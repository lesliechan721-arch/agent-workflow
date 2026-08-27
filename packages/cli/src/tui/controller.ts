import crypto from 'node:crypto';

import type { CatalogSource, PlatformName, Scope } from '../types.js';
import type { PortableReview, PortableInstallReceipt } from '../portable/commands.js';
import type { CatalogSourceUpdate } from '../utils/catalog-sources.js';
import type {
  StatusV4Payload,
  StatusV4PluginSummary,
  StatusTargetRevision,
} from '../commands/status-v4.js';
import type { ProjectConfigStoreLayer } from '../utils/plugin-config.js';
import type { DependencyOperationPlan } from '../commands/dependency-operation-plan.js';
import type {
  RebuildProgressFeed,
  RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import {
  type ConfigPageViewModel,
  type ConfigGroupViewModel,
  buildTuiViewModel,
  hasInstalledPlacement,
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
import {
  TuiRouter,
  type PluginInstallFilter,
  type PortableBlockerCode,
  type TuiPageContext,
  type TuiRoute,
  type TuiRouterSnapshot,
} from './router.js';

export type PluginWriteOperation = 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';
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
      projectLayer: ProjectConfigStoreLayer;
      updates?: Record<string, unknown>;
      removeKeys?: string[];
      sensitiveKeys?: string[];
      privateKeys?: string[];
      changes?: Array<{
        key: string;
        title: string;
        before: string;
        after: string;
      }>;
    }
  | {
      kind: 'configReset';
      pluginId: string;
      scope: Scope;
      projectLayer: ProjectConfigStoreLayer;
    }
  | {
      kind: 'sourceMutation';
      action: 'add' | 'update' | 'setPrimary' | 'remove';
      sourceId: string;
      source?: CatalogSource;
      update?: CatalogSourceUpdate;
      changes?: Array<{ title: string; before?: string; after?: string; private?: boolean }>;
    };

export interface OperationEvidence {
  catalog: {
    configDigest: string;
    compositeDigest: string;
  };
  source?: {
    sourceId: string;
    sourceIdentity: string;
    requestedRef?: string;
    resolvedCommit?: string;
    manifestDigest?: string;
    snapshotDigest?: string;
    contentDigest?: string;
  };
  targetFingerprint?: string;
  dependencyPlan?: DependencyOperationPlan;
  config?: {
    scope: Scope;
    projectLayer: ProjectConfigStoreLayer;
    schemaIdentity?: string;
    storeDigest: string;
  };
  sourceWrite?: {
    configDigest: string;
    candidateDigest: string;
    sourceIdentity?: string;
    inventoryDigest: string;
    referenceCount: number;
    inventoryComplete: boolean;
  };
  portable?: PortableReview;
}

export interface OperationReviewChange {
  kind: 'add' | 'change' | 'remove' | 'keep' | 'warning';
  group?: 'requested' | 'dependencies' | 'portableTarget' | 'portableInputs' | 'portableWarnings' | 'preserved';
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
}

export type ReviewPreparationStageId = 'validate' | 'status' | 'catalog' | 'inventory'
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
  elapsedMs?: number;
  messages?: string[];
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
  payload: StatusV4Payload;
  pluginSummaries: StatusV4PluginSummary[];
  targetRevisions?: StatusTargetRevision[];
  sourceDetails?: SourceDetailViewModel[];
  dependencyOverviews?: PluginDependencyOverviewViewModel[];
  portablePluginIds?: string[];
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
  loadStatus: (signal: AbortSignal) => Promise<TuiStatusLoadResult>;
  checkSource: (sourceId: string, signal: AbortSignal) => Promise<{
    sourceIdentity: string;
    requestedRef: string;
  }>;
  inspectSourceRemoval?: (sourceId: string, signal: AbortSignal) => Promise<SourceReferenceSummaryViewModel>;
  captureEvidence: (intent: OperationIntent, signal?: AbortSignal) => Promise<OperationEvidence>;
  validateIntent?: (intent: OperationIntent, signal: AbortSignal) => Promise<void>;
  prepareReviewEvidence?: (
    intent: OperationIntent,
    signal: AbortSignal,
    onStage: (stage: ReviewPreparationStageId) => void | Promise<void>,
  ) => Promise<OperationEvidence>;
  executeIntent: (
    intent: OperationIntent,
    expectedEvidence: OperationEvidence,
  ) => Promise<unknown>;
  getConfigGroups?: (
    pluginId: string,
    layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer },
    signal: AbortSignal,
  ) => Promise<ConfigGroupViewModel[]>;
  getConfigPage?: (
    pluginId: string,
    layer: { scope: Scope | 'effective'; projectLayer: ProjectConfigStoreLayer },
    signal: AbortSignal,
  ) => Promise<ConfigPageViewModel>;
  getConfigResetAvailability?: (
    pluginId: string,
    layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer },
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
  sourceIdentityPresent: boolean;
  sourceIdentity?: string;
  storeDigest?: string;
}

export interface TuiControllerSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
  router: TuiRouterSnapshot;
  viewModel?: TuiViewModel;
  sourceHealth: SourceHealthViewModel[];
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

export function operationEvidenceFingerprint(evidence: OperationEvidence): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(evidence))).digest('hex');
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

