import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogResolution,
  EnvironmentDetection,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeRecord,
  LifecycleConfigSnapshotMetadata,
  ManagedArtifactStatus,
  NextStepInstruction,
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
import type { PluginLocation as InstallStatePluginLocation } from '../install-state/types.js';
import { readCodexNativeRecoveryBreadcrumb } from '../utils/codex-native-recovery.js';
import { readCodexNativePluginState } from '../utils/codex-native-state.js';
import { detectEnvironment } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import { compareStrictSemVerFields } from '../utils/manifest.js';
import { isCatalogResolutionError, resolveCurrentCatalog } from '../utils/plugin-catalog.js';
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
import {
  PluginConfigSchemaResolutionError,
  isPluginConfigSchemaResolutionError,
  listPluginConfigStorePluginNames,
  resolveConfigReadV2,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  type PluginConfigIssue,
} from '../utils/plugin-config.js';
import {
  assessSharedSkillTriggerRuntimeSemantics,
  type SharedSkillTriggerRuntimeSemanticsAssessment,
  type SkillTriggerMaterializationTarget,
} from '../utils/skill-trigger-preferences.js';
import {
} from '../utils/plugin-scripts.js';
import { resolveAwHome } from '../utils/paths.js';
import { resolveLifecycleScriptForOs } from '../utils/plugin-script-contract.js';
import { loadVerifiedHistoricalBundlePlugin } from '../install-state/shared-runtime-owner.js';
import {
  createAdapters,
  formatStatusOutput,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
} from './common.js';
import {
  createLegacyConfigPlaceholderControllerItem,
  createConsoleControllerItems,
  type ConsoleDependencyEntry,
  type ConsoleLocationReadModel,
  createStatusPageModel,
  createPluginConsoleLocationKey,
  pluginConsoleLocationLabel,
  resolvePluginConsoleMeta,
  PLUGIN_CONSOLE_STATUS_LABELS,
  type ConsoleControllerItem,
  type PluginConsoleConfigProjection,
  type PluginConsoleSummary,
  type PluginConsoleLocationDiagnostics,
  type PluginConsoleStatus,
  type StatusPageModel,
} from './console-model.js';
import { buildCommandCandidates, type CommandCandidate } from './discovery.js';
import {
  createCommandExecutionContext,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  applyCatalogSelectorEnv,
  normalizeStatusCommandOptions,
  type RawStatusCommandOptions,
} from './options.js';
import {
  collectP7Locations,
  renderDiagnoseHumanOutput,
  type CollectedLocationState,
  type StatusJsonPayload as P7StatusJsonPayload,
} from './diagnose.js';
import { isCodexProjectStatusFatalError } from './codex-project-safety.js';
import {
  createLegacyCommandNextStep,
  createLegacyNextStepText,
  createManualNextStep,
  createNextStepsBoundary,
  createUiActionNextStep,
  dedupeNextSteps,
  formatNextStepForHuman,
} from '../output/model.js';

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
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
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
  catalogLatestBlockedByCli: boolean;
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
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
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
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  issueSummary?: string;
}

export interface StatusJsonPayload extends StatusMatrixReport {
  ok: true;
  command: 'status';
  statusSchemaVersion: 2;
  consoleItemsSchemaVersion: 3;
  catalog: CatalogResolution;
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleSummary[];
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

function statusCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
  options: { verbose?: boolean } = {},
): string {
  return `aw status ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}${options.verbose ? ' --verbose' : ''}`;
}

function installCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
): string {
  return `aw install ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}`;
}

function repairCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
  options: { adoptExisting?: boolean; takeoverSharedRuntime?: boolean } = {},
): string {
  return `aw repair ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}`
    + `${options.adoptExisting ? ' --adopt-existing' : ''}`
    + `${options.takeoverSharedRuntime ? ' --takeover-shared-runtime' : ''}`;
}

function cleanupCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
): string {
  return `aw cleanup ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}`;
}

function uninstallCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
): string {
  return `aw uninstall ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}`;
}

function upgradeCommandForCell(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
): string {
  return `aw upgrade ${cell.pluginName} --platform ${cell.platform} --scope ${cell.scope}`;
}

function detailStatusNextStep(
  cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>,
  description = '可以查看安装证据、残留和可恢复动作。',
): NextStepInstruction {
  return createUiActionNextStep(
    '查看详细状态',
    description,
    'openStatus',
    statusCommandForCell(cell, { verbose: true }),
  );
}

