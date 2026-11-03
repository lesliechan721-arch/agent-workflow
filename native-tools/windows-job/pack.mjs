import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { bytesDigest, readCandidate, writeAtomicJson } from './candidate.mjs'
import { refreshWindowsJobArtifacts, verifyWindowsJobArtifacts, verifyWindowsJobReproducibility, windowsJobArtifactContract } from './windows-job-helper-artifacts.mjs'

const defaultRepoRoot = path.resolve(windowsJobArtifactContract.toolRoot, '../..')

// Zero timestamps, uid and gid make the two-file archive independent of the host.
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

async function candidateOptions(options) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot
  const version = options.version ?? JSON.parse(await readFile(path.join(repoRoot, 'packages/cli/package.json'), 'utf8')).version
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version ?? '')) throw new Error('Windows Job candidate requires an exact stable or beta.N CLI version.')
  return { ...options, repoRoot, version, nativeRoot: options.nativeRoot ?? path.join(repoRoot, '.native/windows-job', version) }
}

export async function packWindowsJobCandidate(options = {}) {
  const selected = await candidateOptions(options)
  const { repoRoot, nativeRoot, version } = selected
  const manifest = await verifyWindowsJobArtifacts(selected)
  const packages = []
  for (const arch of ['x64', 'arm64']) {
    const template = JSON.parse(await readFile(path.join(repoRoot, 'packages', `aw-windows-job-win32-${arch}`, 'package.json'), 'utf8'))
    const { scripts, devDependencies, ...metadata } = template
    const packageJson = Buffer.from(`${JSON.stringify({ ...metadata, version, os: ['win32'], cpu: [arch] }, null, 2)}\n`)
    const bytes = await readFile(path.join(nativeRoot, manifest.binaries[arch].path))
    const archive = gzipSync(Buffer.concat([
      archiveFile('package/package.json', packageJson, 0o644),
      archiveFile('package/dist/aw-windows-job.exe', bytes, 0o755),
      Buffer.alloc(1024),
    ]), { level: 9 })
    archive[9] = 255
    const archiveName = `${template.name.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`
    await mkdir(nativeRoot, { recursive: true })
    await writeFile(path.join(nativeRoot, archiveName), archive)
    packages.push({ name: template.name, arch, path: archiveName, contentDigest: bytesDigest(archive) })
  }
  const candidate = { schemaVersion: 1, kind: 'windows-job-candidate', version, sourceDigest: manifest.sourceDigest, goVersion: manifest.build.goVersion, packages }
  await writeAtomicJson(path.join(nativeRoot, 'candidate.json'), candidate)
  const result = await readCandidate(nativeRoot, selected)
  return { ...result, tarballPaths: packages.map((entry) => path.join(nativeRoot, entry.path)) }
}

export async function buildWindowsJobCandidate(options = {}) {
  const selected = await candidateOptions(options)
  await refreshWindowsJobArtifacts(selected)
  const result = await packWindowsJobCandidate(selected)
  await verifyWindowsJobReproducibility(selected)
  await writeAtomicJson(path.join(result.root, 'reproducibility.json'), {
    schemaVersion: 1, kind: 'windows-job-reproducibility', status: 'passed',
    candidateDigest: result.candidateDigest, sourceDigest: result.candidate.sourceDigest,
    goVersion: result.candidate.goVersion, architectures: ['x64', 'arm64'],
  })
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2).filter((arg) => arg !== '--')
    const options = {}
    while (args.length) {
      const flag = args.shift()
      const value = args.shift()
      if (flag === '--version' && value && options.version === undefined) options.version = value
      else if (flag === '--out' && value && options.nativeRoot === undefined) options.nativeRoot = path.resolve(value)
      else throw new Error('Expected [--version <CLI version>] [--out <candidate directory>].')
    }
    const result = await packWindowsJobCandidate(options)
    console.log(`Packed Windows Job for CLI ${result.candidate.version} into ${result.root}.`)
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
