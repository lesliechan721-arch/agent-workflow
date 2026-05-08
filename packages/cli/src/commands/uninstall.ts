import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { applyClaudeUninstallLedger } from '../adapters/claude.js';
import { applyCodexUninstallLedger } from '../adapters/codex.js';
import {
  readClaudeSettings,
  writeClaudeSettings,
  type ClaudeSettings,
} from '../adapters/helpers.js';
import type {
  CommandOptions,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeRecord,
  PluginLocation,
  PlatformAdapter,
  LedgerStateReason,
  PlatformName,
  PluginStatusReport,
} from '../types.js';
import {
  getInstalledLedgerPath,
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import { resolveCurrentCatalog } from '../utils/plugin-catalog.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import { iterateInstalledScopeRecords } from '../utils/plugin-dependency-graph.js';
import {
  normalizePluginLocation,
  serializePluginLocation,
} from '../utils/plugin-dependency-location.js';
import {
  planPluginDependencyUninstall,
  type PluginDependencyPlannerHealthRecord,
  type PluginDependencyPlannerHealthState,
  type PluginDependencyPlannerInstalledRecord,
  type PluginDependencyPlannerState,
} from '../utils/plugin-dependency-planner.js';
import {
  garbageCollectLifecycleConfigSnapshots,
  runLifecycleScript,
} from '../utils/plugin-scripts.js';
import {
  resolveAwHome,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
} from '../utils/paths.js';
import {
  commitMaterializedSkillTriggerPreference,
  rematerializeSkillTriggerPreferenceAfterUninstall,
  rollbackMaterializedSkillTriggerPreference,
  type SkillTriggerMaterializationRollbackHandle,
} from '../utils/skill-trigger-preferences.js';
import { mergeGeneratedArtifacts } from '../utils/generated-artifacts.js';
import {
  getTrackingManifestPath,
  getTrackingRecord,
  readTrackingManifest,
  removeTrackingRecordFromManifest,
  writeTrackingManifest,
} from '../utils/tracking.js';
import {
  collectCommandWarnings,
  createAdapters,
  filterPostCommandDriftWarnings,
  getGeneratedArtifactIdentityRefusal,
  getTrackingArtifactIdentityRefusal,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  resolveTargetPlatforms,
  type ResolvedPluginTarget,
} from './common.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  normalizeCommandOptions,
  type RawCommandOptions,
} from './options.js';
import { tryUninstallUsingInstallState } from './install-state-removal.js';

type UninstallCommandRuntime = CommandExecutionContextInput & {
  skipLifecycle?: boolean;
  skipLifecycleSnapshotGc?: boolean;
};

interface PlannedUninstallExecution {
  location: PluginLocation;
  target: ResolvedPluginTarget;
  autoDependency: boolean;
}

interface FileRollbackState {
  path: string;
  content: string | null;
}

type PathRollbackState =
  | {
    path: string;
    state: 'absent';
  }
  | {
    path: string;
    state: 'file' | 'directory';
    backupPath: string;
  }
  | {
    path: string;
    state: 'symlink';
    target: string;
  };

type ClaudePermissionState = {
  allow: string[];
  ask: string[];
  deny: string[];
};

interface ClaudePermissionsRollbackState {
  topLevelPermissions?: ClaudePermissionState;
  generatedPermissions?: ClaudePermissionState;
  manualPermissions?: ClaudePermissionState;
}

interface CodexNativeRecoveryCleanupAdapter extends PlatformAdapter {
  uninstallUserNativePluginById(pluginNameOrId: string): Promise<void>;
}

export interface ArtifactRollbackState {
  files: FileRollbackState[];
  pathSnapshots: PathRollbackState[];
  cleanupRoots: string[];
  claudePermissions?: ClaudePermissionsRollbackState;
}

