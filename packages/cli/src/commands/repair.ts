import path from 'node:path';

import fs from 'fs-extra';

import { createAdapters, loadPluginTargetsForCommand } from './common.js';
import {
  collectP7Locations,
  type CollectedLocationState,
} from './diagnose.js';
import {
  normalizeCommandOptions,
  parseSkillTriggerPreference,
  type RawCommandOptions,
} from './options.js';
import { createCommandExecutionContext, type CommandExecutionContextInput } from './runtime.js';
import {
  assertNoDuplicateInstalls,
  shouldEnforceDuplicateInstallPreflight,
} from './scope-exclusivity-preflight.js';
import {
  buildGlobalDependencyIndexRecord,
  inspectGlobalDependencyIndex,
  readInstallRecordFileAt,
  readInstallRecordForLocation,
  writeGlobalDependencyIndex,
} from '../install-state/facade.js';
import type { CurrentCatalogSource } from '../install-state/evidence.js';
import { createRecordId, createSharedIdentityId } from '../install-state/ids.js';
import { sha256Hex } from '../install-state/internal.js';
import {
  createProjectArtifactSharedLocator,
  getInstallStatePrivateRoot,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import {
  assertProjectArtifactIdentityPathVisible,
  ensureProjectPrivateStateIgnore,
  type ProjectBoundaryWarning,
} from '../install-state/project-boundary.js';
import { stageHistoricalLifecycleRuntime } from '../install-state/runtime-state.js';
import { preflightSharedSkillTriggerRuntimeOwnerUpsert } from '../install-state/shared-runtime-owner.js';
import {
  createDynamicArtifactDiagnosticCacheWriteStage,
  createInstallRecordWriteStage,
  createNativeTransactionMarkerDeletePostCommitAction,
  createProjectArtifactIdentityWriteStage,
  createSharedRuntimeOwnerWriteStage,
  runInstallStateGraphRecordTransaction,
  runInstallStateTransaction,
  type InstallStateReceiptWarning,
  type InstallStateTransactionPostCommitAction,
} from '../install-state/transactions.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  GlobalDependencyIndex,
  GlobalDependencyIndexRecord,
  InstallRecordArtifact,
  InstallRecordFile,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
} from '../install-state/types.js';
import type {
  CommandOptions,
  PluginLocation as CommandPluginLocation,
  ReceiptOverallState,
  ReceiptTargetResult,
  GeneratedArtifact,
  PlatformName,
  PluginLifecycleEvent,
  PluginMeta,
  Scope,
  SkillTriggerPreference,
} from '../types.js';
import { requiresCodexNativePlugin } from '../utils/codex-project-surface.js';
import { resolveUniformSkillTriggerPreference } from '../utils/plugin-config.js';
import { calculateFileDigest, calculatePluginBundleFingerprint, runLifecycleScript } from '../utils/plugin-scripts.js';
import { getLocalMarketplaceCodexSkillRoot } from '../utils/local-marketplace.js';
import { resolveAwHome, resolveEmbeddedPluginsRoot } from '../utils/paths.js';

export interface RawRepairCommandOptions extends RawCommandOptions {
  adoptExisting?: boolean;
  dependencyIndex?: boolean;
  json?: boolean;
  requestedSkillTrigger?: SkillTriggerPreference | string;
  skillTrigger?: SkillTriggerPreference | string;
  takeoverSharedRuntime?: boolean;
}

export interface RepairCommandOptions extends CommandOptions {
  adoptExisting: boolean;
  dependencyIndex: boolean;
  json?: boolean;
  requestedSkillTrigger?: SkillTriggerPreference;
  takeoverSharedRuntime?: boolean;
}

export interface RepairDependencyIndexCoverage {
  coverageTrusted: boolean;
  reasons: string[];
  verifiedLocations: PluginLocation[];
  revisitProjectLocations: PluginLocation[];
  recoverySuggestion: string | null;
}

export interface RepairLocationPayload {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  action:
    | 'sameBundleRepair'
    | 'markerOnlyRepair'
    | 'recordMarkerClosure'
    | 'adoptExisting'
    | 'dependencyIndexRefresh';
  changed: {
    record: boolean;
    dynamicDiagnosticCache: boolean;
    projectIdentity: boolean;
    historicalLifecycleRuntime: boolean;
    dependencyIndex: boolean;
    nativeMarkerDeleted: boolean;
    artifactsReapplied: boolean;
    nativeInstallReplayed: boolean;
    lifecycleExecuted: boolean;
  };
  adoptExistingLifecycleReason?: 'adoptExistingFirstLocalRecord';
  adoptExistingLifecycleSkippedReason?: 'noInstallLifecycleDeclared';
  dependencyIndexTrusted: boolean;
  dependencyIndexCoverageReason: string[];
  dependencyIndexVerifiedLocations: PluginLocation[];
  dependencyIndexRevisitLocations: PluginLocation[];
  dependencyIndexRecoveryMessage: string | null;
  triggerPreferenceApplied: SkillTriggerPreference | null;
  dynamicArtifacts: Array<{
    id: string;
    target: string;
    state: string;
    artifactKey?: string;
    roleKey?: string;
    disabledReason?: string;
    configDigest?: string;
    contentDigest?: string;
  }>;
  sharedSkillTriggerOwner: {
    present: boolean;
    needsTakeover: boolean;
    ownerConflict: boolean;
    suppressedOwnerConflict: boolean;
  };
  nativeTransactionMarker: {
    present: boolean;
    status: CollectedLocationState['projection']['nativeTransactionKind'];
    recordCommitted: boolean;
    markerPending: boolean;
    needsAttention: boolean;
    repairCommand?: string;
    cleanupCommand?: string;
  };
  warnings: InstallStateReceiptWarning[];
}

export interface RepairDependencyIndexPayload {
  action: 'dependencyIndexRepair';
  changed: {
    dependencyIndex: true;
  };
  rebuiltEntries: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
    recordPath: string;
  }>;
  preservedEntries: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
    recordPath: string;
    status: 'staleCandidate' | 'unreadableReference';
  }>;
  coverage: RepairDependencyIndexCoverage;
  dependencyIndexTrusted: boolean;
  dependencyIndexCoverageReason: string[];
  dependencyIndexVerifiedLocations: PluginLocation[];
  dependencyIndexRevisitLocations: PluginLocation[];
  dependencyIndexRecoveryMessage: string | null;
}

export interface RepairJsonPayload {
  ok: true;
  command: 'repair';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  generatedAt: string;
  dependencyIndexMode: boolean;
  targetResults: ReceiptTargetResult[];
  locations: RepairLocationPayload[];
  dependencyIndex?: RepairDependencyIndexPayload;
}

interface MutableRepairState {
  evidence: CollectedLocationState['evidence'];
  projection: CollectedLocationState['projection'];
}

interface RepairRuntimeOverrides extends CommandExecutionContextInput {
  p8CurrentPluginsByName?: Record<string, PluginMeta>;
}

function normalizeRepairCommandOptions(
  raw: RawRepairCommandOptions = {},
): RepairCommandOptions {
  if (raw.dependencyIndex && raw.adoptExisting) {
    throw new Error('--dependency-index 不能与 --adopt-existing 一起使用。');
  }
  if (raw.dependencyIndex && raw.scope !== undefined) {
    throw new Error('--dependency-index 不接受 `--scope`。');
  }
  if (raw.dependencyIndex && raw.platform !== undefined) {
    throw new Error('--dependency-index 不接受 `--platform`。');
  }
  const base = normalizeCommandOptions(raw, {
    defaultScope: 'user',
    requirePlatform: raw.dependencyIndex !== true,
    missingPlatformMessage: 'repair 命令需要显式指定 `--platform codex|claude|both`。',
    ...(raw.dependencyIndex ? { defaultPlatform: 'both' as const } : {}),
  });
  const requestedSkillTrigger = raw.requestedSkillTrigger ?? raw.skillTrigger;
  return {
    ...base,
    adoptExisting: raw.adoptExisting === true,
    dependencyIndex: raw.dependencyIndex === true,
    json: raw.json === true,
    takeoverSharedRuntime: raw.takeoverSharedRuntime,
    ...(requestedSkillTrigger === undefined
      ? {}
      : { requestedSkillTrigger: parseSkillTriggerPreference(requestedSkillTrigger) }),
  };
}

function toCommandPluginLocation(location: PluginLocation): CommandPluginLocation {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.projectKey ?? null,
  };
}

function renderLocationLabel(location: Pick<PluginLocation, 'platform' | 'scope'>): string {
  const platform = location.platform === 'codex' ? 'Codex' : 'Claude Code';
  const scope = location.scope === 'project' ? '当前项目' : '当前用户';
  return `${platform}（${scope}）`;
}

function buildRepairTargetResults(locations: RepairLocationPayload[]): ReceiptTargetResult[] {
  return locations.map((location) => ({
    target: {
      pluginName: location.plugin,
      platform: location.platform,
      scope: location.scope,
      ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    },
    action: 'repair',
    state: 'completed',
    rollbackState: 'notNeeded',
  }));
}

