import { resolveWorkContext } from '../intent/work-context.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';
import { statusTargetHasLiveConfigConsumer } from '../commands/status-v6.js';
import { readDemand, demandNativeProjection } from '../recovery/demand.js';
import { createScopeContext } from '../intent/scope-context.js';
import type {
  PreApplyAuthorizationTarget,
  RebuildCommandRuntime,
} from '../commands/rebuild-command.js';
import { selectPluginConfigProfile, type PlatformTarget, getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import {
  flattenStatusTargets,
  statusCommandV8,
} from '../commands/status-v6.js';
import { syncWriteCommand } from '../commands/write-commands.js';
import {
  CONFIG_MUTATION_RECEIPT_SCHEMA_VERSION,
  type CommandProducerResult,
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
import { getDefaultNativeCliRunner, prepareNativeCliExecution, type NativeCliRunner } from './native-cli.js';
import {
  assertPluginConfigMutationCandidate,
  assertSafePluginConfigSegment,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  PluginConfigSchemaResolutionError,
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
import { analyzePluginConfigMutationImpact, discoverPluginConfigManagedCommandPackages, pluginConfigTargetRenderScopes, pluginSharedNativeConfigTargets } from './plugin-config-impact.js';
import { collectPluginConfigReferenceEvidence, resolvePluginConfigReferencePlugins, resolvePluginConfigReferenceConsumers } from './plugin-config-references.js';
import { orderPluginMetasByDependencies, resolvePluginMetaDependencyClosure } from './plugin-dependencies.js';
import {
  assertManagedCommandPackageNativeToolsUnchanged,
  discoverInstalledPluginManagedCommandPackages,
  syncPluginManagedCommandPackage,
  type ManagedCommandPackageDiscovery,
} from './managed-command-materialization.js';
import { listManagedCommandPackages, managedCommandDiagnostic, readInstalledCommandProducer } from './managed-command-store.js';
import {
  collectSensitivePluginConfigValues,
  redactPluginScriptOutput,
} from './plugin-scripts.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey, resolveCliPackageRoot } from './paths.js';
import { readSafeOperationError } from './safe-operation-diagnostic.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import fs from 'fs-extra';
import path from 'node:path';
import crypto from 'node:crypto';

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
  platform?: PlatformTarget;
  context?: Scope;
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
  platform?: PlatformTarget;
  context?: Scope;
  plugin: string;
  scope: Scope;
  schema?: ConfigSchemaEvidence;
  existed: boolean;
  deleted: boolean;
  resetDisposition: 'absent' | 'clearedLayer' | 'deletedFile' | 'unlinkedSymlink' | 'quarantinedDirectory';
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

interface ConfigApplyDiscovery {
  targets: ReceiptTargetIdentity[];
  failures: ReceiptTargetResult[];
  commandPackages?: ManagedCommandPackageDiscovery['packages'];
  commandDiscoveryErrors?: ManagedCommandPackageDiscovery['errors'];
  plugins?: readonly PluginMeta[];
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
  result: InternalConfigApplyTargetResult | ConfigApplyTargetResult,
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

function publicConfigApplyResult(apply: InternalConfigApplyResult | ConfigApplyResult): ConfigApplyResult {
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
): Extract<ConfigApplyResult, { state: 'skipped' }> {
  return { state: 'skipped', reason, targetResults: [] };
}

function unavailableApply(
  reason: Extract<ConfigApplyResult, { state: 'unavailable' }>['reason'],
  stage: ConfigApplyError['stage'],
  targetResults: InternalConfigApplyTargetResult[] = [],
  commandPackages: ManagedCommandPackageDiscovery['packages'] = [],
): Extract<InternalConfigApplyResult, { state: 'unavailable' }> {
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
    ...(commandPackages.length > 0 ? { commandResults: commandPackages.map((target) => ({
      producer: target.producer, state: 'failed' as const, commandIds: [], removedCommandIds: [],
      errors: [{ code: reason, message: messages[reason] }],
      recoveryActions: [`aw command package sync ${target.producer.sourceId}/${target.producer.pluginName} ${target.packageKey} --scope ${target.producer.scope} --yes`,
        `aw command package remove ${target.packageId} --yes`],
    })) } : {}),
    error: { stage, code: reason, message: messages[reason] },
  };
}

function overallStateForApply(apply: Pick<ConfigApplyResult, 'state'>): RebuildReceiptOverallState {
  return apply.state === 'succeeded' || apply.state === 'skipped' ? 'succeeded' : 'partial';
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function collectRemovedConfigKeys(values: Record<string, unknown>): string[] {
  return uniqueInOrder(Object.keys(values));
}

function targetKey(target: ReceiptTargetIdentity): string {
  return `${target.pluginName}:${target.platform}:${target.scope}:${target.projectKey ?? '-'}`;
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
  platform?: PlatformTarget;
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
  const consumers = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env,
    plugins: options.rebuildRuntime?.referencePlugins });
  const selectors = consumers.map((plugin) => plugin.pluginId ?? plugin.manifest.name);
  const status = await statusCommandV8({
    plugins: selectors.length ? selectors : [selector],
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
    ...(options.scope === 'project' ? { scope: 'project' } : {}),
    ...(options.rebuildRuntime?.catalogOperationContext
      ? { catalogOperationContext: options.rebuildRuntime.catalogOperationContext }
      : {}),
  });
  for (const statusTarget of flattenStatusTargets(status.payload.targets)) {
    if (!selectors.includes(statusTarget.pluginId ?? '')
      && !consumers.some((plugin) => plugin.manifest.name === statusTarget.pluginName)
      && statusTarget.pluginId !== selector && statusTarget.pluginName !== options.pluginName) continue;
    // A declaration alone is not a consumer. Config apply cannot install it.
    if (!statusTargetHasLiveConfigConsumer(statusTarget)) continue;
    if (options.scope === 'user' && statusTarget.scope !== 'user') continue;
    targets.push(await createCandidateTarget({
      pluginName: statusTarget.pluginName,
      platform: statusTarget.platform,
      scope: statusTarget.scope,
      cwd: options.cwd,
    }));
  }

  return { targets: dedupeTargets(targets), failures };
}

async function reinstallVisibleTargets(options: {
  platform?: PlatformTarget;
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  applyCommandPackages?: readonly string[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  discovered?: ConfigApplyDiscovery;
  preApplyConfirmed?: boolean;
  changedConfigKeys?: string[];
}): Promise<InternalConfigApplyResult> {
  const nativeCliRunner = options.nativeCliRunner ?? getDefaultNativeCliRunner();
  const discovered = options.discovered ?? await resolveConfigApplyTargets(options);
  const managedCommandProducerCache = options.rebuildRuntime?.managedCommandProducerCache
    ?? new Map<string, Promise<CommandProducerResult>>();
  if (discovered.targets.some((target) => target.pluginName !== options.plugin.manifest.name)
    || discovered.commandPackages?.some((target) => target.producer.pluginName !== options.plugin.manifest.name)) {
    const plugins = discovered.plugins ?? await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      env: options.env, plugins: options.rebuildRuntime?.referencePlugins });
    const results: InternalConfigApplyTargetResult[] = [...discovered.failures];
    const commandResults: CommandProducerResult[] = [];
    const failed = new Set(discovered.failures.map(({ target }) => `${target.pluginName}\0${target.platform}\0${target.scope}`));
    const failedPackages = new Set<string>();
    const errors: ConfigApplyError[] = (discovered.commandDiscoveryErrors ?? []).map((error) => ({
      stage: 'targetDiscovery', code: error.code, message: error.message,
    }));
    let partial = discovered.failures.length > 0 || errors.length > 0;
    for (const plugin of orderPluginMetasByDependencies(plugins)) {
      const targets = discovered.targets.filter((target) => target.pluginName === plugin.manifest.name);
      const packages = (discovered.commandPackages ?? []).filter((target) => target.producer.pluginName === plugin.manifest.name);
      if (!targets.length && !packages.length) continue;
      const dependencies = resolvePluginMetaDependencyClosure(plugins, [plugin.manifest.name])
        .filter((entry) => entry.manifest.name !== plugin.manifest.name).map((entry) => entry.manifest.name);
      const dependencyPackageFailed = (scope: Scope) => dependencies.some((dependency) =>
        failedPackages.has(`${dependency}\0${scope}`) || (scope === 'project' && failedPackages.has(`${dependency}\0user`)));
      const blocked = targets.filter((target) => dependencies.some((dependency) =>
        failed.has(`${dependency}\0${target.platform}\0${target.scope}`)
        || (target.scope === 'project' && failed.has(`${dependency}\0${target.platform}\0user`)))
        || dependencyPackageFailed(target.scope));
      if (blocked.length) {
        partial = true;
        for (const target of blocked) failed.add(`${plugin.manifest.name}\0${target.platform}\0${target.scope}`);
        results.push(...blocked.map((target): InternalConfigApplyTargetResult => ({ target, action: 'skipped',
          state: 'skipped', errorCode: 'dependencyApplyFailed',
          message: `A required provider failed. Run aw plugin sync ${plugin.pluginId ?? plugin.manifest.name} --context ${target.scope} --target ${target.platform} --yes.` })));
      }
      const blockedPackages = packages.filter((target) => {
        const platforms = plugin.manifest.managedCommands?.packages.find((entry) => entry.key === target.packageKey
          && entry.scope === target.producer.scope)?.platforms ?? ['codex', 'claude'];
        return dependencyPackageFailed(target.producer.scope) || dependencies.some((dependency) =>
          platforms.some((platform) => failed.has(`${dependency}\0${platform}\0${target.producer.scope}`)
            || (target.producer.scope === 'project' && failed.has(`${dependency}\0${platform}\0user`))));
      });
      for (const target of blockedPackages) {
        partial = true;
        failedPackages.add(`${plugin.manifest.name}\0${target.producer.scope}`);
        commandResults.push({ producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
          errors: [{ code: 'dependencyApplyFailed', message: 'A required provider failed; the command package was not refreshed.' }],
          recoveryActions: [`aw command package sync ${plugin.pluginId ?? plugin.manifest.name} ${target.packageKey} --scope ${target.producer.scope} --yes`] });
      }
      const available = targets.filter((target) => !blocked.includes(target));
      const availablePackages = packages.filter((target) => !blockedPackages.includes(target));
      if (!available.length && !availablePackages.length) continue;
      const own = plugin.manifest.name === options.plugin.manifest.name;
      const result = await reinstallVisibleTargets({ ...options, plugin,
        changedConfigKeys: own ? options.changedConfigKeys : [],
        rebuildRuntime: { ...options.rebuildRuntime, referencePlugins: plugins, managedCommandProducerCache },
        discovered: { targets: available, failures: [], commandPackages: availablePackages,
          commandDiscoveryErrors: [] } });
      if (result.state !== 'succeeded' && result.state !== 'skipped') {
        partial = true;
        for (const target of available) {
          if (!('targetResults' in result) || !result.targetResults.some((entry) =>
            targetKey(entry.target) === targetKey(target) && entry.state === 'completed')) {
            failed.add(`${plugin.manifest.name}\0${target.platform}\0${target.scope}`);
          }
        }
      }
      if ('targetResults' in result) results.push(...result.targetResults);
      if ('commandResults' in result) {
        commandResults.push(...result.commandResults ?? []);
        for (const entry of result.commandResults ?? []) {
          if (entry.state !== 'completed') failedPackages.add(`${plugin.manifest.name}\0${entry.producer.scope}`);
        }
      }
      if ('errors' in result) errors.push(...result.errors ?? []);
    }
    return { state: partial ? 'partial' : 'succeeded', targetResults: results,
      ...(commandResults.length ? { commandResults } : {}), ...(errors.length ? { errors } : {}) };
  }
  const contexts = new Map<Scope, Awaited<ReturnType<typeof createScopeContext>>>();
  const demands = new Map<Scope, Awaited<ReturnType<typeof readDemand>>>();
  const failedScopes = new Set<Scope>();
  try {
    const targetResults: InternalConfigApplyTargetResult[] = [...discovered.failures];
    const commandResults = new Map<string, CommandProducerResult>();
    let runtimeFailed = discovered.failures.length > 0
      || (discovered.commandDiscoveryErrors?.length ?? 0) > 0;
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
    if ((discovered.commandDiscoveryErrors?.length ?? 0) > 0) {
      errors.push(...discovered.commandDiscoveryErrors!.map((error): ConfigApplyError => ({
        stage: 'targetDiscovery', code: error.code, message: error.message,
      })));
    }
    const reinstall = options.reinstallCommandImpl ?? syncWriteCommand;
    if (options.plugin.sourceId && !options.plugin.pluginId) {
      throw new Error(`Plugin "${options.plugin.manifest.name}" is missing its namespaced plugin ID.`);
    }
    const selector = options.plugin.sourceId
      ? options.plugin.pluginId!
      : options.plugin.manifest.name;

    const nativeFailures: CommandProducerResult[] = [];
    for (const target of discovered.commandPackages ?? []) {
      try {
        await assertManagedCommandPackageNativeToolsUnchanged({ plugin: options.plugin, producer: target.producer, env: options.env });
      } catch (error) {
        nativeFailures.push({ producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
          errors: [managedCommandDiagnostic(error)],
          recoveryActions: [`aw command package sync ${selector} ${target.packageKey} --scope ${target.producer.scope} --yes`] });
      }
    }
    if (nativeFailures.length > 0) {
      return { state: 'partial', commandResults: nativeFailures,
        targetResults: [...targetResults, ...discovered.targets.map((target): InternalConfigApplyTargetResult => ({
          target, action: 'reinstall', state: 'failed', errorCode: 'nativeToolSyncRequired',
          message: 'Run a reviewed producer sync or package sync before configuration apply.',
        }))] };
    }

    const sanitizeFailure = async (
      message: string,
      target: Pick<ReceiptTargetIdentity, 'scope' | 'projectKey'> & { platform?: PlatformName | null },
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
          referencePlugins: options.rebuildRuntime?.referencePlugins,
          targetScope: target.scope,
          platform: target.platform ?? undefined,
          cwd: options.cwd,
          env: options.env,
        });
        sensitiveValues = collectSensitivePluginConfigValues(options.plugin.manifest, effective.values, target.platform ?? undefined);
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
        const configs = await Promise.all(pluginConfigTargetRenderScopes(options.plugin, target).map((scope) => resolveEffectivePluginConfig({
          ...(options.plugin.sourceId ? {
            sourceId: options.plugin.sourceId,
            sourceIdentity: options.plugin.sourceIdentity,
            logicalIdentity: options.plugin.catalogLogicalIdentity,
          } : {}),
          pluginName: options.plugin.manifest.name,
          manifest: options.plugin.manifest,
          referencePlugins: options.rebuildRuntime?.referencePlugins,
          targetScope: scope,
          platform: target.platform ?? undefined,
          cwd: options.cwd,
          env: options.env,
        })));
        if (configs.some((effective) => effective.issues.length > 0)) {
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
            managedCommandProducerCache,
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
        for (const producer of result.commandResults ?? []) {
          commandResults.set(getCommandPackageId(producer.producer), producer);
          if (producer.state !== 'completed') runtimeFailed = true;
        }
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

    for (const target of discovered.commandPackages ?? []) {
      await options.rebuildRuntime?.reporter?.event({
        type: 'managed-command:producer',
        source: { plugin: options.plugin.manifest.name, scope: target.producer.scope },
        data: { packageKey: target.packageKey, phase: 'start' },
      });
      let result: CommandProducerResult;
      if (!target.declared) {
        result = {
          producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
          errors: [{ code: 'commandPackageDeclarationMissing',
            message: 'The installed command package is no longer declared by this plugin.' }],
          recoveryActions: [`aw command package remove ${target.packageId} --yes`],
        };
      } else {
        try {
          result = await syncPluginManagedCommandPackage({
            plugin: options.plugin, packageKey: target.packageKey, scope: target.producer.scope,
            cwd: options.cwd, env: options.env, managedCommandProducerCache,
            referencePlugins: options.rebuildRuntime?.referencePlugins,
            event: options.changedConfigKeys?.length ? 'refresh' : 'install',
            changedConfigKeys: options.changedConfigKeys ?? [],
            signal: options.rebuildRuntime?.signal,
            scriptTimeoutMs: options.rebuildRuntime?.scriptTimeoutMs,
          });
        } catch (error) {
          if (options.rebuildRuntime?.signal?.aborted
            || error instanceof Error && error.name === 'AbortError'
            || readSafeOperationError(error)) throw error;
          result = {
            producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
            errors: [{ code: 'commandPackageApplyFailed', message: 'The managed command package could not be refreshed.' }],
            recoveryActions: [`aw command package sync ${selector} ${target.packageKey} --scope ${target.producer.scope} --yes`,
              `aw command package remove ${target.packageId} --yes`],
          };
        }
      }
      result = { ...result, errors: await Promise.all(result.errors.map(async (error) => ({
        ...error, message: await sanitizeFailure(error.message, { scope: target.producer.scope,
          ...(target.producer.projectRoot ? { projectKey: target.producer.projectRoot } : {}) }),
      }))) };
      commandResults.set(getCommandPackageId(result.producer), result);
      await options.rebuildRuntime?.reporter?.event({
        type: 'managed-command:producer',
        source: { plugin: options.plugin.manifest.name, scope: target.producer.scope },
        data: { packageKey: target.packageKey, phase: result.state === 'completed' ? 'success' : 'failure' },
      });
      if (result.state !== 'completed') runtimeFailed = true;
    }
    const commands = commandResults.size > 0 ? { commandResults: [...commandResults.values()] } : {};
    const commandTargetCount = (discovered.commandPackages?.length ?? 0);

    if (discovered.targets.length === 0 && discovered.failures.length === 0
      && commandTargetCount === 0 && !runtimeFailed) {
      return skippedApply('noVisibleTarget');
    }
    if (discovered.targets.length > 0 && invalidTargets === discovered.targets.length && commandTargetCount === 0) {
      return { ...unavailableApply('invalidConfig', 'targetValidation', targetResults), ...commands };
    }
    if (discovered.targets.length > 0 && unavailableTargets === discovered.targets.length && commandTargetCount === 0) {
      return { ...unavailableApply('effectiveConfigUnavailable', 'targetValidation', targetResults), ...commands };
    }
    if (runtimeFailed
      || invalidTargets > 0
      || unavailableTargets > 0
      || targetResults.some((entry) => entry.state === 'failed' || entry.state === 'skipped')) {
      return {
        state: 'partial',
        targetResults,
        ...commands,
        ...(errors.length > 0 ? { errors } : {}),
      };
    }
    return { state: 'succeeded', targetResults, ...commands };
  } finally {
    await Promise.all([...contexts.values()].map((context) => context.dispose()));
  }
}

async function resolveConfigApplyTargets(options: {
  platform?: PlatformTarget;
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  rebuildRuntime?: RebuildCommandRuntime;
}): Promise<ConfigApplyDiscovery> {
  const platformTargets = options.applyTargets !== undefined
    ? { targets: dedupeTargets(options.applyTargets), failures: [] }
    : await discoverVisibleTargets({
        pluginName: options.plugin.manifest.name,
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        nativeCliRunner: options.nativeCliRunner ?? getDefaultNativeCliRunner(),
        rebuildRuntime: options.rebuildRuntime,
      });
  const commands = await discoverPluginConfigManagedCommandPackages({
    plugin: options.plugin, scope: options.scope, cwd: options.cwd, env: options.env,
    platformTargets: platformTargets.targets,
    referencePlugins: options.rebuildRuntime?.referencePlugins,
  });
  return { ...platformTargets, commandPackages: commands.packages, commandDiscoveryErrors: commands.errors };
}

async function configApplyHasValidSharedNativeTarget(options: {
  plugin: PluginMeta;
  targets: ReceiptTargetIdentity[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginMeta[];
}): Promise<boolean> {
  const plugins = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env, plugins: options.plugins });
  for (const plugin of plugins) {
    for (const target of options.targets.filter((target) => target.pluginName === plugin.manifest.name)) {
      const shared = pluginSharedNativeConfigTargets(plugin);
      if (!shared.some((entry) => (entry.platform ?? 'codex') === target.platform)) continue;
      const effective = await resolveEffectivePluginConfig({ sourceId: plugin.sourceId,
        sourceIdentity: plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
        manifest: plugin.manifest, platform: target.platform, targetScope: 'user',
        cwd: options.cwd, env: options.env, referencePlugins: options.plugins });
      if (!effective.issues.length) return true;
    }
  }
  return false;
}

