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
    schemaVersion: 3,
    name: 'example',
    version: '1.0.0',
    description: 'Example.',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    ...overrides,
  } as NormalizedPluginManifest
}

describe('AW capability contracts', () => {
  it('publishes a unique fixed registry and stable normalized digest', () => {
    const registry = getAwCapabilityRegistry()
    expect(registry).toEqual(AW_CAPABILITY_IDS)
    expect(registry.every((capability) => normalizeAwCapabilities([capability])[0] === capability))
      .toBe(true)
    expect(new Set(registry).size).toBe(registry.length)
    expect(registry).not.toContain('aw.catalog-context.v1')
    expect(normalizeAwCapabilities([
      'aw.plugin-skills.v1', 'aw.plugin-config.v2', 'aw.plugin-skills.v1',
    ])).toEqual(['aw.plugin-config.v2', 'aw.plugin-skills.v1'])
    expect(computeAwCapabilitySetDigest([
      'aw.plugin-skills.v1', 'aw.plugin-config.v2',
    ])).toBe(computeAwCapabilitySetDigest([
      'aw.plugin-config.v2', 'aw.plugin-skills.v1', 'aw.plugin-config.v2',
    ]))
  })

  it('accepts unknown valid capabilities as exchange data and validates receipt digests', () => {
    expect(checkAwCapabilitySupport(
      ['aw.future-feature.v3', 'aw.plugin-skills.v1'],
      ['aw.plugin-skills.v1'],
    )).toEqual({ supported: false, missing: ['aw.future-feature.v3'] })

    const requiredCapabilities = ['aw.future-feature.v3']
    expect(parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      digest: computeAwCapabilitySetDigest(requiredCapabilities),
    }).requiredCapabilities).toEqual(requiredCapabilities)
    expect(() => parseAwPluginRequirementsReceipt({
      schemaVersion: 1,
      kind: 'aw-plugin-requirements',
      plugin: { name: 'example', version: '1.0.0' },
      requiredCapabilities,
      digest: 'sha256:bad',
    })).toThrow('digest')
  })

  it('derives requirements only from manifest structure', () => {
    expect(deriveAwCapabilitiesFromManifest(manifest({
      skills: './skills',
      buildConfig: {
        runtimeExports: [{
          name: 'shared', source: './shared.mjs',
          requires: { aw: { capabilities: [] } },
        }],
      },
      config: { fields: {} },
      scripts: { lifecycle: { install: { default: { runner: 'node', path: './scripts/install.mjs' } } } },
      artifacts: { targets: [{ id: 'dynamic', scopes: ['user'], target: 'codex.skill', states: ['present'], refreshKeys: [] }] },
      distributions: { agentSkills: { skills: './portable' } },
    }))).toEqual([
      'aw.dynamic-artifacts.v2',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v2',
      'aw.plugin-lifecycle.v1',
      'aw.plugin-manifest.v3',
      'aw.plugin-skills.v1',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
    ])
  })

  it('scans only shell fences in actual Skill mains and static Manifest executables', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-core-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), [
      'Run `aw catalog dev status` when needed.',
      'aw plugin validate . --json',
      '```text',
      'aw catalog build',
      '```',
      '```bash',
      'aw catalog publish plan --json',
      'aw self check --json && aw future command',
      'aw "$GROUP" status',
      '```',
      '',
    ].join('\n'))
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'references', 'SKILL.md'),
      '```bash\naw catalog source list\n```\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'references', 'commands.md'),
      '```bash\naw catalog source list\n```\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'scripts', 'run.sh'),
      'aw catalog source list\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'README.md'),
      '```bash\naw catalog source list\n```\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'entry.mjs'),
      'import "./helper.mjs"\nspawnSync("aw", ["catalog", "source", "list"])\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'helper.mjs'),
      'spawnSync("aw", ["catalog", "dev", "status"])\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'commands', 'publish.md'),
      '```bash\naw catalog source list\n```\n',
    )

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({
        skills: './skills',
        slashCommands: './commands',
        scripts: {
          lifecycle: { install: './scripts/entry.mjs' },
          node: { build: { runner: 'node', path: './scripts/entry.mjs' } },
        },
        extensions: {
          hooks: [
            { event: 'before_tool', command: 'aw catalog source list' },
            { event: 'after_tool', command: 'node ./scripts/entry.mjs' },
            { event: 'session_start', command: 'aw "$GROUP" status' },
          ],
        },
      }),
    })

    expect(result.detected).toEqual([
      'aw.catalog-publication.v1',
      'aw.catalog-source.v2',
      'aw.self-check.v1',
    ])
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-detected',
        path: 'skills/one/SKILL.md',
        provenance: 'shell-fence',
        command: 'aw catalog publish',
        capability: 'aw.catalog-publication.v1',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        path: '.agents-plugin/plugin.json',
        provenance: 'manifest-executable',
        command: 'aw catalog source',
        capability: 'aw.catalog-source.v2',
      }),
      expect.objectContaining({
        code: 'aw-command-unmapped',
        path: 'skills/one/SKILL.md',
        command: 'aw future command',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-dynamic',
        path: 'skills/one/SKILL.md',
        command: 'aw "$GROUP" status',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-dynamic',
        path: '.agents-plugin/plugin.json',
        command: 'aw "$GROUP" status',
        blocking: false,
      }),
    ]))
    expect([...new Set(result.observations.map((entry) => entry.path))].sort()).toEqual([
      '.agents-plugin/plugin.json',
      'skills/one/SKILL.md',
    ])
    expect(result.observations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'aw plugin validate' }),
      expect.objectContaining({ capability: 'aw.catalog-authoring.v1' }),
      expect.objectContaining({ capability: 'aw.catalog-dev-source.v1' }),
    ]))
  })

  it('reports removed catalog status preflight shell commands as unmapped advisory observations', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-preflight-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'SKILL.md'),
      '```bash\naw catalog status --preflight --json\n```\n',
    )

    const result = await scanPluginAwCliRequirements({
      pluginRoot,
      manifest: manifest({ skills: './skills' }),
    })

    expect(result.detected).not.toContain('aw.catalog-authoring.v1')
    expect(result.observations).toEqual([
      expect.objectContaining({
        code: 'aw-command-unmapped',
        blocking: false,
        path: 'skills/one/SKILL.md',
        provenance: 'shell-fence',
        command: 'aw catalog status',
      }),
    ])
  })

  it('keeps detected observations out of effective compatibility truth and its digest', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-truth-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'SKILL.md'),
      '```bash\naw catalog publish apply --json\n```\n',
    )
    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: manifest({
        skills: './skills',
        requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
      }),
      implementedCapabilities: ['aw.plugin-manifest.v3', 'aw.plugin-skills.v1'],
    })

    expect(result.detected).toEqual(['aw.catalog-publication.v1'])
    expect(result.effective).toEqual([
      'aw.future-feature.v3',
      'aw.plugin-manifest.v3',
      'aw.plugin-skills.v1',
    ])
    expect(result.unsupportedByCurrentAw).toEqual(['aw.future-feature.v3'])
    expect(result.capabilitySetDigest).toBe(computeAwCapabilitySetDigest(result.effective))
    expect(result.capabilitySetDigest).not.toBe(computeAwCapabilitySetDigest([
      ...result.effective,
      ...result.detected,
    ]))
  })
})
