import crypto from 'node:crypto';
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
import { parseCodexConfig, readCodexConfigFile } from '../utils/codex-config.js';
import {
  executeRebuildComponentCleanup,
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
import {
  assertSafeNamespacedMarketplacePluginRoot,
  getNamespacedMarketplaceName,
  readStrictNamespacedMarketplaceRoot,
} from '../utils/local-marketplace.js';
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
import {
  inspectPluginConfigResetTarget,
  readNamespacedPluginConfigStoreIdentity,
  resolvePluginConfigStorePath,
  resolveEffectivePluginConfig,
} from '../utils/plugin-config.js';
import { resolveArtifactRenderConfig } from '../utils/artifact-renderer.js';
import {
  inspectOwnedComponents,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  SKILL_OWNER_MARKER,
  type OwnedComponent,
} from '../utils/ownership.js';
import { resolveActiveCatalogGeneration, resolveActiveCatalogPluginShallow } from '../utils/catalog-generation-resolver.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  codexProjectConfigAliasesUserHome,
  getClaudeHome,
  getCodexHome,
  resolveRepoRootSync,
} from '../utils/state-paths.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  catalogGenerationErrorCode,
  isOfflineCleanupCatalogGenerationError,
} from '../utils/catalog-generation-error.js';
import type { NativeDemandView } from '../utils/native-demand.js';
import type { ScopeContext } from '../intent/scope-context.js';
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
  intentOnlyOfflineCleanupEvidence,
  offlineCleanupEvidenceFromInventory,
  offlineCleanupEvidenceMatches,
  type OfflineCleanupTargetEvidence,
} from './offline-cleanup-evidence.js';

export interface NativeExecutionInput {
  context: ScopeContext;
  /** Complete demand for context.scope, including targets outside this operation. */
  requirements: NativeDemandView;
  selectedTargets: readonly { pluginId: string; platform: PlatformName; scope: Scope }[];
  preserveOtherObservedTargets: true;
}

export type RebuildCommandRuntime = Partial<RebuildExecutionContext> & {
  awHomeMutationToken?: AwHomeMutationToken;
  executionInput?: NativeExecutionInput;
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
  resolvePreApplyAuthorization?: boolean;
  preApplyConfirmed?: boolean;
  scriptTimeoutMs?: number;
  directCli?: boolean;
  managedCodexAuthorizer?: ManagedCodexAuthorizer;
  codexManagerResolver?: typeof resolveCodexManager;
  codexOperationConsumerResolver?: typeof resolveCodexOperationConsumer;
  codexManagerPreviewer?: typeof previewCodexManager;
  onPreviewStage?: (stage: 'catalog' | 'inventory' | 'dependencyPlan') => Promise<void> | void;
  removeObsoleteInstallationContracts?: (directory: string) => Promise<void>;
  executeCleanupOperation?: typeof executeRebuildOperation;
  operationDiagnosticSink?: (results: readonly RebuildResult[]) => void;
};

export interface RebuildTaskTarget {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  method: 'sync' | 'reinstall';
}

export type RebuildTaskCommandOptions = Omit<InstallCommandOptions, 'platform' | 'scope'> & {
  repairTargets?: readonly RebuildTaskTarget[];
};

type RebuildCommandInvocation = {
  command: RebuildCommand;
  pluginNames: string[];
  commandOptions: CommandOptions;
  runtime?: RebuildCommandRuntime;
  all?: boolean;
  taskTargets?: readonly RebuildTaskTarget[];
  taskRepairTargets?: readonly RebuildTaskTarget[];
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
  /** In-memory physical output paths from the prepared targets; never persisted. */
  nativeFootprints?: Array<{ path: string; pluginId: string; platform: PlatformName; scope: Scope; shared: boolean }>;
  operationPlan?: OperationPlan;
  codexManagerPreview?: CodexManagerPreview;
  offlineCleanupPlans?: OfflineCleanupTargetEvidence[];
  preApplyAuthorization?: PreApplyAuthorizationTarget[];
}

export interface PreApplyAuthorizationTarget {
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  relation: 'requested' | 'direct' | 'transitive';
}

export interface RebuildCommandTestHooks {
  afterTargetBuilt?: (options: {
    command: RebuildCommand;
    identity: RebuildTargetIdentity;
  }) => Promise<void>;
  beforeActivationLegacyCleanupMutation?: (component: OwnedComponent) => Promise<void>;
  afterActivationLegacyCleanupQuarantine?: (
    component: OwnedComponent,
    quarantinePath: string,
  ) => Promise<void>;
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

function recoveryTarget(platform: PlatformName): 'codex' | 'claude-code' {
  return platform === 'claude' ? 'claude-code' : 'codex';
}

async function selectedProjectCodexSkillReferences(options: {
  cwd: string;
}): Promise<CatalogSourceReferenceInventory['references']> {
  const skillsRoot = path.join(resolveRepoRootSync(options.cwd), '.agents', 'skills');
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  });
  const references: CatalogSourceReferenceInventory['references'] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const skillRoot = path.join(skillsRoot, entry.name);
    const marker = await readSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot }).catch(() => null);
    if (!marker?.sourceId
      || marker.pluginId !== `${marker.sourceId}/${marker.plugin}`
      || marker.platform !== 'codex'
      || marker.scope !== 'project') continue;
    references.push({
      kind: 'namespacedOwner',
      location: path.join(skillRoot, SKILL_OWNER_MARKER),
      sourceId: marker.sourceId,
      pluginName: marker.plugin,
      platform: marker.platform,
      scope: marker.scope,
    });
  }
  return references;
}

const cleanupProjectSkillsByInventory = new WeakMap<
CatalogSourceReferenceInventory,
CatalogSourceReferenceInventory['references']
>();

function selectCodexActivationPlans(
  plans: readonly CodexReconcilePlan[],
  targetScopes: ReadonlySet<string>,
  preservedActivations?: {
    user: ReadonlyMap<string, boolean>;
    project: ReadonlyMap<string, boolean>;
  },
  originalUserActivations?: ReadonlyMap<string, boolean>,
): CodexReconcilePlan[] {
  return plans.flatMap((plan) => {
    const includesScope = (pluginId: string, scope: Scope) =>
      targetScopes.has(`${pluginId}\0${scope}`);
    const pluginIds = new Set(plan.desiredTargets.flatMap((target) =>
      (['user', 'project'] as const).some((scope) => includesScope(target.pluginId, scope))
        ? [target.pluginId]
        : []));
    if (pluginIds.size === 0) return [];
    const includesActivationAction = (
      action: CodexReconcilePlan['activationActions'][Scope][number],
    ) => includesScope(action.pluginId, action.scope);
    const sharedNativeActions = plan.sharedNativeActions.filter((action) =>
      pluginIds.has(action.pluginId));
    const userActions = plan.activationActions.user.filter((action) =>
      pluginIds.has(action.pluginId) && includesActivationAction(action));
    for (const action of plan.activationActions.user) {
      if (!originalUserActivations || includesScope(action.pluginId, 'user')
        || !includesScope(action.pluginId, 'project')
        || !sharedNativeActions.some((shared) => shared.pluginId === action.pluginId
          && (shared.action === 'install' || shared.action === 'replace' || shared.action === 'repair'))) {
        continue;
      }
      const original = originalUserActivations.get(action.codexPluginId) === true;
      if ((preservedActivations?.user.get(action.codexPluginId) === true) === original) continue;
      userActions.push({ ...action, action: original ? 'enable' : 'disable', desired: original });
    }
    const projectActions = plan.activationActions.project.filter((action) =>
      pluginIds.has(action.pluginId) && includesActivationAction(action));
    const desiredTargets = plan.desiredTargets.flatMap((target) => {
      const scopes = target.scopes.filter((scope) => includesScope(target.pluginId, scope));
      return scopes.length > 0 ? [{ ...target, scopes }] : [];
    });
    const postcheckPlugins = plan.postcheck.plugins.filter((plugin) =>
      pluginIds.has(plugin.pluginId)).map((plugin) => ({
        ...plugin,
        expectedUserEnabled: userActions.some((action) => action.pluginId === plugin.pluginId)
          ? plugin.expectedUserEnabled
          : preservedActivations?.user.get(plugin.codexPluginId) ?? false,
        expectedProjectEnabled: projectActions.some((action) => action.pluginId === plugin.pluginId)
          ? plugin.expectedProjectEnabled
          : preservedActivations?.project.get(plugin.codexPluginId) ?? false,
      }));
    const codexPluginIds = new Set([
      ...sharedNativeActions.map((action) => action.codexPluginId),
      ...userActions.map((action) => action.codexPluginId),
      ...projectActions.map((action) => action.codexPluginId),
      ...postcheckPlugins.map((plugin) => plugin.codexPluginId),
    ]);
    return [{
      ...plan,
      desiredTargets,
      sharedNativeActions,
      activationActions: { user: userActions, project: projectActions },
      extensionWrites: plan.extensionWrites.filter((action) =>
        includesScope(action.pluginId, action.scope)),
      extensionRemovals: plan.extensionRemovals.filter((action) =>
        includesScope(action.pluginId, action.scope)),
      staleActivationRemovals: plan.staleActivationRemovals.filter((action) =>
        codexPluginIds.has(action.codexPluginId)
        && [...pluginIds].some((pluginId) => includesScope(pluginId, action.scope))),
      postcheck: { ...plan.postcheck, plugins: postcheckPlugins },
    }];
  });
}

function failedCodexActivationTargetScopes(options: {
  error: unknown;
  plans: readonly CodexReconcilePlan[];
  successfulTargetScopes: ReadonlySet<string>;
}): Set<string> {
  const error = options.error;
  if (!(error instanceof CodexActivationPostcheckError)) {
    return new Set(options.successfulTargetScopes);
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
    if (!owners || owners.size === 0) return new Set(options.successfulTargetScopes);
    for (const pluginId of owners) {
      for (const scope of ['user', 'project'] as const) {
        const key = `${pluginId}\0${scope}`;
        if (options.successfulTargetScopes.has(key)) failed.add(key);
      }
    }
  }
  return failed.size > 0 ? failed : new Set(options.successfulTargetScopes);
}