function operationLabels(intent: OperationIntent): {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: boolean;
} {
  if (intent.kind === 'portableInstall') {
    return {
      title: '确认安装通用 Skills',
      description: '只安装已选择的 Skills；不会修改原生插件安装。',
      primaryLabel: `开始安装 ${intent.selectedSkills.length} 个 Skills`,
      destructive: false,
    };
  }
  if (intent.kind === 'pluginWrite') {
    if (intent.originIssue) {
      return {
        title: '处理问题',
        description: '只执行所选问题处理动作；插件设置保持不变。',
        primaryLabel: '开始处理',
        destructive: intent.action !== 'reinstall',
      };
    }
    if (intent.action === 'cleanup' && intent.force === true) {
      return {
        title: '强制清理插件',
        description: '跳过依赖保护并清理可证明属于 AW 的现场内容。依赖者会变为不完整。配置保持不变。',
        primaryLabel: '确认强制清理',
        destructive: true,
      };
    }
    const labels: Record<PluginWriteOperation, [string, string, boolean]> = {
      install: ['添加插件', '添加所选平台和使用位置。', false],
      upgrade: ['升级插件', '使用当前来源内容重建所选安装。', false],
      reinstall: ['重新安装插件', '清理 AW 管理的内容后完整重建。', true],
      uninstall: ['移除插件', '移除 AW 管理的安装内容。配置保持不变。', true],
      cleanup: ['清理插件', '只移除可证明属于 AW 的现场内容。配置保持不变。', true],
    };
    const [title, description, destructive] = labels[intent.action];
    return { title, description, primaryLabel: title, destructive };
  }
  if (intent.kind === 'configSave') {
    return {
      title: '保存插件设置',
      description: '保存所选设置层，并重新应用可见安装。',
      primaryLabel: '保存并应用',
      destructive: false,
    };
  }
  if (intent.kind === 'configReset') {
    return {
      title: '重置插件设置',
      description: '删除所选设置层的值，恢复继承。',
      primaryLabel: '重置设置',
      destructive: true,
    };
  }
  if (intent.kind === 'sourceMutation') {
    const labels = {
      add: ['添加来源', '先保存来源配置，再尽力刷新来源。刷新失败时配置仍保留。', '保存并刷新', false],
      update: ['修改来源', '先保存来源配置，再尽力刷新来源。刷新失败时配置仍保留。', '保存并刷新', false],
      setPrimary: ['设为主来源', '只改变默认 marketplace，不迁移安装。', '设为主来源', false],
      remove: ['移除来源', '移除来源配置；不会删除其它来源。', '移除来源', true],
    } as const;
    const [title, description, primaryLabel, destructive] = labels[intent.action];
    return { title, description, primaryLabel, destructive };
  }
  throw new TuiOperationBlockedError(
    'operationNotImplemented',
    '问题修复操作尚未接入。',
  );
}

function dependencyRelation(
  plan: DependencyOperationPlan,
  pluginId: string,
): 'requested' | 'direct' | 'transitive' {
  if (plan.requestedPluginIds.includes(pluginId)) return 'requested';
  return plan.dependencyEdges.some((edge) =>
    plan.requestedPluginIds.includes(edge.from) && edge.to === pluginId)
    ? 'direct'
    : 'transitive';
}

