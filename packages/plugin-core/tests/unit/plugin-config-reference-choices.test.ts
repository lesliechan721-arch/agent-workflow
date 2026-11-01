import { describe, expect, it } from 'vitest'
import {
  getPluginConfigReferenceChoices,
  normalizePluginConfigDefinition,
  validatePluginConfigCandidate,
  type PluginConfigScalarField,
} from '../../src/manifest.js'

const definition = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
  providers: { type: 'array', default: [], validation: { uniqueBy: 'id' }, items: {
    type: 'object', properties: { id: { type: 'string', required: true } },
  } },
  backends: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
    type: 'object', properties: {
      key: { type: 'string', required: true },
      caption: { type: 'string' },
      provider: { type: 'string', valueRef: { field: 'providers', key: 'id', include: ['local'] } },
    },
  } },
  selected: { type: 'string', valueRef: { field: 'backends', key: 'key', label: 'caption', include: ['native'] } },
} })
const scalar = definition.fields.selected as PluginConfigScalarField

describe('Reference choice projection for config editors', () => {
  it('offers included values then source keys in order, retaining identity for duplicate labels', () => {
    expect(getPluginConfigReferenceChoices(definition, scalar, { backends: [
      { key: 'Remote', caption: 'Shared' }, { key: 'remote', caption: 'Shared' }, { key: 'other' },
    ] })).toEqual({ choices: [
      { value: 'native', title: 'native' },
      { value: 'Remote', title: 'Shared (Remote)' },
      { value: 'remote', title: 'Shared (remote)' },
      { value: 'other', title: 'other' },
    ], issues: [] })
  })

  it('keeps valid empty references empty and preserves included values without a source', () => {
    expect(getPluginConfigReferenceChoices(definition, scalar, {})).toEqual({
      choices: [{ value: 'native', title: 'native' }], issues: [],
    })
    const noInclude: PluginConfigScalarField = { type: 'string', valueRef: { field: 'backends', key: 'key' } }
    expect(getPluginConfigReferenceChoices(definition, noInclude, { backends: [] })).toEqual({ choices: [], issues: [] })
  })

  it.each([
    { backends: [{ key: 'a' }, {}] },
    { backends: [{ key: 'a' }, { key: 'a' }] },
    { backends: [{ key: 'native' }] },
    { backends: [{ key: 'a', provider: 'missing' }], providers: [] },
  ])('does not offer partial choices from an invalid source or dependency: %j', (values) => {
    const result = getPluginConfigReferenceChoices(definition, scalar, values)
    expect(result.choices).toEqual([])
    expect(result.issues.length).toBeGreaterThan(0)
  })

  it('intersects source values with scalar constraints even when custom choices are allowed', () => {
    const constrained: PluginConfigScalarField = { ...scalar, type: 'string', validation: { minLength: 2 },
      choices: { allowCustom: false, presets: [
        { id: 'remote', title: 'Remote', value: 'remote' }, { id: 'unregistered', title: 'Unknown', value: 'unregistered' },
      ] } }
    const values = { backends: [{ key: 'remote' }, { key: 'x' }, { key: 'other' }] }
    expect(getPluginConfigReferenceChoices(definition, constrained, values).choices).toEqual([{ value: 'remote', title: 'remote' }])
    const open = { ...constrained, choices: { ...constrained.choices!, allowCustom: true }, const: 'other' }
    expect(getPluginConfigReferenceChoices(definition, open, values).choices).toEqual([{ value: 'other', title: 'other' }])
  })

  it('rejects source reservations from another reference without propagating unrelated errors', () => {
    // A selector must not offer keys that the writer rejects through a sibling reference.
    const config = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      registry: { type: 'array', validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: { key: { type: 'string', required: true } },
      } },
      one: { type: 'string', valueRef: { field: 'registry', key: 'key', include: ['native'] } },
      two: { type: 'string', valueRef: { field: 'registry', key: 'key', include: ['none'] } },
      unrelated: { type: 'string', required: true },
    } })
    const values = { registry: [{ key: 'native' }] }
    const result = getPluginConfigReferenceChoices(config, config.fields.two as PluginConfigScalarField, values)
    expect(result.choices).toEqual([])
    expect(result.issues).toEqual(validatePluginConfigCandidate(config, values)
      .filter((issue) => issue.path.field === 'registry'))
    expect(result.issues).toEqual([expect.objectContaining({ code: 'valueRefReserved' })])
    expect(getPluginConfigReferenceChoices(config, config.fields.two as PluginConfigScalarField,
      { registry: [{ key: 'remote' }] })).toEqual({ choices: [
      { value: 'none', title: 'none' }, { value: 'remote', title: 'remote' },
    ], issues: [] })
  })

  it('retains boolean and number values without coercion', () => {
    for (const [type, included, stored] of [['boolean', false, true], ['number', 0, 2]] as const) {
      const config = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
        registry: { type: 'array', validation: { uniqueBy: 'id' }, items: {
          type: 'object', properties: { id: { type, required: true } },
        } },
        value: { type, valueRef: { field: 'registry', key: 'id', include: [included] } },
      } })
      expect(getPluginConfigReferenceChoices(config, config.fields.value as PluginConfigScalarField,
        { registry: [{ id: stored }] }).choices).toEqual([
        { value: included, title: String(included) }, { value: stored, title: String(stored) },
      ])
    }
  })
})
