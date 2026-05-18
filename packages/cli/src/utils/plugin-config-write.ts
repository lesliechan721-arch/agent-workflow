import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  refreshArtifactsAfterConfigWrite,
  reapplyConfigRefresh,
  type ArtifactRefreshReceipt,
} from './artifact-refresh.js';
import { createArtifactConfigDigest } from './artifact-plan.js';
import {
  findConfigFieldEntry,
  isBuiltInConfigKey,
  parseBuiltInSkillTriggerKey,
  assertSafePluginConfigSegment,
  collectProjectArtifactConfigBoundaryIssues,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  resolveConfigReadV2,
  readPluginConfigStore,
  resolvePluginConfigSchemaAccess,
  resolveUniformSkillTriggerPreference,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  resolveProjectArtifactRenderConfig,
  summarizeEffectivePluginConfig,
  toBuiltInSkillTriggerLogicalKey,
  writePluginConfigStore,
} from './plugin-config.js';
import { resolveArtifactRendererTarget } from './artifact-renderer.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from './plugin-scripts.js';
import {
  commitMaterializedSkillTriggerPreference,
  materializeSkillTriggerPreference,
  resolveSkillTriggerConfigEntries,
} from './skill-trigger-preferences.js';
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
} from '../types.js';
import { readInstalledLedger } from './local-marketplace.js';
import { resolveCodexPaths, resolveCodexProjectKey } from './paths.js';

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
  configRefreshSkippedReason?: 'projectLocalOverride' | 'noRefreshTarget';
  warnings: ProjectBoundaryWarning[];
}

export interface BuiltInConfigWriteReceipt {
  plugin: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  schema?: ConfigSchemaEvidenceV2;
  existed?: boolean;
  deleted?: boolean;
  affectedFields: ConfigReceiptFieldEntryV2[];
  targetResults: ReceiptTargetResult[];
  warnings: ProjectBoundaryWarning[];
}

