import path from 'node:path';

import fs from 'fs-extra';

import type {
  ConsoleIssueSummary,
  ConsoleLocationSummary,
  DiagnosePageModel,
  DiagnoseSupplementalCommand,
  PluginConsoleFeatureSummary,
  PluginConsoleStatus,
  PluginConsoleTone,
} from './console-model.js';
import {
  createPluginConsoleLocationKey,
} from './console-model.js';
import type {
  CleanupBlockingReason,
  CleanupLocationSummary,
  CleanupTargetPayload,
} from './cleanup.js';
import { cleanupCommand } from './cleanup.js';
import type { CommandExecutionContextInput } from './runtime.js';
import { createCommandExecutionContext } from './runtime.js';
import { buildCommandCandidates } from './discovery.js';
import type { DiscoveryEvidenceSummary } from './discovery.js';
import {
  normalizeStatusCommandOptions,
  type RawStatusCommandOptions,
} from './options.js';
import { detectEnvironment } from '../utils/detect.js';
import type {
  GeneratedArtifact,
  NextStepInstruction,
  PluginMeta,
  PlatformName,
  Scope,
  SkillTriggerPreference,
  StatusCommandOptions,
} from '../types.js';
import {
  createLegacyCommandNextStep,
  createNextStepsBoundary,
  createUiActionNextStep,
  formatNextStepForHuman,
} from '../output/model.js';
import type { PluginConsoleReasonCode } from '../install-state/types.js';
import type {
  CurrentCatalogArtifact,
  CurrentCatalogDynamicArtifact,
  CurrentCatalogEvidenceInput,
  InstallEvidence,
} from '../install-state/evidence.js';
import { collectInstallEvidence } from '../install-state/evidence.js';
import type {
  DependencyIndexReferenceInspection,
  DynamicArtifactDiagnosticEntry,
  PluginLocation,
} from '../install-state/types.js';
import { projectInstallState, type ProjectInstallStateProjection } from '../install-state/status-projection.js';
import { createDependencyIndexPruneToken } from '../install-state/transactions.js';
import { sha256Hex } from '../install-state/internal.js';
import { calculatePluginBundleFingerprint, calculateFileDigest } from '../utils/plugin-scripts.js';
import {
  createArtifactConfigDigest,
  validateArtifactPlan,
  type ValidatedArtifactPlanArtifact,
} from '../utils/artifact-plan.js';
import {
  resolveArtifactRenderConfig,
  resolveArtifactRendererTarget,
  runArtifactRenderer,
} from '../utils/artifact-renderer.js';
import { createGeneratedArtifactContentDigest } from '../utils/generated-artifacts.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
} from '../utils/codex-skill-staging.js';

export interface RawDiagnoseCommandOptions extends RawStatusCommandOptions {
  deep?: boolean;
}

export interface DiagnoseCommandOptions extends StatusCommandOptions {
  deep?: boolean;
}

interface InstallStateTarget {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  executionCwd: string;
  currentPlugin?: PluginMeta;
  historicalPlugin?: PluginMeta;
  historicalArtifacts?: GeneratedArtifact[];
  discoveryEvidence?: DiscoveryEvidenceSummary;
}

interface P7RuntimeOverrides {
  p7Targets?: InstallStateTarget[];
  p7Collect?: (options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    target: InstallStateTarget;
    deep: boolean;
  }) => Promise<CollectedLocationState>;
  p7ArtifactRendererRunner?: Parameters<typeof runArtifactRenderer>[0]['runner'];
}

export interface DependencyIndexReferenceAction {
  type: 'staleProjectReference' | 'unreadableProjectReference';
  location: PluginLocation;
  recordPath: string;
  token?: string;
  command?: string;
  error?: string;
}

export interface ForceCleanupBackupItem {
  path: string;
  reason: string;
}

export interface DeepDiagnoseResult {
  attempted: boolean;
  rendered: boolean;
  skippedReason?: 'noCurrentCatalog' | 'noRenderer' | 'catalogDrift';
  artifacts: Array<{
    id: string;
    target: string;
    state: string;
    artifactKey?: string;
    roleKey?: string;
    disabledReason?: string;
    configDigest: string;
    contentDigest: string;
    artifactPath?: string;
    triggerPreference?: SkillTriggerPreference;
    actualDigest?: string | null;
    drift: boolean;
    driftReasons?: string[];
    fileDiffs?: Array<{
      path: string;
      reason: 'missing' | 'unexpected' | 'contentMismatch';
    }>;
  }>;
}

export interface CollectedLocationState {
  target: InstallStateTarget;
  location: PluginLocation;
  evidence: InstallEvidence;
  projection: ProjectInstallStateProjection;
  currentCatalog: CurrentCatalogEvidenceInput | null;
  deepDiagnose: DeepDiagnoseResult;
  summary: string;
  nextSteps: string[];
  findings: string[];
  dependencyIndexActions: DependencyIndexReferenceAction[];
  forceCleanup: {
    required: boolean;
    backupItems: ForceCleanupBackupItem[];
  };
}

export interface StatusJsonLocation {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  summary: string;
  locationLabel: string;
  state: ProjectInstallStateProjection['kind'];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  record: {
    present: boolean;
    status: InstallEvidence['installRecord']['read']['status'];
    path: string;
    sourceDrift: boolean;
    sameBundleAsCatalog: boolean | null;
  };
  dynamicDiagnostic: {
    available: boolean;
    unavailableReason: string | null;
    unavailable: boolean;
    triggerPreference: SkillTriggerPreference | null;
    entries: DynamicArtifactDiagnosticEntry[];
  };
  legacyDynamicTracking: Array<{
    id: string;
    target: string;
    artifactKey?: string;
    roleKey?: string;
    path: string;
  }>;
  dependencyIndex: {
    status: InstallEvidence['dependencyIndex']['inspection']['status'];
    trusted: boolean;
    dependencyIndexTrusted: boolean;
    coverageTrusted: boolean;
    dependencyIndexCoverageReason: string[];
    reasons: string[];
    verifiedLocations: PluginLocation[];
    dependencyIndexVerifiedLocations: PluginLocation[];
    revisitProjectLocations: PluginLocation[];
    dependencyIndexRevisitLocations: PluginLocation[];
    recoverySuggestion: string | null;
    dependencyIndexRecoveryMessage: string | null;
    actions: DependencyIndexReferenceAction[];
    staleProjectReferences: DependencyIndexReferenceAction[];
  };
  dependents: PluginLocation[];
  autoInstalled: boolean;
  unusedDependencyHint: boolean;
  projectIdentity: {
    attempted: boolean;
    present: boolean;
    readStatus: InstallEvidence['projectSharedIdentity']['read'] extends infer T
      ? T extends { status: infer S }
        ? S
        : never
      : never;
    sourceDrift: boolean;
  };
  sharedOwner: {
    present: boolean;
    readStatus: InstallEvidence['sharedRuntimeOwner']['read']['status'];
    ownerMatchesTarget: boolean;
    ownerRecordDigestVerified: boolean;
    needsTakeover: boolean;
  };
  sharedSkillTriggerOwner: {
    present: boolean;
    readStatus: InstallEvidence['sharedRuntimeOwner']['read']['status'];
    ownerMatchesTarget: boolean;
    ownerRecordDigestVerified: boolean;
    needsTakeover: boolean;
    ownerConflict: boolean;
    suppressedOwnerConflict: boolean;
  };
  nativeState: {
    transactionPresent: boolean;
    transactionKind: ProjectInstallStateProjection['nativeTransactionKind'];
    codexNative: InstallEvidence['platform']['codexNative'];
  };
  nativeTransactionMarker: {
    present: boolean;
    status: ProjectInstallStateProjection['nativeTransactionKind'];
    recordCommitted: boolean;
    markerPending: boolean;
    needsAttention: boolean;
    repairCommand?: string;
    cleanupCommand?: string;
  };
  catalogDrift: boolean;
  upgradeAvailable: boolean;
  repairAvailable: boolean;
  cleanupAvailable: boolean;
  adoptExistingAvailable: boolean;
  findings: string[];
  issues: ProjectInstallStateProjection['issues'];
  forceCleanup: {
    required: boolean;
    backupItems: ForceCleanupBackupItem[];
  };
  supplementalCommands: DiagnoseSupplementalCommand[];
  cleanup: {
    evaluated: boolean;
    available: boolean;
    forceRequired: boolean;
    previewCommand?: string;
    executeCommand?: string;
    blockingReasons: CleanupBlockingReason[];
    affectedDependents: CleanupLocationSummary[];
  };
  deepDiagnose: DeepDiagnoseResult;
}

export interface StatusJsonPayload {
  ok: true;
  command: 'status';
  generatedAt: string;
  locations: StatusJsonLocation[];
}

