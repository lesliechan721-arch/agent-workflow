import path from 'node:path';

import fs from 'fs-extra';

import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import type { ResolvedPluginTarget } from './common.js';
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
  InstallRecordArtifact,
  InstallRecordFile,
  PluginLocation,
} from '../install-state/types.js';
import { collectInstallEvidence, type InstallEvidence } from '../install-state/evidence.js';
import { projectInstallState, type ProjectInstallStateProjection } from '../install-state/status-projection.js';
import {
  createInstallRecordDeleteStage,
  createPathDeleteStage,
  createProjectArtifactIdentityDeleteStage,
  runInstallStateGraphRecordTransaction,
} from '../install-state/transactions.js';
import {
  createSharedSkillTriggerRuntimeRemovalStages,
  planSharedSkillTriggerRuntimeOwnerRemoval,
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
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
} from '../utils/paths.js';
import { sha256Hex } from '../install-state/internal.js';

export interface InstallStateRemovalRuntime extends CommandExecutionContextInput {
  adapters?: Record<PlatformName, PlatformAdapter>;
  lifecycleRunner?: LifecycleProcessRunner;
}

export interface InstallStateRemovalResult {
  warnings: string[];
  repoManagedArtifacts: GeneratedArtifact[];
}

export interface InstallStateCleanupResult extends InstallStateRemovalResult {
  summary: string;
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
}

interface ProtectedRecordEntry {
  location: PluginLocation;
  dependencyEdges: InstallRecordFile['record']['dependencyEdges'];
}

