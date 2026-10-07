import { getPluginConfigDependencyKeys, validatePluginConfigCandidate } from './plugin-config.js';
import type { PluginConfigSchema, PluginConfigValue, Scope, PlatformName } from './types.js';

export const AW_RUNTIME_CONFIG_BINDING_PATH = '.aw-runtime-config.json';
export const AW_RUNTIME_CONFIG_READER_PATH = 'scripts/aw-runtime-config.mjs';
export const AW_RUNTIME_NATIVE_RECEIPT_PATH = '.aw-runtime-native-receipt.json';

/** An installation resource declaration. AW supplies the reader and the effective snapshot. */
export type PluginRuntimeConfigDeclaration = import('./generated/plugin-manifest-v3.js').RuntimeConfig;

export interface RuntimeInstalledIdentity {
  sourceId: string;
  sourceIdentity: string;
  logicalIdentity?: string;
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  platform: PlatformName;
  scope: Scope;
  configScope: Scope;
  artifactId: string;
  skillKey: string;
}

export interface RuntimeConfigSnapshot {
  schemaVersion: 2;
  kind: 'aw-runtime-config';
  installedIdentity: RuntimeInstalledIdentity;
  allowedKeys: string[];
  effectiveValues: Record<string, PluginConfigValue>;
}

export interface RuntimeConfigBinding extends RuntimeConfigSnapshot {
  nativeReceiptPath?: string;
}

export function createRuntimeConfigSnapshot(options: {
  installedIdentity: RuntimeInstalledIdentity;
  declaration: PluginRuntimeConfigDeclaration;
  definition: PluginConfigSchema;
  values: Record<string, PluginConfigValue>;
}): RuntimeConfigSnapshot {
  const allowedKeys = [...new Set(options.declaration.keys)].sort();
  const closure = getPluginConfigDependencyKeys(options.definition, allowedKeys);
  for (const key of closure) {
    const field = options.definition.fields[key];
    if (!field || ('sensitive' in field && field.sensitive === true)) {
      throw new Error('runtimeConfigKeyDenied: Runtime config requires declared non-sensitive fields.');
    }
  }
  if (validatePluginConfigCandidate(options.definition, options.values, allowedKeys).length > 0) {
    throw new Error('runtimeConfigInvalid: Effective runtime config is invalid; sync or reinstall after fixing config.');
  }
  return {
    schemaVersion: 2,
    kind: 'aw-runtime-config',
    installedIdentity: options.installedIdentity,
    allowedKeys,
    effectiveValues: Object.fromEntries(allowedKeys.filter((key) => Object.hasOwn(options.values, key))
      .map((key) => [key, options.values[key]!])),
  };
}

export function createRuntimeConfigBinding(
  snapshot: RuntimeConfigSnapshot,
  options: { nativeReceiptPath?: string } = {},
): RuntimeConfigBinding {
  return { ...snapshot,
    ...(options.nativeReceiptPath ? { nativeReceiptPath: options.nativeReceiptPath } : {}),
  };
}
