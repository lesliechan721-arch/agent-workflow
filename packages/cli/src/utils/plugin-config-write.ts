import { statusTargetHasLiveConfigConsumer } from '../commands/status-v6.js';
import { readDemand, demandNativeProjection } from '../recovery/demand.js';
import { createScopeContext } from '../intent/scope-context.js';
import type {
  PreApplyAuthorizationTarget,
  RebuildCommandRuntime,
} from '../commands/rebuild-command.js';
import {
  flattenStatusTargets,
  statusCommandV8,
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
import { analyzePluginConfigMutationImpact } from './plugin-config-impact.js';
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
  const status = await statusCommandV8({
    plugins: [selector],
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
    ...(options.scope === 'project' ? { scope: 'project' } : {}),
    ...(options.rebuildRuntime?.catalogOperationContext
      ? { catalogOperationContext: options.rebuildRuntime.catalogOperationContext }
      : {}),
  });
  for (const statusTarget of flattenStatusTargets(status.payload.targets)) {
    if (statusTarget.pluginId !== selector && statusTarget.pluginName !== options.pluginName) continue;
    // A declaration alone is not a consumer. Config apply cannot install it.
    if (!statusTargetHasLiveConfigConsumer(statusTarget)) continue;
    if (options.scope === 'project' && statusTarget.scope !== 'project') continue;
    targets.push(await createCandidateTarget({
      pluginName: options.pluginName,
      platform: statusTarget.platform,
      scope: statusTarget.scope,
      cwd: options.cwd,
    }));
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
  preApplyConfirmed?: boolean;
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
  const contexts = new Map<Scope, Awaited<ReturnType<typeof createScopeContext>>>();
  const demands = new Map<Scope, Awaited<ReturnType<typeof readDemand>>>();
  const failedScopes = new Set<Scope>();
  try {
  const targetResults: InternalConfigApplyTargetResult[] = [...discovered.failures];
  let runtimeFailed = discovered.failures.length > 0;
  let invalidTargets = 0;
  let unavailableTargets = 0;
  const errors: ConfigApplyError[] = [];
  for (const scope of new Set(discovered.targets.map((target) => target.scope))) {
    try {
      const context = await createScopeContext({ scope, cwd: options.cwd, env: options.env });
      contexts.set(scope, context);
      const demand = await readDemand({ scope, cwd: context.executionCwd, env: context.env });
      demandNativeProjection(demand);
      demands.set(scope, demand);
    } catch {
      failedScopes.add(scope);
      runtimeFailed = true;
      for (const target of discovered.targets.filter((entry) => entry.scope === scope)) {
        targetResults.push({ target, action: 'reinstall', state: 'failed', errorCode: 'configApplyContextUnavailable',
          message: 'The target scope or its demand cannot be read safely.' });
      }
      errors.push({ stage: 'targetValidation', code: 'configApplyContextUnavailable',
        message: 'A visible target scope or its demand cannot be read safely.' });
    }
  }
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

  const preApplyExecutionCache = new Map<string, Promise<void>>();
  for (const target of discovered.targets) {
    if (failedScopes.has(target.scope)) continue;
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
          cwd: contexts.get(target.scope)!.executionCwd,
          platform: target.platform,
          scope: target.scope,
          ...(options.rebuildRuntime?.scriptTimeoutMs === undefined
            ? {}
            : { scriptTimeoutMs: options.rebuildRuntime.scriptTimeoutMs }),
        },
        {
          ...options.rebuildRuntime,
          env: contexts.get(target.scope)!.env,
          nativeCliRunner,
          executionInput: {
            context: contexts.get(target.scope)!,
            requirements: demandNativeProjection(demands.get(target.scope)!),
            selectedTargets: [{ pluginId: selector, platform: target.platform, scope: target.scope }],
            preserveOtherObservedTargets: true,
          },
          preApplyConfirmed: options.preApplyConfirmed === true,
          preApplyExecutionCache,
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
  } finally {
    await Promise.all([...contexts.values()].map((context) => context.dispose()));
  }
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
  preApplyConfirmed?: boolean;
  discovered?: Awaited<ReturnType<typeof resolveConfigApplyTargets>>;
}): Promise<InternalConfigApplyResult> {
  let discovered: Awaited<ReturnType<typeof resolveConfigApplyTargets>>;
  if (options.discovered) {
    discovered = options.discovered;
  } else {
    try {
      discovered = await resolveConfigApplyTargets(options);
    } catch {
      return unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
    }
  }
  if (discovered.targets.length === 0
    && discovered.failures.length === 0
    && options.noVisibleTargetHasInvalidConfig) {
    return unavailableApply('invalidConfig', 'targetValidation');
  }
  return reinstallVisibleTargets({ ...options, discovered });
}

export async function resolveConfigPreApplyAuthorization(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  rebuildRuntime?: RebuildCommandRuntime;
  reinstallCommandImpl?: ReinstallCommand;
}): Promise<{
  targets: PreApplyAuthorizationTarget[];
  availableApplyTargets: ReceiptTargetIdentity[];
  unavailableTargetResults: ReceiptTargetResult[];
}> {
  const applyTargets = dedupeTargets(options.applyTargets);
  if (applyTargets.length === 0 || !pluginMayRunPreApply(options.plugin)) {
    return { targets: [], availableApplyTargets: applyTargets, unavailableTargetResults: [] };
  }
  if (options.plugin.sourceId && !options.plugin.pluginId) {
    return {
      targets: [],
      availableApplyTargets: [],
      unavailableTargetResults: applyTargets.map((target) => ({
        target,
        action: 'reinstall',
        state: 'failed',
        errorCode: 'sourceUnavailable',
        message: 'The preApply authorization scope cannot be resolved for this target.',
      })),
    };
  }
  const selector = options.plugin.sourceId
    ? options.plugin.pluginId!
    : options.plugin.manifest.name;
  const groups = new Map<Scope, ReceiptTargetIdentity[]>();
  for (const target of applyTargets) {
    const targets = groups.get(target.scope) ?? [];
    targets.push(target);
    groups.set(target.scope, targets);
  }
  const authorization: PreApplyAuthorizationTarget[] = [];
  const availableApplyTargets: ReceiptTargetIdentity[] = [];
  const unavailableTargetResults: ReceiptTargetResult[] = [];
  const resolveGroup = async (targets: ReceiptTargetIdentity[]): Promise<boolean> => {
    const platforms = new Set(targets.map((target) => target.platform));
    const platform = platforms.size === 2 ? 'both' as const : [...platforms][0]!;
    let context: Awaited<ReturnType<typeof createScopeContext>> | undefined;
    try {
      context = await createScopeContext({ scope: targets[0]!.scope, cwd: options.cwd, env: options.env });
      const demand = await readDemand({ scope: targets[0]!.scope,
        cwd: context.executionCwd, env: context.env });
      const preview = await (options.reinstallCommandImpl ?? syncWriteCommand)([selector], {
        cwd: context.executionCwd,
        platform,
        scope: targets[0]!.scope,
      }, {
        ...options.rebuildRuntime,
        env: context.env,
        nativeCliRunner: options.nativeCliRunner,
        resolvePreApplyAuthorization: true,
        executionInput: {
          context, requirements: demandNativeProjection(demand),
          selectedTargets: targets.map((target) => ({ pluginId: selector,
            platform: target.platform, scope: target.scope })),
          preserveOtherObservedTargets: true,
        },
      });
      if (preview.overallState !== 'succeeded' || !preview.preApplyAuthorization) return false;
      authorization.push(...preview.preApplyAuthorization);
      availableApplyTargets.push(...targets);
      return true;
    } catch {
      return false;
    } finally { await context?.dispose(); }
  };
  for (const targets of groups.values()) {
    if (await resolveGroup(targets)) continue;
    for (const target of targets) {
      if (targets.length > 1 && await resolveGroup([target])) continue;
      unavailableTargetResults.push({
        target,
        action: 'reinstall',
        state: 'failed',
        errorCode: 'sourceUnavailable',
        message: 'The preApply authorization scope cannot be resolved for this target.',
      });
    }
  }
  return {
    targets: [...new Map(authorization.map((target) => [[
      target.pluginId,
      target.platform,
      target.scope,
    ].join('\0'), target] as const)).values()],
    availableApplyTargets: dedupeTargets(availableApplyTargets),
    unavailableTargetResults,
  };
}

