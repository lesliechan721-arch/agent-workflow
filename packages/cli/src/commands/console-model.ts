import type { StatusMatrixCell, StatusMatrixReport } from './status.js';
import type {
  GeneratedArtifactSessionVisibility,
  ManagedArtifactStatus,
  PlatformName,
  PluginStatusReport,
  RepoManagedProjectItemReport,
  RepoManagedProjectItemState,
  Scope,
} from '../types.js';

export type PluginConsoleStatus =
  | 'notInstalled'
  | 'installed'
  | 'upgradeAvailable'
  | 'needsAction'
  | 'partial'
  | 'external';

export type PluginConsoleActionKind =
  | 'openInstallWizard'
  | 'openConfigWizard'
  | 'runInstall'
  | 'runUpgrade'
  | 'runUninstall'
  | 'repairInstall'
  | 'cleanupRecovery'
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

export type PluginConsoleReasonCode =
  | 'nativeIncomplete'
  | 'nativeResidue'
  | 'missingRecord'
  | 'upgradeEvidenceUnknown'
  | 'artifactRefreshFailed'
  | 'artifactDrift'
  | 'projectVisibilityBlocked'
  | 'sessionVisibilityLimited'
  | 'externalOwnership'
  | 'requiredConfigMissing'
  | 'invalidConfig'
  | 'unreadableConfig'
  | 'trackingIdentityBroken'
  | 'roleOrMcpConflict'
  | 'unmanagedArtifactConflict'
  | 'catalogCapabilityChanged'
  | 'catalogUnavailable';

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
  nextSteps: string[];
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
  nextSteps: string[];
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
}

export const PLUGIN_CONSOLE_STATUS_LABELS: Record<PluginConsoleStatus, string> = {
  notInstalled: '未安装',
  installed: '已安装',
  upgradeAvailable: '可升级',
  needsAction: '需要处理',
  partial: '部分可用',
  external: '由其它来源管理',
};

const LOCATION_PLATFORM_LABELS: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

const STATUS_PRIORITY: Record<PluginConsoleStatus, number> = {
  needsAction: 5,
  partial: 4,
  upgradeAvailable: 3,
  installed: 2,
  external: 1,
  notInstalled: 0,
};

const REASON_PRIORITY: Record<PluginConsoleReasonCode, number> = {
  externalOwnership: 100,
  nativeIncomplete: 95,
  nativeResidue: 94,
  missingRecord: 93,
  unreadableConfig: 92,
  trackingIdentityBroken: 91,
  roleOrMcpConflict: 90,
  unmanagedArtifactConflict: 89,
  catalogCapabilityChanged: 88,
  upgradeEvidenceUnknown: 87,
  artifactRefreshFailed: 86,
  artifactDrift: 85,
  requiredConfigMissing: 84,
  invalidConfig: 83,
  projectVisibilityBlocked: 60,
  sessionVisibilityLimited: 59,
  catalogUnavailable: 20,
};

