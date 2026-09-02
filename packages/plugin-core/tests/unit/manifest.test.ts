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

describe('plugin manifest v3 structure', () => {
  it('requires explicit v3 and accepts unknown valid capability IDs', () => {
    const explicit = manifest({
      schemaVersion: 3,
      requires: { aw: { capabilities: ['aw.future-feature.v3'] } },
    })
    expect(() => assertPluginManifestStructure(explicit)).not.toThrow()
    expect(normalizePluginManifestSchemaVersion(explicit)).toEqual(explicit)
    expect(() => assertPluginManifestStructure(manifest())).toThrow(/schemaVersion/u)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 2 })))
      .toThrow(/Unsupported plugin manifest schemaVersion/u)
  })

  it('rejects unknown versions and invalid structures', () => {
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 2 })))
      .toThrow(/Unsupported plugin manifest schemaVersion/u)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 3, unexpected: true })))
      .toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 3, marketplace: [] })))
      .toThrow(/Invalid plugin manifest structure/u)
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      requires: { aw: { capabilities: ['future-feature'] } },
    }))).toThrow(/capabilities/u)
  })

  it.each([
    ['array default', { fields: { value: { type: 'string', writableLayers: ['user'], default: [] } } }],
    ['null default', { fields: { value: { type: 'string', writableLayers: ['user'], default: null } } }],
    ['closed top-level scalar choices without presets', {
      fields: { value: { type: 'string', writableLayers: ['user'], choices: { allowCustom: false, presets: [] } } },
    }],
    ['closed fixed child choices without presets', {
      fields: {
        value: {
          type: 'object',
          writableLayers: ['user'],
          properties: { child: { type: 'string', choices: { allowCustom: false, presets: [] } } },
        },
      },
    }],
    ['closed dynamic child choices without presets', {
      fields: {
        value: {
          type: 'object',
          writableLayers: ['user'],
          additionalProperties: { type: 'number', choices: { allowCustom: false, presets: [] } },
        },
      },
    }],
    ['nested object', {
      fields: {
        value: {
          type: 'object',
          writableLayers: ['user'],
          properties: { nested: { type: 'object', additionalProperties: false } },
        },
      },
    }],
    ['missing object shape', { fields: { value: { type: 'object', writableLayers: ['user'] } } }],
    ['removed presentation fields', {
      fields: { value: { type: 'string', writableLayers: ['user'] } },
      presentation: { fields: {} },
    }],
  ])('rejects invalid Config v2 structure: %s', (_label, config) => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      config,
    }))).toThrow(PluginManifestStructureError)
  })

  it('accepts custom Config v2 choices without presets', () => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      config: {
        fields: {
          value: { type: 'string', writableLayers: ['user'], choices: { allowCustom: true, presets: [] } },
        },
      },
    }))).not.toThrow()
  })

  it('accepts file and directory string validation formats', () => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      config: {
        fields: {
          certificate: { type: 'string', writableLayers: ['user'], validation: { format: 'file' } },
          workspace: { type: 'string', writableLayers: ['user', 'project'], validation: { format: 'directory' } },
          locations: {
            type: 'object',
            writableLayers: ['user', 'project'],
            properties: {
              certificate: { type: 'string', validation: { format: 'file' } },
            },
            additionalProperties: { type: 'string', validation: { format: 'directory' } },
          },
        },
      },
    }))).not.toThrow()
  })

  it('requires valid top-level writable layers without adding them to object children', () => {
    const configField = (writableLayers: unknown) => manifest({
      schemaVersion: 3,
      config: { fields: { value: { type: 'string', writableLayers } } },
    })
    expect(() => assertPluginManifestStructure(configField(undefined))).toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(configField([]))).toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(configField(['user', 'user']))).toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(configField(['machine']))).toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      config: {
        fields: {
          value: {
            type: 'object',
            writableLayers: ['user', 'project'],
            properties: { child: { type: 'string' } },
          },
        },
      },
    }))).not.toThrow()
  })

  it('enforces codex.skill delivery and native refresh key layers', () => {
    const target = {
      id: 'dynamic', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      states: ['present'], refreshKeys: ['userOnly'], skillKey: 'dynamic',
    }
    const config = {
      fields: {
        userOnly: { type: 'string', writableLayers: ['user'] },
        shared: { type: 'string', writableLayers: ['user', 'project'] },
      },
    }
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3, config, artifacts: { targets: [target] },
    }))).toThrow(/delivery/u)
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3, config,
      artifacts: { targets: [{ ...target, delivery: { mode: 'aw-extension' } }] },
    }))).not.toThrow()
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3, config,
      artifacts: { targets: [{ ...target, delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } }] },
    }))).not.toThrow()
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3, config,
      artifacts: { targets: [{
        ...target,
        refreshKeys: ['shared'],
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
      }] },
    }))).toThrow(/writableLayers \["user"\]/u)
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3, config,
      artifacts: { targets: [{
        ...target,
        target: 'claude.skill',
        platform: 'claude',
        delivery: { mode: 'aw-extension' },
      }] },
    }))).toThrow(/additional properties/u)
  })

  it('fails closed for reserved imports and accepts only injected exports', () => {
    const withImport = (exportName: string) => manifest({
      schemaVersion: 3,
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
      schemaVersion: 3,
      ...override,
    }))).toThrow(/source paths must not enter (?:\.git|node_modules)/u)
  })
})
