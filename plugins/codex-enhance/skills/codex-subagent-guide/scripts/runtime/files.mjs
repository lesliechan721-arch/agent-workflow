import fs from 'node:fs/promises';
import path from 'node:path';
import { constants, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { LIMITS, digest, fail } from './contracts.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true });
const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', '.aw']);

export async function safePath(target, kind = 'file', { allowExecutableSymlink = false } = {}) {
  if (!path.isAbsolute(target) || target.includes('\0') || path.normalize(target) !== target) fail('pathInvalid', 'A runtime path must be absolute and normalized.');
  let current = path.parse(target).root;
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try { stat = await fs.lstat(current); } catch { fail('pathMissing', 'A required runtime path is missing or unreadable.'); }
    if (stat.isSymbolicLink()) {
      if (allowExecutableSymlink) return safePath(await fs.realpath(target), kind);
      fail('pathSymlink', 'Symbolic links are not allowed in runtime materials or resources.');
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
    const bytes = await handle.readFile();
    if (bytes.byteLength > maximumBytes) fail(code, `The input exceeds the ${maximumBytes} byte limit.`);
    return bytes;
  } finally { await handle.close(); }
}

export function textFromBytes(bytes) {
  if (bytes.includes(0)) fail('binaryUnsupported', 'This adapter supports UTF-8 text materials only.');
  try { return decoder.decode(bytes); } catch { fail('binaryUnsupported', 'This adapter supports UTF-8 text materials only.'); }
}

export function materialSource(source) {
  if (typeof source !== 'string' || !source || path.isAbsolute(source) || /[\u0000-\u001f\u007f\\]/u.test(source)) fail('materialPathInvalid', 'Material paths must be clean workspace-relative paths.');
  const segments = source.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) fail('materialPathInvalid', 'Material paths cannot traverse directories.');
  if (segments.some((part) => excludedDirectories.has(part))) fail('materialExcluded', 'The material is in a default excluded dependency or generated directory.');
  const name = segments.at(-1);
  if (/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(name) || /\.(?:pem|p12|pfx|key|keystore)$/i.test(name) || segments.includes('.ssh') || segments.includes('.aws') || segments.includes('.codex')) fail('materialSecretExcluded', 'The material is a default excluded credential or secret file.');
  return source;
}

export async function inspectMaterials(workspace, sources = []) {
  await safePath(workspace, 'directory');
  if (sources.length > LIMITS.files) fail('materialCountExceeded', `The selection exceeds the ${LIMITS.files} file limit.`);
  if (new Set(sources).size !== sources.length) fail('materialDuplicate', 'The same material path was selected more than once.');
  let totalBytes = 0;
  const materials = [];
  for (const source of sources) {
    materialSource(source);
    const originalPath = path.join(workspace, ...source.split('/'));
    const bytes = await readLimited(originalPath, LIMITS.fileBytes, 'materialFileTooLarge');
    totalBytes += bytes.length;
    if (totalBytes > LIMITS.materialBytes) fail('materialTotalTooLarge', `The materials exceed the ${LIMITS.materialBytes} byte total limit.`);
    const text = textFromBytes(bytes);
    if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\bAKIA[A-Z0-9]{16}\b/.test(text)) fail('materialSecretDetected', 'The selected material contains a recognized credential. Remove that material or prepare a safe copy.');
    const lineCount = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
    materials.push({ source, originalPath, sha256: digest(bytes), startLine: 1, endLine: lineCount, bytes });
  }
  return { materials, totalBytes };
}

export async function loadInstructions(plan) {
  const relative = plan.worker.instructionsFile;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) fail('instructionPathInvalid', 'The instruction binding is not a safe resource path.', ['sync', 'reinstall']);
  const bytes = await readLimited(path.join(plan.resourceRoot, relative), LIMITS.instructionBytes, 'instructionsTooLarge');
  if (digest(bytes) !== plan.worker.instructionRevision) fail('instructionRevisionMismatch', 'The installed worker text does not match its binding.', ['sync', 'reinstall']);
  const text = textFromBytes(bytes);
  if (!text.trim()) fail('instructionsEmpty', 'The installed worker instructions are empty.', ['sync', 'reinstall']);
  return text;
}

export async function executableIdentity(command, entrypoint) {
  const resolvedCommand = await safePath(command, 'file', { allowExecutableSymlink: true });
  try { await fs.access(resolvedCommand, constants.X_OK); } catch { fail('executableNotRunnable', 'The registered command is not executable.'); }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolvedCommand)) hash.update(chunk);
  const executable = { path: resolvedCommand, sha256: hash.digest('hex') };
  if (entrypoint !== undefined) {
    await safePath(entrypoint);
    executable.entrypoint = { path: entrypoint, sha256: digest(await readLimited(entrypoint, LIMITS.fileBytes)) };
  }
  return executable;
}

export async function atomicJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, target);
}

export async function readJson(target, maximumBytes = LIMITS.fileBytes) {
  const bytes = await readLimited(target, maximumBytes);
  try { return JSON.parse(textFromBytes(bytes)); } catch (error) {
    if (error?.code) throw error;
    fail('jsonInvalid', 'A runtime JSON resource is invalid.', ['sync', 'reinstall']);
  }
}
