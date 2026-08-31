import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import {
  computeCanonicalDirectoryDigest,
  computeSkillDigest,
  validateEvalSpecFile,
} from '@lesliechan721/agent-skill-eval'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli } from '../../src/index.js'

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
  return { root, outputRoot, ownerRoot, skillRoot, evalRoot, env }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})
describe('aw skill eval commands', () => {
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
        requiredForRelease: true,
        releaseSplits: ['validation'],
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

    const output = path.join(fixture.outputRoot, 'prepared-v1')
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
    })
    await expect(validateEvalSpecFile(path.join(output, 'spec.json'))).resolves.toMatchObject({ valid: true })
    expect((await fs.readdir(output)).sort()).toEqual(['cases.json', 'spec.json', 'targets', 'workspace'])
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
