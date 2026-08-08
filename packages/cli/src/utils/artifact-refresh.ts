import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { CodexAdapter } from '../adapters/codex.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { preflightCodexProjectWriteSafety } from '../commands/codex-project-safety.js';
import type { ResolvedPluginTarget } from '../commands/common.js';
import {
  captureArtifactRollbackState,
  disposeArtifactRollbackState,
  rollbackArtifacts as restoreTrackedArtifactRollbackState,
} from '../commands/uninstall.js';
import {
  readDynamicArtifactDiagnosticCacheForLocation,
  readInstallRecordForLocation,
} from '../install-state/facade.js';
import type {
  ArtifactLastRefresh,
  ArtifactRefreshReach,
  ArtifactState,
  ArtifactTarget,
  GeneratedArtifact,
  MarketplaceManifest,
  PluginMeta,
  PlatformName,
  Scope,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import { mergeGeneratedArtifacts } from './generated-artifacts.js';
import {
  collectCodexDynamicSkillSyncKeys,
  getLocalMarketplaceCodexSkillRoot,
  materializeStagedMarketplaceCodexDynamicSkills,
  readInstalledLedger,
} from './local-marketplace.js';
import {
  captureCodexNativePluginRollbackBaseline,
  disposeCodexNativePluginRollbackBaseline,
  restoreCodexNativePluginRollbackBaseline,
} from './codex-native-state.js';
import {
  createDynamicArtifactDiagnosticCacheWriteStage,
  createInstallRecordWriteStage,
  createProjectArtifactIdentityDeleteStage,
  createProjectArtifactIdentityWriteStage,
  type InstallStateTransactionStage,
  runInstallStateTransaction,
} from '../install-state/transactions.js';
import {
  createProjectArtifactSharedLocator,
  getProjectArtifactSharedIdentityPath,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  InstallRecordArtifact,
  InstallRecordFile,
  InstallStateReadResult,
  PluginLocation,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
} from '../install-state/types.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from './paths.js';
import { readPluginManifest } from './manifest.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from './plugin-scripts.js';
import {
  getTrackingRecord,
  readTrackingManifest,
  upsertTrackingRecordInManifest,
  writeTrackingManifest,
} from './tracking.js';
import { assertTestWritablePath } from './test-path-fence.js';

export interface ArtifactRefreshReceiptArtifact {
  platform: PlatformName;
  scope: Scope;
  id: string;
  target: ArtifactTarget;
  state: ArtifactState;
  status: 'succeeded' | 'failed';
  refreshReach?: ArtifactRefreshReach;
}

export interface ArtifactRefreshReceipt {
  attempted: boolean;
  status: 'succeeded' | 'failed' | 'skipped';
  triggerKeys: string[];
  artifacts: ArtifactRefreshReceiptArtifact[];
  scopeReach?: ArtifactRefreshReach;
  error?: string;
  nextSteps?: string[];
  reason?: 'no-tracked-dynamic-artifact' | 'no-trigger-keys';
}

interface RefreshUnit {
  platform: PlatformName;
  scope: Scope;
  triggerKeys: string[];
  trackingDir: string;
  trackingManifest: TrackingManifest;
  trackingRecord: TrackingPluginRecord;
  dynamicArtifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
  staticArtifacts: GeneratedArtifact[];
}

interface ExecutedRefreshUnit extends RefreshUnit {
  status: 'succeeded' | 'failed';
  refreshedArtifacts?: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
  error?: string;
  artifactRollbackState?: Awaited<ReturnType<typeof captureArtifactRollbackState>>;
  nativeRollbackBaseline?: Awaited<ReturnType<typeof captureCodexNativePluginRollbackBaseline>>;
}

interface WrittenRefreshResult {
  status: ExecutedRefreshUnit['status'];
  error?: string;
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
}

function isTrackedDynamicArtifact(
  artifact: GeneratedArtifact,
): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } {
  return (
    typeof artifact.id === 'string' &&
    (
      artifact.target === 'codex.developerInstructionsBlock' ||
      artifact.target === 'codex.agentRole' ||
      artifact.target === 'codex.skill' ||
      artifact.target === 'claude.skill'
    ) &&
    (artifact.state === 'present' || artifact.state === 'disabled')
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sameDynamicArtifactIdentity(
  artifact: Pick<InstallRecordArtifact, 'id' | 'target' | 'artifactKey' | 'roleKey'>,
  diagnostic: DynamicArtifactDiagnosticEntry,
): boolean {
  return artifact.id === diagnostic.id &&
    artifact.target === diagnostic.target &&
    (artifact.artifactKey === undefined || diagnostic.artifactKey === undefined ||
      artifact.artifactKey === diagnostic.artifactKey) &&
    (artifact.roleKey === undefined || diagnostic.roleKey === undefined ||
      artifact.roleKey === diagnostic.roleKey);
}

function restoreInstallStateArtifact(options: {
  artifact: InstallRecordArtifact;
  diagnostic?: DynamicArtifactDiagnosticEntry;
}): GeneratedArtifact {
  const diagnosticLastRefresh = options.diagnostic?.lastRefresh;
  const diagnosticRefreshReach = options.diagnostic?.refreshReach;

  return {
    path: options.artifact.path,
    ...(options.artifact.paths?.length
      ? { paths: [...options.artifact.paths] }
      : {}),
    kind: options.artifact.kind,
    platform: options.artifact.platform,
    ...(options.artifact.artifactKey === undefined
      ? {}
      : { artifactKey: options.artifact.artifactKey }),
    ...(options.artifact.hookGroups === undefined
      ? {}
      : { hookGroups: structuredClone(options.artifact.hookGroups) }),
    ...(options.artifact.id === undefined ? {} : { id: options.artifact.id }),
    ...(options.artifact.target === undefined ? {} : { target: options.artifact.target }),
    state: options.artifact.state ?? options.diagnostic?.state ?? 'present',
    ...(options.diagnostic?.disabledReason === undefined
      ? {}
      : { disabledReason: options.diagnostic.disabledReason }),
    ...(options.artifact.refreshKeys !== undefined
      ? { refreshKeys: [...options.artifact.refreshKeys] }
      : options.diagnostic?.refreshKeys !== undefined
        ? { refreshKeys: [...options.diagnostic.refreshKeys] }
        : {}),
    ...(options.artifact.configDigest ?? options.diagnostic?.configDigest
      ? { configDigest: options.artifact.configDigest ?? options.diagnostic?.configDigest }
      : {}),
    ...(options.artifact.contentDigest ?? options.diagnostic?.contentDigest
      ? { contentDigest: options.artifact.contentDigest ?? options.diagnostic?.contentDigest }
      : {}),
    ...(options.artifact.roleKey === undefined ? {} : { roleKey: options.artifact.roleKey }),
    ...(diagnosticLastRefresh
      ? {
          lastRefresh: {
            status: diagnosticLastRefresh.status === 'success' ? 'succeeded' : 'failed',
            updatedAt: diagnosticLastRefresh.at,
            event: diagnosticLastRefresh.event === 'config'
              ? 'refresh'
              : diagnosticLastRefresh.event,
            ...(diagnosticLastRefresh.error ? { error: diagnosticLastRefresh.error } : {}),
          },
        }
      : {}),
    ...(diagnosticRefreshReach
      ? {
          refreshReach: {
            commandScope: diagnosticRefreshReach.commandScope === 'projectShared'
              ? 'project'
              : 'user',
            ...(diagnosticRefreshReach.refreshedUserTarget === undefined
              ? {}
              : { refreshedUserTarget: diagnosticRefreshReach.refreshedUserTarget }),
            ...(diagnosticRefreshReach.refreshedCurrentProjectTarget === undefined
              ? {}
              : { refreshedCurrentProjectTarget: diagnosticRefreshReach.refreshedCurrentProjectTarget }),
          },
        }
      : {}),
  };
}

async function createRefreshLocation(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
}): Promise<PluginLocation> {
  if (options.scope === 'user') {
    return {
      plugin: options.pluginName,
      platform: options.platform,
      scope: 'user',
    };
  }

  return {
    plugin: options.pluginName,
    platform: options.platform,
    scope: 'project',
    projectKey: options.platform === 'codex'
      ? await resolveCodexProjectKey(options.cwd)
      : await resolveClaudeProjectKey(options.cwd),
  };
}

async function recoverRefreshTrackingRecord(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  trackingRecord: TrackingPluginRecord | undefined;
}): Promise<TrackingPluginRecord | undefined> {
  const location = await createRefreshLocation({
    pluginName: options.plugin.manifest.name,
    platform: options.platform,
    scope: options.scope,
    cwd: options.cwd,
  });
  const recordRead = await readInstallRecordForLocation({
    cwd: options.cwd,
    location,
    env: options.env,
  });
  if (recordRead.status !== 'ok') {
    return options.trackingRecord;
  }
  const diagnosticRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location,
    currentRecord: recordRead.value,
    env: options.env,
  });
  const diagnostics = diagnosticRead.status === 'ok' ? diagnosticRead.value.artifacts : [];
  const recoveredArtifacts = recordRead.value.record.artifacts.map((artifact) =>
    restoreInstallStateArtifact({
      artifact,
      diagnostic: diagnostics.find((entry) => sameDynamicArtifactIdentity(artifact, entry)),
    }));
  if (!recoveredArtifacts.some((artifact) =>
    artifact.platform === options.platform && isTrackedDynamicArtifact(artifact))) {
    return options.trackingRecord;
  }

  return {
    name: options.plugin.manifest.name,
    generatedAt: new Date().toISOString(),
    artifacts: mergeGeneratedArtifacts(recoveredArtifacts, options.trackingRecord?.artifacts ?? []),
  };
}

