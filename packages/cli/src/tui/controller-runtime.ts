import { readAgentSettings, previewAgentSettings, saveAgentSettings } from './agent-settings.js';
import { selectPluginConfigProfile, getPluginConfigReferenceChoices, PLATFORM_TARGETS, resolveSupportedPlatforms } from '@lesliechan721/aw-plugin-core';
import { configReferenceKey, configReferenceScalars, type ConfigReferenceContext } from './config-references.js';
import crypto from 'node:crypto';
import path from 'node:path';

import type { CliExecutionContext } from '../commands/runtime.js';
import { resolveWorkContext } from '../intent/work-context.js';
import type { CatalogSourceResolution, PlatformName, PlatformTarget, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
import {
  flattenStatusTargets,
  statusCommandV8,
  statusTargetHasLiveConfigConsumer,
  type StatusTargetRevision,
  type StatusScopedTarget,
  type StatusV8Target,
} from '../commands/status-v6.js';
import {
  addCatalogSourceCommand,
  listCatalogSources,
  preflightCatalogSourceMutation,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceMutationProgress,
} from '../commands/catalog-source.js';
import {
  parseScriptTimeoutMs,
  SCRIPT_TIMEOUT_DEFAULT_MS,
} from '../commands/options.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import {
  readCatalogSourcesConfigSnapshot,
  recoverInvalidCatalogSourcesConfig,
} from '../utils/catalog-sources.js';
import {
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  formatPluginId,
  parsePluginId,
} from '../utils/multi-source-catalog.js';
import {
  coercePluginConfigUpdates,
  inspectPluginConfigResetTarget,
  listNamespacedPluginConfigStoreIdentities,
  readPluginConfigStore,
  replacePluginConfigStoreLayer,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolveEffectivePluginConfigFromStores,
  resolvePluginConfigReferenceContext,
} from '../utils/plugin-config.js';
import { readRecoveryStatus } from '../recovery/status.js';
import {
  activateRecoverySourcesAndReprepare,
  prepareRecovery,
  executeRecovery,
} from '../recovery/coordinator.js';
import { prepareRetire, executeRetire } from '../recovery/retirement.js';
import { prepareTargetsPlan, executeTargetsPlan, prepareIntentPlan, executeIntentPlan } from './scoped-flow.js';
import {
  applyPluginConfigWrite,
  applyPluginConfig,
  preparePluginConfigApply,
  disposePluginConfigApply,
  resolveConfigPreApplyAuthorization,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import { analyzePluginConfigMutationImpact, discoverPluginConfigManagedCommandPackages, pluginConfigTargetRenderScopes, pluginSharedNativeConfigTargets } from '../utils/plugin-config-impact.js';
import { collectPluginConfigReferenceEvidence, pluginConfigHasExternalReferences, resolvePluginConfigReferenceConsumers, resolvePluginConfigReferencePlugins } from '../utils/plugin-config-references.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { RebuildReviewPreflightEvidence } from '../commands/rebuild-command.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import {
  operationEvidenceMatches,
  operationEvidenceFingerprint,
  TuiConfigInvalidStoreError,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type ConfigSaveBatchExecutionResult,
  type ConfigSaveBatchGroup,
  type ReviewPreparationStageId,
  type TuiControllerDependencies,
} from './controller.js';
import type { CatalogSessionReusableCandidate } from './catalog-sources/types.js';
import {
  buildConfigPage,
  hasActualScopeEvidence,
  projectPlatformPlacement,
  type PlatformPlacementSummary,
  type PluginDependencyOverviewViewModel,
} from './model.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import {
  calculateCatalogSourceConfigFingerprint,
  calculateCatalogSourceIdentity,
} from '../utils/catalog-source-identity.js';
import { checkAwCapabilitySupport, readPluginManifest } from '../utils/manifest.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import {
  calculateCatalogGenerationSetDigest,
  resolveActiveCatalogGeneration,
} from '../utils/catalog-generation-resolver.js';
import {
  resolveCatalogOperationContext,
  resolvePartialCatalogOperationContext,
  selectCatalogOperationContext,
  type CatalogOperationContext,
} from '../utils/catalog-operation-context.js';
import {
  createCatalogStoreKey,
  readCatalogStoreEntry,
  type CatalogStoreEntry,
} from '../utils/catalog-generation-store.js';
import {
  activateCatalogSourceGeneration,
  compareCatalogGenerationFreshness,
  probeCatalogSourceFreshness,
  probeCatalogSourceGeneration,
  probeCatalogSourceRepairGeneration,
  recoverCatalogGenerationStateAndActivate,
  repairCatalogSourceGeneration,
  replaceDamagedCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
} from '../utils/catalog-generation-service.js';
import {
  calculateCatalogSourceImpactDigest,
  inspectCatalogSourceImpact,
} from '../utils/catalog-source-impact.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { CatalogProviderCompatibilityError } from '../utils/catalog-public-error.js';
import { loadCatalogGenerationViewModels } from './catalog-generation.js';
import {
  executePortableRetry,
  installPortableSkills,
  preparePortableInstall,
  preparePortableRetry,
  PortableCommandError,
  recheckPortableInstall,
  type PortableRetryReview,
} from '../portable/commands.js';
import {
  projectPluginContentOverview,
  type PluginContentOverview,
} from './plugin-content.js';
import {
  executeCatalogStoreTask,
  inspectCatalogStoreTask,
  prepareCatalogStoreTask,
} from './catalog-store-task.js';

function reusableCandidateEvidenceIsComplete(
  candidate: CatalogSessionReusableCandidate,
): boolean {
  const evidence = candidate.probe.candidate;
  return [
    evidence.sourceConfigFingerprint,
    evidence.sourceIdentity,
    evidence.logicalIdentity,
    evidence.requestedRef,
    evidence.resolvedCommit,
    evidence.catalogVersion,
    evidence.channel,
    evidence.manifestDigest,
    evidence.snapshotDigest,
  ].every((value) => typeof value === 'string' && value.length > 0)
    && typeof candidate.probe.manifest === 'object'
    && candidate.probe.manifest !== null;
}

async function loadPortablePluginIds(options: {
  context: CliExecutionContext;
  cliVersion: string;
  signal: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}): Promise<string[]> {
  return withResolvedMultiSourceCatalog({
    cliVersion: options.cliVersion,
    env: options.context.env,
    signal: options.signal,
    ...(options.catalogOperationContext
      ? { operationContext: options.catalogOperationContext }
      : {}),
    consume: async (catalog) => (await Promise.all(catalog.sources.flatMap((item) => item.resolution
      ? item.resolution.manifest.entries.flatMap((entry) => {
          const support = checkAwCapabilitySupport(
            entry.requires.aw.capabilities ?? [],
            IMPLEMENTED_AW_CAPABILITIES,
          );
          return support.supported
            ? [readPluginManifest(
                path.join(item.resolution!.rootDir, 'plugins', entry.name),
                { mode: 'bundle' },
              ).then((plugin) => [...resolveSupportedPlatforms(plugin.manifest)].some((target) => target !== 'codex' && target !== 'claude')
                ? formatPluginId({
                    sourceId: item.resolution!.sourceId,
                    pluginName: entry.name,
                  })
                : null)]
            : [];
        })
      : []))).filter((pluginId): pluginId is string => pluginId !== null),
  });
}

export interface TuiControllerRuntimeTestHooks {
  beforeMutationEvidenceCapture?: () => Promise<void>;
  afterMutationEvidenceCapture?: () => Promise<void>;
  onCatalogSourceProgress?: (event: CatalogSourceMutationProgress) => Promise<void> | void;
  afterCatalogSourceConfigCommit?: () => Promise<void>;
  afterCatalogGenerationCandidateResolved?: () => Promise<void>;
}

let tuiControllerRuntimeTestHooks: TuiControllerRuntimeTestHooks | undefined;

export function setTuiControllerRuntimeTestHooksForTests(
  hooks: TuiControllerRuntimeTestHooks | undefined,
): void {
  tuiControllerRuntimeTestHooks = hooks;
}

function digest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function configSchemaIdentity(plugin: PluginMeta, manifestDigest: string | undefined, platform?: PlatformTarget): string {
  return digest({ manifestDigest, profile: platform ?? 'common',
    definition: selectPluginConfigProfile(plugin.manifest.config!, platform) });
}

export function statusTargetFingerprint(
  targets: StatusScopedTarget[],
  revisions: StatusTargetRevision[] = [],
): string {
  return digest({
    targets: targets.map((target) => ({
      pluginId: target.pluginId,
      sourceIdentity: target.sourceIdentity,
      platform: target.platform,
      scope: target.scope,
      state: target.state,
      errors: target.reasons.map((error) => error.code).sort(),
      sharedReasons: [...(target.sharedReasons ?? [])]
        .sort((left, right) => `${left.code}\0${left.message}`.localeCompare(
          `${right.code}\0${right.message}`, 'en',
        )),
      components: target.components.map((component) => [component.key, component.state])
        .sort(([left], [right]) => left!.localeCompare(right!, 'en')),
      sharedComponents: (target.sharedComponents ?? [])
        .map((component): [string, string, typeof component.metadata] =>
          [component.key, component.state, component.metadata])
        .sort(([left], [right]) => left!.localeCompare(right!, 'en')),
    })).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
      .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en')),
    revisions: revisions.map((entry) => ({
      pluginId: entry.pluginId,
      platform: entry.platform,
      scope: entry.scope,
      revision: entry.revision,
    })).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
      .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en')),
  });
}

export function configAffectedStatusTargets(
  targets: StatusV8Target[],
  pluginId: string,
  configContext: Scope,
  consumerPluginIds: readonly string[] = [],
  platform?: PlatformTarget,
): StatusScopedTarget[] {
  const affected = new Map<string, StatusScopedTarget>();
  const selected = new Set([pluginId, ...consumerPluginIds]);
  for (const target of flattenStatusTargets(targets)) {
    if (!selected.has(target.pluginId) || !statusTargetHasLiveConfigConsumer(target)) continue;
    if (configContext === 'user' && target.scope !== 'user') continue;
    if (platform && target.platform !== platform) continue;
    affected.set(`${target.pluginId}\0${target.platform}\0${target.scope}`, target);
  }
  return [...affected.values()]
    .sort((left, right) => `${left.pluginId}\0${left.platform}\0${left.scope}`
      .localeCompare(`${right.pluginId}\0${right.platform}\0${right.scope}`, 'en'));
}

function configNeedsReferencePlugins(plugin: PluginMeta): boolean {
  return pluginConfigHasExternalReferences(plugin.manifest)
    || (plugin.manifest.config !== undefined && [undefined, ...PLATFORM_TARGETS].some((platform) =>
      Object.values(selectPluginConfigProfile(plugin.manifest.config!, platform).fields)
        .some((field) => field.type === 'array' && field.items.type === 'object')));
}

async function configRetrySharedNativeRenderTargets(
  plugin: PluginMeta,
  targets: readonly { pluginName?: string; platform: PlatformName }[],
  env?: NodeJS.ProcessEnv,
  referencePlugins?: readonly PluginMeta[],
): Promise<ReturnType<typeof pluginSharedNativeConfigTargets>> {
  const plugins = await resolvePluginConfigReferenceConsumers({ plugin, env, plugins: referencePlugins });
  return plugins.flatMap((consumer) => pluginSharedNativeConfigTargets(consumer).filter((shared) =>
    targets.some((target) => (target.pluginName ?? plugin.manifest.name) === consumer.manifest.name
      && target.platform === (shared.platform ?? 'codex'))));
}

async function configRetryStoreDigest(options: {
  plugin: PluginMeta;
  scope: Scope;
  platform?: PlatformTarget;
  targets: readonly { pluginName: string; platform: PlatformName; scope: Scope }[];
  commandPackages: readonly { producer: { pluginName: string; scope: Scope; platform?: PlatformName | null } }[];
  preApplyAuthorization: readonly { pluginName: string; scope: Scope }[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugins?: readonly PluginMeta[];
}): Promise<string> {
  const plugins = await resolvePluginConfigReferencePlugins({ sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity, logicalIdentity: options.plugin.catalogLogicalIdentity,
    env: options.env, plugins: options.plugins });
  const byName = new Map([...plugins, options.plugin].map((plugin) => [plugin.manifest.name, plugin]));
  const profiles = [{ pluginName: options.plugin.manifest.name, scope: options.scope, platform: options.platform },
    ...options.targets.flatMap((target) => {
      const plugin = byName.get(target.pluginName);
      if (!plugin) throw operationReviewStale('重试目标的插件定义已变化。');
      return pluginConfigTargetRenderScopes(plugin, target).map((scope) => ({ pluginName: target.pluginName, scope, platform: target.platform }));
    }),
    ...options.commandPackages.map(({ producer }) => ({ pluginName: producer.pluginName, scope: producer.scope,
      platform: producer.platform ?? undefined })),
    ...options.preApplyAuthorization.map(({ pluginName, scope }) => ({ pluginName, scope, platform: options.platform }))];
  return digest(await collectPluginConfigReferenceEvidence({ ...options, profiles, plugins }));
}

function configImpactVisibleTargets(
  pluginName: string,
  targets: readonly StatusScopedTarget[],
) {
  return targets.map((target) => ({
    pluginName: target.pluginName ?? pluginName,
    platform: target.platform,
    scope: target.scope,
  }));
}

function configIntentRequestsApply(
  intent: Extract<OperationIntent, { kind: 'configSave' }>,
): boolean {
  if (!intent.apply) return false;
  if (intent.retryApply === true) return true;
  if (intent.changes) return intent.changes.length > 0;
  return Object.keys(intent.updates ?? {}).length > 0
    || (intent.removeKeys?.length ?? 0) > 0;
}

type ConfigSaveIntent = Extract<OperationIntent, { kind: 'configSave' }>;
type ConfigSaveBatchIntent = Extract<OperationIntent, { kind: 'configSaveBatch' }>;

function configSaveBatchGroupIntent(
  intent: ConfigSaveBatchIntent,
  group: ConfigSaveBatchGroup,
): ConfigSaveIntent {
  return {
    kind: 'configSave',
    pluginId: intent.pluginId,
    scope: 'user',
    platform: group.platform,
    context: intent.context ?? 'user',
    apply: intent.apply,
    ...(intent.scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs: intent.scriptTimeoutMs }),
    ...(group.updates ? { updates: group.updates } : {}),
    ...(group.removeKeys ? { removeKeys: group.removeKeys } : {}),
    ...(group.sensitiveKeys ? { sensitiveKeys: group.sensitiveKeys } : {}),
    ...(group.privateKeys ? { privateKeys: group.privateKeys } : {}),
    ...(group.changes ? { changes: group.changes } : {}),
  };
}

function assertConfigSaveBatchIntent(intent: ConfigSaveBatchIntent): void {
  if (intent.groups.length === 0 || intent.groups.length > PLATFORM_TARGETS.length + 1
    || new Set(intent.groups.map((group) => group.platform ?? 'common')).size !== intent.groups.length
    || intent.groups.some((group) => Object.keys(group.updates ?? {}).length === 0
      && (group.removeKeys?.length ?? 0) === 0)) {
    throw new TuiOperationBlockedError(
      'configBatchInvalid',
      '设置批次必须包含唯一且非空的公共或平台配置。',
    );
  }
}

type OperationSourceEvidence = NonNullable<OperationEvidence['source']>;

function operationReviewStale(
  message: string,
  diagnostics?: ConstructorParameters<typeof TuiOperationBlockedError>[2],
): TuiOperationBlockedError {
  return new TuiOperationBlockedError(
    'operationReviewStale',
    `operationReviewStale: ${message}`,
    diagnostics,
  );
}