function reviewChanges(
  intent: OperationIntent,
  evidence?: OperationEvidence,
  dependencyOverview?: PluginDependencyOverviewViewModel,
): OperationReviewChange[] {
  if (intent.kind === 'portableInstall') {
    const review = evidence?.portable;
    if (!review) throw new TuiOperationBlockedError('portablePrepareFailed', '缺少通用 Skills Review 证据。');
    return [
      ...review.selected.map((skill): OperationReviewChange => ({
        kind: 'add',
        group: skill.relation === 'requested' ? 'requested' : 'dependencies',
        pluginId: skill.providerPluginId,
        relation: skill.relation,
        title: skill.name,
        description: `${skill.description} · ${skill.providerDisplayName}${skill.dynamic ? ' · 按设置生成' : ''}`,
      })),
      { kind: 'change', group: 'portableTarget', title: 'Agent', description: review.agentMode === 'automatic'
        ? '自动选择检测到的 Agent；未检测到时可能选择全部 Agent'
        : review.requestedAgents.join('、') },
      { kind: 'change', group: 'portableTarget', title: '范围', description: review.scope === 'project' ? '当前项目' : '所有项目' },
      { kind: review.dependencies.length > 0 ? 'keep' : 'change', group: 'portableInputs', title: '插件依赖', description: review.dependencies.length > 0
        ? `${review.dependencies.length} 个依赖用于生成，不能取消` : '无需插件依赖' },
      ...(review.collisions.length > 0 ? [{ kind: 'warning' as const, group: 'portableWarnings' as const, title: '同名覆盖',
        description: review.collisions.map((collision) => collision.name).join('、') }] : []),
    ];
  }
  if (intent.kind === 'pluginWrite') {
    const plan = evidence?.dependencyPlan;
    if (plan && (intent.action === 'install' || intent.action === 'upgrade' || intent.action === 'reinstall')) {
      const changes = plan.targets.map((target): OperationReviewChange => {
        const relation = dependencyRelation(plan, target.pluginId);
        const actionKind = target.action === 'keep'
          ? 'keep'
          : target.action === 'install'
            ? 'add'
            : 'change';
        return {
          kind: actionKind,
          group: relation === 'requested' ? 'requested' : 'dependencies',
          pluginId: target.pluginId,
          relation,
          title: pluginNameFromId(target.pluginId),
          description: `${target.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${target.resolvedScope === 'user' ? '所有项目' : '当前项目'}${target.action === 'keep' ? ' · 已可用' : ''}`,
        };
      });
      changes.push({
        kind: 'keep',
        group: 'preserved',
        title: '插件设置和已有依赖保持不变',
        description: '移除根插件时不会自动清理依赖。',
      });
      return changes;
    }
    const platforms: PlatformName[] = intent.platform === 'both'
      ? ['codex', 'claude']
      : [intent.platform];
    const changes = platforms.map((platform): OperationReviewChange => ({
      kind: intent.action === 'uninstall' || intent.action === 'cleanup' ? 'remove' : intent.action === 'install' ? 'add' : 'change',
      title: `${platform === 'codex' ? 'Codex' : 'Claude Code'} · ${intent.scope === 'user' ? '所有项目' : '当前项目'}`,
      description: intent.action === 'uninstall' || intent.action === 'cleanup'
        ? '插件设置不会删除。'
        : '执行前会再次检查当前安装状态。',
    }));
    if (intent.action === 'uninstall' || intent.action === 'cleanup') {
      changes.push(...(dependencyOverview?.dependencies ?? []).map((dependency) => ({
        kind: 'keep' as const,
        group: 'preserved' as const,
        pluginId: dependency.pluginId,
        relation: dependency.relation === 'direct' ? 'direct' as const : 'transitive' as const,
        title: dependency.displayName,
        description: '依赖保持安装。',
      })));
    }
    if (intent.action === 'cleanup' && intent.force === true) {
      changes.push({
        kind: 'warning',
        title: '跳过依赖保护',
        description: '依赖此插件的插件会变为不完整，需重新安装后恢复。',
      });
    }
    if (intent.originIssue) {
      changes.push(
        { kind: 'keep', title: '插件设置保持不变' },
        { kind: 'warning', title: '执行前重新检查完整目标和来源证据' },
      );
    }
    return changes;
  }
  if (intent.kind === 'configReset') {
    const layerLabel = intent.scope === 'user'
      ? '个人默认'
      : intent.projectLayer === 'local' ? '当前项目（仅本机）' : '当前项目';
    return [
      { kind: 'remove', title: `删除${layerLabel}中的已存值`, description: '有效值将恢复为继承值或默认值。' },
      { kind: 'change', title: '重新计算有效设置' },
      { kind: 'change', title: '重新应用当前可见安装位置' },
      { kind: 'keep', title: intent.scope === 'user' ? '当前项目和本机设置层保持不变' : '其他设置层保持不变' },
    ];
  }
  if (intent.kind === 'sourceMutation') {
    const changes = (intent.changes ?? []).map((change): OperationReviewChange => ({
      kind: intent.action === 'remove' ? 'remove' : intent.action === 'add' ? 'add' : 'change',
      title: change.title,
      ...(change.private
        ? { description: change.before ? '已设置 → 将更新' : '已选择' }
        : change.before || change.after
          ? { description: `${change.before ?? '未设置'} → ${change.after ?? '未设置'}` }
          : {}),
    }));
    if (intent.action === 'add') changes.push({ kind: 'keep', title: '保留现有主来源' });
    if (intent.action === 'setPrimary') changes.push(
      { kind: 'keep', title: '同名插件选择保持不变' },
      { kind: 'keep', title: '现有安装和设置不会迁移' },
    );
    if (intent.action === 'remove') changes.push({ kind: 'keep', title: '保留其他来源' });
    return changes;
  }
  if (intent.kind !== 'configSave') {
    throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
  }
  const privateKeys = new Set([...(intent.sensitiveKeys ?? []), ...(intent.privateKeys ?? [])]);
  if (intent.changes) {
    return [
      ...intent.changes.map((change): OperationReviewChange => ({
        kind: 'change',
        title: change.title,
        description: privateKeys.has(change.key)
          ? change.after === '未设置' ? '已设置 → 未设置' : '已设置 → 将更新'
          : `${change.before} → ${change.after}`,
      })),
      { kind: 'change', title: '重新应用插件内容', description: '只处理当前可见安装位置。' },
      { kind: 'keep', title: '其他项目不会被自动扫描' },
    ];
  }
  const updateKeys = Object.keys(intent.updates ?? {});
  return [
    ...updateKeys.map((key): OperationReviewChange => ({
      kind: 'change',
      title: key,
      description: privateKeys.has(key) ? '已设置 → 将更新' : '将更新',
    })),
    ...(intent.removeKeys ?? []).map((key): OperationReviewChange => ({
      kind: 'remove',
      title: key,
      description: privateKeys.has(key) ? '已设置 → 未设置' : '恢复继承',
    })),
  ];
}

function technicalDetails(evidence: OperationEvidence): string[] {
  const details = [
    `Catalog 配置：${evidence.catalog.configDigest}`,
    `Catalog 组合：${evidence.catalog.compositeDigest}`,
  ];
  if (evidence.source) {
    details.push(`来源：${evidence.source.sourceId}`);
    details.push(`来源身份：${evidence.source.sourceIdentity}`);
    if (evidence.source.resolvedCommit) details.push(`Snapshot commit：${evidence.source.resolvedCommit}`);
    if (evidence.source.snapshotDigest) details.push(`Snapshot digest：${evidence.source.snapshotDigest}`);
    if (evidence.source.contentDigest) details.push(`Content digest：${evidence.source.contentDigest}`);
  }
  if (evidence.targetFingerprint) details.push(`目标状态：${evidence.targetFingerprint}`);
  if (evidence.dependencyPlan) details.push(`安装计划：${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`);
  if (evidence.config) details.push(`设置层：${evidence.config.scope}/${evidence.config.projectLayer} · ${evidence.config.storeDigest}`);
  if (evidence.sourceWrite) {
    details.push(`候选配置：${evidence.sourceWrite.candidateDigest}`);
    details.push(`引用清单：${evidence.sourceWrite.inventoryDigest} · ${evidence.sourceWrite.referenceCount} 项`);
  }
  if (evidence.portable) {
    details.push(`Portable 候选：${evidence.portable.selected.length} 个`);
    details.push(`Materialization：${evidence.portable.materializationDigest}`);
    details.push(`Skills CLI：${evidence.portable.skillsCliVersion}`);
  }
  return details;
}