function assertArtifactRefreshStagingPathForTests(
  targetPath: string,
  source: string,
): string {
  return assertTestWritablePath(
    targetPath,
    source,
    '用 createIsolatedTestEnv() 生成默认 TMPDIR，或通过 registerWritableStateRoot() 登记 artifact refresh staging 路径。',
  );
}

function summarizeArtifacts(
  platform: PlatformName,
  scope: Scope,
  status: 'succeeded' | 'failed',
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>,
): ArtifactRefreshReceiptArtifact[] {
  return artifacts.map((artifact) => ({
    platform,
    scope,
    id: artifact.id,
    target: artifact.target,
    state: artifact.state,
    status,
    ...(artifact.refreshReach ? { refreshReach: artifact.refreshReach } : {}),
  }));
}

function buildLastRefresh(options: {
  status: ArtifactLastRefresh['status'];
  triggerKeys: string[];
  error?: string;
}): ArtifactLastRefresh {
  return {
    status: options.status,
    updatedAt: new Date().toISOString(),
    triggerKeys: [...options.triggerKeys],
    event: 'refresh',
    ...(options.error ? { error: options.error } : {}),
  };
}

function withRefreshMetadata(
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>,
  lastRefresh: ArtifactLastRefresh,
  refreshReach: ArtifactRefreshReach,
): Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }> {
  return artifacts.map((artifact) => ({
    ...artifact,
    lastRefresh,
    refreshReach,
  }));
}

function createResolvedTarget(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    source: 'currentCatalog',
  };
}

function createHistoricalRefreshTarget(
  currentPlugin: PluginMeta,
  refreshPlugin: PluginMeta,
): ResolvedPluginTarget {
  return {
    pluginName: currentPlugin.manifest.name,
    plugin: refreshPlugin,
    currentPlugin,
    source: 'historical',
  };
}

function formatInstallRecordReadFailure(
  recordRead: InstallStateReadResult<InstallRecordFile>,
): string {
  if (recordRead.status === 'ok') {
    return '';
  }

  return `${recordRead.code}: ${recordRead.error}`;
}

function createHistoricalRefreshBundleError(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  reason: string;
}): Error {
  return new Error(
    `无法使用 ${options.pluginName} (${options.scope}) 的 historical lifecycle bundle 刷新 dynamic artifacts：${options.reason}。` +
      `请先运行 \`aw reinstall ${options.pluginName} --platform ${options.platform} --scope ${options.scope}\` 保留配置重建后再试。`,
  );
}