function sameLocation(left: PluginLocation, right: PluginLocation): boolean {
  return left.plugin === right.plugin
    && left.platform === right.platform
    && left.scope === right.scope
    && (left.projectKey ?? null) === (right.projectKey ?? null);
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
  const localRecords = await listReadableScopedRecords(options);
  const blockedDependents = localRecords
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) =>
      entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location);

  const inspection = await inspectGlobalDependencyIndex(options.env);
  if (inspection.status !== 'ok') {
    return options.location.scope === 'user'
      ? {
          allowed: false,
          blockedDependents,
          failClosedReason: inspection.status === 'missing'
            ? 'dependency index 缺失，无法安全确认其它 scope 是否仍在引用该插件。'
            : `dependency index 已损坏：${inspection.error}`,
        }
      : {
          allowed: blockedDependents.length === 0,
          blockedDependents,
        };
  }

  const verifiedIndexDependents = inspection.value.records
    .filter((entry, index) => inspection.references[index]?.status === 'verified')
    .filter((entry) => !sameLocation(entry.location, options.location))
    .filter((entry) =>
      entry.dependencyEdges.some((edge) => sameLocation(edge.dependency, options.location)))
    .map((entry) => entry.location);
  blockedDependents.push(...verifiedIndexDependents);

  const coverageIssue = inspection.references.some((reference) =>
    reference.status !== 'verified'
    && isRelevantIndexReference(options.location, reference));

  if (options.location.scope === 'user' && inspection.references.some((reference) => reference.status !== 'verified')) {
    return {
      allowed: false,
      blockedDependents,
      failClosedReason: 'dependency index 覆盖范围不可信，当前无法安全删除 user-scope 插件。',
    };
  }

  if (coverageIssue) {
    return {
      allowed: false,
      blockedDependents,
      failClosedReason: `当前 projectKey=${options.location.projectKey ?? '(missing-project-key)'} 的 dependency index 覆盖范围不可信，无法安全删除该 project-scope 插件。`,
    };
  }

  const dedupedBlockedDependents = blockedDependents.filter((location, index, all) =>
    all.findIndex((candidate) => sameLocation(candidate, location)) === index);
  return {
    allowed: dedupedBlockedDependents.length === 0,
    blockedDependents: dedupedBlockedDependents,
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

async function resolveEmbeddedRoot(): Promise<string> {
  return resolveEmbeddedPluginsRoot();
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
  commandOptions: CommandOptions;
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

  const adapters = options.runtime.adapters;
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

  const removalPlan = await planSharedSkillTriggerRuntimeOwnerRemoval({
    location,
    embeddedRoot: await resolveEmbeddedRoot(),
    target: createMaterializationTarget(
      location.platform,
      location.scope,
      options.commandOptions.cwd,
      context.env,
    ),
    env: context.env,
  });
  const removalStages = await createSharedSkillTriggerRuntimeRemovalStages({
    plan: removalPlan,
    pluginName: location.plugin,
    platform: location.platform,
    embeddedRoot: await resolveEmbeddedRoot(),
    target: createMaterializationTarget(
      location.platform,
      location.scope,
      options.commandOptions.cwd,
      context.env,
    ),
    env: context.env,
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

export async function cleanupInstallStateTarget(options: {
  pluginName: string;
  location: PluginLocation;
  commandOptions: CommandOptions & { force?: boolean };
  runtime: InstallStateRemovalRuntime;
  target?: ResolvedPluginTarget | null;
}): Promise<InstallStateCleanupResult> {
  const context = createCommandExecutionContext(options.runtime);
  const evidence = await collectInstallEvidence({
    cwd: options.commandOptions.cwd,
    location: options.location,
    env: context.env,
  });
  const projection = projectInstallState(evidence);

  if (projection.kind === 'installed') {
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
  if (protection.blockedDependents.length > 0) {
    throw new Error(
      `${renderLocation(options.location)} 仍被以下 verified dependent 引用：${protection.blockedDependents.map(renderLocation).join('、')}。`,
    );
  }
  if (!protection.allowed) {
    throw new Error(protection.failClosedReason ?? 'dependency protection failed closed');
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
  const pluginMeta = await loadPreferredPluginMeta({
    target: options.target,
    recordFile: recordRead.status === 'ok' ? recordRead.value : null,
  });
  if (options.runtime.adapters?.[options.location.platform] && options.location.scope === 'user') {
    if (pluginMeta) {
      await options.runtime.adapters[options.location.platform]!.uninstallPlugin(pluginMeta, options.location.scope);
    } else if (typeof (options.runtime.adapters[options.location.platform] as PlatformAdapter & {
      uninstallUserNativePluginById?: (pluginNameOrId: string) => Promise<void>;
    }).uninstallUserNativePluginById === 'function') {
      await (options.runtime.adapters[options.location.platform] as PlatformAdapter & {
        uninstallUserNativePluginById: (pluginNameOrId: string) => Promise<void>;
      }).uninstallUserNativePluginById(`${options.pluginName}@aw`);
    }
  }
  if (pluginMeta && recordRead.status === 'ok' && options.runtime.adapters?.[options.location.platform]) {
    await options.runtime.adapters[options.location.platform]!.uninstallExtensions(
      pluginMeta,
      options.location.scope,
      recordRead.value.record.artifacts.map(toGeneratedArtifact),
    );
  }

  const removalPlan = await planSharedSkillTriggerRuntimeOwnerRemoval({
    location: options.location,
    embeddedRoot: await resolveEmbeddedRoot(),
    target: createMaterializationTarget(
      options.location.platform,
      options.location.scope,
      options.commandOptions.cwd,
      context.env,
    ),
    env: context.env,
  });
  const removalStages = await createSharedSkillTriggerRuntimeRemovalStages({
    plan: removalPlan,
    pluginName: options.location.plugin,
    platform: options.location.platform,
    embeddedRoot: await resolveEmbeddedRoot(),
    target: createMaterializationTarget(
      options.location.platform,
      options.location.scope,
      options.commandOptions.cwd,
      context.env,
    ),
    env: context.env,
  });

  const recordPath = getInstallRecordPath(options.commandOptions.cwd, options.location, context.env);
  const runtimeRoot = recordRead.status === 'ok'
    ? recordRead.value.record.lifecycle?.runtimeRoot
    : deriveLocationRuntimeRoot(options.location, context.env);
  await runInstallStateGraphRecordTransaction({
    mode: 'delete',
    location: options.location,
    recordPath,
    env: context.env,
    stages: [
      ...removalStages.stages,
      ...(evidence.projectSharedIdentity.read
        && evidence.projectSharedIdentity.read.status !== 'missing'
        ? [createProjectArtifactIdentityDeleteStage({ filePath: evidence.projectSharedIdentity.read.path })]
        : []),
      createPathDeleteStage({
        label: 'dynamic diagnostic cache',
        filePath: getDiagnosticCachePath(options.commandOptions.cwd, options.location, context.env),
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
        filePath: getNativeTransactionMarkerPath(options.pluginName, context.env),
        rollbackWarningCode: 'nativeMarkerRollbackFailed',
        finalizeWarningCode: 'nativeMarkerFinalizeFailed',
      }),
      createInstallRecordDeleteStage({ filePath: recordPath }),
    ],
  });
  const gcWarning = await removeLifecycleRuntimeGc({ env: context.env });
  const warnings = [
    ...removalStages.warnings,
    ...(backedUp.length > 0 ? [`已备份 ${backedUp.length} 个共享文件。`] : []),
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
}> {
  const evidence = await collectInstallEvidence({
    cwd: options.cwd,
    location: options.location,
    env: options.env,
  });
  const projection = projectInstallState(evidence);
  return {
    evidence,
    projection,
    forceCleanupRequired: !projection.installRecordPresent
      && projection.kind === 'residual'
      && evidence.projectSharedIdentity.artifacts.some((artifact) => artifact.file.exists),
  };
}
