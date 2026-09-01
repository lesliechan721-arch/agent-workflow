import crypto from 'node:crypto';
import path from 'node:path';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { CatalogSourceResolution, PlatformName, Scope } from '../types.js';
import {
  statusCommandV6,
  type StatusTargetRevision,
  type StatusV6Target,
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
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../commands/write-commands.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import {
  readCatalogSourcesConfigSnapshot,
} from '../utils/catalog-sources.js';
import {
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  formatPluginId,
  parsePluginId,
} from '../utils/multi-source-catalog.js';
import {
  coercePluginConfigUpdates,
  readNamespacedPluginConfigStoreIdentity,
  readPluginConfigStore,
  resolveConfigRead,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { DependencyOperationPlan } from '../commands/dependency-operation-plan.js';
import type { RebuildReviewPreflightEvidence } from '../commands/rebuild-command.js';
import {
  offlineCleanupEvidenceFromInventory,
  type OfflineCleanupTargetEvidence,
} from '../commands/offline-cleanup-evidence.js';
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type ReviewPreparationStageId,
  type TuiControllerDependencies,
} from './controller.js';
import {
  buildConfigGroups,
  buildConfigPage,
  isPureNativeCodexTarget,
  projectPlatformPlacement,
  type DependencyPlacementReferenceViewModel,
  type PlatformPlacementSummary,
  type PluginDependencyOverviewViewModel,
} from './model.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import {
  targetCanBeUninstalled,
  targetHasArtifactCollision,
} from '../utils/target-eligibility.js';
import { checkAwCapabilitySupport, readPluginManifest } from '../utils/manifest.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import {
  resolveCatalogOperationContext,
  resolvePartialCatalogOperationContext,
  selectCatalogOperationContext,
  type CatalogOperationContext,
} from '../utils/catalog-operation-context.js';
import type { CatalogStoreEntry } from '../utils/catalog-generation-store.js';
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
import {
  calculatePluginIntentDigest,
  canonicalizePluginIntentState,
  readPluginIntentState,
  writePluginIntentState,
} from '../utils/plugin-intent-state.js';

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
  targets: StatusV6Target[],
  revisions: StatusTargetRevision[] = [],
): string {
  return digest({
    targets: targets.map((target) => ({
      pluginId: target.pluginId,
      sourceIdentity: target.sourceIdentity,
      platform: target.platform,
      scope: target.scope,
      state: target.state,
      errors: target.errors.map((error) => error.code).sort(),
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
  targets: StatusV6Target[],
  pluginId: string,
  configScope: 'user' | 'project',
): StatusV6Target[] {
  return targets.filter((target) => target.pluginId === pluginId
    && (configScope === 'user' || target.scope === 'project')
    && (target.state === 'present' || target.state === 'partial'))
    .sort((left, right) => `${left.platform}\0${left.scope}`
      .localeCompare(`${right.platform}\0${right.scope}`, 'en'));
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
    target.errorCode === 'operationReviewStale');
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

function assertIntentIsLegal(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV6>>['payload']['targets'],
  revisions: StatusTargetRevision[] = [],
): void {
  const platforms: PlatformName[] = intent.platform === 'both'
    ? ['codex', 'claude']
    : [intent.platform];
  for (const platform of platforms) {
    const platformTargets = targets.filter((target) => target.pluginId === intent.pluginId
      && target.platform === platform);
    const selected = platformTargets.find((target) => target.scope === intent.scope)
      ?? (platform === 'codex' ? platformTargets[0] : undefined);
    if (!selected || selected.errors.some((error) => error.code === 'unsupportedTarget')) {
      throw new TuiOperationBlockedError('unsupportedTarget', '所选插件不支持这个平台和使用位置。');
    }
    if (intent.action === 'sync' && platform !== 'codex') {
      throw new TuiOperationBlockedError('syncPlatformUnsupported', 'sync 只支持 Codex。');
    }
    if (intent.dependencyPlacementOnly === 'desired') continue;
    const otherScope = intent.scope === 'user' ? 'project' : 'user';
    const otherScopeInstalled = platform === 'codex'
      ? platformTargets.some((target) =>
          target.desired.scopes.includes(otherScope)
          || target.activation?.[otherScope] === true)
      : targets.some((target) =>
          target.platform === platform
          && target.scope !== intent.scope
          && (target.state === 'present' || target.state === 'partial'));
    const pureNativeCodex = isPureNativeCodexTarget(selected);
    if (intent.action === 'install' && otherScopeInstalled && !pureNativeCodex
      && !intent.dependencyPlacementAdjustment) {
      throw new TuiOperationBlockedError('scopeConflict', '这个平台已安装在另一个使用位置。请先移除原位置。');
    }
    if ((intent.action === 'install' || intent.action === 'upgrade' || intent.action === 'reinstall')
      && targetHasArtifactCollision(selected)) {
      throw new TuiOperationBlockedError(
        'artifactCollision',
        '所选位置存在输出冲突。请先移除或迁移冲突内容。',
      );
    }
    const selectedScopeInstalled = platform === 'codex'
      ? selected.desired.scopes.includes(intent.scope)
        || selected.activation?.[intent.scope] === true
      : selected.state !== 'absent';
    if (intent.action === 'install' && selectedScopeInstalled
      && !intent.dependencyPlacementAdjustment) {
      throw new TuiOperationBlockedError('targetAlreadyInstalled', '所选位置已经安装。');
    }
    if (intent.action === 'sync'
      && selected.actual.state !== 'needsSync'
      && selected.actual.state !== 'drifted'
      && selected.actual.state !== 'conflict') {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不需要同步。');
    }
    const revision = revisions.find((entry) => entry.pluginId === intent.pluginId
      && entry.platform === platform && entry.scope === intent.scope)?.revision;
    if (intent.action === 'upgrade'
      && (selected.state !== 'present' || revision?.state !== 'upgradeAvailable')) {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不允许执行这个操作。');
    }
    if (intent.action === 'uninstall' && !targetCanBeUninstalled(selected.state)) {
      throw new TuiOperationBlockedError('targetStateChanged', '当前安装状态不允许执行这个操作。');
    }
    if ((intent.action === 'reinstall' || intent.action === 'cleanup') && selected.state === 'absent') {
      throw new TuiOperationBlockedError('targetAbsent', '所选位置没有可处理的 AW 安装。');
    }
  }
}

async function assertTypedIssueOrigin(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV6>>['payload']['targets'],
): Promise<void> {
  if (!intent.originIssue) return;
  const stale = (message: string): never => {
    throw new TuiOperationBlockedError('operationReviewStale', `operationReviewStale: ${message}`);
  };
  const selected = targets.find((target) =>
    target.pluginId === intent.pluginId
    && target.platform === intent.platform
    && target.scope === intent.scope)
    ?? targets.find((target) => target.pluginId === intent.pluginId
      && target.platform === 'codex');
  if (intent.originIssue.category === 'dependencyMissing') {
    if (intent.originIssue.actionId !== 'installDependency'
      || intent.action !== 'install' || !selected || selected.state !== 'absent') {
      stale('原缺失依赖问题已变化。');
    }
  }
  else if (intent.originIssue.category === 'dependencyNotReady') {
    if (intent.originIssue.actionId !== 'reinstallDependency'
      || intent.action !== 'reinstall' || !selected
      || (selected.state !== 'partial' && selected.state !== 'error')) {
      stale('原依赖安装问题已变化。');
    }
  }
  else if (intent.originIssue.category === 'incompleteInstallation') {
    if (!selected || !targetCanBeUninstalled(selected.state) || selected.state !== 'partial'
      || !((intent.originIssue.actionId === 'reinstall' && intent.action === 'reinstall')
        || (intent.originIssue.actionId === 'remove' && intent.action === 'uninstall'))) {
      stale('原安装问题已变化。');
    }
    return;
  }
  else if (intent.originIssue.category === 'sourceUnavailable') {
    if (intent.originIssue.actionId !== 'cleanup' || intent.action !== 'cleanup'
      || !selected || !selected.errors.some((error) => error.code === 'bundleUnavailable')) {
      stale('原 Catalog 缺失插件问题已变化。');
    }
    return;
  }
  else if (intent.originIssue.category === 'sourceMissing') {
    if (intent.originIssue.actionId !== 'cleanup' || intent.action !== 'cleanup'
      || !selected || !selected.errors.some((error) => error.code === 'sourceMissing')) {
      stale('原来源缺失问题已变化。');
    }
    return;
  }
  else if (intent.originIssue.category === 'scopeConflict') {
    const installedScopes = new Set<Scope>();
    for (const target of targets.filter((candidate) =>
      candidate.pluginId === intent.pluginId && candidate.platform === intent.platform)) {
      if (target.state === 'present' || target.state === 'partial') installedScopes.add(target.scope);
      for (const scope of target.desired.scopes) installedScopes.add(scope);
      if (target.activation?.user === true) installedScopes.add('user');
      if (target.activation?.project === true) installedScopes.add('project');
    }
    const correctBranch = intent.action === 'uninstall'
      && ((intent.originIssue.actionId === 'keepUserScope' && intent.scope === 'project')
        || (intent.originIssue.actionId === 'keepProjectScope' && intent.scope === 'user'));
    if (!correctBranch || !installedScopes.has('user') || !installedScopes.has('project')) {
      stale('原位置冲突已变化。');
    }
    return;
  }
  else stale('这个问题没有安全的自动写入动作。');

  const origin = intent.originIssue;
  if (!origin.consumerPluginId || !origin.consumerSourceIdentity || !origin.consumerPlatform
    || !origin.consumerScope || !origin.dependencyPluginId || !origin.dependencyPlatform
    || !origin.dependencyScope || origin.dependencyProject === undefined
    || origin.dependencyPluginId !== intent.pluginId
    || origin.dependencyPlatform !== intent.platform || origin.dependencyScope !== intent.scope) {
    stale('依赖问题来源缺少稳定目标证据。');
  }
  const consumer = targets.find((target) =>
    target.pluginId === origin.consumerPluginId
    && target.sourceIdentity === origin.consumerSourceIdentity
    && target.platform === origin.consumerPlatform
    && target.scope === origin.consumerScope);
  const consumerError = consumer?.errors.some((error) =>
    error.code === origin.category && error.message.includes(origin.dependencyPluginId!));
  if (!consumer || !consumerError) stale('原 consumer 依赖问题已消失或变化。');
}

interface DependencyCatalogNode {
  pluginId: string;
  displayName: string;
  dependencies: string[];
}

async function loadDependencyOverviews(options: {
  context: CliExecutionContext;
  cliVersion: string;
  status: Awaited<ReturnType<typeof statusCommandV6>>;
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
      target.errors.filter((error) => error.code.startsWith('dependency') || error.code === 'sourceChanged')
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
      if (inventoryOptions.includeHistoricalProjects === true) {
        return readInventory(inventoryOptions);
      }
      ordinaryInventory ??= readInventory(inventoryOptions);
      return ordinaryInventory;
    };
  };
  const catalogOperationByEvidence = new WeakMap<OperationEvidence, CatalogOperationContext>();
  let sessionCatalogOperationContext: CatalogOperationContext | undefined;
  let sessionStatusResult: Awaited<ReturnType<typeof statusCommandV6>> | undefined;
  const sessionContextForPlugin = (pluginId: string): CatalogOperationContext | undefined => {
    const sourceId = parsePluginId(pluginId).sourceId;
    if (!sourceId || !sessionCatalogOperationContext) return undefined;
    return selectCatalogOperationContext(sessionCatalogOperationContext, [sourceId]);
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
      }).catch(() => undefined);
    if (catalogOperationContext) sessionCatalogOperationContext = catalogOperationContext;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await statusCommandV6({
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
  ): Promise<OperationEvidence> => {
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
          referenceCount: preview.references.references.length,
          inventoryComplete: preview.references.errors.length === 0,
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
    if (preparation && (intent.kind === 'configSave' || intent.kind === 'configReset')) {
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
        operationContext: catalogOperation,
        ...(signal ? { signal } : {}),
        consume: async ({ plugin, source }) => {
          if (!plugin.manifest.config) {
            throw new TuiOperationBlockedError('configSchemaUnavailable', '这个插件没有设置 schema。');
          }
          if (intent.kind === 'configSave') {
            await coercePluginConfigUpdates({
              schema: plugin.manifest.config.schema,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.schema[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          }
          return {
            pluginName: plugin.manifest.name,
            source: sourceEvidenceForPlugin(source, plugin.manifest.name),
          };
        },
      });
      const store = await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        projectLayer: intent.projectLayer,
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
          generationSetDigest: catalogOperation.generationSetDigest,
        },
        source: selected.source,
        targetFingerprint: statusTargetFingerprint(relevantTargets, relevantRevisions),
        config: {
          scope: intent.scope,
          projectLayer: intent.projectLayer,
          schemaIdentity: selected.source.manifestDigest,
          storeDigest: digest({ exists: store.exists, values: store.values }),
          affectedTargets: relevantTargets.map(({ platform, scope }) => ({ platform, scope })),
        },
      };
      catalogOperationByEvidence.set(evidence, catalogOperation);
      return evidence;
    }
    await preparation?.reporter.emit('status');
    const statusCatalogOperation = offlineCleanupReason
      ? undefined
      : catalogOperation ?? (!freshCatalog ? sessionCatalogOperationContext : undefined);
    const status = await statusCommandV6({
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
    if (intent.kind === 'pluginWrite') {
      await assertTypedIssueOrigin(intent, status.payload.targets);
      if (preparation?.validateIntent) {
        assertIntentIsLegal(intent, status.payload.targets, status.targetRevisions);
      }
    }
    if (!offlineCleanupReason && !catalogOperation) {
      catalogOperation = await resolveCatalogOperationContext({
        sourceIds: [parsePluginId(intent.pluginId).sourceId!],
        configSnapshot,
        env: context.env,
        ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    let dependencyPlan: DependencyOperationPlan | undefined;
    let codexReconcilePlans: OperationEvidence['codexReconcilePlans'];
    await preparation?.reporter.emit('catalog');
    const offlineCleanupTarget = offlineCleanupReason && intent.kind === 'pluginWrite'
      ? status.payload.targets.find((target) => target.pluginId === intent.pluginId
        && target.platform === intent.platform
        && target.scope === intent.scope
        && target.errors.some((error) => error.code === offlineCleanupReason))
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
                schema: plugin.manifest.config.schema,
                updates: intent.updates ?? {},
                cwd: context.cwd,
              });
              for (const key of intent.removeKeys ?? []) {
                if (!plugin.manifest.config.schema[key]) {
                  throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
                }
              }
            }
            return {
              pluginName: plugin.manifest.name,
              source: sourceEvidenceForPlugin(source, plugin.manifest.name),
            };
          },
        });
    let codexManager: OperationEvidence['codexManager'];
    const hasDeclaredDependencies = (status.pluginSummaries.find((summary) =>
      summary.pluginId === intent.pluginId)?.dependencyTotalCount ?? 0) > 0;
    if (intent.kind === 'pluginWrite') {
      const command = {
        install: installWriteCommand,
        upgrade: upgradeWriteCommand,
        reinstall: reinstallWriteCommand,
        uninstall: uninstallWriteCommand,
        cleanup: cleanupWriteCommand,
        sync: installWriteCommand,
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
        previewDependencyPlanOnly: true,
        ...(intent.action === 'sync' ? { reconcileIntentOnly: true } : {}),
        ...(preparation ? {
          onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
            stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
        } : {}),
      });
      signal?.throwIfAborted();
      codexReconcilePlans = intent.dependencyPlacementOnly === 'desired'
        ? undefined
        : preview?.codexReconcilePlans;
      if (hasDeclaredDependencies
        && (intent.action === 'install'
          || intent.action === 'upgrade'
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
      if (managerPreview?.state === 'blocked' && intent.dependencyPlacementOnly !== 'desired') {
        const message = managerPreview.code === 'codexSystemCliUnsupported'
          ? '系统 Codex CLI 版本不受支持。请升级官方 Codex CLI 后重试。'
          : 'AW-managed Codex runtime 当前不可用。请重试、升级 AW，或安装官方 Codex CLI。';
        throw new TuiOperationBlockedError(
          managerPreview.code,
          `${managerPreview.code}: ${message}`,
        );
      }
      if (managerPreview && managerPreview.state !== 'blocked'
        && intent.dependencyPlacementOnly !== 'desired') {
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
    let projectIntentDigest: string | undefined;
    if (intent.kind === 'pluginWrite' && intent.dependencyPlacementOnly === 'desired') {
      if (intent.scope !== 'project') {
        throw new TuiOperationBlockedError(
          'dependencyPlacementScopeInvalid',
          '缩小依赖位置只能更新当前项目 desired intent。',
        );
      }
      projectIntentDigest = calculatePluginIntentDigest(await readPluginIntentState({
        scope: 'project',
        cwd: context.cwd,
        env: context.env,
      }));
      signal?.throwIfAborted();
    }
    const evidenceTargets = intent.kind === 'configSave' || intent.kind === 'configReset'
      ? configAffectedStatusTargets(status.payload.targets, intent.pluginId, intent.scope)
      : status.payload.targets;
    const evidenceRevisions = intent.kind === 'configSave' || intent.kind === 'configReset'
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
      ...(projectIntentDigest ? { projectIntentDigest } : {}),
      ...(codexReconcilePlans ? { codexReconcilePlans } : {}),
      ...(codexManager ? { codexManager } : {}),
      targetFingerprint: statusTargetFingerprint(
        evidenceTargets,
        evidenceRevisions,
      ),
    };
    if (intent.kind === 'configSave' || intent.kind === 'configReset') {
      const store = await readPluginConfigStore({
        sourceId: selected.source.sourceId,
        sourceIdentity: selected.source.sourceIdentity,
        pluginName: selected.pluginName,
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      signal?.throwIfAborted();
      evidence.config = {
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        schemaIdentity: selected.source.manifestDigest,
        storeDigest: digest({ exists: store.exists, values: store.values }),
        affectedTargets: evidenceTargets.map(({ platform, scope }) => ({ platform, scope })),
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
    async inspectSourceRemoval(_sourceId, signal) {
      signal.throwIfAborted();
      return {
        blocked: false,
        inventoryComplete: true,
        installationCount: 0,
        configCount: 0,
        lifecycleCount: 0,
        marketplaceCount: 0,
        dependencies: [],
      };
    },
    async prepareReviewEvidence(intent, signal, onStage) {
      const reporter = createReviewStageReporter({
        context,
        onStage,
        now: options.now ?? Date.now,
      });
      try {
        return await captureEvidence(intent, signal, {
          reporter,
          validateIntent: true,
        });
      } finally {
        await reporter.finish();
      }
    },
    async previewDependencyPlacement(intent, signal) {
      const evidence = await captureEvidence(intent, signal);
      return evidence.dependencyPlan;
    },
    async validateIntent(intent, signal) {
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
              schema: plugin.manifest.config.schema,
              updates: intent.updates ?? {},
              cwd: context.cwd,
            });
            for (const key of intent.removeKeys ?? []) {
              if (!plugin.manifest.config.schema[key]) {
                throw new TuiOperationBlockedError('unknownConfigKey', '设置字段已变化，请重新检查。');
              }
            }
          },
        });
        return;
      }
      if (intent.kind !== 'pluginWrite') return;
      signal.throwIfAborted();
      const packageInfo = await readCliPackageInfo();
      const pluginIds = [...new Set([intent.pluginId,
        ...(intent.originIssue?.consumerPluginId ? [intent.originIssue.consumerPluginId] : [])])];
      const offlineCleanup = intent.action === 'cleanup'
        && intent.originIssue?.actionId === 'cleanup'
        && (intent.originIssue.category === 'sourceMissing'
          || intent.originIssue.category === 'sourceUnavailable');
      const sourceIds = pluginIds.map((pluginId) => parsePluginId(pluginId).sourceId!);
      let catalogOperation = offlineCleanup
        ? undefined
        : sessionCatalogOperationContext
          ? selectCatalogOperationContext(sessionCatalogOperationContext, sourceIds)
          : undefined;
      const statusOptions = {
        plugins: pluginIds,
        platform: intent.platform,
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
        inventoryCatalogSourceReferences: readInventory,
      };
      let status = await statusCommandV6({
        ...statusOptions,
        ...(catalogOperation ? { catalogOperationContext: catalogOperation } : {}),
      });
      const platforms: PlatformName[] = intent.platform === 'both'
        ? ['codex', 'claude']
        : [intent.platform];
      const missingSelectedTarget = platforms.some((platform) =>
        !status.payload.targets.some((target) => target.pluginId === intent.pluginId
          && target.platform === platform
          && (platform === 'codex' || target.scope === intent.scope)));
      if (!offlineCleanup && !catalogOperation && missingSelectedTarget) {
        catalogOperation = await resolveCatalogOperationContext({
          sourceIds,
          env: context.env,
          validatedStoreEntries,
          validatingStoreEntries,
          signal,
        });
        status = await statusCommandV6({
          ...statusOptions,
          catalogOperationContext: catalogOperation,
        });
      }
      signal.throwIfAborted();
      await assertTypedIssueOrigin(intent, status.payload.targets);
      assertIntentIsLegal(intent, status.payload.targets, status.targetRevisions);
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
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRead = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: 'effective',
            projectLayer: layer.projectLayer,
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
          const read = await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: layer.scope,
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          const effectiveRead = layer.scope === 'effective' ? read : await resolveConfigRead({
            pluginName: plugin.manifest.name,
            plugin,
            scope: 'effective',
            projectLayer: layer.projectLayer,
            cwd: context.cwd,
            env: context.env,
          });
          const layerReads = layer.scope === 'effective' ? undefined : {
            user: await resolveConfigRead({
              pluginName: plugin.manifest.name,
              plugin,
              scope: 'user',
              projectLayer: 'shared',
              cwd: context.cwd,
              env: context.env,
            }),
            project: await resolveConfigRead({
              pluginName: plugin.manifest.name,
              plugin,
              scope: 'project',
              projectLayer: 'shared',
              cwd: context.cwd,
              env: context.env,
            }),
            local: await resolveConfigRead({
              pluginName: plugin.manifest.name,
              plugin,
              scope: 'project',
              projectLayer: 'local',
              cwd: context.cwd,
              env: context.env,
            }),
          };
          return buildConfigPage({
            pluginId,
            schema: plugin.manifest.config,
            read,
            effectiveRead,
            ...(layerReads ? { layerReads } : {}),
          });
        },
      });
    },
    async getConfigResetAvailability(pluginId, layer, signal) {
      signal.throwIfAborted();
      const { sourceId, pluginName } = parsePluginId(pluginId);
      if (!sourceId) return { exists: false, sourceIdentityPresent: false };
      const identity = await readNamespacedPluginConfigStoreIdentity({
        sourceId,
        pluginName,
        scope: layer.scope,
        projectLayer: layer.projectLayer,
        cwd: context.cwd,
        env: context.env,
      });
      signal.throwIfAborted();
      if (!identity) return { exists: false, sourceIdentityPresent: false };
      return {
        exists: true,
        sourceIdentityPresent: true,
        storeDigest: digest({
          exists: identity.store.exists,
          pluginId: identity.pluginId,
          values: identity.store.values,
        }),
      };
    },
    async executeIntent(intent, expectedEvidence) {
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
          runtime,
        };
        if (intent.action === 'add' && intent.source) {
          return addCatalogSourceCommand({ ...common, source: intent.source, cliVersion: packageInfo.version });
        }
        if (intent.action === 'update' && intent.update) {
          return updateCatalogSourceCommand({ ...common, sourceId: intent.sourceId, update: intent.update, cliVersion: packageInfo.version });
        }
        if (intent.action === 'setPrimary') {
          return setPrimaryCatalogSourceCommand({ ...common, sourceId: intent.sourceId });
        }
        if (intent.action === 'remove') {
          return removeCatalogSourceCommand({ ...common, sourceId: intent.sourceId });
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
          if (operationEvidenceFingerprint(currentEvidence) !== operationEvidenceFingerprint(expectedEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
          const catalogOperation = catalogOperationByEvidence.get(currentEvidence);
          if (expectedEvidence.catalog.generationSetDigest
            && catalogOperation?.generationSetDigest !== expectedEvidence.catalog.generationSetDigest) {
            throw operationReviewStale('确认后 Active Catalog generation 发生变化。');
          }
          await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
          if (intent.kind === 'pluginWrite') {
            if (intent.dependencyPlacementOnly === 'desired') {
              const plan = currentEvidence.dependencyPlan;
              if (!plan || !expectedEvidence.projectIntentDigest) {
                throw operationReviewStale('确认信息缺少依赖位置或 project intent 证据。');
              }
              const location = { scope: 'project' as const, cwd: context.cwd, env: context.env };
              const currentIntent = await readPluginIntentState(location);
              if (calculatePluginIntentDigest(currentIntent) !== expectedEvidence.projectIntentDigest) {
                throw operationReviewStale('确认后 project desired intent 发生变化。');
              }
              const plannedKeys = new Set(plan.targets.map((target) =>
                `${target.pluginId}\0${target.platform}`));
              const nextIntent = canonicalizePluginIntentState({
                ...currentIntent,
                dependencyScopeOverrides: [
                  ...currentIntent.dependencyScopeOverrides.filter((override) =>
                    !plannedKeys.has(`${override.pluginId}\0${override.platform}`)),
                  ...plan.scopeOverrides,
                ],
              });
              await writePluginIntentState(location, nextIntent);
              return { dependencyPlan: plan, desiredPlacementUpdated: true };
            }
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
              upgrade: upgradeWriteCommand,
              reinstall: reinstallWriteCommand,
              uninstall: uninstallWriteCommand,
              cleanup: cleanupWriteCommand,
              sync: installWriteCommand,
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
              ...(currentEvidence.dependencyPlan
                ? { expectedOperationDependencyPlan: currentEvidence.dependencyPlan }
                : {}),
              ...(currentEvidence.codexReconcilePlans
                ? { expectedCodexReconcilePlans: currentEvidence.codexReconcilePlans }
                : {}),
              ...(intent.action === 'sync' ? { reconcileIntentOnly: true } : {}),
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
                const applyTargets = currentEvidence.config?.affectedTargets.map((target) => ({
                  pluginName: plugin.manifest.name,
                  platform: target.platform,
                  scope: target.scope,
                })) ?? [];
                const result = intent.kind === 'configSave'
                  ? await applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: intent.scope,
                      projectLayer: intent.projectLayer,
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
                    })
                  : await resetPluginConfigWithHelper({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: intent.scope,
                      projectLayer: intent.projectLayer,
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
