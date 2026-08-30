import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeEvalFileDigest,
  computeSkillDigest,
  parseSelectedCases,
  runEvalSpec,
  validateEvalAudit,
  type EvalAudit,
  type EvalSpec,
} from '../../dist/index.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

interface Fixture {
  root: string
  specPath: string
  auditPath: string
  spec: EvalSpec
  audit: EvalAudit
  target: string
}

async function fixture(options: {
  baseline?: 'without-skill' | 'previous-version'
  runs?: number
  caseCount?: number
} = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-phase3-'))
  roots.push(root)
  const target = path.join(root, 'targets', 'current')
  const previous = path.join(root, 'targets', 'previous')
  const subject = path.join(root, 'workspace', 'subject')
  const evalRoot = path.join(root, 'workspace', 'eval')
  await Promise.all([
    mkdir(target, { recursive: true }),
    mkdir(previous, { recursive: true }),
    mkdir(path.join(subject, '.agents', 'skills'), { recursive: true }),
    mkdir(evalRoot, { recursive: true }),
  ])
  await Promise.all([
    writeFile(path.join(target, 'SKILL.md'), 'current\n'),
    writeFile(path.join(target, 'references.md'), 'generated current reference\n'),
    writeFile(path.join(previous, 'SKILL.md'), 'previous\n'),
  ])
  const cases = {
    version: 1,
    suite: { kind: 'custom-process', unitUnderTest: 'fixture-skill' },
    cases: Array.from({ length: options.caseCount ?? 1 }, (_, index) => ({
      id: `case-${index + 1}`,
      split: 'validation',
      tags: ['release'],
      input: { prompt: `case ${index + 1}` },
      expected: { ok: true },
      assertions: ['returns ok'],
    })),
  }
  const casesPath = path.join(root, 'cases.json')
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`)
  const currentDigest = await computeSkillDigest(target)
  const previousDigest = await computeSkillDigest(previous)
  const spec: EvalSpec = {
    version: 1,
    source: { plugin: 'fixture-plugin', skill: 'fixture-skill', suite: 'suite', profile: 'project' },
    workspace: 'workspace',
    target: { path: 'targets/current', digest: currentDigest },
    cases: { path: 'cases.json', digest: await computeEvalFileDigest(casesPath) },
    provider: { type: 'custom-process', command: ['fixture-provider'] },
    runs: options.runs ?? 1,
    timeoutMs: 1_000,
    baseline: options.baseline === 'without-skill'
      ? { type: 'without-skill' }
      : options.baseline === 'previous-version'
        ? { type: 'previous-version', target: { path: 'targets/previous', digest: previousDigest } }
        : { type: 'none' },
    outputDir: 'output',
  }
  const specPath = path.join(root, 'spec.json')
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`)
  const audit: EvalAudit = {
    version: 1,
    targets: [
      { role: 'current', digest: currentDigest },
      ...(options.baseline === 'previous-version'
        ? [{ role: 'previous-version' as const, digest: previousDigest }]
        : []),
    ],
    caseDigest: spec.cases.digest,
    status: 'pass',
    approvedCaseIds: cases.cases.map((entry) => entry.id),
    blockedCases: [],
    issues: [],
  }
  const auditPath = path.join(root, 'audit.json')
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`)
  return { root, specPath, auditPath, spec, audit, target }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('EvalSpec v1 execution', () => {
  it('strictly parses selected case documents and rejects unknown executable shapes', () => {
    const canonical = parseSelectedCases({
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'fixture-skill',
        runtime: { observeSpawnAgent: true },
      },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: ['positive'],
        query: 'Use the fixture Skill.',
        expectedLoad: true,
        shouldSpawnAgent: false,
      }],
    })
    expect(canonical.cases[0]?.providerCase).toEqual({
      id: 'loads_skill',
      split: 'validation',
      tags: ['positive'],
      query: 'Use the fixture Skill.',
      should_load_skill: true,
      should_spawn_agent: false,
    })
    expect(JSON.stringify(canonical)).not.toContain('providerCase')
    for (const invalidCase of [{
      id: 'loads_skill', split: 'validation', tags: [], query: 'query',
      expectedLoad: true, expected: { loadedSkills: [] },
    }, {
      id: 'loads_skill', split: 'validation', tags: [], query: 'query',
      expected: { unknown: true },
    }, {
      id: 'bad-id', split: 'validation', tags: [], query: 'query', expectedLoad: true,
    }, {
      id: 'loads_skill', split: 'release', tags: [], query: 'query', expectedLoad: true,
    }]) {
      expect(() => parseSelectedCases({
        version: 1,
        suite: { kind: 'trigger', unitUnderTest: 'fixture-skill' },
        cases: [invalidCase],
      })).toThrow()
    }
    expect(() => parseSelectedCases({
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'fixture-skill',
        runtime: { observeSpawnAgent: true },
      },
      cases: [{
        id: 'loads_skill', split: 'validation', tags: [], query: 'query', expectedLoad: true,
      }],
    })).toThrow('should_spawn_agent is required')
    expect(() => parseSelectedCases({
      version: 1,
      suite: { kind: 'custom-process', unitUnderTest: 'fixture-skill' },
      cases: [{ id: 'case-1', split: 'validation', tags: [], command: ['unsafe'] }],
    })).toThrow('unknown field')
    expect(() => parseSelectedCases({
      version: 1,
      suite: { kind: 'custom-process', unitUnderTest: 'fixture-skill' },
      cases: [{ id: 'case-1', split: 'validation', tags: ['duplicate', 'duplicate'] }],
    })).toThrow('unique values')
  })

  it('never invokes a provider when Audit admission is absent or mismatched', async () => {
    const data = await fixture()
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runEvalSpec(data.specPath, {
      auditPath: path.join(data.root, 'missing-audit.json'),
      executeCustomProvider: execute,
    })).rejects.toThrow('does not admit execution')
    for (const audit of [
      { ...data.audit, status: 'fail' as const },
      { ...data.audit, targets: [{ role: 'current' as const, digest: data.spec.cases.digest }] },
      { ...data.audit, caseDigest: data.spec.target.digest },
      { ...data.audit, approvedCaseIds: [] },
    ]) {
      await writeFile(data.auditPath, `${JSON.stringify(audit, null, 2)}\n`)
      await expect(runEvalSpec(data.specPath, {
        auditPath: data.auditPath,
        executeCustomProvider: execute,
      })).rejects.toThrow('does not admit execution')
    }
    expect(execute).not.toHaveBeenCalled()
    await expect(readFile(path.join(data.root, 'output', 'result.json'))).rejects.toThrow()
    await expect(validateEvalAudit(data.audit, {
      spec: {
        ...data.spec,
        provider: 'codex-trigger',
        runs: 9,
        timeoutMs: 99_999,
      },
      selectedCaseIds: ['case-1'],
    })).resolves.toMatchObject({ valid: true })
  })

  it('passes the parser-approved trigger Oracle to the built-in provider unchanged', async () => {
    const data = await fixture()
    const casesPath = path.join(data.root, 'cases.json')
    const cases = {
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'fixture-skill',
        runtime: { observeSpawnAgent: true },
      },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: ['release'],
        input: {
          query: 'Use the fixture Skill.',
          expected: { loadedSkills: ['fixture-skill'] },
          shouldSpawnAgent: true,
        },
      }],
    }
    await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`)
    data.spec.cases.digest = await computeEvalFileDigest(casesPath)
    data.spec.provider = 'codex-trigger'
    await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
    data.audit.caseDigest = data.spec.cases.digest
    data.audit.approvedCaseIds = ['loads_skill']
    await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
    const runBuiltinProvider = vi.fn(async (_id, input: { case: Record<string, unknown> }) => ({
      usage: null,
      grade: { passed: true, score: 1 },
      observedCase: input.case,
    }))
    await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      runBuiltinProvider: runBuiltinProvider as never,
    })
    expect(runBuiltinProvider).toHaveBeenCalledWith('codex-trigger', expect.objectContaining({
      case: expect.objectContaining({
        value: {
          id: 'loads_skill',
          split: 'validation',
          tags: ['release'],
          query: 'Use the fixture Skill.',
          expected_loaded_skills: ['fixture-skill'],
          should_spawn_agent: true,
        },
      }),
    }), undefined)
  })

  it('exclusively claims outputRoot before provider execution and preserves existing content', async () => {
    const data = await fixture()
    const output = path.join(data.root, 'output')
    await mkdir(output)
    await writeFile(path.join(output, 'foreign.txt'), 'do not change\n')
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute,
    })).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(await readFile(path.join(output, 'foreign.txt'), 'utf8')).toBe('do not change\n')
    expect(await readdir(output)).toEqual(['foreign.txt'])
  })

  it('isolates current, without-skill, and previous-version variants and preserves source inputs', async () => {
    const without = await fixture({ baseline: 'without-skill' })
    const sourceDigest = await computeSkillDigest(without.target)
    const observed: Array<{ variant: string; content: string | null }> = []
    const secret = 'phase3-runner-secret'
    const execute = vi.fn(async ({ input }: { input: {
      variant: string
      workspacePath: string
    } }) => {
      const skillPath = path.join(input.workspacePath, '.agents', 'skills', 'fixture-skill', 'SKILL.md')
      const content = await readFile(skillPath, 'utf8').catch(() => null)
      observed.push({ variant: input.variant, content })
      return {
        usage: { inputTokens: 3, outputTokens: 2 },
        grade: {
          passed: input.variant === 'current',
          score: input.variant === 'current' ? 1 : 0,
          details: { secret },
        },
      }
    })
    const first = await runEvalSpec(without.specPath, {
      auditPath: without.auditPath,
      executeCustomProvider: execute as never,
      sourceEnv: { ...process.env, OPENAI_API_KEY: secret },
    })
    expect(observed).toEqual([
      { variant: 'current', content: 'current\n' },
      { variant: 'without-skill', content: null },
    ])
    expect(first.result.summary).toEqual({ passed: 1, failed: 1, timeout: 0, error: 0 })
    expect(first.result.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        caseId: 'case-1',
        attempt: 1,
        status: 'completed',
        usage: { inputTokens: 3, outputTokens: 2 },
      }),
    ]))
    expect(await computeSkillDigest(without.target)).toBe(sourceDigest)
    expect(await readFile(first.resultPath, 'utf8')).not.toContain(secret)
    expect(await readFile(path.join(
      without.root, first.result.runs[0]!.outputDir, 'provider-result.json',
    ), 'utf8')).not.toContain(secret)

    const previous = await fixture({ baseline: 'previous-version' })
    const previousObserved: string[] = []
    const second = await runEvalSpec(previous.specPath, {
      auditPath: previous.auditPath,
      executeCustomProvider: (async ({ input }: { input: { variant: string; workspacePath: string } }) => {
        previousObserved.push(await readFile(
          path.join(input.workspacePath, '.agents', 'skills', 'fixture-skill', 'SKILL.md'),
          'utf8',
        ))
        return { usage: null, grade: { passed: true, score: 1 } }
      }) as never,
    })
    expect(previousObserved).toEqual(['current\n', 'previous\n'])
    expect(second.result.runs.map((run) => run.variant)).toEqual(['current', 'previous-version'])
  })

  it('stops after timeout or bound-input mutation and still writes a valid diagnostic result', async () => {
    const timeout = await fixture({ runs: 3, caseCount: 2 })
    const timedOut = await runEvalSpec(timeout.specPath, {
      auditPath: timeout.auditPath,
      executeCustomProvider: (async () => { throw new Error('provider timed out after 1000ms') }) as never,
    })
    expect(timedOut.result.runs).toHaveLength(1)
    expect(timedOut.result.runs[0]).toMatchObject({ status: 'timeout', grade: null })
    expect(timedOut.result.summary.timeout).toBe(1)

    const changed = await fixture({ runs: 3 })
    const before = await computeSkillDigest(changed.target)
    const changedResult = await runEvalSpec(changed.specPath, {
      auditPath: changed.auditPath,
      executeCustomProvider: (async ({ input }: { input: { workspacePath: string } }) => {
        const attemptTarget = path.join(
          input.workspacePath,
          '.agents',
          'skills',
          'fixture-skill',
          'references.md',
        )
        expect(await readFile(attemptTarget, 'utf8')).toBe('generated current reference\n')
        await writeFile(path.join(changed.target, 'references.md'), 'changed generated reference\n')
        expect(await readFile(attemptTarget, 'utf8')).toBe('generated current reference\n')
        return { usage: null, grade: { passed: true, score: 1 } }
      }) as never,
    })
    expect(await computeSkillDigest(changed.target)).not.toBe(before)
    expect(changedResult.result.runs).toHaveLength(1)
    expect(changedResult.result.runs[0]).toMatchObject({ status: 'failed', grade: null })
    expect(changedResult.result.runs[0]?.error?.message).toContain('digest changed')

    const cleanup = await fixture({ runs: 3 })
    const cleanupResult = await runEvalSpec(cleanup.specPath, {
      auditPath: cleanup.auditPath,
      executeCustomProvider: (async () => {
        throw new Error('process-tree cleanup could not be confirmed')
      }) as never,
    })
    expect(cleanupResult.result.runs).toHaveLength(1)
    expect(cleanupResult.result.runs[0]).toMatchObject({ status: 'failed' })
  })

  it('supports the new validation and inspection CLI contract', async () => {
    const data = await fixture({ baseline: 'without-skill' })
    const result = await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: (async () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        grade: { passed: true, score: 1 },
      })) as never,
    })
    const bin = path.resolve('dist/bin.js')
    const specOutput = JSON.parse((await execFileAsync(process.execPath, [
      bin, 'spec', 'validate', data.specPath,
    ])).stdout) as { valid: boolean }
    expect(specOutput.valid).toBe(true)
    const auditOutput = JSON.parse((await execFileAsync(process.execPath, [
      bin, 'audit', 'validate', data.auditPath, '--spec', data.specPath,
    ])).stdout) as { valid: boolean }
    expect(auditOutput.valid).toBe(true)
    const resultOutput = JSON.parse((await execFileAsync(process.execPath, [
      bin, 'result', 'validate', result.resultPath,
      '--spec', data.specPath, '--audit', data.auditPath,
    ])).stdout) as { valid: boolean }
    expect(resultOutput.valid).toBe(true)
    const inspection = JSON.parse((await execFileAsync(process.execPath, [
      bin, 'inspect-result', result.resultPath,
    ])).stdout) as { groups: unknown[] }
    expect(inspection.groups).toEqual([expect.objectContaining({
      caseId: 'case-1',
      attempt: 1,
      variants: {
        current: expect.objectContaining({ status: 'completed' }),
        'without-skill': expect.objectContaining({ status: 'completed' }),
      },
    })])
  })
})
