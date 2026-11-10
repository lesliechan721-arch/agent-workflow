import crypto from 'node:crypto';
import path from 'node:path';
import { captureNativeToolChanges } from '../utils/native-tool-review.js';

import { catalogFileMode } from '@lesliechan721/aw-plugin-core';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';
import fs from 'fs-extra';
import os from 'node:os';
import {
  discoverRetainedManagedCommandPackages,
  managedCommandProducerIdentity,
  prepareManagedCommandPackage,
  retainedManagedCommandPackageResult,
  type ManagedCommandCandidate,
  type PreparedManagedCommandPackage
} from '../utils/managed-command-materialization.js';
import { assertManagedCommandBindingIdentities, listManagedCommands, managedCommandDiagnostic, ManagedCommandError, revokeManagedCommandBindings, syncManagedCommandPackage } from '../utils/managed-command-store.js';

import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings } from '../adapters/helpers.js';
import {
  type ClaudePermissions
} from '../generators/permissions.js';
import { buildGeneratedName } from '../generators/shared.js';
import type { CommandReporter, DebugLogger } from '../output/model.js';
import type {
  CatalogResolution,
  CodexSharedHookGroup,
  CommandProducerResult,
  PlatformName,
  PluginMeta,
  Scope
} from '../types.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  applyCodexConfigTransactionFile,
  applyConditionalCodexConfigTransactionFile,
  readCodexConfigFile,
  type CodexAgentRegistrationSnapshot,
  type CodexMcpServerSnapshot
} from '../utils/codex-config.js';
import { isSafeCodexMarketplaceRoot } from '../utils/codex-marketplace-path.js';
import {
  createCodexNativeObservationSession,
  type CodexNativeObservationSession,
  type CodexNativePluginObservation,
} from '../utils/codex-native-observation.js';
import type { CodexReconcilePlan } from '../utils/codex-reconciler.js';
import {
  inspectCodexSharedNative,
  type CodexSharedNativeInspection
} from '../utils/codex-shared-native.js';
import {
  validateSkillDirectory
} from '../utils/dynamic-skill-tree.js';
import {
  parseCodexSharedHooksFile,
  serializeTrackedHookGroupIdentity,
} from '../utils/hooks-contract.js';
import {
  assertSafeNamespacedMarketplacePluginRoot,
  readStrictNamespacedMarketplaceRoot
} from '../utils/local-marketplace.js';
import {
  buildCodexMarketplaceRemoveInvocation,
  buildCodexPluginRemoveInvocation,
  CodexProjectConfigNotEffectiveError,
  runNativeCliChecked,
  SYSTEM_CODEX_MANAGER,
  type CodexManager,
  type NativeCliRunner
} from '../utils/native-cli.js';
import {
  inspectOwnedComponents,
  OWNED_TEXT_HEADER_PREFIX,
  parseOwnedTextHeader,
  parseSharedOwnerToken,
  readSkillOwnerMarker,
  type NativeOwnershipProbe,
  type OwnedComponent,
  type OwnedComponentExecutor,
  type OwnerIdentity,
  type OwnershipInspection
} from '../utils/ownership.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRoot
} from '../utils/paths.js';
import {
  atomicRemoveConfigFile,
  atomicReplaceConfigFile,
  withConfigFileMutation,
} from '../utils/plugin-config.js';
import type { PluginProcessResult } from '../utils/plugin-scripts.js';
import {
  runPreApplyScript
} from '../utils/plugin-scripts.js';
import { assertCanonicalProjectManagedRoots } from '../utils/project-boundary.js';
import { attachSafeOperationError, readSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import {
  createProjectLocationKey,
  resolveRequiredCanonicalRepoRoot,
  resolveClaudeProjectKey,
  resolveCodexProjectKey
} from '../utils/state-paths.js';
import type { OperationAction } from './operation-plan.js';
import type {
  DeferredRebuildPostcheckFailure,
  DesiredTarget,
  RebuildPreApplyInvocation,
  RebuildTargetDriver,
  RebuildTargetIdentity,
} from './rebuild-operations.js';
import { platformOwnership, PlatformRebuildSession } from './rebuild-platform-integration.js';

const MARKETPLACE_NAME = 'aw';
const LEGACY_MCP_OWNER_ENV = 'AW_AGENT_WORKFLOWS_OWNER';

const commandPackagePreparationCaches = new WeakMap<RebuildExecutionContext, Map<string, Promise<{ action: OperationAction; candidate: ManagedCommandCandidate }>>>();
const platformRebuildSessions = new WeakMap<Map<string, PluginProcessResult>, PlatformRebuildSession>();
const commandPackageCandidates = new WeakMap<Map<string, PluginProcessResult>, Map<string, Promise<PreparedManagedCommandPackage>>>();

export function finalizePreparedPlatformRebuildSession(results: Map<string, PluginProcessResult>): void {
  platformRebuildSessions.get(results)?.freezeMarketplaceCandidates();
}

export async function disposePreparedPlatformRebuildSession(results: Map<string, PluginProcessResult>): Promise<void> {
  const session = platformRebuildSessions.get(results);
  platformRebuildSessions.delete(results);
  const packages = commandPackageCandidates.get(results);
  commandPackageCandidates.delete(results);
  try { await session?.dispose(); }
  finally {
    if (packages) await Promise.all([...packages.values()].map(async (candidate) => {
      const prepared = await candidate.catch(() => undefined);
      await prepared?.cleanup();
    }));
  }
}

async function commandPackageActions(options: {
  plugin: PluginMeta; platform: PlatformName; scope: Scope; cwd: string; env: NodeJS.ProcessEnv;
  context: RebuildExecutionContext;
}): Promise<{ actions: OperationAction[]; candidates: ManagedCommandCandidate[] }> {
  const actions: OperationAction[] = [];
  const candidates: ManagedCommandCandidate[] = [];
  const packageCache = options.context.packagePreparationCache ??= new Map();
  let cache = commandPackagePreparationCaches.get(options.context);
  if (!cache) {
    cache = new Map();
    commandPackagePreparationCaches.set(options.context, cache);
  }
  for (const declaration of options.plugin.manifest.managedCommands?.packages ?? []) {
    if (!declaration.platforms.includes(options.platform)) continue;
    const producer = await managedCommandProducerIdentity({ ...options, scope: declaration.scope,
      producer: { kind: 'package', packageKey: declaration.key } });
    const key = getCommandPackageId(producer);
    let preparation = cache.get(key);
    if (!preparation) {
      preparation = (async () => {
        let candidate = packageCache.get(key);
        if (!candidate) {
          candidate = prepareManagedCommandPackage({ ...options, referencePlugins: options.context.referencePlugins,
            packageKey: declaration.key, scope: declaration.scope, signal: options.context.signal,
            scriptTimeoutMs: options.context.scriptTimeoutMs });
          packageCache.set(key, candidate);
        }
        const prepared = await candidate;
        const files: Array<import('./operation-plan.js').OperationArtifactFile & { mode: number }> = [];
        async function visit(directory: string, prefix: string): Promise<void> {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              await visit(absolute, relativePath);
            } else if (entry.isFile()) {
              const content = await fs.readFile(absolute);
              files.push({ relativePath, contentBase64: content.toString('base64'),
                contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
                mode: (await fs.stat(absolute)).mode & 0o777 });
            } else throw new ManagedCommandError('commandResourceInvalid', 'The prepared package contains an unsafe resource.');
          }
        }
        await visit(prepared.resourceRoot, '');
        files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
        return { action: { kind: 'syncManagedCommandPackage' as const, pluginId: pluginActionId(options.plugin),
          scope: declaration.scope, producer: prepared.producer, sets: prepared.sets, nativeTools: prepared.nativeTools,
          files, contentDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')}` },
        candidate: { producer: prepared.producer, sets: prepared.sets, nativeTools: prepared.nativeTools } };
      })();
      cache.set(key, preparation);
    }
    const prepared = await preparation;
    actions.push(prepared.action);
    candidates.push(prepared.candidate);
  }
  return { actions, candidates };
}

export interface RebuildIntegration {
  resolvePlatformTargets(inputs: readonly Parameters<RebuildIntegration['buildTarget']>[0][]): Promise<void>;
  sealMarketplaceGenerations(targets: readonly DesiredTarget[]): Promise<void>;
  driver: RebuildTargetDriver;
  setNativeMarketplaceEligibleTargets(targets: readonly DesiredTarget[]): void;
  prepareNativeMarketplaceGroup(target: DesiredTarget): Promise<void>;
  captureCodexPostMutationSnapshots(marketplaceNames?: readonly string[]): Promise<void>;
  buildTarget(options: {
    sourceId?: string;
    sourceIdentity?: string;
    pluginId?: string;
    marketplaceName?: string;
    marketplaceRoot?: string;
    plugin: PluginMeta;
    platform: PlatformName;
    scope: Scope;
    cwd: string;
    command: 'install' | 'sync' | 'reinstall' | 'cleanup' | 'uninstall';
    catalog: CatalogResolution;
    readOnlyInspectionPlan?: boolean;
    readOnlyShallowInspectionPlan?: boolean;
    includeNativeCleanupCandidate?: boolean;
    codexActivationCleanup?: Array<{
      codexPluginId: string;
      scope: Scope;
      disposition: 'remove' | 'disable';
    }>;
  }): Promise<DesiredTarget>;
}

export interface PreparedRebuildTarget {
  target: DesiredTarget;
}

export class CodexActivationPostcheckError extends Error {
  readonly code = 'codexActivationPostcheckFailed';
  readonly codexPluginIds: string[];

  constructor(codexPluginIds: string | readonly string[], detail: string) {
    super(`codexActivationPostcheckFailed: ${detail}`);
    this.name = 'CodexActivationPostcheckError';
    this.codexPluginIds = [...new Set(
      typeof codexPluginIds === 'string' ? [codexPluginIds] : codexPluginIds,
    )];
  }
}

export interface RebuildExecutionContext {
  recoveryCandidates?: readonly import('../platforms/contracts.js').RecoveryCandidate[];
  sharedReferenceView?: import('../utils/native-demand.js').NativeSharedReferenceView;
  platformRebuildSession?: PlatformRebuildSession;
  packagePreparationCache?: Map<string, Promise<PreparedManagedCommandPackage>>;
  interruption?: import('./public-interruption.js').PublicCommandInterruption;
  /** Validated renderer process output shared only by preparations of this operation. */
  preparedArtifactRenderResults?: Map<string, PluginProcessResult>;
  signal?: AbortSignal;
  scriptTimeoutMs?: number;
  referencePlugins?: readonly PluginMeta[];
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  codexManager?: CodexManager;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
  expectedCatalogConfigDigest?: string;
  codexUserActivationDesired?: ReadonlySet<string>;
  codexObservationSession?: CodexNativeObservationSession;
  codexObservationScopeByMarketplace?: ReadonlyMap<string, 'user' | 'both'>;
  preApplyExecutionCache?: Map<string, Promise<void>>;
  managedCommandProducerCache?: Map<string, Promise<CommandProducerResult>>;
  preserveLegacyNativeSkills?: boolean;
  nativeActivationOnlyTargets?: readonly { pluginId: string; platform: PlatformName; scope: Scope }[];
  commandResults?: CommandProducerResult[];
  managedCommandCandidates?: Map<string, ManagedCommandCandidate[]>;
}

function codexObservationScope(
  context: RebuildExecutionContext,
  marketplaceName: string,
  fallbackScope: Scope,
): 'user' | 'both' {
  return context.codexObservationScopeByMarketplace?.get(marketplaceName)
    ?? (fallbackScope === 'user' ? 'user' : 'both');
}

function codexMarketplaceFromPluginId(pluginId: string): string {
  return pluginId.slice(pluginId.lastIndexOf('@') + 1);
}

function requireCodexObservationCoverage(
  registration: CodexPluginRegistrationLiveInspection,
  scope: 'user' | 'both',
  operation: string,
): void {
  if (!registration.observations.user
    || (scope === 'both' && !registration.observations.project)) {
    throw new Error(
      `codexNativeObservationUnavailable: ${operation} requires ${scope === 'user' ? 'neutral' : 'exact and neutral'} Codex plugin list evidence.`,
    );
  }
}

function requireCodexManager(manager: CodexManager | undefined): CodexManager {
  if (!manager) {
    throw new Error('codexManagerRequired: Codex native operation has no resolved manager.');
  }
  return manager;
}

async function runCodexMutationWithInvalidation<T>(options: {
  marketplaceName: string;
  observationSession?: CodexNativeObservationSession;
  mutation: () => Promise<T>;
}): Promise<T> {
  try {
    return await options.mutation();
  } finally {
    options.observationSession?.invalidate(options.marketplaceName);
  }
}

