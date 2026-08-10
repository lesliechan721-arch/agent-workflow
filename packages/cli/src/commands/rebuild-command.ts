import type {
  CatalogResolution,
  CommandOptions,
  GeneratedArtifact,
  PlatformName,
  PluginMeta,
  ReceiptOverallState,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import { probeAgentVersion } from '../utils/agent-version.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { createNoopReporter } from '../output/reporter.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from '../utils/native-cli.js';
import { readPluginManifest, resolvePluginsFromCatalog } from '../utils/manifest.js';
import { resolveCurrentCatalog } from '../utils/plugin-catalog.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { hasCodexProjectManagedArtifacts } from '../utils/codex-project-surface.js';
import {
  createRebuildActiveStore,
  executeRebuildTargets,
  type RebuildCommand,
  type RebuildResult,
  type RebuildTargetIdentity,
} from './rebuild-operations.js';
import {
  createRebuildIntegration,
  discoverRebuildTargetNames,
  type RebuildExecutionContext,
} from './rebuild-integration.js';
import { applyCatalogSelectorEnv } from './options.js';

export type RebuildCommandRuntime = Partial<RebuildExecutionContext> & {
  catalogResolution?: CatalogResolution;
};

export interface RebuildCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  rebuildResults: RebuildResult[];
  targetResults: ReceiptTargetResult[];
  overallState: ReceiptOverallState;
  nativePlugins: Partial<Record<PlatformName, string[]>>;
  repoManagedArtifacts: GeneratedArtifact[];
  receiptTargets: Array<{
    plugin: string;
    platform: string;
    scope: Scope;
  }>;
}

