import { stablePluginConfigStringify } from '@lesliechan721/aw-plugin-core/manifest';

import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import {
  statusCommandV7,
  statusTargetIntent,
} from '../commands/status-v6.js';
import { syncWriteCommand } from '../commands/write-commands.js';
import type {
  ConfigReceiptFieldEntry,
  ConfigSchemaEvidence,
  PlatformName,
  PluginMeta,
  RebuildReceiptOverallState,
  ReceiptTargetIdentity,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from './native-cli.js';
import {
  assertReadyPluginConfigStore,
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigSchemaAccess,
  summarizeEffectivePluginConfig,
} from './plugin-config.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from './paths.js';
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
  | 'noConfigChange'
  | 'invalidConfig'
  | 'notRequested';

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  schema?: ConfigSchemaEvidence;
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
  otherProjectsRequireReinstall: boolean;
  warnings: string[];
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  schema?: ConfigSchemaEvidence;
  existed: boolean;
  deleted: boolean;
  removedKeys: string[];
  effective?: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
  otherProjectsRequireReinstall: boolean;
  warnings: string[];
}

type ReinstallCommand = typeof syncWriteCommand;

interface ConfigRuntimeReplayReceipt {
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
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
  const selector = options.plugin.pluginId ?? options.pluginName;
  const status = await statusCommandV7({
    plugins: [selector],
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
    ...(options.scope === 'project' ? { scope: 'project' } : {}),
    ...(options.rebuildRuntime?.catalogOperationContext
      ? { catalogOperationContext: options.rebuildRuntime.catalogOperationContext }
      : {}),
  });
  for (const statusTarget of status.payload.targets) {
    const intent = statusTargetIntent(statusTarget);
    if ((statusTarget.pluginId !== selector && statusTarget.pluginName !== options.pluginName)
      || !intent.enabled) continue;
    for (const scope of intent.scopes) {
      if (options.scope === 'project' && scope !== 'project') continue;
      targets.push(await createCandidateTarget({
        pluginName: options.pluginName,
        platform: statusTarget.platform,
        scope,
        cwd: options.cwd,
      }));
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
  discovered?: Awaited<ReturnType<typeof discoverVisibleTargets>>;
}): Promise<{
  overallState: RebuildReceiptOverallState;
  targetResults: ReceiptTargetResult[];
  applySkippedReason?: ConfigApplySkippedReason;
}> {
  const nativeCliRunner = options.nativeCliRunner ?? getDefaultNativeCliRunner();
  const discovered = options.discovered ?? (options.applyTargets === undefined
    ? await discoverVisibleTargets({
        pluginName: options.plugin.manifest.name,
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        nativeCliRunner,
        rebuildRuntime: options.rebuildRuntime,
      })
    : { targets: dedupeTargets(options.applyTargets), failures: [] });
  const targetResults = [...discovered.failures];
  let runtimeFailed = discovered.failures.length > 0;
  const reinstall = options.reinstallCommandImpl ?? syncWriteCommand;
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
    ? 'partial' : 'succeeded';
  return {
    overallState,
    targetResults,
    ...(discovered.targets.length === 0 && discovered.failures.length === 0
      ? { applySkippedReason: 'noVisibleTarget' as const }
      : {}),
  };
}

async function resolveConfigApplyTargets(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  rebuildRuntime?: RebuildCommandRuntime;
}): Promise<Awaited<ReturnType<typeof discoverVisibleTargets>>> {
  if (options.applyTargets !== undefined) {
    return { targets: dedupeTargets(options.applyTargets), failures: [] };
  }
  return discoverVisibleTargets({
    pluginName: options.plugin.manifest.name,
    plugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner ?? getDefaultNativeCliRunner(),
    rebuildRuntime: options.rebuildRuntime,
  });
}

