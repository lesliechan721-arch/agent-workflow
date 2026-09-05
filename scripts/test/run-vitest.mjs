import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { runProcessTree } from '../perf/process-tree.mjs';

const TEST_RUNNER_PROCESS_TREE_ENV = 'AW_TEST_RUNNER_PROCESS_TREE';
const TEST_RUN_ID_ENV = 'AW_TEST_RUN_ID';
const TEST_METRICS_DIR_ENV = 'AW_TEST_METRICS_DIR';
const SIGNAL_EXIT_CODES = new Map([
  ['SIGINT', 130],
  ['SIGTERM', 143],
]);

function resolveVitestEntry(cwd) {
  const require = createRequire(path.join(cwd, 'package.json'));
  return path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
}

export async function runVitest(args = process.argv.slice(2)) {
  const startedAt = performance.now();
  const correlationRunId = process.env[TEST_RUN_ID_ENV] || undefined;
  const runId = randomUUID();
  const processTreeMetrics = {};
  const controller = new AbortController();
  const forceController = new AbortController();
  let receivedSignal;
  const signalHandlers = new Map();
  for (const signal of SIGNAL_EXIT_CODES.keys()) {
    const handler = () => {
      if (!receivedSignal) {
        receivedSignal = signal;
        controller.abort(new Error(`Vitest wrapper received ${signal}.`));
        return;
      }
      forceController.abort(new Error(`Vitest wrapper received repeated ${signal}.`));
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const result = await runProcessTree({
      label: 'Vitest',
      command: process.execPath,
      args: [resolveVitestEntry(process.cwd()), ...args],
      cwd: process.cwd(),
      env: {
        ...process.env,
        [TEST_RUNNER_PROCESS_TREE_ENV]: '1',
        [TEST_RUN_ID_ENV]: runId,
      },
      metrics: process.env[TEST_METRICS_DIR_ENV] ? processTreeMetrics : undefined,
      signal: controller.signal,
      forceSignal: forceController.signal,
      timeoutMs: null,
      allowNonZeroExitCode: true,
      captureOutput: false,
      onStdout: (text) => process.stdout.write(text),
      onStderr: (text) => process.stderr.write(text),
    });
    if (receivedSignal) {
      return SIGNAL_EXIT_CODES.get(receivedSignal);
    }
    return result.exitCode ?? 1;
  } catch (error) {
    if (receivedSignal && error === controller.signal.reason) {
      return SIGNAL_EXIT_CODES.get(receivedSignal);
    }
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) {
      process.removeListener(signal, handler);
    }
    const metricsDir = process.env[TEST_METRICS_DIR_ENV];
    if (metricsDir) {
      await fs.mkdir(metricsDir, { recursive: true });
      const resourceUsage = process.resourceUsage();
      const metrics = {
        runId,
        correlationRunId,
        wallMs: performance.now() - startedAt,
        maxRssMb: resourceUsage.maxRSS / 1024,
        managedSpawnCount: processTreeMetrics.managedSpawnCount ?? 0,
        processTableScanCount: processTreeMetrics.processTableScanCount ?? 0,
        peakLiveDescendants: processTreeMetrics.peakLiveDescendants === undefined
          ? 0
          : processTreeMetrics.peakLiveDescendants,
        cleanupFailureCount: processTreeMetrics.cleanupFailureCount ?? 0,
        leakedProcessCount: processTreeMetrics.leakedProcessCount === undefined
          ? 0
          : processTreeMetrics.leakedProcessCount,
        maxRssScope: 'vitest-wrapper',
      };
      await fs.writeFile(
        path.join(metricsDir, `${encodeURIComponent(runId)}.json`),
        `${JSON.stringify(metrics)}${os.EOL}`,
        { flag: 'wx' },
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exitCode = await runVitest();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
