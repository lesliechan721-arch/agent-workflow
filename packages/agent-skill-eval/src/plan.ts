import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside, pathsOverlap, safeSegment, sha256, stable } from './common.js'
export { computeCaseCorpusDigest } from './corpus-digest.js'
import { validateJsonSchema } from './json-schema.js'
import {
  captureCanonicalDirectory,
  captureRuntimeSkill,
  type CapturedRuntimeSkill,
} from './runtime-skill.js'
import { getSchema } from './schemas.js'
import { assertSafeOutputPath } from './output-path.js'
import type { Digest, RuntimeCapabilities, ValidationResult } from './types.js'

export interface EvalConfiguration {
  id: string
  skillMode: 'with-skill' | 'without-skill' | 'previous-version'
  comparisonId: string | null
  skillPath?: string | null
  skillDigest?: Digest | null
  env?: Record<string, string>
}

export interface RuntimeInput {
  id: string
  kind: 'directory'
  path: string
  digest: Digest
}

export interface AwSkillEvalExecutionPlan {
  schemaVersion: 4
  planId: string
  minimumEvidenceLevel?: 'executed' | 'comparative'
  target: { name: string; path: string; digest: Digest }
  cases: { paths: string[]; corpusDigest: Digest }
  provider: {
    id: string
    command: string[]
    describeCommand: string[]
    cwd?: string | null
    env?: Record<string, string>
    capabilitiesPath: string
    capabilitiesDigest: Digest
    inheritEnvironment: boolean
    environmentAllowlist?: string[]
  }
  runtimeInputs: RuntimeInput[]
  configurations: EvalConfiguration[]
  runsPerCase: number
  timeoutMs: number
  outputRoot: string
  capture: { outputs: boolean; trace: boolean; timing: boolean; usage: boolean }
}

export interface EvalCase extends Record<string, unknown> {
  id?: string | number
}

export interface PlanCalculated {
  targetSkillDigest: Digest | null
  caseCorpusDigest: Digest | null
  capabilitiesDigest: Digest | null
  runtimeInputDigests: Record<string, Digest | null>
  configurationSkillDigests: Record<string, Digest | null>
}

export interface CapturedPlanFile {
  label: string
  requestedPath: string
  canonicalPath: string
  digest: Digest
  raw: string
}

export interface CapturedExecutionPlan {
  plan: AwSkillEvalExecutionPlan
  base: string
  outputRoot: string
  providerCwd: string | null
  planFile: CapturedPlanFile
  caseFiles: CapturedPlanFile[]
  capabilitiesFile: CapturedPlanFile
  cases: EvalCase[]
  capabilities: RuntimeCapabilities
  runtimeInputs: Map<string, CapturedRuntimeSkill>
  skills: Map<string, CapturedRuntimeSkill | null>
  boundSkills: Map<string, CapturedRuntimeSkill>
}

export interface CapturedExecutionPlanResult extends ValidationResult<PlanCalculated> {
  captured: CapturedExecutionPlan | null
}

export function casesFrom(document: unknown): EvalCase[] {
  if (Array.isArray(document)) return document as EvalCase[]
  if (document && typeof document === 'object') {
    const record = document as { cases?: unknown; evals?: unknown }
    if (Array.isArray(record.cases)) return record.cases as EvalCase[]
    if (Array.isArray(record.evals)) return record.evals as EvalCase[]
  }
  throw new Error('case document must be an array or contain cases/evals')
}

export function promptOf(evalCase: EvalCase): string {
  for (const key of ['query', 'prompt', 'input'] as const) {
    if (typeof evalCase[key] === 'string') return evalCase[key]
  }
  if (Array.isArray(evalCase.messages)) {
    const message = [...evalCase.messages].reverse().find((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const record = entry as Record<string, unknown>
      return record.role === 'user' && typeof record.content === 'string'
    }) as Record<string, unknown> | undefined
    if (typeof message?.content === 'string') return message.content
  }
  throw new Error(`case ${String(evalCase.id ?? '?')} has no prompt/query/input`)
}

async function readFencedJson<T>(
  base: string,
  value: string,
  label: string,
  outputRoot?: string,
): Promise<{ file: CapturedPlanFile; value: T }> {
  const candidate = path.resolve(base, value)
  const actual = await resolvePlanInputPath(base, value, label, 'file')
  if (outputRoot && isPathInside(outputRoot, actual))
    throw new Error(`${label} must not be inside outputRoot`)
  const raw = await readFile(actual, 'utf8')
  return {
    file: { label, requestedPath: candidate, canonicalPath: actual, digest: sha256(raw), raw },
    value: JSON.parse(raw) as T,
  }
}