function resolveTrackingDir(
  cwd: string,
  platform: PlatformName,
  scope: CommandOptions['scope'],
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'claude'
    ? resolveClaudePaths(cwd, scope, env).trackingDir
    : resolveCodexPaths(cwd, scope, env).trackingDir;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendRollbackIssue(
  issues: string[],
  surfaces: Set<string>,
  summary: string,
  error: unknown,
  surfaceHints: readonly string[],
): void {
  issues.push(`${summary}：${normalizeErrorMessage(error)}`);
  for (const surface of surfaceHints) {
    surfaces.add(surface);
  }
}

function createRollbackFailureError(
  error: unknown,
  issues: string[],
  surfaces: Set<string>,
): Error {
  if (issues.length === 0) {
    return error instanceof Error ? error : new Error(String(error));
  }

  const baseMessage = normalizeErrorMessage(error);
  const surfaceText = [...surfaces].join('、');
  return new Error(
    `${baseMessage}；回滚未完全完成，请人工检查 ${surfaceText}。${issues.join('；')}`,
  );
}

function uniqueArtifactPaths(
  paths: Iterable<string>,
): string[] {
  return [...new Set([...paths].map((value) => path.normalize(value)))];
}

async function capturePathRollbackState(
  pathname: string,
  backupRoot: string,
  index: number,
): Promise<PathRollbackState> {
  const normalizedPath = path.normalize(pathname);
  if (!(await fs.pathExists(normalizedPath))) {
    return {
      path: normalizedPath,
      state: 'absent',
    };
  }

  const stats = await fs.lstat(normalizedPath);
  if (stats.isSymbolicLink()) {
    return {
      path: normalizedPath,
      state: 'symlink',
      target: await fs.readlink(normalizedPath),
    };
  }

  const backupPath = path.join(backupRoot, `${index}-${path.basename(normalizedPath)}`);
  await fs.copy(normalizedPath, backupPath, {
    overwrite: true,
    errorOnExist: false,
  });

  return {
    path: normalizedPath,
    state: stats.isDirectory() ? 'directory' : 'file',
    backupPath,
  };
}

async function restorePathRollbackState(snapshot: PathRollbackState): Promise<void> {
  if (snapshot.state === 'absent') {
    await fs.remove(snapshot.path);
    return;
  }

  await fs.remove(snapshot.path);
  await fs.ensureDir(path.dirname(snapshot.path));

  if (snapshot.state === 'symlink') {
    await fs.symlink(snapshot.target, snapshot.path);
    return;
  }

  await fs.copy(snapshot.backupPath, snapshot.path, {
    overwrite: true,
    errorOnExist: false,
  });
}

export async function disposeArtifactRollbackState(
  rollbackState: ArtifactRollbackState | undefined,
): Promise<void> {
  if (!rollbackState) {
    return;
  }

  await Promise.all(
    rollbackState.cleanupRoots.map((cleanupRoot) =>
      fs.remove(cleanupRoot).catch(() => undefined)),
  );
}

export function collectArtifactRollbackSurfaceHints(
  platform: PlatformName,
  cwd: string,
  scope: CommandOptions['scope'],
  env: NodeJS.ProcessEnv,
  trackedArtifacts: GeneratedArtifact[],
  rollbackState: ArtifactRollbackState | undefined,
): string[] {
  const hints = new Set<string>(['repo artifacts']);

  if (platform === 'codex') {
    const configTomlPath = resolveCodexPaths(cwd, scope, env).configTomlPath;
    if (
      trackedArtifacts.some((artifact) => path.normalize(artifact.path) === path.normalize(configTomlPath)) ||
      rollbackState?.pathSnapshots.some((snapshot) => path.normalize(snapshot.path) === path.normalize(configTomlPath))
    ) {
      hints.add(configTomlPath);
    }
  }

  return [...hints];
}

function preserveLedgerState(
  baseline: InstalledLedger,
  nextLedger: InstalledLedger,
): InstalledLedger {
  if (baseline.ledgerState.status === 'available') {
    return nextLedger;
  }

  return {
    ...nextLedger,
    ledgerState: {
      ...baseline.ledgerState,
    },
  };
}

function createDegradedLedger(
  baseline: InstalledLedger,
  reason: LedgerStateReason,
): InstalledLedger {
  return {
    ...baseline,
    ledgerState: {
      status: 'degraded',
      degradedAt: new Date().toISOString(),
      reason,
    },
  };
}

async function writeDegradedLedger(
  baseline: InstalledLedger,
  reason: LedgerStateReason,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await writeInstalledLedger(createDegradedLedger(baseline, reason), env);
}

async function applyUninstallLedger(
  platform: PlatformName,
  ledger: InstalledLedger,
  target: ResolvedPluginTarget,
  options: CommandOptions,
): Promise<InstalledLedger> {
  return platform === 'claude'
    ? applyClaudeUninstallLedger(ledger, target.pluginName, options.scope, options.cwd)
    : applyCodexUninstallLedger(ledger, target.pluginName, options.scope, options.cwd);
}

async function getScopeRecordForUninstall(
  ledger: InstalledLedger,
  platform: PlatformName,
  pluginName: string,
  options: CommandOptions,
): Promise<InstalledScopeRecord<Record<string, unknown>> | undefined> {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (options.scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  const projectKey = platform === 'claude'
    ? await resolveClaudeProjectKey(options.cwd)
    : await resolveCodexProjectKey(options.cwd);
  return platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined;
}

function scopeLabel(scope: CommandOptions['scope']): string {
  return scope === 'project' ? '当前项目' : '当前用户';
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function formatDependentLocation(
  location: PluginLocation,
  currentProjectKeysByPlatform: Partial<Record<PlatformName, string | null>>,
): string {
  const normalized = normalizePluginLocation(location);
  const scopeText = normalized.scope === 'user'
    ? scopeLabel('user')
    : normalized.projectKey === currentProjectKeysByPlatform[normalized.platform]
      ? scopeLabel('project')
      : `项目 ${normalized.projectKey}`;
  return `${platformLabel(normalized.platform)} / ${scopeText} / ${normalized.plugin}`;
}

function mapPlannerHealthFromStatus(options: {
  platform: PlatformName;
  scope: CommandOptions['scope'];
  pluginStatus: PluginStatusReport;
  trackingIdentityRefusal: string | null;
}): PluginDependencyPlannerHealthState {
  const { pluginStatus } = options;
  if (isCodexBreadcrumbOnlyUninstallTarget(options.platform, options.scope, pluginStatus)) {
    return 'breadcrumbOnly';
  }
  if (options.trackingIdentityRefusal) {
    return 'trackingBroken';
  }
  if (pluginStatus.ledgerStateStatus && pluginStatus.ledgerStateStatus !== 'available') {
    return 'degraded';
  }
  if (getGeneratedArtifactIdentityRefusal(pluginStatus)) {
    return 'repairRequired';
  }

  const managedEvidence = hasScopeManagedEvidence(pluginStatus);
  if (!managedEvidence && pluginStatus.externalOwnership?.present) {
    return 'externalOnly';
  }
  if (!managedEvidence && pluginStatus.native.pluginEnabled === true) {
    return 'enabledOnly';
  }
  if (
    !managedEvidence &&
    pluginStatus.native.cacheStatus !== undefined &&
    pluginStatus.native.cacheStatus !== 'missing'
  ) {
    return 'cacheOnly';
  }
  if (
    !managedEvidence &&
    (
      pluginStatus.platformNativeFallbackEvidence?.present === true ||
      pluginStatus.platformRuntimeEvidence?.present === true
    )
  ) {
    return 'external';
  }
  if (!managedEvidence) {
    return 'missing';
  }
  return 'healthy';
}

async function resolveCurrentProjectKeysByPlatform(
  cwd: string,
  platforms: readonly PlatformName[],
  scope: CommandOptions['scope'],
): Promise<Partial<Record<PlatformName, string | null>>> {
  if (scope === 'user') {
    return Object.fromEntries(platforms.map((platform) => [platform, null]));
  }

  const uniquePlatforms = [...new Set(platforms)];
  const entries = await Promise.all(uniquePlatforms.map(async (platform) => ([
    platform,
    platform === 'claude'
      ? await resolveClaudeProjectKey(cwd)
      : await resolveCodexProjectKey(cwd),
  ]) as const));
  return Object.fromEntries(entries);
}

function createCommandLocation(options: {
  plugin: string;
  platform: PlatformName;
  scope: CommandOptions['scope'];
  currentProjectKeysByPlatform: Partial<Record<PlatformName, string | null>>;
}): PluginLocation {
  return normalizePluginLocation({
    plugin: options.plugin,
    platform: options.platform,
    scope: options.scope,
    projectKey: options.scope === 'user'
      ? null
      : (options.currentProjectKeysByPlatform[options.platform] ?? null),
  });
}

function isPlannerHealthLocationAccessible(
  location: PluginLocation,
  currentProjectKeysByPlatform: Partial<Record<PlatformName, string | null>>,
): boolean {
  if (location.scope === 'user') {
    return true;
  }
  return location.projectKey === currentProjectKeysByPlatform[location.platform];
}

async function collectUninstallPlannerState(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  adapters: Record<PlatformName, PlatformAdapter>;
  ledger: InstalledLedger;
  requestedLocations: PluginLocation[];
  currentProjectKeysByPlatform: Partial<Record<PlatformName, string | null>>;
}): Promise<PluginDependencyPlannerState> {
  const currentCatalog = await resolveCurrentCatalog(options.env);
  const currentCatalogPlugins = await resolvePluginsFromCatalog(currentCatalog.rootDir, undefined);
  const currentCatalogByPlugin = Object.fromEntries(
    currentCatalogPlugins.map((plugin) => [plugin.manifest.name, plugin.manifest]),
  );

  const installedRecords: PluginDependencyPlannerInstalledRecord[] = iterateInstalledScopeRecords(options.ledger)
    .map(({ location, record }) => ({
      location,
      resolvedVersion: record.resolvedVersion,
      installSource: record.installSource
        ? structuredClone(record.installSource)
        : undefined,
      dependencyEdges: record.dependencyEdges
        ? structuredClone(record.dependencyEdges)
        : undefined,
      installOptions: record.installOptions
        ? structuredClone(record.installOptions)
        : undefined,
    }));

  const requestedKeys = new Set(options.requestedLocations.map((location) => serializePluginLocation(location)));
  const healthLocations = iterateInstalledScopeRecords(options.ledger)
    .map(({ location }) => normalizePluginLocation(location))
    .filter((location) => (
      requestedKeys.has(serializePluginLocation(location)) ||
      isPlannerHealthLocationAccessible(location, options.currentProjectKeysByPlatform)
    ));

  const healthRecords: PluginDependencyPlannerHealthRecord[] = [];
  const seenHealthKeys = new Set<string>();
  for (const location of healthLocations) {
    const locationKey = serializePluginLocation(location);
    if (seenHealthKeys.has(locationKey)) {
      continue;
    }
    seenHealthKeys.add(locationKey);

    const [target] = await loadPluginTargetsForCommand(
      options.cwd,
      location.scope,
      [location.plugin],
      {
        allowHistoricalFallback: true,
        env: options.env,
      },
    );
    const status = await options.adapters[location.platform].status(target.plugin, location.scope);
    const pluginStatus = status.plugins[0];
    if (!pluginStatus) {
      continue;
    }

    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.cwd,
      env: options.env,
      platform: location.platform,
      scope: location.scope,
      pluginName: location.plugin,
    });
    healthRecords.push({
      location,
      state: mapPlannerHealthFromStatus({
        platform: location.platform,
        scope: location.scope,
        pluginStatus,
        trackingIdentityRefusal,
      }),
      visible: true,
      managedByAw: hasScopeManagedEvidence(pluginStatus),
    });
  }

  return {
    currentCatalogByPlugin,
    installedRecords,
    healthRecords,
  };
}

