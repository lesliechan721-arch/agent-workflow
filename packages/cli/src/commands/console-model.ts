import type { StatusMatrixCell, StatusMatrixReport } from './status.js';
import type {
  PluginConsoleReasonCode,
  PluginConsoleStatus,
} from '../install-state/types.js';
import type {
  ConfigSchemaEvidenceV2,
  ConfigFieldEntryV2,
  GeneratedArtifactSessionVisibility,
  LegacyConfigStoreEntryV2,
  ManagedArtifactStatus,
  NextStepInstruction,
  PlatformName,
  PluginMeta,
  PluginStatusReport,
  RepoManagedProjectItemReport,
  RepoManagedProjectItemState,
  Scope,
} from '../types.js';
import {
  createManualNextStep,
  createNextStepsBoundary,
  dedupeNextSteps,
  stripCommandFromNextStep,
} from '../output/model.js';
export type {
  PluginConsoleReasonCode,
  PluginConsoleStatus,
} from '../install-state/types.js';

export type PluginConsoleFeatureKind =
  | 'install'
  | 'upgrade'
  | 'configure'
  | 'uninstall'
  | 'repair'
  | 'cleanup'
  | 'reinstall'
  | 'adoptExisting'
  | 'takeoverSharedRuntime'
  | 'resolveDuplicateInstall'
  | 'reapplyConfigRefresh'
  | 'dependencies'
  | 'status'
  | 'diagnose';

export interface PluginConsoleFeatureSummary {
  kind: PluginConsoleFeatureKind;
  label: string;
  targetSelection:
    | 'none'
    | 'singleTarget'
    | 'multiTargetAllowed'
    | 'singleTargetOnly';
  disabledReason?: string;
  reasonCodes?: PluginConsoleReasonCode[];
  destructive?: boolean;
}

