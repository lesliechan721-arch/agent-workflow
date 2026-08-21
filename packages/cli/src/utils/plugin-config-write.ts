import path from 'node:path';

import type { RebuildCommandResult, RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { releaseRebuildOperationLease } from '../commands/rebuild-operations.js';
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
  withPluginConfigTransactionLease,
  writePluginConfigStore,
} from './plugin-config.js';
import {
  assertProjectSharedConfigPathVisible,
  ensureProjectPrivateStateIgnore,
  type ProjectBoundaryWarning,
} from './project-boundary.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from './paths.js';
import { supportsPlatform } from './platform-support.js';
import { acquireLifecycleOperationLock } from './lifecycle-active-store.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export type ConfigApplySkippedReason =
  | 'noVisibleTarget'
  | 'currentCatalogUnavailable'
  | 'noConfigChange';

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidence;
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded' | 'rolledBack' | 'rollbackFailed';
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
  configWrite: 'succeeded' | 'rolledBack' | 'rollbackFailed';
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

async function restorePluginConfigStore(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  snapshot: { exists: boolean; values: Record<string, unknown> };
}): Promise<void> {
  const target = {
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
    } : {}),
    pluginName: options.pluginName,
    scope: options.scope,
    projectLayer: options.projectLayer,
    cwd: options.cwd,
    env: options.env,
  };
  if (options.snapshot.exists) {
    await writePluginConfigStore({ ...target, values: options.snapshot.values });
  } else {
    await resetPluginConfigStore(target);
  }
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

