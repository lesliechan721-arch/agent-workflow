import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { prepareWindowsNativeResources, windowsNativeSpawn } from './windows-native-host.mjs';
import { promisify } from 'node:util';

// Rules use real files and replace native ACL and process operations. Identity
// stays native so scanner processes read the same resource owner. The native
// storage test leaves every operation connected to the real host.
await prepareWindowsNativeResources(new URL('../storage.test.mjs', import.meta.url), createRequire(import.meta.url).resolve('../../skills/codex-subagent-guide/scripts/runtime/platform.mjs'));
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
  childProcess.execFile = Object.assign(() => {}, { [promisify.custom]: executeNative });
  const simulatedNative = windowsNativeSpawn(async (_command, _args, _options, { operation, input }) => {
    if (operation === 'processTable') return { result: [{ pid: process.pid, ppid: process.ppid, pgid: null, started: '1' }] };
    if (operation === 'rootPublish') await fs.rename(input.source, input.destination);
    else if (!['aclVerify', 'aclProtect', 'pathCheck', 'pathTree'].includes(operation)) throw new Error(`Unexpected storage host operation: ${operation}`);
    return { result: true };
  }, spawnStorage);
  childProcess.spawn = (...args) => nativeHost ? originalSpawn(...args) : simulatedNative(...args);
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
