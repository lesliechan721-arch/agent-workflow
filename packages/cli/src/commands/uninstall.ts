import path from 'node:path';

import fs from 'fs-extra';

import { applyClaudeUninstallLedger } from '../adapters/claude.js';
import { applyCodexUninstallLedger } from '../adapters/codex.js';
import {
  readClaudeSettings,
  writeClaudeSettings,
  type ClaudeSettings,
} from '../adapters/helpers.js';
import type {
  CommandOptions,
  InstalledLedger,
  InstalledScopeRecord,
  LedgerStateReason,
  PlatformName,
  PluginStatusReport,
} from '../types.js';
import {
  readCodexConfigFile,
  removeManagedDeveloperInstructionsFile,
  upsertManagedDeveloperInstructionsFile,
} from '../utils/codex-config.js';
import {
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import {
  garbageCollectLifecycleConfigSnapshots,
  runLifecycleScript,
} from '../utils/plugin-scripts.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
} from '../utils/paths.js';
import {
  commitMaterializedSkillTriggerPreference,
  rematerializeSkillTriggerPreferenceAfterUninstall,
  rollbackMaterializedSkillTriggerPreference,
  type SkillTriggerMaterializationRollbackHandle,
} from '../utils/skill-trigger-preferences.js';
import {
  getTrackingRecord,
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  collectCommandWarnings,
  createAdapters,
  filterPostCommandDriftWarnings,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  resolveTargetPlatforms,
  type ResolvedPluginTarget,
} from './common.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  normalizeCommandOptions,
  type RawCommandOptions,
} from './options.js';

type UninstallCommandRuntime = CommandExecutionContextInput & {
  skipLifecycle?: boolean;
};

interface FileRollbackState {
  path: string;
  content: string | null;
}

type ClaudePermissionState = {
  allow: string[];
  ask: string[];
  deny: string[];
};

interface ClaudePermissionsRollbackState {
  topLevelPermissions?: ClaudePermissionState;
  generatedPermissions?: ClaudePermissionState;
  manualPermissions?: ClaudePermissionState;
}

interface ArtifactRollbackState {
  files: FileRollbackState[];
  codexManagedInstructionValue?: string;
  codexHooksFile?: FileRollbackState;
  claudePermissions?: ClaudePermissionsRollbackState;
}

