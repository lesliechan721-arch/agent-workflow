import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { calculateCanonicalDigest } from './release-model.mjs';

export function bytesDigest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function safePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\')
    || /[\u0000-\u001f\u007f:]/u.test(value) || value.startsWith('/')
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Candidate archive contains an unsafe path.');
  }
  return value;
}

function allowedPath(product, relative) {
  if (relative === 'candidate.json') return true;
  if (product === 'cli') {
    return relative === 'cli/prepared/descriptor.json' || relative === 'cli/attempted.json'
      || /^cli\/prepared\/artifacts\/[^/]+\.tgz$/u.test(relative);
  }
  return relative === 'catalog/publication/journal.json'
    || relative.startsWith('catalog/publication/repository/')
    || /^tools\/[^/]+\.tgz$/u.test(relative);
}

async function records(root, relative = '') {
  const result = [];
  const entries = (await fs.readdir(path.join(root, relative))).sort();
  for (const name of entries) {
    const child = safePath(relative ? `${relative}/${name}` : name);
    const absolute = path.join(root, child);
    const stats = await fs.lstat(absolute);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      result.push(...await records(root, child));
    } else if (stats.isFile() && !stats.isSymbolicLink()) {
      result.push({ path: child, digest: bytesDigest(await fs.readFile(absolute)), mode: stats.mode & 0o111 ? 0o755 : 0o644 });
    } else {
      throw new Error('Candidate archives accept only regular files and directories.');
    }
  }
  return result;
}

function assertManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !['cli', 'catalog'].includes(manifest.product)
    || !Array.isArray(manifest.files) || manifest.files.length === 0
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(manifest.candidateHead ?? '')
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(manifest.sourceHead ?? '')) {
    throw new Error('Candidate manifest is invalid.');
  }
  const paths = new Set();
  for (const record of manifest.files) {
    safePath(record.path);
    if (!allowedPath(manifest.product, record.path) || record.path === 'candidate.json'
      || paths.has(record.path) || !/^sha256:[0-9a-f]{64}$/u.test(record.digest ?? '')
      || ![0o644, 0o755].includes(record.mode)) {
      throw new Error('Candidate file inventory is invalid.');
    }
    paths.add(record.path);
  }
  if (manifest.product === 'cli') {
    if (!paths.has('cli/prepared/descriptor.json') || !paths.has('cli/attempted.json')
      || manifest.files.filter((entry) => entry.path.endsWith('.tgz')).length !== 5) {
      throw new Error('CLI recovery requires the descriptor, attempt, and all five packages.');
    }
  } else if (!paths.has('catalog/publication/journal.json')
    || manifest.files.filter((entry) => entry.path.startsWith('tools/')).length !== 5) {
    throw new Error('Catalog recovery requires its journal and five smoke tool packages.');
  }
}

export async function sealCandidateDirectory(root, metadata) {
  const files = (await records(root)).filter((entry) => entry.path !== 'candidate.json');
  const manifest = { ...metadata, schemaVersion: 1, files };
  assertManifest(manifest);
  await fs.writeFile(path.join(root, 'candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyCandidateDirectory(root, expected = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'candidate.json'), 'utf8'));
  assertManifest(manifest);
  for (const [field, value] of Object.entries(expected)) {
    if (value !== undefined && manifest[field] !== value) throw new Error(`Candidate ${field} does not match the selected release.`);
  }
  const actual = (await records(root)).filter((entry) => entry.path !== 'candidate.json');
  const expectedFiles = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path, 'en'));
  actual.sort((left, right) => left.path.localeCompare(right.path, 'en'));
  const comparable = (list) => list.map(({ path: filePath, digest, mode }) => ({
    path: filePath, digest, ...(process.platform === 'win32' ? {} : { mode }),
  }));
  if (calculateCanonicalDigest(comparable(actual)) !== calculateCanonicalDigest(comparable(expectedFiles))) {
    throw new Error('Candidate files changed or recovery files are missing. Use a new version.');
  }
  return manifest;
}