function createSkillTriggerMaterializationTarget(
  platform: PlatformName,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv,
): {
  platform: 'codex';
  scope: 'user';
  kind: 'localMarketplaceRuntime';
  root: string;
} | {
  platform: 'codex';
  scope: 'project';
  kind: 'repoSkill';
  root: string;
} | {
  platform: 'claude';
  scope: Scope;
  kind: 'localMarketplaceRuntime';
  root: string;
} {
  if (platform === 'codex' && scope === 'project') {
    return {
      platform: 'codex',
      scope: 'project',
      kind: 'repoSkill',
      root: path.join(resolveProjectScopeRepoRoot(cwd), '.agents', 'skills'),
    };
  }
  if (platform === 'codex') {
    return {
      platform: 'codex',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: resolveAwHome(env),
    };
  }
  return {
    platform: 'claude',
    scope,
    kind: 'localMarketplaceRuntime',
    root: resolveAwHome(env),
  };
}

function shouldSuppressSharedOwnerConflict(location: PluginLocation): boolean {
  return location.platform === 'codex' && location.scope === 'project';
}

function buildRepairLocationDetails(state: CollectedLocationState): Pick<
  RepairLocationPayload,
  | 'dependencyIndexTrusted'
  | 'dependencyIndexCoverageReason'
  | 'dependencyIndexVerifiedLocations'
  | 'dependencyIndexRevisitLocations'
  | 'dependencyIndexRecoveryMessage'
  | 'triggerPreferenceApplied'
  | 'dynamicArtifacts'
  | 'sharedSkillTriggerOwner'
  | 'nativeTransactionMarker'
> {
  const suppressOwnerConflict = shouldSuppressSharedOwnerConflict(state.location);
  const needsTakeover = suppressOwnerConflict ? false : state.evidence.sharedRuntimeOwner.needsTakeover;
  const args = `${state.location.plugin} -p ${state.location.platform} -s ${state.location.scope}`;
  const markerStatus = state.projection.nativeTransactionKind;
  return {
    dependencyIndexTrusted: state.projection.dependencyIndexTrusted,
    dependencyIndexCoverageReason: state.projection.dependencyIndexCoverageReasons,
    dependencyIndexVerifiedLocations: state.projection.dependencyIndexVerifiedLocations,
    dependencyIndexRevisitLocations: state.projection.dependencyIndexRevisitProjectLocations,
    dependencyIndexRecoveryMessage: state.projection.dependencyIndexCoverageTrusted
      ? null
      : state.projection.dependencyIndexRevisitProjectLocations.length > 0
        ? `请回到这些位置重新运行 status --verbose 或 repair：${state.projection.dependencyIndexRevisitProjectLocations
          .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
          .join('，')}。`
        : state.projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects'
          ? '请回到可能相关的仓库重新运行 status --verbose 或 repair。'
          : `依赖索引覆盖仍不完整：${state.projection.dependencyIndexCoverageReasons.join('、') || 'unknown'}。`,
    triggerPreferenceApplied: state.evidence.installRecord.read.status === 'ok'
      ? state.evidence.installRecord.read.value.record.options?.skillTriggerPreference ?? null
      : null,
    dynamicArtifacts: state.evidence.dynamicDiagnostic.entries.map(({ entry }) => ({
      id: entry.id,
      target: entry.target,
      state: entry.state,
      ...(entry.artifactKey ? { artifactKey: entry.artifactKey } : {}),
      ...(entry.roleKey ? { roleKey: entry.roleKey } : {}),
      ...(entry.disabledReason ? { disabledReason: entry.disabledReason } : {}),
      ...(entry.configDigest ? { configDigest: entry.configDigest } : {}),
      ...(entry.contentDigest ? { contentDigest: entry.contentDigest } : {}),
    })),
    sharedSkillTriggerOwner: {
      present: state.evidence.sharedRuntimeOwner.read.status === 'ok',
      needsTakeover,
      ownerConflict: needsTakeover,
      suppressedOwnerConflict: suppressOwnerConflict && state.evidence.sharedRuntimeOwner.needsTakeover,
    },
    nativeTransactionMarker: {
      present: state.projection.nativeTransactionPresent,
      status: markerStatus,
      recordCommitted: markerStatus === 'recordInstallResidual',
      markerPending: markerStatus !== 'none',
      needsAttention: markerStatus !== 'none',
      ...(markerStatus !== 'none' ? { repairCommand: `aw repair ${args}` } : {}),
      ...(markerStatus !== 'none' ? { cleanupCommand: `aw cleanup ${args}` } : {}),
    },
  };
}

function collectRemovedDynamicTracking(state: CollectedLocationState): Array<{
  id: string;
  target: string;
  artifactKey?: string;
  roleKey?: string;
}> {
  if (!state.currentCatalog || state.evidence.installRecord.sameBundleAsCatalog !== true) {
    return [];
  }
  const legacyIds = new Set(['lightweight-instruction', 'codex-explorer-role']);

  return state.evidence.installRecord.artifacts
    .filter((artifact) =>
      artifact.artifact.id !== undefined &&
      artifact.artifact.target !== undefined &&
      legacyIds.has(artifact.artifact.id) &&
      !artifact.matchedCurrentDynamicArtifact)
    .map((artifact) => ({
      id: artifact.artifact.id!,
      target: artifact.artifact.target!,
      ...(artifact.artifact.artifactKey ? { artifactKey: artifact.artifact.artifactKey } : {}),
      ...(artifact.artifact.roleKey ? { roleKey: artifact.artifact.roleKey } : {}),
    }));
}

function summarizeDynamicArtifacts(
  artifacts: readonly GeneratedArtifact[],
): RepairLocationPayload['dynamicArtifacts'] {
  return artifacts
    .filter((artifact) => artifact.id && artifact.target)
    .map((artifact) => ({
      id: artifact.id!,
      target: artifact.target!,
      state: artifact.state ?? 'present',
      ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
      ...(artifact.roleKey ? { roleKey: artifact.roleKey } : {}),
      ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
      ...(artifact.configDigest ? { configDigest: artifact.configDigest } : {}),
      ...(artifact.contentDigest ? { contentDigest: artifact.contentDigest } : {}),
    }));
}

function shouldRefreshCodexUserNativeAfterArtifactRepair(options: {
  location: PluginLocation;
  generatedArtifacts: GeneratedArtifact[];
}): boolean {
  return (
    options.location.platform === 'codex' &&
    options.location.scope === 'user' &&
    options.generatedArtifacts.some((artifact) => artifact.target === 'codex.skill')
  );
}

async function inferCodexUserDynamicSkillPreferenceFromRuntime(options: {
  pluginName: string;
  artifacts: readonly InstallRecordArtifact[];
  env: NodeJS.ProcessEnv;
}): Promise<SkillTriggerPreference | undefined> {
  for (const artifact of options.artifacts) {
    if (artifact.target !== 'codex.skill' || !artifact.artifactKey) {
      continue;
    }
    const metadataPath = path.join(
      getLocalMarketplaceCodexSkillRoot(
        resolveAwHome(options.env),
        options.pluginName,
        artifact.artifactKey,
      ),
      'agents',
      'openai.yaml',
    );
    if (!(await fs.pathExists(metadataPath))) {
      continue;
    }
    const content = await fs.readFile(metadataPath, 'utf8');
    if (content.includes('allow_implicit_invocation: false')) {
      return 'manual';
    }
    if (content.includes('allow_implicit_invocation: true')) {
      return 'default';
    }
  }

  return undefined;
}

function sourceEqualsRecord(source: CurrentCatalogSource, record: InstallRecordFile): boolean {
  return source.pluginVersion === record.record.source.pluginVersion
    && source.manifestDigest === record.record.source.manifestDigest
    && source.bundleFingerprint === record.record.source.bundleFingerprint;
}

function pluginDeclaresLifecycle(plugin: PluginMeta, event?: PluginLifecycleEvent): boolean {
  const lifecycle = plugin.manifest.scripts?.lifecycle;
  if (!lifecycle) {
    return false;
  }
  if (event) {
    return lifecycle[event] !== undefined;
  }
  return lifecycle.install !== undefined
    || lifecycle.upgrade !== undefined
    || lifecycle.uninstall !== undefined;
}

async function buildCurrentCatalogSource(plugin: PluginMeta): Promise<CurrentCatalogSource> {
  return {
    pluginVersion: plugin.manifest.version,
    manifestDigest: await calculateFileDigest(plugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(plugin.rootDir),
  };
}

async function resolveCurrentPluginForRepair(options: {
  pluginName: string;
  cwd: string;
  scope: Scope;
  env: NodeJS.ProcessEnv;
  runtime: RepairRuntimeOverrides;
}): Promise<PluginMeta | undefined> {
  const overridden = options.runtime.p8CurrentPluginsByName?.[options.pluginName];
  if (overridden) {
    return overridden;
  }
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    [options.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env: options.env,
    },
  );
  return targets.find((target) => target.pluginName === options.pluginName)?.currentPlugin;
}

function toInstallRecordArtifacts(
  artifacts: readonly GeneratedArtifact[],
): InstallRecordArtifact[] {
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    platform: artifact.platform,
    path: artifact.path,
    ...(artifact.paths?.length ? { paths: [...artifact.paths] } : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.hookGroups === undefined ? {} : { hookGroups: structuredClone(artifact.hookGroups) }),
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.target === undefined ? {} : { target: artifact.target }),
    ...(artifact.state === undefined ? {} : { state: artifact.state }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
      ? { ownershipMarker: artifact.artifactKey ?? artifact.path }
      : {}),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
  }));
}