async function resolveUninstallExecutionTargets(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  plannedLocations: PluginLocation[];
  autoCleanupLocations: PluginLocation[];
}): Promise<PlannedUninstallExecution[]> {
  const autoCleanupKeys = new Set(
    options.autoCleanupLocations.map((location) => serializePluginLocation(location)),
  );
  const executions: PlannedUninstallExecution[] = [];

  for (const location of options.plannedLocations) {
    const [target] = await loadPluginTargetsForCommand(
      options.cwd,
      location.scope,
      [location.plugin],
      {
        allowHistoricalFallback: true,
        env: options.env,
      },
    );
    executions.push({
      location,
      target,
      autoDependency: autoCleanupKeys.has(serializePluginLocation(location)),
    });
  }

  return executions;
}

function shouldRefuseHistoricalUninstall(
  platform: PlatformName,
  pluginStatus: PluginStatusReport,
): string | null {
  const managed = hasScopeManagedEvidence(pluginStatus);
  const runtimeEvidence = pluginStatus.platformRuntimeEvidence?.present === true;
  const nativeFallback = pluginStatus.platformNativeFallbackEvidence?.present === true;

  if (!managed && runtimeEvidence && !nativeFallback) {
    return '当前只剩原生 loader 仍会读取该插件的证据，CLI 缺少可证明安全的受管记录；请先检查 drift，再决定是否手动清理。';
  }

  if (platform === 'codex' && !managed && nativeFallback) {
    return '当前只剩 Codex user native fallback evidence，无法证明 shared native refs 是否仍被其他 repo 引用；请显式确认后再手动清理。';
  }

  return null;
}