async function executeCodexReconcileActivationsInSession(options: {
  plans: readonly CodexReconcilePlan[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  manager?: CodexManager;
  runner: NativeCliRunner;
  observationSession: CodexNativeObservationSession;
  preflightCompleted?: boolean;
  mutationMarketplaces?: Set<string>;
  observationScopeByMarketplace?: ReadonlyMap<string, 'user' | 'both'>;
}): Promise<void> {
  const byScope: Record<Scope, {
    upserts: Record<string, boolean>;
    removals: Set<string>;
  }> = {
    user: { upserts: {}, removals: new Set<string>() },
    project: { upserts: {}, removals: new Set<string>() },
  };
  for (const plan of options.plans) {
    const rewrittenPluginIds = new Set(plan.sharedNativeActions
      .filter((action) => action.action === 'install'
        || action.action === 'replace'
        || action.action === 'repair')
      .map((action) => action.codexPluginId));
    for (const scope of ['user', 'project'] as const) {
      for (const action of plan.activationActions[scope]) {
        if (action.action === 'enable' || action.action === 'disable') {
          byScope[scope].upserts[action.codexPluginId] = action.desired;
          byScope[scope].removals.delete(action.codexPluginId);
        } else if (action.action === 'remove') {
          byScope[scope].removals.add(action.codexPluginId);
        } else if (rewrittenPluginIds.has(action.codexPluginId)
          && (action.desired || scope === 'user')) {
          byScope[scope].upserts[action.codexPluginId] = action.desired;
          byScope[scope].removals.delete(action.codexPluginId);
        }
      }
    }
    for (const removal of plan.staleActivationRemovals) {
      if (!Object.hasOwn(byScope[removal.scope].upserts, removal.codexPluginId)) {
        byScope[removal.scope].removals.add(removal.codexPluginId);
      }
    }
  }
  const recordActivationMutations = (pluginIds: Iterable<string>): void => {
    if (!options.mutationMarketplaces) return;
    for (const pluginId of pluginIds) {
      options.mutationMarketplaces.add(pluginId.slice(pluginId.lastIndexOf('@') + 1));
    }
  };

  const observedActivationPluginIds = [...new Set(options.plans.flatMap((plan) =>
    plan.postcheck.support === 'observed'
      ? plan.postcheck.plugins.map((plugin) => plugin.codexPluginId)
      : []))];
  if (!options.preflightCompleted && observedActivationPluginIds.length > 0) {
    const manager = requireCodexManager(options.manager);
    for (const pluginId of observedActivationPluginIds) {
      const marketplaceName = codexMarketplaceFromPluginId(pluginId);
      const observationScope = options.observationScopeByMarketplace?.get(marketplaceName)
        ?? (options.plans.some((plan) => plan.requirement.scope === 'project')
          ? 'both'
          : 'user');
      const registration = await inspectCodexPluginRegistrationLive({
        pluginId,
        cwd: options.cwd,
        env: options.env,
        nativeCliRunner: options.runner,
        manager,
        scope: observationScope,
        observationSession: options.observationSession,
      });
      const observedState = requireObservedCodexNativeState(
        registration.observation,
        'activation precheck',
      );
      requireCodexObservationCoverage(registration, observationScope, 'activation precheck');
      if (observedState !== 'installed') {
        throw new Error(
          'codexNativeObservationFailed: activation precheck did not observe the installed Codex plugin.',
        );
      }
    }
  }
  for (const scope of ['user', 'project'] as const) {
    const enables = Object.fromEntries(Object.entries(byScope[scope].upserts)
      .filter(([, desired]) => desired));
    if (Object.keys(enables).length === 0) continue;
    const configPath = resolveCodexPaths(options.cwd, scope, options.env).configTomlPath;
    const update = await applyCodexConfigTransactionFile(
      configPath,
      { upsertPluginActivations: enables },
    );
    if (update.wrote) recordActivationMutations(Object.keys(enables));
    const enabledConfig = await readCodexConfigFile(configPath);
    const missingEnables = Object.keys(enables).filter((pluginId) =>
      enabledConfig.snapshot.plugins[pluginId]?.enabled !== true);
    if (missingEnables.length > 0) {
      throw new CodexActivationPostcheckError(
        missingEnables,
        `${missingEnables.join(', ')} ${scope} activation was not enabled before obsolete activation removal.`,
      );
    }
  }
  for (const scope of ['user', 'project'] as const) {
    const transaction = byScope[scope];
    const disables = Object.fromEntries(Object.entries(transaction.upserts)
      .filter(([, desired]) => !desired));
    if (Object.keys(disables).length === 0 && transaction.removals.size === 0) continue;
    const update = await applyCodexConfigTransactionFile(
      resolveCodexPaths(options.cwd, scope, options.env).configTomlPath,
      {
        ...(transaction.removals.size > 0
          ? { removePluginActivations: [...transaction.removals].sort() }
          : {}),
        ...(Object.keys(disables).length > 0
          ? { upsertPluginActivations: disables }
          : {}),
      },
    );
    if (update.wrote) {
      recordActivationMutations([
        ...Object.keys(disables),
        ...transaction.removals,
      ]);
    }
  }

  const [userConfig, projectConfig] = await Promise.all([
    readCodexConfigFile(resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath),
    readCodexConfigFile(resolveCodexPaths(options.cwd, 'project', options.env).configTomlPath),
  ]);
  const configMismatchIds: string[] = [];
  const configMismatchDetails: string[] = [];
  for (const plan of options.plans) {
    for (const scope of ['user', 'project'] as const) {
      const snapshot = scope === 'user' ? userConfig.snapshot : projectConfig.snapshot;
      for (const action of plan.activationActions[scope]) {
        const actual = snapshot.plugins[action.codexPluginId]?.enabled;
        const expected = action.desired
          ? true
          : action.action === 'disable' || actual === false ? false : undefined;
        if (actual !== expected) {
          configMismatchIds.push(action.codexPluginId);
          configMismatchDetails.push(
            `${action.codexPluginId} ${scope} activation is ${String(actual)}; expected ${String(expected)}.`,
          );
        }
      }
      for (const removal of plan.staleActivationRemovals.filter((entry) => entry.scope === scope)) {
        if (snapshot.plugins[removal.codexPluginId]?.enabled !== undefined) {
          configMismatchIds.push(removal.codexPluginId);
          configMismatchDetails.push(`stale ${removal.codexPluginId} ${scope} activation remains.`);
        }
      }
    }
  }
  if (configMismatchIds.length > 0) {
    throw new CodexActivationPostcheckError(
      configMismatchIds,
      configMismatchDetails.join(' '),
    );
  }

  const observedActivationChecks = options.plans.flatMap((plan) =>
    plan.postcheck.support === 'observed'
      ? plan.postcheck.plugins
      : []);
  if (observedActivationChecks.length === 0) return;
  const ineffectivePlugins: string[] = [];
  const ineffectiveDetails: string[] = [];
  for (const plugin of observedActivationChecks) {
    const userActive = userConfig.snapshot.plugins[plugin.codexPluginId]?.enabled === true;
    const projectActive = projectConfig.snapshot.plugins[plugin.codexPluginId]?.enabled === true;
    if ((userActive || projectActive) !== (
      plugin.expectedUserEnabled || plugin.expectedProjectEnabled
    )
      || userActive !== plugin.expectedUserEnabled) {
      ineffectivePlugins.push(plugin.codexPluginId);
      ineffectiveDetails.push(new CodexProjectConfigNotEffectiveError(plugin.codexPluginId).message);
    }
  }
  if (ineffectivePlugins.length > 0) {
    throw new CodexActivationPostcheckError(
      ineffectivePlugins,
      ineffectiveDetails.join(' '),
    );
  }
}

export async function executeCodexReconcileActivations(options: {
  plans: readonly CodexReconcilePlan[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  manager?: CodexManager;
  runner: NativeCliRunner;
  observationSession?: CodexNativeObservationSession;
  preflightCompleted?: boolean;
  mutationMarketplaces?: Set<string>;
  observationScopeByMarketplace?: ReadonlyMap<string, 'user' | 'both'>;
}): Promise<void> {
  const ownedSession = options.observationSession ? undefined
    : await createCodexNativeObservationSession({
        exactCwd: options.cwd,
        env: options.env,
        runner: options.runner,
        manager: options.manager,
      });
  try {
    await executeCodexReconcileActivationsInSession({
      ...options,
      observationSession: options.observationSession ?? ownedSession!,
    });
  } finally {
    await ownedSession?.dispose();
  }
}

export async function postcheckCodexReconcileActivations(options: {
  plans: readonly CodexReconcilePlan[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  manager?: CodexManager;
  runner: NativeCliRunner;
  observationSession?: CodexNativeObservationSession;
  observationScopeByMarketplace?: ReadonlyMap<string, 'user' | 'both'>;
}): Promise<void> {
  const checks = options.plans.flatMap((plan) =>
    plan.postcheck.support === 'observed' ? plan.postcheck.plugins : []);
  if (checks.length === 0) return;
  const ownedSession = options.observationSession ? undefined
    : await createCodexNativeObservationSession({
        exactCwd: options.cwd,
        env: options.env,
        runner: options.runner,
        manager: options.manager,
      });
  const session = options.observationSession ?? ownedSession!;
  try {
    const failedPluginIds: string[] = [];
    const failureDetails: string[] = [];
    for (const check of checks) {
      try {
        const marketplaceName = codexMarketplaceFromPluginId(check.codexPluginId);
        const observationScope = options.observationScopeByMarketplace?.get(marketplaceName)
          ?? (options.plans.some((plan) => plan.requirement.scope === 'project')
            ? 'both'
            : 'user');
        const registration = await inspectCodexPluginRegistrationLive({
          pluginId: check.codexPluginId,
          cwd: options.cwd,
          env: options.env,
          nativeCliRunner: options.runner,
          manager: options.manager,
          scope: observationScope,
          observationSession: session,
        });
        const state = requireObservedCodexNativeState(
          registration.observation,
          'activation postcheck',
        );
        requireCodexObservationCoverage(registration, observationScope, 'activation postcheck');
        if (state !== 'installed') {
          throw new Error(
            `codexNativeObservationFailed: ${check.codexPluginId} was not observed after Codex activation mutation.`,
          );
        }
      } catch (error) {
        failedPluginIds.push(check.codexPluginId);
        failureDetails.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failedPluginIds.length > 0) {
      throw new CodexActivationPostcheckError(failedPluginIds, failureDetails.join(' '));
    }
  } finally {
    await ownedSession?.dispose();
  }
}

const CODEX_REMOVE_RECOVERY =
  'Codex residue was retained. Retry cleanup or uninstall, upgrade AW, or install a compatible official Codex CLI.';

function pluginActionId(plugin: PluginMeta): string {
  return plugin.pluginId ?? plugin.manifest.name;
}

function mergePermissionStates(values: Array<Partial<ClaudePermissions> | undefined>): ClaudePermissions {
  return {
    allow: [...new Set(values.flatMap((value) => value?.allow ?? []))],
    ask: [...new Set(values.flatMap((value) => value?.ask ?? []))],
    deny: [...new Set(values.flatMap((value) => value?.deny ?? []))],
    ...(values.some((value) => value?.excludedCommands !== undefined) ? {
      excludedCommands: [...new Set(values.flatMap((value) => value?.excludedCommands ?? []))],
    } : {}),
  };
}

function subtractPermissionState(
  value: Partial<ClaudePermissions> | undefined,
  generated: ClaudePermissions,
): ClaudePermissions {
  const remove = {
    allow: new Set(generated.allow),
    ask: new Set(generated.ask),
    deny: new Set(generated.deny),
  };
  return {
    allow: (value?.allow ?? []).filter((entry) => !remove.allow.has(entry)),
    ask: (value?.ask ?? []).filter((entry) => !remove.ask.has(entry)),
    deny: (value?.deny ?? []).filter((entry) => !remove.deny.has(entry)),
    ...(value?.excludedCommands ? {
      excludedCommands: value.excludedCommands.filter((entry) => !generated.excludedCommands?.includes(entry)),
    } : {}),
  };
}

function intersectPermissionState(
  value: Partial<ClaudePermissions> | undefined,
  generated: ClaudePermissions,
): ClaudePermissions {
  const keep = {
    allow: new Set(generated.allow),
    ask: new Set(generated.ask),
    deny: new Set(generated.deny),
  };
  return {
    allow: (value?.allow ?? []).filter((entry) => keep.allow.has(entry)),
    ask: (value?.ask ?? []).filter((entry) => keep.ask.has(entry)),
    deny: (value?.deny ?? []).filter((entry) => keep.deny.has(entry)),
    ...(value?.excludedCommands ? {
      excludedCommands: value.excludedCommands.filter((entry) => generated.excludedCommands?.includes(entry)),
    } : {}),
  };
}

function rebuildClaudePermissions(settings: ClaudeSettings, ownerKey: string, desired?: ClaudePermissions): void {
  const previousGenerated = mergePermissionStates(
    Object.values(settings.awGenerated?.permissions ?? {}),
  );
  const currentPermissions = mergePermissionStates([{
    ...settings.permissions,
    ...(settings.sandbox?.excludedCommands ? { excludedCommands: settings.sandbox.excludedCommands } : {}),
  }]);
  const manual = mergePermissionStates([
    subtractPermissionState(currentPermissions, previousGenerated),
    intersectPermissionState(
      intersectPermissionState(settings.awGenerated?.manualPermissions, previousGenerated),
      currentPermissions,
    ),
  ]);
  settings.awGenerated ??= {};
  settings.awGenerated.permissions ??= {};
  if (desired) settings.awGenerated.permissions[ownerKey] = desired;
  else delete settings.awGenerated.permissions[ownerKey];
  if (Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }
  if (manual.allow.length || manual.ask.length || manual.deny.length || manual.excludedCommands?.length) {
    settings.awGenerated.manualPermissions = manual;
  } else {
    delete settings.awGenerated.manualPermissions;
  }
  const combined = mergePermissionStates([
    manual,
    ...Object.values(settings.awGenerated.permissions ?? {}),
  ]);
  settings.permissions = {
    ...settings.permissions, allow: combined.allow, ask: combined.ask, deny: combined.deny,
  };
  if (combined.excludedCommands !== undefined) {
    settings.sandbox = { ...settings.sandbox, excludedCommands: combined.excludedCommands };
  }
  if (
    settings.awGenerated.permissions === undefined
    && settings.awGenerated.manualPermissions === undefined
    && settings.awGenerated.hooks === undefined
    && settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function legacyCodexMcpOwner(actual: CodexMcpServerSnapshot | undefined): string | null {
  const envValue = actual?.value?.env;
  return envValue
    && typeof envValue === 'object'
    && !Array.isArray(envValue)
    && typeof envValue[LEGACY_MCP_OWNER_ENV] === 'string'
    ? envValue[LEGACY_MCP_OWNER_ENV]
    : null;
}

async function readLegacyCodexHooks(hooksPath: string) {
  if (!await fs.pathExists(hooksPath)) return parseCodexSharedHooksFile({ hooks: {} });
  return parseCodexSharedHooksFile(await fs.readJson(hooksPath));
}

function renderLegacyCodexHookGroups(groups: CodexSharedHookGroup[]): string {
  const hooks: Record<string, Record<string, unknown>[]> = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event]!.push(group.rawGroup);
  }
  return `${JSON.stringify({ hooks }, null, 2)}\n`;
}

async function applyLegacyCodexHookCleanupTransactionFile(
  hooksPath: string,
  update: (
    parsed: ReturnType<typeof parseCodexSharedHooksFile>,
  ) => CodexSharedHookGroup[] | null,
): Promise<boolean> {
  return withConfigFileMutation({
    filePath: hooksPath,
    allowedRoot: path.dirname(hooksPath),
    action: async () => {
      const parsed = await readLegacyCodexHooks(hooksPath);
      const groups = update(parsed);
      if (!groups) return false;
      if (groups.length === 0) {
        await atomicRemoveConfigFile({
          filePath: hooksPath,
          allowedRoot: path.dirname(hooksPath),
        });
      } else {
        await atomicReplaceConfigFile({
          filePath: hooksPath,
          allowedRoot: path.dirname(hooksPath),
          content: renderLegacyCodexHookGroups(groups),
        });
      }
      return true;
    },
  });
}

async function codexRoleRegistrationOwned(options: {
  fileIdentity: OwnerIdentity;
  configPath: string;
  roleKey: string;
  rolePath: string;
  registration: CodexAgentRegistrationSnapshot | undefined;
}): Promise<boolean> {
  if (!options.registration?.configFile) return false;
  const expected = path.normalize(
    path.relative(path.dirname(options.configPath), options.rolePath),
  );
  const actual = path.normalize(path.relative(
    path.dirname(options.configPath),
    path.resolve(path.dirname(options.configPath), options.registration.configFile),
  ));
  if (actual !== expected) return false;
  const raw = await fs.readFile(options.rolePath, 'utf8').catch(() => '');
  try {
    return Boolean(parseOwnedTextHeader(
      raw,
      options.fileIdentity,
    ));
  } catch {
    return false;
  }
}

export async function removeForceCleanupCodexRoleRegistration(options: {
  component: OwnedComponent;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const component = options.component;
  if (component.kind !== 'owned-text-file' || component.identity.platform !== 'codex') return;
  const paths = resolveCodexPaths(options.cwd, component.identity.scope, options.env);
  const roleKey = component.identity.artifactKey;
  const expectedPath = path.join(paths.agentsDir,
    `${buildGeneratedName(component.identity.plugin, roleKey)}.toml`);
  if (path.resolve(component.path) !== path.resolve(expectedPath)) return;
  await applyConditionalCodexConfigTransactionFile(paths.configTomlPath, async (snapshot) => {
    const registration = snapshot.agents[roleKey];
    if (!registration?.configFile
      || path.resolve(path.dirname(paths.configTomlPath), registration.configFile)
        !== path.resolve(component.path)) return null;
    // Force authorizes the existing exclusive file. The matching registration is
    // removed before that evidence disappears; missing or foreign files grant no authority.
    const inspected = await inspectOwnedComponents({ components: [component], forceExclusive: true });
    return inspected.components[0]?.state === 'present'
      ? { removeAgentRegistrations: [roleKey] }
      : null;
  });
}

function sharedOwnerPluginName(value: string): string {
  return parseSharedOwnerToken(value)?.plugin ?? value;
}
export interface CodexSharedNativeLiveInspection {
  sharedNative: CodexSharedNativeInspection;
  expectedPayloadDigest?: string;
}

export interface CodexPluginRegistrationLiveInspection {
  observation: CodexNativePluginObservation;
  observations: {
    user: boolean;
    project: boolean;
  };
  activations: {
    user?: boolean;
    project?: boolean;
  };
}

function observedCodexNativeState(
  observation: CodexNativePluginObservation,
  operation: string,
): 'present' | 'absent' | 'partial' {
  if (observation.state === 'observed') {
    return observation.value === 'installed' ? 'present' : 'absent';
  }
  if (observation.state === 'unobserved') return 'partial';
  throw new Error(`codexNativeObservationFailed: ${operation} requires Codex plugin list evidence.`);
}

function requireObservedCodexNativeState(
  observation: CodexNativePluginObservation,
  operation: string,
): 'installed' | 'absent' {
  if (observation.state === 'observed') return observation.value;
  const code = observation.state === 'failed'
    ? 'codexNativeObservationFailed'
    : 'codexNativeObservationUnavailable';
  throw new Error(`${code}: ${operation} requires Codex plugin list evidence.`);
}

export async function inspectCodexPluginRegistrationLive(options: {
  pluginId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner?: NativeCliRunner;
  manager?: CodexManager;
  scope?: 'user' | 'project' | 'both';
  observationSession?: CodexNativeObservationSession;
}): Promise<CodexPluginRegistrationLiveInspection> {
  if (!options.nativeCliRunner) {
    return {
      observation: { state: 'unobserved' },
      observations: { user: false, project: false },
      activations: {},
    };
  }
  const ownedSession = options.observationSession ? undefined
    : await createCodexNativeObservationSession({
        exactCwd: options.cwd,
        env: options.env,
        runner: options.nativeCliRunner,
        manager: options.manager ?? SYSTEM_CODEX_MANAGER,
      });
  const session = options.observationSession ?? ownedSession!;
  try {
    const inspected = await session.inspectPlugin({
      pluginId: options.pluginId,
      scope: options.scope ?? 'both',
    });
    return {
      observation: inspected.observation,
      observations: inspected.observations,
      activations: inspected.activations,
    };
  } finally {
    await ownedSession?.dispose();
  }
}

export async function removeCodexPluginActivation(options: {
  configPath: string;
  codexPluginId: string;
}): Promise<void> {
  await applyConditionalCodexConfigTransactionFile(options.configPath, (snapshot) =>
    Object.hasOwn(snapshot.plugins, options.codexPluginId)
      ? { removePluginActivations: [options.codexPluginId] }
      : null);
}

export async function removeNamespacedMarketplacePluginProjection(options: {
  rootDir: string;
  sourceId: string;
  sourceIdentity: string;
  pluginName: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!await isSafeCodexMarketplaceRoot({
    awHome: resolveAwHome(options.env),
    sourceId: options.sourceId,
    marketplaceRoot: options.rootDir,
  })) {
    throw new Error('marketplaceProjectionUnsafe: marketplace root is outside the canonical AW source path.');
  }
  const root = await readStrictNamespacedMarketplaceRoot({
    rootDir: options.rootDir,
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
  });
  if (!root) return;
  const pluginRoot = await assertSafeNamespacedMarketplacePluginRoot(
    options.rootDir, options.pluginName,
  );
  const pluginStats = await fs.lstat(pluginRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pluginStats && (!pluginStats.isDirectory() || pluginStats.isSymbolicLink())) {
    throw new Error('marketplaceProjectionUnsafe: plugin projection is not a regular directory.');
  }
  const manifests = [
    { value: root.agentsManifest, path: path.join(options.rootDir, '.agents', 'plugins', 'marketplace.json') },
    ...(root.claudeManifest
      ? [{ value: root.claudeManifest, path: path.join(options.rootDir, '.claude-plugin', 'marketplace.json') }]
      : []),
  ];
  const hasEntry = manifests.some(({ value }) => Array.isArray(value.plugins)
    && value.plugins.some((entry) => entry !== null && typeof entry === 'object'
      && (entry as { name?: unknown }).name === options.pluginName));
  let hasIdentityManifest = false;
  if (pluginStats) {
    for (const manifestName of ['.agents-plugin/plugin.json', '.codex-plugin/plugin.json']) {
      const manifestPath = path.join(pluginRoot, manifestName);
      const manifest = await fs.readJson(manifestPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }) as { name?: unknown } | null;
      if (manifest && manifest.name !== options.pluginName) {
        throw new Error('marketplaceProjectionIdentityMismatch: plugin projection has a foreign name.');
      }
      hasIdentityManifest ||= manifest?.name === options.pluginName;
    }
    if (!hasEntry && !hasIdentityManifest) {
      throw new Error('marketplaceProjectionIdentityUnavailable: plugin directory has no matching marketplace entry or plugin manifest.');
    }
  }
  if (pluginStats) {
    const inspectTree = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          throw new Error('marketplaceProjectionUnsafe: plugin projection contains an unsafe node.');
        }
        if (entry.isDirectory()) await inspectTree(path.join(directory, entry.name));
      }
    };
    await inspectTree(pluginRoot);
    await fs.remove(pluginRoot);
  }
  for (const manifest of manifests) {
    if (!Array.isArray(manifest.value.plugins)) {
      throw new Error('marketplaceProjectionInvalid: marketplace plugins are not an array.');
    }
    const plugins = manifest.value.plugins.filter((entry) => entry === null
      || typeof entry !== 'object'
      || (entry as { name?: unknown }).name !== options.pluginName);
    if (plugins.length !== manifest.value.plugins.length) {
      await atomicReplaceConfigFile({
        filePath: manifest.path,
        allowedRoot: options.rootDir,
        content: `${JSON.stringify({ ...manifest.value, plugins }, null, 2)}\n`,
      });
    }
  }
}

/**
 * Read-only shared-native inspection. Official Codex list evidence owns installation
 * state. Filesystem validation is limited to the AW-owned marketplace source.
 */
export async function inspectCodexSharedNativeLive(options: {
  pluginName: string;
  sourceId: string;
  desiredVersion: string;
  expectedPayloadDigest?: string;
  inspectionMode?: 'shallow' | 'payload';
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceName?: string;
  marketplaceRoot?: string;
  nativeCliRunner?: NativeCliRunner;
  manager?: CodexManager;
  observationScope?: 'user' | 'both';
  observationSession?: CodexNativeObservationSession;
  pluginRegistration?: CodexPluginRegistrationLiveInspection;
  nativeRenderPlugin?: PluginMeta;
}): Promise<CodexSharedNativeLiveInspection> {
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const marketplaceRoot = options.marketplaceRoot ?? path.join(
    resolveAwHome(options.env),
    'marketplaces',
    options.sourceId,
  );
  const marketplacePathSafe = await isSafeCodexMarketplaceRoot({
    awHome: resolveAwHome(options.env),
    sourceId: options.sourceId,
    marketplaceRoot,
  });
  const pluginId = `${options.pluginName}@${marketplaceName}`;
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const pluginList = options.pluginRegistration ?? await inspectCodexPluginRegistrationLive({
    pluginId,
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
    manager: options.manager,
    scope: options.observationScope,
    observationSession: options.observationSession,
  });
  const expectedPayloadDigest = options.expectedPayloadDigest;
  const sharedNative: CodexSharedNativeInspection = inspectCodexSharedNative({
    pluginName: options.pluginName,
    pluginId,
    marketplaceName,
    canonicalMarketplaceRoot: marketplaceRoot,
    desiredVersion: options.desiredVersion,
    expectedPayloadDigest,
    marketplaceRegistration: config.snapshot.marketplaces[marketplaceName],
    marketplacePathSafe,
    observation: pluginList.observation,
  });
  return {
    sharedNative,
    ...(expectedPayloadDigest ? { expectedPayloadDigest } : {}),
  };
}

type ClaudeNativeScope = Scope | 'local';

interface ClaudeNativeRecord {
  name: string;
  marketplace?: string;
  scope: ClaudeNativeScope;
  projectPath?: string;
  version: string;
}

interface ClaudeMarketplaceConsumer {
  name: string;
  scope: ClaudeNativeScope;
  projectPath?: string;
}

async function readJsonObjectIfExists(filePath: string, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await fs.readJson(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`${label} 无法读取：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON object。`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readClaudeMarketplaceSourcePath(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const source = nonEmptyString(value);
    if (!source) throw new Error(`${label} 必须是非空 string。`);
    return source;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是 string 或 object。`);
  }
  const record = value as Record<string, unknown>;
  if (record.source && typeof record.source === 'object' && !Array.isArray(record.source)) {
    return readClaudeMarketplaceSourcePath(record.source, `${label}.source`);
  }
  const source = nonEmptyString(record.source);
  if (!source) throw new Error(`${label}.source 必须是非空 string 或 object。`);
  if (record.path === undefined) return source;
  const sourcePath = nonEmptyString(record.path);
  if (!sourcePath) throw new Error(`${label}.path 必须是非空 string。`);
  return source === 'directory' ? sourcePath : null;
}

type ClaudeMarketplaceState = 'absent' | 'canonical' | 'foreign';

function classifyClaudeMarketplaceSources(
  sources: Array<string | null | undefined>,
  awHome: string,
): ClaudeMarketplaceState {
  if (sources.some((source) =>
    source === null || (source !== undefined && path.normalize(source) !== awHome))) {
    return 'foreign';
  }
  return sources.some((source) => source !== undefined) ? 'canonical' : 'absent';
}

function readClaudeKnownMarketplaceSources(value: unknown, label: string): Array<string | null | undefined> {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 记录无效。`);
  }
  const record = value as Record<string, unknown>;
  const sources: Array<string | null | undefined> = [];
  if (record.installLocation !== undefined) {
    const installLocation = nonEmptyString(record.installLocation);
    if (!installLocation) throw new Error(`${label}.installLocation 必须是非空 string。`);
    sources.push(installLocation);
  }
  sources.push(readClaudeMarketplaceSourcePath(record.source, `${label}.source`));
  return sources;
}

async function readClaudeNativeState(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceName?: string;
  marketplaceRoot?: string;
}): Promise<{
  paths: ReturnType<typeof resolveClaudePaths>;
  marketplaceState: ClaudeMarketplaceState;
  marketplaceDeclaredState: ClaudeMarketplaceState;
  marketplaceMaterializedState: ClaudeMarketplaceState;
  legacyMarketplaceState: ClaudeMarketplaceState;
  pluginState: 'absent' | 'present' | 'foreign';
  pluginEnabled: boolean;
  records: ClaudeNativeRecord[];
  marketplaceConsumers: ClaudeMarketplaceConsumer[];
  marketplaceConsumerEvidence: boolean;
  unboundPluginNames: string[];
  pluginVersions: string[];
}> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const awHome = path.normalize(options.marketplaceRoot ?? resolveAwHome(options.env));
  const settings = await readJsonObjectIfExists(paths.settingsPath, 'Claude settings');
  const known = await readJsonObjectIfExists(paths.knownMarketplacesPath, 'Claude known_marketplaces');
  const installed = await readJsonObjectIfExists(paths.installedPluginsPath, 'Claude installed_plugins');
  if (settings.extraKnownMarketplaces !== undefined && (
    !settings.extraKnownMarketplaces
    || typeof settings.extraKnownMarketplaces !== 'object'
    || Array.isArray(settings.extraKnownMarketplaces)
  )) throw new Error('Claude settings.extraKnownMarketplaces 必须是 object。');
  if (settings.plugins !== undefined && (
    !settings.plugins || typeof settings.plugins !== 'object' || Array.isArray(settings.plugins)
  )) throw new Error('Claude settings.plugins 必须是 object。');
  if (settings.enabledPlugins !== undefined && (
    !settings.enabledPlugins
    || typeof settings.enabledPlugins !== 'object'
    || Array.isArray(settings.enabledPlugins)
  )) throw new Error('Claude settings.enabledPlugins 必须是 object。');
  const settingsPlugins = settings.plugins as Record<string, unknown> | undefined;
  if (settingsPlugins?.installed !== undefined && (
    !settingsPlugins.installed
    || typeof settingsPlugins.installed !== 'object'
    || Array.isArray(settingsPlugins.installed)
  )) throw new Error('Claude settings.plugins.installed 必须是 object。');
  if (known.marketplaces !== undefined && (
    !known.marketplaces || typeof known.marketplaces !== 'object' || Array.isArray(known.marketplaces)
  )) throw new Error('Claude known_marketplaces.marketplaces 必须是 object。');
  if (installed.plugins !== undefined && (
    !installed.plugins || typeof installed.plugins !== 'object' || Array.isArray(installed.plugins)
  )) throw new Error('Claude installed_plugins.plugins 必须是 object。');
  const extraKnown = settings.extraKnownMarketplaces as Record<string, unknown> | undefined;
  const settingsSourceValue = extraKnown?.[marketplaceName];
  const settingsSource = readClaudeMarketplaceSourcePath(
    settingsSourceValue,
    'Claude settings marketplace aw',
  );
  const legacyKnown = known.marketplaces as Record<string, unknown> | undefined;
  const marketplaceDeclaredState = classifyClaudeMarketplaceSources([settingsSource], awHome);
  const marketplaceMaterializedState = classifyClaudeMarketplaceSources(
    readClaudeKnownMarketplaceSources(
      known[marketplaceName],
      'Claude known marketplace aw',
    ),
    awHome,
  );
  const legacyMarketplaceState = classifyClaudeMarketplaceSources(
    readClaudeKnownMarketplaceSources(
      legacyKnown?.[marketplaceName],
      'Claude known marketplace aw legacy',
    ),
    awHome,
  );
  const marketplaceStates = [
    marketplaceDeclaredState,
    marketplaceMaterializedState,
    legacyMarketplaceState,
  ];
  const marketplaceState = marketplaceStates.includes('foreign')
    ? 'foreign'
    : marketplaceStates.includes('canonical')
      ? 'canonical'
      : 'absent';
  const pluginId = `${options.pluginName}@${marketplaceName}`;
  const enabledPlugins = settings.enabledPlugins as Record<string, unknown> | undefined;
  const rawEnabled = enabledPlugins?.[pluginId];
  if (
    rawEnabled !== undefined
    && typeof rawEnabled !== 'boolean'
    && (!Array.isArray(rawEnabled) || !rawEnabled.every((entry) => typeof entry === 'string'))
  ) {
    throw new Error(`Claude settings.enabledPlugins 记录 ${pluginId} 必须是 boolean 或 string array。`);
  }
  const pluginEnabled = rawEnabled === true || Array.isArray(rawEnabled);
  const enabledPluginEvidence = rawEnabled !== undefined;
  const records: ClaudeNativeRecord[] = [];
  const unboundPluginNames = new Set<string>();
  for (const [pluginKey, raw] of Object.entries(
    (installed.plugins as Record<string, unknown> | undefined) ?? {},
  )) {
    for (const entry of Array.isArray(raw) ? raw : [raw]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 必须是 object。`);
      }
      const record = entry as Record<string, unknown>;
      const version = nonEmptyString(record.version);
      if (!version) throw new Error(`Claude installed_plugins 记录 ${pluginKey} 缺少 version。`);
      if (
        record.scope !== undefined
        && record.scope !== 'user'
        && record.scope !== 'project'
        && record.scope !== 'local'
      ) {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 的 scope 无效。`);
      }
      if (record.projectPath !== undefined && typeof record.projectPath !== 'string') {
        throw new Error(`Claude installed_plugins 记录 ${pluginKey} 的 projectPath 无效。`);
      }
      const marketplaceSeparator = pluginKey.lastIndexOf('@');
      const keyedMarketplace = marketplaceSeparator > 0 && marketplaceSeparator < pluginKey.length - 1
        ? pluginKey.slice(marketplaceSeparator + 1)
        : undefined;
      if (!pluginKey.includes('@') && record.marketplace === undefined) {
        unboundPluginNames.add(pluginKey);
      }
      records.push({
        name: typeof record.name === 'string'
          ? record.name
          : keyedMarketplace ? pluginKey.slice(0, marketplaceSeparator) : pluginKey,
        marketplace: typeof record.marketplace === 'string'
          ? record.marketplace
          : keyedMarketplace,
        scope: record.scope === 'project' || record.scope === 'local' ? record.scope : 'user',
        ...(typeof record.projectPath === 'string' ? { projectPath: record.projectPath } : {}),
        version,
      });
    }
  }
  const projectPath = options.scope === 'project' ? path.normalize(await resolveRepoRoot(options.cwd)) : undefined;
  const matchingRecords = records.filter((record) =>
    record.name === options.pluginName
    && record.marketplace === marketplaceName
    && record.scope === options.scope
    && (options.scope === 'user' || path.normalize(record.projectPath ?? '') === projectPath));
  const settingsInstalled = settingsPlugins?.installed as Record<string, unknown> | undefined;
  const rawSettingsRecord = settingsInstalled?.[options.pluginName];
  if (rawSettingsRecord !== undefined && (
    !rawSettingsRecord || typeof rawSettingsRecord !== 'object' || Array.isArray(rawSettingsRecord)
  )) throw new Error(`Claude settings plugin 记录 ${options.pluginName} 必须是 object。`);
  const settingsRecord = rawSettingsRecord as Record<string, unknown> | undefined;
  if (settingsRecord && !nonEmptyString(settingsRecord.version)) {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 缺少 version。`);
  }
  if (settingsRecord && !nonEmptyString(settingsRecord.marketplace)) {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 缺少 marketplace。`);
  }
  if (settingsRecord?.scope !== undefined
    && settingsRecord.scope !== 'user'
    && settingsRecord.scope !== 'project'
    && settingsRecord.scope !== 'local') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 scope 无效。`);
  }
  if (settingsRecord?.projectPath !== undefined && typeof settingsRecord.projectPath !== 'string') {
    throw new Error(`Claude settings plugin 记录 ${options.pluginName} 的 projectPath 无效。`);
  }
  const settingsMatchesScope = settingsRecord
    && settingsRecord.marketplace === marketplaceName
    && (settingsRecord.scope ?? 'user') === options.scope
    && (options.scope === 'user'
      || path.normalize((settingsRecord.projectPath as string | undefined) ?? '') === projectPath);
  const canonicalEvidence = matchingRecords.length > 0
    || Boolean(settingsMatchesScope)
    || enabledPluginEvidence;
  const foreign = canonicalEvidence && marketplaceState === 'foreign';
  const canonicalRecords = matchingRecords;
  const canonicalSettingsRecord = settingsMatchesScope;
  const marketplaceConsumerSuffix = `@${marketplaceName}`;
  const hasMarketplaceConsumerKey = (pluginKey: string): boolean =>
    pluginKey.length > marketplaceConsumerSuffix.length
    && pluginKey.endsWith(marketplaceConsumerSuffix);
  const marketplaceConsumerEvidence = records.some((record) =>
    record.marketplace === marketplaceName)
    || Object.keys(enabledPlugins ?? {}).some(hasMarketplaceConsumerKey)
    || Object.entries(settingsInstalled ?? {}).some(([pluginKey, raw]) =>
      hasMarketplaceConsumerKey(pluginKey)
      || (raw !== null
        && typeof raw === 'object'
        && !Array.isArray(raw)
        && (raw as Record<string, unknown>).marketplace === marketplaceName));
  const marketplaceConsumers: ClaudeMarketplaceConsumer[] = records
    .filter((record) => record.marketplace === marketplaceName)
    .map((record) => ({
      name: record.name,
      scope: record.scope,
      ...(record.projectPath ? { projectPath: record.projectPath } : {}),
    }));
  for (const pluginKey of Object.keys(enabledPlugins ?? {})) {
    const suffix = `@${marketplaceName}`;
    if (!pluginKey.endsWith(suffix)) continue;
    marketplaceConsumers.push({
      name: pluginKey.slice(0, -suffix.length),
      scope: options.scope,
      ...(projectPath ? { projectPath } : {}),
    });
  }
  for (const [pluginKey, rawRecord] of Object.entries(settingsInstalled ?? {})) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue;
    const record = rawRecord as Record<string, unknown>;
    if (record.marketplace !== marketplaceName) continue;
    const name = nonEmptyString(record.name)
      ?? (pluginKey.endsWith(`@${marketplaceName}`)
        ? pluginKey.slice(0, -`@${marketplaceName}`.length)
        : pluginKey);
    const scope = record.scope === 'project' || record.scope === 'local' ? record.scope : 'user';
    marketplaceConsumers.push({
      name,
      scope,
      ...(typeof record.projectPath === 'string' ? { projectPath: record.projectPath } : {}),
    });
  }
  const pluginState = foreign
    ? 'foreign'
    : canonicalEvidence
      ? 'present'
      : 'absent';
  const pluginVersions = [
    ...canonicalRecords.map((record) => record.version),
    ...(canonicalSettingsRecord ? [nonEmptyString(settingsRecord.version)!] : []),
  ];
  return {
    paths,
    marketplaceState,
    marketplaceDeclaredState,
    marketplaceMaterializedState,
    legacyMarketplaceState,
    pluginState,
    pluginEnabled,
    records,
    marketplaceConsumers,
    marketplaceConsumerEvidence,
    unboundPluginNames: [...unboundPluginNames],
    pluginVersions,
  };
}

export async function assertNoClaudeUnboundNativeNameCollision(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const state = await readClaudeNativeState({
    pluginName: options.pluginName,
    scope: 'user',
    cwd: options.cwd,
    env: options.env,
  });
  if (state.unboundPluginNames.includes(options.pluginName)) {
    throw new Error(
      `externalOwnershipPresent: Claude has an unbound installed plugin named ${options.pluginName}; native install would overwrite it.`,
    );
  }
}

export async function inspectNativeMarketplaceRegistrations(options: {
  marketplaceName: string;
  marketplaceRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<'codex' | 'claude', 'absent' | 'canonical' | 'foreign'>> {
  const codexConfig = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const codexMarketplace = codexConfig.snapshot.marketplaces[options.marketplaceName];
  const codexRegistration = codexMarketplace === undefined
    ? 'absent'
    : codexMarketplace.sourceType === 'local'
      && !codexMarketplace.sourcePointsToManifest
      && path.normalize(codexMarketplace.source ?? '') === path.normalize(options.marketplaceRoot)
      ? 'canonical'
      : 'foreign';
  const codexConsumerSuffix = `@${options.marketplaceName}`;
  const codex = codexRegistration === 'absent'
    && Object.keys(codexConfig.snapshot.plugins).some((pluginId) =>
      pluginId.length > codexConsumerSuffix.length && pluginId.endsWith(codexConsumerSuffix))
    ? 'foreign'
    : codexRegistration;
  const claudeState = await readClaudeNativeState({
    pluginName: '__marketplace_preflight__',
    scope: 'user',
    cwd: options.cwd,
    env: options.env,
    marketplaceName: options.marketplaceName,
    marketplaceRoot: options.marketplaceRoot,
  });
  const claude = claudeState.marketplaceState === 'absent'
    && claudeState.marketplaceConsumerEvidence
    ? 'foreign'
    : claudeState.marketplaceState;
  return { codex, claude };
}

export async function applyPlannedOperationAction(action: OperationAction): Promise<void> {
  if (action.kind !== 'updateSharedConfig' || action.mutation.kind !== 'claude-permissions'
    || action.locator.kind !== 'claude-permissions') {
    throw new Error('platformContributionUnsupported: expected a Claude permissions contribution.');
  }
  const settings = await readClaudeSettings(action.locator.settingsPath);
  rebuildClaudePermissions(settings, action.locator.ownerKey, action.mutation.permissions as ClaudePermissions);
  await writeClaudeSettings(action.locator.settingsPath, settings);
}

function createNativeDriver(options: {
  targets: DesiredTarget[];
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
  operationScopedNativePhases?: boolean;
}): RebuildTargetDriver & {
  setNativeMarketplaceEligibleTargets(targets: readonly DesiredTarget[]): void;
  prepareNativeMarketplaceGroup(target: DesiredTarget): Promise<void>;
  captureCodexPostMutationSnapshots(marketplaceNames?: readonly string[]): Promise<void>;
} {
  const runner = options.context.nativeCliRunner;
  const revokeAtRoot = async (root: string, recursive = false, platform?: PlatformName): Promise<void> => {
    const listed = await listManagedCommands(options.context.env);
    const producers = new Map<string, import('../types.js').ProducerIdentity>();
    for (const command of listed.commands) {
      if (command.owner.kind !== 'plugin' || !command.resourceRoot) continue;
      if (platform && command.owner.producer.platform !== platform) continue;
      const relative = path.relative(path.resolve(root), path.resolve(command.resourceRoot));
      if (relative !== '' && (!recursive || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) continue;
      producers.set(getCommandPackageId(command.owner.producer), command.owner.producer);
    }
    for (const producer of producers.values()) {
      const removedCommandIds = await revokeManagedCommandBindings(producer, options.context.env);
      options.context.commandResults ??= [];
      options.context.commandResults.push({ producer, state: 'completed', commandIds: [], removedCommandIds, errors: [], recoveryActions: [] });
    }
  };
  const publishPackages = async (target: DesiredTarget): Promise<void> => {
    const cache = options.context.managedCommandProducerCache ??= new Map();
    for (const action of target.operationActions ?? []) {
      if (action.kind !== 'syncManagedCommandPackage') continue;
      const key = getCommandPackageId(action.producer);
      let publication = cache.get(key);
      if (!publication) {
        publication = (async (): Promise<CommandProducerResult> => {
          await options.context.reporter.event({ type: 'managed-command:producer', source: { plugin: action.producer.pluginName, scope: action.producer.scope }, data: { packageKey: action.producer.key, phase: 'start' } });
          const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-command-publish-'));
          try {
            const digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(action.files)).digest('hex')}`;
            if (digest !== action.contentDigest) throw new ManagedCommandError('commandResourceInvalid', 'The prepared command package digest changed.');
            const resourceRoot = path.join(temporary, 'resource');
            await fs.ensureDir(resourceRoot);
            for (const file of action.files) {
              const content = Buffer.from(file.contentBase64, 'base64');
              if (`sha256:${crypto.createHash('sha256').update(content).digest('hex')}` !== file.contentDigest) throw new ManagedCommandError('commandResourceInvalid', 'The prepared command package file digest changed.');
              const destination = path.join(resourceRoot, ...file.relativePath.split('/'));
              await fs.outputFile(destination, content);
              await fs.chmod(destination, file.mode);
            }
            const result = await syncManagedCommandPackage({ producer: action.producer, sourceDirectory: resourceRoot, sets: action.sets, nativeTools: action.nativeTools, env: options.context.env });
            await options.context.reporter.event({ type: 'managed-command:producer', source: { plugin: action.producer.pluginName, scope: action.producer.scope }, data: { packageKey: action.producer.key, phase: 'success' } });
            return { producer: action.producer, state: 'completed', commandIds: result.commandIds, removedCommandIds: result.removedCommandIds, errors: [], recoveryActions: [] };
          } catch (error) {
            await options.context.reporter.event({ type: 'managed-command:producer', source: { plugin: action.producer.pluginName, scope: action.producer.scope }, data: { packageKey: action.producer.key, phase: 'failure' } });
            return { producer: action.producer, state: 'failed', commandIds: [], removedCommandIds: [], errors: [managedCommandDiagnostic(error)], recoveryActions: [`aw command package sync ${action.producer.sourceId}/${action.producer.pluginName} ${action.producer.key} --scope ${action.producer.scope} --yes`] };
          } finally { await fs.remove(temporary); }
        })();
        cache.set(key, publication);
      }
      const result = await publication;
      options.context.commandResults ??= [];
      if (!options.context.commandResults.some((entry) => getCommandPackageId(entry.producer) === key)) options.context.commandResults.push(result);
      if (result.state !== 'completed') throw new Error('commandPackagePublishFailed: sync the command package and retry the plugin operation.');
    }
  };
  const currentCodexManager = (): CodexManager | undefined => options.context.codexManager;
  const codexNativeStates = new Map<string, 'present' | 'absent'>();
  const pendingCodexNativeStates = new Map<string, 'present' | 'absent'>();
  const codexMutationMarketplaces = new Set<string>();
  let nativeMarketplaceEligibleTargets: ReadonlySet<DesiredTarget> | undefined;
  let deferredPostchecks: Array<{ target: DesiredTarget; postcheck: () => Promise<void> }> = [];
  const nativeGroupKey = (target: DesiredTarget): string => [
    target.identity.sourceId ?? '',
    target.identity.sourceIdentity ?? '',
    target.identity.marketplaceName ?? MARKETPLACE_NAME,
    path.normalize(path.resolve(target.identity.marketplaceRoot ?? resolveAwHome(options.context.env))),
  ].join('\0');
  const observationScopeFor = (target: DesiredTarget): 'user' | 'both' =>
    codexObservationScope(
      options.context,
      target.identity.marketplaceName ?? MARKETPLACE_NAME,
      target.identity.scope,
    );
  const groupTargets = (target: DesiredTarget): DesiredTarget[] => {
    if (!options.operationScopedNativePhases) return [target];
    const key = nativeGroupKey(target);
    return options.targets.filter((candidate) =>
      nativeGroupKey(candidate) === key
      && (nativeMarketplaceEligibleTargets?.has(candidate) ?? true));
  };
  const findTarget = (component: OwnedComponent): DesiredTarget => {
    const target = options.targets.find((entry) =>
      entry.identity.pluginName === component.identity.plugin
      && entry.identity.sourceId === component.identity.sourceId
      && entry.identity.platform === component.identity.platform
      && entry.identity.scope === component.identity.scope);
    if (!target) throw new Error('Ownership executor cannot resolve its desired target.');
    return target;
  };
  const codexStateKey = (target: DesiredTarget, pluginId: string): string =>
    `${nativeGroupKey(target)}\0${pluginId}`;
  const runObservedCodexMutation = async <T>(options_: {
    marketplaceName: string;
    mutation: () => Promise<T>;
  }): Promise<T> => runCodexMutationWithInvalidation({
    ...options_,
    ...(options.operationScopedNativePhases
      ? {}
      : { observationSession: options.context.codexObservationSession }),
  });
  const prepareNativeGroup = async (target: DesiredTarget): Promise<void> => {
    for (const member of groupTargets(target)) {
      if (member.identity.platform !== 'codex') continue;
      for (const component of member.ownedComponents) {
        if (component.kind !== 'native-plugin') continue;
        const registration = await inspectCodexPluginRegistrationLive({ pluginId: component.pluginId,
          cwd: member.identity.cwd, env: options.context.env, nativeCliRunner: runner,
          manager: currentCodexManager(), scope: observationScopeFor(member),
          observationSession: options.context.codexObservationSession });
        codexNativeStates.set(codexStateKey(member, component.pluginId),
          requireObservedCodexNativeState(registration.observation, 'native cleanup precheck') === 'installed' ? 'present' : 'absent');
      }
    }
  };
  const inspectCodexMarketplace = async (
    component: Extract<OwnedComponent, { kind: 'shared-config' | 'managed-block' }>,
  ): Promise<'present' | 'absent' | 'foreign'> => {
    if (component.locator.kind !== 'codex-marketplace') throw new Error('Invalid Codex marketplace locator.');
    const target = findTarget(component);
    const configPath = resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath;
    const config = await readCodexConfigFile(configPath);
    const marketplace = config.snapshot.marketplaces[component.locator.marketplaceName];
    const canonical = !marketplace
      ? 'absent' as const
      : marketplace.sourceType === 'local'
        && !marketplace.sourcePointsToManifest
        && path.normalize(marketplace.source ?? '') === path.normalize(component.locator.marketplaceRoot)
        ? 'present' as const
        : 'foreign' as const;
    if (component.locator.desired) {
      if (canonical !== 'present') return canonical;
      const pluginId = `${component.identity.plugin}@${component.locator.marketplaceName}`;
      return config.snapshot.plugins[pluginId]?.enabled === true ? 'present' : 'absent';
    }
    if (canonical !== 'present') return canonical;
    const suffix = `@${component.locator.marketplaceName}`;
    const currentPluginId = `${component.identity.plugin}${suffix}`;
    const projectConfig = await readCodexConfigFile(
      resolveCodexPaths(target.identity.cwd, 'project', options.context.env).configTomlPath,
    );
    const configuredPluginIds = [
      ...Object.keys(config.snapshot.plugins),
      ...Object.keys(projectConfig.snapshot.plugins),
    ].filter((pluginId) => pluginId.endsWith(suffix));
    if (configuredPluginIds.some((pluginId) => pluginId !== currentPluginId)) return 'absent';

    const ownedSession = options.context.codexObservationSession ? undefined
      : await createCodexNativeObservationSession({
          exactCwd: target.identity.cwd,
          env: options.context.env,
          runner,
          manager: currentCodexManager() ?? SYSTEM_CODEX_MANAGER,
        });
    const session = options.context.codexObservationSession ?? ownedSession!;
    try {
      const observationScope = observationScopeFor(target);
      const snapshot = await session.snapshot(component.locator.marketplaceName, observationScope);
      if (!snapshot.neutral || (observationScope === 'both' && !snapshot.exact)) return 'absent';
      const officialPluginIds = new Set([
        ...(snapshot.exact?.keys() ?? []),
        ...snapshot.neutral.keys(),
      ]);
      return [...officialPluginIds].some((pluginId) => pluginId !== currentPluginId)
        ? 'absent'
        : 'present';
    } finally {
      await ownedSession?.dispose();
    }
  };
  const inspectClaudeMarketplace = async (
    component: Extract<OwnedComponent, { kind: 'shared-config' | 'managed-block' }>,
  ): Promise<'present' | 'absent' | 'foreign'> => {
    if (component.locator.kind !== 'claude-marketplace') throw new Error('Invalid Claude marketplace locator.');
    const target = findTarget(component);
    const state = await readClaudeNativeState({
      pluginName: component.identity.plugin,
      scope: component.identity.scope,
      cwd: target.identity.cwd,
      env: options.context.env,
      marketplaceName: component.locator.marketplaceName,
      marketplaceRoot: component.locator.marketplaceRoot,
    });
    if (state.pluginState === 'foreign') return 'foreign';
    if (component.locator.desired) {
      return state.marketplaceDeclaredState === 'canonical'
        && state.marketplaceMaterializedState === 'canonical'
        && state.pluginState === 'present'
        && state.pluginEnabled
        ? 'present'
        : 'absent';
    }
    if (state.marketplaceState !== 'canonical') return state.marketplaceState;
    const projectPath = component.identity.scope === 'project'
      ? path.normalize(await resolveRepoRoot(target.identity.cwd))
      : undefined;
    return state.marketplaceConsumers.some((consumer) => !(
      consumer.name === component.identity.plugin
      && consumer.scope === component.identity.scope
      && (component.identity.scope === 'user'
        || path.normalize(consumer.projectPath ?? '') === projectPath)
    )) ? 'absent' : 'present';
  };
  const ownership: OwnedComponentExecutor = {
    inspectShared: async (component) => {
      const locator = component.locator;
      switch (locator.kind) {
        case 'cursor-workspace-hook':
          return platformOwnership.inspectShared(component);
        case 'claude-permissions':
          return (await readClaudeSettings(locator.settingsPath)).awGenerated
            ?.permissions?.[locator.ownerKey] ? 'present' : 'absent';
        case 'codex-instruction':
          return (await readCodexConfigFile(locator.configPath)).snapshot
            .developerInstructions.managedBlocks[locator.ownerKey] ? 'present' : 'absent';
        case 'codex-activation': {
          const actual = (await readCodexConfigFile(locator.configPath))
            .snapshot.plugins[locator.codexPluginId]?.enabled;
          if (locator.disposition === 'remove') return actual === undefined ? 'absent' : 'present';
          if (locator.disposition === 'disable') return actual === true ? 'present' : 'absent';
          return actual === locator.desired ? 'present' : 'absent';
        }
        case 'legacy-codex-mcp': {
          const actual = (await readCodexConfigFile(locator.configPath))
            .snapshot.mcpServers[locator.serverKey];
          if (!actual) return 'absent';
          return legacyCodexMcpOwner(actual) === locator.ownerKey ? 'present' : 'foreign';
        }
        case 'legacy-codex-hook':
          return (await readLegacyCodexHooks(locator.hooksPath)).managedIdentities.some((entry) =>
            serializeTrackedHookGroupIdentity(entry) === locator.serializedIdentity)
            ? 'present'
            : 'absent';
        case 'codex-role-registration': {
          const registration = (await readCodexConfigFile(locator.configPath))
            .snapshot.agents[locator.roleKey];
          if (!registration) return 'absent';
          return await codexRoleRegistrationOwned({
            fileIdentity: locator.fileIdentity,
            configPath: locator.configPath,
            roleKey: locator.roleKey,
            rolePath: locator.rolePath,
            registration,
          }) ? 'present' : 'foreign';
        }
        case 'codex-marketplace':
          return inspectCodexMarketplace(component);
        case 'claude-marketplace':
          return inspectClaudeMarketplace(component);
        case 'corrupted':
          throw new Error(locator.message);
      }
    },
    removeShared: async (component) => {
      const locator = component.locator;
      switch (locator.kind) {
        case 'cursor-workspace-hook':
          return platformOwnership.removeShared(component);
        case 'claude-permissions': {
          const settings = await readClaudeSettings(locator.settingsPath);
          rebuildClaudePermissions(settings, locator.ownerKey);
          await writeClaudeSettings(locator.settingsPath, settings);
          return;
        }
        case 'codex-instruction':
          await applyCodexConfigTransactionFile(locator.configPath, {
            removeManagedInstructionPluginName: locator.ownerKey,
          });
          return;
        case 'codex-activation':
          await applyConditionalCodexConfigTransactionFile(locator.configPath, (snapshot) => {
            const actual = snapshot.plugins[locator.codexPluginId]?.enabled;
            if (locator.disposition === 'remove') {
              return actual === undefined ? null : { removePluginActivations: [locator.codexPluginId] };
            }
            if (locator.disposition === 'disable') {
              return actual === true
                ? { upsertPluginActivations: { [locator.codexPluginId]: false } }
                : null;
            }
            return { removePluginActivations: [locator.codexPluginId] };
          });
          return;
        case 'legacy-codex-mcp':
          await applyConditionalCodexConfigTransactionFile(locator.configPath, (snapshot) =>
            legacyCodexMcpOwner(snapshot.mcpServers[locator.serverKey]) === locator.ownerKey
              ? { removeMcpServers: [locator.serverKey] }
              : null);
          return;
        case 'legacy-codex-hook':
          await applyLegacyCodexHookCleanupTransactionFile(locator.hooksPath, (parsed) => {
            let removed = false;
            const remaining = parsed.groups.flatMap((entry) => {
              if (!removed && entry.managedIdentity
                && serializeTrackedHookGroupIdentity(entry.managedIdentity) === locator.serializedIdentity) {
                removed = true;
                return [];
              }
              return [entry.rawGroup];
            });
            return removed ? remaining : null;
          });
          return;
        case 'codex-role-registration':
          await applyConditionalCodexConfigTransactionFile(locator.configPath, async (snapshot) =>
            await codexRoleRegistrationOwned({
              fileIdentity: locator.fileIdentity,
              configPath: locator.configPath,
              roleKey: locator.roleKey,
              rolePath: locator.rolePath,
              registration: snapshot.agents[locator.roleKey],
            }) ? { removeAgentRegistrations: [locator.roleKey] } : null);
          return;
        case 'codex-marketplace': {
          if (locator.desired) return;
          const target = findTarget(component);
          await prepareNativeGroup(target);
          const pluginId = `${target.identity.pluginName}@${locator.marketplaceName}`;
          const stateKey = codexStateKey(target, pluginId);
          if (codexNativeStates.get(stateKey) === 'present'
            && pendingCodexNativeStates.get(stateKey) !== 'absent') return;
          codexMutationMarketplaces.add(locator.marketplaceName);
          await runObservedCodexMutation({
            marketplaceName: locator.marketplaceName,
            mutation: () => runNativeCliChecked(
              buildCodexMarketplaceRemoveInvocation(
                currentCodexManager() ?? SYSTEM_CODEX_MANAGER,
                locator.marketplaceName,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            ),
          });
          return;
        }
        case 'claude-marketplace': {
          return;
        }
        case 'corrupted':
          throw new Error(locator.message);
      }
    },
    validateSkillDirectory: async (component) => {
      await validateSkillDirectory(
        component.path,
        component.identity.platform === 'codex' ? 'codex.skill' : 'claude.skill',
        { ownerMarkerPolicy: 'ignore', requirementsReceiptPolicy: 'allow' },
      );
    },
    skillDirectoryMatchesPristineTree: async ({ actualPath, files }) => {
      const expectedFiles = new Map(files.map((entry) => [entry.relativePath, entry]));
      const expectedDirectories = new Set<string>(['']);
      for (const relativePath of expectedFiles.keys()) {
        const segments = relativePath.split('/');
        for (let index = 1; index < segments.length; index += 1) {
          expectedDirectories.add(segments.slice(0, index).join('/'));
        }
      }
      const seen = new Set<string>();
      const pending = [{ absolutePath: actualPath, relativePath: '' }];
      while (pending.length > 0) {
        const current = pending.pop()!;
        for (const entry of await fs.readdir(current.absolutePath, { withFileTypes: true })) {
          const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) return false;
          const absolutePath = path.join(current.absolutePath, entry.name);
          if (entry.isDirectory()) {
            if (!expectedDirectories.has(relativePath)) return false;
            pending.push({ absolutePath, relativePath });
            continue;
          }
          if (!entry.isFile()) return false;
          const digest = `sha256:${crypto.createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex')}`;
          const expected = expectedFiles.get(relativePath);
          if (expected?.contentDigest !== digest) return false;
          if (catalogFileMode(relativePath, (await fs.stat(absolutePath)).mode)
            !== catalogFileMode(relativePath, expected.mode ?? 0o644)) return false;
          seen.add(relativePath);
        }
      }
      return seen.size === expectedFiles.size;
    },
  };
  return {
    ownership,
    beforeCleanupMutation: async (component) => {
      if (component.kind === 'skill-directory') await revokeAtRoot(component.path);
    },
    setNativeMarketplaceEligibleTargets: (eligibleTargets) => {
      nativeMarketplaceEligibleTargets = new Set(eligibleTargets);
    },
    prepareNativeMarketplaceGroup: prepareNativeGroup,
    ...(options.operationScopedNativePhases ? {
      deferPostcheck: (target: DesiredTarget, postcheck: () => Promise<void>): boolean => {
        if (target.identity.platform !== 'codex') return false;
        deferredPostchecks.push({
          target,
          postcheck: async () => {
            if (target.requiresNative) {
              const marketplaceName = target.identity.marketplaceName ?? MARKETPLACE_NAME;
              const pluginId = `${target.identity.pluginName}@${marketplaceName}`;
              const registration = await inspectCodexPluginRegistrationLive({
                pluginId,
                cwd: target.identity.cwd,
                env: options.context.env,
                nativeCliRunner: runner,
                manager: currentCodexManager(),
                scope: observationScopeFor(target),
                observationSession: options.context.codexObservationSession,
              });
              const state = requireObservedCodexNativeState(
                registration.observation,
                'native install postcheck',
              );
              requireCodexObservationCoverage(
                registration,
                observationScopeFor(target),
                'native install postcheck',
              );
              if (state !== 'installed') {
                throw new Error(
                  `codexNativeInstallIncomplete: ${pluginId} is absent from Codex plugin list.`,
                );
              }
              const installedEntry = registration.observation.state === 'observed'
                && registration.observation.value === 'installed'
                ? registration.observation.entry
                : undefined;
              if (installedEntry?.version !== undefined
                && installedEntry.version !== target.identity.pluginVersion) {
                throw new Error(
                  `codexNativeInstallIncomplete: ${pluginId} version is ${installedEntry.version}; expected ${target.identity.pluginVersion}.`,
                );
              }
            }
            await postcheck();
          },
        });
        return true;
      },
      completePostchecks: async (): Promise<readonly DeferredRebuildPostcheckFailure[]> => {
        const pending = deferredPostchecks;
        deferredPostchecks = [];
        const failures: DeferredRebuildPostcheckFailure[] = [];
        for (const entry of pending) {
          try {
            await entry.postcheck();
          } catch (error) {
            failures.push({ target: entry.target, error });
          }
        }
        return failures;
      },
    } : {}),
    captureCodexPostMutationSnapshots: async (marketplaceNames = []) => {
      for (const marketplaceName of marketplaceNames) {
        codexMutationMarketplaces.add(marketplaceName);
      }
      const changedMarketplaces = [...codexMutationMarketplaces];
      const marketplaces = [...new Set([...changedMarketplaces, ...deferredPostchecks.flatMap(({ target }) =>
        (target.platformDeployment?.plans ?? []).flatMap((plan) => plan.evidence.layout.marketplaceName
          && plan.projections.some((projection) => projection.bundle) ? [plan.evidence.layout.marketplaceName] : []))])].sort();
      if (marketplaces.length === 0) return;
      const session = options.context.codexObservationSession;
      if (!session) {
        throw new Error('codexNativeObservationUnavailable: grouped postcheck requires an observation session.');
      }
      codexMutationMarketplaces.clear();
      // Platform mutations already invalidated and observed their generation.
      // Only legacy writes still deferred in the dirty set need invalidation.
      for (const marketplaceName of changedMarketplaces) session.invalidate(marketplaceName);
      await Promise.all(marketplaces.map((marketplaceName) =>
        session.snapshot(
          marketplaceName,
          options.context.codexObservationScopeByMarketplace?.get(marketplaceName)
            ?? (options.targets.some((target) =>
              (nativeMarketplaceEligibleTargets?.has(target) ?? true)
              && target.identity.platform === 'codex'
              && (target.platformDeployment ? target.platformDeployment.plans.some((plan) =>
                plan.evidence.layout.marketplaceName === marketplaceName && plan.binding.scope.kind === 'project')
                : (target.identity.marketplaceName ?? MARKETPLACE_NAME) === marketplaceName && target.identity.scope === 'project'))
              ? 'both'
              : 'user'),
        )));
    },
    preflightMutation: async (target) => {
      await assertManagedCommandBindingIdentities({ producers: (target.operationActions ?? []).flatMap((action) =>
        action.kind === 'syncManagedCommandPackage' ? [{ producer: action.producer, sets: action.sets, nativeTools: action.nativeTools }] : []),
      env: options.context.env });
    },
    preflightMaterialize: async (target) => {
      if (target.identity.sourceId && options.context.expectedCatalogConfigDigest) {
        const current = await readCatalogSourcesConfigSnapshot(options.context.env);
        if (current.digest !== options.context.expectedCatalogConfigDigest) {
          throw new Error('catalogSourceConflict: catalog source config changed before owner publication.');
        }
      }
      if (target.identity.platform === 'claude') await assertNoClaudeUnboundNativeNameCollision({
        pluginName: target.identity.pluginName, cwd: target.identity.cwd, env: options.context.env });
    },
    finalizeCleanup: async (target) => {
      for (const action of target.operationActions ?? []) {
        if (action.kind !== 'retainManagedCommandPackage') continue;
        options.context.commandResults ??= [];
        if (!options.context.commandResults.some((result) => getCommandPackageId(result.producer) === action.packageId)) options.context.commandResults.push(retainedManagedCommandPackageResult(action));
      }
    },
    probeNative: async (component) => {
      const target = findTarget(component);
      if (!target) throw new Error('Native ownership probe cannot resolve its desired target.');
      if (target.identity.platform === 'claude') {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName: target.identity.marketplaceName,
          marketplaceRoot: target.identity.marketplaceRoot,
        });
        return state.pluginState;
      }
      if (target.identity.platform === 'codex') {
        const pending = pendingCodexNativeStates.get(codexStateKey(target, component.pluginId));
        if (pending) return pending;
        const registration = await inspectCodexPluginRegistrationLive({
          pluginId: component.pluginId,
          cwd: target.identity.cwd,
          env: options.context.env,
          nativeCliRunner: runner,
          manager: currentCodexManager(),
          scope: observationScopeFor(target),
          observationSession: options.context.codexObservationSession,
        });
        return observedCodexNativeState(registration.observation, 'native probe');
      }
      return 'absent';
    },
    probeNativeHealth: async (component) => {
      const target = findTarget(component);
      if (!target) throw new Error('Native health probe cannot resolve its desired target.');
      if (target.identity.platform === 'claude') {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName: target.identity.marketplaceName,
          marketplaceRoot: target.identity.marketplaceRoot,
        });
        if (state.pluginState !== 'present') return state.pluginState;
        if (!state.pluginEnabled) return 'partial';
        return 'present';
      }
      if (target.identity.platform === 'codex') {
        const pluginId = `${target.identity.pluginName}@${target.identity.marketplaceName ?? MARKETPLACE_NAME}`;
        const registration = await inspectCodexPluginRegistrationLive({
          pluginId,
          cwd: target.identity.cwd,
          env: options.context.env,
          nativeCliRunner: runner,
          manager: currentCodexManager(),
          scope: observationScopeFor(target),
          observationSession: options.context.codexObservationSession,
        });
        const nativeState = observedCodexNativeState(
          registration.observation,
          'native health postcheck',
        );
        if (nativeState !== 'present') return nativeState;
        const userConfig = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const userEnabled = userConfig.snapshot.plugins[pluginId]?.enabled === true;
        if (target.identity.scope === 'user') return userEnabled ? 'present' : 'partial';
        const projectConfig = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'project', options.context.env).configTomlPath,
        );
        return userEnabled || projectConfig.snapshot.plugins[pluginId]?.enabled === true
          ? 'present'
          : 'partial';
      }
      return 'absent';
    },
    removeNative: async (component) => {
      const target = findTarget(component);
      if (!target) throw new Error('Native ownership removal cannot resolve its desired target.');
      await prepareNativeGroup(target);
      if (target.identity.platform === 'codex') {
        const marketplaceName = component.pluginId.slice(component.pluginId.lastIndexOf('@') + 1);
        const stateKey = codexStateKey(target, component.pluginId);
        const before = pendingCodexNativeStates.get(stateKey) ?? codexNativeStates.get(stateKey);
        if (!before) {
          throw new Error('codexNativeObservationUnavailable: native group precheck is missing.');
        }
        const removalRequired = before === 'present';
        if (!removalRequired) {
          await revokeAtRoot(path.join(target.identity.marketplaceRoot ?? resolveAwHome(options.context.env), 'plugins', target.identity.pluginName), true, 'codex');
          return;
        }
        try {
          codexMutationMarketplaces.add(marketplaceName);
          await runObservedCodexMutation({
            marketplaceName,
            mutation: () => runNativeCliChecked(
              buildCodexPluginRemoveInvocation(
                requireCodexManager(currentCodexManager()),
                component.pluginId,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            ),
          });
        } catch (error) {
          const diagnostic = readSafeOperationError(error);
          throw attachSafeOperationError(
            new Error(`codexNativeRemoveFailed: ${CODEX_REMOVE_RECOVERY}`),
            {
              code: 'codexNativeRemoveFailed',
              safeMessage: `Codex plugin removal did not complete. ${CODEX_REMOVE_RECOVERY}`,
              ...(diagnostic?.exitCode === undefined ? {} : { exitCode: diagnostic.exitCode }),
              ...(diagnostic ? {
                cause: { code: diagnostic.code, safeMessage: diagnostic.safeMessage },
              } : {}),
            },
          );
        }
        pendingCodexNativeStates.set(stateKey, 'absent');
        const postcheck = async () => {
          const after = await inspectCodexPluginRegistrationLive({
            pluginId: component.pluginId,
            cwd: target.identity.cwd,
            env: options.context.env,
            nativeCliRunner: runner,
            manager: currentCodexManager(),
            scope: observationScopeFor(target),
            observationSession: options.context.codexObservationSession,
          });
          const expected = pendingCodexNativeStates.get(stateKey) ?? 'absent';
          const observed = requireObservedCodexNativeState(
            after.observation,
            'native mutation postcheck',
          );
          if ((observed === 'installed' ? 'present' : 'absent') !== expected) {
            throw new Error(expected === 'absent'
              ? `codexNativeRemoveIncomplete: ${CODEX_REMOVE_RECOVERY}`
              : `codexNativeInstallIncomplete: ${component.pluginId} is absent from Codex plugin list.`);
          }
          if (expected === 'absent') await revokeAtRoot(path.join(target.identity.marketplaceRoot ?? resolveAwHome(options.context.env), 'plugins', target.identity.pluginName), true, 'codex');
        };
        if (options.operationScopedNativePhases) {
          deferredPostchecks.push({ target, postcheck });
        } else {
          await postcheck();
        }
      } else {
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'uninstall', component.pluginId, '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'list'],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        const after = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName: target.identity.marketplaceName,
          marketplaceRoot: target.identity.marketplaceRoot,
        });
        if (after.pluginState !== 'absent') {
          throw new Error(`Claude native uninstall 后仍有 ${after.pluginState} plugin evidence。`);
        }
      }
    },
    applyManagedCommands: publishPackages,
    writeNative: async () => { throw new Error('platformDeploymentRequired: native writes require a frozen platform deployment.'); },
    writeArtifacts: async (target) => {
      if (target.artifacts.length > 0) throw new Error('platformDeploymentRequired: platform output requires a frozen platform deployment.');
      return [];
    },
    runPreApply: async (invocation: RebuildPreApplyInvocation) => {
      if (isNativeActivationOnlyTarget(options.context, invocation.target.identity)) return;
      const run = () => runPreApplyScript({
        plugin: invocation.plugin,
        platform: invocation.target.identity.platform,
        scope: invocation.target.identity.scope,
        cwd: invocation.target.identity.cwd,
        context: options.context,
        referencePlugins: options.context.referencePlugins,
        scriptTimeoutMs: options.scriptTimeoutMs,
      });
      const cache = options.context.preApplyExecutionCache;
      if (!cache) {
        await run();
        return;
      }
      const { identity } = invocation.target;
      const sourceIdentity = invocation.plugin.sourceIdentity ?? identity.sourceIdentity;
      const pluginId = invocation.plugin.pluginId ?? identity.pluginId;
      if (!sourceIdentity || !pluginId) {
        await run();
        return;
      }
      const projectKey = identity.scope === 'project'
        ? identity.platform === 'codex'
          ? await resolveCodexProjectKey(identity.cwd)
          : identity.platform === 'claude'
            ? await resolveClaudeProjectKey(identity.cwd)
            : createProjectLocationKey(await resolveRequiredCanonicalRepoRoot(identity.cwd))
        : '';
      const key = [
        sourceIdentity,
        pluginId,
        identity.platform,
        identity.scope,
        projectKey,
      ].join('\0');
      let execution = cache.get(key);
      if (!execution) {
        execution = run();
        cache.set(key, execution);
      }
      await execution;
    },
  };
}

