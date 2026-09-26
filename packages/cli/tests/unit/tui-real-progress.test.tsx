import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  executeRebuildOperation,
  type DesiredTarget,
  type RebuildActiveStore,
  type RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  emitCommandNotice,
  withCommandReporterSession,
} from '../../src/commands/runtime.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type TuiControllerSnapshot,
} from '../../src/tui/controller.js';
import type { PluginMeta } from '../../src/types.js';

afterEach(() => cleanup());

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn();
  }
}

class ProgressControllerStub {
  listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();

  constructor(readonly value: TuiControllerSnapshot) {}

  get snapshot(): TuiControllerSnapshot { return this.value; }
  get externalDrafts(): [] { return []; }
  subscribe(listener: (snapshot: TuiControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  getPluginOverview(): { displayName: string } { return { displayName: '进度插件' }; }
  listPluginWriteTaskCandidates(): [] { return []; }
  listUserIssues(): [] { return []; }
  listPlugins(): [] { return []; }
  listSources(): [] { return []; }
  setExternalDraftState(): void {}
  updatePageContext(): void {}
}

describe('real ConsoleAppV4 progress chain', () => {
  it.each([
    ['install', undefined, '正在添加'],
    ['refreshAndSync', undefined, '正在更新'],
    ['reinstall', undefined, '正在恢复'],
    ['uninstall', undefined, '正在移除'],
    ['cleanup', undefined, '正在清理'],
    [undefined, 'update', '正在更新'],
    [undefined, 'restore', '正在恢复'],
    [undefined, undefined, '正在应用设置', true],
  ] as const)('shows the user action for running targets: %s/%s', async (
    pluginAction,
    taskGoal,
    expected,
    configApply = false,
  ) => {
    const operationKind = configApply ? 'configSave' as const
      : taskGoal ? 'pluginWriteTask' as const : 'pluginWrite' as const;
    const snapshot = {
      phase: 'ready',
      router: {
        current: { route: { name: 'progress', operationId: 'operation-1' }, context: {} },
        currentFrameId: 'test',
        depth: 2,
      },
      sourceHealth: [],
      catalogGenerations: [],
      catalogFreshness: [],
      reloadRequiredSourceIds: [],
      operationHistorySummaries: [],
      progress: {
        messages: ['目标正在处理'],
        startedAtMs: Date.now(),
        current: { target: 'official/progress', phase: '写入平台插件' },
      },
      progressTargets: [{
        pluginId: 'official/progress', platform: 'codex', scope: 'user',
        relation: 'requested', requiredBy: [], state: 'running',
      }],
      activeReview: {
        operationId: 'operation-1', reviewToken: 'review-1', expiresAt: Date.now() + 60_000,
        operationKind, pluginAction, taskGoal,
        title: '测试进度', description: '测试用户动作',
        subject: { name: '进度插件' },
        changes: configApply ? [{ kind: 'change', group: 'configImpact', title: '应用设置' }] : [],
        primaryLabel: '开始',
        requiresConfirmation: false, sharedImpact: { pluginIds: [] },
      },
      viewModel: { plugins: [], dependencyOverviews: [] },
    } as unknown as TuiControllerSnapshot;
    const controller = new ProgressControllerStub(snapshot);
    const instance = render(<ConsoleAppV4
      controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }}
    />);
    await input(instance, '');

    expect(instance.lastFrame()).toContain(expected);
    if (expected !== '正在添加') expect(instance.lastFrame()).not.toContain('正在添加');
    expect(instance.lastFrame()).not.toContain('执行依赖闭包');
    expect(instance.lastFrame()).toContain('所选插件和所需插件');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('renders real rebuild events, reloads status, and restores the reporter session', async () => {
    const plugin: PluginMeta = {
      rootDir: '/fixture/plugin',
      manifestPath: '/fixture/plugin/.agents-plugin/plugin.json',
      manifest: {
        name: 'real-progress',
        version: '1.0.0',
        description: 'real V4 progress fixture',
        schemaVersion: 3,
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    const desired: DesiredTarget = {
      plugin,
      preApplySource: plugin,
      identity: {
        pluginName: plugin.manifest.name,
        pluginVersion: plugin.manifest.version,
        platform: 'codex',
        scope: 'user',
        cwd: '/workspace',
      },
      ownedComponents: [{
        kind: 'native-plugin',
        identity: {
          owner: 'agent-workflows',
          plugin: plugin.manifest.name,
          artifactKey: 'native-codex-user',
          platform: 'codex',
          scope: 'user',
        },
        pluginId: 'real-progress@aw',
      }],
      requiresNative: true,
      artifacts: [],
    };
    let live: 'absent' | 'present' = 'absent';
    const driver: RebuildTargetDriver = {
      probeNative: async () => live,
      removeNative: async () => { live = 'absent'; },
      writeNative: async () => { await nextTurn(); live = 'present'; },
      writeArtifacts: async () => undefined,
      runPreApply: async () => undefined,
    };
    const activeStore: RebuildActiveStore = {
      prepare: async () => ({}) as never,
      discard: async () => undefined,
      promote: async () => ({}) as never,
      read: async () => null,
      remove: async () => undefined,
    };
    const progress = createRebuildProgressFeed();
    const stdout = vi.fn();
    const context = createCliExecutionContext({ cwd: '/workspace', io: { stdout } });
    const status = () => ({
      payload: {
        schemaVersion: 8 as const,
        catalog: {
          primarySourceId: 'official',
          configDigest: 'sha256:config',
          compositeDigest: 'sha256:composite',
          sources: [{ id: 'official', identity: 'identity:official', type: 'path' as const, primary: true, requestedRef: 'path', freshness: 'active' as const }],
        },
        filters: { plugins: [], platform: 'both' as const, cwd: '/workspace' },
        targets: [{
          pluginName: 'real-progress',
          pluginId: 'official/real-progress',
          sourceId: 'official',
          sourceIdentity: 'identity:official',
          version: '1.0.0',
          platform: 'codex' as const,
          cwd: '/workspace',
          state: live === 'present' ? 'ready' as const : 'absent' as const,
          components: [], reasons: [], recoveryActions: [],
          placements: [{
            scope: 'user' as const,
            state: live === 'present' ? 'ready' as const : 'absent' as const,
            components: [{ kind: 'ownership' as const, key: 'fixture', state: live }],
            reasons: [], recoveryActions: [],
          }],
        }],
        errors: [],
      },
      pluginSummaries: [{
        pluginName: 'real-progress',
        pluginId: 'official/real-progress',
        description: 'real V4 progress fixture',
        supportedTargets: { codex: ['user' as const], claude: [] },
      }],
    });
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      source: { sourceId: 'official', sourceIdentity: 'identity:official', snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content' },
      targetFingerprint: 'sha256:target',
    };
    const controller = new TuiController({
      loadStatus: vi.fn(async () => status()),
      checkSource: vi.fn(),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn(async () => {
        const result = await executeRebuildOperation({
          command: 'install',
          target: desired,
          driver,
          activeStore,
          onActionEvent: (event) => emitCommandEvent(context, event),
        });
        return {
          overallState: result.status,
          targetResults: [{
            target: { platform: 'codex', scope: 'user' },
            state: result.status === 'succeeded' ? 'completed' : 'failed',
          }],
        };
      }),
    }, progress);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/real-progress',
      platform: 'codex',
      scope: 'user',
    });

    let frames = '';
    await withCommandReporterSession(context.reporter, {
      event: (event) => progress.addEvent(event),
      notice: (notice) => progress.addNotice(notice),
    }, async () => {
      const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
      await nextTurn();
      expect(instance.lastFrame()).toContain(`› ${review.primaryLabel}`);
      await input(instance, '\r');
      await vi.waitUntil(() => controller.snapshot.result?.state === 'succeeded', { timeout: 1_000 });
      await nextTurn();
      frames = instance.frames.join('\n');
      instance.unmount();
    });

    expect(frames).toContain('写入平台插件');
    expect(frames).toContain('状态已重新检查');
    expect(frames).toMatch(/Codex\s+\[所有项目\].*\[✓ 可用\]/u);
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/real-progress',
    });
    expect(live).toBe('present');
    expect(controller.listUserIssues()).toEqual([]);
    await emitCommandNotice(context, { level: 'notice', message: 'reporter restored' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('reporter restored'));
  });
});
