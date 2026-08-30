import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import { validateExecutionPlan } from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'
import { validateAwSkillEvalCheckResult } from '../../src/eval/check-result.js'

const roots: string[] = []

async function treeDigests(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const walk = async (directory: string, parent = ''): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = path.join(parent, entry.name)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(absolute, relative)
      else if (entry.isFile()) {
        result[relative.split(path.sep).join('/')] = createHash('sha256')
          .update(await fs.readFile(absolute))
          .digest('hex')
      }
    }
  }
  await walk(root)
  return result
}

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

async function createWorkspace(): Promise<{
  root: string
  ownerRoot: string
  skillRoot: string
  evalRoot: string
  env: NodeJS.ProcessEnv
}> {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-eval-command-'))
  const root = await fs.realpath(createdRoot)
  roots.push(root)
  const env = {
    ...process.env,
    HOME: path.join(root, 'home'),
    USERPROFILE: path.join(root, 'home'),
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
  }
  await fs.ensureDir(env.HOME)
  expect(await runCli(['catalog', 'init', '--workspace-root', root], {
    cwd: root,
    env,
    io: capture().io,
  })).toBe(0)
  expect(await runCli([
    'plugin', 'init', 'participant-plugin',
    '--description', 'Participant plugin for Eval materialization tests.',
    '--skill-name', 'participant-skill',
    '--skill-description', 'Use this participant Skill in deterministic Eval materialization tests.',
    '--skill-short-description', 'Materialize participant Skill',
    '--workspace-root', root,
  ], { cwd: root, env, io: capture().io })).toBe(0)
  expect(await runCli([
    'plugin', 'init', 'eval-owner',
    '--description', 'Owner plugin for deterministic Eval command tests.',
    '--skill-name', 'owner-skill',
    '--skill-description', 'Use this owner Skill in deterministic Eval command tests.',
    '--skill-short-description', 'Prepare deterministic Eval Skill',
    '--workspace-root', root,
  ], { cwd: root, env, io: capture().io })).toBe(0)

  const ownerRoot = path.join(root, 'plugins', 'eval-owner')
  const skillRoot = path.join(ownerRoot, 'skills', 'owner-skill')
  const evalRoot = path.join(skillRoot, 'evals')
  const manifestPath = path.join(ownerRoot, '.agents-plugin', 'plugin.json')
  const pluginManifest = await fs.readJson(manifestPath)
  pluginManifest.dependencies = ['participant-plugin']
  pluginManifest.config = {
    schema: {
      mode: { type: 'string', default: 'default-mode' },
      token: { type: 'string', sensitive: true },
    },
  }
  await fs.writeJson(manifestPath, pluginManifest, { spaces: 2 })
  await fs.ensureDir(evalRoot)
  await fs.writeJson(path.join(evalRoot, 'trigger-cases.json'), {
    schemaVersion: 1,
    skill: 'owner-skill',
    cases: [
      { id: 'train_case', split: 'train', query: 'Train query.', should_load_skill: true },
      {
        id: 'validation_case',
        split: 'validation',
        query: 'Validation query.',
        should_load_skill: false,
        oracle: { note: 'author-only metadata is removed by normalization' },
      },
    ],
  }, { spaces: 2 })
  await fs.writeJson(path.join(evalRoot, 'conversation-cases.json'), {
    skill_name: 'owner-skill',
    evals: [{
      id: 'conversation_case',
      prompt: 'Conversation query.',
      scripted_replies: [],
      expected_output: 'Return the result.',
      review: { checks: ['Returns the result.'], workspace_unchanged: true },
    }],
  }, { spaces: 2 })
  await fs.writeJson(path.join(evalRoot, 'provider-cases.json'), {
    evals: [{ id: 'provider_case', prompt: 'Provider query.' }],
  }, { spaces: 2 })
  await fs.writeJson(path.join(evalRoot, 'document.json'), { kind: 'answer', answer: 42 }, { spaces: 2 })
  await fs.writeJson(path.join(evalRoot, 'document.schema.json'), {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { answer: { type: 'integer', exclusiveMinimum: 41 } },
    oneOf: [{
      type: 'object',
      required: ['kind', 'answer'],
      properties: {
        kind: { const: 'answer' },
        answer: { $ref: '#/$defs/answer' },
      },
      additionalProperties: false,
    }, {
      type: 'object',
      required: ['kind', 'message'],
      properties: {
        kind: { const: 'message' },
        message: { type: 'string' },
      },
      additionalProperties: false,
    }],
  }, { spaces: 2 })
  await fs.writeFile(path.join(evalRoot, 'fixture.mjs'), 'export default async () => undefined\n')
  await fs.outputFile(path.join(evalRoot, 'fixtures', 'bin', 'fixture-tool'), '#!/bin/sh\nexit 0\n')
  await fs.writeFile(path.join(evalRoot, 'provider-helper.mjs'), 'export const helper = true\n')
  await fs.writeFile(path.join(evalRoot, 'provider.mjs'), [
    "import { helper } from './provider-helper.mjs'",
    'export async function runEvalProvider(input) {',
    '  return {',
    "    schemaVersion: 1, provider: { id: 'fixture-provider', version: 'manifest-v1' },",
    '    usage: null, grading: null, artifacts: helper && input.caseId ? [] : [],',
    '  }',
    '}',
  ].join('\n'))
  await writeManifest(evalRoot)
  return { root, ownerRoot, skillRoot, evalRoot, env }
}

