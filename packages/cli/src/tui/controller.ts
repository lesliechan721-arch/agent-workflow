import crypto from 'node:crypto';

import type {
  CatalogSource,
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateEvidence,
  CatalogGenerationSyncResult,
  DependencyScopeOverride,
  PlatformName,
  Scope,
} from '../types.js';
import type { PortableReview, PortableInstallReceipt } from '../portable/commands.js';
import type { CatalogSourceUpdate } from '../utils/catalog-sources.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import type {
  CatalogGenerationFreshnessState,
  CatalogGenerationFreshnessResult,
} from '../utils/catalog-generation-service.js';
import type {
  StatusV7Payload,
  StatusV7PluginSummary,
  StatusTargetRevision,
} from '../commands/status-v6.js';
import type { ReconcileOperationPlan } from '../commands/reconcile-operation-plan.js';
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
import { safeDiagnosticCode } from './diagnostics.js';
import { targetHasArtifactCollision } from '../utils/target-eligibility.js';
import {
  TuiRouter,
  type CatalogActivationBlockReason,
  type ConfigInvalidStoreEvidence,
  type PluginInstallFilter,
  type PortableBlockerCode,
  type TuiPageContext,
  type TuiRoute,
  type TuiRouterSnapshot,
} from './router.js';
import {
  type CatalogSourceGenerationViewModel,
} from './catalog-generation.js';
import type { CatalogSourceFreshnessViewModel } from './catalog-freshness.js';
import { CatalogSourcesSession } from './catalog-sources/session.js';
import {
  catalogSourceAutoCheckOnlyValue,
  projectCatalogSourceMutationWarnings,
} from './catalog-sources/review.js';

export type PluginWriteOperation = 'install' | 'refreshAndSync' | 'reinstall' | 'uninstall' | 'cleanup' | 'sync';
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
      dependencyPlacementAdjustment?: true;
      recoveryDescription?: string;
      force?: boolean;
      originIssue?: IssueOrigin;
    }
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
      action: 'activate' | 'update' | 'repair' | 'recoverState';
      sourceId: string;
      sourceMutation?:
        | { action: 'add'; source: CatalogSource }
        | { action: 'update'; update: CatalogSourceUpdate };
      setPrimaryAfterActivation?: boolean;
    }
  | {
      kind: 'catalogSourcesRecovery';
    }
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
    affectedTargets: Array<{ platform: PlatformName; scope: Scope }>;
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
    referenceCount: number;
    inventoryComplete: boolean;
  };
  catalogGeneration?: {
    action: Extract<OperationIntent, { kind: 'catalogGeneration' }>['action'];
    previousActive?: CatalogGenerationActiveV1;
    previousActiveVersion?: string;
    candidate: CatalogGenerationCandidateEvidence;
    candidateRelation?: CatalogGenerationFreshnessState;
    explicitSourceChange?: boolean;
    exactRepair?: boolean;
    configDigest: string;
    proposedConfigDigest?: string;
    proposedSource?: CatalogSource;
    sourceMutation?: Extract<OperationIntent, { kind: 'catalogGeneration' }>['sourceMutation'];
    setPrimaryAfterActivation?: boolean;
  };
  portable?: PortableReview;
}

export interface OperationReviewChange {
  kind: 'add' | 'change' | 'remove' | 'keep' | 'warning';
  group?: 'requested' | 'dependencies' | 'projectIntent' | 'userIntent'
    | 'sharedCodexNative' | 'userActivation' | 'projectActivation' | 'awExtensions'
    | 'runtime' | 'portableTarget' | 'portableInputs' | 'portableWarnings'
    | 'configChanges' | 'configImpact' | 'preserved';
  pluginId?: string;
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
  intent: OperationIntent;
  state: 'running' | 'failed';
  stages: ReviewPreparationStage[];
  currentLabel: string;
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
    }
  | {
      state: 'stale';
      operationId: string;
      operationKind: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      review: OperationReviewModel;
      originIssue?: IssueOrigin;
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
    };

