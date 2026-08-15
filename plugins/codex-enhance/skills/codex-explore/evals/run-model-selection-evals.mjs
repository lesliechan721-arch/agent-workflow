import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createEvalWorkspace,
  readEvalResource,
  runCodexOnce,
} from './eval-harness.mjs';

const DEFAULT_OPTIONS = {
  runs: 3,
  threshold: 0.5,
  timeoutMs: 180_000,
  codexBin: 'codex',
  model: undefined,
  caseId: undefined,
  output: undefined,
  allowEnvironmentSkips: false,
};

function usage() {
  return `Usage: node plugins/codex-enhance/skills/codex-explore/evals/run-model-selection-evals.mjs [OPTIONS]

Runs current-skill model-selection behavior evaluations in clean Codex sessions,
then checks the raw spawn_agent arguments.

Options:
  --runs <count>                Repetitions per case (default: 3)
  --threshold <rate>            Non-critical pass boundary (default: 0.5)
  --timeout-ms <milliseconds>   Per-run safety timeout (default: 180000)
  --codex-bin <path>            Codex executable (default: codex)
  --model <model>               Optional parent model override
  --case <id>                   Run one eval case
  --output <path>               Also write the JSON report to this path
  --allow-environment-skips     Permit incomplete environment-skipped cases
  -h, --help                    Show this help`;
}

function readOptionValue(argv, index, flag) {
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

export function parseModelEvalArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    if (flag === '--allow-environment-skips') {
      options.allowEnvironmentSkips = true;
      continue;
    }
    const value = readOptionValue(argv, index, flag);
    index += 1;
    if (flag === '--runs') {
      options.runs = positiveInteger(value, flag);
    } else if (flag === '--threshold') {
      options.threshold = Number(value);
      if (!(options.threshold > 0 && options.threshold < 1)) {
        throw new Error('--threshold must be greater than 0 and less than 1.');
      }
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = positiveInteger(value, flag);
      if (options.timeoutMs < 10_000) {
        throw new Error('--timeout-ms must be at least 10000.');
      }
    } else if (flag === '--codex-bin') {
      options.codexBin = value;
    } else if (flag === '--model') {
      options.model = value;
    } else if (flag === '--case') {
      options.caseId = value;
    } else if (flag === '--output') {
      options.output = path.resolve(value);
    } else {
      throw new Error(`Unknown option: ${flag}`);
    }
  }
  return options;
}

function validateExpected(expected, id) {
  const range = expected?.spawn_calls;
  if (
    !range ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new Error(`${id}.expected.spawn_calls must define a valid integer range.`);
  }
  if (
    expected.spawn_rejected !== undefined &&
    typeof expected.spawn_rejected !== 'boolean'
  ) {
    throw new Error(`${id}.expected.spawn_rejected must be a boolean.`);
  }
  if (
    expected.preflight_rejection_evidence !== undefined &&
    (
      !Array.isArray(expected.preflight_rejection_evidence) ||
      expected.preflight_rejection_evidence.length === 0 ||
      expected.preflight_rejection_evidence.some(
        (value) => typeof value !== 'string' || value.trim() === '',
      )
    )
  ) {
    throw new Error(`${id}.expected.preflight_rejection_evidence must be a non-empty string array.`);
  }
}

function validateEvalCase(entry, index) {
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
  if (
    typeof entry.expected_output !== 'string' ||
    entry.expected_output.trim() === ''
  ) {
    throw new Error(`${entry.id}.expected_output must be a non-empty string.`);
  }
  if (!Array.isArray(entry.files) || !Array.isArray(entry.assertions)) {
    throw new Error(`${entry.id}.files and assertions must be arrays.`);
  }
  validateExpected(entry.expected, entry.id);
  return entry;
}

export async function loadModelEvalSpec() {
  const spec = JSON.parse(await readEvalResource('evals.json'));
  if (spec?.skill_name !== 'codex-explore' || !Array.isArray(spec.evals)) {
    throw new Error('evals.json must describe codex-explore and contain evals.');
  }
  const evals = spec.evals.map(validateEvalCase);
  const ids = new Set(evals.map((entry) => entry.id));
  if (ids.size !== evals.length) {
    throw new Error('evals.json contains duplicate ids.');
  }
  return { ...spec, evals };
}

