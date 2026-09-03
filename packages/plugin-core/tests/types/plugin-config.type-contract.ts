import type {
  PluginConfigObjectPropertyField,
  PluginConfigScalarField,
  PluginConfigStringFormat,
} from '../../src/types.js'

export const fileStringFormat: PluginConfigStringFormat = 'file'
export const directoryStringFormat: PluginConfigStringFormat = 'directory'

export const topLevelScalarWithDefault: PluginConfigScalarField = {
  type: 'string',
  default: 'safe',
}

export const fixedObjectChildWithRequired: PluginConfigObjectPropertyField = {
  type: 'string',
  required: true,
}

export const fixedObjectChildWithDefault: PluginConfigObjectPropertyField = {
  type: 'string',
  // @ts-expect-error Fixed object config children cannot declare defaults.
  default: 'safe',
}
