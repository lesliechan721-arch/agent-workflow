import crypto from 'node:crypto';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { CatalogFreshnessPolicy, CatalogSourceResolution, PlatformName } from '../types.js';
import { statusCommandV4 } from '../commands/status-v4.js';
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
import { inventoryCatalogSourceReferences } from '../utils/catalog-source-references.js';
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
  operationEvidenceFingerprint,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
} from './controller.js';
import {
  buildConfigGroups,
  buildConfigPage,
  projectPlatformPlacement,
  type PlatformPlacementSummary,
  type PluginDependencyOverviewViewModel,
} from './model.js';
import { projectCatalogSourceLocation } from '../utils/catalog-source-presentation.js';
import { targetCanBeUninstalled } from '../utils/target-eligibility.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import { inventoryInstallationContracts } from '../utils/installation-contract-store.js';
import { resolveCanonicalRepoProjectKey } from '../utils/state-paths.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';

export interface TuiControllerRuntimeTestHooks {
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
    target.errorCode === 'operationReviewStale' || target.errorCode === 'dependencyPlanStale');
  if (stale) {
    throw operationReviewStale('确认后实际写入计划发生变化。');
  }
}

const SOURCE_PROGRESS_PHASES: Record<CatalogSourceMutationProgress['stage'], string> = {
  validatingCandidate: '验证候选来源',
  catalogReady: 'Catalog 已读取，索引已刷新',
  scanningReferences: '扫描现有引用和约束',
  savingConfig: '保存来源配置',
};

function pluginIntent(intent: OperationIntent): intent is Extract<OperationIntent, { pluginId: string }> {
  return 'pluginId' in intent;
}