async function resolveHistoricalRefreshPlugin(options: {
  currentPlugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  recordRead: InstallStateReadResult<InstallRecordFile>;
}): Promise<PluginMeta> {
  const pluginName = options.currentPlugin.manifest.name;
  if (options.recordRead.status !== 'ok') {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason: `install record 不可用（${formatInstallRecordReadFailure(options.recordRead)}）`,
    });
  }

  const lifecycle = options.recordRead.value.record.lifecycle;
  if (!lifecycle) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason: 'install record 缺少 historical lifecycle runtime',
    });
  }

  if (!(await fs.pathExists(lifecycle.bundleRoot))) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason: `historical bundle 不存在：${lifecycle.bundleRoot}`,
    });
  }

  const [manifestDigest, bundleFingerprint] = await Promise.all([
    calculateFileDigest(lifecycle.manifestPath),
    calculatePluginBundleFingerprint(lifecycle.bundleRoot),
  ]);
  if (manifestDigest !== lifecycle.sourceManifestDigest) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason: `historical manifest digest 不匹配：expected ${lifecycle.sourceManifestDigest}, got ${manifestDigest}`,
    });
  }
  if (bundleFingerprint !== lifecycle.bundleFingerprint) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason: `historical bundle fingerprint 不匹配：expected ${lifecycle.bundleFingerprint}, got ${bundleFingerprint}`,
    });
  }

  const historicalPlugin = await readPluginManifest(lifecycle.bundleRoot, { mode: 'bundle' });
  if (
    historicalPlugin.manifest.name !== pluginName ||
    historicalPlugin.manifest.version !== lifecycle.pluginVersion
  ) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      platform: options.platform,
      scope: options.scope,
      reason:
        `historical manifest 身份不匹配：expected ${pluginName}@${lifecycle.pluginVersion}, ` +
        `got ${historicalPlugin.manifest.name}@${historicalPlugin.manifest.version}`,
    });
  }

  return historicalPlugin;
}

function createSinglePluginCodexMarketplace(plugin: PluginMeta): MarketplaceManifest {
  return {
    name: 'aw',
    owner: {
      name: 'Agent Workflows',
      url: 'https://github.com/LeslieChan/agent-workflows',
    },
    interface: {
      displayName: 'Agent Workflows',
    },
    plugins: [
      {
        name: plugin.manifest.name,
        source: `./plugins/${plugin.manifest.name}`,
        description: plugin.manifest.description,
        ...(plugin.manifest.interface ? { interface: structuredClone(plugin.manifest.interface) } : {}),
        category: plugin.manifest.marketplace.category,
        ...(plugin.manifest.marketplace.tags ? { tags: [...plugin.manifest.marketplace.tags] } : {}),
        strict: plugin.manifest.marketplace.strict,
        policy: structuredClone(plugin.manifest.marketplace.policy),
      },
    ],
  };
}

async function stageCodexUserNativeHistoricalMarketplace(options: {
  plugin: PluginMeta;
  refreshedArtifacts: readonly GeneratedArtifact[];
  previousArtifacts?: readonly InstallRecordArtifact[];
  env: NodeJS.ProcessEnv;
}): Promise<{ rootDir: string; marketplacePath: string }> {
  const stagingRoot = await fs.mkdtemp(
    assertArtifactRefreshStagingPathForTests(
      path.join(os.tmpdir(), 'aw-codex-refresh-marketplace-'),
      'artifact refresh historical marketplace staging root',
    ),
  );
  const pluginName = options.plugin.manifest.name;
  const stagedPluginRoot = assertArtifactRefreshStagingPathForTests(
    path.join(stagingRoot, 'plugins', pluginName),
    'artifact refresh staged plugin root',
  );
  try {
    await fs.copy(options.plugin.rootDir, stagedPluginRoot, {
      overwrite: true,
      errorOnExist: false,
    });

    for (const artifact of options.refreshedArtifacts) {
      if (artifact.target !== 'codex.skill') {
        continue;
      }
      if (!artifact.artifactKey) {
        throw new Error(`Artifact "${artifact.id ?? '<unknown>'}" 的 codex.skill 缺少 artifactKey，无法重建 Codex native cache。`);
      }

      const stagedSkillRoot = getLocalMarketplaceCodexSkillRoot(
        stagingRoot,
        pluginName,
        artifact.artifactKey,
      );
      assertArtifactRefreshStagingPathForTests(
        stagedSkillRoot,
        'artifact refresh staged Codex skill root',
      );
      if (artifact.state === 'disabled') {
        await fs.remove(stagedSkillRoot);
        continue;
      }

      const runtimeSkillRoot = path.isAbsolute(artifact.path)
        ? artifact.path
        : getLocalMarketplaceCodexSkillRoot(
            resolveAwHome(options.env),
            pluginName,
            artifact.artifactKey,
          );
      if (!(await fs.pathExists(runtimeSkillRoot))) {
        throw new Error(
          `无法从 historical bundle 重建 Codex native cache：缺少已刷新的 runtime skill ${runtimeSkillRoot}。`,
        );
      }
      await fs.remove(stagedSkillRoot);
      await fs.ensureDir(path.dirname(stagedSkillRoot));
      await fs.copy(runtimeSkillRoot, stagedSkillRoot, {
        overwrite: true,
        errorOnExist: false,
      });
    }
    await materializeStagedMarketplaceCodexDynamicSkills({
      rootDir: stagingRoot,
      pluginName,
      skillKeys: collectCodexDynamicSkillSyncKeys({
        skillKeys: options.refreshedArtifacts
          .filter((artifact) => artifact.target === 'codex.skill')
          .map((artifact) => artifact.artifactKey?.trim())
          .filter((artifactKey): artifactKey is string => Boolean(artifactKey)),
        installedArtifacts: options.previousArtifacts,
      }),
    });

    const marketplacePath = assertArtifactRefreshStagingPathForTests(
      path.join(stagingRoot, '.agents', 'plugins', 'marketplace.json'),
      'artifact refresh staged marketplace manifest',
    );
    await fs.outputJson(marketplacePath, createSinglePluginCodexMarketplace(options.plugin), {
      spaces: 2,
    });
    return {
      rootDir: stagingRoot,
      marketplacePath,
    };
  } catch (error) {
    await fs.remove(stagingRoot).catch(() => undefined);
    throw error;
  }
}

