import crypto from 'node:crypto';

import {
  CatalogManagementError,
  type CatalogDevManagementViewModel,
  type CatalogManagementIntent,
  type CatalogManagementReviewEvidence,
  type CatalogManagementService,
  type CatalogPublicationManagementViewModel,
  type CatalogStoreManagementViewModel,
  type CatalogValidationViewModel,
  type CatalogWorkspaceManagementViewModel,
} from './catalog-management.js';
import type {
  CatalogActivationMode,
  CatalogSource,
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateEvidence,
  CatalogGenerationSyncResult,
  CatalogSourceImpact,
  DependencyScopeOverride,
  PlatformName,
  Scope,
} from '../types.js';
import type { PortableReview, PortableInstallReceipt } from '../portable/commands.js';
import type { CatalogSourceUpdate } from '../utils/catalog-sources.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { readSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import type {
  CatalogGenerationFreshnessState,
  CatalogGenerationFreshnessResult,
} from '../utils/catalog-generation-service.js';
import type {
  StatusV8Payload,
  StatusV8PluginSummary,
  StatusScopedTarget,
  StatusTargetRevision,
} from '../commands/status-v6.js';
import {
  flattenStatusTargets,
  statusTargetActivation,
  statusTargetIntent,
  statusTargetOwnershipState,
  statusTargetSharedNative,
} from '../commands/status-v6.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
import type { RebuildCommandResult } from '../commands/rebuild-command.js';
import type { OfflineCleanupTargetEvidence } from '../commands/offline-cleanup-evidence.js';
import type { CodexReconcilePlan } from '../utils/codex-reconciler.js';
import type { OperationPlan } from '../commands/operation-plan.js';
import type {
  RebuildProgressFeed,
  RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import { buildRebuildReceiptJson, requestedIntentAction } from '../output/command-receipt.js';
import { buildOperationResultModel } from '../commands/operation-planner.js';
import { buildOperationReviewProjection } from './operation-review-planner.js';
import {
  type ConfigPageViewModel,
  type ConfigGroupViewModel,
  buildTuiViewModel,
  dependencyPlacementTargets,
  hasInstalledPlacement,
  type InstallPlacementDraftViewModel,
  type PluginListItemViewModel,
  type PluginDependencyOverviewViewModel,
  type PortableSkillCandidateViewModel,
  type PortableSkillSelectionViewModel,
  type SourceHealthViewModel,
  type SourceDetailViewModel,
  type TuiViewModel,
  type UserIssueCategory,
  type UserIssueViewModel,
} from './model.js';
import { safeDiagnosticCode, sanitizeDiagnosticText } from './diagnostics.js';
import { projectExecutionDiagnostics, projectThrownOperationDiagnostic } from './diagnostic-projection.js';
import {
  OperationHistoryStore,
  type OperationDiagnosticDetail,
  type OperationEffectFacts,
  type OperationHistorySummary,
  type OperationHistoryTarget,
  type OperationReportPreview,
  type SafeOperationDiagnostic,
  type SaveOperationReportResult,
} from './operation-history.js';
import { targetHasArtifactCollision } from '../utils/target-eligibility.js';
import {
  TuiRouter,
  type ConfigInvalidStoreEvidence,
  type ConfigResumeRoute,
  type PluginInstallFilter,
  type PortableBlockerCode,
  type TuiPageContext,
  type TuiRoute,
  type TuiRouterSnapshot,
} from './router.js';
import { normalizeTuiRoute, type RouteEntityState } from './screen-registry.js';
import {
  type CatalogSourceGenerationViewModel,
} from './catalog-generation.js';
import type { CatalogSourceFreshnessViewModel } from './catalog-freshness.js';
import type { CatalogSessionReusableCandidate } from './catalog-sources/types.js';
import { CatalogSourcesSession } from './catalog-sources/session.js';
import {
  catalogSourceAutoCheckOnlyValue,
  projectCatalogSourceMutationWarnings,
} from './catalog-sources/review.js';
import {
  buildPluginWriteTaskCandidates,
  pluginWriteTaskTargetKey,
  type PluginWriteTaskBlockedTarget,
  type PluginWriteTaskCandidate,
  type PluginWriteTaskCause,
  type PluginWriteTaskGoal,
  type PluginWriteTaskIntent,
  type PluginWriteTaskTarget,
} from './plugin-write-task.js';

export type {
  PluginWriteTaskBlockReason,
  PluginWriteTaskCandidate,
  PluginWriteTaskExpectedUpdate,
  PluginWriteTaskGoal,
  PluginWriteTaskIntent,
  PluginWriteTaskMethod,
  PluginWriteTaskTarget,
} from './plugin-write-task.js';

type CatalogActivationBlockReason =
  | 'configDraft' | 'sourceDraft' | 'batchDraft' | 'catalogDraft' | 'portableDraft'
  | 'activeReview' | 'reviewPreparation' | 'writeProgress';

export interface ExternalDraftState {
  kind: 'configDraft' | 'sourceDraft' | 'batchDraft' | 'catalogDraft';
  owner: string;
  flowId?: string;
  revision: number;
}

export type PluginWriteOperation = 'install' | 'refreshAndSync' | 'reinstall' | 'uninstall' | 'cleanup' | 'sync';
export const PLUGIN_WRITE_BATCH_ACTIONS = [
  'install',
  'sync',
  'reinstall',
  'uninstall',
  'cleanup',
] as const;
export type BatchPluginWriteAction = typeof PLUGIN_WRITE_BATCH_ACTIONS[number];
export type PluginWriteBatchSelection =
  | { kind: 'selected'; pluginIds: string[] }
  | { kind: 'targets'; targets: PluginWriteBatchTarget[] }
  | { kind: 'currentProjectIntentRoots' };

export interface PluginWriteBatchTarget {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
}

export interface PluginInstallBatchTarget extends PluginWriteBatchTarget {
  state: 'add' | 'existing' | 'blocked';
  reason?: string;
}

export function pluginWriteBatchTargets(
  action: Exclude<BatchPluginWriteAction, 'install'>,
  pluginIds: readonly string[],
  statusTargets: readonly StatusScopedTarget[],
): PluginWriteBatchTarget[] {
  const selected = new Set(pluginIds);
  const targets: PluginWriteBatchTarget[] = [];
  const add = (target: StatusScopedTarget, scope: Scope): void => {
    targets.push({ pluginId: target.pluginId, platform: target.platform, scope });
  };
  for (const target of statusTargets) {
    if (!selected.has(target.pluginId)) continue;
    const intent = statusTargetIntent(target);
    const ownership = statusTargetOwnershipState(target);
    const activation = statusTargetActivation(target);
    const hasManagedOutput = ownership !== 'absent';
    const hasCleanupEvidence = ownership === 'present' || ownership === 'partial'
      || intent.relation === 'managed';
    if (action === 'sync' || action === 'reinstall') {
      intent.scopes.forEach((scope) => add(target, scope));
      if (hasManagedOutput) add(target, target.scope);
      if (target.platform === 'codex') {
        if (activation?.user === true) add(target, 'user');
        if (activation?.project === true) add(target, 'project');
      }
    } else if (action === 'uninstall') {
      if (hasManagedOutput) add(target, target.scope);
      if (target.platform === 'codex') {
        if (activation?.user === true) add(target, 'user');
        if (activation?.project === true) add(target, 'project');
      }
    } else if (hasCleanupEvidence) {
      add(target, target.scope);
      if (target.platform === 'codex') {
        if (activation?.user === true) add(target, 'user');
        if (activation?.project === true) add(target, 'project');
      }
    }
  }
  return [...new Map(targets.map((target) => [
    [target.pluginId, target.platform, target.scope].join('\0'), target,
  ])).values()].sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
    .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'));
}

export interface PluginWriteBatchIntent {
  kind: 'pluginWriteBatch';
  action: BatchPluginWriteAction;
  selection: PluginWriteBatchSelection;
  platform: PlatformName | 'both';
  scope: Scope;
  scriptTimeoutMs?: number;
}

export interface PluginWriteBatchGroupEvidence {
  groupId: string;
  sourceId: string;
  platform: PlatformName | 'both';
  scope: Scope;
  requestedPluginIds: string[];
  preview: RebuildCommandResult;
  executable: boolean;
}

export interface PluginWriteBatchEvidence extends OperationEvidence {
  requestedPluginIds: string[];
  groups: PluginWriteBatchGroupEvidence[];
  targetVersions?: Array<PluginWriteBatchTarget & {
    presence: 'new' | 'installed' | 'unknown';
    installedVersion?: string;
    availableVersion?: string;
  }>;
}

export interface PluginWriteBatchGroupResult {
  groupId: string;
  sourceId: string;
  platform: PlatformName | 'both';
  scope: Scope;
  requestedPluginIds: string[];
  result: RebuildCommandResult;
}

export interface PluginWriteBatchExecutionResult extends RebuildCommandResult {
  requestedPluginIds: string[];
  groupResults: PluginWriteBatchGroupResult[];
}

export interface PluginWriteTaskSourceEvidence {
  sourceId: string;
  sourceIdentity: string;
  requestedTargets: PluginWriteTaskTarget[];
  causes: PluginWriteTaskCause[];
  preview: RebuildCommandResult;
  executable: boolean;
}

export interface PluginWriteTaskEvidence extends OperationEvidence {
  taskPlan: {
    goal: PluginWriteTaskGoal;
    requestedTargets: PluginWriteTaskTarget[];
    executableTargets: PluginWriteTaskTarget[];
    causes: PluginWriteTaskCause[];
    blockedTargets: PluginWriteTaskBlockedTarget[];
    sources: PluginWriteTaskSourceEvidence[];
    targetFingerprint: string;
    planFingerprint: string;
  };
}

export interface PluginWriteTaskSourceResult {
  sourceId: string;
  sourceIdentity: string;
  requestedTargets: PluginWriteTaskTarget[];
  result: RebuildCommandResult;
}

export interface PluginWriteTaskExecutionResult extends RebuildCommandResult {
  taskPlan: PluginWriteTaskEvidence['taskPlan'];
  sourceResults: PluginWriteTaskSourceResult[];
}

export type OperationKind = OperationIntent['kind'];

export interface IssueOrigin {
  issueId: string;
  issueKey: string;
  category: UserIssueCategory;
  actionId: string;
  consumerPluginId?: string;
  consumerSourceIdentity?: string;
  consumerPlatform?: PlatformName;
  consumerScope?: Scope;
  dependencyPluginId?: string;
  dependencyPlatform?: PlatformName;
  dependencyScope?: Scope;
  dependencyProject?: 'current' | 'other' | null;
}

export type OperationIntent =
  | {
      kind: 'pluginWrite';
      action: PluginWriteOperation;
      pluginId: string;
      platform: PlatformName | 'both';
      scope: Scope;
      dependencyScopeOverrides?: DependencyScopeOverride[];
      expectedUpdate?: {
        installedVersion: string;
        activeVersion: string;
        sourceIdentity: string;
        generationKey: string;
      };
      recoveryDescription?: string;
      force?: boolean;
      scriptTimeoutMs?: number;
      originIssue?: IssueOrigin;
    }
  | PluginWriteBatchIntent
  | PluginWriteTaskIntent
  | {
      kind: 'portableInstall';
      pluginId: string;
      scope: Scope;
      selectedSkills: string[];
      requestedAgents?: string[];
    }
  | {
      kind: 'configSave';
      pluginId: string;
      scope: Scope;
      apply: boolean;
      scriptTimeoutMs?: number;
      retryApply?: true;
      updates?: Record<string, unknown>;
      removeKeys?: string[];
      sensitiveKeys?: string[];
      privateKeys?: string[];
      changes?: Array<{
        key: string;
        title: string;
        before: string;
        after: string;
        children?: Array<{ property: string; before: string; after: string; private?: boolean }>;
      }>;
    }
  | {
      kind: 'configReset';
      pluginId: string;
      scope: Scope;
      expectedStoreState?: 'invalid';
      changes?: Array<{
        key: string;
        title: string;
        before: string;
        after: string;
        children?: Array<{ property: string; before: string; after: string; private?: boolean }>;
      }>;
    }
  | {
      kind: 'sourceMutation';
      action: 'add' | 'update' | 'setPrimary' | 'remove';
      sourceId: string;
      source?: CatalogSource;
      update?: CatalogSourceUpdate;
      changes?: Array<{ title: string; before?: string; after?: string; private?: boolean }>;
    }
  | {
      kind: 'catalogGeneration';
      action: 'activate' | 'update' | 'repair' | 'replaceDamaged' | 'recoverState';
      sourceId: string;
      sourceMutation?:
        | { action: 'add'; source: CatalogSource }
        | { action: 'update'; update: CatalogSourceUpdate };
      setPrimaryAfterActivation?: boolean;
    }
  | {
      kind: 'catalogSourcesRecovery';
    }
  | CatalogManagementIntent
  ;

export interface OperationEvidence {
  catalog: {
    configDigest: string;
    compositeDigest: string;
    generationSetDigest?: string;
  };
  source?: {
    sourceId: string;
    sourceIdentity: string;
    logicalIdentity?: string;
    requestedRef?: string;
    resolvedCommit?: string;
    manifestDigest?: string;
    snapshotDigest?: string;
    contentDigest?: string;
    pluginVersion?: string;
    catalogVersion?: string;
    channel?: 'latest' | 'beta';
  };
  targetFingerprint?: string;
  offlineCleanup?: OfflineCleanupTargetEvidence;
  offlineCleanupPlans?: OfflineCleanupTargetEvidence[];
  dependencyPlan?: ReconcileOperationPlan;
  codexReconcilePlans?: CodexReconcilePlan[];
  operationPlan?: OperationPlan;
  preparationWarnings?: string[];
  codexManager?: {
    state: 'system' | 'cached' | 'requires-install';
    packageName: '@openai/codex';
    version: string;
  };
  config?: {
    scope: Scope;
    schemaIdentity?: string;
    storeDigest: string;
    impactState?: 'known' | 'unknown';
    noEffectiveChange?: true;
    affectedTargets: Array<{ platform: PlatformName; scope: Scope }>;
    shareability?: 'verified' | 'unverified';
    sharedNativeRenderTargets?: Array<{ id: string; skillKey: string; refreshKeys: string[] }>;
    preApplyAuthorization?: import('../commands/rebuild-command.js').PreApplyAuthorizationTarget[];
  };
  resetTarget?: {
    sourceId: string;
    pluginName: string;
    scope: Scope;
    kind: 'absent' | 'regularFile' | 'symbolicLink' | 'directory';
    fingerprint: string;
  };
  sourceWrite?: {
    configDigest: string;
    proposedConfigDigest: string;
    sourceIdentity?: string;
    inventoryDigest: string;
    impactDigest?: string;
    referenceCount: number;
    inventoryComplete: boolean;
    impact?: CatalogSourceImpact;
  };
  catalogGeneration?: {
    action: Extract<OperationIntent, { kind: 'catalogGeneration' }>['action'];
    previousActive?: CatalogGenerationActiveV1;
    previousActiveVersion?: string;
    candidate: CatalogGenerationCandidateEvidence;
    candidateRelation?: CatalogGenerationFreshnessState;
    explicitSourceChange?: boolean;
    exactRepair?: boolean;
    activationMode?: CatalogActivationMode;
    impact?: CatalogSourceImpact;
    impactDigest?: string;
    impactMode?: 'generation' | 'identityChange';
    primaryImpact?: CatalogSourceImpact;
    primaryImpactDigest?: string;
    primaryConfigDigest?: string;
    configDigest: string;
    proposedConfigDigest?: string;
    proposedSource?: CatalogSource;
    sourceMutation?: Extract<OperationIntent, { kind: 'catalogGeneration' }>['sourceMutation'];
    setPrimaryAfterActivation?: boolean;
  };
  catalogManagement?: CatalogManagementReviewEvidence;
  portable?: PortableReview;
}

export interface OperationReviewChange {
  kind: 'add' | 'change' | 'remove' | 'keep' | 'warning';
  group?: 'requested' | 'dependencies' | 'projectIntent' | 'userIntent'
    | 'sharedCodexNative' | 'userActivation' | 'projectActivation' | 'awExtensions'
    | 'runtime' | 'portableTarget' | 'portableInputs' | 'portableWarnings'
    | 'configChanges' | 'configImpact' | 'preserved';
  pluginId?: string;
  batchGroupId?: string;
  sourceId?: string;
  relation?: 'requested' | 'direct' | 'transitive';
  title: string;
  description?: string;
}

export interface OperationReviewModel {
  operationId: string;
  reviewToken: string;
  expiresAt: number;
  operationKind: OperationKind;
  sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
  pluginAction?: PluginWriteOperation;
  taskGoal?: PluginWriteTaskGoal;
  originIssue?: IssueOrigin;
  title: string;
  description: string;
  subject: {
    name: string;
    subtitle?: string;
    sourceLabel?: string;
    version?: string;
  };
  changes: OperationReviewChange[];
  confirmationDetails?: string[];
  technicalDetails?: string[];
  equivalentCommand?: string;
  primaryLabel: string;
  destructive?: boolean;
  requiresConfirmation: boolean;
  sharedImpact: {
    pluginIds: string[];
    warning?: string;
  };
  catalogBinding?: {
    sourceId: string;
    catalogVersion: string;
    generationDigestShort: string;
  };
  batch?: {
    requestedPluginIds: string[];
    groupCount: number;
    executableGroupCount: number;
  };
  task?: {
    goal: PluginWriteTaskGoal;
    requestedTargetCount: number;
    executableTargetCount: number;
    blockedTargetCount: number;
    causeCount: number;
  };
}

export type ReviewPreparationStageId = 'refresh' | 'validate' | 'status' | 'catalog' | 'inventory'
  | 'dependencyPlan' | 'config' | 'portable' | 'evidence';

export interface ReviewPreparationStage {
  id: ReviewPreparationStageId;
  label: string;
  state: 'pending' | 'running' | 'completed' | 'failed';
}

export interface ReviewPreparationSnapshot {
  id: string;
  operationKind: OperationIntent['kind'];
  subject: string;
  state: 'running' | 'failed';
  stages: ReviewPreparationStage[];
  currentStage?: ReviewPreparationStageId;
  code?: 'reviewPreparationFailed';
  message?: string;
}

function reviewPreparationStageLabel(stage: ReviewPreparationStageId): string {
  return {
    refresh: '刷新相关来源',
    validate: '验证当前状态',
    status: '读取安装状态',
    catalog: '解析 Catalog',
    inventory: '检查本地现场',
    dependencyPlan: '准备依赖计划',
    config: '验证设置',
    portable: '准备 Portable Skills',
    evidence: '准备确认信息',
  }[stage];
}

export type OperationExecuteResult =
  | {
      state: 'succeeded';
      operationId: string;
      summary: OperationResultSummary;
      operationKind: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      pluginId?: string;
      originIssue?: IssueOrigin;
      returnRoute?: TuiRoute;
      operationRecordId?: string;
      diagnosticIds?: string[];
      effects?: OperationEffectFacts;
    }
  | {
      state: 'partial';
      operationId: string;
      summary: OperationResultSummary;
      operationKind: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      pluginId?: string;
      originIssue?: IssueOrigin;
      returnRoute?: TuiRoute;
      operationRecordId?: string;
      diagnosticIds?: string[];
      effects?: OperationEffectFacts;
    }
  | {
      state: 'stale';
      operationId: string;
      operationKind: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      review: OperationReviewModel;
      originIssue?: IssueOrigin;
      operationRecordId?: string;
      diagnosticIds?: string[];
      effects?: OperationEffectFacts;
    }
  | {
      state: 'blocked';
      operationId: string;
      code: string;
      message: string;
      operationKind?: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      pluginId?: string;
      returnRoute?: TuiRoute;
      originIssue?: IssueOrigin;
      writeMayHaveCompleted?: boolean;
      verification?: 'issueStillPresent' | 'verificationFailed';
      summary?: OperationResultSummary;
      operationRecordId?: string;
      diagnosticIds?: string[];
      effects?: OperationEffectFacts;
    };

export interface OperationResultSummary {
  code: 'operationSucceeded' | 'operationPartial' | 'operationFailed';
  message: string;
  pluginId?: string;
  action?: PluginWriteOperation;
  catalogAction?: Extract<OperationIntent, { kind: 'catalogGeneration' }>['action'];
  catalogManagement?: {
    action: CatalogManagementIntent['action'];
    state: 'succeeded' | 'partial';
    catalogVersion?: string;
    planDigest?: string;
    store?: {
      deletedEntries: number;
      deletedBytes: number;
      retainedEntries: number;
    };
    publication?: {
      catalogVersion: string;
      planDigest: string;
      state: 'prepared' | 'uncertain' | 'published';
      remote: string;
      branch: string;
    };
  };
  catalogGeneration?: Pick<CatalogGenerationSyncResult,
    'activeChanged' | 'outcome'> & { catalogVersion: string };
  elapsedMs?: number;
  messages?: string[];
  configApplied?: boolean;
  configApplySkippedReason?: 'invalidConfig';
  configScope?: Scope;
  configApplyRetryAvailable?: boolean;
  resetDisposition?: 'absent' | 'deletedFile' | 'unlinkedSymlink' | 'quarantinedDirectory';
  quarantineBasename?: string;
  changes?: string[];
  warnings?: string[];
  recoveryActions?: string[];
  planFingerprint?: string;
  diagnosticIds?: string[];
  effects?: OperationEffectFacts;
  batch?: {
    requestedPluginIds: string[];
    failedRequestedPluginIds: string[];
    rootResults: PluginWriteBatchRootResult[];
    retryTargets?: PluginWriteBatchTarget[];
    groupCount: number;
  };
  task?: {
    goal: PluginWriteTaskGoal;
    requestedTargets: PluginWriteTaskTarget[];
    rootResults: PluginWriteTaskRootResult[];
    retryTargets?: PluginWriteTaskTarget[];
    blockedTargets: PluginWriteTaskBlockedTarget[];
  };
  portable?: {
    selectedSkills: string[];
    agentMode: 'automatic' | 'explicit';
    requestedAgents: string[];
    scope: Scope;
    materializationDigest: string;
    skillsCliVersion: string;
    missing: Array<{ skill: string; agent?: string }>;
    verificationUnknown: boolean;
    recovery?: string;
    failureCode?: string;
  };
  targets?: Array<{
    pluginId?: string;
    platform: PlatformName;
    scope: Scope;
    state: 'completed' | 'kept' | 'failed' | 'skipped';
    relation?: 'requested' | 'direct' | 'transitive';
    requiredBy?: string[];
    errorCode?: string;
    diagnosticIds?: string[];
    effects?: OperationEffectFacts;
  }>;
}

export interface PluginWriteTaskRootResult {
  pluginId: string;
  state: 'completed' | 'kept' | 'partial' | 'failed' | 'notStarted' | 'blocked';
  causeKeys: string[];
  targets: Array<{
    pluginId?: string;
    platform: PlatformName;
    scope: Scope;
    state: 'completed' | 'kept' | 'failed' | 'skipped';
    relation?: 'requested' | 'direct' | 'transitive';
    errorCode?: string;
  }>;
}

export interface PluginWriteBatchRootResult {
  pluginId: string;
  state: 'completed' | 'kept' | 'partial' | 'failed' | 'notStarted';
  targets: Array<{
    pluginId: string;
    platform: PlatformName;
    scope: Scope;
    state: 'completed' | 'kept' | 'failed' | 'skipped';
    relation: 'requested';
    errorCode?: string;
  }>;
}

export interface PluginOperationProgressLine {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  relation: 'requested' | 'direct' | 'transitive';
  requiredBy: string[];
  state: 'pending' | 'running' | 'completed' | 'kept' | 'failed' | 'skipped';
}

export interface TuiStatusLoadResult {
  cliChannel?: 'latest' | 'beta';
  payload: StatusV8Payload;
  pluginSummaries: StatusV8PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceDetails?: SourceDetailViewModel[];
  configuredSources?: CatalogSource[];
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
  configStoreInventory?: Array<{
    pluginId: string;
    sourceId: string;
    pluginName: string;
    scope: Scope;
  }>;
  catalogGenerations?: CatalogSourceGenerationViewModel[];
  sessionGenerationKeys?: Record<string, string>;
}

export interface InstallTargetOption {
  platform: PlatformName;
  compatible: boolean;
  disabled?: string;
}

export interface SourceReferenceSummaryViewModel {
  blocked: boolean;
  inventoryComplete: boolean;
  installationCount?: number;
  configCount?: number;
  lifecycleCount?: number;
  marketplaceCount?: number;
  dependencies: Array<{
    category: 'installation' | 'config' | 'lifecycle' | 'marketplace';
    pluginId?: string;
    sourceId?: string;
    platform?: PlatformName;
    scope?: Scope;
  }>;
}

export interface TuiControllerDependencies {
  catalogManagement?: CatalogManagementService;
  beginCatalogSession?: (options?: {
    reuseValidatedGenerations?: boolean;
  }) => void;
  loadStatus: (signal: AbortSignal) => Promise<TuiStatusLoadResult>;
  probeCatalogFreshness?: (
    sourceId: string,
    options: { fullValidation: boolean },
    signal: AbortSignal,
  ) => Promise<CatalogGenerationFreshnessResult>;
  inspectSourceRemoval?: (sourceId: string, signal: AbortSignal) => Promise<SourceReferenceSummaryViewModel>;
  captureEvidence: (intent: OperationIntent, signal?: AbortSignal) => Promise<OperationEvidence>;
  validateIntent?: (intent: OperationIntent, signal: AbortSignal) => Promise<void>;
  prepareReviewEvidence?: (
    intent: OperationIntent,
    signal: AbortSignal,
    onStage: (stage: ReviewPreparationStageId) => void | Promise<void>,
    reusableCandidate?: CatalogSessionReusableCandidate,
  ) => Promise<OperationEvidence>;
  previewDependencyPlacement?: (
    intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
    signal: AbortSignal,
  ) => Promise<ReconcileOperationPlan | undefined>;
  executeIntent: (
    intent: OperationIntent,
    expectedEvidence: OperationEvidence,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  getConfigGroups?: (
    pluginId: string,
    layer: { scope: Scope },
    signal: AbortSignal,
  ) => Promise<ConfigGroupViewModel[]>;
  getConfigPage?: (
    pluginId: string,
    layer: { scope: Scope | 'effective' },
    signal: AbortSignal,
  ) => Promise<ConfigPageViewModel>;
  getConfigResetAvailability?: (
    pluginId: string,
    layer: { scope: Scope },
    signal: AbortSignal,
  ) => Promise<ConfigResetAvailability>;
  logError?: (
    error: unknown,
    code: string,
    context?: { privateConfigOperation: boolean },
  ) => void | Promise<void>;
  now?: () => number;
  createToken?: () => string;
  reviewTtlMs?: number;
  maxReviewTickets?: number;
}

export interface ConfigResetAvailability {
  exists: boolean;
  state: 'missing' | 'ready' | 'invalid';
  targetKind?: 'absent' | 'regularFile' | 'symbolicLink' | 'directory' | 'special';
  resettable?: boolean;
  invalidCode?: ConfigInvalidStoreEvidence['code'];
  sourceIdentityPresent: boolean;
  sourceIdentity?: string;
  storeDigest?: string;
}

export interface ForceCleanupCandidate {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  actionCount: number;
}

export interface TuiControllerSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
  statusReadAtMs?: number;
  cliChannel?: 'latest' | 'beta';
  router: TuiRouterSnapshot;
  viewModel?: TuiViewModel;
  sourceHealth: SourceHealthViewModel[];
  catalogGenerations: CatalogSourceGenerationViewModel[];
  catalogFreshness: CatalogSourceFreshnessViewModel[];
  reloadRequiredSourceIds: string[];
  progress: RebuildProgressSnapshot;
  progressTargets: PluginOperationProgressLine[];
  activeReview?: OperationReviewModel;
  reviewPreparation?: ReviewPreparationSnapshot;
  result?: OperationExecuteResult;
  operationHistorySummaries: OperationHistorySummary[];
  portableResultSkills?: string[];
  loadError?: { code: string; message: string };
  portableDraft?: PortableSkillSelectionViewModel & {
    agentMode: 'automatic' | 'explicit';
    requestedAgents: string[];
    scope: Scope;
  };
  installPlacementDraft?: InstallPlacementDraftViewModel;
}

interface InstallPlacementDraftState extends InstallPlacementDraftViewModel {
  plan?: ReconcileOperationPlan;
}

interface ReviewTicket {
  intent: OperationIntent;
  evidence: OperationEvidence;
  review: OperationReviewModel;
  returnRoute: TuiRoute;
}

interface ActiveReviewPreparation {
  snapshot: ReviewPreparationSnapshot;
  key: string;
  returnRoute: TuiRoute;
  abort: AbortController;
  token: number;
}

export class TuiOperationBlockedError extends Error {
  readonly code: string;
  readonly diagnostics?: SafeOperationDiagnostic[];

  constructor(code: string, message: string, diagnostics?: readonly SafeOperationDiagnostic[]) {
    super(message);
    this.name = 'TuiOperationBlockedError';
    this.code = code;
    if (diagnostics?.length) this.diagnostics = [...structuredClone(diagnostics)];
  }
}

export class TuiConfigInvalidStoreError extends Error {
  readonly code = 'invalidConfigStores';
  readonly evidence: ConfigInvalidStoreEvidence[];

  constructor(evidence: ConfigInvalidStoreEvidence[]) {
    super('One or more plugin config stores are invalid.');
    this.name = 'TuiConfigInvalidStoreError';
    this.evidence = structuredClone(evidence).sort((left, right) =>
      (left.scope === 'user' ? 0 : 1) - (right.scope === 'user' ? 0 : 1));
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, entry]) => [key, stableValue(entry)]));
}

