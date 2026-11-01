import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { LIMITS, fail } from './contracts.mjs';
import { protectPrivatePaths } from './platform.mjs';

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

export async function readInputFile(target, maximumBytes, tooLargeCode, callerCwd = process.cwd()) {
  if (typeof target !== 'string' || !target || target === '-' || target.includes('\0') || !target.isWellFormed()) fail('inputFileInvalid', 'Use a normal input file path.');
  const resolved = path.resolve(callerCwd, target);
  let handle;
  try {
    const entry = await fs.lstat(resolved);
    if (!entry.isFile() || entry.isSymbolicLink()) fail('inputFileInvalid', 'The selected input must be a normal file, without a final symbolic link.');
    handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) fail('inputFileInvalid', 'The selected input must be a normal file.');
    if (stat.size > maximumBytes) fail(tooLargeCode, `The input exceeds the ${maximumBytes} byte limit.`);
    const chunks = []; let total = 0;
    for (;;) {
      const buffer = Buffer.alloc(Math.min(65536, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) fail(tooLargeCode, `The input exceeds the ${maximumBytes} byte limit.`);
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    let text;
    try { text = decoder.decode(bytes); } catch { fail('inputFileInvalid', 'The input file must contain valid UTF-8 text.'); }
    if (text.includes('\0') || !text.trim()) fail('inputFileInvalid', 'The input file must contain nonblank text without NUL.');
    return text;
  } catch (error) {
    if (['inputFileInvalid', tooLargeCode].includes(error.code)) throw error;
    fail('inputFileReadFailed', 'The selected input file could not be read. Check its path and access permissions.');
  } finally {
    if (handle) await handle.close().catch(() => fail('inputFileReadFailed', 'The selected input file could not be closed.'));
  }
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
  await atomicJsonFiles([{ target, value }]);
}

async function publishJson(temporary, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temporary, target); return; }
    catch (error) {
      // Windows readers can briefly deny replacement. Retry the same protected
      // file, never unlink the old state or repeat a backend operation.
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

export function fileFailureDiagnostic(error, directory) {
  if (!['open', 'read', 'write', 'close', 'rename', 'unlink', 'lstat', 'stat', 'scandir', 'mkdir', 'rmdir'].includes(error?.syscall)) return undefined;
  const resource = (target) => {
    if (typeof target !== 'string' || !path.isAbsolute(target)) return 'unavailable';
    const relative = path.relative(directory, target).split(path.sep).join('/');
    const temporary = /\.[a-f0-9]{16}\.tmp$/.test(relative);
    const published = temporary ? relative.slice(0, -21) : relative;
    const suffix = temporary ? '.tmp' : '';
    if (/^(owner|snapshot|observed|launch|stop|final)\.json$/.test(published)) return published + suffix;
    if (/^(outbox|events|gaps)\/[a-z0-9-]+\.json$/.test(published)) return published.split('/')[0] + '/record' + suffix;
    return 'other';
  };
  // Do not retain raw messages, stacks, filenames, or absolute paths. The fixed
  // categories are enough to identify the failed shared runtime resource.
  return JSON.stringify({ operation: 'workerFile', syscall: error.syscall,
    source: resource(error.path), destination: resource(error.dest) });
}

export async function atomicJsonFiles(entries) {
  const created = [];
  try {
    for (const { target, value } of entries) {
      const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      const handle = await fs.open(temporary, 'wx', 0o600);
      created.push({ target, temporary });
      try { await handle.writeFile(`${JSON.stringify(value)}\n`); }
      finally { await handle.close(); }
    }
    await protectPrivatePaths(created.map(({ temporary }) => ({ target: temporary, kind: 'file' })));
    // Publication remains atomic per file. A later rename failure does not
    // roll back files that were already published successfully.
    for (const { target, temporary } of created) await publishJson(temporary, target);
  } finally {
    await Promise.all(created.map(({ temporary }) => fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; })));
  }
}

export async function readJson(target, maximumBytes = LIMITS.resultBytes) {
  const bytes = await readLimited(target, maximumBytes);
  try { return JSON.parse(textFromBytes(bytes)); } catch (error) {
    if (error?.code) throw error;
    fail('jsonInvalid', 'A runtime JSON resource is invalid.', ['sync', 'reinstall']);
  }
}