function toDynamicDiagnosticEntry(
  artifact: GeneratedArtifact,
  scope: Scope,
  updatedAt: string,
): DynamicArtifactDiagnosticEntry | null {
  if (!artifact.id || !artifact.target) {
    return null;
  }
  const state = artifact.state ?? 'present';
  return {
    id: artifact.id,
    target: artifact.target,
    state,
    ...(state === 'disabled' && artifact.disabledReason
      ? { disabledReason: artifact.disabledReason }
      : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.refreshKeys?.length ? { refreshKeys: [...artifact.refreshKeys] } : {}),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
    lastRefresh: {
      status: 'success',
      at: updatedAt,
      event: 'repair',
    },
    refreshReach: {
      commandScope: scope === 'project' ? 'projectShared' : 'user',
      refreshedUserTarget: scope === 'user',
      refreshedCurrentProjectTarget: scope === 'project',
    },
  };
}

function createDynamicDiagnosticCacheValue(options: {
  recordFile: InstallRecordFile;
  location: PluginLocation;
  artifacts: readonly GeneratedArtifact[];
}): DynamicArtifactDiagnosticCache {
  return {
    version: 1,
    recordId: options.recordFile.recordId,
    location: {
      plugin: options.location.plugin,
      platform: options.location.platform,
      scope: options.location.scope,
      ...(options.location.scope === 'project'
        ? { projectKey: options.location.projectKey ?? undefined }
        : {}),
    },
    updatedAt: options.recordFile.record.updatedAt,
    artifacts: options.artifacts
      .map((artifact) => toDynamicDiagnosticEntry(artifact, options.location.scope, options.recordFile.record.updatedAt))
      .filter((artifact): artifact is DynamicArtifactDiagnosticEntry => artifact !== null),
  };
}

function toProjectArtifactIdentityArtifact(
  artifact: GeneratedArtifact,
  repoRoot: string,
): ProjectArtifactIdentityArtifact {
  return {
    kind: artifact.kind,
    platform: artifact.platform,
    path: path.relative(repoRoot, artifact.path).split(path.sep).join('/'),
    ...(artifact.paths?.length
      ? {
          paths: artifact.paths.map((entryPath) =>
            path.relative(repoRoot, entryPath).split(path.sep).join('/'),
          ),
        }
      : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.hookGroups === undefined ? {} : { hookGroups: structuredClone(artifact.hookGroups) }),
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.target === undefined ? {} : { target: artifact.target }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
      ? { ownershipMarker: artifact.artifactKey ?? artifact.path }
      : {}),
    ...(artifact.state === undefined ? {} : { state: artifact.state }),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
  };
}

function collectRepoVisibleProjectArtifacts(
  repoRoot: string,
  artifacts: readonly GeneratedArtifact[],
): GeneratedArtifact[] {
  const repoRootResolved = path.resolve(repoRoot);
  return artifacts.filter((artifact) => {
    const artifactPath = path.resolve(artifact.path);
    return artifactPath === repoRootResolved || artifactPath.startsWith(`${repoRootResolved}${path.sep}`);
  });
}

function createProjectIdentityFile(options: {
  plugin: PluginMeta;
  location: PluginLocation;
  repoRoot: string;
  projectRoot: string;
  source: CurrentCatalogSource;
  artifacts: readonly GeneratedArtifact[];
  generatedAt: string;
}): ProjectArtifactIdentityFile {
  const locator = createProjectArtifactSharedLocator({
    plugin: options.plugin.manifest.name,
    platform: options.location.platform,
    repoRoot: options.repoRoot,
    projectRoot: options.projectRoot,
  });
  const identityArtifacts = collectRepoVisibleProjectArtifacts(options.repoRoot, options.artifacts)
    .map((artifact) => toProjectArtifactIdentityArtifact(artifact, options.repoRoot));
  return {
    version: 1,
    sharedIdentityId: createSharedIdentityId(locator),
    locator,
    source: options.source,
    generatedAt: options.generatedAt,
    artifacts: identityArtifacts,
  };
}

