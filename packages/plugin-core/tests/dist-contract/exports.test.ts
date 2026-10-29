import fs from 'node:fs/promises'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CATALOG_WORKSPACE_VERSION,
  getAwCapabilityRegistry,
  resolvePluginConfigObjectProperties,
  type PluginConfigObjectField,
} from '@lesliechan721/aw-plugin-core'
import {
  computeAwCapabilitySetDigest,
  assertPluginManifestStructure,
  normalizePluginConfigDefinition,
  validatePluginConfigValue,
  PLUGIN_CONFIG_V3_MAX_DEFINITIONS,
  PLUGIN_CONFIG_V3_MAX_FIELDS,
  PLUGIN_CONFIG_V3_MAX_REF_DEPTH,
  PLUGIN_CONFIG_ARRAY_MAX_ITEMS,
  PLUGIN_CONFIG_ARRAY_MAX_BYTES,
  getPluginAuthoringCapabilities,
  getPluginAuthoringCapabilitySurface,
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  getPluginCommandId,
  getManagedCommandArtifactTargets,
  validatePluginManifest,
} from '@lesliechan721/aw-plugin-core/manifest'

const require = createRequire(import.meta.url)

describe('public package exports', () => {
  it('ships managed command normalization, target projection and identity through the published package', () => {
    const manifest = validatePluginManifest('/plugin', {
      schemaVersion: 3, name: 'managed-tools', version: '1.0.0', description: 'Managed tools',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      managedCommands: { packages: [{ key: 'tools', scope: 'user', platforms: ['codex'], sourceDir: './tools' }], sets: [] },
    });
    expect(manifest.managedCommands?.packages[0]?.refreshKeys).toEqual([]);
    expect(getManagedCommandArtifactTargets(manifest)).toEqual([]);
    expect(getAwCapabilityRegistry()).toEqual(expect.arrayContaining(['aw.managed-commands.v1', 'aw.claude.sandbox-exclusions.v1']));
    expect(getPluginAuthoringCapabilitySurface('managed-commands').surface).toBe('managed-commands');
    expect(getPluginCommandId({ schemaVersion: 1, producer: {
      sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'example-plugin',
      kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null,
    }, set: 'tools', key: 'check', variant: 'default' })).toBe('cmdp_3b4519b3e3a1a54208a71b8229d433cb0b80c57e97260c8d2aab0e59c6adf28e');
  });
  it('ships the v4 schema, capability and shared branch resolver through public exports', () => {
    const config = { schemaVersion: 4, fields: { backend: { type: 'object', properties: {
      adapter: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
      env: { type: 'object', additionalProperties: { type: 'string' } },
    }, variants: { discriminator: 'adapter', cases: {
      builtin: { properties: { mode: { type: 'string', const: 'workspace' } } },
      custom: { properties: { command: { type: 'string', required: true } } },
    } } } } }
    const manifest = { schemaVersion: 3, name: 'v4-reader', version: '1.0.0', description: 'Public contract',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config }
    assertPluginManifestStructure(manifest)
    const compiled = normalizePluginConfigDefinition(config)
    const backend = compiled.fields.backend as PluginConfigObjectField
    expect(resolvePluginConfigObjectProperties(backend, { adapter: 'builtin' }).properties.mode).toMatchObject({ const: 'workspace' })
    expect(validatePluginConfigValue(backend, { adapter: 'builtin', args: [''], env: { PATH: '' } })).toEqual([])
    expect(validatePluginConfigValue(backend, { adapter: 'builtin', command: '/tmp/command' })).toMatchObject([{ code: 'additionalProperty' }])
    expect(() => assertPluginManifestStructure({ ...manifest, config: { ...config, schemaVersion: 3 } })).toThrow()
    expect(getAwCapabilityRegistry()).toContain('aw.plugin-config.v4')
    expect(getPluginAuthoringCapabilitySurface('config').entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'config.schemaVersion', acceptedValues: [3, 4] }),
    ]))
  })
  it('publishes the v3 reader, schema and budget constants through package exports', () => {
    const config = { schemaVersion: 3, definitions: { text: { type: 'string', validation: { minLength: 2 } } }, fields: { label: { $ref: '#/config/definitions/text', default: 'valid' } } };
    const manifest = { schemaVersion: 3, name: 'public-reader', version: '0.1.0', description: 'Public contract', marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config };
    expect(() => assertPluginManifestStructure(manifest)).not.toThrow();
    const compiled = normalizePluginConfigDefinition(config);
    expect(validatePluginConfigValue(compiled.fields.label!, 'x')).toMatchObject([{ code: 'minLength' }]);
    expect(compiled.schemaVersion).toBe(3);
    expect([PLUGIN_CONFIG_V3_MAX_DEFINITIONS, PLUGIN_CONFIG_V3_MAX_FIELDS, PLUGIN_CONFIG_V3_MAX_REF_DEPTH]).toEqual([64, 256, 8]);
    expect(getAwCapabilityRegistry()).toEqual(expect.arrayContaining(['aw.plugin-config.v3', 'aw.plugin-config-summary.v1']));
  });
  it('exposes the manifest runtime and published v3 schema subpaths', async () => {
    expect(DEFAULT_CATALOG_WORKSPACE_VERSION).toBe('0.1.0')
    expect(getAwCapabilityRegistry()).toContain('aw.self-check.v1')
    expect(computeAwCapabilitySetDigest(['aw.self-check.v1'])).toMatch(/^sha256:/u)
    expect(PLUGIN_MANIFEST_SCHEMA_VERSION).toBe(3)
    expect(getPluginAuthoringCapabilities().schemaVersion).toBe(1)
    expect(getPluginAuthoringCapabilitySurface('manifest').surface).toBe('manifest')
    const schemaPath = require.resolve(
      '@lesliechan721/aw-plugin-core/schemas/plugin-manifest-v3.json',
    )
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8'))
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'PluginManifestSourceV3',
    })
  })
  it('ships array validation, schema and capability through the public package', async () => {
    const config = { schemaVersion: 3, fields: { labels: {
      type: 'array', items: { type: 'string', validation: { minLength: 1 } },
      default: [], validation: { maxItems: 2, uniqueItems: true },
    } } }
    const manifest = { schemaVersion: 3, name: 'array-reader', version: '0.1.0', description: 'Array contract',
      marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config }
    expect(() => assertPluginManifestStructure(manifest)).not.toThrow()
    const compiled = normalizePluginConfigDefinition(config)
    expect(validatePluginConfigValue(compiled.fields.labels!, ['ok', ''])).toMatchObject([
      { code: 'minLength', path: { segments: ['value', 1] } },
    ])
    expect([PLUGIN_CONFIG_ARRAY_MAX_ITEMS, PLUGIN_CONFIG_ARRAY_MAX_BYTES]).toEqual([128, 262144])
    expect(getAwCapabilityRegistry()).toContain('aw.plugin-config-array.v1')
  })
})
