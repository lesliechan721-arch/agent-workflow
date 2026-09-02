import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  getPluginAuthoringAcceptedValues,
  getPluginAuthoringCapabilities,
  getPluginAuthoringCapabilitySurface,
  PLUGIN_AUTHORING_CAPABILITY_SURFACES,
} from '../../src/plugin-authoring-capabilities.js'
import {
  PLUGIN_SCRIPT_TIMEOUT_MAX_MS,
  PLUGIN_SCRIPT_TIMEOUT_MIN_MS,
} from '../../src/plugin-script-contract.js'
import { PUBLIC_HOOK_EVENTS } from '../../src/hooks-contract.js'

describe('plugin authoring capability structure registry', () => {
  it('publishes the fixed public surfaces with stable field identity', () => {
    const registry = getPluginAuthoringCapabilities()
    expect(registry.schemaVersion).toBe(1)
    expect(Object.keys(registry.surfaces)).toEqual(PLUGIN_AUTHORING_CAPABILITY_SURFACES)
    for (const surface of PLUGIN_AUTHORING_CAPABILITY_SURFACES) {
      expect(getPluginAuthoringCapabilitySurface(surface)).toBe(registry.surfaces[surface])
      expect(new Set(registry.surfaces[surface].entries.map((entry) => entry.field)).size)
        .toBe(registry.surfaces[surface].entries.length)
    }
  })

  it('keeps accepted values equal to the public manifest schema', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
    const schema = JSON.parse(await fs.readFile(
      path.join(root, 'schemas', 'plugin-manifest-v3.json'),
      'utf8',
    ))
    expect(getPluginAuthoringAcceptedValues('manifest', 'marketplace.policy.installation'))
      .toEqual(schema.$defs.marketplace.properties.policy.properties.installation.enum)
    expect(getPluginAuthoringAcceptedValues('manifest', 'marketplace.policy.authentication'))
      .toEqual(schema.$defs.marketplace.properties.policy.properties.authentication.enum)
    expect(getPluginAuthoringAcceptedValues('config', 'config.fields.<key>.type'))
      .toEqual(schema.$defs.configField.oneOf.map((entry: { $ref: string }) => {
        const definition = entry.$ref.split('/').at(-1)!
        return schema.$defs[definition].properties.type.const
      }))
    expect(getPluginAuthoringAcceptedValues('config', 'config.fields.<key>.validation.format'))
      .toEqual(schema.$defs.configStringValidation.properties.format.enum)
    expect(getPluginAuthoringAcceptedValues('config', 'config.fields.<key>.writableLayers'))
      .toEqual(schema.$defs.configWritableLayers.items.enum)
    expect(getPluginAuthoringAcceptedValues('build-config', 'buildConfig.skillRuntimeFiles[].platforms'))
      .toEqual(schema.$defs.buildConfig.properties.skillRuntimeFiles.items.properties.platforms.items.enum)
    expect(getPluginAuthoringAcceptedValues('build-config', 'buildConfig.skillRuntimeFiles[].distributions'))
      .toEqual([schema.$defs.buildConfig.properties.skillRuntimeFiles.items.properties.distributions.items.const])
    expect([...getPluginAuthoringAcceptedValues('artifacts', 'artifacts.targets[].target')].sort())
      .toEqual(schema.$defs.artifactTarget.oneOf.flatMap(
        (entry: { properties: { target: { const?: string; enum?: string[] } } }) =>
          entry.properties.target.enum ?? [entry.properties.target.const!],
      ).sort())
    expect(getPluginAuthoringAcceptedValues('artifacts', 'artifacts.targets[].scopes'))
      .toEqual(schema.$defs.artifactTarget.oneOf[0].properties.scopes.items.enum)
    expect(getPluginAuthoringAcceptedValues('artifacts', 'artifacts.targets[].states'))
      .toEqual(schema.$defs.artifactTarget.oneOf[0].properties.states.items.enum)
    expect(getPluginAuthoringAcceptedValues('artifacts', 'artifacts.targets[].delivery.mode'))
      .toEqual(schema.$defs.codexSkillDelivery.oneOf.map(
        (entry: { properties: { mode: { const: string } } }) => entry.properties.mode.const,
      ))
  })

  it('publishes postApply timeout and hook values from their Core contracts', () => {
    expect(getPluginAuthoringAcceptedValues('extensions', 'extensions.hooks[].event'))
      .toEqual(PUBLIC_HOOK_EVENTS)
    expect(getPluginAuthoringCapabilitySurface('post-apply').entries)
      .toContainEqual(expect.objectContaining({
        field: 'scripts.postApply.timeoutMs',
        acceptedValues: `${PLUGIN_SCRIPT_TIMEOUT_MIN_MS}..${PLUGIN_SCRIPT_TIMEOUT_MAX_MS}`,
      }))
  })

  it('publishes required nested artifact identity fields', () => {
    expect(getPluginAuthoringCapabilitySurface('artifacts').entries)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          field: 'rendererContext.requestedArtifactIds',
          type: 'non-empty unique artifact id[]',
          required: true,
        }),
        expect.objectContaining({ field: 'artifacts.targets[].id', required: true }),
        expect.objectContaining({ field: 'artifacts.targets[].refreshKeys', required: true }),
        expect.objectContaining({ field: 'artifacts.targets[].delivery', required: 'for codex.skill' }),
        {
          field: 'artifacts.targets[].delivery.identity',
          type: 'literal shared',
          required: 'when delivery.mode is codex-native',
          acceptedValues: ['shared'],
        },
        {
          field: 'artifacts.targets[].delivery.renderProfile',
          type: 'literal user',
          required: 'when delivery.mode is codex-native',
          acceptedValues: ['user'],
        },
        expect.objectContaining({ field: 'artifacts.targets[].skillKey', required: 'for Skill targets' }),
      ]))
  })

  it('publishes required runtime export capability metadata', () => {
    expect(getPluginAuthoringCapabilitySurface('build-config').entries)
      .toContainEqual(expect.objectContaining({
        field: 'buildConfig.runtimeExports[].requires.aw.capabilities',
        type: 'unique AW capability ID[]',
        required: true,
      }))
  })
})
