import path from 'node:path';

import { refreshArtifactsAfterConfigWrite, type ArtifactRefreshReceipt } from './artifact-refresh.js';
import { createArtifactConfigDigest } from './artifact-plan.js';
import {
  assertSafePluginConfigSegment,
  collectProjectArtifactConfigBoundaryIssues,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  resolveProjectArtifactRenderConfig,
  summarizeEffectivePluginConfig,
} from './plugin-config.js';
import { resolveArtifactRendererTarget } from './artifact-renderer.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from './plugin-scripts.js';
import { getTrackingRecord, readTrackingManifest } from './tracking.js';
import { collectInstallEvidence, type CurrentCatalogEvidenceInput } from '../install-state/evidence.js';
import {
  readDynamicArtifactDiagnosticCacheForLocation,
  readInstallRecordForLocation,
} from '../install-state/facade.js';
import {
  assertProjectSharedConfigPathVisible,
  classifyProjectBoundaryPath,
  ensureProjectPrivateStateIgnore,
  type ProjectBoundaryWarning,
} from '../install-state/project-boundary.js';
import {
  createProjectArtifactSharedLocator,
  getProjectArtifactSharedIdentityPath,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import {
  createDynamicArtifactDiagnosticCacheWriteStage,
  createInstallRecordWriteStage,
  createProjectArtifactIdentityDeleteStage,
  createProjectArtifactIdentityWriteStage,
  type InstallStateTransactionStage,
  runInstallStateTransaction,
} from '../install-state/transactions.js';
import type {
  DynamicArtifactDiagnosticCache,
  DynamicArtifactDiagnosticEntry,
  InstallRecordArtifact,
  InstallRecordFile,
  PluginLocation,
  ProjectArtifactIdentityArtifact,
  ProjectArtifactIdentityFile,
} from '../install-state/types.js';
import type { GeneratedArtifact, PluginMeta, PluginManifestSource, Scope } from '../types.js';
import { resolveCodexPaths, resolveCodexProjectKey } from './paths.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  artifactRefresh: ArtifactRefreshReceipt;
  configRefreshSkippedReason?: 'projectLocalOverride' | 'adoptExistingRequired' | 'noRefreshTarget';
  warnings: ProjectBoundaryWarning[];
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  existed: boolean;
  deleted: boolean;
  artifactRefresh: ArtifactRefreshReceipt;
  configRefreshSkippedReason?: 'projectLocalOverride' | 'noRefreshTarget';
  warnings: ProjectBoundaryWarning[];
}

function uniqueInOrder(values: string[]): string[] {
  return [...new Set(values)];
}

function createSkippedRefreshReceipt(triggerKeys: string[] = []): ArtifactRefreshReceipt {
  return {
    attempted: false,
    status: 'skipped',
    triggerKeys,
    artifacts: [],
  };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
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
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.kind === 'skill' || artifact.kind === 'mcpServer'
      ? { ownershipMarker: artifact.artifactKey ?? artifact.path }
      : {}),
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
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
  };
}

function collectRepoVisibleProjectArtifacts(
  repoRoot: string,
  artifacts: readonly GeneratedArtifact[],
): GeneratedArtifact[] {
  return artifacts.filter((artifact) => {
    const relativePath = path.relative(repoRoot, artifact.path);
    if (
      relativePath === '' ||
      relativePath.startsWith(`..${path.sep}`) ||
      relativePath === '..' ||
      path.isAbsolute(relativePath)
    ) {
      return false;
    }
    const classification = classifyProjectBoundaryPath({
      repoRoot,
      path: artifact.path,
    });
    return classification.category !== 'privateState'
      && classification.category !== 'projectLocalConfig'
      && classification.category !== 'ignoredState';
  });
}

