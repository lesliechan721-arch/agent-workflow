import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { initializeCatalogWorkspace, readCatalogWorkspace } from '@lesliechan721/aw-plugin-core'

import { runCli } from '../../src/index.js'
import {
  resolvePortableProfileBindingInput,
  resolveWorkspaceBindingSource,
  writeAwSourceBinding,
} from '../../src/review/source-binding.js'
import { writePluginConfigStore } from '../../src/utils/plugin-config.js'
import { CLI_RESERVED_IMPORTS } from '../../src/utils/manifest.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-inspection-cli-')))
  roots.push(root)
  return root
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('review inspect CLI entry', () => {
  it('emits the default review view and exit 0 for source-only finals', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const pluginRoot = path.join(root, 'plugins', 'fixture')
    const executionMarker = path.join(root, 'build-ran')
    const historicalReport = path.join(root, 'reports', 'reviews', 'historical', 'report.md')
    const historicalBytes = Buffer.from('# Review\r\n原始字节\r\n', 'utf8')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.outputFile(historicalReport, historicalBytes)
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3,
      name: 'fixture',
      version: '0.1.0',
      description: 'Review inspection CLI fixture.',
      skills: './skills',
      scripts: { node: { build: { runner: 'node', path: './scripts/build.mjs' } } },
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
    })
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'fixture', 'SKILL.md'),
      '---\nname: fixture\ndescription: Review fixture.\n---\n\n# Fixture\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'build.mjs'), [
      "import fs from 'node:fs'",
      `fs.writeFileSync(${JSON.stringify(executionMarker)}, 'executed')`,
      "throw new Error('Inspection must not execute a build.')",
    ].join('\n'))
    const output = capture()

    const code = await runCli(['review', 'inspect', pluginRoot, '--json'], {
      cwd: outside,
      io: output.io,
    })

    expect(code).toBe(0)
    expect(output.stderr()).toBe('')
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: true,
      target: { kind: 'plugin', path: pluginRoot },
      skills: expect.arrayContaining([
        expect.objectContaining({
          skill: 'fixture',
          sourcePath: path.join(pluginRoot, 'skills', 'fixture'),
          finalPath: null,
          digest: null,
          state: 'missing',
          evidencePath: null,
        }),
      ]),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'requiredFinalMissing' }),
      ]),
    })

    const explicitReviewOutput = capture()
    expect(await runCli(['review', 'inspect', pluginRoot, '--view', 'review', '--json'], {
      cwd: outside,
      io: explicitReviewOutput.io,
    })).toBe(0)
    expect(JSON.parse(explicitReviewOutput.stdout())).toEqual(JSON.parse(output.stdout()))

    const repeatedSkillOutput = capture()
    expect(await runCli([
      'review', 'inspect', pluginRoot,
      '--skill', 'fixture', '--skill', 'fixture', '--json',
    ], {
      cwd: outside,
      io: repeatedSkillOutput.io,
    })).toBe(0)
    const repeatedSkills = JSON.parse(repeatedSkillOutput.stdout()).skills as Array<{
      skill: string
      profile: { platform: string; scope: string }
    }>
    expect(repeatedSkills.length).toBeGreaterThan(0)
    expect(new Set(repeatedSkills.map((entry) => entry.skill))).toEqual(new Set(['fixture']))
    expect(new Set(repeatedSkills.map((entry) =>
      `${entry.skill}:${entry.profile.platform}:${entry.profile.scope}`)).size).toBe(repeatedSkills.length)

    const textOutput = capture()
    expect(await runCli(['review', 'inspect', pluginRoot], {
      cwd: outside,
      io: textOutput.io,
    })).toBe(0)
    expect(textOutput.stderr()).toBe('')
    expect(textOutput.stdout()).toContain('Review inspection (review): ok')
    expect(textOutput.stdout()).toContain('fixture\t')
    expect(await fs.pathExists(executionMarker)).toBe(false)
    expect(await fs.pathExists(path.join(root, '.aw', 'catalog'))).toBe(false)
    expect(await fs.readFile(historicalReport)).toEqual(historicalBytes)
  })

  it('rejects release views and archive commands without changing historical reports', async () => {
    const root = await tempRoot()
    const archiveRoot = path.join(root, 'reports', 'reviews', 'historical')
    const reportPath = path.join(archiveRoot, 'report.md')
    const manifestPath = path.join(archiveRoot, 'manifest.json')
    const report = Buffer.from('# Historical report\r\n原始报告\r\n', 'utf8')
    const record = Buffer.from('{"schemaVersion":1,"opaque":true}\n', 'utf8')
    await fs.outputFile(reportPath, report)
    await fs.outputFile(manifestPath, record)

    for (const viewArgs of [['--view', 'release'], ['--view=release']]) {
      const output = capture()
      expect(await runCli([
        'review', 'inspect', root, ...viewArgs, '--json',
      ], { cwd: root, io: output.io })).toBe(2)
      expect(output.stderr()).toBe('')
      expect(JSON.parse(output.stdout())).toMatchObject({
        schemaVersion: 2,
        command: 'review:inspect',
        view: 'review',
        ok: false,
        target: null,
        sources: [],
        skills: [],
        issues: [{ code: 'invalidArguments', message: expect.stringContaining('release') }],
      })
    }
    for (const command of ['digest', 'publish', 'verify', 'list', 'show']) {
      const output = capture()
      expect(await runCli(['review', command], { cwd: root, io: output.io })).not.toBe(0)
      expect(output.stderr()).toContain(`unknown command '${command}'`)
    }

    expect(await fs.readFile(reportPath)).toEqual(report)
    expect(await fs.readFile(manifestPath)).toEqual(record)
    expect(await fs.readdir(archiveRoot)).toEqual(['manifest.json', 'report.md'])
    expect(await fs.readdir(root)).toEqual(['reports'])
  })

  it('keeps argument failures in the stable JSON failure shape', async () => {
    const output = capture()

    const code = await runCli(['review', 'inspect', '--json'], { io: output.io })

    expect(code).toBe(2)
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: false,
      target: null,
      sources: [],
      skills: [],
      issues: [{ code: 'invalidArguments', path: null }],
    })
  })

  it.each([
    ['plugin', false],
    ['skill', true],
  ] as const)('preserves a resolved canonical %s target when a binding is invalid', async (
    expectedKind,
    useSkillTarget,
  ) => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot()
    const pluginRoot = path.join(root, 'plugins', 'invalid-binding')
    const skillRoot = path.join(pluginRoot, 'skills', 'invalid-binding')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3,
      name: 'invalid-binding',
      version: '0.1.0',
      description: 'Invalid binding target fixture.',
      skills: './skills',
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
    })
    await fs.outputFile(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: invalid-binding\ndescription: Invalid binding fixture.\n---\n\n# Fixture\n',
    )
    const bindingPath = path.join(materializedRoot, 'aw-source-binding.json')
    await fs.writeJson(bindingPath, useSkillTarget
      ? { schemaVersion: 1, kind: 'aw-source-binding' }
      : { schemaVersion: 2, kind: 'damaged-binding' })
    const output = capture()

    const code = await runCli([
      'review', 'inspect', useSkillTarget ? skillRoot : pluginRoot,
      '--platform', 'codex',
      '--scope', 'user',
      '--materialization', bindingPath,
      '--json',
    ], { cwd: root, io: output.io })

    expect(code).toBe(2)
    expect(output.stderr()).toBe('')
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 2,
      command: 'review:inspect',
      view: 'review',
      ok: false,
      target: {
        kind: expectedKind,
        path: useSkillTarget ? skillRoot : pluginRoot,
      },
      sources: [],
      skills: [],
      issues: [{ code: 'sourceBindingInvalid', path: null }],
    })
  })

  it('does not use a binding custom config as the default request config', async () => {
    const root = await tempRoot()
    const materializedRoot = await tempRoot()
    const injectedHome = path.join(await tempRoot(), 'injected-home')
    const pluginRoot = path.join(root, 'plugins', 'portable-env')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3,
      name: 'portable-env',
      version: '0.1.0',
      description: 'Portable environment fixture.',
      extensions: { instructions: [{ name: 'native', title: 'Native', content: 'Native.' }] },
      distributions: { agentSkills: { skills: './portable-skills' } },
      scripts: { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } },
      artifacts: { targets: [{
        id: 'portable',
        distribution: 'agent-skills',
        target: 'agent-skills.skill',
        kind: 'skill',
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['flavor'],
        skillKey: 'portable',
        sourceDirs: ['./portable-skills/portable'],
      }] },
      config: {
        fields: {
          flavor: { type: 'string', required: true, default: 'ambient' },
        },
      },
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    })
    const sourceSkill = path.join(pluginRoot, 'portable-skills', 'portable')
    await fs.outputFile(
      path.join(sourceSkill, 'SKILL.md'),
      '---\nname: portable\ndescription: Portable fixture.\n---\n\n# Portable\n',
    )
    await fs.outputFile(path.join(sourceSkill, 'README.md'), '# Portable\n')
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'render.mjs'),
      'throw new Error("Review inspection must not run the renderer.")\n',
    )
    const injectedEnv = { ...process.env, AW_HOME: injectedHome }
    await writePluginConfigStore({
      pluginName: 'portable-env',
      scope: 'user',
      cwd: root,
      env: injectedEnv,
      values: { flavor: 'injected' },
    })
    const workspace = await readCatalogWorkspace(root, { reservedImports: CLI_RESERVED_IMPORTS })
    await fs.copy(sourceSkill, path.join(materializedRoot, 'portable'))
    const written = await writeAwSourceBinding({
      rootDir: materializedRoot,
      source: await resolveWorkspaceBindingSource(workspace),
      subject: { plugin: 'portable-env' },
      profile: await resolvePortableProfileBindingInput({
        plugins: workspace.plugins,
        pluginName: 'portable-env',
        scope: 'user',
        cwd: root,
        env: injectedEnv,
      }),
      artifacts: [{
        kind: 'portable-skill',
        plugin: 'portable-env',
        skill: 'portable',
        path: 'portable',
      }],
    })
    const args = [
      'review', 'inspect', pluginRoot,
      '--platform', 'agent-skills', '--scope', 'user',
      '--materialization', written.bindingPath,
      '--json',
    ]

    const ambientOutput = capture()
    expect(await runCli(args, { cwd: root, io: ambientOutput.io })).toBe(0)
    expect(JSON.parse(ambientOutput.stdout())).toMatchObject({
      view: 'review',
      skills: [{ state: 'stale', evidencePath: written.bindingPath }],
    })

    const injectedOutput = capture()
    expect(await runCli(args, { cwd: root, env: injectedEnv, io: injectedOutput.io })).toBe(0)
    expect(JSON.parse(injectedOutput.stdout())).toMatchObject({
      view: 'review',
      skills: [{ state: 'missing' }],
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'materializationNotSelected' }),
      ]),
    })

    const repeatedMaterializationOutput = capture()
    expect(await runCli([
      ...args.slice(0, -1), '--materialization', written.bindingPath, '--json',
    ], { cwd: root, env: injectedEnv, io: repeatedMaterializationOutput.io })).toBe(0)
    expect(JSON.parse(repeatedMaterializationOutput.stdout()))
      .toEqual(JSON.parse(injectedOutput.stdout()))

  })
})
