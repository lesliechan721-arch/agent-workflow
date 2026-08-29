import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV5Payload, StatusV5PluginSummary } from '../../src/commands/status-v5.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  CatalogRefreshCoordinator,
  type CatalogSourceGenerationViewModel,
} from '../../src/tui/catalog-generation.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

afterEach(() => cleanup());

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function generation(options: {
  sourceId?: string;
  sourceType?: 'git' | 'path';
  policy?: 'startup' | 'manual';
  state?: CatalogSourceGenerationViewModel['refreshState'];
  candidateVersion?: string;
} = {}): CatalogSourceGenerationViewModel {
  const sourceId = options.sourceId ?? 'official';
  return {
    sourceId,
    sourceType: options.sourceType ?? 'git',
    refreshPolicy: options.policy ?? 'manual',
    active: {
      catalogVersion: '1.0.0',
      channel: 'latest',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: '1'.repeat(40),
      generationKey: `${'a'.repeat(64)}/${'1'.repeat(64)}`,
      digestShort: '11111111',
    },
    ...(options.candidateVersion ? {
      candidate: {
        catalogVersion: options.candidateVersion,
        channel: 'latest',
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: '2'.repeat(40),
        generationKey: `${'a'.repeat(64)}/${'2'.repeat(64)}`,
        digestShort: '22222222',
        kind: 'upgrade',
        downloadedAt: '2026-08-29T00:00:00.000Z',
        pluginChanges: { added: 2, updated: 3, removed: 1 },
      },
    } : {}),
    refreshState: options.state ?? (options.candidateVersion ? 'candidateReady' : 'idle'),
    lastCheckedAt: '2026-08-29T00:00:00.000Z',
    ...(options.state === 'immutableViolation'
      ? { lastCheckCode: 'catalogImmutableVersionViolation' }
      : {}),
  };
}

