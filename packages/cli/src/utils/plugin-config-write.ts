import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  refreshArtifactsAfterConfigWrite,
  reapplyConfigRefresh,
  type ArtifactRefreshReceipt,
} from './artifact-refresh.js';
import { assertAgentVersionsForWriteTargets } from '../commands/common.js';
import { createArtifactConfigDigest } from './artifact-plan.js';
import {
  findConfigFieldEntry,
  assertSafePluginConfigSegment,
  collectProjectArtifactConfigBoundaryIssues,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  resolveConfigReadV2,
  readPluginConfigStore,
  resolvePluginConfigSchemaAccess,
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
import type {
  ConfigSchemaEvidenceV2,
  ConfigReceiptFieldEntryV2,
  GeneratedArtifact,
  PluginMeta,
  PluginManifestSource,
  ReceiptTargetIdentity,
  ReceiptTargetResult,
  Scope,
  PlatformName,
} from '../types.js';
import type { NativeCliRunner } from './native-cli.js';
import { readInstalledLedger } from './local-marketplace.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from './paths.js';

export interface PluginConfigWriteRequest {
  updates?: Record<string, unknown>;
  removeKeys?: string[];
}

export interface PluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidenceV2;
  updatedKeys: string[];
  removedKeys: string[];
  effective: ReturnType<typeof summarizeEffectivePluginConfig>;
  artifactRefresh: ArtifactRefreshReceipt;
  targetResults: ReceiptTargetResult[];
  configRefreshSkippedReason?: 'projectLocalOverride' | 'adoptExistingRequired' | 'noRefreshTarget';
  warnings: ProjectBoundaryWarning[];
}

export interface ResetPluginConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidenceV2;
  existed: boolean;
  deleted: boolean;
  removedKeys: string[];
  artifactRefresh: ArtifactRefreshReceipt;
  targetResults: ReceiptTargetResult[];
  configRefreshSkippedReason?: 'projectLocalOverride' | 'adoptExistingRequired' | 'noRefreshTarget';
  warnings: ProjectBoundaryWarning[];
}

interface ConfigRuntimeReplayReceipt {
  artifactRefresh: ArtifactRefreshReceipt;
  targetResults: ReceiptTargetResult[];
}

interface ConfigRuntimeImpact {
  applyTargets: ReceiptTargetIdentity[];
  gateTargets: ReceiptTargetIdentity[];
  dynamicRefreshTargets: ReceiptTargetIdentity[];
  configRefreshSkippedReason?: 'projectLocalOverride' | 'adoptExistingRequired' | 'noRefreshTarget';
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

function collectRemovedConfigKeys(values: Record<string, unknown>): string[] {
  return uniqueInOrder(Object.keys(values));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function dedupeReceiptTargets(targets: ReceiptTargetIdentity[]): ReceiptTargetIdentity[] {
  const deduped = new Map<string, ReceiptTargetIdentity>();
  for (const target of targets) {
    deduped.set(
      `${target.platform}:${target.scope}:${target.projectKey ?? '-'}`,
      target,
    );
  }
  return [...deduped.values()];
}

function sameReceiptTarget(
  left: ReceiptTargetIdentity,
  right: ReceiptTargetIdentity,
): boolean {
  return left.platform === right.platform
    && left.scope === right.scope
    && (left.projectKey ?? null) === (right.projectKey ?? null);
}

async function hasConfigApplyTargetEvidence(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  if (options.scope === 'project' && !options.projectKey) {
    return false;
  }

  const location: PluginLocation = options.scope === 'project'
    ? {
        plugin: options.pluginName,
        platform: options.platform,
        scope: 'project',
        projectKey: options.projectKey,
      }
    : {
        plugin: options.pluginName,
        platform: options.platform,
        scope: 'user',
      };
  const recordRead = await readInstallRecordForLocation({
    cwd: options.cwd,
    env: options.env,
    location,
  });
  if (recordRead.status === 'ok') {
    return true;
  }

  const diagnosticCacheRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location,
    env: options.env,
  });
  return diagnosticCacheRead.status === 'ok';
}

