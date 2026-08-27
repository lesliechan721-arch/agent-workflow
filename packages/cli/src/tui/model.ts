import type {
  PlatformName,
  PluginConfigFieldType,
  PluginConfigPresentationPreset,
  PluginConfigSchema,
  Scope,
} from '../types.js';
import type {
  StatusV4Payload,
  StatusV4PluginSummary,
  StatusV4Target,
  StatusV4Component,
  StatusTargetRevision,
  TargetRevisionState,
} from '../commands/status-v4.js';
import type { ResolvedConfigRead } from '../utils/plugin-config.js';

export type SourceHealthState = 'ready' | 'cache' | 'path' | 'checking' | 'degraded' | 'unavailable';

export interface SourceHealthViewModel {
  sourceId: string;
  state: SourceHealthState;
  issueId?: string;
  message?: string;
}

export type PlatformPlacementSummary =
  | { platform: PlatformName; state: 'notInstalled'; supportedScopes: Scope[] }
  | {
      platform: PlatformName;
      state: 'installed';
      scope: Scope;
      health: 'ready' | 'incomplete' | 'error';
      revision: TargetRevisionState;
    }
  | {
      platform: PlatformName;
      state: 'scopeConflict';
      placements: Array<{
        scope: Scope;
        health: 'ready' | 'incomplete' | 'error';
        revision: TargetRevisionState;
      }>;
    };

export type PluginMenuAction =
  | { id: 'add' | 'manage' | 'repair' | 'portableSkills' | 'dependencies' | 'settings'
      | 'source' | 'sourceProblem' | 'about' | 'refreshSource' | 'technical' | 'back' }
  | { id: 'platform' | 'scopeConflict'; platform: PlatformName }
  | { id: 'upgrade'; platform: PlatformName; scope: Scope; availableVersion: string }
  | { id: 'reinstall' | 'remove'; platform: PlatformName; scope: Scope };

export interface PluginListItemViewModel {
  pluginId: string;
  sourceId: string;
  displayName: string;
  description: string;
  version?: string;
  configFieldCount: number;
  sourceLabel: string;
  supportedPlatforms: PlatformName[];
  installedPlacements: PlatformPlacementSummary[];
  aggregateStatus: 'available' | 'installed' | 'needsAttention' | 'unavailable';
  portableSkills: boolean;
  dependencySummary?: PluginDependencySummaryViewModel;
  technicalComponents: Array<{
    platform: PlatformName;
    scope: Scope;
    key: string;
    state: StatusV4Component['state'];
    errorCode?: string;
  }>;
}

export interface PluginDependencySummaryViewModel {
  directCount: number;
  transitiveCount: number;
  totalCount: number;
  readyCount: number;
  missingCount: number;
  issueCount: number;
}

export interface DependencyPlacementDescriptorViewModel {
  platform: PlatformName;
  scope: Scope;
  project: 'current' | 'other' | null;
}

export interface DependencyPlacementReferenceViewModel {
  consumer: DependencyPlacementDescriptorViewModel & { pluginId: string };
  dependency: DependencyPlacementDescriptorViewModel & { pluginId: string };
}

export interface PluginDependencyItemViewModel {
  pluginId: string;
  displayName: string;
  relation: 'direct' | 'transitive' | 'dependent';
  depth: number;
  requiredBy: Array<{ pluginId: string; displayName: string }>;
  placements: PlatformPlacementSummary[];
  aggregateStatus: 'ready' | 'notInstalled' | 'needsAttention' | 'unavailable';
  placementReferences?: DependencyPlacementReferenceViewModel[];
}

export interface PluginDependencyBlockerViewModel {
  code: string;
  title: string;
  explanation: string;
}

export interface PluginDependencyOverviewViewModel {
  pluginId: string;
  summary: PluginDependencySummaryViewModel;
  dependencies: PluginDependencyItemViewModel[];
  dependents: PluginDependencyItemViewModel[];
  blockers: PluginDependencyBlockerViewModel[];
}

export interface SourceTabViewModel {
  id: string;
  label: string;
  count?: number;
  primary: boolean;
  state: 'ready' | 'cache' | 'path' | 'error';
}

export interface SourceDetailViewModel {
  id: string;
  type: 'git' | 'path';
  primary: boolean;
  locationSummary: string;
  refPolicy?: 'cliChannel' | 'explicit';
  explicitRef?: string;
  subdir?: string;
  pluginCount: number;
  sourceIdentity: string;
  requestedRef: string;
  resolvedCommit?: string;
  catalogVersion?: string;
  channel?: string;
  freshness?: 'remote' | 'cache' | 'path';
  configDigest: string;
}

export interface HomeSummaryViewModel {
  availablePlugins: number;
  installedPlugins: number;
  issueCount: number;
  sourceCount: number;
  cachedSourceCount: number;
  unavailableSourceCount: number;
}

export interface ConfigFieldViewModel {
  key: string;
  title: string;
  description?: string;
  type: PluginConfigFieldType;
  displayValue: string;
  required: boolean;
  sensitive: boolean;
  dirty: boolean;
  inherited: boolean;
  configured: boolean;
  sourceLabel: string;
  effectiveDisplayValue: string;
  effectiveSourceLabel: string;
  value?: string | number | boolean;
  effectiveValue?: string | number | boolean;
  defaultValue?: string | number | boolean;
  enumValues?: string[];
  valueLabels?: Record<string, string>;
  recommendedValue?: string | number | boolean;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  advanced: boolean;
}

export interface ConfigGroupViewModel {
  id: string;
  title: string;
  description?: string;
  advanced: boolean;
  fields: ConfigFieldViewModel[];
}

export interface ConfigPresetViewModel extends Omit<PluginConfigPresentationPreset, 'values'> {
  values: Record<string, string | number | boolean>;
  privateFieldTitles?: string[];
}

