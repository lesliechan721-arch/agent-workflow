import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CatalogStoreInspectionEntry,
  CatalogStorePruneItemKey,
  CatalogStorePruneResult,
  CatalogStoreStatusResult,
} from '../../src/commands/catalog-store.js';
import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import { OperationHistoryStore } from '../../src/tui/operation-history.js';
import type { CatalogStoreTaskEvidence } from '../../src/tui/catalog-store-task.js';

afterEach(() => cleanup());

const SIZES = [
  { columns: 80, rows: 24 },
  { columns: 60, rows: 18 },
] as const;

const CATALOG_EVIDENCE: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' },
};

function loadResult(): TuiStatusLoadResult {
  const pluginSummaries: StatusV8PluginSummary[] = [{
    pluginName: 'demo',
    pluginId: 'official/demo',
    displayName: 'Demo',
    description: 'Fixture plugin',
    version: '1.0.0',
    supportedTargets: { codex: ['user'], claude: [] },
    configFieldCount: 0,
  }];
  const payload: StatusV8Payload = {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:catalog',
      sources: [
        {
          id: 'official', identity: 'identity:official', type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active',
        },
        {
          id: 'broken', identity: 'identity:broken', type: 'path', primary: false,
          requestedRef: 'path', error: 'source unavailable', errorCode: 'catalogSourceUnavailable',
        },
      ],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: [],
    errors: [],
  };
  return {
    payload,
    pluginSummaries,
    configuredSources: [
      { id: 'official', type: 'path', primary: true, path: '/catalog/official', autoCheck: false },
      { id: 'broken', type: 'path', primary: false, path: '/catalog/broken', autoCheck: false },
    ],
    catalogGenerations: [{
      sourceId: 'official',
      sourceType: 'path',
      active: {
        catalogVersion: '1.0.0', channel: 'latest', requestedRef: 'path',
        resolvedCommit: 'path', storeKey: 'official-active', digestShort: 'official',
      },
      syncInstruction: 'aw catalog source sync official',
    }],
    sourceDetails: payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      autoCheck: false,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: pluginSummaries.filter((plugin) => plugin.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      ...(source.freshness ? { freshness: source.freshness } : {}),
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      configDigest: 'sha256:config',
    })),
  };
}

