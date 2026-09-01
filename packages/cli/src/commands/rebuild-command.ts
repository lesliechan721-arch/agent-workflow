import path from 'node:path';

import type {
  CatalogSourceResolution,
  CatalogResolution,
  CommandOptions,
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
import {
  getDefaultNativeCliRunner,
  type CodexManager,
  type NativeCliRunner,
} from '../utils/native-cli.js';
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
  executeRebuildOperation,
  type RebuildCommand,
  type RebuildFailure,
  type RebuildPostApplyInvocation,
  type RebuildResult,
  type RebuildTargetIdentity,
} from './rebuild-operations.js';
import {
  assertNoClaudeUnboundNativeNameCollision,
  createRebuildIntegration,
  executeCodexReconcileActivations,
  inspectCodexPluginRegistrationLive,
  inspectCodexSharedNativeLive,
  inspectNativeMarketplaceRegistrations,
  type CodexPluginRegistrationLiveInspection,
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
import { calculateCodexSharedNativePayloadDigest } from '../utils/catalog-digests.js';
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
  inspectOwnedComponents,
} from '../utils/ownership.js';
import {
  codexProjectConfigAliasesUserHome,
  resolveCanonicalRepoProjectKey,
} from '../utils/state-paths.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  catalogGenerationErrorCode,
  isOfflineCleanupCatalogGenerationError,
} from '../utils/catalog-generation-error.js';
import {
  canonicalizePluginIntentState,
  calculatePluginIntentDigest,
  createEmptyPluginIntentState,
  mergePluginIntentRootPlatforms,
  readPluginIntentState,
  removePluginIntentRootPlatforms,
  writePluginIntentState,
  type PluginIntentState,
} from '../utils/plugin-intent-state.js';
import {
  assertOperationPlanFingerprint,
  createOperationPlanConfigDigest,
  createOperationPlan,
  type OperationPlan,
  type OperationAction,
  type OperationPlanEvidence,
} from './operation-plan.js';
import { validateCatalogSnapshotPluginEntriesComplete } from '../utils/catalog-snapshot.js';
import { runPostApplyScript } from '../utils/plugin-scripts.js';
import {
  AwCapabilityUnsupportedError,
  IMPLEMENTED_AW_CAPABILITIES,
} from './aw-capabilities.js';
import { checkAwCapabilitySupport } from '../utils/manifest.js';
import {
  createDependencyPlacementPlan,
  type DependencyPlacementNodeInput,
} from './dependency-operation-plan.js';
import {
  createReconcileOperationPlan,
  type ReconcileOperationPlan,
} from './reconcile-operation-plan.js';
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
  expectedPlanFingerprint?: string;
  expectedOfflineCleanupEvidence?: OfflineCleanupTargetEvidence;
  reviewPreflight?: (evidence: RebuildReviewPreflightEvidence) => Promise<void> | void;
  resolvedReviewEvidenceByPlugin?: Record<
    string,
    Omit<RebuildReviewPreflightEvidence, 'command' | 'identity'>
  >;
  previewOperationPlan?: boolean;
  directCli?: boolean;
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  codexManagerResolver?: typeof resolveCodexManager;
  codexOperationConsumerResolver?: typeof resolveCodexOperationConsumer;
  codexManagerPreviewer?: typeof previewCodexManager;
  onPreviewStage?: (stage: 'catalog' | 'inventory' | 'dependencyPlan') => Promise<void> | void;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
};

