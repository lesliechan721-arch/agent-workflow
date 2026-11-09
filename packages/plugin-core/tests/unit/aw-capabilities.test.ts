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
    expect(registry).toContain('aw.review-preparation.v2')
    expect(registry).toContain('aw.review-inspection.v3')
    expect(registry).toContain('aw.plugin-recovery.v2')
    expect(registry).not.toContain('aw.project-recovery.v1')
    expect(registry).not.toContain('aw.review-publication.v1')
    expect(registry).not.toContain('aw.review-inspection.v1')
    expect(registry).not.toContain('aw.catalog-context.v1')
    expect(registry).toContain('aw.installed-runtime-config.v2')
    expect(registry).not.toContain('aw.installed-runtime-config.v1')
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
      scripts: { preApply: { path: './scripts/pre-apply.mjs' } },
      artifacts: { targets: [{ id: 'dynamic', scopes: ['user'], target: 'codex.skill', platform: 'codex', states: ['present'], refreshKeys: [] }] },
    }))).toEqual([
      'aw.dynamic-artifacts.v2',
      'aw.plugin-build-config.v1',
      'aw.plugin-config.v2',
      'aw.plugin-manifest.v3',
      'aw.plugin-pre-apply.v1',
      'aw.plugin-skills.v1',
      'aw.portable-skills.v1',
      'aw.runtime-imports.v1',
    ])
  })

  // Test Value Gate: a v2 runtime consumer requires a CLI with the new reader contract.
  it('derives v2 installed runtime capability and rejects v1-only support', () => {
    const capabilities = deriveAwCapabilitiesFromManifest(manifest({
      config: { fields: { displayStyle: { type: 'string' } } },
      artifacts: { targets: [{ id: 'tool', scopes: ['user'], platform: 'codex', target: 'codex.skill',
        skillKey: 'tool', states: ['present'], refreshKeys: ['displayStyle'],
        runtimeConfig: { keys: ['displayStyle'] },
      }] },
    }))
    expect(capabilities).toContain('aw.installed-runtime-config.v2')
    expect(capabilities).not.toContain('aw.installed-runtime-config.v1')
    expect(checkAwCapabilitySupport(capabilities, capabilities.filter((capability) => capability !== 'aw.installed-runtime-config.v2')
      .concat(['aw.installed-runtime-config.v1']))).toEqual({ supported: false, missing: ['aw.installed-runtime-config.v2'] })
  })

  it('scans only shell fences in actual Skill mains and static Manifest executables', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-core-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), [
      'Run `aw dev source status` when needed.',
      'aw dev plugin validate . --json',
      '```text',
      'aw dev catalog build',
      '```',
      '```bash',
      'aw dev catalog publish plan --json',
      'aw dev review inspect . --json',
      'aw dev review prepare . --platform codex --scope user --out ./prepared --json',
      ...['digest', 'publish', 'verify', 'list', 'show'].map((command) => `aw dev review ${command}`),
      'aw self check --json && aw future command',
      'aw "$GROUP" status',
      '```',
      '',
    ].join('\n'))
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'references', 'SKILL.md'),
      '```bash\naw source status\n```\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'references', 'commands.md'),
      '```bash\naw source status\n```\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'scripts', 'run.sh'),
      'aw source status\n',
    )
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'README.md'),
      '```bash\naw source status\n```\n',
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
      '```bash\naw source status\n```\n',
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
            { event: 'before_tool', command: 'aw source status' },
            { event: 'after_tool', command: 'node ./scripts/entry.mjs' },
            { event: 'session_start', command: 'aw "$GROUP" status' },
          ],
        },
      }),
    })

    expect(result.detected).toEqual([
      'aw.catalog-publication.v2',
      'aw.catalog-source.v3',
      'aw.cli-output.v1',
      'aw.review-inspection.v3',
      'aw.review-preparation.v2',
      'aw.self-check.v2',
    ])
    for (const command of ['digest', 'publish', 'verify', 'list', 'show']) {
      expect(result.observations).toContainEqual(expect.objectContaining({
        code: 'aw-command-unmapped',
        command: `aw dev review ${command}`,
        blocking: false,
      }))
    }
    expect(result.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'aw-command-detected',
        path: 'skills/one/SKILL.md',
        provenance: 'shell-fence',
        command: 'aw dev review inspect',
        capability: 'aw.review-inspection.v3',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        path: 'skills/one/SKILL.md',
        provenance: 'shell-fence',
        command: 'aw dev review prepare',
        capability: 'aw.review-preparation.v2',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        path: 'skills/one/SKILL.md',
        provenance: 'shell-fence',
        command: 'aw dev catalog publish',
        capability: 'aw.catalog-publication.v2',
        blocking: false,
      }),
      expect.objectContaining({
        code: 'aw-command-detected',
        path: '.agents-plugin/plugin.json',
        provenance: 'manifest-executable',
        command: 'aw source status',
        capability: 'aw.catalog-source.v3',
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
      expect.objectContaining({ command: 'aw dev plugin validate' }),
      expect.objectContaining({ capability: 'aw.catalog-authoring.v2' }),
      expect.objectContaining({ capability: 'aw.catalog-dev-source.v2' }),
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

    expect(result.detected).not.toContain('aw.catalog-authoring.v2')
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

  it('maps new command routes and leaves removed routes unmapped', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-routes-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), [
      '```bash',
      'aw dev plugin create demo',
      'aw dev skill export demo --platform cursor --scope project --out out',
      'aw dev eval check',
      'aw dev source status',
      'aw plugin install official/demo --scope user',
      'aw target list',
      'aw source status',
      'aw cache status',
      'aw plugin config get official/demo',
      'aw command run official/demo tool -- --json',
      'aw plugin build demo',
      'aw catalog source sync',
      'aw review prepare demo',
      'aw skill eval prepare demo one',
      '```',
    ].join('\n'))
    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest({ skills: './skills' }) })
    expect(result.detected).toEqual([
      'aw.catalog-dev-source.v2', 'aw.catalog-source.v3', 'aw.cli-output.v1',
      'aw.managed-commands.v1', 'aw.plugin-authoring.v2', 'aw.plugin-config.v2',
      'aw.plugin-recovery.v2', 'aw.skill-eval.v3',
    ])
    expect(result.observations.filter((entry) => entry.code === 'aw-command-unmapped')
      .map((entry) => entry.command).sort()).toEqual([
      'aw catalog source', 'aw plugin build', 'aw review prepare', 'aw skill eval',
    ])
  })

  // Test Value Gate: supported command routes require both execution and output capabilities; unknown routes must remain unmapped.
  it.each([
    ['aw command update example --from ./tool --json --yes', true],
    ['aw command package sync example tools --scope user --json --yes', true],
    ['aw command package remove example tools --scope user --json --yes', true],
    ['aw command sync example --json', false],
    ['aw command package update example --json', false],
  ] as const)('maps managed command capability support for %s', async (command, supported) => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-command-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(path.join(pluginRoot, 'skills', 'one', 'SKILL.md'), `\`\`\`sh\n${command}\n\`\`\`\n`)
    const result = await scanPluginAwCliRequirements({ pluginRoot, manifest: manifest({ skills: './skills' }) })
    expect(result.detected).toEqual(supported ? ['aw.cli-output.v1', 'aw.managed-commands.v1'] : [])
    expect(result.observations.map((entry) => entry.code)).toEqual(supported
      ? ['aw-command-detected', 'aw-command-detected'] : ['aw-command-unmapped'])
  })

  it('keeps detected observations out of effective compatibility truth and its digest', async () => {
    const pluginRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-requirements-truth-'))
    tempDirs.push(pluginRoot)
    await fs.outputFile(
      path.join(pluginRoot, 'skills', 'one', 'SKILL.md'),
      '```bash\naw dev catalog publish apply --json\n```\n',
    )
    const result = await resolvePluginRequirements({
      pluginRoot,
      manifest: manifest({
        platforms: ['codex', 'claude'],
        skills: './skills',
        requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
      }),
      implementedCapabilities: ['aw.plugin-manifest.v3', 'aw.plugin-skills.v1'],
    })

    expect(result.detected).toEqual(['aw.catalog-publication.v2', 'aw.cli-output.v1'])
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