async function writeManifest(
  evalRoot: string,
  options: { sensitive?: boolean; checkCommand?: boolean } = {},
): Promise<void> {
  await fs.writeJson(path.join(evalRoot, 'manifest.json'), {
    schemaVersion: 1,
    plugin: 'eval-owner',
    skill: 'owner-skill',
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [
        {
          name: 'eval-owner',
          config: options.sensitive
            ? { mode: 'fixture-mode', token: 'never-print-this-secret' }
            : { mode: 'fixture-mode' },
        },
        { name: 'participant-plugin', config: {} },
      ],
      requiredForRelease: true,
    }, {
      id: 'owner-only',
      scope: 'project',
      plugins: [
        { name: 'eval-owner', config: { mode: 'owner-only-mode' } },
      ],
      requiredForRelease: false,
    }, {
      id: 'user-default',
      scope: 'user',
      plugins: [
        { name: 'eval-owner', config: { mode: 'user-fixture-mode' } },
        { name: 'participant-plugin', config: {} },
      ],
      requiredForRelease: false,
    }],
    suites: [
      {
        id: 'trigger-suite',
        kind: 'trigger',
        skills: ['owner-skill', 'participant-skill'],
        cases: 'trigger-cases.json',
        profiles: ['project-default', 'owner-only', 'user-default'],
        defaultRuns: 2,
        releaseSplits: ['validation'],
        requiredForRelease: true,
        perRunTimeoutMs: 10_000,
        observeSpawnAgent: false,
        isolation: 'standard',
        strictNegativeSplits: [],
        fixtureModule: 'fixture.mjs',
      },
      {
        id: 'conversation-suite',
        kind: 'conversation',
        skills: ['owner-skill', 'participant-skill'],
        cases: 'conversation-cases.json',
        profiles: ['project-default'],
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: true,
        perRunTimeoutMs: 10_000,
        isolation: 'standard',
        environment: { pathPrepend: ['fixtures/bin'] },
      },
      {
        id: 'provider-suite',
        kind: 'provider',
        skills: ['owner-skill', 'participant-skill'],
        cases: 'provider-cases.json',
        profiles: ['project-default'],
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: false,
        perRunTimeoutMs: 10_000,
        provider: {
          id: 'fixture-provider',
          entry: 'provider.mjs',
          assets: ['provider-helper.mjs'],
          credentialEnvironment: ['FIXTURE_PROVIDER_TOKEN'],
          capabilities: {
            triggerDiscovery: false,
            conversation: false,
            skillPathExecution: true,
            previousVersionBaseline: true,
            withoutSkillBaseline: true,
            cleanContext: true,
            parallelRuns: false,
            toolTrace: false,
            tokenUsage: false,
            duration: true,
            sandbox: false,
            materialization: true,
          },
        },
      },
      {
        id: 'schema-check',
        kind: 'check',
        skills: ['owner-skill', 'participant-skill'],
        profiles: ['project-default', 'user-default'],
        defaultRuns: 1,
        releaseSplits: [],
        requiredForRelease: true,
        perRunTimeoutMs: 10_000,
        checker: 'json-schema',
        document: 'document.json',
        schema: 'document.schema.json',
        ...(options.checkCommand ? { command: ['node', 'unsafe.js'] } : {}),
      },
    ],
  }, { spaces: 2 })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('aw skill eval commands', () => {
  it('validates canonical v1 Eval manifests through the public plugin validator', async () => {
    const fixture = await createWorkspace()
    const skillPath = path.join(fixture.skillRoot, 'SKILL.md')
    await fs.writeFile(
      skillPath,
      (await fs.readFile(skillPath, 'utf8')).replaceAll('TODO', 'Fixture instruction'),
    )
    const valid = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: valid.io }), valid.stdout()).toBe(0)
    expect(JSON.parse(valid.stdout())).toMatchObject({ ok: true, errors: [] })

    const triggerCasesPath = path.join(fixture.evalRoot, 'trigger-cases.json')
    const triggerCases = await fs.readJson(triggerCasesPath)
    triggerCases.cases[0].should_load_skill = 'true'
    await fs.writeJson(triggerCasesPath, triggerCases, { spaces: 2 })
    const invalidTrigger = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: invalidTrigger.io })).toBe(1)
    expect(JSON.parse(invalidTrigger.stdout())).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('should_load_skill must be boolean'),
      ]),
    })
    triggerCases.cases[0].should_load_skill = true
    await fs.writeJson(triggerCasesPath, triggerCases, { spaces: 2 })

    const conversationCasesPath = path.join(fixture.evalRoot, 'conversation-cases.json')
    const conversationCases = await fs.readJson(conversationCasesPath)
    conversationCases.evals[0].scripted_replies = 'invalid'
    await fs.writeJson(conversationCasesPath, conversationCases, { spaces: 2 })
    const invalidConversation = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: invalidConversation.io })).toBe(1)
    expect(JSON.parse(invalidConversation.stdout())).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('scripted_replies must be an array'),
      ]),
    })
    conversationCases.evals[0].scripted_replies = []
    await fs.writeJson(conversationCasesPath, conversationCases, { spaces: 2 })

    const manifestPath = path.join(fixture.evalRoot, 'manifest.json')
    const manifest = await fs.readJson(manifestPath)
    await fs.writeJson(manifestPath, { ...manifest, schemaVersion: 2 }, { spaces: 2 })
    const legacy = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: legacy.io })).toBe(1)
    expect(JSON.parse(legacy.stdout())).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('eval manifest schemaVersion must be 1'),
      ]),
    })
  }, 20_000)

  it('prepares one input-complete Plan from real profile materialization and comparisons', async () => {
    const fixture = await createWorkspace()
    const output = path.join(fixture.root, 'prepared-plan')
    const commandOutput = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill',
      '--suite', 'trigger-suite',
      '--profile', 'project-default',
      '--workspace-root', fixture.root,
      '--split', 'validation',
      '--case', 'validation_case',
      '--runs', '3',
      '--baseline', 'without-skill',
      '--previous-version', fixture.skillRoot,
      '--output', output,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: commandOutput.io }), commandOutput.stdout()).toBe(0)

    const receipt = JSON.parse(commandOutput.stdout())
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      ok: true,
      plans: [{ suite: 'trigger-suite', profile: 'project-default' }],
    })
    expect(commandOutput.stderr()).toBe('')
    const planPath = path.join(output, 'plan.json')
    await expect(validateExecutionPlan(planPath)).resolves.toMatchObject({ valid: true })
    const plan = await fs.readJson(planPath)
    expect(plan).toMatchObject({
      schemaVersion: 4,
      runsPerCase: 3,
      provider: {
        id: 'codex-trigger',
        command: ['aw', 'skill', 'eval', 'provider', 'codex-trigger'],
        inheritEnvironment: false,
      },
      runtimeInputs: [
        { id: 'aw-subject-base', path: 'runtime/aw-subject-base' },
        { id: 'eval-suite', path: 'runtime/eval-suite' },
      ],
      configurations: [
        { id: 'with-skill', skillMode: 'with-skill', comparisonId: 'comparison' },
        { id: 'without-skill', skillMode: 'without-skill', comparisonId: 'comparison' },
        {
          id: 'previous-version',
          skillMode: 'previous-version',
          comparisonId: 'comparison',
          skillPath: 'targets/previous/previous-version',
        },
      ],
      outputRoot: 'output',
    })
    expect(await fs.readJson(path.join(output, 'cases', 'selected-cases.json'))).toEqual([{
      id: 'validation_case',
      split: 'validation',
      query: 'Validation query.',
      should_load_skill: false,
    }])
    await expect(fs.pathExists(path.join(output, 'targets', 'current', 'SKILL.md'))).resolves.toBe(true)
    await expect(fs.pathExists(path.join(output, 'targets', 'previous', 'previous-version', 'SKILL.md'))).resolves.toBe(true)
    await expect(fs.pathExists(path.join(
      output,
      'runtime',
      'aw-subject-base',
      '.agents',
      'skills',
      'owner-skill',
    ))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(
      output,
      'runtime',
      'aw-subject-base',
      '.agents',
      'skills',
      'participant-skill',
      'SKILL.md',
    ))).resolves.toBe(true)
    await expect(fs.pathExists(path.join(output, 'output'))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(output, 'runtime', 'eval-suite', 'eval-root', 'fixture.mjs')))
      .resolves.toBe(true)
    await expect(fs.readJson(path.join(output, 'preparation.json'))).resolves.toMatchObject({
      targetDigest: receipt.plans[0].targetDigest,
      corpusDigest: receipt.plans[0].corpusDigest,
    })

    const repeatedOutput = path.join(fixture.root, 'repeated-plan')
    const repeated = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root,
      '--split', 'validation', '--case', 'validation_case', '--runs', '3',
      '--baseline', 'without-skill', '--previous-version', fixture.skillRoot,
      '--output', repeatedOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: repeated.io }), repeated.stdout()).toBe(0)
    await expect(fs.readJson(path.join(repeatedOutput, 'plan.json'))).resolves.toEqual(plan)

    const conversationOutput = path.join(fixture.root, 'conversation-plan')
    const conversationRepeat = path.join(fixture.root, 'conversation-repeat')
    for (const target of [conversationOutput, conversationRepeat]) {
      const conversation = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner',
        '--skill', 'owner-skill', '--suite', 'conversation-suite', '--profile', 'project-default',
        '--workspace-root', fixture.root, '--output', target, '--json',
      ], { cwd: fixture.root, env: fixture.env, io: conversation.io }), conversation.stdout()).toBe(0)
    }
    const conversationPlan = await fs.readJson(path.join(conversationOutput, 'plan.json'))
    const firstConversationTree = await treeDigests(path.join(conversationOutput, 'runtime', 'aw-subject-base'))
    const secondConversationTree = await treeDigests(path.join(conversationRepeat, 'runtime', 'aw-subject-base'))
    expect(secondConversationTree).toEqual(firstConversationTree)
    await expect(fs.readJson(path.join(conversationRepeat, 'plan.json'))).resolves.toEqual(conversationPlan)
    expect(conversationPlan.provider.command).toEqual([
      'aw', 'skill', 'eval', 'provider', 'codex-conversation',
    ])
    await expect(fs.pathExists(path.join(
      conversationOutput,
      'runtime',
      'eval-suite',
      'eval-root',
      'fixtures',
      'bin',
      'fixture-tool',
    ))).resolves.toBe(true)

    const providerOutput = path.join(fixture.root, 'provider-plan')
    const provider = capture()
    fixture.env.FIXTURE_PROVIDER_TOKEN = 'fixture-provider-secret-must-not-be-planned'
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'provider-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', providerOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: provider.io }), provider.stdout()).toBe(0)
    await expect(fs.readJson(path.join(providerOutput, 'plan.json'))).resolves.toMatchObject({
      provider: {
        id: 'fixture-provider',
        command: ['aw', 'skill', 'eval', 'provider', 'custom'],
        describeCommand: [
          'aw', 'skill', 'eval', 'provider', 'custom', '--describe', '--capabilities', expect.any(String),
        ],
        inheritEnvironment: false,
        environmentAllowlist: ['FIXTURE_PROVIDER_TOKEN'],
      },
    })
    await expect(fs.readJson(path.join(providerOutput, 'runtime', 'eval-suite', 'suite.json')))
      .resolves.toMatchObject({
        kind: 'provider',
        cases: 'AGENT_EVAL_CASE_PATH',
        provider: {
          id: 'fixture-provider',
          entry: 'eval-root/provider.mjs',
          assets: ['eval-root/provider-helper.mjs'],
        },
      })
    await expect(fs.pathExists(path.join(
      providerOutput, 'runtime', 'eval-suite', 'eval-root', 'provider.mjs',
    ))).resolves.toBe(true)
    await expect(fs.pathExists(path.join(
      providerOutput, 'runtime', 'eval-suite', 'eval-root', 'provider-helper.mjs',
    ))).resolves.toBe(true)
    expect(provider.stdout()).not.toContain('fixture-provider-secret-must-not-be-planned')
    expect(JSON.stringify(await fs.readJson(path.join(providerOutput, 'plan.json'))))
      .not.toContain('fixture-provider-secret-must-not-be-planned')
    expect(JSON.stringify(await fs.readJson(path.join(providerOutput, 'preparation.json'))))
      .not.toContain('fixture-provider-secret-must-not-be-planned')

    const dependencyOutput = path.join(fixture.root, 'dependency-plan')
    const dependency = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'owner-only',
      '--workspace-root', fixture.root, '--output', dependencyOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: dependency.io }), dependency.stdout()).toBe(0)
    await expect(fs.pathExists(path.join(
      dependencyOutput,
      'runtime', 'aw-subject-base', '.agents', 'skills', 'participant-skill', 'SKILL.md',
    ))).resolves.toBe(true)

    const userOutput = path.join(fixture.root, 'user-plan')
    const userReceipt = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'user-default',
      '--workspace-root', fixture.root, '--output', userOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: userReceipt.io }), userReceipt.stdout()).toBe(0)
    await expect(validateExecutionPlan(path.join(userOutput, 'plan.json'))).resolves.toMatchObject({ valid: true })
    await expect(fs.lstat(path.join(userOutput, 'runtime', 'aw-subject-base', '.codex')))
      .resolves.toMatchObject({})
  }, 30_000)

  it('fails closed for sensitive config, unsafe selections, and existing outputs', async () => {
    const fixture = await createWorkspace()
    await writeManifest(fixture.evalRoot, { sensitive: true })
    const sensitiveOutput = path.join(fixture.root, 'sensitive-plan')
    const sensitive = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', sensitiveOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: sensitive.io })).toBe(1)
    expect(sensitive.stdout()).not.toContain('never-print-this-secret')
    await expect(fs.pathExists(sensitiveOutput)).resolves.toBe(false)

    await writeManifest(fixture.evalRoot)
    const noMatchOutput = path.join(fixture.root, 'no-match-plan')
    const noMatch = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--case', '../unsafe', '--output', noMatchOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: noMatch.io })).toBe(1)
    await expect(fs.pathExists(noMatchOutput)).resolves.toBe(false)

    const existingOutput = path.join(fixture.root, 'existing-plan')
    await fs.ensureDir(existingOutput)
    await fs.writeFile(path.join(existingOutput, 'foreign.txt'), 'keep\n')
    const existing = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', existingOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: existing.io })).toBe(1)
    await expect(fs.readFile(path.join(existingOutput, 'foreign.txt'), 'utf8')).resolves.toBe('keep\n')

    const realParent = path.join(fixture.root, 'real-output-parent')
    const linkedParent = path.join(fixture.root, 'linked-output-parent')
    await fs.ensureDir(path.join(realParent, 'nested'))
    await fs.symlink(realParent, linkedParent, 'dir')
    const nestedLinkedPlan = path.join(linkedParent, 'nested', 'plan')
    const nestedLinked = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', nestedLinkedPlan, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: nestedLinked.io })).toBe(1)
    await expect(fs.pathExists(nestedLinkedPlan)).resolves.toBe(false)

    const nestedLinkedCheck = path.join(linkedParent, 'nested', 'check.json')
    const linkedCheck = capture()
    expect(await runCli([
      'skill', 'eval', 'check', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'schema-check', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', nestedLinkedCheck, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: linkedCheck.io })).toBe(1)
    await expect(fs.pathExists(nestedLinkedCheck)).resolves.toBe(false)

    const foreignPluginOutput = path.join(fixture.root, 'plugins', 'participant-plugin', 'foreign-plan')
    const foreignPlugin = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', foreignPluginOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: foreignPlugin.io })).toBe(1)
    await expect(fs.pathExists(foreignPluginOutput)).resolves.toBe(false)

    const linkedOutput = path.join(fixture.root, 'linked-plan')
    await fs.symlink(existingOutput, linkedOutput, 'dir')
    const linked = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', linkedOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: linked.io })).toBe(1)
    await expect(fs.readFile(path.join(existingOutput, 'foreign.txt'), 'utf8')).resolves.toBe('keep\n')

    const participantManifestPath = path.join(
      fixture.root,
      'plugins', 'participant-plugin', '.agents-plugin', 'plugin.json',
    )
    const participantManifest = await fs.readJson(participantManifestPath)
    participantManifest.config = {
      schema: { requiredValue: { type: 'string', required: true } },
    }
    await fs.writeJson(participantManifestPath, participantManifest, { spaces: 2 })
    const missingDependencyConfigOutput = path.join(fixture.root, 'missing-dependency-config-plan')
    const missingDependencyConfig = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'trigger-suite', '--profile', 'owner-only',
      '--workspace-root', fixture.root, '--output', missingDependencyConfigOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: missingDependencyConfig.io })).toBe(1)
    expect(missingDependencyConfig.stdout()).toContain('missing required config')
    await expect(fs.pathExists(missingDependencyConfigOutput)).resolves.toBe(false)
  }, 30_000)

  it('runs only the registered json-schema checker and writes a bound result atomically', async () => {
    const fixture = await createWorkspace()
    const pluginManifestPath = path.join(fixture.ownerRoot, '.agents-plugin', 'plugin.json')
    const pluginManifest = await fs.readJson(pluginManifestPath)
    pluginManifest.scripts = {
      ...pluginManifest.scripts,
      node: { build: { runner: 'node', path: './check-must-not-build.mjs' } },
    }
    await fs.writeJson(pluginManifestPath, pluginManifest, { spaces: 2 })
    const buildMarker = path.join(fixture.ownerRoot, 'check-build-ran')
    await fs.writeFile(
      path.join(fixture.ownerRoot, 'check-must-not-build.mjs'),
      `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(buildMarker)}, 'ran\\n')\nthrow new Error('check must not build')\n`,
    )
    const resultPath = path.join(fixture.root, 'check-result.json')
    const output = capture()
    expect(await runCli([
      'skill', 'eval', 'check', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'schema-check', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', resultPath, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: output.io }), output.stdout()).toBe(0)
    const result = JSON.parse(output.stdout())
    expect(result).toMatchObject({
      schemaVersion: 1,
      checker: { id: 'json-schema', version: '1' },
      plugin: 'eval-owner',
      skill: 'owner-skill',
      suite: 'schema-check',
      profile: 'project-default',
      passed: true,
      errors: [],
    })
    expect(result).not.toHaveProperty('targetDigest')
    expect(result).not.toHaveProperty('runtimeInputs')
    expect(validateAwSkillEvalCheckResult(result)).toEqual([])
    await expect(fs.readJson(resultPath)).resolves.toEqual(result)
    await expect(fs.pathExists(buildMarker)).resolves.toBe(false)

    await fs.writeJson(
      path.join(fixture.evalRoot, 'document.json'),
      { kind: 'answer', answer: 41 },
      { spaces: 2 },
    )
    const failedResultPath = path.join(fixture.root, 'failed-check-result.json')
    const failed = capture()
    expect(await runCli([
      'skill', 'eval', 'check', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'schema-check', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', failedResultPath, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: failed.io })).toBe(1)
    const failedResult = JSON.parse(failed.stdout())
    expect(failedResult).toMatchObject({ passed: false })
    expect(failedResult.errors).toContainEqual(expect.stringContaining('must be > 41'))
    await expect(fs.readJson(failedResultPath)).resolves.toEqual(failedResult)
    await expect(fs.pathExists(buildMarker)).resolves.toBe(false)

    await fs.writeJson(path.join(fixture.evalRoot, 'document.schema.json'), {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/missing',
      $defs: {},
    }, { spaces: 2 })
    const invalidSchemaPath = path.join(fixture.root, 'invalid-schema-result.json')
    const invalidSchema = capture()
    expect(await runCli([
      'skill', 'eval', 'check', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'schema-check', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', invalidSchemaPath, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: invalidSchema.io })).toBe(1)
    expect(invalidSchema.stdout()).toContain('could not compile schema')
    await expect(fs.pathExists(invalidSchemaPath)).resolves.toBe(false)
    await expect(fs.pathExists(buildMarker)).resolves.toBe(false)

    await writeManifest(fixture.evalRoot, { checkCommand: true })
    const rejectedPath = path.join(fixture.root, 'rejected-check.json')
    const rejected = capture()
    expect(await runCli([
      'skill', 'eval', 'check', 'eval-owner',
      '--skill', 'owner-skill', '--suite', 'schema-check', '--profile', 'project-default',
      '--workspace-root', fixture.root, '--output', rejectedPath, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: rejected.io })).toBe(1)
    expect(rejected.stdout()).toContain('unknown field')
    await expect(fs.pathExists(rejectedPath)).resolves.toBe(false)
  }, 30_000)
})
