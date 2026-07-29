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
} from './run-trigger-evals.mjs';

const DEFAULT_OPTIONS = {
  runs: 1,
  timeoutMs: 180_000,
  codexBin: 'codex',
  model: undefined,
  output: undefined,
};

function usage() {
  return `Usage: node plugins/codex-explore/evals/run-workflow-evals.mjs [OPTIONS]

Runs a current-skill outcome smoke to completion. It checks the selected agent,
the final evidence contract, and workspace changes. It does not inspect Codex
wait or message-delivery internals.

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
  const expected = entry.expected;
  if (
    !expected ||
    expected.spawn_count !== 1 ||
    typeof expected.agent_type !== 'string' ||
    !nonEmptyStrings(expected.final_message_includes_all) ||
    !nonEmptyStrings(expected.final_message_patterns) ||
    expected.workspace_unchanged !== true
  ) {
    throw new Error(`${entry.id}.expected does not define the outcome contract.`);
  }
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
  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export function workflowEvalRunCase(entry) {
  return {
    query: entry.prompt,
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
      process.stderr.write(`[current] ${entry.id} run ${index + 1}/${options.runs}\n`);
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
    model: options.model ?? null,
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
