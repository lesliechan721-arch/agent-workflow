import { describe, expect, it, vi } from 'vitest';

import type { StatusV4Payload, StatusV4PluginSummary } from '../../src/commands/status-v4.js';
import type { RebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  TuiController,
  type OperationEvidence,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import { buildTuiViewModel } from '../../src/tui/model.js';
import { TuiRouter } from '../../src/tui/router.js';

function source(
  id: string,
  options: { primary?: boolean; freshness?: 'remote' | 'cache' | 'path'; error?: string; type?: 'git' | 'path' } = {},
): StatusV4Payload['catalog']['sources'][number] {
  return {
    id,
    identity: `identity:${id}`,
    type: options.type ?? 'git',
    primary: options.primary ?? id === 'official',
    requestedRef: options.type === 'path' ? 'path' : 'refs/heads/catalog/latest',
    ...(options.freshness ? { freshness: options.freshness } : {}),
    ...(options.error ? { error: options.error, errorCode: 'catalogSourceUnavailable' } : {}),
  };
}

function status(options: {
  sources?: StatusV4Payload['catalog']['sources'];
  targets?: StatusV4Payload['targets'];
  errors?: StatusV4Payload['errors'];
} = {}): StatusV4Payload {
  return {
    schemaVersion: 4,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: options.sources ?? [source('official', { freshness: 'cache' })],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: options.targets ?? [],
    errors: options.errors ?? [],
  };
}

function target(options: {
  pluginName?: string;
  sourceId?: string;
  platform?: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
}): StatusV4Payload['targets'][number] {
  const pluginName = options.pluginName ?? 'demo';
  const sourceId = options.sourceId ?? 'official';
  return {
    pluginName,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    pluginId: `${sourceId}/${pluginName}`,
    version: '1.0.0',
    platform: options.platform ?? 'codex',
    scope: options.scope,
    cwd: '/workspace',
    state: options.state,
    components: [],
    errors: options.state === 'error' ? [{ code: 'targetError', message: 'safe failure' }] : [],
  };
}

function summaries(...entries: Array<[string, string]>): StatusV4PluginSummary[] {
  return entries.map(([sourceId, pluginName]) => ({
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    description: `${sourceId} description`,
  }));
}

const baseEvidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function dependencies(overrides: Partial<TuiControllerDependencies> = {}): TuiControllerDependencies {
  return {
    loadStatus: vi.fn().mockResolvedValue({
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
    }),
    checkSource: vi.fn().mockResolvedValue(undefined),
    captureEvidence: vi.fn().mockResolvedValue(baseEvidence),
    executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    createToken: vi.fn()
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('review-1')
      .mockReturnValueOnce('operation-2')
      .mockReturnValueOnce('review-2'),
    now: () => 1_000,
    ...overrides,
  };
}

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

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('TUI v4 router and ViewModel', () => {
  it('restores list focus, query, and source tab after a detail route goes back', () => {
    const router = new TuiRouter();
    router.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'team' },
      { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
    );
    router.push({ name: 'pluginDetail', pluginId: 'team/review-gate' });

    expect(router.back()).toEqual({
      depth: 2,
      current: {
        route: { name: 'pluginList', mode: 'browse', sourceId: 'team' },
        context: { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
      },
    });
  });

  it('keeps same-name plugins separate and sorts the tie by source identity', () => {
    const view = buildTuiViewModel({
      status: status({
        sources: [
          source('official', { freshness: 'cache' }),
          source('team', { freshness: 'cache', primary: false }),
        ],
        targets: [
          target({ sourceId: 'team', pluginName: 'review-gate', scope: 'user', state: 'absent' }),
          target({ sourceId: 'official', pluginName: 'review-gate', scope: 'user', state: 'present' }),
        ],
      }),
      pluginSummaries: summaries(['team', 'review-gate'], ['official', 'review-gate']),
    });

    expect(view.plugins.map((plugin) => [plugin.pluginId, plugin.aggregateStatus])).toEqual([
      ['official/review-gate', 'installed'],
      ['team/review-gate', 'available'],
    ]);
  });

  it('projects one installed scope as normal placement and two scopes as a conflict issue', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ scope: 'user', state: 'present' }),
          target({ scope: 'project', state: 'partial' }),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([{
      platform: 'codex',
      state: 'scopeConflict',
      placements: [
        { scope: 'project', health: 'incomplete' },
        { scope: 'user', health: 'ready' },
      ],
    }]);
    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ issueId: 'scope:official/demo:codex' }),
    ]));
  });

  it('projects top-level inventory errors once with safe stable details', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({ scope: 'user', state: 'error' })],
        errors: [
          { code: 'legacyStateUnsupported', message: 'legacy at /Users/private/state' },
          { code: 'nativeStateUnreadable', message: 'token=private-token' },
          { code: 'nativeStateUnreadable', message: 'duplicate raw error' },
          { code: 'targetError', message: 'already represented by the target' },
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.issues.map((issue) => issue.issueId)).toEqual([
      'target:official/demo:codex:user:error',
      'status:legacyStateUnsupported',
      'status:nativeStateUnreadable',
    ]);
    expect(JSON.stringify(view.issues)).not.toContain('/Users/private');
    expect(JSON.stringify(view.issues)).not.toContain('private-token');
  });
});

