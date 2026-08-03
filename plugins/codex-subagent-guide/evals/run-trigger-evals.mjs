import { rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createEvalWorkspace,
  executionErrorEvidence,
  ratePasses,
  runCodexOnce,
  writeJsonReport,
} from './eval-harness.mjs';
import { sanityCases } from './sanity-cases.mjs';
import { trainCases } from './train-cases.mjs';
import { validationCases } from './validation-cases.mjs';

const caseSets = {
  train: trainCases,
  validation: validationCases,
  sanity: sanityCases,
};
const DEFAULT_OPTIONS = {
  split: 'train',
  runs: 3,
  threshold: 0.5,
  timeoutMs: 180_000,
  codexBin: 'codex',
  model: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/codex-subagent-guide/evals/run-trigger-evals.mjs [OPTIONS]

Runs real Codex skill-load and spawn evaluations in an isolated read-only workspace.

Options:
  --split <train|validation|sanity|all>  Eval split (default: train)
  --runs <count>                        Repetitions per query (default: 3)
  --threshold <rate>                    Pass boundary between 0 and 1 (default: 0.5)
  --timeout-ms <milliseconds>           Per-run timeout (default: 180000)
  --codex-bin <path>                    Codex executable (default: codex)
  --model <model>                       Optional parent model override
  --output <path>                       Also write the JSON report
  -h, --help                            Show this help`;
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

export function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '-h' || flag === '--help') {
      options.help = true;
      continue;
    }
    const value = readOptionValue(argv, index, flag);
    index += 1;
    if (flag === '--split') {
      if (!['train', 'validation', 'sanity', 'all'].includes(value)) {
        throw new Error('--split must be train, validation, sanity, or all.');
      }
      options.split = value;
    } else if (flag === '--runs') {
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

function validateCase(entry, split, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`${split}[${index}] must be an object.`);
  }
  if (typeof entry.id !== 'string' || !/^[a-z0-9_]+$/.test(entry.id)) {
    throw new Error(`${split}[${index}].id must use lowercase letters, digits, and underscores.`);
  }
  if (typeof entry.query !== 'string' || entry.query.trim() === '') {
    throw new Error(`${split}[${index}].query must be a non-empty string.`);
  }
  if (typeof entry.should_load_skill !== 'boolean') {
    throw new Error(`${split}[${index}].should_load_skill must be boolean.`);
  }
  if (typeof entry.should_spawn_agent !== 'boolean') {
    throw new Error(`${split}[${index}].should_spawn_agent must be boolean.`);
  }
  if (entry.should_spawn_agent && !entry.should_load_skill) {
    throw new Error(`${split}[${index}] cannot spawn without loading the skill.`);
  }
  return {
    ...entry,
    split,
    explicit_skill: entry.query.includes('$codex-subagent-guide'),
  };
}

export async function loadEvalCases(split = 'train') {
  const splits = split === 'all' ? ['train', 'validation', 'sanity'] : [split];
  const cases = splits.flatMap((name) =>
    caseSets[name].map((entry, index) => validateCase(entry, name, index)));
  const ids = new Set();
  for (const entry of cases) {
    if (ids.has(entry.id)) {
      throw new Error(`Duplicate eval id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return cases;
}

export function summarizeCase(evalCase, runs, threshold) {
  const loadRate = runs.filter((run) => run.loaded).length / runs.length;
  const spawnRate = runs.filter((run) => run.spawned).length / runs.length;
  const executionErrors = runs.filter((run) => run.execution_error).length;
  return {
    id: evalCase.id,
    split: evalCase.split,
    query: evalCase.query,
    expected: {
      load_skill: evalCase.should_load_skill,
      spawn_agent: evalCase.should_spawn_agent,
    },
    observed: {
      load_rate: loadRate,
      spawn_rate: spawnRate,
      execution_errors: executionErrors,
    },
    passed:
      executionErrors === 0 &&
      ratePasses(loadRate, evalCase.should_load_skill, threshold) &&
      ratePasses(spawnRate, evalCase.should_spawn_agent, threshold),
    runs,
  };
}

function thrownExecutionError(error) {
  return {
    loaded: false,
    spawned: false,
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

async function run(options) {
  const cases = await loadEvalCases(options.split);
  const workspace = await createEvalWorkspace({ withSkill: true });
  const results = [];
  let environmentError = null;
  try {
    for (const evalCase of cases) {
      const runs = [];
      for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
        process.stderr.write(
          `[${evalCase.split}] ${evalCase.id} run ${runIndex + 1}/${options.runs}\n`,
        );
        let result;
        try {
          result = await runCodexOnce(workspace, evalCase, {
            ...options,
            profile: 'v2',
            captureTrace: true,
          });
        } catch (error) {
          result = thrownExecutionError(error);
        }
        runs.push(result);
        if (result.execution_error) {
          environmentError = executionErrorEvidence(result);
          break;
        }
      }
      results.push(summarizeCase(evalCase, runs, options.threshold));
      if (environmentError) {
        break;
      }
    }
  } finally {
    await rm(workspace.root, { recursive: true, force: true });
  }

  const complete = !environmentError && results.length === cases.length;
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    split: options.split,
    runs_per_case: options.runs,
    threshold: options.threshold,
    model: options.model ?? null,
    complete,
    passed: complete && results.every((result) => result.passed),
    environment_error: environmentError,
    summary: {
      expected_cases: cases.length,
      completed_cases: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
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
    options = parseArgs(process.argv.slice(2));
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
