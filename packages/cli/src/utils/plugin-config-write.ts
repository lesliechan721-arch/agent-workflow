import { stablePluginConfigStringify } from '@lesliechan721/aw-plugin-core/manifest';

import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import {
  statusCommandV7,
  statusTargetIntent,
} from '../commands/status-v6.js';
import { syncWriteCommand } from '../commands/write-commands.js';
import {
  CONFIG_MUTATION_RECEIPT_SCHEMA_VERSION,
  type ConfigApplyError,
  type ConfigApplyResult,
  type ConfigApplyTargetResult,
  type ConfigReceiptFieldEntry,
  type ConfigMutationCommand,
  type ConfigMutationReceiptBase,
  type ConfigSchemaEvidence,
  type PlatformName,
  type PluginMeta,
  type RebuildReceiptOverallState,
  type ReceiptTargetIdentity,
  type ReceiptTargetResult,
  type Scope,
} from '../types.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from './native-cli.js';
import {
  assertReadyPluginConfigStore,
  assertSafePluginConfigSegment,
  codexNativeRefreshKeys,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  readPluginConfigStore,
  readNamespacedPluginConfigStoreIdentity,
  resetPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  resolvePluginConfigSchemaAccess,
  summarizeEffectivePluginConfig,
  type PluginConfigValue,
} from './plugin-config.js';
import {
  collectSensitivePluginConfigValues,
  redactPluginScriptOutput,
} from './plugin-scripts.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from './paths.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import {
  assertProjectSharedConfigPathVisible,
} from './project-boundary.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export function buildConfigMutationReceipt<
  Command extends ConfigMutationCommand,
  Receipt extends Pick<ConfigMutationReceiptBase, 'ok' | 'overallState' | 'configWrite'>,
>(
  command: Command,
  receipt: Receipt,
): ConfigMutationReceiptBase<Command> & Receipt {
  return {
    ...receipt,
    receiptSchemaVersion: CONFIG_MUTATION_RECEIPT_SCHEMA_VERSION,
    command,
  };
}

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  schema?: ConfigSchemaEvidence;
  updatedKeys: string[];
  removedKeys: string[];
  staleRemovedKeys: string[];
  effective?: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
  apply: ConfigApplyResult;
  otherProjectsMayRequireSync: boolean;
  warnings: string[];
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  schema?: ConfigSchemaEvidence;
  existed: boolean;
  deleted: boolean;
  resetDisposition: 'absent' | 'deletedFile' | 'unlinkedSymlink' | 'quarantinedDirectory';
  quarantineBasename?: string;
  removedKeys: string[];
  effective?: ReturnType<typeof summarizeEffectivePluginConfig>;
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
  apply: ConfigApplyResult;
  otherProjectsMayRequireSync: boolean;
  warnings: string[];
}

type ReinstallCommand = typeof syncWriteCommand;

interface ConfigRuntimeReplayReceipt {
  configWrite: 'succeeded';
  overallState: RebuildReceiptOverallState;
  apply: ConfigApplyResult;
  otherProjectsMayRequireSync: false;
}

interface InternalConfigApplyTargetResult extends Omit<ReceiptTargetResult, 'state'> {
  state: ConfigApplyTargetResult['state'];
}

type InternalConfigApplyResult =
  | Extract<ConfigApplyResult, { state: 'skipped' }>
  | (Omit<Extract<ConfigApplyResult, { state: 'unavailable' }>, 'targetResults'> & {
      targetResults: InternalConfigApplyTargetResult[];
    })
  | (Omit<Extract<ConfigApplyResult, { state: 'succeeded' }>, 'targetResults'> & {
      targetResults: InternalConfigApplyTargetResult[];
    })
  | (Omit<Extract<ConfigApplyResult, { state: 'partial' }>, 'targetResults'> & {
      targetResults: InternalConfigApplyTargetResult[];
    });

