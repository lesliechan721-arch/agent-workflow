import { stable } from './common.js'
import { readEvalContractFile } from './eval-file.js'
import type { EvalProvider } from './eval-spec.js'
import { validateJsonSchema } from './json-schema.js'
import { getSchema } from './schemas.js'
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
}

export interface EvalResultSummary {
  passed: number
  failed: number
  timeout: number
  error: number
}

export interface EvalResult {
  version: 1
  specDigest: Digest
  auditDigest: Digest
  targetDigest: Digest
  caseDigest: Digest
  provider: EvalProvider
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
}

export interface EvalResultFileCalculated {
  result: EvalResult
  resultDigest: Digest
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
  for (const [index, run] of result.runs.entries()) {
    if (run.status === 'completed' && run.grade === null)
      errors.push(`run ${index} is completed but has no grade`)
    if (run.status !== 'completed' && run.grade !== null)
      errors.push(`run ${index} has status ${run.status} but includes a grade`)
  }
  const summary = computeEvalResultSummary(result.runs)
  if (stable(summary) !== stable(result.summary)) errors.push('Result summary does not match runs')
  if (binding) {
    for (const key of ['specDigest', 'auditDigest', 'targetDigest', 'caseDigest'] as const) {
      if (result[key] !== binding[key]) errors.push(`Result ${key} does not match its binding`)
    }
    if (stable(result.provider) !== stable(binding.provider))
      errors.push('Result provider does not match its binding')
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
