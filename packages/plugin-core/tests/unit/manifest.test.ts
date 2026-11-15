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

describe('plugin manifest v4 structure', () => {
  it('requires explicit v4 and accepts unknown valid capability IDs', () => {
    const explicit = manifest({
      schemaVersion: 4,
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
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 4, unexpected: true })))
      .toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 4, marketplace: [] })))
      .toThrow(/Invalid plugin manifest structure/u)
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 4,
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
    ['sensitive string default', {
      fields: { value: { type: 'string', sensitive: true, default: 'secret' } },
    }],
    ['sensitive string choices', {
      fields: {
        value: {
          type: 'string',
          sensitive: true,
          choices: { allowCustom: true, presets: [] },
        },
      },
    }],
    ['sensitive number', { fields: { value: { type: 'number', sensitive: true } } }],
    ['sensitive boolean', { fields: { value: { type: 'boolean', sensitive: true } } }],
    ['sensitive object', {
      fields: { value: { type: 'object', sensitive: true, properties: {} } },
    }],
    ['sensitive fixed child', {
      fields: {
        value: { type: 'object', properties: { child: { type: 'string', sensitive: true } } },
      },
    }],
    ['sensitive dynamic child', {
      fields: {
        value: { type: 'object', additionalProperties: { type: 'string', sensitive: true } },
      },
    }],
    ['pattern without maxLength', {
      fields: { value: { type: 'string', validation: { pattern: 'value' } } },
    }],
    ['pattern longer than 512 code points', {
      fields: { value: { type: 'string', validation: { pattern: 'a'.repeat(513), maxLength: 4096 } } },
    }],
    ['maxLength above 4096', {
      fields: { value: { type: 'string', validation: { maxLength: 4097 } } },
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
      schemaVersion: 4,
      config,
    }))).toThrow(PluginManifestStructureError)
  })

  it('accepts custom Config v2 choices without presets', () => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 4,
      config: {
        fields: {
          value: { type: 'string', choices: { allowCustom: true, presets: [] } },
        },
      },
    }))).not.toThrow()
  })

  it.each(['path', 'file', 'directory'])('rejects removed %s string validation format', (format) => {
    expect(() => assertPluginManifestStructure(manifest({
      schemaVersion: 4,
      config: { fields: { value: { type: 'string', validation: { format } } } },
    }))).toThrow(PluginManifestStructureError)
  })

  it.each([
    { slashCommands: './commands' }, { apps: './.app.json' }, { artifacts: { targets: [] } },
    { buildConfig: { manifestOverrides: { claude: { outputStyles: './styles' } } } },
    { extensions: { agents: [{ name: 'role', description: 'Role', prompt: 'Read.', extra: true }] } },
    { extensions: { hooks: [{ id: 'guard', event: 'before_tool', feedback: 'block', command: 'node guard.mjs', agentOverrides: { codex: { id: 'other' } } }] } },
  ])('rejects deleted author fields and unknown overrides %#', (fields) => {
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 4, ...fields }))).toThrow(PluginManifestStructureError)
  })

  it('rejects Manifest v3 and accepts renderer-wide permissions for all ten platforms', () => {
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 3 }))).toThrow(/expected 4/u)
    const raw = manifest({ schemaVersion: 4, platforms: ['gemini', 'copilot', 'grok'], artifacts: { configKeys: ['token'], scopes: ['project'] },
      config: { schemaVersion: 5, fields: { token: { type: 'string', sensitive: true } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      extensions: { agents: [{ name: 'role', description: 'Role', prompt: 'Read.', model: 'chosen', tools: [], promptMode: 'replace', agentOverrides: { gemini: { model: 'other' }, copilot: null } }] },
    })
    expect(validatePluginManifest('/tmp/plugin', raw).artifacts).toEqual({ configKeys: ['token'], scopes: ['project'] })
    expect(() => validatePluginManifest('/tmp/plugin', { ...raw, scripts: undefined })).toThrow(/render/u)
  })

  it('fails closed for reserved imports and accepts only injected exports', () => {
    const withImport = (exportName: string) => manifest({
      schemaVersion: 4,
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
      schemaVersion: 4,
      ...override,
    }))).toThrow(/source paths must not enter (?:\.git|node_modules)/u)
  })
})