function sourceEvidenceForPlugin(
  source: CatalogSourceResolution,
  pluginName: string,
): OperationSourceEvidence {
  const entry = source.manifest.entries.find((candidate) => candidate.name === pluginName)!;
  return {
    sourceId: source.sourceId,
    sourceIdentity: source.sourceIdentity,
    logicalIdentity: source.logicalIdentity,
    requestedRef: source.requestedRef,
    resolvedCommit: source.resolvedCommit,
    manifestDigest: source.manifestDigest,
    snapshotDigest: source.snapshotDigest,
    contentDigest: entry.contentDigest,
    pluginVersion: entry.version,
    catalogVersion: source.manifest.catalogVersion,
    channel: source.manifest.channel,
  };
}

async function configLayerStoreDigest(options: {
  source: OperationSourceEvidence;
  pluginName: string;
  scope: Scope;
  platform?: PlatformTarget;
  profileOnly?: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const store = await readPluginConfigStore({
    sourceId: options.source.sourceId,
    sourceIdentity: options.source.sourceIdentity,
    ...('logicalIdentity' in options.source
      ? { logicalIdentity: options.source.logicalIdentity }
      : {}),
    pluginName: options.pluginName,
    scope: 'user',
    platform: options.platform,
    cwd: options.cwd,
    env: options.env,
  });
  return options.profileOnly
    ? digest({ profile: options.platform ?? 'common', state: store.state === 'invalid' ? 'invalid' : 'ready',
        values: store.values, ...(store.state === 'invalid' ? { rawDigest: store.rawDigest } : {}) })
    : digest({ exists: store.exists, rawDigest: store.rawDigest });
}

function assertSourceEvidenceMatches(
  expected: OperationSourceEvidence,
  actual: Pick<
    RebuildReviewPreflightEvidence,
    'sourceId' | 'sourceIdentity' | 'logicalIdentity' | 'resolvedCommit'
    | 'manifestDigest' | 'snapshotDigest' | 'contentDigest'
  >,
): void {
  if (actual.sourceId !== expected.sourceId
    || actual.sourceIdentity !== expected.sourceIdentity
    || actual.logicalIdentity !== expected.logicalIdentity
    || actual.resolvedCommit !== expected.resolvedCommit
    || actual.manifestDigest !== expected.manifestDigest
    || actual.snapshotDigest !== expected.snapshotDigest
    || actual.contentDigest !== expected.contentDigest) {
    throw operationReviewStale('确认后来源内容发生变化。');
  }
}

const SOURCE_PROGRESS_PHASES: Record<CatalogSourceMutationProgress['stage'], string> = {
  savingConfig: '保存来源配置',
};

function reviewedScriptTimeoutMs(intent: OperationIntent): number | undefined {
  if (intent.kind === 'pluginWriteTask') {
    return parseScriptTimeoutMs(intent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS);
  }
  if ((intent.kind === 'pluginWrite' || intent.kind === 'pluginWriteBatch')
    && (intent.action === 'install' || intent.action === 'refreshAndSync'
      || intent.action === 'reinstall' || intent.action === 'sync')) {
    return parseScriptTimeoutMs(intent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS);
  }
  if ((intent.kind === 'configSave' || intent.kind === 'configSaveBatch') && intent.apply) {
    return parseScriptTimeoutMs(intent.scriptTimeoutMs ?? SCRIPT_TIMEOUT_DEFAULT_MS);
  }
  return undefined;
}

interface DependencyCatalogNode {
  pluginId: string;
  sourceIdentity: string;
  displayName: string;
  dependencies: string[];
}

async function loadDependencyOverviews(options: {
  context: CliExecutionContext;
  cliVersion: string;
  status: Awaited<ReturnType<typeof statusCommandV8>>;
  signal: AbortSignal;
  catalogOperationContext?: CatalogOperationContext;
}): Promise<PluginDependencyOverviewViewModel[]> {
  const graph = await withResolvedMultiSourceCatalog({
      cliVersion: options.cliVersion,
      env: options.context.env,
      signal: options.signal,
      ...(options.catalogOperationContext
        ? { operationContext: options.catalogOperationContext }
        : {}),
      consume: async (catalog) => ({
        nodes: catalog.sources.flatMap((item) => item.resolution
          ? item.resolution.manifest.entries.map((entry): DependencyCatalogNode => ({
              pluginId: formatPluginId({
                sourceId: item.resolution!.sourceId,
                pluginName: entry.name,
              }),
              sourceIdentity: item.resolution!.sourceIdentity,
              displayName: entry.interface?.displayName ?? entry.name,
              dependencies: entry.dependencies.map((pluginName) =>
                formatPluginId({ sourceId: item.resolution!.sourceId, pluginName })),
            }))
          : []),
        sourceErrors: catalog.sources.flatMap((item) => item.error
          ? [{ sourceId: item.sourceId, code: 'dependencyGraphInvalid' }]
          : []),
      }),
    });
  const nodes = new Map(graph.nodes.map((node) => [node.pluginId, node]));
  const summaryById = new Map(options.status.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  const displayName = (pluginId: string): string => nodes.get(pluginId)?.displayName
    ?? parsePluginId(pluginId).pluginName;
  const reverse = new Map<string, string[]>();
  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) {
      reverse.set(dependency, [...(reverse.get(dependency) ?? []), node.pluginId]);
    }
  }
  const targetsByPlugin = new Map<string, StatusScopedTarget[]>();
  for (const target of flattenStatusTargets(options.status.payload.targets)) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const unsupportedPluginIds = new Set(options.status.pluginSummaries
    .filter((summary) => (summary.missingCapabilities?.length ?? 0) > 0)
    .map((summary) => summary.pluginId));
  const availableReferencesFor = (
    consumerPluginId: string,
    dependencyPluginId: string,
  ): PluginDependencyOverviewViewModel['dependencies'][number]['availablePlacementReferences'] => {
    const consumerSourceId = parsePluginId(consumerPluginId).sourceId;
    const dependencySourceId = parsePluginId(dependencyPluginId).sourceId;
    const consumerNode = nodes.get(consumerPluginId);
    const dependencyNode = nodes.get(dependencyPluginId);
    if (consumerSourceId !== dependencySourceId
      || !nodes.get(consumerPluginId)?.dependencies.includes(dependencyPluginId)) return [];
    return (targetsByPlugin.get(consumerPluginId) ?? []).flatMap((consumer) => {
      if (!hasActualScopeEvidence(consumer)
        || consumer.sourceId !== consumerSourceId
        || consumer.sourceIdentity !== consumerNode?.sourceIdentity) return [];
      return [...consumer.components, ...(consumer.sharedComponents ?? [])].flatMap((component) => {
        if (component.kind !== 'dependency'
          || component.key !== dependencyPluginId
          || component.state !== 'ready') return [];
        const platform = component.metadata?.platform;
        const scope = component.metadata?.scope;
        const project = component.metadata?.project;
        if ((platform !== 'codex' && platform !== 'claude')
          || (scope !== 'user' && scope !== 'project')
          || project !== (scope === 'project' ? 'current' : 'none')) return [];
        const dependency = (targetsByPlugin.get(dependencyPluginId) ?? []).find((target) =>
          target.platform === platform
          && target.scope === scope
          && target.sourceId === dependencySourceId
          && target.sourceIdentity === dependencyNode?.sourceIdentity
          && target.sourceIdentity === consumer.sourceIdentity);
        if (!dependency) return [];
        return [{
          consumer: {
            pluginId: consumerPluginId,
            platform: consumer.platform,
            scope: consumer.scope,
            project: consumer.scope === 'project' ? 'current' : null,
          },
          dependency: {
            pluginId: dependencyPluginId,
            platform,
            scope,
            project: scope === 'project' ? 'current' : null,
          },
        }];
      });
    });
  };
  const placementsFor = (pluginId: string): PlatformPlacementSummary[] => {
    const targets = targetsByPlugin.get(pluginId) ?? [];
    if (targets.length > 0) {
      return (['codex', 'claude'] as const).flatMap((platform) => {
        const selected = targets.filter((target) => target.platform === platform);
        return selected.length > 0 ? [projectPlatformPlacement(platform, selected)] : [];
      });
    }
    return [];
  };
  const aggregateFor = (pluginId: string, placements: PlatformPlacementSummary[]) => {
    const sourceId = parsePluginId(pluginId).sourceId;
    if (graph.sourceErrors.some((error) => error.sourceId === sourceId)
      || unsupportedPluginIds.has(pluginId)) return 'unavailable' as const;
    if (placements.length === 0 || placements.every((placement) => placement.state === 'notInstalled')) {
      return 'notInstalled' as const;
    }
    return placements.some((placement) => placement.state === 'scopeConflict'
      || (placement.state === 'installed'
        && (placement.health !== 'ready' || placement.blockingReason !== undefined)))
      ? 'needsAttention' as const
      : 'ready' as const;
  };
  const allPluginIds = new Set([
    ...nodes.keys(),
    ...reverse.keys(),
    ...targetsByPlugin.keys(),
  ]);
  return [...allPluginIds].sort().map((pluginId): PluginDependencyOverviewViewModel => {
    const dependencies: Array<{ pluginId: string; depth: number; requiredBy: string[] }> = [];
    const seen = new Set([pluginId]);
    let frontier = [pluginId];
    let depth = 0;
    let graphInvalid = false;
    while (frontier.length > 0) {
      depth += 1;
      const next: string[] = [];
      const requiredBy = new Map<string, Set<string>>();
      for (const parent of frontier) {
        for (const dependency of nodes.get(parent)?.dependencies ?? []) {
          const parents = requiredBy.get(dependency) ?? new Set<string>();
          parents.add(parent);
          requiredBy.set(dependency, parents);
          if (seen.has(dependency)) {
            if (dependency === pluginId) graphInvalid = true;
            continue;
          }
          seen.add(dependency);
          next.push(dependency);
        }
      }
      for (const dependency of next) {
        dependencies.push({ pluginId: dependency, depth, requiredBy: [...(requiredBy.get(dependency) ?? [])] });
      }
      frontier = next;
    }
    const dependencyItems = dependencies.map((dependency) => {
      const placements = placementsFor(dependency.pluginId);
      return {
        pluginId: dependency.pluginId,
        displayName: displayName(dependency.pluginId),
        relation: dependency.depth === 1 ? 'direct' as const : 'transitive' as const,
        depth: dependency.depth,
        requiredBy: dependency.requiredBy.map((requiredBy) => ({
          pluginId: requiredBy,
          displayName: displayName(requiredBy),
        })),
        placements,
        aggregateStatus: aggregateFor(dependency.pluginId, placements),
        placementReferences: [],
        availablePlacementReferences: availableReferencesFor(pluginId, dependency.pluginId),
      };
    });
    const dependentIds = [...new Set(reverse.get(pluginId) ?? [])].sort();
    const dependents = dependentIds.map((dependentId) => {
      const placements = placementsFor(dependentId);
      return {
        pluginId: dependentId,
        displayName: displayName(dependentId),
        relation: 'dependent' as const,
        depth: 1,
        requiredBy: [],
        placements,
        aggregateStatus: aggregateFor(dependentId, placements),
        placementReferences: [],
        availablePlacementReferences: availableReferencesFor(dependentId, pluginId),
      };
    });
    const targetBlockers = (targetsByPlugin.get(pluginId) ?? []).flatMap((target) =>
      target.reasons.filter((error) => error.code.startsWith('dependency') || error.code === 'sourceChanged')
        .map((error) => ({
          code: error.code,
          title: '依赖关系需要处理',
          explanation: '当前目标的依赖证据不能安全通过检查。',
        })));
    const consumerTargets = summaryById.get(pluginId)?.supportedTargets;
    const unsupportedDependency = dependencyItems.find((dependency) => {
      const dependencyTargets = summaryById.get(dependency.pluginId)?.supportedTargets;
      if (!consumerTargets || !dependencyTargets) return true;
      return (['codex', 'claude'] as const).some((platform) =>
        consumerTargets[platform].length > 0 && dependencyTargets[platform].length === 0);
    });
    const sourceId = parsePluginId(pluginId).sourceId;
    const blockers = [
      ...graph.sourceErrors.filter((error) => error.sourceId === sourceId).map((error) => ({
        code: error.code,
        title: '来源依赖关系不可用',
        explanation: '当前来源快照不能安全读取。反向安装记录仍可显示。',
      })),
      ...(graphInvalid ? [{
        code: 'dependencyGraphInvalid',
        title: '依赖关系无效',
        explanation: '依赖关系形成环。',
      }] : []),
      ...(unsupportedDependency ? [{
        code: 'dependencyTargetUnsupported',
        title: '依赖目标不兼容',
        explanation: `${unsupportedDependency.displayName} 不支持根插件所需的平台。`,
      }] : []),
      ...targetBlockers,
    ];
    const directCount = dependencyItems.filter((item) => item.relation === 'direct').length;
    const readyCount = dependencyItems.filter((item) => item.aggregateStatus === 'ready').length;
    const missingCount = dependencyItems.filter((item) => item.aggregateStatus === 'notInstalled').length;
    const issueCount = dependencyItems.length - readyCount - missingCount + blockers.length;
    return {
      pluginId,
      summary: {
        directCount,
        transitiveCount: dependencyItems.length - directCount,
        totalCount: dependencyItems.length,
        readyCount,
        missingCount,
        issueCount,
      },
      dependencies: dependencyItems,
      dependents,
      blockers,
    };
  });
}

function createReviewStageReporter(options: {
  context: CliExecutionContext;
  onStage: (stage: ReviewPreparationStageId) => void | Promise<void>;
  now: () => number;
}): {
  emit: (stage: ReviewPreparationStageId) => Promise<void>;
  finish: () => Promise<void>;
} {
  let active: { stage: ReviewPreparationStageId; startedAt: number } | undefined;
  const finish = async (): Promise<void> => {
    if (!active) return;
    const completed = active;
    active = undefined;
    await Promise.allSettled([Promise.resolve().then(() => options.context.debugLogger.log({
      type: `review.prepare.${completed.stage}`,
      level: 'debug',
      target: 'debugLog',
      message: 'TUI review preparation stage completed.',
      data: { durationMs: Math.max(0, options.now() - completed.startedAt) },
    }))]);
  };
  return {
    async emit(stage) {
      await finish();
      active = { stage, startedAt: options.now() };
      await options.onStage(stage);
    },
    finish,
  };
}

