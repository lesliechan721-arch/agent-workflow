import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CODEX_WORKFLOW_ARTIFACTS,
  codexWorkflowAdapterEnvironment,
  codexWorkflowFrameIsForRoot,
  executeCodexWorkflowProvider,
  normalizeCodexWorkflowRollouts,
  parseCodexWorkflowRequest,
  type CodexEvalRuntimeConfig,
  type CodexWorkflowEvidence,
  type CodexWorkflowRequest,
  type CodexWorkflowTransport,
  type ProcessTreeDependencies,
} from '../../src/index.js'
import { codexWorkflowMissingFinalMessageDiagnostic } from '../../src/codex-workflow.js'
import * as appServer from '../../src/codex-eval-app-server.js'
import * as providers from '../../src/providers.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runtime(root: string, secret = 'workflow-runtime-secret'): CodexEvalRuntimeConfig {
  return {
    inherited: false,
    model: null,
    modelProvider: 'openai',
    credentialSource: 'none',
    configToml: '',
    providerEnvironment: {},
    sourceCodexHome: root,
    copyOpenAiAuth: false,
    sensitiveEnvironmentNames: [],
    sensitiveValues: [secret],
    evidenceDigest: `sha256:${'1'.repeat(64)}`,
  }
}

function request(protocol: 'v1' | 'v2' = 'v2'): CodexWorkflowRequest {
  return {
    version: 1,
    prompt: 'Run the workflow.',
    sandbox: 'read-only',
    model: 'allowed-model',
    developerInstructions: 'Follow the workflow contract.',
    roles: [{
      name: 'explorer',
      description: 'Inspect the workspace.',
      configFile: '.codex/agents/explorer.toml',
    }],
    multiAgent: {
      protocol,
      maxDepth: 2,
      hideSpawnAgentMetadata: protocol === 'v2',
      exposeSpawnAgentModelOverrides: protocol === 'v2',
    },
  }
}

function deterministicProcessTree(): ProcessTreeDependencies {
  let marker = ''
  let sentinelAlive = false
  return {
    platform: process.platform,
    createSentinel: async (_markerEnvironmentVariable, value) => {
      marker = value
      sentinelAlive = true
      return {
        pid: 900_001,
        stop: async () => { sentinelAlive = false },
      }
    },
    execFile: (_command, args, _options, callback) => callback(
      null,
      args.some((arg) => arg.includes('command='))
      ? sentinelAlive
        ? `900001 1 900001 S sentinel-start node AW_AGENT_SKILL_EVAL_PROCESS_MARKER=${marker}`
        : ''
      : sentinelAlive
        ? '900001 1 900001 S Mon Aug 24 12:00:00 2026'
        : '',
    ),
  }
}

async function adapterFixture(): Promise<{
  root: string
  workspace: string
  fixtures: string
  output: string
  adapter: string
  processTree: ProcessTreeDependencies
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-test-')))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const fixtures = path.join(root, 'fixtures')
  const output = path.join(root, 'output')
  const adapter = path.join(root, 'adapter.mjs')
  const processTree = deterministicProcessTree()
  await Promise.all([
    mkdir(path.join(workspace, '.codex', 'agents'), { recursive: true }),
    mkdir(fixtures),
    mkdir(output),
  ])
  await writeFile(path.join(workspace, '.codex', 'agents', 'explorer.toml'), 'name = "explorer"\n')
  await writeFile(adapter, [
    "import fs from 'node:fs'",
    "const input = JSON.parse(fs.readFileSync(0, 'utf8'))",
    "const log = input.paths.output + '/adapter-log.jsonl'",
    "fs.appendFileSync(log, JSON.stringify({ input, env: Object.keys(process.env).sort() }) + '\\n')",
    'const wait = Number(input.case[input.phase + "Delay"] ?? 0)',
    'if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))',
    'if (input.phase === "prepare") {',
    '  if (input.case.prepareInvalid) process.stdout.write("{}")',
    '  else process.stdout.write(JSON.stringify({',
    '    version: 1,',
    '    prompt: "Run the workflow.",',
    '    sandbox: input.case.writable ? "workspace-write" : "read-only",',
    '    model: input.case.defaultModel ? null : "allowed-model",',
    '    developerInstructions: "Follow the workflow contract.",',
    '    roles: [{ name: "explorer", description: "Inspect the workspace.", configFile: ".codex/agents/explorer.toml" }],',
    '    multiAgent: { protocol: input.case.protocol ?? "v2", maxDepth: 2, hideSpawnAgentMetadata: input.case.protocol !== "v1", exposeSpawnAgentModelOverrides: input.case.protocol !== "v1" },',
    '    ...(input.case.evaluation ? { evaluation: input.case.evaluation } : {})',
    '  }))',
    '} else {',
    '  const evidence = JSON.parse(fs.readFileSync(input.paths.evidence, "utf8"))',
    '  if (evidence.version !== 1) throw new Error("missing evidence")',
    '  process.stdout.write(JSON.stringify(input.case.gradeInvalid',
    '    ? { passed: true, score: 1, usage: null }',
    '    : { passed: true, score: 1, details: { source: "normalized-evidence" } }))',
    '}',
    '',
  ].join('\n'))
  return { root, workspace, fixtures, output, adapter, processTree }
}

function execution(secret = 'workflow-runtime-secret') {
  const evidence = {
    version: 1,
    rootThreadId: 'root-thread',
    completion: { status: 'completed', turnStatus: 'completed', durationMs: 10 },
    termination: { reason: 'completed', appServerProcessTreeCleanupConfirmed: true },
    usage: { inputTokens: 3, outputTokens: 2 },
    finalMessage: `final ${secret}`,
    workspaceDiff: { added: [], removed: [], modified: [] },
    skillLoads: [],
    threadGraph: [],
    collaborationCalls: [],
    leafCalls: [],
    cleanup: { isolatedCodexHomeRemoved: true },
  } as CodexWorkflowEvidence
  return {
    evidence,
    trace: [{ value: secret }],
    modelOutput: `final ${secret}`,
    usage: { inputTokens: 3, outputTokens: 2 },
  }
}

