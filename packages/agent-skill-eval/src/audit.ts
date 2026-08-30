import { lstat, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { CapturedExecutionPlan } from './plan.js'
import { validateAuditResult } from './schemas.js'
import type { Digest } from './types.js'

interface EvalAuditCase {
  caseId: string
  admission: 'pass' | 'unknown' | 'fail'
}

interface EvalAuditResult {
  schemaVersion: 3
  independentContext: boolean
  mode: 'preflight' | 'result-triage'
  targetSkillDigest: Digest
  caseCorpusDigest: Digest
  runBundleDigest: Digest | null
  validity: 'pass' | 'unknown' | 'fail'
  cases: EvalAuditCase[]
  blockedCases: string[]
  failureTriage: unknown[]
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

async function loadAudit(auditPath: string): Promise<EvalAuditResult> {
  const requestedPath = path.resolve(auditPath)
  const info = await lstat(requestedPath)
  if (info.isSymbolicLink() || !info.isFile())
    throw new Error('Audit must be a regular non-symlink file')
  const actualPath = await realpath(requestedPath)
  const value = JSON.parse(await readFile(actualPath, 'utf8')) as unknown
  const validation = await validateAuditResult<EvalAuditResult>(value)
  if (!validation.valid || !validation.calculated) {
    throw new Error(validation.errors.join('; '))
  }
  return validation.calculated
}

export async function validateExecutionAudits(
  captured: CapturedExecutionPlan,
  auditPaths: string[],
): Promise<void> {
  if (auditPaths.length === 0) {
    throw new Error('Eval execution requires at least one preflight Audit')
  }
  const selectedCaseIds = sorted(captured.cases.map((evalCase) => String(evalCase.id)))
  const requiredSkillDigests = new Set(
    [...captured.boundSkills.values()].map((skill) => skill.digest),
  )
  const auditBySkillDigest = new Map<Digest, string>()
  const errors: string[] = []
  for (const auditPath of auditPaths) {
    let audit: EvalAuditResult
    try {
      audit = await loadAudit(auditPath)
    } catch (error) {
      errors.push(`Invalid EvalAuditResult ${auditPath}: ${(error as Error).message}`)
      continue
    }
    if (!requiredSkillDigests.has(audit.targetSkillDigest)) {
      errors.push(`Audit ${auditPath} is not bound to a captured Skill digest`)
      continue
    }
    const prior = auditBySkillDigest.get(audit.targetSkillDigest)
    if (prior) {
      errors.push(
        `Duplicate or conflicting Audit binding for Skill ${audit.targetSkillDigest}: ${prior}, ${auditPath}`,
      )
      continue
    }
    auditBySkillDigest.set(audit.targetSkillDigest, auditPath)
    if (!audit.independentContext)
      errors.push(`Audit ${auditPath} did not come from an independent context`)
    if (audit.mode !== 'preflight') errors.push(`Audit ${auditPath} is not preflight`)
    if (audit.runBundleDigest !== null)
      errors.push(`Preflight Audit ${auditPath} must use runBundleDigest=null`)
    if (audit.validity !== 'pass')
      errors.push(`Audit ${auditPath} validity is ${audit.validity}; execution is blocked`)
    if (audit.caseCorpusDigest !== captured.plan.cases.corpusDigest)
      errors.push(`Audit ${auditPath} caseCorpusDigest does not match the selected corpus`)
    if (audit.blockedCases.length > 0)
      errors.push(`Audit ${auditPath} contains blocked cases: ${audit.blockedCases.join(', ')}`)
    if (audit.failureTriage.length > 0)
      errors.push(`Preflight Audit ${auditPath} must not contain result triage`)
    const auditCaseIds = audit.cases.map((entry) => entry.caseId)
    if (new Set(auditCaseIds).size !== auditCaseIds.length) {
      errors.push(`Audit ${auditPath} contains duplicate case admissions`)
    }
    if (JSON.stringify(sorted(auditCaseIds)) !== JSON.stringify(selectedCaseIds)) {
      errors.push(`Audit ${auditPath} cases do not exactly cover the selected case IDs`)
    }
    for (const entry of audit.cases) {
      if (entry.admission !== 'pass')
        errors.push(`Case ${entry.caseId} does not have passing Audit admission in ${auditPath}`)
    }
  }
  for (const digest of requiredSkillDigests) {
    if (!auditBySkillDigest.has(digest))
      errors.push(`Captured Skill ${digest} has no independent passing preflight Audit`)
  }
  if (errors.length > 0) throw new Error(`Eval Audit gate failed:\n${errors.join('\n')}`)
}
