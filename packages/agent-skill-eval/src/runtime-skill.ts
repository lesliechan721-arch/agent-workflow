import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathsOverlap } from './common.js'
import type { Digest, RuntimeSkillSnapshot } from './types.js'

const alwaysIgnored = new Set(['.git', 'node_modules', '.DS_Store'])
const authorOnlyRoots = new Set(['evals', 'reports'])
const productionDigestDomain = 'aw-production-records-v1'

interface RuntimeSkillFile {
  absolutePath: string
  relativePath: string
  mode: '100644' | '100755'
}

export interface CapturedRuntimeSkillFile {
  relativePath: string
  mode: '100644' | '100755'
  bytes: Buffer
}

export interface CapturedRuntimeSkill {
  sourceRoot: string
  digest: Digest
  files: CapturedRuntimeSkillFile[]
}

export interface RuntimeSkillDigestOptions {
  platform?: NodeJS.Platform
}

function normalizedRegularFileMode(mode: number, platform: NodeJS.Platform): '100644' | '100755' {
  // Windows does not expose a portable executable bit, so its stable runtime mode is 100644.
  return platform !== 'win32' && (mode & 0o111) !== 0 ? '100755' : '100644'
}

function comparePosixPaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
  const length = Buffer.allocUnsafe(8)
  length.writeBigUInt64BE(BigInt(bytes.length))
  hash.update(length)
  hash.update(bytes)
}

function digestProductionRecords(
  files: ReadonlyArray<{ relativePath: string; mode: '100644' | '100755'; bytes: Buffer }>,
): Digest {
  const hash = createHash('sha256')
  updateLengthPrefixed(hash, productionDigestDomain)
  for (const file of [...files].sort((left, right) =>
    comparePosixPaths(left.relativePath, right.relativePath))) {
    updateLengthPrefixed(hash, file.relativePath)
    updateLengthPrefixed(hash, file.mode)
    updateLengthPrefixed(hash, createHash('sha256').update(file.bytes).digest())
  }
  return `sha256:${hash.digest('hex')}`
}

