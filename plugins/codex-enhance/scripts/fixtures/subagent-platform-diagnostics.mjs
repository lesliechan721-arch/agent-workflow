import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';

// Test-only preload: measure the real PowerShell boundary without changing its
// result or recording arguments, environment, paths, stdout, or stderr.
const original = childProcess.execFile;
const execute = promisify(original);
const timing = { calls: 0, elapsedMs: 0, maxMs: 0, failures: 0 };
childProcess.execFile = Object.assign((...args) => original(...args), {
  [promisify.custom]: async (...args) => {
    if (path.basename(args[0]).toLowerCase() !== 'powershell.exe') return execute(...args);
    const started = performance.now();
    try { return await execute(...args); }
    catch (error) { timing.failures++; throw error; }
    finally {
      const elapsedMs = Math.round(performance.now() - started);
      timing.calls++; timing.elapsedMs += elapsedMs; timing.maxMs = Math.max(timing.maxMs, elapsedMs);
    }
  },
});
syncBuiltinESMExports();
process.on('exit', () => process.stderr.write(`AW_SUBAGENT_NATIVE_TIMING ${JSON.stringify(timing)}\n`));