async function resolveDefaultConfigApplyTargets(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ReceiptTargetIdentity[]> {
  const targets: ReceiptTargetIdentity[] = [];
  const ledger = await readInstalledLedger(options.env);
  const pluginRecord = ledger.plugins[options.plugin.manifest.name];
  const projectKey = await resolveCodexProjectKey(options.cwd).catch(() => undefined);
  const scopes: Scope[] = options.scope === 'user' ? ['user', 'project'] : ['project'];

  for (const platform of ['codex', 'claude'] as const) {
    const platformRecord = pluginRecord?.platforms[platform];
    for (const scope of scopes) {
      const scopeRecord = scope === 'user'
        ? platformRecord?.userScope
        : (projectKey ? platformRecord?.projectScopes?.[projectKey] : undefined);
      if (scopeRecord?.managed) {
        targets.push({
          pluginName: options.plugin.manifest.name,
          platform,
          scope,
          ...(scope === 'project' && projectKey ? { projectKey } : {}),
        });
        continue;
      }
      if (
        await hasConfigApplyTargetEvidence({
          pluginName: options.plugin.manifest.name,
          platform,
          scope,
          projectKey,
          cwd: options.cwd,
          env: options.env,
        })
      ) {
        targets.push({
          pluginName: options.plugin.manifest.name,
          platform,
          scope,
          ...(scope === 'project' && projectKey ? { projectKey } : {}),
        });
      }
    }
  }

  return dedupeReceiptTargets(targets);
}

function collectRefreshKeysForScope(
  manifest: PluginManifestSource,
  platform: PlatformName,
  scope: Scope,
): string[] {
  return uniqueSorted(
    (manifest.artifacts?.targets ?? [])
      .filter((artifact) => artifact.platform === platform && artifact.scopes.includes(scope))
      .flatMap((artifact) => artifact.refreshKeys),
  );
}

function configScopeCandidates(scope: Scope): Scope[] {
  return scope === 'user' ? ['user', 'project'] : ['project'];
}

function targetKey(target: ReceiptTargetIdentity): string {
  return `${target.platform}:${target.scope}:${target.projectKey ?? '-'}`;
}

async function assertConfigRuntimeImpactAgentVersions(options: {
  impact: ConfigRuntimeImpact;
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nativeCliRunner?: NativeCliRunner;
}): Promise<void> {
  const platforms = uniqueSorted(options.impact.gateTargets.map((target) => target.platform)) as PlatformName[];
  if (platforms.length === 0) {
    return;
  }
  await assertAgentVersionsForWriteTargets({
    command: options.command,
    platforms,
    cwd: options.cwd,
    env: options.env,
    nativeCliRunner: options.nativeCliRunner,
  });
}

function artifactRefreshTargetMessage(receipt: ArtifactRefreshReceipt): string {
  if (receipt.status === 'failed') {
    return receipt.error ?? 'dynamic artifact refresh 失败。';
  }
  if (receipt.reason === 'no-tracked-dynamic-artifact') {
    return '当前 target 没有可重放的 dynamic artifact。';
  }
  if (receipt.reason === 'no-trigger-keys') {
    return '当前没有触发任何需要刷新的 dynamic artifact。';
  }
  return '当前 target 没有需要刷新的 dynamic artifact。';
}

function buildDynamicRefreshRawTargetResults(options: {
  plugin: PluginMeta;
  scope: Scope;
  artifactRefresh: ArtifactRefreshReceipt;
  applyTargets: ReceiptTargetIdentity[];
}): ReceiptTargetResult[] {
  const message = artifactRefreshTargetMessage(options.artifactRefresh);
  return dedupeReceiptTargets(options.applyTargets).map((target) => {
    if (target.scope !== options.scope) {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'notRun',
        message: '当前 target 没有可重放的 dynamic artifact。',
      } satisfies ReceiptTargetResult;
    }
    const declaresDynamicTarget = (options.plugin.manifest.artifacts?.targets ?? []).some((artifact) =>
      artifact.platform === target.platform && artifact.scopes.includes(target.scope));
    if (!declaresDynamicTarget) {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'notRun',
        message: '当前 target 没有可重放的 dynamic artifact。',
      } satisfies ReceiptTargetResult;
    }
    const targetArtifacts = options.artifactRefresh.artifacts.filter((artifact) =>
      artifact.platform === target.platform && artifact.scope === target.scope);
    if (
      targetArtifacts.some((artifact) => artifact.status === 'succeeded') ||
      (targetArtifacts.length === 0 && options.artifactRefresh.status === 'succeeded')
    ) {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'completed',
      } satisfies ReceiptTargetResult;
    }
    if (
      targetArtifacts.some((artifact) => artifact.status === 'failed') ||
      (targetArtifacts.length === 0 && options.artifactRefresh.status === 'failed')
    ) {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'failed',
        message,
      } satisfies ReceiptTargetResult;
    }
    return {
      target,
      action: 'dynamicArtifactRefresh',
      state: 'notRun',
      message,
    } satisfies ReceiptTargetResult;
  });
}

function collapseConfigApplyTargetResults(options: {
  pluginName: string;
  applyTargets: ReceiptTargetIdentity[];
  rawTargetResults: ReceiptTargetResult[];
}): ReceiptTargetResult[] {
  const allTargets = dedupeReceiptTargets([
    ...options.applyTargets,
    ...options.rawTargetResults.map((entry) => entry.target),
  ]);
  return allTargets.map((target) => {
    const matches = options.rawTargetResults.filter((entry) => sameReceiptTarget(entry.target, target));
    if (matches.length === 0) {
      return {
        target,
        action: 'configApply',
        state: 'notRun',
        message: '当前没有可重放的 runtime 写入。',
      } satisfies ReceiptTargetResult;
    }
    const failed = matches.find((entry) => entry.state === 'failed');
    if (failed) {
      return {
        target,
        action: 'configApply',
        state: 'failed',
        ...(failed.message ? { message: failed.message } : {}),
      } satisfies ReceiptTargetResult;
    }
    const rolledBack = matches.find((entry) => entry.state === 'rolledBack');
    if (rolledBack) {
      return {
        target,
        action: 'configApply',
        state: 'rolledBack',
        ...(rolledBack.message ? { message: rolledBack.message } : {}),
      } satisfies ReceiptTargetResult;
    }
    if (matches.some((entry) => entry.state === 'completed')) {
      return {
        target,
        action: 'configApply',
        state: 'completed',
      } satisfies ReceiptTargetResult;
    }
    const notRun = matches.find((entry) => entry.state === 'notRun');
    return {
      target,
      action: 'configApply',
      state: 'notRun',
      ...(notRun?.message ? { message: notRun.message } : {}),
    } satisfies ReceiptTargetResult;
  });
}

