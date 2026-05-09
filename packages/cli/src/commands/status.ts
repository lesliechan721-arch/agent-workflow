import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  EnvironmentDetection,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeRecord,
  LifecycleConfigSnapshotMetadata,
  ManagedArtifactStatus,
  PlatformName,
  PluginLocation,
  PluginStatusReport,
  PluginStatusDependencies,
  RepoManagedProjectItemReport,
  PluginManifestSource,
  PluginMeta,
  Scope,
  StatusConfigHealth,
  StatusHealthSource,
  StatusScriptHealth,
  StatusReport,
  NativePluginStatus,
} from '../types.js';
import { readCodexNativeRecoveryBreadcrumb } from '../utils/codex-native-recovery.js';
import { readCodexNativePluginState } from '../utils/codex-native-state.js';
import { detectEnvironment } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveCatalogPlugins } from '../utils/plugin-catalog.js';
import {
  iterateInstalledScopeRecords,
} from '../utils/plugin-dependency-graph.js';
import {
  projectPluginDependencyStatus,
  type PluginDependencyPlannerHealthState,
  type PluginDependencyPlannerHealthRecord,
  type PluginDependencyPlannerInstalledRecord,
  type PluginDependencyPlannerState,
  type PluginDependencyStatusProjection,
} from '../utils/plugin-dependency-planner.js';
import {
  normalizePluginLocation,
  serializePluginLocation,
} from '../utils/plugin-dependency-location.js';
import { resolveEffectivePluginConfig, type PluginConfigIssue } from '../utils/plugin-config.js';
import {
  assessSharedSkillTriggerRuntimeSemantics,
  type SharedSkillTriggerRuntimeSemanticsAssessment,
  type SkillTriggerMaterializationTarget,
} from '../utils/skill-trigger-preferences.js';
import {
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
import { resolveAwHome } from '../utils/paths.js';
import { resolveLifecycleScriptForOs } from '../utils/plugin-script-contract.js';
import {
  createAdapters,
  formatStatusOutput,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
} from './common.js';
import {
  createPluginConsoleItems,
  createPluginConsoleLocationKey,
  pluginConsoleLocationLabel,
  PLUGIN_CONSOLE_STATUS_LABELS,
  type PluginConsoleItem,
  type PluginConsoleLocationDiagnostics,
  type PluginConsolePluginMeta,
  type PluginConsoleStatus,
} from './console-model.js';
import { buildCommandCandidates, type CommandCandidate } from './discovery.js';
import {
  createCommandExecutionContext,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  normalizeStatusCommandOptions,
  type RawStatusCommandOptions,
} from './options.js';
import {
  collectP7Locations,
  renderStatusHumanOutput,
  type StatusJsonPayload as P7StatusJsonPayload,
} from './diagnose.js';
import { isCodexProjectStatusFatalError } from './codex-project-safety.js';

type StatusCommandRuntime = CommandExecutionContextInput;

export type StatusHealth =
  | 'ready'
  | 'partial'
  | 'needsAttention'
  | 'external'
  | 'notInstalled'
  | 'unknown';

export interface StatusMatrixCell {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  projectRoot?: string;
  executionCwd: string;
  health: StatusHealth;
  report?: PluginStatusReport;
  evidenceSources: string[];
  healthSource: StatusHealthSource;
  config: StatusConfigHealth;
  scripts: StatusScriptHealth;
  configSources?: string[];
  configIssues?: PluginConfigIssue[];
  healthWarnings?: string[];
  disabledReason?: string;
  error?: string;
  installState?: StatusMatrixInstallState;
}

export interface StatusMatrixInstallState {
  kind: 'installed' | 'needsRepair' | 'adoptable' | 'residual' | 'externallyManaged' | 'notInstalled';
  summary: string;
  nextSteps: string[];
  findings: string[];
  issueCodes: string[];
  autoInstalled: boolean;
  unusedDependencyHint: boolean;
  dependents: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string | null;
  }>;
  repairAvailable: boolean;
  cleanupAvailable: boolean;
  adoptExistingAvailable: boolean;
  currentCatalogAvailable: boolean;
  catalogDrift: boolean;
  upgradeAvailable: boolean;
  dynamicDiagnosticUnavailable: boolean;
  nativeTransactionKind:
    | 'none'
    | 'markerOnlyInstall'
    | 'recordInstallResidual'
    | 'markerOnlyUninstall'
    | 'recordUninstallResidual'
    | 'invalid';
  sharedRuntimeOwnerPresent: boolean;
  sharedRuntimeNeedsTakeover: boolean;
  sharedRuntimeParticipatesInOwner: boolean;
  sharedRuntimeSemanticDelta: 'change' | 'noChange' | 'unknown';
  sharedRuntimeOwnerConflict: boolean;
}

export interface StatusSummary {
  pluginName: string;
  health: StatusHealth;
  cells: Array<Pick<StatusMatrixCell, 'platform' | 'scope' | 'health' | 'healthSource' | 'config' | 'scripts' | 'projectKey' | 'configIssues'>>;
  nextSteps: string[];
}

interface StatusHealthManifestSource {
  healthSource: StatusHealthSource;
  plugin?: PluginMeta;
  warnings: string[];
}

export interface StatusMatrixReport {
  detection: EnvironmentDetection;
  filters: {
    platform?: PlatformName | 'both';
    scope?: Scope;
    plugins?: string[];
  };
  health: StatusHealth;
  summaries: StatusSummary[];
  cells: StatusMatrixCell[];
  reports: StatusReport[];
}

export interface FriendlyStatusSummary {
  pluginName: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  location: string;
  nextStep?: string;
  nextSteps: string[];
  issueSummary?: string;
}

export interface StatusJsonPayload extends StatusMatrixReport {
  ok: true;
  command: 'status';
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleItem[];
}

function statusErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeOs(): 'linux' | 'darwin' | 'win32' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

