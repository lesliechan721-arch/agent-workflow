import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { verifyWindowsJobArtifacts, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

export const WINDOWS_JOB_PROTOCOL = 'aw.windows-job.v1';
export const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const packageName = (arch) => `@lesliechan721/aw-windows-job-win32-${arch}`;

async function readRegularFile(target) {
  const stats = await lstat(target);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Native candidate files must be regular files.');
  return readFile(target);
}

// Candidate archives have exactly the two files produced by pack.mjs. This is
// build and qualification tooling; installed consumers use npm dependency resolution.
export function readCandidatePackage(archive, { arch, version }) {
  const tar = gunzipSync(archive, { maxOutputLength: 32 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim();
    const size = /^[0-7]+$/u.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN;
    if (!['package/package.json', 'package/dist/aw-windows-job.exe'].includes(name)
      || header[156] !== 0x30 || files.has(name) || !Number.isSafeInteger(size)
      || size < 0 || offset + 512 + size > tar.length) throw new Error('Windows Job candidate archive inventory is invalid.');
    files.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (files.size !== 2) throw new Error('Windows Job candidate archive must contain its package metadata and helper.');
  const metadata = JSON.parse(files.get('package/package.json'));
  if (metadata.name !== packageName(arch) || metadata.version !== version
    || JSON.stringify(metadata.os) !== '["win32"]' || JSON.stringify(metadata.cpu) !== JSON.stringify([arch])
    || metadata.exports?.['./aw-windows-job.exe'] !== './dist/aw-windows-job.exe') throw new Error('Windows Job platform metadata does not match the CLI candidate.');
  return { metadata, packageJson: files.get('package/package.json'), executable: files.get('package/dist/aw-windows-job.exe') };
}

export async function readCandidate(root = windowsJobArtifactContract.defaultNativeRoot, options = {}) {
  const manifest = await verifyWindowsJobArtifacts({ ...options, nativeRoot: root });
  const candidateBytes = await readRegularFile(path.join(root, 'candidate.json'));
  const candidate = JSON.parse(candidateBytes);
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'windows-job-candidate'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(candidate.version ?? '')
    || (options.version !== undefined && candidate.version !== options.version)
    || candidate.sourceDigest !== manifest.sourceDigest || candidate.goVersion !== manifest.build.goVersion
    || candidate.packages?.length !== 2) throw new Error('Native candidate no longer matches the current CLI version or tool source; generate a new candidate.');
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const entry = candidate.packages[index];
    if (entry?.arch !== arch || entry.name !== packageName(arch)
      || typeof entry.path !== 'string' || path.basename(entry.path) !== entry.path || !entry.path.endsWith('.tgz')) throw new Error('Native candidate archive inventory is invalid.');
    const archive = await readRegularFile(path.join(root, entry.path));
    if (bytesDigest(archive) !== entry.contentDigest) throw new Error('Native candidate archive changed; generate a new candidate.');
    const unpacked = readCandidatePackage(archive, { arch, version: candidate.version });
    if (bytesDigest(unpacked.executable) !== manifest.binaries[arch].sha256) throw new Error('Native candidate archive helper does not match this build.');
  }
  return { root, candidate, candidateDigest: bytesDigest(candidateBytes), manifest };
}

// Actions has already checked the exact archive digest before unpacking. Check
// the saved inventory, descriptor and artifacts again before preparing source
// tests; recovery does not contain a native build manifest or bare binaries.
export async function readPreparedWindowsJobCandidate(bundleRoot, options = {}) {
  const [{ verifyCandidateDirectory }, { readPreparedDescriptor, assertPreparedCliArtifacts },
    { calculateCanonicalDigest }, { resolveReleaseHead }, { assertWindowsJobCandidateEvidence }] = await Promise.all([
    import('../../scripts/release/candidate-archive.mjs'),
    import('../../scripts/release/prepared-release.mjs'),
    import('../../scripts/release/release-model.mjs'),
    import('../../scripts/release/common.mjs'),
    import('./evidence.mjs'),
  ]);
  const repoRoot = options.repoRoot ?? path.resolve(windowsJobArtifactContract.toolRoot, '../..');
  const head = await resolveReleaseHead({ cwd: repoRoot });
  const saved = await verifyCandidateDirectory(bundleRoot, { product: 'cli', candidateHead: head });
  const { root: preparedRoot, descriptor } = await readPreparedDescriptor({ preparedRoot: path.join(bundleRoot, 'cli/prepared') });
  if (!descriptor.axes.cli || descriptor.axes.catalog || descriptor.source.head !== saved.candidateHead
    || descriptor.candidates.cli !== saved.version || descriptor.channel !== saved.channel
    || calculateCanonicalDigest(descriptor) !== saved.descriptorDigest) throw new Error('Prepared native tests must use the descriptor from this exact CLI source candidate.');
  await assertPreparedCliArtifacts(preparedRoot, descriptor);
  if (descriptor.npm.nativeEvidence.some((artifact) => artifact.path !== `artifacts/${artifact.name}`)) throw new Error('Prepared native evidence must use its saved artifact paths.');
  const root = path.join(preparedRoot, 'artifacts');
  const candidateBytes = await readRegularFile(path.join(root, 'candidate.json'));
  const candidate = JSON.parse(candidateBytes);
  if (candidate?.schemaVersion !== 1 || candidate.kind !== 'windows-job-candidate'
    || candidate.version !== saved.version || !/^sha256:[0-9a-f]{64}$/u.test(candidate.sourceDigest ?? '')
    || !/^go\d+\.\d+(?:\.\d+)?(?:[a-z0-9.-]+)?$/u.test(candidate.goVersion ?? '')
    || !Array.isArray(candidate.packages) || candidate.packages.length !== 2) throw new Error('Saved native candidate metadata is invalid.');
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const entry = candidate.packages[index];
    const artifact = descriptor.npm.packages.find((item) => item.name === packageName(arch));
    if (entry?.arch !== arch || entry.name !== packageName(arch)
      || typeof entry.path !== 'string' || path.basename(entry.path) !== entry.path
      || artifact?.path !== `artifacts/${entry.path}` || artifact.contentDigest !== entry.contentDigest) throw new Error('Saved native packages do not match the prepared CLI artifacts.');
    readCandidatePackage(await readRegularFile(path.join(root, entry.path)), { arch, version: candidate.version });
  }
  const selected = { root, candidate, candidateDigest: bytesDigest(candidateBytes) };
  await assertWindowsJobCandidateEvidence(selected);
  return selected;
}

