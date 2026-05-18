import path from 'node:path';

import fs from 'fs-extra';

import {
  applyClaudeInstallLedger,
  applyClaudeUninstallLedger,
} from '../adapters/claude.js';
import {
  applyCodexInstallLedger,
  applyCodexUninstallLedger,
  pruneCodexTrackedArtifacts,
} from '../adapters/codex.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  InstallCommandOptions,
  InstalledDependencyEdge,
  InstalledLedger,
  InstalledScopeRecord,
  LedgerStateReason,
  LifecycleConfigSnapshotMetadata,
  NativeRecoveryState,
  NativePluginsByPlatform,
  PlatformAdapter,
  PlatformName,
  PluginLocation,
  PluginMeta,
  PluginStatusReport,
  ResolvedInstallOptions,
  Scope,
  TrackingManifest,
  UpgradeCommandOptions,
} from '../types.js';
import {
  getInstalledLedgerPath,
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
  resolveRepoRoot,
} from '../utils/paths.js';
import {
  hasSameGeneratedArtifactDesiredIdentity,
  getGeneratedArtifactsFromError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import { SOURCE_MANIFEST_PATH } from '../utils/manifest.js';
import {
  getCodexProjectManagedKinds,
  requiresCodexNativePlugin,
} from '../utils/codex-project-surface.js';
import {
  persistLifecycleConfigSnapshot,
  prepareLifecycleConfigSnapshot,
  runLifecycleScript,
  type PreparedLifecycleConfigSnapshot,
} from '../utils/plugin-scripts.js';
import {
  createPluginConfigSchemaIdentity,
  preflightRequiredPluginConfigs,
} from '../utils/plugin-config.js';
import {
  buildSkillTriggerMaterializationSignature,
  commitMaterializedSkillTriggerPreference,
  collectSkillTriggerSiblingConflictWarnings,
  materializeSkillTriggerPreference,
  readCurrentSkillTriggerRuntimeSignature,
  rollbackMaterializedSkillTriggerPreference,
  type SkillTriggerMaterializationRollbackHandle,
  type SkillTriggerSignatureResult,
} from '../utils/skill-trigger-preferences.js';
import {
  getTrackingRecord,
  getTrackingManifestPath,
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  deleteCodexNativeRecoveryBreadcrumb,
  readCodexNativeRecoveryBreadcrumb,
  updateCodexNativeRecoveryBreadcrumb,
} from '../utils/codex-native-recovery.js';
import {
  captureCodexNativePluginRollbackBaseline,
  disposeCodexNativePluginRollbackBaseline,
  restoreCodexNativePluginRollbackBaseline,
  type CodexNativePluginRollbackBaseline,
} from '../utils/codex-native-state.js';
import {
  inspectGlobalDependencyIndex,
  readInstallRecordForLocation,
  readNativeTransactionMarker,
  readProjectArtifactIdentityForLocator,
  writeNativeTransactionMarker,
} from '../install-state/facade.js';
import {
  createProjectArtifactSharedLocator,
  getInstallRecordPath,
  getInstallStatePrivateRoot,
  getProjectArtifactSharedIdentityPath,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import {
  assertProjectArtifactIdentityPathVisible,
  classifyProjectBoundaryPath,
  ensureProjectPrivateStateIgnore,
} from '../install-state/project-boundary.js';
import {
  stageHistoricalLifecycleRuntime,
} from '../install-state/runtime-state.js';
import {
  preflightSharedSkillTriggerRuntimeOwnerUpsert,
} from '../install-state/shared-runtime-owner.js';
import {
  createDependencyIndexRefreshPostCommitAction,
  createDynamicArtifactDiagnosticCacheWriteStage,
  createDiagnosticCacheDeletePostCommitAction,
  createInstallRecordDeleteStage,
  createInstallRecordWriteStage,
  createNativeTransactionMarkerDeletePostCommitAction,
  createProjectArtifactIdentityWriteStage,
  createSharedRuntimeOwnerWriteStage,
  runInstallStateTransaction,
  type InstallStateTransactionStage,
} from '../install-state/transactions.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  InstallRecordArtifact,
  InstallRecordFile,
  NativeTransactionMarker,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
} from '../install-state/types.js';
import {
  captureArtifactRollbackState,
  collectArtifactRollbackSurfaceHints as collectTrackedArtifactRollbackSurfaceHints,
  disposeArtifactRollbackState,
  rollbackArtifacts as restoreTrackedArtifactRollbackState,
  uninstallTargetsOnPlatforms,
  type ArtifactRollbackState,
} from './uninstall.js';
import {
  collectCommandWarnings,
  createAdapters,
  assertPluginsSupportPlatforms,
  filterPostCommandDriftWarnings,
  getGeneratedArtifactIdentityRefusal,
  getTrackingArtifactIdentityRefusal,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  prepareCommandEnvironment,
  preparePluginTargetsForCommand,
  resolveCurrentCatalogWriteTargetPairs,
  resolveInstallOptionsForLocationTargets,
  resolveInstallOptionsForTargets,
  wrapCommandErrorWithWarnings,
  type PreparedMarketplaceState,
  type ResolvedPluginTarget,
} from './common.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  applyCatalogSelectorEnv,
  normalizeInstallCommandOptions,
  type RawInstallCommandOptions,
} from './options.js';
import { assertCodexProjectInstallableTargets } from './codex-project-installability.js';
import { preflightCodexProjectWriteSafety } from './codex-project-safety.js';
import {
  assertNoDuplicateInstalls,
  shouldEnforceDuplicateInstallPreflight,
} from './scope-exclusivity-preflight.js';
import {
  createInstallSource,
  markScopeRecordExplicitlyRequested,
  upsertDependencyEdges,
} from '../utils/plugin-dependency-graph.js';
import {
  normalizePluginLocation,
  serializePluginLocation,
} from '../utils/plugin-dependency-location.js';
import {
  planPluginDependencyWrites,
  type PluginDependencyEdgePlan,
  type PluginDependencyNodePlan,
  type PluginDependencyPlannerHealthRecord,
  type PluginDependencyPlannerInstalledRecord,
  type PluginDependencyPlannerState,
  type PluginDependencyWritePlan,
} from '../utils/plugin-dependency-planner.js';
import {
  executePluginDependencyWriteGraph,
  type PluginDependencyWriteExecutorNode,
  type PluginDependencyWriteExecutorRollbackFailure,
} from './plugin-dependency-write-executor.js';

type InstallCommandRuntime = CommandExecutionContextInput & {
  resolveInstallOptions?: (
    platform: PlatformName,
    target: ResolvedPluginTarget,
  ) => ResolvedInstallOptions;
  operation?: 'install' | 'upgrade';
  skipConfigPreflight?: boolean;
  skipWriteSafetyPreflight?: boolean;
  upgradeRollbackBaselines?: Map<string, UpgradeRollbackBaseline>;
};

interface InstallCommandReceiptTarget {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  requested: boolean;
  selectedVersion?: string;
  selectedVersionSource?: 'currentCatalog' | 'historical';
  dependencyOf?: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
  }>;
}

interface InstallCommandReceiptAction {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  type: 'installDependency';
  status: 'succeeded';
  selectedVersion?: string;
  selectedVersionSource?: 'currentCatalog' | 'historical';
}

interface InstallLocationNodeResult {
  warnings: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
}

interface InstallCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  marketplace?: PreparedMarketplaceState;
  receiptTargets?: InstallCommandReceiptTarget[];
  receiptActions?: InstallCommandReceiptAction[];
}

export interface InstallLocationGraphContext {
  targetByPlugin: Map<string, ResolvedPluginTarget>;
  statusByLocation: Map<string, PluginStatusReport>;
  installedRecordByLocation: Map<string, PluginDependencyPlannerInstalledRecord>;
}

export interface UpgradeRollbackBaseline {
  artifactRollbackState?: ArtifactRollbackState;
  trackingDir: string;
  trackingManifest: TrackingManifest;
  ledger: InstalledLedger;
  degradedReasonOnRestoreFailure: LedgerStateReason;
}

class PostInstallCleanupError extends Error {
  readonly skipRollback = true;
}

function resolveTrackingDir(
  cwd: string,
  platform: PlatformName,
  scope: InstallCommandOptions['scope'],
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'claude'
    ? resolveClaudePaths(cwd, scope, env).trackingDir
    : resolveCodexPaths(cwd, scope, env).trackingDir;
}

export function createUpgradeRollbackBaselineKey(
  platform: PlatformName,
  pluginName: string,
): string {
  return `${platform}:${pluginName}`;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toInstallRecordInstallSource(
  kind: 'explicit' | 'dependency',
): InstallRecordFile['record']['installSource'] {
  return {
    kind,
    explicitlyRequested: kind === 'explicit',
  };
}

function toPlannerInstallSource(
  source: InstallRecordFile['record']['installSource'] | undefined,
): InstalledScopeRecord<Record<string, unknown>>['installSource'] | undefined {
  if (!source) {
    return undefined;
  }
  return {
    kind: source.kind,
    explicitlyRequested: source.explicitlyRequested,
    allowsUnusedCleanup: source.kind === 'dependency' && source.explicitlyRequested === false,
  };
}

function toInstallStateLocation(
  location: PluginLocation,
): PluginLocation {
  return normalizePluginLocation(location);
}

function toPlannerInstalledRecordFromInstallRecord(
  recordFile: InstallRecordFile,
): PluginDependencyPlannerInstalledRecord {
  const location = normalizePluginLocation({
    plugin: recordFile.record.pluginName,
    platform: recordFile.record.platform,
    scope: recordFile.record.scope,
    projectKey: recordFile.record.scope === 'project'
      ? recordFile.record.projectKey ?? null
      : null,
  });
  return {
    location,
    resolvedVersion: recordFile.record.source.pluginVersion,
    installSource: toPlannerInstallSource(recordFile.record.installSource),
    dependencyEdges: recordFile.record.dependencyEdges.map((edge) => ({
      dependency: normalizePluginLocation({
        ...edge.dependency,
        projectKey: edge.dependency.projectKey ?? null,
      }),
      declaration: structuredClone(edge.declaration),
    })),
    installOptions: recordFile.record.options
      ? structuredClone(recordFile.record.options)
      : undefined,
  };
}

function toInstallRecordArtifacts(
  artifacts: readonly GeneratedArtifact[],
): InstallRecordArtifact[] {
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    platform: artifact.platform,
    path: artifact.path,
    ...(artifact.paths?.length ? { paths: [...artifact.paths] } : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.hookGroups === undefined ? {} : { hookGroups: structuredClone(artifact.hookGroups) }),
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.target === undefined ? {} : { target: artifact.target }),
    ...(artifact.state === undefined ? {} : { state: artifact.state }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
      ? { ownershipMarker: artifact.artifactKey ?? artifact.path }
      : {}),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
  }));
}

function toDynamicDiagnosticEntry(
  artifact: GeneratedArtifact,
  scope: Scope,
): DynamicArtifactDiagnosticEntry | null {
  if (!artifact.id || !artifact.target) {
    return null;
  }
  const state = artifact.state ?? 'present';
  const mappedRefreshEvent: 'install' | 'upgrade' | 'config' | 'repair' | undefined =
    artifact.lastRefresh?.event === 'refresh'
      ? 'config'
      : artifact.lastRefresh?.event;
  const mappedLastRefresh = artifact.lastRefresh?.status === 'succeeded'
    ? {
        status: 'success' as const,
        at: artifact.lastRefresh.updatedAt,
        event: mappedRefreshEvent!,
        ...(artifact.lastRefresh.error ? { error: artifact.lastRefresh.error } : {}),
      }
    : artifact.lastRefresh?.status === 'failed'
      ? {
          status: 'failed' as const,
          at: artifact.lastRefresh.updatedAt,
          event: mappedRefreshEvent!,
          ...(artifact.lastRefresh.error ? { error: artifact.lastRefresh.error } : {}),
        }
      : undefined;
  return {
    id: artifact.id,
    target: artifact.target,
    state,
    ...(state === 'disabled' && artifact.disabledReason
      ? { disabledReason: artifact.disabledReason }
      : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.refreshKeys?.length ? { refreshKeys: [...artifact.refreshKeys] } : {}),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
    ...(mappedLastRefresh ? { lastRefresh: mappedLastRefresh } : {}),
    ...(artifact.refreshReach === undefined
      ? {}
      : {
          refreshReach: {
            commandScope: scope === 'project' ? 'projectShared' : 'user',
            ...(artifact.refreshReach.refreshedUserTarget === undefined
              ? {}
              : { refreshedUserTarget: artifact.refreshReach.refreshedUserTarget }),
            ...(artifact.refreshReach.refreshedCurrentProjectTarget === undefined
              ? {}
              : { refreshedCurrentProjectTarget: artifact.refreshReach.refreshedCurrentProjectTarget }),
          },
        }),
  };
}

function createDynamicDiagnosticCacheValue(options: {
  recordFile: InstallRecordFile;
  location: PluginLocation;
  artifacts: readonly GeneratedArtifact[];
}): DynamicArtifactDiagnosticCache {
  return {
    version: 1,
    recordId: options.recordFile.recordId,
    location: toInstallStateLocation(options.location),
    updatedAt: options.recordFile.record.updatedAt,
    artifacts: options.artifacts
      .map((artifact) => toDynamicDiagnosticEntry(artifact, options.location.scope))
      .filter((artifact): artifact is DynamicArtifactDiagnosticEntry => Boolean(artifact)),
  };
}

function toProjectArtifactIdentityArtifact(
  artifact: GeneratedArtifact,
  repoRoot: string,
): ProjectArtifactIdentityArtifact {
  const relativePath = path.relative(repoRoot, artifact.path).split(path.sep).join('/');
  return {
    kind: artifact.kind,
    platform: artifact.platform,
    path: relativePath,
    ...(artifact.paths?.length
      ? {
          paths: artifact.paths.map((entryPath) =>
            path.relative(repoRoot, entryPath).split(path.sep).join('/'),
          ),
        }
      : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.hookGroups === undefined ? {} : { hookGroups: structuredClone(artifact.hookGroups) }),
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.target === undefined ? {} : { target: artifact.target }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
      ? { ownershipMarker: artifact.artifactKey ?? relativePath }
      : {}),
    ...(artifact.state === undefined ? {} : { state: artifact.state }),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
  };
}

