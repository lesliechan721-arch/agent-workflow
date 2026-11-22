import { catalogGenerationErrorCode } from './catalog-generation-error.js';
import { CatalogPluginNotFoundError } from './multi-source-catalog.js';
import { resolveWorkContext } from '../intent/work-context.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';
import { RecoveryInterruptedError, recoveryInterruptionCode } from '../recovery/interruption.js';
import type { RecoveryTarget } from '../recovery/receipt.js';
import { readDemand, demandNativeProjection } from '../recovery/demand.js';
import { createScopeContext } from '../intent/scope-context.js';
import type {
  PreApplyAuthorizationTarget,
  RebuildCommandRuntime,
} from '../commands/rebuild-command.js';
import { nativeDeploymentHasVerifiedComponentWrite } from '../commands/rebuild-platform-integration.js';
import { projectDeploymentNotices, projectRelatedProjectPermissionFailures } from '../commands/public-lifecycle-result.js';
import { recoveryHostPermissionEffects } from '../commands/deployment-confirmation.js';
import type { Confirmation } from '../output/public-result.js';
import { projectComponentDelivery } from '../output/component-delivery.js';
import { canonicalizeIdentityValue, selectPluginConfigProfile, type PlatformTarget } from '@lesliechan721/aw-plugin-core/manifest';
import { syncWriteCommand } from '../commands/write-commands.js';
import { skillInvocationDiagnostics } from '../output/skill-invocation-notices.js';
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
  type PluginMeta,
  type RebuildReceiptOverallState,
  type ReceiptTargetIdentity,
  type ReceiptTargetResult,
  type Scope,
} from '../types.js';
import type { NativeCliRunner } from './native-cli.js';
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
import { analyzePluginConfigMutationImpact, discoverPluginConfigManagedCommandPackages, pluginSharedNativeConfigRenderUnits, type ManagedCommandPackageDiscovery, type PluginConfigImpactMutation } from './plugin-config-impact.js';
import { collectPluginConfigReferenceEvidence, resolvePluginConfigReferencePlugins, resolvePluginConfigReferenceConsumers } from './plugin-config-references.js';
import { resolvePluginMetaDependencyClosure } from './plugin-dependencies.js';
import { publishPreparedManagedCommandPackage } from './managed-command-materialization.js';
import { ManagedCommandError, managedCommandDiagnostic } from './managed-command-store.js';
import { configPackageResult, inspectConfigCommandPackageReview, prepareConfigCommandPackages, type ConfigCommandApplyCandidate,
  type ConfigCommandPackageEvidence, type ConfigCommandPackageReview } from './plugin-config-command-apply.js';
import {
  collectSensitivePluginConfigValues,
  redactPluginScriptOutput,
} from './plugin-scripts.js';
import { resolveCliPackageRoot } from './paths.js';
import { readSafeOperationError } from './safe-operation-diagnostic.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import fs from 'fs-extra';
import path from 'node:path';

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

export function configActiveAvailabilityError(error: unknown): Pick<ConfigApplyError, 'code' | 'message'> | undefined {
  if (error instanceof CatalogPluginNotFoundError) return { code: 'pluginUnavailable',
    message: 'The plugin is absent from the active catalog. Run aw source sync and check the selector.' };
  if (['catalogGenerationUnavailable', 'catalogGenerationSourceMissing', 'catalogGenerationIdentityMismatch',
    'catalogGenerationStateInvalid', 'catalogGenerationMetadataInvalid'].includes(catalogGenerationErrorCode(error))) {
    return { code: 'sourceActiveUnavailable',
      message: 'The active catalog is unavailable. Run aw source sync, then retry configuration apply.' };
  }
  return undefined;
}

