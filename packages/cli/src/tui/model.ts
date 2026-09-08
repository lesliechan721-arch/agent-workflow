import {
  matchPluginConfigPreset,
  stablePluginConfigStringify,
} from '@lesliechan721/aw-plugin-core/manifest';

import type {
  PlatformName,
  PluginConfigFieldType,
  PluginConfigObject,
  PluginConfigPreset,
  PluginConfigScalar,
  PluginConfigSchemaField,
  PluginConfigSchema,
  PluginConfigValue,
  Scope,
} from '../types.js';
import type {
  StatusActivationProjection,
  StatusExtensionProjection,
  StatusIntentProjection,
  StatusSharedNativeProjection,
  StatusV7Payload,
  StatusV7PluginSummary,
  StatusV7Target,
  StatusV7Component,
  StatusTargetRevision,
  TargetRevisionState,
} from '../commands/status-v6.js';
import {
  statusTargetActivation,
  statusTargetExtensions,
  statusTargetIntent,
  statusTargetOwnershipState,
  statusTargetSharedNative,
} from '../commands/status-v6.js';
import type {
  DependencyAssignmentSource,
} from '../commands/dependency-operation-plan.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type { DependencyScopeOverride } from '../types.js';
import { buildAllowedLifecycleActions } from '../commands/operation-planner.js';
import type { ResolvedConfigRead } from '../utils/plugin-config.js';
import {
  safeDiagnosticCode,
  type DiagnosticImpactEntryViewModel,
  type DiagnosticSummaryViewModel,
} from './diagnostics.js';
import type { CatalogSourceFreshnessViewModel } from './catalog-freshness.js';
import type { CatalogSourceGenerationViewModel } from './catalog-generation.js';
import { projectCatalogSourceState } from './catalog-sources/projection.js';
import { projectLifecycleActionView } from './lifecycle-action-view.js';
import { compareStrictSemVer, tryParseStrictSemVer } from '../utils/manifest.js';
import { formatPluginId } from '../utils/multi-source-catalog.js';
import { createCatalogStoreKey } from '../utils/catalog-generation-store.js';

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
      relation?: StatusIntentProjection['relation'];
      actualState?: StatusV7Target['state'];
      activation?: StatusActivationProjection;
      sharedNative?: StatusSharedNativeProjection;
      extensions?: StatusExtensionProjection;
      recovery?: StatusV7Target['recoveryActions'];
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
      | 'outputCollision' | 'upgradeAwCli' | 'capabilityTechnical' }
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
  | {
      id: 'refreshAndSync';
      platform: PlatformName;
      scope: Scope;
      availableVersion: string;
      installedVersion: string;
      sourceIdentity: string;
      generationKey: string;
    }
  | { id: 'reinstall' | 'remove' | 'cleanup'; platform: PlatformName; scope: Scope };

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
  capabilityUnsupported?: boolean;
  capabilityRecovery?: string;
  sourceUnavailable?: boolean;
  savedConfigScopes: Scope[];
  configOnly?: true;
  dependencySummary?: PluginDependencySummaryViewModel;
  technicalComponents: Array<{
    platform: PlatformName;
    scope: Scope;
    key: string;
    state: StatusV7Component['state'];
    errorCode?: string;
  }>;
  update: PluginUpdateSummary;
}

export type PluginUpdateState = 'notChecked' | 'currentAgainstCatalog' | 'available'
  | 'sourceChangedUnverified' | 'blocked' | 'unknown';

export interface PluginUpdateTargetSummary {
  platform: PlatformName;
  scope: Scope;
  installedVersion?: string;
  activeVersion?: string;
  candidateVersion?: string;
  availableVersion?: string;
  candidateEvidence?: string;
  missingCapabilities?: string[];
  eligibility: 'allowed' | 'needsRepair' | 'incompatible' | 'unverified';
  requiresCatalogActivation?: true;
}

export interface PluginUpdateSummary {
  pluginId: string;
  state: PluginUpdateState;
  checkedAt?: string;
  lastSuccessful?: true;
  sourceIdentity?: string;
  generationKey?: string;
  targets: PluginUpdateTargetSummary[];
}

function candidateForPlugin(
  pluginId: string,
  sourceId: string,
  freshness: CatalogSourceFreshnessViewModel | undefined,
): NonNullable<CatalogSourceFreshnessViewModel['candidatePlugins']>[number] | undefined {
  return freshness?.candidatePlugins?.find((entry) => formatPluginId({
    sourceId,
    pluginName: entry.name,
  }) === pluginId);
}

