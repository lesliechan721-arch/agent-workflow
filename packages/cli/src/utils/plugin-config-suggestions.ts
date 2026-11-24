import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat } from 'node:fs/promises';

import {
  PLUGIN_CONFIG_ARRAY_MAX_BYTES,
  PLUGIN_CONFIG_ARRAY_MAX_ITEMS,
  canonicalizeIdentityValue,
  resolvePluginConfigObjectProperties,
  selectPluginConfigProfile,
  validatePluginConfigValue,
  type PluginConfigObject,
  type PluginConfigSchemaField,
  type PluginConfigSuggestionsDeclaration,
} from '@lesliechan721/aw-plugin-core/manifest';

import { resolveWorkContext } from '../intent/work-context.js';
import type { PlatformTarget, PluginConfigValue, PluginMeta, Scope } from '../types.js';
import { readPluginManifest } from './manifest.js';
import { formatPluginId } from './multi-source-catalog.js';
import {
  pluginConfigHasExternalReferences,
  resolvePluginConfigReferenceContext,
} from './plugin-config-references.js';
import {
  readPluginConfigStore,
  replacePluginConfigStoreLayer,
  resolveEffectivePluginConfigFromStores,
  type PluginConfigStore,
} from './plugin-config.js';
import { projectConfigSuggestionsResponse, runPluginConfigSuggestions, type ConfigSuggestionsRequestV1, type ConfigSuggestionsResponseV1 } from './plugin-config-suggestion-runner.js';
import { collectSensitivePluginConfigValues } from './plugin-scripts.js';

export type { ConfigSuggestionsResponseV1 } from './plugin-config-suggestion-runner.js';

type ConfigValues = Record<string, PluginConfigValue>;
type FieldPath = Array<string | number>;
type DraftLayer = { updates: ConfigValues; removes: readonly string[] };
type Draft = {
  draftValues?: ConfigValues;
  draftRemoves?: readonly string[];
  draftLayers?: { common?: DraftLayer; platform?: DraftLayer };
};
type ConfigReadOptions = { platform?: PlatformTarget; context: Scope; cwd: string; env?: NodeJS.ProcessEnv };

export class ConfigSuggestionArgumentError extends Error {}

const fieldName = /^[A-Za-z][A-Za-z0-9_]*$/u;
const indexPattern = /^(0|[1-9][0-9]*)$/u;
const unsafeNames = new Set(['__proto__', 'constructor', 'prototype']);

function safeMember(key: string): boolean {
  return key.length > 0 && !unsafeNames.has(key) && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(key);
}

export function parseConfigSuggestionFieldPath(value: string): FieldPath {
  const parts = value.split('.');
  assertFieldPath(parts);
  return parts;
}

function assertFieldPath(parts: FieldPath): void {
  if (typeof parts[0] !== 'string' || !fieldName.test(parts[0]) || parts.some((part) => typeof part === 'number'
    ? !Number.isSafeInteger(part) || part < 0 : !safeMember(part))) {
    throw new ConfigSuggestionArgumentError('Use a dot-separated configuration field path.');
  }
}

function ownValue<T>(values: Record<string, T> | undefined, key: string): T | undefined {
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

function valueRecord(value: PluginConfigValue | undefined): ConfigValues {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function validateDraftValues(
  fields: Record<string, PluginConfigSchemaField>,
  values: ConfigValues = {},
): ConfigValues {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => {
    const field = ownValue(fields, key);
    return field && validatePluginConfigValue(field, value).length === 0;
  }));
}

/** Keep the valid children and row positions of an in-progress editor value. */
function projectWorkingValue(field: PluginConfigSchemaField, value: PluginConfigValue): PluginConfigValue | undefined {
  if (field.sensitive) return undefined;
  if (validatePluginConfigValue(field, value).length === 0) return value;
  if (field.choices?.allowCustom === false) return undefined;
  if (field.type === 'object' && field.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    const { properties } = resolvePluginConfigObjectProperties(field, value);
    const projected: PluginConfigObject = {};
    for (const [key, child] of Object.entries(properties)) {
      const entry = ownValue(value, key);
      if (entry === undefined) continue;
      const part = projectWorkingValue(child, entry);
      if (part !== undefined) projected[key] = part as PluginConfigObject[string];
    }
    return projected;
  }
  if (field.type === 'array' && field.items.type === 'object' && Array.isArray(value)
    && value.length <= Math.min(field.validation?.maxItems ?? PLUGIN_CONFIG_ARRAY_MAX_ITEMS, PLUGIN_CONFIG_ARRAY_MAX_ITEMS)) {
    const rows = Array.from(value as PluginConfigValue[], (row) => valueRecord(projectWorkingValue(field.items, row)));
    if (Buffer.byteLength(JSON.stringify(rows), 'utf8') <= PLUGIN_CONFIG_ARRAY_MAX_BYTES) return rows as PluginConfigObject[];
  }
  return undefined;
}