function createRecordFile(options: {
  location: PluginLocation;
  source: CurrentCatalogSource;
  previousRecord?: InstallRecordFile | null;
  artifacts: readonly GeneratedArtifact[];
  updatedAt: string;
  installedAt?: string;
  lifecycle?: InstallRecordFile['record']['lifecycle'];
  requestedSkillTrigger?: SkillTriggerPreference;
}): InstallRecordFile {
  const previous = options.previousRecord;
  const recordId = previous?.recordId ?? createRecordId(options.location);
  return {
    version: 2,
    recordId,
    record: {
      pluginName: options.location.plugin,
      platform: options.location.platform,
      scope: options.location.scope,
      ...(options.location.scope === 'project'
        ? { projectKey: options.location.projectKey ?? undefined }
        : {}),
      installedAt: options.installedAt ?? previous?.record.installedAt ?? options.updatedAt,
      updatedAt: options.updatedAt,
      source: options.source,
      installSource: previous?.record.installSource ?? {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      options: {
        skillTriggerPreference: options.requestedSkillTrigger
          ?? previous?.record.options?.skillTriggerPreference
          ?? 'default',
      },
      ...(previous?.record.native
        ? { native: previous.record.native }
        : options.location.platform === 'codex' && options.location.scope === 'user'
          ? {
              native: {
                pluginId: `${options.location.plugin}@aw`,
                installedByAw: true,
              },
            }
          : {}),
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      artifacts: toInstallRecordArtifacts(options.artifacts),
      dependencyEdges: previous?.record.dependencyEdges ?? [],
    },
  };
}

function createSyntheticSharedIdentityId(locator: ProjectArtifactIdentityFile['locator']): string {
  return createSharedIdentityId(locator);
}

function rewriteProjectIdentityId(
  value: ProjectArtifactIdentityFile,
): ProjectArtifactIdentityFile {
  return {
    ...value,
    sharedIdentityId: createSyntheticSharedIdentityId(value.locator),
  };
}

function isRepairRewriteIssue(code: CollectedLocationState['projection']['issues'][number]['code']): boolean {
  return code !== 'nativeTransactionPresent';
}

async function ensureProjectRepairPrivateState(options: {
  cwd: string;
  location: PluginLocation;
}): Promise<InstallStateReceiptWarning[]> {
  if (options.location.scope !== 'project') {
    return [];
  }
  const privateRoot = getInstallStatePrivateRoot(options.cwd, options.location);
  const results = await Promise.all([
    ensureProjectPrivateStateIgnore({
      cwd: options.cwd,
      targetPath: path.join(privateRoot, 'records'),
    }),
    ensureProjectPrivateStateIgnore({
      cwd: options.cwd,
      targetPath: path.join(privateRoot, 'diagnostics'),
    }),
  ]);
  const warnings: InstallStateReceiptWarning[] = [];
  for (const result of results) {
    if (result.status === 'warning' && result.warning) {
      warnings.push(projectBoundaryWarningToReceipt(result.warning));
    }
  }
  return warnings;
}

function projectBoundaryWarningToReceipt(
  warning: ProjectBoundaryWarning,
): InstallStateReceiptWarning {
  return {
    code: warning.code,
    message: warning.message,
  };
}

async function maybeStageHistoricalLifecycle(options: {
  cwd: string;
  location: PluginLocation;
  plugin: PluginMeta;
  source: CurrentCatalogSource;
  previousRecord?: InstallRecordFile | null;
  env: NodeJS.ProcessEnv;
}): Promise<ReturnType<typeof stageHistoricalLifecycleRuntime> | null> {
  const shouldStage = options.previousRecord?.record.lifecycle !== undefined || pluginDeclaresLifecycle(options.plugin);
  if (!shouldStage) {
    return null;
  }
  return stageHistoricalLifecycleRuntime({
    cwd: options.cwd,
    location: options.location,
    sourceBundleRoot: options.plugin.rootDir,
    pluginVersion: options.source.pluginVersion,
    manifestDigest: options.source.manifestDigest,
    bundleFingerprint: options.source.bundleFingerprint,
    events: ['install', 'upgrade', 'uninstall'],
    recordId: options.previousRecord?.recordId,
    manifestRelativePath: path.relative(options.plugin.rootDir, options.plugin.manifestPath),
    env: options.env,
  });
}

async function upsertDependencyInstallSource(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
  requestedSkillTrigger?: SkillTriggerPreference;
}): Promise<void> {
  const read = await readInstallRecordForLocation({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  if (read.status !== 'ok') {
    return;
  }
  const nextRecord = structuredClone(read.value);
  nextRecord.record.installSource = {
    kind: 'dependency',
    explicitlyRequested: false,
  };
  if (options.requestedSkillTrigger) {
    nextRecord.record.options = {
      ...(nextRecord.record.options ?? {}),
      skillTriggerPreference: options.requestedSkillTrigger,
    };
  }
  await runInstallStateTransaction({
    stages: [
      await createInstallRecordWriteStage({
        filePath: read.path,
        value: nextRecord,
        env: options.env,
      }),
    ],
    postCommit: [
      createDependencyIndexRefreshAction({
        cwd: options.cwd,
        recordFile: nextRecord,
        recordPath: read.path,
        env: options.env,
      }),
    ],
  });
}

function createDependencyIndexRefreshAction(options: {
  cwd: string;
  recordFile: InstallRecordFile;
  recordPath: string;
  env: NodeJS.ProcessEnv;
}): InstallStateTransactionPostCommitAction {
  return {
    label: 'dependency index refresh',
    async run() {
      const next = await buildRepairedDependencyIndex({
        cwd: options.cwd,
        env: options.env,
        currentRecord: {
          recordFile: options.recordFile,
          recordPath: options.recordPath,
        },
      });
      await writeGlobalDependencyIndex(next.value, options.env);
    },
    toWarning(error) {
      return {
        code: 'dependencyIndexRefreshFailed',
        message: 'Install record changed, but dependency index refresh failed.',
        error: error instanceof Error ? error.message : String(error),
      };
    },
  };
}

async function buildRepairedDependencyIndex(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  currentRecord?: {
    recordFile: InstallRecordFile;
    recordPath: string;
  };
}): Promise<{
  value: GlobalDependencyIndex;
  rebuiltEntries: GlobalDependencyIndexRecord[];
  preservedEntries: Array<GlobalDependencyIndexRecord & {
    status: 'staleCandidate' | 'unreadableReference';
  }>;
  coverage: RepairDependencyIndexCoverage;
}> {
  const inspection = await inspectGlobalDependencyIndex(options.env);
  const visibleRecords = await collectVisibleInstallRecords({
    cwd: options.cwd,
    env: options.env,
  });
  if (options.currentRecord) {
    visibleRecords.push({
      recordFile: options.currentRecord.recordFile,
      recordPath: options.currentRecord.recordPath,
    });
  }

  const dedupedVisible = new Map<string, { recordFile: InstallRecordFile; recordPath: string }>();
  for (const visible of visibleRecords) {
    dedupedVisible.set(
      `${visible.recordPath}\0${visible.recordFile.recordId}`,
      visible,
    );
  }

  const rebuiltEntries = await Promise.all(
    [...dedupedVisible.values()].map(async (visible) =>
      buildGlobalDependencyIndexRecord({
        recordFile: visible.recordFile,
        recordPath: visible.recordPath,
        recordDigest: sha256Hex(await fs.readFile(visible.recordPath)),
        now: new Date().toISOString(),
      })),
  );

  const preservedEntries: Array<GlobalDependencyIndexRecord & {
    status: 'staleCandidate' | 'unreadableReference';
  }> = inspection.status === 'ok'
    ? inspection.references
      .map((reference, index) => ({ reference, record: inspection.value.records[index]! }))
      .filter((entry) =>
        entry.reference.status === 'staleCandidate' || entry.reference.status === 'unreadableReference')
      .map((entry) => ({
        ...entry.record,
        status: entry.reference.status,
      }))
      .filter((entry): entry is GlobalDependencyIndexRecord & {
        status: 'staleCandidate' | 'unreadableReference';
      } => entry.status === 'staleCandidate' || entry.status === 'unreadableReference')
    : [];

  const rebuiltKeySet = new Set(rebuiltEntries.map((entry) =>
    `${entry.recordPath}\0${entry.location.plugin}\0${entry.location.platform}\0${entry.location.scope}\0${entry.location.projectKey ?? ''}`));
  const mergedRecords = [
    ...preservedEntries
      .filter((entry) =>
        !rebuiltKeySet.has(`${entry.recordPath}\0${entry.location.plugin}\0${entry.location.platform}\0${entry.location.scope}\0${entry.location.projectKey ?? ''}`))
      .map(({ status: _status, ...record }) => record),
    ...rebuiltEntries,
  ];
  const reasons = [
    ...(inspection.status === 'missing' ? ['indexMissing'] : []),
    ...(inspection.status === 'corrupted' ? ['indexCorrupted'] : []),
    ...preservedEntries.map((entry) => entry.status === 'staleCandidate' ? 'staleReference' : 'unreadableReference'),
  ];
  const revisitProjectLocations = preservedEntries
    .filter((entry) => entry.location.scope === 'project')
    .map((entry) => entry.location);
  const coverageTrusted = reasons.length === 0;
  return {
    value: {
      version: 1,
      updatedAt: new Date().toISOString(),
      records: mergedRecords,
    },
    rebuiltEntries,
    preservedEntries,
    coverage: {
      coverageTrusted,
      reasons: [...new Set(reasons)],
      verifiedLocations: rebuiltEntries.map((entry) => entry.location),
      revisitProjectLocations,
      recoverySuggestion: !coverageTrusted && revisitProjectLocations.length === 0
        ? 'revisitRelatedProjects'
        : null,
    },
  };
}

async function collectVisibleInstallRecords(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Array<{ recordFile: InstallRecordFile; recordPath: string }>> {
  const directories = [
    path.join(getInstallStatePrivateRoot(options.cwd, {
      plugin: '__unused__',
      platform: 'codex',
      scope: 'user',
    }, options.env), 'records'),
    path.join(getInstallStatePrivateRoot(options.cwd, {
      plugin: '__unused__',
      platform: 'claude',
      scope: 'user',
    }, options.env), 'records'),
    path.join(getInstallStatePrivateRoot(options.cwd, {
      plugin: '__unused__',
      platform: 'codex',
      scope: 'project',
      projectKey: options.cwd,
    }, options.env), 'records'),
    path.join(getInstallStatePrivateRoot(options.cwd, {
      plugin: '__unused__',
      platform: 'claude',
      scope: 'project',
      projectKey: options.cwd,
    }, options.env), 'records'),
  ];

  const output: Array<{ recordFile: InstallRecordFile; recordPath: string }> = [];
  for (const recordsDir of directories) {
    if (!(await fs.pathExists(recordsDir))) {
      continue;
    }
    const entries = (await fs.readdir(recordsDir))
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    for (const entry of entries) {
      const recordPath = path.join(recordsDir, entry);
      const read = await readInstallRecordFileAt(recordPath, { env: options.env });
      if (read.status === 'ok') {
        output.push({
          recordFile: read.value,
          recordPath: read.path,
        });
      }
    }
  }
  return output;
}

async function runDependencyIndexRepair(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<RepairDependencyIndexPayload> {
  const repaired = await buildRepairedDependencyIndex({
    cwd: options.cwd,
    env: options.env,
  });
  await writeGlobalDependencyIndex(repaired.value, options.env);
  return {
    action: 'dependencyIndexRepair',
    changed: {
      dependencyIndex: true,
    },
    rebuiltEntries: repaired.rebuiltEntries.map((entry) => ({
      plugin: entry.location.plugin,
      platform: entry.location.platform,
      scope: entry.location.scope,
      ...(entry.location.projectKey ? { projectKey: entry.location.projectKey } : {}),
      recordPath: entry.recordPath,
    })),
    preservedEntries: repaired.preservedEntries.map((entry) => ({
      plugin: entry.location.plugin,
      platform: entry.location.platform,
      scope: entry.location.scope,
      ...(entry.location.projectKey ? { projectKey: entry.location.projectKey } : {}),
      recordPath: entry.recordPath,
      status: entry.status,
    })),
    coverage: repaired.coverage,
    dependencyIndexTrusted: repaired.coverage.coverageTrusted,
    dependencyIndexCoverageReason: repaired.coverage.reasons,
    dependencyIndexVerifiedLocations: repaired.coverage.verifiedLocations,
    dependencyIndexRevisitLocations: repaired.coverage.revisitProjectLocations,
    dependencyIndexRecoveryMessage: repaired.coverage.coverageTrusted
      ? null
      : repaired.coverage.revisitProjectLocations.length > 0
        ? `请回到这些位置重新运行 status --verbose 或 repair：${repaired.coverage.revisitProjectLocations
          .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
          .join('，')}。`
        : repaired.coverage.recoverySuggestion === 'revisitRelatedProjects'
          ? '请回到可能相关的仓库重新运行 status --verbose 或 repair。'
          : `依赖索引覆盖仍不完整：${repaired.coverage.reasons.join('、') || 'unknown'}。`,
  };
}

async function ensureDependencyLocationHealthy(options: {
  cwd: string;
  location: PluginLocation;
  parentPreference?: SkillTriggerPreference;
  runtime: RepairRuntimeOverrides;
  env: NodeJS.ProcessEnv;
}): Promise<InstallStateReceiptWarning[]> {
  const dependencyCwd = options.location.scope === 'project'
    ? options.location.projectKey ?? options.cwd
    : options.cwd;
  const dependencyPlugin = await resolveCurrentPluginForRepair({
    pluginName: options.location.plugin,
    cwd: dependencyCwd,
    scope: options.location.scope,
    env: options.env,
    runtime: options.runtime,
  });
  if (!dependencyPlugin) {
    throw new Error(`无法补齐依赖 ${options.location.plugin}：current catalog 中缺少该插件。`);
  }

  const currentSource = await buildCurrentCatalogSource(dependencyPlugin);
  const previousRecordRead = await readInstallRecordForLocation({
    cwd: dependencyCwd,
    location: options.location,
    env: options.env,
  });
  const previousRecord = previousRecordRead.status === 'ok' ? previousRecordRead.value : null;
  if (previousRecord && !sourceEqualsRecord(currentSource, previousRecord)) {
    throw new Error(
      `无法补齐依赖 ${options.location.plugin}：依赖自身的 record source 已经漂移，请先对该依赖执行 upgrade、reinstall 或 cleanup。`,
    );
  }

  const warnings: InstallStateReceiptWarning[] = [];
  warnings.push(...await ensureProjectRepairPrivateState({
    cwd: dependencyCwd,
    location: options.location,
  }));
  if (options.location.scope === 'project') {
    await assertProjectArtifactIdentityPathVisible({
      cwd: dependencyCwd,
      pluginName: options.location.plugin,
      platform: options.location.platform,
      projectKey: options.location.projectKey,
    });
  }

  const adapters = createAdapters(
    dependencyCwd,
    createCommandExecutionContext(options.runtime),
  );
  if (options.location.platform === 'codex' && requiresCodexNativePlugin(dependencyPlugin, options.location.scope)) {
    await adapters.codex.installPlugin(dependencyPlugin, options.location.scope);
  }
  const generatedArtifacts = await adapters[options.location.platform].installExtensions(
    dependencyPlugin,
    options.location.scope,
    {
      event: previousRecord ? 'upgrade' : 'install',
      skillTriggerPreference: options.parentPreference ?? 'default',
    },
  );

  const runtimeStage = await maybeStageHistoricalLifecycle({
    cwd: dependencyCwd,
    location: options.location,
    plugin: dependencyPlugin,
    source: currentSource,
    previousRecord,
    env: options.env,
  });
  const nextRecord = createRecordFile({
    location: options.location,
    source: currentSource,
    previousRecord,
    artifacts: generatedArtifacts.length > 0
      ? generatedArtifacts
      : previousRecord?.record.artifacts as never as GeneratedArtifact[] ?? [],
    updatedAt: new Date().toISOString(),
    lifecycle: runtimeStage?.runtimeRef ?? previousRecord?.record.lifecycle,
    requestedSkillTrigger: options.parentPreference,
  });
  nextRecord.record.installSource = {
    kind: 'dependency',
    explicitlyRequested: false,
  };

  const stages = [];
  if (runtimeStage) {
    stages.push(runtimeStage);
  }
  if (options.location.scope === 'project') {
    const repoRoot = resolveProjectScopeRepoRoot(dependencyCwd);
    const projectRoot = resolveProjectArtifactProjectRoot(dependencyCwd, options.location);
    stages.push(await createProjectArtifactIdentityWriteStage({
      repoRoot,
      locator: createProjectArtifactSharedLocator({
        plugin: options.location.plugin,
        platform: options.location.platform,
        repoRoot,
        projectRoot,
      }),
      value: rewriteProjectIdentityId(createProjectIdentityFile({
        plugin: dependencyPlugin,
        location: options.location,
        repoRoot,
        projectRoot,
        source: currentSource,
        artifacts: generatedArtifacts,
        generatedAt: nextRecord.record.updatedAt,
      })),
    }));
  }
  stages.push(await createDynamicArtifactDiagnosticCacheWriteStage({
    cwd: dependencyCwd,
    location: options.location,
    value: createDynamicDiagnosticCacheValue({
      recordFile: nextRecord,
      location: options.location,
      artifacts: generatedArtifacts,
    }),
    currentRecord: nextRecord,
    env: options.env,
  }));
  const recordPath = previousRecordRead.status === 'ok'
    ? previousRecordRead.path
    : path.join(
        getInstallStatePrivateRoot(dependencyCwd, options.location, options.env),
        'records',
        `${nextRecord.recordId}.json`,
      );
  stages.push(await createInstallRecordWriteStage({
    filePath: recordPath,
    value: nextRecord,
    env: options.env,
  }));
  const result = await runInstallStateGraphRecordTransaction({
    mode: 'upsert',
    stages,
    recordFile: nextRecord,
    recordPath,
    env: options.env,
  });
  return [...warnings, ...result.warnings];
}

async function repairMissingDependenciesForRecord(options: {
  state: CollectedLocationState;
  record: InstallRecordFile;
  repairOptions: RepairCommandOptions;
  runtime: RepairRuntimeOverrides;
  env: NodeJS.ProcessEnv;
}): Promise<InstallStateReceiptWarning[]> {
  const warnings: InstallStateReceiptWarning[] = [];
  const edgesByLocation = new Map(
    options.record.record.dependencyEdges.map((edge) => [
      JSON.stringify([
        edge.dependency.plugin,
        edge.dependency.platform,
        edge.dependency.scope,
        edge.dependency.projectKey ?? null,
      ]),
      edge,
    ]),
  );

  for (const dependency of options.state.evidence.dependencyIndex.projection.dependencyHealth) {
    if (dependency.status === 'ok') {
      continue;
    }
    const edge = edgesByLocation.get(JSON.stringify([
      dependency.dependency.plugin,
      dependency.dependency.platform,
      dependency.dependency.scope,
      dependency.dependency.projectKey ?? null,
    ]));
    const parentPreference = edge?.declaration.inheritInstallOptions === true
      ? options.record.record.options?.skillTriggerPreference
      : undefined;
    warnings.push(...await ensureDependencyLocationHealthy({
      cwd: options.repairOptions.cwd,
      location: dependency.dependency,
      parentPreference,
      runtime: options.runtime,
      env: options.env,
    }));
    await upsertDependencyInstallSource({
      cwd: dependency.dependency.scope === 'project'
        ? dependency.dependency.projectKey ?? options.repairOptions.cwd
        : options.repairOptions.cwd,
      location: dependency.dependency,
      env: options.env,
      requestedSkillTrigger: parentPreference,
    });
  }
  return warnings;
}

async function maybeExecuteInstallLifecycle(options: {
  plugin: PluginMeta;
  location: PluginLocation;
  cwd: string;
  runtime: CommandExecutionContextInput;
  scriptTimeoutMs?: number;
}): Promise<{
  executed: boolean;
  reason?: 'adoptExistingFirstLocalRecord' | 'noInstallLifecycleDeclared';
}> {
  if (!pluginDeclaresLifecycle(options.plugin, 'install')) {
    return {
      executed: false,
      reason: 'noInstallLifecycleDeclared',
    };
  }
  const context = createCommandExecutionContext(options.runtime);
  await runLifecycleScript({
    event: 'install',
    pluginName: options.plugin.manifest.name,
    platform: options.location.platform,
    scope: options.location.scope,
    cwd: options.cwd,
    context,
    currentPlugin: options.plugin,
    scriptTimeoutMs: options.scriptTimeoutMs,
  });
  return {
    executed: true,
    reason: 'adoptExistingFirstLocalRecord',
  };
}

async function maybeCreateSharedRuntimeOwnerStage(options: {
  location: PluginLocation;
  recordFile: InstallRecordFile;
  recordPath: string;
  preference: SkillTriggerPreference;
  repairOptions: RepairCommandOptions;
  env: NodeJS.ProcessEnv;
}): Promise<Awaited<ReturnType<typeof createSharedRuntimeOwnerWriteStage>> | null> {
  const plan = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
    location: options.location,
    embeddedRoot: await resolveEmbeddedPluginsRoot(),
    target: createSkillTriggerMaterializationTarget(
      options.location.platform,
      options.location.scope,
      options.repairOptions.cwd,
      options.env,
    ),
    preference: options.preference,
    command: 'repair',
    takeoverSharedRuntime: options.repairOptions.takeoverSharedRuntime,
    targetCount: 1,
    env: options.env,
  });
  if (plan.status !== 'ok') {
    throw new Error(plan.takeoverRequired.message);
  }
  if (!plan.shouldWriteOwner) {
    return null;
  }
  return createSharedRuntimeOwnerWriteStage({
    recordFile: options.recordFile,
    recordPath: options.recordPath,
    env: options.env,
  });
}

async function preflightRepairSharedRuntimeOwner(options: {
  location: PluginLocation;
  preference: SkillTriggerPreference;
  repairOptions: RepairCommandOptions;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const plan = await preflightSharedSkillTriggerRuntimeOwnerUpsert({
    location: options.location,
    embeddedRoot: await resolveEmbeddedPluginsRoot(),
    target: createSkillTriggerMaterializationTarget(
      options.location.platform,
      options.location.scope,
      options.repairOptions.cwd,
      options.env,
    ),
    preference: options.preference,
    command: 'repair',
    takeoverSharedRuntime: options.repairOptions.takeoverSharedRuntime,
    targetCount: 1,
    env: options.env,
  });
  if (plan.status !== 'ok') {
    throw new Error(plan.takeoverRequired.message);
  }
}

async function repairInstalledLocation(options: {
  state: CollectedLocationState;
  repairOptions: RepairCommandOptions;
  runtime: RepairRuntimeOverrides;
  env: NodeJS.ProcessEnv;
}): Promise<RepairLocationPayload> {
  const { state } = options;
  const location = state.location;
  const record = state.evidence.installRecord.read.status === 'ok'
    ? state.evidence.installRecord.read.value
    : null;
  if (!record) {
    throw new Error(`无法修复 ${location.plugin}：当前 location 没有可信 install record。`);
  }

  const currentPlugin = state.target.currentPlugin;
  if (!currentPlugin) {
    throw new Error(
      `无法修复 ${location.plugin}：当前 catalog 中缺少该插件，repair 不能把 historical runtime、identity metadata 或旧 source 当成 current catalog。`,
    );
  }

  const source = await buildCurrentCatalogSource(currentPlugin);
  const sameBundle = sourceEqualsRecord(source, record);
  const sourceDrift = !sameBundle;
  const removedDynamicTracking = collectRemovedDynamicTracking(state);
  const rewriteIssues = state.projection.issues.filter((issue) => isRepairRewriteIssue(issue.code));

  if (sourceDrift && rewriteIssues.length > 0) {
    throw new Error(
      `${location.plugin} 的 record source 已经漂移，当前 repair 不能隐式升级或重写 artifacts。请改用 aw upgrade、aw reinstall 或 aw cleanup。`,
    );
  }
  if (removedDynamicTracking.length > 0) {
    throw new Error(
      `${location.plugin} 检测到当前 manifest 已移除的历史 dynamic tracking（${removedDynamicTracking
        .map((artifact) => `${artifact.id}/${artifact.target}`)
        .join('、')}）。本轮 repair 不会隐式迁移这些旧入口；请先按新基线重新安装，或显式 cleanup 旧残留。`,
    );
  }

  const warnings: InstallStateReceiptWarning[] = [];
  warnings.push(...await ensureProjectRepairPrivateState({
    cwd: options.repairOptions.cwd,
    location,
  }));

  if (location.scope === 'project') {
    await assertProjectArtifactIdentityPathVisible({
      cwd: options.repairOptions.cwd,
      pluginName: location.plugin,
      platform: location.platform,
      projectKey: location.projectKey,
    });
  }

  warnings.push(...await repairMissingDependenciesForRecord({
    state,
    record,
    repairOptions: options.repairOptions,
    runtime: options.runtime,
    env: options.env,
  }));

  const nativeMarkerPresent = state.evidence.nativeTransaction.classification === 'recordInstallResidual';
  if (sourceDrift) {
    const recordPath = state.evidence.installRecord.read.path;
    const transactionResult = await runInstallStateTransaction({
      stages: [],
      postCommit: [
        ...(nativeMarkerPresent
          ? [createNativeTransactionMarkerDeletePostCommitAction({
              pluginNameOrId: location.plugin,
              env: options.env,
            })]
          : []),
        createDependencyIndexRefreshAction({
          cwd: options.repairOptions.cwd,
          recordFile: record,
          recordPath,
          env: options.env,
        }),
      ],
    });
    return {
      plugin: location.plugin,
      platform: location.platform,
      scope: location.scope,
      ...(location.projectKey ? { projectKey: location.projectKey } : {}),
      action: nativeMarkerPresent ? 'recordMarkerClosure' : 'dependencyIndexRefresh',
      changed: {
        record: false,
        dynamicDiagnosticCache: false,
        projectIdentity: false,
        historicalLifecycleRuntime: false,
        dependencyIndex: true,
        nativeMarkerDeleted: nativeMarkerPresent && transactionResult.warnings.every((warning) => warning.code !== 'nativeMarkerDeleteFailed'),
        artifactsReapplied: false,
        nativeInstallReplayed: false,
        lifecycleExecuted: false,
      },
      ...buildRepairLocationDetails(state),
      warnings: [...warnings, ...transactionResult.warnings],
    };
  }

  const adapters = createAdapters(
    options.repairOptions.cwd,
    createCommandExecutionContext(options.runtime),
  );
  const needsNativeInstall = Boolean(
    location.platform === 'codex'
    && location.scope === 'user'
    && record.record.native?.installedByAw
    && state.evidence.platform.codexNative
    && !state.evidence.platform.codexNative.minimumSatisfied,
  );
  if (needsNativeInstall) {
    await adapters.codex.installPlugin(currentPlugin, location.scope);
  }
  const effectiveSkillTriggerPreference = options.repairOptions.requestedSkillTrigger
    ?? await resolveUniformSkillTriggerPreference({
      plugin: currentPlugin,
      platform: location.platform,
      scope: location.scope,
      cwd: options.repairOptions.cwd,
      env: options.env,
    });
  await preflightRepairSharedRuntimeOwner({
    location,
    preference: effectiveSkillTriggerPreference,
    repairOptions: options.repairOptions,
    env: options.env,
  });
  const generatedArtifacts = await adapters[location.platform].installExtensions(
    currentPlugin,
    location.scope,
    {
      event: 'upgrade',
      skillTriggerPreference: effectiveSkillTriggerPreference,
    },
  );
  let nativeInstallReplayed = needsNativeInstall;
  if (shouldRefreshCodexUserNativeAfterArtifactRepair({ location, generatedArtifacts })) {
    await adapters.codex.installPlugin(currentPlugin, location.scope);
    nativeInstallReplayed = true;
  }

  const runtimeStage = await maybeStageHistoricalLifecycle({
    cwd: options.repairOptions.cwd,
    location,
    plugin: currentPlugin,
    source,
    previousRecord: record,
    env: options.env,
  });
  const nextRecord = createRecordFile({
    location,
    source,
    previousRecord: record,
    artifacts: generatedArtifacts.length > 0 ? generatedArtifacts : record.record.artifacts as never as GeneratedArtifact[],
    updatedAt: new Date().toISOString(),
    lifecycle: runtimeStage?.runtimeRef ?? record.record.lifecycle,
    requestedSkillTrigger: effectiveSkillTriggerPreference,
  });
  const recordPath = state.evidence.installRecord.read.path;
  const stages = [];
  if (runtimeStage) {
    stages.push(runtimeStage);
  }
  if (location.scope === 'project') {
    const repoRoot = resolveProjectScopeRepoRoot(options.repairOptions.cwd);
    const projectRoot = resolveProjectArtifactProjectRoot(options.repairOptions.cwd, location);
    stages.push(await createProjectArtifactIdentityWriteStage({
      repoRoot,
      locator: createProjectArtifactSharedLocator({
        plugin: location.plugin,
        platform: location.platform,
        repoRoot,
        projectRoot,
      }),
      value: rewriteProjectIdentityId(createProjectIdentityFile({
        plugin: currentPlugin,
        location,
        repoRoot,
        projectRoot,
        source,
        artifacts: generatedArtifacts,
        generatedAt: nextRecord.record.updatedAt,
      })),
    }));
  }
  stages.push(await createDynamicArtifactDiagnosticCacheWriteStage({
    cwd: options.repairOptions.cwd,
    location,
    value: createDynamicDiagnosticCacheValue({
      recordFile: nextRecord,
      location,
      artifacts: generatedArtifacts,
    }),
    currentRecord: nextRecord,
    env: options.env,
  }));
  stages.push(await createInstallRecordWriteStage({
    cwd: options.repairOptions.cwd,
    location,
    value: nextRecord,
    env: options.env,
  }));
  const sharedRuntimeOwnerStage = await maybeCreateSharedRuntimeOwnerStage({
    location,
    recordFile: nextRecord,
    recordPath,
    preference: effectiveSkillTriggerPreference,
    repairOptions: options.repairOptions,
    env: options.env,
  });
  if (sharedRuntimeOwnerStage) {
    stages.push(sharedRuntimeOwnerStage);
  }

  const result = await runInstallStateGraphRecordTransaction({
    mode: 'upsert',
    stages,
    recordFile: nextRecord,
    recordPath,
    env: options.env,
    postCommit: nativeMarkerPresent
      ? [createNativeTransactionMarkerDeletePostCommitAction({
          pluginNameOrId: location.plugin,
          env: options.env,
        })]
      : [],
  });

  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    action: nativeMarkerPresent ? 'recordMarkerClosure' : 'sameBundleRepair',
    changed: {
      record: true,
      dynamicDiagnosticCache: true,
      projectIdentity: location.scope === 'project',
      historicalLifecycleRuntime: runtimeStage !== null,
      dependencyIndex: true,
      nativeMarkerDeleted: nativeMarkerPresent && result.warnings.every((warning) => warning.code !== 'nativeMarkerDeleteFailed'),
      artifactsReapplied: true,
      nativeInstallReplayed,
      lifecycleExecuted: false,
    },
    ...buildRepairLocationDetails(state),
    triggerPreferenceApplied: nextRecord.record.options?.skillTriggerPreference ?? null,
    dynamicArtifacts: summarizeDynamicArtifacts(generatedArtifacts),
    warnings: [...warnings, ...result.warnings],
  };
}

async function repairMarkerOnlyLocation(options: {
  state: CollectedLocationState;
  repairOptions: RepairCommandOptions;
  runtime: RepairRuntimeOverrides;
  env: NodeJS.ProcessEnv;
}): Promise<RepairLocationPayload> {
  const { state } = options;
  const location = state.location;
  if (state.evidence.nativeTransaction.classification !== 'markerOnlyInstall') {
    throw new Error(`${location.plugin} 当前不是 marker-only install repair 场景。`);
  }
  const currentPlugin = state.target.currentPlugin;
  if (!currentPlugin) {
    throw new Error(
      `${location.plugin} 当前不在 current catalog 中，无法执行 marker-only repair install。请先恢复 catalog，或改用 aw cleanup。`,
    );
  }
  const source = await buildCurrentCatalogSource(currentPlugin);
  const adapters = createAdapters(
    options.repairOptions.cwd,
    createCommandExecutionContext(options.runtime),
  );
  const nativeSatisfied = state.evidence.platform.codexNative?.minimumSatisfied === true;
  if (!nativeSatisfied) {
    await adapters.codex.installPlugin(currentPlugin, location.scope);
  }
  const requestedPreference = options.repairOptions.requestedSkillTrigger ?? 'default';
  await preflightRepairSharedRuntimeOwner({
    location,
    preference: requestedPreference,
    repairOptions: options.repairOptions,
    env: options.env,
  });
  const generatedArtifacts = await adapters[location.platform].installExtensions(
    currentPlugin,
    location.scope,
    {
      event: 'install',
      skillTriggerPreference: requestedPreference,
    },
  );
  let nativeInstallReplayed = !nativeSatisfied;
  if (shouldRefreshCodexUserNativeAfterArtifactRepair({ location, generatedArtifacts })) {
    await adapters.codex.installPlugin(currentPlugin, location.scope);
    nativeInstallReplayed = true;
  }
  const runtimeStage = await maybeStageHistoricalLifecycle({
    cwd: options.repairOptions.cwd,
    location,
    plugin: currentPlugin,
    source,
    previousRecord: null,
    env: options.env,
  });
  const recordFile = createRecordFile({
    location,
    source,
    artifacts: generatedArtifacts,
    updatedAt: new Date().toISOString(),
    lifecycle: runtimeStage?.runtimeRef,
    requestedSkillTrigger: options.repairOptions.requestedSkillTrigger,
  });
  const stages = [];
  if (runtimeStage) {
    stages.push(runtimeStage);
  }
  stages.push(await createDynamicArtifactDiagnosticCacheWriteStage({
    cwd: options.repairOptions.cwd,
    location,
    value: createDynamicDiagnosticCacheValue({
      recordFile,
      location,
      artifacts: generatedArtifacts,
    }),
    currentRecord: recordFile,
    env: options.env,
  }));
  stages.push(await createInstallRecordWriteStage({
    cwd: options.repairOptions.cwd,
    location,
    value: recordFile,
    env: options.env,
  }));
  const recordPath = path.join(
    getInstallStatePrivateRoot(options.repairOptions.cwd, location, options.env),
    'records',
    `${recordFile.recordId}.json`,
  );
  const sharedRuntimeOwnerStage = await maybeCreateSharedRuntimeOwnerStage({
    location,
    recordFile,
    recordPath,
    preference: recordFile.record.options?.skillTriggerPreference ?? 'default',
    repairOptions: options.repairOptions,
    env: options.env,
  });
  if (sharedRuntimeOwnerStage) {
    stages.push(sharedRuntimeOwnerStage);
  }
  const result = await runInstallStateGraphRecordTransaction({
    mode: 'upsert',
    stages,
    recordFile,
    recordPath,
    env: options.env,
    postCommit: [createNativeTransactionMarkerDeletePostCommitAction({
      pluginNameOrId: location.plugin,
      env: options.env,
    })],
  });
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    action: 'markerOnlyRepair',
    changed: {
      record: true,
      dynamicDiagnosticCache: true,
      projectIdentity: false,
      historicalLifecycleRuntime: runtimeStage !== null,
      dependencyIndex: true,
      nativeMarkerDeleted: result.warnings.every((warning) => warning.code !== 'nativeMarkerDeleteFailed'),
      artifactsReapplied: true,
      nativeInstallReplayed,
      lifecycleExecuted: false,
    },
    ...buildRepairLocationDetails(state),
    triggerPreferenceApplied: recordFile.record.options?.skillTriggerPreference ?? null,
    dynamicArtifacts: summarizeDynamicArtifacts(generatedArtifacts),
    warnings: result.warnings,
  };
}

