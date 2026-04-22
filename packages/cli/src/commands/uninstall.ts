import type { CommandOptions } from '../types.js';
import { createAdapters, loadPluginsForCommand, resolveTargetPlatforms } from './common.js';

export async function uninstallCommand(
  pluginNames: string[],
  options: CommandOptions,
): Promise<{ platforms: string[]; plugins: string[] }> {
  if (pluginNames.length === 0) {
    throw new Error('uninstall 命令至少需要一个插件名。');
  }

  const plugins = await loadPluginsForCommand(options.cwd, pluginNames);
  const adapters = createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'uninstall',
    options.platform,
    options.cwd,
    options.scope,
    plugins,
    adapters,
  );

  for (const platform of platforms) {
    for (const plugin of plugins) {
      await adapters[platform].uninstallExtensions(plugin, options.scope);
      await adapters[platform].uninstallPlugin(plugin, options.scope);
    }
  }

  return {
    platforms,
    plugins: plugins.map((plugin) => plugin.manifest.name),
  };
}

