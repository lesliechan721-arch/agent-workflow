import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { isPathInside, pathsOverlap, safeSegment, sha256, stable } from './common.js'
import { validateJsonSchema } from './json-schema.js'
import { captureRuntimeSkill, type CapturedRuntimeSkill } from './runtime-skill.js'
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

export interface EvalExecutionPlan {
  schemaVersion: 2
  planId: string
  target: { name: string; path: string; digest: Digest }
  cases: { paths: string[]; corpusDigest: Digest }
  audit: {
    path: string
    digest: Digest
    targetSkillDigest: Digest
    caseCorpusDigest: Digest
    validity: 'pass'
  }
  provider: {
    id: string
    command: string[]
    cwd?: string | null
    env?: Record<string, string>
    capabilitiesPath: string
    capabilitiesDigest: Digest
    inheritEnvironment: boolean
  }
  configurations: EvalConfiguration[]
  runsPerCase: number
  timeoutMs: number
  outputRoot: string
  capture: { outputs: boolean; trace: boolean; timing: boolean; usage: boolean }
}

export interface EvalCase extends Record<string, unknown> {
  id?: string | number
}

interface AuditCase {
  caseId: string
  releaseRelevant: boolean
  admission: 'pass' | 'unknown' | 'fail'
}

interface AuditResult {
  validity: 'pass' | 'unknown' | 'fail'
  mode: 'preflight' | 'result-triage'
  independentContext: boolean
  failureTriage: Array<{ attribution: string }>
  cases: AuditCase[]
  blockedCases: string[]
  releaseEligible: boolean
  recommendedAction: string
  targetSkillDigest: Digest
  caseCorpusDigest: Digest
}

export interface PlanCalculated {
  targetSkillDigest: Digest | null
  caseCorpusDigest: Digest | null
  auditDigest: Digest | null
  capabilitiesDigest: Digest | null
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
  plan: EvalExecutionPlan
  base: string
  outputRoot: string
  planFile: CapturedPlanFile
  caseFiles: CapturedPlanFile[]
  auditFile: CapturedPlanFile
  capabilitiesFile: CapturedPlanFile
  cases: EvalCase[]
  capabilities: RuntimeCapabilities
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

export async function computeCaseCorpusDigest(casePaths: string[]): Promise<Digest> {
  const documents = await Promise.all(
    casePaths.map(async (filePath) => stable(JSON.parse(await readFile(filePath, 'utf8')))),
  )
  documents.sort()
  return sha256(documents.join('\n'))
}

async function readFencedJson<T>(
  base: string,
  value: string,
  label: string,
  outputRoot?: string,
): Promise<{ file: CapturedPlanFile; value: T }> {
  const candidate = path.resolve(base, value)
  const actual = await realpath(candidate)
  if (!isPathInside(base, actual)) throw new Error(`${label} leaves the plan directory`)
  if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`${label} cannot be a symlink`)
  if (outputRoot && isPathInside(outputRoot, actual))
    throw new Error(`${label} must not be inside outputRoot`)
  const raw = await readFile(actual, 'utf8')
  return {
    file: { label, requestedPath: candidate, canonicalPath: actual, digest: sha256(raw), raw },
    value: JSON.parse(raw) as T,
  }
}

