import crypto from 'node:crypto';

import type { PlatformName, Scope } from '../types.js';
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
  type ConfigGroupViewModel,
  buildTuiViewModel,
  type PluginListItemViewModel,
  type SourceHealthViewModel,
  type TuiViewModel,
  type UserIssueViewModel,
} from './model.js';
import {
  TuiRouter,
  type TuiPageContext,
  type TuiRoute,
  type TuiRouterSnapshot,
} from './router.js';

export type PluginWriteOperation = 'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup';

export type OperationIntent =
  | {
      kind: 'pluginWrite';
      action: PluginWriteOperation;
      pluginId: string;
      platform: PlatformName;
      scope: Scope;
    }
  | {
      kind: 'configSave';
      pluginId: string;
      scope: Scope;
      projectLayer: ProjectConfigStoreLayer;
      updates?: Record<string, unknown>;
      removeKeys?: string[];
      sensitiveKeys?: string[];
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
    }
  | {
      kind: 'issueResolution';
      issueId: string;
      actionId: string;
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
      summary: { code: 'operationSucceeded'; message: string };
    }
  | { state: 'stale'; operationId: string; review: OperationReviewModel }
  | { state: 'blocked'; operationId: string; code: string; message: string };

export interface TuiStatusLoadResult {
  payload: StatusV4Payload;
  pluginSummaries: StatusV4PluginSummary[];
}

export interface TuiControllerDependencies {
  loadStatus: (signal: AbortSignal) => Promise<TuiStatusLoadResult>;
  checkSource: (sourceId: string, signal: AbortSignal) => Promise<void>;
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
  logError?: (error: unknown, code: string) => void | Promise<void>;
  now?: () => number;
  createToken?: () => string;
  reviewTtlMs?: number;
}

export interface TuiControllerSnapshot {
  phase: 'idle' | 'loading' | 'ready' | 'disposed';
  router: TuiRouterSnapshot;
  viewModel?: TuiViewModel;
  sourceHealth: SourceHealthViewModel[];
  progress: RebuildProgressSnapshot;
  activeReview?: OperationReviewModel;
  result?: OperationExecuteResult;
}