const WRITE_ACTION_KINDS = new Set<PluginConsoleActionKind>([
  'runInstall',
  'runUpgrade',
  'runUninstall',
  'repairInstall',
  'cleanupRecovery',
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

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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

function collectReasonCodes(
  cell: StatusMatrixCell,
  locationDiagnostics: PluginConsoleLocationDiagnostics | undefined,
): PluginConsoleReasonCode[] {
  const report = cell.report;
  const reasons = new Set<PluginConsoleReasonCode>();
  const managedEvidence = hasManagedEvidence(report);
  const runtimeEvidence = hasRuntimeEvidence(report);
  const externalOwnership = hasExternalOwnership(report);

  if (cell.config === 'missing-required') {
    reasons.add('requiredConfigMissing');
  }
  if (cell.config === 'invalid-config') {
    reasons.add('invalidConfig');
  }
  if (hasUnreadableConfigSignal(cell)) {
    reasons.add('unreadableConfig');
  }
  if (report?.catalogCompatibility === 'capabilityChanged') {
    reasons.add('catalogCapabilityChanged');
  }
  if (catalogUnavailable(report)) {
    reasons.add('catalogUnavailable');
  }
  if (hasArtifactRefreshFailure(report)) {
    reasons.add('artifactRefreshFailed');
  }
  if (hasArtifactDrift(report)) {
    reasons.add('artifactDrift');
  }
  if (hasTrackingIdentitySignal(cell)) {
    reasons.add('trackingIdentityBroken');
  }
  if (hasRoleOrMcpConflictSignal(cell)) {
    reasons.add('roleOrMcpConflict');
  }
  if (hasUnmanagedArtifactConflictSignal(cell)) {
    reasons.add('unmanagedArtifactConflict');
  }

  if (
    report?.repoManagedSessionState?.items?.some((item) => hasProjectVisibilityState(item.state)) ||
    report?.managedArtifacts?.some((artifact) => hasProjectVisibilityState(artifact.sessionVisibility)) ||
    (cell.scope === 'project' &&
      (report?.projectTrust === 'untrusted' || report?.projectTrust === 'unknown') &&
      managedEvidence)
  ) {
    reasons.add('projectVisibilityBlocked');
  }

  if (
    report?.managedArtifacts?.some((artifact) => hasSessionVisibilityState(artifact.sessionVisibility)) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.instructions) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.rules) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.hooks) ||
    hasSessionVisibilityState(report?.repoManagedSessionState?.agents)
  ) {
    reasons.add('sessionVisibilityLimited');
  }

  if (externalOwnership) {
    reasons.add('externalOwnership');
  }

  if (isCodexUserNativeCell(cell) && report) {
    const installed = report.native.pluginInstalled;
    const enabled = report.native.pluginEnabled === true;
    const recovery = report.native.recovery;
    const scopeRecorded = report.scopeManagedEvidence?.ledger === true;

    if (recovery?.present) {
      reasons.add(recovery.evidenceMatches === false ? 'nativeResidue' : 'nativeIncomplete');
    } else if ((installed && !enabled) || (!installed && enabled)) {
      reasons.add('nativeResidue');
    } else if (installed && enabled && !scopeRecorded) {
      reasons.add('missingRecord');
    }
  } else if (report && runtimeEvidence && !managedEvidence && !externalOwnership) {
    reasons.add('missingRecord');
  }

  if (locationDiagnostics?.upgradeState === 'unknown') {
    reasons.add('upgradeEvidenceUnknown');
  }

  return dedupeReasons([...reasons]);
}

