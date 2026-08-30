import path from 'node:path';

import type {
  CatalogSourceResolution,
  CatalogResolution,
  CommandOptions,
  GeneratedArtifact,
  InstallCommandOptions,
  PlatformName,
  PluginMeta,
  ReceiptOverallState,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import fs from 'fs-extra';
import type { RebuildActionEvent } from '../output/model.js';
import { getCodexOperationRequirement, probeAgentVersion } from '../utils/agent-version.js';
import {
  previewCodexManager,
  resolveCodexManager,
  resolveCodexOperationConsumer,
  type CodexManagerPreview,
  type ManagedCodexAuthorizer,
} from '../utils/codex-manager.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { createNoopReporter } from '../output/reporter.js';
import { getDefaultNativeCliRunner, type NativeCliRunner } from '../utils/native-cli.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveAwHome, resolveCodexPaths } from '../utils/paths.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import {
  createCodexReconcilePlan,
  type CodexReconcilePlan,
  type CodexReconcilerCatalogTarget,
  type CodexReconcilerLiveEvidence,
} from '../utils/codex-reconciler.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
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
  createRebuildIntegration,
  discoverRebuildTargetNames,
  executeCodexReconcileActivations,
  inspectCodexNativeResidue,
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
  type DesiredArtifactSelection,
} from '../utils/multi-source-catalog.js';
import {
  resolveCatalogOperationContext,
  type CatalogOperationContext,
} from '../utils/catalog-operation-context.js';
import type { CatalogGenerationServiceRuntime } from '../utils/catalog-generation-service.js';
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
  canonicalizePluginIntentState,
  convergePluginIntentManagedCodexOwnership,
  createEmptyPluginIntentState,
  mergePluginIntentRootPlatforms,
  readPluginIntentState,
  removePluginIntentRootPlatforms,
  widenPluginIntentManagedCodexOwnership,
  writePluginIntentState,
  type PluginIntentState,
} from '../utils/plugin-intent-state.js';
import { validateCatalogSnapshotPluginEntriesComplete } from '../utils/catalog-snapshot.js';
import {
  AwCapabilityUnsupportedError,
  IMPLEMENTED_AW_CAPABILITIES,
} from './aw-capabilities.js';
import { checkAwCapabilitySupport } from '../utils/manifest.js';
import {
  createDependencyOperationPlan,
  createDependencyPlacementPlan,
  type DependencyOperationPlan,
  type DependencyPlacementNodeInput,
} from './dependency-operation-plan.js';
import type { CleanupCommandOptions } from './options.js';
import {
  offlineCleanupEvidenceFromInventory,
  offlineCleanupEvidenceMatches,
  type OfflineCleanupTargetEvidence,
} from './offline-cleanup-evidence.js';

