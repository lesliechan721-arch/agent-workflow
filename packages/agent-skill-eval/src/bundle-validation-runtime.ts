import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'

type Digest = `sha256:${string}`

interface RuntimeArtifact {
  role: 'trace' | 'report' | 'output' | 'grading' | 'other'
  path: string
  digest: Digest
}

interface RuntimeRun {
  caseId: string
  configuration: string
  comparisonId: string | null
  skillMode: 'with-skill' | 'without-skill' | 'previous-version'
  skillDigest: Digest | null
  runIndex: number
  status: 'completed' | 'process-failed' | 'timeout' | 'error'
  stdoutPath: string
  stdoutDigest: Digest
  stderrPath: string
  stderrDigest: Digest
  usage: Record<string, unknown> | null
  grading: null | { grader: { id: string; version: string }; [key: string]: unknown }
  artifacts: RuntimeArtifact[]
}

interface RuntimeBundle {
  provider: { id: string; version: string }
  providerCapabilitiesDigest: Digest
  targetSkillDigest: Digest
  runtimeInputs: Array<{ id: string; digest: Digest }>
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
  runs: RuntimeRun[]
  aggregate: {
    cases: number
    configurations: number
    runs: number
    completed: number
    processFailed: number
    timedOut: number
    comparisons: RuntimeComparisonAggregate[]
  }
  limitations: string[]
}

interface RuntimeProviderOutput {
  schemaVersion: 1
  provider: { id: string; version: string }
  usage: Record<string, unknown> | null
  grading: Record<string, unknown> | null
  artifacts: Array<{ path: string; role?: 'trace' | 'report' | 'output' | 'other' }>
}

export interface RuntimeComparisonAggregate {
  comparisonId: string
  caseId: string
  runIndex: number
  paired: boolean
  comparable: boolean
}

export interface RuntimeBundleCalculated {
  bundleDigest: Digest
  cases?: number
  configurations?: number
  runs?: number
  completed?: number
  processFailed?: number
  timedOut?: number
  comparisons?: RuntimeComparisonAggregate[]
}

export interface RuntimeBundleValidationResult {
  valid: boolean
  errors: string[]
  calculated: RuntimeBundleCalculated | null
}