interface ReviewTicket {
  intent: OperationIntent;
  evidence: OperationEvidence;
  review: OperationReviewModel;
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

function operationLabels(intent: OperationIntent): {
  title: string;
  description: string;
  primaryLabel: string;
  destructive: boolean;
} {
  if (intent.kind === 'pluginWrite') {
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
  throw new TuiOperationBlockedError(
    'operationNotImplemented',
    intent.kind === 'sourceMutation' ? '来源写操作将在来源管理阶段接入。' : '问题修复操作尚未接入。',
  );
}

function reviewChanges(intent: OperationIntent): OperationReviewChange[] {
  if (intent.kind === 'pluginWrite') {
    const location = `${intent.platform === 'codex' ? 'Codex' : 'Claude Code'} · ${intent.scope === 'user' ? '所有项目' : '当前项目'}`;
    return [{
      kind: intent.action === 'uninstall' || intent.action === 'cleanup' ? 'remove' : intent.action === 'install' ? 'add' : 'change',
      title: location,
      description: intent.action === 'uninstall' || intent.action === 'cleanup'
        ? '插件设置不会删除。'
        : '执行前会再次检查当前安装状态。',
    }];
  }
  if (intent.kind === 'configReset') {
    return [{ kind: 'remove', title: '删除此层的已存值', description: '有效值将恢复为继承值或默认值。' }];
  }
  if (intent.kind !== 'configSave') {
    throw new TuiOperationBlockedError('operationNotImplemented', '这个写操作尚未接入新 Controller。');
  }
  const sensitive = new Set(intent.sensitiveKeys ?? []);
  const updateKeys = Object.keys(intent.updates ?? {});
  return [
    ...updateKeys.map((key): OperationReviewChange => ({
      kind: 'change',
      title: key,
      description: sensitive.has(key) ? '已设置 → 将更新' : '将更新',
    })),
    ...(intent.removeKeys ?? []).map((key): OperationReviewChange => ({
      kind: 'remove',
      title: key,
      description: sensitive.has(key) ? '已设置 → 未设置' : '恢复继承',
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
  return details;
}

function issueCode(error: unknown): string {
  if (error instanceof TuiOperationBlockedError) return error.code;
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
  #phase: TuiControllerSnapshot['phase'] = 'idle';
  #status?: TuiStatusLoadResult;
  #viewModel?: TuiViewModel;
  #progress: RebuildProgressSnapshot = { messages: [] };
  #activeReview?: OperationReviewModel;
  #result?: OperationExecuteResult;
  #loadGeneration = 0;
  #disposed = false;

  constructor(
    readonly dependencies: TuiControllerDependencies,
    progressFeed?: RebuildProgressFeed,
  ) {
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

  #project(): void {
    if (!this.#status) return;
    this.#viewModel = buildTuiViewModel({
      status: this.#status.payload,
      pluginSummaries: this.#status.pluginSummaries,
      sourceHealth: this.#health,
    });
  }

  async load(): Promise<void> {
    const generation = ++this.#loadGeneration;
    this.#phase = 'loading';
    this.#publish();
    const status = await this.dependencies.loadStatus(this.#abort.signal);
    if (this.#disposed || generation !== this.#loadGeneration) return;
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
    this.#phase = 'ready';
    this.#project();
    this.#publish();
    for (const source of status.payload.catalog.sources) {
      if (source.type === 'git') void this.refreshSource(source.id);
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
    const current = this.#status.payload.catalog.sources.find((source) => source.id === sourceId);
    const hadCache = current !== undefined && current.error === undefined && current.freshness !== undefined;
    this.#health.set(sourceId, { sourceId, state: 'checking' });
    this.#project();
    this.#publish();
    try {
      await this.dependencies.checkSource(sourceId, signal);
      const status = await this.dependencies.loadStatus(signal);
      if (this.#disposed
        || token !== this.#sourceTokens.get(sourceId)) return;
      this.#status = structuredClone(status);
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
      if (this.#disposed || signal.aborted || token !== this.#sourceTokens.get(sourceId)) return;
      await this.dependencies.logError?.(error, 'catalogSourceRefreshFailed');
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
    this.#project();
    this.#publish();
  }

  push(route: TuiRoute, context?: TuiPageContext): void {
    this.#router.push(route, context);
    this.#publish();
  }

  updatePageContext(context: Partial<TuiPageContext>): void {
    this.#router.updateContext(context);
    this.#publish();
  }

  back(): void {
    this.#router.back();
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
    health?: SourceHealthViewModel;
  } {
    return cloneFrozen({
      source: this.#viewModel?.sourceTabs.find((source) => source.id === sourceId),
      health: this.#health.get(sourceId),
    });
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

  listUserIssues(): UserIssueViewModel[] {
    return cloneFrozen(this.#viewModel?.issues ?? []);
  }

  async buildOperationReview(intent: OperationIntent): Promise<OperationReviewModel> {
    await this.dependencies.validateIntent?.(structuredClone(intent), this.#abort.signal);
    const evidence = await this.dependencies.captureEvidence(structuredClone(intent), this.#abort.signal);
    return this.#storeOperationReview(intent, evidence);
  }

  #storeOperationReview(intent: OperationIntent, evidence: OperationEvidence): OperationReviewModel {
    const labels = operationLabels(intent);
    const operationId = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const reviewToken = this.dependencies.createToken?.() ?? crypto.randomUUID();
    const expiresAt = (this.dependencies.now?.() ?? Date.now())
      + (this.dependencies.reviewTtlMs ?? 2 * 60_000);
    const pluginId = 'pluginId' in intent ? intent.pluginId : 'sourceId' in intent ? intent.sourceId : intent.issueId;
    if ('pluginId' in intent) sourceIdFromPluginId(intent.pluginId);
    const review: OperationReviewModel = {
      operationId,
      reviewToken,
      expiresAt,
      title: labels.title,
      description: labels.description,
      subject: {
        name: 'pluginId' in intent ? pluginNameFromId(intent.pluginId) : pluginId,
        ...('pluginId' in intent ? { sourceLabel: sourceIdFromPluginId(intent.pluginId) } : {}),
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
    });
    this.#activeReview = structuredClone(review);
    this.#result = undefined;
    this.#router.push({ name: 'review', operationId });
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
      return this.#setBlocked(operationId, 'reviewTicketExpired');
    }
    let current: OperationEvidence;
    try {
      current = await this.dependencies.captureEvidence(structuredClone(ticket.intent), this.#abort.signal);
    } catch (error) {
      const code = issueCode(error);
      await this.dependencies.logError?.(error, code);
      return this.#setBlocked(operationId, code);
    }
    if (operationEvidenceFingerprint(current) !== operationEvidenceFingerprint(ticket.evidence)) {
      const review = this.#storeOperationReview(ticket.intent, current);
      const result: OperationExecuteResult = { state: 'stale', operationId, review };
      this.#result = result;
      this.#publish();
      return cloneFrozen(result);
    }
    this.#router.push({ name: 'progress', operationId });
    this.#publish();
    try {
      await this.dependencies.executeIntent(
        structuredClone(ticket.intent),
        structuredClone(ticket.evidence),
      );
      const result: OperationExecuteResult = {
        state: 'succeeded',
        operationId,
        summary: { code: 'operationSucceeded', message: '操作已完成。' },
      };
      this.#result = result;
      this.#activeReview = undefined;
      this.#router.push({ name: 'result', operationId });
      this.#publish();
      return cloneFrozen(result);
    } catch (error) {
      const code = issueCode(error);
      await this.dependencies.logError?.(error, code);
      if (code === 'operationReviewStale') {
        let evidence: OperationEvidence;
        try {
          evidence = await this.dependencies.captureEvidence(
            structuredClone(ticket.intent),
            this.#abort.signal,
          );
        } catch (captureError) {
          const captureCode = issueCode(captureError);
          await this.dependencies.logError?.(captureError, captureCode);
          return this.#setBlocked(operationId, captureCode);
        }
        const review = this.#storeOperationReview(ticket.intent, evidence);
        const result: OperationExecuteResult = { state: 'stale', operationId, review };
        this.#result = result;
        this.#publish();
        return cloneFrozen(result);
      }
      return this.#setBlocked(operationId, code);
    }
  }

  #setBlocked(operationId: string, code: string): OperationExecuteResult {
    const message = '操作未完成。请重新检查后重试。';
    const result: OperationExecuteResult = { state: 'blocked', operationId, code, message };
    this.#result = structuredClone(result);
    this.#activeReview = undefined;
    this.#router.push({ name: 'result', operationId });
    this.#publish();
    return cloneFrozen(result);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#abort.abort();
    for (const abort of this.#sourceAborts.values()) abort.abort();
    this.#sourceAborts.clear();
    this.#progressUnsubscribe?.();
    this.#tickets.clear();
    this.#phase = 'disposed';
    this.#listeners.clear();
  }
}