async function buildCurrentCatalogSource(
  plugin: PluginMeta,
): Promise<CurrentCatalogEvidenceInput['source']> {
  return {
    pluginVersion: plugin.manifest.version,
    manifestDigest: await calculateFileDigest(plugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(plugin.rootDir),
  };
}

async function buildDynamicCatalogArtifacts(
  plugin: PluginMeta,
  scope: Scope,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CurrentCatalogEvidenceInput['dynamicArtifacts']> {
  const target = await resolveArtifactRendererTarget(plugin);
  const renderConfig = await resolveProjectArtifactRenderConfig({
    pluginName: plugin.manifest.name,
    manifest: plugin.manifest,
    cwd,
    env,
  });
  const digestSalt = target.rendererDigest ?? target.manifestDigest ?? await calculateFileDigest(plugin.manifestPath);
  return (plugin.manifest.artifacts?.targets ?? [])
    .filter((artifact) => artifact.platform === 'codex' && artifact.scopes.includes(scope))
    .map((artifact) => ({
      id: artifact.id,
      target: artifact.target,
      state: artifact.states.includes('present') ? 'present' : artifact.states[0] ?? 'present',
      ...(artifact.roleKey ? { roleKey: artifact.roleKey } : {}),
      configDigest: createArtifactConfigDigest({
        artifact: {
          id: artifact.id,
          platform: artifact.platform,
          target: artifact.target,
          refreshKeys: artifact.refreshKeys,
        },
        configValues: renderConfig.values,
        digestSalt,
      }),
    }));
}

async function buildBaseCurrentCatalog(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CurrentCatalogEvidenceInput> {
  return {
    source: await buildCurrentCatalogSource(options.plugin),
    artifacts: [],
    dynamicArtifacts: await buildDynamicCatalogArtifacts(
      options.plugin,
      options.scope,
      options.cwd,
      options.env,
    ),
  };
}

function collectProjectRefreshKeys(manifest: PluginManifestSource): string[] {
  return uniqueSorted(
    (manifest.artifacts?.targets ?? [])
      .filter((artifact) => artifact.platform === 'codex' && artifact.scopes.includes('project'))
      .flatMap((artifact) => artifact.refreshKeys),
  );
}

function hasIntersectingKeys(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function isCleanProjectPrewriteCandidate(
  evidence: Awaited<ReturnType<typeof collectInstallEvidence>>,
): boolean {
  return !evidence.installRecord.present
    && !evidence.adoptable.possible
    && !evidence.residualEvidence.privateStatePresent
    && !evidence.residualEvidence.repoVisibleArtifactPresent
    && !evidence.residualEvidence.sharedIdentityPresent
    && !evidence.residualEvidence.historicalLifecyclePresent
    && !evidence.residualEvidence.nativeMarkerPresent
    && !evidence.residualEvidence.sharedOwnerPresent;
}

async function syncCodexInstallStateAfterConfigRefresh(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  refreshStatus: 'succeeded' | 'failed';
}): Promise<void> {
  const location: PluginLocation = options.scope === 'project'
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

  const trackingManifest = await readTrackingManifest(
    resolveCodexPaths(options.cwd, options.scope, options.env).trackingDir,
  );
  const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
  if (!trackingRecord) {
    return;
  }

  const updatedAt = new Date().toISOString();
  const artifacts = trackingRecord.artifacts;
  const currentRecord = recordRead.value;
  const currentCacheRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location,
    currentRecord,
    env: options.env,
  });
  const currentCache = currentCacheRead.status === 'ok' ? currentCacheRead.value : null;
  const nextRecord: InstallRecordFile = {
    ...structuredClone(currentRecord),
    record: {
      ...structuredClone(currentRecord.record),
      updatedAt,
      artifacts: toInstallRecordArtifacts(artifacts),
    },
  };
  const nextCache = createDynamicDiagnosticCacheValue({
    recordFile: nextRecord,
    location,
    artifacts,
    updatedAt,
  });

  const stages: InstallStateTransactionStage[] = [];
  if (options.refreshStatus === 'succeeded') {
    if (options.scope === 'project') {
      const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
      const projectRoot = resolveProjectArtifactProjectRoot(options.cwd, location);
      const repoVisibleArtifacts = collectRepoVisibleProjectArtifacts(repoRoot, artifacts);
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
    mode: options.refreshStatus === 'succeeded' ? 'accepted' : 'refreshFailed',
    env: options.env,
  }));

  await runInstallStateTransaction({ stages });
}

