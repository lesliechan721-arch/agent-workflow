import crypto from 'node:crypto';

import type { CatalogSource, PlatformName, Scope } from '../types.js';
import type { CatalogSourceUpdate } from '../utils/catalog-sources.js';
import type {
  StatusV4Payload,
  StatusV4PluginSummary,
} from '../commands/status-v4.js';
import type { ProjectConfigStoreLayer } from '../utils/plugin-config.js';
import type {
  RebuildProgressFeed,
  RebuildProgressSnapshot,
} from '../output/rebuild-progress.js';
import {
  type ConfigPageViewModel,
  type ConfigGroupViewModel,
  buildTuiViewModel,
  type PluginListItemViewModel,
  type SourceHealthViewModel,
  type SourceDetailViewModel,
  type TuiViewModel,
  type UserIssueCategory,
  type UserIssueViewModel,
} from './model.js';
import {
  TuiRouter,
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
}

export type OperationIntent =
  | {
      kind: 'pluginWrite';
      action: PluginWriteOperation;
      pluginId: string;
      platform: PlatformName | 'both';
      scope: Scope;
      originIssue?: IssueOrigin;
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
}

export interface OperationReviewChange {
  kind: 'add' | 'change' | 'remove' | 'keep' | 'warning';
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
  primaryLabel: string;
  destructive?: boolean;
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
    }
  | {
      state: 'partial';
      operationId: string;
      summary: OperationResultSummary;
      operationKind: OperationKind;
      sourceAction?: Extract<OperationIntent, { kind: 'sourceMutation' }>['action'];
      pluginId?: string;
      originIssue?: IssueOrigin;
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
    };

export interface OperationResultSummary {
  code: 'operationSucceeded' | 'operationPartial';
  message: string;
  pluginId?: string;
  action?: PluginWriteOperation;
  targets?: Array<{
    platform: PlatformName;
    scope: Scope;
    state: 'completed' | 'failed';
  }>;
}

export interface TuiStatusLoadResult {
  payload: StatusV4Payload;
  pluginSummaries: StatusV4PluginSummary[];
  sourceDetails?: SourceDetailViewModel[];
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
  checkSource: (sourceId: string, signal: AbortSignal) => Promise<void>;
  inspectSourceRemoval?: (sourceId: string, signal: AbortSignal) => Promise<SourceReferenceSummaryViewModel>;
  captureEvidence: (intent: OperationIntent, signal?: AbortSignal) => Promise<OperationEvidence>;
  validateIntent?: (intent: OperationIntent, signal: AbortSignal) => Promise<void>;
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

export interface TuiControllerSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'disposed';
  router: TuiRouterSnapshot;
  viewModel?: TuiViewModel;
  sourceHealth: SourceHealthViewModel[];
  progress: RebuildProgressSnapshot;
  activeReview?: OperationReviewModel;
  result?: OperationExecuteResult;
  loadError?: { code: string; message: string };
}

interface ReviewTicket {
  intent: OperationIntent;
  evidence: OperationEvidence;
  review: OperationReviewModel;
  returnRoute: TuiRoute;
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
  'category' | 'pluginId' | 'sourceId' | 'platform' | 'scope'>): string {
  return [issue.category, issue.pluginId ?? '', issue.sourceId ?? '', issue.platform ?? '', issue.scope ?? '']
    .join('\0');
}

