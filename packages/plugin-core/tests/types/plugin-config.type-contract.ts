import type {
  PluginConfigArrayField,
  PluginConfigObjectField,
  PluginConfigObjectPropertyField,
  PluginConfigScalarField,
  PluginConfigStringFormat,
} from '../../src/types.js'
import type { PluginManifestSourceV3 } from '../../src/index.js'

type GeneratedConfigFields = NonNullable<PluginManifestSourceV3['config']>['fields']
type GeneratedConfigField = NonNullable<GeneratedConfigFields[string]>
type GeneratedFixedObjectField = Extract<GeneratedConfigField, { properties: object }>
type GeneratedArrayField = Extract<GeneratedConfigField, { type: 'array' }>

export const generatedArrayField: GeneratedArrayField = {
  type: 'array', items: { type: 'string' }, default: [],
}

export const generatedArrayRejectsMixedDefault: GeneratedArrayField = {
  type: 'array', items: { type: 'string' },
  // @ts-expect-error Array defaults must be homogeneous.
  default: ['text', 1],
}

export const arrayItemRejectsSensitive: PluginConfigArrayField = {
  type: 'array',
  // @ts-expect-error Array items cannot be sensitive.
  items: { type: 'string', sensitive: true },
}

export const arrayItemRejectsNestedArray: PluginConfigArrayField = {
  type: 'array',
  // @ts-expect-error Array items cannot be arrays.
  items: { type: 'array', items: { type: 'string' } },
}

export const generatedFieldsRejectUndefined: GeneratedConfigFields = {
  // @ts-expect-error Config field dictionary values cannot be undefined.
  token: undefined,
}

export const generatedPropertiesRejectUndefined: GeneratedFixedObjectField = {
  type: 'object',
  properties: {
    // @ts-expect-error Fixed object property definitions cannot be undefined.
    token: undefined,
  },
}

export const generatedObjectDefaultsRejectUndefined: GeneratedFixedObjectField = {
  type: 'object',
  properties: {},
  default: {
    // @ts-expect-error Object default values cannot contain undefined leaves.
    token: undefined,
  },
}

export const generatedObjectPresetsRejectUndefined: GeneratedFixedObjectField = {
  type: 'object',
  properties: {},
  choices: {
    allowCustom: false,
    presets: [{
      id: 'managed',
      title: 'Managed',
      value: {
        // @ts-expect-error Object preset values cannot contain undefined leaves.
        token: undefined,
      },
    }],
  },
}

// @ts-expect-error Filesystem path formats are not part of the public Config contract.
export const pathStringFormat: PluginConfigStringFormat = 'path'
// @ts-expect-error Filesystem path formats are not part of the public Config contract.
export const fileStringFormat: PluginConfigStringFormat = 'file'
// @ts-expect-error Filesystem path formats are not part of the public Config contract.
export const directoryStringFormat: PluginConfigStringFormat = 'directory'

export const topLevelScalarWithDefault: PluginConfigScalarField = {
  type: 'string',
  default: 'safe',
}

export const topLevelSensitiveString: PluginConfigScalarField = {
  type: 'string',
  sensitive: true,
}

// @ts-expect-error Sensitive string fields cannot declare defaults.
export const sensitiveStringWithDefault: PluginConfigScalarField = {
  type: 'string',
  sensitive: true,
  default: 'secret',
}

// @ts-expect-error Sensitive string fields cannot declare choices or presets.
export const sensitiveStringWithChoices: PluginConfigScalarField = {
  type: 'string',
  sensitive: true,
  choices: { allowCustom: true, presets: [] },
}

// @ts-expect-error Number fields cannot be sensitive.
export const sensitiveNumber: PluginConfigScalarField = {
  type: 'number',
  sensitive: true,
}

export const fixedObjectChildWithRequired: PluginConfigObjectPropertyField = {
  type: 'string',
  required: true,
}

export const sensitiveFixedObjectChild: PluginConfigObjectPropertyField = {
  type: 'string',
  // @ts-expect-error Object children cannot be sensitive.
  sensitive: true,
}

export const fixedObject: PluginConfigObjectField = {
  type: 'object',
  properties: { child: { type: 'string' } },
  additionalProperties: false,
}

export const keyValueObject: PluginConfigObjectField = {
  type: 'object',
  additionalProperties: { type: 'string' },
}

// @ts-expect-error Fixed and key-value object modes are mutually exclusive.
export const mixedObject: PluginConfigObjectField = {
  type: 'object',
  properties: { child: { type: 'string' } },
  additionalProperties: { type: 'string' },
}

export const fixedObjectChildWithDefault: PluginConfigObjectPropertyField = {
  type: 'string',
  // @ts-expect-error Fixed object config children cannot declare defaults.
  default: 'safe',
}

export const sourceConfigV3: NonNullable<PluginManifestSourceV3['config']> = {
  schemaVersion: 3,
  definitions: { scalar: { type: 'string' }, profile: { type: 'object', properties: { model: { $ref: '#/config/definitions/scalar', required: true } } } },
  fields: { profile: { $ref: '#/config/definitions/profile', default: { model: 'local' } } },
  presentation: { summaries: { compact: { kind: 'join', parts: [{ path: '/model', format: 'raw' }], separator: '/', missing: 'unset' } }, fieldViews: { profile: { summary: 'compact' } } },
}

export const sourceRefCannotOverrideType: import('../../src/generated/plugin-manifest-v3.js').ConfigReference = {
  $ref: '#/config/definitions/scalar',
  // @ts-expect-error A reference cannot replace its definition type.
  type: 'number',
}

export const compiledConfigHasNoRefs: import('../../src/types.js').PluginConfigDefinition = {
  schemaVersion: 3, fields: {
    profile: {
      // @ts-expect-error Runtime fields are compiled; references exist only in source types.
      $ref: '#/config/definitions/profile',
    },
  },
}
