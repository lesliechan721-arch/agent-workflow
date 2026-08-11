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
  runs: 3,
  threshold: 0.5,
  timeoutMs: 180_000,
  codexBin: 'codex',
  v1Model: 'gpt-5.6-luna',
  v2Model: 'gpt-5.6-sol',
  profile: 'all',
  variant: 'all',
  caseId: undefined,
  output: undefined,
};
const MAX_TRANSIENT_TRANSPORT_RETRIES = 2;
const TOOL_ROUTER_ERROR = /codex_core::tools::router: error=([^\n]+)/u;

function usage() {
  return `Usage: node plugins/codex-subagent-guide/templates/codex-subagent-guide/evals/run-routing-evals.mjs [OPTIONS]

Runs real V1/V2 spawn routing evaluations and a without-skill baseline, grading raw
spawn_agent arguments from isolated Codex rollout files.

Options:
  --runs <count>                              Repetitions per case (default: 3)
  --threshold <rate>                          Pass boundary (default: 0.5)
  --timeout-ms <milliseconds>                 Per-run timeout (default: 180000)
  --codex-bin <path>                          Codex executable (default: codex)
  --v1-model <model>                          V1 parent model (default: gpt-5.6-luna)
  --v2-model <model>                          V2 parent model (default: gpt-5.6-sol)
  --profile <v1|v2|all>                       Profiles to run (default: all)
  --variant <with_skill|without_skill|all>    Variants to run (default: all)
  --case <id>                                 Run one case only
  --output <path>                             Also write the JSON report
  -h, --help                                  Show this help`;
}

function readOptionValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

export function parseRoutingArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    const value = readOptionValue(argv, index, flag);
    index += 1;
    if (flag === '--runs') {
      options.runs = parsePositiveInteger(value, flag);
    } else if (flag === '--threshold') {
      options.threshold = Number(value);
      if (!(options.threshold > 0 && options.threshold < 1)) {
        throw new Error('--threshold must be greater than 0 and less than 1.');
      }
    } else if (flag === '--timeout-ms') {
      options.timeoutMs = parsePositiveInteger(value, flag);
      if (options.timeoutMs < 10_000) {
        throw new Error('--timeout-ms must be at least 10000.');
      }
    } else if (flag === '--codex-bin') {
      options.codexBin = value;
    } else if (flag === '--v1-model') {
      options.v1Model = value;
    } else if (flag === '--v2-model') {
      options.v2Model = value;
    } else if (flag === '--profile') {
      if (!['v1', 'v2', 'all'].includes(value)) {
        throw new Error('--profile must be v1, v2, or all.');
      }
      options.profile = value;
    } else if (flag === '--variant') {
      if (!['with_skill', 'without_skill', 'all'].includes(value)) {
        throw new Error('--variant must be with_skill, without_skill, or all.');
      }
      options.variant = value;
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

function validateExpected(expected, label) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw new Error(`${label} must be an object.`);
  }
  const min = expected.spawn_calls?.min;
  const max = expected.spawn_calls?.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) {
    throw new Error(`${label}.spawn_calls must contain a valid min/max range.`);
  }
  if (
    expected.arguments !== undefined &&
    (!expected.arguments || typeof expected.arguments !== 'object' || Array.isArray(expected.arguments))
  ) {
    throw new Error(`${label}.arguments must be an object.`);
  }
  if (
    expected.present_arguments !== undefined &&
    (!Array.isArray(expected.present_arguments) ||
      expected.present_arguments.some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`${label}.present_arguments must be a string array.`);
  }
  if (
    expected.final_message_includes_any !== undefined &&
    (!Array.isArray(expected.final_message_includes_any) ||
      expected.final_message_includes_any.length === 0 ||
      expected.final_message_includes_any.some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`${label}.final_message_includes_any must be a non-empty string array.`);
  }
}

function validateRoutingCase(entry, index) {
  const label = `evals[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${label} must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`${label}.id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.prompt !== 'string' || entry.prompt.trim() === '') {
    throw new Error(`${entry.id}.prompt must be a non-empty string.`);
  }
  if (typeof entry.expected_output !== 'string' || entry.expected_output.trim() === '') {
    throw new Error(`${entry.id}.expected_output must be a non-empty string.`);
  }
  if (!Array.isArray(entry.files)) {
    throw new Error(`${entry.id}.files must be an array.`);
  }
  for (const profile of ['v1', 'v2']) {
    validateExpected(entry.expectations?.[profile], `${entry.id}.expectations.${profile}`);
  }
  if (
    entry.omit_roles !== undefined &&
    (!Array.isArray(entry.omit_roles) ||
      entry.omit_roles.some((value) => typeof value !== 'string'))
  ) {
    throw new Error(`${entry.id}.omit_roles must be a string array.`);
  }
  return entry;
}

