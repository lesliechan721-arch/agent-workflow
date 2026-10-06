import { normalizePluginConfigDefinition, type PluginMeta } from '@lesliechan721/aw-plugin-core'
import { describe, expect, it } from 'vitest'
import { resolveReviewPluginProfileConfig } from '../../src/review/review-profile.js'

const plugin: PluginMeta = {
  rootDir: '/tmp/review-profile', manifestPath: '/tmp/review-profile/.agents-plugin/plugin.json',
  manifest: {
    schemaVersion: 3, name: 'review-profile', version: '1.0.0', description: 'Profile test',
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
  it('checks complete dependency sources without exposing them in selected values and binds their effective interpretation', () => {
    const config = { 'review-profile': { sources: [{ id: 'remote', location: '/first' }], selected: 'remote' } }
    const resolved = resolveReviewPluginProfileConfig({ plugin, scope: 'user', keys: ['selected'], config })
    expect(resolved.values).toEqual({ selected: 'remote' })
    expect(resolved.sources).toEqual({ selected: 'user' })
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