export type RebuildCommandRuntime = Partial<RebuildExecutionContext> & {
  awHomeMutationToken?: AwHomeMutationToken;
  catalogResolution?: CatalogResolution;
  resolvedCatalogPlugins?: PluginMeta[];
  namespacedSource?: {
    sourceId: string;
    sourceIdentity: string;
    marketplaceName: string;
    marketplaceRoot: string;
  };
  expectedCatalogConfigDigest?: string;
  expectedGenerationSetDigest?: string;
  catalogOperationContext?: CatalogOperationContext;
  catalogBootstrapError?: unknown;
  catalogGenerationRuntime?: CatalogGenerationServiceRuntime;
  inventoryCatalogSourceReferences?: typeof inventoryCatalogSourceReferences;
  expectedOperationDependencyPlan?: DependencyOperationPlan;
  expectedCodexReconcilePlans?: CodexReconcilePlan[];
  expectedOfflineCleanupEvidence?: OfflineCleanupTargetEvidence;
  reviewPreflight?: (evidence: RebuildReviewPreflightEvidence) => Promise<void> | void;
  resolvedReviewEvidenceByPlugin?: Record<
    string,
    Omit<RebuildReviewPreflightEvidence, 'command' | 'identity'>
  >;
  bypassDependencyPlan?: boolean;
  dependencyReviewPreflightHandled?: boolean;
  previewDependencyPlanOnly?: boolean;
  reconcileIntentOnly?: boolean;
  directCli?: boolean;
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  codexManagerResolver?: typeof resolveCodexManager;
  codexOperationConsumerResolver?: typeof resolveCodexOperationConsumer;
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

export type CommandPerformanceStageName =
  | 'catalog.context'
  | 'catalog.validation'
  | 'inventory'
  | 'dependency.plan'
  | 'target.build';

async function measureCommandPerformanceStage<T>(
  runtime: RebuildCommandRuntime | undefined,
  name: CommandPerformanceStageName,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  let phase: 'success' | 'failure' = 'success';
  try {
    return await operation();
  } catch (error) {
    phase = 'failure';
    throw error;
  } finally {
    await Promise.resolve().then(() => runtime?.debugLogger?.log({
      type: 'performance:stage',
      level: 'debug',
      target: 'debugLog',
      message: 'Command performance stage completed.',
      data: {
        name,
        phase,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
    })).catch(() => undefined);
  }
}

export interface RebuildReviewPreflightEvidence {
  command: RebuildCommand;
  identity: RebuildTargetIdentity;
  configDigest?: string;
  generationSetDigest?: string;
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
  codexReconcilePlans?: CodexReconcilePlan[];
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

function updateIntentOverrides(options: {
  state: PluginIntentState;
  plan: DependencyOperationPlan;
}): PluginIntentState {
  const plannedKeys = new Set(options.plan.targets.map((target) =>
    `${target.pluginId}\0${target.platform}`));
  return canonicalizePluginIntentState({
    ...options.state,
    dependencyScopeOverrides: [
      ...options.state.dependencyScopeOverrides.filter((override) =>
        !plannedKeys.has(`${override.pluginId}\0${override.platform}`)),
      ...options.plan.scopeOverrides,
    ],
  });
}

function effectiveDependencyScopeOverrides(options: {
  state: PluginIntentState;
  explicit: NonNullable<InstallCommandOptions['dependencyScopeOverrides']>;
  nodes: readonly DependencyPlacementNodeInput[];
  ignoredPersistedRootIds?: ReadonlySet<string>;
}): NonNullable<InstallCommandOptions['dependencyScopeOverrides']> {
  const nodeKeys = new Set(options.nodes.map((node) => `${node.pluginId}\0${node.platform}`));
  const explicitMatches = (pluginId: string, platform: PlatformName): boolean =>
    options.explicit.some((override) => override.pluginId === pluginId
      && (override.platform === undefined || override.platform === platform));
  return [
    ...options.state.dependencyScopeOverrides.filter((override) =>
      nodeKeys.has(`${override.pluginId}\0${override.platform}`)
      && !options.ignoredPersistedRootIds?.has(override.pluginId)
      && !explicitMatches(override.pluginId, override.platform)),
    ...options.explicit.filter((override) => options.nodes.some((node) =>
      node.pluginId === override.pluginId
      && (override.platform === undefined || node.platform === override.platform))),
  ];
}

function deriveDesiredIntentState(options: {
  command: RebuildCommand;
  state: PluginIntentState;
  selectedRoots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  plan: DependencyOperationPlan;
  reconcileIntentOnly?: boolean;
}): PluginIntentState {
  if (options.reconcileIntentOnly) return options.state;
  let next = options.state;
  if (options.command === 'install') {
    for (const root of options.selectedRoots) next = mergePluginIntentRootPlatforms(next, root);
    next = updateIntentOverrides({ state: next, plan: options.plan });
  } else if (options.command === 'uninstall') {
    for (const root of options.selectedRoots) next = removePluginIntentRootPlatforms(next, root);
  }
  return next;
}

async function writeDesiredIntentSuperset(options: {
  command: RebuildCommand;
  cwd: string;
  scope: Scope;
  selectedRoots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  plan: DependencyOperationPlan;
  codexPlan?: CodexReconcilePlan;
  reconcileIntentOnly?: boolean;
  env: NodeJS.ProcessEnv;
}): Promise<Array<{
  location: { scope: Scope; cwd: string; env: NodeJS.ProcessEnv };
  superset: PluginIntentState;
  convergedCodexPluginIds: string[];
}>> {
  const location = { scope: options.scope, cwd: options.cwd, env: options.env };
  let next = deriveDesiredIntentState({
    command: options.command,
    state: await readPluginIntentState(location),
    selectedRoots: options.selectedRoots,
    plan: options.plan,
    reconcileIntentOnly: options.reconcileIntentOnly,
  });
  const convergedCodexPluginIds = options.codexPlan?.managedInventory.converged
    ?? next.managed.codexPluginIds;
  const superset = options.codexPlan
    ? widenPluginIntentManagedCodexOwnership(
        next,
        options.codexPlan.managedInventory.ownershipSuperset,
      )
    : next;
  await writePluginIntentState(location, superset);
  const writes = [{ location, superset, convergedCodexPluginIds }];

  if (options.command === 'install' || options.codexPlan) {
    const otherScope: Scope = options.scope === 'user' ? 'project' : 'user';
    const otherLocation = { scope: otherScope, cwd: options.cwd, env: options.env };
    let other = await readPluginIntentState(otherLocation);
    if (options.command === 'install' && !options.reconcileIntentOnly) {
      for (const root of options.selectedRoots) other = removePluginIntentRootPlatforms(other, root);
    }
    const otherConvergedCodexPluginIds = options.codexPlan?.managedInventory.related.converged
      ?? other.managed.codexPluginIds;
    const otherSuperset = options.codexPlan
      ? widenPluginIntentManagedCodexOwnership(
          other,
          options.codexPlan.managedInventory.related.ownershipSuperset,
        )
      : other;
    await writePluginIntentState(otherLocation, otherSuperset);
    writes.push({
      location: otherLocation,
      superset: otherSuperset,
      convergedCodexPluginIds: otherConvergedCodexPluginIds,
    });
  }
  return writes;
}

function createSyntheticPlugin(pluginName: string, env: NodeJS.ProcessEnv): PluginMeta {
  const rootDir = path.join(resolveAwHome(env), 'plugins', pluginName);
  return {
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      schemaVersion: 2,
      name: pluginName,
      version: '0.0.0',
      description: 'Cleanup-only target for a plugin missing from the current catalog.',
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
  const exactPluginNames = [...new Set([...requestedByPlatform.values()].flat())];
  const catalogPlugins = options.runtime?.resolvedCatalogPlugins ?? (await Promise.all(
    exactPluginNames.map(async (pluginName) => {
      const pluginRoot = path.join(catalog.rootDir, 'plugins', pluginName);
      return await fs.pathExists(pluginRoot)
        ? readPluginManifest(pluginRoot, { mode: 'bundle' })
        : null;
    }),
  )).filter((plugin): plugin is PluginMeta => plugin !== null);
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
  nativeRegistration?: boolean;
};

function desiredCleanupNoopResult(
  targets: LiveCleanupTarget[],
  cwd: string,
): RebuildCommandResult {
  const rebuildResults: RebuildResult[] = targets.map((target) => ({
    status: 'succeeded',
    command: 'cleanup',
    target: {
      ...target,
      pluginVersion: 'unavailable',
      cwd,
    },
    actions: [],
    cleanupAttempted: false,
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [],
  }));
  return {
    platforms: [...new Set(targets.map((target) => target.platform))],
    plugins: [...new Set(targets.map((target) => target.pluginName))],
    warnings: [],
    rebuildResults,
    targetResults: rebuildResults.map((result) => ({
      target: result.target,
      action: 'keep',
      state: 'completed',
    })),
    overallState: 'succeeded',
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: targets,
  };
}

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
          ...((liveNames.size === 1
            || (marketplaceName !== undefined && unboundNativeNames.has(marketplaceName)))
            ? { nativeRegistration: true }
            : {}),
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
  const codexManager = options.codexManager;
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
      },
      includeHistoricalLifecycleArtifacts: false,
      includeNativeCleanupCandidate: target.nativeRegistration === true,
    });
    let result = await executeRebuildOperation({
      command: 'cleanup',
      target: desired,
      driver: integration.driver,
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
  await options.onPreviewStage?.('dependencyPlan');
  return preview;
}

async function assertOfflineCleanupDependents(options: {
  targets: LiveCleanupTarget[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  readInventory: typeof inventoryCatalogSourceReferences;
}): Promise<void> {
  const inventory = await options.readInventory({
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
  const readInventory = options.runtime?.inventoryCatalogSourceReferences
    ?? inventoryCatalogSourceReferences;
  let ordinaryInventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>> | undefined;
  const readOrdinaryInventory = async () => {
    ordinaryInventory ??= await measureCommandPerformanceStage(
      options.runtime,
      'inventory',
      () => readInventory({
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
      }),
    );
    return ordinaryInventory;
  };
  let requestedPluginNames = options.pluginNames;
  const cleanupForce = options.command === 'cleanup'
    && (options.commandOptions as CleanupCommandOptions).force === true;
  const expectedOfflineCleanup = options.runtime?.expectedOfflineCleanupEvidence;
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
    cleanupInventory = await readOrdinaryInventory();
    const live = resolveLiveCleanupTargets({
      selectors: requestedPluginNames,
      platforms: selectedPlatforms(options.commandOptions.platform),
      scope: options.commandOptions.scope,
      references: cleanupInventory.references,
    });
    requestedPluginNames = live.selectors;
    cleanupLiveTargets = live.targets;
    if (expectedOfflineCleanup) {
      const liveTarget = cleanupLiveTargets.find((target) =>
        target.pluginId === expectedOfflineCleanup.pluginId
        && target.pluginName === expectedOfflineCleanup.pluginName
        && target.sourceId === expectedOfflineCleanup.sourceId
        && target.sourceIdentity === expectedOfflineCleanup.sourceIdentity
        && target.platform === expectedOfflineCleanup.platform
        && target.scope === expectedOfflineCleanup.scope);
      const actualOfflineCleanup = liveTarget
        ? offlineCleanupEvidenceFromInventory({
            ...expectedOfflineCleanup,
            inventory: cleanupInventory,
          })
        : null;
      if (!liveTarget
        || !actualOfflineCleanup
        || !offlineCleanupEvidenceMatches(expectedOfflineCleanup, actualOfflineCleanup)) {
        throw namespacedPreflightError(
          'operationReviewStale: offline cleanup ownership evidence changed before mutation.',
          cleanupLiveTargets,
        );
      }
      cleanupLiveTargets = [liveTarget];
    }
    if (cleanupForce && !expectedOfflineCleanup) {
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
      corruptExclusiveDirectoryOperations: options.runtime?.corruptExclusiveDirectoryOperations,
    });
  }
  if (options.all) {
    const inventory = await readOrdinaryInventory();
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
    if (options.runtime?.catalogBootstrapError !== undefined) {
      throw options.runtime.catalogBootstrapError;
    }
    const catalogOperation = options.runtime?.catalogOperationContext
      ?? (options.command === 'cleanup'
        ? undefined
        : await measureCommandPerformanceStage(
            options.runtime,
            'catalog.context',
            () => resolveCatalogOperationContext({
              cliVersion: resolveRuntimeCliVersion(),
              ...(sourceIds ? { sourceIds } : {}),
              env: runtimeEnv,
              ...(options.runtime?.catalogGenerationRuntime
                ? { runtime: options.runtime.catalogGenerationRuntime }
                : {}),
              ...(options.runtime?.awHomeMutationToken
                ? { bootstrapMissingActive: false }
                : {}),
            }),
          ));
    if (options.runtime?.expectedGenerationSetDigest
      && catalogOperation?.generationSetDigest !== options.runtime.expectedGenerationSetDigest) {
      throw new Error('operationReviewStale: Active Catalog generation changed before mutation.');
    }
    const resolvedResult = await withResolvedMultiSourceCatalog({
      cliVersion: resolveRuntimeCliVersion(),
      freshnessPolicy: 'cacheFirst',
      ...(sourceIds ? { sourceIds } : {}),
      ...(catalogOperation ? { operationContext: catalogOperation } : {}),
      ...(options.command === 'cleanup' || options.runtime?.awHomeMutationToken
        ? { bootstrapMissingActive: false }
        : {}),
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
      const availableEntries = catalog.sources.flatMap((item) => {
        const source = item.resolution!;
        return source.manifest.entries.map((entry) => ({
          source,
          entry,
          pluginId: formatPluginId({ sourceId: source.sourceId, pluginName: entry.name }),
        }));
      });
      const selectedEntries = selectors.map((selector, index) => {
        const matches = availableEntries.filter((candidate) =>
          candidate.entry.name === selector.pluginName
          && (selector.sourceId === undefined || candidate.source.sourceId === selector.sourceId));
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
      const entryClosure = (roots: typeof selectedEntries): typeof availableEntries => {
        const result: typeof availableEntries = [];
        const seen = new Set<string>();
        const visiting = new Set<string>();
        const byId = new Map(availableEntries.map((candidate) => [candidate.pluginId, candidate]));
        const visit = (candidate: typeof availableEntries[number]): void => {
          if (seen.has(candidate.pluginId)) return;
          if (visiting.has(candidate.pluginId)) throw new Error(`Catalog dependency cycle includes "${candidate.pluginId}".`);
          visiting.add(candidate.pluginId);
          for (const dependency of candidate.entry.dependencies) {
            const dependencyId = formatPluginId({ sourceId: candidate.source.sourceId, pluginName: dependency });
            const resolved = byId.get(dependencyId);
            if (!resolved) throw new Error(`Catalog plugin "${candidate.pluginId}" depends on missing plugin "${dependency}".`);
            visit(resolved);
          }
          visiting.delete(candidate.pluginId);
          seen.add(candidate.pluginId);
          result.push(candidate);
        };
        for (const root of roots) visit(root);
        return result;
      };
      const removalConsumerEntries = options.command === 'cleanup' || options.command === 'uninstall'
        ? availableEntries.filter((candidate) => selectedEntries.some((selectedEntry) =>
            candidate.source.sourceId === selectedEntry.source.sourceId
            && candidate.entry.dependencies.includes(selectedEntry.entry.name)))
        : [];
      const removalDesiredEntries = options.command === 'cleanup' || options.command === 'uninstall'
        ? entryClosure(selectedEntries)
        : [];
      const requiredEntryClosure = dependencyEnabled
        ? entryClosure(selectedEntries)
        : [...new Map([
            ...selectedEntries,
            ...removalDesiredEntries,
            ...removalConsumerEntries,
          ].map((candidate) =>
            [candidate.pluginId, candidate] as const)).values()];
      if (dependencyEnabled) {
        for (const candidate of requiredEntryClosure) {
          const requiredCapabilities = candidate.entry.requires.aw.capabilities ?? [];
          const support = checkAwCapabilitySupport(requiredCapabilities, IMPLEMENTED_AW_CAPABILITIES);
          if (!support.supported) {
            throw new AwCapabilityUnsupportedError(candidate.pluginId, support.missing);
          }
        }
        await measureCommandPerformanceStage(options.runtime, 'catalog.validation', async () => {
          for (const item of catalog.sources) {
            const source = item.resolution!;
            const names = requiredEntryClosure
              .filter((candidate) => candidate.source.sourceId === source.sourceId)
              .map((candidate) => candidate.entry.name);
            if (names.length > 0) {
              await validateCatalogSnapshotPluginEntriesComplete(source.rootDir, names);
            }
          }
        });
      }
      const available = await Promise.all(requiredEntryClosure.map(async (candidate) => {
        const plugin = await readPluginManifest(
          path.join(candidate.source.rootDir, 'plugins', candidate.entry.name),
          { mode: 'bundle' },
        );
        plugin.sourceId = candidate.source.sourceId;
        plugin.sourceIdentity = candidate.source.sourceIdentity;
        plugin.pluginId = candidate.pluginId;
        return { source: candidate.source, plugin, pluginId: candidate.pluginId };
      }));
      const selected = selectedEntries.map((entry) => available.find((candidate) =>
        candidate.pluginId === entry.pluginId)!);
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
        : options.command === 'cleanup' || options.command === 'uninstall'
          ? resolveClosureEntries(selected)
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
      const stateInventory = await readOrdinaryInventory();
      if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(stateInventory);
      const hasCodexSelection = executionSelections.some((selection) =>
        selection.platform === 'codex');
      const intentBeforeByScope = hasCodexSelection || dependencyEnabled
        ? {
            user: await readPluginIntentState({
              scope: 'user', cwd: options.commandOptions.cwd, env: runtimeEnv,
            }),
            project: await readPluginIntentState({
              scope: 'project', cwd: options.commandOptions.cwd, env: runtimeEnv,
            }),
          }
        : {
            user: createEmptyPluginIntentState(),
            project: createEmptyPluginIntentState(),
          } satisfies Record<Scope, PluginIntentState>;
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
      const selectedRootsForPlan = (plan: DependencyOperationPlan) =>
        [...new Map(plan.targets.flatMap((target) =>
          target.relation === 'requested'
            ? [[target.pluginId, {
                pluginId: target.pluginId,
                platforms: plan.targets.flatMap((candidate) =>
                  candidate.relation === 'requested'
                  && candidate.pluginId === target.pluginId
                    ? [candidate.platform]
                    : []),
              }] as const]
            : [])).values()];
      const createPlan = async (
        inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
      ): Promise<DependencyOperationPlan> => {
        if (options.command !== 'cleanup') assertCatalogSourceInventoryComplete(inventory);
        const codexActivationSnapshots = executionSelections.some((selection) =>
          selection.platform === 'codex')
          ? Object.fromEntries(await Promise.all((['user', 'project'] as const).map(async (scope) => [
              scope,
              (await readCodexConfigFile(
                resolveCodexPaths(options.commandOptions.cwd, scope, runtimeEnv).configTomlPath,
              )).snapshot,
            ] as const)))
          : undefined;
        const targets = [];
        const placementNodes: DependencyPlacementNodeInput[] = [];
        const blockingTargets = new Map<string, string>();
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
            const hasAnyOwned = hasAnyPresent || hasPartial;
            const state: 'absent' | 'present' | 'partial' = !hasAnyOwned
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
          const surface = platform === 'codex'
            ? analyzeCodexSurface(entry.plugin.manifest)
            : undefined;
          const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceNameFor(
            entry,
            platform,
            resolvedScope,
          )}`;
          const placementState = (
            inspected: typeof requestedInspection,
            scope: Scope,
          ): typeof inspected.state => {
            if (platform !== 'codex'
              || surface?.classification !== 'native'
              || options.command === 'cleanup'
              || options.command === 'uninstall') return inspected.state;
            const nativePresent = inspected.components.some((component) =>
              component.component.kind === 'native-plugin' && component.state === 'present');
            return nativePresent
              && codexActivationSnapshots?.[scope].plugins[codexPluginId]?.enabled === true
              ? 'present'
              : 'absent';
          };
          const requestedPlacementState = placementState(
            requestedInspection,
            options.commandOptions.scope,
          );
          let otherPlacementState = placementState(otherInspection, otherScope);
          if (surface?.classification === 'native'
            && requestedPlacementState === 'present'
            && otherPlacementState === 'present') {
            otherPlacementState = 'absent';
          }
          const allowedScopes: Scope[] = platform === 'codex'
            ? [
                ...(surface?.ok ? ['user' as const] : []),
                ...(surface?.ok && !codexScopePathsAlias ? ['project' as const] : []),
              ]
            : ['project', 'user'];
          if (allowedScopes.length === 0) allowedScopes.push(options.commandOptions.scope);
          placementNodes.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            platform,
            relation,
            depth: order,
            allowedScopes,
            current: {
              project: options.commandOptions.scope === 'project'
                ? requestedPlacementState
                : otherPlacementState,
              user: options.commandOptions.scope === 'user'
                ? requestedPlacementState
                : otherPlacementState,
            },
          });
          let state: 'absent' | 'present' | 'partial' | 'error' = requestedPlacementState;
          let action: 'install' | 'upgrade' | 'reinstall' | 'keep' | 'block' = relation === 'requested'
            ? options.command as 'install' | 'upgrade' | 'reinstall'
            : options.command === 'reinstall' ? 'reinstall' : 'upgrade';
          let errorCode: string | undefined;
          const hasForeignCollision = [...requestedInspection.components, ...otherInspection.components]
            .some((component) => component.collision !== undefined);
          if (dependencyEnabled && hasForeignCollision) {
            action = 'block';
            errorCode = 'artifactCollision';
          } else if (dependencyEnabled
            && platform === 'codex'
            && relation === 'requested'
            && surface?.scopeOverlap === 'aw-owned-conflict'
            && options.runtime?.reconcileIntentOnly !== true
            && !(options.command === 'install'
              && intentBeforeByScope[otherScope].roots.some((root) =>
                root.pluginId === entry.pluginId && root.platforms.includes(platform)))
            && otherInspection.components.some((component) =>
              component.state !== 'absent'
              && component.component.kind !== 'native-plugin'
              && !component.component.identity.artifactKey.startsWith('activation-')
              && !component.component.identity.artifactKey.startsWith('marketplace-'))) {
            action = 'block';
            errorCode = 'codexExtensionScopeConflict';
          } else if (dependencyEnabled && relation === 'requested'
            && (requestedInspection.state === 'error'
              || (requestedInspection.state === 'partial'
                && platform !== 'codex'
                && options.command !== 'reinstall'
                && options.command !== 'cleanup'))) {
            action = 'block';
            errorCode = 'dependencyNotReady';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && requestedPlacementState === 'present'
            && otherPlacementState === 'present') {
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
            && (otherPlacementState === 'partial' || otherPlacementState === 'error')) {
            resolvedScope = 'user';
            state = otherPlacementState;
            if (otherPlacementState === 'error') {
              action = 'block';
              errorCode = 'dependencyNotReady';
            }
          } else if (!hasForeignCollision && relation === 'dependency'
            && options.commandOptions.scope === 'user'
            && otherPlacementState !== 'absent') {
            action = 'block';
            errorCode = 'dependencyScopeTooNarrow';
          }
          const resolvedInspection = resolvedScope === options.commandOptions.scope
            ? requestedInspection
            : otherInspection;
          state = resolvedScope === options.commandOptions.scope
            ? requestedPlacementState
            : otherPlacementState;
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
          if (dependencyEnabled && platform === 'codex' && !surface?.ok) {
            action = 'block';
            errorCode = surface?.errorCode ?? 'codexNativeKindUnsupported';
          }
          if (errorCode) blockingTargets.set(`${entry.pluginId}\0${platform}`, errorCode);
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
        if (dependencyEnabled) {
          const placement = createDependencyPlacementPlan({
            requestedPluginIds: selected.map((entry) => entry.pluginId),
            nodes: placementNodes,
            roots: placementNodes.flatMap((node) => selectedIds.has(node.pluginId)
              ? [{ pluginId: node.pluginId, platform: node.platform, scope: options.commandOptions.scope }]
              : []),
            dependencyEdges: closureEntries.flatMap((entry) =>
              (entry.plugin.manifest.dependencies ?? []).flatMap((dependency) => {
                const dependencyId = formatPluginId({
                  sourceId: entry.source.sourceId,
                  pluginName: dependency,
                });
                return (['codex', 'claude'] as const).flatMap((platform) =>
                  placementNodes.some((node) =>
                    node.pluginId === entry.pluginId && node.platform === platform)
                  && placementNodes.some((node) =>
                    node.pluginId === dependencyId && node.platform === platform)
                    ? [{ from: entry.pluginId, to: dependencyId, platform }]
                    : []);
              })),
            scopeOverrides: effectiveDependencyScopeOverrides({
              state: intentBeforeByScope[options.commandOptions.scope],
              explicit: (options.commandOptions as InstallCommandOptions)
                .dependencyScopeOverrides ?? [],
              nodes: placementNodes,
              ignoredPersistedRootIds: selectedIds,
            }),
            operation: options.command as 'install' | 'upgrade' | 'reinstall',
          });
          return createDependencyOperationPlan({
            requestedPluginIds: placement.requestedPluginIds,
            resolvedPluginIds: placement.resolvedPluginIds,
            dependencyEdges: placement.dependencyEdges,
            scopeOverrides: placement.scopeOverrides,
            claimRoots: placement.claimRoots,
            targets: placement.targets.map((target) => {
              const errorCode = blockingTargets.get(`${target.pluginId}\0${target.platform}`);
              return errorCode
                ? { ...target, action: 'block' as const, errorCode }
                : target;
            }),
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
      const createCodexPlans = async (
        plan: DependencyOperationPlan,
      ): Promise<CodexReconcilePlan[]> => {
        const codexTargets = plan.targets.filter((target) => target.platform === 'codex');
        const selectedRoots = selectedRootsForPlan(plan);
        const currentScope = options.commandOptions.scope;
        const otherScope: Scope = currentScope === 'user' ? 'project' : 'user';
        const reconciledCodexTargets = codexTargets;
        if (reconciledCodexTargets.length === 0) return [];
        const beforeByScope = intentBeforeByScope;
        const afterByScope: Record<Scope, PluginIntentState> = {
          user: beforeByScope.user,
          project: beforeByScope.project,
        };
        afterByScope[currentScope] = deriveDesiredIntentState({
          command: options.command,
          state: beforeByScope[currentScope],
          selectedRoots,
          plan,
          reconcileIntentOnly: options.runtime?.reconcileIntentOnly,
        });
        if (options.command === 'install' && options.runtime?.reconcileIntentOnly !== true) {
          let other = afterByScope[otherScope];
          for (const root of selectedRoots) other = removePluginIntentRootPlatforms(other, root);
          afterByScope[otherScope] = other;
        }
        const desiredScopesForEntry = (entry: (typeof available)[number]): Scope[] => {
          const scopes = new Set<Scope>();
          for (const intentScope of ['user', 'project'] as const) {
            const intent = afterByScope[intentScope];
            for (const root of intent.roots.filter((candidate) =>
              candidate.platforms.includes('codex'))) {
              const rootEntry = available.find((candidate) => candidate.pluginId === root.pluginId);
              if (!rootEntry || rootEntry.source.sourceId !== entry.source.sourceId) continue;
              const sourcePlugins = available
                .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
                .map((candidate) => candidate.plugin);
              let closure: PluginMeta[];
              try {
                closure = resolvePluginMetaDependencyClosure(
                  sourcePlugins,
                  [rootEntry.plugin.manifest.name],
                );
              } catch {
                closure = [rootEntry.plugin];
              }
              if (!closure.some((plugin) => plugin.manifest.name === entry.plugin.manifest.name)) {
                continue;
              }
              const currentPlannedScope = intentScope === currentScope
                && selectedRoots.some((selectedRoot) => selectedRoot.pluginId === root.pluginId)
                ? plan.targets.find((target) =>
                    target.pluginId === entry.pluginId && target.platform === 'codex')?.resolvedScope
                : undefined;
              const override = intent.dependencyScopeOverrides.find((candidate) =>
                candidate.pluginId === entry.pluginId && candidate.platform === 'codex');
              const reusedUserDependency = intentScope === 'project'
                && root.pluginId !== entry.pluginId
                && scopes.has('user');
              scopes.add(currentPlannedScope
                ?? override?.scope
                ?? (reusedUserDependency ? 'user' : intentScope));
            }
          }
          return [...scopes].sort();
        };
        const intentScopesForEntry = (entry: (typeof available)[number]): Scope[] => {
          const scopes = new Set<Scope>();
          for (const intentScope of ['user', 'project'] as const) {
            for (const root of afterByScope[intentScope].roots.filter((candidate) =>
              candidate.platforms.includes('codex'))) {
              const rootEntry = available.find((candidate) => candidate.pluginId === root.pluginId);
              if (!rootEntry || rootEntry.source.sourceId !== entry.source.sourceId) continue;
              const sourcePlugins = available
                .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
                .map((candidate) => candidate.plugin);
              let closure: PluginMeta[];
              try {
                closure = resolvePluginMetaDependencyClosure(
                  sourcePlugins,
                  [rootEntry.plugin.manifest.name],
                );
              } catch {
                closure = [rootEntry.plugin];
              }
              if (closure.some((plugin) => plugin.manifest.name === entry.plugin.manifest.name)) {
                scopes.add(intentScope);
              }
            }
          }
          return [...scopes].sort();
        };
        const inspectBothScopes = options.command !== 'cleanup' && options.command !== 'uninstall';
        const readActivationConfig = async (scope: Scope) => {
          return readCodexConfigFile(resolveCodexPaths(
            options.commandOptions.cwd,
            scope,
            runtimeEnv,
          ).configTomlPath);
        };
        const [userConfig, projectConfig] = await Promise.all([
          readActivationConfig('user'),
          readActivationConfig('project'),
        ]);
        const catalogClosure: CodexReconcilerCatalogTarget[] = [];
        const liveEvidence: CodexReconcilerLiveEvidence[] = [];
        for (const planned of reconciledCodexTargets) {
          const entry = available.find((candidate) => candidate.pluginId === planned.pluginId)!;
          const surface = analyzeCodexSurface(entry.plugin.manifest);
          const marketplaceName = marketplaceNameFor(entry, 'codex', planned.resolvedScope);
          const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceName}`;
          const contentDigest = entry.source.manifest.entries.find((candidate) =>
            candidate.name === entry.plugin.manifest.name)?.contentDigest;
          if (!contentDigest) {
            throw new Error(`codexReconcileEvidenceInvalid: ${entry.pluginId} has no content digest.`);
          }
          const desiredScopes = desiredScopesForEntry(entry);
          catalogClosure.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            codexPluginId,
            version: entry.plugin.manifest.version,
            payloadDigest: contentDigest,
            relation: planned.relation,
            resolvedScope: planned.resolvedScope,
            desiredScopes,
            intentScopes: intentScopesForEntry(entry),
            surface,
          });
          const residue = surface.nativeKinds.length > 0
            ? await inspectCodexNativeResidue({
                pluginName: entry.plugin.manifest.name,
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
                marketplaceName,
                marketplaceRoot: path.join(
                  resolveAwHome(runtimeEnv),
                  'marketplaces',
                  entry.source.sourceId,
                ),
              })
            : { state: 'absent' as const, labels: [], versions: [] };
          const managedBefore = beforeByScope.user.managed.codexPluginIds.includes(codexPluginId)
            || beforeByScope.project.managed.codexPluginIds.includes(codexPluginId);
          const sharedNative: CodexReconcilerLiveEvidence['sharedNative'] = residue.state === 'foreign'
            ? { state: 'foreign', diagnostic: 'marketplaceRegistrationForeign', nativeAction: 'blocked' }
            : residue.state === 'absent'
              ? { state: 'absent', nativeAction: 'install' }
              : residue.versions.length === 0
                ? { state: 'corrupt', diagnostic: 'manifestMissing', nativeAction: 'blocked' }
                : residue.versions.every((version) => version === entry.plugin.manifest.version)
                  ? managedBefore
                    ? { state: 'present', version: entry.plugin.manifest.version, nativeAction: 'none' }
                    : { state: 'claimable', version: entry.plugin.manifest.version, nativeAction: 'none' }
                  : {
                      state: 'outdated',
                      version: residue.versions[0]!,
                      desiredVersion: entry.plugin.manifest.version,
                      nativeAction: 'replace',
                    };
          const projectionEntries: Array<{
            scope: Scope;
            artifactKey: string;
            state: string;
            collision?: string;
          }> = [];
          const extensions: NonNullable<CodexReconcilerLiveEvidence['extensions']> = [];
          for (const scope of (inspectBothScopes
            ? ['user', 'project'] as const
            : [currentScope])) {
            const desired = await inspection.buildTarget({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              marketplaceName,
              marketplaceRoot: path.join(
                resolveAwHome(runtimeEnv),
                'marketplaces',
                entry.source.sourceId,
              ),
              plugin: entry.plugin,
              platform: 'codex',
              scope,
              cwd: options.commandOptions.cwd,
              command: options.command,
              catalog: toCatalogResolution(entry.source),
              includeHistoricalLifecycleArtifacts: false,
              readOnlyInspectionPlan: true,
            });
            const inspected = await inspectOwnedComponents({
              components: desired.ownedComponents,
              nativeProbe: inspection.driver.probeNative,
              verifyHealth: true,
            });
            const projected = inspected.components.filter((component) =>
              component.component.kind !== 'native-plugin'
              && !component.component.identity.artifactKey.startsWith('activation-')
              && !component.component.identity.artifactKey.startsWith('marketplace-'));
            projectionEntries.push(...projected.map((component) => ({
              scope,
              artifactKey: component.component.identity.artifactKey,
              state: component.state,
              collision: component.collision?.reason,
            })));
            const projectionState = projected.some((component) => component.collision)
              ? planned.action === 'block' ? 'absent' as const : 'foreign' as const
              : projected.some((component) => component.state === 'partial'
                || component.state === 'error')
                ? 'drifted' as const
                : projected.some((component) => component.state === 'present')
                  ? 'present' as const
                  : 'absent' as const;
            for (const component of surface.components.filter((candidate) => candidate.owner === 'aw')) {
              extensions.push({ componentKey: component.key, scope, state: projectionState });
            }
          }
          liveEvidence.push({
            codexPluginId,
            sharedNative,
            ...(sharedNative.state === 'corrupt' ? { repairableSharedNative: true } : {}),
            activations: {
              user: userConfig?.snapshot.plugins[codexPluginId]?.enabled,
              project: projectConfig?.snapshot.plugins[codexPluginId]?.enabled,
            },
            extensions,
            projectionDigest: JSON.stringify(projectionEntries.sort((left, right) =>
              `${left.scope}\0${left.artifactKey}`.localeCompare(
                `${right.scope}\0${right.artifactKey}`,
                'en',
              ))),
          });
        }
        return [createCodexReconcilePlan({
          scope: currentScope,
          cwd: options.commandOptions.cwd,
          operation: options.runtime?.reconcileIntentOnly ? 'sync' : options.command,
          intentBefore: beforeByScope[currentScope],
          intentAfter: afterByScope[currentScope],
          relatedIntentBefore: beforeByScope[otherScope],
          relatedIntentAfter: afterByScope[otherScope],
          catalogClosure,
          liveEvidence,
        })];
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
          if (dependencyEnabled && (target.writeNativeRequired ?? target.requiresNative)) return true;
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
        const initialPlan = dependencyEnabled
          ? await measureCommandPerformanceStage(
              options.runtime,
              'dependency.plan',
              () => createPlan(stateInventory),
            )
          : undefined;
        const initialCodexPlans = initialPlan ? await createCodexPlans(initialPlan) : [];
        const preview = mergeRebuildCommandResults([]);
        if (initialPlan) preview.dependencyPlan = initialPlan;
        if (initialCodexPlans.length > 0) preview.codexReconcilePlans = initialCodexPlans;
        if (initialCodexPlans.some((plan) => plan.sharedNativeActions.some((action) =>
          action.action === 'install'
          || action.action === 'replace'
          || action.action === 'repair'))) {
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
            ...(catalogOperation
              ? { generationSetDigest: catalogOperation.generationSetDigest }
              : {}),
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            resolvedCommit: entry.source.resolvedCommit,
            manifestDigest: entry.source.manifestDigest,
            snapshotDigest: entry.source.snapshotDigest,
            contentDigest: entry.source.manifest.entries.find((candidate) =>
              candidate.name === entry.plugin.manifest.name)?.contentDigest,
          });
      }
        const lockedPlan = await measureCommandPerformanceStage(
          options.runtime,
          'dependency.plan',
          () => createPlan(stateInventory),
        );
        const lockedCodexPlans = await createCodexPlans(lockedPlan);
        if (options.runtime?.expectedOperationDependencyPlan
          && JSON.stringify(lockedPlan) !== JSON.stringify(options.runtime.expectedOperationDependencyPlan)) {
          throw namespacedPreflightError(
            'operationReviewStale: dependency plan changed before mutation.',
            preflightTargets,
          );
        }
        if (options.runtime?.expectedCodexReconcilePlans
          && JSON.stringify(lockedCodexPlans) !== JSON.stringify(options.runtime.expectedCodexReconcilePlans)) {
          throw namespacedPreflightError(
            'operationReviewStale: Codex reconciliation evidence or plan changed before mutation.',
            preflightTargets,
          );
        }
        if (options.runtime?.directCli
          && options.commandOptions.yes !== true
          && (options.command === 'install'
            || options.command === 'upgrade'
            || options.command === 'reinstall')) {
          const sharedNativeImpact = lockedCodexPlans.some((plan) => plan.review.requiresYes);
          if (sharedNativeImpact) {
            throw namespacedPreflightError(
              'sharedNativeImpactAuthorizationRequired: Replacing or force-reinstalling shared Codex native state requires --yes.',
              preflightTargets,
            );
          }
        }
        let desiredIntent: Awaited<ReturnType<typeof writeDesiredIntentSuperset>> | undefined;
        if (options.runtime?.awHomeMutationToken
          && !lockedPlan.targets.some((target) => target.action === 'block')) {
          const selectedRoots = selectedRootsForPlan(lockedPlan);
          desiredIntent = await writeDesiredIntentSuperset({
            command: options.command,
            cwd: options.commandOptions.cwd,
            scope: options.commandOptions.scope,
            selectedRoots,
            plan: lockedPlan,
            codexPlan: lockedCodexPlans[0],
            reconcileIntentOnly: options.runtime?.reconcileIntentOnly,
            env: runtimeEnv,
          });
        }
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
        const codexManagerRequired = lockedCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        const claudeCliRequired = await operationNeedsNativeCli('claude', lockedPlan);
        const codexUserActivationDesired = new Set(lockedCodexPlans.flatMap((plan) =>
          plan.activationActions.user.flatMap((action) =>
            action.desired ? [action.codexPluginId] : [])));
        executionContext.codexUserActivationDesired = codexUserActivationDesired;
        const codexProjectOperation = lockedCodexPlans.some((plan) =>
          plan.requirement.requiresProjectPluginContract
          && plan.sharedNativeActions.length > 0);
        if (codexManagerRequired || codexProjectOperation) {
          const codexRequirementScope: Scope = codexProjectOperation
            ? 'project'
            : 'user';
          if (options.runtime?.codexManagerResolver && codexManagerRequired) {
            executionContext.codexManager = await options.runtime.codexManagerResolver({
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              runner: executionContext.nativeCliRunner,
              authorizer: options.runtime?.managedCodexAuthorizer,
              operationRequirement: getCodexOperationRequirement(codexRequirementScope),
            });
          } else {
            const consumer = await (
              options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
            )({
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              runner: executionContext.nativeCliRunner,
              authorizer: options.runtime?.managedCodexAuthorizer,
              operationRequirement: getCodexOperationRequirement(codexRequirementScope),
              requiresNativeMaterialization: codexManagerRequired,
            });
            if (consumer.support === 'observed') executionContext.codexManager = consumer.manager;
          }
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
        const lockedCollisionSelections: DesiredArtifactSelection[] = [];
        for (const { entry, platform } of executionSelections) {
          const planned = lockedPlan.targets.find((candidate) =>
            candidate.pluginId === entry.pluginId && candidate.platform === platform)!;
          const desiredCleanup = platform === 'codex'
            && options.command === 'cleanup'
            && lockedCodexPlans.some((plan) => plan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && target.scopes.includes(planned.resolvedScope)));
          const reconcileObsolete = platform === 'codex'
            && options.runtime?.reconcileIntentOnly === true
            && lockedCodexPlans.some((plan) => plan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && !target.scopes.includes(planned.resolvedScope)));
          if (reconcileObsolete) continue;
          if (planned.action !== 'install'
            && planned.action !== 'upgrade'
            && planned.action !== 'reinstall'
            && planned.action !== 'move'
            && !desiredCleanup) continue;
          const buildCommand = desiredCleanup
            ? 'install'
            : planned.action === 'move'
              ? 'install'
            : planned.relation === 'dependency'
              ? planned.action as RebuildCommand
              : options.command;
          const marketplaceName = marketplaceNameFor(entry, platform, planned.resolvedScope);
          try {
            const target = await measureCommandPerformanceStage(
              options.runtime,
              'target.build',
              () => executionIntegration.buildTarget({
                sourceId: entry.source.sourceId,
                sourceIdentity: entry.source.sourceIdentity,
                pluginId: entry.pluginId,
                marketplaceName,
                marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
                plugin: entry.plugin,
                platform,
                scope: planned.resolvedScope,
                cwd: options.commandOptions.cwd,
                command: buildCommand,
                catalog: toCatalogResolution(entry.source),
                includeHistoricalLifecycleArtifacts: true,
              }),
            );
            if (platform === 'codex') {
              const plannedNative = lockedCodexPlans.flatMap((plan) =>
                plan.sharedNativeActions).find((action) =>
                action.pluginId === entry.pluginId);
              if (plannedNative) {
                target.writeNativeRequired = plannedNative.action === 'install'
                  || plannedNative.action === 'replace'
                  || plannedNative.action === 'repair';
              }
            }
            preparedTargets.set(`${entry.pluginId}\0${platform}`, {
              target,
              driver: executionIntegration.driver,
              context: executionContext,
            });
            await rebuildCommandTestHooks?.afterTargetBuilt?.({
              command: options.command,
              identity: target.identity,
            });
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
        if ((options.command === 'cleanup' && !cleanupForce)
          || options.command === 'uninstall'
          || options.runtime?.reconcileIntentOnly === true) {
          const removalStateInventory = await readInventory({
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
        const codexReconcilePlan = platform === 'codex'
          ? lockedCodexPlans.find((plan) =>
              plan.desiredTargets.some((target) => target.pluginId === entry.pluginId))
          : undefined;
        const desiredInCurrentScope = codexReconcilePlan?.desiredTargets.some((target) =>
          target.pluginId === entry.pluginId && target.scopes.includes(planned.resolvedScope)) === true;
        const reconcileObsolete = platform === 'codex'
          && options.runtime?.reconcileIntentOnly === true
          && !desiredInCurrentScope;
        const desiredCleanupMutation = codexReconcilePlan !== undefined && (
          codexReconcilePlan.sharedNativeActions.some((action) =>
            action.pluginId === entry.pluginId
            && (action.action === 'install'
              || action.action === 'replace'
              || action.action === 'repair'))
          || [...codexReconcilePlan.activationActions.user,
            ...codexReconcilePlan.activationActions.project].some((action) =>
              action.pluginId === entry.pluginId && action.action !== 'none')
          || [...codexReconcilePlan.extensionWrites,
            ...codexReconcilePlan.extensionRemovals].some((action) =>
              action.pluginId === entry.pluginId)
        );
        const plannedNativeAction = codexReconcilePlan?.sharedNativeActions.find((action) =>
          action.pluginId === entry.pluginId);
        const hasCodexExtensionMutation = codexReconcilePlan !== undefined
          && [...codexReconcilePlan.extensionWrites, ...codexReconcilePlan.extensionRemovals]
            .some((action) => action.pluginId === entry.pluginId);
        const reconcileActivationOnly = platform === 'codex'
          && plannedNativeAction !== undefined
          && (plannedNativeAction.action === 'reuse'
            || plannedNativeAction.action === 'claim'
            || plannedNativeAction.action === 'none')
          && !hasCodexExtensionMutation;
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
        if (reconcileActivationOnly) {
          const preparedError = preparedTargetErrors.get(`${entry.pluginId}\0${platform}`);
          if (preparedError) {
            const message = preparedError instanceof Error
              ? preparedError.message
              : String(preparedError);
            const result = failedResult(options.command, identity, message);
            results.push({
              platforms: [platform], plugins: [], warnings: [], rebuildResults: [result],
              targetResults: [{
                target: identity,
                action: planned.action,
                state: 'failed',
                errorCode: message.split(':', 1)[0] ?? 'targetPreparationFailed',
                message,
              }],
              overallState: 'failed', nativePlugins: {}, repoManagedArtifacts: [],
              receiptTargets: [{
                pluginName: identity.pluginName, pluginId: identity.pluginId,
                sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
              }],
            });
            dependencyStates.set(`${entry.pluginId}\0${platform}`, 'failed');
            continue;
          }
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity, actions: [],
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
          results.push({
            platforms: [platform], plugins: [identity.pluginName], warnings: [], rebuildResults: [result],
            targetResults: [{ target: identity, action: planned.action, state: 'completed' }],
            overallState: 'succeeded', nativePlugins: {}, repoManagedArtifacts: [],
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(`${entry.pluginId}\0${platform}`, 'completed');
          continue;
        }
        if (platform === 'codex'
          && desiredInCurrentScope
          && (options.command === 'uninstall'
            || (options.command === 'cleanup' && !desiredCleanupMutation))) {
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
        if (planned.action === 'keep' && !reconcileObsolete) {
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
        const reconcileDesiredCleanup = platform === 'codex'
          && options.command === 'cleanup'
          && desiredInCurrentScope;
        const executionResult = await runSingleSourceRebuildCommand({
          ...options,
          command: reconcileObsolete
            ? 'cleanup'
            : reconcileDesiredCleanup
            ? 'install'
            : planned.action === 'move'
              ? 'install'
            : planned.relation === 'dependency'
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
            resolvedCatalogPlugins: available
              .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
              .map((candidate) => candidate.plugin),
            namespacedSource,
            dependencyReviewPreflightHandled: true,
            targetBuiltHookHandled: true,
            preparedTarget: preparedTargets.get(`${entry.pluginId}\0${platform}`),
            preparedTargetError: preparedTargetErrors.get(`${entry.pluginId}\0${platform}`),
            expectedCatalogConfigDigest: catalog.configDigest,
            resolvedReviewEvidenceByPlugin: {
              [entry.plugin.manifest.name]: {
                configDigest: catalog.configDigest,
                ...(catalogOperation
                  ? { generationSetDigest: catalogOperation.generationSetDigest }
                  : {}),
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
        if (reconcileDesiredCleanup) {
          for (const result of executionResult.rebuildResults) result.command = 'cleanup';
          for (const result of executionResult.targetResults) result.action = 'cleanup';
        }
        results.push(executionResult);
        dependencyStates.set(`${entry.pluginId}\0${platform}`,
          executionResult.overallState === 'succeeded' ? 'completed' : 'failed');
      }
      if (lockedCodexPlans.length > 0
        && mergeRebuildCommandResults(results).overallState === 'succeeded') {
        try {
          await executeCodexReconcileActivations({
            plans: lockedCodexPlans,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            manager: executionContext.codexManager,
            runner: executionContext.nativeCliRunner,
          });
        } catch (error) {
          const selection = executionSelections.find((candidate) => candidate.platform === 'codex');
          if (!selection) throw error;
          const planned = lockedPlan.targets.find((target) =>
            target.pluginId === selection.entry.pluginId && target.platform === 'codex')!;
          const identity: RebuildTargetIdentity = {
            sourceId: selection.entry.source.sourceId,
            sourceIdentity: selection.entry.source.sourceIdentity,
            pluginId: selection.entry.pluginId,
            pluginName: selection.entry.plugin.manifest.name,
            pluginVersion: selection.entry.plugin.manifest.version,
            platform: 'codex',
            scope: planned.resolvedScope,
            cwd: options.commandOptions.cwd,
          };
          const message = error instanceof Error ? error.message : String(error);
          const failed = failedResult(options.command, identity, message, 'postcheck.inspect');
          results.push({
            platforms: ['codex'],
            plugins: [],
            warnings: [],
            rebuildResults: [failed],
            targetResults: [{
              target: identity,
              action: options.command,
              state: 'failed',
              errorCode: message.split(':', 1)[0] ?? 'codexActivationPostcheckFailed',
              message,
            }],
            overallState: 'failed',
            nativePlugins: {},
            repoManagedArtifacts: [],
            receiptTargets: [{
              pluginName: identity.pluginName,
              pluginId: identity.pluginId,
              sourceId: identity.sourceId,
              platform: 'codex',
              scope: identity.scope,
            }],
          });
        }
      }
      if (options.command === 'install'
        && mergeRebuildCommandResults(results).overallState === 'succeeded') {
        for (const { entry, platform } of executionSelections) {
          const planned = lockedPlan.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === platform)!;
          if (planned.action !== 'move'
            || dependencyStates.get(`${entry.pluginId}\0${platform}`) !== 'completed') continue;
          const previousScope: Scope = planned.resolvedScope === 'user' ? 'project' : 'user';
          const marketplaceName = marketplaceNameFor(entry, platform, previousScope);
          entry.plugin.marketplaceName = marketplaceName;
          const migration = await runSingleSourceRebuildCommand({
            command: 'cleanup',
            pluginNames: [entry.plugin.manifest.name],
            commandOptions: { ...options.commandOptions, platform, scope: previousScope },
            runtime: {
              ...options.runtime,
              env: runtimeEnv,
              ...(executionContext.codexManager
                ? { codexManager: executionContext.codexManager }
                : {}),
              catalogResolution: toCatalogResolution(entry.source),
              resolvedCatalogPlugins: available
                .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
                .map((candidate) => candidate.plugin),
              namespacedSource: {
                sourceId: entry.source.sourceId,
                sourceIdentity: entry.source.sourceIdentity,
                marketplaceName,
                marketplaceRoot: path.join(
                  resolveAwHome(runtimeEnv),
                  'marketplaces',
                  entry.source.sourceId,
                ),
              },
              dependencyReviewPreflightHandled: true,
              bypassDependencyPlan: true,
            },
          });
          results.push(migration);
          if (migration.overallState !== 'succeeded') {
            dependencyStates.set(`${entry.pluginId}\0${platform}`, 'failed');
          }
        }
      }
      const merged = mergeRebuildCommandResults(results);
      merged.dependencyPlan = lockedPlan;
      if (lockedCodexPlans.length > 0) merged.codexReconcilePlans = lockedCodexPlans;
      if (desiredIntent && merged.overallState === 'succeeded') {
        for (const intent of desiredIntent) {
          await writePluginIntentState(
            intent.location,
            convergePluginIntentManagedCodexOwnership(
              intent.superset,
              intent.convergedCodexPluginIds,
            ),
          );
        }
      }
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
      || (message.includes('Catalog source')
        && (message.includes('does not exist')
          || message.includes('is not configured')
          || message.includes('has no Active generation')));
    if (options.command === 'cleanup'
      && (catalogUnavailable || message.includes('sourceChanged'))
      && cleanupInventory
      && cleanupLiveTargets.length > 0) {
      const desiredIntent = await readPluginIntentState({
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
      });
      const allTargetsRemainDesired = cleanupLiveTargets.every((target) =>
        desiredIntent.roots.some((root) =>
          root.pluginId === target.pluginId && root.platforms.includes(target.platform)));
      if (allTargetsRemainDesired) {
        return leaseSafeRebuildResult(desiredCleanupNoopResult(
          cleanupLiveTargets,
          options.commandOptions.cwd,
        ));
      }
      if (!cleanupForce || expectedOfflineCleanup) {
        await assertOfflineCleanupDependents({
          targets: cleanupLiveTargets,
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
          readInventory,
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
        force: cleanupForce && !expectedOfflineCleanup,
        removeObsoleteInstallationContracts: options.runtime?.removeObsoleteInstallationContracts,
        nativeCliRunner: options.runtime?.nativeCliRunner,
        codexManager: options.runtime?.codexManager,
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