function publicConfigApplyTargetResult(
  result: InternalConfigApplyTargetResult,
): ConfigApplyTargetResult {
  return {
    target: {
      pluginName: result.target.pluginName,
      ...(result.target.pluginId ? { pluginId: result.target.pluginId } : {}),
      platform: result.target.platform,
      scope: result.target.scope,
    },
    action: result.action,
    state: result.state,
    ...(result.message ? { message: result.message } : {}),
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.relation ? { relation: result.relation } : {}),
    ...(result.requiredBy ? { requiredBy: result.requiredBy } : {}),
  };
}

function publicConfigApplyResult(apply: InternalConfigApplyResult): ConfigApplyResult {
  if (apply.state === 'skipped') return apply;
  return {
    ...apply,
    targetResults: apply.targetResults.map(publicConfigApplyTargetResult),
  };
}

export function configWriteStateForError(error: unknown): 'notStarted' | 'failed' {
  return (error as { configWrite?: unknown })?.configWrite === 'failed'
    ? 'failed'
    : 'notStarted';
}

function markConfigWriteFailed(error: unknown): Error & { configWrite: 'failed'; code?: string } {
  const failure = error instanceof Error ? error : new Error(String(error));
  return Object.assign(failure, { configWrite: 'failed' as const });
}

function skippedApply(
  reason: Extract<ConfigApplyResult, { state: 'skipped' }>['reason'],
): ConfigApplyResult {
  return { state: 'skipped', reason, targetResults: [] };
}

function unavailableApply(
  reason: Extract<ConfigApplyResult, { state: 'unavailable' }>['reason'],
  stage: ConfigApplyError['stage'],
  targetResults: InternalConfigApplyTargetResult[] = [],
): InternalConfigApplyResult {
  const messages: Record<typeof reason, string> = {
    invalidConfig: 'The effective config is invalid for every visible target.',
    schemaUnavailable: 'The config schema is unavailable after the config commit.',
    sourceUnavailable: 'The plugin source is unavailable after the config commit.',
    effectiveConfigUnavailable: 'The effective config cannot be read after the config commit.',
    targetDiscoveryFailed: 'Visible config apply targets cannot be discovered after the config commit.',
  };
  return {
    state: 'unavailable',
    reason,
    targetResults,
    error: { stage, code: reason, message: messages[reason] },
  };
}

