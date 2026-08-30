import { rm } from 'node:fs/promises';
import process from 'node:process';

import {
  createProviderOutput,
  createEvalWorkspace,
  PROVIDER_CREDENTIAL_ENVIRONMENT,
  runCodexOnce,
} from './eval-harness.mjs';

function waitTimedOut(call) {
  if (call?.output && typeof call.output === 'object') {
    return call.output.timed_out === true;
  }
  return typeof call?.output === 'string' && /timed[ _-]?out/iu.test(call.output);
}

function hasTerminalResult(call) {
  if (call?.tool === 'agent_message' && call.output?.message_type === 'FINAL_ANSWER') {
    return true;
  }
  if (
    call?.tool !== 'wait_agent' ||
    !call.output?.status ||
    typeof call.output.status !== 'object' ||
    Array.isArray(call.output.status)
  ) {
    return false;
  }
  return Object.values(call.output.status).some((status) =>
    status && typeof status === 'object' && typeof status.completed === 'string');
}

export function evaluateLifecycleTimeline(calls, expected) {
  const timeline = Array.isArray(calls) ? calls : [];
  const assertions = [];
  const add = (name, passed, evidence) => assertions.push({ name, passed, evidence });
  const indexes = (tool) => timeline.flatMap(
    (call, index) => call?.tool === tool ? [index] : [],
  );
  const spawnIndexes = indexes('spawn_agent');
  const waitIndexes = indexes('wait_agent');
  const cleanupIndexes = indexes('close_agent');
  const resultIndexes = timeline.flatMap(
    (call, index) => hasTerminalResult(call) ? [index] : [],
  );
  const firstSpawn = spawnIndexes[0];
  const firstWait = waitIndexes.find((index) => index > firstSpawn);
  const lastResult = resultIndexes.at(-1);
  add('trace_present', timeline.length > 0, `calls=${timeline.length}`);
  add(
    'spawn_count',
    spawnIndexes.length === expected.spawn_count,
    `expected=${expected.spawn_count} actual=${spawnIndexes.length}`,
  );
  add(
    'wait_after_spawn',
    Number.isInteger(firstSpawn) && Number.isInteger(firstWait),
    `spawn=${firstSpawn ?? 'missing'} wait=${firstWait ?? 'missing'}`,
  );
  const firstTimeout = Number.isInteger(firstWait)
    ? timeline[firstWait]?.arguments?.timeout_ms
    : undefined;
  add(
    'minimum_initial_wait',
    Number.isInteger(firstTimeout) &&
      firstTimeout >= expected.minimum_initial_wait_timeout_ms,
    `minimum=${expected.minimum_initial_wait_timeout_ms} actual=${firstTimeout ?? 'missing'}`,
  );
  const timedOutWaits = waitIndexes.filter((index) => waitTimedOut(timeline[index]));
  const timeoutObserved = timedOutWaits.length > 0;
  const timeoutFollowedByWait = timeoutObserved
    ? timedOutWaits.every((index) => waitIndexes.some((later) => later > index))
    : expected.require_timeout !== true;
  add(
    'timeout_observed',
    expected.require_timeout !== true || timeoutObserved,
    `required=${expected.require_timeout === true} timed_out=${JSON.stringify(timedOutWaits)}`,
  );
  add(
    'timeout_followed_by_wait',
    timeoutFollowedByWait,
    `required=${expected.require_timeout === true} timed_out=${JSON.stringify(timedOutWaits)} waits=${JSON.stringify(waitIndexes)}`,
  );
  add(
    'terminal_result_observed',
    Number.isInteger(lastResult) && lastResult > firstWait,
    `result=${lastResult ?? 'missing'}`,
  );
  add(
    'cleanup_after_result',
    cleanupIndexes.every(
      (index) => Number.isInteger(lastResult) && index > lastResult,
    ),
    `cleanup=${JSON.stringify(cleanupIndexes)} result=${lastResult ?? 'missing'}`,
  );
  return { passed: assertions.every((entry) => entry.passed), assertions };
}

function validateLifecycleCase(evalCase) {
  if (!evalCase || typeof evalCase !== 'object' || Array.isArray(evalCase)) {
    throw new Error('Provider lifecycle case must be an object.');
  }
  if (typeof evalCase.id !== 'string' || typeof evalCase.prompt !== 'string') {
    throw new Error('Provider lifecycle case id and prompt are required.');
  }
  if (!evalCase.expected || typeof evalCase.expected !== 'object') {
    throw new Error(`${evalCase.id}.expected is required.`);
  }
  return evalCase;
}

export async function runEvalProvider(input) {
  const evalCase = validateLifecycleCase(input.case);
  if (evalCase.id !== input.caseId) {
    throw new Error('Provider case id does not match input.caseId.');
  }
  const workspace = await createEvalWorkspace({
    sourceRoot: input.workspacePath,
    withSkill: input.skillMode !== 'without-skill',
  });
  try {
    const run = await runCodexOnce(workspace, {
      query: evalCase.prompt,
      explicit_skill: true,
      should_load_skill: true,
      should_spawn_agent: true,
      wait_for_completion: true,
      codex_config: {},
    }, {
      profile: 'v2',
      model: process.env.AW_SKILL_EVAL_CODEX_MODEL ?? 'gpt-5.6-luna',
      codexBin: process.env.AW_SKILL_EVAL_CODEX_BIN ?? 'codex',
      captureTrace: true,
      sensitiveEnvironmentNames: PROVIDER_CREDENTIAL_ENVIRONMENT,
    });
    const evaluation = evaluateLifecycleTimeline(
      run.collaboration_timeline,
      evalCase.expected,
    );
    return createProviderOutput({
      providerId: 'codex-subagent-lifecycle',
      graderId: 'codex-subagent-lifecycle-mechanical',
      run,
      result: {
        caseId: input.caseId,
        configuration: input.configuration,
        skillMode: input.skillMode,
        complete: !run.execution_error && run.collaboration_timeline?.length > 0,
        ...evaluation,
      },
      outputDir: input.outputDir,
    });
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }
}