describe('codex-workflow provider', () => {
  it.each(['structured', 'text', 'unrelated', 'setup', 'grader-error'] as const)(
    'runs the Engine-owned %s interaction loop with a deterministic RPC peer and independent matcher seam',
    async (mode) => {
      const fixture = await adapterFixture()
      const nodeTestFile = path.join(fixture.workspace, 'runtime.test.mjs')
      if (mode === 'structured') {
        await writeFile(nodeTestFile, "import test from 'node:test'; test('runtime module loads', () => {});\n")
      }
      const hiddenAnswer = 'Export the authorized collection.'
      const turns: string[] = []
      const responses: unknown[] = []
      let codexHome = ''
      let cleaned = false
      const evaluation = {
        artifacts: ['product.txt'],
        checks: [{ name: 'actual-result', criterion: 'The actual product follows the delivered answer.' }],
        interactions: [{ id: 'scope', when: 'A genuine question about export collection.', answer: hiddenAnswer, protectedPaths: ['product.txt'] }],
        ...(mode === 'setup' ? { setupPrompt: 'Create the actual setup precondition.' } : {}),
      }
      const grader = vi.fn(async ({ prompt }: { prompt: string }) => {
        if (mode === 'grader-error' && !prompt.includes('details.questionId')) {
          throw new Error('Deterministic grader input rejection.')
        }
        return {
        output: JSON.stringify(prompt.includes('details.questionId')
          ? { passed: mode !== 'unrelated', score: mode === 'unrelated' ? 0 : 1,
              details: { questionId: mode === 'structured' ? 'scope-question' : 'text' } }
          : { passed: true, score: 1, details: { checks: [{ name: 'actual-result', verdict: 'pass', evidence: 'Deterministic test seam, not a real model verdict.' }] } }),
        usage: { inputTokens: 2, outputTokens: 1 }, mechanicalPassed: true,
        }
      })
      vi.spyOn(providers, 'createCodexGrader').mockReturnValue(grader)
      // The RPC seam exercises the real Engine loop, file observation, and lifecycle.
      // It is not native-tool, model, or OS-containment qualification.
      const admission = vi.spyOn(appServer, 'assertHostReadContainmentAvailable').mockResolvedValue()
      class Peer {
        private handlers = new Set<(frame: Record<string, unknown>) => unknown>()
        private failure: ((error: Error) => void) | undefined
        constructor(options: { env: NodeJS.ProcessEnv }) { codexHome = options.env.CODEX_HOME! }
        async initialize() {
          if (mode === 'structured' && process.platform === 'darwin') {
            // Exercise the emitted OS write permission before runtime cleanup.
            const profile = admission.mock.calls[0]![0]
            const target = path.join(await realpath(codexHome), 'state-probe.txt')
            await promisify(execFile)('/usr/bin/sandbox-exec', ['-p', profile, process.execPath,
              '--input-type=module', '-e',
              `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(target)}, 'state');`],
            { cwd: fixture.workspace, env: { PATH: process.env.PATH }, timeout: 5_000 })
            expect(await readFile(target, 'utf8')).toBe('state')
          }
          await writeRollout(codexHome, 'root', [session('root'), developer()])
        }
        onFrame(handler: (frame: Record<string, unknown>) => unknown) { this.handlers.add(handler); return () => this.handlers.delete(handler) }
        onFailure(handler: (error: Error) => void) { this.failure = handler; return () => { this.failure = undefined } }
        private emit(frame: Record<string, unknown>) {
          for (const handler of this.handlers) void Promise.resolve(handler(frame)).catch((error: Error) => this.failure?.(error))
        }
        private complete(message: string) {
          this.emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'root', tokenUsage: { total: { inputTokens: 10, outputTokens: 4 } } } })
          this.emit({ method: 'item/completed', params: { threadId: 'root', item: { type: 'agentMessage', phase: 'final_answer', text: message } } })
          this.emit({ method: 'turn/completed', params: { threadId: 'root', turn: { status: 'completed' } } })
        }
        private async implement() {
          await writeFile(path.join(fixture.workspace, 'product.txt'), hiddenAnswer)
          this.emit({ method: 'item/completed', params: { threadId: 'root', item: { type: 'fileChange', changes: [{ path: path.join(fixture.workspace, 'product.txt'), kind: { type: 'add' } }] } } })
          this.complete('Implementation complete.')
        }
        async sendRequest(method: string, params: { input?: Array<{ text: string }> }) {
          if (method === 'thread/start') return { thread: { id: 'root' } }
          if (method !== 'turn/start') throw new Error(`Unexpected RPC: ${method}`)
          const prompt = params.input![0]!.text
          turns.push(prompt)
          if (mode === 'setup' && turns.length === 1) this.complete('Setup complete.')
          else if (prompt === hiddenAnswer) await this.implement()
          else if (mode === 'structured') this.emit({
            method: 'item/tool/requestUserInput', id: 'request-1',
            params: { threadId: 'root', questions: [{ id: 'scope-question', question: 'Which customer collection?' }] },
          })
          else this.complete(mode === 'unrelated' ? 'Work complete, no choice needed.' : 'Which customer collection should be exported?')
          return {}
        }
        async respond(id: string, response: { answers: Record<string, { answers: string[] }> }) {
          responses.push({ id, response })
          if (response.answers['scope-question']?.answers[0] === hiddenAnswer) await this.implement()
          else this.complete('No product decision available.')
        }
        async cleanup() { cleaned = true }
        scrub<T>(value: T): T { return value }
      }
      vi.spyOn(appServer, 'EvalAppServerSession').mockImplementation((function (options: { env: NodeJS.ProcessEnv }) {
        return new Peer(options)
      }) as never)
      const execution = executeCodexWorkflowProvider({
        provider: { type: 'codex-workflow', command: ['node', 'adapter.mjs'], allowedModels: ['allowed-model'] },
        evalRoot: fixture.root,
        input: { case: { id: mode, evaluation, writable: true }, variant: 'current', attempt: 1,
          workspacePath: fixture.workspace, fixturesPath: fixture.fixtures, outputDir: fixture.output, timeoutMs: 5_000 },
        codexRuntime: runtime(), sourceEnv: { PATH: process.env.PATH },
        processTree: fixture.processTree,
      })
      if (mode === 'grader-error') {
        await expect(execution).rejects.toThrow('Deterministic grader input rejection')
        const evidence = JSON.parse(await readFile(path.join(fixture.output, 'workflow-evidence.json'), 'utf8'))
        expect(evidence.completion.turnStatus).toBe('completed')
        expect(evidence.evaluation).toMatchObject({ complete: false, checks: [] })
        expect(evidence.evaluation.observations).toContainEqual(expect.objectContaining({ threadId: 'root' }))
        expect(evidence.evaluation.snapshots.at(-1)[0].text).toBe(hiddenAnswer)
        expect(JSON.parse(await readFile(path.join(fixture.output, 'workflow-trace.json'), 'utf8'))).not.toHaveLength(0)
        expect(await readFile(path.join(fixture.output, 'model-output.txt'), 'utf8')).toBe('Implementation complete.\n')
        expect(cleaned).toBe(true)
        await expect(readFile(path.join(codexHome, 'config.toml'))).rejects.toThrow()
        expect(grader).toHaveBeenCalledTimes(2)
        await expect(readFile(path.join(fixture.output, 'provider-result.json'))).rejects.toThrow()
        return
      }
      const result = await execution
      const actual = JSON.parse(await readFile(path.join(fixture.output, 'workflow-evidence.json'), 'utf8'))
      if (mode === 'structured' && process.platform === 'darwin') {
        // Actual OS check of the emitted profile, without any model/native Codex run.
        const profile = admission.mock.calls[0]![0]
        const source = [
          "import fs from 'node:fs'; import assert from 'node:assert/strict';",
          `assert.equal(fs.readFileSync(${JSON.stringify(path.join(fixture.workspace, 'product.txt'))},'utf8'),${JSON.stringify(hiddenAnswer)});`,
          `assert.throws(()=>fs.readFileSync(${JSON.stringify(fixture.adapter)}),error=>error.code==='EPERM'||error.code==='EACCES');`,
          `assert.throws(()=>fs.readdirSync(${JSON.stringify(fixture.root)}),error=>error.code==='EPERM'||error.code==='EACCES');`,
          `assert.throws(()=>fs.readFileSync(${JSON.stringify(path.join(fixture.output, 'workflow-evidence.json'))}),error=>error.code==='EPERM'||error.code==='EACCES');`,
        ].join('\n')
        await promisify(execFile)('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '--input-type=module', '-e', source], {
          cwd: fixture.workspace, env: { PATH: process.env.PATH }, timeout: 5_000,
        })
        await promisify(execFile)('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '--test', nodeTestFile], {
          cwd: fixture.workspace, env: { PATH: process.env.PATH }, timeout: 5_000,
        })
      }
      expect(cleaned).toBe(true)
      await expect(readFile(path.join(codexHome, 'config.toml'))).rejects.toThrow()
      expect(grader).toHaveBeenCalledTimes(2)
      expect(grader.mock.calls[0]![0].prompt).not.toContain(hiddenAnswer)
      expect(result.usage).toEqual({ inputTokens: 14, outputTokens: 6 })
      if (mode === 'unrelated') {
        expect(turns).toHaveLength(1)
        expect(actual.evaluation.decisions[0].status).toBe('rejected')
        expect(result.grade.passed).toBe(false)
        await expect(readFile(path.join(fixture.workspace, 'product.txt'))).rejects.toThrow()
      } else {
        expect(result.grade.passed).toBe(true)
        expect(actual.evaluation.decisions[0].answer).toBe(hiddenAnswer)
        expect(actual.evaluation.decisions[0].answerOrdinal).toBeGreaterThan(actual.evaluation.decisions[0].questionOrdinal)
        expect(await readFile(path.join(fixture.workspace, 'product.txt'), 'utf8')).toBe(hiddenAnswer)
        expect(turns).toHaveLength(mode === 'structured' ? 1 : mode === 'setup' ? 3 : 2)
        if (mode === 'structured') expect(responses).toHaveLength(1)
        if (mode === 'setup') expect(actual.evaluation.measurementStart).toBeGreaterThan(0)
      }
    },
  )

  it('accepts opt-in bounded evaluation without exposing hidden answers in the subject prompt', async () => {
    const fixture = await adapterFixture()
    const evaluation = {
      artifacts: ['src/export.js'],
      checks: [{ name: 'decision', criterion: 'The actual user choice controls the exported collection.' }],
      interactions: [{
        id: 'export-scope',
        when: 'The coordinator asks which customer collection to export.',
        answer: 'Export the complete authorized collection.',
        protectedPaths: ['src/export.js'],
      }],
    }
    const parsed = await parseCodexWorkflowRequest(
      { ...request(), evaluation }, ['allowed-model'], fixture.workspace,
    )
    expect(parsed).toEqual({ ...request(), evaluation })
    expect(parsed.prompt).not.toContain(evaluation.interactions[0]!.answer)
    await expect(parseCodexWorkflowRequest({
      ...request(), evaluation: { ...evaluation, artifacts: ['../answer.json'] },
    }, ['allowed-model'], fixture.workspace)).rejects.toThrow('relative')
  })

  it('validates a bounded request and rejects model, role path, and unknown-field drift', async () => {
    const fixture = await adapterFixture()
    await expect(parseCodexWorkflowRequest(
      request(),
      ['allowed-model'],
      fixture.workspace,
    )).resolves.toEqual(request())
    await expect(parseCodexWorkflowRequest(
      { ...request(), model: 'unapproved' },
      ['allowed-model'],
      fixture.workspace,
    )).rejects.toThrow('allowedModels')
    await expect(parseCodexWorkflowRequest(
      { ...request(), arbitraryConfig: {} },
      ['allowed-model'],
      fixture.workspace,
    )).rejects.toThrow('unknown field')
    await expect(parseCodexWorkflowRequest({
      ...request(),
      roles: [{ ...request().roles[0]!, configFile: '../outside.toml' }],
    }, ['allowed-model'], fixture.workspace)).rejects.toThrow('workspace-relative')
  })

  it('keeps adapter credentials and proxy variables out of its isolated environment', async () => {
    const env = codexWorkflowAdapterEnvironment({
      PATH: '/bin',
      LANG: 'C',
      LC_ALL: 'C',
      OPENAI_API_KEY: 'secret',
      HTTP_PROXY: 'http://proxy.invalid',
      HTTPS_PROXY: 'http://proxy.invalid',
      CODEX_HOME: '/private/codex',
      AW_SKILL_EVAL_CODEX_MODEL: 'private-model',
    }, '/attempt', 'prepare')
    expect(env).toMatchObject({
      PATH: '/bin',
      LANG: 'C',
      LC_ALL: 'C',
      NO_COLOR: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('HTTP_PROXY')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('AW_SKILL_EVAL_CODEX_MODEL')
  })

  it.skipIf(process.platform === 'win32').each([
    { protocol: 'v1', expectedModel: 'gpt-5.6-luna' },
    { protocol: 'v2', expectedModel: null },
  ] as const)('selects the compatible default model for $protocol workflows', async ({ protocol, expectedModel }) => {
    const fixture = await adapterFixture()
    const run = vi.fn<CodexWorkflowTransport['run']>(async () => execution())
    await executeCodexWorkflowProvider({
      provider: {
        type: 'codex-workflow',
        command: [process.execPath, fixture.adapter],
        allowedModels: [],
      },
      evalRoot: fixture.root,
      input: {
        case: { defaultModel: true, protocol },
        variant: 'current',
        attempt: 1,
        workspacePath: fixture.workspace,
        fixturesPath: fixture.fixtures,
        outputDir: fixture.output,
        timeoutMs: 5_000,
      },
      sourceEnv: { PATH: process.env.PATH },
      codexRuntime: { ...runtime(fixture.root), model: 'gpt-6-luna' },
      processTree: fixture.processTree,
      transport: { run },
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]![0].request.model).toBe(expectedModel)
    expect(run.mock.calls[0]![0].codexRuntime.model).toBe('gpt-6-luna')
  })

  it.skipIf(process.platform === 'win32')(
    'uses exact prepare and grade phases, one normalized evidence input, and redacted artifacts',
    async () => {
      const fixture = await adapterFixture()
      const transport: CodexWorkflowTransport = { run: vi.fn(async () => execution()) }
      const result = await executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, fixture.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: fixture.root,
        input: {
          case: {},
          variant: 'current',
          attempt: 1,
          workspacePath: fixture.workspace,
          fixturesPath: fixture.fixtures,
          outputDir: fixture.output,
          timeoutMs: 5_000,
        },
        sourceEnv: {
          PATH: process.env.PATH,
          OPENAI_API_KEY: 'must-not-reach-adapter',
          HTTPS_PROXY: 'http://must-not-reach-adapter.invalid',
        },
        codexRuntime: runtime(fixture.root),
        processTree: fixture.processTree,
        transport,
      })
      expect(result).toEqual({
        usage: { inputTokens: 3, outputTokens: 2 },
        grade: { passed: true, score: 1, details: { source: 'normalized-evidence' } },
        artifacts: CODEX_WORKFLOW_ARTIFACTS,
      })
      const log = (await readFile(path.join(fixture.output, 'adapter-log.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line))
      expect(log.map((entry) => entry.input.phase)).toEqual(['prepare', 'grade'])
      expect(Object.keys(log[0].input)).toEqual([
        'version', 'case', 'variant', 'attempt', 'phase', 'paths',
      ])
      expect(log[0].input.paths).toEqual({
        workspace: fixture.workspace,
        fixtures: fixture.fixtures,
        output: fixture.output,
      })
      expect(log[1].input.paths).toEqual({
        workspace: fixture.workspace,
        fixtures: fixture.fixtures,
        output: fixture.output,
        evidence: path.join(fixture.output, 'workflow-evidence.json'),
        modelOutput: path.join(fixture.output, 'model-output.txt'),
      })
      for (const entry of log) {
        expect(entry.env).not.toContain('OPENAI_API_KEY')
        expect(entry.env).not.toContain('HTTPS_PROXY')
        expect(entry.env).not.toContain('CODEX_HOME')
      }
      const artifacts = await Promise.all(CODEX_WORKFLOW_ARTIFACTS.map((artifact) =>
        readFile(path.join(fixture.output, artifact.path), 'utf8')))
      expect(artifacts.join('\n')).not.toContain('workflow-runtime-secret')
      expect(artifacts.join('\n')).toContain('[redacted]')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'passes explicitly unmanaged execution to both adapters and the Codex transport',
    async () => {
      const fixture = await adapterFixture()
      const run: CodexWorkflowTransport['run'] = vi.fn(async (input) => {
        expect(input.processManagement).toMatchObject({ mode: 'unmanaged-confirmed' })
        return execution()
      })
      await expect(executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, fixture.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: fixture.root,
        input: {
          case: {},
          variant: 'current',
          attempt: 1,
          workspacePath: fixture.workspace,
          fixturesPath: fixture.fixtures,
          outputDir: fixture.output,
          timeoutMs: 5_000,
        },
        sourceEnv: { PATH: process.env.PATH },
        codexRuntime: runtime(fixture.root),
        processManagement: {
          mode: 'unmanaged-confirmed',
          inspectionAvailable: false,
          userAcknowledged: true,
          descendantCleanupGuaranteed: false,
          limitation: 'Only the direct child is targeted.',
        },
        transport: { run },
      })).resolves.toMatchObject({
        grade: { passed: true, score: 1 },
      })
      expect(run).toHaveBeenCalledOnce()
    },
  )

  it.skipIf(process.platform === 'win32')(
    'shares one deadline and stops without retry or grade after prepare or Codex failure',
    async () => {
      const prepareFailure = await adapterFixture()
      const unusedTransport = { run: vi.fn(async () => execution()) }
      await expect(executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, prepareFailure.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: prepareFailure.root,
        input: {
          case: { prepareInvalid: true },
          variant: 'current', attempt: 1,
          workspacePath: prepareFailure.workspace,
          fixturesPath: prepareFailure.fixtures,
          outputDir: prepareFailure.output,
          timeoutMs: 5_000,
        },
        codexRuntime: runtime(prepareFailure.root),
        processTree: prepareFailure.processTree,
        transport: unusedTransport,
      })).rejects.toThrow('missing')
      expect(unusedTransport.run).not.toHaveBeenCalled()
      expect((await readFile(path.join(prepareFailure.output, 'adapter-log.jsonl'), 'utf8'))
        .trim().split('\n')).toHaveLength(1)

      const codexFailure = await adapterFixture()
      const failingTransport = { run: vi.fn(async () => { throw new Error('Codex failed') }) }
      await expect(executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, codexFailure.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: codexFailure.root,
        input: {
          case: {}, variant: 'current', attempt: 1,
          workspacePath: codexFailure.workspace,
          fixturesPath: codexFailure.fixtures,
          outputDir: codexFailure.output,
          timeoutMs: 5_000,
        },
        codexRuntime: runtime(codexFailure.root),
        processTree: codexFailure.processTree,
        transport: failingTransport,
      })).rejects.toThrow('Codex failed')
      expect((await readFile(path.join(codexFailure.output, 'adapter-log.jsonl'), 'utf8'))
        .trim().split('\n')).toHaveLength(1)

      const deadline = await adapterFixture()
      const delayedTransport = { run: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        return execution()
      }) }
      await expect(executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, deadline.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: deadline.root,
        input: {
          case: { gradeDelay: 3_500 },
          variant: 'current', attempt: 1,
          workspacePath: deadline.workspace,
          fixturesPath: deadline.fixtures,
          outputDir: deadline.output,
          timeoutMs: 4_000,
        },
        codexRuntime: runtime(deadline.root),
        processTree: deadline.processTree,
        transport: delayedTransport,
      })).rejects.toThrow(/timed out|timeout/u)
      const phases = (await readFile(path.join(deadline.output, 'adapter-log.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line).input.phase)
      expect(phases).toEqual(['prepare', 'grade'])
    },
  )

  it.skipIf(process.platform === 'win32')(
    'fails closed before grade when completed model evidence has no token usage',
    async () => {
      const fixture = await adapterFixture()
      const missingUsage = execution()
      missingUsage.usage = null as never
      missingUsage.evidence.usage = null
      await expect(executeCodexWorkflowProvider({
        provider: {
          type: 'codex-workflow',
          command: [process.execPath, fixture.adapter],
          allowedModels: ['allowed-model'],
        },
        evalRoot: fixture.root,
        input: {
          case: {}, variant: 'current', attempt: 1,
          workspacePath: fixture.workspace,
          fixturesPath: fixture.fixtures,
          outputDir: fixture.output,
          timeoutMs: 5_000,
        },
        codexRuntime: runtime(fixture.root),
        processTree: fixture.processTree,
        transport: { run: vi.fn(async () => missingUsage) },
      })).rejects.toThrow('required token usage evidence')
      const phases = (await readFile(path.join(fixture.output, 'adapter-log.jsonl'), 'utf8'))
        .trim().split('\n').map((line) => JSON.parse(line).input.phase)
      expect(phases).toEqual(['prepare'])
      await expect(readFile(path.join(fixture.output, 'workflow-evidence.json'))).rejects.toThrow()
    },
  )

  it('rejects Windows before adapter or model transport starts', async () => {
    const fixture = await adapterFixture()
    const transport = { run: vi.fn(async () => execution()) }
    await expect(executeCodexWorkflowProvider({
      provider: {
        type: 'codex-workflow',
        command: [process.execPath, fixture.adapter],
        allowedModels: ['allowed-model'],
      },
      evalRoot: fixture.root,
      input: {
        case: {}, variant: 'current', attempt: 1,
        workspacePath: fixture.workspace,
        fixturesPath: fixture.fixtures,
        outputDir: fixture.output,
        timeoutMs: 1_000,
      },
      codexRuntime: runtime(fixture.root),
      transport,
      platform: 'win32',
    })).rejects.toThrow('no model was started')
    expect(transport.run).not.toHaveBeenCalled()
    await expect(readFile(path.join(fixture.output, 'adapter-log.jsonl'))).rejects.toThrow()
  })

  it('accepts only exact root-thread completion identity', () => {
    expect(codexWorkflowFrameIsForRoot({
      method: 'turn/completed',
      params: { threadId: 'grandchild', turn: { status: 'completed' } },
    }, 'root')).toBe(false)
    expect(codexWorkflowFrameIsForRoot({
      method: 'turn/completed',
      params: { threadId: 'root', turn: { status: 'completed' } },
    }, 'root')).toBe(true)
    expect(codexWorkflowFrameIsForRoot({
      method: 'turn/completed',
      params: { turn: { status: 'completed' } },
    }, 'root')).toBe(false)
  })

  it('reports only safe structural counts when a completed root turn has no final message', () => {
    const secret = 'secret prompt /private/secret/workspace'
    const diagnostic = codexWorkflowMissingFinalMessageDiagnostic({
      rootThreadId: 'root',
      turnStatus: 'completed',
      usage: { inputTokens: 10 },
      frames: [{
        method: 'item/completed',
        params: {
          threadId: 'child',
          item: { type: 'agentMessage', phase: 'final_answer', text: secret },
        },
      }, {
        method: 'turn/completed',
        params: { threadId: 'root', turn: { status: 'completed', prompt: secret } },
      }],
    })
    expect(diagnostic).toEqual({
      rootTurnStatus: 'completed',
      rootFinalAgentMessageCount: 0,
      otherThreadFinalAgentMessageCount: 1,
      usagePresent: true,
      frameCount: 2,
    })
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
    expect(JSON.stringify(diagnostic)).not.toContain('/private/secret/workspace')
  })
})