async function collectRefreshUnits(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys: boolean;
}): Promise<RefreshUnit[]> {
  const candidateScopes: Scope[] = options.commandScope === 'user'
    ? ['user', 'project']
    : [options.commandScope];
  const units: RefreshUnit[] = [];

  for (const platform of ['codex', 'claude'] as const) {
    for (const scope of candidateScopes) {
      const trackingDir = platform === 'codex'
        ? resolveCodexPaths(options.cwd, scope, options.env).trackingDir
        : resolveClaudePaths(options.cwd, scope, options.env).trackingDir;
      const trackingManifest = await readTrackingManifest(trackingDir);
      let trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);

      let dynamicArtifacts = trackingRecord?.artifacts.filter(
        (artifact): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } =>
          artifact.platform === platform && isTrackedDynamicArtifact(artifact),
      ) ?? [];
      if (dynamicArtifacts.length === 0) {
        trackingRecord = await recoverRefreshTrackingRecord({
          plugin: options.plugin,
          platform,
          scope,
          cwd: options.cwd,
          env: options.env,
          trackingRecord,
        });
        dynamicArtifacts = trackingRecord?.artifacts.filter(
          (artifact): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } =>
            artifact.platform === platform && isTrackedDynamicArtifact(artifact),
        ) ?? [];
      }
      if (!trackingRecord) {
        continue;
      }
      if (dynamicArtifacts.length === 0) {
        continue;
      }

      const trackedRefreshKeys = uniqueSorted(
        dynamicArtifacts.flatMap((artifact) => artifact.refreshKeys ?? []),
      );
      const triggerKeys = options.resetAllTrackedKeys
        ? trackedRefreshKeys
        : options.changedKeys.filter((key) => trackedRefreshKeys.includes(key));
      if (triggerKeys.length === 0) {
        continue;
      }

      units.push({
        platform,
        scope,
        triggerKeys: uniqueSorted(triggerKeys),
        trackingDir,
        trackingManifest,
        trackingRecord,
        dynamicArtifacts,
        staticArtifacts: trackingRecord.artifacts.filter((artifact) =>
          artifact.platform !== platform || !isTrackedDynamicArtifact(artifact)),
      });
    }
  }

  return units;
}

async function collectRefreshUnitsForReapply(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  units: RefreshUnit[];
  reason?: ArtifactRefreshReceipt['reason'];
}> {
  const candidateScopes: Scope[] = options.commandScope === 'user'
    ? ['user', 'project']
    : [options.commandScope];
  const units: RefreshUnit[] = [];
  let sawTrackedDynamicArtifact = false;

  for (const platform of ['codex', 'claude'] as const) {
    for (const scope of candidateScopes) {
      const trackingDir = platform === 'codex'
        ? resolveCodexPaths(options.cwd, scope, options.env).trackingDir
        : resolveClaudePaths(options.cwd, scope, options.env).trackingDir;
      const trackingManifest = await readTrackingManifest(trackingDir);
      let trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);

      let dynamicArtifacts = trackingRecord?.artifacts.filter(
        (artifact): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } =>
          artifact.platform === platform && isTrackedDynamicArtifact(artifact),
      ) ?? [];
      if (dynamicArtifacts.length === 0) {
        trackingRecord = await recoverRefreshTrackingRecord({
          plugin: options.plugin,
          platform,
          scope,
          cwd: options.cwd,
          env: options.env,
          trackingRecord,
        });
        dynamicArtifacts = trackingRecord?.artifacts.filter(
          (artifact): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } =>
            artifact.platform === platform && isTrackedDynamicArtifact(artifact),
        ) ?? [];
      }
      if (!trackingRecord) {
        continue;
      }
      if (dynamicArtifacts.length === 0) {
        continue;
      }
      sawTrackedDynamicArtifact = true;

      const failedRefreshKeys = uniqueSorted(
        dynamicArtifacts.flatMap((artifact) =>
          artifact.lastRefresh?.status === 'failed' ? artifact.lastRefresh.triggerKeys ?? [] : []),
      );
      const trackedRefreshKeys = uniqueSorted(
        dynamicArtifacts.flatMap((artifact) => artifact.refreshKeys ?? []),
      );
      const triggerKeys = failedRefreshKeys.length > 0 ? failedRefreshKeys : trackedRefreshKeys;
      if (triggerKeys.length === 0) {
        continue;
      }

      units.push({
        platform,
        scope,
        triggerKeys,
        trackingDir,
        trackingManifest,
        trackingRecord,
        dynamicArtifacts,
        staticArtifacts: trackingRecord.artifacts.filter((artifact) =>
          artifact.platform !== platform || !isTrackedDynamicArtifact(artifact)),
      });
    }
  }

  if (units.length > 0) {
    return { units };
  }

  return {
    units,
    reason: sawTrackedDynamicArtifact ? 'no-trigger-keys' : 'no-tracked-dynamic-artifact',
  };
}

async function preflightDynamicArtifactRefresh(options: {
  plugin: PluginMeta;
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  previousArtifacts: GeneratedArtifact[];
}): Promise<void> {
  const adapter = options.platform === 'codex'
    ? new CodexAdapter(options.cwd, undefined, options.env)
    : new ClaudeAdapter(options.cwd, undefined, options.env);
  const status = await adapter.status(options.plugin, options.scope, {
    previousArtifacts: options.previousArtifacts,
  });
  if (options.platform === 'claude') {
    const drifted = status.plugins[0]?.generatedArtifacts.filter((artifact) =>
      artifact.target === 'claude.skill' &&
      (
        (artifact.state === 'disabled' && artifact.exists) ||
        (artifact.state !== 'disabled' && !artifact.exists) ||
        (
          artifact.state !== 'disabled' &&
          artifact.exists &&
          !artifact.currentContentDigest
        ) ||
        (
          artifact.contentDigest &&
          artifact.currentContentDigest &&
          artifact.contentDigest !== artifact.currentContentDigest
        )
      ),
    ) ?? [];
    if (drifted.length > 0) {
      throw new Error('Claude 动态 skill runtime 已漂移；请先运行 status 或 cleanup。');
    }
    return;
  }
  const managedArtifacts = status.plugins[0]?.managedArtifacts ?? [];
  const blockers = managedArtifacts.filter((artifact) =>
    artifact.health === 'registrationDrift' || artifact.health === 'contentDrift',
  );
  if (blockers.length === 0) {
    return;
  }

  throw new Error(blockers.map((artifact) => artifact.diagnostics[0] ?? `${artifact.id} 已漂移。`).join('；'));
}

