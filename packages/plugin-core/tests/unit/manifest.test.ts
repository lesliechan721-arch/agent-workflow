import { describe, expect, it } from 'vitest'

import {
  assertPluginManifestStructure,
  normalizePluginManifestSchemaVersion,
  PluginManifestStructureError,
  validatePluginManifest,
} from '../../src/manifest.js'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'example-plugin',
    version: '0.1.0',
    description: 'Example plugin.',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
    ...overrides,
  }
}

describe('plugin manifest v2 structure', () => {
  it('requires explicit v2 and accepts unknown valid capability IDs', () => {
    const explicit = manifest({
      schemaVersion: 2,
      requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
    })
    expect(() => assertPluginManifestStructure(explicit)).not.toThrow()
    expect(normalizePluginManifestSchemaVersion(explicit)).toEqual(explicit)
    expect(() => assertPluginManifestStructure(manifest())).toThrow(/schemaVersion/u)
  })

  it('rejects unknown versions and invalid structures', () => {
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 1 })))
      .toThrow(/Unsupported plugin manifest schemaVersion/u)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 2, unexpected: true })))
      .toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 2, marketplace: [] })))
      .toThrow(/Invalid plugin manifest structure/u)
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 2,
      requires: { aw: { capabilities: ['future-feature'] } },
    }))).toThrow(/capabilities/u)
  })

  it('fails closed for reserved imports and accepts only injected exports', () => {
    const withImport = (exportName: string) => manifest({
      schemaVersion: 2,
      buildConfig: {
        buildImports: [{
          plugin: '@host/runtime',
          export: exportName,
          env: 'AW_PLUGIN_IMPORT_REGISTRY',
        }],
      },
    })

    expect(() => validatePluginManifest('/tmp/plugin', withImport('registry')))
      .toThrow(/unknown reserved provider "@host\/runtime"/u)
    expect(() => validatePluginManifest('/tmp/plugin', withImport('unknown'), {
      reservedImports: { '@host/runtime': ['registry'] },
    })).toThrow(/unknown reserved export "unknown"/u)
    expect(validatePluginManifest('/tmp/plugin', withImport('registry'), {
      reservedImports: { '@host/runtime': ['registry'] },
    }).buildConfig?.buildImports).toEqual([{
      plugin: '@host/runtime',
      export: 'registry',
      env: 'AW_PLUGIN_IMPORT_REGISTRY',
    }])
  })

  it.each([
    ['MCP file', { mcpServers: './nested/.git/mcp.json' }],
    ['App file', {
      apps: './nested/node_modules/app.json',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
    }],
    ['portable Skill collection', {
      mcpServers: './mcp.json',
      distributions: { agentSkills: { skills: './portable/.git/skills' } },
    }],
    ['plugin script', {
      scripts: { node: { build: { runner: 'node', path: './tools/node_modules/build.mjs' } } },
    }],
    ['runtime export', {
      buildConfig: {
        runtimeExports: [{
          name: 'shared-runtime', source: './runtime/.git/shared.mjs',
          requires: { aw: { capabilities: [] } },
        }],
      },
    }],
  ])('rejects ignored source segments in a %s declaration', (_label, override) => {
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 2,
      ...override,
    }))).toThrow(/source paths must not enter (?:\.git|node_modules)/u)
  })
})
