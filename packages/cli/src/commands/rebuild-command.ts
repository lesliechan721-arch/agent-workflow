import path from 'node:path';

import type {
  CatalogSourceResolution,
  CatalogResolution,
  CommandOptions,
  GeneratedArtifact,
  PlatformName,
  PluginMeta,
  ReceiptOverallState,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import fs from 'fs-extra';
import type { RebuildActionEvent } from '../output/model.js';
import { probeAgentVersion } from '../utils/agent-version.js';
import {
  previewCodexManager,
  resolveCodexManager,
  type CodexManagerPreview,
  type ManagedCodexAuthorizer,
} from '../utils/codex-manager.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { createNoopReporter } from '../output/reporter.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from '../utils/native-cli.js';
import { readPluginManifest, resolvePluginsFromCatalog } from '../utils/manifest.js';
import { resolveAwHome } from '../utils/paths.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { hasCodexProjectManagedArtifacts } from '../utils/codex-project-surface.js';
import {
  createRebuildActiveStore,
  executeRebuildOperation,
  type RebuildCommand,
  type RebuildFailure,
  type RebuildResult,
  type RebuildTargetIdentity,
} from './rebuild-operations.js';
import {
  assertNoClaudeUnboundNativeNameCollision,
  codexNativeRemovalRequired,
  createRebuildIntegration,
  discoverRebuildTargetNames,
  inspectNativeMarketplaceRegistrations,
  type PreparedRebuildTarget,
  type RebuildExecutionContext,
} from './rebuild-integration.js';
import { getNamespacedMarketplaceName } from '../utils/local-marketplace.js';
import type { AwHomeMutationToken } from '../utils/aw-home-mutation-lock.js';
import {
  formatPluginId,
  parsePluginId,
  planPluginSelectorSourceIds,
  preflightDesiredArtifactCollisions,
  withResolvedMultiSourceCatalog,
} from '../utils/multi-source-catalog.js';
import { assertStrictSemVer } from '../utils/manifest.js';
import {
  assertCatalogSourceInventoryComplete,
  canonicalMarketplaceRegistrationNames,
  inventoryCatalogSourceReferences,
} from '../utils/catalog-source-references.js';
import { resolveEffectivePluginConfig } from '../utils/plugin-config.js';
import {
  cleanupCorruptExclusivePluginDirectory,
  inspectOwnedComponents,
  type CleanupResult,
} from '../utils/ownership.js';
import {
  codexProjectConfigAliasesUserHome,
  getClaudeHome,
  getCodexHome,
  resolveCanonicalRepoProjectKey,
  resolveRepoRootSync,
} from '../utils/state-paths.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import {
  createDependencyOperationPlan,
  type DependencyOperationPlan,
} from './dependency-operation-plan.js';
import type { CleanupCommandOptions } from './options.js';

export type RebuildCommandRuntime = Partial<RebuildExecutionContext> & {
  awHomeMutationToken?: AwHomeMutationToken;
  catalogResolution?: CatalogResolution;
  namespacedSource?: {
    sourceId: string;
    sourceIdentity: string;
    marketplaceName: string;
    marketplaceRoot: string;
  };
  expectedCatalogConfigDigest?: string;
  reviewPreflight?: (evidence: RebuildReviewPreflightEvidence) => Promise<void> | void;
  resolvedReviewEvidenceByPlugin?: Record<
    string,
    Omit<RebuildReviewPreflightEvidence, 'command' | 'identity'>
  >;
  bypassDependencyPlan?: boolean;
  dependencyReviewPreflightHandled?: boolean;
  previewDependencyPlanOnly?: boolean;
  previewCatalogFreshnessPolicy?: 'cacheFirst';
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  codexManagerResolver?: typeof resolveCodexManager;
  codexManagerPreviewer?: typeof previewCodexManager;
  onPreviewStage?: (stage: 'catalog' | 'inventory' | 'dependencyPlan') => Promise<void> | void;
  targetBuiltHookHandled?: boolean;
  preparedTarget?: PreparedRebuildTarget;
  preparedTargetError?: unknown;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
  corruptExclusiveDirectoryOperations?: {
    rename?: (source: string, destination: string) => Promise<void>;
    remove?: (target: string) => Promise<void>;
  };
};

export interface RebuildReviewPreflightEvidence {
  command: RebuildCommand;
  identity: RebuildTargetIdentity;
  configDigest?: string;
  sourceId?: string;
  sourceIdentity?: string;
  resolvedCommit?: string;
  manifestDigest?: string;
  snapshotDigest?: string;
  contentDigest?: string;
}

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
    pluginName: string;
    pluginId?: string;
    sourceId?: string;
    platform: PlatformName;
    scope: Scope;
  }>;
  dependencyPlan?: DependencyOperationPlan;
  codexManagerPreview?: CodexManagerPreview;
}

export interface RebuildCommandTestHooks {
  afterTargetBuilt?: (options: {
    command: RebuildCommand;
    identity: RebuildTargetIdentity;
  }) => Promise<void>;
}

let rebuildCommandTestHooks: RebuildCommandTestHooks | undefined;

async function emitRebuildActionEvent(
  runtime: RebuildExecutionContext,
  event: RebuildActionEvent,
): Promise<void> {
  await Promise.allSettled([
    Promise.resolve().then(() => runtime.reporter.event(event)),
    Promise.resolve().then(() => runtime.debugLogger.log(event)),
  ]);
}

export function setRebuildCommandTestHooksForTests(
  hooks: RebuildCommandTestHooks | undefined,
): void {
  rebuildCommandTestHooks = hooks;
}