function valueEvidence(args, key) {
  return Object.hasOwn(args ?? {}, key)
    ? JSON.stringify(args[key])
    : '<absent>';
}

function evaluateArguments(call, expectedArguments, label) {
  const args = call?.arguments;
  if (!args) {
    return [{
      name: label,
      passed: false,
      evidence: 'spawn_agent arguments were unavailable in rollout evidence',
    }];
  }
  return Object.entries(expectedArguments ?? {}).map(([key, expected]) => {
    const present = Object.hasOwn(args, key);
    const passed = expected === null ? !present : present && args[key] === expected;
    return {
      name: `${label}.${key}`,
      passed,
      evidence: `expected=${expected === null ? '<absent>' : JSON.stringify(expected)} actual=${valueEvidence(args, key)}`,
    };
  });
}

function spawnRejected(call) {
  if (!call || call.output === undefined || call.output === null) return false;
  if (
    typeof call.output === 'object' &&
    !Array.isArray(call.output) &&
    typeof call.output.task_name === 'string' &&
    call.output.task_name.trim() !== ''
  ) {
    return false;
  }
  return typeof call.output === 'string'
    ? call.output.trim() !== ''
    : true;
}

export function evaluateModelSelectionRun(run, expected) {
  const calls = run.spawn_calls ?? [];
  const errorEvents = (run.event_trace ?? []).filter(
    (event) =>
      event?.type === 'error' ||
      event?.item?.type === 'error',
  );
  const environmentEvidence = JSON.stringify({
    stderr: run.stderr,
    error_events: errorEvents,
  });
  const matchedEnvironmentError =
    run.execution_error &&
    calls.length === 0 &&
    expected.allowed_environment_errors?.find(
      (text) => environmentEvidence.includes(text),
    );
  if (matchedEnvironmentError) {
    return {
      passed: null,
      skipped: true,
      assertions: [{
        name: 'environment_capability',
        passed: null,
        evidence: `runtime rejected the requested schema profile: ${matchedEnvironmentError}`,
      }],
    };
  }

  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}`,
    },
    {
      name: 'spawn_call_count',
      passed:
        calls.length >= expected.spawn_calls.min &&
        calls.length <= expected.spawn_calls.max,
      evidence: `expected=${expected.spawn_calls.min}..${expected.spawn_calls.max} actual=${calls.length}`,
    },
  ];

  if (expected.arguments) {
    assertions.push(...evaluateArguments(calls[0], expected.arguments, 'arguments'));
  }
  if (calls.length > 0 && expected.arguments_if_called) {
    assertions.push(
      ...evaluateArguments(calls[0], expected.arguments_if_called, 'arguments_if_called'),
    );
  }
  for (const key of expected.present_arguments ?? []) {
    const args = calls[0]?.arguments;
    assertions.push({
      name: `present_arguments.${key}`,
      passed: Object.hasOwn(args ?? {}, key),
      evidence: `actual=${valueEvidence(args, key)}`,
    });
  }
  if (expected.spawn_rejected !== undefined) {
    const runtimeRejected = spawnRejected(calls[0]);
    const preflightEvidence = expected.preflight_rejection_evidence ?? [];
    const preflightRejected = calls.length === 0 &&
      preflightEvidence.length > 0 &&
      preflightEvidence.every((value) => (run.final_message ?? '').includes(value));
    const rejected = runtimeRejected || preflightRejected;
    assertions.push({
      name: 'spawn_rejected',
      passed: rejected === expected.spawn_rejected,
      evidence: `expected=${expected.spawn_rejected} actual=${rejected} mode=${runtimeRejected ? 'runtime' : preflightRejected ? 'preflight' : 'none'} output=${JSON.stringify(calls[0]?.output ?? null)}`,
    });
  }
  if (expected.final_message_includes_any) {
    const finalMessage = run.final_message ?? '';
    const matched = expected.final_message_includes_any.find((text) =>
      finalMessage.includes(text));
    assertions.push({
      name: 'final_message_includes_any',
      passed: Boolean(matched),
      evidence: matched
        ? `matched=${JSON.stringify(matched)}`
        : `expected one of ${JSON.stringify(expected.final_message_includes_any)}`,
    });
  }

  return {
    passed: assertions.every((assertion) => assertion.passed),
    skipped: false,
    assertions,
  };
}

export function summarizeModelEval(entry, runs, threshold, optimization = 'balanced') {
  const gradedRuns = runs.map((run) => ({
    ...run,
    evaluation: evaluateModelSelectionRun(run, entry.expected),
  }));
  const runnable = gradedRuns.filter((run) => !run.evaluation.skipped);
  const environmentSkips = gradedRuns.length - runnable.length;
  const passRate = runnable.length === 0
    ? null
    : runnable.filter((run) => run.evaluation.passed).length / gradedRuns.length;
  const passed = passRate === null
    ? null
    : optimization === 'critical'
      ? runnable.every((run) => run.evaluation.passed)
      : passRate > threshold;
  return {
    id: entry.id,
    expected_output: entry.expected_output,
    expected: entry.expected,
    pass_rate: passRate,
    passed,
    complete: environmentSkips === 0,
    environment_skips: environmentSkips,
    runs: gradedRuns,
  };
}

export function modelEvalRunCase(entry) {
  return {
    query: entry.prompt,
    explicit_skill: true,
    should_load_skill: true,
    should_spawn_agent: entry.expected.spawn_calls.min > 0,
    wait_for_completion: Boolean(entry.wait_for_completion),
    parent_model: entry.parent_model,
    enable_features: entry.enable_features,
    disable_features: entry.disable_features,
    codex_config: entry.codex_config,
  };
}

export function modelEvalReportStatus(results, allowEnvironmentSkips) {
  if (results.length === 0) {
    return { complete: true, passed: null };
  }
  const complete = results.every((result) => result.complete);
  const performancePassed = results.every(
    (result) => result.passed !== false,
  );
  return {
    complete,
    passed: performancePassed && (complete || allowEnvironmentSkips),
  };
}

async function run(options) {
  const spec = await loadModelEvalSpec();
  const selectedCases = options.caseId
    ? spec.evals.filter((entry) => entry.id === options.caseId)
    : spec.evals;
  if (selectedCases.length === 0) {
    throw new Error(`Unknown eval case: ${options.caseId}`);
  }

  const results = [];
  for (const entry of selectedCases) {
    const runs = [];
    for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
      process.stderr.write(
        `${entry.id} run ${runIndex + 1}/${options.runs}\n`,
      );
      const workspace = await createEvalWorkspace({
        configValues: entry.config_values,
      });
      try {
        runs.push(await runCodexOnce(
          workspace,
          modelEvalRunCase(entry),
          {
            codexBin: options.codexBin,
            model: options.model,
            timeoutMs: options.timeoutMs,
            captureTrace: true,
          },
        ));
      } finally {
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
    results.push(summarizeModelEval(
      entry,
      runs,
      options.threshold,
      spec.policy?.optimization,
    ));
  }

  const reportStatus = modelEvalReportStatus(
    results,
    options.allowEnvironmentSkips,
  );
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    skill_name: spec.skill_name,
    runs_per_case: options.runs,
    threshold: options.threshold,
    optimization: spec.policy?.optimization ?? 'balanced',
    requested_model_override: options.model ?? null,
    allow_environment_skips: options.allowEnvironmentSkips,
    complete: reportStatus.complete,
    passed: reportStatus.passed,
    summary: {
      cases: selectedCases.length,
      passed: results.filter(
        (result) => result.complete && result.passed,
      ).length,
      failed: results.filter(
        (result) => result.complete && result.passed === false,
      ).length,
      incomplete: results.filter((result) => !result.complete).length,
      environment_skipped: results.reduce(
        (total, result) => total + result.environment_skips,
        0,
      ),
    },
    case_results: selectedCases.map((entry) => {
      const result = results.find((candidate) => candidate.id === entry.id);
      const caseComplete = result?.complete === true;
      const casePassed = result?.passed === true;
      return {
        id: entry.id,
        outcome: caseComplete ? (casePassed ? 'passed' : 'failed') : 'incomplete',
        complete: caseComplete,
        mechanical_passed: casePassed,
      };
    }),
    results,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, output, 'utf8');
  }
  process.stdout.write(output);
  if (report.passed !== true) {
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseModelEvalArgs(process.argv.slice(2));
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