function collectRepoVisibleProjectArtifacts(
  repoRoot: string,
  artifacts: readonly GeneratedArtifact[],
): GeneratedArtifact[] {
  return artifacts.filter((artifact) => {
    if (!isPathInsideRoot(repoRoot, artifact.path)) {
      return false;
    }
    const classification = classifyProjectBoundaryPath({
      repoRoot,
      path: artifact.path,
    });
    return classification.category !== 'privateState' &&
      classification.category !== 'projectLocalConfig' &&
      classification.category !== 'ignoredState';
  });
}

function createNativeInstallTransactionMarker(
  pluginName: string,
  now: string,
  lastError?: string,
): NativeTransactionMarker {
  return {
    version: 1,
    pluginName,
    pluginId: `${pluginName}@aw`,
    platform: 'codex',
    scope: 'user',
    operation: 'install',
    nativeWriteSucceeded: true,
    createdAt: now,
    updatedAt: now,
    ...(lastError ? { lastError } : {}),
  };
}

function createSkillTriggerMaterializationTarget(
  platform: PlatformName,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv,
): {
  platform: 'codex';
  scope: 'user';
  kind: 'localMarketplaceRuntime';
  root: string;
} | {
  platform: 'codex';
  scope: 'project';
  kind: 'repoSkill';
  root: string;
} | {
  platform: 'claude';
  scope: Scope;
  kind: 'localMarketplaceRuntime';
  root: string;
} {
  if (platform === 'codex' && scope === 'project') {
    return {
      platform: 'codex',
      scope: 'project',
      kind: 'repoSkill',
      root: path.join(resolveProjectScopeRepoRoot(cwd), '.agents', 'skills'),
    };
  }
  if (platform === 'codex') {
    return {
      platform: 'codex',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: resolveAwHome(env),
    };
  }
  return {
    platform: 'claude',
    scope,
    kind: 'localMarketplaceRuntime',
    root: resolveAwHome(env),
  };
}

function hasCodexUserDynamicSkillTarget(
  target: ResolvedPluginTarget,
  platform: PlatformName,
  scope: Scope,
): boolean {
  if (platform !== 'codex' || scope !== 'user' || !target.currentPlugin) {
    return false;
  }

  return (target.currentPlugin.manifest.artifacts?.targets ?? []).some((artifact) =>
    artifact.platform === 'codex' &&
    artifact.scopes.includes('user') &&
    artifact.target === 'codex.skill',
  );
}

function projectStatusLooksAdoptable(
  status: PluginStatusReport | undefined,
): boolean {
  if (!status) {
    return false;
  }
  if (
    status.scopeManagedEvidence?.ledger ||
    status.scopeManagedEvidence?.tracking ||
    status.scopeManagedEvidence?.sharedNativeRef
  ) {
    return false;
  }
  const sessionState = status.repoManagedSessionState;
  if (!sessionState) {
    return false;
  }
  if (
    sessionState.instructions === 'visible' ||
    sessionState.rules === 'visible' ||
    sessionState.hooks === 'visible' ||
    sessionState.agents === 'visible'
  ) {
    return true;
  }
  return (sessionState.items ?? []).some((item) => item.state === 'visible');
}

function appendRollbackIssue(
  issues: string[],
  surfaces: Set<string>,
  summary: string,
  error: unknown,
  surfaceHints: readonly string[],
): void {
  issues.push(`${summary}：${normalizeErrorMessage(error)}`);
  for (const surface of surfaceHints) {
    surfaces.add(surface);
  }
}

function createRollbackFailureError(
  error: unknown,
  issues: string[],
  surfaces: Set<string>,
): Error {
  if (issues.length === 0) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const baseMessage = normalizeErrorMessage(error);
  const surfaceText = [...surfaces].join('、');
  return new Error(
    `${baseMessage}；回滚未完全完成，请人工检查 ${surfaceText}。${issues.join('；')}`,
  );
}

function collectArtifactRollbackSurfaceHints(
  platform: PlatformName,
  cwd: string,
  scope: CommandOptions['scope'],
  env: NodeJS.ProcessEnv,
  artifacts: GeneratedArtifact[],
): string[] {
  const hints = ['repo artifacts'];
  if (platform !== 'codex') {
    return hints;
  }

  const configTomlPath = resolveCodexPaths(cwd, scope, env).configTomlPath;
  if (artifacts.some((artifact) => path.normalize(artifact.path) === path.normalize(configTomlPath))) {
    hints.push(configTomlPath);
  }

  return hints;
}

function createArtifactIdentityRefusal(
  artifacts: GeneratedArtifact[],
  kind: 'previousArtifacts' | 'desiredArtifacts',
): string | null {
  const invalidArtifacts = artifacts.filter((artifact) =>
    (artifact.kind === 'skill' || artifact.kind === 'mcpServer') &&
    !artifact.artifactKey,
  );
  if (invalidArtifacts.length === 0) {
    return null;
  }

  const details = invalidArtifacts
    .map((artifact) => `${artifact.kind} ${artifact.path}`)
    .join('；');
  return `${kind} 中存在缺少 artifactKey 的受管产物（${details}），CLI 不能安全执行 stale prune；请先修复 tracking / artifact identity 后重试。`;
}

function diffGeneratedArtifacts(
  previousArtifacts: GeneratedArtifact[],
  desiredArtifacts: GeneratedArtifact[],
): GeneratedArtifact[] {
  return previousArtifacts.filter((artifact) =>
    !desiredArtifacts.some((desiredArtifact) =>
      hasSameGeneratedArtifactDesiredIdentity(artifact, desiredArtifact)));
}

async function restoreUpgradeRollbackBaseline(
  baseline: UpgradeRollbackBaseline,
  platform: PlatformName,
  target: ResolvedPluginTarget,
  options: InstallCommandOptions,
  context: ReturnType<typeof createCommandExecutionContext>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (baseline.artifactRollbackState) {
    await restoreTrackedArtifactRollbackState(
      platform,
      target,
      options.scope,
      options.cwd,
      env,
      baseline.artifactRollbackState,
    );
  }

  await writeTrackingManifest(baseline.trackingDir, baseline.trackingManifest);
  await writeInstalledLedger(baseline.ledger, env);

  const projectKey = options.scope === 'project'
    ? platform === 'claude'
      ? await resolveClaudeProjectKey(options.cwd)
      : await resolveCodexProjectKey(options.cwd)
    : null;
  const scopeRecord = getInstalledScopeRecordForLocation(baseline.ledger, {
    plugin: target.pluginName,
    platform,
    scope: options.scope,
    projectKey,
  });
  if (scopeRecord?.lifecycleConfigSnapshot) {
    await runLifecycleScript({
      event: 'install',
      pluginName: target.pluginName,
      platform,
      scope: options.scope,
      cwd: options.cwd,
      context,
      currentPlugin: target.currentPlugin,
      scopeRecord,
      artifacts: (getTrackingRecord(baseline.trackingManifest, target.pluginName)?.artifacts ?? [])
        .filter((artifact) => artifact.platform === platform),
      scriptTimeoutMs: options.scriptTimeoutMs,
    });
  }
}

function resolveInstallRollbackLedgerReason(
  platform: PlatformName,
  scope: InstallCommandOptions['scope'],
  plannedNativeWrite: boolean,
  nativeWritten: boolean,
  recoveryBreadcrumbPersisted: boolean,
  ledgerWritten: boolean,
  materializationRollbackFailed: boolean,
  artifactsWritten: boolean,
  trackingWriteAttempted: boolean,
  artifactsRollbackFailed: boolean,
  trackingRestoreFailed: boolean,
): LedgerStateReason | null {
  const recoveredCodexUserNative =
    platform === 'codex' &&
    scope === 'user' &&
    nativeWritten &&
    recoveryBreadcrumbPersisted;

  if (
    plannedNativeWrite &&
    !recoveryBreadcrumbPersisted &&
    (nativeWritten || materializationRollbackFailed || artifactsWritten || trackingWriteAttempted)
  ) {
    return 'operation_interrupted_after_native_write';
  }

  if (recoveredCodexUserNative) {
    return materializationRollbackFailed || artifactsRollbackFailed || trackingRestoreFailed
      ? 'operation_interrupted_after_artifact_write'
      : null;
  }

  if (
    ledgerWritten ||
    materializationRollbackFailed ||
    artifactsWritten ||
    trackingWriteAttempted ||
    artifactsRollbackFailed ||
    trackingRestoreFailed
  ) {
    return 'operation_interrupted_after_artifact_write';
  }

  return null;
}

function preserveLedgerState(
  baseline: InstalledLedger,
  nextLedger: InstalledLedger,
  options: {
    platform: PlatformName;
    scope: InstallCommandOptions['scope'];
    target: ResolvedPluginTarget;
  },
): InstalledLedger {
  if (baseline.ledgerState.status === 'available') {
    return nextLedger;
  }

  if (
    baseline.ledgerState.reason === 'operation_interrupted_after_native_write' &&
    options.platform === 'codex' &&
    options.scope === 'user' &&
    mayWriteNativeState(options.platform, options.target, options.scope)
  ) {
    return nextLedger;
  }

  return {
    ...nextLedger,
    ledgerState: {
      ...baseline.ledgerState,
    },
  };
}

function createDegradedLedger(
  baseline: InstalledLedger,
  reason: LedgerStateReason,
): InstalledLedger {
  return {
    ...baseline,
    ledgerState: {
      status: 'degraded',
      degradedAt: new Date().toISOString(),
      reason,
    },
  };
}

async function writeDegradedLedger(
  baseline: InstalledLedger,
  reason: LedgerStateReason,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await writeInstalledLedger(createDegradedLedger(baseline, reason), env);
}

async function applyInstallLedger(
  platform: PlatformName,
  ledger: InstalledLedger,
  target: ResolvedPluginTarget,
  options: InstallCommandOptions,
  resolvedInstallOptions: ResolvedInstallOptions,
): Promise<InstalledLedger> {
  if (!target.currentPlugin) {
    throw new Error(`Unknown plugin "${target.pluginName}".`);
  }

  const overridableInstallOptions = resolvedInstallOptions.applicability === 'overridable'
    ? resolvedInstallOptions
    : undefined;

  return platform === 'claude'
    ? applyClaudeInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd, overridableInstallOptions)
    : applyCodexInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd, overridableInstallOptions);
}

