import crypto from 'node:crypto';
import { inspectRemovedPluginConfig, type RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { resetPluginConfigStore } from '../utils/plugin-config.js';
import { resolveActiveCatalogGeneration } from '../utils/catalog-generation-resolver.js';
import type { AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import { observeProjectIntent, removeProjectIntentRoot, writeProjectIntent } from './project-state.js';
import { observeProjectPreferences, writeProjectPreferences } from './project-preferences.js';

export interface RemovedProjectRequirementsChanges {
  declarationChanged: boolean;
  preferencesChanged: boolean;
  configChanged: boolean;
}

/** The Native cleanup owner invokes both phases under its existing mutation lock. */
export function createRemovedProjectRequirements(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  token?: AwHomeMutationToken;
  changes?: RemovedProjectRequirementsChanges;
}): NonNullable<RebuildCommandRuntime['removedProjectRequirements']> {
  let prepared: {
    ids: string[];
    intent: Awaited<ReturnType<typeof observeProjectIntent>>;
    preferences: Awaited<ReturnType<typeof observeProjectPreferences>>;
    configs: Array<{ pluginId: string; fingerprint: string; remove: boolean }>;
  } | undefined;
  const evidence = (value: { state: string; rawDigest?: string }): string => `${value.state}:${value.rawDigest ?? ''}`;
  const read = async (pluginIds: readonly string[], requireWritable = true) => {
    const ids = [...new Set(pluginIds)].sort();
    const [intent, preferences] = await Promise.all([
      observeProjectIntent(options), observeProjectPreferences(options),
    ]);
    if (requireWritable && (!['absent', 'valid'].includes(intent.state)
      || !['absent', 'valid'].includes(preferences.state))) {
      throw new Error('removedPluginStrongConfigInvalid: 项目声明或本地偏好无效，未开始整体清理。');
    }
    const configs = [];
    for (const pluginId of ids) {
      const { sourceId, pluginName } = parsePluginId(pluginId);
      if (!sourceId) throw new Error('removedPluginIdentityInvalid');
      const generation = await resolveActiveCatalogGeneration({ sourceId, env: options.env });
      if (requireWritable && intent.state === 'valid' && intent.value.roots.some((root) => root.pluginId === pluginId)
        && intent.value.sources[sourceId]?.logicalIdentity !== generation.logicalIdentity) {
        throw new Error('sourceIdentityMismatch');
      }
      const config = await inspectRemovedPluginConfig({ ...options, env: options.env ?? process.env, sourceId, pluginName, scope: 'project',
        sourceIdentity: generation.sourceIdentity, logicalIdentity: generation.logicalIdentity });
      configs.push({ pluginId, fingerprint: config.fingerprint,
        remove: !config.conflict && config.kind !== 'directory' && config.kind !== 'special' });
    }
    return { ids, intent, preferences, configs };
  };
  return {
    async inspectEvidence(pluginIds) {
      const current = await read(pluginIds, false);
      return `sha256:${crypto.createHash('sha256').update(JSON.stringify({ ids: current.ids,
        intent: evidence(current.intent), preferences: evidence(current.preferences), configs: current.configs })).digest('hex')}`;
    },
    async preflight(pluginIds) { prepared = await read(pluginIds); },
    async commit(pluginIds) {
      let changed = false;
      try {
        const current = await read(pluginIds);
        if (!prepared || JSON.stringify(current.ids) !== JSON.stringify(prepared.ids)
          || evidence(current.intent) !== evidence(prepared.intent)
          || evidence(current.preferences) !== evidence(prepared.preferences)
          || JSON.stringify(current.configs) !== JSON.stringify(prepared.configs)) {
          throw new Error('operationReviewStale');
        }
        if (current.intent.state === 'valid') {
          let next = current.intent.value;
          for (const pluginId of current.ids) next = removeProjectIntentRoot(next, pluginId);
          const result = await writeProjectIntent(options, next);
          changed ||= result.changed;
          if (options.changes) options.changes.declarationChanged ||= result.changed;
        }
        if (current.preferences.state === 'valid') {
          const result = await writeProjectPreferences(options, { ...current.preferences.value,
            dependencyScopeOverrides: current.preferences.value.dependencyScopeOverrides.filter((override) => !current.ids.includes(override.pluginId)) });
          changed ||= result.changed;
          if (options.changes) options.changes.preferencesChanged ||= result.changed;
        }
        for (const { pluginId, remove } of current.configs) {
          if (!remove) continue;
          const { sourceId, pluginName } = parsePluginId(pluginId);
          const result = await resetPluginConfigStore({ ...options, sourceId, pluginName, scope: 'project' });
          changed ||= result.deleted;
          if (options.changes) options.changes.configChanged ||= result.deleted;
        }
        return changed;
      } catch (error) {
        if (changed && error instanceof Error) Object.assign(error, { changed: true });
        throw error;
      }
    },
  };
}