export async function loadRoutingSpec() {
  const spec = JSON.parse(await readEvalResource('evals.json'));
  if (spec?.skill_name !== 'codex-subagent-guide' || !Array.isArray(spec.evals)) {
    throw new Error('evals.json must describe codex-subagent-guide and contain evals.');
  }
  const evals = spec.evals.map(validateRoutingCase);
  if (new Set(evals.map((entry) => entry.id)).size !== evals.length) {
    throw new Error('evals.json contains duplicate ids.');
  }
  return { ...spec, evals };
}

function valueEvidence(args, key) {
  return Object.hasOwn(args ?? {}, key) ? JSON.stringify(args[key]) : '<absent>';
}

function evaluateArguments(call, expectedArguments) {
  const args = call?.arguments;
  if (!args) {
    return [{
      name: 'arguments',
      passed: false,
      evidence: 'spawn_agent arguments were unavailable in rollout evidence',
    }];
  }
  return Object.entries(expectedArguments ?? {}).map(([key, expected]) => {
    const present = Object.hasOwn(args, key);
    return {
      name: `arguments.${key}`,
      passed: expected === null ? !present : present && args[key] === expected,
      evidence: `expected=${expected === null ? '<absent>' : JSON.stringify(expected)} actual=${valueEvidence(args, key)}`,
    };
  });
}

function hasLoadEvidence(run) {
  return (
    run.requested_explicitly === true ||
    (
      run.loaded === true &&
      typeof run.load_evidence === 'string' &&
      run.load_evidence !== ''
    )
  );
}