export async function resolveConfigPreApplyAuthorization(options: {
  platform?: PlatformTarget;
  context?: Scope;
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
  if (applyTargets.some((target) => target.pluginName !== options.plugin.manifest.name)) {
    const plugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
      sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
      env: options.env, plugins: options.rebuildRuntime?.referencePlugins });
    const results = await Promise.all(plugins.map((plugin) => resolveConfigPreApplyAuthorization({ ...options, plugin,
      applyTargets: applyTargets.filter((target) => target.pluginName === plugin.manifest.name) })));
    return { targets: results.flatMap((result) => result.targets),
      availableApplyTargets: results.flatMap((result) => result.availableApplyTargets),
      unavailableTargetResults: results.flatMap((result) => result.unavailableTargetResults) };
  }
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
        previewOperationPlan: true,
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
    ? ['其它项目不会由本次命令扫描或更新，可能需要在对应项目目录中运行 aw plugin sync --context project。']
    : [];
}

function buildReceiptFieldEntry(options: {
  platform?: PlatformTarget;
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
  if (!options.awHomeMutationToken) {
    await prepareNativeCliExecution({ env: options.env, runner: options.nativeCliRunner });
  }
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
              platform: target.platform as PlatformName,
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
        ...discovered,
        targets: preApplyAuthorization.availableApplyTargets,
        failures: [...discovered.failures, ...preApplyAuthorization.unavailableTargetResults],
      };
      if (discovered.targets.length === 0
        && preApplyAuthorization.unavailableTargetResults.length > 0
        && (discovered.commandPackages?.length ?? 0) === 0) {
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
        && await configApplyHasValidSharedNativeTarget({
          plugin: options.plugin,
          targets: discovered.targets,
          cwd: options.cwd,
          env,
          plugins: rebuildRuntime.referencePlugins,
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

export interface ApplyPluginConfigOptions {
  plugin: PluginMeta;
  scope: Scope;
  context?: Scope;
  platform?: PlatformTarget;
  targets?: readonly PlatformTarget[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  expectedEvidence?: unknown;
  applyTargets?: ReceiptTargetIdentity[];
  applyCommandPackages?: readonly string[];
  nativeCliRunner?: NativeCliRunner;
  reinstallCommandImpl?: ReinstallCommand;
  rebuildRuntime?: RebuildCommandRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
  sharedNativeApplyConfirmed?: boolean;
  preApplyConfirmed?: boolean;
  preApplyAuthorizedTargets?: readonly PreApplyAuthorizationTarget[];
  reviewPreflight?: () => Promise<void> | void;
}

export interface PreparedPluginConfigApply {
  plan: RecoveryPlan;
  evidence: unknown;
  retainedLegacyTargets: ReceiptTargetIdentity[];
  preApplyAuthorization: PreApplyAuthorizationTarget[];
  commandPackages: ManagedCommandPackageDiscovery['packages'];
  commandDiscoveryErrors: ManagedCommandPackageDiscovery['errors'];
}

function configApplyRequestedTargets(plan: RecoveryPlan): RecoveryPlan['receipt']['requestedTargets'] {
  return plan.receipt.requestedTargets.filter((target) => !plan.receipt.targetResults.some((result) =>
    result.pluginId === target.pluginId && result.agent === target.agent && result.scope === target.scope
      && (result.satisfaction === 'unsupported' || result.satisfaction === 'excluded')));
}

async function prepareConfigApplyPackages(options: ApplyPluginConfigOptions, plugins: readonly PluginMeta[], plan: RecoveryPlan,
  referencePlugins: readonly PluginMeta[]): Promise<{
  packages: ManagedCommandPackageDiscovery['packages'];
  evidence: unknown;
  errors: ManagedCommandPackageDiscovery['errors'];
  hook: NonNullable<RebuildCommandRuntime['configApplyPackages']>;
}> {
  const env = options.env ?? process.env;
  const context = options.context ?? options.scope;
  const discoveries: ManagedCommandPackageDiscovery[] = [];
  const scopes: Scope[] = context === 'project' ? ['user', 'project'] : ['user'];
  const nativeTargets = configApplyRequestedTargets(plan).flatMap((target): ReceiptTargetIdentity[] => target.agent === 'codex' || target.agent === 'claude'
    ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []);
  for (const plugin of plugins) {
    for (const scope of scopes) {
      discoveries.push(await discoverInstalledPluginManagedCommandPackages({ plugin, scope, cwd: options.cwd, env,
        platformTargets: nativeTargets.filter((target) => target.pluginId === (plugin.pluginId ?? plugin.manifest.name)
          && (scope === 'user' || target.scope === 'project')) }));
    }
  }
  const packages = [...new Map(discoveries.flatMap((discovery) => discovery.packages).filter((target) => {
    if (options.applyCommandPackages && !options.applyCommandPackages.includes(target.packageId)) return false;
    if (options.platform) return false;
    if (!options.targets) return true;
    const plugin = plugins.find((entry) => entry.manifest.name === target.producer.pluginName);
    const declaration = plugin?.manifest.managedCommands?.packages.find((entry) => entry.key === target.packageKey && entry.scope === target.producer.scope);
    return declaration?.platforms.some((platform) => options.targets!.includes(platform)) ?? false;
  }).map((target) => [target.packageId, target])).values()];
  const inventory = await listManagedCommandPackages(env);
  const entries = await Promise.all(packages.map(async (target) => {
    const plugin = plugins.find((entry) => entry.manifest.name === target.producer.pluginName)!;
    const installed = inventory.packages.find((entry) => entry.id === target.packageId);
    let recordDigest: string | undefined;
    let blocker: ReturnType<typeof managedCommandDiagnostic> | undefined;
    if (!target.installed || !installed) {
      blocker = { code: 'configApplyRequiresExistingOutput', message: 'Configuration apply requires an existing command package. Run package sync first.' };
    } else if (!target.declared) {
      blocker = { code: 'commandPackageDeclarationMissing', message: 'The installed command package is no longer declared by this plugin.' };
    } else {
      try {
        const record = await readInstalledCommandProducer(installed.resourceRoot);
        recordDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex')}`;
        await assertManagedCommandPackageNativeToolsUnchanged({ plugin, producer: target.producer, env });
      } catch (error) { blocker = managedCommandDiagnostic(error); }
    }
    return { target, recordDigest, blocker };
  }));
  const errors = [...new Map(discoveries.flatMap((discovery) => discovery.errors).map((error) => [JSON.stringify(error), error])).values()];
  const evidence = { packages: entries, errors };
  const targets = [...new Map(entries.map(({ target }) => {
    const plugin = plugins.find((entry) => entry.manifest.name === target.producer.pluginName)!;
    const pluginId = plugin.pluginId ?? plugin.manifest.name;
    const dependencies = resolvePluginMetaDependencyClosure(referencePlugins, [plugin.manifest.name])
      .filter((entry) => entry.manifest.name !== plugin.manifest.name).map((entry) => entry.pluginId ?? entry.manifest.name);
    return [`${pluginId}\0${target.producer.scope}`, { pluginId, scope: target.producer.scope, dependencies }] as const;
  })).values()];
  const cache = plan.runtime.managedCommandProducerCache ??= new Map<string, Promise<CommandProducerResult>>();
  const hook: NonNullable<RebuildCommandRuntime['configApplyPackages']> = { targets, evidence,
    blocked: (pluginId, scope, code) => {
      const plugin = plugins.find((entry) => (entry.pluginId ?? entry.manifest.name) === pluginId)!;
      return entries.filter(({ target }) => target.producer.pluginName === plugin.manifest.name && target.producer.scope === scope)
        .map(({ target }): CommandProducerResult => ({
          producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
          errors: [{ code, message: 'A required provider failed; the command package was not refreshed.' }],
          recoveryActions: [`aw command package sync ${pluginId} ${target.packageKey} --scope ${scope} --yes`],
        }));
    },
    execute: async (pluginId, scope, token) => {
      const plugin = plugins.find((entry) => (entry.pluginId ?? entry.manifest.name) === pluginId)!;
      const selected = entries.filter(({ target }) => target.producer.pluginName === plugin.manifest.name && target.producer.scope === scope);
      const results: CommandProducerResult[] = [];
      let executionContext: Awaited<ReturnType<typeof createScopeContext>> | undefined;
      try {
        executionContext = await createScopeContext({ scope, cwd: options.cwd, env });
        for (const { target, blocker } of selected) {
          if (blocker) {
            const result: CommandProducerResult = { producer: target.producer, state: 'failed', commandIds: [], removedCommandIds: [],
              errors: [blocker], recoveryActions: [target.declared
                ? `aw command package sync ${pluginId} ${target.packageKey} --scope ${scope} --yes`
                : `aw command package remove ${target.packageId} --yes`] };
            cache.set(target.packageId, Promise.resolve(result));
            results.push(result);
            continue;
          }
          const applied = await reinstallVisibleTargets({ plugin, scope, cwd: executionContext.executionCwd, env: executionContext.env,
            changedConfigKeys: [...target.refreshKeys],
            rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken: token, referencePlugins, managedCommandProducerCache: cache },
            discovered: { targets: [], failures: [], commandPackages: [target], commandDiscoveryErrors: [] } });
          results.push(...('commandResults' in applied ? applied.commandResults ?? [] : []));
        }
        return results;
      } finally { await executionContext?.dispose(); }
    } };
  return { packages, evidence, errors, hook };
}

/** Prepare the same existing-output plan used by apply, without saving config or output. */
export async function preparePluginConfigApply(options: ApplyPluginConfigOptions): Promise<PreparedPluginConfigApply> {
  const { prepareRecovery, describeRecoveryPlan } = await import('../recovery/coordinator.js');
  const context = options.context ?? options.scope;
  const referencePlugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    env: options.env, plugins: options.rebuildRuntime?.referencePlugins });
  const plugins = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env,
    plugins: referencePlugins });
  const selectors = plugins.map((plugin) => plugin.pluginId ?? plugin.manifest.name);
  const version = options.cliVersion
    ?? (await fs.readJson(path.join(resolveCliPackageRoot(), 'package.json')) as { version: string }).version;
  let exactTargets = options.applyTargets?.map((target) => ({
    pluginId: target.pluginId ?? plugins.find((plugin) => plugin.manifest.name === target.pluginName)?.pluginId ?? target.pluginName,
    agent: target.platform,
    scope: target.scope,
  }));
  const retainedLegacyTargets: ReceiptTargetIdentity[] = [];
  if (exactTargets?.some((target) => target.agent === 'codex' || target.agent === 'claude')) {
    const { readRecoveryStatus } = await import('../recovery/status.js');
    const observed = await readRecoveryStatus({ context, cwd: options.cwd, env: options.env, cliVersion: version,
      nativeCliRunner: options.nativeCliRunner ?? options.rebuildRuntime?.nativeCliRunner,
      codexObservationSession: options.rebuildRuntime?.codexObservationSession });
    const key = (target: { pluginId: string; agent: PlatformTarget; scope: Scope }): string =>
      `${target.pluginId}\0${target.agent}\0${target.scope}`;
    const live = new Set(observed.existingTargets?.map(key));
    const owned = new Set(observed.ownedTargets?.map(key));
    exactTargets = exactTargets.filter((target, index) => {
      if ((target.agent === 'codex' || target.agent === 'claude') && owned.has(key(target)) && !live.has(key(target))) {
        retainedLegacyTargets.push(options.applyTargets![index]!);
        return false;
      }
      return true;
    });
  }
  const plan = await prepareRecovery('sync', selectors, {
    scope: context,
    context,
    cwd: options.cwd,
    env: options.env,
    cliVersion: version,
    existingOnly: true,
    ...(exactTargets ? { exactTargets } : {}),
    ...(options.targets ? { targets: options.targets } : options.platform ? { targets: [options.platform] } : {}),
  }, {
    ...options.rebuildRuntime,
    referencePlugins,
    nativeCliRunner: options.nativeCliRunner,
    awHomeMutationToken: options.awHomeMutationToken,
    preApplyConfirmed: options.preApplyConfirmed,
  });
  try {
    plan.warnings.push(...retainedLegacyTargets.map((target) =>
      `${target.pluginId ?? target.pluginName}/${target.platform}/${target.scope}：保留已停用的历史输出；配置 apply 不创建激活。`));
    const commands = await prepareConfigApplyPackages(options, plugins, plan, referencePlugins);
    plan.runtime.configApplyPackages = commands.hook;
    const profiles: Array<{ pluginName: string; scope: Scope; platform?: PlatformTarget }> = configApplyRequestedTargets(plan).map((target) => ({
      pluginName: target.pluginId.split('/').at(-1)!, scope: target.scope, platform: target.agent,
    }));
    // A package has platform=null and always consumes the public common profile.
    profiles.push(...commands.packages.map((target) => ({ pluginName: target.producer.pluginName,
      scope: target.producer.scope, platform: undefined })));
    const references = await collectPluginConfigReferenceEvidence({ plugin: options.plugin, plugins: referencePlugins,
      profiles, cwd: options.cwd, env: options.env });
    const authorization = await resolveConfigPreApplyAuthorization({
      plugin: options.plugin, scope: context, cwd: options.cwd, env: options.env,
      applyTargets: configApplyRequestedTargets(plan).flatMap((target): ReceiptTargetIdentity[] => target.agent === 'codex' || target.agent === 'claude'
        ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []),
      nativeCliRunner: options.nativeCliRunner,
      rebuildRuntime: { ...plan.runtime, referencePlugins },
    });
    const portableAuthorization = (current: RecoveryPlan): PreApplyAuthorizationTarget[] => [
      ...current.preApplyAuthorization ?? [],
      ...(current.joint?.children ?? []).flatMap(portableAuthorization),
    ];
    const preApplyAuthorization = [...new Map([...authorization.targets, ...portableAuthorization(plan)]
      .map((target) => [[target.pluginId, target.platform, target.scope].join('\0'), target])).values()];
    return { plan, retainedLegacyTargets, commandPackages: commands.packages, commandDiscoveryErrors: commands.errors,
      preApplyAuthorization,
      evidence: { recovery: describeRecoveryPlan(plan), references, commands: commands.evidence,
        preApplyAuthorization, retainedLegacyTargets } };
  } catch (error) {
    await disposePluginConfigApply(plan);
    throw error;
  }
}