export function buildPluginUpdateSummary(options: {
  pluginId: string;
  sourceId: string;
  targetRevisions: StatusTargetRevision[];
  targets: StatusV7Target[];
  freshness?: CatalogSourceFreshnessViewModel;
  sourceIdentity?: string;
  generationKey?: string;
}): PluginUpdateSummary {
  const candidate = candidateForPlugin(options.pluginId, options.sourceId, options.freshness);
  let sameVersionCandidateChange = false;
  let blockedCandidate = Boolean(options.freshness?.candidate
    && options.freshness.candidatePlugins && !candidate);
  const targets = options.targetRevisions
    .filter((entry) => entry.pluginId === options.pluginId)
    .map((entry): PluginUpdateTargetSummary => {
      const installedVersion = entry.revision.installedVersion;
      const activeVersion = entry.revision.availableVersion;
      const liveTarget = options.targets.find((target) => target.pluginId === entry.pluginId
        && target.platform === entry.platform && target.scope === entry.scope);
      const needsRepair = liveTarget !== undefined && liveTarget.state !== 'ready';
      const installedValid = installedVersion !== undefined && tryParseStrictSemVer(installedVersion) !== null;
      const activeValid = activeVersion !== undefined && tryParseStrictSemVer(activeVersion) !== null;
      const candidateValid = candidate !== undefined && tryParseStrictSemVer(candidate.version) !== null;
      const candidateCompatible = (candidate?.missingCapabilities.length ?? 0) === 0;
      let targetCandidateBlocked = false;
      const candidateEvidence = candidate && options.freshness?.candidate
        ? createCatalogStoreKey(
            options.freshness.candidate.logicalIdentity,
            options.freshness.candidate.snapshotDigest,
          )
        : undefined;
      if (!installedValid) {
        return {
          platform: entry.platform,
          scope: entry.scope,
          ...(installedVersion ? { installedVersion } : {}),
          ...(activeVersion ? { activeVersion } : {}),
          ...(candidate ? { candidateVersion: candidate.version } : {}),
          ...(candidateEvidence ? { candidateEvidence } : {}),
          eligibility: 'unverified',
        };
      }
      if (entry.revision.state === 'upgradeAvailable' && activeValid) {
        return {
          platform: entry.platform,
          scope: entry.scope,
          installedVersion,
          activeVersion,
          ...(candidate ? { candidateVersion: candidate.version } : {}),
          availableVersion: activeVersion,
          ...(candidateEvidence ? { candidateEvidence } : {}),
          eligibility: needsRepair ? 'needsRepair' : 'allowed',
        };
      }
      if (candidateValid) {
        const candidateRelation = compareStrictSemVer(installedVersion, candidate.version);
        const candidateUsable = candidateCompatible
          && options.freshness?.state !== 'incompatible'
          && options.freshness?.state !== 'rollbackDetected'
          && options.freshness?.state !== 'versionConflict';
        if (candidateRelation < 0 && candidateUsable) {
          return {
            platform: entry.platform,
            scope: entry.scope,
            installedVersion,
            ...(activeVersion ? { activeVersion } : {}),
            candidateVersion: candidate.version,
            availableVersion: candidate.version,
            ...(candidateEvidence ? { candidateEvidence } : {}),
            ...(candidate.missingCapabilities.length > 0
              ? { missingCapabilities: [...candidate.missingCapabilities] }
              : {}),
            eligibility: needsRepair ? 'needsRepair' : 'allowed',
            requiresCatalogActivation: true,
          };
        }
        if (candidateRelation < 0 || candidateRelation > 0) {
          blockedCandidate = true;
          targetCandidateBlocked = true;
        }
        if (candidateRelation === 0 && activeVersion === candidate.version
          && options.freshness?.state !== 'current') sameVersionCandidateChange = true;
      }
      const activeDowngrade = activeValid
        && compareStrictSemVer(installedVersion, activeVersion) > 0;
      return {
        platform: entry.platform,
        scope: entry.scope,
        installedVersion,
        ...(activeVersion ? { activeVersion } : {}),
        ...(candidate ? { candidateVersion: candidate.version } : {}),
        ...(candidateEvidence ? { candidateEvidence } : {}),
        ...(candidate && candidate.missingCapabilities.length > 0
          ? { missingCapabilities: [...candidate.missingCapabilities] }
          : {}),
        eligibility: activeDowngrade || targetCandidateBlocked ? 'incompatible'
          : needsRepair ? 'needsRepair' : activeValid ? 'allowed' : 'unverified',
      };
    })
    .sort((left, right) => `${left.platform}\0${left.scope}`.localeCompare(
      `${right.platform}\0${right.scope}`, 'en',
    ));
  const hasAvailable = targets.some((target) => target.availableVersion !== undefined);
  const hasInstalledVersion = targets.some((target) => target.installedVersion !== undefined);
  const allCurrent = targets.length > 0 && targets.every((target) => target.activeVersion !== undefined
    && target.installedVersion !== undefined
    && tryParseStrictSemVer(target.activeVersion) !== null
    && tryParseStrictSemVer(target.installedVersion) !== null
    && compareStrictSemVer(target.installedVersion, target.activeVersion) === 0);
  return {
    pluginId: options.pluginId,
    state: hasAvailable ? 'available'
      : sameVersionCandidateChange ? 'sourceChangedUnverified'
        : blockedCandidate || targets.some((target) => target.eligibility === 'incompatible') ? 'blocked'
          : allCurrent ? 'currentAgainstCatalog'
            : hasInstalledVersion ? 'unknown' : 'notChecked',
    ...(options.freshness?.checkedAt ? { checkedAt: options.freshness.checkedAt } : {}),
    ...(options.freshness?.lastSuccessful ? { lastSuccessful: true } : {}),
    ...(options.sourceIdentity ? { sourceIdentity: options.sourceIdentity } : {}),
    ...(options.generationKey ? { generationKey: options.generationKey } : {}),
    targets,
  };
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
  action: ReconcileOperationPlan['targets'][number]['action'];
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
  autoCheck: boolean;
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
  pluginUpdateCount: number;
  directPluginUpdateCount: number;
}

export interface ConfigFieldViewModel {
  key: string;
  title: string;
  description?: string;
  type: PluginConfigFieldType;
  definition: PluginConfigSchemaField;
  displayValue: string;
  required: boolean;
  sensitive: boolean;
  writable: boolean;
  canSet: boolean;
  canUnset: boolean;
  dirty: boolean;
  inherited: boolean;
  configured: boolean;
  sourceLabel: string;
  effectiveDisplayValue: string;
  effectiveSourceLabel: string;
  fallbackDisplayValue?: string;
  fallbackSourceLabel?: string;
  invalidOverrideIssue?: string;
  invalidOverrideOwnedByLayer?: boolean;
  fallbackObjectChanges?: Array<{
    property: string;
    before: string;
    after: string;
    private?: boolean;
  }>;
  value?: PluginConfigValue;
  effectiveValue?: PluginConfigValue;
  draftValue?: PluginConfigValue;
  defaultValue?: PluginConfigValue;
  choices?: PluginConfigPreset[];
  allowCustom: boolean;
  matchedPresetId?: string;
  placeholder?: string;
  unit?: string;
  min?: number;
  max?: number;
  advanced: boolean;
  sharedNativeRender?: boolean;
}

export interface ConfigGroupViewModel {
  id: string;
  title: string;
  description?: string;
  advanced: boolean;
  fields: ConfigFieldViewModel[];
}

export interface ConfigPresetViewModel {
  id: string;
  title: string;
  description?: string;
  values: Record<string, PluginConfigValue>;
  privateFieldTitles?: string[];
}

export interface ConfigPageViewModel {
  pluginId: string;
  layer: { scope: Scope | 'effective' };
  groups: ConfigGroupViewModel[];
  presets: ConfigPresetViewModel[];
  storedCount: number;
}

export function configObjectHasSensitiveChild(field: PluginConfigSchemaField): boolean {
  if (field.type !== 'object') return false;
  return Object.values(field.properties ?? {}).some((property) => property.sensitive === true)
    || (field.additionalProperties !== false && field.additionalProperties?.sensitive === true);
}

export type UserIssueCategory =
  | 'incompleteInstallation'
  | 'artifactCollision'
  | 'sourceUnavailable'
  | 'sourceMissing'
  | 'sourceIdentityChanged'
  | 'requiredConfigMissing'
  | 'configLayerUnsupported'
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
  | 'install'
  | 'sync'
  | 'refreshAndSync'
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
  writeAction?: 'install' | 'refreshAndSync' | 'reinstall' | 'uninstall' | 'cleanup' | 'sync';
}

export type TargetIssueRootCode =
  | 'partial'
  | 'artifactCollision'
  | 'sourceMissing'
  | 'sourceChanged'
  | 'catalogSourceUnavailable'
  | 'bundleUnavailable'
  | 'codexIntentSourceUnavailable'
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
    type: 'missing-required' | 'invalid-config' | 'sharedCompositeContainsLocalPath' | 'configLayerUnsupported';
    source: 'default' | 'user' | 'project' | 'missing';
    scope: Scope;
  }>;
  configLayer?: { scope: Scope };
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

function targetHealth(target: StatusV7Target): 'ready' | 'incomplete' | 'error' {
  if (target.state === 'ready') return 'ready';
  if (target.state === 'needsSync' || target.state === 'orphaned') return 'incomplete';
  return target.state === 'blocked' ? 'error' : 'incomplete';
}

export function isPureNativeCodexTarget(target: StatusV7Target): boolean {
  const sharedNative = statusTargetSharedNative(target);
  const extensions = statusTargetExtensions(target);
  return target.platform === 'codex'
    && sharedNative !== undefined
    && (extensions?.kinds.length ?? 0) === 0;
}