function overallStateForApply(apply: InternalConfigApplyResult): RebuildReceiptOverallState {
  return apply.state === 'succeeded' || apply.state === 'skipped' ? 'succeeded' : 'partial';
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
}): Promise<InternalConfigApplyResult> {
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
  const targetResults: InternalConfigApplyTargetResult[] = [...discovered.failures];
  let runtimeFailed = discovered.failures.length > 0;
  let invalidTargets = 0;
  let unavailableTargets = 0;
  const errors: ConfigApplyError[] = [];
  const reinstall = options.reinstallCommandImpl ?? syncWriteCommand;
  if (options.plugin.sourceId && !options.plugin.pluginId) {
    throw new Error(`Plugin "${options.plugin.manifest.name}" is missing its namespaced plugin ID.`);
  }
  const selector = options.plugin.sourceId
    ? options.plugin.pluginId!
    : options.plugin.manifest.name;

  const sanitizeFailure = async (
    message: string,
    target: ReceiptTargetIdentity,
  ): Promise<string> => {
    let sensitiveValues: string[] = [];
    try {
      const effective = await resolveEffectivePluginConfig({
        ...(options.plugin.sourceId ? {
          sourceId: options.plugin.sourceId,
          sourceIdentity: options.plugin.sourceIdentity,
          logicalIdentity: options.plugin.catalogLogicalIdentity,
        } : {}),
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: target.scope,
        cwd: options.cwd,
        env: options.env,
      });
      sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, effective.values);
    } catch {
      // Generic credential redaction and known config paths still apply.
    }
    let sanitized = redactPluginScriptOutput(message, sensitiveValues);
    for (const privatePath of [target.projectKey, options.cwd]) {
      if (privatePath) sanitized = sanitized.split(privatePath).join('<project>');
    }
    for (const scope of ['user', 'project'] as const) {
      const configPath = resolvePluginConfigStorePath({
        sourceId: options.plugin.sourceId,
        pluginName: options.plugin.manifest.name,
        scope,
        cwd: options.cwd,
        env: options.env,
      });
      const safeTarget = `${scope}/plugin-config/${[
        options.plugin.sourceId,
        options.plugin.manifest.name,
        'config.json',
      ].filter(Boolean).join('/')}`;
      sanitized = sanitized.split(configPath).join(safeTarget);
    }
    return sanitized;
  };
  const sanitizeProjection = async (
    value: unknown,
    target: ReceiptTargetIdentity,
    freeText = false,
  ): Promise<unknown> => {
    if (typeof value === 'string') return freeText ? sanitizeFailure(value, target) : value;
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry) => sanitizeProjection(entry, target, freeText)));
    }
    return Object.fromEntries(await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([key, entry]) => [
        key,
        await sanitizeProjection(
          entry,
          target,
          typeof entry === 'string'
            ? /^(?:message|error|stack|stdout|stderr|output|warning)$/u.test(key)
            : Array.isArray(entry) && /^(?:messages|warnings)$/u.test(key),
        ),
      ]),
    ));
  };

  for (const target of discovered.targets) {
    try {
      const effective = await resolveEffectivePluginConfig({
        ...(options.plugin.sourceId ? {
          sourceId: options.plugin.sourceId,
          sourceIdentity: options.plugin.sourceIdentity,
          logicalIdentity: options.plugin.catalogLogicalIdentity,
        } : {}),
        pluginName: options.plugin.manifest.name,
        manifest: options.plugin.manifest,
        targetScope: target.scope,
        cwd: options.cwd,
        env: options.env,
      });
      if (effective.issues.length > 0) {
        invalidTargets += 1;
        targetResults.push({
          target,
          action: 'reinstall',
          state: 'skipped',
          errorCode: 'invalidConfig',
          message: 'The effective config is invalid for this target.',
        });
        continue;
      }
    } catch {
      runtimeFailed = true;
      unavailableTargets += 1;
      targetResults.push({
        target,
        action: 'reinstall',
        state: 'failed',
        errorCode: 'effectiveConfigUnavailable',
        message: 'The effective config cannot be read for this target.',
      });
      errors.push({
        stage: 'targetValidation',
        code: 'effectiveConfigUnavailable',
        message: 'The effective config cannot be read for a visible target.',
      });
      continue;
    }
    try {
      const debugLogger = options.rebuildRuntime?.debugLogger;
      const reporter = options.rebuildRuntime?.reporter;
      const result = await reinstall(
        [selector],
        {
          cwd: options.cwd,
          platform: target.platform,
          scope: target.scope,
          yes: true,
          ...(options.rebuildRuntime?.scriptTimeoutMs === undefined
            ? {}
            : { scriptTimeoutMs: options.rebuildRuntime.scriptTimeoutMs }),
        },
        {
          ...options.rebuildRuntime,
          env: options.env,
          nativeCliRunner,
          ...(debugLogger ? {
            debugLogger: {
              ...debugLogger,
              log: async (value) => debugLogger.log(await sanitizeProjection(value, target) as never),
            },
          } : {}),
          ...(reporter ? {
            reporter: {
              event: async (value) => reporter.event(await sanitizeProjection(value, target) as never),
              notice: async (value) => reporter.notice(await sanitizeProjection(value, target) as never),
            },
          } : {}),
        },
      );
      options.rebuildRuntime?.operationDiagnosticSink?.(result.rebuildResults);
      if (result.overallState !== 'succeeded') runtimeFailed = true;
      targetResults.push(...await Promise.all(result.targetResults.map(async (entry) => ({
        ...entry,
        state: entry.action === 'skipped' ? 'skipped' as const : entry.state,
        ...(entry.message ? { message: await sanitizeFailure(entry.message, entry.target) } : {}),
      }))));
    } catch (error) {
      runtimeFailed = true;
      const message = await sanitizeFailure(
        error instanceof Error ? error.message : String(error),
        target,
      );
      targetResults.push({
        target,
        action: 'reinstall',
        state: 'failed',
        message,
      });
      errors.push({
        stage: 'apply',
        code: 'targetApplyFailed',
        message: 'A visible config apply target failed.',
      });
    }
  }

  if (discovered.targets.length === 0 && discovered.failures.length === 0) {
    return skippedApply('noVisibleTarget');
  }
  if (discovered.targets.length > 0 && invalidTargets === discovered.targets.length) {
    return unavailableApply('invalidConfig', 'targetValidation', targetResults);
  }
  if (discovered.targets.length > 0 && unavailableTargets === discovered.targets.length) {
    return unavailableApply('effectiveConfigUnavailable', 'targetValidation', targetResults);
  }
  if (runtimeFailed
    || invalidTargets > 0
    || unavailableTargets > 0
    || targetResults.some((entry) => entry.state === 'failed' || entry.state === 'skipped')) {
    return {
      state: 'partial',
      targetResults,
      ...(errors.length > 0 ? { errors } : {}),
    };
  }
  return { state: 'succeeded', targetResults };
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

