import { describe, expect, it, vi } from 'vitest';

import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import type { ExternalDraftState, OperationExecuteResult, TuiController, TuiControllerSnapshot } from '../../src/tui/controller.js';
import { LatestSessionResultHistory, SessionHost } from '../../src/tui/session-host.js';
import type { OperationHistoryStore } from '../../src/tui/operation-history.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => { resolve = settle; }), resolve };
}

function result(state: OperationExecuteResult['state']): OperationExecuteResult {
  if (state === 'succeeded' || state === 'partial') {
    return {
      state,
      operationId: 'operation-1',
      operationKind: 'pluginWrite',
      summary: {
        code: state === 'succeeded' ? 'operationSucceeded' : 'operationPartial',
        message: state,
      },
    };
  }
  if (state === 'stale') {
    return {
      state,
      operationId: 'operation-1',
      operationKind: 'pluginWrite',
      review: {} as never,
    };
  }
  return { state, operationId: 'operation-1', code: 'failed', message: 'failed' };
}

function fakeController(options: {
  write?: boolean;
  draft?: boolean;
  drafts?: ExternalDraftState[];
  wait?: Promise<void>;
} = {}): TuiController & {
  emitResult(value: OperationExecuteResult): void;
  emitDetailResult(value: OperationExecuteResult, pluginId: string): void;
  emitLateResult(value: OperationExecuteResult): void;
  setWrite(value: boolean): void;
  setDraft(value: boolean): void;
  reportDrafts(value: ExternalDraftState[]): void;
  dispose: ReturnType<typeof vi.fn>;
  goHome: ReturnType<typeof vi.fn>;
  beginRetirement: ReturnType<typeof vi.fn>;
  waitForWrites: ReturnType<typeof vi.fn>;
  attachOperationHistory: ReturnType<typeof vi.fn>;
} {
  let listener: ((snapshot: TuiControllerSnapshot) => void) | undefined;
  let subscribedListener: ((snapshot: TuiControllerSnapshot) => void) | undefined;
  const base = {
    phase: 'ready',
    router: { current: { route: { name: 'home' }, context: {} }, currentFrameId: 'frame-1', depth: 1 },
    sourceHealth: [], catalogGenerations: [], catalogFreshness: [], reloadRequiredSourceIds: [],
    progress: { messages: [] }, progressTargets: [],
  } as TuiControllerSnapshot;
  let activeWrite = options.write ?? false;
  let sessionDraft = options.draft ?? false;
  let drafts = structuredClone(options.drafts ?? []);
  let latestSnapshot = base;
  const controller = {
    snapshot: base,
    get hasActiveWrite() { return activeWrite; },
    get hasSessionDraft() { return sessionDraft || drafts.length > 0; },
    get externalDrafts() { return structuredClone(drafts); },
    setWrite(value: boolean) { activeWrite = value; },
    setDraft(value: boolean) { sessionDraft = value; },
    reportDrafts(value: ExternalDraftState[]) {
      drafts = structuredClone(value);
      listener?.(latestSnapshot);
    },
    subscribe: vi.fn((next: (snapshot: TuiControllerSnapshot) => void) => {
      listener = next;
      subscribedListener = next;
      next(base);
      return () => { listener = undefined; };
    }),
    cancelAndWaitForReads: vi.fn(async () => {
      await options.wait;
      return true;
    }),
    beginRetirement: vi.fn(),
    waitForWrites: vi.fn().mockResolvedValue(undefined),
    attachOperationHistory: vi.fn((_history: OperationHistoryStore, _epoch: number) => undefined),
    goHome: vi.fn(() => true),
    dispose: vi.fn(),
    emitResult(value: OperationExecuteResult) {
      latestSnapshot = {
        ...base,
        router: {
          current: { route: { name: 'result', operationId: value.operationId }, context: {} },
          currentFrameId: 'frame-2', depth: 1,
        },
        result: value,
      };
      listener?.(latestSnapshot);
    },
    emitDetailResult(value: OperationExecuteResult, pluginId: string) {
      latestSnapshot = {
        ...base,
        router: {
          current: { route: { name: 'pluginDetail', pluginId }, context: {} },
          currentFrameId: 'frame-2', depth: 2,
        },
        result: value,
        completionNotice: {
          pluginId,
          title: '插件安装完成',
          description: '状态已重新检查。',
          operationRecordId: value.operationRecordId,
        },
      };
      listener?.(latestSnapshot);
    },
    emitLateResult(value: OperationExecuteResult) {
      subscribedListener?.({
        ...base,
        router: {
          current: { route: { name: 'result', operationId: value.operationId }, context: {} },
          currentFrameId: 'frame-2', depth: 1,
        },
        result: value,
      });
    },
  };
  return controller as unknown as ReturnType<typeof fakeController>;
}

