import path from 'node:path';

import type { NormalizedPluginManifest, PlatformName, PluginMeta, Scope } from '../types.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import {
  resolvePartialCatalogOperationContext,
  type CatalogOperationContext,
} from '../utils/catalog-operation-context.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { readPluginManifest } from '../utils/manifest.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { createEmptyPluginIntentState, type PluginIntentState } from '../utils/plugin-intent-state.js';
import { observeProjectIntent, type ProjectIntentObservation } from './project-state.js';
import {
  observeProjectPreferences,
  type ProjectAgentId,
  type ProjectPreferencesObservation,
} from './project-preferences.js';

import type { ProjectDelivery, ProjectDiagnostic } from './project-types.js';
export type { ProjectDelivery, ProjectDiagnostic } from './project-types.js';
export type ProjectDemandSourceState = 'ready' | 'missing' | 'unavailable' | 'identity-mismatch';
export interface ProjectDemandRoot {
  pluginId: string;
  sourceId: string;
  sourceState: ProjectDemandSourceState;
  blockers: string[];
  plugin?: PluginMeta;
}
export interface ProjectDemand {
  intent: ProjectIntentObservation;
  preferences: ProjectPreferencesObservation;
  roots: ProjectDemandRoot[] | null;
  plugins: PluginMeta[];
  errors: ProjectDiagnostic[];
  catalogOperationContext?: CatalogOperationContext;
}
export interface ReadProjectDemandOptions {
  intent?: ProjectIntentObservation;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  catalogOperationContext?: CatalogOperationContext;
}

/** Select delivery from the manifest only. Tool and configuration failures cannot change it. */
export function resolveProjectDelivery(
  manifest: NormalizedPluginManifest,
  agent: ProjectAgentId,
  scope: Scope = 'project',
): ProjectDelivery | undefined {
  const platform = agent === 'claude-code' ? 'claude' : agent === 'codex' ? 'codex' : undefined;
  if (platform && supportsPlatform(manifest, platform)) {
    const surface = platform === 'codex' ? analyzeCodexSurface(manifest) : undefined;
    // Ambiguous ownership remains a Native blocker. Only unsupported surface kinds
    // or a surface confined to another scope remove Native applicability.
    const applicable = !surface || (surface.unsupportedKinds.length === 0
      && surface.components.some((component) =>
        component.scopes.includes(scope)));
    if (applicable) return { kind: 'native', platform };
  }
  if (manifest.distributions?.agentSkills) {
    return { kind: 'agent-skills', provider: 'skills-cli', agentId: agent };
  }
  return undefined;
}

export async function readProjectDemand(options: ReadProjectDemandOptions): Promise<ProjectDemand> {
  const [intent, preferences] = await Promise.all([
    options.intent ?? observeProjectIntent(options), observeProjectPreferences(options),
  ]);
  const errors: ProjectDiagnostic[] = [];
  if (!['absent', 'valid'].includes(intent.state)) {
    errors.push({ code: 'pluginIntentStateInvalid', message: '项目声明无效或不可读。' });
  }
  if (preferences.state === 'invalid' || preferences.state === 'unreadable') {
    errors.push({ code: preferences.code, message: '项目本地偏好无效或不可读。' });
  }
  const roots: ProjectDemandRoot[] | null = intent.state === 'absent' ? []
    : intent.state === 'valid'
      ? intent.value.roots.map(({ pluginId }) => ({
          pluginId, sourceId: pluginId.split('/')[0]!, sourceState: 'unavailable', blockers: [],
        })) : null;
  const result: ProjectDemand = { intent, preferences, roots, plugins: [], errors };
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
    // Include the source graph so all consumers use the same dependency facts.
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

/** A protective Native view, never an execution qualification or a writable project declaration. */
export function projectDemandNativeProjection(demand: ProjectDemand): PluginIntentState {
  if (demand.intent.state !== 'absent' && demand.intent.state !== 'valid') {
    throw new Error('pluginIntentStateInvalid: 项目声明无效或不可读。');
  }
  if (demand.preferences.state === 'invalid' || demand.preferences.state === 'unreadable') {
    throw new Error(`${demand.preferences.code}: 项目本地偏好无效或不可读。`);
  }
  return {
    ...createEmptyPluginIntentState(),
    roots: (demand.roots ?? []).flatMap((root) => {
      const platforms: PlatformName[] = root.plugin
        ? (['codex', 'claude'] as const).filter((platform) => resolveProjectDelivery(
            root.plugin!.manifest, platform === 'claude' ? 'claude-code' : 'codex',
          )?.kind === 'native')
        : ['codex', 'claude'];
      return platforms.length ? [{ pluginId: root.pluginId, platforms }] : [];
    }),
    dependencyScopeOverrides: demand.preferences.state === 'valid'
      ? demand.preferences.value.dependencyScopeOverrides : [],
  };
}

export async function readNativeIntentProjection(options: ReadProjectDemandOptions): Promise<PluginIntentState> {
  return projectDemandNativeProjection(await readProjectDemand(options));
}

/** Source usage exists even without a usable Catalog or local Agent selection. */
export async function readProjectReferencedPluginIds(options: ReadProjectDemandOptions): Promise<string[]> {
  const intent = options.intent ?? await observeProjectIntent(options);
  if (intent.state === 'absent') return [];
  if (intent.state === 'valid') return intent.value.roots.map((root) => root.pluginId);
  throw new Error('pluginIntentStateInvalid: Project demand cannot be read.');
}