async function configApplyHasValidCodexTarget(options: {
  plugin: PluginMeta;
  targets: ReceiptTargetIdentity[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const codexScopes = new Set(options.targets
    .filter((target) => target.platform === 'codex')
    .map((target) => target.scope));
  for (const scope of codexScopes) {
    const effective = await resolveEffectivePluginConfig({
      ...(options.plugin.sourceId ? {
        sourceId: options.plugin.sourceId,
        sourceIdentity: options.plugin.sourceIdentity,
        logicalIdentity: options.plugin.catalogLogicalIdentity,
      } : {}),
      pluginName: options.plugin.manifest.name,
      manifest: options.plugin.manifest,
      targetScope: scope,
      cwd: options.cwd,
      env: options.env,
    });
    if (effective.issues.length === 0) return true;
  }
  return false;
}

async function applyConfigToVisibleTargets(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  noVisibleTargetHasInvalidConfig?: boolean;
}): Promise<InternalConfigApplyResult> {
  let discovered: Awaited<ReturnType<typeof resolveConfigApplyTargets>>;
  try {
    discovered = await resolveConfigApplyTargets(options);
  } catch {
    return unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
  }
  if (discovered.targets.length === 0
    && discovered.failures.length === 0
    && options.noVisibleTargetHasInvalidConfig) {
    return unavailableApply('invalidConfig', 'targetValidation');
  }
  return reinstallVisibleTargets({ ...options, discovered });
}

function otherProjectsWarning(scope: Scope): string[] {
  return scope === 'user'
    ? ['其它项目不会由本次命令扫描或更新，可能需要在对应项目目录中运行 aw sync。']
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
  sharedNativeApplyConfirmed?: boolean;
}): Promise<ConfigRuntimeReplayReceipt> {
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      const env = options.env ?? process.env;
      const rebuildRuntime = { ...options.rebuildRuntime, awHomeMutationToken };
      let discovered: Awaited<ReturnType<typeof resolveConfigApplyTargets>>;
      try {
        discovered = await resolveConfigApplyTargets({
          plugin: options.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env,
          applyTargets: options.applyTargets,
          nativeCliRunner: options.nativeCliRunner,
          rebuildRuntime,
        });
      } catch {
        return {
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: publicConfigApplyResult(unavailableApply('targetDiscoveryFailed', 'targetDiscovery')),
          otherProjectsMayRequireSync: false,
        };
      }
      if (
        options.scope === 'user'
        && options.sharedNativeApplyConfirmed !== true
        && pluginHasSharedNativeRefreshKeys(options.plugin)
        && await configApplyHasValidCodexTarget({
          plugin: options.plugin,
          targets: discovered.targets,
          cwd: options.cwd,
          env,
        })
      ) {
        throwSharedNativeApplyConfirmationRequired();
      }
      const apply = await reinstallVisibleTargets({
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
        overallState: overallStateForApply(apply),
        apply: publicConfigApplyResult(apply),
        otherProjectsMayRequireSync: false,
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
  sharedNativeApplyConfirmed?: boolean;
  reviewPreflight?: () => Promise<void> | void;
};

function changedKeysAffectSharedNativeTarget(options: {
  plugin: PluginMeta;
  changedKeys: readonly string[];
}): boolean {
  const changedKeys = new Set(options.changedKeys);
  return (options.plugin.manifest.artifacts?.targets ?? []).some((target) =>
    target.platform === 'codex'
    && target.target === 'codex.skill'
    && target.delivery?.mode === 'codex-native'
    && target.refreshKeys.some((key) => changedKeys.has(key)));
}

function pluginHasSharedNativeRefreshKeys(plugin: PluginMeta): boolean {
  return (plugin.manifest.artifacts?.targets ?? []).some((target) =>
    target.platform === 'codex'
    && target.target === 'codex.skill'
    && target.delivery?.mode === 'codex-native'
    && target.refreshKeys.length > 0);
}

function throwSharedNativeApplyConfirmationRequired(): never {
  const error = new Error(
    'sharedNativeConfigApplyConfirmationRequired: Applying this user config changes a shared Codex native artifact. Re-run with --yes.',
  ) as Error & { code: string };
  error.code = 'sharedNativeConfigApplyConfirmationRequired';
  throw error;
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
    logicalIdentity: options.plugin.catalogLogicalIdentity,
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

  if (options.scope === 'project') {
    const rejectedSensitiveKeys = Object.keys(requestedUpdates)
      .filter((key) => schema[key]?.sensitive === true);
    if (rejectedSensitiveKeys.length > 0) {
      const error = new Error(
        'sensitiveProjectConfigUnsupported: Sensitive config can only be set in user scope.',
      ) as Error & { code: string };
      error.code = 'sensitiveProjectConfigUnsupported';
      throw error;
    }
    const userOnlyKeys = codexNativeRefreshKeys(schemaPlugin.manifest);
    const rejectedKeys = Object.keys(requestedUpdates).filter((key) => userOnlyKeys.has(key));
    if (rejectedKeys.length > 0) {
      const error = new Error(
        `sharedNativeConfigUserScopeRequired: Codex native Skill refresh keys can only be set in user scope: ${rejectedKeys.join(', ')}.`,
      ) as Error & { code: string };
      error.code = 'sharedNativeConfigUserScopeRequired';
      throw error;
    }
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
  for (const key of requestedRemoveKeys) {
    if (!schema[key] && !Object.hasOwn(store.values, key)) {
      throw new Error(`Unknown config key "${key}".`);
    }
  }
  const warnings: string[] = [];
  const removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(store.values, key));
  const staleRemovedKeys = removedKeys.filter((key) => !schema[key]);
  const updatedKeys = Object.entries(updates)
    .filter(([key, value]) => !Object.hasOwn(store.values, key)
      || stablePluginConfigStringify(store.values[key]!) !== stablePluginConfigStringify(value))
    .map(([key]) => key);
  const changedKeys = [...updatedKeys, ...removedKeys];
  let applyTargets = options.applyTargets;
  const sharedNativeAffected = changedKeysAffectSharedNativeTarget({
    plugin: schemaPlugin,
    changedKeys,
  });
  if (
    options.apply !== false
    && options.scope === 'user'
    && options.sharedNativeApplyConfirmed !== true
    && sharedNativeAffected
  ) {
    applyTargets ??= (await discoverVisibleTargets({
      plugin: schemaPlugin,
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env ?? process.env,
      nativeCliRunner: options.nativeCliRunner ?? getDefaultNativeCliRunner(),
      rebuildRuntime: options.rebuildRuntime,
    })).targets;
    if (applyTargets.some((target) => target.platform === 'codex')) {
      throwSharedNativeApplyConfirmationRequired();
    }
  }
  if (
    options.apply !== false
    && options.sharedNativeApplyConfirmed !== true
    && changedKeys.length > 0
    && schemaPlugin.manifest.scripts?.preApply
  ) {
    const error = new Error(
      'preApplyAuthorizationRequired: Applying this config runs plugin preApply. Re-run with --yes.',
    ) as Error & { code: string };
    error.code = 'preApplyAuthorizationRequired';
    throw error;
  }
  if (changedKeys.length > 0) {
    try {
      const write = await patchPluginConfigStore({
        ...configIdentity,
        pluginName,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        updates: Object.fromEntries(updatedKeys.map((key) => [key, updates[key]!])),
        removeKeys: requestedRemoveKeys,
        schema,
      });
      warnings.push(...write.warnings);
    } catch (error) {
      throw markConfigWriteFailed(error);
    }
  }

  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  try {
    effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
      ...configIdentity,
      pluginName,
      manifest: schemaPlugin.manifest,
      targetScope: options.scope,
      cwd: options.cwd,
      env: options.env,
    }));
  } catch {
    const apply = unavailableApply('effectiveConfigUnavailable', 'effectiveConfig');
    const otherProjectsMayRequireSync = options.scope === 'user' && changedKeys.length > 0;
    if (otherProjectsMayRequireSync) warnings.push(...otherProjectsWarning(options.scope));
    return {
      plugin: pluginName,
      scope: options.scope,
      ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
      updatedKeys,
      removedKeys,
      staleRemovedKeys,
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: publicConfigApplyResult(apply),
      otherProjectsMayRequireSync,
      warnings,
    };
  }
  let apply: ConfigApplyResult;
  try {
    apply = changedKeys.length === 0
      ? skippedApply('noConfigChange')
      : staleRemovedKeys.length === changedKeys.length
        ? skippedApply('noEffectiveConfigChange')
        : options.apply === false
          ? skippedApply('notRequested')
          : await applyConfigToVisibleTargets({
              plugin: schemaPlugin,
              scope: options.scope,
              cwd: options.cwd,
              env: options.env ?? process.env,
              applyTargets,
              nativeCliRunner: options.nativeCliRunner,
              reinstallCommandImpl: options.reinstallCommandImpl,
              rebuildRuntime: options.rebuildRuntime,
              noVisibleTargetHasInvalidConfig: effective.issues.length > 0,
            });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(failure, { configWrite: 'succeeded' as const });
  }
  const otherProjectsMayRequireSync = options.scope === 'user' && changedKeys.length > 0;
  if (otherProjectsMayRequireSync) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    updatedKeys,
    removedKeys,
    staleRemovedKeys,
    effective,
    configWrite: 'succeeded',
    overallState: overallStateForApply(apply),
    apply: publicConfigApplyResult(apply),
    otherProjectsMayRequireSync,
    warnings,
  };
}