function isInsidePath(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function getStatusScopeRecord(
  ledger: InstalledLedger,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  projectKey: string | undefined,
): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  return projectKey
    ? platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

function cellLocation(cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope' | 'projectKey'>): PluginLocation {
  return normalizePluginLocation({
    plugin: cell.pluginName,
    platform: cell.platform,
    scope: cell.scope,
    projectKey: cell.projectKey ?? null,
  });
}

async function loadSnapshotPlugin(
  pluginName: string,
  snapshot: LifecycleConfigSnapshotMetadata,
): Promise<PluginMeta> {
  if (snapshot.pluginName !== pluginName) {
    throw new Error('snapshot belongs to another plugin');
  }

  const snapshotRoot = await fs.realpath(snapshot.snapshotRoot);
  const bundleRoot = await fs.realpath(snapshot.bundleRoot);
  const expectedBundleRoot = await fs.realpath(path.join(snapshotRoot, 'bundle'));
  if (bundleRoot !== expectedBundleRoot || !isInsidePath(bundleRoot, snapshotRoot)) {
    throw new Error('snapshot bundle root is outside snapshot root');
  }

  const manifestPath = await fs.realpath(snapshot.manifestPath);
  if (!isInsidePath(manifestPath, bundleRoot)) {
    throw new Error('snapshot manifest path is outside bundle root');
  }
  const digest = await fileDigest(manifestPath);
  if (digest !== snapshot.sourceManifestDigest) {
    throw new Error('snapshot manifest digest mismatch');
  }
  const fingerprint = await calculatePluginBundleFingerprint(bundleRoot);
  if (fingerprint !== snapshot.bundleFingerprint) {
    throw new Error('snapshot bundle fingerprint mismatch');
  }

  const plugin = await readPluginManifest(bundleRoot, { mode: 'bundle' });
  if (
    plugin.manifest.name !== snapshot.pluginName ||
    plugin.manifest.version !== snapshot.pluginVersion ||
    path.resolve(plugin.manifestPath) !== path.resolve(manifestPath)
  ) {
    throw new Error('snapshot manifest identity mismatch');
  }
  return plugin;
}

async function resolveStatusHealthManifest(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  ledger: InstalledLedger;
  currentPlugin?: PluginMeta;
  hasHistoricalEvidence: boolean;
}): Promise<StatusHealthManifestSource> {
  const warnings: string[] = [];
  const scopeRecord = getStatusScopeRecord(
    options.ledger,
    options.pluginName,
    options.platform,
    options.scope,
    options.projectKey,
  );

  const snapshot = scopeRecord?.lifecycleConfigSnapshot;
  if (snapshot) {
    try {
      return {
        healthSource: 'installSnapshot',
        plugin: await loadSnapshotPlugin(options.pluginName, snapshot),
        warnings,
      };
    } catch (error) {
      warnings.push(
        `install snapshot unusable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (options.currentPlugin) {
    return {
      healthSource: 'currentCatalog',
      plugin: options.currentPlugin,
      warnings,
    };
  }

  return {
    healthSource: options.hasHistoricalEvidence ? 'historical' : 'none',
    warnings,
  };
}

async function pathExistsInsideBundle(bundleRoot: string, relativePath: string): Promise<boolean> {
  const resolvedRoot = path.resolve(bundleRoot);
  const absolutePath = path.resolve(resolvedRoot, stripDotSlash(relativePath));
  if (!isInsidePath(absolutePath, resolvedRoot) || !(await fs.pathExists(absolutePath))) {
    return false;
  }
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(resolvedRoot),
    fs.realpath(absolutePath),
  ]);
  return isInsidePath(realPath, realRoot);
}

async function resolveScriptHealth(plugin: PluginMeta | undefined): Promise<StatusScriptHealth> {
  const manifest = plugin?.manifest;
  if (!plugin || !manifest) {
    return 'not_declared';
  }

  const lifecycle = manifest.scripts?.lifecycle ?? {};
  const helperPath = manifest.scripts?.helpers?.config;
  if (Object.keys(lifecycle).length === 0 && !helperPath) {
    return 'not_declared';
  }

  if (helperPath && !(await pathExistsInsideBundle(plugin.rootDir, helperPath))) {
    return 'missing-from-bundle';
  }

  for (const selector of Object.values(lifecycle)) {
    const entry = resolveLifecycleScriptForOs(selector, runtimeOs());
    if (!entry) {
      return 'unsupported-on-current-os';
    }
    if (!(await pathExistsInsideBundle(plugin.rootDir, entry.path))) {
      return 'missing-from-bundle';
    }
  }

  return 'declared';
}

function resolveConfigSourceSummary(
  manifest: PluginManifestSource,
  sources: Record<string, string>,
): string[] {
  const sourceSet = new Set<string>();
  for (const key of Object.keys(manifest.config?.schema ?? {})) {
    const source = sources[key];
    if (source && source !== 'missing') {
      sourceSet.add(source);
    }
  }
  return [...sourceSet].sort();
}

async function resolveConfigHealth(options: {
  plugin: PluginMeta | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ config: StatusConfigHealth; configSources?: string[]; configIssues?: PluginConfigIssue[] }> {
  if (!options.plugin?.manifest.config?.schema) {
    return { config: 'no-schema' };
  }

  const effective = await resolveEffectivePluginConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });
  const configIssues = effective.issues.length > 0
    ? effective.issues.map((issue) => ({
        type: issue.type,
        key: issue.key,
        ...(issue.source ? { source: issue.source } : {}),
        message: issue.message,
      }))
    : undefined;
  if (effective.issues.some((issue) => issue.type === 'invalid-config')) {
    return {
      config: 'invalid-config',
      configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
      ...(configIssues ? { configIssues } : {}),
    };
  }
  if (effective.issues.some((issue) => issue.type === 'missing-required')) {
    return {
      config: 'missing-required',
      configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
      ...(configIssues ? { configIssues } : {}),
    };
  }
  return {
    config: 'configured',
    configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
  };
}

async function resolveStatusRuntimeHealth(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  ledger: InstalledLedger;
  currentPlugin?: PluginMeta;
  hasHistoricalEvidence: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  healthSource: StatusHealthSource;
  config: StatusConfigHealth;
  scripts: StatusScriptHealth;
  plugin?: PluginMeta;
  configSources?: string[];
  configIssues?: PluginConfigIssue[];
  healthWarnings?: string[];
}> {
  const source = await resolveStatusHealthManifest(options);
  const config = await resolveConfigHealth({
    plugin: source.plugin,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    healthSource: source.healthSource,
    plugin: source.plugin,
    ...config,
    scripts: await resolveScriptHealth(source.plugin),
    ...(source.warnings.length > 0 ? { healthWarnings: source.warnings } : {}),
  };
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function healthLabel(health: StatusHealth): string {
  return {
    ready: '可用',
    partial: '部分可用',
    needsAttention: '需要处理',
    external: '外部管理',
    notInstalled: '未安装',
    unknown: '状态未知',
  }[health];
}

function formatSkillTriggerRuntime(plugin: PluginStatusReport): string | undefined {
  if (!plugin.skillTriggerRuntimeState) {
    return undefined;
  }

  if (plugin.skillTriggerRuntimeState === 'unknown') {
    return 'unknown';
  }

  if (plugin.skillTriggerRuntimeState === 'mixed') {
    return 'mixed';
  }

  const matches = plugin.skillTriggerRuntimeMatches ?? [];
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    return `matches(${matches.join(',')})`;
  }

  return 'mixed';
}

function hasRuntimeEvidence(plugin: PluginStatusReport): boolean {
  return (
    plugin.native.pluginInstalled ||
    plugin.generatedArtifacts.length > 0 ||
    plugin.platformRuntimeEvidence?.present === true ||
    plugin.platformNativeFallbackEvidence?.present === true ||
    hasScopeManagedEvidence(plugin)
  );
}

function hasMissingArtifacts(plugin: PluginStatusReport): boolean {
  return (
    plugin.generatedArtifacts.some((artifact) => !artifact.exists) ||
    plugin.managedArtifacts?.some((artifact) =>
      artifact.health === 'blockMissing' ||
      artifact.health === 'missing' ||
      artifact.health === 'roleLayerMissing',
    ) === true ||
    plugin.artifactsInitialized === false
  );
}

function hasManagedArtifactIssues(plugin: PluginStatusReport): boolean {
  return plugin.managedArtifacts?.some((artifact) =>
    artifact.health !== 'healthy' && artifact.health !== 'disabledByConfig',
  ) === true;
}

function getRepoManagedProjectItems(plugin: PluginStatusReport): RepoManagedProjectItemReport[] {
  return plugin.repoManagedSessionState?.items ?? [];
}

function hasRepoManagedActionableItems(plugin: PluginStatusReport): boolean {
  return getRepoManagedProjectItems(plugin).some((item) =>
    item.state === 'missing' ||
      item.state === 'drifted' ||
      item.state === 'orphan' ||
      item.state === 'blockedByProjectTrust',
  );
}

function hasRepoManagedUnknownItems(plugin: PluginStatusReport): boolean {
  return getRepoManagedProjectItems(plugin).some((item) =>
    item.state === 'unknown' || item.state === 'projectTrustUnknown',
  );
}

function hasManagedRepoEvidence(plugin: PluginStatusReport): boolean {
  return hasScopeManagedEvidence(plugin) || getRepoManagedProjectItems(plugin).some((item) => item.tracked);
}

function flattenStatusDiagnostics(cell: StatusMatrixCell): string[] {
  const report = cell.report;
  return [
    cell.error ?? '',
    ...(cell.healthWarnings ?? []),
    ...(cell.configIssues ?? []).map((issue) => issue.message),
    ...(report?.driftWarnings ?? []),
    ...(report?.managedArtifacts ?? []).flatMap((artifact) => artifact.diagnostics),
    ...(report?.repoManagedSessionState?.diagnostics ?? []),
    ...(report?.repoManagedSessionState?.items ?? []).flatMap((item) => item.diagnostics),
  ].filter((message) => message.trim().length > 0);
}

function hasTrackingIdentityIssue(cell: StatusMatrixCell): boolean {
  const report = cell.report;
  const diagnostics = flattenStatusDiagnostics(cell);
  return Boolean(
    report?.repoManagedSessionState?.items?.some((item) =>
      item.state === 'unknown' && item.diagnostics.some((message) => /tracking|roleKey/i.test(message))) ||
    diagnostics.some((message) => /tracking identity|tracking manifest|roleKey/i.test(message)),
  );
}

function isReadySkillsOnlyProjectStatus(plugin: PluginStatusReport): boolean {
  return Array.isArray(plugin.projectManagedKinds) &&
    plugin.projectManagedKinds.length > 0 &&
    plugin.projectManagedKinds.every((kind) => kind === 'skill') &&
    getRepoManagedProjectItems(plugin).length > 0 &&
    getRepoManagedProjectItems(plugin).every((item) => item.kind === 'skill' && item.state === 'visible') &&
    plugin.skillTriggerDrift === 'no' &&
    plugin.externalOwnership?.checkState !== 'unknown';
}

function isCodexUserNativePlugin(
  plugin: PluginStatusReport,
  platform: PlatformName,
  scope: Scope,
): boolean {
  return platform === 'codex' && scope === 'user' && plugin.native.requiresNativePlugin === true;
}

function hasNativeRecovery(plugin: PluginStatusReport): boolean {
  return plugin.native.recovery?.present === true;
}

function hasDependencyHealthDowngrade(plugin: PluginStatusReport): boolean {
  return (plugin.dependencies?.missing.length ?? 0) > 0;
}

function hasGeneralHealthDowngrade(plugin: PluginStatusReport): boolean {
  return (
    hasDependencyHealthDowngrade(plugin) ||
    hasManagedArtifactIssues(plugin) ||
    (plugin.ledgerStateStatus === 'degraded' && !isReadySkillsOnlyProjectStatus(plugin)) ||
    plugin.catalogCompatibility === 'missing' ||
    plugin.catalogCompatibility === 'capabilityChanged' ||
    plugin.skillTriggerDrift === 'yes' ||
    hasMissingArtifacts(plugin) ||
    plugin.currentCatalog?.available === false
  );
}

function resolveCodexUserNativeHealth(plugin: PluginStatusReport): StatusHealth {
  const installed = plugin.native.pluginInstalled;
  const enabled = plugin.native.pluginEnabled === true;
  const hasCacheEvidence =
    plugin.native.cacheStatus === 'active' ||
    plugin.native.cacheStatus === 'ambiguous' ||
    plugin.native.cacheStatus === 'invalid';
  const hasSuccessfulScopeRecord = plugin.scopeManagedEvidence?.ledger === true;
  const hasManagedEvidence = hasScopeManagedEvidence(plugin);

  if (hasRepoManagedActionableItems(plugin) || hasGeneralHealthDowngrade(plugin)) {
    return 'needsAttention';
  }

  if (hasRepoManagedUnknownItems(plugin) || plugin.skillTriggerDrift === 'unknown') {
    return 'unknown';
  }

  if (!installed && !enabled) {
    return hasManagedEvidence || hasNativeRecovery(plugin) || hasCacheEvidence
      ? 'needsAttention'
      : 'notInstalled';
  }

  if (!installed || !enabled) {
    return 'needsAttention';
  }

  if (hasNativeRecovery(plugin) || !hasSuccessfulScopeRecord || plugin.scopeInitialized !== 'yes') {
    return 'needsAttention';
  }

  return 'ready';
}

function resolvePluginHealth(
  plugin: PluginStatusReport | undefined,
  platform: PlatformName,
  scope: Scope,
): StatusHealth {
  if (!plugin) {
    return 'unknown';
  }

  if (plugin.externalOwnership?.checkState === 'unknown') {
    return 'unknown';
  }

  if (plugin.externalOwnership?.present) {
    if (hasRuntimeEvidence(plugin) || hasManagedRepoEvidence(plugin) || hasNativeRecovery(plugin)) {
      return 'needsAttention';
    }
    return 'external';
  }

  if (isCodexUserNativePlugin(plugin, platform, scope)) {
    return resolveCodexUserNativeHealth(plugin);
  }

  if (!hasRuntimeEvidence(plugin)) {
    return plugin.scopeInitialized === 'unknown' ? 'unknown' : 'notInstalled';
  }

  if (plugin.scopeInitialized === 'unknown') {
    return 'unknown';
  }

  if (hasRepoManagedActionableItems(plugin)) {
    return 'needsAttention';
  }

  if (hasGeneralHealthDowngrade(plugin)) {
    return 'needsAttention';
  }

  if (
    hasRepoManagedUnknownItems(plugin) ||
    plugin.skillTriggerDrift === 'unknown'
  ) {
    return 'unknown';
  }

  if (plugin.scopeInitialized !== 'yes') {
    return 'partial';
  }

  return 'ready';
}

const HEALTH_SEVERITY: Record<StatusHealth, number> = {
  needsAttention: 5,
  partial: 4,
  unknown: 3,
  external: 2,
  ready: 1,
  notInstalled: 0,
};

function combineHealth(healths: StatusHealth[]): StatusHealth {
  const meaningful = healths.filter((health) => health !== 'notInstalled');
  if (meaningful.length === 0) {
    return 'notInstalled';
  }

  return meaningful.sort((left, right) => HEALTH_SEVERITY[right] - HEALTH_SEVERITY[left])[0];
}

function resolvePlannerHealthState(
  cell: StatusMatrixCell | undefined,
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
): PluginDependencyPlannerHealthState {
  if (!cell?.report) {
    return scopeRecord?.managed === true ? 'repairRequired' : 'missing';
  }

  const { report } = cell;
  if (report.externalOwnership?.present) {
    return hasManagedRepoEvidence(report) || hasRuntimeEvidence(report)
      ? 'external'
      : 'externalOnly';
  }

  if (
    cell.platform === 'codex' &&
    cell.scope === 'user' &&
    report.native.requiresNativePlugin === true
  ) {
    const hasManagedEvidence = hasScopeManagedEvidence(report);
    if (report.native.recovery?.present && !hasManagedEvidence) {
      return 'breadcrumbOnly';
    }
    if (report.native.pluginInstalled && report.native.pluginEnabled !== true && !hasManagedEvidence) {
      return 'cacheOnly';
    }
    if (!report.native.pluginInstalled && report.native.pluginEnabled === true && !hasManagedEvidence) {
      return 'enabledOnly';
    }
  }

  if (hasTrackingIdentityIssue(cell)) {
    return 'trackingBroken';
  }

  if (cell.health === 'ready') {
    return 'healthy';
  }
  if (cell.health === 'notInstalled') {
    return 'missing';
  }
  if (cell.health === 'unknown' || cell.health === 'partial' || cell.health === 'needsAttention') {
    return 'repairRequired';
  }

  return 'degraded';
}

function mapDependencyHealthSource(
  source: PluginDependencyStatusProjection['healthSource'],
): PluginStatusDependencies['healthSource'] {
  switch (source) {
    case 'installedSnapshot':
      return 'installSnapshot';
    case 'currentCatalogFallback':
      return 'currentCatalog';
    case 'none':
    default:
      return 'none';
  }
}

function mapDependencyResolvedSource(
  source: PluginDependencyStatusProjection['resolved'][number]['source'],
): PluginStatusDependencies['resolved'][number]['source'] {
  return source === 'installedSnapshot' ? 'installSnapshot' : 'currentCatalog';
}

function buildDependencyStatusProjectionByLocation(
  projections: PluginDependencyStatusProjection[],
): Record<string, PluginStatusDependencies> {
  const rawByKey = new Map(
    projections.map((projection) => [serializePluginLocation(projection.location), projection] as const),
  );
  const memo = new Map<string, boolean>();
  const inFlight = new Set<string>();

  const isHealthy = (location: PluginLocation): boolean => {
    const key = serializePluginLocation(location);
    if (memo.has(key)) {
      return memo.get(key) ?? false;
    }
    if (inFlight.has(key)) {
      memo.set(key, false);
      return false;
    }

    inFlight.add(key);
    const projection = rawByKey.get(key);
    if (!projection) {
      inFlight.delete(key);
      memo.set(key, false);
      return false;
    }

    if (projection.missing.length > 0) {
      inFlight.delete(key);
      memo.set(key, false);
      return false;
    }

    const healthy = projection.satisfied.every((entry) => isHealthy(entry.location));
    inFlight.delete(key);
    memo.set(key, healthy);
    return healthy;
  };

  return Object.fromEntries(
    projections.map((projection) => {
      const satisfied = projection.satisfied.filter((entry) => isHealthy(entry.location));
      const transitivelyMissing = projection.satisfied
        .filter((entry) => !isHealthy(entry.location))
        .map((entry) => ({
          declaration: entry.declaration,
          expectedLocation: entry.location,
          reason: '依赖插件当前安装不健康，或它自身仍缺少健康依赖。',
        }));

      const mapped: PluginStatusDependencies = {
        healthSource: mapDependencyHealthSource(projection.healthSource),
        declared: projection.declared,
        resolved: projection.resolved.map((entry) => ({
          declaration: entry.declaration,
          source: mapDependencyResolvedSource(entry.source),
        })),
        satisfied,
        missing: [...projection.missing, ...transitivelyMissing],
        dependents: projection.dependents,
        autoInstalled: projection.autoInstalled,
        autoRemovable: projection.autoRemovable,
        catalogDrift: projection.catalogDrift,
      };

      return [serializePluginLocation(projection.location), mapped];
    }),
  );
}

function describeEvidenceSource(source: string): string {
  return {
    ledger: 'ledger',
    tracking: 'tracking',
    codexNativeConfig: 'Codex enabled config',
    codexNativeCache: 'Codex active cache',
    codexNativeRecovery: 'Codex native recovery',
    codexSharedNativeRef: 'shared native ref',
    claudeSettings: 'Claude settings',
    claudeInstalledPlugins: 'Claude installed plugins',
  }[source] ?? source;
}

function describeEvidence(cell: StatusMatrixCell): string {
  const evidence = new Set(cell.evidenceSources.map(describeEvidenceSource));
  if (cell.report?.scopeManagedEvidence?.ledger) {
    evidence.add('ledger');
  }
  if (cell.report?.scopeManagedEvidence?.tracking) {
    evidence.add('tracking');
  }
  if (cell.report?.scopeManagedEvidence?.sharedNativeRef) {
    evidence.add('shared native ref');
  }
  if (cell.report?.platformRuntimeEvidence?.present) {
    evidence.add('runtime');
  }
  if (cell.report?.platformNativeFallbackEvidence?.present) {
    evidence.add('native fallback');
  }
  if (cell.report?.externalOwnership?.present) {
    evidence.add('external ownership');
  }

  return evidence.size > 0 ? [...evidence].join(', ') : '无受管证据';
}

function describeCatalog(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.currentCatalog) {
    return undefined;
  }

  if (plugin.currentCatalog.available) {
    return plugin.currentCatalog.source === 'embedded'
      ? `当前 catalog 来自 embedded（本地 marketplace 未处于健康状态：${plugin.currentCatalog.reason ?? '原因未知'}）`
      : '当前 catalog 可用';
  }

  return `当前 catalog 中找不到插件目录（来自 ${plugin.currentCatalog.source}${plugin.currentCatalog.reason ? `，${plugin.currentCatalog.reason}` : ''}）`;
}

function describeNative(
  plugin: PluginStatusReport | undefined,
  platform: PlatformName,
  scope: Scope,
): string | undefined {
  if (!plugin) {
    return undefined;
  }

  if (platform === 'codex') {
    if (scope === 'user' && plugin.native.requiresNativePlugin) {
      const recovery = plugin.native.recovery;
      if (recovery?.present) {
        const stateLabels = {
          pending_after_native_write: 'native 写入已完成，AW 后续步骤仍待完成',
          post_check_failed: 'native 写入已完成，但 post-check 失败',
          lifecycle_failed: 'native 写入已完成，但 lifecycle 失败',
          tracking_write_failed: 'native 写入已完成，但 tracking 写入失败',
          ledger_write_failed: 'native 写入已完成，但 ledger 写入失败',
          snapshot_write_failed: 'native 写入已完成，但 snapshot 写入失败',
          cleanup_failed: 'native 残留大概率已清理，但 recovery breadcrumb 仍未删除',
        } as const;
        const summary = stateLabels[recovery.state ?? 'pending_after_native_write'];
        if (recovery.evidenceMatches === false) {
          return `Codex native recovery breadcrumb 仍在：${summary}。当前 cache/config 已不匹配，通常表示 breadcrumb 删除失败。`;
        }
        return `Codex native 已写入，但 AW 安装或清理未完成：${summary}。`;
      }

      if (plugin.native.pluginInstalled && plugin.native.pluginEnabled !== true) {
        return 'Codex active cache 仍在，但 enabled config 缺失或已关闭。';
      }

      if (!plugin.native.pluginInstalled && plugin.native.pluginEnabled === true) {
        return 'Codex enabled config 已存在，但 active cache 缺失，原生安装未完成。';
      }
    }

    if (scope === 'project' && hasManagedRepoEvidence(plugin)) {
      if (plugin.native.pluginInstalled) {
        return plugin.native.pluginEnabled === true
          ? '附加诊断：用户级 Codex native cache 和 enabled config 也存在'
          : '附加诊断：用户级 Codex native cache 也存在';
      }
      return undefined;
    }
    if (plugin.native.marketplaceRegistered) {
      const source = plugin.native.marketplaceSource ?? plugin.native.declaredSource;
      return source
        ? `Codex 已注册本地 marketplace：${source}`
        : 'Codex 已注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'missing') {
      return 'Codex marketplace aw 未注册，需要重新注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'installedCopy') {
      return 'Codex marketplace aw 不是 local source 注册，需要重新注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'unknown') {
      const source = plugin.native.marketplaceSource ?? plugin.native.declaredSource;
      return source
        ? `Codex marketplace source 未指向当前 AW marketplace：${source}`
        : 'Codex marketplace source 无法确认，需要重新注册本地 marketplace';
    }
  }

  if (plugin.native.pluginInstalled) {
    return plugin.native.pluginEnabled === true ? '原生插件已安装并启用' : '原生插件 cache 仍然存在';
  }

  return undefined;
}

function describeSkillTrigger(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.skillTriggerPreference && !plugin?.skillTriggerRuntimeState) {
    return undefined;
  }

  const parts = [
    plugin.skillTriggerPreference ? `账本偏好 ${plugin.skillTriggerPreference}` : undefined,
    formatSkillTriggerRuntime(plugin) ? `运行时 ${formatSkillTriggerRuntime(plugin)}` : undefined,
    plugin.skillTriggerDrift ? `漂移 ${plugin.skillTriggerDrift}` : undefined,
  ].filter(Boolean);
  return `skill trigger：${parts.join('，')}`;
}

function formatRepoManagedItemLabel(
  item: RepoManagedProjectItemReport,
): string {
  if (item.kind === 'skill') {
    return `skill ${item.artifactKey ?? item.path}`;
  }
  if (item.kind === 'mcpServer') {
    return `mcp ${item.artifactKey ?? item.path}`;
  }
  return item.kind;
}

function formatManagedArtifactLabel(
  plugin: PluginStatusReport,
): string[] {
  if (!plugin.managedArtifacts?.length) {
    return [];
  }

  return plugin.managedArtifacts.map((artifact) => {
    const label = artifact.target === 'codex.developerInstructionsBlock'
      ? `instruction:${artifact.id ?? plugin.pluginName}`
      : `role:${artifact.roleKey ?? artifact.artifactKey ?? artifact.id ?? artifact.path}`;
    return `${label}=${artifact.health}/${artifact.sessionVisibility}`;
  });
}

function describeManagedArtifactVisibilityReason(
  plugin: PluginStatusReport,
): string[] {
  if (!plugin.managedArtifacts?.length) {
    return [];
  }

  return plugin.managedArtifacts.flatMap((artifact) => {
    const label = artifact.target === 'codex.developerInstructionsBlock'
      ? 'instruction'
      : `role ${artifact.roleKey ?? artifact.artifactKey ?? artifact.id ?? artifact.path}`;

    switch (artifact.sessionVisibility) {
      case 'blockedByProjectTrust':
        return `${label} 当前不会进入 project scope 会话，因为 Codex 还未信任这个仓库。`;
      case 'projectTrustUnknown':
        return `${label} 的 project scope 会话可见性暂时无法确定，因为当前 repo trust 状态未知。`;
      case 'unknownByExternalLayer':
        return `${label} 的会话可见性无法可靠判断，因为更高优先级 layer 里存在可能覆盖它的同名配置。`;
      case 'shadowedByProjectDeveloperInstructions':
        return `${label} 已写入 user scope，但当前 repo 的 project developer_instructions 会遮住它。`;
      default:
        return [];
    }
  });
}

function describeRepoManagedState(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.repoManagedSessionState) {
    const managedArtifactLabels = plugin ? formatManagedArtifactLabel(plugin) : [];
    const visibilityReasons = plugin ? describeManagedArtifactVisibilityReason(plugin) : [];
    const parts: string[] = [];
    if (managedArtifactLabels.length > 0) {
      parts.push(`artifacts：${managedArtifactLabels.join('，')}`);
    }
    if (visibilityReasons.length > 0) {
      parts.push(`不可见原因：${visibilityReasons.join('；')}`);
    }
    return parts.length > 0 ? parts.join('；') : undefined;
  }

  const parts: string[] = [];
  if (plugin.repoManagedSessionState.skills) {
    parts.push(`skills=${plugin.repoManagedSessionState.skills.state}`);
  }
  if (plugin.repoManagedSessionState.mcpServers) {
    parts.push(`mcpServers=${plugin.repoManagedSessionState.mcpServers.state}`);
  }

  const notableItems = (plugin.repoManagedSessionState.items ?? [])
    .filter((item) => item.state !== 'visible' && item.state !== 'absent')
    .slice(0, 4)
    .map((item) => `${formatRepoManagedItemLabel(item)}=${item.state}`);
  parts.push(...notableItems);
  parts.push(...formatManagedArtifactLabel(plugin));
  const visibilityReasons = describeManagedArtifactVisibilityReason(plugin);
  if (visibilityReasons.length > 0) {
    parts.push(`不可见原因：${visibilityReasons.join('；')}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `repo-managed：${parts.join('，')}`;
}

function describeRuntimeHealth(cell: StatusMatrixCell): string {
  const source = {
    installSnapshot: 'install snapshot',
    currentCatalog: 'current catalog',
    historical: 'historical evidence',
    none: 'none',
  }[cell.healthSource];
  const sourceSummary = cell.configSources && cell.configSources.length > 0
    ? `，配置来源 ${cell.configSources.join('/')}`
    : '';
  return `config=${cell.config}${sourceSummary}，scripts=${cell.scripts}，healthSource=${source}`;
}

function describeDependencies(plugin: PluginStatusReport | undefined): string | undefined {
  const dependencies = plugin?.dependencies;
  if (!dependencies) {
    return undefined;
  }

  const source = {
    installSnapshot: 'install snapshot',
    currentCatalog: 'current catalog',
    historical: 'historical evidence',
    none: 'none',
  }[dependencies.healthSource];
  const parts = [
    `source=${source}`,
    `declared=${dependencies.declared.length}`,
    `resolved=${dependencies.resolved.length}`,
    `satisfied=${dependencies.satisfied.length}`,
    `missing=${dependencies.missing.length}`,
  ];
  if (dependencies.dependents.length > 0) {
    parts.push(`dependents=${dependencies.dependents.length}`);
  }
  if (dependencies.autoInstalled) {
    parts.push('autoInstalled=yes');
  }
  if (dependencies.autoRemovable) {
    parts.push('autoRemovable=yes');
  }
  if (dependencies.catalogDrift.kind !== 'none') {
    parts.push(`catalogDrift=${dependencies.catalogDrift.kind}`);
  }

  const details: string[] = [];
  if (dependencies.missing.length > 0) {
    details.push(`缺失：${dependencies.missing.map((entry) => entry.declaration.name).join(', ')}`);
  }
  if (dependencies.autoRemovable) {
    details.push('当前自动依赖已不再被其它插件使用，可按需清理。');
  }

  return details.length > 0
    ? `dependencies：${parts.join('，')}；${details.join('；')}`
    : `dependencies：${parts.join('，')}`;
}

function describeCell(cell: StatusMatrixCell): string {
  if (cell.error) {
    return `读取失败：${cell.error}`;
  }

  if (!cell.report || cell.health === 'notInstalled') {
    return '未发现 AW 管理状态。';
  }

  const descriptions = [
    `证据：${describeEvidence(cell)}`,
    describeRepoManagedState(cell.report),
    describeNative(cell.report, cell.platform, cell.scope),
    describeCatalog(cell.report),
    describeRuntimeHealth(cell),
    describeDependencies(cell.report),
    describeSkillTrigger(cell.report),
  ].filter(Boolean);

  if (cell.report.driftWarnings.length > 0) {
    descriptions.push(`注意：${cell.report.driftWarnings.join('；')}`);
  }

  return descriptions.join('；') || '未发现更多诊断。';
}

function nextStepForCell(cell: StatusMatrixCell): string | undefined {
  const suffix = ` -p ${cell.platform} -s ${cell.scope}`;
  if (cell.health === 'notInstalled') {
    return `安装 ${cell.pluginName}：aw install ${cell.pluginName}${suffix}`;
  }
  if (cell.health === 'external') {
    return `检查 ${cell.pluginName} 的外部 marketplace 占用后，再决定是否迁移到 AW 管理。`;
  }
  if (cell.report?.externalOwnership?.present && hasRuntimeEvidence(cell.report)) {
    return `先解除 ${cell.pluginName} 的同名外部 native 插件冲突，再重新检查当前 repo-managed 状态。`;
  }
  if (cell.error) {
    return `重新运行 aw status ${cell.pluginName}${suffix} --verbose 查看读取失败细节。`;
  }
  const unknownItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'unknown' || item.state === 'projectTrustUnknown',
  );
  if (unknownItem) {
    return `先修复 ${formatRepoManagedItemLabel(unknownItem)} 的不可判定状态，再重新运行 aw status ${cell.pluginName}${suffix}。`;
  }
  const blockedItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'blockedByProjectTrust',
  );
  if (blockedItem) {
    return `先让 Codex 信任当前仓库，再重新检查 ${formatRepoManagedItemLabel(blockedItem)} 的 project scope 状态。`;
  }
  const orphanItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'orphan',
  );
  if (orphanItem) {
    return `先处理未受管的 ${formatRepoManagedItemLabel(orphanItem)}，再决定是重新受管还是手动保留。`;
  }
  if ((cell.report?.dependencies?.missing.length ?? 0) > 0) {
    return `先补齐 ${cell.pluginName} 当前安装缺失的依赖，再重新检查状态。`;
  }
  if (cell.report?.dependencies?.autoRemovable) {
    return `${cell.pluginName} 是当前已闲置的自动依赖；确认没人再用后，可运行 aw uninstall ${cell.pluginName}${suffix} 清理。`;
  }
  if (cell.report?.catalogCompatibility === 'missing') {
    return `当前插件目录缺失；如需清理历史状态，运行 aw uninstall ${cell.pluginName}${suffix}`;
  }
  if (cell.platform === 'codex' && cell.scope === 'user' && cell.report?.native.requiresNativePlugin) {
    if (cell.report.native.recovery?.present) {
      if (cell.report.native.recovery.evidenceMatches === false) {
        return `重新运行 aw uninstall ${cell.pluginName}${suffix} 清理 recovery breadcrumb；如果 Codex cache/config 已手动清掉，AW 仍需要移除这条恢复记录。`;
      }
      return `当前 Codex native 安装未完整收口；运行 aw install ${cell.pluginName}${suffix} 修复，或运行 aw uninstall ${cell.pluginName}${suffix} 清理残留。`;
    }
    if (cell.report.native.pluginInstalled && cell.report.native.pluginEnabled !== true) {
      return `先确认 ${cell.pluginName} 的 Codex cache 残留来源；当前 AW 不会在缺少归属证据时静默删除它。`;
    }
    if (!cell.report.native.pluginInstalled && cell.report.native.pluginEnabled === true) {
      return `重新运行 aw install ${cell.pluginName}${suffix}，让 Codex 同时补齐 enabled config 和 active cache。`;
    }
    if (
      cell.report.native.pluginInstalled &&
      cell.report.native.pluginEnabled === true &&
      cell.report.scopeManagedEvidence?.ledger !== true
    ) {
      return `当前 Codex native 状态已存在，但 AW 缺少成功 scope record；请先运行 aw install ${cell.pluginName}${suffix} 修复账本。`;
    }
  }
  if (cell.report?.catalogCompatibility === 'capabilityChanged') {
    return `插件能力声明已变化，运行 aw upgrade ${cell.pluginName}${suffix}`;
  }
  if (
    cell.report?.ledgerStateStatus === 'degraded' &&
    cell.report.skillTriggerApplicability === 'overridable' &&
    (
      cell.report.skillTriggerDrift === 'unknown' ||
      !cell.report.skillTriggerPreference
    )
  ) {
    return `本机安装账本处于 degraded 状态；下一次 install/upgrade 请显式传 --skill-trigger default|manual|auto。`;
  }
  if (
    cell.platform === 'codex' &&
    cell.report?.native.marketplaceRegistered === false &&
    cell.report.driftWarnings.some((warning) => warning.includes('Codex marketplace'))
  ) {
    return `重新注册 Codex marketplace：aw install ${cell.pluginName} --platform codex --scope ${cell.scope}`;
  }
  if (cell.report?.skillTriggerDrift === 'yes') {
    return cell.report.skillTriggerApplicability === 'overridable'
      ? `重新应用 skill trigger 偏好：aw upgrade ${cell.pluginName}${suffix} --skill-trigger ${cell.report.skillTriggerPreference ?? 'default'}`
      : `刷新当前 skill runtime：aw upgrade ${cell.pluginName}${suffix}`;
  }

  return undefined;
}

