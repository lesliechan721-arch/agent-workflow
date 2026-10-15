import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { releaseRoot } from './common.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';

const importedBindings = new WeakMap();
const SHA256 = /^sha256:[0-9a-f]{64}$/u;

function assertSavedEvidence(descriptor) {
  if (!descriptor.axes.cli || descriptor.axes.catalog
    || !/^[0-9a-f]{40,64}$/u.test(descriptor.source.head)
    || !SHA256.test(descriptor.source.targetsDigest ?? '')
    || typeof descriptor.build.generationId !== 'string' || descriptor.build.generationId === '') {
    throw new Error('Portable prepared release must contain a complete CLI source and build binding.');
  }
  for (const field of ['inputDigest', 'outputDigest', 'cliPackageDigest']) {
    if (!SHA256.test(descriptor.build[field] ?? '')) {
      throw new Error(`Portable prepared release is missing its saved build ${field}.`);
    }
  }
  const paths = new Set();
  for (const artifact of descriptor.npm.packages) {
    if (typeof artifact.path !== 'string'
      || !/^artifacts\/[A-Za-z0-9@._-]+\.tgz$/u.test(artifact.path)
      || paths.has(artifact.path)
      || !SHA256.test(artifact.contentDigest ?? '')
      || !SHA256.test(descriptor.npm.treeDigests?.[artifact.name] ?? '')) {
      throw new Error('Portable prepared release contains an invalid or duplicate package binding.');
    }
    paths.add(artifact.path);
  }
}

export function assertPortablePreparedBinding(root, descriptor, options = {}) {
  const binding = importedBindings.get(options.portableBinding);
  if (!binding || binding.root !== path.resolve(root)
    || !SHA256.test(options.expectedDescriptorDigest ?? '')
    || binding.descriptorDigest !== options.expectedDescriptorDigest
    || calculateCanonicalDigest(descriptor) !== binding.descriptorDigest) {
    throw new Error('Portable publication requires the verified imported prepared release binding.');
  }
  assertSavedEvidence(descriptor);
}

async function regularPath(filePath, kind) {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile())) {
    throw new Error('Prepared transfer paths must be regular local paths.');
  }
  return stats;
}

