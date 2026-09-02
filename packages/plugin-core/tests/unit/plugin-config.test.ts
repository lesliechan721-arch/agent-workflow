import { describe, expect, it } from 'vitest'

import {
  canonicalizePluginConfigValue,
  canonicalizePluginConfigValues,
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
    expect(validatePluginConfigValue(config.fields.workers!, Number.NaN, 'workers')[0]?.code)
      .toBe('type')
    expect(validatePluginConfigValue(config.fields.workers!, Number.POSITIVE_INFINITY, 'workers')[0]?.code)
      .toBe('type')
  })

  it('preserves object child choices and sensitive metadata', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        fixed: {
          type: 'object',
          sensitive: true,
          properties: {
            token: {
              type: 'string',
              sensitive: true,
              choices: {
                allowCustom: false,
                presets: [{ id: 'managed', title: 'Managed', value: 'managed' }],
              },
            },
          },
        },
        dynamic: {
          type: 'object',
          additionalProperties: {
            type: 'boolean',
            sensitive: true,
            choices: {
              allowCustom: false,
              presets: [{ id: 'enabled', title: 'Enabled', value: true }],
            },
          },
        },
      },
    })

    expect(config.fields.fixed).toMatchObject({
      sensitive: true,
      properties: {
        token: { sensitive: true, choices: { allowCustom: false } },
      },
    })
    expect(config.fields.dynamic).toMatchObject({
      additionalProperties: { sensitive: true, choices: { allowCustom: false } },
    })
    expect(validatePluginConfigValue(config.fields.dynamic!, { feature: false }, 'dynamic'))
      .toContainEqual(expect.objectContaining({
        code: 'choice',
        path: { field: 'dynamic', property: 'feature' },
      }))
  })

  it('rejects removed fields, arrays, null, and nested objects', () => {
    for (const field of [
      { type: 'enum', values: ['safe'] },
      { type: 'file' },
      { type: 'directory' },
      { type: 'string', recommendedValue: 'safe' },
    ]) {
      expect(() => normalizePluginConfigDefinition({ fields: { value: field } })).toThrow()
    }
    expect(() => normalizePluginConfigDefinition({ schema: {} })).toThrow(/unknown field "schema"/u)

    const config = normalizePluginConfigDefinition({
      fields: {
        metadata: {
          type: 'object',
          properties: { name: { type: 'string', required: true } },
          additionalProperties: false,
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

  it('keeps fixed and key-value object modes mutually exclusive', () => {
    expect(() => normalizePluginConfigDefinition({
      fields: {
        labels: {
          type: 'object',
          properties: { owner: { type: 'string' } },
          additionalProperties: { type: 'string' },
        },
      },
    })).toThrow(/cannot be mixed/u)
    expect(() => normalizePluginConfigDefinition({
      fields: { labels: { type: 'object', additionalProperties: false } },
    })).toThrow(/requires a scalar additionalProperties/u)

    const config = normalizePluginConfigDefinition({
      fields: {
        fixed: {
          type: 'object',
          properties: {
            owner: { type: 'string', required: true, validation: { format: 'identifier' } },
          },
          additionalProperties: false,
        },
        labels: {
          type: 'object',
          additionalProperties: { type: 'string', validation: { minLength: 2 } },
          validation: {
            minProperties: 1,
            maxProperties: 3,
            key: { format: 'identifier' },
          },
        },
      },
    })
    const issues = validatePluginConfigDocument(config, {
      fixed: { extra: 'value' },
      labels: { 'bad-key': 'x' },
    })
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'required', path: { field: 'fixed', property: 'owner' }, recoverable: true }),
      expect.objectContaining({ code: 'additionalProperty', path: { field: 'fixed', property: 'extra' }, recoverable: true }),
      expect.objectContaining({ code: 'format', path: { field: 'labels', property: 'bad-key' }, recoverable: true }),
      expect.objectContaining({ code: 'minLength', path: { field: 'labels', property: 'bad-key' }, recoverable: true }),
    ]))
    expect(formatPluginConfigIssue(issues[0]!)).toContain('fixed')
    expect(normalizePluginConfigDefinition({
      fields: {
        labels: {
          type: 'object',
          properties: { 'display-name': { type: 'string' } },
        },
      },
    }).fields.labels).toMatchObject({ additionalProperties: false })
  })

  it('applies object key validation to key-value defaults and presets', () => {
    const config = normalizePluginConfigDefinition({
      fields: {
        labels: {
          type: 'object',
          default: { fixed_key: 'default' },
          choices: {
            allowCustom: true,
            presets: [{ id: 'fixed', title: 'Fixed', value: { fixed_key: 'preset' } }],
          },
          additionalProperties: { type: 'string' },
          validation: { key: { format: 'identifier' } },
        },
      },
    })

    expect(validatePluginConfigDocument(config, { labels: { fixed_key: 'value' } })).toEqual([])
    expect(validatePluginConfigPreset(config.fields.labels!, {
      id: 'fixed-again', title: 'Fixed again', value: { fixed_key: 'preset' },
    }, 'labels')).toEqual([])
    expect(validatePluginConfigDocument(config, {
      labels: { fixed_key: 'value', 'bad key': 'dynamic' },
    })).toContainEqual(expect.objectContaining({
      code: 'format',
      path: { field: 'labels', property: 'bad key' },
    }))
  })

  it('rejects dangerous authoring and runtime config keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      expect(() => normalizePluginConfigDefinition({
        fields: Object.fromEntries([[key, { type: 'string' }]]),
      })).toThrow(/config key/u)
      expect(() => normalizePluginConfigDefinition({
        fields: {
          fixed: {
            type: 'object',
            properties: Object.fromEntries([[key, { type: 'string' }]]),
          },
        },
      })).toThrow(/dangerous config key/u)
    }
    const dynamic = normalizePluginConfigDefinition({
      fields: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
    }).fields.labels!
    expect(validatePluginConfigValue(dynamic, Object.fromEntries([
      ['__proto__', 'bad'],
      ['safe', 'good'],
    ]), 'labels')).toContainEqual(expect.objectContaining({
      code: 'dangerousKey',
      path: { field: 'labels', property: '__proto__' },
    }))
    expect(validatePluginConfigDocument({ fields: {} }, Object.fromEntries([
      ['constructor', 'bad'],
    ]))).toContainEqual(expect.objectContaining({ code: 'dangerousKey' }))
  })

  it.each([
    ['identifier', 'valid_Name', 'not-valid'],
    ['slug', 'valid-slug', 'Invalid Slug'],
    ['semver', '1.2.3-beta.1', '1.2'],
    ['url', 'https://example.com/path', 'example.com'],
    ['hostname', 'api.example.com', '-bad.example.com'],
    ['email', 'user@example.com', 'user@example'],
  ] as const)('validates the %s string format', (format, valid, invalid) => {
    const config = normalizePluginConfigDefinition({
      fields: { value: { type: 'string', validation: { format } } },
    })
    expect(validatePluginConfigValue(config.fields.value!, valid, 'value')).toEqual([])
    expect(validatePluginConfigValue(config.fields.value!, invalid, 'value')[0]?.code).toBe('format')
  })

  it.each(['path', 'file', 'directory'])('rejects the removed %s string format', (format) => {
    expect(() => normalizePluginConfigDefinition({
      fields: { value: { type: 'string', validation: { format } } },
    })).toThrow(/unsupported string format/u)
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
    expect(canonicalizePluginConfigValue(value)).toEqual({ region: 'west', token: 'secret' })
    expect(canonicalizePluginConfigValues({ z: { b: 2, a: 1 }, a: true }))
      .toEqual({ a: true, z: { a: 1, b: 2 } })
    expect(matchPluginConfigPreset(field, value)?.id).toBe('service')
    expect(validatePluginConfigValue(field, { region: 'east', token: 'secret' }, 'credentials'))
      .toContainEqual(expect.objectContaining({ code: 'choice' }))
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
    for (const field of [
      { type: 'string', choices: { allowCustom: false, presets: [] } },
      {
        type: 'object',
        properties: {
          mode: { type: 'string', choices: { allowCustom: false, presets: [] } },
        },
      },
      {
        type: 'object',
        additionalProperties: { type: 'number', choices: { allowCustom: false, presets: [] } },
      },
    ]) {
      expect(() => normalizePluginConfigDefinition({ fields: { value: field } }))
        .toThrow(/at least one preset/u)
    }
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
    expect(normalizePluginConfigDefinition({
      fields: {
        token: {
          type: 'string',
          sensitive: true,
          choices: { allowCustom: true, presets: [{ id: 'one', title: 'One', value: 'one' }] },
        },
      },
    }).fields.token).toMatchObject({ sensitive: true, choices: { allowCustom: true } })
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
    expect(() => normalizePluginConfigDefinition({
      fields: {
        value: {
          type: 'object',
          properties: { first: { type: 'number' }, second: { type: 'number' } },
          choices: {
            allowCustom: true,
            presets: [
              { id: 'one', title: 'One', value: { first: 1, second: 2 } },
              { id: 'two', title: 'Two', value: { second: 2, first: 1 } },
            ],
          },
        },
      },
    })).toThrow(/duplicate preset value/u)

    for (const objectField of [
      { type: 'object' },
      { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
      { type: 'object', properties: { child: { type: 'string', default: 'x' } } },
      { type: 'object', additionalProperties: { type: 'string', required: true } },
    ]) {
      expect(() => normalizePluginConfigDefinition({ fields: { value: objectField } })).toThrow()
    }
  })
})