function session(controller: TuiController) {
  return { controller, progressFeed: createRebuildProgressFeed() };
}

describe('TUI session host', () => {
  it('keeps the same project reminder signature claimed across a reload', async () => {
    const first = fakeController();
    const second = fakeController();
    const createSession = vi.fn()
      .mockReturnValueOnce(session(first))
      .mockReturnValueOnce(session(second));
    const host = new SessionHost({ createSession });

    expect(host.claimProjectIntentReminder('/workspace', 'sha256:first')).toBe(true);
    expect(host.claimProjectIntentReminder('/workspace', 'sha256:first')).toBe(false);
    await expect(host.requestNavigation('reload')).resolves.toBe('completed');
    expect(host.claimProjectIntentReminder('/workspace', 'sha256:first')).toBe(false);
    expect(host.claimProjectIntentReminder('/workspace', 'sha256:changed')).toBe(true);
  });

  it('waits for old reads before replacing the controller and increments the epoch', async () => {
    const wait = deferred<void>();
    const first = fakeController({ wait: wait.promise });
    const second = fakeController();
    const createSession = vi.fn()
      .mockReturnValueOnce(session(first))
      .mockReturnValueOnce(session(second));
    const host = new SessionHost({ createSession });

    const reload = host.requestNavigation('reload');
    await Promise.resolve();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(host.snapshot.reloading).toBe(true);

    wait.resolve();
    await expect(reload).resolves.toBe('completed');
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(host.snapshot).toMatchObject({ epoch: 2, controller: second, reloading: false });
    expect(first.attachOperationHistory).toHaveBeenCalledWith(host.history, 1);
    expect(second.attachOperationHistory).toHaveBeenCalledWith(host.history, 2);

    second.setWrite(true);
    await host.requestNavigation('home');
    first.emitLateResult(result('partial'));
    expect(host.snapshot.pendingNavigation).toBe('home');
  });

  it('keeps one last-wins pending navigation and records success before reloading', async () => {
    const first = fakeController({ write: true });
    const second = fakeController();
    const history = new LatestSessionResultHistory();
    const createSession = vi.fn()
      .mockReturnValueOnce(session(first))
      .mockReturnValueOnce(session(second));
    const host = new SessionHost({ createSession, history });

    await expect(host.requestNavigation('home')).resolves.toBe('pending');
    await expect(host.requestNavigation('reload')).resolves.toBe('pending');
    expect(host.snapshot.pendingNavigation).toBe('reload');
    first.setWrite(false);
    first.emitResult(result('succeeded'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(history.latestResult).toMatchObject({ epoch: 1, result: { state: 'succeeded' } });
    expect(host.snapshot.epoch).toBe(2);
  });

  it('consumes pending home after a single-plugin success returns to detail', async () => {
    const first = fakeController({ write: true });
    const host = new SessionHost({ createSession: () => session(first) });
    await expect(host.requestNavigation('home')).resolves.toBe('pending');
    first.setWrite(false);
    first.emitDetailResult({ ...result('succeeded'), operationRecordId: '1:operation-1' }, 'official/demo');

    expect(first.goHome).toHaveBeenCalledOnce();
    expect(host.snapshot.pendingNavigation).toBeUndefined();
  });

  it.each(['partial', 'stale', 'blocked'] as const)(
    'clears pending navigation and stays on a %s result',
    async (state) => {
      const first = fakeController({ write: true });
      const createSession = vi.fn(() => session(first));
      const host = new SessionHost({ createSession });
      await host.requestNavigation('home');
      first.setWrite(false);
      first.emitResult(result(state));

      expect(host.snapshot.pendingNavigation).toBeUndefined();
      expect(first.goHome).not.toHaveBeenCalled();
      expect(createSession).toHaveBeenCalledOnce();
    },
  );

  it('keeps drafts by default and lets Esc clear only pending navigation', async () => {
    const draft = fakeController({ draft: true });
    const host = new SessionHost({ createSession: () => session(draft) });
    await expect(host.requestNavigation('home')).resolves.toBe('draftBlocked');
    expect(draft.goHome).not.toHaveBeenCalled();

    draft.setDraft(false);
    draft.setWrite(true);
    await host.requestNavigation('reload');
    expect(host.cancelPendingNavigation()).toBe(true);
    expect(host.snapshot.pendingNavigation).toBeUndefined();
    expect(draft.dispose).not.toHaveBeenCalled();
  });

  it('waits for consumed draft cleanup and guards a remaining parent draft', async () => {
    const parent = { kind: 'configDraft', owner: 'plugin\0user', flowId: 'flow-1', revision: 3 } as const;
    const child = { kind: 'sourceDraft', owner: 'source-repair', flowId: 'flow-2', revision: 1 } as const;
    const first = fakeController({ write: true, drafts: [parent, child] });
    const host = new SessionHost({ createSession: () => session(first) });

    await expect(host.requestNavigation('home')).resolves.toBe('pending');
    first.setWrite(false);
    first.emitResult({ ...result('succeeded'), operationKind: 'catalogGeneration' });
    expect(first.goHome).not.toHaveBeenCalled();

    first.reportDrafts([parent]);
    expect(host.snapshot).toMatchObject({
      pendingNavigation: 'home',
      pendingNavigationDrafts: [parent],
    });
    expect(first.goHome).not.toHaveBeenCalled();

    await expect(host.requestNavigation('home', {
      discardDrafts: true,
      draftConfirmation: [parent],
    })).resolves.toBe('completed');
    expect(first.goHome).toHaveBeenCalledWith(expect.objectContaining({ discardDrafts: true }));
  });

  it('rejects a discard confirmation after its owner revision changes', async () => {
    const firstDraft = { kind: 'configDraft', owner: 'plugin\0user', flowId: 'flow-1', revision: 1 } as const;
    const changedDraft = { ...firstDraft, revision: 2 };
    const controller = fakeController({ drafts: [firstDraft] });
    const host = new SessionHost({ createSession: () => session(controller) });

    await expect(host.requestNavigation('reload')).resolves.toBe('draftBlocked');
    controller.reportDrafts([changedDraft]);
    await expect(host.requestNavigation('reload', {
      discardDrafts: true,
      draftConfirmation: [firstDraft],
    })).resolves.toBe('draftBlocked');
    expect(controller.beginRetirement).not.toHaveBeenCalled();
  });

  it('waits for writes and read cleanup before normal shutdown disposes ownership', async () => {
    const write = deferred<void>();
    const reads = deferred<void>();
    const controller = fakeController({ wait: reads.promise });
    controller.waitForWrites.mockImplementation(() => write.promise);
    const host = new SessionHost({ createSession: () => session(controller) });

    const shutdown = host.shutdown();
    await Promise.resolve();
    expect(controller.beginRetirement).toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();

    write.resolve();
    await Promise.resolve();
    expect(controller.cancelAndWaitForReads).toHaveBeenCalled();
    expect(controller.dispose).not.toHaveBeenCalled();

    reads.resolve();
    await shutdown;
    expect(controller.dispose).toHaveBeenCalledOnce();
  });
});
