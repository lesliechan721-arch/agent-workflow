import path from 'node:path';

import type { NormalizedPluginManifest, PlatformName, PluginMeta, Scope } from '../types.js';
import { observePreferences, type PreferencesObservation, type AgentId } from '../intent/deployment-preferences.js';
import { resolvePreferencesPath } from '../intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath, type IntentObservation } from '../intent/intent-store.js';
import { describeStrongStateProblem } from '../intent/diagnostics.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
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
  errors: Diagnostic[];
  catalogOperationContext?: CatalogOperationContext;
}
export interface ReadDemandOptions {
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  intent?: IntentObservation;
  catalogOperationContext?: CatalogOperationContext;
}

/** Manifest delivery choice is independent of tool, trust, and configuration health. */
export function resolveDelivery(
  manifest: NormalizedPluginManifest, agent: AgentId, scope: Scope,
): Delivery | undefined {
  const platform = agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : undefined;
  if (platform && supportsPlatform(manifest, platform)) {
    const surface = platform === 'codex' ? analyzeCodexSurface(manifest) : undefined;
    const applicable = !surface || (surface.unsupportedKinds.length === 0
      && surface.components.some((component) => component.scopes.includes(scope)));
    if (applicable) return { kind: 'native', platform };
  }
  if (manifest.distributions?.agentSkills) {
    return { kind: 'agent-skills', provider: 'skills-cli', agentId: agent };
  }
  return undefined;
}

export async function readDemand(options: ReadDemandOptions): Promise<DemandSnapshot> {
  const [intent, preferences] = await Promise.all([
    options.intent ?? observeIntent(options), observePreferences(options),
  ]);
  const errors: Diagnostic[] = [];
  if (intent.state !== 'absent' && intent.state !== 'valid') {
    errors.push(describeStrongStateProblem({ kind: 'intent', scope: options.scope,
      state: intent.state, filePath: await resolveIntentPath(options) }));
  }
  if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
    errors.push(describeStrongStateProblem({ kind: 'preferences', scope: options.scope,
      state: preferences.state, filePath: await resolvePreferencesPath(options) }));
  }
  const roots: DemandRoot[] | null = intent.state === 'absent' ? []
    : intent.state === 'valid'
      ? intent.value.roots.map(({ pluginId }) => ({
          pluginId, sourceId: pluginId.split('/')[0]!, sourceState: 'unavailable', blockers: [],
        })) : null;
  const result: DemandSnapshot = {
    scope: options.scope, intent, preferences, roots, plugins: [], errors,
  };
  if (!roots?.length) return result;
  let context = options.catalogOperationContext;
  let configured: Set<string>;
  try {
    const snapshot = await readCatalogSourcesConfigSnapshot(options.env);
    configured = new Set(snapshot.config.sources.map((source) => source.id));
    context ??= await resolvePartialCatalogOperationContext({
      env: options.env, configSnapshot: snapshot,
      sourceIds: [...new Set(roots.map((root) => root.sourceId))].filter((id) => configured.has(id)),
    });
  } catch {
    for (const root of roots) root.blockers.push('sourceUnavailable');
    errors.push({ code: 'catalogReadFailed', message: '无法读取本地 Catalog 配置或状态。' });
    return result;
  }
  result.catalogOperationContext = context;
  const pluginCache = new Map<string, PluginMeta>();
  for (const root of roots) {
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
  view.roots = (demand.roots ?? []).flatMap((root) => {
    const platforms: PlatformName[] = root.plugin
      ? (['codex', 'claude'] as const).filter((platform) => resolveDelivery(
          root.plugin!.manifest, platform === 'claude' ? 'claude-code' : 'codex', demand.scope,
        )?.kind === 'native')
      : ['codex', 'claude'];
    return platforms.length ? [{ pluginId: root.pluginId, platforms }] : [];
  });
  view.dependencyScopeOverrides = demand.preferences.state === 'valid'
    ? demand.preferences.value.dependencyScopeOverrides : [];
  return view;
}

/** Source use is independent of selected Agents and local Catalog availability. */
export async function readIntentReferences(options: Pick<ReadDemandOptions, 'scope' | 'cwd' | 'env' | 'intent'>): Promise<string[]> {
  const intent = options.intent ?? await observeIntent(options);
  if (intent.state === 'absent') return [];
  if (intent.state === 'valid') return intent.value.roots.map((root) => root.pluginId);
  throw new Error('pluginIntentStateInvalid: demand cannot be read.');
}