function selectedPlatforms(selection: CommandOptions['platform']): PlatformName[] {
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function createSyntheticPlugin(pluginName: string, env: NodeJS.ProcessEnv): PluginMeta {
  const rootDir = path.join(resolveAwHome(env), 'plugins', pluginName);
  return {
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 1,
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
  phase: RebuildFailure['phase'] = 'preflight',
): RebuildResult {
  return {
    status: 'failed',
    command,
    target: identity,
    actions: phase === 'preflight' ? [] : [{ name: phase, status: 'failed' }],
    cleanupAttempted: false,
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [{ phase, message }],
    error: { phase, message },
  };
}

function toTargetResult(result: RebuildResult): ReceiptTargetResult {
  return {
    target: {
      pluginName: result.target.pluginName,
      ...(result.target.sourceId ? {
        sourceId: result.target.sourceId,
        sourceIdentity: result.target.sourceIdentity,
        pluginId: result.target.pluginId,
      } : {}),
      platform: result.target.platform,
      scope: result.target.scope,
    },
    action: result.command,
    state: result.status === 'succeeded' ? 'completed' : 'failed',
    ...(result.status === 'failed' ? { message: result.error.message } : {}),
  };
}

async function assertClaudeVersion(options: {
  platforms: PlatformName[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  runtime: RebuildExecutionContext;
}): Promise<void> {
  if (!options.platforms.includes('claude')) return;
  const failures = [];
  const result = await probeAgentVersion('claude', {
    cwd: options.cwd,
    env: options.env,
    runner: options.runtime.nativeCliRunner,
  });
  if (result.status !== 'supported') failures.push(result);
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

async function runSingleSourceRebuildCommand(options: {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
  const runtime: RebuildExecutionContext = options.runtime?.preparedTarget?.context ?? {
    env: options.runtime?.env ?? process.env,
    nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    reporter: options.runtime?.reporter ?? createNoopReporter(),
    debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
    ...(options.runtime?.codexManager ? { codexManager: options.runtime.codexManager } : {}),
    expectedCatalogConfigDigest: options.runtime?.expectedCatalogConfigDigest,
  };
  const env = runtime.env;
  const selected = selectedPlatforms(options.commandOptions.platform);
  const catalog = options.runtime?.catalogResolution;
  if (!catalog) throw new Error('Internal error: a resolved catalog source is required.');
  const catalogPlugins = await resolvePluginsFromCatalog(catalog.rootDir, undefined);
  if (options.runtime?.namespacedSource) {
    for (const plugin of catalogPlugins) {
      plugin.sourceId = options.runtime.namespacedSource.sourceId;
      plugin.sourceIdentity = options.runtime.namespacedSource.sourceIdentity;
      plugin.pluginId = formatPluginId({
        sourceId: options.runtime.namespacedSource.sourceId,
        pluginName: plugin.manifest.name,
      });
      plugin.marketplaceName = options.runtime.namespacedSource.marketplaceName;
    }
  }
  const catalogByName = new Map(catalogPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const requestedByPlatform = await resolveRequestedNames({
    command: options.command,
    pluginNames: options.pluginNames,
    all: options.all,
    platforms: selected,
    scope: options.commandOptions.scope,
    cwd: options.commandOptions.cwd,
    env,
    nativeCliRunner: runtime.nativeCliRunner,
  });
  if (
    options.commandOptions.platform === 'both'
    && options.command !== 'cleanup'
    && options.command !== 'uninstall'
  ) {
    for (const platform of selected) {
      requestedByPlatform.set(
        platform,
        (requestedByPlatform.get(platform) ?? []).filter((pluginName) => {
          const plugin = catalogByName.get(pluginName);
          return !plugin || supportsPlatform(plugin.manifest, platform);
        }),
      );
    }
  }
  const platforms = selected.filter((platform) =>
    (requestedByPlatform.get(platform)?.length ?? 0) > 0);
  if (options.runtime?.bypassDependencyPlan) {
    await assertClaudeVersion({
      platforms,
      cwd: options.commandOptions.cwd,
      env,
      runtime,
    });
  }
  const integration = options.runtime?.preparedTarget
    ? {
        driver: options.runtime.preparedTarget.driver,
        buildTarget: async () => options.runtime!.preparedTarget!.target,
      }
    : createRebuildIntegration({
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
        ...(options.runtime?.namespacedSource ?? {}),
        ...(options.runtime?.namespacedSource ? {
          pluginId: formatPluginId({
            sourceId: options.runtime.namespacedSource.sourceId,
            pluginName,
          }),
        } : currentPlugin?.pluginId ? { pluginId: currentPlugin.pluginId } : {}),
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
      const plugin = currentPlugin ?? createSyntheticPlugin(pluginName, env);
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
        && codexProjectConfigAliasesUserHome(options.commandOptions.cwd, env)
      ) {
        results.push(failedResult(
          options.command,
          identity,
          'codexScopePathAlias: Codex project config 与用户配置目录相同。请进入实际项目目录后重试。',
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
      let result: RebuildResult;
      try {
        if (options.runtime?.preparedTargetError) throw options.runtime.preparedTargetError;
        const target = await integration.buildTarget({
          ...(options.runtime?.namespacedSource ?? {}),
          ...(options.runtime?.namespacedSource ? {
            pluginId: formatPluginId({
              sourceId: options.runtime.namespacedSource.sourceId,
              pluginName,
            }),
          } : plugin.pluginId ? { pluginId: plugin.pluginId } : {}),
          plugin,
          platform,
          scope: options.commandOptions.scope,
          cwd: options.commandOptions.cwd,
          command: options.command,
          catalog,
          includeHistoricalLifecycleArtifacts: true,
        });
        targets.push(target);
        if (!options.runtime?.targetBuiltHookHandled) {
          await rebuildCommandTestHooks?.afterTargetBuilt?.({
            command: options.command,
            identity,
          });
        }
        if (!options.runtime?.dependencyReviewPreflightHandled) {
          await options.runtime?.reviewPreflight?.({
            command: options.command,
            identity,
            ...options.runtime.resolvedReviewEvidenceByPlugin?.[pluginName],
          });
        }
        result = await executeRebuildOperation({
          command: options.command,
          target,
          driver: integration.driver,
          activeStore,
          onActionEvent: (event) => emitRebuildActionEvent(runtime, event),
        });
      } catch (error) {
        result = (error as { result?: RebuildResult }).result ?? failedResult(
            options.command,
            identity,
            error instanceof Error ? error.message : String(error),
            'preflight',
          );
      }
      results.push(result);
    }
  }
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
      pluginName: result.target.pluginName,
      ...(result.target.sourceId ? {
        sourceId: result.target.sourceId,
        pluginId: result.target.pluginId,
      } : {}),
      platform: result.target.platform,
      scope: result.target.scope,
    })),
  };
}

function resolveRuntimeCliVersion(): string {
  const value = fs.readJsonSync(path.join(resolveCliPackageRoot(), 'package.json')) as { version?: unknown };
  return assertStrictSemVer(value.version, 'packages/cli/package.json version');
}

function toCatalogResolution(source: CatalogSourceResolution): CatalogResolution {
  return {
    rootDir: source.rootDir,
    source: 'local',
    catalogVersion: source.manifest.catalogVersion,
    channel: source.manifest.channel,
    minAwVersion: source.manifest.compatibility.aw.minVersion,
  };
}

function mergeRebuildCommandResults(results: RebuildCommandResult[]): RebuildCommandResult {
  const rebuildResults = results.flatMap((result) => result.rebuildResults);
  const platforms = [...new Set(results.flatMap((result) => result.platforms))];
  const nativePlugins: RebuildCommandResult['nativePlugins'] = {};
  for (const result of results) {
    for (const platform of ['codex', 'claude'] as const) {
      const names = result.nativePlugins[platform];
      if (names) nativePlugins[platform] = [...new Set([...(nativePlugins[platform] ?? []), ...names])];
    }
  }
  return {
    platforms,
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: results.flatMap((result) => result.warnings),
    rebuildResults,
    targetResults: results.flatMap((result) => result.targetResults),
    overallState: rebuildResults.every((result) => result.status === 'succeeded')
      ? 'succeeded'
      : 'failed',
    nativePlugins,
    repoManagedArtifacts: [],
    receiptTargets: results.flatMap((result) => result.receiptTargets),
    ...(results.find((result) => result.dependencyPlan)?.dependencyPlan
      ? { dependencyPlan: results.find((result) => result.dependencyPlan)!.dependencyPlan }
      : {}),
    ...(results.find((result) => result.codexManagerPreview)?.codexManagerPreview
      ? { codexManagerPreview: results.find((result) => result.codexManagerPreview)!.codexManagerPreview }
      : {}),
  };
}

function leaseSafeRebuildResult(result: RebuildCommandResult): RebuildCommandResult {
  const projectPath = (value: string): string => path.basename(value);
  return {
    ...result,
    repoManagedArtifacts: [],
    rebuildResults: result.rebuildResults.map((entry) => ({
      ...entry,
      target: { ...entry.target, cwd: '.' },
      removed: entry.removed.map(projectPath),
      absent: entry.absent.map(projectPath),
      residual: entry.residual.map(projectPath),
      quarantined: entry.quarantined.map(projectPath),
    })),
  };
}

function namespacedPreflightError(
  message: string,
  targets: Array<{
    pluginId: string;
    sourceId: string;
    sourceIdentity: string;
    pluginName: string;
    platform?: PlatformName;
    scope?: Scope;
    pluginVersion?: string;
  }>,
  legacyTargets: Array<{ pluginName: string; platform: PlatformName; scope: Scope }> = [],
): Error {
  return Object.assign(new Error(message), { namespacedTargets: targets, legacyTargets });
}

function selectedLegacyLiveReferences(
  references: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>['references'],
  platforms: ReadonlySet<PlatformName>,
  scope: Scope,
) {
  return references.filter((reference) =>
    (reference.kind === 'legacyOwner' || reference.kind === 'legacyMarketplace')
    && reference.pluginName
    && reference.scope === scope
    && reference.platform
    && platforms.has(reference.platform as PlatformName));
}

function projectLegacyTargets(
  references: ReturnType<typeof selectedLegacyLiveReferences>,
): Array<{ pluginName: string; platform: PlatformName; scope: Scope }> {
  return [...new Map(references.map((reference) => {
    const target = {
      pluginName: reference.pluginName!,
      platform: reference.platform as PlatformName,
      scope: reference.scope as Scope,
    };
    return [`${target.pluginName}\0${target.platform}\0${target.scope}`, target] as const;
  })).values()];
}

type LiveCleanupTarget = {
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  marketplaceName?: string;
  marketplaceIdentityUnresolved?: boolean;
};

function exclusiveSkillRoot(options: {
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): string {
  if (options.scope === 'user') {
    return path.join(
      options.platform === 'codex' ? getCodexHome(options.env) : getClaudeHome(options.env),
      'skills',
    );
  }
  const repoRoot = resolveRepoRootSync(options.cwd);
  return path.join(repoRoot, options.platform === 'codex' ? '.agents' : '.claude', 'skills');
}

function resolveLiveCleanupTargets(options: {
  selectors: string[];
  platforms: PlatformName[];
  scope: Scope;
  references: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>['references'];
}): { selectors: string[]; targets: LiveCleanupTarget[] } {
  const visible = options.references.filter((reference) =>
    (reference.kind === 'namespacedOwner'
      || reference.kind === 'namespacedMarketplace'
      || reference.kind === 'namespacedLifecycle')
    && reference.sourceId
    && reference.sourceIdentity
    && reference.pluginName
    && reference.platform
    && options.platforms.includes(reference.platform as PlatformName)
    && reference.scope === options.scope);
  const targets: LiveCleanupTarget[] = [];
  const selectors = options.selectors.map((value) => {
    const parsed = parsePluginId(value);
    const matchesByTarget = new Map<string, LiveCleanupTarget>();
    for (const reference of visible.filter((entry) =>
      entry.pluginName === parsed.pluginName
      && (parsed.sourceId === undefined || entry.sourceId === parsed.sourceId))) {
        const liveNames = new Set(options.references.flatMap((candidate) =>
          candidate.sourceId === reference.sourceId
          && candidate.sourceIdentity === reference.sourceIdentity
          && candidate.pluginName === reference.pluginName
          && candidate.platform === reference.platform
          && candidate.scope === reference.scope
          && candidate.marketplaceName
            ? [candidate.marketplaceName]
            : []));
        const registeredNames = canonicalMarketplaceRegistrationNames(
          options.references,
          reference.sourceId!,
        );
        const unboundNativeNames = new Set(options.references.flatMap((candidate) =>
          candidate.kind === 'namespacedMarketplace'
          && candidate.sourceId === undefined
          && candidate.pluginName === reference.pluginName
          && candidate.platform === reference.platform
          && candidate.scope === reference.scope
          && candidate.marketplaceName
            ? [candidate.marketplaceName]
            : []));
        const marketplaceName = liveNames.size === 1
          ? [...liveNames][0]
          : liveNames.size === 0 && registeredNames.length === 1
            ? registeredNames[0]
            : undefined;
        const marketplaceIdentityUnresolved = liveNames.size > 1
          || (liveNames.size === 0 && registeredNames.length > 1)
          || (liveNames.size === 0 && registeredNames.length === 0 && unboundNativeNames.size > 0);
        const target: LiveCleanupTarget = {
          pluginId: formatPluginId({ sourceId: reference.sourceId!, pluginName: reference.pluginName! }),
          pluginName: reference.pluginName!,
          sourceId: reference.sourceId!,
          sourceIdentity: reference.sourceIdentity!,
          platform: reference.platform as PlatformName,
          scope: reference.scope as Scope,
          ...(marketplaceName ? { marketplaceName } : {}),
          ...(marketplaceIdentityUnresolved ? { marketplaceIdentityUnresolved: true } : {}),
        };
        const key = [target.pluginId, target.sourceIdentity, target.platform, target.scope].join('\0');
        const previous = matchesByTarget.get(key);
        matchesByTarget.set(key, previous?.marketplaceName ? previous : target);
    }
    const matches = [...matchesByTarget.values()];
    const identities = [...new Set(matches.map((target) => target.pluginId))];
    if (parsed.sourceId === undefined && identities.length > 1) {
      throw new Error(
        `pluginSelectorAmbiguous: Plugin "${parsed.pluginName}" has multiple live matches: ${identities.sort().join(', ')}.`,
      );
    }
    targets.push(...matches);
    return identities.length === 1 ? identities[0]! : value;
  });
  return {
    selectors,
    targets: [...new Map(targets.map((target) => [[
      target.pluginId, target.sourceIdentity, target.platform, target.scope,
    ].join('\0'), target] as const)).values()],
  };
}

async function discoverDamagedExclusiveCleanupTargets(options: {
  selector: string;
  platforms: PlatformName[];
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<LiveCleanupTarget[]> {
  const parsed = parsePluginId(options.selector);
  if (!parsed.sourceId) return [];
  const targets: LiveCleanupTarget[] = [];
  for (const platform of options.platforms) {
    const root = exclusiveSkillRoot({
      platform,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
    });
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const markerPath = path.join(root, entry.name, '.agent-workflows-owner.json');
      const markerStats = await fs.lstat(markerPath).catch(() => null);
      if (!markerStats?.isFile() || markerStats.isSymbolicLink()) continue;
      const raw = await fs.readJson(markerPath).catch(() => null) as Record<string, unknown> | null;
      if (!raw
        || raw.schemaVersion !== 2
        || raw.owner !== 'agent-workflows'
        || raw.sourceId !== parsed.sourceId
        || raw.plugin !== parsed.pluginName
        || raw.pluginId !== options.selector
        || raw.platform !== platform
        || raw.scope !== options.scope) continue;
      targets.push({
        pluginId: options.selector,
        pluginName: parsed.pluginName,
        sourceId: parsed.sourceId,
        sourceIdentity: typeof raw.sourceIdentity === 'string'
          && /^sha256:[0-9a-f]{64}$/u.test(raw.sourceIdentity)
          ? raw.sourceIdentity
          : `sha256:${'0'.repeat(64)}`,
        platform,
        scope: raw.scope as Scope,
      });
    }
  }
  return [...new Map(targets.map((target) => [[target.platform, target.scope].join('\0'), target] as const)).values()];
}

async function cleanupOfflineOwnedComponents(options: {
  targets: LiveCleanupTarget[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  force: boolean;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
  nativeCliRunner?: NativeCliRunner;
  codexManager?: RebuildExecutionContext['codexManager'];
  codexManagerResolver?: typeof resolveCodexManager;
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  corruptExclusiveDirectoryOperations?: RebuildCommandRuntime['corruptExclusiveDirectoryOperations'];
}): Promise<RebuildCommandResult> {
  if (options.targets.some((target) => target.marketplaceIdentityUnresolved)) {
    throw namespacedPreflightError(
      'marketplaceIdentityUnavailable: Cannot uniquely recover the native marketplace name from live inventory or a canonical native registration path.',
      options.targets,
    );
  }
  const results: RebuildResult[] = [];
  const warnings: string[] = [];
  const nativeCliRunner = options.nativeCliRunner ?? getDefaultNativeCliRunner();
  let codexManager = options.codexManager;
  const codexManagerNeedFailures = new Map<LiveCleanupTarget, Error>();
  if (!codexManager) {
    const codexManagerRequired = (await Promise.all(options.targets.map(async (target) => {
      if (target.platform !== 'codex' || target.scope !== 'user') return false;
      try {
        return await codexNativeRemovalRequired({
          pluginName: target.pluginName,
          cwd: options.cwd,
          env: options.env,
          marketplaceName: target.marketplaceName,
          marketplaceRoot: path.join(resolveAwHome(options.env), 'marketplaces', target.sourceId),
        });
      } catch (error) {
        codexManagerNeedFailures.set(target, new Error(
          'codexNativeResidueProbeFailed: Codex native residue was retained because its config or cache evidence could not be read. Repair the damaged Codex weak state, then retry cleanup; you can also upgrade AW or install a compatible official Codex CLI.',
          { cause: error },
        ));
        return false;
      }
    }))).some(Boolean);
    if (codexManagerRequired) {
      codexManager = await (options.codexManagerResolver ?? resolveCodexManager)({
        cwd: options.cwd,
        env: options.env,
        runner: nativeCliRunner,
        authorizer: options.managedCodexAuthorizer,
      });
    }
  }
  const context: RebuildExecutionContext = {
    env: options.env,
    nativeCliRunner,
    ...(codexManager ? { codexManager } : {}),
    reporter: createNoopReporter(),
    debugLogger: createNoopDebugLogger(),
  };
  const integration = createRebuildIntegration({ context });
  const activeStore = createRebuildActiveStore({
    env: options.env,
    loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
  });
  for (const target of options.targets) {
    const exclusiveRecovery: CleanupResult = {
      removed: [], absent: [], residual: [], quarantined: [], failures: [],
    };
    if (options.force) {
      const root = exclusiveSkillRoot({
        platform: target.platform,
        scope: target.scope,
        cwd: options.cwd,
        env: options.env,
      });
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const directory = path.join(root, entry.name);
        let recovered: CleanupResult | null;
        try {
          recovered = await cleanupCorruptExclusivePluginDirectory({
            directory,
            allowedRoot: root,
            sourceId: target.sourceId,
            pluginName: target.pluginName,
            platform: target.platform,
            scope: target.scope,
            ...options.corruptExclusiveDirectoryOperations,
          });
        } catch (error) {
          recovered = {
            removed: [], absent: [], residual: [directory], quarantined: [],
            failures: [{
              label: directory,
              phase: 'mutation',
              message: error instanceof Error ? error.message : String(error),
            }],
          };
        }
        if (recovered) {
          exclusiveRecovery.removed.push(...recovered.removed);
          exclusiveRecovery.absent.push(...recovered.absent);
          exclusiveRecovery.residual.push(...recovered.residual);
          exclusiveRecovery.quarantined.push(...recovered.quarantined);
          exclusiveRecovery.failures.push(...recovered.failures);
        }
      }
    }
    const plugin = createSyntheticPlugin(target.pluginName, options.env);
    plugin.sourceId = target.sourceId;
    plugin.sourceIdentity = target.sourceIdentity;
    plugin.pluginId = target.pluginId;
    const marketplaceName = target.marketplaceName ?? 'aw';
    plugin.marketplaceName = marketplaceName;
    const desired = await integration.buildTarget({
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      pluginId: target.pluginId,
      marketplaceName,
      marketplaceRoot: path.join(resolveAwHome(options.env), 'marketplaces', target.sourceId),
      plugin,
      platform: target.platform,
      scope: target.scope,
      cwd: options.cwd,
      command: 'cleanup',
      catalog: {
        rootDir: resolveAwHome(options.env),
        source: 'local',
        catalogVersion: '0.0.0',
        channel: 'beta',
        minAwVersion: '0.0.0',
      },
      includeHistoricalLifecycleArtifacts: false,
    });
    const codexManagerNeedFailure = codexManagerNeedFailures.get(target);
    const driver = codexManagerNeedFailure && integration.driver.probeNative
      ? {
          ...integration.driver,
          probeNative: async () => {
            throw codexManagerNeedFailure;
          },
        }
      : integration.driver;
    let result = await executeRebuildOperation({
      command: 'cleanup',
      target: desired,
      driver,
      activeStore,
    });
    const exclusiveResidual = (await Promise.all(exclusiveRecovery.residual.map(async (entry) =>
      await fs.pathExists(entry) ? entry : null))).filter((entry): entry is string => entry !== null);
    const exclusiveQuarantined = (await Promise.all(exclusiveRecovery.quarantined.map(async (entry) =>
      await fs.pathExists(entry) ? entry : null))).filter((entry): entry is string => entry !== null);
    const exclusiveFailures = (await Promise.all(exclusiveRecovery.failures.map(async (failure) => {
      const residualPath = failure.quarantinePath ?? failure.label;
      return await fs.pathExists(residualPath) ? failure : null;
    }))).filter((failure): failure is CleanupResult['failures'][number] => failure !== null);
    const removed = [...new Set([...result.removed, ...exclusiveRecovery.removed])];
    const absent = [...new Set([...result.absent, ...exclusiveRecovery.absent])]
      .filter((entry) => !removed.includes(entry));
    result = {
      ...result,
      removed,
      absent,
      residual: [...new Set([...result.residual, ...exclusiveResidual])],
      quarantined: [...new Set([...result.quarantined, ...exclusiveQuarantined])],
    };
    if (exclusiveFailures.length > 0) {
      const failures = exclusiveFailures.map((failure) => ({
        phase: 'cleanup.owned' as const,
        label: failure.label,
        message: `exclusiveRecoveryFailed: ${failure.phase} ${failure.label}: ${failure.message}`,
      }));
      const message = failures[0]!.message;
      result = {
        ...result,
        status: 'failed',
        actions: [{ name: 'cleanup.owned', status: 'failed' }],
        failures: [...result.failures, ...failures],
        error: { phase: 'cleanup.owned', message },
      };
    }
    results.push(result);
  }
  const obsoleteContracts = path.join(resolveAwHome(options.env), 'installation-contracts');
  try {
    await (options.removeObsoleteInstallationContracts ?? fs.remove)(obsoleteContracts);
  } catch (error) {
    warnings.push(`obsoleteContractsCleanupFailed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return leaseSafeRebuildResult({
    platforms: [...new Set(results.map((result) => result.target.platform))],
    plugins: results.filter((result) => result.status === 'succeeded').map((result) => result.target.pluginName),
    warnings,
    rebuildResults: results,
    targetResults: results.map(toTargetResult),
    overallState: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed',
    nativePlugins: {}, repoManagedArtifacts: [],
    receiptTargets: results.map((result) => ({
      pluginName: result.target.pluginName,
      pluginId: result.target.pluginId,
      sourceId: result.target.sourceId,
      platform: result.target.platform,
      scope: result.target.scope,
    })),
  });
}

async function previewOfflineOwnedComponents(options: {
  targets: LiveCleanupTarget[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner?: NativeCliRunner;
  codexManagerPreviewer?: typeof previewCodexManager;
  onPreviewStage?: RebuildCommandRuntime['onPreviewStage'];
}): Promise<RebuildCommandResult> {
  if (options.targets.some((target) => target.marketplaceIdentityUnresolved)) {
    throw namespacedPreflightError(
      'marketplaceIdentityUnavailable: Cannot uniquely recover the native marketplace name from live inventory or a canonical native registration path.',
      options.targets,
    );
  }
  await options.onPreviewStage?.('inventory');
  const preview = mergeRebuildCommandResults([]);
  const codexManagerRequired = (await Promise.all(options.targets.flatMap((target) =>
    target.platform === 'codex' && target.scope === 'user'
      ? [codexNativeRemovalRequired({
          pluginName: target.pluginName,
          cwd: options.cwd,
          env: options.env,
          marketplaceName: target.marketplaceName,
          marketplaceRoot: path.join(resolveAwHome(options.env), 'marketplaces', target.sourceId),
        })]
      : []))).some(Boolean);
  await options.onPreviewStage?.('dependencyPlan');
  if (codexManagerRequired) {
    preview.codexManagerPreview = await (
      options.codexManagerPreviewer ?? previewCodexManager
    )({
      cwd: options.cwd,
      env: options.env,
      runner: options.nativeCliRunner,
    });
  }
  return preview;
}

async function assertOfflineCleanupDependents(options: {
  targets: LiveCleanupTarget[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const inventory = await inventoryCatalogSourceReferences({
    cwd: options.cwd,
    env: options.env,
    includeHistoricalProjects: true,
  });
  const currentProjectKey = await resolveCanonicalRepoProjectKey(options.cwd);
  for (const target of options.targets) {
    const pluginsRoot = path.join(resolveAwHome(options.env), 'marketplaces', target.sourceId, 'plugins');
    const entries = await fs.readdir(pluginsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === target.pluginName) continue;
      const consumer = await readPluginManifest(path.join(pluginsRoot, entry.name), { mode: 'bundle' })
        .catch(() => null);
      if (!consumer?.manifest.dependencies?.includes(target.pluginName)) continue;
      const consumerId = formatPluginId({ sourceId: target.sourceId, pluginName: consumer.manifest.name });
      const live = inventory.references.some((reference) =>
        (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
        && reference.sourceId === target.sourceId
        && reference.sourceIdentity === target.sourceIdentity
        && reference.pluginName === consumer.manifest.name
        && reference.platform === target.platform
        && (target.scope === 'user' || reference.scope === 'project')
        && (target.scope === 'user' || reference.projectKey === currentProjectKey));
      if (live) {
        throw namespacedPreflightError(
          `dependencyStillRequired: ${target.pluginId} is required by ${consumerId}.`,
          options.targets,
        );
      }
    }
  }
}

export async function runRebuildCommand(options: {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
  if (options.runtime?.catalogResolution && options.runtime.bypassDependencyPlan) {
    return runSingleSourceRebuildCommand(options);
  }
  const runtimeEnv = options.runtime?.env ?? process.env;
  let requestedPluginNames = options.pluginNames;
  const cleanupForce = options.command === 'cleanup'
    && (options.commandOptions as CleanupCommandOptions).force === true;
  let cleanupInventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>> | undefined;
  let cleanupLiveTargets: LiveCleanupTarget[] = [];
  let cleanupHasDamagedExclusiveTarget = false;
  let liveTargets: Array<{
    pluginId: string;
    pluginName: string;
    sourceId: string;
    sourceIdentity: string;
    platform: PlatformName;
    scope: Scope;
  }> = [];
  let legacyLiveTargets: Array<{
    pluginName: string;
    platform: PlatformName;
    scope: Scope;
  }> = [];
  if (options.command === 'cleanup' && !options.all) {
    cleanupInventory = await inventoryCatalogSourceReferences({
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
    });
    const live = resolveLiveCleanupTargets({
      selectors: requestedPluginNames,
      platforms: selectedPlatforms(options.commandOptions.platform),
      scope: options.commandOptions.scope,
      references: cleanupInventory.references,
    });
    requestedPluginNames = live.selectors;
    cleanupLiveTargets = live.targets;
    if (cleanupForce) {
      const damagedTargets = (await Promise.all(requestedPluginNames.map(async (selector) =>
        parsePluginId(selector).sourceId
          ? discoverDamagedExclusiveCleanupTargets({
              selector,
              platforms: selectedPlatforms(options.commandOptions.platform),
              scope: options.commandOptions.scope,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
            })
          : []))).flat();
      cleanupHasDamagedExclusiveTarget = damagedTargets.length > 0;
      cleanupLiveTargets = [...new Map([
        ...damagedTargets,
        ...cleanupLiveTargets,
      ].map((target) => [[target.pluginId, target.platform, target.scope].join('\0'), target] as const)).values()];
    }
    liveTargets = cleanupLiveTargets;
  }
  if (cleanupHasDamagedExclusiveTarget) {
    if (options.runtime?.previewDependencyPlanOnly) {
      return previewOfflineOwnedComponents({
        targets: cleanupLiveTargets,
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        nativeCliRunner: options.runtime.nativeCliRunner,
        codexManagerPreviewer: options.runtime.codexManagerPreviewer,
        onPreviewStage: options.runtime.onPreviewStage,
      });
    }
    return cleanupOfflineOwnedComponents({
      targets: cleanupLiveTargets,
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
      force: true,
      removeObsoleteInstallationContracts: options.runtime?.removeObsoleteInstallationContracts,
      nativeCliRunner: options.runtime?.nativeCliRunner,
      codexManager: options.runtime?.codexManager,
      codexManagerResolver: options.runtime?.codexManagerResolver,
      managedCodexAuthorizer: options.runtime?.managedCodexAuthorizer,
      corruptExclusiveDirectoryOperations: options.runtime?.corruptExclusiveDirectoryOperations,
    });
  }
  if (options.all) {
    const inventory = await inventoryCatalogSourceReferences({
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
    });
    if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(inventory);
    const requestedPlatforms = new Set(selectedPlatforms(options.commandOptions.platform));
    legacyLiveTargets = projectLegacyTargets(selectedLegacyLiveReferences(
      inventory.references,
      requestedPlatforms,
      options.commandOptions.scope,
    ));
    const live = inventory.references.filter((reference) =>
      (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
      && reference.sourceId
      && reference.pluginName
      && reference.scope === options.commandOptions.scope
      && reference.platform
      && requestedPlatforms.has(reference.platform as PlatformName));
    const projectedTargets = [...new Map(live.map((reference) => {
      const target = {
        pluginId: formatPluginId({
          sourceId: reference.sourceId!,
          pluginName: reference.pluginName!,
        }),
        pluginName: reference.pluginName!,
        sourceId: reference.sourceId!,
        sourceIdentity: reference.sourceIdentity ?? 'unavailable',
        platform: reference.platform as PlatformName,
        scope: reference.scope as Scope,
      };
      return [[
        target.pluginId,
        target.sourceIdentity,
        target.platform,
        target.scope,
      ].join('\0'), target] as const;
    })).values()];
    liveTargets = projectedTargets;
    const identities = new Map<string, string>();
    for (const reference of live) {
      if (!reference.sourceIdentity) {
        throw namespacedPreflightError(
          `legacyStateUnsupported: ${reference.location} lacks a schema 2 source identity.`,
          projectedTargets,
          legacyLiveTargets,
        );
      }
      const pluginId = formatPluginId({ sourceId: reference.sourceId!, pluginName: reference.pluginName! });
      const previous = identities.get(pluginId);
      if (previous && previous !== reference.sourceIdentity) {
        throw namespacedPreflightError(
          `sourceChanged: ${pluginId} live targets have different source identities.`,
          projectedTargets,
          legacyLiveTargets,
        );
      }
      identities.set(pluginId, reference.sourceIdentity);
    }
    requestedPluginNames = [...identities.keys()];
  }
  const selectors = requestedPluginNames.map(parsePluginId);
  const sourceIds = planPluginSelectorSourceIds(selectors);
  if (options.all && selectors.length === 0) {
    if (legacyLiveTargets.length > 0) {
      throw namespacedPreflightError(
        `legacyStateUnsupported: legacy live runtime state exists for ${legacyLiveTargets.map((target) =>
          `${target.pluginName}:${target.platform}/${target.scope}`).join(', ')}.`,
        [],
        legacyLiveTargets,
      );
    }
    return mergeRebuildCommandResults([]);
  }
  try {
    if (options.runtime?.previewDependencyPlanOnly) {
      await options.runtime.onPreviewStage?.('catalog');
    }
    const resolvedResult = await withResolvedMultiSourceCatalog({
    cliVersion: resolveRuntimeCliVersion(),
    freshnessPolicy: options.command === 'cleanup'
      ? 'cacheFirst'
      : options.runtime?.previewDependencyPlanOnly
        ? options.runtime.previewCatalogFreshnessPolicy ?? 'requireRemote'
        : 'requireRemote',
    ...(sourceIds ? { sourceIds } : {}),
    env: runtimeEnv,
    consume: async (catalog) => {
      const failedSources = catalog.sources.filter((source) => source.error);
      if (failedSources.length > 0) {
        throw namespacedPreflightError(
          `Cannot resolve required catalog sources: ${failedSources.map((source) => source.sourceId).join(', ')}.`,
          liveTargets,
          legacyLiveTargets,
        );
      }
      const available = (await Promise.all(catalog.sources.map(async (item) => {
        const source = item.resolution!;
        const plugins = await resolvePluginsFromCatalog(source.rootDir, undefined);
        return plugins.map((plugin) => {
          const pluginId = formatPluginId({ sourceId: source.sourceId, pluginName: plugin.manifest.name });
          plugin.sourceId = source.sourceId;
          plugin.sourceIdentity = source.sourceIdentity;
          plugin.pluginId = pluginId;
          return { source, plugin, pluginId };
        });
      }))).flat();
      const selected = selectors.map((selector, index) => {
        const matches = available.filter((entry) =>
          entry.plugin.manifest.name === selector.pluginName
          && (selector.sourceId === undefined || entry.source.sourceId === selector.sourceId));
        if (matches.length === 0) {
          throw new Error(`Plugin "${requestedPluginNames[index]}" does not exist in the required catalog source set.`);
        }
        if (matches.length > 1) {
          throw new Error(`Plugin "${selector.pluginName}" is ambiguous across sources: ${matches.map((entry) => entry.source.sourceId).join(', ')}.`);
        }
        return matches[0]!;
      });
      const dependencyEnabled = options.command === 'install'
        || options.command === 'upgrade'
        || options.command === 'reinstall';
      const selectedIds = new Set(selected.map((entry) => entry.pluginId));
      const resolveClosureEntries = (
        rootsBySource: typeof selected,
      ): typeof available => catalog.sources.flatMap((item) => {
        const source = item.resolution!;
        const roots = rootsBySource
          .filter((entry) => entry.source.sourceId === source.sourceId)
          .map((entry) => entry.plugin.manifest.name);
        if (roots.length === 0) return [];
        const sourcePlugins = available
          .filter((entry) => entry.source.sourceId === source.sourceId)
          .map((entry) => entry.plugin);
        const closure = resolvePluginMetaDependencyClosure(sourcePlugins, roots);
        return closure.map((plugin) => available.find((entry) =>
          entry.source.sourceId === source.sourceId
          && entry.plugin.manifest.name === plugin.manifest.name)!);
      });
      const closureEntriesByPlatform = new Map<PlatformName, typeof available>();
      if (dependencyEnabled) {
        for (const platform of selectedPlatforms(options.commandOptions.platform)) {
          const platformRoots = options.commandOptions.platform === 'both'
            ? selected.filter((entry) => supportsPlatform(entry.plugin.manifest, platform))
            : selected;
          closureEntriesByPlatform.set(platform, resolveClosureEntries(platformRoots));
        }
      }
      const closureEntries = dependencyEnabled
        ? [...new Map([...closureEntriesByPlatform.values()].flat().map((entry) =>
            [entry.pluginId, entry] as const)).values()]
        : selected;
      const rawExecutionSelections = options.all
        ? liveTargets.flatMap((target) => {
            const entry = selected.find((candidate) => candidate.pluginId === target.pluginId)!;
            if (entry.source.sourceIdentity !== target.sourceIdentity) {
              throw namespacedPreflightError(
                `sourceChanged: ${target.pluginId} live target has a different source identity.`,
                liveTargets,
                legacyLiveTargets,
              );
            }
            const sourcePlugins = available
              .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
              .map((candidate) => candidate.plugin);
            return resolvePluginMetaDependencyClosure(
              sourcePlugins,
              [entry.plugin.manifest.name],
            ).map((plugin) => ({
              entry: available.find((candidate) =>
                candidate.source.sourceId === entry.source.sourceId
                && candidate.plugin.manifest.name === plugin.manifest.name)!,
              platform: target.platform,
            }));
          })
        : selectedPlatforms(options.commandOptions.platform).flatMap((platform) =>
            (dependencyEnabled ? closureEntriesByPlatform.get(platform) ?? [] : closureEntries)
              .flatMap((entry) => options.command !== 'cleanup'
                && options.command !== 'uninstall'
                && options.commandOptions.platform === 'both'
                && !supportsPlatform(entry.plugin.manifest, platform)
                ? []
                : [{ entry, platform }]));
      let executionSelections = [...new Map(rawExecutionSelections.map((selection) => [[
        selection.entry.pluginId,
        selection.entry.source.sourceIdentity,
        selection.platform,
        options.commandOptions.scope,
      ].join('\0'), selection] as const)).values()];
      const preflightTargets = executionSelections.map(({ entry, platform }) => ({
        pluginId: entry.pluginId,
        pluginName: entry.plugin.manifest.name,
        sourceId: entry.source.sourceId,
        sourceIdentity: entry.source.sourceIdentity,
        pluginVersion: entry.plugin.manifest.version,
        platform,
        scope: options.commandOptions.scope,
      }));
      if (options.runtime?.previewDependencyPlanOnly) {
        await options.runtime.onPreviewStage?.('inventory');
      }
      const stateInventory = await inventoryCatalogSourceReferences({
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
      });
      if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(stateInventory);
      const commandProjectKey = await resolveCanonicalRepoProjectKey(options.commandOptions.cwd);
      const codexScopePathsAlias = codexProjectConfigAliasesUserHome(
        options.commandOptions.cwd,
        runtimeEnv,
      );
      const selectedLegacy = selectedLegacyLiveReferences(
        stateInventory.references,
        new Set(executionSelections.map((selection) => selection.platform)),
        options.commandOptions.scope,
      );
      const legacy = options.all
        ? selectedLegacy
        : selectedLegacy.filter((reference) => executionSelections.some((selection) =>
            selection.entry.plugin.manifest.name === reference.pluginName
            && selection.platform === reference.platform));
      if (legacy.length > 0) {
        const blockingLegacyTargets = projectLegacyTargets(legacy);
        throw namespacedPreflightError(
          `legacyStateUnsupported: legacy live runtime state exists at ${legacy.map((reference) => reference.location).join(', ')}.`,
          preflightTargets,
          blockingLegacyTargets,
        );
      }
      for (const entry of closureEntries) {
        const changed = stateInventory.references.find((reference) =>
          reference.sourceId === entry.source.sourceId
          && reference.sourceIdentity
          && reference.sourceIdentity !== entry.source.sourceIdentity);
        if (changed) {
          throw namespacedPreflightError(
            `sourceChanged: ${entry.source.sourceId} state at ${changed.location} has a different source identity.`,
            options.all
              ? preflightTargets
              : preflightTargets.filter((target) => target.pluginId === entry.pluginId),
          );
        }
      }
      const marketplaceNamesBySource = new Map<string, string>();
      for (const entry of new Map(closureEntries.map((candidate) => [
        candidate.source.sourceId,
        candidate,
      ] as const)).values()) {
        const sourceNames = new Set(stateInventory.references.flatMap((reference) =>
          (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
          && reference.sourceId === entry.source.sourceId
          && (reference.sourceIdentity === undefined
            || reference.sourceIdentity === entry.source.sourceIdentity)
          && reference.marketplaceName
            ? [reference.marketplaceName]
            : []));
        if (sourceNames.size > 1) {
          throw new Error(
            'marketplaceIdentityUnavailable: Multiple canonical native marketplace registrations match the source.',
          );
        }
        const persistedName = [...sourceNames][0];
        const marketplaceRoot = path.join(
          resolveAwHome(runtimeEnv),
          'marketplaces',
          entry.source.sourceId,
        );
        let marketplaceName = persistedName
          ?? (entry.source.sourceId === catalog.primarySourceId
            ? 'aw'
            : getNamespacedMarketplaceName(entry.source.sourceId));
        if (options.command === 'cleanup' || options.command === 'uninstall') {
          marketplaceNamesBySource.set(entry.source.sourceId, marketplaceName);
          continue;
        }
        let registrations = await inspectNativeMarketplaceRegistrations({
          marketplaceName,
          marketplaceRoot,
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
        });
        if (!persistedName
          && marketplaceName === 'aw'
          && Object.values(registrations).includes('foreign')) {
          marketplaceName = getNamespacedMarketplaceName(entry.source.sourceId);
          registrations = await inspectNativeMarketplaceRegistrations({
            marketplaceName,
            marketplaceRoot,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
        }
        const foreignPlatforms = (Object.entries(registrations) as Array<[
          PlatformName,
          'absent' | 'canonical' | 'foreign',
        ]>).flatMap(([platform, state]) => state === 'foreign' ? [platform] : []);
        if (foreignPlatforms.length > 0) {
          throw new Error(
            `externalOwnershipPresent: Marketplace ${marketplaceName} is foreign on ${foreignPlatforms.join(', ')}.`,
          );
        }
        marketplaceNamesBySource.set(entry.source.sourceId, marketplaceName);
      }
      const marketplaceNameFor = (
        entry: (typeof available)[number],
        ..._placement: [PlatformName, Scope, (string | null)?]
      ): string => {
        const marketplaceName = marketplaceNamesBySource.get(entry.source.sourceId);
        if (!marketplaceName) {
          throw new Error('marketplaceIdentityUnavailable: No marketplace name was selected for the source.');
        }
        return marketplaceName;
      };
      const executionContext: RebuildExecutionContext = {
        env: runtimeEnv,
        nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
        reporter: options.runtime?.reporter ?? createNoopReporter(),
        debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
        expectedCatalogConfigDigest: catalog.configDigest,
      };
      const inspection = createRebuildIntegration({
        context: executionContext,
        scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
      });
      const createPlan = async (
        preparedInventory?: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
      ): Promise<DependencyOperationPlan> => {
        const inventory = preparedInventory ?? await inventoryCatalogSourceReferences({
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
        });
        if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(inventory);
        const targets = [];
        for (const [order, { entry, platform }] of executionSelections.entries()) {
          const relation = selectedIds.has(entry.pluginId) ? 'requested' as const : 'dependency' as const;
          let resolvedScope = options.commandOptions.scope;
          const inspectScope = async (scope: Scope) => {
            const marketplaceName = marketplaceNameFor(entry, platform, scope);
            entry.plugin.marketplaceName = marketplaceName;
            const desired = await inspection.buildTarget({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              marketplaceName,
              marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
              plugin: entry.plugin,
              platform,
              scope,
              cwd: options.commandOptions.cwd,
              command: options.command,
              catalog: toCatalogResolution(entry.source),
              includeHistoricalLifecycleArtifacts: false,
              readOnlyInspectionPlan: true,
            });
            const result = await inspectOwnedComponents({
              components: desired.ownedComponents,
              nativeProbe: inspection.driver.probeNative,
              verifyHealth: true,
            });
            if (result.state === 'error'
              || result.components.some((component) => component.state === 'error')) return result;
            const required = new Set(desired.desiredOwnedComponents ?? desired.ownedComponents);
            const optional = new Set(desired.optionalOwnedComponents ?? []);
            const presentRequired = [...required].every((component) => result.components.some((entry) =>
              entry.component === component && entry.state === 'present'));
            const hasUnexpectedPresent = result.components.some((entry) =>
              entry.state === 'present' && !required.has(entry.component) && !optional.has(entry.component));
            const hasPartial = result.components.some((entry) => entry.state === 'partial');
            const hasAnyPresent = result.components.some((entry) => entry.state === 'present');
            const state: 'absent' | 'present' | 'partial' = !hasAnyPresent
              && result.components.every((entry) => entry.state === 'absent')
              ? 'absent'
              : hasPartial || hasUnexpectedPresent || !presentRequired
              ? 'partial'
              : required.size > 0
                ? 'present'
                : hasAnyPresent ? 'present' : 'absent';
            return { ...result, state };
          };
          const otherScope = resolvedScope === 'user' ? 'project' : 'user';
          const [requestedInspection, otherInspection] = await Promise.all([
            inspectScope(resolvedScope),
            platform === 'codex' && codexScopePathsAlias && resolvedScope === 'user'
              ? Promise.resolve({ state: 'absent' as const, components: [], errors: [] })
              : inspectScope(otherScope),
          ]);
          let state: 'absent' | 'present' | 'partial' | 'error' = requestedInspection.state;
          let action: 'install' | 'upgrade' | 'reinstall' | 'keep' | 'block' = relation === 'requested'
            ? options.command as 'install' | 'upgrade' | 'reinstall'
            : options.command === 'reinstall' ? 'reinstall' : 'upgrade';
          let errorCode: string | undefined;
          const hasForeignCollision = [...requestedInspection.components, ...otherInspection.components]
            .some((component) => component.diagnostic?.includes('foreign collision'));
          if (dependencyEnabled && hasForeignCollision) {
            action = 'block';
            errorCode = 'artifactCollision';
          } else if (dependencyEnabled && relation === 'requested'
            && (requestedInspection.state === 'error'
              || (requestedInspection.state === 'partial' && options.command !== 'reinstall'))) {
            action = 'block';
            errorCode = 'dependencyNotReady';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && requestedInspection.state === 'present'
            && otherInspection.state === 'present') {
            action = 'block';
            state = 'partial';
            errorCode = 'dependencyScopeConflict';
          } else if (!hasForeignCollision && relation === 'dependency'
            && options.commandOptions.scope === 'project'
            && otherInspection.state === 'present') {
            resolvedScope = 'user';
            state = 'present';
          } else if (!hasForeignCollision && relation === 'dependency'
            && options.commandOptions.scope === 'project'
            && (otherInspection.state === 'partial' || otherInspection.state === 'error')) {
            resolvedScope = 'user';
            state = otherInspection.state;
            if (otherInspection.state === 'error') {
              action = 'block';
              errorCode = 'dependencyNotReady';
            }
          } else if (!hasForeignCollision && relation === 'dependency'
            && options.commandOptions.scope === 'user'
            && otherInspection.state !== 'absent') {
            action = 'block';
            errorCode = 'dependencyScopeTooNarrow';
          }
          const resolvedInspection = resolvedScope === options.commandOptions.scope
            ? requestedInspection
            : otherInspection;
          state = resolvedInspection.state;
          if (!hasForeignCollision && !errorCode
            && relation === 'dependency' && options.command === 'install') {
            action = state === 'present' ? 'keep' : state === 'partial' ? 'reinstall' : 'install';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && resolvedInspection.state === 'error') {
            action = 'block';
            state = resolvedInspection.state;
            errorCode ??= 'dependencyNotReady';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && platform === 'codex'
            && resolvedScope === 'project'
            && (entry.plugin.manifest.apps || !hasCodexProjectManagedArtifacts(entry.plugin))) {
            action = 'block';
            errorCode = 'dependencyTargetUnsupported';
          }
          if (entry.plugin.manifest.config?.schema
            && (action === 'install' || action === 'upgrade' || action === 'reinstall')) {
            const effective = await resolveEffectivePluginConfig({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginName: entry.plugin.manifest.name,
              manifest: entry.plugin.manifest,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
            });
            if (effective.issues.length > 0) {
              action = 'block';
              errorCode = 'invalidConfig';
            }
          }
          if (dependencyEnabled
            && platform === 'codex'
            && resolvedScope === 'project'
            && codexScopePathsAlias) {
            action = 'block';
            errorCode = 'codexScopePathAlias';
          }
          targets.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            platform,
            requestedScope: options.commandOptions.scope,
            resolvedScope,
            relation,
            requiredBy: executionSelections.filter((candidate) =>
              candidate.platform === platform
              && candidate.entry.source.sourceId === entry.source.sourceId
              && candidate.entry.plugin.manifest.dependencies?.includes(entry.plugin.manifest.name))
              .map((candidate) => candidate.entry.pluginId).sort(),
            state,
            action,
            order,
            ...(errorCode ? { errorCode } : {}),
          });
        }
        return createDependencyOperationPlan({
          requestedPluginIds: selected.map((entry) => entry.pluginId),
          resolvedPluginIds: closureEntries.map((entry) => entry.pluginId),
          dependencyEdges: closureEntries.flatMap((entry) =>
            (entry.plugin.manifest.dependencies ?? []).map((dependency) => ({
              from: entry.pluginId,
              to: formatPluginId({ sourceId: entry.source.sourceId, pluginName: dependency }),
            }))),
          targets,
        });
      };
      const operationNeedsNativeCli = async (
        platform: PlatformName,
        plan?: DependencyOperationPlan,
      ): Promise<boolean> => {
        for (const { entry, platform: selectedPlatform } of executionSelections) {
          if (selectedPlatform !== platform) continue;
          const planned = plan?.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === selectedPlatform);
          if (dependencyEnabled && (!planned
            || planned.action === 'keep'
            || planned.action === 'block')) continue;
          const scope = planned?.resolvedScope ?? options.commandOptions.scope;
          const marketplaceName = marketplaceNameFor(entry, selectedPlatform, scope);
          entry.plugin.marketplaceName = marketplaceName;
          const marketplaceRoot = path.join(
            resolveAwHome(runtimeEnv),
            'marketplaces',
            entry.source.sourceId,
          );
          if (!dependencyEnabled && selectedPlatform === 'codex') {
            if (scope === 'user' && await codexNativeRemovalRequired({
              pluginName: entry.plugin.manifest.name,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              marketplaceName,
              marketplaceRoot,
            })) return true;
            continue;
          }
          const target = await inspection.buildTarget({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginId: entry.pluginId,
            marketplaceName,
            marketplaceRoot,
            plugin: entry.plugin,
            platform: selectedPlatform,
            scope,
            cwd: options.commandOptions.cwd,
            command: dependencyEnabled
              ? planned!.action as 'install' | 'upgrade' | 'reinstall'
              : options.command,
            catalog: toCatalogResolution(entry.source),
            includeHistoricalLifecycleArtifacts: false,
            readOnlyInspectionPlan: true,
          });
          if (dependencyEnabled && target.requiresNative) return true;
          const nativeComponents = target.ownedComponents.filter((component) =>
            component.kind === 'native-plugin'
            || (component.kind === 'shared-config'
              && component.identity.artifactKey.startsWith('marketplace-')));
          if (nativeComponents.length === 0) continue;
          const nativeInspection = await inspectOwnedComponents({
            components: nativeComponents,
            nativeProbe: inspection.driver.probeNative,
          });
          if (nativeInspection.components.some((component) =>
            component.state === 'present' || component.state === 'partial')) {
            return true;
          }
        }
        return false;
      };
      if (options.runtime?.previewDependencyPlanOnly) {
        await options.runtime.onPreviewStage?.('dependencyPlan');
        const initialPlan = dependencyEnabled ? await createPlan(stateInventory) : undefined;
        const preview = mergeRebuildCommandResults([]);
        if (initialPlan) preview.dependencyPlan = initialPlan;
        if (await operationNeedsNativeCli('codex', initialPlan)) {
          preview.codexManagerPreview = await (
            options.runtime.codexManagerPreviewer ?? previewCodexManager
          )({
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            runner: options.runtime?.nativeCliRunner,
          });
        }
        return preview;
      }
      for (const { entry, platform } of executionSelections.filter((selection) =>
          selectedIds.has(selection.entry.pluginId))) {
          await options.runtime?.reviewPreflight?.({
            command: options.command,
            identity: {
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              pluginName: entry.plugin.manifest.name,
              pluginVersion: entry.plugin.manifest.version,
              platform,
              scope: options.commandOptions.scope,
              cwd: options.commandOptions.cwd,
            },
            configDigest: catalog.configDigest,
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            resolvedCommit: entry.source.resolvedCommit,
            manifestDigest: entry.source.manifestDigest,
            snapshotDigest: entry.source.snapshotDigest,
            contentDigest: entry.source.manifest.entries.find((candidate) =>
              candidate.name === entry.plugin.manifest.name)?.contentDigest,
          });
      }
        const lockedPlan = await createPlan();
        for (const pluginName of new Set(lockedPlan.targets.flatMap((target) =>
          target.platform === 'claude'
          && (target.action === 'install'
            || target.action === 'upgrade'
            || target.action === 'reinstall')
            ? [target.pluginName]
            : []))) {
          await assertNoClaudeUnboundNativeNameCollision({
            pluginName,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
        }
        const codexManagerRequired = await operationNeedsNativeCli('codex', lockedPlan);
        const claudeCliRequired = await operationNeedsNativeCli('claude', lockedPlan);
        if (codexManagerRequired) {
          executionContext.codexManager = await (
            options.runtime?.codexManagerResolver ?? resolveCodexManager
          )({
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            runner: executionContext.nativeCliRunner,
            authorizer: options.runtime?.managedCodexAuthorizer,
          });
        }
        await assertClaudeVersion({
          platforms: claudeCliRequired ? ['claude'] : [],
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
          runtime: executionContext,
        });
        const executionIntegration = createRebuildIntegration({
          context: executionContext,
          scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
        });
        const preparedTargets = new Map<string, PreparedRebuildTarget>();
        const preparedTargetErrors = new Map<string, unknown>();
        const lockedCollisionSelections = [];
        for (const { entry, platform } of executionSelections) {
          const planned = lockedPlan.targets.find((candidate) =>
            candidate.pluginId === entry.pluginId && candidate.platform === platform)!;
          if (planned.action !== 'install'
            && planned.action !== 'upgrade'
            && planned.action !== 'reinstall') continue;
          const marketplaceName = marketplaceNameFor(entry, platform, planned.resolvedScope);
          try {
            const target = await executionIntegration.buildTarget({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              marketplaceName,
              marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
              plugin: entry.plugin,
              platform,
              scope: planned.resolvedScope,
              cwd: options.commandOptions.cwd,
              command: planned.relation === 'dependency' ? planned.action : options.command,
              catalog: toCatalogResolution(entry.source),
              includeHistoricalLifecycleArtifacts: true,
            });
            preparedTargets.set(`${entry.pluginId}\0${platform}`, {
              target,
              driver: executionIntegration.driver,
              context: executionContext,
            });
            if (selectedIds.has(entry.pluginId)) {
              await rebuildCommandTestHooks?.afterTargetBuilt?.({
                command: options.command,
                identity: target.identity,
              });
            }
            lockedCollisionSelections.push({
              pluginId: entry.pluginId,
              targetKey: `${platform}/${target.identity.scope}`,
              artifactKeys: (target.desiredOwnedComponents ?? target.ownedComponents)
                .filter((component) => !(component.kind === 'shared-config'
                  && component.identity.artifactKey.startsWith('marketplace-')))
                .map((component) => 'path' in component
                  ? path.resolve(component.path)
                  : component.kind === 'native-plugin'
                    ? `native:${component.pluginId}`
                    : `shared:${component.label}`),
            });
          } catch (error) {
            preparedTargetErrors.set(`${entry.pluginId}\0${platform}`, error);
          }
        }
        const lockedCollisions = preflightDesiredArtifactCollisions(lockedCollisionSelections);
        if (lockedCollisions.length > 0) {
          throw namespacedPreflightError(
            `artifactCollision: ${lockedCollisions.map((collision) =>
              `${collision.targetKey} (${collision.pluginIds.join(', ')})`).join('; ')}`,
            preflightTargets,
          );
        }
        const removalRequiredConsumers = new Map<string, Set<string>>();
        if ((options.command === 'cleanup' && !cleanupForce) || options.command === 'uninstall') {
          const removalStateInventory = await inventoryCatalogSourceReferences({
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            includeHistoricalProjects: true,
          });
          if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(removalStateInventory);
          const inspectConsumer = async (options_: {
            entry: (typeof available)[number];
            platform: PlatformName;
            scope: Scope;
            cwd: string;
          }): Promise<'absent' | 'live'> => {
            const marketplaceName = marketplaceNameFor(
              options_.entry,
              options_.platform,
              options_.scope,
              options_.scope === 'project' ? options_.cwd : null,
            );
            options_.entry.plugin.marketplaceName = marketplaceName;
            const consumerTarget = await inspection.buildTarget({
              sourceId: options_.entry.source.sourceId,
              sourceIdentity: options_.entry.source.sourceIdentity,
              pluginId: options_.entry.pluginId,
              marketplaceName,
              marketplaceRoot: path.join(
                resolveAwHome(runtimeEnv),
                'marketplaces',
                options_.entry.source.sourceId,
              ),
              plugin: options_.entry.plugin,
              platform: options_.platform,
              scope: options_.scope,
              cwd: options_.cwd,
              command: 'cleanup',
              catalog: toCatalogResolution(options_.entry.source),
              includeHistoricalLifecycleArtifacts: false,
              readOnlyInspectionPlan: true,
            });
            const consumerInspection = await inspectOwnedComponents({
              components: consumerTarget.ownedComponents,
              nativeProbe: inspection.driver.probeNative,
              verifyHealth: true,
            });
            return consumerInspection.state === 'absent' ? 'absent' : 'live';
          };
          const currentConsumerCandidates = [...new Map(removalStateInventory.references.flatMap((reference) => {
            if ((reference.kind !== 'namespacedOwner' && reference.kind !== 'namespacedMarketplace')
              || !reference.sourceId
              || !reference.sourceIdentity
              || !reference.pluginName
              || (reference.platform !== 'codex' && reference.platform !== 'claude')
              || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
            const entry = available.find((candidate) =>
              candidate.source.sourceId === reference.sourceId
              && candidate.source.sourceIdentity === reference.sourceIdentity
              && candidate.plugin.manifest.name === reference.pluginName);
            if (!entry) return [];
            if (reference.scope === 'project' && !reference.projectKey) {
              throw namespacedPreflightError(
                `dependencyStillRequired: cannot inspect project consumer ${entry.pluginId} without its project identity.`,
                preflightTargets,
              );
            }
            const key = [
              entry.pluginId,
              reference.platform,
              reference.scope,
              reference.projectKey ?? '',
            ].join('\0');
            return [[key, {
              entry,
              platform: reference.platform,
              scope: reference.scope,
              projectKey: reference.projectKey ?? null,
            }] as const];
          })).values()];
          for (const dependencyTarget of executionSelections) {
            const dependencyPluginName = dependencyTarget.entry.plugin.manifest.name;
            for (const consumer of currentConsumerCandidates) {
              if (consumer.entry.source.sourceId
                  !== dependencyTarget.entry.source.sourceId
                || !consumer.entry.plugin.manifest.dependencies?.includes(dependencyPluginName)
                || consumer.platform !== dependencyTarget.platform
                || (consumer.scope === 'user'
                  && options.commandOptions.scope !== 'user')
                || (options.commandOptions.scope === 'project'
                  && consumer.scope === 'project'
                  && consumer.projectKey !== commandProjectKey)) continue;
              const plannedConsumer = executionSelections.find((selection) =>
                selection.entry.pluginId === consumer.entry.pluginId
                && selection.platform === consumer.platform
                && lockedPlan.targets.some((target) =>
                  target.pluginId === selection.entry.pluginId
                  && target.platform === selection.platform
                  && target.resolvedScope === consumer.scope
                  && (consumer.scope === 'user' || consumer.projectKey === commandProjectKey)));
              if (plannedConsumer) {
                const dependencyExecutionKey = `${dependencyTarget.entry.pluginId}\0${consumer.platform}`;
                const required = removalRequiredConsumers.get(dependencyExecutionKey) ?? new Set<string>();
                required.add(`${consumer.entry.pluginId}\0${consumer.platform}`);
                removalRequiredConsumers.set(dependencyExecutionKey, required);
                continue;
              }
              try {
                if (await inspectConsumer({
                  entry: consumer.entry,
                  platform: consumer.platform,
                  scope: consumer.scope,
                  cwd: consumer.projectKey ?? options.commandOptions.cwd,
                }) !== 'absent') {
                  throw new Error('consumer is present, partial, or unreadable');
                }
              } catch {
                throw namespacedPreflightError(
                  `dependencyStillRequired: ${dependencyTarget.entry.pluginId} is required by ${consumer.entry.pluginId}.`,
                  preflightTargets,
                );
              }
            }
          }
          const orderedSelections: typeof executionSelections = [];
          const remaining = new Set(executionSelections);
          while (remaining.size > 0) {
            const ready = [...remaining].filter((candidate) => ![...remaining].some((consumer) =>
              consumer.platform === candidate.platform
              && consumer.entry.source.sourceId === candidate.entry.source.sourceId
              && consumer.entry.plugin.manifest.dependencies?.includes(candidate.entry.plugin.manifest.name)))
              .sort((left, right) => left.entry.pluginId.localeCompare(right.entry.pluginId, 'en'));
            if (ready.length === 0) {
              throw namespacedPreflightError(
                'dependencyGraphInvalid: removal graph contains a cycle.',
                preflightTargets,
              );
            }
            for (const selection of ready) {
              orderedSelections.push(selection);
              remaining.delete(selection);
            }
          }
          executionSelections = orderedSelections;
        }
      const results: RebuildCommandResult[] = [];
      const dependencyStates = new Map<string, 'completed' | 'kept' | 'failed' | 'skipped'>();
      for (const { entry, platform } of executionSelections) {
        const planned = lockedPlan.targets.find((target) =>
          target.pluginId === entry.pluginId && target.platform === platform)!;
        const directDependencyIds = (entry.plugin.manifest.dependencies ?? []).map((pluginName) =>
          formatPluginId({ sourceId: entry.source.sourceId, pluginName }));
        const failedDependency = directDependencyIds.find((pluginId) => {
          const state = dependencyStates.get(`${pluginId}\0${platform}`);
          return state === 'failed' || state === 'skipped';
        });
        const failedConsumer = [...(removalRequiredConsumers.get(`${entry.pluginId}\0${platform}`) ?? [])]
          .find((consumerKey) => {
            const state = dependencyStates.get(consumerKey);
            return state === 'failed' || state === 'skipped';
          });
        const identity: RebuildTargetIdentity = {
          sourceId: entry.source.sourceId,
          sourceIdentity: entry.source.sourceIdentity,
          pluginId: entry.pluginId,
          pluginName: entry.plugin.manifest.name,
          pluginVersion: entry.plugin.manifest.version,
          platform,
          scope: planned.resolvedScope,
          cwd: options.commandOptions.cwd,
        };
        if (failedDependency || failedConsumer || planned.action === 'block') {
          const code = failedConsumer
            ? 'dependencyStillRequired'
            : failedDependency ? 'dependencyInstallFailed' : planned.errorCode ?? 'dependencyNotReady';
          const message = `${code}: ${failedConsumer
            ? `${entry.pluginId} retained because consumer ${failedConsumer.split('\0', 1)[0]} was not removed.`
            : failedDependency
            ? `${entry.pluginId} requires failed dependency ${failedDependency}.`
            : code === 'artifactCollision'
              ? `${entry.pluginId} has foreign-owned output. Remove or relocate it, then run cleanup and reinstall.`
              : code === 'dependencyNotReady'
                ? `${entry.pluginId} live state is unreadable. Run cleanup, then reinstall.`
                : `${entry.pluginId} dependency preflight is blocked.`}`;
          const result = failedResult(options.command, identity, message);
          results.push({
            platforms: [platform], plugins: [], warnings: [], rebuildResults: [result],
            targetResults: [{
              target: identity,
              action: failedDependency || failedConsumer ? 'skipped' : planned.action,
              state: 'failed',
              errorCode: code,
              message,
            }],
            overallState: 'failed', nativePlugins: {}, repoManagedArtifacts: [],
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(`${entry.pluginId}\0${platform}`,
            failedDependency || failedConsumer ? 'skipped' : 'failed');
          continue;
        }
        if (planned.action === 'keep') {
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity, actions: [],
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
          results.push({
            platforms: [platform], plugins: [identity.pluginName], warnings: [], rebuildResults: [result],
            targetResults: [{ target: identity, action: 'keep', state: 'completed' }],
            overallState: 'succeeded', nativePlugins: {}, repoManagedArtifacts: [],
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(`${entry.pluginId}\0${platform}`, 'kept');
          continue;
        }
        const marketplaceName = marketplaceNameFor(entry, platform, planned.resolvedScope);
        const namespacedSource = {
          sourceId: entry.source.sourceId,
          sourceIdentity: entry.source.sourceIdentity,
          marketplaceName,
          marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
        };
        entry.plugin.marketplaceName = marketplaceName;
        const executionResult = await runSingleSourceRebuildCommand({
          ...options,
          command: planned.relation === 'dependency'
            ? planned.action as 'install' | 'upgrade' | 'reinstall'
            : options.command,
          pluginNames: [entry.plugin.manifest.name],
          all: false,
          commandOptions: { ...options.commandOptions, platform, scope: planned.resolvedScope },
          runtime: {
            ...options.runtime,
            env: runtimeEnv,
            ...(executionContext.codexManager
              ? { codexManager: executionContext.codexManager }
              : {}),
            catalogResolution: toCatalogResolution(entry.source),
            namespacedSource,
            dependencyReviewPreflightHandled: true,
            targetBuiltHookHandled: true,
            preparedTarget: preparedTargets.get(`${entry.pluginId}\0${platform}`),
            preparedTargetError: preparedTargetErrors.get(`${entry.pluginId}\0${platform}`),
            expectedCatalogConfigDigest: catalog.configDigest,
            resolvedReviewEvidenceByPlugin: {
              [entry.plugin.manifest.name]: {
                configDigest: catalog.configDigest,
                sourceId: entry.source.sourceId,
                sourceIdentity: entry.source.sourceIdentity,
                resolvedCommit: entry.source.resolvedCommit,
                manifestDigest: entry.source.manifestDigest,
                snapshotDigest: entry.source.snapshotDigest,
                contentDigest: entry.source.manifest.entries.find((candidate) =>
                  candidate.name === entry.plugin.manifest.name)?.contentDigest,
              },
            },
          },
        });
        results.push(executionResult);
        dependencyStates.set(`${entry.pluginId}\0${platform}`,
          executionResult.overallState === 'succeeded' ? 'completed' : 'failed');
      }
      const merged = mergeRebuildCommandResults(results);
      merged.dependencyPlan = lockedPlan;
      return leaseSafeRebuildResult(merged);
    },
    });
    if (cleanupForce && !options.runtime?.previewDependencyPlanOnly) {
      try {
        await (options.runtime?.removeObsoleteInstallationContracts ?? fs.remove)(
          path.join(resolveAwHome(runtimeEnv), 'installation-contracts'),
        );
      } catch (error) {
        resolvedResult.warnings.push(
          `obsoleteContractsCleanupFailed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return resolvedResult;
  } catch (error) {
    if (options.all && (liveTargets.length > 0 || legacyLiveTargets.length > 0)) {
      const projected = error as {
        namespacedTargets?: Parameters<typeof namespacedPreflightError>[1];
        legacyTargets?: Parameters<typeof namespacedPreflightError>[2];
      };
      error = namespacedPreflightError(
        error instanceof Error ? error.message : String(error),
        projected.namespacedTargets ?? liveTargets,
        projected.legacyTargets ?? legacyLiveTargets,
      );
    }
    if (options.command !== 'cleanup' && options.command !== 'uninstall') throw error;
    const message = error instanceof Error ? error.message : String(error);
    const catalogUnavailable = message.startsWith('Cannot resolve required catalog sources:')
      || message.includes('does not exist in the required catalog source set')
      || (message.includes('Catalog source') && message.includes('does not exist'));
    if (options.command === 'cleanup'
      && (catalogUnavailable || message.includes('sourceChanged'))
      && cleanupInventory
      && cleanupLiveTargets.length > 0) {
      if (!cleanupForce) {
        await assertOfflineCleanupDependents({
          targets: cleanupLiveTargets,
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
        });
      }
      if (options.runtime?.previewDependencyPlanOnly) {
        return previewOfflineOwnedComponents({
          targets: cleanupLiveTargets,
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
          nativeCliRunner: options.runtime.nativeCliRunner,
          codexManagerPreviewer: options.runtime.codexManagerPreviewer,
          onPreviewStage: options.runtime.onPreviewStage,
        });
      }
      return cleanupOfflineOwnedComponents({
        targets: cleanupLiveTargets,
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        force: cleanupForce,
        removeObsoleteInstallationContracts: options.runtime?.removeObsoleteInstallationContracts,
        nativeCliRunner: options.runtime?.nativeCliRunner,
        codexManager: options.runtime?.codexManager,
        codexManagerResolver: options.runtime?.codexManagerResolver,
        managedCodexAuthorizer: options.runtime?.managedCodexAuthorizer,
        corruptExclusiveDirectoryOperations: options.runtime?.corruptExclusiveDirectoryOperations,
      });
    }
    if (options.command === 'uninstall' && catalogUnavailable) {
      throw namespacedPreflightError(
        `catalogSourceUnavailable: ${message} Restore the source to run lifecycle uninstall, or use cleanup; use cleanup --force only for exclusively owned damaged output.`,
        liveTargets,
        legacyLiveTargets,
      );
    }
    if ((message.includes('Catalog source') && message.includes('does not exist'))
      || message.includes('does not exist in the required catalog source set')) {
      throw namespacedPreflightError(
        `sourceMissing: ${message} Run cleanup for owner recovery, or cleanup --force for an exclusively owned damaged target.`,
        liveTargets,
        legacyLiveTargets,
      );
    }
    throw error;
  }
}