function createSummary(pluginName: string, cells: StatusMatrixCell[]): StatusSummary {
  const health = combineHealth(cells.map((cell) => cell.health));
  const nextSteps = [
    ...new Set(
      cells
        .map(nextStepForCell)
        .filter((step): step is string => Boolean(step)),
    ),
  ];

  if (nextSteps.length === 0) {
    nextSteps.push(`查看详情：aw status ${pluginName} --verbose`);
  }

  return {
    pluginName,
    health,
    cells: cells.map((cell) => ({
      platform: cell.platform,
      scope: cell.scope,
      health: cell.health,
      healthSource: cell.healthSource,
      config: cell.config,
      scripts: cell.scripts,
      projectKey: cell.projectKey,
      ...(cell.configIssues ? { configIssues: cell.configIssues } : {}),
    })),
    nextSteps,
  };
}

function createNotInstalledSummary(pluginName: string): StatusSummary {
  return {
    pluginName,
    health: 'notInstalled',
    cells: [],
    nextSteps: [`安装 ${pluginName}：aw install ${pluginName}`],
  };
}

function formatDetectionSummary(detection: EnvironmentDetection): string {
  const parts = (['codex', 'claude'] as const).map((platform) => {
    const result = detection[platform];
    return `${platformLabel(platform)} ${result.available ? '可用' : '不可用'}`;
  });
  return parts.join('，');
}