function isPureNativeCodexPlacement(
  placement: PlatformPlacementSummary,
): placement is Extract<PlatformPlacementSummary, { state: 'installed' }> {
  return placement.platform === 'codex'
    && placement.state === 'installed'
    && placement.sharedNative !== undefined
    && (placement.extensions?.kinds.length ?? 0) === 0;
}

function parsedScopedUninstallRecovery(
  recovery: StatusV7Target['recoveryActions'][number],
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
  if (placement.actualState !== 'blocked') return [];
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

function isInstalledScopeEvidence(target: StatusV7Target): boolean {
  return statusTargetIntent(target).enabled
    || statusTargetOwnershipState(target) === 'present'
    || statusTargetOwnershipState(target) === 'partial';
}

function dependencyAssignmentExplanation(
  assignmentSource: DependencyAssignmentSource,
  requiredBy: string[],
): string {
  const consumer = requiredBy[0];
  return {
    root: '当前插件位置',
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
  plan: ReconcileOperationPlan,
): DependencyPlacementTargetViewModel[] {
  return plan.targets.filter((target) => target.relation === 'dependency').map((target) => ({
    key: `${target.pluginId}\0${target.platform}`,
    pluginId: target.pluginId,
    displayName: target.pluginName,
    platform: target.platform,
    relation: target.depth === 1 ? 'direct' : 'transitive',
    scope: target.resolvedScope,
    minimumScope: target.minimumScope,
    allowedScopes: [...target.allowedScopes],
    locked: target.locked && target.lockReason !== 'dependencyScopeOverride',
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
  fallback: Pick<StatusV7Target, 'platform' | 'scope'>,
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
  target: StatusV7Target;
  error?: StatusV7Target['reasons'][number];
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
  targets: StatusV7Target[],
  revisions: StatusTargetRevision[] = [],
): PlatformPlacementSummary {
  const revisionFor = (target: StatusV7Target): TargetRevisionState =>
    revisions.find((entry) => entry.pluginId === target.pluginId
      && entry.platform === target.platform
      && entry.scope === target.scope)?.revision
      ?? { state: 'unknown', ...(target.version ? { availableVersion: target.version } : {}) };
  const supportedScopes = [...new Set(targets.map((target) => target.scope))];
  const installed = targets.filter(isInstalledScopeEvidence);
  if (installed.length === 0) {
    if (targets.some((target) => target.reasons.some((reason) =>
      reason.code === 'artifactCollision' && reason.severity === 'blocking'))) {
      return { platform, state: 'blocked', supportedScopes, reason: 'artifactCollision' };
    }
    const errorTarget = targets.find((target) => target.state === 'blocked');
    if (!errorTarget) return { platform, state: 'notInstalled', supportedScopes };
    return {
      platform,
      state: 'installed',
      scope: errorTarget.scope,
      health: 'error',
      revision: revisionFor(errorTarget),
    };
  }
  const target = installed.find((candidate) => candidate.state === 'blocked')
    ?? installed.find((candidate) => candidate.state === 'needsSync')
    ?? installed.find((candidate) => candidate.state === 'orphaned')
    ?? installed[0]!;
  const intent = statusTargetIntent(target);
  const activation = statusTargetActivation(target);
  const sharedNative = statusTargetSharedNative(target);
  const extensions = statusTargetExtensions(target);
  const blockingReason = target.reasons.some((reason) =>
    reason.code === 'artifactCollision' && reason.severity === 'blocking')
    ? 'artifactCollision' as const
    : undefined;
  return {
    platform,
    state: 'installed',
    scope: target.scope,
    health: targetHealth(target),
    revision: revisionFor(target),
    desiredScopes: [...intent.scopes],
    relation: intent.relation,
    actualState: target.state,
    ...(activation ? { activation } : {}),
    ...(sharedNative ? { sharedNative } : {}),
    ...(extensions ? { extensions } : {}),
    recovery: [...target.recoveryActions],
    ...(blockingReason ? { blockingReason } : {}),
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

function capabilityUnavailableActions(): PluginMenuAction[] {
  return [{ id: 'upgradeAwCli' }, { id: 'capabilityTechnical' }];
}

function isCapabilityUnavailable(plugin: PluginListItemViewModel): boolean {
  return plugin.capabilityUnsupported === true && plugin.sourceUnavailable !== true;
}

export function buildPluginPreviewActions(plugin: PluginListItemViewModel): PluginMenuAction[] {
  const installed = hasInstalledPlacement(plugin);
  if (plugin.aggregateStatus === 'unavailable') {
    if (isCapabilityUnavailable(plugin)) {
      return [...capabilityUnavailableActions(), ...(installed ? [{ id: 'manage' as const }] : [])];
    }
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
    if (isCapabilityUnavailable(plugin)) {
      return [
        ...plugin.installedPlacements.flatMap((placement) => placement.state === 'notInstalled'
          ? []
          : [{ id: 'platform' as const, platform: placement.platform }]),
        ...capabilityUnavailableActions(),
        { id: 'about' },
      ];
    }
    return [
      ...plugin.installedPlacements.flatMap((placement) => placement.state === 'notInstalled'
        ? []
        : [{ id: 'platform' as const, platform: placement.platform }]),
      ...(plugin.savedConfigScopes.length > 0 ? [{ id: 'settings' as const }] : []),
      { id: 'sourceProblem' },
      { id: 'about' },
    ];
  }
  return [
    ...(plugin.update?.targets ?? []).flatMap((target): PluginMenuAction[] =>
      target.availableVersion !== undefined && target.installedVersion !== undefined
        && plugin.update.sourceIdentity !== undefined && plugin.update.generationKey !== undefined
        && target.requiresCatalogActivation !== true
        && target.eligibility === 'allowed'
        ? [{
            id: 'refreshAndSync',
            platform: target.platform,
            scope: target.scope,
            availableVersion: target.availableVersion,
            installedVersion: target.installedVersion,
            sourceIdentity: plugin.update.sourceIdentity,
            generationKey: plugin.update.generationKey,
          }]
        : []),
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
    if (isCapabilityUnavailable(plugin)) return capabilityUnavailableActions();
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
  const lifecycleActions = buildAllowedLifecycleActions({
    pluginId: plugin.pluginId,
    platform,
    scope: placement.scope,
    state: placement.actualState ?? (placement.health === 'ready'
      ? 'ready' : placement.health === 'incomplete' ? 'needsSync' : 'blocked'),
    recoveryActions: placement.recovery ?? [],
    revision: placement.revision,
  }).flatMap((action): PluginMenuAction[] => {
    if (action.id === 'install') return [{ id: 'add' }];
    if (action.id === 'refreshAndSync') {
      const updateTarget = plugin.update?.targets.find((target) =>
        target.platform === action.platform && target.scope === action.scope
        && target.availableVersion === action.availableVersion);
      return updateTarget?.installedVersion && plugin.update.sourceIdentity && plugin.update.generationKey
        ? [{
            id: 'refreshAndSync',
            platform: action.platform,
            scope: action.scope,
            availableVersion: action.availableVersion!,
            installedVersion: updateTarget.installedVersion,
            sourceIdentity: plugin.update.sourceIdentity,
            generationKey: plugin.update.generationKey,
          }]
        : [];
    }
    if (action.id === 'sync') return [{ id: 'sync' }];
    if (action.id === 'reinstall') return [{ id: 'reinstall', platform: action.platform, scope: action.scope }];
    if (action.id === 'uninstall') return [{ id: 'remove', platform: action.platform, scope: action.scope }];
    return [{ id: 'cleanup', platform: action.platform, scope: action.scope }];
  });
  if (placement.health !== 'ready') {
    return [...lifecycleActions, { id: 'technical' }, ...(lifecycleActions.length === 0 ? [{ id: 'back' as const }] : [])];
  }
  return [
    ...missingPureNativeScopes(plugin, placement).map((scope): PluginMenuAction => ({
      id: 'addScope', platform, scope,
    })),
    ...lifecycleActions,
    { id: 'technical' },
  ];
}

export function hasInstalledPlacement(plugin: PluginListItemViewModel): boolean {
  return plugin.installedPlacements.some((placement) =>
    placement.state === 'installed' || placement.state === 'scopeConflict');
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

function lifecycleIssueActions(
  target: Pick<StatusV7Target,
    'pluginId' | 'platform' | 'scope' | 'state' | 'recoveryActions'>,
  options: { dependency?: boolean; project?: 'current' | 'other' | null } = {},
): UserIssueActionViewModel[] {
  return buildAllowedLifecycleActions(target).flatMap((action): UserIssueActionViewModel[] => {
    const view = projectLifecycleActionView(action);
    if (options.dependency) {
      if (action.id === 'install') return [{
        id: 'installDependency',
        label: '补齐依赖插件',
        pluginId: action.pluginId,
        platform: action.platform,
        scope: action.scope,
        project: options.project,
        writeAction: 'install',
      }];
      if (action.id === 'sync' || action.id === 'reinstall') return [{
        id: 'reinstallDependency',
        label: view.label,
        description: view.description,
        pluginId: action.pluginId,
        platform: action.platform,
        scope: action.scope,
        project: options.project,
        writeAction: action.id,
      }];
      return [];
    }
    const projection = {
      install: { id: 'install' as const, writeAction: 'install' as const },
      sync: { id: 'sync' as const, writeAction: 'sync' as const },
      refreshAndSync: { id: 'refreshAndSync' as const, writeAction: 'refreshAndSync' as const },
      reinstall: { id: 'reinstall' as const, writeAction: 'reinstall' as const },
      uninstall: { id: 'remove' as const, writeAction: 'uninstall' as const },
      cleanup: { id: 'cleanup' as const, writeAction: 'cleanup' as const },
    }[action.id];
    return [{
      ...projection,
      label: view.label,
      description: view.description,
      pluginId: action.pluginId,
      platform: action.platform,
      scope: action.scope,
    }];
  });
}

function targetIssues(payload: StatusV7Payload): UserIssueDraft[] {
  const issues: UserIssueDraft[] = [];
  const canonicalRootsByEntity = new Map<string, string>();
  for (const target of payload.targets) {
    for (const error of target.reasons) {
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
    const intent = statusTargetIntent(target);
    const scopedConflictRecovery = target.reasons.some((reason) =>
      reason.code === 'codexExtensionScopeConflict')
      ? target.recoveryActions.flatMap((recovery) => {
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
        explanation: 'AW 管理附加能力不能同时使用所有项目和当前项目位置。',
        impact: ['选择要保留的使用位置。系统将移除另一位置，再同步保留的位置。'],
        entity: { kind: 'plugin', id: target.pluginId },
        pluginId: target.pluginId,
        platform: target.platform,
        scope: target.scope,
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        placements: [...intent.scopes].sort(compareText),
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
          message: '扩展同时使用 user 和 project scope。',
        }],
      });
    }
    if (target.state !== 'needsSync' && target.state !== 'blocked'
      && !target.reasons.some((error) => error.code === 'artifactCollision'
        || error.dependencyPluginId !== undefined && error.rootIssueId !== undefined)) continue;
    const codes = new Set(target.reasons.map((error) => error.code));
    const sharedNativeRenderDrift = target.state === 'needsSync'
      && codes.has('codexSharedNativeRenderDrift');
    const sharedNativeDamaged = target.state === 'needsSync'
      && codes.has('codexSharedNativeCorrupt');
    const sharedNativeProjectionIssue = sharedNativeRenderDrift || sharedNativeDamaged;
    const sharedNative = statusTargetSharedNative(target);
    const systemConsumer = statusTargetActivation(target)?.systemConsumer;
    const statusUnconfirmed = systemConsumer?.state === 'unresolved'
      || codes.has('codexSharedNativeUnobserved')
      || codes.has('codexNativeObservationFailed')
      || (sharedNative?.state === 'blocked' && sharedNative.reason === 'unreadable');
    const contentMissing = codes.has('missingContent')
      || sharedNative?.state === 'missing'
      || statusTargetExtensions(target)?.state === 'missing'
      || target.components.some((component) => component.kind === 'ownership'
        && component.state === 'absent');
    const statusIssue = systemConsumer?.state === 'incompatible'
      ? { title: 'Codex 版本不兼容', explanation: '当前 Codex 版本低于要求，请升级后重试。' }
      : statusUnconfirmed
        ? { title: '状态未确认', explanation: '未取得有效的 Codex 状态证据，暂时无法确认插件是否可用。' }
        : codes.has('codexActivationDrift')
          ? { title: '激活范围不一致', explanation: 'Codex 激活配置与期望的使用范围不一致。' }
          : codes.has('codexSharedNativeUpdateRequired')
            ? { title: '版本待同步', explanation: '已安装的 Codex 平台共享内容版本与当前插件版本不一致。' }
            : sharedNativeDamaged || contentMissing
              ? { title: '安装不完整', explanation: '必要内容缺失或损坏，需要运行同步。' }
              : { title: '状态待同步', explanation: '现场状态与期望状态不一致，需要重新检查并同步。' };

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
      error?: StatusV7Target['reasons'][number];
      dependencyPluginId?: string;
    };
    const dependencyRootMap = new Map<string, TargetIssueRoot>();
    for (const error of target.reasons) {
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
    const directCollision = target.reasons.find((error) => error.code === 'artifactCollision');
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
            || codes.has('codexIntentSourceUnavailable')
            ? [
                ...(codes.has('catalogSourceUnavailable')
                  ? [{ code: 'catalogSourceUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: true }]
                  : []),
                ...(codes.has('bundleUnavailable')
                  ? [{ code: 'bundleUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: false }]
                  : []),
                ...(codes.has('codexIntentSourceUnavailable')
                  ? [{ code: 'codexIntentSourceUnavailable' as const, category: 'sourceUnavailable' as const, mergeEligible: false }]
                  : []),
              ]
          : ordinaryDependencyRoots.length > 0
            ? ordinaryDependencyRoots
            : target.state === 'needsSync'
              ? [{ code: 'partial', category: 'incompleteInstallation', mergeEligible: false }]
          : [
              { code: 'targetDiagnostic' as const, category: 'diagnostic' as const, mergeEligible: false },
            ];
    for (const root of roots) {
      const rootError = root.error ?? target.reasons.find((error) => error.code === root.code);
      const dependencyPluginId = root.dependencyPluginId
        ?? rootError?.dependencyPluginId
        ?? (rootError ? dependencyPluginIdFromMessage(rootError.message) : undefined);
      const dependencyPlatform = rootError?.dependencyPlatform;
      const dependencyScope = rootError?.dependencyScope;
      const dependencyProject = rootError?.dependencyProject;
      const dependencyCategory = root.category.startsWith('dependency');
      const dependencyTarget = dependencyPluginId && dependencyPlatform && dependencyScope
        ? payload.targets.find((candidate) => candidate.pluginId === dependencyPluginId
          && candidate.platform === dependencyPlatform && candidate.scope === dependencyScope)
        : undefined;
      const dependencyLifecycleActions = dependencyPluginId && dependencyPlatform && dependencyScope
        ? lifecycleIssueActions(dependencyTarget ?? {
            pluginId: dependencyPluginId,
            platform: dependencyPlatform,
            scope: dependencyScope,
            state: 'absent',
            recoveryActions: [],
          }, { dependency: true, project: dependencyProject })
        : [];
      const directLifecycleActions = dependencyCategory ? [] : lifecycleIssueActions(target);
      const actions: UserIssueActionViewModel[] = root.category === 'dependencyMissing'
        ? [
            ...dependencyLifecycleActions,
            { id: 'viewDependencies', label: '查看依赖关系' },
            { id: 'viewTechnical', label: '技术详情' },
          ]
        : root.category === 'dependencyNotReady'
          ? [
              ...(dependencyPluginId ? [
                { id: 'viewDependencyIssue' as const, label: '查看依赖插件问题', pluginId: dependencyPluginId },
              ] : []),
              ...dependencyLifecycleActions.filter((action) => action.id === 'reinstallDependency'),
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
            ...directLifecycleActions,
            { id: 'viewTechnical', label: '技术详情' },
          ]
        : root.category === 'sourceMissing'
          ? [
              ...directLifecycleActions,
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
                  ...directLifecycleActions.filter((action) => action.id === 'cleanup'),
                  { id: 'editSource', label: '查看来源', description: root.code === 'bundleUnavailable'
                    ? '检查当前插件目录或稍后重试'
                    : root.code === 'codexIntentSourceUnavailable'
                      ? '恢复来源后可重新同步已保存的使用设置'
                      : '修复来源配置或稍后重试' },
                  { id: 'viewTechnical', label: '技术详情' },
                ]
              : [...directLifecycleActions,
                  { id: 'viewTechnical', label: '技术详情' },
                  { id: 'retryLater', label: '稍后重试' }];
      const bundleUnavailable = root.code === 'bundleUnavailable';
      const codexIntentSourceUnavailable = root.code === 'codexIntentSourceUnavailable';
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
        title: `${target.pluginId} · ${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${sharedNativeProjectionIssue ? '平台共享内容待同步' : root.category === 'artifactCollision' ? '输出冲突' : dependencyCategory ? {
          dependencyMissing: '缺少依赖',
          dependencyNotReady: '依赖安装不完整',
          dependencyTargetUnsupported: '依赖目标不兼容',
          dependencyStillRequired: '依赖仍被使用',
          dependencyGraphInvalid: '依赖关系无效',
        }[root.category as Exclude<UserIssueCategory, 'artifactCollision' | 'incompleteInstallation' | 'sourceUnavailable' | 'sourceMissing' | 'sourceIdentityChanged' | 'requiredConfigMissing' | 'configLayerUnsupported' | 'scopeConflict' | 'legacyState' | 'diagnostic'>] : target.state === 'needsSync' || statusUnconfirmed || systemConsumer?.state === 'incompatible' ? statusIssue.title : bundleUnavailable ? '当前插件目录不再包含此插件' : codexIntentSourceUnavailable ? '已保存使用设置不能解析' : '检查失败'}`,
        explanation: root.category === 'artifactCollision'
          ? '目标位置已有不属于当前插件的内容。AW 不会覆盖或删除这些内容。'
          : dependencyCategory
          ? dependencyPluginId
            ? `${dependencyPluginId} 导致当前依赖检查不能通过。`
            : '当前依赖检查不能安全通过。'
          : sharedNativeDamaged
          ? 'Codex 平台共享生成内容缺失或损坏。'
          : sharedNativeRenderDrift
          ? 'Codex 平台共享生成内容与当前渲染输入不一致。'
          : target.state === 'needsSync' || statusUnconfirmed || systemConsumer?.state === 'incompatible'
          ? statusIssue.explanation
          : bundleUnavailable
            ? '当前插件目录不再包含此插件，但仍发现 AW 管理的已安装内容。'
            : codexIntentSourceUnavailable
              ? '当前插件目录不能解析这个已保存的使用设置。'
            : '当前目标不能安全分类为正常安装。',
        impact: [sharedNativeProjectionIssue
          ? '运行同步可重新生成平台共享 Skill。'
          : root.category === 'artifactCollision'
          ? '请先移除或迁移冲突内容，然后重试安装或重新安装。'
          : bundleUnavailable || codexIntentSourceUnavailable || root.code === 'catalogSourceUnavailable'
          ? '可以核验后取消这个位置的使用设置，并清理可信的 AW 现场。'
          : '写操作前需要重新检查这个目标。'],
        entity: { kind: 'plugin', id: target.pluginId },
        pluginId: target.pluginId,
        ...(dependencyPluginId ? { dependencyPluginId } : {}),
        ...(dependencyPlatform ? { dependencyPlatform } : {}),
        ...(dependencyScope ? { dependencyScope } : {}),
        ...(dependencyProject !== undefined ? { dependencyProject } : {}),
        platform: target.platform,
        scope: target.scope,
        sourceId: target.sourceId,
        sourceIdentity: target.sourceIdentity,
        actions,
        technicalDetails: target.reasons.length > 0
          ? target.reasons.filter((error) => root.code === 'targetDiagnostic'
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
  return issues;
}

function statusIssues(payload: StatusV7Payload): UserIssueDraft[] {
  const targetCodes = new Set(payload.targets.flatMap((target) =>
    target.reasons.map((error) => error.code)));
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

function configIssues(pluginSummaries: StatusV7PluginSummary[]): UserIssueDraft[] {
  return pluginSummaries.flatMap((summary): UserIssueDraft[] => {
    const sourceId = summary.pluginId.slice(0, summary.pluginId.indexOf('/'));
    const issues: UserIssueDraft[] = [];
    if (summary.configDiagnostic) {
      issues.push({
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
      });
    }
    if (!summary.configIssues?.length) return issues;
    const unsupported = summary.configIssues.filter((issue) => issue.type === 'configLayerUnsupported');
    if (unsupported.length > 0) {
      issues.push({
        issueId: `config:${summary.pluginId}:unsupported-project-layer`,
        category: 'configLayerUnsupported' as const,
        title: `${summary.displayName ?? summary.pluginName} · 项目设置包含旧值`,
        explanation: '这些 project override 已不再受支持，实际使用个人默认或 manifest 默认值。',
        impact: ['旧值不会参与生成。可以进入项目设置删除旧值。'],
        entity: { kind: 'plugin' as const, id: summary.pluginId },
        pluginId: summary.pluginId,
        sourceId,
        configLayer: { scope: 'project' as const },
        actions: [
          { id: 'openConfig' as const, label: '删除旧值', description: '进入项目设置并恢复继承' },
          { id: 'viewTechnical' as const, label: '查看字段详情' },
        ],
        technicalDetails: unsupported.map((entry) => ({
          code: entry.type,
          message: `${entry.title} · project · 实际使用 user/default`,
        })),
      });
    }
    const blockingIssues = summary.configIssues.filter((issue) => issue.type !== 'configLayerUnsupported');
    if (blockingIssues.length === 0) return issues;
    const types = new Set(blockingIssues.map((issue) => issue.type));
    const invalid = types.has('invalid-config') || types.has('sharedCompositeContainsLocalPath');
    const sources = new Set(blockingIssues.map((issue) => issue.source));
    const onlySource = sources.size === 1 ? [...sources][0] : undefined;
    const configLayer = onlySource === 'user'
      ? { scope: 'user' as const }
      : onlySource === 'project'
        ? { scope: 'project' as const }
        : undefined;
    issues.push({
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
      requiredFields: blockingIssues.map(({ key, title, type, source, scope }) => ({
        key, title, type, source, scope,
      })),
      ...(configLayer ? { configLayer } : {}),
      actions: [
        { id: 'openConfig' as const, label: invalid ? '修正设置' : '完成设置', description: configLayer ? '进入建议的设置层' : '选择个人或项目设置层' },
        { id: 'viewTechnical' as const, label: '查看字段详情' },
      ],
      technicalDetails: blockingIssues.map((entry) => ({
        code: entry.type,
        message: `${entry.title} · ${entry.scope} · ${entry.source}`,
      })),
    });
    return issues;
  });
}

function dependencyOverviewIssues(
  overviews: PluginDependencyOverviewViewModel[],
  pluginSummaries: StatusV7PluginSummary[],
  status: StatusV7Payload,
): UserIssueDraft[] {
  const summaryById = new Map(pluginSummaries.map((summary) => [summary.pluginId, summary]));
  return overviews.flatMap((overview) => overview.blockers.flatMap((blocker): UserIssueDraft[] => {
    if (blocker.code !== 'dependencyGraphInvalid'
      && blocker.code !== 'dependencyTargetUnsupported') return [];
    if (status.targets.some((target) => target.pluginId === overview.pluginId
      && target.reasons.some((error) => error.code === blocker.code))) return [];
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

function issueDiagnostic(
  issue: UserIssueDraft,
  sourceDetails: ReadonlyMap<string, SourceDetailViewModel>,
): DiagnosticSummaryViewModel {
  const source = issue.sourceId ? sourceDetails.get(issue.sourceId) : undefined;
  const sourceUnavailable = issue.category === 'sourceUnavailable' && issue.entity.kind === 'source';
  const configLayerUnsupported = issue.category === 'configLayerUnsupported';
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
    : configLayerUnsupported ? 'read-config'
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
    : configLayerUnsupported
      ? ['打开项目设置。', '删除不再支持的 project override。', '重新检查插件设置。']
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
    severity: configLayerUnsupported ? 'warning' : 'error',
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
  if (issue.category === 'requiredConfigMissing' || issue.category === 'configLayerUnsupported') return 'config';
  if (issue.category === 'incompleteInstallation') return 'installation';
  return 'diagnostic';
}

function primaryAttentionCode(issue: UserIssueDraft): string {
  if (issue.category === 'requiredConfigMissing') {
    return issue.requiredFields?.some((field) => field.type === 'invalid-config')
      ? 'invalidConfig'
      : 'requiredConfigMissing';
  }
  if (issue.category === 'configLayerUnsupported') return 'configLayerUnsupported';
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
    codexIntentSourceUnavailable: 2,
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
  status: StatusV7Payload;
  pluginSummaries: StatusV7PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceHealth?: ReadonlyMap<string, SourceHealthViewModel>;
  sourceDetails?: SourceDetailViewModel[];
  catalogFreshness?: ReadonlyMap<string, CatalogSourceFreshnessViewModel>;
  catalogGenerations?: ReadonlyMap<string, CatalogSourceGenerationViewModel>;
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
  configStoreInventory?: Array<{
    pluginId: string;
    sourceId: string;
    pluginName: string;
    scope: Scope;
  }>;
}): TuiViewModel {
  const dependencyById = new Map((options.dependencyOverviews ?? [])
    .map((overview) => [overview.pluginId, overview]));
  const summaryById = new Map(options.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  const sourceById = new Map(options.status.catalog.sources.map((source) => [source.id, source]));
  const targetsByPlugin = new Map<string, StatusV7Target[]>();
  for (const target of options.status.targets) {
    targetsByPlugin.set(target.pluginId, [...(targetsByPlugin.get(target.pluginId) ?? []), target]);
  }
  const configScopesByPlugin = new Map<string, Set<Scope>>();
  for (const store of options.configStoreInventory ?? []) {
    const scopes = configScopesByPlugin.get(store.pluginId) ?? new Set<Scope>();
    scopes.add(store.scope);
    configScopesByPlugin.set(store.pluginId, scopes);
  }
  const pluginIds = new Set([
    ...summaryById.keys(),
    ...targetsByPlugin.keys(),
    ...configScopesByPlugin.keys(),
  ]);
  const plugins = [...pluginIds].map((pluginId): PluginListItemViewModel => {
    const summary = summaryById.get(pluginId);
    const targets = targetsByPlugin.get(pluginId) ?? [];
    const sourceId = targets[0]?.sourceId ?? pluginId.slice(0, pluginId.indexOf('/'));
    const savedConfigScopes = [...(configScopesByPlugin.get(pluginId) ?? [])]
      .sort((left, right) => (left === 'user' ? 0 : 1) - (right === 'user' ? 0 : 1));
    const configOnly = summary === undefined && targets.length === 0 && savedConfigScopes.length > 0;
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
    const sourceUnavailable = options.sourceHealth?.get(sourceId)?.state === 'unavailable'
      || sourceById.get(sourceId)?.error !== undefined;
    const capabilityTargets = targets.filter((target) => target.reasons.some((reason) =>
      reason.code === 'awCapabilityUnsupported'));
    const capabilityUnsupported = (summary?.missingCapabilities?.length ?? 0) > 0
      || capabilityTargets.length > 0;
    const capabilityRecovery = capabilityTargets.flatMap((target) => target.recoveryActions)
      .find((action) => action.command === 'manual')?.description;
    const unavailable = sourceUnavailable || capabilityUnsupported || configOnly;
    const update = buildPluginUpdateSummary({
      pluginId,
      sourceId,
      targetRevisions: options.targetRevisions ?? [],
      targets,
      freshness: options.catalogFreshness?.get(sourceId),
      sourceIdentity: sourceById.get(sourceId)?.identity,
      generationKey: options.catalogGenerations?.get(sourceId)?.active?.storeKey,
    });
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
      ...(capabilityUnsupported ? { capabilityUnsupported: true } : {}),
      ...(capabilityRecovery ? { capabilityRecovery } : {}),
      ...(sourceUnavailable ? { sourceUnavailable: true } : {}),
      savedConfigScopes,
      ...(configOnly ? { configOnly: true } : {}),
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
        ...(typeof component.metadata?.errorCode === 'string'
          ? { errorCode: component.metadata.errorCode }
          : {}),
      }))),
      update,
    };
  }).sort((left, right) => compareText(left.displayName, right.displayName)
    || compareText(left.sourceId, right.sourceId));
  const sourceTabs = options.status.catalog.sources.map((source) => ({
    id: source.id,
    label: source.id,
    count: plugins.filter((plugin) => plugin.sourceId === source.id).length,
    primary: source.primary,
    state: projectCatalogSourceState(
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
  const issueDrafts = [
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
  ];
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
        severity: primary.category === 'configLayerUnsupported' ? 'warning' : 'error',
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
      pluginUpdateCount: pluginsWithAttention.filter((plugin) => plugin.update.state === 'available').length,
      directPluginUpdateCount: pluginsWithAttention.filter((plugin) => plugin.update.targets.some((target) =>
        target.availableVersion !== undefined && target.requiresCatalogActivation !== true
        && target.eligibility === 'allowed')).length,
    },
  };
}

function displayConfigValue(options: {
  field: PluginConfigSchemaField;
  privateValue: boolean;
  inherited: boolean;
  configured: boolean;
  value: unknown;
}): string {
  if (!options.configured) return options.inherited ? '继承' : '未设置';
  if (options.privateValue) return '已设置';
  if (options.field.type === 'object'
    && typeof options.value === 'object'
    && options.value !== null
    && !Array.isArray(options.value)) {
    const object = options.value as PluginConfigObject;
    if (configObjectHasSensitiveChild(options.field)) {
      const count = Object.keys(object).length;
      return `已设置 · ${count === 0 ? '空对象' : `${count} 项`}`;
    }
    const preset = matchPluginConfigPreset(options.field, object);
    const keys = Object.keys(object).sort((left, right) => left.localeCompare(right, 'en'));
    const keySummary = keys.length === 0
      ? '空对象'
      : `${keys.length} 项${keys.length > 0 ? `（${keys.slice(0, 2).join('、')}${keys.length > 2 ? '…' : ''}）` : ''}`;
    return preset ? `方案“${preset.title}” · ${keySummary}` : `自定义 · ${keySummary}`;
  }
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
  }[source];
}

function configEditorDefinition(field: PluginConfigSchemaField): PluginConfigSchemaField {
  const definition = structuredClone(field);
  delete definition.default;
  if (definition.sensitive === true) delete definition.choices;
  return definition;
}

function configObjectChildChanges(
  field: Extract<PluginConfigSchemaField, { type: 'object' }>,
  before: PluginConfigObject,
  after: PluginConfigObject | undefined,
): NonNullable<ConfigFieldViewModel['fallbackObjectChanges']> {
  const fixed = Object.keys(field.properties ?? {});
  const summary = (property: string, value: PluginConfigScalar | undefined): string => {
    if (value === undefined) return '未设置';
    const definition = field.properties?.[property]
      ?? (field.additionalProperties === false ? undefined : field.additionalProperties);
    if (field.sensitive || definition?.sensitive) return '已设置';
    if (typeof value === 'boolean') return value ? '开启' : '关闭';
    return String(value);
  };
  return [...new Set([...Object.keys(before), ...Object.keys(after ?? {})])]
    .sort((left, right) => {
      const leftIndex = fixed.indexOf(left);
      const rightIndex = fixed.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      }
      return left.localeCompare(right, 'en');
    })
    .filter((property) => before[property] !== after?.[property])
    .map((property) => {
      const definition = field.properties?.[property]
        ?? (field.additionalProperties === false ? undefined : field.additionalProperties);
      return {
        property,
        before: summary(property, before[property]),
        after: summary(property, after?.[property]),
        ...(field.sensitive || definition?.sensitive ? { private: true } : {}),
      };
    });
}

export function buildConfigGroups(options: {
  schema: PluginConfigSchema;
  read: ResolvedConfigRead;
  effectiveRead?: ResolvedConfigRead;
  layerReads?: Partial<Record<Scope, ResolvedConfigRead>>;
  dirtyKeys?: ReadonlySet<string>;
  rawValues?: Record<string, PluginConfigValue>;
  rawLayerValues?: Partial<Record<Scope, Record<string, PluginConfigValue>>>;
  effectiveRawValues?: Record<string, PluginConfigValue>;
  sharedNativeRefreshKeys?: ReadonlySet<string>;
}): ConfigGroupViewModel[] {
  const entryByKey = new Map(options.read.fields.map((field) => [field.key, field]));
  const effectiveEntryByKey = new Map(
    (options.effectiveRead ?? options.read).fields.map((field) => [field.key, field]),
  );
  const effectivePage = options.read.scope === 'effective';
  const layerEntry = (layer: Scope, key: string) =>
    options.layerReads?.[layer]?.fields.find((field) => field.key === key);
  const fieldModel = (key: string): ConfigFieldViewModel => {
    const schema = options.schema.fields[key]!;
    const entry = entryByKey.get(key);
    const effectiveEntry = effectiveEntryByKey.get(key);
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
    const privateValue = schema.sensitive === true;
    const choices = schema.choices;
    const selectedValue = effectivePage ? entry?.effectiveValue : entry?.storedValue;
    const selectedRawValue = effectivePage
      ? options.effectiveRawValues?.[key]
      : options.rawValues?.[key];
    const selectedStoredInvalid = !effectivePage
      && entry?.storedSourceLayer !== undefined
      && entry.storedValue === undefined;
    const invalidOverrideSourceCandidate = selectedStoredInvalid
      ? (effectivePage ? entry?.invalidOverride?.sourceLayer : options.read.scope)
      : entry?.invalidOverride?.sourceLayer;
    const invalidOverrideSource = invalidOverrideSourceCandidate === 'user'
      || invalidOverrideSourceCandidate === 'project'
      ? invalidOverrideSourceCandidate
      : undefined;
    const invalidOverride = invalidOverrideSource !== undefined;
    const invalidOverrideOwnedByLayer = !effectivePage
      && invalidOverrideSource === options.read.scope;
    const effectiveConfigured = effectiveEntry?.sourceLayer !== undefined
      && effectiveEntry.sourceLayer !== null
      && effectiveEntry.effectiveValue !== undefined
      && effectiveEntry.effectiveValue !== null
      && (effectiveEntry.valueState === 'configured' || effectiveEntry.valueState === 'default');
    const omittedLayer = options.read.scope === 'user'
      ? 'user'
      : 'project';
    const fallback = options.read.scope === 'user'
      ? undefined
      : (['project', 'user'] as const)
        .filter((layer) => layer !== omittedLayer)
        .map((layer) => ({ layer, entry: layerEntry(layer, key) }))
        .find((candidate) => candidate.entry?.storedSourceLayer !== undefined);
    const projectedFallback = entry?.fallback;
    const fallbackInvalid = projectedFallback?.state === 'invalid';
    const fallbackValue = projectedFallback?.state === 'valid'
      ? projectedFallback.effectiveValue
      : projectedFallback
        ? undefined
        : fallback?.entry?.storedValue ?? schema.default;
    const fallbackRawValue = projectedFallback?.state === 'valid'
      ? projectedFallback.sourceLayer === 'user'
        ? options.rawLayerValues?.user?.[key] ?? fallbackValue
        : fallbackValue
      : projectedFallback
        ? undefined
        : fallback
          ? options.rawLayerValues?.[fallback.layer]?.[key] ?? fallbackValue
          : schema.default;
    const fallbackConfigured = projectedFallback
      ? projectedFallback.state !== 'missing'
      : fallback !== undefined || schema.default !== undefined;
    const fallbackSource = projectedFallback?.state === 'valid'
      || projectedFallback?.state === 'invalid'
      ? projectedFallback.sourceLayer
      : projectedFallback
        ? undefined
        : fallback?.layer ?? (schema.default !== undefined ? 'default' : undefined);
    return {
      key,
      title: schema.title ?? key,
      ...(schema.description ? { description: schema.description } : {}),
      type: schema.type,
      definition: configEditorDefinition(schema),
      displayValue: selectedStoredInvalid ? '值无效' : displayConfigValue({
        field: schema,
        privateValue,
        inherited,
        configured,
        value: schema.type === 'object' ? selectedRawValue ?? selectedValue : selectedValue,
      }),
      required: schema.required === true,
      sensitive: schema.sensitive === true,
      writable: (entry?.writable ?? effectivePage)
        && !(options.read.scope === 'project' && privateValue),
      canSet: (entry?.canSet ?? effectivePage)
        && !(options.read.scope === 'project' && privateValue),
      canUnset: entry?.canUnset ?? false,
      dirty: options.dirtyKeys?.has(key) === true,
      inherited,
      configured,
      sourceLabel: effectivePage
        ? configSourceLabel(entry?.sourceLayer ?? null)
        : configured ? '本层已设置' : '继承',
      effectiveDisplayValue: displayConfigValue({
        field: schema,
        privateValue,
        inherited: false,
        configured: effectiveConfigured,
        value: schema.type === 'object'
          ? options.effectiveRawValues?.[key] ?? effectiveEntry?.effectiveValue
          : effectiveEntry?.effectiveValue,
      }),
      effectiveSourceLabel: configSourceLabel(effectiveEntry?.sourceLayer ?? null),
      ...(invalidOverride ? {
        invalidOverrideOwnedByLayer,
        invalidOverrideIssue: invalidOverrideOwnedByLayer
          ? schema.type === 'object'
            ? `字段“${schema.title ?? key}”在本层的对象值无效。请修改或删除此字段。`
            : `字段“${schema.title ?? key}”在本层的值无效。请修改或删除此字段。`
          : `字段“${schema.title ?? key}”在${configSourceLabel(invalidOverrideSource ?? null)}中的值无效。请切换到该设置层修改或删除此字段。`,
      } : {}),
      ...(!effectivePage && configured ? {
        fallbackDisplayValue: fallbackInvalid
          ? '值无效；保存可成功，但应用会被阻止'
          : displayConfigValue({
              field: schema,
              privateValue,
              inherited: false,
              configured: fallbackConfigured,
              value: schema.type === 'object' ? fallbackRawValue : fallbackValue,
            }),
        fallbackSourceLabel: fallbackSource ? configSourceLabel(fallbackSource) : '未设置',
        ...(!fallbackInvalid && schema.type === 'object'
          && typeof (selectedRawValue ?? selectedValue) === 'object'
          && (selectedRawValue ?? selectedValue) !== null
          ? { fallbackObjectChanges: configObjectChildChanges(
              schema,
              (selectedRawValue ?? selectedValue) as PluginConfigObject,
              typeof fallbackRawValue === 'object' && fallbackRawValue !== null
                ? fallbackRawValue as PluginConfigObject
                : undefined,
            ) }
          : {}),
      } : {}),
      ...(!privateValue && selectedValue !== undefined
        ? { value: selectedValue as PluginConfigValue }
        : {}),
      ...(!privateValue && effectiveEntry?.effectiveValue !== undefined && effectiveEntry.effectiveValue !== null
        ? { effectiveValue: effectiveEntry.effectiveValue as PluginConfigValue }
        : {}),
      ...(!privateValue && (effectivePage
        ? options.effectiveRawValues?.[key]
        : selectedRawValue ?? (schema.type === 'object' && !configured
          ? options.effectiveRawValues?.[key]
          : undefined)) !== undefined
        ? { draftValue: (effectivePage
            ? options.effectiveRawValues?.[key]
            : selectedRawValue ?? options.effectiveRawValues?.[key])! }
        : {}),
      ...(!privateValue && schema.default !== undefined ? { defaultValue: schema.default } : {}),
      ...(!privateValue && choices ? { choices: choices.presets } : {}),
      allowCustom: choices?.allowCustom ?? true,
      ...(!privateValue && !configObjectHasSensitiveChild(schema)
        && (selectedRawValue ?? selectedValue) !== undefined && (selectedRawValue ?? selectedValue) !== null
        && matchPluginConfigPreset(schema, (selectedRawValue ?? selectedValue) as PluginConfigValue)
        ? { matchedPresetId: matchPluginConfigPreset(
            schema,
            (selectedRawValue ?? selectedValue) as PluginConfigValue,
          )!.id }
        : {}),
      ...(schema.type === 'number' && schema.validation?.minimum !== undefined ? { min: schema.validation.minimum } : {}),
      ...(schema.type === 'number' && schema.validation?.maximum !== undefined ? { max: schema.validation.maximum } : {}),
      advanced: false,
      sharedNativeRender: options.sharedNativeRefreshKeys?.has(key) === true,
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
  const remaining = Object.keys(options.schema.fields)
    .filter((key) => !assigned.has(key));
  if (!options.schema.presentation) {
    groups.push({
      id: 'general',
      title: '插件设置',
      advanced: false,
      fields: Object.keys(options.schema.fields)
        .map(fieldModel),
    });
  } else {
    const ordinary = remaining;
    const advanced: string[] = [];
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
  layerReads?: Partial<Record<Scope, ResolvedConfigRead>>;
  rawValues?: Record<string, PluginConfigValue>;
  rawLayerValues?: Partial<Record<Scope, Record<string, PluginConfigValue>>>;
  effectiveRawValues?: Record<string, PluginConfigValue>;
  sharedNativeRefreshKeys?: ReadonlySet<string>;
}): ConfigPageViewModel {
  return {
    pluginId: options.pluginId,
    layer: { scope: options.read.scope },
    groups: buildConfigGroups(options),
    presets: [],
    storedCount: options.read.fields.filter((field) => field.storedSourceLayer !== undefined).length,
  };
}

export function configValuesEqual(
  left: PluginConfigValue | undefined,
  right: PluginConfigValue | undefined,
): boolean {
  return left !== undefined && right !== undefined
    && stablePluginConfigStringify(left) === stablePluginConfigStringify(right);
}
