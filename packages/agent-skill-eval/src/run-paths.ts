import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'

interface ProviderRunPaths {
  evalRoot: string
  workspacePath: string
  fixturesPath: string
  outputDir: string
}

function assertAbsoluteNormalized(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`)
  if (path.normalize(value) !== value) throw new Error(`${label} must be normalized without '..'.`)
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || pathIsInside(left, right) || pathIsInside(right, left)
}

async function assertOrdinaryDirectory(value: string, label: string): Promise<void> {
  const info = await lstat(value)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be an ordinary directory.`)
  }
}

async function assertSafePathChain(
  evalRoot: string,
  candidate: string,
  label: string,
): Promise<void> {
  const relative = path.relative(evalRoot, candidate)
  if (
    relative === '' || relative === '..' ||
    relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
  ) throw new Error(`${label} must stay inside evalRoot.`)
  let current = evalRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new Error(`${label} path chain must not contain symbolic links.`)
  }
}

export async function assertProviderRunPaths(paths: ProviderRunPaths): Promise<ProviderRunPaths> {
  for (const [label, value] of Object.entries(paths)) assertAbsoluteNormalized(value, label)
  await assertOrdinaryDirectory(paths.evalRoot, 'evalRoot')
  const canonicalEvalRoot = await realpath(paths.evalRoot)
  const canonical: ProviderRunPaths = {
    evalRoot: canonicalEvalRoot,
    workspacePath: '',
    fixturesPath: '',
    outputDir: '',
  }
  for (const label of ['workspacePath', 'fixturesPath', 'outputDir'] as const) {
    const value = paths[label]
    await assertOrdinaryDirectory(value, label)
    await assertSafePathChain(paths.evalRoot, value, label)
    const resolved = await realpath(value)
    if (!pathIsInside(canonicalEvalRoot, resolved)) {
      throw new Error(`${label} realpath must stay inside evalRoot.`)
    }
    canonical[label] = resolved
  }
  const pairs = [
    ['workspacePath', 'fixturesPath'],
    ['workspacePath', 'outputDir'],
    ['fixturesPath', 'outputDir'],
  ] as const
  for (const [left, right] of pairs) {
    if (pathsOverlap(canonical[left], canonical[right])) {
      throw new Error(`${left} and ${right} must not overlap.`)
    }
  }
  return canonical
}
