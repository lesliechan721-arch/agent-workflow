import { describe, expect, it } from 'vitest'

import {
  assertPluginConfigSuggestionProviders,
  assertPluginManifestStructure,
  deriveAwCapabilitiesFromManifest,
  validatePluginManifest,
} from '../../src/manifest.js'
import { selectPluginConfigProfile, validatePluginConfigCandidate } from '../../src/plugin-config.js'

const rootDir = '/tmp/config-suggestions'
const manifestPath = `${rootDir}/.agents-plugin/plugin.json`
const manifest = (name: string, fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 4, name, version: '1.0.0', description: 'Suggestion fixture',
  marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
  config: { schemaVersion: 5, fields },
  ...extra,
})
const scripts = { config: { suggestions: { runner: 'node', path: './scripts/suggestions.mjs', timeoutMs: 1000 } } }
const freeString = { type: 'string', choices: { allowCustom: true, presets: [{ id: 'local', title: 'Local', value: 'local' }] } }
const model = { ...freeString, suggestions: { provider: 'executor-models', dependsOn: ['executor'] } }
const view = (raw: unknown) => ({
  rootDir, manifestPath, manifest: validatePluginManifest(rootDir, raw),
})

describe('Config v5 dynamic suggestion declarations', () => {
  it('retains declarations in nested items and variant cases without narrowing valid config values', () => {
    const provider = view(manifest('suggestion-provider', {}, { scripts }))
    const consumer = view(manifest('consumer', {
      runtime: { type: 'object', properties: { executor: { type: 'string' } },
        variants: { discriminator: 'executor', cases: { local: { properties: {
          model: { ...model, suggestions: { ...model.suggestions, plugin: 'suggestion-provider' } },
        } } } } },
      commands: { type: 'array', items: { type: 'object', properties: { models: {
        type: 'array', items: { type: 'object', properties: { model, executor: { type: 'string' } } },
      } } } },
    }, { scripts, dependencies: ['suggestion-provider'] }))
    assertPluginConfigSuggestionProviders(consumer.manifest, [consumer, provider])
    expect(deriveAwCapabilitiesFromManifest(provider.manifest)).toContain('aw.plugin-config-suggestions.v2')
    expect(deriveAwCapabilitiesFromManifest(consumer.manifest)).toContain('aw.plugin-config-suggestions.v2')
    const config = selectPluginConfigProfile(consumer.manifest.config!)
    expect(config.fields.commands).toMatchObject({ items: { properties: { models: { items: { properties: {
      model: { suggestions: { provider: 'executor-models', dependsOn: ['executor'] } },
    } } } } } })
    expect(validatePluginConfigCandidate(config, {
      runtime: { executor: 'local', model: 'manual-input' },
      commands: [{ models: [{ executor: 'another', model: 'manual-input' }] }],
    })).toEqual([])
  })

  it('checks the canonical provider in a separate phase, even when the provider has no configuration', () => {
    const fields = { model: { ...freeString, suggestions: { provider: 'models', plugin: 'suggestion-provider' } } }
    const consumer = view(manifest('consumer', fields, { dependencies: ['suggestion-provider'] }))
    const missing = view(manifest('suggestion-provider', {}))
    expect(() => assertPluginConfigSuggestionProviders(consumer.manifest, [consumer, missing]))
      .toThrow(/same-source dependency "suggestion-provider"/u)
    const provider = view(manifest('suggestion-provider', {}, { scripts, config: undefined }))
    expect(() => assertPluginConfigSuggestionProviders(consumer.manifest, [consumer, provider])).not.toThrow()
    expect(deriveAwCapabilitiesFromManifest(consumer.manifest)).toContain('aw.plugin-config-suggestions.v2')
  })

  it('rejects invalid scalar placements, dependencies and provider declarations during manifest validation', () => {
    const top = { type: 'string', suggestions: { provider: 'models' } }
    const object = (field: Record<string, unknown>) => ({ type: 'object', properties: { model: field, executor: { type: 'string' } } })
    const invalid = [
      manifest('consumer', { model: top }),
      manifest('consumer', { model: { ...top, suggestions: { ...top.suggestions, plugin: 'unbound' } } }, { scripts }),
      manifest('consumer', { model: { ...top, sensitive: true } }, { scripts }),
      manifest('consumer', { model: { ...top, const: 'model' } }, { scripts }),
      manifest('consumer', { model: { ...top, valueRef: { field: 'models', key: 'id' } } }, { scripts }),
      manifest('consumer', { model: { ...top, choices: { allowCustom: false, presets: [{ id: 'one', title: 'One', value: 'one' }] } } }, { scripts }),
      manifest('consumer', { model: { ...top, suggestions: { provider: 'Model' } } }, { scripts }),
      manifest('consumer', { model }, { scripts }),
      manifest('consumer', { runtime: object({ ...model, suggestions: { ...model.suggestions, dependsOn: ['missing'] } }) }, { scripts }),
      manifest('consumer', { runtime: object({ ...model, suggestions: { ...model.suggestions, dependsOn: ['executor', 'executor'] } }) }, { scripts }),
      manifest('consumer', { runtime: { type: 'array', items: top } }, { scripts }),
      manifest('consumer', { runtime: { type: 'object', additionalProperties: top } }, { scripts }),
      manifest('consumer', {}, { config: { schemaVersion: 4, fields: { model: top } }, scripts }),
    ]
    for (const input of invalid) expect(() => view(input)).toThrow()
  })

  it('accepts the published Node entry bounds and rejects unsafe declarations', () => {
    expect(() => assertPluginManifestStructure(manifest('provider', {}, { scripts }))).not.toThrow()
    for (const override of [{ runner: 'bash' }, { timeoutMs: 999 }, { timeoutMs: 30001 }, { args: [] }]) {
      expect(() => assertPluginManifestStructure(manifest('provider', {}, {
        scripts: { config: { suggestions: { ...scripts.config.suggestions, ...override } } },
      }))).toThrow()
    }
    for (const entryPath of ['../suggestions.mjs', './node_modules/suggestions.mjs', './.git/suggestions.mjs', './suggestions.sh']) {
      expect(() => view(manifest('provider', {}, {
        scripts: { config: { suggestions: { ...scripts.config.suggestions, path: entryPath } } },
      }))).toThrow()
    }
  })
})
