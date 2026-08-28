import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AW_CAPABILITY_IDS,
  checkAwCapabilitySupport,
  computeAwCapabilitySetDigest,
  deriveAwCapabilitiesFromManifest,
  getAwCapabilityRegistry,
  normalizeAwCapabilities,
  parseAwPluginRequirementsReceipt,
  resolvePluginRequirements,
  scanPluginAwCliRequirements,
} from '../../src/manifest.js'
import type { NormalizedPluginManifest } from '../../src/types.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)))
})

function manifest(overrides: Record<string, unknown> = {}): NormalizedPluginManifest {
  return {
    schemaVersion: 1,
    name: 'example',
    version: '1.0.0',
    description: 'Example.',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    compatibility: { aw: { minVersion: '0.1.0' } },
    ...overrides,
  } as NormalizedPluginManifest
}

describe('AW capability contracts', () => {
  it('publishes a unique fixed registry and stable normalized digest', () => {
    const expectedRegistry = [
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
      'aw.catalog-context.v1',
      'aw.catalog-authoring.v1',
      'aw.catalog-source.v2',
      'aw.catalog-dev-source.v1',
      'aw.catalog-publication.v1',
      'aw.catalog-snapshot.v5',
      'aw.self-check.v1',
    ]
    expect(AW_CAPABILITY_IDS).toEqual(expectedRegistry)
    expect(getAwCapabilityRegistry()).toEqual(expectedRegistry)
    expect(new Set(getAwCapabilityRegistry()).size).toBe(getAwCapabilityRegistry().length)
    expect(normalizeAwCapabilities([
      'aw.plugin-skills.v1', 'aw.plugin-config.v1', 'aw.plugin-skills.v1',
    ])).toEqual(['aw.plugin-config.v1', 'aw.plugin-skills.v1'])
    expect(computeAwCapabilitySetDigest([
      'aw.plugin-skills.v1', 'aw.plugin-config.v1',
    ])).toBe(computeAwCapabilitySetDigest([
      'aw.plugin-config.v1', 'aw.plugin-skills.v1', 'aw.plugin-config.v1',
    ]))
    expect(computeAwCapabilitySetDigest(['aw.self-check.v1']))
      .toBe('sha256:07e66a91aef4989637bd24703703305ea88250c2538f810f3820acdddc73b5e1')
  })

  it('treats an unknown valid capability as missing, not invalid data', () => {
    expect(checkAwCapabilitySupport(
      ['aw.future-feature.v3', 'aw.plugin-skills.v1'],
      ['aw.plugin-skills.v1'],
    )).toEqual({ supported: false, missing: ['aw.future-feature.v3'] })
  })

  it('validates receipt digest while accepting unknown valid capability IDs', () => {
    const requiredCapabilities = ['aw.future-feature.v3']
    expect(parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      capabilitySetDigest: computeAwCapabilitySetDigest(requiredCapabilities),
    }).requiredCapabilities).toEqual(requiredCapabilities)
    expect(() => parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      capabilitySetDigest: 'sha256:bad',
    })).toThrow('capabilitySetDigest')
  })

  it('derives coarse structural requirements without adding a v1 manifest capability', () => {
    expect(deriveAwCapabilitiesFromManifest(manifest({
      skills: './skills',
      buildConfig: {
        runtimeExports: [{ name: 'shared', source: './shared.mjs' }],
      },
      config: { schema: {} },
      scripts: { lifecycle: { install: { default: { runner: 'node', path: './scripts/install.mjs' } } } },
      artifacts: { targets: [{ id: 'dynamic', scopes: ['user'], target: 'codex.skill', states: ['present'], refreshKeys: [] }] },
      distributions: { agentSkills: { skills: './portable' } },
    }))).toEqual([
      'aw.dynamic-artifacts.v2',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v1',
      'aw.plugin-lifecycle.v1',
      'aw.plugin-skills.v1',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
    ])
  })

  it('scans only production Skill, script, and slash-command sources', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-core-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), '`aw plugin validate . --json`\n')
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'README.md'), '`aw catalog source add`\n')
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'run.mjs'),
      'spawnSync("aw", ["skill", "validate", "./skill"])\nconst fixture = "PATH aw rejected fixture"\n',
    )
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'ignored.txt'), 'aw catalog publish\n')
    await fs.outputFile(path.join(pluginRoot, 'commands', 'release.md'), 'aw catalog status --preflight\n')
    await fs.outputFile(path.join(pluginRoot, 'references', 'notes.md'), 'aw catalog publish\n')
    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({ slashCommands: './commands' }),
    })
    expect(result.detected).toEqual([
      'aw.catalog-authoring.v1',
      'aw.catalog-publication.v1',
      'aw.plugin-authoring.v1',
      'aw.skill-validation.v1',
    ])
    expect(result.observations.map((entry) => entry.path)).not.toContain('skills/one/README.md')
    expect(result.observations.map((entry) => entry.path)).not.toContain('references/notes.md')
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw rejected fixture' }),
    ]))
  })

  it('detects static Node process argv and keeps dynamic argv non-blocking', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-process-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'run.mjs'), [
      'spawn("aw", ["plugin", "validate"])',
      'spawnSync("aw", ["catalog", "publish"])',
      'execFile("aw", ["unknown", "command"])',
      'execFileSync("aw", argv)',
      'const fixture = "PATH aw rejected fixture"',
    ].join('\n'))
    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest() })
    expect(result.detected).toEqual([
      'aw.catalog-publication.v1',
      'aw.plugin-authoring.v1',
    ])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', command: 'aw unknown command', blocking: true }),
      expect.objectContaining({ code: 'aw-command-dynamic', blocking: false }),
    ]))
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw rejected fixture' }),
    ]))
  })

  it('reports unmapped literals as blocking and dynamic construction as non-blocking', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-observation-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'run.sh'),
      'aw unknown command\naw "$GROUP" "$COMMAND"\nconst command = "aw " + group + " " + action\n',
    )
    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: manifest(),
      implementedCapabilities: [],
    })
    expect(result.declared).toEqual([])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'aw-command-unmapped', blocking: true }),
      expect.objectContaining({ code: 'aw-command-dynamic', blocking: false }),
    ]))
  })
})
