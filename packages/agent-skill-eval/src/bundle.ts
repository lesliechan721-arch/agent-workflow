import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside, sha256, stable } from './common.js'
import { validateJsonSchema } from './json-schema.js'
import { getSchema } from './schemas.js'
import type { Digest, ValidationResult } from './types.js'

export interface EvalArtifact {
  role: 'trace' | 'report' | 'output' | 'grading' | 'other'
  path: string
  digest: Digest
}

export interface EvalGrading {
  grader: { id: string; version: string; [key: string]: unknown }
  result: Record<string, unknown>
  [key: string]: unknown
}

export interface EvalRun {
  caseId: string
  configuration: string
  comparisonId: string | null
  skillMode: 'with-skill' | 'without-skill' | 'previous-version'
  skillDigest: Digest | null
  runIndex: number
  status: 'completed' | 'process-failed' | 'timeout' | 'error'
  exitCode: number | null
  durationMs: number
  stdoutPath: string
  stdoutDigest: Digest
  stderrPath: string
  stderrDigest: Digest
  usage: Record<string, unknown> | null
  grading: EvalGrading | null
  artifacts: EvalArtifact[]
}

export interface ComparisonAggregate {
  comparisonId: string
  caseId: string
  runIndex: number
  paired: boolean
  comparable: boolean
}

export interface EvalRunBundle {
  schemaVersion: 3
  runner: { id: string; version: string }
  independentContext: boolean
  provider: { id: string; version: string }
  planDigest: Digest
  targetSkillDigest: Digest
  caseCorpusDigest: Digest
  comparisonPlanned: boolean
  evidenceLevel: 'executed' | 'comparative'
  evidenceRequirement?: {
    minimumEvidenceLevel: 'executed' | 'comparative'
    plannedComparisons: number
    comparableComparisons: number
    satisfied: boolean
  }
  processManagement?: {
    mode: 'managed' | 'verified-observed' | 'observed'
    descendantCleanupGuaranteed: boolean
    limitation?: string
  }
  runs: EvalRun[]
  aggregate: {
    cases: number
    configurations: number
    runs: number
    completed: number
    processFailed: number
    timedOut: number
    comparisons: ComparisonAggregate[]
  }
  limitations: string[]
}

export interface BundleCalculated {
  bundleDigest: Digest
  cases?: number
  configurations?: number
  runs?: number
  completed?: number
  processFailed?: number
  timedOut?: number
  comparisons?: ComparisonAggregate[]
}

function identity(values: unknown[]): string {
  return JSON.stringify(values)
}

function graderIdentity(run: EvalRun): string | null {
  return run.grading ? identity([run.grading.grader.id, run.grading.grader.version]) : null
}

function runIdentity(run: EvalRun): string {
  return identity([run.caseId, run.configuration, run.runIndex])
}

export function comparisonAggregate(
  runs: EvalRun[],
  gradingBoundRuns = new Set(
    runs
      .filter((run) => run.grading !== null && run.artifacts.filter((entry) => entry.role === 'grading').length === 1)
      .map(runIdentity),
  ),
): ComparisonAggregate[] {
  const groups = new Map<string, { comparisonId: string; caseId: string; runIndex: number; runs: EvalRun[] }>()
  for (const run of runs) {
    if (run.comparisonId === null) continue
    const key = identity([run.comparisonId, run.caseId, run.runIndex])
    const group = groups.get(key) ?? {
      comparisonId: run.comparisonId,
      caseId: run.caseId,
      runIndex: run.runIndex,
      runs: [],
    }
    group.runs.push(run)
    groups.set(key, group)
  }
  return [...groups.values()].map((group) => {
    const withSkill = group.runs.filter((run) => run.skillMode === 'with-skill' && run.status === 'completed')
    const baselines = group.runs.filter((run) => run.skillMode !== 'with-skill' && run.status === 'completed')
    const paired = withSkill.length > 0 && baselines.length > 0
    const comparable = paired && withSkill.some((current) => {
      if (!gradingBoundRuns.has(runIdentity(current))) return false
      const currentGrader = graderIdentity(current)
      return currentGrader !== null && baselines.some((baseline) =>
        gradingBoundRuns.has(runIdentity(baseline)) && graderIdentity(baseline) === currentGrader)
    })
    return { comparisonId: group.comparisonId, caseId: group.caseId, runIndex: group.runIndex, paired, comparable }
  }).sort((left, right) => identity([left.comparisonId, left.caseId, left.runIndex])
    .localeCompare(identity([right.comparisonId, right.caseId, right.runIndex])))
}

