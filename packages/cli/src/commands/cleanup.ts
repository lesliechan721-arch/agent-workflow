import fs from 'fs-extra';

import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import {
  cleanupInstallStateTarget,
  pruneDependencyIndexStaleEntry,
  readInstallStateProjection,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import {
  normalizeCleanupCommandOptions,
  type CleanupCommandOptions,
  type RawCleanupCommandOptions,
} from './options.js';
import {
  assertAgentVersionsForWriteTargets,
  loadPluginTargetsForRemovalCommand,
  type ResolvedPluginTarget,
} from './common.js';
import {
  buildCommandCandidates,
  type CommandCandidate,
} from './discovery.js';
import type {
  ConfigStoreRemovalResult,
  GeneratedArtifact,
  NextStepInstruction,
  PlatformName,
  ReceiptOverallState,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import { getNativeTransactionMarkerPath } from '../install-state/paths.js';
import type { InstallEvidence } from '../install-state/evidence.js';
import type { ProjectInstallStateProjection } from '../install-state/status-projection.js';
import {
  createCliCommandNextStep,
  createNextStepsBoundary,
  createUiActionNextStep,
} from '../output/model.js';
import { mergeGeneratedArtifacts } from '../utils/generated-artifacts.js';
import {
  resolvePluginConfigStoreTargets,
  resetPluginConfigStores,
} from '../utils/plugin-config.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/paths.js';

interface CleanupRetiredEntry {
  location: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
  };
  recordPath: string;
}

export interface CleanupLocationSummary {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
}

type CleanupLocationInput = {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string | null;
};

export interface CleanupPlanItem {
  kind: string;
  label: string;
  path?: string;
  detail?: string;
}

export interface CleanupConfigAction {
  plugin: string;
  scope: Scope;
  projectKey?: string;
  storeKind: 'user' | 'projectShared' | 'projectLocal';
  path: string;
  status: 'kept' | 'removed' | 'skipped' | 'failed';
  reason?: string;
}

export interface CleanupBlockingReason {
  code: string;
  message: string;
  suggestedCommand?: string;
}

export type CleanupTargetType =
  | 'installed'
  | 'cleanup-required'
  | 'marker-residue'
  | 'config-only'
  | 'manifest-only'
  | 'cache-only'
  | 'native-residue'
  | 'claimable-external'
  | 'foreign-external'
  | 'not-installed';

export interface CleanupTargetPayload {
  ok: true;
  command: 'cleanup';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  generatedAt: string;
  dependencyIndex: false;
  targetResults: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  force: boolean;
  removeConfig: boolean;
  target: CleanupLocationSummary & {
    targetType: CleanupTargetType;
  };
  cleanupScope: CleanupPlanItem[];
  deletedItems: CleanupPlanItem[];
  skippedItems: CleanupPlanItem[];
  failedItems: CleanupPlanItem[];
  residueItems: CleanupPlanItem[];
  configActions: CleanupConfigAction[];
  affectedDependents: CleanupLocationSummary[];
  blockingReasons: CleanupBlockingReason[];
}

export interface CleanupDependencyIndexPayload {
  ok: true;
  command: 'cleanup';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  generatedAt: string;
  dependencyIndex: true;
  targetResults: ReceiptTargetResult[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  pruneToken: string;
  action: 'retired' | 'skipped';
  skippedReason?: string;
  retiredEntries: CleanupRetiredEntry[];
}

export type CleanupJsonPayload = CleanupTargetPayload | CleanupDependencyIndexPayload;

export interface CleanupCommandRuntime extends InstallStateRemovalRuntime {
  p9TargetResolver?: typeof loadPluginTargetsForRemovalCommand;
}

interface CleanupEvaluation {
  payload: CleanupTargetPayload;
  execute: boolean;
  target: ResolvedPluginTarget | null;
  targetResolutionError?: string;
}

export function isCleanupExecutionFailure(payload: CleanupJsonPayload): boolean {
  return !payload.dependencyIndex
    && (
      (payload.blockingReasons?.length ?? 0) > 0
      || (payload.failedItems?.length ?? 0) > 0
      || (payload.residueItems?.length ?? 0) > 0
    );
}

function renderLocation(location: CleanupLocationSummary): string {
  return location.scope === 'project'
    ? `${location.platform}/${location.plugin}/project:${location.projectKey ?? '(missing-project-key)'}`
    : `${location.platform}/${location.plugin}/user`;
}

function renderLocationArgs(location: CleanupLocationSummary): string {
  return `${location.plugin} --platform ${location.platform} --scope ${location.scope}`;
}

function renderAdoptExistingCommand(location: CleanupLocationSummary): string {
  return `aw install ${renderLocationArgs(location)} --adopt-existing`;
}

function buildCleanupStatusCommand(location: CleanupLocationSummary): string {
  return `aw status ${renderLocationArgs(location)}`;
}

function buildCleanupNextSteps(payload: CleanupTargetPayload): NextStepInstruction[] {
  const suggestedCommand = payload.blockingReasons.find((entry) => entry.suggestedCommand)?.suggestedCommand;
  if (suggestedCommand) {
    return [createCliCommandNextStep(
      '继续处理 cleanup 残留',
      '当前还有未清理或不适合直接删除的内容，先按建议操作再回来确认状态。',
      suggestedCommand,
    )];
  }

  return [createUiActionNextStep(
    '查看 cleanup 后状态',
    '可以重新确认 cleanup 后还剩哪些安装证据、残留和后续可执行动作。',
    'openStatus',
    buildCleanupStatusCommand(payload.target),
  )];
}

function buildCleanupDependencyIndexNextSteps(): ReturnType<typeof createNextStepsBoundary> {
  return createNextStepsBoundary([createCliCommandNextStep(
    '查看最新依赖状态',
    '可以重新检查 dependency index 清理后，当前环境里还剩哪些依赖引用需要继续处理。',
    'aw status --verbose',
  )]);
}

function buildCleanupTargetResults(
  payload: CleanupTargetPayload,
): ReceiptTargetResult[] {
  return [{
    target: {
      pluginName: payload.target.plugin,
      platform: payload.target.platform,
      scope: payload.target.scope,
      ...(payload.target.projectKey ? { projectKey: payload.target.projectKey } : {}),
    },
    action: 'cleanup',
    state:
      payload.failedItems.length > 0 || payload.residueItems.length > 0 || payload.blockingReasons.length > 0
        ? 'failed'
        : 'completed',
    rollbackState: 'notNeeded',
    ...((payload.failedItems.length > 0 || payload.residueItems.length > 0)
      ? { message: `仍有 ${payload.residueItems.length} 项残留，${payload.failedItems.length} 项删除失败。` }
      : payload.blockingReasons[0]
        ? { message: payload.blockingReasons[0].message, errorCode: payload.blockingReasons[0].code }
        : payload.deletedItems.length === 0
          ? { message: '当前没有需要 cleanup 的 AW 状态。' }
        : {}),
  }];
}

function buildCleanupConfigStoreRemovals(
  payload: CleanupTargetPayload,
): ConfigStoreRemovalResult[] | undefined {
  const actionable = payload.configActions.filter((entry) => entry.status !== 'kept');
  if (actionable.length === 0) {
    return undefined;
  }

  return actionable.map((entry) => ({
    store: {
      pluginName: entry.plugin,
      storeKind: entry.storeKind,
      ...(entry.projectKey ? { projectRoot: entry.projectKey } : {}),
    },
    state: entry.status === 'removed'
      ? 'removed'
      : entry.status === 'failed'
        ? 'failed'
        : entry.reason === '当前 target scope 没有可删除的 AW 自管配置。'
          ? 'notFound'
          : 'skipped',
    ...(entry.status === 'failed'
      ? {
          reasonCode: 'removeFailed' as const,
          message: entry.reason,
        }
      : entry.status === 'skipped' && entry.reason && entry.reason !== '当前 target scope 没有可删除的 AW 自管配置。'
        ? {
            reasonCode: 'subjectFailed' as const,
            message: entry.reason,
          }
        : {}),
    subjectTargets: [{
      pluginName: payload.target.plugin,
      platform: payload.target.platform,
      scope: payload.target.scope,
      ...(payload.target.projectKey ? { projectKey: payload.target.projectKey } : {}),
    }],
    path: entry.path,
  }));
}

function toLocationSummary(
  location: CleanupLocationInput,
): CleanupLocationSummary {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    ...(typeof location.projectKey === 'string' ? { projectKey: location.projectKey } : {}),
  };
}

function uniquePlanItems(items: CleanupPlanItem[]): CleanupPlanItem[] {
  const deduped = new Map<string, CleanupPlanItem>();
  for (const item of items) {
    const key = `${item.kind}\0${item.path ?? ''}\0${item.label}\0${item.detail ?? ''}`;
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()];
}

function uniqueCleanupConfigActions(actions: CleanupConfigAction[]): CleanupConfigAction[] {
  const deduped = new Map<string, CleanupConfigAction>();
  for (const action of actions) {
    const key = [
      action.plugin,
      action.scope,
      action.storeKind,
      action.projectKey ?? '',
      action.path,
      action.status,
      action.reason ?? '',
    ].join('\0');
    if (!deduped.has(key)) {
      deduped.set(key, action);
    }
  }
  return [...deduped.values()];
}

function uniqueCleanupLocations(locations: CleanupLocationSummary[]): CleanupLocationSummary[] {
  const deduped = new Map<string, CleanupLocationSummary>();
  for (const location of locations) {
    deduped.set(renderLocation(location), location);
  }
  return [...deduped.values()];
}

function uniqueCleanupBlockingReasons(reasons: CleanupBlockingReason[]): CleanupBlockingReason[] {
  const deduped = new Map<string, CleanupBlockingReason>();
  for (const reason of reasons) {
    const key = `${reason.code}\0${reason.message}\0${reason.suggestedCommand ?? ''}`;
    if (!deduped.has(key)) {
      deduped.set(key, reason);
    }
  }
  return [...deduped.values()];
}

function hasCleanupCandidateEvidence(candidate: Pick<CommandCandidate, 'evidence'>): boolean {
  return candidate.evidence.sources.length > 0 || candidate.evidence.readErrors.length > 0;
}

async function isPlannedRemovalStillPresent(
  item: CleanupPlanItem,
  evidence: InstallEvidence,
): Promise<boolean> {
  switch (item.kind) {
    case 'native-config':
      return evidence.platform.codexNative?.configEntryPresent === true;
    case 'native-manifest':
      return evidence.platform.codexNative?.installedManifestPresent === true;
    case 'native-cache':
      return evidence.platform.codexNative?.activeCachePresent === true;
    case 'install-record':
      return evidence.installRecord.read.status !== 'missing'
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'diagnostic-cache':
      return evidence.dynamicDiagnostic.read?.status === 'ok'
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'project-artifact-identity':
      return evidence.projectSharedIdentity.read?.status === 'ok'
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'shared-runtime-owner':
      return evidence.sharedRuntimeOwner.read.status === 'ok'
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'historical-lifecycle-runtime':
      return evidence.historicalLifecycle.path !== null
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'native-transaction-marker':
      return evidence.nativeTransaction.read.status !== 'missing'
        || (item.path ? await fs.pathExists(item.path) : false);
    case 'dependency-index-reference':
      return evidence.dependencyIndex.projection.currentLocationReferenceStatuses.length > 0;
    default:
      return item.path ? await fs.pathExists(item.path) : false;
  }
}

async function partitionExecutedRemovalItems(options: {
  items: CleanupPlanItem[];
  location: CleanupLocationSummary;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  actualRemovals: CleanupPlanItem[];
  remainingItems: CleanupPlanItem[];
}> {
  const state = await readInstallStateProjection({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const actualRemovals: CleanupPlanItem[] = [];
  const remainingItems: CleanupPlanItem[] = [];

  for (const item of options.items) {
    if (await isPlannedRemovalStillPresent(item, state.evidence)) {
      remainingItems.push(item);
      continue;
    }
    actualRemovals.push(item);
  }

  return {
    actualRemovals,
    remainingItems,
  };
}

function isPureCodexUserNativeResidue(evidence: InstallEvidence): boolean {
  return evidence.location.platform === 'codex'
    && evidence.location.scope === 'user'
    && !evidence.installRecord.present
    && !evidence.nativeTransaction.present
    && evidence.platform.codexNative !== null
    && evidence.platform.codexNative.anyNativeEvidence
    && !evidence.residualEvidence.privateStatePresent
    && !evidence.residualEvidence.repoVisibleArtifactPresent
    && !evidence.residualEvidence.sharedIdentityPresent
    && !evidence.residualEvidence.historicalLifecyclePresent
    && !evidence.residualEvidence.nativeMarkerPresent
    && !evidence.residualEvidence.sharedOwnerPresent;
}

function classifyCleanupTargetType(
  evidence: InstallEvidence,
  projection: ProjectInstallStateProjection,
): CleanupTargetType {
  const codexNative = evidence.platform.codexNative;
  if (isPureCodexUserNativeResidue(evidence) && codexNative) {
    if (codexNative.configEntryPresent && !codexNative.installedManifestPresent && !codexNative.activeCachePresent) {
      return 'config-only';
    }
    if (!codexNative.configEntryPresent && codexNative.installedManifestPresent && !codexNative.activeCachePresent) {
      return 'manifest-only';
    }
    if (!codexNative.configEntryPresent && !codexNative.installedManifestPresent && codexNative.activeCachePresent) {
      return 'cache-only';
    }
    return 'native-residue';
  }
  if (
    !projection.installRecordPresent &&
    (projection.nativeTransactionKind === 'markerOnlyInstall' || projection.nativeTransactionKind === 'markerOnlyUninstall')
  ) {
    return 'marker-residue';
  }
  switch (projection.kind) {
    case 'installed':
      return 'installed';
    case 'cleanupRequired':
      return 'cleanup-required';
    case 'external':
      return projectionHasReason(projection, 'claimableProjectArtifacts')
        && !projectionHasReason(projection, 'foreignExternalEvidence')
        ? 'claimable-external'
        : 'foreign-external';
    default:
      return 'not-installed';
  }
}

function maybeAddPathRemoval(items: CleanupPlanItem[], options: {
  exists: boolean;
  kind: string;
  label: string;
  path?: string | null;
  detail?: string;
}): void {
  if (!options.exists || !options.path) {
    return;
  }
  items.push({
    kind: options.kind,
    label: options.label,
    path: options.path,
    ...(options.detail ? { detail: options.detail } : {}),
  });
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

function projectionHasReason(
  projection: ProjectInstallStateProjection,
  code: string,
): boolean {
  return projection.reasonCodes.includes(code as typeof projection.reasonCodes[number]);
}

function collectCleanupScopeItems(options: {
  evidence: InstallEvidence;
  env: NodeJS.ProcessEnv;
}): CleanupPlanItem[] {
  const items: CleanupPlanItem[] = [];
  const { evidence } = options;
  const codexNative = evidence.platform.codexNative;
  if (codexNative) {
    maybeAddPathRemoval(items, {
      exists: codexNative.configEntryPresent,
      kind: 'native-config',
      label: 'Codex enabled config',
      path: codexNative.configPath,
    });
    maybeAddPathRemoval(items, {
      exists: codexNative.installedManifestPresent,
      kind: 'native-manifest',
      label: 'Codex installed manifest',
      path: codexNative.installedManifestPath,
    });
    maybeAddPathRemoval(items, {
      exists: codexNative.activeCachePresent,
      kind: 'native-cache',
      label: 'Codex active cache',
      path: codexNative.activeCacheRootPath,
    });
  }

  maybeAddPathRemoval(items, {
    exists: evidence.installRecord.read.status !== 'missing',
    kind: 'install-record',
    label: 'install record',
    path: evidence.installRecord.read.path,
  });
  maybeAddPathRemoval(items, {
    exists:
      evidence.dynamicDiagnostic.read !== null
      && !(evidence.dynamicDiagnostic.read.status === 'unavailable' && evidence.dynamicDiagnostic.read.code === 'missing'),
    kind: 'diagnostic-cache',
    label: 'dynamic diagnostic cache',
    path: evidence.dynamicDiagnostic.read?.path,
  });
  maybeAddPathRemoval(items, {
    exists:
      evidence.projectSharedIdentity.read !== null
      && evidence.projectSharedIdentity.read.status !== 'missing',
    kind: 'project-artifact-identity',
    label: 'project artifact shared identity',
    path: evidence.projectSharedIdentity.read?.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.sharedRuntimeOwner.read.status !== 'missing',
    kind: 'shared-runtime-owner',
    label: 'shared runtime owner',
    path: evidence.sharedRuntimeOwner.read.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.historicalLifecycle.residuePresent,
    kind: 'historical-lifecycle-runtime',
    label: 'historical lifecycle runtime',
    path: evidence.historicalLifecycle.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.nativeTransaction.read.status !== 'missing',
    kind: 'native-transaction-marker',
    label: 'native transaction marker',
    path: getNativeTransactionMarkerPath(evidence.location.plugin, options.env),
  });
  maybeAddPathRemoval(items, {
    exists: evidence.dependencyIndex.projection.currentLocationReferenceStatuses.length > 0,
    kind: 'dependency-index-reference',
    label: 'dependency index reference',
    path: undefined,
    detail: evidence.dependencyIndex.projection.currentLocationReferenceStatuses.join(','),
  });
  for (const artifact of evidence.projectSharedIdentity.artifacts) {
    maybeAddPathRemoval(items, {
      exists: artifact.file.exists,
      kind: 'repo-artifact',
      label: 'project residual artifact',
      path: artifact.file.path,
    });
  }
  for (const artifact of evidence.installRecord.artifacts) {
    const file = artifact.files[0];
    if (!file) {
      continue;
    }
    maybeAddPathRemoval(items, {
      exists: file.exists,
      kind: 'tracked-artifact',
      label: 'tracked artifact',
      path: file.path,
    });
  }

  return uniquePlanItems(items);
}

function buildDefaultConfigActions(options: {
  location: CleanupLocationSummary;
  cwd: string;
  env: NodeJS.ProcessEnv;
  removeConfig: boolean;
  blockedReason?: string;
}): CleanupConfigAction[] {
  return resolvePluginConfigStoreTargets({
    pluginName: options.location.plugin,
    scope: options.location.scope,
    cwd: options.cwd,
    env: options.env,
  }).map((target) => ({
    plugin: options.location.plugin,
    scope: options.location.scope,
    ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
    storeKind: target.storeKind,
    path: target.path,
    status: options.removeConfig
      ? 'skipped'
      : 'kept',
    reason: options.removeConfig
      ? options.blockedReason ?? '默认保留当前 target 的 AW 自管配置。'
      : '默认保留当前 target 的 AW 自管配置。',
  }));
}

export async function buildCleanupEvaluation(options: {
  location: CleanupLocationSummary;
  commandOptions: CleanupCommandOptions;
  env: NodeJS.ProcessEnv;
  target: ResolvedPluginTarget | null;
  targetResolutionError?: string;
}): Promise<CleanupEvaluation> {
  const state = await readInstallStateProjection({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: options.env,
  });
  const targetType = classifyCleanupTargetType(state.evidence, state.projection);
  const affectedDependents = state.removalProtection.blockedDependents.map(toLocationSummary);
  const cleanupScope = collectCleanupScopeItems({
    evidence: state.evidence,
    env: options.env,
  });
  const blockingReasons: CleanupBlockingReason[] = [];
  if (targetType === 'claimable-external') {
    blockingReasons.push({
      code: 'claimableProjectArtifacts',
      message: '当前目标包含可认领的项目产物，cleanup 不会删除这些 repo 可见共享内容。',
      suggestedCommand: renderAdoptExistingCommand(options.location),
    });
  }
  if (targetType === 'foreign-external') {
    blockingReasons.push({
      code: 'foreignExternalEvidence',
      message: '现场包含外部或无法确认归属的内容，cleanup 会跳过这些内容，只处理可安全定位的 AW 状态。',
    });
  }
  if (affectedDependents.length > 0) {
    blockingReasons.push({
      code: 'verifiedDependents',
      message: `目标仍被以下 verified dependents 引用：${affectedDependents.map(renderLocation).join('、')}。`,
    });
  }
  const executionBlocked = affectedDependents.length > 0;

  const payload: CleanupTargetPayload = {
    ok: true,
    command: 'cleanup',
    receiptSchemaVersion: 2,
    overallState: executionBlocked || blockingReasons.length > 0 ? 'failed' : 'succeeded',
    generatedAt: new Date().toISOString(),
    dependencyIndex: false,
    nextStepsSchemaVersion: 1,
    nextSteps: [],
    force: options.commandOptions.force === true,
    removeConfig: options.commandOptions.removeConfig === true,
    target: {
      ...toLocationSummary(options.location),
      targetType,
    },
    cleanupScope,
    deletedItems: [],
    skippedItems: executionBlocked ? cleanupScope : [],
    failedItems: [],
    residueItems: executionBlocked ? cleanupScope : [],
    configActions: buildDefaultConfigActions({
      location: options.location,
      cwd: options.commandOptions.cwd,
      env: options.env,
      removeConfig: options.commandOptions.removeConfig === true,
      ...(executionBlocked ? { blockedReason: blockingReasons[0]?.message } : {}),
    }),
    targetResults: [],
    affectedDependents,
    blockingReasons,
  };

  Object.assign(payload, createNextStepsBoundary(buildCleanupNextSteps(payload)));
  payload.targetResults = buildCleanupTargetResults(payload);
  payload.configStoreRemovals = buildCleanupConfigStoreRemovals(payload);

  return {
    payload,
    execute: !executionBlocked,
    target: options.target,
    ...(options.targetResolutionError ? { targetResolutionError: options.targetResolutionError } : {}),
  };
}

function renderBlockingError(payload: CleanupTargetPayload): Error {
  const primary = payload.blockingReasons[0]?.message ?? 'cleanup 评估失败。';
  const suggested = payload.blockingReasons.find((entry) => entry.suggestedCommand)?.suggestedCommand;
  return new Error(
    `${renderLocation(payload.target)} 无法继续 cleanup：${primary}${suggested ? ` 建议先运行 ${suggested}。` : ''}`,
  );
}

export async function resolveCleanupTarget(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  resolver: typeof loadPluginTargetsForRemovalCommand;
}): Promise<{ target: ResolvedPluginTarget | null; error?: string }> {
  try {
    const resolved = await options.resolver(
      options.cwd,
      options.scope,
      [options.pluginName],
      {
        allowHistoricalFallback: true,
        env: options.env,
      },
    );
    return {
      target: resolved[0] ?? null,
    };
  } catch (error) {
    return {
      target: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function executeCleanupLocation(options: {
  pluginName: string;
  location: CleanupLocationSummary;
  commandOptions: CleanupCommandOptions;
  runtime: CleanupCommandRuntime;
  env: NodeJS.ProcessEnv;
  evaluation: CleanupEvaluation;
}): Promise<{
  warnings: string[];
  repoManagedArtifacts: GeneratedArtifact[];
  payload: CleanupTargetPayload;
}> {
  const cleanupResult = await cleanupInstallStateTarget({
    pluginName: options.pluginName,
    location: options.location,
    commandOptions: options.commandOptions,
    runtime: {
      ...options.runtime,
      adapters: options.runtime.adapters,
    },
    target: options.evaluation.target,
    allowInstalled: true,
  });

  const { actualRemovals, remainingItems } = await partitionExecutedRemovalItems({
    items: options.evaluation.payload.cleanupScope,
    location: options.location,
    cwd: options.commandOptions.cwd,
    env: options.env,
  });
  const deletedItems = uniquePlanItems(actualRemovals);
  const failedItems = uniquePlanItems(cleanupResult.failedItems.map((item) => ({
    kind: item.kind,
    label: item.label,
    ...(item.path ? { path: item.path } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
  })));
  const skippedItems = uniquePlanItems(cleanupResult.skippedItems.map((item) => ({
    kind: item.kind,
    label: item.label,
    ...(item.path ? { path: item.path } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
  })));
  const residueItems = uniquePlanItems([
    ...remainingItems,
    ...failedItems,
    ...skippedItems,
  ]);

  let configActions = options.evaluation.payload.configActions;
  if (options.commandOptions.removeConfig) {
    if (failedItems.length > 0 || remainingItems.length > 0) {
      configActions = configActions.map((entry) => ({
        ...entry,
        status: 'skipped',
        reason: '主体清理未完全完成，因此保留当前 target 的 AW 自管配置。',
      }));
      cleanupResult.warnings.push('主体清理未完全完成，因此保留当前 target 的 AW 自管配置。');
    } else {
      try {
        const resets = await resetPluginConfigStores({
          pluginName: options.location.plugin,
          scope: options.location.scope,
          cwd: options.commandOptions.cwd,
          env: options.env,
        });
        configActions = resets.map((reset) => ({
          plugin: options.location.plugin,
          scope: options.location.scope,
          ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
          storeKind: reset.storeKind,
          path: reset.path,
          status: reset.deleted ? 'removed' : 'skipped',
          ...(reset.deleted ? {} : { reason: '当前 target scope 没有可删除的 AW 自管配置。' }),
        }));
        if (resets.some((entry) => entry.deleted)) {
          cleanupResult.warnings.push('已删除当前 target 的 AW 自管配置。');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        configActions = configActions.map((entry) => ({
          ...entry,
          status: 'failed',
          reason,
        }));
        cleanupResult.warnings.push(`主体清理已完成，但删除当前 target 的 AW 自管配置失败：${reason}`);
      }
    }
  }

  const payload: CleanupTargetPayload = {
    ...options.evaluation.payload,
    overallState: failedItems.length > 0 || residueItems.length > 0 ? 'failed' : 'succeeded',
    deletedItems,
    skippedItems,
    failedItems,
    residueItems,
    configActions: uniqueCleanupConfigActions(configActions),
    targetResults: [],
  };
  Object.assign(payload, createNextStepsBoundary(buildCleanupNextSteps(payload)));
  payload.targetResults = buildCleanupTargetResults(payload);
  payload.configStoreRemovals = buildCleanupConfigStoreRemovals(payload);

  return {
    warnings: cleanupResult.warnings,
    repoManagedArtifacts: cleanupResult.repoManagedArtifacts,
    payload,
  };
}

function mergeCleanupPayloads(options: {
  payloads: CleanupTargetPayload[];
  force: boolean;
  removeConfig: boolean;
}): CleanupTargetPayload {
  const first = options.payloads[0]!;
  const blockingReasons = uniqueCleanupBlockingReasons(
    options.payloads.flatMap((payload) => payload.blockingReasons),
  );
  const overallState = options.payloads.some((payload) => isCleanupExecutionFailure(payload))
    ? 'failed'
    : blockingReasons.length > 0
      ? 'failed'
      : 'succeeded';
  const payload: CleanupTargetPayload = {
    ...first,
    overallState,
    force: options.force,
    removeConfig: options.removeConfig,
    cleanupScope: uniquePlanItems(options.payloads.flatMap((payload) => payload.cleanupScope)),
    deletedItems: uniquePlanItems(options.payloads.flatMap((payload) => payload.deletedItems)),
    skippedItems: uniquePlanItems(options.payloads.flatMap((payload) => payload.skippedItems)),
    failedItems: uniquePlanItems(options.payloads.flatMap((payload) => payload.failedItems)),
    residueItems: uniquePlanItems(options.payloads.flatMap((payload) => payload.residueItems)),
    configActions: uniqueCleanupConfigActions(
      options.payloads.flatMap((payload) => payload.configActions),
    ),
    affectedDependents: uniqueCleanupLocations(
      options.payloads.flatMap((payload) => payload.affectedDependents),
    ),
    blockingReasons,
    targetResults: options.payloads.flatMap((payload) => payload.targetResults),
    configStoreRemovals: options.payloads.flatMap((payload) => payload.configStoreRemovals ?? []),
  };
  Object.assign(payload, createNextStepsBoundary(buildCleanupNextSteps(payload)));
  return payload;
}

export async function cleanupCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: CleanupCommandRuntime = {},
): Promise<{
  platforms: string[];
  plugins: string[];
  warnings: string[];
  repoManagedArtifacts: GeneratedArtifact[];
  retiredEntries?: CleanupRetiredEntry[];
  payload: CleanupJsonPayload;
}> {
  const options = normalizeCleanupCommandOptions(rawOptions, {
    defaultScope: 'user',
  });
  const context = createCommandExecutionContext(runtime);

  if (options.dependencyIndex) {
    const result = await pruneDependencyIndexStaleEntry({
      pruneToken: options.pruneStale!,
      env: context.env,
    });
    const payload: CleanupDependencyIndexPayload = {
      ok: true,
      command: 'cleanup',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      generatedAt: new Date().toISOString(),
      dependencyIndex: true,
      targetResults: [],
      pruneToken: result.pruneToken,
      action: result.action,
      ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      retiredEntries: result.retiredEntries.map((entry) => ({
        location: {
          plugin: entry.location.plugin,
          platform: entry.location.platform,
          scope: entry.location.scope,
          ...(entry.location.projectKey ? { projectKey: entry.location.projectKey } : {}),
        },
        recordPath: entry.recordPath,
      })),
      ...buildCleanupDependencyIndexNextSteps(),
    };
    return {
      platforms: [],
      plugins: [],
      warnings: result.warnings,
      repoManagedArtifacts: [],
      retiredEntries: payload.retiredEntries,
      payload,
    };
  }

  if (pluginNames.length !== 1) {
    throw new Error('cleanup 命令当前只支持单个插件目标。');
  }
  if (options.platform === 'both') {
    const candidates = await buildCommandCandidates({
      command: 'status',
      cwd: options.cwd,
      scopeFilter: options.scope,
      platformFilter: 'both',
      pluginNames,
      env: context.env,
      includeCurrentCatalog: false,
    });
    const evaluations: Array<{
      location: CleanupLocationSummary;
      evaluation: CleanupEvaluation;
      payload: CleanupTargetPayload;
      target: ResolvedPluginTarget | null;
    }> = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const location: CleanupLocationSummary = {
        plugin: candidate.pluginName,
        platform: candidate.platform,
        scope: candidate.scope,
        ...(candidate.projectKey ? { projectKey: candidate.projectKey } : {}),
      };
      const locationKey = renderLocation(location);
      if (seen.has(locationKey)) {
        continue;
      }
      const evaluation = await buildCleanupEvaluation({
        location,
        commandOptions: options,
        env: context.env,
        target: candidate.target,
      });
      if (!hasCleanupCandidateEvidence(candidate) && evaluation.payload.cleanupScope.length === 0) {
        continue;
      }
      seen.add(locationKey);
      evaluations.push({
        location,
        evaluation,
        payload: evaluation.payload,
        target: candidate.target,
      });
    }

    if (evaluations.length === 0) {
      throw new Error('cleanup --platform both 没有找到可由 AW 安全处理的受管 target；它不会包含纯未安装格子。');
    }

    const blockedEvaluation = evaluations.find((entry) => !entry.evaluation.execute);
    if (blockedEvaluation) {
      throw renderBlockingError(blockedEvaluation.payload);
    }

    await assertAgentVersionsForWriteTargets({
      command: 'cleanup',
      platforms: evaluations.map((entry) => entry.location.platform),
      cwd: options.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
    });

    const executed = [];
    let repoManagedArtifacts: GeneratedArtifact[] = [];
    let warnings: string[] = [];
    for (const entry of evaluations) {
      const result = await executeCleanupLocation({
        pluginName: pluginNames[0]!,
        location: entry.location,
        commandOptions: {
          ...options,
          platform: entry.location.platform,
        },
        runtime,
        env: context.env,
        evaluation: entry.evaluation,
      });
      executed.push(result);
      repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, result.repoManagedArtifacts);
      warnings = [...warnings, ...result.warnings];
    }

    return {
      platforms: [...new Set(evaluations.map((entry) => entry.location.platform))],
      plugins: [pluginNames[0]!],
      warnings: [...new Set(warnings)],
      repoManagedArtifacts,
      payload: mergeCleanupPayloads({
        payloads: executed.map((entry) => entry.payload),
        force: options.force,
        removeConfig: options.removeConfig,
      }),
    };
  }

  const location: CleanupLocationSummary = {
    plugin: pluginNames[0]!,
    platform: options.platform,
    scope: options.scope,
    ...(options.scope === 'project'
      ? { projectKey: await resolveProjectKey(options.platform, options.cwd) }
      : {}),
  };
  const resolvedTarget = await resolveCleanupTarget({
    pluginName: pluginNames[0]!,
    scope: options.scope,
    cwd: options.cwd,
    env: context.env,
    resolver: runtime.p9TargetResolver ?? loadPluginTargetsForRemovalCommand,
  });
  const evaluation = await buildCleanupEvaluation({
    location,
    commandOptions: options,
    env: context.env,
    target: resolvedTarget.target,
    ...(resolvedTarget.error ? { targetResolutionError: resolvedTarget.error } : {}),
  });
  if (!evaluation.execute) {
    throw renderBlockingError(evaluation.payload);
  }
  await assertAgentVersionsForWriteTargets({
    command: 'cleanup',
    platforms: [location.platform],
    cwd: options.cwd,
    env: context.env,
    nativeCliRunner: context.nativeCliRunner,
  });
  const execution = await executeCleanupLocation({
    pluginName: pluginNames[0]!,
    location,
    commandOptions: options,
    runtime,
    env: context.env,
    evaluation,
  });

  return {
    platforms: [location.platform],
    plugins: [location.plugin],
    warnings: execution.warnings,
    repoManagedArtifacts: execution.repoManagedArtifacts,
    payload: execution.payload,
  };
}
