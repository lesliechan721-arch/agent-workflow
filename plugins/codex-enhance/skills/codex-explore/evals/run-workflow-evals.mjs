import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createEvalWorkspace,
  readEvalResource,
  runCodexOnce,
} from './eval-harness.mjs';

const DEFAULT_OPTIONS = {
  runs: 1,
  timeoutMs: 180_000,
  codexBin: 'codex',
  model: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/codex-enhance/skills/codex-explore/evals/run-workflow-evals.mjs [OPTIONS]

Runs a current-skill outcome smoke to completion. It checks the selected agent,
the final evidence contract, workspace changes, and the parent collaboration
timeline extracted from rollout function calls.

Options:
  --runs <count>                Repetitions per case (default: 1)
  --timeout-ms <milliseconds>   Per-run safety timeout (default: 180000)
  --codex-bin <path>            Codex executable (default: codex)
  --model <model>               Optional parent model override
  --output <path>               Also write the JSON report to this path
  -h, --help                    Show this help`;
}

function optionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function parseWorkflowEvalArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    const value = optionValue(argv, index, flag);
    index += 1;
    if (flag === '--runs') {
      options.runs = positiveInteger(value, flag);
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = positiveInteger(value, flag);
      if (options.timeoutMs < 10_000) {
        throw new Error('--timeout-ms must be at least 10000.');
      }
    } else if (flag === '--codex-bin') {
      options.codexBin = value;
    } else if (flag === '--model') {
      options.model = value;
    } else if (flag === '--output') {
      options.output = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function nonEmptyStrings(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

function validateLifecycleContract(value, id) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isInteger(value.minimum_initial_wait_timeout_ms) ||
    value.minimum_initial_wait_timeout_ms <= 0 ||
    typeof value.allow_liveness_probe !== 'boolean' ||
    !Number.isInteger(value.max_recoveries) ||
    value.max_recoveries < 0
  ) {
    throw new Error(`${id}.expected.lifecycle does not define the lifecycle contract.`);
  }
}

function validateCase(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`evals[${index}] must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`evals[${index}].id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
    throw new Error(`${entry.id}.prompt must be a non-empty string.`);
  }
  if (
    entry.parent_model !== undefined &&
    (typeof entry.parent_model !== 'string' || entry.parent_model.trim() === '')
  ) {
    throw new Error(`${entry.id}.parent_model must be a non-empty string.`);
  }
  const expected = entry.expected;
  if (
    !expected ||
    expected.spawn_count !== 1 ||
    typeof expected.agent_type !== 'string' ||
    !nonEmptyStrings(expected.final_message_includes_all) ||
    !nonEmptyStrings(expected.final_message_patterns) ||
    !nonEmptyStrings(expected.delegated_source_prefixes) ||
    expected.workspace_unchanged !== true ||
    !expected.lifecycle
  ) {
    throw new Error(`${entry.id}.expected does not define the outcome contract.`);
  }
  validateLifecycleContract(expected.lifecycle, entry.id);
  for (const pattern of expected.final_message_patterns) {
    new RegExp(pattern, 'iu');
  }
  return entry;
}

export async function loadWorkflowEvalSpec() {
  const spec = JSON.parse(await readEvalResource('workflow-evals.json'));
  if (spec?.skill_name !== 'codex-explore' || !Array.isArray(spec.evals)) {
    throw new Error('workflow-evals.json must describe codex-explore and contain evals.');
  }
  const evals = spec.evals.map(validateCase);
  if (new Set(evals.map((entry) => entry.id)).size !== evals.length) {
    throw new Error('workflow-evals.json contains duplicate ids.');
  }
  return { ...spec, evals };
}

async function collectFiles(root, relativeDir, snapshot) {
  const entries = await readdir(path.join(root, relativeDir), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    const absolutePath = path.join(root, relativePath);
    if (entry.isDirectory()) {
      await collectFiles(root, relativePath, snapshot);
    } else if (entry.isSymbolicLink()) {
      snapshot[relativePath] = `symlink:${await readlink(absolutePath)}`;
    } else if (entry.isFile()) {
      snapshot[relativePath] = createHash('sha256')
        .update(await readFile(absolutePath))
        .digest('hex');
    }
  }
}

export async function captureWorkspaceSnapshot(root) {
  const snapshot = {};
  await collectFiles(root, '', snapshot);
  return snapshot;
}

export function diffWorkspaceSnapshots(before, after) {
  const beforePaths = new Set(Object.keys(before));
  const afterPaths = new Set(Object.keys(after));
  return {
    added: [...afterPaths].filter((entry) => !beforePaths.has(entry)).sort(),
    removed: [...beforePaths].filter((entry) => !afterPaths.has(entry)).sort(),
    modified: [...beforePaths]
      .filter((entry) => afterPaths.has(entry) && before[entry] !== after[entry])
      .sort(),
  };
}

function unchanged(changes) {
  return ['added', 'removed', 'modified'].every(
    (field) => Array.isArray(changes?.[field]) && changes[field].length === 0,
  );
}

function waitTimedOut(call) {
  if (call?.output && typeof call.output === 'object') {
    return call.output.timed_out === true;
  }
  return typeof call?.output === 'string' && /timed[ _-]?out/i.test(call.output);
}

function hasFinalAgentResult(call) {
  if (
    call?.tool === 'agent_message' &&
    call.output?.message_type === 'FINAL_ANSWER'
  ) {
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
  return Object.values(call.output.status).some(
    (status) =>
      status &&
      typeof status === 'object' &&
      typeof status.completed === 'string',
  );
}

export function evaluateLifecycleTrace(calls, contract) {
  const timeline = Array.isArray(calls) ? calls : [];
  const assertions = [];
  const add = (name, passed, evidence) => {
    assertions.push({ name: `lifecycle:${name}`, passed, evidence });
  };
  const indexes = (tool) => timeline.flatMap(
    (call, index) => call?.tool === tool ? [index] : [],
  );
  const spawnIndexes = indexes('spawn_agent');
  const waitIndexes = indexes('wait_agent');
  const probeIndexes = indexes('send_message');
  const statusIndexes = timeline.flatMap(
    (call, index) =>
      call?.tool === 'agent_message' &&
      call.output?.message_type === 'MESSAGE' &&
      ['progress', 'blocked'].includes(call.output?.status)
        ? [index]
        : [],
  );
  const followupIndexes = indexes('followup_task');
  const closeIndexes = indexes('close_agent');
  const resultIndexes = timeline.flatMap(
    (call, index) => hasFinalAgentResult(call) ? [index] : [],
  );
  const retrySpawnIndexes = spawnIndexes.slice(1);
  const recoveryIndexes = [...followupIndexes, ...retrySpawnIndexes].sort(
    (left, right) => left - right,
  );

  add('trace_present', timeline.length > 0, `calls=${timeline.length}`);
  const firstSpawn = spawnIndexes[0];
  const firstWait = waitIndexes.find((index) => index > firstSpawn);
  add(
    'wait_after_spawn',
    Number.isInteger(firstSpawn) && Number.isInteger(firstWait),
    `spawn_index=${firstSpawn ?? 'missing'} wait_index=${firstWait ?? 'missing'}`,
  );
  const firstWaitTimeout = Number.isInteger(firstWait)
    ? timeline[firstWait]?.arguments?.timeout_ms
    : undefined;
  add(
    'minimum_initial_wait',
    Number.isInteger(firstWaitTimeout) &&
      firstWaitTimeout >= contract.minimum_initial_wait_timeout_ms,
    `minimum=${contract.minimum_initial_wait_timeout_ms} actual=${firstWaitTimeout ?? 'missing'}`,
  );

  let previousWaitIndex = null;
  let probesFollowTimeout = true;
  let oneProbePerTaskLifecycle = true;
  const probeCountsByTarget = new Map();
  for (const [index, call] of timeline.entries()) {
    if (call?.tool === 'wait_agent') {
      previousWaitIndex = index;
      continue;
    }
    if (call?.tool !== 'send_message') {
      continue;
    }
    const target = call.arguments?.target ?? '<unknown>';
    const probeCount = (probeCountsByTarget.get(target) ?? 0) + 1;
    probeCountsByTarget.set(target, probeCount);
    const previousWait = Number.isInteger(previousWaitIndex)
      ? timeline[previousWaitIndex]
      : null;
    probesFollowTimeout &&= waitTimedOut(previousWait);
    oneProbePerTaskLifecycle &&= probeCount <= 1;
  }
  add(
    'probe_only_after_timeout',
    probesFollowTimeout,
    `probe_indexes=${JSON.stringify(probeIndexes)}`,
  );
  add(
    'one_probe_per_task_lifecycle',
    oneProbePerTaskLifecycle,
    `probe_counts=${JSON.stringify(Object.fromEntries(probeCountsByTarget))}`,
  );
  add(
    'probe_followed_by_wait',
    probeIndexes.every((probeIndex) => waitIndexes.some((waitIndex) => waitIndex > probeIndex)),
    `probe_indexes=${JSON.stringify(probeIndexes)} wait_indexes=${JSON.stringify(waitIndexes)}`,
  );
  add(
    'probe_policy',
    contract.allow_liveness_probe ||
      (probeIndexes.length === 0 && statusIndexes.length === 0),
    `allowed=${contract.allow_liveness_probe} probe_indexes=${JSON.stringify(probeIndexes)} status_indexes=${JSON.stringify(statusIndexes)}`,
  );
  add(
    'status_follows_probe',
    statusIndexes.every((statusIndex) =>
      probeIndexes.some((probeIndex) => probeIndex < statusIndex)),
    `probe_indexes=${JSON.stringify(probeIndexes)} status_indexes=${JSON.stringify(statusIndexes)}`,
  );

  add(
    'recovery_limit',
    recoveryIndexes.length <= contract.max_recoveries,
    `maximum=${contract.max_recoveries} actual=${recoveryIndexes.length}`,
  );
  add(
    'recovery_followed_by_wait',
    recoveryIndexes.every(
      (recoveryIndex) => waitIndexes.some((waitIndex) => waitIndex > recoveryIndex),
    ),
    `recovery_indexes=${JSON.stringify(recoveryIndexes)} wait_indexes=${JSON.stringify(waitIndexes)}`,
  );

  const lastResultIndex = resultIndexes.at(-1);
  const lastRecoveryIndex = recoveryIndexes.at(-1);
  add(
    'cleanup_after_result',
    closeIndexes.every(
      (closeIndex) => Number.isInteger(lastResultIndex) && lastResultIndex < closeIndex,
    ),
    `close_indexes=${JSON.stringify(closeIndexes)} result_index=${lastResultIndex ?? 'missing'}`,
  );
  add(
    'result_before_final',
    Number.isInteger(lastResultIndex) &&
      lastResultIndex >= firstWait &&
      (!Number.isInteger(lastRecoveryIndex) || lastResultIndex > lastRecoveryIndex),
    `result_index=${lastResultIndex ?? 'missing'} wait_index=${firstWait ?? 'missing'} recovery_index=${lastRecoveryIndex ?? 'none'}`,
  );

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function evaluateParentScopeIsolation(calls, delegatedSourcePrefixes) {
  const timeline = Array.isArray(calls) ? calls : [];
  const firstSpawn = timeline.findIndex((call) => call?.tool === 'spawn_agent');
  const firstFinalResult = timeline.findIndex(
    (call, index) => index > firstSpawn && hasFinalAgentResult(call),
  );
  const normalizedPrefixes = delegatedSourcePrefixes.map((prefix) =>
    prefix.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, ''));
  const readableArguments = (call) => {
    if (call?.tool === 'exec_command' && typeof call.arguments?.cmd === 'string') {
      return [call.arguments.cmd];
    }
    const codeModeInput = call?.arguments?.input ?? call?.arguments?.code;
    if (
      call?.tool === 'exec' &&
      typeof codeModeInput === 'string' &&
      call.output !== null &&
      call.output !== undefined &&
      /\btools\.(?:exec_command|view_image|read_mcp_resource)\s*\(/u.test(codeModeInput)
    ) {
      return [codeModeInput];
    }
    if (call?.tool === 'view_image' && typeof call.arguments?.path === 'string') {
      return [call.arguments.path];
    }
    if (call?.tool === 'read_mcp_resource' && typeof call.arguments?.uri === 'string') {
      return [call.arguments.uri];
    }
    return [];
  };
  const referencesPrefix = (value, prefix) => value
    .replaceAll('\\', '/')
    .split(/[\s"'`=,:;|&()[\]{}<>]+/u)
    .some((token) => {
      const normalized = token.replace(/^\.\//u, '').replace(/\/+$/u, '');
      return normalized === prefix ||
        normalized.startsWith(`${prefix}/`) ||
        normalized.endsWith(`/${prefix}`) ||
        normalized.includes(`/${prefix}/`);
    });
  const duplicateCalls = timeline.flatMap((call, index) => {
    if (index <= firstSpawn || index >= firstFinalResult) {
      return [];
    }
    const argumentsToCheck = readableArguments(call);
    return normalizedPrefixes.some((prefix) =>
      argumentsToCheck.some((value) => referencesPrefix(value, prefix)))
      ? [{ index, tool: call?.tool, arguments: call?.arguments }]
      : [];
  });
  return {
    name: 'parent_scope_isolation',
    passed:
      Number.isInteger(firstSpawn) &&
      firstSpawn >= 0 &&
      Number.isInteger(firstFinalResult) &&
      firstFinalResult > firstSpawn &&
      duplicateCalls.length === 0,
    evidence: JSON.stringify({
      first_spawn: firstSpawn,
      first_final_result: firstFinalResult,
      delegated_source_prefixes: delegatedSourcePrefixes,
      duplicate_calls: duplicateCalls,
    }),
  };
}

