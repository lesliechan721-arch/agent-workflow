import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { runProcessTree } from '../perf/process-tree.mjs';

const TEST_RUNNER_PROCESS_TREE_ENV = 'AW_TEST_RUNNER_PROCESS_TREE';
const SIGNAL_EXIT_CODES = new Map([
  ['SIGINT', 130],
  ['SIGTERM', 143],
]);

function resolveVitestEntry(cwd) {
  const require = createRequire(path.join(cwd, 'package.json'));
  return path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
}

export async function runVitest(args = process.argv.slice(2)) {
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
      },
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