async function adoptExistingLocation(options: {
  state: CollectedLocationState;
  repairOptions: RepairCommandOptions;
  runtime: RepairRuntimeOverrides;
  env: NodeJS.ProcessEnv;
}): Promise<RepairLocationPayload> {
  const { state } = options;
  const location = state.location;
  if (location.scope !== 'project') {
    throw new Error('--adopt-existing 只适用于 project scope。');
  }
  if (!state.projection.adoptExistingAvailable) {
    const identityRead = state.evidence.projectSharedIdentity.read;
    if (identityRead && identityRead.status !== 'ok' && identityRead.status !== 'missing') {
      throw new Error(
        `${location.plugin} 的 project artifact shared identity 已损坏，repair --adopt-existing 不会覆盖共享文件。请先运行 aw status --verbose、aw cleanup 或 aw reinstall。`,
      );
    }
    if (state.evidence.adoptable.blockers.includes('artifactIdentityUnverifiable')) {
      throw new Error(
        `${location.plugin} 的共享 artifacts 归属无法验证，或 shared file marker 无法安全定位，repair --adopt-existing 不会静默覆盖共享文件。请先运行 aw status --verbose、aw cleanup 或 aw reinstall。`,
      );
    }
    if (state.evidence.residualEvidence.repoVisibleArtifactPresent) {
      throw new Error(
        `${location.plugin} 当前只有不可认领的残留 artifacts，repair --adopt-existing 不会覆盖共享文件。请先运行 aw cleanup 或 aw reinstall。`,
      );
    }
    throw new Error(`${location.plugin} 当前没有可认领的 project artifacts。`);
  }
  const currentPlugin = state.target.currentPlugin;
  if (!currentPlugin) {
    throw new Error(
      `${location.plugin} 当前不在 current catalog 中，无法执行 adopt-existing。请先恢复 catalog，或改用 aw cleanup。`,
    );
  }
  const source = await buildCurrentCatalogSource(currentPlugin);
  await assertProjectArtifactIdentityPathVisible({
    cwd: options.repairOptions.cwd,
    pluginName: location.plugin,
    platform: location.platform,
    projectKey: location.projectKey,
  });
  const warnings = await ensureProjectRepairPrivateState({
    cwd: options.repairOptions.cwd,
    location,
  });
  const adapters = createAdapters(
    options.repairOptions.cwd,
    createCommandExecutionContext(options.runtime),
  );
  const requestedPreference = options.repairOptions.requestedSkillTrigger ?? 'default';
  await preflightRepairSharedRuntimeOwner({
    location,
    preference: requestedPreference,
    repairOptions: options.repairOptions,
    env: options.env,
  });
  const generatedArtifacts = await adapters[location.platform].installExtensions(
    currentPlugin,
    location.scope,
    {
      event: 'install',
      skillTriggerPreference: requestedPreference,
    },
  );
  const lifecycleResult = await maybeExecuteInstallLifecycle({
    plugin: currentPlugin,
    location,
    cwd: options.repairOptions.cwd,
    runtime: options.runtime,
    scriptTimeoutMs: options.repairOptions.scriptTimeoutMs,
  });
  const runtimeStage = await maybeStageHistoricalLifecycle({
    cwd: options.repairOptions.cwd,
    location,
    plugin: currentPlugin,
    source,
    previousRecord: null,
    env: options.env,
  });
  const recordFile = createRecordFile({
    location,
    source,
    artifacts: generatedArtifacts,
    updatedAt: new Date().toISOString(),
    lifecycle: runtimeStage?.runtimeRef,
    requestedSkillTrigger: options.repairOptions.requestedSkillTrigger,
  });
  const repoRoot = resolveProjectScopeRepoRoot(options.repairOptions.cwd);
  const projectRoot = resolveProjectArtifactProjectRoot(options.repairOptions.cwd, location);
  const stages = [];
  if (runtimeStage) {
    stages.push(runtimeStage);
  }
  stages.push(await createProjectArtifactIdentityWriteStage({
    repoRoot,
    locator: createProjectArtifactSharedLocator({
      plugin: location.plugin,
      platform: location.platform,
      repoRoot,
      projectRoot,
    }),
    value: rewriteProjectIdentityId(createProjectIdentityFile({
      plugin: currentPlugin,
      location,
      repoRoot,
      projectRoot,
      source,
      artifacts: generatedArtifacts,
      generatedAt: recordFile.record.updatedAt,
    })),
  }));
  stages.push(await createDynamicArtifactDiagnosticCacheWriteStage({
    cwd: options.repairOptions.cwd,
    location,
    value: createDynamicDiagnosticCacheValue({
      recordFile,
      location,
      artifacts: generatedArtifacts,
    }),
    currentRecord: recordFile,
    env: options.env,
  }));
  const recordPath = path.join(
    getInstallStatePrivateRoot(options.repairOptions.cwd, location, options.env),
    'records',
    `${recordFile.recordId}.json`,
  );
  stages.push(await createInstallRecordWriteStage({
    filePath: recordPath,
    value: recordFile,
    env: options.env,
  }));
  const sharedRuntimeOwnerStage = await maybeCreateSharedRuntimeOwnerStage({
    location,
    recordFile,
    recordPath,
    preference: recordFile.record.options?.skillTriggerPreference ?? 'default',
    repairOptions: options.repairOptions,
    env: options.env,
  });
  if (sharedRuntimeOwnerStage) {
    stages.push(sharedRuntimeOwnerStage);
  }
  const result = await runInstallStateGraphRecordTransaction({
    mode: 'upsert',
    stages,
    recordFile,
    recordPath,
    env: options.env,
  });
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    action: 'adoptExisting',
    changed: {
      record: true,
      dynamicDiagnosticCache: true,
      projectIdentity: true,
      historicalLifecycleRuntime: runtimeStage !== null,
      dependencyIndex: true,
      nativeMarkerDeleted: false,
      artifactsReapplied: true,
      nativeInstallReplayed: false,
      lifecycleExecuted: lifecycleResult.executed,
    },
    ...buildRepairLocationDetails(state),
    triggerPreferenceApplied: recordFile.record.options?.skillTriggerPreference ?? null,
    dynamicArtifacts: summarizeDynamicArtifacts(generatedArtifacts),
    ...(lifecycleResult.reason === 'adoptExistingFirstLocalRecord'
      ? { adoptExistingLifecycleReason: 'adoptExistingFirstLocalRecord' as const }
      : {}),
    ...(lifecycleResult.reason === 'noInstallLifecycleDeclared'
      ? { adoptExistingLifecycleSkippedReason: 'noInstallLifecycleDeclared' as const }
      : {}),
    warnings: [...warnings, ...result.warnings],
  };
}