async function setLifecycleConfigSnapshotOnLedger(
  ledger: InstalledLedger,
  platform: PlatformName,
  target: ResolvedPluginTarget,
  options: InstallCommandOptions,
  snapshot: LifecycleConfigSnapshotMetadata,
): Promise<InstalledLedger> {
  const platformRecord = ledger.plugins[target.pluginName]?.platforms[platform];
  if (!platformRecord) {
    throw new Error(`缺少 ${platform}/${target.pluginName} 的 ledger platform record，无法写入 lifecycle config snapshot。`);
  }

  let scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined;
  if (options.scope === 'user') {
    scopeRecord = platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  } else {
    const projectKey = platform === 'claude'
      ? await resolveClaudeProjectKey(options.cwd)
      : await resolveCodexProjectKey(options.cwd);
    scopeRecord = platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  if (!scopeRecord) {
    throw new Error(`缺少 ${platform}/${target.pluginName} (${options.scope}) 的 ledger scope record，无法写入 lifecycle config snapshot。`);
  }

  scopeRecord.lifecycleConfigSnapshot = snapshot;
  return ledger;
}

function createPendingScopeRecord(
  target: ResolvedPluginTarget,
  snapshot: LifecycleConfigSnapshotMetadata,
): InstalledScopeRecord<Record<string, unknown>> {
  return {
    managed: true,
    updatedAt: new Date().toISOString(),
    resolvedVersion: target.currentPlugin?.manifest.version ?? snapshot.pluginVersion,
    capabilitySnapshot: {},
    lifecycleConfigSnapshot: snapshot,
  };
}

function mayWriteNativeState(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: InstallCommandOptions['scope'],
): boolean {
  if (platform === 'claude') {
    return true;
  }

  return target.currentPlugin
    ? requiresCodexNativePlugin(target.currentPlugin, scope)
    : false;
}

function isCodexUserNativeInstall(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: InstallCommandOptions['scope'],
): boolean {
  return platform === 'codex' && scope === 'user' && mayWriteNativeState(platform, target, scope);
}

function createRecoveryBreadcrumbFailureReason(stage: {
  snapshotPersisted: boolean;
  lifecycleStarted: boolean;
  trackingWriteAttempted: boolean;
  ledgerWriteAttempted: boolean;
}): {
  state:
    | 'pending_after_native_write'
    | 'snapshot_write_failed'
    | 'lifecycle_failed'
    | 'tracking_write_failed'
    | 'ledger_write_failed';
  reason: string;
} {
  if (stage.ledgerWriteAttempted) {
    return {
      state: 'ledger_write_failed',
      reason: 'install_ledger_write_failed',
    };
  }
  if (stage.trackingWriteAttempted) {
    return {
      state: 'tracking_write_failed',
      reason: 'install_tracking_write_failed',
    };
  }
  if (stage.lifecycleStarted) {
    return {
      state: 'lifecycle_failed',
      reason: 'install_lifecycle_failed',
    };
  }
  if (stage.snapshotPersisted) {
    return {
      state: 'pending_after_native_write',
      reason: 'native_write_succeeded_post_steps_pending',
    };
  }
  return {
    state: 'snapshot_write_failed',
    reason: 'install_snapshot_write_failed',
  };
}

async function emitCodexRecoveryEvent(
  context: ReturnType<typeof createCommandExecutionContext>,
  options: {
    plugin: string;
    scope: InstallCommandOptions['scope'];
    operation: 'write' | 'update' | 'delete';
    phase: 'start' | 'success' | 'error';
    state: NativeRecoveryState;
    nativeWriteSucceeded: boolean;
    recoveryBreadcrumbPersisted: boolean;
    errorCategory?: string;
    suggestion?: string;
  },
): Promise<void> {
  await emitCommandEvent(context, {
    type: 'native:recovery',
    source: {
      platform: 'codex',
      plugin: options.plugin,
      scope: options.scope,
    },
    data: {
      platform: 'codex',
      scope: options.scope,
      plugin: options.plugin,
      pluginId: `${options.plugin}@aw`,
      operation: options.operation,
      phase: options.phase,
      state: options.state,
      nativeWriteSucceeded: options.nativeWriteSucceeded,
      recoveryBreadcrumbPersisted: options.recoveryBreadcrumbPersisted,
      ...(options.errorCategory ? { errorCategory: options.errorCategory } : {}),
      ...(options.suggestion ? { suggestion: options.suggestion } : {}),
    },
  });
}

async function updateCodexRecoveryBreadcrumbWithEvent(
  context: ReturnType<typeof createCommandExecutionContext>,
  options: {
    pluginName: string;
    scope: InstallCommandOptions['scope'];
    state: NativeRecoveryState;
    reason: string;
    pluginVersion?: string | null;
    bundleFingerprint?: string | null;
    activeCachePath?: string | null;
    lastError?: string | null;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  await emitCodexRecoveryEvent(context, {
    plugin: options.pluginName,
    scope: options.scope,
    operation: 'update',
    phase: 'start',
    state: options.state,
    nativeWriteSucceeded: true,
    recoveryBreadcrumbPersisted: true,
  });
  try {
    await updateCodexNativeRecoveryBreadcrumb({
      pluginName: options.pluginName,
      state: options.state,
      reason: options.reason,
      pluginVersion: options.pluginVersion ?? undefined,
      bundleFingerprint: options.bundleFingerprint ?? undefined,
      activeCachePath: options.activeCachePath ?? undefined,
      lastError: options.lastError ?? undefined,
      env: options.env,
    });
    await emitCodexRecoveryEvent(context, {
      plugin: options.pluginName,
      scope: options.scope,
      operation: 'update',
      phase: 'success',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: true,
    });
  } catch (error) {
    await emitCodexRecoveryEvent(context, {
      plugin: options.pluginName,
      scope: options.scope,
      operation: 'update',
      phase: 'error',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: true,
      errorCategory: 'breadcrumb_update_failed',
      suggestion: 'Codex native side effect 已发生，但 AW 更新 recovery breadcrumb 失败；请运行 `aw status --verbose` 查看当前诊断。',
    });
    throw error;
  }
}

async function deleteCodexRecoveryBreadcrumbWithEvent(
  context: ReturnType<typeof createCommandExecutionContext>,
  options: {
    pluginName: string;
    scope: InstallCommandOptions['scope'];
    state: NativeRecoveryState;
    env: NodeJS.ProcessEnv;
  },
): Promise<void> {
  await emitCodexRecoveryEvent(context, {
    plugin: options.pluginName,
    scope: options.scope,
    operation: 'delete',
    phase: 'start',
    state: options.state,
    nativeWriteSucceeded: true,
    recoveryBreadcrumbPersisted: true,
  });
  try {
    await deleteCodexNativeRecoveryBreadcrumb(options.pluginName, options.env);
    await emitCodexRecoveryEvent(context, {
      plugin: options.pluginName,
      scope: options.scope,
      operation: 'delete',
      phase: 'success',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: false,
    });
  } catch (error) {
    await emitCodexRecoveryEvent(context, {
      plugin: options.pluginName,
      scope: options.scope,
      operation: 'delete',
      phase: 'error',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: true,
      errorCategory: 'breadcrumb_delete_failed',
      suggestion: '插件已安装成功，但 AW 还没有删掉 recovery breadcrumb；请运行 `aw status --verbose` 确认清理情况。',
    });
    throw error;
  }
}

function wrapCodexNativeInstallFailure(
  pluginName: string,
  error: Error,
  recoveryBreadcrumbPersisted: boolean,
): Error {
  const detail = error.message;
  if (!recoveryBreadcrumbPersisted) {
    return new Error(
      `Codex 原生插件 ${pluginName}@aw 已写入，但 AW 没有持久化 native transaction marker：${detail}。当前不能承诺后续 repair / uninstall 一定具备自动授权；请运行 \`aw status --verbose\` 查看 marker、config 和 cache 诊断。`,
    );
  }

  return new Error(
    `Codex 原生插件 ${pluginName}@aw 已写入，但 AW 安装未完成：${detail}。请运行 \`aw status --verbose\` 查看 marker、config 和 cache 诊断，必要时再运行 \`aw uninstall ${pluginName} -p codex -s user\` 清理残留。`,
  );
}

function recordNativePlugin(
  nativePlugins: NativePluginsByPlatform,
  platform: PlatformName,
  pluginName: string,
): void {
  nativePlugins[platform] ??= [];
  if (!nativePlugins[platform].includes(pluginName)) {
    nativePlugins[platform].push(pluginName);
  }
}

function shouldMaterializeSkillTriggers(
  platform: PlatformName,
  _scope: InstallCommandOptions['scope'],
  resolvedInstallOptions: ResolvedInstallOptions,
): boolean {
  return resolvedInstallOptions.applicability !== 'none';
}

function resolveMaterializationMode(
  resolvedInstallOptions: ResolvedInstallOptions,
): 'strictExplicit' | 'bestEffortReplay' {
  return resolvedInstallOptions.applicability === 'overridable' &&
    resolvedInstallOptions.skillTriggerSource === 'cli' &&
    resolvedInstallOptions.skillTriggerPreference !== 'default'
    ? 'strictExplicit'
    : 'bestEffortReplay';
}

function shouldCollectSharedRuntimeConflictWarnings(
  platform: PlatformName,
  scope: InstallCommandOptions['scope'],
  resolvedInstallOptions: ResolvedInstallOptions,
): boolean {
  return platform !== 'codex' || scope !== 'project'
    ? resolvedInstallOptions.applicability === 'overridable'
    : false;
}

function resolveMaterializationPreference(
  resolvedInstallOptions: ResolvedInstallOptions,
): 'default' | 'manual' | 'auto' {
  return resolvedInstallOptions.applicability === 'overridable'
    ? resolvedInstallOptions.skillTriggerPreference
    : 'default';
}

async function resolveScopeIdentityForTarget(
  platform: PlatformName,
  options: CommandOptions,
): Promise<string> {
  if (options.scope === 'user') {
    return 'user';
  }

  const projectKey = platform === 'claude'
    ? await resolveClaudeProjectKey(options.cwd)
    : await resolveCodexProjectKey(options.cwd);
  return `project:${projectKey}`;
}

async function preflightInstallConfigs(
  targets: ResolvedPluginTarget[],
  options: InstallCommandOptions,
  runtime: InstallCommandRuntime,
): Promise<void> {
  const context = createCommandExecutionContext(runtime);
  await preflightRequiredPluginConfigs({
    targets: targets
      .filter((target) => target.currentPlugin)
      .map((target) => ({
        pluginName: target.pluginName,
        manifest: target.currentPlugin!.manifest,
        schemaSourceIdentity: createPluginConfigSchemaIdentity(target.currentPlugin!.manifest),
      })),
    cwd: options.cwd,
    defaultScope: options.scope,
    context,
    interactive: true,
  });
}

async function rollbackArtifacts(
  adapter: PlatformAdapter,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
  generatedArtifacts: GeneratedArtifact[],
): Promise<void> {
  if (!target.currentPlugin) {
    return;
  }

  await adapter.uninstallExtensions(target.currentPlugin, scope, generatedArtifacts);
}

async function installTargetOnPlatform(
  target: ResolvedPluginTarget,
  platform: PlatformName,
  options: InstallCommandOptions,
  runtime: InstallCommandRuntime,
  context: ReturnType<typeof createCommandExecutionContext>,
  adapters: Record<PlatformName, PlatformAdapter>,
): Promise<InstallLocationNodeResult> {
  if (!target.currentPlugin) {
    throw new Error(`Unknown plugin "${target.pluginName}".`);
  }
  const currentPlugin = target.currentPlugin;

  const env = context.env;
  const operation = runtime.operation ?? 'install';
  const warnings: string[] = [];
  const nativePlugins: NativePluginsByPlatform = {};
  let repoManagedArtifacts: GeneratedArtifact[] = [];

  const status = await adapters[platform].status(target.currentPlugin, options.scope);
  const pluginStatus = status.plugins[0];
  if (
    pluginStatus?.externalOwnership?.present &&
    !(platform === 'codex' && options.scope === 'project')
  ) {
    throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
  }

  if (options.scope === 'project') {
    const projectKey = platform === 'claude'
      ? await resolveClaudeProjectKey(options.cwd)
      : await resolveCodexProjectKey(options.cwd);
    const location = normalizePluginLocation({
      plugin: target.currentPlugin.manifest.name,
      platform,
      scope: options.scope,
      projectKey,
    });
    const privateStateRoot = getInstallStatePrivateRoot(
      options.cwd,
      toInstallStateLocation(location),
      env,
    );
    const ignoreResult = await ensureProjectPrivateStateIgnore({
      cwd: options.cwd,
      targetPath: privateStateRoot,
    });
    if (ignoreResult.warning) {
      warnings.push(ignoreResult.warning.message);
    }

    await assertProjectArtifactIdentityPathVisible({
      cwd: options.cwd,
      pluginName: location.plugin,
      platform: location.platform,
      projectKey: location.projectKey,
    });

    const existingRecord = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: toInstallStateLocation(location),
      env,
    });
    if (existingRecord.status !== 'ok' && projectStatusLooksAdoptable(pluginStatus)) {
      throw new Error(
        `${location.plugin} 在 ${location.platform} (${location.scope}) 检测到可认领的 project artifacts；install 不会自动接管。请先运行 \`aw repair ${location.plugin} --platform ${location.platform} --scope ${location.scope} --adopt-existing\`。`,
      );
    }

    const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
    const projectRoot = resolveProjectArtifactProjectRoot(options.cwd, location);
    const locator = createProjectArtifactSharedLocator({
      plugin: location.plugin,
      platform: location.platform,
      repoRoot,
      projectRoot,
    });
    const sharedIdentity = await readProjectArtifactIdentityForLocator({
      repoRoot,
      locator,
      cwd: options.cwd,
    });
    if (existingRecord.status !== 'ok' && sharedIdentity.status === 'ok') {
      throw new Error(
        `${location.plugin} 在 ${location.platform} (${location.scope}) 已存在可认领的 project artifact shared identity；install 不会自动接管。请先运行 \`aw repair ${location.plugin} --platform ${location.platform} --scope ${location.scope} --adopt-existing\`。`,
      );
    }
  }

  const baselineLedger = await readInstalledLedger(env);
  const resolvedInstallOptions = runtime.resolveInstallOptions?.(platform, target) ?? (
    await resolveInstallOptionsForTargets(
      'install',
      [target],
      [platform],
      {
        cwd: options.cwd,
        scope: options.scope,
        requestedSkillTrigger: options.requestedSkillTrigger,
        env,
      },
      baselineLedger,
    )
  ).values().next().value as ResolvedInstallOptions;
  const trackingDir = resolveTrackingDir(options.cwd, platform, options.scope, env);
  const baselineTracking = await readTrackingManifest(trackingDir);
  const previousTrackedArtifacts =
    baselineTracking.plugins[target.currentPlugin.manifest.name]?.artifacts ?? [];
  const usesCodexUserDynamicSkillFlow = hasCodexUserDynamicSkillTarget(
    target,
    platform,
    options.scope,
  );
  const isCodexUpgradeWithStalePrune =
    operation === 'upgrade' &&
    platform === 'codex' &&
    (
      options.scope === 'project' ||
      usesCodexUserDynamicSkillFlow
    );
  const upgradeRollbackBaselineKey = createUpgradeRollbackBaselineKey(
    platform,
    target.pluginName,
  );
  const upgradeRollbackBaseline = operation === 'upgrade' && platform === 'codex' && options.scope === 'project'
    ? runtime.upgradeRollbackBaselines?.get(upgradeRollbackBaselineKey) ?? {
        artifactRollbackState: pluginStatus && (
          pluginStatus.scopeManagedEvidence?.ledger ||
          pluginStatus.scopeManagedEvidence?.tracking ||
          pluginStatus.scopeManagedEvidence?.sharedNativeRef
        )
          ? await captureArtifactRollbackState(
              platform,
              target,
              options.scope,
              options.cwd,
              env,
            )
          : undefined,
        trackingDir,
        trackingManifest: baselineTracking,
        ledger: baselineLedger,
        degradedReasonOnRestoreFailure: 'operation_interrupted_after_artifact_write',
      }
    : undefined;
  const materializeSkillTriggers = shouldMaterializeSkillTriggers(
    platform,
    options.scope,
    resolvedInstallOptions,
  );
  const materializationPreference = options.requestedSkillTrigger
    ?? resolveMaterializationPreference(resolvedInstallOptions);
  let nativeWritten = false;
  let artifactsWritten = false;
  let trackingWritten = false;
  let trackingWriteAttempted = false;
  let ledgerWritten = false;
  let plannedNativeWrite = false;
  let materializationCommitted = false;
  let materializationRollbackFailed = false;
  let materializationRollbackHandle: SkillTriggerMaterializationRollbackHandle | undefined;
  let runtimeSignatureBefore: SkillTriggerSignatureResult | undefined;
  let plannedRuntimeSignatureAfter: SkillTriggerSignatureResult | undefined;
  let writtenScopeIdentity: string | undefined;
  let generatedArtifacts: GeneratedArtifact[] = [];
  let materializedArtifacts: GeneratedArtifact[] = [];
  let trackedArtifacts: GeneratedArtifact[] = [];
  let preparedLifecycleConfigSnapshot: PreparedLifecycleConfigSnapshot | undefined;
  let lifecycleConfigSnapshot: LifecycleConfigSnapshotMetadata | undefined;
  let recoveryBreadcrumbPersisted = false;
  let artifactsRollbackFailed = false;
  let trackingRestoreFailed = false;
  let dynamicSkillArtifactRollbackState: ArtifactRollbackState | undefined;
  let nativeRollbackBaseline: CodexNativePluginRollbackBaseline | undefined;
  const recoveryFailureStage = {
    snapshotPersisted: false,
    lifecycleStarted: false,
    trackingWriteAttempted: false,
    ledgerWriteAttempted: false,
  };
  const pruneCodexUpgradeStaleArtifacts = async (): Promise<void> => {
    const previousIdentityRefusal = createArtifactIdentityRefusal(
      previousTrackedArtifacts,
      'previousArtifacts',
    );
    if (previousIdentityRefusal) {
      throw new Error(previousIdentityRefusal);
    }

    const desiredIdentityRefusal = createArtifactIdentityRefusal(
      trackedArtifacts,
      'desiredArtifacts',
    );
    if (desiredIdentityRefusal) {
      throw new Error(desiredIdentityRefusal);
    }

    const staleArtifacts = diffGeneratedArtifacts(previousTrackedArtifacts, trackedArtifacts);
    if (staleArtifacts.length === 0) {
      return;
    }

    await pruneCodexTrackedArtifacts({
      cwd: options.cwd,
      scope: options.scope,
      env,
      pluginName: currentPlugin.manifest.name,
      artifacts: staleArtifacts,
      preservedArtifacts: trackedArtifacts,
    });
    await emitCommandEvent(context, {
      type: 'artifacts:pruned',
      data: {
        platform,
        plugin: currentPlugin.manifest.name,
        scope: options.scope,
        staleArtifacts: staleArtifacts.map((artifact) => ({
          kind: artifact.kind,
          path: artifact.path,
          ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
        })),
      },
    });
  };

  try {
    preparedLifecycleConfigSnapshot = await prepareLifecycleConfigSnapshot({
      plugin: target.currentPlugin,
      platform,
      scope: options.scope,
      cwd: options.cwd,
      env,
    });

    if (
      usesCodexUserDynamicSkillFlow &&
      (
        pluginStatus?.scopeManagedEvidence?.ledger ||
        pluginStatus?.scopeManagedEvidence?.tracking ||
        pluginStatus?.scopeManagedEvidence?.sharedNativeRef
      )
    ) {
      dynamicSkillArtifactRollbackState = await captureArtifactRollbackState(
        platform,
        target,
        options.scope,
        options.cwd,
        env,
      );
    }
    if (usesCodexUserDynamicSkillFlow) {
      nativeRollbackBaseline = await captureCodexNativePluginRollbackBaseline(
        target.currentPlugin.manifest.name,
        env,
      );
    }

    if (materializeSkillTriggers) {
      const [embeddedRoot, writtenScope] = await Promise.all([
        resolveEmbeddedPluginsRoot(),
        resolveScopeIdentityForTarget(platform, options),
      ]);
      const marketplaceRoot = resolveAwHome(env);
      const materializationTarget = platform === 'codex' && options.scope === 'project'
        ? {
            platform: 'codex' as const,
            scope: 'project' as const,
            kind: 'repoSkill' as const,
            root: path.join(await resolveRepoRoot(options.cwd), '.agents', 'skills'),
          }
        : undefined;
      writtenScopeIdentity = writtenScope;

      if (
        baselineLedger.ledgerState.status === 'available' &&
        resolvedInstallOptions.ledgerTrust === 'available' &&
        shouldCollectSharedRuntimeConflictWarnings(platform, options.scope, resolvedInstallOptions)
      ) {
        runtimeSignatureBefore = await readCurrentSkillTriggerRuntimeSignature({
          pluginName: target.pluginName,
          platform,
          marketplaceRoot,
          embeddedRoot,
        });
      }

      const materialization = await materializeSkillTriggerPreference({
        pluginName: target.pluginName,
        platform,
        resolvedOptions: {
          skillTriggerPreference: materializationPreference,
        },
        embeddedRoot,
        ...(materializationTarget
          ? { target: materializationTarget }
          : { marketplaceRootOrStagingRoot: marketplaceRoot }),
        mode: resolveMaterializationMode(resolvedInstallOptions),
      });
      materializationCommitted = materialization.committed;
      materializationRollbackHandle = materialization.rollbackHandle;
      materializedArtifacts = materialization.generatedArtifacts;
      warnings.push(...materialization.warnings);

      if (
        baselineLedger.ledgerState.status === 'available' &&
        resolvedInstallOptions.ledgerTrust === 'available' &&
        shouldCollectSharedRuntimeConflictWarnings(platform, options.scope, resolvedInstallOptions)
      ) {
        plannedRuntimeSignatureAfter = await buildSkillTriggerMaterializationSignature({
          pluginName: target.pluginName,
          platform,
          preference: materializationPreference,
          embeddedRoot,
        });
      }
    }

    plannedNativeWrite = mayWriteNativeState(platform, target, options.scope);
    await emitCommandEvent(context, {
      type: plannedNativeWrite ? 'native:plan' : 'native:skipped',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        ...(plannedNativeWrite
          ? {
              reason: 'plugin_requires_native_registration',
            }
          : {
              reason:
                platform === 'codex' && options.scope === 'project'
                  ? 'project_repo_managed_skipped_native'
                  : 'native_runtime_not_required',
              requiresNativeRuntime:
                platform === 'codex'
                  ? requiresCodexNativePlugin(target.currentPlugin, 'user')
                  : true,
              repoManagedArtifactKinds:
                platform === 'codex'
                  ? getCodexProjectManagedKinds(target.currentPlugin)
                  : [],
            }),
      },
    });

    if (plannedNativeWrite && !usesCodexUserDynamicSkillFlow) {
      await adapters[platform].installPlugin(target.currentPlugin, options.scope);
    }
    nativeWritten = plannedNativeWrite && !usesCodexUserDynamicSkillFlow;
    if (nativeWritten) {
      recordNativePlugin(nativePlugins, platform, target.currentPlugin.manifest.name);
      if (isCodexUserNativeInstall(platform, target, options.scope)) {
        const marker = createNativeInstallTransactionMarker(
          target.currentPlugin.manifest.name,
          new Date().toISOString(),
        );
        await writeNativeTransactionMarker(marker, env);
        recoveryBreadcrumbPersisted = true;
      }
      await emitCommandEvent(context, {
        type: 'native:applied',
        data: {
          platform,
          plugin: target.currentPlugin.manifest.name,
          scope: options.scope,
        },
      });
    }

    if (preparedLifecycleConfigSnapshot) {
      lifecycleConfigSnapshot = await persistLifecycleConfigSnapshot(
        preparedLifecycleConfigSnapshot,
      );
      recoveryFailureStage.snapshotPersisted = true;
    }
    if (!lifecycleConfigSnapshot) {
      throw new Error(`缺少 ${platform}/${target.currentPlugin.manifest.name} 的 lifecycle config snapshot。`);
    }

    await emitCommandEvent(context, {
      type: 'artifacts:plan',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        trackingDir,
      },
    });
    generatedArtifacts = await adapters[platform].installExtensions(target.currentPlugin, options.scope, {
      event: operation,
      skillTriggerPreference: options.requestedSkillTrigger ?? resolveMaterializationPreference(resolvedInstallOptions),
    });
    trackedArtifacts = mergeGeneratedArtifacts(materializedArtifacts, generatedArtifacts);
    repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, trackedArtifacts);
    artifactsWritten = trackedArtifacts.length > 0;
    await emitCommandEvent(context, {
      type: artifactsWritten ? 'artifacts:written' : 'artifacts:noop',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        artifacts: trackedArtifacts.map((artifact) => ({
          kind: artifact.kind,
          path: artifact.path,
        })),
      },
    });

    if (isCodexUpgradeWithStalePrune && usesCodexUserDynamicSkillFlow) {
      await pruneCodexUpgradeStaleArtifacts();
    }

    if (plannedNativeWrite && usesCodexUserDynamicSkillFlow) {
      await adapters[platform].installPlugin(target.currentPlugin, options.scope);
      nativeWritten = true;
      recordNativePlugin(nativePlugins, platform, target.currentPlugin.manifest.name);
      if (isCodexUserNativeInstall(platform, target, options.scope)) {
        const marker = createNativeInstallTransactionMarker(
          target.currentPlugin.manifest.name,
          new Date().toISOString(),
        );
        await writeNativeTransactionMarker(marker, env);
        recoveryBreadcrumbPersisted = true;
      }
      await emitCommandEvent(context, {
        type: 'native:applied',
        data: {
          platform,
          plugin: target.currentPlugin.manifest.name,
          scope: options.scope,
        },
      });
    }

    recoveryFailureStage.lifecycleStarted = true;
    await runLifecycleScript({
      event: operation,
      pluginName: target.currentPlugin.manifest.name,
      platform,
      scope: options.scope,
      cwd: options.cwd,
      context,
      currentPlugin: target.currentPlugin,
      scopeRecord: createPendingScopeRecord(target, lifecycleConfigSnapshot),
      artifacts: trackedArtifacts,
      scriptTimeoutMs: options.scriptTimeoutMs,
    });

    if (isCodexUpgradeWithStalePrune && !usesCodexUserDynamicSkillFlow) {
      await pruneCodexUpgradeStaleArtifacts();
    }

    trackingWriteAttempted = true;
    recoveryFailureStage.trackingWriteAttempted = true;
    await writeTrackingManifest(
      trackingDir,
      trackedArtifacts.length > 0
        ? upsertTrackingRecordInManifest(
            baselineTracking,
            target.currentPlugin.manifest.name,
            trackedArtifacts,
          )
        : removeTrackingRecordFromManifest(
            baselineTracking,
            target.currentPlugin.manifest.name,
          ),
    );
    trackingWritten = true;
    await emitCommandEvent(context, {
      type: 'tracking:written',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        trackingDir,
        artifactCount: trackedArtifacts.length,
      },
    });

    recoveryFailureStage.ledgerWriteAttempted = true;
    const nextLedger = preserveLedgerState(
      baselineLedger,
      await applyInstallLedger(
        platform,
        baselineLedger,
        target,
        options,
        resolvedInstallOptions,
      ),
      {
        platform,
        scope: options.scope,
        target,
      },
    );
    await setLifecycleConfigSnapshotOnLedger(
      nextLedger,
      platform,
      target,
      options,
      lifecycleConfigSnapshot,
    );
    const pendingConflictWarnings: string[] = [];
    if (
      materializeSkillTriggers &&
      baselineLedger.ledgerState.status === 'available' &&
      nextLedger.ledgerState.status === 'available' &&
      resolvedInstallOptions.ledgerTrust === 'available' &&
      shouldCollectSharedRuntimeConflictWarnings(platform, options.scope, resolvedInstallOptions) &&
      runtimeSignatureBefore &&
      plannedRuntimeSignatureAfter &&
      writtenScopeIdentity
    ) {
      const embeddedRoot = await resolveEmbeddedPluginsRoot();
      const conflictResult = await collectSkillTriggerSiblingConflictWarnings({
        ledgerBefore: baselineLedger,
        ledgerAfter: nextLedger,
        pluginName: target.pluginName,
        platform,
        writtenScopeIdentity,
        runtimeSignatureBefore,
        plannedRuntimeSignatureAfter,
        embeddedRoot,
      });
      pendingConflictWarnings.push(
        ...conflictResult.warnings,
        ...conflictResult.diagnostics.filter(Boolean),
      );
    }

    const projectKey = options.scope === 'project'
      ? platform === 'claude'
        ? await resolveClaudeProjectKey(options.cwd)
        : await resolveCodexProjectKey(options.cwd)
      : null;
    const location = normalizePluginLocation({
      plugin: target.currentPlugin.manifest.name,
      platform,
      scope: options.scope,
      projectKey,
    });
    const existingRecord = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: toInstallStateLocation(location),
      env,
    });
    const now = new Date().toISOString();
    const runtimeStage = await stageHistoricalLifecycleRuntime({
      cwd: options.cwd,
      location: toInstallStateLocation(location),
      sourceBundleRoot: lifecycleConfigSnapshot.bundleRoot,
      pluginVersion: lifecycleConfigSnapshot.pluginVersion,
      manifestDigest: lifecycleConfigSnapshot.sourceManifestDigest,
      bundleFingerprint: lifecycleConfigSnapshot.bundleFingerprint,
      events: ['install', 'upgrade', 'uninstall'],
      createdAt: now,
      manifestRelativePath: SOURCE_MANIFEST_PATH,
      env,
    });
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId: '',
      record: {
        pluginName: target.currentPlugin.manifest.name,
        platform,
        scope: options.scope,
        ...(options.scope === 'project' ? { projectKey: projectKey ?? undefined } : {}),
        installedAt: existingRecord.status === 'ok'
          ? existingRecord.value.record.installedAt
          : now,
        updatedAt: now,
        source: {
          pluginVersion: lifecycleConfigSnapshot.pluginVersion,
          manifestDigest: lifecycleConfigSnapshot.sourceManifestDigest,
          bundleFingerprint: lifecycleConfigSnapshot.bundleFingerprint,
        },
        installSource: toInstallRecordInstallSource('explicit'),
        ...(toInstalledScopeInstallOptions(resolvedInstallOptions)
          ? { options: toInstalledScopeInstallOptions(resolvedInstallOptions) }
          : {}),
        ...(plannedNativeWrite
          ? {
              native: {
                pluginId: `${target.currentPlugin.manifest.name}@aw`,
                installedByAw: true,
              },
            }
          : {}),
        lifecycle: runtimeStage.runtimeRef,
        artifacts: toInstallRecordArtifacts(trackedArtifacts),
        dependencyEdges: [],
      },
    };
    const recordPath = getInstallRecordPath(
      options.cwd,
      toInstallStateLocation(location),
      env,
    );
    recordFile.recordId = path.basename(recordPath, '.json');
    const dynamicCache = createDynamicDiagnosticCacheValue({
      recordFile,
      location,
      artifacts: trackedArtifacts,
    });
    const transactionStages: InstallStateTransactionStage[] = [
      runtimeStage,
      await createInstallRecordWriteStage({
        filePath: recordPath,
        value: recordFile,
        env,
      }),
      await createDynamicArtifactDiagnosticCacheWriteStage({
        cwd: options.cwd,
        location: toInstallStateLocation(location),
        value: dynamicCache,
        currentRecord: recordFile,
        env,
      }),
    ];
    if (options.scope === 'project') {
      const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
      const projectRoot = resolveProjectArtifactProjectRoot(options.cwd, location);
      const repoVisibleArtifacts = collectRepoVisibleProjectArtifacts(repoRoot, trackedArtifacts);
      if (repoVisibleArtifacts.length > 0) {
        const locator = createProjectArtifactSharedLocator({
          plugin: target.currentPlugin.manifest.name,
          platform,
          repoRoot,
          projectRoot,
        });
        const identityValue: ProjectArtifactIdentityFile = {
          version: 1,
          sharedIdentityId: path.basename(
            getInstallRecordPath(options.cwd, toInstallStateLocation(location), env),
            '.json',
          ),
          locator,
          source: {
            pluginVersion: lifecycleConfigSnapshot.pluginVersion,
            manifestDigest: lifecycleConfigSnapshot.sourceManifestDigest,
            bundleFingerprint: lifecycleConfigSnapshot.bundleFingerprint,
          },
          generatedAt: now,
          artifacts: repoVisibleArtifacts.map((artifact) =>
            toProjectArtifactIdentityArtifact(artifact, repoRoot),
          ),
        };
        identityValue.sharedIdentityId = path.basename(
          getProjectArtifactSharedIdentityPath({ repoRoot, locator }),
          '.json',
        );
        transactionStages.unshift(await createProjectArtifactIdentityWriteStage({
          repoRoot,
          locator,
          value: identityValue,
        }));
      }
    }
    if (materializeSkillTriggers) {
      const sharedOwnerPreflight = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
        location: toInstallStateLocation(location),
        embeddedRoot: await resolveEmbeddedPluginsRoot(),
        target: createSkillTriggerMaterializationTarget(platform, options.scope, options.cwd, env),
        preference: materializationPreference,
        command: operation === 'upgrade' ? 'upgrade' : 'install',
        takeoverSharedRuntime: options.takeoverSharedRuntime,
        targetCount: 1,
        env,
      });
      if (sharedOwnerPreflight.status === 'ok' && sharedOwnerPreflight.shouldWriteOwner) {
        transactionStages.push(await createSharedRuntimeOwnerWriteStage({
          recordFile,
          recordPath,
          env,
        }));
      }
    }
    const transactionResult = await runInstallStateTransaction({
      stages: transactionStages,
      postCommit: [
        createDependencyIndexRefreshPostCommitAction({
          mode: 'upsert',
          recordFile,
          recordPath,
          env,
        }),
        ...(nativeWritten && recoveryBreadcrumbPersisted && isCodexUserNativeInstall(platform, target, options.scope)
          ? [
              createNativeTransactionMarkerDeletePostCommitAction({
                pluginNameOrId: target.currentPlugin.manifest.name,
                env,
              }),
            ]
          : []),
      ],
    });
    warnings.push(...pendingConflictWarnings);
    for (const warning of transactionResult.warnings) {
      if (warning.code === 'nativeMarkerDeleteFailed') {
        throw new PostInstallCleanupError(
          `插件 ${target.currentPlugin.manifest.name} 已安装成功，但 native transaction marker 清理失败：${warning.error ?? warning.message}。请运行 \`aw repair ${target.currentPlugin.manifest.name} --platform ${platform} --scope ${options.scope}\` 或手动清理后重试。`,
        );
      }
      warnings.push(
        `[${platform}/${target.currentPlugin.manifest.name}] ${warning.message}${warning.error ? ` ${warning.error}` : ''}`,
      );
    }
    if (baselineLedger.ledgerState.status !== 'available') {
      await writeInstalledLedger({
        ...baselineLedger,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
      }, env);
      ledgerWritten = true;
    }
    await emitCommandEvent(context, {
      type: 'ledger:written',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        ledgerState: 'available',
      },
    });
  } catch (error) {
    if (error instanceof PostInstallCleanupError && error.skipRollback) {
      throw error;
    }

    if (
      nativeWritten &&
      recoveryBreadcrumbPersisted &&
      isCodexUserNativeInstall(platform, target, options.scope)
    ) {
      await writeNativeTransactionMarker(
        createNativeInstallTransactionMarker(
          target.currentPlugin.manifest.name,
          new Date().toISOString(),
          normalizeErrorMessage(error),
        ),
        env,
      ).catch(() => undefined);
    }

    await emitCommandEvent(context, {
      type: 'rollback:started',
      message: error instanceof Error ? error.message : String(error),
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        scope: options.scope,
        nativeWritten,
        artifactsWritten,
        trackingWritten,
        materializationCommitted,
      },
    });
    generatedArtifacts = mergeGeneratedArtifacts(
      generatedArtifacts,
      getGeneratedArtifactsFromError(error),
    );
    trackedArtifacts = mergeGeneratedArtifacts(materializedArtifacts, generatedArtifacts);
    artifactsWritten = artifactsWritten || trackedArtifacts.length > 0;
    const rollbackIssues: string[] = [];
    const rollbackSurfaces = new Set<string>();
    const trackingManifestPath = getTrackingManifestPath(trackingDir);
    const installedLedgerPath = getInstalledLedgerPath(env);
    const artifactSurfaceHints = collectArtifactRollbackSurfaceHints(
      platform,
      options.cwd,
      options.scope,
      env,
      trackedArtifacts,
    );

    if (materializationCommitted && materializationRollbackHandle) {
      try {
        await rollbackMaterializedSkillTriggerPreference(materializationRollbackHandle);
        materializationCommitted = false;
      } catch (rollbackError) {
        materializationRollbackFailed = true;
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          'repo-managed skill rollback 失败',
          rollbackError,
          artifactSurfaceHints,
        );
      }
    }

    if (artifactsWritten) {
      try {
        if (usesCodexUserDynamicSkillFlow && dynamicSkillArtifactRollbackState) {
          await restoreTrackedArtifactRollbackState(
            platform,
            target,
            options.scope,
            options.cwd,
            env,
            dynamicSkillArtifactRollbackState,
          );
        } else {
          await rollbackArtifacts(
            adapters[platform],
            target,
            options.scope,
            generatedArtifacts,
          );
        }
      } catch (rollbackError) {
        artifactsRollbackFailed = true;
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          'repo artifacts 回滚失败',
          rollbackError,
          artifactSurfaceHints,
        );
      }
    }

    if (nativeWritten && nativeRollbackBaseline) {
      try {
        await restoreCodexNativePluginRollbackBaseline(nativeRollbackBaseline);
        nativeWritten = false;
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          'Codex native materialized cache 回滚失败',
          rollbackError,
          [nativeRollbackBaseline.configPath, nativeRollbackBaseline.cacheRootPath],
        );
      }
    }

    if (trackingWriteAttempted) {
      try {
        await writeTrackingManifest(trackingDir, baselineTracking);
      } catch (rollbackError) {
        trackingRestoreFailed = true;
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `tracking manifest 恢复失败 (${trackingManifestPath})`,
          rollbackError,
          [trackingManifestPath],
        );
      }
    }

    if (lifecycleConfigSnapshot) {
      try {
        await fs.remove(lifecycleConfigSnapshot.snapshotRoot);
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `install snapshot 清理失败 (${lifecycleConfigSnapshot.snapshotRoot})`,
          rollbackError,
          [lifecycleConfigSnapshot.snapshotRoot],
        );
      }
    } else if (preparedLifecycleConfigSnapshot) {
      try {
        if (await fs.pathExists(preparedLifecycleConfigSnapshot.stagingRoot)) {
          await fs.remove(preparedLifecycleConfigSnapshot.stagingRoot);
        }
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `install snapshot staging 清理失败 (${preparedLifecycleConfigSnapshot.stagingRoot})`,
          rollbackError,
          [preparedLifecycleConfigSnapshot.stagingRoot],
        );
      }
    }

    let upgradeBaselineRestoreFailed = false;
    const shouldAttemptUpgradeBaselineRestore = Boolean(
      upgradeRollbackBaseline &&
      (
        nativeWritten ||
        artifactsWritten ||
        trackingWriteAttempted ||
        materializationCommitted
      ),
    );
    if (shouldAttemptUpgradeBaselineRestore && upgradeRollbackBaseline) {
      const upgradeArtifactSurfaceHints = collectTrackedArtifactRollbackSurfaceHints(
        platform,
        options.cwd,
        options.scope,
        env,
        previousTrackedArtifacts,
        upgradeRollbackBaseline.artifactRollbackState,
      );
      let baselineRestored = false;
      try {
        await restoreUpgradeRollbackBaseline(
          upgradeRollbackBaseline,
          platform,
          target,
          options,
          context,
          env,
        );
        baselineRestored = true;
      } catch (restoreError) {
        upgradeBaselineRestoreFailed = true;
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          '旧安装 baseline 恢复失败',
          restoreError,
          [
            ...upgradeArtifactSurfaceHints,
            trackingManifestPath,
            installedLedgerPath,
          ],
        );
      } finally {
        if (upgradeRollbackBaseline.artifactRollbackState) {
          await disposeArtifactRollbackState(upgradeRollbackBaseline.artifactRollbackState)
            .catch(() => undefined);
        }
      }

      if (baselineRestored) {
        throw new Error(`${normalizeErrorMessage(error)}；upgrade 未完成，已恢复旧安装。`);
      }
    } else if (upgradeRollbackBaseline?.artifactRollbackState) {
      await disposeArtifactRollbackState(upgradeRollbackBaseline.artifactRollbackState)
        .catch(() => undefined);
    }

    const degradedReason = upgradeRollbackBaseline && upgradeBaselineRestoreFailed
      ? upgradeRollbackBaseline.degradedReasonOnRestoreFailure
      : resolveInstallRollbackLedgerReason(
          platform,
          options.scope,
          plannedNativeWrite,
          nativeWritten,
          recoveryBreadcrumbPersisted,
          ledgerWritten,
          materializationRollbackFailed,
          artifactsWritten,
          trackingWriteAttempted,
          artifactsRollbackFailed,
          trackingRestoreFailed,
        );

    if (degradedReason) {
      try {
        await writeDegradedLedger(baselineLedger, degradedReason, env);
        await emitCommandEvent(context, {
          type: 'ledger:degraded',
          data: {
            platform,
            plugin: target.currentPlugin.manifest.name,
            scope: options.scope,
            reason: degradedReason,
          },
        });
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `installed.json degraded 写入失败 (${installedLedgerPath})`,
          rollbackError,
          [installedLedgerPath],
        );
      }
    } else if (ledgerWritten) {
      try {
        await writeInstalledLedger(baselineLedger, env);
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `installed.json baseline 恢复失败 (${installedLedgerPath})`,
          rollbackError,
          [installedLedgerPath],
        );
      }
    }

    if (dynamicSkillArtifactRollbackState) {
      await disposeArtifactRollbackState(dynamicSkillArtifactRollbackState).catch(() => undefined);
      dynamicSkillArtifactRollbackState = undefined;
    }
    await disposeCodexNativePluginRollbackBaseline(nativeRollbackBaseline).catch(() => undefined);
    nativeRollbackBaseline = undefined;

    const rollbackFailure = createRollbackFailureError(error, rollbackIssues, rollbackSurfaces);
    if (isCodexUserNativeInstall(platform, target, options.scope) && nativeWritten) {
      throw wrapCodexNativeInstallFailure(
        target.currentPlugin.manifest.name,
        rollbackFailure,
        recoveryBreadcrumbPersisted,
      );
    }
    throw rollbackFailure;
  }

  if (materializationRollbackHandle) {
    try {
      await commitMaterializedSkillTriggerPreference(materializationRollbackHandle);
      materializationCommitted = false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(
        `[${platform}/${target.currentPlugin.manifest.name}] skill trigger 备份目录清理失败：${detail}`,
      );
    }
  }

  const postStatus = await adapters[platform].status(target.currentPlugin, options.scope);
  const drift = filterPostCommandDriftWarnings(postStatus.plugins[0]?.driftWarnings ?? []);
  for (const warning of drift.visible) {
    warnings.push(`[${platform}/${target.currentPlugin.manifest.name}] ${warning}`);
  }
  if (drift.diagnostics.length > 0) {
    await emitCommandEvent(context, {
      type: 'drift:suppressed',
      data: {
        platform,
        plugin: target.currentPlugin.manifest.name,
        warnings: drift.diagnostics,
      },
    });
  }

  if (upgradeRollbackBaseline?.artifactRollbackState) {
    await disposeArtifactRollbackState(upgradeRollbackBaseline.artifactRollbackState)
      .catch(() => undefined);
  }
  if (dynamicSkillArtifactRollbackState) {
    await disposeArtifactRollbackState(dynamicSkillArtifactRollbackState).catch(() => undefined);
  }
  await disposeCodexNativePluginRollbackBaseline(nativeRollbackBaseline).catch(() => undefined);

  return {
    warnings,
    nativePlugins,
    repoManagedArtifacts,
  };
}