async function writeRollout(
  codexHome: string,
  name: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const directory = path.join(codexHome, 'sessions', name)
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'rollout.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  )
}

function developer(text = 'developer full text <multi_agent_mode> Child agents can also spawn their own sub-agents') {
  return {
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] },
  }
}

function session(threadId: string, parentThreadId?: string) {
  return {
    type: 'session_meta',
    payload: {
      id: threadId,
      source: parentThreadId ? {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            agent_path: `/root/${threadId}`,
            agent_role: 'explorer',
          },
        },
      } : {},
    },
  }
}

function v1CodeModeSpawn(options: {
  outerCallId: string
  innerCallId: string
  senderThreadId: string
  receiverThreadId: string
  arguments: Record<string, unknown>
  input?: string
}): Record<string, unknown>[] {
  const variable = 'result'
  return [{
    type: 'response_item',
    payload: {
      type: 'custom_tool_call', name: 'exec', call_id: options.outerCallId,
      input: options.input
        ?? `const ${variable} = await tools.multi_agent_v1__spawn_agent(${JSON.stringify(options.arguments)});\ntext(${variable});`,
    },
  }, {
    type: 'event_msg',
    payload: {
      type: 'item_completed', thread_id: options.senderThreadId,
      item: {
        type: 'CollabAgentToolCall', id: options.innerCallId, tool: 'spawn_agent',
        sender_thread_id: options.senderThreadId,
        receiver_thread_ids: [options.receiverThreadId],
        prompt: options.arguments.message,
        status: 'completed',
      },
    },
  }, {
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output', call_id: options.outerCallId,
      output: [{ type: 'input_text', text: 'spawned' }],
    },
  }]
}

