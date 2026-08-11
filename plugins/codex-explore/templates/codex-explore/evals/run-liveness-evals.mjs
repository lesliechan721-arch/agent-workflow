import {
  mkdir,
  readFile,
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
import {
  captureWorkspaceSnapshot,
  diffWorkspaceSnapshots,
  evaluateLifecycleTrace,
  evaluateParentScopeIsolation,
} from './run-workflow-evals.mjs';

const DEFAULT_OPTIONS = {
  runs: 3,
  timeoutMs: 300_000,
  codexBin: 'codex',
  model: undefined,
  caseId: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/codex-explore/templates/codex-explore/evals/run-liveness-evals.mjs [OPTIONS]

Runs long and blocked exploration cases against a materialized one-minute wait
profile. The report is comparative ablation evidence, not release evidence.

Options:
  --runs <count>                Repetitions per case (default: 3)
  --case <id>                   Run one case
  --timeout-ms <milliseconds>   Per-run safety timeout (default: 300000)
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

export function parseLivenessEvalArgs(argv) {
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
    } else if (flag === '--case') {
      options.caseId = value;
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
    typeof expected.agent_type !== 'string' ||
    !nonEmptyStrings(expected.final_message_includes_all) ||
    !nonEmptyStrings(expected.delegated_source_prefixes) ||
    expected.workspace_unchanged !== true ||
    !Number.isInteger(expected.lifecycle?.minimum_initial_wait_timeout_ms) ||
    expected.lifecycle.minimum_initial_wait_timeout_ms <= 0 ||
    typeof expected.lifecycle?.allow_liveness_probe !== 'boolean' ||
    !Number.isInteger(expected.lifecycle?.max_recoveries) ||
    expected.lifecycle.max_recoveries < 0
  ) {
    throw new Error(`${entry.id}.expected does not define the liveness contract.`);
  }
  return entry;
}

export async function loadLivenessEvalSpec() {
  const spec = JSON.parse(await readEvalResource('liveness-evals.json'));
  if (spec?.skill_name !== 'codex-explore' || !Array.isArray(spec.evals)) {
    throw new Error('liveness-evals.json must describe codex-explore and contain evals.');
  }
  const evals = spec.evals.map(validateCase);
  if (new Set(evals.map((entry) => entry.id)).size !== evals.length) {
    throw new Error('liveness-evals.json contains duplicate ids.');
  }
  return { ...spec, evals };
}

export async function setupLivenessWorkspace(workspaceRoot) {
  const recordsRoot = path.join(workspaceRoot, 'docs', 'liveness', 'records');
  await mkdir(recordsRoot, { recursive: true });
  await Promise.all(Array.from({ length: 120 }, async (_, offset) => {
    const index = offset + 1;
    const timeout = index <= 40 ? 30 : index <= 80 ? 45 : 60;
    const name = `record-${String(index).padStart(3, '0')}.md`;
    const content = [
      `# Liveness record ${index}`,
      `record=${index} service=service-${(index % 8) + 1} timeout=${timeout}`,
      `region=region-${(index % 4) + 1} verified=true`,
      '',
    ].join('\n');
    await writeFile(path.join(recordsRoot, name), content, 'utf8');
  }));
  const verifier = [
    "import { readFile, readdir } from 'node:fs/promises';",
    "import path from 'node:path';",
    "import { fileURLToPath } from 'node:url';",
    '',
    "const recordsRoot = fileURLToPath(new URL('./records/', import.meta.url));",
    "const files = (await readdir(recordsRoot)).filter((name) => name.endsWith('.md')).sort();",
    'const values = new Set();',
    'for (const name of files) {',
    "  const text = await readFile(path.join(recordsRoot, name), 'utf8');",
    "  const match = text.match(/timeout=(\\d+)/);",
    "  if (!match) throw new Error(`Missing timeout in ${name}`);",
    '  values.add(Number(match[1]));',
    '}',
    'await new Promise((resolve) => setTimeout(resolve, 65_000));',
    'console.log(`records=${files.length}`);',
    'console.log(`timeout_values=${[...values].sort((left, right) => left - right).join(\',\')}`);',
    '',
  ].join('\n');
  await writeFile(
    path.join(workspaceRoot, 'docs', 'liveness', 'verify-records.mjs'),
    verifier,
    'utf8',
  );
}

function unchanged(changes) {
  return ['added', 'removed', 'modified'].every(
    (field) => Array.isArray(changes?.[field]) && changes[field].length === 0,
  );
}

function livenessMetrics(run) {
  const timeline = Array.isArray(run.collaboration_timeline)
    ? run.collaboration_timeline
    : [];
  const probes = timeline.filter((call) => call?.tool === 'send_message');
  const statusMessages = timeline.filter(
    (call) =>
      call?.tool === 'agent_message' &&
      call.output?.message_type === 'MESSAGE' &&
      ['progress', 'blocked'].includes(call.output?.status),
  );
  const timedOutWaits = timeline.filter(
    (call) => call?.tool === 'wait_agent' && call.output?.timed_out === true,
  );
  const waits = timeline.filter((call) => call?.tool === 'wait_agent');
  return {
    probes: probes.length,
    status_messages: statusMessages.map((call) => call.output.status),
    timed_out_waits: timedOutWaits.length,
    wait_count: waits.length,
    duration_ms: run.duration_ms,
    usage: run.usage ?? null,
  };
}

function invokesVerifier(call) {
  if (call?.tool !== 'exec_command' || typeof call.arguments?.cmd !== 'string') {
    return false;
  }
  return /(?:^|[\s;&|])node\s+(?:\.\/)?docs\/liveness\/verify-records\.mjs(?:$|[\s;&|])/u
    .test(call.arguments.cmd);
}

export function evaluateLivenessRun(run, expected, probeEnabled) {
  const finalMessage = run.final_message ?? '';
  const spawnCalls = Array.isArray(run.spawn_calls) ? run.spawn_calls : [];
  const metrics = livenessMetrics(run);
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_count',
      passed: spawnCalls.length === 1,
      evidence: `expected=1 actual=${spawnCalls.length}`,
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
    {
      name: 'workspace_unchanged',
      passed: expected.workspace_unchanged === true && unchanged(run.workspace_changes),
      evidence: JSON.stringify(run.workspace_changes),
    },
    {
      name: 'materialized_probe_policy',
      passed: probeEnabled === expected.lifecycle.allow_liveness_probe,
      evidence: JSON.stringify({
        probe_enabled: probeEnabled,
        expected: expected.lifecycle.allow_liveness_probe,
      }),
    },
    {
      name: 'long_wait_exercised',
      passed:
        metrics.timed_out_waits >= 1 &&
        metrics.wait_count >= 2 &&
        run.duration_ms >= expected.lifecycle.minimum_initial_wait_timeout_ms,
      evidence: JSON.stringify({
        timed_out_waits: metrics.timed_out_waits,
        wait_count: metrics.wait_count,
        minimum_duration_ms: expected.lifecycle.minimum_initial_wait_timeout_ms,
        duration_ms: run.duration_ms,
      }),
    },
    {
      name: 'verifier_invoked_by_leaf',
      passed: (run.leaf_tool_calls ?? []).some(invokesVerifier),
      evidence: JSON.stringify(
        (run.leaf_tool_calls ?? []).filter((call) => call?.tool === 'exec_command'),
      ),
    },
    evaluateParentScopeIsolation(
      run.collaboration_timeline,
      expected.delegated_source_prefixes,
    ),
    ...evaluateLifecycleTrace(
      run.collaboration_timeline,
      expected.lifecycle,
    ).assertions,
  ];
  for (const text of expected.final_message_includes_all) {
    assertions.push({
      name: `final_message_includes:${text}`,
      passed: finalMessage.includes(text),
      evidence: `required=${JSON.stringify(text)}`,
    });
  }
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    metrics,
  };
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