export async function installTargetsOnPlatforms(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: InstallCommandOptions,
  runtime: InstallCommandRuntime = {},
): Promise<{ warnings: string[]; nativePlugins: NativePluginsByPlatform; repoManagedArtifacts: GeneratedArtifact[] }> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const operation = runtime.operation ?? 'install';
  const warnings: string[] = [];
  const nativePlugins: NativePluginsByPlatform = {};
  let repoManagedArtifacts: GeneratedArtifact[] = [];
  assertPluginsSupportPlatforms(
    targets
      .map((target) => target.currentPlugin)
      .filter((plugin): plugin is PluginMeta => Boolean(plugin)),
    platforms,
  );
  assertCodexProjectInstallableTargets(targets, platforms, options.scope);

  if (!runtime.skipWriteSafetyPreflight) {
    await preflightCodexProjectWriteSafety({
      targets,
      platforms,
      cwd: options.cwd,
      scope: options.scope,
      env,
      operation,
    });
  }

  if (!runtime.skipConfigPreflight) {
    await preflightInstallConfigs(targets, options, runtime);
  }

  for (const platform of platforms) {
    for (const target of targets) {
      const result = await installTargetOnPlatform(
        target,
        platform,
        options,
        runtime,
        context,
        adapters,
      );
      warnings.push(...result.warnings);
      for (const [resultPlatform, pluginNames] of Object.entries(result.nativePlugins) as Array<[PlatformName, string[]]>) {
        nativePlugins[resultPlatform] ??= [];
        for (const pluginName of pluginNames) {
          if (!nativePlugins[resultPlatform].includes(pluginName)) {
            nativePlugins[resultPlatform].push(pluginName);
          }
        }
      }
      repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, result.repoManagedArtifacts);
    }
  }

  return { warnings, nativePlugins, repoManagedArtifacts };
}