function mapStatusHealthToFriendlyStatus(health: StatusHealth): PluginConsoleStatus {
  switch (health) {
    case 'ready':
      return 'installed';
    case 'partial':
      return 'partial';
    case 'external':
      return 'external';
    case 'notInstalled':
      return 'notInstalled';
    case 'needsAttention':
    case 'unknown':
    default:
      return 'needsAction';
  }
}

function summarizeFallbackLocation(summary: StatusSummary): string {
  if (summary.cells.length === 0) {
    return '未发现安装位置';
  }
  if (summary.cells.length === 1) {
    return pluginConsoleLocationLabel(summary.cells[0]);
  }
  return '多个位置';
}

function buildFriendlySummaries(
  matrix: StatusMatrixReport,
  consoleItems: PluginConsoleItem[],
): FriendlyStatusSummary[] {
  const itemsByPlugin = new Map(
    consoleItems.map((item) => [item.pluginName, item] as const),
  );

  return matrix.summaries.map((summary) => {
    const item = itemsByPlugin.get(summary.pluginName);
    if (item) {
      const nextSteps = item.nextSteps.length > 0
        ? item.nextSteps
        : item.status === 'notInstalled'
          ? summary.nextSteps
          : [`查看详情：aw status ${summary.pluginName} --verbose`];
      const nextStep = nextSteps[0];
      return {
        pluginName: summary.pluginName,
        status: item.status,
        statusLabel: item.statusLabel,
        location: item.locationSummary,
        ...(nextStep ? { nextStep } : {}),
        nextSteps,
        ...(item.issueSummary ? { issueSummary: item.issueSummary } : {}),
      };
    }

    const status = mapStatusHealthToFriendlyStatus(summary.health);
    const nextSteps = summary.nextSteps;
    const nextStep = nextSteps[0];
    return {
      pluginName: summary.pluginName,
      status,
      statusLabel: PLUGIN_CONSOLE_STATUS_LABELS[status],
      location: summarizeFallbackLocation(summary),
      ...(nextStep ? { nextStep } : {}),
      nextSteps,
    };
  });
}

