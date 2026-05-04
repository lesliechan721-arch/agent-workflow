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
import { requiresCodexNativePlugin } from '../utils/codex-project-surface.js';
import {
  createLifecycleConfigSnapshot,
  garbageCollectLifecycleConfigSnapshots,
  runLifecycleScript,
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
  nativeWritten: boolean,
  materializationRollbackFailed: boolean,
  artifactsWritten: boolean,
  trackingWriteAttempted: boolean,
): LedgerStateReason | null {
  if (nativeWritten) {
    return 'operation_interrupted_after_native_write';
  }

  if (materializationRollbackFailed) {
    return platform === 'codex' && scope === 'project'
      ? 'operation_interrupted_after_artifact_write'
      : 'operation_interrupted_after_native_write';
  }

  return artifactsWritten || trackingWriteAttempted
    ? 'operation_interrupted_after_artifact_write'
    : null;
}

function preserveLedgerState(
  baseline: InstalledLedger,
  nextLedger: InstalledLedger,
): InstalledLedger {
  if (baseline.ledgerState.status === 'available') {
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
      let materializationCommitted = false;
      let materializationRollbackFailed = false;
      let materializationRollbackHandle: SkillTriggerMaterializationRollbackHandle | undefined;
      let runtimeSignatureBefore: SkillTriggerSignatureResult | undefined;
      let plannedRuntimeSignatureAfter: SkillTriggerSignatureResult | undefined;
      let writtenScopeIdentity: string | undefined;
      let generatedArtifacts: GeneratedArtifact[] = [];
      let materializedArtifacts: GeneratedArtifact[] = [];
      let trackedArtifacts: GeneratedArtifact[] = [];
      let lifecycleConfigSnapshot: LifecycleConfigSnapshotMetadata | undefined;

      try {
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

        const plannedNativeWrite = mayWriteNativeState(platform, target, options.scope);
        await emitCommandEvent(context, {
          type: plannedNativeWrite ? 'native:plan' : 'native:skipped',
          data: {
            platform,
            plugin: target.currentPlugin.manifest.name,
            scope: options.scope,
            reason: plannedNativeWrite ? 'plugin_requires_native_registration' : 'repo_managed_artifacts_only',
          },
        });

        if (plannedNativeWrite) {
          await adapters[platform].installPlugin(target.currentPlugin, options.scope);
        }
        nativeWritten = plannedNativeWrite;
        if (nativeWritten) {
          recordNativePlugin(nativePlugins, platform, target.currentPlugin.manifest.name);
          await emitCommandEvent(context, {
            type: 'native:applied',
            data: {
              platform,
              plugin: target.currentPlugin.manifest.name,
              scope: options.scope,
            },
          });
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

        lifecycleConfigSnapshot = await createLifecycleConfigSnapshot({
          plugin: target.currentPlugin,
          platform,
          scope: options.scope,
          cwd: options.cwd,
          env,
        });

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
              preservedArtifacts: trackedArtifacts,
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

        const nextLedger = preserveLedgerState(
          baselineLedger,
          await applyInstallLedger(
            platform,
            baselineLedger,
            target,
            options,
            resolvedInstallOptions,
          ),
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
              nativeWritten,
              materializationRollbackFailed,
              artifactsWritten,
              trackingWriteAttempted,
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
        }

        throw createRollbackFailureError(error, rollbackIssues, rollbackSurfaces);
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
  const prepared = await preparePluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env,
    },
  );
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
