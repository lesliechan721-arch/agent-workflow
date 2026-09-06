import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import {
  generateInstructionArtifacts,
  renderCodexManagedInstructionBlock,
} from '../generators/instructions.js';
import {
  generateCodexPermissionArtifacts,
  mergeClaudePermissions,
  type ClaudePermissions,
} from '../generators/permissions.js';
import { buildGeneratedName } from '../generators/shared.js';
import type {
  CatalogResolution,
  CodexSharedHookGroup,
  GeneratedArtifact,
  MarketplaceManifest,
  PlatformName,
  PluginMeta,
  Scope,
  TrackedHookGroupIdentity,
} from '../types.js';
import type { CommandReporter, DebugLogger } from '../output/model.js';
import {
  applyConditionalCodexConfigTransactionFile,
  applyCodexConfigTransactionFile,
  composeManagedDeveloperInstructionsBlock,
  readCodexConfigFile,
  type CodexAgentRegistrationConfig,
  type CodexAgentRegistrationSnapshot,
  type CodexMcpServerSnapshot,
} from '../utils/codex-config.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
} from '../utils/codex-skill-staging.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  readDynamicSkillTree,
  validateSkillDirectory,
  writeDynamicSkillTree,
  type DynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import {
  parseCodexSharedHooksFile,
  serializeTrackedHookGroupIdentity,
} from '../utils/hooks-contract.js';
import {
  buildCodexMarketplaceAddInvocation,
  buildCodexMarketplaceRemoveInvocation,
  buildCodexPluginAddInvocation,
  buildCodexPluginRemoveInvocation,
  CodexProjectConfigNotEffectiveError,
  runNativeCliChecked,
  SYSTEM_CODEX_MANAGER,
  type CodexManager,
  type NativeCliRunner,
} from '../utils/native-cli.js';
import {
  OWNED_TEXT_HEADER_PREFIX,
  createSharedOwnerToken,
  createSkillOwnerMarkerContent,
  parseSharedOwnerToken,
  parseOwnedTextHeader,
  readSkillOwnerMarker,
  renderOwnedTextFile,
  inspectOwnedComponents,
  writeOwnedTextFile,
  type OwnedComponent,
  type OwnedComponentExecutor,
  type NativeOwnershipProbe,
  type OwnerIdentity,
  type OwnershipInspection,
} from '../utils/ownership.js';
import {
  resolveArtifactRenderConfig,
  resolveArtifactRendererTarget,
  runArtifactRenderer,
} from '../utils/artifact-renderer.js';
import {
  createArtifactConfigDigest,
  validateArtifactPlan,
  type ValidatedArtifactPlanArtifact,
} from '../utils/artifact-plan.js';
import { resolveAwDeliveredArtifactIds } from '../utils/artifact-request.js';
import {
  createAwPluginRequirementsReceipt,
} from '../utils/manifest.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveRepoRoot,
  getCodexHome,
} from '../utils/paths.js';
import {
  assertNoSensitiveConfigInFiles,
  collectSensitivePluginConfigValues,
  runPreApplyScript,
} from '../utils/plugin-scripts.js';
import { findSensitiveTokenPath } from '../utils/sensitive-content.js';
import {
  atomicRemoveConfigFile,
  atomicReplaceConfigFile,
  withConfigFileMutation,
} from '../utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  getNamespacedMarketplaceName,
  projectMarketplaceManifestForPlatform,
  readStrictNamespacedMarketplaceRoot,
  replayNamespacedCodexSkillOverlays,
} from '../utils/local-marketplace.js';
import { commitMarketplaceGenerationBackup } from '../utils/orphan-marketplace-cleanup.js';
import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings } from '../adapters/helpers.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import type { CodexReconcilePlan } from '../utils/codex-reconciler.js';
import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  codexNativeRenderProjectionsEqual,
  createCodexNativeRenderProjection,
  createCodexNativeRenderReceipt,
  parseCodexNativeRenderReceipt,
  serializeCodexNativeRenderReceipt,
  type CodexNativeRenderProjection,
  type CodexNativeRenderReceipt,
} from '../utils/codex-native-render-receipt.js';
import {
  inspectCodexSharedNative,
  type CodexSharedNativeInspection,
} from '../utils/codex-shared-native.js';
import { calculateCodexNativeRenderPayloadDigest } from '../utils/catalog-digests.js';
import {
  createCodexNativeObservationSession,
  type CodexNativeObservationSession,
  type CodexNativePluginObservation,
} from '../utils/codex-native-observation.js';
import { isSafeCodexMarketplaceRoot } from '../utils/codex-marketplace-path.js';
import { assertCanonicalProjectManagedRoots } from '../utils/project-boundary.js';
import {
  findCodexRoleNameConflict,
  resolveCodexRoleNamespace,
} from '../utils/codex-roles.js';
import type {
  DesiredTarget,
  RebuildPreApplyInvocation,
  DeferredRebuildPostcheckFailure,
  RebuildTargetIdentity,
  RebuildTargetDriver,
} from './rebuild-operations.js';
import type { OperationAction } from './operation-plan.js';

const MARKETPLACE_NAME = 'aw';
const LEGACY_MCP_OWNER_ENV = 'AW_AGENT_WORKFLOWS_OWNER';
type OwnedSharedComponent = Extract<OwnedComponent, { locator: unknown }>;

function requirementsReceipt(plugin: PluginMeta): Buffer {
  const receipt = createAwPluginRequirementsReceipt(
    { name: plugin.manifest.name, version: plugin.manifest.version },
    plugin.manifest.requires?.aw.capabilities ?? [],
  );
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

interface PlannedWrite {
  artifact: GeneratedArtifact;
  component?: OwnedComponent;
  additionalComponents?: OwnedComponent[];
  optional?: boolean;
  action?: OperationAction;
  additionalActions?: OperationAction[];
}

export interface RebuildIntegration {
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
    preserveCodexSharedNativePayload?: boolean;
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
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  codexManager?: CodexManager;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
  expectedCatalogConfigDigest?: string;
  codexUserActivationDesired?: ReadonlySet<string>;
  codexObservationSession?: CodexNativeObservationSession;
  codexObservationScopeByMarketplace?: ReadonlyMap<string, 'user' | 'both'>;
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
        ?? (options.plans.some((plan) => plan.requirement.requiresProjectPluginContract)
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
          ?? (options.plans.some((plan) => plan.requirement.requiresProjectPluginContract)
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

function ownerIdentity(
  plugin: string,
  artifactKey: string,
  platform: PlatformName,
  scope: Scope,
): OwnerIdentity {
  return { owner: 'agent-workflows', plugin, artifactKey, platform, scope };
}

function pluginOwnerIdentity(
  plugin: PluginMeta,
  artifactKey: string,
  platform: PlatformName,
  scope: Scope,
): OwnerIdentity {
  return {
    ...ownerIdentity(plugin.manifest.name, artifactKey, platform, scope),
    ...(plugin.sourceId ? {
      sourceId: plugin.sourceId,
      pluginId: plugin.pluginId,
    } : {}),
  };
}

function bindNamespacedOwnerIdentity(
  components: readonly OwnedComponent[],
  source: { sourceId?: string; pluginId?: string },
): void {
  if (!source.sourceId) return;
  for (const component of components) {
    component.identity.sourceId = source.sourceId;
    component.identity.pluginId = source.pluginId;
  }
}

function internalArtifactKey(kind: string, value: string): string {
  return `${kind}-${crypto.createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function pathComponent(options: {
  kind: 'owned-text-file' | 'skill-directory';
  path: string;
  allowedRoot: string;
  identity: OwnerIdentity;
  pristineTree?: Array<{ relativePath: string; contentDigest: string }>;
}): OwnedComponent {
  if (options.kind !== 'skill-directory') return options;
  return {
    ...options,
    validateHealth: true,
  };
}

function pristineTreeDescriptor(tree: DynamicSkillTree): Array<{
  relativePath: string;
  contentDigest: string;
}> {
  return Object.entries(tree.files)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, content]) => ({
      relativePath,
      contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    }));
}

function pluginActionId(plugin: PluginMeta): string {
  return plugin.pluginId ?? plugin.manifest.name;
}

function skillWriteAction(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  path: string;
  allowedRoot: string;
  identity: OwnerIdentity;
  tree: DynamicSkillTree;
  allowPristineUnowned: boolean;
}): Extract<OperationAction, { kind: 'writeOwnedArtifact' }> {
  const files = [
    ...Object.entries(options.tree.files).map(([relativePath, content]) => ({
      relativePath,
      contentBase64: content.toString('base64'),
      contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    })),
    {
      relativePath: '.agent-workflows-owner.json',
      contentBase64: Buffer.from(createSkillOwnerMarkerContent(options.identity)).toString('base64'),
      contentDigest: `sha256:${crypto.createHash('sha256')
        .update(createSkillOwnerMarkerContent(options.identity)).digest('hex')}`,
    },
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const contentDigest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
  return {
    kind: 'writeOwnedArtifact',
    pluginId: pluginActionId(options.plugin),
    platform: options.platform,
    scope: options.scope,
    path: options.path,
    allowedRoot: options.allowedRoot,
    owner: options.identity,
    artifactKind: 'skill-directory',
    files,
    contentDigest,
    allowPristineUnowned: options.allowPristineUnowned,
  };
}

function finalizeOwnedArtifactActions(actions: readonly OperationAction[]): void {
  for (const action of actions) {
    if (action.kind !== 'writeOwnedArtifact' || !action.owner) continue;
    if (action.artifactKind === 'owned-text-file') {
      if (action.sourceContent === undefined) throw new Error('Owned text action is missing source content.');
      action.content = renderOwnedTextFile(action.sourceContent, action.owner);
      action.contentDigest = `sha256:${crypto.createHash('sha256').update(action.content).digest('hex')}`;
      continue;
    }
    if (action.artifactKind === 'skill-directory') {
      const markerContent = createSkillOwnerMarkerContent(action.owner);
      const marker = {
        relativePath: '.agent-workflows-owner.json',
        contentBase64: Buffer.from(markerContent).toString('base64'),
        contentDigest: `sha256:${crypto.createHash('sha256').update(markerContent).digest('hex')}`,
      };
      action.files = [
        ...(action.files ?? []).filter((file) => file.relativePath !== marker.relativePath),
        marker,
      ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      action.contentDigest = `sha256:${crypto.createHash('sha256')
        .update(JSON.stringify(action.files)).digest('hex')}`;
    }
  }
}

function generatedTextWrite(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  configDir: string;
  relativePath: string;
  artifactKey: string;
  content: string;
  kind: GeneratedArtifact['kind'];
}): PlannedWrite {
  const artifactPath = path.join(options.configDir, options.relativePath);
  const identity = ownerIdentity(
    options.plugin.manifest.name,
    options.artifactKey,
    options.platform,
    options.scope,
  );
  const component = pathComponent({
    kind: 'owned-text-file',
    path: artifactPath,
    allowedRoot: options.configDir,
    identity,
  });
  const content = options.content;
  return {
    artifact: {
      path: artifactPath,
      kind: options.kind,
      platform: options.platform,
      artifactKey: options.artifactKey,
    },
    component,
    action: {
      kind: 'writeOwnedArtifact',
      pluginId: pluginActionId(options.plugin),
      platform: options.platform,
      scope: options.scope,
      path: artifactPath,
      allowedRoot: options.configDir,
      owner: identity,
      artifactKind: 'owned-text-file',
      sourceContent: content,
      content,
      contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
    },
  };
}

function mergePermissionStates(values: Array<Partial<ClaudePermissions> | undefined>): ClaudePermissions {
  return {
    allow: [...new Set(values.flatMap((value) => value?.allow ?? []))],
    ask: [...new Set(values.flatMap((value) => value?.ask ?? []))],
    deny: [...new Set(values.flatMap((value) => value?.deny ?? []))],
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
  };
}

function rebuildClaudePermissions(settings: ClaudeSettings, ownerKey: string, desired?: ClaudePermissions): void {
  const previousGenerated = mergePermissionStates(
    Object.values(settings.awGenerated?.permissions ?? {}),
  );
  const currentPermissions = mergePermissionStates([settings.permissions]);
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
  if (manual.allow.length || manual.ask.length || manual.deny.length) {
    settings.awGenerated.manualPermissions = manual;
  } else {
    delete settings.awGenerated.manualPermissions;
  }
  settings.permissions = mergePermissionStates([
    manual,
    ...Object.values(settings.awGenerated.permissions ?? {}),
  ]);
  if (
    settings.awGenerated.permissions === undefined
    && settings.awGenerated.manualPermissions === undefined
    && settings.awGenerated.hooks === undefined
    && settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

function createClaudePermissionsComponent(options: {
  identity: OwnerIdentity;
  scope: Scope;
  settingsPath: string;
}): OwnedSharedComponent & { kind: 'shared-config' } {
  const ownerKey = createSharedOwnerToken(options.identity);
  return {
    kind: 'shared-config',
    identity: options.identity,
    label: `${options.settingsPath}#awGenerated.permissions.${ownerKey}`,
    locator: { kind: 'claude-permissions', settingsPath: options.settingsPath, ownerKey },
  };
}

function createCodexInstructionComponent(options: {
  identity: OwnerIdentity;
  scope: Scope;
  configPath: string;
}): OwnedSharedComponent & { kind: 'managed-block' } {
  const ownerKey = createSharedOwnerToken(options.identity);
  return {
    kind: 'managed-block',
    identity: options.identity,
    label: `${options.configPath}#developer_instructions:${ownerKey}`,
    locator: { kind: 'codex-instruction', configPath: options.configPath, ownerKey },
  };
}

function createCodexActivationComponent(options: {
  identity: OwnerIdentity;
  configPath: string;
  codexPluginId: string;
  desired: boolean;
}): OwnedComponent {
  return {
    kind: 'shared-config',
    identity: options.identity,
    label: `${options.configPath}#plugins.${options.codexPluginId}.enabled`,
    locator: {
      kind: 'codex-activation',
      configPath: options.configPath,
      codexPluginId: options.codexPluginId,
      desired: options.desired,
    },
  };
}

function createCodexActivationCleanupComponent(options: {
  identity: OwnerIdentity;
  configPath: string;
  codexPluginId: string;
  disposition: 'remove' | 'disable';
}): OwnedComponent {
  return {
    kind: 'shared-config',
    identity: options.identity,
    label: `${options.configPath}#plugins.${options.codexPluginId}.enabled`,
    locator: {
      kind: 'codex-activation',
      configPath: options.configPath,
      codexPluginId: options.codexPluginId,
      desired: options.disposition === 'remove' ? false : true,
      disposition: options.disposition,
    },
  };
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

function createLegacyCodexMcpCleanupComponent(options: {
  identity: OwnerIdentity;
  configPath: string;
  serverKey: string;
}): OwnedComponent {
  const ownerKey = createSharedOwnerToken(options.identity);
  return {
    kind: 'shared-config',
    identity: options.identity,
    label: `${options.configPath}#mcp_servers.${options.serverKey}`,
    locator: {
      kind: 'legacy-codex-mcp',
      configPath: options.configPath,
      serverKey: options.serverKey,
      ownerKey,
    },
  };
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

function createLegacyCodexHookCleanupComponent(options: {
  pluginName: string;
  scope: Scope;
  hooksPath: string;
  identity: TrackedHookGroupIdentity;
}): OwnedComponent {
  const serialized = serializeTrackedHookGroupIdentity(options.identity);
  return {
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('hook', serialized),
      'codex',
      options.scope,
    ),
    label: `${options.hooksPath}#${serialized}`,
    locator: {
      kind: 'legacy-codex-hook',
      hooksPath: options.hooksPath,
      serializedIdentity: serialized,
    },
  };
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

function createCodexRoleRegistrationComponent(options: {
  identity: OwnerIdentity;
  fileIdentity: OwnerIdentity;
  configPath: string;
  roleKey: string;
  rolePath: string;
}): OwnedSharedComponent & { kind: 'shared-config' } {
  return {
    kind: 'shared-config',
    identity: options.identity,
    label: `${options.configPath}#agents.${options.roleKey}`,
    locator: {
      kind: 'codex-role-registration',
      configPath: options.configPath,
      roleKey: options.roleKey,
      rolePath: options.rolePath,
      fileIdentity: options.fileIdentity,
    },
  };
}

function sameOwnerIdentity(left: OwnerIdentity, right: OwnerIdentity): boolean {
  return left.owner === right.owner
    && left.sourceId === right.sourceId
    && left.pluginId === right.pluginId
    && left.plugin === right.plugin
    && left.artifactKey === right.artifactKey
    && left.platform === right.platform
    && left.scope === right.scope;
}

function sharedOwnerPluginName(value: string): string {
  return parseSharedOwnerToken(value)?.plugin ?? value;
}

async function scanCodexSharedComponents(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  scope: Scope;
  paths: ReturnType<typeof resolveCodexPaths>;
  scanConfig: boolean;
  ignoreReadErrors?: boolean;
}): Promise<OwnedComponent[]> {
  const output: OwnedComponent[] = [];
  const expectedIdentity = (artifactKey: string): OwnerIdentity => ({
    ...ownerIdentity(options.pluginName, artifactKey, 'codex', options.scope),
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      pluginId: options.pluginId,
    } : {}),
  });
  const corruptedComponent = (filePath: string, error: unknown): OwnedComponent => ({
    kind: 'shared-config',
    identity: ownerIdentity(
      options.pluginName,
      internalArtifactKey('corrupted-shared-config', filePath),
      'codex',
      options.scope,
    ),
    label: filePath,
    locator: {
      kind: 'corrupted',
      message: `包含 ${options.pluginName} 的 AW ownership 证据，但共享配置无法解析：${error instanceof Error ? error.message : String(error)}`,
    },
  });
  const containsOwnedEvidence = (raw: string): boolean => raw.includes(options.pluginName) && (
    raw.includes('[[aw-managed:start plugin=')
    || raw.includes(OWNED_TEXT_HEADER_PREFIX)
    || raw.includes('agent-workflows')
  );
  if (options.scanConfig) {
    const config = await readCodexConfigFile(options.paths.configTomlPath).catch(async (error) => {
      if (!options.ignoreReadErrors) throw error;
      const raw = await fs.readFile(options.paths.configTomlPath, 'utf8').catch(() => '');
      if (containsOwnedEvidence(raw)) {
        output.push(corruptedComponent(options.paths.configTomlPath, error));
      }
      return null;
    });
    const instructionIdentity = expectedIdentity('developer-instructions');
    const instructionOwnerKey = createSharedOwnerToken(instructionIdentity);
    if (config?.snapshot.developerInstructions.managedBlocks[instructionOwnerKey]) {
      output.push(createCodexInstructionComponent({
        identity: instructionIdentity,
        scope: options.scope,
        configPath: options.paths.configTomlPath,
      }));
    }
    for (const [roleKey, registration] of Object.entries(config?.snapshot.agents ?? {})) {
      if (!registration.configFile) continue;
      const rolePath = path.resolve(path.dirname(options.paths.configTomlPath), registration.configFile);
      const raw = await fs.readFile(rolePath, 'utf8').catch(() => '');
      const parsed = (() => {
        try { return parseOwnedTextHeader(raw); } catch { return null; }
      })();
      if (!parsed || !sameOwnerIdentity(parsed.identity, expectedIdentity(roleKey))) continue;
      output.push(createCodexRoleRegistrationComponent({
        identity: expectedIdentity(internalArtifactKey('role', roleKey)),
        fileIdentity: expectedIdentity(roleKey),
        configPath: options.paths.configTomlPath,
        roleKey,
        rolePath,
      }));
    }
  }
  return output;
}

async function scanClaudeSharedComponents(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  scope: Scope;
  settingsPath: string;
}): Promise<OwnedComponent[]> {
  const settings = await readClaudeSettings(options.settingsPath);
  const identity: OwnerIdentity = {
    ...ownerIdentity(options.pluginName, 'permissions', 'claude', options.scope),
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      pluginId: options.pluginId,
    } : {}),
  };
  return settings.awGenerated?.permissions?.[createSharedOwnerToken(identity)]
    ? [createClaudePermissionsComponent({ ...options, identity })]
    : [];
}