export type CommandPerformanceStageName =
  | 'catalog.load'
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
  receiptTargets: Array<{
    pluginName: string;
    pluginId?: string;
    sourceId?: string;
    platform: PlatformName;
    scope: Scope;
  }>;
  dependencyPlan?: ReconcileOperationPlan;
  codexReconcilePlans?: CodexReconcilePlan[];
  operationPlan?: OperationPlan;
  codexManagerPreview?: CodexManagerPreview;
  offlineCleanupPlans?: OfflineCleanupTargetEvidence[];
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
  plan: ReconcileOperationPlan;
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
  plan: ReconcileOperationPlan;
}): PluginIntentState {
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
  plan: ReconcileOperationPlan;
  codexPlan?: CodexReconcilePlan;
  env: NodeJS.ProcessEnv;
}): Promise<Array<{
  location: { scope: Scope; cwd: string; env: NodeJS.ProcessEnv };
  superset: PluginIntentState;
}>> {
  const location = { scope: options.scope, cwd: options.cwd, env: options.env };
  let next = deriveDesiredIntentState({
    command: options.command,
    state: await readPluginIntentState(location),
    selectedRoots: options.selectedRoots,
    plan: options.plan,
  });
  const superset = next;
  await writePluginIntentState(location, superset);
  const writes = [{ location, superset }];

  if (options.command === 'install' || options.codexPlan) {
    const otherScope: Scope = options.scope === 'user' ? 'project' : 'user';
    const otherLocation = { scope: otherScope, cwd: options.cwd, env: options.env };
    let other = await readPluginIntentState(otherLocation);
    if (options.command === 'install') {
      for (const root of options.selectedRoots) other = removePluginIntentRootPlatforms(other, root);
    }
    const otherSuperset = other;
    await writePluginIntentState(otherLocation, otherSuperset);
    writes.push({
      location: otherLocation,
      superset: otherSuperset,
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
      schemaVersion: 3,
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
    const names = options.pluginNames;
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
  execution?: {
    prepared?: PreparedRebuildTarget;
    preparationError?: unknown;
    reviewCompleted?: boolean;
    targetHookCompleted?: boolean;
    deferredPostApplyTasks?: Array<{
      run: () => Promise<void>;
      onFailure: (error: unknown) => void;
    }>;
  };
}): Promise<RebuildCommandResult> {
  const runtime: RebuildExecutionContext = {
    env: options.runtime?.env ?? process.env,
    nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    reporter: options.runtime?.reporter ?? createNoopReporter(),
    debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
    ...(options.runtime?.codexManager ? { codexManager: options.runtime.codexManager } : {}),
    expectedCatalogConfigDigest: options.runtime?.expectedCatalogConfigDigest,
    codexUserActivationDesired: options.runtime?.codexUserActivationDesired,
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
  const integration = createRebuildIntegration({
    context: runtime,
    scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
    ...(options.execution?.prepared
      ? { preparedTargets: [options.execution.prepared.target] }
      : {}),
  });
  const targets = [];
  const results: RebuildResult[] = [];
  const warnings: string[] = [];
  const recordWarning = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (!warnings.includes(message)) warnings.push(message);
  };
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
          `${pluginName} 当前 catalog 不支持 ${platform}。`,
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
        if (options.execution?.preparationError) throw options.execution.preparationError;
        const target = options.execution?.prepared?.target ?? await integration.buildTarget({
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
        });
        targets.push(target);
        if (!options.execution?.targetHookCompleted) {
          await rebuildCommandTestHooks?.afterTargetBuilt?.({
            command: options.command,
            identity,
          });
        }
        if (!options.execution?.reviewCompleted) {
          await options.runtime?.reviewPreflight?.({
            command: options.command,
            identity,
            ...options.runtime.resolvedReviewEvidenceByPlugin?.[pluginName],
          });
        }
        const driver = options.execution?.deferredPostApplyTasks
          ? {
              ...integration.driver,
              runPostApply: async (invocation: RebuildPostApplyInvocation) => {
                options.execution!.deferredPostApplyTasks!.push({
                  run: () => integration.driver.runPostApply(invocation),
                  onFailure: (error) => {
                    recordWarning(error);
                    const action = result.actions.find((entry) => entry.name === 'postApply');
                    if (action) action.status = 'failed';
                  },
                });
              },
            }
          : {
              ...integration.driver,
              runPostApply: async (invocation: RebuildPostApplyInvocation) => {
                try {
                  await integration.driver.runPostApply(invocation);
                } catch (error) {
                  recordWarning(error);
                  throw error;
                }
              },
            };
        result = await executeRebuildOperation({
          command: options.command,
          target,
          driver,
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
  return {
    platforms,
    plugins: [...new Set(successful.map((result) => result.target.pluginName))],
    warnings: [...new Set(warnings)],
    rebuildResults: results,
    targetResults: results.map(toTargetResult),
    overallState: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed',
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
  return {
    platforms,
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
    rebuildResults,
    targetResults: results.flatMap((result) => result.targetResults),
    overallState: rebuildResults.every((result) => result.status === 'succeeded')
      ? 'succeeded'
      : 'failed',
    receiptTargets: results.flatMap((result) => result.receiptTargets),
    ...(results.find((result) => result.dependencyPlan)?.dependencyPlan
      ? { dependencyPlan: results.find((result) => result.dependencyPlan)!.dependencyPlan }
      : {}),
    ...(results.find((result) => result.codexManagerPreview)?.codexManagerPreview
      ? { codexManagerPreview: results.find((result) => result.codexManagerPreview)!.codexManagerPreview }
      : {}),
    ...(results.find((result) => result.operationPlan)?.operationPlan
      ? { operationPlan: results.find((result) => result.operationPlan)!.operationPlan }
      : {}),
    ...(results.some((result) => result.offlineCleanupPlans !== undefined)
      ? { offlineCleanupPlans: results.flatMap((result) => result.offlineCleanupPlans ?? []) }
      : {}),
  };
}

function createRebuildOperationPlan(options: {
  command: RebuildCommand;
  scope: Scope;
  dependencyPlan: ReconcileOperationPlan;
  codexPlans: readonly CodexReconcilePlan[];
  targetActions?: readonly OperationAction[];
  catalogSources: readonly CatalogSourceResolution[];
  intentBeforeByScope: Record<Scope, PluginIntentState>;
  configDigests: OperationPlanEvidence['configDigests'];
}): OperationPlan {
  const selectedRoots = [...new Map(options.dependencyPlan.targets.flatMap((target) =>
    target.relation === 'requested'
      ? [[target.pluginId, {
          pluginId: target.pluginId,
          platforms: options.dependencyPlan.targets.flatMap((candidate) =>
            candidate.relation === 'requested' && candidate.pluginId === target.pluginId
              ? [candidate.platform]
              : []),
        }] as const]
      : [])).values()];
  const intentBefore = options.intentBeforeByScope[options.scope];
  const intentAfter = deriveDesiredIntentState({
    command: options.command,
    state: intentBefore,
    selectedRoots,
    plan: options.dependencyPlan,
  });
  const beforeDigest = calculatePluginIntentDigest(intentBefore);
  const afterDigest = calculatePluginIntentDigest(intentAfter);
  const actions: OperationAction[] = [
    ...(options.targetActions ?? []),
    ...options.codexPlans.flatMap((plan) => [
    ...plan.sharedNativeActions.flatMap((action): OperationAction[] =>
      action.action === 'install' || action.action === 'replace' || action.action === 'repair'
        ? [{
            kind: 'ensureNativeRegistration',
            pluginId: action.pluginId,
            platform: 'codex',
            scope: options.dependencyPlan.targets.find((target) =>
              target.pluginId === action.pluginId && target.platform === 'codex')?.resolvedScope ?? 'user',
            registration: action.codexPluginId,
          }]
        : []),
    ...(['user', 'project'] as const).flatMap((scope) =>
      plan.activationActions[scope].flatMap((action): OperationAction[] =>
        action.action === 'none'
          ? []
          : [{
              kind: 'setActivation',
              pluginId: action.pluginId,
              platform: 'codex',
              scope,
              enabled: action.desired,
            }])),
    ...plan.staleActivationRemovals.map((action): OperationAction => ({
      kind: 'setActivation',
      pluginId: action.codexPluginId,
      platform: 'codex',
      scope: action.scope,
      enabled: false,
    })),
    ]),
  ];
  return createOperationPlan({
    intentChanges: beforeDigest === afterDigest
      ? []
      : [{ scope: options.scope, beforeDigest, afterDigest }],
    actions,
    changes: options.dependencyPlan.targets.map((target) => [
      target.pluginId,
      target.platform,
      target.resolvedScope,
      target.action,
    ].join(':')),
    warnings: options.codexPlans.flatMap((plan) => plan.warnings),
    evidence: {
      catalogDigests: options.catalogSources.map((source) => ({
        sourceId: source.sourceId,
        digest: source.manifestDigest,
      })),
      intentDigests: (['user', 'project'] as const).map((scope) => ({
        scope,
        digest: calculatePluginIntentDigest(options.intentBeforeByScope[scope]),
      })),
      configDigests: options.configDigests,
      targetOwnerFingerprints: options.dependencyPlan.targets.map((target) => ({
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.resolvedScope,
        fingerprint: JSON.stringify({ state: target.state, errorCode: target.errorCode ?? null }),
      })),
    },
  });
}

function leaseSafeRebuildResult(result: RebuildCommandResult): RebuildCommandResult {
  const projectPath = (value: string): string => path.basename(value);
  return {
    ...result,
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

function resolveLiveCleanupTargets(options: {
  selectors: string[];
  platforms: PlatformName[];
  scope: Scope;
  references: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>['references'];
}): { selectors: string[]; targets: LiveCleanupTarget[] } {
  const visible = options.references.filter((reference) =>
    (reference.kind === 'namespacedOwner'
      || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
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
        const stableSourceIdentity = reference.sourceIdentity
          ?? options.references.find((entry) =>
            entry.kind === 'namespacedMarketplace'
            && entry.sourceId === reference.sourceId
            && entry.sourceIdentity)?.sourceIdentity
          ?? 'unavailable';
        const liveNames = new Set(options.references.flatMap((candidate) =>
          candidate.sourceId === reference.sourceId
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
          sourceIdentity: stableSourceIdentity,
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

async function cleanupOfflineOwnedComponents(options: {
  targets: LiveCleanupTarget[];
  evidence?: OfflineCleanupTargetEvidence[];
  inventoryErrors?: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>['errors'];
  cwd: string;
  env: NodeJS.ProcessEnv;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
  nativeCliRunner?: NativeCliRunner;
  codexManager?: RebuildExecutionContext['codexManager'];
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
  for (const target of options.targets) {
    const inventoryErrors = (options.inventoryErrors ?? []).filter((error) =>
      error.relevance.global || (
        (error.relevance.sourceId === undefined || error.relevance.sourceId === target.sourceId)
        && (error.relevance.pluginName === undefined || error.relevance.pluginName === target.pluginName)
        && (error.relevance.platform === undefined || error.relevance.platform === target.platform)
        && (error.relevance.scope === undefined || error.relevance.scope === target.scope)
      ));
    const evidence = options.evidence?.find((candidate) =>
      candidate.pluginId === target.pluginId
      && candidate.sourceIdentity === target.sourceIdentity
      && candidate.platform === target.platform
      && candidate.scope === target.scope);
    const activationAction = target.platform === 'codex'
      ? evidence?.plan.actions.find((action) =>
          action.action === 'removeNativeRegistration'
          && action.activationScope === target.scope)
      : undefined;
    let activationDisposition: 'remove' | 'disable' = 'remove';
    if (activationAction && target.scope === 'user') {
      const projectIntent = await readPluginIntentState({
        scope: 'project',
        cwd: options.cwd,
        env: options.env,
      });
      const remainsDesired = projectIntent.roots.some((root) =>
        root.pluginId === target.pluginId && root.platforms.includes('codex'))
        ;
      if (remainsDesired) activationDisposition = 'disable';
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
      includeNativeCleanupCandidate: target.nativeRegistration === true,
      preserveCodexSharedNativePayload: target.platform === 'codex',
      ...(activationAction
        ? {
            codexActivationCleanup: [{
              codexPluginId: activationAction.target,
              scope: activationAction.activationScope!,
              disposition: activationDisposition,
            }],
          }
        : {}),
    });
    const result = await executeRebuildOperation({
      command: 'cleanup',
      target: desired,
      driver: integration.driver,
    });
    let finalResult = result;
    if (inventoryErrors.length > 0) {
      const message = 'stateInventoryResidual: Some weak state could not be verified. Retry cleanup, use cleanup --force only for exclusively owned damaged output, or run reinstall/sync to restore the target.';
      result.residual = [...new Set([
        ...result.residual,
        ...inventoryErrors.map((error) => error.location),
      ])];
      warnings.push(...inventoryErrors.map((error) =>
        `stateInventoryResidual: ${error.kind}: ${error.message}`));
      if (result.status === 'succeeded') {
        finalResult = {
          ...result,
          status: 'failed',
          failures: [...result.failures, { phase: 'cleanup.owned', message }],
          error: { phase: 'cleanup.owned', message },
        };
      }
    }
    results.push(finalResult);
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
    warnings: [...new Set(warnings)],
    rebuildResults: results,
    targetResults: results.map(toTargetResult),
    overallState: results.every((result) => result.status === 'succeeded') ? 'succeeded' : 'failed',
    receiptTargets: results.map((result) => ({
      pluginName: result.target.pluginName,
      pluginId: result.target.pluginId,
      sourceId: result.target.sourceId,
      platform: result.target.platform,
      scope: result.target.scope,
    })),
    ...(options.evidence ? { offlineCleanupPlans: options.evidence } : {}),
  });
}

async function previewOfflineOwnedComponents(options: {
  targets: LiveCleanupTarget[];
  evidence?: OfflineCleanupTargetEvidence[];
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
  if (options.evidence) {
    preview.offlineCleanupPlans = options.evidence;
    preview.operationPlan = createOfflineCleanupOperationPlan(options.evidence);
  }
  await options.onPreviewStage?.('dependencyPlan');
  return preview;
}

function createOfflineCleanupOperationPlan(
  evidence: readonly OfflineCleanupTargetEvidence[],
): OperationPlan {
  return createOperationPlan({
    intentChanges: [],
    actions: evidence.flatMap((target) => target.plan.actions.map((action): OperationAction =>
      action.action === 'removeNativeRegistration'
        ? {
            kind: 'removeNativeRegistration',
            pluginId: target.pluginId,
            platform: target.platform,
            scope: target.scope,
            registration: action.target,
          }
        : {
            kind: 'removeOwnedArtifact',
            pluginId: target.pluginId,
            platform: target.platform,
            scope: target.scope,
            path: action.target,
            ownerFingerprint: target.targetFingerprint,
          })),
    changes: evidence.flatMap((target) => target.plan.actions.map((action) =>
      `${target.pluginId}:${action.action}:${action.target}`)),
    warnings: [],
    evidence: {
      catalogDigests: evidence.map((target) => ({
        sourceId: target.sourceId,
        digest: target.sourceIdentity,
      })),
      intentDigests: [],
      configDigests: [],
      targetOwnerFingerprints: evidence.map((target) => ({
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.scope,
        fingerprint: target.targetFingerprint,
      })),
    },
  });
}

export async function runRebuildCommand(options: {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
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
    liveTargets = cleanupLiveTargets;
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
    if (options.command === 'cleanup') {
      cleanupInventory = inventory;
      cleanupLiveTargets = projectedTargets;
    }
    const identities = new Set<string>();
    for (const reference of live) {
      const pluginId = formatPluginId({ sourceId: reference.sourceId!, pluginName: reference.pluginName! });
      identities.add(pluginId);
    }
    requestedPluginNames = [...identities];
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
  if (options.command === 'cleanup') {
    if (cleanupLiveTargets.some((target) => target.marketplaceIdentityUnresolved)) {
      throw namespacedPreflightError(
        'marketplaceIdentityUnavailable: Cannot uniquely recover the native marketplace name from live inventory or a canonical native registration path.',
        cleanupLiveTargets,
      );
    }
    if (cleanupLiveTargets.length === 0) {
      const requestedPlatforms = selectedPlatforms(options.commandOptions.platform);
      const primarySource = await readCatalogSourcesConfigSnapshot(runtimeEnv)
        .then((snapshot) => snapshot.config.sources.find((source) => source.primary)?.id)
        .catch(() => undefined);
      const unresolvedTargets = requestedPluginNames.flatMap((selector) => {
        const parsed = parsePluginId(selector);
        const sourceId = parsed.sourceId ?? primarySource;
        return sourceId ? requestedPlatforms.map((platform) => ({
          pluginId: formatPluginId({ sourceId, pluginName: parsed.pluginName }),
          pluginName: parsed.pluginName,
          sourceId,
          sourceIdentity: 'unavailable',
          platform,
          scope: options.commandOptions.scope,
        })) : [];
      });
      const inventoryError = cleanupInventory?.errors.find((error) =>
        error.relevance.global || unresolvedTargets.some((target) =>
          !error.relevance.global
          && (error.relevance.sourceId === undefined || error.relevance.sourceId === target.sourceId)
          && (error.relevance.pluginName === undefined || error.relevance.pluginName === target.pluginName)
          && (error.relevance.platform === undefined || error.relevance.platform === target.platform)
          && (error.relevance.scope === undefined
            || error.relevance.scope === target.scope
            || target.platform === 'codex')));
      if (inventoryError) {
        throw namespacedPreflightError(
          `stateInventoryFailed: ${inventoryError.message}`,
          unresolvedTargets,
        );
      }
      const result = mergeRebuildCommandResults([]);
      if (cleanupForce && !options.runtime?.previewOperationPlan) {
        try {
          await (options.runtime?.removeObsoleteInstallationContracts ?? fs.remove)(
            path.join(resolveAwHome(runtimeEnv), 'installation-contracts'),
          );
        } catch (error) {
          result.warnings.push(
            `obsoleteContractsCleanupFailed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return result;
    }
    const configuredSources = await readCatalogSourcesConfigSnapshot(runtimeEnv)
      .then((snapshot) => new Set(snapshot.config.sources.map((source) => source.id)))
      .catch(() => new Set<string>());
    const evidence = expectedOfflineCleanup
      ? [expectedOfflineCleanup]
      : cleanupLiveTargets.flatMap((target) => {
          const value = offlineCleanupEvidenceFromInventory({
            reason: configuredSources.has(target.sourceId) ? 'bundleUnavailable' : 'sourceMissing',
            pluginId: target.pluginId,
            pluginName: target.pluginName,
            sourceId: target.sourceId,
            sourceIdentity: target.sourceIdentity,
            platform: target.platform,
            scope: target.scope,
            inventory: cleanupInventory!,
          });
          return value ? [value] : [];
        });
    if (options.runtime?.expectedPlanFingerprint) {
      assertOperationPlanFingerprint(
        options.runtime.expectedPlanFingerprint,
        createOfflineCleanupOperationPlan(evidence),
      );
    }
    if (options.runtime?.previewOperationPlan) {
      const previewResult = await previewOfflineOwnedComponents({
        targets: cleanupLiveTargets,
        evidence,
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        onPreviewStage: options.runtime.onPreviewStage,
      });
      return previewResult;
    }
    const cleanupResult = await cleanupOfflineOwnedComponents({
      targets: cleanupLiveTargets,
      evidence,
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
      inventoryErrors: cleanupInventory!.errors,
      removeObsoleteInstallationContracts: options.runtime?.removeObsoleteInstallationContracts,
      nativeCliRunner: options.runtime?.nativeCliRunner,
      codexManager: options.runtime?.codexManager,
    });
    return cleanupResult;
  }
  try {
    if (options.runtime?.previewOperationPlan) {
      await options.runtime.onPreviewStage?.('catalog');
    }
    if (options.runtime?.catalogBootstrapError !== undefined) {
      throw options.runtime.catalogBootstrapError;
    }
    const catalogOperation = options.runtime?.catalogOperationContext
      ?? await measureCommandPerformanceStage(
          options.runtime,
          'catalog.load',
          () => resolveCatalogOperationContext({
              ...(sourceIds ? { sourceIds } : {}),
              env: runtimeEnv,
          }),
        );
    if (options.runtime?.expectedGenerationSetDigest
      && catalogOperation?.generationSetDigest !== options.runtime.expectedGenerationSetDigest) {
      throw new Error('operationReviewStale: Active Catalog generation changed before mutation.');
    }
    const resolvedResult = await withResolvedMultiSourceCatalog({
      cliVersion: resolveRuntimeCliVersion(),
      ...(sourceIds ? { sourceIds } : {}),
      ...(catalogOperation ? { operationContext: catalogOperation } : {}),
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
        || options.command === 'sync'
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
        : options.command === 'cleanup'
          ? resolveClosureEntries(selected)
          : selected;
      const rawExecutionSelections = options.all
        ? liveTargets.flatMap((target) => {
            const entry = selected.find((candidate) => candidate.pluginId === target.pluginId)!;
            if (target.sourceIdentity !== 'unavailable'
              && entry.source.sourceIdentity !== target.sourceIdentity) {
              throw namespacedPreflightError(
                `sourceChanged: ${target.pluginId} live target has a different source identity.`,
                liveTargets,
                legacyLiveTargets,
              );
            }
            const sourcePlugins = available
              .filter((candidate) => candidate.source.sourceId === entry.source.sourceId)
              .map((candidate) => candidate.plugin);
            return (options.command === 'uninstall'
              ? [entry.plugin]
              : resolvePluginMetaDependencyClosure(
                  sourcePlugins,
                  [entry.plugin.manifest.name],
                )).map((plugin) => ({
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
      if (options.runtime?.previewOperationPlan) {
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
      const selectedRootsForPlan = (plan: ReconcileOperationPlan) =>
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
      let plannedCodexRegistrations = new Map<
        string,
        CodexPluginRegistrationLiveInspection
      >();
      const createPlan = async (
        inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
        codexManager?: CodexManager,
      ): Promise<ReconcileOperationPlan> => {
        plannedCodexRegistrations = new Map();
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
        const targets: Array<{
          pluginId: string;
          pluginName: string;
          platform: PlatformName;
          requestedScope: Scope;
          resolvedScope: Scope;
          relation: 'requested' | 'dependency';
          requiredBy: string[];
          state: 'absent' | 'present' | 'partial' | 'error';
          action: 'install' | 'reinstall' | 'keep' | 'block';
          order: number;
          errorCode?: string;
        }> = [];
        const placementNodes: DependencyPlacementNodeInput[] = [];
        const blockingTargets = new Map<string, string>();
        const actualStates = new Map<string, 'absent' | 'present' | 'partial' | 'error'>();
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
              readOnlyInspectionPlan: true,
            });
            const result = await inspectOwnedComponents({
              components: desired.ownedComponents,
              executor: inspection.driver.ownership,
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
          const codexRegistration = platform === 'codex'
            && surface?.classification === 'native'
            ? await inspectCodexPluginRegistrationLive({
                pluginId: codexPluginId,
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
                nativeCliRunner: executionContext.nativeCliRunner,
                ...(codexManager ? { manager: codexManager } : {}),
              })
            : undefined;
          if (codexRegistration) {
            plannedCodexRegistrations.set(codexPluginId, codexRegistration);
          }
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
              && codexRegistration?.entries.some((entry_) =>
                entry_.pluginId === codexPluginId) === true
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
          actualStates.set(
            `${entry.pluginId}\0${platform}\0${options.commandOptions.scope}`,
            requestedPlacementState,
          );
          actualStates.set(`${entry.pluginId}\0${platform}\0${otherScope}`, otherPlacementState);
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
            ...(relation === 'dependency'
              && options.commandOptions.scope === 'project'
              && otherInspection.state === 'present'
              ? {
                  preferredScope: 'user' as const,
                  ...(otherPlacementState === 'present'
                    ? { preferredScopeReason: 'existingWiderTarget' as const }
                    : {}),
                }
              : {}),
          });
          let state: 'absent' | 'present' | 'partial' | 'error' = requestedPlacementState;
          let action: 'install' | 'reinstall' | 'keep' | 'block' = relation === 'requested'
            ? options.command === 'cleanup' || options.command === 'uninstall'
              ? 'keep'
              : options.command === 'reinstall' ? 'reinstall' : 'install'
            : options.command === 'reinstall' ? 'reinstall' : 'install';
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
            && options.command !== 'sync'
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
          if (!hasForeignCollision && !errorCode && relation === 'dependency') {
            action = state === 'present' ? 'keep' : state === 'partial' ? 'reinstall' : 'install';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && resolvedInspection.state === 'error') {
            action = 'block';
            state = resolvedInspection.state;
            errorCode ??= 'dependencyNotReady';
          }
          if (entry.plugin.manifest.config?.schema
            && (action === 'install' || action === 'reinstall')) {
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
          });
          return createReconcileOperationPlan({
            placement,
            actual: placement.targets.map((target) => {
              const prior = targets.find((candidate) =>
                candidate.pluginId === target.pluginId && candidate.platform === target.platform)!;
              const state = actualStates.get(
                `${target.pluginId}\0${target.platform}\0${target.resolvedScope}`,
              ) ?? prior.state;
              const errorCode = blockingTargets.get(`${target.pluginId}\0${target.platform}`)
                ?? prior.errorCode;
              const action = errorCode
                ? 'block' as const
                : options.command === 'cleanup' || options.command === 'uninstall'
                  ? 'keep' as const
                : target.relation === 'dependency' && state === 'present'
                  ? 'keep' as const
                  : state === 'partial' || options.command === 'reinstall'
                    ? 'reinstall' as const
                    : 'install' as const;
              return { ...prior, state, action, ...(errorCode ? { errorCode } : {}) };
            }),
          });
        }
        const directPlacement = createDependencyPlacementPlan({
          requestedPluginIds: selected.map((entry) => entry.pluginId),
          nodes: placementNodes,
          roots: placementNodes.map((node) => ({
            pluginId: node.pluginId,
            platform: node.platform,
            scope: options.commandOptions.scope,
          })),
          dependencyEdges: [],
        });
        return createReconcileOperationPlan({ placement: directPlacement, actual: targets });
      };
      const createCodexPlans = async (
        plan: ReconcileOperationPlan,
        activationSupport: 'observed' | 'assumed' = 'observed',
        codexManager?: CodexManager,
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
        });
        if (options.command === 'install') {
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
              const rootEntry = availableEntries.find((candidate) => candidate.pluginId === root.pluginId);
              if (!rootEntry || rootEntry.source.sourceId !== entry.source.sourceId) continue;
              let closure: typeof availableEntries;
              try {
                closure = entryClosure([rootEntry]);
              } catch {
                closure = [rootEntry];
              }
              if (!closure.some((candidate) => candidate.pluginId === entry.pluginId)) {
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
              const rootEntry = availableEntries.find((candidate) => candidate.pluginId === root.pluginId);
              if (!rootEntry || rootEntry.source.sourceId !== entry.source.sourceId) continue;
              let closure: typeof availableEntries;
              try {
                closure = entryClosure([rootEntry]);
              } catch {
                closure = [rootEntry];
              }
              if (closure.some((candidate) => candidate.pluginId === entry.pluginId)) {
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
          const contentDigest = await calculateCodexSharedNativePayloadDigest(entry.plugin.rootDir);
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
          const sharedInspection = surface.nativeKinds.length > 0
            ? await inspectCodexSharedNativeLive({
                pluginName: entry.plugin.manifest.name,
                desiredVersion: entry.plugin.manifest.version,
                expectedPayloadDigest: contentDigest,
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
                managedByCurrentIntent: false,
                marketplaceName,
                marketplaceRoot: path.join(
                  resolveAwHome(runtimeEnv),
                  'marketplaces',
                  entry.source.sourceId,
                ),
                nativeCliRunner: executionContext.nativeCliRunner,
                ...(codexManager ? { manager: codexManager } : {}),
                ...(plannedCodexRegistrations.get(codexPluginId)
                  ? { pluginRegistration: plannedCodexRegistrations.get(codexPluginId)! }
                  : {}),
              })
            : undefined;
          const sharedNative: CodexReconcilerLiveEvidence['sharedNative'] = sharedInspection?.sharedNative
            ?? { state: 'missing' };
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
              readOnlyInspectionPlan: true,
            });
            const inspected = await inspectOwnedComponents({
              components: desired.ownedComponents,
              executor: inspection.driver.ownership,
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
            ...(sharedInspection?.actualPayloadDigest
              ? { sharedNativePayloadDigest: sharedInspection.actualPayloadDigest }
              : {}),
            ...(sharedInspection?.payloadPath
              ? { sharedNativePayloadPath: sharedInspection.payloadPath }
              : {}),
            activations: {
              user: sharedInspection?.activations.user
                ?? userConfig?.snapshot.plugins[codexPluginId]?.enabled,
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
          operation: options.command,
          intentBefore: beforeByScope[currentScope],
          intentAfter: afterByScope[currentScope],
          relatedIntentBefore: beforeByScope[otherScope],
          relatedIntentAfter: afterByScope[otherScope],
          catalogClosure,
          liveEvidence,
          activationSupport,
        })];
      };
      const operationNeedsNativeCli = async (
        platform: PlatformName,
        plan?: ReconcileOperationPlan,
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
              ? planned!.action as 'install' | 'reinstall'
              : options.command,
            catalog: toCatalogResolution(entry.source),
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
            executor: inspection.driver.ownership,
            nativeProbe: inspection.driver.probeNative,
          });
          if (nativeInspection.components.some((component) =>
            component.state === 'present' || component.state === 'partial')) {
            return true;
          }
        }
        return false;
      };
      const prepareRenderedTargets = async (
        plan: ReconcileOperationPlan,
        codexPlans: readonly CodexReconcilePlan[],
        runTargetHook: boolean,
      ) => {
        const integration = createRebuildIntegration({
          context: executionContext,
          scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
        });
        const preparedTargets = new Map<string, PreparedRebuildTarget>();
        const preparedTargetErrors = new Map<string, unknown>();
        const collisionSelections: DesiredArtifactSelection[] = [];
        for (const { entry, platform } of executionSelections) {
          const planned = plan.targets.find((candidate) =>
            candidate.pluginId === entry.pluginId && candidate.platform === platform)!;
          if (planned.action === 'block') continue;
          const desiredCleanup = platform === 'codex'
            && options.command === 'cleanup'
            && codexPlans.some((codexPlan) => codexPlan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && target.scopes.includes(planned.resolvedScope)));
          const reconcileObsolete = platform === 'codex'
            && options.command === 'sync'
            && codexPlans.some((codexPlan) => codexPlan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && !target.scopes.includes(planned.resolvedScope)));
          const buildCommand: RebuildCommand = reconcileObsolete
            ? 'cleanup'
            : desiredCleanup || planned.action === 'move'
              ? 'install'
              : planned.relation === 'dependency'
                && (planned.action === 'install' || planned.action === 'reinstall')
                ? planned.action
                : options.command;
          const marketplaceName = marketplaceNameFor(entry, platform, planned.resolvedScope);
          try {
            const target = await measureCommandPerformanceStage(
              options.runtime,
              'target.build',
              () => integration.buildTarget({
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
                platform,
                scope: planned.resolvedScope,
                cwd: options.commandOptions.cwd,
                command: buildCommand,
                catalog: toCatalogResolution(entry.source),
                preserveCodexSharedNativePayload: platform === 'codex'
                  && (buildCommand === 'cleanup' || buildCommand === 'uninstall'),
              }),
            );
            if (platform === 'codex') {
              const plannedNative = codexPlans.flatMap((codexPlan) =>
                codexPlan.sharedNativeActions).find((action) =>
                action.pluginId === entry.pluginId);
              if (plannedNative) {
                target.writeNativeRequired = plannedNative.action === 'install'
                  || plannedNative.action === 'replace'
                  || plannedNative.action === 'repair';
              }
            }
            preparedTargets.set(`${entry.pluginId}\0${platform}`, {
              target,
            });
            if (runTargetHook) {
              await rebuildCommandTestHooks?.afterTargetBuilt?.({
                command: options.command,
                identity: target.identity,
              });
            }
            collisionSelections.push({
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
        const collisions = preflightDesiredArtifactCollisions(collisionSelections);
        if (collisions.length > 0) {
          throw namespacedPreflightError(
            `artifactCollision: ${collisions.map((collision) =>
              `${collision.targetKey} (${collision.pluginIds.join(', ')})`).join('; ')}`,
            preflightTargets,
          );
        }
        const configTargets = new Map<string, {
          entry: (typeof executionSelections)[number]['entry'];
          scope: Scope;
        }>();
        if (options.command !== 'cleanup' && options.command !== 'uninstall') {
          for (const { entry, platform } of executionSelections) {
            const planned = plan.targets.find((candidate) =>
              candidate.pluginId === entry.pluginId && candidate.platform === platform)!;
            if (!entry.plugin.manifest.config?.schema
              || planned.action === 'block'
              || !preparedTargets.has(`${entry.pluginId}\0${platform}`)) continue;
            configTargets.set(`${entry.pluginId}\0${planned.resolvedScope}`, {
              entry,
              scope: planned.resolvedScope,
            });
          }
        }
        const configDigests = await Promise.all([...configTargets.values()].map(async ({
          entry,
          scope,
        }) => {
          const effective = await resolveEffectivePluginConfig({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginName: entry.plugin.manifest.name,
            manifest: entry.plugin.manifest,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
          return createOperationPlanConfigDigest({
            pluginId: entry.pluginId,
            scope,
            effectiveValues: effective.values,
          });
        }));
        return {
          preparedTargets,
          preparedTargetErrors,
          targetActions: [...preparedTargets.values()].flatMap((prepared) =>
            prepared.target.operationActions ?? []),
          configDigests,
        };
      };
      if (options.runtime?.previewOperationPlan) {
        await options.runtime.onPreviewStage?.('dependencyPlan');
        const initialPlan = await measureCommandPerformanceStage(
          options.runtime,
          'dependency.plan',
          () => createPlan(stateInventory),
        );
        const provisionalCodexPlans = await createCodexPlans(initialPlan);
        const previewNeedsNativeMaterialization = provisionalCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        const previewActivationOnlyProject = !previewNeedsNativeMaterialization
          && provisionalCodexPlans.some((plan) =>
            plan.requirement.requiresProjectPluginContract
            && plan.postcheck.plugins.length > 0);
        const previewConsumer = previewActivationOnlyProject
          ? await (
              options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
            )({
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              runner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
              operationRequirement: getCodexOperationRequirement('project'),
              requiresNativeMaterialization: false,
            })
          : undefined;
        const initialCodexPlans = previewConsumer?.support === 'assumed'
          ? await createCodexPlans(initialPlan, 'assumed')
          : provisionalCodexPlans;
        const previewPreparation = await prepareRenderedTargets(
          initialPlan,
          initialCodexPlans,
          false,
        );
        const preview = mergeRebuildCommandResults([]);
        preview.dependencyPlan = initialPlan;
        preview.operationPlan = createRebuildOperationPlan({
          command: options.command,
          scope: options.commandOptions.scope,
          dependencyPlan: initialPlan,
          codexPlans: initialCodexPlans,
          targetActions: previewPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          intentBeforeByScope,
          configDigests: previewPreparation.configDigests,
        });
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
        let lockedPlan = await measureCommandPerformanceStage(
          options.runtime,
          'dependency.plan',
          () => createPlan(stateInventory),
        );
        const provisionalLockedCodexPlans = await createCodexPlans(lockedPlan);
        const codexManagerRequired = provisionalLockedCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        const activationOnlyProjectOperation = !codexManagerRequired
          && provisionalLockedCodexPlans.some((plan) =>
            plan.requirement.requiresProjectPluginContract
            && plan.postcheck.plugins.length > 0);
        const activationConsumer = activationOnlyProjectOperation
          ? await (
              options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
            )({
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              runner: executionContext.nativeCliRunner,
              operationRequirement: getCodexOperationRequirement('project'),
              requiresNativeMaterialization: false,
            })
          : undefined;
        if (activationConsumer?.support === 'observed') {
          executionContext.codexManager = activationConsumer.manager;
        }
        if (codexManagerRequired) {
          const codexRequirementScope: Scope = provisionalLockedCodexPlans.some((plan) =>
            plan.requirement.requiresProjectPluginContract)
            ? 'project'
            : 'user';
          if (options.runtime?.codexManagerResolver) {
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
              requiresNativeMaterialization: true,
            });
            if (consumer.support !== 'observed') {
              throw new Error('Codex native materialization requires an observed CLI consumer.');
            }
            executionContext.codexManager = consumer.manager;
          }
        }
        let lockedCodexPlans = activationConsumer?.support === 'assumed'
          ? await createCodexPlans(lockedPlan, 'assumed')
          : provisionalLockedCodexPlans;
        if (executionContext.codexManager) {
          lockedPlan = await createPlan(stateInventory, executionContext.codexManager);
          lockedCodexPlans = await createCodexPlans(
            lockedPlan,
            'observed',
            executionContext.codexManager,
          );
        }
        const lockedPreparation = await prepareRenderedTargets(lockedPlan, lockedCodexPlans, true);
        const lockedOperationPlan = createRebuildOperationPlan({
          command: options.command,
          scope: options.commandOptions.scope,
          dependencyPlan: lockedPlan,
          codexPlans: lockedCodexPlans,
          targetActions: lockedPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          intentBeforeByScope,
          configDigests: lockedPreparation.configDigests,
        });
        if (options.runtime?.expectedPlanFingerprint) {
          try {
            assertOperationPlanFingerprint(
              options.runtime.expectedPlanFingerprint,
              lockedOperationPlan,
            );
          } catch (error) {
            throw namespacedPreflightError(
              error instanceof Error ? error.message : String(error),
              preflightTargets,
            );
          }
        }
        if (options.runtime?.directCli
          && options.commandOptions.yes !== true
          && (options.command === 'install'
            || options.command === 'sync'
            || options.command === 'reinstall')) {
          const sharedNativeImpact = lockedCodexPlans.some((plan) =>
            plan.review.requiresConfirmation);
          if (sharedNativeImpact) {
            throw namespacedPreflightError(
              'sharedNativeImpactAuthorizationRequired: Replacing or force-reinstalling shared Codex native state requires --yes.',
              preflightTargets,
            );
          }
        }
        if (options.runtime?.awHomeMutationToken) {
          const selectedRoots = selectedRootsForPlan(lockedPlan);
          await writeDesiredIntentSuperset({
            command: options.command,
            cwd: options.commandOptions.cwd,
            scope: options.commandOptions.scope,
            selectedRoots,
            plan: lockedPlan,
            codexPlan: lockedCodexPlans[0],
            env: runtimeEnv,
          });
        }
        for (const pluginName of new Set(lockedPlan.targets.flatMap((target) =>
          target.platform === 'claude'
          && (target.action === 'install'
            || target.action === 'reinstall')
            ? [target.pluginName]
            : []))) {
          await assertNoClaudeUnboundNativeNameCollision({
            pluginName,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
        }
        const claudeCliRequired = await operationNeedsNativeCli('claude', lockedPlan);
        const codexUserActivationDesired = new Set(lockedCodexPlans.flatMap((plan) =>
          plan.activationActions.user.flatMap((action) =>
            action.desired ? [action.codexPluginId] : [])));
        executionContext.codexUserActivationDesired = codexUserActivationDesired;
        await assertClaudeVersion({
          platforms: claudeCliRequired ? ['claude'] : [],
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
          runtime: executionContext,
        });
        const preparedTargets = lockedPreparation.preparedTargets;
        const preparedTargetErrors = lockedPreparation.preparedTargetErrors;
        const removalRequiredConsumers = new Map<string, Set<string>>();
        if ((options.command === 'cleanup' && !cleanupForce)
          || options.command === 'uninstall'
          || options.command === 'sync') {
          const removalStateInventory = await readInventory({
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
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
              readOnlyInspectionPlan: true,
            });
            const consumerInspection = await inspectOwnedComponents({
              components: consumerTarget.ownedComponents,
              executor: inspection.driver.ownership,
              nativeProbe: inspection.driver.probeNative,
              verifyHealth: true,
            });
            return consumerInspection.state === 'absent' ? 'absent' : 'live';
          };
          const currentConsumerCandidates = [...new Map(removalStateInventory.references.flatMap((reference) => {
            if ((reference.kind !== 'namespacedOwner' && reference.kind !== 'namespacedMarketplace')
              || !reference.sourceId
              || !reference.pluginName
              || (reference.platform !== 'codex' && reference.platform !== 'claude')
              || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
            const entry = available.find((candidate) =>
              candidate.source.sourceId === reference.sourceId
              && (reference.sourceIdentity === undefined
                || candidate.source.sourceIdentity === reference.sourceIdentity)
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
          if (options.command === 'cleanup' || options.command === 'uninstall') {
            executionSelections = orderedSelections;
          }
        }
      const results: RebuildCommandResult[] = [];
      const deferredPostApplyTasks: Array<{
        run: () => Promise<void>;
        onFailure: (error: unknown) => void;
      }> = [];
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
          && options.command === 'sync'
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
            overallState: 'failed',
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
              overallState: 'failed',
              receiptTargets: [{
                pluginName: identity.pluginName, pluginId: identity.pluginId,
                sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
              }],
            });
            dependencyStates.set(`${entry.pluginId}\0${platform}`, 'failed');
            continue;
          }
          const warnings: string[] = [];
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity,
            actions: [{ name: 'postApply', status: 'succeeded' }],
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
          deferredPostApplyTasks.push({
            run: () => runPostApplyScript({
              plugin: entry.plugin,
              platform,
              scope: planned.resolvedScope,
              cwd: options.commandOptions.cwd,
              context: executionContext as never,
              artifacts: [],
              components: [{
                kind: 'target',
                key: `${platform}:${planned.resolvedScope}`,
                outcome: 'unchanged',
              }],
              scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
            }),
            onFailure: (error) => {
              warnings.push(error instanceof Error ? error.message : String(error));
              result.actions[0]!.status = 'failed';
            },
          });
          results.push({
            platforms: [platform], plugins: [identity.pluginName], warnings, rebuildResults: [result],
            targetResults: [{ target: identity, action: planned.action, state: 'completed' }],
            overallState: 'succeeded',
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
            overallState: 'succeeded',
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(`${entry.pluginId}\0${platform}`, 'kept');
          continue;
        }
        if (planned.action === 'keep'
          && !reconcileObsolete
          && options.command !== 'cleanup'
          && options.command !== 'uninstall') {
          const warnings: string[] = [];
          try {
            await runPostApplyScript({
              plugin: entry.plugin,
              platform,
              scope: planned.resolvedScope,
              cwd: options.commandOptions.cwd,
              context: executionContext as never,
              artifacts: [],
              components: [{
                kind: 'target',
                key: `${platform}:${planned.resolvedScope}`,
                outcome: 'unchanged',
              }],
              scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
            });
          } catch (error) {
            warnings.push(error instanceof Error ? error.message : String(error));
          }
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity,
            actions: [{ name: 'postApply', status: warnings.length > 0 ? 'failed' : 'succeeded' }],
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
          results.push({
            platforms: [platform], plugins: [identity.pluginName], warnings, rebuildResults: [result],
            targetResults: [{ target: identity, action: 'keep', state: 'completed' }],
            overallState: 'succeeded',
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
            ? planned.action as 'install' | 'reinstall'
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
          execution: {
            reviewCompleted: true,
            targetHookCompleted: true,
            prepared: preparedTargets.get(`${entry.pluginId}\0${platform}`),
            preparationError: preparedTargetErrors.get(`${entry.pluginId}\0${platform}`),
            ...(lockedCodexPlans.length > 0 ? { deferredPostApplyTasks } : {}),
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
        let activationSucceeded = false;
        try {
          await executeCodexReconcileActivations({
            plans: lockedCodexPlans,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            manager: executionContext.codexManager,
            runner: executionContext.nativeCliRunner,
          });
          activationSucceeded = true;
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
            receiptTargets: [{
              pluginName: identity.pluginName,
              pluginId: identity.pluginId,
              sourceId: identity.sourceId,
              platform: 'codex',
              scope: identity.scope,
            }],
          });
        }
        if (activationSucceeded) {
          for (const task of deferredPostApplyTasks) {
            try {
              await task.run();
            } catch (error) {
              task.onFailure(error);
            }
          }
        }
      }
      if ((options.command === 'install' || options.command === 'sync')
        && mergeRebuildCommandResults(results).overallState === 'succeeded') {
        for (const { entry, platform } of executionSelections) {
          const planned = lockedPlan.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === platform)!;
          if (dependencyStates.get(`${entry.pluginId}\0${platform}`) !== 'completed') continue;
          const previousScope: Scope = planned.resolvedScope === 'user' ? 'project' : 'user';
          const removesPreviousScope = platform === 'codex' && lockedCodexPlans.some((plan) =>
            plan.extensionRemovals.some((action) =>
              action.pluginId === entry.pluginId && action.scope === previousScope));
          if (!removesPreviousScope) {
            continue;
          }
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
            },
            execution: { reviewCompleted: true },
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
      merged.operationPlan = lockedOperationPlan;
      return leaseSafeRebuildResult(merged);
    },
    });
    if (cleanupForce && !options.runtime?.previewOperationPlan) {
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
    if (options.command !== 'uninstall') throw error;
    const message = error instanceof Error ? error.message : String(error);
    const catalogUnavailable = isOfflineCleanupCatalogGenerationError(error)
      || message.startsWith('Cannot resolve required catalog sources:')
      || message.includes('does not exist in the required catalog source set');
    if (options.command === 'uninstall' && catalogUnavailable) {
      throw namespacedPreflightError(
        `catalogSourceUnavailable: ${message} Restore the source to run lifecycle uninstall, or use cleanup; use cleanup --force only for exclusively owned damaged output.`,
        liveTargets,
        legacyLiveTargets,
      );
    }
    if (catalogGenerationErrorCode(error) === 'catalogGenerationSourceMissing'
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
