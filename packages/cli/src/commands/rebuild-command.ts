import path from 'node:path';
import crypto from 'node:crypto';

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
  releaseRebuildOperationLease,
  type RebuildCommand,
  type RebuildFailure,
  type RebuildResult,
  type RebuildTargetIdentity,
} from './rebuild-operations.js';
import {
  createRebuildIntegration,
  discoverRebuildTargetNames,
  type RebuildExecutionContext,
} from './rebuild-integration.js';
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
  inventoryCatalogSourceReferences,
} from '../utils/catalog-source-references.js';
import { resolveEffectivePluginConfig } from '../utils/plugin-config.js';
import {
  acquireLifecycleOperationLock,
  readLifecycleActiveSnapshot,
  removeLifecycleActiveSnapshot,
} from '../utils/lifecycle-active-store.js';
import {
  withActiveMarketplaceLifecycleLease,
  withActiveMarketplaceRuntimeLease,
} from '../utils/active-marketplace-runtime-lock.js';
import { cleanupOrphanNamespacedMarketplaceRoot } from '../utils/orphan-marketplace-cleanup.js';
import { canonicalPlatformScopeTargets, comparePlatformScopeTarget } from '../utils/target-order.js';
import { inspectOwnedComponents } from '../utils/ownership.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { validateCatalogSnapshot } from '../utils/catalog-snapshot.js';
import {
  discardInstallationContract,
  inventoryInstallationContracts,
  promoteInstallationContract,
  readInstallationContract,
  removeInstallationContract,
  resolveInstallationContractTarget,
  stageInstallationContract,
  type InstallationDependencyPlacement,
  type ReadInstallationContract,
} from '../utils/installation-contract-store.js';
import {
  createDependencyOperationPlan,
  stableDependencyPlanJson,
  type DependencyOperationPlan,
} from './dependency-operation-plan.js';

export type RebuildCommandRuntime = Partial<RebuildExecutionContext> & {
  catalogResolution?: CatalogResolution;
  namespacedSource?: {
    sourceId: string;
    sourceIdentity: string;
    marketplaceName: string;
    marketplaceRoot: string;
  };
  lostSourceRecovery?: boolean;
  expectedCatalogConfigDigest?: string;
  reviewPreflight?: (evidence: RebuildReviewPreflightEvidence) => Promise<void> | void;
  resolvedReviewEvidenceByPlugin?: Record<
    string,
    Omit<RebuildReviewPreflightEvidence, 'command' | 'identity'>
  >;
  operationLeaseHeld?: boolean;
  installationContractHandledExternally?: boolean;
  bypassDependencyPlan?: boolean;
  dependencyReviewPreflightHandled?: boolean;
  afterDependencyOperationLocksAcquire?: () => Promise<void>;
  dependencyPlanReviewPreflight?: (plan: DependencyOperationPlan) => Promise<void> | void;
  previewDependencyPlanOnly?: boolean;
  targetBuiltHookHandled?: boolean;
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
}