function isCodexBreadcrumbOnlyUninstallTarget(
  platform: PlatformName,
  scope: CommandOptions['scope'],
  pluginStatus: PluginStatusReport,
): boolean {
  return (
    platform === 'codex' &&
    scope === 'user' &&
    pluginStatus.native.recovery?.present === true &&
    !hasScopeManagedEvidence(pluginStatus)
  );
}

function getCodexNativeRecoveryCleanupAdapter(
  adapter: PlatformAdapter,
): CodexNativeRecoveryCleanupAdapter {
  if (typeof (adapter as Partial<CodexNativeRecoveryCleanupAdapter>).uninstallUserNativePluginById !== 'function') {
    throw new Error('当前 Codex adapter 不支持 native recovery breadcrumb cleanup。');
  }

  return adapter as CodexNativeRecoveryCleanupAdapter;
}

function didUninstallWriteNativeState(
  platform: PlatformName,
  scope: CommandOptions['scope'],
  pluginStatus: PluginStatusReport,
): boolean {
  if (platform === 'codex') {
    if (scope === 'project') {
      return false;
    }

    return (
      pluginStatus.native.pluginInstalled ||
      pluginStatus.native.pluginEnabled === true ||
      pluginStatus.native.configEntryPresent === true ||
      pluginStatus.native.cacheStatus === 'ambiguous' ||
      pluginStatus.native.cacheStatus === 'invalid' ||
      pluginStatus.native.recovery?.present === true
    );
  }

  return pluginStatus.native.pluginInstalled;
}

function shouldRematerializeSkillTriggersAfterUninstall(
  platform: PlatformName,
  scope: CommandOptions['scope'],
  target: ResolvedPluginTarget,
): boolean {
  if (platform === 'codex' && scope === 'project') {
    return false;
  }

  return target.source === 'currentCatalog' && Boolean(target.embeddedPlugin?.manifest.skills);
}

function normalizeGeneratedArtifactForUninstall(
  platform: PlatformName,
  artifact: PluginStatusReport['generatedArtifacts'][number],
): GeneratedArtifact {
  return {
    path: artifact.path,
    kind: artifact.kind,
    platform,
    ...(artifact.hookGroups === undefined
      ? {}
      : { hookGroups: structuredClone(artifact.hookGroups) }),
    ...(artifact.paths === undefined ? {} : { paths: [...artifact.paths] }),
    ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    ...(artifact.id === undefined ? {} : { id: artifact.id }),
    ...(artifact.target === undefined ? {} : { target: artifact.target }),
    ...(artifact.state === undefined ? {} : { state: artifact.state }),
    ...(artifact.disabledReason === undefined ? {} : { disabledReason: artifact.disabledReason }),
    ...(artifact.refreshKeys === undefined ? {} : { refreshKeys: [...artifact.refreshKeys] }),
    ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
    ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
    ...(artifact.roleKey === undefined ? {} : { roleKey: artifact.roleKey }),
    ...(artifact.lastRefresh === undefined ? {} : { lastRefresh: structuredClone(artifact.lastRefresh) }),
    ...(artifact.refreshReach === undefined ? {} : { refreshReach: structuredClone(artifact.refreshReach) }),
  };
}

