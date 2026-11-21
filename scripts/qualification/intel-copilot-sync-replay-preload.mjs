import fs from 'node:fs';
import path from 'node:path';
import {
  getDefaultNativeCliRunner, retainNativeCliRunnerBackend, setNativeCliRunnerOverrideForTests,
} from '../../packages/cli/dist/src/utils/native-cli.js';
import { defaultPluginProcessRunner } from '../../packages/cli/dist/src/utils/plugin-scripts.js';

const file = process.env.AW_INTEL_COPILOT_REPLAY_TRACE;
const ordinal = Number(process.env.AW_INTEL_COPILOT_REPLAY_ORDINAL);
if (!path.isAbsolute(file ?? '') || !Number.isSafeInteger(ordinal) || ordinal <= 0) {
  throw new Error('invalid-intel-copilot-trace');
}

const operations = new Map([
  ['--version', 'version'],
  ['--help', 'help'],
  ['plugin list --json', 'plugin-list'],
  ['plugin marketplace list --json', 'marketplace-list'],
]);
const errorCodes = new Set(['EPERM', 'ESRCH', 'EACCES', 'ETIMEDOUT', 'ENOENT', 'EAGAIN', 'ABORT_ERR']);
const cleanupKinds = [
  ['group-signal-refused', /could not signal process group/u],
  ['group-exit-check-failed', /could not verify process group exit/u],
  ['group-still-running', /process group is still running/u],
  ['cleanup-deadline', /cleanup timed out/u],
  ['marker-lookup-failed', /POSIX process marker lookup failed/u],
  ['identity-lookup-failed', /POSIX process identity lookup failed/u],
  ['termination-verification-failed', /POSIX termination verification failed/u],
  ['termination-audit-failed', /POSIX termination audit failed/u],
  ['marker-unreadable', /marker could not be read/u],
  ['descendant-still-running', /descendant is still running/u],
];

function record(fields) {
  try {
    fs.appendFileSync(file, JSON.stringify({ ordinal, ...fields }) + '\n', { mode: 0o600 });
  } catch { /* Diagnostic I/O cannot change process outcomes. */ }
}

function cleanup(error) {
  if (!error) return undefined;
  const message = typeof error.message === 'string' ? error.message : '';
  const code = error.cause?.code ?? error.code;
  return {
    kind: cleanupKinds.find(([, matches]) => matches.test(message))?.[0] ?? 'other',
    code: errorCodes.has(code) ? code : undefined,
    signal: message.match(/signal process group (SIGTERM|SIGKILL)\b/u)?.[1],
  };
}

const base = getDefaultNativeCliRunner();
const traced = async invocation => {
  const started = performance.now();
  try {
    return await base(invocation);
  } catch (error) {
    const [entry, ...args] = invocation.args;
    let operation = 'other';
    if (typeof entry === 'string' && entry === process.env.AW_INTEL_COPILOT_REPLAY_ENTRY) {
      operation = operations.get(args.join(' ')) ?? 'other';
      if (args.length === 4 && args.slice(0, 3).join(' ') === 'plugin marketplace add') operation = 'marketplace-add';
      if (args.length === 3 && args[0] === 'plugin' && args[1] === 'install') operation = 'plugin-install';
      if (args.length === 3 && args[0] === 'plugin' && ['uninstall', 'remove'].includes(args[1])) operation = 'plugin-remove';
    }
    record({
      kind: 'native', operation,
      reason: ['exit', 'timeout', 'aborted', 'spawn'].includes(error?.reason) ? error.reason : undefined,
      exitCode: Number.isSafeInteger(error?.exitCode) ? error.exitCode : undefined,
      causeCode: errorCodes.has(error?.cause?.code) ? error.cause.code : undefined,
      elapsedMs: Math.round(performance.now() - started),
      cleanup: cleanup(error?.cleanupError),
    });
    throw error;
  }
};
setNativeCliRunnerOverrideForTests(retainNativeCliRunnerBackend(traced, base));

const runScript = defaultPluginProcessRunner.run.bind(defaultPluginProcessRunner);
defaultPluginProcessRunner.run = async (invocation, options) => {
  const started = performance.now();
  try {
    return await runScript(invocation, options);
  } catch (error) {
    if (error?.operationDiagnostic?.code === 'pluginProcessCleanupFailed') {
      record({ kind: 'plugin-script', elapsedMs: Math.round(performance.now() - started),
        cleanup: cleanup(error.cause ?? error) });
    }
    throw error;
  }
};