export function isNativeActivationOnlyTarget(
  context: Pick<RebuildExecutionContext, 'nativeActivationOnlyTargets'>,
  identity: Pick<RebuildTargetIdentity, 'pluginId' | 'platform' | 'scope'>,
): boolean {
  return context.nativeActivationOnlyTargets?.some((target) =>
    target.pluginId === identity.pluginId
    && target.platform === identity.platform
    && target.scope === identity.scope) === true;
}

export function createRebuildIntegration(options: {
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
  preparedTargets?: readonly DesiredTarget[];
  operationScopedNativePhases?: boolean;
}): RebuildIntegration {
  options.context.scriptTimeoutMs ??= options.scriptTimeoutMs;
  const targets = [...(options.preparedTargets ?? [])];
  const driver = createNativeDriver({ targets, ...options });
  const renderResults = options.context.preparedArtifactRenderResults ??= new Map();
  const packageCache = options.context.packagePreparationCache
    ?? commandPackageCandidates.get(renderResults) ?? new Map<string, Promise<PreparedManagedCommandPackage>>();
  commandPackageCandidates.set(renderResults, packageCache);
  options.context.packagePreparationCache = packageCache;
  const platformSession = options.context.platformRebuildSession
    ?? platformRebuildSessions.get(renderResults)
    ?? new PlatformRebuildSession(options.context);
  platformRebuildSessions.set(renderResults, platformSession);
  options.context.platformRebuildSession = platformSession;
  platformSession.updateContext(options.context);
  platformSession.setOwnershipExecutor(driver.ownership);
  return {
    resolvePlatformTargets: (inputs) => platformSession.resolveAll(inputs),
    sealMarketplaceGenerations: (eligible) => platformSession.sealMarketplaceGenerations(eligible),
    driver,
    setNativeMarketplaceEligibleTargets: driver.setNativeMarketplaceEligibleTargets,
    prepareNativeMarketplaceGroup: driver.prepareNativeMarketplaceGroup,
    captureCodexPostMutationSnapshots: driver.captureCodexPostMutationSnapshots,
    buildTarget: async (input) => {
      const target = await platformSession.buildTarget(input);
      if (!input.readOnlyInspectionPlan) {
        const removed = input.command === 'cleanup' || input.command === 'uninstall';
        const commands = removed ? { actions: [], candidates: [] }
          : await commandPackageActions({ ...input, env: options.context.env, context: options.context });
        const retained = removed ? await discoverRetainedManagedCommandPackages({
          selectors: [{ sourceId: input.sourceId ?? input.plugin.sourceId, pluginName: input.plugin.manifest.name }],
          scope: input.scope, cwd: input.cwd, env: options.context.env }) : [];
        const operationActions: OperationAction[] = [...commands.actions, ...retained.map((entry) => ({ ...entry,
          kind: 'retainManagedCommandPackage' as const, pluginId: `${entry.producer.sourceId}/${entry.producer.pluginName}`,
          scope: entry.producer.scope }))];
        options.context.managedCommandCandidates ??= new Map();
        options.context.managedCommandCandidates.set(pluginActionId(input.plugin), commands.candidates);
        const preApply = input.plugin.manifest.scripts?.preApply;
        if (preApply && !removed && !isNativeActivationOnlyTarget(options.context, target.identity)) operationActions.push({ kind: 'runPreApply',
          pluginId: input.pluginId ?? pluginActionId(input.plugin), platform: input.platform, scope: input.scope,
          script: preApply.path, scriptDigest: `sha256:${crypto.createHash('sha256')
            .update(await fs.readFile(path.resolve(input.plugin.rootDir, preApply.path.replace(/^\.\//u, '')))).digest('hex')}` });
        const nativeToolChanges = await captureNativeToolChanges({ actions: operationActions,
          producers: commands.candidates.map((candidate) => candidate.producer), removed, env: options.context.env });
        if (nativeToolChanges.length) operationActions[0]!.nativeToolChanges = nativeToolChanges;
        target.operationActions = operationActions;
      }
      targets.push(target);
      return target;
    },
  };
}