async function scanOwnedTextFiles(options: {
  sourceId?: string;
  sourceIdentity?: string;
  root: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
}): Promise<OwnedComponent[]> {
  if (!await fs.pathExists(options.root)) return [];
  const output: OwnedComponent[] = [];
  const pending = [options.root];
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
      let parsed: ReturnType<typeof parseOwnedTextHeader>;
      try {
        parsed = parseOwnedTextHeader(raw);
      } catch {
        continue;
      }
      if (
        parsed?.identity.plugin !== options.pluginName
        || (options.sourceId !== undefined && parsed.identity.sourceId !== options.sourceId)
        || parsed.identity.platform !== options.platform
        || parsed.identity.scope !== options.scope
      ) continue;
      output.push(pathComponent({
        kind: 'owned-text-file',
        path: entryPath,
        allowedRoot: options.root,
        identity: parsed.identity,
      }));
    }
  }
  return output;
}

async function scanOwnedSkills(options: {
  sourceId?: string;
  sourceIdentity?: string;
  root: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  recursive?: boolean;
}): Promise<OwnedComponent[]> {
  if (!await fs.pathExists(options.root)) return [];
  const output: OwnedComponent[] = [];
  const pending = [options.root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const skillRoot = path.join(current, entry.name);
      const marker = await readSkillOwnerMarker({
        skillRoot,
        allowedRoot: current,
      }).catch(() => null);
      if (
        marker?.plugin === options.pluginName
        && (options.sourceId === undefined || marker.sourceId === options.sourceId)
        && marker.platform === options.platform
        && marker.scope === options.scope
      ) {
        output.push(pathComponent({
          kind: 'skill-directory',
          path: skillRoot,
          allowedRoot: current,
          identity: marker,
        }));
        continue;
      }
      if (options.recursive !== false) pending.push(skillRoot);
    }
  }
  return output;
}

function componentIdentityKey(component: OwnedComponent): string {
  return [
    component.kind,
    component.identity.artifactKey,
    'path' in component ? path.resolve(component.path) : 'label' in component ? component.label : component.pluginId,
  ].join('\0');
}