function isCanonicalEvidencePath(value: string): boolean {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

async function evidenceErrors(root: string, value: string, digest: Digest, label: string): Promise<string[]> {
  if (!isCanonicalEvidencePath(value)) return [`${label} must be a canonical POSIX relative file path`]
  const candidate = path.resolve(root, value)
  if (!isPathInside(root, candidate)) return [`${label} leaves the evidence root`]
  try {
    const info = await lstat(candidate)
    if (info.isSymbolicLink()) return [`${label} must not be a symlink`]
    if (!info.isFile()) return [`${label} must be a regular file`]
    const actual = await realpath(candidate)
    if (!isPathInside(root, actual)) return [`${label} leaves the evidence root`]
    return sha256(await readFile(actual)) === digest ? [] : [`${label} digest does not match file content`]
  } catch {
    return [`${label} does not resolve to a regular evidence file`]
  }
}

async function gradingBindingErrors(
  root: string,
  run: EvalRun,
  index: number,
): Promise<{ errors: string[]; bound: boolean }> {
  const artifacts = run.artifacts.filter((entry) => entry.role === 'grading')
  if (run.grading === null) {
    return artifacts.length === 0
      ? { errors: [], bound: false }
      : { errors: [`runs[${index}] must not have a grading artifact when grading is null`], bound: false }
  }
  if (artifacts.length !== 1)
    return { errors: [`runs[${index}] grading requires exactly one grading artifact`], bound: false }
  const artifact = artifacts[0]
  if (!isCanonicalEvidencePath(artifact.path)) return { errors: [], bound: false }
  try {
    const candidate = path.resolve(root, artifact.path)
    if (!isPathInside(root, candidate)) return { errors: [], bound: false }
    const info = await lstat(candidate)
    if (info.isSymbolicLink() || !info.isFile()) return { errors: [], bound: false }
    const actual = await realpath(candidate)
    if (!isPathInside(root, actual)) return { errors: [], bound: false }
    const bytes = await readFile(actual)
    if (sha256(bytes) !== artifact.digest) return { errors: [], bound: false }
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown
    if (stable(parsed) !== stable(run.grading)) {
      return { errors: [`runs[${index}] grading artifact does not match run.grading`], bound: false }
    }
    return { errors: [], bound: true }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { errors: [`runs[${index}] grading artifact must contain JSON`], bound: false }
    }
    return { errors: [], bound: false }
  }
}

