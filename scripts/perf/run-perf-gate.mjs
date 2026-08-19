import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

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
  'git-source-selector-strict-cache-warm',
  'local-four-source-git-path-fanout',
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

function runChild(label, args, timeoutMs) {
  const invocation = resolvePnpmInvocation(args);
  return runProcessTree({
    label,
    command: invocation.command,
    args: invocation.args,
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs,
    onStdout: (text) => process.stdout.write(text),
    onStderr: (text) => process.stderr.write(text),
  });
}

export function assertExpectedPerfSummaries(output) {
  const names = output
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

export async function runPerfGate() {
  const performanceResult = await runChild('performance Vitest', [
    '--filter',
    '@lesliechan721/aw',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.perf.config.ts',
  ], PERF_HARD_TIMEOUT_MS);
  assertExpectedPerfSummaries(performanceResult.stdout);

  const fastUnitStartedAt = performance.now();
  await runChild('fast unit lane', [
    '--filter',
    '@lesliechan721/aw',
    'run',
    'test:unit:fast',
  ], FAST_UNIT_HARD_TIMEOUT_MS);
  const fastUnitWallMs = Math.round((performance.now() - fastUnitStartedAt) * 100) / 100;
  console.log(`${SUMMARY_PREFIX}${JSON.stringify({
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
