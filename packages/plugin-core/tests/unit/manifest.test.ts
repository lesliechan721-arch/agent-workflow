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
    ['array default', { fields: { value: { type: 'string', default: [] } } }],
    ['null default', { fields: { value: { type: 'string', default: null } } }],
    ['closed top-level scalar choices without presets', {
      fields: { value: { type: 'string', choices: { allowCustom: false, presets: [] } } },
    }],
    ['closed fixed child choices without presets', {
      fields: {
        value: {
          type: 'object',
          properties: { child: { type: 'string', choices: { allowCustom: false, presets: [] } } },
        },
      },
    }],
    ['closed dynamic child choices without presets', {
      fields: {
        value: {
          type: 'object',
          additionalProperties: { type: 'number', choices: { allowCustom: false, presets: [] } },
        },
      },
    }],
    ['nested object', {
      fields: {
        value: {
          type: 'object',
          properties: { nested: { type: 'object', additionalProperties: false } },
        },
      },
    }],
    ['missing object shape', { fields: { value: { type: 'object' } } }],
    ['mixed fixed and key-value object', {
      fields: {
        value: {
          type: 'object',
          properties: { child: { type: 'string' } },
          additionalProperties: { type: 'string' },
        },
      },
    }],
    ['undefined top-level field', { fields: { value: undefined } }],
    ['undefined fixed property', {
      fields: {
        value: {
          type: 'object',
          properties: { child: undefined },
        },
      },
    }],
    ['undefined object default value', {
      fields: {
        value: {
          type: 'object',
          properties: {},
          default: { child: undefined },
        },
      },
    }],
    ['undefined object preset value', {
      fields: {
        value: {
          type: 'object',
          properties: {},
          choices: {
            allowCustom: false,
            presets: [{ id: 'managed', title: 'Managed', value: { child: undefined } }],
          },
        },
      },
    }],
    ['dangerous top-level key', {
      fields: Object.fromEntries([['constructor', { type: 'string' }]]),
    }],
    ['dangerous fixed property key', {
      fields: {
        value: {
          type: 'object',
          properties: Object.fromEntries([['prototype', { type: 'string' }]]),
        },
      },
    }],
    ['removed presentation fields', {
      fields: { value: { type: 'string' } },
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
          value: { type: 'string', choices: { allowCustom: true, presets: [] } },
        },
      },
    }))).not.toThrow()
  })

  it.each(['path', 'file', 'directory'])('rejects removed %s string validation format', (format) => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 3,
      config: { fields: { value: { type: 'string', validation: { format } } } },
    }))).toThrow(PluginManifestStructureError)
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