async function executeRefreshUnit(options: {
  unit: RefreshUnit;
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ExecutedRefreshUnit> {
  const platform = options.unit.platform;
  const refreshesCodexUserDynamicSkill =
    platform === 'codex' &&
    options.unit.scope === 'user' &&
    options.unit.dynamicArtifacts.some((artifact) => artifact.target === 'codex.skill');
  let artifactRollbackState:
    | Awaited<ReturnType<typeof captureArtifactRollbackState>>
    | undefined;
  let nativeRollbackBaseline:
    | Awaited<ReturnType<typeof captureCodexNativePluginRollbackBaseline>>
    | undefined;
  try {
    const installRecordRead = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: {
        plugin: options.plugin.manifest.name,
        platform,
        scope: options.unit.scope,
        ...(options.unit.scope === 'project'
          ? {
              projectKey: platform === 'codex'
                ? await resolveCodexProjectKey(options.cwd)
                : await resolveClaudeProjectKey(options.cwd),
            }
          : {}),
      },
      env: options.env,
    });
    const refreshPlugin = await resolveHistoricalRefreshPlugin({
      currentPlugin: options.plugin,
      platform,
      scope: options.unit.scope,
      recordRead: installRecordRead,
    });
    const refreshTarget = createHistoricalRefreshTarget(options.plugin, refreshPlugin);

    if (platform === 'codex' && options.unit.scope === 'project') {
      await preflightCodexProjectWriteSafety({
        targets: [refreshTarget],
        platforms: ['codex'],
        cwd: options.cwd,
        scope: 'project',
        env: options.env,
        operation: 'refresh',
        previousArtifactsByPlugin: {
          [options.plugin.manifest.name]: options.unit.trackingRecord.artifacts,
        },
      });
    }

    await preflightDynamicArtifactRefresh({
      plugin: refreshPlugin,
      platform,
      scope: options.unit.scope,
      cwd: options.cwd,
      env: options.env,
      previousArtifacts: options.unit.trackingRecord.artifacts,
    });

    const adapter = platform === 'codex'
      ? new CodexAdapter(options.cwd, undefined, options.env)
      : new ClaudeAdapter(options.cwd, undefined, options.env);
    if (options.unit.dynamicArtifacts.length > 0) {
      artifactRollbackState = await captureArtifactRollbackState(
        platform,
        createResolvedTarget(options.plugin),
        options.unit.scope,
        options.cwd,
        options.env,
        options.unit.trackingRecord.artifacts,
      );
    }
    if (refreshesCodexUserDynamicSkill) {
      nativeRollbackBaseline = await captureCodexNativePluginRollbackBaseline(
        options.plugin.manifest.name,
        options.env,
      );
    }
    const refreshedArtifacts = (await adapter.installExtensions(refreshPlugin, options.unit.scope, {
      event: 'refresh',
      changedConfigKeys: options.unit.triggerKeys,
      dynamicOnly: true,
      previousArtifacts: options.unit.trackingRecord.artifacts,
    })).filter((artifact): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } =>
      artifact.platform === platform && isTrackedDynamicArtifact(artifact));
    if (refreshesCodexUserDynamicSkill) {
      const stagedMarketplace = await stageCodexUserNativeHistoricalMarketplace({
        plugin: refreshPlugin,
        refreshedArtifacts,
        previousArtifacts: installRecordRead.status === 'ok'
          ? installRecordRead.value.record.artifacts
          : [],
        env: options.env,
      });
      try {
        await new CodexAdapter(options.cwd, undefined, options.env).installPluginFromMarketplace(refreshPlugin, 'user', {
          marketplacePath: stagedMarketplace.marketplacePath,
        });
      } finally {
        await fs.remove(stagedMarketplace.rootDir).catch(() => undefined);
      }
    }
    return {
      ...options.unit,
      status: 'succeeded',
      refreshedArtifacts,
      ...(artifactRollbackState ? { artifactRollbackState } : {}),
      ...(nativeRollbackBaseline ? { nativeRollbackBaseline } : {}),
    };
  } catch (error) {
    if (artifactRollbackState) {
      await restoreTrackedArtifactRollbackState(
        platform,
        createResolvedTarget(options.plugin),
        options.unit.scope,
        options.cwd,
        options.env,
        artifactRollbackState,
      ).catch(() => undefined);
      await disposeArtifactRollbackState(artifactRollbackState).catch(() => undefined);
    }
    if (nativeRollbackBaseline) {
      await restoreCodexNativePluginRollbackBaseline(nativeRollbackBaseline).catch(() => undefined);
      await disposeCodexNativePluginRollbackBaseline(nativeRollbackBaseline).catch(() => undefined);
    }
    return {
      ...options.unit,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function disposeExecutedRefreshRollback(unit: ExecutedRefreshUnit): Promise<void> {
  await disposeArtifactRollbackState(unit.artifactRollbackState).catch(() => undefined);
  await disposeCodexNativePluginRollbackBaseline(unit.nativeRollbackBaseline).catch(() => undefined);
  unit.artifactRollbackState = undefined;
  unit.nativeRollbackBaseline = undefined;
}

async function rollbackExecutedRefreshUnit(options: {
  unit: ExecutedRefreshUnit;
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const errors: string[] = [];
  if (options.unit.artifactRollbackState) {
    try {
      await restoreTrackedArtifactRollbackState(
        options.unit.platform,
        createResolvedTarget(options.plugin),
        options.unit.scope,
        options.cwd,
        options.env,
        options.unit.artifactRollbackState,
      );
    } catch (error) {
      errors.push(`artifact runtime 回滚失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.unit.nativeRollbackBaseline) {
    try {
      await restoreCodexNativePluginRollbackBaseline(options.unit.nativeRollbackBaseline);
    } catch (error) {
      errors.push(`Codex native runtime 回滚失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await disposeExecutedRefreshRollback(options.unit);
  if (errors.length > 0) {
    throw new Error(errors.join('；'));
  }
}

async function createRefreshReach(options: {
  pluginName: string;
  platform: PlatformName;
  commandScope: Scope;
  refreshedScopes: Scope[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ArtifactRefreshReach> {
  let knownProjectTargetsOutsideReach: string[] = [];
  try {
    const projectKey = options.platform === 'codex'
      ? await resolveCodexProjectKey(options.cwd)
      : await resolveClaudeProjectKey(options.cwd);
    const ledger = await readInstalledLedger(options.env);
    knownProjectTargetsOutsideReach = uniqueSorted(
      Object.keys(ledger.plugins[options.pluginName]?.platforms[options.platform]?.projectScopes ?? {})
        .filter((key) => key !== projectKey)
        .map((key) => `project:${key}`),
    );
  } catch {
    knownProjectTargetsOutsideReach = [];
  }

  return {
    commandScope: options.commandScope,
    refreshedUserTarget: options.refreshedScopes.includes('user'),
    refreshedCurrentProjectTarget: options.refreshedScopes.includes('project'),
    scannedHistoricalProjects: false,
    historicalProjectTargetsMayBeStale: knownProjectTargetsOutsideReach.length > 0,
    knownProjectTargetsOutsideReach,
  };
}

async function writeRefreshTrackingResult(options: {
  unit: ExecutedRefreshUnit;
  refreshReach: ArtifactRefreshReach;
}): Promise<WrittenRefreshResult> {
  const artifactsWithRefresh = options.unit.status === 'succeeded'
    ? withRefreshMetadata(
        options.unit.refreshedArtifacts ?? [],
        buildLastRefresh({
          status: 'succeeded',
          triggerKeys: options.unit.triggerKeys,
        }),
        options.refreshReach,
      )
    : withRefreshMetadata(
        options.unit.dynamicArtifacts,
        buildLastRefresh({
          status: 'failed',
          triggerKeys: options.unit.triggerKeys,
          error: options.unit.error,
        }),
        options.refreshReach,
      );

  try {
    await writeTrackingManifest(
      options.unit.trackingDir,
      upsertTrackingRecordInManifest(
        options.unit.trackingManifest,
        options.unit.trackingRecord.name,
        mergeGeneratedArtifacts(options.unit.staticArtifacts, artifactsWithRefresh),
      ),
    );
    return {
      status: options.unit.status,
      ...(options.unit.error ? { error: options.unit.error } : {}),
      artifacts: artifactsWithRefresh,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refreshError = options.unit.error
      ? `${options.unit.error}；tracking 写入失败：${message}`
      : `tracking 写入失败：${message}`;
    return {
      status: 'failed',
      error: refreshError,
      artifacts: withRefreshMetadata(
        options.unit.dynamicArtifacts,
        buildLastRefresh({
          status: 'failed',
          triggerKeys: options.unit.triggerKeys,
          error: refreshError,
        }),
        options.refreshReach,
      ),
    };
  }
}

async function finalizeExecutedRefreshUnits(options: {
  units: ExecutedRefreshUnit[];
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
  refreshReachByPlatform: Map<PlatformName, ArtifactRefreshReach>;
  fallbackRefreshReach: ArtifactRefreshReach;
}): Promise<WrittenRefreshResult[]> {
  const results: WrittenRefreshResult[] = [];
  for (const unit of options.units) {
    const refreshReach = options.refreshReachByPlatform.get(unit.platform) ?? options.fallbackRefreshReach;
    let result = await writeRefreshTrackingResult({ unit, refreshReach });
    let runtimeRolledBack = false;
    const effectiveUnit: ExecutedRefreshUnit = {
      ...unit,
      status: result.status,
      ...(result.error ? { error: result.error } : {}),
    };

    try {
      if (unit.status === 'succeeded' && result.status === 'failed') {
        await rollbackExecutedRefreshUnit({
          unit,
          plugin: options.plugin,
          cwd: options.cwd,
          env: options.env,
        });
        runtimeRolledBack = true;
      }
      await syncInstallStateAfterRefresh({
        plugin: options.plugin,
        cwd: options.cwd,
        env: options.env,
        unit: effectiveUnit,
        artifacts: result.artifacts,
      });
      await disposeExecutedRefreshRollback(unit);
    } catch (error) {
      const errors = [error instanceof Error ? error.message : String(error)];
      if (unit.status === 'succeeded' && !runtimeRolledBack) {
        try {
          await rollbackExecutedRefreshUnit({
            unit,
            plugin: options.plugin,
            cwd: options.cwd,
            env: options.env,
          });
        } catch (rollbackError) {
          errors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      } else {
        await disposeExecutedRefreshRollback(unit);
      }
      try {
        await writeTrackingManifest(unit.trackingDir, unit.trackingManifest);
      } catch (trackingRollbackError) {
        errors.push(
          `tracking 回滚失败：${trackingRollbackError instanceof Error
            ? trackingRollbackError.message
            : String(trackingRollbackError)}`,
        );
      }
      let message = errors.join('；');
      const failedArtifacts = withRefreshMetadata(
        unit.dynamicArtifacts,
        buildLastRefresh({
          status: 'failed',
          triggerKeys: unit.triggerKeys,
          error: message,
        }),
        refreshReach,
      );
      try {
        await syncInstallStateAfterRefresh({
          plugin: options.plugin,
          cwd: options.cwd,
          env: options.env,
          unit: {
            ...unit,
            status: 'failed',
            error: message,
          },
          artifacts: failedArtifacts,
        });
      } catch (diagnosticError) {
        errors.push(
          `dynamic diagnostic cache 写入失败：${diagnosticError instanceof Error
            ? diagnosticError.message
            : String(diagnosticError)}`,
        );
        message = errors.join('；');
      }
      result = {
        status: 'failed',
        error: message,
        artifacts: withRefreshMetadata(
          unit.dynamicArtifacts,
          buildLastRefresh({
            status: 'failed',
            triggerKeys: unit.triggerKeys,
            error: message,
          }),
          refreshReach,
        ),
      };
    }
    results.push(result);
  }
  return results;
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
    ...(artifact.refreshKeys === undefined ? {} : { refreshKeys: [...artifact.refreshKeys] }),
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
): DynamicArtifactDiagnosticEntry | null {
  if (!artifact.id || !artifact.target) {
    return null;
  }
  const state = artifact.state ?? 'present';
  const event: 'install' | 'upgrade' | 'config' | undefined = artifact.lastRefresh?.event === 'refresh'
    ? 'config'
    : artifact.lastRefresh?.event;
  const lastRefresh = artifact.lastRefresh === undefined || event === undefined
    ? undefined
    : {
        status: artifact.lastRefresh.status === 'succeeded' ? 'success' as const : 'failed' as const,
        at: artifact.lastRefresh.updatedAt,
        event,
        ...(artifact.lastRefresh.error ? { error: artifact.lastRefresh.error } : {}),
      };

  return {
    id: artifact.id,
    target: artifact.target,
    state,
    ...(state === 'disabled' && artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.refreshKeys?.length ? { refreshKeys: [...artifact.refreshKeys] } : {}),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
    ...(lastRefresh ? { lastRefresh } : {}),
    ...(artifact.refreshReach === undefined
      ? {}
      : {
          refreshReach: {
            commandScope: scope === 'project' ? 'projectShared' : 'user',
            ...(artifact.refreshReach.refreshedUserTarget === undefined
              ? {}
              : { refreshedUserTarget: artifact.refreshReach.refreshedUserTarget }),
            ...(artifact.refreshReach.refreshedCurrentProjectTarget === undefined
              ? {}
              : { refreshedCurrentProjectTarget: artifact.refreshReach.refreshedCurrentProjectTarget }),
          },
        }),
  };
}

function createDynamicDiagnosticCacheValue(options: {
  recordFile: InstallRecordFile;
  location: PluginLocation;
  artifacts: readonly GeneratedArtifact[];
  updatedAt: string;
}): DynamicArtifactDiagnosticCache {
  return {
    version: 1,
    recordId: options.recordFile.recordId,
    location: options.location,
    updatedAt: options.updatedAt,
    artifacts: options.artifacts
      .map((artifact) => toDynamicDiagnosticEntry(artifact, options.location.scope))
      .filter((artifact): artifact is DynamicArtifactDiagnosticEntry => Boolean(artifact)),
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
  return artifacts.filter((artifact) => {
    const relativePath = path.relative(repoRoot, artifact.path);
    return !(
      relativePath === '' ||
      relativePath === '..' ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    );
  });
}

async function syncInstallStateAfterRefresh(options: {
  plugin: PluginMeta;
  cwd: string;
  env: NodeJS.ProcessEnv;
  unit: ExecutedRefreshUnit;
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
}): Promise<void> {
  const location: PluginLocation = options.unit.scope === 'project'
    ? {
        plugin: options.plugin.manifest.name,
        platform: options.unit.platform,
        scope: 'project',
        projectKey: options.unit.platform === 'codex'
          ? await resolveCodexProjectKey(options.cwd)
          : await resolveClaudeProjectKey(options.cwd),
      }
    : {
        plugin: options.plugin.manifest.name,
        platform: options.unit.platform,
        scope: 'user',
      };
  const recordRead = await readInstallRecordForLocation({
    cwd: options.cwd,
    location,
    env: options.env,
  });
  if (recordRead.status !== 'ok') {
    return;
  }

  const updatedAt = new Date().toISOString();
  const currentRecord = recordRead.value;
  const currentCacheRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location,
    currentRecord,
    env: options.env,
  });
  const currentCache = currentCacheRead.status === 'ok' ? currentCacheRead.value : null;
  const mergedArtifacts = mergeGeneratedArtifacts(options.unit.staticArtifacts, options.artifacts);
  const nextRecord: InstallRecordFile = {
    ...structuredClone(currentRecord),
    record: {
      ...structuredClone(currentRecord.record),
      updatedAt,
      artifacts: toInstallRecordArtifacts(mergedArtifacts),
    },
  };
  const nextCache = createDynamicDiagnosticCacheValue({
    recordFile: nextRecord,
    location,
    artifacts: mergedArtifacts,
    updatedAt,
  });

  const stages: InstallStateTransactionStage[] = [];
  if (options.unit.status === 'succeeded') {
    if (options.unit.scope === 'project') {
      const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
      const projectRoot = resolveProjectArtifactProjectRoot(options.cwd, location);
      const repoVisibleArtifacts = collectRepoVisibleProjectArtifacts(repoRoot, mergedArtifacts);
      const locator = createProjectArtifactSharedLocator({
        plugin: options.plugin.manifest.name,
        platform: options.unit.platform,
        repoRoot,
        projectRoot,
      });
      if (repoVisibleArtifacts.length > 0) {
        const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
        const identityValue: ProjectArtifactIdentityFile = {
          version: 1,
          sharedIdentityId: path.basename(identityPath, '.json'),
          locator,
          source: structuredClone(currentRecord.record.source),
          generatedAt: updatedAt,
          artifacts: repoVisibleArtifacts.map((artifact) =>
            toProjectArtifactIdentityArtifact(artifact, repoRoot),
          ),
        };
        stages.push(await createProjectArtifactIdentityWriteStage({
          repoRoot,
          locator,
          value: identityValue,
        }));
      } else {
        stages.push(createProjectArtifactIdentityDeleteStage({
          repoRoot,
          locator,
        }));
      }
    }
    stages.push(await createInstallRecordWriteStage({
      cwd: options.cwd,
      location,
      value: nextRecord,
      env: options.env,
    }));
  }
  stages.push(await createDynamicArtifactDiagnosticCacheWriteStage({
    cwd: options.cwd,
    location,
    value: nextCache,
    currentRecord,
    currentCache,
    mode: options.unit.status === 'succeeded' ? 'accepted' : 'refreshFailed',
    env: options.env,
  }));

  await runInstallStateTransaction({ stages });
}

function createRefreshNextSteps(pluginName: string, units: ExecutedRefreshUnit[]): string[] {
  return uniqueSorted(
    units
      .filter((unit) => unit.status === 'failed')
      .map((unit) => `aw status ${pluginName} -p ${unit.platform} -s ${unit.scope}`),
  );
}

export async function refreshArtifactsAfterConfigWrite(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  changedKeys?: string[];
  resetAllTrackedKeys?: boolean;
}): Promise<ArtifactRefreshReceipt> {
  const env = options.env ?? process.env;
  const changedKeys = uniqueSorted(options.changedKeys ?? []);
  try {
    const units = await collectRefreshUnits({
      plugin: options.plugin,
      commandScope: options.commandScope,
      cwd: options.cwd,
      env,
      changedKeys,
      resetAllTrackedKeys: options.resetAllTrackedKeys === true,
    });

    if (units.length === 0) {
      return {
        attempted: false,
        status: 'skipped',
        triggerKeys: changedKeys,
        artifacts: [],
      };
    }

    const executedUnits: ExecutedRefreshUnit[] = [];
    for (const unit of units) {
      executedUnits.push(await executeRefreshUnit({
        unit,
        plugin: options.plugin,
        cwd: options.cwd,
        env,
      }));
    }

    const refreshReachByPlatform = new Map<PlatformName, ArtifactRefreshReach>();
    for (const platform of uniqueSorted(executedUnits.map((unit) => unit.platform)) as PlatformName[]) {
      refreshReachByPlatform.set(platform, await createRefreshReach({
        pluginName: options.plugin.manifest.name,
        platform,
        commandScope: options.commandScope,
        refreshedScopes: executedUnits
          .filter((unit) => unit.platform === platform && unit.status === 'succeeded')
          .map((unit) => unit.scope),
        cwd: options.cwd,
        env,
      }));
    }
    const refreshReachValues = [...refreshReachByPlatform.values()];
    const refreshReach: ArtifactRefreshReach = {
      commandScope: options.commandScope,
      refreshedUserTarget: refreshReachValues.some((entry) => entry.refreshedUserTarget),
      refreshedCurrentProjectTarget: refreshReachValues.some((entry) => entry.refreshedCurrentProjectTarget),
      scannedHistoricalProjects: false,
      historicalProjectTargetsMayBeStale: refreshReachValues.some(
        (entry) => entry.historicalProjectTargetsMayBeStale),
      knownProjectTargetsOutsideReach: uniqueSorted(refreshReachValues.flatMap(
        (entry) => entry.knownProjectTargetsOutsideReach ?? [])),
    };

    const writtenResults = await finalizeExecutedRefreshUnits({
      units: executedUnits,
      plugin: options.plugin,
      cwd: options.cwd,
      env,
      refreshReachByPlatform,
      fallbackRefreshReach: refreshReach,
    });

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(
        executedUnits[index].platform,
        executedUnits[index].scope,
        result.status,
        result.artifacts,
      ),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));
    const nextSteps = createRefreshNextSteps(
      options.plugin.manifest.name,
      executedUnits.map((unit, index) => ({
        ...unit,
        status: writtenResults[index]?.status ?? 'failed',
        ...(writtenResults[index]?.error ? { error: writtenResults[index].error } : {}),
      })),
    );

    return {
      attempted: true,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      triggerKeys: uniqueSorted(units.flatMap((unit) => unit.triggerKeys)),
      artifacts,
      scopeReach: refreshReach,
      ...(errors.length > 0 ? { error: errors.join('；') } : {}),
      ...(nextSteps.length > 0 ? { nextSteps } : {}),
    };
  } catch (error) {
    return {
      attempted: changedKeys.length > 0 || options.resetAllTrackedKeys === true,
      status: 'failed',
      triggerKeys: changedKeys,
      artifacts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function reapplyConfigRefresh(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ArtifactRefreshReceipt> {
  const env = options.env ?? process.env;
  try {
    const collected = await collectRefreshUnitsForReapply({
      plugin: options.plugin,
      commandScope: options.commandScope,
      cwd: options.cwd,
      env,
    });
    const units = collected.units;

    if (units.length === 0) {
      return {
        attempted: false,
        status: 'skipped',
        triggerKeys: [],
        artifacts: [],
        ...(collected.reason ? { reason: collected.reason } : {}),
      };
    }

    const executedUnits: ExecutedRefreshUnit[] = [];
    for (const unit of units) {
      executedUnits.push(await executeRefreshUnit({
        unit,
        plugin: options.plugin,
        cwd: options.cwd,
        env,
      }));
    }

    const refreshReachByPlatform = new Map<PlatformName, ArtifactRefreshReach>();
    for (const platform of uniqueSorted(executedUnits.map((unit) => unit.platform)) as PlatformName[]) {
      refreshReachByPlatform.set(platform, await createRefreshReach({
        pluginName: options.plugin.manifest.name,
        platform,
        commandScope: options.commandScope,
        refreshedScopes: executedUnits
          .filter((unit) => unit.platform === platform && unit.status === 'succeeded')
          .map((unit) => unit.scope),
        cwd: options.cwd,
        env,
      }));
    }
    const refreshReachValues = [...refreshReachByPlatform.values()];
    const refreshReach: ArtifactRefreshReach = {
      commandScope: options.commandScope,
      refreshedUserTarget: refreshReachValues.some((entry) => entry.refreshedUserTarget),
      refreshedCurrentProjectTarget: refreshReachValues.some((entry) => entry.refreshedCurrentProjectTarget),
      scannedHistoricalProjects: false,
      historicalProjectTargetsMayBeStale: refreshReachValues.some(
        (entry) => entry.historicalProjectTargetsMayBeStale),
      knownProjectTargetsOutsideReach: uniqueSorted(refreshReachValues.flatMap(
        (entry) => entry.knownProjectTargetsOutsideReach ?? [])),
    };

    const writtenResults = await finalizeExecutedRefreshUnits({
      units: executedUnits,
      plugin: options.plugin,
      cwd: options.cwd,
      env,
      refreshReachByPlatform,
      fallbackRefreshReach: refreshReach,
    });

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(
        executedUnits[index].platform,
        executedUnits[index].scope,
        result.status,
        result.artifacts,
      ),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));
    const nextSteps = createRefreshNextSteps(
      options.plugin.manifest.name,
      executedUnits.map((unit, index) => ({
        ...unit,
        status: writtenResults[index]?.status ?? 'failed',
        ...(writtenResults[index]?.error ? { error: writtenResults[index].error } : {}),
      })),
    );

    return {
      attempted: true,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      triggerKeys: uniqueSorted(units.flatMap((unit) => unit.triggerKeys)),
      artifacts,
      scopeReach: refreshReach,
      ...(errors.length > 0 ? { error: errors.join('；') } : {}),
      ...(nextSteps.length > 0 ? { nextSteps } : {}),
    };
  } catch (error) {
    return {
      attempted: true,
      status: 'failed',
      triggerKeys: [],
      artifacts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
