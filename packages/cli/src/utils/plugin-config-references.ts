import crypto from 'node:crypto';
import path from 'node:path';

import {
  validatePluginConfigCandidate,
  compilePluginConfigDefinition,
  PLATFORM_TARGETS,
  type PlatformTarget,
  getPluginConfigDependencyFields,
  formatPluginConfigIssue,
  type PluginConfigReferenceContext,
  type PluginConfigValidationIssue,
} from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest, PluginMeta, Scope } from '../types.js';
import { resolveWorkContext } from '../intent/work-context.js';
import { resolveCatalogOperationContext, type CatalogOperationContext } from './catalog-operation-context.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';
import { readPluginManifest } from './manifest.js';
import { formatPluginId } from './multi-source-catalog.js';
import { resolvePluginMetaDependencyClosure } from './plugin-dependencies.js';
import {
  readPluginConfigStore,
  resolveAwProjectRoot,
  resolveEffectivePluginConfigFromStores,
  type PluginConfigSource,
  type PluginConfigStore,
  type ResolvedEffectivePluginConfig,
} from './plugin-config.js';

export interface PluginConfigReferenceEvidence {
  plugin: string;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  platform: PlatformTarget | null;
  definitionDigest: string;
  stores: Partial<Record<Scope, Pick<PluginConfigStore, 'exists' | 'state' | 'rawDigest'>>>;
  sources: Record<string, PluginConfigSource>;
}

