import { describe, expect, it } from 'vitest'

import {
  assertPluginManifestStructure,
  createBundleSourceManifest,
  deriveAwCapabilitiesFromManifest,
  validatePluginManifest,
} from '../../src/manifest.js'
import {
  compilePluginConfigDefinition,
  formatPluginConfigIssue,
  normalizePluginConfigDefinition,
  validatePluginConfigCandidate,
  validatePluginConfigValue,
} from '../../src/plugin-config.js'

const pluginRoot = '/tmp/nested-config'
const manifest = (config: unknown) => ({
  schemaVersion: 4, name: 'nested-config', version: '1.0.0', description: 'Nested config fixture',
  marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  config,
})
const ref = (name: string) => ({ $ref: `#/config/definitions/${name}` })
const string = { type: 'string' }
const modelItem = {
  type: 'object',
  properties: {
    id: { ...string, required: true },
    description: string,
    efforts: { type: 'array', items: ref('effort') },
    default: { type: 'boolean' },
    labels: { type: 'object', additionalProperties: string },
  },
}
const models = { type: 'array', items: ref('modelItem'), required: true, validation: { uniqueBy: 'id' } }
const command = { type: 'object', properties: { models } }
const defaultModel = { id: 'example', efforts: ['low'], default: false, labels: { group: 'example' } }
const config = {
  schemaVersion: 5,
  definitions: { modelItem, effort: string },
  fields: {
    subagentCommands: { type: 'array', items: command, default: [{ models: [defaultModel] }] },
    command: { ...command, default: { models: [defaultModel] }, choices: {
      allowCustom: true, presets: [{ id: 'baseline', title: 'Baseline', value: { models: [defaultModel] } }],
    } },
  },
}

describe('Config v5 nested fixed object arrays', () => {
  // A v5 source and its generated bundle both need to accept the same resolved schema.
  it('expands nested item references in common and platform profiles and preserves them in bundles', () => {
    const source = validatePluginManifest(pluginRoot, manifest({
      ...config,
      platforms: { codex: { definitions: { modelItem: {
        ...modelItem, properties: { ...modelItem.properties, description: { ...string, title: 'Codex description' } },
      } } } },
    }))
    const bundle = createBundleSourceManifest({ rootDir: pluginRoot, manifestPath: `${pluginRoot}/.agents-plugin/plugin.json`, manifest: source })
    expect(deriveAwCapabilitiesFromManifest(bundle)).toEqual(expect.arrayContaining([
      'aw.plugin-config.v5', 'aw.plugin-config-array.v1', 'aw.plugin-config-unique-by.v1',
    ]))
    const bundled = validatePluginManifest(pluginRoot, JSON.parse(JSON.stringify(bundle))).config!
    const compiled = compilePluginConfigDefinition(bundled, 'codex')
    expect(compiled.fields.subagentCommands).toMatchObject({
      default: [{ models: [defaultModel] }],
      items: { properties: { models: { items: { properties: {
        description: { title: 'Codex description' },
        efforts: { items: { type: 'string' } },
      } } } } },
    })
    expect(validatePluginConfigCandidate(compiled, {
      subagentCommands: [{ models: [defaultModel, { ...defaultModel, id: 'Example' }] }],
      command: { models: [defaultModel] },
    })).toEqual([])
  })

  // Exact property and row positions are used to guide users to the invalid nested value.
  it('reports full nested paths for required properties, duplicate keys and invalid scalar-array items', () => {
    const compiled = compilePluginConfigDefinition(config)
    const field = compiled.fields.subagentCommands!
    const validate = (rows: unknown[]) => validatePluginConfigValue(field, rows, 'subagentCommands')
    const duplicate = validate([{ models: [defaultModel, defaultModel] }])
    expect(duplicate).toMatchObject([{ code: 'uniqueBy', path: { segments: ['subagentCommands', 0, 'models', 1, 'id'] } }])
    expect(formatPluginConfigIssue(duplicate[0]!)).toMatch(/^subagentCommands\[0\]\.models\[1\]\.id:/u)
    expect(validate([{ models: [defaultModel, {}] }])).toMatchObject([
      { code: 'required', path: { segments: ['subagentCommands', 0, 'models', 1, 'id'] } },
    ])
    expect(validate([{ models: [{ ...defaultModel, efforts: ['low', 1] }] }])).toMatchObject([
      { code: 'type', path: { segments: ['subagentCommands', 0, 'models', 0, 'efforts', 1] } },
    ])
  })

  // Each nested list may fit on its own while the complete value exceeds the outer UTF-8 budget.
  it('enforces the top-level byte limit across nested arrays', () => {
    const field = compilePluginConfigDefinition(config).fields.subagentCommands!
    const largeModels = Array.from({ length: 32 }, (_, index) => ({ id: String(index), description: '界'.repeat(1500) }))
    expect(validatePluginConfigValue(field, [{ models: largeModels }])).toEqual([])
    expect(validatePluginConfigValue(field, [{ models: largeModels }, { models: largeModels }], 'subagentCommands'))
      .toMatchObject([{ code: 'maxBytes', path: { segments: ['subagentCommands'] } }])
  })

  // Both the public schema and the resolved definition constrain the shape at the nested boundary.
  it('rejects v4 nesting and invalid inline and referenced v5 items', () => {
    const fieldWithItem = (items: unknown) => ({ ...command, properties: { models: { ...models, items } } })
    const v4 = { schemaVersion: 4, fields: { command: fieldWithItem({ type: 'object', properties: {} }) } }
    expect(() => assertPluginManifestStructure(manifest(v4))).toThrow()
    expect(() => normalizePluginConfigDefinition(v4)).toThrow()

    for (const item of [
      { ...modelItem, properties: { ...modelItem.properties, next: { type: 'array', items: { type: 'object', properties: {} } } } },
      { ...modelItem, properties: { next: { type: 'object', properties: {} } } },
      { ...modelItem, properties: { id: { ...string, default: 'invalid' } } },
      { ...modelItem, properties: { id: { ...string, sensitive: true } } },
      { ...modelItem, variants: { discriminator: 'id', cases: { example: { properties: {} } } } },
      { ...modelItem, required: true },
      { ...modelItem, default: { id: 'invalid' } },
      { ...modelItem, sensitive: true },
      { type: 'object', additionalProperties: string },
    ]) {
      const inline = { ...config, fields: { command: fieldWithItem(item) } }
      expect(() => assertPluginManifestStructure(manifest(inline))).toThrow()
      const referenced = { ...config, definitions: { ...config.definitions, modelItem: item } }
      expect(() => normalizePluginConfigDefinition(referenced)).toThrow()
    }

    const tooMany = { ...config, fields: { command: { ...command, properties: {
      models: { ...models, validation: { maxItems: 129 } },
    } } } }
    expect(() => normalizePluginConfigDefinition(tooMany)).toThrow(/128/u)
  })

  it('shares the reference edge limit across an item and its properties', () => {
    const chain = Object.fromEntries(Array.from({ length: 7 }, (_, index) =>
      [`item${index}`, ref(index === 6 ? 'modelItem' : `item${index + 1}`)]))
    const example = (name: string) => ({
      ...config, definitions: { ...config.definitions, ...chain },
      fields: { command: { ...command, properties: { models: { ...models, items: ref(name) } } } },
    })
    expect(() => normalizePluginConfigDefinition(example('item1'))).not.toThrow()
    expect(() => normalizePluginConfigDefinition(example('item0'))).toThrow(/8 reference edges/u)
  })
})
