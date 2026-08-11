import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createEvalWorkspace,
  executionErrorEvidence,
  readEvalResource,
  runCodexOnce,
  writeJsonReport,
} from './eval-harness.mjs';

const DEFAULT_OPTIONS = {
  runs: 1,
  timeoutMs: 900_000,
  codexBin: 'codex',
  model: 'gpt-5.6-sol',
  caseId: undefined,
  output: undefined,
};

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

export function parseLifecycleArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    const value = valueAfter(argv, index, flag);
    index += 1;
    if (flag === '--runs' || flag === '--timeout-ms') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${flag} must be a positive integer.`);
      }
      if (flag === '--runs') options.runs = parsed;
      else options.timeoutMs = parsed;
    } else if (flag === '--case') options.caseId = value;
    else if (flag === '--codex-bin') options.codexBin = value;
    else if (flag === '--output') options.output = path.resolve(value);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

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
  add(
    'timeout_followed_by_wait',
    timedOutWaits.every((index) => waitIndexes.some((later) => later > index)),
    `timed_out=${JSON.stringify(timedOutWaits)} waits=${JSON.stringify(waitIndexes)}`,
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

async function loadCases(caseId) {
  const document = JSON.parse(await readEvalResource('lifecycle-evals.json'));
  if (document?.skill_name !== 'codex-subagent-guide' || !Array.isArray(document.evals)) {
    throw new Error('lifecycle-evals.json must describe codex-subagent-guide.');
  }
  const cases = caseId
    ? document.evals.filter((entry) => entry.id === caseId)
    : document.evals;
  if (cases.length === 0) throw new Error(`Unknown lifecycle case: ${caseId}`);
  return cases;
}

async function runCase(evalCase, options) {
  const runs = [];
  for (let index = 0; index < options.runs; index += 1) {
    const workspace = await createEvalWorkspace({ withSkill: true });
    try {
      const run = await runCodexOnce(
        workspace,
        {
          query: evalCase.prompt,
          explicit_skill: true,
          should_load_skill: true,
          should_spawn_agent: true,
          wait_for_completion: true,
          codex_config: {},
        },
        {
          profile: 'v2',
          model: options.model,
          codexBin: options.codexBin,
          timeoutMs: options.timeoutMs,
          captureTrace: true,
        },
      );
      const grade = evaluateLifecycleTimeline(run.collaboration_timeline, evalCase.expected);
      runs.push({ run: index + 1, ...run, assertions: grade.assertions, passed: grade.passed });
    } finally {
      await rm(workspace.root, { recursive: true, force: true });
    }
  }
  return {
    id: evalCase.id,
    complete: runs.every((run) => !run.execution_error && run.collaboration_timeline?.length > 0),
    passed: runs.every((run) => run.passed),
    runs,
  };
}

async function main() {
  const options = parseLifecycleArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write('Usage: run-lifecycle-evals.mjs [--runs N] [--case ID] [--codex-bin PATH] [--timeout-ms MS] [--output PATH]\n');
    return;
  }
  const cases = await loadCases(options.caseId);
  const results = [];
  let environmentError = null;
  try {
    for (const evalCase of cases) results.push(await runCase(evalCase, options));
  } catch (error) {
    environmentError = executionErrorEvidence({
      execution_error: true,
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
  const complete = !environmentError && results.length === cases.length &&
    results.every((entry) => entry.complete);
  const passed = complete && results.every((entry) => entry.passed);
  const report = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    complete,
    passed,
    ...(environmentError ? { environment_error: environmentError } : {}),
    summary: {
      cases: results.length,
      passed: results.filter((entry) => entry.passed).length,
      failed: results.filter((entry) => !entry.passed).length,
    },
    results,
  };
  await writeJsonReport(report, options.output);
  if (!passed) process.exitCode = 1;
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