function mergeNodeInstallResult(
  aggregate: InstallLocationNodeResult,
  next: InstallLocationNodeResult,
): InstallLocationNodeResult {
  const nativePlugins: NativePluginsByPlatform = {
    ...aggregate.nativePlugins,
  };
  for (const [platform, pluginNames] of Object.entries(next.nativePlugins) as Array<[PlatformName, string[]]>) {
    nativePlugins[platform] ??= [];
    for (const pluginName of pluginNames) {
      if (!nativePlugins[platform].includes(pluginName)) {
        nativePlugins[platform].push(pluginName);
      }
    }
  }

  return {
    warnings: [...aggregate.warnings, ...next.warnings],
    nativePlugins,
    repoManagedArtifacts: mergeGeneratedArtifacts(
      aggregate.repoManagedArtifacts,
      next.repoManagedArtifacts,
    ),
  };
}

export async function resolveProjectKeysByPlatform(
  cwd: string,
  scope: Scope,
  platforms: PlatformName[],
): Promise<Record<PlatformName, string | null>> {
  const projectKeys: Record<PlatformName, string | null> = {
    codex: null,
    claude: null,
  };
  if (scope === 'user') {
    return projectKeys;
  }

  const [codexProjectKey, claudeProjectKey] = await Promise.all([
    platforms.includes('codex') ? resolveCodexProjectKey(cwd) : Promise.resolve(null),
    platforms.includes('claude') ? resolveClaudeProjectKey(cwd) : Promise.resolve(null),
  ]);
  projectKeys.codex = codexProjectKey;
  projectKeys.claude = claudeProjectKey;
  return projectKeys;
}