async function normalizeV1CodeModeInput(
  name: string,
  input: string,
  message: string,
  options: {
    spawnOverrides?: Record<string, unknown>
    terminalRuntime?: { model?: string; reasoningEffort?: string }
  } = {},
): Promise<Awaited<ReturnType<typeof normalizeCodexWorkflowRollouts>>> {
  const root = await mkdtemp(path.join(os.tmpdir(), `codex-workflow-v1-template-${name}-`))
  roots.push(root)
  await writeRollout(root, 'root', [
    session('root'),
    developer(),
    ...v1CodeModeSpawn({
      outerCallId: 'outer-spawn-1',
      innerCallId: 'spawn-1',
      senderThreadId: 'root',
      receiverThreadId: 'child',
      arguments: {
        agent_type: 'explorer',
        message,
        ...options.spawnOverrides,
        fork_context: false,
      },
      input,
    }),
  ])
  await writeRollout(root, 'child', [
    session('child', 'root'),
    developer('child developer full text'),
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] },
    },
  ])
  return normalizeCodexWorkflowRollouts({
    codexHome: root,
    rootThreadId: 'root',
    request: { ...request('v1'), model: null },
    runtime: runtime(root),
    appServerFrames: [{
      method: 'item/completed',
      params: {
        threadId: 'root',
        item: {
          type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
          senderThreadId: 'root', receiverThreadId: 'child', prompt: message,
          ...options.terminalRuntime,
          agentsStates: { child: 'running' },
        },
      },
    }],
  })
}

