import path from 'node:path';

import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import {
  discoverRebuildTargetNames,
  inspectRebuildTarget,
} from '../commands/rebuild-integration.js';
import { reinstallWriteCommand } from '../commands/write-commands.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { createNoopReporter } from '../output/reporter.js';
import type {
  ConfigReceiptFieldEntry,
  ConfigSchemaEvidence,
  PlatformName,
  PluginMeta,
  ReceiptOverallState,
  ReceiptTargetIdentity,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from './native-cli.js';
import { resolveAwHome } from './paths.js';
import { hasCodexProjectManagedArtifacts } from './codex-project-surface.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  collectProjectArtifactConfigBoundaryIssues,
  patchPluginConfigStore,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigSchemaAccess,
  summarizeEffectivePluginConfig,
} from './plugin-config.js';
import {
  assertProjectSharedConfigPathVisible,
  ensureProjectPrivateStateIgnore,
  type ProjectBoundaryWarning,
} from './project-boundary.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from './paths.js';
import { supportsPlatform } from './platform-support.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export type ConfigApplySkippedReason =
  | 'noVisibleTarget'
  | 'noConfigChange';

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidence;
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: ReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
  otherProjectsRequireReinstall: boolean;
  warnings: Array<ProjectBoundaryWarning | string>;
  /** @deprecated Compatibility for the console until its config view moves to reinstall receipts. */
  /** @deprecated Compatibility alias for the old console projection. */
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidence;
  existed: boolean;
  deleted: boolean;
  removedKeys: string[];
  effective?: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: ReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
  otherProjectsRequireReinstall: boolean;
  warnings: Array<ProjectBoundaryWarning | string>;
  /** @deprecated Compatibility for the console until its config view moves to reinstall receipts. */
  /** @deprecated Compatibility alias for the old console projection. */
}

type ReinstallCommand = typeof reinstallWriteCommand;

interface ConfigRuntimeReplayReceipt {
  configWrite: 'succeeded';
  overallState: ReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
  otherProjectsRequireReinstall: boolean;
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function collectRemovedConfigKeys(values: Record<string, unknown>): string[] {
  return uniqueInOrder(Object.keys(values));
}

function targetKey(target: ReceiptTargetIdentity): string {
  return `${target.platform}:${target.scope}:${target.projectKey ?? '-'}`;
}

function dedupeTargets(targets: ReceiptTargetIdentity[]): ReceiptTargetIdentity[] {
  const deduped = new Map<string, ReceiptTargetIdentity>();
  for (const target of targets) deduped.set(targetKey(target), target);
  return [...deduped.values()];
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'codex'
    ? resolveCodexProjectKey(cwd)
    : resolveClaudeProjectKey(cwd);
}

async function createCandidateTarget(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
}): Promise<ReceiptTargetIdentity> {
  return {
    pluginName: options.pluginName,
    platform: options.platform,
    scope: options.scope,
    ...(options.scope === 'project'
      ? { projectKey: await resolveProjectKey(options.platform, options.cwd) }
      : {}),
  };
}

