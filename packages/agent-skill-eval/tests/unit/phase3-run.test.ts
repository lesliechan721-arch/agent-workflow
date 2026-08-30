import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  computeEvalFileDigest,
  computeSkillDigest,
  normalizeConversationProviderCase,
  parseSelectedCases,
  runEvalSpec,
  validateEvalAudit,
  type EvalAudit,
  type EvalSpec,
} from '../../dist/index.js'
import { adaptConversationProviderCase } from '../../dist/eval-run.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []

async function evalManifestPaths(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(entryPath)
      else if (entry.name === 'manifest.json' && path.basename(directory) === 'evals') {
        result.push(entryPath)
      }
    }
  }
  await walk(root)
  return result.sort()
}

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
        input: {
          query: 'Use the fixture Skill.',
          expectedLoad: true,
          shouldSpawnAgent: false,
        },
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
      id: 'loads_skill', split: 'validation', tags: [], input: { query: 'query',
        expectedLoad: true, expected: { loadedSkills: [] } },
    }, {
      id: 'loads_skill', split: 'validation', tags: [], input: { query: 'query',
        expected: { unknown: true } },
    }, {
      id: 'bad-id', split: 'validation', tags: [], input: { query: 'query', expectedLoad: true },
    }, {
      id: 'loads_skill', split: 'release', tags: [], input: { query: 'query', expectedLoad: true },
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
        id: 'loads_skill', split: 'validation', tags: [],
        input: { query: 'query', expectedLoad: true },
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

  it('requires only the audit fields selected by case tags', () => {
    const base = {
      version: 1 as const,
      suite: { kind: 'custom-process' as const, unitUnderTest: 'fixture-skill' },
    }
    expect(parseSelectedCases({
      ...base,
      cases: [{ id: 'ordinary', split: 'validation', tags: [], input: {} }],
    }).cases[0]?.audit).toBeUndefined()
    expect(parseSelectedCases({
      ...base,
      cases: [{
        id: 'guarded',
        split: 'validation',
        tags: ['boundary', 'release-critical', 'high-variance'],
        audit: {
          rationale: 'This case protects the routing boundary.',
          minimalCounterexample: 'Remove the explicit request.',
          errorCost: 'high',
          allowedVariance: 'Wording can differ.',
        },
      }],
    }).cases[0]?.audit).toEqual({
      rationale: 'This case protects the routing boundary.',
      minimalCounterexample: 'Remove the explicit request.',
      errorCost: 'high',
      allowedVariance: 'Wording can differ.',
    })
    for (const invalidCase of [{
      id: 'boundary', split: 'validation', tags: ['boundary'],
      audit: { rationale: 'reason' },
    }, {
      id: 'cost', split: 'validation', tags: ['high-cost'], audit: { errorCost: 'severe' },
    }, {
      id: 'variance', split: 'validation', tags: ['high-variance'],
      audit: { allowedVariance: { prose: true } },
    }, {
      id: 'legacy', split: 'validation', tags: [], audit: { decision_context: 'legacy' },
    }]) {
      expect(() => parseSelectedCases({ ...base, cases: [invalidCase] })).toThrow()
    }
  })

  it('accepts only finite minimum pass rates from zero through one', () => {
    for (const minimumPassRate of [0, 1]) {
      expect(parseSelectedCases({
        version: 1,
        suite: {
          kind: 'custom-process',
          unitUnderTest: 'fixture-skill',
          runtime: { minimumPassRate },
        },
        cases: [{ id: 'case-1', split: 'validation', tags: [] }],
      }).suite.runtime).toEqual({ minimumPassRate })
    }
    for (const minimumPassRate of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseSelectedCases({
        version: 1,
        suite: {
          kind: 'conversation',
          unitUnderTest: 'fixture-skill',
          runtime: { minimumPassRate },
        },
        cases: [{
          id: 'case-1', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Returns the result.'],
        }],
      })).toThrow('finite number from 0 to 1')
    }
  })

  it('rejects non-normalized paths in selected case contracts', () => {
    const trigger = (fixture: string, workspaceFixture = 'workspaces/basic') => ({
      version: 1,
      suite: {
        kind: 'trigger', unitUnderTest: 'fixture-skill', runtime: { fixture },
      },
      cases: [{
        id: 'loads_skill', split: 'validation', tags: [],
        input: { query: 'query', expectedLoad: true, workspaceFixture },
      }],
    })
    for (const value of [
      trigger('../fixture.mjs'),
      trigger('fixture.mjs', './workspace'),
      {
        version: 1,
        suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
        cases: [{
          id: 'conversation', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Creates the result.'],
          input: { workspaceFiles: { '../outside.txt': 'unsafe' } },
        }],
      },
      {
        version: 1,
        suite: {
          kind: 'conversation', unitUnderTest: 'fixture-skill',
          runtime: { pathPrepend: ['/host/bin'] },
        },
        cases: [{
          id: 'conversation', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Creates the result.'],
        }],
      },
      {
        version: 1,
        suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
        cases: [{
          id: 'conversation', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Creates the result.'],
          expected: { artifacts: [{ path: 'output\\result.json' }] },
        }],
      },
    ]) expect(() => parseSelectedCases(value)).toThrow('normalized relative POSIX path')
  })

  it('rejects symbolic links in the prepared fixture tree before provider execution', async () => {
    const data = await fixture()
    await symlink(
      path.join(data.root, 'cases.json'),
      path.join(data.root, 'workspace', 'eval', 'linked-fixture'),
    )
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute,
    })).rejects.toThrow('symlink')
    expect(execute).not.toHaveBeenCalled()
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
        runtime: { observeSpawnAgent: true, fixture: 'fixtures/setup.mjs' },
      },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: ['release'],
        input: {
          query: 'Use the fixture Skill.',
          expected: { loadedSkills: ['fixture-skill'] },
          shouldSpawnAgent: true,
          workspaceFixture: 'workspaces/project',
          useProjectRules: true,
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
          workspace_fixture: 'workspaces/project',
          use_project_rules: true,
        },
        suite: expect.objectContaining({ fixtureModule: 'fixtures/setup.mjs' }),
      }),
    }), undefined)
  })

  it('maps conversation input, expected values, PATH fixtures, and artifacts to the provider', async () => {
    const data = await fixture()
    const evalRoot = path.join(data.root, 'workspace', 'eval')
    await mkdir(path.join(evalRoot, 'fixtures', 'suite-bin'), { recursive: true })
    await mkdir(path.join(evalRoot, 'fixtures', 'case-bin'), { recursive: true })
    await writeFile(path.join(evalRoot, 'fixtures', 'suite-bin', 'suite-tool'), '#!/bin/sh\n')
    await writeFile(path.join(evalRoot, 'fixtures', 'case-bin', 'case-tool'), '#!/bin/sh\n')
    const casesPath = path.join(data.root, 'cases.json')
    const cases = {
      version: 1,
      suite: {
        kind: 'conversation',
        unitUnderTest: 'fixture-skill',
        participants: ['helper-skill'],
        runtime: { isolation: 'strict', pathPrepend: ['fixtures/suite-bin'] },
      },
      cases: [{
        id: 'writes_result',
        split: 'validation',
        tags: ['high-variance'],
        prompt: 'Create the result.',
        assertions: ['The result is valid.'],
        input: {
          scriptedReplies: [{
            answersByIndex: ['yes'],
            expectedQuestionCount: 1,
            unexpectedQuestionAnswer: 'Stop asking questions.',
          }],
          workspaceFiles: { 'input/request.txt': 'request\n', 'input/.keep': '' },
          pathPrepend: ['fixtures/case-bin'],
        },
        expected: {
          output: 'A concise completion message.',
          workspaceUnchanged: false,
          allowedWorkspaceChanges: ['output/**'],
          artifacts: [{
            path: 'output/result.json',
            exists: true,
            contains: ['ok'],
            notContains: ['secret'],
          }],
        },
        audit: { allowedVariance: 'Equivalent wording is accepted.' },
      }],
    }
    await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`)
    data.spec.cases.digest = await computeEvalFileDigest(casesPath)
    data.spec.provider = 'codex-conversation'
    await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
    data.audit.caseDigest = data.spec.cases.digest
    data.audit.approvedCaseIds = ['writes_result']
    await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
    let mappedCase: Record<string, unknown> | undefined
    let mappedFixturesPath = ''
    await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      runBuiltinProvider: (async (_id, input: { case: Record<string, unknown>; fixturesPath: string }) => {
        mappedCase = input.case
        mappedFixturesPath = input.fixturesPath
        return { usage: null, grade: { passed: true, score: 1 } }
      }) as never,
    })
    expect(mappedCase).toEqual({
      value: {
        id: 'writes_result',
        prompt: 'Create the result.',
        scripted_replies: [{
          answers_by_index: ['yes'],
          expected_question_count: 1,
          unexpected_question_answer: 'Stop asking questions.',
        }],
        expected_output: 'A concise completion message.',
        workspace_files: { 'input/request.txt': 'request\n', 'input/.keep': '' },
        environment: { pathPrepend: ['fixtures/case-bin'] },
        sandbox: 'workspace-write',
        review: {
          checks: ['The result is valid.'],
          workspace_unchanged: false,
          allowed_workspace_changes: ['output/**'],
          artifacts: [{
            path: 'output/result.json',
            exists: true,
            contains: ['ok'],
            not_contains: ['secret'],
          }],
        },
      },
      skillName: 'fixture-skill',
      skillNames: ['fixture-skill', 'helper-skill'],
      isolation: 'strict',
      suitePathPrepend: ['fixtures/suite-bin'],
      assertions: ['The result is valid.'],
      allowedVariance: 'Equivalent wording is accepted.',
    })
    const normalized = normalizeConversationProviderCase({
      value: mappedCase!.value as Record<string, unknown>,
      expectedSkill: 'fixture-skill',
      fixtureRoot: mappedFixturesPath,
      suitePathPrepend: mappedCase!.suitePathPrepend as string[],
    })
    expect(normalized).toMatchObject({
      scriptedReplies: [{
        answersByIndex: ['yes'],
        expectedQuestionCount: 1,
        unexpectedQuestionAnswer: 'Stop asking questions.',
      }],
      workspaceFiles: { 'input/request.txt': 'request\n', 'input/.keep': '' },
      workspaceUnchanged: false,
      allowedWorkspaceChanges: ['output/**'],
      environmentPathPrepend: ['fixtures/case-bin'],
      artifacts: [{ path: 'output/result.json', notContains: ['secret'] }],
    })
  })

  it('rejects legacy or mixed casing in structured conversation replies', () => {
    const conversation = (reply: unknown) => ({
      version: 1,
      suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
      cases: [{
        id: 'case-1', split: 'validation', tags: [], prompt: 'Do work.',
        assertions: ['Returns the result.'],
        input: { scriptedReplies: [reply] },
      }],
    })
    for (const reply of [{
      answers_by_index: ['yes'],
      unexpected_question_answer: 'Stop.',
    }, {
      answersByIndex: ['yes'],
      answers_by_index: ['yes'],
      unexpectedQuestionAnswer: 'Stop.',
    }, {
      answersByIndex: ['yes'],
    }, {
      answersByIndex: 'yes',
      unexpectedQuestionAnswer: 'Stop.',
    }]) expect(() => parseSelectedCases(conversation(reply))).toThrow()
    expect(() => normalizeConversationProviderCase({
      value: {
        id: 'case-1',
        prompt: 'Do work.',
        scripted_replies: [{
          answers_by_index: ['yes'],
          answersByIndex: ['yes'],
          unexpected_question_answer: 'Stop.',
        }],
        expected_output: 'Done.',
        sandbox: 'read-only',
        review: { checks: ['Returns the result.'], workspace_unchanged: true },
      },
      expectedSkill: 'fixture-skill',
      fixtureRoot: process.cwd(),
    })).toThrow('unknown field')
  })

  it('omits empty optional conversation provider fields', () => {
    const document = parseSelectedCases({
      version: 1,
      suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
      cases: [{
        id: 'case-1', split: 'validation', tags: [], prompt: 'Inspect the workspace.',
        assertions: ['Reports the result.'],
        input: { scriptedReplies: [], workspaceFiles: {}, pathPrepend: [] },
        expected: { allowedWorkspaceChanges: [], artifacts: [] },
      }],
    })
    expect(adaptConversationProviderCase(document, document.cases[0]!)).toEqual({
      value: {
        id: 'case-1',
        prompt: 'Inspect the workspace.',
        scripted_replies: [],
        expected_output: 'Evaluate the response against the approved assertions.',
        sandbox: 'read-only',
        review: {
          checks: ['Reports the result.'],
          workspace_unchanged: true,
        },
      },
      skillName: 'fixture-skill',
      skillNames: ['fixture-skill'],
      isolation: 'standard',
      suitePathPrepend: [],
      assertions: ['Reports the result.'],
    })
  })

  it('normalizes every registered conversation corpus through the actual adapter', async () => {
    const repositoryRoot = path.resolve('../..')
    const manifests = await evalManifestPaths(path.join(repositoryRoot, 'plugins'))
    let suiteCount = 0
    let conversationCount = 0
    let caseCount = 0
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        suites: Array<{ kind: string; cases?: string }>
      }
      suiteCount += manifest.suites.length
      for (const suite of manifest.suites) {
        if (suite.kind !== 'conversation') continue
        conversationCount += 1
        const fixtureRoot = path.dirname(manifestPath)
        const document = parseSelectedCases(JSON.parse(await readFile(
          path.join(fixtureRoot, suite.cases!),
          'utf8',
        )))
        for (const evalCase of document.cases) {
          const adapted = adaptConversationProviderCase(document, evalCase)
          normalizeConversationProviderCase({
            value: adapted.value as Record<string, unknown>,
            expectedSkill: document.suite.unitUnderTest,
            fixtureRoot,
            suitePathPrepend: adapted.suitePathPrepend as string[],
          })
          caseCount += 1
        }
      }
    }
    expect({ manifests: manifests.length, suites: suiteCount }).toEqual({ manifests: 27, suites: 65 })
    expect(conversationCount).toBeGreaterThan(0)
    expect(caseCount).toBeGreaterThan(0)
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
