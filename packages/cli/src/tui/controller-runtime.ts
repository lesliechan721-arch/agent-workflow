import crypto from 'node:crypto';
import path from 'node:path';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { CatalogSourceResolution, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
import {
  statusCommandV7,
  statusTargetIntent,
  type StatusTargetRevision,
  type StatusV7Target,
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
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  syncWriteCommand,
  uninstallWriteCommand,
} from '../commands/write-commands.js';
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
  readPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  replayConfigRuntimeWrites,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type { RebuildReviewPreflightEvidence } from '../commands/rebuild-command.js';
import {
  offlineCleanupEvidenceFromInventory,
  type OfflineCleanupTargetEvidence,
} from '../commands/offline-cleanup-evidence.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import {
  operationEvidenceMatches,
  operationEvidenceFingerprint,
  TuiConfigInvalidStoreError,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type ReviewPreparationStageId,
  type TuiControllerDependencies,
} from './controller.js';
import type { CatalogSessionReusableCandidate } from './catalog-sources/types.js';
import {
  buildConfigGroups,
  buildConfigPage,
  projectPlatformPlacement,
  type DependencyPlacementReferenceViewModel,
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
  syncCatalogSourceGeneration,
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
  installPortableSkills,
  preparePortableInstall,
  PortableCommandError,
} from '../portable/commands.js';
import {
  MANAGED_CODEX_PACKAGE_NAME,
  MANAGED_CODEX_VERSION,
} from '../utils/codex-manager.js';

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
  targets: StatusV7Target[],
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
      components: target.components.map((component) => [component.key, component.state])
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
  targets: StatusV7Target[],
  pluginId: string,
  configScope: 'user' | 'project',
): StatusV7Target[] {
  const affected = new Map<string, StatusV7Target>();
  for (const target of targets) {
    const intent = statusTargetIntent(target);
    if (target.pluginId !== pluginId || !intent.enabled) continue;
    for (const scope of intent.scopes) {
      if (configScope === 'project' && scope !== 'project') continue;
      affected.set(`${target.platform}\0${scope}`, { ...target, scope });
    }
  }
  return [...affected.values()]
    .sort((left, right) => `${left.platform}\0${left.scope}`
      .localeCompare(`${right.platform}\0${right.scope}`, 'en'));
}

function configSharedNativeRenderTargets(
  plugin: PluginMeta,
  changedKeys: readonly string[],
): Array<{ id: string; skillKey: string; refreshKeys: string[] }> {
  const changed = new Set(changedKeys);
  return (plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
    target.platform === 'codex'
      && target.target === 'codex.skill'
      && target.delivery.mode === 'codex-native'
      && target.skillKey
      && target.refreshKeys.some((key) => changed.has(key))
      ? [{ id: target.id, skillKey: target.skillKey, refreshKeys: [...target.refreshKeys] }]
      : []);
}

type OperationSourceEvidence = NonNullable<OperationEvidence['source']>;

function operationReviewStale(message: string): TuiOperationBlockedError {
  return new TuiOperationBlockedError('operationReviewStale', `operationReviewStale: ${message}`);
}

