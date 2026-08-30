import os from 'node:os'
import path from 'node:path'

import {
  validateProviderCapabilities,
  validateProviderOutput,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'
import {
  builtInEvalProviderCapabilities,
  encodeCustomProviderCapabilities,
} from '../../src/eval/provider.js'

const roots: string[] = []

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

async function writeFakeAppServer(subjectBase: string, startMarker: string): Promise<void> {
  await fs.writeFile(path.join(subjectBase, 'app-server'), [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const readline = require('node:readline')",
    "const secret = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8')).tokens.access_token",
    "process.stderr.write('fake stderr: ' + secret + '\\n')",
    `fs.writeFileSync(${JSON.stringify(startMarker)}, 'started')`,
    "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')",
    "const input = readline.createInterface({ input: process.stdin })",
    "input.on('line', (line) => {",
    "  const frame = JSON.parse(line)",
    "  if (frame.method === 'initialize') send({ id: frame.id, result: {} })",
    "  else if (frame.method === 'thread/start') send({ id: frame.id, result: { thread: { id: 'thread-1' } } })",
    "  else if (frame.method === 'turn/start') {",
    "    send({ id: frame.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } })",
    "    const prompt = frame.params.input[0].text",
    "    if (prompt.includes('conversation')) {",
    "      send({ id: 41, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', questions: [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [] }] } })",
    "      return",
    "    }",
    "    const skill = path.join(process.cwd(), '.agents', 'skills', 'owner-skill', 'SKILL.md')",
    "    if (fs.existsSync(skill)) send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'commandExecution', status: 'completed', exitCode: 0, command: 'cat .agents/skills/owner-skill/SKILL.md; echo ' + secret } } })",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: (fs.existsSync(skill) ? 'skill-present: ' : 'skill-absent: ') + secret } } })",
    "    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', tokenUsage: { totalTokens: 7 } } })",
    "    send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } })",
    "  } else if (frame.id === 41) {",
    "    send({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', phase: 'final_answer', text: 'conversation-complete: ' + secret } } })",
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
    const startMarker = path.join(root, 'codex-started.marker')
    await Promise.all([
      fs.ensureDir(path.join(subjectBase, '.agents', 'skills')),
      fs.outputJson(path.join(root, 'source-codex-home', 'auth.json'), {
        tokens: { access_token: secret },
      }),
    ])
    await writeFakeAppServer(subjectBase, startMarker)
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

    await fs.remove(startMarker)
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
    await expect(fs.pathExists(startMarker)).resolves.toBe(false)

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
      review: { checks: ['Completes.'], workspace_unchanged: true },
    }
    const conversationEnv = await providerEnvironment({
      root,
      suite: conversationSuite,
      evalCase: conversationCase,
      skillPath: currentSkill,
    })
    const conversation = capture()
    expect(await runCli([
      'skill', 'eval', 'provider', 'codex-conversation',
    ], { cwd: root, env: conversationEnv, io: conversation.io }), conversation.stderr()).toBe(0)
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
    expect(conversationEvidence.finalMessages).toContain('conversation-complete: [redacted]')
  }, 20_000)

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
