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

  it('enforces codex.skill delivery', () => {
    const target = {
      id: 'dynamic', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      states: ['present'], refreshKeys: ['userOnly'], skillKey: 'dynamic',
    }
    const config = {
      fields: {
        userOnly: { type: 'string' },
        shared: { type: 'string' },
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
        target: 'claude.skill',
        platform: 'claude',
        delivery: { mode: 'aw-extension' },
      }] },
    }))).toThrow(/additional properties/u)
  })

  it('requires artifact IDs to be unique only within overlapping surface scopes', () => {
    const codexInstruction = {
      id: 'shared-id', platform: 'codex', scopes: ['user'],
      target: 'codex.developerInstructionsBlock', states: ['present'], refreshKeys: [],
    }
    const codexRole = {
      id: 'shared-id', platform: 'codex', scopes: ['user'],
      target: 'codex.agentRole', states: ['present'], refreshKeys: [], roleKey: 'shared-role',
    }
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: {
        category: 'workflow', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
      artifacts: { targets: [codexInstruction, codexRole] },
    }))).toThrow(/duplicate artifact id "shared-id" for surface\/scope "codex:user"/u)

    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: {
        category: 'workflow', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX', 'CLAUDE'] },
      },
      artifacts: { targets: [
        codexInstruction,
        {
          id: 'shared-id', platform: 'claude', scopes: ['user'],
          target: 'claude.skill', states: ['present'], refreshKeys: [], skillKey: 'shared-skill',
        },
      ] },
    }))).not.toThrow()
  })

  it('requires codex-native IDs and Skill keys to be globally unique across scopes', () => {
    const nativeTarget = {
      id: 'native-id', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
      states: ['present'], refreshKeys: [], skillKey: 'native-skill',
    }
    const nativeManifest = (
      second: Record<string, unknown>,
      secondScopes: string[] = ['project'],
    ) => manifest({
      schemaVersion: 3,
      marketplace: {
        category: 'workflow', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
      artifacts: { targets: [nativeTarget, { ...nativeTarget, scopes: secondScopes, ...second }] },
    })
    expect(() => validatePluginManifest('/tmp/plugin', nativeManifest({ skillKey: 'other-skill' })))
      .toThrow(/duplicate codex-native artifact id "native-id" in the shared projection/u)
    expect(() => validatePluginManifest('/tmp/plugin', nativeManifest({ id: 'other-id' })))
      .toThrow(/duplicate codex-native skillKey "native-skill" in the shared projection/u)
    expect(() => validatePluginManifest('/tmp/plugin', nativeManifest({
      id: 'other-id', skillKey: 'other-skill',
    }, ['user']))).not.toThrow()
  })

  it.each([
    ['codex-native', {
      id: 'native-id', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
      states: ['present'], refreshKeys: ['secret'], skillKey: 'native-skill',
    }, 'codexNativeRenderSensitiveRefreshKey'],
    ['Codex AW extension', {
      id: 'codex-skill', platform: 'codex', scopes: ['user'], target: 'codex.skill',
      delivery: { mode: 'aw-extension' }, states: ['present'], refreshKeys: ['secret'],
      skillKey: 'codex-skill',
    }, 'skillRenderSensitiveRefreshKey'],
    ['Claude', {
      id: 'claude-skill', platform: 'claude', scopes: ['user'], target: 'claude.skill',
      states: ['present'], refreshKeys: ['secret'], skillKey: 'claude-skill',
    }, 'skillRenderSensitiveRefreshKey'],
    ['portable', {
      id: 'portable-skill', distribution: 'agent-skills', scopes: ['user'],
      target: 'agent-skills.skill', states: ['present'], refreshKeys: ['secret'],
      skillKey: 'portable-skill',
    }, 'skillRenderSensitiveRefreshKey'],
  ] as const)('rejects sensitive refresh keys for %s Skill targets', (_label, target, errorCode) => {
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: {
        category: 'workflow', strict: true,
        policy: {
          installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX', 'CLAUDE'],
        },
      },
      distributions: { agentSkills: { skills: './portable' } },
      config: { fields: { secret: { type: 'string', sensitive: true } } },
      artifacts: { targets: [target] },
    }))).toThrow(new RegExp(`^${errorCode}:`, 'u'))
  })

  it('allows a non-Skill target to refresh from sensitive config', () => {
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: {
        category: 'workflow', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
      },
      config: { fields: { secret: { type: 'string', sensitive: true } } },
      artifacts: { targets: [{
        id: 'role-id', platform: 'codex', scopes: ['user'], target: 'codex.agentRole',
        states: ['present'], refreshKeys: ['secret'], roleKey: 'sensitive-role',
      }] },
    }))).not.toThrow()
  })

  it('requires all shared Codex native components to declare the same scope set', () => {
    const nativeTarget = (id: string, scopes: string[]) => ({
      id, platform: 'codex', scopes, target: 'codex.skill',
      delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
      states: ['present'], refreshKeys: [], skillKey: `${id}-skill`,
    })
    const codexMarketplace = {
      category: 'workflow', strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL', products: ['CODEX'] },
    }
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: codexMarketplace,
      artifacts: { targets: [
        nativeTarget('first', ['user']),
        nativeTarget('second', ['project']),
      ] },
    }))).toThrow(/^codexSharedNativeScopeMismatch:/u)
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: codexMarketplace,
      skills: './skills',
      artifacts: { targets: [nativeTarget('first', ['user'])] },
    }))).toThrow(/^codexSharedNativeScopeMismatch:/u)

    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: codexMarketplace,
      artifacts: { targets: [
        nativeTarget('first', ['user']),
        nativeTarget('second', ['user']),
      ] },
    }))).not.toThrow()
    expect(() => validatePluginManifest('/tmp/plugin', manifest({
      schemaVersion: 3,
      marketplace: codexMarketplace,
      skills: './skills',
      artifacts: { targets: [nativeTarget('first', ['user', 'project'])] },
    }))).not.toThrow()
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