async function readTransferAttempt(filePath, descriptor, required) {
  let bytes;
  try {
    await regularPath(filePath, 'file');
    bytes = await fs.readFile(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return null;
    throw new Error('The prepared transfer is missing its valid CLI attempt; publish a new version.', { cause: error });
  }
  let attempt;
  try {
    attempt = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('The prepared transfer CLI attempt is invalid.', { cause: error });
  }
  const { assertPreparedCliAttempt } = await import('./prepared-release.mjs');
  await assertPreparedCliAttempt(descriptor, { readAttempt: async () => attempt });
  if (attempt.publicationStarted !== undefined && typeof attempt.publicationStarted !== 'boolean') {
    throw new Error('The prepared transfer CLI attempt state is invalid.');
  }
  return { attempt, bytes };
}

async function readCandidate(root, options) {
  const { readPreparedDescriptor, assertPreparedCliArtifacts } = await import('./prepared-release.mjs');
  const candidate = await readPreparedDescriptor({ preparedRoot: root });
  assertSavedEvidence(candidate.descriptor);
  await assertPreparedCliArtifacts(candidate.root, candidate.descriptor, options);
  return candidate;
}

async function copyPrepared(root, descriptor, destination) {
  await fs.mkdir(path.join(destination, 'artifacts'), { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(root, 'descriptor.json'), path.join(destination, 'descriptor.json'));
  for (const artifact of descriptor.npm.packages) {
    const source = path.join(root, artifact.path);
    const target = path.join(destination, artifact.path);
    await fs.copyFile(source, target);
    await fs.chmod(target, (await fs.stat(source)).mode & 0o777);
  }
}

async function absent(filePath) {
  try {
    await fs.lstat(filePath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

/** Export only the descriptor, its five bound tarballs, and the unchanged attempt. */
export async function exportPreparedRelease(options = {}) {
  if (typeof options.destination !== 'string' || options.destination === '') {
    throw new Error('Prepared export requires a destination directory.');
  }
  const localReleaseRoot = options.releaseRoot ?? releaseRoot;
  const root = options.preparedRoot ?? path.join(localReleaseRoot, 'prepared');
  const { descriptor } = await readCandidate(root, options);
  const savedAttempt = await readTransferAttempt(
    options.attemptPath ?? path.join(localReleaseRoot, 'attempted.json'),
    descriptor,
    options.requireAttempt ?? false,
  );
  const destination = path.resolve(options.destination);
  if (!await absent(destination)) throw new Error('Prepared export destination already exists.');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = await fs.mkdtemp(`${destination}.`);
  try {
    await copyPrepared(root, descriptor, path.join(temporary, 'prepared'));
    if (savedAttempt) await fs.writeFile(path.join(temporary, 'attempted.json'), savedAttempt.bytes, { mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  return { destination, descriptor, descriptorDigest: calculateCanonicalDigest(descriptor), attempt: savedAttempt?.attempt ?? null };
}

/** Import a candidate selected by the caller's already verified recovery artifact. */
export async function importPreparedRelease(options = {}) {
  if (typeof options.from !== 'string' || options.from === ''
    || !/^[0-9a-f]{40,64}$/u.test(options.expectedSourceHead ?? '')
    || typeof options.expectedVersion !== 'string'
    || !SHA256.test(options.expectedDescriptorDigest ?? '')) {
    throw new Error('Prepared import requires the expected source, version, and descriptor digest.');
  }
  const from = path.resolve(options.from);
  await regularPath(from, 'directory');
  const { root: sourceRoot, descriptor } = await readCandidate(path.join(from, 'prepared'), options);
  const descriptorDigest = calculateCanonicalDigest(descriptor);
  if (descriptor.source.head !== options.expectedSourceHead
    || descriptor.candidates.cli !== options.expectedVersion
    || descriptorDigest !== options.expectedDescriptorDigest) {
    throw new Error('Prepared transfer source, version, or descriptor digest does not match the selected candidate.');
  }
  const savedAttempt = await readTransferAttempt(path.join(from, 'attempted.json'), descriptor, options.requireAttempt ?? true);
  const localReleaseRoot = options.releaseRoot ?? releaseRoot;
  const root = path.resolve(options.preparedRoot ?? path.join(localReleaseRoot, 'prepared'));
  const attemptPath = options.attemptPath ?? path.join(localReleaseRoot, 'attempted.json');
  if (!await absent(attemptPath)) {
    const existing = await readTransferAttempt(attemptPath, descriptor, true);
    if (!savedAttempt || !existing.bytes.equals(savedAttempt.bytes)) {
      throw new Error('Prepared import would overwrite a different CLI attempt.');
    }
  }
  if (await absent(root)) {
    await fs.mkdir(path.dirname(root), { recursive: true });
    const temporary = await fs.mkdtemp(`${root}.`);
    try {
      await copyPrepared(sourceRoot, descriptor, temporary);
      await readCandidate(temporary, options);
      await fs.rename(temporary, root);
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  } else {
    const existing = await readCandidate(root, options);
    if (calculateCanonicalDigest(existing.descriptor) !== descriptorDigest) {
      throw new Error('Prepared import would overwrite a different prepared release.');
    }
  }
  if (savedAttempt && await absent(attemptPath)) {
    await fs.mkdir(path.dirname(attemptPath), { recursive: true });
    const temporary = `${attemptPath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, savedAttempt.bytes, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, attemptPath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  const portableBinding = Object.freeze({ root, descriptorDigest });
  importedBindings.set(portableBinding, { root, descriptorDigest });
  return { root, descriptor, descriptorDigest, attempt: savedAttempt?.attempt ?? null, portableBinding };
}
