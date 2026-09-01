import crypto from 'node:crypto';
import os from 'node:os';
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
  buildCodexMarketplaceListInvocation,
  buildCodexPluginAddInvocation,
  buildCodexPluginListInvocation,
  buildCodexPluginListJsonInvocation,
  buildCodexProjectPluginListInvocations,
  buildCodexPluginRemoveInvocation,
  parseCodexPluginListJson,
  postcheckCodexProjectPluginActivation,
  runNativeCli,
  runNativeCliChecked,
  SYSTEM_CODEX_MANAGER,
  type CodexManager,
  type CodexPluginListEntry,
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
import { resolveArtifactRenderConfig, runArtifactRenderer } from '../utils/artifact-renderer.js';
import { validateArtifactPlan, type ValidatedArtifactPlanArtifact } from '../utils/artifact-plan.js';
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
import { runPostApplyScript } from '../utils/plugin-scripts.js';
import {
  atomicRemoveConfigFile,
  atomicReplaceConfigFile,
  withConfigFileMutation,
} from '../utils/plugin-config.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  getNamespacedMarketplaceName,
  projectMarketplaceManifestForPlatform,
  replayNamespacedCodexSkillOverlays,
} from '../utils/local-marketplace.js';
import { commitMarketplaceGenerationBackup } from '../utils/orphan-marketplace-cleanup.js';
import { readClaudeSettings, writeClaudeSettings, type ClaudeSettings } from '../adapters/helpers.js';
import { analyzeCodexSurface } from '../utils/codex-surface-analysis.js';
import type { CodexReconcilePlan } from '../utils/codex-reconciler.js';
import {
  inspectCodexSharedNative,
  type CodexSharedNativeInspection,
  type CodexSharedNativeManifestEvidence,
} from '../utils/codex-shared-native.js';
import { calculateCodexSharedNativePayloadDigest } from '../utils/catalog-digests.js';
import { assertCanonicalProjectManagedRoots } from '../utils/project-boundary.js';
import {
  findCodexRoleNameConflict,
  resolveCodexRoleNamespace,
} from '../utils/codex-roles.js';
import type {
  DesiredTarget,
  RebuildPostApplyInvocation,
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

export interface RebuildExecutionContext {
  env: NodeJS.ProcessEnv;
  nativeCliRunner: NativeCliRunner;
  codexManager?: CodexManager;
  reporter: CommandReporter;
  debugLogger: DebugLogger;
  expectedCatalogConfigDigest?: string;
  codexUserActivationDesired?: ReadonlySet<string>;
}

function requireCodexManager(manager: CodexManager | undefined): CodexManager {
  if (!manager) {
    throw new Error('codexManagerRequired: Codex native operation has no resolved manager.');
  }
  return manager;
}

export async function executeCodexReconcileActivations(options: {
  plans: readonly CodexReconcilePlan[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  manager?: CodexManager;
  runner: NativeCliRunner;
}): Promise<void> {
  const byScope: Record<Scope, {
    upserts: Record<string, boolean>;
    removals: Set<string>;
  }> = {
    user: { upserts: {}, removals: new Set<string>() },
    project: { upserts: {}, removals: new Set<string>() },
  };
  for (const plan of options.plans) {
    for (const scope of ['user', 'project'] as const) {
      for (const action of plan.activationActions[scope]) {
        if (action.action === 'enable' || action.action === 'disable') {
          byScope[scope].upserts[action.codexPluginId] = action.desired;
          byScope[scope].removals.delete(action.codexPluginId);
        } else if (action.action === 'remove') {
          byScope[scope].removals.add(action.codexPluginId);
        }
      }
    }
    for (const removal of plan.staleActivationRemovals) {
      if (!Object.hasOwn(byScope[removal.scope].upserts, removal.codexPluginId)) {
        byScope[removal.scope].removals.add(removal.codexPluginId);
      }
    }
  }
  for (const scope of ['user', 'project'] as const) {
    const enables = Object.fromEntries(Object.entries(byScope[scope].upserts)
      .filter(([, desired]) => desired));
    if (Object.keys(enables).length === 0) continue;
    const configPath = resolveCodexPaths(options.cwd, scope, options.env).configTomlPath;
    await applyCodexConfigTransactionFile(configPath, { upsertPluginActivations: enables });
    const enabledConfig = await readCodexConfigFile(configPath);
    for (const pluginId of Object.keys(enables)) {
      if (enabledConfig.snapshot.plugins[pluginId]?.enabled !== true) {
        throw new Error(
          `codexActivationPostcheckFailed: ${pluginId} ${scope} activation was not enabled before obsolete activation removal.`,
        );
      }
    }
  }
  for (const scope of ['user', 'project'] as const) {
    const transaction = byScope[scope];
    const disables = Object.fromEntries(Object.entries(transaction.upserts)
      .filter(([, desired]) => !desired));
    if (Object.keys(disables).length === 0 && transaction.removals.size === 0) continue;
    await applyCodexConfigTransactionFile(
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
  }

  const [userConfig, projectConfig] = await Promise.all([
    readCodexConfigFile(resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath),
    readCodexConfigFile(resolveCodexPaths(options.cwd, 'project', options.env).configTomlPath),
  ]);
  for (const plan of options.plans) {
    for (const scope of ['user', 'project'] as const) {
      const snapshot = scope === 'user' ? userConfig.snapshot : projectConfig.snapshot;
      for (const action of plan.activationActions[scope]) {
        const actual = snapshot.plugins[action.codexPluginId]?.enabled;
        const expected = action.desired
          ? true
          : action.action === 'disable' || actual === false ? false : undefined;
        if (actual !== expected) {
          throw new Error(
            `codexActivationPostcheckFailed: ${action.codexPluginId} ${scope} activation is ${String(actual)}; expected ${String(expected)}.`,
          );
        }
      }
      for (const removal of plan.staleActivationRemovals.filter((entry) => entry.scope === scope)) {
        if (snapshot.plugins[removal.codexPluginId]?.enabled !== undefined) {
          throw new Error(
            `codexActivationPostcheckFailed: stale ${removal.codexPluginId} ${scope} activation remains.`,
          );
        }
      }
    }
  }

  const observedProjectChecks = options.plans.flatMap((plan) =>
    plan.postcheck.support === 'observed'
      ? plan.postcheck.plugins.filter((plugin) => plugin.neutralCwdRequired)
      : []);
  if (observedProjectChecks.length === 0) return;
  const manager = requireCodexManager(options.manager);
  const neutralCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-postcheck-'));
  try {
    const invocations = buildCodexProjectPluginListInvocations(manager, {
      exactCwd: options.cwd,
      neutralCwd,
      env: options.env,
    });
    const [exactResult, neutralResult] = await Promise.all([
      runNativeCliChecked(invocations.exact, options.runner),
      runNativeCliChecked(invocations.neutral, options.runner),
    ]);
    for (const plugin of observedProjectChecks) {
      postcheckCodexProjectPluginActivation({
        pluginId: plugin.codexPluginId,
        userEnabled: plugin.expectedUserEnabled,
        projectEnabled: plugin.expectedProjectEnabled,
        exactResult,
        neutralResult,
      });
    }
  } finally {
    await fs.remove(neutralCwd);
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
      pending.push(skillRoot);
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
}> {
  const declarations = (options.plugin.manifest.artifacts?.targets ?? []).filter(
    (target) => target.platform === options.platform && target.scopes.includes(options.scope),
  );
  if (declarations.length === 0) return { artifacts: [], sourceDirs: () => [] };
  const render = await runArtifactRenderer({
    event: options.event,
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.env,
    previousArtifacts: [...options.previousArtifacts],
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  const config = await resolveArtifactRenderConfig({
    sourceId: options.plugin.sourceId,
    sourceIdentity: options.plugin.sourceIdentity,
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
    renderConfig: config,
    rendererDigest: render.target.rendererDigest!,
    manifestDigest: render.target.manifestDigest!,
  }).artifacts;
  return {
    artifacts,
    sourceDirs: (artifact) => render.context.artifactSources.find((entry) =>
      entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [],
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
  if (options.scope === 'user') {
    writes.push(...await buildBundledCodexSkillWrites({
      plugin: options.plugin,
      env: options.env,
      marketplaceRoot: options.marketplaceRoot,
      shallow: options.shallow,
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
    if (target.target === 'codex.skill' && target.skillKey) {
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

function isAbsentCodexResiduePath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

async function lstatCodexResidueIfPresent(filePath: string) {
  return fs.lstat(filePath).catch((error) => {
    if (isAbsentCodexResiduePath(error)) return null;
    throw error;
  });
}

async function readdirCodexResidueIfPresent(directory: string) {
  const stats = await lstatCodexResidueIfPresent(directory);
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Codex residue root is not a canonical directory: ${directory}`);
  }
  return fs.readdir(directory, { withFileTypes: true });
}

export async function inspectCodexNativeResidue(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceName?: string;
  marketplaceRoot?: string;
}): Promise<{
  state: 'present' | 'absent' | 'foreign';
  labels: string[];
  versions: string[];
  installedVersions: string[];
  cacheVersions: string[];
  enabled: boolean;
}> {
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const marketplaceRoot = options.marketplaceRoot ?? resolveAwHome(options.env);
  const pluginId = `${options.pluginName}@${marketplaceName}`;
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const marketplace = config.snapshot.marketplaces[marketplaceName];
  const canonicalMarketplace = marketplace?.sourceType === 'local'
    && !marketplace.sourcePointsToManifest
    && path.normalize(marketplace.source ?? '') === path.normalize(marketplaceRoot);
  const cacheRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    'cache',
    marketplaceName,
    options.pluginName,
  );
  const installedRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    pluginId,
  );
  const installedManifest = path.join(
    installedRoot,
    'manifest.json',
  );
  const labels: string[] = [];
  const foreignLabels: string[] = [];
  const versions = new Set<string>();
  const installedVersions = new Set<string>();
  const cacheVersions = new Set<string>();
  const configEntry = config.snapshot.plugins[pluginId];
  if (configEntry) {
    (canonicalMarketplace ? labels : foreignLabels).push(`${configPath}#plugins.${pluginId}`);
  }
  const inspectManifest = async (
    manifestPath: string,
    kind: 'installed' | 'cache',
    directoryVersion?: string,
  ): Promise<void> => {
    const stats = await lstatCodexResidueIfPresent(manifestPath);
    if (!stats) return;
    if (!stats.isFile() || stats.isSymbolicLink()) {
      foreignLabels.push(manifestPath);
      return;
    }
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown> | null;
    const identity = manifest?.id ?? manifest?.name;
    const version = typeof manifest?.version === 'string' ? manifest.version : null;
    if (
      !canonicalMarketplace
      || (identity !== options.pluginName && identity !== pluginId)
      || !version
      || (directoryVersion !== undefined && version !== directoryVersion)
    ) {
      foreignLabels.push(manifestPath);
      return;
    }
    labels.push(manifestPath);
    versions.add(version);
    (kind === 'installed' ? installedVersions : cacheVersions).add(version);
  };
  for (const entry of await readdirCodexResidueIfPresent(cacheRoot)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      foreignLabels.push(path.join(cacheRoot, entry.name));
      continue;
    }
    const versionRoot = path.join(cacheRoot, entry.name);
    const candidates = [
      path.join(versionRoot, 'plugin.json'),
      path.join(versionRoot, '.codex-plugin', 'plugin.json'),
    ];
    const existing = [];
    for (const candidate of candidates) {
      if (await lstatCodexResidueIfPresent(candidate)) existing.push(candidate);
    }
    if (existing.length === 0) foreignLabels.push(versionRoot);
    for (const candidate of existing) await inspectManifest(candidate, 'cache', entry.name);
  }
  const installedStats = await lstatCodexResidueIfPresent(installedRoot);
  if (installedStats && (!installedStats.isDirectory() || installedStats.isSymbolicLink())) {
    foreignLabels.push(installedRoot);
  } else if (installedStats) {
    await inspectManifest(installedManifest, 'installed');
  }
  return foreignLabels.length > 0
    ? {
        state: 'foreign', labels: [...labels, ...foreignLabels], versions: [...versions],
        installedVersions: [...installedVersions], cacheVersions: [...cacheVersions],
        enabled: configEntry?.enabled === true,
      }
    : labels.length > 0
      ? {
          state: 'present', labels, versions: [...versions],
          installedVersions: [...installedVersions], cacheVersions: [...cacheVersions],
          enabled: configEntry?.enabled === true,
        }
      : {
          state: 'absent', labels: [], versions: [],
          installedVersions: [], cacheVersions: [], enabled: false,
        };
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function codexPayloadPathSafe(payloadRoot: string): Promise<boolean> {
  const rootStats = await lstatCodexResidueIfPresent(payloadRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return false;
  const pending = [payloadRoot];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = path.resolve(path.dirname(entryPath), await fs.readlink(entryPath));
        if (!isPathWithin(payloadRoot, target)) return false;
      } else if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (!entry.isFile()) {
        return false;
      }
    }
  }
  return true;
}

export interface CodexSharedNativeLiveInspection {
  sharedNative: CodexSharedNativeInspection;
  actualPayloadDigest?: string;
  payloadPath?: string;
  staleCacheObserved?: true;
  activationObservations: {
    user: boolean;
    project: boolean;
  };
  activations: {
    user?: boolean;
    project?: boolean;
  };
}

export interface CodexPluginRegistrationLiveInspection {
  entries: CodexPluginListEntry[];
  readable?: boolean;
  observations: {
    user: boolean;
    project: boolean;
  };
  activations: {
    user?: boolean;
    project?: boolean;
  };
}

export async function inspectCodexPluginRegistrationLive(options: {
  pluginId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner?: NativeCliRunner;
  manager?: CodexManager;
}): Promise<CodexPluginRegistrationLiveInspection> {
  if (!options.nativeCliRunner) {
    return {
      entries: [],
      readable: false,
      observations: { user: false, project: false },
      activations: {},
    };
  }
  const manager = options.manager ?? SYSTEM_CODEX_MANAGER;
  const readEntries = async (cwd: string): Promise<CodexPluginListEntry[] | undefined> => {
    try {
      const result = await runNativeCli(
        buildCodexPluginListJsonInvocation(manager, cwd, options.env),
        options.nativeCliRunner,
      );
      if (result.exitCode !== 0) return undefined;
      return parseCodexPluginListJson(result.stdout);
    } catch {
      return undefined;
    }
  };
  const [exactEntries, neutralEntries] = await Promise.all([
    readEntries(options.cwd),
    readEntries(os.tmpdir()),
  ]);
  const entries = neutralEntries ?? exactEntries;
  const enabled = (values: readonly CodexPluginListEntry[] | undefined): boolean | undefined =>
    values?.find((entry) => entry.pluginId === options.pluginId)?.enabled;
  return {
    entries: entries ?? [],
    readable: entries !== undefined,
    observations: {
      user: neutralEntries !== undefined,
      project: exactEntries !== undefined,
    },
    activations: {
      user: enabled(neutralEntries),
      project: enabled(exactEntries),
    },
  };
}

/**
 * Read-only filesystem projection for the payload-aware shared-native classifier.
 * It does not invoke Codex or create native/config state.
 */
export async function inspectCodexSharedNativeLive(options: {
  pluginName: string;
  desiredVersion: string;
  expectedPayloadDigest?: string;
  inspectionMode?: 'shallow' | 'payload';
  cwd: string;
  env: NodeJS.ProcessEnv;
  managedByCurrentIntent: boolean;
  marketplaceName?: string;
  marketplaceRoot?: string;
  nativeCliRunner?: NativeCliRunner;
  manager?: CodexManager;
  pluginRegistration?: CodexPluginRegistrationLiveInspection;
}): Promise<CodexSharedNativeLiveInspection> {
  const inspectionMode = options.inspectionMode ?? 'payload';
  if (inspectionMode === 'payload' && options.expectedPayloadDigest === undefined) {
    throw new Error('Payload inspection requires the expected shared native digest.');
  }
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const marketplaceRoot = options.marketplaceRoot ?? resolveAwHome(options.env);
  const pluginId = `${options.pluginName}@${marketplaceName}`;
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const cacheRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    'cache',
    marketplaceName,
    options.pluginName,
  );
  const installedManifestPath = path.join(
    getCodexHome(options.env),
    'plugins',
    pluginId,
    'manifest.json',
  );
  const cacheRootStats = await lstatCodexResidueIfPresent(cacheRoot);
  let unsafeCachePath = Boolean(cacheRootStats
    && (!cacheRootStats.isDirectory() || cacheRootStats.isSymbolicLink()));
  const candidates: Array<{
    version?: string;
    manifest: CodexSharedNativeManifestEvidence;
    payloadPath: string;
  }> = [];
  if (cacheRootStats?.isDirectory() && !cacheRootStats.isSymbolicLink()) {
    for (const entry of await fs.readdir(cacheRoot, { withFileTypes: true })) {
      const payloadPath = path.join(cacheRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        unsafeCachePath = true;
        continue;
      }
      const manifestPaths = [
        path.join(payloadPath, 'plugin.json'),
        path.join(payloadPath, '.codex-plugin', 'plugin.json'),
      ];
      const existingManifestPaths: string[] = [];
      for (const manifestPath of manifestPaths) {
        const stats = await lstatCodexResidueIfPresent(manifestPath);
        if (stats) existingManifestPaths.push(manifestPath);
      }
      if (existingManifestPaths.length !== 1) {
        candidates.push({
          version: entry.name,
          manifest: existingManifestPaths.length === 0 ? { state: 'absent' } : { state: 'unreadable' },
          payloadPath,
        });
        continue;
      }
      const manifestPath = existingManifestPaths[0]!;
      const manifestStats = await lstatCodexResidueIfPresent(manifestPath);
      if (!manifestStats?.isFile() || manifestStats.isSymbolicLink()) {
        candidates.push({ version: entry.name, manifest: { state: 'unreadable' }, payloadPath });
        continue;
      }
      let manifest: Record<string, unknown>;
      try {
        const value = await fs.readJson(manifestPath) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid manifest');
        manifest = value as Record<string, unknown>;
      } catch {
        candidates.push({ version: entry.name, manifest: { state: 'unreadable' }, payloadPath });
        continue;
      }
      const pathSafe = inspectionMode === 'shallow'
        ? true
        : await codexPayloadPathSafe(payloadPath);
      let payloadDigest: string | undefined;
      if (pathSafe && inspectionMode === 'payload') {
        try {
          payloadDigest = await calculateCodexSharedNativePayloadDigest(payloadPath);
        } catch {
          candidates.push({ version: entry.name, manifest: { state: 'unreadable' }, payloadPath });
          continue;
        }
      }
      candidates.push({
        version: typeof manifest.version === 'string' ? manifest.version : entry.name,
        payloadPath,
        manifest: {
          state: 'present',
          identity: typeof manifest.id === 'string'
            ? manifest.id
            : typeof manifest.name === 'string' ? manifest.name : '',
          version: typeof manifest.version === 'string' ? manifest.version : '',
          payloadDigest,
          payloadPath,
          pathSafe,
        },
      });
    }
  }
  let installedVersion: string | undefined;
  const installedStats = await lstatCodexResidueIfPresent(installedManifestPath);
  if (installedStats?.isFile() && !installedStats.isSymbolicLink()) {
    try {
      const installed = await fs.readJson(installedManifestPath) as Record<string, unknown>;
      if (typeof installed.version === 'string') installedVersion = installed.version;
    } catch {
      installedVersion = undefined;
    }
  }
  const selected = candidates.find((candidate) => candidate.version === installedVersion)
    ?? candidates.find((candidate) => candidate.version === options.desiredVersion)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  const pluginList = options.pluginRegistration ?? await inspectCodexPluginRegistrationLive({
    pluginId,
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
    manager: options.manager,
  });
  const manifest: CodexSharedNativeManifestEvidence = unsafeCachePath
    ? {
        state: 'present',
        identity: pluginId,
        version: options.desiredVersion,
        ...(options.expectedPayloadDigest ? { payloadDigest: options.expectedPayloadDigest } : {}),
        payloadPath: cacheRoot,
        pathSafe: false,
      }
    : selected?.manifest ?? { state: 'absent' };
  const sharedNative = inspectCodexSharedNative({
    pluginName: options.pluginName,
    pluginId,
    marketplaceName,
    canonicalMarketplaceRoot: marketplaceRoot,
    desiredVersion: options.desiredVersion,
    expectedPayloadDigest: options.expectedPayloadDigest,
    marketplaceRegistration: config.snapshot.marketplaces[marketplaceName],
    marketplacePathSafe: true,
    pluginListEntries: pluginList.readable === false ? null : pluginList.entries,
    manifest,
    managedByCurrentIntent: options.managedByCurrentIntent && manifest.state === 'present',
  });
  return {
    sharedNative,
    activationObservations: pluginList.observations,
    activations: pluginList.activations,
    ...(sharedNative.state === 'missing' && sharedNative.staleCacheObserved
      ? { staleCacheObserved: true as const }
      : {}),
    ...(manifest.state === 'present' ? {
      ...(manifest.payloadDigest ? { actualPayloadDigest: manifest.payloadDigest } : {}),
      payloadPath: manifest.payloadPath,
    } : {}),
  };
}

export async function codexNativeRemovalRequired(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceName?: string;
  marketplaceRoot?: string;
}): Promise<boolean> {
  const residue = await inspectCodexNativeResidue(options);
  if (residue.state === 'present') return true;
  if (residue.state === 'foreign') return false;
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const marketplaceRoot = options.marketplaceRoot ?? resolveAwHome(options.env);
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const marketplace = config.snapshot.marketplaces[marketplaceName];
  const canonical = marketplace?.sourceType === 'local'
    && !marketplace.sourcePointsToManifest
    && path.normalize(marketplace.source ?? '') === path.normalize(marketplaceRoot);
  if (!canonical) return false;
  return (await discoverCodexNativeResidueNames(options)).length === 0;
}

export async function discoverCodexNativeResidueNames(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceName?: string;
  marketplaceRoot?: string;
}): Promise<string[]> {
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const marketplaceRoot = options.marketplaceRoot ?? resolveAwHome(options.env);
  const names = new Set<string>();
  const config = await readCodexConfigFile(
    resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath,
  );
  const marketplace = config.snapshot.marketplaces[marketplaceName];
  const canonicalMarketplace = marketplace?.sourceType === 'local'
    && !marketplace.sourcePointsToManifest
    && path.normalize(marketplace.source ?? '') === path.normalize(marketplaceRoot);
  const probeFailure = (location: string, cause: unknown, pluginName?: string): never => {
    if (cause instanceof CodexNativeResidueProbeError) throw cause;
    throw new CodexNativeResidueProbeError(location, cause, pluginName);
  };
  for (const pluginId of canonicalMarketplace ? Object.keys(config.snapshot.plugins) : []) {
    const suffix = `@${marketplaceName}`;
    const match = pluginId.endsWith(suffix)
      ? /^([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(pluginId.slice(0, -suffix.length))
      : null;
    if (match) names.add(match[1]!);
  }
  const cacheRoot = path.join(getCodexHome(options.env), 'plugins', 'cache', marketplaceName);
  const cacheEntries = await readdirCodexResidueIfPresent(cacheRoot).catch((error) =>
    probeFailure(cacheRoot, error));
  for (const entry of cacheEntries) {
    if (entry.isFile()) continue;
    const entryPath = path.join(cacheRoot, entry.name);
    const pluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.name)
      ? entry.name
      : probeFailure(
          entryPath,
          new Error('Codex cache residue has an invalid plugin identity.'),
        );
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      probeFailure(
        entryPath,
        new Error('Codex cache residue is not a canonical plugin directory.'),
        pluginName,
      );
    }
    let versionEntries;
    try {
      versionEntries = await fs.readdir(entryPath, { withFileTypes: true });
    } catch (error) {
      throw new CodexNativeResidueProbeError(entryPath, error, pluginName);
    }
    if (versionEntries.length === 0) {
      if (names.has(pluginName)) {
        probeFailure(
          entryPath,
          new Error('Codex cache residue manifest is missing.'),
          pluginName,
        );
      }
      continue;
    }
    let residue: Awaited<ReturnType<typeof inspectCodexNativeResidue>>;
    try {
      residue = await inspectCodexNativeResidue({ ...options, pluginName: entry.name });
    } catch (error) {
      throw new CodexNativeResidueProbeError(entryPath, error, pluginName);
    }
    if (residue.state !== 'present') {
      probeFailure(
        entryPath,
        new Error('Codex cache residue has foreign or incomplete manifest evidence.'),
        pluginName,
      );
    }
    names.add(pluginName);
  }
  const pluginsRoot = path.join(getCodexHome(options.env), 'plugins');
  const pluginEntries = await readdirCodexResidueIfPresent(pluginsRoot).catch((error) =>
    probeFailure(pluginsRoot, error));
  for (const entry of pluginEntries) {
    const suffix = `@${marketplaceName}`;
    const match = entry.name.endsWith(suffix)
      ? /^([a-z0-9]+(?:-[a-z0-9]+)*)$/u.exec(entry.name.slice(0, -suffix.length))
      : null;
    if (!match) continue;
    const installedRoot = path.join(pluginsRoot, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      probeFailure(
        installedRoot,
        new Error('Codex installed residue is not a canonical plugin directory.'),
        match[1],
      );
    }
    const installedStats = await lstatCodexResidueIfPresent(installedRoot);
    if (!installedStats || !installedStats.isDirectory() || installedStats.isSymbolicLink()) {
      probeFailure(
        installedRoot,
        new Error('Codex installed residue is not a canonical plugin directory.'),
        match[1],
      );
    }
    const manifestPath = path.join(pluginsRoot, entry.name, 'manifest.json');
    const stats = await lstatCodexResidueIfPresent(manifestPath);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      probeFailure(
        manifestPath,
        new Error('Codex installed residue manifest is missing or nonregular.'),
        match[1],
      );
    }
    let rawManifest: unknown;
    try {
      rawManifest = await fs.readJson(manifestPath);
    } catch (error) {
      throw new CodexNativeResidueProbeError(manifestPath, error, match[1]);
    }
    if (!rawManifest || typeof rawManifest !== 'object' || Array.isArray(rawManifest)) {
      probeFailure(
        manifestPath,
        new Error('Codex installed residue manifest must be an object.'),
        match[1],
      );
    }
    const manifest = rawManifest as Record<string, unknown>;
    const identity = manifest.id ?? manifest.name;
    if (!canonicalMarketplace
      || (identity !== match[1] && identity !== entry.name)
      || typeof manifest.version !== 'string'
      || manifest.version.trim() === '') {
      probeFailure(
        manifestPath,
        new Error('Codex installed residue manifest has foreign identity or version.'),
        match[1],
      );
    }
    names.add(match[1]!);
  }
  return [...names];
}

export class CodexNativeResidueProbeError extends Error {
  readonly code = 'codexNativeResidueProbeFailed';
  readonly location: string;
  readonly pluginName?: string;

  constructor(location: string, cause: unknown, pluginName?: string) {
    super(`codexNativeResidueProbeFailed: cannot classify Codex native residue at ${location}.`, {
      cause,
    });
    this.name = 'CodexNativeResidueProbeError';
    this.location = location;
    this.pluginName = pluginName;
  }
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

async function assertCodexNativeInstallState(options: {
  pluginName: string;
  pluginVersion: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  marketplaceRoot: string;
  marketplaceName?: string;
  skillsRelativeRoot: string | null;
  requiredSkillKeys: readonly string[];
}): Promise<void> {
  const marketplaceName = options.marketplaceName ?? MARKETPLACE_NAME;
  const pluginId = `${options.pluginName}@${marketplaceName}`;
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const marketplace = config.snapshot.marketplaces[marketplaceName];
  if (
    marketplace?.sourceType !== 'local'
    || marketplace.sourcePointsToManifest
    || path.normalize(marketplace.source ?? '') !== path.normalize(options.marketplaceRoot)
  ) {
    throw new Error(`Codex marketplace aw 未指向当前 AW_HOME：${options.marketplaceRoot}`);
  }
  if (config.snapshot.plugins[pluginId]?.enabled !== true) {
    throw new Error(`Codex enabled config 缺少 ${pluginId}。`);
  }
  const cacheRoot = path.join(
    getCodexHome(options.env),
    'plugins',
    'cache',
    marketplaceName,
    options.pluginName,
    options.pluginVersion,
  );
  const candidates = [
    path.join(cacheRoot, 'plugin.json'),
    path.join(cacheRoot, '.codex-plugin', 'plugin.json'),
  ];
  const expectedRoot = path.join(
    options.marketplaceRoot,
    'plugins',
    options.pluginName,
  );
  const assertExpectedPayload = async (): Promise<void> => {
    const collectFiles = async (root: string): Promise<string[]> => {
      const output: string[] = [];
      const pending = [''];
      while (pending.length > 0) {
        const relativeRoot = pending.pop()!;
        for (const entry of await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true })) {
          const relativePath = path.join(relativeRoot, entry.name);
          if (entry.isSymbolicLink()) {
            throw new Error(`Codex native payload 不能包含符号链接：${path.join(root, relativePath)}`);
          }
          if (entry.isDirectory()) pending.push(relativePath);
          else if (entry.isFile()) output.push(relativePath);
          else throw new Error(`Codex native payload 包含不支持的节点：${path.join(root, relativePath)}`);
        }
      }
      return output;
    };
    const manifestPaths = new Set(['plugin.json', path.join('.codex-plugin', 'plugin.json')]);
    const allowedMetadata = new Set(['metadata.json', '.metadata.json']);
    const [expectedFiles, actualFiles] = await Promise.all([
      collectFiles(expectedRoot),
      collectFiles(cacheRoot),
    ]);
    const expectedSet = new Set(expectedFiles);
    for (const relativePath of expectedFiles) {
      if (manifestPaths.has(relativePath)) continue;
      const expectedPath = path.join(expectedRoot, relativePath);
      const actualPath = path.join(cacheRoot, relativePath);
      const actualStats = await fs.lstat(actualPath).catch(() => null);
      if (!actualStats?.isFile() || actualStats.isSymbolicLink()) {
        throw new Error(`Codex native cache 缺少 expected payload：${actualPath}`);
      }
      const [expectedContent, actualContent] = await Promise.all([
        fs.readFile(expectedPath),
        fs.readFile(actualPath),
      ]);
      if (!expectedContent.equals(actualContent)) {
        throw new Error(`Codex native cache expected payload digest 不匹配：${actualPath}`);
      }
    }
    for (const relativePath of actualFiles) {
      if (
        expectedSet.has(relativePath)
        || manifestPaths.has(relativePath)
        || allowedMetadata.has(relativePath)
      ) continue;
      throw new Error(`Codex native cache 包含 unexpected loadable payload：${path.join(cacheRoot, relativePath)}`);
    }
  };
  let matchedManifest = false;
  for (const candidate of candidates) {
    if (!await fs.pathExists(candidate)) continue;
    const manifest = await fs.readJson(candidate).catch(() => null) as Record<string, unknown> | null;
    if (!manifest) {
      throw new Error(`Codex native cache manifest 无法解析：${candidate}`);
    }
    const identity = manifest.id ?? manifest.name;
    const matches = (
      (identity === options.pluginName || identity === pluginId)
      && manifest.version === options.pluginVersion
      && (
        options.skillsRelativeRoot === null
          ? typeof manifest.skills !== 'string'
          : typeof manifest.skills === 'string'
            && path.posix.normalize(manifest.skills.replace(/^\.\//u, '')) === options.skillsRelativeRoot
      )
    );
    if (!matches) {
      throw new Error(`Codex native cache manifest 不匹配：${candidate}`);
    }
    matchedManifest = true;
  }
  if (!matchedManifest) {
    throw new Error(
      `Codex native cache 缺少匹配 ${pluginId}@${options.pluginVersion} 的 manifest：${cacheRoot}`,
    );
  }
  for (const skillKey of options.requiredSkillKeys) {
    const skillPath = path.join(
      cacheRoot,
      ...options.skillsRelativeRoot!.split('/'),
      skillKey,
      'SKILL.md',
    );
    if (!await fs.pathExists(skillPath)) {
      throw new Error(`Codex native cache 缺少 required Skill：${skillPath}`);
    }
  }
  await assertExpectedPayload();
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

async function mirrorCatalog(
  catalog: CatalogResolution,
  env: NodeJS.ProcessEnv,
  target?: Pick<RebuildTargetIdentity, 'sourceId' | 'sourceIdentity' | 'marketplaceName' | 'marketplaceRoot'>,
): Promise<{
  rootDir: string;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}> {
  if (!target?.sourceId || !target.marketplaceRoot) {
    const rootDir = resolveAwHome(env);
    await fs.ensureDir(rootDir);
    await fs.copy(catalog.rootDir, rootDir, { overwrite: true });
    return { rootDir, commit: async () => undefined, rollback: async () => undefined };
  }
  const awHome = path.resolve(resolveAwHome(env));
  const awHomeStats = await fs.lstat(awHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!awHomeStats?.isDirectory() || awHomeStats.isSymbolicLink()) {
    throw new Error(`marketplaceRootInvalid: AW_HOME must be a regular directory: ${awHome}`);
  }
  const canonicalAwHome = await fs.realpath(awHome);
  const expectedParent = path.join(canonicalAwHome, 'marketplaces');
  const destination = target.marketplaceRoot;
  const parent = path.dirname(destination);
  if (path.resolve(parent) !== path.join(awHome, 'marketplaces')) {
    throw new Error(`marketplaceRootInvalid: marketplace parent is not under canonical AW_HOME: ${parent}`);
  }
  let parentStats = await fs.lstat(parent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!parentStats) {
    await fs.mkdir(parent);
    parentStats = await fs.lstat(parent);
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error(`marketplaceRootInvalid: marketplace parent must be a regular directory: ${parent}`);
  }
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== expectedParent) {
    throw new Error(`marketplaceRootInvalid: marketplace parent is outside canonical AW_HOME: ${parent}`);
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
}): RebuildTargetDriver {
  const runner = options.context.nativeCliRunner;
  const currentCodexManager = (): CodexManager | undefined => options.context.codexManager;
  const mirrorTransactions = new WeakMap<DesiredTarget, Awaited<ReturnType<typeof mirrorCatalog>>>();
  const findTarget = (component: OwnedComponent): DesiredTarget => {
    const target = options.targets.find((entry) =>
      entry.identity.pluginName === component.identity.plugin
      && entry.identity.sourceId === component.identity.sourceId
      && entry.identity.platform === component.identity.platform
      && entry.identity.scope === component.identity.scope);
    if (!target) throw new Error('Ownership executor cannot resolve its desired target.');
    return target;
  };
  const inspectCodexMarketplace = async (
    component: Extract<OwnedComponent, { kind: 'shared-config' | 'managed-block' }>,
  ): Promise<'present' | 'absent' | 'foreign'> => {
    if (component.locator.kind !== 'codex-marketplace') throw new Error('Invalid Codex marketplace locator.');
    const target = findTarget(component);
    const configPath = resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath;
    const marketplace = (await readCodexConfigFile(configPath))
      .snapshot.marketplaces[component.locator.marketplaceName];
    const canonical = !marketplace
      ? 'absent' as const
      : marketplace.sourceType === 'local'
        && !marketplace.sourcePointsToManifest
        && path.normalize(marketplace.source ?? '') === path.normalize(component.locator.marketplaceRoot)
        ? 'present' as const
        : 'foreign' as const;
    const plugin = await inspectCodexNativeResidue({
      pluginName: component.identity.plugin,
      cwd: target.identity.cwd,
      env: options.context.env,
      marketplaceName: component.locator.marketplaceName,
      marketplaceRoot: component.locator.marketplaceRoot,
    });
    if (plugin.state === 'foreign') return 'foreign';
    if (component.locator.desired) {
      return canonical === 'present' && plugin.state === 'present' && plugin.enabled
        ? 'present'
        : 'absent';
    }
    if (canonical !== 'present') return canonical;
    const remaining = await discoverCodexNativeResidueNames({
      cwd: target.identity.cwd,
      env: options.context.env,
      marketplaceName: component.locator.marketplaceName,
      marketplaceRoot: component.locator.marketplaceRoot,
    });
    return remaining.some((name) => name !== component.identity.plugin) ? 'absent' : 'present';
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
    },
    commitMaterialize: async (target) => {
      const transaction = mirrorTransactions.get(target);
      if (!transaction) return;
      await transaction.commit();
      mirrorTransactions.delete(target);
    },
    rollbackMaterialize: async (target) => {
      const transaction = mirrorTransactions.get(target);
      if (!transaction) return;
      await transaction.rollback();
      mirrorTransactions.delete(target);
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
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName: target.identity.marketplaceName,
          marketplaceRoot: target.identity.marketplaceRoot,
        });
        return residue.state;
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
        const residue = await inspectCodexNativeResidue({
          pluginName: target.identity.pluginName,
          cwd: target.identity.cwd,
          env: options.context.env,
          marketplaceName: target.identity.marketplaceName,
          marketplaceRoot: target.identity.marketplaceRoot,
        });
        if (residue.state !== 'present') return residue.state;
        const codexManager = currentCodexManager();
        if (target.identity.scope !== 'project' || !codexManager) return 'present';
        const userConfig = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
        );
        const projectConfig = await readCodexConfigFile(
          resolveCodexPaths(target.identity.cwd, 'project', options.context.env).configTomlPath,
        );
        const pluginId = `${target.identity.pluginName}@${target.identity.marketplaceName ?? MARKETPLACE_NAME}`;
        const neutralCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-postcheck-'));
        try {
          const invocations = buildCodexProjectPluginListInvocations(codexManager, {
            exactCwd: target.identity.cwd,
            neutralCwd,
            env: options.context.env,
          });
          const [exactResult, neutralResult] = await Promise.all([
            runNativeCliChecked(invocations.exact, runner),
            runNativeCliChecked(invocations.neutral, runner),
          ]);
          postcheckCodexProjectPluginActivation({
            pluginId,
            userEnabled: userConfig.snapshot.plugins[pluginId]?.enabled === true,
            projectEnabled: projectConfig.snapshot.plugins[pluginId]?.enabled === true,
            exactResult,
            neutralResult,
          });
        } finally {
          await fs.remove(neutralCwd);
        }
        return 'present';
      }
      return 'absent';
    },
    removeNative: async (component) => {
      const target = findTarget(component);
      if (!target) throw new Error('Native ownership removal cannot resolve its desired target.');
      if (target.identity.platform === 'codex') {
        const registration = await inspectCodexPluginRegistrationLive({
          pluginId: component.pluginId,
          cwd: target.identity.cwd,
          env: options.context.env,
          nativeCliRunner: runner,
          manager: currentCodexManager(),
        });
        const removalRequired = registration.entries.some((entry) =>
          entry.pluginId === component.pluginId);
        if (!removalRequired) return;
        try {
          await runNativeCliChecked(
            buildCodexPluginRemoveInvocation(
              requireCodexManager(currentCodexManager()),
              component.pluginId,
              target.identity.cwd,
              options.context.env,
            ),
            runner,
          );
        } catch {
          throw new Error(`codexNativeRemoveFailed: ${CODEX_REMOVE_RECOVERY}`);
        }
        const after = await inspectCodexPluginRegistrationLive({
          pluginId: component.pluginId,
          cwd: target.identity.cwd,
          env: options.context.env,
          nativeCliRunner: runner,
          manager: currentCodexManager(),
        });
        if (after.entries.some((entry) => entry.pluginId === component.pluginId)) {
          throw new Error(`codexNativeRemoveIncomplete: ${CODEX_REMOVE_RECOVERY}`);
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
      const catalog = target.catalog;
      const marketplaceName = target.identity.marketplaceName ?? MARKETPLACE_NAME;
      const expectedMarketplaceRoot = target.identity.marketplaceRoot ?? resolveAwHome(options.context.env);
      const writeGeneration = async (): Promise<void> => {
        if (mirrorTransactions.has(target)) {
          throw new Error('Marketplace mirror transaction is already active for this target.');
        }
        {
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
          const mirrored = await mirrorCatalog(catalog, options.context.env, target.identity);
          mirrorTransactions.set(target, mirrored);
          const marketplaceRoot = mirrored.rootDir;
          const pluginId = `${target.identity.pluginName}@${marketplaceName}`;
          if (target.identity.platform === 'codex') {
          const registration = await inspectCodexPluginRegistrationLive({
            pluginId,
            cwd: target.identity.cwd,
            env: options.context.env,
            nativeCliRunner: runner,
            manager: currentCodexManager(),
          });
          const removalRequired = registration.entries.some((entry) =>
            entry.pluginId === pluginId);
          if (removalRequired) {
            await runNativeCliChecked(
              buildCodexPluginRemoveInvocation(
                requireCodexManager(currentCodexManager()),
                pluginId,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            );
          }
          const nativePluginRoot = await canonicalizePathThroughExistingAncestor(path.join(
            marketplaceRoot,
            'plugins',
            target.identity.pluginName,
          ));
          const desiredSkillPaths = new Set((target.desiredOwnedComponents ?? [])
            .filter((component) => component.kind === 'skill-directory')
            .map((component) => path.resolve(component.path)));
          const enabledSkillPaths = new Set(target.artifacts
            .filter((artifact) => artifact.kind === 'skill' && artifact.state !== 'disabled')
            .map((artifact) => path.resolve(artifact.path)));
          const requiredSkillWrites = (target.operationActions ?? []).filter((action): action is Extract<
            OperationAction,
            { kind: 'writeOwnedArtifact' }
          > => action.kind === 'writeOwnedArtifact'
            && action.artifactKind === 'skill-directory'
            && desiredSkillPaths.has(path.resolve(action.path))
            && enabledSkillPaths.has(path.resolve(action.path))
            && target.identity.scope === 'user'
            && !path.relative(nativePluginRoot, action.path).startsWith('..'));
          for (const action of requiredSkillWrites) {
            await applyPlannedOperationAction(action);
          }
          const skillsRelativeRoot = await ensureCodexActiveSkillsManifest({
            plugin: target.plugin,
            marketplaceRoot,
            hasRequiredSkills: target.identity.scope === 'project'
              ? target.plugin.manifest.skills !== undefined
              : requiredSkillWrites.length > 0,
          });
          const config = await readCodexConfigFile(
            resolveCodexPaths(target.identity.cwd, 'user', options.context.env).configTomlPath,
          );
          const marketplace = config.snapshot.marketplaces[marketplaceName];
          if (path.normalize(marketplace?.source ?? '') !== path.normalize(marketplaceRoot)) {
            await runNativeCliChecked(
              buildCodexMarketplaceAddInvocation(
                requireCodexManager(currentCodexManager()),
                marketplaceRoot,
                target.identity.cwd,
                options.context.env,
              ),
              runner,
            );
          }
          await runNativeCliChecked(
            buildCodexMarketplaceListInvocation(
              requireCodexManager(currentCodexManager()),
              target.identity.cwd,
              options.context.env,
            ),
            runner,
          );
          await runNativeCliChecked(
            buildCodexPluginAddInvocation(
              requireCodexManager(currentCodexManager()),
              pluginId,
              target.identity.cwd,
              options.context.env,
            ),
            runner,
          );
          await runNativeCliChecked(
            buildCodexPluginListInvocation(
              requireCodexManager(currentCodexManager()),
              target.identity.cwd,
              options.context.env,
            ),
            runner,
          );
          await assertCodexNativeInstallState({
            pluginName: target.identity.pluginName,
            pluginVersion: target.identity.pluginVersion,
            cwd: target.identity.cwd,
            env: options.context.env,
            marketplaceRoot,
            marketplaceName,
            skillsRelativeRoot,
            requiredSkillKeys: requiredSkillWrites.flatMap((action) =>
              action.owner?.artifactKey ? [action.owner.artifactKey] : []),
          });
          } else {
          await runNativeCliChecked({
            command: 'claude',
            args: ['plugin', 'marketplace', 'add', marketplaceRoot, '--scope', target.identity.scope],
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
            marketplaceRoot,
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
        }
      };
      await writeGeneration();
    },
    writeArtifacts: async (target) => {
      for (const operationAction of target.operationActions ?? []) {
        if (operationAction.kind === 'writeOwnedArtifact'
          || operationAction.kind === 'updateSharedConfig'
          || operationAction.kind === 'setActivation') {
          await applyPlannedOperationAction(operationAction);
        }
      }
      return target.artifacts;
    },
    runPostApply: async (invocation: RebuildPostApplyInvocation) => {
      try {
        await runPostApplyScript({
        plugin: invocation.plugin,
        platform: invocation.target.identity.platform,
        scope: invocation.target.identity.scope,
        cwd: invocation.target.identity.cwd,
        context: options.context as never,
        artifacts: [...invocation.artifacts],
        components: invocation.components,
        scriptTimeoutMs: options.scriptTimeoutMs,
      });
      } catch (error) {
        await options.context.reporter.notice({
          level: 'warning',
          message: error instanceof Error ? error.message : String(error),
          source: {
            plugin: invocation.plugin.manifest.name,
            platform: invocation.target.identity.platform,
            scope: invocation.target.identity.scope,
            action: 'postApply',
          },
          target: 'stderr',
        });
        throw error;
      }
    },
  };
}

export function createRebuildIntegration(options: {
  context: RebuildExecutionContext;
  scriptTimeoutMs?: number;
  preparedTargets?: readonly DesiredTarget[];
}): RebuildIntegration {
  const targets = [...(options.preparedTargets ?? [])];
  const driver = createNativeDriver({ targets, ...options });
  return {
    driver,
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
          ? []
          : [
              path.join(getCodexHome(options.context.env), 'skills'),
              ...(preserveCodexSharedNativePayload
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
      })));
      const scannedSkills = (await scanSkills()).flat();
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
        const nativePluginRoots = await Promise.all([
          path.join(
            input.marketplaceRoot ?? resolveAwHome(options.context.env),
            'plugins',
            input.plugin.manifest.name,
          ),
          path.join(
            getCodexHome(options.context.env),
            'plugins',
            'cache',
            input.marketplaceName ?? MARKETPLACE_NAME,
            input.plugin.manifest.name,
          ),
        ].map((root) => canonicalizePathThroughExistingAncestor(root)));
        historicalComponents = historicalComponents.filter((component) => {
          if (!('path' in component)) return true;
          return nativePluginRoots.every((nativePluginRoot) => {
            const relative = path.relative(nativePluginRoot, path.resolve(component.path));
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
      const codexNative = input.platform === 'codex' && nativeRequired
        ? await inspectCodexNativeResidue({
            pluginName: input.plugin.manifest.name,
            cwd: input.cwd,
            env: options.context.env,
            marketplaceName: input.marketplaceName,
            marketplaceRoot: input.marketplaceRoot,
          })
        : undefined;
      const codexNativeExact = codexNative?.state === 'present'
        && codexNative.versions.length > 0
        && codexNative.versions.every((version) => version === input.plugin.manifest.version);
      const materializeNativeRequired = nativeDesired && (
        input.platform === 'claude'
        || input.command === 'reinstall'
        || !codexNativeExact
      );
      const nativeCleanupCandidate = input.platform === 'claude'
        && input.includeNativeCleanupCandidate !== false;
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
        && nativeDesired
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
      const operationActions = writes.flatMap((write) => [
        ...(write.action ? [write.action] : []),
        ...(write.additionalActions ?? []),
      ]);
      finalizeOwnedArtifactActions(operationActions);
      if (nativeDesired) {
        operationActions.unshift({
          kind: 'ensureNativeRegistration',
          pluginId: input.pluginId ?? pluginActionId(input.plugin),
          platform: input.platform,
          scope: input.scope,
          registration: `${input.plugin.manifest.name}@${input.marketplaceName ?? MARKETPLACE_NAME}`,
          marketplaceName: input.marketplaceName ?? MARKETPLACE_NAME,
          marketplaceRoot: input.marketplaceRoot ?? resolveAwHome(options.context.env),
        });
      }
      const postApply = input.plugin.manifest.scripts?.postApply;
      if (postApply && input.command !== 'cleanup' && input.command !== 'uninstall') {
        const script = path.resolve(input.plugin.rootDir, postApply.path.replace(/^\.\//u, ''));
        const scriptDigest = `sha256:${crypto.createHash('sha256')
          .update(await fs.readFile(script)).digest('hex')}`;
        operationActions.push({
          kind: 'runPostApply',
          pluginId: input.pluginId ?? pluginActionId(input.plugin),
          platform: input.platform,
          scope: input.scope,
          script: postApply.path,
          scriptDigest,
        });
      }
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
        artifacts: writes.map((write) => write.artifact),
        operationActions,
        catalog: input.catalog,
        postApplySource: input.plugin,
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
    const residue = await inspectCodexNativeResidue({
      pluginName: target.identity.pluginName,
      cwd: target.identity.cwd,
      env: options.context.env,
      marketplaceName: target.identity.marketplaceName,
      marketplaceRoot: target.identity.marketplaceRoot,
    });
    if (residue.state !== 'present' || !residue.enabled) return { target, inspection };
    const installed = [...new Set(residue.installedVersions)];
    if (installed.length > 0) {
      return installed.length === 1
        ? { target, inspection, installedVersion: installed[0] }
        : { target, inspection };
    }
    const cached = [...new Set(residue.cacheVersions)];
    return cached.length === 1
      ? { target, inspection, installedVersion: cached[0] }
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
      for (const name of await discoverCodexNativeResidueNames({
        cwd: options.cwd,
        env: options.env,
        marketplaceName: options.marketplaceName,
        marketplaceRoot: options.marketplaceRoot,
      })) names.add(name);
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