function cloneClaudePermissionState(
  permissions:
    | ClaudePermissionState
    | ClaudeSettings['permissions']
    | NonNullable<NonNullable<ClaudeSettings['awGenerated']>['permissions']>[string]
    | NonNullable<NonNullable<ClaudeSettings['awGenerated']>['manualPermissions']>
    | undefined,
): ClaudePermissionState | undefined {
  if (!permissions) {
    return undefined;
  }

  return {
    allow: [...(permissions.allow ?? [])],
    ask: [...(permissions.ask ?? [])],
    deny: [...(permissions.deny ?? [])],
  };
}

function hasClaudePermissions(
  permissions: ClaudePermissionState | undefined,
): boolean {
  return Boolean(
    (permissions?.allow.length ?? 0) > 0 ||
      (permissions?.ask.length ?? 0) > 0 ||
      (permissions?.deny.length ?? 0) > 0,
  );
}

function cleanupClaudeGeneratedPermissions(settings: ClaudeSettings): void {
  if (settings.awGenerated?.permissions && Object.keys(settings.awGenerated.permissions).length === 0) {
    delete settings.awGenerated.permissions;
  }

  if (
    settings.awGenerated &&
    settings.awGenerated.permissions === undefined &&
    settings.awGenerated.manualPermissions === undefined &&
    settings.awGenerated.hooks === undefined &&
    settings.awGenerated.manualHooks === undefined
  ) {
    delete settings.awGenerated;
  }
}

async function captureTextFile(pathname: string): Promise<FileRollbackState> {
  if (!(await fs.pathExists(pathname))) {
    return {
      path: pathname,
      content: null,
    };
  }

  return {
    path: pathname,
    content: await fs.readFile(pathname, 'utf8'),
  };
}

async function restoreTextFile(snapshot: FileRollbackState): Promise<void> {
  if (snapshot.content === null) {
    await fs.remove(snapshot.path);
    return;
  }

  await fs.ensureDir(path.dirname(snapshot.path));
  await fs.writeFile(snapshot.path, snapshot.content, 'utf8');
}