function layerValues(base: ConfigValues, updates: ConfigValues, removes: readonly string[] = []): ConfigValues {
  const result = { ...base };
  for (const key of removes) delete result[key];
  return { ...result, ...updates };
}

async function readConfig(plugin: PluginMeta, options: ConfigReadOptions & { projectRoot: string }, draft: Draft = {}) {
  const { manifest } = plugin;
  if (!manifest.config) return { values: {}, providerValues: {}, sensitiveValues: [] };
  const { platform } = options;
  const schema: Record<string, PluginConfigSchemaField> = selectPluginConfigProfile(manifest.config, platform).fields;
  const commonSchema: Record<string, PluginConfigSchemaField> = platform ? selectPluginConfigProfile(manifest.config).fields : schema;
  const identity = { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
    logicalIdentity: plugin.catalogLogicalIdentity, pluginName: manifest.name };
  const store = await readPluginConfigStore({ ...options, ...identity, scope: 'user' }).catch(() => undefined);
  const commonDraft = validateDraftValues(commonSchema, draft.draftLayers?.common?.updates);
  const platformDraft = platform ? validateDraftValues(schema, draft.draftLayers?.platform?.updates) : {};
  const workingDraft: ConfigValues = {};
  for (const [key, value] of Object.entries(draft.draftValues ?? {})) {
    const field = ownValue(schema, key);
    if (!field || ownValue(commonSchema, key)?.sensitive) continue;
    const projected = projectWorkingValue(field, value);
    if (projected !== undefined) workingDraft[key] = projected;
  }
  const references = store && store.state !== 'invalid' && pluginConfigHasExternalReferences(manifest)
    ? await resolvePluginConfigReferenceContext({ ...options, ...identity, manifest, scope: options.context,
      allowInvalidStores: true }) : undefined;
  const resolve = (user: PluginConfigStore) => resolveEffectivePluginConfigFromStores({
    ...options, ...identity, manifest, referenceContext: references?.context, stores: { user },
  });
  const saved = store && store.state !== 'invalid' ? await resolve(store) : undefined;
  let effective = saved;
  if (store && saved && draft.draftLayers) {
    let edited = store;
    if (draft.draftLayers.common) {
      edited = replacePluginConfigStoreLayer(edited,
        layerValues(store.common ?? store.values, commonDraft, draft.draftLayers.common.removes));
    }
    if (platform && draft.draftLayers.platform) {
      edited = replacePluginConfigStoreLayer(edited,
        layerValues(store.platforms?.[platform] ?? {}, platformDraft, draft.draftLayers.platform.removes), platform);
    }
    effective = await resolve(edited);
  }
  const values = effective?.values ?? { ...(platform ? validateDraftValues(schema, commonDraft) : commonDraft), ...platformDraft };
  const providerBase = layerValues(values, workingDraft, draft.draftRemoves);
  const providerValues = Object.fromEntries(Object.entries(providerBase).filter(([key]) => {
    const field = ownValue(schema, key);
    return field && !field.sensitive && !ownValue(commonSchema, key)?.sensitive;
  }));
  const sensitiveValues = [
    ...collectSensitivePluginConfigValues(manifest, store?.common ?? store?.values ?? {}),
    ...[platform ? store?.platforms?.[platform] : undefined, saved?.values, draft.draftValues, draft.draftLayers?.platform?.updates, providerBase]
      .flatMap((entries) => entries ? collectSensitivePluginConfigValues(manifest, entries, platform) : []),
    ...collectSensitivePluginConfigValues(manifest, draft.draftLayers?.common?.updates ?? {}),
  ];
  return { values, providerValues, sensitiveValues };
}