function assertIntentIsLegal(
  intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
  targets: Awaited<ReturnType<typeof statusCommandV4>>['payload']['targets'],
): void {
  const platforms: PlatformName[] = intent.platform === 'both'
    ? ['codex', 'claude']
    : [intent.platform];
  for (const platform of platforms) {
    const selected = targets.find((target) => target.platform === platform && target.scope === intent.scope);
    if (!selected || selected.errors.some((error) => error.code === 'unsupportedTarget')) {
      throw new TuiOperationBlockedError('unsupportedTarget', '所选插件不支持这个平台和使用位置。');
    }
    const otherScopeInstalled = targets.some((target) =>
      target.platform === platform
      && target.scope !== intent.scope
      && (target.state === 'present' || target.state === 'partial'));
    if (intent.action === 'install' && otherScopeInstalled) {
      throw new TuiOperationBlockedError('scopeConflict', '这个平台已安装在另一个使用位置。请先移除原位置。');
    }
    if (intent.action === 'install' && selected.state !== 'absent') {
      throw new TuiOperationBlockedError('targetAlreadyInstalled', '所选位置已经安装。');
    }
    if (intent.action === 'upgrade' && selected.state !== 'present') {
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
  targets: Awaited<ReturnType<typeof statusCommandV4>>['payload']['targets'],
  context: CliExecutionContext,
): Promise<void> {
  if (!intent.originIssue) return;
  const stale = (message: string): never => {
    throw new TuiOperationBlockedError('operationReviewStale', `operationReviewStale: ${message}`);
  };
  const selected = targets.find((target) =>
    target.pluginId === intent.pluginId
    && target.platform === intent.platform
    && target.scope === intent.scope);
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
  else if (intent.originIssue.category === 'scopeConflict') {
    const installedScopes = new Set(targets.filter((target) =>
      target.pluginId === intent.pluginId
      && target.platform === intent.platform
      && (target.state === 'present' || target.state === 'partial')).map((target) => target.scope));
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
  const currentProjectKey = await resolveCanonicalRepoProjectKey(context.cwd);
  const inventory = await inventoryInstallationContracts({ env: context.env });
  if (inventory.errors.length > 0) stale('依赖安装记录当前不能完整验证。');
  const contract = inventory.contracts.find((candidate) =>
    candidate.metadata.pluginId === origin.consumerPluginId
    && candidate.metadata.sourceIdentity === origin.consumerSourceIdentity
    && candidate.metadata.platform === origin.consumerPlatform
    && candidate.metadata.scope === origin.consumerScope
    && (origin.consumerScope === 'user' || candidate.metadata.projectKey === currentProjectKey));
  const dependency = contract?.metadata.dependencies.find((candidate) =>
    candidate.pluginId === origin.dependencyPluginId
    && candidate.platform === origin.dependencyPlatform
    && candidate.scope === origin.dependencyScope
    && (candidate.scope === 'user'
      ? origin.dependencyProject === null
      : candidate.projectKey === currentProjectKey
        ? origin.dependencyProject === 'current'
        : origin.dependencyProject === 'other'));
  if (!dependency) stale('依赖安装目标映射已变化。');
}

interface DependencyCatalogNode {
  pluginId: string;
  displayName: string;
  dependencies: string[];
}

async function loadDependencyOverviews(options: {
  context: CliExecutionContext;
  cliVersion: string;
  status: Awaited<ReturnType<typeof statusCommandV4>>;
  signal: AbortSignal;
}): Promise<PluginDependencyOverviewViewModel[]> {
  const currentProjectKey = await resolveCanonicalRepoProjectKey(options.context.cwd);
  const [graph, inventory] = await Promise.all([
    withResolvedMultiSourceCatalog({
      cliVersion: options.cliVersion,
      freshnessPolicy: 'cacheFirst',
      env: options.context.env,
      signal: options.signal,
      consume: async (catalog) => ({
        nodes: (await Promise.all(catalog.sources.flatMap((item) => item.resolution
          ? [resolvePluginsFromCatalog(item.resolution.rootDir, undefined).then((plugins) =>
              plugins.map((plugin): DependencyCatalogNode => ({
                pluginId: formatPluginId({
                  sourceId: item.resolution!.sourceId,
                  pluginName: plugin.manifest.name,
                }),
                displayName: plugin.manifest.interface?.displayName ?? plugin.manifest.name,
                dependencies: (plugin.manifest.dependencies ?? []).map((pluginName) =>
                  formatPluginId({ sourceId: item.resolution!.sourceId, pluginName })),
              }))) ] : []))).flat(),
        sourceErrors: catalog.sources.flatMap((item) => item.error
          ? [{ sourceId: item.sourceId, code: 'dependencyGraphInvalid' }]
          : []),
      }),
    }),
    inventoryInstallationContracts({ env: options.context.env }),
  ]);
  const nodes = new Map(graph.nodes.map((node) => [node.pluginId, node]));
  const displayName = (pluginId: string): string => nodes.get(pluginId)?.displayName
    ?? parsePluginId(pluginId).pluginName;
  const contractsByPlugin = new Map<string, typeof inventory.contracts>();
  const reverse = new Map<string, Array<{
    consumer: { pluginId: string; platform: PlatformName; scope: 'user' | 'project'; project: 'current' | 'other' | null };
    dependency: { pluginId: string; platform: PlatformName; scope: 'user' | 'project'; project: 'current' | 'other' | null };
  }>>();
  const projectDescriptor = (scope: 'user' | 'project', projectKey: string | null): 'current' | 'other' | null =>
    scope === 'user' ? null : projectKey === currentProjectKey ? 'current' : 'other';
  for (const contract of inventory.contracts) {
    contractsByPlugin.set(contract.metadata.pluginId, [
      ...(contractsByPlugin.get(contract.metadata.pluginId) ?? []),
      contract,
    ]);
    for (const dependency of contract.metadata.dependencies) {
      const references = reverse.get(dependency.pluginId) ?? [];
      references.push({
        consumer: {
          pluginId: contract.metadata.pluginId,
          platform: contract.metadata.platform,
          scope: contract.metadata.scope,
          project: projectDescriptor(contract.metadata.scope, contract.metadata.projectKey),
        },
        dependency: {
          pluginId: dependency.pluginId,
          platform: dependency.platform,
          scope: dependency.scope,
          project: projectDescriptor(dependency.scope, dependency.projectKey),
        },
      });
      reverse.set(dependency.pluginId, references);
    }
  }
  const targetsByPlugin = new Map<string, typeof options.status.payload.targets>();
  for (const target of options.status.payload.targets) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const placementsFor = (pluginId: string): PlatformPlacementSummary[] => {
    const targets = targetsByPlugin.get(pluginId) ?? [];
    if (targets.length > 0) {
      return (['codex', 'claude'] as const).flatMap((platform) => {
        const selected = targets.filter((target) => target.platform === platform);
        return selected.length > 0 ? [projectPlatformPlacement(platform, selected)] : [];
      });
    }
    const contracts = contractsByPlugin.get(pluginId) ?? [];
    return (['codex', 'claude'] as const).flatMap((platform): PlatformPlacementSummary[] => {
      const selected = contracts.filter((contract) => contract.metadata.platform === platform);
      if (selected.length === 0) return [];
      const scopes = [...new Set(selected.map((contract) => contract.metadata.scope))];
      return scopes.length === 1
        ? [{ platform, state: 'installed' as const, scope: scopes[0]!, health: 'error' as const }]
        : [{ platform, state: 'scopeConflict' as const, placements: scopes.map((scope) => ({
            scope,
            health: 'error' as const,
          })) }];
    });
  };
  const aggregateFor = (pluginId: string, placements: PlatformPlacementSummary[]) => {
    const sourceId = parsePluginId(pluginId).sourceId;
    if (graph.sourceErrors.some((error) => error.sourceId === sourceId)) return 'unavailable' as const;
    if (placements.length === 0 || placements.every((placement) => placement.state === 'notInstalled')) {
      return 'notInstalled' as const;
    }
    return placements.some((placement) => placement.state === 'scopeConflict'
      || (placement.state === 'installed' && placement.health !== 'ready'))
      ? 'needsAttention' as const
      : 'ready' as const;
  };
  const allPluginIds = new Set([
    ...nodes.keys(),
    ...contractsByPlugin.keys(),
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
        placementReferences: reverse.get(dependency.pluginId) ?? [],
      };
    });
    const dependentReferences = reverse.get(pluginId) ?? [];
    const dependentIds = [...new Set(dependentReferences.map((reference) => reference.consumer.pluginId))].sort();
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
        placementReferences: dependentReferences.filter((reference) =>
          reference.consumer.pluginId === dependentId),
      };
    });
    const targetBlockers = (targetsByPlugin.get(pluginId) ?? []).flatMap((target) =>
      target.errors.filter((error) => error.code.startsWith('dependency') || error.code === 'sourceChanged')
        .map((error) => ({
          code: error.code,
          title: '依赖关系需要处理',
          explanation: '当前目标的依赖证据不能安全通过检查。',
        })));
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
      ...targetBlockers,
      ...inventory.errors.map(() => ({
        code: 'dependencyContractInvalid',
        title: '依赖安装记录无效',
        explanation: '部分反向依赖记录不能安全读取。',
      })),
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

