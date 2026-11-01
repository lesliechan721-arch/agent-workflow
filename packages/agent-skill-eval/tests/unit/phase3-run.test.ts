import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fs from 'fs-extra'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeCanonicalDirectoryDigest,
  computeEvalFileDigest,
  computeEvalProviderDigest,
  computeSkillDigest,
  executeCustomProcessProvider,
  normalizeConversationProviderCase,
  parseSelectedCases,
  runEvalSpec,
  assertProcessTreeInspectionAvailable,
  validateEvalAudit,
  type EvalAudit,
  type EvalSpec,
} from '../../src/index.js'
import { adaptConversationProviderCase } from '../../src/eval-run.js'

const execFileAsync = promisify(execFile)
const roots: string[] = []
const syntheticProcessPath = fileURLToPath(
  new URL('../../../../scripts/test/synthetic-process.mjs', import.meta.url),
)
const vitestPackagePath = realpathSync(fileURLToPath(
  new URL('../../node_modules/vitest/package.json', import.meta.url),
))
const viteNodePath = path.resolve(path.dirname(vitestPackagePath), '..', 'vite-node', 'vite-node.mjs')

function evalCliArgs(...args: string[]): string[] {
  return [viteNodePath, path.resolve('src/bin.ts'), ...args]
}

let hostProcessInspectionAvailable = false
try {
  await assertProcessTreeInspectionAvailable()
  hostProcessInspectionAvailable = true
} catch {
  // CLI signal integration tests require host process inspection permission.
}

let sentinelMarker = ''
let sentinelAlive = false
const availableProcessTree = {
  platform: process.platform === 'win32' ? 'linux' as const : process.platform,
  createSentinel: async (_markerEnvironmentVariable: string, marker: string) => {
    sentinelMarker = marker
    sentinelAlive = true
    return {
      pid: 900_001,
      stop: async () => { sentinelAlive = false },
    }
  },
  execFile: (
    _command: string,
    args: string[],
    _options: { timeout: number; windowsHide: boolean; maxBuffer: number },
    callback: (error: Error | null, stdout: string) => void,
  ): void => callback(null, args.some((arg) => arg.includes('command='))
    ? sentinelAlive
      ? `900001 1 900001 S sentinel-start node AW_AGENT_SKILL_EVAL_PROCESS_MARKER=${sentinelMarker}`
      : ''
    : sentinelAlive
      ? '900001 1 900001 S Mon Aug 24 12:00:00 2026'
      : ''),
}

function runManagedEval(
  specPath: string,
  options: Parameters<typeof runEvalSpec>[1],
): ReturnType<typeof runEvalSpec> {
  return runEvalSpec(specPath, {
    // Fake providers use an explicit test session, independent of the host agent's permissions.
    sourceEnv: {
      PATH: process.env.PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_PERMISSION_PROFILE: ':danger-full-access',
    },
    ...options,
    processManagementDependencies: options.processManagementDependencies ?? {
      platform: 'linux',
      inspectProcessTree: async () => undefined,
    },
  })
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await readFile(filePath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`)
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
}

async function reviewEvalFixture(): Promise<{
  root: string
  files: Record<string, string>
  cli: string
}> {
  const repositoryRoot = path.resolve('../..')
  const evalRoot = path.join(
    repositoryRoot,
    'plugins',
    'aw-development-toolkit',
    'skills',
    'develop-aw',
    'evals',
  )
  const document = JSON.parse(await readFile(
    path.join(evalRoot, 'review-materialization-cases.json'),
    'utf8',
  )) as { cases: Array<{ id: string; input: { workspaceFiles: Record<string, string> } }> }
  const evalCase = document.cases.find((entry) => entry.id === 'reuse_current_final')
  if (!evalCase) throw new Error('reuse_current_final fixture is missing.')
  const root = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-review-eval-fixture-')))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(evalCase.input.workspaceFiles)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return {
    root,
    files: evalCase.input.workspaceFiles,
    cli: path.join(evalRoot, 'review-fixtures', 'bin', 'aw.mjs'),
  }
}

async function runReviewFixtureCli(
  data: Awaited<ReturnType<typeof reviewEvalFixture>>,
  args: string[],
): Promise<{ code: number; value: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [data.cli, ...args], {
      cwd: data.root,
      encoding: 'utf8',
    })
    return { code: 0, value: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      value: JSON.parse(failure.stdout ?? '{}') as Record<string, unknown>,
    }
  }
}

async function simplificationEvalFixture(): Promise<{
  root: string
  cli: string
}> {
  const repositoryRoot = path.resolve('../..')
  const evalRoot = path.join(
    repositoryRoot,
    'plugins',
    'aw-development-toolkit',
    'skills',
    'develop-aw',
    'evals',
  )
  const document = JSON.parse(await readFile(
    path.join(evalRoot, 'simplify-source-cases.json'),
    'utf8',
  )) as { cases: Array<{ id: string; input: { workspaceFiles: Record<string, string> } }> }
  const evalCase = document.cases.find((entry) => entry.id === 'prepare_isolated_unverified_candidate')
  if (!evalCase) throw new Error('prepare_isolated_unverified_candidate fixture is missing.')
  const root = await fs.realpath(await mkdtemp(path.join(os.tmpdir(), 'aw-simplification-eval-fixture-')))
  roots.push(root)
  for (const [relativePath, content] of Object.entries(evalCase.input.workspaceFiles)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  return {
    root,
    cli: path.join(evalRoot, 'simplify-fixtures', 'bin', 'aw.mjs'),
  }
}

async function runSimplificationFixtureCli(
  data: Awaited<ReturnType<typeof simplificationEvalFixture>>,
  args: string[],
): Promise<{ code: number; value: Record<string, unknown> }> {
  try {
    const result = await execFileAsync(process.execPath, [data.cli, ...args], {
      cwd: data.root,
      encoding: 'utf8',
    })
    return { code: 0, value: JSON.parse(result.stdout) as Record<string, unknown> }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      value: JSON.parse(failure.stdout ?? '{}') as Record<string, unknown>,
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processExists(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for process ${pid} to exit.`)
}

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
    writeFile(path.join(subject, 'input.txt'), 'prepared subject input\n'),
    writeFile(path.join(evalRoot, 'provider.mjs'), 'export const provider = true\n'),
  ])
  await mkdir(path.join(evalRoot, 'fixtures'))
  await writeFile(path.join(evalRoot, 'fixtures', 'tool'), 'prepared fixture\n')
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
    workspace: {
      path: 'workspace',
      digest: await computeCanonicalDirectoryDigest(path.join(root, 'workspace')),
    },
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
    workspaceDigest: spec.workspace.digest,
    providerDigest: computeEvalProviderDigest(spec.provider),
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

