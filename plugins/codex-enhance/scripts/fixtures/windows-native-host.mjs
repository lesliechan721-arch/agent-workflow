import fs from 'node:fs/promises';
import { guideRuntimeScripts } from './guide-runtime-resources.mjs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';

// Replace the subprocess boundary, preserving the actual UTF-8 stdin and
// stdout protocol used by the runtime. Other child processes stay native.
export function windowsNativeSpawn(execute, fallback) {
  return (command, args, options) => {
    if (path.basename(command) !== 'aw-windows-job.exe' || args[0] !== '--operation') return fallback(command, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    let closed = false;
    const close = (code, signal = null) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.emit('close', code, signal);
    };
    child.kill = (signal) => { close(null, signal); return true; };
    const chunks = [];
    child.stdin = new Writable({
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
      final(callback) {
        callback();
        Promise.resolve().then(async () => {
          const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const response = await execute(command, args, options, request);
          if (response.error) { child.emit('error', response.error); close(null); return; }
          const stdout = response.stdout ?? JSON.stringify({ schemaVersion: 1, result: response.result });
          child.stdout.write(stdout);
          close(response.code ?? 0, response.signal ?? null);
        }).catch((error) => { child.emit('error', error); close(null); });
      },
    });
    return child;
  };
}

export async function prepareWindowsNativeResources(from, runtimeEntry) {
  const source = path.join(guideRuntimeScripts(from), 'runtime/native');
  const target = path.join(path.dirname(runtimeEntry), 'native');
  if (source !== target && !await fs.lstat(target).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })) await fs.cp(source, target, { recursive: true });
}
