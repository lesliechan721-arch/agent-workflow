import { readFile } from 'node:fs/promises'
import {
  comparisonAggregate as runtimeComparisonAggregate,
  validateEvalRunBundleRuntime,
} from './bundle-validation-runtime.js'
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
  schemaVersion: 4
  runner: { id: string; version: string }
  independentContext: boolean
  provider: { id: string; version: string }
  providerCapabilitiesDigest: Digest
  planDigest: Digest
  targetSkillDigest: Digest
  caseCorpusDigest: Digest
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

export function comparisonAggregate(
  runs: EvalRun[],
  gradingBoundRuns?: Set<string>,
): ComparisonAggregate[] {
  return runtimeComparisonAggregate(runs, gradingBoundRuns)
}

export async function validateRunBundle(
  bundlePath: string,
  options: { evidenceRoot?: string; providerCapabilitiesPath?: string } = {},
): Promise<ValidationResult<BundleCalculated>> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(bundlePath, 'utf8')) as unknown
  } catch (error) {
    return { valid: false, errors: [`bundle is unavailable or invalid: ${(error as Error).message}`], calculated: null }
  }
  const schemaErrors = validateJsonSchema(await getSchema('eval-run-bundle'), value)
  const result = await validateEvalRunBundleRuntime(bundlePath, { ...options, schemaErrors })
  return result as ValidationResult<BundleCalculated>
}