export interface PluginConsoleLocationSummary {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export interface PluginConsoleConfigView {
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  fields: ConfigFieldEntryV2[];
  legacyConfigStores: LegacyConfigStoreEntryV2[];
}

export interface PluginConsoleConfigProjection {
  configSchemaVersion: 2;
  state?: 'available' | 'catalogUnavailable' | 'configSchemaUnavailable' | 'configSchemaConflict';
  schema?: ConfigSchemaEvidenceV2;
  issueMessage?: string;
  issueDetails?: string[];
  catalog?: {
    available: boolean;
    source?: string;
    channel?: string;
    catalogVersion?: string;
    minAwVersion?: string;
    reason?: string;
    reasonCode?: string;
  };
  conflictConsumers?: Array<{
    platform: PlatformName;
    scope: Scope;
    projectKey?: string;
    recordPath: string;
    schemaIdentity: string;
    pluginVersion: string;
    manifestDigest: string;
  }>;
  views: PluginConsoleConfigView[];
}

export interface PluginConsoleSummary {
  pluginName: string;
  title: string;
  description?: string;
  version?: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  locationSummary?: string;
  supportedPlatforms?: PlatformName[];
  installedLocations: PluginConsoleLocationSummary[];
  duplicateInstallGroups?: Array<{
    pluginName: string;
    platform: PlatformName;
    locations: PluginConsoleLocationSummary[];
  }>;
  features: PluginConsoleFeatureSummary[];
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
  config?: PluginConsoleConfigProjection;
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export type PluginConsoleTone = 'neutral' | 'success' | 'info' | 'danger';

export interface PluginConsoleBadge {
  label: string;
  icon: string;
  tone: PluginConsoleTone;
  title?: string;
}

export interface PluginConsoleTargetOption {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status?: PluginConsoleStatus;
  statusLabel?: string;
  reasonCodes?: PluginConsoleReasonCode[];
  disabledReason?: string;
}

export interface ConsolePageItem {
  summary: PluginConsoleSummary;
  statusSymbol: string;
  statusTone: PluginConsoleTone;
  platformSummary: string;
  description?: string;
  version?: string;
  primaryActionLabel?: string;
}

export interface ConsoleFeatureMenuItem extends PluginConsoleFeatureSummary {
  recommended?: boolean;
}

export interface ConsoleLocationReadModel {
  hasEvidence: boolean;
  summary?: string;
  diagnostics?: Array<{
    label: string;
    value: string;
    tone: PluginConsoleTone;
  }>;
  dependencyEntries?: ConsoleDependencyEntry[];
}

export interface ConsolePluginDetailPageModel {
  summary: PluginConsoleSummary;
  statusSymbol: string;
  statusTone: PluginConsoleTone;
  platformSummary: string;
  platformDetails: Array<{
    label: string;
    status: PluginConsoleStatus;
    statusLabel: string;
    statusSymbol: string;
    statusTone: PluginConsoleTone;
  }>;
  dependencySummary?: string;
  featureMenu: ConsoleFeatureMenuItem[];
  targetOptions: PluginConsoleTargetOption[];
}

export interface ConsoleIssueSummary {
  code: string;
  label: string;
  severity: 'info' | 'warning' | 'error';
  summary: string;
  suggestedFeatures: PluginConsoleFeatureSummary[];
  details?: string[];
}

export interface ConsoleLocationSummary {
  key: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  statusSymbol: string;
  statusTone: PluginConsoleTone;
  hasEvidence: boolean;
  summary: string;
  issue?: ConsoleIssueSummary;
  issues: ConsoleIssueSummary[];
  suggestedFeatures: PluginConsoleFeatureSummary[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  diagnostics: Array<{
    label: string;
    value: string;
    tone: PluginConsoleTone;
  }>;
}

export interface StatusPageModel {
  pluginName: string;
  summary: PluginConsoleSummary;
  locations: ConsoleLocationSummary[];
}

export interface ConsoleDependencyEntry {
  pluginName: string;
  locationLabel: string;
  symbol: string;
  tone: PluginConsoleTone;
  summary: string;
}

export interface ConsoleDependencyGroup {
  key: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  label: string;
  entries: ConsoleDependencyEntry[];
}

export interface ConsoleDependencyPageModel {
  pluginName: string;
  groups: ConsoleDependencyGroup[];
  summary?: string;
}

export interface DiagnoseSupplementalCommand {
  command: string;
  reason: string;
}

export interface DiagnosePageModel {
  pluginName: string;
  conclusion: string;
  issues: ConsoleIssueSummary[];
  locations: ConsoleLocationSummary[];
  supplementalCommands: DiagnoseSupplementalCommand[];
  summary?: PluginConsoleSummary;
}

export type PluginConsoleExecutableActionKind =
  | 'runInstall'
  | 'runUpgrade'
  | 'runConfig'
  | 'runUninstall'
  | 'runRepair'
  | 'runCleanup'
  | 'runReinstall'
  | 'runAdoptExisting'
  | 'runTakeoverSharedRuntime'
  | 'resolveDuplicateInstall'
  | 'runReapplyConfigRefresh'
  | 'openDependencies'
  | 'openStatus'
  | 'openDiagnose';

export interface PluginConsoleExecutableAction {
  kind: PluginConsoleExecutableActionKind;
  label: string;
  target?: PluginConsoleActionTarget;
  targetPolicy?: 'singleTargetOnly' | 'multiTargetAllowed';
  destructive?: boolean;
  force?: boolean;
  removeConfig?: boolean;
  confirmText?: string;
  disabledReason?: string;
}

export interface ConsoleControllerItem {
  summary: PluginConsoleSummary;
  pageItem: ConsolePageItem;
  detailPage: ConsolePluginDetailPageModel;
  locations: PluginConsoleLocation[];
  statusPage: StatusPageModel;
  dependencyPage?: ConsoleDependencyPageModel;
  blockingMessage?: string;
}

export type PluginConsoleActionKind =
  | 'openInstallWizard'
  | 'openConfigWizard'
  | 'openStatus'
  | 'runInstall'
  | 'runUpgrade'
  | 'runUninstall'
  | 'runCleanup'
  | 'runReinstall'
  | 'runAdoptExisting'
  | 'runTakeoverSharedRuntime'
  | 'repairInstall'
  | 'reapplyConfigRefresh'
  | 'diagnoseCommand'
  | 'back';

export interface PluginConsoleActionTarget {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
}

export interface PluginConsoleAction {
  kind: PluginConsoleActionKind;
  label: string;
  target?: PluginConsoleActionTarget;
  destructive?: boolean;
  confirmText?: string;
  disabledReason?: string;
  command?: string[];
}

export interface PluginConsoleLocation {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  locationLabel: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  actions: PluginConsoleAction[];
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export interface PluginConsoleItem {
  pluginName: string;
  title: string;
  description?: string;
  version?: string;
  status: PluginConsoleStatus;
  statusLabel: string;
  locationSummary: string;
  actions: PluginConsoleAction[];
  locations: PluginConsoleLocation[];
  blockingMessage?: string;
  reasonCodes: PluginConsoleReasonCode[];
  issueSummary?: string;
  detailHints?: string[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
}

export interface PluginConsolePluginMeta {
  title?: string;
  description?: string;
  version?: string;
}

export type PluginConsoleUpgradeState = 'available' | 'current' | 'unknown';

export interface PluginConsoleLocationDiagnostics {
  upgradeState?: PluginConsoleUpgradeState;
}

export interface PluginConsoleProjectionOptions {
  pluginMetaByName?: Record<string, PluginConsolePluginMeta>;
  locationDiagnosticsByKey?: Record<string, PluginConsoleLocationDiagnostics>;
  locationReadModelByKey?: Record<string, ConsoleLocationReadModel>;
  configProjectionByPluginName?: Record<string, PluginConsoleConfigProjection>;
}

export interface ConsoleControllerProjectionOptions extends PluginConsoleProjectionOptions {}

export const PLUGIN_CONSOLE_STATUS_LABELS: Record<PluginConsoleStatus, string> = {
  notInstalled: '未安装',
  installed: '已安装',
  upgradeAvailable: '可升级',
  abnormal: '异常',
};

const LOCATION_PLATFORM_LABELS: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

const STATUS_PRIORITY: Record<PluginConsoleStatus, number> = {
  abnormal: 4,
  upgradeAvailable: 3,
  installed: 2,
  notInstalled: 0,
};

const REASON_PRIORITY: Record<PluginConsoleReasonCode, number> = {
  duplicateInstall: 100,
  foreignOwnershipConflict: 95,
  recordCorrupted: 90,
  nativeIncomplete: 85,
  artifactRefreshFailed: 80,
  missingRequiredConfig: 75,
  dependencyBlocked: 70,
  residueDetected: 65,
  adoptableInstall: 60,
};

const WRITE_ACTION_KINDS = new Set<PluginConsoleActionKind>([
  'runInstall',
  'runUpgrade',
  'runUninstall',
  'runCleanup',
  'runReinstall',
  'runAdoptExisting',
  'runTakeoverSharedRuntime',
  'repairInstall',
  'reapplyConfigRefresh',
]);

function locationTarget(cell: Pick<StatusMatrixCell, 'platform' | 'scope' | 'projectKey'>): PluginConsoleActionTarget {
  return {
    platform: cell.platform,
    scope: cell.scope,
    ...(cell.projectKey ? { projectKey: cell.projectKey } : {}),
  };
}

export function createPluginConsoleLocationKey(cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope' | 'projectKey'>): string {
  return [
    cell.pluginName,
    cell.platform,
    cell.scope,
    cell.projectKey ?? '-',
  ].join(':');
}

export function pluginConsoleLocationLabel(cell: Pick<StatusMatrixCell, 'platform' | 'scope'>): string {
  return `${LOCATION_PLATFORM_LABELS[cell.platform]}（${cell.scope === 'user' ? '个人' : '当前项目'}）`;
}

function formatCommandArgs(cell: Pick<StatusMatrixCell, 'pluginName' | 'platform' | 'scope'>): string[] {
  return [
    cell.pluginName,
    '--platform',
    cell.platform,
    '--scope',
    cell.scope,
  ];
}

function formatDependentLabel(dependent: { plugin: string; platform: PlatformName; scope: Scope; projectKey?: string | null }): string {
  return dependent.scope === 'project'
    ? `${dependent.plugin} (${dependent.platform}/project)`
    : `${dependent.plugin} (${dependent.platform}/user)`;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function dedupeConsoleNextSteps(steps: NextStepInstruction[]): NextStepInstruction[] {
  return dedupeNextSteps(steps.map(stripCommandFromNextStep));
}

function consoleNextStepsBoundary(steps: NextStepInstruction[]) {
  return createNextStepsBoundary(dedupeConsoleNextSteps(steps));
}

function dedupeReasons(values: PluginConsoleReasonCode[]): PluginConsoleReasonCode[] {
  return [...new Set(values)].sort((left, right) => REASON_PRIORITY[right] - REASON_PRIORITY[left]);
}

function sortLocations(left: PluginConsoleLocation, right: PluginConsoleLocation): number {
  const platformOrder = { codex: 0, claude: 1 };
  const scopeOrder = { user: 0, project: 1 };
  return platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope] ||
    (left.projectKey ?? '').localeCompare(right.projectKey ?? '');
}

function hasManagedEvidence(report: PluginStatusReport | undefined): boolean {
  if (!report) {
    return false;
  }

  return Boolean(
    report.scopeInitialized === 'yes' ||
    report.scopeManagedEvidence?.ledger ||
    report.scopeManagedEvidence?.tracking ||
    report.scopeManagedEvidence?.sharedNativeRef ||
    report.generatedArtifacts.length > 0 ||
    report.managedArtifacts?.length ||
    report.repoManagedSessionState?.items?.some((item) => item.tracked),
  );
}

function hasRuntimeEvidence(report: PluginStatusReport | undefined): boolean {
  if (!report) {
    return false;
  }

  return Boolean(
    report.native.pluginInstalled ||
    report.native.pluginEnabled === true ||
    report.native.recovery?.present ||
    report.platformRuntimeEvidence?.present ||
    report.platformNativeFallbackEvidence?.present,
  );
}

function hasExternalOwnership(report: PluginStatusReport | undefined): boolean {
  return report?.externalOwnership?.present === true;
}

function catalogUnavailable(report: PluginStatusReport | undefined): boolean {
  if (!report?.currentCatalog) {
    return true;
  }

  return report.currentCatalog.available === false || report.catalogCompatibility === 'missing';
}

function catalogUsable(report: PluginStatusReport | undefined): boolean {
  return !catalogUnavailable(report);
}

function installActionDisabledReason(cell: StatusMatrixCell): string | undefined {
  if (cell.disabledReason) {
    return cell.disabledReason;
  }
  if (cell.installState) {
    return cell.installState.currentCatalogAvailable
      ? undefined
      : 'current catalog 当前不可用；恢复后才能安装、升级或查看可安装版本。';
  }
  if (!catalogUsable(cell.report) || cell.report?.currentCatalog?.available !== true) {
    return 'current catalog 当前不可用；恢复后才能安装、升级或查看可安装版本。';
  }
  return undefined;
}

function isCodexUserNativeCell(cell: StatusMatrixCell): boolean {
  return cell.platform === 'codex' &&
    cell.scope === 'user' &&
    cell.report?.native.requiresNativePlugin === true;
}

function hasProjectVisibilityState(state: RepoManagedProjectItemState | GeneratedArtifactSessionVisibility | undefined): boolean {
  return state === 'blockedByProjectTrust' || state === 'projectTrustUnknown';
}

function hasSessionVisibilityState(state: GeneratedArtifactSessionVisibility | undefined): boolean {
  return state === 'shadowedByProjectDeveloperInstructions' || state === 'unknownByExternalLayer';
}

function flattenDiagnostics(cell: StatusMatrixCell): string[] {
  const report = cell.report;
  return dedupeStrings([
    cell.error ?? '',
    ...(cell.healthWarnings ?? []),
    ...(cell.configIssues ?? []).map((issue) => issue.message),
    ...(report?.driftWarnings ?? []),
    ...(report?.managedArtifacts ?? []).flatMap((artifact) => artifact.diagnostics),
    ...(report?.repoManagedSessionState?.diagnostics ?? []),
    ...(report?.repoManagedSessionState?.items ?? []).flatMap((item) => item.diagnostics),
  ]);
}

function hasUnreadableConfigSignal(cell: StatusMatrixCell): boolean {
  const diagnostics = flattenDiagnostics(cell);
  return diagnostics.some((message) =>
    /Invalid plugin config store|无法读取.*配置|read.*config|config.*unreadable/i.test(message),
  );
}

function hasTrackingIdentitySignal(cell: StatusMatrixCell): boolean {
  const report = cell.report;
  const diagnostics = flattenDiagnostics(cell);
  return Boolean(
    report?.repoManagedSessionState?.items?.some((item) =>
      item.state === 'unknown' && item.diagnostics.some((message) => /tracking|roleKey/i.test(message))) ||
    diagnostics.some((message) => /tracking identity|tracking manifest|roleKey/i.test(message)),
  );
}

function hasRoleOrMcpConflictSignal(cell: StatusMatrixCell): boolean {
  const diagnostics = flattenDiagnostics(cell);
  return diagnostics.some((message) =>
    /非 AW managed registration|同名.+MCP|同名.+角色|role registration 当前指向|role registration 缺少 config_file/i.test(message),
  );
}

function hasUnmanagedArtifactConflictSignal(cell: StatusMatrixCell): boolean {
  const report = cell.report;
  return Boolean(
    report?.repoManagedSessionState?.items?.some((item) => item.state === 'orphan') ||
    flattenDiagnostics(cell).some((message) => /没有 tracking 证明归属/i.test(message)),
  );
}

function hasArtifactRefreshFailure(report: PluginStatusReport | undefined): boolean {
  return report?.managedArtifacts?.some((artifact) => artifact.health === 'recentRefreshFailed') === true;
}

function hasArtifactDrift(report: PluginStatusReport | undefined): boolean {
  if (!report) {
    return false;
  }

  if (report.artifactsInitialized === false) {
    return true;
  }

  if (report.generatedArtifacts.some((artifact) => !artifact.exists && artifact.disabledReason === undefined)) {
    return true;
  }

  return report.managedArtifacts?.some((artifact) =>
    artifact.health !== 'healthy' &&
    artifact.health !== 'disabledByConfig' &&
    artifact.health !== 'recentRefreshFailed',
  ) === true;
}

function addCodexUserNativeReasonCodes(
  cell: StatusMatrixCell,
  reasons: Set<PluginConsoleReasonCode>,
): void {
  const report = cell.report;
  if (!isCodexUserNativeCell(cell) || !report) {
    return;
  }

  const installed = report.native.pluginInstalled;
  const enabled = report.native.pluginEnabled === true;
  const recovery = report.native.recovery;
  const scopeRecorded = report.scopeManagedEvidence?.ledger === true;

  if (recovery?.present) {
    reasons.add(recovery.evidenceMatches === false ? 'residueDetected' : 'nativeIncomplete');
  } else if ((installed && !enabled) || (!installed && enabled)) {
    reasons.add('residueDetected');
  } else if (installed && enabled && !scopeRecorded) {
    reasons.add('recordCorrupted');
  }
}

function collectInstallStateReasonCodes(cell: StatusMatrixCell): PluginConsoleReasonCode[] {
  const installState = cell.installState;
  if (!installState) {
    return [];
  }

  const reasons = new Set<PluginConsoleReasonCode>();
  if (installState.kind === 'adoptable') {
    reasons.add('adoptableInstall');
  }
  if (installState.sharedRuntimeOwnerConflict) {
    reasons.add('foreignOwnershipConflict');
  }
  if (
    installState.dependents.length > 0
    || installState.issueCodes.includes('dependencyMissing')
  ) {
    reasons.add('dependencyBlocked');
  }
  if (installState.issueCodes.includes('dynamicRefreshFailed')) {
    reasons.add('artifactRefreshFailed');
  }
  if (
    installState.issueCodes.some((code) =>
      code === 'artifactMissing' ||
      code === 'staticContentDrift' ||
      code === 'dynamicContentDrift' ||
      code === 'dynamicConfigStale' ||
      code === 'historicalLifecycleUnavailable' ||
      code === 'projectSharedIdentityUnavailable' ||
      code === 'nativeEvidenceMissing' ||
      code === 'installRecordInvalid',
    )
  ) {
    if (
      installState.issueCodes.includes('installRecordInvalid') ||
      installState.issueCodes.includes('projectSharedIdentityUnavailable')
    ) {
      reasons.add('recordCorrupted');
    }
    if (
      installState.issueCodes.some((code) =>
        code === 'artifactMissing' ||
        code === 'staticContentDrift' ||
        code === 'dynamicContentDrift' ||
        code === 'dynamicConfigStale' ||
        code === 'historicalLifecycleUnavailable',
      )
    ) {
      reasons.add('artifactRefreshFailed');
    }
    if (installState.issueCodes.includes('nativeEvidenceMissing')) {
      reasons.add('nativeIncomplete');
    }
  }
  if (
    installState.nativeTransactionKind === 'markerOnlyInstall' ||
    installState.nativeTransactionKind === 'recordInstallResidual'
  ) {
    reasons.add('nativeIncomplete');
  } else if (
    installState.kind === 'residual' ||
    installState.nativeTransactionKind === 'markerOnlyUninstall' ||
    installState.nativeTransactionKind === 'recordUninstallResidual'
  ) {
    reasons.add('residueDetected');
  }
  if (installState.kind === 'externallyManaged') {
    reasons.add(installState.cleanupAvailable ? 'residueDetected' : 'foreignOwnershipConflict');
  }
  addCodexUserNativeReasonCodes(cell, reasons);

  return dedupeReasons([...reasons]);
}

function collectReasonCodes(
  cell: StatusMatrixCell,
  locationDiagnostics: PluginConsoleLocationDiagnostics | undefined,
): PluginConsoleReasonCode[] {
  if (cell.installState) {
    return collectInstallStateReasonCodes(cell);
  }

  const report = cell.report;
  const reasons = new Set<PluginConsoleReasonCode>();
  const managedEvidence = hasManagedEvidence(report);
  const runtimeEvidence = hasRuntimeEvidence(report);
  const externalOwnership = hasExternalOwnership(report);

  if (cell.config === 'missing-required') {
    reasons.add('missingRequiredConfig');
  }
  if (cell.config === 'invalid-config') {
    reasons.add('missingRequiredConfig');
  }
  if ((report?.dependencies?.missing.length ?? 0) > 0) {
    reasons.add('dependencyBlocked');
  }
  if ((report?.dependencies?.dependents.length ?? 0) > 0) {
    reasons.add('dependencyBlocked');
  }
  if (hasUnreadableConfigSignal(cell)) {
    reasons.add('missingRequiredConfig');
  }
  if (report?.catalogCompatibility === 'capabilityChanged') {
    reasons.add('recordCorrupted');
  }
  if (hasArtifactRefreshFailure(report)) {
    reasons.add('artifactRefreshFailed');
  }
  if (hasArtifactDrift(report)) {
    reasons.add('artifactRefreshFailed');
  }
  if (hasTrackingIdentitySignal(cell)) {
    reasons.add('recordCorrupted');
  }
  if (hasRoleOrMcpConflictSignal(cell)) {
    reasons.add('foreignOwnershipConflict');
  }
  if (hasUnmanagedArtifactConflictSignal(cell)) {
    reasons.add('foreignOwnershipConflict');
  }

  if (
    report?.repoManagedSessionState?.items?.some((item) => hasProjectVisibilityState(item.state)) ||
    report?.managedArtifacts?.some((artifact) => hasProjectVisibilityState(artifact.sessionVisibility)) ||
    (cell.scope === 'project' &&
      (report?.projectTrust === 'untrusted' || report?.projectTrust === 'unknown') &&
      managedEvidence)
  ) {
    reasons.add('foreignOwnershipConflict');
  }

  if (
    report?.managedArtifacts?.some((artifact) => hasSessionVisibilityState(artifact.sessionVisibility)) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.instructions) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.rules) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.hooks) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.agents)
  ) {
    reasons.add('foreignOwnershipConflict');
  }