async function configApplyHasIssues(options: {
  plugin: PluginMeta;
  targets: ReceiptTargetIdentity[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  knownValidScopes?: Scope[];
}): Promise<boolean> {
  const scopes = [...new Set(options.targets.map((target) => target.scope))];
  for (const scope of scopes) {
    if (options.knownValidScopes?.includes(scope)) continue;
    const effective = await resolveEffectivePluginConfig({
      ...(options.plugin.sourceId ? {
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
      } : {}),
      pluginName: options.plugin.manifest.name,
      manifest: options.plugin.manifest,
      targetScope: scope,
      cwd: options.cwd,
      env: options.env,
    });
    if (effective.issues.length > 0) return true;
  }
  return false;
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
  valueState?: ConfigReceiptFieldEntry['valueState'];
}): ConfigReceiptFieldEntry {
  return {
    key: options.key,
    title: options.title,
    kind: options.kind,
    reserved: options.reserved,
    action: options.action,
    scope: options.scope,
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
      const env = options.env ?? process.env;
      const rebuildRuntime = { ...options.rebuildRuntime, awHomeMutationToken };
      const discovered = await resolveConfigApplyTargets({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        rebuildRuntime,
      });
      const applied = await configApplyHasIssues({
        plugin: options.plugin,
        targets: discovered.targets,
        cwd: options.cwd,
        env,
      }) ? {
          overallState: 'partial' as const,
          targetResults: [],
          applySkippedReason: 'invalidConfig' as const,
        } : await reinstallVisibleTargets({
          plugin: options.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env,
          applyTargets: options.applyTargets,
          nativeCliRunner: options.nativeCliRunner,
          reinstallCommandImpl: options.reinstallCommandImpl,
          rebuildRuntime,
          discovered,
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
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
  request: PluginConfigWriteRequest;
  apply?: boolean;
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
    cwd: options.cwd,
    env: options.env,
  });
  const schemaPlugin = schemaAccess.plugin;
  const schema = schemaPlugin?.manifest.config?.fields;
  if (!schema || !schemaPlugin) {
    throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  if (options.scope === 'project') {
    const userStore = await readPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
      schema,
    });
    assertReadyPluginConfigStore(userStore);
  }

  for (const key of requestedRemoveKeys) {
    if (!schema[key]) throw new Error(`Unknown config key "${key}".`);
  }

  const updates = await coercePluginConfigUpdates({ schema, updates: requestedUpdates, cwd: options.cwd });
  const store = await readPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    schema,
  });
  assertReadyPluginConfigStore(store);
  const warnings: string[] = [];
  const removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(store.values, key));
  const updatedKeys = Object.entries(updates)
    .filter(([key, value]) => !Object.hasOwn(store.values, key)
      || stablePluginConfigStringify(store.values[key]!) !== stablePluginConfigStringify(value))
    .map(([key]) => key);
  const changedKeys = [...updatedKeys, ...removedKeys];
  if (changedKeys.length > 0) {
    await patchPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      updates: Object.fromEntries(updatedKeys.map((key) => [key, updates[key]!])),
      removeKeys: requestedRemoveKeys,
      schema,
    });
  }

  const effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
    ...configIdentity,
    pluginName,
    manifest: schemaPlugin.manifest,
    targetScope: options.scope,
    cwd: options.cwd,
    env: options.env,
  }));
  let applied: Awaited<ReturnType<typeof reinstallVisibleTargets>>;
  if (changedKeys.length === 0) {
    applied = {
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noConfigChange',
    };
  } else if (effective.issues.length > 0) {
    applied = {
      overallState: 'partial',
      targetResults: [],
      applySkippedReason: 'invalidConfig',
    };
  } else if (options.apply === false) {
    applied = {
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'notRequested',
    };
  } else {
    const discovered = await resolveConfigApplyTargets({
      plugin: schemaPlugin,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env ?? process.env,
      applyTargets: options.applyTargets,
      nativeCliRunner: options.nativeCliRunner,
      rebuildRuntime: options.rebuildRuntime,
    });
    applied = await configApplyHasIssues({
      plugin: schemaPlugin,
      targets: discovered.targets,
      cwd: options.cwd,
      env: options.env,
      knownValidScopes: [options.scope],
    }) ? {
        overallState: 'partial',
        targetResults: [],
        applySkippedReason: 'invalidConfig',
      } : await reinstallVisibleTargets({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        reinstallCommandImpl: options.reinstallCommandImpl,
        rebuildRuntime: options.rebuildRuntime,
        discovered,
      });
  }
  const otherProjectsRequireReinstall = options.scope === 'user'
    && changedKeys.length > 0
    && effective.issues.length === 0
    && applied.applySkippedReason !== 'invalidConfig';
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
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
  sourceId?: string;
  sourceIdentity?: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
  reviewPreflight?: () => Promise<void> | void;
  apply?: boolean;
};