export async function applyPluginConfigWrite(options: {
  plugin: PluginMeta;
  pluginName?: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  request: PluginConfigWriteRequest;
}): Promise<PluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName ?? options.plugin.manifest.name);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const schema = options.plugin.manifest.config?.schema;
  if (!schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }

  const requestedUpdates = options.request.updates ?? {};
  const requestedRemoveKeys = uniqueInOrder(options.request.removeKeys ?? []);
  const duplicateKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(requestedUpdates, key));
  if (duplicateKeys.length > 0) {
    throw new Error(`Config write cannot update and remove the same key: ${duplicateKeys.join(', ')}.`);
  }

  for (const key of requestedRemoveKeys) {
    if (!schema[key]) {
      throw new Error(`Unknown config key "${key}".`);
    }
  }

  const updates = await coercePluginConfigUpdates({
    schema,
    updates: requestedUpdates,
    cwd: options.cwd,
  });
  if (options.scope === 'project' && projectLayer === 'shared') {
    for (const key of Object.keys(updates)) {
      const field = schema[key];
      if (field.type === 'file' || field.type === 'directory') {
        throw new Error(
          `Config "${key}" is a ${field.type} value and cannot be written into project shared config. ` +
          'Use `--scope project --local` or user config instead.',
        );
      }
    }
  }
  const updatedKeys = Object.keys(updates);
  const warnings: ProjectBoundaryWarning[] = [];

  if (options.scope === 'project' && projectLayer === 'local') {
    const localStorePath = readPluginConfigStore({
      pluginName,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    });
    const ignoreResult = await ensureProjectPrivateStateIgnore({
      cwd: options.cwd,
      targetPath: (await localStorePath).path,
    });
    if (ignoreResult.warning) {
      warnings.push(ignoreResult.warning);
    }
  }
  if (options.scope === 'project' && projectLayer === 'shared') {
    await assertProjectSharedConfigPathVisible({
      cwd: options.cwd,
      pluginName,
    });
  }

  const store = await readPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer } : {}),
  });
  const removedKeys = requestedRemoveKeys.filter((key) => Object.hasOwn(store.values, key));
  const triggerKeys = [...updatedKeys, ...removedKeys];
  let artifactRefresh = createSkippedRefreshReceipt(triggerKeys);
  let configRefreshSkippedReason: PluginConfigWriteReceipt['configRefreshSkippedReason'];
  let shouldAttemptRefresh = triggerKeys.length > 0;

  if (options.scope === 'project' && projectLayer === 'local') {
    shouldAttemptRefresh = false;
    configRefreshSkippedReason = 'projectLocalOverride';
  }

  if (options.scope === 'project' && projectLayer === 'shared' && triggerKeys.length > 0) {
    const nextValues = { ...store.values };
    for (const key of requestedRemoveKeys) {
      delete nextValues[key];
    }
    for (const [key, value] of Object.entries(updates)) {
      nextValues[key] = value;
    }

    const env = options.env ?? process.env;
    const projectLocation: PluginLocation = {
      plugin: pluginName,
      platform: 'codex',
      scope: 'project',
      projectKey: await resolveCodexProjectKey(options.cwd),
    };
    const currentCatalog = await buildBaseCurrentCatalog({
      plugin: options.plugin,
      scope: 'project',
      cwd: options.cwd,
      env,
    });
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location: projectLocation,
      env,
      currentCatalog,
    });
    const projectRefreshKeys = collectProjectRefreshKeys(options.plugin.manifest);
    const refreshTouchesProjectArtifacts = hasIntersectingKeys(triggerKeys, projectRefreshKeys);

    if (!evidence.installRecord.present) {
      shouldAttemptRefresh = false;
      if (evidence.adoptable.possible) {
        if (refreshTouchesProjectArtifacts) {
          throw new Error(
            `当前项目里的 ${pluginName} 共享产物尚未被本机认领；这次写入会影响 repo-visible artifacts。` +
            '请先运行 `aw repair --adopt-existing`，再重试 config write。',
          );
        }
        configRefreshSkippedReason = 'adoptExistingRequired';
      } else if (isCleanProjectPrewriteCandidate(evidence)) {
        configRefreshSkippedReason = 'noRefreshTarget';
      } else if (refreshTouchesProjectArtifacts) {
        throw new Error(
          `当前项目里的 ${pluginName} 存在未认领或无法验证的残留状态，不能直接刷新共享 artifacts。` +
          '请先运行 `aw diagnose`，再选择 `aw repair --adopt-existing`、`aw cleanup` 或 `aw reinstall`。',
        );
      }
    } else {
      shouldAttemptRefresh = refreshTouchesProjectArtifacts;
    }

    const boundaryMessages = collectProjectArtifactConfigBoundaryIssues({
      schema,
      sharedEntries: nextValues,
      refreshKeys: shouldAttemptRefresh ? projectRefreshKeys : undefined,
    }).map((issue) => issue.message);
    if (boundaryMessages.length > 0) {
      throw new Error([...new Set(boundaryMessages)].join(' '));
    }
  }

  if (options.scope === 'user' && triggerKeys.length > 0) {
    const env = options.env ?? process.env;
    const recordRead = await readInstallRecordForLocation({
      cwd: options.cwd,
      location: {
        plugin: pluginName,
        platform: 'codex',
        scope: 'user',
      },
      env,
    });
    if (recordRead.status !== 'ok') {
      shouldAttemptRefresh = false;
      configRefreshSkippedReason = 'noRefreshTarget';
    }
  }

  if (triggerKeys.length > 0) {
    await patchPluginConfigStore({
      pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      updates,
      removeKeys: requestedRemoveKeys,
      ...(options.scope === 'project' ? { projectLayer } : {}),
    });
  }

  const effective = summarizeEffectivePluginConfig(await resolveEffectivePluginConfig({
    pluginName,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  }));
  if (shouldAttemptRefresh) {
    artifactRefresh = await refreshArtifactsAfterConfigWrite({
      plugin: options.plugin,
      commandScope: options.scope,
      cwd: options.cwd,
      env: options.env,
      changedKeys: triggerKeys,
    });
    if (artifactRefresh.attempted && (artifactRefresh.status === 'succeeded' || artifactRefresh.status === 'failed')) {
      await syncCodexInstallStateAfterConfigRefresh({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        refreshStatus: artifactRefresh.status,
      });
    }
  }

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    updatedKeys,
    removedKeys,
    effective,
    artifactRefresh,
    ...(configRefreshSkippedReason ? { configRefreshSkippedReason } : {}),
    warnings,
  };
}

