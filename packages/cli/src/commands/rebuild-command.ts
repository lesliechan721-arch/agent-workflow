import path from 'node:path';

import type {
  CatalogSourceResolution,
  CatalogResolution,
  CommandOptions,
  InstallCommandOptions,
  PlatformName,
  PluginMeta,
  RebuildReceiptOverallState,
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
import { createCodexNativeObservationSession } from '../utils/codex-native-observation.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveAwHome, resolveCodexPaths } from '../utils/paths.js';
import { resolveCliPackageRoot } from '../utils/paths.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import { buildGeneratedName } from '../generators/shared.js';
import {
  createCodexReconcilePlan,
  type CodexReconcilePlan,
  type CodexReconcilerCatalogTarget,
  type CodexReconcilerLiveEvidence,
} from '../utils/codex-reconciler.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import {
  executeRebuildOperation,
  prepareRebuildOperation,
  type DesiredTarget,
  type PreparedRebuildOperation,
  type RebuildCommand,
  type RebuildFailure,
  type RebuildResult,
  type RebuildTargetIdentity,
} from './rebuild-operations.js';
import {
  assertNoClaudeUnboundNativeNameCollision,
  CodexActivationPostcheckError,
  createRebuildIntegration,
  executeCodexReconcileActivations,
  inspectCodexPluginRegistrationLive,
  inspectCodexSharedNativeLive,
  inspectNativeMarketplaceRegistrations,
  postcheckCodexReconcileActivations,
  type CodexPluginRegistrationLiveInspection,
  type PreparedRebuildTarget,
  type RebuildExecutionContext,
  type RebuildIntegration,
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
  calculateCodexNativeRenderPayloadDigest,
  calculateCodexSharedNativePayloadDigest,
} from '../utils/catalog-digests.js';
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
  type CatalogSourceReferenceInventory,
} from '../utils/catalog-source-references.js';
import { sanitizeCatalogSourceErrorMessage } from '../utils/catalog-public-error.js';
import { resolveEffectivePluginConfig } from '../utils/plugin-config.js';
import { resolveArtifactRenderConfig } from '../utils/artifact-renderer.js';
import {
  cleanupOwnedComponents,
  inspectOwnedComponents,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  SKILL_OWNER_MARKER,
  type OwnedComponent,
} from '../utils/ownership.js';
import { resolveActiveCatalogPluginShallow } from '../utils/catalog-generation-resolver.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  codexProjectConfigAliasesUserHome,
  getClaudeHome,
  getCodexHome,
  resolveCanonicalRepoProjectKey,
  resolveRepoRootSync,
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
import {
  validateCatalogSnapshotComplete,
  validateCatalogSnapshotPluginEntriesComplete,
} from '../utils/catalog-snapshot.js';
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
  forceOfflineCleanupEvidence,
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
    logicalIdentity: string;
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
  scriptTimeoutMs?: number;
  directCli?: boolean;
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  codexManagerResolver?: typeof resolveCodexManager;
  codexOperationConsumerResolver?: typeof resolveCodexOperationConsumer;
  codexManagerPreviewer?: typeof previewCodexManager;
  onPreviewStage?: (stage: 'catalog' | 'inventory' | 'dependencyPlan') => Promise<void> | void;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
  operationDiagnosticSink?: (results: readonly RebuildResult[]) => void;
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
  logicalIdentity?: string;
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
  overallState: RebuildReceiptOverallState;
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

function assertRebuildCatalogSourceInventoryComplete(
  inventory: CatalogSourceReferenceInventory,
  targetScope: Scope,
): void {
  if (targetScope !== 'user') {
    assertCatalogSourceInventoryComplete(inventory);
    return;
  }
  assertCatalogSourceInventoryComplete({
    ...inventory,
    errors: inventory.errors.filter((error) =>
      error.relevance.global
      || error.relevance.scope !== 'project'
      || !error.kind.startsWith('config')),
  });
}

const MALFORMED_CONFIG_PRESERVED_WARNING =
  'pluginConfigPreserved: 目标插件的无效配置文件已保留。可稍后运行 aw config reset 清理。';
const OBSOLETE_CONTRACTS_CLEANUP_WARNING =
  'obsoleteContractsCleanupFailed: Obsolete installation contracts could not be removed.';

function omitSelectedPluginConfigErrors(
  inventory: CatalogSourceReferenceInventory,
  targets: ReadonlyArray<{ sourceId: string; pluginName: string }>,
): { inventory: CatalogSourceReferenceInventory; omitted: boolean } {
  let omitted = false;
  const errors = inventory.errors.filter((error) => {
    const relevance = error.relevance;
    const selected = error.kind.startsWith('config') && targets.some((target) => {
      if (!relevance.global
        && relevance.sourceId === target.sourceId
        && relevance.pluginName === target.pluginName) return true;
      const location = error.location.replaceAll('\\', '/');
      return location.endsWith(
        `/plugin-config/${target.sourceId}/${target.pluginName}/config.json`,
      );
    });
    if (selected) omitted = true;
    return !selected;
  });
  return { inventory: { ...inventory, errors }, omitted };
}