export async function captureArtifactRollbackState(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<ArtifactRollbackState> {
  if (platform === 'codex') {
    const paths = resolveCodexPaths(cwd, scope, env);
    const trackingManifest = await readTrackingManifest(paths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, target.pluginName);
    const rollbackPaths = uniqueArtifactPaths([
      ...(trackingRecord?.artifacts
        .filter((artifact) => artifact.kind === 'permission' || artifact.kind === 'agent' || artifact.kind === 'skill')
        .map((artifact) => artifact.path) ?? []),
      ...((trackingRecord?.artifacts ?? []).some((artifact) =>
        artifact.kind === 'instruction' || artifact.kind === 'mcpServer')
        ? [paths.configTomlPath]
        : []),
      ...((trackingRecord?.artifacts ?? []).some((artifact) => artifact.kind === 'hook')
        ? [paths.hooksPath]
        : []),
    ]);
    const cleanupRoot = rollbackPaths.length > 0
      ? await fs.mkdtemp(path.join(os.tmpdir(), 'aw-uninstall-rollback-'))
      : undefined;

    return {
      files: [],
      pathSnapshots: cleanupRoot
        ? await Promise.all(
          rollbackPaths.map((artifactPath, index) => capturePathRollbackState(artifactPath, cleanupRoot, index)),
        )
        : [],
      cleanupRoots: cleanupRoot ? [cleanupRoot] : [],
    };
  }

  const paths = resolveClaudePaths(cwd, scope, env);
  const trackingManifest = await readTrackingManifest(paths.trackingDir);
  const trackingRecord = getTrackingRecord(trackingManifest, target.pluginName);
  const settings = await readClaudeSettings(paths.settingsPath);

  return {
    files: await Promise.all(
      (trackingRecord?.artifacts ?? [])
        .filter((artifact) => artifact.kind === 'instruction')
        .map((artifact) => captureTextFile(artifact.path)),
    ),
    pathSnapshots: [],
    cleanupRoots: [],
    claudePermissions: {
      topLevelPermissions: cloneClaudePermissionState(settings.permissions),
      generatedPermissions: cloneClaudePermissionState(
        settings.awGenerated?.permissions?.[target.pluginName],
      ),
      manualPermissions: cloneClaudePermissionState(settings.awGenerated?.manualPermissions),
    },
  };
}

export async function rollbackArtifacts(
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: CommandOptions['scope'],
  cwd: string,
  env: NodeJS.ProcessEnv,
  rollbackState: ArtifactRollbackState,
): Promise<void> {
  await Promise.all(rollbackState.files.map((snapshot) => restoreTextFile(snapshot)));
  await Promise.all(rollbackState.pathSnapshots.map((snapshot) => restorePathRollbackState(snapshot)));

  if (platform === 'codex') {
    return;
  }

  if (!rollbackState.claudePermissions) {
    return;
  }

  const paths = resolveClaudePaths(cwd, scope, env);
  const settings = await readClaudeSettings(paths.settingsPath);

  if (hasClaudePermissions(rollbackState.claudePermissions.topLevelPermissions)) {
    settings.permissions = cloneClaudePermissionState(
      rollbackState.claudePermissions.topLevelPermissions,
    );
  } else {
    delete settings.permissions;
  }

  if (hasClaudePermissions(rollbackState.claudePermissions.generatedPermissions)) {
    settings.awGenerated ??= {};
    settings.awGenerated.permissions ??= {};
    settings.awGenerated.permissions[target.pluginName] = cloneClaudePermissionState(
      rollbackState.claudePermissions.generatedPermissions,
    ) ?? { allow: [], ask: [], deny: [] };
  } else if (settings.awGenerated?.permissions) {
    delete settings.awGenerated.permissions[target.pluginName];
  }

  if (hasClaudePermissions(rollbackState.claudePermissions.manualPermissions)) {
    settings.awGenerated ??= {};
    settings.awGenerated.manualPermissions = cloneClaudePermissionState(
      rollbackState.claudePermissions.manualPermissions,
    );
  } else if (settings.awGenerated) {
    delete settings.awGenerated.manualPermissions;
  }

  cleanupClaudeGeneratedPermissions(settings);
  await writeClaudeSettings(paths.settingsPath, settings);
}

async function uninstallTargetOnPlatform(
  target: ResolvedPluginTarget,
  platform: PlatformName,
  options: CommandOptions,
  runtime: UninstallCommandRuntime,
): Promise<{ warnings: string[]; repoManagedArtifacts: GeneratedArtifact[] }> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const installStateResult = await tryUninstallUsingInstallState({
    target,
    platform,
    commandOptions: options,
    runtime: {
      ...runtime,
      adapters,
    },
  });
  if (installStateResult.handled) {
    return installStateResult.result ?? {
      warnings: [],
      repoManagedArtifacts: [],
    };
  }
  const warnings: string[] = [];
  let repoManagedArtifacts: GeneratedArtifact[] = [];

  const status = await adapters[platform].status(target.plugin, options.scope);
  const pluginStatus = status.plugins[0];
  if (!pluginStatus) {
    return { warnings, repoManagedArtifacts };
  }

  const codexProjectScope = platform === 'codex' && options.scope === 'project';
  const managedEvidence = hasScopeManagedEvidence(pluginStatus);
  const breadcrumbOnlyCodexUninstall = isCodexBreadcrumbOnlyUninstallTarget(
    platform,
    options.scope,
    pluginStatus,
  );
  if (
    pluginStatus.externalOwnership?.present &&
    !codexProjectScope &&
    !breadcrumbOnlyCodexUninstall
  ) {
    throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
  }

  const historicalEvidence = hasHistoricalEvidence(pluginStatus);
  if (
    target.source === 'historical' &&
    !historicalEvidence &&
    !breadcrumbOnlyCodexUninstall
  ) {
    throw new Error(`Unknown plugin "${target.pluginName}".`);
  }

  if (!breadcrumbOnlyCodexUninstall) {
    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.cwd,
      env,
      platform,
      scope: options.scope,
      pluginName: target.pluginName,
    });
    if (trackingIdentityRefusal) {
      throw new Error(trackingIdentityRefusal);
    }

    const identityRefusal = getGeneratedArtifactIdentityRefusal(pluginStatus);
    if (identityRefusal) {
      throw new Error(identityRefusal);
    }

    const refusal = shouldRefuseHistoricalUninstall(platform, pluginStatus);
    if (refusal) {
      throw new Error(refusal);
    }
  }

  const nativeFallback = pluginStatus.platformNativeFallbackEvidence?.present === true;
  if (!managedEvidence && !nativeFallback && !breadcrumbOnlyCodexUninstall) {
    warnings.push(`[${platform}/${target.pluginName}] 当前 scope 未受管，无需卸载。`);
    return { warnings, repoManagedArtifacts };
  }

  if (codexProjectScope) {
    if (pluginStatus.externalOwnership?.checkState === 'unknown') {
      warnings.push(
        `[${platform}/${target.pluginName}] 无法可靠读取用户级 Codex 配置；external ownership / project trust 只能按 unknown 处理，本次只会清理 AW 管理的 repo artifacts。`,
      );
    } else if (pluginStatus.externalOwnership?.present) {
      warnings.push(
        `[${platform}/${target.pluginName}] ${pluginStatus.externalOwnership.details ?? '检测到外部同名插件。'}本次只会清理 AW 管理的 repo artifacts。`,
      );
    }
  }

  if (breadcrumbOnlyCodexUninstall) {
    await getCodexNativeRecoveryCleanupAdapter(adapters[platform])
      .uninstallUserNativePluginById(`${target.pluginName}@aw`);
    return { warnings, repoManagedArtifacts };
  }

  const baselineLedger = await readInstalledLedger(env);
  const trackingDir = resolveTrackingDir(options.cwd, platform, options.scope, env);
  const baselineTracking = await readTrackingManifest(trackingDir);
  const trackedArtifacts = getTrackingRecord(baselineTracking, target.pluginName)?.artifacts ?? [];
  repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, trackedArtifacts);
  const rollbackState = managedEvidence
    ? await captureArtifactRollbackState(platform, target, options.scope, options.cwd, env)
    : undefined;

  let nativeWritten = false;
  let artifactsWritten = false;
  let trackingWriteAttempted = false;
  let materializationCommitted = false;
  let materializationRollbackFailed = false;
  let materializationRollbackHandle: SkillTriggerMaterializationRollbackHandle | undefined;

  try {
    if (!runtime.skipLifecycle) {
      await runLifecycleScript({
        event: 'uninstall',
        pluginName: target.pluginName,
        platform,
        scope: options.scope,
        cwd: options.cwd,
        context,
        scopeRecord: await getScopeRecordForUninstall(
          baselineLedger,
          platform,
          target.pluginName,
          options,
        ),
        currentPlugin: target.currentPlugin,
        scriptTimeoutMs: options.scriptTimeoutMs,
      });
    }

    await adapters[platform].uninstallPlugin(target.plugin, options.scope);
    nativeWritten = didUninstallWriteNativeState(platform, options.scope, pluginStatus);

    if (managedEvidence) {
      artifactsWritten = true;
      await adapters[platform].uninstallExtensions(
        target.plugin,
        options.scope,
        pluginStatus.generatedArtifacts.map((artifact) =>
          normalizeGeneratedArtifactForUninstall(platform, artifact)),
      );

      trackingWriteAttempted = true;
      await writeTrackingManifest(
        trackingDir,
        removeTrackingRecordFromManifest(baselineTracking, target.pluginName),
      );

      const nextLedger = preserveLedgerState(
        baselineLedger,
        await applyUninstallLedger(platform, baselineLedger, target, options),
      );
      if (shouldRematerializeSkillTriggersAfterUninstall(platform, options.scope, target)) {
        const rematerialization = await rematerializeSkillTriggerPreferenceAfterUninstall({
          pluginName: target.pluginName,
          platform,
          ledgerAfterUninstall: nextLedger,
          embeddedRoot: await resolveEmbeddedPluginsRoot(),
          marketplaceRoot: resolveAwHome(env),
        });
        warnings.push(...rematerialization.warnings);
        materializationCommitted = rematerialization.materialization?.committed === true;
        materializationRollbackHandle = rematerialization.materialization?.rollbackHandle;
      }
      await writeInstalledLedger(nextLedger, env);
      if (!runtime.skipLifecycleSnapshotGc) {
        await garbageCollectLifecycleConfigSnapshots({ ledger: nextLedger, env });
      }
    }
  } catch (error) {
    const rollbackIssues: string[] = [];
    const rollbackSurfaces = new Set<string>();
    const trackingManifestPath = getTrackingManifestPath(trackingDir);
    const installedLedgerPath = getInstalledLedgerPath(env);
    const artifactSurfaceHints = collectArtifactRollbackSurfaceHints(
      platform,
      options.cwd,
      options.scope,
      env,
      trackedArtifacts,
      rollbackState,
    );

    if (materializationCommitted && materializationRollbackHandle) {
      try {
        await rollbackMaterializedSkillTriggerPreference(materializationRollbackHandle);
        materializationCommitted = false;
      } catch (rollbackError) {
        materializationRollbackFailed = true;
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          'skill trigger 回滚失败',
          rollbackError,
          artifactSurfaceHints,
        );
      }
    }

    if (artifactsWritten) {
      try {
        if (rollbackState) {
          await rollbackArtifacts(
            platform,
            target,
            options.scope,
            options.cwd,
            env,
            rollbackState,
          );
        }
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          'repo artifacts 回滚失败',
          rollbackError,
          artifactSurfaceHints,
        );
      }
    }

    if (trackingWriteAttempted) {
      try {
        await writeTrackingManifest(trackingDir, baselineTracking);
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `tracking manifest 恢复失败 (${trackingManifestPath})`,
          rollbackError,
          [trackingManifestPath],
        );
      }
    }

    if (nativeWritten || materializationRollbackFailed || artifactsWritten || trackingWriteAttempted) {
      try {
        await writeDegradedLedger(
          baselineLedger,
          nativeWritten || materializationRollbackFailed
            ? 'operation_interrupted_after_native_write'
            : 'operation_interrupted_after_artifact_write',
          env,
        );
      } catch (rollbackError) {
        appendRollbackIssue(
          rollbackIssues,
          rollbackSurfaces,
          `installed.json degraded 写入失败 (${installedLedgerPath})`,
          rollbackError,
          [installedLedgerPath],
        );
      }
    }

    throw createRollbackFailureError(error, rollbackIssues, rollbackSurfaces);
  } finally {
    await disposeArtifactRollbackState(rollbackState);
  }

  if (materializationRollbackHandle) {
    try {
      await commitMaterializedSkillTriggerPreference(materializationRollbackHandle);
      materializationCommitted = false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push(`[${platform}/${target.pluginName}] skill trigger 备份目录清理失败：${detail}`);
    }
  }

  const postStatus = await adapters[platform].status(target.plugin, options.scope);
  const drift = filterPostCommandDriftWarnings(postStatus.plugins[0]?.driftWarnings ?? []);
  for (const warning of drift.visible) {
    warnings.push(`[${platform}/${target.pluginName}] ${warning}`);
  }
  if (drift.diagnostics.length > 0) {
    await emitCommandEvent(context, {
      type: 'drift:suppressed',
      data: {
        platform,
        plugin: target.pluginName,
        warnings: drift.diagnostics,
      },
    });
  }

  return { warnings, repoManagedArtifacts };
}