export async function disposePluginConfigApply(plan: RecoveryPlan): Promise<void> {
  for (const child of plan.joint?.children ?? []) await disposePluginConfigApply(child);
  await plan.context.dispose();
}

export async function applyPluginConfig(options: ApplyPluginConfigOptions): Promise<{
  configWrite: 'notStarted'; overallState: RebuildReceiptOverallState; apply: ConfigApplyResult;
  otherProjectsMayRequireSync: boolean;
}> {
  return withAwHomeMutationLock({ env: options.env, token: options.awHomeMutationToken, action: async (token) => {
    await options.reviewPreflight?.();
    let prepared: PreparedPluginConfigApply | undefined;
    try {
      const { executeRecovery } = await import('../recovery/coordinator.js');
      prepared = await preparePluginConfigApply({ ...options, awHomeMutationToken: token });
      if (options.expectedEvidence !== undefined
        && JSON.stringify(options.expectedEvidence) !== JSON.stringify(prepared.evidence)) {
        throw Object.assign(new Error('operationPlanStale: Configuration apply inputs changed. Prepare a new Review.'), { code: 'operationPlanStale' });
      }
      const authorization = prepared.preApplyAuthorization;
      if (authorization.length && !preApplyAuthorizationIsConfirmed({ required: authorization,
        confirmed: options.preApplyConfirmed, authorizedTargets: options.preApplyAuthorizedTargets })) {
        throwPreApplyAuthorizationRequired(authorization);
      }
      if (options.sharedNativeApplyConfirmed !== true && await configApplyHasValidSharedNativeTarget({
        plugin: options.plugin, cwd: options.cwd, env: options.env, plugins: options.rebuildRuntime?.referencePlugins,
        targets: configApplyRequestedTargets(prepared.plan).flatMap((target): ReceiptTargetIdentity[] => target.agent === 'codex' || target.agent === 'claude'
          ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []),
      })) throwSharedNativeApplyConfirmationRequired();
      const discoveryErrors: ConfigApplyError[] = prepared.commandDiscoveryErrors.map((error) => ({
        stage: 'targetDiscovery', code: error.code, message: error.message,
      }));
      const receipt = await executeRecovery(prepared.plan, {
        yes: options.sharedNativeApplyConfirmed === true || options.preApplyConfirmed === true,
        runtime: { ...options.rebuildRuntime, awHomeMutationToken: token, preApplyConfirmed: options.preApplyConfirmed },
      });
      const retainedLegacyTargets = prepared.retainedLegacyTargets.filter((target) => !receipt.targetResults.some((result) =>
        (target.pluginId ? result.pluginId === target.pluginId : result.pluginId.split('/').at(-1) === target.pluginName)
          && result.agent === target.platform && result.scope === target.scope));
      prepared = undefined;
      const ok = receipt.ok && discoveryErrors.length === 0;
      const errors: ConfigApplyError[] = [...discoveryErrors, ...receipt.blockers, ...receipt.errors].map((error) => ({
        stage: 'stage' in error ? error.stage as ConfigApplyError['stage'] : 'apply', code: error.code, message: error.message,
      }));
      const apply: ConfigApplyResult = {
        state: ok ? 'succeeded' : 'partial',
        targetResults: [...receipt.targetResults.filter((target) => target.satisfaction !== 'unsupported' && target.satisfaction !== 'excluded').map((target): ConfigApplyTargetResult => ({
          target: { pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId,
            platform: target.agent, scope: target.scope },
          action: 'refresh',
          state: target.execution === 'applied' || target.execution === 'no-op' ? 'completed'
            : target.execution === 'not-run' ? 'skipped' : 'failed',
          ...(target.blockers.length ? { errorCode: target.blockers[0]!.code,
            message: target.blockers.map((item) => item.message).join(' ') } : {}),
        })), ...retainedLegacyTargets.map((target): ConfigApplyTargetResult => ({
          target, action: 'refresh', state: 'skipped',
          message: 'The inactive legacy output was preserved. Configuration apply does not create an activation.',
        }))],
        commandResults: receipt.commandResults,
        ...(errors.length ? { errors } : {}),
      };
      return { configWrite: 'notStarted', overallState: ok ? 'succeeded' : 'partial', apply,
        otherProjectsMayRequireSync: true };
    } catch (error) {
      if (options.rebuildRuntime?.signal?.aborted || error instanceof Error && error.name === 'AbortError'
        || readSafeOperationError(error)) throw error;
      const apply = unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
      const code = (error as { code?: unknown })?.code;
      if (typeof code === 'string') apply.error = { stage: 'apply', code,
        message: code === 'operationPlanStale' ? 'Configuration apply inputs changed. Prepare a new Review.'
          : 'The existing outputs cannot be refreshed with the current authorization.' };
      return { configWrite: 'notStarted', overallState: 'partial', apply, otherProjectsMayRequireSync: true };
    } finally {
      if (prepared) await disposePluginConfigApply(prepared.plan);
    }
  } });
}