function canonicalPluginIds(pluginIds: readonly string[]): string[] {
  return [...new Set(pluginIds)].sort((left, right) => left.localeCompare(right, 'en'));
}

function canonicalBatchTargets(targets: readonly PluginWriteBatchTarget[]): PluginWriteBatchTarget[] {
  const byKey = new Map<string, PluginWriteBatchTarget>();
  for (const target of targets) {
    byKey.set([target.pluginId, target.platform, target.scope].join('\0'), target);
  }
  return [...byKey.values()].sort((left, right) =>
    [left.pluginId, left.platform, left.scope].join('\0')
      .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en'));
}

function canonicalPluginWriteTaskTargets(
  targets: readonly PluginWriteTaskTarget[],
): PluginWriteTaskTarget[] {
  return [...new Map(targets.map((target) => [pluginWriteTaskTargetKey(target), target])).values()]
    .sort((left, right) => pluginWriteTaskTargetKey(left)
      .localeCompare(pluginWriteTaskTargetKey(right), 'en'));
}

function normalizeOperationIntent(intent: OperationIntent): OperationIntent {
  if (intent.kind === 'configSave' && intent.retryApply && !intent.apply) {
    return { ...intent, apply: true };
  }
  if (intent.kind === 'pluginWriteTask') {
    return { ...intent, targets: canonicalPluginWriteTaskTargets(intent.targets) };
  }
  if (intent.kind === 'catalogManagement' && intent.action === 'storePrune') {
    const items = [...new Map(intent.items.map((item) => [
      `${item.category}\0${item.storeKey}`,
      item,
    ])).values()].sort((left, right) =>
      `${left.category}\0${left.storeKey}`.localeCompare(
        `${right.category}\0${right.storeKey}`,
        'en',
      ));
    return { ...intent, items };
  }
  if (intent.kind !== 'pluginWriteBatch') return intent;
  if (intent.selection.kind === 'targets') {
    return {
      ...intent,
      selection: { kind: 'targets', targets: canonicalBatchTargets(intent.selection.targets) },
    };
  }
  if (intent.selection.kind !== 'selected') return intent;
  return {
    ...intent,
    selection: {
      kind: 'selected',
      pluginIds: canonicalPluginIds(intent.selection.pluginIds),
    },
  };
}

function assertPluginWriteTaskEvidence(
  intent: PluginWriteTaskIntent,
  evidence: OperationEvidence,
): asserts evidence is PluginWriteTaskEvidence {
  const candidate = evidence as Partial<PluginWriteTaskEvidence>;
  const plan = candidate.taskPlan;
  if (!plan || plan.goal !== intent.goal || !Array.isArray(plan.requestedTargets)
    || !Array.isArray(plan.executableTargets) || !Array.isArray(plan.blockedTargets)
    || !Array.isArray(plan.causes) || !Array.isArray(plan.sources)
    || typeof plan.targetFingerprint !== 'string' || typeof plan.planFingerprint !== 'string'
    || JSON.stringify(plan.requestedTargets) !== JSON.stringify(intent.targets)
    || plan.executableTargets.length === 0) {
    throw new TuiOperationBlockedError('taskEvidenceInvalid', '任务确认信息不完整。');
  }
  if (plan.planFingerprint !== operationEvidenceFingerprint(evidence)) {
    throw new TuiOperationBlockedError('taskEvidenceInvalid', '任务确认指纹无效。');
  }
  if (intent.executionPolicy === 'all' && plan.blockedTargets.length > 0) {
    throw new TuiOperationBlockedError('taskHasBlockedTargets', '部分目标需要先处理，不能作为完整任务执行。');
  }
  const requested = new Set(plan.requestedTargets.map(pluginWriteTaskTargetKey));
  const executable = new Set(plan.executableTargets.map(pluginWriteTaskTargetKey));
  const blocked = new Set(plan.blockedTargets.map((target) => pluginWriteTaskTargetKey(target.target)));
  if (executable.size !== plan.executableTargets.length || blocked.size !== plan.blockedTargets.length
    || [...executable].some((key) => !requested.has(key) || blocked.has(key))
    || [...blocked].some((key) => !requested.has(key))
    || [...requested].some((key) => !executable.has(key) && !blocked.has(key))) {
    throw new TuiOperationBlockedError('taskEvidenceInvalid', '任务目标分区无效。');
  }
  const grouped = new Set<string>();
  for (const source of plan.sources) {
    if (!source.sourceId || !source.sourceIdentity || source.requestedTargets.length === 0
      || source.executable !== Boolean(source.preview.operationPlan)
      || source.requestedTargets.some((target) =>
        !executable.has(pluginWriteTaskTargetKey(target))
        || sourceIdFromPluginId(target.pluginId) !== source.sourceId)
      || source.causes.some((cause) => cause.sourceId !== source.sourceId
        || cause.sourceIdentity !== source.sourceIdentity
        || cause.consumers.some((consumer) => !executable.has(pluginWriteTaskTargetKey(consumer))))) {
      throw new TuiOperationBlockedError('taskEvidenceInvalid', '任务来源计划无效。');
    }
    source.requestedTargets.forEach((target) => grouped.add(pluginWriteTaskTargetKey(target)));
  }
  if ([...executable].some((key) => !grouped.has(key))) {
    throw new TuiOperationBlockedError('taskEvidenceInvalid', '任务来源计划缺少可执行目标。');
  }
}

function assertPluginWriteBatchEvidence(
  evidence: OperationEvidence,
): asserts evidence is PluginWriteBatchEvidence {
  const candidate = evidence as Partial<PluginWriteBatchEvidence>;
  if (!Array.isArray(candidate.requestedPluginIds) || !Array.isArray(candidate.groups)) {
    throw new TuiOperationBlockedError('batchEvidenceInvalid', '批量确认信息不完整。');
  }
  const requestedPluginIds = canonicalPluginIds(candidate.requestedPluginIds);
  if (requestedPluginIds.length === 0
    || JSON.stringify(requestedPluginIds) !== JSON.stringify(candidate.requestedPluginIds)) {
    throw new TuiOperationBlockedError('batchEvidenceInvalid', '批量根插件集合无效。');
  }
  const requested = new Set(requestedPluginIds);
  const groupIds = new Set<string>();
  const groupedRoots = new Set<string>();
  for (const group of candidate.groups) {
    if (!group || typeof group.groupId !== 'string' || group.groupId.length === 0
      || typeof group.sourceId !== 'string' || group.sourceId.length === 0
      || groupIds.has(group.groupId)
      || !Array.isArray(group.requestedPluginIds)
      || group.requestedPluginIds.length === 0
      || JSON.stringify(canonicalPluginIds(group.requestedPluginIds))
        !== JSON.stringify(group.requestedPluginIds)
      || group.requestedPluginIds.some((pluginId) => !requested.has(pluginId))
      || group.executable !== Boolean(group.preview?.operationPlan)) {
      throw new TuiOperationBlockedError('batchEvidenceInvalid', '批量分组确认信息无效。');
    }
    groupIds.add(group.groupId);
    group.requestedPluginIds.forEach((pluginId) => groupedRoots.add(pluginId));
  }
  if (requestedPluginIds.some((pluginId) => !groupedRoots.has(pluginId))) {
    throw new TuiOperationBlockedError('batchEvidenceInvalid', '批量分组缺少请求根插件。');
  }
}

export function pluginWriteBatchFailedRequestedTargets(
  execution: PluginWriteBatchExecutionResult,
): PluginWriteBatchTarget[] {
  const failed: PluginWriteBatchTarget[] = [];
  for (const group of execution.groupResults) {
    const roots = new Set(group.requestedPluginIds);
    const targetsByPlugin = new Map<string, typeof group.result.targetResults>();
    for (const target of group.result.targetResults) {
      const pluginId = target.target.pluginId;
      if (!pluginId) continue;
      const entries = targetsByPlugin.get(pluginId) ?? [];
      entries.push(target);
      targetsByPlugin.set(pluginId, entries);
    }
    const successfulRootKeys = new Set(group.result.targetResults.flatMap((target) => {
      const pluginId = target.target.pluginId;
      return pluginId && roots.has(pluginId)
        && target.state !== 'failed' && target.action !== 'skipped'
        ? [[pluginId, target.target.platform, target.target.scope].join('\0')]
        : [];
    }));
    const unsuccessful = group.result.targetResults.filter((target) =>
      target.state === 'failed' || target.action === 'skipped');
    for (const target of unsuccessful) {
      const pending = target.target.pluginId
        ? [{ pluginId: target.target.pluginId, platform: target.target.platform }]
        : [];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.shift()!;
        const visitKey = [current.pluginId, current.platform].join('\0');
        if (visited.has(visitKey)) continue;
        visited.add(visitKey);
        const candidates = (targetsByPlugin.get(current.pluginId) ?? [])
          .filter((candidate) => candidate.target.platform === current.platform);
        if (roots.has(current.pluginId)) {
          if (candidates.length === 0) {
            const retryTarget = {
              pluginId: current.pluginId,
              platform: current.platform,
              scope: group.scope,
            };
            const key = [retryTarget.pluginId, retryTarget.platform, retryTarget.scope].join('\0');
            if (!successfulRootKeys.has(key)) failed.push(retryTarget);
          }
          for (const candidate of candidates) {
            const retryTarget = {
              pluginId: current.pluginId,
              platform: candidate.target.platform,
              scope: candidate.target.scope,
            };
            const key = [current.pluginId, retryTarget.platform, retryTarget.scope].join('\0');
            if (!successfulRootKeys.has(key)) failed.push(retryTarget);
          }
          continue;
        }
        for (const candidate of candidates) {
          pending.push(...(candidate.requiredBy ?? []).map((pluginId) => ({
            pluginId, platform: current.platform,
          })));
        }
      }
    }
  }
  return canonicalBatchTargets(failed);
}

export function pluginWriteBatchFailedRequestedPluginIds(
  execution: PluginWriteBatchExecutionResult,
): string[] {
  return canonicalPluginIds(pluginWriteBatchFailedRequestedTargets(execution)
    .map((target) => target.pluginId));
}

export function pluginWriteTaskFailedRequestedTargets(
  execution: PluginWriteTaskExecutionResult,
): PluginWriteTaskTarget[] {
  const requested = new Map(execution.taskPlan.requestedTargets.map((target) => [
    pluginWriteTaskTargetKey(target), target,
  ]));
  const failed = new Set<string>();
  const succeeded = new Set<string>();
  for (const source of execution.sourceResults) {
    const sourceRequested = new Set(source.requestedTargets.map(pluginWriteTaskTargetKey));
    if (source.result.targetResults.length === 0 && source.result.overallState !== 'succeeded') {
      sourceRequested.forEach((key) => failed.add(key));
      continue;
    }
    for (const result of source.result.targetResults) {
      const pluginId = result.target.pluginId;
      if (!pluginId) continue;
      const exactKey = pluginWriteTaskTargetKey({
        pluginId,
        platform: result.target.platform,
        scope: result.target.scope,
      });
      if (sourceRequested.has(exactKey)) {
        if (result.state === 'failed' || result.action === 'skipped') failed.add(exactKey);
        else succeeded.add(exactKey);
      }
      if (result.state !== 'failed' && result.action !== 'skipped') continue;
      for (const cause of source.requestedTargets.length > 0
        ? execution.taskPlan.causes.filter((cause) => cause.sourceId === source.sourceId) : []) {
        if (pluginWriteTaskTargetKey(cause.repairTarget) !== exactKey) continue;
        cause.consumers.forEach((consumer) => failed.add(pluginWriteTaskTargetKey(consumer)));
      }
      const placement = source.result.dependencyPlan?.targets.find((target) =>
        target.pluginId === pluginId && target.platform === result.target.platform
        && (target.requestedScope ?? target.resolvedScope) === result.target.scope);
      for (const consumer of placement?.requiredByTargets ?? []) {
        failed.add(pluginWriteTaskTargetKey(consumer));
      }
    }
  }
  for (const key of succeeded) failed.delete(key);
  return canonicalPluginWriteTaskTargets([...failed].flatMap((key) => {
    const target = requested.get(key);
    return target ? [target] : [];
  }));
}

function collectOperationSensitiveValues(intent: OperationIntent): string[] {
  if (intent.kind === 'catalogManagement') {
    return [
      ...('ownerUrl' in intent && intent.ownerUrl ? [intent.ownerUrl] : []),
      ...('remoteUrl' in intent && intent.remoteUrl ? [intent.remoteUrl] : []),
    ];
  }
  if (intent.kind !== 'configSave') return [];
  const sensitiveKeys = new Set([...(intent.sensitiveKeys ?? []), ...(intent.privateKeys ?? [])]);
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(visit);
  };
  for (const [key, value] of Object.entries(intent.updates ?? {})) {
    if (sensitiveKeys.has(key)) visit(value);
  }
  return values;
}