function unavailableApply(
  reason: Extract<ConfigApplyResult, { state: 'unavailable' }>['reason'],
  stage: ConfigApplyError['stage'],
): Extract<ConfigApplyResult, { state: 'unavailable' }> {
  const messages: Record<typeof reason, string> = {
    invalidConfig: 'The effective config is invalid for every visible target.',
    schemaUnavailable: 'The config schema is unavailable after the config commit.',
    sourceUnavailable: 'The plugin source is unavailable after the config commit.',
    effectiveConfigUnavailable: 'The effective config cannot be read after the config commit.',
    targetDiscoveryFailed: 'Visible config apply targets cannot be discovered after the config commit.',
  };
  return { state: 'unavailable', reason, targetResults: [], error: { stage, code: reason, message: messages[reason] } };
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
      const shared = pluginSharedNativeConfigRenderUnits(plugin);
      if (!shared.some((entry) => entry.platform === target.platform)) continue;
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
  const applyTargets = dedupeTargets(options.applyTargets).filter((target) =>
    !options.rebuildRuntime?.configApplyPackages?.targets.some((entry) => entry.blocker
      && entry.pluginId === (target.pluginId ?? options.plugin.pluginId) && entry.platforms.includes(target.platform)));
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
  const groups = new Map<string, ReceiptTargetIdentity[]>();
  for (const target of applyTargets) {
    const key = `${target.scope}\0${target.platform}`;
    const targets = groups.get(key) ?? [];
    targets.push(target);
    groups.set(key, targets);
  }
  const authorization: PreApplyAuthorizationTarget[] = [];
  const availableApplyTargets: ReceiptTargetIdentity[] = [];
  const unavailableTargetResults: ReceiptTargetResult[] = [];
  const resolveGroup = async (targets: ReceiptTargetIdentity[]): Promise<boolean> => {
    const platform = targets[0]!.platform;
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
        nativeCliRunner: options.nativeCliRunner ?? options.rebuildRuntime?.nativeCliRunner,
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

export async function replayConfigRuntimeWrites(options: ApplyPluginConfigOptions): Promise<ConfigRuntimeReplayReceipt> {
  if (options.scope === 'user' && options.sharedNativeApplyConfirmed !== true && await configApplyHasValidSharedNativeTarget({
    ...options, plugins: options.rebuildRuntime?.referencePlugins, targets: options.applyTargets ?? [],
  })) throwSharedNativeApplyConfirmationRequired();
  const result = await applyPluginConfig(options);
  return { ...result, configWrite: 'succeeded', otherProjectsMayRequireSync: false };
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
  expectedHostPermissionEffects?: Confirmation['effects'];
  expectedCommandPackageEvidence?: readonly ConfigCommandPackageEvidence[];
  mutation?: PluginConfigImpactMutation;
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
  commandPackageEvidence: ConfigCommandPackageEvidence[];
  commandPackageReviews: ConfigCommandPackageReview[];
}

const commandCandidateCleanup = new WeakMap<RecoveryPlan, () => Promise<unknown>>();

function configApplyRequestedTargets(plan: RecoveryPlan): RecoveryPlan['receipt']['requestedTargets'] {
  const targets = plan.joint
    ? plan.joint.children.filter((child) => child.command !== 'cleanup' && child.command !== 'uninstall')
      .flatMap((child) => configApplyRequestedTargets(child))
    : plan.receipt.requestedTargets;
  return targets.filter((target) => !plan.receipt.targetResults.some((result) =>
    result.pluginId === target.pluginId && result.agent === target.agent && result.scope === target.scope
      && (result.satisfaction === 'unsupported' || result.satisfaction === 'excluded')));
}

function configApplyPackageHook(
  options: ApplyPluginConfigOptions, entries: readonly ConfigCommandApplyCandidate[], referencePlugins: readonly PluginMeta[],
): NonNullable<RebuildCommandRuntime['configApplyPackages']> {
  const env = options.env ?? process.env;
  const targets = entries.map(({ target, plugin, evidence }) => ({
    pluginId: plugin.pluginId ?? plugin.manifest.name,
    scope: 'user' as const,
    packageId: target.packageId,
    platforms: evidence.review?.routeChanges.length || evidence.blocker
      ? [...plugin.manifest.command?.platforms ?? target.runtimeConfigPlatforms] : [],
    ...(evidence.blocker && ['nativeToolSyncRequired', 'configApplyVersionMismatch'].includes(evidence.blocker.code)
      ? { blocker: evidence.blocker } : {}),
    dependencies: resolvePluginMetaDependencyClosure(referencePlugins, [plugin.manifest.name])
      .filter((entry) => entry.manifest.name !== plugin.manifest.name).map((entry) => entry.pluginId ?? entry.manifest.name),
  }));
  const selected = (pluginId: string, packageId?: string) => entries.filter(({ target, plugin }) =>
    (plugin.pluginId ?? plugin.manifest.name) === pluginId && (!packageId || target.packageId === packageId));
  return { targets, evidence: entries.map(({ evidence }) => evidence),
    blocked: (pluginId, _scope, code, packageId) => selected(pluginId, packageId).map(({ target, candidate, evidence }) =>
      configPackageResult(target, [evidence.blocker ?? { code, message: 'The command package refresh did not complete.' }], candidate)),
    execute: async (pluginId, _scope, _token, packageId) => {
      const results: CommandProducerResult[] = [];
      for (const { target, plugin, candidate, evidence } of selected(pluginId, packageId)) {
        if (evidence.blocker || !candidate) {
          results.push(configPackageResult(target, [evidence.blocker ?? {
            code: 'commandPackageApplyFailed', message: 'The command package could not be prepared.',
          }]));
          continue;
        }
        try {
          options.rebuildRuntime?.signal?.throwIfAborted();
          if (canonicalizeIdentityValue(evidence.review) !== canonicalizeIdentityValue(await inspectConfigCommandPackageReview(options, target, candidate))) {
            throw new ManagedCommandError('operationReviewStale', 'Permissions affecting the reviewed routes changed. Prepare a new Review.');
          }
          const published = await publishPreparedManagedCommandPackage({ plugin, candidate, cwd: options.cwd, env, referencePlugins });
          results.push(configPackageResult(target, [], candidate, published));
        } catch (error) {
          if (recoveryInterruptionCode(error, options.rebuildRuntime?.signal) || readSafeOperationError(error)) throw error;
          results.push(configPackageResult(target, [managedCommandDiagnostic(error)], candidate));
        }
      }
      return results;
    },
  };
}

/** Prepare the same existing-output plan used by apply, without saving config or output. */
export async function preparePluginConfigApply(
  options: ApplyPluginConfigOptions, { inspectOnly = false } = {},
): Promise<PreparedPluginConfigApply> {
  const { prepareRecovery, describeRecoveryPlan } = await import('../recovery/coordinator.js');
  const context = options.context ?? options.scope;
  const referencePlugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    env: options.env, plugins: options.rebuildRuntime?.referencePlugins,
    operationContext: options.rebuildRuntime?.catalogOperationContext }).catch((error: unknown) => {
    if (recoveryInterruptionCode(error, options.rebuildRuntime?.signal)) throw error;
    throw Object.assign(new Error('The selected source has no usable Active Catalog.'), { code: 'sourceActiveUnavailable' });
  });
  if (options.plugin.sourceId) {
    const activePlugin = referencePlugins.find((entry) => entry.manifest.name === options.plugin.manifest.name);
    if (activePlugin) options = { ...options, plugin: activePlugin };
    else if (options.plugin.manifest.command) {
      throw Object.assign(new Error('The plugin is unavailable in Active Catalog.'), { code: 'pluginUnavailable' });
    }
  }
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
  if (exactTargets?.length) {
    const { readRecoveryStatus } = await import('../recovery/status.js');
    const observed = await readRecoveryStatus({ context, cwd: options.cwd, env: options.env, cliVersion: version,
      nativeCliRunner: options.nativeCliRunner ?? options.rebuildRuntime?.nativeCliRunner,
      codexObservationSession: options.rebuildRuntime?.codexObservationSession });
    const key = (target: { pluginId: string; agent: PlatformTarget; scope: Scope }): string =>
      `${target.pluginId}\0${target.agent}\0${target.scope}`;
    const live = new Set(observed.existingTargets?.map(key));
    const owned = new Set(observed.ownedTargets?.map(key));
    exactTargets = exactTargets.filter((target, index) => {
      if (owned.has(key(target)) && !live.has(key(target))) {
        retainedLegacyTargets.push(options.applyTargets![index]!);
        return false;
      }
      return true;
    });
  }
  const env = options.env ?? process.env;
  const commands = await discoverPluginConfigManagedCommandPackages({ plugin: options.plugin, scope: context,
    cwd: options.cwd, env, referencePlugins });
  let selectedPackages = commands.packages.filter((target) => {
    if (options.applyCommandPackages && !options.applyCommandPackages.includes(target.packageId)) return false;
    const plugin = plugins.find((entry) => entry.manifest.name === target.producer.pluginName);
    const platforms = plugin?.manifest.command?.platforms ?? target.runtimeConfigPlatforms;
    if (options.platform) return options.platform !== 'generic' && platforms.includes(options.platform) && target.runtimeConfigKeys.length > 0;
    return (target.refreshKeys.length > 0 || target.runtimeConfigKeys.length > 0)
      && (!options.targets || platforms.some((platform) => options.targets!.includes(platform)));
  });
  if (options.mutation) {
    const impact = await analyzePluginConfigMutationImpact({ ...options, scope: context, visibleTargets: [],
      mutation: options.mutation, commandDiscovery: { ...commands, packages: selectedPackages }, referencePlugins });
    selectedPackages = impact.affectedCommandPackages;
  }
  const entries = await prepareConfigCommandPackages(options, selectedPackages, plugins, referencePlugins, { inspectOnly });
  const cleanup = () => Promise.all(entries.map(({ candidate }) => candidate?.cleanup()));
  const packagePreparationCache: RebuildCommandRuntime['packagePreparationCache'] = new Map();
  for (const { target, candidate } of entries) {
    if (candidate) packagePreparationCache.set(target.packageId, Promise.resolve(candidate));
  }
  let plan: RecoveryPlan | undefined;
  try {
    plan = await prepareRecovery('sync', selectors, {
      scope: context,
      context,
      cwd: options.cwd,
      env: options.env,
      signal: options.rebuildRuntime?.signal,
      cliVersion: version,
      existingOnly: true,
      ...(exactTargets ? { exactTargets } : {}),
      ...(options.platform ? { targets: [options.platform] } : options.targets ? { targets: options.targets } : {}),
    }, {
      ...options.rebuildRuntime,
      configApply: true,
      packagePreparationCache,
      configApplyPackages: configApplyPackageHook(options, entries, referencePlugins),
      referencePlugins,
      nativeCliRunner: options.nativeCliRunner ?? options.rebuildRuntime?.nativeCliRunner,
      awHomeMutationToken: options.awHomeMutationToken,
      preApplyConfirmed: options.preApplyConfirmed,
    });
    commandCandidateCleanup.set(plan, cleanup);
    plan.warnings.push(...retainedLegacyTargets.map((target) =>
      `${target.pluginId ?? target.pluginName}/${target.platform}/${target.scope}：保留已停用的历史输出；配置 apply 不创建激活。`));
    const profiles: Array<{ pluginName: string; scope: Scope; platform?: PlatformTarget }> = configApplyRequestedTargets(plan).map((target) => ({
      pluginName: target.pluginId.split('/').at(-1)!, scope: target.scope, platform: target.agent,
    }));
    for (const { target, candidate } of entries) {
      for (const platform of candidate?.runtimeConfigEvidence.keys() ?? []) {
        profiles.push({ pluginName: target.producer.pluginName, scope: 'user', platform });
      }
      if (candidate?.routeConfigEvidence) profiles.push({ pluginName: target.producer.pluginName, scope: 'user' });
    }
    const references = await collectPluginConfigReferenceEvidence({ plugin: options.plugin, plugins: referencePlugins,
      profiles, cwd: options.cwd, env: options.env });
    const authorization = await resolveConfigPreApplyAuthorization({
      plugin: options.plugin, scope: context, cwd: options.cwd, env: options.env,
      applyTargets: configApplyRequestedTargets(plan).flatMap((target): ReceiptTargetIdentity[] => target.agent !== 'generic'
        ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []),
      nativeCliRunner: options.nativeCliRunner ?? options.rebuildRuntime?.nativeCliRunner,
      rebuildRuntime: { ...plan.runtime, referencePlugins },
    });
    const portableAuthorization = (current: RecoveryPlan): PreApplyAuthorizationTarget[] => [
      ...current.preApplyAuthorization ?? [],
      ...(current.joint?.children ?? []).flatMap(portableAuthorization),
    ];
    const preApplyAuthorization = [...new Map([...authorization.targets, ...portableAuthorization(plan)]
      .map((target) => [[target.pluginId, target.platform, target.scope].join('\0'), target])).values()];
    const commandPackageEvidence = entries.map(({ evidence }) => evidence);
    return { plan, retainedLegacyTargets, commandPackages: commands.packages, commandDiscoveryErrors: commands.errors,
      commandPackageEvidence, commandPackageReviews: commandPackageEvidence.flatMap(({ review }) => review ? [review] : []),
      preApplyAuthorization,
      evidence: { recovery: describeRecoveryPlan(plan), references, commandPackageEvidence,
        preApplyAuthorization, retainedLegacyTargets } };
  } catch (error) {
    if (plan) await disposePluginConfigApply(plan);
    else await cleanup();
    throw error;
  }
}

