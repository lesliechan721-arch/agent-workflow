import { normalizePluginConfigDefinition, type PluginMeta } from '@lesliechan721/aw-plugin-core'
import { describe, expect, it } from 'vitest'
import {
  normalizeReviewProfileConfig,
  parseReviewProfile,
  resolveReviewPluginProfileConfig,
} from '../../src/review/review-profile.js'
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js'

const plugin: PluginMeta = {
  rootDir: '/tmp/review-profile', manifestPath: '/tmp/review-profile/.agents-plugin/plugin.json',
  manifest: {
    schemaVersion: 4, name: 'review-profile', version: '1.0.0', description: 'Profile test',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
      sources: { type: 'array', default: [], validation: { uniqueBy: 'id' }, items: {
        type: 'object', properties: { id: { type: 'string', required: true }, location: { type: 'string', required: true } }, additionalProperties: false,
      } },
      selected: { type: 'string', valueRef: { field: 'sources', key: 'id' } },
      hidden: { type: 'string', sensitive: true },
    } }),
  },
}

describe('Review profile reference validation', () => {
  it('uses only supplied dependency definitions, defaults, and overrides and binds their interpretation', () => {
    const provider: PluginMeta = {
      ...plugin,
      manifest: { ...plugin.manifest, name: 'provider', config: normalizePluginConfigDefinition({
        schemaVersion: 4, fields: {
          sources: { type: 'array', default: [], validation: { uniqueBy: 'id' }, items: {
            type: 'object', properties: { id: { type: 'string', required: true }, location: { type: 'string', required: true } },
            additionalProperties: false,
          } },
        },
      }) },
    }
    const consumer: PluginMeta = { ...plugin, manifest: { ...plugin.manifest, dependencies: ['provider'],
      config: normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
        selected: { type: 'string', default: 'native', valueRef: {
          plugin: 'provider', field: 'sources', key: 'id', include: ['native'],
        } },
      } }, 'config', { plugin: plugin.manifest.name, dependencies: ['provider'] }),
    } }
    const resolve = (config: Parameters<typeof resolveReviewPluginProfileConfig>[0]['config'],
      source: PluginMeta = provider) => resolveReviewPluginProfileConfig({ plugin: consumer,
      plugins: [consumer, source], scope: 'project', keys: ['selected'], config })
    expect(resolve({}).values).toEqual({ selected: 'native' })
    expect(() => resolve({ 'review-profile': { selected: 'remote' } })).toThrow(/dependency config/u)
    expect(() => resolveReviewPluginProfileConfig({ plugin: consumer, scope: 'user', keys: ['selected'], config: {} }))
      .toThrow(/provider/u)
    const config = { 'review-profile': { selected: 'remote' }, provider: { sources: [{ id: 'remote', location: '/one' }] } }
    const resolved = resolve(config)
    expect(resolved.values).toEqual({ selected: 'remote' })
    const changed = resolve({ ...config, provider: { sources: [{ id: 'remote', location: '/two' }] } })
    expect(changed.digest).not.toBe(resolved.digest)
    const changedDefault = structuredClone(provider)
    changedDefault.manifest.config!.fields.sources!.default = [{ id: 'default', location: '/default' }]
    expect(resolve({}, changedDefault).digest).not.toBe(resolve({}).digest)
    const changedDefinition = structuredClone(provider)
    changedDefinition.manifest.config!.fields.sources!.description = 'Changed provider contract.'
    expect(resolve({}, changedDefinition).digest).not.toBe(resolve({}).digest)
  })

  it('accepts v4 leaf containers through profile parsing and validates the selected variant', () => {
    const v4Plugin: PluginMeta = {
      ...plugin,
      manifest: { ...plugin.manifest, config: createConfigV4Definition() },
    }
    const rawConfig = { 'review-profile': {
      subagentCommands: [{ key: 'oracle', title: 'Oracle', adapter: 'oracle',
        args: ['--model', 'example'], env: { Z: 'last', A: 'first' }, envFrom: { TOKEN: 'HOST_TOKEN' } }],
      advisorProfile: { executor: 'oracle' },
    } }
    const config = normalizeReviewProfileConfig(rawConfig)
    const profile = parseReviewProfile({ kind: 'review', id: 'codex-user', platform: 'codex',
      scope: 'user', requestedSkills: [], inputDigest: `sha256:${'a'.repeat(64)}`, config })
    const resolved = resolveReviewPluginProfileConfig({ plugin: v4Plugin, scope: 'user',
      keys: ['advisorProfile'], config: profile.config })
    expect(resolved.values).toEqual({ advisorProfile: { executor: 'oracle' } })
    expect(resolved.overrides).toEqual(rawConfig['review-profile'])
    expect(profile.config).toEqual(rawConfig)
    expect(() => resolveReviewPluginProfileConfig({ plugin: v4Plugin, scope: 'user',
      config: normalizeReviewProfileConfig({ 'review-profile': { ...rawConfig['review-profile'],
        subagentCommands: [{ ...rawConfig['review-profile'].subagentCommands[0], mode: 'workspace' }],
      } }) })).toThrow(/mode/u)
  })

  it.each([
    { args: [['nested']] },
    { args: ['mixed', true] },
    { envFrom: { TOKEN: { nested: 'HOST_TOKEN' } } },
    { env: JSON.parse('{"constructor":"unsafe"}') as unknown },
  ])('rejects containers outside the finite v4 shape: %j', (properties) => {
    expect(() => normalizeReviewProfileConfig({ 'review-profile': {
      subagentCommands: [{ key: 'oracle', ...properties }],
    } })).toThrow(/invalid (array|object) value/u)
  })

  it('rejects a sparse leaf array even when it has an extra own property', () => {
    const args = Object.assign(new Array<string>(2), { 1: 'value', extra: 'value' })
    expect(() => normalizeReviewProfileConfig({ 'review-profile': {
      subagentCommands: [{ key: 'oracle', args }],
    } })).toThrow(/invalid array value/u)
  })

  it('checks complete dependency sources without exposing them in selected values and binds their effective interpretation', () => {
    const config = { 'review-profile': { sources: [{ id: 'remote', location: '/first' }], selected: 'remote' } }
    const resolved = resolveReviewPluginProfileConfig({ plugin, scope: 'user', keys: ['selected'], config })
    expect(resolved.values).toEqual({ selected: 'remote' })
    expect(resolved.sources).toEqual({ selected: 'common' })
    // Keep the dependency override for isolated prepare and binding replay.
    expect(resolved.overrides).toEqual(config['review-profile'])
    const changed = resolveReviewPluginProfileConfig({ plugin, scope: 'user', keys: ['selected'],
      config: { 'review-profile': { ...config['review-profile'], sources: [{ id: 'remote', location: '/second' }] } } })
    expect(changed.values).toEqual(resolved.values)
    expect(changed.digest).not.toBe(resolved.digest)
    expect(() => resolveReviewPluginProfileConfig({ plugin, scope: 'user', keys: ['selected'],
      config: { 'review-profile': { ...config['review-profile'], sources: [] } } })).toThrow(/sources/u)
    expect(() => resolveReviewPluginProfileConfig({ plugin, scope: 'user', keys: ['selected'],
      config: { 'review-profile': { ...config['review-profile'], sources: [{ id: 'remote', location: '/first' }, { id: 'other' }] } } })).toThrow(/location/u)
  })
})
