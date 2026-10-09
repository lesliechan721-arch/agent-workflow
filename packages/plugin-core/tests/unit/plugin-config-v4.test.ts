import { describe, expect, it } from 'vitest'
import {
  assertPluginManifestStructure,
  checkAwCapabilitySupport,
  createBundleSourceManifest,
  deriveAwCapabilitiesFromManifest,
  getPluginConfigDependencyKeys,
  normalizePluginConfigDefinition,
  resolvePluginConfigObjectProperties,
  stablePluginConfigStringify,
  validatePluginConfigCandidate,
  validatePluginConfigDocument,
  validatePluginConfigValue,
  validatePluginManifest,
  type PluginConfigObjectField,
} from '../../src/manifest.js'

const ref = (name: string, required?: boolean) => ({ $ref: `#/config/definitions/${name}`, ...(required === undefined ? {} : { required }) })
const string = { type: 'string' }
const args = { type: 'array', items: string, validation: { maxItems: 128 } }
const env = { type: 'object', additionalProperties: string, validation: { key: { maxLength: 64, pattern: '^[A-Za-z_][A-Za-z0-9_]*$' } } }
const registry = {
  type: 'array', default: [], validation: { uniqueBy: 'key' },
  items: { type: 'object', properties: {
    key: { ...string, required: true },
    title: { ...string, required: true },
    adapter: { ...string, required: true, choices: { allowCustom: false, presets: ['codex', 'claude-code', 'oracle', 'custom'].map(value => ({ id: value, title: value, value })) } },
    args: ref('args'), env: ref('env'),
  }, variants: { discriminator: 'adapter', cases: {
    codex: { properties: { mode: { ...string, const: 'workspace' } } },
    'claude-code': { properties: { mode: { ...string, const: 'workspace' } } },
    oracle: { properties: { mode: { ...string, const: 'bundle' } } },
    custom: { properties: { mode: { ...string, required: true }, command: { ...string, required: true }, entrypoint: string } },
  } } },
}
const config = () => ({ schemaVersion: 4, definitions: { args, env, model: string, effort: string }, fields: {
  backends: registry,
  profile: { type: 'object', properties: {
    executor: { ...string, valueRef: { field: 'backends', key: 'key', label: 'title', include: ['native'] } },
  }, variants: { discriminator: 'executor', missing: 'native', cases: {
    native: { properties: { model: ref('model', true), effort: ref('effort', true) } },
  }, otherwise: { properties: { model: ref('model'), effort: ref('effort') } } } },
} })
const manifest = (config: unknown) => ({ schemaVersion: 3, name: 'config-v4', version: '1.0.0', description: 'Example',
  marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } }, config })
const backend = (adapter = 'codex') => ({ key: 'remote', title: 'Remote', adapter })

