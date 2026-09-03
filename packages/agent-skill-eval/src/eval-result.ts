import { stable } from './common.js'
import { readEvalContractFile } from './eval-file.js'
import type { EvalProvider, EvalSpec, EvalSpecCalculated } from './eval-spec.js'
import { validateJsonSchema } from './json-schema.js'
import { getSchema } from './schemas.js'
import type { SelectedCasesDocument } from './selected-cases.js'
import { assertEvalProviderSuiteKind } from './eval-suite-binding.js'
import type { Digest, ValidationResult } from './types.js'

export interface EvalGrade {
  passed: boolean
  score: number | null
  details?: Record<string, unknown>
}

export interface EvalRunError {
  message: string
}

export interface EvalResultRun {
  caseId: string
  variant: 'current' | 'without-skill' | 'previous-version'
  attempt: number
  status: 'completed' | 'failed' | 'timeout'
  durationMs: number
  outputDir: string
  usage: Record<string, unknown> | null
  grade: EvalGrade | null
  error: EvalRunError | null
  artifacts?: Array<{ path: string; role: string }>
}

export interface EvalResultSummary {
  passed: number
  failed: number
  timeout: number
  error: number
}

export type EvalResultProcessManagement = {
  mode: 'managed'
  inspectionAvailable: true
  userAcknowledged: false
  descendantCleanupGuaranteed: false
  limitation: string
} | {
  mode: 'unmanaged-confirmed'
  inspectionAvailable: false
  userAcknowledged: true
  descendantCleanupGuaranteed: false
  limitation: string
  diagnostic?: string
}

export interface EvalResult {
  version: 2
  specDigest: Digest
  auditDigest: Digest
  targetDigest: Digest
  caseDigest: Digest
  provider: EvalProvider
  processManagement: EvalResultProcessManagement
  startedAt: string
  finishedAt: string
  runs: EvalResultRun[]
  summary: EvalResultSummary
}

export interface EvalResultBinding {
  specDigest: Digest
  auditDigest: Digest
  targetDigest: Digest
  caseDigest: Digest
  provider: EvalProvider
  selectedCaseIds: readonly string[]
  allowedVariants: readonly EvalResultRun['variant'][]
  runs: number
}

export interface EvalResultFileCalculated {
  result: EvalResult
  resultDigest: Digest
}

export function evalResultVariantsForSpec(spec: EvalSpec): EvalResultRun['variant'][] {
  if (spec.baseline.type === 'without-skill') return ['current', 'without-skill']
  if (spec.baseline.type === 'previous-version') return ['current', 'previous-version']
  return ['current']
}

export function createEvalResultBinding(
  calculated: EvalSpecCalculated,
  auditDigest: Digest,
  selectedCases: Pick<SelectedCasesDocument, 'cases' | 'suite'>,
): EvalResultBinding {
  assertEvalProviderSuiteKind(calculated.spec.provider, selectedCases.suite.kind)
  return {
    specDigest: calculated.specDigest,
    auditDigest,
    targetDigest: calculated.targetDigest,
    caseDigest: calculated.caseDigest,
    provider: calculated.spec.provider,
    selectedCaseIds: selectedCases.cases.map((entry) => entry.id),
    allowedVariants: evalResultVariantsForSpec(calculated.spec),
    runs: calculated.spec.runs,
  }
}

export function computeEvalResultSummary(runs: readonly EvalResultRun[]): EvalResultSummary {
  const summary: EvalResultSummary = { passed: 0, failed: 0, timeout: 0, error: 0 }
  for (const run of runs) {
    if (run.status === 'timeout') summary.timeout += 1
    else if (run.status === 'failed') summary.error += 1
    else if (run.grade?.passed) summary.passed += 1
    else summary.failed += 1
  }
  return summary
}