function renderHumanOutput(payload: RepairJsonPayload): string {
  if (payload.dependencyIndexMode && payload.dependencyIndex) {
    const coverage = payload.dependencyIndex.coverage;
    const lines = ['修复完成'];
    lines.push(`- 依赖关系索引：已重建 ${payload.dependencyIndex.rebuiltEntries.length} 条可验证记录`);
    if (payload.dependencyIndex.rebuiltEntries.length > 0) {
      lines.push(`- 已重建位置：${payload.dependencyIndex.rebuiltEntries
        .map((entry) => `${entry.plugin}(${entry.platform}/${entry.scope})`)
        .join('，')}`);
    }
    if (payload.dependencyIndex.preservedEntries.length > 0) {
      lines.push(`- 仍保留 ${payload.dependencyIndex.preservedEntries.length} 条需要你显式处理的项目引用`);
    }
    if (!coverage.coverageTrusted) {
      lines.push(`- 覆盖范围仍不完整：${coverage.reasons.join('、') || 'unknown'}`);
      if (coverage.revisitProjectLocations.length > 0) {
        lines.push(`- 需要回访的位置：${coverage.revisitProjectLocations.map((location) => `${location.plugin}:${location.projectKey ?? '.'}`).join('，')}`);
      } else if (coverage.recoverySuggestion === 'revisitRelatedProjects') {
        lines.push('- 还需要回到可能相关的仓库重新运行 status --verbose 或 repair。');
      }
    }
    return lines.join('\n');
  }

  const lines = ['修复结果'];
  for (const location of payload.locations) {
    lines.push(`- ${location.plugin}`);
    lines.push(`  位置：${renderLocationLabel(location)}`);
    if (location.action === 'recordMarkerClosure') {
      lines.push('  处理：已收口上次未完成的原生安装状态。');
    } else if (location.action === 'markerOnlyRepair') {
      lines.push('  处理：已按当前目录重新补齐安装状态。');
    } else if (location.action === 'adoptExisting') {
      lines.push('  处理：已认领并重写当前仓库里的共享产物。');
    } else {
      lines.push('  处理：已按当前目录重新应用受管内容。');
    }
    const changes: string[] = [];
    if (location.changed.artifactsReapplied) {
      changes.push('当前仓库文件');
    }
    if (location.changed.record) {
      changes.push('安装记录');
    }
    if (location.changed.dynamicDiagnosticCache) {
      changes.push('诊断缓存');
    }
    if (location.changed.projectIdentity) {
      changes.push('共享身份文件');
    }
    if (location.changed.historicalLifecycleRuntime) {
      changes.push('历史 lifecycle 运行面');
    }
    if (location.changed.dependencyIndex) {
      changes.push('依赖关系索引');
    }
    if (location.changed.nativeMarkerDeleted) {
      changes.push('原生事务标记');
    }
    lines.push(`  更新：${changes.length > 0 ? changes.join('、') : '没有额外状态变更'}`);
    if (location.adoptExistingLifecycleReason) {
      lines.push('  说明：这是当前机器第一次为这个 project location 建立本机记录，所以补跑了 install lifecycle。');
    }
    if (location.adoptExistingLifecycleSkippedReason) {
      lines.push('  说明：当前插件没有声明 install lifecycle，因此这一步没有执行。');
    }
    if (location.nativeTransactionMarker.needsAttention) {
      lines.push(`  下一步：${location.nativeTransactionMarker.repairCommand}；${location.nativeTransactionMarker.cleanupCommand}`);
    }
    if (!location.dependencyIndexTrusted && location.dependencyIndexRecoveryMessage) {
      lines.push(`  提醒：${location.dependencyIndexRecoveryMessage}`);
    }
    if (location.warnings.length > 0) {
      lines.push(`  警告：${location.warnings.map((warning) => warning.message).join('；')}`);
    }
  }
  return lines.join('\n');
}