type ApplyPluginConfigWriteOptions = {
  platform?: PlatformTarget;
  context?: Scope;
  cliVersion?: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  pluginName?: string;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  applyCommandPackages?: readonly string[];
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

function throwSharedNativeApplyConfirmationRequired(): never {
  const error = new Error(
    'sharedNativeConfigApplyConfirmationRequired: Applying this user config changes a shared native artifact. Re-run with --yes.',
  ) as Error & { code: string };
  error.code = 'sharedNativeConfigApplyConfirmationRequired';
  throw error;
}

async function applyPluginConfigWriteUnlocked(options: ApplyPluginConfigWriteOptions): Promise<PluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.plugin?.manifest.name ?? '');
  const identity = options.plugin?.sourceId ? { sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity } : {};
  const requestedUpdates = options.request.updates ?? {};
  const removeKeys = uniqueInOrder(options.request.removeKeys ?? []);
  const duplicateKeys = removeKeys.filter((key) => Object.hasOwn(requestedUpdates, key));
  if (duplicateKeys.length) throw new Error(`Config write cannot update and remove the same key: ${duplicateKeys.join(', ')}.`);
  const schemaAccess = await resolvePluginConfigSchemaAccess({ pluginName, currentPlugin: options.plugin,
    currentPluginError: options.pluginError, scope: options.scope, platform: options.platform, cwd: options.cwd, env: options.env });
  const plugin = schemaAccess.plugin;
  const definition = plugin?.manifest.config ? selectPluginConfigProfile(plugin.manifest.config, options.platform) : undefined;
  if (!plugin || !definition) throw new PluginConfigSchemaResolutionError('configSchemaUnavailable', `Plugin "${pluginName}" does not declare an AW config schema.`);
  const updates = await coercePluginConfigUpdates({ schema: definition.fields, updates: requestedUpdates, cwd: options.cwd });
  const impact = await analyzePluginConfigMutationImpact({ plugin, scope: options.scope, platform: options.platform,
    cwd: options.cwd, env: options.env, visibleTargets: [], commandDiscovery: { packages: [], errors: [] },
    referencePlugins: options.rebuildRuntime?.referencePlugins, mutation: { kind: 'patch', updates, removeKeys } });
  await assertPluginConfigMutationCandidate({ ...identity, pluginName, manifest: plugin.manifest,
    scope: options.scope, platform: options.platform, cwd: options.cwd, env: options.env, updates, removeKeys,
    referencePlugins: options.rebuildRuntime?.referencePlugins });
  if (impact.referenceBlockers?.length) throw Object.assign(new Error(`configReferenceInUse: ${impact.referenceBlockers.join(' ')}`), { code: 'configReferenceInUse' });
  if (impact.storeChanged) {
    try {
      await patchPluginConfigStore({ ...identity, pluginName, scope: 'user', platform: options.platform,
        cwd: options.cwd, env: options.env, updates: Object.fromEntries(impact.updatedKeys.map((key) => [key, updates[key]!])), removeKeys });
    } catch (error) { throw markConfigWriteFailed(error); }
  }
  const warnings = [...impact.referenceWarnings ?? []];
  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  try {
    effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({ ...identity, pluginName,
      manifest: plugin.manifest, platform: options.platform, targetScope: options.scope, cwd: options.cwd, env: options.env,
      referencePlugins: options.rebuildRuntime?.referencePlugins }));
  } catch {
    warnings.push('The saved configuration cannot be previewed. Check its schema and reference sources before applying it.');
  }
  if (impact.storeChanged) warnings.push(...otherProjectsWarning('user'));
  return { plugin: pluginName, scope: 'user', context: options.scope, platform: options.platform,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}), updatedKeys: impact.updatedKeys,
    removedKeys: impact.removedKeys, staleRemovedKeys: impact.staleRemovedKeys, effective,
    configWrite: 'succeeded', overallState: 'succeeded',
    apply: skippedApply(impact.storeChanged ? 'notRequested' : 'noConfigChange'),
    otherProjectsMayRequireSync: impact.storeChanged, warnings };
}

