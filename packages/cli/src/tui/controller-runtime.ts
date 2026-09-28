import crypto from 'node:crypto';
import path from 'node:path';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { CatalogSourceResolution, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
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
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
} from '../utils/plugin-config.js';
import { assertProjectSharedConfigPathVisible } from '../utils/project-boundary.js';
import { readRecoveryStatus } from '../recovery/status.js';
import { prepareRecovery, executeRecovery } from '../recovery/coordinator.js';
import { prepareRetire, executeRetire } from '../recovery/retirement.js';
import { prepareTargetsPlan, executeTargetsPlan, prepareIntentPlan, executeIntentPlan } from './scoped-flow.js';
import {
  applyPluginConfigWrite,
  replayConfigRuntimeWrites,
  resolveConfigPreApplyAuthorization,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import { analyzePluginConfigMutationImpact } from '../utils/plugin-config-impact.js';
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
  buildConfigGroups,
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
              ).then((plugin) => plugin.manifest.distributions?.agentSkills
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
  configScope: 'user' | 'project',
): StatusScopedTarget[] {
  const affected = new Map<string, StatusScopedTarget>();
  for (const target of flattenStatusTargets(targets)) {
    if (target.pluginId !== pluginId || !statusTargetHasLiveConfigConsumer(target)) continue;
    if (configScope === 'project' && target.scope !== 'project') continue;
    affected.set(`${target.platform}\0${target.scope}`, target);
  }
  return [...affected.values()]
    .sort((left, right) => `${left.platform}\0${left.scope}`
      .localeCompare(`${right.platform}\0${right.scope}`, 'en'));
}

function configRetrySharedNativeRenderTargets(
  plugin: PluginMeta,
): Array<{ id: string; skillKey: string; refreshKeys: string[] }> {
  return (plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
    target.platform === 'codex'
      && target.target === 'codex.skill'
      && target.delivery.mode === 'codex-native'
      && target.skillKey
      && target.refreshKeys.length > 0
      ? [{ id: target.id, skillKey: target.skillKey, refreshKeys: [...target.refreshKeys] }]
      : []);
}