async function discoverVisibleTargets(options: {
  plugin: PluginMeta;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  rebuildRuntime?: RebuildCommandRuntime;
}): Promise<{
  targets: ReceiptTargetIdentity[];
  failures: ReceiptTargetResult[];
}> {
  const targets: ReceiptTargetIdentity[] = [];
  const failures: ReceiptTargetResult[] = [];
  const namedTargets: ReceiptTargetIdentity[] = [];
  const scopes: Scope[] = options.scope === 'user' ? ['user', 'project'] : ['project'];

  for (const platform of ['codex', 'claude'] as const) {
    for (const scope of scopes) {
      if (!supportsPlatform(options.plugin.manifest, platform)) continue;
      if (
        platform === 'codex'
        && scope === 'project'
        && !hasCodexProjectManagedArtifacts(options.plugin)
      ) continue;
      const target = await createCandidateTarget({
        pluginName: options.pluginName,
        platform,
        scope,
        cwd: options.cwd,
      });
      try {
        const names = await discoverRebuildTargetNames({
          cwd: options.cwd,
          env: options.env,
          platform,
          scope,
          nativeCliRunner: options.nativeCliRunner,
          nativeFailureMode: 'ignore',
          marketplaceName: options.plugin.marketplaceName,
          marketplaceRoot: options.plugin.sourceId
            ? path.join(resolveAwHome(options.env), 'marketplaces', options.plugin.sourceId)
            : undefined,
        });
        if (!names.includes(options.pluginName)) continue;
        namedTargets.push(target);
      } catch (error) {
        failures.push({
          target,
          action: 'reinstall',
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (namedTargets.length === 0) return { targets, failures };
  const catalog = options.rebuildRuntime?.catalogResolution ?? {
    rootDir: options.plugin.sourceId
      ? path.resolve(options.plugin.rootDir, '..', '..')
      : options.plugin.rootDir,
    source: 'local' as const,
  };

  for (const target of namedTargets) {
    try {
      const inspected = await inspectRebuildTarget({
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
        pluginId: options.plugin.pluginId,
        marketplaceName: options.plugin.marketplaceName,
        marketplaceRoot: options.plugin.sourceId
          ? path.join(resolveAwHome(options.env), 'marketplaces', options.plugin.sourceId)
          : undefined,
        plugin: options.plugin,
        platform: target.platform,
        scope: target.scope,
        cwd: options.cwd,
        catalog,
        context: {
          env: options.env,
          nativeCliRunner: options.nativeCliRunner,
          reporter: options.rebuildRuntime?.reporter ?? createNoopReporter(),
          debugLogger: options.rebuildRuntime?.debugLogger ?? createNoopDebugLogger(),
        },
      });
      if (inspected.inspection.state === 'present' || inspected.inspection.state === 'partial') {
        targets.push(target);
      }
    } catch (error) {
      failures.push({
        target,
        action: 'reinstall',
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { targets: dedupeTargets(targets), failures };
}

async function reinstallVisibleTargets(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
}): Promise<{
  overallState: ReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
}> {
  const nativeCliRunner = options.nativeCliRunner ?? getDefaultNativeCliRunner();
  const discovered = options.applyTargets === undefined
    ? await discoverVisibleTargets({
        pluginName: options.plugin.manifest.name,
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        nativeCliRunner,
        rebuildRuntime: options.rebuildRuntime,
      })
    : { targets: dedupeTargets(options.applyTargets), failures: [] };
  const targetResults = [...discovered.failures];
  let runtimeFailed = discovered.failures.length > 0;
  const reinstall = options.reinstallCommandImpl ?? reinstallWriteCommand;
  if (options.plugin.sourceId && !options.plugin.pluginId) {
    throw new Error(`Plugin "${options.plugin.manifest.name}" is missing its namespaced plugin ID.`);
  }
  const selector = options.plugin.sourceId
    ? options.plugin.pluginId!
    : options.plugin.manifest.name;

  for (const target of discovered.targets) {
    try {
      const result = await reinstall(
        [selector],
        {
          cwd: options.cwd,
          platform: target.platform,
          scope: target.scope,
        },
        {
          ...options.rebuildRuntime,
          env: options.env,
          nativeCliRunner,
        },
      );
      if (result.overallState === 'failed') runtimeFailed = true;
      targetResults.push(...result.targetResults);
    } catch (error) {
      runtimeFailed = true;
      targetResults.push({
        target,
        action: 'reinstall',
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const overallState = runtimeFailed || targetResults.some((entry) => entry.state === 'failed')
    ? 'failed' : 'succeeded';
  return {
    overallState,
    targetResults,
    ...(discovered.targets.length === 0 && discovered.failures.length === 0
      ? { applySkippedReason: 'noVisibleTarget' as const }
      : {}),
  };
}

function otherProjectsWarning(scope: Scope): string[] {
  return scope === 'user'
    ? ['其它项目不会由本次命令扫描或更新。请在每个项目目录中运行对应的 aw reinstall 命令。']
    : [];
}

function buildReceiptFieldEntry(options: {
  key: string;
  title: string;
  kind: ConfigReceiptFieldEntry['kind'];
  reserved: boolean;
  action: ConfigReceiptFieldEntry['action'];
  scope: Scope;
  projectLayer: 'shared' | 'local';
  valueState?: ConfigReceiptFieldEntry['valueState'];
}): ConfigReceiptFieldEntry {
  return {
    key: options.key,
    title: options.title,
    kind: options.kind,
    reserved: options.reserved,
    action: options.action,
    scope: options.scope,
    ...(options.scope === 'project' ? { projectLayer: options.projectLayer } : {}),
    ...(options.valueState ? { valueState: options.valueState } : {}),
  };
}

export async function replayConfigRuntimeWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  includeDynamicArtifacts?: boolean;
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
}): Promise<ConfigRuntimeReplayReceipt> {
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      const applied = await reinstallVisibleTargets({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken },
      });
      return {
        configWrite: 'succeeded',
        overallState: applied.overallState,
        targetResults: applied.targetResults,
        ...(applied.applySkippedReason ? { applySkippedReason: applied.applySkippedReason } : {}),
        otherProjectsRequireReinstall: options.scope === 'user',
      };
    },
  });
}

type ApplyPluginConfigWriteOptions = {
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  pluginName?: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
  request: PluginConfigWriteRequest;
  reviewPreflight?: () => Promise<void> | void;
};

async function applyPluginConfigWriteUnlocked(
  options: ApplyPluginConfigWriteOptions,
): Promise<PluginConfigWriteReceipt> {
  const requestedPluginName = options.pluginName ?? options.plugin?.manifest.name;
  if (!requestedPluginName) throw new Error('Plugin name is required for config write.');
  const pluginName = assertSafePluginConfigSegment(requestedPluginName);
  const configIdentity = options.plugin?.sourceId ? {
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
  } : {};
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const requestedUpdates = options.request.updates ?? {};
  const requestedRemoveKeys = uniqueInOrder(options.request.removeKeys ?? []);
  const duplicateKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(requestedUpdates, key));
  if (duplicateKeys.length > 0) {
    throw new Error(`Config write cannot update and remove the same key: ${duplicateKeys.join(', ')}.`);
  }

  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    currentPluginError: options.pluginError,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const schemaPlugin = schemaAccess.plugin;
  const schema = schemaPlugin?.manifest.config?.schema;
  if (!schema || !schemaPlugin) {
    throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
  }

  for (const key of requestedRemoveKeys) {
    if (!schema[key]) throw new Error(`Unknown config key "${key}".`);
  }

  const updates = await coercePluginConfigUpdates({ schema, updates: requestedUpdates, cwd: options.cwd });
  if (options.scope === 'project' && projectLayer === 'shared') {
    for (const key of Object.keys(updates)) {
      const field = schema[key]!;
      if (field.type === 'file' || field.type === 'directory') {
        throw new Error(
          `Config "${key}" is a ${field.type} value and cannot be written into project shared config. `
          + 'Use `--scope project --local` or user config instead.',
        );
      }
    }
  }

  const store = await readPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const warnings: Array<ProjectBoundaryWarning | string> = [];
  if (options.scope === 'project' && projectLayer === 'shared') {
    await assertProjectSharedConfigPathVisible({ cwd: options.cwd, targetPath: store.path });
  }
  if (options.scope === 'project' && projectLayer === 'local') {
    const ignore = await ensureProjectPrivateStateIgnore({ cwd: options.cwd, targetPath: store.path });
    if (ignore.warning) warnings.push(ignore.warning);
  }
  const removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(store.values, key));
  const updatedKeys = Object.keys(updates);
  const changedKeys = [...updatedKeys, ...removedKeys];
  if (options.scope === 'project' && projectLayer === 'shared' && changedKeys.length > 0) {
    const nextValues = { ...store.values, ...updates };
    for (const key of requestedRemoveKeys) delete nextValues[key];
    const boundaryIssues = collectProjectArtifactConfigBoundaryIssues({
      schema,
      sharedEntries: nextValues,
    });
    if (boundaryIssues.length > 0) {
      throw new Error([...new Set(boundaryIssues.map((issue) => issue.message))].join(' '));
    }
  }

  if (changedKeys.length > 0) {
    await patchPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env: options.env,
      updates,
      removeKeys: requestedRemoveKeys,
    });
  }

  const effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
    ...configIdentity,
    pluginName,
    manifest: schemaPlugin.manifest,
    cwd: options.cwd,
    env: options.env,
  }));
  const applied = changedKeys.length === 0
    ? {
        overallState: 'succeeded' as const,
        targetResults: [],
        applySkippedReason: 'noConfigChange' as const,
      }
    : await reinstallVisibleTargets({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: options.rebuildRuntime,
      });
  const otherProjectsRequireReinstall = options.scope === 'user'
    && changedKeys.length > 0;
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    updatedKeys,
    removedKeys,
    effective,
    configWrite: 'succeeded',
    overallState: applied.overallState,
    targetResults: applied.targetResults,
    ...(applied.applySkippedReason ? { applySkippedReason: applied.applySkippedReason } : {}),
    otherProjectsRequireReinstall,
    warnings,
  };
}

