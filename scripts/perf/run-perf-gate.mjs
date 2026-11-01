import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { runProcessTree } from './process-tree.mjs';

const FAST_UNIT_BUDGET_MS = 30_000;
const FAST_UNIT_HARD_TIMEOUT_MS = 45_000;
const PERF_HARD_TIMEOUT_MS = 120_000;
const SUMMARY_PREFIX = 'AW_PERF_SUMMARY ';
export const EXPECTED_PERF_SUMMARY_NAMES = [
  'path-source-resolution-warm',
  'path-source-force-validation',
  'path-source-after-marketplace-rebuild',
  'multi-source-status-console-warm',
  'catalog-source-config-warm',
  'git-source-current-snapshot-warm',
  'active-four-source-read-warm',
  'tui-review-preparation-warm-large',
  'tui-catalog-local-stages-warm',
  'install-write-command-warm',
  'install-local-stages-warm',
  'git-source-remote-deadline-cleanup',
];

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..', '..');

function resolvePnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath?.trim();
  if (!npmExecPath) {
    throw new Error(
      'Cannot run the performance gate because npm_execpath is missing. Run this script through pnpm.',
    );
  }
  return {
    command: process.execPath,
    args: [npmExecPath, ...args],
  };
}

function runChild(label, args, timeoutMs, env) {
  const invocation = resolvePnpmInvocation(args);
  return runProcessTree({
    label,
    command: invocation.command,
    args: invocation.args,
    cwd: repositoryRoot,
    env,
    timeoutMs,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
}

export function assertExpectedPerfSummaries(output) {
  const names = stripVTControlCharacters(output)
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(SUMMARY_PREFIX))
    .map((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line.slice(SUMMARY_PREFIX.length));
      } catch (error) {
        throw new Error(
          `Performance gate found an invalid AW_PERF_SUMMARY line: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      if (!parsed || typeof parsed !== 'object' || typeof parsed.name !== 'string') {
        throw new Error('Performance gate found an AW_PERF_SUMMARY without a string name.');
      }
      return parsed.name;
    });
  const duplicates = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))].sort();
  const expected = new Set(EXPECTED_PERF_SUMMARY_NAMES);
  const actual = new Set(names);
  const missing = EXPECTED_PERF_SUMMARY_NAMES.filter((name) => !actual.has(name));
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (duplicates.length > 0 || missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      'Performance summary set does not match the required budgets.',
      `missing=${missing.join(',') || 'none'}`,
      `unexpected=${unexpected.join(',') || 'none'}`,
      `duplicates=${duplicates.join(',') || 'none'}`,
    ].join(' '));
  }
}

export async function runPerfGate(dependencies = {}) {
  const executeChild = dependencies.runChild ?? runChild;
  const now = dependencies.now ?? (() => performance.now());
  const log = dependencies.log ?? ((text) => console.log(text));
  const env = { ...(dependencies.env ?? process.env), AW_TEST_WORKERS: '' };
  log('AW_TEST_WORKERS {"runner":"performance-gate","maxWorkers":1,"source":"serial constraint"}');
  const performanceResult = await executeChild('performance Vitest', [
    '--filter',
    '@lesliechan721/aw',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.perf.config.ts',
  ], PERF_HARD_TIMEOUT_MS, env);
  assertExpectedPerfSummaries(performanceResult.stdout);

  const fastUnitStartedAt = now();
  log('AW_TEST_WORKERS {"runner":"fast-unit-baseline","maxWorkers":2,"source":"performance baseline"}');
  await executeChild('fast unit lane', [
    '--filter',
    '@lesliechan721/aw',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.fast.config.ts',
    '--maxWorkers=2',
    '--minWorkers=1',
  ], FAST_UNIT_HARD_TIMEOUT_MS, env);
  const fastUnitWallMs = Math.round((now() - fastUnitStartedAt) * 100) / 100;
  log(`${SUMMARY_PREFIX}${JSON.stringify({
    name: 'unit-fast-wall',
    samples: 1,
    p50Ms: fastUnitWallMs,
    p95Ms: fastUnitWallMs,
    maxMs: fastUnitWallMs,
    budgetMs: FAST_UNIT_BUDGET_MS,
  })}`);

  if (fastUnitWallMs > FAST_UNIT_BUDGET_MS) {
    throw new Error(
      `unit-fast-wall ${fastUnitWallMs}ms exceeded ${FAST_UNIT_BUDGET_MS}ms.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  runPerfGate().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
