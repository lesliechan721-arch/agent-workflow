import os from 'node:os'
import path from 'node:path'

import fs from 'fs-extra'
import { describe, expect, it } from 'vitest'

import {
  assertPluginConfigReferenceSchemas,
  assertPluginManifestStructure,
  createRuntimeConfigSnapshot,
  deriveAwCapabilitiesFromManifest,
  getPluginConfigDependencyFields,
  getPluginConfigDependencyKeys,
  getPluginConfigReferenceChoices,
  normalizePluginConfigDefinition,
  validatePluginConfigCandidate,
  validatePluginConfigDocument,
  validatePluginManifest,
  type PluginConfigReferenceContext,
  type PluginConfigScalarField,
} from '../../src/manifest.js'
import { buildCatalogWorkspace, initializeCatalogWorkspace } from '../../src/workspace.js'

const registry = {
  type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
    type: 'object', properties: { key: { type: 'string', required: true }, title: { type: 'string' } },
  },
}
const reference = { plugin: 'provider', field: 'registry', key: 'key', label: 'title', include: ['native'] }
const consumerConfig = { schemaVersion: 4, fields: {
  registry,
  selected: { type: 'string', default: 'native', valueRef: reference },
} }
const consumer = () => normalizePluginConfigDefinition(consumerConfig, 'config', {
  plugin: 'consumer', dependencies: ['provider'],
})
const provider = () => normalizePluginConfigDefinition({ schemaVersion: 4, fields: { registry } })
const context = (values: Record<string, unknown> = { registry: [{ key: 'Remote', title: 'Shared' }, { key: 'remote', title: 'Shared' }] }): PluginConfigReferenceContext => ({
  plugin: 'consumer', dependencies: ['provider'],
  plugins: { provider: { definition: provider(), dependencies: [], values } },
})
const sourceManifest = (config: unknown = consumerConfig) => ({
  schemaVersion: 3, name: 'consumer', version: '1.0.0', description: 'Consumer',
  dependencies: ['provider'], mcpServers: './.mcp.json',
  marketplace: { category: 'workflow', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  config,
})

describe('Cross-plugin config references', () => {
  // Public schema, normalized source, and capability consumers must agree on the new declaration.
  it('accepts v4 external fields without a local declaration and derives the public capability', () => {
    const source = sourceManifest({ schemaVersion: 4, fields: { selected: consumerConfig.fields.selected } })
    assertPluginManifestStructure(source)
    const normalized = validatePluginManifest('/tmp/consumer', source)
    expect(normalized.config?.fields.selected).toMatchObject({ valueRef: reference })
    expect(deriveAwCapabilitiesFromManifest(source as never)).toContain('aw.plugin-config-cross-plugin-value-ref.v1')
    expect(() => assertPluginManifestStructure(sourceManifest({ ...consumerConfig, schemaVersion: 3 }))).toThrow()
    for (const plugin of ['consumer', 'source/provider', '../provider']) {
      expect(() => validatePluginManifest('/tmp/consumer', sourceManifest({ schemaVersion: 4, fields: {
        selected: { type: 'string', valueRef: { ...reference, plugin } },
      } }))).toThrow()
    }
    expect(() => validatePluginManifest('/tmp/consumer', { ...sourceManifest(), dependencies: [] })).toThrow('direct dependency')
  })

  // A bare field-name set must not select the consumer's equally named registry.
  it('keeps plugin identities in closure and uses only supplied provider values', () => {
    const definition = consumer()
    const ctx = context()
    expect(getPluginConfigDependencyFields(definition, ['registry', 'selected'], ctx)).toEqual([
      { plugin: 'consumer', field: 'registry' }, { plugin: 'consumer', field: 'selected' },
      { plugin: 'provider', field: 'registry' },
    ])
    expect(getPluginConfigDependencyKeys(definition, ['selected'], ctx)).toEqual(['selected'])
    expect(validatePluginConfigCandidate(definition, { registry: [{ key: 'wrong' }], selected: 'remote' }, ['selected'], ctx)).toEqual([])
    expect(validatePluginConfigDocument(definition, { selected: 'wrong', registry: [{ key: 'wrong' }] }, ctx))
      .toMatchObject([{ code: 'valueRef', path: { field: 'selected' } }])
    expect(getPluginConfigReferenceChoices(definition, definition.fields.selected as PluginConfigScalarField, {}, ctx)).toEqual({
      choices: [{ value: 'native', title: 'native' }, { value: 'Remote', title: 'Shared (Remote)' }, { value: 'remote', title: 'Shared (remote)' }], issues: [],
    })
  })

  it('fails complete validation without dependency definitions or a direct dependency', () => {
    const definition = consumer()
    expect(validatePluginConfigCandidate(definition, { selected: 'native' })).toMatchObject([{ code: 'valueRefContext', path: { field: 'selected' } }])
    const missing = { ...context(), plugins: {} }
    expect(() => assertPluginConfigReferenceSchemas(definition, missing)).toThrow('valueRefContext')
    expect(getPluginConfigReferenceChoices(definition, definition.fields.selected as PluginConfigScalarField, {}, missing))
      .toMatchObject({ choices: [], issues: [{ code: 'valueRefContext' }] })
    expect(() => assertPluginConfigReferenceSchemas(definition, { ...context(), dependencies: [] })).toThrow('direct dependency')
  })

  it('checks local defaults when the same object also contains a foreign reference', () => {
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      registry,
      selected: { type: 'object', default: { local: 'missing', external: 'native' }, properties: {
        local: { type: 'string', valueRef: { field: 'registry', key: 'key' } },
        external: { type: 'string', valueRef: reference },
      } },
    } })).toThrow('default')
  })

  it('associates unused source definitions without publishing them in compiled config', () => {
    for (const extra of [{ field: 'missing' }, { key: 'missing' }]) {
      const raw = { ...consumerConfig, definitions: {
        unused: { type: 'string', valueRef: { ...reference, ...extra } },
      } }
      const definition = normalizePluginConfigDefinition(raw)
      expect(definition).not.toHaveProperty('definitions')
      expect(() => assertPluginConfigReferenceSchemas(definition, context(), raw)).toThrow('valueRefSchema')
    }
  })

  it('offers choices before a required consumer scalar is selected', () => {
    const definition = consumer()
    const scalar = { ...definition.fields.selected as PluginConfigScalarField, required: true }
    expect(getPluginConfigReferenceChoices(definition, scalar, {}, context()).choices.map(choice => choice.value))
      .toEqual(['native', 'Remote', 'remote'])
  })

  it('rejects invalid provider schemas and preserves scalar and sensitive constraints', () => {
    for (const source of [
      { type: 'string' },
      { ...registry, validation: { uniqueBy: 'title' } },
      { ...registry, items: { type: 'object', properties: { key: { type: 'number' } } } },
      { ...registry, items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'array', items: { type: 'string' } } } } },
    ]) {
      const ctx = context()
      ctx.plugins = { provider: { definition: { schemaVersion: 4, fields: { registry: source } } as never, dependencies: [] } }
      expect(() => assertPluginConfigReferenceSchemas(consumer(), ctx)).toThrow('valueRefSchema')
    }
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      selected: { type: 'string', sensitive: true, valueRef: reference },
    } })).toThrow('sensitive')
    expect(() => normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      selected: { type: 'string', valueRef: { ...reference, include: [false] } },
    } })).toThrow('include')
    const definition = consumer()
    const scalar: PluginConfigScalarField = { ...definition.fields.selected as PluginConfigScalarField, type: 'string', const: 'Remote' }
    expect(getPluginConfigReferenceChoices(definition, scalar, {}, context()).choices).toEqual([{ value: 'Remote', title: 'Shared (Remote)' }])
  })

  it.each([
    { registry: [{ key: 'remote' }, {}] },
    { registry: [{ key: 'remote' }, { key: 'remote' }] },
    { registry: [{ key: 'native' }] },
  ])('returns no partial choices for a bad complete provider value: %j', values => {
    const definition = consumer()
    const ctx = context(values)
    const result = getPluginConfigReferenceChoices(definition, definition.fields.selected as PluginConfigScalarField, {}, ctx)
    expect(result.choices).toEqual([])
    expect(result.issues.some(issue => issue.path.plugin === 'provider')).toBe(true)
    expect(validatePluginConfigCandidate(definition, { selected: 'native' }, ['selected'], ctx).length).toBeGreaterThan(0)
  })

  it('rejects circular reference closure across plugin and field identities', () => {
    const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      ...consumerConfig.fields,
      registry: { ...registry, items: { type: 'object', properties: {
        key: { type: 'string', required: true, valueRef: { plugin: 'provider', field: 'registry', key: 'key' } },
      } } },
    } })
    const ctx = context()
    ctx.plugins = { provider: { dependencies: ['consumer'], definition: normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      registry: { ...registry, items: { type: 'object', properties: {
        key: { type: 'string', required: true, valueRef: { plugin: 'consumer', field: 'registry', key: 'key' } },
        title: { type: 'string' },
      } } },
    } }), values: { registry: [] } } }
    expect(() => getPluginConfigDependencyFields(definition, ['selected'], ctx)).toThrow('valueRefCycle')
  })

  // Runtime validation may consume dependency values, but its snapshot must retain only allowed local keys.
  it('does not expose provider data in installed runtime config', () => {
    const snapshot = createRuntimeConfigSnapshot({
      definition: consumer(), values: { selected: 'remote' }, referenceContext: context(),
      declaration: { keys: ['selected'] }, installedIdentity: {
        sourceId: 'example', sourceIdentity: 'identity', pluginId: 'example/consumer', pluginName: 'consumer',
        pluginVersion: '1.0.0', platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'skill', skillKey: 'skill',
      },
    })
    expect(snapshot.allowedKeys).toEqual(['selected'])
    expect(snapshot.effectiveValues).toEqual({ selected: 'remote' })
  })

  // Catalog build is a complete author boundary and must stop before any adapter runs for invalid associations.
  it('requires same-workspace provider association before catalog build', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cross-plugin-'))
    try {
      await initializeCatalogWorkspace({ workspaceRoot: root })
      for (const [name, manifest] of [
        ['consumer', sourceManifest()],
        ['provider', { ...sourceManifest({ schemaVersion: 4, fields: { registry: { type: 'string' } } }), name: 'provider', dependencies: [] }],
      ] as const) {
        const directory = path.join(root, 'plugins', name)
        await fs.outputJson(path.join(directory, '.agents-plugin/plugin.json'), manifest)
        await fs.outputJson(path.join(directory, '.mcp.json'), { mcpServers: {} })
      }
      let built = false
      await expect(buildCatalogWorkspace({ workspaceRoot: root, adapter: { build: async () => { built = true } } }))
        .rejects.toThrow('valueRefSchema')
      expect(built).toBe(false)
    } finally {
      await fs.remove(root)
    }
  })

  it.each([
    { ...consumerConfig, fields: { ...consumerConfig.fields, selected: { ...consumerConfig.fields.selected, default: 'missing' } } },
    { ...consumerConfig, definitions: { unused: { type: 'string', valueRef: { ...reference, field: 'missing' } } } },
  ])('rejects invalid source defaults and unused associations before a catalog adapter runs', async config => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cross-plugin-source-'))
    try {
      await initializeCatalogWorkspace({ workspaceRoot: root })
      for (const [name, manifest] of [
        ['consumer', sourceManifest(config)],
        ['provider', { ...sourceManifest({ schemaVersion: 4, fields: { registry } }), name: 'provider', dependencies: [] }],
      ] as const) {
        const directory = path.join(root, 'plugins', name)
        await fs.outputJson(path.join(directory, '.agents-plugin/plugin.json'), manifest)
        await fs.outputJson(path.join(directory, '.mcp.json'), { mcpServers: {} })
      }
      let built = false
      await expect(buildCatalogWorkspace({ workspaceRoot: root, adapter: { build: async () => { built = true } } }))
        .rejects.toThrow(/valueRefDefault|valueRefSchema/u)
      expect(built).toBe(false)
    } finally {
      await fs.remove(root)
    }
  })
})
