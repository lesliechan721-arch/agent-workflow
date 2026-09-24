import crypto from 'node:crypto';
import path from 'node:path';

import type { CliExecutionContext } from '../commands/runtime.js';
import type { CatalogSourceResolution, PluginConfigSchema, PluginMeta, Scope } from '../types.js';
import {
  flattenStatusTargets,
  statusCommandV8,
  statusTargetActivation,
  statusTargetIntent,
  statusTargetOwnershipState,
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
  cleanupWriteCommand,
  failedWriteCommandResult,
  installWriteCommand,
  mergeWriteCommandResults,
  reinstallWriteCommand,
  syncWriteCommand,
  taskWriteCommand,
  uninstallWriteCommand,
} from '../commands/write-commands.js';
import { resolveSyncIntentSelection } from '../commands/sync-command.js';
import {
  parseScriptTimeoutMs,
  SCRIPT_TIMEOUT_DEFAULT_MS,
} from '../commands/options.js';
import { readCliPackageInfo } from '../utils/local-marketplace.js';
import {
  createCodexNativeObservationSession,
  type CodexNativeObservationSession,
} from '../utils/codex-native-observation.js';
import type { CodexManager } from '../utils/native-cli.js';
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
import {
  calculatePluginIntentDigest,
  readPluginIntentState,
} from '../utils/plugin-intent-state.js';
import {
  applyPluginConfigWrite,
  replayConfigRuntimeWrites,
  resolveConfigPreApplyAuthorization,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';
import { analyzePluginConfigMutationImpact } from '../utils/plugin-config-impact.js';
import type { RebuildProgressFeed } from '../output/rebuild-progress.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import { createBatchIntentCompatiblePlanFingerprint } from '../commands/operation-plan.js';
import type {
  RebuildCommandResult,
  RebuildReviewPreflightEvidence,
} from '../commands/rebuild-command.js';
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
  type PluginWriteBatchEvidence,
  type PluginWriteBatchExecutionResult,
  type PluginWriteBatchGroupEvidence,
  type PluginWriteTaskCandidate,
  type PluginWriteTaskEvidence,
  type PluginWriteTaskExecutionResult,
  type PluginWriteTaskSourceEvidence,
  type PluginWriteTaskSourceResult,
  type ReviewPreparationStageId,
  type TuiControllerDependencies,
} from './controller.js';
import type { CatalogSessionReusableCandidate } from './catalog-sources/types.js';
import {
  buildConfigGroups,
  buildConfigPage,
  buildTuiViewModel,
  hasActualScopeEvidence,
  isDirectCodexVersionUpgrade,
  projectPlatformPlacement,
  type PlatformPlacementSummary,
  type PluginDependencyOverviewViewModel,
} from './model.js';
import {
  buildPluginWriteTaskCandidates,
  buildPluginWriteTaskDraft,
  evaluatePluginWriteTaskRestoreVersion,
  pluginWriteTaskTargetKey,
  type PluginWriteTaskTarget,
} from './plugin-write-task.js';
import { projectExecutionDiagnostics, projectThrownOperationDiagnostic } from './diagnostic-projection.js';
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
  executePortableRetry,
  installPortableSkills,
  preparePortableInstall,
  preparePortableRetry,
  PortableCommandError,
  recheckPortableInstall,
  type PortableRetryReview,
} from '../portable/commands.js';
import {
  MANAGED_CODEX_PACKAGE_NAME,
  MANAGED_CODEX_VERSION,
} from '../utils/codex-manager.js';
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

function writeReviewIsStale(result: {
  targetResults: Array<{ errorCode?: string }>;
}): boolean {
  return result.targetResults.some((target) =>
    target.errorCode === 'operationReviewStale'
    || target.errorCode === 'operationPlanStale');
}

function throwIfWriteReviewStale(result: {
  targetResults: Array<{ errorCode?: string }>;
}): void {
  if (writeReviewIsStale(result)) {
    throw operationReviewStale('确认后实际写入计划发生变化。');
  }
}

const SOURCE_PROGRESS_PHASES: Record<CatalogSourceMutationProgress['stage'], string> = {
  savingConfig: '保存来源配置',
};

function pluginIntent(intent: OperationIntent): intent is Extract<OperationIntent, { pluginId: string }> {
  return 'pluginId' in intent;
}

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

interface PluginWriteBatchGroup {
  groupId: string;
  sourceId: string;
  platform: 'codex' | 'claude' | 'both';
  scope: Scope;
  requestedPluginIds: string[];
}

function selectedBatchGroups(intent: Extract<OperationIntent, { kind: 'pluginWriteBatch' }>): {
  requestedPluginIds: string[];
  groups: PluginWriteBatchGroup[];
} {
  if (intent.selection.kind !== 'selected' && intent.selection.kind !== 'targets') {
    throw new TuiOperationBlockedError(
      'syncSelectionRequired',
      '当前项目全部同步必须从项目 intent roots 解析。',
    );
  }
  const rawTargets = intent.selection.kind === 'targets'
    ? intent.selection.targets
    : intent.selection.pluginIds.map((pluginId) => ({
        pluginId, platform: intent.platform, scope: intent.scope,
      }));
  const normalizedTargets = rawTargets.map((target) => {
    if ((target.platform !== 'codex' && target.platform !== 'claude' && target.platform !== 'both')
      || (target.scope !== 'project' && target.scope !== 'user')
      || (intent.selection.kind === 'targets' && target.platform === 'both')) {
      throw new TuiOperationBlockedError('batchTargetInvalid', '批量精确目标必须使用有效 scope 和单个平台。');
    }
    const pluginId = target.pluginId;
    const parsed = parsePluginId(pluginId);
    if (!parsed.sourceId) {
      throw new TuiOperationBlockedError('invalidPluginId', '批量操作必须使用 canonical pluginId。');
    }
    const canonicalPluginId = formatPluginId({ sourceId: parsed.sourceId, pluginName: parsed.pluginName });
    if (intent.selection.kind === 'targets' && canonicalPluginId !== pluginId) {
      throw new TuiOperationBlockedError('invalidPluginId', '批量精确目标必须使用 canonical pluginId。');
    }
    return {
      pluginId: canonicalPluginId,
      platform: target.platform,
      scope: target.scope,
    };
  }).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
    .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'));
  const uniqueTargets = [...new Map(normalizedTargets.map((target) => [
    [target.pluginId, target.platform, target.scope].join('\0'), target,
  ])).values()];
  const requestedPluginIds = [...new Set(uniqueTargets.map((target) => target.pluginId))];
  if (requestedPluginIds.length === 0) {
    throw new TuiOperationBlockedError('syncSelectionRequired', '批量操作至少需要一个插件。');
  }
  const groups = new Map<string, PluginWriteBatchGroup>();
  for (const target of uniqueTargets) {
    const pluginId = target.pluginId;
    const sourceId = parsePluginId(pluginId).sourceId!;
    const groupKey = intent.action === 'cleanup'
      ? ['cleanup', target.platform, target.scope].join('\0')
      : [sourceId, target.platform, target.scope].join('\0');
    const group = groups.get(groupKey) ?? {
      groupId: groupKey,
      sourceId: intent.action === 'cleanup' ? 'offline' : sourceId,
      platform: target.platform,
      scope: target.scope,
      requestedPluginIds: [],
    };
    group.requestedPluginIds.push(pluginId);
    groups.set(groupKey, group);
  }
  return { requestedPluginIds, groups: [...groups.values()] };
}