export async function repairCommand(
  pluginNames: string[],
  rawOptions: RawRepairCommandOptions = {},
  runtime: CommandExecutionContextInput = {},
): Promise<{
  output: string;
  payload: RepairJsonPayload;
}> {
  const options = normalizeRepairCommandOptions(rawOptions);
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const overrides = runtime as RepairRuntimeOverrides;

  if (options.dependencyIndex) {
    if (options.adoptExisting) {
      throw new Error('--dependency-index 不能与 --adopt-existing 一起使用。');
    }
    const dependencyIndex = await runDependencyIndexRepair({
      cwd: options.cwd,
      env,
    });
    const payload: RepairJsonPayload = {
      ok: true,
      command: 'repair',
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      generatedAt: new Date().toISOString(),
      dependencyIndexMode: true,
      targetResults: [],
      locations: [],
      dependencyIndex,
    };
    return {
      output: options.json ? JSON.stringify(payload, null, 2) : renderHumanOutput(payload),
      payload,
    };
  }

  if (pluginNames.length === 0) {
    throw new Error('repair 命令至少需要一个插件名，或显式传入 --dependency-index。');
  }

  const collected = await collectP7Locations(pluginNames, {
    cwd: options.cwd,
    scope: options.scope,
    platform: options.platform,
  }, runtime);
  if (collected.locations.length === 0) {
    throw new Error('没有找到可修复的插件位置。');
  }

  const writableStates = options.adoptExisting
    ? collected.locations.filter((state) =>
      state.location.scope === 'project' && state.projection.adoptExistingAvailable
    )
    : collected.locations.filter((state) =>
      state.evidence.installRecord.present ||
      state.evidence.nativeTransaction.classification === 'markerOnlyInstall'
    );
  const repairStates = options.platform === 'both'
    ? writableStates
    : collected.locations;
  if (repairStates.length === 0) {
    throw new Error('没有找到可修复的插件位置。');
  }
  await assertNoDuplicateInstalls({
    cwd: options.cwd,
    locations: repairStates
      .filter((state) =>
        shouldEnforceDuplicateInstallPreflight({
          location: toCommandPluginLocation(state.location),
          plugin: state.target.currentPlugin ?? state.target.historicalPlugin ?? null,
        }))
      .map((state) => toCommandPluginLocation(state.location)),
    env,
  });

  const locations: RepairLocationPayload[] = [];
  for (const state of repairStates) {
    if (options.adoptExisting) {
      locations.push(await adoptExistingLocation({
        state,
        repairOptions: options,
        runtime: overrides,
        env,
      }));
      continue;
    }

    if (state.evidence.installRecord.present) {
      locations.push(await repairInstalledLocation({
        state,
        repairOptions: options,
        runtime: overrides,
        env,
      }));
      continue;
    }

    if (state.evidence.nativeTransaction.classification === 'markerOnlyInstall') {
      locations.push(await repairMarkerOnlyLocation({
        state,
        repairOptions: options,
        runtime: overrides,
        env,
      }));
      continue;
    }

    if (state.location.scope === 'project' && state.projection.adoptExistingAvailable) {
      throw new Error(
        `${state.location.plugin} 在 ${renderLocationLabel(state.location)} 处于可认领状态；普通 repair 不会自动接管。请改用 aw repair ${state.location.plugin} --platform ${state.location.platform} --scope ${state.location.scope} --adopt-existing。`,
      );
    }

    throw new Error(
      `${state.location.plugin} 当前没有可信 install record，也不是 marker-only repair 场景。请先运行 aw cleanup 或重新安装。`,
    );
  }

  const payload: RepairJsonPayload = {
    ok: true,
    command: 'repair',
    receiptSchemaVersion: 2,
    overallState: 'succeeded',
    generatedAt: new Date().toISOString(),
    dependencyIndexMode: false,
    targetResults: buildRepairTargetResults(locations),
    locations,
  };
  return {
    output: options.json ? JSON.stringify(payload, null, 2) : renderHumanOutput(payload),
    payload,
  };
}
