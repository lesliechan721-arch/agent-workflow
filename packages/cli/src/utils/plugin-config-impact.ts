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

export type PluginConfigImpactMutation =
  | {
      kind: 'patch';
      updates?: Record<string, unknown>;
      removeKeys?: string[];
    }
  | { kind: 'reset' };

export interface PluginConfigImpactSharedNativeTarget {
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
  return `${target.platform}\0${target.scope}\0${target.projectKey ?? ''}`;
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
      id: artifact?.id ?? declaration.id,
      refreshKeys: declaration.refreshKeys,
      scope: sharedNativeSkillKey ? 'user' : target.scope,
      sharedNativeSkillKey,
      platform: target.platform,
    });
  }
  return consumers;
}

function addSharedNativeConsumer(
  output: Map<string, PluginConfigImpactSharedNativeTarget>,
  consumer: ReturnType<typeof targetConfigConsumers>[number],
): void {
  if (!consumer.sharedNativeSkillKey) return;
  const previous = output.get(consumer.id);
  output.set(consumer.id, { id: consumer.id, skillKey: consumer.sharedNativeSkillKey,
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
}): PluginConfigMutationImpact {
  const affectedTargets = dedupeTargets(options.visibleTargets);
  const sharedNativeRenderTargets = new Map<string, PluginConfigImpactSharedNativeTarget>();
  for (const target of affectedTargets) {
    if (options.scope !== 'user') continue;
    for (const consumer of targetConfigConsumers(options.plugin, target)) {
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
}): Promise<PluginConfigMutationImpact> {
  const commands = options.commandDiscovery ?? await discoverInstalledPluginManagedCommandPackages({
    plugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env ?? process.env,
    platformTargets: options.visibleTargets,
  });
  const schema = options.plugin.manifest.config?.fields;
  const needsProjectStore = options.scope === 'project'
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
  const resolved = new Map<Scope, {
    before: ResolvedEffectivePluginConfig;
    after: ResolvedEffectivePluginConfig;
  }>();
  const resolveScope = async (scope: Scope) => {
    const existing = resolved.get(scope);
    if (existing) return existing;
    const pair = {
      before: await resolveEffectivePluginConfigFromStores({
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: scope,
        projectRoot,
        stores,
      }),
      after: await resolveEffectivePluginConfigFromStores({
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: scope,
        projectRoot,
        stores: afterStores,
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
    const commandPackages = commands.packages.filter((target) => target.installed
      || affectedTargets.some((platformTarget) => options.plugin.manifest.managedCommands?.packages
        .some((declaration) => declaration.key === target.packageKey
          && declaration.platforms.includes(platformTarget.platform))));
    for (const target of commandPackages) {
      if (!target.declared) {
        affectedCommandPackages.push(target);
        continue;
      }
      const config = await resolveScope(target.producer.scope);
      const refreshKeys = getPluginConfigDependencyKeys(options.plugin.manifest.config!, target.refreshKeys);
      if (!rendererProjectionEqual(config.before, config.after, refreshKeys)) {
        affectedCommandPackages.push(target);
      }
    }
    return {
      impactState: commands.errors.length > 0 ? 'unknown' : 'known',
      noEffectiveChange: affectedTargets.length === 0 && affectedCommandPackages.length === 0
        && commands.errors.length === 0,
      storeChanged: true,
      storeDigest: digestStores(stores),
      changedKeys,
      updatedKeys,
      removedKeys,
      staleRemovedKeys,
      affectedTargets,
      sharedNativeRenderTargets: [...sharedNativeRenderTargets.values()],
      commandPackages,
      affectedCommandPackages,
      commandDiscoveryErrors: commands.errors,
    };
  } catch {
    return unknownImpact({
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
    });
  }
}