function tarHeader(relative, size, mode) {
  const header = Buffer.alloc(512);
  let name = relative;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const candidates = [...relative.matchAll(/\//gu)].map((match) => match.index).reverse();
    const split = candidates.find((index) => Buffer.byteLength(relative.slice(0, index)) <= 155
      && Buffer.byteLength(relative.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error(`Candidate path is too long for a portable tar: ${relative}`);
    prefix = relative.slice(0, split);
    name = relative.slice(split + 1);
  }
  header.write(name, 0, 100, 'utf8');
  const octal = (value, offset, length) => {
    const encoded = value.toString(8).padStart(length - 1, '0');
    if (encoded.length >= length) throw new Error('Candidate archive exceeds the portable tar limit.');
    header.write(`${encoded}\0`, offset, length, 'ascii');
  };
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

export async function archiveCandidate(root, destination) {
  const manifest = await verifyCandidateDirectory(root);
  const chunks = [];
  for (const record of [{ path: 'candidate.json', mode: 0o644 }, ...manifest.files]) {
    const bytes = await fs.readFile(path.join(root, record.path));
    chunks.push(tarHeader(record.path, bytes.length, record.mode), bytes);
    if (bytes.length % 512) chunks.push(Buffer.alloc(512 - bytes.length % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const archive = Buffer.concat(chunks);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, archive, { mode: 0o600 });
  return bytesDigest(archive);
}

// Only this module's regular-file ustar format is accepted. Links, devices, and
// extended headers cannot change the path checked before each write.
export async function extractCandidate(archivePath, destination, expectedDigest) {
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedDigest ?? '')) throw new Error('An exact candidate archive digest is required.');
  const archive = await fs.readFile(archivePath);
  if (bytesDigest(archive) !== expectedDigest) throw new Error('Candidate archive digest does not match.');
  const entries = [];
  const seen = new Set();
  const stringAt = (header, start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
  let offset = 0;
  for (; offset + 512 <= archive.length; ) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const checksum = Number.parseInt(stringAt(header, 148, 8).trim(), 8);
    const computed = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== computed || header[156] !== 48 || stringAt(header, 257, 6) !== 'ustar') {
      throw new Error('Candidate archive contains an unsupported or damaged tar entry.');
    }
    const prefix = stringAt(header, 345, 155);
    const relative = safePath(`${prefix ? `${prefix}/` : ''}${stringAt(header, 0, 100)}`);
    const size = Number.parseInt(stringAt(header, 124, 12), 8);
    const mode = Number.parseInt(stringAt(header, 100, 8), 8);
    if (!Number.isSafeInteger(size) || size < 0 || ![0o644, 0o755].includes(mode)
      || seen.has(relative) || offset + 512 + size > archive.length) throw new Error('Candidate tar entry is invalid.');
    seen.add(relative);
    entries.push({ path: relative, bytes: archive.subarray(offset + 512, offset + 512 + size), mode });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (archive.length - offset < 1024 || !archive.subarray(offset).every((byte) => byte === 0)) throw new Error('Candidate archive is incomplete.');
  const metadata = entries.find((entry) => entry.path === 'candidate.json');
  if (!metadata) throw new Error('Candidate archive has no manifest.');
  const manifest = JSON.parse(metadata.bytes.toString('utf8'));
  assertManifest(manifest);
  const declared = new Map(manifest.files.map((entry) => [entry.path, entry]));
  if (entries.length !== declared.size + 1) throw new Error('Candidate archive file inventory does not match.');
  for (const entry of entries) {
    if (!allowedPath(manifest.product, entry.path)) throw new Error('Candidate archive file is outside its product boundary.');
    if (entry.path === 'candidate.json') continue;
    const record = declared.get(entry.path);
    if (!record || record.digest !== bytesDigest(entry.bytes) || record.mode !== entry.mode) throw new Error('Candidate archive file digest or mode changed.');
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(destination), '.candidate-'));
  try {
    for (const entry of entries) {
      const target = path.join(temporary, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.bytes, { flag: 'wx', mode: entry.mode });
    }
    await verifyCandidateDirectory(temporary);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}
