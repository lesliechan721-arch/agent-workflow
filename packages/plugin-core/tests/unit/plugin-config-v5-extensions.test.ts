import { describe, expect, it } from 'vitest'

import {
  assertPluginConfigReferenceSchemas,
  assertPluginConfigSuggestionProviders,
  assertPluginManifestStructure,
  createBundleSourceManifest,
  createRuntimeConfigSnapshot,
  deriveAwCapabilitiesFromManifest,
  getPluginConfigSuggestions,
  normalizePluginConfigDefinition,
  selectPluginConfigProfile,
  validatePluginManifest,
} from '../../src/manifest.js'

const pluginRoot = '/tmp/config-v5-extensions'
const manifest = (name: string, config: unknown, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 4, name, version: '1.0.0', description: 'Config v5 fixture',
  marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  config, ...extra,
})
const view = (raw: unknown) => ({
  rootDir: pluginRoot, manifestPath: `${pluginRoot}/.agents-plugin/plugin.json`, manifest: validatePluginManifest(pluginRoot, raw),
})
const ref = (name: string) => ({ $ref: `#/config/definitions/${name}` })
const scalar = { type: 'string' }
const fixed = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'object', properties, additionalProperties: false, ...extra,
})
const config = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ schemaVersion: 5, fields, ...extra })
const composite = { provider: 'profiles', title: 'Choose a profile', description: 'Choose model and effort',
  hint: 'fast', dependsOn: ['executor'], targets: ['model', 'effort'] }
const scripts = { config: { suggestions: { runner: 'node', path: './suggestions.mjs', timeoutMs: 1000 } } }
const capabilities = [
  'aw.plugin-config-suggestions.v2', 'aw.plugin-config-platform-only.v1',
  'aw.plugin-config-clears-on-change.v1', 'aw.plugin-config-ref-override.v1',
]

