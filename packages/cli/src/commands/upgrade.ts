import type { CommandOptions } from '../types.js';
import {
  collectCommandWarnings,
  createAdapters,
  loadPluginsForCommand,
  resolveTargetPlatforms,
} from './common.js';

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
}

export async function upgradeCommand(
  pluginNames: string[],
  options: UpgradeCommandOptions,
): Promise<{ platforms: string[]; plugins: string[]; warnings: string[] }> {
  const plugins = await loadPluginsForCommand(
    options.cwd,
    options.all ? undefined : pluginNames,
    {
      syncGeneratedManifests: true,
    },
  );

  if (!options.all && pluginNames.length === 0) {
    throw new Error('upgrade 命令需要插件名，或者显式传入 `--all`。');
  }

  const adapters = createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'upgrade',
    options.platform,
    options.cwd,
    options.scope,
    plugins,
    adapters,
  );

  const warnings = collectCommandWarnings(platforms, options.scope);
  const upgradedPlugins = new Set<string>();
  for (const platform of platforms) {
    const initializedPlugins = [];

    for (const plugin of plugins) {
      const status = await adapters[platform].status(plugin, options.scope);
      if (!status.initialized) {
        if (options.all) {
          continue;
        }

        throw new Error(
          `${plugin.manifest.name} 在 ${platform} (${options.scope}) 尚未初始化，不能执行 upgrade。`,
        );
      }

      initializedPlugins.push(plugin);
    }

    if (options.all && initializedPlugins.length === 0) {
      continue;
    }

    for (const plugin of initializedPlugins) {
      await adapters[platform].upgradePlugin(plugin, options.scope);
      const status = await adapters[platform].status(plugin, options.scope);
      for (const warning of status.plugins[0]?.driftWarnings ?? []) {
        warnings.push(`[${platform}/${plugin.manifest.name}] ${warning}`);
      }
      upgradedPlugins.add(plugin.manifest.name);
    }
  }

  return {
    platforms,
    plugins: [...upgradedPlugins],
    warnings,
  };
}
