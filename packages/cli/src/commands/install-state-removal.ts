import path from 'node:path';

import fs from 'fs-extra';

import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import {
  createAdapters,
  createHistoricalPluginTarget,
  type ResolvedPluginTarget,
} from './common.js';
import { readPluginManifest } from '../utils/manifest.js';
import { runLifecycleScript, type LifecycleProcessRunner } from '../utils/plugin-scripts.js';
import {
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
  planSharedSkillTriggerRuntimeOwnerRemoval,
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
  getInstallRecordPath,
  getInstallStatePrivateRoot,
  getNativeTransactionMarkerPath,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
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
import { readCodexConfigFile } from '../utils/codex-config.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
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
  backups: string[];
  skippedItems: InstallStateCleanupExecutionItem[];
}

export interface InstallStatePruneResult {
  warnings: string[];
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
    ...(artifact.ownershipMarker ? { contentDigest: artifact.ownershipMarker } : {}),
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
  if (inspection.status !== 'ok') {
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

  const verifiedIndexDependents = inspection.value.records
    .filter((entry, index) => inspection.references[index]?.status === 'verified')
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) =>
      entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location);
  const blockedDependents = dedupeLocations([
    ...localBlockedDependents,
    ...verifiedIndexDependents,
  ]);

  const coverageIssue = inspection.references.some((reference) =>
    reference.status !== 'verified'
    && isRelevantIndexReference(options.location, reference));

  if (options.location.scope === 'user' && inspection.references.some((reference) => reference.status !== 'verified')) {
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
  if (options.recordFile?.record.lifecycle?.bundleRoot) {
    try {
      return await readPluginManifest(options.recordFile.record.lifecycle.bundleRoot, { mode: 'bundle' });
    } catch {
      // fall through
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
  }
  | {
    status: 'invalid';
    reason: string;
  };

function isPathInside(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

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

  const { lifecycle } = options;
  let runtimeRoot: string;
  let bundleRoot: string;
  let manifestPath: string;
  try {
    runtimeRoot = await fs.realpath(lifecycle.runtimeRoot);
    bundleRoot = await fs.realpath(lifecycle.bundleRoot);
    manifestPath = await fs.realpath(lifecycle.manifestPath);
    if (!isPathInside(bundleRoot, runtimeRoot)) {
      return {
        status: 'invalid',
        reason: 'historical lifecycle bundle root 不在 runtime root 内',
      };
    }
    if (!isPathInside(manifestPath, bundleRoot)) {
      return {
        status: 'invalid',
        reason: 'historical lifecycle manifest path 不在 bundle root 内',
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical lifecycle bundle 路径不可用：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const [manifestDigest, bundleFingerprint, historicalPlugin] = await Promise.all([
      calculateFileDigest(manifestPath),
      calculatePluginBundleFingerprint(bundleRoot),
      readPluginManifest(bundleRoot, { mode: 'bundle' }),
    ]);
    if (manifestDigest !== lifecycle.sourceManifestDigest) {
      return {
        status: 'invalid',
        reason: 'historical lifecycle manifest digest 与记录不一致',
      };
    }
    if (bundleFingerprint !== lifecycle.bundleFingerprint) {
      return {
        status: 'invalid',
        reason: 'historical lifecycle bundle fingerprint 与记录不一致',
      };
    }
    if (
      historicalPlugin.manifest.name !== options.location.plugin ||
      historicalPlugin.manifest.version !== lifecycle.pluginVersion
    ) {
      return {
        status: 'invalid',
        reason: 'historical lifecycle manifest identity 与记录不一致',
      };
    }
  } catch (error) {
    return {
      status: 'invalid',
      reason: `historical lifecycle bundle 内容不可验证：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!options.currentPlugin) {
    return {
      status: 'invalid',
      reason: '缺少当前 bundle 参照，无法判断 historical lifecycle bundle 是否过期',
    };
  }

  if (
    options.currentPlugin.manifest.name !== options.location.plugin ||
    options.currentPlugin.manifest.version !== lifecycle.pluginVersion
  ) {
    return {
      status: 'invalid',
      reason: `historical lifecycle version ${lifecycle.pluginVersion} 与当前 bundle version ${options.currentPlugin.manifest.version} 不一致`,
    };
  }

  if (!(await fs.pathExists(path.join(bundleRoot, options.location.platform, 'skills')))) {
    return {
      status: 'invalid',
      reason: `historical lifecycle bundle 缺少 ${options.location.platform} skill source 子树`,
    };
  }

  return {
    status: 'ok',
    sourcePluginRoot: bundleRoot,
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

  if (recordRead.value.record.lifecycle) {
    const historicalPlugin = await readPluginManifest(recordRead.value.record.lifecycle.bundleRoot, { mode: 'bundle' });
    await runLifecycleScript({
      event: 'uninstall',
      pluginName: recordRead.value.record.pluginName,
      platform: location.platform,
      scope: location.scope,
      cwd: options.commandOptions.cwd,
      context,
      currentPlugin: historicalPlugin,
      artifacts: recordRead.value.record.artifacts.map(toGeneratedArtifact),
      scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
      runner: options.runtime.lifecycleRunner,
    });
  }

  const adapters = createAdapters(options.commandOptions.cwd, context);
  const pluginMeta = await loadPreferredPluginMeta({
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
      createPathDeleteStage({
        label: 'native transaction marker',
        filePath: getNativeTransactionMarkerPath(location.plugin, context.env),
        rollbackWarningCode: 'nativeMarkerRollbackFailed',
        finalizeWarningCode: 'nativeMarkerFinalizeFailed',
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

async function backupFiles(filePaths: string[], env: NodeJS.ProcessEnv): Promise<string[]> {
  if (filePaths.length === 0) {
    return [];
  }
  const backupRoot = path.join(resolveAwHome(env), 'cleanup-backups', Date.now().toString());
  const backedUp: string[] = [];
  await fs.ensureDir(backupRoot);
  for (const filePath of filePaths) {
    if (!(await fs.pathExists(filePath))) {
      continue;
    }
    const destination = path.join(backupRoot, path.basename(filePath));
    await fs.copy(filePath, destination, { overwrite: true });
    backedUp.push(destination);
  }
  return backedUp;
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

  return items;
}

interface CleanupDeleteStageGroup {
  label: string;
  stages: InstallStateTransactionStage[];
  postCommit?: InstallStateTransactionPostCommitAction[];
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
}): Promise<string[]> {
  const warnings: string[] = [];
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
      if (error instanceof InstallStateTransactionError) {
        warnings.push(...error.warnings.map((warning) => formatInstallStateWarning(options.location, warning)));
      }
    }
  }
  return warnings;
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
  if (projection.kind === 'adoptable') {
    throw new Error(`${renderLocation(options.location)} 当前是可认领状态，cleanup 默认不会删除这些共享产物。`);
  }

  const protection = await analyzeRemovalDependencyProtection({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: context.env,
  });
  if (protection.blockedDependents.length > 0 && options.commandOptions.force !== true) {
    throw new Error(
      `${renderLocation(options.location)} 仍被以下 verified dependent 引用：${protection.blockedDependents.map(renderLocation).join('、')}。`,
    );
  }

  const forceCleanupRequired = !projection.installRecordPresent
    && projection.kind === 'residual'
    && evidence.projectSharedIdentity.artifacts.some((artifact) => artifact.file.exists);
  if (forceCleanupRequired && options.commandOptions.force !== true) {
    throw new Error('当前 cleanup 需要 --force 才能继续，因为它会先备份现有共享文件。');
  }
  const backedUp = options.commandOptions.force === true
    ? await backupFiles(
        evidence.projectSharedIdentity.artifacts
          .filter((artifact) => artifact.file.exists)
          .map((artifact) => artifact.file.path),
        context.env,
      )
    : [];

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
    : createAdapters(options.commandOptions.cwd, context)[options.location.platform];
  const nativeCleanupAdapter = platformAdapter as PlatformAdapter & {
    uninstallUserNativePluginById?: (pluginNameOrId: string) => Promise<void>;
  } | undefined;
  const preferDirectCodexUserNativeCleanup =
    codexUserNativeEvidencePresent &&
    !projection.installRecordPresent &&
    !protectedCodexUserNativeCleanup &&
    typeof nativeCleanupAdapter?.uninstallUserNativePluginById === 'function';
  const executionWarnings: string[] = [];
  if (platformAdapter && options.location.scope === 'user') {
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
  if (pluginMeta && platformAdapter && !preferDirectCodexUserNativeCleanup) {
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

  const shouldPlanSharedRuntimeRemoval =
    projection.installRecordPresent || evidence.sharedRuntimeOwner.read.status === 'ok';
  const removalTarget = createMaterializationTarget(
    options.location.platform,
    options.location.scope,
    options.commandOptions.cwd,
    context.env,
  );
  const embeddedRootAttempt = shouldPlanSharedRuntimeRemoval
    ? await tryResolveEmbeddedPluginsRoot()
    : { root: null };
  const removalStages = shouldPlanSharedRuntimeRemoval
    ? embeddedRootAttempt.root
      ? await (async () => {
          const removalPlan = await planSharedSkillTriggerRuntimeOwnerRemoval({
            location: options.location,
            embeddedRoot: embeddedRootAttempt.root!,
            target: removalTarget,
            env: context.env,
          });
          return createSharedSkillTriggerRuntimeRemovalStages({
            plan: removalPlan,
            pluginName: options.location.plugin,
            platform: options.location.platform,
            embeddedRoot: embeddedRootAttempt.root!,
            target: removalTarget,
            env: context.env,
          });
        })()
      : await createBestEffortSharedRuntimeRemovalStagesWithoutEmbeddedRoot({
          location: options.location,
          target: removalTarget,
          env: context.env,
          lifecycle: recordRead.status === 'ok' ? recordRead.value.record.lifecycle : undefined,
          currentPlugin: options.target?.currentPlugin ?? options.target?.embeddedPlugin,
          force: options.commandOptions.force === true,
          error: embeddedRootAttempt.error,
        })
    : {
        ownerAction: 'none' as const,
        warnings: [],
        stages: [],
      };

  const recordPath = getInstallRecordPath(options.commandOptions.cwd, options.location, context.env);
  const runtimeRoot = recordRead.status === 'ok'
    ? recordRead.value.record.lifecycle?.runtimeRoot
    : deriveLocationRuntimeRoot(options.location, context.env);
  const residualRepoArtifactStages =
    !projection.installRecordPresent && options.commandOptions.force === true
      ? evidence.projectSharedIdentity.artifacts
        .filter((artifact) => artifact.file.exists)
        .map((artifact) =>
          createPathDeleteStage({
            label: `project residual artifact (${artifact.file.path})`,
            filePath: artifact.file.path,
            rollbackWarningCode: 'projectArtifactRollbackFailed',
            finalizeWarningCode: 'projectArtifactFinalizeFailed',
          }))
      : [];
  executionWarnings.push(...await runCleanupDeleteStageGroups({
    location: options.location,
    groups: [
      {
        label: 'shared runtime owner',
        stages: removalStages.stages,
      },
      ...residualRepoArtifactStages.map((stage) => ({
        label: stage.label,
        stages: [stage],
      })),
      ...(evidence.projectSharedIdentity.read
        && evidence.projectSharedIdentity.read.status !== 'missing'
        ? [{
            label: 'project artifact identity',
            stages: [createProjectArtifactIdentityDeleteStage({ filePath: evidence.projectSharedIdentity.read.path })],
          }]
        : []),
      {
        label: 'dynamic diagnostic cache',
        stages: [createPathDeleteStage({
          label: 'dynamic diagnostic cache',
          filePath: getDiagnosticCachePath(options.commandOptions.cwd, options.location, context.env),
          rollbackWarningCode: 'diagnosticCacheRollbackFailed',
          finalizeWarningCode: 'diagnosticCacheFinalizeFailed',
        })],
      },
      ...(runtimeRoot
        ? [{
            label: 'historical lifecycle runtime',
            stages: [createPathDeleteStage({
              label: 'historical lifecycle runtime',
              filePath: runtimeRoot,
              rollbackWarningCode: 'historicalLifecycleRollbackFailed',
              finalizeWarningCode: 'historicalLifecycleFinalizeFailed',
            })],
          }]
        : []),
      {
        label: 'native transaction marker',
        stages: [createPathDeleteStage({
          label: 'native transaction marker',
          filePath: getNativeTransactionMarkerPath(options.pluginName, context.env),
          rollbackWarningCode: 'nativeMarkerRollbackFailed',
          finalizeWarningCode: 'nativeMarkerFinalizeFailed',
        })],
      },
      {
        label: 'install record',
        stages: [createInstallRecordDeleteStage({ filePath: recordPath })],
        postCommit: [createDependencyIndexRefreshPostCommitAction({
          mode: 'delete',
          location: options.location,
          recordPath,
          env: context.env,
        })],
      },
    ],
  }));
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
    ...removalStages.warnings,
    ...(!protection.allowed && protection.failClosedReason
      ? [`[${renderLocation(options.location)}] 忽略 dependency index fail-closed：${protection.failClosedReason}`]
      : []),
    ...(protection.blockedDependents.length > 0 && options.commandOptions.force === true
      ? [
          `[${renderLocation(options.location)}] 已按 --force 保留 ${
            protection.blockedDependents.map(renderLocation).join('、')
          }；这些 dependent 后续可能需要 repair、reinstall 或 cleanup。`,
        ]
      : []),
    ...(backedUp.length > 0 ? [`已备份 ${backedUp.length} 个共享文件。`] : []),
    ...(gcWarning ? [`[${renderLocation(options.location)}] lifecycle runtime GC 已 fail closed：${gcWarning}`] : []),
  ];
  const skippedItems = await collectProtectedCodexUserNativeSkippedItems({
    protectedCodexUserNativeCleanup,
    evidence,
  });

  return {
    warnings,
    repoManagedArtifacts: recordRead.status === 'ok'
      ? recordRead.value.record.artifacts.map(toGeneratedArtifact)
      : [],
    summary: recordRead.status === 'ok'
      ? 'cleanup completed for record-backed residual'
      : 'cleanup completed for residual state',
    backups: backedUp,
    skippedItems,
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
    throw new Error('dependency index 当前不可读，请先重新运行 diagnose 或 repair。');
  }
  const indexDigest = sha256Hex(await fs.readFile(inspection.path));
  if (indexDigest !== parsed.indexDigest) {
    throw new Error('prune token 已过期：dependency index digest 已变化，请重新运行 diagnose 生成新 token。');
  }
  const matchedIndex = inspection.value.records.findIndex((entry) =>
    entry.recordPath === parsed.recordPath);
  if (matchedIndex < 0) {
    throw new Error('prune token 对应的 dependency index entry 已不存在，请重新运行 diagnose。');
  }
  const matchedEntry = inspection.value.records[matchedIndex]!;
  if (!sameLocation(matchedEntry.location, parsed.location)) {
    throw new Error('prune token 与当前 dependency index entry 的 location 不匹配，请重新运行 diagnose。');
  }
  const reference = inspection.references[matchedIndex];
  if (!reference || reference.recordPath !== parsed.recordPath) {
    throw new Error('prune token 与当前 dependency index reference 不匹配，请重新运行 diagnose。');
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
}> {
  const evidence = await collectInstallEvidence({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const projection = projectInstallState(evidence);
  const removalProtection = await analyzeRemovalDependencyProtection(options);
  return {
    evidence,
    projection,
    forceCleanupRequired: !projection.installRecordPresent
      && projection.kind === 'residual'
      && evidence.projectSharedIdentity.artifacts.some((artifact) => artifact.file.exists),
    removalProtection,
  };
}