async function prepareConfigMutationApplySelection(options: ApplyPluginConfigWriteOptions | ResetPluginConfigWriteOptions): Promise<{
  applyTargets?: ReceiptTargetIdentity[];
  applyCommandPackages?: readonly string[];
  skipReason?: 'noVisibleTarget' | 'noEffectiveConfigChange';
} | undefined> {
  if (options.apply !== true || !options.plugin) return undefined;
  let prepared: PreparedPluginConfigApply | undefined;
  try {
    prepared = await preparePluginConfigApply({ ...options, plugin: options.plugin });
    const requestedTargets = configApplyRequestedTargets(prepared.plan);
    if (requestedTargets.some((target) => target.agent !== 'codex' && target.agent !== 'claude')) return undefined;
    const visibleTargets: ReceiptTargetIdentity[] = requestedTargets.map((target) => ({
      pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId,
      platform: target.agent as PlatformName, scope: target.scope,
    }));
    if (!visibleTargets.length && !prepared.commandPackages.length && !prepared.commandDiscoveryErrors.length) {
      if (prepared.plan.blockExecution || prepared.plan.receipt.blockers.length || prepared.plan.receipt.errors.length) return undefined;
      return { skipReason: 'noVisibleTarget' };
    }
    const impact = await analyzePluginConfigMutationImpact({ plugin: options.plugin, scope: options.context ?? options.scope,
      platform: options.platform, cwd: options.cwd, env: options.env, visibleTargets,
      commandDiscovery: { packages: prepared.commandPackages, errors: prepared.commandDiscoveryErrors },
      referencePlugins: options.rebuildRuntime?.referencePlugins,
      mutation: 'request' in options ? { kind: 'patch', ...options.request } : { kind: 'reset' } });
    return { applyTargets: impact.affectedTargets,
      applyCommandPackages: impact.affectedCommandPackages.map((target) => target.packageId),
      ...(impact.noEffectiveChange ? { skipReason: 'noEffectiveConfigChange' as const } : {}) };
  } catch {
    // A failed output discovery must not prevent a valid configuration save.
    return undefined;
  } finally { if (prepared) await disposePluginConfigApply(prepared.plan); }
}

