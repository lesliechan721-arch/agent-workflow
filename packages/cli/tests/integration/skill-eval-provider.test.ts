import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  computeCaseCorpusDigest,
  computeSkillDigest,
  getRuntimeCapabilities,
  runExecutionPlan,
  validateProviderCapabilities,
  validateProviderOutput,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../../src/index.js'
import {
  builtInEvalProviderCapabilities,
  conversationProviderStageLine,
  encodeCustomProviderCapabilities,
} from '../../src/eval/provider.js'
import type { AppServerRunEvidence } from '../../scripts/codex-eval-app-server.js'

const roots: string[] = []
const servers: Server[] = []
const execFileAsync = promisify(execFile)

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: (text: string) => { stdout += text },
      stderr: (text: string) => { stderr += text },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

async function createRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-eval-provider-')))
  roots.push(root)
  return root
}

async function writeSkill(root: string, name: string, marker: string): Promise<void> {
  await fs.outputFile(path.join(root, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${marker}`,
    '---',
    '',
    marker,
    '',
  ].join('\n'))
}

async function writeFakeAppServer(
  subjectBase: string,
  forbiddenHostPath: string,
  controlPlanePort: number,
): Promise<void> {
  await fs.writeFile(path.join(subjectBase, 'app-server'), [
    "const fs = require('node:fs')",
    "const { execFileSync } = require('node:child_process')",
    "const net = require('node:net')",
    "const path = require('node:path')",
    "const readline = require('node:readline')",
    "let hostRead = 'allowed'",
    `try { fs.readFileSync(${JSON.stringify(forbiddenHostPath)}, 'utf8') } catch (error) { hostRead = error && (error.code === 'EPERM' || error.code === 'EACCES') ? 'blocked' : 'failed' }`,
    "let codexState = 'writable'",
    "try {",
    "  const journal = path.join(process.env.CODEX_HOME, 'state_5.sqlite-journal')",
    "  fs.writeFileSync(journal, 'state')",
    "  fs.renameSync(journal, path.join(process.env.CODEX_HOME, 'state_5.sqlite'))",
    "} catch { codexState = 'blocked' }",
    "let runRootWrite = 'writable'",
    "try { fs.writeFileSync(path.join(process.cwd(), '..', 'team-status-components.json'), '{}') } catch { runRootWrite = 'blocked' }",
    "let devNullWrite = 'writable'",
    "try { fs.writeFileSync('/dev/null', 'probe') } catch { devNullWrite = 'blocked' }",
    "let controlPlane = 'blocked'",
    "const controlPlaneReady = new Promise((resolve) => {",
    `  const socket = net.connect(${controlPlanePort}, '127.0.0.1')`,
    "  socket.once('connect', () => { controlPlane = 'reachable'; socket.end(); resolve() })",
    "  socket.once('error', () => resolve())",
    "})",
    "let threadSandbox = null",
    "let turnSandboxPolicy = null",
    "let workspaceWrite = 'blocked'",
    "let gitStatus = 'failed'",
    "let turnNumber = 0",
    "const gitLocksConfigIndex = process.argv.indexOf('shell_environment_policy.set.GIT_OPTIONAL_LOCKS=\"0\"')",
    "const toolEnv = { ...process.env, GIT_OPTIONAL_LOCKS: gitLocksConfigIndex >= 0 ? '0' : undefined }",
    "const secret = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).tokens.access_token",
    "process.stderr.write('fake stderr: ' + secret + '\\n')",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')",
    "const input = readline.createInterface({ input: process.stdin })",
    "input.on('line', async (line) => {",
    "  const frame = JSON.parse(line)",
    "  if (frame.method === 'initialize') send({ id: frame.id, result: {} })",
    "  else if (frame.method === 'thread/start') { threadSandbox = frame.params.sandbox; send({ id: frame.id, result: { thread: { id: 'thread-1' } } }) }",
    "  else if (frame.method === 'turn/start') {",
    "    turnNumber += 1",
    "    turnSandboxPolicy = frame.params.sandboxPolicy",
    "    send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })",
    "    const prompt = frame.params.input[0].text",
    "    if (prompt.includes('final fallback one')) {",
    "      send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Which publication target?' } } })",
    "      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "      return",
    "    }",
    "    if (prompt.includes('final fallback two')) {",
    "      send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Which target and channel?' } } })",
    "      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "      return",
    "    }",
    "    if (prompt.startsWith('Scripted user reply')) {",
    "      fs.appendFileSync(path.join(process.cwd(), 'turn-inputs.txt'), prompt + '\\n---\\n')",
    "      if (prompt.includes('catalog-main') && turnNumber === 2) {",
    "        send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'Which approval decision?' } } })",
    "        send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "        return",
    "      }",
    "      fs.writeFileSync(path.join(process.cwd(), 'publisher-result.txt'), prompt)",
    "      send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'publisher-complete' } } })",
    "      send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 17 } } })",
    "      send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "      return",
    "    }",
    "    if (prompt.includes('conversation')) {",
    "      await controlPlaneReady",
    "      try { gitStatus = execFileSync('/bin/sh', ['-c', 'printf %s \"$GIT_OPTIONAL_LOCKS\"; git status --short >/dev/null'], { env: toolEnv, encoding: 'utf8' }) || 'unset' } catch {}",
    "      try {",
    "        const output = threadSandbox === 'workspace-write' ? 'result.txt' : 'read-only-probe.txt'",
    "        fs.writeFileSync(path.join(process.cwd(), output), 'done')",
    "        workspaceWrite = 'writable'",
    "      } catch {}",
    "      send({ id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [] }] } })",
    "      return",
    "    }",
    "    const skill = path.join(process.cwd(), '.agents', 'skills', 'owner-skill', 'SKILL.md')",
    "    if (fs.existsSync(skill)) send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cat .agents/skills/owner-skill/SKILL.md; echo ' + secret } } })",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: (fs.existsSync(skill) ? 'skill-present: ' : 'skill-absent: ') + secret } } })",
    "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 7 } } })",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "  } else if (frame.id === 41) {",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'conversation-complete: ' + secret + '; host-read:' + hostRead + '; codex-state:' + codexState + '; run-root-write:' + runRootWrite + '; dev-null-write:' + devNullWrite + '; control-plane:' + controlPlane + '; git-optional-locks:' + gitStatus + '; workspace-write:' + workspaceWrite + '; sandbox-policy:' + JSON.stringify(turnSandboxPolicy) } } })",
    "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 11 } } })",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "  }",
    "})",
  ].join('\n'))
}

async function providerEnvironment(options: {
  root: string
  suite: Record<string, unknown>
  evalCase: Record<string, unknown>
  skillPath?: string
  skillMode?: 'with-skill' | 'without-skill' | 'previous-version'
}): Promise<NodeJS.ProcessEnv> {
  const outputDir = path.join(options.root, `output-${String(options.suite.kind)}-${String(options.skillMode ?? 'with')}`)
  const subjectBase = path.join(options.root, 'aw-subject-base')
  const evalSuite = path.join(options.root, `eval-suite-${String(options.suite.kind)}`)
  await Promise.all([
    fs.ensureDir(outputDir),
    fs.ensureDir(path.join(subjectBase, '.agents', 'skills')),
    fs.ensureDir(path.join(evalSuite, 'eval-root')),
  ])
  await fs.writeJson(path.join(evalSuite, 'suite.json'), options.suite, { spaces: 2 })
  const casePath = path.join(options.root, `case-${String(options.suite.kind)}.json`)
  await fs.writeJson(casePath, options.evalCase, { spaces: 2 })
  return {
    PATH: process.env.PATH,
    HOME: path.join(options.root, 'home'),
    CODEX_HOME: path.join(options.root, 'source-codex-home'),
    AW_SKILL_EVAL_CODEX_BIN: process.execPath,
    AGENT_EVAL_CASE_ID: String(options.evalCase.id),
    AGENT_EVAL_CONFIGURATION: options.skillMode ?? 'with-skill',
    AGENT_EVAL_SKILL_MODE: options.skillMode ?? 'with-skill',
    AGENT_EVAL_OUTPUT_DIR: outputDir,
    AGENT_EVAL_CASE_PATH: casePath,
    AGENT_EVAL_RUNTIME_INPUTS_JSON: JSON.stringify({
      'aw-subject-base': subjectBase,
      'eval-suite': evalSuite,
    }),
    ...(options.skillPath ? { AGENT_EVAL_SKILL_PATH: options.skillPath } : {}),
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('aw skill eval provider', () => {
  it('describes built-in and custom RuntimeCapabilities v2 without runtime inputs', async () => {
    const root = await createRoot()
    for (const name of ['codex-trigger', 'codex-conversation'] as const) {
      const output = capture()
      expect(await runCli([
        'skill', 'eval', 'provider', name, '--describe',
      ], { cwd: root, env: { PATH: process.env.PATH }, io: output.io })).toBe(0)
      const value = JSON.parse(output.stdout())
      await expect(validateProviderCapabilities(value)).resolves.toMatchObject({ valid: true })
      expect(value).toEqual(builtInEvalProviderCapabilities(name))
      if (name === 'codex-conversation') {
        expect(value.limitations.join('\n')).toContain('tool execution network remains enabled')
      }
      expect(output.stderr()).toBe('')
    }

    const capabilities = {
      ...builtInEvalProviderCapabilities('codex-trigger'),
      provider: 'fixture-provider',
      providerVersion: 'manifest-v1',
    }
    const custom = capture()
    expect(await runCli([
      'skill', 'eval', 'provider', 'custom', '--describe',
      '--capabilities', encodeCustomProviderCapabilities(capabilities),
    ], { cwd: root, env: { PATH: process.env.PATH }, io: custom.io })).toBe(0)
    expect(JSON.parse(custom.stdout())).toEqual(capabilities)
    expect(custom.stderr()).toBe('')
  })

  it('runs one trigger and one conversation case through a fake Codex app-server', async () => {
    const root = await createRoot()
    const secret = 'auth-secret-from-codex-home'
    const subjectBase = path.join(root, 'aw-subject-base')
    const forbiddenHostPath = path.join(root, 'host-eval-evidence.json')
    const controlPlaneServer = createServer((socket) => socket.end())
    servers.push(controlPlaneServer)
    await new Promise<void>((resolve) => controlPlaneServer.listen(0, '127.0.0.1', resolve))
    const controlPlaneAddress = controlPlaneServer.address()
    if (!controlPlaneAddress || typeof controlPlaneAddress === 'string') {
      throw new Error('Control-plane fixture did not bind a TCP port.')
    }
    await Promise.all([
      fs.ensureDir(path.join(subjectBase, '.agents', 'skills')),
      fs.outputJson(path.join(root, 'source-codex-home', 'auth.json'), {
        tokens: { access_token: secret },
      }),
      fs.writeJson(forbiddenHostPath, { evidence: 'must-not-reach-model' }),
    ])
    await writeFakeAppServer(subjectBase, forbiddenHostPath, controlPlaneAddress.port)
    await fs.writeFile(path.join(subjectBase, 'tracked.txt'), 'tracked\n')
    await execFileAsync('git', ['init'], { cwd: subjectBase })
    await execFileAsync('git', ['config', 'user.email', 'eval@example.invalid'], { cwd: subjectBase })
    await execFileAsync('git', ['config', 'user.name', 'Eval Fixture'], { cwd: subjectBase })
    await execFileAsync('git', ['add', '.'], { cwd: subjectBase })
    await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: subjectBase })
    const currentSkill = path.join(root, 'current-skill')
    await writeSkill(currentSkill, 'owner-skill', 'current marker')

    const triggerSuite = {
      id: 'trigger-suite',
      kind: 'trigger',
      skill: 'owner-skill',
      skills: ['owner-skill'],
      cases: 'AGENT_EVAL_CASE_PATH',
      profiles: ['project'],
      defaultRuns: 9,
      releaseSplits: [],
      requiredForRelease: false,
      perRunTimeoutMs: 10_000,
      observeSpawnAgent: false,
      isolation: 'standard',
      strictNegativeSplits: [],
      forbidMultipleSkillLoads: false,
    }
    const triggerCase = {
      id: 'trigger_case',
      split: 'validation',
      query: 'trigger prompt',
      should_load_skill: true,
    }
    const triggerEnv = await providerEnvironment({
      root,
      suite: triggerSuite,
      evalCase: triggerCase,
      skillPath: currentSkill,
    })
    const trigger = capture()
    expect(await runCli([
      'skill', 'eval', 'provider', 'codex-trigger',
    ], { cwd: root, env: triggerEnv, io: trigger.io }), trigger.stderr()).toBe(0)
    const triggerOutput = JSON.parse(trigger.stdout())
    await expect(validateProviderOutput(triggerOutput)).resolves.toMatchObject({ valid: true })
    expect(triggerOutput).toMatchObject({
      provider: { id: 'codex-trigger', version: 'builtin-v1' },
      grading: { result: { passed: true, complete: true } },
    })
    expect(triggerOutput.artifacts).toEqual(expect.arrayContaining([
      { path: 'provider-evidence.json', role: 'report' },
      { path: 'provider-trace.json', role: 'trace' },
    ]))
    expect(trigger.stdout()).not.toContain(secret)
    expect(trigger.stderr()).not.toContain(secret)
    const triggerArtifactContents: string[] = []
    for (const artifact of triggerOutput.artifacts) {
      const content = await fs.readFile(path.join(triggerEnv.AGENT_EVAL_OUTPUT_DIR!, artifact.path), 'utf8')
      triggerArtifactContents.push(content)
      expect(content).not.toContain(secret)
      if (artifact.path.endsWith('.json')) expect(() => JSON.parse(content)).not.toThrow()
    }
    expect(triggerArtifactContents.join('\n')).toContain('[redacted]')
    const triggerEvidence = await fs.readJson(path.join(
      triggerEnv.AGENT_EVAL_OUTPUT_DIR!,
      'provider-evidence.json',
    ))
    expect(triggerEvidence.stderr).toContain('[redacted]')
    expect(JSON.stringify(triggerEvidence.event_trace)).toContain('[redacted]')

    const firstRouteCase = capture()
    const firstRouteCaseEnv = await providerEnvironment({
      root,
      suite: triggerSuite,
      evalCase: {
        id: 'first_route_case',
        split: 'validation',
        query: 'trigger prompt',
        expected_first_loaded_skill: 'owner-skill',
      },
      skillPath: currentSkill,
    })
    expect(await runCli([
      'skill', 'eval', 'provider', 'codex-trigger',
    ], { cwd: root, env: firstRouteCaseEnv, io: firstRouteCase.io }), firstRouteCase.stderr()).toBe(0)
    expect(JSON.parse(firstRouteCase.stdout())).toMatchObject({
      grading: { result: { passed: true, complete: true } },
    })

    const invalidCase = capture()
    const invalidCaseEnv = await providerEnvironment({
      root,
      suite: triggerSuite,
      evalCase: { ...triggerCase, id: 'invalid_trigger_case', should_load_skill: 'true' },
      skillPath: currentSkill,
    })
    expect(await runCli([
      'skill', 'eval', 'provider', 'codex-trigger',
    ], { cwd: root, env: invalidCaseEnv, io: invalidCase.io })).toBe(1)
    expect(invalidCase.stdout()).toBe('')
    expect(invalidCase.stderr()).toContain('should_load_skill must be boolean')

    const withoutSkill = capture()
    const withoutSkillEnv = await providerEnvironment({
      root,
      suite: triggerSuite,
      evalCase: { ...triggerCase, should_load_skill: false },
      skillMode: 'without-skill',
    })
    expect(await runCli([
      'skill', 'eval', 'provider', 'codex-trigger',
    ], { cwd: root, env: withoutSkillEnv, io: withoutSkill.io }), withoutSkill.stderr()).toBe(0)
    const withoutSkillOutput = JSON.parse(withoutSkill.stdout())
    await expect(validateProviderOutput(withoutSkillOutput)).resolves.toMatchObject({ valid: true })
    expect(withoutSkillOutput).toMatchObject({
      grading: { result: { passed: true, complete: true } },
    })
    const withoutSkillEvidence = await fs.readJson(path.join(
      withoutSkillEnv.AGENT_EVAL_OUTPUT_DIR!,
      'provider-evidence.json',
    ))
    expect(withoutSkillEvidence.loaded).toBe(false)

    const conversationSuite = {
      id: 'conversation-suite',
      kind: 'conversation',
      skill: 'owner-skill',
      skills: ['owner-skill'],
      cases: 'AGENT_EVAL_CASE_PATH',
      profiles: ['project'],
      defaultRuns: 7,
      releaseSplits: [],
      requiredForRelease: false,
      perRunTimeoutMs: 10_000,
      isolation: 'standard',
    }
    const conversationCase = {
      id: 'conversation_case',
      prompt: 'conversation prompt',
      scripted_replies: ['project'],
      expected_output: 'conversation-complete',
      sandbox: 'workspace-write',
      review: {
        checks: ['Completes.'],
        workspace_unchanged: false,
        allowed_workspace_changes: ['result.txt'],
        artifacts: [{ path: 'result.txt', exists: true, contains: ['done'] }],
      },
    }
    const conversationEnv = await providerEnvironment({
      root,
      suite: conversationSuite,
      evalCase: conversationCase,
      skillPath: currentSkill,
    })
    conversationEnv.GIT_OPTIONAL_LOCKS = '1'
    const conversation = capture()
    let providerStages = ''
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      providerStages += String(chunk)
      return true
    }) as typeof process.stderr.write)
    try {
      expect(await runCli([
        'skill', 'eval', 'provider', 'codex-conversation',
      ], { cwd: root, env: conversationEnv, io: conversation.io }), conversation.stderr()).toBe(0)
    } finally {
      stderrWrite.mockRestore()
    }
    const conversationOutput = JSON.parse(conversation.stdout())
    await expect(validateProviderOutput(conversationOutput)).resolves.toMatchObject({ valid: true })
    expect(conversationOutput).toMatchObject({
      provider: { id: 'codex-conversation', version: 'builtin-v1' },
      usage: { totalTokens: 11 },
      grading: { result: { passed: true, complete: true, qualitativeReview: 'required' } },
    })
    expect(conversationOutput.artifacts).toContainEqual({ path: 'model-output.txt', role: 'output' })
    expect(conversation.stdout()).not.toContain(secret)
    expect(conversation.stderr()).not.toContain(secret)
    const conversationArtifactContents: string[] = []
    for (const artifact of conversationOutput.artifacts) {
      const content = await fs.readFile(path.join(
        conversationEnv.AGENT_EVAL_OUTPUT_DIR!,
        artifact.path,
      ), 'utf8')
      conversationArtifactContents.push(content)
      expect(content).not.toContain(secret)
      if (artifact.path.endsWith('.json')) expect(() => JSON.parse(content)).not.toThrow()
    }
    expect(conversationArtifactContents.join('\n')).toContain('[redacted]')
    const conversationEvidence = await fs.readJson(path.join(
      conversationEnv.AGENT_EVAL_OUTPUT_DIR!,
      'provider-evidence.json',
    ))
    expect(conversationEvidence.stderr).toContain('[redacted]')
    expect(conversationEvidence.questions).toHaveLength(1)
    expect(conversationEvidence.scriptedReplyMismatches).toEqual([])
    expect(conversationEvidence.finalMessages.join('\n')).toContain('conversation-complete: [redacted]')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('host-read:blocked')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('codex-state:writable')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('run-root-write:writable')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('dev-null-write:writable')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('control-plane:reachable')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('git-optional-locks:0')
    expect(conversationEvidence.finalMessages.join('\n')).toContain('workspace-write:writable')
    expect(conversationEvidence.workspaceChanges).not.toContain('.git/index')
    expect(conversationEvidence.finalMessages.join('\n')).toContain(
      'sandbox-policy:{"type":"externalSandbox","networkAccess":"enabled"}',
    )
    expect(conversationEvidence.limitations.join('\n')).toContain(
      'tool execution network remains enabled',
    )
    expect(providerStages).toContain('"stage":"provider-started"')
    expect(providerStages).toContain('"stage":"workspace-materialized"')
    expect(providerStages).toContain('"stage":"session-started"')
    expect(providerStages).toContain('"stage":"thread-started"')
    expect(providerStages).toContain('"stage":"turn-started"')

    const readOnlyEnv = await providerEnvironment({
      root,
      suite: conversationSuite,
      evalCase: {
        ...conversationCase,
        id: 'read_only_conversation_case',
        sandbox: 'read-only',
        review: { checks: ['Completes.'], workspace_unchanged: true },
      },
      skillPath: currentSkill,
    })
    readOnlyEnv.AGENT_EVAL_OUTPUT_DIR = path.join(root, 'output-conversation-read-only')
    readOnlyEnv.GIT_OPTIONAL_LOCKS = '1'
    await fs.ensureDir(readOnlyEnv.AGENT_EVAL_OUTPUT_DIR)
    const readOnly = capture()
    const readOnlyStderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(
      (() => true) as typeof process.stderr.write,
    )
    try {
      expect(await runCli([
        'skill', 'eval', 'provider', 'codex-conversation',
      ], { cwd: root, env: readOnlyEnv, io: readOnly.io }), readOnly.stderr()).toBe(0)
    } finally {
      readOnlyStderrWrite.mockRestore()
    }
    const readOnlyOutput = JSON.parse(readOnly.stdout())
    expect(readOnlyOutput).toMatchObject({
      grading: { result: { passed: true, complete: true } },
    })
    const readOnlyEvidence = await fs.readJson(path.join(
      readOnlyEnv.AGENT_EVAL_OUTPUT_DIR,
      'provider-evidence.json',
    ))
    const readOnlyMessages = readOnlyEvidence.finalMessages.join('\n')
    expect(readOnlyMessages).toContain('host-read:blocked')
    expect(readOnlyMessages).toContain('codex-state:writable')
    expect(readOnlyMessages).toContain('run-root-write:writable')
    expect(readOnlyMessages).toContain('dev-null-write:writable')
    expect(readOnlyMessages).toContain('control-plane:reachable')
    expect(readOnlyMessages).toContain('git-optional-locks:0')
    expect(readOnlyMessages).toContain('workspace-write:blocked')
    expect(readOnlyMessages).toContain(
      'sandbox-policy:{"type":"externalSandbox","networkAccess":"enabled"}',
    )
    expect(readOnlyEvidence.limitations.join('\n')).toContain(
      'tool execution network remains enabled',
    )
  }, 20_000)

  it('continues final-answer questions as ordered turns without double-consuming tool replies', async () => {
    const root = await createRoot()
    const subjectBase = path.join(root, 'aw-subject-base')
    const forbiddenHostPath = path.join(root, 'host-eval-evidence.json')
    const controlPlaneServer = createServer((socket) => socket.end())
    servers.push(controlPlaneServer)
    await new Promise<void>((resolve) => controlPlaneServer.listen(0, '127.0.0.1', resolve))
    const controlPlaneAddress = controlPlaneServer.address()
    if (!controlPlaneAddress || typeof controlPlaneAddress === 'string') {
      throw new Error('Control-plane fixture did not bind a TCP port.')
    }
    await Promise.all([
      fs.ensureDir(path.join(subjectBase, '.agents', 'skills')),
      fs.outputJson(path.join(root, 'source-codex-home', 'auth.json'), {
        tokens: { access_token: 'conversation-secret' },
      }),
      fs.writeJson(forbiddenHostPath, { evidence: 'must-not-reach-model' }),
    ])
    await writeFakeAppServer(subjectBase, forbiddenHostPath, controlPlaneAddress.port)
    const currentSkill = path.join(root, 'current-skill')
    await writeSkill(currentSkill, 'owner-skill', 'current marker')
    const suite = {
      id: 'conversation-multiturn-suite',
      kind: 'conversation',
      skill: 'owner-skill',
      skills: ['owner-skill'],
      cases: 'AGENT_EVAL_CASE_PATH',
      profiles: ['project'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: false,
      perRunTimeoutMs: 10_000,
      isolation: 'standard',
    }

    const runCase = async (
      suffix: string,
      evalCase: Record<string, unknown>,
      passed = true,
    ): Promise<AppServerRunEvidence> => {
      const env = await providerEnvironment({ root, suite, evalCase, skillPath: currentSkill })
      env.AGENT_EVAL_OUTPUT_DIR = path.join(root, `output-conversation-${suffix}`)
      await fs.ensureDir(env.AGENT_EVAL_OUTPUT_DIR)
      const output = capture()
      const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(
        (() => true) as typeof process.stderr.write,
      )
      try {
        expect(await runCli([
          'skill', 'eval', 'provider', 'codex-conversation',
        ], { cwd: root, env, io: output.io }), output.stderr()).toBe(0)
      } finally {
        stderrWrite.mockRestore()
      }
      expect(JSON.parse(output.stdout())).toMatchObject({
        grading: { result: { passed, complete: true } },
      })
      return fs.readJson(path.join(env.AGENT_EVAL_OUTPUT_DIR, 'provider-evidence.json'))
    }

    const oneStep = await runCase('one-step', {
      id: 'final_answer_one_step',
      prompt: 'final fallback one',
      scripted_replies: [{
        expected_question_count: 2,
        answers_by_index: ['catalog-only', 'beta'],
        unexpected_question_answer: 'stop',
      }],
      expected_output: 'publisher-complete',
      sandbox: 'workspace-write',
      review: {
        checks: ['Completes after one reply.'],
        workspace_unchanged: false,
        allowed_workspace_changes: ['publisher-result.txt', 'turn-inputs.txt'],
        artifacts: [{
          path: 'publisher-result.txt',
          contains: ['1. catalog-only', '2. beta'],
        }],
      },
    })
    expect(oneStep.scriptedReplyMismatches).toEqual([])
    expect(oneStep.questions).toEqual([])
    expect(oneStep.finalMessages).toEqual(['Which publication target?', 'publisher-complete'])
    expect(oneStep.limitations.join('\n')).toContain(
      'expected_question_count is checked against answers_by_index length',
    )

    const twoStep = await runCase('two-step', {
      id: 'final_answer_two_step',
      prompt: 'final fallback two',
      scripted_replies: [{
        expected_question_count: 2,
        answers_by_index: ['catalog-main', 'stable'],
        unexpected_question_answer: 'stop',
      }, {
        expected_question_count: 1,
        answers_by_index: ['approve'],
        unexpected_question_answer: 'stop',
      }],
      expected_output: 'publisher-complete',
      sandbox: 'workspace-write',
      review: {
        checks: ['Completes after two replies.'],
        workspace_unchanged: false,
        allowed_workspace_changes: ['publisher-result.txt', 'turn-inputs.txt'],
        artifacts: [
          { path: 'publisher-result.txt', contains: ['1. approve'] },
          { path: 'turn-inputs.txt', contains: ['1. catalog-main', '2. stable', '1. approve'] },
        ],
      },
    })
    expect(twoStep.scriptedReplyMismatches).toEqual([])
    expect(twoStep.finalMessages).toEqual([
      'Which target and channel?',
      'Which approval decision?',
      'publisher-complete',
    ])
    const turnInputs = twoStep.workspaceArtifacts.find(
      (artifact: { path: string }) => artifact.path === 'turn-inputs.txt',
    ).text as string
    expect(turnInputs.indexOf('1. catalog-main')).toBeLessThan(turnInputs.indexOf('2. stable'))
    expect(turnInputs.indexOf('2. stable')).toBeLessThan(turnInputs.indexOf('1. approve'))

    const countMismatch = await runCase('count-mismatch', {
      id: 'final_answer_count_mismatch',
      prompt: 'final fallback one',
      scripted_replies: [{
        expected_question_count: 1,
        answers_by_index: ['catalog-only', 'beta'],
        unexpected_question_answer: 'stop',
      }],
      expected_output: 'publisher-complete',
      sandbox: 'workspace-write',
      review: {
        checks: ['Reports an unobservable question-count mismatch.'],
        workspace_unchanged: false,
        allowed_workspace_changes: ['publisher-result.txt', 'turn-inputs.txt'],
        artifacts: [{ path: 'publisher-result.txt', contains: ['publisher'] }],
      },
    }, false)
    expect(countMismatch.scriptedReplyMismatches).toEqual([
      'Final-answer fallback step 1 cannot observe structured questions: expected_question_count=1, but answers_by_index contains 2 answer(s).',
    ])
  }, 20_000)

  it('preserves incremental conversation stages in runner-owned timeout evidence', async () => {
    const root = await createRoot()
    const skillRoot = path.join(root, 'skill')
    const casePath = path.join(root, 'cases.json')
    const capabilitiesPath = path.join(root, 'capabilities.json')
    await writeSkill(skillRoot, 'owner-skill', 'timeout evidence fixture')
    await fs.writeJson(casePath, [{ id: 'timeout_case', prompt: 'hang' }])
    const capabilities = {
      ...getRuntimeCapabilities(),
      provider: 'codex-conversation',
      providerVersion: 'builtin-v1',
      capabilities: {
        ...getRuntimeCapabilities().capabilities,
        conversation: true,
        skillPathExecution: true,
        toolTrace: true,
      },
    }
    const capabilitiesRaw = JSON.stringify(capabilities)
    await fs.writeFile(capabilitiesPath, capabilitiesRaw)
    const targetDigest = await computeSkillDigest(skillRoot)
    const corpusDigest = await computeCaseCorpusDigest([casePath])
    const stages = ['provider-started', 'subject-materialized', 'workspace-materialized',
      'session-started', 'thread-started', 'turn-started']
    const plan = {
      schemaVersion: 4,
      planId: 'conversation-timeout-stages',
      target: { name: 'owner-skill', path: 'skill', digest: targetDigest },
      cases: { paths: ['cases.json'], corpusDigest },
      provider: {
        id: 'codex-conversation',
        command: [
          process.execPath,
          '-e',
          `process.stderr.write(${JSON.stringify(stages.map(conversationProviderStageLine).join(''))});setInterval(()=>{},1000)`,
        ],
        describeCommand: [
          process.execPath,
          '-e',
          `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(capabilitiesPath)},'utf8'))`,
        ],
        cwd: null,
        env: {},
        capabilitiesPath: 'capabilities.json',
        capabilitiesDigest: `sha256:${createHash('sha256').update(capabilitiesRaw).digest('hex')}`,
        inheritEnvironment: false,
      },
      runtimeInputs: [],
      configurations: [{ id: 'with-skill', skillMode: 'with-skill', comparisonId: null, env: {} }],
      runsPerCase: 1,
      timeoutMs: 1_000,
      outputRoot: 'output',
      capture: { outputs: true, trace: true, timing: true, usage: true },
    }
    const planPath = path.join(root, 'plan.json')
    await fs.writeJson(planPath, plan)
    const auditPath = path.join(root, 'audit.json')
    await fs.writeJson(auditPath, {
      schemaVersion: 3,
      producer: 'audit-agent-skill-evals',
      independentContext: true,
      auditId: 'timeout-stage-audit',
      mode: 'preflight',
      targetSkillDigest: targetDigest,
      caseCorpusDigest: corpusDigest,
      runBundleDigest: null,
      validity: 'pass',
      optimizationPolicy: 'balanced',
      cases: [{
        caseId: 'timeout_case',
        releaseRelevant: false,
        admission: 'pass',
        oracleConfidence: 'high',
        findings: [],
      }],
      blockedCases: [],
      releaseEligible: false,
      failureTriage: [],
      recommendedAction: 'collect-more-data',
    })
    const result = await runExecutionPlan(planPath, {
      auditPaths: [auditPath],
      processHooks: {
        externalContainment: {
          confirmed: true,
          descendantCleanupGuaranteed: true,
          readOnlySkillSnapshotGuaranteed: true,
        },
        terminateProcessTree: async ({ pid }) => {
          try {
            process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
          } catch {
            // The timed-out provider can already be closed.
          }
          return { confirmed: true }
        },
      },
    })
    const bundle = await fs.readJson(result.bundlePath)
    expect(bundle.runs[0]).toMatchObject({ status: 'timeout', usage: null })
    const stderr = await fs.readFile(path.resolve(path.dirname(result.bundlePath), bundle.runs[0].stderrPath), 'utf8')
    for (const stage of stages) expect(stderr).toContain(`"stage":"${stage}"`)
  })

  it('executes one custom snapshot entry and overlays current, previous, or no target Skill', async () => {
    const root = await createRoot()
    const subjectBase = path.join(root, 'aw-subject-base')
    await writeSkill(path.join(subjectBase, '.agents', 'skills', 'participant'), 'participant', 'participant')
    const currentSkill = path.join(root, 'current-skill')
    const previousSkill = path.join(root, 'previous-skill')
    await writeSkill(currentSkill, 'owner-skill', 'current marker')
    await writeSkill(previousSkill, 'owner-skill', 'previous marker')
    const suite = {
      id: 'custom-suite',
      kind: 'provider',
      skill: 'owner-skill',
      skills: ['owner-skill', 'participant'],
      cases: 'AGENT_EVAL_CASE_PATH',
      profiles: ['project'],
      defaultRuns: 99,
      releaseSplits: [],
      requiredForRelease: false,
      perRunTimeoutMs: 10_000,
      provider: { id: 'fixture-provider', entry: 'eval-root/provider.mjs' },
    }
    const evalCase = { id: 'custom_case', prompt: 'one case' }
    const results: string[] = []
    for (const [skillMode, skillPath] of [
      ['with-skill', currentSkill],
      ['previous-version', previousSkill],
      ['without-skill', undefined],
    ] as const) {
      const env = await providerEnvironment({ root, suite, evalCase, skillMode, skillPath })
      const runtimeInputs = JSON.parse(env.AGENT_EVAL_RUNTIME_INPUTS_JSON!) as Record<string, string>
      const entryPath = path.join(runtimeInputs['eval-suite']!, 'eval-root', 'provider.mjs')
      await fs.writeFile(entryPath, [
        "import { appendFile, readFile, writeFile } from 'node:fs/promises'",
        "import path from 'node:path'",
        'export async function runEvalProvider(input) {',
        "  const skill = path.join(input.workspacePath, '.agents', 'skills', 'owner-skill', 'SKILL.md')",
        "  const marker = await readFile(skill, 'utf8').catch(() => 'absent')",
        "  await appendFile(path.join(input.outputDir, 'calls.txt'), input.caseId + '\\n')",
        "  await writeFile(path.join(input.outputDir, 'overlay.txt'), marker)",
        '  return {',
        "    schemaVersion: 1, provider: { id: 'fixture-provider', version: 'manifest-v1' },",
        "    usage: null, grading: { grader: { id: 'fixture', version: '1' }, result: { passed: true } },",
        "    artifacts: [{ path: 'overlay.txt', role: 'output' }, { path: 'calls.txt', role: 'report' }],",
        '  }',
        '}',
      ].join('\n'))
      const output = capture()
      expect(await runCli([
        'skill', 'eval', 'provider', 'custom',
      ], { cwd: root, env, io: output.io }), output.stderr()).toBe(0)
      const value = JSON.parse(output.stdout())
      await expect(validateProviderOutput(value)).resolves.toMatchObject({ valid: true })
      const outputDir = env.AGENT_EVAL_OUTPUT_DIR!
      results.push(await fs.readFile(path.join(outputDir, 'overlay.txt'), 'utf8'))
      await expect(fs.readFile(path.join(outputDir, 'calls.txt'), 'utf8')).resolves.toBe('custom_case\n')
      await expect(fs.pathExists(path.join(outputDir, '.aw-provider-subject'))).resolves.toBe(false)
    }
    expect(results[0]).toContain('current marker')
    expect(results[1]).toContain('previous marker')
    expect(results[2]).toBe('absent')
  })

  it('rejects custom entries that write to provider stdout', async () => {
    const root = await createRoot()
    const suite = {
      id: 'custom-stdout-suite',
      kind: 'provider',
      skill: 'owner-skill',
      skills: ['owner-skill'],
      cases: 'AGENT_EVAL_CASE_PATH',
      profiles: ['project'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: false,
      perRunTimeoutMs: 10_000,
      provider: { id: 'fixture-provider', entry: 'eval-root/provider.mjs' },
    }
    const env = await providerEnvironment({
      root,
      suite,
      evalCase: { id: 'custom_stdout_case' },
      skillMode: 'without-skill',
    })
    const runtimeInputs = JSON.parse(env.AGENT_EVAL_RUNTIME_INPUTS_JSON!) as Record<string, string>
    await fs.writeFile(path.join(runtimeInputs['eval-suite']!, 'eval-root', 'provider.mjs'), [
      "process.stdout.write('invalid provider stdout\\n')",
      'export function runEvalProvider() {',
      "  return { schemaVersion: 1, provider: { id: 'fixture-provider', version: 'manifest-v1' }, usage: null, grading: null, artifacts: [] }",
      '}',
    ].join('\n'))
    const output = capture()
    expect(await runCli([
      'skill', 'eval', 'provider', 'custom',
    ], { cwd: root, env, io: output.io })).toBe(1)
    expect(output.stdout()).toBe('')
    expect(output.stderr()).toContain('must not write to stdout')
    await expect(fs.pathExists(path.join(
      env.AGENT_EVAL_OUTPUT_DIR!,
      '.aw-provider-subject',
    ))).resolves.toBe(false)
  })
})