function dedupeComponents(components: OwnedComponent[]): OwnedComponent[] {
  const seen = new Set<string>();
  return components.filter((component) => {
    const key = componentIdentityKey(component);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function preflightCodexWriteSafety(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const pluginName = options.plugin.manifest.name;
  const userConfigPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const projectConfigPath = resolveCodexPaths(options.cwd, 'project', options.env).configTomlPath;
  const nativeSurface = analyzeCodexSurface(options.plugin.manifest).nativeKinds.length > 0;
  const needsUserConfig = options.scope === 'user'
    || nativeSurface;
  let userConfig: Awaited<ReturnType<typeof readCodexConfigFile>> | undefined;
  if (needsUserConfig) {
    try {
      userConfig = await readCodexConfigFile(userConfigPath);
    } catch (error) {
      throw new Error(
        `codexProjectUserConfigUnreadable: 无法解析用户级 Codex 配置 ${userConfigPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (options.scope === 'project' && userConfig) {
    const expectedPluginId = `${pluginName}@${options.plugin.marketplaceName ?? MARKETPLACE_NAME}`;
    for (const [key, plugin] of Object.entries(userConfig.snapshot.plugins)) {
      if (
        key !== expectedPluginId
        && (key === pluginName || key.startsWith(`${pluginName}@`) || plugin.name === pluginName)
      ) {
        throw new Error(`externalOwnershipPresent: 用户级 Codex 已存在同名外部插件 ${key}。`);
      }
    }
  }

  const roleKeys = new Set(
    (options.plugin.manifest.artifacts?.targets ?? [])
      .filter((target) =>
        target.platform === 'codex'
        && target.scopes.includes(options.scope)
        && target.target === 'codex.agentRole'
        && target.roleKey)
      .map((target) => target.roleKey!),
  );
  const needsProjectConfig = options.scope === 'project' && Boolean(
    nativeSurface
    || resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex').length > 0
    || (options.plugin.manifest.artifacts?.targets ?? []).some((target) =>
      target.platform === 'codex'
      && target.scopes.includes('project')
      && (
        target.target === 'codex.agentRole'
        || target.target === 'codex.developerInstructionsBlock'
      )),
  );
  if (needsProjectConfig) {
    try {
      await readCodexConfigFile(projectConfigPath);
    } catch (error) {
      throw new Error(
        `projectConfigUnreadable: 无法解析项目级 Codex 配置 ${projectConfigPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (roleKeys.size === 0) return;

  for (const configPath of options.scope === 'project'
    ? [projectConfigPath]
    : [userConfigPath]) {
    const configScope: Scope = configPath === userConfigPath ? 'user' : 'project';
    const ownedRolePaths: string[] = [];
    const ownedRoleKeys: string[] = [];
    for (const roleKey of roleKeys) {
      const rolePath = path.join(
        path.dirname(configPath),
        'agents',
        `${buildGeneratedName(pluginName, roleKey)}.toml`,
      );
      const raw = await fs.readFile(rolePath, 'utf8').catch(() => '');
      try {
        if (parseOwnedTextHeader(
          raw,
          pluginOwnerIdentity(options.plugin, roleKey, 'codex', configScope),
        )) {
          ownedRolePaths.push(rolePath);
          ownedRoleKeys.push(roleKey);
        }
      } catch {
        // A foreign file remains external below.
      }
    }
    let namespace: Awaited<ReturnType<typeof resolveCodexRoleNamespace>>;
    try {
      namespace = await resolveCodexRoleNamespace(configPath, {
        strict: true,
        awManagedTableKeys: ownedRoleKeys,
        awManagedRoleLayerPaths: ownedRolePaths,
      });
    } catch (error) {
      throw new Error(
        `projectConfigUnreadable: 无法读取 Codex role namespace ${configPath}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const roleKey of roleKeys) {
      const tableCollision = namespace.roles.find((role) =>
        role.source === 'registration' && role.tableKey === roleKey && !role.awManaged);
      const nameConflict = findCodexRoleNameConflict(namespace, roleKey);
      if (tableCollision || nameConflict?.conflict) {
        throw new Error(`roleNameConflict: Codex role "${roleKey}" 已由外部配置占用（${configPath}）。`);
      }
    }
  }
}

function renderCodexRole(options: {
  roleKey: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: string;
}): string {
  const stringValue = (value: string): string => JSON.stringify(value.trim());
  return [
    `name = ${stringValue(options.roleKey)}`,
    `description = ${stringValue(options.description)}`,
    `developer_instructions = ${stringValue(options.developerInstructions)}`,
    ...(options.model ? [`model = ${stringValue(options.model)}`] : []),
    ...(options.modelReasoningEffort
      ? [`model_reasoning_effort = ${stringValue(options.modelReasoningEffort)}`]
      : []),
    '',
  ].join('\n');
}

async function resolveDynamicArtifacts(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install';
  previousArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
}): Promise<{
  artifacts: ValidatedArtifactPlanArtifact[];
  sourceDirs(artifact: ValidatedArtifactPlanArtifact): string[];
  sensitiveValues: string[];
}> {
  const requestedArtifactIds = resolveAwDeliveredArtifactIds({
    manifest: options.plugin.manifest,
    platform: options.platform,
    scope: options.scope,
  });
  if (requestedArtifactIds.length === 0) {
    return { artifacts: [], sourceDirs: () => [], sensitiveValues: [] };
  }
  const render = await runArtifactRenderer({
    event: options.event,
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.env,
    previousArtifacts: [...options.previousArtifacts],
    requestedArtifactIds,
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  const config = await resolveArtifactRenderConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const artifacts = validateArtifactPlan({
    manifest: options.plugin.manifest,
    plan: render.plan,
    platform: options.platform,
    scope: options.scope,
    requestedArtifactIds: render.context.requestedArtifactIds,
    renderConfig: config,
    rendererDigest: render.target.rendererDigest!,
    manifestDigest: render.target.manifestDigest!,
  }).artifacts;
  return {
    artifacts,
    sourceDirs: (artifact) => render.context.artifactSources.find((entry) =>
      entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [],
    sensitiveValues: collectSensitivePluginConfigValues(options.plugin.manifest, config.values),
  };
}

function dynamicSkillWrite(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  artifact: ValidatedArtifactPlanArtifact;
  skillPath: string;
  allowedRoot: string;
  tree: DynamicSkillTree;
}): PlannedWrite {
  const skillKey = 'skillKey' in options.artifact ? options.artifact.skillKey! : '';
  const identity = ownerIdentity(
    options.plugin.manifest.name,
    skillKey,
    options.platform,
    options.scope,
  );
  const component = pathComponent({
    kind: 'skill-directory',
    path: options.skillPath,
    allowedRoot: options.allowedRoot,
    identity,
    ...(options.platform === 'codex' && options.scope === 'user'
      ? {
          pristineTree: pristineTreeDescriptor(options.tree),
        }
      : {}),
  });
  return {
    artifact: {
      path: options.skillPath,
      paths: Object.keys(options.tree.files).map((relativePath) =>
        path.join(options.skillPath, relativePath.split('/').join(path.sep))),
      kind: 'skill',
      platform: options.platform,
      artifactKey: skillKey,
      id: options.artifact.id,
      target: options.artifact.target,
      state: options.artifact.state,
      ...(options.artifact.disabledReason
        ? { disabledReason: options.artifact.disabledReason }
        : {}),
      refreshKeys: [...options.artifact.refreshKeys],
      configDigest: options.artifact.configDigest,
      contentDigest: options.platform === 'codex'
        ? createCodexSkillStagingTreeContentDigest(options.tree)
        : createDynamicSkillTreeContentDigest(options.tree),
    },
    ...(options.artifact.state === 'present' ? { component } : {}),
    ...(options.artifact.state === 'present' ? {
      action: skillWriteAction({
        plugin: options.plugin,
        platform: options.platform,
        scope: options.scope,
        path: options.skillPath,
        allowedRoot: options.allowedRoot,
        identity,
        tree: options.tree,
        allowPristineUnowned: options.platform === 'codex' && options.scope === 'user',
      }),
    } : {}),
  };
}

async function resolveCodexSkillsRelativeRoot(
  plugin: PluginMeta,
  marketplaceFallbackRoot?: string,
): Promise<string> {
  const manifestPaths = [
    path.join(plugin.rootDir, '.codex-plugin', 'plugin.json'),
    ...(marketplaceFallbackRoot
      ? [path.join(marketplaceFallbackRoot, '.codex-plugin', 'plugin.json')]
      : []),
  ];
  let manifest: Record<string, unknown> | null = null;
  for (const manifestPath of manifestPaths) {
    manifest = await fs.readJson(manifestPath).catch(() => null) as Record<string, unknown> | null;
    if (manifest) break;
  }
  const raw = typeof manifest?.skills === 'string' && manifest.skills.trim() !== ''
    ? manifest.skills
    : plugin.manifest.skills ?? './codex/skills';
  const normalized = path.posix.normalize(raw.replace(/^\.\//u, ''));
  if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`Codex plugin skills root 越界：${raw}`);
  }
  return normalized;
}

async function buildBundledCodexSkillWrites(options: {
  plugin: PluginMeta;
  env: NodeJS.ProcessEnv;
  marketplaceRoot?: string;
  marketplaceName?: string;
  shallow?: boolean;
}): Promise<PlannedWrite[]> {
  const relativeRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const sourceRoot = path.join(options.plugin.rootDir, ...relativeRoot.split('/'));
  if (!await fs.pathExists(sourceRoot)) return [];
  const dynamicKeys = new Set(
    (options.plugin.manifest.artifacts?.targets ?? [])
      .filter((target) => target.target === 'codex.skill' && target.skillKey)
      .map((target) => target.skillKey!),
  );
  const targetRoot = await canonicalizePathThroughExistingAncestor(path.join(
    options.marketplaceRoot ?? resolveAwHome(options.env),
    'plugins',
    options.plugin.manifest.name,
    ...relativeRoot.split('/'),
  ));
  const writes: PlannedWrite[] = [];
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Codex skills source 不能包含符号链接：${entry.name}`);
    }
    if (!entry.isDirectory() || dynamicKeys.has(entry.name)) continue;
    const skillSource = path.join(sourceRoot, entry.name);
    if (!await fs.pathExists(path.join(skillSource, 'SKILL.md'))) continue;
    const skillPath = path.join(targetRoot, entry.name);
    const identity = ownerIdentity(
      options.plugin.manifest.name,
      entry.name,
      'codex',
      'user',
    );
    if (options.shallow) {
      writes.push({
        artifact: {
          path: skillPath,
          kind: 'skill',
          platform: 'codex',
          artifactKey: entry.name,
        },
        component: pathComponent({
          kind: 'skill-directory',
          path: skillPath,
          allowedRoot: targetRoot,
          identity,
        }),
      });
      continue;
    }
    const tree = await createCodexSkillExpectedTree({
      artifact: {
        target: 'codex.skill',
        skillKey: entry.name,
        state: 'present',
        content: { files: {} },
      },
      sourceDirs: [skillSource],
      sourceRequirementsReceiptPolicy: 'allow',
    });
    const canRecoverPristine = await canonicalizePathThroughExistingAncestor(skillSource)
      !== path.resolve(skillPath);
    const component = pathComponent({
      kind: 'skill-directory',
      path: skillPath,
      allowedRoot: targetRoot,
      identity,
      ...(canRecoverPristine
        ? {
            pristineTree: pristineTreeDescriptor(tree),
          }
        : {}),
    });
    writes.push({
      artifact: {
        path: skillPath,
        paths: Object.keys(tree.files).map((relativePath) => path.join(skillPath, relativePath)),
        kind: 'skill',
        platform: 'codex',
        artifactKey: entry.name,
      },
      component,
      action: skillWriteAction({
        plugin: options.plugin,
        platform: 'codex',
        scope: 'user',
        path: skillPath,
        allowedRoot: targetRoot,
        identity,
        tree,
        allowPristineUnowned: canRecoverPristine,
      }),
    });
  }
  return writes;
}

async function buildClaudeWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install';
  historicalArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
}): Promise<PlannedWrite[]> {
  const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
  const writes: PlannedWrite[] = [];
  const dynamic = await resolveDynamicArtifacts({
    ...options,
    platform: 'claude',
    previousArtifacts: options.historicalArtifacts,
  });
  for (const artifact of dynamic.artifacts.filter((entry) => entry.target === 'claude.skill')) {
    const skillKey = artifact.skillKey!;
    const tree = await createDynamicSkillExpectedTree({
      artifact,
      sourceDirs: dynamic.sourceDirs(artifact),
      requireReadme: true,
      requirementsReceipt: requirementsReceipt(options.plugin),
      sourceRequirementsReceiptPolicy: 'allow',
    });
    assertNoSensitiveConfigInFiles(
      tree.files,
      dynamic.sensitiveValues,
      'artifactRendererSensitiveConfigExposed: Final dynamic Skill contains sensitive config.',
    );
    writes.push(dynamicSkillWrite({
      ...options,
      platform: 'claude',
      artifact,
      skillPath: path.join(paths.configDir, 'skills', skillKey),
      allowedRoot: path.join(paths.configDir, 'skills'),
      tree,
    }));
  }
  for (const artifact of generateInstructionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'claude'),
    'claude',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'claude',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'instruction',
    }));
  }
  const permissions = resolvePlatformEntries(
    options.plugin.manifest.extensions?.permissions,
    'claude',
  );
  if (permissions.length > 0) {
    const component = createClaudePermissionsComponent({
      identity: pluginOwnerIdentity(options.plugin, 'permissions', 'claude', options.scope),
      scope: options.scope,
      settingsPath: paths.settingsPath,
    });
    const desiredPermissions = mergeClaudePermissions(permissions);
    const mutation = { kind: 'claude-permissions' as const, permissions: desiredPermissions };
    writes.push({
      artifact: { path: paths.settingsPath, kind: 'permission', platform: 'claude' },
      component,
      action: {
        kind: 'updateSharedConfig',
        pluginId: pluginActionId(options.plugin),
        platform: 'claude',
        scope: options.scope,
        owner: component.identity,
        locator: component.locator,
        mutation,
        contentDigest: `sha256:${crypto.createHash('sha256').update(JSON.stringify(mutation)).digest('hex')}`,
      },
    });
  }
  return writes;
}

async function buildCodexWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  event: 'install';
  historicalArtifacts: readonly GeneratedArtifact[];
  scriptTimeoutMs?: number;
  marketplaceRoot?: string;
  marketplaceName?: string;
  userActivationDesired?: ReadonlySet<string>;
}): Promise<PlannedWrite[]> {
  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  const writes: PlannedWrite[] = [];
  const dynamic = await resolveDynamicArtifacts({
    ...options,
    platform: 'codex',
    previousArtifacts: options.historicalArtifacts,
  });
  const dynamicInstructions = dynamic.artifacts.filter(
    (entry) => entry.target === 'codex.developerInstructionsBlock',
  );
  const dynamicRoles = dynamic.artifacts.filter((entry) => entry.target === 'codex.agentRole');
  const dynamicSkills = dynamic.artifacts.filter((entry) => entry.target === 'codex.skill');
  const repoRoot = await resolveRepoRoot(options.cwd);
  if (options.scope === 'user') {
    writes.push(...await buildBundledCodexSkillWrites({
      plugin: options.plugin,
      env: options.env,
      marketplaceRoot: options.marketplaceRoot,
    }));
  }
  const skillRoot = options.scope === 'user'
    ? path.join(getCodexHome(options.env), 'skills')
    : path.join(repoRoot, '.agents', 'skills');
  for (const artifact of dynamicSkills) {
    const tree = await createCodexSkillExpectedTree({
      artifact,
      sourceDirs: dynamic.sourceDirs(artifact),
      requireReadme: true,
      requirementsReceipt: requirementsReceipt(options.plugin),
      sourceRequirementsReceiptPolicy: 'allow',
    });
    assertNoSensitiveConfigInFiles(
      tree.files,
      dynamic.sensitiveValues,
      'artifactRendererSensitiveConfigExposed: Final dynamic Skill contains sensitive config.',
    );
    writes.push(dynamicSkillWrite({
      ...options,
      platform: 'codex',
      artifact,
      skillPath: path.join(skillRoot, artifact.skillKey!),
      allowedRoot: skillRoot,
      tree,
    }));
  }

  const staticInstructions = dynamicInstructions.length > 0
    ? []
    : resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex');
  const hasInstructionOutput = dynamicInstructions.length > 0 || staticInstructions.length > 0;
  if (hasInstructionOutput) {
    const component = createCodexInstructionComponent({
      identity: pluginOwnerIdentity(
        options.plugin,
        'developer-instructions',
        'codex',
        options.scope,
      ),
      scope: options.scope,
      configPath: paths.configTomlPath,
    });
    const dynamicBlock = dynamicInstructions.length > 0
      ? composeManagedDeveloperInstructionsBlock(
          options.plugin.manifest.name,
          dynamicInstructions
            .filter((entry) => entry.state === 'present')
            .map((entry) => ({ artifactId: entry.id, value: entry.content! })),
        )
      : undefined;
    const block = dynamicBlock?.value
      ? { ...dynamicBlock, pluginName: createSharedOwnerToken(component.identity) }
      : staticInstructions.length > 0
        ? {
            pluginName: createSharedOwnerToken(component.identity),
            value: renderCodexManagedInstructionBlock(
              options.plugin.manifest.name,
              staticInstructions,
            ),
          }
        : undefined;
    const instructionMutation = { kind: 'codex-instruction' as const, ...(block ? { block } : {}) };
    for (const artifact of dynamicInstructions.length > 0 ? dynamicInstructions : [{
      id: undefined,
      target: undefined,
      state: 'present' as const,
      refreshKeys: [] as string[],
      configDigest: undefined,
      disabledReason: undefined,
    }]) {
      writes.push({
        artifact: {
          path: paths.configTomlPath,
          kind: 'instruction',
          platform: 'codex',
          ...(artifact.id ? { id: artifact.id } : {}),
          ...(artifact.target ? { target: artifact.target } : {}),
          state: artifact.state,
          refreshKeys: [...artifact.refreshKeys],
          ...(artifact.configDigest ? { configDigest: artifact.configDigest } : {}),
          ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
        },
        ...(block ? { component } : {}),
        action: {
          kind: 'updateSharedConfig',
          pluginId: pluginActionId(options.plugin),
          platform: 'codex',
          scope: options.scope,
          owner: component.identity,
          locator: component.locator,
          mutation: instructionMutation,
          contentDigest: `sha256:${crypto.createHash('sha256')
            .update(JSON.stringify(instructionMutation)).digest('hex')}`,
        },
      });
    }
  }

  for (const artifact of dynamicRoles) {
    const roleKey = artifact.roleKey!;
    const rolePath = path.join(
      paths.configDir,
      'agents',
      `${buildGeneratedName(options.plugin.manifest.name, roleKey)}.toml`,
    );
    const roleComponent = pathComponent({
      kind: 'owned-text-file',
      path: rolePath,
      allowedRoot: paths.configDir,
      identity: pluginOwnerIdentity(options.plugin, roleKey, 'codex', options.scope),
    });
    const registrationComponent = createCodexRoleRegistrationComponent({
      identity: pluginOwnerIdentity(
        options.plugin,
        internalArtifactKey('role', roleKey),
        'codex',
        options.scope,
      ),
      fileIdentity: roleComponent.identity,
      configPath: paths.configTomlPath,
      roleKey,
      rolePath,
    });
    const roleFile = artifact.content?.roleFile;
    const description = artifact.content?.registration?.description
      ?? roleFile?.description;
    const present = artifact.state === 'present';
    if (present && (!description || !roleFile?.developer_instructions)) {
      throw new Error(`Artifact "${artifact.id}" 的 codex.agentRole 缺少 description 或 developer_instructions。`);
    }
    writes.push({
      artifact: {
        path: rolePath,
        paths: [paths.configTomlPath, rolePath],
        kind: 'agent',
        platform: 'codex',
        artifactKey: roleKey,
        roleKey,
        id: artifact.id,
        target: artifact.target,
        state: artifact.state,
        refreshKeys: [...artifact.refreshKeys],
        configDigest: artifact.configDigest,
        ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
      },
      ...(present ? { component: roleComponent } : {}),
      ...(present ? { additionalComponents: [registrationComponent] } : {}),
      ...(present ? {
        action: (() => {
          const content = renderCodexRole({
            roleKey,
            description: description!,
            developerInstructions: roleFile!.developer_instructions!,
            model: roleFile!.model,
            modelReasoningEffort: roleFile!.model_reasoning_effort,
          });
          return {
            kind: 'writeOwnedArtifact' as const,
            pluginId: pluginActionId(options.plugin),
            platform: 'codex' as const,
            scope: options.scope,
            path: rolePath,
            allowedRoot: paths.configDir,
            owner: roleComponent.identity,
            artifactKind: 'owned-text-file' as const,
            sourceContent: content,
            content,
            contentDigest: `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`,
          };
        })(),
      } : {}),
      ...(present ? {
        additionalActions: [(() => {
          const mutation = {
            kind: 'codex-role-registration' as const,
            roleKey,
            configFile: path.relative(path.dirname(paths.configTomlPath), rolePath),
            description: description!,
          };
          return {
            kind: 'updateSharedConfig' as const,
            pluginId: pluginActionId(options.plugin),
            platform: 'codex' as const,
            scope: options.scope,
            owner: registrationComponent.identity,
            locator: registrationComponent.locator,
            mutation,
            contentDigest: `sha256:${crypto.createHash('sha256')
              .update(JSON.stringify(mutation)).digest('hex')}`,
          };
        })()],
      } : {}),
    });
  }

  for (const artifact of generateCodexPermissionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'codex'),
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'codex',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'permission',
    }));
  }
  for (const artifact of generateAgentArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.agents, 'codex'),
    'codex',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      platform: 'codex',
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'agent',
    }));
  }

  const codexPluginId = `${options.plugin.manifest.name}@${options.marketplaceName ?? options.plugin.marketplaceName ?? MARKETPLACE_NAME}`;
  const nativeSurface = analyzeCodexSurface(options.plugin.manifest).nativeKinds.length > 0;
  const userActivationDesired = options.scope === 'user'
    || options.userActivationDesired?.has(codexPluginId) === true;
  for (const activation of !nativeSurface ? [] : options.scope === 'project'
    ? [
        {
          scope: 'user' as const,
          desired: userActivationDesired,
          configPath: resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
        },
        { scope: 'project' as const, desired: true, configPath: paths.configTomlPath },
      ]
    : [{ scope: 'user' as const, desired: true, configPath: paths.configTomlPath }]) {
    const component = createCodexActivationComponent({
      identity: pluginOwnerIdentity(
        options.plugin,
        internalArtifactKey('activation', activation.scope),
        'codex',
        options.scope,
      ),
      configPath: activation.configPath,
      codexPluginId,
      desired: activation.desired,
    });
    writes.push({
      artifact: {
        path: activation.configPath,
        kind: 'instruction',
        platform: 'codex',
        artifactKey: internalArtifactKey('activation', activation.scope),
      },
      component,
      action: {
        kind: 'setActivation',
        pluginId: pluginActionId(options.plugin),
        platform: 'codex',
        scope: activation.scope,
        enabled: activation.desired,
        configPath: activation.configPath,
        registration: codexPluginId,
      },
    });
  }
  return writes;
}

