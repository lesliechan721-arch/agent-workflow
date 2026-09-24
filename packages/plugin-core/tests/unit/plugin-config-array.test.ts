import { describe, expect, it } from 'vitest'

import {
  assertPluginManifestStructure,
  canonicalizePluginConfigValue,
  checkAwCapabilitySupport,
  createBundleSourceManifest,
  deriveAwCapabilitiesFromManifest,
  matchPluginConfigPreset,
  normalizePluginConfigDefinition,
  PLUGIN_CONFIG_ARRAY_MAX_BYTES,
  PLUGIN_CONFIG_ARRAY_MAX_ITEMS,
  stablePluginConfigStringify,
  validatePluginConfigDocument,
  validatePluginConfigValue,
  validatePluginManifest,
} from '../../src/manifest.js'

const ref = (name: string) => ({ $ref: `#/config/definitions/${name}` })
const fixed = {
  type: 'object',
  properties: { model: { type: 'string', required: true }, weight: { type: 'number' } },
  additionalProperties: false,
}
const kv = { type: 'object', additionalProperties: { type: 'boolean' } }

function manifest(config: unknown) {
  return {
    schemaVersion: 3,
    name: 'array-example', version: '0.1.0', description: 'Array example',
    marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config,
  }
}

describe('Config Definition v3 arrays', () => {
  it('validates all five homogeneous element forms, defaults, presets and whole-value equality', () => {
    const config = normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
      strings: { type: 'array', items: { type: 'string' }, default: ['a'],
        choices: { allowCustom: false, presets: [{ id: 'empty', title: 'Empty', value: [] }, { id: 'a', title: 'A', value: ['a'] }] } },
      numbers: { type: 'array', items: { type: 'number' } },
      flags: { type: 'array', items: { type: 'boolean' } },
      fixed: { type: 'array', items: fixed },
      kv: { type: 'array', items: kv },
      requiredList: { type: 'array', items: { type: 'string' }, required: true, validation: { minItems: 1 } },
    } })
    expect(validatePluginConfigDocument(config, {
      strings: [], numbers: [0, 1], flags: [false, true],
      fixed: [{ weight: 1, model: 'a' }], kv: [{ enabled: false }], requiredList: ['yes'],
    })).toEqual([])
    expect(matchPluginConfigPreset(config.fields.strings!, [])?.id).toBe('empty')
    expect(validatePluginConfigValue(config.fields.strings!, ['x'])[0]?.code).toBe('choice')
    expect(stablePluginConfigStringify([{ model: 'a', weight: 1 }]))
      .toBe(stablePluginConfigStringify([{ weight: 1, model: 'a' }]))
    expect(stablePluginConfigStringify([{ model: 'a' }, { model: 'b' }]))
      .not.toBe(stablePluginConfigStringify([{ model: 'b' }, { model: 'a' }]))
    expect(canonicalizePluginConfigValue([{ weight: 1, model: 'a' }]))
      .toEqual([{ model: 'a', weight: 1 }])
    expect(validatePluginConfigValue(config.fields.numbers!, [0, 0])).toEqual([])
    expect(validatePluginConfigValue(config.fields.requiredList!, [])[0]?.code).toBe('minItems')
    expect(validatePluginConfigDocument(config, { fixed: [] }).map((issue) => issue.code)).toEqual(['required'])
  })

  it('rejects invalid structure after references expand and preserves item summary evidence', () => {
    const source = manifest({ schemaVersion: 3,
      definitions: { stringItem: { type: 'string' }, fixedItem: fixed },
      fields: {
        names: { type: 'array', items: ref('stringItem') },
        models: { type: 'array', items: ref('fixedItem') },
      },
      presentation: { summaries: { model: { kind: 'join', parts: [{ path: '/model' }], separator: '/', missing: '?' } },
        fieldViews: { models: { itemSummary: 'model' } } },
    })
    assertPluginManifestStructure(source)
    const normalized = validatePluginManifest('/tmp/array-example', source)
    expect(normalized.config?.presentation?.fieldViews?.models).toEqual({ itemSummary: 'model' })
    const bundle = createBundleSourceManifest({
      rootDir: '/tmp/array-example', manifestPath: '/tmp/array-example/.agents-plugin/plugin.json', manifest: normalized,
    })
    expect(JSON.stringify(bundle.config)).not.toContain('$ref')
    expect(normalizePluginConfigDefinition(bundle.config)).toEqual(normalized.config)
    expect(deriveAwCapabilitiesFromManifest(bundle)).toContain('aw.plugin-config-array.v1')
    expect(deriveAwCapabilitiesFromManifest(bundle)).toContain('aw.plugin-config-summary.v1')
    expect(checkAwCapabilitySupport(deriveAwCapabilitiesFromManifest(bundle), ['aw.plugin-config.v3']).missing)
      .toContain('aw.plugin-config-array.v1')

    for (const item of [
      { type: 'string', default: 'x' }, { type: 'string', required: true },
      { type: 'string', sensitive: true }, { type: 'array', items: { type: 'string' } },
      { type: 'object', properties: { nested: { type: 'object', properties: {} } } },
    ]) {
      expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { bad: { type: 'array', items: item } } })).toThrow()
    }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3,
      definitions: { secret: { type: 'string', sensitive: true } },
      fields: { bad: { type: 'array', items: ref('secret') } },
    })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3,
      definitions: { a: ref('b'), b: ref('a') }, fields: { bad: { type: 'array', items: ref('a') } },
    })).toThrow()
    expect(() => normalizePluginConfigDefinition({ fields: { bad: { type: 'array', items: { type: 'string' } } } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { bad: {
      type: 'array', items: kv,
    } }, presentation: { summaries: { key: { kind: 'join', parts: [{ path: '/key' }], separator: '', missing: '?' } },
      fieldViews: { bad: { itemSummary: 'key' } } } })).toThrow()
  })

  it('enforces item, byte and object budgets with full array issue paths', () => {
    const fields = normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
      text: { type: 'array', items: { type: 'string' }, validation: { uniqueItems: true } },
      models: { type: 'array', items: fixed },
      kv: { type: 'array', items: kv },
      objectUnique: { type: 'array', items: fixed, validation: { uniqueItems: true } },
    } }).fields
    expect(PLUGIN_CONFIG_ARRAY_MAX_ITEMS).toBe(128)
    expect(PLUGIN_CONFIG_ARRAY_MAX_BYTES).toBe(262144)
    expect(validatePluginConfigValue(fields.text!, Array(128).fill('x'))[0]).toMatchObject({
      code: 'uniqueItems', path: { field: 'value', segments: ['value', 1] },
    })
    expect(validatePluginConfigValue(fields.text!, Array(129).fill('x'))[0]?.code).toBe('maxItems')
    expect(validatePluginConfigValue(fields.kv!, Array(128).fill(null).map(() => ({})))).toEqual([])
    expect(validatePluginConfigValue(fields.objectUnique!, [{ model: 'a', weight: 1 }, { weight: 1, model: 'a' }])[0])
      .toMatchObject({ code: 'uniqueItems', path: { segments: ['value', 1] } })
    expect(validatePluginConfigValue(fields.models!, [{ model: 'ok' }, { weight: 1 }], 'models')[0]).toMatchObject({
      code: 'required', path: { field: 'models', property: 'model', segments: ['models', 1, 'model'] },
    })
    expect(validatePluginConfigValue(fields.kv!, [Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, true]))])[0]?.code)
      .toBe('maxProperties')
    expect(validatePluginConfigValue(fields.text!, ['x'.repeat(PLUGIN_CONFIG_ARRAY_MAX_BYTES)])[0]?.code).toBe('maxBytes')
    expect(validatePluginConfigValue(fields.text!, ['x'.repeat(PLUGIN_CONFIG_ARRAY_MAX_BYTES - 4)])).toEqual([])
    expect(validatePluginConfigValue(fields.models!, [{ model: 'a', weight: Number.POSITIVE_INFINITY }])[0]?.path.segments)
      .toEqual(['value', 0, 'weight'])
    expect(validatePluginConfigValue(fields.kv!, [new Date()])[0]?.path.segments).toEqual(['value', 0])
    expect(validatePluginConfigValue(fields.text!, ['ok', 3])[0]?.path.segments).toEqual(['value', 1])
    expect(validatePluginConfigValue(fields.text!, ['ok', Number.NaN])[0]?.code).toBe('type')
  })

  it('rejects invalid array declarations and invalid complete defaults or presets', () => {
    for (const validation of [
      { maxItems: 129 }, { minItems: 129 }, { minItems: 3, maxItems: 2 },
      { minItems: -1 }, { uniqueItems: 'yes' },
    ]) {
      expect(() => normalizePluginConfigDefinition({ schemaVersion: 3,
        fields: { bad: { type: 'array', items: { type: 'string' }, validation } },
      })).toThrow()
    }
    for (const extra of [
      { default: ['a', 1] }, { default: ['x', 'x'], validation: { uniqueItems: true } },
      { choices: { allowCustom: false, presets: [{ id: 'bad', title: 'Bad', value: ['a', false] }] } },
    ]) {
      expect(() => normalizePluginConfigDefinition({ schemaVersion: 3,
        fields: { bad: { type: 'array', items: { type: 'string' }, ...extra } },
      })).toThrow()
    }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
      bad: { type: 'array', sensitive: true, items: { type: 'string' } },
    } })).toThrow()
    expect(() => assertPluginManifestStructure(manifest({ schemaVersion: 3, fields: {
      bad: { type: 'array', items: { type: 'string' }, default: ['x', 1] },
    } }))).toThrow()
  })
})