export interface ConfigPageViewModel {
  pluginId: string;
  layer: { scope: Scope | 'effective'; projectLayer: 'shared' | 'local' };
  groups: ConfigGroupViewModel[];
  presets: ConfigPresetViewModel[];
  storedCount: number;
}

export type UserIssueCategory =
  | 'incompleteInstallation'
  | 'sourceDegraded'
  | 'sourceUnavailable'
  | 'sourceMissing'
  | 'sourceIdentityChanged'
  | 'requiredConfigMissing'
  | 'scopeConflict'
  | 'dependencyMissing'
  | 'dependencyNotReady'
  | 'dependencyTargetUnsupported'
  | 'dependencyStillRequired'
  | 'dependencyGraphInvalid'
  | 'legacyState'
  | 'diagnostic';

export type UserIssueActionId =
  | 'reinstall'
  | 'remove'
  | 'refreshSource'
  | 'continueWithCache'
  | 'editSource'
  | 'retryLater'
  | 'reAddSource'
  | 'viewSourceChange'
  | 'openConfig'
  | 'keepUserScope'
  | 'keepProjectScope'
  | 'viewTechnical'
  | 'manualMigration'
  | 'installDependency'
  | 'reinstallDependency'
  | 'viewDependencyIssue'
  | 'viewDependencies';

export interface UserIssueActionViewModel {
  id: UserIssueActionId;
  label: string;
  description?: string;
  pluginId?: string;
  platform?: PlatformName;
  scope?: Scope;
  project?: 'current' | 'other' | null;
  writeAction?: 'install' | 'upgrade' | 'reinstall';
}

export type TargetIssueRootCode =
  | 'partial'
  | 'sourceMissing'
  | 'sourceChanged'
  | 'catalogSourceUnavailable'
  | 'bundleUnavailable'
  | 'dependencyMissing'
  | 'dependencyNotReady'
  | 'dependencyTargetUnsupported'
  | 'dependencyStillRequired'
  | 'dependencyGraphInvalid'
  | 'targetDiagnostic';

export interface UserIssueViewModel {
  issueId: string;
  category: UserIssueCategory;
  title: string;
  explanation: string;
  impact: string[];
  entity: { kind: 'plugin' | 'source'; id: string };
  pluginId?: string;
  dependencyPluginId?: string;
  dependencyPlatform?: PlatformName;
  dependencyScope?: Scope;
  dependencyProject?: 'current' | 'other' | null;
  platform?: PlatformName;
  scope?: Scope;
  sourceId?: string;
  sourceIdentity?: string;
  rootCode?: TargetIssueRootCode;
  mergeEligible?: boolean;
  placements?: Scope[];
  requiredFields?: Array<{
    key: string;
    title: string;
    type: 'missing-required' | 'invalid-config';
    source: 'default' | 'user' | 'project' | 'projectLocal' | 'missing';
  }>;
  configLayer?: { scope: Scope; projectLayer: 'shared' | 'local' };
  actions: UserIssueActionViewModel[];
  technicalDetails: Array<{ code: string; message: string }>;
}

export interface TuiViewModel {
  plugins: PluginListItemViewModel[];
  sourceTabs: SourceTabViewModel[];
  sourceDetails: SourceDetailViewModel[];
  issues: UserIssueViewModel[];
  home: HomeSummaryViewModel;
  dependencyOverviews: PluginDependencyOverviewViewModel[];
}

export interface PortableSkillCandidateViewModel {
  name: string;
  description: string;
  selected: boolean;
  providerPluginId: string;
  providerDisplayName: string;
  relation: 'requested' | 'direct' | 'transitive';
  dynamic: boolean;
  availableScopes: Scope[];
  scopeDetails: Partial<Record<Scope, {
    description: string;
    providerPluginId: string;
    providerDisplayName: string;
    relation: 'requested' | 'direct' | 'transitive';
    dynamic: boolean;
    filesDigest: string;
  }>>;
}

export interface PortableSkillSelectionViewModel {
  pluginId: string;
  candidates: PortableSkillCandidateViewModel[];
  selectedCount: number;
  totalCount: number;
  dependencySummary?: {
    directCount: number;
    transitiveCount: number;
    contributingSkillCount: number;
  };
  canContinue: boolean;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en');
}

function targetHealth(target: StatusV4Target): 'ready' | 'incomplete' | 'error' {
  if (target.state === 'present') return 'ready';
  if (target.state === 'partial') return 'incomplete';
  return 'error';
}

function isInstalledScopeEvidence(target: StatusV4Target): boolean {
  return target.state === 'present' || target.state === 'partial';
}

function dependencyPluginIdFromMessage(message: string): string | undefined {
  return message.match(/(?:[a-z0-9]+(?:-[a-z0-9]+)*)\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)/u)?.[0];
}

export function projectPlatformPlacement(
  platform: PlatformName,
  targets: StatusV4Target[],
  revisions: StatusTargetRevision[] = [],
): PlatformPlacementSummary {
  const revisionFor = (target: StatusV4Target): TargetRevisionState =>
    revisions.find((entry) => entry.pluginId === target.pluginId
      && entry.platform === target.platform
      && entry.scope === target.scope)?.revision
      ?? { state: 'unknown', ...(target.version ? { availableVersion: target.version } : {}) };
  const supportedScopes = [...new Set(targets.map((target) => target.scope))];
  const installed = targets.filter(isInstalledScopeEvidence);
  if (installed.length === 0) {
    const errorTarget = targets.find((target) => target.state === 'error');
    if (!errorTarget) return { platform, state: 'notInstalled', supportedScopes };
    return {
      platform,
      state: 'installed',
      scope: errorTarget.scope,
      health: 'error',
      revision: revisionFor(errorTarget),
    };
  }
  if (installed.length === 1) {
    const target = installed[0]!;
    return {
      platform,
      state: 'installed',
      scope: target.scope,
      health: targetHealth(target),
      revision: revisionFor(target),
    };
  }
  return {
    platform,
    state: 'scopeConflict',
    placements: installed.map((target) => ({
      scope: target.scope,
      health: targetHealth(target),
      revision: revisionFor(target),
    })).sort((left, right) => compareText(left.scope, right.scope)),
  };
}