function longSourceLoadResult(): TuiStatusLoadResult {
  const data = loadResult();
  const sources = Array.from({ length: 10 }, (_, index) => {
    const id = `source-${String(index + 1).padStart(2, '0')}`;
    return {
      id,
      identity: `identity:${id}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'active' as const,
    };
  });
  data.payload.catalog.sources = sources;
  data.configuredSources = sources.map((source) => ({
    id: source.id,
    type: 'path' as const,
    primary: source.primary,
    path: `/catalog/${source.id}`,
    autoCheck: false,
  }));
  data.catalogGenerations = sources.map((source) => ({
    sourceId: source.id,
    sourceType: 'path' as const,
    active: {
      catalogVersion: '1.0.0',
      channel: 'latest',
      requestedRef: 'path',
      resolvedCommit: 'path',
      storeKey: `${source.id}-active`,
      digestShort: source.id,
    },
    syncInstruction: `aw catalog source sync ${source.id}`,
  }));
  data.sourceDetails = sources.map((source) => ({
    id: source.id,
    type: source.type,
    primary: source.primary,
    autoCheck: false,
    locationSummary: `已选择本地目录（${source.id}）`,
    pluginCount: 0,
    sourceIdentity: source.identity,
    requestedRef: source.requestedRef,
    freshness: source.freshness,
    configDigest: 'sha256:config',
  }));
  return data;
}

function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
  return new TuiController({
    loadStatus: vi.fn().mockResolvedValue(loadResult()),
    captureEvidence: vi.fn(async () => CATALOG_EVIDENCE),
    executeIntent: vi.fn().mockResolvedValue({ overallState: 'succeeded', targetResults: [] }),
    now: () => 1_000,
    reviewTtlMs: 10_000,
    ...overrides,
  });
}

function frame(instance: ReturnType<typeof render>, size: { columns: number; rows: number }): string {
  const value = instance.lastFrame() ?? '';
  const lines = value.split('\n');
  expect(lines.length).toBeLessThanOrEqual(size.rows);
  expect(Math.max(...lines.map(stringWidth))).toBeLessThanOrEqual(size.columns);
  expect(value).not.toMatch(/\u001B\[[0-9;]*m/u);
  return value;
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function focusAction(
  instance: ReturnType<typeof render>,
  label: string,
  limit = 24,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const current = instance.lastFrame() ?? '';
    if (current.includes(`› ${label}`) || current.includes(`› [${label}]`)) return;
    await input(instance, '\u001B[B');
  }
  throw new Error(`Action was not reachable: ${label}\n${instance.lastFrame() ?? ''}`);
}

async function waitForRoute(value: TuiController, route: string): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    if (value.snapshot.router.current.route.name === route) return;
    await nextTurn(2);
  }
  throw new Error(`Route did not become ${route}: ${value.snapshot.router.current.route.name}`);
}

async function confirmReview(instance: ReturnType<typeof render>, value: TuiController): Promise<void> {
  if (value.snapshot.activeReview?.requiresConfirmation) {
    await input(instance, '\r', '\u001B[B', '\r');
    return;
  }
  await input(instance, '\r');
}

function catalogStoreEntry(options: {
  storeKey: string;
  category?: CatalogStoreInspectionEntry['category'];
  status: CatalogStoreInspectionEntry['status'];
  generationReference: CatalogStoreInspectionEntry['generationReference'];
  reclaimableBytes: number | null;
  reason: string;
}): CatalogStoreInspectionEntry {
  return {
    storeKey: options.storeKey,
    category: options.category ?? 'entry',
    status: options.status,
    generationReference: options.generationReference,
    ageMs: 31 * 24 * 60 * 60 * 1_000,
    reclaimableBytes: options.reclaimableBytes,
    reason: options.reason,
  };
}

function catalogStoreStatus(entries: CatalogStoreInspectionEntry[]): CatalogStoreStatusResult {
  const reclaimable = entries.filter((entry) => entry.status === 'reclaimable');
  return {
    catalogStoreSchemaVersion: 2,
    command: 'catalog:store:status',
    ok: true,
    entries,
    totals: {
      entries: entries.length,
      reclaimableEntries: reclaimable.length,
      reclaimableBytes: reclaimable.reduce((total, entry) => total + (entry.reclaimableBytes ?? 0), 0),
    },
    errors: [],
  };
}

function catalogStoreResult(options: {
  overallState: 'succeeded' | 'partial';
  entries: CatalogStoreInspectionEntry[];
  deleted: Array<{ storeKey: string; bytes: number }>;
  retained: Array<{ storeKey: string; reason: string }>;
}): CatalogStorePruneResult {
  return {
    catalogStoreSchemaVersion: 2,
    command: 'catalog:store:prune',
    ok: options.overallState === 'succeeded',
    overallState: options.overallState,
    dryRun: false,
    entries: options.entries,
    deleted: options.deleted,
    retained: options.retained,
    errors: options.overallState === 'partial' ? [{
      storeKey: 'entry-old', code: 'catalogStoreDeleteFailed', message: 'safe delete failed',
    }] : [],
    reclaimableBytes: options.entries.reduce((total, entry) => total + (entry.reclaimableBytes ?? 0), 0),
    deletedBytes: options.deleted.reduce((total, entry) => total + entry.bytes, 0),
  };
}

describe('TUI v8.2 stage 5', () => {
  it.each(SIZES)('reads complete source values through basic-key pagination at $columns x $rows', async (size) => {
    const data = loadResult();
    const prefix = 'shared-reference-'.repeat(7);
    data.sourceDetails![0]!.requestedRef = `${prefix}REF-END`;
    data.sourceDetails![0]!.resolvedCommit = `${prefix}COMMIT-END`;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'sourceTechnical', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);
    const pages: string[] = [];
    await input(instance, '\u001B[B');
    for (let index = 0; index < 16; index += 1) {
      pages.push(frame(instance, size));
      await input(instance, '\r');
    }
    const text = pages.join('\n');
    expect(text).toContain('REF-END');
    expect(text).toContain('COMMIT-END');
    expect(text).toContain('requested ref');
    expect(text).toContain('resolved commit');
    await input(instance, '\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(value.snapshot.router.current.route.name).toBe('home');
    instance.unmount();
  });

  it.each(SIZES)('keeps the last source visible and reaches bottom source actions at $columns x $rows', async (size) => {
    const inspectCatalogStore = vi.fn().mockResolvedValue(catalogStoreStatus([]));
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(longSourceLoadResult()),
      inspectCatalogStore,
      executeIntent,
    });
    const recheckAll = vi.spyOn(value, 'recheckAllCatalogSources').mockResolvedValue(undefined);
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    await input(instance, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(frame(instance, size)).toContain('› source-10');

    await input(instance, 'a', '\u001B[B');
    expect(frame(instance, size)).toContain('› 检查全部来源 [r]');
    await input(instance, '\r');
    expect(recheckAll).toHaveBeenCalledOnce();
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });

    await input(instance, '\u001B[B', '\r');
    await waitForRoute(value, 'catalogStoreOverview');
    await nextTurn(3);
    expect(frame(instance, size)).toContain('存储概览');
    expect(inspectCatalogStore).toHaveBeenCalledOnce();
    expect(executeIntent).not.toHaveBeenCalled();
    instance.unmount();
  });

  it.each(SIZES)('cycles a long plugin source list in place at $columns x $rows', async (size) => {
    const data = longSourceLoadResult();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' }, { query: 'Demo' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    const depth = value.snapshot.router.depth;
    await input(instance, ...Array.from({ length: 10 }, () => '\u001B[C'));
    const lastSource = frame(instance, size);
    expect(lastSource).toContain('source-10');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginList', mode: 'browse', sourceId: 'source-10',
    });
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.query).toBe('Demo');
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    expect(value.snapshot.router.depth).toBe(depth);
    expect(frame(instance, size)).toContain('Demo');
    instance.unmount();
  });

  it.each(SIZES)('cycles all plugin status filters in place at $columns x $rows', async (size) => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' }, { query: 'Demo' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    const depth = value.snapshot.router.depth;
    for (const [filter, label] of [
      ['installed', '已安装'], ['uninstalled', '未安装'],
      ['updateAvailable', '可更新'], ['attention', '需处理'], ['all', '全部'],
    ]) {
      await input(instance, 'f');
      expect(frame(instance, size)).toContain(label);
      expect(value.snapshot.router.current.context.installFilter).toBe(filter);
      expect(value.snapshot.router.current.context.query).toBe('Demo');
      expect(value.snapshot.router.depth).toBe(depth);
      expect(value.snapshot.router.current.route.name).toBe('pluginList');
    }
    instance.unmount();
  });

  it('keeps the final direct source-detail actions visible at 60 x 18', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'broken' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    for (const label of ['移除来源', '更多操作']) {
      await focusAction(instance, label);
      const current = frame(instance, { columns: 60, rows: 18 });
      expect(current).toContain(`› ${label}`);
    }
    instance.unmount();
  });

  it.each(SIZES)('shows an unknown plugin count for a failed source at $columns x $rows', async (size) => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    await input(instance, '\u001B[B');
    const current = frame(instance, size);
    expect(current).toContain('broken');
    expect(current).toContain('插件数未知');
    expect(current).not.toMatch(/broken[\s\S]{0,100}0 个插件/u);
    instance.unmount();
  });

  it.each(SIZES)('uses the same Controller actions for source checks and r at $columns x $rows', async (size) => {
    let resolveProbe!: (value: {
      sourceId: string;
      state: 'current';
      activeVersion: string;
      activeResolvedCommit: string;
    }) => void;
    const pendingProbe = new Promise<{
      sourceId: string;
      state: 'current';
      activeVersion: string;
      activeResolvedCommit: string;
    }>((resolve) => { resolveProbe = resolve; });
    const probe = vi.fn(() => pendingProbe);
    const value = controller({ probeCatalogFreshness: probe });
    await value.load();
    const recheck = vi.spyOn(value, 'recheckCatalogSource');
    const fullValidate = vi.spyOn(value, 'fullValidateCatalogSource');
    value.push({ name: 'sourceDetail', sourceId: 'official' });
    const detail = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    await focusAction(detail, '检查来源');
    await input(detail, '\r', 'r');
    expect(recheck).toHaveBeenCalledTimes(2);
    expect(recheck).toHaveBeenNthCalledWith(1, 'official');
    expect(recheck).toHaveBeenNthCalledWith(2, 'official');
    expect(probe).toHaveBeenCalledTimes(1);
    expect(fullValidate).not.toHaveBeenCalled();
    frame(detail, size);
    resolveProbe({ sourceId: 'official', state: 'current', activeVersion: '1.0.0', activeResolvedCommit: 'path' });
    await nextTurn(4);
    detail.unmount();

    const recheckAll = vi.spyOn(value, 'recheckAllCatalogSources').mockResolvedValue(undefined);
    value.replace({ name: 'sourceList' });
    const list = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);
    await focusAction(list, '检查全部来源');
    await input(list, '\r', 'r');
    expect(recheckAll).toHaveBeenCalledTimes(2);
    expect(recheckAll).toHaveBeenCalledWith();
    frame(list, size);
    list.unmount();
  });

  it.each(SIZES)('keeps diagnostic and report pages readable with p and n at $columns x $rows', async (size) => {
    const value = controller();
    const history = new OperationHistoryStore();
    const tailSentinel = 'SAFE-CJK-TAIL-SENTINEL';
    const privateToken = 'private-source-token';
    const detailLines = [
      ...Array.from({ length: 18 }, (_, index) => `detail-page-line-${String(index + 1).padStart(2, '0')}`),
      `\u001B[31m${'诊断信息'.repeat(90)} Authorization=${privateToken} /Users/private/catalog ${tailSentinel}\u001B[0m`,
    ];
    history.record({
      summary: {
        recordId: '1:stage5-pagination', epoch: 1, operationId: 'stage5-pagination', createdAtMs: 1,
        state: 'partial', code: 'operationPartial', message: 'A safe partial result.', diagnosticCount: 1,
        effects: {
          configCommit: 'notApplicable', awWrite: 'partial',
          preApplyExternalEffect: 'notApplicable', finalVerification: 'failed',
        },
      },
      diagnostics: [{
        id: '1:stage5-pagination:detail', code: 'catalogStoreDeleteFailed', stage: 'execute',
        safeMessage: 'One item needs attention.', causes: [], detailLines,
      }],
      targets: [],
    });
    value.attachOperationHistory(history, 1);
    await value.load();
    value.push({ name: 'operationDiagnostic', recordId: '1:stage5-pagination' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    const firstDiagnostic = frame(instance, size);
    expect(firstDiagnostic).toContain('p 上一页');
    expect(firstDiagnostic).toContain('n 下一页');
    await input(instance, 'p');
    expect(frame(instance, size)).toBe(firstDiagnostic);
    const diagnosticFrames = [firstDiagnostic];
    for (let index = 0; index < 40; index += 1) {
      await input(instance, 'n');
      diagnosticFrames.push(frame(instance, size));
    }
    const diagnosticText = diagnosticFrames.join('\n');
    for (const line of detailLines.slice(0, -1)) expect(diagnosticText).toContain(line);
    expect(diagnosticText.replace(/[\s│]/gu, '')).toContain(tailSentinel);
    expect(diagnosticText).not.toContain(privateToken);
    expect(diagnosticText).not.toContain('/Users/private/catalog');
    expect(diagnosticText).not.toContain('\u001B');
    const lastDiagnostic = diagnosticFrames.at(-1)!;
    await input(instance, 'p');
    expect(frame(instance, size)).not.toBe(lastDiagnostic);

    await focusAction(instance, '预览安全报告');
    await input(instance, '\r');
    await waitForRoute(value, 'operationReportPreview');
    const firstReport = frame(instance, size);
    expect(firstReport).toContain('p 上一页');
    expect(firstReport).toContain('n 下一页');
    await input(instance, 'p');
    expect(frame(instance, size)).toBe(firstReport);
    const reportFrames = [firstReport];
    for (let index = 0; index < 48; index += 1) {
      await input(instance, 'n');
      reportFrames.push(frame(instance, size));
    }
    const reportText = reportFrames.join('\n');
    for (const line of detailLines.slice(0, -1)) expect(reportText).toContain(line);
    expect(reportText.replace(/[\s│]/gu, '')).toContain(tailSentinel);
    expect(reportText).not.toContain(privateToken);
    expect(reportText).not.toContain('/Users/private/catalog');
    expect(reportText).not.toContain('\u001B');
    const lastReport = reportFrames.at(-1)!;
    await input(instance, 'p');
    expect(frame(instance, size)).not.toBe(lastReport);
    instance.unmount();
  });

  it.each([
    ['succeeded', '✓ Catalog 本地存储清理完成'],
    ['partial', '! Catalog 本地存储只完成部分清理'],
  ] as const)('runs the Catalog store overview, rules, preview, confirmation and %s result at both terminal sizes', async (overallState, resultTitle) => {
    const oldEntry = catalogStoreEntry({
      storeKey: 'entry-old', status: 'reclaimable', generationReference: 'orphan',
      reclaimableBytes: 64, reason: 'formalOlderThan30Days',
    });
    const activeEntry = catalogStoreEntry({
      storeKey: 'entry-active', status: 'active', generationReference: 'active',
      reclaimableBytes: 0, reason: 'activeGeneration',
    });
    const lateEntry = catalogStoreEntry({
      storeKey: 'entry-appeared-after-preview', status: 'reclaimable', generationReference: 'orphan',
      reclaimableBytes: 128, reason: 'formalOlderThan30Days',
    });
    const authorizedItems: CatalogStorePruneItemKey[] = [{ storeKey: oldEntry.storeKey, category: oldEntry.category }];
    const storeEvidence: CatalogStoreTaskEvidence = {
      preview: {
        ...catalogStoreResult({
          overallState: 'succeeded', entries: [oldEntry, activeEntry], deleted: [],
          retained: [{ storeKey: activeEntry.storeKey, reason: activeEntry.reason }],
        }),
        dryRun: true,
      },
      entries: [oldEntry, activeEntry],
      authorizedItems,
      reclaimableBytes: oldEntry.reclaimableBytes,
    };

    for (const size of SIZES) {
      const executeIntent = vi.fn(async (intent: OperationIntent, expected: OperationEvidence) => {
        expect(intent).toEqual({ kind: 'catalogStorePrune' });
        expect(expected.catalogStore?.authorizedItems).toEqual(authorizedItems);
        expect(expected.catalogStore?.authorizedItems).not.toContainEqual({
          storeKey: lateEntry.storeKey, category: lateEntry.category,
        });
        return catalogStoreResult({
          overallState,
          entries: [oldEntry, activeEntry, lateEntry],
          deleted: overallState === 'succeeded' ? [{ storeKey: oldEntry.storeKey, bytes: 64 }] : [],
          retained: [
            { storeKey: activeEntry.storeKey, reason: activeEntry.reason },
            { storeKey: lateEntry.storeKey, reason: 'notAuthorizedAfterPreview' },
          ],
        });
      });
      const captureEvidence = vi.fn(async (intent: OperationIntent) => {
        expect(intent).toEqual({ kind: 'catalogStorePrune' });
        return { ...CATALOG_EVIDENCE, catalogStore: storeEvidence };
      });
      const value = controller({
        inspectCatalogStore: vi.fn().mockResolvedValue(catalogStoreStatus([oldEntry, activeEntry])),
        captureEvidence,
        executeIntent,
      });
      await value.load();
      value.push({ name: 'sourceList' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);

      await focusAction(instance, 'Catalog 本地存储');
      await input(instance, '\r');
      await waitForRoute(value, 'catalogStoreOverview');
      await nextTurn(3);
      const overview = frame(instance, size);
      expect(overview).toContain('存储概览');
      expect(overview).toContain('全部项目');
      expect(overview).toContain('可回收项目');
      expect(overview).toContain('预计可回收大小');

      await focusAction(instance, '查看保留规则');
      await input(instance, '\r');
      await waitForRoute(value, 'catalogStoreRules');
      const rules = frame(instance, size);
      expect(rules).toContain('安全清理规则');
      expect(rules).toContain('当前使用的目录不会删除');
      expect(rules).toContain('不属于 AW、无法确认安全或仍在使用的内容会保留');
      await input(instance, 'd');
      const technicalRules = frame(instance, size);
      expect(technicalRules).toContain('非 Active 项保留 30 天');
      expect(technicalRules).toContain('foreign、符号链接、unsafe、损坏或未知项目');
      await input(instance, 'd');
      await input(instance, '\u001B');
      await new Promise((resolve) => setTimeout(resolve, 550));
      await waitForRoute(value, 'catalogStoreOverview');

      await focusAction(instance, '预览安全清理');
      await input(instance, '\r');
      await waitForRoute(value, 'review');
      const review = frame(instance, size);
      expect(review).toContain('确认清理 Catalog 本地存储');
      expect(review).not.toContain('确认确认');
      expect(review).not.toContain('Catalog 来源配置');
      expect(review).toContain('只删除本次预览确认的 1 个可回收项');
      expect(review).toContain('删除 1 个已确认的可回收项');
      await confirmReview(instance, value);
      await waitForRoute(value, 'result');
      const result = frame(instance, size);
      expect(value.snapshot.result).toMatchObject({ state: overallState, operationKind: 'catalogStorePrune' });
      expect(result).toContain(resultTitle);
      expect(executeIntent).toHaveBeenCalledTimes(1);
      expect(captureEvidence).toHaveBeenCalledTimes(2);
      instance.unmount();
    }
  });
});


describe('plugin detail readable summary', () => {
  it.each(SIZES)('keeps long content, badges and actions readable at $columns x $rows', async (size) => {
    const data = loadResult();
    data.pluginSummaries[0]!.description = '用于检查长说明的完整阅读。'.repeat(45) + '摘要完整结尾';
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);
    value.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    await nextTurn(2);
    const initial = frame(instance, size);
    expect(initial).toContain('版本 · 1.0.0');
    expect(initial).toContain('来源 · official');
    expect(initial).toContain('Codex · 尚未安装');
    expect(initial).toContain('› ');
    expect(initial).toContain('完整基本信息');
    expect(initial).toContain('帮助');
    await focusAction(instance, '完整基本信息');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    let foundEnd = false;
    for (let page = 0; page < 30; page += 1) {
      const current = frame(instance, size);
      if (current.includes('摘要完整结尾')) { foundEnd = true; break; }
      await input(instance, 'n');
    }
    expect(foundEnd).toBe(true);
    await input(instance, '\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    instance.rerender(<ConsoleAppV4 controller={value} size={size.columns === 60
      ? { columns: 80, rows: 24 } : { columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Codex');
    await input(instance, '\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(value.snapshot.router.current.route.name).toBe('home');
    value.dispose();
  });
});


it.each(SIZES)('explains absent project declarations without scheduling writes at $columns x $rows', async (size) => {
  const data = loadResult();
  data.projectIntent = { state: 'absent' };
  const executeIntent = vi.fn();
  const value = controller({ loadStatus: vi.fn().mockResolvedValue(data), executeIntent });
  const instance = render(<ConsoleAppV4 controller={value} size={size} />);
  await nextTurn(3);
  expect(frame(instance, size)).toContain('当前目录没有共享插件声明；不会自动安装插件');
  await input(instance, '\r');
  expect(value.snapshot.router.current.route.name).toBe('pluginList');
  expect(executeIntent).not.toHaveBeenCalled();
  value.dispose();
});