export async function validateEvalResult(
  value: unknown,
  binding?: EvalResultBinding,
): Promise<ValidationResult<EvalResult>> {
  const errors = validateJsonSchema(await getSchema('eval-result'), value)
  if (errors.length > 0) return { valid: false, errors, calculated: null }
  const result = value as EvalResult
  const leapSecond = /:60(?=(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$)/iu
  const timestamp = (value: string): number => {
    const leap = leapSecond.test(value)
    const parsed = Date.parse(leap ? value.replace(leapSecond, ':59') : value)
    return leap ? parsed + 1_000 : parsed
  }
  if (timestamp(result.finishedAt) < timestamp(result.startedAt))
    errors.push('Result finishedAt must not be earlier than startedAt')
  for (const [index, run] of result.runs.entries()) {
    if (run.status === 'completed') {
      if (run.grade === null) errors.push(`run ${index} is completed but has no grade`)
      if (run.error !== null) errors.push(`run ${index} is completed but includes an error`)
    } else {
      if (run.grade !== null) errors.push(`run ${index} has status ${run.status} but includes a grade`)
      if (run.error === null) errors.push(`run ${index} has status ${run.status} but has no error`)
    }
    if (
      typeof result.provider === 'object'
      && result.provider.type === 'codex-workflow'
      && run.status === 'completed'
    ) {
      if (run.usage === null) errors.push(`run ${index} codex-workflow has no usage evidence`)
      const expected = [
        { path: 'workflow-evidence.json', role: 'evidence' },
        { path: 'workflow-trace.json', role: 'trace' },
        { path: 'model-output.txt', role: 'output' },
        { path: 'provider-result.json', role: 'result' },
      ]
      if (
        !run.artifacts
        || stable([...run.artifacts].sort((left, right) => left.path.localeCompare(right.path)))
          !== stable(expected.sort((left, right) => left.path.localeCompare(right.path)))
      ) errors.push(`run ${index} codex-workflow artifacts are incomplete`)
    } else if (run.artifacts !== undefined) {
      errors.push(`run ${index} must not include codex-workflow artifacts`)
    }
  }
  const summary = computeEvalResultSummary(result.runs)
  if (stable(summary) !== stable(result.summary)) errors.push('Result summary does not match runs')
  if (binding) {
    for (const key of ['specDigest', 'auditDigest', 'targetDigest', 'caseDigest'] as const) {
      if (result[key] !== binding[key]) errors.push(`Result ${key} does not match its binding`)
    }
    if (stable(result.provider) !== stable(binding.provider))
      errors.push('Result provider does not match its binding')
    const selectedCaseIds = new Set(binding.selectedCaseIds)
    const allowedVariants = new Set(binding.allowedVariants)
    const observedRuns = new Set<string>()
    for (const [index, run] of result.runs.entries()) {
      if (!selectedCaseIds.has(run.caseId)) {
        errors.push(`run ${index} caseId is not selected by its binding`)
      }
      if (!allowedVariants.has(run.variant)) {
        errors.push(`run ${index} variant is not enabled by its binding`)
      }
      if (run.attempt > binding.runs) {
        errors.push(`run ${index} attempt exceeds its binding`)
      }
      const identity = JSON.stringify([run.caseId, run.variant, run.attempt])
      if (observedRuns.has(identity)) {
        errors.push(`run ${index} duplicates a case, variant, and attempt tuple`)
      }
      observedRuns.add(identity)
    }
  }
  return { valid: errors.length === 0, errors, calculated: errors.length === 0 ? result : null }
}

export async function parseEvalResult(value: unknown): Promise<EvalResult> {
  const validation = await validateEvalResult(value)
  if (!validation.valid || !validation.calculated) throw new Error(validation.errors.join('; '))
  return validation.calculated
}

export async function validateEvalResultFile(
  resultPath: string,
  binding?: EvalResultBinding,
): Promise<ValidationResult<EvalResultFileCalculated>> {
  try {
    const file = await readEvalContractFile(resultPath, 'EvalResult')
    const validation = await validateEvalResult(file.value, binding)
    if (!validation.valid || !validation.calculated)
      return { valid: false, errors: validation.errors, calculated: null }
    return {
      valid: true,
      errors: [],
      calculated: { result: validation.calculated, resultDigest: file.digest },
    }
  } catch (error) {
    return {
      valid: false,
      errors: [`EvalResult is unavailable or invalid: ${(error as Error).message}`],
      calculated: null,
    }
  }
}