function effectiveDependencyScopeOverrides(options: {
  state: NativeDemandView;
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

function nativeDemandDigest(demand: NativeDemandView): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(demand)).digest('hex')}`;
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
    skipPreApply?: boolean;
  };
}): Promise<RebuildCommandResult> {
  const runtime: RebuildExecutionContext = {
    signal: options.runtime?.signal,
    env: options.runtime?.env ?? process.env,
    nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    reporter: options.runtime?.reporter ?? createNoopReporter(),
    debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
    ...(options.runtime?.codexManager ? { codexManager: options.runtime.codexManager } : {}),
    expectedCatalogConfigDigest: options.runtime?.expectedCatalogConfigDigest,
    codexUserActivationDesired: options.runtime?.codexUserActivationDesired,
    codexObservationSession: options.runtime?.codexObservationSession,
    preApplyExecutionCache: options.runtime?.preApplyExecutionCache,
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
        let operationPreparation = options.execution?.operationPreparation;
        if (options.execution?.skipPreApply
          && !operationPreparation
          && (options.command === 'install'
            || options.command === 'sync'
            || options.command === 'reinstall')) {
          const prepared = await prepareRebuildOperation({
            command: options.command,
            target,
            driver,
            skipPreApply: true,
            onActionEvent: (event) => emitRebuildActionEvent(runtime, event),
          });
          if (prepared.status === 'failed') {
            results.push(prepared.result);
            continue;
          }
          operationPreparation = prepared.preparation;
        }
        result = await executeRebuildOperation({
          command: options.command,
          target,
          driver,
          ...(operationPreparation
            ? { preparation: operationPreparation }
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

function preparedNativeFootprints(
  targets: readonly DesiredTarget[],
): NonNullable<RebuildCommandResult['nativeFootprints']> {
  return targets.flatMap((target) =>
    (target.desiredOwnedComponents ?? target.ownedComponents).flatMap((component) => {
      let outputPath: string | undefined;
      if ('path' in component) outputPath = component.path;
      else if ('locator' in component) {
        const locator = component.locator;
        if ('configPath' in locator) outputPath = locator.configPath;
        else if ('settingsPath' in locator) outputPath = locator.settingsPath;
        else if ('hooksPath' in locator) outputPath = locator.hooksPath;
        else if ('marketplaceRoot' in locator) outputPath = locator.marketplaceRoot;
      }
      return outputPath ? [{
        path: path.resolve(outputPath),
        pluginId: target.identity.pluginId ?? target.identity.pluginName,
        platform: target.identity.platform,
        scope: target.identity.scope,
        shared: component.kind === 'shared-config' || component.kind === 'managed-block',
      }] : [];
    }));
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
      ? results.some((result) => result.overallState === 'partial') ? 'partial' : 'succeeded'
      : rebuildResults.some((result) => result.status === 'succeeded') ? 'partial' : 'failed',
    receiptTargets: results.flatMap((result) => result.receiptTargets),
    ...(results.some((result) => result.nativeFootprints !== undefined)
      ? { nativeFootprints: results.flatMap((result) => result.nativeFootprints ?? []) }
      : {}),
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
  dependencyPlan: ReconcileOperationPlan;
  codexPlans: readonly CodexReconcilePlan[];
  targetActions?: readonly OperationAction[];
  catalogSources: readonly CatalogSourceResolution[];
  requirements: NativeDemandView;
  scope: Scope;
  configDigests: OperationPlanEvidence['configDigests'];
}): OperationPlan {
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
    intentChanges: [],
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
      intentDigests: [{ scope: options.scope, digest: nativeDemandDigest(options.requirements) }],
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

function cleanupIntentTargets(options: {
  state: NativeDemandView;
  selectors: readonly string[];
  platforms: readonly PlatformName[];
  scope: Scope;
  all: boolean;
  liveTargets: readonly LiveCleanupTarget[];
  primarySourceId?: string;
}): LiveCleanupTarget[] {
  const selectedPlatforms = new Set(options.platforms);
  const liveByKey = new Map(options.liveTargets.map((target) => [
    `${target.pluginId}\0${target.platform}`,
    target,
  ]));
  const selectedIds = options.all
    ? new Set(options.state.roots.map((root) => root.pluginId))
    : new Set(options.selectors.flatMap((selector) => {
        const parsed = parsePluginId(selector);
        if (parsed.sourceId) return [formatPluginId(parsed)];
        const matches = options.state.roots
          .filter((root) => parsePluginId(root.pluginId).pluginName === parsed.pluginName)
          .map((root) => root.pluginId);
        const liveMatches = options.liveTargets
          .filter((target) => target.pluginName === parsed.pluginName)
          .map((target) => target.pluginId);
        const identities = [...new Set([...matches, ...liveMatches])];
        if (identities.length > 1) {
          throw new Error(
            `pluginSelectorAmbiguous: Plugin "${parsed.pluginName}" has multiple Intent or live matches: ${identities.sort().join(', ')}.`,
          );
        }
        return identities.length === 1
          ? identities
          : options.primarySourceId
            ? [formatPluginId({ sourceId: options.primarySourceId, pluginName: parsed.pluginName })]
            : [];
      }));
  return options.state.roots.flatMap((root) => root.platforms.flatMap((platform) => {
    if (!selectedIds.has(root.pluginId) || !selectedPlatforms.has(platform)) return [];
    const live = liveByKey.get(`${root.pluginId}\0${platform}`);
    if (live) return [live];
    const parsed = parsePluginId(root.pluginId);
    return [{
      pluginId: root.pluginId,
      pluginName: parsed.pluginName,
      sourceId: parsed.sourceId!,
      sourceIdentity: 'unavailable',
      platform,
      scope: options.scope,
    }];
  }));
}

function cleanupIntentResult(target: LiveCleanupTarget): RebuildResult {
  return {
    status: 'succeeded',
    command: 'cleanup',
    target: {
      pluginId: target.pluginId,
      pluginName: target.pluginName,
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      pluginVersion: '0.0.0',
      platform: target.platform,
      scope: target.scope,
      cwd: '.',
    },
    actions: [],
    cleanupAttempted: false,
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [],
  };
}

function cleanupInventoryWarnings(
  inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
  targets: readonly LiveCleanupTarget[],
): string[] {
  return inventory.errors.flatMap((error) => {
    const relevance = error.relevance;
    const relevant = relevance.global || targets.some((target) =>
      (relevance.sourceId === undefined || relevance.sourceId === target.sourceId)
      && (relevance.pluginName === undefined || relevance.pluginName === target.pluginName)
      && (relevance.platform === undefined || relevance.platform === target.platform)
      && (relevance.scope === undefined || relevance.scope === target.scope));
    if (!relevant) return [];
    const digest = crypto.createHash('sha256').update(JSON.stringify(error)).digest('hex');
    return [`stateInventoryResidual: ${error.kind} (sha256:${digest})`];
  }).sort();
}

function cleanupInventoryErrorsForTarget(
  inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>,
  target: LiveCleanupTarget,
) {
  return inventory.errors.filter((error) => {
    const relevance = error.relevance;
    return relevance.global || (
      (relevance.sourceId === undefined || relevance.sourceId === target.sourceId)
      && (relevance.pluginName === undefined || relevance.pluginName === target.pluginName)
      && (relevance.platform === undefined || relevance.platform === target.platform)
      && (relevance.scope === undefined || relevance.scope === target.scope)
    );
  });
}

function cleanupInventoryErrorsForSelection(options: {
  inventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>;
  selectors: readonly string[];
  platforms: readonly PlatformName[];
  scope: Scope;
  all: boolean;
}) {
  const selectors = options.selectors.map(parsePluginId);
  return options.inventory.errors.filter((error) => {
    const relevance = error.relevance;
    if (relevance.global) return true;
    if (relevance.scope !== undefined && relevance.scope !== options.scope) return false;
    if (relevance.platform !== undefined && !options.platforms.includes(relevance.platform)) return false;
    if (options.all) return true;
    return selectors.some((selector) =>
      (relevance.pluginName === undefined || relevance.pluginName === selector.pluginName)
      && (selector.sourceId === undefined
        || relevance.sourceId === undefined
        || relevance.sourceId === selector.sourceId));
  });
}

function cleanupActionCoversLocation(
  evidence: OfflineCleanupTargetEvidence | undefined,
  location: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): boolean {
  const rawRepoRoot = resolveRepoRootSync(cwd);
  const sensitiveRoots = [
    canonicalizePathThroughExistingAncestorSync(getCodexHome(env)),
    canonicalizePathThroughExistingAncestorSync(getClaudeHome(env)),
    canonicalizePathThroughExistingAncestorSync(rawRepoRoot),
    getCodexHome(env),
    getClaudeHome(env),
    rawRepoRoot,
  ];
  const normalizedLocation = location.replaceAll('\\', '/');
  return evidence?.plan.actions.some((action) => {
    if (action.action !== 'removeOwnedOutput') return false;
    const normalizedTarget = sanitizeCatalogSourceErrorMessage(
      action.target,
      env,
      sensitiveRoots,
    ).replaceAll('\\', '/');
    const relative = path.posix.relative(normalizedTarget, normalizedLocation);
    return relative === ''
      || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
  }) ?? false;
}

function cleanupLocatorPaths(component: Extract<OwnedComponent, { locator: unknown }>): string[] {
  const locator = component.locator;
  switch (locator.kind) {
    case 'claude-permissions': return [locator.settingsPath];
    case 'codex-instruction': return [locator.configPath];
    case 'codex-activation': return [locator.configPath];
    case 'legacy-codex-mcp': return [locator.configPath];
    case 'legacy-codex-hook': return [locator.hooksPath];
    case 'codex-role-registration': return [locator.configPath, locator.rolePath];
    case 'codex-marketplace':
    case 'claude-marketplace': return [locator.marketplaceRoot];
    case 'corrupted': return [];
  }
}

function cleanupPathAuthorized(pathValue: string, evidence: OfflineCleanupTargetEvidence): boolean {
  const normalizedPath = canonicalizePathThroughExistingAncestorSync(pathValue);
  return evidence.plan.actions.some((action) => {
    if (action.action !== 'removeOwnedOutput') return false;
    const actionPath = action.target.split('#', 1)[0]!;
    const normalizedActionPath = canonicalizePathThroughExistingAncestorSync(actionPath);
    const relative = path.relative(normalizedPath, normalizedActionPath);
    return relative === ''
      || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
}

function cleanupComponentAuthorized(
  component: OwnedComponent,
  evidence: OfflineCleanupTargetEvidence,
): boolean {
  if ('path' in component) return cleanupPathAuthorized(component.path, evidence);
  if (component.kind === 'native-plugin') {
    return evidence.plan.actions.some((action) =>
      action.action === 'removeNativeRegistration' && action.target === component.pluginId);
  }
  const locator = component.locator;
  if (locator.kind === 'codex-activation') {
    return evidence.plan.actions.some((action) =>
      action.action === 'removeNativeRegistration'
      && action.target === locator.codexPluginId);
  }
  if (locator.kind === 'codex-marketplace'
    || locator.kind === 'claude-marketplace') {
    return evidence.plan.actions.some((action) =>
      action.action === 'removeNativeRegistration'
      && action.marketplaceName === locator.marketplaceName);
  }
  if (evidence.plan.actions.some((action) =>
    action.action === 'removeOwnedOutput' && action.target === component.label)) return true;
  return cleanupLocatorPaths(component).some((candidate) =>
    cleanupPathAuthorized(candidate, evidence));
}

function cleanupComponentResidual(component: OwnedComponent): string {
  if ('path' in component) return component.path;
  if (component.kind === 'native-plugin') return component.pluginId;
  return component.label;
}

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
  executeCleanupOperation?: typeof executeRebuildOperation;
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
    try {
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
      const activationDisposition: 'disable' = 'disable';
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
        includeNativeCleanupCandidate: false,
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
      const sharedNativeComponent = (component: OwnedComponent): boolean =>
        component.kind === 'native-plugin'
        || (component.kind === 'shared-config'
          && component.identity.artifactKey.startsWith('marketplace-'));
      desired.requiresNative = false;
      desired.writeNativeRequired = false;
      desired.ownedComponents = desired.ownedComponents.filter((component) =>
        !sharedNativeComponent(component));
      desired.desiredOwnedComponents = desired.desiredOwnedComponents?.filter((component) =>
        !sharedNativeComponent(component));
      desired.optionalOwnedComponents = desired.optionalOwnedComponents?.filter((component) =>
        !sharedNativeComponent(component));
      desired.operationActions = desired.operationActions?.filter((action) =>
        action.kind !== 'removeNativeRegistration');
      const unplannedCandidates = evidence
        ? desired.ownedComponents.filter((component) =>
            !cleanupComponentAuthorized(component, evidence))
        : [];
      const unplannedComponents = unplannedCandidates.length > 0
        ? (await inspectOwnedComponents({
            components: unplannedCandidates,
            executor: integration.driver.ownership,
          })).components.flatMap((entry) => entry.state === 'present' ? [entry.component] : [])
        : [];
      if (evidence) {
        const authorized = (component: OwnedComponent): boolean =>
          cleanupComponentAuthorized(component, evidence);
        desired.ownedComponents = desired.ownedComponents.filter(authorized);
        desired.desiredOwnedComponents = desired.desiredOwnedComponents?.filter(authorized);
        desired.optionalOwnedComponents = desired.optionalOwnedComponents?.filter(authorized);
        desired.artifacts = desired.artifacts.filter((artifact) =>
          cleanupPathAuthorized(artifact.path, evidence));
        desired.requiresNative = false;
        desired.writeNativeRequired = false;
        desired.operationActions = desired.operationActions?.filter((action) => {
          if (action.kind === 'removeOwnedArtifact') {
            return cleanupPathAuthorized(action.path, evidence);
          }
          if (action.kind === 'setActivation') {
            return Boolean(activationAction
              && action.scope === target.scope
              && action.registration === activationAction.target);
          }
          return false;
        });
      }
      const result = await (options.executeCleanupOperation ?? executeRebuildOperation)({
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
      if (unplannedComponents.length > 0) {
        const message = 'operationPlanResidual: Newly discovered owned output was not included in the cleanup plan and was preserved.';
        result.residual = [...new Set([
          ...result.residual,
          ...unplannedComponents.map(cleanupComponentResidual),
        ])];
        warnings.push(message);
        if (result.status === 'succeeded') {
          finalResult = {
            ...result,
            status: 'failed',
            failures: [...result.failures, { phase: 'cleanup.owned', message }],
            error: { phase: 'cleanup.owned', message },
          };
        }
      }
      if (inventoryErrors.length > 0) {
        const message = 'stateInventoryResidual: Some weak state could not be verified. Retry cleanup, use cleanup --force only for exclusively owned damaged output, or run reinstall/sync to restore the target.';
        result.residual = [...new Set([
          ...result.residual,
          ...inventoryErrors.map((error) => error.location),
        ])];
        warnings.push(...inventoryErrors.map((error) =>
          `stateInventoryResidual: ${error.kind}: ${error.message}`));
        if (finalResult.status === 'succeeded') {
          finalResult = {
            ...finalResult,
            status: 'failed',
            failures: [...finalResult.failures, { phase: 'cleanup.owned', message }],
            error: { phase: 'cleanup.owned', message },
          };
        }
      }
      results.push(finalResult);
    } catch (error) {
      results.push(failedResult(
        'cleanup',
        {
          pluginId: target.pluginId,
          pluginName: target.pluginName,
          sourceId: target.sourceId,
          sourceIdentity: target.sourceIdentity,
          pluginVersion: '0.0.0',
          platform: target.platform,
          scope: target.scope,
          cwd: options.cwd,
        },
        error instanceof Error ? error.message : String(error),
        'cleanup.owned',
      ));
    }
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
  requirements?: { scope: Scope; view: NativeDemandView },
  warnings: readonly string[] = [],
): OperationPlan {
  return createOperationPlan({
    intentChanges: [],
    actions: evidence.flatMap((target) => target.plan.actions.flatMap((action): OperationAction[] =>
      action.action === 'removeOwnedOutput'
        ? [{
            kind: 'removeOwnedArtifact',
            pluginId: target.pluginId,
            platform: target.platform,
            scope: target.scope,
            path: action.target,
            ownerFingerprint: target.targetFingerprint,
          }]
        : action.activationScope === target.scope
          ? [{
              kind: 'setActivation',
              pluginId: target.pluginId,
              platform: 'codex',
              scope: target.scope,
              enabled: false,
            }]
          : [])),
    changes: evidence.flatMap((target) => target.plan.actions.flatMap((action) =>
      action.action === 'removeOwnedOutput'
        ? [`${target.pluginId}:${target.platform}:${target.scope}:${action.action}:${action.target}`]
        : action.activationScope === target.scope
          ? [`${target.pluginId}:${target.platform}:${target.scope}:setActivation:false:${action.target}`]
          : [])),
    warnings: [...warnings],
    evidence: {
      catalogDigests: evidence.map((target) => ({
        sourceId: target.sourceId,
        digest: target.sourceIdentity,
      })),
      intentDigests: requirements
        ? [{ scope: requirements.scope, digest: nativeDemandDigest(requirements.view) }]
        : [],
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

export type RemovedPluginCleanupTarget = {
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  logicalIdentity: string;
  snapshotDigest: string;
  marketplaceRoot: string;
  marketplaceName?: string;
  nativeOwnershipVerified: boolean;
  projectionOwnershipVerified: boolean;
  claudeNativeCleanupBlocked: boolean;
  nativeState: 'installed' | 'absent' | 'unknown' | 'unbound';
  nativeObservationFingerprint: string;
  marketplaceEvidenceFingerprint: string;
  projectionFingerprint: string;
  projectionPresent: boolean;
  activationScopes: Array<{ scope: Scope; enabled: boolean | undefined }>;
  configTargets: Array<{
    scope: Scope;
    kind: Awaited<ReturnType<typeof inspectPluginConfigResetTarget>>['kind'];
    fingerprint: string;
  }>;
  evidence: OfflineCleanupTargetEvidence[];
  blockers: string[];
};

function removedCleanupDigest(value: unknown): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

async function removedProjectionTreeFingerprint(root: string): Promise<string> {
  const visit = async (location: string): Promise<unknown> => {
    const stats = await fs.lstat(location).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) return null;
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      return { kind: 'unsafe', mode: stats.mode, size: stats.size, mtimeMs: stats.mtimeMs };
    }
    if (stats.isFile()) {
      return { kind: 'file', digest: `sha256:${crypto.createHash('sha256').update(await fs.readFile(location)).digest('hex')}` };
    }
    const entries = await fs.readdir(location);
    return { kind: 'directory', entries: await Promise.all(entries.sort().map(async (name) =>
      [name, await visit(path.join(location, name))])) };
  };
  return removedCleanupDigest(await visit(root));
}

export async function inspectRemovedPluginConfig(options: {
  sourceId: string;
  sourceIdentity: string;
  logicalIdentity: string;
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  kind: Awaited<ReturnType<typeof inspectPluginConfigResetTarget>>['kind'];
  fingerprint: string;
  conflict?: string;
}> {
  const inspection = await inspectPluginConfigResetTarget(options);
  if (inspection.kind !== 'regularFile') return inspection;
  try {
    const identity = await readNamespacedPluginConfigStoreIdentity(options);
    if (identity && (options.scope === 'user'
      ? identity.binding.kind !== 'source'
        || identity.binding.sourceIdentity !== options.sourceIdentity
      : identity.binding.kind !== 'catalog'
        || identity.binding.logicalIdentity !== options.logicalIdentity)) {
      return { ...inspection, conflict: 'removedPluginConfigIdentityConflict: saved config binding differs from the Active source.' };
    }
  } catch {
    const filePath = resolvePluginConfigStorePath(options);
    const raw = await fs.readJson(filePath).catch(() => null) as Record<string, unknown> | null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const binding = raw.binding as Record<string, unknown> | undefined;
      if ((typeof raw.sourceId === 'string' && raw.sourceId !== options.sourceId)
        || (typeof raw.pluginName === 'string' && raw.pluginName !== options.pluginName)
        || (binding?.kind === 'source' && options.scope !== 'user')
        || (binding?.kind === 'catalog' && options.scope !== 'project')
        || (binding?.kind === 'source' && options.scope === 'user'
          && typeof binding.sourceIdentity === 'string'
          && binding.sourceIdentity !== options.sourceIdentity)
        || (binding?.kind === 'catalog' && options.scope === 'project'
          && typeof binding.logicalIdentity === 'string'
          && binding.logicalIdentity !== options.logicalIdentity)) {
        return { ...inspection, conflict: 'removedPluginConfigIdentityConflict: saved config identifies another source or plugin.' };
      }
    }
  }
  return inspection;
}

export async function inspectRemovedPluginCleanup(options: {
  pluginId: string;
  scope: Scope;
  inventory: CatalogSourceReferenceInventory;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  codexManager?: CodexManager;
}): Promise<RemovedPluginCleanupTarget | null> {
  const parsed = parsePluginId(options.pluginId);
  if (!parsed.sourceId) return null;
  let generation: Awaited<ReturnType<typeof resolveActiveCatalogGeneration>>;
  try {
    generation = await resolveActiveCatalogGeneration({ sourceId: parsed.sourceId, env: options.env });
  } catch {
    return null;
  }
  if (generation.manifest.entries.some((entry) => entry.name === parsed.pluginName)) return null;
  const pluginId = formatPluginId(parsed);
  const blockers: string[] = [];
  const marketplaceRoot = path.join(resolveAwHome(options.env), 'marketplaces', parsed.sourceId);
  const relevant = options.inventory.references.filter((reference) =>
    reference.sourceId === parsed.sourceId && reference.pluginName === parsed.pluginName);
  const ownershipConflict = relevant.some((reference) => reference.sourceIdentity !== undefined
    && reference.sourceIdentity !== generation.sourceIdentity);
  if (ownershipConflict) {
    blockers.push('removedPluginOwnershipConflict: live source identity differs from Active. Repair ownership evidence, then retry cleanup.');
  }
  let root: Awaited<ReturnType<typeof readStrictNamespacedMarketplaceRoot>> = null;
  try {
    root = await readStrictNamespacedMarketplaceRoot({
      rootDir: marketplaceRoot,
      sourceId: parsed.sourceId,
      sourceIdentity: generation.sourceIdentity,
    });
    if (root?.config.logicalIdentity && root.config.logicalIdentity !== generation.logicalIdentity) {
      blockers.push('removedPluginMarketplaceIdentityConflict: marketplace logical identity differs from Active.');
    }
  } catch (error) {
    blockers.push(`removedPluginMarketplaceEvidenceUnavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const registeredNames = canonicalMarketplaceRegistrationNames(options.inventory.references, parsed.sourceId);
  const marketplaceName = root?.config.marketplaceName
    ?? (registeredNames.length === 1 ? registeredNames[0] : undefined);
  let registrationReadFailed = false;
  const registration = root ? await inspectNativeMarketplaceRegistrations({
    marketplaceName: root.config.marketplaceName,
    marketplaceRoot,
    cwd: options.cwd,
    env: options.env,
  }).catch((error) => {
    registrationReadFailed = true;
    blockers.push(`removedPluginMarketplaceRegistrationUnknown: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }) : null;
  const projectionOwnershipVerified = Boolean(root
    && !ownershipConflict
    && (!root.config.logicalIdentity || root.config.logicalIdentity === generation.logicalIdentity));
  const nativeOwnershipVerified = projectionOwnershipVerified
    && registration?.codex === 'canonical';
  let claudeNativeCleanupBlocked = registrationReadFailed;
  if (registration?.claude === 'foreign') {
    blockers.push('removedPluginClaudeOwnershipConflict: Claude marketplace registration is foreign.');
    claudeNativeCleanupBlocked = true;
  }
  if (registration?.claude !== 'canonical' && relevant.some((reference) =>
    reference.platform === 'claude' && reference.kind === 'namespacedMarketplace')) {
    blockers.push('removedPluginClaudeOwnershipUnavailable: Claude native evidence exists without a canonical marketplace registration.');
    claudeNativeCleanupBlocked = true;
  }
  const activationScopes: RemovedPluginCleanupTarget['activationScopes'] = [];
  if (marketplaceName) {
    const inspectedPaths = new Set<string>();
    for (const scope of [options.scope]) {
      const configPath = resolveCodexPaths(options.cwd, scope, options.env).configTomlPath;
      if (inspectedPaths.has(path.resolve(configPath))) continue;
      inspectedPaths.add(path.resolve(configPath));
      try {
        const config = await readCodexConfigFile(configPath);
        if (Object.hasOwn(config.snapshot.plugins, `${parsed.pluginName}@${marketplaceName}`)) {
          activationScopes.push({
            scope,
            enabled: config.snapshot.plugins[`${parsed.pluginName}@${marketplaceName}`]?.enabled,
          });
        }
      } catch (error) {
        blockers.push(`removedPluginActivationReadFailed: ${scope}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  let nativeState: RemovedPluginCleanupTarget['nativeState'] = 'unbound';
  let nativeObservationFingerprint = removedCleanupDigest('unbound');
  if (root) {
    if (registration?.codex === 'foreign') {
      blockers.push('removedPluginNativeOwnershipConflict: Codex marketplace registration is foreign.');
    } else {
      const observed = await inspectCodexPluginRegistrationLive({
        pluginId: `${parsed.pluginName}@${marketplaceName}`,
        cwd: options.cwd,
        env: options.env,
        nativeCliRunner: options.nativeCliRunner,
        manager: options.codexManager,
        scope: options.scope,
      });
      nativeState = observed.observation.state === 'observed'
        ? observed.observation.value === 'installed' ? 'installed' : 'absent'
        : 'unknown';
      nativeObservationFingerprint = removedCleanupDigest(observed.observation);
      if (nativeState === 'unknown') {
        blockers.push('removedPluginNativeObservationUnknown: official Codex list did not confirm installed or absent. Retry cleanup with a compatible Codex CLI.');
      }
      if (registration?.codex !== 'canonical'
        && (nativeState === 'installed' || activationScopes.length > 0)) {
        blockers.push('removedPluginNativeOwnershipUnavailable: native or activation evidence exists but canonical marketplace registration is missing.');
      }
    }
  } else if (options.inventory.references.some((reference) =>
    reference.pluginName === parsed.pluginName
    && reference.platform === 'codex'
    && reference.marketplaceName)) {
    blockers.push('removedPluginNativeOwnershipUnavailable: native evidence remains without a valid AW marketplace root.');
  }
  const configTargets: RemovedPluginCleanupTarget['configTargets'] = [];
  for (const scope of [options.scope]) {
    try {
      const inspected = await inspectRemovedPluginConfig({
        sourceId: parsed.sourceId,
        sourceIdentity: generation.sourceIdentity,
        logicalIdentity: generation.logicalIdentity,
        pluginName: parsed.pluginName,
        scope,
        cwd: options.cwd,
        env: options.env,
      });
      configTargets.push({ scope, kind: inspected.kind, fingerprint: inspected.fingerprint });
      if (inspected.conflict) blockers.push(`${scope}: ${inspected.conflict}`);
      if (inspected.kind === 'directory' || inspected.kind === 'special') {
        blockers.push(`removedPluginConfigTargetUnsupported: ${scope} saved config is a ${inspected.kind}. Repair the node or run explicit config reset, then retry cleanup.`);
      }
    } catch (error) {
      blockers.push(`removedPluginConfigTargetUnsafe: ${scope}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const projectionRoot = path.join(marketplaceRoot, 'plugins', parsed.pluginName);
  let projectionPathSafe = true;
  if (root) {
    try {
      await assertSafeNamespacedMarketplacePluginRoot(marketplaceRoot, parsed.pluginName);
    } catch (error) {
      projectionPathSafe = false;
      blockers.push(`removedPluginMarketplaceProjectionUnsafe: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const projectionStats = root && projectionPathSafe ? await fs.lstat(projectionRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }) : null;
  const projectionPresent = Boolean(root && (projectionStats
    || [root.agentsManifest, root.claudeManifest].some((manifest) =>
      manifest && Array.isArray(manifest.plugins) && manifest.plugins.some((entry) =>
        entry !== null && typeof entry === 'object'
        && (entry as { name?: unknown }).name === parsed.pluginName))));
  const projectionFingerprint = removedCleanupDigest({
    tree: root && projectionPathSafe ? await removedProjectionTreeFingerprint(projectionRoot) : 'unsafe',
    agentsEntries: root && Array.isArray(root.agentsManifest.plugins)
      ? root.agentsManifest.plugins.filter((entry) => entry !== null && typeof entry === 'object'
        && (entry as { name?: unknown }).name === parsed.pluginName)
      : null,
    claudeEntries: root?.claudeManifest && Array.isArray(root.claudeManifest.plugins)
      ? root.claudeManifest.plugins.filter((entry) => entry !== null && typeof entry === 'object'
        && (entry as { name?: unknown }).name === parsed.pluginName)
      : null,
  });
  const marketplaceEvidenceFingerprint = removedCleanupDigest({
    config: root?.config ?? null,
    registration,
    marketplaceName,
  });
  const evidence: OfflineCleanupTargetEvidence[] = [];
  for (const platform of ['codex', 'claude'] as const) {
    for (const scope of [options.scope]) {
      const base = offlineCleanupEvidenceFromInventory({
        reason: 'bundleUnavailable',
        pluginId,
        pluginName: parsed.pluginName,
        sourceId: parsed.sourceId,
        sourceIdentity: generation.sourceIdentity,
        platform,
        scope,
        inventory: options.inventory,
      }) ?? intentOnlyOfflineCleanupEvidence({
        pluginId,
        pluginName: parsed.pluginName,
        sourceId: parsed.sourceId,
        sourceIdentity: generation.sourceIdentity,
        platform,
        scope,
      });
      const actions = base.plan.actions.filter((action) =>
        action.action !== 'removeNativeRegistration'
        || (platform === 'codex'
          && nativeOwnershipVerified
          && projectionPathSafe
          && action.activationScope === scope));
      const safeActions = ownershipConflict ? [] : actions;
      const enrichedActions = await Promise.all(safeActions.map(async (action) => action.action === 'removeOwnedOutput'
        ? { ...action, pathEvidence: await removedProjectionTreeFingerprint(action.target.split('#', 1)[0]!) }
        : action));
      const plan = { ...base.plan, actions: enrichedActions };
      evidence.push({ ...base, plan, planDigest: removedCleanupDigest(plan), targetFingerprint: removedCleanupDigest(plan) });
    }
  }
  return {
    pluginId,
    pluginName: parsed.pluginName,
    sourceId: parsed.sourceId,
    sourceIdentity: generation.sourceIdentity,
    logicalIdentity: generation.logicalIdentity,
    snapshotDigest: generation.snapshotDigest,
    marketplaceRoot,
    ...(marketplaceName ? { marketplaceName } : {}),
    nativeOwnershipVerified: nativeOwnershipVerified && projectionPathSafe,
    projectionOwnershipVerified: projectionOwnershipVerified && projectionPathSafe,
    claudeNativeCleanupBlocked,
    nativeState,
    nativeObservationFingerprint,
    marketplaceEvidenceFingerprint,
    projectionFingerprint,
    projectionPresent,
    activationScopes,
    configTargets,
    evidence,
    blockers,
  };
}

export async function executeRemovedPluginOutputCleanup(options: {
  target: RemovedPluginCleanupTarget;
  selectedTargets: readonly { pluginId: string; platform: PlatformName; scope: Scope }[];
  context: ScopeContext;
  runtime?: RebuildCommandRuntime;
}): Promise<RebuildCommandResult> {
  const selected = options.selectedTargets.filter((target) =>
    target.pluginId === options.target.pluginId && target.scope === options.context.scope);
  if (selected.length === 0) return mergeRebuildCommandResults([]);
  const inventoryReader = options.runtime?.inventoryCatalogSourceReferences
    ?? inventoryCatalogSourceReferences;
  const inventory = await inventoryReader({
    cwd: options.context.executionCwd,
    env: options.context.env,
    scope: options.context.scope,
    includeProjectAgentSkills: true,
  });
  const current = await inspectRemovedPluginCleanup({
    pluginId: options.target.pluginId,
    scope: options.context.scope,
    inventory,
    cwd: options.context.executionCwd,
    env: options.context.env,
    nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    codexManager: options.runtime?.codexManager,
  });
  if (!current || current.sourceIdentity !== options.target.sourceIdentity
    || current.projectionFingerprint !== options.target.projectionFingerprint
    || current.evidence.some((entry) => {
      const expected = options.target.evidence.find((candidate) =>
        candidate.platform === entry.platform && candidate.scope === entry.scope);
      return !expected || !offlineCleanupEvidenceMatches(expected, entry);
    })) {
    throw new Error('operationReviewStale: removed plugin ownership or output changed before cleanup.');
  }
  const evidence = current.evidence.filter((entry) => selected.some((target) =>
    target.platform === entry.platform && target.scope === entry.scope));
  const targets: LiveCleanupTarget[] = evidence.map((entry) => ({
    pluginId: current.pluginId,
    pluginName: current.pluginName,
    sourceId: current.sourceId,
    sourceIdentity: current.sourceIdentity,
    platform: entry.platform,
    scope: entry.scope,
    ...(current.marketplaceName ? { marketplaceName: current.marketplaceName } : {}),
    nativeRegistration: entry.platform === 'codex',
  }));
  const result = await cleanupOfflineOwnedComponents({
    targets,
    evidence,
    inventoryErrors: inventory.errors.filter((error) => !error.kind.startsWith('config')),
    cwd: options.context.executionCwd,
    env: options.context.env,
    nativeCliRunner: options.runtime?.nativeCliRunner,
    codexManager: options.runtime?.codexManager,
    executeCleanupOperation: options.runtime?.executeCleanupOperation,
    removeObsoleteInstallationContracts: options.runtime?.removeObsoleteInstallationContracts,
  });
  result.operationPlan = createOfflineCleanupOperationPlan(evidence);
  const residual = [
    ...current.blockers.filter((blocker) => !blocker.includes('Config')),
    ...(current.nativeState === 'installed' || current.nativeState === 'unknown'
      ? ['sharedNativePreserved: Codex package remains available to other scopes.'] : []),
    ...(current.projectionPresent ? ['sharedMarketplaceProjectionPreserved'] : []),
  ];
  if (residual.length > 0) {
    result.warnings.push(...residual);
    if (result.overallState === 'succeeded') result.overallState = 'partial';
  }
  return result;
}

async function runRebuildCommandInSession(
  options: RebuildCommandInvocation,
): Promise<RebuildCommandResult> {
  const executionInput = options.runtime?.executionInput;
  if (!executionInput || executionInput.context.scope !== options.commandOptions.scope
    || executionInput.preserveOtherObservedTargets !== true) {
    throw new Error('nativeExecutionInputRequired: Native execution requires an explicit matching scope context and complete demand.');
  }
  if (executionInput.selectedTargets.length === 0) return mergeRebuildCommandResults([]);
  if (executionInput.selectedTargets.some((target) => target.scope !== executionInput.context.scope)) {
    throw new Error('nativeExecutionTargetScopeInvalid: Selected targets must use the execution context scope.');
  }
  const requestedPlatforms = selectedPlatforms(options.commandOptions.platform);
  if (executionInput.selectedTargets.some((target) => !requestedPlatforms.includes(target.platform))) {
    throw new Error('nativeExecutionTargetPlatformInvalid: Selected targets must use a requested platform.');
  }
  const selectedExecutionTarget = (target: { pluginId?: string; platform: PlatformName; scope: Scope }): boolean =>
    executionInput.selectedTargets.some((selected) =>
      selected.pluginId === target.pluginId && selected.platform === target.platform && selected.scope === target.scope);
  const runtimeEnv = executionInput.context.env;
  const readInventory = options.runtime?.inventoryCatalogSourceReferences
    ?? inventoryCatalogSourceReferences;
  let ordinaryInventory: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>> | undefined;
  const readOrdinaryInventory = async () => {
    ordinaryInventory ??= await measureCommandPerformanceStage(options.runtime, 'inventory', async () => {
      const inventory = await readInventory({
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        scope: options.commandOptions.scope,
      });
      if (options.command !== 'cleanup'
        || options.commandOptions.scope !== 'project'
        || !selectedPlatforms(options.commandOptions.platform).includes('codex')) return inventory;
      let projectSkills = cleanupProjectSkillsByInventory.get(inventory);
      if (!projectSkills) {
        projectSkills = await selectedProjectCodexSkillReferences({
          cwd: options.commandOptions.cwd,
        });
        cleanupProjectSkillsByInventory.set(inventory, projectSkills);
      }
      const selectors = options.pluginNames.map(parsePluginId);
      const selectedProjectSkills = options.all === true
        ? projectSkills
        : projectSkills.filter((reference) => selectors.some((selector) =>
            selector.pluginName === reference.pluginName
            && (selector.sourceId === undefined || selector.sourceId === reference.sourceId)));
      return {
        ...inventory,
        references: [...new Map([...inventory.references, ...selectedProjectSkills].map((reference) => [[
          reference.kind,
          reference.location,
          reference.sourceId ?? '',
          reference.pluginName ?? '',
          reference.platform ?? '',
          reference.scope ?? '',
        ].join('\0'), reference])).values()],
      };
    });
    return ordinaryInventory;
  };
  let requestedPluginNames = options.pluginNames;
  const cleanupForce = options.command === 'cleanup'
    && (options.commandOptions as CleanupCommandOptions).force === true;
  const cleanupRequirements = options.command === 'cleanup' ? executionInput.requirements : undefined;
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
    cleanupLiveTargets = live.targets.filter(selectedExecutionTarget);
    if (expectedOfflineCleanup
      && expectedOfflineCleanup.forceExclusive !== true
      && expectedOfflineCleanup.plan.actions.length > 0) {
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
      cleanupLiveTargets = projectedTargets.filter(selectedExecutionTarget);
    }
    const identities = new Set<string>();
    for (const reference of live) {
      const pluginId = formatPluginId({ sourceId: reference.sourceId!, pluginName: reference.pluginName! });
      identities.add(pluginId);
    }
    if (options.command === 'cleanup') {
      for (const root of cleanupRequirements!.roots) identities.add(root.pluginId);
    }
    requestedPluginNames = [...identities];
  }
  let cleanupTargets: LiveCleanupTarget[] = [];
  let cleanupUnavailableWarnings: string[] = [];
  let cleanupSelectionErrors: Awaited<ReturnType<typeof inventoryCatalogSourceReferences>>['errors'] = [];
  if (options.command === 'cleanup') {
    const primarySourceId = cleanupForce
      ? await readCatalogSourcesConfigSnapshot(runtimeEnv)
          .then((snapshot) => snapshot.config.sources.find((source) => source.primary)?.id)
          .catch(() => undefined)
      : undefined;
    const intentTargets = cleanupIntentTargets({
      state: cleanupRequirements!,
      selectors: options.pluginNames,
      platforms: selectedPlatforms(options.commandOptions.platform),
      scope: options.commandOptions.scope,
      all: options.all === true,
      liveTargets: cleanupLiveTargets,
      primarySourceId,
    });
    const damagedTargets = options.pluginNames.flatMap((selector) => {
      const parsed = parsePluginId(selector);
      if (!parsed.sourceId) return [];
      return selectedPlatforms(options.commandOptions.platform).flatMap((platform) =>
        cleanupInventory!.errors.some((error) => error.relevance.global || (
          (error.relevance.sourceId === undefined || error.relevance.sourceId === parsed.sourceId)
          && (error.relevance.pluginName === undefined || error.relevance.pluginName === parsed.pluginName)
          && (error.relevance.platform === undefined || error.relevance.platform === platform)
          && (error.relevance.scope === undefined || error.relevance.scope === options.commandOptions.scope)
        )) ? [{
          pluginId: formatPluginId(parsed),
          pluginName: parsed.pluginName,
          sourceId: parsed.sourceId!,
          sourceIdentity: 'unavailable',
          platform,
          scope: options.commandOptions.scope,
        }] : []);
    });
    cleanupTargets = [...new Map([...damagedTargets, ...intentTargets, ...cleanupLiveTargets].map((target) => [
      `${target.pluginId}\0${target.platform}\0${target.scope}`,
      target,
    ] as const)).values()].filter(selectedExecutionTarget);
    requestedPluginNames = [...new Set([
      ...requestedPluginNames,
      ...cleanupTargets.map((target) => target.pluginId),
    ])];
    const filtered = omitSelectedPluginConfigErrors(cleanupInventory!, cleanupTargets);
    cleanupInventory = filtered.inventory;
    malformedSelectedConfigPreserved ||= filtered.omitted;
    cleanupSelectionErrors = cleanupInventoryErrorsForSelection({
      inventory: cleanupInventory,
      selectors: options.pluginNames,
      platforms: selectedPlatforms(options.commandOptions.platform),
      scope: options.commandOptions.scope,
      all: options.all === true,
    });
  }
  const selectors = requestedPluginNames.map(parsePluginId);
  const sourceIds = planPluginSelectorSourceIds(selectors);
  if (options.all && selectors.length === 0 && options.command !== 'cleanup') {
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
    if (!cleanupForce
      && cleanupTargets.length === 0
      && cleanupSelectionErrors.length === 0
      && legacyLiveTargets.length === 0) {
      const result = mergeRebuildCommandResults([]);
      const operationPlan = createOfflineCleanupOperationPlan([], { scope: options.commandOptions.scope, view: cleanupRequirements! }, [...cleanupInventoryWarnings(cleanupInventory!, []), ...cleanupUnavailableWarnings]);
      if (options.runtime?.expectedPlanFingerprint) {
        assertOperationPlanFingerprint(options.runtime.expectedPlanFingerprint, operationPlan);
      }
      result.operationPlan = operationPlan;
      result.warnings.push(...cleanupUnavailableWarnings);
      return result;
    }
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
      const supplementAttempts = await Promise.allSettled(selectorsNeedingSupplement.map((selector) =>
        buildForceExclusiveCleanupPlan({
          selectors: [selector],
          platforms: requestedPlatforms,
          scope: options.commandOptions.scope,
          cwd: options.commandOptions.cwd,
          env: runtimeEnv,
          primarySourceId: primarySource,
          damagedOnly: cleanupLiveTargets.length > 0,
        })));
      const forcePlan = await mergeForceCleanupPlans(
        livePlan,
        ...supplementAttempts.flatMap((attempt) => attempt.status === 'fulfilled' ? [attempt.value] : []),
      );
      forcePlan.targets = forcePlan.targets.filter((target) => selectedExecutionTarget(target.identity));
      forcePlan.evidence = forcePlan.evidence.filter(selectedExecutionTarget);
      const forceCleanupTargets = [...new Map([
        ...cleanupTargets,
        ...forcePlan.targets.map((target): LiveCleanupTarget => ({
          pluginId: target.identity.pluginId!,
          pluginName: target.identity.pluginName,
          sourceId: target.identity.sourceId!,
          sourceIdentity: target.identity.sourceIdentity!,
          platform: target.identity.platform,
          scope: target.identity.scope,
        })),
      ].map((target) => [`${target.pluginId}\0${target.platform}\0${target.scope}`, target] as const)).values()];
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
      const unresolvedTargets = requestedTargets.filter((requested) =>
        !forcePlan.targets.some((target) =>
          target.identity.pluginId === requested.pluginId
          && target.identity.platform === requested.platform
          && target.identity.scope === requested.scope)
        && cleanupInventory!.errors.some((error) => error.relevance.global || (
          (error.relevance.sourceId === undefined || error.relevance.sourceId === requested.sourceId)
          && (error.relevance.pluginName === undefined || error.relevance.pluginName === requested.pluginName)
          && (error.relevance.platform === undefined || error.relevance.platform === requested.platform)
          && (error.relevance.scope === undefined || error.relevance.scope === requested.scope)
        )));
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
      const forceEvidence = forceCleanupTargets.map((target) => forcePlan.evidence.find((candidate) =>
        candidate.pluginId === target.pluginId
        && candidate.platform === target.platform
        && candidate.scope === target.scope)
        ?? intentOnlyOfflineCleanupEvidence(target));
      const operationPlan = createOfflineCleanupOperationPlan(forceEvidence, { scope: options.commandOptions.scope, view: cleanupRequirements! }, cleanupInventoryWarnings(cleanupInventory!, forceCleanupTargets));
      if (options.runtime?.expectedPlanFingerprint) {
        assertOperationPlanFingerprint(options.runtime.expectedPlanFingerprint, operationPlan);
      }
      if (options.runtime?.previewOperationPlan) {
        return {
          ...await previewOfflineOwnedComponents({
            targets: forceCleanupTargets,
            evidence: forceEvidence,
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
        const result = await (options.runtime?.executeCleanupOperation ?? executeRebuildOperation)({
          command: 'cleanup', target, driver: pathOnlyDriver,
        });
        if (cleanupLiveTargets.some((liveTarget) =>
          liveTarget.marketplaceIdentityUnresolved
          && liveTarget.pluginId === result.target.pluginId
          && liveTarget.platform === result.target.platform
          && liveTarget.scope === result.target.scope)) {
          result.residual.push('nativeMarketplaceIdentityUnresolved');
        }
        const targetEvidence = forceEvidence.find((candidate) =>
          candidate.pluginId === target.identity.pluginId
          && candidate.platform === target.identity.platform
          && candidate.scope === target.identity.scope);
        const targetDescriptor = forceCleanupTargets.find((candidate) =>
          candidate.pluginId === target.identity.pluginId
          && candidate.platform === target.identity.platform
          && candidate.scope === target.identity.scope)!;
        const unresolvedErrors = cleanupInventoryErrorsForTarget(
          cleanupInventory!,
          targetDescriptor,
        ).filter((error) => !cleanupActionCoversLocation(
          targetEvidence,
          error.location,
          runtimeEnv,
          options.commandOptions.cwd,
        ));
        if (unresolvedErrors.length > 0) {
          const message = 'stateInventoryResidual: Some weak state could not be verified after force cleanup.';
          result.residual = [...new Set([
            ...result.residual,
            ...unresolvedErrors.map((error) => error.location),
          ])];
          if (result.status === 'succeeded') {
            return {
              ...result,
              status: 'failed' as const,
              failures: [...result.failures, { phase: 'cleanup.owned' as const, message }],
              error: { phase: 'cleanup.owned' as const, message },
            };
          }
        }
        return result;
      }));
      const unresolvedResults = unresolvedTargets.map((target) => failedResult(
        'cleanup',
        { ...target, pluginVersion: '0.0.0', cwd: options.commandOptions.cwd },
        'forceCleanupPathUnavailable: No exact exclusive output is available from live evidence or the local Active shallow plan. Restore the local Active bundle, then retry cleanup --force, or inspect and remove the exact output manually.',
      ));
      const intentOnlyResults = forceCleanupTargets
        .filter((target) => !forcePlan.targets.some((forceTarget) =>
          forceTarget.identity.pluginId === target.pluginId
          && forceTarget.identity.platform === target.platform
          && forceTarget.identity.scope === target.scope)
          && !unresolvedTargets.some((unresolved) =>
            unresolved.pluginId === target.pluginId
            && unresolved.platform === target.platform
            && unresolved.scope === target.scope))
        .map(cleanupIntentResult);
      const allResults = [...forceResults, ...unresolvedResults, ...intentOnlyResults];
      const warnings = cleanupLiveTargets.flatMap((target) =>
        target.marketplaceIdentityUnresolved
          ? [`nativeMarketplaceIdentityUnresolved: Preserved ambiguous native registration for ${target.pluginId} on ${target.platform}/${target.scope}.`]
          : []);
      return leaseSafeRebuildResult({
        platforms: [...new Set(allResults.map((entry) => entry.target.platform))],
        plugins: allResults.filter((entry) => entry.status === 'succeeded')
          .map((entry) => entry.target.pluginName),
        warnings,
        rebuildResults: allResults,
        targetResults: allResults.map(toTargetResult),
        overallState: allResults.every((entry) => entry.status === 'succeeded')
          ? 'succeeded'
          : allResults.some((entry) => entry.status === 'succeeded'
              || entry.actions.some((action) => action.status === 'succeeded'))
            ? 'partial' : 'failed',
        receiptTargets: allResults.map((entry) => entry.target),
        offlineCleanupPlans: forceEvidence,
        operationPlan,
      });
    }
    if (cleanupTargets.length === 0) {
      const result = mergeRebuildCommandResults([]);
      const operationPlan = createOfflineCleanupOperationPlan([], { scope: options.commandOptions.scope, view: cleanupRequirements! }, [...cleanupInventoryWarnings(cleanupInventory!, []), ...cleanupUnavailableWarnings]);
      if (options.runtime?.expectedPlanFingerprint) {
        assertOperationPlanFingerprint(options.runtime.expectedPlanFingerprint, operationPlan);
      }
      result.operationPlan = operationPlan;
      result.overallState = cleanupSelectionErrors.length > 0 || legacyLiveTargets.length > 0
        ? 'failed'
        : 'succeeded';
      result.warnings.push(...cleanupSelectionErrors.map((error) =>
        `stateInventoryResidual: ${error.kind}: ${error.message}`));
      result.warnings.push(...legacyLiveTargets.map((target) =>
        `legacyStateUnsupported: legacy live runtime state exists for ${target.pluginName}:${target.platform}/${target.scope}.`));
      result.warnings.push(...cleanupUnavailableWarnings);
      if (malformedSelectedConfigPreserved) {
        result.warnings.push(MALFORMED_CONFIG_PRESERVED_WARNING);
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
    evidence = cleanupTargets.map((target) => evidence.find((candidate) =>
      candidate.pluginId === target.pluginId
      && candidate.platform === target.platform
      && candidate.scope === target.scope)
      ?? intentOnlyOfflineCleanupEvidence(target));
    const operationPlan = createOfflineCleanupOperationPlan(evidence, { scope: options.commandOptions.scope, view: cleanupRequirements! }, [...cleanupInventoryWarnings(cleanupInventory!, cleanupTargets), ...cleanupUnavailableWarnings]);
    if (options.runtime?.expectedPlanFingerprint) {
      assertOperationPlanFingerprint(
        options.runtime.expectedPlanFingerprint,
        operationPlan,
      );
    }
    if (options.runtime?.previewOperationPlan) {
      const previewResult = await previewOfflineOwnedComponents({
        targets: cleanupTargets,
        evidence,
        cwd: options.commandOptions.cwd,
        env: runtimeEnv,
        onPreviewStage: options.runtime.onPreviewStage,
      });
      previewResult.operationPlan = operationPlan;
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
      executeCleanupOperation: options.runtime?.executeCleanupOperation,
    });
    const liveKeys = new Set(cleanupLiveTargets.map((target) =>
      `${target.pluginId}\0${target.platform}\0${target.scope}`));
    const intentOnlyResults = cleanupTargets
      .filter((target) => !liveKeys.has(`${target.pluginId}\0${target.platform}\0${target.scope}`))
      .map((target) => {
        const inventoryError = cleanupInventory!.errors.find((error) =>
          error.relevance.global || (
            (error.relevance.sourceId === undefined || error.relevance.sourceId === target.sourceId)
            && (error.relevance.pluginName === undefined || error.relevance.pluginName === target.pluginName)
            && (error.relevance.platform === undefined || error.relevance.platform === target.platform)
            && (error.relevance.scope === undefined || error.relevance.scope === target.scope)
          ));
        return inventoryError
          ? failedResult(
              'cleanup',
              { ...cleanupIntentResult(target).target, cwd: options.commandOptions.cwd },
              `stateInventoryResidual: ${inventoryError.message}`,
            )
          : cleanupIntentResult(target);
      });
    cleanupResult.rebuildResults.push(...intentOnlyResults);
    cleanupResult.targetResults.push(...intentOnlyResults.map(toTargetResult));
    cleanupResult.receiptTargets.push(...intentOnlyResults.map((result) => result.target));
    cleanupResult.platforms = [...new Set([...cleanupResult.platforms, ...intentOnlyResults.map((result) => result.target.platform)])];
    cleanupResult.plugins = [...new Set([...cleanupResult.plugins, ...intentOnlyResults.map((result) => result.target.pluginName)])];
    cleanupResult.operationPlan = operationPlan;
    if (intentOnlyResults.some((result) => result.status === 'failed')) {
      cleanupResult.overallState = 'failed';
    }
    if (malformedSelectedConfigPreserved) {
      cleanupResult.warnings.push(MALFORMED_CONFIG_PRESERVED_WARNING);
    }
    cleanupResult.warnings.push(...cleanupUnavailableWarnings);
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
      const requestedIds = new Set(selectedEntries.map((entry) => entry.pluginId));
      if (executionInput.selectedTargets.some((target) => !requestedIds.has(target.pluginId))) {
        throw new Error('nativeExecutionTargetOutsideRequest: selected target must match a requested plugin.');
      }
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
      const codexDemandRootsFor = (entry: (typeof available)[number]) =>
        requirements.roots.filter((root) => {
          if (!root.platforms.includes('codex')) return false;
          const rootEntry = availableEntries.find((candidate) => candidate.pluginId === root.pluginId);
          if (!rootEntry || rootEntry.source.sourceId !== entry.source.sourceId) return false;
          try {
            return entryClosure([rootEntry]).some((candidate) => candidate.pluginId === entry.pluginId);
          } catch {
            return rootEntry.pluginId === entry.pluginId;
          }
        });
      const selectedCodexRoot = (pluginId: string) => executionInput.selectedTargets.some((target) =>
        target.pluginId === pluginId && target.platform === 'codex');
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
        const selectionTargets = executionInput.selectedTargets;
        const selectedTaskPlatforms = selectionTargets
          ? [...new Set(selectionTargets.map((target) => target.platform))]
          : selectedPlatforms(options.commandOptions.platform);
        for (const platform of selectedTaskPlatforms) {
          const platformRoots = selectionTargets
            ? selected.filter((entry) => selectionTargets.some((target) =>
                target.pluginId === entry.pluginId && target.platform === platform))
            : options.commandOptions.platform === 'both'
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
      const rawExecutionSelections: Array<{
        entry: (typeof available)[number];
        platform: PlatformName;
        requestedScope?: Scope;
        requestedMethod?: 'sync' | 'reinstall';
      }> = executionInput.selectedTargets.flatMap((target) => {
            const root = selected.find((entry) => entry.pluginId === target.pluginId);
            if (!root) return [];
            return (dependencyEnabled ? resolveClosureEntries([root]) : [root]).map((entry) => ({
              entry, platform: target.platform,
              ...(entry.pluginId === root.pluginId ? { requestedScope: target.scope } : {}),
              requestedMethod: options.taskTargets?.find((candidate) =>
                candidate.pluginId === entry.pluginId
                && candidate.platform === target.platform)?.method
                ?? options.taskRepairTargets?.find((candidate) =>
                  candidate.pluginId === entry.pluginId
                  && candidate.platform === target.platform)?.method,
            }));
          });
      const normalizedExecutionSelections = [...new Map(rawExecutionSelections.map((selection) => [[
        selection.entry.pluginId,
        selection.entry.source.sourceIdentity,
        selection.platform,
      ].join('\0'), selection] as const)).values()];
      if (dependencyEnabled) {
        const ordered = new Map<string, typeof normalizedExecutionSelections[number]>();
        for (const [platform, closure] of closureEntriesByPlatform) {
          for (const entry of closure) {
            const selection = normalizedExecutionSelections.find((candidate) =>
              candidate.entry.pluginId === entry.pluginId && candidate.platform === platform);
            if (selection) ordered.set(`${entry.pluginId}\0${platform}`, selection);
          }
        }
        normalizedExecutionSelections.splice(0, normalizedExecutionSelections.length, ...ordered.values());
      }
      const taskSelectionMethods = new Map<string, 'sync' | 'reinstall'>();
      for (const selection of normalizedExecutionSelections) {
        if (!selection.requestedMethod) continue;
        const key = [
          selection.entry.pluginId,
          selection.platform,
          selection.requestedScope ?? '',
        ].join('\0');
        const current = taskSelectionMethods.get(key);
        if (current && current !== selection.requestedMethod) {
          throw new Error(
            `rebuildTaskMethodConflict: ${selection.entry.pluginId}#${selection.platform}`,
          );
        }
        taskSelectionMethods.set(key, selection.requestedMethod);
      }
      let executionSelections = normalizedExecutionSelections;
      type ExecutionSelection = (typeof executionSelections)[number];
      const planTargetFor = (
        plan: ReconcileOperationPlan,
        selection: ExecutionSelection,
      ) => plan.targets.find((target) =>
        target.pluginId === selection.entry.pluginId
        && target.platform === selection.platform
        && (selection.requestedScope === undefined
          || target.requestedScope === selection.requestedScope));
      const executionKey = (
        selection: ExecutionSelection,
        plan: ReconcileOperationPlan,
      ): string => {
        const target = planTargetFor(plan, selection);
        return [
          selection.entry.pluginId,
          selection.platform,
          target?.resolvedScope ?? selection.requestedScope ?? options.commandOptions.scope,
        ].join('\0');
      };
      const planExecutionKey = (target: ReconcileOperationPlan['targets'][number]): string => [
        target.pluginId,
        target.platform,
        target.requestedScope ?? target.resolvedScope,
      ].join('\0');
      const dependencyTargetFor = (
        plan: ReconcileOperationPlan,
        consumer: ReconcileOperationPlan['targets'][number],
        dependencyPluginId: string,
      ) => {
        const candidates = plan.targets.filter((target) =>
          target.pluginId === dependencyPluginId
          && target.platform === consumer.platform);
        const consumerScope = consumer.requestedScope ?? consumer.resolvedScope;
        return candidates.find((target) => (target.requiredByTargets ?? []).some((requiredBy) =>
          requiredBy.pluginId === consumer.pluginId
          && requiredBy.platform === consumer.platform
          && requiredBy.scope === consumerScope))
          ?? (candidates.length === 1 ? candidates[0] : undefined);
      };
      const preflightTargets = executionSelections.map(({ entry, platform, requestedScope }) => ({
        pluginId: entry.pluginId,
        pluginName: entry.plugin.manifest.name,
        sourceId: entry.source.sourceId,
        sourceIdentity: entry.source.sourceIdentity,
        pluginVersion: entry.plugin.manifest.version,
        platform,
        scope: requestedScope ?? options.commandOptions.scope,
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
      const requirements = executionInput.requirements;
      const commandProjectKey = executionInput.context.projectRoot ?? executionInput.context.executionCwd;
      const codexScopePathsAlias = options.commandOptions.scope === 'project' && codexProjectConfigAliasesUserHome(
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
      const projectCodexConfig = options.commandOptions.scope === 'project'
        ? await readCodexConfigFile(
            resolveCodexPaths(options.commandOptions.cwd, 'project', runtimeEnv).configTomlPath,
          )
        : undefined;
      for (const { entry, platform } of executionSelections) {
        if (platform !== 'codex') continue;
        const marketplaceName = marketplaceNameFor(
          entry,
          platform,
          options.commandOptions.scope,
        );
        const codexPluginId = `${entry.plugin.manifest.name}@${marketplaceName}`;
        const requiredScope = options.commandOptions.scope === 'project'
          || (projectCodexConfig !== undefined
            && Object.hasOwn(projectCodexConfig.snapshot.plugins, codexPluginId))
          ? 'both'
          : 'user';
        if (requiredScope === 'both'
          || !codexObservationScopeByMarketplace.has(marketplaceName)) {
          codexObservationScopeByMarketplace.set(marketplaceName, requiredScope);
        }
      }
      const executionContext: RebuildExecutionContext = {
        signal: options.runtime?.signal,
        env: runtimeEnv,
        nativeCliRunner: options.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
        reporter: options.runtime?.reporter ?? createNoopReporter(),
        debugLogger: options.runtime?.debugLogger ?? createNoopDebugLogger(),
        expectedCatalogConfigDigest: catalog.configDigest,
        codexObservationSession: options.runtime?.codexObservationSession,
        codexObservationScopeByMarketplace,
        preApplyExecutionCache: options.runtime?.preApplyExecutionCache,
      };
      const inspection = createRebuildIntegration({
        context: executionContext,
        scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
      });
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
        planOptions?: { skipConfigValidation?: boolean },
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
          const user = await readCodexConfigFile(resolveCodexPaths(
            options.commandOptions.cwd, 'user', runtimeEnv,
          ).configTomlPath);
          const project = options.commandOptions.scope === 'project'
            ? await readCodexConfigFile(resolveCodexPaths(
                options.commandOptions.cwd, 'project', runtimeEnv,
              ).configTomlPath)
            : { content: '', snapshot: parseCodexConfig('') };
          return { user, project };
        };
        let placementCodexConfigs: ReturnType<typeof loadPlacementCodexConfigs> | undefined;
        const readPlacementCodexConfigs = () => {
          placementCodexConfigs ??= loadPlacementCodexConfigs();
          return placementCodexConfigs;
        };
        for (const [order, selection] of executionSelections.entries()) {
          const { entry, platform } = selection;
          const relation = executionInput.selectedTargets.some((target) =>
            target.pluginId === entry.pluginId && target.platform === platform)
            ? 'requested' as const : 'dependency' as const;
          const requestedScope = selection.requestedScope ?? options.commandOptions.scope;
          const requestedMethod = selection.requestedMethod ?? options.command;
          let resolvedScope = requestedScope;
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
              command: requestedMethod,
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
            options.commandOptions.scope === 'user'
              ? Promise.resolve({ state: 'partial' as const, components: [], errors: [] })
              : platform === 'codex' && codexScopePathsAlias && resolvedScope === 'user'
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
            requestedScope,
          );
          let otherPlacementState = placementState(otherInspection, otherScope);
          if (surface?.classification === 'native'
            && requestedPlacementState === 'present'
            && otherPlacementState === 'present') {
            otherPlacementState = 'absent';
          }
          actualStates.set(
            `${entry.pluginId}\0${platform}\0${requestedScope}`,
            requestedPlacementState,
          );
          actualStates.set(`${entry.pluginId}\0${platform}\0${otherScope}`, otherPlacementState);
          const allowedScopes: Scope[] = platform === 'codex'
            ? [
                ...(surface?.ok ? ['user' as const] : []),
                ...(surface?.ok && !codexScopePathsAlias ? ['project' as const] : []),
              ]
            : ['project', 'user'];
          if (allowedScopes.length === 0) allowedScopes.push(requestedScope);
          if (!placementNodes.some((node) =>
            node.pluginId === entry.pluginId && node.platform === platform)) {
            placementNodes.push({
              pluginId: entry.pluginId,
              pluginName: entry.plugin.manifest.name,
              platform,
              relation,
              depth: order,
              allowedScopes,
            });
          }
          let state: 'absent' | 'present' | 'partial' | 'error' = requestedPlacementState;
          let action: 'install' | 'reinstall' | 'keep' | 'block' = relation === 'requested'
            ? options.command === 'cleanup' || options.command === 'uninstall'
              ? 'keep'
              : requestedMethod === 'reinstall' ? 'reinstall' : 'install'
            : requestedMethod === 'reinstall' ? 'reinstall' : 'install';
          let errorCode: string | undefined;
          if (!dependencyEnabled && platform === 'codex'
            && relation === 'requested'
            && codexDemandRootsFor(entry).some((root) => !selectedCodexRoot(root.pluginId))) {
            action = 'block';
            errorCode = 'dependencyStillRequired';
          } else if (dependencyEnabled
            && platform === 'codex'
            && relation === 'requested'
            && surface?.scopeOverlap === 'aw-owned-conflict'
            && options.command !== 'cleanup'
            && options.command !== 'uninstall'
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
                && requestedMethod !== 'reinstall'
                && options.command !== 'cleanup'))) {
            action = 'block';
            errorCode = 'dependencyNotReady';
          }
          if (relation === 'dependency'
            && requestedScope === 'user'
            && otherPlacementState === 'error') {
            action = 'block';
            errorCode = 'dependencyNotReady';
          }
          const dependencyScopeOverride = relation === 'dependency'
            ? [
                ...((options.commandOptions as InstallCommandOptions).dependencyScopeOverrides ?? []),
                ...requirements.dependencyScopeOverrides,
              ].find((override) => override.pluginId === entry.pluginId
                && (override.platform === undefined || override.platform === platform))
            : undefined;
          if (dependencyEnabled && relation === 'dependency' && platform === 'codex'
            && surface?.scopeOverlap === 'aw-owned-conflict'
            && (dependencyScopeOverride?.scope ?? requestedScope) === requestedScope
            && !(requestedScope === 'project'
              && dependencyScopeOverride?.scope === 'project'
              && otherPlacementState === 'present')
            && otherInspection.components.some((component) => component.state !== 'absent'
              && component.component.kind !== 'native-plugin'
              && !component.component.identity.artifactKey.startsWith('activation-')
              && !component.component.identity.artifactKey.startsWith('marketplace-'))) {
            action = 'block';
            errorCode = 'codexExtensionScopeConflict';
          }
          const resolvedInspection = resolvedScope === requestedScope
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
          const hasInvalidExclusiveOwner = requestedMethod === 'reinstall'
            && invalidOwnerComponents.some((component) =>
              (component.component.kind === 'skill-directory'
                || component.component.kind === 'owned-text-file')
              && component.collision?.reason === 'unownedContent');
          state = resolvedScope === requestedScope
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
          if (!planOptions?.skipConfigValidation
            && entry.plugin.manifest.config?.fields
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
          if (errorCode) blockingTargets.set(
            `${entry.pluginId}\0${platform}\0${requestedScope}`,
            errorCode,
          );
          targets.push({
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            platform,
            requestedScope,
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
            roots: executionInput.selectedTargets.map((target) => ({
              pluginId: target.pluginId,
              platform: target.platform,
              scope: target.scope,
            })),
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
              state: requirements,
              explicit: (options.commandOptions as InstallCommandOptions)
                .dependencyScopeOverrides ?? [],
              nodes: placementNodes,
              ignoredPersistedRootIds: selectedIds,
            }),
          });
          if (options.commandOptions.scope === 'user'
            && placement.targets.some((target) => target.resolvedScope === 'project')) {
            throw new Error('nativeUserProjectPlacementUnsupported: User execution cannot use project output.');
          }
          for (const repairTarget of options.taskRepairTargets ?? []) {
            if (!placement.targets.some((target) =>
              target.pluginId === repairTarget.pluginId
              && target.platform === repairTarget.platform)) {
              throw new Error(
                `rebuildTaskRepairTargetOutsideClosure: ${repairTarget.pluginId}`
                + `#${repairTarget.platform}#${repairTarget.scope}`,
              );
            }
          }
          return createReconcileOperationPlan({
            placement,
            actual: placement.targets.map((target) => {
              const targetScope = target.requestedScope ?? target.resolvedScope;
              const inspectedScope = target.requestedScope ?? options.commandOptions.scope;
              const prior = targets.find((candidate) =>
                candidate.pluginId === target.pluginId
                && candidate.platform === target.platform
                && candidate.requestedScope === inspectedScope)!;
              const state = actualStates.get(
                `${target.pluginId}\0${target.platform}\0${target.resolvedScope}`,
              ) ?? prior.state;
              const errorCode = blockingTargets.get(
                `${target.pluginId}\0${target.platform}\0${targetScope}`,
              )
                ?? prior.errorCode;
              const requestedMethod = options.taskTargets?.find((candidate) =>
                candidate.pluginId === target.pluginId
                && candidate.platform === target.platform
                && candidate.scope === targetScope)?.method
                ?? options.taskRepairTargets?.find((candidate) =>
                  candidate.pluginId === target.pluginId
                  && candidate.platform === target.platform)?.method
                ?? options.command;
              const action = errorCode
                ? 'block' as const
                : options.command === 'cleanup' || options.command === 'uninstall'
                  ? 'keep' as const
                  : target.relation === 'dependency' && state === 'present'
                      ? 'keep' as const
                      : state === 'partial' || requestedMethod === 'reinstall'
                        ? 'reinstall' as const
                        : 'install' as const;
              return {
                ...prior,
                scope: targetScope,
                state,
                action,
                ...(errorCode ? { errorCode } : {}),
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
      const isHealthyWiderDependency = (target: ReconcileOperationPlan['targets'][number]) =>
        target.relation === 'dependency'
        && target.resolvedScope !== options.commandOptions.scope
        && target.action === 'keep';
      const createCodexPlans = async (
        plan: ReconcileOperationPlan,
        activationSupport: 'observed' | 'assumed' = 'observed',
        codexManager?: CodexManager,
      ): Promise<CodexReconcilePlan[]> => {
        const codexTargets = plan.targets.filter((target) => target.platform === 'codex');
        const currentScope = options.commandOptions.scope;
        const reconciledCodexTargetsByPlugin = new Map<
          string,
          ReconcileOperationPlan['targets'][number]
        >();
        for (const target of codexTargets) {
          if (!reconciledCodexTargetsByPlugin.has(target.pluginId)
            || target.resolvedScope === 'user') {
            reconciledCodexTargetsByPlugin.set(target.pluginId, target);
          }
        }
        const reconciledCodexTargets = [...reconciledCodexTargetsByPlugin.values()];
        if (reconciledCodexTargets.length === 0) return [];
        const desiredScopesForEntry = (entry: (typeof available)[number]): Scope[] => {
          const roots = codexDemandRootsFor(entry);
          const protectedRoot = roots.some((root) => !selectedCodexRoot(root.pluginId));
          const selectedForRemoval = selectedCodexRoot(entry.pluginId);
          if ((options.command === 'cleanup' || options.command === 'uninstall')
            && (roots.length === 0 || (selectedForRemoval && !protectedRoot))) return [];
          const planned = plan.targets.find((target) =>
            target.pluginId === entry.pluginId && target.platform === 'codex');
          return [planned?.resolvedScope ?? currentScope];
        };
        const intentScopesForEntry = (entry: (typeof available)[number]): Scope[] =>
          codexDemandRootsFor(entry).length > 0 ? [currentScope] : [];
        const inspectBothScopes = currentScope === 'project';
        const userConfig = await readCodexConfigFile(resolveCodexPaths(
          options.commandOptions.cwd, 'user', runtimeEnv,
        ).configTomlPath);
        const projectConfig = currentScope === 'project'
          ? await readCodexConfigFile(resolveCodexPaths(
              options.commandOptions.cwd, 'project', runtimeEnv,
            ).configTomlPath)
          : { content: '', snapshot: parseCodexConfig('') };
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
            executionScopes: [...new Set(codexTargets.filter((target) =>
              target.pluginId === entry.pluginId).map((target) => target.resolvedScope))],
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
          catalogClosure,
          liveEvidence,
          activationSupport,
        });
        return [codexPlan];
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
          operationScopedNativePhases: true,
        });
        const preparedTargets = new Map<string, PreparedRebuildTarget>();
        const preparedTargetErrors = new Map<string, unknown>();
        const collisionSelections: DesiredArtifactSelection[] = [];
        for (const selection of executionSelections) {
          const { entry, platform } = selection;
          const planned = planTargetFor(plan, selection)!;
          const key = executionKey(selection, plan);
          if (planned.action === 'block') continue;
          const buildCommand: RebuildCommand = planned.relation === 'dependency'
            && (planned.action === 'install' || planned.action === 'reinstall')
            ? planned.action
            : selection.requestedMethod ?? options.command;
          const plannedNative = platform === 'codex'
            ? codexPlans.flatMap((codexPlan) => codexPlan.sharedNativeActions).find((action) =>
                action.pluginId === entry.pluginId)
            : undefined;
          const codexNativeStillDesired = platform === 'codex'
            && codexPlans.some((codexPlan) => codexPlan.desiredTargets.some((target) =>
              target.pluginId === entry.pluginId && target.scopes.length > 0));
          const preserveSharedNative = plannedNative?.action === 'reuse'
            || (plannedNative?.action === 'none' && codexNativeStillDesired)
            || options.command === 'cleanup'
            || options.command === 'uninstall';
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
                ...(platform === 'codex'
                  && (buildCommand === 'cleanup' || buildCommand === 'uninstall')
                  ? { includeNativeCleanupCandidate: false }
                  : {}),
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
              target.codexNativeSensitivePreflightRequired = preserveSharedNative
                && hasActivationMutation;
              if (!writesSharedNative) {
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
            preparedTargets.set(key, {
              target,
            });
            if (runTargetHook) {
              await rebuildCommandTestHooks?.afterTargetBuilt?.({
                command: selection.requestedMethod ?? options.command,
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
            preparedTargetErrors.set(key, error);
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
          for (const selection of executionSelections) {
            const { entry } = selection;
            const planned = planTargetFor(plan, selection)!;
            if (!entry.plugin.manifest.config?.fields
              || planned.action === 'block'
              || !preparedTargets.has(executionKey(selection, plan))) continue;
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
      if (options.runtime?.resolvePreApplyAuthorization) {
        const authorizationPlan = await measureCommandPerformanceStage(
          options.runtime,
          'dependency.plan',
          () => createPlan(stateInventory, undefined, { skipConfigValidation: true }),
        );
        assertWriteInventoryComplete(
          stateInventory,
          exactOwnedTextTargets(authorizationPlan),
          exactSkillMarkerTargets(authorizationPlan),
        );
        const preview = mergeRebuildCommandResults([]);
        preview.dependencyPlan = authorizationPlan;
        preview.preApplyAuthorization = executionSelections.flatMap((selection) => {
          const { entry, platform } = selection;
          const planned = planTargetFor(authorizationPlan, selection);
          if (!planned || planned.action === 'block' || isHealthyWiderDependency(planned)
            || !entry.plugin.manifest.scripts?.preApply) {
            return [];
          }
          const relation = planned.relation === 'requested'
            ? 'requested' as const
            : planned.requiredBy.some((pluginId) => selectedIds.has(pluginId))
              ? 'direct' as const
              : 'transitive' as const;
          return [{
            pluginId: entry.pluginId,
            pluginName: entry.plugin.manifest.name,
            sourceId: entry.source.sourceId,
            sourceIdentity: entry.source.sourceIdentity,
            platform,
            scope: planned.resolvedScope,
            relation,
          }];
        });
        return preview;
      }
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
        preview.nativeFootprints = preparedNativeFootprints([...previewPreparation.preparedTargets.values()].map((entry) => entry.target));
        preview.operationPlan = createRebuildOperationPlan({
          dependencyPlan: initialPlan,
          codexPlans: initialCodexPlans,
          targetActions: previewPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          requirements,
          scope: options.commandOptions.scope,
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
      for (const { entry, platform, requestedScope } of executionSelections.filter((selection) =>
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
              scope: requestedScope ?? options.commandOptions.scope,
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
        const lifecycleCommand = options.command === 'install'
          || options.command === 'sync'
          || options.command === 'reinstall';
        const preApplyRequired = lifecycleCommand && executionSelections.some(({ entry, platform }) =>
          entry.plugin.manifest.scripts?.preApply !== undefined
          && lockedPlan.targets.some((target) =>
            target.pluginId === entry.pluginId
            && target.platform === platform
            && target.action !== 'block'
            && !isHealthyWiderDependency(target)));
        if (preApplyRequired
          && options.commandOptions.yes !== true
          && options.runtime?.preApplyConfirmed !== true) {
          throw namespacedPreflightError(
            'preApplyAuthorizationRequired: Running plugin preApply requires --yes or an accepted Review.',
            preflightTargets,
          );
        }
        const provisionalLockedCodexPlans = await createCodexPlans(lockedPlan);
        const codexManagerRequired = provisionalLockedCodexPlans.some((plan) =>
          plan.sharedNativeActions.some((action) =>
            action.action === 'install'
            || action.action === 'replace'
            || action.action === 'repair'));
        let lockedCodexPlans = provisionalLockedCodexPlans;
        let lockedPreparation = await prepareRenderedTargets(lockedPlan, lockedCodexPlans, true);
        let lockedOperationPlan = createRebuildOperationPlan({
          dependencyPlan: lockedPlan,
          codexPlans: lockedCodexPlans,
          targetActions: lockedPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          requirements,
          scope: options.commandOptions.scope,
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
          && lifecycleCommand) {
          const sharedNativeImpact = lockedCodexPlans.some((plan) =>
            plan.review.requiresConfirmation);
          if (sharedNativeImpact) {
            throw namespacedPreflightError(
              'sharedNativeImpactAuthorizationRequired: Replacing or force-reinstalling shared Codex native state requires --yes.',
              preflightTargets,
            );
          }
        }
        const operationPreparations = new Map<string, PreparedRebuildOperation>();
        const operationPreparationFailures = new Map<string, RebuildResult>();
        const executionCommandFor = (
          selection: ExecutionSelection,
        ): 'install' | 'sync' | 'reinstall' | 'cleanup' | 'uninstall' => {
          const planned = planTargetFor(lockedPlan, selection)!;
          if (planned.relation === 'dependency'
            && (planned.action === 'install' || planned.action === 'reinstall')) {
            return planned.action;
          }
          return selection.requestedMethod ?? options.command;
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
          for (const selection of executionSelections) {
            const { entry, platform } = selection;
            const key = executionKey(selection, lockedPlan);
            const planned = planTargetFor(lockedPlan, selection)!;
            if (preparationOptions.eligibleKeys
              && !preparationOptions.eligibleKeys.has(key)) {
              states.set(key, isHealthyWiderDependency(planned) ? 'ready' : 'skipped');
              continue;
            }
            const directDependencyFailed = (entry.plugin.manifest.dependencies ?? []).some(
              (pluginName) => {
                const dependencyPluginId = formatPluginId({
                  sourceId: entry.source.sourceId,
                  pluginName,
                });
                const consumer = planTargetFor(lockedPlan, selection)!;
                const dependency = dependencyTargetFor(
                  lockedPlan,
                  consumer,
                  dependencyPluginId,
                );
                const state = dependency ? states.get(planExecutionKey(dependency)) : undefined;
                return state === 'failed' || state === 'skipped';
              },
            );
            if (directDependencyFailed || planned.action === 'block') {
              states.set(key, 'skipped');
              continue;
            }
            if (isHealthyWiderDependency(planned)) {
              states.set(key, 'ready');
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
            const executionCommand = executionCommandFor(selection);
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
          dependencyPlan: lockedPlan,
          codexPlans: lockedCodexPlans,
          targetActions: lockedPreparation.targetActions,
          catalogSources: catalog.sources.flatMap((source) =>
            source.resolution ? [source.resolution] : []),
          requirements,
          scope: options.commandOptions.scope,
          configDigests: lockedPreparation.configDigests,
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
        const originalUserActivations = options.commandOptions.scope === 'project'
          && lockedCodexPlans.length > 0
          ? new Map(Object.entries((await readCodexConfigFile(resolveCodexPaths(
              options.commandOptions.cwd, 'user', runtimeEnv,
            ).configTomlPath)).snapshot.plugins)
              .map(([pluginId, activation]) => [pluginId, activation.enabled === true]))
          : undefined;
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
            scope: options.commandOptions.scope,
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
                const plannedDependency = planTargetFor(lockedPlan, dependencyTarget);
                const plannedConsumerTarget = planTargetFor(lockedPlan, plannedConsumer);
                if (!plannedDependency || !plannedConsumerTarget) continue;
                const dependencyExecutionKey = planExecutionKey(plannedDependency);
                const required = removalRequiredConsumers.get(dependencyExecutionKey) ?? new Set<string>();
                required.add(planExecutionKey(plannedConsumerTarget));
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
      for (const selection of executionSelections) {
        const { entry, platform } = selection;
        const planned = planTargetFor(lockedPlan, selection)!;
        const key = executionKey(selection, lockedPlan);
        const requestedMethod = selection.requestedMethod ?? options.command;
        const directDependencyIds = (entry.plugin.manifest.dependencies ?? []).map((pluginName) =>
          formatPluginId({ sourceId: entry.source.sourceId, pluginName }));
        const failedDependency = directDependencyIds.find((pluginId) => {
          const dependency = dependencyTargetFor(lockedPlan, planned, pluginId);
          const state = dependency
            ? dependencyStates.get(planExecutionKey(dependency))
            : undefined;
          return state === 'failed' || state === 'skipped';
        });
        const failedConsumer = [...(removalRequiredConsumers.get(key) ?? [])]
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
              ? `${entry.pluginId} has damaged or missing exclusive owner evidence. Run aw cleanup ${entry.pluginId} --target ${recoveryTarget(platform)} --scope ${planned.resolvedScope} --force, then run aw reinstall ${entry.pluginId} --target ${recoveryTarget(platform)} --scope ${planned.resolvedScope}.`
            : code === 'artifactCollision'
              ? `${entry.pluginId} has foreign-owned output. Remove or relocate it, then run cleanup and reinstall.`
            : code === 'dependencyNotReady'
                ? `${entry.pluginId} live state is unreadable. Run cleanup, then reinstall.`
                : code === 'dependencyStillRequired'
                  ? `${entry.pluginId} remains required by an unselected declared root.`
                : `${entry.pluginId} dependency preflight is blocked.`}`;
          const result = failedResult(requestedMethod, identity, message);
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
                  `run aw cleanup ${entry.pluginId} --target ${recoveryTarget(platform)} --scope ${planned.resolvedScope} --force`,
                  `then run aw reinstall ${entry.pluginId} --target ${recoveryTarget(platform)} --scope ${planned.resolvedScope}`,
                ],
              } : {}),
            }],
            overallState: 'failed',
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(key,
            failedDependency || failedConsumer ? 'skipped' : 'failed');
          continue;
        }
        if (isHealthyWiderDependency(planned)) {
          results.push({
            platforms: [platform], plugins: [identity.pluginName], warnings: [], rebuildResults: [],
            targetResults: [{ target: identity, action: 'keep', state: 'completed' }],
            overallState: 'succeeded',
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(key, 'kept');
          continue;
        }
        const operationPreparationFailure = operationPreparationFailures.get(key);
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
          dependencyStates.set(key, 'failed');
          continue;
        }
        if (reconcileActivationOnly) {
          const preparedError = preparedTargetErrors.get(key);
          if (preparedError) {
            const message = preparedError instanceof Error
              ? preparedError.message
              : String(preparedError);
            const result = failedResult(requestedMethod, identity, message);
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
            dependencyStates.set(key, 'failed');
            continue;
          }
          const actions = operationPreparations.get(key)?.actions
            ?? [];
          const preparedTarget = preparedTargets.get(key)?.target;
          let result: RebuildResult | undefined;
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
              result = await executeRebuildComponentCleanup({
                command: requestedMethod,
                target: preparedTarget,
                driver: lockedPreparation.integration.driver,
                components: legacyNativeSkills,
                actions,
                onActionEvent: (event) => emitRebuildActionEvent(executionContext, event),
                ...(rebuildCommandTestHooks?.beforeActivationLegacyCleanupMutation ? {
                  beforeMutation: rebuildCommandTestHooks.beforeActivationLegacyCleanupMutation,
                } : {}),
                ...(rebuildCommandTestHooks?.afterActivationLegacyCleanupQuarantine ? {
                  afterQuarantine: rebuildCommandTestHooks.afterActivationLegacyCleanupQuarantine,
                } : {}),
              });
            }
          }
          result ??= {
            status: 'succeeded', command: requestedMethod, target: identity,
            actions,
            cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
          };
          results.push({
            platforms: [platform],
            plugins: result.status === 'succeeded' ? [identity.pluginName] : [],
            warnings: result.failures.map((failure) => failure.message),
            rebuildResults: [result],
            targetResults: [{
              ...toTargetResult(result),
              action: result.status === 'succeeded' && result.removed.length === 0
                && codexReconcilePlan
                && [...codexReconcilePlan.activationActions.user,
                  ...codexReconcilePlan.activationActions.project].every((action) =>
                  action.pluginId !== entry.pluginId || action.action === 'none')
                ? 'keep' : planned.action,
            }],
            overallState: result.status === 'succeeded' ? 'succeeded' : 'failed',
            receiptTargets: [{
              pluginName: identity.pluginName, pluginId: identity.pluginId,
              sourceId: identity.sourceId, platform, scope: planned.resolvedScope,
            }],
          });
          dependencyStates.set(
            key,
            result.status === 'succeeded' ? 'completed' : 'failed',
          );
          continue;
        }
        if (planned.action === 'keep'
          && options.command !== 'cleanup'
          && options.command !== 'uninstall') {
          const preparedError = preparedTargetErrors.get(key);
          if (preparedError) {
            const message = preparedError instanceof Error
              ? preparedError.message
              : String(preparedError);
            const result = failedResult(requestedMethod, identity, message);
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
            dependencyStates.set(key, 'failed');
            continue;
          }
          const actions = operationPreparations.get(key)?.actions
            ?? [];
          const result: RebuildResult = {
            status: 'succeeded', command: requestedMethod, target: identity,
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
          dependencyStates.set(key, 'kept');
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
        const executionResult = await runSingleSourceRebuildCommand({
          ...options,
          command: planned.relation === 'dependency'
            ? planned.action as 'install' | 'reinstall'
            : requestedMethod,
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
            prepared: preparedTargets.get(key),
            operationPreparation: operationPreparations.get(key),
            integration: lockedPreparation.integration,
            preparationError: preparedTargetErrors.get(key),
          },
        });
        results.push(executionResult);
        dependencyStates.set(key,
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
        dependencyStates.set([
          options_.identity.pluginId,
          'codex',
          options_.identity.scope,
        ].join('\0'), 'failed');
        return true;
      };
      const activationMutationPluginIds = new Set(lockedCodexPlans.flatMap((plan) => [
        ...plan.activationActions.user,
        ...plan.activationActions.project,
      ].flatMap((action) => action.action === 'none' ? [] : [action.pluginId])));
      for (const selection of executionSelections) {
        const { entry, platform } = selection;
        const key = executionKey(selection, lockedPlan);
        if (platform !== 'codex'
          || !activationMutationPluginIds.has(entry.pluginId)
          || (dependencyStates.get(key) !== 'completed'
            && dependencyStates.get(key) !== 'kept')) continue;
        const prepared = preparedTargets.get(key)?.target;
        if (!prepared) continue;
        try {
          await lockedPreparation.integration.prepareNativeMarketplaceGroup(prepared);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failCompletedCodexTarget({ identity: prepared.identity, message, phase: 'native.write' });
        }
      }
      const successfulCodexTargetScopes = new Set(executionSelections.flatMap((selection) =>
        selection.platform === 'codex'
        && (dependencyStates.get(executionKey(selection, lockedPlan)) === 'completed'
          || dependencyStates.get(executionKey(selection, lockedPlan)) === 'kept')
          ? [`${selection.entry.pluginId}\0${planTargetFor(
              lockedPlan,
              selection,
            )!.resolvedScope}`]
          : []));
      const activationUserBefore = await readCodexConfigFile(resolveCodexPaths(
        options.commandOptions.cwd,
        'user',
        runtimeEnv,
      ).configTomlPath);
      const activationProjectBefore = options.commandOptions.scope === 'project'
        ? await readCodexConfigFile(resolveCodexPaths(
            options.commandOptions.cwd,
            'project',
            runtimeEnv,
          ).configTomlPath)
        : undefined;
      const preservedActivations = {
        user: new Map(Object.entries(activationUserBefore.snapshot.plugins)
          .map(([pluginId, activation]) => [pluginId, activation.enabled === true])),
        project: new Map(Object.entries(activationProjectBefore?.snapshot.plugins ?? {})
          .map(([pluginId, activation]) => [pluginId, activation.enabled === true])),
      };
      const activationPlans = selectCodexActivationPlans(
        lockedCodexPlans,
        successfulCodexTargetScopes,
        preservedActivations,
        originalUserActivations,
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
        const failedCodexTargetScopes = new Set(executionSelections.flatMap((selection) =>
          selection.platform === 'codex'
          && (dependencyStates.get(executionKey(selection, lockedPlan)) === 'failed'
            || dependencyStates.get(executionKey(selection, lockedPlan)) === 'skipped')
            ? [`${selection.entry.pluginId}\0${planTargetFor(
                lockedPlan,
                selection,
              )!.resolvedScope}`]
            : []));
        for (const failure of await lockedPreparation.integration.driver.completePostchecks?.() ?? []) {
          const message = failure.error instanceof Error
            ? failure.error.message
            : String(failure.error);
          if (failCompletedCodexTarget({ identity: failure.target.identity, message })) {
            const failedPluginId = failure.target.identity.pluginId
              ?? failure.target.identity.pluginName;
            failedCodexTargetScopes.add(
              `${failedPluginId}\0${failure.target.identity.scope}`,
            );
          }
        }
        if (!activationError && activationPlans.length > 0) {
          const postcheckTargetScopes = new Set([...successfulCodexTargetScopes]
            .filter((key) => !failedCodexTargetScopes.has(key)));
          const postcheckPlans = selectCodexActivationPlans(
            activationPlans,
            postcheckTargetScopes,
            preservedActivations,
            originalUserActivations,
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
          const failedActivationTargetScopes = failedCodexActivationTargetScopes({
            error: activationError,
            plans: activationPlans,
            successfulTargetScopes: successfulCodexTargetScopes,
          });
          const message = activationError instanceof Error
            ? activationError.message
            : String(activationError);
          const failedSelections = executionSelections.filter((candidate) =>
            candidate.platform === 'codex'
            && failedActivationTargetScopes.has(`${candidate.entry.pluginId}\0${planTargetFor(
              lockedPlan,
              candidate,
            )!.resolvedScope}`));
          if (failedSelections.length === 0) throw activationError;
          for (const selection of failedSelections) {
            const planned = planTargetFor(lockedPlan, selection)!;
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
            failedCodexTargetScopes.add(
              `${selection.entry.pluginId}\0${planned.resolvedScope}`,
            );
          }
        }
        let propagated = true;
        while (propagated) {
          propagated = false;
          for (const selection of executionSelections.filter((candidate) =>
            candidate.platform === 'codex')) {
            const planned = planTargetFor(lockedPlan, selection)!;
            const targetScopeKey = `${selection.entry.pluginId}\0${planned.resolvedScope}`;
            if (failedCodexTargetScopes.has(targetScopeKey)) continue;
            const failedDependency = (selection.entry.plugin.manifest.dependencies ?? [])
              .map((pluginName) => formatPluginId({
                sourceId: selection.entry.source.sourceId,
                pluginName,
              }))
              .find((pluginId) => {
                const dependency = dependencyTargetFor(lockedPlan, planned, pluginId);
                return dependency
                  ? failedCodexTargetScopes.has(
                      `${pluginId}\0${dependency.requestedScope ?? dependency.resolvedScope}`,
                    )
                  : false;
              });
            if (!failedDependency) continue;
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
                `run aw sync ${selection.entry.pluginId} --target codex --scope ${planned.resolvedScope}`,
              ],
            })) {
              failedCodexTargetScopes.add(targetScopeKey);
              dependencyStates.set(executionKey(selection, lockedPlan), 'failed');
              propagated = true;
            }
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
      merged.nativeFootprints = preparedNativeFootprints([...lockedPreparation.preparedTargets.values()].map((entry) => entry.target));
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

export async function runRebuildCommand(
  options: RebuildCommandInvocation,
): Promise<RebuildCommandResult> {
  const executionInput = options.runtime?.executionInput;
  if (!executionInput) {
    throw new Error('nativeExecutionInputRequired: Native execution requires an explicit scope context and complete demand.');
  }
  const scopedOptions: RebuildCommandInvocation = {
    ...options,
    commandOptions: { ...options.commandOptions, cwd: executionInput.context.executionCwd },
    runtime: { ...options.runtime, env: executionInput.context.env },
  };
  if (scopedOptions.runtime?.codexObservationSession) {
    return runRebuildCommandInSession(scopedOptions);
  }
  const env = executionInput.context.env;
  const session = await createCodexNativeObservationSession({
    exactCwd: executionInput.context.executionCwd,
    env,
    runner: scopedOptions.runtime?.nativeCliRunner ?? getDefaultNativeCliRunner(),
    manager: scopedOptions.runtime?.codexManager,
  });
  try {
    return await runRebuildCommandInSession({
      ...scopedOptions,
      runtime: { ...scopedOptions.runtime, codexObservationSession: session },
    });
  } finally {
    await session.dispose();
  }
}

export async function runRebuildTaskCommand(
  targets: readonly RebuildTaskTarget[],
  options: RebuildTaskCommandOptions,
  runtime: RebuildCommandRuntime = {},
): Promise<RebuildCommandResult> {
  if (targets.length === 0) {
    throw new Error('rebuildTaskTargetsRequired: At least one rebuild task target is required.');
  }
  const normalizeTargets = (values: readonly RebuildTaskTarget[]) => values.map((target) => {
    const selector = parsePluginId(target.pluginId);
    if (!selector.sourceId) {
      throw new Error(`rebuildTaskPluginIdInvalid: "${target.pluginId}" must include a source.`);
    }
    return { ...target, pluginId: formatPluginId({
      sourceId: selector.sourceId,
      pluginName: selector.pluginName,
    }) };
  });
  const normalizedRoots = normalizeTargets(targets);
  const normalizedRepairs = normalizeTargets(options.repairTargets ?? []);
  const sourceIds = new Set([...normalizedRoots, ...normalizedRepairs]
    .map((target) => parsePluginId(target.pluginId).sourceId));
  if (sourceIds.size !== 1) {
    throw new Error('rebuildTaskSourceConflict: All rebuild task targets must use one source.');
  }
  const methodsByKey = new Map<string, RebuildTaskTarget['method']>();
  const repairMethodsByTarget = new Map<string, RebuildTaskTarget['method']>();
  for (const target of [...normalizedRoots, ...normalizedRepairs]) {
    const key = [target.pluginId, target.platform, target.scope].join('\0');
    const current = methodsByKey.get(key);
    if (current && current !== target.method) {
      throw new Error(`rebuildTaskMethodConflict: ${target.pluginId}#${target.platform}#${target.scope}`);
    }
    methodsByKey.set(key, target.method);
  }
  for (const target of normalizedRepairs) {
    const key = [target.pluginId, target.platform].join('\0');
    const current = repairMethodsByTarget.get(key);
    if (current && current !== target.method) {
      throw new Error(`rebuildTaskMethodConflict: ${target.pluginId}#${target.platform}`);
    }
    repairMethodsByTarget.set(key, target.method);
  }
  const deduplicate = (values: readonly RebuildTaskTarget[]) => [...new Map(values.map((target) => [
    [target.pluginId, target.platform, target.scope].join('\0'),
    target,
  ] as const)).values()];
  const normalized = deduplicate(normalizedRoots);
  const repairTargets = deduplicate(normalizedRepairs);
  const commandOptions = { ...options };
  delete commandOptions.repairTargets;
  if (!runtime.executionInput) {
    throw new Error('nativeExecutionInputRequired: rebuild tasks require a scope context and complete demand.');
  }
  if (normalized.some((target) => target.scope !== runtime.executionInput!.context.scope)) {
    throw new Error('nativeExecutionTargetScopeInvalid: rebuild tasks cannot mix scopes.');
  }
  return runRebuildCommand({
    command: 'sync',
    pluginNames: [...new Set(normalized.map((target) => target.pluginId))],
    commandOptions: {
      ...commandOptions,
      platform: 'both',
      scope: normalized[0]!.scope,
    },
    runtime: {
      ...runtime,
      executionInput: {
        ...runtime.executionInput,
        selectedTargets: normalized.map(({ pluginId, platform, scope }) => ({ pluginId, platform, scope })),
      },
    },
    taskTargets: normalized,
    taskRepairTargets: repairTargets,
  });
}