async function resolvePlanInputPath(
  base: string,
  value: string,
  label: string,
  kind: 'file' | 'directory',
): Promise<string> {
  const candidate = path.resolve(base, value)
  if (!isPathInside(base, candidate)) throw new Error(`${label} leaves the plan directory`)
  const relative = path.relative(base, candidate)
  let current = base
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue
    current = path.join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error(`${label} cannot contain a symlink path component`)
  }
  const actual = await realpath(candidate)
  if (!isPathInside(base, actual)) throw new Error(`${label} leaves the plan directory`)
  const info = await lstat(actual)
  if (kind === 'file' && !info.isFile()) throw new Error(`${label} must be a regular file`)
  if (kind === 'directory' && !info.isDirectory()) throw new Error(`${label} must be a directory`)
  return actual
}

export async function captureAndValidateExecutionPlan(
  planPath: string,
): Promise<CapturedExecutionPlanResult> {
  const errors: string[] = []
  const calculated: PlanCalculated = {
    targetSkillDigest: null,
    caseCorpusDigest: null,
    capabilitiesDigest: null,
    runtimeInputDigests: {},
    configurationSkillDigests: {},
  }
  let plan: AwSkillEvalExecutionPlan
  let planFile: CapturedPlanFile
  try {
    const requestedPath = path.resolve(planPath)
    const info = await lstat(requestedPath)
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('execution plan must be a regular non-symlink file')
    const canonicalPath = await realpath(requestedPath)
    const raw = await readFile(canonicalPath, 'utf8')
    planFile = {
      label: 'execution plan',
      requestedPath,
      canonicalPath,
      digest: sha256(raw),
      raw,
    }
    const value = JSON.parse(raw) as unknown
    errors.push(...validateJsonSchema(await getSchema('aw-skill-eval-execution-plan'), value))
    if (errors.length > 0) return { valid: false, errors, calculated, captured: null }
    plan = value as AwSkillEvalExecutionPlan
  } catch (error) {
    return {
      valid: false,
      errors: [`plan is unavailable or invalid: ${(error as Error).message}`],
      calculated,
      captured: null,
    }
  }

  const base = await realpath(path.dirname(planFile.requestedPath))
  const outputRoot = path.resolve(base, plan.outputRoot)
  try {
    await assertSafeOutputPath(base, outputRoot)
  } catch (error) {
    errors.push(`outputRoot is unavailable or unsafe: ${(error as Error).message}`)
  }
  try {
    if (isPathInside(outputRoot, planFile.canonicalPath)) errors.push('execution plan must not be inside outputRoot')
  } catch (error) {
    errors.push(`execution plan path is unavailable or unsafe: ${(error as Error).message}`)
  }
  if (new Set(plan.configurations.map((entry) => entry.id)).size !== plan.configurations.length)
    errors.push('configuration ids must be unique')
  if (plan.configurations.some((entry) => !safeSegment(entry.id)))
    errors.push('configuration ids must be safe path segments')

  const comparisonGroups = new Map<string, EvalConfiguration[]>()
  for (const configuration of plan.configurations) {
    if (configuration.comparisonId === null) continue
    const group = comparisonGroups.get(configuration.comparisonId) ?? []
    group.push(configuration)
    comparisonGroups.set(configuration.comparisonId, group)
  }
  for (const [comparisonId, configurations] of comparisonGroups) {
    if (!configurations.some((entry) => entry.skillMode === 'with-skill'))
      errors.push(`${comparisonId} comparison requires a with-skill configuration`)
    if (!configurations.some((entry) => entry.skillMode !== 'with-skill'))
      errors.push(`${comparisonId} comparison requires a baseline configuration`)
  }
  if ((plan.minimumEvidenceLevel ?? 'executed') === 'comparative' && comparisonGroups.size === 0)
    errors.push('minimumEvidenceLevel comparative requires at least one comparison')

  let capabilities: RuntimeCapabilities | null = null
  let capabilitiesFile: CapturedPlanFile | null = null
  try {
    const loaded = await readFencedJson<RuntimeCapabilities>(
      base,
      plan.provider.capabilitiesPath,
      'capabilities path',
      outputRoot,
    )
    capabilitiesFile = loaded.file
    calculated.capabilitiesDigest = loaded.file.digest
    errors.push(...validateJsonSchema(await getSchema('eval-provider-capabilities'), loaded.value).map((entry) => `capabilities: ${entry}`))
    capabilities = loaded.value
    if (capabilities.provider !== plan.provider.id) errors.push('provider id does not match capability document')
    for (const configuration of plan.configurations) {
      if (configuration.skillMode === 'with-skill' && !capabilities.capabilities.skillPathExecution)
        errors.push('provider does not support with-skill execution')
      if (configuration.skillMode === 'without-skill' && !capabilities.capabilities.withoutSkillBaseline)
        errors.push('provider does not support without-skill baseline')
      if (configuration.skillMode === 'previous-version' && !capabilities.capabilities.previousVersionBaseline)
        errors.push('provider does not support previous-version baseline')
    }
    if (!plan.capture.outputs) errors.push('capture.outputs must be true for portable evidence')
    if (!plan.capture.timing) errors.push('capture.timing must be true for portable evidence')
    if (plan.capture.trace && !capabilities.capabilities.toolTrace)
      errors.push('provider does not support requested tool trace capture')
    if (plan.capture.usage && !capabilities.capabilities.tokenUsage)
      errors.push('provider does not support requested token usage capture')
  } catch (error) {
    errors.push(`provider capabilities are unavailable or invalid: ${(error as Error).message}`)
  }

  let targetSkill: CapturedRuntimeSkill | null = null
  const configurationRoots = new Map<string, string>()
  const capturedSkills = new Map<string, CapturedRuntimeSkill | null>()
  const boundSkills = new Map<string, CapturedRuntimeSkill>()
  try {
    const target = await resolvePlanInputPath(base, plan.target.path, 'target path', 'directory')
    targetSkill = await captureRuntimeSkill(target)
    if (!isPathInside(base, targetSkill.sourceRoot)) throw new Error('target path leaves the plan directory')
    calculated.targetSkillDigest = targetSkill.digest
    if (pathsOverlap(targetSkill.sourceRoot, outputRoot)) errors.push('outputRoot must not overlap the target Skill tree')
    configurationRoots.set('with-skill', targetSkill.sourceRoot)
    boundSkills.set('target', targetSkill)
  } catch (error) {
    errors.push(`target path is unavailable or unsafe: ${(error as Error).message}`)
  }

  for (const configuration of plan.configurations) {
    if (configuration.skillMode === 'with-skill' || configuration.skillMode === 'without-skill') {
      if (configuration.skillPath !== undefined && configuration.skillPath !== null)
        errors.push(`${configuration.id} must not set skillPath for ${configuration.skillMode}`)
      if (configuration.skillDigest !== undefined && configuration.skillDigest !== null)
        errors.push(`${configuration.id} must not set skillDigest for ${configuration.skillMode}`)
      calculated.configurationSkillDigests[configuration.id] = configuration.skillMode === 'with-skill'
        ? calculated.targetSkillDigest
        : null
      capturedSkills.set(configuration.id, configuration.skillMode === 'with-skill' ? targetSkill : null)
      continue
    }
    if (!configuration.skillPath || !configuration.skillDigest) {
      errors.push(`${configuration.id} previous-version requires skillPath and skillDigest`)
      continue
    }
    try {
      const previousPath = await resolvePlanInputPath(
        base,
        configuration.skillPath,
        `${configuration.id} previous-version path`,
        'directory',
      )
      const captured = await captureRuntimeSkill(previousPath)
      if (!isPathInside(base, captured.sourceRoot)) throw new Error('previous-version path leaves the plan directory')
      if (pathsOverlap(captured.sourceRoot, outputRoot)) throw new Error('previous-version path overlaps outputRoot')
      calculated.configurationSkillDigests[configuration.id] = captured.digest
      configurationRoots.set(configuration.id, captured.sourceRoot)
      capturedSkills.set(configuration.id, captured)
      boundSkills.set(configuration.id, captured)
      if (captured.digest !== configuration.skillDigest)
        errors.push(`${configuration.id} skillDigest does not match previous-version content`)
    } catch (error) {
      errors.push(`${configuration.id} previous-version path is unavailable or unsafe: ${(error as Error).message}`)
    }
  }

  const caseIds = new Set<string>()
  const caseFiles: CapturedPlanFile[] = []
  const capturedCases: EvalCase[] = []
  try {
    const canonicalDocuments: string[] = []
    const evalTypes = new Set<string>()
    for (const caseEntry of plan.cases.paths) {
      const loaded = await readFencedJson<unknown>(base, caseEntry, 'case path', outputRoot)
      caseFiles.push({ ...loaded.file, label: `case corpus file ${caseFiles.length + 1}` })
      canonicalDocuments.push(stable(loaded.value))
      for (const evalCase of casesFrom(loaded.value)) {
        const id = String(evalCase.id ?? '')
        if (!safeSegment(id) || caseIds.has(id)) throw new Error('case ids must be unique safe path segments')
        caseIds.add(id)
        evalTypes.add(String(evalCase.eval_type ?? evalCase.type ?? 'unknown'))
        capturedCases.push(evalCase)
      }
    }
    if (caseIds.size === 0) throw new Error('case corpus must contain at least one case')
    calculated.caseCorpusDigest = sha256(canonicalDocuments.sort().join('\n'))
    if (evalTypes.has('trigger') && capabilities && !capabilities.capabilities.triggerDiscovery)
      errors.push('provider does not support trigger discovery')
    if (evalTypes.has('conversation') && capabilities && !capabilities.capabilities.conversation)
      errors.push('provider does not support conversation execution')
  } catch (error) {
    errors.push(`case corpus is unavailable or invalid: ${(error as Error).message}`)
  }

  if (calculated.targetSkillDigest && calculated.targetSkillDigest !== plan.target.digest)
    errors.push('target digest does not match target content')
  if (calculated.caseCorpusDigest && calculated.caseCorpusDigest !== plan.cases.corpusDigest)
    errors.push('case corpus digest does not match case documents')
  if (calculated.capabilitiesDigest && calculated.capabilitiesDigest !== plan.provider.capabilitiesDigest)
    errors.push('capabilitiesDigest does not match capability document')
  const runtimeInputs = new Map<string, CapturedRuntimeSkill>()
  if (new Set(plan.runtimeInputs.map((entry) => entry.id)).size !== plan.runtimeInputs.length)
    errors.push('runtime input ids must be unique')
  for (const runtimeInput of plan.runtimeInputs) {
    try {
      const inputPath = await resolvePlanInputPath(
        base,
        runtimeInput.path,
        `runtime input ${runtimeInput.id}`,
        'directory',
      )
      const captured = await captureCanonicalDirectory(inputPath)
      calculated.runtimeInputDigests[runtimeInput.id] = captured.digest
      runtimeInputs.set(runtimeInput.id, captured)
      if (pathsOverlap(captured.sourceRoot, outputRoot))
        errors.push(`runtime input ${runtimeInput.id} must not overlap outputRoot`)
      if (captured.digest !== runtimeInput.digest)
        errors.push(`runtime input ${runtimeInput.id} digest does not match directory content`)
    } catch (error) {
      errors.push(`runtime input ${runtimeInput.id} is unavailable or unsafe: ${(error as Error).message}`)
    }
  }
  if (plan.provider.command.some((value) => value.includes('\0')))
    errors.push('provider command contains invalid argv')
  if (plan.provider.describeCommand.some((value) => value.includes('\0')))
    errors.push('provider describeCommand contains invalid argv')
  if (plan.provider.environmentAllowlist !== undefined) {
    if (new Set(plan.provider.environmentAllowlist).size !== plan.provider.environmentAllowlist.length)
      errors.push('provider environmentAllowlist entries must be unique')
    if (plan.provider.environmentAllowlist.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)))
      errors.push('provider environmentAllowlist contains an invalid environment variable name')
  }
  let providerCwd: string | null = null
  if (plan.provider.cwd !== null && plan.provider.cwd !== undefined) {
    try {
      providerCwd = await resolvePlanInputPath(base, plan.provider.cwd, 'provider cwd', 'directory')
      if (pathsOverlap(providerCwd, outputRoot)) errors.push('provider cwd must not overlap outputRoot')
      for (const [configurationId, skillRoot] of configurationRoots)
        if (pathsOverlap(skillRoot, providerCwd)) errors.push(`provider cwd must not overlap ${configurationId} Skill content`)
      for (const [id, runtimeInput] of runtimeInputs)
        if (pathsOverlap(runtimeInput.sourceRoot, providerCwd)) errors.push(`provider cwd must not overlap runtime input ${id}`)
    } catch (error) {
      errors.push(`provider cwd is unavailable or unsafe: ${(error as Error).message}`)
    }
  }
  if (errors.length > 0 || !capabilities || !capabilitiesFile || !targetSkill) {
    return { valid: false, errors, calculated, captured: null }
  }
  return {
    valid: true,
    errors,
    calculated,
    captured: {
      plan,
      base,
      outputRoot,
      providerCwd,
      planFile,
      caseFiles,
      capabilitiesFile: { ...capabilitiesFile, label: 'provider capabilities' },
      cases: capturedCases,
      capabilities,
      runtimeInputs,
      skills: capturedSkills,
      boundSkills,
    },
  }
}

export async function validateExecutionPlan(
  planPath: string,
): Promise<ValidationResult<PlanCalculated>> {
  const { captured: _captured, ...validation } = await captureAndValidateExecutionPlan(planPath)
  return validation
}