function buildReceiptFieldEntry(options: {
  key: string;
  title: string;
  kind: ConfigReceiptFieldEntryV2['kind'];
  reserved: boolean;
  action: ConfigReceiptFieldEntryV2['action'];
  scope: Scope;
  projectLayer: 'shared' | 'local';
  valueState?: ConfigReceiptFieldEntryV2['valueState'];
}): ConfigReceiptFieldEntryV2 {
  return {
    key: options.key,
    title: options.title,
    kind: options.kind,
    reserved: options.reserved,
    action: options.action,
    scope: options.scope,
    ...(options.scope === 'project' ? { projectLayer: options.projectLayer } : {}),
    ...(options.valueState ? { valueState: options.valueState } : {}),
  };
}

export async function replayConfigRuntimeWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  includeDynamicArtifacts?: boolean;
  nativeCliRunner?: NativeCliRunner;
}): Promise<ConfigRuntimeReplayReceipt> {
  const env = options.env ?? process.env;
  const impact = await analyzeConfigRuntimeImpact({
    plugin: options.plugin,
    scope: options.scope,
    projectLayer: 'shared',
    cwd: options.cwd,
    env,
    changedKeys: [],
    resetAllTrackedKeys: true,
    includeDynamicArtifacts: options.includeDynamicArtifacts !== false,
    applyTargets: options.applyTargets,
  });
  await assertConfigRuntimeImpactAgentVersions({
    impact,
    command: 'config',
    cwd: options.cwd,
    env,
    nativeCliRunner: options.nativeCliRunner,
  });
  const applyTargets = impact.applyTargets;

  const artifactRefresh = options.includeDynamicArtifacts === false
    ? createSkippedRefreshReceipt()
    : await reapplyConfigRefresh({
        plugin: options.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env,
      });
  const dynamicRawResults = options.includeDynamicArtifacts === false
    ? []
    : buildDynamicRefreshRawTargetResults({
        plugin: options.plugin,
        scope: options.scope,
        artifactRefresh,
        applyTargets,
      });

  return {
    artifactRefresh,
    targetResults: collapseConfigApplyTargetResults({
      pluginName: options.plugin.manifest.name,
      applyTargets,
      rawTargetResults: dynamicRawResults,
    }),
  };
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
  const manifestDigest = await fs.pathExists(plugin.manifestPath)
    ? await calculateFileDigest(plugin.manifestPath)
    : `sha256:${crypto.createHash('sha256').update(JSON.stringify(plugin.manifest)).digest('hex')}`;
  const bundleFingerprint = await fs.pathExists(plugin.rootDir)
    ? await calculatePluginBundleFingerprint(plugin.rootDir)
    : `sha256:${crypto.createHash('sha256').update(JSON.stringify({
        rootDir: plugin.rootDir,
        manifest: plugin.manifest,
      })).digest('hex')}`;
  return {
    pluginVersion: plugin.manifest.version,
    manifestDigest,
    bundleFingerprint,
  };
}

