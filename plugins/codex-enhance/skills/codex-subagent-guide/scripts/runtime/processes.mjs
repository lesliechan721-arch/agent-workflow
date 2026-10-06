import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fail } from './contracts.mjs';

const execFileAsync = promisify(execFile);
const supported = new Set(['darwin', 'linux']);
const maximumObserverBytes = 8 * 1024 * 1024;

// macOS file sandboxes cannot execute the setuid system ps. Use the same bytes
// without setuid, from the fixed root-owned source, for this one observation.
export async function withSystemPs(operation) {
  if (process.platform !== 'darwin') return operation('/bin/ps');
  for (const target of ['/', '/bin', '/bin/ps']) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (target === '/bin/ps' ? !stat.isFile() : !stat.isDirectory())) fail('processObserverSourceUnsafe', 'The fixed system process observer is not a safe root-owned source.');
  }
  const source = await fs.open('/bin/ps', constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = await source.stat();
    if (!before.isFile() || before.uid !== 0 || (before.mode & 0o022) !== 0 || before.size < 1 || before.size > maximumObserverBytes) fail('processObserverSourceUnsafe', 'The fixed system process observer is unsafe or exceeds its size limit.');
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await source.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) fail('processObserverSourceChanged', 'The fixed system process observer changed while being read.');
      offset += read.bytesRead;
    }
    const extra = await source.read(Buffer.alloc(1), 0, 1, offset);
    const after = await source.stat();
    if (extra.bytesRead || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some((key) => before[key] !== after[key])) fail('processObserverSourceChanged', 'The fixed system process observer changed while being read.');
  } finally { await source.close(); }
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'aw-subagent-ps-'));
  const executable = path.join(directory, 'ps');
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(executable, bytes, { mode: 0o755, flag: 'wx' });
    await fs.chmod(executable, 0o755);
    if (!(await fs.readFile(executable)).equals(bytes)) fail('processObserverCopyChanged', 'The private process observer does not match the fixed system source.');
    return await operation(executable);
  } finally {
    // Only these freshly created resources belong to this observation.
    await fs.unlink(executable).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(directory).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

function observerEnvironment() {
  return { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...(process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER ? { AW_AGENT_SKILL_EVAL_PROCESS_MARKER: process.env.AW_AGENT_SKILL_EVAL_PROCESS_MARKER } : {}) };
}

export async function processTable() {
  if (!supported.has(process.platform)) fail('platformUnsupported', 'Managed external runs support macOS and Linux only.');
  let stdout;
  try { ({ stdout } = await withSystemPs((executable) => execFileAsync(executable, ['-axo', 'pid=,ppid=,pgid=,lstart='], { timeout: 3000, maxBuffer: 4194304, env: observerEnvironment() }))); }
  catch { fail('processObservationFailed', 'Process ownership could not be observed.'); }
  return stdout.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4] }] : [];
  });
}

export async function ownsProcess(identity, token) {
  if (!/^[a-f0-9]{48}$/.test(token ?? '')) return false;
  const row = (await processTable()).find((item) => item.pid === identity.pid);
  if (!row || row.started !== identity.started) return false;
  try {
    // The environment is used only for the ownership marker. It is never logged or persisted.
    const { stdout } = await withSystemPs((executable) => execFileAsync(executable, ['eww', '-p', String(identity.pid), '-o', 'command='], { timeout: 3000, maxBuffer: 2097152, env: observerEnvironment() }));
    return stdout.split(/\s+/).includes(`AW_SUBAGENT_PROCESS_TOKEN=${token}`);
  } catch { return false; }
}

export async function observeTree(rootPid, known, token) {
  const table = await processTable();
  const candidates = new Set([rootPid, ...known.map((item) => item.pid)]);
  let changed;
  do {
    changed = false;
    for (const row of table) if (candidates.has(row.ppid) && !candidates.has(row.pid)) { candidates.add(row.pid); changed = true; }
  } while (changed);
  const root = known.find((item) => item.pid === rootPid) ?? table.find((item) => item.pid === rootPid);
  for (const row of table) {
    // The root can exit before cleanup while a member of its original group remains live.
    // A shared actor group also contains the parent and supervisor. It is not
    // the adapter's stop scope, even when those processes have our token.
    if (root && root.pid === root.pgid && row.pgid === root.pgid) candidates.add(row.pid);
  }
  const result = [...known];
  for (const row of table.filter((item) => candidates.has(item.pid))) {
    // A missing or unreadable marker removes permission to signal the process.
    // It does not prove that this related process has stopped.
    if (!result.some((item) => item.pid === row.pid && item.started === row.started)) result.push(row);
  }
  return result;
}

export async function stopOwnedTree(rootPid, known, token) {
  let tracked = await observeTree(rootPid, known, token);
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const identity of [...tracked].reverse()) if (await ownsProcess(identity, token)) {
      try { process.kill(identity.pid, signal); } catch (error) { if (error.code !== 'ESRCH') fail('processStopFailed', 'An owned process could not be stopped.'); }
    }
    await new Promise((resolve) => setTimeout(resolve, signal === 'SIGTERM' ? 250 : 100));
    tracked = await observeTree(rootPid, tracked, token);
  }
  const table = await processTable();
  return { stopped: !tracked.some((identity) => table.some((row) => row.pid === identity.pid && row.started === identity.started)), tracked };
}
