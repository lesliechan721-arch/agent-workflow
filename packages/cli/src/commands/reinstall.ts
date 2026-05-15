import { installCommand } from './install.js';
import { uninstallCommand } from './uninstall.js';
import { cleanupCommand } from './cleanup.js';
import {
  createAdapters,
  loadPluginTargetsForCommand,
  resolveCurrentCatalogWriteTargetPairs,
} from './common.js';
import {
  readInstallStateProjection,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import {
  normalizeReinstallCommandOptions,
  type RawCleanupCommandOptions,
  type RawReinstallCommandOptions,
} from './options.js';
import { assertNoDuplicateInstall } from './scope-exclusivity-preflight.js';
import type { PlatformName, PluginLocation } from '../types.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/paths.js';

function renderReinstallLocation(location: PluginLocation): string {
  return location.scope === 'project'
    ? `${location.platform}/${location.plugin}/project:${location.projectKey ?? '(missing-project-key)'}`
    : `${location.platform}/${location.plugin}/user`;
}

async function preflightReinstallLocation(options: {
  pluginName: string;
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Awaited<ReturnType<typeof readInstallStateProjection>>> {
  await assertNoDuplicateInstall({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const projectionState = await readInstallStateProjection({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });

  if (projectionState.projection.kind === 'adoptable') {
    throw new Error(`${options.pluginName} 当前是可认领状态，reinstall 默认不会删除这些共享产物。`);
  }
  if (projectionState.projection.kind === 'needsRepair' || projectionState.projection.kind === 'residual') {
    if (projectionState.removalProtection.blockedDependents.length > 0) {
      throw new Error(
        `${options.pluginName} 当前仍被其它 verified dependent 引用，reinstall 不会隐式执行 cleanup。`,
      );
    }
    if (projectionState.forceCleanupRequired) {
      throw new Error(`${options.pluginName} 当前需要先显式运行 aw cleanup --force，reinstall 不会隐式执行该清理。`);
    }
    if (!projectionState.removalProtection.allowed) {
      throw new Error(
        projectionState.removalProtection.failClosedReason
        ?? `${options.pluginName} 当前无法安全执行隐式 cleanup。`,
      );
    }
  }

  return projectionState;
}

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
  const options = normalizeReinstallCommandOptions(rawOptions, {
    defaultScope: 'user',
  });
  if (pluginNames.length !== 1) {
    throw new Error('reinstall 命令当前只支持单个插件目标。');
  }

  const platform = options.platform;
  const env = runtime.env ?? process.env;
  const uninstallImpl = runtime.uninstallCommandImpl ?? uninstallCommand;
  const cleanupImpl = runtime.cleanupCommandImpl ?? cleanupCommand;
  const installImpl = runtime.installCommandImpl ?? installCommand;
  if (platform === 'both') {
    const adapters = createAdapters(options.cwd, env, runtime);
    const targets = await loadPluginTargetsForCommand(
      options.cwd,
      options.scope,
      pluginNames,
      {
        catalogMode: 'readOnly',
        allowHistoricalFallback: false,
        env,
      },
    );
    const requestedPairs = await resolveCurrentCatalogWriteTargetPairs(
      'install',
      'both',
      options.cwd,
      options.scope,
      targets,
      adapters,
      env,
    );
    const supportedLocations = await Promise.all(requestedPairs.map(async ({ pluginName, platform: resolvedPlatform }) => ({
      plugin: pluginName,
      platform: resolvedPlatform,
      scope: options.scope,
      projectKey: options.scope === 'project'
        ? await resolveProjectKey(resolvedPlatform, options.cwd)
        : null,
    } satisfies PluginLocation)));
    const supportedPlatforms = [...new Set(supportedLocations.map((location) => location.platform))];
    const historicalRecoveryLocations = [];
    for (const historicalPlatform of (['codex', 'claude'] as const).filter((candidatePlatform) =>
      !supportedPlatforms.includes(candidatePlatform),
    )) {
      const historicalLocation: PluginLocation = {
        plugin: pluginNames[0]!,
        platform: historicalPlatform,
        scope: options.scope,
        projectKey: options.scope === 'project'
          ? await resolveProjectKey(historicalPlatform, options.cwd)
          : null,
      };
      const projectionState = await readInstallStateProjection({
        cwd: options.cwd,
        location: historicalLocation,
        env,
      });
      if (projectionState.projection.kind !== 'notInstalled') {
        historicalRecoveryLocations.push(historicalLocation);
      }
    }
    if (historicalRecoveryLocations.length > 0 && supportedLocations.length > 0) {
      throw new Error(
        [
          '`reinstall --platform both` 不能在同一次写入里同时清理历史不再支持的平台并重建当前支持的平台。',
          `请先单独 cleanup 这些历史 target：${historicalRecoveryLocations.map(renderReinstallLocation).join('、')}。`,
          `完成后再重新运行 aw reinstall ${pluginNames[0]} --platform both --scope ${options.scope}。`,
        ].join(' '),
      );
    }

    const preflightStates = await Promise.all(supportedLocations.map(async (location) => ({
      location,
      projectionState: await preflightReinstallLocation({
        pluginName: pluginNames[0]!,
        location,
        cwd: options.cwd,
        env,
      }),
    })));

    for (const { location, projectionState } of preflightStates) {
      const singlePlatformOptions = {
        ...rawOptions,
        cwd: options.cwd,
        scope: location.scope,
        platform: location.platform,
      };
      if (projectionState.projection.kind === 'installed') {
        await uninstallImpl(pluginNames, singlePlatformOptions, runtime);
      } else if (
        projectionState.projection.kind === 'needsRepair' ||
        projectionState.projection.kind === 'residual'
      ) {
        await cleanupImpl(pluginNames, singlePlatformOptions as RawCleanupCommandOptions, runtime);
      }
    }

    return installImpl(pluginNames, {
      ...rawOptions,
      cwd: options.cwd,
      scope: options.scope,
      platform: 'both',
    }, runtime);
  }
  const location: PluginLocation = {
    plugin: pluginNames[0]!,
    platform,
    scope: options.scope,
    projectKey: options.scope === 'project'
      ? await resolveProjectKey(platform, options.cwd)
      : null,
  };
  await assertNoDuplicateInstall({
    cwd: options.cwd,
    location,
    env,
  });
  const projectionState = await readInstallStateProjection({
    cwd: options.cwd,
    location,
    env,
  });

  if (projectionState.projection.kind === 'adoptable') {
    throw new Error(`${pluginNames[0]} 当前是可认领状态，reinstall 默认不会删除这些共享产物。`);
  }

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
