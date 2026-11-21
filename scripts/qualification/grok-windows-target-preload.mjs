import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const samePath = (actual, expected) =>
  Boolean(actual && expected && path.isAbsolute(actual) && path.relative(expected, actual) === '');
const { GROK_DIAG_ENTRY: entry, GROK_DIAG_TRACE: trace, GROK_DIAG_DELAY: delayedProbe,
  GROK_DIAG_GATE: gate } = process.env;

function probeKind(args) {
  if (args.length === 1 && args[0] === '--version') return 'version';
  if (args.length === 1 && args[0] === '--help') return 'identityHelp';
  if (args.length === 2 && args[0] === 'plugin' && args[1] === '--help') return 'pluginHelp';
  if (args.length === 3 && args[0] === 'plugin' && args[1] === 'list' && args[2] === '--help') return 'listHelp';
}

// Imported into the selected child before the genuine npm launcher runs.
if (samePath(process.argv[1], entry)) {
  if (probeKind(process.argv.slice(2)) !== delayedProbe) process.exit(91);
  writeFileSync(gate, `started\n${process.pid}\n`, { flag: 'wx' });
  await delay(6_500);
  appendFileSync(gate, 'continued\n');
} else {
  // Imported into the public AW process. Preserve its default runner,
  // Windows Job, original deadlines, cancellation, and result handling.
  const nativeFile = path.join(path.dirname(process.argv[1]), 'src', 'utils', 'native-cli.js');
  const native = await import(pathToFileURL(nativeFile));
  const base = native.getDefaultNativeCliRunner();
  let usedDelay = false;
  const wrapper = async (invocation) => {
    const probe = samePath(invocation.command, process.execPath) && samePath(invocation.args[0], entry)
      ? probeKind(invocation.args.slice(1)) : undefined;
    if (!probe) return base(invocation);
    const delayed = probe === delayedProbe && !usedDelay;
    usedDelay ||= delayed;
    const started = performance.now();
    let spawned = false;
    function record(reply, failed) {
      const nativeError = failed && reply instanceof native.NativeCliError;
      const version = probe === 'version' && !failed && /\bgrok\b/iu.test(reply.stdout + reply.stderr)
        && /\b1\.0\.77\b/u.test(reply.stdout + reply.stderr) ? '1.0.77' : null;
      appendFileSync(trace, JSON.stringify({
        probe, elapsedMs: Math.round(performance.now() - started),
        exitCode: Number.isInteger(reply?.exitCode) ? reply.exitCode : null,
        reason: nativeError ? reply.reason : failed ? 'probeError' : 'complete',
        version, cleanupConfirmed: spawned && (!failed || nativeError && !reply.cleanupError && reply.exitCode !== 250),
      }) + '\n');
    }
    let result;
    try {
      result = await base({
        ...invocation,
        args: delayed ? ['--import', import.meta.url, ...invocation.args] : invocation.args,
        onSpawn(child) {
          spawned = true;
          invocation.onSpawn?.(child);
        },
      });
    } catch (error) {
      try { record(error, true); } catch { /* The parent checks trace completeness. */ }
      throw error;
    }
    try { record(result, false); } catch { /* The parent checks trace completeness. */ }
    return result;
  };
  native.setNativeCliRunnerOverrideForTests(native.retainNativeCliRunnerBackend(wrapper, base));
}
