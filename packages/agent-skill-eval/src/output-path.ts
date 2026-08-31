import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside } from './common.js'

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

export async function assertSafeOutputPath(base: string, target: string): Promise<void> {
  const canonicalBase = await realpath(base)
  const resolvedTarget = path.resolve(canonicalBase, target)
  if (!isPathInside(canonicalBase, resolvedTarget) || resolvedTarget === canonicalBase)
    throw new Error('output path must be a non-root child inside the spec directory')

  const relative = path.relative(canonicalBase, resolvedTarget)
  let candidate = canonicalBase
  for (const segment of relative.split(path.sep)) {
    candidate = path.join(candidate, segment)
    let info
    try {
      info = await lstat(candidate)
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`output path component cannot be a symlink: ${candidate}`)
    if (!info.isDirectory()) throw new Error(`output path component must be a directory: ${candidate}`)
    const actual = await realpath(candidate)
    if (!isPathInside(canonicalBase, actual)) throw new Error('output path leaves the spec directory')
  }
}
