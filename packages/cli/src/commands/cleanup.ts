import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import {
  cleanupInstallStateTarget,
  pruneDependencyIndexStaleEntry,
  type InstallStateRemovalRuntime,
} from './install-state-removal.js';
import { normalizeCommandOptions, type RawCommandOptions } from './options.js';
import { loadPluginTargetsForCommand } from './common.js';
import type { PlatformName, Scope } from '../types.js';
import { resolveClaudeProjectKey, resolveCodexProjectKey } from '../utils/paths.js';

interface CleanupRetiredEntry {
  location: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
  };
  recordPath: string;
}

export interface CleanupJsonPayload {
  ok: true;
  command: 'cleanup';
  generatedAt: string;
  dependencyIndex: boolean;
  retiredEntries: CleanupRetiredEntry[];
  nextSteps: string[];
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function scopeLabel(scope: Scope): string {
  return scope === 'project' ? '当前项目' : '当前用户';
}

function renderCleanupOutput(payload: CleanupJsonPayload): string {
  if (payload.dependencyIndex) {
    const lines = ['清理完成'];
    if (payload.retiredEntries.length > 0) {
      lines.push('已退休的项目引用：');
      for (const entry of payload.retiredEntries) {
        lines.push(`- ${entry.location.plugin} / ${platformLabel(entry.location.platform)} / ${scopeLabel(entry.location.scope)}`);
        lines.push(`  记录路径：${entry.recordPath}`);
      }
    } else {
      lines.push('这次没有需要退休的项目引用。');
    }
    if (payload.nextSteps.length > 0) {
      lines.push(`下一步：${payload.nextSteps.join('；')}`);
    }
    return lines.join('\n');
  }

  return '清理完成。';
}

export interface RawCleanupCommandOptions extends RawCommandOptions {
  force?: boolean;
  dependencyIndex?: boolean;
  pruneStale?: string;
  yes?: boolean;
}

export interface CleanupCommandRuntime extends InstallStateRemovalRuntime {
  p9TargetResolver?: typeof loadPluginTargetsForCommand;
}

async function resolveProjectKey(platform: PlatformName, cwd: string): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

export async function cleanupCommand(
  pluginNames: string[],
  rawOptions: RawCleanupCommandOptions,
  runtime: CleanupCommandRuntime = {},
): Promise<{
  platforms: string[];
  plugins: string[];
  warnings: string[];
  repoManagedArtifacts: unknown[];
  retiredEntries?: CleanupRetiredEntry[];
  output?: string;
  payload?: CleanupJsonPayload;
}> {
  const options = normalizeCommandOptions(rawOptions, {
    defaultScope: 'user',
    defaultPlatform: 'auto',
  });
  const context = createCommandExecutionContext(runtime);

  if (rawOptions.dependencyIndex) {
    if (!rawOptions.pruneStale) {
      throw new Error('cleanup --dependency-index 目前只支持 --prune-stale <token>。');
    }
    if (rawOptions.yes !== true) {
      throw new Error('cleanup --dependency-index --prune-stale 需要显式传入 --yes。');
    }
    const result = await pruneDependencyIndexStaleEntry({
      pruneToken: rawOptions.pruneStale,
      env: context.env,
    });
    const payload: CleanupJsonPayload = {
      ok: true,
      command: 'cleanup',
      generatedAt: new Date().toISOString(),
      dependencyIndex: true,
      retiredEntries: result.retiredEntries.map((entry) => ({
        location: {
          plugin: entry.location.plugin,
          platform: entry.location.platform,
          scope: entry.location.scope,
          ...(entry.location.projectKey ? { projectKey: entry.location.projectKey } : {}),
        },
        recordPath: entry.recordPath,
      })),
      nextSteps: ['运行 aw diagnose 查看最新依赖状态。'],
    };
    return {
      platforms: [],
      plugins: [],
      warnings: result.warnings,
      repoManagedArtifacts: [],
      retiredEntries: payload.retiredEntries,
      output: renderCleanupOutput(payload),
      payload,
    };
  }

  if (pluginNames.length !== 1) {
    throw new Error('cleanup 命令当前只支持单个插件目标。');
  }
  if (options.platform === 'auto' || options.platform === 'both') {
    throw new Error('cleanup 命令需要显式指定单一平台。');
  }

  const platform = options.platform;
  const scope: Scope = options.scope;
  const location = {
    plugin: pluginNames[0]!,
    platform,
    scope,
    ...(scope === 'project'
      ? { projectKey: await resolveProjectKey(platform, options.cwd) }
      : {}),
  };
  let target = null;
  try {
    const resolver = runtime.p9TargetResolver ?? loadPluginTargetsForCommand;
    const resolved = await resolver(
      options.cwd,
      scope,
      [pluginNames[0]!],
      {
        allowHistoricalFallback: true,
        env: context.env,
      },
    );
    target = resolved[0] ?? null;
  } catch {
    target = null;
  }

  const result = await cleanupInstallStateTarget({
    pluginName: pluginNames[0]!,
    location,
    commandOptions: {
      ...options,
      force: rawOptions.force === true,
    },
    runtime: {
      ...runtime,
      adapters: runtime.adapters,
    },
    target,
  });

  const payload: CleanupJsonPayload = {
    ok: true,
    command: 'cleanup',
    generatedAt: new Date().toISOString(),
    dependencyIndex: false,
    retiredEntries: [],
    nextSteps: [`运行 aw install ${pluginNames[0]} -p ${platform} -s ${scope} 重新安装。`],
  };

  return {
    platforms: [platform],
    plugins: pluginNames,
    warnings: result.warnings,
    repoManagedArtifacts: result.repoManagedArtifacts,
    output: renderCleanupOutput(payload),
    payload,
  };
}
