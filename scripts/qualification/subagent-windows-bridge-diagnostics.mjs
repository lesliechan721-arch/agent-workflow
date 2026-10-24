#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Deterministic fake-only bridge cases with real host files, ACLs, and processes.
// No backend CLI or model runs. Phase records contain no message text or binding.
const selected = process.argv[2] ?? 'all';
const cases = {
  cleanup: 'caller and scanner never delete the same response concurrently',
  script: 'generated script preserves text, rejects invalid input, and leaves no tool history',
  close: 'close wakes default receive, cancels submission, resolves queued inputs, and removes resources',
  abandon: 'an abandoned receive releases the shared receiver instead of blocking later tools',
};
if (process.argv.length > 3 || (selected !== 'all' && !Object.hasOwn(cases, selected))) {
  process.stderr.write('Use: node scripts/qualification/subagent-windows-bridge-diagnostics.mjs [all|cleanup|script|close|abandon]\n');
  process.exitCode = 2;
} else {
  const began = performance.now();
  const pattern = selected === 'all' ? Object.values(cases).join('|') : cases[selected];
  const testFile = fileURLToPath(new URL('../../plugins/codex-enhance/scripts/subagent-bridge-v5.test.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1', `--test-name-pattern=^(?:${pattern})$`, testFile], {
    env: { ...process.env, AW_SUBAGENT_COMMUNICATION_DIAGNOSTICS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  const emit = (event) => process.stdout.write(`AW_SUBAGENT_WINDOWS_BRIDGE_DIAGNOSTICS ${JSON.stringify(event)}\n`);
  emit({ phase: 'started', selected, platform: process.platform, node: process.version, pid: child.pid });
  // A bounded diagnostic watchdog; semantic timeouts are simulated in the suite.
  const watchdog = setTimeout(() => { emit({ phase: 'watchdogExpired', selected }); child.kill(); }, 180000);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  child.once('error', (error) => { emit({ phase: 'spawnFailed', code: error.code }); process.exitCode = 1; });
  child.once('close', (exitCode, signal) => {
    clearTimeout(watchdog);
    emit({ phase: 'closed', selected, exitCode, signal, elapsedMs: Math.round(performance.now() - began) });
    process.exitCode = exitCode === 0 ? 0 : 1;
  });
}