function issueCode(error: unknown): string {
  if (error instanceof TuiOperationBlockedError) return error.code;
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
  const diagnosticCode = typedCode ?? fallback ?? 'portableValidationFailed';
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
  readonly #sourceTokens = new Map<string, number>();
  readonly #successfulSourceRefreshes = new Map<string, {
    generation: number;
    sourceIdentity: string;
    requestedRef: string;
  }>();
  readonly #sourceAborts = new Map<string, AbortController>();
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
  #generation = 0;
  #refreshSequence = 0;
  #appliedRefreshSequence = 0;
  #disposed = false;

  constructor(
    readonly dependencies: TuiControllerDependencies,
    progressFeed?: RebuildProgressFeed,
  ) {
    this.#progressFeed = progressFeed;
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
      router: this.#router.snapshot,
      ...(this.#viewModel ? { viewModel: this.#viewModel } : {}),
      sourceHealth: [...this.#health.values()],
      progress: this.#progress,
      progressTargets: this.#progressTargets,
      ...(this.#activeReview ? { activeReview: this.#activeReview } : {}),
      ...(this.#reviewPreparation ? { reviewPreparation: this.#reviewPreparation.snapshot } : {}),
      ...(this.#result ? { result: this.#result } : {}),
      ...(this.#loadError ? { loadError: this.#loadError } : {}),
      ...(this.#portableDraft ? { portableDraft: this.#portableDraft } : {}),
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
    this.#health.clear();
    for (const source of status.payload.catalog.sources) {
      this.#health.set(source.id, {
        sourceId: source.id,
        state: source.error ? 'unavailable'
          : source.type === 'path' ? 'path'
            : source.freshness === 'cache' ? 'cache' : 'ready',
        ...(source.error ? { message: '来源当前没有可用数据。' } : {}),
      });
      const successful = this.#successfulSourceRefreshes.get(source.id);
      if (successful?.generation === this.#generation
        && successful.sourceIdentity === source.identity
        && successful.requestedRef === source.requestedRef
        && !source.error) {
        this.#health.set(source.id, {
          sourceId: source.id,
          state: source.type === 'path' || source.freshness === 'path' ? 'path' : 'ready',
        });
      }
    }
    const sourceIds = new Set(status.payload.catalog.sources.map((source) => source.id));
    for (const sourceId of this.#successfulSourceRefreshes.keys()) {
      if (!sourceIds.has(sourceId)) this.#successfulSourceRefreshes.delete(sourceId);
    }
    this.#project();
    this.#normalizeCurrentRoute();
  }

  #applyRefreshStatus(
    status: TuiStatusLoadResult,
    sourceId: string,
    health: SourceHealthViewModel,
    refreshSequence: number,
  ): boolean {
    if (refreshSequence < this.#appliedRefreshSequence) return false;
    this.#appliedRefreshSequence = refreshSequence;
    this.#applyStatus(status);
    if (!status.payload.catalog.sources.some((source) => source.id === sourceId)) return true;
    this.#health.set(sourceId, health);
    this.#project();
    return true;
  }

  #recordSuccessfulSourceRefresh(
    sourceId: string,
    checked: { sourceIdentity: string; requestedRef: string },
    generation: number,
  ): void {
    const authoritative = this.#status?.payload.catalog.sources.find((source) => source.id === sourceId);
    if (!authoritative || authoritative.type !== 'git' || authoritative.error
      || authoritative.identity !== checked.sourceIdentity
      || authoritative.requestedRef !== checked.requestedRef) return;
    this.#successfulSourceRefreshes.set(sourceId, {
      generation,
      sourceIdentity: checked.sourceIdentity,
      requestedRef: checked.requestedRef,
    });
    this.#health.set(sourceId, {
      sourceId,
      state: 'ready',
    });
  }

  #cancelSourceRefreshes(): void {
    for (const abort of this.#sourceAborts.values()) abort.abort();
    this.#sourceAborts.clear();
  }

  #startGitSourceRefreshes(): void {
    for (const source of this.#status?.payload.catalog.sources ?? []) {
      if (source.type === 'git') void this.refreshSource(source.id).catch(() => undefined);
    }
  }

  async load(): Promise<void> {
    this.#cancelSourceRefreshes();
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
    this.#startGitSourceRefreshes();
  }

  async refreshSource(sourceId: string): Promise<void> {
    if (this.#disposed || !this.#status) return;
    this.#sourceAborts.get(sourceId)?.abort();
    const sourceAbort = new AbortController();
    this.#sourceAborts.set(sourceId, sourceAbort);
    const finishRefresh = (): void => {
      if (this.#sourceAborts.get(sourceId) === sourceAbort) this.#sourceAborts.delete(sourceId);
    };
    const signal = AbortSignal.any([this.#abort.signal, sourceAbort.signal]);
    const token = (this.#sourceTokens.get(sourceId) ?? 0) + 1;
    this.#sourceTokens.set(sourceId, token);
    const generation = this.#generation;
    const current = this.#status.payload.catalog.sources.find((source) => source.id === sourceId);
    if (!current) {
      finishRefresh();
      return;
    }
    const hadCache = current.type === 'git' && current.error === undefined
      && (current.freshness === 'cache' || current.freshness === 'remote');
    this.#health.set(sourceId, { sourceId, state: 'checking' });
    this.#project();
    this.#publish();
    let checkError: unknown;
    let checked: { sourceIdentity: string; requestedRef: string } | undefined;
    try {
      checked = await this.dependencies.checkSource(sourceId, signal);
    } catch (error) {
      checkError = error;
    }
    if (this.#disposed || signal.aborted || generation !== this.#generation
      || token !== this.#sourceTokens.get(sourceId)) {
      finishRefresh();
      return;
    }
    if (checkError) this.#successfulSourceRefreshes.delete(sourceId);
    const refreshSequence = ++this.#refreshSequence;
    let status: TuiStatusLoadResult;
    let authoritativeReloadSucceeded = true;
    try {
      status = await this.dependencies.loadStatus(signal);
    } catch (error) {
      authoritativeReloadSucceeded = false;
      if (!checkError) checkError = error;
      this.#successfulSourceRefreshes.delete(sourceId);
      status = structuredClone(this.#status);
    }
    if (this.#disposed || signal.aborted || generation !== this.#generation
      || token !== this.#sourceTokens.get(sourceId)) {
      finishRefresh();
      return;
    }
    if (checkError) {
      await this.#logErrorSafe(checkError, 'catalogSourceRefreshFailed', {
        privateConfigOperation: true,
      });
    }
    const refreshed = status.payload.catalog.sources.find((source) => source.id === sourceId);
    const refreshedMatchesCheck = checked !== undefined && refreshed !== undefined
      && refreshed.type === 'git'
      && !refreshed.error
      && refreshed.identity === checked.sourceIdentity
      && refreshed.requestedRef === checked.requestedRef;
    const state = checkError
      ? authoritativeReloadSucceeded
        ? !refreshed || refreshed.error
          ? 'unavailable'
          : refreshed.type === 'path' || refreshed.freshness === 'path'
            ? 'path'
            : refreshed.freshness === 'cache' ? 'degraded' : 'unavailable'
        : hadCache ? 'degraded' : 'unavailable'
        : !refreshed
          ? 'unavailable'
          : refreshed.error
          ? 'unavailable'
          : !refreshedMatchesCheck
            ? refreshed.type === 'path' || refreshed.freshness === 'path'
              ? 'path'
              : refreshed.freshness === 'cache' ? 'cache' : 'unavailable'
          : refreshed.type === 'path' || refreshed.freshness === 'path'
            ? 'path'
            : 'ready';
    this.#applyRefreshStatus(status, sourceId, {
      sourceId,
      state,
      ...(state === 'degraded' || state === 'unavailable' ? {
        issueId: `source:${sourceId}:${state === 'degraded' ? 'cache' : 'unavailable'}`,
        message: checkError
          ? state === 'degraded'
            ? '远端检查失败。当前仍使用已验证的缓存数据。'
            : '远端检查失败，并且没有可用缓存数据。'
          : state === 'degraded'
            ? '远端检查后仍只能使用缓存数据。'
            : '来源检查后没有可用数据。',
      } : {}),
    }, refreshSequence);
    if (!checkError && refreshedMatchesCheck && checked) {
      this.#recordSuccessfulSourceRefresh(sourceId, checked, generation);
    }
    finishRefresh();
    if (generation !== this.#generation) return;
    this.#project();
    this.#publish();
  }

  push(route: TuiRoute, context?: TuiPageContext): void {
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
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
      layer: { scope: 'effective', projectLayer: 'shared' },
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
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    const route = this.#router.snapshot.current.route;
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
      const placement = plugin.installedPlacements.find((entry) => entry.platform === platform);
      if (!placement) return { platform, compatible: false, disabled: '当前没有可信的平台能力信息' };
      if (placement.state === 'scopeConflict') {
        return { platform, compatible: false, disabled: '安装位置冲突；请先处理问题' };
      }
      if (placement.state === 'installed') {
        return {
          platform,
          compatible: false,
          disabled: `已安装到${placement.scope === 'user' ? '所有项目' : '当前项目'}；请先移除现有安装`,
        };
      }
      if (!placement.supportedScopes.includes(scope)) {
        return { platform, compatible: false, disabled: '不支持所选位置' };
      }
      const overview = this.#viewModel?.dependencyOverviews.find((entry) => entry.pluginId === pluginId);
      for (const dependency of overview?.dependencies ?? []) {
        const dependentPlugin = this.#viewModel?.plugins.find((entry) =>
          entry.pluginId === dependency.pluginId);
        if (!dependentPlugin || !dependentPlugin.supportedPlatforms.includes(platform)) {
          return {
            platform,
            compatible: false,
            disabled: `${dependency.displayName} 不支持${platform === 'codex' ? 'Codex' : 'Claude Code'}`,
          };
        }
        const dependencyPlacement = dependentPlugin.installedPlacements.find((entry) =>
          entry.platform === platform);
        if (dependencyPlacement?.state === 'scopeConflict') {
          return { platform, compatible: false, disabled: `${dependency.displayName} 的安装位置冲突` };
        }
        if (dependencyPlacement?.state === 'installed') {
          if (dependencyPlacement.health !== 'ready') {
            return { platform, compatible: false, disabled: `${dependency.displayName} 需要先处理` };
          }
          if (scope === 'user' && dependencyPlacement.scope === 'project') {
            return { platform, compatible: false, disabled: `${dependency.displayName} 只在当前项目可用` };
          }
        }
        if (dependencyPlacement?.state === 'notInstalled'
          && !dependencyPlacement.supportedScopes.includes(scope)) {
          return { platform, compatible: false, disabled: `${dependency.displayName} 不支持所选位置` };
        }
      }
      return { platform, compatible: true };
    });
  }

  getTargetState(
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
  ): StatusV4Payload['targets'][number]['state'] | undefined {
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

  async inspectSourceRemoval(sourceId: string): Promise<SourceReferenceSummaryViewModel> {
    if (!this.dependencies.inspectSourceRemoval) {
      throw new TuiOperationBlockedError('stateInventoryFailed', '来源引用清单不可用。');
    }
    return cloneFrozen(await this.dependencies.inspectSourceRemoval(sourceId, this.#abort.signal));
  }

  async getConfigGroups(
    pluginId: string,
    layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer },
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
    layer: { scope: Scope | 'effective'; projectLayer: ProjectConfigStoreLayer },
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
    layer: { scope: Scope; projectLayer: ProjectConfigStoreLayer },
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
      throw new TuiOperationBlockedError(code, '操作未建立。请检查当前设置后重试。');
    }
  }

  startReviewPreparation(intent: OperationIntent, returnRoute?: TuiRoute): ReviewPreparationSnapshot {
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
    this.#assertIssueOrigin(intent);
    if (intent.kind === 'pluginWrite'
      && (intent.action === 'uninstall' || intent.action === 'cleanup')
      && intent.force !== true
      && (intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform])
        .some((platform) => this.getBlockingDependents(intent.pluginId, platform, intent.scope).length > 0)) {
      throw new TuiOperationBlockedError(
        'dependencyStillRequired',
        '仍有已安装插件依赖这个插件。请先查看完整依赖关系。',
      );
    }
  }

  #reviewPreparationLabel(intent: OperationIntent): string {
    if ('pluginId' in intent) {
      return this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.displayName
        ?? pluginNameFromId(intent.pluginId);
    }
    return intent.sourceId;
  }

  #reviewPreparationIsCurrent(token: number): boolean {
    const preparation = this.#reviewPreparation;
    return Boolean(preparation && preparation.token === token
      && !preparation.abort.signal.aborted
      && !this.#disposed
      && this.#router.snapshot.current.route.name === 'reviewPreparing'
      && this.#router.snapshot.current.route.preparationId === preparation.snapshot.id);
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
      const active = this.#reviewPreparation!;
      active.snapshot.state = 'failed';
      active.snapshot.stages = active.snapshot.stages.map((stage) =>
        stage.state === 'running' ? { ...stage, state: 'failed' } : stage);
      active.snapshot.code = 'reviewPreparationFailed';
      active.snapshot.message = '无法准备确认信息。请返回检查选择，或重试。';
      this.#publish();
      await this.#logOperationError(error, issueCode(error), intent);
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
    const labels = operationLabels(intent);
    const operationId = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const reviewToken = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const now = this.dependencies.now?.() ?? Date.now();
    this.#pruneReviewTickets(now);
    const expiresAt = now
      + (this.dependencies.reviewTtlMs ?? 2 * 60_000);
    const pluginId = 'pluginId' in intent ? intent.pluginId : intent.sourceId;
    if ('pluginId' in intent) sourceIdFromPluginId(intent.pluginId);
    const review: OperationReviewModel = {
      operationId,
      reviewToken,
      expiresAt,
      operationKind: intent.kind,
      ...(intent.kind === 'sourceMutation' ? { sourceAction: intent.action } : {}),
      ...(intent.kind === 'pluginWrite' ? { pluginAction: intent.action } : {}),
      ...(intent.kind === 'pluginWrite' && intent.originIssue
        ? { originIssue: intent.originIssue }
        : {}),
      title: labels.title,
      description: labels.description,
      subject: {
        name: 'pluginId' in intent
          ? this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.displayName
            ?? pluginNameFromId(intent.pluginId)
          : pluginId,
        ...('pluginId' in intent ? { sourceLabel: sourceIdFromPluginId(intent.pluginId) } : {}),
        ...('pluginId' in intent
          && this.#viewModel?.plugins.find((plugin) => plugin.pluginId === intent.pluginId)?.version
          ? { version: this.#viewModel.plugins.find((plugin) => plugin.pluginId === intent.pluginId)!.version }
          : {}),
      },
      changes: reviewChanges(
        intent,
        evidence,
        'pluginId' in intent ? this.getPluginDependencyOverview(intent.pluginId) : undefined,
      ),
      technicalDetails: technicalDetails(evidence),
      ...(intent.kind === 'pluginWrite' && intent.action === 'cleanup' && intent.force === true
        ? { equivalentCommand: `aw cleanup ${intent.pluginId} --platform ${intent.platform} --scope ${intent.scope} --force` }
        : {}),
      primaryLabel: intent.kind === 'pluginWrite' && evidence.dependencyPlan
        ? `${labels.primaryLabel} ${evidence.dependencyPlan.resolvedPluginIds.length} 个插件`
        : labels.primaryLabel,
      ...(labels.destructive ? { destructive: true } : {}),
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
      relation: dependencyRelation(dependencyPlan, target.pluginId),
      requiredBy: target.requiredBy,
      state: target.action === 'keep' ? 'kept' as const : 'pending' as const,
    })) ?? [];
    this.#progress = {
      messages: [],
      startedAtMs,
      elapsedMs: 0,
      current: {
        target: 'pluginId' in ticket.intent ? ticket.intent.pluginId : ticket.intent.sourceId,
        phase: '验证当前状态',
      },
    };
    this.#router.replace({ name: 'progress', operationId });
    this.#publish();
    try {
      this.#assertIssueOrigin(ticket.intent);
      await this.dependencies.validateIntent?.(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#cancelSourceRefreshes();
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
    if (operationEvidenceFingerprint(current) !== operationEvidenceFingerprint(ticket.evidence)) {
      return this.#rebuildStaleReview(ticket, operationId, current, generation);
    }
    if (ticket.intent.kind === 'sourceMutation') {
      this.#cancelSourceRefreshes();
      generation = ++this.#generation;
    }
    try {
      const execution = await this.dependencies.executeIntent(
        structuredClone(ticket.intent),
        structuredClone(ticket.evidence),
      );
      const executionTargets = operationResultSummary(ticket.intent, execution).targets ?? [];
      this.#progressTargets = this.#progressTargets.map((target) => {
        const completed = executionTargets.find((candidate) =>
          candidate.pluginId === target.pluginId
          && candidate.platform === target.platform && candidate.scope === target.scope);
        return completed ? { ...target, state: completed.state } : target;
      });
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      this.#cancelSourceRefreshes();
      generation = ++this.#generation;
      if (ticket.intent.kind === 'sourceMutation') {
        try {
          this.#progressFeed?.setCurrent(
            { target: 'Catalog 来源配置', phase: '读取最终状态' },
            '来源操作：读取最终状态',
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
      const pluginSummary = ticket.intent.kind === 'pluginWrite'
        ? operationResultSummary(ticket.intent, execution)
        : undefined;
      const hasFailedDependencyTarget = pluginSummary?.targets?.some((target) =>
        target.relation !== undefined && (target.state === 'failed' || target.state === 'skipped'));
      const hasPreservedTarget = pluginSummary?.targets?.some((target) =>
        target.state === 'completed' || target.state === 'kept');
      const dependencyPartial = pluginSummary?.code === 'operationPartial'
        && Boolean(hasFailedDependencyTarget && hasPreservedTarget);
      const dependencyFailure = pluginSummary?.code === 'operationFailed'
        && Boolean(hasFailedDependencyTarget);
      if (pluginSummary?.code === 'operationFailed') {
        return this.#setBlocked(operationId, 'operationFailed', {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          ...(dependencyFailure ? { summary: pluginSummary } : {}),
          ...(!dependencyFailure ? { writeMayHaveCompleted: true } : {}),
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
      this.#startGitSourceRefreshes();
      return cloneFrozen(result);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      if (code === 'operationReviewStale') {
        return this.#rebuildStaleReview(ticket, operationId, undefined, generation);
      }
      this.#cancelSourceRefreshes();
      generation = ++this.#generation;
      try {
        const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        this.#applyStatus(refreshed);
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
        writeMayHaveCompleted: true,
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
    this.#cancelSourceRefreshes();
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
    try {
      this.#assertIssueOrigin(ticket.intent);
      await this.dependencies.validateIntent?.(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
      const result: OperationExecuteResult = {
        state: 'blocked',
        operationId,
        code,
        message: '状态已变化，原操作不再安全。请修改选择后重试。',
        ...this.#operationIdentity(ticket.intent),
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
          structuredClone(ticket.intent),
          this.#abort.signal,
        );
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const code = issueCode(error);
        await this.#logOperationError(error, code, ticket.intent);
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        return this.#setBlocked(operationId, code, { intent: ticket.intent, returnRoute: ticket.returnRoute });
      }
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    if (ticket.intent.kind === 'portableInstall') {
      try {
        await this.refreshPortableInstallDraft(ticket.intent.pluginId);
      } catch (error) {
        if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
        const code = issueCode(error);
        await this.#logOperationError(error, code, ticket.intent);
        return this.#setBlocked(operationId, code, { intent: ticket.intent, returnRoute: ticket.returnRoute });
      }
    }
    if (!this.#operationIsCurrent(generation)) return this.#detachedBlocked(operationId, ticket.intent);
    const review = this.#storeOperationReview(ticket.intent, evidence, 'replace', ticket.returnRoute);
    const result: OperationExecuteResult = { state: 'stale', operationId, review, ...this.#operationIdentity(ticket.intent) };
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
    const message = code === 'portableSkillsCliInstallFailed'
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

  #assertIssueOrigin(intent: OperationIntent): void {
    if (intent.kind !== 'pluginWrite' || !intent.originIssue) return;
    const origin = intent.originIssue;
    const issue = this.#viewModel?.issues.find((candidate) => candidate.issueId === origin.issueId);
    const action = issue?.actions.find((candidate) => candidate.id === origin.actionId);
    if (!issue || !action || issue.category !== origin.category
      || userIssueKey(issue) !== origin.issueKey
      || (action.pluginId ?? issue.pluginId) !== intent.pluginId
      || issue.platform !== intent.platform
      || issue.sourceId !== sourceIdFromPluginId(intent.pluginId)) {
      throw new TuiOperationBlockedError('operationReviewStale', '原问题与当前状态不匹配。');
    }
    const expected = issue.category === 'dependencyMissing'
      ? action.id === 'installDependency' && action.writeAction === 'install'
        ? { action: 'install' as const, scope: action.scope, platform: action.platform }
        : undefined
      : issue.category === 'dependencyNotReady'
        ? action.id === 'reinstallDependency' && action.writeAction === 'reinstall'
          ? { action: 'reinstall' as const, scope: action.scope, platform: action.platform }
          : undefined
        : issue.category === 'incompleteInstallation'
      ? origin.actionId === 'reinstall'
        ? { action: 'reinstall' as const, scope: issue.scope }
        : origin.actionId === 'remove'
          ? { action: 'uninstall' as const, scope: issue.scope }
          : undefined
      : issue.category === 'scopeConflict'
        ? origin.actionId === 'keepUserScope'
          ? { action: 'uninstall' as const, scope: 'project' as const }
          : origin.actionId === 'keepProjectScope'
            ? { action: 'uninstall' as const, scope: 'user' as const }
            : undefined
        : undefined;
    const dependencyOriginValid = issue.category !== 'dependencyMissing' && issue.category !== 'dependencyNotReady'
      || (origin.consumerPluginId === issue.pluginId
        && origin.consumerSourceIdentity === issue.sourceIdentity
        && origin.consumerPlatform === issue.platform
        && origin.consumerScope === issue.scope
        && origin.dependencyPluginId === issue.dependencyPluginId
        && origin.dependencyPlatform === issue.dependencyPlatform
        && origin.dependencyScope === issue.dependencyScope
        && origin.dependencyProject === issue.dependencyProject);
    if (!expected || intent.action !== expected.action || intent.scope !== expected.scope
      || ('platform' in expected && intent.platform !== expected.platform) || !dependencyOriginValid) {
      throw new TuiOperationBlockedError('operationReviewStale', '问题动作与当前目标不匹配。');
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelReviewPreparation();
    this.#cancelPortableRequest();
    this.#abort.abort();
    this.#cancelSourceRefreshes();
    this.#progressUnsubscribe?.();
    this.#tickets.clear();
    this.#phase = 'disposed';
    this.#listeners.clear();
  }
}

function operationResultSummary(intent: OperationIntent, execution: unknown): OperationResultSummary {
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
  const sourceWarnings = intent.kind === 'sourceMutation'
    && typeof execution === 'object' && execution !== null
    && Array.isArray((execution as { errors?: unknown }).errors)
    ? (execution as { errors: Array<{ message?: unknown }> }).errors.flatMap((error) =>
        typeof error?.message === 'string' ? [`警告：${error.message}`] : [])
    : [];
  const executionPlan = typeof execution === 'object' && execution !== null
    && typeof (execution as { dependencyPlan?: unknown }).dependencyPlan === 'object'
    ? (execution as { dependencyPlan: DependencyOperationPlan }).dependencyPlan
    : undefined;
  const rawTargets = typeof execution === 'object' && execution !== null
    && Array.isArray((execution as { targetResults?: unknown }).targetResults)
    ? (execution as { targetResults: Array<Record<string, unknown>> }).targetResults
    : [];
  const targets = rawTargets.flatMap((entry) => {
    const target = typeof entry.target === 'object' && entry.target !== null
      ? entry.target as Record<string, unknown>
      : entry;
    const platform = target.platform;
    const scope = target.scope;
    const pluginId = target.pluginId;
    const rawState = entry.state;
    const action = entry.action;
    if ((platform !== 'codex' && platform !== 'claude')
      || (scope !== 'user' && scope !== 'project')
      || (rawState !== 'completed' && rawState !== 'failed')) return [];
    const planned = executionPlan?.targets.find((candidate) =>
      candidate.pluginId === pluginId && candidate.platform === platform
      && candidate.resolvedScope === scope);
    const state = action === 'keep' ? 'kept' as const
      : action === 'skipped' ? 'skipped' as const
        : rawState as 'completed' | 'failed';
    return [{
      ...(typeof pluginId === 'string' ? { pluginId } : {}),
      platform: platform as PlatformName,
      scope: scope as Scope,
      state,
      ...(planned && executionPlan ? {
        relation: dependencyRelation(executionPlan, planned.pluginId),
        requiredBy: planned.requiredBy,
      } : {}),
    }];
  });
  const inferredTargets = intent.kind === 'pluginWrite' && targets.length === 0
    ? (intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform]).map((platform) => ({
        platform,
        scope: intent.scope,
        state: 'completed' as const,
      }))
    : targets;
  const partial = inferredTargets.some((target) => target.state === 'failed' || target.state === 'skipped')
    && inferredTargets.some((target) => target.state === 'completed' || target.state === 'kept');
  const overallFailed = typeof execution === 'object' && execution !== null
    && (execution as { overallState?: unknown }).overallState === 'failed';
  const failed = overallFailed || (inferredTargets.length > 0
    && inferredTargets.every((target) => target.state === 'failed' || target.state === 'skipped'));
  return {
    code: failed && !partial ? 'operationFailed' : partial ? 'operationPartial' : 'operationSucceeded',
    message: failed && !partial
      ? '操作结果无法确认。'
      : partial
      ? '操作只完成了一部分。'
      : '操作已完成。',
    ...(intent.kind === 'pluginWrite' ? {
      pluginId: intent.pluginId,
      action: intent.action,
    } : {}),
    ...(inferredTargets.length > 0 ? { targets: inferredTargets } : {}),
    ...(sourceWarnings.length > 0 ? { messages: sourceWarnings } : {}),
  };
}
