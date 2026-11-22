import crypto from 'node:crypto';

import {
  selectPluginConfigProfile,
  PLATFORM_TARGETS,
  NATIVE_PLATFORM_TARGETS,
  type PlatformTarget,
  supportsPlatform,
  getCommandPackageId,
  type ProducerIdentity,
  getPluginConfigDependencyKeys,
  stablePluginConfigStringify,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  PlatformName,
  PluginMeta,
  ReceiptTargetIdentity,
  Scope,
} from '../types.js';
import { ManagedCommandError, managedCommandDiagnostic, readManagedCommandPackage, readManagedCommandPackageView } from './managed-command-store.js';
import {
  coercePluginConfigUpdates,
  readPluginConfigStore,
  replacePluginConfigStoreLayer,
  resolveAwProjectRoot,
  resolveEffectivePluginConfigFromStores,
  type PluginConfigStore,
  type PluginConfigValue,
  type ResolvedEffectivePluginConfig,
} from './plugin-config.js';
import {
  analyzePluginConfigReferenceMutation,
  collectPluginConfigReferenceEvidence,
  pluginConfigHasExternalReferences,
  resolvePluginConfigReferenceContext,
  resolvePluginConfigReferenceConsumers,
} from './plugin-config-references.js';
import { getProfileRenderScopes } from '../platforms/layout.js';

export type PluginConfigImpactMutation =
  | {
      kind: 'patch';
      updates?: Record<string, unknown>;
      removeKeys?: string[];
    }
  | { kind: 'reset' };

export interface PluginConfigImpactSharedNativeRenderUnit {
  pluginName: string;
  platform: PlatformName;
  renderScope: 'user';
  configKeys: string[];
  dynamicComponents: boolean;
}

export interface ConfigCommandPackage {
  producer: ProducerIdentity;
  packageId: string;
  refreshKeys: string[];
  runtimeConfigKeys: string[];
  runtimeConfigPlatforms: PlatformName[];
  availability?: 'ready' | 'empty' | 'unavailable';
  subcommands?: string[];
  hasFallback?: boolean;
  declared: boolean;
  installed: boolean;
}

export interface ManagedCommandPackageDiscovery {
  packages: ConfigCommandPackage[];
  errors: Array<ReturnType<typeof managedCommandDiagnostic>>;
}

export interface PluginConfigMutationImpact {
  impactState: 'known' | 'unknown';
  noEffectiveChange: boolean;
  storeChanged: boolean;
  storeDigest: string;
  changedKeys: string[];
  updatedKeys: string[];
  removedKeys: string[];
  staleRemovedKeys: string[];
  affectedTargets: ReceiptTargetIdentity[];
  sharedNativeRenderUnits: PluginConfigImpactSharedNativeRenderUnit[];
  commandPackages: ManagedCommandPackageDiscovery['packages'];
  affectedCommandPackages: ManagedCommandPackageDiscovery['packages'];
  commandDiscoveryErrors: ManagedCommandPackageDiscovery['errors'];
  referenceBlockers?: string[];
  referenceWarnings?: string[];
}

