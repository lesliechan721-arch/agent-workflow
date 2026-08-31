import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside, pathsOverlap, sha256 } from './common.js'
import { readEvalContractFile } from './eval-file.js'
import { validateJsonSchema } from './json-schema.js'
import { assertSafeOutputPath } from './output-path.js'
import { computeEvalProviderDigest } from './eval-audit.js'
import { computeCanonicalDirectoryDigest, computeSkillDigest } from './runtime-skill.js'
import { getSchema } from './schemas.js'
import type { Digest, ValidationResult } from './types.js'

export type EvalProvider =
  | 'codex-trigger'
  | 'codex-conversation'
  | { type: 'custom-process'; command: string[] }

export interface EvalSpecPathDigest {
  path: string
  digest: Digest
}

export type EvalBaseline =
  | { type: 'none' }
  | { type: 'without-skill' }
  | { type: 'previous-version'; target: EvalSpecPathDigest }

export interface EvalSpec {
  version: 1
  source: { plugin: string; skill: string; suite: string; profile: string }
  workspace: EvalSpecPathDigest
  target: EvalSpecPathDigest
  cases: EvalSpecPathDigest
  provider: EvalProvider
  runs: number
  timeoutMs: number
  baseline: EvalBaseline
  outputDir: string
}

export interface EvalSpecCalculated {
  spec: EvalSpec
  specDigest: Digest
  workspaceDigest: Digest
  providerDigest: Digest
  targetDigest: Digest
  caseDigest: Digest
  previousTargetDigest: Digest | null
  paths: {
    workspace: string
    target: string
    cases: string
    previousTarget: string | null
    outputDir: string
  }
}

function isRelativeContractPath(value: string): boolean {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  const segments = value.split(/[\\/]/u)
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '..')
}

async function resolveInput(
  base: string,
  relativePath: string,
  label: string,
  expected: 'file' | 'directory' | 'file-or-directory',
): Promise<string> {
  if (!isRelativeContractPath(relativePath)) throw new Error(`${label} must be a safe relative path`)
  const candidate = path.resolve(base, relativePath)
  if (!isPathInside(base, candidate)) throw new Error(`${label} leaves the spec directory`)
  let current = base
  for (const segment of path.relative(base, candidate).split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} cannot contain a symlink path component`)
  }
  const actual = await realpath(candidate)
  if (!isPathInside(base, actual)) throw new Error(`${label} leaves the spec directory`)
  const info = await lstat(actual)
  if (expected === 'file' && !info.isFile()) throw new Error(`${label} must be a regular file`)
  if (expected === 'directory' && !info.isDirectory()) throw new Error(`${label} must be a directory`)
  if (expected === 'file-or-directory' && !info.isFile() && !info.isDirectory())
    throw new Error(`${label} must be a regular file or directory`)
  return actual
}

async function resolveOutput(base: string, relativePath: string): Promise<string> {
  if (!isRelativeContractPath(relativePath)) throw new Error('outputDir must be a safe relative path')
  const candidate = path.resolve(base, relativePath)
  await assertSafeOutputPath(base, candidate)
  return candidate
}

export async function validateEvalSpec(value: unknown): Promise<ValidationResult<EvalSpec>> {
  const errors = validateJsonSchema(await getSchema('eval-spec'), value)
  return { valid: errors.length === 0, errors, calculated: errors.length === 0 ? value as EvalSpec : null }
}

export async function parseEvalSpec(value: unknown): Promise<EvalSpec> {
  const validation = await validateEvalSpec(value)
  if (!validation.valid || !validation.calculated) throw new Error(validation.errors.join('; '))
  return validation.calculated
}

export async function validateEvalSpecFile(
  specPath: string,
): Promise<ValidationResult<EvalSpecCalculated>> {
  try {
    const file = await readEvalContractFile(specPath, 'EvalSpec')
    const spec = await parseEvalSpec(file.value)
    const base = await realpath(path.dirname(file.path))
    const workspace = await resolveInput(base, spec.workspace.path, 'workspace', 'directory')
    const target = await resolveInput(base, spec.target.path, 'target', 'file-or-directory')
    const cases = await resolveInput(base, spec.cases.path, 'cases', 'file')
    const workspaceDigest = await computeCanonicalDirectoryDigest(workspace)
    const targetDigest = await computeSkillDigest(target)
    const caseDigest = sha256(await readFile(cases))
    const errors: string[] = []
    if (workspaceDigest !== spec.workspace.digest)
      errors.push('workspace digest does not match workspace content')
    if (targetDigest !== spec.target.digest) errors.push('target digest does not match target content')
    if (caseDigest !== spec.cases.digest) errors.push('case digest does not match cases content')
    let previousTarget: string | null = null
    let previousTargetDigest: Digest | null = null
    if (spec.baseline.type === 'previous-version') {
      previousTarget = await resolveInput(
        base,
        spec.baseline.target.path,
        'previous-version target',
        'file-or-directory',
      )
      previousTargetDigest = await computeSkillDigest(previousTarget)
      if (previousTargetDigest !== spec.baseline.target.digest)
        errors.push('previous-version target digest does not match target content')
    }
    const outputDir = await resolveOutput(base, spec.outputDir)
    for (const [label, input] of [
      ['workspace', workspace],
      ['target', target],
      ['cases', cases],
      ['previous-version target', previousTarget],
    ] as const) {
      if (input && pathsOverlap(outputDir, input))
        errors.push(`outputDir must not overlap ${label}`)
    }
    if (errors.length > 0) return { valid: false, errors, calculated: null }
    return {
      valid: true,
      errors: [],
      calculated: {
        spec,
        specDigest: file.digest,
        workspaceDigest,
        providerDigest: computeEvalProviderDigest(spec.provider),
        targetDigest,
        caseDigest,
        previousTargetDigest,
        paths: { workspace, target, cases, previousTarget, outputDir },
      },
    }
  } catch (error) {
    return {
      valid: false,
      errors: [`EvalSpec is unavailable or invalid: ${(error as Error).message}`],
      calculated: null,
    }
  }
}
