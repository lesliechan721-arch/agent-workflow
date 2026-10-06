import { createHash } from 'node:crypto';

import { getPluginConfigDependencyKeys, validatePluginConfigCandidate } from './plugin-config.js';
import type { PluginConfigSchema, PluginConfigValue, Scope, PlatformName } from './types.js';

export const AW_RUNTIME_CONFIG_BINDING_PATH = '.aw-runtime-config.json';
export const AW_RUNTIME_CONFIG_READER_PATH = 'scripts/aw-runtime-config.mjs';
export const AW_RUNTIME_NATIVE_RECEIPT_PATH = '.aw-runtime-native-receipt.json';
export const AW_RUNTIME_PEERS_ROOT = '.aw-runtime-peers';

/** An installation resource declaration. AW supplies the reader and the effective snapshot. */
export interface PluginRuntimeConfigDeclaration {
  keys: string[];
  resourceVersion: string;
  artifactIds?: string[];
}

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
  schemaVersion: 1;
  kind: 'aw-runtime-config';
  installedIdentity: RuntimeInstalledIdentity;
  allowedKeys: string[];
  definition: PluginConfigSchema;
  effectiveValues: Record<string, PluginConfigValue>;
  sources: Record<string, string>;
  resourceVersion: string;
  revision: string;
  consistencyGroup?: Array<{ artifactId: string; skillKey: string }>;
}

export interface RuntimeConfigBinding extends RuntimeConfigSnapshot {
  resources: Record<string, string>;
  peerLocators: Array<{ artifactId: string; skillKey: string; relativeRoot: string }>;
  nativeReceiptPath?: string;
  digest: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

export function computeRuntimeConfigDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update('aw-runtime-config-v1\0')
    .update(JSON.stringify(canonical(value))).digest('hex')}`;
}

/** Artifact identity and tree bytes are checked separately so related Skills share a revision. */
export function computeRuntimeConfigRevision(snapshot: Omit<RuntimeConfigSnapshot, 'revision'>): string {
  const { artifactId: _artifactId, skillKey: _skillKey, scope: _scope, ...identity } = snapshot.installedIdentity;
  return computeRuntimeConfigDigest({
    installedIdentity: identity,
    allowedKeys: snapshot.allowedKeys,
    definition: snapshot.definition,
    effectiveValues: snapshot.effectiveValues,
    sources: snapshot.sources,
    resourceVersion: snapshot.resourceVersion,
    consistencyGroup: snapshot.consistencyGroup,
  });
}

export function createRuntimeConfigSnapshot(options: {
  installedIdentity: RuntimeInstalledIdentity;
  declaration: PluginRuntimeConfigDeclaration;
  definition: PluginConfigSchema;
  values: Record<string, PluginConfigValue>;
  sources: Record<string, string>;
  consistencyGroup?: Array<{ artifactId: string; skillKey: string }>;
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
  const definition = {
    ...(options.definition.schemaVersion === 3 ? { schemaVersion: 3 as const } : {}),
    fields: Object.fromEntries(closure.map((key) => [key, options.definition.fields[key]])),
  } as PluginConfigSchema;
  const snapshot: Omit<RuntimeConfigSnapshot, 'revision'> = {
    schemaVersion: 1,
    kind: 'aw-runtime-config',
    installedIdentity: options.installedIdentity,
    allowedKeys,
    definition,
    effectiveValues: Object.fromEntries(closure.filter((key) => Object.hasOwn(options.values, key))
      .map((key) => [key, options.values[key]!])),
    sources: Object.fromEntries(closure.filter((key) => Object.hasOwn(options.sources, key))
      .map((key) => [key, options.sources[key]!])),
    resourceVersion: options.declaration.resourceVersion,
    ...(options.consistencyGroup ? { consistencyGroup: options.consistencyGroup } : {}),
  };
  return { ...snapshot, revision: computeRuntimeConfigRevision(snapshot) };
}

export function createRuntimeConfigBinding(
  snapshot: RuntimeConfigSnapshot,
  resources: Record<string, string>,
  options: { nativeReceiptPath?: string; peerLocation?: 'sibling' | 'snapshot' | 'snapshot-member'; snapshotOwnerSkillKey?: string } = {},
): RuntimeConfigBinding {
  const peerLocators = (snapshot.consistencyGroup ?? []).map((peer) => ({
    ...peer,
    relativeRoot: peer.skillKey === snapshot.installedIdentity.skillKey ? '.'
      : options.peerLocation === 'snapshot' ? `${AW_RUNTIME_PEERS_ROOT}/${peer.skillKey}`
        : options.peerLocation === 'snapshot-member' && peer.skillKey === options.snapshotOwnerSkillKey ? '../..' : `../${peer.skillKey}`,
  }));
  const binding = { ...snapshot, resources, peerLocators,
    ...(options.nativeReceiptPath ? { nativeReceiptPath: options.nativeReceiptPath } : {}),
  };
  return { ...binding, digest: computeRuntimeConfigDigest(binding) };
}