function configImpactVisibleTargets(
  pluginName: string,
  targets: readonly StatusScopedTarget[],
) {
  return targets.map((target) => ({
    pluginName,
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
    scope: group.scope,
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
  const order: Record<Scope, number> = { project: 0, user: 1 };
  if (intent.groups.length === 0 || intent.groups.length > 2
    || new Set(intent.groups.map((group) => group.scope)).size !== intent.groups.length
    || intent.groups.some((group, index) => index > 0
      && order[intent.groups[index - 1]!.scope] >= order[group.scope])
    || intent.groups.some((group) => Object.keys(group.updates ?? {}).length === 0
      && (group.removeKeys?.length ?? 0) === 0)) {
    throw new TuiOperationBlockedError(
      'configBatchInvalid',
      '设置批次必须包含按当前项目、个人默认排序的唯一非空目标。',
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
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  return digest({ exists: store.exists, rawDigest: store.rawDigest });
}

async function inspectConfigShareability(options: {
  sourceId?: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<'verified' | 'unverified' | undefined> {
  if (options.scope !== 'project') return undefined;
  const targetPath = resolvePluginConfigStorePath({
    sourceId: options.sourceId,
    pluginName: options.pluginName,
    scope: 'project',
    cwd: options.cwd,
    env: options.env,
  });
  const visibility = await assertProjectSharedConfigPathVisible({
    cwd: options.cwd,
    targetPath,
    env: options.env,
  });
  return visibility.state === 'unverified' ? 'unverified' : 'verified';
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
    scope: Scope | 'effective';
    signal: AbortSignal;
  }) => {
    const scopes = config.scope === 'user' ? ['user'] as const : ['user', 'project'] as const;
    const stores = await Promise.all(scopes.map((scope) => readPluginConfigStore({
      sourceId: config.sourceId,
      sourceIdentity: config.sourceIdentity,
      logicalIdentity: config.logicalIdentity,
      pluginName: config.pluginName,
      scope,
      cwd: context.cwd,
      env: context.env,
      schema: config.schema,
    })));
    const user = stores[0]!;
    const project = config.scope === 'user' ? undefined : stores[1]!;
    config.signal.throwIfAborted();
    const invalidStores = ([
      { scope: 'user' as const, store: user },
      ...(project ? [{ scope: 'project' as const, store: project }] : []),
    ]).flatMap(({ scope, store }) => store.state === 'invalid' ? [{
      scope,
      code: store.invalidCode!,
      pathSummary: scope === 'user'
        ? `AW_HOME/plugin-config/${config.sourceId ?? '<source>'}/${config.pluginName}/config.json`
        : `<project>/.agent-workflows/plugin-config/${config.sourceId ?? '<source>'}/${config.pluginName}/config.json`,
    }] : []);
    if (invalidStores.length > 0) throw new TuiConfigInvalidStoreError(invalidStores);
    return { user, ...(project ? { project } : {}) };
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
      const configStoreInventory = (await Promise.all((['user', 'project'] as const).map(async (scope) => {
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
        scope: Scope;
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
            || expected.schemaIdentity !== current.config.schemaIdentity) {
            throw operationReviewStale('编辑期间插件来源或设置定义已变化，请重新打开列表。');
          }
          for (const scope of ['user', 'project'] as const) {
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
          scope: group.scope,
          config: {
            ...current.config,
            storeDigest: await configLayerStoreDigest({
              source: current.source,
              pluginName: parsePluginId(intent.pluginId).pluginName!,
              scope: group.scope,
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
        scope: intent.scope,
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
            intent.scope,
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
              scope: intent.scope,
              cwd: context.cwd,
              env: context.env,
              visibleTargets: configImpactVisibleTargets(plugin.manifest.name, relevantTargets),
              mutation: { kind: 'reset' },
            }),
          }),
        });
      } catch {
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
          scope: intent.scope,
          storeDigest: selected?.impact.storeDigest ?? target.fingerprint,
          impactState: selected?.impact.impactState ?? 'unknown',
          ...(selected?.impact.noEffectiveChange ? { noEffectiveChange: true as const } : {}),
          affectedTargets: (selected?.impact.affectedTargets
            ?? relevantTargets).map(({ platform, scope }) => ({ platform, scope })),
          ...((selected?.impact.sharedNativeRenderTargets.length ?? 0) > 0
            ? { sharedNativeRenderTargets: selected!.impact.sharedNativeRenderTargets }
            : {}),
        },
        resetTarget: {
          sourceId: parsed.sourceId,
          pluginName: parsed.pluginName,
          scope: intent.scope,
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
        intent.scope,
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
          if (intent.kind === 'configSave') {
            await coercePluginConfigUpdates({
              schema: plugin.manifest.config.fields,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.fields[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          }
          const impact = intent.retryApply ? undefined : await analyzePluginConfigMutationImpact({
            plugin,
            scope: intent.scope,
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
          return {
            pluginName: plugin.manifest.name,
            source: sourceEvidenceForPlugin(source, plugin.manifest.name),
            impact,
            preApplyAuthorization: configIntentRequestsApply(intent)
              ? (await resolveConfigPreApplyAuthorization({
                  plugin,
                  scope: intent.scope,
                  cwd: context.cwd,
                  env: context.env,
                  applyTargets: affectedTargets,
                  nativeCliRunner: context.nativeCliRunner,
                  rebuildRuntime: {
                    catalogOperationContext: preparedCatalogOperation,
                    expectedGenerationSetDigest: preparedCatalogOperation.generationSetDigest,
                    inventoryCatalogSourceReferences: operationInventory,
                  },
                })).targets
              : [],
            sharedNativeRenderTargets: intent.retryApply
              ? configRetrySharedNativeRenderTargets(plugin)
              : impact!.sharedNativeRenderTargets,
          };
        },
      });
      const retryStore = intent.retryApply ? await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        logicalIdentity: selected.source.logicalIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        cwd: context.cwd,
        env: context.env,
      }) : undefined;
      signal?.throwIfAborted();
      const relevantRevisions = (sessionStatusResult.targetRevisions ?? []).filter((revision) =>
        relevantTargets.some((target) => target.platform === revision.platform
          && target.scope === revision.scope
          && target.pluginId === revision.pluginId));
      await preparation.reporter.emit('evidence');
      const evidence: OperationEvidence = {
        catalog: {
          configDigest: sessionStatusResult.payload.catalog.configDigest,
          compositeDigest: sessionStatusResult.payload.catalog.compositeDigest,
          ...(catalogOperation ? { generationSetDigest: catalogOperation.generationSetDigest } : {}),
        },
        ...(selected.source ? { source: selected.source } : {}),
        targetFingerprint: statusTargetFingerprint(relevantTargets, relevantRevisions),
        config: {
          scope: intent.scope,
          ...(selected.source?.manifestDigest ? { schemaIdentity: selected.source.manifestDigest } : {}),
          storeDigest: selected.impact?.storeDigest
            ?? digest({ exists: retryStore?.exists, rawDigest: retryStore?.rawDigest }),
          impactState: selected.impact?.impactState ?? 'known',
          ...(selected.impact?.noEffectiveChange ? { noEffectiveChange: true as const } : {}),
          affectedTargets: (selected.impact?.affectedTargets
            ?? relevantTargets).map(({ platform, scope }) => ({ platform, scope })),
          ...(selected.preApplyAuthorization.length > 0
            ? { preApplyAuthorization: selected.preApplyAuthorization }
            : {}),
          ...(selected.sharedNativeRenderTargets.length > 0
            ? { sharedNativeRenderTargets: selected.sharedNativeRenderTargets }
            : {}),
        },
      };
      if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    await preparation?.reporter.emit('status');
    const statusCatalogOperation = catalogOperation
      ?? (!freshCatalog ? sessionCatalogOperationContext : undefined);
    const status = await statusCommandV8({
      plugins: [intent.pluginId],
      ...(intent.scope === 'project'
        ? { scope: intent.scope }
        : {}),
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
      ? configAffectedStatusTargets(status.payload.targets, intent.pluginId, intent.scope)
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
              await coercePluginConfigUpdates({
                schema: plugin.manifest.config.fields,
                updates: intent.updates ?? {},
                cwd: context.cwd,
              });
              for (const key of intent.removeKeys ?? []) {
                if (!plugin.manifest.config.fields[key]) {
                  throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
                }
              }
            }
            const impact = intent.kind === 'configSave' && !intent.retryApply
              ? await analyzePluginConfigMutationImpact({
                  plugin,
                  scope: intent.scope,
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
            return {
              pluginName: plugin.manifest.name,
              source: sourceEvidenceForPlugin(source, plugin.manifest.name),
              impact,
              preApplyAuthorization: intent.kind === 'configSave'
                && configIntentRequestsApply(intent)
                ? (await resolveConfigPreApplyAuthorization({
                    plugin,
                    scope: intent.scope,
                    cwd: context.cwd,
                    env: context.env,
                    applyTargets: intent.retryApply
                      ? configImpactVisibleTargets(plugin.manifest.name, configVisibleTargets)
                      : impact!.affectedTargets,
                    nativeCliRunner: context.nativeCliRunner,
                    rebuildRuntime: {
                      ...(catalogOperation ? { catalogOperationContext: catalogOperation } : {}),
                      ...(catalogOperation?.generationSetDigest
                        ? { expectedGenerationSetDigest: catalogOperation.generationSetDigest }
                        : {}),
                      inventoryCatalogSourceReferences: operationInventory,
                    },
                  })).targets
                : [],
              sharedNativeRenderTargets: intent.kind === 'configSave'
                ? intent.retryApply
                  ? configRetrySharedNativeRenderTargets(plugin)
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
        compositeDigest: status.payload.catalog.compositeDigest,
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
      const retryStore = intent.retryApply ? await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        ...('logicalIdentity' in selected.source
          ? { logicalIdentity: selected.source.logicalIdentity }
          : {}),
        pluginName: selected.pluginName,
        scope: intent.scope,
        cwd: context.cwd,
        env: context.env,
      }) : undefined;
      signal?.throwIfAborted();
      evidence.config = {
        scope: intent.scope,
        ...('manifestDigest' in selected.source
          ? { schemaIdentity: selected.source.manifestDigest }
          : {}),
        storeDigest: impact?.storeDigest
          ?? digest({ exists: retryStore?.exists, rawDigest: retryStore?.rawDigest }),
        impactState: impact?.impactState ?? 'known',
        ...(impact?.noEffectiveChange ? { noEffectiveChange: true } : {}),
        affectedTargets: (impact?.affectedTargets
          ?? evidenceTargets).map(({ platform, scope }) => ({ platform, scope })),
        ...(intent.scope === 'project' ? {
          shareability: await inspectConfigShareability({
            sourceId: selected.source.sourceId,
            pluginName: selected.pluginName,
            scope: intent.scope,
            cwd: context.cwd,
            env: context.env,
          }),
        } : {}),
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
    if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
    return evidence;
  };

  const dependencies: TuiControllerDependencies = {
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
      let nativeSnapshot: Awaited<ReturnType<NonNullable<TuiControllerDependencies['loadScopedStatus']>>>['nativeSnapshot'] | undefined;
      const status = await readRecoveryStatus({
        scope, cwd: context.cwd, env: context.env, cliVersion: packageInfo.version,
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
        scope: request.scope, cwd: context.cwd, env: context.env,
        cliVersion: packageInfo.version,
        all: request.selectors.length === 0,
        ...(request.targets ? { targets: request.targets } : {}),
        ...(request.force ? { force: true } : {}),
        ...(request.refresh ? { refresh: true } : {}),
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
      const targets = intent.platform === 'both' ? ['codex', 'claude-code'] as const
        : [intent.platform === 'claude' ? 'claude-code' as const : 'codex' as const];
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
            await coercePluginConfigUpdates({
              schema: plugin.manifest.config.fields,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.fields[key]) {
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
    async getConfigGroups(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        env: context.env,
        signal,
        ...(sessionContextForPlugin(pluginId)
          ? { operationContext: sessionContextForPlugin(pluginId)! }
          : {}),
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRead = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: 'effective',
            cwd: context.cwd,
            env: context.env,
          });
          return buildConfigGroups({ schema: plugin.manifest.config, read, effectiveRead });
        },
      });
    },
    async getConfigPage(pluginId, layer, signal) {
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
          const stores = await readConfigStoresForTui({
            sourceId: plugin.sourceId,
            sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity,
            pluginName: plugin.manifest.name,
            schema: plugin.manifest.config.fields,
            scope: layer.scope,
            signal,
          });
          const userStore = stores.user;
          const projectStore = stores.project;
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRead = layer.scope === 'effective' ? read : await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: 'effective',
            cwd: context.cwd,
            env: context.env,
          });
          const layerReads = layer.scope === 'effective' ? undefined : {
            user: layer.scope === 'user' ? read : await resolveConfigRead({
              pluginName: plugin.manifest.name,
              plugin,
              scope: 'user',
              cwd: context.cwd,
              env: context.env,
            }),
            ...(layer.scope === 'user' ? {} : { project: read }),
          };
          const effectiveRaw = await resolveEffectivePluginConfig({
            sourceId: plugin.sourceId,
            sourceIdentity: plugin.sourceIdentity,
            logicalIdentity: plugin.catalogLogicalIdentity,
            pluginName: plugin.manifest.name,
            manifest: plugin.manifest,
            targetScope: layer.scope === 'user' ? 'user' : 'project',
            cwd: context.cwd,
            env: context.env,
          });
          const layerStore = layer.scope === 'effective'
            ? undefined
            : layer.scope === 'user' ? userStore : projectStore;
          const page = buildConfigPage({
            pluginId,
            schema: plugin.manifest.config,
            read,
            effectiveRead,
            ...(layerReads ? { layerReads } : {}),
            ...(layerStore ? { rawValues: layerStore.values } : {}),
            rawLayerValues: {
              user: userStore.values,
              ...(projectStore ? { project: projectStore.values } : {}),
            },
            effectiveRawValues: effectiveRaw.values,
            sharedNativeRefreshKeys: new Set(
              (plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
                target.target === 'codex.skill' && target.delivery.mode === 'codex-native'
                  ? target.refreshKeys
                  : []),
            ),
          });
          return { ...page, editEvidence: {
            sourceIdentity: source.sourceIdentity,
            schemaIdentity: source.manifestDigest,
            storeDigests: {
              user: digest({ exists: userStore.exists, rawDigest: userStore.rawDigest }),
              ...(projectStore ? { project: digest({ exists: projectStore.exists, rawDigest: projectStore.rawDigest }) } : {}),
            },
          } };
        },
      });
    },
    async getConfigResetAvailability(pluginId, layer, signal) {
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
        scope: layer.scope,
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
          scope: layer.scope,
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
              group.config.affectedTargets.map((target) => `${target.platform}\0${target.scope}`)));
            const approvedPreApplyTargets = reviewedBatch.groups.flatMap((group) =>
              group.config.preApplyAuthorization ?? []);
            const results: ConfigSaveBatchExecutionResult['groups'] = [];
            const packageInfo = await readCliPackageInfo();
            for (const group of intent.groups) {
              const groupIntent = configSaveBatchGroupIntent(intent, group);
              const reviewedGroup = reviewedBatch.groups.find((item) => item.scope === group.scope);
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
                  scope: group.scope,
                  cwd: context.cwd,
                  env: context.env,
                });
                if (freshLayerStoreDigest !== reviewedGroup.config.storeDigest) {
                  throw operationReviewStale('保存设置期间此设置层的原始内容发生变化。');
                }
                if (freshConfig.affectedTargets.some((target) =>
                  !approvedApplyTargets.has(`${target.platform}\0${target.scope}`))) {
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
                    const applyTargets = intent.apply
                      ? freshConfig.affectedTargets.map((target) => ({
                          pluginName: plugin.manifest.name,
                          platform: target.platform,
                          scope: target.scope,
                        }))
                      : [];
                    return applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: group.scope,
                      cwd: context.cwd,
                      env: context.env,
                      nativeCliRunner: context.nativeCliRunner,
                      rebuildRuntime: {
                        ...context,
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
                      applyTargets,
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
                  scope: group.scope,
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
                  scope: group.scope,
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
                scope: intent.scope,
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
                const applyTargets = intent.retryApply || intent.apply
                  ? currentEvidence.config?.affectedTargets.map((target) => ({
                      pluginName: plugin.manifest.name,
                      platform: target.platform,
                      scope: target.scope,
                    })) ?? []
                  : [];
                const result = intent.retryApply
                    ? await replayConfigRuntimeWrites({
                        plugin,
                        scope: intent.scope,
                        cwd: context.cwd,
                        env: context.env,
                        nativeCliRunner: context.nativeCliRunner,
                        rebuildRuntime: {
                          ...context,
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
                        applyTargets,
                        sharedNativeApplyConfirmed: true,
                        preApplyConfirmed: true,
                        preApplyAuthorizedTargets:
                          expectedEvidence.config?.preApplyAuthorization ?? [],
                      })
                    : await applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: intent.scope,
                      cwd: context.cwd,
                      env: context.env,
                      nativeCliRunner: context.nativeCliRunner,
                      rebuildRuntime: {
                        ...context,
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
                      applyTargets,
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