function sha256(data: string | NodeJS.ArrayBufferView): Digest {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => stable(entry)).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
    .join(',')}}`
}

function identity(values: unknown[]): string {
  return JSON.stringify(values)
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
  )
}

function graderIdentity(run: RuntimeRun): string | null {
  return run.grading ? identity([run.grading.grader.id, run.grading.grader.version]) : null
}

function runIdentity(run: RuntimeRun): string {
  return identity([run.caseId, run.configuration, run.runIndex])
}

export function comparisonAggregate(
  runs: RuntimeRun[],
  gradingBoundRuns = new Set(
    runs
      .filter((run) => run.grading !== null && run.artifacts.filter((entry) => entry.role === 'grading').length === 1)
      .map(runIdentity),
  ),
): RuntimeComparisonAggregate[] {
  const groups = new Map<string, { comparisonId: string; caseId: string; runIndex: number; runs: RuntimeRun[] }>()
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
  run: RuntimeRun,
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
  const artifact = artifacts[0]!
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function providerOutputFrom(value: unknown): { output: RuntimeProviderOutput | null; errors: string[] } {
  const errors: string[] = []
  if (!record(value)) return { output: null, errors: ['must be an object'] }
  if (!exactKeys(value, ['schemaVersion', 'provider', 'usage', 'grading', 'artifacts'])) errors.push('has unsupported properties')
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!record(value.provider) || !exactKeys(value.provider, ['id', 'version']) ||
    typeof value.provider.id !== 'string' || !value.provider.id ||
    typeof value.provider.version !== 'string' || !value.provider.version) errors.push('provider identity is invalid')
  if (value.usage !== null && !record(value.usage)) errors.push('usage must be an object or null')
  if (value.grading !== null && !record(value.grading)) errors.push('grading must be an object or null')
  if (!Array.isArray(value.artifacts)) {
    errors.push('artifacts must be an array')
  } else {
    for (const [index, artifact] of value.artifacts.entries()) {
      if (!record(artifact) || !exactKeys(artifact, ['path', 'role']) || typeof artifact.path !== 'string' || !artifact.path ||
        (artifact.role !== undefined && !['trace', 'report', 'output', 'other'].includes(String(artifact.role)))) {
        errors.push(`artifacts[${index}] is invalid`)
      }
    }
  }
  return errors.length > 0
    ? { output: null, errors }
    : { output: value as unknown as RuntimeProviderOutput, errors }
}

async function providerOutputBindingErrors(root: string, bundle: RuntimeBundle, run: RuntimeRun, index: number): Promise<string[]> {
  const errors: string[] = []
  if (!isCanonicalEvidencePath(run.stdoutPath)) return errors
  const stdoutPath = path.resolve(root, run.stdoutPath)
  try {
    const parsed = JSON.parse((await readFile(stdoutPath)).toString('utf8')) as unknown
    const validation = providerOutputFrom(parsed)
    if (!validation.output) return validation.errors.map((entry) => `runs[${index}] ProviderOutput ${entry}`)
    const output = validation.output
    if (stable(output.provider) !== stable(bundle.provider))
      errors.push(`runs[${index}] ProviderOutput provider does not match bundle.provider`)
    if (stable(output.usage) !== stable(run.usage))
      errors.push(`runs[${index}] ProviderOutput usage does not match run.usage`)
    if (run.grading !== null && stable(output.grading) !== stable(run.grading))
      errors.push(`runs[${index}] accepted grading does not match ProviderOutput grading`)
    const runDirectory = path.dirname(stdoutPath)
    const declaredArtifacts: Array<{ role: string; path: string }> = []
    for (const [artifactIndex, artifact] of output.artifacts.entries()) {
      const candidate = path.resolve(runDirectory, artifact.path)
      if (!isPathInside(runDirectory, candidate)) {
        errors.push(`runs[${index}] ProviderOutput artifacts[${artifactIndex}] leaves the run directory`)
        continue
      }
      const relative = path.relative(root, candidate).split(path.sep).join('/')
      if (!isCanonicalEvidencePath(relative)) {
        errors.push(`runs[${index}] ProviderOutput artifacts[${artifactIndex}] is not a canonical evidence path`)
        continue
      }
      declaredArtifacts.push({ role: artifact.role ?? 'other', path: relative })
    }
    const boundArtifacts = run.artifacts
      .filter((artifact) => artifact.role !== 'grading')
      .map((artifact) => ({ role: artifact.role, path: artifact.path }))
    const sortArtifacts = (entries: Array<{ role: string; path: string }>) => [...entries]
      .sort((left, right) => identity([left.role, left.path]).localeCompare(identity([right.role, right.path])))
    if (stable(sortArtifacts(declaredArtifacts)) !== stable(sortArtifacts(boundArtifacts)))
      errors.push(`runs[${index}] ProviderOutput artifacts do not match provider-declared bundle artifacts`)
  } catch (error) {
    errors.push(`runs[${index}] ProviderOutput is unavailable or invalid: ${(error as Error).message}`)
  }
  return errors
}

async function capabilityEvidenceErrors(
  pathValue: string,
  bundle: RuntimeBundle,
): Promise<string[]> {
  try {
    const raw = await readFile(pathValue)
    if (sha256(raw) !== bundle.providerCapabilitiesDigest)
      return ['providerCapabilitiesDigest does not match the supplied capabilities evidence']
    const value = JSON.parse(raw.toString('utf8')) as unknown
    if (!record(value) || value.schemaVersion !== 2 || value.provider !== bundle.provider.id ||
      value.providerVersion !== bundle.provider.version) {
      return ['supplied capabilities evidence does not match bundle.provider']
    }
    return []
  } catch (error) {
    return [`provider capabilities evidence is unavailable or invalid: ${(error as Error).message}`]
  }
}

export async function validateEvalRunBundleRuntime(
  bundlePath: string,
  options: {
    evidenceRoot?: string
    providerCapabilitiesPath?: string
    schemaErrors?: string[]
  } = {},
): Promise<RuntimeBundleValidationResult> {
  let raw: Buffer
  try {
    raw = await readFile(bundlePath)
  } catch (error) {
    return { valid: false, errors: [`bundle is unavailable or invalid: ${(error as Error).message}`], calculated: null }
  }
  const digestCalculated: RuntimeBundleCalculated = { bundleDigest: sha256(raw) }
  if (options.schemaErrors && options.schemaErrors.length > 0)
    return { valid: false, errors: options.schemaErrors, calculated: digestCalculated }
  let bundle: RuntimeBundle
  try {
    bundle = JSON.parse(raw.toString('utf8')) as RuntimeBundle
  } catch (error) {
    return { valid: false, errors: [`bundle is unavailable or invalid: ${(error as Error).message}`], calculated: digestCalculated }
  }
  const errors: string[] = []
  const root = await realpath(options.evidenceRoot ?? path.dirname(path.resolve(bundlePath)))
  if (new Set(bundle.runtimeInputs.map((entry) => entry.id)).size !== bundle.runtimeInputs.length)
    errors.push('runtimeInputs ids must be unique')
  if (options.providerCapabilitiesPath)
    errors.push(...await capabilityEvidenceErrors(options.providerCapabilitiesPath, bundle))
  const runIdentities = new Set<string>()
  const gradingBoundRuns = new Set<string>()
  for (let index = 0; index < bundle.runs.length; index += 1) {
    const run = bundle.runs[index]!
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
      const artifact = run.artifacts[artifactIndex]!
      errors.push(...await evidenceErrors(root, artifact.path, artifact.digest, `runs[${index}].artifacts[${artifactIndex}].path`))
    }
    const gradingBinding = await gradingBindingErrors(root, run, index)
    errors.push(...gradingBinding.errors)
    if (gradingBinding.bound) gradingBoundRuns.add(runIdentity(run))
    errors.push(...await providerOutputBindingErrors(root, bundle, run, index))
  }
  const comparisons = comparisonAggregate(bundle.runs, gradingBoundRuns)
  const calculated: RuntimeBundleCalculated = {
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
  if (bundle.processManagement?.mode === 'managed' && bundle.processManagement.descendantCleanupGuaranteed !== true)
    errors.push('managed processManagement must guarantee descendant cleanup')
  if (bundle.processManagement && bundle.processManagement.mode !== 'managed' &&
    bundle.processManagement.descendantCleanupGuaranteed !== false)
    errors.push('observed processManagement must not guarantee descendant cleanup')
  if (bundle.processManagement && bundle.processManagement.mode !== 'managed' && !bundle.processManagement.limitation)
    errors.push('observed processManagement requires a limitation')
  if (bundle.processManagement?.limitation && !bundle.limitations.includes(bundle.processManagement.limitation))
    errors.push('processManagement limitation must be preserved in limitations')
  if (bundle.evidenceLevel === 'comparative' && bundle.evidenceRequirement?.satisfied !== false &&
    bundle.processManagement?.mode === 'observed')
    errors.push('accepted comparative evidence requires managed or verified-observed process management')
  if (bundle.evidenceLevel === 'comparative' && bundle.evidenceRequirement?.satisfied === true &&
    bundle.processManagement === undefined)
    errors.push('accepted comparative evidence requires processManagement evidence')
  if (comparisons.some((entry) => !entry.comparable) && bundle.limitations.length === 0)
    errors.push('non-comparable planned comparisons require a limitation')
  return { valid: errors.length === 0, errors, calculated }
}