function toConfigApplyTargetResult(
  target: ReceiptTargetIdentity,
  result: RebuildCommandResult,
): ReceiptTargetResult {
  const failed = result.targetResults.find((entry) => entry.state === 'failed');
  return {
    target,
    action: 'reinstall',
    state: result.overallState === 'succeeded' ? 'completed' : 'failed',
    ...(failed?.message ? { message: failed.message } : {}),
  };
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
  attemptedTargets: ReceiptTargetIdentity[];
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
  const attemptedTargets: ReceiptTargetIdentity[] = [];
  const reinstall = options.reinstallCommandImpl ?? reinstallWriteCommand;

  for (const target of discovered.targets) {
    attemptedTargets.push(target);
    try {
      const result = await reinstall(
        [options.plugin.manifest.name],
        {
          cwd: options.cwd,
          platform: target.platform,
          scope: target.scope,
        },
        {
          ...options.rebuildRuntime,
          env: options.env,
          nativeCliRunner,
          ...(options.plugin.sourceId ? {
            catalogResolution: {
              rootDir: path.resolve(options.plugin.rootDir, '..', '..'),
              source: 'local' as const,
            },
            namespacedTarget: {
              sourceId: options.plugin.sourceId,
              sourceIdentity: options.plugin.sourceIdentity!,
              pluginId: options.plugin.pluginId!,
              marketplaceName: options.plugin.marketplaceName!,
              marketplaceRoot: path.join(
                resolveAwHome(options.env),
                'marketplaces',
                options.plugin.sourceId,
              ),
            },
          } : {}),
        },
      );
      targetResults.push(toConfigApplyTargetResult(target, result));
    } catch (error) {
      targetResults.push({
        target,
        action: 'reinstall',
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const overallState = targetResults.some((entry) => entry.state === 'failed')
    ? 'failed'
    : 'succeeded';
  return {
    overallState,
    targetResults,
    attemptedTargets,
    ...(discovered.targets.length === 0 && discovered.failures.length === 0
      ? { applySkippedReason: 'noVisibleTarget' as const }
      : {}),
  };
}

function mergeRollbackTargetResults(
  applied: ReceiptTargetResult[],
  compensation: ReceiptTargetResult[],
): ReceiptTargetResult[] {
  const compensationByTarget = new Map(compensation.map((entry) => [targetKey(entry.target), entry]));
  const projected = applied.map((entry) => {
    const recovery = compensationByTarget.get(targetKey(entry.target));
    if (recovery?.state !== 'failed') return entry;
    compensationByTarget.delete(targetKey(entry.target));
    return {
      ...entry,
      state: 'failed' as const,
      message: `rollbackFailed: ${recovery.message ?? 'runtime compensation failed.'}`,
    };
  });
  for (const recovery of compensationByTarget.values()) {
    if (recovery.state === 'failed') {
      projected.push({
        ...recovery,
        message: `rollbackFailed: ${recovery.message ?? 'runtime compensation failed.'}`,
      });
    }
  }
  return projected;
}

async function compensateConfigRuntimeRollback(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  attemptedTargets: ReceiptTargetIdentity[];
  appliedTargetResults: ReceiptTargetResult[];
  restoreStore: () => Promise<void>;
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
}): Promise<{
  configWrite: 'rolledBack' | 'rollbackFailed';
  targetResults: ReceiptTargetResult[];
  warning: string;
}> {
  try {
    await options.restoreStore();
  } catch (error) {
    const message = `rollbackFailed: config store restore failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      configWrite: 'rollbackFailed',
      targetResults: options.appliedTargetResults.map((entry) => ({
        ...entry,
        state: 'failed',
        message,
      })),
      warning: message,
    };
  }
  let compensation: Awaited<ReturnType<typeof reinstallVisibleTargets>>;
  try {
    compensation = await reinstallVisibleTargets({
      plugin: options.plugin,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      applyTargets: options.attemptedTargets,
      nativeCliRunner: options.nativeCliRunner,
      reinstallCommandImpl: options.reinstallCommandImpl,
      rebuildRuntime: options.rebuildRuntime,
    });
  } catch (error) {
    const message = `rollbackFailed: runtime compensation failed: ${error instanceof Error ? error.message : String(error)}`;
    const affected = options.appliedTargetResults.length > 0
      ? options.appliedTargetResults
      : options.attemptedTargets.map((target): ReceiptTargetResult => ({
          target,
          action: 'reinstall',
          state: 'failed',
        }));
    return {
      configWrite: 'rollbackFailed',
      targetResults: affected.map((entry) => ({ ...entry, state: 'failed', message })),
      warning: message,
    };
  }
  const failed = compensation.overallState === 'failed';
  return {
    configWrite: failed ? 'rollbackFailed' : 'rolledBack',
    targetResults: failed
      ? mergeRollbackTargetResults(options.appliedTargetResults, compensation.targetResults)
      : options.appliedTargetResults,
    warning: failed
      ? 'rollbackFailed: Config store was restored, but runtime compensation failed.'
      : 'Config store and runtime targets were restored because reinstall failed.',
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
}): Promise<ConfigRuntimeReplayReceipt> {
  const applied = await reinstallVisibleTargets({
    plugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env ?? process.env,
    applyTargets: options.applyTargets,
    nativeCliRunner: options.nativeCliRunner,
    reinstallCommandImpl: options.reinstallCommandImpl,
    rebuildRuntime: options.rebuildRuntime,
  });
  return {
    configWrite: 'succeeded',
    overallState: applied.overallState,
    targetResults: applied.targetResults,
    ...(applied.applySkippedReason ? { applySkippedReason: applied.applySkippedReason } : {}),
    otherProjectsRequireReinstall: options.scope === 'user',
  };
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
  request: PluginConfigWriteRequest;
  reviewPreflight?: () => Promise<void> | void;
};

async function withConfigReviewOperationLocks<T>(options: {
  plugin?: PluginMeta | null;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  rebuildRuntime?: RebuildCommandRuntime;
  reviewPreflight?: () => Promise<void> | void;
}, action: (rebuildRuntime: RebuildCommandRuntime | undefined) => Promise<T>): Promise<T> {
  if (!options.reviewPreflight || !options.plugin) return action(options.rebuildRuntime);
  const scopes: Scope[] = options.scope === 'user' ? ['project', 'user'] : ['project'];
  const targets = (['claude', 'codex'] as const).flatMap((platform) =>
    scopes.map((scope) => ({ platform, scope })));
  const leases: Awaited<ReturnType<typeof acquireLifecycleOperationLock>>[] = [];
  try {
    for (const target of targets) {
      leases.push(await acquireLifecycleOperationLock({
        ...(options.plugin.sourceId ? {
          sourceId: options.plugin.sourceId,
          sourceIdentity: options.plugin.sourceIdentity,
        } : {}),
        pluginName: options.plugin.manifest.name,
        platform: target.platform,
        scope: target.scope,
        cwd: options.cwd,
        env: options.env,
      }));
    }
    await options.reviewPreflight();
    return action({ ...options.rebuildRuntime, operationLeaseHeld: true });
  } finally {
    for (const lease of leases.reverse()) {
      try {
        await releaseRebuildOperationLease(lease);
      } catch (error) {
        try {
          process.emitWarning(
            `Config operation lock release failed: ${error instanceof Error ? error.message : String(error)}`,
            { code: 'AW_CONFIG_OPERATION_LOCK_RELEASE_FAILED' },
          );
        } catch {
          // Release diagnostics cannot replace the config action result.
        }
      }
    }
  }
}

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

  let schemaAccess;
  try {
    schemaAccess = await resolvePluginConfigSchemaAccess({
      pluginName,
      currentPlugin: options.plugin,
      currentPluginError: options.pluginError,
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env: options.env,
    });
  } catch {
    schemaAccess = { pluginName, plugin: null };
  }
  const schemaPlugin = schemaAccess.plugin;
  const schema = schemaPlugin?.manifest.config?.schema;
  if (!schema || !schemaPlugin) {
    if (Object.keys(requestedUpdates).length === 0 && requestedRemoveKeys.length > 0) {
      const store = await readPluginConfigStore({
        ...configIdentity,
        pluginName,
        scope: options.scope,
        projectLayer,
        cwd: options.cwd,
        env: options.env,
      });
      const missingKeys = requestedRemoveKeys.filter((key) => !Object.hasOwn(store.values, key));
      if (missingKeys.length > 0) {
        throw new Error(`Unknown config key "${missingKeys[0]}".`);
      }
      const warnings: Array<ProjectBoundaryWarning | string> = [];
      if (options.scope === 'project' && projectLayer === 'shared') {
        await assertProjectSharedConfigPathVisible({ cwd: options.cwd, targetPath: store.path });
      }
      if (options.scope === 'project' && projectLayer === 'local') {
        const ignore = await ensureProjectPrivateStateIgnore({ cwd: options.cwd, targetPath: store.path });
        if (ignore.warning) warnings.push(ignore.warning);
      }
      await patchPluginConfigStore({
        ...configIdentity,
        pluginName,
        scope: options.scope,
        projectLayer,
        cwd: options.cwd,
        env: options.env,
        updates: {},
        removeKeys: requestedRemoveKeys,
        requireExistingRemoveKeys: true,
        reviewPreflight: options.reviewPreflight,
      });
      return {
        plugin: pluginName,
        scope: options.scope,
        projectLayer,
        updatedKeys: [],
        removedKeys: requestedRemoveKeys,
        effective: {
          values: {},
          sources: {},
          issues: [],
          ignoredUnknownKeys: [],
        },
        configWrite: 'succeeded',
        overallState: 'succeeded',
        targetResults: [],
        applySkippedReason: 'currentCatalogUnavailable',
        otherProjectsRequireReinstall: false,
        warnings,
      };
    }
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
      reviewPreflight: options.reviewPreflight,
    });
  }

  const effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
    ...configIdentity,
    pluginName,
    manifest: schemaPlugin.manifest,
    cwd: options.cwd,
    env: options.env,
  }));
  let applied: Awaited<ReturnType<typeof reinstallVisibleTargets>>;
  try {
    applied = changedKeys.length === 0
      ? {
          overallState: 'succeeded' as const,
          targetResults: [],
          attemptedTargets: [],
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
  } catch (error) {
    if (changedKeys.length > 0) {
      await restorePluginConfigStore({
        ...configIdentity,
        pluginName,
        scope: options.scope,
        projectLayer,
        cwd: options.cwd,
        env: options.env,
        snapshot: store,
      });
    }
    throw error;
  }
  const rollbackRequired = changedKeys.length > 0 && applied.overallState === 'failed';
  const rollback = rollbackRequired
    ? await compensateConfigRuntimeRollback({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        attemptedTargets: applied.attemptedTargets,
        appliedTargetResults: applied.targetResults,
        restoreStore: () => restorePluginConfigStore({
          ...configIdentity,
          pluginName,
          scope: options.scope,
          projectLayer,
          cwd: options.cwd,
          env: options.env,
          snapshot: store,
        }),
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: options.rebuildRuntime,
      })
    : undefined;
  if (rollback) warnings.push(rollback.warning);
  const finalEffective = rollbackRequired
    ? summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
        ...configIdentity,
        pluginName,
        manifest: schemaPlugin.manifest,
        cwd: options.cwd,
        env: options.env,
      }))
    : effective;
  const otherProjectsRequireReinstall = options.scope === 'user'
    && changedKeys.length > 0
    && !rollbackRequired;
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    updatedKeys: rollbackRequired ? [] : updatedKeys,
    removedKeys: rollbackRequired ? [] : removedKeys,
    effective: finalEffective,
    configWrite: rollback?.configWrite ?? 'succeeded',
    overallState: applied.overallState,
    targetResults: rollback?.targetResults ?? applied.targetResults,
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
  const pluginName = assertSafePluginConfigSegment(requestedPluginName);
  return withPluginConfigTransactionLease({
    ...(options.plugin?.sourceId ? { sourceId: options.plugin.sourceId } : {}),
    pluginName,
    scope: options.scope,
    projectLayer: options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared',
    cwd: options.cwd,
    env: options.env,
    action: async () => {
      await options.reviewPreflight?.();
      return withConfigReviewOperationLocks(options, (rebuildRuntime) =>
        applyPluginConfigWriteUnlocked({ ...options, rebuildRuntime }));
    },
  });
}

type ResetPluginConfigWriteOptions = {
  sourceId?: string;
  sourceIdentity?: string;
  pluginName: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  reviewPreflight?: () => Promise<void> | void;
};

async function resetPluginConfigWithHelperUnlocked(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const configIdentity = options.plugin?.sourceId ? {
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
  } : options.sourceId ? {
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
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

  const schemaAccess = options.plugin
    ? await resolvePluginConfigSchemaAccess({
        pluginName,
        currentPlugin: options.plugin,
        scope: options.scope,
        projectLayer,
        cwd: options.cwd,
        env: options.env,
      })
    : { pluginName, plugin: null };
  const reset = await resetPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
    reviewPreflight: options.reviewPreflight,
  });

  let applied: Awaited<ReturnType<typeof reinstallVisibleTargets>> = {
    overallState: 'succeeded',
    targetResults: [],
    attemptedTargets: [],
    applySkippedReason: reset.deleted ? 'currentCatalogUnavailable' : 'noConfigChange',
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
      try {
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
      } catch (error) {
        await restorePluginConfigStore({
          ...configIdentity,
          pluginName,
          scope: options.scope,
          projectLayer,
          cwd: options.cwd,
          env: options.env,
          snapshot: store,
        });
        throw error;
      }
    }
  }
  const rollbackRequired = reset.deleted && applied.overallState === 'failed';
  const rollback = rollbackRequired && schemaAccess.plugin
    ? await compensateConfigRuntimeRollback({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        attemptedTargets: applied.attemptedTargets,
        appliedTargetResults: applied.targetResults,
        restoreStore: () => restorePluginConfigStore({
          ...configIdentity,
          pluginName,
          scope: options.scope,
          projectLayer,
          cwd: options.cwd,
          env: options.env,
          snapshot: store,
        }),
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: options.rebuildRuntime,
      })
    : undefined;
  if (rollback) {
    warnings.push(rollback.warning);
    if (schemaAccess.plugin?.manifest.config?.schema) {
      effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
        ...configIdentity,
        pluginName,
        manifest: schemaAccess.plugin.manifest,
        cwd: options.cwd,
        env: options.env,
      }));
    }
  }
  const otherProjectsRequireReinstall = Boolean(schemaAccess.plugin)
    && options.scope === 'user'
    && reset.deleted
    && !rollbackRequired;
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    existed: reset.existed,
    deleted: rollbackRequired ? false : reset.deleted,
    removedKeys: rollbackRequired ? [] : removedKeys,
    ...(effective ? { effective } : {}),
    configWrite: rollback?.configWrite ?? 'succeeded',
    overallState: applied.overallState,
    targetResults: rollback?.targetResults ?? applied.targetResults,
    ...(applied.applySkippedReason ? { applySkippedReason: applied.applySkippedReason } : {}),
    otherProjectsRequireReinstall,
    warnings,
  };
}

export async function resetPluginConfigWithHelper(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const sourceId = options.plugin?.sourceId ?? options.sourceId;
  return withPluginConfigTransactionLease({
    ...(sourceId ? { sourceId } : {}),
    pluginName,
    scope: options.scope,
    projectLayer: options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared',
    cwd: options.cwd,
    env: options.env,
    action: async () => {
      await options.reviewPreflight?.();
      return withConfigReviewOperationLocks(options, (rebuildRuntime) =>
        resetPluginConfigWithHelperUnlocked({ ...options, rebuildRuntime }));
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
