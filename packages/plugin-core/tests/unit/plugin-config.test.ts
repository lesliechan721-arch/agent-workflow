import { describe, expect, it } from 'vitest'

import {
  formatPluginConfigIssue,
  matchPluginConfigPreset,
  normalizePluginConfigDefinition,
  redactPluginConfigValue,
  stablePluginConfigStringify,
  validatePluginConfigDocument,
  validatePluginConfigPreset,
  validatePluginConfigValue,
} from '../../src/plugin-config.js'

describe('Plugin Config v2 contract', () => {
  it('normalizes scalar fields, closed choices, defaults, and type-specific limits', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          default: 'safe',
          choices: {
            allowCustom: false,
            presets: [
              { id: 'safe', title: 'Safe', value: 'safe', recommended: true },
              { id: 'fast', title: 'Fast', value: 'fast' },
            ],
          },
          validation: { minLength: 4, maxLength: 8, pattern: '^[a-z]+$', format: 'slug' },
        },
        workers: {
          type: 'number',
          default: 4,
          validation: { integer: true, minimum: 2, maximum: 8, multipleOf: 2 },
        },
        trace: { type: 'boolean', default: false },
      },
    })

    expect(config.fields.mode).toMatchObject({ type: 'string', default: 'safe' })
    expect(validatePluginConfigDocument(config, {
      mode: 'fast',
      workers: 6,
      trace: true,
    })).toEqual([])
    expect(validatePluginConfigValue(config.fields.workers!, 3, 'workers').map((issue) => issue.code))
      .toEqual(['multipleOf'])
    expect(validatePluginConfigValue(config.fields.mode!, 'custom', 'mode').map((issue) => issue.code))
      .toEqual(['choice'])
  })

  it('rejects removed fields, arrays, null, nested objects, and boolean choices', () => {
    for (const field of [
      { type: 'enum', values: ['safe'] },
      { type: 'file' },
      { type: 'directory' },
      { type: 'string', recommendedValue: 'safe' },
      { type: 'boolean', choices: { allowCustom: false, presets: [] } },
    ]) {
      expect(() => normalizePluginConfigDefinition({ fields: { value: field } })).toThrow()
    }
    expect(() => normalizePluginConfigDefinition({ schema: {} })).toThrow(/unknown field "schema"/u)

    const config = normalizePluginConfigDefinition({
      fields: {
        metadata: {
          type: 'object',
          properties: { name: { type: 'string', required: true } },
          additionalProperties: { type: 'number' },
        },
      },
    })
    expect(validatePluginConfigValue(config.fields.metadata!, [], 'metadata')[0]?.code).toBe('type')
    expect(validatePluginConfigValue(config.fields.metadata!, null, 'metadata')[0]?.code).toBe('type')
    expect(validatePluginConfigValue(
      config.fields.metadata!,
      { name: { nested: true } },
      'metadata',
    )[0]?.path).toEqual({ field: 'metadata', property: 'name' })
  })

  it('validates fixed and dynamic object properties with structured property paths', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        labels: {
          type: 'object',
          properties: {
            owner: { type: 'string', required: true, validation: { format: 'identifier' } },
          },
          additionalProperties: { type: 'string', validation: { minLength: 2 } },
          validation: {
            minProperties: 2,
            maxProperties: 3,
            key: { format: 'identifier' },
          },
        },
      },
    })
    const issues = validatePluginConfigDocument(config, {
      labels: { 'bad-key': 'x' },
    })
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'required', path: { field: 'labels', property: 'owner' }, recoverable: true }),
      expect.objectContaining({ code: 'format', path: { field: 'labels', property: 'bad-key' }, recoverable: true }),
      expect.objectContaining({ code: 'minLength', path: { field: 'labels', property: 'bad-key' }, recoverable: true }),
      expect.objectContaining({ code: 'minProperties', path: { field: 'labels' }, recoverable: true }),
    ]))
    expect(formatPluginConfigIssue(issues[0]!)).toContain('labels')
    expect(normalizePluginConfigDefinition({
      fields: {
        labels: {
          type: 'object',
          properties: { 'display-name': { type: 'string' } },
        },
      },
    }).fields.labels).toMatchObject({ additionalProperties: false })
  })

  it('uses own properties for declared and dynamic special keys', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        constructor: { type: 'string' },
        fixed: {
          type: 'object',
          properties: Object.fromEntries([
            ['__proto__', { type: 'string', sensitive: true }],
            ['constructor', { type: 'number' }],
          ]),
        },
        dynamic: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      },
    })
    const fixed = Object.fromEntries([
      ['__proto__', 'private'],
      ['constructor', 2],
    ])
    const dynamic = Object.fromEntries([
      ['__proto__', 'prototype'],
      ['constructor', 'constructor'],
      ['toString', 'to-string'],
    ])

    expect(Object.getPrototypeOf(config.fields)).toBeNull()
    expect(Object.getPrototypeOf(config.fields.fixed!.properties)).toBeNull()
    expect(validatePluginConfigDocument(config, { constructor: 'declared', fixed, dynamic })).toEqual([])
    expect(redactPluginConfigValue(config.fields.fixed!, fixed)).toEqual(Object.assign(
      Object.create(null),
      { ['__proto__']: '[redacted]', constructor: 2 },
    ))
    expect(validatePluginConfigValue(
      config.fields.fixed!,
      { toString: 'not declared' },
      'fixed',
    )).toContainEqual(expect.objectContaining({
      code: 'additionalProperty',
      path: { field: 'fixed', property: 'toString' },
    }))
  })

  it.each([
    ['identifier', 'valid_Name', 'not-valid'],
    ['slug', 'valid-slug', 'Invalid Slug'],
    ['semver', '1.2.3-beta.1', '1.2'],
    ['url', 'https://example.com/path', 'example.com'],
    ['hostname', 'api.example.com', '-bad.example.com'],
    ['email', 'user@example.com', 'user@example'],
    ['path', './relative/path', ''],
  ] as const)('validates the %s string format', (format, valid, invalid) => {
    const config = normalizePluginConfigDefinition({
      fields: { value: { type: 'string', validation: { format } } },
    })
    expect(validatePluginConfigValue(config.fields.value!, valid, 'value')).toEqual([])
    expect(validatePluginConfigValue(config.fields.value!, invalid, 'value')[0]?.code).toBe('format')
  })

  it('matches actual preset values, canonicalizes objects, and redacts one object level', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        credentials: {
          type: 'object',
          choices: {
            allowCustom: false,
            presets: [{
              id: 'service',
              title: 'Service',
              value: { token: 'secret', region: 'west' },
              recommended: true,
            }],
          },
          properties: {
            token: { type: 'string', sensitive: true, required: true },
            region: { type: 'string', required: true },
          },
        },
      },
    })
    const field = config.fields.credentials!
    const value = { region: 'west', token: 'secret' }
    expect(stablePluginConfigStringify(value)).toBe('{"region":"west","token":"secret"}')
    expect(matchPluginConfigPreset(field, value)?.id).toBe('service')
    expect(redactPluginConfigValue(field, value)).toEqual({ region: 'west', token: '[redacted]' })
    expect(validatePluginConfigPreset(field, {
      id: 'bad',
      title: 'Bad',
      value: { region: 'west' },
    }, 'credentials')[0]).toMatchObject({
      code: 'required',
      path: { field: 'credentials', property: 'token' },
    })
    const dynamic = normalizePluginConfigDefinition({
      fields: {
        secrets: {
          type: 'object',
          additionalProperties: { type: 'string', sensitive: true },
        },
      },
    }).fields.secrets!
    expect(redactPluginConfigValue(dynamic, { first: 'private', public: false }))
      .toEqual({ first: '[redacted]', public: '[redacted]' })
  })

  it('rejects invalid preset and schema combinations', () => {
    expect(normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          choices: { allowCustom: true, presets: [] },
        },
      },
    }).fields.mode).toMatchObject({ choices: { allowCustom: true, presets: [] } })
    expect(() => normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          default: 'custom',
          choices: {
            allowCustom: false,
            presets: [{ id: 'safe', title: 'Safe', value: 'safe' }],
          },
        },
      },
    })).toThrow(/declared preset value/u)
    expect(() => normalizePluginConfigDefinition({
      fields: {
        token: {
          type: 'string',
          sensitive: true,
          choices: { allowCustom: true, presets: [{ id: 'one', title: 'One', value: 'one' }] },
        },
      },
    })).toThrow(/sensitive config cannot declare choices/u)
    expect(() => normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          choices: {
            allowCustom: true,
            presets: [
              { id: 'one', title: 'One', value: 'one', recommended: true },
              { id: 'two', title: 'Two', value: 'two', recommended: true },
            ],
          },
        },
      },
    })).toThrow(/at most one recommended preset/u)
    expect(() => normalizePluginConfigDefinition({
      fields: {
        mode: {
          type: 'string',
          choices: {
            allowCustom: true,
            presets: [
              { id: 'same', title: 'One', value: 'one' },
              { id: 'same', title: 'Two', value: 'two' },
            ],
          },
        },
      },
    })).toThrow(/duplicate preset id/u)

    for (const objectField of [
      { type: 'object' },
      { type: 'object', properties: { child: { type: 'string', default: 'x' } } },
      { type: 'object', additionalProperties: { type: 'string', required: true } },
    ]) {
      expect(() => normalizePluginConfigDefinition({ fields: { value: objectField } })).toThrow()
    }
  })
})