function formatFriendlyStatusOutput(friendlySummaries: FriendlyStatusSummary[]): string {
  if (friendlySummaries.length === 0) {
    return [
      '插件状态',
      '当前还没有可显示的插件状态。',
      '下一步：运行 aw install <plugin> 安装指定插件。',
    ].join('\n');
  }

  const lines = ['插件状态'];
  for (const summary of friendlySummaries) {
    lines.push(`- ${summary.pluginName}`);
    lines.push(`  状态：${summary.statusLabel}`);
    lines.push(`  位置：${summary.location}`);
    if (summary.nextStep) {
      lines.push(`  下一步：${summary.nextStep}`);
    }
  }

  return lines.join('\n');
}

function formatVerboseMatrixOutput(matrix: StatusMatrixReport): string {
  if (matrix.cells.length === 0) {
    return '未发现更多诊断。';
  }

  return [
    `平台检测：${formatDetectionSummary(matrix.detection)}`,
    ...matrix.cells.map((cell) =>
      `- ${cell.pluginName} / ${pluginConsoleLocationLabel(cell)}：${healthLabel(cell.health)}。${describeCell(cell)}`,
    ),
  ].join('\n');
}

function formatVerboseStatusOutput(
  matrix: StatusMatrixReport,
  reports: StatusReport[],
  friendlySummaries: FriendlyStatusSummary[],
): string {
  return [
    formatFriendlyStatusOutput(friendlySummaries),
    '',
    '诊断信息',
    '状态矩阵',
    formatVerboseMatrixOutput(matrix),
    '',
    '命令诊断',
    formatStatusOutput(matrix.detection, reports),
  ].join('\n').trimEnd();
}