export async function applyPluginConfigWrite(
  options: ApplyPluginConfigWriteOptions,
): Promise<PluginConfigWriteReceipt> {
  const requestedPluginName = options.pluginName ?? options.plugin?.manifest.name;
  if (!requestedPluginName) throw new Error('Plugin name is required for config write.');
  assertSafePluginConfigSegment(requestedPluginName);
  if (options.scope === 'project') {
    const targetPath = resolvePluginConfigStorePath({
      sourceId: options.plugin?.sourceId,
      pluginName: requestedPluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    await assertProjectSharedConfigPathVisible({
      cwd: options.cwd,
      targetPath,
      env: options.env,
    });
  }
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      await options.reviewPreflight?.();
      try {
        return await applyPluginConfigWriteUnlocked({
          ...options,
          awHomeMutationToken,
          rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken },
        });
      } catch (error) {
        let sensitiveValues = options.plugin
          ? collectSensitivePluginConfigValues(
              options.plugin.manifest,
              (options.request.updates ?? {}) as Record<string, PluginConfigValue>,
            )
          : [];
        if (options.plugin) {
          try {
            const effective = await resolveEffectivePluginConfig({
              ...(options.plugin.sourceId ? {
                sourceId: options.plugin.sourceId,
                sourceIdentity: options.plugin.sourceIdentity,
                logicalIdentity: options.plugin.catalogLogicalIdentity,
              } : {}),
              pluginName: options.plugin.manifest.name,
              manifest: options.plugin.manifest,
              targetScope: options.scope,
              cwd: options.cwd,
              env: options.env,
            });
            sensitiveValues = [
              ...sensitiveValues,
              ...collectSensitivePluginConfigValues(options.plugin.manifest, effective.values),
            ];
          } catch {
            // Requested sensitive values and generic credential redaction remain available.
          }
        }
        let message = redactPluginScriptOutput(
          error instanceof Error ? error.message : String(error),
          sensitiveValues,
        );
        message = message.split(options.cwd).join('<project>');
        for (const scope of ['user', 'project'] as const) {
          const configPath = resolvePluginConfigStorePath({
            sourceId: options.plugin?.sourceId,
            pluginName: requestedPluginName,
            scope,
            cwd: options.cwd,
            env: options.env,
          });
          message = message.split(configPath).join(`${scope}/plugin-config/${[
            options.plugin?.sourceId,
            requestedPluginName,
            'config.json',
          ].filter(Boolean).join('/')}`);
        }
        const safeError = new Error(message) as Error & {
          code?: string;
          configWrite?: 'failed' | 'succeeded';
          operationDiagnostic?: unknown;
        };
        const code = (error as { code?: unknown }).code;
        safeError.code = typeof code === 'string' ? code : 'configApplyFailed';
        const configWrite = (error as { configWrite?: unknown }).configWrite;
        if (configWrite === 'succeeded' || configWriteStateForError(error) === 'failed') {
          safeError.configWrite = configWrite === 'succeeded' ? 'succeeded' : 'failed';
        }
        if (error && typeof error === 'object' && 'operationDiagnostic' in error) {
          safeError.operationDiagnostic = (error as { operationDiagnostic?: unknown }).operationDiagnostic;
        }
        throw safeError;
      }
    },
  });
}

