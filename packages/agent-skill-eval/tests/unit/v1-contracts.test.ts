import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  computeEvalFileDigest,
  computeEvalResultSummary,
  computeSkillDigest,
  getSchema,
  parseEvalAudit,
  parseEvalResult,
  parseEvalSpec,
  validateEvalAudit,
  validateEvalAuditFile,
  validateEvalResult,
  validateEvalResultFile,
  validateEvalSpec,
  validateEvalSpecFile,
  validateJsonSchema,
} from '../../dist/index.js'
import type {
  Digest,
  EvalAudit,
  EvalResult,
  EvalResultBinding,
  EvalSpec,
} from '../../dist/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createSpecFixture(): Promise<{
  root: string
  spec: EvalSpec
  specPath: string
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eval-contract-v1-'))
  roots.push(root)
  await mkdir(path.join(root, 'workspace'))
  await mkdir(path.join(root, 'target'))
  await writeFile(path.join(root, 'target', 'SKILL.md'), '# Test\n')
  await writeFile(path.join(root, 'cases.json'), '[{"id":"case-1"},{"id":"case-2"}]\n')
  const spec: EvalSpec = {
    version: 1,
    source: { plugin: 'plugin', skill: 'skill', suite: 'suite', profile: 'profile' },
    workspace: 'workspace',
    target: { path: 'target', digest: await computeSkillDigest(path.join(root, 'target')) },
    cases: { path: 'cases.json', digest: await computeEvalFileDigest(path.join(root, 'cases.json')) },
    provider: 'codex-conversation',
    runs: 2,
    timeoutMs: 1_000,
    baseline: { type: 'without-skill' },
    outputDir: 'output',
  }
  const specPath = path.join(root, 'spec.json')
  await writeFile(specPath, JSON.stringify(spec))
  return { root, spec, specPath }
}

function validAudit(spec: EvalSpec): EvalAudit {
  return {
    version: 1,
    targets: [{ role: 'current', digest: spec.target.digest }],
    caseDigest: spec.cases.digest,
    status: 'pass',
    approvedCaseIds: ['case-1', 'case-2'],
    blockedCases: [],
    issues: [],
  }
}

function validResult(binding: EvalResultBinding): EvalResult {
  return {
    version: 1,
    specDigest: binding.specDigest,
    auditDigest: binding.auditDigest,
    targetDigest: binding.targetDigest,
    caseDigest: binding.caseDigest,
    provider: binding.provider,
    startedAt: '2026-08-30T00:00:00Z',
    finishedAt: '2026-08-30T00:00:01Z',
    runs: [
      {
        caseId: 'case-1',
        variant: 'current',
        attempt: 1,
        status: 'completed',
        durationMs: 10,
        outputDir: 'output/case-1/current/1',
        usage: { tokens: 1 },
        grade: { passed: true, score: 1, details: { reason: 'ok' } },
        error: null,
      },
      {
        caseId: 'case-2',
        variant: 'current',
        attempt: 1,
        status: 'completed',
        durationMs: 10,
        outputDir: 'output/case-2/current/1',
        usage: null,
        grade: { passed: false, score: null },
        error: null,
      },
      {
        caseId: 'case-1',
        variant: 'without-skill',
        attempt: 1,
        status: 'timeout',
        durationMs: 1_000,
        outputDir: 'output/case-1/without-skill/1',
        usage: null,
        grade: null,
        error: { message: 'timed out' },
      },
      {
        caseId: 'case-2',
        variant: 'without-skill',
        attempt: 1,
        status: 'failed',
        durationMs: 5,
        outputDir: 'output/case-2/without-skill/1',
        usage: null,
        grade: null,
        error: { message: 'provider failed' },
      },
    ],
    summary: { passed: 1, failed: 1, timeout: 1, error: 1 },
  }
}

