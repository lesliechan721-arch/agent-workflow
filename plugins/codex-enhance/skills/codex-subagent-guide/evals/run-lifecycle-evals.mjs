import {
  ROOT_DEVELOPER_INSTRUCTIONS,
  evidenceRun,
  legacyCase,
  readWorkflowEvidence,
  runCodexWorkflowAdapterMain,
  workflowProfile,
  workflowRoles,
} from './codex-workflow-adapter.mjs';
import { setupTriggerWorkspace } from './trigger-fixture.mjs';

function waitTimedOut(call) {
  if (call?.output && typeof call.output === 'object') {
    return call.output.timed_out === true ||
      call.output.timedOut === true ||
      call.output.status === 'timeout' ||
      call.output.status === 'timed_out';
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

export function evaluateContinuation(evidence, expected, progress) {
  const calls = evidence.collaborationCalls.filter((call) => call.threadId === evidence.rootThreadId);
  const spawns = calls.filter((call) => call.tool === 'spawn_agent');
  const followups = calls.filter((call) => call.tool === 'followup_task');
  const assertions = [];
  const add = (name, passed) => assertions.push({ name, passed, evidence: name });
  add('clean_delegation', spawns.every((call) => call.arguments?.fork_turns === 'none'));
  add('continuation_count', followups.length === (expected.followup ? 1 : 0));
  if (expected.followup) {
    const first = spawns[0]?.arguments?.task_name;
    const target = followups[0]?.arguments?.target;
    add('same_delivery_target', typeof first === 'string' && typeof target === 'string'
      && (target === first || target.endsWith(`/${first}`)));
    const childId = spawns[0]?.linkedThreadId;
    const childCalls = evidence.leafCalls.filter((call) => typeof childId === 'string' && call.threadId === childId);
    const start = childCalls.find((call) => /recoverable\.mjs['"]?\s+start(?:\s|$)/u.test(call.arguments?.cmd ?? '')
      && Number.isInteger(call.output?.exitCode) && call.output.exitCode !== 0);
    const finish = childCalls.find((call) => /recoverable\.mjs['"]?\s+finish(?:\s|$)/u.test(call.arguments?.cmd ?? '')
      && call.output?.exitCode === 0);
    const followup = followups[0];
    add('failure_then_same_child_continuation', !!start && !!finish
      && start.ordinal < followup?.ordinal && followup.ordinal < finish.ordinal);
    add('failure_reported_before_continuation', !!start && calls.some((call) => call.tool === 'agent_message'
      && call.output?.messageType === 'FINAL_ANSWER' && start.ordinal < call.ordinal && call.ordinal < followup?.ordinal));
    add('saved_progress_once', Object.entries(expected.value).every(([key, value]) => progress?.[key] === value));
  } else {
    const second = spawns[1];
    const firstResult = calls.find((call) => call.tool === 'agent_message'
      && call.output?.messageType === 'FINAL_ANSWER');
    add('first_delivery_finished', !!firstResult && firstResult.ordinal < second?.ordinal);
    const child = evidence.threadGraph.find((thread) => thread.threadId === second?.linkedThreadId);
    const message = child?.initialMessage?.kind === 'plaintext' ? child.initialMessage.text : '';
    const source = expected.model ? 'src/publish-v2.mjs' : 'src/new-task.ts';
    add('current_scope', message.includes(source));
    add('current_source_read', evidence.leafCalls.some((call) => call.threadId === child?.threadId
      && JSON.stringify(call.arguments).includes(source)));
    if (!expected.model) add('unrelated_history_absent', !message.includes('src/simple.ts') && !message.includes('retryLimit'));
    const answers = [...evidence.finalMessage.matchAll(/\{[^{}]*\}/gu)].flatMap(([text]) => {
      try { return [JSON.parse(text)]; } catch { return []; }
    });
    add('current_result', answers.some((answer) => Object.entries(expected.answer)
      .every(([key, value]) => answer[key] === value)));
    if (expected.model) {
      add('effective_model', spawns.every((call) => call.effectiveRuntime?.model === expected.model
        && call.effectiveRuntime?.reasoningEffort === expected.reasoningEffort));
    }
  }
  const changed = Object.values(evidence.workspaceDiff).flat();
  add('write_scope', changed.every((file) => file === expected.artifact));
  return assertions;
}

export async function prepareLifecycle(input) {
  const evalCase = validateLifecycleCase(legacyCase(input.case));
  await setupTriggerWorkspace({
    workspaceRoot: input.paths.workspace,
    evalCase,
  });
  const recovery = evalCase.lifecycle_fixture === 'recovery';
  return {
    version: 1,
    prompt: evalCase.prompt,
    sandbox: recovery ? 'workspace-write' : 'read-only',
    model: 'gpt-5.6-luna',
    developerInstructions: recovery
      ? ROOT_DEVELOPER_INSTRUCTIONS.replace('Do not modify files in this evaluation workspace.',
        'Only the delegated child may run the helper and write results/progress.json; the parent only orchestrates.')
      : ROOT_DEVELOPER_INSTRUCTIONS,
    roles: await workflowRoles(input.paths.workspace),
    multiAgent: workflowProfile('v2'),
  };
}

export async function gradeLifecycle(input) {
  const evalCase = validateLifecycleCase(legacyCase(input.case));
  const evidence = await readWorkflowEvidence(input.paths.evidence);
  const run = evidenceRun(evidence, input.case, input.variant);
  const evaluation = evaluateLifecycleTimeline(run.collaboration_timeline, evalCase.expected);
  if (evalCase.expected.continuation) {
    let progress;
    if (evalCase.lifecycle_fixture === 'recovery') {
      progress = await readFile(path.join(input.paths.workspace, 'results/progress.json'), 'utf8')
        .then(JSON.parse).catch(() => null);
    }
    evaluation.assertions.push(...evaluateContinuation(evidence, evalCase.expected.continuation, progress));
  }
  evaluation.assertions.push({
    name: 'engine_cleanup_confirmed',
    passed: run.cleanup_confirmed === true,
    evidence: `confirmed=${run.cleanup_confirmed === true}`,
  });
  evaluation.passed = evaluation.assertions.every((entry) => entry.passed === true);
  const complete = run.collaboration_timeline.length > 0 && run.cleanup_confirmed === true;
  const passed = complete && evaluation.passed;
  return {
    passed,
    score: passed ? 1 : 0,
    details: {
      caseId: evalCase.id,
      variant: input.variant,
      complete,
      ...evaluation,
    },
  };
}

await runCodexWorkflowAdapterMain(import.meta.url, {
  prepare: prepareLifecycle,
  grade: gradeLifecycle,
});
import { readFile } from 'node:fs/promises';
import path from 'node:path';