describe('TUI v4 background source checks', () => {
  it('publishes a safe terminal state when the initial status load fails', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockRejectedValue(new Error('nativeStateUnreadable: /private/path')),
    }));

    await expect(controller.load()).resolves.toBeUndefined();

    expect(controller.snapshot).toMatchObject({
      phase: 'error',
      loadError: { code: 'nativeStateUnreadable' },
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/path');
  });

  it('returns the cache-first page before a successful remote check refreshes its data', async () => {
    const remote = deferred<void>();
    const initial = { payload: status(), pluginSummaries: summaries(['official', 'demo']) };
    const refreshed = {
      payload: status({
        sources: [source('official', { freshness: 'remote' })],
        targets: [target({ scope: 'user', state: 'absent' })],
      }),
      pluginSummaries: summaries(['official', 'demo'], ['official', 'new-plugin']),
    };
    const deps = dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(refreshed),
      checkSource: vi.fn(() => remote.promise),
    });
    const controller = new TuiController(deps);

    await controller.load();
    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'checking' });
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual(['official/demo']);

    remote.resolve();
    await nextTurn();
    await nextTurn();
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual([
      'official/demo', 'official/new-plugin',
    ]);
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
  });

  it('keeps cached plugins and creates a degraded issue after remote failure', async () => {
    const controller = new TuiController(dependencies({
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    }));
    await controller.load();
    await nextTurn();

    expect(controller.listPlugins({ mode: 'browse' })).toHaveLength(1);
    expect(controller.snapshot.sourceHealth).toEqual([expect.objectContaining({
      sourceId: 'official',
      state: 'degraded',
    })]);
    expect(controller.listUserIssues()).toEqual([expect.objectContaining({
      issueId: 'source:official:cache',
    })]);
  });

  it('marks a source unavailable when cache-first load had no usable data', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources: [source('official', { error: 'no cache' })] }),
        pluginSummaries: [],
      }),
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    }));
    await controller.load();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual([expect.objectContaining({
      sourceId: 'official',
      state: 'unavailable',
    })]);
    expect(controller.listUserIssues()[0]?.issueId).toBe('source:official:unavailable');
  });

  it('aborts the active source check on dispose and does not publish a late result', async () => {
    let observedSignal: AbortSignal | undefined;
    const checkSource = vi.fn((_sourceId: string, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const controller = new TuiController(dependencies({ checkSource }));
    await controller.load();
    const listener = vi.fn();
    controller.subscribe(listener);
    const callsBeforeDispose = listener.mock.calls.length;

    controller.dispose();
    await nextTurn();

    expect(observedSignal?.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose);
    expect(controller.snapshot.phase).toBe('disposed');
  });

  it('does not let an older failed check overwrite a newer successful refresh', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const checks = [first, second];
    const deps = dependencies({
      checkSource: vi.fn(() => checks.shift()!.promise),
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({
          payload: status({ sources: [source('official', { freshness: 'remote' })] }),
          pluginSummaries: summaries(['official', 'demo']),
        }),
    });
    const controller = new TuiController(deps);
    await controller.load();
    const newer = controller.refreshSource('official');
    second.resolve();
    await newer;
    first.reject(new Error('old remote failure'));
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
  });

  it('does not let an older full reload for another source overwrite newer status', async () => {
    const older = deferred<TuiStatusLoadResult>();
    const newer = deferred<TuiStatusLoadResult>();
    const initial = {
      payload: status({ sources: [
        source('alpha', { type: 'path', freshness: 'path', primary: true }),
        source('beta', { type: 'path', freshness: 'path', primary: false }),
      ] }),
      pluginSummaries: summaries(['alpha', 'old']),
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockImplementationOnce(() => older.promise)
        .mockImplementationOnce(() => newer.promise),
    }));
    await controller.load();

    const alpha = controller.refreshSource('alpha');
    const beta = controller.refreshSource('beta');
    newer.resolve({ ...initial, pluginSummaries: summaries(['beta', 'newer']) });
    await beta;
    older.resolve({ ...initial, pluginSummaries: summaries(['alpha', 'stale']) });
    await alpha;

    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId)).toEqual([
      'beta/newer',
    ]);
  });

  it('aborts an older generation when the same source is refreshed again', async () => {
    const signals: AbortSignal[] = [];
    const checks: Array<ReturnType<typeof deferred<void>>> = [];
    const checkSource = vi.fn((_sourceId: string, signal: AbortSignal) => {
      signals.push(signal);
      const pending = deferred<void>();
      checks.push(pending);
      signal.addEventListener('abort', () => pending.reject(signal.reason), { once: true });
      return pending.promise;
    });
    const controller = new TuiController(dependencies({ checkSource }));
    await controller.load();

    const newer = controller.refreshSource('official');
    expect(signals[0]?.aborted).toBe(true);
    checks[1]!.resolve();
    await newer;
  });

  it.each([
    ['missing', undefined, 'unavailable'],
    ['error with cache', source('official', { error: 'raw private error' }), 'degraded'],
    ['cache', source('official', { freshness: 'cache' }), 'degraded'],
    ['path', source('official', { freshness: 'path', type: 'path' }), 'path'],
  ] as const)('projects a successful remote reload with %s data as %s', async (_label, refreshed, expected) => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({
          payload: status({ sources: refreshed ? [refreshed] : [] }),
          pluginSummaries: summaries(['official', 'demo']),
        }),
    }));
    await controller.load();
    await nextTurn();
    await nextTurn();

    expect(controller.snapshot.sourceHealth).toEqual([
      expect.objectContaining({ sourceId: 'official', state: expected }),
    ]);
    expect(JSON.stringify(controller.snapshot)).not.toContain('raw private error');
  });
});

