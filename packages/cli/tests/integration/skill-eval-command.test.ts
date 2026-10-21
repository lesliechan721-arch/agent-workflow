import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  computeCanonicalDirectoryDigest,
  computeEvalProviderDigest,
  computeSkillDigest,
  validateEvalSpecFile,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'
import { setSkillEvalCommandTestHooksForTests } from '../../src/commands/skill-eval.js'
import {
  createAwSourceBindingWorkspaceValidationContext,
  validateAwSourceBindingForWorkspace,
} from '../../src/review/source-binding.js'

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
  outputRoot: string
  ownerRoot: string
  skillRoot: string
  evalRoot: string
  env: NodeJS.ProcessEnv
}> {
  const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-eval-command-'))
  const root = await fs.realpath(createdRoot)
  const outputRoot = await fs.mkdtemp(`${root}-outputs-`)
  roots.push(root, outputRoot)
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
    fields: {
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
  return { root, outputRoot, ownerRoot, skillRoot, evalRoot, env }
}

afterEach(async () => {
  setSkillEvalCommandTestHooksForTests(undefined)
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})
describe('aw skill eval commands', () => {
  it('binds explicit non-sensitive config overrides and rejects changes before commit', async () => {
    // Protect the public prepare boundary: actual paths can be supplied without editing
    // a profile or signing a runtime receipt, and the same values can be revalidated.
    const fixture = await createWorkspace()
    const manifestPath = path.join(fixture.ownerRoot, '.agents-plugin', 'plugin.json')
    const pluginManifest = await fs.readJson(manifestPath)
    pluginManifest.artifacts = { targets: [{
      id: 'configured', platform: 'codex', scopes: ['project', 'user'],
      target: 'codex.skill', delivery: { mode: 'aw-extension' },
      states: ['present'], refreshKeys: ['mode'], skillKey: 'configured-skill',
    }] }
    pluginManifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } }
    await fs.writeJson(manifestPath, pluginManifest, { spaces: 2 })
    await fs.outputFile(path.join(fixture.ownerRoot, 'scripts', 'render.mjs'), [
      "import { readFile } from 'node:fs/promises';",
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'process.stdout.write(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "configured", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: "present", skillKey: "configured-skill", refreshKeys: ["mode"],',
      '  content: { files: {',
      '    "SKILL.md": "---\\nname: configured-skill\\ndescription: Inspect deterministic configured content.\\n---\\nRead render.json.\\n",',
      '    "README.md": "Inspect deterministic configured content.\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n",',
      '    "render.json": JSON.stringify({ mode: context.config.values.mode }),',
      '  } },',
      '}]}));',
    ].join('\n'))
    await fs.writeFile(path.join(fixture.skillRoot, 'SKILL.md'),
      (await fs.readFile(path.join(fixture.skillRoot, 'SKILL.md'), 'utf8')).replaceAll('TODO', 'Fixture instruction'))
    await fs.writeJson(path.join(fixture.evalRoot, 'cases.json'), {
      version: 1,
      suite: { kind: 'trigger', unitUnderTest: 'owner-skill', participants: ['configured-skill'] },
      cases: [{ id: 'configured', split: 'validation', tags: [], input: { query: 'Inspect configuration.', expectedLoad: true } }],
    })
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      version: 1,
      defaults: { profile: 'local' },
      profiles: { local: { scope: 'project', plugins: { 'eval-owner': { mode: 'profile-value' } } } },
      suites: [{ id: 'configured', kind: 'trigger', cases: 'cases.json' }],
    })
    const configFile = path.join(fixture.outputRoot, 'config.json')
    await fs.writeJson(configFile, { 'eval-owner': { mode: 'explicit-value' } })
    const output = path.join(fixture.outputRoot, 'configured')
    const io = capture()
    const args = [
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--workspace-root', fixture.root, '--config-file', configFile, '--output', output, '--json',
    ]
    expect(await runCli(args, { cwd: fixture.root, env: fixture.env, io: io.io }), io.stdout()).toBe(0)
    expect(await fs.readJson(path.join(output, 'workspace', 'subject', '.agents', 'skills', 'configured-skill', 'render.json')))
      .toEqual({ mode: 'explicit-value' })
    const sourceBindingPath = JSON.parse(io.stdout()).sourceBindingPath as string
    expect((await fs.readJson(sourceBindingPath)).profile.config).toEqual({ 'eval-owner': { mode: 'explicit-value' } })
    const workspaceContext = await createAwSourceBindingWorkspaceValidationContext(fixture.root)
    expect((await validateAwSourceBindingForWorkspace({
      bindingPath: sourceBindingPath, cwd: fixture.root, context: workspaceContext,
      expectedSubject: { plugin: 'eval-owner', skill: 'owner-skill', suite: 'configured' },
    })).state).toBe('verified')

    await fs.writeJson(configFile, { 'eval-owner': { token: 'never-expose-this-token' } })
    const sensitive = capture()
    expect(await runCli(args.map((arg) => arg === output ? `${output}-secret` : arg), {
      cwd: fixture.root, env: fixture.env, io: sensitive.io,
    })).toBe(1)
    expect(`${sensitive.stdout()}${sensitive.stderr()}`).not.toContain('never-expose-this-token')
    expect(await fs.pathExists(`${output}-secret`)).toBe(false)

    await fs.writeJson(configFile, { 'eval-owner': { mode: 'before-change' } })
    setSkillEvalCommandTestHooksForTests({ beforePrepareCommit: async () => {
      await fs.writeJson(configFile, { 'eval-owner': { mode: 'after-change' } })
    } })
    const drifted = capture()
    expect(await runCli(args.map((arg) => arg === output ? `${output}-drifted` : arg), {
      cwd: fixture.root, env: fixture.env, io: drifted.io,
    })).toBe(1)
    expect(await fs.pathExists(`${output}-drifted`)).toBe(false)
  }, 30_000)

  it('prepares mixed static, dynamic, and shared native Codex content with scoped config', async () => {
    const fixture = await createWorkspace()
    const providerInit = capture()
    expect(await runCli([
      'plugin', 'init', 'runtime-provider',
      '--description', 'Runtime provider for Eval materialization tests.',
      '--skill-name', 'provider-skill',
      '--skill-description', 'Provide runtime data in Eval materialization tests.',
      '--skill-short-description', 'Provide deterministic runtime data',
      '--workspace-root', fixture.root,
    ], { cwd: fixture.root, env: fixture.env, io: providerInit.io }), `${providerInit.stdout()}${providerInit.stderr()}`).toBe(0)
    const providerManifestPath = path.join(
      fixture.root, 'plugins', 'runtime-provider', '.agents-plugin', 'plugin.json',
    )
    const providerManifest = await fs.readJson(providerManifestPath)
    providerManifest.buildConfig = {
      runtimeExports: [{
        name: 'runtime-data',
        source: './shared/runtime-data.json',
        requires: { aw: { capabilities: [] } },
      }],
    }
    await fs.writeJson(providerManifestPath, providerManifest, { spaces: 2 })
    await fs.outputJson(
      path.join(fixture.root, 'plugins', 'runtime-provider', 'shared', 'runtime-data.json'),
      { runtimeImport: true },
    )
    const participantManifestPath = path.join(
      fixture.root, 'plugins', 'participant-plugin', '.agents-plugin', 'plugin.json',
    )
    const participantManifest = await fs.readJson(participantManifestPath)
    participantManifest.dependencies = ['runtime-provider']
    participantManifest.buildConfig = {
      skillRuntimeFiles: [{
        skill: 'participant-skill',
        target: 'references/runtime-import.json',
        import: { plugin: 'runtime-provider', export: 'runtime-data' },
      }],
    }
    await fs.writeJson(participantManifestPath, participantManifest, { spaces: 2 })
    const manifestPath = path.join(fixture.ownerRoot, '.agents-plugin', 'plugin.json')
    const pluginManifest = await fs.readJson(manifestPath)
    pluginManifest.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    }
    pluginManifest.config.fields.roleMode = { type: 'string', required: true }
    pluginManifest.config.fields.nativeMode = { type: 'string', required: true }
    pluginManifest.config.fields.dynamicEnabled = { type: 'boolean', required: true }
    pluginManifest.config.fields.nativeEnabled = { type: 'boolean', required: true }
    pluginManifest.artifacts = {
      targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'aw-extension' },
        states: ['present', 'disabled'],
        refreshKeys: ['roleMode', 'dynamicEnabled'],
        skillKey: 'dynamic-skill',
      }, {
        id: 'native-skill',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        projectManagedKind: 'skill',
        states: ['present', 'disabled'],
        refreshKeys: ['nativeMode', 'nativeEnabled'],
        skillKey: 'native-skill',
      }, {
        id: 'fixture-role',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.agentRole',
        states: ['present'],
        refreshKeys: ['roleMode'],
        roleKey: 'fixture-role',
        requiresCodexProjectConfig: true,
      }],
    }
    await fs.writeJson(manifestPath, pluginManifest, { spaces: 2 })
    const rendererLog = path.join(fixture.root, 'renderer-requests.jsonl')
    await fs.outputFile(path.join(fixture.ownerRoot, 'scripts', 'render.mjs'), [
      "import fs from 'node:fs';",
      "const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      `fs.appendFileSync(${JSON.stringify(rendererLog)}, JSON.stringify(context.requestedArtifactIds) + '\\n');`,
      'const artifacts = context.requestedArtifactIds.map((id) => {',
      "  if (id === 'fixture-role') return {",
      "    id, kind: 'codexRole', platform: 'codex', target: 'codex.agentRole', state: 'present',",
      "    roleKey: 'fixture-role', refreshKeys: ['roleMode'], content: {",
      "      registration: { description: 'Eval fixture role.' },",
      "      roleFile: { name: 'fixture-role', description: 'Eval fixture role.', developer_instructions: 'Fixture.', model: context.config.values.roleMode },",
      '    },',
      '  };',
      "  const skillKey = id === 'native-skill' ? 'native-skill' : 'dynamic-skill';",
      "  const refreshKeys = id === 'native-skill' ? ['nativeMode', 'nativeEnabled'] : ['roleMode', 'dynamicEnabled'];",
      "  const selected = id === 'native-skill' ? context.config.values.nativeMode : context.config.values.roleMode;",
      "  const enabled = id === 'native-skill' ? context.config.values.nativeEnabled : context.config.values.dynamicEnabled;",
      "  if (!enabled) return { id, kind: 'skill', platform: 'codex', target: 'codex.skill', state: 'disabled', skillKey, refreshKeys };",
      '  return {',
      "    id, kind: 'skill', platform: 'codex', target: 'codex.skill', state: 'present', skillKey, refreshKeys,",
      '    content: { files: {',
      "      'SKILL.md': `---\\nname: ${skillKey}\\ndescription: ${skillKey} Eval fixture.\\n---\\n\\n# ${skillKey}\\n`,",
      "      'README.md': `# ${skillKey}\\n`,",
      "      'agents/openai.yaml': 'policy:\\n  allow_implicit_invocation: true\\n',",
      "      'render.json': JSON.stringify({ selected, targetScope: context.config.targetScope }),",
      "      'references/native-tree.json': JSON.stringify({ nativeTree: true }),",
      '    } },',
      '  };',
      '});',
      'process.stdout.write(JSON.stringify({ version: 2, artifacts }));',
    ].join('\n'))
    const selectedCasesPath = path.join(fixture.evalRoot, 'trigger-cases.json')
    await fs.writeJson(selectedCasesPath, {
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'owner-skill',
        participants: ['owner-skill', 'participant-skill', 'dynamic-skill', 'native-skill'],
      },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: [],
        input: { query: 'Use the owner Skill.', expectedLoad: true },
      }],
    }, { spaces: 2 })
    await fs.writeFile(
      path.join(fixture.skillRoot, 'SKILL.md'),
      (await fs.readFile(path.join(fixture.skillRoot, 'SKILL.md'), 'utf8')).replaceAll('TODO', 'Fixture instruction'),
    )
    const manifest = {
      version: 1,
      defaults: { profile: 'project-scoped' },
      profiles: {
        'project-scoped': {
          scope: 'project',
          plugins: {
            'eval-owner': {
              mode: 'common-mode', roleMode: 'common-role', nativeMode: 'common-native',
              dynamicEnabled: true, nativeEnabled: true,
            },
            'participant-plugin': {},
          },
          configByScope: {
            project: { 'eval-owner': { roleMode: 'project-role' } },
            user: { 'eval-owner': { nativeMode: 'user-native' } },
          },
        },
        'user-scoped': {
          scope: 'user',
          plugins: {
            'eval-owner': {
              mode: 'common-mode', roleMode: 'common-role', nativeMode: 'common-native',
              dynamicEnabled: true, nativeEnabled: true,
            },
            'participant-plugin': {},
          },
          configByScope: {
            user: { 'eval-owner': { roleMode: 'user-role', nativeMode: 'user-native' } },
          },
        },
        'optional-disabled': {
          scope: 'project',
          plugins: {
            'eval-owner': {
              mode: 'common-mode', roleMode: 'common-role', nativeMode: 'common-native',
              dynamicEnabled: false, nativeEnabled: false,
            },
            'participant-plugin': {},
          },
        },
      },
      suites: [
        { id: 'trigger-suite', kind: 'trigger', cases: 'trigger-cases.json' },
        { id: 'optional-suite', kind: 'trigger', cases: 'optional-cases.json' },
        { id: 'required-native-suite', kind: 'trigger', cases: 'required-native-cases.json' },
      ],
    }
    const optionalCases = {
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'owner-skill',
        participants: ['owner-skill', 'participant-skill'],
      },
      cases: [{
        id: 'loads_skill', split: 'validation', tags: [],
        input: { query: 'Use the owner Skill.', expectedLoad: true },
      }],
    }
    await fs.writeJson(path.join(fixture.evalRoot, 'optional-cases.json'), optionalCases, { spaces: 2 })
    await fs.writeJson(path.join(fixture.evalRoot, 'required-native-cases.json'), {
      ...optionalCases,
      suite: { ...optionalCases.suite, participants: ['owner-skill', 'native-skill'] },
    }, { spaces: 2 })
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), manifest, { spaces: 2 })

    for (const [profile, roleMode] of [
      ['project-scoped', 'project-role'],
      ['user-scoped', 'user-role'],
    ] as const) {
      const output = path.join(fixture.outputRoot, profile)
      const command = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
        '--suite', 'trigger-suite', '--profile', profile,
        '--workspace-root', fixture.root, '--output', output, '--json',
      ], { cwd: fixture.root, env: fixture.env, io: command.io }), command.stdout()).toBe(0)
      const subject = path.join(output, 'workspace', 'subject')
      await expect(fs.readJson(path.join(
        subject, '.agents', 'skills', 'native-skill', 'render.json',
      ))).resolves.toEqual({ selected: 'user-native', targetScope: 'user' })
      await expect(fs.readJson(path.join(
        subject, '.agents', 'skills', 'dynamic-skill', 'render.json',
      ))).resolves.toEqual({ selected: roleMode, targetScope: profile === 'project-scoped' ? 'project' : 'user' })
      await expect(fs.pathExists(path.join(
        subject, '.agents', 'skills', 'native-skill', 'references', 'native-tree.json',
      ))).resolves.toBe(true)
      await expect(fs.readJson(path.join(
        subject, '.agents', 'skills', 'participant-skill', 'references', 'runtime-import.json',
      ))).resolves.toEqual({ runtimeImport: true })
      await expect(fs.pathExists(path.join(
        subject, '.agents', 'skills', 'participant-skill', 'SKILL.md',
      ))).resolves.toBe(true)
      await expect(fs.readFile(path.join(subject, '.codex', 'agents', 'aw-eval-owner-fixture-role.toml'), 'utf8'))
        .resolves.toContain(`model = ${JSON.stringify(roleMode)}`)
      await expect(validateEvalSpecFile(path.join(output, 'spec.json')))
        .resolves.toMatchObject({ valid: true })
    }

    await fs.writeFile(rendererLog, '')
    const optionalOutput = path.join(fixture.outputRoot, 'optional-disabled')
    const optional = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'optional-suite', '--profile', 'optional-disabled',
      '--workspace-root', fixture.root, '--output', optionalOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: optional.io }), optional.stdout()).toBe(0)
    const optionalSubject = path.join(optionalOutput, 'workspace', 'subject', '.agents', 'skills')
    await expect(fs.pathExists(path.join(optionalSubject, 'dynamic-skill'))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(optionalSubject, 'native-skill'))).resolves.toBe(false)
    const requests = (await fs.readFile(rendererLog, 'utf8')).trim().split('\n')
      .flatMap((line) => JSON.parse(line) as string[])
    expect(requests.filter((id) => id === 'dynamic-skill')).toHaveLength(1)
    expect(requests.filter((id) => id === 'native-skill')).toHaveLength(1)

    const requiredDisabledOutput = path.join(fixture.outputRoot, 'required-native-disabled')
    const requiredDisabled = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'required-native-suite', '--profile', 'optional-disabled',
      '--workspace-root', fixture.root, '--output', requiredDisabledOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: requiredDisabled.io })).toBe(1)
    await expect(fs.pathExists(requiredDisabledOutput)).resolves.toBe(false)

    pluginManifest.skills = './skills'
    await fs.writeJson(manifestPath, pluginManifest, { spaces: 2 })
    const dynamicEvalRoot = path.join(fixture.ownerRoot, 'skills', 'dynamic-skill', 'evals')
    await fs.outputJson(path.join(dynamicEvalRoot, 'cases.json'), {
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'dynamic-skill',
        participants: ['dynamic-skill', 'participant-skill'],
      },
      cases: [{
        id: 'loads_dynamic', split: 'validation', tags: [],
        input: { query: 'Use the dynamic Skill.', expectedLoad: true },
      }],
    }, { spaces: 2 })
    await fs.outputJson(path.join(dynamicEvalRoot, 'manifest.json'), {
      version: 1,
      defaults: { profile: 'user-target' },
      profiles: {
        'user-target': {
          scope: 'user',
          plugins: {
            'eval-owner': {
              mode: 'common-mode', roleMode: 'user-role', nativeMode: 'user-native',
              dynamicEnabled: true, nativeEnabled: true,
            },
            'participant-plugin': {},
          },
        },
      },
      suites: [{ id: 'dynamic-target', kind: 'trigger', cases: 'cases.json' }],
    }, { spaces: 2 })
    const dynamicTargetOutput = path.join(fixture.outputRoot, 'user-dynamic-target')
    const dynamicTarget = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'dynamic-skill',
      '--suite', 'dynamic-target', '--profile', 'user-target',
      '--workspace-root', fixture.root, '--output', dynamicTargetOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: dynamicTarget.io }), dynamicTarget.stdout()).toBe(0)
    await expect(fs.pathExists(path.join(
      dynamicTargetOutput, 'targets', 'current', 'SKILL.md',
    ))).resolves.toBe(true)
    const dynamicSubject = path.join(dynamicTargetOutput, 'workspace', 'subject')
    await expect(fs.pathExists(path.join(
      dynamicSubject, '.agents', 'skills', 'dynamic-skill',
    ))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(
      dynamicSubject, '.codex', 'skills', 'dynamic-skill',
    ))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(
      dynamicSubject, '.agents', 'skills', 'participant-skill', 'SKILL.md',
    ))).resolves.toBe(true)

    await fs.writeFile(
      path.join(fixture.ownerRoot, 'scripts', 'render.mjs'),
      "process.stderr.write('fixture renderer failed\\n'); process.exit(7);\n",
    )
    const failedOutput = path.join(fixture.outputRoot, 'renderer-failed')
    const failed = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite', '--profile', 'project-scoped',
      '--workspace-root', fixture.root, '--output', failedOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: failed.io })).toBe(1)
    await expect(fs.pathExists(failedOutput)).resolves.toBe(false)
    expect((await fs.readdir(fixture.outputRoot)).some((entry) =>
      entry.includes('.renderer-failed.aw-eval-stage-'))).toBe(false)
  }, 30_000)

  it('prepares the new manifest v1 as a fixed EvalSpec workspace and runs doctor read-only', async () => {
    const fixture = await createWorkspace()
    await fs.outputFile(
      path.join(fixture.skillRoot, 'references', 'generated-reference.md'),
      'materialized generated reference\n',
    )
    await fs.writeFile(
      path.join(fixture.skillRoot, 'SKILL.md'),
      (await fs.readFile(path.join(fixture.skillRoot, 'SKILL.md'), 'utf8'))
        .replaceAll('TODO', 'Fixture instruction'),
    )
    const selectedCasesPath = path.join(fixture.evalRoot, 'selected-cases.json')
    const v1Cases = {
      version: 1,
      suite: {
        kind: 'trigger',
        unitUnderTest: 'owner-skill',
        participants: ['owner-skill', 'participant-skill'],
        runtime: { isolation: 'standard' },
      },
      cases: [{
        id: 'validation_case',
        split: 'validation',
        tags: ['release'],
        input: {
          query: 'Use the owner Skill.',
          expectedLoad: true,
        },
      }, {
        id: 'train_case',
        split: 'train',
        tags: ['development'],
        input: {
          query: 'Do not use the owner Skill.',
          expectedLoad: false,
        },
      }],
    }
    await fs.writeJson(selectedCasesPath, v1Cases, { spaces: 2 })
    const heldOutCasesPath = path.join(fixture.evalRoot, 'held-out-cases.json')
    await fs.writeJson(heldOutCasesPath, {
      ...v1Cases,
      cases: [{
        id: 'held_out_case',
        split: 'sanity',
        tags: ['held-out'],
        input: {
          query: 'Held-out query must not enter another suite workspace.',
          expectedLoad: false,
        },
      }],
    }, { spaces: 2 })
    const manifestPath = path.join(fixture.evalRoot, 'manifest.json')
    const v1Manifest = {
      version: 1,
      defaults: { profile: 'project-default', runs: 2, timeoutMs: 12_000 },
      profiles: {
        'project-default': {
          scope: 'project',
          plugins: {
            'eval-owner': { mode: 'fixture-mode' },
            'participant-plugin': {},
          },
        },
      },
      suites: [{
        id: 'trigger-suite',
        kind: 'trigger',
        cases: 'selected-cases.json',
      }, {
        id: 'held-out-suite',
        kind: 'trigger',
        cases: 'held-out-cases.json',
      }],
    }
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })
    const sourceBefore = await treeDigests(fixture.ownerRoot)
    const validation = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: validation.io }), validation.stdout()).toBe(0)
    expect(JSON.parse(validation.stdout())).toMatchObject({ ok: true, errors: [] })
    const blockedOutput = path.join(fixture.root, 'prepared-v1')
    const blocked = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite',
      '--workspace-root', fixture.root,
      '--output', blockedOutput,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: blocked.io })).toBe(1)
    expect(`${blocked.stdout()}${blocked.stderr()}`).toContain('overlaps source content')
    await expect(fs.pathExists(blockedOutput)).resolves.toBe(false)
    expect(await treeDigests(fixture.ownerRoot)).toEqual(sourceBefore)

    const workspaceEvalRoot = path.join(fixture.root, '.aw', 'evals')
    await fs.ensureDir(workspaceEvalRoot)
    const existingOutput = path.join(workspaceEvalRoot, 'existing')
    await fs.ensureDir(existingOutput)
    const linkedOutput = path.join(workspaceEvalRoot, 'linked')
    await fs.symlink(fixture.outputRoot, linkedOutput)
    for (const [label, rejectedOutput] of [
      ['workspace eval root', workspaceEvalRoot],
      ['other workspace path', path.join(fixture.root, '.aw', 'other', 'prepared')],
      ['plugin path', path.join(fixture.ownerRoot, 'prepared')],
      ['existing target', existingOutput],
      ['symlink component', path.join(linkedOutput, 'prepared')],
      ['broad workspace target', fixture.root],
    ] as const) {
      const rejected = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
        '--suite', 'trigger-suite',
        '--workspace-root', fixture.root,
        '--output', rejectedOutput,
        '--json',
      ], { cwd: fixture.root, env: fixture.env, io: rejected.io }), label).toBe(1)
    }

    const aliasRoot = path.join(
      path.dirname(fixture.root),
      path.basename(fixture.root).toUpperCase(),
    )
    const resolvedAlias = await fs.realpath(aliasRoot).catch(() => null)
    if (resolvedAlias === fixture.root && aliasRoot !== fixture.root) {
      const aliased = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
        '--suite', 'trigger-suite',
        '--workspace-root', fixture.root,
        '--output', path.join(aliasRoot, 'case-alias-bypass'),
        '--json',
      ], { cwd: fixture.root, env: fixture.env, io: aliased.io })).toBe(1)
      await expect(fs.pathExists(path.join(fixture.root, 'case-alias-bypass'))).resolves.toBe(false)
    }

    const output = path.join(workspaceEvalRoot, 'prepared-v1')
    const command = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite',
      '--workspace-root', fixture.root,
      '--split', 'validation',
      '--case', 'validation_case',
      '--runs', '3',
      '--timeout-ms', '9000',
      '--baseline', 'without-skill',
      '--output', output,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: command.io }), command.stdout()).toBe(0)
    const receipt = JSON.parse(command.stdout())
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      command: 'skill:eval:prepare',
      ok: true,
      suite: 'trigger-suite',
      profile: 'project-default',
      specPath: path.join(output, 'spec.json'),
      sourceBindingPath: path.join(output, 'aw-source-binding.json'),
    })
    await expect(validateEvalSpecFile(path.join(output, 'spec.json'))).resolves.toMatchObject({ valid: true })
    expect((await fs.readdir(output)).sort()).toEqual([
      'aw-source-binding.json', 'cases.json', 'spec.json', 'targets', 'workspace',
    ])
    await expect(fs.readJson(receipt.sourceBindingPath)).resolves.toMatchObject({
      schemaVersion: 2,
      kind: 'aw-source-binding',
      profile: { kind: 'eval' },
    })
    await expect(fs.pathExists(path.join(output, 'output'))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(output, 'preparation.json'))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(output, 'provider'))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(output, 'targets', 'current', 'references', 'generated-reference.md')))
      .resolves.toBe(true)
    await expect(fs.pathExists(path.join(
      output, 'workspace', 'subject', '.agents', 'skills', 'owner-skill',
    ))).resolves.toBe(false)
    await expect(fs.pathExists(path.join(
      output, 'workspace', 'subject', '.agents', 'skills', 'participant-skill', 'SKILL.md',
    ))).resolves.toBe(true)
    await expect(fs.pathExists(path.join(output, 'workspace', 'eval', 'selected-cases.json')))
      .resolves.toBe(false)
    await expect(fs.pathExists(path.join(output, 'workspace', 'eval', 'held-out-cases.json')))
      .resolves.toBe(false)
    const spec = await fs.readJson(path.join(output, 'spec.json'))
    expect(spec).toMatchObject({
      version: 1,
      source: { plugin: 'eval-owner', skill: 'owner-skill', suite: 'trigger-suite', profile: 'project-default' },
      workspace: { path: 'workspace', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
      provider: 'codex-trigger',
      runs: 3,
      timeoutMs: 9000,
      baseline: { type: 'without-skill' },
      outputDir: 'output',
    })
    expect(await fs.readJson(path.join(output, 'cases.json'))).toMatchObject({
      version: 1,
      cases: [{ id: 'validation_case' }],
    })
    expect(await computeCanonicalDirectoryDigest(path.join(output, 'workspace'))).toBe(spec.workspace.digest)
    expect(await computeSkillDigest(path.join(output, 'targets', 'current'))).toBe(spec.target.digest)
    expect(await treeDigests(fixture.ownerRoot)).toEqual(sourceBefore)

    const bindingContext = await createAwSourceBindingWorkspaceValidationContext(fixture.root)
    const bindingOptions = {
      bindingPath: receipt.sourceBindingPath,
      context: bindingContext,
      expectedSubject: { plugin: 'eval-owner', skill: 'owner-skill', suite: 'trigger-suite' },
      cwd: fixture.root,
      env: fixture.env,
    }
    const verifiedBinding = await validateAwSourceBindingForWorkspace(bindingOptions)
    expect(verifiedBinding.state).toBe('verified')
    if (verifiedBinding.state !== 'verified') throw new Error('Expected a verified source binding.')
    expect(verifiedBinding.binding).toMatchObject({
      source: { kind: 'workspace', workspaceIdentity: expect.any(String) },
      profile: { kind: 'eval', id: 'project-default', scope: 'project' },
      evalInput: {
        casesPath: expect.stringMatching(/selected-cases\.json$/u),
        selectedCaseIds: ['validation_case'],
        suiteDefaultsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        selectedCasesDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        fixturesDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        providerDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        inputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      },
    })
    expect(verifiedBinding.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining(
        { kind: 'eval-target', skill: 'owner-skill', path: path.join(output, 'targets', 'current') },
      ),
      expect.objectContaining(
        { kind: 'eval-workspace', path: path.join(output, 'workspace') },
      ),
    ]))
    const preparedCasesOutput = verifiedBinding.outputs.find((entry) => entry.kind === 'eval-cases')
    expect(preparedCasesOutput?.digest).not.toBe(verifiedBinding.binding.evalInput?.selectedCasesDigest)
    expect(verifiedBinding.binding.evalInput?.providerDigest).toBe(computeEvalProviderDigest(spec.provider))

    const sourceCasesBytes = await fs.readFile(selectedCasesPath)
    await fs.writeJson(selectedCasesPath, {
      ...v1Cases,
      cases: v1Cases.cases.map((entry) => entry.id === 'train_case'
        ? { ...entry, input: { ...entry.input, query: 'Changed unselected source case.' } }
        : entry),
    }, { spaces: 2 })
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'verified',
    })
    await fs.writeFile(selectedCasesPath, sourceCasesBytes)

    await fs.writeJson(selectedCasesPath, {
      ...v1Cases,
      cases: v1Cases.cases.map((entry) => entry.id === 'validation_case'
        ? { ...entry, input: { ...entry.input, query: 'Changed selected source case.' } }
        : entry),
    }, { spaces: 2 })
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingEvalInputDrift' })]),
    })
    await fs.writeFile(selectedCasesPath, sourceCasesBytes)

    const fixturePath = path.join(fixture.evalRoot, 'provider.mjs')
    const fixtureBytes = await fs.readFile(fixturePath)
    await fs.appendFile(fixturePath, '\n// changed fixture\n')
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingEvalInputDrift' })]),
    })
    await fs.writeFile(fixturePath, fixtureBytes)

    const manifestBytes = await fs.readFile(manifestPath)
    await fs.writeJson(manifestPath, {
      ...v1Manifest,
      defaults: { ...v1Manifest.defaults, runs: 4 },
    }, { spaces: 2 })
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingEvalInputDrift' })]),
    })
    await fs.writeFile(manifestPath, manifestBytes)

    const targetSkillPath = path.join(output, 'targets', 'current', 'SKILL.md')
    const targetSkillBytes = await fs.readFile(targetSkillPath)
    await fs.appendFile(targetSkillPath, '\nchanged target\n')
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingArtifactDrift' })]),
    })
    await fs.writeFile(targetSkillPath, targetSkillBytes)

    const participantPath = path.join(
      output, 'workspace', 'subject', '.agents', 'skills', 'participant-skill', 'SKILL.md',
    )
    const participantBytes = await fs.readFile(participantPath)
    await fs.appendFile(participantPath, '\nchanged workspace\n')
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingArtifactDrift' })]),
    })
    await fs.writeFile(participantPath, participantBytes)

    const ownerReadmePath = path.join(fixture.ownerRoot, 'README.md')
    const ownerReadmeBytes = await fs.readFile(ownerReadmePath)
    await fs.appendFile(ownerReadmePath, '\nchanged shared source\n')
    await expect(validateAwSourceBindingForWorkspace({
      ...bindingOptions,
      context: await createAwSourceBindingWorkspaceValidationContext(fixture.root),
    })).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingSourceDrift' })]),
    })
    await fs.writeFile(ownerReadmePath, ownerReadmeBytes)

    await fs.writeJson(manifestPath, {
      ...v1Manifest,
      profiles: {
        'project-default': {
          ...v1Manifest.profiles['project-default'],
          plugins: {
            ...v1Manifest.profiles['project-default'].plugins,
            'eval-owner': { mode: 'changed-profile' },
          },
        },
      },
    }, { spaces: 2 })
    await expect(validateAwSourceBindingForWorkspace(bindingOptions)).resolves.toMatchObject({
      state: 'drifted',
      issues: expect.arrayContaining([expect.objectContaining({ code: 'sourceBindingProfileDrift' })]),
    })
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })

    const prepareMutations = [
      {
        name: 'case',
        mutate: () => fs.writeJson(selectedCasesPath, {
          ...v1Cases,
          cases: v1Cases.cases.map((entry) => entry.id === 'validation_case'
            ? { ...entry, input: { ...entry.input, query: 'Changed while staged.' } }
            : entry),
        }, { spaces: 2 }),
      },
      { name: 'fixture', mutate: () => fs.appendFile(fixturePath, '\n// changed while staged\n') },
      {
        name: 'defaults',
        mutate: () => fs.writeJson(manifestPath, {
          ...v1Manifest, defaults: { ...v1Manifest.defaults, runs: 4 },
        }, { spaces: 2 }),
      },
    ]
    for (const mutation of prepareMutations) {
      const changedDuringPrepareOutput = path.join(fixture.outputRoot, `${mutation.name}-changed-during-prepare`)
      setSkillEvalCommandTestHooksForTests({ beforePrepareCommit: mutation.mutate })
      const changedDuringPrepare = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
        '--suite', 'trigger-suite',
        '--workspace-root', fixture.root,
        '--output', changedDuringPrepareOutput,
        '--json',
      ], { cwd: fixture.root, env: fixture.env, io: changedDuringPrepare.io }), mutation.name).toBe(1)
      await expect(fs.pathExists(changedDuringPrepareOutput)).resolves.toBe(false)
      setSkillEvalCommandTestHooksForTests(undefined)
      await Promise.all([
        fs.writeFile(selectedCasesPath, sourceCasesBytes),
        fs.writeFile(fixturePath, fixtureBytes),
        fs.writeFile(manifestPath, manifestBytes),
      ])
    }

    fixture.env.AW_SKILL_EVAL_CODEX_BIN = 'fixture-isolated-codex'
    const beforeDoctor = await treeDigests(fixture.root)
    const doctor = capture()
    expect(await runCli([
      'skill', 'eval', 'doctor', '--json',
    ], { cwd: fixture.root, env: fixture.env, io: doctor.io }), doctor.stdout()).toBe(0)
    expect(JSON.parse(doctor.stdout())).toMatchObject({
      providers: ['codex-trigger', 'codex-conversation'],
      codex: { requestedExecutable: 'fixture-isolated-codex' },
      cleanup: { supported: expect.any(Boolean) },
    })
    expect(await treeDigests(fixture.root)).toEqual(beforeDoctor)

    await fs.writeJson(path.join(fixture.evalRoot, 'custom-cases.json'), {
      version: 1,
      suite: { kind: 'custom-process', unitUnderTest: 'owner-skill' },
      cases: [{
        id: 'custom_case',
        split: 'validation',
        tags: ['custom'],
        input: { prompt: 'Run custom provider.' },
        expected: { ok: true },
        assertions: ['Returns ok.'],
      }],
    }, { spaces: 2 })
    const customManifest = {
      ...v1Manifest,
      suites: [{
        id: 'custom-suite',
        kind: 'custom-process',
        cases: 'custom-cases.json',
        provider: { type: 'custom-process', command: ['node', 'provider.mjs'] },
      }],
    }
    await fs.writeJson(manifestPath, customManifest, { spaces: 2 })
    const customOutput = path.join(fixture.outputRoot, 'custom-v1')
    const custom = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--workspace-root', fixture.root, '--output', customOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: custom.io }), custom.stdout()).toBe(0)
    await expect(fs.readJson(path.join(customOutput, 'spec.json'))).resolves.toMatchObject({
      provider: {
        type: 'custom-process',
        command: ['node', 'workspace/eval/provider.mjs'],
      },
    })
    await expect(fs.pathExists(path.join(customOutput, 'workspace', 'eval', 'provider.mjs')))
      .resolves.toBe(true)

    await fs.writeJson(path.join(fixture.evalRoot, 'workflow-cases.json'), {
      version: 1,
      suite: { kind: 'codex-workflow', unitUnderTest: 'owner-skill' },
      cases: [{
        id: 'workflow_case',
        split: 'validation',
        tags: ['workflow'],
        input: { prompt: 'Run Codex workflow.' },
        expected: { ok: true },
        assertions: ['Returns ok.'],
      }],
    }, { spaces: 2 })
    const workflowManifest = {
      ...v1Manifest,
      suites: [{
        id: 'workflow-suite',
        kind: 'codex-workflow',
        cases: 'workflow-cases.json',
        provider: {
          type: 'codex-workflow',
          command: ['node', 'provider.mjs'],
          allowedModels: ['gpt-approved'],
        },
      }],
    }
    await fs.writeJson(manifestPath, workflowManifest, { spaces: 2 })
    const workflowOutput = path.join(fixture.outputRoot, 'workflow-v1')
    const workflow = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--workspace-root', fixture.root, '--output', workflowOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: workflow.io }), workflow.stdout()).toBe(0)
    await expect(fs.readJson(path.join(workflowOutput, 'spec.json'))).resolves.toMatchObject({
      provider: {
        type: 'codex-workflow',
        command: ['node', 'workspace/eval/provider.mjs'],
        allowedModels: ['gpt-approved'],
      },
    })
    await expect(validateEvalSpecFile(path.join(workflowOutput, 'spec.json')))
      .resolves.toMatchObject({ valid: true })
    await expect(fs.pathExists(path.join(workflowOutput, 'workspace', 'eval', 'provider.mjs')))
      .resolves.toBe(true)

    await fs.writeJson(manifestPath, customManifest, { spaces: 2 })
    for (const [index, unsafeCommand] of [
      [process.execPath, 'provider.mjs'],
      ['node', '../provider.mjs'],
      ['node', '/tmp/provider.mjs'],
      ['node', 'nested\\provider.mjs'],
      ['node', 'provider.mjs\0'],
    ].entries()) {
      await fs.writeJson(manifestPath, {
        ...customManifest,
        suites: [{ ...customManifest.suites[0], provider: { type: 'custom-process', command: unsafeCommand } }],
      }, { spaces: 2 })
      const unsafeOutput = path.join(fixture.outputRoot, `unsafe-custom-v1-${index}`)
      const unsafe = capture()
      expect(await runCli([
        'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
        '--workspace-root', fixture.root, '--output', unsafeOutput, '--json',
      ], { cwd: fixture.root, env: fixture.env, io: unsafe.io })).toBe(1)
      await expect(fs.pathExists(unsafeOutput)).resolves.toBe(false)
    }
    await fs.writeJson(selectedCasesPath, v1Cases, { spaces: 2 })
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })

    await fs.writeJson(manifestPath, {
      ...v1Manifest,
      profiles: {
        ...v1Manifest.profiles,
        unused: { scope: 'project', plugins: { 'participant-plugin': {} } },
      },
    }, { spaces: 2 })
    const invalidOwnerProfile = capture()
    const invalidOwnerOutput = path.join(fixture.outputRoot, 'invalid-owner-profile-v1')
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite',
      '--workspace-root', fixture.root,
      '--output', invalidOwnerOutput,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: invalidOwnerProfile.io })).toBe(1)
    expect(`${invalidOwnerProfile.stdout()}${invalidOwnerProfile.stderr()}`)
      .toContain('must include owner plugin')
    await expect(fs.pathExists(invalidOwnerOutput)).resolves.toBe(false)
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })

    const sensitiveValue = 'new-manifest-secret-must-not-be-planned'
    v1Manifest.profiles['project-default'].plugins['eval-owner'] = {
      mode: 'fixture-mode',
      token: sensitiveValue,
    }
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })
    const sensitiveOutput = path.join(fixture.outputRoot, 'sensitive-v1')
    const sensitive = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite',
      '--workspace-root', fixture.root, '--output', sensitiveOutput, '--json',
    ], { cwd: fixture.root, env: fixture.env, io: sensitive.io })).toBe(1)
    expect(sensitive.stdout()).not.toContain(sensitiveValue)
    await expect(fs.pathExists(sensitiveOutput)).resolves.toBe(false)

    v1Manifest.profiles['project-default'].plugins['eval-owner'] = { mode: 'fixture-mode' }
    await fs.writeJson(manifestPath, v1Manifest, { spaces: 2 })
    const atomicOutput = path.join(fixture.outputRoot, 'atomic-v1')
    const atomic = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner', 'owner-skill',
      '--suite', 'trigger-suite',
      '--workspace-root', fixture.root,
      '--previous-version', path.join(fixture.root, 'missing-previous'),
      '--output', atomicOutput,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: atomic.io })).toBe(1)
    await expect(fs.pathExists(atomicOutput)).resolves.toBe(false)
    expect((await fs.readdir(fixture.outputRoot)).filter((entry) => entry.includes('.atomic-v1.aw-eval-stage-')))
      .toEqual([])
  }, 30_000)


  it('rejects legacy manifest, option, and command surfaces', async () => {
    const fixture = await createWorkspace()
    const skillPath = path.join(fixture.skillRoot, 'SKILL.md')
    await fs.writeFile(
      skillPath,
      (await fs.readFile(skillPath, 'utf8')).replaceAll('TODO', 'Fixture instruction'),
    )
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      schemaVersion: 1,
      plugin: 'eval-owner',
      skill: 'owner-skill',
      profiles: [],
      suites: [],
    }, { spaces: 2 })

    const legacyManifest = capture()
    expect(await runCli([
      'plugin', 'validate', fixture.ownerRoot,
      '--workspace-root', fixture.root,
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: legacyManifest.io })).toBe(1)
    expect(JSON.parse(legacyManifest.stdout())).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('unknown field "schemaVersion"'),
      ]),
    })

    const legacyOption = capture()
    expect(await runCli([
      'skill', 'eval', 'prepare', 'eval-owner',
      '--skill', 'owner-skill',
      '--workspace-root', fixture.root,
      '--output', path.join(fixture.outputRoot, 'legacy-option-output'),
      '--json',
    ], { cwd: fixture.root, env: fixture.env, io: legacyOption.io })).toBe(1)
    expect(legacyOption.stderr()).toContain("unknown option '--skill'")

    for (const command of ['check', 'provider']) {
      const removedCommand = capture()
      expect(await runCli([
        'skill', 'eval', command,
      ], { cwd: fixture.root, env: fixture.env, io: removedCommand.io })).toBe(1)
      expect(removedCommand.stderr()).toContain('unknown command')
    }
  }, 20_000)
})