async function resolveBatchGroups(
  intent: Extract<OperationIntent, { kind: 'pluginWriteBatch' }>,
  env: NodeJS.ProcessEnv,
  cwd: string,
  frozenRequestedPluginIds?: readonly string[],
): Promise<{
  requestedPluginIds: string[];
  groups: PluginWriteBatchGroup[];
  projectIntentDigest?: string;
}> {
  if (intent.selection.kind === 'selected' || intent.selection.kind === 'targets') {
    return selectedBatchGroups(intent);
  }
  if (intent.action !== 'sync' || intent.scope !== 'project') {
    throw new TuiOperationBlockedError(
      'syncSelectionRequired',
      '当前项目全部操作只支持 project scope sync。',
    );
  }
  const state = await readPluginIntentState({ scope: 'project', cwd, env });
  const projectIntentDigest = calculatePluginIntentDigest(state);
  if (intent.selection.kind === 'currentProjectIntentTargets') {
    if (intent.selection.targets.length === 0
      || intent.selection.targets.some((target) => target.scope !== 'project')) {
      throw new TuiOperationBlockedError(
        'batchTargetInvalid',
        '当前项目精确同步目标必须是非空 project targets。',
      );
    }
    const exact = selectedBatchGroups({
      ...intent,
      selection: { kind: 'targets', targets: intent.selection.targets },
    });
    const declaredPlatforms = new Map(state.roots.map((root) => [
      root.pluginId,
      new Set(root.platforms),
    ]));
    if (intent.selection.targets.some((target) =>
      !declaredPlatforms.get(target.pluginId)?.has(target.platform))) {
      throw new TuiOperationBlockedError(
        'batchTargetInvalid',
        '当前项目精确同步目标必须属于完整 project intent roots 声明。',
      );
    }
    return { ...exact, projectIntentDigest };
  }
  const selection = resolveSyncIntentSelection({
    roots: state.roots,
    selectors: frozenRequestedPluginIds ?? [],
    all: frozenRequestedPluginIds === undefined,
    platform: intent.platform,
  });
  if (selection.requestedPluginIds.length === 0) {
    throw new TuiOperationBlockedError('syncSelectionRequired', '当前项目没有可同步的 intent roots。');
  }
  return {
    requestedPluginIds: selection.requestedPluginIds,
    projectIntentDigest,
    groups: selection.groups.map((group) => ({
      groupId: `${group.sourceId}\0${group.platform}\0${intent.scope}`,
      sourceId: group.sourceId,
      platform: group.platform,
      scope: intent.scope,
      requestedPluginIds: group.pluginIds,
    })),
  };
}

