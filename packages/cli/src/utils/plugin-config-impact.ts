import crypto from 'node:crypto';

import {
  canonicalizePluginConfigValues,
  getManagedCommandArtifactTargets,
  getPluginConfigDependencyKeys,
  stablePluginConfigStringify,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  PluginArtifactTargetDefinition,
  PlatformName,
  PluginMeta,
  ReceiptTargetIdentity,
  Scope,
} from '../types.js';
import {
  discoverInstalledPluginManagedCommandPackages,
  type ManagedCommandPackageDiscovery,
} from './managed-command-materialization.js';
import {
  coercePluginConfigUpdates,
  readPluginConfigStore,
  resolveAwProjectRoot,
  resolveEffectivePluginConfigFromStores,
  type PluginConfigStore,
  type PluginConfigValue,
  type ResolvedEffectivePluginConfig,
} from './plugin-config.js';
import {
  analyzePluginConfigReferenceMutation,
  pluginConfigHasExternalReferences,
  resolvePluginConfigReferenceContext,
  resolvePluginConfigReferenceConsumers,
} from './plugin-config-references.js';

export type PluginConfigImpactMutation =
  | {
      kind: 'patch';
      updates?: Record<string, unknown>;
      removeKeys?: string[];
    }
  | { kind: 'reset' };

export interface PluginConfigImpactSharedNativeTarget {
  pluginName?: string;
  id: string;
  skillKey: string;
  refreshKeys: string[];
  platform?: PlatformName;
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
  sharedNativeRenderTargets: PluginConfigImpactSharedNativeTarget[];
  commandPackages: ManagedCommandPackageDiscovery['packages'];
  affectedCommandPackages: ManagedCommandPackageDiscovery['packages'];
  commandDiscoveryErrors: ManagedCommandPackageDiscovery['errors'];
  referenceBlockers?: string[];
  referenceWarnings?: string[];
}

