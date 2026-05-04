import path from 'node:path';

import fs from 'fs-extra';

import { applyClaudeInstallLedger } from '../adapters/claude.js';
import {
  applyCodexInstallLedger,
  pruneCodexTrackedArtifacts,
} from '../adapters/codex.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  InstallCommandOptions,
  InstalledLedger,
  InstalledScopeRecord,
  LedgerStateReason,
  LifecycleConfigSnapshotMetadata,
  NativeRecoveryState,
  NativePluginsByPlatform,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  ResolvedInstallOptions,
  TrackingManifest,
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
  getGeneratedArtifactIdentityKey,
  getGeneratedArtifactsFromError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  getCodexProjectManagedKinds,
  requiresCodexNativePlugin,
} from '../utils/codex-project-surface.js';
import {
  garbageCollectLifecycleConfigSnapshots,
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
  captureArtifactRollbackState,
  collectArtifactRollbackSurfaceHints as collectTrackedArtifactRollbackSurfaceHints,
  disposeArtifactRollbackState,
  rollbackArtifacts as restoreTrackedArtifactRollbackState,
  type ArtifactRollbackState,
} from './uninstall.js';
import {
  collectCommandWarnings,
  createResolvedInstallOptionsResolver,
  createAdapters,
  assertPluginsSupportPlatforms,
  filterPostCommandDriftWarnings,
  prepareCommandEnvironment,
  preparePluginTargetsForCommand,
  requiresRuntimeWritableMarketplaceForTargets,
  resolveInstallOptionsForTargets,
  resolveTargetPlatforms,
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
  normalizeInstallCommandOptions,
  type RawInstallCommandOptions,
} from './options.js';
import { assertCodexProjectInstallableTargets } from './codex-project-installability.js';
import { preflightCodexProjectWriteSafety } from './codex-project-safety.js';

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
  const desiredKeys = new Set(desiredArtifacts.map((artifact) => getGeneratedArtifactIdentityKey(artifact)));
  return previousArtifacts.filter((artifact) => !desiredKeys.has(getGeneratedArtifactIdentityKey(artifact)));
}