describe('codex-workflow raw rollout normalization', () => {
  it('parses a multiline V1 code-mode spawn message from a template literal', async () => {
    const message = 'first line\nsecond `tick` \\ path \nnext\tcolumn 🚀 ! ${literal}'
    const input = [
      'const result = await tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      '  message: `first line',
      'second \\`tick\\` \\\\ path \\nnext\\tcolumn \\u{1F680} \\x21 \\${literal}`,',
      '  fork_context: false,',
      '});',
      'text(result);',
    ].join('\n')
    const normalized = await normalizeV1CodeModeInput('multiline', input, message)
    expect(normalized.collaborationCalls[0]?.arguments).toEqual(expect.objectContaining({ message }))
    expect(normalized.collaborationCalls[0]).not.toHaveProperty('effectiveRuntime')
  })

  it('parses the exact unawaited V1 wrapper with string and template messages', async () => {
    const stringMessage = 'plain child prompt'
    const stringInput = [
      'const result = tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      `  message: ${JSON.stringify(stringMessage)},`,
      '  fork_context: false,',
      '});',
      'text(result);',
    ].join('\n')
    const stringNormalized = await normalizeV1CodeModeInput(
      'unawaited-string',
      stringInput,
      stringMessage,
      { terminalRuntime: { model: 'effective-model', reasoningEffort: 'high' } },
    )
    expect(stringNormalized.collaborationCalls[0]).toEqual(expect.objectContaining({
      arguments: {
        agent_type: 'explorer',
        message: stringMessage,
        fork_context: false,
      },
      effectiveRuntime: { model: 'effective-model', reasoningEffort: 'high' },
    }))

    const templateMessage = 'first line\nsecond line'
    const templateInput = [
      'const result = tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      '  message: `first line',
      'second line`,',
      '  fork_context: false,',
      '});',
      'text(result);',
    ].join('\n')
    const templateNormalized = await normalizeV1CodeModeInput(
      'unawaited-template',
      templateInput,
      templateMessage,
    )
    expect(templateNormalized.collaborationCalls[0]?.arguments).toEqual(expect.objectContaining({
      message: templateMessage,
    }))
  })

  it('normalizes a full-history V1 spawn without agent_type and keeps runtime evidence separate', async () => {
    const message = 'full-history child prompt'
    const input = [
      'const result = await tools.multi_agent_v1__spawn_agent({',
      `  message: ${JSON.stringify(message)},`,
      '  model: "explicit-model",',
      '  reasoning_effort: "xhigh",',
      '  fork_context: true,',
      '});',
      'text(result);',
    ].join('\n')
    const normalized = await normalizeV1CodeModeInput(
      'full-history-no-role',
      input,
      message,
      { terminalRuntime: { model: 'effective-model', reasoningEffort: 'high' } },
    )

    expect(normalized.collaborationCalls[0]).toEqual(expect.objectContaining({
      arguments: {
        message,
        model: 'explicit-model',
        reasoning_effort: 'xhigh',
        fork_context: true,
      },
      effectiveRuntime: { model: 'effective-model', reasoningEffort: 'high' },
    }))
    expect(normalized.collaborationCalls[0]?.arguments).not.toHaveProperty('agent_type')
    expect(normalized.collaborationCalls[0]?.arguments).not.toHaveProperty('effectiveRuntime')
  })

  it('rejects near-match unawaited V1 wrappers', async () => {
    const message = 'child prompt'
    const argumentsSource = `{ agent_type: "explorer", message: ${JSON.stringify(message)}, fork_context: false }`
    const fixtures = [
      {
        name: 'alias',
        input: `const spawn = tools.multi_agent_v1__spawn_agent;\nconst result = spawn(${argumentsSource});\ntext(result);`,
      },
      {
        name: 'other-receiver',
        input: `const result = runtime.multi_agent_v1__spawn_agent(${argumentsSource});\ntext(result);`,
      },
      {
        name: 'destructure',
        input: `const { result } = tools.multi_agent_v1__spawn_agent(${argumentsSource});\ntext(result);`,
      },
      {
        name: 'extra-statement',
        input: `const result = tools.multi_agent_v1__spawn_agent(${argumentsSource});\ntext(result);\nlog(result);`,
      },
    ] as const

    for (const fixture of fixtures) {
      const error = await normalizeV1CodeModeInput(fixture.name, fixture.input, message)
        .then(() => '', (value: Error) => value.message)
      expect(error, fixture.name).toMatch(/Codex V1 code-mode spawn (?:prefix|suffix) is invalid\./u)
      if (fixture.name === 'destructure') {
        expect(error).toContain(
          '"await":"no","receiver":"tools","calleeFamily":"exact-v1-snake",'
          + '"exactSpawnCallee":"yes"',
        )
      }
    }
  })

  it('keeps explicit V1 spawn arguments separate from effective terminal runtime', async () => {
    const message = 'child prompt'
    const input = [
      'const result = await tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      `  message: ${JSON.stringify(message)},`,
      '  model: "explicit-model",',
      '  reasoning_effort: "medium",',
      '  fork_context: false,',
      '});',
      'text(result);',
    ].join('\n')
    const normalized = await normalizeV1CodeModeInput('runtime-layers', input, message, {
      spawnOverrides: { model: 'explicit-model', reasoning_effort: 'medium' },
      terminalRuntime: { model: 'effective-model', reasoningEffort: 'high' },
    })
    expect(normalized.collaborationCalls[0]).toEqual(expect.objectContaining({
      arguments: {
        agent_type: 'explorer',
        message,
        model: 'explicit-model',
        reasoning_effort: 'medium',
        fork_context: false,
      },
      effectiveRuntime: { model: 'effective-model', reasoningEffort: 'high' },
    }))
  })

  it('rejects interpolation in a V1 code-mode spawn template literal', async () => {
    const input = [
      'const result = await tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      '  message: `unsafe ${expression}`,',
      '  fork_context: false,',
      '});',
      'text(result);',
    ].join('\n')
    await expect(normalizeV1CodeModeInput('interpolation', input, 'unsafe value'))
      .rejects.toThrow('template literal interpolation is unsupported')
  })

  it('reports distinct safe structural fingerprints for invalid V1 wrapper phases', async () => {
    const secret = 'SECRET_MARKER /private/agents/root/explorer\nsecond secret line'
    const prefixInput = [
      '// @exec: {"yield_time_ms":30000}',
      '```js',
      `let privateVariable = await tools.multi_agent_v1__spawn_agent({ agent_type: "explorer", message: ${JSON.stringify(secret)}, fork_context: false });`,
      'text(privateVariable);',
      '```',
    ].join('\n')
    const prefixError = await normalizeV1CodeModeInput('invalid-prefix', prefixInput, secret)
      .then(() => '', (error: Error) => error.message)
    expect(prefixError).toBe(
      'Codex V1 code-mode spawn prefix is invalid. fingerprint='
      + '{"phase":"prefix","pragma":"yes","codeFence":"yes","declaration":"let",'
      + '"bindingForm":"identifier","await":"yes","receiver":"tools",'
      + '"calleeFamily":"exact-v1-snake","exactSpawnCallee":"yes","outputForm":"other"}',
    )

    const suffixInput = [
      'const privateVariable = await tools.multi_agent_v1__spawn_agent({',
      '  agent_type: "explorer",',
      `  message: ${JSON.stringify(secret)},`,
      '  fork_context: false,',
      '})',
      'return text(privateVariable);',
      `text(${JSON.stringify(secret)});`,
    ].join('\n')
    const suffixError = await normalizeV1CodeModeInput('invalid-suffix', suffixInput, secret)
      .then(() => '', (error: Error) => error.message)
    expect(suffixError).toBe(
      'Codex V1 code-mode spawn suffix is invalid. fingerprint='
      + '{"phase":"suffix","spawnCallSemicolon":"no","outputForm":"return-text",'
      + '"extraStatements":"yes"}',
    )

    for (const error of [prefixError, suffixError]) {
      expect(error).not.toContain('SECRET_MARKER')
      expect(error).not.toContain('/private/agents/root/explorer')
      expect(error).not.toContain('privateVariable')
      expect(error).not.toContain('second secret line')
    }
  })

  it('classifies each safe V1 prefix fingerprint enum without exposing input tokens', async () => {
    const secret = 'FINGERPRINT_SECRET /private/eval/agent.json'
    const argumentsSource = `{ agent_type: "explorer", message: ${JSON.stringify(secret)}, fork_context: false }`
    const fixtures = [
      {
        name: 'binding-identifier',
        prefix: 'let privateBinding = await tools.multi_agent_v1__spawn_agent',
        expected: { bindingForm: 'identifier', receiver: 'tools', calleeFamily: 'exact-v1-snake' },
      },
      {
        name: 'binding-object',
        prefix: 'const { privateBinding } = await tools.multi_agent_v1__spawn_agent',
        expected: { bindingForm: 'object-destructure', receiver: 'tools', calleeFamily: 'exact-v1-snake' },
      },
      {
        name: 'binding-array',
        prefix: 'const [privateBinding] = await tools.multi_agent_v1__spawn_agent',
        expected: { bindingForm: 'array-destructure', receiver: 'tools', calleeFamily: 'exact-v1-snake' },
      },
      {
        name: 'binding-other',
        prefix: 'const privateBinding: unknown = await tools.multi_agent_v1__spawn_agent',
        expected: { bindingForm: 'other', receiver: 'tools', calleeFamily: 'exact-v1-snake' },
      },
      {
        name: 'v1-namespaced-other',
        prefix: 'const privateBinding = await tools.multi_agent_v1__spawnAgent',
        expected: { bindingForm: 'identifier', receiver: 'tools', calleeFamily: 'v1-namespaced-other' },
      },
      {
        name: 'spawn-family-other',
        prefix: 'const privateBinding = await tools.multi_agent_v2__spawn_agent',
        expected: { bindingForm: 'identifier', receiver: 'tools', calleeFamily: 'spawn-family-other' },
      },
      {
        name: 'callee-other',
        prefix: 'const privateBinding = await tools.delegate',
        expected: { bindingForm: 'identifier', receiver: 'tools', calleeFamily: 'other' },
      },
      {
        name: 'receiver-other',
        prefix: 'const privateBinding = await runtime.multi_agent_v1__spawn_agent',
        expected: { bindingForm: 'identifier', receiver: 'other', calleeFamily: 'exact-v1-snake' },
      },
    ] as const

    for (const fixture of fixtures) {
      const input = `${fixture.prefix}(${argumentsSource});\ntext(privateBinding);`
      const message = await normalizeV1CodeModeInput(fixture.name, input, secret)
        .then(() => '', (error: Error) => error.message)
      const encoded = message.split('fingerprint=', 2)[1]
      expect(encoded, fixture.name).toBeDefined()
      const fingerprint = JSON.parse(encoded!) as Record<string, unknown>
      expect(fingerprint, fixture.name).toEqual(expect.objectContaining({
        phase: 'prefix',
        declaration: fixture.name === 'binding-identifier' ? 'let' : 'const',
        await: 'yes',
        exactSpawnCallee: fixture.expected.receiver === 'tools'
          && fixture.expected.calleeFamily === 'exact-v1-snake' ? 'yes' : 'no',
        ...fixture.expected,
      }))
      expect(Object.keys(fingerprint), fixture.name).not.toEqual(expect.arrayContaining([
        'callee', 'variable', 'string', 'raw', 'path', 'length', 'hash',
      ]))
      expect(message, fixture.name).not.toContain('FINGERPRINT_SECRET')
      expect(message, fixture.name).not.toContain('/private/eval/agent.json')
      expect(message, fixture.name).not.toContain('privateBinding')
    }
  })

  it('rejects a terminal V1 spawn when its rollout call omits fork_context', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-app-server-aliases-'))
    roots.push(root)
    await writeRollout(root, 'root', [session('root'), developer(), {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'root prompt' }] },
    }, ...v1CodeModeSpawn({
      outerCallId: 'outer-spawn-1',
      innerCallId: 'spawn-1',
      senderThreadId: 'root',
      receiverThreadId: 'child',
      arguments: {
        agent_type: 'explorer', message: 'child prompt',
      },
    })])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text'),
      {
        timestamp: '2026-08-30T00:00:04.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child prompt' }] },
      },
    ])
    const shared = {
      type: 'collabToolCall', status: 'completed', senderThreadId: 'root',
      receiverThreadId: 'child', agentsStates: { child: 'completed' },
    }
    await expect(normalizeCodexWorkflowRollouts({
      codexHome: root,
      rootThreadId: 'root',
      request: { ...request('v1'), model: null },
      runtime: runtime(root),
      appServerFrames: [{
        method: 'item/completed',
        params: {
          threadId: 'root',
          item: {
            ...shared, id: 'spawn-1', tool: 'spawnAgent', prompt: 'child prompt',
            agentsStates: { child: 'running' },
          },
        },
      }],
    })).rejects.toThrow('fork_context evidence must be boolean')
  })

  it('rejects ambiguous and lineage-conflicting V1 code-mode spawn evidence', async () => {
    const normalize = async (
      name: string,
      spawnArguments: Record<string, unknown>,
      repeated = false,
    ) => {
      const root = await mkdtemp(path.join(os.tmpdir(), `codex-workflow-v1-${name}-`))
      roots.push(root)
      const spawn = v1CodeModeSpawn({
        outerCallId: 'outer-spawn-1', innerCallId: 'spawn-1',
        senderThreadId: 'root', receiverThreadId: 'child', arguments: spawnArguments,
      })
      await writeRollout(root, 'root', [session('root'), developer(), ...spawn,
        ...(repeated ? v1CodeModeSpawn({
          outerCallId: 'outer-spawn-2', innerCallId: 'spawn-1',
          senderThreadId: 'root', receiverThreadId: 'child', arguments: spawnArguments,
        }) : [])])
      await writeRollout(root, 'child', [session('child', 'root'), developer('child developer'), {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child prompt' }] },
      }])
      return normalizeCodexWorkflowRollouts({
        codexHome: root,
        rootThreadId: 'root',
        request: { ...request('v1'), model: null },
        runtime: runtime(root),
        appServerFrames: [{
          method: 'item/completed',
          params: {
            threadId: 'root',
            item: {
              type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
              senderThreadId: 'root', receiverThreadId: 'child',
              prompt: spawnArguments.message, agentsStates: { child: 'running' },
            },
          },
        }],
      })
    }
    const canonical = {
      agent_type: 'explorer', message: 'child prompt', fork_context: false,
    }
    await expect(normalize('ambiguous', canonical, true)).rejects.toThrow('one exact rollout call id')
    await expect(normalize('role-conflict', {
      ...canonical, agent_type: 'wrong-role',
    })).rejects.toThrow('role does not match')
    await expect(normalize('message-conflict', {
      ...canonical, message: 'wrong prompt',
    })).rejects.toThrow('prompt does not match')
  })

  it('merges terminal V1 app-server collaboration items with rollout lineage and terminal messages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-app-server-v1-'))
    roots.push(root)
    await writeRollout(root, 'root', [session('root'), developer(), {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'root prompt' }] },
    }, ...v1CodeModeSpawn({
      outerCallId: 'outer-spawn-1',
      innerCallId: 'spawn-1',
      senderThreadId: 'root',
      receiverThreadId: 'child',
      arguments: {
          agent_type: 'explorer', message: 'child prompt', fork_context: false,
      },
    })])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text ### Codex Explore 子代理授权'),
      {
        timestamp: '2026-08-30T00:00:05.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child prompt' }] },
      },
      {
        timestamp: '2026-08-30T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: child\nPayload:\ndone',
          }],
        },
      },
    ])
    const appServerFrames = [
      {
        method: 'item/completed',
        params: {
          threadId: 'root',
          item: {
            type: 'collab_tool_call', id: 'spawn-1', tool: 'spawn_agent', status: 'completed',
            sender_thread_id: 'root', receiver_thread_id: 'child', prompt: 'child prompt',
            model: 'gpt-test', reasoningEffort: 'high',
            agent_status: { child: 'running' },
          },
        },
      },
      {
        method: 'item/completed',
        params: {
          threadId: 'child',
          item: {
            type: 'collabToolCall', id: 'wait-1', tool: 'wait', status: 'completed',
            senderThreadId: 'child', receiverThreadId: 'child', prompt: null,
            agentStatus: { child: 'completed' }, result: { completed: 'done' },
          },
        },
      },
    ]
    const normalized = await normalizeCodexWorkflowRollouts({
      codexHome: root,
      rootThreadId: 'root',
      request: { ...request('v1'), model: null },
      runtime: runtime(root),
      appServerFrames,
    })
    expect(normalized.collaborationCalls).toEqual([
      expect.objectContaining({
        ordinal: 1, threadId: 'root', callId: 'spawn-1', tool: 'spawn_agent',
        arguments: {
          agent_type: 'explorer', message: 'child prompt', fork_context: false,
        },
        effectiveRuntime: { model: 'gpt-test', reasoningEffort: 'high' },
        output: { agent_id: 'child', status: 'running' }, status: 'completed',
      }),
      expect.objectContaining({
        ordinal: 2, threadId: 'child', parentThreadId: 'root', callId: 'wait-1', tool: 'wait_agent',
        linkedThreadId: 'child',
        arguments: { receiver_thread_ids: ['child'] },
        output: { status: { child: { completed: 'done' } } },
        status: 'completed',
      }),
      expect.objectContaining({
        ordinal: 3, threadId: 'child', tool: 'agent_message', status: 'completed',
        output: expect.objectContaining({ messageType: 'FINAL_ANSWER', payload: 'done' }),
      }),
    ])
    expect(normalized.leafCalls.map((call) => call.tool)).toEqual(['wait_agent', 'agent_message'])
    expect(normalized.threadGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: 'child',
        developerContext: expect.objectContaining({
          hasCodexExploreDeveloperAuthorization: true,
        }),
      }),
    ]))
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain('agentPath')
    expect(serialized).not.toContain('agent_path')
    expect(serialized).not.toContain('/root/child')
    expect(serialized).not.toContain('tools.multi_agent_v1__spawn_agent')
  })

  it('links a root-delivered descendant final answer and rejects unlinked root messages as leaf evidence', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-root-delivered-final-'))
    roots.push(root)
    const ciphertext = 'linked-child-message'
    await writeRollout(root, 'root', [
      session('root'),
      developer(),
      {
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-v2',
          arguments: JSON.stringify({ agent_type: 'explorer', message: ciphertext }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'spawn-v2', output: '{"agent_id":"child"}' },
      },
      {
        timestamp: '2026-08-30T00:00:03.500Z',
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'wait_agent', call_id: 'wait-v2',
          arguments: '{"timeout_ms":30000}',
        },
      },
      {
        timestamp: '2026-08-30T00:00:03.600Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output', call_id: 'wait-v2',
          output: '{"status":{"child":{"completed":"done"}}}',
        },
      },
      {
        timestamp: '2026-08-30T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/child\nPayload:\ndone',
          }],
        },
      },
      {
        timestamp: '2026-08-30T00:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: /root\nPayload:\nroot-owned',
          }],
        },
      },
    ])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text'),
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [
            { type: 'input_text', text: 'Message Type: NEW_TASK' },
            { type: 'encrypted_content', encrypted_content: ciphertext },
          ],
        },
      },
      {
        timestamp: '2026-08-30T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution', id: 'cmd-child', command: 'rg retry docs/output',
            exit_code: 0, status: 'completed',
          },
        },
      },
    ])
    const normalized = await normalizeCodexWorkflowRollouts({
      codexHome: root,
      rootThreadId: 'root',
      request: request('v2'),
      runtime: runtime(root),
    })
    const delivered = normalized.collaborationCalls.find((call) =>
      call.tool === 'agent_message' && call.output?.payload === 'done')
    expect(delivered).toEqual(expect.objectContaining({
      threadId: 'root', linkedThreadId: 'child', tool: 'agent_message',
    }))
    expect(normalized.leafCalls.map((call) => [call.threadId, call.linkedThreadId, call.tool])).toEqual([
      ['child', undefined, 'exec_command'],
      ['root', 'child', 'wait_agent'],
      ['root', 'child', 'agent_message'],
    ])
    expect(normalized.leafCalls.some((call) => call.output?.payload === 'root-owned')).toBe(false)
  })

  it('normalizes V1 plaintext lineage, calls, skill loads, and safe developer summaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-rollout-v1-'))
    roots.push(root)
    await writeRollout(root, 'root', [
      session('root'),
      developer(),
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'root prompt' }] },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<skill>\n<name>decision-prototype</name>\n<path>/workspace/.agents/skills/decision-prototype/SKILL.md</path>\n</skill>',
          }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ['skills.selected_skill_instructions'],
          },
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-1',
          arguments: JSON.stringify({ agent_type: 'explorer', message: 'child prompt' }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'spawn-1', output: JSON.stringify({ agent_id: 'child' }) },
      },
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            type: 'CommandExecution', id: 'cmd-1',
            command: 'sed -n 1,20p .agents/skills/codex-explore/SKILL.md',
            exit_code: 0, status: 'completed',
          },
        },
      },
    ])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text'),
      {
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'child prompt' }] },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'wait_agent', call_id: 'wait-1',
          arguments: '{"timeout_ms":10000}',
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'wait-1', output: '{"status":"timeout"}' },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'wait_agent', call_id: 'wait-2',
          arguments: '{"timeout_ms":30000}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output', call_id: 'wait-2',
          output: '{"status":{"child":{"completed":"done"}}}',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: child\nPayload:\ndone',
          }],
        },
      },
    ])
    const normalized = await normalizeCodexWorkflowRollouts({
      codexHome: root,
      rootThreadId: 'root',
      request: { ...request('v1'), model: null },
      runtime: runtime(root),
    })
    expect(normalized.threadGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: 'child',
        parentThreadId: 'root',
        initialMessage: { kind: 'plaintext', text: 'child prompt' },
        developerContext: expect.objectContaining({
          present: true,
          messageCount: 1,
          hasCodexExploreDeveloperAuthorization: false,
        }),
      }),
    ]))
    expect(normalized.collaborationCalls.map((call) => call.ordinal)).toEqual([1, 2, 3, 4, 5])
    expect(normalized.leafCalls).toEqual([
      expect.objectContaining({
        threadId: 'child', tool: 'wait_agent',
        arguments: { timeout_ms: 10000 }, output: { status: 'timeout' }, status: 'completed',
      }),
      expect.objectContaining({
        threadId: 'child', tool: 'wait_agent',
        arguments: { timeout_ms: 30000 },
        output: { status: { child: { completed: 'done' } } }, status: 'completed',
      }),
      expect.objectContaining({
        threadId: 'child', tool: 'agent_message',
        output: expect.objectContaining({ messageType: 'FINAL_ANSWER', payload: 'done' }),
      }),
    ])
    expect(normalized.skillLoads).toEqual([
      { threadId: 'root', skill: 'decision-prototype', callId: null },
      expect.objectContaining({ threadId: 'root', skill: 'codex-explore' }),
    ])
    expect(JSON.stringify(normalized.trace)).not.toContain('developer full text')
    expect(JSON.stringify(normalized.trace)).toContain('child prompt')
    expect(normalized.trace).toContainEqual(expect.objectContaining({
      type: 'response_item', threadId: 'child', parentThreadId: 'root',
      payload: expect.objectContaining({ type: 'message', role: 'user' }),
    }))
  })

  it('normalizes the formal full-history V2 shape without agent_type and redacts its message', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-rollout-v2-'))
    roots.push(root)
    const ciphertext = 'opaque-ciphertext-must-not-be-public'
    await writeRollout(root, 'root', [
      session('root'),
      developer(),
      {
        type: 'response_item',
        payload: {
          type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-v2',
          arguments: JSON.stringify({
            message: ciphertext,
            model: 'explicit-model',
            reasoning_effort: 'xhigh',
            fork_turns: 'all',
          }),
        },
      },
      {
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'spawn-v2', output: '{"agent_id":"child"}' },
      },
    ])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text'),
      {
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [
            { type: 'input_text', text: 'Message Type: NEW_TASK' },
            { type: 'encrypted_content', encrypted_content: ciphertext },
          ],
        },
      },
    ])
    const normalized = await normalizeCodexWorkflowRollouts({
      codexHome: root,
      rootThreadId: 'root',
      request: request('v2'),
      runtime: runtime(root),
    })
    expect(normalized.threadGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({
        threadId: 'child',
        initialMessage: expect.objectContaining({
          kind: 'opaque-link',
          linkedCallId: 'spawn-v2',
          sha256: expect.stringMatching(/^sha256:/u),
        }),
      }),
    ]))
    expect(normalized.collaborationCalls[0]?.arguments).toEqual({
      message: expect.objectContaining({ kind: 'opaque', sha256: expect.stringMatching(/^sha256:/u) }),
      model: 'explicit-model',
      reasoning_effort: 'xhigh',
      fork_turns: 'all',
    })
    expect(normalized.collaborationCalls[0]?.arguments).not.toHaveProperty('agent_type')
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain('child developer full text')
    expect(serialized).not.toContain('effectiveRuntime')
    expect(serialized).toContain('opaque-link')
  })

  it('links V2 executed namespaced calls to their outputs and redacts spawn and isolated paths', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-rollout-v2-executed-'))
    roots.push(root)
    const runtimeRoot = path.join(root, 'private-runtime')
    const codexHome = path.join(runtimeRoot, 'codex-home')
    const isolatedHome = path.join(runtimeRoot, 'home')
    const ciphertext = 'executed-spawn-ciphertext-must-not-be-public'
    await writeRollout(codexHome, 'root', [
      session('root'),
      developer(),
      {
        timestamp: '2026-08-30T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call', name: 'exec', call_id: 'outer-spawn', input: '{}',
        },
      },
      {
        timestamp: '2026-08-30T00:00:01.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output', call_id: 'outer-spawn',
          output: { agentId: 'child', path: isolatedHome },
          internal_chat_message_metadata_passthrough: {
            tool_calls_complete: true,
            executed_tool_calls: [{
              name: 'multi_agent_v2__spawn_agent',
              arguments: { agent_type: 'explorer', message: ciphertext },
            }],
          },
        },
      },
      {
        timestamp: '2026-08-30T00:00:02.000Z',
        type: 'response_item',
        payload: { type: 'custom_tool_call', name: 'exec', call_id: 'outer-wait', input: '{}' },
      },
      {
        timestamp: '2026-08-30T00:00:02.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output', call_id: 'outer-wait', output: { completed: 'done' },
          internal_chat_message_metadata_passthrough: {
            tool_calls_complete: true,
            executed_tool_calls: [{
              name: 'multi_agent_v2__wait_agent', arguments: { timeout_ms: 30_000 },
            }],
          },
        },
      },
    ])
    await writeRollout(codexHome, 'child', [
      session('child', 'root'),
      developer('child developer full text'),
      {
        timestamp: '2026-08-30T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [
            { type: 'input_text', text: 'Message Type: NEW_TASK' },
            { type: 'encrypted_content', encrypted_content: ciphertext },
          ],
        },
      },
      {
        timestamp: '2026-08-30T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'agent_message',
          content: [{
            type: 'input_text',
            text: 'Message Type: FINAL_ANSWER\nTask name: child\nPayload:\ndone',
          }],
        },
      },
    ])
    const normalized = await normalizeCodexWorkflowRollouts({
      codexHome,
      rootThreadId: 'root',
      request: request('v2'),
      runtime: runtime(root),
      isolatedPaths: [
        { path: codexHome, marker: '[codex-home]' },
        { path: isolatedHome, marker: '[isolated-home]' },
        { path: runtimeRoot, marker: '[runtime-root]' },
      ],
    })
    const executed = normalized.collaborationCalls.filter((call) => call.namespace === 'multi_agent_v2')
    expect(executed).toEqual([
      expect.objectContaining({
        callId: 'outer-spawn', tool: 'spawn_agent', status: 'completed',
        arguments: expect.objectContaining({
          agent_type: 'explorer',
          message: expect.objectContaining({ kind: 'opaque', sha256: expect.stringMatching(/^sha256:/u) }),
        }),
        output: { agentId: 'child', path: '[isolated-home]' },
      }),
      expect.objectContaining({
        callId: 'outer-wait', tool: 'wait_agent', arguments: { timeout_ms: 30_000 },
        output: { completed: 'done' }, status: 'completed',
      }),
    ])
    expect(executed.map((call) => call.ordinal)).toEqual([2, 4])
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain(runtimeRoot)
    expect(serialized).not.toContain(codexHome)
    expect(serialized).not.toContain(isolatedHome)
    expect(serialized).toContain('[isolated-home]')
  })
})
