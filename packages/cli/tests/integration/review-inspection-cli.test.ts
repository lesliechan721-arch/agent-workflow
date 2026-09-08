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
  it('emits one incomplete JSON receipt and exit 1 for source-only finals', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    const pluginRoot = path.join(root, 'plugins', 'fixture')
    await initializeCatalogWorkspace({ workspaceRoot: root })
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3,
      name: 'fixture',
      version: '0.1.0',
      description: 'Review inspection CLI fixture.',
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
      path.join(pluginRoot, 'skills', 'fixture', 'SKILL.md'),
      '---\nname: fixture\ndescription: Review fixture.\n---\n\n# Fixture\n',
    )
    const output = capture()

    const code = await runCli(['review', 'inspect', pluginRoot, '--json'], {
      cwd: outside,
      io: output.io,
    })

    expect(code).toBe(1)
    expect(output.stderr()).toBe('')
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 1,
      command: 'review:inspect',
      ok: false,
      completeness: 'incomplete',
      target: { kind: 'plugin', id: 'fixture', path: pluginRoot },
      snapshot: { state: 'absent' },
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'requiredFinalMissing', blocking: true }),
      ]),
    })
  })

  it('keeps argument failures in the stable JSON failure shape', async () => {
    const output = capture()

    const code = await runCli(['review', 'inspect', '--json'], { io: output.io })

    expect(code).toBe(1)
    expect(JSON.parse(output.stdout())).toMatchObject({
      schemaVersion: 1,
      command: 'review:inspect',
      ok: false,
      completeness: 'incomplete',
      issues: [{ category: 'invalid', code: 'invalidArguments', blocking: true }],
    })
  })

  it('passes the injected AW_HOME to source binding validation', async () => {
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
      '--materialization', written.bindingPath,
      '--json',
    ]

    const ambientOutput = capture()
    expect(await runCli(args, { cwd: root, io: ambientOutput.io })).toBe(1)
    expect(JSON.parse(ambientOutput.stdout()).materializations[0].state).toBe('drifted')

    const injectedOutput = capture()
    expect(await runCli(args, { cwd: root, env: injectedEnv, io: injectedOutput.io })).toBe(1)
    expect(JSON.parse(injectedOutput.stdout()).materializations[0].state).toBe('verified')
  })
})
