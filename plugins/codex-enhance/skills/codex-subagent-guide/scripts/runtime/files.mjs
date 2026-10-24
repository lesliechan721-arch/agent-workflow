import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { LIMITS, fail } from './contracts.mjs';
import { protectPrivatePath } from './platform.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function safePath(target, kind = 'file', { allowExecutableSymlink = false } = {}) {
  if (!path.isAbsolute(target) || target.includes('\0') || path.normalize(target) !== target) fail('pathInvalid', 'A runtime path must be absolute and normalized.');
  let current = path.parse(target).root;
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch { fail('pathMissing', 'A required runtime path is missing or unreadable.'); }
    if (stat.isSymbolicLink()) {
      if (allowExecutableSymlink) return safePath(await fs.realpath(target), kind);
      fail('pathSymlink', 'Symbolic links are not allowed in private runtime resources.');
    }
    if (current !== target && !stat.isDirectory()) fail('pathInvalid', 'A path parent is not a normal directory.');
  }
  const stat = await fs.lstat(target);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) fail('pathInvalid', 'The path has an unsupported node type.');
  return target;
}

export async function readLimited(target, maximumBytes, code = 'inputTooLarge') {
  await safePath(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('pathInvalid', 'The input is not a normal file.');
    if (stat.size > maximumBytes) fail(code, `The input exceeds the ${maximumBytes} byte limit.`);
    const chunks = [];
    let total = 0;
    while (total <= maximumBytes) {
      const buffer = Buffer.alloc(Math.min(65536, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maximumBytes) fail(code, `The input exceeds the ${maximumBytes} byte limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
  } finally { await handle.close(); }
}

export function textFromBytes(bytes) {
  if (bytes.includes(0)) fail('binaryUnsupported', 'The input must be valid UTF-8 text without NUL.');
  try { return decoder.decode(bytes); } catch { fail('binaryUnsupported', 'The input must be valid UTF-8 text without NUL.'); }
}

export async function readStdin(stream = process.stdin, maximumBytes = LIMITS.taskBytes, code = 'taskTooLarge') {
  if (stream.isTTY) fail('stdinInteractive', 'Use --prompt - with redirected noninteractive stdin.');
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumBytes) fail(code, `The input exceeds the ${maximumBytes} byte limit.`);
      chunks.push(bytes);
    }
  } catch (error) {
    if (error?.code === code) throw error;
    fail('stdinUnreadable', 'The redirected prompt could not be read.');
  }
  return textFromBytes(Buffer.concat(chunks, total));
}

export async function readText(target, maximumBytes, code) {
  // These files are explicit caller selections, not workspace-relative bundle members.
  const resolved = await fs.realpath(path.resolve(target)).catch(() => fail('pathMissing', 'The selected instruction file is missing or unreadable.'));
  const text = textFromBytes(await readLimited(resolved, maximumBytes, code));
  if (!text.trim()) fail('inputEmpty', 'The instruction file is empty.');
  return text;
}

export async function executablePaths(command, entrypoint) {
  const resolvedCommand = await safePath(path.normalize(command), 'file', { allowExecutableSymlink: true });
  try { await fs.access(resolvedCommand, constants.X_OK); } catch { fail('executableNotRunnable', 'The registered command is not executable.'); }
  if (entrypoint !== undefined) await safePath(path.normalize(entrypoint));
  return { command: resolvedCommand, ...(entrypoint === undefined ? {} : { entrypoint: path.normalize(entrypoint) }) };
}

export async function atomicJson(target, value) {
  const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await protectPrivatePath(temporary, 'file');
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function readJson(target, maximumBytes = LIMITS.resultBytes) {
  const bytes = await readLimited(target, maximumBytes);
  try { return JSON.parse(textFromBytes(bytes)); } catch (error) {
    if (error?.code) throw error;
    fail('jsonInvalid', 'A runtime JSON resource is invalid.', ['sync', 'reinstall']);
  }
}