function hasIncompletePlacement(plugin: PluginListItemViewModel): boolean {
  return plugin.installedPlacements.some((placement) =>
    placement.state === 'scopeConflict'
    || placement.state === 'installed' && placement.health !== 'ready');
}

function hasMissingPlatform(plugin: PluginListItemViewModel): boolean {
  return plugin.supportedPlatforms.some((platform) =>
    plugin.installedPlacements.find((placement) => placement.platform === platform)?.state === 'notInstalled');
}

function capabilityActions(plugin: PluginListItemViewModel): PluginMenuAction[] {
  return [
    ...(plugin.portableSkills ? [{ id: 'portableSkills' as const }] : []),
    ...((plugin.dependencySummary?.totalCount ?? 0) > 0 ? [{ id: 'dependencies' as const }] : []),
    ...(plugin.configFieldCount > 0 ? [{ id: 'settings' as const }] : []),
  ];
}

export function buildPluginPreviewActions(plugin: PluginListItemViewModel): PluginMenuAction[] {
  const installed = hasInstalledPlacement(plugin);
  if (plugin.aggregateStatus === 'unavailable') {
    return [{ id: 'sourceProblem' }, ...(installed ? [{ id: 'manage' as const }] : [])];
  }
  const primary: PluginMenuAction = hasIncompletePlacement(plugin)
    || (plugin.dependencySummary?.issueCount ?? 0) > 0
    ? { id: 'repair' }
    : installed && !hasMissingPlatform(plugin)
      ? { id: 'manage' }
      : { id: 'add' };
  return [primary, ...capabilityActions(plugin), { id: 'source' }];
}

export function buildPluginDetailActions(plugin: PluginListItemViewModel): PluginMenuAction[] {
  if (plugin.aggregateStatus === 'unavailable') {
    return [
      ...plugin.installedPlacements.flatMap((placement) => placement.state === 'notInstalled'
        ? []
        : [{ id: 'platform' as const, platform: placement.platform }]),
      { id: 'sourceProblem' },
      { id: 'about' },
    ];
  }
  return [
    ...plugin.installedPlacements.map((placement): PluginMenuAction => placement.state === 'scopeConflict'
      ? { id: 'scopeConflict', platform: placement.platform }
      : { id: 'platform', platform: placement.platform }),
    ...((plugin.dependencySummary?.totalCount ?? 0) > 0 ? [{ id: 'dependencies' as const }] : []),
    ...(plugin.portableSkills ? [{ id: 'portableSkills' as const }] : []),
    ...(plugin.configFieldCount > 0 ? [{ id: 'settings' as const }] : []),
    { id: 'about' },
  ];
}

export function buildPlatformActions(
  plugin: PluginListItemViewModel,
  platform: PlatformName,
): PluginMenuAction[] {
  if (plugin.aggregateStatus === 'unavailable') {
    return [{ id: 'sourceProblem' }, { id: 'refreshSource' }];
  }
  const placement = plugin.installedPlacements.find((entry) => entry.platform === platform);
  if (!placement || placement.state === 'notInstalled') return [{ id: 'add' }, { id: 'about' }];
  if (placement.state === 'scopeConflict') return [{ id: 'scopeConflict', platform }];
  if (placement.health === 'error') return [{ id: 'technical' }, { id: 'back' }];
  if (placement.health === 'incomplete') {
    return [
      { id: 'reinstall', platform, scope: placement.scope },
      { id: 'technical' },
      { id: 'remove', platform, scope: placement.scope },
    ];
  }
  return [
    ...(placement.revision.state === 'upgradeAvailable'
      ? [{
          id: 'upgrade' as const,
          platform,
          scope: placement.scope,
          availableVersion: placement.revision.availableVersion,
        }]
      : []),
    { id: 'reinstall', platform, scope: placement.scope },
    { id: 'remove', platform, scope: placement.scope },
    { id: 'technical' },
  ];
}

export function hasInstalledPlacement(plugin: PluginListItemViewModel): boolean {
  return plugin.installedPlacements.some((placement) => placement.state !== 'notInstalled');
}

function sourceState(
  source: StatusV4Payload['catalog']['sources'][number],
  health?: SourceHealthViewModel,
): SourceTabViewModel['state'] {
  if (health?.state === 'ready') return 'ready';
  if (health?.state === 'path') return 'path';
  if (health?.state === 'degraded') return 'cache';
  if (health?.state === 'unavailable') return 'error';
  if (source.error) return 'error';
  if (source.type === 'path' || source.freshness === 'path') return 'path';
  return source.freshness === 'cache' ? 'cache' : 'ready';
}

function sourceIssue(
  health: SourceHealthViewModel,
  impactedTargets = 0,
): UserIssueViewModel | undefined {
  if (health.state !== 'cache' && health.state !== 'degraded' && health.state !== 'unavailable') return undefined;
  const cached = health.state === 'cache' || health.state === 'degraded';
  const issueId = health.issueId ?? `source:${health.sourceId}:${cached ? 'cache' : 'unavailable'}`;
  return {
    issueId,
    category: cached ? 'sourceDegraded' : 'sourceUnavailable',
    title: `${health.sourceId} · ${cached ? '来源使用缓存' : '来源不可用'}`,
    explanation: cached
      ? '远端检查失败。当前仍使用已验证的缓存数据。'
      : '远端检查失败，并且没有可用缓存数据。',
    impact: [cached ? '插件仍可浏览，但数据可能不是最新。' : '当前不能浏览或安装这个来源的插件。',
      ...(impactedTargets > 0 ? [`${impactedTargets} 个安装位置受此来源根问题影响。`] : [])],
    entity: { kind: 'source', id: health.sourceId },
    sourceId: health.sourceId,
    actions: cached
      ? [
          { id: 'refreshSource', label: '重新检查来源', description: '不会修改已安装内容' },
          { id: 'continueWithCache', label: '继续使用缓存', description: '当前缓存仍可安全读取' },
          { id: 'viewTechnical', label: '技术详情' },
        ]
      : [
          { id: 'editSource', label: '编辑来源', description: '检查 URL、路径或 ref' },
          { id: 'refreshSource', label: '稍后重试', description: '只重新检查来源' },
          { id: 'viewTechnical', label: '技术详情' },
        ],
    technicalDetails: [{
      code: cached ? 'catalogSourceDegraded' : 'catalogSourceUnavailable',
      message: cached ? '远端检查失败；已验证缓存仍可用。' : '来源检查失败；没有可用缓存。',
    }],
  };
}

