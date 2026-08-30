import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import { validateAwSkillEvalManifest } from '../../src/eval/manifest.js'
import type { PluginMeta } from '../../src/types.js'

const roots: string[] = []

async function createFixture(): Promise<{
  evalRoot: string
  manifestPath: string
  plugin: PluginMeta
}> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aw-eval-manifest-')))
  roots.push(root)
  const evalRoot = path.join(root, 'skills', 'owner-skill', 'evals')
  const manifestPath = path.join(root, '.agents-plugin', 'plugin.json')
  await Promise.all([
    fs.outputJson(manifestPath, { name: 'fixture-plugin' }),
    fs.outputJson(path.join(evalRoot, 'cases.json'), { cases: [{ id: 'one-case' }] }),
    fs.outputFile(path.join(evalRoot, 'provider.mjs'), 'export function runEvalProvider() {}\n'),
  ])
  return {
    evalRoot,
    manifestPath,
    plugin: {
      rootDir: root,
      manifestPath,
      manifest: { name: 'fixture-plugin' },
    } as PluginMeta,
  }
}

function providerManifest(schemaVersion = 1): Record<string, unknown> {
  return {
    schemaVersion,
    plugin: 'fixture-plugin',
    skill: 'owner-skill',
    profiles: [{
      id: 'project-default',
      scope: 'project',
      plugins: [{ name: 'fixture-plugin', config: {} }],
      requiredForRelease: true,
    }],
    suites: [{
      id: 'behavior',
      kind: 'provider',
      skills: ['owner-skill'],
      cases: 'cases.json',
      profiles: ['project-default'],
      defaultRuns: 1,
      releaseSplits: [],
      requiredForRelease: true,
      perRunTimeoutMs: 10_000,
      provider: {
        id: 'fixture-provider',
        entry: 'provider.mjs',
        capabilities: {
          triggerDiscovery: false,
          conversation: true,
          skillPathExecution: true,
          previousVersionBaseline: true,
          withoutSkillBaseline: true,
          cleanContext: true,
          parallelRuns: false,
          toolTrace: true,
          tokenUsage: true,
          duration: true,
          sandbox: true,
          materialization: true,
        },
      },
    }],
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.remove(root)))
})

describe('canonical AwSkillEvalManifest reader', () => {
  it('accepts empty unique releaseSplits only for manifest v1 release selection', async () => {
    const fixture = await createFixture()
    await fs.writeJson(path.join(fixture.evalRoot, 'selected-cases.json'), {
      version: 1,
      suite: { kind: 'trigger', unitUnderTest: 'owner-skill' },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: [],
        input: {
          query: 'Use the owner Skill.',
          expectedLoad: true,
        },
      }],
    }, { spaces: 2 })
    const manifest = {
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
      }],
    }
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), manifest, { spaces: 2 })

    const emptyReleaseSplits = await validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })
    expect(emptyReleaseSplits, emptyReleaseSplits.errors.join('; ')).toMatchObject({
      valid: true,
      manifest: { version: 1, suites: [{ releaseSplits: [] }] },
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...manifest,
      suites: [{ ...manifest.suites[0], releaseSplits: ['validation', 'validation'] }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('releaseSplits must contain unique values')],
    })

    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      ...manifest,
      suites: [{ ...manifest.suites[0], profiles: [] }],
    }, { spaces: 2 })
    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('profiles must be a non-empty array')],
    })
  })

  it('requires the owner plugin in every manifest v1 profile', async () => {
    const fixture = await createFixture()
    await fs.writeJson(path.join(fixture.evalRoot, 'selected-cases.json'), {
      version: 1,
      suite: { kind: 'trigger', unitUnderTest: 'owner-skill' },
      cases: [{
        id: 'loads_skill',
        split: 'validation',
        tags: [],
        query: 'Use the owner Skill.',
        expectedLoad: true,
      }],
    }, { spaces: 2 })
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), {
      version: 1,
      defaults: { profile: 'selected' },
      profiles: {
        selected: { scope: 'project', plugins: { 'fixture-plugin': {} } },
        unused: { scope: 'project', plugins: { 'another-plugin': {} } },
      },
      suites: [{ id: 'trigger', kind: 'trigger', cases: 'selected-cases.json' }],
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

  it('accepts a self-contained v1 provider entry and applies optional defaults', async () => {
    const fixture = await createFixture()
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), providerManifest(), { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: true,
      manifest: {
        schemaVersion: 1,
        suites: [{
          kind: 'provider',
          provider: {
            entry: 'provider.mjs',
            assets: [],
            credentialEnvironment: [],
          },
        }],
      },
    })
  })

  it('rejects the old v2 command-provider contract', async () => {
    const fixture = await createFixture()
    const manifest = providerManifest(2)
    await fs.writeJson(path.join(fixture.evalRoot, 'manifest.json'), manifest, { spaces: 2 })

    await expect(validateAwSkillEvalManifest({
      plugin: fixture.plugin,
      skill: 'owner-skill',
    })).resolves.toMatchObject({
      valid: false,
      errors: [expect.stringContaining('schemaVersion must be 1')],
      manifest: null,
    })
  })
})