function sourceEvidenceForPlugin(
  source: CatalogSourceResolution,
  pluginName: string,
): OperationSourceEvidence {
  const entry = source.manifest.entries.find((candidate) => candidate.name === pluginName)!;
  return {
    sourceId: source.sourceId,
    sourceIdentity: source.sourceIdentity,
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

function assertSourceEvidenceMatches(
  expected: OperationSourceEvidence,
  actual: Pick<
    RebuildReviewPreflightEvidence,
    'sourceId' | 'sourceIdentity' | 'resolvedCommit' | 'manifestDigest' | 'snapshotDigest' | 'contentDigest'
  >,
): void {
  if (actual.sourceId !== expected.sourceId
    || actual.sourceIdentity !== expected.sourceIdentity
    || actual.resolvedCommit !== expected.resolvedCommit
    || actual.manifestDigest !== expected.manifestDigest
    || actual.snapshotDigest !== expected.snapshotDigest
    || actual.contentDigest !== expected.contentDigest) {
    throw operationReviewStale('确认后来源内容发生变化。');
  }
}

function throwIfWriteReviewStale(result: {
  targetResults: Array<{ errorCode?: string }>;
}): void {
  const stale = result.targetResults.find((target) =>
    target.errorCode === 'operationReviewStale'
    || target.errorCode === 'operationPlanStale');
  if (stale) {
    throw operationReviewStale('确认后实际写入计划发生变化。');
  }
}

const SOURCE_PROGRESS_PHASES: Record<CatalogSourceMutationProgress['stage'], string> = {
  savingConfig: '保存来源配置',
};

function pluginIntent(intent: OperationIntent): intent is Extract<OperationIntent, { pluginId: string }> {
  return 'pluginId' in intent;
}

interface DependencyCatalogNode {
  pluginId: string;
  displayName: string;
  dependencies: string[];
}

async function loadDependencyOverviews(options: {
  context: CliExecutionContext;
  cliVersion: string;
  status: Awaited<ReturnType<typeof statusCommandV7>>;
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
  const targetsByPlugin = new Map<string, typeof options.status.payload.targets>();
  for (const target of options.status.payload.targets) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const unsupportedPluginIds = new Set(options.status.pluginSummaries
    .filter((summary) => (summary.missingCapabilities?.length ?? 0) > 0)
    .map((summary) => summary.pluginId));
  const placementReferences = new Map<string, DependencyPlacementReferenceViewModel[]>();
  for (const consumer of options.status.payload.targets.filter((target) => target.state !== 'absent')) {
    const consumerNode = nodes.get(consumer.pluginId);
    if (!consumerNode) continue;
    for (const dependencyPluginId of consumerNode.dependencies) {
      const dependencyTargets = (targetsByPlugin.get(dependencyPluginId) ?? [])
        .filter((target) => target.platform === consumer.platform);
      const projectTarget = dependencyTargets.find((target) => target.scope === 'project');
      const userTarget = dependencyTargets.find((target) => target.scope === 'user');
      const dependencyScope = consumer.scope === 'user'
        ? 'user'
        : userTarget && (!projectTarget
          || (userTarget.state !== 'absent' && projectTarget.state === 'absent'))
          ? 'user'
          : 'project';
      const reference: DependencyPlacementReferenceViewModel = {
        consumer: {
          pluginId: consumer.pluginId,
          platform: consumer.platform,
          scope: consumer.scope,
          project: consumer.scope === 'project' ? 'current' : null,
        },
        dependency: {
          pluginId: dependencyPluginId,
          platform: consumer.platform,
          scope: dependencyScope,
          project: dependencyScope === 'project' ? 'current' : null,
        },
      };
      const key = `${consumer.pluginId}\0${dependencyPluginId}`;
      placementReferences.set(key, [...(placementReferences.get(key) ?? []), reference]);
    }
  }
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
        placementReferences: placementReferences.get(`${pluginId}\0${dependency.pluginId}`) ?? [],
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
        placementReferences: placementReferences.get(`${dependentId}\0${pluginId}`) ?? [],
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
  let sessionStatusResult: Awaited<ReturnType<typeof statusCommandV7>> | undefined;
  const sessionContextForPlugin = (pluginId: string): CatalogOperationContext | undefined => {
    const sourceId = parsePluginId(pluginId).sourceId;
    if (!sourceId || !sessionCatalogOperationContext) return undefined;
    return selectCatalogOperationContext(sessionCatalogOperationContext, [sourceId]);
  };
  const readConfigStoresForTui = async (config: {
    sourceId?: string;
    sourceIdentity?: string;
    pluginName: string;
    schema: PluginConfigSchema['fields'];
    scope: Scope | 'effective';
    signal: AbortSignal;
  }) => {
    const scopes = config.scope === 'user' ? ['user'] as const : ['user', 'project'] as const;
    const stores = await Promise.all(scopes.map((scope) => readPluginConfigStore({
      sourceId: config.sourceId,
      sourceIdentity: config.sourceIdentity,
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
      const result = await statusCommandV7({
        cwd: context.cwd,
        env: context.env,
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
      const statusById = new Map(result.payload.catalog.sources.map((source) => [source.id, source]));
      return {
        cliChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
        payload: result.payload,
        pluginSummaries: result.pluginSummaries,
        targetRevisions: result.targetRevisions,
        dependencyOverviews,
        portablePluginIds,
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
      let source: OperationEvidence['source'];
      try {
        const packageInfo = await readCliPackageInfo();
        source = await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          env: context.env,
          ...(preparation && sessionContextForPlugin(intent.pluginId)
            ? { operationContext: sessionContextForPlugin(intent.pluginId)! }
            : {}),
          ...(signal ? { signal } : {}),
          consume: async ({ plugin, source: resolvedSource }) =>
            sourceEvidenceForPlugin(resolvedSource, plugin.manifest.name),
        });
      } catch {
        source = undefined;
      }
      signal?.throwIfAborted();
      const relevantTargets = sessionStatusResult
        ? configAffectedStatusTargets(
            sessionStatusResult.payload.targets,
            intent.pluginId,
            intent.scope,
          )
        : [];
      await preparation?.reporter.emit('evidence');
      return {
        catalog: sessionStatusResult ? {
          configDigest: sessionStatusResult.payload.catalog.configDigest,
          compositeDigest: sessionStatusResult.payload.catalog.compositeDigest,
        } : {
          configDigest: 'config-reset-offline',
          compositeDigest: 'config-reset-target',
        },
        ...(source ? { source } : {}),
        config: {
          scope: intent.scope,
          storeDigest: target.fingerprint,
          affectedTargets: relevantTargets.map(({ platform, scope }) => ({ platform, scope })),
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
          impactSchemaVersion: 1,
          sourceId: preview.sourceId,
          inventoryComplete: preview.references.inventoryComplete,
          references: preview.references.references,
          affectedReferences: preview.references.references,
          changes: { added: [], removed: [], changed: [], newlyIncompatible: [], dependencyChanged: [] },
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
      const impact = intent.action === 'repair' ? undefined
        : sourceIdentityChangeImpact ?? await inspectCatalogSourceImpact({
          sourceId: intent.sourceId,
          cwd: context.cwd,
          env: context.env,
          sourcePrimary: comparisonSource?.primary === true,
          mode: 'generation',
          candidateManifest: probe.manifest,
        });
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
            impactSchemaVersion: 1,
            sourceId: preview.sourceId,
            inventoryComplete: preview.references.inventoryComplete,
            references: preview.references.references,
            affectedReferences: preview.references.references,
            changes: { added: [], removed: [], changed: [], newlyIncompatible: [], dependencyChanged: [] },
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
    if (!pluginIntent(intent)) {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    signal?.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const offlineCleanupReason: OfflineCleanupTargetEvidence['reason'] | undefined =
      intent.kind === 'pluginWrite'
      && intent.action === 'cleanup'
      && intent.originIssue?.actionId === 'cleanup'
      && (intent.originIssue?.category === 'sourceMissing'
        || intent.originIssue?.category === 'sourceUnavailable')
        ? intent.originIssue.category === 'sourceMissing' ? 'sourceMissing' : 'bundleUnavailable'
        : undefined;
    let catalogOperation: CatalogOperationContext | undefined;
    let catalogOperationError: unknown;
    if (!offlineCleanupReason && intent.kind !== 'portableInstall') {
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
      const portableSourceId = parsePluginId(intent.pluginId).sourceId!;
      const portableCatalogOperation = sessionCatalogOperationContext
        ? selectCatalogOperationContext(sessionCatalogOperationContext, [portableSourceId])
        : undefined;
      const portable = await preparePortableInstall({
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
      const selected = await withResolvedCatalogPlugin({
        selector: intent.pluginId,
        cliVersion: packageInfo.version,
        configSnapshot,
        env: context.env,
        ...(catalogOperation ? { operationContext: catalogOperation } : {}),
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
          return {
            pluginName: plugin.manifest.name,
            source: sourceEvidenceForPlugin(source, plugin.manifest.name),
            sharedNativeRenderTargets: intent.kind === 'configSave'
              ? configSharedNativeRenderTargets(plugin, [
                  ...Object.keys(intent.updates ?? {}),
                  ...(intent.removeKeys ?? []),
                ])
              : [],
          };
        },
      });
      const store = await readPluginConfigStore({
        sourceId: selected.source?.sourceId ?? parsePluginId(intent.pluginId).sourceId,
        ...(selected.source?.sourceIdentity
          ? { sourceIdentity: selected.source.sourceIdentity }
          : {}),
        pluginName: selected.pluginName,
        scope: intent.scope,
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      const relevantTargets = configAffectedStatusTargets(
        sessionStatusResult.payload.targets,
        intent.pluginId,
        intent.scope,
      );
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
          storeDigest: digest({ exists: store.exists, rawDigest: store.rawDigest }),
          affectedTargets: relevantTargets.map(({ platform, scope }) => ({ platform, scope })),
          ...(selected.sharedNativeRenderTargets.length > 0
            ? { sharedNativeRenderTargets: selected.sharedNativeRenderTargets }
            : {}),
        },
      };
      if (catalogOperation) catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    await preparation?.reporter.emit('status');
    const statusCatalogOperation = offlineCleanupReason
      ? undefined
      : catalogOperation ?? (!freshCatalog ? sessionCatalogOperationContext : undefined);
    const status = await statusCommandV7({
      plugins: [...new Set([intent.pluginId,
        ...(intent.kind === 'pluginWrite' && intent.originIssue?.consumerPluginId
          ? [intent.originIssue.consumerPluginId] : [])])],
      ...('platform' in intent ? { platform: intent.platform } : {}),
      ...(intent.kind !== 'pluginWrite' && intent.scope === 'project'
        ? { scope: intent.scope }
        : {}),
      cwd: context.cwd,
      env: context.env,
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
    if (!offlineCleanupReason && !catalogOperation) {
      catalogOperation = await resolveCatalogOperationContext({
        sourceIds: [parsePluginId(intent.pluginId).sourceId!],
        configSnapshot,
        env: context.env,
        ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    let dependencyPlan: ReconcileOperationPlan | undefined;
    let codexReconcilePlans: OperationEvidence['codexReconcilePlans'];
    let operationPlan: OperationEvidence['operationPlan'];
    await preparation?.reporter.emit('catalog');
    const offlineCleanupTarget = offlineCleanupReason && intent.kind === 'pluginWrite'
      ? status.payload.targets.find((target) => target.pluginId === intent.pluginId
        && target.platform === intent.platform
        && target.scope === intent.scope
        && target.reasons.some((error) => error.code === offlineCleanupReason))
      : undefined;
    const catalogSource = offlineCleanupTarget
      ? status.payload.catalog.sources.find((source) => source.id === offlineCleanupTarget.sourceId)
      : undefined;
    let offlineCleanup: OfflineCleanupTargetEvidence | undefined;
    if (offlineCleanupReason && offlineCleanupTarget) {
      await preparation?.reporter.emit('inventory');
      const inventory = await operationInventory({
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      offlineCleanup = offlineCleanupEvidenceFromInventory({
        reason: offlineCleanupReason,
        pluginId: offlineCleanupTarget.pluginId,
        pluginName: offlineCleanupTarget.pluginName,
        sourceId: offlineCleanupTarget.sourceId,
        sourceIdentity: offlineCleanupTarget.sourceIdentity,
        platform: offlineCleanupTarget.platform,
        scope: offlineCleanupTarget.scope,
        inventory,
      }) ?? undefined;
      if (!offlineCleanup) {
        throw operationReviewStale('离线清理现场证据已消失或无法验证。');
      }
    }
    const selected = offlineCleanupTarget
      ? {
          pluginName: offlineCleanupTarget.pluginName,
          source: {
            sourceId: offlineCleanupTarget.sourceId,
            sourceIdentity: offlineCleanupTarget.sourceIdentity,
            ...(catalogSource?.requestedRef ? { requestedRef: catalogSource.requestedRef } : {}),
            ...(catalogSource?.resolvedCommit ? { resolvedCommit: catalogSource.resolvedCommit } : {}),
          },
        }
      : await withResolvedCatalogPlugin({
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
            return {
              pluginName: plugin.manifest.name,
              source: sourceEvidenceForPlugin(source, plugin.manifest.name),
              sharedNativeRenderTargets: intent.kind === 'configSave'
                ? configSharedNativeRenderTargets(plugin, [
                    ...Object.keys(intent.updates ?? {}),
                    ...(intent.removeKeys ?? []),
                  ])
                : [],
            };
          },
        });
    let codexManager: OperationEvidence['codexManager'];
    const hasDeclaredDependencies = (status.pluginSummaries.find((summary) =>
      summary.pluginId === intent.pluginId)?.dependencyTotalCount ?? 0) > 0;
    if (intent.kind === 'pluginWrite') {
      const command = {
        install: installWriteCommand,
        refreshAndSync: syncWriteCommand,
        reinstall: reinstallWriteCommand,
        uninstall: uninstallWriteCommand,
        cleanup: cleanupWriteCommand,
        sync: syncWriteCommand,
      }[intent.action];
      const preview = await command([intent.pluginId], {
        cwd: context.cwd,
        platform: intent.platform,
        scope: intent.scope,
        ...(intent.action === 'install' && intent.dependencyScopeOverrides
          ? { dependencyScopeOverrides: intent.dependencyScopeOverrides }
          : {}),
        ...(intent.action === 'cleanup' ? { force: intent.force === true } : {}),
      }, {
        ...context,
        inventoryCatalogSourceReferences: operationInventory,
        expectedCatalogConfigDigest: status.payload.catalog.configDigest,
        ...(catalogOperation ? {
          catalogOperationContext: catalogOperation,
          expectedGenerationSetDigest: catalogOperation.generationSetDigest,
        } : {}),
        previewOperationPlan: true,
        ...(preparation ? {
          onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
            stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
        } : {}),
      });
      signal?.throwIfAborted();
      codexReconcilePlans = preview?.codexReconcilePlans;
      operationPlan = preview?.operationPlan;
      if (hasDeclaredDependencies
        && (intent.action === 'install'
          || intent.action === 'refreshAndSync'
          || intent.action === 'reinstall'
          || intent.action === 'sync')) {
        dependencyPlan = preview.dependencyPlan;
        if (!dependencyPlan) {
          throw new TuiOperationBlockedError('dependencyGraphInvalid', '无法建立可信的依赖安装计划。');
        }
        const blocker = dependencyPlan.targets.find((target) => target.action === 'block');
        if (blocker) {
          throw new TuiOperationBlockedError(
            blocker.errorCode ?? 'dependencyNotReady',
            `${blocker.errorCode ?? 'dependencyNotReady'}: 依赖安装计划被阻止。`,
          );
        }
      }
      const managerPreview = preview?.codexManagerPreview;
      if (managerPreview?.state === 'blocked') {
        const message = managerPreview.code === 'codexSystemCliUnsupported'
          ? '系统 Codex CLI 版本不受支持。请升级官方 Codex CLI 后重试。'
          : 'AW-managed Codex runtime 当前不可用。请重试、升级 AW，或安装官方 Codex CLI。';
        throw new TuiOperationBlockedError(
          managerPreview.code,
          `${managerPreview.code}: ${message}`,
        );
      }
      if (managerPreview) {
        codexManager = {
          state: managerPreview.state,
          packageName: MANAGED_CODEX_PACKAGE_NAME,
          version: managerPreview.state === 'requires-install'
            ? MANAGED_CODEX_VERSION
            : managerPreview.manager.version,
        };
      }
    }
    await preparation?.reporter.emit('evidence');
    signal?.throwIfAborted();
    const evidenceTargets = intent.kind === 'configSave'
      ? configAffectedStatusTargets(status.payload.targets, intent.pluginId, intent.scope)
      : status.payload.targets;
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
      ...(offlineCleanup ? { offlineCleanup } : {}),
      ...(dependencyPlan ? { dependencyPlan } : {}),
      ...(codexReconcilePlans ? { codexReconcilePlans } : {}),
      ...(operationPlan ? { operationPlan } : {}),
      ...(codexManager ? { codexManager } : {}),
      targetFingerprint: statusTargetFingerprint(
        evidenceTargets,
        evidenceRevisions,
      ),
    };
    if (intent.kind === 'configSave') {
      const store = await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      evidence.config = {
        scope: intent.scope,
        ...('manifestDigest' in selected.source
          ? { schemaIdentity: selected.source.manifestDigest }
          : {}),
        storeDigest: digest({ exists: store.exists, rawDigest: store.rawDigest }),
        affectedTargets: evidenceTargets.map(({ platform, scope }) => ({ platform, scope })),
        ...('sharedNativeRenderTargets' in selected
          && selected.sharedNativeRenderTargets.length > 0
          ? { sharedNativeRenderTargets: selected.sharedNativeRenderTargets }
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
        const preparationWarnings: string[] = [];
        if (intent.kind === 'pluginWrite' && intent.action === 'refreshAndSync') {
          await reporter.emit('refresh');
          const packageInfo = await readCliPackageInfo();
          const sourceId = parsePluginId(intent.pluginId).sourceId!;
          await syncCatalogSourceGeneration({
            sourceId,
            cliVersion: packageInfo.version,
            cwd: context.cwd,
            env: context.env,
            signal,
          }).catch((error) => {
            preparationWarnings.push(
              `catalogSourceRefreshFailed: ${sourceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          sessionCatalogOperationContext = undefined;
          sessionStatusResult = undefined;
          validatedStoreEntries.clear();
          validatingStoreEntries.clear();
        }
        const evidence = await captureEvidence(intent, signal, {
          reporter,
          validateIntent: true,
        }, createOperationInventoryReader(), intent.kind === 'pluginWrite'
          && intent.action === 'refreshAndSync', reusableCandidate);
        if (preparationWarnings.length > 0) evidence.preparationWarnings = preparationWarnings;
        return evidence;
      } finally {
        await reporter.finish();
      }
    },
    async previewDependencyPlacement(intent, signal) {
      const evidence = await captureEvidence(intent, signal);
      return evidence.dependencyPlan;
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
        consume: async ({ plugin }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          const stores = await readConfigStoresForTui({
            sourceId: plugin.sourceId,
            sourceIdentity: plugin.sourceIdentity,
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
            pluginName: plugin.manifest.name,
            manifest: plugin.manifest,
            targetScope: layer.scope === 'user' ? 'user' : 'project',
            cwd: context.cwd,
            env: context.env,
          });
          const layerStore = layer.scope === 'effective'
            ? undefined
            : layer.scope === 'user' ? userStore : projectStore;
          return buildConfigPage({
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
        },
      });
    },
    async getConfigResetAvailability(pluginId, layer, signal) {
      const parsed = parsePluginId(pluginId);
      if (!parsed.sourceId || !parsed.pluginName) {
        throw new TuiOperationBlockedError('invalidPluginId', '设置目标必须使用 canonical pluginId。');
      }
      let sourceIdentity: string | undefined;
      try {
        const packageInfo = await readCliPackageInfo();
        sourceIdentity = await withResolvedCatalogPlugin({
          selector: pluginId,
          cliVersion: packageInfo.version,
          env: context.env,
          signal,
          ...(sessionContextForPlugin(pluginId)
            ? { operationContext: sessionContextForPlugin(pluginId)! }
            : {}),
          consume: async ({ source }) => source.sourceIdentity,
        });
      } catch {
        sourceIdentity = undefined;
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
            await addCatalogSourceCommand({ ...common, source: intent.sourceMutation.source });
          } else {
            await updateCatalogSourceCommand({
              ...common,
              sourceId: intent.sourceId,
              update: intent.sourceMutation.update,
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
              });
              primaryChanged = true;
            } catch (error) {
              return {
                status: 'partial',
                partialReason: 'primary',
                configSaved,
                generation,
                activeAvailable: true,
                errorCode: error instanceof Error ? error.name : 'catalogSourcePrimaryFailed',
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
          expectedImpactDigest: expectedEvidence.sourceWrite?.impactDigest,
          runtime,
        };
        if (intent.action === 'add' && intent.source) {
          return addCatalogSourceCommand({ ...common, source: intent.source, cliVersion: packageInfo.version });
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
          return setPrimaryCatalogSourceCommand({ ...common, sourceId: intent.sourceId });
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
          const currentEvidence = await captureEvidence(
            intent,
            undefined,
            undefined,
            operationInventory,
            true,
          );
          if (intent.kind !== 'pluginWrite'
            && !operationEvidenceMatches(expectedEvidence, currentEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
          const catalogOperation = catalogOperationByEvidence.get(currentEvidence);
          if (expectedEvidence.catalog.generationSetDigest
            && catalogOperation?.generationSetDigest !== expectedEvidence.catalog.generationSetDigest) {
            throw operationReviewStale('确认后 Active Catalog generation 发生变化。');
          }
          await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
          if (intent.kind === 'pluginWrite') {
            const options = {
              cwd: context.cwd,
              platform: intent.platform,
              scope: intent.scope,
              ...(intent.action === 'install' && intent.dependencyScopeOverrides
                ? { dependencyScopeOverrides: intent.dependencyScopeOverrides }
                : {}),
              ...(expectedEvidence.codexManager?.state === 'requires-install'
                ? { allowManagedCodexInstall: true }
                : {}),
              ...(intent.action === 'cleanup' ? { force: intent.force === true } : {}),
            };
            const command = {
              install: installWriteCommand,
              refreshAndSync: syncWriteCommand,
              reinstall: reinstallWriteCommand,
              uninstall: uninstallWriteCommand,
              cleanup: cleanupWriteCommand,
              sync: syncWriteCommand,
            }[intent.action];
            const currentSource = currentEvidence.source;
            const offlineCleanup = currentEvidence.offlineCleanup;
            if (!offlineCleanup && (!expectedEvidence.source || !currentSource)) {
              throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少来源身份。');
            }
            const result = await command([intent.pluginId], options, {
              ...context,
              awHomeMutationToken,
              inventoryCatalogSourceReferences: operationInventory,
              ...(expectedEvidence.operationPlan
                ? { expectedPlanFingerprint: expectedEvidence.operationPlan.planFingerprint }
                : {}),
              expectedCatalogConfigDigest: expectedEvidence.catalog.configDigest,
              ...(catalogOperation ? {
                catalogOperationContext: catalogOperation,
                expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
              } : {}),
              ...(expectedEvidence.codexManager?.state === 'requires-install'
                ? { managedCodexAuthorizer: async () => true }
                : {}),
              ...(offlineCleanup
                ? { expectedOfflineCleanupEvidence: offlineCleanup }
                : { reviewPreflight: (actual: RebuildReviewPreflightEvidence) =>
                    assertSourceEvidenceMatches(currentSource!, actual) }),
            });
            throwIfWriteReviewStale(result);
            return result;
          }
          if (intent.kind === 'configSave' || intent.kind === 'configReset') {
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
                const applyTargets = intent.apply
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
                          ...(catalogOperation ? {
                            catalogOperationContext: catalogOperation,
                            expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
                          } : {}),
                        },
                        awHomeMutationToken,
                        applyTargets,
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
                        ...(catalogOperation ? {
                          catalogOperationContext: catalogOperation,
                          expectedGenerationSetDigest: expectedEvidence.catalog.generationSetDigest,
                        } : {}),
                      },
                      awHomeMutationToken,
                      applyTargets,
                      request: { updates: intent.updates, removeKeys: intent.removeKeys },
                      });
                return result;
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
