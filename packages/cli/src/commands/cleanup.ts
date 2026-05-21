import fs from 'fs-extra';

import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import {
  cleanupInstallStateTarget,
  pruneDependencyIndexStaleEntry,
  readInstallStateProjection,
  tryUninstallUsingInstallState,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import {
  normalizeCleanupCommandOptions,
  type CleanupCommandOptions,
  type RawCleanupCommandOptions,
} from './options.js';
import {
  assertAgentVersionsForWriteTargets,
  createHistoricalPluginTarget,
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
  PlatformSelection,
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
import { resolvePluginConfigStorePath, resetPluginConfigStore } from '../utils/plugin-config.js';
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
  path: string;
  status: 'planned' | 'blocked' | 'removed' | 'skipped' | 'failed';
  reason?: string;
}

export interface CleanupBlockingReason {
  code: string;
  message: string;
  suggestedCommand?: string;
}

export type CleanupTargetType =
  | 'installed'
  | 'needs-repair'
  | 'residual'
  | 'marker-only'
  | 'config-only'
  | 'manifest-only'
  | 'cache-only'
  | 'native-residue'
  | 'adoptable'
  | 'externally-managed'
  | 'not-installed';

export interface CleanupTargetPayload {
  ok: true;
  command: 'cleanup';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  generatedAt: string;
  dependencyIndex: false;
  cleanupPlanSchemaVersion: 1;
  targetResults: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  dryRun: boolean;
  force: boolean;
  removeConfig: boolean;
  target: CleanupLocationSummary & {
    targetType: CleanupTargetType;
  };
  forceReason: string | null;
  plannedRemovals: CleanupPlanItem[];
  wouldBackups: CleanupPlanItem[];
  wouldRemoveConfig: CleanupConfigAction[];
  skippedForeignItems: CleanupPlanItem[];
  affectedDependents: CleanupLocationSummary[];
  blockingReasons: CleanupBlockingReason[];
  recommendedCommand: string;
  actualRemovals?: CleanupPlanItem[];
  actualBackups?: CleanupPlanItem[];
  skippedItems?: CleanupPlanItem[];
  remainingItems?: CleanupPlanItem[];
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
  retiredEntries: CleanupRetiredEntry[];
}

export type CleanupJsonPayload = CleanupTargetPayload | CleanupDependencyIndexPayload;

export interface CleanupCommandRuntime extends InstallStateRemovalRuntime {
  p9TargetResolver?: typeof loadPluginTargetsForRemovalCommand;
}

interface CleanupEvaluation {
  payload: CleanupTargetPayload;
  target: ResolvedPluginTarget | null;
  targetResolutionError?: string;
}

export function isCleanupExecutionFailure(payload: CleanupJsonPayload): boolean {
  return !payload.dependencyIndex
    && payload.dryRun === false
    && (
      payload.blockingReasons.length > 0
      || (payload.remainingItems?.length ?? 0) > 0
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

function renderCleanupSelectionArgs(options: {
  plugin: string;
  platform: PlatformSelection;
  scope: Scope;
}): string {
  return `${options.plugin} --platform ${options.platform} --scope ${options.scope}`;
}

function renderCleanupCommand(location: CleanupLocationSummary, options: {
  force?: boolean;
  plan?: boolean;
  removeConfig?: boolean;
} = {}): string {
  return `aw cleanup ${renderLocationArgs(location)}`
    + `${options.plan ? ' --plan' : ''}`
    + `${options.force ? ' --force' : ''}`
    + `${options.removeConfig ? ' --remove-config' : ''}`;
}

function renderCleanupCommandForSelection(options: {
  plugin: string;
  platform: PlatformSelection;
  scope: Scope;
  force?: boolean;
  plan?: boolean;
  removeConfig?: boolean;
}): string {
  return `aw cleanup ${renderCleanupSelectionArgs(options)}`
    + `${options.plan ? ' --plan' : ''}`
    + `${options.force ? ' --force' : ''}`
    + `${options.removeConfig ? ' --remove-config' : ''}`;
}

function renderAdoptExistingCommand(location: CleanupLocationSummary): string {
  return `aw repair ${renderLocationArgs(location)} --adopt-existing`;
}

function buildCleanupStatusCommand(location: CleanupLocationSummary): string {
  return `aw status ${renderLocationArgs(location)}`;
}

function buildCleanupStatusCommandForSelection(options: {
  plugin: string;
  platform: PlatformSelection;
  scope: Scope;
}): string {
  return `aw status ${renderCleanupSelectionArgs(options)}`;
}

function buildCleanupNextSteps(payload: CleanupTargetPayload): NextStepInstruction[] {
  if (payload.dryRun) {
    return [createCliCommandNextStep(
      payload.blockingReasons.length > 0 ? '查看 cleanup 预检结果' : '继续执行 cleanup',
      payload.blockingReasons.length > 0
        ? '可以根据这次预检结果判断是先解除阻断，还是按建议继续处理。'
        : '可以继续进入 cleanup 执行流程，并按这次预检确认删除项、备份项和配置处理结果。',
      payload.recommendedCommand,
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
    state: payload.dryRun
      ? 'notRun'
      : (payload.remainingItems?.length ?? 0) > 0 || payload.blockingReasons.length > 0
        ? 'failed'
        : 'completed',
    rollbackState: 'notNeeded',
    ...((payload.remainingItems?.length ?? 0) > 0
      ? { message: `仍有 ${payload.remainingItems!.length} 项未清理。` }
      : payload.blockingReasons[0]
        ? { message: payload.blockingReasons[0].message, errorCode: payload.blockingReasons[0].code }
        : {}),
  }];
}

function buildCleanupConfigStoreRemovals(
  payload: CleanupTargetPayload,
): ConfigStoreRemovalResult[] | undefined {
  if (payload.wouldRemoveConfig.length === 0) {
    return undefined;
  }

  return payload.wouldRemoveConfig.map((entry) => ({
    store: {
      pluginName: entry.plugin,
      storeKind: entry.scope === 'project' ? 'projectShared' : 'user',
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
      return evidence.installRecord.fileExists;
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
      return evidence.nativeTransaction.present;
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
    return 'marker-only';
  }
  switch (projection.kind) {
    case 'installed':
      return 'installed';
    case 'needsRepair':
      return 'needs-repair';
    case 'residual':
      return 'residual';
    case 'adoptable':
      return 'adoptable';
    case 'externallyManaged':
      return 'externally-managed';
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

function collectPlannedRemovals(options: {
  location: CleanupLocationSummary;
  evidence: InstallEvidence;
  env: NodeJS.ProcessEnv;
}): CleanupPlanItem[] {
  const { evidence } = options;
  const items: CleanupPlanItem[] = [];
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
    exists: evidence.installRecord.fileExists,
    kind: 'install-record',
    label: 'install record',
    path: evidence.installRecord.read.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.dynamicDiagnostic.read?.status === 'ok',
    kind: 'diagnostic-cache',
    label: 'dynamic diagnostic cache',
    path: evidence.dynamicDiagnostic.read?.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.projectSharedIdentity.read?.status === 'ok',
    kind: 'project-artifact-identity',
    label: 'project artifact shared identity',
    path: evidence.projectSharedIdentity.read?.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.sharedRuntimeOwner.read.status === 'ok',
    kind: 'shared-runtime-owner',
    label: 'shared runtime owner',
    path: evidence.sharedRuntimeOwner.read.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.historicalLifecycle.path !== null,
    kind: 'historical-lifecycle-runtime',
    label: 'historical lifecycle runtime',
    path: evidence.historicalLifecycle.path,
  });
  maybeAddPathRemoval(items, {
    exists: evidence.nativeTransaction.present,
    kind: 'native-transaction-marker',
    label: 'native transaction marker',
    path: getNativeTransactionMarkerPath(evidence.location.plugin, options.env),
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

function buildForceReason(options: {
  forceCleanupRequired: boolean;
  blockedDependents: CleanupLocationSummary[];
  standardUninstallFallbackReason?: string | null;
}): string | null {
  const reasons: string[] = [];
  if (options.forceCleanupRequired) {
    reasons.push('需要先备份共享文件再执行清理。');
  }
  if (options.blockedDependents.length > 0) {
    reasons.push('目标仍被 verified dependents 引用，`--force` 会保留 dependent 本身，只清理当前目标；这些 dependent 后续可能需要 repair、reinstall 或 cleanup。');
  }
  if (options.standardUninstallFallbackReason) {
    reasons.push(options.standardUninstallFallbackReason);
  }
  return reasons.length > 0 ? reasons.join(' ') : null;
}

function buildRecommendedCommand(options: {
  location: CleanupLocationSummary;
  dryRun: boolean;
  force: boolean;
  removeConfig: boolean;
  blockingReasons: CleanupBlockingReason[];
  targetType: CleanupTargetType;
}): string {
  if (options.targetType === 'adoptable') {
    return renderAdoptExistingCommand(options.location);
  }
  const suggestedBlockingCommand = options.blockingReasons.find((entry) => entry.suggestedCommand)?.suggestedCommand;
  if (suggestedBlockingCommand) {
    return suggestedBlockingCommand;
  }
  if (options.dryRun) {
    return renderCleanupCommand(options.location, {
      force: options.force,
      removeConfig: options.removeConfig,
    });
  }
  return `aw status ${renderLocationArgs(options.location)} --verbose`;
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

async function buildCleanupEvaluation(options: {
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
  const plannedRemovals = collectPlannedRemovals({
    location: options.location,
    evidence: state.evidence,
    env: options.env,
  });
  const blockingReasons: CleanupBlockingReason[] = [];
  if (targetType === 'adoptable') {
    blockingReasons.push({
      code: 'duplicateInstall',
      message: '当前是可认领的重复安装场景，普通 cleanup 不会直接删除共享产物。',
      suggestedCommand: renderAdoptExistingCommand(options.location),
    });
  }
  if (targetType === 'externally-managed' && !isPureCodexUserNativeResidue(state.evidence)) {
    blockingReasons.push({
      code: 'foreignOwnershipConflict',
      message: '现场包含不能安全枚举或证明归属的外部内容，cleanup 默认不会直接删除。',
    });
  }
  if (targetType === 'not-installed' && plannedRemovals.length === 0) {
    blockingReasons.push({
      code: 'nothingToClean',
      message: '当前没有可由 AW 安全清理的目标。',
    });
  }
  if (state.forceCleanupRequired && options.commandOptions.force !== true) {
    blockingReasons.push({
      code: 'forceRequired',
      message: '当前 cleanup 会先备份共享文件；请先用 `--plan --force` 预览，确认后再执行 `--force`。',
      suggestedCommand: renderCleanupCommand(options.location, {
        plan: true,
        force: true,
        removeConfig: options.commandOptions.removeConfig,
      }),
    });
  }
  if (affectedDependents.length > 0 && options.commandOptions.force !== true) {
    blockingReasons.push({
      code: 'verifiedDependents',
      message: `目标仍被以下 verified dependents 引用：${affectedDependents.map(renderLocation).join('、')}。`,
      suggestedCommand: renderCleanupCommand(options.location, {
        plan: true,
        force: true,
        removeConfig: options.commandOptions.removeConfig,
      }),
    });
  }
  if (
    targetType === 'installed'
    && options.commandOptions.force !== true
    && !options.target
    && options.targetResolutionError
  ) {
    blockingReasons.push({
      code: 'standardUninstallTargetUnavailable',
      message: `标准 uninstall 等价路径缺少可执行 target：${options.targetResolutionError}`,
      suggestedCommand: renderCleanupCommand(options.location, {
        plan: true,
        force: true,
        removeConfig: options.commandOptions.removeConfig,
      }),
    });
  }

  const standardUninstallFallbackReason =
    targetType === 'installed'
    && options.commandOptions.force === true
    && !options.target
    && options.targetResolutionError
      ? `标准 uninstall 等价路径不可用，执行时会降级为恢复清理：${options.targetResolutionError}`
      : null;

  const wouldRemoveConfig = options.commandOptions.removeConfig
    ? [{
        plugin: options.location.plugin,
        scope: options.location.scope,
        ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
        path: resolvePluginConfigStorePath({
          pluginName: options.location.plugin,
          scope: options.location.scope,
          cwd: options.commandOptions.cwd,
          env: options.env,
        }),
        status: (blockingReasons.length > 0 ? 'blocked' : 'planned') as CleanupConfigAction['status'],
        ...(blockingReasons.length > 0 ? { reason: blockingReasons[0]!.message } : {}),
      }]
    : [];

  const wouldBackups = state.forceCleanupRequired
    ? uniquePlanItems(
        state.evidence.projectSharedIdentity.artifacts
          .filter((artifact) => artifact.file.exists)
          .map((artifact) => ({
            kind: 'backup',
            label: 'shared file backup',
            path: artifact.file.path,
            detail: 'cleanup --force 会先备份共享文件。',
          })),
      )
    : [];

  const recommendedCommand = buildRecommendedCommand({
    location: options.location,
    dryRun: options.commandOptions.plan === true,
    force: options.commandOptions.force === true,
    removeConfig: options.commandOptions.removeConfig === true,
    blockingReasons,
    targetType,
  });

  const payload: CleanupTargetPayload = {
    ok: true,
    command: 'cleanup',
    receiptSchemaVersion: 2,
    overallState: blockingReasons.length > 0 ? 'failed' : 'succeeded',
    generatedAt: new Date().toISOString(),
    dependencyIndex: false,
    cleanupPlanSchemaVersion: 1,
    ...createNextStepsBoundary([createCliCommandNextStep(
      blockingReasons.length > 0 ? '查看 cleanup 预检结果' : '继续执行 cleanup',
      blockingReasons.length > 0
        ? '可以根据这次预检结果判断是先解除阻断，还是按建议继续处理。'
        : '可以继续进入 cleanup 执行流程，并按这次预检确认删除项、备份项和配置处理结果。',
      recommendedCommand,
    )]),
    dryRun: options.commandOptions.plan === true,
    force: options.commandOptions.force === true,
    removeConfig: options.commandOptions.removeConfig === true,
    target: {
      ...toLocationSummary(options.location),
      targetType,
    },
    forceReason: buildForceReason({
      forceCleanupRequired: state.forceCleanupRequired,
      blockedDependents: affectedDependents,
      standardUninstallFallbackReason,
    }),
    plannedRemovals,
    wouldBackups,
    wouldRemoveConfig,
    targetResults: [],
    skippedForeignItems: [],
    affectedDependents,
    blockingReasons,
    recommendedCommand,
  };

  payload.targetResults = buildCleanupTargetResults(payload);
  payload.configStoreRemovals = buildCleanupConfigStoreRemovals(payload);

  return {
    payload,
    target: options.target,
    ...(options.targetResolutionError ? { targetResolutionError: options.targetResolutionError } : {}),
  };
}

function renderBlockingError(payload: CleanupTargetPayload): Error {
  const primary = payload.blockingReasons[0]?.message ?? 'cleanup 评估失败。';
  return new Error(
    `${renderLocation(payload.target)} 无法继续 cleanup：${primary} 建议先运行 ${payload.recommendedCommand}。`,
  );
}

async function resolveCleanupTarget(options: {
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

async function executeCleanupLocation(options: {
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
  const warnings: string[] = [];
  let repoManagedArtifacts: GeneratedArtifact[] = [];
  let actualBackups: CleanupPlanItem[] = [];
  let actualSkippedItems = options.evaluation.payload.skippedForeignItems;
  let executionTarget = options.evaluation.target;
  if (!executionTarget) {
    executionTarget = await createHistoricalPluginTarget(
      options.commandOptions.cwd,
      options.commandOptions.scope,
      options.location.plugin,
      undefined,
      options.env,
      undefined,
      {
        codexNativeManifestPlaceholder: options.evaluation.payload.target.targetType === 'manifest-only'
          || options.evaluation.payload.target.targetType === 'cache-only'
          || options.evaluation.payload.target.targetType === 'config-only'
          || options.evaluation.payload.target.targetType === 'native-residue',
      },
    );
  }

  const forcedRecoveryCleanup =
    options.evaluation.payload.target.targetType === 'installed'
    && options.commandOptions.force
    && !options.evaluation.target
    && Boolean(options.evaluation.targetResolutionError);
  const shouldAttemptStandardUninstall =
    options.evaluation.payload.target.targetType === 'installed'
    && !forcedRecoveryCleanup;
  let standardUninstallError: string | null = forcedRecoveryCleanup
    ? options.evaluation.targetResolutionError ?? '未能解析标准 uninstall 等价 target。'
    : null;
  if (shouldAttemptStandardUninstall) {
    try {
      const uninstallResult = await tryUninstallUsingInstallState({
        target: executionTarget,
        platform: options.location.platform,
        commandOptions: options.commandOptions,
        runtime: {
          ...options.runtime,
          adapters: options.runtime.adapters,
        },
      });
      if (uninstallResult.handled) {
        warnings.push(...(uninstallResult.result?.warnings ?? []));
        repoManagedArtifacts = uninstallResult.result?.repoManagedArtifacts ?? [];
      } else {
        standardUninstallError = '未能进入标准 uninstall 等价路径。';
      }
    } catch (error) {
      standardUninstallError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!shouldAttemptStandardUninstall || standardUninstallError) {
    if (standardUninstallError && !options.commandOptions.force) {
      throw new Error(
        `${renderLocation(options.location)} 的标准 uninstall 等价 cleanup 失败：${standardUninstallError} 如需降级为恢复清理，请先运行 ${renderCleanupCommand(options.location, {
          plan: true,
          force: true,
          removeConfig: options.commandOptions.removeConfig,
        })}。`,
      );
    }
    if (standardUninstallError) {
      warnings.push(
        `[${renderLocation(options.location)}] 标准 uninstall 等价 cleanup 失败，已因 --force 降级为恢复清理：${standardUninstallError}`,
      );
    }
    const cleanupResult = await cleanupInstallStateTarget({
      pluginName: options.pluginName,
      location: options.location,
      commandOptions: options.commandOptions,
      runtime: {
        ...options.runtime,
        adapters: options.runtime.adapters,
      },
      target: executionTarget,
      allowInstalled: shouldAttemptStandardUninstall || forcedRecoveryCleanup,
    });
    warnings.push(...cleanupResult.warnings);
    repoManagedArtifacts = cleanupResult.repoManagedArtifacts;
    actualBackups = cleanupResult.backups.map((backupPath) => ({
      kind: 'backup',
      label: 'shared file backup',
      path: backupPath,
    }));
    actualSkippedItems = uniquePlanItems([
      ...options.evaluation.payload.skippedForeignItems,
      ...cleanupResult.skippedItems,
    ]);
  }

  const { actualRemovals, remainingItems } = await partitionExecutedRemovalItems({
    items: options.evaluation.payload.plannedRemovals,
    location: options.location,
    cwd: options.commandOptions.cwd,
    env: options.env,
  });
  const cleanupFailed = remainingItems.length > 0;
  let wouldRemoveConfig = options.evaluation.payload.wouldRemoveConfig;
  if (options.commandOptions.removeConfig) {
    if (cleanupFailed) {
      const configPath = options.evaluation.payload.wouldRemoveConfig[0]?.path ?? resolvePluginConfigStorePath({
        pluginName: options.location.plugin,
        scope: options.location.scope,
        cwd: options.commandOptions.cwd,
        env: options.env,
      });
      wouldRemoveConfig = [{
        plugin: options.location.plugin,
        scope: options.location.scope,
        ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
        path: configPath,
        status: 'skipped',
        reason: '主体清理未完全完成，因此跳过 remove-config。',
      }];
      warnings.push('主体清理未完全完成，因此保留当前 target scope 的 AW 自管配置。');
    } else {
      try {
        const reset = await resetPluginConfigStore({
          pluginName: options.location.plugin,
          scope: options.location.scope,
          cwd: options.commandOptions.cwd,
          env: options.env,
        });
        wouldRemoveConfig = [{
          plugin: options.location.plugin,
          scope: options.location.scope,
          ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
          path: reset.path,
          status: reset.deleted ? 'removed' : 'skipped',
          ...(reset.deleted
            ? {}
            : { reason: '当前 target scope 没有可删除的 AW 自管配置。' }),
        }];
        if (reset.deleted) {
          warnings.push('已删除当前 target scope 的 AW 自管配置。');
        }
      } catch (error) {
        const configPath = options.evaluation.payload.wouldRemoveConfig[0]?.path ?? resolvePluginConfigStorePath({
          pluginName: options.location.plugin,
          scope: options.location.scope,
          cwd: options.commandOptions.cwd,
          env: options.env,
        });
        const reason = error instanceof Error ? error.message : String(error);
        wouldRemoveConfig = [{
          plugin: options.location.plugin,
          scope: options.location.scope,
          ...(options.location.projectKey ? { projectKey: options.location.projectKey } : {}),
          path: configPath,
          status: 'failed',
          reason,
        }];
        warnings.push(`主体清理已完成，但删除当前 target scope 的 AW 自管配置失败：${reason}`);
      }
    }
  }

  const payload: CleanupTargetPayload = {
    ...options.evaluation.payload,
    dryRun: false,
    overallState: cleanupFailed ? 'failed' : 'succeeded',
    ...createNextStepsBoundary(buildCleanupNextSteps({
      ...options.evaluation.payload,
      dryRun: false,
      overallState: cleanupFailed ? 'failed' : 'succeeded',
      wouldRemoveConfig,
      actualRemovals,
      actualBackups,
      skippedItems: actualSkippedItems,
      remainingItems,
      targetResults: [],
    })),
    wouldRemoveConfig,
    actualRemovals,
    actualBackups,
    skippedItems: actualSkippedItems,
    remainingItems,
    targetResults: [],
  };
  payload.targetResults = buildCleanupTargetResults(payload);
  payload.configStoreRemovals = buildCleanupConfigStoreRemovals(payload);

  return {
    warnings,
    repoManagedArtifacts,
    payload,
  };
}

function mergeCleanupPayloads(options: {
  payloads: CleanupTargetPayload[];
  pluginName: string;
  scope: Scope;
  platform: PlatformSelection;
  force: boolean;
  plan: boolean;
  removeConfig: boolean;
}): CleanupTargetPayload {
  const first = options.payloads[0]!;
  const dryRun = options.plan;
  const forceReason = [...new Set(
    options.payloads
      .map((payload) => payload.forceReason)
      .filter((reason): reason is string => Boolean(reason)),
  )].join(' ');
  const blockingReasons = uniqueCleanupBlockingReasons(
    options.payloads.flatMap((payload) => payload.blockingReasons),
  );
  const overallState = options.payloads.some((payload) => isCleanupExecutionFailure(payload))
    ? 'failed'
    : blockingReasons.length > 0
      ? 'failed'
      : 'succeeded';
  const recommendedCommand = dryRun
    ? blockingReasons.find((reason) => reason.suggestedCommand)?.suggestedCommand
      ?? renderCleanupCommandForSelection({
        plugin: options.pluginName,
        platform: options.platform,
        scope: options.scope,
        force: options.force,
        removeConfig: options.removeConfig,
      })
    : buildCleanupStatusCommandForSelection({
      plugin: options.pluginName,
      platform: options.platform,
      scope: options.scope,
    });
  const nextSteps = dryRun
    ? createNextStepsBoundary([createCliCommandNextStep(
      blockingReasons.length > 0 ? '查看 cleanup 预检结果' : '继续执行 cleanup',
      blockingReasons.length > 0
        ? '可以根据这次预检结果判断是先解除阻断，还是按建议继续处理。'
        : '可以继续进入 cleanup 执行流程，并按这次预检确认删除项、备份项和配置处理结果。',
      recommendedCommand,
    )])
    : createNextStepsBoundary([createUiActionNextStep(
      '查看 cleanup 后状态',
      '可以重新确认 cleanup 后还剩哪些安装证据、残留和后续可执行动作。',
      'openStatus',
      recommendedCommand,
    )]);

  return {
    ...first,
    overallState,
    force: options.force,
    dryRun,
    removeConfig: options.removeConfig,
    forceReason: forceReason.length > 0 ? forceReason : null,
    plannedRemovals: uniquePlanItems(options.payloads.flatMap((payload) => payload.plannedRemovals)),
    wouldBackups: uniquePlanItems(options.payloads.flatMap((payload) => payload.wouldBackups)),
    wouldRemoveConfig: uniqueCleanupConfigActions(
      options.payloads.flatMap((payload) => payload.wouldRemoveConfig),
    ),
    skippedForeignItems: uniquePlanItems(
      options.payloads.flatMap((payload) => payload.skippedForeignItems),
    ),
    affectedDependents: uniqueCleanupLocations(
      options.payloads.flatMap((payload) => payload.affectedDependents),
    ),
    blockingReasons,
    recommendedCommand,
    ...nextSteps,
    targetResults: options.payloads.flatMap((payload) => payload.targetResults),
    configStoreRemovals: options.payloads.flatMap((payload) => payload.configStoreRemovals ?? []),
    actualRemovals: dryRun
      ? undefined
      : uniquePlanItems(options.payloads.flatMap((payload) => payload.actualRemovals ?? [])),
    actualBackups: dryRun
      ? undefined
      : uniquePlanItems(options.payloads.flatMap((payload) => payload.actualBackups ?? [])),
    skippedItems: dryRun
      ? undefined
      : uniquePlanItems(options.payloads.flatMap((payload) => payload.skippedItems ?? [])),
    remainingItems: dryRun
      ? undefined
      : uniquePlanItems(options.payloads.flatMap((payload) => payload.remainingItems ?? [])),
  };
}

function renderCleanupBothBlockingError(
  evaluations: Array<{
    location: CleanupLocationSummary;
    payload: CleanupTargetPayload;
  }>,
): Error {
  const lines = evaluations.flatMap(({ location, payload }) =>
    payload.blockingReasons.map((reason) => `- ${renderLocation(location)}：${reason.message}`),
  );
  const suggested = evaluations
    .flatMap(({ payload }) => payload.blockingReasons)
    .find((reason) => reason.suggestedCommand)?.suggestedCommand;
  return new Error(
    `cleanup --platform both 预检失败：\n${lines.join('\n')}${
      suggested ? `\n建议先运行 ${suggested}。` : ''
    }`,
  );
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
      payload: CleanupTargetPayload;
      target: ResolvedPluginTarget;
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
      if (!hasCleanupCandidateEvidence(candidate) && evaluation.payload.plannedRemovals.length === 0) {
        continue;
      }
      seen.add(locationKey);
      evaluations.push({
        location,
        payload: evaluation.payload,
        target: candidate.target,
      });
    }

    if (evaluations.length === 0) {
      throw new Error('cleanup --platform both 没有找到可由 AW 安全处理的受管 target；它不会包含纯未安装格子。');
    }

    if (options.plan) {
      const payload = mergeCleanupPayloads({
        payloads: evaluations.map((entry) => entry.payload),
        pluginName: pluginNames[0]!,
        scope: options.scope,
        platform: 'both',
        force: options.force,
        plan: true,
        removeConfig: options.removeConfig,
      });
      return {
        platforms: [...new Set(evaluations.map((entry) => entry.location.platform))],
        plugins: [pluginNames[0]!],
        warnings: [],
        repoManagedArtifacts: [],
        payload,
      };
    }

    const blocking = evaluations.filter((entry) => entry.payload.blockingReasons.length > 0);
    if (blocking.length > 0) {
      throw renderCleanupBothBlockingError(blocking);
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
        evaluation: {
          payload: entry.payload,
          target: entry.target,
        },
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
        pluginName: pluginNames[0]!,
        scope: options.scope,
        platform: 'both',
        force: options.force,
        plan: false,
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
  if (options.plan) {
    return {
      platforms: [location.platform],
      plugins: [location.plugin],
      warnings: [],
      repoManagedArtifacts: [],
      payload: evaluation.payload,
    };
  }
  if (evaluation.payload.blockingReasons.length > 0) {
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
