import os from 'node:os'
import path from 'node:path'

import { computeAwCapabilitySetDigest } from '@lesliechan721/aw-plugin-core/manifest'
import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  describeCurrentAw,
  discoverAwPluginRequirements,
  IMPLEMENTED_AW_CAPABILITIES,
} from '../../src/commands/aw-capabilities.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)))
})

describe('current AW executable capabilities', () => {
  it('describes only implemented capabilities with a bound digest', () => {
    const expectedCapabilities = [
      'aw.plugin-manifest.v2',
      'aw.plugin-skills.v1',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v1',
      'aw.plugin-lifecycle.v1',
      'aw.dynamic-artifacts.v2',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
      'aw.skill-validation.v1',
      'aw.plugin-authoring.v1',
      'aw.catalog-authoring.v1',
      'aw.catalog-context.v1',
      'aw.catalog-source.v2',
      'aw.catalog-dev-source.v1',
      'aw.catalog-publication.v1',
      'aw.review-publication.v1',
      'aw.catalog-snapshot.v5',
      'aw.self-check.v1',
    ]
    expect(IMPLEMENTED_AW_CAPABILITIES).toEqual(expectedCapabilities)
    const result = describeCurrentAw('1.2.3')
    expect(result).toMatchObject({
      schemaVersion: 1,
      command: 'self:describe',
      awVersion: '1.2.3',
      coreVersion: expect.any(String),
    })
    expect(result.capabilities).toEqual([...expectedCapabilities].sort())
    expect(result.capabilities).toContain('aw.plugin-manifest.v2')
    expect(result.capabilities).toContain('aw.catalog-snapshot.v5')
    expect(result.capabilities).toContain('aw.catalog-source.v2')
    expect(result.capabilities).toContain('aw.catalog-dev-source.v1')
    expect(result.capabilitySetDigest).toBe(computeAwCapabilitySetDigest(result.capabilities))
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