function pluginMayRunPreApply(plugin: PluginMeta): boolean {
  return plugin.manifest.scripts?.preApply !== undefined
    || (plugin.manifest.dependencies?.length ?? 0) > 0;
}

function throwPreApplyAuthorizationRequired(
  targets: readonly PreApplyAuthorizationTarget[],
): never {
  const plugins = [...new Set(targets.map((target) => target.pluginId))].join(', ');
  const error = new Error(
    `preApplyAuthorizationRequired: Applying this config runs plugin preApply for ${plugins}. Re-run with --yes.`,
  ) as Error & { code: string };
  error.code = 'preApplyAuthorizationRequired';
  throw error;
}

function preApplyAuthorizationIsConfirmed(options: {
  required: readonly PreApplyAuthorizationTarget[];
  confirmed?: boolean;
  authorizedTargets?: readonly PreApplyAuthorizationTarget[];
}): boolean {
  if (options.confirmed !== true) return false;
  if (options.authorizedTargets === undefined) return true;
  const authorized = new Set(options.authorizedTargets.map((target) => [
    target.pluginId,
    target.sourceIdentity,
    target.platform,
    target.scope,
  ].join('\0')));
  return options.required.every((target) => authorized.has([
    target.pluginId,
    target.sourceIdentity,
    target.platform,
    target.scope,
  ].join('\0')));
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
  preApplyConfirmed?: boolean;
  preApplyAuthorizedTargets?: readonly PreApplyAuthorizationTarget[];
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
        const apply = unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
        return {
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: publicConfigApplyResult(apply),
          otherProjectsMayRequireSync: false,
        };
      }
      const preApplyAuthorization = await resolveConfigPreApplyAuthorization({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env,
        applyTargets: discovered.targets,
        nativeCliRunner: options.nativeCliRunner,
        rebuildRuntime,
        reinstallCommandImpl: options.reinstallCommandImpl,
      });
      if (preApplyAuthorization.targets.length > 0 && !preApplyAuthorizationIsConfirmed({
        required: preApplyAuthorization.targets,
        confirmed: options.preApplyConfirmed,
        authorizedTargets: options.preApplyAuthorizedTargets,
      })) {
        const apply: InternalConfigApplyResult = {
          state: 'partial',
          targetResults: preApplyAuthorization.targets.map((target) => ({
            target: {
              pluginName: target.pluginName,
              pluginId: target.pluginId,
              platform: target.platform,
              scope: target.scope,
            },
            action: 'reinstall',
            state: 'failed',
            errorCode: 'preApplyAuthorizationRequired',
            message: 'Running plugin preApply requires explicit authorization.',
          })),
        };
        return {
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: publicConfigApplyResult(apply),
          otherProjectsMayRequireSync: false,
        };
      }
      discovered = {
        targets: preApplyAuthorization.availableApplyTargets,
        failures: [...discovered.failures, ...preApplyAuthorization.unavailableTargetResults],
      };
      if (discovered.targets.length === 0
        && preApplyAuthorization.unavailableTargetResults.length > 0) {
        const apply = unavailableApply(
          'sourceUnavailable',
          'source',
          preApplyAuthorization.unavailableTargetResults,
        );
        return {
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: publicConfigApplyResult(apply),
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
        preApplyConfirmed: options.preApplyConfirmed,
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
  preApplyConfirmed?: boolean;
  preApplyAuthorizedTargets?: readonly PreApplyAuthorizationTarget[];
  reviewPreflight?: () => Promise<void> | void;
};

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

  let discovered: Awaited<ReturnType<typeof resolveConfigApplyTargets>> | undefined;
  let targetDiscoveryFailed = false;
  if (options.apply !== false) {
    try {
      discovered = await resolveConfigApplyTargets({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        applyTargets: options.applyTargets,
        nativeCliRunner: options.nativeCliRunner,
        rebuildRuntime: options.rebuildRuntime,
      });
    } catch {
      targetDiscoveryFailed = true;
    }
  }
  const impact = await analyzePluginConfigMutationImpact({
    plugin: schemaPlugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    visibleTargets: discovered?.targets ?? [],
    mutation: {
      kind: 'patch',
      updates: requestedUpdates,
      removeKeys: requestedRemoveKeys,
    },
  });
  const updates = await coercePluginConfigUpdates({ schema, updates: requestedUpdates, cwd: options.cwd });
  const warnings: string[] = [];
  const { updatedKeys, removedKeys, staleRemovedKeys } = impact;
  let preApplyUnavailableReason: 'sourceUnavailable' | 'targetDiscoveryFailed' | undefined;
  let preApplyUnavailableTargetResults: ReceiptTargetResult[] = [];
  let applyDiscovery = discovered
    ? { targets: impact.affectedTargets, failures: discovered.failures }
    : undefined;
  const shouldApply = options.apply !== false && impact.storeChanged && !impact.noEffectiveChange;
  if (shouldApply && pluginMayRunPreApply(schemaPlugin)) {
    if (applyDiscovery) {
      const preApplyAuthorization = await resolveConfigPreApplyAuthorization({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        applyTargets: applyDiscovery.targets,
        nativeCliRunner: options.nativeCliRunner,
        rebuildRuntime: options.rebuildRuntime,
        reinstallCommandImpl: options.reinstallCommandImpl,
      });
      if (preApplyAuthorization.targets.length > 0 && !preApplyAuthorizationIsConfirmed({
        required: preApplyAuthorization.targets,
        confirmed: options.preApplyConfirmed,
        authorizedTargets: options.preApplyAuthorizedTargets,
      })) {
        throwPreApplyAuthorizationRequired(preApplyAuthorization.targets);
      }
      preApplyUnavailableTargetResults = preApplyAuthorization.unavailableTargetResults;
      applyDiscovery = {
        targets: preApplyAuthorization.availableApplyTargets,
        failures: [...applyDiscovery.failures, ...preApplyUnavailableTargetResults],
      };
      if (applyDiscovery.targets.length === 0 && preApplyUnavailableTargetResults.length > 0) {
        preApplyUnavailableReason = 'sourceUnavailable';
      }
    }
  }
  if (
    options.apply !== false
    && options.scope === 'user'
    && options.sharedNativeApplyConfirmed !== true
    && impact.sharedNativeRenderTargets.length > 0
    && impact.affectedTargets.some((target) => target.platform === 'codex')
  ) {
    throwSharedNativeApplyConfirmationRequired();
  }
  if (impact.storeChanged) {
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
    const otherProjectsMayRequireSync = options.scope === 'user' && impact.storeChanged;
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
    apply = !impact.storeChanged
      ? skippedApply('noConfigChange')
      : options.apply === false
        ? skippedApply('notRequested')
        : targetDiscoveryFailed
          ? unavailableApply('targetDiscoveryFailed', 'targetDiscovery')
        : impact.noEffectiveChange
            && ((discovered?.targets.length ?? 0) > 0
              || staleRemovedKeys.length === impact.changedKeys.length)
            ? skippedApply('noEffectiveConfigChange')
          : preApplyUnavailableReason
            ? unavailableApply(
                preApplyUnavailableReason,
                preApplyUnavailableReason === 'sourceUnavailable' ? 'source' : 'targetDiscovery',
                preApplyUnavailableTargetResults,
              )
          : await applyConfigToVisibleTargets({
              plugin: schemaPlugin,
              scope: options.scope,
              cwd: options.cwd,
              env: options.env ?? process.env,
              applyTargets: applyDiscovery?.targets ?? impact.affectedTargets,
              nativeCliRunner: options.nativeCliRunner,
              reinstallCommandImpl: options.reinstallCommandImpl,
              rebuildRuntime: options.rebuildRuntime,
              noVisibleTargetHasInvalidConfig: (discovered?.targets.length ?? 0) > 0
                && effective.issues.length > 0,
              preApplyConfirmed: options.preApplyConfirmed,
              discovered: applyDiscovery,
            });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    throw Object.assign(failure, { configWrite: 'succeeded' as const });
  }
  const otherProjectsMayRequireSync = options.scope === 'user' && impact.storeChanged;
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
        safeError.code = typeof code === 'string' ? code
          : message.startsWith('schemaVersionUnsupported:') ? 'schemaVersionUnsupported'
            : 'configApplyFailed';
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
  preApplyConfirmed?: boolean;
  preApplyAuthorizedTargets?: readonly PreApplyAuthorizationTarget[];
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
  try {
    const store = await readPluginConfigStore({
      ...configIdentity,
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
    });
    removedKeys = collectRemovedConfigKeys(store.values);
  } catch {
    // Reset is the final recovery boundary and does not require a readable store.
  }
  const warnings: string[] = [];
  let impact: Awaited<ReturnType<typeof analyzePluginConfigMutationImpact>> | undefined;
  let targetDiscoveryFailed = false;
  let visibleTargets: ReceiptTargetIdentity[] = [];
  if (options.plugin) {
    if (options.apply !== false) {
      try {
        visibleTargets = (await resolveConfigApplyTargets({
          plugin: options.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env ?? process.env,
          applyTargets: options.applyTargets,
          nativeCliRunner: options.nativeCliRunner,
          rebuildRuntime: options.rebuildRuntime,
        })).targets;
      } catch {
        targetDiscoveryFailed = true;
      }
    }
    try {
      impact = await analyzePluginConfigMutationImpact({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        visibleTargets,
        mutation: { kind: 'reset' },
      });
      removedKeys = impact.removedKeys;
    } catch {
      // Reset remains available when its before state cannot be read.
    }
  }
  let preApplyUnavailableReason: 'sourceUnavailable' | undefined;
  let preApplyUnavailableTargetResults: ReceiptTargetResult[] = [];
  let applyDiscovery = options.plugin && !targetDiscoveryFailed
    ? { targets: impact?.affectedTargets ?? visibleTargets, failures: [] as ReceiptTargetResult[] }
    : undefined;
  if (
    options.plugin
    && options.apply !== false
    && impact?.storeChanged
    && !impact.noEffectiveChange
    && applyDiscovery
    && pluginMayRunPreApply(options.plugin)
  ) {
    const preApplyAuthorization = await resolveConfigPreApplyAuthorization({
      plugin: options.plugin,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      applyTargets: applyDiscovery.targets,
      nativeCliRunner: options.nativeCliRunner,
      rebuildRuntime: options.rebuildRuntime,
      reinstallCommandImpl: options.reinstallCommandImpl,
    });
    if (preApplyAuthorization.targets.length > 0 && !preApplyAuthorizationIsConfirmed({
      required: preApplyAuthorization.targets,
      confirmed: options.preApplyConfirmed,
      authorizedTargets: options.preApplyAuthorizedTargets,
    })) {
      throwPreApplyAuthorizationRequired(preApplyAuthorization.targets);
    }
    preApplyUnavailableTargetResults = preApplyAuthorization.unavailableTargetResults;
    applyDiscovery = {
      targets: preApplyAuthorization.availableApplyTargets,
      failures: preApplyUnavailableTargetResults,
    };
    if (applyDiscovery.targets.length === 0 && preApplyUnavailableTargetResults.length > 0) {
      preApplyUnavailableReason = 'sourceUnavailable';
    }
  }
  if (
    options.plugin
    && options.apply !== false
    && options.scope === 'user'
    && options.sharedNativeApplyConfirmed !== true
    && (impact
      ? impact.sharedNativeRenderTargets.length > 0
        && impact.affectedTargets.some((target) => target.platform === 'codex')
      : pluginHasSharedNativeRefreshKeys(options.plugin))
    && visibleTargets.some((target) => target.platform === 'codex')
  ) {
    throwSharedNativeApplyConfirmationRequired();
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
      if (reset.deleted
        && options.apply !== false
        && apply.state === 'skipped'
        && impact?.noEffectiveChange
        && visibleTargets.length > 0) {
        apply = skippedApply('noEffectiveConfigChange');
      } else if (reset.deleted
        && options.apply !== false
        && apply.state === 'skipped'
        && targetDiscoveryFailed) {
        apply = unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
      } else if (reset.deleted && options.apply !== false && apply.state === 'skipped') {
        apply = preApplyUnavailableReason
          ? unavailableApply(
              preApplyUnavailableReason,
              'source',
              preApplyUnavailableTargetResults,
            )
          : await applyConfigToVisibleTargets({
              plugin: schemaPlugin,
              scope: options.scope,
              cwd: options.cwd,
              env: options.env ?? process.env,
              applyTargets: applyDiscovery?.targets ?? impact?.affectedTargets ?? options.applyTargets,
              nativeCliRunner: options.nativeCliRunner,
              reinstallCommandImpl: options.reinstallCommandImpl,
              rebuildRuntime: options.rebuildRuntime,
              noVisibleTargetHasInvalidConfig: (effective?.issues.length ?? 0) > 0,
              preApplyConfirmed: options.preApplyConfirmed,
              discovered: applyDiscovery,
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
