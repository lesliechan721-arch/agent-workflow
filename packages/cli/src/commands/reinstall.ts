import { installCommand } from './install.js';
import { uninstallCommand } from './uninstall.js';
import { cleanupCommand, type RawCleanupCommandOptions } from './cleanup.js';
import {
  readInstallStateProjection,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import { normalizeCommandOptions, type RawInstallCommandOptions } from './options.js';
import type { PlatformName } from '../types.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/paths.js';

export interface RawReinstallCommandOptions extends RawInstallCommandOptions {}

export interface ReinstallCommandRuntime extends InstallStateRemovalRuntime {
  installCommandImpl?: typeof installCommand;
  uninstallCommandImpl?: typeof uninstallCommand;
  cleanupCommandImpl?: typeof cleanupCommand;
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

export async function reinstallCommand(
  pluginNames: string[],
  rawOptions: RawReinstallCommandOptions,
  runtime: ReinstallCommandRuntime = {},
): Promise<Awaited<ReturnType<typeof installCommand>>> {
  const options = normalizeCommandOptions(rawOptions, {
    defaultScope: 'user',
    defaultPlatform: 'auto',
  });
  if (pluginNames.length !== 1) {
    throw new Error('reinstall 命令当前只支持单个插件目标。');
  }
  if (options.platform === 'auto' || options.platform === 'both') {
    throw new Error('reinstall 命令需要显式指定单一平台。');
  }

  const platform = options.platform;
  const location = {
    plugin: pluginNames[0]!,
    platform,
    scope: options.scope,
    ...(options.scope === 'project'
      ? { projectKey: await resolveProjectKey(platform, options.cwd) }
      : {}),
  };
  const projectionState = await readInstallStateProjection({
    cwd: options.cwd,
    location,
    env: runtime.env ?? process.env,
  });

  if (projectionState.projection.kind === 'adoptable') {
    throw new Error(`${pluginNames[0]} 当前是可认领状态，reinstall 默认不会删除这些共享产物。`);
  }

  const uninstallImpl = runtime.uninstallCommandImpl ?? uninstallCommand;
  const cleanupImpl = runtime.cleanupCommandImpl ?? cleanupCommand;
  const installImpl = runtime.installCommandImpl ?? installCommand;

  if (projectionState.projection.kind === 'installed') {
    await uninstallImpl(pluginNames, rawOptions, runtime);
  } else if (projectionState.projection.kind === 'needsRepair' || projectionState.projection.kind === 'residual') {
    if (projectionState.removalProtection.blockedDependents.length > 0) {
      throw new Error(
        `${pluginNames[0]} 当前仍被其它 verified dependent 引用，reinstall 不会隐式执行 cleanup。`,
      );
    }
    if (projectionState.forceCleanupRequired) {
      throw new Error(`${pluginNames[0]} 当前需要先显式运行 aw cleanup --force，reinstall 不会隐式执行该清理。`);
    }
    if (!projectionState.removalProtection.allowed) {
      throw new Error(
        projectionState.removalProtection.failClosedReason
        ?? `${pluginNames[0]} 当前无法安全执行隐式 cleanup。`,
      );
    }
    await cleanupImpl(pluginNames, rawOptions as RawCleanupCommandOptions, runtime);
  }

  return installImpl(pluginNames, rawOptions, runtime);
}