export function createPluginLocationForPlatform(options: {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKeysByPlatform: Record<PlatformName, string | null>;
}): PluginLocation {
  return normalizePluginLocation({
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    projectKey: options.scope === 'project'
      ? options.projectKeysByPlatform[options.platform]
      : null,
  });
}

function createScopedInstallOptions(
  options: InstallCommandOptions,
  location: PluginLocation,
): InstallCommandOptions {
  return {
    ...options,
    platform: location.platform,
    scope: location.scope,
  };
}

export function toInstalledScopeInstallOptions(
  resolvedInstallOptions: ResolvedInstallOptions | undefined,
): InstalledScopeRecord<Record<string, unknown>>['installOptions'] {
  return resolvedInstallOptions?.applicability === 'overridable'
    ? {
        skillTriggerPreference: resolvedInstallOptions.skillTriggerPreference,
      }
    : undefined;
}

function getInstalledScopeRecordForLocation(
  ledger: InstalledLedger,
  location: PluginLocation,
): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = ledger.plugins[location.plugin]?.platforms[location.platform];
  if (!platformRecord) {
    return undefined;
  }
  if (location.scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }
  return location.projectKey
    ? platformRecord.projectScopes?.[location.projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

function setInstalledScopeRecordForLocation(
  ledger: InstalledLedger,
  location: PluginLocation,
  record: InstalledScopeRecord<Record<string, unknown>>,
): void {
  const platformRecord = ledger.plugins[location.plugin]?.platforms[location.platform];
  if (!platformRecord) {
    throw new Error(`缺少 ${location.platform}/${location.plugin} 的 ledger platform record。`);
  }
  if (location.scope === 'user') {
    platformRecord.userScope = record;
    return;
  }
  if (!location.projectKey) {
    throw new Error(`缺少 ${location.platform}/${location.plugin} 的 project key。`);
  }
  platformRecord.projectScopes ??= {};
  platformRecord.projectScopes[location.projectKey] = record;
}

function replaceScopeRecordDependencyEdges(
  record: InstalledScopeRecord<Record<string, unknown>>,
  edges: readonly InstalledDependencyEdge[],
): InstalledScopeRecord<Record<string, unknown>> {
  return upsertDependencyEdges(
    {
      ...record,
      dependencyEdges: [],
    },
    edges,
  );
}

async function updateInstallRecordForLocation(options: {
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  update: (recordFile: InstallRecordFile) => InstallRecordFile;
}): Promise<boolean> {
  const readResult = await readInstallRecordForLocation({
    cwd: options.cwd,
    location: toInstallStateLocation(options.location),
    env: options.env,
  });
  if (readResult.status !== 'ok') {
    return false;
  }

  const nextRecord = options.update(structuredClone(readResult.value));
  const recordPath = getInstallRecordPath(
    options.cwd,
    toInstallStateLocation(options.location),
    options.env,
  );
  await runInstallStateTransaction({
    stages: [
      await createInstallRecordWriteStage({
        filePath: recordPath,
        value: nextRecord,
        env: options.env,
      }),
    ],
    postCommit: [
      createDependencyIndexRefreshPostCommitAction({
        mode: 'upsert',
        recordFile: nextRecord,
        recordPath,
        env: options.env,
      }),
    ],
  });
  return true;
}

async function updateInstalledScopeRecord(
  location: PluginLocation,
  env: NodeJS.ProcessEnv,
  update: (
    record: InstalledScopeRecord<Record<string, unknown>>,
  ) => InstalledScopeRecord<Record<string, unknown>>,
): Promise<void> {
  const ledger = await readInstalledLedger(env);
  const scopeRecord = getInstalledScopeRecordForLocation(ledger, location);
  if (!scopeRecord) {
    throw new Error(`缺少 ${location.platform}/${location.plugin} (${location.scope}) 的 ledger scope record。`);
  }
  setInstalledScopeRecordForLocation(ledger, location, update(scopeRecord));
  await writeInstalledLedger(ledger, env);
}

function toInstalledDependencyEdges(edges: readonly PluginDependencyEdgePlan[]): InstalledDependencyEdge[] {
  return edges.map((edge) => ({
    dependency: normalizePluginLocation(edge.dependency),
    declaration: structuredClone(edge.declaration),
  }));
}

export async function initializeInstalledScopeDependencyMetadata(options: {
  location: PluginLocation;
  cwd?: string;
  requested: boolean;
  preserveExplicit: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const cwd = options.cwd ?? (options.location.scope === 'project'
    ? options.location.projectKey ?? process.cwd()
    : process.cwd());
  const updatedInstallRecord = await updateInstallRecordForLocation({
    location: options.location,
    cwd,
    env: options.env,
    update: (recordFile) => {
      recordFile.record.installSource = options.requested || options.preserveExplicit
        ? toInstallRecordInstallSource('explicit')
        : toInstallRecordInstallSource('dependency');
      recordFile.record.dependencyEdges = [];
      return recordFile;
    },
  });
  if (updatedInstallRecord) {
    return;
  }

  await updateInstalledScopeRecord(options.location, options.env, (record) => {
    const nextRecord = options.requested || options.preserveExplicit
      ? markScopeRecordExplicitlyRequested(record)
      : {
          ...record,
          installSource: createInstallSource('dependency'),
        };
    nextRecord.dependencyEdges = [];
    return nextRecord;
  });
}

export async function commitInstalledScopeDependencyEdges(
  location: PluginLocation,
  edges: readonly PluginDependencyEdgePlan[],
  cwdOrEnv: string | NodeJS.ProcessEnv,
  envMaybe?: NodeJS.ProcessEnv,
): Promise<void> {
  const cwd = typeof cwdOrEnv === 'string'
    ? cwdOrEnv
    : (location.scope === 'project' ? location.projectKey ?? process.cwd() : process.cwd());
  const env = typeof cwdOrEnv === 'string' ? envMaybe! : cwdOrEnv;
  const updatedInstallRecord = await updateInstallRecordForLocation({
    location,
    cwd,
    env,
    update: (recordFile) => {
      recordFile.record.dependencyEdges = toInstalledDependencyEdges(edges).map((edge) => ({
        dependency: {
          ...edge.dependency,
          projectKey: edge.dependency.projectKey ?? undefined,
        },
        declaration: structuredClone(edge.declaration),
      }));
      return recordFile;
    },
  });
  if (updatedInstallRecord) {
    return;
  }

  await updateInstalledScopeRecord(location, env, (record) =>
    replaceScopeRecordDependencyEdges(record, toInstalledDependencyEdges(edges)),
  );
}

async function deleteInstallRecordForLocation(options: {
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const readResult = await readInstallRecordForLocation({
    cwd: options.cwd,
    location: toInstallStateLocation(options.location),
    env: options.env,
  });
  if (readResult.status !== 'ok') {
    return false;
  }

  const recordPath = getInstallRecordPath(
    options.cwd,
    toInstallStateLocation(options.location),
    options.env,
  );
  await runInstallStateTransaction({
    stages: [
      createInstallRecordDeleteStage({
        filePath: recordPath,
      }),
    ],
    postCommit: [
      createDiagnosticCacheDeletePostCommitAction({
        cwd: options.cwd,
        location: toInstallStateLocation(options.location),
        env: options.env,
      }),
      createDependencyIndexRefreshPostCommitAction({
        mode: 'delete',
        location: toInstallStateLocation(options.location),
        recordPath,
        env: options.env,
      }),
    ],
  });
  return true;
}

export async function ensureRollbackRemovedDependencyLocation(options: {
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const trackingDir = resolveTrackingDir(
    options.cwd,
    options.location.platform,
    options.location.scope,
    options.env,
  );
  const trackingManifest = await readTrackingManifest(trackingDir);
  if (trackingManifest.plugins[options.location.plugin]) {
    await writeTrackingManifest(
      trackingDir,
      removeTrackingRecordFromManifest(trackingManifest, options.location.plugin),
    );
  }

  if (await deleteInstallRecordForLocation(options)) {
    return;
  }

  const ledger = await readInstalledLedger(options.env);
  if (!getInstalledScopeRecordForLocation(ledger, options.location)) {
    return;
  }

  const nextLedger = options.location.platform === 'claude'
    ? await applyClaudeUninstallLedger(
        ledger,
        options.location.plugin,
        options.location.scope,
        options.cwd,
      )
    : await applyCodexUninstallLedger(
        ledger,
        options.location.plugin,
        options.location.scope,
        options.cwd,
      );
  await writeInstalledLedger(nextLedger, options.env);
}

function ledgerHasIncomingDependencyReference(
  ledger: InstalledLedger,
  location: PluginLocation,
): boolean {
  const locationKey = serializePluginLocation(location);
  return Object.entries(ledger.plugins).some(([, pluginRecord]) =>
    ['codex', 'claude'].some((platform) => {
      const platformRecord = pluginRecord.platforms[platform as PlatformName];
      const scopeRecords = [
        platformRecord?.userScope,
        ...Object.values(platformRecord?.projectScopes ?? {}),
      ].filter(Boolean) as Array<InstalledScopeRecord<Record<string, unknown>>>;
      return scopeRecords.some((scopeRecord) =>
        (scopeRecord.dependencyEdges ?? []).some((edge) =>
          serializePluginLocation(edge.dependency) === locationKey),
      );
    }),
  );
}

async function installRecordHasIncomingDependencyReference(options: {
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const inspection = await inspectGlobalDependencyIndex(options.env);
  if (inspection.status !== 'ok') {
    return false;
  }

  const locationKey = serializePluginLocation(options.location);
  return inspection.value.records.some((record) =>
    record.dependencyEdges.some((edge) =>
      serializePluginLocation(normalizePluginLocation({
        ...edge.dependency,
        projectKey: edge.dependency.projectKey ?? null,
      })) === locationKey,
    ),
  );
}

export async function cleanupOrphanedAutoDependenciesAfterFailedInstall(options: {
  plan: PluginDependencyWritePlan;
  cwd: string;
  env: NodeJS.ProcessEnv;
  targetByPlugin?: ReadonlyMap<string, ResolvedPluginTarget>;
  adapters?: Record<PlatformName, PlatformAdapter>;
  scriptTimeoutMs?: number;
}): Promise<void> {
  const rollbackLiveDependencyLocation = async (location: PluginLocation): Promise<void> => {
    const target = options.targetByPlugin?.get(location.plugin);
    const adapter = options.adapters?.[location.platform];
    if (!target || !adapter) {
      return;
    }

    try {
      await uninstallTargetsOnPlatforms(
        [target],
        [location.platform],
        {
          cwd: options.cwd,
          platform: location.platform,
          scope: location.scope,
          scriptTimeoutMs: options.scriptTimeoutMs,
          removeConfig: false,
        },
        {
          env: options.env,
          adapters: options.adapters,
        },
      );
      return;
    } catch {
      const plugin = target.currentPlugin ?? target.plugin;
      await adapter.uninstallExtensions(plugin, location.scope).catch(() => undefined);
      await adapter.uninstallPlugin(plugin, location.scope).catch(() => undefined);
    }
  };

  for (const location of [...options.plan.writeOrder].reverse()) {
    const node = options.plan.nodesByLocation[serializePluginLocation(location)];
    if (node?.action !== 'installDependency') {
      continue;
    }

    const installRecord = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: toInstallStateLocation(location),
      env: options.env,
    });
    if (
      installRecord.status === 'ok' &&
      installRecord.value.record.installSource.kind === 'dependency' &&
      installRecord.value.record.installSource.explicitlyRequested === false &&
      !(await installRecordHasIncomingDependencyReference({
        location,
        env: options.env,
      }))
    ) {
      await rollbackLiveDependencyLocation(location);
      await ensureRollbackRemovedDependencyLocation({
        location,
        cwd: options.cwd,
        env: options.env,
      });
      continue;
    }

    const ledger = await readInstalledLedger(options.env);
    const scopeRecord = getInstalledScopeRecordForLocation(ledger, location);
    if (
      !scopeRecord?.installSource ||
      scopeRecord.installSource.kind !== 'dependency' ||
      scopeRecord.installSource.explicitlyRequested !== false ||
      ledgerHasIncomingDependencyReference(ledger, location)
    ) {
      continue;
    }

    await rollbackLiveDependencyLocation(location);
    await ensureRollbackRemovedDependencyLocation({
      location,
      cwd: options.cwd,
      env: options.env,
    });
  }
}

function getEffectiveManifestDependenciesForPlatform(
  plugin: PluginMeta['manifest'],
  platform: PlatformName,
) {
  return (plugin.dependencies?.plugins ?? []).filter((entry) =>
    !entry.when?.platforms || entry.when.platforms.includes(platform),
  );
}

function collectInstallPlannerPluginPairs(options: {
  requestedLocations: PluginLocation[];
  targetByPlugin: Map<string, ResolvedPluginTarget>;
}): PluginLocation[] {
  const visited = new Set<string>();
  const orderedPairs: PluginLocation[] = [];

  const visit = (location: PluginLocation): void => {
    const key = `${location.plugin}:${location.platform}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    orderedPairs.push(location);

    const target = options.targetByPlugin.get(location.plugin);
    const manifest = target?.currentPlugin?.manifest;
    if (!manifest) {
      return;
    }

    for (const dependency of getEffectiveManifestDependenciesForPlatform(manifest, location.platform)) {
      visit(normalizePluginLocation({
        plugin: dependency.name,
        platform: location.platform,
        scope: 'user',
        projectKey: null,
      }));
    }
  };

  for (const location of options.requestedLocations) {
    visit(location);
  }

  return orderedPairs;
}

function buildPlannerCandidateLocations(options: {
  pluginPairs: PluginLocation[];
  scope: Scope;
  projectKeysByPlatform: Record<PlatformName, string | null>;
}): PluginLocation[] {
  const locations = new Map<string, PluginLocation>();
  for (const pair of options.pluginPairs) {
    const userLocation = createPluginLocationForPlatform({
      plugin: pair.plugin,
      platform: pair.platform,
      scope: 'user',
      projectKeysByPlatform: options.projectKeysByPlatform,
    });
    locations.set(serializePluginLocation(userLocation), userLocation);

    if (options.scope === 'project') {
      const projectLocation = createPluginLocationForPlatform({
        plugin: pair.plugin,
        platform: pair.platform,
        scope: 'project',
        projectKeysByPlatform: options.projectKeysByPlatform,
      });
      locations.set(serializePluginLocation(projectLocation), projectLocation);
    }
  }

  return [...locations.values()];
}

async function classifyPlannerHealthRecord(options: {
  location: PluginLocation;
  target: ResolvedPluginTarget;
  status: PluginStatusReport;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<PluginDependencyPlannerHealthRecord> {
  const managedByAw = hasScopeManagedEvidence(options.status);
  const generatedArtifactIdentityRefusal = getGeneratedArtifactIdentityRefusal(options.status);
  const trackingIdentityRefusal = managedByAw
    ? await getTrackingArtifactIdentityRefusal({
        cwd: options.cwd,
        env: options.env,
        platform: options.location.platform,
        scope: options.location.scope,
        pluginName: options.location.plugin,
      })
    : null;

  let state: PluginDependencyPlannerHealthRecord['state'];
  if (!managedByAw) {
    if (options.status.externalOwnership?.present) {
      state = 'externalOnly';
    } else if (options.status.native.recovery?.present) {
      state = 'repairRequired';
    } else if (options.status.platformNativeFallbackEvidence?.present) {
      state = 'cacheOnly';
    } else if (options.status.platformRuntimeEvidence?.present) {
      state = 'enabledOnly';
    } else {
      state = 'missing';
    }
  } else if (options.status.externalOwnership?.present) {
    state = 'external';
  } else if (options.status.native.recovery?.present) {
    state = 'repairRequired';
  } else if (options.status.ledgerStateStatus !== 'available') {
    state = 'degraded';
  } else if (generatedArtifactIdentityRefusal || trackingIdentityRefusal) {
    state = 'trackingBroken';
  } else if (options.status.artifactsInitialized === false) {
    state = 'degraded';
  } else {
    state = 'healthy';
  }

  return {
    location: options.location,
    state,
    visible: true,
    managedByAw,
  };
}

export async function buildInstallPlannerContext(options: {
  requestedLocations: PluginLocation[];
  extraLocations?: PluginLocation[];
  targetByPlugin: Map<string, ResolvedPluginTarget>;
  adapters: Record<PlatformName, PlatformAdapter>;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: InstalledLedger;
  projectKeysByPlatform: Record<PlatformName, string | null>;
  readStatusForRequestedLocations?: boolean;
}): Promise<{
  plannerState: PluginDependencyPlannerState;
  graphContext: InstallLocationGraphContext;
}> {
  const pluginPairs = collectInstallPlannerPluginPairs({
    requestedLocations: options.requestedLocations,
    targetByPlugin: options.targetByPlugin,
  });
  const candidateLocations = buildPlannerCandidateLocations({
    pluginPairs,
    scope: options.scope,
    projectKeysByPlatform: options.projectKeysByPlatform,
  });
  const candidateLocationsByKey = new Map(
    candidateLocations.map((location) => [serializePluginLocation(location), location]),
  );
  const requestedLocationKeys = new Set(
    options.requestedLocations.map((location) => serializePluginLocation(normalizePluginLocation(location))),
  );
  for (const location of options.extraLocations ?? []) {
    candidateLocationsByKey.set(
      serializePluginLocation(location),
      normalizePluginLocation(location),
    );
  }

  const statusByLocation = new Map<string, PluginStatusReport>();
  const healthRecords: PluginDependencyPlannerHealthRecord[] = [];
  const installRecordByLocation = new Map<string, InstallRecordFile>();
  for (const location of candidateLocationsByKey.values()) {
    const target = options.targetByPlugin.get(location.plugin);
    if (!target?.currentPlugin) {
      throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
    }
    const locationKey = serializePluginLocation(location);
    const installRecord = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: toInstallStateLocation(location),
      env: options.env,
    });
    if (installRecord.status === 'ok') {
      installRecordByLocation.set(locationKey, installRecord.value);
    }
    const scopeRecord = getInstalledScopeRecordForLocation(options.ledger, location);
    const shouldReadStatus =
      installRecord.status === 'ok' ||
      Boolean(scopeRecord) ||
      (
        options.readStatusForRequestedLocations === true &&
        requestedLocationKeys.has(locationKey)
      );
    if (!shouldReadStatus) {
      healthRecords.push({
        location,
        state: 'missing',
        visible: true,
        managedByAw: false,
      });
      continue;
    }
    const status = await options.adapters[location.platform].status(target.currentPlugin, location.scope);
    const pluginStatus = status.plugins[0];
    if (!pluginStatus) {
      throw new Error(`无法读取 ${location.platform}/${location.plugin} (${location.scope}) 的状态。`);
    }
    statusByLocation.set(locationKey, pluginStatus);
    healthRecords.push(await classifyPlannerHealthRecord({
      location,
      target,
      status: pluginStatus,
      cwd: options.cwd,
      env: options.env,
    }));
  }

  const installedRecordByLocation = new Map<string, PluginDependencyPlannerInstalledRecord>();
  for (const location of candidateLocationsByKey.values()) {
    const locationKey = serializePluginLocation(location);
    const installRecord = installRecordByLocation.get(locationKey);
    if (installRecord) {
      installedRecordByLocation.set(locationKey, toPlannerInstalledRecordFromInstallRecord(installRecord));
      continue;
    }
    const scopeRecord = getInstalledScopeRecordForLocation(options.ledger, location);
    if (!scopeRecord) {
      continue;
    }
    installedRecordByLocation.set(locationKey, {
      location,
      resolvedVersion: scopeRecord.resolvedVersion,
      installSource: scopeRecord.installSource,
      dependencyEdges: scopeRecord.dependencyEdges,
      installOptions: scopeRecord.installOptions,
    });
  }

  return {
    plannerState: {
      currentCatalogByPlugin: Object.fromEntries(
        [...options.targetByPlugin.entries()]
          .filter(([, target]) => Boolean(target.currentPlugin))
          .map(([pluginName, target]) => [pluginName, structuredClone(target.currentPlugin!.manifest)]),
      ),
      installedRecords: [...installedRecordByLocation.values()],
      healthRecords,
    },
    graphContext: {
      targetByPlugin: options.targetByPlugin,
      statusByLocation,
      installedRecordByLocation,
    },
  };
}

export function requiresRuntimeWritableMarketplaceForGraphNodes(
  locations: readonly PluginLocation[],
  targetByPlugin: Map<string, ResolvedPluginTarget>,
): boolean {
  return locations.some((location) => {
    if (location.platform === 'claude') {
      return true;
    }
    const target = targetByPlugin.get(location.plugin);
    const plugin = target?.currentPlugin ?? target?.plugin;
    return plugin ? requiresCodexNativePlugin(plugin, location.scope) : false;
  });
}

function applyPlannedInstallOptionOverrides(
  resolvedInstallOptions: ResolvedInstallOptions,
  node: PluginDependencyNodePlan,
): ResolvedInstallOptions {
  const plannedPreference = node.installOptions?.skillTriggerPreference;
  if (
    !plannedPreference ||
    resolvedInstallOptions.applicability !== 'overridable' ||
    resolvedInstallOptions.skillTriggerPreference === plannedPreference
  ) {
    return resolvedInstallOptions;
  }

  return {
    applicability: 'overridable',
    skillTriggerPreference: plannedPreference,
    skillTriggerSource: node.requested ? resolvedInstallOptions.skillTriggerSource : 'default',
    ledgerTrust: resolvedInstallOptions.ledgerTrust,
  };
}

export async function resolveGraphInstallOptionsByLocation(options: {
  mode: 'install' | 'upgrade' | 'upgrade-all';
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
  commandOptions: Pick<InstallCommandOptions | UpgradeCommandOptions, 'cwd' | 'requestedSkillTrigger'>;
  ledger: InstalledLedger;
  env: NodeJS.ProcessEnv;
}): Promise<Map<string, ResolvedInstallOptions>> {
  const requests = options.plan.writeOrder.map((location) => {
    const target = options.graphContext.targetByPlugin.get(location.plugin);
    if (!target) {
      throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
    }
    const node = options.plan.nodesByLocation[serializePluginLocation(location)];
    return {
      location,
      target,
      requestedSkillTrigger: node?.requested ? options.commandOptions.requestedSkillTrigger : undefined,
    };
  });
  const baseResolvedByLocation = await resolveInstallOptionsForLocationTargets(
    options.mode,
    requests,
    {
      cwd: options.commandOptions.cwd,
      env: options.env,
    },
    options.ledger,
  );

  const resolvedByLocation = new Map<string, ResolvedInstallOptions>();
  for (const location of options.plan.writeOrder) {
    const key = serializePluginLocation(location);
    const baseResolved = baseResolvedByLocation.get(key);
    const node = options.plan.nodesByLocation[key];
    if (!baseResolved || !node) {
      throw new Error(`缺少 ${location.platform}/${location.plugin} (${location.scope}) 的 resolved install options。`);
    }
    resolvedByLocation.set(key, applyPlannedInstallOptionOverrides(baseResolved, node));
  }

  return resolvedByLocation;
}

async function preflightInstallGraphWrites(options: {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
  resolvedInstallOptionsByLocation: Map<string, ResolvedInstallOptions>;
  commandOptions: InstallCommandOptions;
  runtime: InstallCommandRuntime;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const writeTargets = options.plan.writeOrder.map((location) => {
    const target = options.graphContext.targetByPlugin.get(location.plugin);
    if (!target?.currentPlugin) {
      throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
    }
    return {
      location,
      target,
      status: options.graphContext.statusByLocation.get(serializePluginLocation(location)),
    };
  });

  for (const { location, target } of writeTargets) {
    assertPluginsSupportPlatforms([target.currentPlugin!], [location.platform]);
    if (!options.resolvedInstallOptionsByLocation.has(serializePluginLocation(location))) {
      throw new Error(`缺少 ${location.platform}/${location.plugin} (${location.scope}) 的 resolved install options。`);
    }
  }

  for (const scope of ['user', 'project'] as const satisfies readonly Scope[]) {
    const codexTargetsForScope = writeTargets
      .filter(({ location }) => location.scope === scope && location.platform === 'codex')
      .map(({ target }) => target);
    if (codexTargetsForScope.length === 0) {
      continue;
    }
    if (scope === 'project') {
      assertCodexProjectInstallableTargets(codexTargetsForScope, ['codex'], 'project');
    }
    await preflightCodexProjectWriteSafety({
      targets: codexTargetsForScope,
      platforms: ['codex'],
      cwd: options.commandOptions.cwd,
      scope,
      env: options.env,
      operation: 'install',
    });
  }

  for (const scope of ['user', 'project'] as const satisfies readonly Scope[]) {
    const targetsForScope = writeTargets
      .filter(({ location }) => location.scope === scope)
      .map(({ target }) => target);
    if (targetsForScope.length === 0) {
      continue;
    }
    await preflightInstallConfigs(
      targetsForScope,
      {
        ...options.commandOptions,
        scope,
      },
      options.runtime,
    );
  }

  const embeddedRoot = await resolveEmbeddedPluginsRoot();

  for (const { location, target, status } of writeTargets) {
    const locationKey = serializePluginLocation(location);
    const resolvedInstallOptions = options.resolvedInstallOptionsByLocation.get(locationKey);
    const installedRecord = options.graphContext.installedRecordByLocation.get(locationKey);
    if (
      status?.externalOwnership?.present &&
      !(location.platform === 'codex' && location.scope === 'project')
    ) {
      throw new Error(status.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.commandOptions.cwd,
      env: options.env,
      platform: location.platform,
      scope: location.scope,
      pluginName: location.plugin,
    });
    if (trackingIdentityRefusal) {
      throw new Error(trackingIdentityRefusal);
    }

    if (status) {
      const generatedArtifactIdentityRefusal = getGeneratedArtifactIdentityRefusal(status);
      if (generatedArtifactIdentityRefusal) {
        throw new Error(generatedArtifactIdentityRefusal);
      }
    }

    if (!target.currentPlugin) {
      throw new Error(`Unknown plugin "${target.pluginName}".`);
    }

    if (location.scope === 'project') {
      const privateStateRoot = getInstallStatePrivateRoot(
        options.commandOptions.cwd,
        toInstallStateLocation(location),
        options.env,
      );
      const ignoreResult = await ensureProjectPrivateStateIgnore({
        cwd: options.commandOptions.cwd,
        targetPath: privateStateRoot,
      });

      await assertProjectArtifactIdentityPathVisible({
        cwd: options.commandOptions.cwd,
        pluginName: location.plugin,
        platform: location.platform,
        projectKey: location.projectKey,
      });

      if (!installedRecord && projectStatusLooksAdoptable(status)) {
        throw new Error(
          `${location.plugin} 在 ${location.platform} (${location.scope}) 检测到可认领的 project artifacts；install 不会自动接管。请先运行 \`aw repair ${location.plugin} --platform ${location.platform} --scope ${location.scope} --adopt-existing\`。`,
        );
      }

      const repoRoot = resolveProjectScopeRepoRoot(options.commandOptions.cwd);
      const projectRoot = resolveProjectArtifactProjectRoot(options.commandOptions.cwd, location);
      const locator = createProjectArtifactSharedLocator({
        plugin: location.plugin,
        platform: location.platform,
        repoRoot,
        projectRoot,
      });
      const sharedIdentity = await readProjectArtifactIdentityForLocator({
        repoRoot,
        locator,
        cwd: options.commandOptions.cwd,
      });
      if (!installedRecord && sharedIdentity.status === 'ok') {
        throw new Error(
          `${location.plugin} 在 ${location.platform} (${location.scope}) 已存在可认领的 project artifact shared identity；install 不会自动接管。请先运行 \`aw repair ${location.plugin} --platform ${location.platform} --scope ${location.scope} --adopt-existing\`。`,
        );
      }
    }

    if (resolvedInstallOptions && shouldMaterializeSkillTriggers(location.platform, location.scope, resolvedInstallOptions)) {
      const sharedOwnerPreflight = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
        location: toInstallStateLocation(location),
        embeddedRoot,
        target: createSkillTriggerMaterializationTarget(
          location.platform,
          location.scope,
          options.commandOptions.cwd,
          options.env,
        ),
        preference: resolveMaterializationPreference(resolvedInstallOptions),
        command: 'install',
        takeoverSharedRuntime: options.commandOptions.takeoverSharedRuntime,
        targetCount: options.plan.requestedRoots.length,
        env: options.env,
      });
      if (sharedOwnerPreflight.status !== 'ok') {
        throw new Error(sharedOwnerPreflight.takeoverRequired.message);
      }
    }
  }
}

