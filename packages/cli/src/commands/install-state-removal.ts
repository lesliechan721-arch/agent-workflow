import path from 'node:path';

import fs from 'fs-extra';

import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import {
  createAdapters,
  createHistoricalPluginTarget,
  type ResolvedPluginTarget,
} from './common.js';
import { runLifecycleScript, type LifecycleProcessRunner } from '../utils/plugin-scripts.js';
import {
  buildDerivedGlobalDependencyIndex,
  readInstallRecordFileAt,
  readInstallRecordForLocation,
  inspectGlobalDependencyIndex,
  writeGlobalDependencyIndex,
} from '../install-state/facade.js';
import type {
  DependencyIndexReferenceInspection,
  HistoricalLifecycleRuntimeRef,
  InstallRecordArtifact,
  InstallRecordFile,
  PluginLocation,
} from '../install-state/types.js';
import { collectInstallEvidence, type InstallEvidence } from '../install-state/evidence.js';
import {
  projectInstallState,
  type ProjectInstallStateProjection,
} from '../install-state/status-projection.js';
import {
  createDependencyIndexRefreshPostCommitAction,
  createInstallRecordDeleteStage,
  createNativeTransactionMarkerDeleteStage,
  createPathDeleteStage,
  createProjectArtifactIdentityDeleteStage,
  createSharedRuntimeOwnerDeleteStage,
  InstallStateTransactionError,
  runInstallStateGraphRecordTransaction,
  runInstallStateTransaction,
  type InstallStateReceiptWarning,
  type InstallStateTransactionPostCommitAction,
  type InstallStateTransactionStage,
} from '../install-state/transactions.js';
import {
  createSharedSkillTriggerRuntimeMaterializationStage,
  createSharedSkillTriggerRuntimeRemovalStages,
  inspectSharedSkillTriggerRuntimeOwner,
  loadVerifiedHistoricalBundlePlugin,
  planSharedSkillTriggerRuntimeOwnerRemoval,
  readDerivedSharedSkillTriggerRuntimeOwner,
  type SharedSkillTriggerRuntimeStageBundle,
} from '../install-state/shared-runtime-owner.js';
import {
  buildHistoricalLifecycleRuntimeCoverage,
  garbageCollectHistoricalLifecycleRuntimes,
} from '../install-state/runtime-state.js';
import {
  createHistoricalLifecycleScopeKey,
  createRecordId,
} from '../install-state/ids.js';
import {
  getDiagnosticCachePath,
  getGlobalDependencyIndexPath,
  getInstallRecordPath,
  getInstallStatePrivateRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginLocation as LedgerPluginLocation,
  PluginMeta,
  Scope,
} from '../types.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  tryResolveEmbeddedPluginsRoot,
} from '../utils/paths.js';
import {
  getTrackingRecord,
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  normalizeSharedNativeRefs,
  readInstalledLedger,
} from '../utils/local-marketplace.js';
import { serializePluginLocation } from '../utils/plugin-dependency-location.js';
import { resolveSkillTriggerPolicies } from '../utils/skill-trigger-preferences.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import { sha256Hex } from '../install-state/internal.js';

export interface InstallStateRemovalRuntime extends CommandExecutionContextInput {
  adapters?: Record<PlatformName, PlatformAdapter>;
  lifecycleRunner?: LifecycleProcessRunner;
}

export interface InstallStateRemovalResult {
  warnings: string[];
  repoManagedArtifacts: GeneratedArtifact[];
}

export interface InstallStateCleanupExecutionItem {
  kind: string;
  label: string;
  path?: string;
  detail?: string;
}

export interface InstallStateCleanupResult extends InstallStateRemovalResult {
  summary: string;
  skippedItems: InstallStateCleanupExecutionItem[];
  failedItems: InstallStateCleanupExecutionItem[];
}

export interface InstallStatePruneResult {
  warnings: string[];
  pruneToken: string;
  action: 'retired' | 'skipped';
  skippedReason?: string;
  retiredEntries: Array<{
    location: PluginLocation;
    recordPath: string;
  }>;
}

interface RemovalDependencyProtection {
  allowed: boolean;
  blockedDependents: PluginLocation[];
  failClosedReason?: string;
  failClosedCode?:
    | 'dependencyIndexMissing'
    | 'dependencyIndexInvalid'
    | 'dependencyIndexCoverageUntrusted';
}

export interface InstallStateRemovalProtection {
  allowed: boolean;
  blockedDependents: PluginLocation[];
  failClosedReason?: string;
  failClosedCode?:
    | 'dependencyIndexMissing'
    | 'dependencyIndexInvalid'
    | 'dependencyIndexCoverageUntrusted';
}

export interface InstallStateCleanupSafety {
  protectedCodexUserNativeCleanup: boolean;
  skipExternalNativeItems: boolean;
  skipClaimableProjectArtifacts: boolean;
  sharedRuntimeOwnerConflict: boolean;
}

interface ProtectedRecordEntry {
  location: PluginLocation;
  dependencyEdges: InstallRecordFile['record']['dependencyEdges'];
}

function formatCommandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameLocation(left: PluginLocation, right: PluginLocation): boolean {
  return left.plugin === right.plugin
    && left.platform === right.platform
    && left.scope === right.scope
    && (left.projectKey ?? null) === (right.projectKey ?? null);
}

function toLedgerPluginLocation(location: PluginLocation): LedgerPluginLocation {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.scope === 'project' ? (location.projectKey ?? null) : null,
  };
}

function serializeComparableLocation(location: PluginLocation): string {
  return serializePluginLocation(toLedgerPluginLocation(location));
}

function isPureCodexUserNativeResidueForCleanup(evidence: InstallEvidence): boolean {
  return evidence.location.platform === 'codex'
    && evidence.location.scope === 'user'
    && !evidence.installRecord.present
    && !evidence.nativeTransaction.present
    && evidence.platform.codexNative !== null
    && evidence.platform.codexNative.anyNativeEvidence
    && !evidence.residualEvidence.privateStatePresent
    && !evidence.residualEvidence.repoVisibleArtifactPresent
    && !evidence.residualEvidence.sharedIdentityPresent
    && !evidence.residualEvidence.historicalLifecyclePresent
    && !evidence.residualEvidence.nativeMarkerPresent
    && !evidence.residualEvidence.sharedOwnerPresent;
}

function dedupeLocations(locations: PluginLocation[]): PluginLocation[] {
  const deduped = new Map<string, PluginLocation>();
  for (const location of locations) {
    deduped.set(renderLocation(location), location);
  }
  return [...deduped.values()];
}

function renderLocation(location: PluginLocation): string {
  return location.scope === 'project'
    ? `${location.platform}/${location.plugin}/project:${location.projectKey ?? '(missing-project-key)'}`
    : `${location.platform}/${location.plugin}/user`;
}