export async function disposePluginConfigApply(plan: RecoveryPlan): Promise<void> {
  const cleanup = commandCandidateCleanup.get(plan);
  commandCandidateCleanup.delete(plan);
  await cleanup?.();
  for (const child of plan.joint?.children ?? []) await disposePluginConfigApply(child);
  await plan.context.dispose();
}

export class ConfigApplyInterruptedError extends Error {
  readonly code: string;
  readonly operationDiagnostic;
  configWrite: 'notStarted' | 'succeeded' = 'notStarted';

  constructor(error: RecoveryInterruptedError, readonly apply: ConfigApplyResult, signal?: AbortSignal) {
    super(error.code === 'operationInterrupted' && signal?.reason instanceof Error ? signal.reason.message : error.message);
    this.code = error.code;
    this.operationDiagnostic = readSafeOperationError(error.cause) ?? error.operationDiagnostic;
  }
}

function configApplyHasPartialDelivery(target: RecoveryTarget): boolean {
  if (target.execution !== 'partial') return false;
  if (skillInvocationDiagnostics([target]).some(({ subject }) => subject?.pluginId === target.pluginId
    && subject.target === target.agent && subject.scope === target.scope)) return true;
  if (target.delivery?.kind === 'native') {
    return target.deploymentReceipts?.some((receipt) => {
      const plan = target.deploymentPlans?.find(({ binding }) => binding.id === receipt.bindingId);
      return plan && nativeDeploymentHasVerifiedComponentWrite(plan, receipt);
    }) ?? false;
  }
  if (target.delivery?.kind !== 'agent-skills' || !Array.isArray(target.backend)) return false;
  return target.backend.some((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return false;
    const outcome = entry as Record<string, unknown>;
    return typeof outcome.skill === 'string' && outcome.observation === 'satisfied'
      && (outcome.execution === 'applied' || outcome.execution === 'no-op')
      && Array.isArray(outcome.blockers) && outcome.blockers.length === 0;
  });
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
      const expectedCommands = options.expectedCommandPackageEvidence
        ?? (options.expectedEvidence as { commandPackageEvidence?: ConfigCommandPackageEvidence[] } | undefined)?.commandPackageEvidence;
      prepared = await preparePluginConfigApply({ ...options, awHomeMutationToken: token,
        expectedCommandPackageEvidence: expectedCommands });
      if (options.expectedEvidence !== undefined
        && JSON.stringify(options.expectedEvidence) !== JSON.stringify(prepared.evidence)) {
        throw Object.assign(new Error('Configuration apply inputs changed. Prepare a new Review.'), { code: 'operationReviewStale' });
      }
      const authorizedEffects = new Set(options.expectedHostPermissionEffects?.map((effect) => JSON.stringify(effect)));
      if (recoveryHostPermissionEffects(prepared.plan).some((effect) => !authorizedEffects.has(JSON.stringify(effect)))) {
        throw Object.assign(new Error('Host permission effects changed after Review. Prepare a new Review.'), { code: 'operationReviewStale' });
      }
      const authorization = prepared.preApplyAuthorization;
      if (authorization.length && !preApplyAuthorizationIsConfirmed({ required: authorization,
        confirmed: options.preApplyConfirmed, authorizedTargets: options.preApplyAuthorizedTargets })) {
        throwPreApplyAuthorizationRequired(authorization);
      }
      if (options.sharedNativeApplyConfirmed !== true && await configApplyHasValidSharedNativeTarget({
        plugin: options.plugin, cwd: options.cwd, env: options.env, plugins: options.rebuildRuntime?.referencePlugins,
        targets: configApplyRequestedTargets(prepared.plan).flatMap((target): ReceiptTargetIdentity[] => target.agent !== 'generic'
          ? [{ pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId, platform: target.agent, scope: target.scope }] : []),
      })) throwSharedNativeApplyConfirmationRequired();
      const discoveryErrors: ConfigApplyError[] = prepared.commandDiscoveryErrors.map((error) => ({
        stage: 'targetDiscovery', code: error.code, message: error.message,
      }));
      let interruption: RecoveryInterruptedError | undefined;
      const receipt = await executeRecovery(prepared.plan, {
        yes: options.sharedNativeApplyConfirmed === true || options.preApplyConfirmed === true,
        runtime: { ...options.rebuildRuntime, awHomeMutationToken: token, preApplyConfirmed: options.preApplyConfirmed },
      }).catch((error: unknown) => {
        if (!(error instanceof RecoveryInterruptedError)) throw error;
        interruption = error;
        return error.receipt;
      });
      const retainedLegacyTargets = prepared.retainedLegacyTargets.filter((target) => !receipt.targetResults.some((result) =>
        (target.pluginId ? result.pluginId === target.pluginId : result.pluginId.split('/').at(-1) === target.pluginName)
          && result.agent === target.platform && result.scope === target.scope));
      const ok = receipt.ok && discoveryErrors.length === 0;
      const errors: ConfigApplyError[] = [...discoveryErrors, ...receipt.blockers, ...receipt.errors].map((error) => ({
        stage: 'stage' in error ? error.stage as ConfigApplyError['stage'] : 'apply', code: error.code, message: error.message,
      }));
      const diagnostics = [...projectDeploymentNotices(receipt.targetResults), ...projectRelatedProjectPermissionFailures(receipt.targetResults)];
      const apply: ConfigApplyResult = {
        state: ok ? 'succeeded' : 'partial',
        targetResults: [...receipt.targetResults.filter((target) => target.satisfaction !== 'unsupported' && target.satisfaction !== 'excluded').map((target): ConfigApplyTargetResult => ({
          target: { pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId,
            platform: target.agent, scope: target.scope },
          action: 'refresh',
          state: target.execution === 'applied' || target.execution === 'no-op' ? 'completed'
            : target.execution === 'not-run' ? 'skipped' : 'failed',
          ...projectComponentDelivery(target),
          ...(target.relation === 'root' ? { relation: 'requested' } : target.relation === 'dependency' ? { relation: 'dependency' } : {}),
          ...(target.requiredBy.length ? { requiredBy: target.requiredBy } : {}),
          ...(configApplyHasPartialDelivery(target) ? { partialDelivery: true } : {}),
          ...(target.blockers.length ? { errorCode: target.blockers[0]!.code,
            message: target.blockers.map((item) => item.message).join(' ') } : {}),
        })), ...retainedLegacyTargets.map((target): ConfigApplyTargetResult => ({
          target, action: 'refresh', state: 'skipped',
          message: 'The inactive legacy output was preserved. Configuration apply does not create an activation.',
        }))],
        commandResults: receipt.commandResults,
        ...(receipt.reviewedUserRoots !== undefined ? { reviewedUserRoots: receipt.reviewedUserRoots } : {}),
        ...(errors.length ? { errors } : {}),
        ...(diagnostics.length ? { diagnostics } : {}),
      };
      if (interruption) throw new ConfigApplyInterruptedError(interruption, apply, options.rebuildRuntime?.signal);
      return { configWrite: 'notStarted', overallState: ok ? 'succeeded' : 'partial', apply,
        otherProjectsMayRequireSync: true };
    } catch (error) {
      if (recoveryInterruptionCode(error, options.rebuildRuntime?.signal)
        || readSafeOperationError(error)) throw error;
      const apply = unavailableApply('targetDiscoveryFailed', 'targetDiscovery');
      const code = (error as { code?: unknown })?.code;
      if (code === 'sourceActiveUnavailable' || code === 'pluginUnavailable') {
        return { configWrite: 'notStarted', overallState: 'partial', apply: {
          ...unavailableApply('sourceUnavailable', 'source'),
          error: { stage: 'source', code, message: error instanceof Error ? error.message : 'The Active Catalog plugin is unavailable.' },
        }, otherProjectsMayRequireSync: true };
      }
      if (typeof code === 'string') apply.error = { stage: 'apply', code,
        message: code === 'operationReviewStale' ? 'Configuration apply inputs changed. Prepare a new Review.'
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
  expectedCommandPackageEvidence?: readonly ConfigCommandPackageEvidence[];
  expectedHostPermissionEffects?: Confirmation['effects'];
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
    prepared = await preparePluginConfigApply({ ...options, plugin: options.plugin }, { inspectOnly: true });
    const requestedTargets = configApplyRequestedTargets(prepared.plan);
    const hasGeneric = requestedTargets.some((target) => target.agent === 'generic');
    const visibleTargets: ReceiptTargetIdentity[] = requestedTargets.flatMap((target) => target.agent === 'generic' ? [] : [{
      pluginName: target.pluginId.split('/').at(-1)!, pluginId: target.pluginId,
      platform: target.agent, scope: target.scope,
    }]);
    const impact = await analyzePluginConfigMutationImpact({ plugin: options.plugin, scope: options.context ?? options.scope,
      platform: options.platform, cwd: options.cwd, env: options.env, visibleTargets,
      commandDiscovery: { packages: prepared.commandPackages, errors: prepared.commandDiscoveryErrors },
      referencePlugins: options.rebuildRuntime?.referencePlugins,
      mutation: 'request' in options ? { kind: 'patch', ...options.request } : { kind: 'reset' } });
    if (options.expectedCommandPackageEvidence) {
      const referencePlugins = prepared.plan.runtime.referencePlugins ?? [];
      const plugins = await resolvePluginConfigReferenceConsumers({ plugin: options.plugin, env: options.env, plugins: referencePlugins });
      const entries = await prepareConfigCommandPackages({ ...options, plugin: options.plugin,
        mutation: 'request' in options ? { kind: 'patch', ...options.request } : { kind: 'reset' } },
      impact.affectedCommandPackages, plugins, referencePlugins);
      await Promise.all(entries.map(({ candidate }) => candidate?.cleanup()));
    }
    if (!hasGeneric && !visibleTargets.length && !prepared.commandPackages.length && !prepared.commandDiscoveryErrors.length) {
      if (prepared.plan.blockExecution || prepared.plan.receipt.blockers.length || prepared.plan.receipt.errors.length) return undefined;
      return { skipReason: 'noVisibleTarget' };
    }
    return { applyTargets: hasGeneric ? undefined : impact.affectedTargets,
      applyCommandPackages: impact.affectedCommandPackages.map((target) => target.packageId),
      ...(!hasGeneric && impact.noEffectiveChange ? { skipReason: 'noEffectiveConfigChange' as const } : {}) };
  } catch (error) {
    if ((error as { code?: string })?.code === 'operationReviewStale' || recoveryInterruptionCode(error, options.rebuildRuntime?.signal)) throw error;
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
        if (error instanceof ConfigApplyInterruptedError) {
          error.message = message;
          if (configCommitted) error.configWrite = 'succeeded';
          throw error;
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
  expectedCommandPackageEvidence?: readonly ConfigCommandPackageEvidence[];
  expectedHostPermissionEffects?: Confirmation['effects'];
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
      if (!options.plugin) {
        const apply = unavailableApply('sourceUnavailable', 'source');
        const cause = configActiveAvailabilityError(options.pluginError);
        return { ...saved, overallState: 'partial', apply: cause ? { ...apply, error: { stage: 'source', ...cause } } : apply };
      }
      if (saved.apply.state === 'skipped' && saved.apply.reason === 'noConfigChange') return saved;
      if (selection?.skipReason) return { ...saved, apply: skippedApply(selection.skipReason) };
      const applied = await applyPluginConfig({ ...options, ...selection, plugin: options.plugin, awHomeMutationToken })
        .catch((error: unknown) => {
          if (error instanceof ConfigApplyInterruptedError) error.configWrite = 'succeeded';
          throw error;
        });
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
