import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';

// Rules use real files and replace native ACL and process operations. Identity
// stays native so scanner processes read the same resource owner. The native
// storage test leaves every operation connected to the real host.
const originalExecFile = childProcess.execFile;
const originalSpawn = childProcess.spawn;
const executeNative = promisify(originalExecFile);
let nativeHost = true;

export function setNativeStorageHost(enabled) {
  nativeHost = enabled;
  childProcess.spawn = enabled ? originalSpawn : spawnStorage;
  syncBuiltinESMExports();
}

function spawnStorage(command, ...args) {
  if (command !== '/bin/ps') return originalSpawn(command, ...args);
  const child = new EventEmitter();
  child.stdout = Readable.from([Buffer.from(`${process.pid} ${process.ppid} ${process.pid} fixture-worker\n`)]);
  child.kill = () => {};
  child.stdout.once('end', () => child.emit('close', 0));
  return child;
}

let store, files, processes;
try {
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: async (command, args, options) => {
    if (nativeHost || path.basename(command).toLowerCase() === 'whoami.exe') return executeNative(command, args, options);
    const operation = options.env.AW_SUBAGENT_NATIVE_OPERATION;
    if (operation === 'processTable') return { stdout: JSON.stringify([{ pid: process.pid, ppid: process.ppid, started: '1' }]) };
    const input = JSON.parse(Buffer.from(options.env.AW_SUBAGENT_PLATFORM_INPUT, 'base64').toString('utf8'));
    if (operation === 'rootPublish') await fs.rename(input.source, input.destination);
    else if (!['aclVerify', 'aclProtect', 'pathCheck', 'pathTree'].includes(operation)) throw new Error(`Unexpected storage host operation: ${operation}`);
    return { stdout: 'true' };
  } });
  syncBuiltinESMExports();
  [store, files, processes] = await Promise.all([
    import('../../skills/codex-subagent-guide/scripts/runtime/store.mjs'),
    import('../../skills/codex-subagent-guide/scripts/runtime/files.mjs'),
    import('../../skills/codex-subagent-guide/scripts/runtime/processes.mjs'),
  ]);
} finally {
  childProcess.execFile = originalExecFile;
  childProcess.spawn = originalSpawn;
  syncBuiltinESMExports();
}

export { store, files, processes };