export async function resetPluginConfigWithHelper(options: {
  pluginName: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  plugin?: PluginMeta;
}): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const warnings: ProjectBoundaryWarning[] = [];
  if (options.scope === 'project' && projectLayer === 'shared') {
    const current = await readPluginConfigStore({
      pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    if (current.exists) {
      await assertProjectSharedConfigPathVisible({
        cwd: options.cwd,
        pluginName,
      });
    }
  }
  if (options.scope === 'project' && projectLayer === 'local') {
    const localStorePath = readPluginConfigStore({
      pluginName,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    });
    const ignoreResult = await ensureProjectPrivateStateIgnore({
      cwd: options.cwd,
      targetPath: (await localStorePath).path,
    });
    if (ignoreResult.warning) {
      warnings.push(ignoreResult.warning);
    }
  }
  const reset = await resetPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer } : {}),
  });

  let artifactRefresh = createSkippedRefreshReceipt();
  let configRefreshSkippedReason: ResetPluginConfigWriteReceipt['configRefreshSkippedReason'];

  if (options.scope === 'project' && projectLayer === 'local') {
    configRefreshSkippedReason = 'projectLocalOverride';
  } else if (reset.deleted && options.plugin) {
    const env = options.env ?? process.env;
    const location: PluginLocation = options.scope === 'project'
      ? {
          plugin: pluginName,
          platform: 'codex',
          scope: 'project',
          projectKey: await resolveCodexProjectKey(options.cwd),
        }
      : {
          plugin: pluginName,
          platform: 'codex',
          scope: 'user',
        };
    const recordRead = await readInstallRecordForLocation({
      cwd: options.cwd,
      location,
      env,
    });
    if (recordRead.status === 'ok') {
      artifactRefresh = await refreshArtifactsAfterConfigWrite({
        plugin: options.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env: options.env,
        resetAllTrackedKeys: true,
      });
      if (artifactRefresh.attempted && (artifactRefresh.status === 'succeeded' || artifactRefresh.status === 'failed')) {
        await syncCodexInstallStateAfterConfigRefresh({
          plugin: options.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env,
          refreshStatus: artifactRefresh.status,
        });
      }
    } else {
      configRefreshSkippedReason = 'noRefreshTarget';
    }
  }

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    existed: reset.existed,
    deleted: reset.deleted,
    artifactRefresh,
    ...(configRefreshSkippedReason ? { configRefreshSkippedReason } : {}),
    warnings,
  };
}
