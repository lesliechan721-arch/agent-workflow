import type {
  PlatformName,
  PluginConfigFieldType,
  PluginConfigPresentationPreset,
  PluginConfigSchema,
  Scope,
} from '../types.js';
import type {
  StatusV6Payload,
  StatusV6PluginSummary,
  StatusV6Target,
  StatusV6Component,
  StatusTargetRevision,
  TargetRevisionState,
} from '../commands/status-v6.js';
import type {
  DependencyAssignmentSource,
  DependencyOperationPlan,
} from '../commands/dependency-operation-plan.js';
import type { DependencyScopeOverride } from '../types.js';
import type { ResolvedConfigRead } from '../utils/plugin-config.js';
import {
  safeDiagnosticCode,
  type DiagnosticImpactEntryViewModel,
  type DiagnosticSummaryViewModel,
} from './diagnostics.js';
import type { CatalogSourceFreshnessViewModel } from './catalog-freshness.js';
import type { CatalogSourceGenerationViewModel } from './catalog-generation.js';

export type SourceHealthState = 'ready' | 'unavailable';

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
      state: 'blocked';
      supportedScopes: Scope[];
      reason: 'artifactCollision';
    }
  | {
      platform: PlatformName;
      state: 'installed';
      scope: Scope;
      health: 'ready' | 'incomplete' | 'error';
      revision: TargetRevisionState;
      desiredScopes?: Scope[];
      relation?: StatusV6Target['desired']['relation'];
      actualState?: StatusV6Target['actual']['state'];
      activation?: StatusV6Target['activation'];
      sharedNative?: StatusV6Target['sharedNative'];
      extensions?: StatusV6Target['extensions'];
      recovery?: StatusV6Target['recovery'];
      blockingReason?: 'artifactCollision';
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
  | { id: 'add' | 'manage' | 'repair' | 'sync' | 'portableSkills' | 'dependencies' | 'settings'
      | 'source' | 'sourceProblem' | 'about' | 'refreshSource' | 'technical' | 'back'
      | 'outputCollision' }
  | { id: 'addScope'; platform: PlatformName; scope: Scope }
  | {
      id: 'resolveScopeConflict';
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
      keepScope: Scope;
      description: string;
    }
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
  supportedScopes?: Partial<Record<PlatformName, Scope[]>>;
  installedPlacements: PlatformPlacementSummary[];
  aggregateStatus: 'available' | 'installed' | 'needsAttention' | 'unavailable';
  primaryAttention?: {
    severity: 'warning' | 'error';
    code: string;
    message: string;
  };
  portableSkills: boolean;
  missingCapabilities?: string[];
  dependencySummary?: PluginDependencySummaryViewModel;
  technicalComponents: Array<{
    platform: PlatformName;
    scope: Scope;
    key: string;
    state: StatusV6Component['state'];
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

export interface DependencyPlacementTargetViewModel {
  key: string;
  pluginId: string;
  displayName: string;
  platform: PlatformName;
  relation: 'direct' | 'transitive';
  scope: Scope;
  minimumScope: Scope;
  allowedScopes: Scope[];
  locked: boolean;
  requiredBy: string[];
  assignmentSource: DependencyAssignmentSource;
  explanation: string;
  affectsOtherProjects: boolean;
  action: DependencyOperationPlan['targets'][number]['action'];
}

export interface InstallPlacementDraftViewModel {
  pluginId: string;
  rootScope: Scope;
  platforms: PlatformName[];
  dependencyScopeOverrides: DependencyScopeOverride[];
  state: 'selecting' | 'loading' | 'ready' | 'blocked';
  targets: DependencyPlacementTargetViewModel[];
  canContinue: boolean;
  error?: { code: string; message: string };
}

export interface SourceTabViewModel {
  id: string;
  label: string;
  count?: number;
  primary: boolean;
  state: 'ready' | 'checking' | 'update' | 'recovery' | 'error';
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
  freshness?: 'active';
  errorCode?: string;
  configDigest: string;
}

export interface HomeSummaryViewModel {
  availablePlugins: number;
  installedPlugins: number;
  issueCount: number;
  sourceCount: number;
  unavailableSourceCount: number;
  catalogUpdateCount: number;
  catalogRecoveryCount: number;
  catalogCheckingCount: number;
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
  fallbackDisplayValue?: string;
  fallbackSourceLabel?: string;
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
  | 'artifactCollision'
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

export type UserIssueGroup =
  | 'sourceRemoved'
  | 'artifactCollision'
  | 'sourceUnavailable'
  | 'dependency'
  | 'scope'
  | 'config'
  | 'installation'
  | 'diagnostic';

export type UserIssueActionId =
  | 'reinstall'
  | 'cleanup'
  | 'remove'
  | 'refreshSource'
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
  writeAction?: 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';
}

export type TargetIssueRootCode =
  | 'partial'
  | 'artifactCollision'
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

export interface TargetIssueEntityViewModel {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
}

export interface AffectedTargetViewModel extends TargetIssueEntityViewModel {
  relationship: 'direct' | 'consumer';
}

export interface UserIssueViewModel {
  issueId: string;
  category: UserIssueCategory;
  group: UserIssueGroup;
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
  relationship?: 'direct' | 'consumer';
  rootEntity?: TargetIssueEntityViewModel;
  affectedTargets?: AffectedTargetViewModel[];
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
  diagnostic: DiagnosticSummaryViewModel;
}

type UserIssueDraft = Omit<UserIssueViewModel, 'diagnostic' | 'group'>;

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

function targetHealth(target: StatusV6Target): 'ready' | 'incomplete' | 'error' {
  if (target.actual?.state === 'ready') return 'ready';
  if (target.actual?.state === 'needsSync'
    || target.actual?.state === 'drifted'
    || target.actual?.state === 'conflict'
    || target.actual?.state === 'orphaned'
    || target.actual?.state === 'unresolved') return 'incomplete';
  if (target.state === 'present') return 'ready';
  if (target.state === 'partial') return 'incomplete';
  return 'error';
}

export function isPureNativeCodexTarget(target: StatusV6Target): boolean {
  return target.platform === 'codex'
    && target.sharedNative?.shared === true
    && (target.extensions?.kinds.length ?? 0) === 0;
}

function isPureNativeCodexPlacement(
  placement: PlatformPlacementSummary,
): placement is Extract<PlatformPlacementSummary, { state: 'installed' }> {
  return placement.platform === 'codex'
    && placement.state === 'installed'
    && placement.sharedNative?.shared === true
    && (placement.extensions?.kinds.length ?? 0) === 0;
}

function parsedScopedUninstallRecovery(
  recovery: StatusV6Target['recovery'][number],
  expectedPlatform: PlatformName,
): { pluginId: string; scope: Scope; description: string } | undefined {
  if (recovery.command !== 'uninstall' || !recovery.scope) return undefined;
  const match = /(?:^|\s)aw uninstall ([^\s]+) --platform (codex|claude) --scope (user|project)(?:，|,|\s|$)/u
    .exec(recovery.description);
  if (!match || match[2] !== expectedPlatform || match[3] !== recovery.scope) return undefined;
  return { pluginId: match[1]!, scope: recovery.scope, description: recovery.description };
}

function scopeConflictRecoveryMenuActions(
  placement: Extract<PlatformPlacementSummary, { state: 'installed' }>,
): Extract<PluginMenuAction, { id: 'resolveScopeConflict' }>[] {
  if (placement.actualState !== 'conflict') return [];
  return (placement.recovery ?? []).flatMap((recovery) => {
    const parsed = parsedScopedUninstallRecovery(recovery, placement.platform);
    return parsed ? [{
      id: 'resolveScopeConflict' as const,
      pluginId: parsed.pluginId,
      platform: placement.platform,
      scope: parsed.scope,
      keepScope: parsed.scope === 'user' ? 'project' as const : 'user' as const,
      description: parsed.description,
    }] : [];
  });
}

function missingPureNativeScopes(
  plugin: PluginListItemViewModel,
  placement: PlatformPlacementSummary,
): Scope[] {
  if (!isPureNativeCodexPlacement(placement) || placement.actualState !== 'ready') return [];
  const supported = plugin.supportedScopes?.codex ?? ['user', 'project'];
  return supported.filter((scope) =>
    !placement.desiredScopes?.includes(scope) && placement.activation?.[scope] !== true);
}

function isInstalledScopeEvidence(target: StatusV6Target): boolean {
  return target.desired?.enabled === true
    || target.state === 'present'
    || target.state === 'partial';
}

function dependencyAssignmentExplanation(
  assignmentSource: DependencyAssignmentSource,
  requiredBy: string[],
): string {
  const consumer = requiredBy[0];
  return {
    root: '根插件位置',
    default: '推荐使用当前项目',
    existingWiderTarget: '复用健康的所有项目安装',
    userOverride: '你选择的位置',
    consumerPromotion: consumer
      ? `因 ${consumer} 的位置而一并调整`
      : '因上游依赖位置而一并调整',
    platformRequirement: '平台只支持这个位置',
  }[assignmentSource];
}

export function dependencyPlacementTargets(
  plan: DependencyOperationPlan,
): DependencyPlacementTargetViewModel[] {
  return plan.targets.filter((target) => target.relation === 'dependency').map((target) => ({
    key: `${target.pluginId}\0${target.platform}`,
    pluginId: target.pluginId,
    displayName: target.pluginName,
    platform: target.platform,
    relation: plan.dependencyEdges.some((edge) =>
      plan.requestedPluginIds.includes(edge.from)
      && edge.to === target.pluginId
      && edge.platform === target.platform)
      ? 'direct'
      : 'transitive',
    scope: target.resolvedScope,
    minimumScope: target.minimumScope,
    allowedScopes: [...target.allowedScopes],
    locked: (target.locked && target.lockReason !== 'dependencyScopeOverride')
      || target.allowedScopes.filter((scope) =>
        target.minimumScope === 'project' || scope === 'user').length < 2,
    requiredBy: [...target.requiredBy],
    assignmentSource: target.assignmentSource,
    explanation: dependencyAssignmentExplanation(target.assignmentSource, target.requiredBy),
    affectsOtherProjects: target.affectsOtherProjects,
    action: target.action,
  }));
}

function dependencyPluginIdFromMessage(message: string): string | undefined {
  return message.match(/(?:[a-z0-9]+(?:-[a-z0-9]+)*)\/(?:[a-z0-9]+(?:-[a-z0-9]+)*)/u)?.[0];
}

function rootPlacementFromIssueId(
  issueId: string | undefined,
  fallback: Pick<StatusV6Target, 'platform' | 'scope'>,
): Pick<TargetIssueEntityViewModel, 'platform' | 'scope'> {
  if (issueId) {
    for (const platform of ['claude', 'codex'] as const) {
      for (const scope of ['project', 'user'] as const) {
        if (issueId.includes(`:${platform}:${scope}:`)
          || issueId.endsWith(`:${platform}:${scope}`)) return { platform, scope };
      }
    }
  }
  return fallback;
}

function rootPluginIdFromIssueId(
  issueId: string | undefined,
  rootIssueCode: string | undefined,
): string | undefined {
  if (!issueId || !rootIssueCode || !issueId.startsWith(`${rootIssueCode}:`)) return undefined;
  for (const platform of ['claude', 'codex'] as const) {
    for (const scope of ['project', 'user'] as const) {
      const marker = `:${platform}:${scope}`;
      const markerIndex = issueId.indexOf(marker, rootIssueCode.length + 1);
      if (markerIndex > rootIssueCode.length + 1) {
        return issueId.slice(rootIssueCode.length + 1, markerIndex);
      }
    }
  }
  return undefined;
}

function targetIssueRelationship(options: {
  target: StatusV6Target;
  error?: StatusV6Target['errors'][number];
  dependencyPluginId?: string;
}): {
  relationship: 'direct' | 'consumer';
  rootEntity: TargetIssueEntityViewModel;
} {
  const consumer = options.error?.rootIssueId !== undefined
    && options.error.rootIssueCode !== undefined
    && (options.error.code !== options.error.rootIssueCode
      || options.dependencyPluginId !== undefined
        && options.dependencyPluginId !== options.target.pluginId);
  if (!consumer) {
    return {
      relationship: 'direct',
      rootEntity: {
        pluginId: options.target.pluginId,
        platform: options.target.platform,
        scope: options.target.scope,
      },
    };
  }
  const placement = rootPlacementFromIssueId(options.error?.rootIssueId, options.target);
  return {
    relationship: 'consumer',
    rootEntity: {
      pluginId: rootPluginIdFromIssueId(
        options.error?.rootIssueId,
        options.error?.rootIssueCode,
      ) ?? options.dependencyPluginId ?? options.target.pluginId,
      ...placement,
    },
  };
}

export function projectPlatformPlacement(
  platform: PlatformName,
  targets: StatusV6Target[],
  revisions: StatusTargetRevision[] = [],
): PlatformPlacementSummary {
  const revisionFor = (target: StatusV6Target): TargetRevisionState =>
    revisions.find((entry) => entry.pluginId === target.pluginId
      && entry.platform === target.platform
      && entry.scope === target.scope)?.revision
      ?? { state: 'unknown', ...(target.version ? { availableVersion: target.version } : {}) };
  const supportedScopes = [...new Set(targets.map((target) => target.scope))];
  const installed = targets.filter(isInstalledScopeEvidence);
  if (installed.length === 0) {
    if (targets.some((target) => target.errors.some((error) =>
      error.code === 'artifactCollision' && error.severity === 'blocking'))) {
      return { platform, state: 'blocked', supportedScopes, reason: 'artifactCollision' };
    }
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
    const blockingReason = target.errors.some((error) =>
      error.code === 'artifactCollision' && error.severity === 'blocking')
      ? 'artifactCollision' as const
      : undefined;
    return {
      platform,
      state: 'installed',
      scope: target.scope,
      health: targetHealth(target),
      revision: revisionFor(target),
      ...(target.desired ? {
        desiredScopes: [...target.desired.scopes],
        relation: target.desired.relation,
      } : {}),
      ...(target.actual ? { actualState: target.actual.state } : {}),
      ...(target.activation ? { activation: target.activation } : {}),
      ...(target.sharedNative ? { sharedNative: target.sharedNative } : {}),
      ...(target.extensions ? { extensions: target.extensions } : {}),
      ...(target.recovery ? { recovery: [...target.recovery] } : {}),
      ...(blockingReason ? { blockingReason } : {}),
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
    || placement.state === 'installed'
      && (placement.health !== 'ready' || placement.blockingReason !== undefined));
}

function hasMissingPlatform(plugin: PluginListItemViewModel): boolean {
  return plugin.supportedPlatforms.some((platform) =>
    plugin.installedPlacements.find((placement) => placement.platform === platform)?.state === 'notInstalled');
}

function allSupportedPlatformsBlocked(plugin: PluginListItemViewModel): boolean {
  return plugin.supportedPlatforms.length > 0 && plugin.supportedPlatforms.every((platform) =>
    plugin.installedPlacements.some((placement) => placement.platform === platform
      && (placement.state === 'blocked'
        || placement.state === 'installed' && placement.blockingReason === 'artifactCollision')));
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
  if (allSupportedPlatformsBlocked(plugin)) {
    return [
      { id: 'outputCollision' },
      ...(hasInstalledPlacement(plugin) ? [{ id: 'manage' as const }] : []),
      { id: 'source' },
      { id: 'about' },
    ];
  }
  const collisionWithInstallablePlatform = hasMissingPlatform(plugin)
    && plugin.installedPlacements.some((placement) => placement.state === 'blocked'
      || placement.state === 'installed' && placement.blockingReason === 'artifactCollision');
  const primary: PluginMenuAction = collisionWithInstallablePlatform
    ? { id: 'add' }
    : hasIncompletePlacement(plugin) || (plugin.dependencySummary?.issueCount ?? 0) > 0
      ? { id: 'repair' }
      : installed && !hasMissingPlatform(plugin) ? { id: 'manage' } : { id: 'add' };
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
    ...plugin.installedPlacements.flatMap((placement): PluginMenuAction[] => [
      ...(placement.state === 'installed' ? scopeConflictRecoveryMenuActions(placement) : []),
      placement.state === 'scopeConflict'
        ? { id: 'scopeConflict', platform: placement.platform }
        : { id: 'platform', platform: placement.platform },
    ]),
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
  if (placement?.state === 'blocked') {
    return [{ id: 'outputCollision' }, { id: 'source' }, { id: 'about' }];
  }
  if (!placement || placement.state === 'notInstalled') return [{ id: 'add' }, { id: 'about' }];
  if (placement.state === 'scopeConflict') return [{ id: 'scopeConflict', platform }];
  const scopedRecovery = scopeConflictRecoveryMenuActions(placement);
  if (scopedRecovery.length > 0) return [...scopedRecovery, { id: 'technical' }];
  if (placement.blockingReason === 'artifactCollision') {
    return [
      { id: 'outputCollision' },
      { id: 'remove', platform, scope: placement.scope },
      { id: 'technical' },
    ];
  }
  if (placement.health === 'error') return [{ id: 'technical' }, { id: 'back' }];
  if (placement.health === 'incomplete') {
    if (platform === 'codex'
      && (placement.actualState === 'needsSync' || placement.actualState === 'drifted'
        || placement.recovery?.some((action) => action.command === 'sync'))) {
      return [
        { id: 'sync' },
        { id: 'technical' },
        { id: 'remove', platform, scope: placement.scope },
      ];
    }
    return [
      { id: 'reinstall', platform, scope: placement.scope },
      { id: 'technical' },
      { id: 'remove', platform, scope: placement.scope },
    ];
  }
  return [
    ...missingPureNativeScopes(plugin, placement).map((scope): PluginMenuAction => ({
      id: 'addScope', platform, scope,
    })),
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
  return plugin.installedPlacements.some((placement) =>
    placement.state === 'installed' || placement.state === 'scopeConflict');
}

function sourceState(
  source: StatusV6Payload['catalog']['sources'][number],
  health?: SourceHealthViewModel,
  freshness?: CatalogSourceFreshnessViewModel,
  generation?: CatalogSourceGenerationViewModel,
): SourceTabViewModel['state'] {
  if (health?.state === 'unavailable') return 'error';
  if (source.error) return 'error';
  if (generation?.state && generation.state !== 'ready') return 'recovery';
  if (freshness?.state === 'checking') return 'checking';
  if (freshness?.state === 'updateAvailable'
    || freshness?.state === 'localChangesAvailable') return 'update';
  if (freshness?.state === 'versionConflict'
    || freshness?.state === 'rollbackDetected'
    || freshness?.state === 'incompatible') return 'recovery';
  if (freshness?.state === 'checkFailed') return 'error';
  return 'ready';
}

function sourceIssue(
  health: SourceHealthViewModel,
  impactedTargets = 0,
): UserIssueDraft | undefined {
  if (health.state !== 'unavailable') return undefined;
  const issueId = health.issueId ?? `source:${health.sourceId}:unavailable`;
  return {
    issueId,
    category: 'sourceUnavailable',
    title: `${health.sourceId} · 来源不可用`,
    explanation: '来源检查失败。',
    impact: ['当前不能浏览或安装这个来源的插件。',
      ...(impactedTargets > 0 ? [`${impactedTargets} 个安装位置受此来源根问题影响。`] : [])],
    entity: { kind: 'source', id: health.sourceId },
    sourceId: health.sourceId,
    actions: [
      { id: 'editSource', label: '编辑来源', description: '检查 URL、路径或 ref' },
      { id: 'refreshSource', label: '稍后重试', description: '只重新检查来源' },
      { id: 'viewTechnical', label: '技术详情' },
    ],
    technicalDetails: [{
      code: 'catalogSourceUnavailable',
      message: '来源检查失败。',
    }],
  };
}

function targetIssues(payload: StatusV6Payload): UserIssueDraft[] {
  const issues: UserIssueDraft[] = [];
  const byPlacement = new Map<string, StatusV6Target[]>();
  const canonicalRootsByEntity = new Map<string, string>();
  for (const target of payload.targets) {
    for (const error of target.errors) {
      if (!error.rootIssueId || !error.rootIssueCode) continue;
      const dependencyPluginId = error.dependencyPluginId
        ?? dependencyPluginIdFromMessage(error.message);
      const relationship = targetIssueRelationship({ target, error, dependencyPluginId });
      if (relationship.relationship !== 'consumer') continue;
      const key = [
        error.rootIssueCode,
        relationship.rootEntity.pluginId,
        relationship.rootEntity.platform,
        relationship.rootEntity.scope,
      ].join('\0');
      const current = canonicalRootsByEntity.get(key);
      if (!current || compareText(error.rootIssueId, current) < 0) {
        canonicalRootsByEntity.set(key, error.rootIssueId);
      }
    }
  }
  for (const target of payload.targets) {
    const key = `${target.pluginId}\0${target.platform}`;
    byPlacement.set(key, [...(byPlacement.get(key) ?? []), target]);
    const scopedConflictRecovery = target.actual?.state === 'conflict'
      ? target.recovery.flatMap((recovery) => {
          const parsed = parsedScopedUninstallRecovery(recovery, target.platform);
          return parsed ? [{ ...parsed, keepScope: parsed.scope === 'user'
            ? 'project' as const : 'user' as const }] : [];
        })
      : [];
    if (scopedConflictRecovery.length > 0) {
      issues.push({
        issueId: `scope:${target.pluginId}:${target.platform}`,
        category: 'scopeConflict',
        title: `${target.pluginId} · ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · 扩展位置冲突`,
        explanation: 'AW-only 扩展不能同时使用所有项目和当前项目位置。',
        impact: ['选择一条 root uninstall 路径，然后按该路径同步保留的 scope。'],
        entity: { kind: 'plugin', id: target.pluginId },
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.scope,
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        placements: [...target.desired.scopes].sort(compareText),
        actions: [
          ...scopedConflictRecovery.map((recovery): UserIssueActionViewModel => ({
            id: recovery.keepScope === 'user' ? 'keepUserScope' : 'keepProjectScope',
            label: `保留${recovery.keepScope === 'user' ? '所有项目' : '当前项目'}`,
            description: recovery.description,
            pluginId: recovery.pluginId,
            platform: target.platform,
            scope: recovery.scope,
            writeAction: 'uninstall',
          })),
          { id: 'viewTechnical', label: '查看冲突详情' },
        ],
        technicalDetails: [{
          code: 'codexExtensionScopeConflict',
          message: 'mixed 或 AW-only 扩展同时使用两个 scope。',
        }],
      });
    }
    if (target.state !== 'partial' && target.state !== 'error'
      && !target.errors.some((error) => error.code === 'artifactCollision'
        || error.dependencyPluginId !== undefined && error.rootIssueId !== undefined)) continue;
    const codes = new Set(target.errors.map((error) => error.code));
    const dependencyCodes = [
      'dependencyMissing',
      'dependencyNotReady',
      'dependencyTargetUnsupported',
      'dependencyStillRequired',
      'dependencyGraphInvalid',
    ] as const;
    type TargetIssueRoot = {
      code: TargetIssueRootCode;
      category: UserIssueCategory;
      mergeEligible: boolean;
      error?: StatusV6Target['errors'][number];
      dependencyPluginId?: string;
    };
    const dependencyRootMap = new Map<string, TargetIssueRoot>();
    for (const error of target.errors) {
      if (!dependencyCodes.includes(error.code as typeof dependencyCodes[number])) continue;
      if (error.rootIssueCode === 'artifactCollision') {
        dependencyRootMap.set(error.rootIssueId ?? `artifactCollision\0${error.dependencyPluginId ?? ''}`, {
          code: 'artifactCollision',
          category: 'artifactCollision',
          mergeEligible: false,
          error,
          dependencyPluginId: error.dependencyPluginId,
        });
        continue;
      }
      const code = error.code as typeof dependencyCodes[number];
      const dependencyPluginId = error.dependencyPluginId ?? dependencyPluginIdFromMessage(error.message);
      dependencyRootMap.set(`${code}\0${dependencyPluginId ?? ''}`, {
        code,
        category: code,
        mergeEligible: false,
        error,
        dependencyPluginId,
      });
    }
    const dependencyRoots = [...dependencyRootMap.values()];
    const directCollision = target.errors.find((error) => error.code === 'artifactCollision');
    const projectedCollisionRoots = dependencyRoots.filter((root) => root.code === 'artifactCollision');
    const ordinaryDependencyRoots = dependencyRoots.filter((root) => root.code !== 'artifactCollision');
    const roots: TargetIssueRoot[] = codes.has('sourceMissing')
      ? [{ code: 'sourceMissing', category: 'sourceMissing', mergeEligible: false }]
      : directCollision || projectedCollisionRoots.length > 0
      ? [{
          code: 'artifactCollision',
          category: 'artifactCollision',
          mergeEligible: false,
          error: directCollision ?? projectedCollisionRoots[0]!.error,
          dependencyPluginId: projectedCollisionRoots[0]?.dependencyPluginId,
        }]
      : codes.has('sourceChanged')
          ? [{ code: 'sourceChanged', category: 'sourceIdentityChanged', mergeEligible: false }]
          : codes.has('catalogSourceUnavailable') || codes.has('bundleUnavailable')
            ? [
                ...(codes.has('catalogSourceUnavailable')
                  ? [{ code: 'catalogSourceUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: true }]
                  : []),
                ...(codes.has('bundleUnavailable')
                  ? [{ code: 'bundleUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: false }]
                  : []),
              ]
          : ordinaryDependencyRoots.length > 0
            ? ordinaryDependencyRoots
            : target.state === 'partial'
              ? [{ code: 'partial', category: 'incompleteInstallation', mergeEligible: false }]
          : [
              { code: 'targetDiagnostic' as const, category: 'diagnostic' as const, mergeEligible: false },
            ];
    for (const root of roots) {
      const rootError = root.error ?? target.errors.find((error) => error.code === root.code);
      const dependencyPluginId = root.dependencyPluginId
        ?? rootError?.dependencyPluginId
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
            : root.category === 'artifactCollision'
              ? [
                  { id: 'viewTechnical', label: '查看冲突原因' },
                  { id: 'retryLater', label: '处理冲突后重试' },
                ]
              : root.category === 'incompleteInstallation'
        ? [
            { id: 'reinstall', label: '重新安装', description: '保留插件设置，重新生成缺失内容' },
            { id: 'remove', label: '移除安装', description: '保留插件设置' },
            { id: 'viewTechnical', label: '技术详情' },
          ]
        : root.category === 'sourceMissing'
          ? [
              { id: 'cleanup', label: '清理已安装内容', description: '只清理 matching owner 的现场内容；保留插件设置', writeAction: 'cleanup' },
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
                  ...(root.code === 'bundleUnavailable' ? [{
                    id: 'cleanup' as const,
                    label: '清理已安装内容',
                    description: '只清理 AW 管理的现场内容；保留插件设置',
                    writeAction: 'cleanup' as const,
                  }] : []),
                  { id: 'editSource', label: '查看来源', description: root.code === 'bundleUnavailable' ? '检查当前 Catalog 或稍后重试' : '修复来源配置或稍后重试' },
                  { id: 'viewTechnical', label: '技术详情' },
                ]
              : [{ id: 'viewTechnical', label: '技术详情' }, { id: 'retryLater', label: '稍后重试' }];
      const bundleUnavailable = root.code === 'bundleUnavailable';
      const relationship = targetIssueRelationship({
        target,
        error: rootError,
        dependencyPluginId,
      });
      const directRootCode = root.code === 'partial' ? 'incompleteInstallation'
        : root.code === 'targetDiagnostic' ? 'diagnostic'
          : undefined;
      const canonicalRoot = relationship.relationship === 'direct' && directRootCode
        ? canonicalRootsByEntity.get([
            directRootCode,
            relationship.rootEntity.pluginId,
            relationship.rootEntity.platform,
            relationship.rootEntity.scope,
          ].join('\0'))
        : undefined;
      const issueId = rootError?.rootIssueId
        ?? canonicalRoot
        ?? (directRootCode
          ? `${directRootCode}:${target.pluginId}:${target.platform}:${target.scope}`
          : `target:${target.pluginId}:${target.platform}:${target.scope}:${target.state}${roots.length > 1 ? `:${root.code}` : ''}${dependencyPluginId ? `:${dependencyPluginId}` : ''}`);
      issues.push({
        issueId,
        category: root.category,
        rootCode: root.code,
        mergeEligible: root.mergeEligible,
        relationship: relationship.relationship,
        rootEntity: relationship.rootEntity,
        affectedTargets: [{
          pluginId: target.pluginId,
          platform: target.platform,
          scope: target.scope,
          relationship: relationship.relationship,
        }],
        title: `${target.pluginId} · ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${root.category === 'artifactCollision' ? '输出冲突' : dependencyCategory ? {
          dependencyMissing: '缺少依赖',
          dependencyNotReady: '依赖安装不完整',
          dependencyTargetUnsupported: '依赖目标不兼容',
          dependencyStillRequired: '依赖仍被使用',
          dependencyGraphInvalid: '依赖关系无效',
        }[root.category as Exclude<UserIssueCategory, 'artifactCollision' | 'incompleteInstallation' | 'sourceUnavailable' | 'sourceMissing' | 'sourceIdentityChanged' | 'requiredConfigMissing' | 'scopeConflict' | 'legacyState' | 'diagnostic'>] : target.state === 'partial' ? '安装不完整' : bundleUnavailable ? '当前 Catalog 不再包含此插件' : '检查失败'}`,
        explanation: root.category === 'artifactCollision'
          ? '目标位置已有不属于当前插件的内容。AW 不会覆盖或删除这些内容。'
          : dependencyCategory
          ? dependencyPluginId
            ? `${dependencyPluginId} 导致当前依赖检查不能通过。`
            : '当前依赖检查不能安全通过。'
          : target.state === 'partial'
          ? '必要内容缺失，插件可能不能稳定运行。'
          : bundleUnavailable
            ? '当前 Catalog 不再包含此插件，但仍发现 AW 管理的已安装内容。'
            : '当前目标不能安全分类为正常安装。',
        impact: [root.category === 'artifactCollision'
          ? '请先移除或迁移冲突内容，然后重试安装或重新安装。'
          : bundleUnavailable
          ? '可以清理可信的 AW 现场；这不表示来源整体可用。'
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
            || error.code === root.code
            || error.rootIssueId === issueId)
            .map((error) => ({
              code: error.code,
              message: error.collision
                ? ({
                    ownerMismatch: '目标由其他 owner 占用。',
                    unownedContent: '目标包含没有 AW owner 标记的内容。',
                    typeMismatch: '目标节点类型不符合预期。',
                  })[error.collision.reason]
                : '状态检查报告了这个安全错误代码。',
            }))
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

function statusIssues(payload: StatusV6Payload): UserIssueDraft[] {
  const targetCodes = new Set(payload.targets.flatMap((target) =>
    target.errors.map((error) => error.code)));
  const issues = new Map<string, UserIssueDraft>();
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

function configIssues(pluginSummaries: StatusV6PluginSummary[]): UserIssueDraft[] {
  return pluginSummaries.flatMap((summary): UserIssueDraft[] => {
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
        technicalDetails: [{
          code: summary.configDiagnostic.code,
          message: '设置读取报告了这个安全错误代码。',
        }],
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

function dependencyOverviewIssues(
  overviews: PluginDependencyOverviewViewModel[],
  pluginSummaries: StatusV6PluginSummary[],
  status: StatusV6Payload,
): UserIssueDraft[] {
  const summaryById = new Map(pluginSummaries.map((summary) => [summary.pluginId, summary]));
  return overviews.flatMap((overview) => overview.blockers.flatMap((blocker): UserIssueDraft[] => {
    if (blocker.code !== 'dependencyGraphInvalid'
      && blocker.code !== 'dependencyTargetUnsupported') return [];
    if (status.targets.some((target) => target.pluginId === overview.pluginId
      && target.errors.some((error) => error.code === blocker.code))) return [];
    const summary = summaryById.get(overview.pluginId);
    const sourceId = overview.pluginId.slice(0, overview.pluginId.indexOf('/'));
    const category = blocker.code;
    return [{
      issueId: `dependency:${overview.pluginId}:${blocker.code}`,
      category,
      rootCode: category,
      mergeEligible: false,
      title: `${summary?.displayName ?? summary?.pluginName ?? overview.pluginId} · ${blocker.title}`,
      explanation: blocker.explanation,
      impact: [category === 'dependencyGraphInvalid'
        ? '修复依赖关系后才能安全计算安装顺序。'
        : '当前不能在所有声明的平台上安全安装这个插件。'],
      entity: { kind: 'plugin', id: overview.pluginId },
      pluginId: overview.pluginId,
      sourceId,
      actions: [
        { id: 'viewDependencies', label: '查看依赖关系' },
        { id: 'viewTechnical', label: '技术详情' },
      ],
      technicalDetails: [{ code: blocker.code, message: blocker.explanation }],
    }];
  }));
}

function enrichDependencyIssuePlacements(
  issues: UserIssueDraft[],
  overviews: PluginDependencyOverviewViewModel[],
): UserIssueDraft[] {
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

function issueDiagnostic(
  issue: UserIssueDraft,
  sourceDetails: ReadonlyMap<string, SourceDetailViewModel>,
): DiagnosticSummaryViewModel {
  const source = issue.sourceId ? sourceDetails.get(issue.sourceId) : undefined;
  const sourceUnavailable = issue.category === 'sourceUnavailable' && issue.entity.kind === 'source';
  const configUnavailable = issue.category === 'diagnostic' && issue.issueId.startsWith('config:');
  const configInvalid = issue.category === 'requiredConfigMissing';
  const dependency = issue.category.startsWith('dependency');
  const platformState = issue.issueId.startsWith('status:') || issue.rootCode === 'targetDiagnostic';
  const preserved = sourceUnavailable
    ? '已安装插件和已保存设置不会被删除。'
    : configUnavailable
      ? '已保存的设置保持不变。'
      : '现有安装和已保存设置不会因本页自动改变。';
  const impact: DiagnosticImpactEntryViewModel[] = sourceUnavailable
      ? [
          { state: 'blocked', message: '当前不能浏览或安装这个来源中的插件。' },
          { state: 'preserved', message: preserved },
        ]
      : [
          ...issue.impact.map((message): DiagnosticImpactEntryViewModel => ({
            state: dependency || configUnavailable || configInvalid || platformState ? 'blocked' : 'degraded',
            message,
          })),
          { state: 'preserved', message: preserved },
        ];
  const primaryAction = issue.actions.find((action) => action.id !== 'viewTechnical');
  const nextStep = primaryAction
    ? `${primaryAction.label}，然后重新检查当前状态。`
    : '打开技术详情，记录安全错误代码后重新检查。';
  const sourceDiagnostic = sourceUnavailable;
  const rawCode = sourceDiagnostic
    ? source?.errorCode ?? issue.technicalDetails[0]?.code
    : issue.technicalDetails[0]?.code;
  const code = safeDiagnosticCode(rawCode, sourceUnavailable
    ? 'catalogSourceUnavailable' : 'diagnosticUnavailable');
  const stage = sourceUnavailable ? 'resolve-source'
    : configUnavailable ? 'read-config'
      : configInvalid ? 'validate-config'
      : dependency ? 'resolve-dependencies'
        : platformState ? 'read-platform-state' : 'inspect-target';
  const context = [
    ...(issue.pluginId ? [{ key: 'pluginId' as const, value: issue.pluginId }] : []),
    ...(issue.dependencyPluginId
      ? [{ key: 'dependencyPluginId' as const, value: issue.dependencyPluginId }]
      : []),
    ...(issue.platform ? [{ key: 'platform' as const, value: issue.platform }] : []),
    ...(issue.scope ? [{ key: 'scope' as const, value: issue.scope }] : []),
    ...(issue.requiredFields?.slice(0, 1).map((field) => ({
      key: 'field' as const,
      value: field.title,
    })) ?? []),
  ];
  const checks = issue.category === 'legacyState'
    ? [
        '不自动迁移旧版状态。',
        '运行 aw status --json，记录公开错误 code。',
        '备份相关 AW 配置。',
        '按技术详情使用受支持命令或人工处理。',
        '再次运行状态检查。',
      ]
    : sourceUnavailable
    ? ['检查 Git URL、ref 或本地目录。', '确认当前终端具备来源授权。', '运行“重新检查来源”验证修复。']
    : dependency
      ? ['检查依赖关系和依赖插件状态。', '完成恢复动作后重新检查根插件。']
      : configUnavailable
        ? ['恢复插件来源和可信字段定义。', '重新检查来源后再次打开设置。']
        : configInvalid
          ? ['完成或修正列出的设置字段。', '重新检查插件设置。']
        : ['检查目标平台配置和访问权限。', '完成恢复动作后重新运行状态检查。'];
  return {
    severity: 'error',
    title: issue.title,
    userMessage: issue.explanation,
    impact,
    nextStep,
    technical: {
      code,
      stage,
      ...(sourceDiagnostic && issue.sourceId ? { sourceId: issue.sourceId } : {}),
      ...(sourceDiagnostic && source?.requestedRef ? { requestedRef: source.requestedRef } : {}),
      ...(sourceDiagnostic && source?.resolvedCommit ? { resolvedCommit: source.resolvedCommit } : {}),
      ...(context.length > 0 ? { context } : {}),
      checks,
    },
  };
}

const issueGroupOrder: Record<UserIssueGroup, number> = {
  sourceRemoved: 0,
  artifactCollision: 1,
  sourceUnavailable: 2,
  dependency: 3,
  scope: 4,
  config: 5,
  installation: 6,
  diagnostic: 7,
};

function issueGroup(issue: UserIssueDraft): UserIssueGroup {
  if (issue.category === 'sourceMissing') return 'sourceRemoved';
  if (issue.category === 'artifactCollision') return 'artifactCollision';
  if (issue.category === 'sourceUnavailable'
    || issue.category === 'sourceIdentityChanged') return 'sourceUnavailable';
  if (issue.category.startsWith('dependency')) return 'dependency';
  if (issue.category === 'scopeConflict') return 'scope';
  if (issue.category === 'requiredConfigMissing') return 'config';
  if (issue.category === 'incompleteInstallation') return 'installation';
  return 'diagnostic';
}

function primaryAttentionCode(issue: UserIssueDraft): string {
  if (issue.category === 'requiredConfigMissing') {
    return issue.requiredFields?.some((field) => field.type === 'invalid-config')
      ? 'invalidConfig'
      : 'requiredConfigMissing';
  }
  if (issue.category === 'incompleteInstallation') return 'incompleteInstallation';
  if (issue.category === 'sourceIdentityChanged') return 'sourceUnavailable';
  return issue.rootCode ?? issue.category;
}

function issueReasonPriority(issue: UserIssueDraft): number {
  const code = primaryAttentionCode(issue);
  return ({
    sourceMissing: 0,
    artifactCollision: 1,
    sourceUnavailable: 2,
    catalogSourceUnavailable: 2,
    bundleUnavailable: 2,
    dependencyGraphInvalid: 3,
    dependencyTargetUnsupported: 4,
    dependencyNotReady: 5,
    dependencyMissing: 5,
    scopeConflict: 6,
    requiredConfigMissing: 7,
    invalidConfig: 7,
    incompleteInstallation: 8,
    diagnostic: 9,
  } as Record<string, number>)[code] ?? 9;
}

function collapseRootIssues(issues: UserIssueDraft[]): UserIssueDraft[] {
  const byId = new Map<string, UserIssueDraft[]>();
  for (const issue of issues) byId.set(issue.issueId, [...(byId.get(issue.issueId) ?? []), issue]);
  return [...byId.values()].map((group) => {
    const ordered = [...group].sort((left, right) =>
      Number(right.relationship === 'direct') - Number(left.relationship === 'direct')
      || compareText(left.pluginId ?? '', right.pluginId ?? '')
      || compareText(left.platform ?? '', right.platform ?? '')
      || compareText(left.scope ?? '', right.scope ?? ''));
    const primary = ordered[0]!;
    const direct = ordered.find((issue) => issue.relationship === 'direct');
    const rootEntity = direct?.rootEntity ?? ordered.map((issue) => issue.rootEntity)
      .filter((entity): entity is TargetIssueEntityViewModel => entity !== undefined)
      .sort((left, right) => compareText(left.pluginId, right.pluginId)
        || compareText(left.platform, right.platform)
        || compareText(left.scope, right.scope))[0];
    const affectedTargets = [...new Map(ordered.flatMap((issue) => issue.affectedTargets ?? [])
      .map((target) => [`${target.pluginId}\0${target.platform}\0${target.scope}`, target])).values()]
      .sort((left, right) => compareText(left.pluginId, right.pluginId)
        || compareText(left.platform, right.platform)
        || compareText(left.scope, right.scope));
    const projected = rootEntity && !direct ? {
      ...primary,
      title: `${rootEntity.pluginId} · ${rootEntity.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${primary.category === 'artifactCollision' ? '输出冲突' : primary.title.split(' · ').at(-1) ?? primary.title}`,
      entity: { kind: 'plugin' as const, id: rootEntity.pluginId },
      pluginId: rootEntity.pluginId,
      platform: rootEntity.platform,
      scope: rootEntity.scope,
      sourceId: rootEntity.pluginId.split('/', 1)[0],
    } : primary;
    return {
      ...projected,
      ...(rootEntity ? { rootEntity } : {}),
      ...(affectedTargets.length > 0 ? { affectedTargets } : {}),
      impact: [...new Set(ordered.flatMap((issue) => issue.impact))],
      technicalDetails: [...new Map(ordered.flatMap((issue) => issue.technicalDetails)
        .map((detail) => [`${detail.code}\0${detail.message}`, detail])).values()],
    };
  });
}

export function buildTuiViewModel(options: {
  status: StatusV6Payload;
  pluginSummaries: StatusV6PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceHealth?: ReadonlyMap<string, SourceHealthViewModel>;
  sourceDetails?: SourceDetailViewModel[];
  catalogFreshness?: ReadonlyMap<string, CatalogSourceFreshnessViewModel>;
  catalogGenerations?: ReadonlyMap<string, CatalogSourceGenerationViewModel>;
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
}): TuiViewModel {
  const dependencyById = new Map((options.dependencyOverviews ?? [])
    .map((overview) => [overview.pluginId, overview]));
  const summaryById = new Map(options.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  const targetsByPlugin = new Map<string, StatusV6Target[]>();
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
      || (placement.state === 'installed'
        && (placement.health !== 'ready' || placement.blockingReason !== undefined)));
    const installed = placements.some((placement) =>
      placement.state === 'installed' || placement.state === 'scopeConflict');
    const unavailable = options.sourceHealth?.get(sourceId)?.state === 'unavailable'
      || (summary?.missingCapabilities?.length ?? 0) > 0;
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
      ...(summary?.supportedTargets ? { supportedScopes: {
        codex: [...summary.supportedTargets.codex],
        claude: [...summary.supportedTargets.claude],
      } } : {}),
      installedPlacements: placements,
      aggregateStatus: unavailable ? 'unavailable' : attention ? 'needsAttention' : installed ? 'installed' : 'available',
      portableSkills: options.portablePluginIds?.includes(pluginId) ?? false,
      ...(summary?.missingCapabilities
        ? { missingCapabilities: summary.missingCapabilities }
        : {}),
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
    state: sourceState(
      source,
      options.sourceHealth?.get(source.id),
      options.catalogFreshness?.get(source.id),
      options.catalogGenerations?.get(source.id),
    ),
  }));
  const sourceRootIds = new Set([...(options.sourceHealth?.values() ?? [])]
    .filter((health) => health.state === 'unavailable')
    .map((health) => health.sourceId));
  const allTargetIssues = targetIssues(options.status);
  const targetImpactCounts = new Map<string, number>();
  for (const issue of allTargetIssues) {
    if (!issue.mergeEligible || !issue.sourceId || !sourceRootIds.has(issue.sourceId)) continue;
    targetImpactCounts.set(issue.sourceId, (targetImpactCounts.get(issue.sourceId) ?? 0) + 1);
  }
  const sourceDetails = new Map((options.sourceDetails ?? []).map((detail) => [detail.id, detail]));
  const issueDrafts = enrichDependencyIssuePlacements([
    ...allTargetIssues.filter((issue) => !issue.mergeEligible
      || !issue.sourceId || !sourceRootIds.has(issue.sourceId)),
    ...statusIssues(options.status),
    ...configIssues(options.pluginSummaries),
    ...dependencyOverviewIssues(
      options.dependencyOverviews ?? [],
      options.pluginSummaries,
      options.status,
    ),
    ...[...(options.sourceHealth?.values() ?? [])].flatMap((health) =>
      sourceIssue(health, targetImpactCounts.get(health.sourceId) ?? 0) ?? []),
  ], options.dependencyOverviews ?? []);
  const stableIssueDrafts = collapseRootIssues(issueDrafts).sort((left, right) =>
    issueGroupOrder[issueGroup(left)] - issueGroupOrder[issueGroup(right)]
    || issueReasonPriority(left) - issueReasonPriority(right)
    || compareText(primaryAttentionCode(left), primaryAttentionCode(right))
    || compareText(left.issueId, right.issueId));
  const issues = stableIssueDrafts.map((issue): UserIssueViewModel => ({
    ...issue,
    group: issueGroup(issue),
    diagnostic: issueDiagnostic(issue, sourceDetails),
  }));
  const pluginsWithAttention = plugins.map((plugin): PluginListItemViewModel => {
    const primary = stableIssueDrafts.filter((issue) => issue.pluginId === plugin.pluginId
      || issue.dependencyPluginId === plugin.pluginId
      || issue.affectedTargets?.some((target) => target.pluginId === plugin.pluginId)
      || issue.entity.kind === 'source' && issue.sourceId === plugin.sourceId)
      .sort((left, right) => issueReasonPriority(left) - issueReasonPriority(right)
        || compareText(primaryAttentionCode(left), primaryAttentionCode(right))
        || compareText(left.issueId, right.issueId))[0];
    if (!primary) return plugin;
    return {
      ...plugin,
      primaryAttention: {
        severity: 'error',
        code: primaryAttentionCode(primary),
        message: primary.explanation,
      },
    };
  });
  return {
    plugins: pluginsWithAttention,
    sourceTabs,
    sourceDetails: (options.sourceDetails ?? []).map((detail) => ({
      ...detail,
      pluginCount: pluginsWithAttention.filter((plugin) => plugin.sourceId === detail.id).length,
    })),
    issues,
    dependencyOverviews: options.dependencyOverviews ?? [],
    home: {
      availablePlugins: pluginsWithAttention.filter((plugin) => plugin.aggregateStatus === 'available').length,
      installedPlugins: pluginsWithAttention.filter(hasInstalledPlacement).length,
      issueCount: issues.length,
      sourceCount: sourceTabs.length,
      unavailableSourceCount: options.status.catalog.sources.filter((source) => source.error
        || options.sourceHealth?.get(source.id)?.state === 'unavailable').length,
      catalogUpdateCount: sourceTabs.filter((source) => source.state === 'update').length,
      catalogRecoveryCount: sourceTabs.filter((source) => source.state === 'recovery'
        || source.state === 'error').length,
      catalogCheckingCount: sourceTabs.filter((source) => source.state === 'checking').length,
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
  layerReads?: {
    user: ResolvedConfigRead;
    project: ResolvedConfigRead;
    local: ResolvedConfigRead;
  };
  dirtyKeys?: ReadonlySet<string>;
}): ConfigGroupViewModel[] {
  const entryByKey = new Map(options.read.fields.map((field) => [field.key, field]));
  const effectiveEntryByKey = new Map(
    (options.effectiveRead ?? options.read).fields.map((field) => [field.key, field]),
  );
  const effectivePage = options.read.scope === 'effective';
  const layerEntry = (layer: keyof NonNullable<typeof options.layerReads>, key: string) =>
    options.layerReads?.[layer].fields.find((field) => field.key === key);
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
    const omittedLayer = options.read.scope === 'user'
      ? 'user'
      : options.read.projectLayer === 'local' ? 'local' : 'project';
    const fallback = (['local', 'project', 'user'] as const)
      .filter((layer) => layer !== omittedLayer)
      .map((layer) => ({ layer, entry: layerEntry(layer, key) }))
      .find((candidate) => candidate.entry?.storedSourceLayer !== undefined);
    const fallbackValue = fallback?.entry?.storedValue ?? schema.default;
    const fallbackConfigured = fallback !== undefined || schema.default !== undefined;
    const fallbackSource = fallback?.layer ?? (schema.default !== undefined ? 'default' : undefined);
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
      ...(!effectivePage && configured ? {
        fallbackDisplayValue: displayConfigValue({
          privateValue,
          inherited: false,
          configured: fallbackConfigured,
          value: fallbackValue,
        }),
        fallbackSourceLabel: fallbackSource ? configSourceLabel(fallbackSource) : '未设置',
      } : {}),
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
  layerReads?: {
    user: ResolvedConfigRead;
    project: ResolvedConfigRead;
    local: ResolvedConfigRead;
  };
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
