import type { CommandOptions, StatusReport } from '../types.js';
import { createAdapters, formatStatusReports, loadPluginsForCommand, resolveTargetPlatforms } from './common.js';

export async function statusCommand(
  pluginNames: string[],
  options: CommandOptions,
): Promise<{ reports: StatusReport[]; output: string }> {
  const plugins = await loadPluginsForCommand(
    options.cwd,
    pluginNames.length > 0 ? pluginNames : undefined,
    {
      syncGeneratedManifests: false,
    },
  );
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
    const pluginReports = [];
    let initialized = false;

    for (const plugin of plugins) {
      const status = await adapters[platform].status(plugin, options.scope);
      pluginReports.push(...status.plugins);
      initialized ||= status.initialized;
    }

    reports.push({
      platform,
      scope: options.scope,
      initialized,
      plugins: pluginReports,
    });
  }

  return {
    reports,
    output: formatStatusReports(reports),
  };
}