function buildGraphWriteExecutorNodes(options: {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
}): PluginDependencyWriteExecutorNode[] {
  const outgoingEdgesByDependent = new Map<string, PluginDependencyEdgePlan[]>();
  for (const edge of options.plan.edges) {
    const dependentKey = serializePluginLocation(edge.dependent);
    const bucket = outgoingEdgesByDependent.get(dependentKey) ?? [];
    bucket.push(edge);
    outgoingEdgesByDependent.set(dependentKey, bucket);
  }

  return options.plan.writeOrder.map((location) => {
    const key = serializePluginLocation(location);
    const node = options.plan.nodesByLocation[key];
    const installedRecord = options.graphContext.installedRecordByLocation.get(key);
    return {
      location,
      action: node.action,
      requested: node.requested,
      rollbackEligible: node.action === 'installDependency' && !installedRecord,
      dependencyOf: node.dependencyOf,
      outgoingEdges: outgoingEdgesByDependent.get(key) ?? [],
    };
  });
}

function createInstallReceiptTargets(
  plan: PluginDependencyWritePlan,
  targetByPlugin: ReadonlyMap<string, ResolvedPluginTarget>,
): InstallCommandReceiptTarget[] {
  return plan.topologicalOrder.map((location) => {
    const node = plan.nodesByLocation[serializePluginLocation(location)];
    const target = targetByPlugin.get(location.plugin);
    return {
      plugin: location.plugin,
      platform: location.platform,
      scope: location.scope,
      requested: node?.requested === true,
      ...(target
        ? {
            selectedVersion: target.plugin.manifest.version,
            selectedVersionSource: target.source === 'historical' ? 'historical' as const : 'currentCatalog' as const,
          }
        : {}),
      ...(node?.dependencyOf.length
        ? {
            dependencyOf: node.dependencyOf.map((dependencyOf) => ({
              plugin: dependencyOf.plugin,
              platform: dependencyOf.platform,
              scope: dependencyOf.scope,
            })),
          }
        : {}),
    };
  });
}