export interface RebuildCommandTestHooks {
  beforeOperationLockAcquire?: (options: {
    command: RebuildCommand;
    identity: RebuildTargetIdentity;
  }) => Promise<void>;
  afterTargetBuilt?: (options: {
    command: RebuildCommand;
    identity: RebuildTargetIdentity;
  }) => Promise<void>;
  afterOrphanCleanupValidated?: (options: {
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

async function withRebuildActionEvent<T>(options: {
  runtime: RebuildExecutionContext;
  command: RebuildCommand;
  identity: RebuildTargetIdentity;
  name: 'operation.lock' | 'operation.release';
  operation: () => Promise<T>;
}): Promise<T> {
  const source = {
    plugin: options.identity.pluginName,
    platform: options.identity.platform,
    scope: options.identity.scope,
    action: options.command,
  };
  const startedAt = Date.now();
  await emitRebuildActionEvent(options.runtime, {
    type: 'rebuild:action',
    source,
    data: { name: options.name, phase: 'start' },
  });
  let result: T;
  try {
    result = await options.operation();
  } catch (error) {
    await emitRebuildActionEvent(options.runtime, {
      type: 'rebuild:action',
      source,
      data: {
        name: options.name,
        phase: 'failure',
        durationMs: Math.max(0, Date.now() - startedAt),
        message: options.name === 'operation.lock'
          ? '获取操作锁失败。'
          : '释放操作锁失败。',
      },
    });
    throw error;
  }
  await emitRebuildActionEvent(options.runtime, {
    type: 'rebuild:action',
    source,
    data: {
      name: options.name,
      phase: 'success',
      durationMs: Math.max(0, Date.now() - startedAt),
    },
  });
  return result;
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

function appendOperationReleaseFailure(
  result: RebuildResult,
  message: string,
): RebuildResult {
  result.actions.push({ name: 'operation.release', status: 'failed' });
  result.failures.push({ phase: 'operation.release', message });
  if (result.status === 'failed') return result;
  return {
    ...result,
    status: 'failed',
    error: { phase: 'operation.release', message },
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

async function runSingleSourceRebuildCommand(options: {
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
    runtimeLeaseHeld: options.runtime?.runtimeLeaseHeld,
    lifecycleLeaseHeld: options.runtime?.lifecycleLeaseHeld,
    expectedCatalogConfigDigest: options.runtime?.expectedCatalogConfigDigest,
  };
  const env = runtime.env;
  const selected = selectedPlatforms(options.commandOptions.platform);
  const catalog = options.runtime?.catalogResolution;
  if (!catalog) throw new Error('Internal error: a resolved catalog source is required.');
  const catalogPlugins = await resolvePluginsFromCatalog(catalog.rootDir, undefined).catch((error) => {
    if (options.runtime?.lostSourceRecovery) return [];
    throw error;
  });
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
  await assertAgentVersions({
    platforms,
    cwd: options.commandOptions.cwd,
    env,
    runtime,
  });
  const integration = createRebuildIntegration({
    context: runtime,
    scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
  });
  const activeStore = createRebuildActiveStore({
    env,
    loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
    isLifecycleLeaseHeld: () => runtime.lifecycleLeaseHeld === true,
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
      let operationLock;
      if (!options.runtime?.operationLeaseHeld) {
        try {
          await rebuildCommandTestHooks?.beforeOperationLockAcquire?.({
            command: options.command,
            identity,
          });
          operationLock = await withRebuildActionEvent({
            runtime,
            command: options.command,
            identity,
            name: 'operation.lock',
            operation: () => activeStore.acquireOperation!(identity),
          });
        } catch (error) {
          results.push(failedResult(
            options.command,
            identity,
            error instanceof Error ? error.message : String(error),
            'operation.lock',
          ));
          continue;
        }
      }
      let result: RebuildResult;
      try {
        if (options.runtime?.lostSourceRecovery && options.command === 'uninstall') {
          const snapshot = await readLifecycleActiveSnapshot({
            sourceId: options.runtime.namespacedSource!.sourceId,
            sourceIdentity: options.runtime.namespacedSource!.sourceIdentity,
            pluginName,
            platform,
            scope: options.commandOptions.scope,
            cwd: options.commandOptions.cwd,
            env,
            loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
          });
          if (!snapshot) {
            result = failedResult(
              options.command,
              identity,
              'sourceMissing: Active lifecycle snapshot is required for lost-source uninstall. Run cleanup to remove live outputs without lifecycle.',
              'active.read',
            );
            throw Object.assign(new Error('lost-source-active-read-result'), { result });
          }
        }
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
          includeHistoricalLifecycleArtifacts: !options.runtime?.lostSourceRecovery
            || options.command === 'uninstall',
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
        if (options.runtime?.namespacedSource
          && !options.runtime.installationContractHandledExternally
          && (options.command === 'cleanup' || options.command === 'uninstall')) {
          const removalTarget = await resolveInstallationContractTarget({
            sourceId: options.runtime.namespacedSource.sourceId,
            sourceIdentity: options.runtime.namespacedSource.sourceIdentity,
            pluginName,
            platform,
            scope: options.commandOptions.scope,
            cwd: options.commandOptions.cwd,
            env,
          });
          const inventory = await inventoryCatalogSourceReferences({
            cwd: options.commandOptions.cwd,
            env,
            includeHistoricalProjects: true,
          });
          assertCatalogSourceInventoryComplete(inventory);
          if (inventory.references.some((reference) =>
            reference.kind === 'namespacedDependency'
            && reference.dependencyPluginId === identity.pluginId
            && reference.dependencySourceIdentity === identity.sourceIdentity
            && reference.dependencyPlatform === platform
            && reference.dependencyScope === options.commandOptions.scope
            && (options.commandOptions.scope === 'user'
              || reference.dependencyProjectKey === removalTarget.projectKey))) {
            throw new Error(`dependencyStillRequired: ${identity.pluginId} has a live or unreadable consumer.`);
          }
        }
        const { acquireOperation: _acquireOperation, ...operationHeldStore } = activeStore;
        result = await executeRebuildOperation({
          command: options.command,
          target,
          driver: integration.driver,
          activeStore: operationHeldStore,
          onActionEvent: (event) => emitRebuildActionEvent(runtime, event),
        });
        if (
          result.status === 'succeeded'
          && options.runtime?.namespacedSource
          && !options.runtime.installationContractHandledExternally
          && options.command !== 'cleanup'
          && options.command !== 'uninstall'
        ) {
          const evidence = options.runtime.resolvedReviewEvidenceByPlugin?.[pluginName];
          if (evidence?.contentDigest) {
            const staged = await stageInstallationContract({
              sourceId: options.runtime.namespacedSource.sourceId,
              sourceIdentity: options.runtime.namespacedSource.sourceIdentity,
              pluginName,
              pluginVersion: plugin.manifest.version,
              contentDigest: evidence.contentDigest,
              platform,
              scope: options.commandOptions.scope,
              cwd: options.commandOptions.cwd,
              env,
            });
            try {
              await promoteInstallationContract(staged);
            } catch (error) {
              await discardInstallationContract(staged).catch(() => undefined);
              throw new Error(
                `dependencyContractInvalid: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
          }
        }
        if (
          result.status === 'succeeded'
          && options.runtime?.namespacedSource
          && !options.runtime.installationContractHandledExternally
          && (options.command === 'cleanup' || options.command === 'uninstall')
        ) {
          const contract = await readInstallationContract({
            sourceId: options.runtime.namespacedSource.sourceId,
            sourceIdentity: options.runtime.namespacedSource.sourceIdentity,
            pluginName,
            platform,
            scope: options.commandOptions.scope,
            cwd: options.commandOptions.cwd,
            env,
          });
          if (contract) {
            await removeInstallationContract({
              sourceId: options.runtime.namespacedSource.sourceId,
              sourceIdentity: options.runtime.namespacedSource.sourceIdentity,
              pluginName,
              platform,
              scope: options.commandOptions.scope,
              cwd: contract.metadata.projectKey ?? options.commandOptions.cwd,
              env,
              expectedMetadataIntegrityDigest: contract.metadata.metadataIntegrityDigest,
            });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result = (error as { result?: RebuildResult }).result ?? failedResult(
            options.command,
            identity,
            `${options.runtime?.lostSourceRecovery && options.command === 'uninstall'
              && !errorMessage.startsWith('dependencyStillRequired:') ? 'sourceMissing: ' : ''}${errorMessage}`,
            options.runtime?.lostSourceRecovery && options.command === 'uninstall' ? 'active.read' : 'preflight',
          );
      }
      result.actions.unshift({ name: 'operation.lock', status: 'succeeded' });
      if (operationLock) {
        try {
          await withRebuildActionEvent({
            runtime,
            command: options.command,
            identity,
            name: 'operation.release',
            operation: () => releaseRebuildOperationLease(operationLock),
          });
          result.actions.push({ name: 'operation.release', status: 'succeeded' });
        } catch (error) {
          result = appendOperationReleaseFailure(
            result,
            error instanceof Error ? error.message : String(error),
          );
        }
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

async function cleanupOrphanLifecycleOnly(options: {
  selector: ReturnType<typeof parsePluginId>;
  commandOptions: CommandOptions;
  env: NodeJS.ProcessEnv;
}): Promise<RebuildCommandResult | null> {
  if (!options.selector.sourceId) return null;
  const inventory = await inventoryCatalogSourceReferences({
    cwd: options.commandOptions.cwd,
    env: options.env,
  });
  assertCatalogSourceInventoryComplete(inventory);
  const platforms = new Set(selectedPlatforms(options.commandOptions.platform));
  const exact = (reference: (typeof inventory.references)[number]): boolean =>
    reference.sourceId === options.selector.sourceId
    && reference.pluginName === options.selector.pluginName
    && reference.scope === options.commandOptions.scope
    && !!reference.platform
    && platforms.has(reference.platform as PlatformName);
  const lifecycle = inventory.references.filter((reference) =>
    reference.kind === 'namespacedLifecycle' && exact(reference));
  if (lifecycle.length === 0) return null;
  if (inventory.references.some((reference) =>
    reference.kind === 'installationContract' && exact(reference))) return null;
  const live = inventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && exact(reference));
  if (live.length > 0) return null;
  const identities = new Set(lifecycle.map((reference) => reference.sourceIdentity).filter(Boolean));
  if (identities.size !== 1 || lifecycle.some((reference) => !reference.sourceIdentity)) {
    throw new Error(
      `sourceChanged: ${options.selector.sourceId}/${options.selector.pluginName} lifecycle state has conflicting source identities.`,
    );
  }
  const sourceIdentity = [...identities][0]!;
  const operationLocks: Awaited<ReturnType<typeof acquireLifecycleOperationLock>>[] = [];
  try {
    const lockTargets = canonicalPlatformScopeTargets(
      selectedPlatforms(options.commandOptions.platform).map((platform) => ({
        platform,
        scope: options.commandOptions.scope,
      })),
    );
    for (const { platform } of lockTargets) {
      const identity: RebuildTargetIdentity = {
        sourceId: options.selector.sourceId,
        sourceIdentity,
        pluginId: formatPluginId({
          sourceId: options.selector.sourceId,
          pluginName: options.selector.pluginName,
        }),
        pluginName: options.selector.pluginName,
        pluginVersion: '0.0.0',
        platform,
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
      };
      await rebuildCommandTestHooks?.beforeOperationLockAcquire?.({ command: 'cleanup', identity });
      operationLocks.push(await acquireLifecycleOperationLock({
        sourceId: options.selector.sourceId,
        sourceIdentity,
        pluginName: options.selector.pluginName,
        platform,
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
        env: options.env,
      }));
    }
    const lockedInventory = await inventoryCatalogSourceReferences({
      cwd: options.commandOptions.cwd,
      env: options.env,
    });
    assertCatalogSourceInventoryComplete(lockedInventory);
    const lockedLifecycle = lockedInventory.references.filter((reference) =>
      reference.kind === 'namespacedLifecycle' && exact(reference));
    const lockedLive = lockedInventory.references.filter((reference) =>
      (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
      && exact(reference));
    if (lockedLive.length > 0) {
      throw new Error(
        `liveOwnershipRequired: ${options.selector.sourceId}/${options.selector.pluginName} became live before orphan cleanup acquired its operation lock.`,
      );
    }
    if (lockedLifecycle.length !== lifecycle.length
      || lockedLifecycle.some((reference) => reference.sourceIdentity !== sourceIdentity)) {
      throw new Error(
        `stateInventoryFailed: ${options.selector.sourceId}/${options.selector.pluginName} lifecycle state changed before cleanup.`,
      );
    }
    const results: RebuildResult[] = [];
    const validated: Array<{
      reference: (typeof lockedLifecycle)[number];
      platform: PlatformName;
      snapshot: NonNullable<Awaited<ReturnType<typeof readLifecycleActiveSnapshot>>>;
    }> = [];
    for (const reference of lockedLifecycle) {
      const platform = reference.platform as PlatformName;
      const snapshot = await readLifecycleActiveSnapshot({
        sourceId: options.selector.sourceId,
        sourceIdentity,
        pluginName: options.selector.pluginName,
        platform,
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
        env: options.env,
        loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
      });
      if (!snapshot) {
        throw new Error(`stateInventoryFailed: lifecycle state disappeared before cleanup at ${reference.location}.`);
      }
      const recordedPaths = new Set(snapshot.metadata.artifacts.flatMap((artifact) => [
        artifact.path,
        ...(artifact.paths ?? []),
      ]));
      for (const artifactPath of recordedPaths) {
        let exists = true;
        try {
          await fs.lstat(artifactPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
          else throw error;
        }
        if (exists) {
          throw new Error(
            `liveOwnershipRequired: ${options.selector.sourceId}/${options.selector.pluginName} lifecycle records a live ${platform} component without valid schema 2 ownership.`,
          );
        }
      }
      validated.push({ reference, platform, snapshot });
    }
    for (const { platform, snapshot } of validated) {
      await rebuildCommandTestHooks?.afterOrphanCleanupValidated?.({
        identity: {
          sourceId: options.selector.sourceId,
          sourceIdentity,
          pluginId: formatPluginId({
            sourceId: options.selector.sourceId,
            pluginName: options.selector.pluginName,
          }),
          pluginName: options.selector.pluginName,
          pluginVersion: snapshot.metadata.pluginVersion,
          platform,
          scope: options.commandOptions.scope,
          cwd: options.commandOptions.cwd,
        },
      });
    }
    for (const { reference, platform, snapshot } of validated) {
      await removeLifecycleActiveSnapshot({
        sourceId: options.selector.sourceId,
        sourceIdentity,
        pluginName: options.selector.pluginName,
        platform,
        scope: options.commandOptions.scope,
        cwd: options.commandOptions.cwd,
        env: options.env,
        expectedMetadataIntegrityDigest: snapshot.metadata.metadataIntegrityDigest,
      });
      results.push({
        status: 'succeeded',
        command: 'cleanup',
        target: {
          sourceId: options.selector.sourceId,
          sourceIdentity,
          pluginId: formatPluginId({
            sourceId: options.selector.sourceId,
            pluginName: options.selector.pluginName,
          }),
          pluginName: options.selector.pluginName,
          pluginVersion: snapshot.metadata.pluginVersion,
          platform,
          scope: options.commandOptions.scope,
          cwd: options.commandOptions.cwd,
        },
        actions: [{ name: 'active.remove', status: 'succeeded' }],
        cleanupAttempted: true,
        removed: [reference.location],
        absent: [],
        residual: [],
        quarantined: [],
        failures: [],
      });
    }
    await withActiveMarketplaceLifecycleLease(options.env, () =>
      withActiveMarketplaceRuntimeLease(options.env, () =>
        cleanupOrphanNamespacedMarketplaceRoot({
          sourceId: options.selector.sourceId!,
          sourceIdentity,
          cwd: options.commandOptions.cwd,
          env: options.env,
        })));
    return leaseSafeRebuildResult({
      platforms: [...new Set(results.map((result) => result.target.platform))],
      plugins: [options.selector.pluginName],
      warnings: [],
      rebuildResults: results,
      targetResults: results.map(toTargetResult),
      overallState: 'succeeded',
      nativePlugins: {},
      repoManagedArtifacts: [],
      receiptTargets: results.map((result) => ({
        pluginName: result.target.pluginName,
        pluginId: result.target.pluginId,
        sourceId: result.target.sourceId,
        platform: result.target.platform,
        scope: result.target.scope,
      })),
    });
  } finally {
    for (const lock of operationLocks.reverse()) {
      await releaseRebuildOperationLease(lock);
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
  if (options.all) {
    const inventory = await inventoryCatalogSourceReferences({
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
    });
    assertCatalogSourceInventoryComplete(inventory);
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
  if (options.command === 'cleanup' && !options.all && selectors.length === 1 && selectors[0]!.sourceId) {
    const orphanCleanup = await cleanupOrphanLifecycleOnly({
      selector: selectors[0]!,
      commandOptions: options.commandOptions,
      env: runtimeEnv,
    });
    if (orphanCleanup) return orphanCleanup;
  }
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
    return await withResolvedMultiSourceCatalog({
    cliVersion: resolveRuntimeCliVersion(),
    freshnessPolicy: 'requireRemote',
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
      const closureEntries = dependencyEnabled
        ? catalog.sources.flatMap((item) => {
            const source = item.resolution!;
            const roots = selected
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
          })
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
        : closureEntries.flatMap((entry) => selectedPlatforms(options.commandOptions.platform).flatMap((platform) =>
            options.command !== 'cleanup'
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
      const stateInventory = await inventoryCatalogSourceReferences({
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
      });
      assertCatalogSourceInventoryComplete(stateInventory);
      const legacy = selectedLegacyLiveReferences(
        stateInventory.references,
        new Set(executionSelections.map((selection) => selection.platform)),
        options.commandOptions.scope,
      );
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
      if (options.command !== 'cleanup' && options.command !== 'uninstall') {
        for (const entry of closureEntries) {
          if (!entry.plugin.manifest.config?.schema) continue;
          const effective = await resolveEffectivePluginConfig({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginName: entry.plugin.manifest.name,
            manifest: entry.plugin.manifest,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
          if (effective.issues.length > 0) {
            throw namespacedPreflightError(
              `invalidConfig: ${entry.pluginId} has invalid required config: ${effective.issues.map((issue) => issue.key).join(', ')}.`,
              options.all
                ? preflightTargets
                : preflightTargets.filter((target) => target.pluginId === entry.pluginId),
            );
          }
        }
      }
      const collisionSelections = [];
      const inspection = createRebuildIntegration({
        context: {
          env: runtimeEnv,
          nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
          reporter: options.runtime?.reporter ?? createNoopReporter(),
          debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
        },
        scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
      });
      await assertAgentVersions({
        platforms: [...new Set(executionSelections.flatMap(({ entry, platform }) =>
          supportsPlatform(entry.plugin.manifest, platform) ? [platform] : []))],
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        runtime: {
          env: runtimeEnv,
          nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
          reporter: options.runtime?.reporter ?? createNoopReporter(),
          debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
        },
      });
      if (options.command !== 'cleanup' && options.command !== 'uninstall') {
        for (const { entry, platform } of executionSelections) {
          const marketplaceName = entry.source.sourceId === catalog.primarySourceId
            ? 'aw'
            : `aw-${entry.source.sourceId}`;
          const marketplaceRoot = path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId);
          entry.plugin.marketplaceName = marketplaceName;
          if (supportsPlatform(entry.plugin.manifest, platform)) {
            const target = await inspection.buildTarget({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              marketplaceName,
              marketplaceRoot,
              plugin: entry.plugin,
              platform,
              scope: options.commandOptions.scope,
              cwd: options.commandOptions.cwd,
              command: options.command,
              catalog: toCatalogResolution(entry.source),
              includeHistoricalLifecycleArtifacts: false,
              readOnlyInspectionPlan: true,
            });
            collisionSelections.push({
              pluginId: entry.pluginId,
              targetKey: `${platform}/${options.commandOptions.scope}/${path.resolve(options.commandOptions.cwd)}`,
              artifactKeys: (target.desiredOwnedComponents ?? target.ownedComponents)
                .filter((component) => !(
                  component.kind === 'shared-config'
                  && component.identity.artifactKey.startsWith('marketplace-')
                ))
                .map((component) => {
                  if ('path' in component) return path.resolve(component.path);
                  if (component.kind === 'native-plugin') return `native:${component.pluginId}`;
                  return `shared:${component.label}`;
                }),
            });
          }
        }
        const collisions = preflightDesiredArtifactCollisions(collisionSelections);
        if (collisions.length > 0) {
          throw namespacedPreflightError(
            `artifactCollision: ${collisions.map((collision) =>
              `${collision.targetKey}:${collision.artifactKey} (${collision.pluginIds.join(', ')})`).join('; ')}`,
            preflightTargets,
          );
        }
      }
      const createPlan = async (): Promise<DependencyOperationPlan> => {
        const inventory = await inventoryCatalogSourceReferences({
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
        });
        assertCatalogSourceInventoryComplete(inventory);
        const targets = [];
        for (const [order, { entry, platform }] of executionSelections.entries()) {
          const relation = selectedIds.has(entry.pluginId) ? 'requested' as const : 'dependency' as const;
          let resolvedScope = options.commandOptions.scope;
          const inspectScope = async (scope: Scope) => {
            const marketplaceName = entry.source.sourceId === catalog.primarySourceId
              ? 'aw'
              : `aw-${entry.source.sourceId}`;
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
            return inspectOwnedComponents({
              components: desired.ownedComponents,
              nativeProbe: inspection.driver.probeNative,
              verifyHealth: true,
            });
          };
          const [requestedInspection, otherInspection] = await Promise.all([
            inspectScope(resolvedScope),
            inspectScope(resolvedScope === 'user' ? 'project' : 'user'),
          ]);
          let state: 'absent' | 'present' | 'partial' | 'error' = requestedInspection.state;
          let action: 'install' | 'upgrade' | 'reinstall' | 'keep' | 'block' = relation === 'requested'
            ? options.command as 'install' | 'upgrade' | 'reinstall'
            : state === 'absent' ? 'install' : 'upgrade';
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
            action = 'block';
            errorCode = 'dependencyNotReady';
          } else if (!hasForeignCollision && relation === 'dependency'
            && options.commandOptions.scope === 'user'
            && otherInspection.state !== 'absent') {
            action = 'block';
            errorCode = 'dependencyScopeTooNarrow';
          }
          const resolvedInspection = resolvedScope === options.commandOptions.scope
            ? requestedInspection
            : otherInspection;
          if (!hasForeignCollision && relation === 'dependency'
            && (resolvedInspection.state === 'partial' || resolvedInspection.state === 'error')) {
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
          try {
            const contract = await readInstallationContract({
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginName: entry.plugin.manifest.name,
              platform,
              scope: resolvedScope,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
            });
            if (relation === 'dependency' && state === 'present' && action !== 'block') {
              if (!contract) {
                action = 'block';
                errorCode = 'dependencyContractMissing';
              } else {
                const contentDigest = entry.source.manifest.entries.find((candidate) =>
                  candidate.name === entry.plugin.manifest.name)!.contentDigest;
                action = contract.metadata.contentDigest === contentDigest ? 'keep' : 'upgrade';
              }
            }
          } catch {
            if (dependencyEnabled) {
              action = 'block';
              errorCode = 'dependencyContractInvalid';
            }
          }
          let configDigest: string | undefined;
          if (entry.plugin.manifest.config?.schema) {
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
            configDigest = `sha256:${crypto.createHash('sha256')
              .update(stableDependencyPlanJson({
                values: effective.values,
                sources: effective.sources,
                issues: effective.issues,
                ignoredUnknownKeys: effective.ignoredUnknownKeys,
                stores: {
                  user: { exists: effective.stores.user.exists, values: effective.stores.user.values },
                  project: { exists: effective.stores.project.exists, values: effective.stores.project.values },
                  projectLocal: {
                    exists: effective.stores.projectLocal.exists,
                    values: effective.stores.projectLocal.values,
                  },
                },
              })).digest('hex')}`;
          }
          targets.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            platform,
            requestedScope: options.commandOptions.scope,
            resolvedScope,
            relation,
            requiredBy: closureEntries.filter((candidate) =>
              candidate.source.sourceId === entry.source.sourceId
              && candidate.plugin.manifest.dependencies?.includes(entry.plugin.manifest.name))
              .map((candidate) => candidate.pluginId).sort(),
            state,
            action,
            order,
            ...(errorCode ? { errorCode } : {}),
            ...(configDigest ? { configDigest } : {}),
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
          sources: catalog.sources.map((item) => ({
            sourceId: item.resolution!.sourceId,
            sourceIdentity: item.resolution!.sourceIdentity,
            resolvedCommit: item.resolution!.resolvedCommit,
            manifestDigest: item.resolution!.manifestDigest,
            snapshotDigest: item.resolution!.snapshotDigest,
          })),
          nodes: closureEntries.map((entry) => {
            const manifestEntry = entry.source.manifest.entries.find((candidate) =>
              candidate.name === entry.plugin.manifest.name)!;
            return {
              pluginId: entry.pluginId,
              pluginName: entry.plugin.manifest.name,
              pluginVersion: entry.plugin.manifest.version,
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              manifestDigest: manifestEntry.manifestDigest,
              contentDigest: manifestEntry.contentDigest,
            };
          }),
          targets,
        });
      };
      const initialPlan = await createPlan();
      await options.runtime?.dependencyPlanReviewPreflight?.(initialPlan);
      if (options.runtime?.previewDependencyPlanOnly) {
        const preview = mergeRebuildCommandResults([]);
        preview.dependencyPlan = initialPlan;
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
      const operationLocks: Awaited<ReturnType<typeof acquireLifecycleOperationLock>>[] = [];
      try {
        const lockTargets = initialPlan.targets.flatMap((target) =>
          (['project', 'user'] as const).map((scope) => ({ ...target, scope })));
        for (const target of [...lockTargets].sort((left, right) =>
          comparePlatformScopeTarget(left, right)
          || left.pluginId.localeCompare(right.pluginId, 'en'))) {
          const entry = closureEntries.find((candidate) => candidate.pluginId === target.pluginId)!;
          await rebuildCommandTestHooks?.beforeOperationLockAcquire?.({
            command: options.command,
            identity: {
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              pluginId: entry.pluginId,
              pluginName: entry.plugin.manifest.name,
              pluginVersion: entry.plugin.manifest.version,
              platform: target.platform,
              scope: target.scope,
              cwd: options.commandOptions.cwd,
            },
          });
          operationLocks.push(await acquireLifecycleOperationLock({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginName: entry.plugin.manifest.name,
            platform: target.platform,
            scope: target.scope,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          }));
        }
        await options.runtime?.afterDependencyOperationLocksAcquire?.();
        for (const { entry, platform } of executionSelections.filter((selection) =>
          selectedIds.has(selection.entry.pluginId))) {
          await rebuildCommandTestHooks?.afterTargetBuilt?.({
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
          });
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
        for (const source of [...new Map(executionSelections.map(({ entry }) =>
          [entry.source.sourceId, entry.source] as const)).values()]) {
          const current = await validateCatalogSnapshot(source.rootDir);
          if (current.manifestDigest !== source.manifestDigest
            || current.snapshotDigest !== source.snapshotDigest) {
            throw namespacedPreflightError(
              'dependencyPlanStale: catalog source changed after operation locks were acquired.',
              preflightTargets,
            );
          }
        }
        const lockedPlan = await createPlan();
        await options.runtime?.dependencyPlanReviewPreflight?.(lockedPlan);
        if (lockedPlan.planDigest !== initialPlan.planDigest) {
          throw namespacedPreflightError(
            'dependencyPlanStale: dependency state changed before execution.',
            preflightTargets,
          );
        }
        const lockedCollisionSelections = [];
        for (const { entry, platform } of executionSelections) {
          const marketplaceName = entry.source.sourceId === catalog.primarySourceId
            ? 'aw'
            : `aw-${entry.source.sourceId}`;
          const target = await inspection.buildTarget({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginId: entry.pluginId,
            marketplaceName,
            marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
            plugin: entry.plugin,
            platform,
            scope: lockedPlan.targets.find((candidate) =>
              candidate.pluginId === entry.pluginId && candidate.platform === platform)!.resolvedScope,
            cwd: options.commandOptions.cwd,
            command: options.command,
            catalog: toCatalogResolution(entry.source),
            includeHistoricalLifecycleArtifacts: false,
            readOnlyInspectionPlan: true,
          });
          lockedCollisionSelections.push({
            pluginId: entry.pluginId,
            targetKey: `${platform}/${target.identity.scope}/${path.resolve(options.commandOptions.cwd)}`,
            artifactKeys: (target.desiredOwnedComponents ?? target.ownedComponents)
              .filter((component) => !(component.kind === 'shared-config'
                && component.identity.artifactKey.startsWith('marketplace-')))
              .map((component) => 'path' in component
                ? path.resolve(component.path)
                : component.kind === 'native-plugin'
                  ? `native:${component.pluginId}`
                  : `shared:${component.label}`),
          });
        }
        const lockedCollisions = preflightDesiredArtifactCollisions(lockedCollisionSelections);
        if (lockedCollisions.length > 0) {
          throw namespacedPreflightError(
            `artifactCollision: ${lockedCollisions.map((collision) =>
              `${collision.targetKey}:${collision.artifactKey} (${collision.pluginIds.join(', ')})`).join('; ')}`,
            preflightTargets,
          );
        }
        const blockers = lockedPlan.targets.filter((target) => target.action === 'block');
        if (blockers.length > 0) {
          const firstCode = blockers[0]!.errorCode ?? 'dependencyNotReady';
          throw namespacedPreflightError(
            `${firstCode}: dependency preflight blocked ${blockers.map((target) =>
              `${target.pluginId}:${target.platform}/${target.resolvedScope}`).join(', ')}.`,
            preflightTargets,
          );
        }
        const removalContractsByTarget = new Map<string, ReadInstallationContract>();
        const removalRequiredConsumers = new Map<string, Set<string>>();
        if (options.command === 'cleanup' || options.command === 'uninstall') {
          const removalStateInventory = await inventoryCatalogSourceReferences({
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            includeHistoricalProjects: true,
          });
          assertCatalogSourceInventoryComplete(removalStateInventory);
          const contractInventory = await inventoryInstallationContracts({ env: runtimeEnv });
          if (contractInventory.errors.length > 0) {
            throw namespacedPreflightError(
              'stateInventoryFailed: installation contract inventory is incomplete.',
              preflightTargets,
            );
          }
          const targetKey = (value: {
            pluginId: string;
            sourceIdentity: string;
            platform: PlatformName;
            scope: Scope;
            projectKey: string | null;
          }) => [
            value.pluginId,
            value.sourceIdentity,
            value.platform,
            value.scope,
            value.projectKey ?? '',
          ].join('\0');
          const plannedTargets = new Map<string, {
            selection: (typeof executionSelections)[number];
            contractTarget: Awaited<ReturnType<typeof resolveInstallationContractTarget>>;
          }>();
          for (const selection of executionSelections) {
            const planned = lockedPlan.targets.find((target) =>
              target.pluginId === selection.entry.pluginId && target.platform === selection.platform)!;
            const contractTarget = await resolveInstallationContractTarget({
              sourceId: selection.entry.source.sourceId,
              sourceIdentity: selection.entry.source.sourceIdentity,
              pluginName: selection.entry.plugin.manifest.name,
              platform: selection.platform,
              scope: planned.resolvedScope,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
            });
            plannedTargets.set(targetKey({
              pluginId: selection.entry.pluginId,
              sourceIdentity: selection.entry.source.sourceIdentity,
              platform: selection.platform,
              scope: planned.resolvedScope,
              projectKey: contractTarget.projectKey,
            }), { selection, contractTarget });
          }
          const removalEdges = new Map<string, Set<string>>();
          const inspectConsumer = async (options_: {
            entry: (typeof available)[number];
            platform: PlatformName;
            scope: Scope;
            cwd: string;
          }): Promise<'absent' | 'live'> => {
            const marketplaceName = options_.entry.source.sourceId === catalog.primarySourceId
              ? 'aw'
              : `aw-${options_.entry.source.sourceId}`;
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
          for (const contract of contractInventory.contracts) {
            const consumerKey = targetKey({
              pluginId: contract.metadata.pluginId,
              sourceIdentity: contract.metadata.sourceIdentity,
              platform: contract.metadata.platform,
              scope: contract.metadata.scope,
              projectKey: contract.metadata.projectKey,
            });
            if (plannedTargets.has(consumerKey)) {
              removalContractsByTarget.set(consumerKey, contract);
            }
            for (const dependency of contract.metadata.dependencies) {
              const dependencyKey = targetKey({
                pluginId: dependency.pluginId,
                sourceIdentity: dependency.sourceIdentity,
                platform: dependency.platform,
                scope: dependency.scope,
                projectKey: dependency.projectKey,
              });
              if (!plannedTargets.has(dependencyKey)) continue;
              if (plannedTargets.has(consumerKey)) {
                const outgoing = removalEdges.get(consumerKey) ?? new Set<string>();
                outgoing.add(dependencyKey);
                removalEdges.set(consumerKey, outgoing);
                const dependencySelection = plannedTargets.get(dependencyKey)!.selection;
                const consumerSelection = plannedTargets.get(consumerKey)!.selection;
                const dependencyExecutionKey = `${dependencySelection.entry.pluginId}\0${dependencySelection.platform}`;
                const required = removalRequiredConsumers.get(dependencyExecutionKey) ?? new Set<string>();
                required.add(`${consumerSelection.entry.pluginId}\0${consumerSelection.platform}`);
                removalRequiredConsumers.set(dependencyExecutionKey, required);
                continue;
              }
              const consumerEntry = available.find((candidate) =>
                candidate.pluginId === contract.metadata.pluginId
                && candidate.source.sourceIdentity === contract.metadata.sourceIdentity);
              if (!consumerEntry) {
                throw namespacedPreflightError(
                  `dependencyStillRequired: cannot inspect consumer ${contract.metadata.pluginId}.`,
                  preflightTargets,
                );
              }
              try {
                if (await inspectConsumer({
                  entry: consumerEntry,
                  platform: contract.metadata.platform,
                  scope: contract.metadata.scope,
                  cwd: contract.metadata.projectKey ?? options.commandOptions.cwd,
                }) !== 'absent') {
                  throw new Error('consumer is present, partial, or unreadable');
                }
              } catch {
                throw namespacedPreflightError(
                  `dependencyStillRequired: ${dependency.pluginId} is required by ${contract.metadata.pluginId}.`,
                  preflightTargets,
                );
              }
            }
          }
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
            const key = [entry.pluginId, reference.platform, reference.scope].join('\0');
            return [[key, { entry, platform: reference.platform, scope: reference.scope }] as const];
          })).values()];
          for (const [dependencyKey, dependencyTarget] of plannedTargets) {
            const dependencyPluginName = dependencyTarget.selection.entry.plugin.manifest.name;
            for (const consumer of currentConsumerCandidates) {
              if (consumer.entry.source.sourceId
                  !== dependencyTarget.selection.entry.source.sourceId
                || !consumer.entry.plugin.manifest.dependencies?.includes(dependencyPluginName)
                || consumer.platform !== dependencyTarget.selection.platform
                || (consumer.scope === 'user'
                  && dependencyTarget.contractTarget.scope !== 'user')) continue;
              const consumerContractTarget = await resolveInstallationContractTarget({
                sourceId: consumer.entry.source.sourceId,
                sourceIdentity: consumer.entry.source.sourceIdentity,
                pluginName: consumer.entry.plugin.manifest.name,
                platform: consumer.platform,
                scope: consumer.scope,
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
              });
              const consumerKey = targetKey({
                pluginId: consumer.entry.pluginId,
                sourceIdentity: consumer.entry.source.sourceIdentity,
                platform: consumer.platform,
                scope: consumer.scope,
                projectKey: consumerContractTarget.projectKey,
              });
              const hasValidContract = contractInventory.contracts.some((contract) =>
                targetKey({
                  pluginId: contract.metadata.pluginId,
                  sourceIdentity: contract.metadata.sourceIdentity,
                  platform: contract.metadata.platform,
                  scope: contract.metadata.scope,
                  projectKey: contract.metadata.projectKey,
                }) === consumerKey
                && contract.metadata.contentDigest === consumer.entry.source.manifest.entries.find((entry) =>
                  entry.name === consumer.entry.plugin.manifest.name)?.contentDigest);
              if (hasValidContract) continue;
              if (plannedTargets.has(consumerKey)) {
                const outgoing = removalEdges.get(consumerKey) ?? new Set<string>();
                outgoing.add(dependencyKey);
                removalEdges.set(consumerKey, outgoing);
                const dependencyExecutionKey = `${dependencyTarget.selection.entry.pluginId}\0${consumer.platform}`;
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
                  cwd: consumerContractTarget.projectKey ?? options.commandOptions.cwd,
                }) !== 'absent') {
                  throw new Error('consumer is present, partial, or unreadable');
                }
              } catch {
                throw namespacedPreflightError(
                  `dependencyStillRequired: ${dependencyTarget.selection.entry.pluginId} is required by ${consumer.entry.pluginId}.`,
                  preflightTargets,
                );
              }
            }
          }
          const orderedKeys: string[] = [];
          const remaining = new Set(plannedTargets.keys());
          while (remaining.size > 0) {
            const ready = [...remaining].filter((candidate) =>
              ![...remaining].some((other) => removalEdges.get(other)?.has(candidate)))
              .sort();
            if (ready.length === 0) {
              throw namespacedPreflightError(
                'dependencyContractInvalid: installation contract removal graph contains a cycle.',
                preflightTargets,
              );
            }
            for (const key of ready) {
              orderedKeys.push(key);
              remaining.delete(key);
            }
          }
          executionSelections = orderedKeys.map((key) => plannedTargets.get(key)!.selection);
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
        const marketplaceName = entry.source.sourceId === catalog.primarySourceId
          ? 'aw'
          : `aw-${entry.source.sourceId}`;
        const namespacedSource = {
          sourceId: entry.source.sourceId,
          sourceIdentity: entry.source.sourceIdentity,
          marketplaceName,
          marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', entry.source.sourceId),
        };
        entry.plugin.marketplaceName = marketplaceName;
        let executionResult = await runSingleSourceRebuildCommand({
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
            catalogResolution: toCatalogResolution(entry.source),
            namespacedSource,
            operationLeaseHeld: true,
            installationContractHandledExternally: true,
            dependencyReviewPreflightHandled: true,
            targetBuiltHookHandled: true,
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
        if (executionResult.overallState === 'succeeded') {
          const contractTarget = await resolveInstallationContractTarget({
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            pluginName: entry.plugin.manifest.name,
            platform,
            scope: planned.resolvedScope,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
          });
          const dependencies: InstallationDependencyPlacement[] = options.command === 'cleanup'
            || options.command === 'uninstall' ? [] : directDependencyIds.map((pluginId) => {
            const dependencyTarget = lockedPlan.targets.find((target) =>
              target.pluginId === pluginId && target.platform === platform)!;
            return {
              pluginId,
              sourceId: entry.source.sourceId,
              sourceIdentity: entry.source.sourceIdentity,
              platform,
              scope: dependencyTarget.resolvedScope,
              projectKey: dependencyTarget.resolvedScope === 'project'
                ? contractTarget.projectKey
                : null,
            };
          });
          if (options.command === 'cleanup' || options.command === 'uninstall') {
            const ownContract = [...removalContractsByTarget.values()].find((contract) =>
              contract.metadata.pluginId === entry.pluginId
              && contract.metadata.sourceIdentity === entry.source.sourceIdentity
              && contract.metadata.platform === platform
              && contract.metadata.scope === planned.resolvedScope
              && (planned.resolvedScope === 'user'
                || contract.metadata.projectKey === contractTarget.projectKey));
            if (ownContract) {
              try {
                await removeInstallationContract({
                  sourceId: entry.source.sourceId,
                  sourceIdentity: entry.source.sourceIdentity,
                  pluginName: entry.plugin.manifest.name,
                  platform,
                  scope: planned.resolvedScope,
                  cwd: ownContract.metadata.projectKey ?? options.commandOptions.cwd,
                  env: runtimeEnv,
                  expectedMetadataIntegrityDigest: ownContract.metadata.metadataIntegrityDigest,
                });
              } catch (error) {
                const message = `dependencyContractInvalid: ${error instanceof Error ? error.message : String(error)}`;
                const failed = failedResult(options.command, identity, message, 'postcheck.inspect');
                executionResult = {
                  ...executionResult,
                  rebuildResults: [failed],
                  targetResults: [{ target: identity, action: planned.action, state: 'failed',
                    errorCode: 'dependencyContractInvalid', message }],
                  overallState: 'failed',
                };
              }
            }
          } else {
            let staged;
            try {
              staged = await stageInstallationContract({
                sourceId: entry.source.sourceId,
                sourceIdentity: entry.source.sourceIdentity,
                pluginName: entry.plugin.manifest.name,
                pluginVersion: entry.plugin.manifest.version,
                contentDigest: entry.source.manifest.entries.find((candidate) =>
                  candidate.name === entry.plugin.manifest.name)!.contentDigest,
                platform,
                scope: planned.resolvedScope,
                cwd: options.commandOptions.cwd,
                dependencies,
                env: runtimeEnv,
              });
              await promoteInstallationContract(staged);
            } catch (error) {
              if (staged) await discardInstallationContract(staged).catch(() => undefined);
              const message = `dependencyContractInvalid: ${error instanceof Error ? error.message : String(error)}`;
              const failed = failedResult(options.command, identity, message, 'postcheck.inspect');
              executionResult = {
                ...executionResult,
                rebuildResults: [failed],
                targetResults: [{ target: identity, action: planned.action, state: 'failed',
                  errorCode: 'dependencyContractInvalid', message }],
                overallState: 'failed',
              };
            }
          }
        }
        results.push(executionResult);
        dependencyStates.set(`${entry.pluginId}\0${platform}`,
          executionResult.overallState === 'succeeded' ? 'completed' : 'failed');
      }
      const merged = mergeRebuildCommandResults(results);
      merged.dependencyPlan = lockedPlan;
      return leaseSafeRebuildResult(merged);
      } finally {
        for (const lock of operationLocks.reverse()) await releaseRebuildOperationLease(lock);
      }
    },
    });
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
    if (!(
      (message.includes('Catalog source') && message.includes('does not exist'))
      || message.startsWith('Cannot resolve required catalog sources:')
      || message.includes('does not exist in the required catalog source set')
    )) throw error;
    if (selectors.length !== 1 || !selectors[0]!.sourceId) throw error;
    const selector = selectors[0]!;
    const sourceId = selector.sourceId!;
    const inventory = await inventoryCatalogSourceReferences({
      cwd: options.commandOptions.cwd,
      env: runtimeEnv,
    });
    assertCatalogSourceInventoryComplete(inventory);
    const requestedPlatforms = new Set(selectedPlatforms(options.commandOptions.platform));
    const liveEvidence = inventory.references.filter((reference) =>
      (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
      && reference.sourceId === sourceId
      && reference.pluginName === selector.pluginName
      && reference.sourceIdentity
      && reference.scope === options.commandOptions.scope
      && reference.platform
      && requestedPlatforms.has(reference.platform as PlatformName));
    if (liveEvidence.length === 0) throw error;
    const identities = new Set(liveEvidence.map((reference) => reference.sourceIdentity!));
    if (identities.size !== 1) {
      throw new Error(`sourceChanged: ${sourceId}/${selector.pluginName} live state has conflicting source identities.`);
    }
    const nativeEvidence = liveEvidence.filter((reference) => reference.kind === 'namespacedMarketplace');
    const marketplaceNames = new Set(nativeEvidence.map((reference) => reference.marketplaceName).filter(Boolean));
    if (marketplaceNames.size > 1 || nativeEvidence.some((reference) => !reference.marketplaceName)) {
      throw new Error(`sourceMissing: ${sourceId}/${selector.pluginName} native marketplace evidence is invalid.`);
    }
    const sourceIdentity = [...identities][0]!;
    const marketplaceName = [...marketplaceNames][0] ?? `aw-${sourceId}`;
    return runSingleSourceRebuildCommand({
      ...options,
      pluginNames: [selector.pluginName],
      runtime: {
        ...options.runtime,
        env: runtimeEnv,
        catalogResolution: { rootDir: resolveAwHome(runtimeEnv), source: 'local' },
        lostSourceRecovery: true,
        namespacedSource: {
          sourceId,
          sourceIdentity,
          marketplaceName,
          marketplaceRoot: path.join(resolveAwHome(runtimeEnv), 'marketplaces', sourceId),
        },
      },
    });
  }
}
