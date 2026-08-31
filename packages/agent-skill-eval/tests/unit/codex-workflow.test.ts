import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

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
} from '../../dist/index.js'

const roots: string[] = []

afterEach(async () => {
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

async function adapterFixture(): Promise<{
  root: string
  workspace: string
  fixtures: string
  output: string
  adapter: string
}> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-test-')))
  roots.push(root)
  const workspace = path.join(root, 'workspace')
  const fixtures = path.join(root, 'fixtures')
  const output = path.join(root, 'output')
  const adapter = path.join(root, 'adapter.mjs')
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
    '    sandbox: "read-only",',
    '    model: "allowed-model",',
    '    developerInstructions: "Follow the workflow contract.",',
    '    roles: [{ name: "explorer", description: "Inspect the workspace.", configFile: ".codex/agents/explorer.toml" }],',
    '    multiAgent: { protocol: "v2", maxDepth: 2, hideSpawnAgentMetadata: true, exposeSpawnAgentModelOverrides: true }',
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
  return { root, workspace, fixtures, output, adapter }
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
    expect(env).toMatchObject({ PATH: '/bin', LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('HTTP_PROXY')
    expect(env).not.toHaveProperty('HTTPS_PROXY')
    expect(env).not.toHaveProperty('CODEX_HOME')
    expect(env).not.toHaveProperty('AW_SKILL_EVAL_CODEX_MODEL')
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
          case: { gradeDelay: 2_000 },
          variant: 'current', attempt: 1,
          workspacePath: deadline.workspace,
          fixturesPath: deadline.fixtures,
          outputDir: deadline.output,
          timeoutMs: 4_000,
        },
        codexRuntime: runtime(deadline.root),
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

describe('codex-workflow raw rollout normalization', () => {
  it('merges terminal V1 app-server collaboration items with rollout lineage and terminal messages', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-workflow-app-server-v1-'))
    roots.push(root)
    await writeRollout(root, 'root', [session('root'), developer(), {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'root prompt' }] },
    }, {
      type: 'response_item',
      payload: {
        type: 'function_call', namespace: 'collaboration', name: 'spawn_agent', call_id: 'spawn-1',
        arguments: JSON.stringify({
          agent_type: 'explorer', message: 'child prompt', fork_context: false,
        }),
      },
    }])
    await writeRollout(root, 'child', [
      session('child', 'root'),
      developer('child developer full text ### Codex Explore 子代理授权'),
      {
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
          agent_type: 'explorer', message: 'child prompt', model: 'gpt-test',
          reasoning_effort: 'high', fork_context: false,
        },
        output: { agent_id: 'child', status: 'running' }, status: 'completed',
      }),
      expect.objectContaining({
        ordinal: 2, threadId: 'child', parentThreadId: 'root', callId: 'wait-1', tool: 'wait_agent',
        arguments: {},
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
      expect.objectContaining({ threadId: 'root', skill: 'codex-explore' }),
    ])
    expect(JSON.stringify(normalized.trace)).not.toContain('developer full text')
    expect(JSON.stringify(normalized.trace)).toContain('child prompt')
  })

  it('links V2 opaque child input by hash and never writes ciphertext to normalized evidence or trace', async () => {
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
          arguments: JSON.stringify({ agent_type: 'explorer', message: ciphertext }),
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
    const serialized = JSON.stringify(normalized)
    expect(serialized).not.toContain(ciphertext)
    expect(serialized).not.toContain('child developer full text')
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
