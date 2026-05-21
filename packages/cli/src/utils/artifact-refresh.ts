import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { CodexAdapter } from '../adapters/codex.js';
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
  Scope,
  SkillTriggerPreference,
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
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
  patchCodexOpenAiYaml,
} from './skill-trigger-preferences.js';
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
import { resolveAwHome, resolveCodexPaths, resolveCodexProjectKey } from './paths.js';
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
  platform: 'codex';
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
}

function isTrackedCodexDynamicArtifact(
  artifact: GeneratedArtifact,
): artifact is GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState } {
  return (
    artifact.platform === 'codex' &&
    typeof artifact.id === 'string' &&
    (
      artifact.target === 'codex.developerInstructionsBlock' ||
      artifact.target === 'codex.agentRole' ||
      artifact.target === 'codex.skill'
    ) &&
    (artifact.state === 'present' || artifact.state === 'disabled')
  );
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
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

async function inferCodexUserDynamicSkillPreferenceFromRuntime(options: {
  pluginName: string;
  artifactKeys: string[];
  env: NodeJS.ProcessEnv;
}): Promise<'manual' | 'default' | undefined> {
  for (const artifactKey of options.artifactKeys) {
    const metadataPath = `${getLocalMarketplaceCodexSkillRoot(
      resolveAwHome(options.env),
      options.pluginName,
      artifactKey,
    )}/agents/openai.yaml`;
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

function summarizeArtifacts(
  scope: Scope,
  status: 'succeeded' | 'failed',
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>,
): ArtifactRefreshReceiptArtifact[] {
  return artifacts.map((artifact) => ({
    platform: 'codex',
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
  scope: Scope;
  reason: string;
}): Error {
  return new Error(
    `无法使用 ${options.pluginName} (${options.scope}) 的 historical lifecycle bundle 刷新 dynamic artifacts：${options.reason}。` +
      `请先运行 \`aw repair ${options.pluginName} --platform codex --scope ${options.scope}\` 重建 install record 后再试。`,
  );
}

async function resolveHistoricalRefreshPlugin(options: {
  currentPlugin: PluginMeta;
  scope: Scope;
  recordRead: InstallStateReadResult<InstallRecordFile>;
}): Promise<PluginMeta> {
  const pluginName = options.currentPlugin.manifest.name;
  if (options.recordRead.status !== 'ok') {
    throw createHistoricalRefreshBundleError({
      pluginName,
      scope: options.scope,
      reason: `install record 不可用（${formatInstallRecordReadFailure(options.recordRead)}）`,
    });
  }

  const lifecycle = options.recordRead.value.record.lifecycle;
  if (!lifecycle) {
    throw createHistoricalRefreshBundleError({
      pluginName,
      scope: options.scope,
      reason: 'install record 缺少 historical lifecycle runtime',
    });
  }

  if (!(await fs.pathExists(lifecycle.bundleRoot))) {
    throw createHistoricalRefreshBundleError({
      pluginName,
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
      scope: options.scope,
      reason: `historical manifest digest 不匹配：expected ${lifecycle.sourceManifestDigest}, got ${manifestDigest}`,
    });
  }
  if (bundleFingerprint !== lifecycle.bundleFingerprint) {
    throw createHistoricalRefreshBundleError({
      pluginName,
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
  skillTriggerPreference?: SkillTriggerPreference;
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

    if (options.skillTriggerPreference) {
      const materialization = await materializeSkillTriggerPreference({
        pluginName,
        platform: 'codex',
        resolvedOptions: {
          skillTriggerPreference: options.skillTriggerPreference,
        },
        embeddedRoot: stagingRoot,
        marketplaceRootOrStagingRoot: stagingRoot,
        mode: 'bestEffortReplay',
      });
      await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle)
        .catch(() => undefined);
    }

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

  for (const scope of candidateScopes) {
    const trackingDir = resolveCodexPaths(options.cwd, scope, options.env).trackingDir;
    const trackingManifest = await readTrackingManifest(trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    if (!trackingRecord) {
      continue;
    }

    const dynamicArtifacts = trackingRecord.artifacts.filter(isTrackedCodexDynamicArtifact);
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
      scope,
      triggerKeys: uniqueSorted(triggerKeys),
      trackingDir,
      trackingManifest,
      trackingRecord,
      dynamicArtifacts,
      staticArtifacts: trackingRecord.artifacts.filter((artifact) => !isTrackedCodexDynamicArtifact(artifact)),
    });
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

  for (const scope of candidateScopes) {
    const trackingDir = resolveCodexPaths(options.cwd, scope, options.env).trackingDir;
    const trackingManifest = await readTrackingManifest(trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    if (!trackingRecord) {
      continue;
    }

    const dynamicArtifacts = trackingRecord.artifacts.filter(isTrackedCodexDynamicArtifact);
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
      scope,
      triggerKeys,
      trackingDir,
      trackingManifest,
      trackingRecord,
      dynamicArtifacts,
      staticArtifacts: trackingRecord.artifacts.filter((artifact) => !isTrackedCodexDynamicArtifact(artifact)),
    });
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
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const adapter = new CodexAdapter(options.cwd, undefined, options.env);
  const status = await adapter.status(options.plugin, options.scope);
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
  const refreshesCodexUserDynamicSkill =
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
        platform: 'codex',
        scope: options.unit.scope,
        ...(options.unit.scope === 'project'
          ? { projectKey: await resolveCodexProjectKey(options.cwd) }
          : {}),
      },
      env: options.env,
    });
    const refreshPlugin = await resolveHistoricalRefreshPlugin({
      currentPlugin: options.plugin,
      scope: options.unit.scope,
      recordRead: installRecordRead,
    });
    const refreshTarget = createHistoricalRefreshTarget(options.plugin, refreshPlugin);

    if (options.unit.scope === 'project') {
      await preflightCodexProjectWriteSafety({
        targets: [refreshTarget],
        platforms: ['codex'],
        cwd: options.cwd,
        scope: 'project',
        env: options.env,
        operation: 'refresh',
      });
    }

    await preflightDynamicArtifactRefresh({
      plugin: refreshPlugin,
      scope: options.unit.scope,
      cwd: options.cwd,
      env: options.env,
    });

    const adapter = new CodexAdapter(options.cwd, undefined, options.env);
    if (refreshesCodexUserDynamicSkill) {
      artifactRollbackState = await captureArtifactRollbackState(
        'codex',
        createResolvedTarget(options.plugin),
        options.unit.scope,
        options.cwd,
        options.env,
      );
      nativeRollbackBaseline = await captureCodexNativePluginRollbackBaseline(
        options.plugin.manifest.name,
        options.env,
      );
    }
    const ledger = await readInstalledLedger(options.env);
    let skillTriggerPreference =
      installRecordRead.status === 'ok'
        ? installRecordRead.value.record.options?.skillTriggerPreference
        : ledger.plugins[options.plugin.manifest.name]?.platforms.codex?.userScope?.installOptions?.skillTriggerPreference;
    if (refreshesCodexUserDynamicSkill) {
      const runtimeSkillTriggerPreference = await inferCodexUserDynamicSkillPreferenceFromRuntime({
        pluginName: options.plugin.manifest.name,
        artifactKeys: uniqueSorted(
          options.unit.dynamicArtifacts
            .filter((artifact) => artifact.target === 'codex.skill' && Boolean(artifact.artifactKey))
            .map((artifact) => artifact.artifactKey as string),
        ),
        env: options.env,
      });
      if (
        runtimeSkillTriggerPreference === 'manual' &&
        skillTriggerPreference !== 'manual'
      ) {
        skillTriggerPreference = 'manual';
      } else if (!skillTriggerPreference) {
        skillTriggerPreference = runtimeSkillTriggerPreference;
      }
    }
    const refreshedArtifacts = (await adapter.installExtensions(refreshPlugin, options.unit.scope, {
      event: 'refresh',
      changedConfigKeys: options.unit.triggerKeys,
      dynamicOnly: true,
      skillTriggerPreference,
    })).filter(isTrackedCodexDynamicArtifact);
    if (
      refreshesCodexUserDynamicSkill &&
      skillTriggerPreference &&
      skillTriggerPreference !== 'default'
    ) {
      for (const artifact of refreshedArtifacts) {
        if (artifact.target !== 'codex.skill' || !artifact.artifactKey || artifact.state !== 'present') {
          continue;
        }
        await patchCodexOpenAiYaml(
          `${getLocalMarketplaceCodexSkillRoot(
            resolveAwHome(options.env),
            options.plugin.manifest.name,
            artifact.artifactKey,
          )}/agents/openai.yaml`,
          skillTriggerPreference,
        );
      }
    }
    if (refreshesCodexUserDynamicSkill) {
      const stagedMarketplace = await stageCodexUserNativeHistoricalMarketplace({
        plugin: refreshPlugin,
        refreshedArtifacts,
        previousArtifacts: installRecordRead.status === 'ok'
          ? installRecordRead.value.record.artifacts
          : [],
        ...(skillTriggerPreference ? { skillTriggerPreference } : {}),
        env: options.env,
      });
      try {
        await adapter.installPluginFromMarketplace(refreshPlugin, 'user', {
          marketplacePath: stagedMarketplace.marketplacePath,
        });
      } finally {
        await fs.remove(stagedMarketplace.rootDir).catch(() => undefined);
      }
    }
    if (artifactRollbackState) {
      await disposeArtifactRollbackState(artifactRollbackState).catch(() => undefined);
    }
    await disposeCodexNativePluginRollbackBaseline(nativeRollbackBaseline).catch(() => undefined);

    return {
      ...options.unit,
      status: 'succeeded',
      refreshedArtifacts,
    };
  } catch (error) {
    if (artifactRollbackState) {
      await restoreTrackedArtifactRollbackState(
        'codex',
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

async function createRefreshReach(options: {
  pluginName: string;
  commandScope: Scope;
  refreshedScopes: Scope[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ArtifactRefreshReach> {
  let knownProjectTargetsOutsideReach: string[] = [];
  try {
    const projectKey = await resolveCodexProjectKey(options.cwd);
    const ledger = await readInstalledLedger(options.env);
    knownProjectTargetsOutsideReach = uniqueSorted(
      Object.keys(ledger.plugins[options.pluginName]?.platforms.codex?.projectScopes ?? {})
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
}): Promise<{
  status: ExecutedRefreshUnit['status'];
  error?: string;
  artifacts: Array<GeneratedArtifact & { id: string; target: ArtifactTarget; state: ArtifactState }>;
}> {
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
    return {
      status: 'failed',
      error: options.unit.error ? `${options.unit.error}；tracking 写入失败：${message}` : `tracking 写入失败：${message}`,
      artifacts: artifactsWithRefresh,
    };
  }
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
): DynamicArtifactDiagnosticEntry | null {
  if (!artifact.id || !artifact.target) {
    return null;
  }
  const state = artifact.state ?? 'present';
  const event: 'install' | 'upgrade' | 'config' | 'repair' | undefined = artifact.lastRefresh?.event === 'refresh'
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
        platform: 'codex',
        scope: 'project',
        projectKey: await resolveCodexProjectKey(options.cwd),
      }
    : {
        plugin: options.plugin.manifest.name,
        platform: 'codex',
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
        platform: 'codex',
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
      .map((unit) => `aw status ${pluginName} -p codex -s ${unit.scope}`),
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

    const refreshedScopes = executedUnits
      .filter((unit) => unit.status === 'succeeded')
      .map((unit) => unit.scope);
    const refreshReach = await createRefreshReach({
      pluginName: options.plugin.manifest.name,
      commandScope: options.commandScope,
      refreshedScopes,
      cwd: options.cwd,
      env,
    });

    const writtenResults = [];
    for (const unit of executedUnits) {
      writtenResults.push(await writeRefreshTrackingResult({
        unit,
        refreshReach,
      }));
    }
    for (const [index, unit] of executedUnits.entries()) {
      await syncInstallStateAfterRefresh({
        plugin: options.plugin,
        cwd: options.cwd,
        env,
        unit,
        artifacts: writtenResults[index]?.artifacts ?? [],
      });
    }

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(executedUnits[index].scope, result.status, result.artifacts),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));
    const nextSteps = createRefreshNextSteps(options.plugin.manifest.name, executedUnits);

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

    const refreshedScopes = executedUnits
      .filter((unit) => unit.status === 'succeeded')
      .map((unit) => unit.scope);
    const refreshReach = await createRefreshReach({
      pluginName: options.plugin.manifest.name,
      commandScope: options.commandScope,
      refreshedScopes,
      cwd: options.cwd,
      env,
    });

    const writtenResults = [];
    for (const unit of executedUnits) {
      writtenResults.push(await writeRefreshTrackingResult({
        unit,
        refreshReach,
      }));
    }
    for (const [index, unit] of executedUnits.entries()) {
      await syncInstallStateAfterRefresh({
        plugin: options.plugin,
        cwd: options.cwd,
        env,
        unit,
        artifacts: writtenResults[index]?.artifacts ?? [],
      });
    }

    const artifacts = writtenResults.flatMap((result, index) =>
      summarizeArtifacts(executedUnits[index].scope, result.status, result.artifacts),
    );
    const errors = writtenResults
      .map((result) => result.error)
      .filter((error): error is string => Boolean(error));
    const nextSteps = createRefreshNextSteps(options.plugin.manifest.name, executedUnits);

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