type ResetPluginConfigWriteOptions = {
  pluginName: string;
  sourceId?: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
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
  sharedNativeApplyConfirmed?: boolean;
};

async function resetPluginConfigWithHelperUnlocked(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  let configIdentity: {
    sourceId?: string;
    sourceIdentity?: string;
    logicalIdentity?: string;
  } = options.plugin?.sourceId ? {
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
  } : options.sourceId ? {
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    logicalIdentity: options.logicalIdentity,
  } : {};
  if (options.sourceId && !options.sourceIdentity) {
    try {
      const identity = await readNamespacedPluginConfigStoreIdentity({
        sourceId: options.sourceId,
        pluginName,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      });
      if (identity?.binding.kind === 'source') configIdentity = {
        sourceId: options.sourceId,
        sourceIdentity: identity.binding.sourceIdentity,
      };
      if (identity?.binding.kind === 'catalog') configIdentity = {
        sourceId: options.sourceId,
        logicalIdentity: identity.binding.logicalIdentity,
      };
    } catch {
      // Reset does not require a readable or valid envelope.
    }
  }
  let removedKeys: string[] = [];
  let removedKeysKnown = false;
  try {
    const store = await readPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
    });
    removedKeys = collectRemovedConfigKeys(store.values);
    removedKeysKnown = store.state !== 'invalid';
  } catch {
    // Reset is the final recovery boundary and does not require a readable store.
  }
  const warnings: string[] = [];

  const sharedNativeAffected = options.plugin
    && (removedKeysKnown
      ? changedKeysAffectSharedNativeTarget({
          plugin: options.plugin,
          changedKeys: removedKeys,
        })
      : pluginHasSharedNativeRefreshKeys(options.plugin));
  if (
    options.plugin
    && options.apply !== false
    && options.scope === 'user'
    && options.sharedNativeApplyConfirmed !== true
    && sharedNativeAffected
  ) {
    const discovered = await resolveConfigApplyTargets({
      plugin: options.plugin,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env ?? process.env,
      applyTargets: options.applyTargets,
      nativeCliRunner: options.nativeCliRunner,
      rebuildRuntime: options.rebuildRuntime,
    });
    if (discovered.targets.some((target) => target.platform === 'codex')) {
      throwSharedNativeApplyConfirmationRequired();
    }
  }

  let reset: Awaited<ReturnType<typeof resetPluginConfigStore>>;
  try {
    reset = await resetPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
    });
  } catch (error) {
    throw markConfigWriteFailed(error);
  }

  let schemaAccess: Awaited<ReturnType<typeof resolvePluginConfigSchemaAccess>> | undefined;
  let apply = reset.deleted ? skippedApply('notRequested') : skippedApply('noConfigChange');
  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  if (options.plugin) {
    try {
      schemaAccess = await resolvePluginConfigSchemaAccess({
        pluginName,
        currentPlugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      });
    } catch {
      if (reset.deleted && options.apply !== false) {
        apply = unavailableApply('sourceUnavailable', 'source');
      }
    }
    const schemaPlugin = schemaAccess?.plugin;
    if (schemaPlugin?.manifest.config?.fields) {
      try {
        effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
          ...configIdentity,
          pluginName,
          manifest: schemaPlugin.manifest,
          targetScope: options.scope,
          cwd: options.cwd,
          env: options.env,
        }));
      } catch {
        if (reset.deleted && options.apply !== false) {
          apply = unavailableApply('effectiveConfigUnavailable', 'effectiveConfig');
        }
      }
      if (reset.deleted && options.apply !== false && apply.state === 'skipped') {
        apply = await applyConfigToVisibleTargets({
          plugin: schemaPlugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env ?? process.env,
          applyTargets: options.applyTargets,
          nativeCliRunner: options.nativeCliRunner,
          reinstallCommandImpl: options.reinstallCommandImpl,
          rebuildRuntime: options.rebuildRuntime,
          noVisibleTargetHasInvalidConfig: (effective?.issues.length ?? 0) > 0,
        });
      }
    } else if (reset.deleted && options.apply !== false && apply.state === 'skipped') {
      apply = unavailableApply('schemaUnavailable', 'schema');
    }
  } else if (reset.deleted && options.apply !== false) {
    apply = options.pluginError
      ? unavailableApply('sourceUnavailable', 'source')
      : unavailableApply('schemaUnavailable', 'schema');
  }
  const otherProjectsMayRequireSync = options.scope === 'user' && reset.deleted;
  if (otherProjectsMayRequireSync) warnings.push(...otherProjectsWarning(options.scope));

  return {
    plugin: pluginName,
    scope: options.scope,
    ...(schemaAccess?.schema ? { schema: schemaAccess.schema } : {}),
    existed: reset.existed,
    deleted: reset.deleted,
    resetDisposition: reset.resetDisposition,
    ...(reset.quarantineBasename ? { quarantineBasename: reset.quarantineBasename } : {}),
    removedKeys,
    ...(effective ? { effective } : {}),
    configWrite: 'succeeded',
    overallState: overallStateForApply(apply),
    apply: publicConfigApplyResult(apply),
    otherProjectsMayRequireSync,
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
  logicalIdentity?: string;
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
        logicalIdentity: options.plugin.catalogLogicalIdentity,
      } : options.sourceId ? {
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        logicalIdentity: options.logicalIdentity,
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