function operationLabels(intent: OperationIntent): {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: boolean;
} {
  if (intent.kind === 'pluginWrite') {
    if (intent.originIssue) {
      return {
        title: '处理问题',
        description: '只执行所选问题处理动作；插件设置保持不变。',
        primaryLabel: '开始处理',
        destructive: intent.action !== 'reinstall',
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
      add: ['添加来源', '验证来源后保存到来源列表。', '验证并添加', false],
      update: ['修改来源', '验证修改后保存到来源列表。', '验证并保存', false],
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

function reviewChanges(intent: OperationIntent): OperationReviewChange[] {
  if (intent.kind === 'pluginWrite') {
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
  if (evidence.config) details.push(`设置层：${evidence.config.scope}/${evidence.config.projectLayer} · ${evidence.config.storeDigest}`);
  if (evidence.sourceWrite) {
    details.push(`候选配置：${evidence.sourceWrite.candidateDigest}`);
    details.push(`引用清单：${evidence.sourceWrite.inventoryDigest} · ${evidence.sourceWrite.referenceCount} 项`);
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

export class TuiController {
  readonly #router = new TuiRouter();
  readonly #listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();
  readonly #health = new Map<string, SourceHealthViewModel>();
  readonly #sourceTokens = new Map<string, number>();
  readonly #sourceAborts = new Map<string, AbortController>();
  readonly #tickets = new Map<string, ReviewTicket>();
  readonly #abort = new AbortController();
  readonly #progressUnsubscribe?: () => void;
  readonly #progressFeed?: RebuildProgressFeed;
  #phase: TuiControllerSnapshot['phase'] = 'idle';
  #status?: TuiStatusLoadResult;
  #viewModel?: TuiViewModel;
  #progress: RebuildProgressSnapshot = { messages: [] };
  #activeReview?: OperationReviewModel;
  #result?: OperationExecuteResult;
  #loadError?: { code: string; message: string };
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
        this.#progress = structuredClone(progress);
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
      ...(this.#activeReview ? { activeReview: this.#activeReview } : {}),
      ...(this.#result ? { result: this.#result } : {}),
      ...(this.#loadError ? { loadError: this.#loadError } : {}),
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
      sourceHealth: this.#health,
      sourceDetails: this.#status.sourceDetails,
    });
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
    }
    this.#project();
  }

  #cancelSourceRefreshes(): void {
    for (const abort of this.#sourceAborts.values()) abort.abort();
    this.#sourceAborts.clear();
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
    for (const source of status.payload.catalog.sources) {
      if (source.type === 'git') void this.refreshSource(source.id).catch(() => undefined);
    }
  }

  async refreshSource(sourceId: string): Promise<void> {
    if (this.#disposed || !this.#status) return;
    this.#sourceAborts.get(sourceId)?.abort();
    const sourceAbort = new AbortController();
    this.#sourceAborts.set(sourceId, sourceAbort);
    const signal = AbortSignal.any([this.#abort.signal, sourceAbort.signal]);
    const token = (this.#sourceTokens.get(sourceId) ?? 0) + 1;
    this.#sourceTokens.set(sourceId, token);
    const generation = this.#generation;
    const refreshSequence = ++this.#refreshSequence;
    const current = this.#status.payload.catalog.sources.find((source) => source.id === sourceId);
    const hadCache = current !== undefined && current.error === undefined && current.freshness !== undefined;
    this.#health.set(sourceId, { sourceId, state: 'checking' });
    this.#project();
    this.#publish();
    try {
      await this.dependencies.checkSource(sourceId, signal);
      const status = await this.dependencies.loadStatus(signal);
      if (this.#disposed
        || generation !== this.#generation
        || token !== this.#sourceTokens.get(sourceId)) return;
      if (refreshSequence < this.#appliedRefreshSequence) return;
      this.#appliedRefreshSequence = refreshSequence;
      this.#applyStatus(status);
      const refreshed = status.payload.catalog.sources.find((source) => source.id === sourceId);
      const state = !refreshed
        ? 'unavailable'
        : refreshed.error
          ? hadCache ? 'degraded' : 'unavailable'
          : refreshed.type === 'path' || refreshed.freshness === 'path'
            ? 'path'
            : refreshed.freshness === 'remote'
              ? 'ready'
              : refreshed.freshness === 'cache'
                ? 'degraded'
                : 'unavailable';
      this.#health.set(sourceId, {
        sourceId,
        state,
        ...(state === 'degraded' || state === 'unavailable' ? {
          issueId: `source:${sourceId}:${state === 'degraded' ? 'cache' : 'unavailable'}`,
          message: state === 'degraded'
            ? '远端检查后仍只能使用缓存数据。'
            : '来源检查后没有可用数据。',
        } : {}),
      });
    } catch (error) {
      if (this.#disposed || signal.aborted || generation !== this.#generation
        || token !== this.#sourceTokens.get(sourceId)) return;
      await this.#logErrorSafe(error, 'catalogSourceRefreshFailed', {
        privateConfigOperation: true,
      });
      const state = hadCache ? 'degraded' : 'unavailable';
      this.#health.set(sourceId, {
        sourceId,
        state,
        issueId: `source:${sourceId}:${state === 'degraded' ? 'cache' : 'unavailable'}`,
        message: state === 'degraded'
          ? '远端检查失败。当前仍使用已验证的缓存数据。'
          : '远端检查失败，并且没有可用缓存数据。',
      });
    } finally {
      if (this.#sourceAborts.get(sourceId) === sourceAbort) this.#sourceAborts.delete(sourceId);
    }
    if (generation !== this.#generation) return;
    this.#project();
    this.#publish();
  }

  push(route: TuiRoute, context?: TuiPageContext): void {
    this.#router.push(route, context);
    this.#publish();
  }

  replace(route: TuiRoute, context?: TuiPageContext): void {
    this.#router.replace(route, context);
    this.#publish();
  }

  updatePageContext(context: Partial<TuiPageContext>): void {
    this.#router.updateContext(context);
    this.#publish();
  }

  back(): void {
    const route = this.#router.snapshot.current.route;
    if (route.name === 'review' && this.#activeReview?.operationId === route.operationId) {
      this.#tickets.delete(this.#activeReview.reviewToken);
      this.#activeReview = undefined;
    }
    this.#router.back();
    this.#publish();
  }

  returnFromResult(): void {
    const route = this.#result?.state === 'blocked' ? this.#result.returnRoute : undefined;
    if (route) this.#router.replace(route);
    else this.#router.back();
    this.#result = undefined;
    this.#publish();
  }

  listPlugins(options: {
    mode: 'browse' | 'installed';
    sourceId?: string;
    query?: string;
  }): PluginListItemViewModel[] {
    const query = options.query?.trim().toLocaleLowerCase('en');
    return cloneFrozen((this.#viewModel?.plugins ?? []).filter((plugin) =>
      (!options.sourceId || plugin.sourceId === options.sourceId)
      && (options.mode === 'browse' || plugin.aggregateStatus === 'installed' || plugin.aggregateStatus === 'needsAttention')
      && (!query || `${plugin.displayName}\n${plugin.description}\n${plugin.sourceId}`.toLocaleLowerCase('en').includes(query))));
  }

  getPluginOverview(pluginId: string): PluginListItemViewModel | undefined {
    const plugin = this.#viewModel?.plugins.find((entry) => entry.pluginId === pluginId);
    return plugin ? cloneFrozen(plugin) : undefined;
  }

  getPlatformPlacement(pluginId: string, platform: PlatformName): PluginListItemViewModel['installedPlacements'][number] | undefined {
    return this.getPluginOverview(pluginId)?.installedPlacements.find((placement) =>
      placement.platform === platform);
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

  listUserIssues(): UserIssueViewModel[] {
    return cloneFrozen(this.#viewModel?.issues ?? []);
  }

  async buildOperationReview(intent: OperationIntent): Promise<OperationReviewModel> {
    try {
      this.#assertIssueOrigin(intent);
      await this.dependencies.validateIntent?.(structuredClone(intent), this.#abort.signal);
      const evidence = await this.dependencies.captureEvidence(structuredClone(intent), this.#abort.signal);
      return this.#storeOperationReview(intent, evidence);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, intent);
      throw new TuiOperationBlockedError(code, '操作未建立。请检查当前设置后重试。');
    }
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
      changes: reviewChanges(intent),
      technicalDetails: technicalDetails(evidence),
      primaryLabel: labels.primaryLabel,
      ...(labels.destructive ? { destructive: true } : {}),
    };
    this.#tickets.set(reviewToken, {
      intent: structuredClone(intent),
      evidence: structuredClone(evidence),
      review: structuredClone(review),
      returnRoute: structuredClone(returnRoute),
    });
    this.#activeReview = structuredClone(review);
    this.#result = undefined;
    this.#router[navigation]({ name: 'review', operationId });
    this.#publish();
    return cloneFrozen(review);
  }

  async executeOperation(reviewToken: string): Promise<OperationExecuteResult> {
    const ticket = this.#tickets.get(reviewToken);
    const operationId = ticket?.review.operationId ?? 'unknown';
    if (!ticket) {
      return this.#setBlocked(operationId, 'reviewTicketInvalid');
    }
    this.#tickets.delete(reviewToken);
    if ((this.dependencies.now?.() ?? Date.now()) > ticket.review.expiresAt) {
      return this.#setBlocked(operationId, 'reviewTicketExpired', { intent: ticket.intent, returnRoute: ticket.returnRoute });
    }
    try {
      this.#assertIssueOrigin(ticket.intent);
      await this.dependencies.validateIntent?.(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      return this.#setBlocked(operationId, code, {
        intent: ticket.intent,
        navigation: 'back',
        returnRoute: ticket.returnRoute,
      });
    }
    let current: OperationEvidence;
    try {
      current = await this.dependencies.captureEvidence(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      return this.#setBlocked(operationId, code, { intent: ticket.intent, returnRoute: ticket.returnRoute });
    }
    if (operationEvidenceFingerprint(current) !== operationEvidenceFingerprint(ticket.evidence)) {
      return this.#rebuildStaleReview(ticket, operationId, current);
    }
    if (ticket.intent.kind === 'sourceMutation') {
      this.#cancelSourceRefreshes();
      this.#generation += 1;
    }
    this.#progressFeed?.clearCurrent?.();
    this.#progress.current = undefined;
    this.#router.replace({ name: 'progress', operationId });
    this.#publish();
    try {
      const execution = await this.dependencies.executeIntent(
        structuredClone(ticket.intent),
        structuredClone(ticket.evidence),
      );
      this.#cancelSourceRefreshes();
      this.#generation += 1;
      try {
        const refreshed = await this.dependencies.loadStatus(this.#abort.signal);
        this.#applyStatus(refreshed);
      } catch (error) {
        const verificationCode = ticket.intent.kind === 'pluginWrite' && ticket.intent.originIssue
          ? 'issueVerificationFailed'
          : 'tuiStateReloadFailed';
        await this.#logErrorSafe(error, verificationCode, {
          privateConfigOperation: true,
        });
        return this.#setBlocked(operationId, verificationCode, {
          intent: ticket.intent,
          navigation: 'result',
          returnRoute: ticket.returnRoute,
          writeMayHaveCompleted: true,
          verification: ticket.intent.kind === 'pluginWrite' && ticket.intent.originIssue
            ? 'verificationFailed' : undefined,
        });
      }
      const originIssue = ticket.intent.kind === 'pluginWrite' ? ticket.intent.originIssue : undefined;
      if (originIssue
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
        if (configWrite === 'rolledBack') {
          return this.#setBlocked(operationId, 'configWriteRolledBack', {
            intent: ticket.intent,
            navigation: 'back',
          });
        }
        if (configWrite === 'rollbackFailed') {
          return this.#setBlocked(operationId, 'configWriteRollbackFailed', {
            intent: ticket.intent,
            navigation: 'result',
          });
        }
        if (configWrite !== 'succeeded') {
          return this.#setBlocked(operationId, 'configWriteUnconfirmed', {
            intent: ticket.intent,
            navigation: 'back',
          });
        }
      }
      const summary = operationResultSummary(ticket.intent, execution);
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
      };
      this.#result = result;
      this.#activeReview = undefined;
      this.#router.push({ name: 'result', operationId });
      this.#publish();
      return cloneFrozen(result);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      if (code === 'operationReviewStale') {
        return this.#rebuildStaleReview(ticket, operationId);
      }
      return this.#setBlocked(operationId, code, ticket.intent.kind === 'sourceMutation'
        ? { intent: ticket.intent, navigation: 'result', returnRoute: ticket.returnRoute }
        : { intent: ticket.intent, returnRoute: ticket.returnRoute });
    }
  }

  async #rebuildStaleReview(
    ticket: ReviewTicket,
    operationId: string,
    currentEvidence?: OperationEvidence,
  ): Promise<OperationExecuteResult> {
    try {
      this.#assertIssueOrigin(ticket.intent);
      await this.dependencies.validateIntent?.(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      const code = issueCode(error);
      await this.#logOperationError(error, code, ticket.intent);
      const result: OperationExecuteResult = {
        state: 'blocked',
        operationId,
        code,
        message: '状态已变化，原操作不再安全。请修改选择后重试。',
        ...this.#operationIdentity(ticket.intent),
        returnRoute: structuredClone(ticket.returnRoute),
      };
      this.#result = structuredClone(result);
      this.#activeReview = undefined;
      this.#router.back();
      this.#publish();
      return cloneFrozen(result);
    }
    let evidence = currentEvidence;
    if (!evidence) {
      try {
        evidence = await this.dependencies.captureEvidence(
          structuredClone(ticket.intent),
          this.#abort.signal,
        );
      } catch (error) {
        const code = issueCode(error);
        await this.#logOperationError(error, code, ticket.intent);
        return this.#setBlocked(operationId, code, { intent: ticket.intent, returnRoute: ticket.returnRoute });
      }
    }
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
    },
  ): OperationExecuteResult {
    const message = code === 'configWriteRolledBack'
      ? '设置未保存。原设置已安全恢复，请检查草稿后重试。'
      : code === 'configWriteRollbackFailed'
        ? '设置未确认保存，且恢复未完整完成。请停止修改并检查问题。'
        : code === 'issueVerificationFailed'
          ? '写入可能已完成，但当前无法确认原问题是否消失。请重新检查状态。'
          : code === 'issueStillPresent'
            ? '写入已完成，但重新检查后原问题仍然存在。'
            : '操作未完成。请重新检查后重试。';
    const result: OperationExecuteResult = {
      state: 'blocked',
      operationId,
      code,
      message,
      ...(options?.intent ? this.#operationIdentity(options.intent) : {}),
      ...(options?.returnRoute ? { returnRoute: structuredClone(options.returnRoute) } : {}),
      ...(options?.writeMayHaveCompleted ? { writeMayHaveCompleted: true } : {}),
      ...(options?.verification ? { verification: options.verification } : {}),
    };
    this.#result = structuredClone(result);
    this.#activeReview = undefined;
    if (options?.navigation === 'back') this.#router.back();
    else this.#router.push({ name: 'result', operationId });
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
      || issue.pluginId !== intent.pluginId
      || issue.platform !== intent.platform
      || issue.sourceId !== sourceIdFromPluginId(intent.pluginId)) {
      throw new TuiOperationBlockedError('issueOriginInvalid', '原问题与当前状态不匹配。');
    }
    const expected = issue.category === 'incompleteInstallation'
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
    if (!expected || intent.action !== expected.action || intent.scope !== expected.scope) {
      throw new TuiOperationBlockedError('issueOriginInvalid', '问题动作与当前目标不匹配。');
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    this.#cancelSourceRefreshes();
    this.#progressUnsubscribe?.();
    this.#tickets.clear();
    this.#phase = 'disposed';
    this.#listeners.clear();
  }
}

function operationResultSummary(intent: OperationIntent, execution: unknown): OperationResultSummary {
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
    const state = entry.state;
    if ((platform !== 'codex' && platform !== 'claude')
      || (scope !== 'user' && scope !== 'project')
      || (state !== 'completed' && state !== 'failed')) return [];
    return [{
      platform: platform as PlatformName,
      scope: scope as Scope,
      state: state as 'completed' | 'failed',
    }];
  });
  const inferredTargets = intent.kind === 'pluginWrite' && targets.length === 0
    ? (intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform]).map((platform) => ({
        platform,
        scope: intent.scope,
        state: 'completed' as const,
      }))
    : targets;
  const partial = inferredTargets.some((target) => target.state === 'failed')
    && inferredTargets.some((target) => target.state === 'completed');
  return {
    code: partial ? 'operationPartial' : 'operationSucceeded',
    message: partial ? '操作只完成了一部分。' : '操作已完成。',
    ...(intent.kind === 'pluginWrite' ? {
      pluginId: intent.pluginId,
      action: intent.action,
    } : {}),
    ...(inferredTargets.length > 0 ? { targets: inferredTargets } : {}),
  };
}
