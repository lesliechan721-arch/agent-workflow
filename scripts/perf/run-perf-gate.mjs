import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { runProcessTree } from './process-tree.mjs';

const FAST_UNIT_BUDGET_MS = 30_000;
const FAST_UNIT_HARD_TIMEOUT_MS = 45_000;
const PERF_HARD_TIMEOUT_MS = 120_000;
const SUMMARY_PREFIX = 'AW_PERF_SUMMARY ';

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

export async function runPerfGate() {
  await runChild('performance Vitest', [
    '--filter',
    '@yiliang/aw',
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.perf.config.ts',
  ], PERF_HARD_TIMEOUT_MS);

  const fastUnitStartedAt = performance.now();
  await runChild('fast unit lane', [
    '--filter',
    '@yiliang/aw',
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
