import { describe, expect, it } from 'vitest'

import {
  assertPluginConfigReferenceSchemas,
  compilePluginConfigDefinition,
  getPluginConfigReferenceChoices,
  normalizePluginConfigDefinition,
  selectPluginConfigProfile,
  validatePluginConfigCandidate,
} from '../../src/plugin-config.js'
import type { PluginConfigReferenceContext, PluginConfigScalarField } from '../../src/types.js'
import { createBundleSourceManifest, deriveAwCapabilitiesFromManifest, validatePluginManifest } from '../../src/manifest.js'
import { PLATFORM_TARGETS } from '../../src/platform-support.js'

const ref = (name: string) => ({ $ref: `#/config/definitions/${name}` })

describe('Config platform profiles', () => {
  // Platform defaults must use the replacement definition before any reference is expanded.
  it('compiles whole definitions, fields and presentation before expanding references and survives a bundle round trip', () => {
    const source = {
      schemaVersion: 5,
      definitions: {
        model: { type: 'string' },
        profile: { type: 'object', properties: { model: ref('model'), commonOnly: { type: 'boolean' } } },
      },
      fields: { profile: { ...ref('profile'), default: { model: 'common' } }, retries: { type: 'number', default: 4 } },
      presentation: { groups: [{ id: 'main', title: 'Main', fields: ['profile', 'retries'] }] },
      platforms: {
        codex: {
          definitions: {
            model: { type: 'string', choices: { allowCustom: false, presets: [{ id: 'codex', title: 'Codex', value: 'codex-model' }] } },
            profile: { type: 'object', properties: { model: ref('model') } },
          },
          fields: { profile: { ...ref('profile'), default: { model: 'codex-model' } }, retries: { type: 'boolean' } },
          presentation: {},
        },
        cursor: { fields: { cursorOnly: { type: 'boolean', default: false } } },
      },
    }
    const normalized = normalizePluginConfigDefinition(source)
    const codex = compilePluginConfigDefinition(normalized, 'codex')
    expect(codex.schemaVersion).toBe(4)
    expect(codex.fields.profile).toMatchObject({ default: { model: 'codex-model' }, properties: { model: { choices: { allowCustom: false } } } })
    expect(codex.fields.profile?.type === 'object' ? codex.fields.profile.properties?.commonOnly : null).toBeUndefined()
    expect(codex.fields.retries).toEqual({ type: 'boolean' })
    expect(codex.presentation?.groups).toBeUndefined()
    expect(compilePluginConfigDefinition(normalized).fields.profile?.default).toEqual({ model: 'common' })
    expect(compilePluginConfigDefinition(normalized, 'cursor').fields.cursorOnly?.default).toBe(false)
    expect(compilePluginConfigDefinition(normalized, 'generic').fields.cursorOnly).toBeUndefined()
    for (const platform of [undefined, ...PLATFORM_TARGETS]) {
      expect(selectPluginConfigProfile(normalized, platform)).toEqual(compilePluginConfigDefinition(normalized, platform))
    }
    const manifest = validatePluginManifest('/tmp/platform-config', {
      schemaVersion: 3, name: 'platform-config', version: '1.0.0', description: 'Example',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: source,
    })
    const bundle = createBundleSourceManifest({ rootDir: '/tmp/platform-config', manifestPath: '/tmp/platform-config/.agents-plugin/plugin.json', manifest })
    expect(deriveAwCapabilitiesFromManifest(bundle)).toContain('aw.plugin-config.v5')
    const bundled = validatePluginManifest('/tmp/platform-config', JSON.parse(JSON.stringify(bundle))).config!
    expect(bundled).toEqual(normalized)
    expect(compilePluginConfigDefinition(bundled, 'codex')).toEqual(codex)
  })

  it('selects current mutable normalized profiles without freezing or retaining an earlier selection', () => {
    const definition = normalizePluginConfigDefinition({ schemaVersion: 5,
      fields: { mode: { type: 'string', default: 'common' } },
      platforms: { codex: { fields: { mode: { type: 'string', default: 'codex' } } } },
    })
    expect(selectPluginConfigProfile(definition).fields).toBe(definition.fields)
    const profile = selectPluginConfigProfile(definition, 'codex')
    expect(profile.fields.mode?.default).toBe('codex')
    definition.fields = { mode: { type: 'string', title: 'Common mode', default: 'updated common' } }
    profile.fields.mode!.title = 'Codex mode'
    expect(selectPluginConfigProfile(definition, 'codex').fields.mode?.title).toBe('Codex mode')
    expect(selectPluginConfigProfile(definition, 'generic').fields.mode?.title).toBe('Common mode')
    expect(selectPluginConfigProfile(definition).fields.mode?.default).toBe('updated common')
    const compiled = compilePluginConfigDefinition(definition, 'codex')
    compiled.fields.mode!.title = 'Isolated compile'
    expect(selectPluginConfigProfile(definition, 'codex').fields.mode?.title).toBe('Codex mode')
    const legacy = normalizePluginConfigDefinition({ fields: { enabled: { type: 'boolean' } } })
    expect(selectPluginConfigProfile(legacy, 'codex')).toEqual(legacy)
    expect(() => selectPluginConfigProfile(definition, 'agent-skills' as never, 'plugin.config'))
      .toThrow('Invalid plugin.config.platform: unknown config platform.')
    expect(() => selectPluginConfigProfile(legacy, 'agent-skills' as never)).toThrow('config.platform')
  })

  // Invalid inactive profiles and unused definitions must fail at the definition boundary.
  it('rejects invalid declarations in every profile, including unused definitions and combined limits', () => {
    const base = { schemaVersion: 5, fields: {} }
    for (const branch of [
      { definitions: { unused: { type: 'number', default: 'invalid' } } },
      { definitions: { unused: ref('unused') } },
      { fields: JSON.parse('{"constructor":{"type":"string"}}') },
      { definitions: JSON.parse('{"__proto__":{"type":"string"}}') },
      { presentation: { groups: [{ id: 'missing', title: 'Missing', fields: ['absent'] }] } },
    ]) {
      const invalid = { ...base, platforms: { pi: branch } }
      expect(() => normalizePluginConfigDefinition(invalid)).toThrow()
      expect(() => compilePluginConfigDefinition(invalid, 'codex')).toThrow()
    }
    for (const invalid of [null, [], 1, { fields: { bad: { type: 'unknown' } } },
      { fields: { bad: { type: 'string', validation: { pattern: '(', maxLength: 10 } } } }]) {
      expect(() => compilePluginConfigDefinition(invalid, 'codex')).toThrow()
    }
    expect(() => normalizePluginConfigDefinition({ ...base, platforms: { unknown: {} } })).toThrow()
    expect(() => compilePluginConfigDefinition(base, 'agent-skills' as never)).toThrow()
    expect(() => normalizePluginConfigDefinition({ ...base, platforms: JSON.parse('{"__proto__":{}}') })).toThrow()
    const definitions = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`d${index}`, { type: 'string' }]))
    expect(() => normalizePluginConfigDefinition({ ...base, definitions, platforms: { pi: { definitions: { overflow: { type: 'string' } } } } })).toThrow('64')
  })

  // A platform override must not turn a saved secret into a renderable ordinary field.
  it('preserves common sensitive protection through direct and referenced replacements', () => {
    const source = { schemaVersion: 5, definitions: { secret: { type: 'string', sensitive: true } }, fields: { token: ref('secret') } }
    for (const replacement of [{ type: 'string' }, { type: 'string', sensitive: false }, { type: 'number' }]) {
      expect(() => normalizePluginConfigDefinition({ ...source, platforms: { codex: { fields: { token: replacement } } } })).toThrow('sensitive')
    }
    expect(() => normalizePluginConfigDefinition({ ...source, platforms: { codex: { definitions: { secret: { type: 'string' } } } } })).toThrow('sensitive')
    expect(compilePluginConfigDefinition({ ...source, platforms: { codex: { fields: { token: { type: 'string', sensitive: true, required: true } } } } }, 'codex').fields.token)
      .toMatchObject({ type: 'string', sensitive: true, required: true })
  })

  // Provider schemas and defaults must use the same canonical platform as their consumer.
  it('validates references with same-platform provider schemas and checks platform defaults', () => {
    const registry = (type: 'string' | 'number', key: string | number) => ({
      type: 'array', default: [{ key }], validation: { uniqueBy: 'key' },
      items: { type: 'object', properties: { key: { type } } },
    })
    const provider = normalizePluginConfigDefinition({ schemaVersion: 5,
      fields: { registry: registry('string', 'common') },
      platforms: { cursor: { fields: { registry: registry('number', 12) } } },
    })
    const valueRef = { plugin: 'provider', field: 'registry', key: 'key' }
    const source = { schemaVersion: 5, fields: { selected: { type: 'string', default: 'common', valueRef } },
      platforms: { cursor: { fields: { selected: { type: 'number', default: 12, valueRef } } } } }
    const consumer = normalizePluginConfigDefinition(source, 'config', { plugin: 'consumer', dependencies: ['provider'] })
    const context: PluginConfigReferenceContext = { plugin: 'consumer', dependencies: ['provider'], platform: 'cursor',
      plugins: { provider: { definition: provider, dependencies: [], values: { registry: [{ key: 12 }] } } } }
    expect(validatePluginConfigCandidate(consumer, { selected: 12 }, undefined, context)).toEqual([])
    expect(validatePluginConfigCandidate(consumer, { selected: 'common' }, undefined, context)).toMatchObject([{ code: 'type' }])
    const selected = compilePluginConfigDefinition(consumer, 'cursor').fields.selected as PluginConfigScalarField
    expect(getPluginConfigReferenceChoices(consumer, selected, {}, context)).toEqual({ choices: [{ value: 12, title: '12' }], issues: [] })
    expect(() => assertPluginConfigReferenceSchemas(consumer, { ...context, platform: undefined }, source)).not.toThrow()
    const invalid = { ...source, platforms: { cursor: { fields: { selected: { type: 'number', default: 99, valueRef } } } } }
    expect(() => assertPluginConfigReferenceSchemas(normalizePluginConfigDefinition(invalid), { ...context, platform: undefined }, invalid)).toThrow('valueRefDefault')
    const invalidUnused = { ...source, platforms: { cursor: { ...source.platforms.cursor,
      definitions: { unused: { type: 'number', default: 99, valueRef } },
    } } }
    expect(() => assertPluginConfigReferenceSchemas(normalizePluginConfigDefinition(invalidUnused), { ...context, platform: undefined }, invalidUnused)).toThrow('valueRefDefault')
  })
})
