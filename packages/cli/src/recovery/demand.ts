import path from 'node:path';
import { NATIVE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest, PlatformName, PluginMeta, Scope } from '../types.js';
import { observePreferences, type PreferencesObservation, type AgentId } from '../intent/deployment-preferences.js';
import { resolvePreferencesPath } from '../intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath, type IntentObservation } from '../intent/intent-store.js';
import { describeStrongStateProblem } from '../intent/diagnostics.js';
import {
  resolvePartialCatalogOperationContext,
  type CatalogOperationContext,
} from '../utils/catalog-operation-context.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { readPluginManifest } from '../utils/manifest.js';
import { createEmptyNativeDemandView, type NativeDemandView } from '../utils/native-demand.js';
import { supportsPlatform } from '../utils/platform-support.js';
import type { Delivery, Diagnostic } from './types.js';

export type DemandSourceState = 'ready' | 'missing' | 'unavailable' | 'identity-mismatch';
export interface DemandRoot {
  pluginId: string;
  sourceId: string;
  sourceState: DemandSourceState;
  blockers: string[];
  plugin?: PluginMeta;
}
export interface DemandSnapshot {
  scope: Scope;
  intent: IntentObservation;
  preferences: PreferencesObservation;
  roots: DemandRoot[] | null;
  plugins: PluginMeta[];
  targetRequirements?: Array<{ pluginId: string; target: AgentId }>;
  userProviders?: Partial<Record<AgentId, string[]>>;
  errors: Diagnostic[];
  catalogOperationContext?: CatalogOperationContext;
}
export interface ReadDemandOptions {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  intent?: IntentObservation;
  preferences?: PreferencesObservation;
  catalogOperationContext?: CatalogOperationContext;
  signal?: AbortSignal;
}

/** Manifest delivery choice is independent of tool, trust, and configuration health. */
export function resolveDelivery(
  manifest: NormalizedPluginManifest, agent: AgentId, _scope: Scope,
): Delivery | undefined {
  if (!supportsPlatform(manifest, agent)) return undefined;
  return agent === 'generic'
    ? { kind: 'agent-skills', provider: 'aw', agentId: agent }
    : { kind: 'native', platform: agent };
}