/** Config apply can refresh a shared package even without a visible platform deployment. */
export async function discoverPluginConfigManagedCommandPackages(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platformTargets?: readonly ReceiptTargetIdentity[];
  referencePlugins?: readonly PluginMeta[];
}): Promise<ManagedCommandPackageDiscovery> {
  let plugins: PluginMeta[];
  const errors: ManagedCommandPackageDiscovery['errors'] = [];
  try {
    plugins = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env,
      plugins: options.referencePlugins });
  } catch {
    plugins = [options.plugin];
    errors.push({ code: 'commandDependencyDiscoveryFailed', message: 'The command packages of configuration consumers cannot be discovered.' });
  }
  const packages = new Map<string, ManagedCommandPackageDiscovery['packages'][number]>();
  for (const plugin of plugins) {
    if (!plugin.sourceId || !plugin.sourceIdentity) continue;
    const producer = { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, pluginName: plugin.manifest.name };
    const packageId = getCommandPackageId(producer);
    try {
      const view = await readManagedCommandPackageView(packageId, options.env);
      const record = view.routes === null ? undefined : await readManagedCommandPackage(producer, options.env, { validateFiles: false });
      const command = plugin.manifest.command;
      packages.set(packageId, { producer, packageId,
        refreshKeys: [...new Set([...(command?.mode === 'dynamic' ? command.refreshKeys : []), ...record?.record.dynamicRefreshKeys ?? []])],
        runtimeConfigKeys: [...new Set([...command?.runtimeConfig?.keys ?? [], ...record?.record.runtimeConfigKeys ?? []])],
        runtimeConfigPlatforms: view.runtimeConfigPlatforms, declared: command !== undefined, installed: true,
        availability: view.availability, subcommands: view.subcommands, hasFallback: view.hasFallback });
    } catch (error) {
      if (error instanceof ManagedCommandError && error.code === 'commandNotFound') continue;
      errors.push(managedCommandDiagnostic(error, `${producer.sourceId}/${producer.pluginName}`));
    }
  }
  return { packages: [...packages.values()], errors: [...new Map(errors.map((error) => [JSON.stringify(error), error])).values()] };
}

function configIdentity(plugin: PluginMeta): {
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
} {
  return plugin.sourceId ? {
    sourceId: plugin.sourceId,
    sourceIdentity: plugin.sourceIdentity,
    logicalIdentity: plugin.catalogLogicalIdentity,
  } : {};
}

function targetKey(target: ReceiptTargetIdentity): string {
  return `${target.pluginName}\0${target.platform}\0${target.scope}\0${target.projectKey ?? ''}`;
}

function dedupeTargets(targets: readonly ReceiptTargetIdentity[]): ReceiptTargetIdentity[] {
  const output = new Map<string, ReceiptTargetIdentity>();
  for (const target of targets) output.set(targetKey(target), target);
  return [...output.values()];
}

function configValuesEqual(
  left: Record<string, PluginConfigValue>,
  right: Record<string, PluginConfigValue>,
  keys: readonly string[] = [...new Set([...Object.keys(left), ...Object.keys(right)])],
): boolean {
  return keys.every((key) => {
    const leftHas = Object.hasOwn(left, key);
    const rightHas = Object.hasOwn(right, key);
    return leftHas === rightHas
      && (!leftHas || stablePluginConfigStringify(left[key]!) === stablePluginConfigStringify(right[key]!));
  });
}

function storeEvidence(store: PluginConfigStore): {
  exists: boolean;
  state: PluginConfigStore['state'];
  rawDigest?: string;
} {
  return {
    exists: store.exists,
    state: store.state,
    ...(store.rawDigest ? { rawDigest: store.rawDigest } : {}),
  };
}

