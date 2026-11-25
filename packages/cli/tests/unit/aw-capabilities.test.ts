import os from 'node:os'
import path from 'node:path'

import {
  computeAwCapabilitySetDigest,
  getAwCapabilityRegistry,
  resolvePluginRequirements,
} from '@lesliechan721/aw-plugin-core/manifest'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  describeCurrentAw,
  discoverAwPluginRequirements,
  IMPLEMENTED_AW_CAPABILITIES,
} from '../../src/commands/aw-capabilities.js'
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js'
import { readPluginManifest } from '../../src/utils/manifest.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)))
})

describe('current AW executable capabilities', () => {
  it('describes only implemented capabilities with a bound digest', () => {
    const registry = new Set(getAwCapabilityRegistry())
    expect(IMPLEMENTED_AW_CAPABILITIES.every((capability) => registry.has(capability))).toBe(true)
    const result = describeCurrentAw('1.2.3')
    expect(result).toMatchObject({
      schemaVersion: 1,
      command: 'self:describe',
      awVersion: '1.2.3',
      coreVersion: expect.any(String),
    })
    expect(result.capabilities).toEqual([...IMPLEMENTED_AW_CAPABILITIES].sort())
    expect(result.capabilities).toContain('aw.cli-output.v2')
    expect(result.capabilities).not.toContain('aw.self-check.v1')
    expect(result.capabilities).not.toContain('aw.plugin-authoring.v1')
    expect(result.capabilities).toContain('aw.plugin-manifest.v4')
    expect(result.capabilities).toContain('aw.plugin-config-array.v1')
    expect(result.capabilities).toContain('aw.plugin-config.v5')
    expect(result.capabilities).toEqual(expect.arrayContaining([
      'aw.plugin-config-suggestions.v2', 'aw.plugin-config-platform-only.v1',
      'aw.plugin-config-clears-on-change.v1', 'aw.plugin-config-ref-override.v1',
    ]))
    expect(result.capabilities.filter((id) => id.startsWith('aw.plugin-config-suggestions.'))).toEqual(['aw.plugin-config-suggestions.v2'])
    expect(result.capabilities).toContain('aw.catalog-snapshot.v7')
    expect(result.capabilities).toContain('aw.catalog-source.v3')
    expect(result.capabilities).toContain('aw.catalog-dev-source.v2')
    expect(result.capabilities).not.toContain('aw.catalog-context.v1')
    expect(result.capabilities).not.toContain('aw.skill-eval.v1')
    expect(result.capabilities).toContain('aw.skill-eval.v3')
    expect(result.capabilities).toContain('aw.review-preparation.v2')
    expect(result.capabilities).toContain('aw.review-inspection.v3')
    expect(result.capabilities).toContain('aw.plugin-recovery.v2')
    expect(result.capabilities).not.toContain('aw.project-recovery.v1')
    expect(result.capabilities).not.toContain('aw.review-publication.v1')
    expect(result.capabilities).not.toContain('aw.review-inspection.v1')
    expect(result.capabilities).toContain('aw.installed-runtime-config.v2')
    expect(result.capabilities).not.toContain('aw.installed-runtime-config.v1')
    expect(result.capabilitySetDigest).toBe(computeAwCapabilitySetDigest(result.capabilities))
  })

  it('binds source-only config requirements to the generated bundle before references and unused definitions disappear', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-v5-requirements-'))
    tempDirs.push(root)
    const pluginRoot = path.join(root, 'source')
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 4, name: 'config-v5-example', version: '1.0.0', description: 'Config v5 bundle example',
      platforms: ['codex'], skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 5,
        definitions: { text: { type: 'string' }, unused: { type: 'string', clearsOnChange: ['other'] } },
        fields: { model: { $ref: '#/config/definitions/text', platformOnly: true } },
      },
    })
    await fs.outputFile(path.join(pluginRoot, 'skills', 'example', 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'example', 'agents', 'openai.yaml'), 'interface:\n  display_name: Example\n')
    const source = await readPluginManifest(pluginRoot)
    const sourceRequirements = await resolvePluginRequirements({ pluginRoot, manifest: source.manifest,
      implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES })
    const expected = ['aw.plugin-config-ref-override.v1', 'aw.plugin-config-clears-on-change.v1', 'aw.plugin-config-platform-only.v1']
    expect(sourceRequirements.derived).toEqual(expect.arrayContaining(expected))
    const bundleRoot = path.join(root, 'bundle')
    await bundleLocalPlugin(source, bundleRoot)
    const bundle = await readPluginManifest(bundleRoot)
    expect(bundle.manifest.requires?.aw.capabilities).toEqual(expect.arrayContaining(expected))
    expect(Object.keys(bundle.manifest.config!).sort()).toEqual(['fields', 'presentation', 'schemaVersion'])
    const bundledRequirements = await resolvePluginRequirements({ pluginRoot: bundleRoot, manifest: bundle.manifest,
      implementedCapabilities: IMPLEMENTED_AW_CAPABILITIES })
    expect(bundledRequirements.derived).not.toContain('aw.plugin-config-ref-override.v1')
    expect(bundledRequirements.derived).not.toContain('aw.plugin-config-clears-on-change.v1')
    expect(bundledRequirements.effective).toEqual(expect.arrayContaining(expected))
  })

  it('uses the nearest candidate and does not skip a damaged receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-discovery-'))
    tempDirs.push(root)
    const nested = path.join(root, 'plugin', 'skills', 'one')
    await fs.ensureDir(nested)
    const capabilities = ['aw.plugin-skills.v1']
    await fs.writeJson(path.join(root, 'aw-plugin-requirements.json'), {
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'outer', version: '1.0.0' },
      requiredCapabilities: capabilities,
      digest: computeAwCapabilitySetDigest(capabilities),
    })
    await fs.writeFile(path.join(root, 'plugin', 'aw-plugin-requirements.json'), '{broken', 'utf8')

    await expect(discoverAwPluginRequirements(nested)).rejects.toThrow()
  })

  it('discovers from a file and gives a same-layer receipt priority over a manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-receipt-'))
    tempDirs.push(root)
    const startFile = path.join(root, 'nested', 'input.txt')
    await fs.outputFile(startFile, 'input')
    await fs.ensureDir(path.join(root, 'nested', '.agents-plugin'))
    const capabilities = ['aw.future-feature.v3']
    await fs.writeJson(path.join(root, 'nested', 'aw-plugin-requirements.json'), {
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'receipt', version: '1.0.0' },
      requiredCapabilities: capabilities,
      digest: computeAwCapabilitySetDigest(capabilities),
    })
    await fs.writeFile(path.join(root, 'nested', '.agents-plugin', 'plugin.json'), '{broken', 'utf8')

    await expect(discoverAwPluginRequirements(startFile)).resolves.toMatchObject({
      source: { kind: 'receipt' },
      plugin: { name: 'receipt' },
      requiredCapabilities: capabilities,
    })
  })

  it('rejects a non-regular nearest candidate instead of following or skipping it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-self-candidate-kind-'))
    tempDirs.push(root)
    const nested = path.join(root, 'nested')
    await fs.ensureDir(path.join(nested, 'aw-plugin-requirements.json'))
    await expect(discoverAwPluginRequirements(nested)).rejects.toThrow('expected a regular file')
  })
})