export function parseConfigSuggestionDependencyOverrides(entries: readonly string[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    const key = entry.slice(0, separator);
    if (separator < 1 || !safeMember(key) || result.has(key)) {
      throw new ConfigSuggestionArgumentError('Use each --dep key once with a key=value argument.');
    }
    result.set(key, entry.slice(separator + 1));
  }
  return result;
}

function parseDependencyValue(field: PluginConfigSchemaField, raw: string): PluginConfigValue {
  if (field.type === 'string') return raw;
  if (field.type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (field.type === 'number' && raw.trim() !== '' && Number.isFinite(Number(raw))) return Number(raw);
  throw new ConfigSuggestionArgumentError('A --dep value does not match the dependency field type.');
}

function resolveSuggestionField(
  fields: Record<string, PluginConfigSchemaField>,
  fieldPath: FieldPath,
  config: ConfigValues,
  overrides: ReadonlyMap<string, string>,
  liveSiblings?: ConfigValues,
) {
  const [root, ...parts] = fieldPath;
  const resolvedPath: FieldPath = [root!];
  let field = ownValue(fields, root as string);
  let value = ownValue(config, root as string);
  let siblings: ConfigValues = {};
  let properties: Record<string, PluginConfigSchemaField> = {};
  for (let index = 0; field && index < parts.length;) {
    if (field.type === 'array') {
      const step = parts[index];
      const explicitIndex = typeof step === 'number' ? step : step !== undefined && indexPattern.test(step) ? Number(step) : undefined;
      if (explicitIndex !== undefined) {
        if (!Number.isSafeInteger(explicitIndex)) throw new ConfigSuggestionArgumentError('Use a valid array index in the field path.');
        resolvedPath.push(explicitIndex);
        index++;
      }
      field = field.items;
      value = explicitIndex !== undefined && Array.isArray(value) ? value[explicitIndex] : undefined;
    } else if (field.type === 'object' && typeof parts[index] === 'string') {
      const property = parts[index++] as string;
      resolvedPath.push(property);
      siblings = index === parts.length && liveSiblings ? liveSiblings : valueRecord(value);
      const discriminator = field.variants?.discriminator;
      const override = discriminator && index === parts.length ? overrides.get(discriminator) : undefined;
      if (discriminator && override !== undefined) {
        siblings = { ...siblings, [discriminator]: override };
      }
      properties = resolvePluginConfigObjectProperties(field, siblings).properties;
      field = ownValue(properties, property);
      value = ownValue(siblings, property);
    } else {
      field = undefined;
    }
  }
  if (!field || field.type === 'array' || field.type === 'object' || field.sensitive || !field.suggestions) {
    throw new ConfigSuggestionArgumentError('The selected field does not declare dynamic suggestions.');
  }
  const declaration: PluginConfigSuggestionsDeclaration = field.suggestions;
  const dependsOn = declaration.dependsOn ?? [];
  for (const key of overrides.keys()) {
    const dependency = ownValue(properties, key);
    if (!dependsOn.includes(key) || !dependency || dependency.sensitive) {
      throw new ConfigSuggestionArgumentError('A --dep key is not a dependency of the selected field.');
    }
  }
  const dependencyValues: ConfigValues = {};
  for (const key of dependsOn) {
    const dependency = ownValue(properties, key);
    if (!dependency || dependency.sensitive) continue;
    const override = overrides.get(key);
    const candidate = override === undefined ? ownValue(siblings, key) : parseDependencyValue(dependency, override);
    if (candidate !== undefined && (override !== undefined || validatePluginConfigValue(dependency, candidate).length === 0)) {
      dependencyValues[key] = candidate;
    }
  }
  return { field, declaration, dependencyValues, fieldPath: resolvedPath };
}

export interface PreparedConfigSuggestions {
  cacheKey: string;
  pluginId: string;
  providerPluginId: string;
  provider: string;
  profile: ConfigSuggestionsRequestV1['profile'];
  fieldPath: FieldPath;
  /** Reapply current redaction and finalize candidates for the selected field. */
  project(response: ConfigSuggestionsResponseV1, target?: 'field' | 'cache'): ConfigSuggestionsResponseV1;
  run(signal?: AbortSignal): Promise<ConfigSuggestionsResponseV1>;
}

/** Prepare inside the Active Catalog lease that supplied the consumer bundle. */
export async function preparePluginConfigSuggestions(options: ConfigReadOptions & Draft & {
  plugin: PluginMeta;
  fieldPath: FieldPath;
  dependencyValues?: ConfigValues;
  dependencyOverrides?: ReadonlyMap<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PreparedConfigSuggestions> {
  const { plugin, platform, signal } = options;
  signal?.throwIfAborted();
  assertFieldPath(options.fieldPath);
  const fields: Record<string, PluginConfigSchemaField> = plugin.manifest.config
    ? selectPluginConfigProfile(plugin.manifest.config, platform).fields : {};
  if (!ownValue(fields, options.fieldPath[0] as string)) {
    throw new ConfigSuggestionArgumentError('The selected field does not declare dynamic suggestions.');
  }
  const cwd = path.resolve(options.cwd);
  const work = await resolveWorkContext({ cwd, context: options.context });
  const readOptions = { ...options, cwd, projectRoot: work.projectRoot ?? '' };
  const consumerConfig = await readConfig(plugin, readOptions, options);
  // A working object can select a valid branch before all of its required properties are filled.
  const fieldValues = layerValues(consumerConfig.values, options.draftValues ?? {}, options.draftRemoves);
  const { field, declaration, dependencyValues, fieldPath } = resolveSuggestionField(fields, options.fieldPath,
    fieldValues, options.dependencyOverrides ?? new Map(), options.dependencyValues);
  if (!plugin.sourceId || !plugin.sourceIdentity) throw new Error('The plugin Catalog source is unavailable.');
  const pluginId = formatPluginId({ sourceId: plugin.sourceId, pluginName: plugin.manifest.name });
  let provider = plugin;
  if (declaration.plugin) {
    if (!plugin.manifest.dependencies?.includes(declaration.plugin)) throw new Error('The suggestion provider is unavailable.');
    const providerRoot = path.join(path.dirname(plugin.rootDir), declaration.plugin);
    if (!(await lstat(providerRoot)).isDirectory()) throw new Error('The suggestion provider bundle is unavailable.');
    const sibling = await readPluginManifest(providerRoot, { mode: 'bundle' });
    if (sibling.manifest.name !== declaration.plugin) throw new Error('The suggestion provider bundle identity is invalid.');
    provider = { ...sibling, sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
      catalogLogicalIdentity: plugin.catalogLogicalIdentity };
  }
  const providerPluginId = formatPluginId({ sourceId: plugin.sourceId, pluginName: provider.manifest.name });
  const script = provider.manifest.scripts?.config?.suggestions;
  if (!script) throw new Error('The suggestion provider script is unavailable.');
  const providerConfig = provider === plugin ? consumerConfig : await readConfig(provider, readOptions);
  signal?.throwIfAborted();
  const request: ConfigSuggestionsRequestV1 = {
    schemaVersion: 1, provider: declaration.provider,
    ...(platform === undefined ? {} : { platform }), profile: platform ?? 'common',
    consumer: { pluginId, name: plugin.manifest.name, version: plugin.manifest.version },
    providerPlugin: { pluginId: providerPluginId, name: provider.manifest.name, version: provider.manifest.version, rootDir: provider.rootDir },
    fieldPath, dependencyValues, providerConfigValues: providerConfig.providerValues, cwd,
  };
  const providerConfigDigest = createHash('sha256').update(canonicalizeIdentityValue(request.providerConfigValues)).digest('hex');
  const cacheKey = canonicalizeIdentityValue({
    sourceIdentity: plugin.sourceIdentity, providerPluginId, providerVersion: provider.manifest.version,
    provider: request.provider, platform: request.profile, dependencyValues, providerConfigDigest,
  });
  const sensitiveValues = [...new Set([...consumerConfig.sensitiveValues, ...providerConfig.sensitiveValues])];
  return {
    cacheKey, pluginId, providerPluginId, provider: request.provider, profile: request.profile, fieldPath,
    project: (response, target = 'field') => projectConfigSuggestionsResponse(response, sensitiveValues,
      target === 'field' ? (value) => validatePluginConfigValue(field, value).length === 0 : undefined),
    run: (runSignal = signal) => runPluginConfigSuggestions({
      request, entry: script.path, env: options.env ?? process.env, timeoutMs: options.timeoutMs ?? script.timeoutMs,
      signal: runSignal, sensitiveValues,
    }),
  };
}
