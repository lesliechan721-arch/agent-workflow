import { applyClaudeInstallLedger } from '../adapters/claude.js';
import { applyCodexInstallLedger } from '../adapters/codex.js';
import type {
  GeneratedArtifact,
  CommandOptions,
  InstallCommandOptions,
  InstalledLedger,
  LedgerStateReason,
  PlatformAdapter,
  PlatformName,
  ResolvedInstallOptions,
} from '../types.js';
import {
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
} from '../utils/paths.js';
import {
  getGeneratedArtifactsFromError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  buildSkillTriggerMaterializationSignature,
  collectSkillTriggerSiblingConflictWarnings,
  materializeSkillTriggerPreference,
  readCurrentSkillTriggerRuntimeSignature,
  rollbackMaterializedSkillTriggerPreference,
  type SkillTriggerMaterializationRollbackHandle,
  type SkillTriggerSignatureResult,
} from '../utils/skill-trigger-preferences.js';
import {
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  collectCommandWarnings,
  createResolvedInstallOptionsResolver,
  createAdapters,
  preparePluginTargetsForCommand,
  resolveInstallOptionsForTargets,
  resolveTargetPlatforms,
  wrapCommandErrorWithWarnings,
  type ResolvedPluginTarget,
} from './common.js';

interface CommandRuntime {
  adapters?: Record<PlatformName, PlatformAdapter>;
  env?: NodeJS.ProcessEnv;
  resolveInstallOptions?: (
    platform: PlatformName,
    target: ResolvedPluginTarget,
  ) => ResolvedInstallOptions;
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

  return platform === 'claude'
    ? applyClaudeInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd, resolvedInstallOptions)
    : applyCodexInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd, resolvedInstallOptions);
}

function mayWriteNativeState(platform: PlatformName, target: ResolvedPluginTarget): boolean {
  if (platform === 'claude') {
    return true;
  }

  const manifest = target.currentPlugin?.manifest;
  return Boolean(manifest?.skills || manifest?.mcpServers || manifest?.apps);
}

function shouldMaterializeSkillTriggers(target: ResolvedPluginTarget): boolean {
  return Boolean(target.embeddedPlugin?.manifest.skills);
}

function resolveDefaultInstallOptions(ledger: InstalledLedger): ResolvedInstallOptions {
  return {
    skillTriggerPreference: 'default',
    skillTriggerSource: 'default',
    ledgerTrust: ledger.ledgerState.status === 'available' ? 'available' : 'degraded',
  };
}

