import { createHash } from 'node:crypto';
import { lstat, readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseNativeToolDescriptor, nativeToolDescriptorDigest } from '../../packages/native-runtime/src/descriptor.mjs';
import { verifyWindowsJobArtifacts, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs';

export const bytesDigest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export async function readCandidate(root = windowsJobArtifactContract.defaultNativeRoot, options = {}) {
  const manifest = await verifyWindowsJobArtifacts({ ...options, nativeRoot: root });
  const read = async (name) => {
    const target = path.join(root, name);
    const stats = await lstat(target);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Native candidate files must be regular files.');
    return readFile(target);
  };
  const candidateBytes = await read('candidate.json');
  const candidate = JSON.parse(candidateBytes);
  const descriptor = parseNativeToolDescriptor(JSON.parse(await read('windows-job.lock.json')));
  const tool = JSON.parse(await readFile(path.join(windowsJobArtifactContract.toolRoot, 'tool.json'), 'utf8'));
  if (candidate.schemaVersion !== 1 || candidate.kind !== 'windows-job-candidate'
    || candidate.version !== tool.version || candidate.version !== descriptor.tool.version
    || descriptor.tool.id !== tool.id || descriptor.tool.protocol !== tool.protocol
    || candidate.sourceDigest !== manifest.sourceDigest || candidate.goVersion !== tool.goVersion
    || candidate.descriptorDigest !== nativeToolDescriptorDigest(descriptor)
    || candidate.packages?.length !== 2) throw new Error('Native candidate no longer matches the current tool source or descriptor; generate a new candidate.');
  for (const [index, arch] of ['x64', 'arm64'].entries()) {
    const entry = candidate.packages[index];
    const variant = descriptor.variants.find((item) => item.platform === 'win32' && item.arch === arch);
    if (entry?.arch !== arch || entry.name !== variant?.transport.package
      || variant.transport.version !== tool.version || variant.file.sha256 !== manifest.binaries[arch].sha256
      || variant.file.machine !== manifest.binaries[arch].peMachine
      || typeof entry.path !== 'string' || path.basename(entry.path) !== entry.path || !entry.path.endsWith('.tgz')) throw new Error('Native candidate archive inventory is invalid.');
    const bytes = await read(entry.path);
    if (bytesDigest(bytes) !== entry.contentDigest || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== variant.transport.archiveIntegrity) throw new Error('Native candidate archive changed; generate a new candidate.');
  }
  return { root, candidate, candidateDigest: bytesDigest(candidateBytes), descriptor, manifest };
}

export async function writeAtomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, target);
}