describe('TUI v4 Review safety', () => {
  it('performs zero writes and returns to the input page when stale evidence makes the intent illegal', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const executeIntent = vi.fn();
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('targetAlreadyInstalled: new state is not legal'));
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(baseEvidence)
      .mockResolvedValueOnce(changedEvidence)
      .mockResolvedValueOnce(changedEvidence);
    const controller = new TuiController(dependencies({
      captureEvidence,
      executeIntent,
      validateIntent,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const review = await controller.buildOperationReview(intent);

    const result = await controller.executeOperation(review.reviewToken);

    expect(executeIntent).not.toHaveBeenCalled();
    expect(validateIntent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'blocked',
      code: 'targetAlreadyInstalled',
    });
    expect(controller.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('returns a new Review when the locked write reports a typed stale prefix', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:locked-change' };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(changedEvidence),
      executeIntent: vi.fn().mockRejectedValue(
        new Error('operationReviewStale: /Users/private/target token-private'),
      ),
    }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result.state).toBe('stale');
    expect(controller.snapshot.router.depth).toBe(2);
    expect(JSON.stringify(controller.snapshot)).not.toContain('/Users/private');
    expect(JSON.stringify(controller.snapshot)).not.toContain('token-private');
  });

  it('does not expose sensitive config values in Review or controller snapshots', async () => {
    const secret = 'sk-private-review-secret';
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        config: {
          scope: 'user',
          projectLayer: 'shared',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
        },
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });

    const visible = JSON.stringify({ review, snapshot: controller.snapshot });
    expect(visible).not.toContain(secret);
    expect(visible).toContain('已设置 → 将更新');
    expect(visible).not.toContain('/Users/');
  });

  it('passes the canonical plugin identity to the write executor', async () => {
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const controller = new TuiController(dependencies({ executeIntent }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'team-tools/review-gate',
      platform: 'claude',
      scope: 'project',
    });

    await controller.executeOperation(review.reviewToken);

    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'team-tools/review-gate' }),
      baseEvidence,
    );
    expect(controller.snapshot.result).toMatchObject({
      summary: { pluginId: 'team-tools/review-gate', action: 'cleanup' },
    });
  });

  it('keeps only a safe result summary and a fixed typed failure message', async () => {
    const secret = '/Users/private/config.json?token=private-token';
    const succeeded = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({ effective: { token: secret }, path: secret }),
    }));
    const successReview = await succeeded.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });
    await succeeded.executeOperation(successReview.reviewToken);

    const failed = new TuiController(dependencies({
      executeIntent: vi.fn().mockRejectedValue(new Error(`nativeStateUnreadable: ${secret}`)),
    }));
    const failureReview = await failed.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });
    await failed.executeOperation(failureReview.reviewToken);

    expect(succeeded.snapshot.result).toEqual(expect.objectContaining({
      state: 'succeeded',
      summary: { code: 'operationSucceeded', message: '操作已完成。' },
    }));
    expect(failed.snapshot.result).toEqual(expect.objectContaining({
      state: 'blocked',
      code: 'nativeStateUnreadable',
      message: '操作未完成。请重新检查后重试。',
    }));
    expect(JSON.stringify({ success: succeeded.snapshot, failure: failed.snapshot })).not.toContain(secret);
  });

  it('isolates nested router, status, ticket, progress, and result values from caller mutation', async () => {
    const router = new TuiRouter();
    const route = {
      name: 'configFields' as const,
      pluginId: 'official/demo',
      layer: { scope: 'project' as const, projectLayer: 'shared' as const },
    };
    router.push(route);
    route.layer.projectLayer = 'local';
    expect(router.snapshot.current.route).toMatchObject({ layer: { projectLayer: 'shared' } });

    const loaded = {
      payload: status({ sources: [source('official', { type: 'path', freshness: 'path' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    let progressListener: ((value: { messages: string[] }) => void) | undefined;
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
    }), {
      subscribe: (listener) => {
        progressListener = listener;
        return vi.fn();
      },
    } as unknown as RebuildProgressFeed);
    await controller.load();
    loaded.pluginSummaries[0]!.pluginName = 'mutated';
    const messages = ['safe'];
    progressListener?.({ messages });
    messages[0] = 'mutated';
    const intent = {
      kind: 'configSave' as const,
      pluginId: 'official/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
      updates: { mode: 'safe' },
    };
    const review = await controller.buildOperationReview(intent);
    intent.updates.mode = 'mutated';
    await controller.executeOperation(review.reviewToken);
    const snapshot = controller.snapshot;

    expect(controller.listPlugins({ mode: 'browse' })[0]?.displayName).toBe('demo');
    expect(snapshot.progress.messages).toEqual(['safe']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.viewModel?.plugins)).toBe(true);
    expect(controller.dependencies.executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { mode: 'safe' } }),
      baseEvidence,
    );
  });

  it('publishes rebuild progress through the unified snapshot', () => {
    let progressListener: ((value: { current?: { target: string; phase: string }; messages: string[] }) => void) | undefined;
    const progressFeed = {
      subscribe: vi.fn((listener) => {
        progressListener = listener;
        listener({ messages: [] });
        return vi.fn();
      }),
    } as unknown as RebuildProgressFeed;
    const controller = new TuiController(dependencies(), progressFeed);
    progressListener?.({ current: { target: 'demo', phase: '检查当前组件' }, messages: ['开始检查'] });

    expect(controller.snapshot.progress).toEqual({
      current: { target: 'demo', phase: '检查当前组件' },
      messages: ['开始检查'],
    });
  });
});