async function buildInspectionWrites(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceRoot?: string;
  marketplaceName?: string;
  userActivationDesired?: ReadonlySet<string>;
  shallow?: boolean;
}): Promise<PlannedWrite[]> {
  const writes: PlannedWrite[] = [];
  if (options.platform === 'claude') {
    const paths = resolveClaudePaths(options.cwd, options.scope, options.env);
    for (const artifact of generateInstructionArtifacts(
      options.plugin.manifest.name,
      resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'claude'),
      'claude',
    )) {
      writes.push(generatedTextWrite({
        ...options,
        configDir: paths.configDir,
        relativePath: artifact.relativePath,
        artifactKey: artifact.artifactKey!,
        content: artifact.content,
        kind: 'instruction',
      }));
    }
    if (resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'claude').length > 0) {
      writes.push({
        artifact: { path: paths.settingsPath, kind: 'permission', platform: 'claude' },
        component: createClaudePermissionsComponent({
          identity: pluginOwnerIdentity(options.plugin, 'permissions', 'claude', options.scope),
          scope: options.scope,
          settingsPath: paths.settingsPath,
        }),
      });
    }
    for (const target of options.plugin.manifest.artifacts?.targets ?? []) {
      if (
        target.platform !== 'claude'
        || !target.scopes.includes(options.scope)
        || target.target !== 'claude.skill'
        || !target.skillKey
      ) continue;
      const state = target.states.includes('present') ? 'present' : 'disabled';
      const skillPath = path.join(paths.configDir, 'skills', target.skillKey);
      const component = pathComponent({
        kind: 'skill-directory',
        path: skillPath,
        allowedRoot: path.dirname(skillPath),
        identity: ownerIdentity(
          options.plugin.manifest.name,
          target.skillKey,
          'claude',
          options.scope,
        ),
      });
      writes.push({
        artifact: {
          path: skillPath,
          kind: 'skill',
          platform: 'claude',
          artifactKey: target.skillKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present' ? { component } : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
      });
    }
    return writes;
  }

  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  const repoRoot = await resolveRepoRoot(options.cwd);
  if (options.scope === 'user' && options.shallow !== true) {
    writes.push(...await buildBundledCodexSkillWrites({
      plugin: options.plugin,
      env: options.env,
      marketplaceRoot: options.marketplaceRoot,
    }));
  }
  const instructions = resolvePlatformEntries(options.plugin.manifest.extensions?.instructions, 'codex');
  const targets = (options.plugin.manifest.artifacts?.targets ?? []).filter((target) =>
    target.platform === 'codex' && target.scopes.includes(options.scope));
  const instructionTargets = targets.filter((target) =>
    target.target === 'codex.developerInstructionsBlock');
  const presentCapableInstructionTargets = instructionTargets.filter((target) =>
    target.states.includes('present'));
  const instructionDesired = presentCapableInstructionTargets.length > 0;
  const instructionOptional = presentCapableInstructionTargets.length > 0
    && presentCapableInstructionTargets.every((target) => target.states.includes('disabled'));
  if (instructions.length > 0 || instructionDesired) {
    writes.push({
      artifact: { path: paths.configTomlPath, kind: 'instruction', platform: 'codex' },
      component: createCodexInstructionComponent({
        identity: pluginOwnerIdentity(
          options.plugin,
          'developer-instructions',
          'codex',
          options.scope,
        ),
        scope: options.scope,
        configPath: paths.configTomlPath,
      }),
      ...(instructions.length === 0 && instructionOptional ? { optional: true } : {}),
    });
  }
  const dynamicSkillRoot = options.scope === 'user'
    ? path.join(getCodexHome(options.env), 'skills')
    : path.join(repoRoot, '.agents', 'skills');
  for (const target of targets) {
    const state = target.states.includes('present') ? 'present' : 'disabled';
    if (target.target === 'codex.skill'
      && target.delivery?.mode === 'aw-extension'
      && target.skillKey) {
      const skillPath = path.join(dynamicSkillRoot, target.skillKey);
      const component = pathComponent({
        kind: 'skill-directory',
        path: skillPath,
        allowedRoot: dynamicSkillRoot,
        identity: ownerIdentity(options.plugin.manifest.name, target.skillKey, 'codex', options.scope),
      });
      writes.push({
        artifact: {
          path: skillPath,
          kind: 'skill',
          platform: 'codex',
          artifactKey: target.skillKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present' ? { component } : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
      });
    }
    if (target.target === 'codex.agentRole' && target.roleKey) {
      const rolePath = path.join(
        paths.configDir,
        'agents',
        `${buildGeneratedName(options.plugin.manifest.name, target.roleKey)}.toml`,
      );
      const roleComponent = pathComponent({
        kind: 'owned-text-file',
        path: rolePath,
        allowedRoot: paths.configDir,
        identity: pluginOwnerIdentity(options.plugin, target.roleKey, 'codex', options.scope),
      });
      const registrationComponent = createCodexRoleRegistrationComponent({
        identity: pluginOwnerIdentity(
          options.plugin,
          internalArtifactKey('role', target.roleKey),
          'codex',
          options.scope,
        ),
        fileIdentity: pluginOwnerIdentity(options.plugin, target.roleKey, 'codex', options.scope),
        configPath: paths.configTomlPath,
        roleKey: target.roleKey,
        rolePath,
      });
      writes.push({
        artifact: {
          path: rolePath,
          kind: 'agent',
          platform: 'codex',
          artifactKey: target.roleKey,
          roleKey: target.roleKey,
          id: target.id,
          target: target.target,
          state,
        },
        ...(state === 'present'
          ? { component: roleComponent, additionalComponents: [registrationComponent] }
          : {}),
        ...(target.states.includes('present') && target.states.includes('disabled')
          ? { optional: true }
          : {}),
      });
    }
  }
  for (const artifact of generateCodexPermissionArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.permissions, 'codex'),
  )) {
    writes.push(generatedTextWrite({
      ...options,
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'permission',
    }));
  }
  for (const artifact of generateAgentArtifacts(
    options.plugin.manifest.name,
    resolvePlatformEntries(options.plugin.manifest.extensions?.agents, 'codex'),
    'codex',
  )) {
    writes.push(generatedTextWrite({
      ...options,
      configDir: paths.configDir,
      relativePath: artifact.relativePath,
      artifactKey: artifact.artifactKey!,
      content: artifact.content,
      kind: 'agent',
    }));
  }
  const nativeSurface = analyzeCodexSurface(options.plugin.manifest).nativeKinds.length > 0;
  const codexPluginId = `${options.plugin.manifest.name}@${options.marketplaceName ?? options.plugin.marketplaceName ?? MARKETPLACE_NAME}`;
  const userActivationDesired = options.scope === 'user'
    || options.userActivationDesired?.has(codexPluginId) === true;
  for (const activation of !nativeSurface ? [] : options.scope === 'project'
    ? [
        {
          scope: 'user' as const,
          desired: userActivationDesired,
          configPath: resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
        },
        { scope: 'project' as const, desired: true, configPath: paths.configTomlPath },
      ]
    : [{ scope: 'user' as const, desired: true, configPath: paths.configTomlPath }]) {
    writes.push({
      artifact: {
        path: activation.configPath,
        kind: 'instruction',
        platform: 'codex',
        artifactKey: internalArtifactKey('activation', activation.scope),
      },
      component: createCodexActivationComponent({
        identity: pluginOwnerIdentity(
          options.plugin,
          internalArtifactKey('activation', activation.scope),
          'codex',
          options.scope,
        ),
        configPath: activation.configPath,
        codexPluginId,
        desired: activation.desired,
      }),
    });
  }
  return writes;
}

async function buildHistoricalComponents(options: {
  sourceId?: string;
  sourceIdentity?: string;
  pluginId?: string;
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifacts: readonly GeneratedArtifact[];
  command: 'install' | 'sync' | 'reinstall' | 'cleanup' | 'uninstall';
}): Promise<OwnedComponent[]> {
  const components: OwnedComponent[] = [];
  const paths = options.platform === 'codex'
    ? resolveCodexPaths(options.cwd, options.scope, options.env)
    : resolveClaudePaths(options.cwd, options.scope, options.env);
  const historicalIdentity = (artifactKey: string): OwnerIdentity => ({
    ...ownerIdentity(options.pluginName, artifactKey, options.platform, options.scope),
    ...(options.sourceId ? {
      sourceId: options.sourceId,
      pluginId: options.pluginId,
    } : {}),
  });
  for (const artifact of options.artifacts) {
    if (artifact.platform !== options.platform) continue;
    if (artifact.state === 'disabled') continue;
    if (
      options.platform === 'codex'
      && artifact.artifactKey !== undefined
      && new Set([
        internalArtifactKey('activation', 'user'),
        internalArtifactKey('activation', 'project'),
      ]).has(artifact.artifactKey)
    ) {
      continue;
    }
    if (
      options.command === 'cleanup'
      && artifact.kind === 'hook'
      && options.platform === 'codex'
    ) {
      for (const identity of artifact.hookGroups ?? []) {
        components.push(createLegacyCodexHookCleanupComponent({
          pluginName: options.pluginName,
          scope: options.scope,
          hooksPath: path.join(resolveCodexPaths(
            options.cwd,
            options.scope,
            options.env,
          ).configDir, 'hooks.json'),
          identity,
        }));
      }
      continue;
    }
    if (
      options.command === 'cleanup'
      && artifact.kind === 'mcpServer'
      && options.platform === 'codex'
      && artifact.artifactKey
    ) {
      components.push(createLegacyCodexMcpCleanupComponent({
        identity: historicalIdentity(internalArtifactKey('mcp', artifact.artifactKey)),
        configPath: resolveCodexPaths(
          options.cwd,
          options.scope,
          options.env,
        ).configTomlPath,
        serverKey: artifact.artifactKey,
      }));
      continue;
    }
    if (artifact.kind === 'instruction' && options.platform === 'codex' && !artifact.artifactKey) {
      components.push(createCodexInstructionComponent({
        identity: historicalIdentity('developer-instructions'),
        scope: options.scope,
        configPath: resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
      }));
      continue;
    }
    if (artifact.kind === 'permission' && options.platform === 'claude') {
      components.push(createClaudePermissionsComponent({
        identity: historicalIdentity('permissions'),
        scope: options.scope,
        settingsPath: resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath,
      }));
      continue;
    }
    if (
      artifact.target === 'codex.agentRole'
      && options.platform === 'codex'
      && (artifact.roleKey || artifact.artifactKey)
    ) {
      const roleKey = artifact.roleKey ?? artifact.artifactKey!;
      components.push(createCodexRoleRegistrationComponent({
        identity: historicalIdentity(internalArtifactKey('role', roleKey)),
        fileIdentity: historicalIdentity(roleKey),
        configPath: resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath,
        roleKey,
        rolePath: artifact.path,
      }));
    }
    if (!artifact.artifactKey) continue;
    const identity = ownerIdentity(
      options.pluginName,
      artifact.artifactKey,
      options.platform,
      options.scope,
    );
    components.push(pathComponent({
      kind: artifact.kind === 'skill' ? 'skill-directory' : 'owned-text-file',
      path: artifact.path,
      allowedRoot: artifact.kind === 'skill' ? path.dirname(artifact.path) : paths.configDir,
      identity,
    }));
  }
  return components;
}

function isAbsentPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

async function lstatIfPresent(filePath: string) {
  return fs.lstat(filePath).catch((error) => {
    if (isAbsentPath(error)) return null;
    throw error;
  });
}