// Explicit qualification and test setup may inject this helper. It is never a
// production fallback and does not consult registry, PATH, cache or source EXEs.
export async function extractCandidateHelper(selected, { arch = process.arch, destination } = {}) {
  if (!path.isAbsolute(destination ?? '')) throw new Error('An absolute isolated destination is required for the candidate helper.');
  const artifact = selected.candidate.packages.find((entry) => entry.arch === arch);
  if (!artifact) throw new Error('Unsupported Windows source candidate architecture.');
  const archive = await readRegularFile(path.join(selected.root, artifact.path));
  if (bytesDigest(archive) !== artifact.contentDigest) throw new Error('Native candidate archive changed; generate a new candidate.');
  const unpacked = readCandidatePackage(archive, { arch, version: selected.candidate.version });
  const packageRoot = path.join(destination, 'node_modules', ...artifact.name.split('/'));
  const executable = path.join(packageRoot, 'dist/aw-windows-job.exe');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), unpacked.packageJson, { flag: 'wx' });
  await writeFile(executable, unpacked.executable, { flag: 'wx', mode: 0o755 });
  return { state: 'ready', protocol: WINDOWS_JOB_PROTOCOL, executable };
}

export function candidateToolContext(ready) {
  return JSON.stringify({ schemaVersion: 1, tools: { 'windows-job': ready } });
}

export async function writeAtomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
}