export async function applyPluginConfigWrite(
  options: ApplyPluginConfigWriteOptions,
): Promise<PluginConfigWriteReceipt> {
  if (options.context) await resolveWorkContext({ cwd: options.cwd, context: options.context });
  const requestedPluginName = options.pluginName ?? options.plugin?.manifest.name;
  if (!requestedPluginName) throw new Error('Plugin name is required for config write.');
  assertSafePluginConfigSegment(requestedPluginName);
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      await options.reviewPreflight?.();
      let configCommitted = false;
      try {
        const selection = await prepareConfigMutationApplySelection({ ...options, awHomeMutationToken });
        const saved = await applyPluginConfigWriteUnlocked({ ...options, scope: options.context ?? options.scope,
          apply: false, awHomeMutationToken, rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken } });
        configCommitted = true;
        if (options.apply !== true || !options.plugin) return saved;
        if (saved.apply.state === 'skipped' && saved.apply.reason === 'noConfigChange') return saved;
        if (selection?.skipReason) return { ...saved, apply: skippedApply(selection.skipReason) };
        const applied = await applyPluginConfig({ ...options, ...selection, plugin: options.plugin, awHomeMutationToken });
        return { ...saved, overallState: applied.overallState, apply: applied.apply };

      } catch (error) {
        let sensitiveValues = options.plugin
          ? collectSensitivePluginConfigValues(
              options.plugin.manifest,
              (options.request.updates ?? {}) as Record<string, PluginConfigValue>,
              options.platform,
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
              referencePlugins: options.rebuildRuntime?.referencePlugins,
              targetScope: options.scope,
      platform: options.platform,
              cwd: options.cwd,
              env: options.env,
            });
            sensitiveValues = [
              ...sensitiveValues,
              ...collectSensitivePluginConfigValues(options.plugin.manifest, effective.values, options.platform),
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
        if (configCommitted || configWrite === 'succeeded' || configWriteStateForError(error) === 'failed') {
          safeError.configWrite = configCommitted || configWrite === 'succeeded' ? 'succeeded' : 'failed';
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
  platform?: PlatformTarget;
  context?: Scope;
  cliVersion?: string;
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
  applyCommandPackages?: readonly string[];
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

async function resetPluginConfigWithHelperUnlocked(options: ResetPluginConfigWriteOptions): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  let identity = options.plugin?.sourceId ? { sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity }
    : { sourceId: options.sourceId, sourceIdentity: options.sourceIdentity, logicalIdentity: options.logicalIdentity };
  if (identity.sourceId && !identity.sourceIdentity) {
    try {
      const stored = await readNamespacedPluginConfigStoreIdentity({ sourceId: identity.sourceId, pluginName,
        scope: 'user', platform: options.platform, cwd: options.cwd, env: options.env });
      if (stored) identity = { ...identity, sourceIdentity: stored.binding.sourceIdentity };
    } catch { /* Reset remains available for unreadable identity metadata. */ }
  }
  let removedKeys: string[] = [];
  try {
    const store = await readPluginConfigStore({ ...identity, pluginName, scope: 'user', platform: options.platform,
      cwd: options.cwd, env: options.env });
    removedKeys = collectRemovedConfigKeys(store.values);
  } catch { /* Broken stores still have the path-based reset boundary. */ }
  const warnings: string[] = [];
  if (options.plugin) {
    try {
      const impact = await analyzePluginConfigMutationImpact({ plugin: options.plugin, scope: options.scope,
        platform: options.platform, cwd: options.cwd, env: options.env, visibleTargets: [],
        commandDiscovery: { packages: [], errors: [] }, referencePlugins: options.rebuildRuntime?.referencePlugins,
        mutation: { kind: 'reset' } });
      warnings.push(...impact.referenceWarnings ?? [], ...impact.referenceBlockers ?? []);
    } catch { warnings.push('Configuration references could not be checked. Reset will still clear the selected layer.'); }
  }
  let reset: Awaited<ReturnType<typeof resetPluginConfigStore>>;
  try { reset = await resetPluginConfigStore({ ...identity, pluginName, scope: 'user', platform: options.platform,
    cwd: options.cwd, env: options.env }); }
  catch (error) { throw markConfigWriteFailed(error); }
  let effective: ReturnType<typeof summarizeEffectivePluginConfig> | undefined;
  let schema: ConfigSchemaEvidence | undefined;
  if (options.plugin) {
    try {
      schema = (await resolvePluginConfigSchemaAccess({ pluginName, currentPlugin: options.plugin,
        scope: options.scope, platform: options.platform, cwd: options.cwd, env: options.env })).schema;
      effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({ ...identity, pluginName,
        manifest: options.plugin.manifest, platform: options.platform, targetScope: options.scope, cwd: options.cwd,
        env: options.env, referencePlugins: options.rebuildRuntime?.referencePlugins }));
    } catch { warnings.push('The cleared configuration cannot be previewed. Check its schema and references before applying it.'); }
  }
  if (reset.existed) warnings.push(...otherProjectsWarning('user'));
  return { plugin: pluginName, scope: 'user', context: options.scope, platform: options.platform, schema,
    existed: reset.existed, deleted: reset.deleted, resetDisposition: reset.resetDisposition,
    ...(reset.quarantineBasename ? { quarantineBasename: reset.quarantineBasename } : {}), removedKeys, effective,
    configWrite: 'succeeded', overallState: 'succeeded', apply: skippedApply(reset.existed ? 'notRequested' : 'noConfigChange'),
    otherProjectsMayRequireSync: reset.existed, warnings };
}