function formatStatusJsonPayload(
  payload: StatusJsonPayload,
  verbose: boolean | undefined,
): string {
  return JSON.stringify(
    payload,
    null,
    verbose ? 2 : 0,
  );
}

function createReportsByKey(): Map<string, StatusReport> {
  return new Map<string, StatusReport>();
}

function upsertReport(
  reportsByKey: Map<string, StatusReport>,
  candidate: CommandCandidate,
  status: StatusReport,
): void {
  const key = `${candidate.platform}:${candidate.scope}`;
  const report = reportsByKey.get(key) ?? {
    platform: candidate.platform,
    scope: candidate.scope,
    initialized: false,
    scopeInitialized: status.scopeInitialized,
    plugins: [],
  };
  report.initialized ||= status.initialized;
  report.scopeInitialized ??= status.scopeInitialized;
  report.plugins.push(...status.plugins);
  reportsByKey.set(key, report);
}

function sortReports(reports: StatusReport[]): StatusReport[] {
  const scopeOrder = { user: 0, project: 1 };
  const platformOrder = { codex: 0, claude: 1 };
  return reports.sort((left, right) =>
    platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope],
  );
}

function sortCells(cells: StatusMatrixCell[]): StatusMatrixCell[] {
  const scopeOrder = { user: 0, project: 1 };
  const platformOrder = { codex: 0, claude: 1 };
  return cells.sort((left, right) =>
    left.pluginName.localeCompare(right.pluginName) ||
    platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope] ||
    (left.projectKey ?? '').localeCompare(right.projectKey ?? ''),
  );
}

function hasConsoleUpgradeEvidenceCandidate(cell: StatusMatrixCell): boolean {
  if (!cell.report || cell.error) {
    return false;
  }

  if (cell.health !== 'ready' && cell.health !== 'partial') {
    return false;
  }

  return Boolean(
    cell.report.scopeManagedEvidence?.ledger ||
    cell.report.scopeManagedEvidence?.tracking ||
    cell.report.scopeManagedEvidence?.sharedNativeRef ||
    cell.report.scopeInitialized === 'yes' ||
    cell.report.generatedArtifacts.length > 0 ||
    cell.report.managedArtifacts?.length,
  );
}

async function resolveConsoleLocationDiagnostics(options: {
  cell: StatusMatrixCell;
  currentPlugin?: PluginMeta;
  ledger: InstalledLedger;
}): Promise<PluginConsoleLocationDiagnostics | undefined> {
  const { cell, currentPlugin, ledger } = options;
  if (!currentPlugin || !hasConsoleUpgradeEvidenceCandidate(cell)) {
    return undefined;
  }

  if (cell.report?.currentCatalog?.available !== true) {
    return undefined;
  }

  const scopeRecord = getStatusScopeRecord(
    ledger,
    cell.pluginName,
    cell.platform,
    cell.scope,
    cell.projectKey,
  );
  if (!scopeRecord?.resolvedVersion) {
    return { upgradeState: 'unknown' };
  }

  if (scopeRecord.resolvedVersion !== currentPlugin.manifest.version) {
    return { upgradeState: 'available' };
  }

  const snapshot = scopeRecord.lifecycleConfigSnapshot;
  if (!snapshot?.bundleFingerprint) {
    return { upgradeState: 'unknown' };
  }

  try {
    const currentFingerprint = await calculatePluginBundleFingerprint(currentPlugin.rootDir);
    return {
      upgradeState: currentFingerprint === snapshot.bundleFingerprint ? 'current' : 'available',
    };
  } catch {
    return { upgradeState: 'unknown' };
  }
}

function statusHealthFromProjectionKind(
  kind: StatusMatrixInstallState['kind'],
): StatusHealth {
  switch (kind) {
    case 'installed':
      return 'ready';
    case 'externallyManaged':
      return 'external';
    case 'notInstalled':
      return 'notInstalled';
    default:
      return 'needsAttention';
  }
}

function hasAwNativeResidueDiscoveryEvidence(
  state: Awaited<ReturnType<typeof collectP7Locations>>['locations'][number],
): boolean {
  const sources = state.target.discoveryEvidence?.sources ?? [];
  return sources.includes('codexNativeConfig') ||
    sources.includes('codexNativeCache') ||
    sources.includes('codexNativeRecovery') ||
    sources.includes('codexSharedNativeRef');
}

function statusHealthForCollectedState(
  state: Awaited<ReturnType<typeof collectP7Locations>>['locations'][number],
  installState: StatusMatrixInstallState,
): StatusHealth {
  if (state.target.discoveryEvidence?.readErrors.length) {
    return 'unknown';
  }
  if (
    (installState.kind === 'externallyManaged' || installState.kind === 'notInstalled') &&
    hasAwNativeResidueDiscoveryEvidence(state)
  ) {
    return 'needsAttention';
  }
  return statusHealthFromProjectionKind(installState.kind);
}

function createSkillTriggerMaterializationTargetForStatus(options: {
  platform: PlatformName;
  scope: Scope;
  executionCwd: string;
  env: NodeJS.ProcessEnv;
}): SkillTriggerMaterializationTarget {
  if (options.platform === 'codex' && options.scope === 'project') {
    return {
      platform: 'codex',
      scope: 'project',
      kind: 'repoSkill',
      root: path.join(options.executionCwd, '.agents', 'skills'),
    };
  }

  if (options.platform === 'codex') {
    return {
      platform: 'codex',
      scope: 'user',
      kind: 'localMarketplaceRuntime',
      root: resolveAwHome(options.env),
    };
  }

  return {
    platform: 'claude',
    scope: options.scope,
    kind: 'localMarketplaceRuntime',
    root: resolveAwHome(options.env),
  };
}

async function resolveSharedRuntimeAssessmentForState(options: {
  location: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey?: string | null;
  };
  executionCwd: string;
  currentPlugin?: PluginMeta;
  recordPreference?: string;
  env: NodeJS.ProcessEnv;
}): Promise<SharedSkillTriggerRuntimeSemanticsAssessment | null> {
  if (!options.currentPlugin) {
    return null;
  }

  try {
    return await assessSharedSkillTriggerRuntimeSemantics({
      pluginName: options.location.plugin,
      platform: options.location.platform,
      locationScope: options.location.scope,
      preference: options.recordPreference === 'manual' || options.recordPreference === 'auto'
        ? options.recordPreference
        : 'default',
      embeddedRoot: path.dirname(options.currentPlugin.rootDir),
      target: createSkillTriggerMaterializationTargetForStatus({
        platform: options.location.platform,
        scope: options.location.scope,
        executionCwd: options.executionCwd,
        env: options.env,
      }),
    });
  } catch {
    return null;
  }
}

async function createInstallStateForCell(options: {
  state: Awaited<ReturnType<typeof collectP7Locations>>['locations'][number];
  env: NodeJS.ProcessEnv;
}): Promise<StatusMatrixInstallState> {
  const { state, env } = options;
  const location = normalizePluginLocation({
    plugin: state.location.plugin,
    platform: state.location.platform,
    scope: state.location.scope,
    projectKey: state.location.projectKey ?? null,
  });
  const recordPreference = state.evidence.installRecord.read.status === 'ok'
    ? state.evidence.installRecord.read.value.record.options?.skillTriggerPreference
    : undefined;
  const sharedRuntimeAssessment = await resolveSharedRuntimeAssessmentForState({
    location,
    executionCwd: state.target.executionCwd,
    currentPlugin: state.target.currentPlugin,
    recordPreference,
    env,
  });
  const sharedRuntimeOwnerConflict = Boolean(
    state.evidence.sharedRuntimeOwner.needsTakeover &&
    sharedRuntimeAssessment?.participatesInSharedRuntimeOwner === true &&
    sharedRuntimeAssessment.semanticDelta !== 'noChange',
  );

  return {
    kind: state.projection.kind,
    summary: state.summary,
    nextSteps: state.nextSteps,
    findings: state.findings,
    issueCodes: state.projection.issues.map((issue) => issue.code),
    autoInstalled: state.projection.autoInstalled,
    unusedDependencyHint: state.projection.unusedDependencyHint,
    dependents: state.projection.dependents.map((dependent) =>
      normalizePluginLocation({
        plugin: dependent.plugin,
        platform: dependent.platform,
        scope: dependent.scope,
        projectKey: dependent.projectKey ?? null,
      })),
    repairAvailable: state.projection.repairAvailable,
    cleanupAvailable: state.projection.cleanupAvailable,
    adoptExistingAvailable: state.projection.adoptExistingAvailable,
    currentCatalogAvailable: Boolean(state.target.currentPlugin),
    catalogDrift: state.projection.catalogDrift,
    upgradeAvailable: state.projection.upgradeAvailable,
    dynamicDiagnosticUnavailable: state.projection.dynamicDiagnosticUnavailable,
    nativeTransactionKind: state.projection.nativeTransactionKind,
    sharedRuntimeOwnerPresent: state.evidence.sharedRuntimeOwner.read.status === 'ok',
    sharedRuntimeNeedsTakeover: state.evidence.sharedRuntimeOwner.needsTakeover,
    sharedRuntimeParticipatesInOwner: sharedRuntimeAssessment?.participatesInSharedRuntimeOwner === true,
    sharedRuntimeSemanticDelta: sharedRuntimeAssessment?.semanticDelta ?? 'unknown',
    sharedRuntimeOwnerConflict,
  };
}

