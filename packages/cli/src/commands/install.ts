import { applyClaudeInstallLedger } from '../adapters/claude.js';
import { applyCodexInstallLedger } from '../adapters/codex.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  InstalledLedger,
  LedgerStateReason,
  PlatformAdapter,
  PlatformName,
} from '../types.js';
import {
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import { resolveClaudePaths, resolveCodexPaths } from '../utils/paths.js';
import {
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  collectCommandWarnings,
  createAdapters,
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

async function applyInstallLedger(
  platform: PlatformName,
  ledger: InstalledLedger,
  target: ResolvedPluginTarget,
  options: CommandOptions,
): Promise<InstalledLedger> {
  if (!target.currentPlugin) {
    throw new Error(`Unknown plugin "${target.pluginName}".`);
  }

  return platform === 'claude'
    ? applyClaudeInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd)
    : applyCodexInstallLedger(ledger, target.currentPlugin, options.scope, options.cwd);
}

function mayWriteNativeState(platform: PlatformName, target: ResolvedPluginTarget): boolean {
  if (platform === 'claude') {
    return true;
  }

  const manifest = target.currentPlugin?.manifest;
  return Boolean(manifest?.skills || manifest?.mcpServers || manifest?.apps);
}

async function rollbackArtifacts(
  adapter: PlatformAdapter,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
): Promise<void> {
  if (!target.currentPlugin) {
    return;
  }

  await adapter.uninstallExtensions(target.currentPlugin, scope);
}

export async function installTargetsOnPlatforms(
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
      if (!target.currentPlugin) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

      const status = await adapters[platform].status(target.currentPlugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (pluginStatus?.externalOwnership?.present) {
        throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
      }

      const baselineLedger = await readInstalledLedger(env);
      const trackingDir = resolveTrackingDir(options.cwd, platform, options.scope, env);
      const baselineTracking = await readTrackingManifest(trackingDir);

      let nativeWritten = false;
      let artifactsWritten = false;
      let trackingWritten = false;
      let generatedArtifacts: GeneratedArtifact[] = [];

      try {
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
          await applyInstallLedger(platform, baselineLedger, target, options),
        );
        await writeInstalledLedger(nextLedger, env);
      } catch (error) {
        if (artifactsWritten) {
          try {
            await rollbackArtifacts(adapters[platform], target, options.scope);
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
  options: CommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  if (pluginNames.length === 0) {
    throw new Error('install 命令至少需要一个插件名。');
  }

  const env = runtime.env ?? process.env;
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      ensureLocalMarketplace: true,
      allowHistoricalFallback: false,
      env,
    },
  );
  const adapters = runtime.adapters ?? createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'install',
    options.platform,
    options.cwd,
    options.scope,
    targets.map((target) => target.plugin),
    adapters,
  );

  const result = await installTargetsOnPlatforms(targets, platforms, options, {
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