export function createTuiControllerDependencies(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
  options: {
    now?: () => number;
    inventoryCatalogSourceReferences?: typeof inventoryCatalogSourceReferences;
    catalogGenerationRuntime?: CatalogGenerationServiceRuntime;
  } = {},
): TuiControllerDependencies {
  const readInventory = options.inventoryCatalogSourceReferences
    ?? inventoryCatalogSourceReferences;
  const validatedStoreEntries = new Map<string, CatalogStoreEntry>();
  const validatingStoreEntries = new Map<
    string,
    Promise<CatalogStoreEntry>
  >();
  const loadCatalogGenerations = async () => {
    const generations = await loadCatalogGenerationViewModels({
      env: context.env,
      validatedStoreEntries,
      validatingStoreEntries,
      onStage: (event) => context.debugLogger.log({
        type: 'performance:stage',
        level: 'debug',
        target: 'debugLog',
        message: 'Catalog generation load stage completed.',
        data: event,
      }),
    });
    const retained = new Set(generations.flatMap((source) => [
      source.active?.storeKey,
    ].filter((value): value is string => value !== undefined)));
    for (const storeKey of validatedStoreEntries.keys()) {
      if (!retained.has(storeKey)) validatedStoreEntries.delete(storeKey);
    }
    return generations;
  };
  const createOperationInventoryReader = (): typeof inventoryCatalogSourceReferences => {
    let ordinaryInventory: ReturnType<typeof inventoryCatalogSourceReferences> | undefined;
    return (inventoryOptions) => {
      ordinaryInventory ??= readInventory(inventoryOptions);
      return ordinaryInventory;
    };
  };
  const catalogOperationByEvidence = new WeakMap<OperationEvidence, CatalogOperationContext>();
  let sessionCatalogOperationContext: CatalogOperationContext | undefined;
  let sessionStatusResult: Awaited<ReturnType<typeof statusCommandV8>> | undefined;
  const sessionContextForPlugin = (pluginId: string): CatalogOperationContext | undefined => {
    const sourceId = parsePluginId(pluginId).sourceId;
    if (!sourceId || !sessionCatalogOperationContext) return undefined;
    return selectCatalogOperationContext(sessionCatalogOperationContext, [sourceId]);
  };
  const readConfigStoresForTui = async (config: {
    sourceId?: string;
    sourceIdentity?: string;
    logicalIdentity?: string;
    pluginName: string;
    schema: PluginConfigSchema['fields'];
    platform?: PlatformTarget;
    signal: AbortSignal;
  }) => {
    const user = await readPluginConfigStore({
      sourceId: config.sourceId,
      sourceIdentity: config.sourceIdentity,
      logicalIdentity: config.logicalIdentity,
      pluginName: config.pluginName,
      scope: 'user',
      platform: config.platform,
      cwd: context.cwd,
      env: context.env,
      schema: config.schema,
    });
    config.signal.throwIfAborted();
    if (user.state === 'invalid') throw new TuiConfigInvalidStoreError([{
      scope: 'user', code: user.invalidCode!,
      pathSummary: `AW_HOME/plugin-config/${config.sourceId ?? '<source>'}/${config.pluginName}/config.json`,
    }]);
    return { user };
  };
  const assertConfigEditEvidence = async (intent: ConfigSaveIntent, evidence: OperationEvidence): Promise<void> => {
    if (!intent.editEvidence) return;
    if (!evidence.source || !evidence.config) throw operationReviewStale('设置编辑缺少当前证据。');
    const currentDigest = await configLayerStoreDigest({ source: evidence.source,
      pluginName: parsePluginId(intent.pluginId).pluginName!, scope: 'user', platform: intent.platform,
      cwd: context.cwd, env: context.env });
    for (const expected of Object.values(intent.editEvidence)) {
      if (expected.sourceIdentity !== evidence.source.sourceIdentity
        || expected.schemaIdentity !== evidence.config.schemaIdentity
        || expected.platform !== intent.platform
        || (expected.context ?? 'user') !== (intent.context ?? 'user')
        || expected.storeDigests.user !== undefined && expected.storeDigests.user !== currentDigest) {
        throw operationReviewStale('编辑期间设置、来源或定义已变化。请重新打开设置。');
      }
    }
  };
  const loadStatus: TuiControllerDependencies['loadStatus'] = async (signal) => {
    signal.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const catalogOperationContext = sessionCatalogOperationContext
      ?? await resolvePartialCatalogOperationContext({
        env: context.env,
        signal,
        validatedStoreEntries,
        validatingStoreEntries,
      }).catch(async (error): Promise<CatalogOperationContext | undefined> => {
        if (!(error instanceof CatalogGenerationError)
          || error.code !== 'catalogGenerationStateInvalid') return undefined;
        const snapshot = await readCatalogSourcesConfigSnapshot(context.env);
        const primarySourceId = snapshot.config.sources.find((source) => source.primary)!.id;
        const generationSetDigest = calculateCatalogGenerationSetDigest(
          snapshot.digest,
          primarySourceId,
          [],
        );
        return {
          generationSet: {
            generationSetDigest,
            configDigest: snapshot.digest,
            primarySourceId,
            sources: [],
          },
          generationSetDigest,
          catalog: {
            sources: snapshot.config.sources.map((source) => ({
              sourceId: source.id,
              error,
            })),
            primarySourceId,
            configDigest: snapshot.digest,
            compositeDigest: generationSetDigest,
          },
        };
      });
    if (catalogOperationContext) sessionCatalogOperationContext = catalogOperationContext;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await statusCommandV8({
        cwd: context.cwd,
        env: context.env,
        nativeCliRunner: context.nativeCliRunner,
        cliVersion: packageInfo.version,
        verbose: context.diagnostics.verbose,
        ...(catalogOperationContext ? { catalogOperationContext } : {}),
        inventoryCatalogSourceReferences: readInventory,
      });
      signal.throwIfAborted();
      const configured = await listCatalogSources({ env: context.env });
      signal.throwIfAborted();
      if (result.payload.catalog.configDigest !== configured.configDigest) continue;
      sessionStatusResult = result;
      const dependencyOverviews = await loadDependencyOverviews({
        context,
        cliVersion: packageInfo.version,
        status: result,
        signal,
        ...(catalogOperationContext ? { catalogOperationContext } : {}),
      });
      const portablePluginIds = await loadPortablePluginIds({
        context,
        cliVersion: packageInfo.version,
        signal,
        ...(catalogOperationContext ? { catalogOperationContext } : {}),
      });
      signal.throwIfAborted();
      const catalogGenerations = await loadCatalogGenerations();
      signal.throwIfAborted();
      const configStoreInventory = (await Promise.all((['user'] as const).map(async (scope) => {
        try {
          return (await listNamespacedPluginConfigStoreIdentities({
            cwd: context.cwd,
            env: context.env,
            scope,
          })).map(({ pluginId, sourceId, pluginName }) => ({
            pluginId, sourceId, pluginName, scope,
          }));
        } catch {
          await context.debugLogger.log({
            type: 'tui:config-inventory-error',
            level: 'debug',
            target: 'debugLog',
            message: 'TUI saved config inventory could not be read.',
            data: { scope },
          });
          return [];
        }
      }))).flat();
      signal.throwIfAborted();
      const statusById = new Map(result.payload.catalog.sources.map((source) => [source.id, source]));
      return {
        cliChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
        ...(result.projectRoot ? { projectRoot: result.projectRoot } : {}),
        configuredSources: structuredClone(configured.sources),
        payload: result.payload,
        pluginSummaries: result.pluginSummaries,
        targetRevisions: result.targetRevisions,
        dependencyOverviews,
        portablePluginIds,
        configStoreInventory,
        catalogGenerations,
        sessionGenerationKeys: Object.fromEntries(
          (catalogOperationContext?.generationSet.sources ?? [])
            .map((source) => [source.sourceId, source.storeKey]),
        ),
        sourceDetails: configured.sources.map((source) => {
          const status = statusById.get(source.id);
          return {
            id: source.id,
            type: source.type,
            primary: source.primary,
            autoCheck: source.autoCheck,
            locationSummary: projectCatalogSourceLocation(
              source.type === 'git' ? source.url : source.path,
            ),
            ...(source.type === 'git' ? {
              refPolicy: source.refPolicy.type,
              ...(source.refPolicy.type === 'explicit' ? { explicitRef: source.refPolicy.ref } : {}),
              ...(source.subdir ? { subdir: source.subdir } : {}),
            } : {}),
            pluginCount: 0,
            sourceIdentity: source.sourceIdentity,
            requestedRef: status?.requestedRef ?? (source.type === 'path' ? 'path' : 'AW channel'),
            ...(status?.resolvedCommit ? { resolvedCommit: status.resolvedCommit } : {}),
            ...(status?.catalogVersion ? { catalogVersion: status.catalogVersion } : {}),
            ...(status?.channel ? { channel: status.channel } : {}),
            ...(status?.freshness ? { freshness: status.freshness } : {}),
            ...(status?.errorCode ? { errorCode: status.errorCode } : {}),
            configDigest: configured.configDigest,
          };
        }),
      };
    }
    throw new TuiOperationBlockedError(
      'operationReviewStale',
      '状态读取期间来源配置持续变化。请重试。',
    );
  };

  const loadPluginContent = async (
    pluginId: string,
    signal: AbortSignal,
  ): Promise<PluginContentOverview> => {
    signal.throwIfAborted();
    try {
      const packageInfo = await readCliPackageInfo();
      const catalogOperation = sessionContextForPlugin(pluginId);
      return await withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        env: context.env,
        signal,
        ...(catalogOperation ? { operationContext: catalogOperation } : {}),
        consume: ({ plugin, source }) => projectPluginContentOverview({
          pluginId,
          catalogVersion: source.manifest.catalogVersion,
          plugin,
        }),
      });
    } catch {
      signal.throwIfAborted();
      const summary = sessionStatusResult?.pluginSummaries.find((entry) => entry.pluginId === pluginId);
      let sourceId: string | undefined;
      try {
        sourceId = parsePluginId(pluginId).sourceId;
      } catch {
        // The fixed unavailable result below does not repeat an unsafe selector.
      }
      const catalogVersion = sessionStatusResult?.payload.catalog.sources
        .find((source) => source.id === sourceId)?.catalogVersion;
      return {
        pluginId,
        pluginVersion: summary?.version ?? '待确认',
        catalogVersion: catalogVersion ?? '待确认',
        evidence: 'unavailable',
        items: [],
        notices: ['当前无法安全读取这个插件的目录内容。请检查来源状态后重试。'],
        coverage: 'unavailable',
        coverageIssue: {
          code: 'unreadable',
          message: '当前无法安全读取这个插件的目录内容。请检查来源状态后重试。',
        },
      };
    }
  };

  const captureEvidence = async (
    intent: OperationIntent,
    signal?: AbortSignal,
    preparation?: {
      reporter: ReturnType<typeof createReviewStageReporter>;
      validateIntent: boolean;
    },
    operationInventory = createOperationInventoryReader(),
    freshCatalog = false,
    reusableCandidate?: CatalogSessionReusableCandidate,
  ): Promise<OperationEvidence> => {
    if (intent.kind === 'pluginWrite' || intent.kind === 'pluginWriteBatch'
      || intent.kind === 'pluginWriteTask') {
      throw new TuiOperationBlockedError('useScopedRecovery', '请使用统一范围恢复任务。');
    }
    reviewedScriptTimeoutMs(intent);
    if ((intent.kind === 'configSave' || intent.kind === 'configSaveBatch' || intent.kind === 'configReset')
      && intent.context === 'project') {
      await resolveWorkContext({ cwd: context.cwd, context: 'project' });
      signal?.throwIfAborted();
    }
    if (intent.kind === 'catalogStorePrune') {
      signal?.throwIfAborted();
      const config = await readCatalogSourcesConfigSnapshot(context.env);
      const catalogStore = await prepareCatalogStoreTask({ env: context.env });
      signal?.throwIfAborted();
      return {
        catalog: { configDigest: config.digest, compositeDigest: config.digest },
        catalogStore,
      };
    }
    if (intent.kind === 'configSaveBatch') {
      assertConfigSaveBatchIntent(intent);
      const groupEvidence: Array<{
        scope: 'user';
        platform?: PlatformTarget;
        config: NonNullable<OperationEvidence['config']>;
        targetFingerprint: string;
      }> = [];
      let batchBase: OperationEvidence | undefined;
      let batchCatalogOperation: CatalogOperationContext | undefined;
      for (const group of intent.groups) {
        const current = await captureEvidence(
          configSaveBatchGroupIntent(intent, group),
          signal,
          preparation,
          operationInventory,
          freshCatalog,
          reusableCandidate,
        );
        if (!current.config || !current.source || !current.targetFingerprint) {
          throw operationReviewStale('设置批次缺少单层证据。');
        }
        if (batchBase && (JSON.stringify(batchBase.catalog) !== JSON.stringify(current.catalog)
          || JSON.stringify(batchBase.source) !== JSON.stringify(current.source))) {
          throw operationReviewStale('准备设置批次期间 Catalog 或来源发生变化。');
        }
        for (const expected of Object.values(group.editEvidence ?? {})) {
          if (expected.sourceIdentity !== current.source.sourceIdentity
            || expected.schemaIdentity !== current.config.schemaIdentity
            || expected.platform !== group.platform
            || (expected.context ?? 'user') !== (intent.context ?? 'user')) {
            throw operationReviewStale('编辑期间插件来源或设置定义已变化，请重新打开列表。');
          }
          for (const scope of ['user'] as const) {
            if (expected.storeDigests[scope] === undefined) continue;
            const currentDigest = await configLayerStoreDigest({
              source: current.source, pluginName: parsePluginId(intent.pluginId).pluginName!,
              scope, cwd: context.cwd, env: context.env,
            });
            if (expected.storeDigests[scope] !== currentDigest) {
              throw operationReviewStale('编辑期间设置已被外部修改，请重新打开列表。');
            }
          }
        }
        batchBase ??= current;
        batchCatalogOperation ??= catalogOperationByEvidence.get(current);
        groupEvidence.push({
          scope: 'user',
          platform: group.platform,
          config: {
            ...current.config,
            storeDigest: await configLayerStoreDigest({
              source: current.source,
              pluginName: parsePluginId(intent.pluginId).pluginName!,
              scope: 'user',
              platform: group.platform,
              profileOnly: true,
              cwd: context.cwd,
              env: context.env,
            }),
          },
          targetFingerprint: current.targetFingerprint,
        });
      }
      const evidence: OperationEvidence = {
        catalog: batchBase!.catalog,
        source: batchBase!.source,
        configBatch: { groups: groupEvidence },
      };
      if (batchCatalogOperation) catalogOperationByEvidence.set(evidence, batchCatalogOperation);
      return evidence;
    }
    if (intent.kind === 'configReset') {
      const parsed = parsePluginId(intent.pluginId);
      if (!parsed.sourceId || !parsed.pluginName) {
        throw new TuiOperationBlockedError('invalidPluginId', '设置目标必须使用 canonical pluginId。');
      }
      await preparation?.reporter.emit('config');
      const target = await inspectPluginConfigResetTarget({
        sourceId: parsed.sourceId,
        pluginName: parsed.pluginName,
        scope: 'user',
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      if (target.kind === 'special') {
        throw new TuiOperationBlockedError(
          'configResetTargetUnsupported',
          '设置目标是特殊文件系统节点，不能自动重置。请手动移动后重试。',
        );
      }
      const relevantTargets = sessionStatusResult
        ? configAffectedStatusTargets(
            sessionStatusResult.payload.targets,
            intent.pluginId,
            intent.context ?? 'user',
            [], intent.platform,
          )
        : [];
      const relevantRevisions = (sessionStatusResult?.targetRevisions ?? []).filter((revision) =>
        relevantTargets.some((statusTarget) => statusTarget.platform === revision.platform
          && statusTarget.scope === revision.scope
          && statusTarget.pluginId === revision.pluginId));
      let selected: {
        source: OperationSourceEvidence;
        impact: Awaited<ReturnType<typeof analyzePluginConfigMutationImpact>>;
      } | undefined;
      try {
        const packageInfo = await readCliPackageInfo();
        selected = await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          env: context.env,
          ...(preparation && sessionContextForPlugin(intent.pluginId)
            ? { operationContext: sessionContextForPlugin(intent.pluginId)! }
            : {}),
          ...(signal ? { signal } : {}),
          consume: async ({ plugin, source: resolvedSource }) => ({
            source: sourceEvidenceForPlugin(resolvedSource, plugin.manifest.name),
            impact: await analyzePluginConfigMutationImpact({
              plugin,
              scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
              cwd: context.cwd,
              env: context.env,
              visibleTargets: configImpactVisibleTargets(plugin.manifest.name, relevantTargets),
              mutation: { kind: 'reset' },
            }),
          }),
        });
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'configValidationMemoryExhausted') throw error;
        selected = undefined;
      }
      signal?.throwIfAborted();
      await preparation?.reporter.emit('evidence');
      return {
        catalog: sessionStatusResult ? {
          configDigest: sessionStatusResult.payload.catalog.configDigest,
          compositeDigest: sessionStatusResult.payload.catalog.compositeDigest,
        } : {
          configDigest: 'config-reset-offline',
          compositeDigest: 'config-reset-target',
        },
        ...(selected ? { source: selected.source } : {}),
        ...(sessionStatusResult ? {
          targetFingerprint: statusTargetFingerprint(relevantTargets, relevantRevisions),
        } : {}),
        config: {
          scope: 'user', platform: intent.platform, context: intent.context ?? 'user',
          storeDigest: selected?.impact.storeDigest ?? target.fingerprint,
          impactState: selected?.impact.impactState ?? 'unknown',
          ...(selected?.impact.noEffectiveChange ? { noEffectiveChange: true as const } : {}),
          ...(selected?.impact.affectedCommandPackages.length
            ? { commandPackages: selected.impact.affectedCommandPackages } : {}),
          affectedTargets: (selected?.impact.affectedTargets
            ?? relevantTargets).map(({ platform, scope }) => ({ platform, scope })),
          ...((selected?.impact.sharedNativeRenderTargets.length ?? 0) > 0
            ? { sharedNativeRenderTargets: selected!.impact.sharedNativeRenderTargets }
            : {}),
        },
        resetTarget: {
          sourceId: parsed.sourceId,
          pluginName: parsed.pluginName,
          scope: 'user', platform: intent.platform, context: intent.context ?? 'user',
          kind: target.kind,
          fingerprint: target.fingerprint,
        },
      };
    }
    if (intent.kind === 'catalogSourcesRecovery') {
      signal?.throwIfAborted();
      await preparation?.reporter.emit('validate');
      await preparation?.reporter.emit('evidence');
      return {
        catalog: {
          configDigest: 'invalid-catalog-sources-config',
          compositeDigest: 'bootstrap-recovery',
        },
      };
    }
    if (intent.kind === 'catalogGeneration') {
      signal?.throwIfAborted();
      await preparation?.reporter.emit('validate');
      const packageInfo = await readCliPackageInfo();
      const config = await readCatalogSourcesConfigSnapshot(context.env);
      const configuredSource = config.config.sources.find((source) => source.id === intent.sourceId);
      let proposedSource: import('../types.js').CatalogSource | undefined;
      let proposedConfigDigest: string | undefined;
      let explicitSourceChange = false;
      let sourceIdentityChangeImpact: import('../types.js').CatalogSourceImpact | undefined;
      if (intent.sourceMutation) {
        const preview = await preflightCatalogSourceMutation({
          request: intent.sourceMutation.action === 'add'
            ? intent.sourceMutation
            : { action: 'update', sourceId: intent.sourceId, update: intent.sourceMutation.update },
          cwd: context.cwd,
          env: context.env,
        });
        proposedSource = preview.proposedSource;
        proposedConfigDigest = preview.proposedConfigDigest;
        if (preview.configDigest !== config.digest) {
          throw operationReviewStale('准备 Catalog 候选期间来源配置发生变化。');
        }
        const sourceFingerprintChanged = Boolean(proposedSource && (!configuredSource
          || calculateCatalogSourceConfigFingerprint(proposedSource)
            !== calculateCatalogSourceConfigFingerprint(configuredSource)));
        explicitSourceChange = preview.proposedConfigDigest !== preview.configDigest
          && (preview.identityChanged || sourceFingerprintChanged);
        if (preview.identityChanged) sourceIdentityChangeImpact = {
          impactSchemaVersion: 3,
          sourceId: preview.sourceId,
          primaryChange: preview.references.primaryChange,
          inventoryComplete: preview.references.inventoryComplete,
          references: preview.references.references,
          affectedReferences: preview.references.references,
          changes: {
            added: [], removed: [], changed: [], newlyIncompatible: [],
            dependencyChanged: [], platformSupportChanged: [],
          },
          errors: preview.references.errors,
        };
        if (!explicitSourceChange) {
          throw new TuiOperationBlockedError('sourceNoChanges', '来源没有变化。');
        }
      }
      let previousActive: import('../types.js').CatalogGenerationActiveV1 | undefined;
      let healthyActive: Awaited<ReturnType<typeof resolveActiveCatalogGeneration>> | undefined;
      let previousActiveVersion: string | undefined;
      let previousStoreReady = false;
      try {
        previousActive = (await readCatalogGenerationState(context.env))
          .sources[intent.sourceId]?.active;
      } catch (error) {
        if (intent.action !== 'recoverState'
          || !(error instanceof CatalogGenerationError)
          || error.code !== 'catalogGenerationStateInvalid') throw error;
      }
      const activeStoreKey = previousActive
        ? createCatalogStoreKey(previousActive.logicalIdentity, previousActive.snapshotDigest)
        : null;
      const configuredFingerprint = configuredSource
        ? calculateCatalogSourceConfigFingerprint(configuredSource)
        : undefined;
      const canReuseCandidate = Boolean(
        reusableCandidate
        && !intent.sourceMutation
        && (intent.action === 'activate' || intent.action === 'update')
        && configuredFingerprint
        && reusableCandidate.sourceId === intent.sourceId
        && reusableCandidate.sourceConfigFingerprint === configuredFingerprint
        && reusableCandidate.probe.candidate.sourceConfigFingerprint === configuredFingerprint
        && reusableCandidate.activeStoreKey === activeStoreKey
        && reusableCandidate.probe.sourceId === intent.sourceId
        && reusableCandidateEvidenceIsComplete(reusableCandidate),
      );
      const probe = intent.action === 'repair'
        ? await probeCatalogSourceRepairGeneration({
            sourceId: intent.sourceId,
            cliVersion: packageInfo.version,
            ...(previousActive ? { expectedActive: previousActive } : {}),
            expectedConfigDigest: config.digest,
            env: context.env,
            signal,
            runtime: options.catalogGenerationRuntime,
          })
        : canReuseCandidate
          ? structuredClone(reusableCandidate!.probe)
        : await probeCatalogSourceGeneration({
            sourceId: intent.sourceId,
            ...(proposedSource ? { source: proposedSource } : {}),
            cliVersion: packageInfo.version,
            env: context.env,
            signal,
            runtime: options.catalogGenerationRuntime,
          });
      signal?.throwIfAborted();
      await preparation?.reporter.emit('evidence');
      if (intent.action === 'activate' || intent.action === 'update') {
        try {
          healthyActive = await resolveActiveCatalogGeneration({ sourceId: intent.sourceId, env: context.env });
        } catch (error) {
          if (!(error instanceof CatalogGenerationError)
            && !(error instanceof CatalogProviderCompatibilityError)) throw error;
        }
      }
      const comparisonSource = proposedSource
        ?? configuredSource;
      if (previousActive) {
        const store = await readCatalogStoreEntry({
          logicalIdentity: previousActive.logicalIdentity,
          snapshotDigest: previousActive.snapshotDigest,
          env: context.env,
        }).catch(() => undefined);
        previousStoreReady = Boolean(store);
        previousActiveVersion = healthyActive?.catalogVersion
          ?? store?.metadata.catalogVersion;
      }
      if (intent.action === 'update' && !intent.sourceMutation && previousActive && comparisonSource) {
        explicitSourceChange = previousActive.sourceConfigFingerprint
            !== calculateCatalogSourceConfigFingerprint(comparisonSource)
          || previousActive.sourceIdentity !== await calculateCatalogSourceIdentity(comparisonSource);
      }
      const comparisonActive = healthyActive
        ? {
            logicalIdentity: healthyActive.logicalIdentity,
            catalogVersion: healthyActive.catalogVersion,
            snapshotDigest: healthyActive.snapshotDigest,
            resolvedCommit: healthyActive.resolvedCommit,
          }
        : previousActive && previousActiveVersion
          ? {
              logicalIdentity: previousActive.logicalIdentity,
              catalogVersion: previousActiveVersion,
              snapshotDigest: previousActive.snapshotDigest,
              resolvedCommit: previousActive.resolvedCommit,
            }
          : undefined;
      const candidateRelation = comparisonActive && comparisonSource
        ? compareCatalogGenerationFreshness({
            sourceType: comparisonSource.type,
            active: comparisonActive,
            candidate: probe.candidate,
          }).state
        : undefined;
      const exactStoreTarget = Boolean(previousActive)
        && createCatalogStoreKey(previousActive!.logicalIdentity, previousActive!.snapshotDigest)
          === createCatalogStoreKey(probe.candidate.logicalIdentity, probe.candidate.snapshotDigest);
      if (intent.action === 'repair' && !exactStoreTarget) {
        throw new CatalogGenerationError({
          code: 'catalogReplaceDamagedRequired', sourceId: intent.sourceId,
          message: `Catalog source "${intent.sourceId}" cannot reproduce the damaged Active entry. Use the current candidate replacement Review.`,
        });
      }
      const exactRepair = (intent.action === 'repair' || intent.action === 'update')
        && exactStoreTarget && !previousStoreReady;
      if (previousActive && !previousStoreReady && !exactStoreTarget
        && !intent.sourceMutation && intent.action !== 'replaceDamaged') {
        throw new CatalogGenerationError({
          code: 'catalogReplaceDamagedRequired',
          sourceId: intent.sourceId,
          message: `Catalog source "${intent.sourceId}" has a damaged Active entry whose version cannot be compared safely. The current Active remains unchanged. Edit the source explicitly, or remove and add it again.`,
        });
      }
      if (intent.action !== 'replaceDamaged' && !explicitSourceChange && candidateRelation === 'incompatible') {
        throw new CatalogGenerationError({
          code: 'catalogLogicalIdentityChanged', sourceId: intent.sourceId,
          message: `Catalog source "${intent.sourceId}" changed logical identity. Edit or remove and re-add the source.`,
        });
      }
      if (intent.action !== 'replaceDamaged' && !explicitSourceChange && candidateRelation === 'versionConflict') {
        throw new TuiOperationBlockedError(
          'catalogVersionConflict',
          '候选 Catalog 与当前 Active 版本相同，但内容摘要不同。普通更新已阻止。',
        );
      }
      if (intent.action !== 'replaceDamaged' && !explicitSourceChange && candidateRelation === 'rollbackDetected') {
        throw new TuiOperationBlockedError(
          'catalogRollbackDetected',
          '候选 Catalog 版本低于当前 Active。普通更新已阻止。',
        );
      }
      const impact = exactRepair ? undefined
        : sourceIdentityChangeImpact ?? await inspectCatalogSourceImpact({
          sourceId: intent.sourceId,
          cwd: context.cwd,
          env: context.env,
          sourcePrimary: comparisonSource?.primary === true,
          mode: 'generation',
          candidateManifest: probe.manifest,
        });
      const primaryPreview = intent.setPrimaryAfterActivation
        ? await preflightCatalogSourceMutation({
            request: { action: 'setPrimary', sourceId: intent.sourceId },
            cwd: context.cwd,
            env: context.env,
          })
        : undefined;
      if (primaryPreview && primaryPreview.configDigest !== config.digest) {
        throw operationReviewStale('准备主来源切换期间来源配置发生变化。');
      }
      const primaryImpact = primaryPreview ? {
        impactSchemaVersion: 3 as const,
        sourceId: primaryPreview.sourceId,
        primaryChange: primaryPreview.references.primaryChange,
        inventoryComplete: primaryPreview.references.inventoryComplete,
        references: primaryPreview.references.references,
        affectedReferences: primaryPreview.references.references,
        changes: {
          added: [], removed: [], changed: [], newlyIncompatible: [],
          dependencyChanged: [], platformSupportChanged: [],
        },
        errors: primaryPreview.references.errors,
      } : undefined;
      return {
        catalog: {
          configDigest: config.digest,
          compositeDigest: probe.candidate.snapshotDigest,
        },
        catalogGeneration: {
          action: intent.action,
          ...(previousActive ? { previousActive } : {}),
          ...(previousActiveVersion ? { previousActiveVersion } : {}),
          candidate: probe.candidate,
          ...(candidateRelation ? { candidateRelation } : {}),
          ...(explicitSourceChange ? { explicitSourceChange: true } : {}),
          ...(exactRepair ? { exactRepair: true } : {}),
          activationMode: intent.action === 'replaceDamaged' ? 'replaceDamaged'
            : explicitSourceChange ? 'explicitSourceChange' : 'normal',
          ...(impact ? {
            impact,
            impactDigest: calculateCatalogSourceImpactDigest(impact),
            impactMode: sourceIdentityChangeImpact ? 'identityChange' as const : 'generation' as const,
          } : {}),
          ...(primaryPreview && primaryImpact ? {
            primaryImpact,
            primaryImpactDigest: primaryPreview.impactDigest,
            primaryConfigDigest: primaryPreview.configDigest,
          } : {}),
          configDigest: config.digest,
          ...(proposedConfigDigest ? { proposedConfigDigest } : {}),
          ...(proposedSource ? { proposedSource } : {}),
          ...(intent.sourceMutation ? { sourceMutation: intent.sourceMutation } : {}),
          ...(intent.setPrimaryAfterActivation ? { setPrimaryAfterActivation: true } : {}),
        },
      };
    }
    if (intent.kind === 'sourceMutation') {
      signal?.throwIfAborted();
      if (intent.action === 'add' && !intent.source
        || intent.action === 'update' && !intent.update) {
        throw new TuiOperationBlockedError('invalidSourceMutation', '来源操作缺少候选输入。');
      }
      const request = intent.action === 'add'
        ? { action: 'add' as const, source: intent.source! }
        : intent.action === 'update'
          ? { action: 'update' as const, sourceId: intent.sourceId, update: intent.update! }
          : { action: intent.action, sourceId: intent.sourceId };
      await preparation?.reporter.emit('validate');
      const preview = await preflightCatalogSourceMutation({
        request,
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      await preparation?.reporter.emit('evidence');
      signal?.throwIfAborted();
      const evidence: OperationEvidence = {
        catalog: { configDigest: preview.configDigest, compositeDigest: preview.proposedConfigDigest },
        sourceWrite: {
          configDigest: preview.configDigest,
          proposedConfigDigest: preview.proposedConfigDigest,
          ...(preview.sourceIdentity ? { sourceIdentity: preview.sourceIdentity } : {}),
          inventoryDigest: digest({ references: preview.references.references, errors: preview.references.errors }),
          impactDigest: preview.impactDigest,
          referenceCount: preview.references.references.length,
          inventoryComplete: preview.references.inventoryComplete,
          impact: {
            impactSchemaVersion: 3,
            sourceId: preview.sourceId,
            primaryChange: preview.references.primaryChange,
            inventoryComplete: preview.references.inventoryComplete,
            references: preview.references.references,
            affectedReferences: preview.references.references,
            changes: {
              added: [], removed: [], changed: [], newlyIncompatible: [],
              dependencyChanged: [], platformSupportChanged: [],
            },
            errors: preview.references.errors,
          },
        },
      };
      if (preparation?.validateIntent
        && evidence.sourceWrite?.configDigest === evidence.sourceWrite?.proposedConfigDigest) {
        throw new TuiOperationBlockedError('sourceNoChanges', '来源没有变化。');
      }
      return evidence;
    }
    if (intent.kind !== 'configSave'
      && intent.kind !== 'portableInstall') {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    signal?.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    let catalogOperation: CatalogOperationContext | undefined;
    let catalogOperationError: unknown;
    if (intent.kind !== 'portableInstall') {
      try {
        const sourceIds = [parsePluginId(intent.pluginId).sourceId!];
        catalogOperation = !freshCatalog && sessionCatalogOperationContext
          ? selectCatalogOperationContext(sessionCatalogOperationContext, sourceIds)
          : await resolveCatalogOperationContext({
              sourceIds,
              env: context.env,
              ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
              ...(signal ? { signal } : {}),
            });
      } catch (error) {
        catalogOperationError = error;
      }
    }
    if (intent.kind === 'portableInstall') {
      await preparation?.reporter.emit('portable');
      if (intent.retry
        && (intent.retry.receipt.plugin.id !== intent.pluginId
          || intent.retry.receipt.scope !== intent.scope)) {
        throw operationReviewStale('Portable 重试结果与当前插件或范围不匹配。');
      }
      const portableSourceId = parsePluginId(intent.pluginId).sourceId!;
      const portableCatalogOperation = sessionCatalogOperationContext
        ? selectCatalogOperationContext(sessionCatalogOperationContext, [portableSourceId])
        : undefined;
      const portable = intent.retry
        ? await preparePortableRetry({
            receipt: intent.retry.receipt,
            cwd: context.cwd,
            env: context.env,
            cliVersion: packageInfo.version,
            signal,
            ...(portableCatalogOperation
              ? { catalogOperationContext: portableCatalogOperation }
              : {}),
          })
        : await preparePortableInstall({
            selector: intent.pluginId,
            scope: intent.scope,
            ...(intent.selectedSkills.length > 0 ? { requestedSkills: intent.selectedSkills } : {}),
            ...(intent.requestedAgents ? { requestedAgents: intent.requestedAgents } : {}),
            cwd: context.cwd,
            env: context.env,
            cliVersion: packageInfo.version,
            signal,
            ...(portableCatalogOperation
              ? { catalogOperationContext: portableCatalogOperation }
              : {}),
          });
      signal?.throwIfAborted();
      await preparation?.reporter.emit('evidence');
      signal?.throwIfAborted();
      const evidence: OperationEvidence = {
        catalog: {
          configDigest: portable.configDigest,
          compositeDigest: portable.evidenceDigest,
          ...(portable.generationSetDigest
            ? { generationSetDigest: portable.generationSetDigest }
            : {}),
        },
        portable,
      };
      if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    if (intent.kind === 'configSave' && intent.retryApply) {
      await preparation?.reporter.emit('config');
      if (!catalogOperation) throw catalogOperationError ?? operationReviewStale('无法取得设置应用所需的 Catalog。');
      const selectedCatalogOperation = catalogOperation;
      const evidence = await withResolvedCatalogPlugin({
        selector: intent.pluginId, cliVersion: packageInfo.version, env: context.env,
        ...(selectedCatalogOperation ? { operationContext: selectedCatalogOperation } : {}),
        ...(signal ? { signal } : {}),
        consume: async ({ plugin, source }): Promise<OperationEvidence> => {
          const referencePlugins = await resolvePluginConfigReferencePlugins({
            sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity, env: context.env,
            operationContext: selectedCatalogOperation,
          });
          const prepared = await preparePluginConfigApply({
            plugin, scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
            ...(intent.targets ? { targets: intent.targets } : {}),
            cwd: context.cwd, env: context.env, cliVersion: packageInfo.version,
            nativeCliRunner: context.nativeCliRunner,
            rebuildRuntime: {
              ...context,
              referencePlugins,
              ...(selectedCatalogOperation ? { catalogOperationContext: selectedCatalogOperation,
                expectedGenerationSetDigest: selectedCatalogOperation.generationSetDigest } : {}),
              ...(reviewedScriptTimeoutMs(intent) === undefined ? {} : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
            },
          });
          try {
            signal?.throwIfAborted();
            const targets = prepared.plan.receipt.requestedTargets
              .filter((target) => !prepared.plan.receipt.targetResults.some((result) =>
                result.pluginId === target.pluginId && result.agent === target.agent && result.scope === target.scope
                && (result.satisfaction === 'unsupported' || result.satisfaction === 'excluded')))
              .map((target) => ({
                pluginName: parsePluginId(target.pluginId).pluginName!, platform: target.agent, scope: target.scope,
              }));
            return {
              catalog: {
                configDigest: selectedCatalogOperation.catalog.configDigest,
                compositeDigest: selectedCatalogOperation.catalog.compositeDigest,
                ...(selectedCatalogOperation ? { generationSetDigest: selectedCatalogOperation.generationSetDigest } : {}),
              },
              source: sourceEvidenceForPlugin(source, plugin.manifest.name),
              config: {
                scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
                schemaIdentity: configSchemaIdentity(plugin, source.manifestDigest, intent.platform),
                storeDigest: digest(prepared.evidence),
                impactState: 'known', affectedTargets: targets,
                commandPackages: prepared.commandPackages,
                applyEvidence: prepared.evidence, applyChanges: prepared.plan.changes,
                applyWarnings: prepared.plan.warnings,
                applyBlockers: [...new Map([
                  ...prepared.plan.receipt.blockers, ...prepared.plan.receipt.errors,
                  ...prepared.plan.receipt.targetResults.flatMap((target) => target.blockers),
                ].map((item) => [`${item.code}\0${item.message}`, item])).values()],
                preApplyAuthorization: prepared.preApplyAuthorization,
                sharedNativeRenderTargets: await configRetrySharedNativeRenderTargets(plugin,
                  targets.filter((target): target is typeof target & { platform: PlatformName } => target.platform === 'codex' || target.platform === 'claude'), context.env, referencePlugins),
              },
            };
          } finally { await disposePluginConfigApply(prepared.plan); }
        },
      });
      if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    const needsReferencePlugins = intent.kind === 'configSave'
      && await withResolvedCatalogPlugin({
        selector: intent.pluginId, cliVersion: packageInfo.version, env: context.env,
        ...(catalogOperation ? { operationContext: catalogOperation } : {}),
        ...(signal ? { signal } : {}),
        consume: ({ plugin }) => configNeedsReferencePlugins(plugin),
      });
    const referencePlugins = needsReferencePlugins
      ? await resolvePluginConfigReferencePlugins({
          sourceId: parsePluginId(intent.pluginId).sourceId,
          env: context.env,
          operationContext: catalogOperation,
        })
      : undefined;
    const configReferencePluginIds = intent.kind === 'configSave' && needsReferencePlugins
      ? await withResolvedCatalogPlugin({
          selector: intent.pluginId, cliVersion: packageInfo.version, env: context.env,
          ...(catalogOperation ? { operationContext: catalogOperation } : {}),
          ...(signal ? { signal } : {}),
          consume: async ({ plugin }) => (await resolvePluginConfigReferenceConsumers({
            plugin, env: context.env, plugins: referencePlugins,
          })).map((entry) => entry.pluginId ?? `${entry.sourceId}/${entry.manifest.name}`),
        })
      : [];
    if (preparation && intent.kind === 'configSave') {
      if (!sessionStatusResult || !catalogOperation) {
        throw operationReviewStale('当前 TUI session 没有可复用的设置证据。');
      }
      await preparation.reporter.emit('config');
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      signal?.throwIfAborted();
      if (configSnapshot.digest !== sessionStatusResult.payload.catalog.configDigest) {
        throw operationReviewStale('准备设置确认期间来源配置发生变化。');
      }
      const relevantTargets = configAffectedStatusTargets(
        sessionStatusResult.payload.targets,
        intent.pluginId,
        intent.context ?? 'user',
        configReferencePluginIds,
        intent.platform,
      );
      const preparedCatalogOperation = catalogOperation;
      const selected = await withResolvedCatalogPlugin({
        selector: intent.pluginId,
        cliVersion: packageInfo.version,
        configSnapshot,
        env: context.env,
        operationContext: preparedCatalogOperation,
        ...(signal ? { signal } : {}),
        consume: async ({ plugin, source }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const definition = selectPluginConfigProfile(plugin.manifest.config, intent.platform);
          if (intent.kind === 'configSave') {
            await coercePluginConfigUpdates({
              schema: definition.fields,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!definition.fields[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          }
          const impact = intent.retryApply ? undefined : await analyzePluginConfigMutationImpact({
            plugin,
            referencePlugins,
            scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
            cwd: context.cwd,
            env: context.env,
            visibleTargets: configImpactVisibleTargets(plugin.manifest.name, relevantTargets),
            mutation: {
              kind: 'patch',
              updates: intent.updates,
              removeKeys: intent.removeKeys,
            },
          });
          const affectedTargets = intent.retryApply
            ? configImpactVisibleTargets(plugin.manifest.name, relevantTargets)
            : impact!.affectedTargets;
          const commandPackages = impact?.affectedCommandPackages
            ?? (await discoverPluginConfigManagedCommandPackages({ plugin, scope: intent.context ?? 'user',
              cwd: context.cwd, env: context.env ?? process.env, platformTargets: affectedTargets, referencePlugins })).packages;
          const preApplyAuthorization = configIntentRequestsApply(intent)
            ? (await resolveConfigPreApplyAuthorization({
                plugin,
                scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
                cwd: context.cwd,
                env: context.env,
                applyTargets: affectedTargets,
                nativeCliRunner: context.nativeCliRunner,
                rebuildRuntime: {
                  referencePlugins,
                  catalogOperationContext: preparedCatalogOperation,
                  expectedGenerationSetDigest: preparedCatalogOperation.generationSetDigest,
                  inventoryCatalogSourceReferences: operationInventory,
                },
              })).targets
            : [];
          return {
            pluginName: plugin.manifest.name,
            source: sourceEvidenceForPlugin(source, plugin.manifest.name),
            schemaIdentity: configSchemaIdentity(plugin, source.manifestDigest, intent.platform),
            impact,
            commandPackages,
            preApplyAuthorization,
            retryStoreDigest: intent.retryApply ? await configRetryStoreDigest({ plugin, scope: intent.context ?? 'user', platform: intent.platform,
              targets: affectedTargets, commandPackages, preApplyAuthorization, cwd: context.cwd, env: context.env, plugins: referencePlugins }) : undefined,
            sharedNativeRenderTargets: intent.retryApply
              ? await configRetrySharedNativeRenderTargets(plugin, affectedTargets, context.env, referencePlugins)
              : impact!.sharedNativeRenderTargets,
          };
        },
      });
      signal?.throwIfAborted();
      const relevantRevisions = (sessionStatusResult.targetRevisions ?? []).filter((revision) =>
        relevantTargets.some((target) => target.platform === revision.platform
          && target.scope === revision.scope
          && target.pluginId === revision.pluginId));
      await preparation.reporter.emit('evidence');
      const evidence: OperationEvidence = {
        catalog: {
          configDigest: sessionStatusResult.payload.catalog.configDigest,
          compositeDigest: preparedCatalogOperation.catalog.compositeDigest,
          ...(catalogOperation ? { generationSetDigest: catalogOperation.generationSetDigest } : {}),
        },
        ...(selected.source ? { source: selected.source } : {}),
        targetFingerprint: statusTargetFingerprint(relevantTargets, relevantRevisions),
        config: {
          scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
          schemaIdentity: selected.schemaIdentity,
          storeDigest: selected.impact?.storeDigest
            ?? selected.retryStoreDigest!,
          impactState: selected.impact?.impactState ?? 'known',
          ...(selected.impact?.noEffectiveChange ? { noEffectiveChange: true as const } : {}),
          ...(selected.commandPackages.length ? { commandPackages: selected.commandPackages } : {}),
          affectedTargets: (selected.impact?.affectedTargets
            ?? relevantTargets).map(({ pluginName, platform, scope }) => ({ pluginName, platform, scope })),
          ...(selected.preApplyAuthorization.length > 0
            ? { preApplyAuthorization: selected.preApplyAuthorization }
            : {}),
          ...(selected.sharedNativeRenderTargets.length > 0
            ? { sharedNativeRenderTargets: selected.sharedNativeRenderTargets }
            : {}),
        },
      };
      await assertConfigEditEvidence(intent, evidence);
      if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    await preparation?.reporter.emit('status');
    const statusCatalogOperation = catalogOperation
      ?? (!freshCatalog ? sessionCatalogOperationContext : undefined);
    const status = await statusCommandV8({
      plugins: [...new Set([intent.pluginId, ...configReferencePluginIds])],
      ...(intent.context === 'project' ? {} : { scope: 'user' }),
      cwd: context.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
      cliVersion: packageInfo.version,
      ...(statusCatalogOperation ? { catalogOperationContext: statusCatalogOperation } : {}),
      inventoryCatalogSourceReferences: operationInventory,
    });
    signal?.throwIfAborted();
    const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
    signal?.throwIfAborted();
    if (configSnapshot.digest !== status.payload.catalog.configDigest) {
      throw operationReviewStale('准备确认信息期间来源配置发生变化。');
    }
    if (catalogOperationError) throw catalogOperationError;
    if (!catalogOperation) {
      catalogOperation = await resolveCatalogOperationContext({
        sourceIds: [parsePluginId(intent.pluginId).sourceId!],
        configSnapshot,
        env: context.env,
        ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    await preparation?.reporter.emit('catalog');
    const configVisibleTargets = intent.kind === 'configSave'
      ? configAffectedStatusTargets(status.payload.targets, intent.pluginId, intent.context ?? 'user', configReferencePluginIds, intent.platform)
      : [];
    const selected = await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          configSnapshot,
          env: context.env,
          ...(catalogOperation ? { operationContext: catalogOperation } : {}),
          ...(signal ? { signal } : {}),
          consume: async ({ plugin, source }) => {
            if (preparation?.validateIntent && intent.kind === 'configSave') {
              await preparation.reporter.emit('config');
              if (!plugin.manifest.config) {
                throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
              }
              const definition = selectPluginConfigProfile(plugin.manifest.config, intent.platform);
              await coercePluginConfigUpdates({
                schema: definition.fields,
                updates: intent.updates ?? {},
                cwd: context.cwd,
              });
              for (const key of intent.removeKeys ?? []) {
                if (!definition.fields[key]) {
                  throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
                }
              }
            }
            const impact = intent.kind === 'configSave' && !intent.retryApply
              ? await analyzePluginConfigMutationImpact({
                  plugin,
                  referencePlugins,
                  scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
                  cwd: context.cwd,
                  env: context.env,
                  visibleTargets: configImpactVisibleTargets(
                    plugin.manifest.name,
                    configVisibleTargets,
                  ),
                  mutation: {
                    kind: 'patch',
                    updates: intent.updates,
                    removeKeys: intent.removeKeys,
                  },
                })
              : undefined;
            const affectedTargets = intent.kind === 'configSave'
              ? intent.retryApply ? configImpactVisibleTargets(plugin.manifest.name, configVisibleTargets) : impact!.affectedTargets
              : [];
            const commandPackages = impact?.affectedCommandPackages
              ?? (intent.kind === 'configSave' ? (await discoverPluginConfigManagedCommandPackages({
                plugin, scope: intent.context ?? 'user', cwd: context.cwd, env: context.env ?? process.env,
                platformTargets: configImpactVisibleTargets(plugin.manifest.name, configVisibleTargets),
                referencePlugins,
              })).packages : []);
            const preApplyAuthorization = intent.kind === 'configSave'
              && configIntentRequestsApply(intent)
              ? (await resolveConfigPreApplyAuthorization({
                  plugin,
                  scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
                  cwd: context.cwd,
                  env: context.env,
                  applyTargets: intent.retryApply
                    ? configImpactVisibleTargets(plugin.manifest.name, configVisibleTargets)
                    : impact!.affectedTargets,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: {
                    referencePlugins,
                    ...(catalogOperation ? { catalogOperationContext: catalogOperation } : {}),
                    ...(catalogOperation?.generationSetDigest
                      ? { expectedGenerationSetDigest: catalogOperation.generationSetDigest }
                      : {}),
                    inventoryCatalogSourceReferences: operationInventory,
                  },
                })).targets
              : [];
            return {
              pluginName: plugin.manifest.name,
              source: sourceEvidenceForPlugin(source, plugin.manifest.name),
              schemaIdentity: configSchemaIdentity(plugin, source.manifestDigest, intent.platform),
              impact,
              commandPackages,
              preApplyAuthorization,
              retryStoreDigest: intent.kind === 'configSave' && intent.retryApply
                ? await configRetryStoreDigest({ plugin, scope: intent.context ?? 'user', platform: intent.platform, targets: affectedTargets,
                  commandPackages, preApplyAuthorization, cwd: context.cwd, env: context.env, plugins: referencePlugins }) : undefined,
              sharedNativeRenderTargets: intent.kind === 'configSave'
                ? intent.retryApply
                  ? await configRetrySharedNativeRenderTargets(plugin,
                    configImpactVisibleTargets(plugin.manifest.name, configVisibleTargets), context.env, referencePlugins)
                  : impact!.sharedNativeRenderTargets
                : [],
            };
          },
        });
    await preparation?.reporter.emit('evidence');
    signal?.throwIfAborted();
    const evidenceTargets = intent.kind === 'configSave'
      ? configVisibleTargets
      : flattenStatusTargets(status.payload.targets);
    const evidenceRevisions = intent.kind === 'configSave'
      ? (status.targetRevisions ?? []).filter((revision) =>
          evidenceTargets.some((target) => target.platform === revision.platform
            && target.scope === revision.scope
            && target.pluginId === revision.pluginId))
      : (status.targetRevisions ?? []);
    const evidence: OperationEvidence = {
      catalog: {
        configDigest: status.payload.catalog.configDigest,
        compositeDigest: intent.kind === 'configSave' ? catalogOperation.catalog.compositeDigest : status.payload.catalog.compositeDigest,
        ...(catalogOperation
          ? { generationSetDigest: catalogOperation.generationSetDigest }
          : {}),
      },
      source: selected.source,
      targetFingerprint: statusTargetFingerprint(
        evidenceTargets,
        evidenceRevisions,
      ),
    };
    if (intent.kind === 'configSave') {
      const impact = 'impact' in selected ? selected.impact : undefined;
      const storeDigest = impact?.storeDigest ?? ('retryStoreDigest' in selected ? selected.retryStoreDigest : undefined);
      if (!storeDigest) throw operationReviewStale('设置操作缺少实际配置输入证据。');
      signal?.throwIfAborted();
      evidence.config = {
        scope: 'user', context: intent.context ?? 'user', platform: intent.platform,
        schemaIdentity: selected.schemaIdentity,
        storeDigest,
        impactState: impact?.impactState ?? 'known',
        ...(impact?.noEffectiveChange ? { noEffectiveChange: true } : {}),
        ...('commandPackages' in selected && selected.commandPackages.length
          ? { commandPackages: selected.commandPackages } : {}),
        affectedTargets: (impact?.affectedTargets
          ?? evidenceTargets).map(({ pluginName, platform, scope }) => ({ pluginName, platform, scope })),
        ...('sharedNativeRenderTargets' in selected
          && selected.sharedNativeRenderTargets.length > 0
          ? { sharedNativeRenderTargets: selected.sharedNativeRenderTargets }
          : {}),
        ...('preApplyAuthorization' in selected
          && selected.preApplyAuthorization.length > 0
          ? { preApplyAuthorization: selected.preApplyAuthorization }
          : {}),
      };
    }
    await assertConfigEditEvidence(intent, evidence);
    if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
    return evidence;
  };

  const dependencies: TuiControllerDependencies = {
    readAgentSettings: () => readAgentSettings(context),
    previewAgentSettings: (preferences, pluginId) => previewAgentSettings(context, preferences, pluginId),
    saveAgentSettings: (request) => saveAgentSettings(context, request),
    beginCatalogSession(sessionOptions) {
      sessionCatalogOperationContext = undefined;
      if (sessionOptions?.reuseValidatedGenerations !== true) {
        validatedStoreEntries.clear();
        validatingStoreEntries.clear();
      }
    },
    loadStatus,
    async loadScopedStatus(scope, signal) {
      signal.throwIfAborted();
      const packageInfo = await readCliPackageInfo();
      const currentCatalog = await resolvePartialCatalogOperationContext({
        env: context.env, signal, validatedStoreEntries, validatingStoreEntries,
      });
      signal.throwIfAborted();
      if (sessionCatalogOperationContext
        && currentCatalog.generationSetDigest !== sessionCatalogOperationContext.generationSetDigest) {
        throw new TuiOperationBlockedError('catalogSessionReloadRequired',
          'Catalog 已变化。请按 H 重新加载，再检查清单。');
      }
      const catalogOperationContext = sessionCatalogOperationContext ?? currentCatalog;
      let nativeSnapshot: Awaited<ReturnType<NonNullable<TuiControllerDependencies['loadScopedStatus']>>>['nativeSnapshot'] | undefined;
      const status = await readRecoveryStatus({
        scope, cwd: context.cwd, env: context.env, cliVersion: packageInfo.version,
        nativeCliRunner: context.nativeCliRunner,
        catalogOperationContext, signal,
        onNativeStatus: async (native, demand) => {
          signal.throwIfAborted();
          const dependencyOverviews = await loadDependencyOverviews({ context,
            cliVersion: packageInfo.version, status: native, signal,
            catalogOperationContext: demand.catalogOperationContext,
          });
          nativeSnapshot = { payload: native.payload, pluginSummaries: native.pluginSummaries, targetRevisions: native.targetRevisions,
            dependencyOverviews };
        },
      });
      signal.throwIfAborted();
      if (!nativeSnapshot) throw new Error('nativeObservationUnavailable');
      return { ...status, nativeSnapshot };
    },
    async prepareScopedTask(request, signal) {
      signal.throwIfAborted();
      if (request.kind === 'targets') {
        return prepareTargetsPlan({ scope: request.scope, cwd: context.cwd, env: context.env },
          request.action, request.agents);
      }
      if (request.kind === 'intent') {
        return prepareIntentPlan({ scope: request.scope, cwd: context.cwd, env: context.env },
          request.action, request.selector);
      }
      if (request.kind === 'retire') {
        const packageInfo = await readCliPackageInfo();
        signal.throwIfAborted();
        const plan = await prepareRetire({ scope: request.scope, cwd: context.cwd, env: context.env,
          signal,
          selector: request.selector, cliVersion: packageInfo.version,
          ...(request.targets ? { targets: request.targets } : {}),
          deleteConfig: request.deleteConfig === true,
        }, context);
        if (signal.aborted) {
          await plan.context.dispose();
          signal.throwIfAborted();
        }
        return { kind: 'retire', scope: request.scope, plan };
      }
      const packageInfo = await readCliPackageInfo();
      signal.throwIfAborted();
      const plan = await prepareRecovery(request.command ?? 'sync', request.selectors, {
        signal,
        scope: request.scope, cwd: context.cwd, env: context.env,
        cliVersion: packageInfo.version,
        all: request.selectors.length === 0,
        ...(request.allowDependencySelectors ? { allowDependencySelectors: true } : {}),
        ...(request.targets ? { targets: request.targets } : {}),
        ...(request.force ? { force: true } : {}),
        ...(request.refresh ? { refresh: true } : {}),
        ...(request.retireUnselectedTargets ? { retireUnselectedTargets: true } : {}),
        ...(request.scriptTimeoutMs !== undefined ? { scriptTimeoutMs: request.scriptTimeoutMs } : {}),
        ...(request.dependencyScopeOverrides?.length
          ? { dependencyScopeOverrides: request.dependencyScopeOverrides } : {}),
        ...(request.exactTargets ? { exactTargets: request.exactTargets } : {}),
        ...(request.saveDependencyScopeOverrides ? { saveDependencyScopeOverrides: true } : {}),
      }, context);
      if (signal.aborted) {
        await plan.context.dispose();
        signal.throwIfAborted();
      }
      return { kind: 'recovery', scope: request.scope, plan };
    },
    async executeScopedTask(plan) {
      if (plan.kind === 'targets') {
        const result = await executeTargetsPlan({ scope: plan.scope, cwd: context.cwd, env: context.env }, plan);
        return { kind: 'targets', ...result };
      }
      if (plan.kind === 'intent') {
        const receipt = await executeIntentPlan({ scope: plan.scope, cwd: context.cwd, env: context.env }, plan);
        return { kind: 'recovery', receipt };
      }
      if (plan.kind === 'retire') {
        const receipt = await executeRetire(plan.plan, { yes: true, runtime: context });
        return { kind: 'recovery', receipt };
      }
      if ((plan.plan.sourceRefreshes?.length ?? 0) > 0) {
        const refreshed = await activateRecoverySourcesAndReprepare(plan.plan, { runtime: context });
        return { kind: 'recoveryReview', plan: { kind: 'recovery', scope: plan.scope, plan: refreshed } };
      }
      const receipt = await executeRecovery(plan.plan, { yes: true, runtime: context });
      return { kind: 'recovery', receipt };
    },
    loadPluginContent,
    async probeCatalogFreshness(sourceId, freshnessOptions, signal) {
      signal.throwIfAborted();
      const packageInfo = await readCliPackageInfo();
      return probeCatalogSourceFreshness({
        sourceId,
        cliVersion: packageInfo.version,
        env: context.env,
        signal,
        fullValidation: freshnessOptions.fullValidation,
        runtime: {
          ...options.catalogGenerationRuntime,
          validatedStoreEntries,
          validatingStoreEntries,
        },
      });
    },
    async inspectSourceRemoval(sourceId, signal) {
      signal.throwIfAborted();
      const config = await readCatalogSourcesConfigSnapshot(context.env);
      const source = config.config.sources.find((entry) => entry.id === sourceId);
      if (!source) throw new TuiOperationBlockedError('catalogGenerationSourceMissing', '来源不存在。');
      const impact = await inspectCatalogSourceImpact({
        sourceId,
        cwd: context.cwd,
        env: context.env,
        sourcePrimary: source.primary,
        mode: 'remove',
      });
      const counts = (category: import('../types.js').CatalogSourceImpactCategory) =>
        impact.affectedReferences.filter((reference) => reference.category === category).length;
      return {
        blocked: impact.affectedReferences.length > 0 || !impact.inventoryComplete,
        inventoryComplete: impact.inventoryComplete,
        installationCount: counts('installation'),
        configCount: counts('config'),
        lifecycleCount: counts('lifecycle'),
        marketplaceCount: counts('marketplace'),
        dependencies: impact.affectedReferences,
      };
    },
    async prepareReviewEvidence(intent, signal, onStage, reusableCandidate) {
      const reporter = createReviewStageReporter({
        context,
        onStage,
        now: options.now ?? Date.now,
      });
      try {
        return await captureEvidence(intent, signal, {
          reporter,
          validateIntent: true,
        }, createOperationInventoryReader(), false, reusableCandidate);
      } finally {
        await reporter.finish();
      }
    },
    async previewDependencyPlacement(intent, signal) {
      const targets = intent.platform === 'both' ? ['codex', 'claude'] as const
        : [intent.platform === 'claude' ? 'claude' as const : 'codex' as const];
      const prepared = await dependencies.prepareScopedTask!({
        kind: 'recovery', command: 'install', scope: intent.scope,
        selectors: [intent.pluginId], targets: [...targets],
        dependencyScopeOverrides: intent.dependencyScopeOverrides,
      }, signal);
      if (prepared.kind !== 'recovery') throw new Error('dependencyPlacementUnavailable');
      try {
        const plans = prepared.plan.nativeGroups.flatMap((group) =>
          group.preview.dependencyPlan ? [group.preview.dependencyPlan] : []);
        if (plans.length === 0) {
          throw new Error(prepared.plan.receipt.blockers[0]?.code
            ?? prepared.plan.receipt.targetResults[0]?.blockers[0]?.code ?? 'dependencyPlacementUnavailable');
        }
        return {
          requestedPluginIds: [...new Set(plans.flatMap((plan) => plan.requestedPluginIds))],
          resolvedPluginIds: [...new Set(plans.flatMap((plan) => plan.resolvedPluginIds))],
          dependencyEdges: plans.flatMap((plan) => plan.dependencyEdges),
          scopeOverrides: plans.flatMap((plan) => plan.scopeOverrides),
          targets: plans.flatMap((plan) => plan.targets),
        };
      } finally { await prepared.plan.context.dispose(); }
    },
    async validateIntent(intent, signal) {
      if (intent.kind === 'catalogSourcesRecovery') {
        signal.throwIfAborted();
        return;
      }
      if (intent.kind === 'catalogGeneration') {
        signal.throwIfAborted();
        return;
      }
      if (intent.kind === 'sourceMutation') {
        const evidence = await captureEvidence(intent, signal);
        if (evidence.sourceWrite?.configDigest === evidence.sourceWrite?.proposedConfigDigest) {
          throw new TuiOperationBlockedError('sourceNoChanges', '来源没有变化。');
        }
        return;
      }
      if (intent.kind === 'configSaveBatch') {
        assertConfigSaveBatchIntent(intent);
        for (const group of intent.groups) {
          await dependencies.validateIntent!(configSaveBatchGroupIntent(intent, group), signal);
        }
        return;
      }
      if (intent.kind === 'configSave') {
        const packageInfo = await readCliPackageInfo();
        await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          env: context.env,
          signal,
          ...(sessionContextForPlugin(intent.pluginId)
            ? { operationContext: sessionContextForPlugin(intent.pluginId)! }
            : {}),
          consume: async ({ plugin }) => {
            if (!plugin.manifest.config) {
              throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
            }
            const definition = selectPluginConfigProfile(plugin.manifest.config, intent.platform);
            await coercePluginConfigUpdates({
              schema: definition.fields,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!definition.fields[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          },
        });
        return;
      }
      if (intent.kind !== 'pluginWrite') return;
      signal.throwIfAborted();
      const parsed = parsePluginId(intent.pluginId);
      if (!parsed.sourceId || !parsed.pluginName) {
        throw new TuiOperationBlockedError('invalidPluginId', '操作必须使用 canonical pluginId。');
      }
    },
    captureEvidence,
    inspectCatalogStore(signal) {
      signal.throwIfAborted();
      return inspectCatalogStoreTask({ env: context.env });
    },
    recheckPortableInstall(receipt, signal) {
      return recheckPortableInstall({
        receipt,
        cwd: context.cwd,
        env: context.env,
        signal,
      });
    },
    logError(_error, code, logContext) {
      return context.debugLogger.log({
        type: 'tui:controller-error',
        level: 'debug',
        target: 'debugLog',
        message: logContext?.privateConfigOperation
          ? 'TUI config operation failed.'
          : 'TUI controller operation failed.',
        data: { code },
      });
    },
    async getConfigGroups(pluginId, config, signal) {
      return (await dependencies.getConfigPage!(pluginId, config, signal)).groups;
    },
    async getConfigPage(pluginId, config, signal) {
      if (config.context === 'project') await resolveWorkContext({ cwd: context.cwd, context: 'project' });
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        env: context.env,
        signal,
        ...(sessionContextForPlugin(pluginId)
          ? { operationContext: sessionContextForPlugin(pluginId)! }
          : {}),
        consume: async ({ plugin, source }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const definition = selectPluginConfigProfile(plugin.manifest.config, config.platform);
          const stores = await readConfigStoresForTui({
            sourceId: plugin.sourceId,
            sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity,
            pluginName: plugin.manifest.name,
            schema: definition.fields,
            platform: config.platform,
            signal,
          });
          const userStore = stores.user;
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: config.view === 'effective' ? 'effective' : 'user',
            platform: config.platform,
            context: config.context ?? 'user',
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRead = config.view === 'effective' ? read : await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: 'effective',
            platform: config.platform,
            context: config.context ?? 'user',
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRaw = await resolveEffectivePluginConfig({
            sourceId: plugin.sourceId,
            sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity,
            pluginName: plugin.manifest.name,
            manifest: plugin.manifest,
            platform: config.platform,
            context: config.context ?? 'user',
            cwd: context.cwd,
            env: context.env,
          });
          const page = buildConfigPage({
            pluginId,
            context: config.context ?? 'user',
            schema: definition,
            read,
            effectiveRead,
            ...(config.view === 'effective' ? {} : { rawValues: userStore.values }),
            rawLayerValues: {
              common: userStore.common ?? {},
              ...(userStore.platforms ?? {}),
            },
            effectiveRawValues: effectiveRaw.values,
            sharedNativeRefreshKeys: new Set(
              (plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
                (target.target === 'codex.skill' || target.target === 'claude.skill')
                  && (!config.platform || target.platform === config.platform)
                  ? target.refreshKeys
                  : []),
            ),
          });
          return { ...page, editEvidence: {
            platform: config.platform,
            context: config.context ?? 'user',
            sourceIdentity: source.sourceIdentity,
            schemaIdentity: configSchemaIdentity(plugin, source.manifestDigest, config.platform),
            storeDigests: {
              user: digest({ exists: userStore.exists, rawDigest: userStore.rawDigest }),
            },
          } };
        },
      });
    },
    async getConfigReferenceContext(pluginId, config, draft, signal) {
      const workContext = await resolveWorkContext({ cwd: context.cwd, context: config.context ?? 'user' });
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId, cliVersion: packageInfo.version, env: context.env, signal,
        ...(sessionContextForPlugin(pluginId) ? { operationContext: sessionContextForPlugin(pluginId)! } : {}),
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          const definition = selectPluginConfigProfile(plugin.manifest.config, config.platform);
          const scalars = Object.values(definition.fields).flatMap(configReferenceScalars);
          if (!scalars.length) return { platform: config.platform, selections: {} };
          const stores = await readConfigStoresForTui({
            sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity, pluginName: plugin.manifest.name,
            schema: definition.fields, platform: config.platform, signal,
          });
          const edited = stores.user;
          const values = { ...edited.values };
          for (const key of draft.removes) delete values[key];
          Object.assign(values, draft.updates);
          const candidateStores = { user: replacePluginConfigStoreLayer(edited, values, config.platform) };
          const references = await resolvePluginConfigReferenceContext({
            sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity, manifest: plugin.manifest,
            scope: 'user', context: config.context ?? 'user', platform: config.platform, cwd: context.cwd, env: context.env,
          });
          const effective = await resolveEffectivePluginConfigFromStores({
            manifest: plugin.manifest, context: config.context ?? 'user', platform: config.platform,
            projectRoot: workContext.projectRoot ?? '', stores: candidateStores,
            referenceContext: references.context,
          });
          // Keep invalid raw sources for Core validation; effective.values omits them.
          // Preserve active branches in other references that reserve source values.
          // Only source choices and entry digests leave this boundary.
          const candidate: Record<string, unknown> = {};
          for (const key of Object.keys(definition.fields)) {
            const source = effective.sources[key];
            if (source === 'default') candidate[key] = definition.fields[key]!.default;
            else if (source === 'common') candidate[key] = candidateStores.user.common?.[key];
            else if (source === 'platform' && config.platform) candidate[key] = candidateStores.user.platforms?.[config.platform]?.[key];
          }
          const result: ConfigReferenceContext = { platform: config.platform, selections: {} };
          for (const scalar of scalars) {
            const ref = scalar.valueRef!;
            const selection = getPluginConfigReferenceChoices(definition, scalar, candidate, references.context);
            const entries = ref.plugin ? references.context.plugins[ref.plugin]?.values?.[ref.field] : candidate[ref.field];
            result.selections[configReferenceKey(scalar, config.platform)] = {
              ...selection, source: (ref.plugin
                ? references.evidence.find((entry) => entry.plugin === ref.plugin)?.sources[ref.field]
                : effective.sources[ref.field]) ?? 'missing',
              entries: Array.isArray(entries) ? Object.fromEntries(entries.flatMap((entry) =>
                entry && typeof entry === 'object' && Object.hasOwn(entry, ref.key)
                  ? [[JSON.stringify(entry[ref.key]), digest(entry)]] : [])) : {},
            };
          }
          return result;
        },
      });
    },
    async getConfigResetAvailability(pluginId, config, signal) {
      if (config.context === 'project') await resolveWorkContext({ cwd: context.cwd, context: 'project' });
      const parsed = parsePluginId(pluginId);
      if (!parsed.sourceId || !parsed.pluginName) {
        throw new TuiOperationBlockedError('invalidPluginId', '设置目标必须使用 canonical pluginId。');
      }
      let sourceIdentity: string | undefined;
      let logicalIdentity: string | undefined;
      try {
        const packageInfo = await readCliPackageInfo();
        const source = await withResolvedCatalogPlugin({
          selector: pluginId,
          cliVersion: packageInfo.version,
          env: context.env,
          signal,
          ...(sessionContextForPlugin(pluginId)
            ? { operationContext: sessionContextForPlugin(pluginId)! }
            : {}),
          consume: async ({ source }) => ({
            sourceIdentity: source.sourceIdentity,
            logicalIdentity: source.logicalIdentity,
          }),
        });
        sourceIdentity = source.sourceIdentity;
        logicalIdentity = source.logicalIdentity;
      } catch {
        sourceIdentity = undefined;
        logicalIdentity = undefined;
      }
      signal.throwIfAborted();
      const target = await inspectPluginConfigResetTarget({
        sourceId: parsed.sourceId,
        pluginName: parsed.pluginName,
        scope: 'user',
        cwd: context.cwd,
        env: context.env,
      });
      signal.throwIfAborted();
      if (target.kind === 'regularFile') {
        const store = await readPluginConfigStore({
          sourceId: parsed.sourceId,
          ...(sourceIdentity ? { sourceIdentity } : {}),
          ...(logicalIdentity ? { logicalIdentity } : {}),
          pluginName: parsed.pluginName,
          scope: 'user',
          platform: config.platform,
          cwd: context.cwd,
          env: context.env,
        });
        signal.throwIfAborted();
        return {
          exists: store.exists,
          state: store.state,
          ...(store.invalidCode ? { invalidCode: store.invalidCode } : {}),
          sourceIdentityPresent: sourceIdentity !== undefined,
          ...(sourceIdentity ? { sourceIdentity } : {}),
          targetKind: target.kind,
          resettable: target.resettable,
          storeDigest: target.fingerprint,
        };
      }
      return {
        exists: target.exists,
        state: target.kind === 'absent' ? 'missing' as const : 'invalid' as const,
        sourceIdentityPresent: sourceIdentity !== undefined,
        ...(sourceIdentity ? { sourceIdentity } : {}),
        targetKind: target.kind,
        resettable: target.resettable,
        storeDigest: target.fingerprint,
      };
    },
    async executeIntent(intent, expectedEvidence, signal) {
      if (intent.kind === 'pluginWrite' || intent.kind === 'pluginWriteBatch'
        || intent.kind === 'pluginWriteTask') {
        throw new TuiOperationBlockedError('useScopedRecovery', '请使用统一范围恢复任务。');
      }
      if (intent.kind === 'catalogStorePrune') {
        signal?.throwIfAborted();
        if (!expectedEvidence.catalogStore) {
          throw new TuiOperationBlockedError('catalogStoreReviewStale', '确认信息缺少精确清理目标。');
        }
        return executeCatalogStoreTask({
          env: context.env,
          authorizedItems: expectedEvidence.catalogStore.authorizedItems,
        });
      }
      if (intent.kind === 'catalogSourcesRecovery') {
        signal?.throwIfAborted();
        return recoverInvalidCatalogSourcesConfig({ env: context.env });
      }
      if (intent.kind === 'catalogGeneration') {
        signal?.throwIfAborted();
        const expected = expectedEvidence.catalogGeneration;
        if (!expected) throw new TuiOperationBlockedError(
          'catalogGenerationReviewStale',
          '确认信息缺少 Catalog candidate。',
        );
        const packageInfo = await readCliPackageInfo();
        let configSaved = false;
        if (intent.sourceMutation) {
          const common = {
            cwd: context.cwd,
            env: context.env,
            cliVersion: packageInfo.version,
            expectedConfigDigest: expected.configDigest,
          };
          if (intent.sourceMutation.action === 'add') {
            await addCatalogSourceCommand({
              ...common,
              source: intent.sourceMutation.source,
              expectedProposedConfigDigest: expected.proposedConfigDigest,
              expectedImpactDigest: expected.impactDigest,
              requireImpactConfirmation: true,
              confirmImpact: true,
            });
          } else {
            await updateCatalogSourceCommand({
              ...common,
              sourceId: intent.sourceId,
              update: intent.sourceMutation.update,
              expectedProposedConfigDigest: expected.proposedConfigDigest,
              expectedImpactDigest: expected.impactDigest,
              requireIdentityChangeConfirmation: true,
              confirmIdentityChange: true,
            });
          }
          configSaved = true;
          await tuiControllerRuntimeTestHooks?.afterCatalogSourceConfigCommit?.();
        }
        try {
          let generation;
          if (intent.action === 'recoverState') {
            generation = await recoverCatalogGenerationStateAndActivate({
              sourceId: intent.sourceId,
              cliVersion: packageInfo.version,
              cwd: context.cwd,
              impactConfirmed: true,
              expectedImpactDigest: expected.impactDigest,
              expectedCandidate: expected.candidate,
              env: context.env,
              signal,
              runtime: options.catalogGenerationRuntime,
            });
          } else if (intent.action === 'repair') {
            generation = await repairCatalogSourceGeneration({
              sourceId: intent.sourceId,
              cliVersion: packageInfo.version,
              cwd: context.cwd,
              expectedCandidate: expected.candidate,
              expectedActive: expected.previousActive ?? null,
              expectedConfigDigest: expected.proposedConfigDigest ?? expected.configDigest,
              env: context.env,
              signal,
              runtime: {
                ...options.catalogGenerationRuntime,
                afterCandidateResolved: tuiControllerRuntimeTestHooks
                  ?.afterCatalogGenerationCandidateResolved,
              },
            });
          } else if (intent.action === 'update' && expected.exactRepair) {
            generation = await repairCatalogSourceGeneration({
              sourceId: intent.sourceId,
              cliVersion: packageInfo.version,
              cwd: context.cwd,
              expectedActive: expected.previousActive ?? null,
              expectedConfigDigest: expected.proposedConfigDigest ?? expected.configDigest,
              env: context.env,
              signal,
              runtime: options.catalogGenerationRuntime,
            });
          } else if (intent.action === 'replaceDamaged') {
            generation = await replaceDamagedCatalogSourceGeneration({
              sourceId: intent.sourceId,
              cliVersion: packageInfo.version,
              cwd: context.cwd,
              expectedCandidate: expected.candidate,
              expectedActive: expected.previousActive!,
              expectedConfigDigest: expected.proposedConfigDigest ?? expected.configDigest,
              impactConfirmed: true,
              expectedImpactDigest: expected.impactDigest,
              env: context.env,
              signal,
              runtime: {
                ...options.catalogGenerationRuntime,
                afterCandidateResolved: tuiControllerRuntimeTestHooks
                  ?.afterCatalogGenerationCandidateResolved,
              },
            });
          } else {
            generation = await activateCatalogSourceGeneration({
              sourceId: intent.sourceId,
              cliVersion: packageInfo.version,
              cwd: context.cwd,
              activationMode: expected.activationMode,
              impactConfirmed: true,
              expectedImpactDigest: expected.impactDigest,
              impactMode: expected.impactMode,
              expectedCandidate: expected.candidate,
              expectedActive: expected.previousActive ?? null,
              expectedConfigDigest: expected.proposedConfigDigest ?? expected.configDigest,
              env: context.env,
              signal,
              runtime: {
                ...options.catalogGenerationRuntime,
                afterCandidateResolved: tuiControllerRuntimeTestHooks
                  ?.afterCatalogGenerationCandidateResolved,
              },
            });
          }
          let primaryChanged = false;
          if (intent.setPrimaryAfterActivation) {
            try {
              await setPrimaryCatalogSourceCommand({
                sourceId: intent.sourceId,
                cwd: context.cwd,
                env: context.env,
                expectedConfigDigest: expected.primaryConfigDigest,
                expectedImpactDigest: expected.primaryImpactDigest,
                requireImpactConfirmation: true,
                confirmImpact: true,
              });
              primaryChanged = true;
            } catch (error) {
              return {
                status: 'partial',
                partialReason: 'primary',
                configSaved,
                generation,
                activeAvailable: true,
                errorCode: typeof error === 'object' && error !== null
                  && 'code' in error && typeof error.code === 'string'
                  ? error.code
                  : error instanceof Error ? error.name : 'catalogSourcePrimaryFailed',
              };
            }
          }
          return { status: 'succeeded', generation, configSaved, primaryChanged };
        } catch (error) {
          if (!configSaved) throw error;
          return {
            status: 'partial',
            partialReason: 'activation',
            configSaved: true,
            errorCode: error instanceof CatalogGenerationError ? error.code : 'catalogGenerationRefreshFailed',
          };
        }
      }
      if (intent.kind === 'portableInstall') {
        if (!expectedEvidence.portable) {
          throw operationReviewStale('确认信息缺少 Portable evidence。');
        }
        const packageInfo = await readCliPackageInfo();
        try {
          if (intent.retry) {
            if (!('retryPairs' in expectedEvidence.portable)) {
              throw operationReviewStale('确认信息缺少 Portable 重试目标。');
            }
            return await executePortableRetry({
              receipt: intent.retry.receipt,
              review: expectedEvidence.portable as PortableRetryReview,
              expectedEvidenceDigest: expectedEvidence.portable.evidenceDigest,
              cwd: context.cwd,
              env: context.env,
              cliVersion: packageInfo.version,
              signal,
              onProgress(stage) {
                const phase = stage === 'prepare' ? '重新检查失败目标'
                  : stage === 'add' ? '重试缺失的 Skills' : '验证重试结果';
                progressFeed?.setCurrent({ target: 'Skills CLI', phase }, `Portable Skills：${phase}`);
              },
            });
          }
          return await installPortableSkills({
            selector: intent.pluginId,
            scope: intent.scope,
            requestedSkills: intent.selectedSkills,
            ...(intent.requestedAgents ? { requestedAgents: intent.requestedAgents } : {}),
            yes: true,
            cwd: context.cwd,
            env: context.env,
            cliVersion: packageInfo.version,
            expectedEvidenceDigest: expectedEvidence.portable.evidenceDigest,
            expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
            onProgress(stage) {
              const phase = stage === 'prepare' ? '检查插件依赖并生成候选'
                : stage === 'add' ? '安装已选择的 Skills' : '验证安装结果';
              progressFeed?.setCurrent({ target: 'Skills CLI', phase }, `Portable Skills：${phase}`);
            },
          });
        } catch (error) {
          if (error instanceof PortableCommandError && error.code === 'reviewStale') {
            throw operationReviewStale('确认后 Portable 安装证据发生变化。');
          }
          throw error;
        }
      }
      if (intent.kind === 'sourceMutation') {
        const currentEvidence = await captureEvidence(intent);
        if (operationEvidenceFingerprint(currentEvidence) !== operationEvidenceFingerprint(expectedEvidence)) {
          throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
        }
        await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
        const packageInfo = await readCliPackageInfo();
        const runtime = {
          onProgress: async (event: CatalogSourceMutationProgress) => {
            const phase = SOURCE_PROGRESS_PHASES[event.stage];
            progressFeed?.setCurrent(
              { target: 'Catalog 来源配置', phase },
              `来源操作：${phase}`,
            );
            await tuiControllerRuntimeTestHooks?.onCatalogSourceProgress?.(event);
          },
        };
        const common = {
          cwd: context.cwd,
          env: context.env,
          expectedConfigDigest: expectedEvidence.sourceWrite?.configDigest,
          expectedProposedConfigDigest: expectedEvidence.sourceWrite?.proposedConfigDigest,
          expectedImpactDigest: expectedEvidence.sourceWrite?.impactDigest,
          runtime,
        };
        if (intent.action === 'add' && intent.source) {
          return addCatalogSourceCommand({
            ...common,
            source: intent.source,
            cliVersion: packageInfo.version,
            requireImpactConfirmation: true,
            confirmImpact: true,
          });
        }
        if (intent.action === 'update' && intent.update) {
          return updateCatalogSourceCommand({
            ...common,
            sourceId: intent.sourceId,
            update: intent.update,
            cliVersion: packageInfo.version,
            requireIdentityChangeConfirmation: true,
            confirmIdentityChange: true,
          });
        }
        if (intent.action === 'setPrimary') {
          return setPrimaryCatalogSourceCommand({
            ...common,
            sourceId: intent.sourceId,
            requireImpactConfirmation: true,
            confirmImpact: true,
          });
        }
        if (intent.action === 'remove') {
          return removeCatalogSourceCommand({
            ...common,
            sourceId: intent.sourceId,
            requireImpactConfirmation: true,
            confirmImpact: true,
          });
        }
        throw new TuiOperationBlockedError('invalidSourceMutation', '来源操作缺少候选输入。');
      }
      return withAwHomeMutationLock({
        env: context.env,
        action: async (awHomeMutationToken) => {
          await tuiControllerRuntimeTestHooks?.beforeMutationEvidenceCapture?.();
          const operationInventory = createOperationInventoryReader();
          const currentEvidence = await captureEvidence(intent, undefined, undefined,
            operationInventory, true);
          if (!operationEvidenceMatches(expectedEvidence, currentEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
          const catalogOperation = catalogOperationByEvidence.get(currentEvidence);
          if (expectedEvidence.catalog.generationSetDigest
            && catalogOperation?.generationSetDigest !== expectedEvidence.catalog.generationSetDigest) {
            throw operationReviewStale('确认后 Active Catalog generation 发生变化。');
          }
          await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
          if (intent.kind === 'configSaveBatch') {
            assertConfigSaveBatchIntent(intent);
            const reviewedBatch = expectedEvidence.configBatch;
            if (!reviewedBatch || !currentEvidence.configBatch || !currentEvidence.source) {
              throw operationReviewStale('确认信息缺少设置批次证据。');
            }
            const approvedApplyTargets = new Set(reviewedBatch.groups.flatMap((group) =>
              group.config.affectedTargets.map((target) => `${target.pluginName ?? parsePluginId(intent.pluginId).pluginName}\0${target.platform}\0${target.scope}`)));
            const approvedCommandPackages = new Set(reviewedBatch.groups.flatMap((group) =>
              (group.config.commandPackages ?? []).map((target) => target.packageId)));
            const approvedPreApplyTargets = reviewedBatch.groups.flatMap((group) =>
              group.config.preApplyAuthorization ?? []);
            const results: ConfigSaveBatchExecutionResult['groups'] = [];
            const packageInfo = await readCliPackageInfo();
            for (const group of intent.groups) {
              const groupIntent = configSaveBatchGroupIntent(intent, group);
              const reviewedGroup = reviewedBatch.groups.find((item) => item.platform === group.platform);
              if (!reviewedGroup) {
                throw operationReviewStale('确认信息缺少设置层基线。');
              }
              let configSaved = false;
              const operationRebuildResults: import('../commands/rebuild-operations.js').RebuildResult[] = [];
              try {
                const freshEvidence = await captureEvidence(
                  groupIntent,
                  undefined,
                  undefined,
                  operationInventory,
                  true,
                );
                const freshSource = freshEvidence.source;
                const freshConfig = freshEvidence.config;
                if (!freshSource || !freshConfig) {
                  throw operationReviewStale('设置目标缺少最新证据。');
                }
                assertSourceEvidenceMatches(currentEvidence.source, freshSource);
                const freshLayerStoreDigest = await configLayerStoreDigest({
                  source: freshSource,
                  pluginName: parsePluginId(intent.pluginId).pluginName!,
                  scope: 'user', platform: group.platform, profileOnly: true,
                  cwd: context.cwd,
                  env: context.env,
                });
                if (freshLayerStoreDigest !== reviewedGroup.config.storeDigest) {
                  throw operationReviewStale('保存设置期间此设置层的原始内容发生变化。');
                }
                if (freshConfig.affectedTargets.some((target) =>
                  !approvedApplyTargets.has(`${target.pluginName ?? parsePluginId(intent.pluginId).pluginName}\0${target.platform}\0${target.scope}`))
                  || freshConfig.commandPackages?.some((target) => !approvedCommandPackages.has(target.packageId))) {
                  throw operationReviewStale('同批前一层变更扩大了未经确认的应用目标。');
                }
                const groupCatalogOperation = catalogOperationByEvidence.get(freshEvidence);
                if (expectedEvidence.catalog.generationSetDigest
                  && groupCatalogOperation?.generationSetDigest
                    !== expectedEvidence.catalog.generationSetDigest) {
                  throw operationReviewStale('保存设置期间 Active Catalog generation 发生变化。');
                }
                const result = await withResolvedCatalogPlugin({
                  selector: intent.pluginId,
                  cliVersion: packageInfo.version,
                  env: context.env,
                  ...(groupCatalogOperation ? { operationContext: groupCatalogOperation } : {}),
                  consume: async ({ plugin, source }) => {
                    assertSourceEvidenceMatches(
                      freshSource,
                      sourceEvidenceForPlugin(source, plugin.manifest.name),
                    );
                    const referencePlugins = configNeedsReferencePlugins(plugin) ? await resolvePluginConfigReferencePlugins({
                      sourceId: plugin.sourceId,
                      sourceIdentity: plugin.sourceIdentity,
                      logicalIdentity: plugin.catalogLogicalIdentity,
                      env: context.env,
                      operationContext: groupCatalogOperation,
                    }) : undefined;
                    const applyTargets = intent.apply
                      ? freshConfig.affectedTargets.filter((target): target is typeof target & { platform: PlatformName } =>
                          target.platform === 'codex' || target.platform === 'claude').map((target) => ({
                          pluginName: target.pluginName ?? plugin.manifest.name,
                          platform: target.platform,
                          scope: target.scope,
                        }))
                      : [];
                    return applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: 'user', platform: group.platform, context: intent.context ?? 'user',
                      apply: intent.apply,
                      cwd: context.cwd,
                      env: context.env,
                      nativeCliRunner: context.nativeCliRunner,
                      rebuildRuntime: {
                        ...context,
                        referencePlugins,
                        awHomeMutationToken,
                        operationDiagnosticSink: (entries) => {
                          operationRebuildResults.push(...structuredClone(entries));
                        },
                        ...(reviewedScriptTimeoutMs(intent) === undefined ? {} : {
                          scriptTimeoutMs: reviewedScriptTimeoutMs(intent),
                        }),
                        ...(groupCatalogOperation ? {
                          catalogOperationContext: groupCatalogOperation,
                          expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
                        } : {}),
                      },
                      awHomeMutationToken,
                      ...(applyTargets.length ? { applyTargets } : {}),
                      request: { updates: group.updates, removeKeys: group.removeKeys },
                      sharedNativeApplyConfirmed: true,
                      preApplyConfirmed: true,
                      preApplyAuthorizedTargets: approvedPreApplyTargets,
                    });
                  },
                });
                configSaved = result.configWrite === 'succeeded';
                const applyStatus = !intent.apply
                  ? 'notRequested' as const
                  : result.apply.state === 'succeeded'
                    ? 'succeeded' as const
                    : result.apply.state === 'skipped'
                      ? 'notNeeded' as const
                      : 'failed' as const;
                results.push({
                  scope: 'user', platform: group.platform,
                  status: applyStatus === 'failed' ? 'failed' : 'succeeded',
                  configSaved,
                  applyRequested: intent.apply,
                  applyStatus,
                  execution: { ...result, operationRebuildResults },
                  ...(applyStatus === 'failed' ? {
                    errorCode: result.apply.state === 'unavailable'
                      ? result.apply.error?.code ?? result.apply.reason
                      : result.apply.targetResults.find((target) => target.errorCode)?.errorCode
                        ?? 'runtimeApplyFailed',
                  } : {}),
                });
              } catch (error) {
                configSaved = (error as { configWrite?: unknown })?.configWrite === 'succeeded';
                const errorCode = typeof error === 'object' && error !== null
                  && 'code' in error && typeof error.code === 'string'
                  ? error.code
                  : configSaved ? 'runtimeApplyFailed' : 'configWriteFailed';
                results.push({
                  scope: 'user', platform: group.platform,
                  status: 'failed',
                  configSaved,
                  applyRequested: intent.apply,
                  applyStatus: intent.apply ? 'failed' : 'notRequested',
                  errorCode,
                  ...(operationRebuildResults.length > 0
                    ? { execution: { operationRebuildResults } }
                    : {}),
                });
              }
            }
            const succeeded = results.filter((result) => result.status === 'succeeded').length;
            return {
              status: succeeded === results.length
                ? 'succeeded'
                : succeeded > 0 || results.some((result) => result.configSaved)
                  ? 'partial'
                  : 'failed',
              groups: results,
            } satisfies ConfigSaveBatchExecutionResult;
          }
          if (intent.kind === 'configSave' || intent.kind === 'configReset') {
            const operationRebuildResults: import('../commands/rebuild-operations.js').RebuildResult[] = [];
            const operationDiagnosticSink = (
              results: readonly import('../commands/rebuild-operations.js').RebuildResult[],
            ): void => {
              operationRebuildResults.push(...structuredClone(results));
            };
            const currentSource = currentEvidence.source;
            if (intent.kind === 'configReset') {
              const parsed = parsePluginId(intent.pluginId);
              if (!parsed.sourceId || !parsed.pluginName) {
                throw operationReviewStale('确认信息缺少 qualified 设置目标。');
              }
              return resetPluginConfigWithHelper({
                sourceId: parsed.sourceId,
                pluginName: parsed.pluginName,
                scope: 'user', platform: intent.platform, context: intent.context ?? 'user',
                cwd: context.cwd,
                env: context.env,
                nativeCliRunner: context.nativeCliRunner,
                rebuildRuntime: { ...context, awHomeMutationToken },
                awHomeMutationToken,
                apply: false,
                sharedNativeApplyConfirmed: false,
              });
            }
            if (!currentSource) {
              throw operationReviewStale('确认信息缺少来源身份。');
            }
            const packageInfo = await readCliPackageInfo();
            return withResolvedCatalogPlugin({
              selector: intent.pluginId,
              cliVersion: packageInfo.version,
              env: context.env,
              ...(catalogOperation ? { operationContext: catalogOperation } : {}),
              consume: async ({ plugin, source }) => {
                assertSourceEvidenceMatches(
                  currentSource,
                  sourceEvidenceForPlugin(source, plugin.manifest.name),
                );
                const referencePlugins = configNeedsReferencePlugins(plugin) ? await resolvePluginConfigReferencePlugins({
                  sourceId: plugin.sourceId,
                  sourceIdentity: plugin.sourceIdentity,
                  logicalIdentity: plugin.catalogLogicalIdentity,
                  env: context.env,
                  operationContext: catalogOperation,
                }) : undefined;
                const applyTargets = intent.retryApply || intent.apply
                  ? currentEvidence.config?.affectedTargets.filter((target): target is typeof target & { platform: PlatformName } =>
                      target.platform === 'codex' || target.platform === 'claude').map((target) => ({
                      pluginName: target.pluginName ?? plugin.manifest.name,
                      platform: target.platform,
                      scope: target.scope,
                    })) ?? []
                  : [];
                const result = intent.retryApply
                    ? await applyPluginConfig({
                        plugin,
                        scope: 'user', platform: intent.platform, context: intent.context ?? 'user',
                        ...(intent.targets ? { targets: intent.targets } : {}),
                        cliVersion: packageInfo.version,
                        cwd: context.cwd,
                        env: context.env,
                        nativeCliRunner: context.nativeCliRunner,
                        rebuildRuntime: {
                          ...context,
                          referencePlugins,
                          awHomeMutationToken,
                          operationDiagnosticSink,
                          ...(reviewedScriptTimeoutMs(intent) === undefined
                            ? {}
                            : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
                          ...(catalogOperation ? {
                            catalogOperationContext: catalogOperation,
                            expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
                          } : {}),
                        },
                        awHomeMutationToken,
                        expectedEvidence: expectedEvidence.config?.applyEvidence,
                        sharedNativeApplyConfirmed: true,
                        preApplyConfirmed: true,
                        preApplyAuthorizedTargets:
                          expectedEvidence.config?.preApplyAuthorization ?? [],
                      })
                    : await applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: 'user', platform: intent.platform, context: intent.context ?? 'user',
                      apply: intent.apply,
                      cwd: context.cwd,
                      env: context.env,
                      nativeCliRunner: context.nativeCliRunner,
                      rebuildRuntime: {
                        ...context,
                        referencePlugins,
                        awHomeMutationToken,
                        operationDiagnosticSink,
                        ...(reviewedScriptTimeoutMs(intent) === undefined
                          ? {}
                          : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
                        ...(catalogOperation ? {
                          catalogOperationContext: catalogOperation,
                          expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
                        } : {}),
                      },
                      awHomeMutationToken,
                      ...(applyTargets.length ? { applyTargets } : {}),
                      request: { updates: intent.updates, removeKeys: intent.removeKeys },
                      sharedNativeApplyConfirmed: true,
                      preApplyConfirmed: true,
                      preApplyAuthorizedTargets:
                        expectedEvidence.config?.preApplyAuthorization ?? [],
                      });
                return { ...result, operationRebuildResults };
              },
            });
          }
          throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
        },
      });
    },
  };
  return dependencies;
}

export function createConsoleTuiV4Controller(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): TuiController {
  return new TuiController(createTuiControllerDependencies(context, progressFeed), progressFeed);
}