async function restoreUpgradeRollbackBaseline(
  baseline: UpgradeRollbackBaseline,
  platform: PlatformName,
  target: ResolvedPluginTarget,
  options: CommandOptions,
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
      `Codex 原生插件 ${pluginName}@aw 已写入，但 AW 没有持久化恢复证据：${detail}。当前不能承诺后续 repair / uninstall 一定具备自动授权；请运行 \`aw status --verbose\` 查看 breadcrumb、config 和 cache 诊断。`,
    );
  }

  return new Error(
    `Codex 原生插件 ${pluginName}@aw 已写入，但 AW 安装未完成：${detail}。请运行 \`aw status --verbose\` 查看 breadcrumb、config 和 cache 诊断，必要时再运行 \`aw uninstall ${pluginName} -p codex -s user\` 清理残留。`,
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
      if (!target.currentPlugin) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

      const status = await adapters[platform].status(target.currentPlugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (
        pluginStatus?.externalOwnership?.present &&
        !(platform === 'codex' && options.scope === 'project')
      ) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
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
      const isCodexProjectUpgrade =
        operation === 'upgrade' &&
        platform === 'codex' &&
        options.scope === 'project';
      const upgradeRollbackBaselineKey = createUpgradeRollbackBaselineKey(
        platform,
        target.pluginName,
      );
      const hasProvidedUpgradeRollbackBaseline =
        runtime.upgradeRollbackBaselines?.has(upgradeRollbackBaselineKey) === true;
      const upgradeRollbackBaseline = isCodexProjectUpgrade
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
      const materializationPreference = resolveMaterializationPreference(resolvedInstallOptions);

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
      const recoveryFailureStage = {
        snapshotPersisted: false,
        lifecycleStarted: false,
        trackingWriteAttempted: false,
        ledgerWriteAttempted: false,
      };

      try {
        preparedLifecycleConfigSnapshot = await prepareLifecycleConfigSnapshot({
          plugin: target.currentPlugin,
          platform,
          scope: options.scope,
          cwd: options.cwd,
          env,
        });

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

        if (plannedNativeWrite) {
          await adapters[platform].installPlugin(target.currentPlugin, options.scope);
        }
        nativeWritten = plannedNativeWrite;
        if (nativeWritten) {
          recordNativePlugin(nativePlugins, platform, target.currentPlugin.manifest.name);
          if (isCodexUserNativeInstall(platform, target, options.scope)) {
            recoveryBreadcrumbPersisted = Boolean(
              await readCodexNativeRecoveryBreadcrumb(target.currentPlugin.manifest.name, env),
            );
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
        generatedArtifacts = await adapters[platform].installExtensions(target.currentPlugin, options.scope);
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

        if (isCodexProjectUpgrade) {
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
          if (staleArtifacts.length > 0) {
            await pruneCodexTrackedArtifacts({
              cwd: options.cwd,
              scope: options.scope,
              env,
              pluginName: target.currentPlugin.manifest.name,
              artifacts: staleArtifacts,
            });
            await emitCommandEvent(context, {
              type: 'artifacts:pruned',
              data: {
                platform,
                plugin: target.currentPlugin.manifest.name,
                scope: options.scope,
                staleArtifacts: staleArtifacts.map((artifact) => ({
                  kind: artifact.kind,
                  path: artifact.path,
                  ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
                })),
              },
            });
          }
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
        await writeInstalledLedger(nextLedger, env);
        ledgerWritten = true;
        await emitCommandEvent(context, {
          type: 'ledger:written',
          data: {
            platform,
            plugin: target.currentPlugin.manifest.name,
            scope: options.scope,
            ledgerState: nextLedger.ledgerState.status,
          },
        });
        warnings.push(...pendingConflictWarnings);
        if (operation === 'upgrade') {
          await garbageCollectLifecycleConfigSnapshots({ ledger: nextLedger, env });
        }
      } catch (error) {
        if (error instanceof PostInstallCleanupError && error.skipRollback) {
          throw error;
        }

        if (
          nativeWritten &&
          recoveryBreadcrumbPersisted &&
          isCodexUserNativeInstall(platform, target, options.scope)
        ) {
          const preparedMetadata = preparedLifecycleConfigSnapshot?.metadata;
          const recoveryFailure = createRecoveryBreadcrumbFailureReason(recoveryFailureStage);
          await updateCodexRecoveryBreadcrumbWithEvent(context, {
            pluginName: target.currentPlugin.manifest.name,
            scope: options.scope,
            state: recoveryFailure.state,
            reason: recoveryFailure.reason,
            pluginVersion: lifecycleConfigSnapshot?.pluginVersion ?? preparedMetadata?.pluginVersion ?? null,
            bundleFingerprint: lifecycleConfigSnapshot?.bundleFingerprint ?? preparedMetadata?.bundleFingerprint ?? null,
            lastError: normalizeErrorMessage(error),
            env,
          }).catch(() => undefined);
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
            await rollbackArtifacts(
              adapters[platform],
              target,
              options.scope,
              generatedArtifacts,
            );
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
            hasProvidedUpgradeRollbackBaseline ||
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

      if (
        nativeWritten &&
        recoveryBreadcrumbPersisted &&
        isCodexUserNativeInstall(platform, target, options.scope)
      ) {
        try {
          await deleteCodexRecoveryBreadcrumbWithEvent(context, {
            pluginName: target.currentPlugin.manifest.name,
            scope: options.scope,
            state: 'pending_after_native_write',
            env,
          });
        } catch (error) {
          await updateCodexRecoveryBreadcrumbWithEvent(context, {
            pluginName: target.currentPlugin.manifest.name,
            scope: options.scope,
            state: 'cleanup_failed',
            reason: 'install_breadcrumb_delete_failed',
            lastError: normalizeErrorMessage(error),
            env,
          }).catch(() => undefined);
          throw new PostInstallCleanupError(
            `插件 ${target.currentPlugin.manifest.name} 已安装成功，但删除 Codex native recovery breadcrumb 失败：${normalizeErrorMessage(error)}。请运行 \`aw status --verbose\` 检查并手动重试清理恢复标记。`,
          );
        }
      }
    }
  }

  return { warnings, nativePlugins, repoManagedArtifacts };
}

export async function installCommand(
  pluginNames: string[],
  rawOptions: RawInstallCommandOptions,
  runtime: InstallCommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[]; nativePlugins: NativePluginsByPlatform; repoManagedArtifacts: GeneratedArtifact[]; marketplace?: PreparedMarketplaceState }> {
  const options = normalizeInstallCommandOptions(rawOptions);
  if (pluginNames.length === 0) {
    throw new Error('install 命令至少需要一个插件名。非交互模式下请运行 `aw install <插件名>`。');
  }

  const context = createCommandExecutionContext(runtime);
  const env = context.env;
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
        const breadcrumb = await readCodexNativeRecoveryBreadcrumb(missingPluginName, env);
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
  try {
    const adapters = createAdapters(options.cwd, context);
    const platforms = await resolveTargetPlatforms(
      'install',
      options.platform,
      options.cwd,
      options.scope,
      prepared.targets.map((target) => target.plugin),
      adapters,
      env,
    );
    await emitCommandEvent(context, {
      type: 'platform:resolved',
      data: {
        requestedPlatform: options.platform,
        platforms,
        scope: options.scope,
      },
    });
    assertCodexProjectInstallableTargets(prepared.targets, platforms, options.scope);
    await preflightCodexProjectWriteSafety({
      targets: prepared.targets,
      platforms,
      cwd: options.cwd,
      scope: options.scope,
      env,
      operation: 'install',
    });
    await preflightInstallConfigs(prepared.targets, options, context);
    const runtimeWritableMarketplace = requiresRuntimeWritableMarketplaceForTargets(
      platforms,
      prepared.targets,
      options.scope,
    );
    const preparedForExecution = await prepareCommandEnvironment({
      catalogMode: runtimeWritableMarketplace ? 'runtimeWritable' : 'readOnly',
      env,
    });
    commandWarnings = [
      ...prepared.warnings,
      ...preparedForExecution.warnings,
    ];
    const resolvedInstallOptionsByKey = await resolveInstallOptionsForTargets(
      'install',
      prepared.targets,
      platforms,
      {
        ...options,
        env,
      },
      preparedForExecution.ledger,
    );
    await emitCommandEvent(context, {
      type: 'skill-trigger:resolved',
      data: {
        entries: [...resolvedInstallOptionsByKey.entries()].map(([key, value]) => ({
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
    const resolveInstallOptions = await createResolvedInstallOptionsResolver(
      resolvedInstallOptionsByKey,
      options.cwd,
      options.scope,
    );

    const result = await installTargetsOnPlatforms(prepared.targets, platforms, options, {
      ...context,
      adapters,
      resolveInstallOptions,
      skipConfigPreflight: true,
      skipWriteSafetyPreflight: true,
    });

    return {
      platforms,
      plugins: prepared.targets.map((target) => target.pluginName),
      nativePlugins: result.nativePlugins,
      repoManagedArtifacts: result.repoManagedArtifacts,
      marketplace: preparedForExecution.marketplace,
      warnings: [
        ...commandWarnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...result.warnings,
      ],
    };
  } catch (error) {
    throw wrapCommandErrorWithWarnings(error, commandWarnings);
  }
}
