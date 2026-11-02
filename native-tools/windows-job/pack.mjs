import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { parseNativeToolDescriptor, nativeToolDescriptorDigest } from '../../packages/native-runtime/src/descriptor.mjs'
import { verifyWindowsJobArtifacts, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs'

const { toolRoot, defaultNativeRoot } = windowsJobArtifactContract
const repoRoot = path.resolve(toolRoot, '../..')
const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex')

// The archive has two fixed regular files. Zero timestamps, uid and gid make
// its digest independent of the host, filesystem metadata and pack tooling.
function archiveFile(name, bytes, mode) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100)
  for (const [offset, width, value] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) {
    header.write(value.toString(8).padStart(width - 1, '0') + '\0', offset, width)
  }
  header.fill(0x20, 148, 156)
  header.write('0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  const sum = header.reduce((total, byte) => total + byte, 0)
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)])
}

export async function packWindowsJobCandidate(options = {}) {
  const tool = JSON.parse(await readFile(path.join(toolRoot, 'tool.json'), 'utf8'))
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(tool.version)) throw new Error('Windows Job version must be exact stable SemVer or beta.N.')
  const nativeRoot = options.nativeRoot ?? defaultNativeRoot
  const manifest = await verifyWindowsJobArtifacts({ ...options, nativeRoot })
  const variants = []
  const packages = []
  for (const arch of ['x64', 'arm64']) {
    const template = JSON.parse(await readFile(path.join(repoRoot, 'packages', `aw-windows-job-win32-${arch}`, 'package.json'), 'utf8'))
    const { scripts, devDependencies, ...metadata } = template
    const packageJson = Buffer.from(`${JSON.stringify({ ...metadata, version: tool.version }, null, 2)}\n`)
    const bytes = await readFile(path.join(nativeRoot, manifest.binaries[arch].path))
    const archive = gzipSync(Buffer.concat([
      archiveFile('package/package.json', packageJson, 0o644),
      archiveFile('package/dist/aw-windows-job.exe', bytes, 0o755),
      Buffer.alloc(1024),
    ]), { level: 9 })
    // gzip records the producer's OS. Use the unspecified value so the same
    // tar bytes have one immutable archive integrity on every build host.
    archive[9] = 255
    const archiveName = `${template.name.replace(/^@/u, '').replace('/', '-')}-${tool.version}.tgz`
    await mkdir(nativeRoot, { recursive: true })
    await writeFile(path.join(nativeRoot, archiveName), archive)
    variants.push({
      platform: 'win32', arch,
      transport: { kind: 'npm', package: template.name, version: tool.version, archiveIntegrity: `sha512-${hash(archive, 'sha512')}`, entry: 'package/dist/aw-windows-job.exe' },
      file: { sha256: `sha256:${hash(bytes)}`, size: bytes.length, format: 'pe', machine: manifest.binaries[arch].peMachine },
      limits: { archiveBytes: 8 * 1024 * 1024, expandedBytes: 16 * 1024 * 1024, entries: 32 },
    })
    packages.push({ name: template.name, arch, path: archiveName, contentDigest: `sha256:${hash(archive)}` })
  }
  const descriptor = parseNativeToolDescriptor({ schemaVersion: 1, tool: { id: tool.id, version: tool.version, protocol: tool.protocol }, variants })
  const candidate = { schemaVersion: 1, kind: 'windows-job-candidate', version: tool.version, sourceDigest: manifest.sourceDigest, goVersion: manifest.build.goVersion, descriptorDigest: nativeToolDescriptorDigest(descriptor), packages }
  await writeFile(path.join(nativeRoot, 'windows-job.lock.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
  await writeFile(path.join(nativeRoot, 'candidate.json'), `${JSON.stringify(candidate, null, 2)}\n`)
  // This is a byte lock, not evidence that the packages exist in a registry.
  if (options.writeLock !== false) await writeFile(path.join(toolRoot, 'windows-job.lock.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
  return { root: nativeRoot, descriptor, candidate }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await packWindowsJobCandidate(); console.log(`Packed Windows Job ${result.candidate.version} into ${result.root}.`) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