  if (externalOwnership) {
    reasons.add('foreignOwnershipConflict');
  }

  addCodexUserNativeReasonCodes(cell, reasons);
  if (!isCodexUserNativeCell(cell) && report && runtimeEvidence && !managedEvidence && !externalOwnership) {
    reasons.add('recordCorrupted');
  }

  return dedupeReasons([...reasons]);
}

function installedEvidenceHealthy(cell: StatusMatrixCell, reasons: PluginConsoleReasonCode[]): boolean {
  const report = cell.report;
  if (!report) {
    return false;
  }

  const blockingReasons = reasons.filter((reason) =>
    reason !== 'dependencyBlocked',
  );
  if (blockingReasons.length > 0) {
    return false;
  }

  if (isCodexUserNativeCell(cell)) {
    return report.native.pluginInstalled &&
      report.native.pluginEnabled === true &&
      report.scopeManagedEvidence?.ledger === true &&
      report.native.recovery?.present !== true;
  }

  return hasManagedEvidence(report);
}

function computeLocationStatus(
  cell: StatusMatrixCell,
  reasons: PluginConsoleReasonCode[],
  locationDiagnostics: PluginConsoleLocationDiagnostics | undefined,
): PluginConsoleStatus {
  if (cell.installState) {
    const installState = cell.installState;
    if (installState.kind === 'notInstalled') {
      return 'notInstalled';
    }
    if (installState.kind !== 'installed') {
      return 'abnormal';
    }
    if (installState.upgradeAvailable) {
      return 'upgradeAvailable';
    }
    return 'installed';
  }

  const report = cell.report;

  if (reasons.some((reason) =>
    reason === 'duplicateInstall' ||
    reason === 'missingRequiredConfig' ||
    reason === 'artifactRefreshFailed' ||
    reason === 'recordCorrupted' ||
    reason === 'nativeIncomplete' ||
    reason === 'adoptableInstall' ||
    reason === 'foreignOwnershipConflict' ||
    reason === 'residueDetected' ||
    (reason === 'dependencyBlocked' && hasDependencyGap(cell))
  )) {
    return 'abnormal';
  }

  const healthyInstalled = installedEvidenceHealthy(cell, reasons);
  if (
    healthyInstalled &&
    catalogUsable(report) &&
    locationDiagnostics?.upgradeState === 'available'
  ) {
    return 'upgradeAvailable';
  }

  if (healthyInstalled) {
    return 'installed';
  }

  if (catalogUsable(report) && !hasManagedEvidence(report) && !hasRuntimeEvidence(report) && !hasExternalOwnership(report)) {
    return 'notInstalled';
  }

  return hasManagedEvidence(report) || hasRuntimeEvidence(report) ? 'abnormal' : 'notInstalled';
}

function baseStatusCommand(cell: StatusMatrixCell): string[] {
  return [
    'aw',
    'status',
    cell.pluginName,
    '--platform',
    cell.platform,
    '--scope',
    cell.scope,
    '--verbose',
  ];
}

function action(
  kind: PluginConsoleActionKind,
  label: string,
  target: PluginConsoleActionTarget | undefined,
  extras: Omit<PluginConsoleAction, 'kind' | 'label' | 'target'> = {},
): PluginConsoleAction {
  const builtAction: PluginConsoleAction = {
    kind,
    label,
    ...(target ? { target } : {}),
    ...extras,
  };

  if (WRITE_ACTION_KINDS.has(kind) && !builtAction.target) {
    throw new Error(`Plugin console write action "${kind}" requires a target.`);
  }
  if (builtAction.destructive && !builtAction.confirmText) {
    throw new Error(`Plugin console destructive action "${kind}" requires confirmText.`);
  }
  if ('disabledReason' in builtAction && builtAction.disabledReason === '') {
    throw new Error(`Plugin console action "${kind}" requires a non-empty disabledReason.`);
  }

  return builtAction;
}

function buildInstallStateActions(
  cell: StatusMatrixCell,
  status: PluginConsoleStatus,
  reasons: PluginConsoleReasonCode[],
  configProjection: PluginConsoleConfigProjection | undefined,
): PluginConsoleAction[] {
  const installState = cell.installState;
  if (!installState) {
    return [];
  }

  const target = locationTarget(cell);
  const commandArgs = formatCommandArgs(cell);
  const diagnose = action('openStatus', '查看状态', target, {
    command: ['aw', 'status', ...commandArgs, '--verbose'],
  });
  const configSupported = supportsConfigAction(configProjection);
  const dependencyProtected = installState.dependents.length > 0;
  const autoRemovable = installState.autoInstalled && installState.unusedDependencyHint;
  const uninstall = action('runUninstall', autoRemovable ? '清理自动依赖' : '卸载', target, {
    destructive: true,
    confirmText: autoRemovable
      ? `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的自动依赖安装吗？`
      : `确定要卸载 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的安装吗？`,
    ...(dependencyProtected
      ? {
          disabledReason: installState.dependents.length === 1
            ? `当前仍被 ${formatDependentLabel(installState.dependents[0]!)} 依赖，暂时不能直接卸载。`
            : `当前仍被 ${formatDependentLabel(installState.dependents[0]!)} 等 ${installState.dependents.length} 个安装位置依赖，暂时不能直接卸载。`,
        }
      : {}),
  });
  const actions: PluginConsoleAction[] = [];

  if (status === 'notInstalled') {
    actions.push(action('openInstallWizard', '安装', target, {
      ...(installActionDisabledReason(cell) ? { disabledReason: installActionDisabledReason(cell) } : {}),
    }));
    if (configSupported) {
      actions.push(action('openConfigWizard', '配置', target));
    }
    return actions;
  }

  if (reasons.includes('adoptableInstall')) {
    actions.push(action('runAdoptExisting', '认领现有安装', target, {
      destructive: true,
      confirmText: `确定要认领 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的现有安装吗？`,
    }));
    if (installState.cleanupAvailable) {
      actions.push(action('runCleanup', '清理', target, {
        destructive: true,
        confirmText: `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的现有残留吗？`,
      }));
    }
    actions.push(diagnose);
    return dedupeActions(actions);
  }

  if (installState.sharedRuntimeOwnerConflict) {
    actions.push(action('runTakeoverSharedRuntime', '接管共享触发策略', target, {
      destructive: true,
      confirmText: `确定要接管 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的共享触发策略吗？`,
    }));
  }

  if (status === 'upgradeAvailable') {
    actions.push(action('runUpgrade', '升级', target));
  }

  if (
    configSupported &&
    (
      installState.kind === 'installed' ||
      installState.kind === 'needsRepair' ||
      status === 'upgradeAvailable' ||
      reasons.includes('missingRequiredConfig')
    )
  ) {
    actions.push(action('openConfigWizard', '配置', target));
  }

  if (installState.issueCodes.includes('dynamicRefreshFailed')) {
    actions.push(action('reapplyConfigRefresh', '重新应用配置', target));
  }

  if (
    installState.repairAvailable &&
    !installState.sharedRuntimeOwnerConflict &&
    (
      installState.kind === 'needsRepair' ||
      installState.issueCodes.includes('dependencyMissing') ||
      reasons.includes('recordCorrupted') ||
      reasons.includes('artifactRefreshFailed') ||
      reasons.includes('nativeIncomplete')
    )
  ) {
    actions.push(action(
      'repairInstall',
      installState.issueCodes.includes('dependencyMissing') ? '补齐依赖' : '修复安装',
      target,
    ));
  }

  if (installState.kind === 'residual' || (installState.kind === 'externallyManaged' && installState.cleanupAvailable)) {
    if (installState.cleanupAvailable && !installState.sharedRuntimeOwnerConflict) {
      actions.push(action('runCleanup', '清理', target, {
        destructive: true,
        confirmText: `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的残留吗？`,
      }));
    }
    actions.push(diagnose);
    return dedupeActions(actions);
  }

  if (installState.kind === 'installed' || status === 'upgradeAvailable') {
    actions.push(uninstall);
    actions.push(action('runReinstall', '重新安装', target, {
      destructive: true,
      confirmText: `确定要重新安装 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的当前安装吗？`,
    }));
  } else if (installState.cleanupAvailable && !installState.sharedRuntimeOwnerConflict) {
    actions.push(action('runCleanup', '清理', target, {
      destructive: true,
      confirmText: `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的当前状态吗？`,
    }));
  }

  actions.push(diagnose);
  return dedupeActions(actions);
}

function buildReasonCopy(
  reason: PluginConsoleReasonCode,
  cell: StatusMatrixCell,
): { issueSummary: string; detailHints: string[]; nextSteps: NextStepInstruction[] } {
  switch (reason) {
    case 'duplicateInstall':
      return {
        issueSummary: '同一平台同时存在两个可生效安装。',
        detailHints: ['先决定保留个人还是当前项目这一侧，再处理另一个位置。'],
        nextSteps: [createManualNextStep('处理重复安装', '先卸载或清理其中一侧，再重新检查状态。')],
      };
    case 'missingRequiredConfig':
      return {
        issueSummary: '这个插件还缺少可用配置。',
        detailHints: ['先补齐必填项，或修正当前无效的配置值。'],
        nextSteps: [createManualNextStep('补齐或修正配置', '先打开配置向导补齐或修正配置。')],
      };
    case 'artifactRefreshFailed':
      return {
        issueSummary: '已写入内容和当前期望不一致，或最近一次刷新没有成功。',
        detailHints: ['如果只是刷新失败，可以先重试；如果内容已经漂移，再考虑修复安装。'],
        nextSteps: [createManualNextStep('重试刷新或修复安装', '先重试刷新或修复安装，再重新检查状态。')],
      };
    case 'recordCorrupted':
      return {
        issueSummary: 'AW 记录和当前安装状态对不上。',
        detailHints: ['通常需要先修复记录，再继续升级、卸载或接管。'],
        nextSteps: [createManualNextStep('修复安装', '先执行修复安装，再重新检查状态。')],
      };
    case 'nativeIncomplete':
      return {
        issueSummary: '平台侧写入没有完整收口。',
        detailHints: ['可以先尝试修复；如果只想撤掉未完成写入，再执行受控清理。'],
        nextSteps: [createManualNextStep('处理修复动作', '先处理这个位置的修复动作，再重新检查状态。')],
      };
    case 'adoptableInstall':
      return {
        issueSummary: '发现了一份可认领的已有安装。',
        detailHints: ['认领只会补齐当前机器上的 AW 状态，不会直接改动已有仓库文件。'],
        nextSteps: [createManualNextStep('认领现有安装', '先执行认领，再继续管理这个位置。')],
      };
    case 'foreignOwnershipConflict':
      return {
        issueSummary: '当前安装位置的归属或生效环境存在冲突。',
        detailHints: ['先确认冲突来源，再决定是接管、认领，还是保留现有内容。'],
        nextSteps: [createManualNextStep('查看诊断', '先查看诊断，再处理冲突来源。')],
      };
    case 'residueDetected':
      return {
        issueSummary: '发现了残留文件或本机状态。',
        detailHints: ['先确认来源，再决定是清理还是补齐记录。'],
        nextSteps: [createManualNextStep('查看诊断', '先查看诊断，再处理当前残留。')],
      };
    case 'dependencyBlocked':
      return {
        issueSummary: '依赖关系正在阻止当前操作。',
        detailHints: ['有的目标缺少上游依赖，也有的目标还在被下游安装引用。'],
        nextSteps: [createManualNextStep('处理依赖链', '先处理依赖链，再重新尝试当前操作。')],
      };
  }
}

function reasonLabel(reason: PluginConsoleReasonCode): string {
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

function reasonSeverity(reason: PluginConsoleReasonCode): ConsoleIssueSummary['severity'] {
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

function composeCopy(
  reasons: PluginConsoleReasonCode[],
  cell: StatusMatrixCell,
): { issueSummary?: string; detailHints?: string[]; nextSteps: NextStepInstruction[] } {
  if (cell.installState) {
    const installState = cell.installState;
    const copies = reasons.map((reason) => buildReasonCopy(reason, cell));
    const detailHints = [
      ...copies.flatMap((copy) => copy.detailHints),
      ...installState.findings,
      ...(installState.autoInstalled && !installState.unusedDependencyHint
        ? ['这个位置最初由依赖自动安装，但当前仍被显式保留或还有可信引用。']
        : []),
    ].filter((hint) => hint !== installState.summary);
    return {
      ...(copies[0]?.issueSummary ? { issueSummary: copies[0].issueSummary } : {}),
      detailHints: dedupeStrings(detailHints).slice(0, 6),
      nextSteps: dedupeConsoleNextSteps(installState.nextSteps.length > 0
        ? installState.nextSteps
        : copies.flatMap((copy) => copy.nextSteps)),
    };
  }

  if (reasons.length === 0) {
    return { nextSteps: [] };
  }

  const copies = reasons.map((reason) => buildReasonCopy(reason, cell));
  return {
    issueSummary: copies[0]?.issueSummary,
    detailHints: dedupeStrings(copies.flatMap((copy) => copy.detailHints)),
    nextSteps: dedupeConsoleNextSteps(copies.flatMap((copy) => copy.nextSteps)),
  };
}

function supportsConfigAction(projection: PluginConsoleConfigProjection | undefined): boolean {
  return projection !== undefined;
}

function hasDependencyGap(cell: StatusMatrixCell): boolean {
  if (cell.installState) {
    return cell.installState.issueCodes.includes('dependencyMissing');
  }
  return (cell.report?.dependencies?.missing.length ?? 0) > 0;
}

function hasOnlyForeignOwnershipConflict(
  cell: StatusMatrixCell,
  reasons: PluginConsoleReasonCode[],
): boolean {
  return reasons.length === 1 &&
    reasons[0] === 'foreignOwnershipConflict' &&
    !hasManagedEvidence(cell.report) &&
    !hasRuntimeEvidence(cell.report);
}

function buildLocationActions(
  cell: StatusMatrixCell,
  status: PluginConsoleStatus,
  reasons: PluginConsoleReasonCode[],
  configProjection: PluginConsoleConfigProjection | undefined,
): PluginConsoleAction[] {
  if (cell.installState) {
    return buildInstallStateActions(cell, status, reasons, configProjection);
  }

  const target = locationTarget(cell);
  const diagnose = action('openStatus', '查看状态', target, {
    command: baseStatusCommand(cell),
  });
  const dependencyProtected = (cell.report?.dependencies?.dependents.length ?? 0) > 0;
  const autoRemovable = cell.report?.dependencies?.autoRemovable === true;
  const uninstall = action('runUninstall', autoRemovable ? '清理自动依赖' : '卸载', target, {
    destructive: true,
    confirmText: autoRemovable
      ? `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的自动依赖安装吗？`
      : `确定要卸载 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的安装吗？`,
    ...(dependencyProtected
      ? {
          disabledReason: `当前还有 ${cell.report?.dependencies?.dependents.length ?? 0} 个依赖它的安装位置，暂时不能直接卸载。`,
        }
      : {}),
  });
  const actions: PluginConsoleAction[] = [];
  const configSupported = supportsConfigAction(configProjection);
  const managedEvidence = hasManagedEvidence(cell.report);
  const disabledInstallReason = installActionDisabledReason(cell);

  if (status === 'notInstalled') {
    actions.push(action('openInstallWizard', '安装', target, {
      ...(disabledInstallReason ? { disabledReason: disabledInstallReason } : {}),
    }));
    if (configSupported) {
      actions.push(action('openConfigWizard', '配置', target));
    }
    return actions;
  }

  if (hasOnlyForeignOwnershipConflict(cell, reasons)) {
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('duplicateInstall')) {
    if (managedEvidence) {
      actions.push(uninstall);
    }
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('nativeIncomplete')) {
    actions.push(action('repairInstall', '修复安装', target));
    if (cell.report?.native.recovery?.present && cell.report.native.recovery.evidenceMatches !== false) {
      actions.push(action('runCleanup', '清理', target, {
        destructive: true,
        confirmText: `确定要清理 ${pluginConsoleLocationLabel(cell)} 这次未完成安装留下的残留吗？`,
      }));
    }
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('residueDetected')) {
    actions.push(action('runCleanup', '清理', target, {
      destructive: true,
      confirmText: `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的残留吗？`,
    }));
    actions.push(diagnose);
    return actions;
  }

  if (hasArtifactRefreshFailure(cell.report)) {
    actions.push(action('reapplyConfigRefresh', '重新应用配置', target));
  }

  if (
    reasons.includes('recordCorrupted') ||
    reasons.includes('dependencyBlocked') ||
    reasons.includes('artifactRefreshFailed')
  ) {
    const repairLabel = hasDependencyGap(cell)
      ? '补齐依赖'
      : hasArtifactDrift(cell.report)
        ? '重新安装/升级'
        : '修复安装';
    if (
      hasDependencyGap(cell) ||
      reasons.includes('recordCorrupted') ||
      reasons.includes('artifactRefreshFailed')
    ) {
      actions.push(action('repairInstall', repairLabel, target));
    }
  }

  if (
    configSupported &&
    (status === 'installed' || status === 'upgradeAvailable' ||
      reasons.includes('missingRequiredConfig'))
  ) {
    actions.push(action('openConfigWizard', '配置', target));
  }

  if (
    catalogUsable(cell.report) &&
    cell.report?.currentCatalog?.available === true &&
    (status === 'installed' || status === 'upgradeAvailable')
  ) {
    actions.push(action('runUpgrade', '升级', target));
  }

  if (
    status === 'abnormal' &&
    !reasons.includes('foreignOwnershipConflict') &&
    !reasons.includes('missingRequiredConfig') &&
    !reasons.includes('residueDetected') &&
    !(reasons.includes('dependencyBlocked') && !hasDependencyGap(cell)) &&
    !actions.some((existing) => existing.kind === 'repairInstall')
  ) {
    actions.push(action('repairInstall', '修复安装', target));
  }

  if (managedEvidence && !reasons.includes('residueDetected')) {
    actions.push(uninstall);
    if (status === 'abnormal') {
      actions.push(action('runCleanup', '清理', target, {
        destructive: true,
        confirmText: `确定要清理 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的当前状态吗？`,
      }));
    }
    if (!reasons.includes('adoptableInstall')) {
      actions.push(action('runReinstall', '重新安装', target, {
        destructive: true,
        confirmText: `确定要重新安装 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的当前安装吗？`,
      }));
    }
  }

  actions.push(diagnose);
  return dedupeActions(actions);
}

function dedupeActions(actions: PluginConsoleAction[]): PluginConsoleAction[] {
  const seen = new Set<string>();
  const unique: PluginConsoleAction[] = [];
  for (const entry of actions) {
    const key = [
      entry.kind,
      entry.target?.platform ?? '-',
      entry.target?.scope ?? '-',
      entry.target?.projectKey ?? '-',
      entry.label,
    ].join(':');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function buildLocation(
  cell: StatusMatrixCell,
  locationDiagnostics: PluginConsoleLocationDiagnostics | undefined,
  configProjection: PluginConsoleConfigProjection | undefined,
): PluginConsoleLocation {
  const reasonCodes = collectReasonCodes(cell, locationDiagnostics);
  const status = computeLocationStatus(cell, reasonCodes, locationDiagnostics);
  const copy = composeCopy(reasonCodes, cell);
  const actions = buildLocationActions(cell, status, reasonCodes, configProjection);

  for (const entry of actions) {
    if (WRITE_ACTION_KINDS.has(entry.kind) && !entry.target) {
      throw new Error(`Plugin console location action "${entry.kind}" is missing target.`);
    }
    if (entry.destructive && !entry.confirmText) {
      throw new Error(`Plugin console location action "${entry.kind}" is missing confirmText.`);
    }
    if (entry.disabledReason !== undefined && entry.disabledReason.trim() === '') {
      throw new Error(`Plugin console location action "${entry.kind}" has empty disabledReason.`);
    }
  }

  return {
    platform: cell.platform,
    scope: cell.scope,
    ...(cell.projectKey ? { projectKey: cell.projectKey } : {}),
    locationLabel: pluginConsoleLocationLabel(cell),
    status,
    statusLabel: PLUGIN_CONSOLE_STATUS_LABELS[status],
    actions,
    reasonCodes,
    ...(copy.issueSummary ? { issueSummary: copy.issueSummary } : {}),
    ...(copy.detailHints && copy.detailHints.length > 0 ? { detailHints: copy.detailHints } : {}),
    ...consoleNextStepsBoundary(copy.nextSteps),
  };
}

function isHealthyInstalledStatus(status: PluginConsoleStatus): boolean {
  return status === 'installed' || status === 'upgradeAvailable';
}

function pageStatusSymbol(status: PluginConsoleStatus): string {
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

function buildDependencyLocationLabel(location: {
  platform: PlatformName;
  scope: Scope;
}): string {
  return pluginConsoleLocationLabel(location);
}

function createFallbackLocationReadModel(
  cell: StatusMatrixCell,
  location: PluginConsoleLocation,
): NonNullable<PluginConsoleProjectionOptions['locationReadModelByKey']>[string] {
  const dependencyEntries: ConsoleDependencyEntry[] = [];
  if (cell.report?.dependencies) {
    for (const satisfied of cell.report.dependencies.satisfied) {
      dependencyEntries.push({
        pluginName: satisfied.declaration.name,
        locationLabel: buildDependencyLocationLabel(satisfied.location),
        symbol: '✓',
        tone: 'success',
        summary: '正常',
      });
    }
    for (const missing of cell.report.dependencies.missing) {
      dependencyEntries.push({
        pluginName: missing.declaration.name,
        locationLabel: missing.expectedLocation
          ? buildDependencyLocationLabel(missing.expectedLocation)
          : '未知位置',
        symbol: '×',
        tone: 'danger',
        summary: '缺失',
      });
    }
  }

  return {
    hasEvidence: location.status !== 'notInstalled' || Boolean(cell.error),
    summary: cell.installState?.summary ?? location.issueSummary ?? location.statusLabel,
    diagnostics: [
      ...(cell.error
        ? [{
            label: '读取失败',
            value: cell.error,
            tone: 'danger' as const,
          }]
        : []),
      ...((location.detailHints ?? []).map((detail) => ({
        label: '说明',
        value: detail,
        tone: 'info' as const,
      }))),
    ],
    ...(dependencyEntries.length > 0 ? { dependencyEntries } : {}),
  };
}

function buildConsoleLocationSummary(options: {
  pluginName?: string;
  location: PluginConsoleLocation;
  readModel?: NonNullable<PluginConsoleProjectionOptions['locationReadModelByKey']>[string];
}): ConsoleLocationSummary {
  const { location } = options;
  const readModel = options.readModel;
  const issues = location.reasonCodes.map((reason) => createConsoleIssueSummary(reason, location));
  const suggestedFeatures = dedupeFeatureSummaries(
    location.actions
      .map((actionEntry) => featureSummaryFromAction(actionEntry))
      .filter((entry): entry is PluginConsoleFeatureSummary => entry !== undefined),
  );

  return {
    key: createPluginConsoleLocationKey({
      pluginName: options.pluginName ?? '',
      platform: location.platform,
      scope: location.scope,
      ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    }),
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    label: location.locationLabel,
    status: location.status,
    statusLabel: location.statusLabel,
    statusSymbol: pageStatusSymbol(location.status),
    statusTone: pageStatusTone(location.status),
    hasEvidence: readModel?.hasEvidence ?? location.status !== 'notInstalled',
    summary: readModel?.summary ?? location.issueSummary ?? location.statusLabel,
    ...(issues[0] ? { issue: issues[0] } : {}),
    issues,
    suggestedFeatures,
    ...createNextStepsBoundary(location.nextSteps, location.legacyNextSteps),
    diagnostics: readModel?.diagnostics ?? [],
  };
}

function dependencySummaryText(groups: ConsoleDependencyGroup[]): string | undefined {
  const entries = groups.flatMap((group) => group.entries);
  if (entries.length === 0) {
    return undefined;
  }

  const okCount = entries.filter((entry) => entry.symbol === '✓').length;
  const missingCount = entries.filter((entry) => entry.symbol === '×').length;
  const issueCount = entries.length - okCount - missingCount;

  const parts = [`${entries.length} 项`];
  if (missingCount > 0) {
    parts.push(`${missingCount} 个缺失`);
  }
  if (issueCount > 0) {
    parts.push(`${issueCount} 个异常`);
  }
  if (missingCount === 0 && issueCount === 0) {
    parts.push('全部正常');
  }

  return parts.join('，');
}

function buildDependencyPage(options: {
  pluginName: string;
  locations: PluginConsoleLocation[];
  locationReadModelByKey?: PluginConsoleProjectionOptions['locationReadModelByKey'];
}): ConsoleDependencyPageModel | undefined {
  const groups = options.locations
    .map((location) => {
      const key = createPluginConsoleLocationKey({
        pluginName: options.pluginName,
        platform: location.platform,
        scope: location.scope,
        ...(location.projectKey ? { projectKey: location.projectKey } : {}),
      });
      const entries = options.locationReadModelByKey?.[key]?.dependencyEntries ?? [];
      if (location.status === 'notInstalled' || entries.length === 0) {
        return null;
      }
      return {
        key,
        platform: location.platform,
        scope: location.scope,
        ...(location.projectKey ? { projectKey: location.projectKey } : {}),
        label: location.locationLabel,
        entries,
      } satisfies ConsoleDependencyGroup;
    })
    .filter((group): group is ConsoleDependencyGroup => group !== null);

  if (groups.length === 0) {
    return undefined;
  }

  return {
    pluginName: options.pluginName,
    groups,
    summary: dependencySummaryText(groups),
  };
}

function combineItemStatus(locations: PluginConsoleLocation[]): PluginConsoleStatus {
  if (locations.some((location) => location.status === 'abnormal')) {
    return 'abnormal';
  }
  if (locations.some((location) => location.status === 'upgradeAvailable')) {
    return 'upgradeAvailable';
  }
  if (locations.some((location) => location.status === 'installed')) {
    return 'installed';
  }
  return 'notInstalled';
}

function summarizeLocations(locations: PluginConsoleLocation[]): string {
  const actionableLocations = locations.filter((location) => location.status !== 'notInstalled');
  if (actionableLocations.length === 1) {
    return actionableLocations[0]!.locationLabel;
  }
  if (actionableLocations.length > 1) {
    const platforms = [...new Set(actionableLocations.map((location) => location.platform))];
    if (platforms.length === 1) {
      const platform = platforms[0]!;
      const scopes = new Set(actionableLocations.map((location) => location.scope));
      if (scopes.has('user') && scopes.has('project')) {
        return `${LOCATION_PLATFORM_LABELS[platform]}（个人 + 当前项目）`;
      }
      return LOCATION_PLATFORM_LABELS[platform];
    }
    return platforms.map((platform) => LOCATION_PLATFORM_LABELS[platform]).join('、');
  }
  if (locations.length === 1) {
    return locations[0]!.locationLabel;
  }
  return '多个位置';
}

function pickPrimaryLocation(locations: PluginConsoleLocation[]): PluginConsoleLocation | undefined {
  return [...locations].sort((left, right) =>
    STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status] ||
    (REASON_PRIORITY[right.reasonCodes[0] ?? 'adoptableInstall'] - REASON_PRIORITY[left.reasonCodes[0] ?? 'adoptableInstall']) ||
    sortLocations(left, right),
  )[0];
}

function supportedPlatformsForLocations(locations: PluginConsoleLocation[]): PlatformName[] | undefined {
  const platforms = dedupeStrings(locations.map((location) => location.platform)) as PlatformName[];
  return platforms.length > 0 ? platforms : undefined;
}

function toLocationSummary(location: PluginConsoleLocation): PluginConsoleLocationSummary {
  return {
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    label: location.locationLabel,
    status: location.status,
    statusLabel: location.statusLabel,
    reasonCodes: location.reasonCodes,
    ...(location.issueSummary ? { issueSummary: location.issueSummary } : {}),
    ...createNextStepsBoundary(location.nextSteps, location.legacyNextSteps),
  };
}

function buildDuplicateInstallGroups(
  pluginName: string,
  locations: PluginConsoleLocation[],
): PluginConsoleSummary['duplicateInstallGroups'] {
  const groups = new Map<PlatformName, PluginConsoleLocationSummary[]>();
  for (const location of locations) {
    if (!location.reasonCodes.includes('duplicateInstall')) {
      continue;
    }
    groups.set(location.platform, [
      ...(groups.get(location.platform) ?? []),
      toLocationSummary(location),
    ]);
  }

  const duplicates = [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([platform, entries]) => ({
      pluginName,
      platform,
      locations: entries.sort((left, right) =>
        sortLocations(
          {
            platform: left.platform,
            scope: left.scope,
            projectKey: left.projectKey,
            locationLabel: left.label,
            status: left.status,
            statusLabel: left.statusLabel,
            actions: [],
            reasonCodes: left.reasonCodes,
            ...createNextStepsBoundary(left.nextSteps, left.legacyNextSteps),
          },
          {
            platform: right.platform,
            scope: right.scope,
            projectKey: right.projectKey,
            locationLabel: right.label,
            status: right.status,
            statusLabel: right.statusLabel,
            actions: [],
            reasonCodes: right.reasonCodes,
            ...createNextStepsBoundary(right.nextSteps, right.legacyNextSteps),
          },
        ),
      ),
    }));

  return duplicates.length > 0 ? duplicates : undefined;
}

function featureKindForAction(actionEntry: PluginConsoleAction): PluginConsoleFeatureKind | undefined {
  switch (actionEntry.kind) {
    case 'openInstallWizard':
      return 'install';
    case 'openConfigWizard':
      return 'configure';
    case 'runUpgrade':
      return 'upgrade';
    case 'runUninstall':
      return 'uninstall';
    case 'runCleanup':
      return 'cleanup';
    case 'runReinstall':
      return 'reinstall';
    case 'runAdoptExisting':
      return 'adoptExisting';
    case 'runTakeoverSharedRuntime':
      return 'takeoverSharedRuntime';
    case 'repairInstall':
      return 'repair';
    case 'reapplyConfigRefresh':
      return 'reapplyConfigRefresh';
    case 'openStatus':
    case 'diagnoseCommand':
      return 'status';
    default:
      return undefined;
  }
}

function featureLabel(kind: PluginConsoleFeatureKind): string {
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
    case 'dependencies':
      return '依赖';
    case 'status':
      return '查看状态';
    case 'diagnose':
      return '查看诊断';
  }
}

function featureSummaryFromAction(actionEntry: PluginConsoleAction): PluginConsoleFeatureSummary | undefined {
  const kind = featureKindForAction(actionEntry);
  if (!kind) {
    return undefined;
  }

  return {
    kind,
    label: featureLabel(kind),
    targetSelection: kind === 'status' || kind === 'diagnose' ? 'none' : 'singleTarget',
    ...(actionEntry.disabledReason ? { disabledReason: actionEntry.disabledReason } : {}),
    ...(actionEntry.destructive ? { destructive: true } : {}),
  };
}

function dedupeFeatureSummaries(features: PluginConsoleFeatureSummary[]): PluginConsoleFeatureSummary[] {
  const deduped = new Map<string, PluginConsoleFeatureSummary>();
  for (const feature of features) {
    const key = [
      feature.kind,
      feature.label,
      feature.targetSelection,
      feature.disabledReason ?? '',
      feature.destructive === true ? 'yes' : 'no',
    ].join('\0');
    if (!deduped.has(key)) {
      deduped.set(key, feature);
    }
  }
  return [...deduped.values()].sort((left, right) =>
    featurePriority(right.kind) - featurePriority(left.kind) ||
    left.label.localeCompare(right.label),
  );
}

function createConsoleIssueSummary(
  reason: PluginConsoleReasonCode,
  location: PluginConsoleLocation,
): ConsoleIssueSummary {
  const copy = buildReasonCopy(reason, {
    pluginName: '',
    platform: location.platform,
    scope: location.scope,
    ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    executionCwd: '',
    health: 'ready',
    evidenceSources: [],
    healthSource: 'none',
    config: 'configured',
    scripts: 'declared',
  } as StatusMatrixCell);

  return {
    code: reason,
    label: reasonLabel(reason),
    severity: reasonSeverity(reason),
    summary: location.issueSummary ?? copy.issueSummary,
    suggestedFeatures: dedupeFeatureSummaries(
      location.actions
        .map((actionEntry) => featureSummaryFromAction(actionEntry))
        .filter((entry): entry is PluginConsoleFeatureSummary => entry !== undefined),
    ),
    ...(location.detailHints && location.detailHints.length > 0 ? { details: location.detailHints } : {}),
  };
}

export function createConsoleLocationSummary(
  location: PluginConsoleLocation,
): ConsoleLocationSummary {
  return buildConsoleLocationSummary({ location });
}

export function createStatusPageModel(
  item: Pick<ConsoleControllerItem, 'summary' | 'locations'>,
  locationReadModelByKey?: PluginConsoleProjectionOptions['locationReadModelByKey'],
): StatusPageModel {
  return {
    pluginName: item.summary.pluginName,
    summary: item.summary,
    locations: item.locations.map((location) => {
      const key = createPluginConsoleLocationKey({
        pluginName: item.summary.pluginName,
        platform: location.platform,
        scope: location.scope,
        ...(location.projectKey ? { projectKey: location.projectKey } : {}),
      });
      return {
        ...buildConsoleLocationSummary({
          pluginName: item.summary.pluginName,
          location,
          readModel: locationReadModelByKey?.[key],
        }),
        key,
      };
    }),
  };
}

function featurePriority(kind: PluginConsoleFeatureKind): number {
  switch (kind) {
    case 'install':
      return 100;
    case 'upgrade':
      return 95;
    case 'repair':
      return 90;
    case 'cleanup':
      return 78;
    case 'configure':
      return 80;
    case 'adoptExisting':
      return 75;
    case 'takeoverSharedRuntime':
      return 70;
    case 'resolveDuplicateInstall':
      return 65;
    case 'reapplyConfigRefresh':
      return 60;
    case 'dependencies':
      return 12;
    case 'uninstall':
      return 55;
    case 'reinstall':
      return 50;
    case 'status':
      return 10;
    case 'diagnose':
      return 5;
  }
}

function featureSelectionMode(
  kind: PluginConsoleFeatureKind,
  locations: PluginConsoleLocation[],
): PluginConsoleFeatureSummary['targetSelection'] {
  if (kind === 'status' || kind === 'diagnose' || kind === 'dependencies') {
    return 'none';
  }
  if (
    kind === 'adoptExisting'
    || kind === 'takeoverSharedRuntime'
    || kind === 'resolveDuplicateInstall'
  ) {
    return 'singleTargetOnly';
  }

  const distinctPlatforms = new Set(locations.map((location) => location.platform)).size;
  if (distinctPlatforms > 1) {
    return 'multiTargetAllowed';
  }

  const distinctTargets = new Set(locations.map((location) =>
    `${location.platform}:${location.scope}:${location.projectKey ?? '-'}`,
  )).size;
  return distinctTargets > 1 ? 'singleTargetOnly' : 'singleTarget';
}

function buildSummaryFeatures(
  summaryStatus: PluginConsoleStatus,
  itemReasonCodes: PluginConsoleReasonCode[],
  locations: PluginConsoleLocation[],
  duplicateInstallGroups: PluginConsoleSummary['duplicateInstallGroups'],
  dependencyPage: ConsoleDependencyPageModel | undefined,
  configProjection: PluginConsoleConfigProjection | undefined,
): PluginConsoleFeatureSummary[] {
  const featureMap = new Map<PluginConsoleFeatureKind, {
    actions: PluginConsoleAction[];
    locations: PluginConsoleLocation[];
    destructive: boolean;
  }>();

  const pushFeatureCandidate = (
    kind: PluginConsoleFeatureKind,
    location: PluginConsoleLocation,
    actionEntry: PluginConsoleAction,
  ): void => {
    const existing = featureMap.get(kind);
    if (existing) {
      existing.actions.push(actionEntry);
      existing.locations.push(location);
      existing.destructive = existing.destructive || actionEntry.destructive === true;
      return;
    }
    featureMap.set(kind, {
      actions: [actionEntry],
      locations: [location],
      destructive: actionEntry.destructive === true,
    });
  };

  for (const location of locations) {
    for (const actionEntry of location.actions) {
      const kind = featureKindForAction(actionEntry);
      if (!kind) {
        continue;
      }
      pushFeatureCandidate(kind, location, actionEntry);
    }
  }

  if (itemReasonCodes.includes('duplicateInstall') && duplicateInstallGroups && duplicateInstallGroups.length > 0) {
    const duplicateLocations = locations.filter((location) => location.reasonCodes.includes('duplicateInstall'));
    featureMap.set('resolveDuplicateInstall', {
      actions: [],
      locations: duplicateLocations,
      destructive: true,
    });
  }

  featureMap.set('status', {
    actions: [],
    locations: [],
    destructive: false,
  });
  if (dependencyPage && dependencyPage.groups.length > 0) {
    featureMap.set('dependencies', {
      actions: [],
      locations: [],
      destructive: false,
    });
  }

  return [...featureMap.entries()]
    .map(([kind, aggregate]) => {
      const enabled = aggregate.actions.some((actionEntry) => !actionEntry.disabledReason);
      const disabledReasons = dedupeStrings(
        aggregate.actions
          .map((actionEntry) => actionEntry.disabledReason ?? '')
          .filter((reason) => reason.length > 0),
      );
      const reasonCodes = dedupeReasons(
        aggregate.locations.flatMap((location) => location.reasonCodes),
      );
      return {
        kind,
        label: featureLabel(kind),
        targetSelection: featureSelectionMode(kind, aggregate.locations),
        ...(!enabled && disabledReasons.length > 0 ? { disabledReason: disabledReasons[0] } : {}),
        ...(reasonCodes.length > 0 ? { reasonCodes } : {}),
        ...(aggregate.destructive || kind === 'resolveDuplicateInstall' ? { destructive: true } : {}),
      } satisfies PluginConsoleFeatureSummary;
    })
    .filter((feature) => {
      if (feature.kind === 'configure' && !configProjection) {
        return false;
      }
      if (feature.kind === 'install') {
        return summaryStatus === 'notInstalled' || feature.disabledReason !== undefined;
      }
      return true;
    })
    .sort((left, right) =>
      featurePriority(right.kind) - featurePriority(left.kind) ||
      left.label.localeCompare(right.label),
    );
}

function pageStatusIcon(status: PluginConsoleStatus): string {
  return pageStatusSymbol(status);
}

function pageStatusTone(status: PluginConsoleStatus): PluginConsoleTone {
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

function primaryFeatureLabel(summary: PluginConsoleSummary): string | undefined {
  return summary.features.find((feature) =>
    feature.kind !== 'status' &&
    feature.kind !== 'diagnose' &&
    feature.kind !== 'dependencies' &&
    feature.disabledReason === undefined,
  )?.label;
}

function createConsolePageItem(summary: PluginConsoleSummary): ConsolePageItem {
  return {
    summary,
    statusSymbol: pageStatusIcon(summary.status),
    statusTone: pageStatusTone(summary.status),
    platformSummary: summary.locationSummary ?? '未安装',
    ...(summary.description ? { description: summary.description } : {}),
    ...(summary.version ? { version: summary.version } : {}),
    ...(primaryFeatureLabel(summary) ? { primaryActionLabel: primaryFeatureLabel(summary) } : {}),
  };
}

function executableKindForFeature(
  featureKind: PluginConsoleFeatureKind,
): PluginConsoleExecutableActionKind {
  switch (featureKind) {
    case 'install':
      return 'runInstall';
    case 'upgrade':
      return 'runUpgrade';
    case 'configure':
      return 'runConfig';
    case 'uninstall':
      return 'runUninstall';
    case 'repair':
      return 'runRepair';
    case 'cleanup':
      return 'runCleanup';
    case 'reinstall':
      return 'runReinstall';
    case 'adoptExisting':
      return 'runAdoptExisting';
    case 'takeoverSharedRuntime':
      return 'runTakeoverSharedRuntime';
    case 'resolveDuplicateInstall':
      return 'resolveDuplicateInstall';
    case 'reapplyConfigRefresh':
      return 'runReapplyConfigRefresh';
    case 'dependencies':
      return 'openDependencies';
    case 'status':
      return 'openStatus';
    case 'diagnose':
      return 'openDiagnose';
  }
}

function actionMatchesFeature(
  actionEntry: PluginConsoleAction,
  featureKind: PluginConsoleFeatureKind,
): boolean {
  switch (featureKind) {
    case 'install':
      return actionEntry.kind === 'openInstallWizard';
    case 'upgrade':
      return actionEntry.kind === 'runUpgrade';
    case 'configure':
      return actionEntry.kind === 'openConfigWizard';
    case 'uninstall':
      return actionEntry.kind === 'runUninstall';
    case 'repair':
      return actionEntry.kind === 'repairInstall';
    case 'cleanup':
      return actionEntry.kind === 'runCleanup';
    case 'reinstall':
      return actionEntry.kind === 'runReinstall';
    case 'adoptExisting':
      return actionEntry.kind === 'runAdoptExisting';
    case 'takeoverSharedRuntime':
      return actionEntry.kind === 'runTakeoverSharedRuntime';
    case 'resolveDuplicateInstall':
      return false;
    case 'reapplyConfigRefresh':
      return actionEntry.kind === 'reapplyConfigRefresh';
    case 'dependencies':
      return false;
    case 'status':
    case 'diagnose':
      return false;
  }
}

export function createPluginConsoleExecutableActions(
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
): PluginConsoleExecutableAction[] {
  if (featureKind === 'status' || featureKind === 'diagnose' || featureKind === 'dependencies') {
    return [{
      kind: executableKindForFeature(featureKind),
      label: featureLabel(featureKind),
    }];
  }

  if (featureKind === 'resolveDuplicateInstall') {
    return (item.summary.duplicateInstallGroups ?? [])
      .flatMap((group) => group.locations)
      .map((location) => ({
        kind: 'resolveDuplicateInstall',
        label: location.scope === 'user' ? '保留个人位置' : '保留当前项目位置',
        target: {
          platform: location.platform,
          scope: location.scope,
          ...(location.projectKey ? { projectKey: location.projectKey } : {}),
        },
        targetPolicy: 'singleTargetOnly',
        destructive: true,
        confirmText: location.scope === 'user'
          ? `确定保留 ${LOCATION_PLATFORM_LABELS[location.platform]} 的个人位置，并移除另一处重复安装吗？`
          : `确定保留 ${LOCATION_PLATFORM_LABELS[location.platform]} 的当前项目位置，并移除另一处重复安装吗？`,
      }));
  }

  const policy = item.summary.features.find((feature) => feature.kind === featureKind)?.targetSelection;
  const executableKind = executableKindForFeature(featureKind);
  return item.locations
    .flatMap((location) => location.actions
      .filter((actionEntry) => actionMatchesFeature(actionEntry, featureKind))
      .map((actionEntry) => ({
        kind: executableKind,
        label: featureLabel(featureKind),
        ...(actionEntry.target ? { target: actionEntry.target } : {}),
        ...(policy === 'multiTargetAllowed' || policy === 'singleTargetOnly'
          ? { targetPolicy: policy }
          : {}),
        ...(actionEntry.destructive ? { destructive: true } : {}),
        ...(actionEntry.confirmText ? { confirmText: actionEntry.confirmText } : {}),
        ...(actionEntry.disabledReason ? { disabledReason: actionEntry.disabledReason } : {}),
      } satisfies PluginConsoleExecutableAction)));
}

export function createConsolePluginDetailPageModel(
  item: ConsoleControllerItem,
  featureKind?: PluginConsoleFeatureKind,
): ConsolePluginDetailPageModel {
  const recommendedKind = item.summary.features.find((feature) =>
    feature.kind !== 'status' &&
    feature.kind !== 'diagnose' &&
    feature.kind !== 'dependencies' &&
    feature.disabledReason === undefined,
  )?.kind;
  const targetOptions = featureKind
    ? createPluginConsoleExecutableActions(item, featureKind)
      .filter((actionEntry) => actionEntry.target)
      .map((actionEntry) => {
        const target = actionEntry.target!;
        const location = item.locations.find((entry) =>
          entry.platform === target.platform &&
          entry.scope === target.scope &&
          (target.projectKey === undefined || entry.projectKey === target.projectKey),
        );
        if (!location) {
          throw new Error(`Missing console location for ${item.summary.pluginName} target ${target.platform}/${target.scope}.`);
        }

        return {
          platform: location.platform,
          scope: location.scope,
          ...(location.projectKey ? { projectKey: location.projectKey } : {}),
          label: featureKind === 'resolveDuplicateInstall'
            ? target.scope === 'user' ? '保留个人位置' : '保留当前项目位置'
            : location.locationLabel,
          status: location.status,
          statusLabel: location.statusLabel,
          reasonCodes: location.reasonCodes,
          ...(actionEntry.disabledReason ? { disabledReason: actionEntry.disabledReason } : {}),
        } satisfies PluginConsoleTargetOption;
      })
    : [];

  return {
    summary: item.summary,
    statusSymbol: pageStatusSymbol(item.summary.status),
    statusTone: pageStatusTone(item.summary.status),
    platformSummary: item.summary.locationSummary ?? '未安装',
    platformDetails: item.locations.map((location) => ({
      label: location.locationLabel,
      status: location.status,
      statusLabel: location.statusLabel,
      statusSymbol: pageStatusSymbol(location.status),
      statusTone: pageStatusTone(location.status),
    })),
    ...(item.dependencyPage?.summary ? { dependencySummary: item.dependencyPage.summary } : {}),
    featureMenu: item.summary.features.map((feature) => ({
      ...feature,
      ...(feature.kind === recommendedKind ? { recommended: true } : {}),
    })),
    targetOptions,
  };
}

function legacyConfigStoreLabel(storeKind: LegacyConfigStoreEntryV2['storeKind']): string {
  switch (storeKind) {
    case 'user':
      return '个人配置';
    case 'projectShared':
      return '当前项目配置';
    case 'projectLocal':
      return '当前项目本地配置';
  }
}

function summarizeLegacyConfigProjection(
  projection: PluginConsoleConfigProjection,
): {
  locationSummary: string;
  issueSummary: string;
  detailHints: string[];
} {
  const stores = projection.views.flatMap((view) => view.legacyConfigStores);
  const fieldStoreLabels = projection.views.flatMap((view) =>
    view.fields.flatMap((field) => {
      if (field.storedSourceLayer === 'user') {
        return ['个人配置'];
      }
      if (field.storedSourceLayer === 'project') {
        return ['当前项目配置'];
      }
      if (field.storedSourceLayer === 'local') {
        return ['当前项目本地配置'];
      }
      return [];
    }));
  const labels = dedupeStrings([
    ...stores.map((store) => legacyConfigStoreLabel(store.storeKind)),
    ...fieldStoreLabels,
  ]);
  const locationSummary = labels.length === 0
    ? '旧配置残留'
    : labels.length === 1
      ? `${labels[0]}残留`
      : `${labels.join('、')}残留`;
  const detailHints = stores.map((store) => {
    const scopeLabel = legacyConfigStoreLabel(store.storeKind);
    const reason = store.reason === 'pluginRemoved'
      ? '插件已经不在当前目录中'
      : '当前 schema 已无法解释这些值';
    return `${scopeLabel}存在 store-only 旧残留，${reason}，只能按 store 整层清理。`;
  });

  return {
    locationSummary,
    issueSummary: '检测到需要手动清理的配置残留，当前不会把它当作可安装、可升级或可应用的插件条目。',
    detailHints: dedupeStrings([
      ...detailHints,
      ...projection.views.flatMap((view) =>
        view.fields.flatMap((field) => {
          if (field.valueState === 'orphaned') {
            return [`${field.title} 只剩旧配置残留，可以在配置页清理。`];
          }
          if (field.valueState === 'ignored') {
            return [`${field.title} 存在已忽略的旧配置，可以在配置页清理。`];
          }
          if (field.valueState === 'invalid' && field.storedSourceLayer === 'local') {
            return [`${field.title} 在项目本地层存在无效旧值，只能整层清理。`];
          }
          return [];
        })),
    ]),
  };
}

export function createLegacyConfigPlaceholderControllerItem(options: {
  pluginName: string;
  title?: string;
  config: PluginConsoleConfigProjection;
}): ConsoleControllerItem {
  const copy = summarizeLegacyConfigProjection(options.config);
  const summary: PluginConsoleSummary = {
    pluginName: options.pluginName,
    title: options.title ?? options.pluginName,
    description: '检测到需要手动查看或清理的配置残留。',
    status: 'abnormal',
    statusLabel: PLUGIN_CONSOLE_STATUS_LABELS.abnormal,
    locationSummary: copy.locationSummary,
    installedLocations: [],
    features: [{
      kind: 'configure',
      label: '配置',
      targetSelection: 'none',
    }],
    reasonCodes: [],
    issueSummary: copy.issueSummary,
    detailHints: copy.detailHints,
    config: options.config,
    ...createNextStepsBoundary([
      createManualNextStep('查看残留范围', '先查看这个条目的残留范围，再决定后续如何整层清理。'),
    ]),
  };
  const detailPage: ConsolePluginDetailPageModel = {
    summary,
    statusSymbol: pageStatusSymbol(summary.status),
    statusTone: pageStatusTone(summary.status),
    platformSummary: summary.locationSummary ?? '配置残留',
    platformDetails: [],
    featureMenu: summary.features.map((feature) => ({ ...feature })),
    targetOptions: [],
  };
  return {
    summary,
    pageItem: createConsolePageItem(summary),
    detailPage,
    locations: [],
    statusPage: {
      pluginName: summary.pluginName,
      summary,
      locations: [],
    },
    blockingMessage: copy.issueSummary,
  };
}

function sortControllerItems(left: ConsoleControllerItem, right: ConsoleControllerItem): number {
  return STATUS_PRIORITY[right.summary.status] - STATUS_PRIORITY[left.summary.status] ||
    left.summary.title.localeCompare(right.summary.title);
}

export function resolvePluginConsoleMeta(plugin: PluginMeta | undefined): PluginConsolePluginMeta | undefined {
  if (!plugin) {
    return undefined;
  }

  return {
    title: plugin.manifest.interface?.displayName ?? plugin.manifest.name,
    description: plugin.manifest.interface?.shortDescription ?? plugin.manifest.description,
    version: plugin.manifest.version,
  };
}

export function createConsoleControllerItems(
  matrix: StatusMatrixReport,
  options: ConsoleControllerProjectionOptions = {},
): ConsoleControllerItem[] {
  const cellsByPlugin = new Map<string, StatusMatrixCell[]>();
  for (const cell of matrix.cells) {
    cellsByPlugin.set(cell.pluginName, [...(cellsByPlugin.get(cell.pluginName) ?? []), cell]);
  }

  return [...cellsByPlugin.entries()]
    .map(([pluginName, cells]) => {
      const locations = cells
        .map((cell) => buildLocation(
          cell,
          options.locationDiagnosticsByKey?.[createPluginConsoleLocationKey(cell)],
          options.configProjectionByPluginName?.[pluginName],
        ))
        .sort(sortLocations);
      const locationReadModelByKey: Record<string, ConsoleLocationReadModel> = {
        ...Object.fromEntries(cells.map((cell) => {
          const key = createPluginConsoleLocationKey(cell);
          const location = locations.find((entry) =>
            entry.platform === cell.platform &&
            entry.scope === cell.scope &&
            (entry.projectKey ?? null) === (cell.projectKey ?? null),
          );
          if (!location) {
            return [key, { hasEvidence: false }] satisfies [string, ConsoleLocationReadModel];
          }
          return [key, createFallbackLocationReadModel(cell, location)] satisfies [string, ConsoleLocationReadModel];
        })),
        ...(options.locationReadModelByKey ?? {}),
      };
      const status = combineItemStatus(locations);
      const primaryLocation = pickPrimaryLocation(locations);
      const reasonCodes = dedupeReasons(locations.flatMap((location) => location.reasonCodes));
      const itemCopy = primaryLocation
        ? {
            issueSummary: primaryLocation.issueSummary,
            detailHints: dedupeStrings(locations.flatMap((location) => location.detailHints ?? [])).slice(0, 6),
            nextSteps: dedupeConsoleNextSteps(locations.flatMap((location) => location.nextSteps)),
          }
        : { nextSteps: [] };
      const meta = options.pluginMetaByName?.[pluginName];
      const duplicateInstallGroups = buildDuplicateInstallGroups(pluginName, locations);
      const dependencyPage = buildDependencyPage({
        pluginName,
        locations,
        locationReadModelByKey,
      });
      const summary: PluginConsoleSummary = {
        pluginName,
        title: meta?.title ?? pluginName,
        ...(meta?.description ? { description: meta.description } : {}),
        ...(meta?.version ? { version: meta.version } : {}),
        status,
        statusLabel: PLUGIN_CONSOLE_STATUS_LABELS[status],
        locationSummary: summarizeLocations(locations),
        ...(supportedPlatformsForLocations(locations) ? { supportedPlatforms: supportedPlatformsForLocations(locations) } : {}),
        installedLocations: locations.map(toLocationSummary),
        ...(duplicateInstallGroups ? { duplicateInstallGroups } : {}),
        features: buildSummaryFeatures(
          status,
          reasonCodes,
          locations,
          duplicateInstallGroups,
          dependencyPage,
          options.configProjectionByPluginName?.[pluginName],
        ),
        reasonCodes,
        ...(itemCopy.issueSummary ? { issueSummary: itemCopy.issueSummary } : {}),
        ...(itemCopy.detailHints && itemCopy.detailHints.length > 0 ? { detailHints: itemCopy.detailHints } : {}),
        ...(options.configProjectionByPluginName?.[pluginName]
          ? { config: options.configProjectionByPluginName[pluginName] }
          : {}),
        ...createNextStepsBoundary(itemCopy.nextSteps),
      };
      const recommendedFeatureKind = primaryLocation?.actions
        .map((actionEntry) => featureKindForAction(actionEntry))
        .find((kind) =>
          kind !== undefined &&
          kind !== 'status' &&
          kind !== 'diagnose' &&
          kind !== 'dependencies',
        );
      const detailPage: ConsolePluginDetailPageModel = {
        summary,
        statusSymbol: pageStatusSymbol(summary.status),
        statusTone: pageStatusTone(summary.status),
        platformSummary: summary.locationSummary ?? '未安装',
        platformDetails: locations.map((location) => ({
          label: location.locationLabel,
          status: location.status,
          statusLabel: location.statusLabel,
          statusSymbol: pageStatusSymbol(location.status),
          statusTone: pageStatusTone(location.status),
        })),
        ...(dependencyPage?.summary ? { dependencySummary: dependencyPage.summary } : {}),
        featureMenu: summary.features.map((feature) => ({
          ...feature,
          ...(feature.kind === recommendedFeatureKind ? { recommended: true } : {}),
        })),
        targetOptions: [],
      };
      const statusPage = createStatusPageModel({
        summary,
        locations,
      }, locationReadModelByKey);
      return {
        summary,
        pageItem: createConsolePageItem(summary),
        detailPage,
        locations,
        statusPage,
        ...(dependencyPage ? { dependencyPage } : {}),
        ...(status === 'abnormal'
          ? { blockingMessage: itemCopy.issueSummary ?? primaryLocation?.issueSummary }
          : {}),
      } satisfies ConsoleControllerItem;
    })
    .sort(sortControllerItems);
}

export function createPluginConsoleItems(
  matrix: StatusMatrixReport,
  options: PluginConsoleProjectionOptions = {},
): PluginConsoleSummary[] {
  return createConsoleControllerItems(matrix, options).map((item) => item.summary);
}