/** Installed producer markers and the actual platform plan define the visible package set. */
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
  const discoveries = await Promise.all(plugins.map((plugin) => discoverInstalledPluginManagedCommandPackages({
    plugin, scope: options.scope, cwd: options.cwd, env: options.env,
    platformTargets: options.platformTargets?.filter((target) => target.pluginName === plugin.manifest.name),
  })));
  const packages = new Map<string, ManagedCommandPackageDiscovery['packages'][number]>();
  for (const discovery of discoveries) {
    for (const target of discovery.packages) packages.set(target.packageId, target);
    errors.push(...discovery.errors);
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

function cloneStore(
  store: PluginConfigStore,
  values: Record<string, PluginConfigValue>,
): PluginConfigStore {
  const canonical = canonicalizePluginConfigValues(values);
  return {
    path: store.path,
    exists: Object.keys(canonical).length > 0,
    state: Object.keys(canonical).length > 0 ? 'ready' : 'missing',
    values: canonical,
    issues: [],
  };
}

function targetArtifactDeclarations(plugin: PluginMeta, target: ReceiptTargetIdentity) {
  return (plugin.manifest.artifacts?.targets ?? []).filter((declaration) =>
    declaration.platform === target.platform
    && (declaration.target === 'codex.skill'
      && declaration.delivery.mode === 'codex-native'
      || declaration.scopes.includes(target.scope)));
}

function nativeDeclaration(declaration: PluginArtifactTargetDefinition):
declaration is typeof declaration & {
  target: 'codex.skill';
  delivery: { mode: 'codex-native'; identity: 'shared'; renderProfile: 'user' };
  skillKey: string;
} {
  return declaration.target === 'codex.skill'
    && declaration.delivery.mode === 'codex-native'
    && typeof declaration.skillKey === 'string';
}

function targetConfigConsumers(plugin: PluginMeta, target: ReceiptTargetIdentity) {
  const consumers = targetArtifactDeclarations(plugin, target).map((declaration) => ({
    pluginName: plugin.manifest.name,
    id: declaration.id,
    refreshKeys: declaration.refreshKeys,
    scope: nativeDeclaration(declaration) ? 'user' as const : target.scope,
    sharedNativeSkillKey: nativeDeclaration(declaration) ? declaration.skillKey : undefined,
    platform: target.platform,
  }));
  for (const declaration of getManagedCommandArtifactTargets(plugin.manifest)) {
    if (declaration.target !== 'aw.command-set' || declaration.platform !== target.platform) continue;
    const producer = declaration.producer;
    if (producer.kind === 'package') continue;
    const artifact = producer.kind === 'artifact'
      ? plugin.manifest.artifacts?.targets?.find((entry) => entry.id === producer.artifactId)
      : undefined;
    const sharedNativeSkillKey = producer.kind === 'static-skill'
      ? producer.skillKey : artifact && nativeDeclaration(artifact) ? artifact.skillKey : undefined;
    if (!sharedNativeSkillKey && !declaration.scopes.includes(target.scope)) continue;
    consumers.push({
      pluginName: plugin.manifest.name,
      id: artifact?.id ?? declaration.id,
      refreshKeys: declaration.refreshKeys,
      scope: sharedNativeSkillKey ? 'user' : target.scope,
      sharedNativeSkillKey,
      platform: target.platform,
    });
  }
  return consumers;
}

/** Activation scope can differ from the profile used to render shared native content. */
export function pluginConfigTargetRenderScopes(plugin: PluginMeta, target: ReceiptTargetIdentity): Scope[] {
  const consumers = targetConfigConsumers(plugin, target).filter((consumer) => consumer.refreshKeys.length > 0);
  return consumers.length ? [...new Set(consumers.map((consumer) => consumer.scope))] : [target.scope];
}

function addSharedNativeConsumer(
  output: Map<string, PluginConfigImpactSharedNativeTarget>,
  consumer: ReturnType<typeof targetConfigConsumers>[number],
): void {
  if (!consumer.sharedNativeSkillKey) return;
  const key = `${consumer.pluginName}\0${consumer.platform}\0${consumer.id}`;
  const previous = output.get(key);
  output.set(key, { id: consumer.id, pluginName: consumer.pluginName, skillKey: consumer.sharedNativeSkillKey,
    ...(consumer.platform === 'claude' ? { platform: 'claude' } : {}),
    refreshKeys: [...new Set([...(previous?.refreshKeys ?? []), ...consumer.refreshKeys])] });
}

export function pluginSharedNativeConfigTargets(plugin: PluginMeta): PluginConfigImpactSharedNativeTarget[] {
  const targets = new Map<string, PluginConfigImpactSharedNativeTarget>();
  for (const platform of ['codex', 'claude'] as const) {
    for (const consumer of targetConfigConsumers(plugin, { pluginName: plugin.manifest.name, platform, scope: 'user' })) {
      if (consumer.refreshKeys.length > 0) addSharedNativeConsumer(targets, consumer);
    }
  }
  return [...targets.values()];
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
  const sharedNativeRenderTargets = new Map<string, PluginConfigImpactSharedNativeTarget>();
  for (const target of affectedTargets) {
    if (options.scope !== 'user') continue;
    const plugin = target.pluginName === options.plugin.manifest.name ? options.plugin
      : options.plugins?.find((entry) => entry.manifest.name === target.pluginName);
    if (!plugin) continue;
    for (const consumer of targetConfigConsumers(plugin, target)) {
      if (consumer.refreshKeys.length > 0) addSharedNativeConsumer(sharedNativeRenderTargets, consumer);
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
    sharedNativeRenderTargets: [...sharedNativeRenderTargets.values()],
    commandPackages: options.commands.packages,
    affectedCommandPackages: options.commands.packages,
    commandDiscoveryErrors: options.commands.errors,
  };
}

export async function analyzePluginConfigMutationImpact(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  visibleTargets: readonly ReceiptTargetIdentity[];
  mutation: PluginConfigImpactMutation;
  commandDiscovery?: ManagedCommandPackageDiscovery;
  referencePlugins?: readonly PluginMeta[];
}): Promise<PluginConfigMutationImpact> {
  const commands = options.commandDiscovery ?? await discoverPluginConfigManagedCommandPackages({
    plugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env ?? process.env,
    platformTargets: options.visibleTargets,
    referencePlugins: options.referencePlugins,
  });
  const schema = options.plugin.manifest.config?.fields;
  const needsProjectStore = options.scope === 'project'
    || options.scope === 'user'
    || options.visibleTargets.some((target) => target.scope === 'project')
    || commands.packages.some((target) => target.producer.scope === 'project');
  const identity = configIdentity(options.plugin);
  const readStore = async (scope: Scope): Promise<PluginConfigStore> => {
    try {
      return await readPluginConfigStore({
        ...identity,
        pluginName: options.plugin.manifest.name,
        scope,
        cwd: options.cwd,
        env: options.env,
        schema,
      });
    } catch {
      return {
        path: '',
        exists: true,
        state: 'invalid',
        values: {},
        invalidCode: 'invalidValues',
        issues: ['The store cannot be read.'],
      };
    }
  };
  const [userStore, projectStore] = await Promise.all([
    readStore('user'),
    needsProjectStore
      ? readStore('project')
      : undefined,
  ]);
  const stores = { user: userStore, ...(projectStore ? { project: projectStore } : {}) };
  const editedStore = options.scope === 'user' ? userStore : projectStore!;
  const requestedRemoveKeys = [...new Set(
    options.mutation.kind === 'patch' ? options.mutation.removeKeys ?? [] : [],
  )];
  let updatedKeys: string[] = [];
  let removedKeys: string[] = [];
  let staleRemovedKeys: string[] = [];
  let coercedUpdates: Record<string, PluginConfigValue> = {};
  let storeChanged = options.mutation.kind === 'reset' && editedStore.exists;

  if (editedStore.state !== 'invalid' && options.mutation.kind === 'reset') {
    removedKeys = Object.keys(editedStore.values);
    staleRemovedKeys = schema
      ? removedKeys.filter((key) => !schema[key])
      : [...removedKeys];
  }
  if (editedStore.state !== 'invalid' && options.mutation.kind === 'patch' && schema) {
    coercedUpdates = await coercePluginConfigUpdates({
      schema,
      updates: options.mutation.updates ?? {},
      cwd: options.cwd,
    });
    for (const key of requestedRemoveKeys) {
      if (!schema[key] && !Object.hasOwn(editedStore.values, key)) {
        throw new Error(`Unknown config key "${key}".`);
      }
    }
    removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(editedStore.values, key));
    staleRemovedKeys = removedKeys.filter((key) => !schema[key]);
    updatedKeys = Object.entries(coercedUpdates)
      .filter(([key, value]) => !Object.hasOwn(editedStore.values, key)
        || stablePluginConfigStringify(editedStore.values[key]!)
          !== stablePluginConfigStringify(value))
      .map(([key]) => key);
    storeChanged = updatedKeys.length > 0 || removedKeys.length > 0;
  }
  const changedKeys = [...updatedKeys, ...removedKeys];
  if (!schema || editedStore.state === 'invalid') {
    return unknownImpact({
      plugins: await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env, plugins: options.referencePlugins }),
      commands,
      stores,
      plugin: options.plugin,
      scope: options.scope,
      visibleTargets: options.visibleTargets,
      storeChanged: options.mutation.kind === 'reset' ? editedStore.exists : true,
      changedKeys: changedKeys.length > 0
        ? changedKeys
        : options.mutation.kind === 'patch'
          ? [...Object.keys(options.mutation.updates ?? {}), ...requestedRemoveKeys]
          : [],
      updatedKeys,
      removedKeys,
      staleRemovedKeys,
    });
  }
  if (!storeChanged) {
    return {
      impactState: commands.errors.length > 0 ? 'unknown' : 'known',
      noEffectiveChange: true,
      storeChanged: false,
      storeDigest: digestStores(stores),
      changedKeys: [],
      updatedKeys: [],
      removedKeys: [],
      staleRemovedKeys: [],
      affectedTargets: [],
      sharedNativeRenderTargets: [],
      commandPackages: commands.packages,
      affectedCommandPackages: [],
      commandDiscoveryErrors: commands.errors,
    };
  }

  const nextValues = options.mutation.kind === 'reset' ? {} : { ...editedStore.values };
  if (options.mutation.kind === 'patch') {
    for (const key of requestedRemoveKeys) delete nextValues[key];
    for (const [key, value] of Object.entries(coercedUpdates)) nextValues[key] = value;
  }
  const afterStores = {
    user: options.scope === 'user' ? cloneStore(userStore, nextValues) : userStore,
    ...(projectStore ? {
      project: options.scope === 'project' ? cloneStore(projectStore, nextValues) : projectStore,
    } : {}),
  };
  const projectRoot = resolveAwProjectRoot(options.cwd);
  const referenceImpact = await analyzePluginConfigReferenceMutation({ plugin: options.plugin,
    scope: options.scope, cwd: options.cwd, env: options.env, plugins: options.referencePlugins,
    beforeStores: stores, afterStores });
  const referenceWarnings: string[] = [];
  if (pluginConfigHasExternalReferences(options.plugin.manifest)) {
    for (const scope of needsProjectStore ? ['user', 'project'] as const : ['user'] as const) {
      try {
        const references = await resolvePluginConfigReferenceContext({ ...identity, manifest: options.plugin.manifest,
          scope, cwd: options.cwd, env: options.env, plugins: options.referencePlugins });
        referenceImpact.evidence.push({ scope, references: references.evidence });
      } catch (error) {
        referenceImpact.evidence.push({ scope, unavailable: true,
          references: (error as { referenceEvidence?: unknown }).referenceEvidence });
        referenceWarnings.push(`${scope} config reference impact is unknown because its dependencies cannot be read.`);
      }
    }
  }
  const referenceDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    stores: digestStores(stores), references: referenceImpact.evidence,
  })).digest('hex')}`;
  const resolved = new Map<Scope, {
    before: ResolvedEffectivePluginConfig;
    after: ResolvedEffectivePluginConfig;
  }>();
  const resolveScope = async (scope: Scope) => {
    const existing = resolved.get(scope);
    if (existing) return existing;
    const references = pluginConfigHasExternalReferences(options.plugin.manifest)
      ? await resolvePluginConfigReferenceContext({ ...identity, manifest: options.plugin.manifest,
          scope, cwd: options.cwd, env: options.env, plugins: options.referencePlugins }) : undefined;
    const pair = {
      before: await resolveEffectivePluginConfigFromStores({
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: scope,
        projectRoot,
        stores,
        referenceContext: references?.context,
      }),
      after: await resolveEffectivePluginConfigFromStores({
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: scope,
        projectRoot,
        stores: afterStores,
        referenceContext: references?.context,
      }),
    };
    resolved.set(scope, pair);
    return pair;
  };

  try {
    const affectedTargets: ReceiptTargetIdentity[] = [];
    const affectedCommandPackages: ManagedCommandPackageDiscovery['packages'] = [];
    const sharedNativeRenderTargets = new Map<string, PluginConfigImpactSharedNativeTarget>();
    for (const target of dedupeTargets(options.visibleTargets)) {
      if (target.pluginName !== options.plugin.manifest.name) {
        const plugin = referenceImpact.consumers.find((entry) => entry.plugin.manifest.name === target.pluginName)?.plugin;
        if (!plugin) continue;
        let affected = false;
        if (plugin.manifest.scripts?.preApply || (plugin.manifest.dependencies?.length ?? 0) > 0) {
          const config = referenceImpact.consumers.find((entry) => entry.plugin.manifest.name === target.pluginName
            && entry.scope === target.scope);
          affected = !config?.before || !config.after
            || !configValuesEqual(config.before.values, config.after.values);
        }
        for (const declaration of targetConfigConsumers(plugin, target)) {
          if (declaration.refreshKeys.length === 0 || (options.scope === 'project' && declaration.scope === 'user')) continue;
          const consumer = referenceImpact.consumers.find((entry) => entry.plugin.manifest.name === target.pluginName
            && entry.scope === declaration.scope);
          const refreshKeys = getPluginConfigDependencyKeys(plugin.manifest.config!, declaration.refreshKeys);
          if (consumer?.before && consumer.after
            && rendererProjectionEqual(consumer.before, consumer.after, refreshKeys)) continue;
          affected = true;
          addSharedNativeConsumer(sharedNativeRenderTargets, declaration);
        }
        if (affected) affectedTargets.push(target);
        continue;
      }
      let affected = false;
      const consumers = targetConfigConsumers(options.plugin, target);
      if (options.plugin.manifest.scripts?.preApply
        || (options.plugin.manifest.dependencies?.length ?? 0) > 0) {
        const config = await resolveScope(target.scope);
        affected = !configValuesEqual(config.before.values, config.after.values);
      }
      for (const consumer of consumers) {
        if (consumer.refreshKeys.length === 0) continue;
        const config = await resolveScope(consumer.scope);
        const refreshKeys = getPluginConfigDependencyKeys(options.plugin.manifest.config!, consumer.refreshKeys);
        const changed = !rendererProjectionEqual(
          config.before,
          config.after,
          refreshKeys,
        );
        if (!changed) continue;
        affected = true;
        addSharedNativeConsumer(sharedNativeRenderTargets, consumer);
      }
      if (affected) affectedTargets.push(target);
    }
    const packagePlugin = (target: ManagedCommandPackageDiscovery['packages'][number]) =>
      target.producer.pluginName === options.plugin.manifest.name ? options.plugin
        : referenceImpact.consumers.find((consumer) => consumer.plugin.manifest.name === target.producer.pluginName)?.plugin;
    const commandPackages = commands.packages.filter((target) => target.installed
      || affectedTargets.some((platformTarget) => platformTarget.pluginName === target.producer.pluginName
        && packagePlugin(target)?.manifest.managedCommands?.packages.some((declaration) => declaration.key === target.packageKey
          && declaration.platforms.includes(platformTarget.platform))));
    for (const target of commandPackages) {
      if (!target.declared) {
        affectedCommandPackages.push(target);
        continue;
      }
      const plugin = packagePlugin(target);
      const config = target.producer.pluginName === options.plugin.manifest.name ? await resolveScope(target.producer.scope)
        : referenceImpact.consumers.find((consumer) => consumer.plugin.manifest.name === target.producer.pluginName
          && consumer.scope === target.producer.scope);
      if (!plugin || !config?.before || !config.after) {
        affectedCommandPackages.push(target);
        continue;
      }
      const refreshKeys = getPluginConfigDependencyKeys(plugin.manifest.config!, target.refreshKeys);
      if (!rendererProjectionEqual(config.before, config.after, refreshKeys)) {
        affectedCommandPackages.push(target);
      }
    }
    return {
      impactState: commands.errors.length > 0 || referenceWarnings.length > 0 ? 'unknown' : 'known',
      noEffectiveChange: affectedTargets.length === 0 && affectedCommandPackages.length === 0
        && commands.errors.length === 0,
      storeChanged: true,
      storeDigest: referenceDigest,
      changedKeys,
      updatedKeys,
      removedKeys,
      staleRemovedKeys,
      affectedTargets,
      sharedNativeRenderTargets: [...sharedNativeRenderTargets.values()],
      commandPackages,
      affectedCommandPackages,
      commandDiscoveryErrors: commands.errors,
      referenceWarnings,
      referenceBlockers: [...referenceImpact.blockedReferences,
        ...referenceImpact.unreadableConsumers.map((location) => `Cannot check config references in ${location}.`)],
    };
  } catch {
    return { ...unknownImpact({
      plugins: referenceImpact.consumers.map((consumer) => consumer.plugin),
      commands,
      stores,
      plugin: options.plugin,
      scope: options.scope,
      visibleTargets: options.visibleTargets,
      storeChanged: true,
      changedKeys,
      updatedKeys,
      removedKeys,
      staleRemovedKeys,
    }), storeDigest: referenceDigest, referenceWarnings,
      referenceBlockers: [...referenceImpact.blockedReferences,
        ...referenceImpact.unreadableConsumers.map((location) => `Cannot check config references in ${location}.`)] };
  }
}