export interface DiagnoseJsonPayload {
  ok: true;
  command: 'diagnose';
  generatedAt: string;
  deep: boolean;
  locations: StatusJsonLocation[];
  pageModels: DiagnosePageModel[];
}

interface DiagnosedCleanupPath {
  evaluated: boolean;
  available: boolean;
  forceRequired: boolean;
  previewCommand?: string;
  executeCommand?: string;
  blockingReasons: CleanupBlockingReason[];
  affectedDependents: CleanupLocationSummary[];
}

interface DiagnoseLocationPageInput {
  state: CollectedLocationState;
  cleanup: DiagnosedCleanupPath;
  supplementalCommands: DiagnoseSupplementalCommand[];
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function scopeLabel(scope: Scope): string {
  return scope === 'project' ? '当前项目' : '个人';
}

function locationLabel(location: Pick<PluginLocation, 'platform' | 'scope'>): string {
  return `${platformLabel(location.platform)}（${scopeLabel(location.scope)}）`;
}

function renderLocationArgs(location: PluginLocation, pluginName: string): string {
  return `${pluginName} -p ${location.platform} -s ${location.scope}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function cleanupLocationSummary(location: PluginLocation): CleanupLocationSummary {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
  };
}

function renderCleanupPlanCommand(location: PluginLocation, force = false): string {
  return `aw cleanup ${renderLocationArgs(location, location.plugin)} --plan${force ? ' --force' : ''}`;
}

function consoleStatusForLocation(state: CollectedLocationState): PluginConsoleStatus {
  if (state.projection.kind === 'installed') {
    return state.projection.upgradeAvailable ? 'upgradeAvailable' : 'installed';
  }
  if (state.projection.kind === 'notInstalled') {
    return 'notInstalled';
  }
  return 'abnormal';
}

function consoleStatusLabel(status: PluginConsoleStatus): string {
  switch (status) {
    case 'notInstalled':
      return '未安装';
    case 'installed':
      return '已安装';
    case 'upgradeAvailable':
      return '可升级';
    case 'abnormal':
      return '异常';
  }
}

function diagnoseStatusSymbol(status: PluginConsoleStatus): string {
  switch (status) {
    case 'abnormal':
      return '!';
    case 'upgradeAvailable':
      return '↑';
    case 'installed':
      return '✓';
    case 'notInstalled':
      return '○';
  }
}

function diagnoseStatusTone(status: PluginConsoleStatus): PluginConsoleTone {
  switch (status) {
    case 'abnormal':
      return 'danger';
    case 'upgradeAvailable':
      return 'info';
    case 'installed':
      return 'success';
    case 'notInstalled':
      return 'neutral';
  }
}

function consoleReasonLabel(reason: PluginConsoleReasonCode): string {
  switch (reason) {
    case 'duplicateInstall':
      return '重复安装';
    case 'missingRequiredConfig':
      return '配置缺失';
    case 'artifactRefreshFailed':
      return '内容刷新异常';
    case 'recordCorrupted':
      return '记录损坏';
    case 'nativeIncomplete':
      return '平台写入未完成';
    case 'adoptableInstall':
      return '可认领安装';
    case 'foreignOwnershipConflict':
      return '归属冲突';
    case 'residueDetected':
      return '残留待处理';
    case 'dependencyBlocked':
      return '依赖阻断';
  }
}

function consoleReasonSeverity(reason: PluginConsoleReasonCode): ConsoleIssueSummary['severity'] {
  switch (reason) {
    case 'adoptableInstall':
      return 'info';
    case 'missingRequiredConfig':
    case 'artifactRefreshFailed':
    case 'residueDetected':
    case 'dependencyBlocked':
      return 'warning';
    case 'duplicateInstall':
    case 'recordCorrupted':
    case 'nativeIncomplete':
    case 'foreignOwnershipConflict':
      return 'error';
  }
}

function featureSummary(
  kind: PluginConsoleFeatureSummary['kind'],
  options: {
    label?: string;
    destructive?: boolean;
    disabledReason?: string;
    targetSelection?: PluginConsoleFeatureSummary['targetSelection'];
  } = {},
): PluginConsoleFeatureSummary {
  const label = options.label ?? (() => {
    switch (kind) {
      case 'install':
        return '安装';
      case 'upgrade':
        return '升级';
      case 'configure':
        return '配置';
      case 'uninstall':
        return '卸载';
      case 'repair':
        return '修复安装';
      case 'cleanup':
        return '清理';
      case 'reinstall':
        return '重新安装';
      case 'adoptExisting':
        return '认领现有安装';
      case 'takeoverSharedRuntime':
        return '接管共享触发策略';
      case 'resolveDuplicateInstall':
        return '处理重复安装';
      case 'reapplyConfigRefresh':
        return '重新应用配置';
      case 'status':
        return '查看状态';
      case 'diagnose':
        return '查看诊断';
      case 'dependencies':
        return '依赖';
    }
  })();

  return {
    kind,
    label,
    targetSelection: options.targetSelection ?? (kind === 'status' || kind === 'diagnose' ? 'none' : 'singleTarget'),
    ...(options.destructive ? { destructive: true } : {}),
    ...(options.disabledReason ? { disabledReason: options.disabledReason } : {}),
  };
}

function dedupeFeatureSummaries(features: PluginConsoleFeatureSummary[]): PluginConsoleFeatureSummary[] {
  const deduped = new Map<string, PluginConsoleFeatureSummary>();
  for (const entry of features) {
    const key = [
      entry.kind,
      entry.label,
      entry.targetSelection,
      entry.disabledReason ?? '',
      entry.destructive === true ? 'yes' : 'no',
    ].join('\0');
    if (!deduped.has(key)) {
      deduped.set(key, entry);
    }
  }
  return [...deduped.values()];
}

function collectConsoleReasonCodes(state: CollectedLocationState): PluginConsoleReasonCode[] {
  const reasons = new Set<PluginConsoleReasonCode>();
  if (state.projection.kind === 'adoptable' || state.projection.adoptExistingAvailable) {
    reasons.add('adoptableInstall');
  }
  if (state.projection.kind === 'residual') {
    reasons.add('residueDetected');
  }
  if (state.projection.kind === 'externallyManaged') {
    reasons.add(state.projection.cleanupAvailable ? 'residueDetected' : 'foreignOwnershipConflict');
  }
  if (state.projection.kind === 'needsRepair') {
    reasons.add('recordCorrupted');
  }
  if (state.projection.sharedRuntimeNeedsTakeover && !shouldSuppressSharedOwnerConflict(state.location)) {
    reasons.add('foreignOwnershipConflict');
  }
  if (
    state.projection.nativeTransactionKind === 'recordInstallResidual' ||
    state.projection.nativeTransactionKind === 'markerOnlyInstall'
  ) {
    reasons.add('nativeIncomplete');
  }
  if (state.projection.nativeTransactionKind === 'markerOnlyUninstall') {
    reasons.add('residueDetected');
  }
  for (const issue of state.projection.issues) {
    switch (issue.code) {
      case 'dynamicRefreshFailed':
      case 'artifactMissing':
      case 'staticContentDrift':
      case 'dynamicContentDrift':
      case 'dynamicConfigStale':
      case 'historicalLifecycleUnavailable':
        reasons.add('artifactRefreshFailed');
        break;
      case 'projectSharedIdentityUnavailable':
      case 'installRecordInvalid':
        reasons.add('recordCorrupted');
        break;
      case 'nativeEvidenceMissing':
        reasons.add('nativeIncomplete');
        break;
      case 'dependencyMissing':
        reasons.add('dependencyBlocked');
        break;
    }
  }
  if (state.projection.dependents.length > 0) {
    reasons.add('dependencyBlocked');
  }
  if (hasAwNativeResidueDiscoveryEvidence(state.target) &&
    (state.projection.kind === 'notInstalled' || state.projection.kind === 'externallyManaged')) {
    reasons.add(state.projection.cleanupAvailable ? 'residueDetected' : 'foreignOwnershipConflict');
  }
  return [...reasons];
}

function shouldEvaluateCleanup(state: CollectedLocationState): boolean {
  return state.projection.kind === 'needsRepair' ||
    state.projection.kind === 'adoptable' ||
    state.projection.kind === 'residual' ||
    state.projection.kind === 'externallyManaged' ||
    state.forceCleanup.required ||
    state.projection.dependents.length > 0 ||
    hasAwNativeResidueDiscoveryEvidence(state.target);
}

function createSupplementalCommands(
  state: CollectedLocationState,
): DiagnoseSupplementalCommand[] {
  return state.dependencyIndexActions
    .filter((action) => action.command)
    .map((action) => ({
      command: action.command!,
      reason: action.type === 'staleProjectReference'
        ? '清理依赖索引里的过期项目引用。'
        : '处理无法读取的依赖索引项目引用。',
    }));
}

function toLocation(target: InstallStateTarget): PluginLocation {
  return {
    plugin: target.pluginName,
    platform: target.platform,
    scope: target.scope,
    ...(target.projectKey ? { projectKey: target.projectKey } : {}),
  };
}

function hasAwNativeResidueDiscoveryEvidence(target: InstallStateTarget): boolean {
  const sources = target.discoveryEvidence?.sources ?? [];
  return sources.includes('codexNativeConfig') ||
    sources.includes('codexNativeManifest') ||
    sources.includes('codexNativeCache') ||
    sources.includes('codexNativeRecovery') ||
    sources.includes('codexSharedNativeRef');
}

function isNativeResidueAttentionState(state: CollectedLocationState): boolean {
  return (
    (state.projection.kind === 'notInstalled' || state.projection.kind === 'externallyManaged') &&
    hasAwNativeResidueDiscoveryEvidence(state.target)
  );
}

function renderStateLabelForLocation(state: CollectedLocationState): string {
  return isNativeResidueAttentionState(state)
    ? '需要处理'
    : renderStateLabel(state.projection.kind);
}

function shouldSuppressSharedOwnerConflict(location: PluginLocation): boolean {
  return location.platform === 'codex' && location.scope === 'project';
}

function buildNativeTransactionMarkerSummary(
  location: PluginLocation,
  pluginName: string,
  projection: ProjectInstallStateProjection,
): StatusJsonLocation['nativeTransactionMarker'] {
  const args = renderLocationArgs(location, pluginName);
  const status = projection.nativeTransactionKind;
  const needsAttention = status !== 'none';
  return {
    present: projection.nativeTransactionPresent,
    status,
    recordCommitted: status === 'recordInstallResidual',
    markerPending: needsAttention,
    needsAttention,
    ...(needsAttention ? { repairCommand: `aw repair ${args}` } : {}),
    ...(needsAttention ? { cleanupCommand: `aw cleanup ${args}` } : {}),
  };
}

function buildDependencyIndexRecoveryMessage(
  projection: ProjectInstallStateProjection,
): string | null {
  if (projection.dependencyIndexCoverageTrusted) {
    return null;
  }
  if (projection.dependencyIndexRevisitProjectLocations.length > 0) {
    const revisit = projection.dependencyIndexRevisitProjectLocations
      .map((location) => `${location.plugin}:${location.projectKey ?? '.'}`)
      .join('，');
    return `请回到这些位置重新运行 status --verbose 或 repair：${revisit}。`;
  }
  if (projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects') {
    return '请回到可能相关的仓库重新运行 status --verbose 或 repair。';
  }
  return `依赖索引覆盖仍不完整：${projection.dependencyIndexCoverageReasons.join('、') || 'unknown'}。`;
}

function sanitizeDefaultStdout(text: string): string {
  return text
    .replaceAll('ledger', 'record')
    .replaceAll('tracking', 'state')
    .replaceAll('breadcrumb', 'marker')
    .replaceAll('snapshot', 'history')
    .replaceAll('degraded', 'unhealthy');
}

function normalizeDiagnoseCommandOptions(raw: RawDiagnoseCommandOptions = {}): DiagnoseCommandOptions {
  const normalized = normalizeStatusCommandOptions(raw);
  return {
    ...normalized,
    deep: raw.deep === true,
  };
}

async function discoverTargets(
  pluginNames: string[],
  options: DiagnoseCommandOptions,
  env: NodeJS.ProcessEnv,
  runtime: P7RuntimeOverrides,
): Promise<InstallStateTarget[]> {
  if (runtime.p7Targets) {
    return runtime.p7Targets;
  }

  const candidates = await buildCommandCandidates({
    command: 'status',
    cwd: options.cwd,
    scopeFilter: options.scope,
    platformFilter: options.platform,
    pluginNames: pluginNames.length > 0 ? pluginNames : undefined,
    env,
  });
  const seen = new Set<string>();
  const targets: InstallStateTarget[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.pluginName,
      candidate.platform,
      candidate.scope,
      candidate.projectKey ?? '',
    ].join('\0');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    targets.push({
      pluginName: candidate.pluginName,
      platform: candidate.platform,
      scope: candidate.scope,
      ...(candidate.projectKey ? { projectKey: candidate.projectKey } : {}),
      executionCwd: candidate.executionCwd,
      ...(candidate.target.currentPlugin ? { currentPlugin: candidate.target.currentPlugin } : {}),
      ...(candidate.target.source === 'historical'
        ? {
            historicalPlugin: candidate.target.plugin,
            ...(candidate.target.historicalArtifacts ? { historicalArtifacts: candidate.target.historicalArtifacts } : {}),
          }
        : {}),
      discoveryEvidence: candidate.evidence,
    });
  }
  return targets;
}

function createSourceCatalogArtifact(
  artifact: InstallEvidence['projectSharedIdentity']['artifacts'][number]['artifact'],
): CurrentCatalogArtifact {
  return {
    kind: artifact.kind,
    platform: artifact.platform,
    path: artifact.path,
    ...(artifact.paths ? { paths: artifact.paths } : {}),
    ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
    ...(artifact.id ? { id: artifact.id } : {}),
    ...(artifact.target ? { target: artifact.target } : {}),
    ...(artifact.roleKey ? { roleKey: artifact.roleKey } : {}),
    ...(artifact.ownershipMarker ? { ownershipMarker: artifact.ownershipMarker } : {}),
    ...(artifact.state ? { state: artifact.state } : {}),
    ...(artifact.contentDigest ? { contentDigest: artifact.contentDigest } : {}),
  };
}

async function buildDynamicCatalogArtifacts(
  plugin: PluginMeta,
  location: PluginLocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CurrentCatalogDynamicArtifact[]> {
  const target = await resolveArtifactRendererTarget(plugin);
  const renderConfig = await resolveArtifactRenderConfig({
    pluginName: plugin.manifest.name,
    manifest: plugin.manifest,
    scope: location.scope,
    cwd,
    env,
  });
  const digestSalt = target.rendererDigest ?? target.manifestDigest ?? await calculateFileDigest(plugin.manifestPath);
  return (plugin.manifest.artifacts?.targets ?? [])
    .filter((artifact) =>
      artifact.platform === location.platform
      && artifact.scopes.includes(location.scope),
    )
    .map((artifact) => ({
      id: artifact.id,
      target: artifact.target,
      state: artifact.states.includes('present') ? 'present' : artifact.states[0] ?? 'present',
      ...(artifact.roleKey
        ? {
            roleKey: artifact.roleKey,
            artifactKey: artifact.roleKey,
          }
        : {}),
      ...(artifact.target === 'codex.skill' && artifact.skillKey
        ? { artifactKey: artifact.skillKey }
        : {}),
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

async function buildCurrentCatalogSource(
  plugin: PluginMeta,
): Promise<CurrentCatalogEvidenceInput['source']> {
  return {
    pluginVersion: plugin.manifest.version,
    manifestDigest: await calculateFileDigest(plugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(plugin.rootDir),
  };
}

async function buildBaseCurrentCatalog(
  plugin: PluginMeta | undefined,
  location: PluginLocation,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<CurrentCatalogEvidenceInput | null> {
  if (!plugin) {
    return null;
  }
  return {
    source: await buildCurrentCatalogSource(plugin),
    artifacts: [],
    dynamicArtifacts: await buildDynamicCatalogArtifacts(plugin, location, cwd, env),
  };
}

function mapArtifactContentDigest(
  artifact: ValidatedArtifactPlanArtifact,
  preference: 'default' | 'manual' | 'auto',
): string {
  if (artifact.target === 'codex.skill') {
    return createCodexSkillStagingTreeContentDigest(createCodexSkillExpectedTree({
      artifact,
      preference,
    }));
  }

  if (artifact.state === 'present') {
    return createGeneratedArtifactContentDigest({
      target: artifact.target,
      state: artifact.state,
      ...(artifact.target === 'codex.developerInstructionsBlock'
        ? { content: artifact.content?.trim() }
        : { content: artifact.content }),
    });
  }
  return createGeneratedArtifactContentDigest({
    target: artifact.target,
    state: artifact.state,
    disabledReason: artifact.disabledReason ?? null,
  });
}

function mapActualArtifactDigest(
  matchedRecordArtifact: InstallEvidence['installRecord']['artifacts'][number] | undefined,
): string | null {
  if (!matchedRecordArtifact) {
    return null;
  }
  if (matchedRecordArtifact.artifact.target !== 'codex.skill') {
    return matchedRecordArtifact.files[0]?.contentDigest ?? null;
  }

  const rootPath = matchedRecordArtifact.artifact.path;
  const files = matchedRecordArtifact.files
    .filter((file) => file.path !== rootPath && file.exists && file.rawContent !== null)
    .map((file) => [
      path.relative(rootPath, file.path).split(path.sep).join('/'),
      file.rawContent,
    ] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return files.length > 0
    ? createGeneratedArtifactContentDigest(Object.fromEntries(files))
    : null;
}

async function collectSkillTreeFileContents(rootDir: string): Promise<Record<string, string>> {
  if (!(await fs.pathExists(rootDir))) {
    return {};
  }

  const output = new Map<string, string>();
  const visit = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      output.set(
        path.relative(rootDir, entryPath).split(path.sep).join('/'),
        await fs.readFile(entryPath, 'utf8'),
      );
    }
  };

  await visit(rootDir);
  return Object.fromEntries(output);
}

function diffSkillTrees(options: {
  expectedFiles: Record<string, string>;
  actualFiles: Record<string, string>;
}): {
  drift: boolean;
  driftReasons: string[];
  fileDiffs: Array<{
    path: string;
    reason: 'missing' | 'unexpected' | 'contentMismatch';
  }>;
} {
  const allPaths = [...new Set([
    ...Object.keys(options.expectedFiles),
    ...Object.keys(options.actualFiles),
  ])].sort();
  const fileDiffs: Array<{
    path: string;
    reason: 'missing' | 'unexpected' | 'contentMismatch';
  }> = [];
  const driftReasons: string[] = [];

  for (const relativePath of allPaths) {
    const expected = options.expectedFiles[relativePath];
    const actual = options.actualFiles[relativePath];
    if (expected === undefined) {
      fileDiffs.push({ path: relativePath, reason: 'unexpected' });
      driftReasons.push(`存在未受管文件 ${relativePath}`);
      continue;
    }
    if (actual === undefined) {
      fileDiffs.push({ path: relativePath, reason: 'missing' });
      driftReasons.push(`缺少文件 ${relativePath}`);
      continue;
    }
    if (actual !== expected) {
      fileDiffs.push({ path: relativePath, reason: 'contentMismatch' });
      driftReasons.push(`文件内容已漂移 ${relativePath}`);
    }
  }

  return {
    drift: fileDiffs.length > 0,
    driftReasons,
    fileDiffs,
  };
}

function collectLegacyDynamicTracking(
  evidence: InstallEvidence,
): StatusJsonLocation['legacyDynamicTracking'] {
  if (!evidence.currentCatalog.provided || evidence.installRecord.sameBundleAsCatalog !== true) {
    return [];
  }
  const legacyIds = new Set(['lightweight-instruction', 'codex-explorer-role']);

  return evidence.installRecord.artifacts
    .filter((artifact) =>
      artifact.artifact.id !== undefined &&
      artifact.artifact.target !== undefined &&
      legacyIds.has(artifact.artifact.id) &&
      !artifact.matchedCurrentDynamicArtifact)
    .map((artifact) => ({
      id: artifact.artifact.id!,
      target: artifact.artifact.target!,
      ...(artifact.artifact.artifactKey ? { artifactKey: artifact.artifact.artifactKey } : {}),
      ...(artifact.artifact.roleKey ? { roleKey: artifact.artifact.roleKey } : {}),
      path: artifact.artifact.path,
    }));
}

async function buildDeepDiagnoseResult(options: {
  currentPlugin: PluginMeta | undefined;
  location: PluginLocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  evidence: InstallEvidence;
  currentCatalog: CurrentCatalogEvidenceInput | null;
  runtime: P7RuntimeOverrides;
}): Promise<DeepDiagnoseResult> {
  const triggerPreference: SkillTriggerPreference = options.evidence.installRecord.read.status === 'ok'
    ? options.evidence.installRecord.read.value.record.options?.skillTriggerPreference ?? 'default'
    : 'default';
  if (!options.currentPlugin) {
    return {
      attempted: true,
      rendered: false,
      skippedReason: 'noCurrentCatalog',
      artifacts: [],
    };
  }
  if (!options.currentPlugin.manifest.scripts?.artifacts?.render) {
    return {
      attempted: true,
      rendered: false,
      skippedReason: 'noRenderer',
      artifacts: [],
    };
  }
  if (options.evidence.installRecord.sourceDrift || options.evidence.projectSharedIdentity.sourceDrift) {
    return {
      attempted: true,
      rendered: false,
      skippedReason: 'catalogDrift',
      artifacts: [],
    };
  }

  const result = await runArtifactRenderer({
    event: 'install',
    plugin: options.currentPlugin,
    platform: options.location.platform,
    scope: options.location.scope,
    cwd: options.cwd,
    commandEnv: options.env,
    runner: options.runtime.p7ArtifactRendererRunner,
  });
  const validated = validateArtifactPlan({
    pluginName: options.currentPlugin.manifest.name,
    manifest: options.currentPlugin.manifest,
    plan: result.plan,
    platform: options.location.platform,
    scope: options.location.scope,
    renderConfig: {
      values: result.context.config.values,
    },
    rendererDigest: result.target.rendererDigest,
    manifestDigest: result.target.manifestDigest,
  });

  const artifacts = await Promise.all(validated.artifacts.map(async (artifact) => {
    const matchedRecordArtifact = options.evidence.installRecord.artifacts.find((entry) =>
      entry.artifact.id === artifact.id
      && entry.artifact.target === artifact.target,
    );
    const contentDigest = mapArtifactContentDigest(
      artifact,
      triggerPreference,
    );
    let actualDigest = mapActualArtifactDigest(matchedRecordArtifact);
    let drift = actualDigest !== null && actualDigest !== contentDigest;
    let driftReasons: string[] = [];
    let fileDiffs: DeepDiagnoseResult['artifacts'][number]['fileDiffs'];

    if (artifact.target === 'codex.skill') {
      const actualFiles = matchedRecordArtifact
        ? await collectSkillTreeFileContents(matchedRecordArtifact.artifact.path)
        : {};
      actualDigest = Object.keys(actualFiles).length > 0
        ? createGeneratedArtifactContentDigest(actualFiles)
        : null;
      const comparison = diffSkillTrees({
        expectedFiles: createCodexSkillExpectedTree({
          artifact,
          preference: triggerPreference,
        }).files,
        actualFiles,
      });
      drift = comparison.drift;
      driftReasons = comparison.driftReasons;
      fileDiffs = comparison.fileDiffs;
    } else if (drift) {
      driftReasons = ['当前内容摘要与 renderer 输出不一致。'];
    }

    const roleKey = artifact.target === 'codex.agentRole' ? artifact.roleKey : undefined;

    return {
      id: artifact.id,
      target: artifact.target,
      state: artifact.state,
      ...(roleKey ? { roleKey } : {}),
      ...(artifact.target === 'codex.skill' && artifact.skillKey ? { artifactKey: artifact.skillKey } : {}),
      ...(artifact.state === 'disabled' && artifact.disabledReason
        ? { disabledReason: artifact.disabledReason }
        : {}),
      configDigest: artifact.configDigest,
      contentDigest,
      ...(matchedRecordArtifact?.files[0]?.path ? { artifactPath: matchedRecordArtifact.files[0].path } : {}),
      ...(artifact.target === 'codex.skill' ? { triggerPreference } : {}),
      actualDigest,
      drift,
      ...(driftReasons.length > 0 ? { driftReasons } : {}),
      ...(fileDiffs && fileDiffs.length > 0 ? { fileDiffs } : {}),
    };
  }));

  return {
    attempted: true,
    rendered: true,
    artifacts,
  };
}

async function collectWithDefaultEvidence(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  target: InstallStateTarget;
  deep: boolean;
  runtime: P7RuntimeOverrides;
}): Promise<CollectedLocationState> {
  const location = toLocation(options.target);
  let currentCatalog = await buildBaseCurrentCatalog(
    options.target.currentPlugin,
    location,
    options.cwd,
    options.env,
  );
  let evidence = await collectInstallEvidence({
    cwd: options.cwd,
    location,
    env: options.env,
    currentCatalog,
  });
  if (
    currentCatalog
    && evidence.projectSharedIdentity.read?.status === 'ok'
    && evidence.projectSharedIdentity.sourceDrift === false
  ) {
    currentCatalog = {
      ...currentCatalog,
      artifacts: evidence.projectSharedIdentity.artifacts.map((artifact) =>
        createSourceCatalogArtifact(artifact.artifact),
      ),
    };
    evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location,
      env: options.env,
      currentCatalog,
    });
  }

  const projection = projectInstallState(evidence);
  const dependencyIndexActions = await collectDependencyIndexActions(evidence);
  const forceCleanup = createForceCleanupHint(evidence, projection);
  const deepDiagnose = options.deep
    ? await buildDeepDiagnoseResult({
      currentPlugin: options.target.currentPlugin,
      location,
      cwd: options.cwd,
      env: options.env,
      evidence,
      currentCatalog,
      runtime: options.runtime,
    })
    : {
      attempted: false,
      rendered: false,
      artifacts: [],
    };
  const findings = createFindings({
    evidence,
    projection,
    dependencyIndexActions,
    deepDiagnose,
  });
  const summary = createSummaryText({
    evidence,
    projection,
    target: options.target,
  });
  const nextSteps = createNextSteps({
    location,
    pluginName: options.target.pluginName,
    projection,
    evidence,
    dependencyIndexActions,
    forceCleanup,
  });

  return {
    target: options.target,
    location,
    evidence,
    projection,
    currentCatalog,
    deepDiagnose,
    summary,
    nextSteps,
    findings,
    dependencyIndexActions,
    forceCleanup,
  };
}

async function collectDependencyIndexActions(
  evidence: InstallEvidence,
): Promise<DependencyIndexReferenceAction[]> {
  if (evidence.dependencyIndex.inspection.status !== 'ok') {
    return [];
  }
  const indexDigest = sha256Hex(await fs.readFile(evidence.dependencyIndex.inspection.path));
  const actions: DependencyIndexReferenceAction[] = [];
  for (const reference of evidence.dependencyIndex.inspection.references) {
    if (reference.status === 'staleCandidate') {
      const token = createDependencyIndexPruneToken({
        location: reference.location,
        recordPath: reference.recordPath,
        indexDigest,
      });
      actions.push({
        type: 'staleProjectReference',
        location: reference.location,
        recordPath: reference.recordPath,
        token,
        command: `aw cleanup --dependency-index --prune-stale ${token} --yes`,
      });
      continue;
    }
    if (reference.status === 'unreadableReference') {
      actions.push({
        type: 'unreadableProjectReference',
        location: reference.location,
        recordPath: reference.recordPath,
        ...(reference.error ? { error: reference.error } : {}),
      });
    }
  }
  return actions;
}

function createForceCleanupHint(
  evidence: InstallEvidence,
  projection: ProjectInstallStateProjection,
): {
  required: boolean;
  backupItems: ForceCleanupBackupItem[];
} {
  if (projection.installRecordPresent || projection.kind !== 'residual') {
    return {
      required: false,
      backupItems: [],
    };
  }
  const backupItems = evidence.projectSharedIdentity.artifacts
    .filter((artifact) => artifact.file.exists)
    .map((artifact) => ({
      path: artifact.file.path,
      reason: '缺少可用安装记录，执行 cleanup --force 前会先备份当前共享文件。',
    }));
  return {
    required: backupItems.length > 0,
    backupItems,
  };
}

function hasIssue(
  projection: ProjectInstallStateProjection,
  code: ProjectInstallStateProjection['issues'][number]['code'],
): boolean {
  return projection.issues.some((issue) => issue.code === code);
}

function createSummaryText(options: {
  evidence: InstallEvidence;
  projection: ProjectInstallStateProjection;
  target: InstallStateTarget;
}): string {
  const { evidence, projection, target } = options;
  const legacyDynamicTracking = collectLegacyDynamicTracking(evidence);
  const disabledCodexSkillEntries = evidence.dynamicDiagnostic.entries.filter((entry) =>
    entry.entry.target === 'codex.skill' && entry.entry.state === 'disabled');
  if (projection.nativeTransactionKind === 'recordInstallResidual') {
    return '安装记录还在，但原生安装收尾没有完成。';
  }
  if (projection.nativeTransactionKind === 'markerOnlyInstall' || projection.nativeTransactionKind === 'markerOnlyUninstall') {
    return '发现只剩原生残留标记，没有可继续依赖的安装记录。';
  }
  if (
    (projection.kind === 'notInstalled' || projection.kind === 'externallyManaged') &&
    hasAwNativeResidueDiscoveryEvidence(target)
  ) {
    return '检测到 Codex 原生残留。不要直接覆盖当前残留，先确认来源。';
  }
  if (projection.kind === 'installed' && projection.catalogDrift) {
    return '当前安装仍可识别，但目录里的插件版本已经变化，建议升级或重装。';
  }
  if (projection.kind === 'installed' && projection.dynamicDiagnosticUnavailable) {
    return '当前安装仍可识别，但只读模式下无法确认动态内容是否还和上次接受的一致。';
  }
  if (legacyDynamicTracking.length > 0) {
    return '检测到当前 manifest 已移除的历史 dynamic tracking；本轮不会在这里隐式迁移旧入口。';
  }
  if (hasIssue(projection, 'dynamicContentDrift')) {
    return '动态内容和上次接受的结果不一致。';
  }
  if (hasIssue(projection, 'dynamicConfigStale')) {
    return '共享配置已经变化，但动态内容还没刷新。';
  }
  if (hasIssue(projection, 'dynamicRefreshFailed')) {
    return '最近一次动态刷新失败，需要处理。';
  }
  if (hasIssue(projection, 'dependencyMissing')) {
    return '依赖链里有缺口，当前目标不能算健康。';
  }
  if (projection.kind === 'needsRepair') {
    return '当前安装可定位，但有异常需要收口。';
  }
  if (projection.kind === 'adoptable') {
    return '发现了一份可认领的已有项目安装。';
  }
  if (projection.kind === 'residual') {
    if (projection.dependents.length > 0) {
      return '发现残留文件或本机状态，但当前还有其它安装在依赖它，不能直接清理。';
    }
    return '发现残留文件或本机状态，建议清理后再继续。';
  }
  if (projection.kind === 'externallyManaged') {
    return '检测到外部安装痕迹，AW 不会把它当成本地已管理安装。';
  }
  if (projection.kind === 'notInstalled') {
    return '当前没有找到已安装记录。';
  }
  if (disabledCodexSkillEntries.length > 0) {
    return '当前安装状态正常，且 codex.skill 已按配置禁用。';
  }
  return evidence.installRecord.present ? '当前安装状态正常。' : '当前没有可处理的安装状态。';
}

function createDependencyCoverageFinding(projection: ProjectInstallStateProjection): string | null {
  if (projection.dependencyIndexCoverageTrusted) {
    return null;
  }
  const reasons = projection.dependencyIndexCoverageReasons.length > 0
    ? projection.dependencyIndexCoverageReasons.join('、')
    : 'coverageUntrusted';
  if (projection.dependencyIndexRevisitProjectLocations.length > 0) {
    const revisit = projection.dependencyIndexRevisitProjectLocations
      .map((location) => `${location.plugin}@${location.projectKey ?? scopeLabel(location.scope)}`)
      .join('、');
    return `依赖索引当前不可信（${reasons}）；请回到这些项目重新运行 status --verbose 或 repair：${revisit}。`;
  }
  if (projection.dependencyIndexRecoverySuggestion === 'revisitRelatedProjects') {
    return '依赖索引当前不可信，且还没有足够的已知项目位置可回访；请回到可能相关的仓库重新运行 status --verbose 或 repair。';
  }
  return `依赖索引当前不可信（${reasons}）。`;
}

function createFindings(options: {
  evidence: InstallEvidence;
  projection: ProjectInstallStateProjection;
  dependencyIndexActions: DependencyIndexReferenceAction[];
  deepDiagnose: DeepDiagnoseResult;
}): string[] {
  const { evidence, projection, dependencyIndexActions, deepDiagnose } = options;
  const findings: string[] = [];
  const legacyDynamicTracking = collectLegacyDynamicTracking(evidence);
  const codexSkillEntries = evidence.dynamicDiagnostic.entries
    .filter((entry) => entry.entry.target === 'codex.skill')
    .map((entry) => entry.entry);
  if (projection.nativeTransactionKind === 'recordInstallResidual') {
    findings.push('安装记录存在，且还保留着 install marker 残留。');
  } else if (projection.nativeTransactionKind === 'markerOnlyInstall' || projection.nativeTransactionKind === 'markerOnlyUninstall') {
    findings.push('只检测到原生 marker 残留，没有对应安装记录。');
  }
  if (projection.catalogDrift) {
    findings.push('当前目录里的插件来源已经变化；这更像升级提示，不当作文件损坏。');
  }
  if (projection.dynamicDiagnosticUnavailable) {
    findings.push('动态诊断信息目前不可用；只读模式不会补写本地诊断数据。');
    for (const entry of codexSkillEntries) {
      findings.push(`codex.skill "${entry.artifactKey ?? entry.id}" 的诊断缓存目前不可用。`);
    }
  }
  if (hasIssue(projection, 'dynamicContentDrift')) {
    findings.push('动态内容与已接受摘要不一致。');
    for (const entry of codexSkillEntries) {
      findings.push(`codex.skill "${entry.artifactKey ?? entry.id}" 的运行时内容与诊断缓存记录不一致。`);
    }
  }
  if (hasIssue(projection, 'dynamicConfigStale')) {
    findings.push('共享渲染配置摘要已经变化，当前内容还没刷新。');
    for (const entry of codexSkillEntries) {
      findings.push(`codex.skill "${entry.artifactKey ?? entry.id}" 的配置摘要已经过期。`);
    }
  }
  if (hasIssue(projection, 'dynamicRefreshFailed')) {
    const failed = projection.issues.find((issue) => issue.code === 'dynamicRefreshFailed');
    findings.push(
      failed?.detail
        ? `最近一次动态刷新失败：${failed.detail}`
        : '最近一次动态刷新失败。',
    );
    for (const entry of codexSkillEntries.filter((current) => current.lastRefresh?.status === 'failed')) {
      findings.push(
        entry.lastRefresh?.error
          ? `codex.skill "${entry.artifactKey ?? entry.id}" 最近一次刷新失败：${entry.lastRefresh.error}`
          : `codex.skill "${entry.artifactKey ?? entry.id}" 最近一次刷新失败。`,
      );
    }
  }
  if (hasIssue(projection, 'artifactMissing')) {
    findings.push('记录里的目标文件有缺失。');
    for (const artifact of evidence.installRecord.artifacts.filter((recordArtifact) =>
      recordArtifact.artifact.target === 'codex.skill' &&
      recordArtifact.files.some((file) => !file.exists))) {
      findings.push(`codex.skill "${artifact.artifact.artifactKey ?? artifact.artifact.id}" 缺少运行时文件。`);
    }
  }
  if (hasIssue(projection, 'historicalLifecycleUnavailable')) {
    findings.push('历史 lifecycle runtime 不完整。');
  }
  if (hasIssue(projection, 'dependencyMissing')) {
    const dependencies = projection.issues
      .filter((issue) => issue.code === 'dependencyMissing')
      .map((issue) => issue.dependency?.plugin)
      .filter((value): value is string => Boolean(value));
    findings.push(`依赖边仍指向缺失或不健康的位置：${uniqueStrings(dependencies).join('、')}。`);
  }
  if (projection.sharedRuntimeNeedsTakeover && !shouldSuppressSharedOwnerConflict(evidence.location)) {
    findings.push('共享 skill trigger owner 指向了别的位置。');
  }
  if (projection.autoInstalled && projection.unusedDependencyHint) {
    findings.push('这个目标是自动装上的依赖，现在看起来已经没人再依赖它了。');
  }
  const coverageFinding = createDependencyCoverageFinding(projection);
  if (coverageFinding) {
    findings.push(coverageFinding);
  }
  for (const action of dependencyIndexActions) {
    if (action.type === 'staleProjectReference') {
      findings.push(`依赖索引里有可修剪的过期项目引用：${action.location.plugin}。`);
    } else {
      findings.push(`依赖索引里有无法读取的项目引用：${action.location.plugin}。`);
    }
  }
  if (evidence.adoptable.possible) {
    findings.push('项目文件与共享身份可以对齐，具备认领条件。');
  }
  for (const entry of codexSkillEntries.filter((current) => current.state === 'disabled')) {
    findings.push(`codex.skill "${entry.artifactKey ?? entry.id}" 当前按配置禁用。`);
  }
  if (legacyDynamicTracking.length > 0) {
    findings.push(
      `检测到当前 manifest 已移除的历史 dynamic tracking：${legacyDynamicTracking
        .map((entry) => `${entry.id}(${entry.target})`)
        .join('、')}。本轮不会在 status --verbose / repair / cleanup 中隐式迁移这些旧入口。`,
    );
  }
  if (deepDiagnose.attempted && deepDiagnose.rendered) {
    const drifted = deepDiagnose.artifacts.filter((artifact) => artifact.drift);
    if (drifted.length > 0) {
      findings.push(`deep 诊断下发现 ${drifted.length} 个动态内容与当前 renderer 结果不一致。`);
      for (const artifact of drifted) {
        if (artifact.target === 'codex.skill' && artifact.driftReasons?.length) {
          findings.push(
            `deep 诊断显示 codex.skill "${artifact.artifactKey ?? artifact.id}" 与当前 expected tree 不一致：${artifact.driftReasons.join('；')}`,
          );
        }
      }
    }
  } else if (deepDiagnose.attempted && deepDiagnose.skippedReason === 'catalogDrift') {
    findings.push('deep 诊断跳过了跨版本内容比对，因为当前目录来源已经变化。');
  }
  return uniqueStrings(findings);
}

function createNextSteps(options: {
  location: PluginLocation;
  pluginName: string;
  projection: ProjectInstallStateProjection;
  evidence: InstallEvidence;
  dependencyIndexActions: DependencyIndexReferenceAction[];
  forceCleanup: {
    required: boolean;
    backupItems: ForceCleanupBackupItem[];
  };
}): string[] {
  const { location, pluginName, projection, dependencyIndexActions, forceCleanup } = options;
  const args = renderLocationArgs(location, pluginName);
  const steps: string[] = [];
  if (projection.nativeTransactionKind === 'recordInstallResidual') {
    steps.push(`aw repair ${args}`);
    steps.push(`aw cleanup ${args}`);
  } else if (projection.nativeTransactionKind === 'markerOnlyInstall' || projection.nativeTransactionKind === 'markerOnlyUninstall') {
    steps.push(`aw cleanup ${args}`);
  } else if (projection.kind === 'needsRepair') {
    if (projection.repairAvailable) {
      steps.push(`aw repair ${args}`);
    }
    if (projection.cleanupAvailable) {
      steps.push(`aw cleanup ${args}`);
    }
  } else if (projection.kind === 'adoptable') {
    steps.push(`aw repair ${args} --adopt-existing`);
    steps.push(`aw status ${args} --verbose`);
  } else if (projection.kind === 'residual' && projection.cleanupAvailable) {
    steps.push(`aw cleanup ${args}`);
  } else if (projection.kind === 'externallyManaged' && projection.cleanupAvailable) {
    steps.push(`aw cleanup ${args}`);
  } else if (projection.kind === 'installed' && projection.catalogDrift) {
    steps.push(`aw upgrade ${args}`);
    steps.push(`aw reinstall ${args}`);
  } else if (projection.kind === 'installed' && projection.dynamicDiagnosticUnavailable) {
    steps.push(`aw status ${args} --verbose`);
  } else if (projection.kind === 'notInstalled') {
    steps.push(`aw install ${args}`);
  }
  if (forceCleanup.required) {
    steps.push(`aw cleanup ${args} --plan --force`);
    steps.push(`aw cleanup ${args} --force`);
  }
  for (const action of dependencyIndexActions) {
    if (action.command) {
      steps.push(action.command);
    }
  }
  return uniqueStrings(steps);
}

function nextStepFromLegacyCommand(step: string): NextStepInstruction {
  if (step.startsWith('aw cleanup ')) {
    return createUiActionNextStep(
      '清理残留',
      '会进入 cleanup 流程，评估并清理当前残留状态。',
      'runCleanup',
      step,
    );
  }
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
  if (step.startsWith('aw upgrade ')) {
    return createUiActionNextStep(
      '升级插件',
      '会进入升级流程，让当前安装重新对齐最新版本和能力。',
      'runUpgrade',
      step,
    );
  }
  if (step.startsWith('aw reinstall ')) {
    return createUiActionNextStep(
      '重新安装',
      '会进入重新安装流程，先收口当前状态，再按最新版本重新写入。',
      'runReinstall',
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
  if (step.startsWith('aw status ')) {
    return createUiActionNextStep(
      '查看详细状态',
      '可以查看安装证据、残留和可恢复动作。',
      'openStatus',
      step,
    );
  }
  return createLegacyCommandNextStep(step, {
    label: '继续处理',
    description: '可以进入下一步处理流程。',
  });
}

function nextStepsBoundaryFromLegacy(steps: string[]) {
  return createNextStepsBoundary(steps.map(nextStepFromLegacyCommand), steps);
}

async function evaluateCleanupPath(
  state: CollectedLocationState,
  runtime: CommandExecutionContextInput,
): Promise<DiagnosedCleanupPath> {
  if (!shouldEvaluateCleanup(state)) {
    return {
      evaluated: false,
      available: false,
      forceRequired: false,
      blockingReasons: [],
      affectedDependents: state.projection.dependents.map((location) => cleanupLocationSummary(location)),
    };
  }

  const baseResult = await cleanupCommand(
    [state.location.plugin],
    {
      cwd: state.target.executionCwd,
      platform: state.location.platform,
      scope: state.location.scope,
      plan: true,
    },
    runtime,
  );
  if (baseResult.payload.dependencyIndex) {
    return {
      evaluated: true,
      available: false,
      forceRequired: false,
      blockingReasons: [],
      affectedDependents: [],
    };
  }

  const basePayload = baseResult.payload as CleanupTargetPayload;
  const forceRequired = basePayload.blockingReasons.some((reason) =>
    reason.code === 'forceRequired' || reason.code === 'verifiedDependents');
  if (forceRequired) {
    const forcePreviewResult = await cleanupCommand(
      [state.location.plugin],
      {
        cwd: state.target.executionCwd,
        platform: state.location.platform,
        scope: state.location.scope,
        plan: true,
        force: true,
      },
      runtime,
    );
    const forcePayload = forcePreviewResult.payload as CleanupTargetPayload;
    return {
      evaluated: true,
      available: forcePayload.blockingReasons.length === 0,
      forceRequired: true,
      previewCommand: basePayload.recommendedCommand,
      ...(forcePayload.blockingReasons.length === 0 ? { executeCommand: forcePayload.recommendedCommand } : {}),
      blockingReasons: forcePayload.blockingReasons,
      affectedDependents: forcePayload.affectedDependents,
    };
  }

  return {
    evaluated: true,
    available: basePayload.blockingReasons.length === 0,
    forceRequired: false,
    previewCommand: renderCleanupPlanCommand(state.location),
    ...(basePayload.blockingReasons.length === 0 ? { executeCommand: basePayload.recommendedCommand } : {}),
    blockingReasons: basePayload.blockingReasons,
    affectedDependents: basePayload.affectedDependents,
  };
}

function cleanupIssueSummary(
  reason: CleanupBlockingReason,
  cleanup: DiagnosedCleanupPath,
): ConsoleIssueSummary {
  const details = uniqueStrings([
    ...(reason.suggestedCommand ? [`建议命令：${reason.suggestedCommand}`] : []),
    ...(cleanup.affectedDependents.length > 0
      ? [`已知冲突面：${cleanup.affectedDependents.map((dependent) => dependent.plugin).join('、')}`]
      : []),
    ...(reason.code === 'foreignOwnershipConflict'
      ? ['当前现场存在无法安全证明归属的内容，需要人工确认后再处理。']
      : []),
  ]);

  return {
    code: reason.code,
    label: reason.code,
    severity: 'error',
    summary: reason.message,
    suggestedFeatures: reason.code === 'duplicateInstall'
      ? [featureSummary('adoptExisting')]
      : reason.code === 'foreignOwnershipConflict'
        ? [featureSummary('diagnose')]
        : [featureSummary('cleanup', {
            label: cleanup.forceRequired ? '查看清理预览' : '清理',
            destructive: cleanup.executeCommand !== undefined,
          })],
    ...(details.length > 0 ? { details } : {}),
  };
}

function diagnoseIssueSummary(
  state: CollectedLocationState,
  reason: PluginConsoleReasonCode,
  cleanup: DiagnosedCleanupPath,
): ConsoleIssueSummary {
  const suggestedFeatures: PluginConsoleFeatureSummary[] = [];
  switch (reason) {
    case 'adoptableInstall':
      suggestedFeatures.push(featureSummary('adoptExisting'));
      break;
    case 'artifactRefreshFailed':
      suggestedFeatures.push(featureSummary('repair'));
      if (state.projection.issues.some((issue) => issue.code === 'dynamicRefreshFailed')) {
        suggestedFeatures.push(featureSummary('reapplyConfigRefresh'));
      }
      break;
    case 'recordCorrupted':
    case 'nativeIncomplete':
      suggestedFeatures.push(featureSummary('repair'));
      break;
    case 'duplicateInstall':
      suggestedFeatures.push(featureSummary('resolveDuplicateInstall', {
        label: '处理重复安装',
        destructive: true,
      }));
      break;
    case 'dependencyBlocked':
      suggestedFeatures.push(featureSummary('repair'));
      break;
    case 'missingRequiredConfig':
      suggestedFeatures.push(featureSummary('configure'));
      break;
    case 'foreignOwnershipConflict':
      if (state.projection.sharedRuntimeNeedsTakeover && !shouldSuppressSharedOwnerConflict(state.location)) {
        suggestedFeatures.push(featureSummary('takeoverSharedRuntime'));
      }
      break;
    case 'residueDetected':
      break;
  }
  if (cleanup.evaluated) {
    suggestedFeatures.push(featureSummary('cleanup', {
      label: cleanup.forceRequired ? '查看清理预览' : '清理',
      destructive: cleanup.executeCommand !== undefined,
      ...(cleanup.available || cleanup.previewCommand
        ? {}
        : { disabledReason: cleanup.blockingReasons[0]?.message }),
    }));
  }

  return {
    code: reason,
    label: consoleReasonLabel(reason),
    severity: consoleReasonSeverity(reason),
    summary: state.summary,
    suggestedFeatures: dedupeFeatureSummaries(suggestedFeatures),
    ...(state.findings.length > 0 ? { details: state.findings.slice(0, 4) } : {}),
  };
}

function createDiagnoseLocationSummary(
  input: DiagnoseLocationPageInput,
): ConsoleLocationSummary {
  const reasonCodes = collectConsoleReasonCodes(input.state);
  const issues = [
    ...reasonCodes.map((reason) => diagnoseIssueSummary(input.state, reason, input.cleanup)),
    ...input.cleanup.blockingReasons.map((reason) => cleanupIssueSummary(reason, input.cleanup)),
  ];
  const suggestedFeatures = dedupeFeatureSummaries([
    ...issues.flatMap((issue) => issue.suggestedFeatures),
    featureSummary('diagnose'),
  ]);

  const status = consoleStatusForLocation(input.state);
  return {
    key: createPluginConsoleLocationKey({
      pluginName: input.state.location.plugin,
      platform: input.state.location.platform,
      scope: input.state.location.scope,
      ...(input.state.location.projectKey ? { projectKey: input.state.location.projectKey } : {}),
    }),
    platform: input.state.location.platform,
    scope: input.state.location.scope,
    ...(input.state.location.projectKey ? { projectKey: input.state.location.projectKey } : {}),
    label: locationLabel(input.state.location),
    status,
    statusLabel: consoleStatusLabel(status),
    statusSymbol: diagnoseStatusSymbol(status),
    statusTone: diagnoseStatusTone(status),
    hasEvidence: true,
    summary: input.state.summary,
    ...(issues[0] ? { issue: issues[0] } : {}),
    issues,
    suggestedFeatures,
    ...nextStepsBoundaryFromLegacy(uniqueStrings([
      ...input.state.nextSteps,
      ...(input.cleanup.previewCommand ? [input.cleanup.previewCommand] : []),
      ...(input.cleanup.executeCommand ? [input.cleanup.executeCommand] : []),
    ])),
    diagnostics: input.state.findings.map((finding) => ({
      label: '说明',
      value: finding,
      tone: 'info' as const,
    })),
  };
}

function createDiagnosePageModels(
  inputs: DiagnoseLocationPageInput[],
): DiagnosePageModel[] {
  const byPlugin = new Map<string, DiagnoseLocationPageInput[]>();
  for (const input of inputs) {
    byPlugin.set(input.state.location.plugin, [...(byPlugin.get(input.state.location.plugin) ?? []), input]);
  }

  return [...byPlugin.entries()].map(([pluginName, entries]) => {
    const locations = entries.map((entry) => createDiagnoseLocationSummary(entry));
    const issueMap = new Map<string, ConsoleIssueSummary>();
    for (const issue of locations.flatMap((location) => location.issues)) {
      const key = [issue.code, issue.summary].join('\0');
      if (!issueMap.has(key)) {
        issueMap.set(key, issue);
      }
    }
    const commandMap = new Map<string, DiagnoseSupplementalCommand>();
    for (const command of entries.flatMap((entry) => entry.supplementalCommands)) {
      if (!commandMap.has(command.command)) {
        commandMap.set(command.command, command);
      }
    }
    const issues = [...issueMap.values()];
    const supplementalCommands = [...commandMap.values()];
    const conclusion = uniqueStrings(entries.map((entry) => entry.state.summary))[0]
      ?? '当前没有需要额外处理的诊断结论。';

    return {
      pluginName,
      conclusion,
      issues,
      locations,
      supplementalCommands,
    };
  });
}

function toStatusJsonLocation(
  state: CollectedLocationState,
  options: {
    supplementalCommands: DiagnoseSupplementalCommand[];
    cleanup: DiagnosedCleanupPath;
  },
): StatusJsonLocation {
  const suppressOwnerConflict = shouldSuppressSharedOwnerConflict(state.location);
  const staleProjectReferences = state.dependencyIndexActions.filter((action) =>
    action.type === 'staleProjectReference');
  const sharedOwnerNeedsTakeover = suppressOwnerConflict
    ? false
    : state.evidence.sharedRuntimeOwner.needsTakeover;
  const dependencyIndexRecoveryMessage = buildDependencyIndexRecoveryMessage(state.projection);

  return {
    plugin: state.location.plugin,
    platform: state.location.platform,
    scope: state.location.scope,
    ...(state.location.projectKey ? { projectKey: state.location.projectKey } : {}),
    summary: state.summary,
    locationLabel: locationLabel(state.location),
    state: state.projection.kind,
    ...nextStepsBoundaryFromLegacy(state.nextSteps),
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
    legacyDynamicTracking: collectLegacyDynamicTracking(state.evidence),
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
      needsTakeover: sharedOwnerNeedsTakeover,
    },
    sharedSkillTriggerOwner: {
      present: state.evidence.sharedRuntimeOwner.read.status === 'ok',
      readStatus: state.evidence.sharedRuntimeOwner.read.status,
      ownerMatchesTarget: state.evidence.sharedRuntimeOwner.ownerMatchesTarget,
      ownerRecordDigestVerified: state.evidence.sharedRuntimeOwner.ownerRecordDigestVerified,
      needsTakeover: sharedOwnerNeedsTakeover,
      ownerConflict: sharedOwnerNeedsTakeover,
      suppressedOwnerConflict: suppressOwnerConflict && state.evidence.sharedRuntimeOwner.needsTakeover,
    },
    nativeState: {
      transactionPresent: state.projection.nativeTransactionPresent,
      transactionKind: state.projection.nativeTransactionKind,
      codexNative: state.evidence.platform.codexNative,
    },
    nativeTransactionMarker: buildNativeTransactionMarkerSummary(
      state.location,
      state.location.plugin,
      state.projection,
    ),
    catalogDrift: state.projection.catalogDrift,
    upgradeAvailable: state.projection.upgradeAvailable,
    repairAvailable: state.projection.repairAvailable,
    cleanupAvailable: state.projection.cleanupAvailable,
    adoptExistingAvailable: state.projection.adoptExistingAvailable,
    findings: state.findings,
    issues: state.projection.issues,
    forceCleanup: state.forceCleanup,
    supplementalCommands: options.supplementalCommands,
    cleanup: {
      evaluated: options.cleanup.evaluated,
      available: options.cleanup.available,
      forceRequired: options.cleanup.forceRequired,
      ...(options.cleanup.previewCommand ? { previewCommand: options.cleanup.previewCommand } : {}),
      ...(options.cleanup.executeCommand ? { executeCommand: options.cleanup.executeCommand } : {}),
      blockingReasons: options.cleanup.blockingReasons,
      affectedDependents: options.cleanup.affectedDependents,
    },
    deepDiagnose: state.deepDiagnose,
  };
}

export async function collectP7Locations(
  pluginNames: string[],
  rawOptions: RawDiagnoseCommandOptions,
  runtime: CommandExecutionContextInput = {},
): Promise<{
  detection: Awaited<ReturnType<typeof detectEnvironment>>;
  options: DiagnoseCommandOptions;
  locations: CollectedLocationState[];
}> {
  const options = normalizeDiagnoseCommandOptions(rawOptions);
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const overrides = runtime as CommandExecutionContextInput & P7RuntimeOverrides;
  const targets = await discoverTargets(pluginNames, options, env, overrides);
  const locations = await Promise.all(targets.map((target) =>
    overrides.p7Collect
      ? overrides.p7Collect({
        cwd: options.cwd,
        env,
        target,
        deep: options.deep === true,
      })
      : collectWithDefaultEvidence({
        cwd: options.cwd,
        env,
        target,
        deep: options.deep === true,
        runtime: overrides,
      })
  ));
  return {
    detection: await detectEnvironment(options.cwd, env),
    options,
    locations,
  };
}

export function renderStatusHumanOutput(
  locations: CollectedLocationState[],
): string {
  const lines = ['插件状态'];
  for (const state of locations) {
    lines.push(`- ${state.location.plugin}`);
    lines.push(`  状态：${renderStateLabelForLocation(state)}`);
    lines.push(`  位置：${locationLabel(state.location)}`);
    lines.push(`  摘要：${state.summary}`);
    if (state.nextSteps.length > 0) {
      lines.push(`  下一步：${state.nextSteps.join('；')}`);
    }
  }
  return sanitizeDefaultStdout(lines.join('\n'));
}

export function renderDiagnoseHumanOutput(
  locations: CollectedLocationState[],
): string {
  const lines = ['诊断结果'];
  for (const state of locations) {
    lines.push(`- ${state.location.plugin}`);
    lines.push(`  结论：${renderStateLabelForLocation(state)}`);
    lines.push(`  位置：${locationLabel(state.location)}`);
    lines.push(`  摘要：${state.summary}`);
    if (state.findings.length > 0) {
      lines.push('  发现：');
      for (const finding of state.findings) {
        lines.push(`  - ${finding}`);
      }
    }
    if (state.dependencyIndexActions.length > 0) {
      lines.push('  依赖索引：');
      for (const action of state.dependencyIndexActions) {
        if (action.type === 'staleProjectReference') {
          lines.push(`  - 发现可修剪的过期项目引用：${action.location.plugin}`);
          if (action.token) {
            lines.push(`    prune token：${action.token}`);
          }
          if (action.command) {
            lines.push(`    清理命令：${action.command}`);
          }
          continue;
        }
        lines.push(`  - 发现无法读取的项目引用：${action.location.plugin}${action.error ? `（${action.error}）` : ''}`);
      }
    }
    lines.push(`  可执行操作：repair=${state.projection.repairAvailable ? 'yes' : 'no'}，cleanup=${state.projection.cleanupAvailable ? 'yes' : 'no'}${state.forceCleanup.required ? '，cleanup --force=needed' : ''}`);
    if (state.projection.cleanupAvailable) {
      lines.push('  提醒：cleanup 不会执行 uninstall lifecycle。');
    }
    if (state.forceCleanup.required && state.forceCleanup.backupItems.length > 0) {
      lines.push('  cleanup --force 备份范围：');
      for (const item of state.forceCleanup.backupItems) {
        lines.push(`  - ${item.path}：${item.reason}`);
      }
    }
    if (state.nextSteps.length > 0) {
      lines.push(`  下一步：${state.nextSteps.join('；')}`);
    }
  }
  return sanitizeDefaultStdout(lines.join('\n'));
}

function renderStateLabel(kind: ProjectInstallStateProjection['kind']): string {
  switch (kind) {
    case 'installed':
      return '已安装';
    case 'needsRepair':
      return '需要处理';
    case 'adoptable':
      return '可认领';
    case 'residual':
      return '有残留';
    case 'externallyManaged':
      return '外部管理';
    case 'notInstalled':
      return '未安装';
    default:
      return kind;
  }
}

function renderJsonDetails(label: string, payload: unknown, prefix: string): string {
  return `${label}\n${prefix}${JSON.stringify(payload, null, 2)}`;
}

export async function diagnoseCommand(
  pluginNames: string[],
  rawOptions: RawDiagnoseCommandOptions,
  runtime: CommandExecutionContextInput = {},
): Promise<{
  output: string;
  payload: DiagnoseJsonPayload;
  pageModels: DiagnosePageModel[];
}> {
  const collected = await collectP7Locations(pluginNames, rawOptions, runtime);
  const locationInputs = await Promise.all(collected.locations.map(async (state) => {
    const supplementalCommands = createSupplementalCommands(state);
    const cleanup = await evaluateCleanupPath(state, runtime);
    return {
      state,
      cleanup,
      supplementalCommands,
    } satisfies DiagnoseLocationPageInput;
  }));
  const pageModels = createDiagnosePageModels(locationInputs);
  const payload: DiagnoseJsonPayload = {
    ok: true,
    command: 'diagnose',
    generatedAt: new Date().toISOString(),
    deep: collected.options.deep === true,
    locations: locationInputs.map((input) => toStatusJsonLocation(input.state, {
      supplementalCommands: input.supplementalCommands,
      cleanup: input.cleanup,
    })),
    pageModels,
  };
  const output = collected.options.json
    ? JSON.stringify(payload, null, 2)
    : collected.options.verbose
      ? `${renderDiagnoseHumanOutput(collected.locations)}\n\n${renderJsonDetails('详细信息', payload, '')}`
      : renderDiagnoseHumanOutput(collected.locations);
  return {
    output,
    payload,
    pageModels,
  };
}
