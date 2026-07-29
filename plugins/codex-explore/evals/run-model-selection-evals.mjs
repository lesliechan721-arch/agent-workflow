import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createEvalWorkspace,
  readEvalResource,
  runCodexOnce,
} from './run-trigger-evals.mjs';

const DEFAULT_OPTIONS = {
  variant: 'both',
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
  return `Usage: node plugins/codex-explore/evals/run-model-selection-evals.mjs [OPTIONS]

Runs current-skill and frozen old-skill model-selection behavior evaluations in
clean Codex sessions, then checks the current skill's raw spawn_agent arguments.

Options:
  --variant <current|old|both>  Variants to run (default: both)
  --runs <count>                Repetitions per case and variant (default: 3)
  --threshold <rate>            Current-skill pass boundary (default: 0.5)
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
    if (flag === '--variant') {
      if (!['current', 'old', 'both'].includes(value)) {
        throw new Error('--variant must be current, old, or both.');
      }
      options.variant = value;
    } else if (flag === '--runs') {
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

function validateExpectedCurrent(expected, id) {
  const range = expected?.spawn_calls;
  if (
    !range ||
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < 0 ||
    range.max < range.min
  ) {
    throw new Error(`${id}.expected_current.spawn_calls must define a valid integer range.`);
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
    typeof entry.expected_output !== 'string' ||
    entry.expected_output.trim() === ''
  ) {
    throw new Error(`${entry.id}.expected_output must be a non-empty string.`);
  }
  if (!Array.isArray(entry.files) || !Array.isArray(entry.assertions)) {
    throw new Error(`${entry.id}.files and assertions must be arrays.`);
  }
  validateExpectedCurrent(entry.expected_current, entry.id);
  return entry;
}

export async function loadModelEvalSpec() {
  const spec = JSON.parse(await readEvalResource('evals.json'));
  if (spec?.skill_name !== 'codex-explore' || !Array.isArray(spec.evals)) {
    throw new Error('evals.json must describe codex-explore and contain evals.');
  }
  if (typeof spec.baseline?.should_spawn_agent !== 'boolean') {
    throw new Error('evals.json baseline.should_spawn_agent must be boolean.');
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

export function summarizeVariant(entry, variant, runs, threshold) {
  if (variant === 'old') {
    return {
      id: entry.id,
      variant,
      expected_output: entry.expected_output,
      graded: false,
      runs,
    };
  }
  const gradedRuns = runs.map((run) => ({
    ...run,
    evaluation: evaluateModelSelectionRun(run, entry.expected_current),
  }));
  const runnable = gradedRuns.filter((run) => !run.evaluation.skipped);
  const environmentSkips = gradedRuns.length - runnable.length;
  const passRate = runnable.length === 0
    ? null
    : runnable.filter((run) => run.evaluation.passed).length / gradedRuns.length;
  return {
    id: entry.id,
    variant,
    expected_output: entry.expected_output,
    expected: entry.expected_current,
    pass_rate: passRate,
    passed: passRate === null ? null : passRate > threshold,
    complete: environmentSkips === 0,
    environment_skips: environmentSkips,
    graded: true,
    runs: gradedRuns,
  };
}

function selectedVariants(variant) {
  return variant === 'both' ? ['current', 'old'] : [variant];
}

export function modelEvalRunCase(entry, variant, baseline) {
  return {
    query: entry.prompt,
    explicit_skill: true,
    should_load_skill: true,
    should_spawn_agent:
      variant === 'old'
        ? baseline.should_spawn_agent
        : entry.expected_current.spawn_calls.min > 0,
    wait_for_completion: Boolean(entry.wait_for_completion),
    enable_features: entry.enable_features,
    disable_features: entry.disable_features,
    codex_config: entry.codex_config,
  };
}

export function modelEvalReportStatus(currentResults, allowEnvironmentSkips) {
  if (currentResults.length === 0) {
    return { complete: true, passed: null };
  }
  const complete = currentResults.every((result) => result.complete);
  const performancePassed = currentResults.every(
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
    for (const variant of selectedVariants(options.variant)) {
      const runs = [];
      for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
        process.stderr.write(
          `[${variant}] ${entry.id} run ${runIndex + 1}/${options.runs}\n`,
        );
        const workspace = await createEvalWorkspace({
          configValues: entry.config_values,
          variant,
        });
        try {
          runs.push(await runCodexOnce(
            workspace,
            modelEvalRunCase(entry, variant, spec.baseline),
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
      results.push(summarizeVariant(entry, variant, runs, options.threshold));
    }
  }

  const currentResults = results.filter((result) => result.variant === 'current');
  const reportStatus = modelEvalReportStatus(
    currentResults,
    options.allowEnvironmentSkips,
  );
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    skill_name: spec.skill_name,
    baseline: spec.baseline,
    variant: options.variant,
    runs_per_case: options.runs,
    threshold: options.threshold,
    model: options.model ?? null,
    allow_environment_skips: options.allowEnvironmentSkips,
    complete: reportStatus.complete,
    passed: reportStatus.passed,
    summary: {
      cases: selectedCases.length,
      current_passed: currentResults.filter(
        (result) => result.complete && result.passed,
      ).length,
      current_failed: currentResults.filter(
        (result) => result.complete && result.passed === false,
      ).length,
      current_incomplete: currentResults.filter((result) => !result.complete).length,
      current_environment_skipped: currentResults.reduce(
        (total, result) => total + result.environment_skips,
        0,
      ),
      baseline_runs: results
        .filter((result) => result.variant === 'old')
        .reduce((total, result) => total + result.runs.length, 0),
    },
    results,
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    await mkdir(path.dirname(options.output), { recursive: true });
    await writeFile(options.output, output, 'utf8');
  }
  process.stdout.write(output);
  if (currentResults.length > 0 && report.passed !== true) {
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
