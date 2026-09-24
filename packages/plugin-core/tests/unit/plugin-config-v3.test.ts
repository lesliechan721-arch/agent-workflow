import { describe, expect, it } from 'vitest'
import { assertPluginManifestStructure, createBundleSourceManifest, deriveAwCapabilitiesFromManifest, normalizePluginConfigDefinition, validatePluginManifest, validatePluginConfigValue, checkAwCapabilitySupport, PLUGIN_CONFIG_V3_MAX_REF_DEPTH } from '../../src/manifest.js'
const ref = (name: string) => ({ $ref: `#/config/definitions/${name}` })
const profile = { type: 'object', properties: {
  model: { type: 'string', required: true, validation: { minLength: 1 } },
  effort: { type: 'string', choices: { allowCustom: false, presets: [{ id: 'high', title: 'High', value: 'high' }] } },
}, additionalProperties: false }
function manifest(config: unknown) {
  return { schemaVersion: 3, name: 'config-example', version: '0.1.0', description: 'Example',
    marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config }
}
function config() {
  return { schemaVersion: 3, definitions: { profile }, fields: { profile: { ...ref('profile'), required: true, default: { model: 'local', effort: 'high' } } },
    presentation: { summaries: { concise: { kind: 'join', parts: [{ path: '/model' }, { path: '/effort', format: 'choiceTitle' }], separator: '/', missing: 'unset' } }, fieldViews: { profile: { summary: 'concise' } } } }
}
describe('Config Definition v3', () => {
  it('compiles source and bundle through the public reader, retaining requirements and full constraints', () => {
    const source = manifest(config())
    expect(() => assertPluginManifestStructure(source)).not.toThrow()
    const normalized = validatePluginManifest('/tmp/config-example', source)
    const bundle = createBundleSourceManifest({ rootDir: '/tmp/config-example', manifestPath: '/tmp/config-example/.agents-plugin/plugin.json', manifest: normalized })
    expect(JSON.stringify(bundle.config)).not.toContain('$ref')
    expect(JSON.stringify(bundle.config)).not.toContain('definitions')
    expect(bundle.config).toMatchObject({ schemaVersion: 3, presentation: config().presentation })
    expect(validatePluginManifest('/tmp/config-example', bundle).config).toEqual(normalized.config)
    expect(normalizePluginConfigDefinition(normalized.config)).toEqual(normalized.config)
    expect(validatePluginConfigValue(normalized.config!.fields.profile!, { model: 'local', effort: 'bogus' })).toMatchObject([{ code: 'choice' }])
    expect(deriveAwCapabilitiesFromManifest(bundle)).toContain('aw.plugin-config.v3')
    expect(deriveAwCapabilitiesFromManifest(bundle)).toContain('aw.plugin-config-summary.v1')
    expect(checkAwCapabilitySupport(deriveAwCapabilitiesFromManifest(bundle), ['aw.plugin-manifest.v3', 'aw.plugin-config.v2']).missing)
      .toEqual(['aw.plugin-config-summary.v1', 'aw.plugin-config.v3'])
  })
  it('counts reference edges through aliases and object children; inline nodes cost zero', () => {
    expect(PLUGIN_CONFIG_V3_MAX_REF_DEPTH).toBe(8)
    const definitions: Record<string, unknown> = { d8: { type: 'string' } }
    for (let n = 7; n >= 1; n--) definitions[`d${n}`] = ref(`d${n + 1}`)
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: { value: ref('d1') } })).not.toThrow()
    definitions.d0 = ref('d1')
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: { value: ref('d0') } })).toThrow(/8 reference edges/u)
    delete definitions.d0
    definitions.object = { type: 'object', properties: { child: ref('d1') } }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: { value: ref('object') } })).toThrow(/8 reference edges/u)
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: { value: { type: 'object', properties: { child: ref('d1') } } } })).not.toThrow()
  })
  it.each([
    ['unused unknown', { a: ref('missing') }], ['unused cycle', { a: ref('b'), b: ref('a') }],
    ['unused invalid default', { a: { type: 'string', default: 1 } }],
    ['dangerous name', JSON.parse('{"constructor":{"type":"string"}}')],
    ['remote reference', { a: { $ref: 'https://example.com/schema' } }],
    ['constraint override', { a: { type: 'string' }, b: { ...ref('a'), validation: { minLength: 2 } } }],
  ])('rejects %s even without consuming fields', (_label, definitions) => {
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: {} })).toThrow()
  })
  it.each([
    ['default', { type: 'string', default: 'bad' }], ['sensitive', { type: 'string', sensitive: true }],
    ['nested object', { type: 'object', properties: {} }],
  ])('rejects referenced child %s', (_label, child) => {
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions: { child }, fields: { value: { type: 'object', properties: { child: ref('child') } } } })).toThrow()
  })
  it('rejects dynamic required, mixed objects, unsafe child keys and invalid overridden defaults', () => {
    for (const fields of [
      { value: { type: 'object', additionalProperties: ref('child') } },
      { value: { type: 'object', properties: {}, additionalProperties: ref('child') } },
      { value: { type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') } },
      { value: { ...ref('child'), default: 3 } },
    ]) expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions: { child: { type: 'string', required: true } }, fields })).toThrow()
  })
  it('rejects a shared nested-object graph before expanding its descendants', () => {
    const definitions: Record<string, unknown> = { leaf: { type: 'string' } };
    let previous = 'leaf';
    for (let depth = 0; depth < 7; depth++) {
      const name = `object${depth}`;
      definitions[name] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`child${i}`, ref(previous)])) };
      previous = name;
    }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions, fields: { value: ref(previous) } }))
      .toThrow(/expected string, number, or boolean/u);
  });
  it('limits reference overrides to presentation, required and validated defaults', () => {
    const compiled = normalizePluginConfigDefinition({ schemaVersion: 3, definitions: { value: { type: 'string', title: 'Base', required: true, default: 'old', validation: { minLength: 2 } } },
      fields: { value: { ...ref('value'), title: 'Local', description: 'Local description', required: false, default: 'new' } } });
    expect(compiled.fields.value).toMatchObject({ type: 'string', title: 'Local', required: false, default: 'new', validation: { minLength: 2 } });
    for (const field of [{ type: 'string', sensitive: true }, { type: 'string' }, { type: 'object', additionalProperties: { type: 'string' } }]) {
      expect(() => normalizePluginConfigDefinition({ ...config(), definitions: {}, fields: { profile: field } })).toThrow(/fixed object/u);
    }
  });
  it('applies v3 budgets without reducing the v2 field allowance', () => {
    const map = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: 'string' }]))
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions: map(64), fields: map(256) })).not.toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions: map(65), fields: {} })).toThrow(/64/u)
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: map(257) })).toThrow(/256/u)
    expect(() => normalizePluginConfigDefinition({ fields: map(257) })).not.toThrow()
    expect(() => assertPluginManifestStructure(manifest({ fields: map(257) }))).not.toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { object: { type: 'object', properties: map(33) } } })).toThrow(/32/u)
  })
  it('validates summary bindings, paths, formats and code point budgets', () => {
    const valid = config()
    valid.presentation.summaries.concise.separator = '😀'.repeat(8)
    expect(() => assertPluginManifestStructure(manifest(valid))).not.toThrow()
    expect(() => normalizePluginConfigDefinition(valid)).not.toThrow()
    const cases = [
      { ...valid.presentation, fieldViews: { unknown: { summary: 'concise' } } },
      { ...valid.presentation, fieldViews: { profile: { summary: 'missing' } } },
      ...['/unknown', '/model/child', '/constructor', '/model~2', '/' + 'x'.repeat(128)].map(path => ({ ...valid.presentation, summaries: { concise: { ...valid.presentation.summaries.concise, parts: [{ path }] } } })),
      { ...valid.presentation, summaries: { concise: { ...valid.presentation.summaries.concise, parts: Array(5).fill({ path: '/model' }) } } },
      { ...valid.presentation, summaries: { concise: { ...valid.presentation.summaries.concise, separator: '😀'.repeat(9) } } },
      { ...valid.presentation, summaries: { concise: { ...valid.presentation.summaries.concise, parts: [{ path: '/model', format: 'script' }] } } },
    ]
    for (const presentation of cases) expect(() => normalizePluginConfigDefinition({ ...valid, presentation })).toThrow()
    expect(() => normalizePluginConfigDefinition({ fields: {}, presentation: valid.presentation })).toThrow()
  })
})