function resolveTrackingDir(
  cwd: string,
  platform: PlatformName,
  scope: CommandOptions['scope'],
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'claude'
    ? resolveClaudePaths(cwd, scope, env).trackingDir
    : resolveCodexPaths(cwd, scope, env).trackingDir;
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

async function applyUninstallLedger(
  platform: PlatformName,
  ledger: InstalledLedger,
  target: ResolvedPluginTarget,
  options: CommandOptions,
): Promise<InstalledLedger> {
  return platform === 'claude'
    ? applyClaudeUninstallLedger(ledger, target.pluginName, options.scope, options.cwd)
    : applyCodexUninstallLedger(ledger, target.pluginName, options.scope, options.cwd);
}

async function getScopeRecordForUninstall(
  ledger: InstalledLedger,
  platform: PlatformName,
  pluginName: string,
  options: CommandOptions,
): Promise<InstalledScopeRecord<Record<string, unknown>> | undefined> {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (options.scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  const projectKey = platform === 'claude'
    ? await resolveClaudeProjectKey(options.cwd)
    : await resolveCodexProjectKey(options.cwd);
  return platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined;
}

function shouldRefuseHistoricalUninstall(
  platform: PlatformName,
  pluginStatus: PluginStatusReport,
): string | null {
  const managed = hasScopeManagedEvidence(pluginStatus);
  const runtimeEvidence = pluginStatus.platformRuntimeEvidence?.present === true;
  const nativeFallback = pluginStatus.platformNativeFallbackEvidence?.present === true;

  if (!managed && runtimeEvidence && !nativeFallback) {
    return '当前只剩原生 loader 仍会读取该插件的证据，CLI 缺少可证明安全的受管记录；请先检查 drift，再决定是否手动清理。';
  }

  if (platform === 'codex' && !managed && nativeFallback) {
    return '当前只剩 Codex user native fallback evidence，无法证明 shared native refs 是否仍被其他 repo 引用；请显式确认后再手动清理。';
  }

  return null;
}

function didUninstallWriteNativeState(
  platform: PlatformName,
  scope: CommandOptions['scope'],
  pluginStatus: PluginStatusReport,
): boolean {
  if (platform === 'codex') {
    if (scope === 'project') {
      return false;
    }

    return pluginStatus.native.pluginInstalled;
  }

  return pluginStatus.native.pluginInstalled;
}

function shouldRematerializeSkillTriggersAfterUninstall(target: ResolvedPluginTarget): boolean {
  return target.source === 'currentCatalog' && Boolean(target.embeddedPlugin?.manifest.skills);
}

function cloneClaudePermissionState(
  permissions:
    | ClaudePermissionState
    | ClaudeSettings['permissions']
    | NonNullable<NonNullable<ClaudeSettings['awGenerated']>['permissions']>[string]
    | NonNullable<NonNullable<ClaudeSettings['awGenerated']>['manualPermissions']>
    | undefined,
): ClaudePermissionState | undefined {
  if (!permissions) {
    return undefined;
  }

  return {
    allow: [...(permissions.allow ?? [])],
    ask: [...(permissions.ask ?? [])],
    deny: [...(permissions.deny ?? [])],
  };
}

function hasClaudePermissions(
  permissions: ClaudePermissionState | undefined,
): boolean {
  return Boolean(
    (permissions?.allow.length ?? 0) > 0 ||
      (permissions?.ask.length ?? 0) > 0 ||
      (permissions?.deny.length ?? 0) > 0,
  );
}

function cleanupClaudeGeneratedPermissions(settings: ClaudeSettings): void {
  if (settings.awGenerated?.permissions && Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }

  if (
    settings.awGenerated &&
    settings.awGenerated.permissions === undefined &&
    settings.awGenerated.manualPermissions === undefined &&
    settings.awGenerated.hooks === undefined &&
    settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

async function captureTextFile(pathname: string): Promise<FileRollbackState> {
  if (!(await fs.pathExists(pathname))) {
    return {
      path: pathname,
      content: null,
    };
  }

  return {
    path: pathname,
    content: await fs.readFile(pathname, 'utf8'),
  };
}

async function restoreTextFile(snapshot: FileRollbackState): Promise<void> {
  if (snapshot.content === null) {
    await fs.remove(snapshot.path);
    return;
  }

  await fs.ensureDir(path.dirname(snapshot.path));
  await fs.writeFile(snapshot.path, snapshot.content, 'utf8');
}

async function captureArtifactRollbackState(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ArtifactRollbackState> {
  if (platform === 'codex') {
    const paths = resolveCodexPaths(cwd, scope, env);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, target.pluginName);
    const { snapshot } = await readCodexConfigFile(paths.configTomlPath);

    return {
      files: await Promise.all(
        (trackingRecord?.artifacts ?? [])
          .filter((artifact) => artifact.kind === 'permission' || artifact.kind === 'agent')
          .map((artifact) => captureTextFile(artifact.path)),
      ),
      codexManagedInstructionValue:
        snapshot.developerInstructions.managedBlocks[target.pluginName]?.value,
      codexHooksFile: await captureTextFile(paths.hooksPath),
    };
  }

  const paths = resolveClaudePaths(cwd, scope, env);
  const trackingManifest = await readTrackingManifest(paths.trackingDir);
  const trackingRecord = getTrackingRecord(trackingManifest, target.pluginName);
  const settings = await readClaudeSettings(paths.settingsPath);

  return {
    files: await Promise.all(
      (trackingRecord?.artifacts ?? [])
        .filter((artifact) => artifact.kind === 'instruction')
        .map((artifact) => captureTextFile(artifact.path)),
    ),
    claudePermissions: {
      topLevelPermissions: cloneClaudePermissionState(settings.permissions),
      generatedPermissions: cloneClaudePermissionState(
        settings.awGenerated?.permissions?.[target.pluginName],
      ),
      manualPermissions: cloneClaudePermissionState(settings.awGenerated?.manualPermissions),
    },
  };
}

async function rollbackArtifacts(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
  cwd: string,
  env: NodeJS.ProcessEnv,
  rollbackState: ArtifactRollbackState,
): Promise<void> {
  await Promise.all(rollbackState.files.map((snapshot) => restoreTextFile(snapshot)));

  if (platform === 'codex') {
    const paths = resolveCodexPaths(cwd, scope, env);
    if (rollbackState.codexManagedInstructionValue !== undefined) {
      await upsertManagedDeveloperInstructionsFile(paths.configTomlPath, {
        pluginName: target.pluginName,
        value: rollbackState.codexManagedInstructionValue,
      });
    } else {
      await removeManagedDeveloperInstructionsFile(paths.configTomlPath, target.pluginName);
    }

    if (rollbackState.codexHooksFile) {
      await restoreTextFile(rollbackState.codexHooksFile);
    }

    return;
  }

  if (!rollbackState.claudePermissions) {
    return;
  }

  const paths = resolveClaudePaths(cwd, scope, env);
  const settings = await readClaudeSettings(paths.settingsPath);

  if (hasClaudePermissions(rollbackState.claudePermissions.topLevelPermissions)) {
    settings.permissions = cloneClaudePermissionState(
      rollbackState.claudePermissions.topLevelPermissions,
    );
  } else {
    delete settings.permissions;
  }

  if (hasClaudePermissions(rollbackState.claudePermissions.generatedPermissions)) {
    settings.awGenerated ??= {};
    settings.awGenerated.permissions ??= {};
    settings.awGenerated.permissions[target.pluginName] = cloneClaudePermissionState(
      rollbackState.claudePermissions.generatedPermissions,
    ) ?? { allow: [], ask: [], deny: [] };
  } else if (settings.awGenerated?.permissions) {
    delete settings.awGenerated.permissions[target.pluginName];
  }

  if (hasClaudePermissions(rollbackState.claudePermissions.manualPermissions)) {
    settings.awGenerated ??= {};
    settings.awGenerated.manualPermissions = cloneClaudePermissionState(
      rollbackState.claudePermissions.manualPermissions,
    );
  } else if (settings.awGenerated) {
    delete settings.awGenerated.manualPermissions;
  }

  cleanupClaudeGeneratedPermissions(settings);
  await writeClaudeSettings(paths.settingsPath, settings);
}

export async function uninstallTargetsOnPlatforms(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: CommandOptions,
  runtime: UninstallCommandRuntime = {},
): Promise<{ warnings: string[] }> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const warnings: string[] = [];

  for (const platform of platforms) {
    for (const target of targets) {
      const status = await adapters[platform].status(target.plugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (!pluginStatus) {
        continue;
      }

      if (pluginStatus.externalOwnership?.present) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
      }

      const managedEvidence = hasScopeManagedEvidence(pluginStatus);
      const historicalEvidence = hasHistoricalEvidence(pluginStatus);
      if (target.source === 'historical' && !historicalEvidence) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

      const refusal = shouldRefuseHistoricalUninstall(platform, pluginStatus);
      if (refusal) {
        throw new Error(refusal);
      }

      const nativeFallback = pluginStatus.platformNativeFallbackEvidence?.present === true;
      if (!managedEvidence && !nativeFallback) {
        warnings.push(`[${platform}/${target.pluginName}] 当前 scope 未受管，无需卸载。`);
        continue;
      }

      const baselineLedger = await readInstalledLedger(env);
      const trackingDir = resolveTrackingDir(options.cwd, platform, options.scope, env);
      const baselineTracking = await readTrackingManifest(trackingDir);
      const rollbackState = managedEvidence
        ? await captureArtifactRollbackState(platform, target, options.scope, options.cwd, env)
        : undefined;

      let nativeWritten = false;
      let artifactsWritten = false;
      let trackingWritten = false;
      let materializationCommitted = false;
      let materializationRollbackFailed = false;
      let materializationRollbackHandle: SkillTriggerMaterializationRollbackHandle | undefined;

      try {
        if (!runtime.skipLifecycle) {
          await runLifecycleScript({
            event: 'uninstall',
            pluginName: target.pluginName,
            platform,
            scope: options.scope,
            cwd: options.cwd,
            context,
            scopeRecord: await getScopeRecordForUninstall(
              baselineLedger,
              platform,
              target.pluginName,
              options,
            ),
            currentPlugin: target.currentPlugin,
            scriptTimeoutMs: options.scriptTimeoutMs,
          });
        }

        await adapters[platform].uninstallPlugin(target.plugin, options.scope);
        nativeWritten = didUninstallWriteNativeState(platform, options.scope, pluginStatus);

        if (managedEvidence) {
          artifactsWritten = true;
          await adapters[platform].uninstallExtensions(target.plugin, options.scope);

          await writeTrackingManifest(
            trackingDir,
            removeTrackingRecordFromManifest(baselineTracking, target.pluginName),
          );
          trackingWritten = true;

          const nextLedger = preserveLedgerState(
            baselineLedger,
            await applyUninstallLedger(platform, baselineLedger, target, options),
          );
          if (shouldRematerializeSkillTriggersAfterUninstall(target)) {
            const rematerialization = await rematerializeSkillTriggerPreferenceAfterUninstall({
              pluginName: target.pluginName,
              platform,
              ledgerAfterUninstall: nextLedger,
              embeddedRoot: await resolveEmbeddedPluginsRoot(),
              marketplaceRoot: resolveAwHome(env),
            });
            warnings.push(...rematerialization.warnings);
            materializationCommitted = rematerialization.materialization?.committed === true;
            materializationRollbackHandle = rematerialization.materialization?.rollbackHandle;
          }
          await writeInstalledLedger(nextLedger, env);
          await garbageCollectLifecycleConfigSnapshots({ ledger: nextLedger, env });
        }
      } catch (error) {
        if (materializationCommitted && materializationRollbackHandle) {
          try {
            await rollbackMaterializedSkillTriggerPreference(materializationRollbackHandle);
            materializationCommitted = false;
          } catch {
            materializationRollbackFailed = true;
          }
        }

        if (trackingWritten) {
          try {
            await writeTrackingManifest(trackingDir, baselineTracking);
          } catch {
            // noop
          }
        }

        if (artifactsWritten) {
          try {
            if (rollbackState) {
              await rollbackArtifacts(
                platform,
                target,
                options.scope,
                options.cwd,
                env,
                rollbackState,
              );
            }
          } catch {
            // noop
          }
        }

        if (nativeWritten || materializationRollbackFailed || artifactsWritten || trackingWritten) {
          try {
            await writeDegradedLedger(
              baselineLedger,
              nativeWritten || materializationRollbackFailed
                ? 'operation_interrupted_after_native_write'
                : 'operation_interrupted_after_artifact_write',
              env,
            );
          } catch (ledgerError) {
            const detail = ledgerError instanceof Error ? ledgerError.message : String(ledgerError);
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}；此外，无法把 installed.json 标记为 degraded：${detail}`,
            );
          }
        }

        throw error;
      }

      if (materializationRollbackHandle) {
        try {
          await commitMaterializedSkillTriggerPreference(materializationRollbackHandle);
          materializationCommitted = false;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`[${platform}/${target.pluginName}] skill trigger 备份目录清理失败：${detail}`);
        }
      }

      const postStatus = await adapters[platform].status(target.plugin, options.scope);
      const drift = filterPostCommandDriftWarnings(postStatus.plugins[0]?.driftWarnings ?? []);
      for (const warning of drift.visible) {
        warnings.push(`[${platform}/${target.pluginName}] ${warning}`);
      }
      if (drift.diagnostics.length > 0) {
        await emitCommandEvent(context, {
          type: 'drift:suppressed',
          data: {
            platform,
            plugin: target.pluginName,
            warnings: drift.diagnostics,
          },
        });
      }
    }
  }

  return { warnings };
}

export async function uninstallCommand(
  pluginNames: string[],
  rawOptions: RawCommandOptions,
  runtime: UninstallCommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  const options = normalizeCommandOptions(rawOptions, {
    defaultScope: 'user',
    defaultPlatform: 'auto',
  });
  if (pluginNames.length === 0) {
    throw new Error('uninstall 命令至少需要一个插件名。非交互模式下请运行 `aw uninstall <插件名>`。');
  }

  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      allowHistoricalFallback: true,
      env,
    },
  );
  await emitCommandEvent(context, {
    type: 'catalog:resolved',
    data: {
      plugins: targets.map((target) => ({
        name: target.pluginName,
        source: target.source,
        current: Boolean(target.currentPlugin),
      })),
    },
  });
  const adapters = createAdapters(options.cwd, context);
  const platforms = await resolveTargetPlatforms(
    'uninstall',
    options.platform,
    options.cwd,
    options.scope,
    targets.map((target) => target.plugin),
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

  const result = await uninstallTargetsOnPlatforms(targets, platforms, options, {
    ...context,
    adapters,
  });

  return {
    platforms,
    plugins: targets.map((target) => target.pluginName),
    warnings: [
      ...collectCommandWarnings(platforms, options.scope),
      ...result.warnings,
    ],
  };
}