function createInstallReceiptActions(
  plan: PluginDependencyWritePlan,
  targetByPlugin: ReadonlyMap<string, ResolvedPluginTarget>,
): InstallCommandReceiptAction[] {
  return plan.writeOrder
    .filter((location) =>
      plan.nodesByLocation[serializePluginLocation(location)]?.action === 'installDependency',
    )
    .map((location) => {
      const node = plan.nodesByLocation[serializePluginLocation(location)];
      const target = targetByPlugin.get(location.plugin);
      return {
        plugin: location.plugin,
        platform: location.platform,
        scope: location.scope,
        type: 'installDependency',
        status: 'succeeded',
        ...(target
          ? {
              selectedVersion: target.plugin.manifest.version,
              selectedVersionSource: target.source === 'historical' ? 'historical' as const : 'currentCatalog' as const,
            }
          : {}),
      };
    });
}

function withEarlyDegradedLedgerWarning(
  warnings: string[],
  ledger: InstalledLedger,
): string[] {
  if (warnings.length > 0 || ledger.ledgerState.status !== 'degraded') {
    return warnings;
  }

  return [
    `installed.json 处于 degraded 状态（${ledger.ledgerState.reason ?? 'unknown'}），跳过 skill trigger 偏好 replay，保留 embedded pristine 默认策略。`,
  ];
}

export async function installCommand(
  pluginNames: string[],
  rawOptions: RawInstallCommandOptions,
  runtime: InstallCommandRuntime = {},
): Promise<InstallCommandResult> {
  const options = normalizeInstallCommandOptions(rawOptions);
  if (pluginNames.length === 0) {
    throw new Error('install 命令至少需要一个插件名。非交互模式下请运行 `aw install <插件名>`。');
  }

  const context = createCommandExecutionContext(runtime);
  const env = applyCatalogSelectorEnv(context.env, options);
  let prepared: Awaited<ReturnType<typeof preparePluginTargetsForCommand>>;
  try {
    prepared = await preparePluginTargetsForCommand(
      options.cwd,
      options.scope,
      pluginNames,
      {
        catalogMode: 'readOnly',
        allowHistoricalFallback: false,
        env,
      },
    );
  } catch (error) {
    if (options.scope === 'user') {
      const missingPluginMatch = /Unknown plugin "([^"]+)"\./.exec(normalizeErrorMessage(error));
      const missingPluginName = missingPluginMatch?.[1];
      if (missingPluginName) {
        const nativeMarker = await readNativeTransactionMarker(missingPluginName, env);
        const breadcrumb = nativeMarker.status === 'ok'
          ? nativeMarker.value
          : await readCodexNativeRecoveryBreadcrumb(missingPluginName, env);
        if (breadcrumb) {
          throw new Error(
            `${missingPluginName} 当前不在 current catalog 中，无法执行 repair install。请先恢复该插件到当前 catalog，或运行 \`aw uninstall ${missingPluginName} -p codex -s user\` 清理 Codex native 残留。`,
          );
        }
      }
    }
    throw error;
  }
  await emitCommandEvent(context, {
    type: 'catalog:resolved',
    data: {
      plugins: prepared.targets.map((target) => ({
        name: target.pluginName,
        source: target.source,
        current: Boolean(target.currentPlugin),
      })),
      warnings: prepared.warnings,
    },
  });
  let commandWarnings = prepared.warnings;
  let installPlan: PluginDependencyWritePlan | undefined;
  let installPlanTargetByPlugin: Map<string, ResolvedPluginTarget> | undefined;
  let installAdapters: Record<PlatformName, PlatformAdapter> | undefined;
  try {
    const adapters = createAdapters(options.cwd, context);
    installAdapters = adapters;
    const requestedPlatformPairs = await resolveCurrentCatalogWriteTargetPairs(
      'install',
      options.platform,
      options.cwd,
      options.scope,
      prepared.targets,
      adapters,
      env,
    );
    const platforms = [...new Set(requestedPlatformPairs.map((entry) => entry.platform))];
    await emitCommandEvent(context, {
      type: 'platform:resolved',
      data: {
        requestedPlatform: options.platform,
        platforms,
        scope: options.scope,
      },
    });
    const allCatalogTargets = await loadPluginTargetsForCommand(
      options.cwd,
      options.scope,
      undefined,
      {
        catalogMode: 'readOnly',
        allowHistoricalFallback: false,
        env,
      },
    );
    const targetByPlugin = new Map<string, ResolvedPluginTarget>(
      allCatalogTargets.map((target) => [target.pluginName, target]),
    );
    installPlanTargetByPlugin = targetByPlugin;
    const projectKeysByPlatform = await resolveProjectKeysByPlatform(
      options.cwd,
      options.scope,
      platforms,
    );
    const requestedLocations = requestedPlatformPairs.map(({ pluginName, platform }) =>
      createPluginLocationForPlatform({
        plugin: pluginName,
        platform,
        scope: options.scope,
        projectKeysByPlatform,
      }));
    const rootInstallOptionsByLocation = await resolveInstallOptionsForLocationTargets(
      'install',
      requestedLocations.map((location) => {
        const target = targetByPlugin.get(location.plugin);
        if (!target) {
          throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
        }
        return {
          location,
          target,
          requestedSkillTrigger: options.requestedSkillTrigger,
        };
      }),
      {
        cwd: options.cwd,
        env,
      },
      prepared.ledger,
    );
    const plannerTargets = requestedLocations.map((location) => ({
      location,
      installOptions: toInstalledScopeInstallOptions(
        rootInstallOptionsByLocation.get(serializePluginLocation(location)),
      ),
    }));
    const { plannerState, graphContext } = await buildInstallPlannerContext({
      requestedLocations,
      targetByPlugin,
      adapters,
      scope: options.scope,
      cwd: options.cwd,
      env,
      ledger: prepared.ledger,
      projectKeysByPlatform,
      readStatusForRequestedLocations: true,
    });
    const graphPlan = planPluginDependencyWrites({
      mode: 'install',
      state: plannerState,
      targets: plannerTargets,
    });
    installPlan = graphPlan;
    await assertNoDuplicateInstalls({
      cwd: options.cwd,
      locations: graphPlan.preflight.scopeExclusivity.filter((location) =>
        shouldEnforceDuplicateInstallPreflight({
          location,
          plugin: targetByPlugin.get(location.plugin)?.currentPlugin
            ?? targetByPlugin.get(location.plugin)?.plugin
            ?? null,
        })),
      env,
    });
    const runtimeWritableMarketplace = requiresRuntimeWritableMarketplaceForGraphNodes(
      graphPlan.writeOrder,
      targetByPlugin,
    );
    const preparedForExecution = await prepareCommandEnvironment({
      catalogMode: runtimeWritableMarketplace ? 'runtimeWritable' : 'readOnly',
      env,
      context,
    });
    commandWarnings = [
      ...prepared.warnings,
      ...preparedForExecution.warnings,
    ];
    const resolvedInstallOptionsByLocation = await resolveGraphInstallOptionsByLocation({
      mode: 'install',
      plan: graphPlan,
      graphContext,
      commandOptions: options,
      ledger: preparedForExecution.ledger,
      env,
    });
    await emitCommandEvent(context, {
      type: 'skill-trigger:resolved',
      data: {
        entries: [...resolvedInstallOptionsByLocation.entries()].map(([key, value]) => ({
          key,
          applicability: value.applicability,
          ...(value.applicability === 'overridable'
            ? {
                preference: value.skillTriggerPreference,
                source: value.skillTriggerSource,
              }
            : {}),
          ledgerTrust: value.ledgerTrust,
        })),
      },
    });
    const executorNodes = buildGraphWriteExecutorNodes({
      plan: graphPlan,
      graphContext,
    });
    const graphResult = await executePluginDependencyWriteGraph({
      nodes: executorNodes,
      preflight: async () => {
        await preflightInstallGraphWrites({
          plan: graphPlan,
          graphContext,
          resolvedInstallOptionsByLocation,
          commandOptions: options,
          runtime: context,
          env,
        });
      },
      executeNode: async (node) => {
        const key = serializePluginLocation(node.location);
        const target = graphContext.targetByPlugin.get(node.location.plugin);
        const resolvedInstallOptions = resolvedInstallOptionsByLocation.get(key);
        if (!target || !resolvedInstallOptions) {
          throw new Error(`缺少 ${node.location.platform}/${node.location.plugin} (${node.location.scope}) 的 graph install 上下文。`);
        }
        const result = await installTargetOnPlatform(
          target,
          node.location.platform,
          createScopedInstallOptions(options, node.location),
          {
            ...context,
            adapters,
            resolveInstallOptions: () => resolvedInstallOptions,
            skipConfigPreflight: true,
            skipWriteSafetyPreflight: true,
          },
          context,
          adapters,
        );
        await initializeInstalledScopeDependencyMetadata({
          location: node.location,
          cwd: options.cwd,
          requested: node.requested,
          preserveExplicit: graphContext.installedRecordByLocation.get(key)?.installSource?.explicitlyRequested === true,
          env,
        });
        return result;
      },
      commitNodeEdges: async (node) => {
        await commitInstalledScopeDependencyEdges(
          node.location,
          node.outgoingEdges,
          options.cwd,
          env,
        );
      },
      rollbackNode: async (node) => {
        const target = graphContext.targetByPlugin.get(node.location.plugin);
        if (!target) {
          throw new Error(`插件 ${node.location.plugin} 在 current catalog 中不存在，无法回滚自动依赖。`);
        }
        await uninstallTargetsOnPlatforms(
          [target],
          [node.location.platform],
          {
            ...createScopedInstallOptions(options, node.location),
            removeConfig: false,
          },
          {
            ...context,
            adapters,
          },
        );
        await ensureRollbackRemovedDependencyLocation({
          location: node.location,
          cwd: options.cwd,
          env,
        });
      },
      createRollbackFailure: (error, failures) => new Error(
        `${normalizeErrorMessage(error)}；以下自动安装依赖回滚未完全完成：${
          failures
            .map((failure: PluginDependencyWriteExecutorRollbackFailure) =>
              `${failure.node.location.platform}/${failure.node.location.scope}/${failure.node.location.plugin}: ${normalizeErrorMessage(failure.error)}`)
            .join('；')
        }`,
      ),
    });
    const aggregatedNodeResult = Object.values(graphResult.nodeResultsByLocation).reduce(
      (aggregate, next) => mergeNodeInstallResult(aggregate, next),
      {
        warnings: [],
        nativePlugins: {},
        repoManagedArtifacts: [],
      } satisfies InstallLocationNodeResult,
    );

    return {
      platforms,
      plugins: prepared.targets.map((target) => target.pluginName),
      nativePlugins: aggregatedNodeResult.nativePlugins,
      repoManagedArtifacts: aggregatedNodeResult.repoManagedArtifacts,
      marketplace: preparedForExecution.marketplace,
      receiptTargets: createInstallReceiptTargets(graphPlan, targetByPlugin),
      receiptActions: createInstallReceiptActions(graphPlan, targetByPlugin),
      warnings: [
        ...commandWarnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...aggregatedNodeResult.warnings,
      ],
    };
  } catch (error) {
    if (installPlan) {
      await cleanupOrphanedAutoDependenciesAfterFailedInstall({
        plan: installPlan,
        cwd: options.cwd,
        env,
        targetByPlugin: installPlanTargetByPlugin,
        adapters: installAdapters,
        scriptTimeoutMs: options.scriptTimeoutMs,
      }).catch(() => undefined);
    }
    throw wrapCommandErrorWithWarnings(
      error,
      withEarlyDegradedLedgerWarning(commandWarnings, prepared.ledger),
    );
  }
}