async function useTriggerProvider(data: Fixture): Promise<void> {
  const casesPath = path.join(data.root, 'cases.json')
  const caseIds = data.audit.approvedCaseIds.map((id) => id.replaceAll('-', '_'))
  const cases = {
    version: 1,
    suite: { kind: 'trigger', unitUnderTest: 'fixture-skill' },
    cases: caseIds.map((id) => ({
      id,
      split: 'validation',
      tags: [],
      input: { query: 'Use the fixture Skill.', expectedLoad: true },
    })),
  }
  await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`)
  data.spec.cases.digest = await computeEvalFileDigest(casesPath)
  data.spec.provider = 'codex-trigger'
  data.audit.caseDigest = data.spec.cases.digest
  data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
  data.audit.approvedCaseIds = caseIds
  await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
  await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
}

beforeEach(async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'agent-skill-eval-test-codex-'))
  roots.push(codexHome)
  vi.stubEnv('CODEX_HOME', codexHome)
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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
    const removedSuiteField = 'default' + 'Grader'
    expect(() => parseSelectedCases({
      version: 1,
      suite: {
        kind: 'custom-process',
        unitUnderTest: 'fixture-skill',
        [removedSuiteField]: 'mechanical',
      },
      cases: [{ id: 'case-1', split: 'validation', tags: [] }],
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
    await expect(runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute,
    })).rejects.toThrow('symlink')
    expect(execute).not.toHaveBeenCalled()
  })

  it('blocks restricted runs before output and passes explicit unmanaged evidence to custom providers', async () => {
    const blocked = await fixture()
    const blockedExecute = vi.fn()
    await expect(runEvalSpec(blocked.specPath, {
      auditPath: blocked.auditPath,
      sourceEnv: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':workspace-write',
      },
      processManagementDependencies: { platform: 'linux' },
      executeCustomProvider: blockedExecute,
    })).rejects.toThrow('does not identify a Full Access Codex session')
    expect(blockedExecute).not.toHaveBeenCalled()
    await expect(readdir(path.join(blocked.root, 'output'))).rejects.toThrow()

    const unmanaged = await fixture()
    const execute = vi.fn(async (options: { processManagement: unknown }) => {
      expect(options.processManagement).toMatchObject({
        mode: 'unmanaged-confirmed',
        inspectionAvailable: false,
        userAcknowledged: true,
        descendantCleanupGuaranteed: false,
      })
      return { usage: null, grade: { passed: true, score: 1 } }
    })
    const result = await runEvalSpec(unmanaged.specPath, {
      auditPath: unmanaged.auditPath,
      allowUnmanagedProcesses: true,
      sourceEnv: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':read-only',
      },
      processManagementDependencies: { platform: 'linux' },
      executeCustomProvider: execute as never,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(result.result).toMatchObject({
      version: 2,
      processManagement: { mode: 'unmanaged-confirmed' },
    })
  })

  it('blocks a macOS keychain wrapper before output or provider execution in every process mode', async () => {
    for (const allowUnmanagedProcesses of [false, true]) {
      const data = await fixture()
      const execute = vi.fn()
      const inspectProcessTree = vi.fn(async () => undefined)
      await expect(runEvalSpec(data.specPath, {
        auditPath: data.auditPath,
        allowUnmanagedProcesses,
        sourceEnv: {
          CODEX_HOME: process.env.CODEX_HOME,
          CODEX_PERMISSION_PROFILE: ':danger-full-access',
        },
        processManagementDependencies: {
          platform: 'darwin',
          resolveCodexExecutable: async () => '/usr/local/bin/codex',
          readUserKeychainSearchList: async () =>
            '"/private/tmp/accountsKeychainExport/eval.keychain"',
          inspectProcessTree,
        },
        executeCustomProvider: execute,
      })).rejects.toThrow('accountsKeychainExport')
      expect(execute).not.toHaveBeenCalled()
      expect(inspectProcessTree).not.toHaveBeenCalled()
      await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
    }
  })

  it('blocks a cmux Codex shim before output or provider execution in every process mode', async () => {
    for (const allowUnmanagedProcesses of [false, true]) {
      const data = await fixture()
      const execute = vi.fn()
      const readUserKeychainSearchList = vi.fn(async () => '')
      const inspectProcessTree = vi.fn(async () => undefined)
      await expect(runEvalSpec(data.specPath, {
        auditPath: data.auditPath,
        allowUnmanagedProcesses,
        sourceEnv: {
          CODEX_HOME: process.env.CODEX_HOME,
          CODEX_PERMISSION_PROFILE: ':danger-full-access',
          PATH: '/private/tmp/cmux-cli-shims/session:/usr/local/bin',
        },
        processManagementDependencies: {
          platform: 'darwin',
          resolveCodexExecutable: async () =>
            '/private/tmp/cmux-cli-shims/session/codex',
          readUserKeychainSearchList,
          inspectProcessTree,
        },
        executeCustomProvider: execute,
      })).rejects.toThrow('cmux Codex shim or wrapper')
      expect(execute).not.toHaveBeenCalled()
      expect(readUserKeychainSearchList).not.toHaveBeenCalled()
      expect(inspectProcessTree).not.toHaveBeenCalled()
      await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
    }
  })

  it('rejects prepared workspace, provider, and fixture mutations before output or provider execution', async () => {
    for (const relativePath of [
      ['subject', 'input.txt'],
      ['eval', 'provider.mjs'],
      ['eval', 'fixtures', 'tool'],
    ]) {
      const data = await fixture()
      await writeFile(path.join(data.root, 'workspace', ...relativePath), 'changed after Audit\n')
      const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
      await expect(runManagedEval(data.specPath, {
        auditPath: data.auditPath,
        executeCustomProvider: execute,
      })).rejects.toThrow('workspace digest')
      expect(execute).not.toHaveBeenCalled()
      await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
    }
  })

  it('rejects an empty workspace directory added after Audit before output or provider execution', async () => {
    const data = await fixture()
    await mkdir(path.join(data.root, 'workspace', 'subject', 'added-empty'))
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute,
    })).rejects.toThrow('workspace digest')
    expect(execute).not.toHaveBeenCalled()
    await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
  })

  it('preserves an audited empty directory through the run snapshot and attempt workspace', async () => {
    const data = await fixture()
    const emptyDirectory = path.join(data.root, 'workspace', 'subject', 'kept-empty')
    await mkdir(emptyDirectory)
    data.spec.workspace.digest = await computeCanonicalDirectoryDigest(path.join(data.root, 'workspace'))
    data.audit.workspaceDigest = data.spec.workspace.digest
    await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
    await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
    const execute = vi.fn(async ({ input }: { input: { workspacePath: string } }) => {
      expect(await readdir(path.join(input.workspacePath, 'kept-empty'))).toEqual([])
      return { usage: null, grade: { passed: true, score: 1 } }
    })

    await runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute as never,
    })

    expect(execute).toHaveBeenCalledOnce()
  })

  it('never invokes a provider when Audit admission is absent or mismatched', async () => {
    const data = await fixture()
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runManagedEval(data.specPath, {
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
      await expect(runManagedEval(data.specPath, {
        auditPath: data.auditPath,
        executeCustomProvider: execute,
      })).rejects.toThrow('does not admit execution')
    }
    expect(execute).not.toHaveBeenCalled()
    await expect(readFile(path.join(data.root, 'output', 'result.json'))).rejects.toThrow()
    await expect(validateEvalAudit(data.audit, {
      spec: {
        ...data.spec,
        runs: 9,
        timeoutMs: 99_999,
      },
      selectedCaseIds: ['case-1'],
    })).resolves.toMatchObject({ valid: true })
  })

  it('rejects a changed custom provider command before output or provider execution', async () => {
    const data = await fixture()
    data.spec.provider = {
      type: 'custom-process',
      command: ['fixture-provider', '--changed-after-audit'],
    }
    await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
    await expect(validateEvalAudit(data.audit, {
      spec: data.spec,
      selectedCaseIds: ['case-1'],
    })).resolves.toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining('providerDigest')]),
    })
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: execute,
    })).rejects.toThrow('providerDigest')
    expect(execute).not.toHaveBeenCalled()
    await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
  })

  it('rejects old and unknown object providers before any provider can start', async () => {
    for (const provider of [
      { type: 'codex-workflow', command: ['node', 'workspace/eval/provider.mjs'] },
      { type: 'unknown-provider', command: ['node'] },
    ]) {
      const data = await fixture()
      data.spec.provider = provider as EvalSpec['provider']
      await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
      const runBuiltinProvider = vi.fn()
      const executeCustomProvider = vi.fn()
      const executeCodexWorkflowProvider = vi.fn()
      await expect(runManagedEval(data.specPath, {
        auditPath: data.auditPath,
        runBuiltinProvider,
        executeCustomProvider,
        executeCodexWorkflowProvider,
      })).rejects.toThrow('EvalSpec is invalid')
      expect(runBuiltinProvider).not.toHaveBeenCalled()
      expect(executeCustomProvider).not.toHaveBeenCalled()
      expect(executeCodexWorkflowProvider).not.toHaveBeenCalled()
      await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
    }
  })

  it('dispatches codex-workflow separately from custom-process and preserves its result kind', async () => {
    const data = await fixture()
    const casesPath = path.join(data.root, 'cases.json')
    const cases = JSON.parse(await readFile(casesPath, 'utf8'))
    cases.suite.kind = 'codex-workflow'
    await writeFile(casesPath, `${JSON.stringify(cases, null, 2)}\n`)
    data.spec.cases.digest = await computeEvalFileDigest(casesPath)
    data.spec.provider = {
      type: 'codex-workflow',
      command: ['node', 'workspace/eval/provider.mjs'],
      allowedModels: [],
    }
    data.audit.caseDigest = data.spec.cases.digest
    data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
    await Promise.all([
      writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`),
      writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`),
    ])
    const executeCustomProvider = vi.fn(async () => ({
      usage: null,
      grade: { passed: true, score: 1 },
    }))
    const executeCodexWorkflowProvider = vi.fn(async () => ({
      usage: { inputTokens: 3, outputTokens: 2 },
      grade: { passed: true, score: 1 },
      artifacts: [
        { path: 'workflow-evidence.json', role: 'evidence' },
        { path: 'workflow-trace.json', role: 'trace' },
        { path: 'model-output.txt', role: 'output' },
      ],
    }))

    const result = await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      allowUnmanagedProcesses: true,
      sourceEnv: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':read-only',
      },
      processManagementDependencies: { platform: 'linux' },
      executeCustomProvider,
      executeCodexWorkflowProvider,
    })

    expect(executeCustomProvider).not.toHaveBeenCalled()
    expect(executeCodexWorkflowProvider).toHaveBeenCalledOnce()
    expect(executeCodexWorkflowProvider).toHaveBeenCalledWith(expect.objectContaining({
      processManagement: expect.objectContaining({ mode: 'unmanaged-confirmed' }),
    }))
    expect(result.result.provider).toEqual(data.spec.provider)
    expect(result.result.runs[0]).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 3, outputTokens: 2 },
      artifacts: [
        { path: 'workflow-evidence.json', role: 'evidence' },
        { path: 'workflow-trace.json', role: 'trace' },
        { path: 'model-output.txt', role: 'output' },
        { path: 'provider-result.json', role: 'result' },
      ],
    })

    const failed = await fixture({ runs: 3 })
    const failedCasesPath = path.join(failed.root, 'cases.json')
    const failedCases = JSON.parse(await readFile(failedCasesPath, 'utf8'))
    failedCases.suite.kind = 'codex-workflow'
    await writeFile(failedCasesPath, `${JSON.stringify(failedCases, null, 2)}\n`)
    failed.spec.cases.digest = await computeEvalFileDigest(failedCasesPath)
    failed.spec.provider = {
      type: 'codex-workflow',
      command: ['node', 'workspace/eval/provider.mjs'],
      allowedModels: [],
    }
    failed.audit.caseDigest = failed.spec.cases.digest
    failed.audit.providerDigest = computeEvalProviderDigest(failed.spec.provider)
    await Promise.all([
      writeFile(failed.specPath, `${JSON.stringify(failed.spec, null, 2)}\n`),
      writeFile(failed.auditPath, `${JSON.stringify(failed.audit, null, 2)}\n`),
    ])
    const failClosed = vi.fn(async () => { throw new Error('prepare failed') })
    const failedResult = await runManagedEval(failed.specPath, {
      auditPath: failed.auditPath,
      executeCodexWorkflowProvider: failClosed,
    })
    expect(failClosed).toHaveBeenCalledOnce()
    expect(failedResult.result.runs).toEqual([
      expect.objectContaining({
        attempt: 1,
        status: 'failed',
        usage: null,
        grade: null,
        error: { message: 'prepare failed' },
      }),
    ])
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
    data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
    data.audit.approvedCaseIds = ['loads_skill']
    await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
    const runBuiltinProvider = vi.fn(async (_id, input: { case: Record<string, unknown> }) => ({
      usage: null,
      grade: { passed: true, score: 1 },
      observedCase: input.case,
    }))
    await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      allowUnmanagedProcesses: true,
      sourceEnv: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':read-only',
      },
      processManagementDependencies: { platform: 'linux' },
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
    }), expect.objectContaining({
      model: 'gpt-6-luna',
      codexRuntime: expect.objectContaining({ inherited: false, modelProvider: 'openai' }),
      processManagement: expect.objectContaining({ mode: 'unmanaged-confirmed' }),
    }))
  })

  it('resolves one inherited runtime for the built-in provider before output creation', async () => {
    const data = await fixture()
    const sourceCodexHome = path.join(data.root, 'source-codex-home')
    const ignoredCodexHome = path.join(data.root, 'ignored-codex-home')
    await Promise.all([mkdir(sourceCodexHome), mkdir(ignoredCodexHome)])
    await writeFile(path.join(sourceCodexHome, 'config.toml'), [
      'model = "user-model"',
      'model_provider = "custom"',
      '',
      '[model_providers.custom]',
      'name = "Custom"',
      'base_url = "https://provider.example.invalid/v1"',
      'wire_api = "responses"',
      'env_key = "CUSTOM_TOKEN"',
      '',
    ].join('\n'))
    await useTriggerProvider(data)
    const runBuiltinProvider = vi.fn(async (_id, _input, dependencies) => {
      expect(dependencies).toMatchObject({
        codexBin: '/injected/codex',
        model: 'dependency-model',
        sourceEnv: expect.objectContaining({ CODEX_HOME: sourceCodexHome }),
        codexRuntime: expect.objectContaining({
          inherited: true,
          model: 'dependency-model',
          modelProvider: 'custom',
          sourceCodexHome,
          providerEnvironment: { CUSTOM_TOKEN: 'runtime-token' },
        }),
      })
      return { usage: null, grade: { passed: true, score: 1 } }
    })

    const result = await runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      sourceEnv: {
        PATH: process.env.PATH,
        CODEX_HOME: sourceCodexHome,
        CUSTOM_TOKEN: 'runtime-token',
        AW_SKILL_EVAL_CODEX_MODEL: 'environment-model',
      },
      builtinProviderDependencies: {
        codexBin: '/injected/codex',
        model: 'dependency-model',
        sourceEnv: { CODEX_HOME: ignoredCodexHome },
      },
      runBuiltinProvider: runBuiltinProvider as never,
    })

    expect(runBuiltinProvider).toHaveBeenCalledOnce()
    expect(JSON.stringify(result.result)).not.toContain(sourceCodexHome)
    expect(JSON.stringify(result.result)).not.toContain('provider.example.invalid')
  })

  it('launches the canonical Codex executable admitted by the macOS preflight', async () => {
    const data = await fixture()
    await useTriggerProvider(data)
    const runBuiltinProvider = vi.fn(async (_id, _input, dependencies) => {
      expect(dependencies).toMatchObject({ codexBin: '/native/bin/codex' })
      return { usage: null, grade: { passed: true, score: 1 } }
    })

    await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      sourceEnv: {
        CODEX_PERMISSION_PROFILE: ':danger-full-access',
        PATH: '/eval/fixture/bin:/host/bin',
      },
      builtinProviderDependencies: { codexBin: 'codex' },
      processManagementDependencies: {
        platform: 'darwin',
        resolveCodexExecutable: async () => '/native/bin/codex',
        readUserKeychainSearchList: async () => '',
        inspectProcessTree: async () => undefined,
      },
      runBuiltinProvider: runBuiltinProvider as never,
    })

    expect(runBuiltinProvider).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'stages auth and runtime variables for a custom provider, then removes runtime homes',
    async () => {
      const data = await fixture()
      const sourceCodexHome = path.join(data.root, 'auth-only-codex-home')
      const providerPath = path.join(data.root, 'runtime-provider.mjs')
      await mkdir(sourceCodexHome)
      await writeFile(path.join(sourceCodexHome, 'auth.json'), JSON.stringify({
        tokens: { access_token: 'fake-auth-token' },
      }))
      await writeFile(providerPath, [
        "import fs from 'node:fs'",
        "import path from 'node:path'",
        `const sourceCodexHome = ${JSON.stringify(sourceCodexHome)}`,
        'const runtimeHome = process.env.AW_CODEX_EVAL_RUNTIME_HOME',
        "if (!runtimeHome || runtimeHome !== process.env.CODEX_HOME) throw new Error('runtime home mismatch')",
        "if (runtimeHome === sourceCodexHome) throw new Error('runtime was not staged')",
        "if (process.env.HOME === runtimeHome) throw new Error('HOME was not isolated separately')",
        "if (process.env.AW_CODEX_EVAL_MODEL_PROVIDER !== 'openai') throw new Error('provider mismatch')",
        "if (process.env.AW_CODEX_EVAL_SENSITIVE_ENV_NAMES === undefined) throw new Error('sensitive names missing')",
        "const auth = JSON.parse(fs.readFileSync(path.join(runtimeHome, 'auth.json'), 'utf8'))",
        "if (auth.tokens.access_token !== 'fake-auth-token') throw new Error('staged auth mismatch')",
        "process.stdout.write(JSON.stringify({ version: 1, usage: null, grade: { passed: true, score: 1 } }))",
        '',
      ].join('\n'))
      data.spec.provider = { type: 'custom-process', command: [process.execPath, providerPath] }
      await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
      data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
      await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)

      const result = await runManagedEval(data.specPath, {
        auditPath: data.auditPath,
        sourceEnv: { PATH: process.env.PATH, CODEX_HOME: sourceCodexHome },
      })

      expect(result.result.runs[0]).toMatchObject({ status: 'completed' })
      const attemptRoot = path.join(
        data.root,
        'output',
        'runs',
        'case-1',
        'current',
        'attempt-1',
      )
      await expect(readFile(path.join(attemptRoot, '.custom-provider-runtime', 'auth.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(path.join(attemptRoot, '.custom-provider-home', 'auth.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(path.join(attemptRoot, '.custom-provider-tmp', 'auth.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.stringify(result.result)).not.toContain(sourceCodexHome)
      expect(JSON.stringify(result.result)).not.toContain('fake-auth-token')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'uses one auth read for staging and redaction when the source credential rotates',
    async () => {
      const data = await fixture()
      const sourceCodexHome = path.join(data.root, 'rotating-auth-codex-home')
      const authPath = path.join(sourceCodexHome, 'auth.json')
      const providerPath = path.join(data.root, 'rotating-auth-provider.mjs')
      const oldToken = 'old-auth-token'
      const newToken = 'new-auth-token'
      await mkdir(sourceCodexHome)
      await writeFile(authPath, JSON.stringify({ tokens: { access_token: oldToken } }))
      await writeFile(providerPath, [
        "import fs from 'node:fs'",
        "import path from 'node:path'",
        "const auth = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8'))",
        'const token = auth.tokens.access_token',
        'process.stdout.write(JSON.stringify({',
        '  version: 1,',
        '  usage: null,',
        '  grade: { passed: true, score: 1, details: { token } },',
        '}))',
        '',
      ].join('\n'))
      data.spec.provider = { type: 'custom-process', command: [process.execPath, providerPath] }
      await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
      data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
      await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)

      const originalReadFile = fs.readFile.bind(fs) as (...args: any[]) => Promise<any>
      let rotated = false
      vi.spyOn(fs, 'readFile').mockImplementation((async (...args: any[]) => {
        const value = await originalReadFile(...args)
        if (!rotated && path.resolve(String(args[0])) === authPath) {
          rotated = true
          await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: newToken } }))
        }
        return value
      }) as typeof fs.readFile)

      const result = await runManagedEval(data.specPath, {
        auditPath: data.auditPath,
        sourceEnv: { PATH: process.env.PATH, CODEX_HOME: sourceCodexHome },
        executeCustomProvider: (options) => executeCustomProcessProvider({
          ...options,
          processTree: availableProcessTree,
        }),
      })

      expect(rotated).toBe(true)
      expect(result.result.runs[0]).toMatchObject({ status: 'failed', usage: null, grade: null })
      const serialized = JSON.stringify(result.result)
      expect(serialized).not.toContain(oldToken)
      expect(serialized).not.toContain(newToken)
      const providerResult = path.join(
        data.root,
        'output',
        'runs',
        'case-1',
        'current',
        'attempt-1',
        'output',
        'provider-result.json',
      )
      await expect(fs.pathExists(providerResult)).resolves.toBe(false)
    },
  )

  it('maps conversation input, expected values, PATH fixtures, and artifacts to the provider', async () => {
    const data = await fixture()
    const evalRoot = path.join(data.root, 'workspace', 'eval')
    await mkdir(path.join(evalRoot, 'fixtures', 'suite-bin'), { recursive: true })
    await mkdir(path.join(evalRoot, 'fixtures', 'case-bin'), { recursive: true })
    await writeFile(path.join(evalRoot, 'fixtures', 'suite-bin', 'suite-tool'), '#!/bin/sh\n')
    await writeFile(path.join(evalRoot, 'fixtures', 'case-bin', 'case-tool'), '#!/bin/sh\n')
    data.spec.workspace.digest = await computeCanonicalDirectoryDigest(path.join(data.root, 'workspace'))
    data.audit.workspaceDigest = data.spec.workspace.digest
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
    data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
    data.audit.approvedCaseIds = ['writes_result']
    await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
    let mappedCase: Record<string, unknown> | undefined
    let mappedFixturesPath = ''
    await runEvalSpec(data.specPath, {
      auditPath: data.auditPath,
      allowUnmanagedProcesses: true,
      sourceEnv: {
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':read-only',
      },
      processManagementDependencies: { platform: 'linux' },
      runBuiltinProvider: (async (
        _id,
        input: { case: Record<string, unknown>; fixturesPath: string },
        dependencies: { processManagement: unknown },
      ) => {
        expect(dependencies.processManagement).toMatchObject({ mode: 'unmanaged-confirmed' })
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

  it('preserves explicit deny-all authorization with writable conversation tools', () => {
    const document = parseSelectedCases({
      version: 1,
      suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
      cases: [{
        id: 'no-write', split: 'validation', tags: [], prompt: 'Inspect without editing.',
        assertions: ['Does not attempt a write.'],
        expected: { workspaceUnchanged: false, allowedWorkspaceChanges: [] },
      }],
    })
    const adapted = adaptConversationProviderCase(document, document.cases[0]!)
    const value = adapted.value as Record<string, unknown>
    const normalize = (candidate: Record<string, unknown>) => normalizeConversationProviderCase({
      value: candidate, expectedSkill: 'fixture-skill', fixtureRoot: process.cwd(),
    })
    expect(value).toMatchObject({
      sandbox: 'workspace-write',
      review: { workspace_unchanged: false, allowed_workspace_changes: [] },
    })
    expect(normalize(value)).toMatchObject({
      sandbox: 'workspace-write', workspaceUnchanged: false,
      allowedWorkspaceChanges: [], artifacts: [],
    })

    const review = value.review as Record<string, unknown>
    const { allowed_workspace_changes: _allowlist, ...missingAllowlist } = review
    expect(() => normalize({ ...value, review: missingAllowlist })).toThrow('requires explicit')
    expect(() => normalize({
      ...value, review: { ...review, allowed_workspace_changes: ['out/**'] },
    })).toThrow('requires non-empty review.artifacts')
    expect(() => normalize({
      ...value,
      review: {
        ...review, allowed_workspace_changes: ['out/**'],
        artifacts: [{ path: 'outside.txt', exists: true }],
      },
    })).toThrow('outside review.allowed_workspace_changes')
  })

  it('normalizes every registered conversation corpus through the actual adapter', async () => {
    const repositoryRoot = path.resolve('../..')
    const manifests = await evalManifestPaths(path.join(repositoryRoot, 'plugins'))
    let conversationCount = 0
    let caseCount = 0
    for (const manifestPath of manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
        suites: Array<{ kind: string; cases?: string }>
      }
      for (const suite of manifest.suites) {
        if (suite.kind !== 'conversation') continue
        conversationCount += 1
        const fixtureRoot = path.dirname(manifestPath)
        const casesPath = path.join(fixtureRoot, suite.cases!)
        const document = parseSelectedCases(JSON.parse(await readFile(
          casesPath,
          'utf8',
        )))
        for (const evalCase of document.cases) {
          const adapted = adaptConversationProviderCase(document, evalCase)
          expect(() => normalizeConversationProviderCase({
            value: adapted.value as Record<string, unknown>,
            expectedSkill: document.suite.unitUnderTest,
            fixtureRoot,
            suitePathPrepend: adapted.suitePathPrepend as string[],
          }), `${path.relative(repositoryRoot, casesPath)}: ${evalCase.id}`).not.toThrow()
          caseCount += 1
        }
      }
    }
    expect(conversationCount).toBeGreaterThan(0)
    expect(caseCount).toBeGreaterThan(0)
  })

  it('prepares separate simplification finals from complete isolated snapshots', async () => {
    const data = await simplificationEvalFixture()
    const productionSkill = path.join(data.root, 'project/plugins/demo-plugin/skills/demo-skill')
    const productionSkillFile = path.join(productionSkill, 'SKILL.md')
    const original = await readFile(productionSkillFile, 'utf8')
    const baselineWorkspace = path.join(data.root, '_simplify/baseline/project')
    const candidateWorkspace = path.join(data.root, '_simplify/candidate/project')
    await fs.copy(path.join(data.root, 'project'), baselineWorkspace)
    await fs.copy(path.join(data.root, 'project'), candidateWorkspace)
    const candidateSkill = path.join(candidateWorkspace, 'plugins/demo-plugin/skills/demo-skill/SKILL.md')
    await writeFile(candidateSkill, (await readFile(candidateSkill, 'utf8')).replace(
      'Use only supplied facts. Use only supplied facts.',
      'Use only supplied facts.',
    ))

    const inspect = await runSimplificationFixtureCli(data, [
      'review', 'inspect', productionSkill, '--view', 'review', '--json',
    ])
    expect(inspect.code, JSON.stringify(inspect.value)).toBe(0)
    expect(inspect.value).toMatchObject({ ok: true, fixture: true, sources: expect.any(Array) })

    const prepared: Array<Record<string, unknown>> = []
    for (const kind of ['baseline', 'candidate']) {
      const workspace = path.join(data.root, `_simplify/${kind}/project`)
      const result = await runSimplificationFixtureCli(data, [
        'review', 'prepare', path.join(workspace, 'plugins/demo-plugin/skills/demo-skill'),
        '--workspace-root', workspace,
        '--platform', 'codex',
        '--scope', 'project',
        '--out', path.join(data.root, `_simplify/final/${kind}`),
        '--json',
      ])
      expect(result).toMatchObject({
        code: 0,
        value: {
          ok: true,
          fixture: true,
          sourceBindingPath: expect.any(String),
          skills: [{ profile: { platform: 'codex', scope: 'project' }, state: 'ready' }],
        },
      })
      prepared.push(result.value)
    }

    expect(await readFile(productionSkillFile, 'utf8')).toBe(original)
    expect(await readFile(
      path.join(data.root, '_simplify/final/baseline/skills/demo-skill/SKILL.md'),
      'utf8',
    )).toContain('Use only supplied facts. Use only supplied facts.')
    expect(await readFile(
      path.join(data.root, '_simplify/final/candidate/skills/demo-skill/SKILL.md'),
      'utf8',
    )).not.toContain('Use only supplied facts. Use only supplied facts.')
    const bindings = await Promise.all(['baseline', 'candidate'].map(async (kind) => JSON.parse(await readFile(
      path.join(data.root, `_simplify/final/${kind}/aw-source-binding.json`),
      'utf8',
    )) as { testDouble: boolean; sourceDigest: string }))
    expect(bindings.every((binding) => binding.testDouble)).toBe(true)
    expect(bindings[0]!.sourceDigest).not.toBe(bindings[1]!.sourceDigest)
    expect(prepared).toHaveLength(2)
    await expect(runSimplificationFixtureCli(data, ['review', 'publish', '--json']))
      .resolves.toMatchObject({ code: 64, value: { ok: false, fixture: true } })
  })

  it('rejects review fixture choices outside its declared test-double profile', async () => {
    const data = await reviewEvalFixture()
    const source = path.join(data.root, 'project/plugins/demo-plugin/skills/demo-skill')
    const workspace = path.join(data.root, 'project')
    const binding = path.join(data.root, '_review-output/existing/aw-source-binding.json')
    const config = path.join(data.root, 'config.json')
    await writeFile(config, '{"unknown-plugin":{}}\n')

    const rejected = [
      ['review', 'inspect', path.join(data.root, 'outside'), '--json'],
      ['review', 'inspect', source, '--skill', 'unknown-skill', '--json'],
      ['review', 'inspect', source, '--platform', 'claude', '--json'],
      ['review', 'inspect', source, '--scope', 'user', '--json'],
      ['review', 'inspect', source, '--workspace-root', data.root, '--json'],
      ['review', 'inspect', source, '--config', config, '--json'],
      ['review', 'inspect', source, '--materialization', path.join(data.root, 'missing-binding.json'), '--json'],
      ['review', 'prepare', source, '--platform', 'codex', '--scope', 'project', '--json'],
      ['review', 'inspect', source, '--unknown', 'value', '--json'],
      ['review', 'inspect', source, '--platform', '--json'],
      ['review', 'inspect', source, '--skill', 'demo-skill', '--skill', 'unknown-skill', '--json'],
    ]
    for (const args of rejected) {
      const result = await runReviewFixtureCli(data, args)
      expect(result.code, args.join(' ')).not.toBe(0)
      expect(result.value.ok, args.join(' ')).toBe(false)
    }

    const acceptedArgs = [
      'review', 'inspect', source,
      '--workspace-root', workspace,
      '--skill', 'demo-skill',
      '--platform', 'codex',
      '--scope', 'project',
      '--materialization', binding,
      '--json',
    ]
    const accepted = await runReviewFixtureCli(data, acceptedArgs)
    expect(accepted.code).toBe(0)
    expect(accepted.value).toMatchObject({ schemaVersion: 2, view: 'review', skills: [{ state: 'ready' }] })
    const explicitReview = await runReviewFixtureCli(data, [...acceptedArgs, '--view', 'review'])
    expect(explicitReview.code).toBe(0)
    expect(explicitReview.value).toEqual(accepted.value)

    for (const viewArgs of [['--view', 'release'], ['--view=release']]) {
      const result = await runReviewFixtureCli(data, ['review', 'inspect', source, ...viewArgs, '--json'])
      expect(result.code).toBe(2)
      expect(result.value).toMatchObject({
        schemaVersion: 2,
        command: 'review:inspect',
        view: 'review',
        ok: false,
        sources: expect.any(Array),
        skills: [],
        issues: [{ code: 'invalidArguments' }],
      })
    }
  })

  it('preserves review fixture source, provider, and supplied final bytes', async () => {
    const data = await reviewEvalFixture()
    const protectedPaths = Object.keys(data.files).filter((relativePath) =>
      relativePath.startsWith('project/plugins/demo-plugin/')
        || relativePath.startsWith('_review-output/existing/'))
    const before = new Map(await Promise.all(protectedPaths.map(async (relativePath) => [
      relativePath,
      await readFile(path.join(data.root, relativePath)),
    ] as const)))
    const source = path.join(data.root, 'project/plugins/demo-plugin/skills/demo-skill')

    expect((await runReviewFixtureCli(data, ['review', 'inspect', source, '--json'])).code).toBe(0)
    expect((await runReviewFixtureCli(data, [
      'review', 'prepare', source,
      '--platform', 'codex',
      '--scope', 'project',
      '--out', path.join(data.root, '_review-output/new'),
      '--json',
    ])).code).not.toBe(0)

    for (const [relativePath, expected] of before) {
      expect(await readFile(path.join(data.root, relativePath)), relativePath).toEqual(expected)
    }
  })

  it('exclusively claims outputRoot before provider execution and preserves existing content', async () => {
    const data = await fixture()
    const output = path.join(data.root, 'output')
    await mkdir(output)
    await writeFile(path.join(output, 'foreign.txt'), 'do not change\n')
    const execute = vi.fn(async () => ({ usage: null, grade: { passed: true, score: 1 } }))
    await expect(runManagedEval(data.specPath, {
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
    const secret = 'phase3-"\\\n\t-runner-secret'
    const control = 'phase3-model-control'
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
          details: { [secret]: secret, secret, control },
        },
      }
    })
    const first = await runManagedEval(without.specPath, {
      auditPath: without.auditPath,
      executeCustomProvider: execute as never,
      sourceEnv: {
        PATH: process.env.PATH,
        CODEX_HOME: process.env.CODEX_HOME,
        CODEX_PERMISSION_PROFILE: ':danger-full-access',
        OPENAI_API_KEY: secret,
        AW_SKILL_EVAL_CODEX_MODEL: control,
        HOME: '/phase3/home-control',
      },
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
    const resultBytes = await readFile(first.resultPath, 'utf8')
    expect(resultBytes).not.toContain(secret)
    expect(resultBytes).not.toContain(JSON.stringify(secret).slice(1, -1))
    expect(resultBytes).toContain(control)
    const providerResultBytes = await readFile(path.join(
      without.root, first.result.runs[0]!.outputDir, 'provider-result.json',
    ), 'utf8')
    expect(providerResultBytes).not.toContain(secret)
    expect(providerResultBytes).not.toContain(JSON.stringify(secret).slice(1, -1))

    const previous = await fixture({ baseline: 'previous-version' })
    const previousObserved: string[] = []
    const second = await runManagedEval(previous.specPath, {
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
    const timedOut = await runManagedEval(timeout.specPath, {
      auditPath: timeout.auditPath,
      executeCustomProvider: (async () => { throw new Error('provider timed out after 1000ms') }) as never,
    })
    expect(timedOut.result.runs).toHaveLength(1)
    expect(timedOut.result.runs[0]).toMatchObject({ status: 'timeout', grade: null })
    expect(timedOut.result.summary.timeout).toBe(1)

    const changed = await fixture({ runs: 3 })
    const before = await computeSkillDigest(changed.target)
    const changedResult = await runManagedEval(changed.specPath, {
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

    const changedWorkspace = await fixture({ runs: 3 })
    const changedWorkspaceResult = await runManagedEval(changedWorkspace.specPath, {
      auditPath: changedWorkspace.auditPath,
      executeCustomProvider: (async () => {
        await writeFile(
          path.join(changedWorkspace.root, 'workspace', 'eval', 'provider.mjs'),
          'changed during execution\n',
        )
        return { usage: null, grade: { passed: true, score: 1 } }
      }) as never,
    })
    expect(changedWorkspaceResult.result.runs).toHaveLength(1)
    expect(changedWorkspaceResult.result.runs[0]).toMatchObject({ status: 'failed', grade: null })
    expect(changedWorkspaceResult.result.runs[0]?.error?.message).toContain('digest changed')

    const cleanup = await fixture({ runs: 3 })
    const cleanupResult = await runManagedEval(cleanup.specPath, {
      auditPath: cleanup.auditPath,
      executeCustomProvider: (async () => {
        throw new Error('process-tree cleanup could not be confirmed')
      }) as never,
    })
    expect(cleanupResult.result.runs).toHaveLength(1)
    expect(cleanupResult.result.runs[0]).toMatchObject({ status: 'failed' })
  })

  it('passes an external abort signal to built-in providers and stops later attempts', async () => {
    const data = await fixture({ runs: 3, caseCount: 2 })
    await useTriggerProvider(data)
    const controller = new AbortController()
    const runBuiltinProvider = vi.fn(async (_id, input: { signal?: AbortSignal }) => {
      expect(input.signal).toBe(controller.signal)
      controller.abort()
      return { usage: { inputTokens: 1, outputTokens: 1 }, grade: { passed: true, score: 1 } }
    })
    const result = await runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      signal: controller.signal,
      runBuiltinProvider: runBuiltinProvider as never,
    })
    expect(runBuiltinProvider).toHaveBeenCalledTimes(1)
    expect(result.result.runs).toHaveLength(1)
    expect(result.result.runs[0]).toMatchObject({
      status: 'failed',
      usage: null,
      grade: null,
      error: { message: 'Eval execution was aborted.' },
    })
  })

  it.skipIf(process.platform !== 'linux' || !hostProcessInspectionAvailable)(
    'cleans a custom provider tree before exiting for SIGINT and SIGTERM',
    async () => {
      for (const [signal, exitCode] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
      ] as const) {
        const data = await fixture({ runs: 3, caseCount: 2 })
        const providerPath = path.join(data.root, 'provider.mjs')
        const processPath = path.join(data.root, 'provider-processes.json')
        await writeFile(providerPath, [
          "import { spawn } from 'node:child_process'",
          "import { writeFileSync } from 'node:fs'",
          "let input = ''",
          "process.stdin.setEncoding('utf8')",
          "process.stdin.on('data', (chunk) => { input += chunk })",
          "process.stdin.on('end', () => {",
          `  const child = spawn(process.execPath, [${JSON.stringify(syntheticProcessPath)}], { stdio: 'ignore' })`,
          `  writeFileSync(${JSON.stringify(processPath)}, JSON.stringify({ parent: process.pid, child: child.pid }))`,
          "  setTimeout(() => process.exit(124), 30_000)",
          "  setInterval(() => {}, 1000)",
          "})",
          '',
        ].join('\n'))
        data.spec.provider = { type: 'custom-process', command: [process.execPath, providerPath] }
        data.spec.timeoutMs = 30_000
        await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
        data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
        await writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`)
        const runner = spawn(process.execPath, evalCliArgs(
          'run', data.specPath, '--audit', data.auditPath,
        ), { stdio: ['ignore', 'pipe', 'pipe'] })
        const closedPromise = waitForClose(runner)
        let stdout = ''
        let stderr = ''
        runner.stdout!.setEncoding('utf8')
        runner.stderr!.setEncoding('utf8')
        runner.stdout!.on('data', (chunk) => { stdout += chunk })
        runner.stderr!.on('data', (chunk) => { stderr += chunk })
        let providerPids: { parent: number; child: number } | null = null
        try {
          await Promise.race([
            waitForFile(processPath),
            closedPromise.then(({ code, signal: closedSignal }) => {
              throw new Error(
                `Runner exited before provider startup (code ${String(code)}, signal ${String(closedSignal)}): ${stderr}${stdout}`,
              )
            }),
          ])
          providerPids = JSON.parse(await readFile(processPath, 'utf8')) as {
            parent: number
            child: number
          }
          expect(runner.kill(signal)).toBe(true)
          const closed = await closedPromise
          expect(closed).toEqual({ code: exitCode, signal: null })
          expect(stderr).toBe('')
          const result = JSON.parse(stdout) as {
            result: { runs: Array<{ status: string; usage: unknown; grade: unknown }> }
          }
          expect(result.result.runs).toHaveLength(1)
          expect(result.result.runs[0]).toMatchObject({ status: 'failed', usage: null, grade: null })
          await Promise.all([
            waitForProcessExit(providerPids.parent),
            waitForProcessExit(providerPids.child),
          ])
        } finally {
          if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
          for (const pid of providerPids ? [providerPids.parent, providerPids.child] : []) {
            if (processExists(pid)) {
              try {
                process.kill(pid, 'SIGKILL')
              } catch {
                // The provider can exit between the check and cleanup.
              }
            }
          }
        }
      }
    },
    30_000,
  )

  it('supports the new validation and inspection CLI contract', async () => {
    const data = await fixture({ baseline: 'without-skill' })
    const result = await runManagedEval(data.specPath, {
      auditPath: data.auditPath,
      executeCustomProvider: (async () => ({
        usage: { inputTokens: 1, outputTokens: 1 },
        grade: { passed: true, score: 1 },
      })) as never,
    })
    await expect(execFileAsync(process.execPath, evalCliArgs('--help')))
      .resolves.toMatchObject({ stdout: expect.stringContaining('--allow-unmanaged-processes') })
    const specOutput = JSON.parse((await execFileAsync(process.execPath, evalCliArgs(
      'spec', 'validate', data.specPath,
    ))).stdout) as { valid: boolean; calculated: { providerDigest: string } }
    expect(specOutput.valid).toBe(true)
    expect(specOutput.calculated.providerDigest).toBe(computeEvalProviderDigest(data.spec.provider))
    const auditOutput = JSON.parse((await execFileAsync(process.execPath, evalCliArgs(
      'audit', 'validate', data.auditPath, '--spec', data.specPath,
    ))).stdout) as { valid: boolean }
    expect(auditOutput.valid).toBe(true)
    const resultOutput = JSON.parse((await execFileAsync(process.execPath, evalCliArgs(
      'result', 'validate', result.resultPath,
      '--spec', data.specPath, '--audit', data.auditPath,
    ))).stdout) as { valid: boolean }
    expect(resultOutput.valid).toBe(true)
    const inspection = JSON.parse((await execFileAsync(process.execPath, evalCliArgs(
      'inspect-result', result.resultPath,
      '--spec', data.specPath, '--audit', data.auditPath,
    ))).stdout) as { groups: unknown[] }
    expect(inspection.groups).toEqual([expect.objectContaining({
      caseId: 'case-1',
      attempt: 1,
      variants: {
        current: expect.objectContaining({ status: 'completed' }),
        'without-skill': expect.objectContaining({ status: 'completed' }),
      },
    })])

    const unknownCaseResult = structuredClone(result.result)
    unknownCaseResult.runs[0]!.caseId = 'not-selected'
    const unknownCaseResultPath = path.join(data.root, 'unknown-case-result.json')
    await writeFile(unknownCaseResultPath, `${JSON.stringify(unknownCaseResult, null, 2)}\n`)
    await expect(execFileAsync(process.execPath, evalCliArgs(
      'result', 'validate', unknownCaseResultPath,
      '--spec', data.specPath, '--audit', data.auditPath,
    ))).rejects.toMatchObject({ code: 1 })
    await expect(execFileAsync(process.execPath, evalCliArgs(
      'inspect-result', unknownCaseResultPath,
      '--spec', data.specPath, '--audit', data.auditPath,
    ))).rejects.toMatchObject({ code: 1 })
  })

  it.skipIf(process.platform !== 'linux')(
    'accepts the per-run unmanaged CLI flag and records its evidence',
    async () => {
      const data = await fixture()
      const providerPath = path.join(data.root, 'provider.mjs')
      await writeFile(providerPath, [
        "let input = ''",
        "process.stdin.setEncoding('utf8')",
        "process.stdin.on('data', (chunk) => { input += chunk })",
        "process.stdin.on('end', () => {",
        '  JSON.parse(input)',
        '  process.stdout.write(JSON.stringify({ version: 1, usage: null, grade: { passed: true, score: 1 } }))',
        '})',
        '',
      ].join('\n'))
      data.spec.provider = { type: 'custom-process', command: [process.execPath, providerPath] }
      data.audit.providerDigest = computeEvalProviderDigest(data.spec.provider)
      await Promise.all([
        writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`),
        writeFile(data.auditPath, `${JSON.stringify(data.audit, null, 2)}\n`),
      ])

      const completed = await execFileAsync(process.execPath, evalCliArgs(
        'run', data.specPath,
        '--audit', data.auditPath,
        '--allow-unmanaged-processes',
      ), {
        env: {
          PATH: process.env.PATH,
          CODEX_HOME: process.env.CODEX_HOME,
          CODEX_PERMISSION_PROFILE: ':read-only',
        },
      })
      const output = JSON.parse(completed.stdout) as {
        result: { version: number; processManagement: { mode: string } }
      }
      expect(output.result).toMatchObject({
        version: 2,
        processManagement: { mode: 'unmanaged-confirmed' },
      })
      expect(completed.stderr).toContain('Unmanaged process execution was explicitly authorized')
    },
  )

  it('rejects every provider and suite kind mismatch during spec validation', async () => {
    const mismatches = [
      {
        provider: 'codex-trigger' as const,
        suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
        evalCase: {
          id: 'case-1', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Returns the result.'],
        },
      },
      {
        provider: 'codex-conversation' as const,
        suite: { kind: 'trigger', unitUnderTest: 'fixture-skill' },
        evalCase: {
          id: 'case_1', split: 'validation', tags: [],
          input: { query: 'Use the fixture Skill.', expectedLoad: true },
        },
      },
      {
        provider: { type: 'custom-process' as const, command: ['fixture-provider'] },
        suite: { kind: 'conversation', unitUnderTest: 'fixture-skill' },
        evalCase: {
          id: 'case-1', split: 'validation', tags: [], prompt: 'Do work.',
          assertions: ['Returns the result.'],
        },
      },
    ]
    for (const mismatch of mismatches) {
      const data = await fixture()
      const casesPath = path.join(data.root, 'cases.json')
      await writeFile(casesPath, `${JSON.stringify({
        version: 1,
        suite: mismatch.suite,
        cases: [mismatch.evalCase],
      }, null, 2)}\n`)
      data.spec.cases.digest = await computeEvalFileDigest(casesPath)
      data.spec.provider = mismatch.provider
      await writeFile(data.specPath, `${JSON.stringify(data.spec, null, 2)}\n`)
      const error = await execFileAsync(process.execPath, evalCliArgs(
        'spec', 'validate', data.specPath,
      )).catch((caught) => caught as { code: number; stdout: string })
      expect(error).toMatchObject({ code: 1 })
      expect(JSON.parse((error as { stdout: string }).stdout)).toMatchObject({
        valid: false,
        errors: expect.arrayContaining([expect.stringContaining('selected suite kind')]),
      })
      await expect(readdir(path.join(data.root, 'output'))).rejects.toThrow()
    }
  })
})
