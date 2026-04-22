import chalk from 'chalk';

import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type {
  CommandAction,
  PlatformAdapter,
  PlatformName,
  PlatformSelection,
  PluginMeta,
  Scope,
  StatusReport,
} from '../types.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  resolvePlugins,
  syncGeneratedPluginManifests,
} from '../utils/manifest.js';

export function createAdapters(cwd: string): Record<PlatformName, PlatformAdapter> {
  return {
    codex: new CodexAdapter(cwd),
    claude: new ClaudeAdapter(cwd),
  };
}

async function getInitializedPlatforms(
  adapters: Record<PlatformName, PlatformAdapter>,
  plugins: PluginMeta[],
  scope: Scope,
): Promise<PlatformName[]> {
  const initialized = new Set<PlatformName>();

  for (const platform of ['codex', 'claude'] as const) {
    for (const plugin of plugins) {
      const status = await adapters[platform].status(plugin, scope);
      if (status.initialized) {
        initialized.add(platform);
        break;
      }
    }
  }

  return [...initialized];
}

export async function resolveTargetPlatforms(
  action: CommandAction,
  requestedPlatform: PlatformSelection,
  cwd: string,
  scope: Scope,
  plugins: PluginMeta[],
  adapters: Record<PlatformName, PlatformAdapter>,
): Promise<PlatformName[]> {
  const detection = await detectEnvironment(cwd);
  const availablePlatforms = listDetectedPlatforms(detection);

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!availablePlatforms.includes(requestedPlatform)) {
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    if (availablePlatforms.length !== 2) {
      throw new Error('`--platform both` 只在同时检测到 Codex 和 Claude 时可用。');
    }
    return ['codex', 'claude'];
  }

  if (availablePlatforms.length === 0) {
    throw new Error('当前环境没有检测到可用平台。');
  }

  if (availablePlatforms.length === 1) {
    return availablePlatforms;
  }

  if (action === 'status') {
    return ['codex', 'claude'];
  }

  const initializedPlatforms = await getInitializedPlatforms(adapters, plugins, scope);
  if (initializedPlatforms.length === 1) {
    return initializedPlatforms;
  }

  throw new Error(
    '当前环境同时检测到双平台，且无法从当前 scope 的初始化状态唯一推断目标平台，请显式传入 `--platform codex|claude|both`。',
  );
}

export async function loadPluginsForCommand(
  cwd: string,
  pluginNames?: string[],
  options: {
    syncGeneratedManifests?: boolean;
  } = {},
): Promise<PluginMeta[]> {
  const plugins = await resolvePlugins(cwd, pluginNames);
  if (plugins.length === 0) {
    throw new Error('没有发现可用插件。');
  }
  if (options.syncGeneratedManifests !== false) {
    await syncGeneratedPluginManifests(plugins);
  }
  return plugins;
}

export function formatStatusReports(reports: StatusReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(chalk.bold(`${report.platform} (${report.scope})`));
    lines.push(`  initialized: ${report.initialized ? 'yes' : 'no'}`);
    for (const plugin of report.plugins) {
      lines.push(`  - ${plugin.pluginName}`);
      lines.push(
        `    native: marketplace=${plugin.native.marketplaceRegistered ? 'registered' : 'missing'}, available=${plugin.native.pluginAvailable ? 'yes' : 'no'}, installed=${plugin.native.pluginInstalled ? 'yes' : 'no'}, version=${plugin.native.version ?? '-'}`,
      );
      if (plugin.native.details) {
        lines.push(`    native-details: ${plugin.native.details}`);
      }
      if (plugin.generatedArtifacts.length === 0) {
        lines.push('    artifacts: none');
      } else {
        lines.push('    artifacts:');
        for (const artifact of plugin.generatedArtifacts) {
          lines.push(
            `      - ${artifact.kind} ${artifact.exists ? 'present' : 'missing'} ${artifact.path}`,
          );
        }
      }
      if (plugin.driftWarnings.length === 0) {
        lines.push('    drift: none');
      }
      for (const warning of plugin.driftWarnings) {
        lines.push(`    drift: ${warning}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