function sanitizeOperationSummary(
  summary: OperationResultSummary,
  sensitiveValues: readonly string[],
): OperationResultSummary {
  const text = (value: string): string => sanitizeDiagnosticText(value, [], sensitiveValues);
  return {
    ...summary,
    message: text(summary.message),
    ...(summary.messages ? { messages: summary.messages.map(text) } : {}),
    ...(summary.changes ? { changes: summary.changes.map(text) } : {}),
    ...(summary.warnings ? { warnings: summary.warnings.map(text) } : {}),
    ...(summary.recoveryActions ? { recoveryActions: summary.recoveryActions.map(text) } : {}),
    ...(summary.quarantineBasename ? { quarantineBasename: text(summary.quarantineBasename) } : {}),
    ...(summary.portable ? {
      portable: {
        ...summary.portable,
        ...(summary.portable.recovery ? { recovery: text(summary.portable.recovery) } : {}),
      },
    } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

export function operationEvidenceFingerprint(evidence: OperationEvidence): string {
  if (evidence.catalogManagement) {
    const management = evidence.catalogManagement;
    return crypto.createHash('sha256')
      .update(JSON.stringify(stableValue(management.action === 'storePrune'
        ? {
            action: management.action,
            workspaceBinding: management.workspaceBinding,
            authorizedStoreItems: management.authorizedStoreItems,
          }
        : {
            action: management.action,
            workspaceBinding: management.workspaceBinding,
            evidenceDigest: management.evidenceDigest,
          })))
      .digest('hex');
  }
  if ('taskPlan' in evidence) {
    const task = (evidence as PluginWriteTaskEvidence).taskPlan;
    return crypto.createHash('sha256')
      .update(JSON.stringify(stableValue({
        catalog: evidence.catalog,
        goal: task.goal,
        requestedTargets: task.requestedTargets,
        executableTargets: task.executableTargets,
        causes: task.causes,
        blockedTargets: task.blockedTargets,
        targetFingerprint: task.targetFingerprint,
        sources: task.sources.map((source) => ({
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          requestedTargets: source.requestedTargets,
          causes: source.causes,
          executable: source.executable,
          planFingerprint: source.preview.operationPlan?.planFingerprint,
          targetResults: source.preview.targetResults.map((target) => ({
            pluginId: target.target.pluginId,
            platform: target.target.platform,
            scope: target.target.scope,
            state: target.state,
            action: target.action,
            errorCode: target.errorCode,
            requiredBy: target.requiredBy,
          })),
        })),
      })))
      .digest('hex');
  }
  if ('groups' in evidence && 'requestedPluginIds' in evidence) {
    const batch = evidence as PluginWriteBatchEvidence;
    return crypto.createHash('sha256')
      .update(JSON.stringify(stableValue({
        requestedPluginIds: batch.requestedPluginIds,
        groups: batch.groups.map((group) => ({
          groupId: group.groupId,
          sourceId: group.sourceId,
          platform: group.platform,
          requestedPluginIds: group.requestedPluginIds,
          executable: group.executable,
          planFingerprint: group.preview.operationPlan?.planFingerprint,
          overallState: group.preview.overallState,
          targetResults: group.preview.targetResults.map((target) => ({
            pluginId: target.target.pluginId,
            platform: target.target.platform,
            scope: target.target.scope,
            state: target.state,
            action: target.action,
            errorCode: target.errorCode,
            requiredBy: target.requiredBy,
          })),
        })),
      })))
      .digest('hex');
  }
  if (evidence.operationPlan) return evidence.operationPlan.planFingerprint;
  if (evidence.resetTarget) {
    return crypto.createHash('sha256')
      .update(JSON.stringify(stableValue({
        resetTarget: evidence.resetTarget,
        ...(evidence.source ? { source: evidence.source } : {}),
      })))
      .digest('hex');
  }
  const { codexManager: _runtimeSelection, ...staleEvidence } = evidence;
  const config = staleEvidence.config
    ? (({ shareability: _shareability, ...identity }) => identity)(staleEvidence.config)
    : undefined;
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue({
      ...staleEvidence,
      ...(config ? { config } : {}),
    })))
    .digest('hex');
}

export function operationEvidenceMatches(
  expected: OperationEvidence,
  current: OperationEvidence,
): boolean {
  if (expected.resetTarget && current.resetTarget) {
    if (JSON.stringify(stableValue(expected.resetTarget))
      !== JSON.stringify(stableValue(current.resetTarget))) {
      return false;
    }
    if (expected.source && (current.source === undefined
      || JSON.stringify(stableValue(expected.source))
        !== JSON.stringify(stableValue(current.source)))) {
      return false;
    }
    if (expected.targetFingerprint !== undefined
      && expected.targetFingerprint !== current.targetFingerprint) {
      return false;
    }
    if (expected.config?.impactState !== 'known') return true;
    return JSON.stringify(stableValue({
      config: expected.config,
    })) === JSON.stringify(stableValue({
      config: current.config,
    }));
  }
  return operationEvidenceFingerprint(expected) === operationEvidenceFingerprint(current);
}

function sourceIdFromPluginId(pluginId: string): string {
  const separator = pluginId.indexOf('/');
  if (separator <= 0) throw new TuiOperationBlockedError('invalidPluginId', '操作必须使用 canonical pluginId。');
  return pluginId.slice(0, separator);
}

function pluginNameFromId(pluginId: string): string {
  const separator = pluginId.indexOf('/');
  return separator < 0 ? pluginId : pluginId.slice(separator + 1);
}

export function userIssueKey(issue: Pick<UserIssueViewModel,
  'category' | 'pluginId' | 'dependencyPluginId' | 'dependencyPlatform' | 'dependencyScope'
  | 'dependencyProject' | 'sourceId' | 'sourceIdentity' | 'platform' | 'scope'>): string {
  return [issue.category, issue.pluginId ?? '', issue.dependencyPluginId ?? '',
    issue.dependencyPlatform ?? '', issue.dependencyScope ?? '', issue.dependencyProject ?? '',
    issue.sourceId ?? '', issue.sourceIdentity ?? '', issue.platform ?? '', issue.scope ?? '']
    .join('\0');
}

function originIssueRemains(
  issue: UserIssueViewModel,
  origin: IssueOrigin,
): boolean {
  if (!origin.consumerPluginId || !origin.consumerPlatform || !origin.consumerScope) {
    return userIssueKey(issue) === origin.issueKey;
  }
  return issue.category === origin.category
    && issue.dependencyPluginId === origin.dependencyPluginId
    && issue.dependencyPlatform === origin.dependencyPlatform
    && issue.dependencyScope === origin.dependencyScope
    && issue.affectedTargets?.some((target) =>
      target.pluginId === origin.consumerPluginId
      && target.platform === origin.consumerPlatform
      && target.scope === origin.consumerScope) === true;
}


function issueCode(error: unknown): string {
  const safeOperationError = readSafeOperationError(error);
  if (safeOperationError) return safeDiagnosticCode(safeOperationError.code, 'operationBlocked');
  if (error instanceof TuiOperationBlockedError) return error.code;
  if (error instanceof CatalogManagementError) return error.code;
  if (error instanceof CatalogGenerationError) return error.code;
  if (error instanceof Error && error.name === 'CatalogSourcesConfigConflictError') {
    return 'operationReviewStale';
  }
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.split(':', 1)[0];
  return /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'operationBlocked';
}

export function extractPortableError(error: unknown): {
  code: PortableBlockerCode;
  diagnosticCode: string;
} {
  const typedCode = typeof error === 'object' && error !== null
    && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const fallback = message.match(/^([A-Za-z][A-Za-z0-9]*):/u)?.[1];
  const diagnosticCode = safeDiagnosticCode(
    typedCode ?? fallback,
    'portableValidationFailed',
  );
  if (diagnosticCode === 'requiredConfigMissing') return { code: 'requiredConfigMissing', diagnosticCode };
  if (diagnosticCode === 'portableSkillsCliMissing') return { code: 'portableSkillsCliMissing', diagnosticCode };
  if (diagnosticCode === 'portableSkillsCliIncompatible') return { code: 'portableSkillsCliIncompatible', diagnosticCode };
  if (diagnosticCode === 'portableScopeUnavailable') return { code: 'portableScopeUnavailable', diagnosticCode };
  return { code: 'portableValidationFailed', diagnosticCode };
}

export class TuiController {
  readonly #router = new TuiRouter();
  readonly #listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();
  readonly #health = new Map<string, SourceHealthViewModel>();
  readonly #tickets = new Map<string, ReviewTicket>();
  readonly #reviewPreparationIntents = new Map<string, OperationIntent>();
  readonly #inflightOperations = new Map<string, {
    operationId: string;
    promise: Promise<OperationExecuteResult>;
  }>();
  readonly #pendingReads = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  readonly #progressUnsubscribe?: () => void;
  readonly #progressFeed?: RebuildProgressFeed;
  #phase: TuiControllerSnapshot['phase'] = 'idle';
  #status?: TuiStatusLoadResult;
  #statusReadAtMs?: number;
  readonly #catalogGenerations = new Map<string, CatalogSourceGenerationViewModel>();
  readonly #catalogFreshness = new Map<string, CatalogSourceFreshnessViewModel>();
  readonly #catalogSourcesSession: CatalogSourcesSession;
  readonly #sessionGenerationKeys = new Map<string, string>();
  #viewModel?: TuiViewModel;
  #progress: RebuildProgressSnapshot = { messages: [] };
  #progressTargets: PluginOperationProgressLine[] = [];
  #activeReview?: OperationReviewModel;
  #reviewPreparation?: ActiveReviewPreparation;
  #reviewPreparationToken = 0;
  #result?: OperationExecuteResult;
  #resultAnchor?: TuiRoute;
  #portableResultSkills?: string[];
  #loadError?: { code: string; message: string };
  #portableDraft?: TuiControllerSnapshot['portableDraft'];
  #recoverablePortableDraft?: TuiControllerSnapshot['portableDraft'];
  #portableRepreparePluginId?: string;
  #portableRequestToken = 0;
  #portableRequestAbort?: AbortController;
  #portablePending?: { key: string; promise: Promise<unknown> };
  #installPlacementDraft?: InstallPlacementDraftState;
  #recoverableInstallPlacementDraft?: InstallPlacementDraftState;
  #installPlacementRequestToken = 0;
  #installPlacementRequestAbort?: AbortController;
  #generation = 0;
  #disposed = false;
  #retiring = false;
  #externalDrafts: ExternalDraftState[] = [];
  #batchRetryIntent?: PluginWriteBatchIntent;
  #taskRetryIntent?: PluginWriteTaskIntent;
  #operationHistory = new OperationHistoryStore();
  #sessionEpoch = 0;
  #lastRecordedResultId?: string;
  readonly #operationDiagnostics = new Map<string, {
    diagnostics: SafeOperationDiagnostic[];
    effects: OperationEffectFacts;
    targetEffects?: Map<string, OperationEffectFacts>;
    targets?: OperationHistoryTarget[];
    sensitiveValues?: string[];
  }>();

  constructor(
    readonly dependencies: TuiControllerDependencies,
    progressFeed?: RebuildProgressFeed,
  ) {
    this.#progressFeed = progressFeed;
    this.#catalogSourcesSession = new CatalogSourcesSession({
      parentSignal: this.#abort.signal,
      probe: async (sourceId, options, signal) => {
        if (!this.dependencies.probeCatalogFreshness) {
          throw new TuiOperationBlockedError('catalogFreshnessUnavailable', '来源检查入口不可用。');
        }
        return this.dependencies.probeCatalogFreshness(sourceId, options, signal);
      },
      onChange: (sourceId, freshness) => {
        this.#catalogFreshness.set(sourceId, structuredClone(freshness));
        this.#project();
        this.#publish();
      },
      onError: (error, code) => {
        void this.#logErrorSafe(error, code);
      },
      now: this.dependencies.now,
    });
    if (progressFeed) {
      this.#progressUnsubscribe = progressFeed.subscribe((progress) => {
        if (this.#router.snapshot.current.route.name === 'result') return;
        this.#progress = {
          ...structuredClone(progress),
          messages: progress.messages.slice(-8),
          ...(this.#progress.startedAtMs !== undefined ? { startedAtMs: this.#progress.startedAtMs } : {}),
        };
        const current = progress.current;
        if (current) {
          const [pluginName, placement = ''] = current.target.split(' · ', 2);
          const platform = placement.startsWith('Codex') ? 'codex'
            : placement.startsWith('Claude Code') ? 'claude' : undefined;
          const scope = placement.endsWith('当前项目') ? 'project'
            : placement.endsWith('当前用户') ? 'user' : undefined;
          if (pluginName && platform && scope) {
            this.#progressTargets = this.#progressTargets.map((target) =>
              pluginNameFromId(target.pluginId) === pluginName
              && target.platform === platform && target.scope === scope
                ? { ...target, state: target.state === 'failed' ? 'failed'
                    : current.phase.endsWith('失败') ? 'failed'
                    : current.phase.endsWith('已完成') ? 'completed' : 'running' }
                : target);
          }
        }
        this.#publish();
      });
    }
  }

  get snapshot(): TuiControllerSnapshot {
    return cloneFrozen({
      phase: this.#phase,
      ...(this.#statusReadAtMs !== undefined ? { statusReadAtMs: this.#statusReadAtMs } : {}),
      ...(this.#status?.cliChannel ? { cliChannel: this.#status.cliChannel } : {}),
      router: this.#router.snapshot,
      ...(this.#viewModel ? { viewModel: this.#viewModel } : {}),
      sourceHealth: [...this.#health.values()],
      catalogGenerations: [...this.#catalogGenerations.values()]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en')),
      catalogFreshness: [...this.#catalogFreshness.values()]
        .sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en')),
      reloadRequiredSourceIds: [],
      progress: this.#progress,
      progressTargets: this.#progressTargets,
      ...(this.#activeReview ? { activeReview: this.#activeReview } : {}),
      ...(this.#reviewPreparation
        ? { reviewPreparation: this.#reviewPreparation.snapshot }
        : {}),
      ...(this.#result ? { result: this.#result } : {}),
      operationHistorySummaries: this.#operationHistory.list(),
      ...(this.#portableResultSkills ? { portableResultSkills: this.#portableResultSkills } : {}),
      ...(this.#loadError ? { loadError: this.#loadError } : {}),
      ...(this.#portableDraft ? { portableDraft: this.#portableDraft } : {}),
      ...(this.#installPlacementDraft
        ? { installPlacementDraft: {
            pluginId: this.#installPlacementDraft.pluginId,
            rootScope: this.#installPlacementDraft.rootScope,
            platforms: this.#installPlacementDraft.platforms,
            dependencyScopeOverrides: this.#installPlacementDraft.dependencyScopeOverrides,
            state: this.#installPlacementDraft.state,
            targets: this.#installPlacementDraft.targets,
            canContinue: this.#installPlacementDraft.canContinue,
            ...(this.#installPlacementDraft.error
              ? { error: this.#installPlacementDraft.error }
              : {}),
          } }
        : {}),
    });
  }

  subscribe(listener: (snapshot: TuiControllerSnapshot) => void): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot);
    return () => this.#listeners.delete(listener);
  }

  get hasActiveWrite(): boolean {
    return this.#inflightOperations.size > 0;
  }

  get retiring(): boolean {
    return this.#retiring;
  }

  get hasSessionDraft(): boolean {
    return this.#externalDrafts.length > 0
      || this.#portableDraft !== undefined
      || this.#installPlacementDraft !== undefined;
  }

  get externalDrafts(): ExternalDraftState[] {
    return structuredClone(this.#externalDrafts);
  }

  attachOperationHistory(history: OperationHistoryStore, epoch: number): void {
    this.#operationHistory = history;
    this.#sessionEpoch = epoch;
  }

  listOperationHistory(): OperationHistorySummary[] {
    return this.#operationHistory.list();
  }

  getOperationDiagnostic(recordId: string): OperationDiagnosticDetail | undefined {
    return this.#operationHistory.get(recordId);
  }

  previewOperationReport(recordId: string): OperationReportPreview | undefined {
    return this.#operationHistory.preview(recordId);
  }

  saveOperationReport(recordId: string, filePath?: string): Promise<SaveOperationReportResult> {
    return this.#operationHistory.save(recordId, filePath);
  }

  /** @internal Test-only observability for bounded private diagnostic ownership. */
  operationDiagnosticRetentionCountForTests(): number {
    return this.#operationDiagnostics.size;
  }

  recordUiFailure(error: unknown, context: { code: string; stage: string }): string {
    const recordId = this.#recordStandaloneFailure(context.code, context.stage, error);
    this.#publish();
    return recordId;
  }

  #recordStandaloneFailure(code: string, stage: string, error?: unknown): string {
    const operationId = `ui-${crypto.randomUUID()}`;
    const recordId = `${this.#sessionEpoch}:${operationId}`;
    const diagnostic = projectThrownOperationDiagnostic({
      error,
      id: `${recordId}:failure`,
      stage: safeDiagnosticCode(stage, 'ui'),
      fallbackCode: safeDiagnosticCode(code, 'uiOperationFailed'),
    });
    this.#operationHistory.record({
      summary: {
        recordId,
        epoch: this.#sessionEpoch,
        operationId,
        createdAtMs: this.dependencies.now?.() ?? Date.now(),
        state: 'blocked',
        code: diagnostic.code,
        message: diagnostic.safeMessage,
        diagnosticCount: 1,
        effects: {
          configCommit: 'notApplicable', awWrite: 'notStarted',
          preApplyExternalEffect: 'notApplicable', finalVerification: 'notStarted',
        },
      },
      diagnostics: [diagnostic],
      targets: [],
    });
    return recordId;
  }

  #trackRead<T>(promise: Promise<T>): Promise<T> {
    this.#pendingReads.add(promise);
    void promise.finally(() => this.#pendingReads.delete(promise)).catch(() => undefined);
    return promise;
  }

  beginRetirement(): void {
    this.#retiring = true;
  }

  async waitForWrites(): Promise<void> {
    this.beginRetirement();
    while (this.#inflightOperations.size > 0) {
      await Promise.allSettled(
        [...this.#inflightOperations.values()].map((operation) => operation.promise),
      );
    }
  }

  async cancelAndWaitForReads(): Promise<boolean> {
    if (this.hasActiveWrite) return false;
    this.beginRetirement();
    this.#generation += 1;
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    this.#abort.abort();
    const catalogDrain = this.#catalogSourcesSession.cancelAndWait();
    while (this.#pendingReads.size > 0) {
      await Promise.allSettled([...this.#pendingReads]);
    }
    await catalogDrain;
    return !this.hasActiveWrite;
  }

  #assertAcceptingActions(): void {
    if (this.#retiring || this.#disposed) {
      throw new DOMException('Controller session is retiring.', 'AbortError');
    }
  }

  goHome(options: { discardDrafts?: boolean } = {}): boolean {
    if (this.hasSessionDraft && !options.discardDrafts) return false;
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    this.#tickets.clear();
    this.#activeReview = undefined;
    this.#portableDraft = undefined;
    this.#recoverablePortableDraft = undefined;
    this.#installPlacementDraft = undefined;
    this.#recoverableInstallPlacementDraft = undefined;
    this.#batchRetryIntent = undefined;
    this.#taskRetryIntent = undefined;
    this.#externalDrafts = [];
    this.#result = undefined;
    this.#resultAnchor = undefined;
    this.#portableResultSkills = undefined;
    this.#progress = { messages: [] };
    this.#progressTargets = [];
    this.#router.resetToRoot();
    this.#publish();
    return true;
  }

  #publish(): void {
    if (this.#disposed) return;
    this.#recordTerminalResult();
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
  }

  #recordTerminalResult(): void {
    const result = this.#result;
    if (!result || result.state === 'stale') return;
    const recordId = `${this.#sessionEpoch}:${result.operationId}`;
    if (this.#lastRecordedResultId === recordId) return;
    const projected = this.#operationDiagnostics.get(result.operationId) ?? {
      diagnostics: [],
      effects: {
        configCommit: 'notApplicable' as const,
        awWrite: result.state === 'succeeded' ? 'completed' as const : 'unknown' as const,
        preApplyExternalEffect: 'notApplicable' as const,
        finalVerification: result.state === 'succeeded' ? 'completed' as const : 'unknown' as const,
      },
    };
    if ('summary' in result && result.summary) {
      Object.assign(result.summary, sanitizeOperationSummary(
        result.summary,
        projected.sensitiveValues ?? [],
      ));
    }
    const diagnosticIds = projected.diagnostics.map((diagnostic) => diagnostic.id);
    Object.assign(result, { operationRecordId: recordId, diagnosticIds, effects: projected.effects });
    if ('summary' in result && result.summary) {
      result.summary.diagnosticIds = diagnosticIds;
      result.summary.effects = projected.effects;
      for (const target of result.summary.targets ?? []) {
        const targetDiagnostics = projected.diagnostics.filter((diagnostic) => diagnostic.target
          && diagnostic.target.platform === target.platform
          && diagnostic.target.scope === target.scope
          && (diagnostic.target.pluginId === undefined || diagnostic.target.pluginId === target.pluginId));
        target.diagnosticIds = targetDiagnostics.map((diagnostic) => diagnostic.id);
        target.effects = projected.targetEffects?.get(`${target.pluginId ?? ''}\0${target.platform}\0${target.scope}`);
      }
    }
    const code = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.code : result.summary?.code ?? result.code;
    const message = result.state === 'succeeded' || result.state === 'partial'
      ? result.summary.message : result.summary?.message ?? result.message;
    this.#operationHistory.record({
      summary: {
        recordId,
        epoch: this.#sessionEpoch,
        operationId: result.operationId,
        createdAtMs: this.dependencies.now?.() ?? Date.now(),
        state: result.state,
        code,
        message,
        ...('operationKind' in result && result.operationKind ? { operationKind: result.operationKind } : {}),
        ...('pluginId' in result && result.pluginId ? { pluginId: result.pluginId } : {}),
        diagnosticCount: projected.diagnostics.length,
        effects: projected.effects,
      },
      diagnostics: projected.diagnostics,
      targets: 'summary' in result && result.summary
        ? structuredClone((result.summary.targets ?? []).map((target) => ({
            ...target,
            diagnosticIds: target.diagnosticIds ?? [],
          })))
        : structuredClone(projected.targets ?? []),
    }, { sensitiveValues: projected.sensitiveValues });
    this.#operationDiagnostics.delete(result.operationId);
    this.#lastRecordedResultId = recordId;
  }

  #captureThrownProjection(
    operationId: string,
    error: unknown,
    code: string,
    stage: string,
    intent?: OperationIntent,
    effects?: OperationEffectFacts,
  ): void {
    const sensitiveValues = intent ? collectOperationSensitiveValues(intent) : [];
    const carried = error instanceof TuiOperationBlockedError ? error.diagnostics : undefined;
    this.#operationDiagnostics.set(operationId, {
      diagnostics: carried?.length ? carried.map((diagnostic, index) => ({
        ...structuredClone(diagnostic),
        id: `${this.#sessionEpoch}:${operationId}:failure:${index}`,
      })) : [projectThrownOperationDiagnostic({
          error,
          id: `${this.#sessionEpoch}:${operationId}:failure`,
          stage,
          fallbackCode: code,
          sensitiveValues,
          ...(intent && 'pluginId' in intent && 'platform' in intent && intent.platform !== 'both'
            ? { target: { pluginId: intent.pluginId, platform: intent.platform, scope: intent.scope } }
            : {}),
        })],
      effects: effects ?? {
        configCommit: 'notApplicable', awWrite: 'notStarted',
        preApplyExternalEffect: 'notApplicable', finalVerification: 'notStarted',
      },
      sensitiveValues,
    });
  }

  #appendThrownProjection(
    operationId: string,
    error: unknown,
    code: string,
    stage: string,
    intent: OperationIntent,
  ): void {
    const existing = this.#operationDiagnostics.get(operationId);
    if (!existing) {
      this.#captureThrownProjection(operationId, error, code, stage, intent);
      return;
    }
    const carried = error instanceof TuiOperationBlockedError ? error.diagnostics : undefined;
    const diagnostics = carried?.length ? carried : [projectThrownOperationDiagnostic({
      error,
      id: `${this.#sessionEpoch}:${operationId}:failure:${existing.diagnostics.length}`,
      stage,
      fallbackCode: code,
      sensitiveValues: existing.sensitiveValues,
    })];
    const offset = existing.diagnostics.length;
    const appended = diagnostics.map((diagnostic, index) => ({
      ...structuredClone(diagnostic),
      id: `${this.#sessionEpoch}:${operationId}:failure:${offset + index}`,
    }));
    existing.diagnostics.push(...appended);
    const targetDiagnostics = appended.filter((diagnostic) => diagnostic.target !== undefined);
    if (targetDiagnostics.length > 0) {
      existing.targets = [...new Map([
        ...(existing.targets ?? []).map((target) => [[
          target.pluginId ?? '', target.platform, target.scope,
        ].join('\0'), target] as const),
        ...targetDiagnostics.map((diagnostic) => [[
          diagnostic.target!.pluginId ?? '', diagnostic.target!.platform, diagnostic.target!.scope,
        ].join('\0'), {
          ...diagnostic.target!,
          state: 'skipped' as const,
          errorCode: diagnostic.code,
          diagnosticIds: targetDiagnostics.filter((candidate) => candidate.target
            && candidate.target.pluginId === diagnostic.target!.pluginId
            && candidate.target.platform === diagnostic.target!.platform
            && candidate.target.scope === diagnostic.target!.scope).map((candidate) => candidate.id),
        }] as const),
      ]).values()];
    }
  }

  #recordStaleAttempt(operationId: string, intent: OperationIntent): void {
    if (!this.#operationDiagnostics.has(operationId)) {
      this.#captureThrownProjection(
        operationId,
        undefined,
        'operationReviewStale',
        'reviewValidation',
        intent,
      );
    }
    const projected = this.#operationDiagnostics.get(operationId)!;
    const recordId = `${this.#sessionEpoch}:${operationId}`;
    const diagnosticsByTarget = new Map<string, SafeOperationDiagnostic[]>();
    for (const diagnostic of projected.diagnostics) {
      if (!diagnostic.target) continue;
      const key = [diagnostic.target.pluginId ?? '', diagnostic.target.platform, diagnostic.target.scope].join('\0');
      diagnosticsByTarget.set(key, [...(diagnosticsByTarget.get(key) ?? []), diagnostic]);
    }
    const targets = projected.targets ?? [...diagnosticsByTarget.entries()].map(([key, diagnostics]) => {
      const [pluginId, platform, scope] = key.split('\0') as [string, PlatformName, Scope];
      return {
        ...(pluginId ? { pluginId } : {}),
        platform,
        scope,
        state: 'skipped' as const,
        errorCode: diagnostics[0]!.code,
        diagnosticIds: diagnostics.map((diagnostic) => diagnostic.id),
      };
    });
    this.#operationHistory.record({
      summary: {
        recordId,
        epoch: this.#sessionEpoch,
        operationId,
        createdAtMs: this.dependencies.now?.() ?? Date.now(),
        state: 'blocked',
        code: projected.diagnostics[0]?.code ?? 'operationReviewStale',
        message: '状态已变化，原确认没有执行。已准备新的确认信息。',
        operationKind: intent.kind,
        ...('pluginId' in intent ? { pluginId: intent.pluginId } : {}),
        diagnosticCount: projected.diagnostics.length,
        effects: projected.effects,
      },
      diagnostics: projected.diagnostics,
      targets,
    }, { sensitiveValues: projected.sensitiveValues });
    this.#operationDiagnostics.delete(operationId);
  }

  async #logErrorSafe(
    error: unknown,
    code: string,
    context?: { privateConfigOperation: boolean },
  ): Promise<void> {
    try {
      await this.dependencies.logError?.(error, code, context);
    } catch {
      // Diagnostics must not replace the fixed safe Controller result.
    }
  }

  #project(): void {
    if (!this.#status) return;
    this.#viewModel = buildTuiViewModel({
      status: this.#status.payload,
      pluginSummaries: this.#status.pluginSummaries,
      targetRevisions: this.#status.targetRevisions,
      sourceHealth: this.#health,
      sourceDetails: this.#status.sourceDetails,
      catalogFreshness: this.#catalogFreshness,
      catalogGenerations: this.#catalogGenerations,
      dependencyOverviews: this.#status.dependencyOverviews,
      portablePluginIds: this.#status.portablePluginIds,
      configStoreInventory: this.#status.configStoreInventory,
    });
  }

  #normalizeRoute(route: TuiRoute): TuiRoute {
    return normalizeTuiRoute(route, this.#routeEntityState());
  }

  #routeEntityState(): RouteEntityState {
    return {
      hasPlugin: (pluginId) => this.#viewModel?.plugins.some((plugin) => plugin.pluginId === pluginId) ?? false,
      hasSource: (sourceId) => this.#viewModel?.sourceTabs.some((source) => source.id === sourceId) ?? false,
      hasIssue: (issueId) => this.#viewModel?.issues.some((issue) => issue.issueId === issueId) ?? false,
      hasHistoryRecord: (recordId) => this.#operationHistory.get(recordId) !== undefined,
      hasActiveOperation: (candidate) => candidate.name === 'reviewPreparing'
        ? this.#reviewPreparation?.snapshot.id === candidate.preparationId
        : candidate.name === 'result'
          ? this.#result?.operationId === candidate.operationId
          : this.#activeReview?.operationId === candidate.operationId,
    };
  }

  #normalizeCurrentRoute(): void {
    this.#router.normalizeRoutes((route) => this.#normalizeRoute(route));
    if (this.#resultAnchor) this.#resultAnchor = this.#normalizeRoute(this.#resultAnchor);
    for (const ticket of this.#tickets.values()) ticket.returnRoute = this.#normalizeRoute(ticket.returnRoute);
    if (this.#reviewPreparation) {
      this.#reviewPreparation.returnRoute = this.#normalizeRoute(this.#reviewPreparation.returnRoute);
    }
  }

  #ensureOperationFlow(intent: OperationIntent): void {
    const active = this.#router.activeFlow();
    if (intent.kind === 'catalogManagement') {
      if (active?.kind === 'catalogManagement') return;
      this.#router.beginFlow('catalogManagement', this.#router.snapshot.current.route);
      return;
    }
    if (intent.kind === 'pluginWriteTask') {
      if (active?.kind === 'pluginWriteTask') return;
      this.#router.beginFlow('pluginWriteTask', this.#router.snapshot.current.route);
      return;
    }
    if (intent.kind === 'pluginWriteBatch') {
      if (active?.kind === 'batchWrite') return;
      this.#router.beginFlow('batchWrite', { name: 'pluginList', mode: 'installed' });
      return;
    }
    if (intent.kind === 'pluginWrite') {
      const kind = intent.action === 'install' ? 'pluginInstall' : 'pluginMaintenance';
      if (active?.kind === kind) return;
      this.#router.beginPluginFlow(
        kind,
        intent.pluginId,
      );
      return;
    }
    if (intent.kind === 'portableInstall') {
      if (active?.kind === 'portableInstall') return;
      this.#router.beginPortableFlow(intent.pluginId);
      return;
    }
    if (intent.kind === 'configSave' || intent.kind === 'configReset') {
      if (active?.kind === 'configEdit') return;
      const route = this.#router.snapshot.current.route;
      if ((route.name === 'pluginPreview' || route.name === 'pluginDetail')
        && route.pluginId === intent.pluginId) {
        this.#router.beginConfigFlow(intent.pluginId);
      } else {
        this.#router.beginFlow('configEdit', { name: 'pluginDetail', pluginId: intent.pluginId });
      }
      return;
    }
    const kind = intent.kind === 'catalogSourcesRecovery' ? 'sourceRecovery' : 'sourceEdit';
    if (active?.kind === 'sourceRecovery'
      && (intent.kind === 'catalogSourcesRecovery'
        || intent.kind === 'catalogGeneration'
        || intent.kind === 'sourceMutation')) return;
    if (active?.kind === kind) return;
    this.#router.beginFlow(
      kind,
      active ? this.#router.snapshot.current.route
        : intent.kind === 'sourceMutation' && intent.action !== 'remove'
        ? { name: 'sourceDetail', sourceId: intent.sourceId }
        : intent.kind === 'catalogGeneration'
          ? this.#router.snapshot.current.route.name === 'pluginWriteTask'
            ? this.#router.snapshot.current.route
            : { name: 'sourceDetail', sourceId: intent.sourceId }
          : { name: 'sourceList' },
    );
  }

  #stableResultRoute(intent: OperationIntent, result: OperationExecuteResult): TuiRoute {
    const active = this.#router.activeFlow();
    if (intent.kind === 'pluginWriteTask'
      && result.state === 'succeeded'
      && 'returnRoute' in result
      && result.returnRoute?.name === 'pluginWriteTask'
      && result.returnRoute.goal === result.summary.task?.goal
      && result.returnRoute.batchOrigin?.owner === 'batch-write') {
      return { name: 'pluginList', mode: 'installed' };
    }
    if (active?.parentFlowId) return this.#normalizeRoute(active.returnTarget);
    if (active && (intent.kind === 'portableInstall'
      || intent.kind === 'configSave' || intent.kind === 'configReset')) {
      return this.#normalizeRoute(active.returnTarget);
    }
    if (intent.kind === 'pluginWrite') {
      if (intent.originIssue && result.state === 'succeeded') return { name: 'issueList' };
      return this.#normalizeRoute({ name: 'pluginDetail', pluginId: intent.pluginId });
    }
    if (intent.kind === 'pluginWriteBatch') return { name: 'pluginList', mode: 'installed' };
    if (intent.kind === 'pluginWriteTask') return { name: 'pluginList', mode: 'installed' };
    if (intent.kind === 'portableInstall' || intent.kind === 'configSave' || intent.kind === 'configReset') {
      return this.#normalizeRoute({ name: 'pluginDetail', pluginId: intent.pluginId });
    }
    if (intent.kind === 'sourceMutation' && intent.action === 'update') {
      return this.#normalizeRoute({ name: 'sourceDetail', sourceId: intent.sourceId });
    }
    if (intent.kind === 'catalogGeneration') {
      if ('returnRoute' in result && result.returnRoute?.name === 'pluginWriteTask') {
        return this.#normalizeRoute(result.returnRoute);
      }
      return this.#normalizeRoute({ name: 'sourceDetail', sourceId: intent.sourceId });
    }
    if (intent.kind === 'catalogManagement') {
      if (intent.action === 'devActivate' || intent.action === 'devDeactivate') {
        return { name: 'catalogDev', step: 'overview' };
      }
      if (intent.action === 'storePrune') return { name: 'catalogStore' };
      if (intent.action === 'publishPlan' || intent.action === 'publishApply') {
        return { name: 'catalogPublish', step: 'overview' };
      }
      return { name: 'catalogWorkspace', view: 'overview' };
    }
    return { name: 'sourceList' };
  }

  #showResult(result: OperationExecuteResult, intent: OperationIntent): void {
    const terminal = { name: 'result' as const, operationId: result.operationId };
    const target = this.#stableResultRoute(intent, result);
    this.#resultAnchor = structuredClone(target);
    this.#cancelReviewPreparation();
    this.#progress = { messages: [] };
    this.#progressTargets = [];
    this.#recoverableInstallPlacementDraft = result.state === 'blocked'
      && intent.kind === 'pluginWrite' && intent.action === 'install'
      && this.#installPlacementDraft?.pluginId === intent.pluginId
      ? structuredClone(this.#installPlacementDraft)
      : undefined;
    this.#installPlacementDraft = undefined;
    this.#recoverablePortableDraft = result.state !== 'succeeded'
      && intent.kind === 'portableInstall'
      && this.#portableDraft?.pluginId === intent.pluginId
      ? structuredClone(this.#portableDraft)
      : undefined;
    this.#portableResultSkills = intent.kind === 'portableInstall'
      ? this.#portableDraft?.candidates
        .filter((candidate) => candidate.selected)
        .map((candidate) => candidate.name)
      : undefined;
    this.#portableDraft = undefined;
    this.#batchRetryIntent = intent.kind === 'pluginWriteBatch'
      && 'summary' in result
      && result.summary?.batch
      && (result.summary.batch.retryTargets?.length ?? 0) > 0
      ? {
          ...structuredClone(intent),
          selection: {
            kind: 'targets',
            targets: structuredClone(result.summary.batch.retryTargets!),
          },
      }
      : undefined;
    this.#taskRetryIntent = intent.kind === 'pluginWriteTask'
      && 'summary' in result
      && result.summary?.task
      && (result.summary.task.retryTargets?.length ?? 0) > 0
      ? {
          ...structuredClone(intent),
          targets: result.summary.task.retryTargets!.map((target) => {
            const current = this.listPluginWriteTaskCandidates(intent.goal).find((candidate) =>
              pluginWriteTaskTargetKey(candidate.target) === pluginWriteTaskTargetKey(target));
            return structuredClone(current?.eligible ? current.target : target);
          }),
          executionPolicy: 'all',
        }
      : undefined;
    const batchFlowId = result.state === 'succeeded'
      && intent.kind === 'pluginWriteTask'
      && 'returnRoute' in result
      && result.returnRoute?.name === 'pluginWriteTask'
      && result.returnRoute.goal === result.summary.task?.goal
      && result.returnRoute.batchOrigin?.owner === 'batch-write'
      ? result.returnRoute.batchOrigin.flowId
      : undefined;
    const finished = batchFlowId
      ? this.#router.finishFlowById(batchFlowId, 'batchWrite', target, terminal)
      : this.#router.finishFlow(target, terminal);
    if (!finished) this.#router.replace(terminal);
  }

  #applyStatus(status: TuiStatusLoadResult): void {
    this.#status = structuredClone(status);
    this.#statusReadAtMs = this.dependencies.now?.() ?? Date.now();
    if (status.catalogGenerations) {
      this.#catalogGenerations.clear();
      for (const source of status.catalogGenerations) {
        this.#catalogGenerations.set(source.sourceId, structuredClone(source));
      }
    }
    this.#sessionGenerationKeys.clear();
    if (status.sessionGenerationKeys) {
      for (const [sourceId, generationKey] of Object.entries(status.sessionGenerationKeys)) {
        this.#sessionGenerationKeys.set(sourceId, generationKey);
      }
    }
    this.#health.clear();
    for (const source of status.payload.catalog.sources) {
      this.#health.set(source.id, {
        sourceId: source.id,
        state: source.error ? 'unavailable'
          : 'ready',
        ...(source.error ? { message: '来源当前没有可用数据。' } : {}),
      });
      if (!this.#catalogFreshness.has(source.id)) {
        this.#catalogFreshness.set(source.id, { sourceId: source.id, state: 'notChecked' });
      }
    }
    const configuredSourceIds = new Set(status.payload.catalog.sources.map((source) => source.id));
    for (const sourceId of this.#catalogFreshness.keys()) {
      if (configuredSourceIds.has(sourceId)) continue;
      this.#catalogFreshness.delete(sourceId);
    }
    const details = new Map((status.sourceDetails ?? []).map((detail) => [detail.id, detail]));
    this.#catalogSourcesSession.configure(status.payload.catalog.sources.map((source) => {
      const generation = this.#catalogGenerations.get(source.id);
      const detail = details.get(source.id);
      const probeFingerprint = JSON.stringify({
        sourceIdentity: source.identity,
        requestedRef: source.requestedRef,
      });
      return {
        sourceId: source.id,
        primary: source.primary,
        autoCheck: this.dependencies.probeCatalogFreshness !== undefined
          && (detail?.autoCheck ?? true),
        probeFingerprint,
        fingerprint: JSON.stringify({
          probeFingerprint,
          activeStoreKey: generation?.active?.storeKey,
          generationState: generation?.state,
          generationErrorCode: generation?.errorCode,
        }),
        fixedCommit: generation?.state === 'ready'
          && generation.active !== undefined
          && detail?.type === 'git'
          && detail.refPolicy === 'explicit'
          && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(detail.explicitRef ?? ''),
      };
    }));
    this.#project();
    this.#normalizeCurrentRoute();
  }

  async load(): Promise<void> {
    this.#assertAcceptingActions();
    this.dependencies.beginCatalogSession?.();
    const generation = ++this.#generation;
    this.#phase = 'loading';
    this.#publish();
    let status: TuiStatusLoadResult;
    try {
      status = await this.#trackRead(this.dependencies.loadStatus(this.#abort.signal));
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      const code = issueCode(error);
      await this.#logErrorSafe(error, code);
      this.#phase = 'error';
      this.#loadError = { code, message: '无法安全读取插件状态。请检查诊断后重试或退出。' };
      this.#recordStandaloneFailure(code, 'statusReload', error);
      this.#publish();
      return;
    }
    if (this.#disposed || generation !== this.#generation) return;
    this.#applyStatus(status);
    this.#phase = 'ready';
    this.#loadError = undefined;
    this.#publish();
  }

  push(route: TuiRoute, context?: TuiPageContext): void {
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    this.#discardPortableDraftForRoute(route);
    if ((route.name === 'sourceAdd' || route.name === 'sourceEdit' || route.name === 'sourceSave')
      && this.#router.activeFlow()?.kind !== 'sourceEdit') {
      this.#router.beginFlow('sourceEdit', this.#router.snapshot.current.route);
    }
    this.#router.push(route, context);
    this.#publish();
  }

  hasPortableSkills(pluginId: string): boolean {
    return this.#status?.portablePluginIds?.includes(pluginId) ?? false;
  }

  preparePortableInstall(
    pluginId: string,
    navigation: 'push' | 'replace' = 'push',
  ): Promise<PortableSkillSelectionViewModel> {
    this.#assertAcceptingActions();
    if (!this.hasPortableSkills(pluginId)) {
      throw new TuiOperationBlockedError('portableUnsupported', '插件不提供通用 Skills。');
    }
    this.#router.beginPortableFlow(pluginId);
    const expectedRoute = this.#router.snapshot.current.route;
    return this.#runPortableRequest(`prepare:${pluginId}`, async (signal, token) => {
      const draft = await this.#buildPortableDraft(pluginId, false, signal);
      this.#assertPortableRequestCurrent(token, expectedRoute);
      this.#portableDraft = draft;
      this.#router[navigation]({ name: 'portableSkillSelect', pluginId });
      this.#publish();
      return cloneFrozen(draft);
    });
  }

  refreshPortableInstallDraft(pluginId: string): Promise<PortableSkillSelectionViewModel> {
    this.#assertAcceptingActions();
    const expectedRoute = this.#router.snapshot.current.route;
    return this.#runPortableRequest(`refresh:${pluginId}`, async (signal, token) => {
      const draft = await this.#buildPortableDraft(pluginId, true, signal);
      this.#assertPortableRequestCurrent(token, expectedRoute);
      this.#portableDraft = draft;
      this.#publish();
      return cloneFrozen(draft);
    });
  }

  async #buildPortableDraft(
    pluginId: string,
    preserveSelection: boolean,
    signal: AbortSignal,
  ): Promise<NonNullable<TuiControllerSnapshot['portableDraft']>> {
    const previous = preserveSelection && this.#portableDraft?.pluginId === pluginId
      ? this.#portableDraft
      : undefined;
    const prepared = await Promise.allSettled((['project', 'user'] as const).map(async (scope) => ({
      scope,
      evidence: await this.#trackRead(this.dependencies.captureEvidence({
        kind: 'portableInstall',
        pluginId,
        scope,
        selectedSkills: [],
      }, signal)),
    })));
    const available = prepared.flatMap((entry) =>
      entry.status === 'fulfilled' && entry.value.evidence.portable ? [entry.value] : []);
    if (available.length === 0) {
      const failure = prepared.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
      if (failure) throw failure.reason;
      throw new TuiOperationBlockedError('portablePrepareFailed', '无法准备通用 Skills。');
    }
    const merged = new Map<string, PortableSkillCandidateViewModel>();
    for (const { scope, evidence } of available) {
      for (const candidate of evidence.portable!.selected) {
        const current = merged.get(candidate.name);
        const scopeDetail = {
          description: candidate.description,
          providerPluginId: candidate.providerPluginId,
          providerDisplayName: candidate.providerDisplayName,
          relation: candidate.relation,
          dynamic: candidate.dynamic,
          filesDigest: candidate.filesDigest,
        };
        if (current) {
          current.availableScopes.push(scope);
          current.scopeDetails[scope] = scopeDetail;
          continue;
        }
        merged.set(candidate.name, {
          ...candidate,
          selected: true,
          availableScopes: [scope],
          scopeDetails: { [scope]: scopeDetail },
        });
      }
    }
    const selectedNames = new Set(previous?.candidates
      .filter((candidate) => candidate.selected)
      .map((candidate) => candidate.name) ?? []);
    const candidates = [...merged.values()].map((candidate) => ({
      ...candidate,
      selected: previous ? selectedNames.has(candidate.name) : true,
    }));
    const dependencies = this.getPluginDependencyOverview(pluginId);
    const selectedCount = candidates.filter((candidate) => candidate.selected).length;
    return {
      pluginId,
      candidates,
      selectedCount,
      totalCount: candidates.length,
      canContinue: selectedCount > 0,
      ...(dependencies ? { dependencySummary: {
        directCount: dependencies.summary.directCount,
        transitiveCount: dependencies.summary.transitiveCount,
        contributingSkillCount: candidates.filter((candidate) => candidate.relation !== 'requested').length,
      } } : {}),
      agentMode: previous?.agentMode ?? 'automatic',
      requestedAgents: previous?.requestedAgents ?? [],
      scope: previous?.scope ?? 'project',
    };
  }

  togglePortableSkill(name: string): void {
    if (!this.#portableDraft) return;
    this.#portableDraft.candidates = this.#portableDraft.candidates.map((candidate) =>
      candidate.name === name ? { ...candidate, selected: !candidate.selected } : candidate);
    this.#portableDraft.selectedCount = this.#portableDraft.candidates.filter((candidate) => candidate.selected).length;
    this.#portableDraft.canContinue = this.#portableDraft.selectedCount > 0;
    this.#publish();
  }

  selectAllPortableSkills(): void {
    if (!this.#portableDraft) return;
    this.#portableDraft.candidates = this.#portableDraft.candidates.map((candidate) => ({ ...candidate, selected: true }));
    this.#portableDraft.selectedCount = this.#portableDraft.totalCount;
    this.#portableDraft.canContinue = this.#portableDraft.totalCount > 0;
    this.#publish();
  }

  setPortableAgentMode(mode: 'automatic' | 'explicit', requestedAgents: string[] = []): void {
    if (!this.#portableDraft) return;
    this.#portableDraft.agentMode = mode;
    this.#portableDraft.requestedAgents = [...requestedAgents];
    this.#publish();
  }

  setPortableScope(scope: Scope): void {
    if (!this.#portableDraft) return;
    this.#portableDraft.scope = scope;
    this.#publish();
  }

  async buildPortableInstallReview(): Promise<OperationReviewModel> {
    const intent = this.#portableInstallIntent();
    const draft = this.#portableDraft!;
    const expectedRoute = this.#router.snapshot.current.route;
    return this.#runPortableRequest(`review:${JSON.stringify(intent)}`, async (signal, token) => {
      const evidence = await this.dependencies.captureEvidence(structuredClone(intent), signal);
      this.#assertPortableRequestCurrent(token, expectedRoute);
      return this.#storeOperationReview(
        intent,
        evidence,
        'push',
        this.#router.portableOrigin(draft.pluginId),
      );
    });
  }

  #portableInstallIntent(): Extract<OperationIntent, { kind: 'portableInstall' }> {
    const draft = this.#portableDraft;
    if (!draft?.canContinue) {
      throw new TuiOperationBlockedError('portableNoSkillsSelected', '至少选择一个 Skill。');
    }
    const unavailable = draft.candidates.filter((candidate) =>
      candidate.selected && !candidate.availableScopes.includes(draft.scope));
    if (unavailable.length > 0) {
      throw new TuiOperationBlockedError(
        'portableScopeUnavailable',
        `所选范围不提供这些 Skill：${unavailable.map((candidate) => candidate.name).join(', ')}。请返回 Skill 选择或更改范围。`,
      );
    }
    return {
      kind: 'portableInstall',
      pluginId: draft.pluginId,
      scope: draft.scope,
      selectedSkills: draft.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.name),
      ...(draft.agentMode === 'explicit' ? { requestedAgents: draft.requestedAgents } : {}),
    };
  }

  startPortableInstallReviewPreparation(): ReviewPreparationSnapshot {
    const intent = this.#portableInstallIntent();
    return this.startReviewPreparation(intent, this.#router.portableOrigin(intent.pluginId));
  }

  discardPortableDraft(): void {
    this.#cancelPortableRequest();
    this.#portableDraft = undefined;
    this.#publish();
  }

  replace(route: TuiRoute, context?: TuiPageContext): void {
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    const current = this.#router.snapshot.current.route;
    if (current.name === 'portableBlocker' && current.code === 'requiredConfigMissing'
      && route.name === 'configLayer' && route.pluginId === current.pluginId) {
      this.#portableRepreparePluginId = current.pluginId;
    }
    this.#discardPortableDraftForRoute(route);
    this.#router.replace(route, context);
    this.#publish();
  }

  beginConfigFlow(pluginId: string): void {
    this.#router.beginConfigFlow(pluginId);
    this.#router.push({
      name: 'configFields',
      pluginId,
      layer: { scope: 'effective' },
    });
    this.#publish();
  }

  beginSavedConfigRecovery(pluginId: string): void {
    this.#assertAcceptingActions();
    const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
    if (!plugin?.configOnly || plugin.savedConfigScopes.length === 0) {
      throw new TuiOperationBlockedError('savedConfigUnavailable', '没有可识别的已保存设置。');
    }
    this.#router.beginConfigFlow(pluginId);
    this.#router.push({
      name: 'configUnavailable',
      pluginId,
      storedScopes: plugin.savedConfigScopes,
      ...(plugin.savedConfigScopes.length === 1
        ? { layer: { scope: plugin.savedConfigScopes[0]! } }
        : {}),
      diagnosticCode: 'catalogSourceUnavailable',
      diagnosticStage: 'read-config',
    });
    this.#publish();
  }

  beginConfigSourceRecovery(sourceId: string): void {
    this.#assertAcceptingActions();
    const route = this.#router.snapshot.current.route;
    const active = this.#router.activeFlow();
    if (route.name !== 'configUnavailable'
      || active?.kind !== 'configEdit'
      || route.storedScopes !== undefined
      || sourceIdFromPluginId(route.pluginId) !== sourceId
      || !this.#viewModel?.sourceTabs.some((source) => source.id === sourceId)) {
      throw new TuiOperationBlockedError(
        'configSourceRecoveryUnavailable',
        '来源恢复只能从不可用的设置流程开始。',
      );
    }
    const layer = route.layer?.scope ?? route.resumeRoute?.layer.scope ?? 'effective';
    const returnTarget: ConfigResumeRoute = route.resumeRoute ?? {
      name: 'configFields',
      pluginId: route.pluginId,
      layer: { scope: layer },
    };
    this.#router.beginFlow('sourceRecovery', returnTarget, undefined, route.resumeContext);
    this.#router.push({ name: 'sourceDetail', sourceId });
    this.#publish();
  }

  async getForceCleanupCandidate(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): Promise<ForceCleanupCandidate | undefined> {
    this.#assertAcceptingActions();
    const intent: Extract<OperationIntent, { kind: 'pluginWrite' }> = {
      kind: 'pluginWrite', action: 'cleanup', pluginId, platform, scope, force: true,
    };
    try {
      const evidence = await this.#trackRead(this.dependencies.captureEvidence(intent, this.#abort.signal));
      const candidate = (evidence.offlineCleanupPlans
        ?? (evidence.offlineCleanup ? [evidence.offlineCleanup] : [])).find((entry) =>
        entry.pluginId === pluginId
        && entry.platform === platform
        && entry.scope === scope);
      if (!evidence.operationPlan
        || !candidate
        || candidate.platform !== platform
        || candidate.scope !== scope
        || (candidate.forceExclusive !== true && candidate.plan.actions.length > 0)
        || (candidate.plan.actions.length === 0
          && !evidence.operationPlan.intentChanges.some((change) => change.scope === scope))) {
        return undefined;
      }
      return cloneFrozen({ pluginId, platform, scope, actionCount: candidate.plan.actions.length });
    } catch (error) {
      await this.#logOperationError(error, issueCode(error), intent);
      return undefined;
    }
  }

  startForceCleanupReview(candidate: ForceCleanupCandidate): ReviewPreparationSnapshot {
    return this.startReviewPreparation({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: candidate.pluginId,
      platform: candidate.platform,
      scope: candidate.scope,
      force: true,
    });
  }

  configOrigin(pluginId: string): TuiRoute | undefined {
    const origin = this.#router.configOrigin(pluginId);
    if (origin) return origin;
    if (this.#router.snapshot.current.route.name === 'result'
      && this.#resultAnchor
      && (this.#resultAnchor.name === 'pluginPreview' || this.#resultAnchor.name === 'pluginDetail'
        || this.#resultAnchor.name === 'pluginWriteTask')
      && (this.#resultAnchor.pluginId === pluginId
        || this.#resultAnchor.name === 'pluginWriteTask'
          && this.#resultAnchor.targetKeys?.some((key) => key.startsWith(`${pluginId}\0`)))) {
      return structuredClone(this.#resultAnchor);
    }
    return undefined;
  }

  updatePageContext(context: Partial<TuiPageContext>): void {
    this.#router.updateContext(context);
    this.#publish();
  }

  back(): void {
    const route = this.#router.snapshot.current.route;
    const activeFlow = this.#router.activeFlow();
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    if (route.name === 'review' && this.#activeReview?.operationId === route.operationId) {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    this.#router.back();
    if (activeFlow
      && this.#router.snapshot.currentFrameId === activeFlow.originFrameId) {
      this.#router.abandonFlow(activeFlow.id);
      if (activeFlow.kind === 'pluginInstall') this.#installPlacementDraft = undefined;
      if (activeFlow.kind === 'portableInstall') this.#portableDraft = undefined;
    }
    this.#normalizeCurrentRoute();
    this.#discardPortableDraftForRoute(this.#router.snapshot.current.route);
    this.#publish();
  }

  discardSourceDraft(
    owner: string,
    returnRoute: Extract<TuiRoute, { name: 'sourceList' | 'sourceDetail' }>,
  ): void {
    if (this.#activeReview?.operationKind === 'sourceMutation') {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    this.#result = undefined;
    const activeFlow = this.#router.activeFlow();
    if (activeFlow?.kind === 'sourceEdit') {
      this.#router.abandonFlow(activeFlow.id);
      if (JSON.stringify(this.#router.snapshot.current.route) !== JSON.stringify(returnRoute)) {
        this.#router.replace(returnRoute);
      }
    } else {
      this.#router.discardSourceFlow(owner, returnRoute);
    }
    this.#normalizeCurrentRoute();
    this.#publish();
  }

  leaveResult(target?: TuiRoute): void {
    if (this.#router.snapshot.current.route.name !== 'result') return;
    if (target?.name === 'home') {
      this.#router.resetToRoot();
      this.#portableDraft = undefined;
      this.#recoverablePortableDraft = undefined;
      this.#installPlacementDraft = undefined;
      this.#recoverableInstallPlacementDraft = undefined;
      this.#result = undefined;
      this.#resultAnchor = undefined;
      this.#portableResultSkills = undefined;
      this.#publish();
      return;
    }
    if (this.#result?.operationKind === 'portableInstall'
      && 'pluginId' in this.#result && this.#result.pluginId) {
      const preserveDraft = target?.name === 'portableSkillSelect'
        || target?.name === 'portableAgentInput';
      this.resetPortableFlowToPreview(this.#result.pluginId, target, preserveDraft);
      return;
    }
    if (this.#result?.state === 'succeeded'
      && (this.#result.operationKind === 'configSave' || this.#result.operationKind === 'configReset')
      && this.#result.pluginId
      && this.#router.resetConfigFlow(this.#result.pluginId, target)) {
      this.#result = undefined;
      this.#publish();
      return;
    }
    this.#router.back();
    if (target) this.#router.replace(this.#normalizeRoute(target));
    else this.#normalizeCurrentRoute();
    this.#discardPortableDraftForRoute(this.#router.snapshot.current.route);
    this.#result = undefined;
    this.#resultAnchor = undefined;
    this.#portableResultSkills = undefined;
    this.#recoverableInstallPlacementDraft = undefined;
    this.#recoverablePortableDraft = undefined;
    this.#publish();
  }

  resumeResultDraft(): void {
    const result = this.#result;
    if (this.#router.snapshot.current.route.name !== 'result' || !result
      || !('returnRoute' in result) || !result.returnRoute) return;
    const returnRoute = this.#normalizeRoute(result.returnRoute);
    this.#router.back();
    const kind = result.operationKind === 'configSave' || result.operationKind === 'configReset'
      ? 'configEdit' as const
      : result.operationKind === 'portableInstall'
        ? 'portableInstall' as const
        : result.operationKind === 'sourceMutation' || result.operationKind === 'catalogGeneration'
          || result.operationKind === 'catalogSourcesRecovery'
          ? 'sourceEdit' as const
          : 'pluginMaintenance' as const;
    this.#router.beginFlow(kind, this.#router.snapshot.current.route);
    if (result.operationKind === 'pluginWrite') {
      this.#installPlacementDraft = this.#recoverableInstallPlacementDraft;
    }
    if (result.operationKind === 'portableInstall') {
      this.#portableDraft = this.#recoverablePortableDraft;
    }
    this.#router.push(returnRoute);
    this.#recoverableInstallPlacementDraft = undefined;
    this.#recoverablePortableDraft = undefined;
    this.#result = undefined;
    this.#resultAnchor = undefined;
    this.#portableResultSkills = undefined;
    this.#publish();
  }

  #discardPortableDraftForRoute(route: TuiRoute): void {
    const readOnlyHistoryRoute = route.name === 'operationHistory'
      || route.name === 'operationDiagnostic'
      || route.name === 'operationReportPreview';
    if (readOnlyHistoryRoute && this.#router.activeFlow()?.kind === 'portableInstall') return;
    const portableRoute = route.name === 'portableSkillSelect'
      || route.name === 'portableDependencies'
      || route.name === 'portableAgentMode'
      || route.name === 'portableAgentInput'
      || route.name === 'portableScope'
      || route.name === 'portableBlocker';
    const portableOperationRoute = (route.name === 'reviewPreparing' || route.name === 'review'
      || route.name === 'progress' || route.name === 'result')
      && (this.#reviewPreparation !== undefined
        && this.#reviewPreparationIntents.get(this.#reviewPreparation.snapshot.id)?.kind === 'portableInstall'
        || this.#activeReview?.operationKind === 'portableInstall'
        || this.#result?.operationKind === 'portableInstall');
    if (!portableRoute && !portableOperationRoute) {
      this.#cancelPortableRequest();
      this.#portableDraft = undefined;
    }
  }

  resetPortableFlowToPreview(
    pluginId: string,
    target?: TuiRoute,
    preserveDraft = false,
  ): void {
    this.#cancelPortableRequest();
    if (preserveDraft && !this.#portableDraft) {
      this.#portableDraft = this.#recoverablePortableDraft;
    }
    if (!preserveDraft) this.#portableDraft = undefined;
    this.#recoverablePortableDraft = undefined;
    if (this.#activeReview?.operationKind === 'portableInstall') {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    if (this.#result?.operationKind === 'portableInstall') this.#result = undefined;
    this.#resultAnchor = undefined;
    this.#portableResultSkills = undefined;
    if (this.#router.snapshot.current.route.name === 'result') this.#router.back();
    else this.#router.resetPortableFlow(pluginId);
    if (target && JSON.stringify(this.#router.snapshot.current.route) !== JSON.stringify(target)) {
      this.#router.beginPortableFlow(pluginId);
      this.#router.push(this.#normalizeRoute(target));
    }
    this.#publish();
  }

  #cancelPortableRequest(): void {
    this.#portableRequestToken += 1;
    this.#portableRequestAbort?.abort();
    this.#portableRequestAbort = undefined;
    this.#portablePending = undefined;
  }

  #runPortableRequest<T>(
    key: string,
    action: (signal: AbortSignal, token: number) => Promise<T>,
  ): Promise<T> {
    if (this.#portablePending?.key === key) {
      return this.#portablePending.promise as Promise<T>;
    }
    this.#cancelPortableRequest();
    const abort = new AbortController();
    this.#portableRequestAbort = abort;
    const token = this.#portableRequestToken;
    const signal = AbortSignal.any([this.#abort.signal, abort.signal]);
    const promise = action(signal, token).finally(() => {
      if (this.#portableRequestToken === token) {
        this.#portableRequestAbort = undefined;
        this.#portablePending = undefined;
      }
    });
    this.#portablePending = { key, promise };
    return promise;
  }

  #assertPortableRequestCurrent(token: number, expectedRoute: TuiRoute): void {
    if (this.#disposed || this.#abort.signal.aborted || token !== this.#portableRequestToken
      || JSON.stringify(this.#router.snapshot.current.route) !== JSON.stringify(expectedRoute)) {
      throw new DOMException('Portable request was cancelled.', 'AbortError');
    }
  }

  beginInstallFlow(
    pluginId: string,
    rootScope: Scope,
  ): void {
    this.#cancelInstallPlacementRequest();
    const active = this.#router.activeFlow();
    if (active?.kind !== 'pluginInstall') this.#router.beginPluginFlow('pluginInstall', pluginId);
    this.#installPlacementDraft = {
      pluginId,
      rootScope,
      platforms: [],
      dependencyScopeOverrides: [],
      state: 'selecting',
      targets: [],
      canContinue: false,
    };
    this.#publish();
  }

  setInstallRootScope(rootScope: Scope): void {
    const draft = this.#installPlacementDraft;
    if (!draft) return;
    this.#cancelInstallPlacementRequest();
    draft.rootScope = rootScope;
    draft.platforms = [];
    draft.plan = undefined;
    draft.targets = [];
    draft.state = 'selecting';
    draft.canContinue = false;
    draft.error = undefined;
    this.#publish();
  }

  setInstallPlatforms(platforms: PlatformName[]): void {
    const draft = this.#installPlacementDraft;
    if (!draft) return;
    this.#cancelInstallPlacementRequest();
    const selected = [...new Set(platforms)].sort();
    draft.platforms = selected;
    draft.dependencyScopeOverrides = draft.dependencyScopeOverrides.filter((override) =>
      selected.includes(override.platform));
    draft.plan = undefined;
    draft.targets = [];
    draft.state = 'selecting';
    draft.canContinue = selected.length > 0;
    draft.error = undefined;
    this.#publish();
  }

  #cancelInstallPlacementRequest(): void {
    const cancelled = this.#installPlacementRequestAbort !== undefined;
    this.#installPlacementRequestToken += 1;
    this.#installPlacementRequestAbort?.abort();
    this.#installPlacementRequestAbort = undefined;
    if (cancelled && this.#installPlacementDraft?.state === 'loading') {
      this.#installPlacementDraft.plan = undefined;
      this.#installPlacementDraft.targets = [];
      this.#installPlacementDraft.state = 'selecting';
      this.#installPlacementDraft.canContinue = false;
      this.#installPlacementDraft.error = undefined;
    }
  }

  #installPlacementIntent(): Extract<OperationIntent, { kind: 'pluginWrite' }> {
    const draft = this.#installPlacementDraft;
    if (!draft || draft.platforms.length === 0) {
      throw new TuiOperationBlockedError('installPlacementIncomplete', '请先明确选择目标平台。');
    }
    return {
      kind: 'pluginWrite',
      action: 'install',
      pluginId: draft.pluginId,
      platform: draft.platforms.length === 2 ? 'both' : draft.platforms[0]!,
      scope: draft.rootScope,
      ...(draft.dependencyScopeOverrides.length > 0
        ? { dependencyScopeOverrides: draft.dependencyScopeOverrides }
        : {}),
    };
  }

  async prepareInstallDependencyPlacement(): Promise<boolean> {
    this.#assertAcceptingActions();
    const draft = this.#installPlacementDraft;
    if (!draft) throw new TuiOperationBlockedError('installPlacementMissing', '安装位置草稿不存在。');
    this.#cancelInstallPlacementRequest();
    const abort = new AbortController();
    this.#installPlacementRequestAbort = abort;
    const token = this.#installPlacementRequestToken;
    draft.state = 'loading';
    draft.canContinue = false;
    draft.error = undefined;
    this.#publish();
    try {
      const signal = AbortSignal.any([this.#abort.signal, abort.signal]);
      const preview = async (
        intent: Extract<OperationIntent, { kind: 'pluginWrite' }>,
      ): Promise<ReconcileOperationPlan | undefined> => this.dependencies.previewDependencyPlacement
        ? this.dependencies.previewDependencyPlacement(structuredClone(intent), signal)
        : (await this.dependencies.captureEvidence(structuredClone(intent), signal)).dependencyPlan;
      const throwIfCancelled = (): void => {
        if (this.#disposed || token !== this.#installPlacementRequestToken || abort.signal.aborted) {
          throw new DOMException('Dependency placement preview was cancelled.', 'AbortError');
        }
      };
      const plan = await this.#trackRead(preview(this.#installPlacementIntent()));
      throwIfCancelled();
      if (!plan) {
        draft.state = 'ready';
        draft.plan = undefined;
        draft.targets = [];
        draft.canContinue = true;
        this.#publish();
        return false;
      }
      draft.plan = structuredClone(plan);
      draft.targets = dependencyPlacementTargets(plan);
      const blocker = plan.targets.find((target) => target.action === 'block');
      draft.state = blocker ? 'blocked' : 'ready';
      draft.canContinue = !blocker;
      draft.error = blocker
        ? {
            code: blocker.errorCode ?? 'dependencyPlacementBlocked',
            message: '依赖位置不能满足所选根插件和目标平台。',
          }
        : undefined;
      this.#publish();
      return draft.targets.some((target) => !target.locked);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const code = issueCode(error);
      draft.state = 'blocked';
      draft.canContinue = false;
      draft.error = { code, message: '无法计算可信的依赖位置。请返回检查选择。' };
      this.#publish();
      throw error;
    } finally {
      if (token === this.#installPlacementRequestToken) {
        this.#installPlacementRequestAbort = undefined;
      }
    }
  }

  async setDependencyScope(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): Promise<void> {
    const draft = this.#installPlacementDraft;
    const target = draft?.targets.find((entry) =>
      entry.pluginId === pluginId && entry.platform === platform);
    if (!draft || !target) {
      throw new TuiOperationBlockedError('dependencyScopeOverrideInvalid', '这个依赖不支持所选位置。');
    }
    draft.dependencyScopeOverrides = [
      ...draft.dependencyScopeOverrides.filter((override) =>
        override.pluginId !== pluginId || override.platform !== platform),
      { pluginId, platform, scope },
    ].sort((left, right) => `${left.pluginId}\0${left.platform}`
      .localeCompare(`${right.pluginId}\0${right.platform}`, 'en'));
    await this.prepareInstallDependencyPlacement();
  }

  async resetDependencyScopes(): Promise<void> {
    const draft = this.#installPlacementDraft;
    if (!draft) return;
    draft.dependencyScopeOverrides = [];
    await this.prepareInstallDependencyPlacement();
  }

  installPlacementIntent(): Extract<OperationIntent, { kind: 'pluginWrite' }> {
    return this.#installPlacementIntent();
  }

  listPlugins(options: {
    mode: 'browse' | 'installed';
    sourceId?: string;
    query?: string;
    installFilter?: PluginInstallFilter;
  }): PluginListItemViewModel[] {
    const query = options.query?.trim().toLocaleLowerCase('en');
    return cloneFrozen((this.#viewModel?.plugins ?? []).filter((plugin) =>
      (!options.sourceId || plugin.sourceId === options.sourceId)
      && (options.mode === 'browse' || hasInstalledPlacement(plugin) || plugin.savedConfigScopes.length > 0)
      && (options.installFilter !== 'uninstalled' || !hasInstalledPlacement(plugin))
      && (options.installFilter !== 'updateAvailable' || plugin.update?.state === 'available')
      && (!query || `${plugin.displayName}\n${plugin.description}\n${plugin.sourceId}`.toLocaleLowerCase('en').includes(query))));
  }

  getPluginOverview(pluginId: string): PluginListItemViewModel | undefined {
    const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
    return plugin ? cloneFrozen(plugin) : undefined;
  }

  getPluginSourceIdentity(pluginId: string): string | undefined {
    return flattenStatusTargets(this.#status?.payload.targets ?? []).find((target) =>
      target.pluginId === pluginId)?.sourceIdentity;
  }

  listCurrentProjectIntentRoots(): string[] {
    return cloneFrozen([...new Set(flattenStatusTargets(this.#status?.payload.targets ?? []).flatMap((target) => {
      const intent = statusTargetIntent(target);
      return intent.relation === 'root' && intent.scopes.includes('project')
        ? [target.pluginId] : [];
    }))].sort((left, right) => left.localeCompare(right, 'en')));
  }

  listPluginWriteBatchTargets(
    action: Exclude<BatchPluginWriteAction, 'install'>,
    pluginIds: readonly string[],
  ): PluginWriteBatchTarget[] {
    return cloneFrozen(pluginWriteBatchTargets(
      action,
      pluginIds,
      flattenStatusTargets(this.#status?.payload.targets ?? []),
    ));
  }

  listPluginInstallBatchTargets(
    pluginIds: readonly string[],
    platform: PlatformName | 'both',
    scope: Scope,
  ): PluginInstallBatchTarget[] {
    const platforms = platform === 'both' ? ['codex', 'claude'] as const : [platform];
    return cloneFrozen([...new Set(pluginIds)].flatMap((pluginId) => {
      const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
      return platforms.map((targetPlatform): PluginInstallBatchTarget => {
        const target = { pluginId, platform: targetPlatform, scope };
        const statusTargets = flattenStatusTargets(this.#status?.payload.targets ?? []).filter((entry) =>
          entry.pluginId === pluginId && entry.platform === targetPlatform);
        const exactTarget = statusTargets.find((entry) => entry.scope === scope);
        const alreadyConfigured = statusTargets.some((entry) => {
          const activation = statusTargetActivation(entry);
          return statusTargetIntent(entry).scopes.includes(scope)
            || (targetPlatform === 'codex'
              && activation?.evidence === 'observed'
              && activation[scope] === true);
        });
        const exactOwnership = exactTarget ? statusTargetOwnershipState(exactTarget) : 'absent';
        if (alreadyConfigured || exactOwnership === 'present' || exactOwnership === 'partial') {
          return { ...target, state: 'existing' };
        }
        if (!plugin) return { ...target, state: 'blocked', reason: '插件已不在当前状态中' };
        if (plugin.configOnly) {
          return { ...target, state: 'blocked', reason: '来源中没有可信插件定义' };
        }
        if (plugin.sourceUnavailable) {
          return { ...target, state: 'blocked', reason: '插件来源不可用' };
        }
        if (plugin.capabilityUnsupported) {
          return { ...target, state: 'blocked', reason: '当前 AW CLI 不支持插件所需功能' };
        }
        const option = this.listInstallTargets(pluginId, scope)
          .find((entry) => entry.platform === targetPlatform);
        if (!option?.compatible) {
          return { ...target, state: 'blocked', reason: option?.disabled ?? '插件不支持所选工具或位置' };
        }
        const representativeTarget = exactTarget
          ?? (targetPlatform === 'codex' ? statusTargets[0] : undefined);
        const uncertainObservation = (representativeTarget
          && statusTargetActivation(representativeTarget)?.evidence === 'unobserved')
          || statusTargets.some((entry) => statusTargetSharedNative(entry)?.state === 'unobserved');
        if (uncertainObservation) {
          return { ...target, state: 'blocked', reason: '无法确认所选位置是否缺失' };
        }
        if (!representativeTarget || representativeTarget.state === 'blocked') {
          return {
            ...target,
            state: 'blocked',
            reason: representativeTarget?.reasons.find((reason) => reason.severity === 'blocking')?.message
              ?? '无法确认所选位置是否缺失',
          };
        }
        if (targetPlatform === 'codex') {
          const intent = statusTargetIntent(representativeTarget);
          const activation = statusTargetActivation(representativeTarget);
          const confirmedMissing = activation?.evidence === 'observed' && activation[scope] === false
            || intent.enabled && !intent.scopes.includes(scope)
            || representativeTarget.state === 'absent'
              && statusTargetOwnershipState(representativeTarget) === 'absent'
              && !intent.enabled;
          if (!confirmedMissing) {
            return { ...target, state: 'blocked', reason: '无法确认所选位置是否缺失' };
          }
        } else if (representativeTarget.state !== 'absent') {
          return { ...target, state: 'blocked', reason: '无法确认所选位置是否缺失' };
        }
        return { ...target, state: 'add' };
      });
    }).sort((left, right) => [left.pluginId, left.platform, left.scope].join('\0')
      .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en')));
  }

  pluginHasInstallableTarget(pluginId: string): boolean {
    return (['project', 'user'] as const).some((scope) =>
      this.listPluginInstallBatchTargets([pluginId], 'both', scope)
        .some((target) => target.state === 'add'));
  }

  getPluginDependencyOverview(pluginId: string): PluginDependencyOverviewViewModel | undefined {
    const overview = this.#viewModel?.dependencyOverviews.find((entry) => entry.pluginId === pluginId);
    return overview ? cloneFrozen(overview) : undefined;
  }

  listPluginDependencyOverviews(): PluginDependencyOverviewViewModel[] {
    return cloneFrozen(this.#viewModel?.dependencyOverviews ?? []);
  }

  getBlockingDependents(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): PluginDependencyOverviewViewModel['dependents'] {
    const statusTargets = flattenStatusTargets(this.#status?.payload.targets ?? []);
    const dependents = this.#viewModel?.dependencyOverviews.find((entry) =>
      entry.pluginId === pluginId)?.dependents ?? [];
    return cloneFrozen(dependents.flatMap((dependent) => {
      const references = (dependent.placementReferences ?? []).filter((reference) =>
        reference.dependency.pluginId === pluginId
        && reference.dependency.platform === platform
        && reference.dependency.scope === scope
        && (scope === 'user' || reference.dependency.project === 'current')
        && (reference.consumer.project === 'other'
          || statusTargets.find((target) =>
            target.pluginId === reference.consumer.pluginId
            && target.platform === reference.consumer.platform
            && target.scope === reference.consumer.scope)?.state !== 'absent'));
      return references.length > 0 ? [{ ...dependent, placementReferences: references }] : [];
    }));
  }

  getPlatformPlacement(pluginId: string, platform: PlatformName): PluginListItemViewModel['installedPlacements'][number] | undefined {
    return this.getPluginOverview(pluginId)?.installedPlacements.find((placement) =>
      placement.platform === platform);
  }

  listInstallTargets(pluginId: string, scope: Scope): InstallTargetOption[] {
    const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
    if (!plugin) return [];
    if (plugin.aggregateStatus === 'unavailable') {
      return plugin.supportedPlatforms.map((platform) => ({
        platform,
        compatible: false,
        disabled: '插件来源不可用',
      }));
    }
    return plugin.supportedPlatforms.map((platform): InstallTargetOption => {
      const allStatusTargets = flattenStatusTargets(this.#status?.payload.targets ?? []);
      const platformTargets = allStatusTargets.filter((target) =>
        target.pluginId === pluginId && target.platform === platform) ?? [];
      const rootSummary = this.#status?.pluginSummaries.find((summary) =>
        summary.pluginId === pluginId);
      const rootSupportedScopes = rootSummary?.supportedTargets?.[platform]
        ?? platformTargets.filter((target) => !target.reasons.some((error) =>
          error.code === 'unsupportedTarget')).map((target) => target.scope);
      if (!rootSupportedScopes.includes(scope)) {
        return { platform, compatible: false, disabled: '不支持所选位置' };
      }
      const statusTarget = platformTargets.find((target) => target.scope === scope)
        ?? (platform === 'codex' ? platformTargets[0] : undefined);
      if (statusTarget && targetHasArtifactCollision(statusTarget)) {
        return { platform, compatible: false, disabled: '存在输出冲突；请先移除或迁移占用内容' };
      }
      const overview = this.#viewModel?.dependencyOverviews.find((entry) => entry.pluginId === pluginId);
      for (const dependency of overview?.dependencies ?? []) {
        const dependencySummary = this.#status?.pluginSummaries.find((summary) =>
          summary.pluginId === dependency.pluginId);
        const allowedScopes = dependencySummary?.supportedTargets?.[platform]
          ?? (allStatusTargets.filter((target) =>
            target.pluginId === dependency.pluginId
            && target.platform === platform
            && !target.reasons.some((error) => error.code === 'unsupportedTarget'))
            .map((target) => target.scope) ?? []);
        const viableScopes = allowedScopes.filter((candidateScope) =>
          scope === 'project' || candidateScope === 'user');
        if (viableScopes.length === 0) {
          return {
            platform,
            compatible: false,
            disabled: `${dependency.displayName} 不支持${platform === 'codex' ? 'Codex' : 'Claude Code'}或所选位置`,
          };
        }
        const collisionAtEveryViableScope = viableScopes.every((candidateScope) => {
          const target = allStatusTargets.find((entry) =>
            entry.pluginId === dependency.pluginId
            && entry.platform === platform
            && entry.scope === candidateScope);
          return Boolean(target && targetHasArtifactCollision(target));
        });
        if (collisionAtEveryViableScope) {
          return {
            platform,
            compatible: false,
            disabled: `${dependency.displayName} 存在输出冲突`,
          };
        }
      }
      return { platform, compatible: true };
    });
  }

  getTargetState(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): StatusV8Payload['targets'][number]['state'] | undefined {
    return flattenStatusTargets(this.#status?.payload.targets ?? []).find((target) =>
      target.pluginId === pluginId
      && target.platform === platform
      && target.scope === scope)?.state;
  }

  listSources(): TuiViewModel['sourceTabs'] {
    return cloneFrozen(this.#viewModel?.sourceTabs ?? []);
  }

  getSourceOverview(sourceId: string): {
    source?: TuiViewModel['sourceTabs'][number];
    detail?: SourceDetailViewModel;
    health?: SourceHealthViewModel;
  } {
    return cloneFrozen({
      source: this.#viewModel?.sourceTabs.find((source) => source.id === sourceId),
      detail: this.#viewModel?.sourceDetails.find((source) => source.id === sourceId),
      health: this.#health.get(sourceId),
    });
  }

  getConfiguredSource(sourceId: string): CatalogSource | undefined {
    const source = this.#status?.configuredSources?.find((candidate) => candidate.id === sourceId);
    return source ? cloneFrozen(source) : undefined;
  }

  getCatalogGeneration(sourceId: string): CatalogSourceGenerationViewModel | undefined {
    const source = this.#catalogGenerations.get(sourceId);
    return source ? cloneFrozen(source) : undefined;
  }

  getCatalogFreshness(sourceId: string): CatalogSourceFreshnessViewModel | undefined {
    const freshness = this.#catalogFreshness.get(sourceId);
    return freshness ? cloneFrozen(freshness) : undefined;
  }

  recheckCatalogSource(sourceId: string): Promise<void> {
    this.#assertAcceptingActions();
    return this.#catalogSourcesSession.recheck(sourceId);
  }

  async recheckAllCatalogSources(): Promise<void> {
    this.#assertAcceptingActions();
    const sourceIds = [...this.listSources()]
      .sort((left, right) => Number(Boolean(right.primary)) - Number(Boolean(left.primary)))
      .map((source) => source.id);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < sourceIds.length) {
        const sourceId = sourceIds[next++];
        if (sourceId) await this.#catalogSourcesSession.recheck(sourceId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, sourceIds.length) }, () => worker()));
  }

  fullValidateCatalogSource(sourceId: string): Promise<void> {
    this.#assertAcceptingActions();
    return this.#catalogSourcesSession.fullValidate(sourceId);
  }

  setExternalDraftState(states: ExternalDraftState[] = []): void {
    const priority = { sourceDraft: 0, batchDraft: 1, catalogDraft: 2, configDraft: 3 } as const;
    this.#externalDrafts = structuredClone(states).sort((left, right) =>
      priority[left.kind] - priority[right.kind] || left.owner.localeCompare(right.owner, 'en'));
    this.#publish();
  }

  beginPluginWriteBatch(): void {
    this.#assertAcceptingActions();
    this.#router.beginBatchFlow();
    this.#router.push({ name: 'batchSelection' });
    this.#publish();
  }

  startPluginWriteBatchReview(intent: PluginWriteBatchIntent): ReviewPreparationSnapshot {
    return this.startReviewPreparation(intent, { name: 'batchPlacement' });
  }

  startPluginWriteTaskReview(
    intent: PluginWriteTaskIntent,
    returnRoute?: TuiRoute,
  ): ReviewPreparationSnapshot {
    return this.startReviewPreparation(intent, returnRoute);
  }

  beginNestedPluginWriteTask(route: Extract<TuiRoute, { name: 'pluginWriteTask' }>): void {
    this.#assertAcceptingActions();
    const current = this.#router.snapshot.current.route;
    if (current.name !== 'pluginWriteTask') {
      throw new TuiOperationBlockedError('taskOriginUnavailable', '嵌套任务缺少父任务。');
    }
    this.#router.beginFlow('pluginWriteTask', current);
    this.#router.push(route);
    this.#publish();
  }

  pluginWriteTaskReturnRoute(route: Extract<TuiRoute, { name: 'pluginWriteTask' }>): TuiRoute {
    const active = this.#router.activeFlow();
    return structuredClone(active?.kind === 'pluginWriteTask'
      && active.returnTarget.name === 'pluginWriteTask'
      ? active.returnTarget
      : route);
  }

  returnToPluginWriteTaskBatchSelection(flowId: string): boolean {
    this.#assertAcceptingActions();
    const route = this.#router.snapshot.current.route;
    if (route.name !== 'review'
      || this.#activeReview?.operationId !== route.operationId
      || this.#activeReview.operationKind !== 'pluginWriteTask') return false;
    const reviewToken = this.#activeReview.reviewToken;
    const returned = this.#router.returnToBatchSelection(flowId);
    if (!returned) return false;
    this.#cancelReviewPreparation();
    this.#tickets.delete(reviewToken);
    this.#activeReview = undefined;
    this.#publish();
    return true;
  }

  retryFailedPluginWriteBatch(): ReviewPreparationSnapshot | undefined {
    if (!this.#batchRetryIntent) return undefined;
    const intent = structuredClone(this.#batchRetryIntent);
    this.#batchRetryIntent = undefined;
    return this.startReviewPreparation(intent, { name: 'pluginList', mode: 'installed' });
  }

  retryFailedPluginWriteTask(): ReviewPreparationSnapshot | undefined {
    if (!this.#taskRetryIntent) return undefined;
    const intent = structuredClone(this.#taskRetryIntent);
    this.#taskRetryIntent = undefined;
    return this.startReviewPreparation(intent, { name: 'pluginList', mode: 'installed' });
  }

  catalogActivationBlockReason(): CatalogActivationBlockReason | undefined {
    if (this.#externalDrafts[0]) return this.#externalDrafts[0].kind;
    if (this.#portableDraft) return 'portableDraft';
    if (this.#reviewPreparation) return 'reviewPreparation';
    if (this.#activeReview) return 'activeReview';
    if (this.#router.snapshot.current.route.name === 'progress'
      || this.#inflightOperations.size > 0) return 'writeProgress';
    return undefined;
  }

  catalogSourceRecoveryBlockReason(
    intent?: Extract<OperationIntent, { kind: 'catalogGeneration' }>,
  ): CatalogActivationBlockReason | undefined {
    const activeFlow = this.#router.activeFlow();
    const route = this.#router.snapshot.current.route;
    const ownedFrozenBatchTask = intent !== undefined
      && route.name === 'pluginWriteTask'
      && route.targetKeys !== undefined
      && route.targetKeys.length > 0
      && route.batchOrigin !== undefined
      && (activeFlow?.id === route.batchOrigin.flowId
        || activeFlow?.parentFlowId === route.batchOrigin.flowId)
      && this.listPluginWriteTaskCandidates(route.goal).some((candidate) =>
        candidate.sourceId === intent.sourceId
        && candidate.blockReason === 'catalogActivationRequired'
        && route.targetKeys!.includes(pluginWriteTaskTargetKey(candidate.target)));
    const blockingExternalDraft = this.#externalDrafts.find((draft) =>
      !(draft.kind === 'configDraft'
        && activeFlow?.kind === 'sourceRecovery'
        && activeFlow.parentFlowId !== undefined)
      && !(ownedFrozenBatchTask
        && draft.kind === 'batchDraft'
        && draft.owner === route.batchOrigin?.owner
        && draft.flowId === route.batchOrigin.flowId));
    if (blockingExternalDraft) return blockingExternalDraft.kind;
    if (this.#portableDraft) return 'portableDraft';
    if (this.#reviewPreparation) return 'reviewPreparation';
    if (this.#activeReview) return 'activeReview';
    if (this.#router.snapshot.current.route.name === 'progress'
      || this.#inflightOperations.size > 0) return 'writeProgress';
    return undefined;
  }

  getSessionCatalogVersion(sourceId: string): string | undefined {
    return this.#status?.payload.catalog.sources.find((source) => source.id === sourceId)?.catalogVersion;
  }

  async reloadCatalog(options: { sourceId: string }): Promise<boolean> {
    this.#assertAcceptingActions();
    if (this.catalogActivationBlockReason()) return false;
    this.dependencies.beginCatalogSession?.();
    const generation = ++this.#generation;
    this.#phase = 'loading';
    this.#publish();
    try {
      const status = await this.#trackRead(this.dependencies.loadStatus(this.#abort.signal));
      if (this.#disposed || generation !== this.#generation) return false;
      this.#applyStatus(status);
      this.#phase = 'ready';
      this.#loadError = undefined;
      this.#router.replace({ name: 'sourceDetail', sourceId: options.sourceId });
      this.#publish();
      return true;
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return false;
      const code = issueCode(error);
      await this.#logErrorSafe(error, code);
      this.#phase = 'error';
      this.#loadError = { code, message: '无法安全重新加载 Catalog。请检查诊断后重试。' };
      this.#publish();
      return false;
    }
  }

  async inspectSourceRemoval(sourceId: string): Promise<SourceReferenceSummaryViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.inspectSourceRemoval) {
      throw new TuiOperationBlockedError('stateInventoryFailed', '来源引用清单不可用。');
    }
    return cloneFrozen(await this.#trackRead(
      this.dependencies.inspectSourceRemoval(sourceId, this.#abort.signal),
    ));
  }

  async getConfigGroups(
    pluginId: string,
    layer: { scope: Scope },
  ): Promise<ConfigGroupViewModel[]> {
    this.#assertAcceptingActions();
    if (!this.dependencies.getConfigGroups) {
      throw new TuiOperationBlockedError('configUnavailable', '设置读取入口不可用。');
    }
    return cloneFrozen(await this.#trackRead(this.dependencies.getConfigGroups(
      pluginId,
      structuredClone(layer),
      this.#abort.signal,
    )));
  }

  async getConfigPage(
    pluginId: string,
    layer: { scope: Scope | 'effective' },
    signal?: AbortSignal,
  ): Promise<ConfigPageViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.getConfigPage) {
      throw new TuiOperationBlockedError('configUnavailable', '设置读取入口不可用。');
    }
    const combined = signal
      ? AbortSignal.any([this.#abort.signal, signal])
      : this.#abort.signal;
    return cloneFrozen(await this.#trackRead(this.dependencies.getConfigPage(
      pluginId,
      structuredClone(layer),
      combined,
    )));
  }

  async selectCatalogWorkspace(
    workspaceRoot?: string,
  ): Promise<CatalogWorkspaceManagementViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(
      this.dependencies.catalogManagement.selectWorkspace(workspaceRoot),
    ));
  }

  async getCatalogWorkspaceManagement(): Promise<CatalogWorkspaceManagementViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(this.dependencies.catalogManagement.getWorkspace()));
  }

  async validateCatalogWorkspace(): Promise<CatalogValidationViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(
      this.dependencies.catalogManagement.validateWorkspace(),
    ));
  }

  async getCatalogDevManagement(): Promise<CatalogDevManagementViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(this.dependencies.catalogManagement.getDev()));
  }

  async getCatalogStoreManagement(): Promise<CatalogStoreManagementViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(this.dependencies.catalogManagement.getStore()));
  }

  async getCatalogPublicationManagement(): Promise<CatalogPublicationManagementViewModel> {
    this.#assertAcceptingActions();
    if (!this.dependencies.catalogManagement) {
      throw new TuiOperationBlockedError(
        'catalogManagementUnavailable',
        'Catalog management is unavailable.',
      );
    }
    return cloneFrozen(await this.#trackRead(
      this.dependencies.catalogManagement.getPublication(),
    ));
  }

  async previewConfigSaveImpact(
    intent: Extract<OperationIntent, { kind: 'configSave' }>,
    signal?: AbortSignal,
  ): Promise<NonNullable<OperationEvidence['config']>> {
    this.#assertAcceptingActions();
    const normalized = normalizeOperationIntent(intent) as Extract<OperationIntent, { kind: 'configSave' }>;
    this.#validateReviewIntent(normalized);
    const combined = signal
      ? AbortSignal.any([this.#abort.signal, signal])
      : this.#abort.signal;
    const evidence = await this.#trackRead(this.#prepareReviewEvidence(normalized, combined));
    if (!evidence.config) {
      throw new TuiOperationBlockedError('configImpactUnavailable', '无法确定设置修改的应用影响。');
    }
    return cloneFrozen(evidence.config);
  }

  async getConfigResetAvailability(
    pluginId: string,
    layer: { scope: Scope },
  ): Promise<ConfigResetAvailability> {
    this.#assertAcceptingActions();
    if (!this.dependencies.getConfigResetAvailability) {
      throw new TuiOperationBlockedError(
        'configResetVerificationUnavailable',
        '设置层可信读取入口不可用。',
      );
    }
    return cloneFrozen(await this.#trackRead(this.dependencies.getConfigResetAvailability(
      pluginId,
      structuredClone(layer),
      this.#abort.signal,
    )));
  }

  listUserIssues(): UserIssueViewModel[] {
    return cloneFrozen(this.#viewModel?.issues ?? []);
  }

  listPluginWriteTaskCandidates(goal: PluginWriteTaskGoal): PluginWriteTaskCandidate[] {
    return cloneFrozen(this.#viewModel
      ? buildPluginWriteTaskCandidates(this.#viewModel, goal)
      : []);
  }

  async buildOperationReview(intent: OperationIntent, returnRoute?: TuiRoute): Promise<OperationReviewModel> {
    this.#assertAcceptingActions();
    intent = normalizeOperationIntent(intent);
    try {
      this.#validateReviewIntent(intent);
      const evidence = await this.#trackRead(
        this.#prepareReviewEvidence(intent, this.#abort.signal),
      );
      return this.#storeOperationReview(intent, evidence, 'push', returnRoute);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, intent);
      throw new TuiOperationBlockedError(
        code,
        code === 'catalogGenerationUnavailable'
          ? '本次加载时 Catalog 来源不可用。请刷新来源并重新加载后重试。'
          : '操作未建立。请检查当前设置后重试。',
      );
    }
  }

  startReviewPreparation(intent: OperationIntent, returnRoute?: TuiRoute): ReviewPreparationSnapshot {
    this.#assertAcceptingActions();
    intent = normalizeOperationIntent(intent);
    if (intent.kind === 'catalogGeneration' && !intent.sourceMutation) {
      const blockReason = this.catalogSourceRecoveryBlockReason(intent);
      if (blockReason) {
        throw new TuiOperationBlockedError(
          'catalogActivationBlocked',
          `Catalog Active 切换已阻止：${blockReason}。请先完成或放弃当前草稿或操作。`,
        );
      }
    }
    this.#ensureOperationFlow(intent);
    const inheritedReturnRoute = this.#reviewPreparation?.returnRoute;
    const current = this.#router.snapshot.current.route;
    const navigation = current.name === 'result' || current.name === 'reviewPreparing'
      ? 'replace' : 'push';
    const resolvedReturnRoute = returnRoute
      ?? (current.name === 'reviewPreparing' ? inheritedReturnRoute : undefined)
      ?? (current.name === 'result' && this.#result
      && 'returnRoute' in this.#result && this.#result.returnRoute
      ? this.#result.returnRoute
      : current);
    const normalizedReturnRoute = this.#normalizeRoute(resolvedReturnRoute);
    const key = crypto.createHash('sha256')
      .update(JSON.stringify(stableValue({ intent, returnRoute: normalizedReturnRoute })))
      .digest('hex');
    if (this.#reviewPreparation?.snapshot.state === 'running'
      && this.#reviewPreparation.key === key) {
      return cloneFrozen(this.#reviewPreparation.snapshot);
    }
    this.#cancelReviewPreparation();
    const id = crypto.randomUUID();
    const abort = new AbortController();
    const token = ++this.#reviewPreparationToken;
    const snapshot: ReviewPreparationSnapshot = {
      id,
      operationKind: intent.kind,
      subject: this.#reviewPreparationLabel(intent),
      state: 'running',
      stages: this.dependencies.prepareReviewEvidence ? [] : [
        { id: 'validate', label: '验证当前状态', state: 'running' },
        { id: 'evidence', label: '准备确认信息', state: 'pending' },
      ],
      ...(this.dependencies.prepareReviewEvidence ? {} : { currentStage: 'validate' as const }),
    };
    this.#reviewPreparationIntents.set(id, structuredClone(intent));
    this.#reviewPreparation = {
      snapshot,
      key,
      returnRoute: structuredClone(normalizedReturnRoute),
      abort,
      token,
    };
    this.#result = undefined;
    this.#router[navigation]({ name: 'reviewPreparing', preparationId: id });
    this.#publish();
    queueMicrotask(() => void this.#runReviewPreparation(token));
    return cloneFrozen(snapshot);
  }

  retryReviewPreparation(): ReviewPreparationSnapshot | undefined {
    const preparation = this.#reviewPreparation;
    if (!preparation || preparation.snapshot.state !== 'failed') return undefined;
    const intent = this.#reviewPreparationIntents.get(preparation.snapshot.id);
    if (!intent) return undefined;
    return this.startReviewPreparation(structuredClone(intent), preparation.returnRoute);
  }

  #validateReviewIntent(intent: OperationIntent): void {
    if (intent.kind === 'catalogManagement') {
      if (intent.action === 'storePrune' && intent.items.length === 0) {
        throw new TuiOperationBlockedError(
          'catalogStoreSelectionInvalid',
          'Select at least one reclaimable Catalog store item.',
        );
      }
      if (intent.action === 'workspaceVersion'
        && (intent.version === undefined) === (intent.bump === undefined)) {
        throw new TuiOperationBlockedError(
          'catalogVersionSelectionInvalid',
          'Select exactly one Catalog version or bump level.',
        );
      }
      if ((intent.action === 'publishPlan' || intent.action === 'publishApply')
        && intent.remote !== undefined && intent.remoteUrl !== undefined) {
        throw new TuiOperationBlockedError(
          'catalogPublicationTargetInvalid',
          'Select a Git remote name or one direct remote URL.',
        );
      }
      if (intent.action === 'publishApply'
        && !/^sha256:[0-9a-f]{64}$/u.test(intent.expectedPlanDigest)) {
        throw new TuiOperationBlockedError(
          'catalogPublicationPlanInvalid',
          'Select an exact prepared Catalog publication plan.',
        );
      }
    }
    if (intent.kind === 'pluginWriteTask') {
      if (intent.targets.length === 0
        || JSON.stringify(intent.targets) !== JSON.stringify(canonicalPluginWriteTaskTargets(intent.targets))) {
        throw new TuiOperationBlockedError('taskSelectionInvalid', '任务目标必须是非空精确目标集合。');
      }
      for (const target of intent.targets) {
        sourceIdFromPluginId(target.pluginId);
        if ((target.platform !== 'codex' && target.platform !== 'claude')
          || (target.scope !== 'user' && target.scope !== 'project')
          || (intent.goal === 'update') !== Boolean(target.expectedUpdate)) {
          throw new TuiOperationBlockedError('taskSelectionInvalid', '任务目标或版本证据无效。');
        }
      }
    }
    if (intent.kind === 'pluginWriteBatch') {
      if (intent.selection.kind === 'currentProjectIntentRoots'
        && (intent.action !== 'sync' || intent.scope !== 'project')) {
        throw new TuiOperationBlockedError(
          'batchSelectionInvalid',
          '当前项目全部同步只支持 project scope sync。',
        );
      }
      if (intent.selection.kind === 'selected') {
        const canonical = canonicalPluginIds(intent.selection.pluginIds);
        if (canonical.length === 0) {
          throw new TuiOperationBlockedError('batchSelectionInvalid', '批量插件选择无效。');
        }
        canonical.forEach(sourceIdFromPluginId);
      }
    }
    const primaryGeneration = intent.kind === 'sourceMutation' && intent.action === 'setPrimary'
      ? this.#catalogGenerations.get(intent.sourceId) : undefined;
    if (primaryGeneration && !primaryGeneration.active && primaryGeneration.state !== 'ready') {
      throw new TuiOperationBlockedError(
        'catalogGenerationUnavailable',
        '来源尚未 ready。请先获取、修复或切换 Active Catalog。',
      );
    }
  }

  #reviewPreparationLabel(intent: OperationIntent): string {
    if (intent.kind === 'catalogManagement') return 'Catalog 管理';
    if (intent.kind === 'catalogSourcesRecovery') return 'Catalog 来源配置';
    if (intent.kind === 'pluginWriteTask') return `${intent.targets.length} 个安装位置`;
    if (intent.kind === 'pluginWriteBatch') {
      return intent.selection.kind === 'selected'
        ? `${intent.selection.pluginIds.length} 个插件`
        : '当前项目全部插件';
    }
    if ('pluginId' in intent) {
      return this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.displayName
        ?? pluginNameFromId(intent.pluginId);
    }
    return intent.sourceId;
  }

  #reviewPreparationIsCurrent(token: number): boolean {
    const preparation = this.#reviewPreparation;
    const route = this.#router.snapshot.current.route;
    return Boolean(preparation && preparation.token === token
      && !preparation.abort.signal.aborted
      && !this.#disposed
      && route.name === 'reviewPreparing' && route.preparationId === preparation.snapshot.id);
  }

  async #runReviewPreparation(token: number): Promise<void> {
    const preparation = this.#reviewPreparation;
    if (!preparation || preparation.token !== token) return;
    const storedIntent = this.#reviewPreparationIntents.get(preparation.snapshot.id);
    if (!storedIntent) return;
    const intent = structuredClone(storedIntent);
    const signal = AbortSignal.any([this.#abort.signal, preparation.abort.signal]);
    try {
      this.#validateReviewIntent(intent);
      const evidence = await this.#trackRead(this.#prepareReviewEvidence(intent, signal, (stage) => {
        if (!this.#reviewPreparationIsCurrent(token)) return;
        preparation.snapshot.currentStage = stage;
        const existing = preparation.snapshot.stages.find((entry) => entry.id === stage);
        preparation.snapshot.stages = preparation.snapshot.stages.map((entry) =>
          entry.state === 'running' ? { ...entry, state: 'completed' } : entry);
        if (existing) {
          preparation.snapshot.stages = preparation.snapshot.stages.map((entry) =>
            entry.id === stage ? { ...entry, state: 'running' } : entry);
        } else {
          preparation.snapshot.stages.push({
            id: stage,
            label: reviewPreparationStageLabel(stage),
            state: 'running',
          });
        }
        this.#publish();
      }));
      if (!this.#reviewPreparationIsCurrent(token)) return;
      preparation.snapshot.stages = preparation.snapshot.stages.map((stage) =>
        stage.state === 'running' ? { ...stage, state: 'completed' } : stage);
      this.#publish();
      const returnRoute = structuredClone(preparation.returnRoute);
      this.#storeOperationReview(intent, evidence, 'replace', returnRoute);
      this.#reviewPreparationIntents.delete(preparation.snapshot.id);
      this.#reviewPreparation = undefined;
      this.#publish();
    } catch (error) {
      if (!this.#reviewPreparationIsCurrent(token)) return;
      const code = issueCode(error);
      const active = this.#reviewPreparation!;
      if (code === 'catalogLogicalIdentityChanged'
        && intent.kind === 'catalogGeneration') {
        const generation = this.#catalogGenerations.get(intent.sourceId);
        if (generation) this.#catalogGenerations.set(intent.sourceId, {
          ...generation,
          state: 'unavailable',
          errorCode: code,
        });
      }
      active.snapshot.state = 'failed';
      active.snapshot.stages = active.snapshot.stages.map((stage) =>
        stage.state === 'running' ? { ...stage, state: 'failed' } : stage);
      active.snapshot.code = 'reviewPreparationFailed';
      active.snapshot.message = code === 'catalogLogicalIdentityChanged'
        ? 'Catalog logical identity 已变化。请编辑来源，或移除后重新添加。'
        : code === 'catalogGenerationActiveComparisonUnavailable'
          ? '损坏的当前 Active 无法提供可信版本，不能安全比较候选。当前 Active 保持不变。请明确编辑来源，或移除后重新添加。'
        : code === 'catalogReplaceDamagedRequired'
          ? intent.kind === 'catalogGeneration'
            && this.#catalogFreshness.get(intent.sourceId)?.state === 'incompatible'
            ? '无法重新取得或精确匹配旧 Active，且当前候选与此 AW 不兼容。当前 Active 保持不变。请升级 AW 或修改来源。'
            : '无法重新取得或精确匹配旧 Active。当前 Active 保持不变。请返回并选择“使用当前候选替换损坏的 Active”。'
        : code === 'catalogVersionConflict'
          ? '候选 Catalog 与当前 Active 版本相同，但内容摘要不同。普通更新已阻止。'
          : code === 'catalogRollbackDetected'
            ? '候选 Catalog 版本低于当前 Active。普通更新已阻止。'
        : code === 'catalogGenerationUnavailable'
        ? '本次加载时 Catalog 来源不可用。请刷新来源并重新加载后重试。'
        : '无法准备确认信息。请返回检查选择，或重试。';
      const preparationRecordId = `${this.#sessionEpoch}:${active.snapshot.id}`;
      const carriedDiagnostics = error instanceof TuiOperationBlockedError
        ? error.diagnostics : undefined;
      const preparationDiagnostics = carriedDiagnostics?.length
        ? carriedDiagnostics.map((diagnostic, index) => ({
            ...structuredClone(diagnostic),
            id: `${preparationRecordId}:failure:${index}`,
          }))
        : [projectThrownOperationDiagnostic({
            error,
            id: `${preparationRecordId}:failure`,
            stage: active.snapshot.currentStage ?? 'reviewPreparation',
            fallbackCode: code,
            sensitiveValues: collectOperationSensitiveValues(intent),
          })];
      this.#operationHistory.record({
        summary: {
          recordId: preparationRecordId,
          epoch: this.#sessionEpoch,
          operationId: active.snapshot.id,
          createdAtMs: this.dependencies.now?.() ?? Date.now(),
          state: 'blocked',
          code: preparationDiagnostics[0]!.code,
          message: active.snapshot.message,
          operationKind: intent.kind,
          ...('pluginId' in intent ? { pluginId: intent.pluginId } : {}),
          diagnosticCount: preparationDiagnostics.length,
          effects: {
            configCommit: 'notApplicable', awWrite: 'notStarted',
            preApplyExternalEffect: 'notApplicable', finalVerification: 'notStarted',
          },
        },
        diagnostics: preparationDiagnostics,
        targets: [...new Map(preparationDiagnostics.flatMap((diagnostic) => diagnostic.target ? [[
          [diagnostic.target.pluginId ?? '', diagnostic.target.platform, diagnostic.target.scope].join('\0'),
          {
            ...diagnostic.target,
            state: 'skipped' as const,
            errorCode: diagnostic.code,
            diagnosticIds: preparationDiagnostics.filter((candidate) => candidate.target
              && candidate.target.pluginId === diagnostic.target!.pluginId
              && candidate.target.platform === diagnostic.target!.platform
              && candidate.target.scope === diagnostic.target!.scope).map((candidate) => candidate.id),
          },
        ] as const] : [])).values()],
      }, { sensitiveValues: collectOperationSensitiveValues(intent) });
      this.#publish();
      await this.#logOperationError(error, code, intent);
    }
  }

  async #prepareReviewEvidence(
    intent: OperationIntent,
    signal: AbortSignal,
    onStage: (stage: ReviewPreparationStageId) => void | Promise<void> = () => undefined,
  ): Promise<OperationEvidence> {
    if (this.dependencies.prepareReviewEvidence) {
      const reusableCandidate = intent.kind === 'catalogGeneration'
        && !intent.sourceMutation
        && (intent.action === 'activate' || intent.action === 'update')
        ? this.#catalogSourcesSession.reusableCandidate(intent.sourceId)
        : undefined;
      return this.dependencies.prepareReviewEvidence(
        structuredClone(intent),
        signal,
        onStage,
        reusableCandidate,
      );
    }
    await onStage('validate');
    await this.dependencies.validateIntent?.(structuredClone(intent), signal);
    await onStage('evidence');
    return this.dependencies.captureEvidence(structuredClone(intent), signal);
  }

  #cancelReviewPreparation(): void {
    if (!this.#reviewPreparation) return;
    this.#reviewPreparationToken += 1;
    this.#reviewPreparation.abort.abort();
    this.#reviewPreparationIntents.delete(this.#reviewPreparation.snapshot.id);
    this.#reviewPreparation = undefined;
  }

  async #logOperationError(error: unknown, code: string, intent: OperationIntent): Promise<void> {
    await this.#logErrorSafe(error, code, {
      privateConfigOperation: intent.kind === 'configSave' || intent.kind === 'configReset'
        || intent.kind === 'sourceMutation',
    });
  }

  #pruneReviewTickets(now: number): void {
    for (const [token, ticket] of this.#tickets) {
      if (ticket.review.expiresAt < now) this.#tickets.delete(token);
    }
    const maximum = Math.max(1, this.dependencies.maxReviewTickets ?? 32);
    while (this.#tickets.size >= maximum) {
      const oldest = this.#tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#tickets.delete(oldest);
    }
  }

  #storeOperationReview(
    intent: OperationIntent,
    evidence: OperationEvidence,
    navigation: 'push' | 'replace' = 'push',
    returnRoute: TuiRoute = this.#router.snapshot.current.route,
  ): OperationReviewModel {
    this.#ensureOperationFlow(intent);
    if (intent.kind === 'pluginWriteBatch') assertPluginWriteBatchEvidence(evidence);
    if (intent.kind === 'pluginWriteTask') assertPluginWriteTaskEvidence(intent, evidence);
    if (this.#router.snapshot.current.route.name === 'result') navigation = 'replace';
    const projection = buildOperationReviewProjection({
      intent,
      evidence,
      ...('pluginId' in intent
        ? { dependencyOverview: this.getPluginDependencyOverview(intent.pluginId) }
        : {}),
    });
    const operationId = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const reviewToken = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const now = this.dependencies.now?.() ?? Date.now();
    this.#pruneReviewTickets(now);
    const expiresAt = now
      + (this.dependencies.reviewTtlMs ?? 2 * 60_000);
    const pluginId = 'pluginId' in intent ? intent.pluginId
      : 'sourceId' in intent ? intent.sourceId ?? 'Catalog 管理'
        : intent.kind === 'pluginWriteBatch'
          ? `${(evidence as PluginWriteBatchEvidence).requestedPluginIds.length} 个插件`
          : intent.kind === 'pluginWriteTask'
            ? `${(evidence as PluginWriteTaskEvidence).taskPlan.requestedTargets.length} 个安装位置`
          : 'Catalog 来源配置';
    if ('pluginId' in intent) sourceIdFromPluginId(intent.pluginId);
    const pluginVersion = 'pluginId' in intent
      ? evidence.source?.pluginVersion
        ?? this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.version
      : undefined;
    const review: OperationReviewModel = {
      operationId,
      reviewToken,
      expiresAt,
      operationKind: intent.kind,
      ...(intent.kind === 'sourceMutation' ? { sourceAction: intent.action }
        : intent.kind === 'catalogGeneration' && intent.sourceMutation
          ? { sourceAction: intent.sourceMutation.action } : {}),
      ...(intent.kind === 'pluginWrite' ? { pluginAction: intent.action } : {}),
      ...(intent.kind === 'pluginWriteBatch' ? { pluginAction: intent.action } : {}),
      ...(intent.kind === 'pluginWriteTask' ? { taskGoal: intent.goal } : {}),
      ...(intent.kind === 'pluginWrite' && intent.originIssue
        ? { originIssue: intent.originIssue }
        : {}),
      ...projection,
      subject: {
        name: 'pluginId' in intent
          ? this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.displayName
            ?? pluginNameFromId(intent.pluginId)
          : pluginId,
        ...('pluginId' in intent ? { sourceLabel: sourceIdFromPluginId(intent.pluginId) } : {}),
        ...(pluginVersion ? { version: pluginVersion } : {}),
      },
      ...(intent.kind === 'pluginWriteBatch' ? {
        batch: {
          requestedPluginIds: [...(evidence as PluginWriteBatchEvidence).requestedPluginIds],
          groupCount: (evidence as PluginWriteBatchEvidence).groups.length,
          executableGroupCount: (evidence as PluginWriteBatchEvidence).groups
            .filter((group) => group.executable).length,
        },
      } : {}),
      ...(intent.kind === 'pluginWriteTask' ? {
        task: {
          goal: intent.goal,
          requestedTargetCount: (evidence as PluginWriteTaskEvidence).taskPlan.requestedTargets.length,
          executableTargetCount: (evidence as PluginWriteTaskEvidence).taskPlan.executableTargets.length,
          blockedTargetCount: (evidence as PluginWriteTaskEvidence).taskPlan.blockedTargets.length,
          causeCount: (evidence as PluginWriteTaskEvidence).taskPlan.causes.length,
        },
      } : {}),
      ...(evidence.source && 'catalogVersion' in evidence.source
        && typeof evidence.source.catalogVersion === 'string'
        && evidence.source.snapshotDigest
        ? { catalogBinding: {
            sourceId: evidence.source.sourceId,
            catalogVersion: evidence.source.catalogVersion,
            generationDigestShort: evidence.source.snapshotDigest.replace(/^sha256:/u, '').slice(0, 8),
          } }
        : {}),
    };
    this.#tickets.set(reviewToken, {
      intent: structuredClone(intent),
      evidence: structuredClone(evidence),
      review: structuredClone(review),
      returnRoute: structuredClone(this.#normalizeRoute(returnRoute)),
    });
    this.#activeReview = structuredClone(review);
    this.#result = undefined;
    this.#router[navigation]({ name: 'review', operationId });
    this.#publish();
    return cloneFrozen(review);
  }

  executeOperation(reviewToken: string): Promise<OperationExecuteResult> {
    if (this.#retiring || this.#disposed) {
      return Promise.resolve(cloneFrozen({
        state: 'blocked',
        operationId: this.#tickets.get(reviewToken)?.review.operationId ?? 'unknown',
        code: 'sessionRetiring',
        message: '会话正在结束，未启动新操作。',
      }));
    }
    const inflight = this.#inflightOperations.get(reviewToken);
    if (inflight) return inflight.promise;
    const ticket = this.#tickets.get(reviewToken);
    const operationId = ticket?.review.operationId ?? 'unknown';
    if (!ticket) {
      return Promise.resolve(cloneFrozen({
        state: 'blocked',
        operationId,
        code: 'reviewTicketInvalid',
        message: '操作未完成。请重新检查后重试。',
      }));
    }
    this.#tickets.delete(reviewToken);
    if ((this.dependencies.now?.() ?? Date.now()) > ticket.review.expiresAt) {
      return Promise.resolve(this.#setBlocked(operationId, 'reviewTicketExpired', { intent: ticket.intent, returnRoute: ticket.returnRoute }));
    }
    const promise = this.#executeOperationTicket(ticket, operationId).finally(() => {
      if (this.#inflightOperations.get(reviewToken)?.promise === promise) {
        this.#inflightOperations.delete(reviewToken);
        this.#publish();
      }
    });
    this.#inflightOperations.set(reviewToken, { operationId, promise });
    return promise;
  }

  async #executeOperationTicket(
    ticket: ReviewTicket,
    operationId: string,
  ): Promise<OperationExecuteResult> {
    let generation = this.#generation;
    const startedAtMs = this.dependencies.now?.() ?? Date.now();
    this.#progressFeed?.clearCurrent?.();
    const dependencyTargets = ticket.intent.kind === 'pluginWriteBatch'
      ? (ticket.evidence as PluginWriteBatchEvidence).groups.flatMap((group) =>
          group.preview.dependencyPlan?.targets ?? [])
      : ticket.intent.kind === 'pluginWriteTask'
        ? (ticket.evidence as PluginWriteTaskEvidence).taskPlan.sources.flatMap((source) =>
            source.preview.dependencyPlan?.targets ?? [])
      : ticket.evidence.dependencyPlan?.targets ?? [];
    this.#progressTargets = dependencyTargets.map((target) => ({
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.resolvedScope,
      relation: target.relation === 'requested'
        ? 'requested'
        : target.depth === 1 ? 'direct' : 'transitive',
      requiredBy: target.requiredBy,
      state: target.action === 'keep' ? 'kept' as const : 'pending' as const,
    }));
    this.#progress = {
      messages: [],
      startedAtMs,
      elapsedMs: 0,
      current: {
        target: ticket.intent.kind === 'pluginWriteBatch'
          ? `${(ticket.evidence as PluginWriteBatchEvidence).requestedPluginIds.length} 个插件`
          : ticket.intent.kind === 'pluginWriteTask'
            ? `${(ticket.evidence as PluginWriteTaskEvidence).taskPlan.executableTargets.length} 个安装位置`
          : 'pluginId' in ticket.intent ? ticket.intent.pluginId
          : 'sourceId' in ticket.intent ? ticket.intent.sourceId ?? 'Catalog 管理' : 'Catalog 来源配置',
        phase: '验证当前状态',
      },
    };
    this.#router.replace({ name: 'progress', operationId });
    this.#publish();
    try {
      if (ticket.intent.kind !== 'pluginWrite' && ticket.intent.kind !== 'pluginWriteBatch'
        && ticket.intent.kind !== 'pluginWriteTask') {
        await this.dependencies.validateIntent?.(structuredClone(ticket.intent), this.#abort.signal);
      }
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      generation = ++this.#generation;
      try {
        const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        this.#applyStatus(refreshed);
      } catch (reloadError) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        await this.#logErrorSafe(reloadError, 'tuiStateReloadFailed', { privateConfigOperation: true });
      }
      return this.#setBlocked(operationId, code, {
        intent: ticket.intent,
        navigation: 'result',
        returnRoute: ticket.returnRoute,
      });
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    if (ticket.intent.kind !== 'pluginWrite' && ticket.intent.kind !== 'pluginWriteBatch'
      && ticket.intent.kind !== 'pluginWriteTask'
      && ticket.intent.kind !== 'catalogGeneration') {
      let current: OperationEvidence;
      try {
        current = await this.dependencies.captureEvidence(structuredClone(ticket.intent), this.#abort.signal);
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const code = issueCode(error);
        await this.#logOperationError(error, code, ticket.intent);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        return this.#setBlocked(operationId, code, { intent: ticket.intent, returnRoute: ticket.returnRoute });
      }
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      if (!operationEvidenceMatches(ticket.evidence, current)) {
        return this.#rebuildStaleReview(ticket, operationId, current, generation);
      }
    }
    if (ticket.intent.kind === 'sourceMutation' || ticket.intent.kind === 'catalogGeneration'
      || ticket.intent.kind === 'catalogSourcesRecovery') {
      generation = ++this.#generation;
    }
    try {
      const execution = ticket.intent.kind === 'catalogGeneration'
        ? await this.dependencies.executeIntent(
            structuredClone(ticket.intent),
            structuredClone(ticket.evidence),
            this.#abort.signal,
          )
        : await this.dependencies.executeIntent(
            structuredClone(ticket.intent),
            structuredClone(ticket.evidence),
          );
      const executionProjection = projectExecutionDiagnostics(
        execution,
        `${this.#sessionEpoch}:${operationId}`,
        collectOperationSensitiveValues(ticket.intent),
        ticket.intent.kind,
      );
      this.#operationDiagnostics.set(operationId, {
        ...executionProjection,
        sensitiveValues: collectOperationSensitiveValues(ticket.intent),
      });
      if (ticket.intent.kind === 'catalogManagement') {
        if (ticket.intent.action === 'devActivate' || ticket.intent.action === 'devDeactivate') {
          this.dependencies.beginCatalogSession?.();
          generation = ++this.#generation;
          try {
            const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
            if (!this.#operationIsCurrent(generation)) {
              return this.#detachedBlocked(operationId, ticket.intent);
            }
            this.#applyStatus(refreshed);
          } catch (reloadError) {
            if (!this.#operationIsCurrent(generation)) {
              return this.#detachedBlocked(operationId, ticket.intent);
            }
            await this.#logErrorSafe(reloadError, 'tuiStateReloadFailed', {
              privateConfigOperation: true,
            });
            this.#status = undefined;
            this.#viewModel = undefined;
            this.#phase = 'error';
            this.#loadError = {
              code: 'tuiStateReloadFailed',
              message: 'Catalog 来源已变更，但插件状态刷新失败。请重新加载后再继续操作。',
            };
            return this.#setBlocked(operationId, 'tuiStateReloadFailed', {
              intent: ticket.intent,
              navigation: 'result',
              returnRoute: ticket.returnRoute,
              writeMayHaveCompleted: true,
            });
          }
        }
        const baseSummary = operationResultSummary(ticket.intent, execution);
        const summary: OperationResultSummary = {
          ...baseSummary,
          elapsedMs: Math.max(0, (this.dependencies.now?.() ?? Date.now()) - startedAtMs),
          messages: [...this.#progress.messages, ...(baseSummary.messages ?? [])].slice(-8)
            .map((message) => sanitizeDiagnosticText(
              message,
              [],
              collectOperationSensitiveValues(ticket.intent),
            )),
        };
        const projection = this.#operationDiagnostics.get(operationId);
        if (projection) projection.effects.finalVerification = 'completed';
        this.#progress = { ...this.#progress, elapsedMs: summary.elapsedMs };
        const result: OperationExecuteResult = {
          state: summary.code === 'operationPartial' ? 'partial' : 'succeeded',
          operationId,
          summary,
          operationKind: ticket.intent.kind,
          returnRoute: structuredClone(this.#normalizeRoute(ticket.returnRoute)),
        };
        this.#result = result;
        this.#activeReview = undefined;
        this.#showResult(result, ticket.intent);
        this.#publish();
        return cloneFrozen(result);
      }
      if (ticket.intent.kind === 'sourceMutation' && ticket.intent.action === 'update') {
        const confirmedAutoCheck = catalogSourceAutoCheckOnlyValue(ticket.intent.update);
        if (confirmedAutoCheck !== undefined) {
          this.#catalogSourcesSession.setAutoCheck(ticket.intent.sourceId, confirmedAutoCheck);
        }
      }
      const executionTargets = operationResultSummary(ticket.intent, execution).targets ?? [];
      this.#progressTargets = this.#progressTargets.map((target) => {
        const completed = executionTargets.find((candidate) =>
          candidate.pluginId === target.pluginId
          && candidate.platform === target.platform && candidate.scope === target.scope);
        return completed ? { ...target, state: completed.state } : target;
      });
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      generation = ++this.#generation;
      if (ticket.intent.kind === 'sourceMutation' || ticket.intent.kind === 'catalogGeneration'
        || ticket.intent.kind === 'catalogSourcesRecovery') {
        this.dependencies.beginCatalogSession?.(ticket.intent.kind === 'sourceMutation' ? {
          reuseValidatedGenerations: true,
        } : undefined);
        try {
          this.#progressFeed?.setCurrent(
            { target: 'Catalog 来源', phase: '读取最终状态' },
            'Catalog 操作：读取最终状态',
          );
        } catch {
          // Progress diagnostics must not replace the completed source write.
        }
      }
      let refreshed: TuiStatusLoadResult;
      try {
        refreshed = await this.dependencies.loadStatus(this.#abort.signal);
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const verificationCode = ticket.intent.kind === 'pluginWrite' && ticket.intent.originIssue
          ? 'issueVerificationFailed'
          : 'tuiStateReloadFailed';
        await this.#logErrorSafe(error, verificationCode, {
          privateConfigOperation: true,
        });
        const existingProjection = this.#operationDiagnostics.get(operationId)!;
        existingProjection.diagnostics.push(projectThrownOperationDiagnostic({
          error,
          id: `${this.#sessionEpoch}:${operationId}:status-reload`,
          stage: 'statusReload',
          fallbackCode: verificationCode,
        }));
        existingProjection.effects.finalVerification = 'failed';
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const configCommitted = typeof execution === 'object'
          && execution !== null
          && (execution as { configWrite?: unknown }).configWrite === 'succeeded';
        if ((ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset')
          && configCommitted) {
          const baseSummary = operationResultSummary(ticket.intent, execution);
          const elapsedMs = Math.max(0, (this.dependencies.now?.() ?? Date.now()) - startedAtMs);
          const summary: OperationResultSummary = {
            ...baseSummary,
            code: 'operationPartial',
            message: '设置已保存，但最终状态无法刷新。',
            elapsedMs,
            messages: [
              ...this.#progress.messages,
              ...(baseSummary.messages ?? []),
              '状态刷新失败。配置写入已经提交；请稍后刷新状态。',
            ].slice(-8).map((message) => sanitizeDiagnosticText(
              message,
              [],
              collectOperationSensitiveValues(ticket.intent),
            )),
          };
          this.#progress = { ...this.#progress, elapsedMs };
          const result: OperationExecuteResult = {
            state: 'partial',
            operationId,
            summary,
            operationKind: ticket.intent.kind,
            pluginId: ticket.intent.pluginId,
            returnRoute: structuredClone(this.#normalizeRoute(ticket.returnRoute)),
          };
          this.#result = structuredClone(result);
          this.#activeReview = undefined;
          this.#showResult(result, ticket.intent);
          this.#publish();
          return cloneFrozen(result);
        }
        return this.#setBlocked(operationId, verificationCode, {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          writeMayHaveCompleted: true,
          verification: ticket.intent.kind === 'pluginWrite' && ticket.intent.originIssue
            ? 'verificationFailed' : undefined,
        });
      }
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#applyStatus(refreshed);
      if (ticket.intent.kind === 'catalogGeneration') {
        const completed = typeof execution === 'object' && execution !== null
          ? (execution as { generation?: CatalogGenerationSyncResult }).generation
          : undefined;
        const active = this.#catalogGenerations.get(ticket.intent.sourceId)?.active;
        if (completed && active
          && active.catalogVersion === completed.resolution.catalogVersion
          && active.resolvedCommit === completed.resolution.resolvedCommit) {
          this.#catalogSourcesSession.recordVerifiedGeneration(ticket.intent.sourceId, active);
        }
      }
      const verifiedProjection = this.#operationDiagnostics.get(operationId);
      if (verifiedProjection && verifiedProjection.effects.finalVerification !== 'failed') {
        verifiedProjection.effects.finalVerification = 'completed';
      }
      if (ticket.intent.kind === 'catalogSourcesRecovery') {
        this.#phase = 'ready';
        this.#loadError = undefined;
      }
      const pluginSummary = ticket.intent.kind === 'pluginWrite'
        || ticket.intent.kind === 'pluginWriteBatch'
        || ticket.intent.kind === 'pluginWriteTask'
        ? operationResultSummary(ticket.intent, execution)
        : undefined;
      const hasFailedDependencyTarget = pluginSummary?.targets?.some((target) =>
        target.relation !== undefined && target.relation !== 'requested'
        && (target.state === 'failed' || target.state === 'skipped'));
      const hasPreservedTarget = pluginSummary?.targets?.some((target) =>
        target.state === 'completed' || target.state === 'kept');
      const dependencyPartial = pluginSummary?.code === 'operationPartial'
        && Boolean(hasFailedDependencyTarget && hasPreservedTarget);
      const dependencyFailure = pluginSummary?.code === 'operationFailed'
        && Boolean(hasFailedDependencyTarget);
      if (pluginSummary?.code === 'operationFailed') {
        const projected = this.#operationDiagnostics.get(operationId);
        if (projected) {
          projected.targets = (pluginSummary.targets ?? []).map((target) => ({
            ...target,
            diagnosticIds: projected.diagnostics.filter((diagnostic) => diagnostic.target
              && diagnostic.target.platform === target.platform
              && diagnostic.target.scope === target.scope
              && (diagnostic.target.pluginId === undefined || diagnostic.target.pluginId === target.pluginId))
              .map((diagnostic) => diagnostic.id),
            effects: projected.targetEffects?.get(`${target.pluginId ?? ''}\0${target.platform}\0${target.scope}`),
          }));
        }
        const unsuccessfulTargets = pluginSummary.targets?.filter((target) =>
          target.state === 'failed' || target.state === 'skipped') ?? [];
        const managerFailureCode = unsuccessfulTargets.map((target) => target.errorCode).find((code) =>
          code === 'codexSystemCliUnsupported'
          || code === 'managedCodexAuthorizationRequired'
          || code === 'managedCodexUnavailable');
        if (managerFailureCode) {
          return this.#setBlocked(operationId, managerFailureCode, {
            intent: ticket.intent,
            navigation: 'result',
            returnRoute: ticket.returnRoute,
            summary: pluginSummary,
          });
        }
        const dependencyStillRequired = unsuccessfulTargets.length > 0
          && unsuccessfulTargets.every((target) => target.errorCode === 'dependencyStillRequired');
        return this.#setBlocked(operationId, dependencyStillRequired ? 'dependencyStillRequired' : 'operationFailed', {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          ...(ticket.intent.kind === 'pluginWriteBatch' || ticket.intent.kind === 'pluginWriteTask'
            || dependencyFailure || dependencyStillRequired
            ? { summary: pluginSummary } : {}),
          ...(ticket.intent.kind !== 'pluginWriteBatch' && ticket.intent.kind !== 'pluginWriteTask'
            && !dependencyFailure && !dependencyStillRequired && ['started', 'partial', 'completed', 'failed', 'unknown'].includes(
            this.#operationDiagnostics.get(operationId)?.effects.awWrite ?? 'unknown',
          ) ? { writeMayHaveCompleted: true } : {}),
        });
      }
      const originIssue = ticket.intent.kind === 'pluginWrite' ? ticket.intent.originIssue : undefined;
      if (originIssue && !dependencyPartial
        && this.#viewModel?.issues.some((issue) => originIssueRemains(issue, originIssue))) {
        return this.#setBlocked(operationId, 'issueStillPresent', {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          writeMayHaveCompleted: true,
          verification: 'issueStillPresent',
        });
      }
      if (ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset') {
        const configWrite = typeof execution === 'object' && execution !== null
          ? (execution as { configWrite?: unknown }).configWrite
          : undefined;
        if (configWrite !== 'succeeded') {
          return this.#setBlocked(operationId, 'configWriteUnconfirmed', {
            intent: ticket.intent,
            navigation: 'back',
          });
        }
      }
      const baseSummary = dependencyPartial && pluginSummary
        ? { ...pluginSummary, code: 'operationPartial' as const, message: '依赖安装没有全部完成。' }
        : pluginSummary ?? operationResultSummary(ticket.intent, execution);
      const summary: OperationResultSummary = {
        ...baseSummary,
        elapsedMs: Math.max(0, (this.dependencies.now?.() ?? Date.now()) - startedAtMs),
        messages: [...this.#progress.messages, ...(baseSummary.messages ?? [])].slice(-8)
          .map((message) => sanitizeDiagnosticText(
            message,
            [],
            collectOperationSensitiveValues(ticket.intent),
          )),
      };
      this.#progress = { ...this.#progress, elapsedMs: summary.elapsedMs };
      if (summary.code === 'operationFailed') {
        if (ticket.intent.kind === 'portableInstall') {
          const result: OperationExecuteResult = {
            state: 'partial',
            operationId,
            summary,
            operationKind: ticket.intent.kind,
            pluginId: ticket.intent.pluginId,
            returnRoute: structuredClone(this.#normalizeRoute(ticket.returnRoute)),
          };
          this.#result = structuredClone(result);
          this.#activeReview = undefined;
          this.#showResult(result, ticket.intent);
          this.#publish();
          return cloneFrozen(result);
        }
        return this.#setBlocked(operationId, 'operationFailed', {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          writeMayHaveCompleted: true,
        });
      }
      const result: OperationExecuteResult = {
        state: summary.code === 'operationPartial' ? 'partial' : 'succeeded',
        operationId,
        summary,
        operationKind: ticket.intent.kind,
        ...(ticket.intent.kind === 'sourceMutation' ? { sourceAction: ticket.intent.action } : {}),
        ...('pluginId' in ticket.intent ? { pluginId: ticket.intent.pluginId } : {}),
        ...(ticket.intent.kind === 'pluginWrite' && ticket.intent.originIssue
          ? { originIssue: ticket.intent.originIssue }
          : {}),
        returnRoute: structuredClone(this.#normalizeRoute(
          ticket.intent.kind === 'sourceMutation' && ticket.intent.action === 'add'
            ? { name: 'sourceList' }
            : ticket.intent.kind === 'sourceMutation' && ticket.intent.action === 'update'
              ? { name: 'sourceDetail', sourceId: ticket.intent.sourceId }
              : ticket.intent.kind === 'catalogGeneration'
                ? ticket.returnRoute.name === 'pluginWriteTask'
                  ? ticket.returnRoute
                  : { name: 'sourceDetail', sourceId: ticket.intent.sourceId }
              : ticket.returnRoute,
        )),
      };
      if ((ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset')
        && this.#portableRepreparePluginId === ticket.intent.pluginId) {
        this.#operationDiagnostics.delete(operationId);
        this.#portableRepreparePluginId = undefined;
        this.#activeReview = undefined;
        this.#result = undefined;
        await this.preparePortableInstall(ticket.intent.pluginId, 'replace');
        return cloneFrozen(result);
      }
      this.#result = result;
      this.#activeReview = undefined;
      this.#showResult(result, ticket.intent);
      this.#publish();
      return cloneFrozen(result);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      const metadata = readSafeOperationError(error);
      const preApply = metadata?.stage === 'preApply';
      const configWrite = error && typeof error === 'object' && 'configWrite' in error
        ? (error as { configWrite?: unknown }).configWrite : undefined;
      this.#captureThrownProjection(operationId, error, code, 'execute', ticket.intent, {
        configCommit: ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset'
          ? configWrite === 'succeeded' ? 'completed'
            : configWrite === 'failed' ? 'failed' : 'notStarted' : 'notApplicable',
        awWrite: preApply ? 'notStarted' : 'unknown',
        preApplyExternalEffect: preApply ? 'possible' : 'notApplicable',
        finalVerification: 'notStarted',
      });
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      if (code === 'operationReviewStale' || code === 'catalogGenerationReviewStale') {
        return this.#rebuildStaleReview(ticket, operationId, undefined, generation);
      }
      if (ticket.intent.kind === 'catalogManagement') {
        return this.#setBlocked(operationId, code, {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          writeMayHaveCompleted: true,
        });
      }
      generation = ++this.#generation;
      let finalVerification: OperationEffectFacts['finalVerification'] = 'completed';
      try {
        const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        this.#applyStatus(refreshed);
        const projection = this.#operationDiagnostics.get(operationId);
        if (projection) projection.effects.finalVerification = 'completed';
        if (ticket.intent.kind === 'catalogSourcesRecovery'
          && code === 'catalogSourcesConfigRecoveryStale') {
          this.#phase = 'ready';
          this.#loadError = undefined;
          return this.#setBlocked(operationId, code, {
            intent: ticket.intent,
            navigation: 'result',
            returnRoute: ticket.returnRoute,
            writeMayHaveCompleted: false,
          });
        }
      } catch (reloadError) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        finalVerification = 'failed';
        const projection = this.#operationDiagnostics.get(operationId);
        if (projection) projection.effects.finalVerification = 'failed';
        await this.#logErrorSafe(reloadError, 'tuiStateReloadFailed', {
          privateConfigOperation: true,
        });
        if (ticket.intent.kind === 'catalogSourcesRecovery'
          && code === 'catalogSourcesConfigRecoveryStale') {
          this.#phase = 'error';
          this.#loadError = {
            code: issueCode(reloadError),
            message: '无法安全读取插件状态。请检查诊断后重试或退出。',
          };
        }
      }
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      if ((ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset')
        && configWrite === 'succeeded') {
        const elapsedMs = Math.max(0, (this.dependencies.now?.() ?? Date.now()) - startedAtMs);
        const summary: OperationResultSummary = {
          code: 'operationPartial',
          message: ticket.intent.kind === 'configReset'
            ? '设置层重置已提交，但后续步骤未完成。'
            : finalVerification === 'failed'
              ? ticket.intent.apply
                ? '设置已保存，但后续应用或状态复核失败。'
                : '设置已保存，但状态复核失败。'
              : ticket.intent.apply
                ? '设置已保存，但后续应用失败。'
                : '设置已保存，但后续步骤未完成。',
          pluginId: ticket.intent.pluginId,
          configScope: ticket.intent.scope,
          ...(ticket.intent.kind === 'configSave' && ticket.intent.apply
            ? { configApplyRetryAvailable: true } : {}),
          elapsedMs,
          messages: [ticket.intent.kind === 'configReset'
            ? '设置层重置已经提交；失败的后续步骤没有恢复旧设置。'
            : '配置写入已经提交；失败的后续步骤没有回滚设置。'],
        };
        this.#progress = { ...this.#progress, elapsedMs };
        const result: OperationExecuteResult = {
          state: 'partial',
          operationId,
          summary,
          operationKind: ticket.intent.kind,
          pluginId: ticket.intent.pluginId,
          returnRoute: structuredClone(this.#normalizeRoute(ticket.returnRoute)),
        };
        this.#result = structuredClone(result);
        this.#activeReview = undefined;
        this.#showResult(result, ticket.intent);
        this.#publish();
        return cloneFrozen(result);
      }
      return this.#setBlocked(operationId, code, {
        intent: ticket.intent,
        navigation: 'result',
        returnRoute: ticket.returnRoute,
        writeMayHaveCompleted: ticket.intent.kind === 'catalogSourcesRecovery' ? false : true,
      });
    }
  }

  #operationIsCurrent(generation: number): boolean {
    return !this.#disposed && !this.#abort.signal.aborted && generation === this.#generation;
  }

  #detachedBlocked(operationId: string, intent: OperationIntent): OperationExecuteResult {
    this.#operationDiagnostics.delete(operationId);
    return cloneFrozen({
      state: 'blocked',
      operationId,
      code: 'operationCancelled',
      message: '操作已停止。',
      ...this.#operationIdentity(intent),
    });
  }

  async #rebuildStaleReview(
    ticket: ReviewTicket,
    operationId: string,
    currentEvidence?: OperationEvidence,
    generation = this.#generation,
  ): Promise<OperationExecuteResult> {
    if (ticket.intent.kind === 'catalogManagement') {
      let evidence = currentEvidence;
      try {
        evidence ??= await this.dependencies.captureEvidence(
          structuredClone(ticket.intent),
          this.#abort.signal,
        );
      } catch (error) {
        const code = issueCode(error);
        this.#appendThrownProjection(operationId, error, code, 'reviewPreparation', ticket.intent);
        await this.#logOperationError(error, code, ticket.intent);
        return this.#setBlocked(operationId, code, {
          intent: ticket.intent,
          returnRoute: ticket.returnRoute,
        });
      }
      const review = this.#storeOperationReview(
        ticket.intent,
        evidence,
        'replace',
        ticket.returnRoute,
      );
      const result: OperationExecuteResult = {
        state: 'stale',
        operationId,
        review,
        ...this.#operationIdentity(ticket.intent),
      };
      this.#recordStaleAttempt(operationId, ticket.intent);
      this.#result = result;
      this.#publish();
      return cloneFrozen(result);
    }
    this.dependencies.beginCatalogSession?.();
    generation = ++this.#generation;
    try {
      const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#applyStatus(refreshed);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#appendThrownProjection(operationId, error, 'tuiStateReloadFailed', 'statusReload', ticket.intent);
      await this.#logErrorSafe(error, 'tuiStateReloadFailed', { privateConfigOperation: true });
      return this.#setBlocked(operationId, 'tuiStateReloadFailed', {
        intent: ticket.intent,
        navigation: 'result',
        returnRoute: ticket.returnRoute,
      });
    }
    const intent: OperationIntent = ticket.intent;
    try {
      await this.dependencies.validateIntent?.(structuredClone(intent), this.#abort.signal);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      this.#appendThrownProjection(operationId, error, code, 'validate', intent);
      await this.#logOperationError(error, code, intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const result: OperationExecuteResult = {
        state: 'blocked',
        operationId,
        code,
        message: '状态已变化，原操作不再安全。请修改选择后重试。',
        ...this.#operationIdentity(intent),
        returnRoute: structuredClone(this.#normalizeRoute(ticket.returnRoute)),
      };
      this.#result = structuredClone(result);
      this.#activeReview = undefined;
      this.#showResult(result, ticket.intent);
      this.#publish();
      return cloneFrozen(result);
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    let evidence = currentEvidence;
    if (!evidence) {
      try {
        evidence = await this.dependencies.captureEvidence(
          structuredClone(intent),
          this.#abort.signal,
        );
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const code = issueCode(error);
        this.#appendThrownProjection(operationId, error, code, 'reviewPreparation', intent);
        await this.#logOperationError(error, code, intent);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        return this.#setBlocked(operationId, code, { intent, returnRoute: ticket.returnRoute });
      }
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    if (intent.kind === 'portableInstall') {
      try {
        await this.refreshPortableInstallDraft(intent.pluginId);
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const code = issueCode(error);
        await this.#logOperationError(error, code, intent);
        return this.#setBlocked(operationId, code, { intent, returnRoute: ticket.returnRoute });
      }
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    const review = this.#storeOperationReview(intent, evidence, 'replace', ticket.returnRoute);
    const result: OperationExecuteResult = { state: 'stale', operationId, review, ...this.#operationIdentity(intent) };
    this.#recordStaleAttempt(operationId, intent);
    this.#result = result;
    this.#publish();
    return cloneFrozen(result);
  }

  #setBlocked(
    operationId: string,
    code: string,
    options?: {
      intent?: OperationIntent;
      navigation?: 'back' | 'result';
      returnRoute?: TuiRoute;
      writeMayHaveCompleted?: boolean;
      verification?: 'issueStillPresent' | 'verificationFailed';
      summary?: OperationResultSummary;
    },
  ): OperationExecuteResult {
    if (!this.#operationDiagnostics.has(operationId)) {
      this.#captureThrownProjection(operationId, undefined, code, 'execute', options?.intent);
    }
    const message = code === 'managedCodexAuthorizationRequired'
      ? '操作在插件写入前停止。请在 Review 中确认获取 Codex runtime，或在命令行传入 --allow-managed-codex-install。'
      : code === 'codexSystemCliUnsupported'
        ? '操作在插件写入前停止。系统 Codex CLI 版本不受支持。请升级官方 Codex CLI 后重试。'
        : code === 'managedCodexUnavailable'
          ? '操作在插件写入前停止。Codex runtime 当前不可用。请重试、升级 AW，或安装官方 Codex CLI。'
          : code === 'portableSkillsCliInstallFailed'
      ? 'Skills CLI 安装失败。请修改 Agent 或重试。'
      : options?.writeMayHaveCompleted
      ? '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。'
      : code === 'configResetStillPresent'
          ? '重置执行后设置层仍然存在。请重新检查设置问题。'
        : code === 'issueStillPresent'
          ? '写入已完成，但重新检查后原问题仍然存在。'
          : '操作未完成。请重新检查后重试。';
    const result: OperationExecuteResult = {
      state: 'blocked',
      operationId,
      code,
      message,
      ...(options?.intent ? this.#operationIdentity(options.intent) : {}),
      ...(options?.returnRoute ? { returnRoute: structuredClone(this.#normalizeRoute(options.returnRoute)) } : {}),
      ...(options?.writeMayHaveCompleted ? { writeMayHaveCompleted: true } : {}),
      ...(options?.verification ? { verification: options.verification } : {}),
      ...(options?.summary ? { summary: structuredClone(options.summary) } : {}),
    };
    this.#result = structuredClone(result);
    this.#activeReview = undefined;
    if (options?.navigation === 'back') {
      this.#router.back();
      this.#normalizeCurrentRoute();
    }
    else if (options?.intent) this.#showResult(result, options.intent);
    else this.#router.replace({ name: 'result', operationId });
    this.#publish();
    return cloneFrozen(result);
  }

  #operationIdentity(intent: OperationIntent): {
    operationKind: OperationKind;
    sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
    pluginId?: string;
    originIssue?: IssueOrigin;
  } {
    return {
      operationKind: intent.kind,
      ...(intent.kind === 'sourceMutation' ? { sourceAction: intent.action } : {}),
      ...('pluginId' in intent ? { pluginId: intent.pluginId } : {}),
      ...(intent.kind === 'pluginWrite' && intent.originIssue
        ? { originIssue: intent.originIssue }
        : {}),
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    this.#catalogSourcesSession.dispose();
    this.#abort.abort();
    this.#progressUnsubscribe?.();
    this.#tickets.clear();
    this.#phase = 'disposed';
    this.#listeners.clear();
  }
}

function operationResultSummaryUnsafe(intent: OperationIntent, execution: unknown): OperationResultSummary {
  if (intent.kind === 'catalogManagement') {
    const result = execution as import('./catalog-management.js').CatalogManagementExecutionResult;
    return {
      code: result.state === 'partial' ? 'operationPartial' : 'operationSucceeded',
      message: result.message,
      messages: result.messages,
      catalogManagement: {
        action: result.action,
        state: result.state,
        ...(result.catalogVersion ? { catalogVersion: result.catalogVersion } : {}),
        ...(result.planDigest ? { planDigest: result.planDigest } : {}),
        ...(result.store ? { store: structuredClone(result.store) } : {}),
        ...(result.publication ? { publication: structuredClone(result.publication) } : {}),
      },
    };
  }
  if (intent.kind === 'catalogSourcesRecovery') {
    const result = execution as { backupPath: string };
    return {
      code: 'operationSucceeded',
      message: 'Catalog 来源配置已恢复。',
      messages: [
        `损坏配置已备份为 ${result.backupPath}。`,
        '已恢复唯一的主来源 official；自定义来源需要重新添加。',
      ],
    };
  }
  if (intent.kind === 'catalogGeneration') {
    const result = execution as {
      status?: 'succeeded' | 'partial';
      partialReason?: 'activation' | 'primary';
      configSaved?: boolean;
      errorCode?: string;
      generation?: CatalogGenerationSyncResult;
    };
    const generation = result.generation;
    const updateActivated = intent.action === 'update'
      && generation?.activeChanged === true
      && generation.outcome === 'activated';
    return {
      code: result.status === 'partial' ? 'operationPartial' : 'operationSucceeded',
      catalogAction: intent.action,
      ...(generation ? { catalogGeneration: {
        activeChanged: generation.activeChanged,
        outcome: generation.outcome,
        catalogVersion: generation.resolution.catalogVersion,
      } } : {}),
      message: result.status === 'partial'
        ? result.partialReason === 'primary'
          ? 'Catalog 已启用，但主来源尚未切换。可在 TUI 中重试。'
          : '来源配置已保存，但 Catalog 尚未启用。可在 TUI 中立即重试。'
        : intent.action === 'repair' ? 'Catalog 已重新下载并修复。'
          : intent.action === 'replaceDamaged' ? '损坏的 Active Catalog 已由当前候选替换。'
          : intent.action === 'recoverState' ? '目录版本状态已恢复，目标来源已启用。'
            : updateActivated ? `Catalog 已更新到 ${generation.resolution.catalogVersion}。`
              : intent.action === 'update' ? 'Catalog 已验证，Active 未变化。'
              : 'Catalog 已验证并启用。',
      messages: result.status === 'partial'
        ? [result.partialReason === 'primary'
            ? `新的已启用版本可用；主来源保持不变。错误：${result.errorCode ?? 'catalogSourcePrimaryFailed'}`
            : `旧的已启用版本保持不变。错误：${result.errorCode ?? 'catalogGenerationRefreshFailed'}`]
        : updateActivated
          ? ['已安装插件不会自动升级。', '已重新计算可用的插件升级。']
          : intent.action === 'update'
            ? [`当前 Active Catalog 已是 ${generation?.resolution.catalogVersion ?? '已验证版本'}。`]
          : ['Plugin 列表已从新的 Active Catalog 重新加载。'],
    };
  }
  if (intent.kind === 'portableInstall') {
    const receipt = execution as PortableInstallReceipt;
    const verificationUnknown = receipt.failures.some((failure) =>
      failure.code === 'portableSkillsCliVerificationFailed'
      && receipt.verification.records.length === 0
      && receipt.verification.missing.length === 0);
    return {
      code: receipt.status === 'succeeded' ? 'operationSucceeded'
        : receipt.status === 'partial' ? 'operationPartial' : 'operationFailed',
      message: receipt.status === 'succeeded' ? '通用 Skills 已安装。'
        : receipt.status === 'partial' ? '安装命令已完成，但结果无法完全确认。'
          : 'Skills CLI 安装失败。',
      pluginId: intent.pluginId,
      messages: [
        ...receipt.selectedSkills.map((skill) => skill.name),
        ...receipt.failures.map((failure) => failure.message),
      ],
      portable: {
        selectedSkills: receipt.selectedSkills.map((skill) => skill.name),
        agentMode: receipt.agentMode,
        requestedAgents: receipt.requestedAgents,
        scope: receipt.scope,
        materializationDigest: receipt.materializationDigest,
        skillsCliVersion: receipt.skillsCliVersion,
        missing: receipt.verification.missing,
        verificationUnknown,
        ...(receipt.failures[0]?.recovery ? { recovery: receipt.failures[0].recovery } : {}),
        ...(receipt.failures[0]?.code ? { failureCode: receipt.failures[0].code } : {}),
      },
    };
  }
  if (intent.kind === 'pluginWriteTask') {
    const taskExecution = execution as PluginWriteTaskExecutionResult;
    const failedTargets = pluginWriteTaskFailedRequestedTargets(taskExecution);
    const failedKeys = new Set(failedTargets.map(pluginWriteTaskTargetKey));
    const technicalTargets = taskExecution.targetResults.map((entry) => {
      const placement = taskExecution.dependencyPlan?.targets.find((target) =>
        target.pluginId === entry.target.pluginId && target.platform === entry.target.platform
        && (target.requestedScope ?? target.resolvedScope) === entry.target.scope);
      return {
        pluginId: entry.target.pluginId,
        platform: entry.target.platform,
        scope: entry.target.scope,
        state: entry.action === 'skipped' ? 'skipped' as const
          : entry.state === 'failed' ? 'failed' as const
            : entry.action === 'keep' ? 'kept' as const : 'completed' as const,
        relation: entry.relation === 'requested' ? 'requested' as const
          : placement?.depth === 1 ? 'direct' as const : 'transitive' as const,
        requiredBy: entry.requiredBy,
        ...(entry.errorCode ? { errorCode: safeDiagnosticCode(entry.errorCode, 'writeFailed') } : {}),
      };
    });
    const blocked = new Map(taskExecution.taskPlan.blockedTargets.map((entry) => [
      pluginWriteTaskTargetKey(entry.target), entry,
    ]));
    const relatedResults = (target: PluginWriteTaskTarget) => {
      const key = pluginWriteTaskTargetKey(target);
      const source = taskExecution.sourceResults.find((candidate) =>
        candidate.requestedTargets.some((requested) => pluginWriteTaskTargetKey(requested) === key));
      const related = source?.result.targetResults.filter((entry) => {
        const pluginId = entry.target.pluginId;
        if (!pluginId) return false;
        const executionKey = pluginWriteTaskTargetKey({
          pluginId,
          platform: entry.target.platform,
          scope: entry.target.scope,
        });
        if (executionKey === key) return true;
        if (taskExecution.taskPlan.causes.some((cause) =>
          pluginWriteTaskTargetKey(cause.repairTarget) === executionKey
          && cause.consumers.some((consumer) => pluginWriteTaskTargetKey(consumer) === key))) return true;
        const placement = source.result.dependencyPlan?.targets.find((candidate) =>
          candidate.pluginId === pluginId && candidate.platform === entry.target.platform
          && (candidate.requestedScope ?? candidate.resolvedScope) === entry.target.scope);
        return placement?.requiredByTargets?.some((consumer) =>
          pluginWriteTaskTargetKey(consumer) === key) ?? false;
      }) ?? [];
      const targetResults: PluginWriteTaskRootResult['targets'] = related.map((entry) => {
        const placement = source?.result.dependencyPlan?.targets.find((candidate) =>
          candidate.pluginId === entry.target.pluginId
          && candidate.platform === entry.target.platform
          && (candidate.requestedScope ?? candidate.resolvedScope) === entry.target.scope);
        return {
          pluginId: entry.target.pluginId,
          platform: entry.target.platform,
          scope: entry.target.scope,
          state: entry.action === 'skipped' ? 'skipped' as const
            : entry.state === 'failed' ? 'failed' as const
              : entry.action === 'keep' ? 'kept' as const : 'completed' as const,
          relation: entry.relation === 'requested' ? 'requested' as const
            : placement?.depth === 1 ? 'direct' as const : 'transitive' as const,
          ...(entry.errorCode ? { errorCode: safeDiagnosticCode(entry.errorCode, 'writeFailed') } : {}),
        };
      });
      if (blocked.has(key) && !targetResults.some((entry) =>
        entry.pluginId === target.pluginId && entry.platform === target.platform
        && entry.scope === target.scope)) {
        targetResults.unshift({
          pluginId: target.pluginId,
          platform: target.platform,
          scope: target.scope,
          state: 'skipped',
          relation: 'requested',
        });
      }
      const hasFailed = targetResults.some((entry) => entry.state === 'failed' || entry.state === 'skipped');
      const hasCompleted = targetResults.some((entry) => entry.state === 'completed' || entry.state === 'kept');
      const state: PluginWriteTaskRootResult['state'] = blocked.has(key) ? 'blocked'
        : !source ? 'notStarted'
          : hasFailed && hasCompleted ? 'partial'
            : hasFailed || failedKeys.has(key) ? 'failed'
              : targetResults.length > 0 && targetResults.every((entry) => entry.state === 'kept')
                ? 'kept' : targetResults.length > 0 ? 'completed' : 'notStarted';
      return { state, targets: targetResults };
    };
    const roots: PluginWriteTaskRootResult[] = [...new Set(taskExecution.taskPlan.requestedTargets
      .map((target) => target.pluginId))].map((pluginId) => {
      const requestedTargets = taskExecution.taskPlan.requestedTargets.filter((target) =>
        target.pluginId === pluginId);
      const positions = requestedTargets.map((target) => relatedResults(target));
      const successfulPositions = positions.filter((position) =>
        position.state === 'completed' || position.state === 'kept');
      const state: PluginWriteTaskRootResult['state'] = successfulPositions.length > 0
        ? successfulPositions.length === positions.length
          ? positions.every((position) => position.state === 'kept') ? 'kept' : 'completed'
          : 'partial'
        : positions.some((position) => position.state === 'failed' || position.state === 'partial')
          ? 'failed'
          : positions.some((position) => position.state === 'notStarted') ? 'notStarted' : 'blocked';
      const targets = [...new Map(positions.flatMap((position) => position.targets).map((target) => [[
        target.pluginId ?? '', target.platform, target.scope,
      ].join('\0'), target] as const)).values()];
      const causeKeys = [...new Set(taskExecution.taskPlan.causes.filter((cause) =>
        cause.consumers.some((consumer) => consumer.pluginId === pluginId))
        .map((cause) => cause.causeKey))];
      return { pluginId, state, causeKeys, targets };
    });
    const retryTargets = canonicalPluginWriteTaskTargets(roots.flatMap((root) =>
      root.state === 'failed' || root.state === 'partial' || root.state === 'notStarted'
        ? failedTargets.filter((target) => target.pluginId === root.pluginId) : []));
    const completedCount = roots.filter((root) => root.state === 'completed'
      || root.state === 'kept' || root.state === 'partial').length;
    const failedCount = roots.filter((root) => root.state === 'failed' || root.state === 'partial'
      || root.state === 'notStarted' || root.state === 'blocked').length;
    const code = failedCount === 0 ? 'operationSucceeded' as const
      : completedCount > 0 ? 'operationPartial' as const : 'operationFailed' as const;
    return {
      code,
      message: code === 'operationSucceeded' ? '任务已完成。'
        : code === 'operationPartial' ? '任务只完成了一部分。' : '任务没有完成。',
      warnings: taskExecution.warnings,
      recoveryActions: [...new Set(taskExecution.targetResults.flatMap((entry) =>
        entry.recoveryActions ?? []))],
      ...(taskExecution.operationPlan?.planFingerprint
        ? { planFingerprint: taskExecution.operationPlan.planFingerprint } : {}),
      task: {
        goal: intent.goal,
        requestedTargets: taskExecution.taskPlan.requestedTargets,
        rootResults: roots,
        ...(retryTargets.length > 0 ? { retryTargets } : {}),
        blockedTargets: taskExecution.taskPlan.blockedTargets,
      },
      targets: technicalTargets,
    };
  }
  if (intent.kind === 'pluginWrite' || intent.kind === 'pluginWriteBatch') {
    const command = intent.action === 'refreshAndSync' ? 'sync' : intent.action;
    const rawExecution = typeof execution === 'object' && execution !== null
      ? execution as Record<string, unknown>
      : {};
    const requestedPluginIds = intent.kind === 'pluginWriteBatch'
      ? canonicalPluginIds((execution as PluginWriteBatchExecutionResult).requestedPluginIds ?? [])
      : [intent.pluginId];
    const fallbackPluginId = requestedPluginIds[0] ?? 'unknown/plugin';
    const normalizedTargetResults = Array.isArray(rawExecution.targetResults)
      ? rawExecution.targetResults.map((candidate) => {
          if (typeof candidate !== 'object' || candidate === null) return candidate;
          const entry = candidate as Record<string, unknown>;
          const rawTarget = typeof entry.target === 'object' && entry.target !== null
            ? entry.target as Record<string, unknown>
            : {};
          const pluginId = typeof rawTarget.pluginId === 'string'
            ? rawTarget.pluginId : undefined;
          return {
            ...entry,
            target: {
              ...rawTarget,
              ...(pluginId ? { pluginId } : {}),
              pluginName: typeof rawTarget.pluginName === 'string'
                ? rawTarget.pluginName : pluginNameFromId(pluginId ?? fallbackPluginId),
            },
            action: typeof entry.action === 'string'
              ? entry.action : requestedIntentAction(command),
          };
        })
      : undefined;
    const receipt = buildRebuildReceiptJson(
      command,
      {
        ...rawExecution,
        ...(normalizedTargetResults ? { targetResults: normalizedTargetResults } : {}),
        platforms: Array.isArray(rawExecution.platforms) ? rawExecution.platforms as string[] : [],
        plugins: Array.isArray(rawExecution.plugins) ? rawExecution.plugins as string[] : requestedPluginIds,
        warnings: Array.isArray(rawExecution.warnings) ? rawExecution.warnings as string[] : [],
      } as Parameters<typeof buildRebuildReceiptJson>[1],
    );
    const result = buildOperationResultModel(receipt);
    const requestedIds = new Set(receipt.requestedPluginIds ?? requestedPluginIds);
    const retryTargets = intent.kind === 'pluginWriteBatch'
      ? pluginWriteBatchFailedRequestedTargets(execution as PluginWriteBatchExecutionResult)
      : [];
    const failedRequestedPluginIds = canonicalPluginIds(retryTargets.map((target) => target.pluginId));
    const requestedTargetKeys = intent.kind === 'pluginWriteBatch'
      ? new Set((execution as PluginWriteBatchExecutionResult).groupResults.flatMap((group) => {
          const roots = new Set(group.requestedPluginIds);
          return group.result.targetResults.flatMap((entry) => entry.target.pluginId
            && roots.has(entry.target.pluginId)
            && entry.target.scope === group.scope
            && (group.platform === 'both' || entry.target.platform === group.platform)
            ? [[entry.target.pluginId, entry.target.platform, entry.target.scope].join('\0')]
            : []);
        }))
      : new Set<string>();
    const rootResults: PluginWriteBatchRootResult[] = intent.kind === 'pluginWriteBatch'
      ? requestedPluginIds.map((pluginId) => {
          const observed = (result.targetResults ?? []).flatMap((entry) =>
            entry.target.pluginId === pluginId
              && requestedTargetKeys.has([
                pluginId, entry.target.platform, entry.target.scope,
              ].join('\0')) ? [{
              pluginId,
              platform: entry.target.platform,
              scope: entry.target.scope,
              state: entry.action === 'skipped' ? 'skipped' as const
                : entry.state === 'failed' ? 'failed' as const
                  : entry.action === 'keep' ? 'kept' as const : 'completed' as const,
              relation: 'requested' as const,
              ...(entry.errorCode
                ? { errorCode: safeDiagnosticCode(entry.errorCode, 'writeFailed') }
                : {}),
            }] : []);
          const targets = [...new Map([
            ...retryTargets.filter((target) => target.pluginId === pluginId).map((target) => ({
              ...target,
              state: 'skipped' as const,
              relation: 'requested' as const,
            })),
            ...observed,
          ].map((target) => [[target.pluginId, target.platform, target.scope].join('\0'), target]))
            .values()];
          const completed = targets.filter((target) =>
            target.state === 'completed' || target.state === 'kept').length;
          const failed = targets.length - completed;
          const state: PluginWriteBatchRootResult['state'] = completed > 0
            ? failed > 0 ? 'partial'
              : targets.every((target) => target.state === 'kept') ? 'kept' : 'completed'
            : failed > 0 ? 'failed' : 'notStarted';
          return { pluginId, state, targets };
        })
      : [];
    return {
      code: result.state === 'succeeded' ? 'operationSucceeded'
        : result.state === 'partial' ? 'operationPartial' : 'operationFailed',
      message: result.state === 'succeeded' ? '操作已完成。'
        : result.state === 'partial' ? '操作只完成了一部分。' : '操作结果无法确认。',
      ...(intent.kind === 'pluginWrite' ? { pluginId: intent.pluginId } : {}),
      action: intent.action,
      changes: result.changes,
      warnings: result.warnings,
      recoveryActions: result.recoveryActions,
      ...(result.planFingerprint ? { planFingerprint: result.planFingerprint } : {}),
      messages: [
        ...result.warnings.map((warning) => `警告：${warning}`),
        ...result.recoveryActions.map((action) => `恢复：${action}`),
        ...(intent.kind === 'pluginWrite' && intent.recoveryDescription
          ? [intent.recoveryDescription, `后续：${intent.scope === 'user' ? '当前项目' : '所有项目'} sync`]
          : []),
      ],
      ...(intent.kind === 'pluginWriteBatch' ? {
        batch: {
          requestedPluginIds,
          failedRequestedPluginIds,
          rootResults,
          retryTargets,
          groupCount: (execution as PluginWriteBatchExecutionResult).groupResults.length,
        },
      } : {}),
      targets: result.targetResults.map((entry) => ({
        pluginId: entry.target.pluginId,
        platform: entry.target.platform,
        scope: entry.target.scope,
        state: entry.action === 'skipped' ? 'skipped'
          : entry.state === 'failed' ? 'failed'
            : entry.action === 'keep' ? 'kept'
              : entry.state,
        relation: entry.relation === 'requested' ? 'requested'
          : entry.requiredBy.some((pluginId) => requestedIds.has(pluginId)) ? 'direct' : 'transitive',
        requiredBy: entry.requiredBy,
        ...(entry.errorCode ? { errorCode: safeDiagnosticCode(entry.errorCode, 'writeFailed') } : {}),
      })),
    };
  }
  if (intent.kind === 'configSave' || intent.kind === 'configReset') {
    const rawApply = typeof execution === 'object' && execution !== null
      && typeof (execution as { apply?: unknown }).apply === 'object'
      && (execution as { apply?: unknown }).apply !== null
      ? (execution as { apply: Record<string, unknown> }).apply
      : {};
    const rawTargets = Array.isArray(rawApply.targetResults)
      ? rawApply.targetResults as Array<Record<string, unknown>>
      : [];
    const targets = rawTargets.flatMap((entry) => {
      const target = typeof entry.target === 'object' && entry.target !== null
        ? entry.target as Record<string, unknown>
        : entry;
      if ((target.platform !== 'codex' && target.platform !== 'claude')
        || (target.scope !== 'user' && target.scope !== 'project')
        || (entry.state !== 'completed' && entry.state !== 'failed' && entry.state !== 'skipped')) return [];
      return [{
        ...(typeof target.pluginId === 'string' ? { pluginId: target.pluginId } : {}),
        platform: target.platform as PlatformName,
        scope: target.scope as Scope,
        state: entry.state === 'skipped' || entry.action === 'skipped' ? 'skipped' as const
          : entry.state === 'failed' ? 'failed' as const
            : entry.action === 'keep' ? 'kept' as const
              : entry.state as 'completed' | 'failed',
        ...(typeof entry.errorCode === 'string'
          ? { errorCode: safeDiagnosticCode(entry.errorCode, 'configApplyFailed') }
          : {}),
      }];
    });
    const overallState = typeof execution === 'object' && execution !== null
      ? (execution as { overallState?: unknown }).overallState
      : undefined;
    const applyState = rawApply.state;
    const applyReason = rawApply.reason;
    const invalidConfig = applyState === 'unavailable' && applyReason === 'invalidConfig';
    const resetDisposition = typeof execution === 'object' && execution !== null
      ? (execution as { resetDisposition?: unknown }).resetDisposition
      : undefined;
    const quarantineBasename = typeof execution === 'object' && execution !== null
      ? (execution as { quarantineBasename?: unknown }).quarantineBasename
      : undefined;
    const publicWarnings = typeof execution === 'object' && execution !== null
      && Array.isArray((execution as { warnings?: unknown }).warnings)
      ? (execution as { warnings: unknown[] }).warnings.filter((warning): warning is string =>
          typeof warning === 'string'
          && warning.startsWith('projectConfigShareabilityUnverified:'))
      : [];
    const otherProjectsMayRequireSync = intent.scope === 'user'
      && typeof execution === 'object' && execution !== null
      && (execution as { otherProjectsMayRequireSync?: unknown }).otherProjectsMayRequireSync === true;
    const publicMessages = [
      ...publicWarnings.map((warning) => `警告：${warning}`),
      ...(otherProjectsMayRequireSync
        ? ['提示：其它项目没有被扫描，可能需要在对应项目目录中运行 aw sync。']
        : []),
    ];
    const partial = overallState === 'partial'
      || applyState === 'partial'
      || applyState === 'unavailable'
      || invalidConfig
      || targets.some((target) => target.state === 'failed' || target.state === 'skipped')
      && targets.some((target) => target.state === 'completed' || target.state === 'kept');
    const failed = overallState === 'failed'
      || (targets.length > 0
        && targets.every((target) => target.state === 'failed' || target.state === 'skipped'));
    return {
      code: failed || partial ? 'operationPartial' : 'operationSucceeded',
      message: invalidConfig ? '设置已保存，但没有应用。当前配置仍无效。'
        : failed || partial ? '设置已保存，但插件内容重新应用失败或部分失败。' : '操作已完成。',
      pluginId: intent.pluginId,
      configScope: intent.scope,
      configApplyRetryAvailable: intent.kind === 'configSave'
        && intent.apply && !invalidConfig && (applyState === 'partial' || applyState === 'unavailable'),
      ...(publicMessages.length > 0 ? { messages: publicMessages } : {}),
      ...(intent.kind === 'configSave'
        ? { configApplied: applyState === 'succeeded' || applyState === 'partial' }
        : invalidConfig ? { configApplied: false } : {}),
      ...(invalidConfig ? { configApplySkippedReason: 'invalidConfig' as const } : {}),
      ...(intent.kind === 'configReset'
        && (resetDisposition === 'absent'
          || resetDisposition === 'deletedFile'
          || resetDisposition === 'unlinkedSymlink'
          || resetDisposition === 'quarantinedDirectory')
        ? {
            resetDisposition,
            ...(resetDisposition === 'quarantinedDirectory' && typeof quarantineBasename === 'string'
              ? { quarantineBasename } : {}),
          }
        : {}),
      ...(targets.length > 0 ? { targets } : {}),
    };
  }
  const sourceWarnings = intent.kind === 'sourceMutation'
    ? projectCatalogSourceMutationWarnings(execution) : [];
  const overallFailed = typeof execution === 'object' && execution !== null
    && (execution as { overallState?: unknown }).overallState === 'failed';
  return {
    code: overallFailed ? 'operationFailed' : 'operationSucceeded',
    message: overallFailed ? '操作结果无法确认。' : '操作已完成。',
    ...(sourceWarnings.length > 0 ? { messages: sourceWarnings } : {}),
  };
}

function operationResultSummary(intent: OperationIntent, execution: unknown): OperationResultSummary {
  return sanitizeOperationSummary(
    operationResultSummaryUnsafe(intent, execution),
    collectOperationSensitiveValues(intent),
  );
}