interface ConfigRuntimeReplayReceipt {
  artifactRefresh: ArtifactRefreshReceipt;
  targetResults: ReceiptTargetResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const removedKeys = Object.keys(values).filter((key) => key !== '$aw');
  const awNamespace = values.$aw;
  if (
    isRecord(awNamespace) &&
    isRecord(awNamespace.skillTriggers)
  ) {
    for (const skillName of Object.keys(awNamespace.skillTriggers)) {
      removedKeys.push(toBuiltInSkillTriggerLogicalKey(skillName));
    }
  }
  return uniqueInOrder(removedKeys);
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

async function resolveDefaultConfigApplyTargets(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ReceiptTargetIdentity[]> {
  const targets: ReceiptTargetIdentity[] = [];
  const ledger = await readInstalledLedger(options.env);
  const pluginRecord = ledger.plugins[options.plugin.manifest.name];
  const projectKey = options.scope === 'project'
    ? await resolveCodexProjectKey(options.cwd)
    : undefined;

  for (const platform of ['codex', 'claude'] as const) {
    const platformRecord = pluginRecord?.platforms[platform];
    const scopeRecord = options.scope === 'user'
      ? platformRecord?.userScope
      : (projectKey ? platformRecord?.projectScopes?.[projectKey] : undefined);
    if (!scopeRecord?.managed) {
      continue;
    }
    targets.push({
      pluginName: options.plugin.manifest.name,
      platform,
      scope: options.scope,
      ...(projectKey ? { projectKey } : {}),
    });
  }

  if (options.scope === 'project') {
    const skillEntries = await resolveSkillTriggerConfigEntries(options.plugin);
    if (skillEntries.some((entry) => entry.platforms.includes('codex'))) {
      targets.push({
        pluginName: options.plugin.manifest.name,
        platform: 'codex',
        scope: 'project',
        ...(projectKey ? { projectKey } : {}),
      });
    }
  }

  return dedupeReceiptTargets(targets);
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
  pluginName: string;
  scope: Scope;
  artifactRefresh: ArtifactRefreshReceipt;
  applyTargets: ReceiptTargetIdentity[];
}): ReceiptTargetResult[] {
  const message = artifactRefreshTargetMessage(options.artifactRefresh);
  return dedupeReceiptTargets(options.applyTargets).map((target) => {
    if (target.platform !== 'codex' || target.scope !== options.scope) {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'notRun',
        message: '当前 target 没有可重放的 dynamic artifact。',
      } satisfies ReceiptTargetResult;
    }
    if (options.artifactRefresh.status === 'succeeded') {
      return {
        target,
        action: 'dynamicArtifactRefresh',
        state: 'completed',
      } satisfies ReceiptTargetResult;
    }
    if (options.artifactRefresh.status === 'failed') {
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

function toConfigStoreLayer(scope: Scope, projectLayer: 'shared' | 'local'): 'user' | 'project' | 'local' {
  if (scope === 'user') {
    return 'user';
  }
  return projectLayer === 'local' ? 'local' : 'project';
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

function normalizeBuiltInNamespace(values: Record<string, unknown>): Record<string, unknown> {
  const nextValues = structuredClone(values);
  const awNamespace = typeof nextValues.$aw === 'object' && nextValues.$aw !== null && !Array.isArray(nextValues.$aw)
    ? nextValues.$aw as Record<string, unknown>
    : {};
  const skillTriggers = typeof awNamespace.skillTriggers === 'object' && awNamespace.skillTriggers !== null && !Array.isArray(awNamespace.skillTriggers)
    ? awNamespace.skillTriggers as Record<string, unknown>
    : {};
  nextValues.$aw = awNamespace;
  awNamespace.skillTriggers = skillTriggers;
  return nextValues;
}

function pruneBuiltInNamespace(values: Record<string, unknown>): Record<string, unknown> {
  const nextValues = structuredClone(values);
  const awNamespace = nextValues.$aw;
  if (typeof awNamespace !== 'object' || awNamespace === null || Array.isArray(awNamespace)) {
    return nextValues;
  }
  const awRecord = awNamespace as Record<string, unknown>;
  const skillTriggers = awRecord.skillTriggers;
  if (
    typeof skillTriggers === 'object'
    && skillTriggers !== null
    && !Array.isArray(skillTriggers)
    && Object.keys(skillTriggers as Record<string, unknown>).length === 0
  ) {
    delete awRecord.skillTriggers;
  }
  if (Object.keys(awRecord).length === 0) {
    delete nextValues.$aw;
  }
  return nextValues;
}

async function applyBuiltInSkillTriggerRuntime(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<ReceiptTargetResult[]> {
  const ledger = await readInstalledLedger(options.env);
  const pluginRecord = ledger.plugins[options.plugin.manifest.name];
  const targetResults: ReceiptTargetResult[] = [];
  const runtimeTargets = new Map<string, {
    platform: 'codex' | 'claude';
    scope: Scope;
  }>();
  const projectKey = options.scope === 'project'
    ? await resolveCodexProjectKey(options.cwd)
    : undefined;

  const skillEntries = await resolveSkillTriggerConfigEntries(options.plugin);
  for (const platform of ['codex', 'claude'] as const) {
    const platformRecord = pluginRecord?.platforms[platform];
    const scopeRecord = options.scope === 'user'
      ? platformRecord?.userScope
      : (projectKey ? platformRecord?.projectScopes?.[projectKey] : undefined);
    if (scopeRecord?.managed) {
      runtimeTargets.set(`${platform}:${options.scope}`, {
        platform,
        scope: options.scope,
      });
    }
    if (
      options.scope === 'project' &&
      platform === 'codex' &&
      skillEntries.some((entry) => entry.platforms.includes('codex'))
    ) {
      runtimeTargets.set('codex:project', {
        platform: 'codex',
        scope: 'project',
      });
    }
  }

  for (const { platform, scope } of runtimeTargets.values()) {
    try {
      const preference = await resolveUniformSkillTriggerPreference({
        plugin: options.plugin,
        platform,
        scope,
        cwd: options.cwd,
        env: options.env,
      });
      const materialization = await materializeSkillTriggerPreference({
        pluginName: options.plugin.manifest.name,
        platform,
        resolvedOptions: {
          skillTriggerPreference: preference,
        },
        embeddedRoot: path.dirname(path.dirname(options.plugin.rootDir)),
        policyPlugin: options.plugin,
        sourcePluginRoot: options.plugin.rootDir,
        ...(platform === 'codex' && scope === 'project'
          ? {
              target: {
                platform: 'codex' as const,
                scope: 'project' as const,
                kind: 'repoSkill' as const,
                root: resolveCodexPaths(options.cwd, 'project', options.env).agentsDir,
              },
            }
          : {
              marketplaceRootOrStagingRoot: options.env.AW_HOME ?? process.env.AW_HOME ?? '',
            }),
        mode: 'bestEffortReplay',
      });
      await commitMaterializedSkillTriggerPreference(materialization.rollbackHandle);
      targetResults.push({
        target: {
          pluginName: options.plugin.manifest.name,
          platform,
          scope,
        },
        action: 'builtInApply',
        state: 'completed',
      });
    } catch (error) {
      targetResults.push({
        target: {
          pluginName: options.plugin.manifest.name,
          platform,
          scope,
        },
        action: 'builtInApply',
        state: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return targetResults;
}

export async function replayBuiltInConfigRuntime(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ReceiptTargetResult[]> {
  const entries = await resolveSkillTriggerConfigEntries(options.plugin);
  if (entries.length === 0) {
    return [];
  }
  return applyBuiltInSkillTriggerRuntime({
    plugin: options.plugin,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
}

export async function replayConfigRuntimeWrites(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  includeBuiltIn?: boolean;
  includeDynamicArtifacts?: boolean;
}): Promise<ConfigRuntimeReplayReceipt> {
  const env = options.env ?? process.env;
  const applyTargets = (options.applyTargets && options.applyTargets.length > 0)
    ? dedupeReceiptTargets(options.applyTargets)
    : await resolveDefaultConfigApplyTargets({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env,
      });

  const builtInRawResults = options.includeBuiltIn === false
    ? []
    : await replayBuiltInConfigRuntime({
        plugin: options.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env,
      });
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
        pluginName: options.plugin.manifest.name,
        scope: options.scope,
        artifactRefresh,
        applyTargets,
      });

  return {
    artifactRefresh,
    targetResults: collapseConfigApplyTargetResults({
      pluginName: options.plugin.manifest.name,
      applyTargets,
      rawTargetResults: [...builtInRawResults, ...dynamicRawResults],
    }),
  };
}

async function upsertBuiltInSkillTriggerStoreValue(options: {
  pluginName: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  skillName: string;
  trigger?: 'manual' | 'auto';
}): Promise<boolean> {
  const store = await readPluginConfigStore({
    pluginName: options.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer: options.projectLayer } : {}),
  });
  const nextValues = normalizeBuiltInNamespace(store.values);
  const skillTriggers = (((nextValues.$aw as Record<string, unknown>).skillTriggers) as Record<string, unknown>);
  const existed = typeof skillTriggers[options.skillName] === 'object'
    && skillTriggers[options.skillName] !== null
    && !Array.isArray(skillTriggers[options.skillName]);

  if (options.trigger) {
    skillTriggers[options.skillName] = {
      ...(existed ? skillTriggers[options.skillName] as Record<string, unknown> : {}),
      trigger: options.trigger,
    };
  } else {
    delete skillTriggers[options.skillName];
  }

  await writePluginConfigStore({
    pluginName: options.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    values: pruneBuiltInNamespace(nextValues),
    ...(options.scope === 'project' ? { projectLayer: options.projectLayer } : {}),
  });

  return existed;
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
  commandScope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  artifactRefresh: ArtifactRefreshReceipt;
}): Promise<void> {
  const scopeStatuses = new Map<Scope, 'succeeded' | 'failed'>();
  for (const artifact of options.artifactRefresh.artifacts) {
    const current = scopeStatuses.get(artifact.scope);
    if (current === 'failed') {
      continue;
    }
    scopeStatuses.set(artifact.scope, artifact.status);
  }
  if (scopeStatuses.size === 0) {
    if (options.artifactRefresh.status === 'skipped') {
      return;
    }
    scopeStatuses.set(options.commandScope, options.artifactRefresh.status);
  }

  for (const [scope, refreshStatus] of scopeStatuses.entries()) {
    const location: PluginLocation = scope === 'project'
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
      continue;
    }

    const trackingManifest = await readTrackingManifest(
      resolveCodexPaths(options.cwd, scope, options.env).trackingDir,
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
      plugin: schemaPlugin,
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
    const projectRefreshKeys = collectProjectRefreshKeys(schemaPlugin.manifest);
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
          '请先运行 `aw status --verbose` 查看状态，再选择 `aw repair --adopt-existing`、`aw cleanup` 或 `aw reinstall`。',
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
      await syncCodexInstallStateAfterConfigRefresh({
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

  const applyTargets = (options.applyTargets && options.applyTargets.length > 0)
    ? dedupeReceiptTargets(options.applyTargets)
    : await resolveDefaultConfigApplyTargets({
        plugin: schemaPlugin,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env ?? process.env,
      });
  targetResults = collapseConfigApplyTargetResults({
    pluginName,
    applyTargets,
    rawTargetResults: buildDynamicRefreshRawTargetResults({
      pluginName,
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
  const reset = await resetPluginConfigStore({
    pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
    ...(options.scope === 'project' ? { projectLayer } : {}),
  });

  let artifactRefresh = createSkippedRefreshReceipt();
  let configRefreshSkippedReason: ResetPluginConfigWriteReceipt['configRefreshSkippedReason'];
  let targetResults: ReceiptTargetResult[] = [];

  if (options.scope === 'project' && projectLayer === 'local') {
    configRefreshSkippedReason = 'projectLocalOverride';
  } else if (reset.deleted && schemaAccess.plugin && schemaAccess.installedConsumers.length > 0) {
    const env = options.env ?? process.env;
    const shouldCheckProjectRecord = options.scope === 'project';
    let hasRefreshTarget = !shouldCheckProjectRecord;
    if (shouldCheckProjectRecord) {
      const location: PluginLocation = {
        plugin: pluginName,
        platform: 'codex',
        scope: 'project',
        projectKey: await resolveCodexProjectKey(options.cwd),
      };
      const recordRead = await readInstallRecordForLocation({
        cwd: options.cwd,
        location,
        env,
      });
      hasRefreshTarget = recordRead.status === 'ok';
    }
    if (hasRefreshTarget) {
      artifactRefresh = await refreshArtifactsAfterConfigWrite({
        plugin: schemaAccess.plugin,
        commandScope: options.scope,
        cwd: options.cwd,
        env: options.env,
        changedKeys: removedKeys,
      });
      if (artifactRefresh.attempted && (artifactRefresh.status === 'succeeded' || artifactRefresh.status === 'failed')) {
        await syncCodexInstallStateAfterConfigRefresh({
          plugin: schemaAccess.plugin,
          commandScope: options.scope,
          cwd: options.cwd,
          env,
          artifactRefresh,
        });
      } else if (!artifactRefresh.attempted && options.scope === 'user') {
        configRefreshSkippedReason = 'noRefreshTarget';
      }
    } else {
      configRefreshSkippedReason = 'noRefreshTarget';
    }
  } else if (reset.deleted && removedKeys.length > 0) {
    configRefreshSkippedReason = 'noRefreshTarget';
  }

  if (schemaAccess.plugin && schemaAccess.installedConsumers.length > 0) {
    const applyTargets = (options.applyTargets && options.applyTargets.length > 0)
      ? dedupeReceiptTargets(options.applyTargets)
      : await resolveDefaultConfigApplyTargets({
          plugin: schemaAccess.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env ?? process.env,
        });
    const builtInRawResults = !reset.deleted || (options.scope === 'project' && projectLayer === 'local')
      ? []
      : await replayBuiltInConfigRuntime({
          plugin: schemaAccess.plugin,
          scope: options.scope,
          cwd: options.cwd,
          env: options.env,
        });
    targetResults = collapseConfigApplyTargetResults({
      pluginName,
      applyTargets,
      rawTargetResults: [
        ...builtInRawResults,
        ...buildDynamicRefreshRawTargetResults({
          pluginName,
          scope: options.scope,
          artifactRefresh,
          applyTargets,
        }),
      ],
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

export async function applyBuiltInConfigWrite(options: {
  pluginName: string;
  plugin?: PluginMeta | null;
  pluginError?: Error | null;
  scope: Scope;
  projectLayer?: 'shared' | 'local';
  cwd: string;
  env?: NodeJS.ProcessEnv;
  applyTargets?: ReceiptTargetIdentity[];
  key: string;
  action: 'set' | 'unset';
  value?: 'manual' | 'auto';
}): Promise<BuiltInConfigWriteReceipt> {
  const pluginName = assertSafePluginConfigSegment(options.pluginName);
  const projectLayer = options.scope === 'project' ? (options.projectLayer ?? 'shared') : 'shared';
  const schemaAccess = await resolvePluginConfigSchemaAccess({
    pluginName,
    currentPlugin: options.plugin ?? null,
    currentPluginError: options.pluginError,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const parsedKey = parseBuiltInSkillTriggerKey(options.key);
  if (!parsedKey) {
    throw new Error(`Unknown config key "${options.key}".`);
  }
  if (options.scope === 'project' && projectLayer === 'local') {
    throw new Error('project local 层不支持 SkillTrigger 内建字段；请改用 `--scope project` 或整层 reset 清理误写入值。');
  }
  if (options.action === 'set' && options.value !== 'manual' && options.value !== 'auto') {
    throw new Error(`Unsupported skill trigger preference "${String(options.value)}". Expected one of: manual, auto.`);
  }

  const resolved = await resolveConfigReadV2({
    pluginName,
    plugin: schemaAccess.plugin,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const field = findConfigFieldEntry(resolved.fields, options.key);
  if (options.action === 'set') {
    if (!schemaAccess.plugin) {
      throw new Error(`configSchemaUnavailable: Unknown plugin "${pluginName}".`);
    }
    if (!field) {
      throw new Error(`Unknown config key "${options.key}".`);
    }
    if (!field.writable) {
      throw new Error(`${options.key} 当前是 ${field.valueState} 字段，不能写入新值。`);
    }
  }
  if (options.action === 'unset') {
    if (!field && !schemaAccess.plugin) {
      const store = await readPluginConfigStore({
        pluginName,
        scope: options.scope,
        cwd: options.cwd,
        env: options.env,
        ...(options.scope === 'project' ? { projectLayer } : {}),
      });
      if (!isBuiltInConfigKey(options.key) || !Object.keys(store.values).includes('$aw')) {
        throw new Error(`configSchemaUnavailable: Unknown plugin "${pluginName}".`);
      }
    }
    if (field && field.storedSourceLayer && field.storedSourceLayer !== toConfigStoreLayer(options.scope, projectLayer)) {
      throw new Error(`${options.key} 只能在 ${field.storedSourceLayer} 层清理。`);
    }
    if (field && field.valueState === 'default' && field.storedSourceLayer === undefined) {
      throw new Error(`${options.key} 当前没有可清理的存量值。`);
    }
  }

  const existed = await upsertBuiltInSkillTriggerStoreValue({
    pluginName,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
    skillName: parsedKey.skillName,
    ...(options.action === 'set' ? { trigger: options.value } : {}),
  });

  const nextRead = await resolveConfigReadV2({
    pluginName,
    plugin: schemaAccess.plugin,
    scope: options.scope,
    projectLayer,
    cwd: options.cwd,
    env: options.env,
  });
  const nextField = findConfigFieldEntry(nextRead.fields, options.key);
  const affectedFields: ConfigReceiptFieldEntryV2[] = [
    buildReceiptFieldEntry({
      key: options.key,
      title: nextField?.title ?? field?.title ?? `${parsedKey.skillName} 触发方式`,
      kind: 'builtIn',
      reserved: true,
      action: options.action,
      scope: options.scope,
      projectLayer,
      valueState: nextField?.valueState ?? field?.valueState,
    }),
  ];
  const env = options.env ?? process.env;
  const targetResults = schemaAccess.plugin
    ? (await replayConfigRuntimeWrites({
        plugin: schemaAccess.plugin,
        scope: options.scope,
        cwd: options.cwd,
        env,
        applyTargets: options.applyTargets,
        includeBuiltIn: true,
        includeDynamicArtifacts: false,
      })).targetResults
    : [];

  return {
    plugin: pluginName,
    scope: options.scope,
    projectLayer,
    ...(schemaAccess.schema ? { schema: schemaAccess.schema } : {}),
    affectedFields,
    targetResults,
    ...(options.action === 'unset' ? { existed, deleted: existed } : {}),
    warnings: [],
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
        kind: isBuiltInConfigKey(key) ? 'builtIn' : 'manifest',
        reserved: isBuiltInConfigKey(key),
        action: 'reset',
        scope: options.scope,
        projectLayer,
      }),
    );
  }
}