export async function validateRunBundle(
  bundlePath: string,
  options: { evidenceRoot?: string } = {},
): Promise<ValidationResult<BundleCalculated>> {
  let bundle: EvalRunBundle
  const errors: string[] = []
  let raw: Buffer
  try {
    raw = await readFile(bundlePath)
  } catch (error) {
    return { valid: false, errors: [`bundle is unavailable or invalid: ${(error as Error).message}`], calculated: null }
  }
  const digestCalculated: BundleCalculated = { bundleDigest: sha256(raw) }
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown
    errors.push(...validateJsonSchema(await getSchema('eval-run-bundle'), value))
    if (errors.length > 0) return { valid: false, errors, calculated: digestCalculated }
    bundle = value as EvalRunBundle
  } catch (error) {
    return { valid: false, errors: [`bundle is unavailable or invalid: ${(error as Error).message}`], calculated: digestCalculated }
  }
  const root = await realpath(options.evidenceRoot ?? path.dirname(path.resolve(bundlePath)))
  const runIdentities = new Set<string>()
  const gradingBoundRuns = new Set<string>()
  for (let index = 0; index < bundle.runs.length; index += 1) {
    const run = bundle.runs[index]
    const key = identity([run.caseId, run.configuration, run.runIndex])
    if (runIdentities.has(key)) errors.push(`duplicate run identity ${key}`)
    runIdentities.add(key)
    if (run.skillMode === 'with-skill' && run.skillDigest !== bundle.targetSkillDigest)
      errors.push(`with-skill run ${key} must use targetSkillDigest`)
    if (run.skillMode === 'without-skill' && run.skillDigest !== null)
      errors.push(`without-skill run ${key} must use skillDigest=null`)
    if (run.skillMode === 'previous-version' && run.skillDigest === null)
      errors.push(`previous-version run ${key} must use a Skill digest`)
    errors.push(
      ...await evidenceErrors(root, run.stdoutPath, run.stdoutDigest, `runs[${index}].stdoutPath`),
      ...await evidenceErrors(root, run.stderrPath, run.stderrDigest, `runs[${index}].stderrPath`),
    )
    for (let artifactIndex = 0; artifactIndex < run.artifacts.length; artifactIndex += 1) {
      const artifact = run.artifacts[artifactIndex]
      errors.push(...await evidenceErrors(root, artifact.path, artifact.digest, `runs[${index}].artifacts[${artifactIndex}].path`))
    }
    const gradingBinding = await gradingBindingErrors(root, run, index)
    errors.push(...gradingBinding.errors)
    if (gradingBinding.bound) gradingBoundRuns.add(runIdentity(run))
  }
  const comparisons = comparisonAggregate(bundle.runs, gradingBoundRuns)
  const calculated: BundleCalculated = {
    bundleDigest: digestCalculated.bundleDigest,
    cases: new Set(bundle.runs.map((run) => run.caseId)).size,
    configurations: new Set(bundle.runs.map((run) => run.configuration)).size,
    runs: bundle.runs.length,
    completed: bundle.runs.filter((run) => run.status === 'completed').length,
    processFailed: bundle.runs.filter((run) => run.status === 'process-failed' || run.status === 'error').length,
    timedOut: bundle.runs.filter((run) => run.status === 'timeout').length,
    comparisons,
  }
  for (const name of ['cases', 'configurations', 'runs', 'completed', 'processFailed', 'timedOut'] as const)
    if (bundle.aggregate[name] !== calculated[name]) errors.push(`aggregate.${name} does not match runs`)
  const actualComparisons = [...bundle.aggregate.comparisons].sort((left, right) =>
    identity([left.comparisonId, left.caseId, left.runIndex]).localeCompare(identity([right.comparisonId, right.caseId, right.runIndex])))
  if (JSON.stringify(actualComparisons) !== JSON.stringify(comparisons))
    errors.push('aggregate.comparisons does not match runs')
  const comparisonPlanned = comparisons.length > 0
  if (bundle.comparisonPlanned !== comparisonPlanned)
    errors.push('comparisonPlanned does not match run comparison identities')
  const evidenceLevel = comparisons.some((entry) => entry.comparable) ? 'comparative' : 'executed'
  if (bundle.evidenceLevel !== evidenceLevel)
    errors.push(`evidenceLevel must be ${evidenceLevel} for the supplied runs`)
  if (bundle.evidenceRequirement) {
    const comparableComparisons = comparisons.filter((entry) => entry.comparable).length
    if (bundle.evidenceRequirement.comparableComparisons !== comparableComparisons)
      errors.push('evidenceRequirement.comparableComparisons does not match aggregate comparisons')
    if (bundle.evidenceRequirement.plannedComparisons < comparisons.length)
      errors.push('evidenceRequirement.plannedComparisons is smaller than aggregate comparisons')
    const comparisonCoverageSatisfied = bundle.evidenceRequirement.minimumEvidenceLevel === 'executed' || (
      bundle.evidenceRequirement.plannedComparisons > 0 &&
      comparableComparisons === bundle.evidenceRequirement.plannedComparisons
    )
    if (bundle.evidenceRequirement.satisfied && !comparisonCoverageSatisfied)
      errors.push('evidenceRequirement.satisfied cannot be true without required comparison coverage')
  }
  if (
    bundle.processManagement?.mode === 'managed' &&
    bundle.processManagement.descendantCleanupGuaranteed !== true
  ) errors.push('managed processManagement must guarantee descendant cleanup')
  if (
    bundle.processManagement &&
    bundle.processManagement.mode !== 'managed' &&
    bundle.processManagement.descendantCleanupGuaranteed !== false
  ) errors.push('observed processManagement must not guarantee descendant cleanup')
  if (
    bundle.processManagement &&
    bundle.processManagement.mode !== 'managed' &&
    !bundle.processManagement.limitation
  ) errors.push('observed processManagement requires a limitation')
  if (
    bundle.processManagement?.limitation &&
    !bundle.limitations.includes(bundle.processManagement.limitation)
  ) errors.push('processManagement limitation must be preserved in limitations')
  if (
    bundle.evidenceLevel === 'comparative' &&
    bundle.evidenceRequirement?.satisfied !== false &&
    bundle.processManagement?.mode === 'observed'
  ) errors.push('accepted comparative evidence requires managed or verified-observed process management')
  if (
    bundle.evidenceLevel === 'comparative' &&
    bundle.evidenceRequirement?.satisfied === true &&
    bundle.processManagement === undefined
  ) errors.push('accepted comparative evidence requires processManagement evidence')
  if (comparisons.some((entry) => !entry.comparable) && bundle.limitations.length === 0)
    errors.push('non-comparable planned comparisons require a limitation')
  return { valid: errors.length === 0, errors, calculated }
}