// Value gate: these tests protect public source/bundle contracts and actual candidate rejection.
describe('Config Definition v4', () => {
  it('preserves bounded branches and leaves through public manifest and bundle entry points', () => {
    const source = manifest(config())
    assertPluginManifestStructure(source)
    const normalized = validatePluginManifest('/tmp/config-v4', source)
    const bundle = createBundleSourceManifest({ rootDir: '/tmp/config-v4', manifestPath: '/tmp/config-v4/.agents-plugin/plugin.json', manifest: normalized })
    expect(bundle.config?.schemaVersion).toBe(4)
    expect(normalizePluginConfigDefinition(bundle.config)).toEqual(normalized.config)
    expect(JSON.stringify(bundle.config)).not.toContain('$ref')
    expect(validatePluginConfigDocument(normalized.config!, { backends: [{ ...backend(), args: ['', '--engine', 'api'], env: { PATH: '', HTTPS_PROXY: 'local' } }], profile: { executor: 'remote' } })).toEqual([])
    const capabilities = deriveAwCapabilitiesFromManifest(bundle)
    expect(capabilities).toEqual(expect.arrayContaining(['aw.plugin-config.v4', 'aw.plugin-config-array.v1', 'aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1']))
    expect(checkAwCapabilitySupport(capabilities, capabilities.filter(capability => capability !== 'aw.plugin-config.v4')).missing).toEqual(['aw.plugin-config.v4'])
    expect(() => assertPluginManifestStructure({ ...source, configV4PlainStringField: { type: 'string' } })).toThrow()
  })

  it.each(['codex', 'claude-code', 'oracle'])('allows omitted built-in mode and rejects hidden properties or incorrect %s constants', adapter => {
    const definition = normalizePluginConfigDefinition(config())
    const source = [{ ...backend(adapter) }]
    expect(validatePluginConfigValue(definition.fields.backends!, source)).toEqual([])
    expect(source).toEqual([backend(adapter)])
    expect(validatePluginConfigValue(definition.fields.backends!, [{ ...backend(adapter), command: '/tmp/command' }])).toMatchObject([{ code: 'additionalProperty', path: { segments: ['value', 0, 'command'] } }])
    expect(validatePluginConfigValue(definition.fields.backends!, [{ ...backend(adapter), mode: adapter === 'oracle' ? 'workspace' : 'bundle' }])).toMatchObject([{ code: 'const', path: { segments: ['value', 0, 'mode'] } }])
    const item = (definition.fields.backends as { items: PluginConfigObjectField }).items
    const resolved = resolvePluginConfigObjectProperties(item, backend(adapter))
    expect(resolved.variant).toEqual({ kind: 'case', case: adapter })
    expect(resolved.properties.mode).toMatchObject({ const: adapter === 'oracle' ? 'bundle' : 'workspace' })
    expect(resolved.properties.command).toBeUndefined()
  })

  it('requires native fields on missing/explicit native and allows external profile omissions only for registered keys', () => {
    const definition = normalizePluginConfigDefinition(config())
    for (const profile of [{}, { executor: 'native' }]) {
      expect(validatePluginConfigCandidate(definition, { backends: [], profile }).map(issue => issue.code)).toEqual(['required', 'required'])
    }
    expect(validatePluginConfigCandidate(definition, { backends: [], profile: { model: 'local', effort: 'high' } })).toEqual([])
    expect(validatePluginConfigCandidate(definition, { backends: [backend()], profile: { executor: 'remote' } })).toEqual([])
    expect(validatePluginConfigCandidate(definition, { backends: [backend()], profile: { executor: 'missing' } })).toMatchObject([{ code: 'valueRef' }])
    expect(validatePluginConfigCandidate(definition, { backends: [{ ...backend(), key: 'native' }] })).toMatchObject([{ code: 'valueRefReserved' }])
    expect(validatePluginConfigValue(definition.fields.backends!, [backend('custom')]).map(issue => issue.code)).toEqual(['required', 'required'])
    expect(validatePluginConfigValue(definition.fields.backends!, [{ ...backend('custom'), command: '/tmp/custom', mode: 'bundle' }])).toEqual([])
  })

  it('validates the discriminator before choosing any case and never guesses an unmatched branch', () => {
    const object = { type: 'object', properties: { kind: { ...string, choices: { allowCustom: false, presets: [{ id: 'known', title: 'Known', value: 'known' }] } } }, variants: { discriminator: 'kind', cases: { known: { properties: { fixed: { ...string, const: 'ok' } } } }, otherwise: { properties: { fallback: string } } } }
    const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: { object } })
    const schema = definition.fields.object as PluginConfigObjectField
    for (const value of [{ kind: 'bad' }, { kind: 1 }, { kind: undefined }]) {
      const resolved = resolvePluginConfigObjectProperties(schema, value)
      expect(Object.keys(resolved.properties)).toEqual(['kind'])
      expect(resolved.issues).toHaveLength(1)
      expect(resolved.variant).toBeUndefined()
    }
    expect(validatePluginConfigValue(schema, {})).toMatchObject([{ code: 'variant' }])
    const open = normalizePluginConfigDefinition({ schemaVersion: 4, fields: { object: { ...object, properties: { kind: string }, variants: { discriminator: 'kind', cases: object.variants.cases } } } })
    expect(validatePluginConfigValue(open.fields.object!, { kind: 'unknown' })).toMatchObject([{ code: 'variant' }])
  })

  it('checks scalar constants against type, validation, choices and required without populating values', () => {
    const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      text: { ...string, const: 'fixed' }, number: { type: 'number', const: 0 }, flag: { type: 'boolean', const: false, required: true },
    } })
    expect(validatePluginConfigDocument(definition, { number: 0, flag: false })).toEqual([])
    expect(validatePluginConfigDocument(definition, { number: 1, flag: true }).map(issue => issue.code)).toEqual(['const', 'const'])
    expect(validatePluginConfigDocument(definition, {}).map(issue => issue.code)).toEqual(['required'])
    for (const field of [
      { ...string, const: 1 }, { type: 'number', const: Infinity },
      { ...string, const: 'x', validation: { minLength: 2 } },
      { ...string, const: 'x', choices: { allowCustom: false, presets: [{ id: 'y', title: 'Y', value: 'y' }] } },
      { ...string, const: 'x', default: 'y' }, { ...string, sensitive: true, const: 'secret' },
    ]) expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: { field } })).toThrow()
  })

  it('reports complete leaf paths and checks nested array/KV limits, types and dangerous keys', () => {
    const definition = normalizePluginConfigDefinition(config())
    const schema = definition.fields.backends!
    expect(validatePluginConfigValue(schema, [{ ...backend(), args: ['ok', 3] }], 'backends')).toMatchObject([{ code: 'type', path: { segments: ['backends', 0, 'args', 1] } }])
    expect(validatePluginConfigValue(schema, [{ ...backend(), env: { 'BAD-NAME': 'x' } }], 'backends')).toMatchObject([{ code: 'pattern', path: { segments: ['backends', 0, 'env', 'BAD-NAME'] } }])
    expect(validatePluginConfigValue(schema, [{ ...backend(), env: JSON.parse('{"__proto__":"x"}') }])).toMatchObject([{ code: 'dangerousKey' }])
    expect(validatePluginConfigValue(schema, [{ ...backend(), args: Array(129).fill('x') }])).toMatchObject([{ code: 'maxItems' }])
    expect(validatePluginConfigValue(schema, [{ ...backend(), env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`K${index}`, 'x'])) }])).toMatchObject([{ code: 'maxProperties' }])
    expect(validatePluginConfigValue(schema, [{ ...backend(), args: Array(128).fill('x'.repeat(2048)) }])).toMatchObject([{ code: 'maxBytes' }])
  })

  it('canonicalizes leaf object keys recursively for full object equality without changing array order', () => {
    const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      values: { type: 'array', validation: { uniqueItems: true }, items: { type: 'object', properties: { env, args } } },
    } })
    const first = { env: { A: 'a', B: 'b' }, args: ['a', 'b'] }
    const second = { args: ['a', 'b'], env: { B: 'b', A: 'a' } }
    expect(stablePluginConfigStringify(first)).toEqual(stablePluginConfigStringify(second))
    expect(validatePluginConfigValue(definition.fields.values!, [first, second])).toMatchObject([{ code: 'uniqueItems' }])
    expect(validatePluginConfigValue(definition.fields.values!, [first, { ...second, args: ['b', 'a'] }])).toEqual([])
  })

  it('tracks value references inside selected variants and scalar leaves through complete dependency validation', () => {
    const valueRef = { field: 'keys', key: 'id' }
    const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      keys: { type: 'array', validation: { uniqueBy: 'id' }, items: { type: 'object', properties: { id: { ...string, required: true } } } },
      object: { type: 'object', properties: { kind: string }, variants: { discriminator: 'kind', cases: {
        active: { properties: { args: { type: 'array', items: { ...string, valueRef } }, env: { type: 'object', additionalProperties: { ...string, valueRef } } } },
        idle: { properties: {} },
      } } },
    } })
    expect(getPluginConfigDependencyKeys(definition, ['object'])).toEqual(['object', 'keys'])
    expect(validatePluginConfigCandidate(definition, { keys: [{ id: 'allowed' }], object: { kind: 'active', args: ['allowed'], env: { A: 'allowed' } } }, ['object'])).toEqual([])
    expect(validatePluginConfigCandidate(definition, { keys: [], object: { kind: 'active', args: ['absent'], env: { A: 'absent' } } }, ['object'])).toMatchObject([
      { code: 'valueRef', path: { segments: ['object', 'args', 0] } }, { code: 'valueRef', path: { segments: ['object', 'env', 'A'] } },
    ])
    expect(validatePluginConfigCandidate(definition, { keys: [], object: { kind: 'idle' } }, ['object'])).toEqual([])
  })

  it('rejects invalid unselected variants and unsupported recursive or sensitive leaf schemas', () => {
    const fixed = { type: 'object', properties: { selector: string } }
    const variants = { discriminator: 'selector', cases: { valid: { properties: {} } } }
    for (const object of [
      { ...fixed, variants: { ...variants, discriminator: 'unknown' } },
      { ...fixed, properties: { selector: { type: 'number' } }, variants },
      { ...fixed, variants: { ...variants, missing: 'missing' } },
      { ...fixed, variants: { ...variants, cases: { valid: { properties: { selector: string } } } } },
      { ...fixed, variants: { ...variants, cases: { valid: { properties: {} }, unused: { properties: { child: { type: 'array', items: { type: 'object', properties: {} } } } } } } },
      { ...fixed, variants: { ...variants, cases: { valid: { properties: { child: { type: 'object', properties: {} } } } } } },
      { ...fixed, properties: { ...fixed.properties, child: { type: 'array', items: { ...string, sensitive: true } } }, variants },
      { ...fixed, properties: { ...fixed.properties, child: { type: 'object', additionalProperties: { type: 'array', items: string } } }, variants },
      { ...fixed, variants: { ...variants, cases: JSON.parse('{"constructor":{"properties":{}}}') } },
    ]) expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: { object } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: { object: { type: 'object', additionalProperties: string, variants } } })).toThrow()
  })

  it('keeps v2/v3 source and runtime acceptance ranges unchanged', () => {
    const objects = [
      { type: 'object', properties: { args } },
      { type: 'object', properties: { env } },
      { type: 'object', properties: { kind: string }, variants: { discriminator: 'kind', cases: { one: { properties: {} } } } },
      { ...string, const: 'x' },
    ]
    for (const object of objects) {
      for (const version of [undefined, 3]) {
        const config = { ...(version === undefined ? {} : { schemaVersion: version }), fields: { object } }
        expect(() => assertPluginManifestStructure(manifest(config))).toThrow()
        expect(() => normalizePluginConfigDefinition(config)).toThrow()
      }
    }
  })

  it('checks references and budgets in every case and rejects leaf summary/uniqueBy/reference labels', () => {
    const withSummary = { ...config(), presentation: { summaries: { profile: {
      kind: 'join', parts: [{ path: '/model' }, { path: '/effort' }], separator: '/', missing: '-',
    } }, fieldViews: { profile: { summary: 'profile' } } } }
    expect(() => normalizePluginConfigDefinition(withSummary)).not.toThrow()
    const invalids = [
      { schemaVersion: 4, definitions: { bad: { type: 'object', properties: { child: { type: 'object', properties: {} } } } }, fields: {} },
      { schemaVersion: 4, fields: { object: { type: 'object', properties: { selector: string }, variants: { discriminator: 'selector', cases: { valid: { properties: {} }, unused: { properties: { child: ref('missing') } } } } } } },
      { schemaVersion: 4, fields: { array: { type: 'array', validation: { uniqueBy: 'args' }, items: { type: 'object', properties: { args } } } } },
      { ...config(), presentation: { summaries: { one: { kind: 'join', parts: [{ path: '/args' }], separator: '/', missing: '-' } }, fieldViews: { backends: { itemSummary: 'one' } } } },
      { schemaVersion: 4, fields: { keys: { type: 'array', validation: { uniqueBy: 'id' }, items: { type: 'object', properties: { id: string, args } } }, target: { ...string, valueRef: { field: 'keys', key: 'id', label: 'args' } } } },
    ]
    for (const invalid of invalids) expect(() => normalizePluginConfigDefinition(invalid)).toThrow()
    const many = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`p${index}`, string]))
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: { object: { type: 'object', properties: { selector: string }, variants: { discriminator: 'selector', cases: { one: { properties: many } } } } } })).toThrow(/32/u)
    const definitions: Record<string, unknown> = { d8: string }
    for (let index = 7; index >= 1; index--) definitions[`d${index}`] = ref(`d${index + 1}`)
    const object = { type: 'object', properties: { selector: string }, variants: { discriminator: 'selector', cases: { one: { properties: { leaf: ref('d1') } } } } }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, definitions, fields: { object } })).not.toThrow()
    definitions.d0 = ref('d1')
    object.variants.cases.one.properties.leaf = ref('d0')
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, definitions, fields: { object } })).toThrow(/8 reference edges/u)
  })
})
