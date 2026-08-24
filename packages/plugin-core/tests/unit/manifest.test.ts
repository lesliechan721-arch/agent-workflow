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

describe('plugin manifest v1 structure', () => {
  it('accepts explicit v1 and canonicalizes a legacy manifest without mutating it', () => {
    const explicit = manifest({ schemaVersion: 1 })
    expect(() => assertPluginManifestStructure(explicit)).not.toThrow()

    const legacy = manifest()
    expect(normalizePluginManifestSchemaVersion(legacy)).toEqual({
      ...legacy,
      schemaVersion: 1,
    })
    expect(legacy).not.toHaveProperty('schemaVersion')
  })

  it('rejects unknown versions and invalid structures', () => {
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 2 })))
      .toThrow(/Unsupported plugin manifest schemaVersion/u)
    expect(() => assertPluginManifestStructure(manifest({ unexpected: true })))
      .toThrow(PluginManifestStructureError)
    expect(() => assertPluginManifestStructure(manifest({ marketplace: [] })))
      .toThrow(/Invalid plugin manifest structure/u)
  })

  it('fails closed for reserved imports and accepts only injected exports', () => {
    const withImport = (exportName: string) => manifest({
      schemaVersion: 1,
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
})
