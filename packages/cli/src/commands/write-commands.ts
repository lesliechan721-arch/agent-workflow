import type { InstallCommandOptions, UpgradeCommandOptions } from '../types.js';
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
  runRebuildCommand,
  type RebuildCommandResult,
  type RebuildCommandRuntime,
} from './rebuild-command.js';

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
  return runRebuildCommand({ command: 'install', pluginNames, commandOptions, runtime });
}

export async function upgradeWriteCommand(
  pluginNames: string[],
  rawOptions: RawUpgradeCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  const commandOptions: UpgradeCommandOptions = normalizeUpgradeCommandOptions(rawOptions);
  if (!commandOptions.all) requirePluginNames('upgrade', pluginNames);
  return runRebuildCommand({
    command: 'upgrade',
    pluginNames,
    commandOptions,
    runtime,
    all: commandOptions.all,
  });
}

export async function reinstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('reinstall', pluginNames, true);
  const commandOptions = normalizeReinstallCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'reinstall', pluginNames, commandOptions, runtime });
}

export async function uninstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawUninstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('uninstall', pluginNames);
  const commandOptions = normalizeUninstallCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'uninstall', pluginNames, commandOptions, runtime });
}

export async function cleanupWriteCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('cleanup', pluginNames, true);
  const commandOptions = normalizeCleanupCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'cleanup', pluginNames, commandOptions, runtime });
}
