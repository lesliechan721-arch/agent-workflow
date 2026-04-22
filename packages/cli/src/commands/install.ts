import type { CommandOptions } from '../types.js';
import { createAdapters, loadPluginsForCommand, resolveTargetPlatforms } from './common.js';

export async function installCommand(
  pluginNames: string[],
  options: CommandOptions,
): Promise<{ platforms: string[]; plugins: string[] }> {
  if (pluginNames.length === 0) {
    throw new Error('install 命令至少需要一个插件名。');
  }

  const plugins = await loadPluginsForCommand(options.cwd, pluginNames);
  const adapters = createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'install',
    options.platform,
    options.cwd,
    options.scope,
    plugins,
    adapters,
  );

  for (const platform of platforms) {
    for (const plugin of plugins) {
      await adapters[platform].installPlugin(plugin, options.scope);
      await adapters[platform].installExtensions(plugin, options.scope);
    }
  }

  return {
    platforms,
    plugins: plugins.map((plugin) => plugin.manifest.name),
  };
}

