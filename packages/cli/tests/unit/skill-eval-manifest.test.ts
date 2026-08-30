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
