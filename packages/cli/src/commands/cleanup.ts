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
  createHistoricalPluginTarget,
  loadPluginTargetsForRemovalCommand,
  type ResolvedPluginTarget,
} from './common.js';
import type { GeneratedArtifact, PlatformName, PluginLocation, Scope } from '../types.js';
import { getNativeTransactionMarkerPath } from '../install-state/paths.js';
import type { InstallEvidence } from '../install-state/evidence.js';
import type { ProjectInstallStateProjection } from '../install-state/status-projection.js';
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
  generatedAt: string;
  dependencyIndex: false;
  cleanupPlanSchemaVersion: 1;
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
  generatedAt: string;
  dependencyIndex: true;
  retiredEntries: CleanupRetiredEntry[];
  nextSteps: string[];
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

function renderAdoptExistingCommand(location: CleanupLocationSummary): string {
  return `aw repair ${renderLocationArgs(location)} --adopt-existing`;
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
  return `aw diagnose ${renderLocationArgs(options.location)}`;
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

  const payload: CleanupTargetPayload = {
    ok: true,
    command: 'cleanup',
    generatedAt: new Date().toISOString(),
    dependencyIndex: false,
    cleanupPlanSchemaVersion: 1,
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
    skippedForeignItems: [],
    affectedDependents,
    blockingReasons,
    recommendedCommand: buildRecommendedCommand({
      location: options.location,
      dryRun: options.commandOptions.plan === true,
      force: options.commandOptions.force === true,
      removeConfig: options.commandOptions.removeConfig === true,
      blockingReasons,
      targetType,
    }),
  };

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
    defaultPlatform: 'auto',
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
      generatedAt: new Date().toISOString(),
      dependencyIndex: true,
      retiredEntries: result.retiredEntries.map((entry) => ({
        location: {
          plugin: entry.location.plugin,
          platform: entry.location.platform,
          scope: entry.location.scope,
          ...(entry.location.projectKey ? { projectKey: entry.location.projectKey } : {}),
        },
        recordPath: entry.recordPath,
      })),
      nextSteps: ['运行 aw diagnose 查看最新依赖状态。'],
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
  if (options.platform === 'auto' || options.platform === 'both') {
    throw new Error('cleanup 命令需要显式指定单一平台。');
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

  const warnings: string[] = [];
  let repoManagedArtifacts: GeneratedArtifact[] = [];
  let actualBackups: CleanupPlanItem[] = [];
  let actualSkippedItems = evaluation.payload.skippedForeignItems;
  let executionTarget = evaluation.target;
  if (!executionTarget) {
    executionTarget = await createHistoricalPluginTarget(
      options.cwd,
      options.scope,
      location.plugin,
      undefined,
      context.env,
      undefined,
      {
        codexNativeManifestPlaceholder: evaluation.payload.target.targetType === 'manifest-only'
          || evaluation.payload.target.targetType === 'cache-only'
          || evaluation.payload.target.targetType === 'config-only'
          || evaluation.payload.target.targetType === 'native-residue',
      },
    );
  }

  const forcedRecoveryCleanup =
    evaluation.payload.target.targetType === 'installed'
    && options.force
    && !evaluation.target
    && Boolean(evaluation.targetResolutionError);
  const shouldAttemptStandardUninstall =
    evaluation.payload.target.targetType === 'installed'
    && !forcedRecoveryCleanup;
  let standardUninstallError: string | null = forcedRecoveryCleanup
    ? evaluation.targetResolutionError ?? '未能解析标准 uninstall 等价 target。'
    : null;
  if (shouldAttemptStandardUninstall) {
    try {
      const uninstallResult = await tryUninstallUsingInstallState({
        target: executionTarget,
        platform: location.platform,
        commandOptions: options,
        runtime: {
          ...runtime,
          adapters: runtime.adapters,
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
    if (standardUninstallError && !options.force) {
      throw new Error(
        `${renderLocation(location)} 的标准 uninstall 等价 cleanup 失败：${standardUninstallError} 如需降级为恢复清理，请先运行 ${renderCleanupCommand(location, {
          plan: true,
          force: true,
          removeConfig: options.removeConfig,
        })}。`,
      );
    }
    if (standardUninstallError) {
      warnings.push(
        `[${renderLocation(location)}] 标准 uninstall 等价 cleanup 失败，已因 --force 降级为恢复清理：${standardUninstallError}`,
      );
    }
    const cleanupResult = await cleanupInstallStateTarget({
      pluginName: pluginNames[0]!,
      location,
      commandOptions: options,
      runtime: {
        ...runtime,
        adapters: runtime.adapters,
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
      ...evaluation.payload.skippedForeignItems,
      ...cleanupResult.skippedItems,
    ]);
  }

  const { actualRemovals, remainingItems } = await partitionExecutedRemovalItems({
    items: evaluation.payload.plannedRemovals,
    location,
    cwd: options.cwd,
    env: context.env,
  });
  const cleanupFailed = remainingItems.length > 0;
  let wouldRemoveConfig = evaluation.payload.wouldRemoveConfig;
  if (options.removeConfig) {
    if (cleanupFailed) {
      const configPath = evaluation.payload.wouldRemoveConfig[0]?.path ?? resolvePluginConfigStorePath({
        pluginName: location.plugin,
        scope: location.scope,
        cwd: options.cwd,
        env: context.env,
      });
      wouldRemoveConfig = [{
        plugin: location.plugin,
        scope: location.scope,
        ...(location.projectKey ? { projectKey: location.projectKey } : {}),
        path: configPath,
        status: 'skipped',
        reason: '主体清理未完全完成，因此跳过 remove-config。',
      }];
      warnings.push('主体清理未完全完成，因此保留当前 target scope 的 AW 自管配置。');
    } else {
      try {
        const reset = await resetPluginConfigStore({
          pluginName: location.plugin,
          scope: location.scope,
          cwd: options.cwd,
          env: context.env,
        });
        wouldRemoveConfig = [{
          plugin: location.plugin,
          scope: location.scope,
          ...(location.projectKey ? { projectKey: location.projectKey } : {}),
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
        const configPath = evaluation.payload.wouldRemoveConfig[0]?.path ?? resolvePluginConfigStorePath({
          pluginName: location.plugin,
          scope: location.scope,
          cwd: options.cwd,
          env: context.env,
        });
        const reason = error instanceof Error ? error.message : String(error);
        wouldRemoveConfig = [{
          plugin: location.plugin,
          scope: location.scope,
          ...(location.projectKey ? { projectKey: location.projectKey } : {}),
          path: configPath,
          status: 'failed',
          reason,
        }];
        warnings.push(`主体清理已完成，但删除当前 target scope 的 AW 自管配置失败：${reason}`);
      }
    }
  }

  return {
    platforms: [location.platform],
    plugins: [location.plugin],
    warnings,
    repoManagedArtifacts,
    payload: {
      ...evaluation.payload,
      dryRun: false,
      wouldRemoveConfig,
      actualRemovals,
      actualBackups,
      skippedItems: actualSkippedItems,
      remainingItems,
    },
  };
}