export async function captureAndValidateExecutionPlan(
  planPath: string,
): Promise<CapturedExecutionPlanResult> {
  const errors: string[] = []
  const calculated: PlanCalculated = {
    targetSkillDigest: null,
    caseCorpusDigest: null,
    auditDigest: null,
    capabilitiesDigest: null,
    configurationSkillDigests: {},
  }
  let plan: EvalExecutionPlan
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
    errors.push(...validateJsonSchema(await getSchema('eval-execution-plan'), value))
    if (errors.length > 0) return { valid: false, errors, calculated, captured: null }
    plan = value as EvalExecutionPlan
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
    errors.push(...validateJsonSchema(await getSchema('eval-runtime-capabilities'), loaded.value).map((entry) => `capabilities: ${entry}`))
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
    const target = path.resolve(base, plan.target.path)
    if ((await lstat(target)).isSymbolicLink()) throw new Error('symlink')
    targetSkill = await captureRuntimeSkill(target)
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
      const previousPath = path.resolve(base, configuration.skillPath)
      if ((await lstat(previousPath)).isSymbolicLink()) throw new Error('symlink')
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
  } catch (error) {
    errors.push(`case corpus is unavailable or invalid: ${(error as Error).message}`)
  }

  let auditFile: CapturedPlanFile | null = null
  try {
    const loaded = await readFencedJson<AuditResult>(base, plan.audit.path, 'audit path', outputRoot)
    auditFile = { ...loaded.file, label: 'preflight audit' }
    calculated.auditDigest = loaded.file.digest
    errors.push(...validateJsonSchema(await getSchema('eval-audit-result'), loaded.value).map((entry) => `audit: ${entry}`))
    const audit = loaded.value
    if (audit.validity !== 'pass') errors.push('audit validity must be pass')
    if (audit.mode !== 'preflight') errors.push('plan requires a preflight audit')
    if (!audit.independentContext) errors.push('audit validity=pass requires independentContext=true')
    if (audit.failureTriage.length > 0) errors.push('preflight audit must not contain failureTriage entries')
    if (audit.cases.length === 0) errors.push('audit validity=pass requires audited cases')
    const auditCases = new Map<string, AuditCase>()
    for (const entry of audit.cases) {
      if (auditCases.has(entry.caseId)) errors.push(`audit case ${entry.caseId} is duplicated`)
      auditCases.set(entry.caseId, entry)
    }
    for (const caseId of caseIds)
      if (auditCases.get(caseId)?.admission !== 'pass') errors.push(`plan case ${caseId} requires passing audit admission`)
    if (audit.cases.some((entry) => entry.releaseRelevant && entry.admission !== 'pass'))
      errors.push('audit validity=pass requires every release-relevant case to pass admission')
    if (audit.blockedCases.length > 0) errors.push('audit validity=pass requires no blocked cases')
    if (audit.releaseEligible && !audit.cases.some((entry) => entry.releaseRelevant))
      errors.push('releaseEligible=true requires release-relevant cases')
    if (audit.recommendedAction === 'candidate-skill-fix' && !audit.failureTriage.some((entry) => entry.attribution === 'skill-defect'))
      errors.push('candidate-skill-fix requires skill-defect triage evidence')
    if (audit.targetSkillDigest !== plan.audit.targetSkillDigest || audit.targetSkillDigest !== plan.target.digest)
      errors.push('audit targetSkillDigest does not bind the plan target')
    if (audit.caseCorpusDigest !== plan.audit.caseCorpusDigest || audit.caseCorpusDigest !== plan.cases.corpusDigest)
      errors.push('audit caseCorpusDigest does not bind the plan corpus')
  } catch (error) {
    errors.push(`audit is unavailable or invalid: ${(error as Error).message}`)
  }

  if (calculated.targetSkillDigest && calculated.targetSkillDigest !== plan.target.digest)
    errors.push('target digest does not match target content')
  if (calculated.caseCorpusDigest && calculated.caseCorpusDigest !== plan.cases.corpusDigest)
    errors.push('case corpus digest does not match case documents')
  if (calculated.auditDigest && calculated.auditDigest !== plan.audit.digest)
    errors.push('audit digest does not match audit document')
  if (calculated.capabilitiesDigest && calculated.capabilitiesDigest !== plan.provider.capabilitiesDigest)
    errors.push('capabilitiesDigest does not match capability document')
  if (plan.provider.command.some((value) => value.includes('\0')))
    errors.push('provider command contains invalid argv')
  if (plan.provider.cwd !== null && plan.provider.cwd !== undefined) {
    const providerCwd = path.resolve(base, plan.provider.cwd)
    if (!isPathInside(base, providerCwd)) errors.push('provider cwd must stay inside the plan directory')
    for (const [configurationId, skillRoot] of configurationRoots)
      if (pathsOverlap(skillRoot, providerCwd)) errors.push(`provider cwd must not overlap ${configurationId} Skill content`)
  }
  if (errors.length > 0 || !capabilities || !capabilitiesFile || !auditFile || !targetSkill) {
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
      planFile,
      caseFiles,
      auditFile,
      capabilitiesFile: { ...capabilitiesFile, label: 'provider capabilities' },
      cases: capturedCases,
      capabilities,
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