function createStatusJsonPayload(options: {
  matrix: StatusMatrixReport;
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleItem[];
}): StatusJsonPayload {
  return {
    ok: true,
    command: 'status',
    ...options.matrix,
    friendlySummaries: options.friendlySummaries,
    consoleItems: options.consoleItems,
  };
}

function nativeRecoverySuggestion(pluginName: string): string {
  return `aw uninstall ${pluginName} -p codex -s user`;
}

function isHistoricalCodexRoleWithoutRecoverableIdentity(
  artifact: GeneratedArtifact,
): boolean {
  return artifact.platform === 'codex' &&
    artifact.target === 'codex.agentRole' &&
    artifact.id !== undefined &&
    !artifact.roleKey?.trim() &&
    !artifact.artifactKey?.trim();
}

function createHistoricalUnavailableManagedArtifacts(
  state: Awaited<ReturnType<typeof collectP7Locations>>['locations'][number],
): ManagedArtifactStatus[] {
  const historicalArtifacts = state.target.historicalArtifacts ?? [];
  return historicalArtifacts
    .filter((artifact) =>
      artifact.platform === state.location.platform &&
      isHistoricalCodexRoleWithoutRecoverableIdentity(artifact)
    )
    .map((artifact) => ({
      path: artifact.path,
      exists: false,
      kind: artifact.kind,
      ...(artifact.paths ? { paths: [...artifact.paths] } : {}),
      ...(artifact.id ? { id: artifact.id } : {}),
      ...(artifact.target ? { target: artifact.target } : {}),
      ...(artifact.state ? { state: artifact.state } : {}),
      ...(artifact.disabledReason ? { disabledReason: artifact.disabledReason } : {}),
      ...(artifact.refreshKeys ? { refreshKeys: [...artifact.refreshKeys] } : {}),
      ...(artifact.configDigest ? { configDigest: artifact.configDigest } : {}),
      ...(artifact.contentDigest ? { contentDigest: artifact.contentDigest } : {}),
      ...(artifact.lastRefresh ? { lastRefresh: artifact.lastRefresh } : {}),
      ...(artifact.refreshReach ? { refreshReach: artifact.refreshReach } : {}),
      tracked: true,
      health: 'unavailable',
      sessionVisibility: 'absent',
      diagnostics: ['无法从 tracking 或静态 metadata 恢复 codex.agentRole 的真实 roleKey。'],
    }));
}

async function createCompatNativeStatus(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  env: NodeJS.ProcessEnv;
}): Promise<NativePluginStatus> {
  const base: NativePluginStatus = {
    marketplaceRegistered: false,
    pluginAvailable: true,
    pluginInstalled: false,
    pluginEnabled: false,
    recovery: {
      present: false,
      state: null,
      reason: null,
      evidenceMatches: null,
      suggestion: null,
    },
  };

  if (options.platform !== 'codex' || options.scope !== 'user') {
    return base;
  }

  try {
    const native = await readCodexNativePluginState(options.pluginName, options.env);
    base.configPath = native.configPath;
    base.configEntryPresent = native.configEntryPresent;
    base.pluginEnabled = native.pluginEnabled;
    base.pluginInstalled = native.pluginInstalled;
    base.cacheRootPath = native.cacheRootPath;
    base.cacheStatus = native.cacheStatus;
    if (native.activeCacheVersion) {
      base.activeCacheVersion = native.activeCacheVersion;
    }
    if (native.activeCachePath) {
      base.activeCachePath = native.activeCachePath;
    }
    base.validCachePaths = native.validCachePaths;
    base.invalidCachePaths = native.invalidCachePaths;
    base.ignoredCacheEntries = native.ignoredCacheEntries;
  } catch {
    return base;
  }

  const recovery = await readCodexNativeRecoveryBreadcrumb(options.pluginName, options.env);
  if (recovery) {
    base.recovery = {
      present: true,
      state: recovery.state,
      reason: recovery.reason,
      evidenceMatches: Boolean(base.pluginInstalled && base.pluginEnabled),
      suggestion: nativeRecoverySuggestion(options.pluginName),
    };
  }

  return base;
}

async function createCompatibilityReports(options: {
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'];
  env: NodeJS.ProcessEnv;
}): Promise<StatusReport[]> {
  const reports = new Map<string, StatusReport>();
  for (const state of options.locations) {
    const key = `${state.location.platform}:${state.location.scope}`;
    const report = reports.get(key) ?? {
      platform: state.location.platform,
      scope: state.location.scope,
      initialized: false,
      scopeInitialized: state.evidence.installRecord.present ? 'yes' : 'no',
      plugins: [],
    };
    report.initialized ||= state.evidence.installRecord.present ||
      state.evidence.platform.codexNative?.anyNativeEvidence === true ||
      Boolean(state.target.discoveryEvidence?.sources.length);
    report.scopeInitialized = state.evidence.installRecord.present ? 'yes' : report.scopeInitialized;
    const managedArtifacts = createHistoricalUnavailableManagedArtifacts(state);
    report.plugins.push({
      pluginName: state.location.plugin,
      native: await createCompatNativeStatus({
        pluginName: state.location.plugin,
        platform: state.location.platform,
        scope: state.location.scope,
        env: options.env,
      }),
      generatedArtifacts: [],
      managedArtifacts,
      driftWarnings: [],
      ledgerStateStatus: 'available',
      ledgerStateReason: null,
      scopeInitialized: state.evidence.installRecord.present ? 'yes' : 'no',
      externalOwnership: { present: state.projection.kind === 'externallyManaged', checkState: 'known' },
      projectTrust: state.location.scope === 'project' ? 'unknown' : 'not_applicable',
      scopeManagedEvidence: {
        ledger: state.target.discoveryEvidence?.sources.includes('ledger') === true || state.evidence.installRecord.present,
        tracking: state.target.discoveryEvidence?.sources.includes('tracking') === true,
        sharedNativeRef: state.target.discoveryEvidence?.sources.includes('codexSharedNativeRef') === true,
      },
      repoManagedSessionState: {
        instructions: 'not_applicable',
        rules: 'not_applicable',
        hooks: 'not_applicable',
        agents: 'not_applicable',
        diagnostics: [],
        items: [],
      },
      currentCatalog: state.currentCatalog
        ? {
            rootDir: state.target.currentPlugin?.rootDir ?? '',
            source: 'local',
            available: true,
          }
        : undefined,
      artifactsInitialized: !state.projection.dynamicDiagnosticUnavailable,
    });
    reports.set(key, report);
  }

  return sortReports([...reports.values()]);
}