describe('independent Eval v1 contracts', () => {
  it('exports canonical schemas and accepts valid strict contracts', async () => {
    const { spec, specPath } = await createSpecFixture()
    await expect(getSchema('eval-spec')).resolves.toMatchObject({ properties: { version: { const: 1 } } })
    await expect(getSchema('eval-audit')).resolves.toMatchObject({ properties: { version: { const: 1 } } })
    await expect(getSchema('eval-result')).resolves.toMatchObject({ properties: { version: { const: 1 } } })
    await expect(parseEvalSpec(spec)).resolves.toEqual(spec)
    const specValidation = await validateEvalSpecFile(specPath)
    expect(specValidation).toMatchObject({ valid: true, errors: [] })
    expect(specValidation.calculated?.specDigest).toBe(await computeEvalFileDigest(specPath))

    const audit = validAudit(spec)
    await expect(parseEvalAudit(audit)).resolves.toEqual(audit)
    await expect(validateEvalAudit(audit, { spec, selectedCaseIds: ['case-1', 'case-2'] }))
      .resolves.toMatchObject({ valid: true, errors: [] })

    const binding: EvalResultBinding = {
      specDigest: specValidation.calculated!.specDigest,
      auditDigest: spec.target.digest,
      targetDigest: spec.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: spec.runs,
    }
    const result = validResult(binding)
    await expect(parseEvalResult(result)).resolves.toEqual(result)
    await expect(validateEvalResult(result, binding)).resolves.toMatchObject({ valid: true, errors: [] })

    const root = path.dirname(specPath)
    await mkdir(path.join(root, 'previous'))
    await writeFile(path.join(root, 'previous', 'SKILL.md'), '# Previous\n')
    const previousSpec: EvalSpec = {
      ...spec,
      provider: { type: 'custom-process', command: ['provider', '--json'] },
      baseline: {
        type: 'previous-version',
        target: {
          path: 'previous',
          digest: await computeSkillDigest(path.join(root, 'previous')),
        },
      },
    }
    await writeFile(specPath, JSON.stringify(previousSpec))
    await expect(validateEvalSpecFile(specPath)).resolves.toMatchObject({ valid: true, errors: [] })
  })

  it('rejects unknown versions and additional properties at every new contract boundary', async () => {
    const { spec } = await createSpecFixture()
    await expect(validateEvalSpec({ ...spec, version: 2 })).resolves.toMatchObject({ valid: false })
    await expect(validateEvalSpec({ ...spec, unexpected: true })).resolves.toMatchObject({ valid: false })
    const audit = validAudit(spec)
    await expect(validateEvalAudit({ ...audit, version: 2 })).resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({ ...audit, unexpected: true })).resolves.toMatchObject({ valid: false })
    const binding: EvalResultBinding = {
      specDigest: spec.target.digest,
      auditDigest: spec.target.digest,
      targetDigest: spec.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: spec.runs,
    }
    const result = validResult(binding)
    await expect(validateEvalResult({ ...result, version: 2 })).resolves.toMatchObject({ valid: false })
    await expect(validateEvalResult({ ...result, unexpected: true })).resolves.toMatchObject({ valid: false })
  })

  it('rejects path escape, input symlinks, and symlinked output components', async () => {
    const fixture = await createSpecFixture()
    await writeFile(fixture.specPath, JSON.stringify({ ...fixture.spec, workspace: '../outside' }))
    await expect(validateEvalSpecFile(fixture.specPath)).resolves.toMatchObject({ valid: false })

    await symlink('target', path.join(fixture.root, 'linked-target'))
    await writeFile(fixture.specPath, JSON.stringify({
      ...fixture.spec,
      target: { ...fixture.spec.target, path: 'linked-target' },
    }))
    const linkedInput = await validateEvalSpecFile(fixture.specPath)
    expect(linkedInput.valid).toBe(false)
    expect(linkedInput.errors.join('\n')).toContain('symlink')

    await mkdir(path.join(fixture.root, 'real-output'))
    await symlink('real-output', path.join(fixture.root, 'linked-output'))
    await writeFile(fixture.specPath, JSON.stringify({ ...fixture.spec, outputDir: 'linked-output/runs' }))
    const linkedOutput = await validateEvalSpecFile(fixture.specPath)
    expect(linkedOutput.valid).toBe(false)
    expect(linkedOutput.errors.join('\n')).toContain('symlink')
  })

  it('keeps outputDir away from the Spec root, files, and every input tree', async () => {
    const fixture = await createSpecFixture()
    for (const outputDir of ['.', 'cases.json', 'target', 'target/output', 'workspace/output']) {
      await writeFile(fixture.specPath, JSON.stringify({ ...fixture.spec, outputDir }))
      const validation = await validateEvalSpecFile(fixture.specPath)
      expect(validation.valid, outputDir).toBe(false)
    }

    await mkdir(path.join(fixture.root, 'container', 'nested-target'), { recursive: true })
    await writeFile(path.join(fixture.root, 'container', 'nested-target', 'SKILL.md'), '# Nested\n')
    const nestedTargetSpec: EvalSpec = {
      ...fixture.spec,
      target: {
        path: 'container/nested-target',
        digest: await computeSkillDigest(path.join(fixture.root, 'container', 'nested-target')),
      },
      outputDir: 'container',
    }
    await writeFile(fixture.specPath, JSON.stringify(nestedTargetSpec))
    await expect(validateEvalSpecFile(fixture.specPath)).resolves.toMatchObject({ valid: false })

    await mkdir(path.join(fixture.root, 'previous'))
    await writeFile(path.join(fixture.root, 'previous', 'SKILL.md'), '# Previous\n')
    const previousSpec: EvalSpec = {
      ...fixture.spec,
      baseline: {
        type: 'previous-version',
        target: {
          path: 'previous',
          digest: await computeSkillDigest(path.join(fixture.root, 'previous')),
        },
      },
      outputDir: 'previous/output',
    }
    await writeFile(fixture.specPath, JSON.stringify(previousSpec))
    await expect(validateEvalSpecFile(fixture.specPath)).resolves.toMatchObject({ valid: false })
  })

  it('rejects non-finite JSON Schema numbers', () => {
    const schema = { type: 'number' }
    expect(validateJsonSchema(schema, 1.5)).toEqual([])
    expect(validateJsonSchema(schema, Number.NaN)).not.toEqual([])
    expect(validateJsonSchema(schema, Number.POSITIVE_INFINITY)).not.toEqual([])
    expect(validateJsonSchema(schema, Number.NEGATIVE_INFINITY)).not.toEqual([])
  })

  it('accepts RFC 3339 case variants and rejects nonexistent calendar dates', async () => {
    const { spec } = await createSpecFixture()
    const binding: EvalResultBinding = {
      specDigest: spec.target.digest,
      auditDigest: spec.target.digest,
      targetDigest: spec.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: spec.runs,
    }
    const result = validResult(binding)
    await expect(validateEvalResult({
      ...result,
      startedAt: '2024-02-29t00:00:00z',
      finishedAt: '2024-06-30T23:59:60Z',
    })).resolves.toMatchObject({ valid: true })
    await expect(validateEvalResult({
      ...result,
      startedAt: '2023-02-29T00:00:00Z',
    })).resolves.toMatchObject({ valid: false })
    await expect(validateEvalResult({
      ...result,
      finishedAt: '2024-04-31T00:00:00Z',
    })).resolves.toMatchObject({ valid: false })
  })

  it('enforces exact passing Audit admission for the bound Spec and selected cases', async () => {
    const { spec } = await createSpecFixture()
    const audit = validAudit(spec)
    const binding = { spec, selectedCaseIds: ['case-1', 'case-2'] }
    await expect(validateEvalAudit({ ...audit, caseDigest: spec.target.digest }, binding))
      .resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({ ...audit, status: 'fail' }, binding))
      .resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({ ...audit, status: 'unknown' }, binding))
      .resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({ ...audit, approvedCaseIds: ['case-1'] }, binding))
      .resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({
      ...audit,
      blockedCases: [{ caseId: 'case-2', reason: 'ambiguous oracle' }],
    }, binding)).resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({
      ...audit,
      targets: [{ role: 'current', digest: spec.cases.digest }],
    }, binding)).resolves.toMatchObject({ valid: false })
    const previousSpec: EvalSpec = {
      ...spec,
      baseline: { type: 'previous-version', target: { path: 'previous', digest: spec.cases.digest } },
    }
    await expect(validateEvalAudit(audit, {
      spec: previousSpec,
      selectedCaseIds: binding.selectedCaseIds,
    })).resolves.toMatchObject({ valid: false })
    await expect(validateEvalAudit({
      ...audit,
      targets: [
        ...audit.targets,
        { role: 'previous-version', digest: spec.cases.digest },
      ],
    }, {
      spec: previousSpec,
      selectedCaseIds: binding.selectedCaseIds,
    })).resolves.toMatchObject({ valid: true })
  })

  it('requires completed grades, forbids grades on execution failures, and recomputes summary', async () => {
    const { spec } = await createSpecFixture()
    const binding: EvalResultBinding = {
      specDigest: spec.target.digest,
      auditDigest: spec.target.digest,
      targetDigest: spec.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: spec.runs,
    }
    const result = validResult(binding)
    const completedWithoutGrade = structuredClone(result)
    completedWithoutGrade.runs[0]!.grade = null
    await expect(validateEvalResult(completedWithoutGrade)).resolves.toMatchObject({ valid: false })
    const failedWithGrade = structuredClone(result)
    failedWithGrade.runs[3]!.grade = { passed: false, score: 0 }
    await expect(validateEvalResult(failedWithGrade)).resolves.toMatchObject({ valid: false })
    await expect(validateEvalResult({
      ...result,
      summary: { ...result.summary, error: 0 },
    })).resolves.toMatchObject({ valid: false })
  })

  it('binds every observed run while accepting an early partial result', async () => {
    const { spec } = await createSpecFixture()
    const binding: EvalResultBinding = {
      specDigest: spec.target.digest,
      auditDigest: spec.target.digest,
      targetDigest: spec.target.digest,
      caseDigest: spec.cases.digest,
      provider: spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: spec.runs,
    }
    const result = validResult(binding)

    const unknownCase = structuredClone(result)
    unknownCase.runs[0]!.caseId = 'unknown-case'
    await expect(validateEvalResult(unknownCase, binding)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('caseId is not selected')]),
    })

    const disabledVariant = structuredClone(result)
    disabledVariant.runs[0]!.variant = 'previous-version'
    await expect(validateEvalResult(disabledVariant, binding)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('variant is not enabled')]),
    })

    const excessiveAttempt = structuredClone(result)
    excessiveAttempt.runs[0]!.attempt = spec.runs + 1
    await expect(validateEvalResult(excessiveAttempt, binding)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('attempt exceeds')]),
    })

    const duplicate = structuredClone(result)
    duplicate.runs.push(structuredClone(duplicate.runs[0]!))
    duplicate.summary = computeEvalResultSummary(duplicate.runs)
    await expect(validateEvalResult(duplicate, binding)).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('duplicates a case')]),
    })

    const earlyFailure = structuredClone(result)
    earlyFailure.runs = [{
      ...earlyFailure.runs[0]!,
      status: 'failed',
      usage: null,
      grade: null,
      error: { message: 'provider failed before later runs started' },
    }]
    earlyFailure.summary = computeEvalResultSummary(earlyFailure.runs)
    await expect(validateEvalResult(earlyFailure, binding)).resolves.toMatchObject({
      valid: true,
      errors: [],
    })
  })

  it('binds Audit and Result file digests without using the legacy case schema', async () => {
    const fixture = await createSpecFixture()
    const specValidation = await validateEvalSpecFile(fixture.specPath)
    const auditPath = path.join(fixture.root, 'audit.json')
    await writeFile(auditPath, JSON.stringify(validAudit(fixture.spec)))
    const auditValidation = await validateEvalAuditFile(auditPath, {
      spec: fixture.spec,
      selectedCaseIds: ['case-1', 'case-2'],
    })
    expect(auditValidation).toMatchObject({ valid: true })
    expect(auditValidation.calculated?.auditDigest).toBe(await computeEvalFileDigest(auditPath))

    const binding: EvalResultBinding = {
      specDigest: specValidation.calculated!.specDigest,
      auditDigest: auditValidation.calculated!.auditDigest,
      targetDigest: fixture.spec.target.digest,
      caseDigest: fixture.spec.cases.digest,
      provider: fixture.spec.provider,
      selectedCaseIds: ['case-1', 'case-2'],
      allowedVariants: ['current', 'without-skill'],
      runs: fixture.spec.runs,
    }
    const resultPath = path.join(fixture.root, 'result.json')
    await writeFile(resultPath, JSON.stringify(validResult(binding)))
    await expect(validateEvalResultFile(resultPath, binding)).resolves.toMatchObject({ valid: true })
    await expect(validateEvalResultFile(resultPath, { ...binding, auditDigest: fixture.spec.cases.digest }))
      .resolves.toMatchObject({ valid: false })
    await writeFile(path.join(fixture.root, 'cases.json'), '[{"id":"changed"}]\n')
    await expect(validateEvalSpecFile(fixture.specPath)).resolves.toMatchObject({ valid: false })
  })
})