export interface OperationResultSummary {
  code: 'operationSucceeded' | 'operationPartial' | 'operationFailed';
  message: string;
  pluginId?: string;
  action?: PluginWriteOperation;
  catalogAction?: Extract<OperationIntent, { kind: 'catalogGeneration' }>['action'];
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
    errorCode?: 'dependencyStillRequired'
      | 'codexSystemCliUnsupported'
      | 'managedCodexAuthorizationRequired'
      | 'managedCodexUnavailable';
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
  payload: StatusV7Payload;
  pluginSummaries: StatusV7PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceDetails?: SourceDetailViewModel[];
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
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
  marketplaceCount?: number;
  dependencies: Array<{
    category: 'installation' | 'config' | 'marketplace';
    pluginId?: string;
    sourceId?: string;
    platform?: PlatformName;
    scope?: Scope;
  }>;
}

export interface TuiControllerDependencies {
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

export interface TuiControllerSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
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
  adjustingExisting: boolean;
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

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TuiOperationBlockedError';
    this.code = code;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function cloneFrozen<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function publicReviewPreparation(
  snapshot: ReviewPreparationSnapshot,
): ReviewPreparationSnapshot {
  if (snapshot.intent.kind !== 'catalogGeneration' || !snapshot.intent.sourceMutation) return snapshot;
  const mutation = snapshot.intent.sourceMutation;
  const sourceMutation = mutation.action === 'add'
    ? {
        ...mutation,
        source: mutation.source.type === 'path'
          ? { ...mutation.source, path: '<private>' }
          : { ...mutation.source, url: '<private>' },
      }
    : {
        ...mutation,
        update: 'url' in mutation.update
          ? { ...mutation.update, ...(mutation.update.url ? { url: '<private>' } : {}) }
          : { ...mutation.update, ...('path' in mutation.update && mutation.update.path
            ? { path: '<private>' } : {}) },
      };
  return { ...snapshot, intent: { ...snapshot.intent, sourceMutation } };
}

export function operationEvidenceFingerprint(evidence: OperationEvidence): string {
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
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableValue(staleEvidence)))
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
    if (!expected.source) return true;
    return current.source !== undefined
      && JSON.stringify(stableValue(expected.source))
        === JSON.stringify(stableValue(current.source));
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


