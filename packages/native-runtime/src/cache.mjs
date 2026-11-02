import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { NativeToolError, validateNativeBinary } from './descriptor.mjs';

const executableName = 'native.exe';
const markerName = '.aw-native-artifact.json';
const missing = (error) => error?.code === 'ENOENT';
function reject(code = 'nativeCacheUnsafe') { throw new NativeToolError(code); }

async function stat(file) {
  try { return await lstat(file); } catch (error) { if (missing(error)) return undefined; throw error; }
}

async function rejectWindowsReparsePoints(paths) {
  if (process.platform !== 'win32' || paths.length === 0) return;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) reject();
  const input = JSON.stringify(paths);
  if (Buffer.byteLength(input) > 64 * 1024) reject();
  const script = '$ErrorActionPreference="Stop";$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;foreach($v in $p){if(([IO.File]::GetAttributes($v)-band[IO.FileAttributes]::ReparsePoint)-ne 0){exit 2}}';
  await new Promise((resolve, rejectPromise) => {
    const child = execFile(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4096 }, (error) => error ? rejectPromise(new NativeToolError('nativeCacheUnsafe')) : resolve());
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** No downloaded helper, shell command interpolation, or package code is used here. */
export async function checkNativePath(target, leaf = 'directory', allowMissing = false) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  const checked = [current];
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const found = await stat(current);
    if (!found) {
      if (allowMissing) break;
      reject('nativeCacheMiss');
    }
    const expectedFile = i === parts.length - 1 && leaf === 'file';
    if (found.isSymbolicLink() || !(expectedFile ? found.isFile() : found.isDirectory())) reject();
    checked.push(current);
  }
  await rejectWindowsReparsePoints(checked);
  return absolute;
}

async function ensureDirectory(directory) {
  await checkNativePath(directory, 'directory', true);
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const found = await lstat(current);
    if (found.isSymbolicLink() || !found.isDirectory()) reject();
  }
  await checkNativePath(absolute);
  return absolute;
}

export async function readNativeFile(file, maximum) {
  await checkNativePath(file, 'file');
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) reject();
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) reject();
    if (opened.nlink === 0 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) reject('nativeFileChanged');
    // Read at most the budget even if another process grows the ordinary file.
    const bytes = Buffer.alloc(Math.min(opened.size + 1, maximum + 1));
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, total);
      if (!result.bytesRead) break;
      total += result.bytesRead;
    }
    if (total > maximum || total !== opened.size) reject('nativeFileChanged');
    const after = await lstat(file);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1) reject();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) reject('nativeFileChanged');
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

export function nativeCandidatePath(cacheRoot, variant) {
  return path.join(path.resolve(cacheRoot), variant.platform, variant.arch, variant.file.sha256.slice(7));
}

function marker(variant) {
  return { schemaVersion: 1, kind: 'aw-native-artifact', sha256: variant.file.sha256 };
}

async function ownedCandidate(candidate, variant) {
  await checkNativePath(candidate);
  const names = await readdir(candidate);
  if (!names.includes(markerName) || names.some((name) => ![markerName, executableName].includes(name))) reject('nativeCacheForeign');
  let value;
  try { value = JSON.parse((await readNativeFile(path.join(candidate, markerName), 512)).toString('utf8')); }
  catch (error) { if (error instanceof NativeToolError && error.code !== 'nativeCacheMiss') throw error; reject('nativeCacheForeign'); }
  if (!value || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['kind', 'schemaVersion', 'sha256'])
    || value.schemaVersion !== 1 || value.kind !== 'aw-native-artifact' || value.sha256 !== variant.file.sha256) reject('nativeCacheForeign');
  const binary = await stat(path.join(candidate, executableName));
  if (binary && (!binary.isFile() || binary.isSymbolicLink() || binary.nlink !== 1)) reject();
}

export async function readNativeCandidate(cacheRoot, descriptor, variant) {
  // A concurrent repair replaces only the executable. Revalidate its new inode,
  // while foreign ownership and unsafe nodes remain immediate failures.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { return await inspectNativeCandidate(cacheRoot, descriptor, variant); }
    catch (error) {
      if (!(error instanceof NativeToolError) || error.code !== 'nativeFileChanged' || attempt === 7) throw error;
    }
  }
}

async function inspectNativeCandidate(cacheRoot, descriptor, variant) {
  const candidate = nativeCandidatePath(cacheRoot, variant);
  await checkNativePath(candidate, 'directory', true);
  if (!await stat(candidate)) return { state: 'missing' };
  await ownedCandidate(candidate, variant);
  const binaryStat = await stat(path.join(candidate, executableName));
  if (!binaryStat || binaryStat.size !== variant.file.size) return { state: 'corrupt' };
  try {
    const bytes = await readNativeFile(path.join(candidate, executableName), variant.file.size);
    validateNativeBinary(bytes, variant);
    return { state: 'ready', protocol: descriptor.tool.protocol, executable: path.join(candidate, executableName), sha256: variant.file.sha256 };
  } catch (error) {
    if (error instanceof NativeToolError && ['nativeCacheMiss', 'nativeBinarySizeMismatch', 'nativeBinaryDigestMismatch', 'nativeBinaryFormatInvalid', 'nativeBinaryMachineMismatch'].includes(error.code)) return { state: 'corrupt' };
    throw error;
  }
}

export async function publishNativeCandidate(cacheRoot, descriptor, variant, bytes) {
  validateNativeBinary(bytes, variant);
  const parent = await ensureDirectory(path.dirname(nativeCandidatePath(cacheRoot, variant)));
  const staging = path.join(parent, `.staging-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  const candidate = nativeCandidatePath(cacheRoot, variant);
  try {
    for (const [name, content] of [[markerName, Buffer.from(JSON.stringify(marker(variant)))], [executableName, bytes]]) {
      const handle = await open(path.join(staging, name), 'wx', name === executableName ? 0o700 : 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
    const existing = await readNativeCandidate(cacheRoot, descriptor, variant);
    if (existing.state === 'ready') return existing;
    if (existing.state === 'corrupt') {
      // Keep the validated marker and directory intact. Concurrent repairers
      // atomically replace the same owned regular file with identical locked bytes.
      await ownedCandidate(candidate, variant);
      await checkNativePath(path.join(candidate, executableName), 'file', true);
      await rename(path.join(staging, executableName), path.join(candidate, executableName));
      const repaired = await readNativeCandidate(cacheRoot, descriptor, variant);
      if (repaired.state === 'ready') return repaired;
      reject('nativeCachePublicationFailed');
    }
    await checkNativePath(parent);
    // Valid candidates are nonempty directories: rename cannot replace a concurrent winner.
    // Existing foreign directories are rejected by readNativeCandidate before publication.
    try { await rename(staging, candidate); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      const winner = await readNativeCandidate(cacheRoot, descriptor, variant);
      if (winner.state === 'ready') return winner;
      reject('nativeCachePublicationFailed');
    }
    const result = await readNativeCandidate(cacheRoot, descriptor, variant);
    if (result.state !== 'ready') reject('nativeCachePublicationFailed');
    return result;
  } finally {
    // Staging is exclusive to this call; remove only the two files that this call wrote.
    for (const name of [executableName, markerName]) {
      try { await unlink(path.join(staging, name)); } catch (error) { if (!missing(error)) throw error; }
    }
    try { await rmdir(staging); } catch (error) { if (!missing(error)) throw error; }
  }
}