export async function resetPluginConfigWithHelper(
  options: ResetPluginConfigWriteOptions,
): Promise<ResetPluginConfigWriteReceipt> {
  if (options.context) await resolveWorkContext({ cwd: options.cwd, context: options.context });
  assertSafePluginConfigSegment(options.pluginName);
  return withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
    action: async (awHomeMutationToken) => {
      await options.reviewPreflight?.();
      const selection = await prepareConfigMutationApplySelection({ ...options, awHomeMutationToken });
      const saved = await resetPluginConfigWithHelperUnlocked({ ...options, scope: options.context ?? options.scope,
        apply: false, awHomeMutationToken, rebuildRuntime: { ...options.rebuildRuntime, awHomeMutationToken } });
      if (options.apply !== true) return saved;
      if (!options.plugin) return { ...saved, overallState: 'partial', apply: unavailableApply('sourceUnavailable', 'source') };
      if (saved.apply.state === 'skipped' && saved.apply.reason === 'noConfigChange') return saved;
      if (selection?.skipReason) return { ...saved, apply: skippedApply(selection.skipReason) };
      const applied = await applyPluginConfig({ ...options, ...selection, plugin: options.plugin, awHomeMutationToken });
      return { ...saved, overallState: applied.overallState, apply: applied.apply };

    },
  });
}

export async function describeResetAffectedFields(options: {
  platform?: PlatformTarget;
  context?: Scope;
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
      context: options.context,
      platform: options.platform,
      cwd: options.cwd,
      env: options.env,
    });
    return resolved.fields.map((field) => buildReceiptFieldEntry({
      key: field.key,
      title: field.title,
      kind: field.kind,
      reserved: field.reserved,
      action: 'reset',
      scope: 'user',
      platform: options.platform,
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
      scope: 'user',
      platform: options.platform,
      cwd: options.cwd,
      env: options.env,
    });
    return collectRemovedConfigKeys(store.values).map((key) => buildReceiptFieldEntry({
      key,
      title: key,
      kind: 'manifest',
      reserved: false,
      action: 'reset',
      scope: 'user',
      platform: options.platform,
    }));
  }
}