async function lstatCodexResidueIfPresent(filePath: string) {
  return fs.lstat(filePath).catch((error) => {
    if (isAbsentPath(error)) return null;
    throw error;
  });
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function codexReadPathSafe(root: string, candidate: string): Promise<boolean> {
  if (!isPathWithin(root, candidate)) return false;
  const rootStats = await lstatCodexResidueIfPresent(root);
  if (rootStats && (!rootStats.isDirectory() || rootStats.isSymbolicLink())) return false;
  const [physicalRoot, physicalCandidate] = await Promise.all([
    canonicalizePathThroughExistingAncestor(root),
    canonicalizePathThroughExistingAncestor(candidate),
  ]);
  return isPathWithin(physicalRoot, physicalCandidate);
}

async function codexPayloadPathSafe(
  payloadRoot: string,
  allowedRoot = payloadRoot,
): Promise<boolean> {
  if (!await codexReadPathSafe(allowedRoot, payloadRoot)) return false;
  const rootStats = await lstatCodexResidueIfPresent(payloadRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return false;
  const pending = [payloadRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (!entry.isFile()) {
        return false;
      }
    }
  }
  return true;
}

async function resolveCodexSkillsRoot(
  payloadRoot: string,
  rawSkillsRoot: string,
): Promise<{ relativeRoot: string; root: string }> {
  const normalizedSeparators = rawSkillsRoot.replace(/\\/gu, '/');
  const relativeRoot = path.posix.normalize(normalizedSeparators.replace(/^\.\//u, ''));
  if (!relativeRoot
    || relativeRoot === '.'
    || relativeRoot === '..'
    || relativeRoot.startsWith('../')
    || path.posix.isAbsolute(normalizedSeparators)
    || path.win32.isAbsolute(rawSkillsRoot)) {
    throw new Error('codexNativeSkillsRootInvalid: Codex native Skills root is invalid.');
  }
  const root = path.join(payloadRoot, ...relativeRoot.split('/'));
  if (!await codexReadPathSafe(payloadRoot, root)) {
    throw new Error('codexNativeSkillsRootInvalid: Codex native Skills root is unsafe.');
  }
  return { relativeRoot, root };
}
export interface CodexSharedNativeLiveInspection {
  sharedNative: CodexSharedNativeInspection;
  expectedPayloadDigest?: string;
}

function codexNativeRenderTargets(plugin: PluginMeta) {
  return (plugin.manifest.artifacts?.targets ?? []).filter((target) =>
    target.platform === 'codex'
    && target.target === 'codex.skill'
    && target.delivery?.mode === 'codex-native');
}

async function readCodexNativeRenderReceiptEvidence(payloadRoot: string): Promise<
  | { state: 'absent' }
  | { state: 'unreadable' }
  | { state: 'present'; receipt: CodexNativeRenderReceipt }
> {
  const receiptPath = path.join(payloadRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH);
  const stats = await lstatIfPresent(receiptPath);
  if (!stats) return { state: 'absent' };
  if (!stats.isFile() || stats.isSymbolicLink()) return { state: 'unreadable' };
  try {
    return {
      state: 'present',
      receipt: parseCodexNativeRenderReceipt(await fs.readFile(receiptPath, 'utf8')),
    };
  } catch {
    return { state: 'unreadable' };
  }
}

async function resolveCodexNativeRenderExpectedEvidence(options: {
  plugin: PluginMeta;
  marketplaceRoot: string;
  marketplaceName: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  state: 'present';
  payloadDigest: string;
  projection?: CodexNativeRenderProjection;
  sourceProjection: 'current' | 'drifted';
} | {
  state: 'foreign';
}> {
  const logicalPluginId = options.plugin.pluginId
    ?? (options.plugin.sourceId ? `${options.plugin.sourceId}/${options.plugin.manifest.name}` : undefined);
  if (!logicalPluginId || !options.plugin.sourceId || !options.plugin.sourceIdentity) {
    throw new Error('Codex native render projection requires namespaced source identity.');
  }
  const marketplace = await readStrictNamespacedMarketplaceRoot({
    trustedMarketplaceRoot: path.join(resolveAwHome(options.env), 'marketplaces'),
    rootDir: options.marketplaceRoot,
    sourceId: options.plugin.sourceId,
    marketplaceName: options.marketplaceName,
  });
  if (!marketplace) {
    throw new Error('Codex native render canonical marketplace generation is missing.');
  }
  if (marketplace.config.sourceIdentity !== options.plugin.sourceIdentity) {
    return { state: 'foreign' };
  }
  const payloadRoot = path.join(options.marketplaceRoot, 'plugins', options.plugin.manifest.name);
  if (!await codexPayloadPathSafe(payloadRoot, options.marketplaceRoot)) {
    throw new Error('Codex native render canonical marketplace payload path is unsafe.');
  }
  const receiptEvidence = await readCodexNativeRenderReceiptEvidence(payloadRoot);
  if (receiptEvidence.state !== 'present') {
    throw new Error('Codex native render canonical marketplace receipt is missing or unreadable.');
  }
  const receipt = receiptEvidence.receipt;
  if (receipt.logicalPluginId !== logicalPluginId
    || receipt.strategy !== 'shared-user'
    || receipt.sourceIdentity !== marketplace.config.sourceIdentity) {
    throw new Error('Codex native render canonical marketplace receipt identity is invalid.');
  }
  const payloadDigest = await calculateCodexNativeRenderPayloadDigest(payloadRoot);
  if (payloadDigest !== receipt.payloadDigest) {
    throw new Error('Codex native render canonical marketplace payload does not match its receipt.');
  }
  const sourceManifestPath = path.join(payloadRoot, '.agents-plugin', 'plugin.json');
  const sourceManifestStats = await lstatIfPresent(sourceManifestPath);
  const sourceManifest = sourceManifestStats?.isFile() && !sourceManifestStats.isSymbolicLink()
    ? await fs.readJson(sourceManifestPath).catch(() => null) as Record<string, unknown> | null
    : null;
  if (sourceManifest?.name !== options.plugin.manifest.name
    || sourceManifest.version !== receipt.pluginVersion) {
    throw new Error('Codex native render canonical marketplace plugin identity is invalid.');
  }
  const codexManifestPath = path.join(payloadRoot, '.codex-plugin', 'plugin.json');
  const codexManifestStats = await lstatIfPresent(codexManifestPath);
  const codexManifest = codexManifestStats?.isFile() && !codexManifestStats.isSymbolicLink()
    ? await fs.readJson(codexManifestPath).catch(() => null) as Record<string, unknown> | null
    : null;
  if (!codexManifest) {
    throw new Error('Codex native render canonical marketplace manifest is invalid.');
  }
  const rawSkillsRoot = typeof codexManifest.skills === 'string' && codexManifest.skills.trim() !== ''
    ? codexManifest.skills
    : './codex/skills';
  const { relativeRoot: skillsRelativeRoot } = await resolveCodexSkillsRoot(
    payloadRoot,
    rawSkillsRoot,
  );
  const emptyArtifactDigest = createCodexSkillStagingTreeContentDigest({
    skillKey: 'empty',
    files: {},
  });
  for (const receiptTarget of receipt.targets) {
    const skillRoot = path.join(payloadRoot, ...skillsRelativeRoot.split('/'), receiptTarget.skillKey);
    if (await lstatIfPresent(path.join(skillRoot, '.agent-workflows-owner.json'))) {
      throw new Error('Codex native render canonical marketplace Skill has an AW owner marker.');
    }
    const tree = await readDynamicSkillTree(skillRoot, 'codex.skill');
    const artifactDigest = tree
      ? createCodexSkillStagingTreeContentDigest(tree)
      : emptyArtifactDigest;
    if (artifactDigest !== receiptTarget.artifactDigest) {
      throw new Error('Codex native render canonical marketplace Skill does not match its receipt.');
    }
  }
  const targets = codexNativeRenderTargets(options.plugin);
  const receiptTargets = new Map(receipt.targets.map((target) => [target.id, target]));
  if (targets.length === 0
    || targets.length !== receipt.targets.length
    || targets.some((target) => receiptTargets.get(target.id)?.skillKey !== target.skillKey)) {
    return { state: 'present', payloadDigest, sourceProjection: 'drifted' };
  }
  const renderer = await resolveArtifactRendererTarget(options.plugin);
  if (renderer.noOp || !renderer.rendererDigest) {
    throw new Error('Codex native render projection requires an artifact renderer.');
  }
  const config = await resolveArtifactRenderConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
    logicalIdentity: options.plugin.catalogLogicalIdentity,
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: 'user',
    cwd: options.plugin.rootDir,
    env: options.env,
  });
  if (config.issues.length > 0) {
    throw new Error(`Invalid AW config for ${options.plugin.manifest.name}.`);
  }
  const projection = createCodexNativeRenderProjection({
    logicalPluginId,
    sourceIdentity: options.plugin.sourceIdentity,
    pluginVersion: options.plugin.manifest.version,
    rendererDigest: renderer.rendererDigest,
    targets: targets.map((target) => ({
      id: target.id,
      skillKey: target.skillKey!,
      configDigest: createArtifactConfigDigest({
        artifact: {
          id: target.id,
          platform: 'codex',
          target: 'codex.skill',
          refreshKeys: target.refreshKeys,
        },
        configValues: config.values,
        digestSalt: renderer.rendererDigest!,
      }),
      artifactDigest: receiptTargets.get(target.id)!.artifactDigest,
    })),
  });
  return {
    state: 'present',
    projection,
    payloadDigest,
    sourceProjection: codexNativeRenderProjectionsEqual(receipt, projection)
      ? 'current'
      : 'drifted',
  };
}

async function assertNoSensitiveValuesInCanonicalCodexNativePayload(options: {
  plugin: PluginMeta;
  marketplaceRoot: string;
  env: NodeJS.ProcessEnv;
  sensitiveValues: readonly string[];
}): Promise<void> {
  if (options.sensitiveValues.length === 0
    || !pluginHasCodexNativeSkillSurface(options.plugin)) return;
  const sourceId = options.plugin.sourceId;
  if (!sourceId) {
    throw new Error('Codex native sensitive scan requires namespaced source identity.');
  }
  const awHome = resolveAwHome(options.env);
  if (!await isSafeCodexMarketplaceRoot({
    awHome,
    sourceId,
    marketplaceRoot: options.marketplaceRoot,
  })) {
    throw new Error('Codex native sensitive scan canonical marketplace path is unsafe.');
  }
  const payloadRoot = path.join(
    options.marketplaceRoot,
    'plugins',
    options.plugin.manifest.name,
  );
  await assertNoSensitiveValuesInCodexNativePayload({
    plugin: options.plugin,
    payloadRoot,
    allowedRoot: options.marketplaceRoot,
    sensitiveValues: options.sensitiveValues,
  });
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
  const inspectionMode = options.inspectionMode ?? 'payload';
  const dynamicProjectionExpected = options.nativeRenderPlugin !== undefined
    && codexNativeRenderTargets(options.nativeRenderPlugin).length > 0;
  if (inspectionMode === 'payload'
    && options.expectedPayloadDigest === undefined
    && !dynamicProjectionExpected) {
    throw new Error('Payload inspection requires the expected shared native digest.');
  }
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
  let expectedPayloadDigest = dynamicProjectionExpected ? undefined : options.expectedPayloadDigest;
  let sourceProjection: 'current' | 'drifted' | undefined;
  let expectedMarketplaceForeign = false;
  const installed = pluginList.observation.state === 'observed'
    && pluginList.observation.value === 'installed';
  if (installed && dynamicProjectionExpected && options.nativeRenderPlugin) {
    try {
      const expected = await resolveCodexNativeRenderExpectedEvidence({
        plugin: options.nativeRenderPlugin,
        marketplaceRoot,
        marketplaceName,
        env: options.env,
      });
      if (expected.state === 'foreign') {
        expectedMarketplaceForeign = true;
      } else {
        expectedPayloadDigest = expected.payloadDigest;
        sourceProjection = expected.sourceProjection;
      }
    } catch {
      sourceProjection = 'drifted';
    }
  }
  const sharedNative: CodexSharedNativeInspection = expectedMarketplaceForeign
    ? { state: 'blocked', reason: 'foreign', diagnostic: 'marketplaceRegistrationForeign' }
    : inspectCodexSharedNative({
    pluginName: options.pluginName,
    pluginId,
    marketplaceName,
    canonicalMarketplaceRoot: marketplaceRoot,
    desiredVersion: options.desiredVersion,
    expectedPayloadDigest,
    marketplaceRegistration: config.snapshot.marketplaces[marketplaceName],
    marketplacePathSafe,
    observation: pluginList.observation,
    ...(sourceProjection ? { sourceProjection } : {}),
  });
  return {
    sharedNative,
    ...(expectedPayloadDigest ? { expectedPayloadDigest } : {}),
  };
}

async function ensureCodexActiveSkillsManifest(options: {
  plugin: PluginMeta;
  marketplaceRoot: string;
  hasRequiredSkills: boolean;
}): Promise<string | null> {
  const relativeSkillsRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const skillsRoot = path.join(
    options.marketplaceRoot,
    'plugins',
    options.plugin.manifest.name,
    ...relativeSkillsRoot.split('/'),
  );
  if (options.hasRequiredSkills && !await fs.pathExists(skillsRoot)) {
    throw new Error(`Codex required Skills root 不存在：${skillsRoot}`);
  }
  const manifestPath = path.join(
    options.marketplaceRoot,
    'plugins',
    options.plugin.manifest.name,
    '.codex-plugin',
    'plugin.json',
  );
  const manifest = await fs.readJson(manifestPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }) as Record<string, unknown>;
  const updated: Record<string, unknown> = {
    ...manifest,
    name: options.plugin.manifest.name,
    version: options.plugin.manifest.version,
  };
  if (options.hasRequiredSkills) updated.skills = `./${relativeSkillsRoot}`;
  else delete updated.skills;
  await fs.outputJson(manifestPath, updated, { spaces: 2 });
  return options.hasRequiredSkills ? relativeSkillsRoot : null;
}

function createCodexMarketplaceComponent(options: {
  pluginName: string;
  codexManager?: CodexManager;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: NativeCliRunner;
  marketplaceName: string;
  marketplaceRoot: string;
  desired: boolean;
}): OwnedComponent {
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  return {
    kind: 'shared-config',
    identity: ownerIdentity(options.pluginName, `marketplace-${options.marketplaceName}`, 'codex', 'user'),
    label: `${configPath}#marketplaces.${options.marketplaceName}`,
    locator: {
      kind: 'codex-marketplace',
      marketplaceName: options.marketplaceName,
      marketplaceRoot: options.marketplaceRoot,
      desired: options.desired,
    },
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
}): Promise<Record<PlatformName, 'absent' | 'canonical' | 'foreign'>> {
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

function createClaudeMarketplaceComponent(options: {
  pluginName: string;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: NativeCliRunner;
  marketplaceName: string;
  marketplaceRoot: string;
  desired: boolean;
}): OwnedComponent {
  return {
    kind: 'shared-config',
    identity: ownerIdentity(options.pluginName, `marketplace-${options.marketplaceName}`, 'claude', options.scope),
    label: `${resolveClaudePaths(options.cwd, options.scope, options.env).settingsPath}#marketplaces.${options.marketplaceName}`,
    locator: {
      kind: 'claude-marketplace',
      marketplaceName: options.marketplaceName,
      marketplaceRoot: options.marketplaceRoot,
      desired: options.desired,
    },
  };
}

interface StagedCodexNativeRender {
  payloadDigest: string;
  projection: CodexNativeRenderProjection;
  presentSkillKeys: string[];
  targetSkillKeys: string[];
}

interface PreparedCodexNativeRender {
  logicalPluginId: string;
  sourceIdentity: string;
  rendererDigest: string;
  skillsRelativeRoot: string;
  renderedArtifacts: Array<{
    artifact: ValidatedArtifactPlanArtifact;
    skillKey: string;
    tree: DynamicSkillTree;
  }>;
  receiptTargets: Array<{
    id: string;
    skillKey: string;
    configDigest: string;
    artifactDigest: string;
  }>;
  projection: CodexNativeRenderProjection;
  presentSkillKeys: string[];
  targetSkillKeys: string[];
}

const codexNativeRenderPreparationCaches = new WeakMap<
  RebuildExecutionContext,
  WeakMap<PluginMeta, Promise<PreparedCodexNativeRender | null>>
>();

function codexNativeRenderPreparationCache(
  context: RebuildExecutionContext,
): WeakMap<PluginMeta, Promise<PreparedCodexNativeRender | null>> {
  let cache = codexNativeRenderPreparationCaches.get(context);
  if (!cache) {
    cache = new WeakMap();
    codexNativeRenderPreparationCaches.set(context, cache);
  }
  return cache;
}

function pluginHasCodexNativeSkillSurface(plugin: PluginMeta): boolean {
  return plugin.manifest.skills !== undefined
    || codexNativeRenderTargets(plugin).length > 0;
}

async function resolveSensitiveUserConfigValues(
  plugin: PluginMeta,
  env: NodeJS.ProcessEnv,
): Promise<string[]> {
  const hasSensitiveFields = Object.values(plugin.manifest.config?.fields ?? {}).some((field) =>
    field.sensitive === true
    || (field.type === 'object'
      && (Object.values(field.properties ?? {}).some((child) => child.sensitive === true)
        || (field.additionalProperties !== false
          && field.additionalProperties?.sensitive === true))));
  if (!hasSensitiveFields) return [];
  const config = await resolveArtifactRenderConfig({
    sourceId: plugin.sourceId,
    sourceIdentity: plugin.sourceIdentity,
    pluginName: plugin.manifest.name,
    manifest: plugin.manifest,
    scope: 'user',
    cwd: plugin.rootDir,
    env,
  });
  return collectSensitivePluginConfigValues(plugin.manifest, config.values);
}

async function assertNoSensitiveValuesInCodexNativePayload(options: {
  plugin: PluginMeta;
  payloadRoot: string;
  allowedRoot?: string;
  sensitiveValues: readonly string[];
}): Promise<void> {
  if (options.sensitiveValues.length === 0) return;
  if (!await codexPayloadPathSafe(options.payloadRoot, options.allowedRoot)) {
    throw new Error('Codex native sensitive scan payload path is unsafe.');
  }
  const codexManifestPath = path.join(options.payloadRoot, '.codex-plugin', 'plugin.json');
  const codexManifestStats = await lstatCodexResidueIfPresent(codexManifestPath);
  if (!codexManifestStats?.isFile()) {
    throw new Error('Codex native sensitive scan manifest is missing or unsafe.');
  }
  const codexManifest = await fs.readJson(codexManifestPath).catch(() => null) as Record<string, unknown> | null;
  if (!codexManifest
    || codexManifest.name !== options.plugin.manifest.name
    || codexManifest.version !== options.plugin.manifest.version) {
    throw new Error('Codex native sensitive scan manifest identity is invalid.');
  }
  const rawSkillsRoot = codexManifest.skills;
  if (rawSkillsRoot !== undefined) {
    if (typeof rawSkillsRoot !== 'string' || rawSkillsRoot.trim() === '') {
      throw new Error('Codex native sensitive scan Skills root is invalid.');
    }
    const { root: skillsRoot } = await resolveCodexSkillsRoot(
      options.payloadRoot,
      rawSkillsRoot,
    );
    const skillsRootStats = await lstatCodexResidueIfPresent(skillsRoot);
    if (!skillsRootStats?.isDirectory()) {
      throw new Error('Codex native sensitive scan Skills root is missing or unsafe.');
    }
    for (const entry of await fs.readdir(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillRoot = path.join(skillsRoot, entry.name);
      const skillFileStats = await lstatCodexResidueIfPresent(path.join(skillRoot, 'SKILL.md'));
      if (!skillFileStats) continue;
      if (!skillFileStats.isFile()) {
        throw new Error('Codex native sensitive scan Skill entry is unsafe.');
      }
      const tree = await readDynamicSkillTree(skillRoot, 'codex.skill');
      if (!tree) continue;
      const leakedPath = findSensitiveTokenPath(tree.files, options.sensitiveValues);
      if (leakedPath) {
        throw new Error(
          `codexNativeRenderSensitiveValue: Codex native Skill "${entry.name}" exposes ` +
            `sensitive config in "${leakedPath}".`,
        );
      }
    }
  }
  const receiptPath = path.join(options.payloadRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH);
  const receiptStats = await lstatCodexResidueIfPresent(receiptPath);
  if (receiptStats) {
    if (!receiptStats.isFile()) {
      throw new Error('Codex native sensitive scan render receipt path is unsafe.');
    }
    const receiptLeak = findSensitiveTokenPath(
      { [CODEX_NATIVE_RENDER_RECEIPT_PATH]: await fs.readFile(receiptPath) },
      options.sensitiveValues,
    );
    if (receiptLeak) {
      throw new Error(
        `codexNativeRenderSensitiveValue: Codex native render receipt exposes sensitive config in ` +
          `"${receiptLeak}".`,
      );
    }
  }
}

async function prepareCodexNativeRender(options: {
  plugin: PluginMeta;
  env: NodeJS.ProcessEnv;
  scriptTimeoutMs?: number;
}): Promise<PreparedCodexNativeRender | null> {
  const targets = codexNativeRenderTargets(options.plugin);
  if (targets.length === 0) return null;
  const byScope = new Map<Scope, typeof targets>();
  for (const target of targets) {
    const requestScope: Scope = target.scopes.includes('user') ? 'user' : 'project';
    const group = byScope.get(requestScope) ?? [];
    group.push(target);
    byScope.set(requestScope, group);
  }

  const renderedArtifacts: PreparedCodexNativeRender['renderedArtifacts'] = [];
  const receiptTargets: PreparedCodexNativeRender['receiptTargets'] = [];
  const presentSkillKeys: string[] = [];
  let rendererDigest: string | undefined;
  for (const scope of ['user', 'project'] as const) {
    const group = byScope.get(scope);
    if (!group || group.length === 0) continue;
    const rendered = await runArtifactRenderer({
      event: 'install',
      plugin: options.plugin,
      platform: 'codex',
      scope,
      configScope: 'user',
      cwd: options.plugin.rootDir,
      commandEnv: options.env,
      previousArtifacts: [],
      requestedArtifactIds: group.map((target) => target.id),
      scriptTimeoutMs: options.scriptTimeoutMs,
    });
    rendererDigest = rendered.target.rendererDigest;
    const validated = validateArtifactPlan({
      manifest: options.plugin.manifest,
      plan: rendered.plan,
      platform: 'codex',
      scope,
      requestedArtifactIds: rendered.context.requestedArtifactIds,
      renderConfig: rendered.context.config,
      rendererDigest: rendered.target.rendererDigest,
      manifestDigest: rendered.target.manifestDigest,
    });
    for (const artifact of validated.artifacts) {
      if (artifact.target !== 'codex.skill') {
        throw new Error(`Codex native renderer returned non-Skill artifact "${artifact.id}".`);
      }
      const sourceDirs = rendered.context.artifactSources.find((entry) =>
        entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [];
      const tree = await createCodexSkillExpectedTree({
        artifact,
        sourceDirs,
        requireReadme: true,
        requirementsReceipt: requirementsReceipt(options.plugin),
        sourceRequirementsReceiptPolicy: 'allow',
      });
      assertNoSensitiveConfigInFiles(
        tree.files,
        collectSensitivePluginConfigValues(
          options.plugin.manifest,
          rendered.context.config.values,
        ),
        'artifactRendererSensitiveConfigExposed: Final dynamic Skill contains sensitive config.',
      );
      const skillKey = artifact.skillKey!;
      renderedArtifacts.push({
        artifact,
        skillKey,
        tree,
      });
      if (artifact.state === 'present') presentSkillKeys.push(skillKey);
      receiptTargets.push({
        id: artifact.id,
        skillKey,
        configDigest: artifact.configDigest,
        artifactDigest: createCodexSkillStagingTreeContentDigest(tree),
      });
    }
  }
  if (!rendererDigest || renderedArtifacts.length !== targets.length) {
    throw new Error('Codex native renderer did not produce the complete declared target set.');
  }

  const skillsRelativeRoot = await resolveCodexSkillsRelativeRoot(options.plugin);
  const logicalPluginId = options.plugin.pluginId
    ?? (options.plugin.sourceId ? `${options.plugin.sourceId}/${options.plugin.manifest.name}` : undefined);
  if (!logicalPluginId || !options.plugin.sourceIdentity) {
    throw new Error('Codex native render materialization requires namespaced source identity.');
  }
  const projection = createCodexNativeRenderProjection({
    logicalPluginId,
    sourceIdentity: options.plugin.sourceIdentity,
    pluginVersion: options.plugin.manifest.version,
    rendererDigest,
    targets: receiptTargets,
  });
  return {
    logicalPluginId,
    sourceIdentity: options.plugin.sourceIdentity,
    rendererDigest,
    skillsRelativeRoot,
    renderedArtifacts,
    receiptTargets,
    projection,
    presentSkillKeys: presentSkillKeys.sort(),
    targetSkillKeys: targets.map((target) => target.skillKey!).sort(),
  };
}

function prepareCodexNativeRenderCached(options: {
  context: RebuildExecutionContext;
  plugin: PluginMeta;
  scriptTimeoutMs?: number;
}): Promise<PreparedCodexNativeRender | null> {
  const cache = codexNativeRenderPreparationCache(options.context);
  let preparation = cache.get(options.plugin);
  if (!preparation) {
    preparation = prepareCodexNativeRender({
      plugin: options.plugin,
      env: options.context.env,
      scriptTimeoutMs: options.scriptTimeoutMs,
    });
    cache.set(options.plugin, preparation);
  }
  return preparation;
}

async function requirePreparedCodexNativeRender(options: {
  context: RebuildExecutionContext;
  plugin: PluginMeta;
}): Promise<PreparedCodexNativeRender | null> {
  if (codexNativeRenderTargets(options.plugin).length === 0) return null;
  const preparation = codexNativeRenderPreparationCache(options.context).get(options.plugin);
  if (!preparation) {
    throw new Error('codexNativeRenderPreflightMissing: Codex native renderer was not prepared.');
  }
  return preparation;
}

async function materializeCodexNativeRender(options: {
  plugin: PluginMeta;
  stagingRoot: string;
  prepared: PreparedCodexNativeRender;
  hasStaticSkills: boolean;
}): Promise<StagedCodexNativeRender> {
  const skillsRoot = path.join(
    options.stagingRoot,
    'plugins',
    options.plugin.manifest.name,
    ...options.prepared.skillsRelativeRoot.split('/'),
  );
  for (const { artifact, skillKey, tree } of options.prepared.renderedArtifacts) {
    const skillRoot = path.join(skillsRoot, skillKey);
    if (artifact.state === 'present') {
      await writeDynamicSkillTree(skillRoot, tree);
    } else {
      await fs.remove(skillRoot);
    }
  }
  await ensureCodexActiveSkillsManifest({
    plugin: options.plugin,
    marketplaceRoot: options.stagingRoot,
    hasRequiredSkills: options.hasStaticSkills || options.prepared.presentSkillKeys.length > 0,
  });
  const pluginRoot = path.join(options.stagingRoot, 'plugins', options.plugin.manifest.name);
  const payloadDigest = await calculateCodexNativeRenderPayloadDigest(pluginRoot);
  const receipt = createCodexNativeRenderReceipt({
    logicalPluginId: options.prepared.logicalPluginId,
    sourceIdentity: options.prepared.sourceIdentity,
    pluginVersion: options.plugin.manifest.version,
    rendererDigest: options.prepared.rendererDigest,
    targets: options.prepared.receiptTargets,
    payloadDigest,
  });
  await fs.outputFile(
    path.join(pluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    serializeCodexNativeRenderReceipt(receipt),
    'utf8',
  );
  return {
    payloadDigest,
    projection: options.prepared.projection,
    presentSkillKeys: options.prepared.presentSkillKeys,
    targetSkillKeys: options.prepared.targetSkillKeys,
  };
}

async function mirrorCatalog(
  catalog: CatalogResolution,
  env: NodeJS.ProcessEnv,
  target?: Pick<RebuildTargetIdentity, 'sourceId' | 'sourceIdentity' | 'marketplaceName' | 'marketplaceRoot'>,
  logicalIdentity?: string,
  prepareStaging?: (stagingRoot: string) => Promise<void>,
): Promise<{
  rootDir: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}> {
  if (!target?.sourceId || !target.marketplaceRoot) {
    const rootDir = resolveAwHome(env);
    await fs.ensureDir(rootDir);
    await fs.copy(catalog.rootDir, rootDir, { overwrite: true });
    await prepareStaging?.(rootDir);
    return { rootDir, commit: async () => undefined, rollback: async () => undefined };
  }
  const awHome = path.resolve(resolveAwHome(env));
  const destination = target.marketplaceRoot;
  const parent = path.dirname(destination);
  if (!await isSafeCodexMarketplaceRoot({
    awHome,
    sourceId: target.sourceId,
    marketplaceRoot: destination,
  })) {
    throw new Error(`marketplaceRootInvalid: marketplace root is unsafe: ${destination}`);
  }
  if (!await fs.pathExists(parent)) {
    await fs.mkdir(parent);
  }
  if (!await isSafeCodexMarketplaceRoot({
    awHome,
    sourceId: target.sourceId,
    marketplaceRoot: destination,
  })) {
    throw new Error(`marketplaceRootInvalid: marketplace root became unsafe: ${destination}`);
  }
  const staging = await fs.mkdtemp(path.join(parent, `.${target.sourceId}-staging-`));
  try {
    for (const entry of ['.agents', '.claude-plugin', 'plugins']) {
      await fs.copy(path.join(catalog.rootDir, entry), path.join(staging, entry));
    }
    const marketplaceName = target.marketplaceName ?? getNamespacedMarketplaceName(target.sourceId);
    for (const [platform, manifestPath] of [
      ['codex', path.join(staging, '.agents', 'plugins', 'marketplace.json')],
      ['claude', path.join(staging, '.claude-plugin', 'marketplace.json')],
    ] as const) {
      const manifest = await fs.readJson(manifestPath) as MarketplaceManifest;
      await fs.writeJson(manifestPath, {
        ...projectMarketplaceManifestForPlatform(manifest, platform),
        name: marketplaceName,
      }, { spaces: 2 });
    }
    await fs.writeJson(path.join(staging, 'config.json'), {
      schemaVersion: 2,
      sourceId: target.sourceId,
      sourceIdentity: target.sourceIdentity,
      logicalIdentity,
      marketplaceName,
    }, { spaces: 2 });
    const destinationExists = await fs.lstat(destination).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      },
    );
    if (destinationExists) {
      await replayNamespacedCodexSkillOverlays({
        sourceRoot: destination,
        stagingRoot: staging,
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity!,
        marketplaceName,
      });
    }
    await prepareStaging?.(staging);
    const backup = `${destination}.backup-${crypto.randomUUID()}`;
    if (destinationExists) await fs.move(destination, backup);
    try {
      await fs.move(staging, destination);
    } catch (error) {
      const backupStats = await fs.lstat(backup).catch((inspectionError: NodeJS.ErrnoException) => {
        if (inspectionError.code === 'ENOENT') return null;
        throw inspectionError;
      });
      const destinationStats = await fs.lstat(destination).catch((inspectionError: NodeJS.ErrnoException) => {
        if (inspectionError.code === 'ENOENT') return null;
        throw inspectionError;
      });
      if (backupStats && !destinationStats) {
        await fs.move(backup, destination);
      }
      throw error;
    }
    let state: 'active' | 'committed' | 'rolledBack' = 'active';
    return {
      rootDir: destination,
      commit: async () => {
        if (state !== 'active') return;
        try {
          await commitMarketplaceGenerationBackup({
            backupRoot: backup,
            sourceId: target.sourceId!,
            sourceIdentity: target.sourceIdentity!,
            ...(target.marketplaceName ? { marketplaceName: target.marketplaceName } : {}),
            env,
          });
          state = 'committed';
        } catch (error) {
          if ((error as { durableMaterializeCommit?: unknown }).durableMaterializeCommit === true) {
            state = 'committed';
          }
          throw error;
        }
      },
      rollback: async () => {
        if (state !== 'active') return;
        const backupStats = await fs.lstat(backup).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        await fs.remove(destination);
        if (backupStats) await fs.move(backup, destination);
        state = 'rolledBack';
      },
    };
  } catch (error) {
    await fs.remove(staging);
    throw error;
  }
}

async function applyPlannedOperationAction(action: OperationAction): Promise<void> {
  switch (action.kind) {
    case 'writeOwnedArtifact': {
      if (!action.owner || !action.allowedRoot || !action.artifactKind) {
        throw new Error('Owned artifact action is missing owner or locator data.');
      }
      if (action.artifactKind === 'owned-text-file') {
        if (action.content === undefined) throw new Error('Owned text action is missing content.');
        const digest = `sha256:${crypto.createHash('sha256').update(action.content).digest('hex')}`;
        if (digest !== action.contentDigest) throw new Error('Owned text action content digest mismatch.');
        if (action.sourceContent === undefined) throw new Error('Owned text action is missing source content.');
        await fs.ensureDir(action.allowedRoot);
        await writeOwnedTextFile({
          path: action.path,
          allowedRoot: action.allowedRoot,
          identity: action.owner,
          content: action.sourceContent,
        });
        return;
      }
      const files = action.files ?? [];
      const digest = `sha256:${crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')}`;
      if (digest !== action.contentDigest) throw new Error('Skill action content digest mismatch.');
      const treeFiles: Record<string, Buffer> = {};
      for (const file of files) {
        const content = Buffer.from(file.contentBase64, 'base64');
        if (`sha256:${crypto.createHash('sha256').update(content).digest('hex')}` !== file.contentDigest) {
          throw new Error(`Skill action file digest mismatch: ${file.relativePath}`);
        }
        if (file.relativePath !== '.agent-workflows-owner.json') treeFiles[file.relativePath] = content;
      }
      await writeDynamicSkillTree(action.path, {
        skillKey: action.owner.artifactKey,
        files: treeFiles,
      }, {
        allowedRoot: action.allowedRoot,
        identity: action.owner,
        allowPristineUnowned: action.allowPristineUnowned === true,
      });
      return;
    }
    case 'updateSharedConfig': {
      const mutation = action.mutation;
      switch (mutation.kind) {
        case 'claude-permissions': {
          if (action.locator.kind !== 'claude-permissions') throw new Error('Claude permission locator mismatch.');
          const settings = await readClaudeSettings(action.locator.settingsPath);
          rebuildClaudePermissions(
            settings,
            action.locator.ownerKey,
            mutation.permissions as ClaudePermissions,
          );
          await writeClaudeSettings(action.locator.settingsPath, settings);
          return;
        }
        case 'codex-instruction': {
          if (action.locator.kind !== 'codex-instruction') throw new Error('Codex instruction locator mismatch.');
          await applyCodexConfigTransactionFile(action.locator.configPath, mutation.block
            ? { upsertManagedInstructionBlock: mutation.block }
            : { removeManagedInstructionPluginName: action.locator.ownerKey });
          return;
        }
        case 'codex-role-registration': {
          if (action.locator.kind !== 'codex-role-registration') throw new Error('Codex role locator mismatch.');
          const locator = action.locator;
          const registration: CodexAgentRegistrationConfig = {
            description: mutation.description,
            configFile: mutation.configFile.split(path.sep).join('/'),
          };
          await applyConditionalCodexConfigTransactionFile(locator.configPath, async (snapshot) => {
            const actual = snapshot.agents[mutation.roleKey];
            if (actual && !await codexRoleRegistrationOwned({
              fileIdentity: locator.fileIdentity,
              configPath: locator.configPath,
              roleKey: mutation.roleKey,
              rolePath: locator.rolePath,
              registration: actual,
            })) {
              throw new Error(
                `Codex agent registration "${mutation.roleKey}" is foreign and cannot be overwritten by plugin "${action.owner.plugin}".`,
              );
            }
            return { upsertAgentRegistrations: { [mutation.roleKey]: registration } };
          });
          return;
        }
        case 'codex-activation':
          throw new Error('Codex activation must use a setActivation action.');
      }
    }
    case 'setActivation':
      if (!action.configPath || !action.registration) {
        throw new Error('Activation action is missing configPath or registration.');
      }
      await applyCodexConfigTransactionFile(action.configPath, {
        upsertPluginActivations: { [action.registration]: action.enabled },
      });
      return;
    default:
      throw new Error(`Operation action ${action.kind} is not an artifact write action.`);
  }
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
  const currentCodexManager = (): CodexManager | undefined => options.context.codexManager;
  const nativeGroupPreparations = new Map<string, Promise<void>>();
  const nativeTargetPreparations = new WeakMap<DesiredTarget, Promise<void>>();
  const codexNativeStates = new Map<string, 'present' | 'absent'>();
  const pendingCodexNativeStates = new Map<string, 'present' | 'absent'>();
  const codexMutationMarketplaces = new Set<string>();
  const completedNativeSkillWrites = new WeakSet<OperationAction>();
  const committedNativeGroups = new Set<string>();
  let nativeMarketplaceEligibleTargets: ReadonlySet<DesiredTarget> | undefined;
  let deferredPostchecks: Array<{
    target: DesiredTarget;
    postcheck: () => Promise<void>;
  }> = [];
  const nativeGroupKey = (target: DesiredTarget): string => [
    target.identity.sourceId ?? '',
    target.identity.sourceIdentity ?? '',
    target.identity.marketplaceName ?? MARKETPLACE_NAME,
    path.normalize(path.resolve(target.identity.marketplaceRoot ?? resolveAwHome(options.context.env))),
    target.identity.platform,
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
  const nativeSkillOverlay = async (target: DesiredTarget): Promise<{
    marketplaceRoot: string;
    writes: Array<Extract<OperationAction, { kind: 'writeOwnedArtifact' }>>;
  }> => {
    const canonicalMarketplaceRoot = await canonicalizePathThroughExistingAncestor(
      target.identity.marketplaceRoot ?? resolveAwHome(options.context.env),
    );
    const nativePluginRoot = await canonicalizePathThroughExistingAncestor(path.join(
      canonicalMarketplaceRoot,
      'plugins',
      target.identity.pluginName,
    ));
    const desiredSkillPaths = new Set((target.desiredOwnedComponents ?? [])
      .filter((component) => component.kind === 'skill-directory')
      .map((component) => path.resolve(component.path)));
    const enabledSkillPaths = new Set(target.artifacts
      .filter((artifact) => artifact.kind === 'skill' && artifact.state !== 'disabled')
      .map((artifact) => path.resolve(artifact.path)));
    return {
      marketplaceRoot: canonicalMarketplaceRoot,
      writes: (target.operationActions ?? []).filter((action): action is Extract<
        OperationAction,
        { kind: 'writeOwnedArtifact' }
      > => action.kind === 'writeOwnedArtifact'
        && action.artifactKind === 'skill-directory'
        && desiredSkillPaths.has(path.resolve(action.path))
        && enabledSkillPaths.has(path.resolve(action.path))
        && target.identity.scope === 'user'
        && !path.relative(nativePluginRoot, action.path).startsWith('..')),
    };
  };
  const asNativeGroupFailure = (error: unknown): Error & {
    nativeMarketplaceGroupFailure: true;
  } => {
    const result = error instanceof Error ? error : new Error(String(error));
    return Object.assign(result, { nativeMarketplaceGroupFailure: true as const });
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
    const key = nativeGroupKey(target);
    let preparation = options.operationScopedNativePhases
      ? nativeGroupPreparations.get(key)
      : nativeTargetPreparations.get(target);
    if (!preparation) {
      preparation = (async () => {
        const members = groupTargets(target);
        const materializing = members.filter((candidate) =>
          candidate.writeNativeRequired ?? candidate.requiresNative);
        const overlayTargets = members.filter((candidate) =>
          candidate.nativeOverlayDesired ?? candidate.requiresNative);
        if (target.identity.platform === 'codex') {
          const observationScope = codexObservationScope(
            options.context,
            target.identity.marketplaceName ?? MARKETPLACE_NAME,
            members.some((candidate) => candidate.identity.scope === 'project') ? 'project' : 'user',
          );
          const nativePluginIds = [...new Set(members.flatMap((candidate) =>
            candidate.ownedComponents.flatMap((component) =>
              component.kind === 'native-plugin' ? [component.pluginId] : [])))].sort();
          for (const pluginId of nativePluginIds) {
            const member = members.find((candidate) => candidate.ownedComponents.some((component) =>
              component.kind === 'native-plugin' && component.pluginId === pluginId))!;
            const registration = await inspectCodexPluginRegistrationLive({
              pluginId,
              cwd: member.identity.cwd,
              env: options.context.env,
              nativeCliRunner: runner,
              manager: currentCodexManager(),
              scope: observationScope,
              observationSession: options.context.codexObservationSession,
            });
            codexNativeStates.set(
              codexStateKey(member, pluginId),
              requireObservedCodexNativeState(
                registration.observation,
                'native group precheck',
              ) === 'installed' ? 'present' : 'absent',
            );
          }
        }
        if (materializing.length === 0) return;
        const first = materializing[0]!;
        if (!first.catalog) throw new Error('Missing rebuild target catalog data.');
        const catalogRoot = path.resolve(first.catalog.rootDir);
        if (overlayTargets.some((candidate) =>
          !candidate.catalog || path.resolve(candidate.catalog.rootDir) !== catalogRoot)) {
          throw new Error('nativeMarketplaceGroupInvalid: grouped targets do not share one Catalog root.');
        }
        const materializationTargets = [...overlayTargets].sort((left, right) => [
          left.identity.pluginId ?? left.identity.pluginName,
          left.identity.scope,
          left.identity.cwd,
        ].join('\0').localeCompare([
          right.identity.pluginId ?? right.identity.pluginName,
          right.identity.scope,
          right.identity.cwd,
        ].join('\0'), 'en'));
        const nativeSkillOverlays = new Map(await Promise.all(
          materializationTargets.map(async (candidate) => [
            candidate,
            await nativeSkillOverlay(candidate),
          ] as const),
        ));
        const transaction = await mirrorCatalog(
          first.catalog,
          options.context.env,
          first.identity,
          first.plugin.catalogLogicalIdentity,
          first.identity.platform === 'codex' ? async (stagingRoot) => {
            for (const candidate of materializationTargets) {
              const overlay = nativeSkillOverlays.get(candidate)!;
              const requiredSkillWrites = overlay.writes;
              for (const action of requiredSkillWrites) {
                await applyPlannedOperationAction({
                  ...action,
                  path: path.join(stagingRoot, path.relative(overlay.marketplaceRoot, action.path)),
                  allowedRoot: path.join(
                    stagingRoot,
                    path.relative(overlay.marketplaceRoot, action.allowedRoot!),
                  ),
                });
              }
              const hasStaticSkills = candidate.plugin.manifest.skills !== undefined
                || requiredSkillWrites.length > 0;
              const preparedNativeRender = await requirePreparedCodexNativeRender({
                context: options.context,
                plugin: candidate.plugin,
              });
              const nativeRender = preparedNativeRender
                ? await materializeCodexNativeRender({
                    plugin: candidate.plugin,
                    stagingRoot,
                    prepared: preparedNativeRender,
                    hasStaticSkills,
                  })
                : null;
              if (!nativeRender) {
                await ensureCodexActiveSkillsManifest({
                  plugin: candidate.plugin,
                  marketplaceRoot: stagingRoot,
                  hasRequiredSkills: hasStaticSkills,
                });
              }
              if (pluginHasCodexNativeSkillSurface(candidate.plugin)) {
                await assertNoSensitiveValuesInCodexNativePayload({
                  plugin: candidate.plugin,
                  payloadRoot: path.join(stagingRoot, 'plugins', candidate.identity.pluginName),
                  allowedRoot: stagingRoot,
                  sensitiveValues: await resolveSensitiveUserConfigValues(
                    candidate.plugin,
                    options.context.env,
                  ),
                });
              }
            }
          } : undefined,
        );
        try {
          await transaction.commit();
        } catch (error) {
          if ((error as { durableMaterializeCommit?: unknown }).durableMaterializeCommit !== true) {
            try {
              await transaction.rollback();
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                'nativeMarketplaceGroupCommitFailed: marketplace commit and rollback failed.',
              );
            }
          }
          throw error;
        }
        for (const candidate of materializationTargets) {
          for (const action of nativeSkillOverlays.get(candidate)?.writes ?? []) {
            completedNativeSkillWrites.add(action);
          }
        }
        committedNativeGroups.add(key);
      })().catch((error) => {
        throw asNativeGroupFailure(error);
      });
      if (options.operationScopedNativePhases) {
        nativeGroupPreparations.set(key, preparation);
      } else {
        nativeTargetPreparations.set(target, preparation);
      }
    }
    await preparation;
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
      const expectedFiles = new Map(files.map((entry) => [entry.relativePath, entry.contentDigest]));
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
          if (expectedFiles.get(relativePath) !== digest) return false;
          seen.add(relativePath);
        }
      }
      return seen.size === expectedFiles.size;
    },
  };
  return {
    ownership,
    setNativeMarketplaceEligibleTargets: (eligibleTargets) => {
      nativeMarketplaceEligibleTargets = new Set(eligibleTargets);
    },
    prepareNativeMarketplaceGroup: prepareNativeGroup,
    selectRecoveryCleanupComponents: (target, components) => {
      if (!committedNativeGroups.has(nativeGroupKey(target))) return components;
      const marketplaceRoot = path.resolve(
        target.identity.marketplaceRoot ?? resolveAwHome(options.context.env),
      );
      return components.filter((component) => {
        if (!('path' in component)) return true;
        const relative = path.relative(marketplaceRoot, path.resolve(component.path));
        return relative === '..'
          || relative.startsWith(`..${path.sep}`)
          || path.isAbsolute(relative);
      });
    },
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
      if (codexMutationMarketplaces.size === 0) return;
      const session = options.context.codexObservationSession;
      if (!session) {
        throw new Error('codexNativeObservationUnavailable: grouped postcheck requires an observation session.');
      }
      const marketplaces = [...codexMutationMarketplaces].sort();
      codexMutationMarketplaces.clear();
      for (const marketplaceName of marketplaces) session.invalidate(marketplaceName);
      await Promise.all(marketplaces.map((marketplaceName) =>
        session.snapshot(
          marketplaceName,
          options.context.codexObservationScopeByMarketplace?.get(marketplaceName)
            ?? (options.targets.some((target) =>
              (nativeMarketplaceEligibleTargets?.has(target) ?? true)
              && target.identity.platform === 'codex'
              && (target.identity.marketplaceName ?? MARKETPLACE_NAME) === marketplaceName
              && target.identity.scope === 'project')
              ? 'both'
              : 'user'),
        )));
    },
    preflightMutation: async (target) => {
      if (!target.codexNativeObservationExpectation
        && !target.codexNativeSensitivePreflightRequired) return;
      const sensitiveValues = pluginHasCodexNativeSkillSurface(target.plugin)
        ? await resolveSensitiveUserConfigValues(target.plugin, options.context.env)
        : [];
      if (sensitiveValues.length > 0) {
        await assertNoSensitiveValuesInCanonicalCodexNativePayload({
          plugin: target.plugin,
          marketplaceRoot: target.identity.marketplaceRoot ?? resolveAwHome(options.context.env),
          env: options.context.env,
          sensitiveValues,
        });
      }
      if (!target.codexNativeObservationExpectation) return;
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
      const observed = requireObservedCodexNativeState(
        registration.observation,
        'artifact write precheck',
      );
      if (target.codexNativeObservationExpectation === 'installed' && observed !== 'installed') {
        throw new Error(
          'codexNativeExpectedInstalled: artifact write precheck requires the reused Codex plugin to remain installed.',
        );
      }
    },
    preflightMaterialize: async (target) => {
      if (target.identity.sourceId && options.context.expectedCatalogConfigDigest) {
        const current = await readCatalogSourcesConfigSnapshot(options.context.env);
        if (current.digest !== options.context.expectedCatalogConfigDigest) {
          throw new Error('catalogSourceConflict: catalog source config changed before owner publication.');
        }
      }
      if (target.identity.platform === 'claude') {
        await assertNoClaudeUnboundNativeNameCollision({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
        });
        return;
      }
      const marketplaceName = target.identity.marketplaceName ?? MARKETPLACE_NAME;
      const marketplaceRoot = target.identity.marketplaceRoot ?? resolveAwHome(options.context.env);
      const config = await readCodexConfigFile(
        resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
      );
      const marketplace = config.snapshot.marketplaces[marketplaceName];
      const canonical = marketplace?.sourceType === 'local'
        && !marketplace.sourcePointsToManifest
        && path.resolve(marketplace.source ?? '') === path.resolve(marketplaceRoot);
      const expectedPluginId = `${target.identity.pluginName}@${marketplaceName}`;
      if ((marketplace !== undefined && !canonical)
        || (Object.hasOwn(config.snapshot.plugins, expectedPluginId) && !canonical)) {
        throw new Error(
          `externalOwnershipPresent: Codex marketplace ${marketplaceName} has a foreign source instead of its canonical namespaced root.`,
        );
      }
      if (target.nativeOverlayDesired) {
        await prepareCodexNativeRenderCached({
          context: options.context,
          plugin: target.plugin,
          scriptTimeoutMs: options.scriptTimeoutMs,
        });
      }
    },
    finalizeCleanup: async () => undefined,
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
        return state.pluginEnabled ? 'present' : 'partial';
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
        if (!removalRequired) return;
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
        } catch {
          throw new Error(`codexNativeRemoveFailed: ${CODEX_REMOVE_RECOVERY}`);
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
    writeNative: async (target) => {
      if (!target.catalog) throw new Error('Missing rebuild target catalog data.');
      const marketplaceName = target.identity.marketplaceName ?? MARKETPLACE_NAME;
      const expectedMarketplaceRoot = target.identity.marketplaceRoot ?? resolveAwHome(options.context.env);
      if (target.identity.platform === 'codex') {
        const config = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const marketplace = config.snapshot.marketplaces[marketplaceName];
        if (marketplace && (
          marketplace.sourceType !== 'local'
          || marketplace.sourcePointsToManifest
          || path.normalize(marketplace.source ?? '') !== path.normalize(expectedMarketplaceRoot)
        )) {
          throw new Error(
            `externalOwnershipPresent: Codex marketplace ${marketplaceName} 已由 foreign source 占用，拒绝覆盖。`,
          );
        }
      } else {
        const state = await readClaudeNativeState({
          pluginName: target.identity.pluginName,
          scope: target.identity.scope,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName,
          marketplaceRoot: expectedMarketplaceRoot,
        });
        if (state.marketplaceState === 'foreign') {
          throw new Error(`Claude marketplace ${marketplaceName} 已由 foreign source 占用，拒绝覆盖。`);
        }
      }
      await prepareNativeGroup(target);
      const pluginId = `${target.identity.pluginName}@${marketplaceName}`;
      if (target.identity.platform === 'codex') {
        const stateKey = codexStateKey(target, pluginId);
        const codexRemovalRequired = pendingCodexNativeStates.get(stateKey)
          ?? codexNativeStates.get(stateKey);
        if (!codexRemovalRequired) {
          throw new Error('codexNativeObservationUnavailable: native group precheck is missing.');
        }
        if (codexRemovalRequired === 'present') {
          codexMutationMarketplaces.add(marketplaceName);
          await runObservedCodexMutation({
            marketplaceName,
            mutation: () => runNativeCliChecked(
              buildCodexPluginRemoveInvocation(
                requireCodexManager(currentCodexManager()),
                pluginId,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            ),
          });
          pendingCodexNativeStates.set(stateKey, 'absent');
        }
        const config = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const marketplace = config.snapshot.marketplaces[marketplaceName];
        if (path.normalize(marketplace?.source ?? '') !== path.normalize(expectedMarketplaceRoot)) {
          codexMutationMarketplaces.add(marketplaceName);
          await runObservedCodexMutation({
            marketplaceName,
            mutation: () => runNativeCliChecked(
              buildCodexMarketplaceAddInvocation(
                requireCodexManager(currentCodexManager()),
                expectedMarketplaceRoot,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            ),
          });
        }
        codexMutationMarketplaces.add(marketplaceName);
        await runObservedCodexMutation({
          marketplaceName,
          mutation: () => runNativeCliChecked(
            buildCodexPluginAddInvocation(
              requireCodexManager(currentCodexManager()),
              pluginId,
              target.identity.cwd,
              options.context.env,
            ),
            runner,
          ),
        });
        pendingCodexNativeStates.set(stateKey, 'present');
        const installedConfig = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const installedMarketplace = installedConfig.snapshot.marketplaces[marketplaceName];
        if (installedMarketplace?.sourceType !== 'local'
          || installedMarketplace.sourcePointsToManifest
          || path.normalize(installedMarketplace.source ?? '') !== path.normalize(expectedMarketplaceRoot)
          || installedConfig.snapshot.plugins[pluginId]?.enabled !== true) {
          throw new Error(`codexNativeInstallIncomplete: ${pluginId} public config is not canonical and enabled.`);
        }
      } else {
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'marketplace', 'add', expectedMarketplaceRoot, '--scope', target.identity.scope],
          cwd: target.identity.cwd,
          env: options.context.env,
        }, runner);
        await runNativeCliChecked({
          command: 'claude',
          args: ['plugin', 'install', pluginId, '--scope', target.identity.scope],
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
          marketplaceName,
          marketplaceRoot: expectedMarketplaceRoot,
        });
        if (
          after.marketplaceDeclaredState !== 'canonical'
          || after.marketplaceMaterializedState !== 'canonical'
          || after.pluginState !== 'present'
          || !after.pluginEnabled
          || !after.pluginVersions.includes(target.identity.pluginVersion)
        ) {
          throw new Error(
            `Claude native install postcheck 失败：declaredMarketplace=${after.marketplaceDeclaredState}，materializedMarketplace=${after.marketplaceMaterializedState}，plugin=${after.pluginState}，enabled=${after.pluginEnabled}，versions=${after.pluginVersions.join(',')}。`,
          );
        }
      }
    },
    writeArtifacts: async (target) => {
      for (const operationAction of target.operationActions ?? []) {
        if (completedNativeSkillWrites.has(operationAction)) continue;
        if (operationAction.kind === 'writeOwnedArtifact'
          || operationAction.kind === 'updateSharedConfig'
          || operationAction.kind === 'setActivation') {
          await applyPlannedOperationAction(operationAction);
        }
      }
      return target.artifacts;
    },
    runPreApply: async (invocation: RebuildPreApplyInvocation) => {
      await runPreApplyScript({
        plugin: invocation.plugin,
        platform: invocation.target.identity.platform,
        scope: invocation.target.identity.scope,
        cwd: invocation.target.identity.cwd,
        context: options.context as never,
        scriptTimeoutMs: options.scriptTimeoutMs,
      });
    },
  };
}