export function evaluateWorkflowRun(run, expected) {
  const finalMessage = run.final_message ?? '';
  const spawnCalls = run.spawn_calls ?? [];
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_count',
      passed: spawnCalls.length === expected.spawn_count,
      evidence: `expected=${expected.spawn_count} actual=${spawnCalls.length}`,
    },
    {
      name: 'agent_type',
      passed: spawnCalls[0]?.arguments?.agent_type === expected.agent_type,
      evidence: `expected=${expected.agent_type} actual=${spawnCalls[0]?.arguments?.agent_type}`,
    },
    {
      name: 'final_message',
      passed: finalMessage.trim() !== '',
      evidence: `characters=${[...finalMessage].length}`,
    },
  ];
  for (const text of expected.final_message_includes_all) {
    assertions.push({
      name: `final_message_includes:${text}`,
      passed: finalMessage.includes(text),
      evidence: `required=${JSON.stringify(text)}`,
    });
  }
  for (const pattern of expected.final_message_patterns) {
    assertions.push({
      name: `final_message_pattern:${pattern}`,
      passed: new RegExp(pattern, 'iu').test(finalMessage),
      evidence: `pattern=${JSON.stringify(pattern)}`,
    });
  }
  assertions.push({
    name: 'workspace_unchanged',
    passed:
      expected.workspace_unchanged === true &&
      unchanged(run.workspace_changes),
    evidence: JSON.stringify(run.workspace_changes),
  });
  assertions.push(
    evaluateParentScopeIsolation(
      run.collaboration_timeline,
      expected.delegated_source_prefixes,
    ),
  );
  assertions.push(
    ...evaluateLifecycleTrace(run.collaboration_timeline, expected.lifecycle).assertions,
  );
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function workflowEvalRunCase(entry) {
  return {
    query: entry.prompt,
    parent_model: entry.parent_model,
    explicit_skill: true,
    should_load_skill: true,
    should_spawn_agent: true,
    wait_for_completion: true,
    codex_config: entry.codex_config,
  };
}

