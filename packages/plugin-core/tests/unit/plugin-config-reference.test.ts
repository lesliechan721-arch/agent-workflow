import { describe, expect, it } from 'vitest'
import {
  assertPluginManifestStructure,
  createBundleSourceManifest,
  deriveAwCapabilitiesFromManifest,
  getPluginConfigDependencyKeys,
  normalizePluginConfigDefinition,
  validatePluginConfigCandidate,
  validatePluginConfigDocument,
  validatePluginConfigValue,
  validatePluginManifest,
} from '../../src/manifest.js'

const registry = {
  type: 'array', default: [], validation: { uniqueBy: 'id' },
  items: { type: 'object', properties: {
    id: { type: 'string', required: true },
    caption: { type: 'string', required: true },
    enabled: { type: 'boolean' },
  }, additionalProperties: false },
}
const reference = { field: 'backends', key: 'id', label: 'caption', include: ['builtin'] }
const fields = {
  backends: registry,
  selection: { type: 'object', default: {}, properties: {
    backend: { type: 'string', valueRef: reference },
  }, additionalProperties: false },
  unrelated: { type: 'string', sensitive: true },
}
const config = () => normalizePluginConfigDefinition({ schemaVersion: 3, fields })

describe('Config v3 scalar references and property uniqueness', () => {
  // Protect schema and bundle consumers from silently dropping relational constraints.
  it('retains public constraints in source and bundle, and derives capability requirements', () => {
    const source = { schemaVersion: 3, name: 'backend-choice', version: '1.0.0', description: 'Example',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 3, fields } }
    assertPluginManifestStructure(source)
    const normalized = validatePluginManifest('/tmp/backend-choice', source)
    const bundle = createBundleSourceManifest({ rootDir: '/tmp/backend-choice', manifestPath: '/tmp/backend-choice/.agents-plugin/plugin.json', manifest: normalized })
    expect(normalizePluginConfigDefinition(bundle.config)).toEqual(normalized.config)
    expect(deriveAwCapabilitiesFromManifest(bundle)).toEqual(expect.arrayContaining([
      'aw.plugin-config-unique-by.v1', 'aw.plugin-config-value-ref.v1',
    ]))
  })

  it('compares only the selected scalar without merging labels or converting types', () => {
    const definition = config()
    expect(validatePluginConfigDocument(definition, { backends: [
      { id: 'Remote', caption: 'Same' }, { id: 'remote', caption: 'Same' },
    ], selection: { backend: 'remote' } })).toEqual([])
    expect(validatePluginConfigValue(definition.fields.backends!, [
      { id: 'remote', caption: 'First' }, { id: 'remote', caption: 'Second' },
    ], 'backends')).toMatchObject([{ code: 'uniqueBy', path: { segments: ['backends', 1, 'id'] } }])
    expect(validatePluginConfigDocument(definition, { backends: [{ id: '1', caption: 'One' }], selection: { backend: 1 } })[0]?.code).toBe('type')
    expect(validatePluginConfigDocument(definition, { backends: [{ id: 'builtin', caption: 'Collision' }] }))
      .toMatchObject([{ code: 'valueRefReserved', path: { segments: ['backends', 0, 'id'] } }])
  })

  it('checks the full source and dependency closure while preserving optional legacy properties', () => {
    const definition = config()
    expect(getPluginConfigDependencyKeys(definition, ['selection'])).toEqual(['selection', 'backends'])
    expect(validatePluginConfigCandidate(definition, { backends: [], selection: {} }, ['selection'])).toEqual([])
    expect(validatePluginConfigCandidate(definition, { backends: [], selection: { backend: 'builtin' }, unrelated: 3 }, ['selection'])).toEqual([])
    expect(validatePluginConfigCandidate(definition, { backends: [], selection: { backend: 'remote' } }, ['selection']))
      .toMatchObject([{ code: 'valueRef', path: { field: 'selection', property: 'backend' } }])
    expect(validatePluginConfigCandidate(definition, { backends: [{ id: 'remote', caption: 'Valid' }, { id: 'other' }], selection: { backend: 'remote' } }, ['selection']).map((issue) => issue.code))
      .toEqual(expect.arrayContaining(['required', 'valueRefSource']))
  })

  it('rejects invalid source fields, shallow properties, types and declarations', () => {
    for (const valueRef of [
      { ...reference, field: 'missing' }, { ...reference, key: 'missing' },
      { ...reference, label: 'missing' }, { ...reference, include: [false] },
      { ...reference, include: ['builtin', 'builtin'] }, { ...reference, expression: '$.id' },
    ]) {
      expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
        ...fields, selection: { type: 'string', valueRef },
      } })).toThrow()
    }
    for (const source of [
      { type: 'string' }, { ...registry, validation: { uniqueBy: 'missing' } },
      { ...registry, items: { type: 'string' } },
    ]) expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { ...fields, backends: source } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ fields: { selection: { type: 'string', valueRef: reference } } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { ...fields, selection: { type: 'string', sensitive: true, valueRef: reference } } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, definitions: { unused: { type: 'string', valueRef: { ...reference, field: 'missing' } } }, fields })).toThrow()
  })

  it('validates default and preset property uniqueness, and dependent defaults as one candidate', () => {
    const duplicate = [{ id: 'same', caption: 'A' }, { id: 'same', caption: 'B' }]
    for (const extra of [
      { default: duplicate },
      { choices: { allowCustom: true, presets: [{ id: 'duplicate', title: 'Duplicate', value: duplicate }] } },
    ]) expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { backends: { ...registry, ...extra } } })).toThrow()
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 3, fields: { ...fields,
      selection: { ...fields.selection, default: { backend: 'missing' } },
    } })).toThrow()
  })
})