function loadResult(catalogGenerations: CatalogSourceGenerationViewModel[]): TuiStatusLoadResult {
  const sourceId = catalogGenerations[0]?.sourceId ?? 'official';
  const summaries: StatusV5PluginSummary[] = [{
    pluginName: 'toolkit',
    pluginId: `${sourceId}/toolkit`,
    displayName: 'Agent Toolkit',
    description: 'Agent tools',
    version: '0.1.0',
    supportedTargets: { codex: ['user'], claude: [] },
    configFieldCount: 1,
  }];
  const payload: StatusV5Payload = {
    schemaVersion: 5,
    catalog: {
      primarySourceId: sourceId,
      configDigest: `sha256:${'c'.repeat(64)}`,
      compositeDigest: `sha256:${'d'.repeat(64)}`,
      sources: catalogGenerations.map((source) => ({
        id: source.sourceId,
        identity: `identity:${source.sourceId}`,
        type: source.sourceType,
        primary: source.sourceId === sourceId,
        requestedRef: source.active?.requestedRef ?? 'path',
        ...(source.active ? {
          resolvedCommit: source.active.resolvedCommit,
          catalogVersion: source.active.catalogVersion,
          channel: source.active.channel,
        } : {}),
        freshness: 'active',
      })),
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: [],
    errors: [],
  };
  return {
    payload,
    pluginSummaries: summaries,
    catalogGenerations,
    sessionGenerationKeys: Object.fromEntries(catalogGenerations.flatMap((source) =>
      source.active ? [[source.sourceId, source.active.generationKey]] : [])),
    sourceDetails: catalogGenerations.map((source) => ({
      id: source.sourceId,
      type: source.sourceType,
      primary: source.sourceId === sourceId,
      locationSummary: source.sourceType === 'git' ? 'https://example.invalid/catalog.git' : '本地目录',
      ...(source.sourceType === 'git' ? { refPolicy: 'explicit' as const } : {}),
      pluginCount: 1,
      sourceIdentity: `identity:${source.sourceId}`,
      requestedRef: source.active?.requestedRef ?? 'path',
      ...(source.active ? {
        resolvedCommit: source.active.resolvedCommit,
        catalogVersion: source.active.catalogVersion,
        channel: source.active.channel,
      } : {}),
      freshness: 'active',
      configDigest: payload.catalog.configDigest,
    })),
  };
}

function catalogEvidence(source: CatalogSourceGenerationViewModel): OperationEvidence {
  return {
    catalog: {
      configDigest: `sha256:${'c'.repeat(64)}`,
      compositeDigest: `sha256:${'d'.repeat(64)}`,
      generationSetDigest: `sha256:${'e'.repeat(64)}`,
    },
    catalogCandidate: {
      sourceId: source.sourceId,
      activeVersion: source.active!.catalogVersion,
      candidateVersion: source.candidate!.catalogVersion,
      channel: source.candidate!.channel,
      requestedRef: source.candidate!.requestedRef,
      candidateGenerationKey: source.candidate!.generationKey,
      digestShort: source.candidate!.digestShort,
      pluginChanges: source.candidate!.pluginChanges,
    },
  };
}

function dependencies(options: {
  initial?: CatalogSourceGenerationViewModel;
  refreshCatalogSource?: TuiControllerDependencies['refreshCatalogSource'];
  loadStatus?: TuiControllerDependencies['loadStatus'];
  captureEvidence?: TuiControllerDependencies['captureEvidence'];
  executeIntent?: TuiControllerDependencies['executeIntent'];
  setCatalogRefreshPolicy?: TuiControllerDependencies['setCatalogRefreshPolicy'];
  beginCatalogSession?: TuiControllerDependencies['beginCatalogSession'];
} = {}): TuiControllerDependencies {
  const initial = options.initial ?? generation({ candidateVersion: '1.1.0' });
  return {
    beginCatalogSession: options.beginCatalogSession,
    loadStatus: options.loadStatus ?? (async () => loadResult([initial])),
    checkSource: async () => ({ sourceIdentity: 'identity:official', requestedRef: 'refs/heads/catalog/latest' }),
    refreshCatalogSource: options.refreshCatalogSource,
    setCatalogRefreshPolicy: options.setCatalogRefreshPolicy,
    captureEvidence: options.captureEvidence ?? (async (intent) => {
      if (intent.kind === 'catalogActivate') return catalogEvidence(initial);
      return {
        catalog: {
          configDigest: `sha256:${'c'.repeat(64)}`,
          compositeDigest: `sha256:${'d'.repeat(64)}`,
          generationSetDigest: `sha256:${'e'.repeat(64)}`,
        },
        source: {
          sourceId: 'official',
          sourceIdentity: 'identity:official',
          snapshotDigest: `sha256:${'1'.repeat(64)}`,
          catalogVersion: '1.0.0',
        },
      };
    }),
    validateIntent: async () => undefined,
    executeIntent: options.executeIntent ?? (async () => ({ ok: true })),
  };
}

describe('Catalog refresh coordinator', () => {
  it('filters startup sources, keeps concurrency at two, and continues after one source fails', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const started: string[] = [];
    let running = 0;
    let maximum = 0;
    const coordinator = new CatalogRefreshCoordinator({
      maxConcurrency: 2,
      onUpdate: () => undefined,
      execute: async (sourceId) => {
        started.push(sourceId);
        running += 1;
        maximum = Math.max(maximum, running);
        const gate = deferred<void>();
        gates.set(sourceId, gate);
        await gate.promise;
        running -= 1;
        if (sourceId === 'bad') throw new Error('source failed');
        return {
          source: generation({ sourceId, policy: 'startup', state: 'upToDate' }),
          activeChanged: false,
        };
      },
    });
    coordinator.start([
      generation({ sourceId: 'a', policy: 'startup' }),
      generation({ sourceId: 'bad', policy: 'startup' }),
      generation({ sourceId: 'c', policy: 'startup' }),
      generation({ sourceId: 'manual', policy: 'manual' }),
      generation({ sourceId: 'path', sourceType: 'path', policy: 'manual' }),
    ]);
    coordinator.start([generation({ sourceId: 'late', policy: 'startup' })]);
    await waitFor(() => started.length === 2, 'first refresh pair');
    expect(started).toEqual(['a', 'bad']);
    gates.get('bad')!.resolve();
    await waitFor(() => started.includes('c'), 'independent source after failure');
    gates.get('a')!.resolve();
    gates.get('c')!.resolve();
    await waitFor(() => running === 0, 'all refreshes');
    expect(maximum).toBe(2);
    expect(started).not.toContain('manual');
    expect(started).not.toContain('path');
    expect(started).not.toContain('late');
    coordinator.dispose();
  });

  it('aborts the running refresh and does not start queued work after dispose', async () => {
    const signals: AbortSignal[] = [];
    const coordinator = new CatalogRefreshCoordinator({
      maxConcurrency: 1,
      onUpdate: () => undefined,
      execute: async (_sourceId, signal) => {
        signals.push(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { source: generation(), activeChanged: false };
      },
    });
    const first = coordinator.refresh('first');
    const second = coordinator.refresh('second');
    await waitFor(() => signals.length === 1, 'running refresh');
    coordinator.dispose();
    await Promise.all([first, second]);
    expect(signals[0]!.aborted).toBe(true);
    expect(signals).toHaveLength(1);
  });

  it('forwards the complete Active-change event to the Controller boundary', async () => {
    const result = {
      source: generation({ state: 'upToDate' }),
      activeChanged: true,
      activeGenerationKey: `${'a'.repeat(64)}/${'2'.repeat(64)}`,
    };
    const onResult = vi.fn();
    const coordinator = new CatalogRefreshCoordinator({
      onUpdate: () => undefined,
      execute: async () => result,
      onResult,
    });

    await coordinator.refresh('official');

    expect(onResult).toHaveBeenCalledWith(result);
    coordinator.dispose();
  });
});

describe('Catalog generation TUI', () => {
  it('publishes the Active first frame before startup refresh and keeps the session plugin list unchanged', async () => {
    const refresh = deferred<void>();
    const initial = generation({ policy: 'startup' });
    const updated = generation({ policy: 'startup', candidateVersion: '1.1.0' });
    const controller = new TuiController(dependencies({
      initial,
      refreshCatalogSource: async (_sourceId, signal, onState) => {
        onState('checking');
        await refresh.promise;
        signal.throwIfAborted();
        return { source: updated, activeChanged: false };
      },
    }));
    const observed: string[] = [];
    controller.subscribe((snapshot) => {
      observed.push(`${snapshot.phase}:${snapshot.catalogGenerations[0]?.refreshState ?? 'none'}`);
    });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => observed.includes('ready:checking'), 'background refresh start');
    await waitFor(() => instance.lastFrame()?.includes('添加插件') === true, 'Active first frame');
    expect(observed.indexOf('ready:idle')).toBeLessThan(observed.indexOf('ready:checking'));
    expect(instance.lastFrame()).toContain('当前状态');
    expect(instance.lastFrame()).not.toContain('1.1.0');
    const pluginIds = controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId);
    refresh.resolve();
    await waitFor(() => controller.listCatalogCandidates().length === 1, 'Candidate badge');
    expect(controller.isCatalogReloadRequired('official')).toBe(false);
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual(pluginIds);
    await waitFor(() => instance.lastFrame()?.includes('Catalog 有更新') === true, 'Candidate home card');
    expect(instance.lastFrame()).toContain('当前操作仍使用 1.0.0');
    expect(instance.lastFrame()).toContain('查看 Catalog 更新');
    expect(instance.lastFrame()).toContain('› 添加插件');
    controller.dispose();
  });

  it('summarizes multiple Candidates in stable source order', async () => {
    const controller = new TuiController(dependencies({
      initial: generation({ sourceId: 'z-source', candidateVersion: '1.1.0' }),
      loadStatus: async () => loadResult([
        generation({ sourceId: 'z-source', candidateVersion: '1.1.0' }),
        generation({ sourceId: 'a-source', candidateVersion: '1.2.0' }),
      ]),
    }));
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => instance.lastFrame()?.includes('Catalog 有更新') === true, 'stable Candidate summary');
    expect(instance.lastFrame()).toContain('a-source');
    expect(instance.lastFrame()).toContain('1.0.0 → 1.2.0');
    expect(instance.lastFrame()).toContain('当前操作仍使用 1.0.0');
    expect(instance.lastFrame()).toContain('另有 1 个来源');
    expect(instance.lastFrame()).toContain('查看 Catalog 更新');
    expect(controller.listCatalogCandidates().map((source) => source.sourceId))
      .toEqual(['a-source', 'z-source']);
    controller.dispose();
  });

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps K02, K03, K06, and K07 reasons and actions visible at $columns×$rows',
    async (size) => {
      const current = generation({ candidateVersion: '1.1.0' });
      const controller = new TuiController(dependencies({ initial: current }));
      await controller.load();
      controller.push({ name: 'sourceDetail', sourceId: 'official' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await waitFor(() => instance.lastFrame()?.includes('当前使用') === true, 'K02');
      expect(instance.lastFrame()).toContain('1.0.0');
      expect(instance.lastFrame()).toContain('1.1.0');
      expect(instance.lastFrame()).toContain('使用 1.1.0');
      expect(instance.lastFrame()).not.toContain('使用缓存');
      expect(instance.lastFrame()).toContain('refs/heads/catalog/latest');
      expect(instance.lastFrame()).toContain('仅手动');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);

      controller.replace({ name: 'catalogCandidate', sourceId: 'official' });
      controller.beginCatalogActivation({ sourceId: 'official' });
      await waitFor(() => controller.snapshot.router.current.route.name === 'review', 'K03 Review');
      expect(instance.lastFrame()).toContain('不会自动升级');
      expect(instance.lastFrame()).toContain('当前设置不会改变');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);

      controller.replace({ name: 'catalogImmutableViolation', sourceId: 'official' });
      await waitFor(() => instance.lastFrame()?.includes('不加载远端变化') === true, 'K06');
      expect(instance.lastFrame()).toContain('继续使用本地已验证的 1.0.0');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);

      controller.replace({ name: 'catalogCandidate', sourceId: 'official' });
      controller.beginCatalogActivation({
        sourceId: 'official',
        dirtyDraft: { kind: 'config', label: 'Agent Toolkit · 当前项目设置草稿' },
      });
      await waitFor(() => instance.lastFrame()?.includes('暂时不能切换 Catalog') === true, 'K07');
      expect(instance.lastFrame()).toContain('设置草稿');
      expect(instance.lastFrame()).toContain('Candidate 1.1.0 保持已下载状态');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.1.0');
      controller.dispose();
    },
  );

  it('updates refresh policy without starting refresh or changing the current session', async () => {
    const refreshCatalogSource = vi.fn();
    const setPolicy = vi.fn(async (_sourceId: string, policy: 'startup' | 'manual') =>
      generation({ policy }));
    const controller = new TuiController(dependencies({
      initial: generation(),
      refreshCatalogSource,
      setCatalogRefreshPolicy: setPolicy,
    }));
    await controller.load();
    controller.push({ name: 'catalogRefreshPolicy', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => instance.lastFrame()?.includes('启动时自动检查') === true, 'K04 policy');
    expect(instance.lastFrame()).toContain('仅手动检查');
    instance.stdin.write('\r');
    await waitFor(() => setPolicy.mock.calls.length === 1, 'K04 policy action');
    expect(setPolicy).toHaveBeenCalledWith('official', 'startup');
    expect(refreshCatalogSource).not.toHaveBeenCalled();
    expect(controller.getCatalogGeneration('official')?.refreshPolicy).toBe('startup');
    expect(controller.getPluginOverview('official/toolkit')?.version).toBe('0.1.0');
    controller.dispose();
  });

  it('keeps coordinator refresh ownership across a deferred policy update and cancel race', async () => {
    const current = generation({ candidateVersion: '1.1.0' });
    const policyResult = deferred<CatalogSourceGenerationViewModel>();
    const setPolicy = vi.fn()
      .mockResolvedValueOnce(generation({ policy: 'manual', candidateVersion: '1.1.0' }))
      .mockImplementationOnce(async () => policyResult.promise);
    const controller = new TuiController(dependencies({
      initial: current,
      setCatalogRefreshPolicy: setPolicy,
      refreshCatalogSource: async (_sourceId, signal, onState) => {
        onState('checking');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { source: current, activeChanged: false };
      },
    }));
    await controller.load();
    const refresh = controller.refreshSource('official');
    await waitFor(() => controller.getCatalogGeneration('official')?.refreshState === 'checking', 'running refresh');
    await controller.setCatalogRefreshPolicy('official', 'manual');
    expect(controller.getCatalogGeneration('official')).toMatchObject({
      refreshPolicy: 'manual',
      refreshState: 'checking',
      candidate: { catalogVersion: '1.1.0' },
    });
    controller.beginCatalogActivation({
      sourceId: 'official',
      dirtyDraft: { kind: 'config', label: '当前设置草稿' },
    });
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'catalogActivationBlocked',
      reason: 'refreshProgress',
      preservedLabel: expect.stringContaining('当前设置草稿'),
    });
    expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.1.0');

    const policyUpdate = controller.setCatalogRefreshPolicy('official', 'manual');
    await waitFor(() => setPolicy.mock.calls.length === 2, 'late policy result');
    controller.cancelCatalogRefresh('official');
    await refresh;
    policyResult.resolve(generation({
      policy: 'manual', candidateVersion: '1.1.0', state: 'checking',
    }));
    await policyUpdate;
    expect(controller.getCatalogGeneration('official')).toMatchObject({
      refreshPolicy: 'manual',
      refreshState: 'candidateReady',
      candidate: { catalogVersion: '1.1.0' },
    });
    controller.back();
    controller.beginCatalogActivation({ sourceId: 'official' });
    await waitFor(() => controller.snapshot.router.current.route.name === 'review', 'activation guard release');
    controller.dispose();
  });

  it('keeps Path refresh manual and exposes an explicit local refresh action without K04', async () => {
    const initialSource = generation({ sourceType: 'path', policy: 'manual' });
    const refreshedSource = generation({ sourceType: 'path', policy: 'manual', state: 'upToDate' });
    refreshedSource.active = {
      ...refreshedSource.active!,
      catalogVersion: '2.0.0',
      generationKey: `${'a'.repeat(64)}/${'2'.repeat(64)}`,
    };
    const refreshed = vi.fn(async () => ({
      source: refreshedSource,
      activeChanged: true,
      activeGenerationKey: refreshedSource.active!.generationKey,
    }));
    const reloaded = loadResult([refreshedSource]);
    reloaded.pluginSummaries[0] = {
      ...reloaded.pluginSummaries[0]!,
      displayName: 'Updated Agent Toolkit',
      version: '0.2.0',
    };
    reloaded.payload.targets = [{
      pluginName: 'toolkit',
      pluginId: 'official/toolkit',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      version: '0.2.0',
      platform: 'codex',
      scope: 'user',
      cwd: '/workspace',
      state: 'present',
      components: [],
      errors: [],
    }];
    reloaded.dependencyOverviews = [{
      pluginId: 'official/toolkit',
      summary: {
        directCount: 1, transitiveCount: 0, totalCount: 1,
        readyCount: 1, missingCount: 0, issueCount: 0,
      },
      dependencies: [], dependents: [], blockers: [],
    }];
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(loadResult([initialSource]))
      .mockResolvedValue(reloaded);
    const beginCatalogSession = vi.fn();
    const controller = new TuiController(dependencies({
      initial: initialSource,
      refreshCatalogSource: refreshed,
      loadStatus,
      beginCatalogSession,
    }));
    await controller.load();
    await new Promise((resolve) => setImmediate(resolve));
    expect(refreshed).not.toHaveBeenCalled();
    controller.push({ name: 'sourceDetail', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => instance.lastFrame()?.includes('重新检查来源') === true, 'Path refresh action');
    expect(instance.lastFrame()).toContain('仅手动');
    expect(instance.lastFrame()).not.toContain('Catalog 自动刷新');
    instance.stdin.write('\r');
    await waitFor(() => refreshed.mock.calls.length === 1, 'explicit Path refresh');
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'catalogRefresh', sourceId: 'official',
    });
    await waitFor(() => instance.lastFrame()?.includes('Catalog 已是最新') === true, 'Path refresh completion');
    expect(controller.isCatalogReloadRequired('official')).toBe(true);
    expect(instance.lastFrame()).toContain('新 Active Catalog 2.0.0');
    expect(instance.lastFrame()).toContain('本次会话仍使用 Catalog 1.0.0');
    expect(instance.lastFrame()).toContain('重新加载Catalog');
    expect(controller.getPluginOverview('official/toolkit')?.displayName).toBe('Agent Toolkit');
    instance.stdin.write('\r');
    await waitFor(() => controller.snapshot.router.current.route.name === 'sourceDetail', 'Path source detail');
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(beginCatalogSession).toHaveBeenLastCalledWith({ bootstrapMissingActive: false });
    expect(controller.isCatalogReloadRequired('official')).toBe(false);
    expect(instance.lastFrame()).toContain('Catalog 2.0.0');
    expect(controller.getPluginOverview('official/toolkit')?.displayName).toBe('Updated Agent Toolkit');
    expect(controller.getPlatformPlacement('official/toolkit', 'codex')).toMatchObject({
      state: 'installed', scope: 'user', health: 'ready',
    });
    expect(controller.getPluginDependencyOverview('official/toolkit')?.summary.totalCount).toBe(1);
    controller.dispose();
  });

  it('keeps the first background Git Active outside the fixed session until explicit reload', async () => {
    const missing = generation({ policy: 'startup' });
    delete missing.active;
    const bootstrapped = generation({ policy: 'startup', state: 'upToDate' });
    const initialLoad = loadResult([missing]);
    const reloaded = loadResult([bootstrapped]);
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initialLoad)
      .mockResolvedValue(reloaded);
    const controller = new TuiController(dependencies({
      initial: missing,
      loadStatus,
      refreshCatalogSource: async () => ({
        source: bootstrapped,
        activeChanged: true,
        activeGenerationKey: bootstrapped.active!.generationKey,
      }),
    }));
    await controller.load();
    await waitFor(() => controller.isCatalogReloadRequired('official'), 'background bootstrap reload');
    controller.push({ name: 'sourceDetail', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => instance.lastFrame()?.includes('重新加载Catalog') === true, 'bootstrap reload action');
    expect(instance.lastFrame()).toContain('新 Active Catalog 1.0.0');
    expect(instance.lastFrame()).toContain('本次会话 Catalog 未加');

    await controller.reloadCatalog({
      sourceId: 'official',
      dirtyDraft: { kind: 'config', label: '当前设置草稿' },
    });
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'catalogActivationBlocked',
      operation: 'reload',
      reason: 'configDraft',
      preservedLabel: '当前设置草稿',
    });
    expect(loadStatus).toHaveBeenCalledOnce();
    controller.back();
    await expect(controller.reloadCatalog({ sourceId: 'official' })).resolves.toBe(true);
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(controller.isCatalogReloadRequired('official')).toBe(false);
    controller.dispose();
  });

  it('requires reload only after an explicit Active-change event', async () => {
    const initial = generation({ policy: 'manual' });
    const changed = generation({ policy: 'manual', state: 'upToDate' });
    changed.active = {
      ...changed.active!,
      catalogVersion: '2.0.0',
      generationKey: `${'a'.repeat(64)}/${'2'.repeat(64)}`,
    };
    const incompatible = loadResult([initial]);
    incompatible.sessionGenerationKeys = {};
    incompatible.payload.catalog.sources[0] = {
      ...incompatible.payload.catalog.sources[0]!,
      error: 'safe incompatible Active',
      errorCode: 'awCapabilityUnsupported',
    };
    const refreshed = [
      { source: { ...changed, refreshState: 'candidateReady' as const }, activeChanged: false },
      { source: { ...changed, refreshState: 'upToDate' as const }, activeChanged: false },
      { source: { ...changed, refreshState: 'channelRollback' as const }, activeChanged: false },
      {
        source: changed,
        activeChanged: true,
        activeGenerationKey: changed.active.generationKey,
      },
    ];
    const reloadFailure = loadResult([changed]);
    reloadFailure.sessionGenerationKeys = {};
    reloadFailure.payload.catalog.sources[0] = {
      ...reloadFailure.payload.catalog.sources[0]!,
      error: 'safe source load failure',
      errorCode: 'catalogSourceUnavailable',
    };
    const controller = new TuiController(dependencies({
      initial,
      loadStatus: vi.fn()
        .mockResolvedValueOnce(incompatible)
        .mockResolvedValueOnce(reloadFailure),
      refreshCatalogSource: vi.fn(async () => refreshed.shift()!),
    }));
    await controller.load();
    expect(controller.isCatalogReloadRequired('official')).toBe(false);
    for (const _state of ['candidateReady', 'upToDate', 'channelRollback']) {
      await controller.refreshSource('official');
      expect(controller.isCatalogReloadRequired('official')).toBe(false);
    }
    await controller.refreshSource('official');
    expect(controller.isCatalogReloadRequired('official')).toBe(true);

    await expect(controller.reloadCatalog({ sourceId: 'official' })).resolves.toBe(true);
    expect(controller.isCatalogReloadRequired('official')).toBe(false);
    expect(controller.getSourceOverview('official').health?.state).toBe('unavailable');
    controller.dispose();
  });

  it('shows real K05 boundaries and cancels the read-only refresh with Esc', async () => {
    let refreshSignal: AbortSignal | undefined;
    const controller = new TuiController(dependencies({
      initial: generation({ candidateVersion: '1.1.0' }),
      refreshCatalogSource: async (_sourceId, signal, onState) => {
        refreshSignal = signal;
        onState('checking');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return { source: generation({ state: 'upToDate' }), activeChanged: false };
      },
    }));
    await controller.load();
    controller.push({ name: 'catalogRefresh', sourceId: 'official' });
    const refresh = controller.refreshSource('official');
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await waitFor(() => instance.lastFrame()?.includes('检查并获取远端 generation') === true, 'K05 checking');
    expect(instance.lastFrame()).toContain('当前操作继续使用 Catalog 1.0.0');
    expect(instance.lastFrame()).toContain('Esc 取消检查');
    instance.stdin.write('\u001B');
    await refresh;
    expect(refreshSignal?.aborted).toBe(true);
    expect(controller.snapshot.router.current.route.name).toBe('home');
    expect(controller.getCatalogGeneration('official')?.active?.catalogVersion).toBe('1.0.0');
    expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.1.0');
    expect(controller.getCatalogGeneration('official')?.refreshState).toBe('candidateReady');
    controller.dispose();
  });

  it('routes active Review, Review preparation, and write progress to K07 without dropping work', async () => {
    const current = generation({ candidateVersion: '1.1.0' });
    const evidenceGate = deferred<OperationEvidence>();
    const executeGate = deferred<unknown>();
    let delayEvidence = false;
    const controller = new TuiController(dependencies({
      initial: current,
      captureEvidence: async (intent) => {
        if (intent.kind === 'catalogActivate') return catalogEvidence(current);
        if (delayEvidence) return evidenceGate.promise;
        return dependencies({ initial: current }).captureEvidence(intent, new AbortController().signal);
      },
      executeIntent: async () => executeGate.promise,
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/toolkit', scope: 'user',
      projectLayer: 'shared', updates: { mode: 'strict' },
    });
    controller.beginCatalogActivation({ sourceId: 'official' });
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'catalogActivationBlocked', reason: 'activeReview',
    });
    expect(controller.snapshot.activeReview?.reviewToken).toBe(review.reviewToken);
    expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.1.0');

    controller.back();
    const operation = controller.executeOperation(review.reviewToken);
    expect(controller.snapshot.router.current.route.name).toBe('progress');
    controller.beginCatalogActivation({ sourceId: 'official' });
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'catalogActivationBlocked', reason: 'writeProgress',
    });
    expect(controller.snapshot.activeReview?.reviewToken).toBe(review.reviewToken);
    executeGate.resolve({ configWrite: 'succeeded' });
    await operation;

    delayEvidence = true;
    controller.startReviewPreparation({
      kind: 'configSave', pluginId: 'official/toolkit', scope: 'user',
      projectLayer: 'shared', updates: { mode: 'careful' },
    });
    await waitFor(() => controller.snapshot.reviewPreparation !== undefined, 'Review preparation');
    controller.beginCatalogActivation({ sourceId: 'official' });
    expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'catalogActivationBlocked', reason: 'reviewPreparation',
    });
    expect(controller.snapshot.reviewPreparation).toBeDefined();
    expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.1.0');
    evidenceGate.resolve(await dependencies({ initial: current }).captureEvidence(
      { kind: 'configSave', pluginId: 'official/toolkit', scope: 'user', projectLayer: 'shared', updates: { mode: 'careful' } },
      new AbortController().signal,
    ));
    await waitFor(() => controller.snapshot.activeReview?.operationKind === 'configSave', 'preserved Review preparation');
    expect(controller.snapshot.router.current.route.name).toBe('review');
    controller.dispose();
  });

  it('returns stale and builds a new activation Review when Candidate drifts', async () => {
    const reviewed = generation({ candidateVersion: '1.1.0' });
    const changed = generation({ candidateVersion: '1.2.0' });
    changed.candidate = {
      ...changed.candidate!,
      generationKey: `${'a'.repeat(64)}/${'3'.repeat(64)}`,
      digestShort: '33333333',
    };
    let drifted = false;
    const executeIntent = vi.fn();
    const controller = new TuiController(dependencies({
      initial: reviewed,
      loadStatus: async () => loadResult([drifted ? changed : reviewed]),
      captureEvidence: async (intent) => intent.kind === 'catalogActivate'
        ? catalogEvidence(drifted ? changed : reviewed)
        : dependencies({ initial: reviewed }).captureEvidence(intent, new AbortController().signal),
      executeIntent,
    }));
    await controller.load();
    controller.beginCatalogActivation({ sourceId: 'official' });
    await waitFor(() => controller.snapshot.activeReview !== undefined, 'original activation Review');
    const originalToken = controller.snapshot.activeReview!.reviewToken;
    drifted = true;
    const result = await controller.executeOperation(originalToken);
    expect(result).toMatchObject({
      state: 'stale', review: { operationKind: 'catalogActivate' },
    });
    expect(result.state === 'stale' && result.review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Catalog 1.0.0 → 1.2.0' }),
    ]));
    expect(executeIntent).not.toHaveBeenCalled();
    expect(controller.getCatalogGeneration('official')?.candidate?.catalogVersion).toBe('1.2.0');
    controller.dispose();
  });

  it('activates without refresh, rebuilds the session, and shows fixed Catalog evidence in plugin Review', async () => {
    const before = generation({ candidateVersion: '1.1.0' });
    const after = generation();
    after.active = { ...before.candidate! };
    const beginCatalogSession = vi.fn();
    let activated = false;
    const executeIntent = vi.fn(async (intent: OperationIntent) => {
      expect(intent.kind).toBe('catalogActivate');
      activated = true;
      return { outcome: 'activated' };
    });
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(loadResult([before]))
      .mockResolvedValue(loadResult([after]));
    const controller = new TuiController(dependencies({
      initial: before,
      loadStatus,
      executeIntent,
      beginCatalogSession,
      captureEvidence: async (intent) => {
        if (intent.kind === 'catalogActivate') return catalogEvidence(before);
        const source = activated ? after : before;
        return {
          catalog: {
            configDigest: `sha256:${'c'.repeat(64)}`,
            compositeDigest: `sha256:${'d'.repeat(64)}`,
            generationSetDigest: `sha256:${'e'.repeat(64)}`,
          },
          source: {
            sourceId: 'official', sourceIdentity: 'identity:official',
            snapshotDigest: `sha256:${activated ? '2'.repeat(64) : '1'.repeat(64)}`,
            catalogVersion: source.active!.catalogVersion,
          },
        };
      },
    }));
    await controller.load();
    controller.push({ name: 'catalogCandidate', sourceId: 'official' });
    controller.beginCatalogActivation({ sourceId: 'official' });
    await waitFor(() => controller.snapshot.activeReview !== undefined, 'activation Review');
    await controller.executeOperation(controller.snapshot.activeReview!.reviewToken);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(beginCatalogSession).toHaveBeenLastCalledWith({
      bootstrapMissingActive: false,
      reuseValidatedGenerations: true,
    });
    expect(controller.getCatalogGeneration('official')?.active?.catalogVersion).toBe('1.1.0');
    expect(controller.getCatalogGeneration('official')?.candidate).toBeUndefined();
    expect(controller.isCatalogReloadRequired('official')).toBe(false);

    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/toolkit',
      scope: 'user',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    });
    expect(review.catalogBinding).toEqual({
      sourceId: 'official',
      catalogVersion: '1.1.0',
      generationDigestShort: '22222222',
    });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await waitFor(() => instance.lastFrame()?.includes('操作期间不检查远端 Catalog') === true, 'fixed generation Review');
    expect(instance.lastFrame()).toContain('generation 22222222');
    expect(instance.lastFrame()).not.toContain(`sha256:${'1'.repeat(64)}`);
    controller.dispose();
  });
});