function selectedPlatforms(selection: CommandOptions['platform']): PlatformName[] {
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function createSyntheticPlugin(pluginName: string): PluginMeta {
  return {
    rootDir: '.',
    manifestPath: '.agents-plugin/plugin.json',
    manifest: {
      name: pluginName,
      version: '0.0.0',
      description: 'Cleanup-only target for a plugin missing from the current catalog.',
      compatibility: { aw: { minVersion: '0.0.0' } },
      marketplace: {
        category: 'cleanup',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
    },
  };
}

function failedResult(
  command: RebuildCommand,
  identity: RebuildTargetIdentity,
  message: string,
): RebuildResult {
  return {
    status: 'failed',
    command,
    target: identity,
    actions: [],
    cleanupAttempted: false,
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [{ phase: 'preflight', message }],
    error: { phase: 'preflight', message },
  };
}

function toTargetResult(result: RebuildResult): ReceiptTargetResult {
  return {
    target: {
      pluginName: result.target.pluginName,
      platform: result.target.platform,
      scope: result.target.scope,
    },
    action: result.command,
    state: result.status === 'succeeded' ? 'completed' : 'failed',
    ...(result.status === 'failed' ? { message: result.error.message } : {}),
  };
}

async function assertAgentVersions(options: {
  platforms: PlatformName[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  runtime: RebuildExecutionContext;
}): Promise<void> {
  const failures = [];
  for (const platform of options.platforms) {
    const result = await probeAgentVersion(platform, {
      cwd: options.cwd,
      env: options.env,
      runner: options.runtime.nativeCliRunner,
    });
    if (result.status !== 'supported') failures.push(result);
  }
  if (failures.length > 0) {
    throw new Error(failures.map((failure) =>
      `${failure.command} 版本检查失败：${failure.details ?? failure.status}；最低版本 ${failure.requiredMinVersion}。`)
      .join('；'));
  }
}

async function resolveRequestedNames(options: {
  command: RebuildCommand;
  pluginNames: string[];
  all?: boolean;
  platforms: PlatformName[];
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
}): Promise<Map<PlatformName, string[]>> {
  const result = new Map<PlatformName, string[]>();
  for (const platform of options.platforms) {
    const names = options.command === 'upgrade' && options.all
      ? await discoverRebuildTargetNames({
          cwd: options.cwd,
          env: options.env,
          platform,
          scope: options.scope,
          nativeCliRunner: options.nativeCliRunner,
          nativeFailureMode: 'error',
        })
      : options.pluginNames;
    result.set(platform, [...new Set(names)]);
  }
  return result;
}

export async function runRebuildCommand(options: {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
  const runtime: RebuildExecutionContext = {
    env: options.runtime?.env ?? process.env,
    nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    reporter: options.runtime?.reporter ?? createNoopReporter(),
    debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
  };
  const env = applyCatalogSelectorEnv(runtime.env, options.commandOptions);
  const platforms = selectedPlatforms(options.commandOptions.platform);
  await assertAgentVersions({
    platforms,
    cwd: options.commandOptions.cwd,
    env,
    runtime,
  });
  const catalog = options.runtime?.catalogResolution ?? await resolveCurrentCatalog(env, {
    channel: options.commandOptions.catalogChannel,
    catalogVersion: options.commandOptions.catalogVersion,
  });
  const catalogPlugins = await resolvePluginsFromCatalog(catalog.rootDir, undefined);
  const catalogByName = new Map(catalogPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const requestedByPlatform = await resolveRequestedNames({
    command: options.command,
    pluginNames: options.pluginNames,
    all: options.all,
    platforms,
    scope: options.commandOptions.scope,
    cwd: options.commandOptions.cwd,
    env,
    nativeCliRunner: runtime.nativeCliRunner,
  });
  const integration = createRebuildIntegration({
    context: runtime,
    scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
  });
  const activeStore = createRebuildActiveStore({
    env,
    loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
  });
  const targets = [];
  const results: RebuildResult[] = [];
  for (const platform of platforms) {
    for (const pluginName of requestedByPlatform.get(platform) ?? []) {
      const currentPlugin = catalogByName.get(pluginName);
      const identity: RebuildTargetIdentity = {
        pluginName,
        pluginVersion: currentPlugin?.manifest.version ?? '0.0.0',
        platform,
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
      };
      if (!currentPlugin && options.command === 'upgrade') {
        results.push(failedResult(
          options.command,
          identity,
          `${pluginName} 当前不在 current catalog 中，不能用历史 bundle 升级。请运行 \`aw cleanup ${pluginName} -p ${platform} -s ${options.commandOptions.scope}\` 清理当前可见 AW 输出。`,
        ));
        continue;
      }
      if (!currentPlugin && options.command !== 'cleanup' && options.command !== 'uninstall') {
        results.push(failedResult(
          options.command,
          identity,
          `${pluginName} 当前不在 current catalog 中。`,
        ));
        continue;
      }
      const plugin = currentPlugin ?? createSyntheticPlugin(pluginName);
      if (
        currentPlugin
        && options.command !== 'cleanup'
        && options.command !== 'uninstall'
        && !supportsPlatform(currentPlugin.manifest, platform)
      ) {
        results.push(failedResult(
          options.command,
          identity,
          options.command === 'upgrade'
            ? `${pluginName} 当前 catalog 不再支持 ${platform}，不能升级这个可见目标。请运行 \`aw cleanup ${pluginName} -p ${platform} -s ${options.commandOptions.scope}\`。`
            : `${pluginName} 当前 catalog 不支持 ${platform}。`,
        ));
        continue;
      }
      if (
        currentPlugin
        && platform === 'codex'
        && options.commandOptions.scope === 'project'
        && options.command !== 'cleanup'
        && options.command !== 'uninstall'
        && currentPlugin.manifest.apps
      ) {
        results.push(failedResult(
          options.command,
          identity,
          `${pluginName} 声明了 apps；Codex project scope 不支持 apps。`,
        ));
        continue;
      }
      if (
        currentPlugin
        && platform === 'codex'
        && options.commandOptions.scope === 'project'
        && options.command !== 'cleanup'
        && options.command !== 'uninstall'
        && !hasCodexProjectManagedArtifacts(currentPlugin)
      ) {
        results.push(failedResult(
          options.command,
          identity,
          `${pluginName} 没有 Codex project scope 可生成的 Skills、instructions、roles、MCP、hooks 或 permissions。`,
        ));
        continue;
      }
      try {
        targets.push(await integration.buildTarget({
          plugin,
          platform,
          scope: options.commandOptions.scope,
          cwd: options.commandOptions.cwd,
          command: options.command,
          catalog,
          includeHistoricalLifecycleArtifacts: true,
        }));
      } catch (error) {
        results.push(failedResult(
          options.command,
          identity,
          error instanceof Error ? error.message : String(error),
        ));
      }
    }
  }
  results.push(...await executeRebuildTargets({
    command: options.command,
    targets,
    driver: integration.driver,
    activeStore,
  }));
  const successful = results.filter((result) => result.status === 'succeeded');
  const artifacts = targets.flatMap((target) => [...target.artifacts]);
  const nativePlugins: Partial<Record<PlatformName, string[]>> = {};
  for (const result of successful) {
    const target = targets.find((entry) =>
      entry.identity.pluginName === result.target.pluginName
      && entry.identity.platform === result.target.platform
      && entry.identity.scope === result.target.scope);
    if (target?.requiresNative && options.command !== 'cleanup' && options.command !== 'uninstall') {
      nativePlugins[result.target.platform] ??= [];
      nativePlugins[result.target.platform]!.push(result.target.pluginName);
    }
  }
  return {
    platforms,
    plugins: [...new Set(successful.map((result) => result.target.pluginName))],
    warnings: [],
    rebuildResults: results,
    targetResults: results.map(toTargetResult),
    overallState: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed',
    nativePlugins,
    repoManagedArtifacts: artifacts,
    receiptTargets: results.map((result) => ({
      plugin: result.target.pluginName,
      platform: result.target.platform,
      scope: result.target.scope,
    })),
  };
}