function resolveMaterializationMode(
  resolvedInstallOptions: ResolvedInstallOptions,
): 'strictExplicit' | 'bestEffortReplay' {
  return resolvedInstallOptions.skillTriggerSource === 'cli' &&
    resolvedInstallOptions.skillTriggerPreference !== 'default'
    ? 'strictExplicit'
    : 'bestEffortReplay';
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
  runtime: CommandRuntime = {},
): Promise<{ warnings: string[] }> {
  const env = runtime.env ?? process.env;
  const adapters = runtime.adapters ?? createAdapters(options.cwd, env);
  const warnings: string[] = [];

  for (const platform of platforms) {
    for (const target of targets) {
      if (!target.currentPlugin) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

      const status = await adapters[platform].status(target.currentPlugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (pluginStatus?.externalOwnership?.present) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
      }

      const baselineLedger = await readInstalledLedger(env);
      const resolvedInstallOptions =
        runtime.resolveInstallOptions?.(platform, target) ??
        resolveDefaultInstallOptions(baselineLedger);
      const trackingDir = resolveTrackingDir(options.cwd, platform, options.scope, env);
      const baselineTracking = await readTrackingManifest(trackingDir);
      const materializeSkillTriggers = shouldMaterializeSkillTriggers(target);

      let nativeWritten = false;
      let artifactsWritten = false;
      let trackingWritten = false;
      let materializationCommitted = false;
      let materializationRollbackFailed = false;
      let materializationRollbackHandle: SkillTriggerMaterializationRollbackHandle | undefined;
      let runtimeSignatureBefore: SkillTriggerSignatureResult | undefined;
      let plannedRuntimeSignatureAfter: SkillTriggerSignatureResult | undefined;
      let writtenScopeIdentity: string | undefined;
      let generatedArtifacts: GeneratedArtifact[] = [];

      try {
        if (materializeSkillTriggers) {
          const [embeddedRoot, writtenScope] = await Promise.all([
            resolveEmbeddedPluginsRoot(),
            resolveScopeIdentityForTarget(platform, options),
          ]);
          const marketplaceRoot = resolveAwHome(env);
          writtenScopeIdentity = writtenScope;

          if (
            baselineLedger.ledgerState.status === 'available' &&
            resolvedInstallOptions.ledgerTrust === 'available'
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
            resolvedOptions: resolvedInstallOptions,
            embeddedRoot,
            marketplaceRootOrStagingRoot: marketplaceRoot,
            mode: resolveMaterializationMode(resolvedInstallOptions),
          });
          materializationCommitted = materialization.committed;
          materializationRollbackHandle = materialization.rollbackHandle;
          warnings.push(...materialization.warnings);

          if (
            baselineLedger.ledgerState.status === 'available' &&
            resolvedInstallOptions.ledgerTrust === 'available'
          ) {
            plannedRuntimeSignatureAfter = await buildSkillTriggerMaterializationSignature({
              pluginName: target.pluginName,
              platform,
              preference: resolvedInstallOptions.skillTriggerPreference,
              embeddedRoot,
            });
          }
        }

        await adapters[platform].installPlugin(target.currentPlugin, options.scope);
        nativeWritten = mayWriteNativeState(platform, target);

        generatedArtifacts = await adapters[platform].installExtensions(target.currentPlugin, options.scope);
        artifactsWritten = generatedArtifacts.length > 0;

        await writeTrackingManifest(
          trackingDir,
          generatedArtifacts.length > 0
            ? upsertTrackingRecordInManifest(
                baselineTracking,
                target.currentPlugin.manifest.name,
                generatedArtifacts,
              )
            : removeTrackingRecordFromManifest(
                baselineTracking,
                target.currentPlugin.manifest.name,
              ),
        );
        trackingWritten = true;

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
        const pendingConflictWarnings: string[] = [];
        if (
          materializeSkillTriggers &&
          baselineLedger.ledgerState.status === 'available' &&
          nextLedger.ledgerState.status === 'available' &&
          resolvedInstallOptions.ledgerTrust === 'available' &&
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
        warnings.push(...pendingConflictWarnings);
      } catch (error) {
        generatedArtifacts = mergeGeneratedArtifacts(
          generatedArtifacts,
          getGeneratedArtifactsFromError(error),
        );
        artifactsWritten = artifactsWritten || generatedArtifacts.length > 0;

        if (materializationCommitted && materializationRollbackHandle) {
          try {
            await rollbackMaterializedSkillTriggerPreference(materializationRollbackHandle);
            materializationCommitted = false;
          } catch {
            materializationRollbackFailed = true;
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
          } catch {
            // noop
          }
        }

        if (trackingWritten) {
          try {
            await writeTrackingManifest(trackingDir, baselineTracking);
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

      const postStatus = await adapters[platform].status(target.currentPlugin, options.scope);
      for (const warning of postStatus.plugins[0]?.driftWarnings ?? []) {
        warnings.push(`[${platform}/${target.currentPlugin.manifest.name}] ${warning}`);
      }
    }
  }

  return { warnings };
}

export async function installCommand(
  pluginNames: string[],
  options: InstallCommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  if (pluginNames.length === 0) {
    throw new Error('install 命令至少需要一个插件名。');
  }

  const env = runtime.env ?? process.env;
  const prepared = await preparePluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      ensureLocalMarketplace: true,
      allowHistoricalFallback: false,
      env,
    },
  );
  try {
    const adapters = runtime.adapters ?? createAdapters(options.cwd, env);
    const platforms = await resolveTargetPlatforms(
      'install',
      options.platform,
      options.cwd,
      options.scope,
      prepared.targets.map((target) => target.plugin),
      adapters,
      env,
    );
    const resolvedInstallOptionsByKey = await resolveInstallOptionsForTargets(
      'install',
      prepared.targets,
      platforms,
      options,
      prepared.ledger,
    );
    const resolveInstallOptions = await createResolvedInstallOptionsResolver(
      resolvedInstallOptionsByKey,
      options.cwd,
      options.scope,
    );

    const result = await installTargetsOnPlatforms(prepared.targets, platforms, options, {
      adapters,
      env,
      resolveInstallOptions,
    });

    return {
      platforms,
      plugins: prepared.targets.map((target) => target.pluginName),
      warnings: [
        ...prepared.warnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...result.warnings,
      ],
    };
  } catch (error) {
    throw wrapCommandErrorWithWarnings(error, prepared.warnings);
  }
}