export async function inspectRebuildTarget(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  marketplaceName?: string;
  marketplaceRoot?: string;
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  catalog: CatalogResolution;
  context: RebuildExecutionContext;
  userActivationDesired?: ReadonlySet<string>;
  nativeProbe?: NativeOwnershipProbe;
  shallow?: boolean;
}): Promise<{
  target: DesiredTarget;
  inspection: OwnershipInspection;
  installedVersion?: string;
}> {
  const integration = createRebuildIntegration({
    context: {
      ...options.context,
      codexUserActivationDesired: options.userActivationDesired
        ?? options.context.codexUserActivationDesired,
    },
  });
  const target = await integration.buildTarget({
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      pluginId: options.pluginId,
      marketplaceName: options.marketplaceName,
      marketplaceRoot: options.marketplaceRoot,
    } : {}),
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    command: 'install',
    catalog: options.catalog,
    readOnlyInspectionPlan: true,
    readOnlyShallowInspectionPlan: options.shallow,
  });
  const inspection = await inspectOwnedComponents({
    components: target.ownedComponents,
    executor: integration.driver.ownership,
    nativeProbe: options.nativeProbe
      ?? integration.driver.probeNativeHealth
      ?? integration.driver.probeNative,
    verifyHealth: true,
  });
  if (!target.requiresNative) return { target, inspection };
  if (target.identity.platform === 'codex') {
    const nativeInspection = inspection.components.find((component) =>
      component.component.kind === 'native-plugin');
    if (nativeInspection?.state !== 'present') return { target, inspection };
    const registration = await inspectCodexPluginRegistrationLive({
      pluginId: `${target.identity.pluginName}@${target.identity.marketplaceName ?? MARKETPLACE_NAME}`,
      cwd: target.identity.cwd,
      env: options.context.env,
      nativeCliRunner: options.context.nativeCliRunner,
      manager: options.context.codexManager,
      scope: target.identity.scope,
      observationSession: options.context.codexObservationSession,
    });
    return registration.observation.state === 'observed'
      && registration.observation.value === 'installed'
      && registration.observation.entry.version !== undefined
      ? { target, inspection, installedVersion: registration.observation.entry.version }
      : { target, inspection };
  }
  const native = await readClaudeNativeState({
    pluginName: target.identity.pluginName,
    scope: target.identity.scope,
    cwd: target.identity.cwd,
    env: options.context.env,
    marketplaceName: target.identity.marketplaceName,
    marketplaceRoot: target.identity.marketplaceRoot,
  });
  const versions = [...new Set(native.pluginVersions)];
  return native.marketplaceState === 'canonical'
    && native.pluginState === 'present'
    && native.pluginEnabled
    && versions.length === 1
    ? { target, inspection, installedVersion: versions[0] }
    : { target, inspection };
}

