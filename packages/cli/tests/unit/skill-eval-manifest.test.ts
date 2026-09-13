import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertNoSensitiveProfileConfig,
  validateAwSkillEvalManifest,
} from '../../src/eval/manifest-v1.js'
import { validatePluginManifest } from '../../src/utils/manifest.js'
import type { PluginMeta } from '../../src/types.js'

const roots: string[] = []

async function createFixture(): Promise<{
  evalRoot: string
  plugin: PluginMeta
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-manifest-')))
  roots.push(root)
  const evalRoot = path.join(root, 'skills', 'owner-skill', 'evals')
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json')
  await Promise.all([
    fs.outputJson(manifestPath, { name: 'fixture-plugin' }),
    fs.outputJson(path.join(evalRoot, 'selected-cases.json'), {
      version: 1,
      suite: { kind: 'trigger', unitUnderTest: 'owner-skill' },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: [],
        input: { query: 'Use the owner Skill.', expectedLoad: true },
      }],
    }),
  ])
  return {
    evalRoot,
    plugin: {
      rootDir: root,
      manifestPath,
      manifest: { name: 'fixture-plugin' },
    } as PluginMeta,
  }
}

function manifest(): Record<string, unknown> {
  return {
    version: 1,
    defaults: { profile: 'selected' },
    profiles: {
      selected: { scope: 'project', plugins: { 'fixture-plugin': {} } },
    },
    suites: [{
      id: 'trigger',
      kind: 'trigger',
      cases: 'selected-cases.json',
      profiles: ['selected'],
      releaseSplits: [],
      requiredForRelease: true,
    }],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('AwSkillEvalManifest v1 reader', () => {
  it('validates every registered source Eval manifest through the public reader', async () => {
    const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url))
    const pluginsRoot = path.join(repositoryRoot, 'plugins')
    const pluginNames = await fs.readdir(pluginsRoot)
    let validated = 0
    for (const pluginName of pluginNames) {
      const rootDir = path.join(pluginsRoot, pluginName)
      const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json')
      if (!await fs.pathExists(manifestPath)) continue
      const manifest = validatePluginManifest(rootDir, await fs.readJson(manifestPath))
      const skillsRoot = path.join(rootDir, 'skills')
      if (!await fs.pathExists(skillsRoot)) continue
      for (const skill of await fs.readdir(skillsRoot)) {
        if (!await fs.pathExists(path.join(skillsRoot, skill, 'evals', 'manifest.json'))) continue
        await expect(validateAwSkillEvalManifest({
          plugin: { rootDir, manifestPath, manifest },
          skill,
        })).resolves.toMatchObject({ valid: true, errors: [] })
        validated += 1
      }
    }
    expect(validated).toBeGreaterThan(0)
  })

  it('rejects fixed and dynamic sensitive object children without leaking values', () => {
    const plugin = {
      rootDir: '/fixture',
      manifestPath: '/fixture/.agents-plugin/plugin.json',
      manifest: {
        name: 'fixture-plugin',
        config: {
          fields: {
            settings: {
              type: 'object',
              properties: {
                public: { type: 'string' },
                token: { type: 'string', sensitive: true },
              },
              additionalProperties: { type: 'string', sensitive: true },
            },
          },
        },
      },
    } as PluginMeta
    const profile = (config: Record<string, unknown>) => ({
      id: 'selected',
      scope: 'project' as const,
      plugins: [{ name: 'fixture-plugin', config }],
    })

    expect(() => assertNoSensitiveProfileConfig(
      profile({ settings: { public: 'safe' } }),
      [plugin],
    )).not.toThrow()

    for (const [config, sensitiveValue] of [
      [{ settings: { token: 'fixed-secret-must-not-leak' } }, 'fixed-secret-must-not-leak'],
      [{ settings: { custom: 'dynamic-secret-must-not-leak' } }, 'dynamic-secret-must-not-leak'],
    ] as const) {
      let message = ''
      try {
        assertNoSensitiveProfileConfig(profile(config), [plugin])
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain('provides a sensitive config field')
      expect(message).not.toContain(sensitiveValue)
    }
  })

  it('accepts canonical v1 and rejects invalid release/profile selections', async () => {
    const fixture = await createFixture()
    const validManifest = manifest()
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), validManifest, { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      errors: [],
      manifest: { version: 1, suites: [{ releaseSplits: [] }] },
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...validManifest,
      suites: [{ ...(validManifest.suites as Record<string, unknown>[])[0], releaseSplits: ['validation', 'validation'] }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('releaseSplits must contain unique values')],
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...validManifest,
      suites: [{ ...(validManifest.suites as Record<string, unknown>[])[0], profiles: [] }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('profiles must be a non-empty array')],
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...validManifest,
      suites: [{
        ...(validManifest.suites as Record<string, unknown>[])[0],
        releaseProcessManagement: 'allow-unmanaged-confirmed',
      }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      manifest: {
        suites: [{ releaseProcessManagement: 'allow-unmanaged-confirmed' }],
      },
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...validManifest,
      suites: [{
        ...(validManifest.suites as Record<string, unknown>[])[0],
        releaseProcessManagement: 'unmanaged',
      }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('releaseProcessManagement must be managed-only or allow-unmanaged-confirmed')],
    })
  })

  it('requires the owner plugin in every profile', async () => {
    const fixture = await createFixture()
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...manifest(),
      profiles: {
        selected: { scope: 'project', plugins: { 'fixture-plugin': {} } },
        unused: { scope: 'project', plugins: { 'another-plugin': {} } },
      },
    }, { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('unused must include owner plugin "fixture-plugin"')],
      manifest: null,
    })
  })

  it('accepts scoped config overrides only for explicitly selected plugins', async () => {
    const fixture = await createFixture()
    const validManifest = manifest()
    ;(validManifest.profiles as Record<string, Record<string, unknown>>).selected!.configByScope = {
      user: { 'fixture-plugin': { mode: 'user' } },
      project: { 'fixture-plugin': { mode: 'project' } },
    }
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), validManifest)
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      manifest: {
        profiles: [{
          configByScope: {
            user: [{ name: 'fixture-plugin', config: { mode: 'user' } }],
            project: [{ name: 'fixture-plugin', config: { mode: 'project' } }],
          },
        }],
      },
    })

    ;(validManifest.profiles as Record<string, Record<string, unknown>>).selected!.configByScope = {
      user: { 'unselected-plugin': {} },
    }
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), validManifest)
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('is not declared in plugins')],
    })
  })

  it('rejects sensitive values in scoped config without leaking them', () => {
    const sensitiveValue = 'scoped-secret-must-not-leak'
    const plugin = {
      rootDir: '/fixture',
      manifestPath: '/fixture/.agents-plugin/plugin.json',
      manifest: {
        name: 'fixture-plugin',
        config: { fields: { token: { type: 'string', sensitive: true } } },
      },
    } as PluginMeta
    let message = ''
    try {
      assertNoSensitiveProfileConfig({
        id: 'selected',
        scope: 'project',
        plugins: [{ name: 'fixture-plugin', config: {} }],
        configByScope: {
          user: [{ name: 'fixture-plugin', config: { token: sensitiveValue } }],
        },
      }, [plugin])
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('provides a sensitive config field')
    expect(message).not.toContain(sensitiveValue)
  })

  it('does not invent a release requirement for a dynamic Skill', async () => {
    const fixture = await createFixture()
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'dynamic-owner',
        target: 'codex.skill',
        skillKey: 'owner-skill',
      }],
    } as NonNullable<PluginMeta['manifest']['artifacts']>
    const noReleaseSuite = manifest()
    noReleaseSuite.suites = [{
      ...((noReleaseSuite.suites as Record<string, unknown>[])[0]!),
      requiredForRelease: false,
    }]
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), noReleaseSuite, { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      errors: [],
      manifest: { suites: [{ requiredForRelease: false }] },
    })
  })

  it('rejects the legacy schemaVersion manifest shape', async () => {
    const fixture = await createFixture()
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      schemaVersion: 1,
      plugin: 'fixture-plugin',
      skill: 'owner-skill',
      profiles: [],
      suites: [],
    }, { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('unknown field "schemaVersion"')],
      manifest: null,
    })
  })

  it('accepts only the strict codex-workflow provider shape', async () => {
    const fixture = await createFixture()
    await Promise.all([
      fs.writeFile(path.join(fixture.evalRoot, 'workflow.mjs'), 'export {}\n'),
      fs.writeJson(path.join(fixture.evalRoot, 'selected-cases.json'), {
        version: 1,
        suite: { kind: 'codex-workflow', unitUnderTest: 'owner-skill' },
        cases: [{
          id: 'workflow',
          split: 'validation',
          tags: [],
          input: { prompt: 'Run the workflow.' },
          expected: { passed: true },
          assertions: ['The workflow completes.'],
        }],
      }),
    ])
    const base = manifest()
    base.suites = [{
      id: 'workflow',
      kind: 'codex-workflow',
      cases: 'selected-cases.json',
      provider: {
        type: 'codex-workflow',
        command: ['node', 'workflow.mjs'],
        allowedModels: [],
      },
    }]
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), base)
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      manifest: {
        suites: [{
          kind: 'codex-workflow',
          provider: { type: 'codex-workflow', allowedModels: [] },
        }],
      },
    })

    const suite = (base.suites as Record<string, unknown>[])[0]!
    for (const provider of [
      { type: 'codex-workflow', command: ['node', 'workflow.mjs'] },
      { type: 'codex-workflow', command: [], allowedModels: [] },
      { type: 'codex-workflow', command: ['node', 'workflow.mjs'], allowedModels: ['gpt', 'gpt'] },
      { type: 'codex-workflow', command: ['node', 'workflow.mjs'], allowedModels: [], config: {} },
      { type: 'unknown', command: ['node', 'workflow.mjs'], allowedModels: [] },
    ]) {
      await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
        ...base,
        suites: [{ ...suite, provider }],
      })
      await expect(validateAwSkillEvalManifest({
        plugin: fixture.plugin,
        skill: 'owner-skill',
      })).resolves.toMatchObject({ valid: false, manifest: null })
    }
  })
})
