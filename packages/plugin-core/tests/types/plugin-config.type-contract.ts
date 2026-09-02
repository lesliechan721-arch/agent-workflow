import type {
  PluginConfigObjectField,
  PluginConfigObjectPropertyField,
  PluginConfigScalarField,
  PluginConfigStringFormat,
} from '../../src/types.js'

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

export const fixedObjectChildWithRequired: PluginConfigObjectPropertyField = {
  type: 'string',
  required: true,
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
