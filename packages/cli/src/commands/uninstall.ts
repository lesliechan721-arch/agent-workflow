import { applyClaudeUninstallLedger } from '../adapters/claude.js';
import { applyCodexUninstallLedger } from '../adapters/codex.js';
import type {
  CommandOptions,
  InstalledLedger,
  LedgerStateReason,
  PlatformAdapter,
  PlatformName,
  PluginStatusReport,
} from '../types.js';
import {
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import { resolveClaudePaths, resolveCodexPaths } from '../utils/paths.js';
import {
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  collectCommandWarnings,
  createAdapters,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  resolveTargetPlatforms,
  type ResolvedPluginTarget,
} from './common.js';

interface CommandRuntime {
  adapters?: Record<PlatformName, PlatformAdapter>;
  env?: NodeJS.ProcessEnv;
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

async function rollbackArtifacts(
  adapter: PlatformAdapter,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
): Promise<void> {
  if (!target.currentPlugin) {
    return;
  }

  await adapter.installExtensions(target.currentPlugin, scope);
}

export async function uninstallTargetsOnPlatforms(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: CommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ warnings: string[] }> {
  const env = runtime.env ?? process.env;
  const adapters = runtime.adapters ?? createAdapters(options.cwd);
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

      let nativeWritten = false;
      let artifactsWritten = false;
      let trackingWritten = false;

      try {
        await adapters[platform].uninstallPlugin(target.plugin, options.scope);
        nativeWritten = managedEvidence || nativeFallback;

        if (managedEvidence) {
          await adapters[platform].uninstallExtensions(target.plugin, options.scope);
          artifactsWritten = true;

          await writeTrackingManifest(
            trackingDir,
            removeTrackingRecordFromManifest(baselineTracking, target.pluginName),
          );
          trackingWritten = true;

          const nextLedger = preserveLedgerState(
            baselineLedger,
            await applyUninstallLedger(platform, baselineLedger, target, options),
          );
          await writeInstalledLedger(nextLedger, env);
        }
      } catch (error) {
        if (trackingWritten) {
          try {
            await writeTrackingManifest(trackingDir, baselineTracking);
          } catch {
            // noop
          }
        }

        if (artifactsWritten) {
          try {
            await rollbackArtifacts(adapters[platform], target, options.scope);
          } catch {
            // noop
          }
        }

        if (nativeWritten || artifactsWritten || trackingWritten) {
          try {
            await writeDegradedLedger(
              baselineLedger,
              nativeWritten
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

      const postStatus = await adapters[platform].status(target.plugin, options.scope);
      for (const warning of postStatus.plugins[0]?.driftWarnings ?? []) {
        warnings.push(`[${platform}/${target.pluginName}] ${warning}`);
      }
    }
  }

  return { warnings };
}

export async function uninstallCommand(
  pluginNames: string[],
  options: CommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  if (pluginNames.length === 0) {
    throw new Error('uninstall 命令至少需要一个插件名。');
  }

  const env = runtime.env ?? process.env;
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      allowHistoricalFallback: true,
      env,
    },
  );
  const adapters = runtime.adapters ?? createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'uninstall',
    options.platform,
    options.cwd,
    options.scope,
    targets.map((target) => target.plugin),
    adapters,
  );

  const result = await uninstallTargetsOnPlatforms(targets, platforms, options, {
    adapters,
    env,
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