async function discoverOwnerNamesInTextRoot(
  root: string,
  platform: PlatformName,
  scope: Scope,
): Promise<string[]> {
  if (!await fs.pathExists(root)) return [];
  const names = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const raw = await fs.readFile(entryPath, 'utf8').catch(() => '');
      if (!raw.includes(OWNED_TEXT_HEADER_PREFIX)) continue;
      const parsed = (() => {
        try { return parseOwnedTextHeader(raw); } catch { return null; }
      })();
      if (parsed?.identity.platform === platform && parsed.identity.scope === scope) {
        names.add(parsed.identity.plugin);
      }
    }
  }
  return [...names];
}

async function discoverOwnerNamesInSkillRoot(
  root: string,
  platform: PlatformName,
  scope: Scope,
): Promise<string[]> {
  if (!await fs.pathExists(root)) return [];
  const names = new Set<string>();
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const marker = await readSkillOwnerMarker({
      skillRoot: path.join(root, entry.name),
      allowedRoot: root,
    }).catch(() => null);
    if (marker?.platform === platform && marker.scope === scope) names.add(marker.plugin);
  }
  return [...names];
}

export async function discoverRebuildTargetNames(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformName;
  scope: Scope;
  nativeCliRunner: NativeCliRunner;
  nativeFailureMode?: 'error' | 'ignore';
  marketplaceName?: string;
  marketplaceRoot?: string;
}): Promise<string[]> {
  if (options.scope === 'project') {
    const canonicalRepoRoot = await assertCanonicalProjectManagedRoots({
      cwd: options.cwd,
      rootNames: options.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
      managedPaths: options.platform === 'codex'
        ? ['.codex/config.toml']
        : ['.claude/settings.json'],
    });
    options = { ...options, cwd: canonicalRepoRoot };
  }
  const names = new Set<string>();
  const paths = options.platform === 'codex'
    ? resolveCodexPaths(options.cwd, options.scope, options.env)
    : resolveClaudePaths(options.cwd, options.scope, options.env);
  const textRoots = [path.join(paths.configDir, 'rules'), path.join(paths.configDir, 'agents')];
  for (const name of (await Promise.all(textRoots.map((root) =>
    discoverOwnerNamesInTextRoot(root, options.platform, options.scope)))).flat()) names.add(name);
  const skillRoots = options.platform === 'codex'
    ? options.scope === 'project'
      ? []
      : [path.join(resolveAwHome(options.env), 'plugins')]
    : [path.join(paths.configDir, 'skills')];
  if (options.platform === 'codex' && options.scope === 'user') {
    const pluginsRoot = skillRoots[0]!;
    if (await fs.pathExists(pluginsRoot)) {
      for (const pluginEntry of await fs.readdir(pluginsRoot, { withFileTypes: true })) {
        if (!pluginEntry.isDirectory()) continue;
        const pluginRoot = path.join(pluginsRoot, pluginEntry.name);
        const platformManifest = await fs.readJson(
          path.join(pluginRoot, '.codex-plugin', 'plugin.json'),
        ).catch(() => null) as Record<string, unknown> | null;
        const relativeSkillsRoot = typeof platformManifest?.skills === 'string'
          ? path.posix.normalize(platformManifest.skills.replace(/^\.\//u, ''))
          : 'codex/skills';
        if (
          relativeSkillsRoot === '..'
          || relativeSkillsRoot.startsWith('../')
          || path.isAbsolute(relativeSkillsRoot)
        ) continue;
        for (const name of await discoverOwnerNamesInSkillRoot(
          path.join(pluginRoot, ...relativeSkillsRoot.split('/')),
          options.platform,
          options.scope,
        )) names.add(name);
      }
    }
  } else {
    for (const root of skillRoots) {
      for (const name of await discoverOwnerNamesInSkillRoot(root, options.platform, options.scope)) {
        names.add(name);
      }
    }
  }
  if (options.platform === 'codex') {
    const config = await readCodexConfigFile(
      resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
    );
    for (const name of Object.keys(config.snapshot.developerInstructions.managedBlocks)) {
      names.add(sharedOwnerPluginName(name));
    }
    if (options.scope === 'project') {
      const suffix = `@${options.marketplaceName ?? MARKETPLACE_NAME}`;
      for (const pluginId of Object.keys(config.snapshot.plugins)) {
        if (!pluginId.endsWith(suffix)) continue;
        const name = pluginId.slice(0, -suffix.length);
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) names.add(name);
      }
    } else {
      const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
      const marketplaceRoot = options.marketplaceRoot ?? resolveAwHome(options.env);
      const marketplace = config.snapshot.marketplaces[marketplaceName];
      const canonicalMarketplace = marketplace?.sourceType === 'local'
        && !marketplace.sourcePointsToManifest
        && path.normalize(marketplace.source ?? '') === path.normalize(marketplaceRoot);
      const suffix = `@${marketplaceName}`;
      const configuredPluginIds = Object.keys(config.snapshot.plugins)
        .filter((pluginId) => pluginId.endsWith(suffix));
      if (configuredPluginIds.length > 0 && !canonicalMarketplace) {
        throw new Error(
          `externalOwnershipPresent: Codex marketplace ${marketplaceName} has a foreign public config source.`,
        );
      }
      for (const pluginId of canonicalMarketplace ? configuredPluginIds : []) {
        const name = pluginId.slice(0, -suffix.length);
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) names.add(name);
      }
      const session = await createCodexNativeObservationSession({
        exactCwd: options.cwd,
        env: options.env,
        runner: options.nativeCliRunner,
      });
      try {
        const snapshot = await session.snapshot(marketplaceName, 'user');
        if (!snapshot.neutral) {
          if (options.nativeFailureMode !== 'ignore') {
            throw new Error('codexNativeObservationFailed: cannot discover official Codex plugins.');
          }
        } else {
          for (const pluginId of snapshot.neutral.keys()) {
            if (!pluginId.endsWith(suffix)) continue;
            const name = pluginId.slice(0, -suffix.length);
            if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) names.add(name);
          }
        }
      } finally {
        await session.dispose();
      }
    }
  } else {
    const settings = await readClaudeSettings(
      resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
    );
    for (const name of Object.keys(settings.awGenerated?.permissions ?? {})) {
      names.add(sharedOwnerPluginName(name));
    }
    const installed = await readJsonObjectIfExists(
      resolveClaudePaths(options.cwd, options.scope, options.env).installedPluginsPath,
      'Claude installed_plugins',
    );
    const installedPlugins = installed.plugins;
    if (installedPlugins !== undefined && (
      !installedPlugins || typeof installedPlugins !== 'object' || Array.isArray(installedPlugins)
    )) throw new Error('Claude installed_plugins.plugins 必须是 object。');
    const candidates = new Set<string>();
    for (const [pluginKey, raw] of Object.entries(
      (installedPlugins as Record<string, unknown> | undefined) ?? {},
    )) {
      for (const entry of Array.isArray(raw) ? raw : [raw]) {
        const record = entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : null;
        const name = typeof record?.name === 'string'
          ? record.name
          : pluginKey.includes('@') ? pluginKey.slice(0, pluginKey.indexOf('@')) : pluginKey;
        if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
      }
    }
    const rawSettings = await readJsonObjectIfExists(
      resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
      'Claude settings',
    );
    const settingsPlugins = rawSettings.plugins;
    const settingsInstalled = settingsPlugins
      && typeof settingsPlugins === 'object'
      && !Array.isArray(settingsPlugins)
      ? (settingsPlugins as Record<string, unknown>).installed
      : undefined;
    if (settingsInstalled !== undefined && (
      !settingsInstalled || typeof settingsInstalled !== 'object' || Array.isArray(settingsInstalled)
    )) throw new Error('Claude settings.plugins.installed 必须是 object。');
    for (const name of Object.keys(
      (settingsInstalled as Record<string, unknown> | undefined) ?? {},
    )) {
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
    }
    const enabledPlugins = rawSettings.enabledPlugins;
    if (enabledPlugins !== undefined && (
      !enabledPlugins || typeof enabledPlugins !== 'object' || Array.isArray(enabledPlugins)
    )) throw new Error('Claude settings.enabledPlugins 必须是 object。');
    for (const pluginId of Object.keys(
      (enabledPlugins as Record<string, unknown> | undefined) ?? {},
    )) {
      const suffix = `@${options.marketplaceName ?? MARKETPLACE_NAME}`;
      if (!pluginId.endsWith(suffix)) continue;
      const name = pluginId.slice(0, -suffix.length);
      if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) candidates.add(name);
    }
    for (const name of candidates) {
      const state = await readClaudeNativeState({
        pluginName: name,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        marketplaceName: options.marketplaceName,
        marketplaceRoot: options.marketplaceRoot,
      });
      if (state.pluginState === 'present') names.add(name);
    }
  }
  return [...names].sort();
}
