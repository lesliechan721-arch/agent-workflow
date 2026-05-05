import { refreshArtifactsAfterConfigWrite, type ArtifactRefreshReceipt } from './artifact-refresh.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  summarizeEffectivePluginConfig,
} from './plugin-config.js';
import type { PluginMeta, Scope } from '../types.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  artifactRefresh: ArtifactRefreshReceipt;
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  existed: boolean;
  deleted: boolean;
  artifactRefresh: ArtifactRefreshReceipt;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function createSkippedRefreshReceipt(triggerKeys: string[] = []): ArtifactRefreshReceipt {
  return {
    attempted: false,
    status: 'skipped',
    triggerKeys,
    artifacts: [],
  };
}

export async function applyPluginConfigWrite(options: {
  plugin: PluginMeta;
  pluginName?: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  request: PluginConfigWriteRequest;
}): Promise<PluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.plugin.manifest.name);
  const schema = options.plugin.manifest.config?.schema;
  if (!schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }

  const requestedUpdates = options.request.updates ?? {};
  const requestedRemoveKeys = uniqueInOrder(options.request.removeKeys ?? []);
  const duplicateKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(requestedUpdates, key));
  if (duplicateKeys.length > 0) {
    throw new Error(`Config write cannot update and remove the same key: ${duplicateKeys.join(', ')}.`);
  }

  for (const key of requestedRemoveKeys) {
    if (!schema[key]) {
      throw new Error(`Unknown config key "${key}".`);
    }
  }

  const updates = await coercePluginConfigUpdates({
    schema,
    updates: requestedUpdates,
    cwd: options.cwd,
  });
  const updatedKeys = Object.keys(updates);

  const store = await readPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(store.values, key));
  const triggerKeys = [...updatedKeys, ...removedKeys];

  if (triggerKeys.length > 0) {
    await patchPluginConfigStore({
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      updates,
      removeKeys: requestedRemoveKeys,
    });
  }

  const effective = await resolveEffectivePluginConfig({
    pluginName,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });
  const artifactRefresh = triggerKeys.length > 0
    ? await refreshArtifactsAfterConfigWrite({
        plugin: options.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env: options.env,
        changedKeys: triggerKeys,
      })
    : createSkippedRefreshReceipt();

  return {
    plugin: pluginName,
    scope: options.scope,
    updatedKeys,
    removedKeys,
    effective: summarizeEffectivePluginConfig(effective),
    artifactRefresh,
  };
}

export async function resetPluginConfigWithHelper(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugin?: PluginMeta;
}): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const reset = await resetPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });

  const artifactRefresh = reset.deleted && options.plugin
    ? await refreshArtifactsAfterConfigWrite({
        plugin: options.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env: options.env,
        resetAllTrackedKeys: true,
      })
    : createSkippedRefreshReceipt();

  return {
    plugin: pluginName,
    scope: options.scope,
    existed: reset.existed,
    deleted: reset.deleted,
    artifactRefresh,
  };
}