export function createRebuildIntegration(options: {
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
  preparedTargets?: readonly DesiredTarget[];
  operationScopedNativePhases?: boolean;
}): RebuildIntegration {
  const targets = [...(options.preparedTargets ?? [])];
  const driver = createNativeDriver({ targets, ...options });
  return {
    driver,
    setNativeMarketplaceEligibleTargets: driver.setNativeMarketplaceEligibleTargets,
    prepareNativeMarketplaceGroup: driver.prepareNativeMarketplaceGroup,
    captureCodexPostMutationSnapshots: driver.captureCodexPostMutationSnapshots,
    buildTarget: async (input) => {
      input = {
        ...input,
        sourceId: input.sourceId ?? input.plugin.sourceId,
        sourceIdentity: input.sourceIdentity ?? input.plugin.sourceIdentity,
        pluginId: input.pluginId ?? input.plugin.pluginId,
      };
      const materializing = input.command !== 'cleanup'
        && input.command !== 'uninstall'
        && input.readOnlyInspectionPlan !== true;
      if (input.scope === 'project') {
        const canonicalRepoRoot = await assertCanonicalProjectManagedRoots({
          cwd: input.cwd,
          rootNames: input.platform === 'codex' ? ['.agents', '.codex'] : ['.claude'],
          managedPaths: input.platform === 'codex'
            ? ['.codex/config.toml']
            : ['.claude/settings.json'],
        });
        input = { ...input, cwd: canonicalRepoRoot };
      }
      if (materializing && input.platform === 'codex') {
        await preflightCodexWriteSafety({
          plugin: input.plugin,
          scope: input.scope,
          cwd: input.cwd,
          env: options.context.env,
        });
      }
      const event = 'install' as const;
      const historicalArtifacts: GeneratedArtifact[] = [];
      let writes: PlannedWrite[] = [];
      let currentRemovalComponents: OwnedComponent[] = [];
      if (input.command !== 'cleanup' && input.command !== 'uninstall') {
        if (input.readOnlyInspectionPlan) {
          writes = await buildInspectionWrites({
            plugin: input.plugin,
            platform: input.platform,
            scope: input.scope,
            cwd: input.cwd,
            env: options.context.env,
            marketplaceRoot: input.marketplaceRoot,
            marketplaceName: input.marketplaceName,
            userActivationDesired: options.context.codexUserActivationDesired,
            shallow: input.readOnlyShallowInspectionPlan,
          });
        } else if (input.platform === 'codex') {
          writes = await buildCodexWrites({
            ...input,
            env: options.context.env,
            event,
            historicalArtifacts,
            scriptTimeoutMs: options.scriptTimeoutMs,
            marketplaceName: input.marketplaceName,
            userActivationDesired: options.context.codexUserActivationDesired,
          });
        } else {
          writes = await buildClaudeWrites({
            ...input,
            env: options.context.env,
            event,
            historicalArtifacts,
            scriptTimeoutMs: options.scriptTimeoutMs,
          });
        }
      } else if (input.platform === 'codex' && input.scope === 'project') {
        const currentRemovalWrites = await buildInspectionWrites({
          plugin: input.plugin,
          platform: input.platform,
          scope: input.scope,
          cwd: input.cwd,
          env: options.context.env,
          marketplaceRoot: input.marketplaceRoot,
          marketplaceName: input.marketplaceName,
          userActivationDesired: options.context.codexUserActivationDesired,
        });
        currentRemovalComponents = currentRemovalWrites.flatMap((write) => [
          ...(write.additionalComponents ?? []),
          ...(write.component ? [write.component] : []),
        ]);
      }
      const desiredComponents = writes.filter((write) => !write.optional).flatMap((write) => [
        ...(write.additionalComponents ?? []),
        ...(write.component ? [write.component] : []),
      ]);
      const optionalComponents = writes
        .filter((write) => write.optional)
        .flatMap((write) => [
          ...(write.additionalComponents ?? []),
          ...(write.component ? [write.component] : []),
        ]);
      const optionalComponentKeys = new Set(optionalComponents.map(componentIdentityKey));
      const preserveCodexSharedNativePayload = input.platform === 'codex'
        && (input.command === 'cleanup'
          || input.command === 'uninstall'
          || input.preserveCodexSharedNativePayload === true);
      const configDir = input.platform === 'codex'
        ? resolveCodexPaths(input.cwd, input.scope, options.context.env).configDir
        : resolveClaudePaths(input.cwd, input.scope, options.context.env).configDir;
      const textRoots = input.platform === 'codex'
        ? [path.join(configDir, 'rules'), path.join(configDir, 'agents')]
        : [path.join(configDir, 'rules'), path.join(configDir, 'agents')];
      const scannedText = (await Promise.all(textRoots.map((root) => scanOwnedTextFiles({
        sourceId: input.sourceId,
        sourceIdentity: input.sourceIdentity,
        root,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
      })))).flat();
      const skillRoots = input.platform === 'codex'
        ? input.scope === 'project'
          ? materializing
            ? [path.join(input.cwd, '.agents', 'skills')]
            : []
          : [
              path.join(getCodexHome(options.context.env), 'skills'),
              ...(preserveCodexSharedNativePayload || input.readOnlyShallowInspectionPlan === true
                ? []
                : [await canonicalizePathThroughExistingAncestor(path.join(
                    input.marketplaceRoot ?? resolveAwHome(options.context.env),
                    'plugins',
                    input.plugin.manifest.name,
                  ))]),
            ]
        : [path.join(configDir, 'skills')];
      const scanSkills = () => Promise.all(skillRoots.map((root) => scanOwnedSkills({
        sourceId: input.sourceId,
        sourceIdentity: input.sourceIdentity,
        root,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
        recursive: !(input.platform === 'codex' && input.scope === 'project'),
      })));
      const scannedSkills = (await scanSkills()).flat();
      const legacyCodexNativeSkills = input.platform === 'codex'
        ? (await (async () => {
            const skillKeys = [...new Set(codexNativeRenderTargets(input.plugin)
              .map((target) => target.skillKey!))];
            if (skillKeys.length === 0) return [];
            const projectRoot = await assertCanonicalProjectManagedRoots({
              cwd: input.cwd,
              rootNames: ['.agents'],
            });
            const roots = [
              {
                root: path.join(getCodexHome(options.context.env), 'skills'),
                scope: 'user' as const,
              },
              {
                root: path.join(projectRoot, '.agents', 'skills'),
                scope: 'project' as const,
              },
            ];
            return roots.flatMap(({ root, scope }) => skillKeys.map((skillKey) => pathComponent({
              kind: 'skill-directory',
              path: path.join(root, skillKey),
              allowedRoot: root,
              identity: ownerIdentity(
                input.plugin.manifest.name,
                skillKey,
                'codex',
                scope,
              ),
            })));
          })())
        : [];
      let historicalComponents = await buildHistoricalComponents({
        sourceId: input.sourceId,
        sourceIdentity: input.sourceIdentity,
        pluginId: input.pluginId,
        pluginName: input.plugin.manifest.name,
        platform: input.platform,
        scope: input.scope,
        cwd: input.cwd,
        env: options.context.env,
        artifacts: historicalArtifacts,
        command: input.command,
      });
      if (preserveCodexSharedNativePayload) {
        const nativePluginRoot = await canonicalizePathThroughExistingAncestor(path.join(
          input.marketplaceRoot ?? resolveAwHome(options.context.env),
          'plugins',
          input.plugin.manifest.name,
        ));
        const privateCacheRoot = path.resolve(getCodexHome(options.context.env), 'plugins', 'cache');
        historicalComponents = historicalComponents.filter((component) => {
          if (!('path' in component)) return true;
          const componentPath = path.resolve(component.path);
          return [nativePluginRoot, privateCacheRoot].every((protectedRoot) => {
            const relative = path.relative(protectedRoot, componentPath);
            return relative === '..'
              || relative.startsWith(`..${path.sep}`)
              || path.isAbsolute(relative);
          });
        });
      }
      const sharedComponents = input.platform === 'codex'
        ? await scanCodexSharedComponents({
            sourceId: input.sourceId,
            sourceIdentity: input.sourceIdentity,
            pluginId: input.pluginId,
            pluginName: input.plugin.manifest.name,
            scope: input.scope,
            paths: resolveCodexPaths(input.cwd, input.scope, options.context.env),
            scanConfig: true,
            ignoreReadErrors: true,
          })
        : await scanClaudeSharedComponents({
            sourceId: input.sourceId,
            sourceIdentity: input.sourceIdentity,
            pluginId: input.pluginId,
            pluginName: input.plugin.manifest.name,
            scope: input.scope,
            settingsPath: resolveClaudePaths(
              input.cwd,
              input.scope,
              options.context.env,
            ).settingsPath,
          });
      const nativeRequired = input.platform === 'claude'
        || analyzeCodexSurface(input.plugin.manifest).nativeKinds.length > 0;
      const nativeDesired = nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall';
      const codexRegistration = input.platform === 'codex'
        && nativeDesired
        && input.readOnlyInspectionPlan !== true
        ? await inspectCodexPluginRegistrationLive({
            pluginId: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
            cwd: input.cwd,
            env: options.context.env,
            nativeCliRunner: options.context.nativeCliRunner,
            manager: options.context.codexManager,
            scope: codexObservationScope(
              options.context,
              input.marketplaceName ?? MARKETPLACE_NAME,
              input.scope,
            ),
            observationSession: options.context.codexObservationSession,
          })
        : undefined;
      const codexNativeExact = codexRegistration?.observation.state === 'observed'
        && codexRegistration.observation.value === 'installed'
        && (codexRegistration.observation.entry.version === undefined
          || codexRegistration.observation.entry.version === input.plugin.manifest.version);
      const materializeNativeRequired = nativeDesired && (
        input.platform === 'claude'
        || input.command === 'reinstall'
        || !codexNativeExact
      );
      const nativeCleanupCandidate = input.platform === 'claude'
        ? input.includeNativeCleanupCandidate !== false
        : input.platform === 'codex'
          && nativeRequired
          && (input.command === 'cleanup' || input.command === 'uninstall');
      const nativePlugin = (nativeDesired || nativeCleanupCandidate)
        ? [{
            kind: 'native-plugin' as const,
            identity: ownerIdentity(input.plugin.manifest.name, 'native', input.platform, input.scope),
            pluginId: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
          } satisfies OwnedComponent]
        : [];
      const marketplaceDesired = nativeRequired
        && input.command !== 'cleanup'
        && input.command !== 'uninstall';
      const marketplace = input.platform === 'codex'
        && input.scope === 'user'
        && nativeRequired
        && input.readOnlyShallowInspectionPlan !== true
        ? [createCodexMarketplaceComponent({
            pluginName: input.plugin.manifest.name,
            codexManager: options.context.codexManager,
            cwd: input.cwd,
            env: options.context.env,
            runner: options.context.nativeCliRunner,
            marketplaceName: input.marketplaceName ?? MARKETPLACE_NAME,
            marketplaceRoot: input.marketplaceRoot ?? resolveAwHome(options.context.env),
            desired: marketplaceDesired,
          })]
        : input.platform === 'claude' && marketplaceDesired
          ? [createClaudeMarketplaceComponent({
              pluginName: input.plugin.manifest.name,
              scope: input.scope,
              cwd: input.cwd,
              env: options.context.env,
              runner: options.context.nativeCliRunner,
              marketplaceName: input.marketplaceName ?? MARKETPLACE_NAME,
              marketplaceRoot: input.marketplaceRoot ?? resolveAwHome(options.context.env),
              desired: marketplaceDesired,
            })]
          : [];
      if (nativeDesired) desiredComponents.push(...nativePlugin, ...marketplace);
      const activationCleanup = input.platform === 'codex'
        && nativeRequired
        && (input.command === 'cleanup' || input.command === 'uninstall')
        ? (input.scope === 'project'
            ? [
                createCodexActivationComponent({
                  identity: ownerIdentity(input.plugin.manifest.name, internalArtifactKey('activation', 'project'), 'codex', input.scope),
                  configPath: resolveCodexPaths(input.cwd, 'project', options.context.env).configTomlPath,
                  codexPluginId: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
                  desired: true,
                }),
              ]
            : [createCodexActivationComponent({
                identity: ownerIdentity(input.plugin.manifest.name, internalArtifactKey('activation', 'user'), 'codex', input.scope),
                configPath: resolveCodexPaths(input.cwd, 'user', options.context.env).configTomlPath,
                codexPluginId: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
                desired: true,
              })])
        : [];
      const explicitActivationCleanup = input.platform === 'codex'
        ? (input.codexActivationCleanup ?? []).map((activation) =>
            createCodexActivationCleanupComponent({
              identity: ownerIdentity(
                input.plugin.manifest.name,
                internalArtifactKey('activation', activation.scope),
                'codex',
                input.scope,
              ),
              configPath: resolveCodexPaths(
                input.cwd,
                activation.scope,
                options.context.env,
              ).configTomlPath,
              codexPluginId: activation.codexPluginId,
              disposition: activation.disposition,
            }))
        : [];
      const allComponents = dedupeComponents([
        ...desiredComponents,
        ...optionalComponents,
        ...(input.platform === 'codex' ? sharedComponents : []),
        ...scannedText,
        ...scannedSkills,
        ...legacyCodexNativeSkills,
        ...currentRemovalComponents,
        ...historicalComponents,
        ...(input.platform === 'claude' ? sharedComponents : []),
        ...nativePlugin,
        ...marketplace,
        ...activationCleanup,
        ...explicitActivationCleanup,
      ]);
      bindNamespacedOwnerIdentity(allComponents, input);
      const desiredKeys = new Set(desiredComponents.map(componentIdentityKey));
      const operationActions: OperationAction[] = [];
      const preApply = input.plugin.manifest.scripts?.preApply;
      if (preApply && input.command !== 'cleanup' && input.command !== 'uninstall') {
        const script = path.resolve(input.plugin.rootDir, preApply.path.replace(/^\.\//u, ''));
        const scriptDigest = `sha256:${crypto.createHash('sha256')
          .update(await fs.readFile(script)).digest('hex')}`;
        operationActions.push({
          kind: 'runPreApply',
          pluginId: input.pluginId ?? pluginActionId(input.plugin),
          platform: input.platform,
          scope: input.scope,
          script: preApply.path,
          scriptDigest,
        });
      }
      if (nativeDesired) {
        operationActions.push({
          kind: 'ensureNativeRegistration',
          pluginId: input.pluginId ?? pluginActionId(input.plugin),
          platform: input.platform,
          scope: input.scope,
          registration: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
          marketplaceName: input.marketplaceName ?? MARKETPLACE_NAME,
          marketplaceRoot: input.marketplaceRoot ?? resolveAwHome(options.context.env),
        });
      }
      operationActions.push(...writes.flatMap((write) => [
        ...(write.action ? [write.action] : []),
        ...(write.additionalActions ?? []),
      ]));
      finalizeOwnedArtifactActions(operationActions);
      const target: DesiredTarget = {
        plugin: input.plugin,
        identity: {
          ...(input.sourceId ? {
            sourceId: input.sourceId,
            sourceIdentity: input.sourceIdentity,
            pluginId: input.pluginId,
            marketplaceName: input.marketplaceName,
            marketplaceRoot: input.marketplaceRoot,
          } : {}),
          pluginName: input.plugin.manifest.name,
          pluginVersion: input.plugin.manifest.version,
          platform: input.platform,
          scope: input.scope,
          cwd: input.cwd,
        },
        ownedComponents: allComponents,
        desiredOwnedComponents: allComponents.filter((component) =>
          desiredKeys.has(componentIdentityKey(component))),
        optionalOwnedComponents: allComponents.filter((component) =>
          optionalComponentKeys.has(componentIdentityKey(component))),
        requiresNative: nativeDesired,
        writeNativeRequired: materializeNativeRequired,
        nativeOverlayDesired: nativeDesired,
        artifacts: writes.map((write) => write.artifact),
        operationActions,
        catalog: input.catalog,
        preApplySource: input.plugin,
      };
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