export function summarizeLivenessRuns(runs) {
  return {
    accepted_runs: runs.filter((run) => run.evaluation.passed).length,
    probe_runs: runs.filter((run) => run.evaluation.metrics.probes > 0).length,
    status_runs: runs.filter(
      (run) => run.evaluation.metrics.status_messages.length > 0,
    ).length,
    median_duration_ms: median(
      runs.map((run) => run.duration_ms).filter(Number.isFinite),
    ),
    terminations: Object.fromEntries(
      [...new Set(runs.map((run) => run.termination))]
        .sort()
        .map((termination) => [
          termination,
          runs.filter((run) => run.termination === termination).length,
        ]),
    ),
  };
}

async function run(options) {
  const spec = await loadLivenessEvalSpec();
  const selected = options.caseId
    ? spec.evals.filter((entry) => entry.id === options.caseId)
    : spec.evals;
  if (selected.length === 0) {
    throw new Error(`Unknown liveness case: ${options.caseId}`);
  }
  const results = [];
  for (const entry of selected) {
    const runs = [];
    for (let index = 0; index < options.runs; index += 1) {
      process.stderr.write(`${entry.id} run ${index + 1}/${options.runs}\n`);
      const workspace = await createEvalWorkspace();
      try {
        await setupLivenessWorkspace(workspace.root);
        const probeEnabled = (await readFile(workspace.skillPath, 'utf8'))
          .includes('status=progress');
        const before = await captureWorkspaceSnapshot(workspace.root);
        const result = await runCodexOnce(
          workspace,
          {
            query: entry.prompt,
            parent_model: entry.parent_model,
            explicit_skill: true,
            should_load_skill: true,
            should_spawn_agent: true,
            wait_for_completion: true,
            codex_config: entry.codex_config,
          },
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
          probe_enabled: probeEnabled,
          workspace_changes: diffWorkspaceSnapshots(before, after),
        };
        runs.push({
          ...completeRun,
          evaluation: evaluateLivenessRun(
            completeRun,
            entry.expected,
            probeEnabled,
          ),
        });
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
    results.push({
      id: entry.id,
      passed: runs.every((result) => result.evaluation.passed),
      summary: summarizeLivenessRuns(runs),
      runs,
    });
  }

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    skill_name: spec.skill_name,
    scope: 'liveness-ablation',
    profile: process.env.AW_PLUGIN_EVAL_PROFILE ?? null,
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
    options = parseLivenessEvalArgs(process.argv.slice(2));
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