async function resetPluginConfigWithHelperUnlocked(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const schemaAccess = options.plugin ? await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  }) : undefined;
  const configIdentity = options.plugin?.sourceId ? {
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
  } : options.sourceId ? {
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
  } : {};
  if (options.scope === 'project' && schemaAccess?.plugin?.manifest.config?.fields) {
    const userStore = await readPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
      schema: schemaAccess.plugin.manifest.config.fields,
    });
    assertReadyPluginConfigStore(userStore);
  }
  const store = await readPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const removedKeys = collectRemovedConfigKeys(store.values);
  const warnings: string[] = [];

  const reset = await resetPluginConfigStore({
    ...configIdentity,
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });

  let applied: Awaited<ReturnType<typeof reinstallVisibleTargets>> = {
    overallState: 'succeeded',
    targetResults: [],
    applySkippedReason: reset.deleted ? 'notRequested' : 'noConfigChange',
  };
  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  if (schemaAccess?.plugin) {
    if (schemaAccess.plugin.manifest.config?.fields) {
      effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
        ...configIdentity,
        pluginName,
        manifest: schemaAccess.plugin.manifest,
        targetScope: options.scope,
        cwd: options.cwd,
        env: options.env,
      }));
    }
    if (reset.deleted && effective && effective.issues.length > 0) {
      applied = {
        overallState: 'partial',
        targetResults: [],
        applySkippedReason: 'invalidConfig',
      };
    } else if (reset.deleted && options.apply !== false) {
      const discovered = await resolveConfigApplyTargets({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        rebuildRuntime: options.rebuildRuntime,
      });
      applied = await configApplyHasIssues({
        plugin: schemaAccess.plugin,
        targets: discovered.targets,
        cwd: options.cwd,
        env: options.env,
        knownValidScopes: effective ? [options.scope] : undefined,
      }) ? {
          overallState: 'partial',
          targetResults: [],
          applySkippedReason: 'invalidConfig',
        } : await reinstallVisibleTargets({
          plugin: schemaAccess.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env ?? process.env,
          applyTargets: options.applyTargets,
          nativeCliRunner: options.nativeCliRunner,
          reinstallCommandImpl: options.reinstallCommandImpl,
          rebuildRuntime: options.rebuildRuntime,
          discovered,
        });
    }
  }
  const otherProjectsRequireReinstall = Boolean(schemaAccess?.plugin)
    && options.scope === 'user'
    && reset.deleted
    && (effective?.issues.length ?? 0) === 0
    && applied.applySkippedReason !== 'invalidConfig';
  if (otherProjectsRequireReinstall) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    ...(schemaAccess?.schema ? { schema: schemaAccess.schema } : {}),
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
  assertSafePluginConfigSegment(options.pluginName);
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
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigReceiptFieldEntry[]> {
  try {
    const resolved = await resolveConfigRead({
      pluginName: options.pluginName,
      plugin: options.plugin,
      ...(options.pluginError ? { pluginError: options.pluginError } : {}),
      scope: options.scope,
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
    }));
  }
}
