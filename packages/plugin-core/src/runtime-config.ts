import { compilePluginConfigDefinition, getPluginConfigDependencyKeys, validatePluginConfigCandidate } from './plugin-config.js';
import type { PluginConfigSchema, PluginConfigValue, Scope, PlatformName, PluginConfigReferenceContext } from './types.js';

export const AW_RUNTIME_CONFIG_BINDING_PATH = '.aw-runtime-config.json';
export const AW_RUNTIME_CONFIG_READER_PATH = 'scripts/aw-runtime-config.mjs';
export const AW_RUNTIME_NATIVE_RECEIPT_PATH = '.aw-runtime-native-receipt.json';

/** An installation resource declaration. AW supplies the reader and the effective snapshot. */
export type PluginRuntimeConfigDeclaration = import('./generated/plugin-manifest-v4.js').RuntimeConfig;

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
  originPath?: string;
}

/** A portable slice of the actual component preparation, independent of its config binding. */
export interface RuntimeConfigOrigin {
  schemaVersion: 1;
  kind: 'aw-runtime-component-origin';
  source: Pick<RuntimeInstalledIdentity,
    'sourceId' | 'sourceIdentity' | 'logicalIdentity' | 'pluginId' | 'pluginName' | 'pluginVersion'>;
  platform: PlatformName;
  scope: Scope;
  configScope: Scope;
  component: { id: string; kind: 'skill'; name: string };
  inputDigest: string;
}

export function createRuntimeConfigOrigin(options: {
  snapshot: RuntimeConfigSnapshot;
  inputDigest: string;
}): RuntimeConfigOrigin {
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.inputDigest)) {
    throw new Error('runtimeConfigBindingInvalid: Component preparation digest is invalid.');
  }
  const identity = options.snapshot.installedIdentity;
  return {
    schemaVersion: 1, kind: 'aw-runtime-component-origin',
    source: {
      sourceId: identity.sourceId, sourceIdentity: identity.sourceIdentity,
      ...(identity.logicalIdentity ? { logicalIdentity: identity.logicalIdentity } : {}),
      pluginId: identity.pluginId, pluginName: identity.pluginName, pluginVersion: identity.pluginVersion,
    },
    platform: identity.platform, scope: identity.scope, configScope: identity.configScope,
    component: { id: identity.artifactId, kind: 'skill', name: identity.skillKey },
    inputDigest: options.inputDigest,
  };
}

export function createRuntimeConfigSnapshot(options: {
  installedIdentity: RuntimeInstalledIdentity;
  declaration: PluginRuntimeConfigDeclaration;
  definition: PluginConfigSchema;
  values: Record<string, PluginConfigValue>;
  referenceContext?: PluginConfigReferenceContext;
}): RuntimeConfigSnapshot {
  const definition = compilePluginConfigDefinition(options.definition, options.installedIdentity.platform);
  if (options.referenceContext?.platform !== undefined
    && options.referenceContext.platform !== options.installedIdentity.platform) {
    throw new Error('runtimeConfigInvalid: Reference context must use the installed platform.');
  }
  const referenceContext = options.referenceContext === undefined ? undefined : {
    ...options.referenceContext, platform: options.installedIdentity.platform,
  };
  const allowedKeys = [...new Set(options.declaration.keys)].sort();
  const closure = getPluginConfigDependencyKeys(definition, allowedKeys, referenceContext);
  for (const key of closure) {
    const field = definition.fields[key];
    if (!field || ('sensitive' in field && field.sensitive === true)) {
      throw new Error('runtimeConfigKeyDenied: Runtime config requires declared non-sensitive fields.');
    }
  }
  if (validatePluginConfigCandidate(definition, options.values, allowedKeys, referenceContext).length > 0) {
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
  options: { originPath?: string } = {},
): RuntimeConfigBinding {
  return { schemaVersion: 2, kind: 'aw-runtime-config',
    installedIdentity: structuredClone(snapshot.installedIdentity),
    allowedKeys: [...snapshot.allowedKeys], effectiveValues: structuredClone(snapshot.effectiveValues),
    ...(options.originPath ? { originPath: options.originPath } : {}),
  };
}
