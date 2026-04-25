import type { CommandOptions, PlatformAdapter, PlatformName, StatusReport } from '../types.js';
import { detectEnvironment } from '../utils/detect.js';
import {
  createAdapters,
  formatStatusOutput,
  hasHistoricalEvidence,
  loadPluginTargetsForCommand,
  resolveTargetPlatforms,
} from './common.js';

interface CommandRuntime {
  adapters?: Record<PlatformName, PlatformAdapter>;
  env?: NodeJS.ProcessEnv;
}

export async function statusCommand(
  pluginNames: string[],
  options: CommandOptions,
  runtime: CommandRuntime = {},
): Promise<{ reports: StatusReport[]; output: string }> {
  const env = runtime.env ?? process.env;
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames.length > 0 ? pluginNames : undefined,
    {
      allowHistoricalFallback: pluginNames.length > 0,
      env,
    },
  );
  const adapters = runtime.adapters ?? createAdapters(options.cwd);
  const platforms = await resolveTargetPlatforms(
    'status',
    options.platform,
    options.cwd,
    options.scope,
    targets.map((target) => target.plugin),
    adapters,
  );

  const reports: StatusReport[] = [];
  for (const platform of platforms) {
    const pluginReports = [];
    let initialized = false;

    for (const target of targets) {
      const status = await adapters[platform].status(target.plugin, options.scope);
      const pluginStatus = status.plugins[0];
      if (target.source === 'historical' && pluginStatus && !hasHistoricalEvidence(pluginStatus)) {
        throw new Error(`Unknown plugin "${target.pluginName}".`);
      }

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

  const detection = await detectEnvironment(options.cwd, env);
  return {
    reports,
    output: formatStatusOutput(detection, reports),
  };
}