function createMaterializationTarget(
  platform: PlatformName,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv,
):
  | { platform: 'codex'; scope: 'user'; kind: 'localMarketplaceRuntime'; root: string }
  | { platform: 'codex'; scope: 'project'; kind: 'repoSkill'; root: string }
  | { platform: 'claude'; scope: Scope; kind: 'localMarketplaceRuntime'; root: string } {
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

function resolveTrackingDir(
  cwd: string,
  location: PluginLocation,
  env: NodeJS.ProcessEnv,
): string {
  return location.platform === 'claude'
    ? resolveClaudePaths(cwd, location.scope, env).trackingDir
    : resolveCodexPaths(cwd, location.scope, env).trackingDir;
}

function toGeneratedArtifact(
  artifact: InstallRecordArtifact,
): GeneratedArtifact {
  return {
    path: artifact.path,
    kind: artifact.kind,
    platform: artifact.platform,
    ...(artifact.paths ? { paths: [...artifact.paths] } : {}),
    ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
    ...(artifact.hookGroups ? { hookGroups: structuredClone(artifact.hookGroups) } : {}),
    ...(artifact.id ? { id: artifact.id } : {}),
    ...(artifact.target ? { target: artifact.target } : {}),
    ...(artifact.roleKey ? { roleKey: artifact.roleKey } : {}),
    ...(artifact.state ? { state: artifact.state } : {}),
    ...(artifact.configDigest ? { configDigest: artifact.configDigest } : {}),
    ...(artifact.contentDigest
      ? { contentDigest: artifact.contentDigest }
      : artifact.ownershipMarker
        ? { contentDigest: artifact.ownershipMarker }
        : {}),
  };
}

async function listReadableScopedRecords(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<ProtectedRecordEntry[]> {
  const recordsDir = path.join(
    getInstallStatePrivateRoot(options.cwd, options.location, options.env),
    'records',
  );
  if (!(await fs.pathExists(recordsDir))) {
    return [];
  }
  const entries = (await fs.readdir(recordsDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const output: ProtectedRecordEntry[] = [];
  for (const entry of entries) {
    const recordPath = path.join(recordsDir, entry);
    const recordRead = await readInstallRecordFileAt(recordPath, { env: options.env });
    if (recordRead.status !== 'ok') {
      continue;
    }
    output.push({
      location: {
        plugin: recordRead.value.record.pluginName,
        platform: recordRead.value.record.platform,
        scope: recordRead.value.record.scope,
        ...(recordRead.value.record.scope === 'project'
          ? { projectKey: recordRead.value.record.projectKey ?? null }
          : {}),
      },
      dependencyEdges: recordRead.value.record.dependencyEdges,
    });
  }
  return output;
}

async function collectVisibleInstallRecordsForDependencyIndex(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<Array<{ recordFile: InstallRecordFile; recordPath: string }>> {
  const locations: PluginLocation[] = [
    {
      plugin: '__unused__',
      platform: 'codex',
      scope: 'user',
    },
    {
      plugin: '__unused__',
      platform: 'claude',
      scope: 'user',
    },
  ];

  if (options.location.scope === 'project') {
    locations.push(
      {
        plugin: '__unused__',
        platform: 'codex',
        scope: 'project',
        projectKey: options.cwd,
      },
      {
        plugin: '__unused__',
        platform: 'claude',
        scope: 'project',
        projectKey: options.cwd,
      },
    );
  } else {
    locations.push(
      {
        plugin: '__unused__',
        platform: 'codex',
        scope: 'project',
        projectKey: await resolveProjectKeyForPlatform('codex', options.cwd),
      },
      {
        plugin: '__unused__',
        platform: 'claude',
        scope: 'project',
        projectKey: await resolveProjectKeyForPlatform('claude', options.cwd),
      },
    );
  }

  const output: Array<{ recordFile: InstallRecordFile; recordPath: string }> = [];
  const seen = new Set<string>();

  for (const pseudoLocation of locations) {
    const recordsDir = path.join(
      getInstallStatePrivateRoot(options.cwd, pseudoLocation, options.env),
      'records',
    );
    if (!(await fs.pathExists(recordsDir))) {
      continue;
    }
    const entries = (await fs.readdir(recordsDir))
      .filter((entry) => entry.endsWith('.json'))
      .sort();
    for (const entry of entries) {
      const recordPath = path.join(recordsDir, entry);
      const read = await readInstallRecordFileAt(recordPath, { env: options.env });
      if (read.status !== 'ok') {
        continue;
      }
      const dedupeKey = `${recordPath}\u0000${read.value.recordId}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      output.push({
        recordFile: read.value,
        recordPath,
      });
    }
  }

  return output;
}

async function listLocallyVisibleReadableRecords(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<ProtectedRecordEntry[]> {
  const records = await listReadableScopedRecords(options);
  if (options.location.scope !== 'user') {
    return records;
  }

  const projectRecords = await listReadableScopedRecords({
    ...options,
    location: {
      plugin: options.location.plugin,
      platform: options.location.platform,
      scope: 'project',
      projectKey: await resolveProjectKeyForPlatform(options.location.platform, options.cwd),
    },
  });
  const deduped = new Map<string, ProtectedRecordEntry>();
  for (const record of [...records, ...projectRecords]) {
    deduped.set(renderLocation(record.location), record);
  }
  return [...deduped.values()];
}

function isRelevantIndexReference(
  target: PluginLocation,
  reference: DependencyIndexReferenceInspection,
): boolean {
  if (target.scope === 'user') {
    return true;
  }
  return reference.location.scope === 'project'
    && reference.location.projectKey === target.projectKey;
}

async function analyzeRemovalDependencyProtection(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<RemovalDependencyProtection> {
  const localRecords = await listLocallyVisibleReadableRecords(options);
  const localBlockedDependents = dedupeLocations(localRecords
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) =>
      entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location));

  const inspection = await inspectGlobalDependencyIndex(options.env);
  const derivedIndex = await buildDerivedGlobalDependencyIndex({
    recordEntries: await collectVisibleInstallRecordsForDependencyIndex(options),
    env: options.env,
  });

  const effectiveRecords = inspection.status === 'ok'
    ? [
        ...inspection.value.records
          .filter((entry, index) => inspection.references[index]?.status === 'verified'),
        ...derivedIndex.rebuiltEntries.filter((entry) =>
          !inspection.value.records.some((existing, index) =>
            inspection.references[index]?.status === 'verified'
            && existing.recordPath === entry.recordPath
            && serializeComparableLocation(existing.location) === serializeComparableLocation(entry.location))),
      ]
    : derivedIndex.rebuiltEntries;
  const effectiveReferenceStatusByIdentity = new Map<string, DependencyIndexReferenceInspection['status']>();
  if (inspection.status === 'ok') {
    for (const [index, reference] of inspection.references.entries()) {
      const record = inspection.value.records[index];
      if (!record) {
        continue;
      }
      effectiveReferenceStatusByIdentity.set(
        `${record.recordPath}\u0000${serializeComparableLocation(record.location)}`,
        reference.status,
      );
    }
  }
  for (const record of derivedIndex.rebuiltEntries) {
    effectiveReferenceStatusByIdentity.set(
      `${record.recordPath}\u0000${serializeComparableLocation(record.location)}`,
      'verified',
    );
  }

  if (inspection.status !== 'ok' && derivedIndex.rebuiltEntries.length === 0) {
    return options.location.scope === 'user'
      ? {
          allowed: false,
          blockedDependents: localBlockedDependents,
          failClosedCode: inspection.status === 'missing'
            ? 'dependencyIndexMissing'
            : 'dependencyIndexInvalid',
          failClosedReason: inspection.status === 'missing'
            ? 'dependency index 缺失，无法安全确认其它 scope 是否仍在引用该插件。'
            : `dependency index 已损坏：${inspection.error}`,
        }
      : {
          allowed: localBlockedDependents.length === 0,
          blockedDependents: localBlockedDependents,
        };
  }

  const verifiedIndexDependents = effectiveRecords
    .filter((entry) =>
      effectiveReferenceStatusByIdentity.get(
        `${entry.recordPath}\u0000${serializeComparableLocation(entry.location)}`,
      ) === 'verified')
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) =>
      entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location);
  const blockedDependents = dedupeLocations([
    ...localBlockedDependents,
    ...verifiedIndexDependents,
  ]);

  const coverageIssue = [...effectiveReferenceStatusByIdentity.entries()].some(([identity, status]) => {
    if (status === 'verified') {
      return false;
    }
    const record = effectiveRecords.find((entry) =>
      `${entry.recordPath}\u0000${serializeComparableLocation(entry.location)}` === identity);
    return record
      ? isRelevantIndexReference(options.location, {
          recordPath: record.recordPath,
          location: record.location,
          status,
        })
      : false;
  });

  if (
    options.location.scope === 'user'
    && [...effectiveReferenceStatusByIdentity.values()].some((status) => status !== 'verified')
  ) {
    return {
      allowed: false,
      blockedDependents,
      failClosedCode: 'dependencyIndexCoverageUntrusted',
      failClosedReason: 'dependency index 覆盖范围不可信，当前无法安全删除 user-scope 插件。',
    };
  }

  if (coverageIssue) {
    return {
      allowed: false,
      blockedDependents,
      failClosedCode: 'dependencyIndexCoverageUntrusted',
      failClosedReason: `当前 projectKey=${options.location.projectKey ?? '(missing-project-key)'} 的 dependency index 覆盖范围不可信，无法安全删除该 project-scope 插件。`,
    };
  }

  return {
    allowed: blockedDependents.length === 0,
    blockedDependents,
  };
}

async function removeLifecycleRuntimeGc(options: {
  env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const inspection = await inspectGlobalDependencyIndex(options.env);
  if (inspection.status !== 'ok') {
    const result = await garbageCollectHistoricalLifecycleRuntimes({
      env: options.env,
      coverage: {
        trusted: false,
        verifiedRecordPaths: [],
        reason: inspection.status === 'missing'
          ? 'dependency index missing'
          : `dependency index corrupted: ${inspection.error}`,
      },
    });
    return result.status === 'skipped' ? result.reason ?? 'historical lifecycle GC skipped' : null;
  }

  if (inspection.references.some((reference) => reference.status !== 'verified')) {
    const result = await garbageCollectHistoricalLifecycleRuntimes({
      env: options.env,
      coverage: {
        trusted: false,
        verifiedRecordPaths: [],
        reason: 'dependency index coverage is incomplete',
      },
    });
    return result.status === 'skipped' ? result.reason ?? 'historical lifecycle GC skipped' : null;
  }

  const verifiedRecords = await Promise.all(
    inspection.value.records.map(async (entry) => {
      const read = await readInstallRecordFileAt(entry.recordPath, { env: options.env });
      return {
        path: entry.recordPath,
        value: read.status === 'ok' ? read.value : null,
      };
    }),
  );
  const usableRecords = verifiedRecords
    .filter((entry): entry is { path: string; value: InstallRecordFile } => entry.value !== null);
  const coverage = await buildHistoricalLifecycleRuntimeCoverage({
    verifiedRecords: usableRecords.map((entry) => ({
      path: entry.path,
      value: entry.value,
    })),
  });
  const gc = await garbageCollectHistoricalLifecycleRuntimes({
    env: options.env,
    coverage,
  });
  return gc.status === 'skipped' ? gc.reason ?? 'historical lifecycle GC skipped' : null;
}

async function loadPreferredPluginMeta(options: {
  target?: ResolvedPluginTarget | null;
  recordFile?: InstallRecordFile | null;
}): Promise<PluginMeta | null> {
  const lifecycle = options.recordFile?.record.lifecycle;
  if (lifecycle) {
    const verified = await loadVerifiedHistoricalBundlePlugin({
      pluginName: options.recordFile!.record.pluginName,
      pluginVersion: lifecycle.pluginVersion,
      runtimeRoot: lifecycle.runtimeRoot,
      bundleRoot: lifecycle.bundleRoot,
      manifestPath: lifecycle.manifestPath,
      sourceManifestDigest: lifecycle.sourceManifestDigest,
      bundleFingerprint: lifecycle.bundleFingerprint,
    });
    if (verified.status === 'ok') {
      return verified.plugin;
    }
  }
  if (options.target?.currentPlugin) {
    return options.target.currentPlugin;
  }
  if (options.target?.plugin) {
    return options.target.plugin;
  }
  return null;
}

async function loadProtectedCodexUserCleanupPluginMeta(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  ledgerPluginSharedNativeRefs: unknown;
  target?: ResolvedPluginTarget | null;
  recordFile?: InstallRecordFile | null;
  anyNativeEvidence: boolean;
}): Promise<PluginMeta | null> {
  const preferred = await loadPreferredPluginMeta(options);
  if (preferred) {
    return preferred;
  }

  const sharedNativeRefs = normalizeSharedNativeRefs(
    options.ledgerPluginSharedNativeRefs,
  );
  const needsProtectedCleanup = Boolean(
    sharedNativeRefs?.user === true || (sharedNativeRefs?.projects.length ?? 0) > 0,
  );
  if (!needsProtectedCleanup) {
    return null;
  }

  const historicalTarget = await createHistoricalPluginTarget(
    options.cwd,
    'user',
    options.pluginName,
    options.target?.embeddedPlugin,
    options.env,
    await readInstalledLedger(options.env),
    {
      codexNativeManifestPlaceholder: options.anyNativeEvidence,
    },
  );
  return historicalTarget.plugin;
}

async function resolveProjectKeyForPlatform(
  platform: PlatformName,
  cwd: string,
): Promise<string> {
  return platform === 'claude'
    ? await resolveClaudeProjectKey(cwd)
    : await resolveCodexProjectKey(cwd);
}

async function createLocationForTarget(options: {
  target: ResolvedPluginTarget;
  platform: PlatformName;
  commandOptions: CommandOptions;
}): Promise<PluginLocation> {
  return {
    plugin: options.target.pluginName,
    platform: options.platform,
    scope: options.commandOptions.scope,
    ...(options.commandOptions.scope === 'project'
      ? { projectKey: await resolveProjectKeyForPlatform(options.platform, options.commandOptions.cwd) }
      : {}),
  };
}

type DefaultReplaySourceValidationResult =
  | {
    status: 'ok';
    sourcePluginRoot: string;
    plugin: PluginMeta;
  }
  | {
    status: 'noReplayRequired';
    reason: string;
  }
  | {
    status: 'invalid';
    reason: string;
  };

async function validateHistoricalLifecycleBundleForDefaultReplay(options: {
  location: PluginLocation;
  lifecycle?: HistoricalLifecycleRuntimeRef;
  currentPlugin?: PluginMeta;
}): Promise<DefaultReplaySourceValidationResult> {
  if (!options.lifecycle) {
    return {
      status: 'invalid',
      reason: '缺少 historical lifecycle bundle',
    };
  }

  const verified = await loadVerifiedHistoricalBundlePlugin({
    pluginName: options.location.plugin,
    pluginVersion: options.lifecycle.pluginVersion,
    runtimeRoot: options.lifecycle.runtimeRoot,
    bundleRoot: options.lifecycle.bundleRoot,
    manifestPath: options.lifecycle.manifestPath,
    sourceManifestDigest: options.lifecycle.sourceManifestDigest,
    bundleFingerprint: options.lifecycle.bundleFingerprint,
  });
  if (verified.status !== 'ok') {
    return verified;
  }

  if (!options.currentPlugin) {
    return {
      status: 'invalid',
      reason: '缺少当前 bundle 参照，无法判断 historical lifecycle bundle 是否过期',
    };
  }

  if (
    options.currentPlugin.manifest.name !== options.location.plugin ||
    options.currentPlugin.manifest.version !== options.lifecycle.pluginVersion
  ) {
    return {
      status: 'invalid',
      reason: `historical lifecycle version ${options.lifecycle.pluginVersion} 与当前 bundle version ${options.currentPlugin.manifest.version} 不一致`,
    };
  }

  let policyCount: number;
  try {
    const policyResolution = await resolveSkillTriggerPolicies({
      embeddedRoot: verified.bundleRoot,
      pluginName: options.location.plugin,
      platform: options.location.platform,
      policyPlugin: verified.plugin,
      sourcePluginRoot: verified.bundleRoot,
    });
    policyCount = policyResolution.policies.length;
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical lifecycle bundle 的 skill trigger policy 不可解析：${formatCommandError(error)}`,
    };
  }

  if (policyCount === 0) {
    return {
      status: 'noReplayRequired',
      reason: `historical lifecycle bundle 没有 ${options.location.platform} shared skill trigger runtime 需要重放`,
    };
  }

  if (!(await fs.pathExists(path.join(verified.bundleRoot, options.location.platform, 'skills')))) {
    return {
      status: 'invalid',
      reason: `historical lifecycle bundle 缺少 ${options.location.platform} skill source 子树`,
    };
  }

  return {
    status: 'ok',
    sourcePluginRoot: verified.bundleRoot,
    plugin: verified.plugin,
  };
}

async function createBestEffortSharedRuntimeRemovalStagesWithoutEmbeddedRoot(options: {
  location: PluginLocation;
  target:
    | { platform: 'codex'; scope: 'user'; kind: 'localMarketplaceRuntime'; root: string }
    | { platform: 'codex'; scope: 'project'; kind: 'repoSkill'; root: string }
    | { platform: 'claude'; scope: Scope; kind: 'localMarketplaceRuntime'; root: string };
  env: NodeJS.ProcessEnv;
  lifecycle?: HistoricalLifecycleRuntimeRef;
  currentPlugin?: PluginMeta;
  force?: boolean;
  error?: string;
}): Promise<SharedSkillTriggerRuntimeStageBundle> {
  const ownerInspection = await inspectSharedSkillTriggerRuntimeOwner({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
  });
  const ownerMatchesTarget = ownerInspection.read.status === 'ok'
    && sameLocation(ownerInspection.read.value.owner, options.location);

  if (!ownerMatchesTarget) {
    return {
      ownerAction: 'none',
      warnings: [],
      stages: [],
    };
  }

  const defaultReplaySource = await validateHistoricalLifecycleBundleForDefaultReplay({
    location: options.location,
    lifecycle: options.lifecycle,
    currentPlugin: options.currentPlugin,
  });
  const replayWarningPrefix =
    `[${renderLocation(options.location)}] embedded bundle 不可用，无法安全重放 shared skill trigger runtime default`;

  if (defaultReplaySource.status === 'noReplayRequired') {
    return {
      ownerAction: 'release',
      warnings: [],
      stages: [createSharedRuntimeOwnerDeleteStage({
        pluginName: options.location.plugin,
        platform: options.location.platform,
        env: options.env,
      })],
    };
  }

  if (defaultReplaySource.status !== 'ok') {
    const detail = `${replayWarningPrefix}：${defaultReplaySource.reason}.${options.error ? ` ${options.error}` : ''}`;
    if (options.force !== true) {
      throw new Error(`${detail} 如需跳过 runtime 重放并强制清理 owner，请加 --force。`);
    }

    return {
      ownerAction: 'release',
      warnings: [`${detail} 已因 --force 仅清理 owner。`],
      stages: [createSharedRuntimeOwnerDeleteStage({
        pluginName: options.location.plugin,
        platform: options.location.platform,
        env: options.env,
      })],
    };
  }

  const materialization = await createSharedSkillTriggerRuntimeMaterializationStage({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    preference: 'default',
    embeddedRoot: defaultReplaySource.sourcePluginRoot,
    sourcePluginRoot: defaultReplaySource.sourcePluginRoot,
    target: options.target,
    mode: 'bestEffortReplay',
  });
  const replayWarning =
    `[${renderLocation(options.location)}] embedded bundle 不可用，已使用 historical lifecycle bundle 重放 shared skill trigger runtime default.`
    + (options.error ? ` ${options.error}` : '');

  return {
    ownerAction: 'release',
    warnings: [
      replayWarning,
      ...materialization.warnings,
    ],
    stages: [
      materialization.stage,
      createSharedRuntimeOwnerDeleteStage({
        pluginName: options.location.plugin,
        platform: options.location.platform,
        env: options.env,
      }),
    ],
  };
}

function deriveLocationRuntimeRoot(
  location: PluginLocation,
  env: NodeJS.ProcessEnv,
): string {
  return path.join(
    resolveAwHome(env),
    'lifecycle-runtimes',
    location.platform,
    location.scope,
    createHistoricalLifecycleScopeKey(location),
    createRecordId(location),
  );
}

export async function tryUninstallUsingInstallState(options: {
  target: ResolvedPluginTarget;
  platform: PlatformName;
  commandOptions: CommandOptions & { force?: boolean };
  runtime: InstallStateRemovalRuntime;
}): Promise<{ handled: boolean; result?: InstallStateRemovalResult }> {
  const context = createCommandExecutionContext(options.runtime);
  const location = await createLocationForTarget({
    target: options.target,
    platform: options.platform,
    commandOptions: options.commandOptions,
  });
  const recordRead = await readInstallRecordForLocation({
    cwd: options.commandOptions.cwd,
    location,
    env: context.env,
  });
  if (recordRead.status === 'missing') {
    return { handled: false };
  }
  if (recordRead.status !== 'ok') {
    throw new Error(`${renderLocation(location)} 的 install record 不可读，请改用 aw cleanup。`);
  }

  const evidence = await collectInstallEvidence({
    cwd: options.commandOptions.cwd,
    location,
    env: context.env,
  });
  const projection = projectInstallState(evidence);
  if (projection.kind !== 'installed') {
    throw new Error(`${renderLocation(location)} 当前不是健康 installed 状态，请先运行 aw cleanup。`);
  }
  const protection = await analyzeRemovalDependencyProtection({
    cwd: options.commandOptions.cwd,
    location,
    env: context.env,
  });
  if (protection.blockedDependents.length > 0) {
    throw new Error(
      `${renderLocation(location)} 仍被以下 verified dependent 引用：${protection.blockedDependents.map(renderLocation).join('、')}。`,
    );
  }
  if (!protection.allowed) {
    throw new Error(protection.failClosedReason ?? 'dependency protection failed closed');
  }

  const verifiedHistoricalPlugin = recordRead.value.record.lifecycle
    ? await loadVerifiedHistoricalBundlePlugin({
        pluginName: recordRead.value.record.pluginName,
        pluginVersion: recordRead.value.record.lifecycle.pluginVersion,
        runtimeRoot: recordRead.value.record.lifecycle.runtimeRoot,
        bundleRoot: recordRead.value.record.lifecycle.bundleRoot,
        manifestPath: recordRead.value.record.lifecycle.manifestPath,
        sourceManifestDigest: recordRead.value.record.lifecycle.sourceManifestDigest,
        bundleFingerprint: recordRead.value.record.lifecycle.bundleFingerprint,
      })
    : null;

  if (recordRead.value.record.lifecycle) {
    if (!verifiedHistoricalPlugin || verifiedHistoricalPlugin.status !== 'ok') {
      throw new Error(
        `[reason=historicalRuntimeUnavailable] ${renderLocation(location)} 缺少可校验的 historical runtime，无法安全执行 uninstall lifecycle：${
          verifiedHistoricalPlugin?.reason ?? 'historical lifecycle runtime 不可验证'
        }。`,
      );
    }
    await runLifecycleScript({
      event: 'uninstall',
      pluginName: recordRead.value.record.pluginName,
      platform: location.platform,
      scope: location.scope,
      cwd: options.commandOptions.cwd,
      context,
      currentPlugin: verifiedHistoricalPlugin.plugin,
      artifacts: recordRead.value.record.artifacts.map(toGeneratedArtifact),
      scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
      runner: options.runtime.lifecycleRunner,
    });
  }

  const adapters = createAdapters(options.commandOptions.cwd, context);
  const pluginMeta = verifiedHistoricalPlugin?.status === 'ok'
    ? verifiedHistoricalPlugin.plugin
    : await loadPreferredPluginMeta({
        target: options.target,
        recordFile: recordRead.value,
      });
  if (!pluginMeta) {
    throw new Error(`无法为 ${renderLocation(location)} 加载卸载元数据。`);
  }
  if (adapters?.[location.platform]) {
    await adapters[location.platform]!.uninstallPlugin(pluginMeta, location.scope);
    await adapters[location.platform]!.uninstallExtensions(
      pluginMeta,
      location.scope,
      recordRead.value.record.artifacts.map(toGeneratedArtifact),
    );
  }

  const removalTarget = createMaterializationTarget(
    location.platform,
    location.scope,
    options.commandOptions.cwd,
    context.env,
  );
  const embeddedRootAttempt = await tryResolveEmbeddedPluginsRoot();
  const removalStages = embeddedRootAttempt.root
    ? await (async () => {
        const removalPlan = await planSharedSkillTriggerRuntimeOwnerRemoval({
          location,
          embeddedRoot: embeddedRootAttempt.root!,
          target: removalTarget,
          cwd: options.commandOptions.cwd,
          env: context.env,
        });
        return createSharedSkillTriggerRuntimeRemovalStages({
          plan: removalPlan,
          pluginName: location.plugin,
          platform: location.platform,
          embeddedRoot: embeddedRootAttempt.root!,
          target: removalTarget,
          env: context.env,
        });
      })()
    : await createBestEffortSharedRuntimeRemovalStagesWithoutEmbeddedRoot({
        location,
        target: removalTarget,
        env: context.env,
        lifecycle: recordRead.value.record.lifecycle,
        currentPlugin: options.target.currentPlugin ?? options.target.embeddedPlugin,
        force: options.commandOptions.force === true,
        error: embeddedRootAttempt.error,
      });
  const runtimeRoot = recordRead.value.record.lifecycle?.runtimeRoot;
  await runInstallStateGraphRecordTransaction({
    mode: 'delete',
    location,
    recordPath: recordRead.path,
    env: context.env,
    stages: [
      ...removalStages.stages,
      ...(evidence.projectSharedIdentity.read?.status === 'ok'
        ? [createProjectArtifactIdentityDeleteStage({ filePath: evidence.projectSharedIdentity.read.path })]
        : []),
      createPathDeleteStage({
        label: 'dynamic diagnostic cache',
        filePath: getDiagnosticCachePath(options.commandOptions.cwd, location, context.env),
        rollbackWarningCode: 'diagnosticCacheRollbackFailed',
        finalizeWarningCode: 'diagnosticCacheFinalizeFailed',
      }),
      ...(runtimeRoot
        ? [createPathDeleteStage({
            label: 'historical lifecycle runtime',
            filePath: runtimeRoot,
            rollbackWarningCode: 'historicalLifecycleRollbackFailed',
            finalizeWarningCode: 'historicalLifecycleFinalizeFailed',
          })]
        : []),
      createNativeTransactionMarkerDeleteStage({
        pluginNameOrId: location.plugin,
        env: context.env,
      }),
      createInstallRecordDeleteStage({ filePath: recordRead.path }),
    ],
  });
  const trackingDir = resolveTrackingDir(options.commandOptions.cwd, location, context.env);
  const trackingManifest = await readTrackingManifest(trackingDir);
  if (getTrackingRecord(trackingManifest, location.plugin)) {
    await writeTrackingManifest(
      trackingDir,
      removeTrackingRecordFromManifest(trackingManifest, location.plugin),
    );
  }

  const warnings = [...removalStages.warnings];
  const gcWarning = await removeLifecycleRuntimeGc({ env: context.env });
  if (gcWarning) {
    warnings.push(`[${renderLocation(location)}] lifecycle runtime GC 已 fail closed：${gcWarning}`);
  }

  return {
    handled: true,
    result: {
      warnings,
      repoManagedArtifacts: recordRead.value.record.artifacts.map(toGeneratedArtifact),
    },
  };
}

function cleanupItemKey(item: InstallStateCleanupExecutionItem): string {
  return [item.kind, item.path ?? '', item.label, item.detail ?? ''].join('\0');
}

function uniqueCleanupExecutionItems(
  items: InstallStateCleanupExecutionItem[],
): InstallStateCleanupExecutionItem[] {
  const deduped = new Map<string, InstallStateCleanupExecutionItem>();
  for (const item of items) {
    deduped.set(cleanupItemKey(item), item);
  }
  return [...deduped.values()];
}

async function collectSkippedCleanupItems(options: {
  evidence: InstallEvidence;
  protectedCodexUserNativeCleanup: boolean;
  skipExternalNativeItems: boolean;
  skipClaimableProjectArtifacts: boolean;
}): Promise<InstallStateCleanupExecutionItem[]> {
  const items: InstallStateCleanupExecutionItem[] = [];
  const codexNative = options.evidence.platform.codexNative;

  if (options.skipExternalNativeItems && codexNative) {
    const detail = '检测到外部或不可归属的 Codex native 内容，cleanup 未删除该原生条目。';
    if (await fs.pathExists(codexNative.configPath)) {
      items.push({
        kind: 'native-config',
        label: 'Codex enabled config',
        path: codexNative.configPath,
        detail,
      });
    }
    if (await fs.pathExists(codexNative.installedManifestPath)) {
      items.push({
        kind: 'native-manifest',
        label: 'Codex installed manifest',
        path: codexNative.installedManifestPath,
        detail,
      });
    }
    if (await fs.pathExists(codexNative.activeCacheRootPath)) {
      items.push({
        kind: 'native-cache',
        label: 'Codex active cache',
        path: codexNative.activeCacheRootPath,
        detail,
      });
    }
  }

  if (options.protectedCodexUserNativeCleanup && codexNative) {
    const detail = 'shared native refs 仍保护其它 project consumer，cleanup 未删除该原生条目。';
    const config = await readCodexConfigFile(codexNative.configPath);
    if (config.snapshot.plugins[codexNative.pluginId]?.enabled === true) {
      items.push({
        kind: 'native-config',
        label: 'Codex enabled config',
        path: codexNative.configPath,
        detail,
      });
    }
    if (await fs.pathExists(codexNative.installedManifestPath)) {
      items.push({
        kind: 'native-manifest',
        label: 'Codex installed manifest',
        path: codexNative.installedManifestPath,
        detail,
      });
    }
    if (await fs.pathExists(codexNative.activeCacheRootPath)) {
      items.push({
        kind: 'native-cache',
        label: 'Codex active cache',
        path: codexNative.activeCacheRootPath,
        detail,
      });
    }
  }

  if (options.skipClaimableProjectArtifacts) {
    const detail = '这些项目产物可通过 `aw install --adopt-existing` 认领，cleanup 默认保留。';
    if (
      options.evidence.projectSharedIdentity.read
      && options.evidence.projectSharedIdentity.read.status !== 'missing'
    ) {
      items.push({
        kind: 'project-artifact-identity',
        label: 'project artifact shared identity',
        path: options.evidence.projectSharedIdentity.read.path,
        detail,
      });
    }
    for (const artifact of options.evidence.projectSharedIdentity.artifacts) {
      if (!artifact.file.exists) {
        continue;
      }
      items.push({
        kind: 'repo-artifact',
        label: 'project residual artifact',
        path: artifact.file.path,
        detail,
      });
    }
  }

  if (
    options.evidence.sharedRuntimeOwner.read.status === 'ok'
    && !options.evidence.sharedRuntimeOwner.ownerMatchesTarget
  ) {
    items.push({
      kind: 'shared-runtime-owner',
      label: 'shared runtime owner',
      path: options.evidence.sharedRuntimeOwner.read.path,
      detail: `shared runtime owner 当前属于 ${renderLocation(options.evidence.sharedRuntimeOwner.read.value.owner)}，cleanup 未删除该 owner 文件。`,
    });
  }

  return uniqueCleanupExecutionItems(items);
}

async function collectProtectedCodexUserNativeSkippedItems(options: {
  protectedCodexUserNativeCleanup: boolean;
  evidence: InstallEvidence;
}): Promise<InstallStateCleanupExecutionItem[]> {
  if (!options.protectedCodexUserNativeCleanup) {
    return [];
  }

  const codexNative = options.evidence.platform.codexNative;
  if (!codexNative) {
    return [];
  }

  const detail = 'shared native refs 仍保护其它 project consumer，cleanup 未删除该原生条目。';
  const config = await readCodexConfigFile(codexNative.configPath);
  const items: InstallStateCleanupExecutionItem[] = [];

  if (config.snapshot.plugins[codexNative.pluginId]?.enabled === true) {
    items.push({
      kind: 'native-config',
      label: 'Codex enabled config',
      path: codexNative.configPath,
      detail,
    });
  }
  if (await fs.pathExists(codexNative.installedManifestPath)) {
    items.push({
      kind: 'native-manifest',
      label: 'Codex installed manifest',
      path: codexNative.installedManifestPath,
      detail,
    });
  }
  if (await fs.pathExists(codexNative.activeCacheRootPath)) {
    items.push({
      kind: 'native-cache',
      label: 'Codex active cache',
      path: codexNative.activeCacheRootPath,
      detail,
    });
  }

  return uniqueCleanupExecutionItems(items);
}

interface CleanupDeleteStageGroup {
  label: string;
  stages: InstallStateTransactionStage[];
  postCommit?: InstallStateTransactionPostCommitAction[];
  items?: InstallStateCleanupExecutionItem[];
}

function formatInstallStateWarning(
  location: PluginLocation,
  warning: InstallStateReceiptWarning,
): string {
  return `[${renderLocation(location)}] ${warning.message}`
    + `${warning.path ? ` (${warning.path})` : ''}`
    + `${warning.error ? `：${warning.error}` : ''}`;
}

async function runCleanupDeleteStageGroups(options: {
  location: PluginLocation;
  groups: CleanupDeleteStageGroup[];
}): Promise<{
  warnings: string[];
  failedItems: InstallStateCleanupExecutionItem[];
}> {
  const warnings: string[] = [];
  const failedItems: InstallStateCleanupExecutionItem[] = [];
  for (const group of options.groups) {
    if (group.stages.length === 0 && (group.postCommit?.length ?? 0) === 0) {
      continue;
    }
    try {
      const result = await runInstallStateTransaction({
        stages: group.stages,
        postCommit: group.postCommit,
      });
      warnings.push(...result.warnings.map((warning) => formatInstallStateWarning(options.location, warning)));
    } catch (error) {
      warnings.push(
        `[${renderLocation(options.location)}] cleanup 删除 ${group.label} 失败：${
          formatCommandError(error instanceof InstallStateTransactionError ? error.cause : error)
        }`,
      );
      failedItems.push(...(group.items ?? []));
      if (error instanceof InstallStateTransactionError) {
        warnings.push(...error.warnings.map((warning) => formatInstallStateWarning(options.location, warning)));
      }
    }
  }
  return {
    warnings,
    failedItems,
  };
}

export async function cleanupInstallStateTarget(options: {
  pluginName: string;
  location: PluginLocation;
  commandOptions: CommandOptions & { force?: boolean };
  runtime: InstallStateRemovalRuntime;
  target?: ResolvedPluginTarget | null;
  allowInstalled?: boolean;
}): Promise<InstallStateCleanupResult> {
  const context = createCommandExecutionContext(options.runtime);
  const evidence = await collectInstallEvidence({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: context.env,
  });
  const projection = projectInstallState(evidence);

  if (projection.kind === 'installed' && options.allowInstalled !== true) {
    throw new Error(`${renderLocation(options.location)} 当前健康已安装，请改用 aw uninstall。`);
  }

  const protection = await analyzeRemovalDependencyProtection({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: context.env,
  });
  if (protection.blockedDependents.length > 0) {
    throw new Error(
      `${renderLocation(options.location)} 仍被以下 verified dependent 引用：${protection.blockedDependents.map(renderLocation).join('、')}。`,
    );
  }

  const recordRead = await readInstallRecordForLocation({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: context.env,
  });
  const codexUserNativeEvidencePresent =
    options.location.platform === 'codex' &&
    options.location.scope === 'user' &&
    evidence.platform.codexNative?.anyNativeEvidence === true;
  const ledger = options.location.platform === 'codex' && options.location.scope === 'user'
    ? await readInstalledLedger(context.env)
    : null;
  const codexSharedNativeRefs = options.location.platform === 'codex' && options.location.scope === 'user'
    ? normalizeSharedNativeRefs(
        ledger?.plugins[options.pluginName]?.platforms.codex?.sharedNativeRefs,
      )
    : null;
  const protectedCodexUserNativeCleanup = Boolean(
    codexSharedNativeRefs?.user === true || (codexSharedNativeRefs?.projects.length ?? 0) > 0,
  );
  const skipExternalNativeItems =
    projection.kind === 'external' && !isPureCodexUserNativeResidueForCleanup(evidence);
  const skipClaimableProjectArtifacts = evidence.adoptable.possible;
  const pluginMeta = options.location.platform === 'codex' && options.location.scope === 'user'
    ? await loadProtectedCodexUserCleanupPluginMeta({
        cwd: options.commandOptions.cwd,
        env: context.env,
        pluginName: options.pluginName,
        ledgerPluginSharedNativeRefs: ledger?.plugins[options.pluginName]?.platforms.codex?.sharedNativeRefs,
        target: options.target,
        recordFile: recordRead.status === 'ok' ? recordRead.value : null,
        anyNativeEvidence: codexUserNativeEvidencePresent,
      })
    : await loadPreferredPluginMeta({
        target: options.target,
        recordFile: recordRead.status === 'ok' ? recordRead.value : null,
      });
  const platformAdapter = projection.kind === 'notInstalled'
    ? undefined
    : (context.adapters ?? context.adaptersFactory(options.commandOptions.cwd, context))[options.location.platform];
  const nativeCleanupAdapter = platformAdapter as PlatformAdapter & {
    uninstallUserNativePluginById?: (pluginNameOrId: string) => Promise<void>;
  } | undefined;
  const preferDirectCodexUserNativeCleanup =
    codexUserNativeEvidencePresent &&
    !projection.installRecordPresent &&
    !skipExternalNativeItems &&
    !protectedCodexUserNativeCleanup &&
    typeof nativeCleanupAdapter?.uninstallUserNativePluginById === 'function';
  const skippedItems = await collectSkippedCleanupItems({
    evidence,
    protectedCodexUserNativeCleanup,
    skipExternalNativeItems,
    skipClaimableProjectArtifacts,
  });
  const executionWarnings: string[] = [];
  if (platformAdapter && options.location.scope === 'user' && !skipExternalNativeItems) {
    try {
      if (preferDirectCodexUserNativeCleanup) {
        await nativeCleanupAdapter!.uninstallUserNativePluginById!(`${options.pluginName}@aw`);
      } else if (pluginMeta) {
        await platformAdapter.uninstallPlugin(pluginMeta, options.location.scope);
      } else if (typeof nativeCleanupAdapter?.uninstallUserNativePluginById === 'function') {
        await nativeCleanupAdapter.uninstallUserNativePluginById(`${options.pluginName}@aw`);
      }
    } catch (error) {
      executionWarnings.push(
        `[${renderLocation(options.location)}] cleanup 原生卸载步骤失败：${formatCommandError(error)}`,
      );
    }
  }
  if (pluginMeta && platformAdapter && !preferDirectCodexUserNativeCleanup && !skipExternalNativeItems) {
    try {
      await platformAdapter.uninstallExtensions(
        pluginMeta,
        options.location.scope,
        recordRead.status === 'ok'
          ? recordRead.value.record.artifacts.map(toGeneratedArtifact)
          : [],
      );
    } catch (error) {
      executionWarnings.push(
        `[${renderLocation(options.location)}] cleanup 扩展卸载步骤失败：${formatCommandError(error)}`,
      );
    }
  }

  const recordPath = getInstallRecordPath(options.commandOptions.cwd, options.location, context.env);
  const runtimeRoot = evidence.historicalLifecycle.path
    ?? (recordRead.status === 'ok' ? recordRead.value.record.lifecycle?.runtimeRoot : null)
    ?? deriveLocationRuntimeRoot(options.location, context.env);
  const deleteGroups: CleanupDeleteStageGroup[] = [];

  if (
    evidence.sharedRuntimeOwner.read.status !== 'missing'
    && !(evidence.sharedRuntimeOwner.read.status === 'ok' && !evidence.sharedRuntimeOwner.ownerMatchesTarget)
  ) {
    deleteGroups.push({
      label: 'shared runtime owner',
      stages: [createSharedRuntimeOwnerDeleteStage({ filePath: evidence.sharedRuntimeOwner.read.path })],
      items: [{
        kind: 'shared-runtime-owner',
        label: 'shared runtime owner',
        path: evidence.sharedRuntimeOwner.read.path,
      }],
    });
  }

  if (!skipClaimableProjectArtifacts) {
    for (const artifact of evidence.projectSharedIdentity.artifacts) {
      if (artifact.artifact.state === 'disabled' || !artifact.file.exists) {
        continue;
      }
      deleteGroups.push({
        label: `project residual artifact (${artifact.file.path})`,
        stages: [createPathDeleteStage({
          label: `project residual artifact (${artifact.file.path})`,
          filePath: artifact.file.path,
          rollbackWarningCode: 'projectArtifactRollbackFailed',
          finalizeWarningCode: 'projectArtifactFinalizeFailed',
        })],
        items: [{
          kind: 'repo-artifact',
          label: 'project residual artifact',
          path: artifact.file.path,
        }],
      });
    }
  }

  const trackedArtifactPaths = new Set<string>();
  for (const artifact of evidence.installRecord.artifacts) {
    if (artifact.artifact.state === 'disabled') {
      continue;
    }
    for (const file of artifact.files) {
      if (!file.exists || trackedArtifactPaths.has(file.path)) {
        continue;
      }
      trackedArtifactPaths.add(file.path);
      deleteGroups.push({
        label: `tracked artifact (${file.path})`,
        stages: [createPathDeleteStage({
          label: `tracked artifact (${file.path})`,
          filePath: file.path,
          rollbackWarningCode: 'trackedArtifactRollbackFailed',
          finalizeWarningCode: 'trackedArtifactFinalizeFailed',
        })],
        items: [{
          kind: 'tracked-artifact',
          label: 'tracked artifact',
          path: file.path,
        }],
      });
    }
  }

  if (
    !skipClaimableProjectArtifacts
    && evidence.projectSharedIdentity.read
    && evidence.projectSharedIdentity.read.status !== 'missing'
  ) {
    deleteGroups.push({
      label: 'project artifact identity',
      stages: [createProjectArtifactIdentityDeleteStage({ filePath: evidence.projectSharedIdentity.read.path })],
      items: [{
        kind: 'project-artifact-identity',
        label: 'project artifact shared identity',
        path: evidence.projectSharedIdentity.read.path,
      }],
    });
  }

  if (
    evidence.dynamicDiagnostic.read !== null
    && !(evidence.dynamicDiagnostic.read.status === 'unavailable' && evidence.dynamicDiagnostic.read.code === 'missing')
  ) {
    deleteGroups.push({
      label: 'dynamic diagnostic cache',
      stages: [createPathDeleteStage({
        label: 'dynamic diagnostic cache',
        filePath: evidence.dynamicDiagnostic.read.path,
        rollbackWarningCode: 'diagnosticCacheRollbackFailed',
        finalizeWarningCode: 'diagnosticCacheFinalizeFailed',
      })],
      items: [{
        kind: 'diagnostic-cache',
        label: 'dynamic diagnostic cache',
        path: evidence.dynamicDiagnostic.read.path,
      }],
    });
  }

  if (evidence.historicalLifecycle.residuePresent) {
    deleteGroups.push({
      label: 'historical lifecycle runtime',
      stages: [createPathDeleteStage({
        label: 'historical lifecycle runtime',
        filePath: runtimeRoot,
        rollbackWarningCode: 'historicalLifecycleRollbackFailed',
        finalizeWarningCode: 'historicalLifecycleFinalizeFailed',
      })],
      items: [{
        kind: 'historical-lifecycle-runtime',
        label: 'historical lifecycle runtime',
        path: runtimeRoot,
      }],
    });
  }

  if (evidence.nativeTransaction.read.status !== 'missing') {
    deleteGroups.push({
      label: 'native transaction marker',
      stages: [createNativeTransactionMarkerDeleteStage({
        pluginNameOrId: options.pluginName,
        env: context.env,
      })],
      items: [{
        kind: 'native-transaction-marker',
        label: 'native transaction marker',
        path: evidence.nativeTransaction.read.path,
      }],
    });
  }

  if (
    recordRead.status !== 'missing'
    || evidence.dependencyIndex.projection.currentLocationReferenceStatuses.length > 0
  ) {
    deleteGroups.push({
      label: 'install record',
      stages: [createInstallRecordDeleteStage({ filePath: recordPath })],
      postCommit: [createDependencyIndexRefreshPostCommitAction({
        mode: 'delete',
        location: options.location,
        recordPath,
        env: context.env,
      })],
      items: [
        ...(recordRead.status !== 'missing'
          ? [{
              kind: 'install-record',
              label: 'install record',
              path: recordPath,
            }]
          : []),
        ...(evidence.dependencyIndex.projection.currentLocationReferenceStatuses.length > 0
          ? [{
              kind: 'dependency-index-reference',
              label: 'dependency index reference',
              path: getGlobalDependencyIndexPath(context.env),
              detail: evidence.dependencyIndex.projection.currentLocationReferenceStatuses.join(','),
            }]
          : []),
      ],
    });
  }

  const deleteResult = await runCleanupDeleteStageGroups({
    location: options.location,
    groups: deleteGroups,
  });
  executionWarnings.push(...deleteResult.warnings);
  const trackingDir = resolveTrackingDir(options.commandOptions.cwd, options.location, context.env);
  try {
    const trackingManifest = await readTrackingManifest(trackingDir);
    if (getTrackingRecord(trackingManifest, options.location.plugin)) {
      await writeTrackingManifest(
        trackingDir,
        removeTrackingRecordFromManifest(trackingManifest, options.location.plugin),
      );
    }
  } catch (error) {
    executionWarnings.push(
      `[${renderLocation(options.location)}] cleanup tracking manifest 清理失败：${formatCommandError(error)}`,
    );
  }
  const gcWarning = await removeLifecycleRuntimeGc({ env: context.env });
  const warnings = [
    ...executionWarnings,
    ...(!protection.allowed && protection.failClosedReason
      ? [`[${renderLocation(options.location)}] 忽略 dependency index fail-closed：${protection.failClosedReason}`]
      : []),
    ...(gcWarning ? [`[${renderLocation(options.location)}] lifecycle runtime GC 已 fail closed：${gcWarning}`] : []),
  ];

  return {
    warnings,
    repoManagedArtifacts: recordRead.status === 'ok'
      ? recordRead.value.record.artifacts.map(toGeneratedArtifact)
      : [],
    summary: recordRead.status === 'ok'
      ? 'cleanup completed for record-backed residual'
      : 'cleanup completed for residual state',
    skippedItems,
    failedItems: uniqueCleanupExecutionItems(deleteResult.failedItems),
  };
}

export async function pruneDependencyIndexStaleEntry(options: {
  pruneToken: string;
  env: NodeJS.ProcessEnv;
}): Promise<InstallStatePruneResult> {
  const parsed = JSON.parse(Buffer.from(options.pruneToken, 'base64url').toString('utf8')) as {
    location: PluginLocation;
    recordPath: string;
    indexDigest: string;
  };
  const inspection = await inspectGlobalDependencyIndex(options.env);
  if (inspection.status !== 'ok') {
    throw new Error('dependency index 当前不可读，请先重新运行 status --verbose。');
  }
  const indexDigest = sha256Hex(await fs.readFile(inspection.path));
  if (indexDigest !== parsed.indexDigest) {
    throw new Error('prune token 已过期：dependency index digest 已变化，请重新运行 status --verbose 生成新 token。');
  }
  const matchedIndex = inspection.value.records.findIndex((entry) =>
    entry.recordPath === parsed.recordPath);
  if (matchedIndex < 0) {
    throw new Error('prune token 对应的 dependency index entry 已不存在，请重新运行 status --verbose。');
  }
  const matchedEntry = inspection.value.records[matchedIndex]!;
  if (!sameLocation(matchedEntry.location, parsed.location)) {
    throw new Error('prune token 与当前 dependency index entry 的 location 不匹配，请重新运行 status --verbose。');
  }
  const reference = inspection.references[matchedIndex];
  if (!reference || reference.recordPath !== parsed.recordPath) {
    throw new Error('prune token 与当前 dependency index reference 不匹配，请重新运行 status --verbose。');
  }
  if (reference.status === 'verified') {
    throw new Error('该 dependency index entry 目前仍可验证，不能按 stale prune 删除。');
  }
  if (reference.status === 'unreadableReference') {
    throw new Error('该 dependency index entry 当前是 unreadable reference，不允许按 stale prune 删除。');
  }

  await writeGlobalDependencyIndex({
    ...inspection.value,
    updatedAt: new Date().toISOString(),
    records: inspection.value.records.filter((_, index) => index !== matchedIndex),
  }, options.env);

  return {
    warnings: [],
    pruneToken: options.pruneToken,
    action: 'retired',
    retiredEntries: [{
      location: parsed.location,
      recordPath: parsed.recordPath,
    }],
  };
}

export async function readInstallStateProjection(options: {
  cwd: string;
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<{
  evidence: InstallEvidence;
  projection: ProjectInstallStateProjection;
  forceCleanupRequired: boolean;
  removalProtection: InstallStateRemovalProtection;
  cleanupSafety: InstallStateCleanupSafety;
}> {
  const evidence = await collectInstallEvidence({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const projection = projectInstallState(evidence);
  const removalProtection = await analyzeRemovalDependencyProtection(options);
  const ledger = options.location.platform === 'codex' && options.location.scope === 'user'
    ? await readInstalledLedger(options.env)
    : null;
  const codexSharedNativeRefs = options.location.platform === 'codex' && options.location.scope === 'user'
    ? normalizeSharedNativeRefs(
        ledger?.plugins[options.location.plugin]?.platforms.codex?.sharedNativeRefs,
      )
    : null;
  const derivedSharedRuntimeOwner = await readDerivedSharedSkillTriggerRuntimeOwner({
    pluginName: options.location.plugin,
    platform: options.location.platform,
    env: options.env,
    cwd: options.cwd,
  });
  const cleanupSafety: InstallStateCleanupSafety = {
    protectedCodexUserNativeCleanup: Boolean(
      codexSharedNativeRefs?.user === true || (codexSharedNativeRefs?.projects.length ?? 0) > 0,
    ),
    skipExternalNativeItems:
      projection.kind === 'external' && !isPureCodexUserNativeResidueForCleanup(evidence),
    skipClaimableProjectArtifacts: evidence.adoptable.possible,
    sharedRuntimeOwnerConflict:
      derivedSharedRuntimeOwner !== null
      && !(options.location.platform === 'codex' && options.location.scope === 'project')
      && !sameLocation(derivedSharedRuntimeOwner, options.location),
  };
  return {
    evidence,
    projection,
    forceCleanupRequired: false,
    removalProtection,
    cleanupSafety,
  };
}