export async function uninstallTargetsOnPlatforms(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: CommandOptions,
  runtime: UninstallCommandRuntime = {},
): Promise<{ warnings: string[]; repoManagedArtifacts: GeneratedArtifact[] }> {
  const warnings: string[] = [];
  let repoManagedArtifacts: GeneratedArtifact[] = [];

  for (const platform of platforms) {
    for (const target of targets) {
      const result = await uninstallTargetOnPlatform(target, platform, options, runtime);
      warnings.push(...result.warnings);
      repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, result.repoManagedArtifacts);
    }
  }

  return { warnings, repoManagedArtifacts };
}

export async function uninstallCommand(
  pluginNames: string[],
  rawOptions: RawCommandOptions,
  runtime: UninstallCommandRuntime = {},
): Promise<{
  platforms: string[];
  plugins: string[];
  warnings: string[];
  repoManagedArtifacts: GeneratedArtifact[];
}> {
  const options = normalizeCommandOptions(rawOptions, {
    defaultScope: 'user',
    defaultPlatform: 'auto',
  });
  if (pluginNames.length === 0) {
    throw new Error('uninstall 命令至少需要一个插件名。非交互模式下请运行 `aw uninstall <插件名>`。');
  }

  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const targets = await loadPluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      allowHistoricalFallback: true,
      env,
    },
  );
  await emitCommandEvent(context, {
    type: 'catalog:resolved',
    data: {
      plugins: targets.map((target) => ({
        name: target.pluginName,
        source: target.source,
        current: Boolean(target.currentPlugin),
      })),
    },
  });
  const adapters = createAdapters(options.cwd, context);
  const platforms = await resolveTargetPlatforms(
    'uninstall',
    options.platform,
    options.cwd,
    options.scope,
    targets.map((target) => target.plugin),
    adapters,
    env,
  );
  await emitCommandEvent(context, {
    type: 'platform:resolved',
    data: {
      requestedPlatform: options.platform,
      platforms,
      scope: options.scope,
    },
  });
  const currentProjectKeysByPlatform = await resolveCurrentProjectKeysByPlatform(
    options.cwd,
    platforms,
    options.scope,
  );
  const requestedLocations = targets.flatMap((target) =>
    platforms.map((platform) => createCommandLocation({
      plugin: target.pluginName,
      platform,
      scope: options.scope,
      currentProjectKeysByPlatform,
    })),
  );
  const baselineLedger = await readInstalledLedger(env);
  const plannerState = await collectUninstallPlannerState({
    cwd: options.cwd,
    env,
    adapters,
    ledger: baselineLedger,
    requestedLocations,
    currentProjectKeysByPlatform,
  });
  const uninstallPlan = planPluginDependencyUninstall({
    state: plannerState,
    requested: requestedLocations,
  });
  if (uninstallPlan.incompleteMetadataLocations.length > 0) {
    const details = uninstallPlan.incompleteMetadataLocations
      .map((location) => formatDependentLocation(location, currentProjectKeysByPlatform))
      .join('、');
    throw new Error(
      `无法卸载以下插件：当前可见范围内存在缺失 dependency metadata 的已安装记录（${details}），无法可靠判断它们是否仍被依赖。请先 repair 或 reinstall 这些记录后再重试。`,
    );
  }
  if (uninstallPlan.blocked.length > 0) {
    const details = uninstallPlan.blocked.map((entry) => (
      `${formatDependentLocation(entry.location, currentProjectKeysByPlatform)} 仍被 ${entry.dependents
        .map((dependent) => formatDependentLocation(dependent, currentProjectKeysByPlatform))
        .join('、')} 依赖`
    ));
    throw new Error(`无法卸载以下插件：${details.join('；')}。若要继续，请在同一条命令里一并卸载这些 dependent。`);
  }

  const executions = await resolveUninstallExecutionTargets({
    cwd: options.cwd,
    env,
    plannedLocations: uninstallPlan.uninstallOrder,
    autoCleanupLocations: uninstallPlan.autoCleanup,
  });
  const warnings: string[] = [];
  let repoManagedArtifacts: GeneratedArtifact[] = [];
  for (const execution of executions) {
    const result = await uninstallTargetOnPlatform(
      execution.target,
      execution.location.platform,
      {
        ...options,
        scope: execution.location.scope,
      },
      {
        ...context,
        adapters,
      },
    );
    warnings.push(...result.warnings);
    repoManagedArtifacts = mergeGeneratedArtifacts(repoManagedArtifacts, result.repoManagedArtifacts);
  }

  return {
    platforms,
    plugins: targets.map((target) => target.pluginName),
    repoManagedArtifacts,
    warnings: [
      ...collectCommandWarnings(platforms, options.scope),
      ...warnings,
    ],
  };
}