function issueCode(error: unknown): string {
  if (error instanceof TuiOperationBlockedError) return error.code;
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
  readonly #inflightOperations = new Map<string, {
    operationId: string;
    promise: Promise<OperationExecuteResult>;
  }>();
  readonly #abort = new AbortController();
  readonly #progressUnsubscribe?: () => void;
  readonly #progressFeed?: RebuildProgressFeed;
  #phase: TuiControllerSnapshot['phase'] = 'idle';
  #status?: TuiStatusLoadResult;
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
  #loadError?: { code: string; message: string };
  #portableDraft?: TuiControllerSnapshot['portableDraft'];
  #portableRepreparePluginId?: string;
  #portableRequestToken = 0;
  #portableRequestAbort?: AbortController;
  #portablePending?: { key: string; promise: Promise<unknown> };
  #installPlacementDraft?: InstallPlacementDraftState;
  #installPlacementRequestToken = 0;
  #installPlacementRequestAbort?: AbortController;
  #generation = 0;
  #disposed = false;
  #externalDraft?: 'configDraft' | 'sourceDraft';

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
    });
    if (progressFeed) {
      this.#progressUnsubscribe = progressFeed.subscribe((progress) => {
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
        ? { reviewPreparation: publicReviewPreparation(this.#reviewPreparation.snapshot) }
        : {}),
      ...(this.#result ? { result: this.#result } : {}),
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

  #publish(): void {
    if (this.#disposed) return;
    const snapshot = this.snapshot;
    for (const listener of this.#listeners) listener(snapshot);
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
    });
  }

  #normalizeRoute(route: TuiRoute): TuiRoute {
    if (route.name === 'pluginList' && route.sourceId
      && !this.#viewModel?.sourceTabs.some((source) => source.id === route.sourceId)) {
      return { name: 'pluginList', mode: route.mode };
    }
    const pluginRoute = route.name === 'pluginPreview'
      || route.name === 'portableSkillSelect'
      || route.name === 'portableDependencies'
      || route.name === 'portableAgentMode'
      || route.name === 'portableAgentInput'
      || route.name === 'portableScope'
      || route.name === 'portableBlocker'
      || route.name === 'pluginDependencies'
      || route.name === 'installPlacement'
      || route.name === 'installTargets'
      || route.name === 'dependencyPlacement'
      || route.name === 'dependencyPlacementEditor'
      || route.name === 'pluginDetail'
      || route.name === 'platform'
      || route.name === 'pluginAbout'
      || route.name === 'pluginTechnical'
      || route.name === 'configLayer'
      || route.name === 'configFields'
      || route.name === 'configFieldEditor'
      || route.name === 'configUnavailable';
    if (pluginRoute && !this.#viewModel?.plugins.some((plugin) => plugin.pluginId === route.pluginId)) {
      return {
        name: 'pluginList',
        mode: route.name === 'pluginPreview' || route.name === 'pluginDependencies'
          || route.name === 'installPlacement' || route.name === 'installTargets'
          || route.name === 'dependencyPlacement' || route.name === 'dependencyPlacementEditor'
          ? 'browse'
          : 'installed',
      };
    }
    if (route.name === 'issueDetail'
      && !this.#viewModel?.issues.some((issue) => issue.issueId === route.issueId)) {
      return { name: 'issueList' };
    }
    if ((route.name === 'sourceDetail'
      || route.name === 'sourceTechnical'
      || route.name === 'sourceEdit'
      || route.name === 'sourceRemoveBlocked')
      && !this.#viewModel?.sourceTabs.some((source) => source.id === route.sourceId)) {
      return { name: 'sourceList' };
    }
    return route;
  }

  #normalizeCurrentRoute(): void {
    const route = this.#router.snapshot.current.route;
    const normalized = this.#normalizeRoute(route);
    if (normalized !== route) this.#router.replace(normalized);
  }

  #applyStatus(status: TuiStatusLoadResult): void {
    this.#status = structuredClone(status);
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
      return {
        sourceId: source.id,
        primary: source.primary,
        autoCheck: this.dependencies.probeCatalogFreshness !== undefined
          && (detail?.autoCheck ?? true),
        fingerprint: JSON.stringify({
          sourceIdentity: source.identity,
          requestedRef: source.requestedRef,
          activeStoreKey: generation?.active?.storeKey,
          generationState: generation?.state,
          generationErrorCode: generation?.errorCode,
        }),
        fixedCommit: detail?.type === 'git'
          && detail.refPolicy === 'explicit'
          && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(detail.explicitRef ?? ''),
      };
    }));
    this.#project();
    this.#normalizeCurrentRoute();
  }

  async load(): Promise<void> {
    this.dependencies.beginCatalogSession?.();
    const generation = ++this.#generation;
    this.#phase = 'loading';
    this.#publish();
    let status: TuiStatusLoadResult;
    try {
      status = await this.dependencies.loadStatus(this.#abort.signal);
    } catch (error) {
      if (this.#disposed || generation !== this.#generation) return;
      const code = issueCode(error);
      await this.#logErrorSafe(error, code);
      this.#phase = 'error';
      this.#loadError = { code, message: '无法安全读取插件状态。请检查诊断后重试或退出。' };
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
      evidence: await this.dependencies.captureEvidence({
        kind: 'portableInstall',
        pluginId,
        scope,
        selectedSkills: [],
      }, signal),
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

  configOrigin(pluginId: string): TuiRoute | undefined {
    return this.#router.configOrigin(pluginId);
  }

  updatePageContext(context: Partial<TuiPageContext>): void {
    this.#router.updateContext(context);
    this.#publish();
  }

  back(): void {
    const route = this.#router.snapshot.current.route;
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#cancelInstallPlacementRequest();
    if (route.name === 'review' && this.#activeReview?.operationId === route.operationId) {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    this.#router.back();
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
    this.#router.discardSourceFlow(owner, returnRoute);
    this.#normalizeCurrentRoute();
    this.#publish();
  }

  leaveResult(target?: TuiRoute): void {
    if (this.#router.snapshot.current.route.name !== 'result') return;
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
    const route = target ?? (this.#result && 'returnRoute' in this.#result
      ? this.#result.returnRoute
      : undefined);
    this.#router.back();
    if (route) this.#router.replace(this.#normalizeRoute(route));
    else this.#normalizeCurrentRoute();
    this.#discardPortableDraftForRoute(this.#router.snapshot.current.route);
    this.#result = undefined;
    this.#publish();
  }

  #discardPortableDraftForRoute(route: TuiRoute): void {
    const portableRoute = route.name === 'portableSkillSelect'
      || route.name === 'portableDependencies'
      || route.name === 'portableAgentMode'
      || route.name === 'portableAgentInput'
      || route.name === 'portableScope'
      || route.name === 'portableBlocker';
    const portableOperationRoute = (route.name === 'reviewPreparing' || route.name === 'review'
      || route.name === 'progress' || route.name === 'result')
      && (this.#reviewPreparation?.snapshot.intent.kind === 'portableInstall'
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
    if (!preserveDraft) this.#portableDraft = undefined;
    if (this.#activeReview?.operationKind === 'portableInstall') {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    if (this.#result?.operationKind === 'portableInstall') this.#result = undefined;
    this.#router.resetPortableFlow(pluginId);
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
    options: { adjustingExisting?: boolean } = {},
  ): void {
    this.#cancelInstallPlacementRequest();
    this.#installPlacementDraft = {
      pluginId,
      rootScope,
      platforms: [],
      dependencyScopeOverrides: [],
      state: 'selecting',
      targets: [],
      canContinue: false,
      adjustingExisting: options.adjustingExisting === true,
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
      ...(draft.adjustingExisting ? { dependencyPlacementAdjustment: true } : {}),
    };
  }

  async prepareInstallDependencyPlacement(): Promise<boolean> {
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
      const plan = await preview(this.#installPlacementIntent());
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
      && (options.mode === 'browse' || hasInstalledPlacement(plugin))
      && (options.installFilter !== 'uninstalled' || !hasInstalledPlacement(plugin))
      && (!query || `${plugin.displayName}\n${plugin.description}\n${plugin.sourceId}`.toLocaleLowerCase('en').includes(query))));
  }

  getPluginOverview(pluginId: string): PluginListItemViewModel | undefined {
    const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
    return plugin ? cloneFrozen(plugin) : undefined;
  }

  getPluginDependencyOverview(pluginId: string): PluginDependencyOverviewViewModel | undefined {
    const overview = this.#viewModel?.dependencyOverviews.find((entry) => entry.pluginId === pluginId);
    return overview ? cloneFrozen(overview) : undefined;
  }

  getBlockingDependents(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): PluginDependencyOverviewViewModel['dependents'] {
    const dependents = this.#viewModel?.dependencyOverviews.find((entry) =>
      entry.pluginId === pluginId)?.dependents ?? [];
    return cloneFrozen(dependents.flatMap((dependent) => {
      const references = (dependent.placementReferences ?? []).filter((reference) =>
        reference.dependency.pluginId === pluginId
        && reference.dependency.platform === platform
        && reference.dependency.scope === scope
        && (scope === 'user' || reference.dependency.project === 'current')
        && (reference.consumer.project === 'other'
          || this.#status?.payload.targets.find((target) =>
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
      const platformTargets = this.#status?.payload.targets.filter((target) =>
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
          ?? (this.#status?.payload.targets.filter((target) =>
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
          const target = this.#status?.payload.targets.find((entry) =>
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
  ): StatusV7Payload['targets'][number]['state'] | undefined {
    return this.#status?.payload.targets.find((target) =>
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

  getCatalogGeneration(sourceId: string): CatalogSourceGenerationViewModel | undefined {
    const source = this.#catalogGenerations.get(sourceId);
    return source ? cloneFrozen(source) : undefined;
  }

  getCatalogFreshness(sourceId: string): CatalogSourceFreshnessViewModel | undefined {
    const freshness = this.#catalogFreshness.get(sourceId);
    return freshness ? cloneFrozen(freshness) : undefined;
  }

  recheckCatalogSource(sourceId: string): Promise<void> {
    return this.#catalogSourcesSession.recheck(sourceId);
  }

  setExternalDraftState(state?: 'configDraft' | 'sourceDraft'): void {
    this.#externalDraft = state;
  }

  catalogActivationBlockReason(): CatalogActivationBlockReason | undefined {
    if (this.#externalDraft) return this.#externalDraft;
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
    if (this.catalogActivationBlockReason()) return false;
    this.dependencies.beginCatalogSession?.();
    const generation = ++this.#generation;
    this.#phase = 'loading';
    this.#publish();
    try {
      const status = await this.dependencies.loadStatus(this.#abort.signal);
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
    if (!this.dependencies.inspectSourceRemoval) {
      throw new TuiOperationBlockedError('stateInventoryFailed', '来源引用清单不可用。');
    }
    return cloneFrozen(await this.dependencies.inspectSourceRemoval(sourceId, this.#abort.signal));
  }

  async getConfigGroups(
    pluginId: string,
    layer: { scope: Scope },
  ): Promise<ConfigGroupViewModel[]> {
    if (!this.dependencies.getConfigGroups) {
      throw new TuiOperationBlockedError('configUnavailable', '设置读取入口不可用。');
    }
    return cloneFrozen(await this.dependencies.getConfigGroups(
      pluginId,
      structuredClone(layer),
      this.#abort.signal,
    ));
  }

  async getConfigPage(
    pluginId: string,
    layer: { scope: Scope | 'effective' },
    signal?: AbortSignal,
  ): Promise<ConfigPageViewModel> {
    if (!this.dependencies.getConfigPage) {
      throw new TuiOperationBlockedError('configUnavailable', '设置读取入口不可用。');
    }
    const combined = signal
      ? AbortSignal.any([this.#abort.signal, signal])
      : this.#abort.signal;
    return cloneFrozen(await this.dependencies.getConfigPage(
      pluginId,
      structuredClone(layer),
      combined,
    ));
  }

  async getConfigResetAvailability(
    pluginId: string,
    layer: { scope: Scope },
  ): Promise<ConfigResetAvailability> {
    if (!this.dependencies.getConfigResetAvailability) {
      throw new TuiOperationBlockedError(
        'configResetVerificationUnavailable',
        '设置层可信读取入口不可用。',
      );
    }
    return cloneFrozen(await this.dependencies.getConfigResetAvailability(
      pluginId,
      structuredClone(layer),
      this.#abort.signal,
    ));
  }

  listUserIssues(): UserIssueViewModel[] {
    return cloneFrozen(this.#viewModel?.issues ?? []);
  }

  async buildOperationReview(intent: OperationIntent, returnRoute?: TuiRoute): Promise<OperationReviewModel> {
    try {
      this.#validateReviewIntent(intent);
      const evidence = await this.#prepareReviewEvidence(intent, this.#abort.signal);
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
    if (intent.kind === 'catalogGeneration' && !intent.sourceMutation) {
      const blockReason = this.catalogActivationBlockReason();
      if (blockReason) {
        throw new TuiOperationBlockedError(
          'catalogActivationBlocked',
          `Catalog Active 切换已阻止：${blockReason}。请先完成或放弃当前草稿或操作。`,
        );
      }
    }
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
    const key = JSON.stringify(stableValue({ intent, returnRoute: normalizedReturnRoute }));
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
      intent: structuredClone(intent),
      state: 'running',
      stages: this.dependencies.prepareReviewEvidence ? [] : [
        { id: 'validate', label: '验证当前状态', state: 'running' },
        { id: 'evidence', label: '准备确认信息', state: 'pending' },
      ],
      currentLabel: this.#reviewPreparationLabel(intent),
    };
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
    return this.startReviewPreparation(preparation.snapshot.intent, preparation.returnRoute);
  }

  #validateReviewIntent(intent: OperationIntent): void {
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
    if (intent.kind === 'catalogSourcesRecovery') return 'Catalog 来源配置';
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
    const intent = structuredClone(preparation.snapshot.intent);
    const signal = AbortSignal.any([this.#abort.signal, preparation.abort.signal]);
    try {
      this.#validateReviewIntent(intent);
      const evidence = await this.#prepareReviewEvidence(intent, signal, (stage) => {
        if (!this.#reviewPreparationIsCurrent(token)) return;
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
      });
      if (!this.#reviewPreparationIsCurrent(token)) return;
      preparation.snapshot.stages = preparation.snapshot.stages.map((stage) =>
        stage.state === 'running' ? { ...stage, state: 'completed' } : stage);
      this.#publish();
      const returnRoute = structuredClone(preparation.returnRoute);
      this.#reviewPreparation = undefined;
      this.#storeOperationReview(intent, evidence, 'replace', returnRoute);
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
        : code === 'catalogVersionConflict'
          ? '候选 Catalog 与当前 Active 版本相同，但内容摘要不同。普通更新已阻止。'
          : code === 'catalogRollbackDetected'
            ? '候选 Catalog 版本低于当前 Active。普通更新已阻止。'
        : code === 'catalogGenerationUnavailable'
        ? '本次加载时 Catalog 来源不可用。请刷新来源并重新加载后重试。'
        : '无法准备确认信息。请返回检查选择，或重试。';
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
      return this.dependencies.prepareReviewEvidence(structuredClone(intent), signal, onStage);
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
      : 'sourceId' in intent ? intent.sourceId : 'Catalog 来源配置';
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
    const dependencyPlan = ticket.evidence.dependencyPlan;
    this.#progressTargets = dependencyPlan?.targets.map((target) => ({
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.resolvedScope,
      relation: target.relation === 'requested'
        ? 'requested'
        : target.depth === 1 ? 'direct' : 'transitive',
      requiredBy: target.requiredBy,
      state: target.action === 'keep' ? 'kept' as const : 'pending' as const,
    })) ?? [];
    this.#progress = {
      messages: [],
      startedAtMs,
      elapsedMs: 0,
      current: {
        target: 'pluginId' in ticket.intent ? ticket.intent.pluginId
          : 'sourceId' in ticket.intent ? ticket.intent.sourceId : 'Catalog 来源配置',
        phase: '验证当前状态',
      },
    };
    this.#router.replace({ name: 'progress', operationId });
    this.#publish();
    try {
      if (ticket.intent.kind !== 'pluginWrite') {
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
    if (ticket.intent.kind !== 'pluginWrite') {
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
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
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
      if (ticket.intent.kind === 'catalogSourcesRecovery') {
        this.#phase = 'ready';
        this.#loadError = undefined;
      }
      if (ticket.intent.kind === 'catalogGeneration') {
        void this.#catalogSourcesSession.refresh(ticket.intent.sourceId, false);
      }
      const pluginSummary = ticket.intent.kind === 'pluginWrite'
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
          ...(dependencyFailure || dependencyStillRequired ? { summary: pluginSummary } : {}),
          ...(!dependencyFailure && !dependencyStillRequired ? { writeMayHaveCompleted: true } : {}),
        });
      }
      const originIssue = ticket.intent.kind === 'pluginWrite' ? ticket.intent.originIssue : undefined;
      if (originIssue && !dependencyPartial
        && this.#viewModel?.issues.some((issue) => userIssueKey(issue) === originIssue.issueKey)) {
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
        messages: [...this.#progress.messages, ...(baseSummary.messages ?? [])].slice(-8),
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
          this.#router.replace({ name: 'result', operationId });
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
                ? { name: 'sourceDetail', sourceId: ticket.intent.sourceId }
              : ticket.returnRoute,
        )),
      };
      if ((ticket.intent.kind === 'configSave' || ticket.intent.kind === 'configReset')
        && this.#portableRepreparePluginId === ticket.intent.pluginId) {
        this.#portableRepreparePluginId = undefined;
        this.#activeReview = undefined;
        this.#result = undefined;
        await this.preparePortableInstall(ticket.intent.pluginId, 'replace');
        return cloneFrozen(result);
      }
      this.#result = result;
      this.#activeReview = undefined;
      this.#router.replace({ name: 'result', operationId });
      this.#publish();
      return cloneFrozen(result);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      if (code === 'operationReviewStale' || code === 'catalogGenerationReviewStale') {
        return this.#rebuildStaleReview(ticket, operationId, undefined, generation);
      }
      generation = ++this.#generation;
      try {
        const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        this.#applyStatus(refreshed);
        if (ticket.intent.kind === 'catalogSourcesRecovery'
          && code === 'catalogSourcesConfigRecoveryStale') {
          this.#phase = 'ready';
          this.#loadError = undefined;
          this.#activeReview = undefined;
          this.#result = undefined;
          this.#router.replace({ name: 'home' });
          this.#publish();
          return cloneFrozen({
            state: 'blocked',
            operationId,
            code,
            message: '来源配置已变化，已重新加载当前状态。',
            operationKind: ticket.intent.kind,
          });
        }
      } catch (reloadError) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        await this.#logErrorSafe(reloadError, 'tuiStateReloadFailed', {
          privateConfigOperation: true,
        });
      }
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
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
    this.dependencies.beginCatalogSession?.();
    generation = ++this.#generation;
    try {
      const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#applyStatus(refreshed);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
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
      this.#router.replace({ name: 'result', operationId });
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

function operationResultSummary(intent: OperationIntent, execution: unknown): OperationResultSummary {
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
          : intent.action === 'recoverState' ? 'Catalog generation state 已恢复，目标来源已启用。'
            : updateActivated ? `Catalog 已更新到 ${generation.resolution.catalogVersion}。`
              : intent.action === 'update' ? 'Catalog 已验证，Active 未变化。'
              : 'Catalog 已验证并启用。',
      messages: result.status === 'partial'
        ? [result.partialReason === 'primary'
            ? `新的 Active 可用；主来源保持不变。错误：${result.errorCode ?? 'catalogSourcePrimaryFailed'}`
            : `旧 Active 保持不变。错误：${result.errorCode ?? 'catalogGenerationRefreshFailed'}`]
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
  if (intent.kind === 'pluginWrite') {
    const command = intent.action === 'refreshAndSync' ? 'sync' : intent.action;
    const rawExecution = typeof execution === 'object' && execution !== null
      ? execution as Record<string, unknown>
      : {};
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
                ? rawTarget.pluginName : pluginNameFromId(pluginId ?? intent.pluginId),
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
        plugins: Array.isArray(rawExecution.plugins) ? rawExecution.plugins as string[] : [intent.pluginId],
        warnings: Array.isArray(rawExecution.warnings) ? rawExecution.warnings as string[] : [],
      } as Parameters<typeof buildRebuildReceiptJson>[1],
    );
    const result = buildOperationResultModel(receipt);
    const requestedIds = new Set(receipt.requestedPluginIds ?? [intent.pluginId]);
    return {
      code: result.state === 'succeeded' ? 'operationSucceeded'
        : result.state === 'partial' ? 'operationPartial' : 'operationFailed',
      message: result.state === 'succeeded' ? '操作已完成。'
        : result.state === 'partial' ? '操作只完成了一部分。' : '操作结果无法确认。',
      pluginId: intent.pluginId,
      action: intent.action,
      changes: result.changes,
      warnings: result.warnings,
      recoveryActions: result.recoveryActions,
      ...(result.planFingerprint ? { planFingerprint: result.planFingerprint } : {}),
      messages: [
        ...result.warnings.map((warning) => `警告：${warning}`),
        ...result.recoveryActions.map((action) => `恢复：${action}`),
        ...(intent.recoveryDescription
          ? [intent.recoveryDescription, `后续：${intent.scope === 'user' ? '当前项目' : '所有项目'} sync`]
          : []),
      ],
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
        ...(entry.errorCode === 'dependencyStillRequired'
          || entry.errorCode === 'codexSystemCliUnsupported'
          || entry.errorCode === 'managedCodexAuthorizationRequired'
          || entry.errorCode === 'managedCodexUnavailable'
          ? { errorCode: entry.errorCode }
          : {}),
      })),
    };
  }
  if (intent.kind === 'configSave' || intent.kind === 'configReset') {
    const rawTargets = typeof execution === 'object' && execution !== null
      && Array.isArray((execution as { targetResults?: unknown }).targetResults)
      ? (execution as { targetResults: Array<Record<string, unknown>> }).targetResults
      : [];
    const targets = rawTargets.flatMap((entry) => {
      const target = typeof entry.target === 'object' && entry.target !== null
        ? entry.target as Record<string, unknown>
        : entry;
      if ((target.platform !== 'codex' && target.platform !== 'claude')
        || (target.scope !== 'user' && target.scope !== 'project')
        || (entry.state !== 'completed' && entry.state !== 'failed')) return [];
      return [{
        ...(typeof target.pluginId === 'string' ? { pluginId: target.pluginId } : {}),
        platform: target.platform as PlatformName,
        scope: target.scope as Scope,
        state: entry.action === 'skipped' ? 'skipped' as const
          : entry.state === 'failed' ? 'failed' as const
            : entry.action === 'keep' ? 'kept' as const
              : entry.state as 'completed' | 'failed',
      }];
    });
    const overallState = typeof execution === 'object' && execution !== null
      ? (execution as { overallState?: unknown }).overallState
      : undefined;
    const applySkippedReason = typeof execution === 'object' && execution !== null
      ? (execution as { applySkippedReason?: unknown }).applySkippedReason
      : undefined;
    const invalidConfig = applySkippedReason === 'invalidConfig';
    const resetDisposition = typeof execution === 'object' && execution !== null
      ? (execution as { resetDisposition?: unknown }).resetDisposition
      : undefined;
    const quarantineBasename = typeof execution === 'object' && execution !== null
      ? (execution as { quarantineBasename?: unknown }).quarantineBasename
      : undefined;
    const partial = overallState === 'partial'
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
        && intent.apply && !invalidConfig && (failed || partial),
      ...(intent.kind === 'configSave'
        ? { configApplied: invalidConfig ? false : intent.apply }
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
