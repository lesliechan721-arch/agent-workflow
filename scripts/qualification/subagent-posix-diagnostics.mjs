#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Native qualification only. ps stdout can contain credentials. It goes only
// to owner-private temporary files, is never read or printed, and is deleted.
const prefix = 'AW_SUBAGENT_POSIX_DIAGNOSTICS';
const timeoutMs = 3000;
const productionLimit = 16 * 1024 * 1024;
const emit = (value) => process.stdout.write(`${prefix} ${JSON.stringify(value)}\n`);
const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };
const fields = 'pid=,ppid=,pgid=,lstart=,command=';
const candidates = [
  ['identityTable', ['-axo', 'pid=,ppid=,pgid=,lstart=']],
  ['singleMarker', ['eww', '-p', String(process.pid), '-o', 'pid=,lstart=,command=']],
  ['productionGlobal', ['eww', '-axo', fields]],
  ['bsdGlobal', ['axeww', '-o', fields]],
  ['unixAllWithEnvironment', ['eww', '-e', '-o', fields]],
  ['splitGlobal', ['-e', 'eww', '-o', fields]],
];

async function probe(directory, name, args) {
  const target = path.join(directory, `${name}.stdout`);
  const file = await fs.open(target, 'wx', 0o600);
  const began = performance.now();
  try {
    const result = await new Promise((resolve) => {
      const child = spawn('/bin/ps', args, { detached: true, shell: false, env: environment, stdio: ['ignore', file.fd, 'pipe'] });
      let stderr = '', errorCode = null, timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stderr.on('data', (chunk) => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); });
      child.once('error', (error) => { errorCode = error.code ?? 'spawnFailed'; });
      child.once('close', (exit, signal) => {
        clearTimeout(timer);
        resolve({ exit, signal, killed: child.killed, timedOut, errorCode, stderr });
      });
    });
    const stdoutBytes = (await file.stat()).size;
    return { name, argv: args, elapsedMs: Math.round(performance.now() - began), ...result, stdoutBytes, exceedsProductionLimit: stdoutBytes > productionLimit };
  } finally {
    await file.close();
    await fs.unlink(target);
  }
}

async function main() {
  if (!['darwin', 'linux'].includes(process.platform)) {
    emit({ type: 'skipped', reason: 'Native POSIX is required.', platform: process.platform });
    return;
  }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-posix-diagnostic-'));
  await fs.chmod(directory, 0o700);
  try {
    emit({ type: 'begin', platform: process.platform, arch: process.arch, node: process.version, timeoutMs, productionLimit });
    for (const [name, args] of candidates) emit({ type: 'probe', ...await probe(directory, name, args) });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
    emit({ type: 'cleanup', removed: true });
  }
}

main().catch((error) => {
  // No arbitrary child output, environment, file content, or command text.
  emit({ type: 'error', code: typeof error.code === 'string' ? error.code : 'diagnosticFailed' });
  process.exitCode = 1;
});