describe('Config v5 structural extensions', () => {
  // A consumer with no common fields and no explicit platform overrides must still derive and validate every capability.
  it('retains the full authored baseline for derivation, static references, and bundle serialization', () => {
    const provider = view(manifest('provider', config({ registry: { type: 'array', platformOnly: true,
      items: fixed({ id: scalar }), validation: { uniqueBy: 'id' } } }), { scripts }))
    const declaration = { ...composite, plugin: 'provider' }
    const source = config({
      profile: { ...ref('profile'), platformOnly: true, suggestions: { ...declaration, hint: 'balanced' } },
      profiles: { type: 'array', platformOnly: true, items: ref('profile') },
    }, {
      definitions: {
        executor: { ...scalar, valueRef: { plugin: 'provider', field: 'registry', key: 'id', include: ['native'] },
          clearsOnChange: ['model', 'effort'] },
        profile: fixed({ executor: ref('executor'), model: scalar, effort: scalar }, { suggestions: declaration }),
      },
      presentation: { groups: [{ id: 'profiles', title: 'Profiles', fields: ['profile', 'profiles'] }],
        summaries: { compact: { kind: 'join', parts: [{ path: '/model' }], separator: '/', missing: 'default' } },
        fieldViews: { profile: { summary: 'compact' }, profiles: { itemSummary: 'compact' } } },
    })
    const consumer = view(manifest('consumer', source, { dependencies: ['provider'] }))
    const normalized = consumer.manifest.config!
    expect(deriveAwCapabilitiesFromManifest(consumer.manifest)).toEqual(expect.arrayContaining([
      ...capabilities, 'aw.plugin-config-array.v1', 'aw.plugin-config-value-ref.v1',
      'aw.plugin-config-cross-plugin-value-ref.v1', 'aw.plugin-config-summary.v1',
    ]))
    expect(deriveAwCapabilitiesFromManifest(consumer.manifest)
      .filter((id) => id.startsWith('aw.plugin-config-suggestions.'))).toEqual(['aw.plugin-config-suggestions.v2'])
    expect(deriveAwCapabilitiesFromManifest(validatePluginManifest(pluginRoot, consumer.manifest))).toContain('aw.plugin-config-ref-override.v1')
    expect(Object.keys(normalized.fields)).toEqual(['profile', 'profiles'])
    expect(selectPluginConfigProfile(normalized).fields).toEqual({})
    expect(selectPluginConfigProfile(normalized).presentation).toMatchObject({ groups: [], fieldViews: {} })
    expect(selectPluginConfigProfile(normalized, 'pi').fields).toEqual(normalized.fields)
    expect(selectPluginConfigProfile(normalized, 'pi').presentation?.groups).toHaveLength(1)
    expect(() => assertPluginConfigReferenceSchemas(normalized, { plugin: 'consumer', dependencies: ['provider'],
      plugins: { provider: { definition: provider.manifest.config!, dependencies: [] } } }, source)).not.toThrow()
    const badProvider = normalizePluginConfigDefinition(config({ registry: scalar }))
    expect(() => assertPluginConfigReferenceSchemas(normalized, { plugin: 'consumer', dependencies: ['provider'],
      plugins: { provider: { definition: badProvider, dependencies: [] } } }, source)).toThrow(/valueRefSchema/u)
    expect(getPluginConfigSuggestions(normalized)).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...declaration, hint: 'balanced' }), declaration,
    ]))
    expect(() => assertPluginConfigSuggestionProviders(consumer.manifest, [consumer, provider])).not.toThrow()
    expect(() => assertPluginConfigSuggestionProviders(consumer.manifest, [consumer])).toThrow(/same-source dependency/u)

    const derived = deriveAwCapabilitiesFromManifest(consumer.manifest)
    const bundle = JSON.parse(JSON.stringify(createBundleSourceManifest(consumer, derived)))
    expect(Object.keys(bundle.config).sort()).toEqual(['fields', 'presentation', 'schemaVersion'])
    expect(bundle.config.fields.profile).toMatchObject({ platformOnly: true, suggestions: { hint: 'balanced', targets: ['model', 'effort'] },
      properties: { executor: { clearsOnChange: ['model', 'effort'] } } })
    expect(bundle.requires.aw.capabilities).toEqual(derived)
    expect(() => assertPluginManifestStructure(bundle)).not.toThrow()
    expect(deriveAwCapabilitiesFromManifest(validatePluginManifest(pluginRoot, bundle))).not.toContain('aw.plugin-config-ref-override.v1')
  })

  it('filters only the common field view and rejects nested placements or a platform weakening', () => {
    const normalized = normalizePluginConfigDefinition(config({ shared: scalar, platform: { ...scalar, platformOnly: true },
      optional: { ...scalar, platformOnly: false } }, {
      presentation: { groups: [{ id: 'main', title: 'Main', fields: ['shared', 'platform'] }] },
      platforms: { codex: { fields: { platform: { ...scalar, platformOnly: true, default: 'codex' } } } },
    }))
    expect(Object.keys(selectPluginConfigProfile(normalized).fields)).toEqual(['shared', 'optional'])
    expect(selectPluginConfigProfile(normalized).presentation?.groups?.[0]?.fields).toEqual(['shared'])
    expect(selectPluginConfigProfile(normalized, 'codex').fields.platform?.default).toBe('codex')
    expect(selectPluginConfigProfile(normalized, 'cursor').fields.platform).toMatchObject({ platformOnly: true })
    for (const nested of [fixed({ child: { ...scalar, platformOnly: true } }),
      { type: 'object', additionalProperties: { ...scalar, platformOnly: true } },
      { type: 'array', items: { ...scalar, platformOnly: false } }]) {
      expect(() => normalizePluginConfigDefinition(config({ nested }))).toThrow(/platformOnly/u)
    }
    for (const replacement of [scalar, { ...scalar, platformOnly: false }]) {
      expect(() => normalizePluginConfigDefinition(config({ platform: { ...scalar, platformOnly: true } }, {
        platforms: { codex: { fields: { platform: replacement } } },
      }))).toThrow(/platformOnly/u)
    }
  })

  it('accepts an already selected v5 profile for runtime snapshots without reinterpreting its v5 fields as author-time v4', () => {
    const definition = selectPluginConfigProfile(normalizePluginConfigDefinition(config({ shared: scalar,
      platformSpecific: { ...scalar, platformOnly: true },
    })), 'codex')
    const snapshot = createRuntimeConfigSnapshot({ definition, declaration: { keys: ['shared'] },
      values: { shared: 'shared-value', platformSpecific: 'platform-value' }, installedIdentity: {
        sourceId: 'example', sourceIdentity: 'identity', pluginId: 'example/consumer', pluginName: 'consumer', pluginVersion: '1.0.0',
        platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'skill', skillKey: 'skill',
      } })
    expect(snapshot.allowedKeys).toEqual(['shared'])
    expect(snapshot.effectiveValues).toEqual({ shared: 'shared-value' })
  })

  it('permits only new v5 ref overrides and derives their source-only capability independently', () => {
    const source = config({ value: ref('alias') }, { definitions: { base: scalar,
      alias: { ...ref('base'), platformOnly: false } } })
    const normalized = view(manifest('consumer', source))
    expect(deriveAwCapabilitiesFromManifest(normalized.manifest)).toContain('aw.plugin-config-ref-override.v1')
    expect(deriveAwCapabilitiesFromManifest(normalized.manifest)).not.toContain('aw.plugin-config-platform-only.v1')
    for (const schemaVersion of [3, 4]) {
      for (const override of [{ platformOnly: true }, { suggestions: { provider: 'models' } }]) {
        expect(() => normalizePluginConfigDefinition({ schemaVersion, definitions: { base: scalar },
          fields: { value: { ...ref('base'), ...override } } })).toThrow()
      }
    }
    expect(() => normalizePluginConfigDefinition(config({ value: { ...ref('base'), choices: { allowCustom: true, presets: [] } } },
      { definitions: { base: scalar } }))).toThrow(/choices/u)
    expect(() => normalizePluginConfigDefinition(config({ value: fixed({ child: { ...ref('base'), platformOnly: true } }) },
      { definitions: { base: scalar } }))).toThrow(/platformOnly/u)
  })

  it('validates all object suggestion declarations, including variants and enclosing placement', () => {
    const object = fixed({ executor: scalar, model: { ...scalar, suggestions: { provider: 'models', hint: 'fast' } } }, {
      variants: { discriminator: 'executor', cases: { one: { properties: { effort: scalar } } }, otherwise: { properties: { effort: scalar } } },
      suggestions: composite,
    })
    expect(normalizePluginConfigDefinition(config({ profile: object, profiles: { type: 'array', items: object } })).fields.profile)
      .toMatchObject({ suggestions: composite, properties: { model: { suggestions: { hint: 'fast' } } } })
    const badDeclarations = [
      { targets: [] }, { targets: ['model', 'model'] }, { targets: ['executor'] }, { targets: ['absent'] },
      { dependsOn: ['model'] }, { dependsOn: ['missing'] }, { hint: 'Invalid' },
      { title: '🚀'.repeat(65) }, { description: '🚀'.repeat(257) },
    ]
    for (const bad of badDeclarations) {
      expect(() => normalizePluginConfigDefinition(config({ profile: { ...object, suggestions: { ...composite, ...bad } } }))).toThrow(/suggestions/u)
    }
    for (const target of [
      { ...scalar, const: 'fixed' }, { ...scalar, valueRef: { field: 'registry', key: 'id' } },
      { ...scalar, sensitive: true }, { ...scalar, choices: { allowCustom: false, presets: [{ id: 'fixed', title: 'Fixed', value: 'fixed' }] } },
      { type: 'array', items: scalar }, { type: 'object', additionalProperties: scalar },
    ]) {
      const invalid = { ...object, variants: { ...object.variants, otherwise: { properties: { effort: target } } } }
      expect(() => normalizePluginConfigDefinition(config({ profile: invalid }))).toThrow()
    }
    for (const profile of [
      { ...object, additionalProperties: undefined },
      { ...fixed({}, { suggestions: composite }) },
      { type: 'object', additionalProperties: scalar, suggestions: composite },
      { ...object, choices: { allowCustom: false, presets: [{ id: 'one', title: 'One', value: {} }] } },
      fixed({ nested: { type: 'array', items: fixed({ model: scalar }, { suggestions: { provider: 'models', targets: ['model'] } }) } }),
    ]) expect(() => normalizePluginConfigDefinition(config({ profile }))).toThrow()

    const cross = fixed({ model: scalar }, { suggestions: { provider: 'models', plugin: 'provider', targets: ['model'] } })
    expect(() => view(manifest('consumer', config({ profiles: { type: 'array', items: cross } })))).toThrow(/explicit direct dependency/u)
    expect(() => view(manifest('consumer', config({ profile: object })))).toThrow(/scripts.config.suggestions/u)
  })

  it('checks clearsOnChange after reusable properties and variant branches expand, including unused definitions', () => {
    const source = config({ profile: fixed({ executor: ref('executor'), model: scalar }, {
      variants: { discriminator: 'executor', cases: { native: { properties: { effort: scalar } } } },
    }) }, { definitions: { executor: { ...scalar, clearsOnChange: ['model', 'effort'] } } })
    expect(normalizePluginConfigDefinition(source).fields.profile).toMatchObject({ properties: {
      executor: { clearsOnChange: ['model', 'effort'] },
    } })
    for (const clearsOnChange of [[], ['model', 'model'], ['executor'], ['missing']]) {
      expect(() => normalizePluginConfigDefinition({ ...source, definitions: { executor: { ...scalar, clearsOnChange } } })).toThrow(/clearsOnChange/u)
    }
    expect(() => normalizePluginConfigDefinition(config({ scalar: ref('executor') }, { definitions: source.definitions }))).toThrow(/clearsOnChange/u)
    expect(() => normalizePluginConfigDefinition(config({ scalar: { ...scalar, clearsOnChange: ['model'] } }))).toThrow(/clearsOnChange/u)
    expect(() => normalizePluginConfigDefinition(config({ profile: fixed({ model: { ...scalar, clearsOnChange: ['executor'] }, executor: scalar }, {
      variants: { discriminator: 'executor', cases: { native: { properties: {} } } },
    }) }))).toThrow(/clearsOnChange/u)
    expect(() => normalizePluginConfigDefinition(config({ profile: fixed({ executor: { ...scalar, clearsOnChange: ['model'] },
      model: { ...scalar, const: 'fixed' } }) }))).toThrow(/clearsOnChange/u)
    const unused = view(manifest('consumer', config({}, { platforms: { pi: { definitions: { executor: { ...scalar, clearsOnChange: ['model'] } } } } })))
    expect(deriveAwCapabilitiesFromManifest(unused.manifest)).toContain('aw.plugin-config-clears-on-change.v1')
    const sensitiveUnused = view(manifest('consumer', config({}, { definitions: { unused: { ...scalar, sensitive: true, clearsOnChange: ['model'] } } })))
    expect(deriveAwCapabilitiesFromManifest(sensitiveUnused.manifest)).toContain('aw.plugin-config-clears-on-change.v1')
    const misleading = view(manifest('consumer', config({ profile: { type: 'object', additionalProperties: scalar,
      default: { clearsOnChange: 'data', suggestions: 'data' } } })))
    expect(deriveAwCapabilitiesFromManifest(misleading.manifest)).not.toContain('aw.plugin-config-clears-on-change.v1')
  })
})
