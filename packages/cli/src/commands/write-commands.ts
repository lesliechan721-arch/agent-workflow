import type {
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
  runRebuildCommand,
  type RebuildCommandResult,
  type RebuildCommandRuntime,
} from './rebuild-command.js';

function writeErrorCode(message: string): string {
  for (const code of [
    'legacyStateUnsupported',
    'sourceChanged',
    'sourceMissing',
    'artifactCollision',
    'dependencyNotReady',
    'dependencyScopeTooNarrow',
    'dependencyScopeConflict',
    'dependencyTargetUnsupported',
    'dependencyInstallFailed',
    'dependencyPlanStale',
    'dependencyContractMissing',
    'dependencyContractInvalid',
  ]) {
    if (message.includes(code)) return code;
  }
  if (message.startsWith('Cannot resolve required catalog sources:')) {
    return 'catalogSourceUnavailable';
  }
  const prefix = message.split(':', 1)[0];
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'writeFailed';
}

function failedWriteCommandResult(
  command: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup',
  pluginNames: string[],
  options: InstallCommandOptions,
  error: unknown,
): RebuildCommandResult {
  const message = error instanceof Error ? error.message : String(error);
  const namespacedTargets = (error as {
    namespacedTargets?: Array<{
      pluginId: string;
      pluginName: string;
      sourceId: string;
      sourceIdentity: string;
      platform?: PlatformName;
      scope?: InstallCommandOptions['scope'];
      pluginVersion?: string;
    }>;
  }).namespacedTargets ?? [];
  const legacyTargets = (error as {
    legacyTargets?: Array<{
      pluginName: string;
      platform: PlatformName;
      scope: InstallCommandOptions['scope'];
    }>;
  }).legacyTargets ?? [];
  const platforms: PlatformName[] = options.platform === 'both'
    ? ['codex', 'claude']
    : [options.platform];
  const requested = pluginNames.length > 0 ? pluginNames : [];
  const explicitFailureTargets = [
    ...namespacedTargets.map((target) => ({ selector: target.pluginId, target })),
    ...legacyTargets.map((target) => ({ selector: target.pluginName, target })),
  ];
  const failedTargets = explicitFailureTargets.length > 0
    ? explicitFailureTargets
    : requested.map((selector) => ({ selector, target: undefined }));
  const rebuildResults = failedTargets.flatMap(({ selector, target: exactTarget }) => {
    let pluginName = selector;
    let sourceId: string | undefined;
    let pluginId: string | undefined;
    try {
      const parsed = parsePluginId(selector);
      pluginName = parsed.pluginName;
      sourceId = parsed.sourceId;
      pluginId = parsed.sourceId ? selector : undefined;
    } catch {
      // Keep the original selector in the failure receipt.
    }
    const resolvedTarget = exactTarget ?? namespacedTargets.find((target) =>
      target.pluginId === selector
      || (sourceId === undefined && target.pluginName === pluginName));
    if (resolvedTarget) {
      pluginName = resolvedTarget.pluginName;
      sourceId = 'sourceId' in resolvedTarget ? resolvedTarget.sourceId : undefined;
      pluginId = 'pluginId' in resolvedTarget ? resolvedTarget.pluginId : undefined;
    }
    const targetPlatforms = resolvedTarget?.platform ? [resolvedTarget.platform] : platforms;
    return targetPlatforms.map((platform) => ({
      status: 'failed' as const,
      command,
      target: {
        pluginName,
        pluginVersion: resolvedTarget && 'pluginVersion' in resolvedTarget
          ? resolvedTarget.pluginVersion ?? 'unavailable'
          : 'unavailable',
        ...(sourceId ? {
          sourceId,
          pluginId,
          ...(resolvedTarget && 'sourceIdentity' in resolvedTarget
            ? { sourceIdentity: resolvedTarget.sourceIdentity }
            : {}),
        } : {}),
        platform,
        scope: resolvedTarget?.scope ?? options.scope,
        cwd: options.cwd,
      },
      actions: [],
      cleanupAttempted: false,
      removed: [],
      absent: [],
      residual: [],
      quarantined: [],
      failures: [{ phase: 'preflight' as const, message }],
      error: { phase: 'preflight' as const, message },
    }));
  });
  return {
    platforms: [...new Set(rebuildResults.map((result) => result.target.platform))],
    plugins: [],
    warnings: [],
    rebuildResults,
    targetResults: rebuildResults.map((result) => ({
      target: result.target,
      action: command,
      state: 'failed',
      message,
      errorCode: writeErrorCode(message),
    })),
    overallState: 'failed',
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: rebuildResults.map((result) => result.target),
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
  return runRebuildCommand({ command: 'install', pluginNames, commandOptions, runtime })
    .catch((error) => failedWriteCommandResult('install', pluginNames, commandOptions, error));
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
  }).catch((error) => failedWriteCommandResult('upgrade', pluginNames, commandOptions, error));
}

export async function reinstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('reinstall', pluginNames, true);
  const commandOptions = normalizeReinstallCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'reinstall', pluginNames, commandOptions, runtime })
    .catch((error) => failedWriteCommandResult('reinstall', pluginNames, commandOptions, error));
}

export async function uninstallWriteCommand(
  pluginNames: string[],
  rawOptions: RawUninstallCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('uninstall', pluginNames);
  const commandOptions = normalizeUninstallCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'uninstall', pluginNames, commandOptions, runtime })
    .catch((error) => failedWriteCommandResult('uninstall', pluginNames, commandOptions, error));
}

export async function cleanupWriteCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  requirePluginNames('cleanup', pluginNames, true);
  const commandOptions = normalizeCleanupCommandOptions(rawOptions);
  return runRebuildCommand({ command: 'cleanup', pluginNames, commandOptions, runtime })
    .catch((error) => failedWriteCommandResult('cleanup', pluginNames, commandOptions, error));
}