export async function statusCommand(
  pluginNames: string[],
  rawOptions: RawStatusCommandOptions,
  runtime: StatusCommandRuntime = {},
): Promise<{
  reports: StatusReport[];
  output: string;
  matrix: StatusMatrixReport;
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleItem[];
}> {
  const collected = await collectP7Locations(pluginNames, rawOptions, runtime);
  const options = collected.options;
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const requestedPlugins = pluginNames.length > 0 ? pluginNames : undefined;
  const installStates = await Promise.all(collected.locations.map((state) =>
    createInstallStateForCell({ state, env }),
  ));
  const compatibilityReports = await createCompatibilityReports({
    locations: collected.locations,
    env,
  });
  const cells: StatusMatrixCell[] = collected.locations.map((state, index) => ({
    pluginName: state.location.plugin,
    platform: state.location.platform,
    scope: state.location.scope,
    ...(state.location.projectKey ? { projectKey: state.location.projectKey } : {}),
    executionCwd: state.target.executionCwd,
    health: statusHealthForCollectedState(state, installStates[index]!),
    evidenceSources: [
      state.evidence.installRecord.present ? 'record' : '',
      state.evidence.projectSharedIdentity.present ? 'projectIdentity' : '',
      state.evidence.dynamicDiagnostic.available ? 'dynamicDiagnostic' : '',
    ].filter((value) => value.length > 0),
    healthSource: state.currentCatalog ? 'currentCatalog' : 'none',
    config: 'no-schema',
    scripts: 'not_declared',
    ...(state.target.discoveryEvidence?.readErrors.length
      ? { error: state.target.discoveryEvidence.readErrors.join('\n') }
      : {}),
    installState: installStates[index],
  }));
  const summaries: StatusSummary[] = [...new Set(cells.map((cell) => cell.pluginName))]
    .map((pluginName) => {
      const pluginCells = cells.filter((cell) => cell.pluginName === pluginName);
      const pluginStates = collected.locations.filter((state) => state.location.plugin === pluginName);
      return {
        pluginName,
        health: combineHealth(pluginCells.map((cell) => cell.health)),
        cells: pluginCells.map((cell) => ({
          platform: cell.platform,
          scope: cell.scope,
          health: cell.health,
          healthSource: cell.healthSource,
          config: cell.config,
          scripts: cell.scripts,
          ...(cell.projectKey ? { projectKey: cell.projectKey } : {}),
        })),
        nextSteps: [...new Set(pluginStates.flatMap((state) => state.nextSteps))],
      };
    })
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));
  const matrix: StatusMatrixReport = {
    detection: collected.detection,
    filters: {
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(requestedPlugins ? { plugins: requestedPlugins } : {}),
    },
    health: cells.some((cell) => cell.health === 'needsAttention')
      ? 'needsAttention'
      : cells.some((cell) => cell.health === 'ready')
        ? 'ready'
        : cells.every((cell) => cell.health === 'notInstalled')
          ? 'notInstalled'
          : 'unknown',
    summaries,
    cells: sortCells(cells),
    reports: compatibilityReports,
  };
  const consoleItems = createPluginConsoleItems(matrix);
  const friendlySummaries = buildFriendlySummaries(matrix, consoleItems);
  const jsonPayload: P7StatusJsonPayload & StatusMatrixReport & Pick<StatusJsonPayload, 'friendlySummaries' | 'consoleItems'> = {
    ok: true,
    command: 'status',
    detection: matrix.detection,
    filters: matrix.filters,
    health: matrix.health,
    summaries: matrix.summaries,
    cells: matrix.cells,
    reports: matrix.reports,
    generatedAt: new Date().toISOString(),
    locations: [],
    friendlySummaries,
    consoleItems,
  };
  const statusLocations: P7StatusJsonPayload['locations'] = collected.locations.map((state, index) => {
    const installState = installStates[index]!;
    const staleProjectReferences = state.dependencyIndexActions.filter((action) =>
      action.type === 'staleProjectReference');
    const dependencyIndexRecoveryMessage = state.projection.dependencyIndexCoverageTrusted
      ? null
      : state.projection.dependencyIndexRevisitProjectLocations.length > 0
        ? `请回到这些位置重新运行 diagnose 或 repair：${state.projection.dependencyIndexRevisitProjectLocations
          .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
          .join('，')}。`
        : state.projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects'
          ? '请回到可能相关的仓库重新运行 diagnose 或 repair。'
          : `依赖索引覆盖仍不完整：${state.projection.dependencyIndexCoverageReasons.join('、') || 'unknown'}。`;
    return {
      plugin: state.location.plugin,
      platform: state.location.platform,
      scope: state.location.scope,
      ...(state.location.projectKey ? { projectKey: state.location.projectKey } : {}),
      summary: state.summary,
      locationLabel: state.location.platform === 'codex'
        ? `Codex（${state.location.scope === 'project' ? '当前项目' : '当前用户'}）`
        : `Claude Code（${state.location.scope === 'project' ? '当前项目' : '当前用户'}）`,
      state: state.projection.kind,
      nextSteps: state.nextSteps,
      record: {
        present: state.evidence.installRecord.present,
        status: state.evidence.installRecord.read.status,
        path: state.evidence.installRecord.read.path,
        sourceDrift: state.evidence.installRecord.sourceDrift,
        sameBundleAsCatalog: state.evidence.installRecord.sameBundleAsCatalog,
      },
      dynamicDiagnostic: {
        available: state.evidence.dynamicDiagnostic.available,
        unavailableReason: state.evidence.dynamicDiagnostic.unavailableReason,
        unavailable: state.projection.dynamicDiagnosticUnavailable,
        triggerPreference: state.evidence.installRecord.read.status === 'ok'
          ? state.evidence.installRecord.read.value.record.options?.skillTriggerPreference ?? null
          : null,
        entries: state.evidence.dynamicDiagnostic.entries.map((entry) => entry.entry),
      },
      legacyDynamicTracking: state.evidence.installRecord.artifacts
        .filter((artifact) =>
          state.evidence.currentCatalog.provided &&
          state.evidence.installRecord.sameBundleAsCatalog === true &&
          artifact.artifact.id !== undefined &&
          artifact.artifact.target !== undefined &&
          (artifact.artifact.id === 'lightweight-instruction' || artifact.artifact.id === 'codex-explorer-role') &&
          !artifact.matchedCurrentDynamicArtifact)
        .map((artifact) => ({
          id: artifact.artifact.id!,
          target: artifact.artifact.target!,
          ...(artifact.artifact.artifactKey ? { artifactKey: artifact.artifact.artifactKey } : {}),
          ...(artifact.artifact.roleKey ? { roleKey: artifact.artifact.roleKey } : {}),
          path: artifact.artifact.path,
        })),
      dependencyIndex: {
        status: state.evidence.dependencyIndex.inspection.status,
        trusted: state.projection.dependencyIndexTrusted,
        dependencyIndexTrusted: state.projection.dependencyIndexTrusted,
        coverageTrusted: state.projection.dependencyIndexCoverageTrusted,
        dependencyIndexCoverageReason: state.projection.dependencyIndexCoverageReasons,
        reasons: state.projection.dependencyIndexCoverageReasons,
        verifiedLocations: state.projection.dependencyIndexVerifiedLocations,
        dependencyIndexVerifiedLocations: state.projection.dependencyIndexVerifiedLocations,
        revisitProjectLocations: state.projection.dependencyIndexRevisitProjectLocations,
        dependencyIndexRevisitLocations: state.projection.dependencyIndexRevisitProjectLocations,
        recoverySuggestion: state.projection.dependencyIndexRecoverySuggestion,
        dependencyIndexRecoveryMessage,
        actions: state.dependencyIndexActions,
        staleProjectReferences,
      },
      dependents: state.projection.dependents,
      autoInstalled: state.projection.autoInstalled,
      unusedDependencyHint: state.projection.unusedDependencyHint,
      projectIdentity: {
        attempted: state.evidence.projectSharedIdentity.attempted,
        present: state.evidence.projectSharedIdentity.present,
        readStatus: state.evidence.projectSharedIdentity.read?.status ?? 'missing',
        sourceDrift: state.evidence.projectSharedIdentity.sourceDrift,
      },
      sharedOwner: {
        present: state.evidence.sharedRuntimeOwner.read.status === 'ok',
        readStatus: state.evidence.sharedRuntimeOwner.read.status,
        ownerMatchesTarget: state.evidence.sharedRuntimeOwner.ownerMatchesTarget,
        ownerRecordDigestVerified: state.evidence.sharedRuntimeOwner.ownerRecordDigestVerified,
        needsTakeover: installState.sharedRuntimeOwnerConflict,
      },
      sharedSkillTriggerOwner: {
        present: state.evidence.sharedRuntimeOwner.read.status === 'ok',
        readStatus: state.evidence.sharedRuntimeOwner.read.status,
        ownerMatchesTarget: state.evidence.sharedRuntimeOwner.ownerMatchesTarget,
        ownerRecordDigestVerified: state.evidence.sharedRuntimeOwner.ownerRecordDigestVerified,
        needsTakeover: installState.sharedRuntimeOwnerConflict,
        ownerConflict: installState.sharedRuntimeOwnerConflict,
        suppressedOwnerConflict: state.evidence.sharedRuntimeOwner.needsTakeover && !installState.sharedRuntimeOwnerConflict,
      },
      nativeState: {
        transactionPresent: state.projection.nativeTransactionPresent,
        transactionKind: state.projection.nativeTransactionKind,
        codexNative: state.evidence.platform.codexNative,
      },
      nativeTransactionMarker: {
        present: state.projection.nativeTransactionPresent,
        status: state.projection.nativeTransactionKind,
        recordCommitted: state.projection.nativeTransactionKind === 'recordInstallResidual',
        markerPending: state.projection.nativeTransactionKind !== 'none',
        needsAttention: state.projection.nativeTransactionKind !== 'none',
        ...(state.projection.nativeTransactionKind !== 'none'
          ? {
              repairCommand: `aw repair ${state.location.plugin} -p ${state.location.platform} -s ${state.location.scope}`,
              cleanupCommand: `aw cleanup ${state.location.plugin} -p ${state.location.platform} -s ${state.location.scope}`,
            }
          : {}),
      },
      catalogDrift: state.projection.catalogDrift,
      upgradeAvailable: state.projection.upgradeAvailable,
      repairAvailable: state.projection.repairAvailable,
      cleanupAvailable: state.projection.cleanupAvailable,
      adoptExistingAvailable: state.projection.adoptExistingAvailable,
      findings: state.findings,
      issues: state.projection.issues,
      forceCleanup: state.forceCleanup,
      deepDiagnose: state.deepDiagnose,
    };
  });
  jsonPayload.locations = statusLocations;
  const output = options.json
    ? JSON.stringify(jsonPayload, null, 2)
    : options.verbose
      ? `${renderStatusHumanOutput(collected.locations)}\n\n详细信息\n${JSON.stringify(jsonPayload, null, 2)}`
      : renderStatusHumanOutput(collected.locations);
  return {
    reports: compatibilityReports,
    output,
    matrix,
    friendlySummaries,
    consoleItems,
  };
}