async function run(options) {
  const spec = await loadWorkflowEvalSpec();
  const results = [];
  for (const entry of spec.evals) {
    const runs = [];
    for (let index = 0; index < options.runs; index += 1) {
      process.stderr.write(`${entry.id} run ${index + 1}/${options.runs}\n`);
      const workspace = await createEvalWorkspace();
      try {
        const before = await captureWorkspaceSnapshot(workspace.root);
        const result = await runCodexOnce(
          workspace,
          workflowEvalRunCase(entry),
          {
            codexBin: options.codexBin,
            model: options.model,
            timeoutMs: options.timeoutMs,
            sandboxMode: 'workspace-write',
            captureTrace: true,
          },
        );
        const after = await captureWorkspaceSnapshot(workspace.root);
        const completeRun = {
          ...result,
          workspace_changes: diffWorkspaceSnapshots(before, after),
        };
        runs.push({
          ...completeRun,
          evaluation: evaluateWorkflowRun(completeRun, entry.expected),
        });
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
    results.push({
      id: entry.id,
      passed: runs.every((result) => result.evaluation.passed),
      runs,
    });
  }

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    skill_name: spec.skill_name,
    scope: 'outcome-smoke',
    runs_per_case: options.runs,
    requested_model_override: options.model ?? null,
    sandbox: 'workspace-write',
    read_only_enforcement: 'instruction-only',
    passed: results.every((result) => result.passed),
    results,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, output, 'utf8');
  }
  process.stdout.write(output);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseWorkflowEvalArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await run(options);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
