import type { CommandOptions, StatusReport } from '../types.js';
import { createAdapters, formatStatusReports, loadPluginsForCommand, resolveTargetPlatforms } from './common.js';

export async function statusCommand(
  pluginNames: string[],
  options: CommandOptions,
): Promise<{ reports: StatusReport[]; output: string }> {
  const plugins = await loadPluginsForCommand(options.cwd, pluginNames.length > 0 ? pluginNames : undefined);
  const adapters = createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'status',
    options.platform,
    options.cwd,
    options.scope,
    plugins,
    adapters,
  );

  const reports: StatusReport[] = [];
  for (const platform of platforms) {
    for (const plugin of plugins) {
      reports.push(await adapters[platform].status(plugin, options.scope));
    }
  }

  return {
    reports,
    output: formatStatusReports(reports),
  };
}

