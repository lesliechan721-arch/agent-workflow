import os from 'node:os'
import path from 'node:path'

import {
  initializeCatalogWorkspace,
  type PluginManifestSource,
} from '@lesliechan721/aw-plugin-core'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  resolveReviewSelection,
  reviewBindingMatchesSelection,
} from '../../src/review/review-selection.js'
import { ReviewSelectionError } from '../../src/review/review-types.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-review-selection-')))
  roots.push(root)
  await initializeCatalogWorkspace({ workspaceRoot: root })
  return root
}

function manifest(name: string, extra: Partial<PluginManifestSource> = {}): PluginManifestSource {
  return {
    schemaVersion: 3,
    name,
    version: '0.1.0',
    description: `${name} selection fixture.`,
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...extra,
  }
}

async function writePlugin(root: string, value: PluginManifestSource): Promise<string> {
  const pluginRoot = path.join(root, 'plugins', value.name)
  await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), value)
  return pluginRoot
}

async function writeSkill(pluginRoot: string, name: string, collection = 'skills'): Promise<string> {
  const skillRoot = path.join(pluginRoot, collection, name)
  await fs.outputFile(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture.\n---\n\n# ${name}\n`,
  )
  if (collection !== 'skills') await fs.outputFile(path.join(skillRoot, 'README.md'), `# ${name}\n`)
  return skillRoot
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('Review selection', () => {
  it('resolves canonical source Skill roots and only enumerates declared profiles', async () => {
    const root = await tempRoot()
    const pluginRoot = await writePlugin(root, manifest('static-plugin', {
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
    }))
    const skillRoot = await writeSkill(pluginRoot, 'static-skill')

    const selection = await resolveReviewSelection({
      cwd: root,
      target: path.join(skillRoot, 'SKILL.md'),
      skills: ['static-skill', 'static-skill'],
    })

    expect(selection.target).toMatchObject({
      kind: 'skill', path: skillRoot, skill: 'static-skill',
    })
    expect(selection.profiles.map((entry) => entry.profile.id)).toEqual([
      'codex-project',
      'codex-user',
    ])
    expect(selection.profiles.flatMap((entry) => entry.skills)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginName: 'static-plugin',
        name: 'static-skill',
        sourcePath: skillRoot,
        targetId: null,
      }),
    ]))
    await expect(resolveReviewSelection({
      cwd: root,
      target: skillRoot,
      platform: 'claude',
    })).rejects.toMatchObject<Partial<ReviewSelectionError>>({
      code: 'unsupportedProfile', exitCode: 2,
    })
  })

  it('uses the declared renderer source for dynamic Skills and requires ambiguity resolution', async () => {
    const root = await tempRoot()
    const pluginRoot = await writePlugin(root, manifest('dynamic-plugin', {
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
      scripts: {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      },
      config: {
        fields: {
          mode: { type: 'string', default: 'standard', required: true },
          needed: { type: 'string', required: true },
          token: { type: 'string', sensitive: true, required: true },
        },
      },
      artifacts: {
        targets: [
          {
            id: 'generated-a',
            platform: 'codex',
            scopes: ['project', 'user'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: ['mode'],
            skillKey: 'generated-a',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          },
          {
            id: 'generated-b',
            platform: 'codex',
            scopes: ['project', 'user'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: ['mode'],
            skillKey: 'generated-b',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          },
          {
            id: 'generated-needed',
            platform: 'codex',
            scopes: ['project', 'user'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: ['needed'],
            skillKey: 'generated-needed',
            delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          },
        ],
      },
    }))
    const rendererPath = path.join(pluginRoot, 'scripts', 'render.mjs')
    await fs.outputFile(rendererPath, 'process.stdout.write("{}")\n')

    await expect(resolveReviewSelection({
      cwd: root,
      target: rendererPath,
      platform: 'codex',
      scope: 'project',
    })).rejects.toMatchObject<Partial<ReviewSelectionError>>({
      code: 'sourceSkillAmbiguous', exitCode: 2,
    })

    const defaults = await resolveReviewSelection({
      cwd: root,
      target: rendererPath,
      skills: ['generated-a', 'generated-a'],
      platform: 'codex',
      scope: 'project',
    })
    expect(defaults.profiles).toHaveLength(1)
    expect(defaults.profiles[0]).toMatchObject({
      profile: { id: 'codex-project', config: {} },
      skills: [{
        name: 'generated-a',
        sourcePath: rendererPath,
        delivery: 'codex-native',
        configScope: 'user',
      }],
      pluginConfigs: [{
        pluginName: 'dynamic-plugin',
        scope: 'user',
        values: { mode: 'standard' },
        sources: { mode: 'default' },
      }],
    })

    await expect(resolveReviewSelection({
      cwd: root,
      target: rendererPath,
      skills: ['generated-needed'],
      platform: 'codex',
      scope: 'project',
    })).rejects.toMatchObject<Partial<ReviewSelectionError>>({
      code: 'requiredConfigMissing', exitCode: 3,
    })
  })

  it('normalizes default overrides and binds effective config sources without reading user config', async () => {
    const root = await tempRoot()
    const pluginRoot = await writePlugin(root, manifest('configured-plugin', {
      marketplace: {
        category: 'test',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
      scripts: {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      },
      config: {
        fields: {
          mode: { type: 'string', default: 'standard', required: true },
          unrelated: { type: 'string', required: true },
          token: { type: 'string', sensitive: true, required: true },
        },
      },
      artifacts: {
        targets: [{
          id: 'configured',
          platform: 'codex',
          scopes: ['project', 'user'],
          target: 'codex.skill',
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'configured',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        }],
      },
    }))
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), 'process.stdout.write("{}")\n')
    const defaultPath = path.join(root, 'default.json')
    const customPath = path.join(root, 'custom.json')
    const sensitivePath = path.join(root, 'sensitive.json')
    await Promise.all([
      fs.writeJson(defaultPath, { 'configured-plugin': { mode: 'standard' } }),
      fs.writeJson(customPath, { 'configured-plugin': { mode: 'custom' } }),
      fs.writeJson(sensitivePath, { 'configured-plugin': { token: 'not-for-receipts' } }),
    ])
    const options = {
      cwd: root,
      target: 'configured-plugin',
      skills: ['configured'],
      platform: 'codex' as const,
      scope: 'project' as const,
    }
    const omitted = await resolveReviewSelection(options)
    const explicitDefault = await resolveReviewSelection({ ...options, configFile: defaultPath })
    const custom = await resolveReviewSelection({ ...options, configFile: customPath })

    expect(explicitDefault.profiles[0]!.profile).toEqual(omitted.profiles[0]!.profile)
    expect(custom.profiles[0]).toMatchObject({
      profile: { config: { 'configured-plugin': { mode: 'custom' } } },
      pluginConfigs: [{
        scope: 'user',
        values: { mode: 'custom' },
        sources: { mode: 'user' },
      }],
    })
    expect(custom.profiles[0]!.profile.inputDigest)
      .not.toBe(omitted.profiles[0]!.profile.inputDigest)
    await expect(resolveReviewSelection({ ...options, configFile: sensitivePath }))
      .rejects.toMatchObject<Partial<ReviewSelectionError>>({
        code: 'invalidConfig',
        exitCode: 2,
        reviewTarget: { kind: 'plugin', path: pluginRoot },
      })
  })

  it('matches a single-Skill binding to the same leaf in a Plugin profile', async () => {
    const root = await tempRoot()
    const pluginRoot = await writePlugin(root, manifest('leaf-plugin', {
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
    }))
    await Promise.all([
      writeSkill(pluginRoot, 'first'),
      writeSkill(pluginRoot, 'second'),
    ])
    const profile = { platform: 'codex' as const, scope: 'user' as const }
    const single = await resolveReviewSelection({
      cwd: root, target: 'leaf-plugin', skills: ['first'], ...profile,
    })
    const plugin = await resolveReviewSelection({
      cwd: root, target: 'leaf-plugin', ...profile,
    })

    expect(single.profiles[0]!.profile.inputDigest)
      .not.toBe(plugin.profiles[0]!.profile.inputDigest)
    await expect(reviewBindingMatchesSelection({
      workspace: plugin.workspace,
      bindingProfile: single.profiles[0]!.profile,
      requestedProfile: plugin.profiles[0]!,
      pluginName: 'leaf-plugin',
      skill: 'first',
    })).resolves.toBe(true)
  })
})