export function createTuiControllerDependencies(
  context: CliExecutionContext,
  progressFeed?: RebuildProgressFeed,
): TuiControllerDependencies {
  const loadStatus: TuiControllerDependencies['loadStatus'] = async (signal) => {
    signal.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await statusCommandV4({
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
        verbose: context.diagnostics.verbose,
      });
      signal.throwIfAborted();
      const configured = await listCatalogSources({ env: context.env });
      signal.throwIfAborted();
      if (result.payload.catalog.configDigest !== configured.configDigest) continue;
      const dependencyOverviews = await loadDependencyOverviews({
        context,
        cliVersion: packageInfo.version,
        status: result,
        signal,
      });
      signal.throwIfAborted();
      const statusById = new Map(result.payload.catalog.sources.map((source) => [source.id, source]));
      return {
        payload: result.payload,
        pluginSummaries: result.pluginSummaries,
        dependencyOverviews,
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
    freshnessPolicy: CatalogFreshnessPolicy = 'cacheFirst',
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
      const preview = await preflightCatalogSourceMutation({
        request,
        cwd: context.cwd,
        env: context.env,
      });
      return {
        catalog: { configDigest: preview.configDigest, compositeDigest: preview.candidateDigest },
        sourceWrite: {
          configDigest: preview.configDigest,
          candidateDigest: preview.candidateDigest,
          ...(preview.sourceIdentity ? { sourceIdentity: preview.sourceIdentity } : {}),
          inventoryDigest: digest({ references: preview.references.references, errors: preview.references.errors }),
          referenceCount: preview.references.references.length,
          inventoryComplete: preview.references.errors.length === 0,
        },
      };
    }
    if (!pluginIntent(intent)) {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    signal?.throwIfAborted();
    const packageInfo = await readCliPackageInfo();
    const status = await statusCommandV4({
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
    });
    signal?.throwIfAborted();
    if (intent.kind === 'pluginWrite') {
      await assertTypedIssueOrigin(intent, status.payload.targets, context);
    }
    const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
    let dependencyPlan: DependencyOperationPlan | undefined;
    const hasDeclaredDependencies = (status.pluginSummaries.find((summary) =>
      summary.pluginId === intent.pluginId)?.dependencyTotalCount ?? 0) > 0;
    if (intent.kind === 'pluginWrite'
      && hasDeclaredDependencies
      && (intent.action === 'install' || intent.action === 'upgrade' || intent.action === 'reinstall')) {
      const command = {
        install: installWriteCommand,
        upgrade: upgradeWriteCommand,
        reinstall: reinstallWriteCommand,
      }[intent.action];
      const preview = await command([intent.pluginId], {
        cwd: context.cwd,
        platform: intent.platform,
        scope: intent.scope,
      }, {
        ...context,
        expectedCatalogConfigDigest: status.payload.catalog.configDigest,
        previewDependencyPlanOnly: true,
      });
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
    const selected = dependencyPlan
      ? (() => {
          const node = dependencyPlan.nodes.find((candidate) => candidate.pluginId === intent.pluginId)!;
          const source = dependencyPlan.sources.find((candidate) => candidate.sourceId === node.sourceId)!;
          return {
            pluginName: node.pluginName,
            source: {
              sourceId: source.sourceId,
              sourceIdentity: source.sourceIdentity,
              ...(status.payload.catalog.sources.find((candidate) => candidate.id === source.sourceId)?.requestedRef
                ? { requestedRef: status.payload.catalog.sources.find((candidate) =>
                    candidate.id === source.sourceId)!.requestedRef }
                : {}),
              resolvedCommit: source.resolvedCommit,
              manifestDigest: source.manifestDigest,
              snapshotDigest: source.snapshotDigest,
              contentDigest: node.contentDigest,
            },
          };
        })()
      : await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy,
          configSnapshot,
          env: context.env,
          ...(signal ? { signal } : {}),
          consume: ({ plugin, source }) => ({
            pluginName: plugin.manifest.name,
            source: sourceEvidenceForPlugin(source, plugin.manifest.name),
          }),
        });
    const evidence: OperationEvidence = {
      catalog: {
        configDigest: status.payload.catalog.configDigest,
        compositeDigest: status.payload.catalog.compositeDigest,
      },
      source: selected.source,
      ...(dependencyPlan ? { dependencyPlan } : {}),
      targetFingerprint: digest(status.payload.targets.map((target) => ({
        pluginId: target.pluginId,
        sourceIdentity: target.sourceIdentity,
        platform: target.platform,
        scope: target.scope,
        state: target.state,
        errors: target.errors.map((error) => error.code).sort(),
        components: target.components.map((component) => [component.key, component.state])
          .sort(([left], [right]) => left!.localeCompare(right!, 'en')),
      })).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
        .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'))),
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
      evidence.config = {
        scope: intent.scope,
        projectLayer: intent.projectLayer,
        schemaIdentity: selected.source.manifestDigest,
        storeDigest: digest({ exists: store.exists, values: store.values }),
      };
    }
    return evidence;
  };

  const dependencies: TuiControllerDependencies = {
    loadStatus,
    async inspectSourceRemoval(sourceId, signal) {
      signal.throwIfAborted();
      const inventory = await inventoryCatalogSourceReferences({
        cwd: context.cwd,
        env: context.env,
        includeHistoricalProjects: true,
      });
      signal.throwIfAborted();
      const references = inventory.references.filter((reference) =>
        reference.sourceId === undefined || reference.sourceId === sourceId);
      const dependencies = new Map<string, {
        category: 'installation' | 'config' | 'lifecycle' | 'marketplace';
        pluginId?: string;
        sourceId?: string;
        platform?: PlatformName;
        scope?: 'user' | 'project';
      }>();
      for (const reference of references) {
        const kind = reference.kind.toLocaleLowerCase('en');
        const category: 'installation' | 'config' | 'lifecycle' | 'marketplace' = kind.includes('config')
          ? 'config'
          : kind.includes('lifecycle')
            ? 'lifecycle'
            : kind.includes('marketplace')
              ? 'marketplace'
              : 'installation';
        const stableSourceId = reference.sourceId;
        const pluginId = reference.pluginName && stableSourceId
          ? `${stableSourceId}/${reference.pluginName}`
          : undefined;
        const dependency: {
          category: 'installation' | 'config' | 'lifecycle' | 'marketplace';
          pluginId?: string;
          sourceId?: string;
          platform?: PlatformName;
          scope?: 'user' | 'project';
        } = {
          category,
          ...(pluginId ? { pluginId } : {}),
          ...(stableSourceId ? { sourceId: stableSourceId } : {}),
          ...(reference.platform === 'codex' || reference.platform === 'claude'
            ? { platform: reference.platform } : {}),
          ...(reference.scope === 'user' || reference.scope === 'project'
            ? { scope: reference.scope } : {}),
        };
        const key = [
          category,
          pluginId ?? '',
          stableSourceId ?? '',
          dependency.platform ?? '',
          dependency.scope ?? '',
          category === 'marketplace' ? reference.marketplaceName ?? '' : '',
        ].join('\0');
        dependencies.set(key, dependency);
      }
      const projected = [...dependencies.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .map(([, dependency]) => dependency);
      const complete = inventory.errors.length === 0;
      const count = (category: typeof projected[number]['category']): number | undefined =>
        complete ? projected.filter((reference) => reference.category === category).length : undefined;
      return {
        blocked: !complete || references.length > 0,
        inventoryComplete: complete,
        installationCount: count('installation'),
        configCount: count('config'),
        lifecycleCount: count('lifecycle'),
        marketplaceCount: count('marketplace'),
        dependencies: projected,
      };
    },
    async validateIntent(intent, signal) {
      if (intent.kind === 'sourceMutation') {
        const evidence = await captureEvidence(intent, signal);
        if (evidence.sourceWrite?.configDigest === evidence.sourceWrite?.candidateDigest) {
          throw new TuiOperationBlockedError('sourceNoChanges', '来源没有变化。');
        }
        return;
      }
      if (intent.kind === 'configSave') {
        const packageInfo = await readCliPackageInfo();
        await withResolvedCatalogPlugin({
          selector: intent.pluginId,
          cliVersion: packageInfo.version,
          freshnessPolicy: 'cacheFirst',
          env: context.env,
          signal,
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
      const status = await statusCommandV4({
        plugins: [...new Set([intent.pluginId,
          ...(intent.originIssue?.consumerPluginId ? [intent.originIssue.consumerPluginId] : [])])],
        platform: intent.platform,
        cwd: context.cwd,
        env: context.env,
        cliVersion: packageInfo.version,
      });
      signal.throwIfAborted();
      await assertTypedIssueOrigin(intent, status.payload.targets, context);
      assertIntentIsLegal(intent, status.payload.targets);
    },
    async checkSource(sourceId, signal) {
      const packageInfo = await readCliPackageInfo();
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      return withResolvedMultiSourceCatalog({
        cliVersion: packageInfo.version,
        freshnessPolicy: 'forceRemote',
        sourceIds: [sourceId],
        configSnapshot,
        env: context.env,
        signal,
        consume: (catalog) => {
          const item = catalog.sources[0]!;
          if (item.error) throw item.error;
          return {
            sourceIdentity: item.resolution!.sourceIdentity,
            requestedRef: item.resolution!.requestedRef,
          };
        },
      });
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
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
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
          return buildConfigGroups({ schema: plugin.manifest.config, read });
        },
      });
    },
    async getConfigPage(pluginId, layer, signal) {
      const packageInfo = await readCliPackageInfo();
      return withResolvedCatalogPlugin({
        selector: pluginId,
        cliVersion: packageInfo.version,
        freshnessPolicy: 'cacheFirst',
        env: context.env,
        signal,
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
          return buildConfigPage({ pluginId, schema: plugin.manifest.config, read });
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
      const configured = await readCatalogSourcesConfigSnapshot(context.env);
      const source = configured.config.sources.find((entry) => entry.id === sourceId);
      const configuredIdentity = source
        ? await calculateCatalogSourceIdentity(source)
        : undefined;
      if (identity.sourceIdentity !== configuredIdentity) {
        return {
          exists: true,
          sourceIdentityPresent: false,
          sourceIdentity: identity.sourceIdentity,
        };
      }
      return {
        exists: true,
        sourceIdentityPresent: true,
        sourceIdentity: identity.sourceIdentity,
        storeDigest: digest({
          exists: identity.store.exists,
          sourceIdentity: identity.sourceIdentity,
          values: identity.store.values,
        }),
      };
    },
    async executeIntent(intent, expectedEvidence) {
      return withAwHomeMutationLock({
        env: context.env,
        action: async (awHomeMutationToken) => {
          const currentEvidence = await captureEvidence(intent, undefined, 'requireRemote');
          if (operationEvidenceFingerprint(currentEvidence) !== operationEvidenceFingerprint(expectedEvidence)) {
            throw new TuiOperationBlockedError('operationReviewStale', '确认后状态发生变化。');
          }
          await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
          if (intent.kind === 'sourceMutation') {
            const packageInfo = await readCliPackageInfo();
            const runtime = {
              awHomeMutationToken,
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
          if (intent.kind === 'pluginWrite') {
            const options = { cwd: context.cwd, platform: intent.platform, scope: intent.scope };
            const command = {
              install: installWriteCommand,
              upgrade: upgradeWriteCommand,
              reinstall: reinstallWriteCommand,
              uninstall: uninstallWriteCommand,
              cleanup: cleanupWriteCommand,
            }[intent.action];
            const currentSource = currentEvidence.source;
            if (!expectedEvidence.source || !currentSource) {
              throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少来源身份。');
            }
            const currentDependencyPlan = currentEvidence.dependencyPlan;
            const result = await command([intent.pluginId], options, {
              ...context,
              awHomeMutationToken,
              expectedCatalogConfigDigest: expectedEvidence.catalog.configDigest,
              reviewPreflight: (actual) => assertSourceEvidenceMatches(currentSource, actual),
              ...(currentDependencyPlan ? {
                dependencyPlanReviewPreflight: (actual: DependencyOperationPlan) => {
                  if (actual.planDigest !== currentDependencyPlan.planDigest) {
                    throw new TuiOperationBlockedError(
                      'operationReviewStale',
                      'dependencyPlanStale: 确认后依赖安装计划发生变化。',
                    );
                  }
                },
              } : {}),
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
              freshnessPolicy: 'requireRemote',
              env: context.env,
              consume: async ({ plugin, source }) => {
                assertSourceEvidenceMatches(
                  currentSource,
                  sourceEvidenceForPlugin(source, plugin.manifest.name),
                );
                const result = intent.kind === 'configSave'
                  ? await applyPluginConfigWrite({
                      plugin,
                      pluginName: plugin.manifest.name,
                      scope: intent.scope,
                      projectLayer: intent.projectLayer,
                      cwd: context.cwd,
                      env: context.env,
                      nativeCliRunner: context.nativeCliRunner,
                      rebuildRuntime: { ...context, awHomeMutationToken },
                      awHomeMutationToken,
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
                      rebuildRuntime: { ...context, awHomeMutationToken },
                      awHomeMutationToken,
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