function digestStores(stores: {
  user: PluginConfigStore;
  project?: PluginConfigStore;
}): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    user: storeEvidence(stores.user),
    ...(stores.project ? { project: storeEvidence(stores.project) } : {}),
  })).digest('hex')}`;
}

interface ConfigRenderConsumer {
  pluginName: string;
  platform: ReceiptTargetIdentity['platform'];
  scope: Scope;
  configKeys: string[];
  dynamicComponents: boolean;
}

function targetConfigConsumers(plugin: PluginMeta, target: ReceiptTargetIdentity): ConfigRenderConsumer[] {
  if (!supportsPlatform(plugin.manifest, target.platform)) return [];
  const scopes = getProfileRenderScopes(target.platform, target.scope);
  const artifacts = plugin.manifest.artifacts;
  return artifacts ? scopes
    .filter((scope) => !artifacts.scopes || artifacts.scopes.includes(scope))
    .map((scope) => ({ pluginName: plugin.manifest.name, platform: target.platform, scope,
      configKeys: artifacts.configKeys, dynamicComponents: true })) : [];
}

/** Render scopes come from the fixed platform layout, independently of the previous component set. */
export function pluginConfigTargetRenderScopes(_plugin: PluginMeta, target: ReceiptTargetIdentity): Scope[] {
  return getProfileRenderScopes(target.platform, target.scope);
}

function addSharedNativeConsumer(output: Map<string, PluginConfigImpactSharedNativeRenderUnit>, consumer: ConfigRenderConsumer): void {
  if (consumer.scope !== 'user'
    || !getProfileRenderScopes(consumer.platform, 'project').includes('user')) return;
  const key = `${consumer.pluginName}\0${consumer.platform}`;
  const previous = output.get(key);
  output.set(key, { pluginName: consumer.pluginName, platform: consumer.platform, renderScope: 'user',
    configKeys: [...new Set([...(previous?.configKeys ?? []), ...consumer.configKeys])],
    dynamicComponents: previous?.dynamicComponents === true || consumer.dynamicComponents });
}

export function pluginSharedNativeConfigRenderUnits(plugin: PluginMeta): PluginConfigImpactSharedNativeRenderUnit[] {
  const units = new Map<string, PluginConfigImpactSharedNativeRenderUnit>();
  for (const platform of NATIVE_PLATFORM_TARGETS) {
    for (const consumer of targetConfigConsumers(plugin, { pluginName: plugin.manifest.name, platform, scope: 'user' })) {
      if (consumer.configKeys.length > 0) addSharedNativeConsumer(units, consumer);
    }
  }
  return [...units.values()];
}

function rendererProjectionEqual(
  before: ResolvedEffectivePluginConfig,
  after: ResolvedEffectivePluginConfig,
  refreshKeys: readonly string[],
): boolean {
  const keys = new Set(refreshKeys);
  if (!configValuesEqual(before.values, after.values, refreshKeys)) return false;
  if ([...keys].some((key) => before.sources[key] !== after.sources[key])) return false;
  const issueProjection = (config: ResolvedEffectivePluginConfig) => config.issues
    .filter((issue) => keys.has(issue.key))
    .map((issue) => JSON.stringify(issue))
    .sort((left, right) => left.localeCompare(right, 'en'));
  return JSON.stringify(issueProjection(before)) === JSON.stringify(issueProjection(after));
}

function unknownImpact(options: {
  stores: { user: PluginConfigStore; project?: PluginConfigStore };
  plugin: PluginMeta;
  scope: Scope;
  visibleTargets: readonly ReceiptTargetIdentity[];
  storeChanged: boolean;
  changedKeys: string[];
  updatedKeys: string[];
  removedKeys: string[];
  staleRemovedKeys: string[];
  commands: ManagedCommandPackageDiscovery;
  plugins?: readonly PluginMeta[];
}): PluginConfigMutationImpact {
  const affectedTargets = dedupeTargets(options.visibleTargets);
  const sharedNativeRenderUnits = new Map<string, PluginConfigImpactSharedNativeRenderUnit>();
  for (const target of affectedTargets) {
    const plugin = target.pluginName === options.plugin.manifest.name ? options.plugin
      : options.plugins?.find((entry) => entry.manifest.name === target.pluginName);
    if (!plugin) continue;
    for (const consumer of targetConfigConsumers(plugin, target)) {
      if (consumer.configKeys.length > 0) addSharedNativeConsumer(sharedNativeRenderUnits, consumer);
    }
  }
  return {
    impactState: 'unknown',
    noEffectiveChange: false,
    storeChanged: options.storeChanged,
    storeDigest: digestStores(options.stores),
    changedKeys: options.changedKeys,
    updatedKeys: options.updatedKeys,
    removedKeys: options.removedKeys,
    staleRemovedKeys: options.staleRemovedKeys,
    affectedTargets,
    sharedNativeRenderUnits: [...sharedNativeRenderUnits.values()],
    commandPackages: options.commands.packages,
    affectedCommandPackages: options.commands.packages,
    commandDiscoveryErrors: options.commands.errors,
  };
}

export async function analyzePluginConfigMutationImpact(options: {
  plugin: PluginMeta; scope: Scope; context?: Scope; platform?: PlatformTarget; cwd: string; env?: NodeJS.ProcessEnv;
  visibleTargets: readonly ReceiptTargetIdentity[]; mutation: PluginConfigImpactMutation;
  commandDiscovery?: ManagedCommandPackageDiscovery; referencePlugins?: readonly PluginMeta[];
}): Promise<PluginConfigMutationImpact> {
  options = { ...options, scope: options.context ?? options.scope };
  const commands = options.commandDiscovery ?? await discoverPluginConfigManagedCommandPackages({ ...options,
    env: options.env ?? process.env, platformTargets: options.visibleTargets });
  const schema = options.plugin.manifest.config ? selectPluginConfigProfile(options.plugin.manifest.config, options.platform).fields : undefined;
  const identity = configIdentity(options.plugin);
  let user: PluginConfigStore;
  try { user = await readPluginConfigStore({ ...identity, pluginName: options.plugin.manifest.name,
    scope: 'user', platform: options.platform, cwd: options.cwd, env: options.env }); }
  catch { user = { path: '', exists: true, state: 'invalid', values: {}, invalidCode: 'invalidValues', issues: ['The store cannot be read.'] }; }
  const stores = { user };
  const requestedRemoveKeys = [...new Set(options.mutation.kind === 'patch' ? options.mutation.removeKeys ?? [] : [])];
  const updates = options.mutation.kind === 'patch' && schema ? await coercePluginConfigUpdates({ schema,
    updates: options.mutation.updates ?? {}, cwd: options.cwd }) : {};
  if (options.mutation.kind === 'patch' && schema && user.state !== 'invalid') {
    for (const key of requestedRemoveKeys) if (!schema[key] && !Object.hasOwn(user.values, key)) throw new Error(`Unknown config key "${key}".`);
  }
  const removedKeys = options.mutation.kind === 'reset' ? Object.keys(user.values)
    : requestedRemoveKeys.filter((key) => Object.hasOwn(user.values, key));
  const updatedKeys = Object.entries(updates).filter(([key, value]) => !Object.hasOwn(user.values, key)
    || stablePluginConfigStringify(user.values[key]!) !== stablePluginConfigStringify(value)).map(([key]) => key);
  const staleRemovedKeys = removedKeys.filter((key) => !schema?.[key]);
  const changedKeys = [...updatedKeys, ...removedKeys];
  const storeChanged = user.state === 'invalid' ? options.mutation.kind === 'reset' && user.exists || options.mutation.kind === 'patch'
    : changedKeys.length > 0;
  const visibleTargets = options.visibleTargets.filter((target) => (!options.platform || target.platform === options.platform)
    && (options.scope === 'project' || target.scope === 'user'));
  const selectedCommands = { ...commands, packages: commands.packages.filter((target) => !options.platform
    || target.runtimeConfigKeys.length > 0) };
  let plugins: PluginMeta[];
  let currentReferences: unknown;
  try {
    plugins = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env, plugins: options.referencePlugins });
    const profiles = plugins.flatMap((plugin) => (options.platform ? [options.platform] : [undefined, ...PLATFORM_TARGETS])
      .map((platform) => ({ pluginName: plugin.manifest.name, scope: options.scope, platform })));
    currentReferences = await collectPluginConfigReferenceEvidence({ plugin: options.plugin, plugins,
      profiles, cwd: options.cwd, env: options.env });
  } catch {
    plugins = [options.plugin];
    currentReferences = { sourceUnavailable: true };
  }
  const currentStoreDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ stores: digestStores(stores),
    platform: options.platform ?? null, references: currentReferences })).digest('hex')}`;
  if (!schema || user.state === 'invalid') return { ...unknownImpact({ ...options, commands: selectedCommands, stores,
    visibleTargets, storeChanged, changedKeys, updatedKeys, removedKeys, staleRemovedKeys, plugins }), storeDigest: currentStoreDigest };
  if (!storeChanged) return { impactState: commands.errors.length ? 'unknown' : 'known', noEffectiveChange: true,
    storeChanged: false, storeDigest: currentStoreDigest, changedKeys: [], updatedKeys: [], removedKeys: [], staleRemovedKeys: [],
    affectedTargets: [], sharedNativeRenderUnits: [], commandPackages: selectedCommands.packages, affectedCommandPackages: [], commandDiscoveryErrors: commands.errors };
  const values = options.mutation.kind === 'reset' ? {} : { ...user.values };
  if (options.mutation.kind === 'patch') {
    for (const key of requestedRemoveKeys) delete values[key];
    for (const [key, value] of Object.entries(updates)) values[key] = value;
  }
  const afterStores = { user: replacePluginConfigStoreLayer(user, values, options.platform) };
  const referenceImpact = await analyzePluginConfigReferenceMutation({ ...options, plugins: options.referencePlugins,
    beforeStores: stores, afterStores });
  const referenceWarnings: string[] = [];
  const resolved = new Map<string, { before: ResolvedEffectivePluginConfig; after: ResolvedEffectivePluginConfig }>();
  const resolveProfile = async (platform?: PlatformTarget) => {
    const key = platform ?? 'common';
    if (resolved.has(key)) return resolved.get(key)!;
    const references = pluginConfigHasExternalReferences(options.plugin.manifest)
      ? await resolvePluginConfigReferenceContext({ ...identity, manifest: options.plugin.manifest, scope: options.scope,
        platform, cwd: options.cwd, env: options.env, plugins: options.referencePlugins }) : undefined;
    if (references) referenceImpact.evidence.push({ platform: platform ?? null, references: references.evidence });
    const resolve = (candidate: typeof stores) => resolveEffectivePluginConfigFromStores({ manifest: options.plugin.manifest,
      platform, targetScope: options.scope, projectRoot: options.scope === 'project' ? resolveAwProjectRoot(options.cwd) : '', stores: candidate,
      referenceContext: references?.context });
    const [before, after] = await Promise.all([resolve(stores), resolve(afterStores)]);
    const pair = { before, after }; resolved.set(key, pair); return pair;
  };
  const consumerPair = (pluginName: string, platform?: PlatformTarget) => pluginName === options.plugin.manifest.name
    ? resolveProfile(platform) : Promise.resolve(referenceImpact.consumers.find((consumer) => consumer.plugin.manifest.name === pluginName && consumer.platform === platform));
  const allPlugins = new Map([options.plugin, ...referenceImpact.consumers.map((entry) => entry.plugin)].map((plugin) => [plugin.manifest.name, plugin]));
  const affectedTargets: ReceiptTargetIdentity[] = [];
  const affectedCommandPackages: ManagedCommandPackageDiscovery['packages'] = [];
  const sharedNativeRenderUnits = new Map<string, PluginConfigImpactSharedNativeRenderUnit>();
  try {
    for (const target of dedupeTargets(visibleTargets)) {
      const plugin = allPlugins.get(target.pluginName);
      if (!plugin?.manifest.config) continue;
      const pair = await consumerPair(target.pluginName, target.platform);
      let affected = !pair?.before || !pair.after;
      if (pair?.before && pair.after && (plugin.manifest.scripts?.preApply || plugin.manifest.dependencies?.length)) {
        affected ||= !configValuesEqual(pair.before.values, pair.after.values);
      }
      for (const consumer of targetConfigConsumers(plugin, target)) {
        if (!consumer.configKeys.length) continue;
        const keys = getPluginConfigDependencyKeys(selectPluginConfigProfile(plugin.manifest.config, target.platform), consumer.configKeys);
        if (pair?.before && pair.after && rendererProjectionEqual(pair.before, pair.after, keys)) continue;
        affected = true; addSharedNativeConsumer(sharedNativeRenderUnits, consumer);
      }
      if (affected) affectedTargets.push(target);
    }
    for (const target of selectedCommands.packages) {
      const plugin = allPlugins.get(target.producer.pluginName);
      if (!plugin?.manifest.config) continue;
      const command = plugin.manifest.command;
      const matches = async (keys: string[], platform?: PlatformTarget) => {
        const definition = selectPluginConfigProfile(plugin.manifest.config!, platform);
        const declared = keys.filter((key) => Object.hasOwn(definition.fields, key));
        if (declared.length === 0) return false;
        const pair = await consumerPair(target.producer.pluginName, platform);
        if (!pair?.before || !pair.after) return false;
        return !rendererProjectionEqual(pair.before, pair.after, getPluginConfigDependencyKeys(definition, declared));
      };
      const routesChanged = !options.platform && await matches(target.refreshKeys);
      const runtimeChanged = options.platform
        ? options.platform !== 'generic' && (command?.platforms.includes(options.platform) ?? target.runtimeConfigPlatforms.includes(options.platform)) && await matches(target.runtimeConfigKeys, options.platform)
        : await matches(target.runtimeConfigKeys)
          || (target.producer.pluginName === options.plugin.manifest.name && target.runtimeConfigPlatforms.some((platform) => {
            const definition = selectPluginConfigProfile(plugin.manifest.config!, platform);
            const keys = target.runtimeConfigKeys.filter((key) => Object.hasOwn(definition.fields, key));
            return getPluginConfigDependencyKeys(definition, keys).some((key) => changedKeys.includes(key));
          }))
          || (await Promise.all(target.runtimeConfigPlatforms.map((platform) => matches(target.runtimeConfigKeys, platform)))).some(Boolean);
      if (routesChanged || runtimeChanged) affectedCommandPackages.push(target);
      if (routesChanged) for (const visible of visibleTargets) {
        if (visible.pluginName === target.producer.pluginName && command?.platforms.includes(visible.platform)) affectedTargets.push(visible);
      }
    }
    // Common edits bind every supported profile even when no installed output currently consumes it.
    for (const platform of options.platform ? [options.platform] : [undefined, ...PLATFORM_TARGETS]) {
      try { await resolveProfile(platform); }
      catch { referenceWarnings.push(`${platform ?? 'common'} configuration reference impact is unknown.`); }
    }
    const storeDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({ stores: digestStores(stores),
      platform: options.platform ?? null, references: currentReferences, mutationReferences: referenceImpact.evidence })).digest('hex')}`;
    return { impactState: commands.errors.length || referenceWarnings.length ? 'unknown' : 'known',
      noEffectiveChange: !affectedTargets.length && !affectedCommandPackages.length && !commands.errors.length,
      storeChanged, storeDigest, changedKeys, updatedKeys, removedKeys, staleRemovedKeys, affectedTargets: dedupeTargets(affectedTargets),
      sharedNativeRenderUnits: [...sharedNativeRenderUnits.values()], commandPackages: selectedCommands.packages,
      affectedCommandPackages, commandDiscoveryErrors: commands.errors, referenceWarnings,
      referenceBlockers: [...referenceImpact.blockedReferences, ...referenceImpact.unreadableConsumers.map((location) => `Cannot check config references in ${location}.`)] };
  } catch {
    return { ...unknownImpact({ ...options, visibleTargets, commands: selectedCommands, stores, storeChanged,
      changedKeys, updatedKeys, removedKeys, staleRemovedKeys, plugins: [...allPlugins.values()] }), storeDigest: currentStoreDigest, referenceWarnings,
      referenceBlockers: [...referenceImpact.blockedReferences, ...referenceImpact.unreadableConsumers.map((location) => `Cannot check config references in ${location}.`)] };
  }
}