export function evaluateRoutingRun(run, expected, variant) {
  const calls = run.spawn_calls ?? [];
  const loadObserved = hasLoadEvidence(run);
  const routerError = run.stderr?.match(TOOL_ROUTER_ERROR)?.[1];
  const assertions = [
    {
      name: 'execution',
      passed: !run.execution_error && !routerError,
      evidence: `termination=${run.termination} exit_code=${run.exit_code}${routerError ? ` router_error=${JSON.stringify(routerError)}` : ''}`,
    },
    {
      name: 'skill_load',
      passed: variant === 'with_skill' ? loadObserved : run.loaded === false,
      evidence: `variant=${variant} requested=${Boolean(run.requested_explicitly)} loaded=${Boolean(run.loaded)} evidence=${JSON.stringify(run.load_evidence ?? null)}`,
    },
    {
      name: 'spawn_call_count',
      passed: calls.length >= expected.spawn_calls.min && calls.length <= expected.spawn_calls.max,
      evidence: `expected=${expected.spawn_calls.min}..${expected.spawn_calls.max} actual=${calls.length}`,
    },
    {
      name: 'raw_spawn_argument_evidence',
      passed: !(run.spawned && calls.length === 0),
      evidence: run.spawned && calls.length === 0
        ? 'spawn_agent was observed but rollout arguments were unavailable'
        : `observed=${Boolean(run.spawned)} raw_calls=${calls.length}`,
    },
  ];
  if (expected.arguments) {
    assertions.push(...evaluateArguments(calls[0], expected.arguments));
  }
  for (const key of expected.present_arguments ?? []) {
    assertions.push({
      name: `present_arguments.${key}`,
      passed: Object.hasOwn(calls[0]?.arguments ?? {}, key),
      evidence: `actual=${valueEvidence(calls[0]?.arguments, key)}`,
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
    assertions,
  };
}

export function summarizeRoutingVariant(entry, profile, variant, runs, threshold) {
  const expected = entry.expectations[profile];
  const gradedRuns = runs.map((run) => ({
    ...run,
    evaluation: evaluateRoutingRun(run, expected, variant),
  }));
  const passRate = gradedRuns.filter((run) => run.evaluation.passed).length / gradedRuns.length;
  const rawEvidenceMissing = gradedRuns.filter(
    (run) => run.spawned && (run.spawn_calls ?? []).length === 0,
  ).length;
  const loadEvidenceMissing = variant === 'with_skill'
    ? gradedRuns.filter((run) => !run.execution_error && !hasLoadEvidence(run)).length
    : 0;
  const complete =
    rawEvidenceMissing === 0 &&
    loadEvidenceMissing === 0 &&
    gradedRuns.every((run) => !run.execution_error);
  return {
    id: entry.id,
    profile,
    variant,
    expected_output: entry.expected_output,
    expected,
    pass_rate: passRate,
    complete,
    raw_evidence_missing: rawEvidenceMissing,
    load_evidence_missing: loadEvidenceMissing,
    passed: complete && passRate > threshold,
    runs: gradedRuns,
  };
}

export function routingRunCase(entry, profile, variant) {
  const expected = entry.expectations[profile];
  return {
    query: entry.prompt,
    explicit_skill: true,
    should_load_skill: variant === 'with_skill',
    should_spawn_agent: expected.spawn_calls.min > 0,
    stop_on_spawn: true,
    omit_roles: entry.omit_roles,
  };
}

export function routingReportStatus(results, expectedResultCount) {
  const complete =
    results.length === expectedResultCount &&
    results.every((result) => result.complete);
  const current = results.filter((result) => result.variant === 'with_skill');
  return {
    complete,
    passed: complete && current.every((result) => result.passed),
  };
}

function thrownExecutionError(error) {
  return {
    requested_explicitly: false,
    loaded: false,
    spawned: false,
    load_evidence: null,
    spawn_calls: [],
    termination: 'environment_error',
    exit_code: null,
    execution_error: true,
    stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    final_message: null,
    duration_ms: 0,
    usage: null,
  };
}

export function shouldRetryTransportFailure(run, retriesUsed) {
  if (!run.execution_error || retriesUsed >= MAX_TRANSIENT_TRANSPORT_RETRIES) return false;
  const evidence = executionErrorEvidence(run);
  return evidence.includes('stream disconnected before completion') &&
    (
      evidence.includes('WebSocket protocol error') ||
      evidence.includes('Connection reset without closing handshake')
    );
}

async function run(options) {
  const spec = await loadRoutingSpec();
  const selected = options.caseId
    ? spec.evals.filter((entry) => entry.id === options.caseId)
    : spec.evals;
  if (selected.length === 0) {
    throw new Error(`Unknown routing eval case: ${options.caseId}`);
  }
  const profiles = options.profile === 'all' ? ['v1', 'v2'] : [options.profile];
  const variants = options.variant === 'all'
    ? ['with_skill', 'without_skill']
    : [options.variant];
  const workspaces = new Map();
  for (const variant of variants) {
    workspaces.set(
      variant,
      await createEvalWorkspace({ withSkill: variant === 'with_skill' }),
    );
  }

  const results = [];
  let environmentError = null;
  try {
    outer:
    for (const entry of selected) {
      for (const profile of profiles) {
        for (const variant of variants) {
          const runs = [];
          for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
            let result;
            const retryEvidence = [];
            do {
              const retryLabel = retryEvidence.length > 0
                ? ` retry ${retryEvidence.length}/${MAX_TRANSIENT_TRANSPORT_RETRIES}`
                : '';
              process.stderr.write(
                `[${profile}/${variant}] ${entry.id} run ${runIndex + 1}/${options.runs}${retryLabel}\n`,
              );
              try {
                result = await runCodexOnce(
                  workspaces.get(variant),
                  routingRunCase(entry, profile, variant),
                  {
                    ...options,
                    profile,
                    model: profile === 'v1' ? options.v1Model : options.v2Model,
                    captureTrace: true,
                  },
                );
              } catch (error) {
                result = thrownExecutionError(error);
              }
              if (!shouldRetryTransportFailure(result, retryEvidence.length)) break;
              retryEvidence.push(executionErrorEvidence(result));
            } while (true);
            if (retryEvidence.length > 0) {
              result = {
                ...result,
                transient_transport_retries: retryEvidence.length,
                transient_transport_retry_evidence: retryEvidence,
              };
            }
            runs.push(result);
            if (result.execution_error) {
              environmentError = executionErrorEvidence(result);
              break;
            }
          }
          results.push(
            summarizeRoutingVariant(entry, profile, variant, runs, options.threshold),
          );
          if (environmentError) {
            break outer;
          }
        }
      }
    }
  } finally {
    await Promise.all(
      [...workspaces.values()].map((workspace) =>
        rm(workspace.root, { recursive: true, force: true })),
    );
  }

  const expectedResultCount = selected.length * profiles.length * variants.length;
  const status = routingReportStatus(results, expectedResultCount);
  const rawEvidenceMissing = results.reduce(
    (total, result) => total + result.raw_evidence_missing,
    0,
  );
  const loadEvidenceMissing = results.reduce(
    (total, result) => total + result.load_evidence_missing,
    0,
  );
  const currentResults = results.filter((result) => result.variant === 'with_skill');
  const baselineResults = results.filter((result) => result.variant === 'without_skill');
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    runs_per_case: options.runs,
    threshold: options.threshold,
    profiles,
    variants,
    models: { v1: options.v1Model, v2: options.v2Model },
    complete: status.complete,
    passed: status.passed,
    environment_error: environmentError ?? (
      rawEvidenceMissing > 0
        ? 'Raw spawn_agent arguments were unavailable for one or more observed calls.'
        : loadEvidenceMissing > 0
          ? 'Skill load evidence was unavailable for one or more with-skill runs.'
          : null
    ),
    summary: {
      expected_results: expectedResultCount,
      completed_results: results.length,
      current_passed: currentResults.filter((result) => result.passed).length,
      current_total: currentResults.length,
      baseline_passed: baselineResults.filter((result) => result.passed).length,
      baseline_total: baselineResults.length,
      raw_evidence_missing: rawEvidenceMissing,
      load_evidence_missing: loadEvidenceMissing,
    },
    results,
  };
  await writeJsonReport(report, options.output);
  if (!report.passed) {
    process.exitCode = 1;
  }
}

async function main() {
  let options;
  try {
    options = parseRoutingArgs(process.argv.slice(2));
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

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
