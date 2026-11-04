import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import path from 'node:path';

// Test-only preload: measure real native calls in this process without changing their
// result or recording arguments, environment, paths, stdout, or stderr.
const original = childProcess.execFile;
const execute = promisify(original);
const counters = () => ({ calls: 0, elapsedMs: 0, maxMs: 0, failures: 0, timeouts: 0 });
const timing = { ...counters(), operations: {}, hosts: {} };
const operations = new Set(['identity', 'aclVerify', 'aclProtect', 'pathCheck', 'pathTree', 'rootPublish', 'processTable', 'processIdentity', 'processStop', 'jobObserve', 'jobStop']);
childProcess.execFile = Object.assign((...args) => original(...args), {
  [promisify.custom]: async (...args) => {
    const host = path.basename(args[0]).toLowerCase();
    if (!['powershell.exe', 'whoami.exe'].includes(host)) return execute(...args);
    const label = args[2]?.env?.AW_SUBAGENT_NATIVE_OPERATION;
    const operation = operations.has(label) ? label : 'other';
    const groups = [timing, timing.operations[operation] ??= counters(), timing.hosts[host] ??= counters()];
    const started = performance.now();
    try { return await execute(...args); }
    catch (error) {
      for (const group of groups) { group.failures++; if (error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') group.timeouts++; }
      throw error;
    }
    finally {
      const elapsedMs = Math.round(performance.now() - started);
      for (const group of groups) { group.calls++; group.elapsedMs += elapsedMs; group.maxMs = Math.max(group.maxMs, elapsedMs); }
    }
  },
});
syncBuiltinESMExports();
process.on('exit', () => process.stderr.write(`AW_SUBAGENT_NATIVE_TIMING ${JSON.stringify(timing)}\n`));