function targetIssues(payload: StatusV4Payload): UserIssueViewModel[] {
  const issues: UserIssueViewModel[] = [];
  const byPlacement = new Map<string, StatusV4Target[]>();
  for (const target of payload.targets) {
    const key = `${target.pluginId}\0${target.platform}`;
    byPlacement.set(key, [...(byPlacement.get(key) ?? []), target]);
    if (target.state !== 'partial' && target.state !== 'error') continue;
    const codes = new Set(target.errors.map((error) => error.code));
    const dependencyCodes = [
      'dependencyMissing',
      'dependencyNotReady',
      'dependencyTargetUnsupported',
      'dependencyStillRequired',
      'dependencyGraphInvalid',
    ] as const;
    const dependencyRoots = [...new Map(target.errors.flatMap((error) => {
      if (!dependencyCodes.includes(error.code as typeof dependencyCodes[number])) return [];
      const code = error.code as typeof dependencyCodes[number];
      const dependencyPluginId = dependencyPluginIdFromMessage(error.message);
      return [[`${code}\0${dependencyPluginId ?? ''}`, {
        code,
        category: code,
        mergeEligible: false,
        error,
        dependencyPluginId,
      }] as const];
    })).values()];
    const roots: Array<{
      code: TargetIssueRootCode;
      category: UserIssueCategory;
      mergeEligible: boolean;
      error?: { code: string; message: string };
      dependencyPluginId?: string;
    }> = dependencyRoots.length > 0
      ? dependencyRoots
      : target.state === 'partial'
      ? [{ code: 'partial', category: 'incompleteInstallation', mergeEligible: false }]
      : codes.has('sourceMissing')
        ? [{ code: 'sourceMissing', category: 'sourceMissing', mergeEligible: false }]
        : codes.has('sourceChanged')
          ? [{ code: 'sourceChanged', category: 'sourceIdentityChanged', mergeEligible: false }]
          : [
              ...(codes.has('catalogSourceUnavailable')
                ? [{ code: 'catalogSourceUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: true }]
                : []),
              ...(codes.has('bundleUnavailable')
                ? [{ code: 'bundleUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: false }]
                : []),
              ...(!codes.has('catalogSourceUnavailable') && !codes.has('bundleUnavailable')
                ? [{ code: 'targetDiagnostic' as const, category: 'diagnostic' as const, mergeEligible: false }]
                : []),
            ];
    for (const root of roots) {
      const rootError = root.error ?? target.errors.find((error) => error.code === root.code);
      const dependencyPluginId = root.dependencyPluginId
        ?? (rootError ? dependencyPluginIdFromMessage(rootError.message) : undefined);
      const dependencyCategory = root.category.startsWith('dependency');
      const actions: UserIssueActionViewModel[] = root.category === 'dependencyMissing'
        ? [
            ...(dependencyPluginId ? [{ id: 'installDependency' as const, label: '补齐依赖插件',
              pluginId: dependencyPluginId, writeAction: 'install' as const }] : []),
            { id: 'viewDependencies', label: '查看依赖关系' },
            { id: 'viewTechnical', label: '技术详情' },
          ]
        : root.category === 'dependencyNotReady'
          ? [
              ...(dependencyPluginId ? [
                { id: 'viewDependencyIssue' as const, label: '查看依赖插件问题', pluginId: dependencyPluginId },
                { id: 'reinstallDependency' as const, label: '重新安装依赖插件',
                  pluginId: dependencyPluginId, writeAction: 'reinstall' as const },
              ] : []),
              { id: 'viewDependencies', label: '查看依赖关系' },
              { id: 'viewTechnical', label: '技术详情' },
            ]
          : dependencyCategory
            ? [
                { id: 'viewDependencies', label: '查看依赖关系' },
                { id: 'viewTechnical', label: '技术详情' },
              ]
            : root.category === 'incompleteInstallation'
        ? [
            { id: 'reinstall', label: '重新安装', description: '保留插件设置，重新生成缺失内容' },
            { id: 'remove', label: '移除安装', description: '保留插件设置' },
            { id: 'viewTechnical', label: '技术详情' },
          ]
        : root.category === 'sourceMissing'
          ? [
              { id: 'reAddSource', label: '重新添加同一来源', description: '保留来源 ID；来源类型和位置由你选择' },
              { id: 'viewTechnical', label: '技术详情' },
            ]
          : root.category === 'sourceIdentityChanged'
            ? [
                { id: 'viewSourceChange', label: '查看来源变更', description: '不会自动覆盖现场状态' },
                { id: 'viewTechnical', label: '技术详情' },
              ]
            : root.category === 'sourceUnavailable'
              ? [
                  { id: 'editSource', label: '查看来源', description: root.code === 'bundleUnavailable' ? '检查这个插件包或稍后重试' : '修复来源配置或稍后重试' },
                  { id: 'viewTechnical', label: '技术详情' },
                ]
              : [{ id: 'viewTechnical', label: '技术详情' }, { id: 'retryLater', label: '稍后重试' }];
      const issueId = `target:${target.pluginId}:${target.platform}:${target.scope}:${target.state}${roots.length > 1 ? `:${root.code}` : ''}${dependencyPluginId ? `:${dependencyPluginId}` : ''}`;
      const bundleUnavailable = root.code === 'bundleUnavailable';
      issues.push({
        issueId,
        category: root.category,
        rootCode: root.code,
        mergeEligible: root.mergeEligible,
        title: `${target.pluginId} · ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${dependencyCategory ? {
          dependencyMissing: '缺少依赖',
          dependencyNotReady: '依赖安装不完整',
          dependencyTargetUnsupported: '依赖目标不兼容',
          dependencyStillRequired: '依赖仍被使用',
          dependencyGraphInvalid: '依赖关系无效',
        }[root.category as Exclude<UserIssueCategory, 'incompleteInstallation' | 'sourceDegraded' | 'sourceUnavailable' | 'sourceMissing' | 'sourceIdentityChanged' | 'requiredConfigMissing' | 'scopeConflict' | 'legacyState' | 'diagnostic'>] : target.state === 'partial' ? '安装不完整' : bundleUnavailable ? '插件包不可用' : '检查失败'}`,
        explanation: dependencyCategory
          ? dependencyPluginId
            ? `${dependencyPluginId} 导致当前依赖检查不能通过。`
            : '当前依赖检查不能安全通过。'
          : target.state === 'partial'
          ? '必要内容缺失，插件可能不能稳定运行。'
          : bundleUnavailable
            ? '当前来源中无法取得这个插件的可信 bundle。'
            : '当前目标不能安全分类为正常安装。',
        impact: [bundleUnavailable
          ? '当前目标不能使用这个插件包；这不表示来源缓存整体不可用。'
          : '写操作前需要重新检查这个目标。'],
        entity: { kind: 'plugin', id: target.pluginId },
        pluginId: target.pluginId,
        ...(dependencyPluginId ? { dependencyPluginId } : {}),
        platform: target.platform,
        scope: target.scope,
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        actions,
        technicalDetails: target.errors.length > 0
          ? target.errors.filter((error) => root.code === 'targetDiagnostic'
            || root.code === 'partial'
            || error.code === root.code)
            .map((error) => ({ code: error.code, message: '状态检查报告了这个安全错误代码。' }))
          : [{ code: 'targetStateError', message: '目标状态异常。' }],
      });
    }
  }
  for (const targets of byPlacement.values()) {
    const installed = targets.filter(isInstalledScopeEvidence);
    if (new Set(installed.map((target) => target.scope)).size < 2) continue;
    const sample = installed[0]!;
    issues.push({
      issueId: `scope:${sample.pluginId}:${sample.platform}`,
      category: 'scopeConflict',
      title: `${sample.pluginId} · ${sample.platform === 'codex' ? 'Codex' : 'Claude Code'} · 安装位置冲突`,
      explanation: '所有项目和当前项目同时发现了这个插件。',
      impact: ['正常状态只能保留一个位置。'],
      entity: { kind: 'plugin', id: sample.pluginId },
      pluginId: sample.pluginId,
      platform: sample.platform,
      sourceId: sample.sourceId,
      sourceIdentity: sample.sourceIdentity,
      placements: installed.map((target) => target.scope).sort(compareText),
      actions: [
        { id: 'keepUserScope', label: '保留所有项目', description: '移除当前项目中的安装；设置保留' },
        { id: 'keepProjectScope', label: '保留当前项目', description: '移除所有项目中的安装；设置保留' },
        { id: 'viewTechnical', label: '查看两个位置的详情' },
      ],
      technicalDetails: [{ code: 'scopeConflict', message: '同一插件和平台存在两个安装位置。' }],
    });
  }
  return issues;
}

function statusIssues(payload: StatusV4Payload): UserIssueViewModel[] {
  const targetCodes = new Set(payload.targets.flatMap((target) =>
    target.errors.map((error) => error.code)));
  const issues = new Map<string, UserIssueViewModel>();
  for (const error of payload.errors) {
    if (targetCodes.has(error.code) || issues.has(error.code)) continue;
    const projection = error.code === 'legacyStateUnsupported'
      ? {
          title: '发现旧版状态',
          explanation: '当前状态使用不受支持的旧格式。',
          impact: '在迁移或清理旧状态前，部分操作不可用。',
        }
      : error.code === 'nativeStateUnreadable'
        ? {
            title: '平台状态不可读',
            explanation: '当前不能安全读取平台状态。',
            impact: '部分安装状态可能不可用。',
          }
        : {
            title: '状态清单不可用',
            explanation: '当前不能完成状态清单检查。',
            impact: '部分安装状态可能不可用。',
          };
    issues.set(error.code, {
      issueId: `status:${error.code}`,
      category: error.code === 'legacyStateUnsupported' ? 'legacyState' : 'diagnostic',
      title: projection.title,
      explanation: projection.explanation,
      impact: [projection.impact],
      entity: { kind: 'source', id: payload.catalog.primarySourceId },
      sourceId: payload.catalog.primarySourceId,
      actions: error.code === 'legacyStateUnsupported'
        ? [
            { id: 'manualMigration', label: '查看手动处理说明', description: '当前没有安全的自动迁移' },
            { id: 'retryLater', label: '稍后重新检查' },
          ]
        : [{ id: 'retryLater', label: '稍后重试' }, { id: 'viewTechnical', label: '技术详情' }],
      technicalDetails: [{ code: error.code, message: projection.explanation }],
    });
  }
  return [...issues.values()];
}

function configIssues(pluginSummaries: StatusV4PluginSummary[]): UserIssueViewModel[] {
  return pluginSummaries.flatMap((summary): UserIssueViewModel[] => {
    const sourceId = summary.pluginId.slice(0, summary.pluginId.indexOf('/'));
    if (summary.configDiagnostic) {
      return [{
        issueId: `config:${summary.pluginId}:read`,
        category: 'diagnostic' as const,
        title: `${summary.displayName ?? summary.pluginName} · 设置状态不可读`,
        explanation: '当前不能安全读取这个插件的设置状态。',
        impact: ['其他插件仍可检查；当前插件的设置值不会显示。'],
        entity: { kind: 'plugin' as const, id: summary.pluginId },
        pluginId: summary.pluginId,
        sourceId,
        actions: [
          { id: 'retryLater' as const, label: '稍后重新检查' },
          { id: 'viewTechnical' as const, label: '查看技术详情' },
        ],
        technicalDetails: [{ code: summary.configDiagnostic.code, message: summary.configDiagnostic.message }],
      }];
    }
    if (!summary.configIssues?.length) return [];
    const types = new Set(summary.configIssues.map((issue) => issue.type));
    const invalid = types.has('invalid-config');
    const sources = new Set(summary.configIssues.map((issue) => issue.source));
    const onlySource = sources.size === 1 ? [...sources][0] : undefined;
    const configLayer = onlySource === 'user'
      ? { scope: 'user' as const, projectLayer: 'shared' as const }
      : onlySource === 'project'
        ? { scope: 'project' as const, projectLayer: 'shared' as const }
        : onlySource === 'projectLocal'
          ? { scope: 'project' as const, projectLayer: 'local' as const }
          : undefined;
    return [{
      issueId: `config:${summary.pluginId}:${invalid ? 'invalid' : 'required'}`,
      category: 'requiredConfigMissing' as const,
      title: `${summary.displayName ?? summary.pluginName} · ${invalid ? '设置值无效' : '缺少必填设置'}`,
      explanation: invalid
        ? '已有设置值不符合当前字段规则。'
        : '插件缺少必填设置，写操作会在预检时被阻止。',
      impact: [invalid ? '修正所列字段后才能稳定生成插件内容。' : '完成所列字段后才能稳定生成插件内容。'],
      entity: { kind: 'plugin' as const, id: summary.pluginId },
      pluginId: summary.pluginId,
      sourceId,
      requiredFields: summary.configIssues.map(({ key, title, type, source }) => ({ key, title, type, source })),
      ...(configLayer ? { configLayer } : {}),
      actions: [
        { id: 'openConfig' as const, label: invalid ? '修正设置' : '完成设置', description: configLayer ? '进入建议的设置层' : '选择个人或项目设置层' },
        { id: 'viewTechnical' as const, label: '查看字段详情' },
      ],
      technicalDetails: summary.configIssues.map((entry) => ({
        code: entry.type,
        message: `${entry.title} · ${entry.source}`,
      })),
    }];
  });
}

function enrichDependencyIssuePlacements(
  issues: UserIssueViewModel[],
  overviews: PluginDependencyOverviewViewModel[],
): UserIssueViewModel[] {
  const overviewById = new Map(overviews.map((overview) => [overview.pluginId, overview]));
  return issues.map((issue) => {
    if ((issue.category !== 'dependencyMissing' && issue.category !== 'dependencyNotReady')
      || !issue.pluginId || !issue.dependencyPluginId || !issue.platform || !issue.scope) return issue;
    const dependency = overviewById.get(issue.pluginId)?.dependencies.find((candidate) =>
      candidate.pluginId === issue.dependencyPluginId);
    const references = (dependency?.placementReferences ?? []).filter((reference) =>
      reference.consumer.pluginId === issue.pluginId
      && reference.consumer.platform === issue.platform
      && reference.consumer.scope === issue.scope
      && (issue.scope === 'user' || reference.consumer.project === 'current'))
      .sort((left, right) => [
        left.dependency.pluginId,
        left.dependency.platform,
        left.dependency.scope,
        left.dependency.project ?? '',
      ].join('\0').localeCompare([
        right.dependency.pluginId,
        right.dependency.platform,
        right.dependency.scope,
        right.dependency.project ?? '',
      ].join('\0'), 'en'));
    const target = references[0]?.dependency;
    if (!target) {
      return {
        ...issue,
        actions: issue.actions.filter((action) =>
          action.id !== 'installDependency' && action.id !== 'reinstallDependency'),
      };
    }
    return {
      ...issue,
      dependencyPlatform: target.platform,
      dependencyScope: target.scope,
      dependencyProject: target.project,
      actions: issue.actions.map((action) =>
        action.id === 'installDependency' || action.id === 'reinstallDependency'
          ? {
              ...action,
              platform: target.platform,
              scope: target.scope,
              project: target.project,
            }
          : action),
    };
  });
}

export function buildTuiViewModel(options: {
  status: StatusV4Payload;
  pluginSummaries: StatusV4PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceHealth?: ReadonlyMap<string, SourceHealthViewModel>;
  sourceDetails?: SourceDetailViewModel[];
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
}): TuiViewModel {
  const dependencyById = new Map((options.dependencyOverviews ?? [])
    .map((overview) => [overview.pluginId, overview]));
  const summaryById = new Map(options.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  const targetsByPlugin = new Map<string, StatusV4Target[]>();
  for (const target of options.status.targets) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const pluginIds = new Set([...summaryById.keys(), ...targetsByPlugin.keys()]);
  const plugins = [...pluginIds].map((pluginId): PluginListItemViewModel => {
    const summary = summaryById.get(pluginId);
    const targets = targetsByPlugin.get(pluginId) ?? [];
    const sourceId = targets[0]?.sourceId ?? pluginId.slice(0, pluginId.indexOf('/'));
    const placements = (['codex', 'claude'] as const).flatMap((platform) => {
      const platformTargets = targets.filter((target) => target.platform === platform);
      return platformTargets.length > 0
        ? [projectPlatformPlacement(platform, platformTargets, options.targetRevisions)]
        : [];
    });
    const attention = placements.some((placement) => placement.state === 'scopeConflict'
      || (placement.state === 'installed' && placement.health !== 'ready'));
    const installed = placements.some((placement) => placement.state !== 'notInstalled');
    const unavailable = options.sourceHealth?.get(sourceId)?.state === 'unavailable';
    return {
      pluginId,
      sourceId,
      displayName: summary?.displayName ?? summary?.pluginName ?? targets[0]?.pluginName ?? pluginId,
      description: summary?.description ?? '',
      ...(summary?.version ?? targets[0]?.version
        ? { version: summary?.version ?? targets[0]?.version }
        : {}),
      configFieldCount: summary?.configFieldCount
        ?? Object.keys(summary?.configSchema ?? {}).length,
      sourceLabel: sourceId,
      supportedPlatforms: summary?.supportedTargets
        ? (['codex', 'claude'] as const).filter((platform) =>
            summary.supportedTargets![platform].length > 0)
        : placements.map((placement) => placement.platform),
      installedPlacements: placements,
      aggregateStatus: unavailable ? 'unavailable' : attention ? 'needsAttention' : installed ? 'installed' : 'available',
      portableSkills: options.portablePluginIds?.includes(pluginId) ?? false,
      ...(dependencyById.get(pluginId)
        ? { dependencySummary: dependencyById.get(pluginId)!.summary }
        : summary && (summary.dependencyTotalCount ?? 0) > 0
          ? { dependencySummary: {
              directCount: summary.dependencyDirectCount ?? 0,
              transitiveCount: Math.max(0,
                (summary.dependencyTotalCount ?? 0) - (summary.dependencyDirectCount ?? 0)),
              totalCount: summary.dependencyTotalCount ?? 0,
              readyCount: 0,
              missingCount: 0,
              issueCount: summary.dependencyIssueCount ?? 0,
            } }
          : {}),
      technicalComponents: targets.flatMap((target) => target.components.map((component) => ({
        platform: target.platform,
        scope: target.scope,
        key: component.key,
        state: component.state,
        ...(component.error ? { errorCode: component.error.code } : {}),
      }))),
    };
  }).sort((left, right) => compareText(left.displayName, right.displayName)
    || compareText(left.sourceId, right.sourceId));
  const sourceTabs = options.status.catalog.sources.map((source) => ({
    id: source.id,
    label: source.id,
    count: plugins.filter((plugin) => plugin.sourceId === source.id).length,
    primary: source.primary,
    state: sourceState(source, options.sourceHealth?.get(source.id)),
  }));
  const sourceRootIds = new Set([...(options.sourceHealth?.values() ?? [])]
    .filter((health) => health.state === 'cache' || health.state === 'degraded' || health.state === 'unavailable')
    .map((health) => health.sourceId));
  const allTargetIssues = targetIssues(options.status);
  const targetImpactCounts = new Map<string, number>();
  for (const issue of allTargetIssues) {
    if (!issue.mergeEligible || !issue.sourceId || !sourceRootIds.has(issue.sourceId)) continue;
    targetImpactCounts.set(issue.sourceId, (targetImpactCounts.get(issue.sourceId) ?? 0) + 1);
  }
  const issues = enrichDependencyIssuePlacements([
    ...allTargetIssues.filter((issue) => !issue.mergeEligible
      || !issue.sourceId || !sourceRootIds.has(issue.sourceId)),
    ...statusIssues(options.status),
    ...configIssues(options.pluginSummaries),
    ...[...(options.sourceHealth?.values() ?? [])].flatMap((health) =>
      sourceIssue(health, targetImpactCounts.get(health.sourceId) ?? 0) ?? []),
  ], options.dependencyOverviews ?? []);
  return {
    plugins,
    sourceTabs,
    sourceDetails: (options.sourceDetails ?? []).map((detail) => ({
      ...detail,
      pluginCount: plugins.filter((plugin) => plugin.sourceId === detail.id).length,
    })),
    issues,
    dependencyOverviews: options.dependencyOverviews ?? [],
    home: {
      availablePlugins: plugins.filter((plugin) => plugin.aggregateStatus === 'available').length,
      installedPlugins: plugins.filter(hasInstalledPlacement).length,
      issueCount: issues.length,
      sourceCount: sourceTabs.length,
      cachedSourceCount: sourceTabs.filter((source) => source.state === 'cache').length,
      unavailableSourceCount: sourceTabs.filter((source) => source.state === 'error').length,
    },
  };
}

function displayConfigValue(options: {
  privateValue: boolean;
  inherited: boolean;
  configured: boolean;
  value: unknown;
}): string {
  if (!options.configured) return options.inherited ? '继承' : '未设置';
  if (options.privateValue) return '已设置';
  if (typeof options.value === 'string') return options.value;
  if (options.value === undefined || options.value === null) return '已设置';
  return String(options.value);
}

function configSourceLabel(source: ResolvedConfigRead['fields'][number]['sourceLayer']): string {
  if (!source) return '未设置';
  return {
    default: '默认值',
    user: '个人默认',
    project: '当前项目',
    local: '当前项目（仅本机）',
  }[source];
}

export function buildConfigGroups(options: {
  schema: PluginConfigSchema;
  read: ResolvedConfigRead;
  effectiveRead?: ResolvedConfigRead;
  dirtyKeys?: ReadonlySet<string>;
}): ConfigGroupViewModel[] {
  const entryByKey = new Map(options.read.fields.map((field) => [field.key, field]));
  const effectiveEntryByKey = new Map(
    (options.effectiveRead ?? options.read).fields.map((field) => [field.key, field]),
  );
  const effectivePage = options.read.scope === 'effective';
  const fieldModel = (key: string): ConfigFieldViewModel => {
    const schema = options.schema.schema[key]!;
    const entry = entryByKey.get(key);
    const effectiveEntry = effectiveEntryByKey.get(key);
    const presentation = options.schema.presentation?.fields?.[key];
    const inherited = effectivePage
      ? false
      : entry?.storedSourceLayer === undefined;
    const configured = effectivePage
      ? entry?.sourceLayer !== undefined
        && entry.sourceLayer !== null
        && entry.effectiveValue !== undefined
        && entry.effectiveValue !== null
        && (entry.valueState === 'configured' || entry.valueState === 'default')
      : entry?.storedSourceLayer !== undefined;
    const privateValue = schema.sensitive === true || schema.type === 'file' || schema.type === 'directory';
    const selectedValue = effectivePage ? entry?.effectiveValue : entry?.storedValue;
    const selectedStoredInvalid = !effectivePage
      && entry?.storedSourceLayer !== undefined
      && entry.storedValue === undefined;
    const effectiveConfigured = effectiveEntry?.sourceLayer !== undefined
      && effectiveEntry.sourceLayer !== null
      && effectiveEntry.effectiveValue !== undefined
      && effectiveEntry.effectiveValue !== null
      && (effectiveEntry.valueState === 'configured' || effectiveEntry.valueState === 'default');
    return {
      key,
      title: schema.title ?? key,
      ...(schema.description ? { description: schema.description } : {}),
      type: schema.type,
      displayValue: selectedStoredInvalid ? '值无效' : displayConfigValue({
        privateValue,
        inherited,
        configured,
        value: selectedValue,
      }),
      required: schema.required === true,
      sensitive: schema.sensitive === true,
      dirty: options.dirtyKeys?.has(key) === true,
      inherited,
      configured,
      sourceLabel: effectivePage
        ? configSourceLabel(entry?.sourceLayer ?? null)
        : configured ? '本层已设置' : '继承',
      effectiveDisplayValue: displayConfigValue({
        privateValue,
        inherited: false,
        configured: effectiveConfigured,
        value: effectiveEntry?.effectiveValue,
      }),
      effectiveSourceLabel: configSourceLabel(effectiveEntry?.sourceLayer ?? null),
      ...(!privateValue && selectedValue !== undefined
        ? { value: selectedValue as string | number | boolean }
        : {}),
      ...(!privateValue && effectiveEntry?.effectiveValue !== undefined && effectiveEntry.effectiveValue !== null
        ? { effectiveValue: effectiveEntry.effectiveValue as string | number | boolean }
        : {}),
      ...(!privateValue && schema.default !== undefined ? { defaultValue: schema.default } : {}),
      ...(schema.values ? { enumValues: [...schema.values] } : {}),
      ...(presentation?.valueLabels ? { valueLabels: { ...presentation.valueLabels } } : {}),
      ...(presentation?.recommendedValue !== undefined
        ? { recommendedValue: presentation.recommendedValue }
        : {}),
      ...(presentation?.placeholder ? { placeholder: presentation.placeholder } : {}),
      ...(presentation?.unit ? { unit: presentation.unit } : {}),
      ...(schema.min !== undefined ? { min: schema.min } : {}),
      ...(schema.max !== undefined ? { max: schema.max } : {}),
      advanced: presentation?.advanced === true,
    };
  };
  const assigned = new Set<string>();
  const groups = (options.schema.presentation?.groups ?? []).map((group) => {
    group.fields.forEach((key) => assigned.add(key));
    return {
      id: group.id,
      title: group.title,
      ...(group.description ? { description: group.description } : {}),
      advanced: group.advanced === true,
      fields: group.fields.map(fieldModel),
    };
  });
  const syntheticGroupId = (preferred: string): string => {
    const existing = new Set(groups.map((group) => group.id));
    let id = preferred;
    let suffix = 2;
    while (existing.has(id)) {
      id = `${preferred}-${suffix}`;
      suffix += 1;
    }
    return id;
  };
  const remaining = Object.keys(options.schema.schema).filter((key) => !assigned.has(key));
  if (!options.schema.presentation) {
    groups.push({
      id: 'general',
      title: '插件设置',
      advanced: false,
      fields: Object.keys(options.schema.schema).map(fieldModel),
    });
  } else {
    const ordinary = remaining.filter((key) => options.schema.presentation?.fields?.[key]?.advanced !== true);
    const advanced = remaining.filter((key) => options.schema.presentation?.fields?.[key]?.advanced === true);
    if (ordinary.length > 0) {
      groups.push({
        id: syntheticGroupId('general'),
        title: groups.length === 0 ? '插件设置' : '其他设置',
        advanced: false,
        fields: ordinary.map(fieldModel),
      });
    }
    if (advanced.length > 0) {
      groups.push({
        id: syntheticGroupId('advanced'),
        title: '高级设置',
        advanced: true,
        fields: advanced.map(fieldModel),
      });
    }
  }
  return groups;
}

export function buildConfigPage(options: {
  pluginId: string;
  schema: PluginConfigSchema;
  read: ResolvedConfigRead;
  effectiveRead?: ResolvedConfigRead;
}): ConfigPageViewModel {
  const privateFields = new Set(Object.entries(options.schema.schema)
    .filter(([, field]) => field.sensitive === true || field.type === 'file' || field.type === 'directory')
    .map(([key]) => key));
  const presets = (options.schema.presentation?.presets ?? []).map((preset): ConfigPresetViewModel => {
    const privateFieldTitles = Object.keys(preset.values)
      .filter((key) => privateFields.has(key))
      .map((key) => options.schema.schema[key]?.title ?? key);
    return {
      id: preset.id,
      title: preset.title,
      ...(preset.description ? { description: preset.description } : {}),
      values: Object.fromEntries(Object.entries(preset.values)
        .filter(([key]) => !privateFields.has(key))),
      ...(privateFieldTitles.length > 0 ? { privateFieldTitles } : {}),
    };
  });
  return {
    pluginId: options.pluginId,
    layer: { scope: options.read.scope, projectLayer: options.read.projectLayer },
    groups: buildConfigGroups(options),
    presets,
    storedCount: options.read.fields.filter((field) => field.storedSourceLayer !== undefined).length,
  };
}