async function runtimeSkillFiles(
  root: string,
  platform: NodeJS.Platform,
  filterSkillOnly = true,
): Promise<RuntimeSkillFile[]> {
  const rootStat = await stat(root)
  if (rootStat.isFile()) {
    return [{
      absolutePath: root,
      relativePath: path.basename(root),
      mode: normalizedRegularFileMode(rootStat.mode, platform),
    }]
  }
  if (!rootStat.isDirectory()) throw new Error(`Skill target is not a file or directory: ${root}`)

  const files: RuntimeSkillFile[] = []
  async function walk(directory: string, relativeDirectory = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (filterSkillOnly && alwaysIgnored.has(entry.name)) continue
      if (filterSkillOnly && relativeDirectory === '' && authorOnlyRoots.has(entry.name)) continue
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Skill target cannot contain symlinks: ${relativePath}`)
      if (entry.isDirectory()) await walk(absolutePath, relativePath)
      else if (entry.isFile()) {
        const fileStat = await stat(absolutePath)
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
          mode: normalizedRegularFileMode(fileStat.mode, platform),
        })
      }
    }
  }
  await walk(root)
  return files
}

export async function computeSkillDigest(
  skillPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<Digest> {
  if ((await lstat(skillPath)).isSymbolicLink()) throw new Error('Skill target cannot be a symlink')
  const canonicalRoot = await realpath(skillPath)
  const files = await Promise.all(
    (await runtimeSkillFiles(canonicalRoot, options.platform ?? process.platform)).map(
      async (file) => ({
        relativePath: file.relativePath,
        mode: file.mode,
        bytes: await readFile(file.absolutePath),
      }),
    ),
  )
  return digestProductionRecords(files)
}

function digestCapturedRuntimeSkill(files: CapturedRuntimeSkillFile[]): Digest {
  return digestProductionRecords(files)
}

export async function captureRuntimeSkill(
  skillPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<CapturedRuntimeSkill> {
  if ((await lstat(skillPath)).isSymbolicLink()) throw new Error('Skill target cannot be a symlink')
  const sourceRoot = await realpath(skillPath)
  const files = await Promise.all(
    (await runtimeSkillFiles(sourceRoot, options.platform ?? process.platform)).map(async (file) => ({
      relativePath: file.relativePath,
      mode: file.mode,
      bytes: await readFile(file.absolutePath),
    })),
  )
  return { sourceRoot, digest: digestCapturedRuntimeSkill(files), files }
}

export async function computeCanonicalDirectoryDigest(
  directoryPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<Digest> {
  return (await captureCanonicalDirectory(directoryPath, options)).digest
}

export async function captureCanonicalDirectory(
  directoryPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<CapturedRuntimeSkill> {
  if ((await lstat(directoryPath)).isSymbolicLink()) throw new Error('directory cannot be a symlink')
  const sourceRoot = await realpath(directoryPath)
  if (!(await stat(sourceRoot)).isDirectory()) throw new Error('runtime input must be a directory')
  const files = await Promise.all(
    (await runtimeSkillFiles(sourceRoot, options.platform ?? process.platform, false)).map(async (file) => ({
      relativePath: file.relativePath,
      mode: file.mode,
      bytes: await readFile(file.absolutePath),
    })),
  )
  return { sourceRoot, digest: digestCapturedRuntimeSkill(files), files }
}

export async function materializeCapturedRuntimeSkill(
  captured: CapturedRuntimeSkill,
  destinationPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<RuntimeSkillSnapshot> {
  const resolvedDestination = path.resolve(destinationPath)
  if (pathsOverlap(captured.sourceRoot, resolvedDestination))
    throw new Error('Runtime Skill snapshot destination must not overlap the source Skill')
  await mkdir(destinationPath, { recursive: true })
  const platform = options.platform ?? process.platform
  for (const file of captured.files) {
    const destination = path.join(destinationPath, ...file.relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 })
    if (platform !== 'win32') await chmod(destination, file.mode === '100755' ? 0o755 : 0o644)
  }
  const digest = await computeSkillDigest(destinationPath, options)
  if (digest !== captured.digest) throw new Error('Runtime Skill snapshot digest does not match captured Skill bytes')
  return { root: await realpath(destinationPath), digest }
}

export async function materializeCapturedCanonicalDirectory(
  captured: CapturedRuntimeSkill,
  destinationPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<RuntimeSkillSnapshot> {
  const resolvedDestination = path.resolve(destinationPath)
  if (pathsOverlap(captured.sourceRoot, resolvedDestination))
    throw new Error('runtime input snapshot destination must not overlap its source')
  await mkdir(destinationPath, { recursive: true })
  const platform = options.platform ?? process.platform
  for (const file of captured.files) {
    const destination = path.join(destinationPath, ...file.relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o755 : 0o644 })
    if (platform !== 'win32') await chmod(destination, file.mode === '100755' ? 0o755 : 0o644)
  }
  const digest = await computeCanonicalDirectoryDigest(destinationPath, options)
  if (digest !== captured.digest) throw new Error('runtime input snapshot digest does not match captured bytes')
  return { root: await realpath(destinationPath), digest }
}

export async function createRuntimeSkillSnapshot(
  sourcePath: string,
  destinationPath: string,
  options: RuntimeSkillDigestOptions = {},
): Promise<RuntimeSkillSnapshot> {
  if ((await lstat(sourcePath)).isSymbolicLink()) throw new Error('Skill target cannot be a symlink')
  const canonicalSource = await realpath(sourcePath)
  const resolvedDestination = path.resolve(destinationPath)
  if (pathsOverlap(canonicalSource, resolvedDestination))
    throw new Error('Runtime Skill snapshot destination must not overlap the source Skill')
  await mkdir(destinationPath, { recursive: true })
  const platform = options.platform ?? process.platform
  for (const file of await runtimeSkillFiles(canonicalSource, platform)) {
    const destination = path.join(destinationPath, ...file.relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(file.absolutePath, destination)
    if (platform !== 'win32') await chmod(destination, file.mode === '100755' ? 0o755 : 0o644)
  }
  return {
    root: await realpath(destinationPath),
    digest: await computeSkillDigest(destinationPath, options),
  }
}