export async function applyPluginConfigWrite(
  options: ApplyPluginConfigWriteOptions,
): Promise<PluginConfigWriteReceipt> {
  const requestedPluginName = options.pluginName ?? options.plugin?.manifest.name;
  if (!requestedPluginName) throw new Error('Plugin name is required for config write.');
  assertSafePluginConfigSegment(requestedPluginName);
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      await options.reviewPreflight?.();
      return applyPluginConfigWriteUnlocked({
        ...options,
        awHomeMutationToken,
        rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken },
      });
    },
  });
}

type ResetPluginConfigWriteOptions = {
  pluginName: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugin: PluginMeta;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
  reviewPreflight?: () => Promise<void> | void;
};

async function resetPluginConfigWithHelperUnlocked(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  if (!options.plugin) {
    throw new Error(`sourceMissing: Plugin "${pluginName}" is unavailable; config reset was not applied.`);
  }
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  if (!schemaAccess.plugin?.manifest.config?.schema) {
    throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  const configIdentity = options.plugin.sourceId ? {
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
  } : {};
  const store = await readPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const removedKeys = collectRemovedConfigKeys(store.values);
  const warnings: Array<ProjectBoundaryWarning | string> = [];
  if (options.scope === 'project' && projectLayer === 'shared' && store.exists) {
    await assertProjectSharedConfigPathVisible({ cwd: options.cwd, targetPath: store.path });
  }
  if (options.scope === 'project' && projectLayer === 'local') {
    const ignore = await ensureProjectPrivateStateIgnore({ cwd: options.cwd, targetPath: store.path });
    if (ignore.warning) warnings.push(ignore.warning);
  }

  const reset = await resetPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });

  let applied: Awaited<ReturnType<typeof reinstallVisibleTargets>> = {
    overallState: 'succeeded',
    targetResults: [],
    applySkippedReason: 'noConfigChange',
  };
  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  if (schemaAccess.plugin) {
    if (schemaAccess.plugin.manifest.config?.schema) {
      effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
        ...configIdentity,
        pluginName,
        manifest: schemaAccess.plugin.manifest,
        cwd: options.cwd,
        env: options.env,
      }));
    }
    if (reset.deleted) {
      applied = await reinstallVisibleTargets({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: options.rebuildRuntime,
      });
    }
  }
  const otherProjectsRequireReinstall = Boolean(schemaAccess.plugin)
    && options.scope === 'user'
    && reset.deleted;
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    existed: reset.existed,
    deleted: reset.deleted,
    removedKeys,
    ...(effective ? { effective } : {}),
    configWrite: 'succeeded',
    overallState: applied.overallState,
    targetResults: applied.targetResults,
    ...(applied.applySkippedReason ? { applySkippedReason: applied.applySkippedReason } : {}),
    otherProjectsRequireReinstall,
    warnings,
  };
}