function installedEvidenceHealthy(cell: StatusMatrixCell, reasons: PluginConsoleReasonCode[]): boolean {
  const report = cell.report;
  if (!report) {
    return false;
  }

  const blockingReasons = reasons.filter((reason) =>
    reason !== 'catalogUnavailable' &&
    reason !== 'projectVisibilityBlocked' &&
    reason !== 'sessionVisibilityLimited',
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

function pureExternal(report: PluginStatusReport | undefined): boolean {
  return hasExternalOwnership(report) &&
    !hasManagedEvidence(report) &&
    !hasRuntimeEvidence(report) &&
    report?.native.recovery?.present !== true;
}

function computeLocationStatus(
  cell: StatusMatrixCell,
  reasons: PluginConsoleReasonCode[],
  locationDiagnostics: PluginConsoleLocationDiagnostics | undefined,
): PluginConsoleStatus {
  const report = cell.report;

  if (pureExternal(report)) {
    return 'external';
  }

  if (reasons.some((reason) =>
    reason === 'externalOwnership' ||
    reason === 'nativeIncomplete' ||
    reason === 'nativeResidue' ||
    reason === 'missingRecord' ||
    reason === 'upgradeEvidenceUnknown' ||
    reason === 'artifactRefreshFailed' ||
    reason === 'artifactDrift' ||
    reason === 'requiredConfigMissing' ||
    reason === 'invalidConfig' ||
    reason === 'unreadableConfig' ||
    reason === 'trackingIdentityBroken' ||
    reason === 'roleOrMcpConflict' ||
    reason === 'unmanagedArtifactConflict' ||
    reason === 'catalogCapabilityChanged'
  )) {
    return 'needsAction';
  }

  if (reasons.includes('projectVisibilityBlocked') || reasons.includes('sessionVisibilityLimited')) {
    return 'partial';
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

  return hasManagedEvidence(report) || hasRuntimeEvidence(report) ? 'needsAction' : 'notInstalled';
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

function buildReasonCopy(
  reason: PluginConsoleReasonCode,
  cell: StatusMatrixCell,
): { issueSummary: string; detailHints: string[]; nextSteps: string[] } {
  const location = pluginConsoleLocationLabel(cell);

  switch (reason) {
    case 'nativeIncomplete':
      return {
        issueSummary: 'Codex 侧已写入，但 AW 还没完成收尾。',
        detailHints: ['可以先尝试修复安装；如果只想清理这次未完成安装，再执行受控清理。'],
        nextSteps: ['先处理这个位置的修复动作，再重新检查状态。'],
      };
    case 'nativeResidue':
      return {
        issueSummary: 'Codex 里发现了插件残留，AW 还不能确认归属。',
        detailHints: ['先查看诊断，再决定是否手动清理。'],
        nextSteps: ['不要直接覆盖当前残留，先确认来源。'],
      };
    case 'missingRecord':
      return {
        issueSummary: '插件已经存在，但 AW 缺少完整安装记录。',
        detailHints: ['通常需要重新补齐安装，让 AW 能重新接管这个位置。'],
        nextSteps: ['先执行修复安装，再重新查看状态。'],
      };
    case 'upgradeEvidenceUnknown':
      return {
        issueSummary: 'AW 还不能确认当前安装版本。',
        detailHints: ['先修复安装记录，再决定是否升级。'],
        nextSteps: ['不要直接把它当成可升级，先补齐版本证据。'],
      };
    case 'artifactRefreshFailed':
      return {
        issueSummary: '配置已经保存，但相关项目文件刷新失败。',
        detailHints: ['重新应用配置不会改动已保存的值，只会重试更新项目文件。'],
        nextSteps: ['先重新应用配置；如果还失败，再看诊断命令。'],
      };
    case 'artifactDrift':
      return {
        issueSummary: '已写入的项目文件被修改或缺失。',
        detailHints: ['如果这是预期手改，请先确认是否还要继续由 AW 管理。'],
        nextSteps: ['优先修复安装，必要时再卸载重装。'],
      };
    case 'projectVisibilityBlocked':
      return {
        issueSummary: '项目文件已经写入，但当前会话还不能稳定使用。',
        detailHints: ['先确认当前仓库是否已被工具信任，再重新打开会话。'],
        nextSteps: ['先处理仓库信任或重新打开会话，再重新检查状态。'],
      };
    case 'sessionVisibilityLimited':
      return {
        issueSummary: '插件已经写入，但当前会话可能没有用到这份内容。',
        detailHints: ['当前仓库里可能有更高优先级的同名内容。'],
        nextSteps: ['先确认当前会话实际使用的是哪一份内容。'],
      };
    case 'externalOwnership':
      return {
        issueSummary: '同名插件已经由其它来源管理。',
        detailHints: ['先解除同名占用，再决定是否迁回 AW 管理。'],
        nextSteps: ['先看诊断命令确认占用来源。'],
      };
    case 'requiredConfigMissing':
      return {
        issueSummary: '这个插件还缺少必填配置。',
        detailHints: [`补齐 ${location} 的配置后，再重新检查状态。`],
        nextSteps: ['先打开配置向导补齐必填项。'],
      };
    case 'invalidConfig':
      return {
        issueSummary: '已保存的配置目前无效。',
        detailHints: ['路径、枚举值或数值范围可能需要重新确认。'],
        nextSteps: ['先打开配置向导修正现有配置。'],
      };
    case 'unreadableConfig':
      return {
        issueSummary: 'AW 现在读不出这个插件的配置。',
        detailHints: ['先修复配置文件，再重新运行状态检查。'],
        nextSteps: ['先查看诊断命令，再处理配置文件。'],
      };
    case 'trackingIdentityBroken':
      return {
        issueSummary: 'AW 现在无法安全确认这组项目文件的归属。',
        detailHints: ['在归属关系恢复前，不要直接让 AW 自动接管或清理。'],
        nextSteps: ['先看诊断命令，再修复归属记录。'],
      };
    case 'roleOrMcpConflict':
      return {
        issueSummary: '当前项目里已经有同名角色或 MCP 配置。',
        detailHints: ['先解决命名冲突，再继续由 AW 管理这个位置。'],
        nextSteps: ['先查看诊断命令确认冲突位置。'],
      };
    case 'unmanagedArtifactConflict':
      return {
        issueSummary: '当前项目里已经有同名项目文件，但不属于 AW 管理。',
        detailHints: ['先确认这些文件是否要保留，再决定是否交给 AW 接管。'],
        nextSteps: ['先看诊断命令确认冲突文件。'],
      };
    case 'catalogCapabilityChanged':
      return {
        issueSummary: '插件当前版本的能力和现有安装记录不一致。',
        detailHints: ['通常需要重新安装或升级，才能让当前位置和当前插件定义重新对齐。'],
        nextSteps: ['先执行重新安装或升级，再重新检查状态。'],
      };
    case 'catalogUnavailable':
      return {
        issueSummary: '当前插件目录暂时不可用。',
        detailHints: ['在插件目录恢复前，升级和基于 schema 的配置都会先隐藏。'],
        nextSteps: ['先恢复插件目录，或者只保留卸载和诊断。'],
      };
  }
}

function composeCopy(
  reasons: PluginConsoleReasonCode[],
  cell: StatusMatrixCell,
): { issueSummary?: string; detailHints?: string[]; nextSteps: string[] } {
  if (reasons.length === 0) {
    return { nextSteps: [] };
  }

  const copies = reasons.map((reason) => buildReasonCopy(reason, cell));
  return {
    issueSummary: copies[0]?.issueSummary,
    detailHints: dedupeStrings(copies.flatMap((copy) => copy.detailHints)),
    nextSteps: dedupeStrings(copies.flatMap((copy) => copy.nextSteps)),
  };
}

function supportsConfigAction(cell: StatusMatrixCell): boolean {
  return catalogUsable(cell.report) && cell.report?.currentCatalog?.available === true;
}

function buildLocationActions(
  cell: StatusMatrixCell,
  status: PluginConsoleStatus,
  reasons: PluginConsoleReasonCode[],
): PluginConsoleAction[] {
  const target = locationTarget(cell);
  const diagnose = action('diagnoseCommand', '查看诊断命令', target, {
    command: baseStatusCommand(cell),
  });
  const uninstall = action('runUninstall', '卸载', target, {
    destructive: true,
    confirmText: `确定要卸载 ${cell.pluginName} 在 ${pluginConsoleLocationLabel(cell)} 的安装吗？`,
  });
  const actions: PluginConsoleAction[] = [];
  const configSupported = supportsConfigAction(cell);
  const managedEvidence = hasManagedEvidence(cell.report);
  const disabledInstallReason = cell.disabledReason;

  if (status === 'notInstalled') {
    actions.push(action('openInstallWizard', '安装', target, {
      ...(disabledInstallReason ? { disabledReason: disabledInstallReason } : {}),
    }));
    actions.push(diagnose);
    return actions;
  }

  if (status === 'external') {
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('catalogUnavailable')) {
    if (managedEvidence && !reasons.includes('nativeResidue')) {
      actions.push(uninstall);
    }
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('nativeIncomplete')) {
    actions.push(action('repairInstall', '修复安装', target));
    if (cell.report?.native.recovery?.present && cell.report.native.recovery.evidenceMatches !== false) {
      actions.push(action('cleanupRecovery', '清理未完成安装', target, {
        destructive: true,
        confirmText: `确定要清理 ${pluginConsoleLocationLabel(cell)} 这次未完成安装留下的残留吗？`,
      }));
    }
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('nativeResidue')) {
    actions.push(diagnose);
    return actions;
  }

  if (reasons.includes('artifactRefreshFailed')) {
    actions.push(action('reapplyConfigRefresh', '重新应用配置', target));
  }

  if (
    reasons.includes('missingRecord') ||
    reasons.includes('upgradeEvidenceUnknown') ||
    reasons.includes('artifactDrift') ||
    reasons.includes('catalogCapabilityChanged')
  ) {
    const repairLabel = reasons.includes('catalogCapabilityChanged') || reasons.includes('artifactDrift')
      ? '重新安装/升级'
      : '修复安装';
    actions.push(action('repairInstall', repairLabel, target));
  }

  if (
    configSupported &&
    (status === 'installed' || status === 'upgradeAvailable' || status === 'partial' ||
      reasons.includes('requiredConfigMissing') || reasons.includes('invalidConfig'))
  ) {
    actions.push(action('openConfigWizard', '配置', target));
  }

  if (
    configSupported &&
    (status === 'installed' || status === 'upgradeAvailable')
  ) {
    actions.push(action('runUpgrade', '升级', target));
  }

  if (
    status === 'needsAction' &&
    !reasons.includes('externalOwnership') &&
    !reasons.includes('trackingIdentityBroken') &&
    !reasons.includes('roleOrMcpConflict') &&
    !reasons.includes('unmanagedArtifactConflict') &&
    !reasons.includes('unreadableConfig') &&
    !reasons.includes('nativeResidue') &&
    !actions.some((existing) => existing.kind === 'repairInstall')
  ) {
    actions.push(action('repairInstall', '修复安装', target));
  }

  if (managedEvidence && !reasons.includes('nativeResidue')) {
    actions.push(uninstall);
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
): PluginConsoleLocation {
  const reasonCodes = collectReasonCodes(cell, locationDiagnostics);
  const status = computeLocationStatus(cell, reasonCodes, locationDiagnostics);
  const copy = composeCopy(reasonCodes, cell);
  const actions = buildLocationActions(cell, status, reasonCodes);

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
    nextSteps: copy.nextSteps,
  };
}

function combineItemStatus(locations: PluginConsoleLocation[]): PluginConsoleStatus {
  if (locations.some((location) => location.status === 'needsAction')) {
    return 'needsAction';
  }
  if (locations.some((location) => location.status === 'partial')) {
    return 'partial';
  }
  if (locations.some((location) => location.status === 'upgradeAvailable')) {
    return 'upgradeAvailable';
  }
  if (locations.some((location) => location.status === 'installed')) {
    return 'installed';
  }
  if (locations.some((location) => location.status === 'external')) {
    return 'external';
  }
  return 'notInstalled';
}

function summarizeLocations(locations: PluginConsoleLocation[]): string {
  if (locations.length === 0) {
    return '多个位置';
  }
  if (locations.length === 1) {
    return locations[0].locationLabel;
  }
  return '多个位置';
}

function pickPrimaryLocation(locations: PluginConsoleLocation[]): PluginConsoleLocation | undefined {
  return [...locations].sort((left, right) =>
    STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status] ||
    (REASON_PRIORITY[right.reasonCodes[0] ?? 'catalogUnavailable'] - REASON_PRIORITY[left.reasonCodes[0] ?? 'catalogUnavailable']) ||
    sortLocations(left, right),
  )[0];
}

export function createPluginConsoleItems(
  matrix: StatusMatrixReport,
  options: PluginConsoleProjectionOptions = {},
): PluginConsoleItem[] {
  const cellsByPlugin = new Map<string, StatusMatrixCell[]>();
  for (const cell of matrix.cells) {
    cellsByPlugin.set(cell.pluginName, [...(cellsByPlugin.get(cell.pluginName) ?? []), cell]);
  }

  return [...cellsByPlugin.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginName, cells]) => {
      const locations = cells
        .map((cell) => buildLocation(
          cell,
          options.locationDiagnosticsByKey?.[createPluginConsoleLocationKey(cell)],
        ))
        .sort(sortLocations);
      const status = combineItemStatus(locations);
      const primaryLocation = pickPrimaryLocation(locations);
      const reasonCodes = dedupeReasons(locations.flatMap((location) => location.reasonCodes));
      const itemCopy = primaryLocation
        ? {
            issueSummary: primaryLocation.issueSummary,
            detailHints: dedupeStrings(locations.flatMap((location) => location.detailHints ?? [])).slice(0, 6),
            nextSteps: dedupeStrings(locations.flatMap((location) => location.nextSteps)),
          }
        : { nextSteps: [] };
      const meta = options.pluginMetaByName?.[pluginName];

      const item: PluginConsoleItem = {
        pluginName,
        title: meta?.title ?? pluginName,
        ...(meta?.description ? { description: meta.description } : {}),
        ...(meta?.version ? { version: meta.version } : {}),
        status,
        statusLabel: PLUGIN_CONSOLE_STATUS_LABELS[status],
        locationSummary: summarizeLocations(locations),
        actions: [],
        locations,
        reasonCodes,
        ...(itemCopy.issueSummary ? { issueSummary: itemCopy.issueSummary } : {}),
        ...(itemCopy.detailHints && itemCopy.detailHints.length > 0 ? { detailHints: itemCopy.detailHints } : {}),
        nextSteps: itemCopy.nextSteps,
        ...(status === 'needsAction' || status === 'partial'
          ? { blockingMessage: itemCopy.issueSummary ?? primaryLocation?.issueSummary }
          : {}),
      };

      for (const entry of item.actions) {
        if (WRITE_ACTION_KINDS.has(entry.kind)) {
          throw new Error(`Plugin console item action "${entry.kind}" must not be a write action.`);
        }
      }

      return item;
    });
}
