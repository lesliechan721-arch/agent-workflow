import { stable } from './common.js'
import { readEvalContractFile } from './eval-file.js'
import type { EvalSpec } from './eval-spec.js'
import { validateJsonSchema } from './json-schema.js'
import { getSchema } from './schemas.js'
import type { Digest, ValidationResult } from './types.js'

export interface EvalAuditTarget {
  role: 'current' | 'previous-version'
  digest: Digest
}

export interface EvalAuditBlockedCase {
  caseId: string
  reason: string
}

export interface EvalAuditIssue {
  code: string
  message: string
  caseId?: string
}

export interface EvalAudit {
  version: 1
  targets: EvalAuditTarget[]
  caseDigest: Digest
  status: 'pass' | 'fail' | 'unknown'
  approvedCaseIds: string[]
  blockedCases: EvalAuditBlockedCase[]
  issues: EvalAuditIssue[]
}

export interface EvalAuditBinding {
  spec: EvalSpec
  selectedCaseIds: readonly string[]
}

export interface EvalAuditFileCalculated {
  audit: EvalAudit
  auditDigest: Digest
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function expectedTargets(spec: EvalSpec): EvalAuditTarget[] {
  const targets: EvalAuditTarget[] = [{ role: 'current', digest: spec.target.digest }]
  if (spec.baseline.type === 'previous-version')
    targets.push({ role: 'previous-version', digest: spec.baseline.target.digest })
  return targets
}

export async function validateEvalAudit(
  value: unknown,
  binding?: EvalAuditBinding,
): Promise<ValidationResult<EvalAudit>> {
  const errors = validateJsonSchema(await getSchema('eval-audit'), value)
  if (errors.length > 0) return { valid: false, errors, calculated: null }
  const audit = value as EvalAudit
  if (new Set(audit.targets.map((target) => target.role)).size !== audit.targets.length)
    errors.push('Audit target roles must be unique')
  if (binding) {
    if (new Set(binding.selectedCaseIds).size !== binding.selectedCaseIds.length)
      errors.push('selected case IDs must be unique')
    if (stable(audit.targets.slice().sort((left, right) => left.role.localeCompare(right.role))) !==
      stable(expectedTargets(binding.spec).sort((left, right) => left.role.localeCompare(right.role))))
      errors.push('Audit targets do not exactly match the bound EvalSpec')
    if (audit.caseDigest !== binding.spec.cases.digest)
      errors.push('Audit caseDigest does not match the bound EvalSpec')
    if (audit.status !== 'pass') errors.push(`Audit status is ${audit.status}; execution is blocked`)
    if (stable(sorted(audit.approvedCaseIds)) !== stable(sorted(binding.selectedCaseIds)))
      errors.push('Audit approvedCaseIds do not exactly match the selected case IDs')
    if (audit.blockedCases.length > 0) errors.push('Audit contains blocked cases')
  }
  return { valid: errors.length === 0, errors, calculated: errors.length === 0 ? audit : null }
}

export async function parseEvalAudit(value: unknown): Promise<EvalAudit> {
  const validation = await validateEvalAudit(value)
  if (!validation.valid || !validation.calculated) throw new Error(validation.errors.join('; '))
  return validation.calculated
}

export async function validateEvalAuditFile(
  auditPath: string,
  binding?: EvalAuditBinding,
): Promise<ValidationResult<EvalAuditFileCalculated>> {
  try {
    const file = await readEvalContractFile(auditPath, 'EvalAudit')
    const validation = await validateEvalAudit(file.value, binding)
    if (!validation.valid || !validation.calculated)
      return { valid: false, errors: validation.errors, calculated: null }
    return {
      valid: true,
      errors: [],
      calculated: { audit: validation.calculated, auditDigest: file.digest },
    }
  } catch (error) {
    return {
      valid: false,
      errors: [`EvalAudit is unavailable or invalid: ${(error as Error).message}`],
      calculated: null,
    }
  }
}