function createReferenceEvidence(plugin: PluginMeta, platform?: PlatformTarget): PluginConfigReferenceEvidence {
  return { plugin: plugin.manifest.name, platform: platform ?? null, sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
    logicalIdentity: plugin.catalogLogicalIdentity,
    definitionDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify({ platform: platform ?? null, config: plugin.manifest.config ? compilePluginConfigDefinition(plugin.manifest.config, platform) : null,
      dependencies: plugin.manifest.dependencies ?? [] })).digest('hex')}`,
    stores: {}, sources: {} };
}

export function pluginConfigHasExternalReferences(manifest: NormalizedPluginManifest): boolean {
  if (manifest.requires?.aw.capabilities?.includes('aw.plugin-config-cross-plugin-value-ref.v1')) return true;
  const visit = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    const record = value as Record<string, unknown>;
    const reference = record.valueRef as { plugin?: unknown } | undefined;
    return typeof reference?.plugin === 'string' || Object.values(record).some(visit);
  };
  return visit(manifest.config);
}

/** Read only the selected Active source. An explicit set is also the offline boundary. */
export async function resolvePluginConfigReferencePlugins(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  plugins?: readonly PluginMeta[];
  operationContext?: CatalogOperationContext;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginMeta[]> {
  if (options.plugins) {
    const selected = options.plugins.filter((plugin) => plugin.sourceId === options.sourceId);
    if (selected.some((plugin) => (options.sourceIdentity && plugin.sourceIdentity !== options.sourceIdentity)
      || (options.logicalIdentity && plugin.catalogLogicalIdentity !== options.logicalIdentity))) {
      throw new Error('operationPlanStale: the configuration reference source identity changed.');
    }
    return selected;
  }
  if (!options.sourceId) return [];
  let operation = options.operationContext;
  if (!operation) {
    const configured = await readCatalogSourcesConfigSnapshot(options.env);
    if (!configured.config.sources.some((source) => source.id === options.sourceId)) return [];
    operation = await resolveCatalogOperationContext({ sourceIds: [options.sourceId], env: options.env });
  }
  const source = operation.catalog.sources.find((source) => source.sourceId === options.sourceId)?.resolution;
  if (!source) throw new Error('operationPlanStale: the configuration reference source is unavailable.');
  if ((options.sourceIdentity && source.sourceIdentity !== options.sourceIdentity)
    || (options.logicalIdentity && source.logicalIdentity !== options.logicalIdentity)) {
    throw new Error('operationPlanStale: the configuration reference source identity changed.');
  }
  return Promise.all(source.manifest.entries.map(async (entry) => {
    const plugin = await readPluginManifest(path.join(source.rootDir, 'plugins', entry.name), { mode: 'bundle' });
    return { ...plugin, sourceId: source.sourceId, sourceIdentity: source.sourceIdentity,
      catalogLogicalIdentity: source.logicalIdentity,
      pluginId: formatPluginId({ sourceId: source.sourceId, pluginName: entry.name }) };
  }));
}

export async function resolvePluginConfigReferenceContext(options: {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
  manifest: NormalizedPluginManifest;
  scope: Scope;
  context?: Scope;
  platform?: PlatformTarget;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginMeta[];
  storeOverrides?: ReadonlyMap<string, Partial<Record<Scope, PluginConfigStore>>>;
}): Promise<{ context: PluginConfigReferenceContext; evidence: PluginConfigReferenceEvidence[] }> {
  options = { ...options, scope: options.context ?? options.scope };
  const workContext = options.context ? await resolveWorkContext({ cwd: options.cwd, context: options.context }) : undefined;
  const projectRoot = workContext?.projectRoot ?? (options.scope === 'project' ? resolveAwProjectRoot(options.cwd) : '');
  const context: PluginConfigReferenceContext = {
    plugin: options.manifest.name,
    platform: options.platform,
    dependencies: options.manifest.dependencies ?? [],
    plugins: {},
  };
  const evidence: PluginConfigReferenceEvidence[] = [];
  if (!pluginConfigHasExternalReferences(options.manifest)) return { context, evidence };
  const plugins = await resolvePluginConfigReferencePlugins(options);
  // The current manifest is authoritative for the operation; never substitute another source.
  const current = plugins.find((plugin) => plugin.manifest.name === options.manifest.name);
  const selected = current ? plugins.map((plugin) => plugin === current ? { ...plugin, manifest: options.manifest } : plugin) : plugins;
  const closure = resolvePluginMetaDependencyClosure(selected, [options.manifest.name]);
  const entries: Record<string, PluginConfigReferenceContext['plugins'][string]> = {};
  for (const plugin of closure) {
    if (!plugin.manifest.config) continue;
    entries[plugin.manifest.name] = { definition: compilePluginConfigDefinition(plugin.manifest.config, options.platform),
      dependencies: plugin.manifest.dependencies ?? [] };
  }
  const completeContext = { ...context, plugins: entries };
  for (const plugin of closure) {
    if (!plugin.manifest.config || plugin.manifest.name === options.manifest.name) continue;
    const identity = { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
      logicalIdentity: plugin.catalogLogicalIdentity, pluginName: plugin.manifest.name,
      cwd: options.cwd, env: options.env };
    const entry = createReferenceEvidence(plugin, options.platform);
    evidence.push(entry);
    try {
      const overrides = options.storeOverrides?.get(plugin.manifest.name);
      const storeEvidence = (store: PluginConfigStore) => ({ exists: store.exists, state: store.state,
        ...(store.rawDigest ? { rawDigest: store.rawDigest } : {}) });
      const user = overrides?.user ?? await readPluginConfigStore({ ...identity, scope: 'user', platform: options.platform });
      entry.stores.user = storeEvidence(user);
      const effective = await resolveEffectivePluginConfigFromStores({ manifest: plugin.manifest,
        targetScope: options.scope, platform: options.platform, projectRoot,
        stores: { user },
        referenceContext: { ...completeContext, plugin: plugin.manifest.name, dependencies: plugin.manifest.dependencies ?? [] } });
      entries[plugin.manifest.name] = { ...entries[plugin.manifest.name]!, values: rawEffectiveValues(effective) };
      entry.sources = effective.sources;
    } catch (error) {
      // An unavailable optional scope still binds Review to the dependency bytes that were read.
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { referenceEvidence: evidence });
    }
  }
  return { context: completeContext, evidence };
}

/** Bind each reviewed profile to its single owner document and same-profile providers. */
export async function collectPluginConfigReferenceEvidence(options: {
  plugin: PluginMeta; profiles: readonly { pluginName: string; scope: Scope; platform?: PlatformTarget }[];
  plugins: readonly PluginMeta[]; cwd: string; env?: NodeJS.ProcessEnv;
}): Promise<PluginConfigReferenceEvidence[]> {
  const plugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    plugins: options.plugins, env: options.env });
  const byName = new Map([...plugins, options.plugin].map((plugin) => [plugin.manifest.name, plugin]));
  const profiles = new Map(options.profiles.map((profile) => [`${profile.pluginName}\0${profile.scope}\0${profile.platform ?? 'common'}`, profile]));
  const evidence: PluginConfigReferenceEvidence[] = [];
  for (const [, profile] of [...profiles].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const plugin = byName.get(profile.pluginName);
    if (!plugin) throw new Error(`operationPlanStale: configuration owner ${profile.pluginName} is no longer in the selected source.`);
    const entry = createReferenceEvidence(plugin, profile.platform);
    const user = await readPluginConfigStore({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
      logicalIdentity: plugin.catalogLogicalIdentity, pluginName: plugin.manifest.name, scope: 'user',
      platform: profile.platform, cwd: options.cwd, env: options.env });
    entry.stores.user = { exists: user.exists, state: user.state, rawDigest: user.rawDigest };
    evidence.push(entry);
    try {
      const references = await resolvePluginConfigReferenceContext({ sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
        logicalIdentity: plugin.catalogLogicalIdentity, manifest: plugin.manifest, scope: profile.scope,
        platform: profile.platform, cwd: options.cwd, env: options.env, plugins: [...byName.values()] });
      evidence.push(...references.evidence);
      const effective = await resolveEffectivePluginConfigFromStores({ manifest: plugin.manifest, targetScope: profile.scope,
        platform: profile.platform, projectRoot: profile.scope === 'project' ? resolveAwProjectRoot(options.cwd) : '', stores: { user }, referenceContext: references.context });
      entry.sources = effective.sources;
    } catch (error) {
      evidence.push(...((error as { referenceEvidence?: PluginConfigReferenceEvidence[] }).referenceEvidence ?? []));
    }
  }
  return evidence;
}

export interface PluginConfigReferenceConsumerImpact {
  plugin: PluginMeta;
  scope: Scope;
  platform?: PlatformTarget;
  before?: ResolvedEffectivePluginConfig;
  after?: ResolvedEffectivePluginConfig;
  error?: string;
}

function providerReferences(consumer: PluginMeta, provider: PluginMeta, plugins: readonly PluginMeta[], platform?: PlatformTarget): Array<{ field: string; key: string }> {
  const definition = consumer.manifest.config ? compilePluginConfigDefinition(consumer.manifest.config, platform) : undefined;
  if (!definition) return [];
  const context: PluginConfigReferenceContext = { plugin: consumer.manifest.name, platform,
    dependencies: consumer.manifest.dependencies ?? [],
    plugins: Object.fromEntries(plugins.filter((plugin) => plugin.manifest.config).map((plugin) => [plugin.manifest.name, {
      definition: compilePluginConfigDefinition(plugin.manifest.config!, platform), dependencies: plugin.manifest.dependencies ?? [],
    }])) };
  return getPluginConfigDependencyFields(definition, Object.keys(definition.fields), context)
    .filter((entry) => entry.plugin === provider.manifest.name)
    .flatMap(({ field }) => {
      const schema = provider.manifest.config ? compilePluginConfigDefinition(provider.manifest.config, platform).fields[field] : undefined;
      return schema?.type === 'array' && schema.items.type === 'object' && schema.validation?.uniqueBy
        ? [{ field, key: schema.validation.uniqueBy }] : [];
    });
}

export async function resolvePluginConfigReferenceConsumers(options: {
  plugin: PluginMeta;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginMeta[];
}): Promise<PluginMeta[]> {
  const plugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    env: options.env, plugins: options.plugins });
  return [options.plugin, ...plugins.filter((plugin) => plugin.manifest.name !== options.plugin.manifest.name
    && [undefined, ...PLATFORM_TARGETS].some((platform) => providerReferences(plugin, options.plugin, plugins, platform).length > 0))];
}

function rawEffectiveValues(config: ResolvedEffectivePluginConfig): Record<string, unknown> {
  const user = config.stores.user!;
  return Object.fromEntries(Object.entries(config.sources).flatMap(([key, source]) => source === 'missing' ? [] : [[key,
    source === 'default' ? config.schema[key]!.default : source === 'common' ? (user.common ?? user.values)[key]
      : user.platforms?.[config.platform!]?.[key]]]));
}

/** Compare actual reference failures. Existing unrelated errors do not block an incremental repair. */
export async function analyzePluginConfigReferenceMutation(options: {
  plugin: PluginMeta;
  scope: Scope;
  context?: Scope;
  platform?: PlatformTarget;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginMeta[];
  beforeStores: { user: PluginConfigStore; project?: PluginConfigStore };
  afterStores: { user: PluginConfigStore; project?: PluginConfigStore };
}): Promise<{ consumers: PluginConfigReferenceConsumerImpact[]; blockedReferences: string[];
  unreadableConsumers: string[]; removesCandidates: boolean; evidence: unknown[] }> {
  options = { ...options, scope: options.context ?? options.scope };
  const result = { consumers: [] as PluginConfigReferenceConsumerImpact[], blockedReferences: [] as string[],
    unreadableConsumers: [] as string[], removesCandidates: false, evidence: [] as unknown[] };
  const profiles: Array<PlatformTarget | undefined> = options.platform ? [options.platform] : [undefined, ...PLATFORM_TARGETS];
  const potentialFields = profiles.some((platform) => options.plugin.manifest.config
    && Object.values(compilePluginConfigDefinition(options.plugin.manifest.config, platform).fields).some((field) => field.type === 'array' && field.items.type === 'object'));
  if (!potentialFields) return result;
  const identity = { sourceId: options.plugin.sourceId, sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity };
  const canRemove = profiles.some((platform) => Object.entries(compilePluginConfigDefinition(options.plugin.manifest.config!, platform).fields).some(([field, schema]) => {
    if (schema.type !== 'array' || schema.items.type !== 'object') return false;
    const key = schema.validation?.uniqueBy;
    if (!key) return false;
    const value = (stores: typeof options.beforeStores) => {
      const user = stores.user;
      const common = user.common ?? user.values;
      const values = platform ? user.platforms?.[platform] ?? {} : {};
      return Object.hasOwn(values, field) ? values[field] : Object.hasOwn(common, field) ? common[field] : schema.default;
    };
    const before = value(options.beforeStores), after = value(options.afterStores);
    if (!Array.isArray(before)) return false;
    const afterKeys = new Set(Array.isArray(after) ? after.map((row) => JSON.stringify((row as Record<string, unknown>)[key])) : []);
    return before.some((row) => !afterKeys.has(JSON.stringify((row as Record<string, unknown>)[key])));
  }));
  let plugins: PluginMeta[];
  try {
    plugins = await resolvePluginConfigReferencePlugins({ ...identity, env: options.env, plugins: options.plugins });
  } catch {
    if (canRemove) result.unreadableConsumers.push(`Active source ${options.plugin.sourceId ?? '<unbound>'}`);
    result.evidence.push({ sourceId: options.plugin.sourceId, unavailable: true });
    return result;
  }
  const consumers = plugins.filter((plugin) => plugin.manifest.name !== options.plugin.manifest.name
    && [undefined, ...PLATFORM_TARGETS].some((platform) => providerReferences(plugin, options.plugin, plugins, platform).length > 0));
  for (const platform of profiles) {
    const scope = options.scope;
    const resolveProvider = async (stores: typeof options.beforeStores) => {
      const references = pluginConfigHasExternalReferences(options.plugin.manifest)
        ? await resolvePluginConfigReferenceContext({ ...identity, manifest: options.plugin.manifest,
            scope, platform, cwd: options.cwd, env: options.env, plugins,
            storeOverrides: new Map([[options.plugin.manifest.name, stores]]) }) : undefined;
      return resolveEffectivePluginConfigFromStores({ manifest: options.plugin.manifest,
        targetScope: scope, platform, projectRoot: scope === 'project' ? resolveAwProjectRoot(options.cwd) : '', stores,
        referenceContext: references?.context });
    };
    let providerBefore: ResolvedEffectivePluginConfig;
    let providerAfter: ResolvedEffectivePluginConfig;
    try {
      [providerBefore, providerAfter] = await Promise.all([
        resolveProvider(options.beforeStores), resolveProvider(options.afterStores),
      ]);
    } catch {
      if (canRemove) result.unreadableConsumers.push(`${options.plugin.manifest.name} (${platform ?? 'common'}, ${scope} context)`);
      result.evidence.push({ plugin: options.plugin.manifest.name, scope, platform, unavailable: true });
      continue;
    }
    for (const consumer of consumers) {
      const refs = providerReferences(consumer, options.plugin, plugins, platform);
      if (!refs.length) continue;
      const removes = refs.some((ref) => {
        const keys = (config: ResolvedEffectivePluginConfig) => new Set(
          Array.isArray(config.values[ref.field]) ? (config.values[ref.field] as Record<string, unknown>[])
            .map((row) => JSON.stringify(row[ref.key])) : []);
        const afterKeys = keys(providerAfter);
        return [...keys(providerBefore)].some((key) => !afterKeys.has(key));
      });
      result.removesCandidates ||= removes;
      try {
        const consumerIdentity = { sourceId: consumer.sourceId, sourceIdentity: consumer.sourceIdentity,
          logicalIdentity: consumer.catalogLogicalIdentity, pluginName: consumer.manifest.name,
          cwd: options.cwd, env: options.env };
        const user = await readPluginConfigStore({ ...consumerIdentity, scope: 'user', platform });
        const stores = { user };
        const resolveConsumer = async (providerStores: typeof options.beforeStores) => {
          const references = await resolvePluginConfigReferenceContext({ ...identity, manifest: consumer.manifest,
            scope, platform, cwd: options.cwd, env: options.env, plugins,
            storeOverrides: new Map([[options.plugin.manifest.name, providerStores]]) });
          const effective = await resolveEffectivePluginConfigFromStores({ manifest: consumer.manifest,
            targetScope: scope, platform, projectRoot: scope === 'project' ? resolveAwProjectRoot(options.cwd) : '', stores,
            referenceContext: references.context, referenceEvidence: references.evidence });
          return effective;
        };
        const [before, after] = await Promise.all([
          resolveConsumer(options.beforeStores), resolveConsumer(options.afterStores),
        ]);
        const validate = (config: ResolvedEffectivePluginConfig) => {
          const candidate = rawEffectiveValues(config);
          const failures: Array<{ issue: PluginConfigValidationIssue; field: string }> = [];
          for (const field of Object.keys(candidate)) {
            const dependencies = getPluginConfigDependencyFields(config.definition, [field], config.referenceContext);
            if (!dependencies.some((entry) => entry.plugin === options.plugin.manifest.name
              && refs.some((ref) => ref.field === entry.field))) continue;
            for (const issue of validatePluginConfigCandidate(config.definition, candidate, [field], config.referenceContext)) {
              if (!issue.code.startsWith('valueRef')) continue;
              if (!issue.path.plugin || issue.path.plugin === consumer.manifest.name) {
                failures.push({ issue, field: issue.path.field });
              } else if (issue.path.plugin === options.plugin.manifest.name
                && refs.some((ref) => ref.field === issue.path.field)) {
                // Reserved values are reported on the source path, even when the selection is included.
                failures.push({ issue, field });
              }
            }
          }
          return failures;
        };
        const issueKey = ({ issue, field }: ReturnType<typeof validate>[number]) => JSON.stringify([field, issue.code, issue.path]);
        const reported = new Set<string>();
        for (const failure of validate(after)) {
          if (!Object.hasOwn(before.values, failure.field) || reported.has(issueKey(failure))) continue;
          reported.add(issueKey(failure));
          const { issue, field } = failure;
          const segments = issue.path.segments ?? [issue.path.field, ...(issue.path.property ? [issue.path.property] : [])];
          const foreign = issue.path.plugin && issue.path.plugin !== consumer.manifest.name;
          let selected: unknown = foreign ? after.referenceContext?.plugins[issue.path.plugin!]?.values
            : rawEffectiveValues(after);
          for (const segment of segments) selected = selected && typeof selected === 'object'
            ? (selected as Record<string | number, unknown>)[segment] : undefined;
          result.blockedReferences.push(`${options.plugin.manifest.name}${foreign ? `/${issue.path.field}` : ''}: key ${JSON.stringify(selected)}; `
            + `${consumer.manifest.name}/${field} (${platform ?? 'common'}, ${scope} context): ${formatPluginConfigIssue(issue)}`);
        }
        result.consumers.push({ plugin: consumer, scope, platform, before, after });
        result.evidence.push({ plugin: consumer.manifest.name, scope, platform,
          definition: consumer.manifest.config, identity: consumerIdentity,
          stores: Object.fromEntries(Object.entries(stores).map(([layer, store]) => [layer,
            { exists: store.exists, state: store.state, rawDigest: store.rawDigest }])),
          references: before.referenceEvidence });
      } catch {
        const location = `${consumer.manifest.name} (${platform ?? 'common'}, ${scope} context)`;
        result.consumers.push({ plugin: consumer, scope, platform, error: location });
        if (removes) result.unreadableConsumers.push(location);
        result.evidence.push({ plugin: consumer.manifest.name, scope, platform, unreadable: true, definition: consumer.manifest.config });
      }
    }
  }
  return result;
}