async function buildDynamicCatalogArtifacts(
  plugin: PluginMeta,
  platform: PlatformName,
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
    .filter((artifact) => artifact.platform === platform && artifact.scopes.includes(scope))
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
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CurrentCatalogEvidenceInput> {
  return {
    source: await buildCurrentCatalogSource(options.plugin),
    artifacts: [],
    dynamicArtifacts: await buildDynamicCatalogArtifacts(
      options.plugin,
      options.platform,
      options.scope,
      options.cwd,
      options.env,
    ),
  };
}

function collectProjectRefreshKeys(manifest: PluginManifestSource): string[] {
  return uniqueSorted(
    (manifest.artifacts?.targets ?? [])
      .filter((artifact) => artifact.scopes.includes('project'))
      .flatMap((artifact) => artifact.refreshKeys),
  );
}

function hasIntersectingKeys(left: readonly string[], right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function isDynamicRefreshEntry(
  artifact: Pick<GeneratedArtifact, 'id' | 'platform' | 'target' | 'state' | 'refreshKeys'>
    | (DynamicArtifactDiagnosticEntry & { platform?: PlatformName }),
): boolean {
  return (
    typeof artifact.id === 'string' &&
    (
      artifact.target === 'codex.developerInstructionsBlock' ||
      artifact.target === 'codex.agentRole' ||
      artifact.target === 'codex.skill' ||
      artifact.target === 'claude.skill'
    ) &&
    (artifact.state === 'present' || artifact.state === 'disabled') &&
    (artifact.refreshKeys?.length ?? 0) > 0
  );
}

function dynamicRefreshEntryTouchesKeys(options: {
  artifact: Pick<GeneratedArtifact, 'id' | 'platform' | 'target' | 'state' | 'refreshKeys'>
    | (DynamicArtifactDiagnosticEntry & { platform?: PlatformName });
  changedKeys: string[];
  resetAllTrackedKeys?: boolean;
}): boolean {
  if (!isDynamicRefreshEntry(options.artifact)) {
    return false;
  }
  if (options.resetAllTrackedKeys === true) {
    return true;
  }
  return hasIntersectingKeys(options.changedKeys, options.artifact.refreshKeys ?? []);
}

async function hasUserCodexDynamicRefreshEvidence(options: {
  pluginName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys?: boolean;
}): Promise<boolean> {
  const location: PluginLocation = {
    plugin: options.pluginName,
    platform: 'codex',
    scope: 'user',
  };
  const diagnosticCacheRead = await readDynamicArtifactDiagnosticCacheForLocation({
    cwd: options.cwd,
    location,
    env: options.env,
  });
  if (
    diagnosticCacheRead.status === 'ok' &&
    diagnosticCacheRead.value.artifacts.some((artifact) =>
      dynamicRefreshEntryTouchesKeys({
        artifact,
        changedKeys: options.changedKeys,
        resetAllTrackedKeys: options.resetAllTrackedKeys,
      }))
  ) {
    return true;
  }

  const trackingManifest = await readTrackingManifest(
    resolveCodexPaths(options.cwd, 'user', options.env).trackingDir,
  );
  const trackingRecord = getTrackingRecord(trackingManifest, options.pluginName);
  return (trackingRecord?.artifacts ?? []).some((artifact) =>
    dynamicRefreshEntryTouchesKeys({
      artifact,
      changedKeys: options.changedKeys,
      resetAllTrackedKeys: options.resetAllTrackedKeys,
    }));
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
    && !evidence.residualEvidence.nativeMarkerPresent;
}

async function resolveCodexDynamicRefreshImpact(options: {
  plugin: PluginMeta;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys?: boolean;
}): Promise<{
  targets: ReceiptTargetIdentity[];
  configRefreshSkippedReason?: ConfigRuntimeImpact['configRefreshSkippedReason'];
}> {
  if (options.projectLayer === 'local') {
    return { targets: [], configRefreshSkippedReason: 'projectLocalOverride' };
  }

  const projectKey = await resolveCodexProjectKey(options.cwd).catch(() => undefined);
  const targets: ReceiptTargetIdentity[] = [];
  let sawCodexRefreshableSurface = false;
  let adoptExistingRequired = false;
  let cleanPrewrite = false;

  for (const scope of configScopeCandidates(options.scope)) {
    const refreshKeys = collectRefreshKeysForScope(options.plugin.manifest, 'codex', scope);
    let touchesScope = refreshKeys.length > 0 && (
      options.resetAllTrackedKeys === true ||
      hasIntersectingKeys(options.changedKeys, refreshKeys)
    );
    let userFallbackEvidence = false;
    if (!touchesScope && scope === 'user') {
      userFallbackEvidence = await hasUserCodexDynamicRefreshEvidence({
        pluginName: options.plugin.manifest.name,
        cwd: options.cwd,
        env: options.env,
        changedKeys: options.changedKeys,
        resetAllTrackedKeys: options.resetAllTrackedKeys,
      });
      touchesScope = userFallbackEvidence;
    }
    if (!touchesScope) {
      continue;
    }
    sawCodexRefreshableSurface = true;

    const location: PluginLocation = scope === 'project'
      ? {
          plugin: options.plugin.manifest.name,
          platform: 'codex',
          scope: 'project',
          ...(projectKey ? { projectKey } : {}),
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
    if (recordRead.status === 'ok') {
      targets.push({
        pluginName: options.plugin.manifest.name,
        platform: 'codex',
        scope,
        ...(scope === 'project' && projectKey ? { projectKey } : {}),
      });
      continue;
    }

    if (scope !== 'project') {
      const hasFallbackEvidence = userFallbackEvidence || await hasUserCodexDynamicRefreshEvidence({
        pluginName: options.plugin.manifest.name,
        cwd: options.cwd,
        env: options.env,
        changedKeys: options.changedKeys,
        resetAllTrackedKeys: options.resetAllTrackedKeys,
      });
      if (hasFallbackEvidence) {
        targets.push({
          pluginName: options.plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        });
      }
      continue;
    }

    const currentCatalog = await buildBaseCurrentCatalog({
      plugin: options.plugin,
      platform: 'codex',
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location: {
        plugin: options.plugin.manifest.name,
        platform: 'codex',
        scope: 'project',
        ...(projectKey ? { projectKey } : {}),
      },
      env: options.env,
      currentCatalog,
    });

    if (evidence.adoptable.possible) {
      adoptExistingRequired = true;
    } else if (isCleanProjectPrewriteCandidate(evidence)) {
      cleanPrewrite = true;
    } else {
      throw new Error(
        `当前项目里的 ${options.plugin.manifest.name} 存在未认领或无法验证的残留状态，不能直接刷新共享 artifacts。` +
        `请先运行 \`aw status --verbose\` 查看状态，再选择 \`aw install ${options.plugin.manifest.name} --platform codex --scope project --adopt-existing\`、\`aw cleanup\` 或 \`aw reinstall\`。`,
      );
    }
  }

  if (adoptExistingRequired) {
    throw new Error(
      `当前项目里的 ${options.plugin.manifest.name} 共享产物尚未被本机认领；这次写入会影响 repo-visible artifacts。` +
      `请先运行 \`aw install ${options.plugin.manifest.name} --platform codex --scope project --adopt-existing\`，再重试 config write。`,
    );
  }

  if (targets.length > 0) {
    return { targets: dedupeReceiptTargets(targets) };
  }

  if (
    options.changedKeys.length > 0 &&
    configScopeCandidates(options.scope).includes('project')
  ) {
    const currentCatalog = await buildBaseCurrentCatalog({
      plugin: options.plugin,
      platform: 'codex',
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location: {
        plugin: options.plugin.manifest.name,
        platform: 'codex',
        scope: 'project',
        ...(projectKey ? { projectKey } : {}),
      },
      env: options.env,
      currentCatalog,
    });
    if (!evidence.installRecord.present && evidence.adoptable.possible) {
      return { targets: [], configRefreshSkippedReason: 'adoptExistingRequired' };
    }
  }

  if (sawCodexRefreshableSurface || cleanPrewrite) {
    return { targets: [], configRefreshSkippedReason: 'noRefreshTarget' };
  }

  return { targets: [] };
}

async function resolveClaudeDynamicRefreshImpact(options: {
  plugin: PluginMeta;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys?: boolean;
}): Promise<{
  targets: ReceiptTargetIdentity[];
  configRefreshSkippedReason?: ConfigRuntimeImpact['configRefreshSkippedReason'];
}> {
  if (options.projectLayer === 'local') {
    return { targets: [], configRefreshSkippedReason: 'projectLocalOverride' };
  }

  const targets: ReceiptTargetIdentity[] = [];
  const projectKey = await resolveClaudeProjectKey(options.cwd).catch(() => undefined);
  let sawClaudeRefreshableSurface = false;
  let adoptExistingRequired = false;
  let cleanPrewrite = false;
  for (const scope of configScopeCandidates(options.scope)) {
    const refreshKeys = collectRefreshKeysForScope(options.plugin.manifest, 'claude', scope);
    if (
      refreshKeys.length === 0 ||
      (
        options.resetAllTrackedKeys !== true &&
        !hasIntersectingKeys(options.changedKeys, refreshKeys)
      )
    ) {
      continue;
    }
    sawClaudeRefreshableSurface = true;

    const location: PluginLocation = scope === 'project'
      ? {
          plugin: options.plugin.manifest.name,
          platform: 'claude',
          scope: 'project',
          ...(projectKey ? { projectKey } : {}),
        }
      : {
          plugin: options.plugin.manifest.name,
          platform: 'claude',
          scope: 'user',
        };
    const recordRead = await readInstallRecordForLocation({
      cwd: options.cwd,
      location,
      env: options.env,
    });
    const trackingManifest = await readTrackingManifest(
      resolveClaudePaths(options.cwd, scope, options.env).trackingDir,
    );
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    const hasTrackedDynamicSkill = trackingRecord?.artifacts.some((artifact) =>
      artifact.platform === 'claude' &&
      artifact.target === 'claude.skill' &&
      dynamicRefreshEntryTouchesKeys({
        artifact,
        changedKeys: options.changedKeys,
        resetAllTrackedKeys: options.resetAllTrackedKeys,
      })) ?? false;
    if (recordRead.status === 'ok') {
      targets.push({
        pluginName: options.plugin.manifest.name,
        platform: 'claude',
        scope,
        ...(scope === 'project' && projectKey ? { projectKey } : {}),
      });
      continue;
    }

    if (scope !== 'project') {
      if (hasTrackedDynamicSkill) {
        targets.push({
          pluginName: options.plugin.manifest.name,
          platform: 'claude',
          scope: 'user',
        });
      }
      continue;
    }

    const currentCatalog = await buildBaseCurrentCatalog({
      plugin: options.plugin,
      platform: 'claude',
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location,
      env: options.env,
      currentCatalog,
    });
    if (evidence.adoptable.possible) {
      adoptExistingRequired = true;
    } else if (!evidence.legacyTracking.present && isCleanProjectPrewriteCandidate(evidence)) {
      cleanPrewrite = true;
    } else {
      throw new Error(
        `当前项目里的 ${options.plugin.manifest.name} 存在未认领或无法验证的残留状态，不能直接刷新共享 artifacts。` +
        `请先运行 \`aw status --verbose\` 查看状态，再选择 \`aw install ${options.plugin.manifest.name} --platform claude --scope project --adopt-existing\`、\`aw cleanup\` 或 \`aw reinstall\`。`,
      );
    }
  }

  if (adoptExistingRequired) {
    throw new Error(
      `当前项目里的 ${options.plugin.manifest.name} 共享产物尚未被本机认领；这次写入会影响 repo-visible artifacts。` +
      `请先运行 \`aw install ${options.plugin.manifest.name} --platform claude --scope project --adopt-existing\`，再重试 config write。`,
    );
  }

  if (targets.length > 0) {
    return { targets: dedupeReceiptTargets(targets) };
  }

  if (
    options.changedKeys.length > 0 &&
    configScopeCandidates(options.scope).includes('project')
  ) {
    const currentCatalog = await buildBaseCurrentCatalog({
      plugin: options.plugin,
      platform: 'claude',
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    });
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location: {
        plugin: options.plugin.manifest.name,
        platform: 'claude',
        scope: 'project',
        ...(projectKey ? { projectKey } : {}),
      },
      env: options.env,
      currentCatalog,
    });
    if (!evidence.installRecord.present && evidence.adoptable.possible) {
      return { targets: [], configRefreshSkippedReason: 'adoptExistingRequired' };
    }
  }

  if (sawClaudeRefreshableSurface || cleanPrewrite) {
    return { targets: [], configRefreshSkippedReason: 'noRefreshTarget' };
  }

  return { targets: [] };
}

async function resolveDynamicRefreshImpact(options: Parameters<typeof resolveCodexDynamicRefreshImpact>[0]): Promise<{
  targets: ReceiptTargetIdentity[];
  configRefreshSkippedReason?: ConfigRuntimeImpact['configRefreshSkippedReason'];
}> {
  const [codex, claude] = await Promise.all([
    resolveCodexDynamicRefreshImpact(options),
    resolveClaudeDynamicRefreshImpact(options),
  ]);
  const targets = dedupeReceiptTargets([...codex.targets, ...claude.targets]);
  const configRefreshSkippedReason = targets.length === 0
    ? codex.configRefreshSkippedReason === 'adoptExistingRequired' ||
      claude.configRefreshSkippedReason === 'adoptExistingRequired'
      ? 'adoptExistingRequired' as const
      : codex.configRefreshSkippedReason ?? claude.configRefreshSkippedReason
    : undefined;
  return {
    targets,
    ...(configRefreshSkippedReason ? { configRefreshSkippedReason } : {}),
  };
}

async function analyzeConfigRuntimeImpact(options: {
  plugin: PluginMeta;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  cwd: string;
  env: NodeJS.ProcessEnv;
  changedKeys: string[];
  resetAllTrackedKeys?: boolean;
  includeDynamicArtifacts: boolean;
  applyTargets?: ReceiptTargetIdentity[];
}): Promise<ConfigRuntimeImpact> {
  if (options.projectLayer === 'local') {
    const applyTargets = options.applyTargets && options.applyTargets.length > 0
      ? dedupeReceiptTargets(options.applyTargets)
      : [];
    return {
      applyTargets,
      gateTargets: [],
      dynamicRefreshTargets: [],
      configRefreshSkippedReason: 'projectLocalOverride',
    };
  }

  const defaultApplyTargets = options.applyTargets && options.applyTargets.length > 0
    ? dedupeReceiptTargets(options.applyTargets)
    : await resolveDefaultConfigApplyTargets({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
      });
  const dynamicRefresh = options.includeDynamicArtifacts
    ? await resolveDynamicRefreshImpact({
        plugin: options.plugin,
        scope: options.scope,
        projectLayer: options.projectLayer,
        cwd: options.cwd,
        env: options.env,
        changedKeys: options.changedKeys,
        resetAllTrackedKeys: options.resetAllTrackedKeys,
      })
    : { targets: [] };
  const applyTargets = dedupeReceiptTargets([
    ...defaultApplyTargets,
    ...dynamicRefresh.targets,
  ]);
  const gateTargetMap = new Map<string, ReceiptTargetIdentity>();
  for (const target of dynamicRefresh.targets) {
    gateTargetMap.set(targetKey(target), target);
  }
  return {
    applyTargets,
    gateTargets: [...gateTargetMap.values()],
    dynamicRefreshTargets: dynamicRefresh.targets,
    ...(dynamicRefresh.configRefreshSkippedReason
      ? { configRefreshSkippedReason: dynamicRefresh.configRefreshSkippedReason }
      : options.includeDynamicArtifacts && options.changedKeys.length > 0 && dynamicRefresh.targets.length === 0
        ? { configRefreshSkippedReason: 'noRefreshTarget' as const }
      : {}),
  };
}

async function syncInstallStateAfterConfigRefresh(options: {
  plugin: PluginMeta;
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifactRefresh: ArtifactRefreshReceipt;
}): Promise<void> {
  const scopeStatuses = new Map<string, {
    platform: PlatformName;
    scope: Scope;
    status: 'succeeded' | 'failed';
  }>();
  for (const artifact of options.artifactRefresh.artifacts) {
    const key = `${artifact.platform}:${artifact.scope}`;
    const current = scopeStatuses.get(key);
    if (current?.status === 'failed') {
      continue;
    }
    scopeStatuses.set(key, {
      platform: artifact.platform,
      scope: artifact.scope,
      status: artifact.status,
    });
  }
  if (scopeStatuses.size === 0) {
    if (options.artifactRefresh.status === 'skipped') {
      return;
    }
    for (const target of options.plugin.manifest.artifacts?.targets ?? []) {
      for (const scope of configScopeCandidates(options.commandScope)) {
        if (!target.scopes.includes(scope)) {
          continue;
        }
        const key = `${target.platform}:${scope}`;
        scopeStatuses.set(key, {
          platform: target.platform,
          scope,
          status: options.artifactRefresh.status,
        });
      }
    }
  }

  for (const { platform, scope, status: refreshStatus } of scopeStatuses.values()) {
    const location: PluginLocation = scope === 'project'
      ? {
          plugin: options.plugin.manifest.name,
          platform,
          scope: 'project',
          projectKey: platform === 'codex'
            ? await resolveCodexProjectKey(options.cwd)
            : await resolveClaudeProjectKey(options.cwd),
        }
      : {
          plugin: options.plugin.manifest.name,
          platform,
          scope: 'user',
        };
    const recordRead = await readInstallRecordForLocation({
      cwd: options.cwd,
      location,
      env: options.env,
    });
    if (recordRead.status !== 'ok') {
      continue;
    }

    const trackingManifest = await readTrackingManifest(
      platform === 'codex'
        ? resolveCodexPaths(options.cwd, scope, options.env).trackingDir
        : resolveClaudePaths(options.cwd, scope, options.env).trackingDir,
    );
    const trackingRecord = getTrackingRecord(trackingManifest, options.plugin.manifest.name);
    if (!trackingRecord) {
      continue;
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
    if (refreshStatus === 'succeeded') {
      if (scope === 'project') {
        const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
        const projectRoot = resolveProjectArtifactProjectRoot(options.cwd, location);
        const repoVisibleArtifacts = collectRepoVisibleProjectArtifacts(repoRoot, artifacts);
        const locator = createProjectArtifactSharedLocator({
          plugin: options.plugin.manifest.name,
          platform,
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
      mode: refreshStatus === 'succeeded' ? 'accepted' : 'refreshFailed',
      env: options.env,
    }));

    await runInstallStateTransaction({ stages });
  }
}

export async function applyPluginConfigWrite(options: {
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  pluginName?: string;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
  request: PluginConfigWriteRequest;
}): Promise<PluginConfigWriteReceipt> {
  const requestedPluginName = options.pluginName ?? options.plugin?.manifest.name;
  if (!requestedPluginName) {
    throw new Error('Plugin name is required for config write.');
  }
  const pluginName = assertSafePluginConfigSegment(requestedPluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin,
    currentPluginError: options.pluginError,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const schemaPlugin = schemaAccess.plugin;
  const schema = schemaPlugin?.manifest.config?.schema;
  if (!schema) {
    throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
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
  let targetResults: ReceiptTargetResult[] = [];
  let shouldAttemptRefresh = false;
  let applyTargets: ReceiptTargetIdentity[] = [];

  if (triggerKeys.length > 0) {
    const nextValues = { ...store.values };
    for (const key of requestedRemoveKeys) {
      delete nextValues[key];
    }
    for (const [key, value] of Object.entries(updates)) {
      nextValues[key] = value;
    }

    const env = options.env ?? process.env;
    const impact = await analyzeConfigRuntimeImpact({
      plugin: schemaPlugin,
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env,
      changedKeys: triggerKeys,
      includeDynamicArtifacts: true,
      applyTargets: options.applyTargets,
    });
    await assertConfigRuntimeImpactAgentVersions({
      impact,
      command: 'config',
      cwd: options.cwd,
      env,
      nativeCliRunner: options.nativeCliRunner,
    });
    shouldAttemptRefresh = impact.dynamicRefreshTargets.length > 0;
    applyTargets = impact.applyTargets;
    configRefreshSkippedReason = impact.configRefreshSkippedReason;

    if (options.scope === 'project' && projectLayer === 'shared') {
      const projectRefreshKeys = collectProjectRefreshKeys(schemaPlugin.manifest);
      const boundaryMessages = collectProjectArtifactConfigBoundaryIssues({
        schema,
        sharedEntries: nextValues,
        refreshKeys: shouldAttemptRefresh ? projectRefreshKeys : undefined,
      }).map((issue) => issue.message);
      if (boundaryMessages.length > 0) {
        throw new Error([...new Set(boundaryMessages)].join(' '));
      }
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
    manifest: schemaPlugin.manifest,
    cwd: options.cwd,
    env: options.env,
  }));
  if (shouldAttemptRefresh) {
    artifactRefresh = await refreshArtifactsAfterConfigWrite({
      plugin: schemaPlugin,
      commandScope: options.scope,
      cwd: options.cwd,
      env: options.env,
      changedKeys: triggerKeys,
    });
    if (artifactRefresh.attempted && (artifactRefresh.status === 'succeeded' || artifactRefresh.status === 'failed')) {
      await syncInstallStateAfterConfigRefresh({
        plugin: schemaPlugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
        artifactRefresh,
      });
    } else if (!artifactRefresh.attempted && options.scope === 'user') {
      configRefreshSkippedReason = 'noRefreshTarget';
    }
  }

  if (applyTargets.length === 0) {
    applyTargets = (options.applyTargets && options.applyTargets.length > 0)
      ? dedupeReceiptTargets(options.applyTargets)
      : await resolveDefaultConfigApplyTargets({
          plugin: schemaPlugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env ?? process.env,
        });
  }
  targetResults = collapseConfigApplyTargetResults({
    pluginName,
    applyTargets,
    rawTargetResults: buildDynamicRefreshRawTargetResults({
      plugin: schemaPlugin,
      scope: options.scope,
      artifactRefresh,
      applyTargets,
    }),
  });
  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    updatedKeys,
    removedKeys,
    effective,
    artifactRefresh,
    targetResults,
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
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  applyTargets?: ReceiptTargetIdentity[];
  nativeCliRunner?: NativeCliRunner;
}): Promise<ResetPluginConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const store = await readPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer } : {}),
  });
  const removedKeys = collectRemovedConfigKeys(store.values);
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin ?? null,
    currentPluginError: options.pluginError,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
    allowSchemaConflict: true,
  });
  const warnings: ProjectBoundaryWarning[] = [];
  if (options.scope === 'project' && projectLayer === 'shared') {
    if (store.exists) {
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
  let artifactRefresh = createSkippedRefreshReceipt();
  let configRefreshSkippedReason: ResetPluginConfigWriteReceipt['configRefreshSkippedReason'];
  let targetResults: ReceiptTargetResult[] = [];
  let shouldAttemptRefresh = false;
  let applyTargets: ReceiptTargetIdentity[] = [];

  if (options.scope === 'project' && projectLayer === 'local') {
    configRefreshSkippedReason = 'projectLocalOverride';
  } else if (store.exists && schemaAccess.plugin && removedKeys.length > 0) {
    const env = options.env ?? process.env;
    const impact = await analyzeConfigRuntimeImpact({
      plugin: schemaAccess.plugin,
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env,
      changedKeys: removedKeys,
      includeDynamicArtifacts: true,
      applyTargets: options.applyTargets,
    });
    await assertConfigRuntimeImpactAgentVersions({
      impact,
      command: 'config',
      cwd: options.cwd,
      env,
      nativeCliRunner: options.nativeCliRunner,
    });
    shouldAttemptRefresh = impact.dynamicRefreshTargets.length > 0;
    applyTargets = impact.applyTargets;
    configRefreshSkippedReason = impact.configRefreshSkippedReason;
  } else if (store.exists && removedKeys.length > 0) {
    configRefreshSkippedReason = 'noRefreshTarget';
  }

  const reset = await resetPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer } : {}),
  });

  if (shouldAttemptRefresh && schemaAccess.plugin) {
    const env = options.env ?? process.env;
    artifactRefresh = await refreshArtifactsAfterConfigWrite({
      plugin: schemaAccess.plugin,
      commandScope: options.scope,
      cwd: options.cwd,
      env: options.env,
      changedKeys: removedKeys,
    });
    if (artifactRefresh.attempted && (artifactRefresh.status === 'succeeded' || artifactRefresh.status === 'failed')) {
      await syncInstallStateAfterConfigRefresh({
        plugin: schemaAccess.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env,
        artifactRefresh,
      });
    } else if (!artifactRefresh.attempted && options.scope === 'user') {
      configRefreshSkippedReason = 'noRefreshTarget';
    }
  }

  if (schemaAccess.plugin && reset.deleted) {
    if (applyTargets.length === 0) {
      applyTargets = (options.applyTargets && options.applyTargets.length > 0)
        ? dedupeReceiptTargets(options.applyTargets)
        : await resolveDefaultConfigApplyTargets({
            plugin: schemaAccess.plugin,
            scope: options.scope,
            cwd: options.cwd,
            env: options.env ?? process.env,
          });
    }
    targetResults = collapseConfigApplyTargetResults({
      pluginName,
      applyTargets,
      rawTargetResults: buildDynamicRefreshRawTargetResults({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        artifactRefresh,
        applyTargets,
      }),
    });
  }

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    existed: reset.existed,
    deleted: reset.deleted,
    removedKeys,
    artifactRefresh,
    targetResults,
    ...(configRefreshSkippedReason ? { configRefreshSkippedReason } : {}),
    warnings,
  };
}

export async function describeResetAffectedFields(options: {
  pluginName: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ConfigReceiptFieldEntryV2[]> {
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  try {
    const resolved = await resolveConfigReadV2({
      pluginName: options.pluginName,
      plugin: options.plugin,
      ...(options.pluginError ? { pluginError: options.pluginError } : {}),
      scope: options.scope,
      projectLayer,
      cwd: options.cwd,
      env: options.env,
    });
    return resolved.fields.map((field) =>
      buildReceiptFieldEntry({
        key: field.key,
        title: field.title,
        kind: field.kind,
        reserved: field.reserved,
        action: 'reset',
        scope: options.scope,
        projectLayer,
        valueState: field.valueState,
      }),
    );
  } catch (error) {
    const store = await readPluginConfigStore({
      pluginName: options.pluginName,
      scope: options.scope,
      cwd: options.cwd,
      env: options.env,
      ...(options.scope === 'project' ? { projectLayer } : {}),
    });
    return collectRemovedConfigKeys(store.values).map((key) =>
      buildReceiptFieldEntry({
        key,
        title: key,
        kind: 'manifest',
        reserved: false,
        action: 'reset',
        scope: options.scope,
        projectLayer,
      }),
    );
  }
}
