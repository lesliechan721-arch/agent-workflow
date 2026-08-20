import { createHash } from 'node:crypto'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathsOverlap } from './common.js'
import type { Digest, RuntimeSkillSnapshot } from './types.js'

const alwaysIgnored = new Set(['.git', 'node_modules'])
const authorOnlyRoots = new Set(['evals', 'reports'])

interface RuntimeSkillFile {
  absolutePath: string
  relativePath: string
}

async function runtimeSkillFiles(root: string): Promise<RuntimeSkillFile[]> {
  const rootStat = await stat(root)
  if (rootStat.isFile()) return [{ absolutePath: root, relativePath: path.basename(root) }]
  if (!rootStat.isDirectory()) throw new Error(`Skill target is not a file or directory: ${root}`)

  const files: RuntimeSkillFile[] = []
  async function walk(directory: string, relativeDirectory = ''): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (alwaysIgnored.has(entry.name)) continue
      if (relativeDirectory === '' && authorOnlyRoots.has(entry.name)) continue
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`Skill target cannot contain symlinks: ${relativePath}`)
      if (entry.isDirectory()) await walk(absolutePath, relativePath)
      else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: relativePath.split(path.sep).join('/'),
        })
      }
    }
  }
  await walk(root)
  return files
}

export async function computeSkillDigest(skillPath: string): Promise<Digest> {
  if ((await lstat(skillPath)).isSymbolicLink()) throw new Error('Skill target cannot be a symlink')
  const canonicalRoot = await realpath(skillPath)
  const hash = createHash('sha256')
  for (const file of await runtimeSkillFiles(canonicalRoot)) {
    hash.update(file.relativePath)
    hash.update('\0')
    hash.update(await readFile(file.absolutePath))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

export async function createRuntimeSkillSnapshot(
  sourcePath: string,
  destinationPath: string,
): Promise<RuntimeSkillSnapshot> {
  if ((await lstat(sourcePath)).isSymbolicLink()) throw new Error('Skill target cannot be a symlink')
  const canonicalSource = await realpath(sourcePath)
  const resolvedDestination = path.resolve(destinationPath)
  if (pathsOverlap(canonicalSource, resolvedDestination))
    throw new Error('Runtime Skill snapshot destination must not overlap the source Skill')
  await mkdir(destinationPath, { recursive: true })
  for (const file of await runtimeSkillFiles(canonicalSource)) {
    const destination = path.join(destinationPath, ...file.relativePath.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(file.absolutePath, destination)
  }
  return {
    root: await realpath(destinationPath),
    digest: await computeSkillDigest(destinationPath),
  }
}
