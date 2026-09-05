import type {
  PluginConfigObjectField,
  PluginConfigObjectPropertyField,
  PluginConfigScalarField,
  PluginConfigStringFormat,
} from '../../src/types.js'
import type { PluginManifestSourceV3 } from '../../src/index.js'

type GeneratedConfigFields = NonNullable<PluginManifestSourceV3['config']>['fields']
type GeneratedConfigField = NonNullable<GeneratedConfigFields[string]>
type GeneratedFixedObjectField = Extract<GeneratedConfigField, { properties: object }>

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
