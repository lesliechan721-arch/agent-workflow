import type { CommandOptions } from '../types.js';
import { createAdapters, loadPluginsForCommand, resolveTargetPlatforms } from './common.js';

export interface UpgradeCommandOptions extends CommandOptions {
  all?: boolean;
}

export async function upgradeCommand(
  pluginNames: string[],
  options: UpgradeCommandOptions,
): Promise<{ platforms: string[]; plugins: string[] }> {
  const plugins = await loadPluginsForCommand(
    options.cwd,
    options.all ? undefined : pluginNames,
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

  for (const platform of platforms) {
    for (const plugin of plugins) {
      await adapters[platform].upgradePlugin(plugin, options.scope);
    }
  }

  return {
    platforms,
    plugins: plugins.map((plugin) => plugin.manifest.name),
  };
}