export async function readDemand(options: ReadDemandOptions): Promise<DemandSnapshot> {
  options.signal?.throwIfAborted();
  const [intent, preferences] = await Promise.all([
    options.intent ?? observeIntent(options), options.preferences ?? observePreferences(options),
  ]);
  const errors: Diagnostic[] = [];
  if (intent.state !== 'absent' && intent.state !== 'valid') {
    errors.push(describeStrongStateProblem({ kind: 'intent', scope: options.scope,
      state: intent.state, filePath: await resolveIntentPath(options) }));
  }
  if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
    errors.push(describeStrongStateProblem({ kind: 'preferences', scope: 'user',
      state: preferences.state, filePath: await resolvePreferencesPath(options) }));
  }
  const roots: DemandRoot[] | null = intent.state === 'absent' ? []
    : intent.state === 'valid'
      ? intent.value.roots.map(({ pluginId }) => ({
          pluginId, sourceId: pluginId.split('/')[0]!, sourceState: 'unavailable', blockers: [],
        })) : null;
  const result: DemandSnapshot = {
    scope: options.scope, intent, preferences, roots, plugins: [], errors,
    catalogOperationContext: options.catalogOperationContext,
  };
  if (!roots?.length) return result;
  let context = options.catalogOperationContext;
  let configured: Set<string>;
  try {
    const snapshot = await readCatalogSourcesConfigSnapshot(options.env);
    configured = new Set(snapshot.config.sources.map((source) => source.id));
    context ??= await resolvePartialCatalogOperationContext({
      env: options.env, configSnapshot: snapshot, signal: options.signal,
      sourceIds: [...new Set(roots.map((root) => root.sourceId))].filter((id) => configured.has(id)),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    for (const root of roots) root.blockers.push('sourceUnavailable');
    errors.push({ code: 'catalogReadFailed', message: '无法读取本地 Catalog 配置或状态。' });
    return result;
  }
  result.catalogOperationContext = context;
  const pluginCache = new Map<string, PluginMeta>();
  for (const root of roots) {
    options.signal?.throwIfAborted();
    if (!configured.has(root.sourceId)) {
      root.sourceState = 'missing';
      root.blockers.push('sourceMissing');
      continue;
    }
    const source = context.catalog.sources.find((entry) => entry.sourceId === root.sourceId)?.resolution;
    if (!source) {
      root.blockers.push('sourceActiveUnavailable');
      continue;
    }
    if (intent.state === 'valid'
      && intent.value.sources[root.sourceId]!.logicalIdentity !== source.logicalIdentity) {
      root.sourceState = 'identity-mismatch';
      root.blockers.push('sourceIdentityMismatch');
      continue;
    }
    root.sourceState = 'ready';
    const pluginName = root.pluginId.slice(root.sourceId.length + 1);
    if (!source.manifest.entries.some((entry) => entry.name === pluginName)) {
      root.blockers.push('pluginUnavailable');
      continue;
    }
    for (const entry of source.manifest.entries) {
      const pluginId = `${root.sourceId}/${entry.name}`;
      if (pluginCache.has(pluginId)) continue;
      try {
        const plugin = await readPluginManifest(path.join(source.rootDir, 'plugins', entry.name), { mode: 'bundle' });
        Object.assign(plugin, {
          pluginId, sourceId: root.sourceId, sourceIdentity: source.sourceIdentity,
          catalogLogicalIdentity: source.logicalIdentity,
        });
        pluginCache.set(pluginId, plugin);
      } catch {
        if (pluginId === root.pluginId) root.blockers.push('pluginManifestUnavailable');
      }
    }
    root.plugin = pluginCache.get(root.pluginId);
  }
  result.plugins = [...pluginCache.values()];
  return result;
}

/** Protect the complete current-scope requirement, including unresolvable roots. */
export function demandNativeProjection(demand: DemandSnapshot): NativeDemandView {
  if (demand.intent.state !== 'absent' && demand.intent.state !== 'valid') {
    throw new Error('pluginIntentStateInvalid: declaration cannot be read.');
  }
  if (demand.preferences.state === 'invalid' || demand.preferences.state === 'unreadable') {
    throw new Error(`${demand.preferences.code}: preferences cannot be read.`);
  }
  const view = createEmptyNativeDemandView();
  const preferences = demand.preferences.state === 'valid' ? demand.preferences.value : undefined;
  view.roots = (demand.roots ?? []).flatMap((root) => {
    const platforms: PlatformName[] = root.plugin
      ? NATIVE_PLATFORM_TARGETS.filter((platform) => resolveDelivery(
          root.plugin!.manifest, platform, demand.scope,
        )?.kind === 'native')
      : [...NATIVE_PLATFORM_TARGETS];
    const selected = platforms.filter((platform) => preferences?.targets.includes(platform)
      && !preferences.exclusions.some((entry) => entry.plugin === root.pluginId && entry.target === platform)
      && !(demand.scope === 'project' && demand.userProviders?.[platform]?.includes(root.pluginId))
      && (!demand.targetRequirements || demand.targetRequirements.some((entry) => entry.pluginId === root.pluginId && entry.target === platform)));
    return selected.length ? [{ pluginId: root.pluginId, platforms: selected }] : [];
  });
  view.dependencyScopeOverrides = demand.scope === 'project'
    ? NATIVE_PLATFORM_TARGETS.flatMap((platform) => (demand.userProviders?.[platform] ?? [])
      .map((pluginId) => ({ pluginId, platform, scope: 'user' as const }))) : [];
  return view;
}

/** Source use is independent of selected Agents and local Catalog availability. */
export async function readIntentReferences(options: Pick<ReadDemandOptions, 'scope' | 'cwd' | 'env' | 'intent'>): Promise<string[]> {
  const intent = options.intent ?? await observeIntent(options);
  if (intent.state === 'absent') return [];
  if (intent.state === 'valid') return intent.value.roots.map((root) => root.pluginId);
  throw new Error('pluginIntentStateInvalid: demand cannot be read.');
}