export async function resetPluginConfigWithHelper(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  if (!options.plugin) {
    throw new Error(`sourceMissing: Plugin "${pluginName}" is unavailable; config reset was not applied.`);
  }
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      await options.reviewPreflight?.();
      return resetPluginConfigWithHelperUnlocked({
        ...options,
        awHomeMutationToken,
        rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken },
      });
    },
  });
}

export async function describeResetAffectedFields(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigReceiptFieldEntry[]> {
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  try {
    const resolved = await resolveConfigRead({
      pluginName: options.pluginName,
      plugin: options.plugin,
      ...(options.pluginError ? { pluginError: options.pluginError } : {}),
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env: options.env,
    });
    return resolved.fields.map((field) => buildReceiptFieldEntry({
      key: field.key,
      title: field.title,
      kind: field.kind,
      reserved: field.reserved,
      action: 'reset',
      scope: options.scope,
      projectLayer,
      valueState: field.valueState,
    }));
  } catch {
    const store = await readPluginConfigStore({
      ...(options.plugin?.sourceId ? {
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
      } : options.sourceId ? {
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
      } : {}),
      pluginName: options.pluginName,
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env: options.env,
    });
    return collectRemovedConfigKeys(store.values).map((key) => buildReceiptFieldEntry({
      key,
      title: key,
      kind: 'manifest',
      reserved: false,
      action: 'reset',
      scope: options.scope,
      projectLayer,
    }));
  }
}