function selectedPlatforms(selection: CommandOptions['platform']): PlatformName[] {
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function selectCodexActivationPlans(
  plans: readonly CodexReconcilePlan[],
  pluginIds: ReadonlySet<string>,
): CodexReconcilePlan[] {
  return plans.flatMap((plan) => {
    if (!plan.desiredTargets.some((target) => pluginIds.has(target.pluginId))) return [];
    const sharedNativeActions = plan.sharedNativeActions.filter((action) =>
      pluginIds.has(action.pluginId));
    const userActions = plan.activationActions.user.filter((action) =>
      pluginIds.has(action.pluginId));
    const projectActions = plan.activationActions.project.filter((action) =>
      pluginIds.has(action.pluginId));
    const postcheckPlugins = plan.postcheck.plugins.filter((plugin) =>
      pluginIds.has(plugin.pluginId));
    const codexPluginIds = new Set([
      ...sharedNativeActions.map((action) => action.codexPluginId),
      ...userActions.map((action) => action.codexPluginId),
      ...projectActions.map((action) => action.codexPluginId),
      ...postcheckPlugins.map((plugin) => plugin.codexPluginId),
    ]);
    return [{
      ...plan,
      activationActions: { user: userActions, project: projectActions },
      staleActivationRemovals: plan.staleActivationRemovals.filter((action) =>
        codexPluginIds.has(action.codexPluginId)),
      postcheck: { ...plan.postcheck, plugins: postcheckPlugins },
    }];
  });
}

function failedCodexActivationPluginIds(options: {
  error: unknown;
  plans: readonly CodexReconcilePlan[];
  successfulPluginIds: ReadonlySet<string>;
}): Set<string> {
  const error = options.error;
  if (!(error instanceof CodexActivationPostcheckError)) {
    return new Set(options.successfulPluginIds);
  }
  const ownersByCodexPluginId = new Map<string, Set<string>>();
  for (const entry of options.plans.flatMap((plan) => [
    ...plan.activationActions.user,
    ...plan.activationActions.project,
    ...plan.postcheck.plugins,
  ])) {
    const owners = ownersByCodexPluginId.get(entry.codexPluginId) ?? new Set<string>();
    owners.add(entry.pluginId);
    ownersByCodexPluginId.set(entry.codexPluginId, owners);
  }
  const failed = new Set<string>();
  for (const codexPluginId of error.codexPluginIds) {
    const owners = ownersByCodexPluginId.get(codexPluginId);
    if (!owners || owners.size === 0) return new Set(options.successfulPluginIds);
    for (const pluginId of owners) {
      if (options.successfulPluginIds.has(pluginId)) failed.add(pluginId);
    }
  }
  return failed.size > 0 ? failed : new Set(options.successfulPluginIds);
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

interface IntentCatalogDependencyEntry {
  pluginId: string;
  dependencyPluginIds: string[];
}

function pruneUnreachableDependencyScopeOverrides(
  state: PluginIntentState,
  catalogEntries: readonly IntentCatalogDependencyEntry[] | undefined,
): PluginIntentState {
  if (!catalogEntries || state.dependencyScopeOverrides.length === 0) return state;
  const byId = new Map(catalogEntries.map((entry) => [entry.pluginId, entry]));
  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (pluginId: string, platform: PlatformName, root: boolean): boolean => {
    const entry = byId.get(pluginId);
    if (!entry || visiting.has(pluginId)) return false;
    const visitKey = `${pluginId}\0${platform}`;
    if (visited.has(visitKey)) {
      if (!root) reachable.add(visitKey);
      return true;
    }
    visiting.add(pluginId);
    for (const dependencyPluginId of entry.dependencyPluginIds) {
      if (!visit(dependencyPluginId, platform, false)) return false;
    }
    visiting.delete(pluginId);
    visited.add(visitKey);
    if (!root) reachable.add(visitKey);
    return true;
  };
  for (const root of state.roots) {
    for (const platform of root.platforms) {
      visiting.clear();
      if (!visit(root.pluginId, platform, true)) return state;
    }
  }
  return canonicalizePluginIntentState({
    ...state,
    dependencyScopeOverrides: state.dependencyScopeOverrides.filter((override) =>
      reachable.has(`${override.pluginId}\0${override.platform}`)),
  });
}

function deriveDesiredIntentState(options: {
  command: RebuildCommand;
  state: PluginIntentState;
  selectedRoots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  plan: ReconcileOperationPlan;
  catalogEntries?: readonly IntentCatalogDependencyEntry[];
}): PluginIntentState {
  let next = options.state;
  if (options.command === 'install') {
    for (const root of options.selectedRoots) next = mergePluginIntentRootPlatforms(next, root);
    next = updateIntentOverrides({ state: next, plan: options.plan });
  } else if (options.command === 'uninstall') {
    for (const root of options.selectedRoots) next = removePluginIntentRootPlatforms(next, root);
    next = pruneUnreachableDependencyScopeOverrides(next, options.catalogEntries);
  }
  return next;
}

function removeSelectedRootPlatformsFromOtherScope(options: {
  state: PluginIntentState;
  selectedRoots: Array<{ pluginId: string; platforms: PlatformName[] }>;
  preserveCodexRootIds: ReadonlySet<string>;
}): PluginIntentState {
  let next = options.state;
  for (const root of options.selectedRoots) {
    const platforms = root.platforms.filter((platform) =>
      platform !== 'codex' || !options.preserveCodexRootIds.has(root.pluginId));
    if (platforms.length > 0) {
      next = removePluginIntentRootPlatforms(next, { ...root, platforms });
    }
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
  preserveOtherCodexScopeRootIds: ReadonlySet<string>;
  catalogEntries: readonly IntentCatalogDependencyEntry[];
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
    catalogEntries: options.catalogEntries,
  });
  const superset = next;
  await writePluginIntentState(location, superset);
  const writes = [{ location, superset }];

  if (options.command === 'install' || options.codexPlan) {
    const otherScope: Scope = options.scope === 'user' ? 'project' : 'user';
    const otherLocation = { scope: otherScope, cwd: options.cwd, env: options.env };
    let other = await readPluginIntentState(otherLocation);
    if (options.command === 'install') {
      other = removeSelectedRootPlatformsFromOtherScope({
        state: other,
        selectedRoots: options.selectedRoots,
        preserveCodexRootIds: options.preserveOtherCodexScopeRootIds,
      });
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
  const errorPrefix = result.status === 'failed'
    ? result.error.message.split(':', 1)[0]
    : undefined;
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
    ...(result.status === 'failed' ? {
      message: result.error.message,
      errorCode: result.error.phase === 'preApply'
        ? 'preApplyFailed'
        : errorPrefix && /^[A-Za-z][A-Za-z0-9]*$/u.test(errorPrefix)
          ? errorPrefix
          : 'writeFailed',
    } : {}),
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
    operationPreparation?: PreparedRebuildOperation;
    integration?: RebuildIntegration;
    preparationError?: unknown;
    reviewCompleted?: boolean;
    targetHookCompleted?: boolean;
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
    codexObservationSession: options.runtime?.codexObservationSession,
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
      plugin.catalogLogicalIdentity = options.runtime.namespacedSource.logicalIdentity;
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
  const integration = options.execution?.integration ?? createRebuildIntegration({
    context: runtime,
    scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
    ...(options.execution?.prepared
      ? { preparedTargets: [options.execution.prepared.target] }
      : {}),
  });
  const targets = [];
  const results: RebuildResult[] = [];
  const warnings: string[] = [];
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
        const driver = integration.driver;
        result = await executeRebuildOperation({
          command: options.command,
          target,
          driver,
          ...(options.execution?.operationPreparation
            ? { preparation: options.execution.operationPreparation }
            : {}),
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
    overallState: successful.length === results.length
      ? 'succeeded'
      : successful.length > 0 ? 'partial' : 'failed',
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
      : rebuildResults.some((result) => result.status === 'succeeded') ? 'partial' : 'failed',
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

function reconcileOverallState(
  targetResults: readonly ReceiptTargetResult[],
  plan: ReconcileOperationPlan,
  rebuildResults: readonly RebuildResult[] = [],
): RebuildReceiptOverallState {
  const failed = targetResults.some((result) =>
    result.state === 'failed' || result.action === 'skipped');
  if (!failed) return 'succeeded';
  const requested = new Set(plan.targets
    .filter((target) => target.relation === 'requested')
    .map((target) => `${target.pluginId}\0${target.platform}`));
  const completedRequested = targetResults.some((result) =>
    result.state === 'completed'
    && result.action !== 'skipped'
    && result.target.pluginId !== undefined
    && requested.has(`${result.target.pluginId}\0${result.target.platform}`));
  const completedMutation = targetResults.some((result) =>
    result.state === 'completed'
    && result.action !== 'keep'
    && result.action !== 'skipped');
  const observedMutation = rebuildResults.some((result) => result.actions.some((action) =>
    action.status === 'succeeded'
    && (action.name === 'stale.cleanup'
      || action.name === 'native.write'
      || action.name === 'artifacts.write'
      || action.name === 'cleanup.owned')));
  return completedRequested || completedMutation || observedMutation ? 'partial' : 'failed';
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
  catalogEntries: readonly IntentCatalogDependencyEntry[];
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
    catalogEntries: options.catalogEntries,
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
      activationDisposition = 'disable';
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
    if (target.marketplaceIdentityUnresolved) {
      result.residual.push('nativeMarketplaceIdentityUnresolved');
      warnings.push(
        `nativeMarketplaceIdentityUnresolved: Preserved ambiguous native registration for ${target.pluginId} on ${target.platform}/${target.scope}.`,
      );
    }
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
  } catch {
    warnings.push(OBSOLETE_CONTRACTS_CLEANUP_WARNING);
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
  await options.onPreviewStage?.('inventory');
  const preview = mergeRebuildCommandResults([]);
  preview.warnings.push(...options.targets.flatMap((target) =>
    target.marketplaceIdentityUnresolved
      ? [`nativeMarketplaceIdentityUnresolved: Preserved ambiguous native registration for ${target.pluginId} on ${target.platform}/${target.scope}.`]
      : []));
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

async function buildForceExclusiveCleanupPlan(options: {
  selectors: string[];
  platforms: PlatformName[];
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  primarySourceId?: string;
  damagedOnly?: boolean;
}): Promise<{ targets: DesiredTarget[]; evidence: OfflineCleanupTargetEvidence[] }> {
  const targets: DesiredTarget[] = [];
  const evidence: OfflineCleanupTargetEvidence[] = [];
  for (const selector of options.selectors) {
    const parsed = parsePluginId(selector);
    const sourceId = parsed.sourceId ?? options.primarySourceId;
    if (!sourceId) {
      throw namespacedPreflightError(
        'forceCleanupPathUnavailable: The selected plugin has no local Active source identity. Restore the local Active bundle, then retry cleanup --force, or inspect and remove the exact output manually.',
        [],
      );
    }
    let active: Awaited<ReturnType<typeof resolveActiveCatalogPluginShallow>>;
    let plugin: PluginMeta;
    try {
      active = await resolveActiveCatalogPluginShallow({
        sourceId,
        pluginName: parsed.pluginName,
        env: options.env,
      });
      plugin = active.plugin;
    } catch {
      const unavailableTarget = options.platforms.map((platform) => ({
        pluginId: formatPluginId({ sourceId, pluginName: parsed.pluginName }),
        pluginName: parsed.pluginName,
        sourceId,
        sourceIdentity: 'unavailable',
        platform,
        scope: options.scope,
      }));
      throw namespacedPreflightError(
        'forceCleanupPathUnavailable: The exact exclusive output path is unavailable from live evidence and the local Active bundle. Restore the local Active bundle, then retry cleanup --force, or inspect and remove the exact output manually.',
        unavailableTarget,
      );
    }
    const pluginId = formatPluginId({ sourceId, pluginName: parsed.pluginName });
    plugin.sourceId = sourceId;
    plugin.sourceIdentity = active.sourceIdentity;
    plugin.catalogLogicalIdentity = active.logicalIdentity;
    plugin.pluginId = pluginId;
    plugin.marketplaceName = sourceId === options.primarySourceId ? 'aw' : `aw-${sourceId}`;
    const context: RebuildExecutionContext = {
      env: options.env,
      nativeCliRunner: getDefaultNativeCliRunner(),
      reporter: createNoopReporter(),
      debugLogger: createNoopDebugLogger(),
    };
    const integration = createRebuildIntegration({ context });
    for (const platform of options.platforms) {
      const inspectedTarget = await integration.buildTarget({
        sourceId,
        sourceIdentity: active.sourceIdentity,
        pluginId,
        marketplaceName: plugin.marketplaceName,
        marketplaceRoot: path.join(resolveAwHome(options.env), 'marketplaces', sourceId),
        plugin,
        platform,
        scope: options.scope,
        cwd: options.cwd,
        command: 'install',
        catalog: {
          rootDir: active.snapshotPath,
          source: 'local',
          catalogVersion: active.catalogVersion,
        },
        readOnlyInspectionPlan: true,
        readOnlyShallowInspectionPlan: true,
      });
      const expected = [...new Set([
        ...(inspectedTarget.desiredOwnedComponents ?? []),
        ...(inspectedTarget.optionalOwnedComponents ?? []),
      ])].filter((component): component is Extract<OwnedComponent, { path: string }> =>
        component.kind === 'skill-directory' || component.kind === 'owned-text-file');
      const inspection = await inspectOwnedComponents({
        components: expected,
        executor: integration.driver.ownership,
        forceExclusive: true,
      });
      const ordinaryInspection = await inspectOwnedComponents({
        components: expected,
        executor: integration.driver.ownership,
      });
      const removable = inspection.components.flatMap((entry) =>
        entry.state === 'present'
        && (options.damagedOnly !== true
          || ordinaryInspection.components.find((candidate) => candidate.component === entry.component)?.state !== 'present')
        && 'path' in entry.component
          ? [entry.component as Extract<OwnedComponent, { path: string }>]
          : []);
      if (removable.length === 0) continue;
      const target: DesiredTarget = {
        ...inspectedTarget,
        ownedComponents: removable,
        desiredOwnedComponents: removable,
        optionalOwnedComponents: [],
        requiresNative: false,
        writeNativeRequired: false,
        artifacts: inspectedTarget.artifacts.filter((artifact) =>
          removable.some((component) => path.resolve(component.path) === path.resolve(artifact.path))),
        operationActions: [],
        forceExclusiveCleanup: true,
      };
      targets.push(target);
      evidence.push(await forceOfflineCleanupEvidence({
        reason: 'bundleUnavailable',
        pluginId,
        pluginName: parsed.pluginName,
        sourceId,
        sourceIdentity: active.sourceIdentity,
        platform,
        scope: options.scope,
        components: removable,
      }));
    }
  }
  if (targets.length === 0) {
    return { targets, evidence };
  }
  return { targets, evidence };
}

async function buildLiveForceExclusiveCleanupPlan(options: {
  targets: LiveCleanupTarget[];
  inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): Promise<{ targets: DesiredTarget[]; evidence: OfflineCleanupTargetEvidence[] }> {
  const targets: DesiredTarget[] = [];
  const evidence: OfflineCleanupTargetEvidence[] = [];
  for (const target of options.targets) {
    const components: Array<Extract<OwnedComponent, { path: string }>> = [];
    const references = options.inventory.references.filter((reference) =>
      reference.kind === 'namespacedOwner'
      && reference.sourceId === target.sourceId
      && reference.pluginName === target.pluginName
      && reference.platform === target.platform
      && reference.scope === target.scope);
    for (const reference of references) {
      if (path.basename(reference.location) === SKILL_OWNER_MARKER) {
        const skillRoot = path.dirname(reference.location);
        const allowedRoot = path.dirname(skillRoot);
        const marker = await readSkillOwnerMarker({ skillRoot, allowedRoot }).catch(() => null);
        if (marker
          && marker.sourceId === target.sourceId
          && marker.pluginId === target.pluginId
          && marker.platform === target.platform
          && marker.scope === target.scope) {
          components.push({ kind: 'skill-directory', path: skillRoot, allowedRoot, identity: marker });
        }
        continue;
      }
      const parsed = await fs.readFile(reference.location, 'utf8')
        .then((content) => parseOwnedTextHeader(content))
        .catch(() => null);
      if (parsed
        && parsed.identity.sourceId === target.sourceId
        && parsed.identity.pluginId === target.pluginId
        && parsed.identity.platform === target.platform
        && parsed.identity.scope === target.scope) {
        components.push({
          kind: 'owned-text-file',
          path: reference.location,
          allowedRoot: path.dirname(reference.location),
          identity: parsed.identity,
        });
      }
    }
    if (components.length === 0) continue;
    const plugin = createSyntheticPlugin(target.pluginName, options.env);
    plugin.sourceId = target.sourceId;
    plugin.sourceIdentity = target.sourceIdentity;
    plugin.pluginId = target.pluginId;
    plugin.marketplaceName = target.marketplaceName;
    targets.push({
      plugin,
      identity: {
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        pluginId: target.pluginId,
        pluginName: target.pluginName,
        pluginVersion: plugin.manifest.version,
        platform: target.platform,
        scope: target.scope,
        cwd: options.cwd,
      },
      ownedComponents: components,
      desiredOwnedComponents: components,
      optionalOwnedComponents: [],
      requiresNative: false,
      writeNativeRequired: false,
      artifacts: [],
      operationActions: [],
      preApplySource: plugin,
      forceExclusiveCleanup: true,
    });
    evidence.push(await forceOfflineCleanupEvidence({
      reason: 'bundleUnavailable',
      pluginId: target.pluginId,
      pluginName: target.pluginName,
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      platform: target.platform,
      scope: target.scope,
      components,
    }));
  }
  return { targets, evidence };
}

async function mergeForceCleanupPlans(
  ...plans: Array<{ targets: DesiredTarget[]; evidence: OfflineCleanupTargetEvidence[] }>
): Promise<{ targets: DesiredTarget[]; evidence: OfflineCleanupTargetEvidence[] }> {
  const targets = new Map<string, DesiredTarget>();
  for (const target of plans.flatMap((plan) => plan.targets)) {
    const key = `${target.identity.pluginId}\0${target.identity.platform}\0${target.identity.scope}`;
    const previous = targets.get(key);
    if (!previous) {
      targets.set(key, target);
      continue;
    }
    const components = [...previous.ownedComponents];
    for (const component of target.ownedComponents) {
      if ('path' in component && !components.some((candidate) =>
        'path' in candidate && path.resolve(candidate.path) === path.resolve(component.path))) {
        components.push(component);
      }
    }
    previous.ownedComponents = components;
    previous.desiredOwnedComponents = components;
  }
  const mergedTargets = [...targets.values()];
  return {
    targets: mergedTargets,
    evidence: await Promise.all(mergedTargets.map((target) => forceOfflineCleanupEvidence({
      reason: 'bundleUnavailable',
      pluginId: target.identity.pluginId!,
      pluginName: target.identity.pluginName,
      sourceId: target.identity.sourceId!,
      sourceIdentity: target.identity.sourceIdentity!,
      platform: target.identity.platform,
      scope: target.identity.scope,
      components: target.ownedComponents as ReadonlyArray<Extract<OwnedComponent, { path: string }>>,
    }))),
  };
}

async function runRebuildCommandInSession(options: {
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
  let malformedSelectedConfigPreserved = false;
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
    if (expectedOfflineCleanup && expectedOfflineCleanup.forceExclusive !== true) {
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
    if (cleanupLiveTargets.length > 0) {
      const filtered = omitSelectedPluginConfigErrors(cleanupInventory, cleanupLiveTargets);
      cleanupInventory = filtered.inventory;
      malformedSelectedConfigPreserved ||= filtered.omitted;
    }
  }
  if (options.all) {
    const inventory = await readOrdinaryInventory();
    if (options.command !== 'cleanup') {
      assertRebuildCatalogSourceInventoryComplete(inventory, options.commandOptions.scope);
    }
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
  if (options.command === 'cleanup' && !options.all) {
    if (cleanupForce) {
      const requestedPlatforms = selectedPlatforms(options.commandOptions.platform);
      const cleanupSourceSnapshot = await readCatalogSourcesConfigSnapshot(runtimeEnv).catch(() => undefined);
      const primarySource = cleanupSourceSnapshot?.config.sources.find((source) => source.primary)?.id;
      const livePlan = await buildLiveForceExclusiveCleanupPlan({
        targets: cleanupLiveTargets,
        inventory: cleanupInventory!,
        env: runtimeEnv,
        cwd: options.commandOptions.cwd,
      });
      const selectorsNeedingSupplement = requestedPluginNames.filter((selector) => {
        const parsed = parsePluginId(selector);
        const sourceId = parsed.sourceId ?? primarySource;
        if (!sourceId) return true;
        const missingLiveTarget = requestedPlatforms.some((platform) => !livePlan.targets.some((target) =>
          target.identity.pluginId === formatPluginId({ sourceId, pluginName: parsed.pluginName })
          && target.identity.platform === platform
          && target.identity.scope === options.commandOptions.scope));
        const damagedExclusiveEvidence = cleanupInventory!.errors.some((error) =>
          (error.kind === 'ownerMarkerRead'
            || error.kind === 'ownerMarkerValidation'
            || error.kind === 'ownerHeaderRead'
            || error.kind === 'ownerHeaderParse'
            || error.kind === 'ownerHeaderPathValidation')
          && !error.relevance.global
          && (error.relevance.sourceId === undefined || error.relevance.sourceId === sourceId)
          && (error.relevance.pluginName === undefined || error.relevance.pluginName === parsed.pluginName)
          && (error.relevance.platform === undefined || requestedPlatforms.includes(error.relevance.platform))
          && (error.relevance.scope === undefined || error.relevance.scope === options.commandOptions.scope));
        return missingLiveTarget || damagedExclusiveEvidence;
      });
      const supplement = selectorsNeedingSupplement.length > 0
        ? await buildForceExclusiveCleanupPlan({
            selectors: selectorsNeedingSupplement,
            platforms: requestedPlatforms,
            scope: options.commandOptions.scope,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            primarySourceId: primarySource,
            damagedOnly: cleanupLiveTargets.length > 0,
          })
        : { targets: [], evidence: [] };
      const forcePlan = await mergeForceCleanupPlans(livePlan, supplement);
      const requestedTargets = requestedPluginNames.flatMap((selector) => {
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
      const unresolvedTargets = requestedTargets.filter((requested) => !forcePlan.targets.some((target) =>
        target.identity.pluginId === requested.pluginId
        && target.identity.platform === requested.platform
        && target.identity.scope === requested.scope));
      if (expectedOfflineCleanup?.forceExclusive === true) {
        const actual = forcePlan.evidence.find((candidate) =>
          candidate.pluginId === expectedOfflineCleanup.pluginId
          && candidate.platform === expectedOfflineCleanup.platform
          && candidate.scope === expectedOfflineCleanup.scope);
        if (!actual || !offlineCleanupEvidenceMatches(expectedOfflineCleanup, actual)) {
          throw namespacedPreflightError(
            'operationReviewStale: force cleanup path or ownership evidence changed before mutation.',
            cleanupLiveTargets,
          );
        }
      }
      if (unresolvedTargets.length > 0) {
        throw namespacedPreflightError(
          'forceCleanupPathUnavailable: No exact exclusive output is available from live evidence or the local Active shallow plan. Restore the local Active bundle, then retry cleanup --force, or inspect and remove the exact output manually.',
          unresolvedTargets,
        );
      }
      if (forcePlan.targets.length === 0) {
        throw namespacedPreflightError(
          'forceCleanupPathUnavailable: No exact exclusive output is available from live evidence or the local Active shallow plan. Restore the local Active bundle, then retry cleanup --force, or inspect and remove the exact output manually.',
          requestedTargets,
        );
      }
      const operationPlan = createOfflineCleanupOperationPlan(forcePlan.evidence);
      if (options.runtime?.expectedPlanFingerprint) {
        assertOperationPlanFingerprint(options.runtime.expectedPlanFingerprint, operationPlan);
      }
      if (options.runtime?.previewOperationPlan) {
        return {
          ...await previewOfflineOwnedComponents({
            targets: cleanupLiveTargets,
            evidence: forcePlan.evidence,
            cwd: options.commandOptions.cwd,
            env: runtimeEnv,
            onPreviewStage: options.runtime.onPreviewStage,
          }),
          operationPlan,
        };
      }
      const forceResults = await Promise.all(forcePlan.targets.map(async (target) => {
        const integration = createRebuildIntegration({
          context: {
            env: runtimeEnv,
            nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
            reporter: options.runtime?.reporter ?? createNoopReporter(),
            debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
          },
        });
        const { finalizeCleanup: _finalizeCleanup, ...pathOnlyDriver } = integration.driver;
        const result = await executeRebuildOperation({ command: 'cleanup', target, driver: pathOnlyDriver });
        if (cleanupLiveTargets.some((liveTarget) =>
          liveTarget.marketplaceIdentityUnresolved
          && liveTarget.pluginId === result.target.pluginId
          && liveTarget.platform === result.target.platform
          && liveTarget.scope === result.target.scope)) {
          result.residual.push('nativeMarketplaceIdentityUnresolved');
        }
        return result;
      }));
      const warnings = cleanupLiveTargets.flatMap((target) =>
        target.marketplaceIdentityUnresolved
          ? [`nativeMarketplaceIdentityUnresolved: Preserved ambiguous native registration for ${target.pluginId} on ${target.platform}/${target.scope}.`]
          : []);
      return leaseSafeRebuildResult({
        platforms: [...new Set(forceResults.map((entry) => entry.target.platform))],
        plugins: forceResults.filter((entry) => entry.status === 'succeeded')
          .map((entry) => entry.target.pluginName),
        warnings,
        rebuildResults: forceResults,
        targetResults: forceResults.map(toTargetResult),
        overallState: forceResults.every((entry) => entry.status === 'succeeded')
          ? 'succeeded'
          : forceResults.some((entry) => entry.status === 'succeeded') ? 'partial' : 'failed',
        receiptTargets: forceResults.map((entry) => entry.target),
        offlineCleanupPlans: forcePlan.evidence,
        operationPlan,
      });
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
      const qualifiedTargets = requestedPluginNames.flatMap((selector) => {
        const parsed = parsePluginId(selector);
        return parsed.sourceId ? [{ sourceId: parsed.sourceId, pluginName: parsed.pluginName }] : [];
      });
      const filtered = cleanupInventory && qualifiedTargets.length > 0
        ? omitSelectedPluginConfigErrors(cleanupInventory, qualifiedTargets)
        : { inventory: cleanupInventory, omitted: false };
      malformedSelectedConfigPreserved ||= filtered.omitted;
      const inventoryError = filtered.inventory?.errors.find((error) => {
        if (!cleanupForce
          || (error.kind !== 'ownerMarkerRead' && error.kind !== 'ownerMarkerValidation')
          || error.relevance.global) return true;
        const relevant = unresolvedTargets.some((target) =>
          !error.relevance.global
          && (error.relevance.sourceId === undefined || error.relevance.sourceId === target.sourceId)
          && (error.relevance.pluginName === undefined || error.relevance.pluginName === target.pluginName)
          && (error.relevance.platform === undefined || error.relevance.platform === target.platform)
          && (error.relevance.scope === undefined || error.relevance.scope === target.scope));
        return relevant
          && !(error.relevance.platform === 'codex' && error.relevance.scope === 'project');
      });
      if (inventoryError) {
        throw namespacedPreflightError(
          `stateInventoryFailed: ${inventoryError.message}`,
          unresolvedTargets,
        );
      }
      const result = mergeRebuildCommandResults([]);
      if (malformedSelectedConfigPreserved) {
        result.warnings.push(MALFORMED_CONFIG_PRESERVED_WARNING);
      }
      if (cleanupForce && !options.runtime?.previewOperationPlan) {
        try {
          await (options.runtime?.removeObsoleteInstallationContracts ?? fs.remove)(
            path.join(resolveAwHome(runtimeEnv), 'installation-contracts'),
          );
        } catch {
          result.warnings.push(OBSOLETE_CONTRACTS_CLEANUP_WARNING);
        }
      }
      return result;
    }
    const cleanupSourceSnapshot = await readCatalogSourcesConfigSnapshot(runtimeEnv).catch(() => undefined);
    const configuredSources = new Set(cleanupSourceSnapshot?.config.sources.map((source) => source.id) ?? []);
    let evidence = expectedOfflineCleanup
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
    if (malformedSelectedConfigPreserved) {
      cleanupResult.warnings.push(MALFORMED_CONFIG_PRESERVED_WARNING);
    }
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
      if (options.command === 'uninstall' || (options.command === 'cleanup' && options.all)) {
        await measureCommandPerformanceStage(options.runtime, 'catalog.validation', async () => {
          const selectedSources = new Map(selectedEntries.map((candidate) => [
            candidate.source.sourceId,
            candidate.source,
          ]));
          for (const source of selectedSources.values()) {
            await validateCatalogSnapshotComplete(source.rootDir);
          }
        });
      }
      const intentCatalogEntries: IntentCatalogDependencyEntry[] = availableEntries.map((candidate) => ({
        pluginId: candidate.pluginId,
        dependencyPluginIds: candidate.entry.dependencies.map((dependency) => formatPluginId({
          sourceId: candidate.source.sourceId,
          pluginName: dependency,
        })),
      }));
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
        plugin.catalogLogicalIdentity = candidate.source.logicalIdentity;
        plugin.pluginId = candidate.pluginId;
        return { source: candidate.source, plugin, pluginId: candidate.pluginId };
      }));
      const selected = selectedEntries.map((entry) => available.find((candidate) =>
        candidate.pluginId === entry.pluginId)!);
      const selectedIds = new Set(selected.map((entry) => entry.pluginId));
      const preserveOtherCodexScopeRootIds = new Set(selected.flatMap((entry) =>
        analyzeCodexSurface(entry.plugin.manifest).scopeOverlap === 'native-compatible'
          ? [entry.pluginId]
          : []));
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
      const assertWriteInventoryComplete = (
        inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
        exactOwnedTextErrorLocations?: ReadonlySet<string>,
        exactSkillMarkerErrorLocations?: ReadonlySet<string>,
      ): void => {
        if (options.command === 'cleanup') return;
        const isExpectedOwnedTextHeaderError = (
          error: (typeof inventory.errors)[number],
        ): boolean => {
          if (error.kind !== 'ownerHeaderParse'
            && error.kind !== 'ownerHeaderPathValidation') return false;
          if (exactOwnedTextErrorLocations === undefined) return true;
          const relevance = error.relevance;
          if (relevance.global || relevance.platform === undefined || relevance.scope === undefined) {
            return false;
          }
          return [...exactOwnedTextErrorLocations].some((target) => {
            const [sourceId, pluginName, platform, scope, location] = target.split('\0');
            return (relevance.sourceId === undefined || relevance.sourceId === sourceId)
              && (relevance.pluginName === undefined || relevance.pluginName === pluginName)
              && relevance.platform === platform
              && relevance.scope === scope
              && error.location.replaceAll('\\', '/') === location;
          });
        };
        const isExpectedSkillMarkerError = (
          error: (typeof inventory.errors)[number],
        ): boolean => {
          if (error.kind !== 'ownerMarkerRead'
            && error.kind !== 'ownerMarkerValidation') return false;
          if (exactSkillMarkerErrorLocations === undefined) return true;
          const relevance = error.relevance;
          if (relevance.global || relevance.platform === undefined || relevance.scope === undefined) {
            return false;
          }
          return exactSkillMarkerErrorLocations.has([
            relevance.platform,
            relevance.scope,
            error.location.replaceAll('\\', '/'),
          ].join('\0'));
        };
        assertRebuildCatalogSourceInventoryComplete(options.command === 'reinstall'
          ? {
              ...inventory,
              errors: inventory.errors.filter((error) =>
                !isExpectedSkillMarkerError(error)
                && !isExpectedOwnedTextHeaderError(error)),
            }
          : inventory, options.commandOptions.scope);
      };
      const checked = options.command === 'uninstall'
        ? omitSelectedPluginConfigErrors(stateInventory, preflightTargets)
        : { inventory: stateInventory, omitted: false };
      malformedSelectedConfigPreserved ||= checked.omitted;
      if (checked.omitted) stateInventory.errors = checked.inventory.errors;
      assertWriteInventoryComplete(checked.inventory);
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
      const codexObservationScopeByMarketplace = new Map<string, 'user' | 'both'>();
      const projectIntentPluginIds = new Set<string>();
      for (const root of intentBeforeByScope.project.roots.filter((candidate) =>
        candidate.platforms.includes('codex'))) {
        const rootEntry = availableEntries.find((candidate) => candidate.pluginId === root.pluginId);
        if (!rootEntry) continue;
        for (const candidate of entryClosure([rootEntry])) {
          projectIntentPluginIds.add(candidate.pluginId);
        }
      }
      const projectCodexConfig = await readCodexConfigFile(
        resolveCodexPaths(options.commandOptions.cwd, 'project', runtimeEnv).configTomlPath,
      );
      for (const { entry, platform } of executionSelections) {
        if (platform !== 'codex') continue;
        const marketplaceName = marketplaceNameFor(
          entry,
          platform,
          options.commandOptions.scope,
        );
        const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceName}`;
        const requiredScope = options.commandOptions.scope === 'project'
          || projectIntentPluginIds.has(entry.pluginId)
          || Object.hasOwn(projectCodexConfig.snapshot.plugins, codexPluginId)
          ? 'both'
          : 'user';
        if (requiredScope === 'both'
          || !codexObservationScopeByMarketplace.has(marketplaceName)) {
          codexObservationScopeByMarketplace.set(marketplaceName, requiredScope);
        }
      }
      const executionContext: RebuildExecutionContext = {
        env: runtimeEnv,
        nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
        reporter: options.runtime?.reporter ?? createNoopReporter(),
        debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
        expectedCatalogConfigDigest: catalog.configDigest,
        codexObservationSession: options.runtime?.codexObservationSession,
        codexObservationScopeByMarketplace,
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
      const intentPlanForPreparedRoots = (
        plan: ReconcileOperationPlan,
        preparedKeys: ReadonlySet<string>,
      ): {
        plan: ReconcileOperationPlan;
        selectedRoots: Array<{ pluginId: string; platforms: PlatformName[] }>;
      } => {
        const retainedRootKeys = new Set(plan.targets.flatMap((target) =>
          target.relation === 'requested'
          && preparedKeys.has(`${target.pluginId}\0${target.platform}`)
            ? [`${target.pluginId}\0${target.platform}`]
            : []));
        const closureKeys = new Set(retainedRootKeys);
        const pending = [...closureKeys];
        while (pending.length > 0) {
          const consumerKey = pending.pop()!;
          for (const edge of plan.dependencyEdges) {
            if (`${edge.from}\0${edge.platform}` !== consumerKey) continue;
            const dependencyKey = `${edge.to}\0${edge.platform}`;
            if (closureKeys.has(dependencyKey)) continue;
            closureKeys.add(dependencyKey);
            pending.push(dependencyKey);
          }
        }
        return {
          plan: {
            ...plan,
            requestedPluginIds: plan.requestedPluginIds.filter((pluginId) =>
              plan.targets.some((target) => target.pluginId === pluginId
                && retainedRootKeys.has(`${target.pluginId}\0${target.platform}`))),
            resolvedPluginIds: plan.resolvedPluginIds.filter((pluginId) =>
              plan.targets.some((target) => target.pluginId === pluginId
                && closureKeys.has(`${target.pluginId}\0${target.platform}`))),
            dependencyEdges: plan.dependencyEdges.filter((edge) =>
              closureKeys.has(`${edge.from}\0${edge.platform}`)
              && closureKeys.has(`${edge.to}\0${edge.platform}`)),
            scopeOverrides: plan.scopeOverrides.filter((override) =>
              closureKeys.has(`${override.pluginId}\0${override.platform}`)),
            targets: plan.targets.filter((target) =>
              closureKeys.has(`${target.pluginId}\0${target.platform}`)),
          },
          selectedRoots: selectedRootsForPlan(plan).flatMap((root) => {
            const platforms = root.platforms.filter((platform) =>
              retainedRootKeys.has(`${root.pluginId}\0${platform}`));
            return platforms.length > 0 ? [{ ...root, platforms }] : [];
          }),
        };
      };
      let plannedCodexRegistrations = new Map<
        string,
        CodexPluginRegistrationLiveInspection
      >();
      let plannedOwnedTextTargets = new Map<string, Set<string>>();
      let plannedSkillMarkerTargets = new Map<string, Set<string>>();
      const exactOwnedTextTargets = (plan: ReconcileOperationPlan): Set<string> => {
        const output = new Set<string>();
        for (const target of plan.targets) {
          for (const location of plannedOwnedTextTargets.get([
            target.pluginId, target.platform, target.resolvedScope,
          ].join('\0')) ?? []) {
            output.add([
              target.pluginId.split('/', 1)[0],
              target.pluginName,
              target.platform,
              target.resolvedScope,
              location,
            ].join('\0'));
          }
        }
        return output;
      };
      const exactSkillMarkerTargets = (plan: ReconcileOperationPlan): Set<string> => {
        const output = new Set<string>();
        for (const target of plan.targets) {
          for (const location of plannedSkillMarkerTargets.get([
            target.pluginId, target.platform, target.resolvedScope,
          ].join('\0')) ?? []) {
            output.add([target.platform, target.resolvedScope, location].join('\0'));
          }
        }
        return output;
      };
      const createPlan = async (
        inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
        codexManager?: CodexManager,
      ): Promise<ReconcileOperationPlan> => {
        plannedCodexRegistrations = new Map();
        plannedOwnedTextTargets = new Map();
        plannedSkillMarkerTargets = new Map();
        assertWriteInventoryComplete(inventory);
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
        const loadPlacementCodexConfigs = async () => {
          const [user, project] = await Promise.all((['user', 'project'] as const).map((scope) =>
            readCodexConfigFile(resolveCodexPaths(
              options.commandOptions.cwd,
              scope,
              runtimeEnv,
            ).configTomlPath)));
          return { user, project };
        };
        let placementCodexConfigs: ReturnType<typeof loadPlacementCodexConfigs> | undefined;
        const readPlacementCodexConfigs = () => {
          placementCodexConfigs ??= loadPlacementCodexConfigs();
          return placementCodexConfigs;
        };
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
            const targetKey = [entry.pluginId, platform, scope].join('\0');
            const ownedTextTargets = plannedOwnedTextTargets.get(targetKey) ?? new Set<string>();
            const skillMarkerTargets = plannedSkillMarkerTargets.get(targetKey) ?? new Set<string>();
            const rawRepoRoot = resolveRepoRootSync(options.commandOptions.cwd);
            const sensitiveRoots = [
              canonicalizePathThroughExistingAncestorSync(getCodexHome(runtimeEnv)),
              canonicalizePathThroughExistingAncestorSync(getClaudeHome(runtimeEnv)),
              canonicalizePathThroughExistingAncestorSync(rawRepoRoot),
              getCodexHome(runtimeEnv),
              getClaudeHome(runtimeEnv),
              rawRepoRoot,
            ];
            for (const component of desired.ownedComponents) {
              if (component.kind === 'owned-text-file') {
                ownedTextTargets.add(sanitizeCatalogSourceErrorMessage(
                  component.path,
                  runtimeEnv,
                  sensitiveRoots,
                ).replaceAll('\\', '/'));
              } else if (component.kind === 'skill-directory') {
                skillMarkerTargets.add(sanitizeCatalogSourceErrorMessage(
                  path.join(component.path, SKILL_OWNER_MARKER),
                  runtimeEnv,
                  sensitiveRoots,
                ).replaceAll('\\', '/'));
              }
            }
            plannedOwnedTextTargets.set(targetKey, ownedTextTargets);
            plannedSkillMarkerTargets.set(targetKey, skillMarkerTargets);
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
                scope: codexObservationScopeByMarketplace.get(
                  marketplaceNameFor(entry, platform, resolvedScope),
                ) ?? 'both',
                observationSession: executionContext.codexObservationSession,
                ...(codexManager ? { manager: codexManager } : {}),
              })
            : undefined;
          if (codexRegistration) {
            plannedCodexRegistrations.set(codexPluginId, codexRegistration);
          }
          const placementActivationConfigs = codexRegistration
            ? await readPlacementCodexConfigs()
            : undefined;
          const placementState = (
            inspected: typeof requestedInspection,
            scope: Scope,
          ): typeof inspected.state => {
            if (platform !== 'codex'
              || surface?.classification !== 'native'
              || options.command === 'cleanup'
              || options.command === 'uninstall') return inspected.state;
            if (!codexRegistration) return inspected.state;
            if (codexRegistration.observation.state === 'failed') return 'error';
            if (codexRegistration.observation.state === 'unobserved') return 'partial';
            if (codexRegistration.observation.value === 'absent') return 'absent';
            const configEnabled = placementActivationConfigs!.user
              .snapshot.plugins[codexPluginId]?.enabled === true
              || (scope === 'project'
                && placementActivationConfigs!.project
                  .snapshot.plugins[codexPluginId]?.enabled === true);
            return configEnabled
              ? inspected.state
              : 'partial';
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
          const hasWiderDesiredRoot = relation === 'dependency'
            && options.commandOptions.scope === 'project'
            && intentBeforeByScope.user.roots.some((root) =>
              root.pluginId === entry.pluginId && root.platforms.includes(platform));
          placementNodes.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            platform,
            relation,
            depth: order,
            allowedScopes,
            ...(relation === 'dependency'
              && options.commandOptions.scope === 'project'
              && (otherPlacementState === 'present' || hasWiderDesiredRoot)
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
          if (dependencyEnabled
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
          if (relation === 'dependency'
            && requestedPlacementState === 'present'
            && otherPlacementState === 'present') {
            action = 'block';
            state = 'partial';
            errorCode = 'dependencyScopeConflict';
          } else if (relation === 'dependency'
            && options.commandOptions.scope === 'project'
            && otherInspection.state === 'present') {
            resolvedScope = 'user';
            state = 'present';
          } else if (relation === 'dependency'
            && options.commandOptions.scope === 'project'
            && (otherPlacementState === 'partial' || otherPlacementState === 'error')) {
            resolvedScope = 'user';
            state = otherPlacementState;
            if (otherPlacementState === 'error') {
              action = 'block';
              errorCode = 'dependencyNotReady';
            }
          } else if (relation === 'dependency'
            && options.commandOptions.scope === 'user'
            && otherPlacementState === 'error') {
            action = 'block';
            errorCode = 'dependencyNotReady';
          }
          const resolvedInspection = resolvedScope === options.commandOptions.scope
            ? requestedInspection
            : otherInspection;
          const collisionComponents = relation === 'dependency'
            ? resolvedInspection.components
            : [...requestedInspection.components, ...otherInspection.components];
          const invalidOwnerComponents = relation === 'dependency'
            ? resolvedInspection.components
            : requestedInspection.components;
          const hasForeignCollision = collisionComponents
            .some((component) => component.collision !== undefined);
          const hasInvalidExclusiveOwner = options.command === 'reinstall'
            && invalidOwnerComponents.some((component) =>
              (component.component.kind === 'skill-directory'
                || component.component.kind === 'owned-text-file')
              && component.collision?.reason === 'unownedContent');
          state = resolvedScope === options.commandOptions.scope
            ? requestedPlacementState
            : otherPlacementState;
          if (dependencyEnabled && hasForeignCollision) {
            action = 'block';
            errorCode = hasInvalidExclusiveOwner
              ? 'exclusiveOwnerEvidenceInvalid'
              : 'artifactCollision';
          }
          if (!hasForeignCollision && !errorCode && relation === 'dependency') {
            action = state === 'present' ? 'keep' : state === 'partial' ? 'reinstall' : 'install';
          }
          if (!hasForeignCollision && relation === 'dependency'
            && resolvedInspection.state === 'error') {
            action = 'block';
            state = resolvedInspection.state;
            errorCode ??= 'dependencyNotReady';
          }
          if (entry.plugin.manifest.config?.fields
            && (action === 'install' || action === 'reinstall')) {
            const effective = resolvedScope === 'project'
              ? await resolveArtifactRenderConfig({
                  sourceId: entry.source.sourceId,
                  sourceIdentity: entry.source.sourceIdentity,
                  logicalIdentity: entry.source.logicalIdentity,
                  pluginName: entry.plugin.manifest.name,
                  manifest: entry.plugin.manifest,
                  scope: 'project',
                  cwd: options.commandOptions.cwd,
                  env: runtimeEnv,
                })
              : await resolveEffectivePluginConfig({
                  sourceId: entry.source.sourceId,
                  sourceIdentity: entry.source.sourceIdentity,
                  logicalIdentity: entry.source.logicalIdentity,
                  pluginName: entry.plugin.manifest.name,
                  manifest: entry.plugin.manifest,
                  targetScope: 'user',
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
              const otherScope: Scope = target.resolvedScope === 'user' ? 'project' : 'user';
              const otherState = actualStates.get(
                `${target.pluginId}\0${target.platform}\0${otherScope}`,
              );
              const movesExistingPlacement = target.relation === 'dependency'
                && target.resolvedScope === 'user'
                && (state === 'absent' || state === 'partial')
                && (otherState === 'present' || otherState === 'partial');
              const preservesWiderPlacement = target.relation === 'dependency'
                && target.resolvedScope === 'project'
                && (state === 'absent' || state === 'partial')
                && (otherState === 'present' || otherState === 'partial');
              const action = errorCode
                ? 'block' as const
                : options.command === 'cleanup' || options.command === 'uninstall'
                  ? 'keep' as const
                  : movesExistingPlacement
                    ? 'move' as const
                    : target.relation === 'dependency' && state === 'present'
                      ? 'keep' as const
                      : state === 'partial' || options.command === 'reinstall'
                        ? 'reinstall' as const
                        : 'install' as const;
              return {
                ...prior,
                state,
                action,
                ...(errorCode ? { errorCode } : {}),
                ...(preservesWiderPlacement ? { preservedScope: 'user' as const } : {}),
              };
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
          catalogEntries: intentCatalogEntries,
        });
        if (options.command === 'install') {
          afterByScope[otherScope] = removeSelectedRootPlatformsFromOtherScope({
            state: afterByScope[otherScope],
            selectedRoots,
            preserveCodexRootIds: preserveOtherCodexScopeRootIds,
          });
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
        const [userConfig, projectConfig] = await Promise.all([
          readCodexConfigFile(resolveCodexPaths(
            options.commandOptions.cwd,
            'user',
            runtimeEnv,
          ).configTomlPath),
          readCodexConfigFile(resolveCodexPaths(
            options.commandOptions.cwd,
            'project',
            runtimeEnv,
          ).configTomlPath),
        ]);
        const catalogClosure: CodexReconcilerCatalogTarget[] = [];
        const liveEvidence: CodexReconcilerLiveEvidence[] = [];
        const desiredScopesByPluginId = new Map<string, Scope[]>();
        const intentScopesByPluginId = new Map<string, Scope[]>();
        for (const planned of reconciledCodexTargets) {
          const entry = available.find((candidate) => candidate.pluginId === planned.pluginId)!;
          const marketplaceName = marketplaceNameFor(entry, 'codex', planned.resolvedScope);
          const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceName}`;
          const desiredScopes = desiredScopesForEntry(entry);
          const intentScopes = intentScopesForEntry(entry);
          desiredScopesByPluginId.set(entry.pluginId, desiredScopes);
          intentScopesByPluginId.set(entry.pluginId, intentScopes);
          if (planned.resolvedScope === 'project'
            || desiredScopes.includes('project')
            || intentScopes.includes('project')
            || Object.hasOwn(projectConfig.snapshot.plugins, codexPluginId)) {
            codexObservationScopeByMarketplace.set(marketplaceName, 'both');
          }
        }
        for (const planned of reconciledCodexTargets) {
          const entry = available.find((candidate) => candidate.pluginId === planned.pluginId)!;
          const surface = analyzeCodexSurface(entry.plugin.manifest);
          const marketplaceName = marketplaceNameFor(entry, 'codex', planned.resolvedScope);
          const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceName}`;
          const hasNativeRenderTargets = (entry.plugin.manifest.artifacts?.targets ?? []).some((target) =>
            target.platform === 'codex'
            && target.target === 'codex.skill'
            && target.delivery?.mode === 'codex-native');
          const staticContentDigest = hasNativeRenderTargets
            ? undefined
            : await calculateCodexSharedNativePayloadDigest(entry.plugin.rootDir);
          const desiredScopes = desiredScopesByPluginId.get(entry.pluginId)!;
          const intentScopes = intentScopesByPluginId.get(entry.pluginId)!;
          const observationScope = codexObservationScopeByMarketplace.get(marketplaceName)
            ?? 'user';
          const plannedRegistration = plannedCodexRegistrations.get(codexPluginId);
          const sharedInspection = surface.nativeKinds.length > 0
            ? await inspectCodexSharedNativeLive({
                pluginName: entry.plugin.manifest.name,
                sourceId: entry.source.sourceId,
                desiredVersion: entry.plugin.manifest.version,
                ...(staticContentDigest ? { expectedPayloadDigest: staticContentDigest } : {}),
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
                marketplaceName,
                marketplaceRoot: path.join(
                  resolveAwHome(runtimeEnv),
                  'marketplaces',
                  entry.source.sourceId,
                ),
                nativeCliRunner: executionContext.nativeCliRunner,
                observationScope,
                observationSession: executionContext.codexObservationSession,
                ...(codexManager ? { manager: codexManager } : {}),
                ...(plannedRegistration
                  && (observationScope === 'user' || plannedRegistration.observations.project)
                  ? { pluginRegistration: plannedRegistration }
                  : {}),
                ...(hasNativeRenderTargets ? { nativeRenderPlugin: entry.plugin } : {}),
              })
            : undefined;
          const contentDigest = sharedInspection?.expectedPayloadDigest
            ?? staticContentDigest
            ?? await calculateCodexNativeRenderPayloadDigest(entry.plugin.rootDir);
          catalogClosure.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            codexPluginId,
            version: entry.plugin.manifest.version,
            payloadDigest: contentDigest,
            relation: planned.relation,
            resolvedScope: planned.resolvedScope,
            desiredScopes,
            intentScopes,
            surface,
          });
          const sharedNative: CodexReconcilerLiveEvidence['sharedNative'] = sharedInspection?.sharedNative
            ?? { state: 'unobserved' };
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
            for (const component of surface.components.filter((candidate) => candidate.owner === 'aw')) {
              const artifactKeys = new Set<string>();
              if (component.key.startsWith('extensions.instructions:')) {
                artifactKeys.add('developer-instructions');
              } else if ((component.key.startsWith('extensions.permissions:')
                || component.key.startsWith('extensions.agents:')) && component.name) {
                artifactKeys.add(buildGeneratedName(entry.plugin.manifest.name, component.name));
              } else if (component.key.startsWith('artifacts.targets:')) {
                const targetId = component.key.slice('artifacts.targets:'.length);
                const target = entry.plugin.manifest.artifacts?.targets?.find((candidate) =>
                  candidate.id === targetId);
                const artifactKey = target?.target === 'codex.developerInstructionsBlock'
                  ? 'developer-instructions'
                  : target?.skillKey ?? target?.roleKey;
                if (artifactKey) artifactKeys.add(artifactKey);
              }
              const componentInspections = projected.filter((candidate) =>
                artifactKeys.has(candidate.component.identity.artifactKey)
                || (candidate.component.kind === 'shared-config'
                  && candidate.component.locator.kind === 'codex-role-registration'
                  && artifactKeys.has(candidate.component.locator.roleKey)));
              const projectionState = componentInspections.some((candidate) => candidate.collision)
                ? planned.action === 'block' ? 'absent' as const : 'foreign' as const
                : componentInspections.length > 0
                  && componentInspections.every((candidate) => candidate.state === 'present')
                  ? 'present' as const
                  : componentInspections.some((candidate) => candidate.state !== 'absent')
                    ? 'drifted' as const
                    : 'absent' as const;
              extensions.push({ componentKey: component.key, scope, state: projectionState });
            }
          }
          liveEvidence.push({
            codexPluginId,
            sharedNative,
            activations: {
              user: userConfig.snapshot.plugins[codexPluginId]?.enabled,
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
        const codexPlan = createCodexReconcilePlan({
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
        });
        const preservedScopes = new Map(plan.targets.flatMap((target) =>
          target.platform === 'codex' && target.preservedScope
            ? [[target.pluginId, target.preservedScope] as const]
            : []));
        if (preservedScopes.size === 0) return [codexPlan];
        const preservedNativePluginIds = new Set(catalogClosure.flatMap((target) =>
          (options.command === 'install' || options.command === 'reinstall')
          && preservedScopes.get(target.pluginId) === 'user'
          && liveEvidence.find((evidence) =>
            evidence.codexPluginId === target.codexPluginId)?.activations.user === true
            ? [target.pluginId]
            : []));
        const preservedCodexIds = new Set(codexPlan.sharedNativeActions.flatMap((action) =>
          preservedNativePluginIds.has(action.pluginId) ? [action.codexPluginId] : []));
        return [{
          ...codexPlan,
          desiredTargets: codexPlan.desiredTargets.map((target) => {
            const preservedScope = preservedNativePluginIds.has(target.pluginId)
              ? preservedScopes.get(target.pluginId)
              : undefined;
            return preservedScope
              ? { ...target, scopes: [...new Set([...target.scopes, preservedScope])].sort() }
              : target;
          }),
          activationActions: {
            user: codexPlan.activationActions.user.map((action) =>
              preservedNativePluginIds.has(action.pluginId)
                ? { ...action, action: 'none' as const, desired: true }
                : action),
            project: codexPlan.activationActions.project,
          },
          extensionRemovals: codexPlan.extensionRemovals.filter((action) =>
            preservedScopes.get(action.pluginId) !== action.scope),
          staleActivationRemovals: codexPlan.staleActivationRemovals.filter((action) =>
            !(action.scope === 'user' && preservedCodexIds.has(action.codexPluginId))),
          postcheck: {
            ...codexPlan.postcheck,
            plugins: codexPlan.postcheck.plugins.map((plugin) =>
              preservedNativePluginIds.has(plugin.pluginId)
                ? { ...plugin, expectedUserEnabled: true }
                : plugin),
          },
        }];
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
              ? planned!.action === 'move'
                ? planned!.state === 'partial' ? 'reinstall' : 'install'
                : planned!.action as 'install' | 'reinstall'
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
          operationScopedNativePhases: true,
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
              ? planned.state === 'partial' ? 'reinstall' : 'install'
              : planned.relation === 'dependency'
                && (planned.action === 'install' || planned.action === 'reinstall')
                ? planned.action
                : options.command;
          const plannedNative = platform === 'codex'
            ? codexPlans.flatMap((codexPlan) => codexPlan.sharedNativeActions).find((action) =>
                action.pluginId === entry.pluginId)
            : undefined;
          const codexNativeStillDesired = platform === 'codex'
            && codexPlans.some((codexPlan) => codexPlan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && target.scopes.length > 0));
          const preserveSharedNative = plannedNative?.action === 'reuse'
            || (plannedNative?.action === 'none' && codexNativeStillDesired);
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
                  && (buildCommand === 'cleanup'
                    || buildCommand === 'uninstall'
                    || preserveSharedNative),
              }),
            );
            if (plannedNative) {
              const writesSharedNative = plannedNative.action === 'install'
                || plannedNative.action === 'replace'
                || plannedNative.action === 'repair';
              const isActivationComponent = (component: OwnedComponent) =>
                component.kind === 'shared-config'
                && component.locator.kind === 'codex-activation';
              const activationArtifactKeys = new Set(target.ownedComponents
                .filter(isActivationComponent)
                .map((component) => component.identity.artifactKey));
              target.ownedComponents = target.ownedComponents.filter((component) =>
                !isActivationComponent(component));
              target.desiredOwnedComponents = target.desiredOwnedComponents?.filter((component) =>
                !isActivationComponent(component));
              target.optionalOwnedComponents = target.optionalOwnedComponents?.filter((component) =>
                !isActivationComponent(component));
              target.artifacts = target.artifacts.filter((artifact) =>
                artifact.artifactKey === undefined
                || !activationArtifactKeys.has(artifact.artifactKey));
              target.operationActions = target.operationActions?.filter((action) =>
                action.kind !== 'setActivation');
              target.writeNativeRequired = writesSharedNative;
              const hasExtensionMutation = codexPlans.some((codexPlan) => [
                ...codexPlan.extensionWrites,
                ...codexPlan.extensionRemovals,
              ].some((action) =>
                action.pluginId === entry.pluginId
                && action.scope === planned.resolvedScope));
              const hasActivationMutation = codexPlans.some((codexPlan) => [
                ...codexPlan.activationActions.user,
                ...codexPlan.activationActions.project,
              ].some((action) =>
                action.pluginId === entry.pluginId
                && action.action !== 'none'));
              target.codexNativeObservationExpectation = preserveSharedNative && hasExtensionMutation
                ? (plannedNative.action === 'reuse' ? 'installed' : 'observed')
                : undefined;
              const removesSharedNative = !writesSharedNative
                && !preserveSharedNative
                && (buildCommand === 'cleanup' || buildCommand === 'uninstall');
              target.codexNativeSensitivePreflightRequired = preserveSharedNative
                && hasActivationMutation;
              if (!writesSharedNative && !removesSharedNative) {
                const isSharedNativeComponent = (component: OwnedComponent) =>
                  component.kind === 'native-plugin'
                  || (component.kind === 'shared-config'
                    && component.identity.artifactKey.startsWith('marketplace-'));
                target.requiresNative = false;
                target.ownedComponents = target.ownedComponents.filter((component) =>
                  !isSharedNativeComponent(component));
                target.desiredOwnedComponents = target.desiredOwnedComponents?.filter((component) =>
                  !isSharedNativeComponent(component));
                target.optionalOwnedComponents = target.optionalOwnedComponents?.filter((component) =>
                  !isSharedNativeComponent(component));
                target.operationActions = target.operationActions?.filter((action) =>
                  action.kind !== 'ensureNativeRegistration');
              }
              if (target.codexNativeSensitivePreflightRequired && !hasExtensionMutation) {
                await integration.driver.preflightMutation?.(target);
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
            if (!entry.plugin.manifest.config?.fields
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
            logicalIdentity: entry.source.logicalIdentity,
            pluginName: entry.plugin.manifest.name,
            manifest: entry.plugin.manifest,
            targetScope: scope,
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
          integration,
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
        assertWriteInventoryComplete(
          stateInventory,
          exactOwnedTextTargets(initialPlan),
          exactSkillMarkerTargets(initialPlan),
        );
        const provisionalCodexPlans = await createCodexPlans(initialPlan);
        const previewNeedsNativeMaterialization = provisionalCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        const previewActivationOnly = !previewNeedsNativeMaterialization
          && provisionalCodexPlans.some((plan) =>
            plan.postcheck.support === 'observed'
            && plan.postcheck.plugins.length > 0);
        const previewActivationScope: Scope = provisionalCodexPlans.some((plan) =>
          plan.requirement.requiresProjectPluginContract) ? 'project' : 'user';
        const previewConsumer = previewActivationOnly
          ? await (
              options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
            )({
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              runner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
              operationRequirement: getCodexOperationRequirement(previewActivationScope),
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
          catalogEntries: intentCatalogEntries,
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
            logicalIdentity: entry.source.logicalIdentity,
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
        assertWriteInventoryComplete(
          stateInventory,
          exactOwnedTextTargets(lockedPlan),
          exactSkillMarkerTargets(lockedPlan),
        );
        const provisionalLockedCodexPlans = await createCodexPlans(lockedPlan);
        const codexManagerRequired = provisionalLockedCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        let lockedCodexPlans = provisionalLockedCodexPlans;
        let lockedPreparation = await prepareRenderedTargets(lockedPlan, lockedCodexPlans, true);
        let lockedOperationPlan = createRebuildOperationPlan({
          command: options.command,
          scope: options.commandOptions.scope,
          dependencyPlan: lockedPlan,
          codexPlans: lockedCodexPlans,
          targetActions: lockedPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          intentBeforeByScope,
          configDigests: lockedPreparation.configDigests,
          catalogEntries: intentCatalogEntries,
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
          const preApplyRequired = executionSelections.some(({ entry }) =>
            entry.plugin.manifest.scripts?.preApply !== undefined);
          if (preApplyRequired || sharedNativeImpact) {
            throw namespacedPreflightError(
              preApplyRequired
                ? 'preApplyAuthorizationRequired: Running plugin preApply requires --yes.'
                : 'sharedNativeImpactAuthorizationRequired: Replacing or force-reinstalling shared Codex native state requires --yes.',
              preflightTargets,
            );
          }
        }
        const operationPreparations = new Map<string, PreparedRebuildOperation>();
        const operationPreparationFailures = new Map<string, RebuildResult>();
        const lifecycleCommand = options.command === 'install'
          || options.command === 'sync'
          || options.command === 'reinstall';
        const executionCommandFor = (
          entry: (typeof executionSelections)[number]['entry'],
          platform: PlatformName,
        ): 'install' | 'sync' | 'reinstall' | 'cleanup' | 'uninstall' => {
          const planned = lockedPlan.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === platform)!;
          const desiredInCurrentScope = platform === 'codex'
            && lockedCodexPlans.some((codexPlan) => codexPlan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && target.scopes.includes(planned.resolvedScope)));
          if (platform === 'codex' && options.command === 'sync' && !desiredInCurrentScope) {
            return 'cleanup';
          }
          if (platform === 'codex' && options.command === 'cleanup' && desiredInCurrentScope) {
            return 'install';
          }
          if (planned.action === 'move') {
            return planned.state === 'partial' ? 'reinstall' : 'install';
          }
          if (planned.relation === 'dependency'
            && (planned.action === 'install' || planned.action === 'reinstall')) {
            return planned.action;
          }
          return options.command;
        };
        const prepareLockedTargets = async (preparationOptions: {
          eligibleKeys?: ReadonlySet<string>;
          skipPreApply?: boolean;
          deferManagedNativeInspection?: boolean;
        }): Promise<{
          preparations: Map<string, PreparedRebuildOperation>;
          failures: Map<string, RebuildResult>;
        }> => {
          const preparations = new Map<string, PreparedRebuildOperation>();
          const failures = new Map<string, RebuildResult>();
          const states = new Map<string, 'ready' | 'failed' | 'skipped'>();
          const integration = createRebuildIntegration({
            context: executionContext,
            scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
            preparedTargets: [...lockedPreparation.preparedTargets.values()].map((entry) =>
              entry.target),
          });
          for (const { entry, platform } of executionSelections) {
            const key = `${entry.pluginId}\0${platform}`;
            if (preparationOptions.eligibleKeys
              && !preparationOptions.eligibleKeys.has(key)) {
              states.set(key, 'skipped');
              continue;
            }
            const directDependencyFailed = (entry.plugin.manifest.dependencies ?? []).some(
              (pluginName) => {
                const dependencyPluginId = formatPluginId({
                  sourceId: entry.source.sourceId,
                  pluginName,
                });
                const state = states.get(`${dependencyPluginId}\0${platform}`);
                return state === 'failed' || state === 'skipped';
              },
            );
            const planned = lockedPlan.targets.find((target) =>
              target.pluginId === entry.pluginId && target.platform === platform)!;
            if (directDependencyFailed || planned.action === 'block') {
              states.set(key, 'skipped');
              continue;
            }
            const preparationError = lockedPreparation.preparedTargetErrors.get(key);
            const prepared = lockedPreparation.preparedTargets.get(key);
            if (preparationError || !prepared) {
              const message = preparationError instanceof Error
                ? preparationError.message
                : String(preparationError ?? 'Target preparation did not produce a target.');
              failures.set(key, failedResult(options.command, {
                sourceId: entry.source.sourceId,
                sourceIdentity: entry.source.sourceIdentity,
                pluginId: entry.pluginId,
                pluginName: entry.plugin.manifest.name,
                pluginVersion: entry.plugin.manifest.version,
                platform,
                scope: planned.resolvedScope,
                cwd: options.commandOptions.cwd,
              }, message));
              states.set(key, 'failed');
              continue;
            }
            const executionCommand = executionCommandFor(entry, platform);
            if (executionCommand === 'cleanup' || executionCommand === 'uninstall') {
              states.set(key, 'ready');
              continue;
            }
            const preparedOperation = await prepareRebuildOperation({
              command: executionCommand,
              target: prepared.target,
              driver: integration.driver,
              ...(preparationOptions.skipPreApply ? { skipPreApply: true } : {}),
              ...(preparationOptions.deferManagedNativeInspection
                && platform === 'codex'
                && executionContext.codexManager === undefined
                && (prepared.target.writeNativeRequired ?? prepared.target.requiresNative)
                ? { deferNativeInspection: true }
                : {}),
              onActionEvent: (event) => emitRebuildActionEvent(executionContext, event),
            });
            if (preparedOperation.status === 'failed') {
              failures.set(key, preparedOperation.result);
              states.set(key, 'failed');
              continue;
            }
            preparations.set(key, preparedOperation.preparation);
            states.set(key, 'ready');
          }
          return { preparations, failures };
        };
        if (lifecycleCommand) {
          const initialPreparation = await prepareLockedTargets({
            deferManagedNativeInspection: codexManagerRequired,
          });
          for (const [key, preparation] of initialPreparation.preparations) {
            operationPreparations.set(key, preparation);
          }
          for (const [key, failure] of initialPreparation.failures) {
            operationPreparationFailures.set(key, failure);
          }

          const nativePreparationKeys = new Set([...operationPreparations].flatMap(
            ([key, preparation]) => preparation.target.identity.platform === 'codex'
              && (preparation.target.writeNativeRequired ?? preparation.target.requiresNative)
              ? [key]
              : [],
          ));
          const activationPluginIds = new Set(provisionalLockedCodexPlans.flatMap((plan) =>
            plan.postcheck.plugins.map((plugin) => plugin.pluginId)));
          const activationPreparationKeys = new Set([...operationPreparations].flatMap(
            ([key, preparation]) => preparation.target.identity.platform === 'codex'
              && preparation.target.identity.pluginId
              && activationPluginIds.has(preparation.target.identity.pluginId)
              ? [key]
              : [],
          ));
          const codexRequirementScopeFor = (keys: ReadonlySet<string>): Scope => {
            const pluginIds = new Set([...keys].flatMap((key) => {
              const pluginId = operationPreparations.get(key)?.target.identity.pluginId;
              return pluginId ? [pluginId] : [];
            }));
            return provisionalLockedCodexPlans.some((plan) => plan.desiredTargets.some((target) =>
              pluginIds.has(target.pluginId) && target.scopes.includes('project')))
              ? 'project'
              : 'user';
          };
          let refreshManagedNativePlan = false;
          const failPreparedTargets = (keys: ReadonlySet<string>, error: unknown): void => {
            const message = error instanceof Error ? error.message : String(error);
            for (const key of keys) {
              const target = operationPreparations.get(key)?.target;
              if (!target) continue;
              operationPreparations.delete(key);
              operationPreparationFailures.set(
                key,
                failedResult(options.command, target.identity, message),
              );
            }
          };
          if (executionContext.codexManager === undefined
            && nativePreparationKeys.size > 0) {
            try {
              if (options.runtime?.codexManagerResolver) {
                executionContext.codexManager = await options.runtime.codexManagerResolver({
                  cwd: options.commandOptions.cwd,
                  env: runtimeEnv,
                  runner: executionContext.nativeCliRunner,
                  authorizer: options.runtime?.managedCodexAuthorizer,
                  operationRequirement: getCodexOperationRequirement(
                    codexRequirementScopeFor(nativePreparationKeys),
                  ),
                });
              } else {
                const consumer = await (
                  options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
                )({
                  cwd: options.commandOptions.cwd,
                  env: runtimeEnv,
                  runner: executionContext.nativeCliRunner,
                  authorizer: options.runtime?.managedCodexAuthorizer,
                  operationRequirement: getCodexOperationRequirement(
                    codexRequirementScopeFor(nativePreparationKeys),
                  ),
                  requiresNativeMaterialization: true,
                });
                if (consumer.support !== 'observed') {
                  throw new Error('Codex native materialization requires an observed CLI consumer.');
                }
                executionContext.codexManager = consumer.manager;
              }
              refreshManagedNativePlan = true;
            } catch (error) {
              failPreparedTargets(nativePreparationKeys, error);
            }
          } else if (executionContext.codexManager === undefined
            && activationPreparationKeys.size > 0) {
            try {
              const consumer = await (
                options.runtime?.codexOperationConsumerResolver ?? resolveCodexOperationConsumer
              )({
                cwd: options.commandOptions.cwd,
                env: runtimeEnv,
                runner: executionContext.nativeCliRunner,
                operationRequirement: getCodexOperationRequirement(
                  codexRequirementScopeFor(activationPreparationKeys),
                ),
                requiresNativeMaterialization: false,
              });
              if (consumer.support === 'observed') {
                executionContext.codexManager = consumer.manager;
              } else {
                lockedCodexPlans = lockedCodexPlans.map((plan) => ({
                  ...plan,
                  warnings: [...new Set([
                    ...plan.warnings,
                    'codexProjectActivationAssumed',
                  ])],
                  postcheck: { ...plan.postcheck, support: 'assumed' },
                }));
              }
            } catch (error) {
              failPreparedTargets(activationPreparationKeys, error);
            }
          }
          if (executionContext.codexManager) {
            executionContext.codexObservationSession?.setManager(executionContext.codexManager);
          }

          if (refreshManagedNativePlan) {
            if (executionContext.codexManager) {
              lockedPlan = await createPlan(stateInventory, executionContext.codexManager);
              assertWriteInventoryComplete(
                stateInventory,
                exactOwnedTextTargets(lockedPlan),
                exactSkillMarkerTargets(lockedPlan),
              );
            }
            lockedCodexPlans = await createCodexPlans(
              lockedPlan,
              'observed',
              executionContext.codexManager,
            );
            lockedPreparation = await prepareRenderedTargets(lockedPlan, lockedCodexPlans, false);
            const eligibleKeys = new Set(operationPreparations.keys());
            const initialOperationPreparations = new Map(operationPreparations);
            const finalPreparation = await prepareLockedTargets({
              eligibleKeys,
              skipPreApply: true,
            });
            operationPreparations.clear();
            for (const [key, preparation] of finalPreparation.preparations) {
              operationPreparations.set(key, {
                ...preparation,
                actions: [
                  ...(initialOperationPreparations.get(key)?.actions ?? []),
                  ...preparation.actions,
                ],
              });
            }
            for (const [key, failure] of finalPreparation.failures) {
              operationPreparationFailures.set(key, failure);
            }
          }
          const eligibleTargets = [...operationPreparations.keys()].flatMap((key) => {
            const prepared = lockedPreparation.preparedTargets.get(key);
            return prepared ? [prepared.target] : [];
          });
          lockedPreparation.integration.setNativeMarketplaceEligibleTargets(eligibleTargets);
        }
        lockedOperationPlan = createRebuildOperationPlan({
          command: options.command,
          scope: options.commandOptions.scope,
          dependencyPlan: lockedPlan,
          codexPlans: lockedCodexPlans,
          targetActions: lockedPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          intentBeforeByScope,
          configDigests: lockedPreparation.configDigests,
          catalogEntries: intentCatalogEntries,
        });
        if (options.runtime?.expectedPlanFingerprint) {
          assertOperationPlanFingerprint(
            options.runtime.expectedPlanFingerprint,
            lockedOperationPlan,
          );
        }
        if (options.runtime?.directCli
          && options.commandOptions.yes !== true
          && lifecycleCommand
          && lockedCodexPlans.some((plan) => plan.review.requiresConfirmation)) {
          throw namespacedPreflightError(
            'sharedNativeImpactAuthorizationRequired: Replacing or force-reinstalling shared Codex native state requires --yes.',
            preflightTargets,
          );
        }
        if (options.runtime?.awHomeMutationToken) {
          if (lifecycleCommand) {
            const preparedKeys = new Set(operationPreparations.keys());
            const intentSelection = intentPlanForPreparedRoots(lockedPlan, preparedKeys);
            const intentPlan = intentSelection.plan;
            const selectedRoots = intentSelection.selectedRoots;
            if (selectedRoots.length > 0) {
              await writeDesiredIntentSuperset({
                command: options.command,
                cwd: options.commandOptions.cwd,
                scope: options.commandOptions.scope,
                selectedRoots,
                plan: intentPlan,
                codexPlan: lockedCodexPlans[0],
                preserveOtherCodexScopeRootIds,
                catalogEntries: intentCatalogEntries,
                env: runtimeEnv,
              });
            }
          } else {
            const selectedRoots = selectedRootsForPlan(lockedPlan);
            await writeDesiredIntentSuperset({
              command: options.command,
              cwd: options.commandOptions.cwd,
              scope: options.commandOptions.scope,
              selectedRoots,
              plan: lockedPlan,
              codexPlan: lockedCodexPlans[0],
              preserveOtherCodexScopeRootIds,
              catalogEntries: intentCatalogEntries,
              env: runtimeEnv,
            });
          }
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
          if (options.command !== 'cleanup') {
            const checked = options.command === 'uninstall'
              ? omitSelectedPluginConfigErrors(removalStateInventory, preflightTargets)
              : { inventory: removalStateInventory, omitted: false };
            malformedSelectedConfigPreserved ||= checked.omitted;
            assertRebuildCatalogSourceInventoryComplete(
              checked.inventory,
              options.commandOptions.scope,
            );
          }
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
            : code === 'exclusiveOwnerEvidenceInvalid'
              ? `${entry.pluginId} has damaged or missing exclusive owner evidence. Run aw cleanup ${entry.pluginId} --platform ${platform} --scope ${planned.resolvedScope} --force, then run aw reinstall ${entry.pluginId} --platform ${platform} --scope ${planned.resolvedScope}.`
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
              ...(code === 'exclusiveOwnerEvidenceInvalid' ? {
                recoveryActions: [
                  `run aw cleanup ${entry.pluginId} --platform ${platform} --scope ${planned.resolvedScope} --force`,
                  `then run aw reinstall ${entry.pluginId} --platform ${platform} --scope ${planned.resolvedScope}`,
                ],
              } : {}),
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
        const operationPreparationFailure = operationPreparationFailures.get(
          `${entry.pluginId}\0${platform}`,
        );
        if (operationPreparationFailure) {
          const targetResult = toTargetResult(operationPreparationFailure);
          results.push({
            platforms: [platform],
            plugins: [],
            warnings: [],
            rebuildResults: [operationPreparationFailure],
            targetResults: [{ ...targetResult, action: planned.action }],
            overallState: 'failed',
            receiptTargets: [{
              pluginName: identity.pluginName,
              pluginId: identity.pluginId,
              sourceId: identity.sourceId,
              platform,
              scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(`${entry.pluginId}\0${platform}`, 'failed');
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
          const actions = operationPreparations.get(`${entry.pluginId}\0${platform}`)?.actions
            ?? [];
          const warnings: string[] = [];
          const preparedTarget = preparedTargets.get(`${entry.pluginId}\0${platform}`)?.target;
          if (preparedTarget) {
            const nativeSkillKeys = new Set((entry.plugin.manifest.artifacts?.targets ?? [])
              .filter((target) => target.platform === 'codex'
                && target.target === 'codex.skill'
                && target.delivery?.mode === 'codex-native')
              .map((target) => target.skillKey));
            const marketplaceRoot = preparedTarget.identity.marketplaceRoot;
            const legacyNativeSkills = preparedTarget.ownedComponents.filter((component) =>
              component.kind === 'skill-directory'
              && nativeSkillKeys.has(component.identity.artifactKey)
              && (!marketplaceRoot || path.relative(marketplaceRoot, component.path).startsWith('..')));
            if (legacyNativeSkills.length > 0) {
              const cleanup = await cleanupOwnedComponents({
                components: legacyNativeSkills,
                executor: lockedPreparation.integration.driver.ownership,
              });
              for (const failure of cleanup.failures) {
                warnings.push(failure.message);
              }
            }
          }
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity,
            actions,
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
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
          const actions = operationPreparations.get(`${entry.pluginId}\0${platform}`)?.actions
            ?? [];
          const result: RebuildResult = {
            status: 'succeeded', command: options.command, target: identity,
            actions,
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
        const marketplaceName = marketplaceNameFor(entry, platform, planned.resolvedScope);
        const namespacedSource = {
          sourceId: entry.source.sourceId,
          sourceIdentity: entry.source.sourceIdentity,
          logicalIdentity: entry.source.logicalIdentity,
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
              ? planned.state === 'partial' ? 'reinstall' : 'install'
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
                logicalIdentity: entry.source.logicalIdentity,
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
            operationPreparation: operationPreparations.get(`${entry.pluginId}\0${platform}`),
            integration: lockedPreparation.integration,
            preparationError: preparedTargetErrors.get(`${entry.pluginId}\0${platform}`),
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
      const failCompletedCodexTarget = (options_: {
        identity: RebuildTargetIdentity;
        message: string;
        phase?: RebuildFailure['phase'];
        action?: ReceiptTargetResult['action'];
        recoveryActions?: string[];
      }): boolean => {
        const resultIndex = results.findIndex((candidate) =>
          candidate.targetResults.some((target) =>
            target.target.pluginId === options_.identity.pluginId
            && target.target.platform === 'codex'
            && target.target.scope === options_.identity.scope));
        if (resultIndex === -1) return false;
        const existing = results[resultIndex]!;
        const phase = options_.phase ?? 'postcheck.inspect';
        const rebuildResults = existing.rebuildResults.map((rebuild): RebuildResult => {
          if (rebuild.target.pluginId !== options_.identity.pluginId
            || rebuild.target.platform !== 'codex'
            || rebuild.target.scope !== options_.identity.scope) return rebuild;
          if (!rebuild.failures.some((failure) =>
            failure.phase === phase && failure.message === options_.message)) {
            rebuild.failures.unshift({ phase, message: options_.message });
          }
          return {
            ...rebuild,
            status: 'failed',
            actions: rebuild.actions,
            error: { phase, message: options_.message },
          };
        });
        results[resultIndex] = {
          ...existing,
          plugins: existing.plugins.filter((pluginName) =>
            pluginName !== options_.identity.pluginName),
          rebuildResults,
          targetResults: existing.targetResults.map((target) =>
            target.target.pluginId === options_.identity.pluginId
            && target.target.platform === 'codex'
            && target.target.scope === options_.identity.scope
              ? {
                  ...target,
                  target: options_.identity,
                  action: options_.action ?? target.action,
                  state: 'failed' as const,
                  errorCode: options_.message.split(':', 1)[0] ?? 'codexActivationPostcheckFailed',
                  message: options_.message,
                  ...(options_.recoveryActions
                    ? { recoveryActions: options_.recoveryActions }
                    : {}),
                }
              : target),
          overallState: 'failed',
        };
        dependencyStates.set(`${options_.identity.pluginId}\0codex`, 'failed');
        return true;
      };
      const activationMutationPluginIds = new Set(lockedCodexPlans.flatMap((plan) => [
        ...plan.activationActions.user,
        ...plan.activationActions.project,
      ].flatMap((action) => action.action === 'none' ? [] : [action.pluginId])));
      for (const { entry, platform } of executionSelections) {
        if (platform !== 'codex'
          || !activationMutationPluginIds.has(entry.pluginId)
          || (dependencyStates.get(`${entry.pluginId}\0${platform}`) !== 'completed'
            && dependencyStates.get(`${entry.pluginId}\0${platform}`) !== 'kept')) continue;
        const prepared = preparedTargets.get(`${entry.pluginId}\0${platform}`)?.target;
        if (!prepared) continue;
        try {
          await lockedPreparation.integration.prepareNativeMarketplaceGroup(prepared);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failCompletedCodexTarget({ identity: prepared.identity, message, phase: 'native.write' });
        }
      }
      const successfulCodexPluginIds = new Set(executionSelections.flatMap(({ entry, platform }) =>
        platform === 'codex'
        && (dependencyStates.get(`${entry.pluginId}\0${platform}`) === 'completed'
          || dependencyStates.get(`${entry.pluginId}\0${platform}`) === 'kept')
          ? [entry.pluginId]
          : []));
      const activationPlans = selectCodexActivationPlans(
        lockedCodexPlans,
        successfulCodexPluginIds,
      );
      if (activationPlans.length > 0
        || lockedPreparation.integration.driver.completePostchecks) {
        let activationError: unknown;
        const activationMutationMarketplaces = new Set<string>();
        try {
          if (activationPlans.length > 0) {
            await executeCodexReconcileActivations({
              plans: activationPlans,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              manager: executionContext.codexManager,
              runner: executionContext.nativeCliRunner,
              observationSession: executionContext.codexObservationSession,
              preflightCompleted: true,
              mutationMarketplaces: activationMutationMarketplaces,
              observationScopeByMarketplace: codexObservationScopeByMarketplace,
            });
          }
        } catch (error) {
          activationError = error;
        }
        try {
          await lockedPreparation.integration.captureCodexPostMutationSnapshots(
            [...activationMutationMarketplaces],
          );
        } catch (error) {
          activationError ??= error;
        }
        const failedCodexPluginIds = new Set(executionSelections.flatMap(({ entry, platform }) =>
          platform === 'codex'
          && (dependencyStates.get(`${entry.pluginId}\0${platform}`) === 'failed'
            || dependencyStates.get(`${entry.pluginId}\0${platform}`) === 'skipped')
            ? [entry.pluginId]
            : []));
        for (const failure of await lockedPreparation.integration.driver.completePostchecks?.() ?? []) {
          const message = failure.error instanceof Error
            ? failure.error.message
            : String(failure.error);
          if (failCompletedCodexTarget({ identity: failure.target.identity, message })) {
            failedCodexPluginIds.add(failure.target.identity.pluginId ?? failure.target.identity.pluginName);
          }
        }
        if (!activationError && activationPlans.length > 0) {
          const postcheckPluginIds = new Set([...successfulCodexPluginIds]
            .filter((pluginId) => !failedCodexPluginIds.has(pluginId)));
          const postcheckPlans = selectCodexActivationPlans(
            activationPlans,
            postcheckPluginIds,
          );
          try {
            await postcheckCodexReconcileActivations({
              plans: postcheckPlans,
              cwd: options.commandOptions.cwd,
              env: runtimeEnv,
              manager: executionContext.codexManager,
              runner: executionContext.nativeCliRunner,
              observationScopeByMarketplace: codexObservationScopeByMarketplace,
              observationSession: executionContext.codexObservationSession,
            });
          } catch (error) {
            activationError = error;
          }
        }
        if (activationError) {
          const failedActivationPluginIds = failedCodexActivationPluginIds({
            error: activationError,
            plans: activationPlans,
            successfulPluginIds: successfulCodexPluginIds,
          });
          const message = activationError instanceof Error
            ? activationError.message
            : String(activationError);
          const failedSelections = executionSelections.filter((candidate) =>
            candidate.platform === 'codex'
            && failedActivationPluginIds.has(candidate.entry.pluginId));
          if (failedSelections.length === 0) throw activationError;
          for (const selection of failedSelections) {
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
            if (!failCompletedCodexTarget({ identity, message })) throw activationError;
            failedCodexPluginIds.add(selection.entry.pluginId);
          }
        }
        let propagated = true;
        while (propagated) {
          propagated = false;
          for (const selection of executionSelections.filter((candidate) =>
            candidate.platform === 'codex')) {
            if (failedCodexPluginIds.has(selection.entry.pluginId)) continue;
            const failedDependency = (selection.entry.plugin.manifest.dependencies ?? [])
              .map((pluginName) => formatPluginId({
                sourceId: selection.entry.source.sourceId,
                pluginName,
              }))
              .find((pluginId) => failedCodexPluginIds.has(pluginId));
            if (!failedDependency) continue;
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
            const message = `dependencyInstallFailed: ${selection.entry.pluginId} requires failed dependency ${failedDependency}.`;
            if (failCompletedCodexTarget({
              identity,
              message,
              recoveryActions: [
                `run aw sync --all --platform codex --scope ${planned.resolvedScope}`,
              ],
            })) {
              failedCodexPluginIds.add(selection.entry.pluginId);
              dependencyStates.set(`${selection.entry.pluginId}\0codex`, 'failed');
              propagated = true;
            }
          }
        }
      }
      for (const result of results) {
        result.targetResults = result.targetResults.map((target) => {
          if (target.state !== 'completed') return target;
          const planned = lockedPlan.targets.find((candidate) =>
            candidate.pluginId === target.target.pluginId
            && candidate.platform === target.target.platform
            && candidate.resolvedScope === target.target.scope);
          if (!planned?.preservedScope) return target;
          return {
            ...target,
            recoveryActions: [
              `run aw cleanup ${planned.pluginId} --platform ${planned.platform} --scope ${planned.preservedScope}`,
              `then run aw sync --all --platform ${planned.platform} --scope ${planned.resolvedScope}`,
            ],
          };
        });
      }
      if (options.command === 'install' || options.command === 'sync') {
        for (const { entry, platform } of executionSelections) {
          const planned = lockedPlan.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === platform)!;
          if (dependencyStates.get(`${entry.pluginId}\0${platform}`) !== 'completed') continue;
          const previousScope: Scope = planned.resolvedScope === 'user' ? 'project' : 'user';
          const removesPreviousScope = planned.resolvedScope === 'user'
            && (planned.action === 'move'
              || platform === 'codex' && lockedCodexPlans.some((plan) =>
                plan.extensionRemovals.some((action) =>
                  action.pluginId === entry.pluginId && action.scope === previousScope)));
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
                logicalIdentity: entry.source.logicalIdentity,
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
          results.push({
            ...migration,
            targetResults: migration.targetResults.map((target) => ({
              ...target,
              relation: planned.relation,
              requiredBy: planned.requiredBy,
            })),
          });
          if (migration.overallState !== 'succeeded') {
            dependencyStates.set(`${entry.pluginId}\0${platform}`, 'failed');
          }
        }
      }
      const merged = mergeRebuildCommandResults(results);
      if (malformedSelectedConfigPreserved) {
        merged.warnings.push(MALFORMED_CONFIG_PRESERVED_WARNING);
      }
      merged.dependencyPlan = lockedPlan;
      merged.overallState = reconcileOverallState(
        merged.targetResults,
        lockedPlan,
        merged.rebuildResults,
      );
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
      } catch {
        resolvedResult.warnings.push(OBSOLETE_CONTRACTS_CLEANUP_WARNING);
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

export async function runRebuildCommand(options: {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
}): Promise<RebuildCommandResult> {
  if (options.runtime?.codexObservationSession) {
    return runRebuildCommandInSession(options);
  }
  const env = options.runtime?.env ?? process.env;
  const session = await createCodexNativeObservationSession({
    exactCwd: options.commandOptions.cwd,
    env,
    runner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    manager: options.runtime?.codexManager,
  });
  try {
    return await runRebuildCommandInSession({
      ...options,
      runtime: { ...options.runtime, codexObservationSession: session },
    });
  } finally {
    await session.dispose();
  }
}