async function loadSnapshotPlugin(
  pluginName: string,
  snapshot: LifecycleConfigSnapshotMetadata,
): Promise<PluginMeta> {
  if (snapshot.pluginName !== pluginName) {
    throw new Error('snapshot belongs to another plugin');
  }

  const verified = await loadVerifiedHistoricalBundlePlugin({
    pluginName,
    pluginVersion: snapshot.pluginVersion,
    runtimeRoot: snapshot.snapshotRoot,
    bundleRoot: snapshot.bundleRoot,
    manifestPath: snapshot.manifestPath,
    sourceManifestDigest: snapshot.sourceManifestDigest,
    bundleFingerprint: snapshot.bundleFingerprint,
  });
  if (verified.status !== 'ok') {
    throw new Error(verified.reason);
  }

  const snapshotRoot = await fs.realpath(snapshot.snapshotRoot);
  const expectedBundleRoot = await fs.realpath(path.join(snapshotRoot, 'bundle'));
  if (verified.bundleRoot !== expectedBundleRoot || !isInsidePath(verified.bundleRoot, snapshotRoot)) {
    throw new Error('snapshot bundle root is outside snapshot root');
  }

  return verified.plugin;
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
  catalog: CatalogResolution,
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
          versionState: {
            ...entry.versionState,
            autoUpgradeState: catalog.latestCatalogBlocked && entry.versionState.autoUpgradeState === 'available'
              ? 'blockedByCli'
              : catalog.reasonCode === 'catalogUnavailable' && entry.versionState.autoUpgradeState === 'catalogUnavailable'
                ? 'catalogUnavailable'
                : entry.versionState.autoUpgradeState,
          },
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

async function resolveDependencyStatusByLocation(options: {
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'];
  catalog: CatalogResolution;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, PluginStatusDependencies>> {
  const ledger = await readInstalledLedger(options.env);
  const ledgerRecords = iterateInstalledScopeRecords(ledger);
  const collectedByKey = new Map(
    options.locations.map((state) => [
      serializePluginLocation(normalizePluginLocation({
        plugin: state.location.plugin,
        platform: state.location.platform,
        scope: state.location.scope,
        projectKey: state.location.projectKey ?? null,
      })),
      state,
    ] as const),
  );
  const projections = projectPluginDependencyStatus({
    state: {
      currentCatalogByPlugin: Object.fromEntries(
        options.locations
          .flatMap((state) => state.target.currentPlugin ? [[state.target.currentPlugin.manifest.name, state.target.currentPlugin.manifest] as const] : []),
      ),
      installedRecords: ledgerRecords.map(({ location, record }) => ({
        location,
        resolvedVersion: record.resolvedVersion,
        installSource: record.installSource,
        dependencyEdges: record.dependencyEdges,
        installOptions: record.installOptions,
      })),
      healthRecords: ledgerRecords.map(({ location, record }) => {
        const collected = collectedByKey.get(serializePluginLocation(location));
        const state = collected
          ? collected.projection.kind === 'installed'
            ? 'healthy'
            : record.managed ? 'degraded' : 'external'
          : record.managed ? 'healthy' : 'external';
        return {
          location,
          state,
          visible: true,
          managedByAw: record.managed,
        } satisfies PluginDependencyPlannerHealthRecord;
      }),
    },
    locations: options.locations.map((state) => normalizePluginLocation({
      plugin: state.location.plugin,
      platform: state.location.platform,
      scope: state.location.scope,
      projectKey: state.location.projectKey ?? null,
    })),
  });
  return buildDependencyStatusProjectionByLocation(projections, options.catalog);
}

function describeEvidenceSource(source: string): string {
  return {
    ledger: 'ledger',
    tracking: 'tracking',
    codexNativeConfig: 'Codex enabled config',
    codexNativeManifest: 'Codex installed manifest',
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

  if (plugin.currentCatalog.latestCatalogBlocked) {
    return `最新 catalog ${plugin.currentCatalog.latestCatalogBlocked.catalogVersion} 需要 CLI >= ${plugin.currentCatalog.latestCatalogBlocked.minAwVersion}；当前状态继续使用可兼容的 catalog 视图，不把它显示成插件可升级。`;
  }

  if (plugin.currentCatalog.available) {
    const versionParts = [
      plugin.currentCatalog.catalogVersion ? `catalog 版本 ${plugin.currentCatalog.catalogVersion}` : undefined,
      plugin.currentCatalog.pluginVersion ? `插件版本 ${plugin.currentCatalog.pluginVersion}` : undefined,
      plugin.currentCatalog.minAwVersion ? `最低 CLI ${plugin.currentCatalog.minAwVersion}` : undefined,
    ].filter(Boolean);
    const versionSummary = versionParts.length > 0 ? `，${versionParts.join('，')}` : '';
    return plugin.currentCatalog.source === 'embedded'
      ? `当前 catalog 来自 embedded${versionSummary}（本地 marketplace 未处于健康状态：${plugin.currentCatalog.reason ?? '原因未知'}）`
      : `当前 catalog 可用（来源 ${plugin.currentCatalog.source}${versionSummary}）`;
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

function nextStepForCell(cell: StatusMatrixCell): NextStepInstruction | undefined {
  if (cell.health === 'notInstalled') {
    return createUiActionNextStep(
      '开始安装',
      '会进入安装流程，并为这个插件选择可用的目标位置。',
      'runInstall',
      installCommandForCell(cell),
    );
  }
  if (cell.health === 'external') {
    return createManualNextStep(
      '确认外部占用来源',
      `先确认 ${cell.pluginName} 当前是否被外部 marketplace 占用，再决定是否迁移到 AW 管理。`,
    );
  }
  if (cell.report?.externalOwnership?.present && hasRuntimeEvidence(cell.report)) {
    return createManualNextStep(
      '处理外部 native 冲突',
      `先解除 ${cell.pluginName} 的同名外部 native 插件冲突，再重新检查当前 repo-managed 状态。`,
    );
  }
  if (cell.error) {
    return detailStatusNextStep(cell, '可以查看这次状态读取失败的具体原因。');
  }
  const unknownItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'unknown' || item.state === 'projectTrustUnknown',
  );
  if (unknownItem) {
    return createManualNextStep(
      '处理不可判定状态',
      `先修复 ${formatRepoManagedItemLabel(unknownItem)} 的不可判定状态，再重新查看当前插件的详细状态。`,
    );
  }
  const blockedItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'blockedByProjectTrust',
  );
  if (blockedItem) {
    return createManualNextStep(
      '让 Codex 信任当前仓库',
      `先让 Codex 信任当前仓库，再重新检查 ${formatRepoManagedItemLabel(blockedItem)} 的 project scope 状态。`,
    );
  }
  const orphanItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'orphan',
  );
  if (orphanItem) {
    return createManualNextStep(
      '处理未受管内容',
      `先处理未受管的 ${formatRepoManagedItemLabel(orphanItem)}，再决定是重新受管还是手动保留。`,
    );
  }
  if ((cell.report?.dependencies?.missing.length ?? 0) > 0) {
    return createManualNextStep(
      '补齐缺失依赖',
      `先补齐 ${cell.pluginName} 当前安装缺失的依赖，再重新检查状态。`,
    );
  }
  if (cell.report?.dependencies?.autoRemovable) {
    return createUiActionNextStep(
      '清理闲置自动依赖',
      `${cell.pluginName} 当前已经是闲置的自动依赖；确认没人再使用后，可以进入卸载流程清理。`,
      'runUninstall',
      uninstallCommandForCell(cell),
    );
  }
  if (cell.report?.catalogCompatibility === 'missing') {
    return createUiActionNextStep(
      '清理历史状态',
      '当前插件目录已经缺失；如果只想收口历史状态，可以进入卸载流程继续清理。',
      'runUninstall',
      uninstallCommandForCell(cell),
    );
  }
  if (cell.platform === 'codex' && cell.scope === 'user' && cell.report?.native.requiresNativePlugin) {
    if (cell.report.native.recovery?.present) {
      if (cell.report.native.recovery.evidenceMatches === false) {
        return createUiActionNextStep(
          '清理恢复标记',
          '如果 Codex cache 或 config 已手动清掉，仍需要通过卸载流程移除这条恢复记录。',
          'runUninstall',
          uninstallCommandForCell(cell),
        );
      }
      return createUiActionNextStep(
        '修复未完整收口的安装',
        '可以重新进入安装流程，补齐当前 Codex native 安装缺失的状态和产物。',
        'runInstall',
        installCommandForCell(cell),
      );
    }
    if (cell.report.native.pluginInstalled && cell.report.native.pluginEnabled !== true) {
      return createManualNextStep(
        '确认 Codex cache 残留来源',
        `先确认 ${cell.pluginName} 的 Codex cache 残留来源；当前 AW 不会在缺少归属证据时静默删除它。`,
      );
    }
    if (!cell.report.native.pluginInstalled && cell.report.native.pluginEnabled === true) {
      return createUiActionNextStep(
        '补齐 Codex native 状态',
        '可以重新进入安装流程，同时补齐 enabled config 和 active cache。',
        'runInstall',
        installCommandForCell(cell),
      );
    }
    if (
      cell.report.native.pluginInstalled &&
      cell.report.native.pluginEnabled === true &&
      cell.report.scopeManagedEvidence?.ledger !== true
    ) {
      return createUiActionNextStep(
        '修复 AW 账本',
        '当前 Codex native 状态已经存在，但 AW 缺少成功的 scope record；可以重新进入安装流程补齐账本。',
        'runInstall',
        installCommandForCell(cell),
      );
    }
  }
  if (cell.report?.catalogCompatibility === 'capabilityChanged') {
    return createUiActionNextStep(
      '升级插件',
      '当前插件的能力声明已经变化；可以进入升级流程，让当前安装重新对齐最新能力。',
      'runUpgrade',
      upgradeCommandForCell(cell),
    );
  }
  if (
    cell.report?.ledgerStateStatus === 'degraded' &&
    cell.report.skillTriggerApplicability === 'overridable' &&
    (
      cell.report.skillTriggerDrift === 'unknown' ||
      !cell.report.skillTriggerPreference
    )
  ) {
    return createManualNextStep(
      '显式指定 skill trigger',
      '本机安装账本处于 degraded 状态；下一次 install 或 upgrade 时，请显式指定 skill trigger。',
    );
  }
  if (
    cell.platform === 'codex' &&
    cell.report?.native.marketplaceRegistered === false &&
    cell.report.driftWarnings.some((warning) => warning.includes('Codex marketplace'))
  ) {
    return createUiActionNextStep(
      '重新注册 Codex marketplace',
      '可以重新进入安装流程，把当前插件重新注册到 Codex marketplace。',
      'runInstall',
      installCommandForCell({
        ...cell,
        platform: 'codex',
      }),
    );
  }
  if (cell.report?.skillTriggerDrift === 'yes') {
    return cell.report.skillTriggerApplicability === 'overridable'
      ? createUiActionNextStep(
        '重新应用 skill trigger 偏好',
        '可以进入升级流程，重新把当前 skill trigger 偏好应用到运行时产物。',
        'runUpgrade',
        upgradeCommandForCell(cell),
      )
      : createUiActionNextStep(
        '刷新当前 skill runtime',
        '可以进入升级流程，重新刷新当前 skill 的运行时内容。',
        'runUpgrade',
        upgradeCommandForCell(cell),
      );
  }

  return undefined;
}

function createSummary(pluginName: string, cells: StatusMatrixCell[]): StatusSummary {
  const health = combineHealth(cells.map((cell) => cell.health));
  const nextSteps = dedupeNextSteps(
    cells
      .map(nextStepForCell)
      .filter((step): step is NextStepInstruction => Boolean(step)),
  );

  if (nextSteps.length === 0) {
    nextSteps.push(createUiActionNextStep(
      '查看详细状态',
      '可以查看当前插件的详细状态、安装证据和可恢复动作。',
      'openStatus',
      `aw status ${pluginName} --verbose`,
    ));
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
    ...createNextStepsBoundary(nextSteps),
  };
}

function createNotInstalledSummary(pluginName: string): StatusSummary {
  return {
    pluginName,
    health: 'notInstalled',
    cells: [],
    ...createNextStepsBoundary([createUiActionNextStep(
      '开始安装',
      '会进入安装流程，并为这个插件选择可用的目标位置。',
      'runInstall',
      `aw install ${pluginName}`,
    )]),
  };
}

function instructionFromCollectedNextStep(step: string): NextStepInstruction {
  if (step.startsWith('aw repair ') && step.includes('--adopt-existing')) {
    return createUiActionNextStep(
      '认领现有安装',
      '会进入认领流程，把当前已存在的安装纳入 AW 管理。',
      'runAdoptExisting',
      step,
    );
  }
  if (step.startsWith('aw repair ')) {
    return createUiActionNextStep(
      '修复安装',
      '会进入修复流程，补齐当前安装缺失或不一致的状态。',
      'runRepair',
      step,
    );
  }
  if (step.startsWith('aw cleanup ')) {
    return createUiActionNextStep(
      '清理残留',
      '会进入 cleanup 流程，评估并清理当前残留状态。',
      'runCleanup',
      step,
    );
  }
  if (step.startsWith('aw install ')) {
    return createUiActionNextStep(
      '开始安装',
      '会进入安装流程，并为这个插件选择可用的目标位置。',
      'runInstall',
      step,
    );
  }
  if (step.startsWith('aw upgrade ')) {
    return createUiActionNextStep(
      '升级插件',
      '会进入升级流程，让当前安装重新对齐最新版本和能力。',
      'runUpgrade',
      step,
    );
  }
  if (step.startsWith('aw uninstall ')) {
    return createUiActionNextStep(
      '卸载插件',
      '会进入卸载流程，清理当前安装及其 AW 托管状态。',
      'runUninstall',
      step,
    );
  }
  if (step.startsWith('aw status ')) {
    return createUiActionNextStep(
      '查看详细状态',
      '可以查看安装证据、残留和可恢复动作。',
      'openStatus',
      step,
    );
  }
  return createManualNextStep('继续处理', step);
}

function nextStepsForCollectedLocation(state: CollectedLocationState): NextStepInstruction[] {
  const nextSteps = dedupeNextSteps(state.nextSteps.map(instructionFromCollectedNextStep));
  return nextSteps.length > 0 ? nextSteps : [detailStatusNextStep({
    pluginName: state.location.plugin,
    platform: state.location.platform,
    scope: state.location.scope,
  })];
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
    case 'notInstalled':
      return 'notInstalled';
    case 'partial':
    case 'external':
    case 'needsAttention':
    case 'unknown':
    default:
      return 'abnormal';
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
  consoleItems: PluginConsoleSummary[],
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
          : [createUiActionNextStep(
            '查看详细状态',
            '可以查看当前插件的详细状态、安装证据和可恢复动作。',
            'openStatus',
            `aw status ${summary.pluginName} --verbose`,
          )];
      const nextStep = nextSteps[0];
      return {
        pluginName: summary.pluginName,
        status: item.status,
        statusLabel: item.statusLabel,
        location: item.locationSummary ?? summarizeFallbackLocation(summary),
        ...(nextStep ? { nextStep: formatNextStepForHuman(nextStep) } : {}),
        ...createNextStepsBoundary(nextSteps, item.legacyNextSteps ?? summary.legacyNextSteps),
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
      ...(nextStep ? { nextStep: formatNextStepForHuman(nextStep) } : {}),
      ...createNextStepsBoundary(nextSteps, summary.legacyNextSteps),
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

function renderCollectedStatusHumanOutput(
  locations: CollectedLocationState[],
  options: { requestedPlugins?: string[] } = {},
): string {
  const stateLabel = (state: CollectedLocationState): string => {
    switch (state.projection.kind) {
      case 'installed':
        return '已安装';
      case 'needsRepair':
        return '需要处理';
      case 'adoptable':
        return '可认领';
      case 'residual':
        return '残留待清理';
      case 'externallyManaged':
        return '外部管理';
      case 'notInstalled':
        return '未安装';
    }
  };
  const lines = ['插件状态'];
  for (const state of locations) {
    const explicitNotInstalled = state.projection.kind === 'notInstalled' && options.requestedPlugins?.includes(state.location.plugin);
    lines.push(`- ${state.location.plugin}`);
    lines.push(`  状态：${stateLabel(state)}`);
    lines.push(`  摘要：${state.summary}`);
    if (!explicitNotInstalled) {
      lines.push(`  位置：${state.location.platform === 'codex'
        ? `Codex（${state.location.scope === 'project' ? '当前项目' : '当前用户'}）`
        : `Claude Code（${state.location.scope === 'project' ? '当前项目' : '当前用户'}）`}`);
      const nextStep = nextStepsForCollectedLocation(state)[0];
      if (nextStep) {
        lines.push(`  下一步：${formatNextStepForHuman(nextStep)}`);
      }
    }
  }
  return lines.join('\n');
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
  if (cell.report.currentCatalog.latestCatalogBlocked) {
    return { upgradeState: 'current' };
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

  const versionComparison = compareStrictSemVerFields({
    left: {
      value: currentPlugin.manifest.version,
      fieldPath: 'current plugin manifest.version',
    },
    right: {
      value: scopeRecord.resolvedVersion,
      fieldPath: 'installed ledger resolvedVersion',
    },
  });
  if (versionComparison.kind === 'invalid') {
    return { upgradeState: 'unknown' };
  }
  if (versionComparison.relation > 0) {
    return { upgradeState: 'available' };
  }
  return { upgradeState: 'current' };
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
    sources.includes('codexNativeManifest') ||
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
    ...createNextStepsBoundary(nextStepsForCollectedLocation(state), state.nextSteps),
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
    catalogLatestBlockedByCli: state.projection.catalogLatestBlockedByCli,
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
  catalog: CatalogResolution;
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleSummary[];
}): StatusJsonPayload {
  return {
    ok: true,
    command: 'status',
    statusSchemaVersion: 2,
    consoleItemsSchemaVersion: 3,
    catalog: options.catalog,
    ...options.matrix,
    friendlySummaries: options.friendlySummaries,
    consoleItems: options.consoleItems,
  };
}

function nativeRecoverySuggestion(pluginName: string): string {
  return `aw uninstall ${pluginName} -p codex -s user`;
}

function catalogResolutionFromError(
  error: unknown,
  fallbackRoot: string,
): CatalogResolution {
  if (isCatalogResolutionError(error)) {
    return {
      rootDir: fallbackRoot,
      source: 'remote',
      ...(error.resolution.selector ? { selector: error.resolution.selector } : {}),
      ...(error.resolution.channel ? { channel: error.resolution.channel } : {}),
      ...(error.resolution.catalogVersion ? { catalogVersion: error.resolution.catalogVersion } : {}),
      ...(error.resolution.minAwVersion ? { minAwVersion: error.resolution.minAwVersion } : {}),
      ...(error.resolution.latestCatalogBlocked ? { latestCatalogBlocked: error.resolution.latestCatalogBlocked } : {}),
      ...(error.resolution.historySchemaVersion !== undefined
        ? { historySchemaVersion: error.resolution.historySchemaVersion }
        : {}),
      ...(error.resolution.cacheFallback ? { cacheFallback: error.resolution.cacheFallback } : {}),
      ...(error.resolution.remoteFailure ? { remoteFailure: error.resolution.remoteFailure } : {}),
      reason: error.resolution.reason,
      reasonCode: error.resolution.reasonCode,
    };
  }

  return {
    rootDir: fallbackRoot,
    source: 'remote',
    reason: statusErrorMessage(error),
    reasonCode: 'catalogUnavailable',
  };
}

async function resolveStatusCatalog(
  env: NodeJS.ProcessEnv,
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'],
): Promise<CatalogResolution> {
  try {
    return await resolveCurrentCatalog(env);
  } catch (error) {
    const fallbackRoot = locations.find((state) => state.target.currentPlugin)?.target.currentPlugin?.rootDir
      ?? process.cwd();
    return catalogResolutionFromError(error, path.dirname(fallbackRoot));
  }
}

async function resolveStatusCatalogForProjection(
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CatalogResolution> {
  try {
    return await resolveCurrentCatalog(env);
  } catch (error) {
    return catalogResolutionFromError(error, cwd);
  }
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
  catalog: CatalogResolution;
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
            available: true,
            rootDir: options.catalog.rootDir,
            source: options.catalog.source,
            ...(options.catalog.selector ? { selector: options.catalog.selector } : {}),
            ...(options.catalog.sidecarManifestPackage ? { sidecarManifestPackage: options.catalog.sidecarManifestPackage } : {}),
            ...(options.catalog.fullCatalog ? { fullCatalog: options.catalog.fullCatalog } : {}),
            ...(options.catalog.channel ? { channel: options.catalog.channel } : {}),
            ...(options.catalog.catalogVersion ? { catalogVersion: options.catalog.catalogVersion } : {}),
            ...(options.catalog.minAwVersion ? { minAwVersion: options.catalog.minAwVersion } : {}),
            ...(options.catalog.latestCatalog ? { latestCatalog: options.catalog.latestCatalog } : {}),
            ...(options.catalog.latestCatalogBlocked ? { latestCatalogBlocked: options.catalog.latestCatalogBlocked } : {}),
            ...(options.catalog.historySchemaVersion !== undefined ? { historySchemaVersion: options.catalog.historySchemaVersion } : {}),
            ...(options.catalog.cacheFallback ? { cacheFallback: options.catalog.cacheFallback } : {}),
            ...(options.catalog.remoteFailure ? { remoteFailure: options.catalog.remoteFailure } : {}),
            ...(state.currentCatalog.source ? { pluginVersion: state.currentCatalog.source.pluginVersion } : {}),
            ...(options.catalog.reason ? { reason: options.catalog.reason } : {}),
            ...(options.catalog.reasonCode ? { reasonCode: options.catalog.reasonCode } : {}),
          }
        : undefined,
      artifactsInitialized: !state.projection.dynamicDiagnosticUnavailable,
    });
    reports.set(key, report);
  }

  return sortReports([...reports.values()]);
}

function createPluginMetaByNameFromCollected(
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'],
): Record<string, NonNullable<ReturnType<typeof resolvePluginConsoleMeta>>> {
  const metaByName: Record<string, NonNullable<ReturnType<typeof resolvePluginConsoleMeta>>> = {};
  for (const state of locations) {
    const meta = resolvePluginConsoleMeta(state.target.currentPlugin ?? state.target.historicalPlugin);
    if (meta) {
      metaByName[state.location.plugin] = meta;
    }
  }
  return metaByName;
}

function createPluginMetaByNameFromCandidates(
  candidates: CommandCandidate[],
): Record<string, NonNullable<ReturnType<typeof resolvePluginConsoleMeta>>> {
  const metaByName: Record<string, NonNullable<ReturnType<typeof resolvePluginConsoleMeta>>> = {};
  for (const candidate of candidates) {
    const meta = resolvePluginConsoleMeta(candidate.target.currentPlugin ?? candidate.target.plugin);
    if (meta) {
      metaByName[candidate.pluginName] = meta;
    }
  }
  return metaByName;
}

function createPluginMetaByNameFromConsoleItems(
  items: ConsoleControllerItem[],
): Record<string, {
  title?: string;
  description?: string;
  version?: string;
}> {
  return Object.fromEntries(items.map((item) => [
    item.summary.pluginName,
    {
      title: item.summary.title,
      ...(item.summary.description ? { description: item.summary.description } : {}),
      ...(item.summary.version ? { version: item.summary.version } : {}),
    },
  ]));
}

function createCurrentPluginByNameFromCollected(
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'],
): Record<string, PluginMeta> {
  const pluginByName: Record<string, PluginMeta> = {};
  for (const state of locations) {
    if (state.target.currentPlugin) {
      pluginByName[state.location.plugin] = state.target.currentPlugin;
    }
  }
  return pluginByName;
}

function createCurrentPluginByNameFromCandidates(
  candidates: CommandCandidate[],
): Record<string, PluginMeta> {
  const pluginByName: Record<string, PluginMeta> = {};
  for (const candidate of candidates) {
    const plugin = candidate.target.currentPlugin
      ?? (candidate.target.source === 'currentCatalog' ? candidate.target.plugin : undefined);
    if (plugin) {
      pluginByName[candidate.pluginName] = plugin;
    }
  }
  return pluginByName;
}

async function resolveConsoleConfigProjection(options: {
  pluginName: string;
  plugin?: PluginMeta;
  catalog: CatalogResolution;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<PluginConsoleConfigProjection | null> {
  const catalogDetails: NonNullable<PluginConsoleConfigProjection['catalog']> = {
    available: !options.catalog.reasonCode,
    ...(options.catalog.source ? { source: options.catalog.source } : {}),
    ...(options.catalog.channel ? { channel: options.catalog.channel } : {}),
    ...(options.catalog.catalogVersion ? { catalogVersion: options.catalog.catalogVersion } : {}),
    ...(options.catalog.minAwVersion ? { minAwVersion: options.catalog.minAwVersion } : {}),
    ...(options.catalog.reason ? { reason: options.catalog.reason } : {}),
    ...(options.catalog.reasonCode ? { reasonCode: options.catalog.reasonCode } : {}),
  };
  const storePaths = [
    resolvePluginConfigStorePath({
      pluginName: options.pluginName,
      scope: 'user',
      cwd: options.cwd,
      env: options.env,
    }),
    resolvePluginConfigStorePath({
      pluginName: options.pluginName,
      scope: 'project',
      cwd: options.cwd,
      env: options.env,
    }),
    resolvePluginConfigStorePath({
      pluginName: options.pluginName,
      scope: 'project',
      projectLayer: 'local',
      cwd: options.cwd,
      env: options.env,
    }),
  ];
  const hasConfigStore = (await Promise.all(storePaths.map((storePath) => fs.pathExists(storePath))))
    .some(Boolean);
  const pluginError = !options.plugin && options.catalog.reasonCode
    ? new PluginConfigSchemaResolutionError(
        'catalogUnavailable',
        options.catalog.reason ?? `current catalog 当前不可用（${options.catalog.reasonCode}）。`,
        {
          reasonCode: options.catalog.reasonCode,
          reason: options.catalog.reason,
        },
      )
    : null;

  try {
    const results = await Promise.all([
      resolveConfigReadV2({
        pluginName: options.pluginName,
        plugin: options.plugin,
        pluginError,
        scope: 'effective',
        projectLayer: 'shared',
        cwd: options.cwd,
        env: options.env,
      }),
      resolveConfigReadV2({
        pluginName: options.pluginName,
        plugin: options.plugin,
        pluginError,
        scope: 'user',
        projectLayer: 'shared',
        cwd: options.cwd,
        env: options.env,
      }),
      resolveConfigReadV2({
        pluginName: options.pluginName,
        plugin: options.plugin,
        pluginError,
        scope: 'project',
        projectLayer: 'shared',
        cwd: options.cwd,
        env: options.env,
      }),
      resolveConfigReadV2({
        pluginName: options.pluginName,
        plugin: options.plugin,
        pluginError,
        scope: 'project',
        projectLayer: 'local',
        cwd: options.cwd,
        env: options.env,
      }),
    ]);
    const views = results.map((result) => ({
      scope: result.scope,
      projectLayer: result.projectLayer,
      fields: result.fields,
      legacyConfigStores: result.legacyConfigStores,
    })).filter((view) => view.fields.length > 0 || view.legacyConfigStores.length > 0);

    if (views.length === 0) {
      return null;
    }

    return {
      configSchemaVersion: 2,
      state: 'available',
      ...(results.find((result) => result.schema)?.schema
        ? { schema: results.find((result) => result.schema)!.schema }
        : {}),
      catalog: catalogDetails,
      views,
    };
  } catch (error) {
    if (!isPluginConfigSchemaResolutionError(error)) {
      return null;
    }

    const details = typeof error.details === 'object' && error.details !== null
      ? error.details as {
          consumers?: Array<{
            location: {
              platform: PlatformName;
              scope: Scope;
              projectKey?: string;
            };
            recordPath: string;
            schemaIdentity: string;
            pluginVersion: string;
            manifestDigest: string;
          }>;
        }
      : {};
    const conflictConsumers = details.consumers?.map((consumer) => ({
      platform: consumer.location.platform,
      scope: consumer.location.scope,
      ...(consumer.location.projectKey ? { projectKey: consumer.location.projectKey } : {}),
      recordPath: consumer.recordPath,
      schemaIdentity: consumer.schemaIdentity,
      pluginVersion: consumer.pluginVersion,
      manifestDigest: consumer.manifestDigest,
    }));
    if (!hasConfigStore && (conflictConsumers?.length ?? 0) === 0) {
      return null;
    }

    return {
      configSchemaVersion: 2,
      state: error.code,
      issueMessage: error.message.replace(/^[^:]+:\s*/, ''),
      ...(conflictConsumers && conflictConsumers.length > 0
        ? {
            issueDetails: conflictConsumers.map((consumer) =>
              `${consumer.platform}/${consumer.scope}${consumer.projectKey ? `/${consumer.projectKey}` : ''} · ${consumer.pluginVersion} · ${consumer.schemaIdentity}`),
            conflictConsumers,
          }
        : {}),
      catalog: catalogDetails,
      views: [],
    };
  }
}

async function resolveConsoleConfigProjectionByPluginName(options: {
  pluginNames: string[];
  currentPluginByName: Record<string, PluginMeta>;
  catalog: CatalogResolution;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, PluginConsoleConfigProjection>> {
  const entries = await Promise.all(options.pluginNames.map(async (pluginName) => {
    const projection = await resolveConsoleConfigProjection({
      pluginName,
      plugin: options.currentPluginByName[pluginName],
      catalog: options.catalog,
      cwd: options.cwd,
      env: options.env,
    });
    return projection ? [pluginName, projection] as const : null;
  }));
  return Object.fromEntries(entries.filter((entry): entry is [string, PluginConsoleConfigProjection] => entry !== null));
}

function hasLegacyConfigStores(projection: PluginConsoleConfigProjection | undefined): boolean {
  return projection?.views.some((view) => view.legacyConfigStores.length > 0) === true;
}

function classifyDependencyEntry(options: {
  pluginName: string;
  location: PluginLocation;
  healthStatus: 'ok' | 'missingRecord' | 'invalidRecord' | 'missingArtifact' | 'nativeMarkerPresent' | 'nativeEvidenceMissing' | null;
  reason: string | null;
  versionState?: PluginStatusDependencies['resolved'][number]['versionState'];
}): ConsoleDependencyEntry {
  const versionDetails = options.versionState
    ? [
        options.versionState.declaredMinVersion ? `声明 >= ${options.versionState.declaredMinVersion}` : undefined,
        options.versionState.installedVersion ? `已装 ${options.versionState.installedVersion}` : undefined,
        options.versionState.candidateVersion ? `catalog 候选 ${options.versionState.candidateVersion}` : undefined,
        options.versionState.autoUpgradeState === 'available'
          ? '可自动升级'
          : options.versionState.autoUpgradeState === 'blockedByCli'
            ? '受 CLI 版本限制'
            : undefined,
      ].filter(Boolean).join('，')
    : '';
  const summarySuffix = versionDetails ? `（${versionDetails}）` : '';
  if (options.healthStatus === 'ok' || options.healthStatus === null) {
    return {
      pluginName: options.pluginName,
      locationLabel: pluginConsoleLocationLabel(options.location),
      symbol: '✓',
      tone: 'success',
      summary: `正常${summarySuffix}`,
    };
  }

  if (
    options.healthStatus === 'missingRecord' ||
    options.healthStatus === 'missingArtifact'
  ) {
    return {
      pluginName: options.pluginName,
      locationLabel: pluginConsoleLocationLabel(options.location),
      symbol: '×',
      tone: 'danger',
      summary: `缺失${summarySuffix}`,
    };
  }

    return {
      pluginName: options.pluginName,
      locationLabel: pluginConsoleLocationLabel(options.location),
      symbol: '!',
      tone: 'danger',
      summary: `${options.reason ?? '状态异常'}${summarySuffix}`,
    };
}

type ConsoleCatalogSelectorLike = {
  kind: 'default' | 'distTag' | 'exactVersion';
  defaultChannel: string;
  requestedChannel?: string;
  requestedCatalogVersion?: string;
};

type ConsoleCatalogLike = {
  available?: boolean;
  source?: string | null;
  channel?: string | null;
  catalogVersion?: string | null;
  pluginVersion?: string | null;
  minAwVersion?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  selector?: ConsoleCatalogSelectorLike;
  latestCatalogBlocked?: {
    catalogVersion: string;
    minAwVersion: string;
  };
  cacheFallback?: {
    used?: boolean;
    matchedCatalog?: {
      channel: string;
      version: string;
      source: string;
    };
  };
  remoteFailure?: {
    stage: string;
    message: string;
  };
};

function describeCatalogSelectorForConsole(
  selector: ConsoleCatalogSelectorLike,
): string {
  switch (selector.kind) {
    case 'default':
      return `默认 channel（${selector.defaultChannel}）`;
    case 'distTag':
      return `显式 channel ${selector.requestedChannel ?? selector.defaultChannel}`;
    case 'exactVersion':
      return `显式 catalog 版本 ${selector.requestedCatalogVersion}`;
  }
}

function describeCatalogSummaryForConsole(
  currentCatalog: ConsoleCatalogLike,
): string {
  if (currentCatalog.available !== true) {
    const reason = [currentCatalog.reasonCode, currentCatalog.reason]
      .filter((value): value is string => Boolean(value && value.trim().length > 0))
      .join('；');
    return reason === '' ? '不可用' : `不可用（${reason}）`;
  }

  return [
    currentCatalog.source ? `来源 ${currentCatalog.source}` : undefined,
    currentCatalog.channel ? `channel ${currentCatalog.channel}` : undefined,
    currentCatalog.catalogVersion ? `catalog ${currentCatalog.catalogVersion}` : undefined,
    currentCatalog.pluginVersion ? `插件 ${currentCatalog.pluginVersion}` : undefined,
    currentCatalog.minAwVersion ? `最低 CLI ${currentCatalog.minAwVersion}` : undefined,
  ].filter(Boolean).join(' · ');
}

function toCommandPluginLocation(location: InstallStatePluginLocation): PluginLocation {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.projectKey ?? null,
  };
}

function buildConsoleLocationReadModelByKey(options: {
  locations: Awaited<ReturnType<typeof collectP7Locations>>['locations'];
  catalog: CatalogResolution;
  dependencyStatusByLocation: Record<string, PluginStatusDependencies>;
}): Record<string, ConsoleLocationReadModel> {
  const entries: Array<[string, ConsoleLocationReadModel]> = [];

  for (const state of options.locations) {
    const key = createPluginConsoleLocationKey({
      pluginName: state.location.plugin,
      platform: state.location.platform,
      scope: state.location.scope,
      ...(state.location.projectKey ? { projectKey: state.location.projectKey } : {}),
    });
    const diagnostics: ConsoleLocationReadModel['diagnostics'] = [];
    const dependencyEntries: ConsoleDependencyEntry[] = [];
    const record = state.evidence.installRecord.read.status === 'ok'
      ? state.evidence.installRecord.read.value.record
      : null;
    const dependencyStatus = options.dependencyStatusByLocation[
      serializePluginLocation(toCommandPluginLocation(state.location))
    ];
    const dependencyHealthByKey = new Map(
      state.evidence.dependencyIndex.projection.dependencyHealth.map((entry) => [
        serializePluginLocation(toCommandPluginLocation(entry.dependency)),
        entry,
      ] as const),
    );

    if (record) {
      for (const edge of record.dependencyEdges) {
        const health = dependencyHealthByKey.get(serializePluginLocation(toCommandPluginLocation(edge.dependency)));
        const resolvedEntry = dependencyStatus?.resolved.find((entry) =>
          entry.declaration.name === edge.declaration.name &&
          (entry.declaration.target?.scope ?? null) === (edge.declaration.target?.scope ?? null),
        );
        dependencyEntries.push(classifyDependencyEntry({
          pluginName: edge.dependency.plugin,
          location: toCommandPluginLocation(edge.dependency),
          healthStatus: health?.status ?? null,
          reason: health?.reason ?? null,
          versionState: resolvedEntry?.versionState,
        }));
      }
    }

    if (record?.source.pluginVersion) {
      diagnostics.push({
        label: '已安装版本',
        value: record.source.pluginVersion,
        tone: 'info',
      });
    }

    if (state.target.currentPlugin || options.catalog.reasonCode) {
      diagnostics.push({
        label: 'current catalog',
        value: describeCatalogSummaryForConsole({
          available: !options.catalog.reasonCode && Boolean(state.target.currentPlugin),
          source: options.catalog.source,
          channel: options.catalog.channel,
          catalogVersion: options.catalog.catalogVersion,
          pluginVersion: state.target.currentPlugin?.manifest.version ?? null,
          minAwVersion: options.catalog.minAwVersion,
          reason: options.catalog.reason,
          reasonCode: options.catalog.reasonCode,
        }),
        tone: !options.catalog.reasonCode && state.target.currentPlugin ? 'info' : 'danger',
      });
      if (options.catalog.selector) {
        diagnostics.push({
          label: 'selector',
          value: describeCatalogSelectorForConsole(options.catalog.selector),
          tone: 'info',
        });
      }
      if (options.catalog.latestCatalogBlocked) {
        diagnostics.push({
          label: 'CLI 版本限制',
          value: `最新 catalog ${options.catalog.latestCatalogBlocked.catalogVersion} 需要 CLI >= ${options.catalog.latestCatalogBlocked.minAwVersion}；当前继续使用兼容 catalog，不把它当成插件可升级。`,
          tone: 'info',
        });
      }
      if (options.catalog.cacheFallback?.used && options.catalog.cacheFallback.matchedCatalog) {
        diagnostics.push({
          label: 'catalog 缓存',
          value: `命中 cache fallback：${options.catalog.cacheFallback.matchedCatalog.channel} / ${options.catalog.cacheFallback.matchedCatalog.version}（${options.catalog.cacheFallback.matchedCatalog.source}）`,
          tone: 'info',
        });
      }
      if (options.catalog.remoteFailure) {
        diagnostics.push({
          label: '远程校验',
          value: `${options.catalog.remoteFailure.stage}：${options.catalog.remoteFailure.message}`,
          tone: 'danger',
        });
      }
    }

    if (options.catalog.reasonCode) {
      const details = [
        options.catalog.reasonCode,
        options.catalog.reason,
      ].filter((value): value is string => Boolean(value && value.trim().length > 0));
      diagnostics.push({
        label: 'catalog',
        value: state.target.currentPlugin
          ? `current catalog 当前不可用或不可接受；状态详情改用本地已知插件证据：${details.join('；') || '原因未知'}`
          : `current catalog 当前不可用或不可接受：${details.join('；') || '原因未知'}`,
        tone: 'info',
      });
    } else if (!state.target.currentPlugin && state.target.historicalPlugin) {
      diagnostics.push({
        label: 'catalog',
        value: '当前详情来自历史证据；current catalog 已不再提供这个插件目录。',
        tone: 'info',
      });
    }

    const autoUpgradeDependencies = dependencyStatus?.resolved
      .filter((entry) => entry.versionState.autoUpgradeState === 'available')
      .map((entry) =>
        `${entry.declaration.name}${entry.versionState.candidateVersion ? ` -> ${entry.versionState.candidateVersion}` : ''}`);
    if ((autoUpgradeDependencies?.length ?? 0) > 0) {
      diagnostics.push({
        label: '依赖自动升级',
        value: autoUpgradeDependencies!.join('，'),
        tone: 'info',
      });
    }

    const blockedDependencies = dependencyStatus?.resolved
      .filter((entry) =>
        entry.versionState.autoUpgradeState === 'blockedByCli' ||
        entry.versionState.autoUpgradeState === 'catalogUnavailable' ||
        entry.versionState.candidateVersionComparison === 'belowMinimum' ||
        entry.versionState.installedVersionComparison === 'invalid',
      )
      .map((entry) => {
        if (entry.versionState.autoUpgradeState === 'blockedByCli') {
          return `${entry.declaration.name} 当前有兼容升级候选，但受 CLI 版本限制。`;
        }
        if (entry.versionState.autoUpgradeState === 'catalogUnavailable') {
          return `${entry.declaration.name} 需要 current catalog 候选版本，但当前 catalog 不可用。`;
        }
        if (entry.versionState.candidateVersionComparison === 'belowMinimum') {
          return `${entry.declaration.name} 的 catalog 候选版本不足以满足最低版本要求。`;
        }
        if (entry.versionState.installedVersionComparison === 'invalid') {
          return `${entry.declaration.name} 的已安装版本无法按语义版本解释。`;
        }
        return undefined;
      })
      .filter((entry): entry is string => Boolean(entry));
    if ((blockedDependencies?.length ?? 0) > 0) {
      diagnostics.push({
        label: '依赖阻断',
        value: blockedDependencies!.join('；'),
        tone: 'danger',
      });
    }

    if (!state.projection.dependencyIndexCoverageTrusted) {
      diagnostics.push({
        label: '依赖索引',
        value: state.projection.dependencyIndexRevisitProjectLocations.length > 0
          ? `覆盖仍不完整；请回到这些位置重新运行 status --verbose 或 repair：${state.projection.dependencyIndexRevisitProjectLocations
            .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
            .join('，')}`
          : state.projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects'
            ? '覆盖仍不完整；请回到可能相关的仓库重新运行 status --verbose 或 repair。'
            : `覆盖仍不完整：${state.projection.dependencyIndexCoverageReasons.join('、') || 'unknown'}`,
        tone: 'info',
      });
    }

    for (const finding of state.findings) {
      diagnostics.push({
        label: '说明',
        value: finding,
        tone: 'info',
      });
    }

    for (const readError of state.target.discoveryEvidence?.readErrors ?? []) {
      diagnostics.push({
        label: '读取失败',
        value: readError,
        tone: 'danger',
      });
    }

    entries.push([key, {
      hasEvidence: Boolean(
        state.evidence.installRecord.present ||
        state.evidence.projectSharedIdentity.present ||
        state.evidence.dynamicDiagnostic.available ||
        state.evidence.platform.codexNative?.anyNativeEvidence ||
        (state.target.discoveryEvidence?.sources.length ?? 0) > 0 ||
        (state.target.discoveryEvidence?.readErrors.length ?? 0) > 0 ||
        state.projection.kind !== 'notInstalled'
      ),
      summary: state.summary,
      diagnostics,
      ...(dependencyEntries.length > 0 ? { dependencyEntries } : {}),
    }]);
  }

  return Object.fromEntries(entries);
}

function fallbackNotInstalledState(): StatusMatrixInstallState {
  return {
    kind: 'notInstalled',
    summary: '当前还没有发现安装。',
    ...createNextStepsBoundary([
      createManualNextStep(
        '选择目标位置',
        '先选择要安装到哪个位置，再继续安装流程。',
      ),
    ]),
    findings: [],
    issueCodes: [],
    autoInstalled: false,
    unusedDependencyHint: false,
    dependents: [],
    repairAvailable: false,
    cleanupAvailable: false,
    adoptExistingAvailable: false,
    currentCatalogAvailable: true,
    catalogDrift: false,
    catalogLatestBlockedByCli: false,
    upgradeAvailable: false,
    dynamicDiagnosticUnavailable: true,
    nativeTransactionKind: 'none',
    sharedRuntimeOwnerPresent: false,
    sharedRuntimeNeedsTakeover: false,
    sharedRuntimeParticipatesInOwner: false,
    sharedRuntimeSemanticDelta: 'unknown',
    sharedRuntimeOwnerConflict: false,
  };
}

function summarizeCandidateInstallState(
  candidate: CommandCandidate,
): Pick<StatusMatrixInstallState, 'summary' | 'nextSteps'> {
  const kind = candidate.installState?.kind ?? 'notInstalled';
  const detailCommand = `aw status ${candidate.pluginName} --verbose`;
  const baseLocation = {
    pluginName: candidate.pluginName,
    platform: candidate.platform,
    scope: candidate.scope,
  };
  switch (kind) {
    case 'installed':
      return {
        summary: '已发现安装。',
        nextSteps: [createUiActionNextStep(
          '查看详细状态',
          '可以查看当前安装的详细状态、安装证据和可恢复动作。',
          'openStatus',
          detailCommand,
        )],
      };
    case 'needsRepair':
      return {
        summary: '安装存在异常，需要修复。',
        nextSteps: [createUiActionNextStep(
          '修复安装',
          '会进入修复流程，补齐当前安装缺失或不一致的状态。',
          'runRepair',
          repairCommandForCell(baseLocation),
        )],
      };
    case 'adoptable':
      return {
        summary: '发现可认领的现有安装。',
        nextSteps: [createUiActionNextStep(
          '认领现有安装',
          '会进入认领流程，把当前已存在的安装纳入 AW 管理。',
          'runAdoptExisting',
          repairCommandForCell(baseLocation, { adoptExisting: true }),
        )],
      };
    case 'residual':
      return {
        summary: '发现可清理的残留。',
        nextSteps: [createUiActionNextStep(
          '清理残留',
          '会进入 cleanup 流程，评估并清理当前残留状态。',
          'runCleanup',
          cleanupCommandForCell(baseLocation),
        )],
      };
    case 'externallyManaged':
      return {
        summary: '发现由其他来源管理的安装。',
        nextSteps: [createManualNextStep(
          '确认外部安装来源',
          '先确认这份安装是否由外部来源管理，再决定是否继续处理。',
        )],
      };
    case 'notInstalled':
    default:
      return {
        summary: '当前还没有发现安装。',
        nextSteps: [createManualNextStep(
          '选择目标位置',
          '先选择要安装到哪个位置，再继续安装流程。',
        )],
      };
  }
}

function createCandidateInstallState(candidate: CommandCandidate): StatusMatrixInstallState {
  const fallback = fallbackNotInstalledState();
  if (!candidate.installState) {
    return fallback;
  }

  const summarized = summarizeCandidateInstallState(candidate);
  return {
    ...fallback,
    kind: candidate.installState.kind,
    summary: summarized.summary,
    ...createNextStepsBoundary(summarized.nextSteps),
    autoInstalled: candidate.installState.autoInstalled,
    unusedDependencyHint: candidate.installState.unusedDependencyHint,
    repairAvailable: candidate.installState.kind === 'needsRepair',
    cleanupAvailable: candidate.installState.kind === 'residual' || candidate.installState.kind === 'externallyManaged',
    adoptExistingAvailable: candidate.installState.adoptExistingAvailable,
    currentCatalogAvailable: Boolean(candidate.target.currentPlugin),
    sharedRuntimeOwnerConflict: candidate.installState.ownerConflict,
    issueCodes: candidate.installState.kind === 'needsRepair'
      ? ['installRecordInvalid']
      : [],
  };
}

function createStatusMatrixFromCandidates(options: {
  candidates: CommandCandidate[];
  detection: EnvironmentDetection;
  requestedPlugins?: string[];
  scope?: Scope;
  platform?: PlatformName | 'both';
}): StatusMatrixReport {
  const cells: StatusMatrixCell[] = options.candidates.map((candidate) => {
    const installState = createCandidateInstallState(candidate);
    return {
      pluginName: candidate.pluginName,
      platform: candidate.platform,
      scope: candidate.scope,
      ...(candidate.projectKey ? { projectKey: candidate.projectKey } : {}),
      executionCwd: candidate.executionCwd,
      health: installState.kind === 'notInstalled' ? 'notInstalled' : 'ready',
      evidenceSources: [],
      healthSource: candidate.target.currentPlugin ? 'currentCatalog' : 'none',
      config: 'no-schema',
      scripts: 'not_declared',
      installState,
    };
  });

  const summaries: StatusSummary[] = [...new Set(cells.map((cell) => cell.pluginName))]
    .map((pluginName) => {
      const pluginCells = cells.filter((cell) => cell.pluginName === pluginName);
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
        ...createNextStepsBoundary(pluginCells.every((cell) => cell.installState?.kind === 'notInstalled')
          ? [createManualNextStep('选择目标位置', '先选择要安装到哪个位置，再继续安装流程。')]
          : []),
      };
    })
    .sort((left, right) => left.pluginName.localeCompare(right.pluginName));

  return {
    detection: options.detection,
    filters: {
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.requestedPlugins ? { plugins: options.requestedPlugins } : {}),
    },
    health: cells.every((cell) => cell.health === 'notInstalled') ? 'notInstalled' : 'ready',
    summaries,
    cells: sortCells(cells),
    reports: [],
  };
}

export async function statusCommand(
  pluginNames: string[],
  rawOptions: RawStatusCommandOptions,
  runtime: StatusCommandRuntime = {},
): Promise<{
  catalog: CatalogResolution;
  reports: StatusReport[];
  output: string;
  matrix: StatusMatrixReport;
  friendlySummaries: FriendlyStatusSummary[];
  consoleItems: PluginConsoleSummary[];
  consoleControllerItems: ConsoleControllerItem[];
  statusPageModels: StatusPageModel[];
  locationReadModelByKey: Record<string, ConsoleLocationReadModel>;
  currentPluginByName: Record<string, PluginMeta>;
  configProjectionByPluginName: Record<string, PluginConsoleConfigProjection>;
}> {
  const normalizedOptions = normalizeStatusCommandOptions(rawOptions);
  const earlyCatalog = await resolveStatusCatalogForProjection(
    normalizedOptions.cwd,
    applyCatalogSelectorEnv(runtime.env ?? process.env, normalizedOptions),
  );
  const runtimeWithSelector = {
    ...runtime,
    env: applyCatalogSelectorEnv(runtime.env ?? process.env, normalizedOptions),
    p7Catalog: earlyCatalog,
  } as StatusCommandRuntime & { p7Catalog: CatalogResolution };
  const collected = await collectP7Locations(pluginNames, {
    ...normalizedOptions,
    deep: normalizedOptions.verbose === true,
  }, runtimeWithSelector);
  const options = collected.options;
  const context = createCommandExecutionContext(runtimeWithSelector);
  const env = context.env;
  const requestedPlugins = pluginNames.length > 0 ? pluginNames : undefined;
  const installStates = await Promise.all(collected.locations.map((state) =>
    createInstallStateForCell({ state, env }),
  ));
  const catalog = earlyCatalog.reasonCode === 'catalogUnavailable'
    ? await resolveStatusCatalog(env, collected.locations)
    : earlyCatalog;
  const dependencyStatusByLocation = await resolveDependencyStatusByLocation({
    locations: collected.locations,
    catalog,
    env,
  });
  const compatibilityReports = await createCompatibilityReports({
    locations: collected.locations,
    env,
    catalog,
  });
  const cells: StatusMatrixCell[] = collected.locations.map((state, index) => ({
    ...(() => {
      const compatibilityReport = compatibilityReports.find((report) =>
        report.platform === state.location.platform &&
        report.scope === state.location.scope,
      )?.plugins.find((plugin) => plugin.pluginName === state.location.plugin);
      return compatibilityReport ? { report: compatibilityReport } : {};
    })(),
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
        ...createNextStepsBoundary(dedupeNextSteps(pluginStates.flatMap((state) => nextStepsForCollectedLocation(state)))),
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
  const pluginMetaByName = createPluginMetaByNameFromCollected(collected.locations);
  const currentPluginByName = createCurrentPluginByNameFromCollected(collected.locations);
  const locationReadModelByKey = buildConsoleLocationReadModelByKey({
    locations: collected.locations,
    catalog,
    dependencyStatusByLocation,
  });
  const configProjectionByPluginName = await resolveConsoleConfigProjectionByPluginName({
    pluginNames: [...new Set(matrix.cells.map((cell) => cell.pluginName))],
    currentPluginByName,
    catalog,
    cwd: options.cwd,
    env,
  });
  const consoleControllerItems = createConsoleControllerItems(matrix, {
    pluginMetaByName,
    locationReadModelByKey,
    configProjectionByPluginName,
  });
  const consoleItems = consoleControllerItems.map((item) => item.summary);
  const statusPageModels = consoleControllerItems.map((item) => createStatusPageModel(item));
  const friendlySummaries = buildFriendlySummaries(matrix, consoleItems);
  const jsonPayload: P7StatusJsonPayload & StatusJsonPayload = {
    ...createStatusJsonPayload({
      matrix,
      catalog,
      friendlySummaries,
      consoleItems,
    }),
    generatedAt: new Date().toISOString(),
    locations: [],
  };
  const statusLocations: P7StatusJsonPayload['locations'] = collected.locations.map((state, index) => {
    const installState = installStates[index]!;
    const locationNextSteps = nextStepsForCollectedLocation(state);
    const staleProjectReferences = state.dependencyIndexActions.filter((action) =>
      action.type === 'staleProjectReference');
    const dependencyIndexRecoveryMessage = state.projection.dependencyIndexCoverageTrusted
      ? null
      : state.projection.dependencyIndexRevisitProjectLocations.length > 0
        ? `请回到这些位置重新运行 status --verbose 或 repair：${state.projection.dependencyIndexRevisitProjectLocations
          .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
          .join('，')}。`
        : state.projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects'
          ? '请回到可能相关的仓库重新运行 status --verbose 或 repair。'
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
      ...createNextStepsBoundary(locationNextSteps, state.nextSteps),
      record: {
        present: state.evidence.installRecord.present,
        status: state.evidence.installRecord.read.status,
        path: state.evidence.installRecord.read.path,
        sourceDrift: state.evidence.installRecord.sourceDrift,
        sameBundleAsCatalog: state.evidence.installRecord.sameBundleAsCatalog,
        ...(state.evidence.installRecord.read.status === 'ok'
          ? {
              source: state.evidence.installRecord.read.value.record.source,
            }
          : {}),
      },
      currentCatalog: {
        provided: state.evidence.currentCatalog.provided,
        source: state.evidence.currentCatalog.source,
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
      legacyTracking: state.evidence.legacyTracking,
      historicalLifecycle: state.evidence.historicalLifecycle,
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
      dependencies: dependencyStatusByLocation[serializePluginLocation(normalizePluginLocation({
        plugin: state.location.plugin,
        platform: state.location.platform,
        scope: state.location.scope,
        projectKey: state.location.projectKey ?? null,
      }))] ?? {
        healthSource: 'none',
        declared: [],
        resolved: [],
        satisfied: [],
        missing: [],
        dependents: [],
        autoInstalled: false,
        autoRemovable: false,
        catalogDrift: {
          kind: 'none',
          snapshotDependencies: [],
          currentDependencies: [],
        },
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
      catalogLatestBlockedByCli: state.projection.catalogLatestBlockedByCli,
      upgradeAvailable: state.projection.upgradeAvailable,
      repairAvailable: state.projection.repairAvailable,
      cleanupAvailable: state.projection.cleanupAvailable,
      adoptExistingAvailable: state.projection.adoptExistingAvailable,
      findings: state.findings,
      issues: state.projection.issues,
      forceCleanup: state.forceCleanup,
      supplementalCommands: [],
      cleanup: {
        evaluated: false,
        available: false,
        forceRequired: false,
        blockingReasons: [],
        affectedDependents: [],
      },
      deepDiagnose: state.deepDiagnose,
    };
  });
  jsonPayload.locations = statusLocations;
  const output = options.json
    ? JSON.stringify(jsonPayload, null, 2)
    : options.verbose
      ? [
          renderCollectedStatusHumanOutput(collected.locations, { requestedPlugins }),
          '',
          '状态详情',
          renderDiagnoseHumanOutput(collected.locations),
        ].join('\n')
      : renderCollectedStatusHumanOutput(collected.locations, { requestedPlugins });
  return {
    catalog,
    reports: compatibilityReports,
    output,
    matrix,
    friendlySummaries,
    consoleItems,
    consoleControllerItems,
    statusPageModels,
    locationReadModelByKey,
    currentPluginByName,
    configProjectionByPluginName,
  };
}

const CONSOLE_SUMMARY_PRIORITY: Record<PluginConsoleStatus, number> = {
  abnormal: 4,
  upgradeAvailable: 3,
  installed: 2,
  notInstalled: 0,
};

export interface ConsoleItemsLoadResult {
  items: ConsoleControllerItem[];
  catalogUnavailable: boolean;
}

type StatusCommandResult = Awaited<ReturnType<typeof statusCommand>>;

function isConsoleCatalogUnavailable(base: StatusCommandResult): boolean {
  return base.matrix.cells.length > 0 &&
    base.matrix.cells.every((cell) => cell.report?.currentCatalog?.available !== true);
}

async function buildConsoleItemsFromStatusResult(options: {
  base: StatusCommandResult;
  rawOptions: RawStatusCommandOptions & { includeCatalogOnly?: boolean };
  normalizedOptions: ReturnType<typeof normalizeStatusCommandOptions>;
  runtimeWithSelector: StatusCommandRuntime;
}): Promise<ConsoleControllerItem[]> {
  const { base, rawOptions, normalizedOptions, runtimeWithSelector } = options;
  if (!rawOptions.includeCatalogOnly) {
    return base.consoleControllerItems;
  }

  const context = createCommandExecutionContext(runtimeWithSelector);
  const configStorePluginNames = await listPluginConfigStorePluginNames({
    cwd: normalizedOptions.cwd,
    env: context.env,
  });
  const candidates = base.catalog.reasonCode
    ? []
    : await buildCommandCandidates({
        command: 'status',
        cwd: normalizedOptions.cwd,
        scopeFilter: normalizedOptions.scope,
        platformFilter: normalizedOptions.platform,
        env: context.env,
        includeCatalogOnly: true,
      });
  const discoveredNames = new Set(base.consoleItems.map((item) => item.pluginName));
  const baseCellKeys = new Set(base.matrix.cells.map((cell) => createPluginConsoleLocationKey(cell)));
  const extraMatrix = createStatusMatrixFromCandidates({
    candidates,
    detection: base.matrix.detection,
    scope: normalizedOptions.scope,
    platform: normalizedOptions.platform,
  });
  const extraCells = extraMatrix.cells.filter((cell) => !baseCellKeys.has(createPluginConsoleLocationKey(cell)));
  const mergedMatrix: StatusMatrixReport = extraCells.length === 0
    ? base.matrix
    : {
        ...base.matrix,
        cells: sortCells([...base.matrix.cells, ...extraCells]),
      };
  const pluginMetaByName = {
    ...createPluginMetaByNameFromConsoleItems(base.consoleControllerItems),
    ...createPluginMetaByNameFromCandidates(candidates.filter((candidate) => !discoveredNames.has(candidate.pluginName))),
  };
  const currentPluginByName = {
    ...(base.currentPluginByName ?? {}),
    ...createCurrentPluginByNameFromCandidates(candidates),
  };
  const pluginNames = [...new Set([
    ...mergedMatrix.cells.map((cell) => cell.pluginName),
    ...configStorePluginNames,
  ])];
  const unresolvedConfigPluginNames = pluginNames
    .filter((pluginName) => !base.configProjectionByPluginName?.[pluginName]);
  const resolvedConfigProjectionByPluginName = await resolveConsoleConfigProjectionByPluginName({
    pluginNames: unresolvedConfigPluginNames,
    currentPluginByName,
    catalog: base.catalog,
    cwd: normalizedOptions.cwd,
    env: context.env,
  });
  const configProjectionByPluginName = {
    ...(base.configProjectionByPluginName ?? {}),
    ...resolvedConfigProjectionByPluginName,
  };
  const mergedItems = createConsoleControllerItems(mergedMatrix, {
    pluginMetaByName,
    locationReadModelByKey: base.locationReadModelByKey,
    configProjectionByPluginName,
  });
  const existingNames = new Set(mergedItems.map((item) => item.summary.pluginName));
  const legacyPlaceholderItems = pluginNames
    .filter((pluginName) => !existingNames.has(pluginName) && configProjectionByPluginName[pluginName])
    .map((pluginName) => createLegacyConfigPlaceholderControllerItem({
      pluginName,
      title: pluginMetaByName[pluginName]?.title,
      config: configProjectionByPluginName[pluginName]!,
    }));

  return [...mergedItems, ...legacyPlaceholderItems].sort((left, right) =>
    CONSOLE_SUMMARY_PRIORITY[right.summary.status] - CONSOLE_SUMMARY_PRIORITY[left.summary.status] ||
    left.summary.title.localeCompare(right.summary.title),
  );
}

export async function loadConsoleItemsResult(
  rawOptions: RawStatusCommandOptions & { includeCatalogOnly?: boolean } = {},
  runtime: StatusCommandRuntime = {},
): Promise<ConsoleItemsLoadResult> {
  const options = normalizeStatusCommandOptions(rawOptions);
  const runtimeWithSelector = {
    ...runtime,
    env: applyCatalogSelectorEnv(runtime.env ?? process.env, options),
  } satisfies StatusCommandRuntime;
  const base = await statusCommand([], {
    ...rawOptions,
    ...options,
  }, runtimeWithSelector);
  return {
    items: await buildConsoleItemsFromStatusResult({
      base,
      rawOptions,
      normalizedOptions: options,
      runtimeWithSelector,
    }),
    catalogUnavailable: isConsoleCatalogUnavailable(base),
  };
}

export async function loadConsoleItems(
  rawOptions: RawStatusCommandOptions & { includeCatalogOnly?: boolean } = {},
  runtime: StatusCommandRuntime = {},
): Promise<ConsoleControllerItem[]> {
  return (await loadConsoleItemsResult(rawOptions, runtime)).items;
}
