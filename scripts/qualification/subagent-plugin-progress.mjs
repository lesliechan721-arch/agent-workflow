// Observe safe test progress without changing the formal runner's spawn,
// environment, output redaction, result handling, or test assertions.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const originalSpawn = childProcess.spawn;
const startedAt = Date.now();
let completedNamedTests = 0;
const emit = (event) => process.stderr.write(`AW_PLUGIN_TEST_PROGRESS ${JSON.stringify({ elapsedMs: Date.now() - startedAt, ...event })}\n`);

function observe(stream) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop().slice(-8192);
    for (const raw of lines) {
      const line = raw.replace(/\u001b\[[\d;]*m/g, '').trim();
      const test = line.match(/^[✔✖﹣▶] (.+?)(?: \(([\d.]+)ms\))?$/)
        ?? line.match(/^(?:ok|not ok) \d+ - (.+)$/);
      if (test) {
        const name = test[1].replace(/^(?:[A-Za-z]:[\\/]|\/).*[/\\]/, '').slice(0, 240);
        if (!name.endsWith('.test.mjs') && /^(?:[✔✖]|ok |not ok )/.test(line)) completedNamedTests += 1;
        emit({ event: 'test', name, ...(test[2] ? { durationMs: Number(test[2]) } : {}) });
      }
      const phase = line.match(/AW_SUBAGENT_PARENT_PHASE (\{.*\})$/);
      if (!phase) continue;
      try {
        const value = JSON.parse(phase[1]);
        if (!/^[A-Za-z][A-Za-z0-9]*$/.test(value.phase)) continue;
        const safe = { event: 'parent', phase: value.phase };
        if (['start', 'send', 'wait', 'result', 'stop'].includes(value.operation)) safe.operation = value.operation;
        for (const key of ['elapsedMs', 'commandElapsedMs', 'code']) {
          if (Number.isFinite(value[key])) safe[key === 'elapsedMs' ? 'fixtureElapsedMs' : key] = value[key];
        }
        emit(safe);
      } catch { /* Other output stays with the formal runner's redaction. */ }
    }
  });
}

childProcess.spawn = function (...args) {
  const child = originalSpawn.apply(this, args);
  if (args[0] === process.execPath && args[1]?.[0] === '--test') {
    const patternIndex = args[1].indexOf('--test-name-pattern');
    emit({ event: 'runnerStarted', pattern: patternIndex < 0 ? null : args[1][patternIndex + 1] });
    observe(child.stdout);
    observe(child.stderr);
    child.once('close', (code, signal) => emit({ event: 'runnerClosed', code, signal, completedNamedTests }));
  }
  return child;
};
syncBuiltinESMExports();
try {
  const { runPluginScriptTests } = await import('../../packages/cli/dist/scripts/test-plugin-scripts.js');
  process.exitCode = await runPluginScriptTests(process.argv.slice(2));
  if (completedNamedTests === 0) {
    emit({ event: 'noNamedTestsMatched' });
    process.exitCode = 1;
  }
} finally {
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}