async function runBatchWriteGroup(options: {
  intent: Extract<OperationIntent, { kind: 'pluginWriteBatch' }>;
  group: PluginWriteBatchGroup;
  cwd: string;
  runtime: Parameters<typeof installWriteCommand>[2];
}): Promise<RebuildCommandResult> {
  const dependencyScopeOverrides = options.intent.action === 'install'
    ? options.intent.dependencyScopeOverrides?.filter((override) =>
        parsePluginId(override.pluginId).sourceId === options.group.sourceId
        && (options.group.platform === 'both' || override.platform === options.group.platform))
    : undefined;
  const commandOptions = {
    cwd: options.cwd,
    ...(dependencyScopeOverrides?.length ? { dependencyScopeOverrides } : {}),
    platform: options.group.platform,
    scope: options.group.scope,
    ...(reviewedScriptTimeoutMs(options.intent) === undefined
      ? {}
      : { scriptTimeoutMs: reviewedScriptTimeoutMs(options.intent) }),
  };
  switch (options.intent.action) {
    case 'install':
      return installWriteCommand(options.group.requestedPluginIds, commandOptions, options.runtime);
    case 'sync':
      return syncWriteCommand(options.group.requestedPluginIds, commandOptions, options.runtime);
    case 'reinstall':
      return reinstallWriteCommand(options.group.requestedPluginIds, commandOptions, options.runtime);
    case 'uninstall':
      return uninstallWriteCommand(options.group.requestedPluginIds, commandOptions, options.runtime);
    case 'cleanup':
      return cleanupWriteCommand(options.group.requestedPluginIds, commandOptions, options.runtime);
  }
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
  const taskCatalogOperationsByEvidence = new WeakMap<
    OperationEvidence,
    Map<string, CatalogOperationContext>
  >();
  const codexManagerByEvidence = new WeakMap<OperationEvidence, CodexManager>();
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
      const projectIntentObservation = result.projectIntentObservation;
      const projectIntent = projectIntentObservation.state === 'ready' ? {
        state: 'ready' as const,
        roots: structuredClone(projectIntentObservation.value.roots),
      } : projectIntentObservation.state === 'absent' ? {
        state: 'absent' as const,
      } : {
        state: projectIntentObservation.state,
        code: projectIntentObservation.code,
        message: projectIntentObservation.message,
      };
      return {
        cliChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
        ...(result.projectRoot ? { projectRoot: result.projectRoot } : {}),
        projectIntent,
        ...(projectIntent.state === 'ready'
          ? { projectIntentRoots: structuredClone(projectIntent.roots) }
          : {}),
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
    codexObservationSession?: CodexNativeObservationSession,
    frozenBatchEvidence?: PluginWriteBatchEvidence,
  ): Promise<OperationEvidence> => {
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
          codexObservationSession,
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
    if ((intent.kind === 'pluginWrite'
      && (intent.platform === 'codex' || intent.platform === 'both')
      || intent.kind === 'pluginWriteTask'
      && intent.targets.some((target) => target.platform === 'codex'))
      && !codexObservationSession) {
      const observationSession = await createCodexNativeObservationSession({
        exactCwd: context.cwd,
        env: context.env,
        runner: context.nativeCliRunner,
      });
      try {
        return await captureEvidence(
          intent,
          signal,
          preparation,
          operationInventory,
          freshCatalog,
          reusableCandidate,
          observationSession,
          frozenBatchEvidence,
        );
      } finally {
        await observationSession.dispose();
      }
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
    if (!pluginIntent(intent) && intent.kind !== 'pluginWriteBatch'
      && intent.kind !== 'pluginWriteTask') {
      throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
    }
    signal?.throwIfAborted();
    if (intent.kind === 'pluginWriteTask') {
      await preparation?.reporter.emit('status');
      const packageInfo = await readCliPackageInfo();
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      const requestedBySource = new Map<string, PluginWriteTaskTarget[]>();
      for (const target of intent.targets) {
        const parsed = parsePluginId(target.pluginId);
        if (!parsed.sourceId || formatPluginId({
          sourceId: parsed.sourceId,
          pluginName: parsed.pluginName,
        }) !== target.pluginId) {
          throw new TuiOperationBlockedError('invalidPluginId', '任务目标必须使用 canonical pluginId。');
        }
        requestedBySource.set(parsed.sourceId, [
          ...(requestedBySource.get(parsed.sourceId) ?? []),
          target,
        ]);
      }
      const sources: PluginWriteTaskSourceEvidence[] = [];
      const executableTargets: PluginWriteTaskTarget[] = [];
      const causes: PluginWriteTaskEvidence['taskPlan']['causes'] = [];
      const blockedTargets: PluginWriteTaskEvidence['taskPlan']['blockedTargets'] = [];
      const observedTargets: StatusScopedTarget[] = [];
      const observedRevisions: StatusTargetRevision[] = [];
      const operationContexts = new Map<string, CatalogOperationContext>();
      await preparation?.reporter.emit('catalog');
      for (const [sourceId, requestedTargets] of [...requestedBySource.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))) {
        signal?.throwIfAborted();
        let catalogOperation: CatalogOperationContext | undefined;
        try {
          catalogOperation = !freshCatalog && sessionCatalogOperationContext
            ? selectCatalogOperationContext(sessionCatalogOperationContext, [sourceId])
            : await resolveCatalogOperationContext({
                sourceIds: [sourceId],
                env: context.env,
                ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
                ...(signal ? { signal } : {}),
              });
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') throw error;
          blockedTargets.push(...requestedTargets.map((target, index) => {
            const diagnostic = error instanceof CatalogGenerationError ? {
              id: `task-source:${sourceId}:${index}`,
              code: error.code,
              stage: 'source',
              sourceId,
              safeMessage: 'The Catalog source could not be prepared safely.',
              target: { pluginId: target.pluginId, platform: target.platform, scope: target.scope },
              causes: [],
              detailLines: [],
            } : projectThrownOperationDiagnostic({
                error,
                id: `task-source:${sourceId}:${index}`,
                stage: 'source',
                fallbackCode: 'catalogSourceResolutionFailed',
                sourceId,
                target,
              });
            return {
              target,
              reason: 'targetUnavailable' as const,
              issueIds: [],
              errorCodes: [diagnostic.code],
              diagnostics: [diagnostic],
            };
          }));
          continue;
        }
        operationContexts.set(sourceId, catalogOperation);
        const status = await statusCommandV8({
          plugins: [...new Set(requestedTargets.map((target) => target.pluginId))],
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          ...(codexObservationSession ? { codexObservationSession } : {}),
          cliVersion: packageInfo.version,
          catalogOperationContext: catalogOperation,
          inventoryCatalogSourceReferences: operationInventory,
        });
        observedTargets.push(...flattenStatusTargets(status.payload.targets));
        observedRevisions.push(...status.targetRevisions);
        const model = buildTuiViewModel({
          status: status.payload,
          pluginSummaries: status.pluginSummaries,
          targetRevisions: status.targetRevisions,
        });
        const runtimeCandidates: PluginWriteTaskCandidate[] = intent.goal === 'restore'
          ? buildPluginWriteTaskCandidates(model, 'restore')
          : requestedTargets.map((target): PluginWriteTaskCandidate => {
              const expected = target.expectedUpdate;
              const revision = status.targetRevisions.find((entry) =>
                entry.pluginId === target.pluginId && entry.platform === target.platform
                && entry.scope === target.scope);
              const live = flattenStatusTargets(status.payload.targets).find((entry) => {
                if (entry.pluginId !== target.pluginId || entry.platform !== target.platform) return false;
                const desired = statusTargetIntent(entry);
                return entry.scope === target.scope || desired.scopes.includes(target.scope);
              });
              const generation = catalogOperation.generationSet.sources.find((entry) =>
                entry.sourceId === sourceId);
              const eligible = Boolean(expected && live && revision
                && live.sourceIdentity === expected.sourceIdentity
                && generation?.storeKey === expected.generationKey
                && revision.revision.installedVersion === expected.installedVersion
                && revision.revision.availableVersion === expected.activeVersion
                && revision.revision.state === 'upgradeAvailable');
              const directVersionUpgrade = live !== undefined && revision !== undefined
                && isDirectCodexVersionUpgrade(live, revision.revision);
              return {
                target,
                displayName: model.plugins.find((plugin) => plugin.pluginId === target.pluginId)
                  ?.displayName ?? parsePluginId(target.pluginId).pluginName,
                sourceId,
                eligible,
                ...(!eligible ? { blockReason: 'updateEvidenceIncomplete' as const } : {}),
                recommendedMethod: live?.state === 'ready' || directVersionUpgrade
                  ? 'sync' : 'reinstall',
                issueIds: [],
              };
            });
        const draft = buildPluginWriteTaskDraft({ ...intent, targets: requestedTargets }, model,
          runtimeCandidates);
        blockedTargets.push(...draft.blockedTargets);
        if (draft.executableTargets.length === 0) continue;
        const methodsByTarget = new Map<string, Set<'sync' | 'reinstall'>>();
        for (const cause of draft.causes) {
          const key = pluginWriteTaskTargetKey(cause.repairTarget);
          const methods = methodsByTarget.get(key) ?? new Set();
          methods.add(cause.method);
          methodsByTarget.set(key, methods);
        }
        const conflicted = new Set([...methodsByTarget].filter(([, methods]) => methods.size > 1)
          .map(([key]) => key));
        if (conflicted.size > 0) {
          const blockedKeys = new Set(draft.causes.filter((cause) =>
            conflicted.has(pluginWriteTaskTargetKey(cause.repairTarget)))
            .flatMap((cause) => cause.consumers.map(pluginWriteTaskTargetKey)));
          blockedTargets.push(...draft.executableTargets.filter((target) =>
            blockedKeys.has(pluginWriteTaskTargetKey(target))).map((target) => ({
            target,
            reason: 'taskActionConflict' as const,
            issueIds: draft.causes.filter((cause) => cause.consumers.some((consumer) =>
              pluginWriteTaskTargetKey(consumer) === pluginWriteTaskTargetKey(target)))
              .map((cause) => cause.issueId),
          })));
          draft.executableTargets = draft.executableTargets.filter((target) =>
            !blockedKeys.has(pluginWriteTaskTargetKey(target)));
          draft.causes = draft.causes.filter((cause) => cause.consumers.some((consumer) =>
            !blockedKeys.has(pluginWriteTaskTargetKey(consumer))));
        }
        if (draft.executableTargets.length === 0) continue;
        const taskTargets = () => draft.executableTargets.map((target) => {
          const direct = draft.causes.filter((cause) =>
            pluginWriteTaskTargetKey(cause.repairTarget) === pluginWriteTaskTargetKey(target));
          return {
            pluginId: target.pluginId,
            platform: target.platform,
            scope: target.scope,
            method: direct.some((cause) => cause.method === 'reinstall')
              ? 'reinstall' as const : 'sync' as const,
          };
        });
        const repairTargets = () => [...new Map(draft.causes.map((cause) => [
          pluginWriteTaskTargetKey(cause.repairTarget),
          { ...cause.repairTarget, method: cause.method },
        ])).values()];
        let preview: RebuildCommandResult | undefined;
        while (draft.executableTargets.length > 0) {
          preview = await taskWriteCommand(taskTargets(), {
            cwd: context.cwd,
            repairTargets: repairTargets(),
            ...(reviewedScriptTimeoutMs(intent) === undefined
              ? {} : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
          }, {
            ...context,
            catalogOperationContext: catalogOperation,
            expectedGenerationSetDigest: catalogOperation.generationSetDigest,
            expectedCatalogConfigDigest: configSnapshot.digest,
            inventoryCatalogSourceReferences: operationInventory,
            previewOperationPlan: true,
            ...(codexObservationSession ? { codexObservationSession } : {}),
            ...(preparation ? {
              onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
                stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
            } : {}),
          });
          if (!preview.operationPlan) {
            const projected = projectExecutionDiagnostics(
              preview,
              `task-preview:${sourceId}`,
              [],
              'pluginWrite',
            );
            const sourceDiagnostics = projected.diagnostics.filter((diagnostic) => !diagnostic.target)
              .map((diagnostic) => ({ ...diagnostic, sourceId, target: undefined }));
            blockedTargets.push(...draft.executableTargets.map((target, targetIndex) => {
              const matchingDiagnostics = projected.diagnostics.filter((diagnostic) =>
                diagnostic.target?.pluginId === target.pluginId
                && diagnostic.target.platform === target.platform
                && diagnostic.target.scope === target.scope);
              const preparedDiagnostics = [
                ...matchingDiagnostics,
                ...(targetIndex === 0 ? sourceDiagnostics : []),
              ];
              const targetDiagnostics = preparedDiagnostics.length > 0
                ? preparedDiagnostics
                : [projectThrownOperationDiagnostic({
                    error: undefined,
                    id: `task-preview:${sourceId}:${targetIndex}`,
                    stage: 'dependencyPlan',
                    fallbackCode: 'taskOperationPlanMissing',
                    sourceId,
                    target,
                  })];
              const diagnostics = targetDiagnostics.map((diagnostic, diagnosticIndex) => ({
                ...structuredClone(diagnostic),
                id: `task-preview:${sourceId}:${targetIndex}:${diagnosticIndex}`,
                sourceId,
              }));
              return {
                target,
                reason: 'targetUnavailable' as const,
                issueIds: draft.causes.filter((cause) => cause.consumers.some((consumer) =>
                  pluginWriteTaskTargetKey(consumer) === pluginWriteTaskTargetKey(target)))
                  .map((cause) => cause.issueId),
                errorCodes: [...new Set(diagnostics.map((diagnostic) => diagnostic.code))],
                diagnostics,
              };
            }));
            draft.executableTargets = [];
            draft.causes = [];
            break;
          }
          if (intent.goal === 'restore') {
            const grouped = new Map<string, {
              cause: (typeof draft.causes)[number];
              issueIds: Set<string>;
              methods: Set<'sync' | 'reinstall'>;
            }>();
            const blockedByVersion = new Map<string, {
              reason: 'restoreVersionChanged' | 'restoreVersionUnverified'
                | 'manualRecoveryRequired' | 'taskActionConflict';
              issueIds: Set<string>;
            }>();
            for (const cause of draft.causes) {
              const placements = (preview.dependencyPlan?.targets ?? []).filter((target) =>
                target.pluginId === cause.repairTarget.pluginId
                && target.platform === cause.repairTarget.platform);
              const placement = placements.find((target) =>
                target.requestedScope === cause.repairTarget.scope)
                ?? (placements.length === 1 ? placements[0] : undefined);
              if (!placement) {
                throw new TuiOperationBlockedError(
                  'taskRepairPlacementMissing',
                  '任务修复目标无法绑定到依赖位置。',
                );
              }
              const repairTarget = {
                pluginId: cause.repairTarget.pluginId,
                platform: cause.repairTarget.platform,
                scope: placement.requestedScope ?? placement.resolvedScope,
              };
              const version = evaluatePluginWriteTaskRestoreVersion(
                repairTarget,
                cause.restoreVersionEvidence?.state === 'absent',
                model,
              );
              if (!version.evidence || version.blockReason) {
                for (const consumer of cause.consumers) {
                  const key = pluginWriteTaskTargetKey(consumer);
                  const current = blockedByVersion.get(key) ?? {
                    reason: version.blockReason ?? 'restoreVersionUnverified',
                    issueIds: new Set<string>(),
                  };
                  if (version.blockReason === 'restoreVersionChanged') {
                    current.reason = version.blockReason;
                  }
                  current.issueIds.add(cause.issueId);
                  blockedByVersion.set(key, current);
                }
                continue;
              }
              const causeKey = ['restore', cause.sourceIdentity,
                pluginWriteTaskTargetKey(repairTarget)].join('\0');
              const current = grouped.get(causeKey);
              grouped.set(causeKey, {
                cause: {
                  ...cause,
                  causeKey,
                  issueId: [cause.issueId, ...(current?.issueIds ?? [])]
                    .sort((left, right) => left.localeCompare(right, 'en'))[0]!,
                  repairTarget,
                  consumers: [...new Map([
                    ...(current?.cause.consumers ?? []),
                    ...cause.consumers,
                  ].map((consumer) => [pluginWriteTaskTargetKey(consumer), consumer])).values()]
                    .sort((left, right) => pluginWriteTaskTargetKey(left)
                      .localeCompare(pluginWriteTaskTargetKey(right), 'en')),
                  restoreVersionEvidence: version.evidence,
                },
                issueIds: new Set([...(current?.issueIds ?? []), cause.issueId]),
                methods: new Set([...(current?.methods ?? []), cause.method]),
              });
            }
            for (const group of grouped.values()) {
              if (group.methods.size < 2) continue;
              for (const consumer of group.cause.consumers) {
                const key = pluginWriteTaskTargetKey(consumer);
                const current = blockedByVersion.get(key) ?? {
                  reason: 'taskActionConflict' as const,
                  issueIds: new Set<string>(),
                };
                group.issueIds.forEach((issueId) => current.issueIds.add(issueId));
                blockedByVersion.set(key, current);
              }
            }
            const newlyBlockedKeys = new Set(blockedByVersion.keys());
            blockedTargets.push(...draft.executableTargets.flatMap((target) => {
              const blocked = blockedByVersion.get(pluginWriteTaskTargetKey(target));
              return blocked ? [{
                target,
                reason: blocked.reason,
                issueIds: [...blocked.issueIds].sort((left, right) => left.localeCompare(right, 'en')),
              }] : [];
            }));
            const normalizedCauses = [...grouped.values()]
              .filter((group) => group.methods.size === 1)
              .map((group) => ({
                ...group.cause,
                consumers: group.cause.consumers.filter((consumer) =>
                  !newlyBlockedKeys.has(pluginWriteTaskTargetKey(consumer))),
              }))
              .filter((cause) => cause.consumers.length > 0)
              .sort((left, right) => left.causeKey.localeCompare(right.causeKey, 'en'));
            const normalizedTargets = draft.executableTargets.filter((target) =>
              !newlyBlockedKeys.has(pluginWriteTaskTargetKey(target)));
            const changed = JSON.stringify(normalizedCauses) !== JSON.stringify(draft.causes)
              || JSON.stringify(normalizedTargets) !== JSON.stringify(draft.executableTargets);
            draft.causes = normalizedCauses;
            draft.executableTargets = normalizedTargets;
            if (changed) continue;
          }
          const blockedPlanTargets = (preview.dependencyPlan?.targets ?? []).filter((target) =>
            target.action === 'block' || target.errorCode !== undefined);
          if (blockedPlanTargets.length === 0) break;
          const requestedKeys = new Set(draft.executableTargets.map(pluginWriteTaskTargetKey));
          const blockedPlansByRoot = new Map<string, typeof blockedPlanTargets>();
          for (const blockedPlanTarget of blockedPlanTargets) {
            const pending = [blockedPlanTarget];
            const visited = new Set<string>();
            const mappedRoots = new Set<string>();
            const repairKey = pluginWriteTaskTargetKey({
              pluginId: blockedPlanTarget.pluginId,
              platform: blockedPlanTarget.platform,
              scope: blockedPlanTarget.requestedScope ?? blockedPlanTarget.resolvedScope,
            });
            for (const cause of draft.causes) {
              if (pluginWriteTaskTargetKey(cause.repairTarget) !== repairKey) continue;
              cause.consumers.forEach((consumer) => mappedRoots.add(pluginWriteTaskTargetKey(consumer)));
            }
            while (pending.length > 0) {
              const current = pending.shift()!;
              const currentKey = pluginWriteTaskTargetKey({
                pluginId: current.pluginId,
                platform: current.platform,
                scope: current.requestedScope ?? current.resolvedScope,
              });
              if (visited.has(currentKey)) continue;
              visited.add(currentKey);
              if (current.relation === 'requested' && requestedKeys.has(currentKey)) {
                mappedRoots.add(currentKey);
              }
              for (const consumer of current.requiredByTargets ?? []) {
                const consumerKey = pluginWriteTaskTargetKey(consumer);
                if (requestedKeys.has(consumerKey)) {
                  mappedRoots.add(consumerKey);
                  continue;
                }
                const placement = preview.dependencyPlan?.targets.find((target) =>
                  target.pluginId === consumer.pluginId && target.platform === consumer.platform
                  && (target.requestedScope ?? target.resolvedScope) === consumer.scope);
                if (placement) pending.push(placement);
              }
            }
            if (mappedRoots.size === 0) {
              throw new TuiOperationBlockedError(
                'taskPlanConsumerMissing',
                '任务计划中的阻止项无法映射到请求目标。',
              );
            }
            for (const key of mappedRoots) {
              const plans = blockedPlansByRoot.get(key) ?? [];
              plans.push(blockedPlanTarget);
              blockedPlansByRoot.set(key, plans);
            }
          }
          blockedTargets.push(...draft.executableTargets.flatMap((target) => {
            const plans = blockedPlansByRoot.get(pluginWriteTaskTargetKey(target));
            return plans ? [{
              target,
              reason: 'targetUnavailable' as const,
              issueIds: draft.causes.filter((cause) => cause.consumers.some((consumer) =>
                pluginWriteTaskTargetKey(consumer) === pluginWriteTaskTargetKey(target)))
                .map((cause) => cause.issueId),
              errorCodes: [...new Set(plans.map((plan) => plan.errorCode ?? 'writePlanBlocked'))]
                .sort((left, right) => left.localeCompare(right, 'en')),
              diagnostics: plans.map((plan, index) => ({
                id: `task-plan:${sourceId}:${target.pluginId}:${target.platform}:${target.scope}:${index}`,
                code: plan.errorCode ?? 'writePlanBlocked',
                stage: 'dependencyPlan',
                sourceId,
                target: {
                  pluginId: plan.pluginId, platform: plan.platform,
                  scope: plan.requestedScope ?? plan.resolvedScope,
                },
                causes: [],
                detailLines: [],
                safeMessage: plan.errorCode === 'artifactCollision'
                  ? '输出位置存在外来内容，无法覆盖。'
                  : plan.errorCode === 'exclusiveOwnerEvidenceInvalid'
                    ? '独立扩展的归属标记缺失或损坏。'
                    : plan.errorCode === 'dependencyNotReady'
                      ? '依赖安装状态无法读取。'
                      : '依赖计划阻止了此目标。',
              })),
            }] : [];
          }));
          draft.executableTargets = draft.executableTargets.filter((target) =>
            !blockedPlansByRoot.has(pluginWriteTaskTargetKey(target)));
          draft.causes = draft.causes.map((cause) => ({
            ...cause,
            consumers: cause.consumers.filter((consumer) =>
              !blockedPlansByRoot.has(pluginWriteTaskTargetKey(consumer))),
          })).filter((cause) => cause.consumers.length > 0);
        }
        if (!preview?.operationPlan || draft.executableTargets.length === 0) continue;
        const sourceIdentity = draft.causes[0]?.sourceIdentity
          ?? status.payload.catalog.sources.find((source) => source.id === sourceId)?.identity;
        if (!sourceIdentity) {
          throw new TuiOperationBlockedError('taskSourceIdentityMissing', '任务来源身份不可验证。');
        }
        const sourceEvidence: PluginWriteTaskSourceEvidence = {
          sourceId,
          sourceIdentity,
          requestedTargets: draft.executableTargets,
          causes: draft.causes,
          preview,
          executable: true,
        };
        sources.push(sourceEvidence);
        executableTargets.push(...draft.executableTargets);
        causes.push(...draft.causes);
      }
      const canonicalBlocked = [...new Map(blockedTargets.map((target) => [
        pluginWriteTaskTargetKey(target.target), target,
      ])).values()].sort((left, right) => pluginWriteTaskTargetKey(left.target)
        .localeCompare(pluginWriteTaskTargetKey(right.target), 'en'));
      if (executableTargets.length === 0) {
        throw new TuiOperationBlockedError(
          'taskNoExecutableTargets',
          '任务没有可安全执行的目标。',
          canonicalBlocked.flatMap((target) => target.diagnostics ?? []),
        );
      }
      if (intent.executionPolicy === 'all' && canonicalBlocked.length > 0) {
        throw new TuiOperationBlockedError(
          'taskHasBlockedTargets',
          '部分目标需要先处理。请调整选择。',
          canonicalBlocked.flatMap((target) => target.diagnostics ?? []),
        );
      }
      await preparation?.reporter.emit('evidence');
      const evidence: PluginWriteTaskEvidence = {
        catalog: {
          configDigest: configSnapshot.digest,
          compositeDigest: digest(sources.map((source) => [
            source.sourceId,
            source.sourceIdentity,
            source.preview.operationPlan?.planFingerprint,
          ])),
        },
        taskPlan: {
          goal: intent.goal,
          requestedTargets: intent.targets,
          executableTargets: [...executableTargets].sort((left, right) =>
            pluginWriteTaskTargetKey(left).localeCompare(pluginWriteTaskTargetKey(right), 'en')),
          causes: [...new Map(causes.map((cause) => [cause.causeKey, cause])).values()]
            .sort((left, right) => left.causeKey.localeCompare(right.causeKey, 'en')),
          blockedTargets: canonicalBlocked,
          sources,
          targetFingerprint: statusTargetFingerprint(observedTargets, observedRevisions),
          planFingerprint: '',
        },
      };
      evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
      taskCatalogOperationsByEvidence.set(evidence, operationContexts);
      return evidence;
    }
    if (intent.kind === 'pluginWriteBatch') {
      await preparation?.reporter.emit('status');
      const selection = await resolveBatchGroups(
        intent,
        context.env,
        context.cwd,
        frozenBatchEvidence?.requestedPluginIds,
      );
      signal?.throwIfAborted();
      if (intent.action === 'cleanup') {
        const groups: PluginWriteBatchGroupEvidence[] = [];
        for (const group of selection.groups) {
          signal?.throwIfAborted();
          const preview = await runBatchWriteGroup({
            intent,
            group,
            cwd: context.cwd,
            runtime: {
              ...context,
              inventoryCatalogSourceReferences: operationInventory,
              previewOperationPlan: true,
              ...(codexObservationSession ? { codexObservationSession } : {}),
              ...(preparation ? {
                onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
                  stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
              } : {}),
            },
          });
          groups.push({ ...group, preview, executable: preview.operationPlan !== undefined });
        }
        await preparation?.reporter.emit('evidence');
        signal?.throwIfAborted();
        const evidence: PluginWriteBatchEvidence = {
          catalog: {
            configDigest: 'cleanup-offline',
            compositeDigest: digest(groups.map((group) => [
              group.groupId,
              group.preview.operationPlan?.planFingerprint,
            ])),
          },
          requestedPluginIds: selection.requestedPluginIds,
          groups,
        };
        return evidence;
      }
      const configSnapshot = await readCatalogSourcesConfigSnapshot(context.env);
      const groups: PluginWriteBatchGroupEvidence[] = [];
      const ownsObservationSession = !codexObservationSession
        && selection.groups.some((group) => {
          const reviewed = frozenBatchEvidence?.groups.find((candidate) =>
            candidate.groupId === group.groupId);
          return reviewed?.executable !== false
            && (group.platform === 'codex' || group.platform === 'both');
        });
      const observationSession = codexObservationSession ?? (ownsObservationSession
        ? await createCodexNativeObservationSession({
            exactCwd: context.cwd,
            env: context.env,
            runner: context.nativeCliRunner,
          })
        : undefined);
      try {
        await preparation?.reporter.emit('catalog');
        for (const group of selection.groups) {
          signal?.throwIfAborted();
          const reviewed = frozenBatchEvidence?.groups.find((candidate) =>
            candidate.groupId === group.groupId);
          if (reviewed?.executable === false) {
            groups.push({ ...group, preview: reviewed.preview, executable: false });
            continue;
          }
          let catalogOperation: CatalogOperationContext | undefined;
          try {
            catalogOperation = !freshCatalog && sessionCatalogOperationContext
              ? selectCatalogOperationContext(sessionCatalogOperationContext, [group.sourceId])
              : await resolveCatalogOperationContext({
                  sourceIds: [group.sourceId],
                  env: context.env,
                  ...(!freshCatalog ? { validatedStoreEntries, validatingStoreEntries } : {}),
                  ...(signal ? { signal } : {}),
                });
          } catch {
            catalogOperation = undefined;
          }
          const preview = await runBatchWriteGroup({
            intent,
            group,
            cwd: context.cwd,
            runtime: {
              ...context,
              inventoryCatalogSourceReferences: operationInventory,
              expectedCatalogConfigDigest: configSnapshot.digest,
              ...(catalogOperation ? {
                catalogOperationContext: catalogOperation,
                expectedGenerationSetDigest: catalogOperation.generationSetDigest,
              } : {}),
              previewOperationPlan: true,
              ...(observationSession ? { codexObservationSession: observationSession } : {}),
              ...(preparation ? {
                onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
                  stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
              } : {}),
            },
          });
          groups.push({ ...group, preview, executable: preview.operationPlan !== undefined });
        }
      } finally {
        if (ownsObservationSession) await observationSession?.dispose();
      }
      await preparation?.reporter.emit('evidence');
      signal?.throwIfAborted();
      const merged = mergeWriteCommandResults(groups.map((group) => group.preview));
      const targetVersions = groups.flatMap((group) => {
        if (group.platform === 'both') return [];
        const platform = group.platform;
        return group.requestedPluginIds.map((pluginId) => {
          const live = flattenStatusTargets(sessionStatusResult?.payload.targets ?? []).find((target) =>
            target.pluginId === pluginId && target.platform === platform
            && (target.scope === group.scope || statusTargetIntent(target).scopes.includes(group.scope)
              || platform === 'codex' && statusTargetActivation(target)?.[group.scope] === true));
          const revision = sessionStatusResult?.targetRevisions?.find((target) =>
            target.pluginId === pluginId && target.platform === platform
            && target.scope === group.scope)?.revision;
          const activation = live ? statusTargetActivation(live) : undefined;
          const ownership = live && live.scope === group.scope
            ? statusTargetOwnershipState(live) : 'absent';
          const present = ownership === 'present' || ownership === 'partial'
            || platform === 'codex' && activation?.[group.scope] === true;
          const planned = live ? statusTargetIntent(live).scopes.includes(group.scope) : false;
          return {
            pluginId,
            platform,
            scope: group.scope,
            presence: present ? 'installed' as const
              : ownership === 'absent' && planned ? 'new' as const : 'unknown' as const,
            ...(revision?.installedVersion ? { installedVersion: revision.installedVersion } : {}),
            ...(revision?.availableVersion ? { availableVersion: revision.availableVersion } : {}),
          };
        });
      });
      const evidence: PluginWriteBatchEvidence = {
        catalog: {
          configDigest: configSnapshot.digest,
          compositeDigest: sessionStatusResult?.payload.catalog.compositeDigest
            ?? digest(groups.map((group) => [group.groupId, group.preview.operationPlan?.planFingerprint])),
        },
        requestedPluginIds: selection.requestedPluginIds,
        ...(selection.projectIntentDigest
          ? { projectIntentDigest: selection.projectIntentDigest }
          : {}),
        groups,
        targetVersions: [...new Map(targetVersions.map((target) => [[
          target.pluginId, target.platform, target.scope,
        ].join('\0'), target])).values()].sort((left, right) => [
          left.pluginId, left.platform, left.scope,
        ].join('\0').localeCompare([
          right.pluginId, right.platform, right.scope,
        ].join('\0'), 'en')),
        ...(merged.dependencyPlan ? { dependencyPlan: merged.dependencyPlan } : {}),
        ...(merged.codexReconcilePlans ? { codexReconcilePlans: merged.codexReconcilePlans } : {}),
        ...(merged.operationPlan ? { operationPlan: merged.operationPlan } : {}),
      };
      return evidence;
    }
    if (intent.kind === 'pluginWrite' && intent.action === 'cleanup') {
      const preview = await cleanupWriteCommand([intent.pluginId], {
        cwd: context.cwd,
        platform: intent.platform,
        scope: intent.scope,
        force: intent.force === true,
      }, {
        ...context,
        inventoryCatalogSourceReferences: operationInventory,
        previewOperationPlan: true,
        ...(codexObservationSession ? { codexObservationSession } : {}),
        ...(preparation ? {
          onPreviewStage: (stage: 'catalog' | 'inventory' | 'dependencyPlan') =>
            stage === 'catalog' ? undefined : preparation.reporter.emit(stage),
        } : {}),
      });
      signal?.throwIfAborted();
      if (!preview.operationPlan) {
        throw new TuiOperationBlockedError(
          'cleanupPlanUnavailable',
          '无法建立可信的清理计划。',
        );
      }
      const offlineCleanupPlans = preview.offlineCleanupPlans ?? [];
      await preparation?.reporter.emit('evidence');
      return {
        catalog: {
          configDigest: 'cleanup-offline',
          compositeDigest: preview.operationPlan.planFingerprint,
        },
        operationPlan: preview.operationPlan,
        offlineCleanupPlans,
        ...(offlineCleanupPlans.length === 1
          ? { offlineCleanup: offlineCleanupPlans[0] }
          : {}),
        targetFingerprint: preview.operationPlan.planFingerprint,
      };
    }
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
      plugins: [...new Set([intent.pluginId,
        ...(intent.kind === 'pluginWrite' && intent.originIssue?.consumerPluginId
          ? [intent.originIssue.consumerPluginId] : [])])],
      ...('platform' in intent ? { platform: intent.platform } : {}),
      ...(intent.kind !== 'pluginWrite' && intent.scope === 'project'
        ? { scope: intent.scope }
        : {}),
      cwd: context.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
      ...(codexObservationSession ? { codexObservationSession } : {}),
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
    let dependencyPlan: ReconcileOperationPlan | undefined;
    let codexReconcilePlans: OperationEvidence['codexReconcilePlans'];
    let operationPlan: OperationEvidence['operationPlan'];
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
    if (intent.kind === 'pluginWrite' && intent.expectedUpdate) {
      const revision = status.targetRevisions.find((entry) =>
        entry.pluginId === intent.pluginId && entry.platform === intent.platform
        && entry.scope === intent.scope);
      const generation = catalogOperation?.generationSet.sources.find((entry) =>
        entry.sourceId === selected.source.sourceId);
      if (intent.action !== 'sync'
        || !('pluginVersion' in selected.source)
        || selected.source.sourceIdentity !== intent.expectedUpdate.sourceIdentity
        || selected.source.pluginVersion !== intent.expectedUpdate.activeVersion
        || generation?.storeKey !== intent.expectedUpdate.generationKey
        || revision?.revision.installedVersion !== intent.expectedUpdate.installedVersion
        || revision?.revision.availableVersion !== intent.expectedUpdate.activeVersion
        || revision.revision.state !== 'upgradeAvailable') {
        throw operationReviewStale('插件更新版本或 Active Catalog 证据已变化。');
      }
    }
    let codexManager: OperationEvidence['codexManager'];
    let resolvedCodexManager: CodexManager | undefined;
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
        ...(reviewedScriptTimeoutMs(intent) === undefined
          ? {}
          : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
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
        ...(codexObservationSession ? { codexObservationSession } : {}),
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
          const code = blocker.errorCode ?? 'dependencyNotReady';
          const reason = code === 'dependencyScopeConflict' || code === 'codexExtensionScopeConflict'
            ? '这个依赖的安装位置存在冲突，需要先选择保留的位置。'
            : code === 'artifactCollision' || code === 'exclusiveOwnerEvidenceInvalid'
              ? '这个依赖的安装位置被其他内容占用，需要先检查并处理冲突。'
              : '这个依赖尚不可用，需要先检查并恢复后再安装。';
          throw new TuiOperationBlockedError(
            code,
            `${blocker.pluginId}：${reason}`,
            [{
              id: `dependency:${blocker.pluginId}:${blocker.platform}:${blocker.resolvedScope}`,
              code, stage: 'dependencyPlan', safeMessage: reason,
              target: { pluginId: blocker.pluginId, platform: blocker.platform, scope: blocker.resolvedScope },
              causes: [], detailLines: [],
            }],
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
        if (managerPreview.state === 'system' || managerPreview.state === 'cached') {
          resolvedCodexManager = managerPreview.manager;
        }
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
    if (resolvedCodexManager) codexManagerByEvidence.set(evidence, resolvedCodexManager);
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
        const taskObservationSession = intent.kind === 'pluginWriteTask'
          && intent.targets.some((target) => target.platform === 'codex')
          ? await createCodexNativeObservationSession({
              exactCwd: context.cwd,
              env: context.env,
              runner: context.nativeCliRunner,
            })
          : undefined;
        let evidence: OperationEvidence;
        try {
          evidence = await captureEvidence(intent, signal, {
            reporter,
            validateIntent: true,
          }, createOperationInventoryReader(), intent.kind === 'pluginWrite'
            && intent.action === 'refreshAndSync', reusableCandidate, taskObservationSession);
        } finally {
          await taskObservationSession?.dispose();
        }
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
      const codexObservationSession = intent.kind === 'pluginWrite'
        || intent.kind === 'pluginWriteBatch'
        || intent.kind === 'pluginWriteTask'
        ? await createCodexNativeObservationSession({
            exactCwd: context.cwd,
            env: context.env,
            runner: context.nativeCliRunner,
            manager: codexManagerByEvidence.get(expectedEvidence),
          })
        : undefined;
      return withAwHomeMutationLock({
        env: context.env,
        action: async (awHomeMutationToken) => {
          await tuiControllerRuntimeTestHooks?.beforeMutationEvidenceCapture?.();
          const operationInventory = createOperationInventoryReader();
          let currentEvidence: OperationEvidence;
          try {
            currentEvidence = await captureEvidence(
              intent,
              undefined,
              undefined,
              operationInventory,
              true,
              undefined,
              codexObservationSession,
              intent.kind === 'pluginWriteBatch'
                ? expectedEvidence as PluginWriteBatchEvidence
                : undefined,
            );
          } catch (error) {
            const code = error instanceof TuiOperationBlockedError ? error.code : undefined;
            if (intent.kind === 'pluginWriteBatch'
              && (intent.selection.kind === 'currentProjectIntentRoots'
                || intent.selection.kind === 'currentProjectIntentTargets')
              && error instanceof TuiOperationBlockedError) {
              throw operationReviewStale('确认后完整项目 Intent 声明发生变化。');
            }
            if (intent.kind === 'pluginWriteTask'
              && (code === 'taskHasBlockedTargets' || code === 'taskNoExecutableTargets')) {
              throw operationReviewStale(
                '确认后任务可执行目标发生变化。',
                error instanceof TuiOperationBlockedError ? error.diagnostics : undefined,
              );
            }
            throw error;
          }
          if (intent.kind === 'pluginWriteBatch') {
            const expectedBatch = expectedEvidence as PluginWriteBatchEvidence;
            const currentBatch = currentEvidence as PluginWriteBatchEvidence;
            if ((intent.selection.kind === 'currentProjectIntentRoots'
              || intent.selection.kind === 'currentProjectIntentTargets')
              && (!expectedBatch.projectIntentDigest
                || expectedBatch.projectIntentDigest !== currentBatch.projectIntentDigest)) {
              throw operationReviewStale('确认后完整项目 Intent 声明发生变化。');
            }
            const reviewedGroups = expectedBatch.groups.map((group) => ({
              groupId: group.groupId,
              sourceId: group.sourceId,
              platform: group.platform,
              scope: group.scope,
              requestedPluginIds: group.requestedPluginIds,
              executable: group.executable,
              planFingerprint: group.preview.operationPlan
                ? intent.action === 'cleanup'
                  ? group.preview.operationPlan.planFingerprint
                  : createBatchIntentCompatiblePlanFingerprint(group.preview.operationPlan)
                : undefined,
            }));
            const currentGroups = currentBatch.groups.map((group) => ({
              groupId: group.groupId,
              sourceId: group.sourceId,
              platform: group.platform,
              scope: group.scope,
              requestedPluginIds: group.requestedPluginIds,
              executable: expectedBatch.groups.find((reviewed) => reviewed.groupId === group.groupId)
                ?.executable === false ? false : group.executable,
              planFingerprint: expectedBatch.groups.find((reviewed) => reviewed.groupId === group.groupId)
                ?.executable === false
                ? undefined
                : group.preview.operationPlan
                  ? intent.action === 'cleanup'
                    ? group.preview.operationPlan.planFingerprint
                    : createBatchIntentCompatiblePlanFingerprint(group.preview.operationPlan)
                  : undefined,
            }));
            if (expectedBatch.catalog.configDigest !== currentBatch.catalog.configDigest
              || JSON.stringify(expectedBatch.requestedPluginIds)
                !== JSON.stringify(currentBatch.requestedPluginIds)
              || JSON.stringify(reviewedGroups) !== JSON.stringify(currentGroups)) {
              throw operationReviewStale('确认后批量目标或写入计划发生变化。');
            }
            await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
            const groupResults = [];
            const completedTargetKeys = new Set<string>();
            const expectedIntentDigests = new Map<string, string>();
            for (const group of expectedBatch.groups) {
              for (const intentDigest of group.preview.operationPlan?.evidence.intentDigests ?? []) {
                expectedIntentDigests.set(intentDigest.scope, intentDigest.digest);
              }
            }
            let executedGroupCount = 0;
            const appendStoppedGroups = (startIndex: number, staleMessage: string): void => {
              for (const [offset, stopped] of expectedBatch.groups.slice(startIndex).entries()) {
                groupResults.push({
                  groupId: stopped.groupId,
                  sourceId: stopped.sourceId,
                  platform: stopped.platform,
                  scope: stopped.scope,
                  requestedPluginIds: stopped.requestedPluginIds,
                  result: !stopped.executable ? stopped.preview : failedWriteCommandResult(
                    intent.action,
                    stopped.requestedPluginIds,
                    { cwd: context.cwd, platform: stopped.platform, scope: stopped.scope },
                    offset === 0
                      ? new TuiOperationBlockedError('operationReviewStale', staleMessage)
                      : new TuiOperationBlockedError(
                          'batchNotStarted',
                          '前一个批量组的写入计划已变化，因此这个组没有开始。',
                        ),
                  ),
                });
              }
            };
            for (const [groupIndex, reviewed] of expectedBatch.groups.entries()) {
              const current = currentBatch.groups.find((group) => group.groupId === reviewed.groupId)!;
              if (!reviewed.executable) {
                groupResults.push({
                  groupId: reviewed.groupId,
                  sourceId: reviewed.sourceId,
                  platform: reviewed.platform,
                  scope: reviewed.scope,
                  requestedPluginIds: reviewed.requestedPluginIds,
                  result: reviewed.preview,
                });
                continue;
              }
              const groupInventory = groupResults.length === 0
                ? operationInventory
                : createOperationInventoryReader();
              let executionPreview = current.preview;
              if (completedTargetKeys.size > 0
                || (intent.action === 'cleanup' && executedGroupCount > 0)) {
                executionPreview = await runBatchWriteGroup({
                  intent,
                  group: current,
                  cwd: context.cwd,
                  runtime: {
                    ...context,
                    awHomeMutationToken,
                    inventoryCatalogSourceReferences: groupInventory,
                    ...(intent.action === 'cleanup' ? {} : {
                      expectedCatalogConfigDigest: expectedBatch.catalog.configDigest,
                    }),
                    previewOperationPlan: true,
                    ...(codexObservationSession ? { codexObservationSession } : {}),
                  },
                });
                const cleanupIntentDigestChanged = intent.action === 'cleanup'
                  && executionPreview.operationPlan?.evidence.intentDigests.find((entry) =>
                    entry.scope === current.scope)?.digest !== expectedIntentDigests.get(current.scope);
                if (cleanupIntentDigestChanged
                  || !reviewed.preview.operationPlan || !executionPreview.operationPlan
                  || createBatchIntentCompatiblePlanFingerprint(
                    reviewed.preview.operationPlan,
                    completedTargetKeys,
                  ) !== createBatchIntentCompatiblePlanFingerprint(
                    executionPreview.operationPlan,
                    completedTargetKeys,
                  )) {
                  appendStoppedGroups(
                    groupIndex,
                    '前序批量结果改变了这个组的实际写入计划。',
                  );
                  break;
                }
              }
              const requiresManagedCodex = reviewed.preview.codexManagerPreview?.state === 'requires-install';
              const result = await runBatchWriteGroup({
                intent,
                group: current,
                cwd: context.cwd,
                runtime: {
                  ...context,
                  awHomeMutationToken,
                  preApplyConfirmed: true,
                  inventoryCatalogSourceReferences: groupInventory,
                  ...(intent.action === 'cleanup' ? {} : {
                    expectedCatalogConfigDigest: expectedBatch.catalog.configDigest,
                  }),
                  ...(executionPreview.operationPlan ? {
                    expectedPlanFingerprint: executionPreview.operationPlan.planFingerprint,
                  } : {}),
                  ...(requiresManagedCodex ? {
                    managedCodexAuthorizer: async () => true,
                  } : {}),
                  ...(codexObservationSession ? { codexObservationSession } : {}),
                },
              });
              if (writeReviewIsStale(result)) {
                if (executedGroupCount === 0) throwIfWriteReviewStale(result);
                appendStoppedGroups(groupIndex, '这个组的实际写入计划发生变化。');
                break;
              }
              if (intent.action === 'cleanup') {
                for (const change of result.operationPlan?.intentChanges ?? []) {
                  expectedIntentDigests.set(change.scope, change.afterDigest);
                }
              }
              executedGroupCount += 1;
              for (const target of result.targetResults) {
                if (target.state === 'completed') {
                  completedTargetKeys.add([
                    target.target.pluginId,
                    target.target.platform,
                    target.target.scope,
                  ].join('\0'));
                }
              }
              groupResults.push({
                groupId: reviewed.groupId,
                sourceId: reviewed.sourceId,
                platform: reviewed.platform,
                scope: reviewed.scope,
                requestedPluginIds: reviewed.requestedPluginIds,
                result,
              });
            }
            const merged = mergeWriteCommandResults(groupResults.map((group) => group.result));
            return {
              ...merged,
              requestedPluginIds: expectedBatch.requestedPluginIds,
              groupResults,
            } satisfies PluginWriteBatchExecutionResult;
          }
          if (intent.kind === 'pluginWriteTask') {
            const expectedTask = expectedEvidence as PluginWriteTaskEvidence;
            const currentTask = currentEvidence as PluginWriteTaskEvidence;
            if (!operationEvidenceMatches(expectedTask, currentTask)) {
              throw operationReviewStale('确认后任务目标、根因、版本或写入计划发生变化。');
            }
            await tuiControllerRuntimeTestHooks?.afterMutationEvidenceCapture?.();
            const operationContexts = taskCatalogOperationsByEvidence.get(currentEvidence)
              ?? new Map<string, CatalogOperationContext>();
            const sourceResults: PluginWriteTaskSourceResult[] = [];
            const completedTargetKeys = new Set<string>();
            const preApplyExecutionCache = new Map<string, Promise<void>>();
            const commandTargets = (source: PluginWriteTaskSourceEvidence) =>
              source.requestedTargets.map((target) => {
                const direct = source.causes.filter((cause) =>
                  pluginWriteTaskTargetKey(cause.repairTarget) === pluginWriteTaskTargetKey(target));
                return {
                  pluginId: target.pluginId,
                  platform: target.platform,
                  scope: target.scope,
                  method: direct.some((cause) => cause.method === 'reinstall')
                    ? 'reinstall' as const : 'sync' as const,
                };
              });
            const repairTargets = (source: PluginWriteTaskSourceEvidence) =>
              [...new Map(source.causes.map((cause) => [
                pluginWriteTaskTargetKey(cause.repairTarget),
                { ...cause.repairTarget, method: cause.method },
              ])).values()];
            const stoppedResult = (
              source: PluginWriteTaskSourceEvidence,
              error: TuiOperationBlockedError,
            ): RebuildCommandResult => mergeWriteCommandResults(source.requestedTargets.map((target) =>
              failedWriteCommandResult('sync', [target.pluginId], {
                cwd: context.cwd,
                platform: target.platform,
                scope: target.scope,
              }, error)));
            const appendStoppedSources = (startIndex: number, message: string): void => {
              for (const [offset, source] of expectedTask.taskPlan.sources.slice(startIndex).entries()) {
                sourceResults.push({
                  sourceId: source.sourceId,
                  sourceIdentity: source.sourceIdentity,
                  requestedTargets: source.requestedTargets,
                  result: stoppedResult(source, offset === 0
                    ? new TuiOperationBlockedError('operationReviewStale', message)
                    : new TuiOperationBlockedError(
                        'taskNotStarted',
                        '前一个来源计划已变化，因此这个来源没有开始。',
                      )),
                });
              }
            };
            for (const [sourceIndex, reviewed] of expectedTask.taskPlan.sources.entries()) {
              const current = currentTask.taskPlan.sources.find((source) =>
                source.sourceId === reviewed.sourceId);
              const catalogOperation = operationContexts.get(reviewed.sourceId);
              if (!current || !catalogOperation || current.sourceIdentity !== reviewed.sourceIdentity) {
                if (sourceResults.length === 0) {
                  throw operationReviewStale('确认后任务来源身份发生变化。');
                }
                appendStoppedSources(sourceIndex, '确认后任务来源身份发生变化。');
                break;
              }
              const sourceInventory = sourceResults.length === 0
                ? operationInventory : createOperationInventoryReader();
              let executionPreview = current.preview;
              if (completedTargetKeys.size > 0) {
                executionPreview = await taskWriteCommand(commandTargets(current), {
                  cwd: context.cwd,
                  repairTargets: repairTargets(current),
                  ...(reviewedScriptTimeoutMs(intent) === undefined
                    ? {} : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
                }, {
                  ...context,
                  awHomeMutationToken,
                  catalogOperationContext: catalogOperation,
                  expectedGenerationSetDigest: catalogOperation.generationSetDigest,
                  expectedCatalogConfigDigest: expectedTask.catalog.configDigest,
                  inventoryCatalogSourceReferences: sourceInventory,
                  previewOperationPlan: true,
                  preApplyExecutionCache,
                  ...(codexObservationSession ? { codexObservationSession } : {}),
                });
                if (!reviewed.preview.operationPlan || !executionPreview.operationPlan
                  || createBatchIntentCompatiblePlanFingerprint(
                    reviewed.preview.operationPlan,
                    completedTargetKeys,
                  ) !== createBatchIntentCompatiblePlanFingerprint(
                    executionPreview.operationPlan,
                    completedTargetKeys,
                  )) {
                  appendStoppedSources(sourceIndex, '前序结果改变了这个来源的实际写入计划。');
                  break;
                }
              }
              const requiresManagedCodex = reviewed.preview.codexManagerPreview?.state === 'requires-install';
              const result = await taskWriteCommand(commandTargets(current), {
                cwd: context.cwd,
                repairTargets: repairTargets(current),
                ...(reviewedScriptTimeoutMs(intent) === undefined
                  ? {} : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
              }, {
                ...context,
                awHomeMutationToken,
                catalogOperationContext: catalogOperation,
                expectedGenerationSetDigest: catalogOperation.generationSetDigest,
                expectedCatalogConfigDigest: expectedTask.catalog.configDigest,
                inventoryCatalogSourceReferences: sourceInventory,
                preApplyConfirmed: true,
                preApplyExecutionCache,
                ...(executionPreview.operationPlan
                  ? { expectedPlanFingerprint: executionPreview.operationPlan.planFingerprint } : {}),
                ...(requiresManagedCodex ? { managedCodexAuthorizer: async () => true } : {}),
                ...(codexObservationSession ? { codexObservationSession } : {}),
              });
              if (writeReviewIsStale(result)) {
                if (sourceResults.length === 0) throwIfWriteReviewStale(result);
                appendStoppedSources(sourceIndex, '这个来源的实际写入计划发生变化。');
                break;
              }
              for (const target of result.targetResults) {
                if (target.state === 'completed') {
                  completedTargetKeys.add([
                    target.target.pluginId,
                    target.target.platform,
                    target.target.scope,
                  ].join('\0'));
                }
              }
              sourceResults.push({
                sourceId: reviewed.sourceId,
                sourceIdentity: reviewed.sourceIdentity,
                requestedTargets: reviewed.requestedTargets,
                result,
              });
            }
            const merged = mergeWriteCommandResults(sourceResults.map((source) => source.result));
            return {
              ...merged,
              taskPlan: expectedTask.taskPlan,
              sourceResults,
            } satisfies PluginWriteTaskExecutionResult;
          }
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
              ...(reviewedScriptTimeoutMs(intent) === undefined
                ? {}
                : { scriptTimeoutMs: reviewedScriptTimeoutMs(intent) }),
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
            if (intent.action === 'cleanup') {
              if (!expectedEvidence.operationPlan || !currentEvidence.operationPlan
                || expectedEvidence.operationPlan.planFingerprint
                  !== currentEvidence.operationPlan.planFingerprint) {
                throw operationReviewStale('确认后清理计划发生变化。');
              }
              const result = await command([intent.pluginId], options, {
                ...context,
                ...(codexObservationSession ? { codexObservationSession } : {}),
                awHomeMutationToken,
                preApplyConfirmed: true,
                inventoryCatalogSourceReferences: operationInventory,
                expectedPlanFingerprint: expectedEvidence.operationPlan.planFingerprint,
                ...(expectedEvidence.codexManager?.state === 'requires-install'
                  ? { managedCodexAuthorizer: async () => true }
                  : {}),
              });
              throwIfWriteReviewStale(result);
              return result;
            }
            const currentSource = currentEvidence.source;
            if (!expectedEvidence.source || !currentSource) {
              throw new TuiOperationBlockedError('operationReviewStale', '确认信息缺少来源身份。');
            }
            const result = await command([intent.pluginId], options, {
              ...context,
              ...(codexObservationSession ? { codexObservationSession } : {}),
              awHomeMutationToken,
              preApplyConfirmed: true,
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
              reviewPreflight: (actual: RebuildReviewPreflightEvidence) =>
                assertSourceEvidenceMatches(currentSource, actual),
            });
            throwIfWriteReviewStale(result);
            return result;
          }
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
      }).finally(async () => {
        await codexObservationSession?.dispose();
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
