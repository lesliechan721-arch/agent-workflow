import type {
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  UpgradeCommandOptions,
} from '../types.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import {
  normalizeCleanupCommandOptions,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUninstallCommandOptions,
  normalizeUpgradeCommandOptions,
  type RawCleanupCommandOptions,
  type RawInstallCommandOptions,
  type RawReinstallCommandOptions,
  type RawUninstallCommandOptions,
  type RawUpgradeCommandOptions,
} from './options.js';
import {
  type RebuildCommandResult,
  type RebuildCommandRuntime,
} from './rebuild-command.js';

const RUNTIME_TRANSITION_MESSAGE =
  'runtimeTransitionIncomplete: write commands require the phase 3B namespaced runtime.';

export function runtimeTransitionResult(
  pluginNames: string[],
  options: Pick<CommandOptions, 'platform' | 'scope'>,
): RebuildCommandResult {
  const platforms: PlatformName[] = options.platform === 'both'
    ? ['codex', 'claude']
    : [options.platform];
  const receiptTargets = pluginNames.flatMap((requestedPlugin) => {
    let pluginName = requestedPlugin;
    let sourceId: string | undefined;
    let pluginId: string | undefined;
    try {
      const parsed = parsePluginId(requestedPlugin);
      pluginName = parsed.pluginName;
      sourceId = parsed.sourceId;
      if (sourceId !== undefined) pluginId = requestedPlugin;
    } catch {
      // Preserve the explicit token without resolving catalog state.
    }
    return platforms.map((platform) => ({
      pluginName,
      ...(sourceId ? { sourceId } : {}),
      ...(pluginId ? { pluginId } : {}),
      platform,
      scope: options.scope,
    }));
  });
  return {
    platforms,
    plugins: pluginNames,
    warnings: [RUNTIME_TRANSITION_MESSAGE],
    rebuildResults: [],
    targetResults: [],
    overallState: 'failed',
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets,
  };
}

function requirePluginNames(command: string, pluginNames: string[], exact = false): void {
  if ((exact && pluginNames.length !== 1) || (!exact && pluginNames.length === 0)) {
    throw new Error(`${command} 命令${exact ? '需要且只接受一个' : '至少需要一个'}插件名。`);
  }
}

export async function installWriteCommand(
  pluginNames: string[],
  rawOptions: RawInstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('install', pluginNames);
  const commandOptions: InstallCommandOptions = normalizeInstallCommandOptions(rawOptions);
  void commandOptions;
  void runtime;
  return runtimeTransitionResult(pluginNames, commandOptions);
}

export async function upgradeWriteCommand(
  pluginNames: string[],
  rawOptions: RawUpgradeCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  const commandOptions: UpgradeCommandOptions = normalizeUpgradeCommandOptions(rawOptions);
  if (!commandOptions.all) requirePluginNames('upgrade', pluginNames);
  void runtime;
  return runtimeTransitionResult(pluginNames, commandOptions);
}

export async function reinstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('reinstall', pluginNames, true);
  const commandOptions = normalizeReinstallCommandOptions(rawOptions);
  void commandOptions;
  void runtime;
  return runtimeTransitionResult(pluginNames, commandOptions);
}

export async function uninstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawUninstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('uninstall', pluginNames);
  const commandOptions = normalizeUninstallCommandOptions(rawOptions);
  void commandOptions;
  void runtime;
  return runtimeTransitionResult(pluginNames, commandOptions);
}

export async function cleanupWriteCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('cleanup', pluginNames, true);
  const commandOptions = normalizeCleanupCommandOptions(rawOptions);
  void commandOptions;
  void runtime;
  return runtimeTransitionResult(pluginNames, commandOptions);
}
