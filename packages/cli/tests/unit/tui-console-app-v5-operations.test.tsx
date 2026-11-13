import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import { type ScopedTaskRequest, scopedPlan, scopedTarget, scopedReceipt } from '../helpers/tui-console-app-fixture.js';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DependencyOperationPlan,
} from '../../src/commands/dependency-operation-plan.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationEvidence, type OperationIntent, type PluginWriteTaskEvidence, type TuiControllerDependencies } from '../../src/tui/controller.js';
import { operationDiagnosticText } from '../../src/tui/operation-diagnostic-screens.js';
import { readerPage } from '../../src/tui/reader.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import { controller, deferred, dependencyLoadResult, dependencyPlan, evidence, loadResult, placementPlanFor, platformLoadResult, pluginWriteTaskEvidence, pluginWriteTaskExecution, target, updatePlacement } from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  confirmReview,
  escape,
  focusAction,
  input,
  nextTurn,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

async function readScopedDetails(instance: ReturnType<typeof render>): Promise<string> {
  await input(instance, 'd');
  const frames: string[] = [];
  for (let page = 0; page < 40; page += 1) {
    const frame = instance.lastFrame() ?? '';
    if (frames.at(-1) === frame) {
      await input(instance, 'd');
      return frames.join('\n');
    }
    frames.push(frame);
    const pager = frame.match(/(\d+)\s*\/\s*(\d+)/u);
    if (pager && pager[1] === pager[2]) {
      await input(instance, 'd');
      return frames.join('\n');
    }
    await input(instance, '\u001B[C');
  }
  throw new Error('The scoped details did not reach the last page.');
}

describe('ConsoleAppV4', () => {
  it('shows machine targets and confirms only the Intent scope before install', async () => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ prepareScopedTask });
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await focusAction(instance, '添加插件…');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('选择使用范围');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    expect(instance.lastFrame()).toContain('■ 所有项目');
    expect(instance.lastFrame()).toContain('■ 当前项目');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await input(instance, ' ');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith({
      kind: 'recovery', command: 'install', scope: 'project', selectors: ['official/agent-lab'],
    }, expect.any(AbortSignal));
  });

  it('keeps accepted Progress non-cancellable by Esc', async () => {
    const execution = deferred<unknown>();
    const value = controller({ executeIntent: vi.fn(() => execution.promise) });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);

    expect(value.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    expect(instance.lastFrame()).toContain('Ctrl-C 完成后退出');
    execution.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(3);
  });

  it('renders a safe failed preparation with focused retry and Back actions', async () => {
    const validateIntent = vi.fn()
      .mockRejectedValueOnce(new Error('/Users/private/raw failure'))
      .mockResolvedValueOnce(undefined);
    const value = controller({ validateIntent });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.startReviewPreparation({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('无法准备确认信息');
    expect(frame).not.toContain('reviewPreparationFailed');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('reviewPreparationFailed');
    await input(instance, 'd');
    expect(frame).toContain('› 重试');
    expect(frame).toContain('返回修改');
    expect(frame).not.toContain('/Users/private/raw failure');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(validateIntent).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['all projects', [] as string[], 'user'],
    ['current project', ['\u001B[B'], 'project'],
  ] as const)('uses the same machine targets for %s', async (_label, keys, selectedScope) => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ prepareScopedTask });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'c');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    await input(instance, ...keys, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith({ kind: 'recovery', command: 'install',
      scope: selectedScope, selectors: ['official/agent-lab'] }, expect.any(AbortSignal));
  });

  it('keeps the configured Agents visible while the backend checks compatibility', async () => {
    const loaded = dependencyLoadResult();
    loaded.projectRoot = '/workspace';
    loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/skill-toolkit')!
      .supportedTargets = { codex: [], claude: ['user', 'project'] };
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('◆ Codex');
    expect(frame).toContain('◆ Claude Code');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledOnce());
    expect(prepareScopedTask.mock.calls[0]![0]).not.toHaveProperty('exactTargets');
  });

  it('keeps a failed install preparation safe and leaves execution unstarted', async () => {
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('unsupportedTarget:/private/secret'));
    const executeScopedTask = vi.fn();
    const value = controller({ prepareScopedTask, executeScopedTask });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('当前无法完成，请查看详情'));
    expect(instance.lastFrame()).not.toContain('/private/secret');
    expect(instance.lastFrame()).toContain('返回插件列表');
    expect(executeScopedTask).not.toHaveBeenCalled();
    const details = await readScopedDetails(instance);
    expect(details).toContain('recoveryPreparationFailed');
    expect(details).not.toContain('/private/secret');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('recoveryPreparationFailed');
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it('shows bounded scope choices for the configured Agents at both terminal sizes', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(4);
      const frame = instance.lastFrame() ?? '';
      expect(frame.indexOf('所有项目')).toBeLessThan(frame.indexOf('当前项目'));
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      await input(instance, '\u001B[B', '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(value.dependencies.prepareScopedTask).toHaveBeenCalledWith({
        kind: 'recovery', command: 'install', scope: 'project', selectors: ['official/agent-lab'],
      }, expect.any(AbortSignal));
      instance.unmount();
    }
  });

  it.each([
    ['succeeded', {
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    }],
    ['partial', {
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
      ],
    }],
    ['blocked', new Error('writeRejected')],
  ] as const)('returns from a mounted %s Result without exposing Progress or a fallback page', async (state, execution) => {
    const value = controller({
      executeIntent: execution instanceof Error
        ? vi.fn().mockRejectedValue(execution)
        : vi.fn().mockResolvedValue(execution),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team-tools/review-gate', platform: 'both', scope: 'user',
    });
    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({ state });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    if (state === 'succeeded') {
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId: 'team-tools/review-gate',
      });
      expect(value.snapshot.completionNotice).toBeDefined();
      await input(instance, 'b');
      expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
      expect(value.snapshot.result).toBeDefined();
    } else {
      await input(instance, 'b');
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId: 'team-tools/review-gate',
      });
      expect(instance.lastFrame()).not.toContain('后续阶段');
      expect(instance.lastFrame()).not.toContain('正在执行');
      await input(instance, 'b');
      expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
      expect(value.snapshot.result).toBeUndefined();
    }
  });

  it('marks a failed target and current operation step as error instead of active', async () => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const plan = dependencyPlan();
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const running = value.executeOperation(review.reviewToken);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'agent-lab', platform: 'codex', scope: 'project', action: 'install' },
      data: { name: 'postcheck.inspect', phase: 'failure', message: 'safe failure' },
    });
    await nextTurn(2);
    expect(screens).toContain('D06');
    expect(instance.lastFrame()).toContain('× 添加所选插件和所需插件');
    expect(instance.lastFrame()).toContain('× 验证完整结果');
    expect(instance.lastFrame()).not.toContain('● 验证完整结果');
    expect(instance.lastFrame()).toContain('× Agent Lab');
    expect(instance.lastFrame()).toContain('另有 2 个目标');
    expect(instance.lastFrame()).toContain('d 技术进度');
    execution.resolve({ overallState: 'partial', targetResults: [
      { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed' },
    ] });
    await running;
  });

  it('grows a large dependency progress target viewport from 60x18 through 80x40 without clipping', async () => {
    const execution = deferred<unknown>();
    const loaded = dependencyLoadResult();
    const targetIds = Array.from({ length: 12 }, (_, index) =>
      index === 11 ? 'official/agent-lab' : `official/progress-target-${index + 1}`);
    loaded.pluginSummaries.push(...targetIds.slice(0, -1).map((pluginId, index) => ({
      pluginName: pluginId.split('/')[1]!,
      pluginId,
      displayName: `Progress Target ${index + 1}`,
      description: `Dependency ${index + 1}`,
      supportedTargets: { codex: ['user' as const], claude: [] },
      configFieldCount: 0,
    })));
    loaded.payload.targets.push(...targetIds.slice(0, -1).map((pluginId) => target({
      pluginName: pluginId.split('/')[1]!,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    })));
    const plan: DependencyOperationPlan = {
      dependencyPlanSchemaVersion: 1,
      requestedPluginIds: ['official/agent-lab'],
      resolvedPluginIds: targetIds,
      dependencyEdges: targetIds.slice(0, -1).map((pluginId) => ({ from: 'official/agent-lab', to: pluginId })),
      targets: targetIds.map((pluginId, index) => ({
        pluginId,
        pluginName: pluginId.split('/')[1]!,
        platform: 'codex' as const,
        requestedScope: 'user' as const,
        resolvedScope: 'user' as const,
        relation: index === targetIds.length - 1 ? 'requested' as const : 'dependency' as const,
        requiredBy: index === targetIds.length - 1 ? [] : ['official/agent-lab'],
        state: 'absent' as const,
        action: 'install' as const,
        order: index + 1,
      })),
    };
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const running = value.executeOperation(review.reviewToken);
    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/Progress Target \d+/gu)?.length ?? 0);
      expect(frame).toContain('执行目标');
      expect(frame).toContain('? 帮助');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    execution.resolve({ targetResults: [] });
    await running;
  });

  it('renders multiple saved result messages with standard and compact viewport budgets', async () => {
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      executeIntent: vi.fn(async () => {
        for (let index = 1; index <= 10; index += 1) {
          progress.addNotice({ level: 'notice', identity: `message-${index}`, message: `safe ${index}` });
        }
        return {
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        };
      }),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'team-tools/review-gate', scope: 'user', apply: false, updates: { mode: 'safe' },
    });
    await value.executeOperation(review.reviewToken);

    const standard = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const standardFrame = standard.lastFrame() ?? '';
    expect(standardFrame.match(/收到通知/g)).toHaveLength(4);
    expect(standardFrame).not.toContain('返回插件详情');
    expect(standardFrame).not.toContain('返回首页');
    standard.unmount();

    const compact = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const compactFrame = compact.lastFrame() ?? '';
    expect(compactFrame.match(/收到通知/g)).toHaveLength(2);
    expect(compactFrame).not.toContain('返回插件详情');
    expect(compactFrame).not.toContain('返回首页');
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('bounds many Result targets and keeps the last page with HelpBar at 60x18', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        warnings: ['需要复查。'],
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/target-${index}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('1 / 6');
    expect(instance.lastFrame()).toContain('12 个目标');
    expect(instance.lastFrame()).not.toContain('变更：undefined');
    let targetPages = instance.lastFrame() ?? '';
    for (let page = 0; page < 15; page += 1) {
      await input(instance, '\u001B[C');
      targetPages += instance.lastFrame() ?? '';
    }
    expect(instance.lastFrame()).toContain('target-11');
    for (let index = 0; index < 12; index += 1) {
      expect(targetPages).toContain(`target-${index}`);
    }
    expect(instance.lastFrame()).toContain('6 / 6');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).not.toContain('返回首页');
    expect(instance.lastFrame()).toContain('←→ 翻页');
    expect(instance.lastFrame()).toContain('[y] 复制全文');
    expect(instance.lastFrame()?.match(/›/gu)).toBeNull();
  });

  it('grows a large dependency result target viewport with available terminal rows', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        warnings: ['需要复查。'],
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/result-target-${index + 1}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);

    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/result-target-\d+/gu)?.length ?? 0);
      if (size.rows <= 24) {
        const firstPage = frame.match(/← 上一页\s+(\d+) \/ (\d+)/u);
        expect(firstPage?.[1]).toBe('1');
        expect(Number(firstPage?.[2])).toBe(Math.ceil(12 / visibleCounts.at(-1)!));
        let last = frame;
        for (let page = 1; page < Number(firstPage?.[2]); page += 1) {
          await input(instance, '\u001B[C');
          last = instance.lastFrame() ?? '';
        }
        expect(last).toContain(`result-target-12`);
        expect(last).toContain(`${firstPage?.[2]} / ${firstPage?.[2]}`);
        await writeAcceptanceTrace(`reader/result-targets-${size.columns}x${size.rows}`, [
          { label: '第一页', size, inputs: [], frame },
          { label: '末页', size, inputs: ['ArrowRight'], frame: last },
        ]);
      }
      await input(instance, '\u001B[B');
      expect(instance.lastFrame()).not.toContain('返回首页');
      expect(instance.lastFrame()).toContain('[y] 复制全文');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(12);
  });

  it('ignores a second Enter after the Review primary action becomes busy', async () => {
    const execution = deferred<unknown>();
    const executeIntent = vi.fn(() => execution.promise);
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent,
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    instance.stdin.write('\r');
    instance.stdin.write('\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');
    expect(instance.lastFrame()).not.toContain('reviewTicketInvalid');
    expect(executeIntent).toHaveBeenCalledTimes(1);
    execution.resolve({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(value.snapshot.result).toMatchObject({
      state: 'succeeded', operationId: review.operationId,
    });
  });

  it('retries only the failed target with the canonical plugin identity', async () => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
      const receipt = (plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt;
      return { kind: 'recovery' as const, receipt: { ...receipt, ok: false,
        targetResults: [
          scopedTarget('official/agent-lab', 'codex', 'applied', 'verified'),
          scopedTarget('official/agent-lab', 'claude', 'failed', 'missing'),
        ],
        remainingTargets: [{ pluginId: 'official/agent-lab', agent: 'claude' as const,
          scope: 'user' as const, delivery: { kind: 'native' as const, platform: 'claude' as const } }],
      } };
    });
    const value = controller({
      prepareScopedTask, executeScopedTask,
    });
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await focusAction(instance, '添加插件…');
    await input(instance, '\r', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '重试明确失败项（1）');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'user', selectors: ['official/agent-lab'],
      exactTargets: [{ pluginId: 'official/agent-lab', agent: 'claude', scope: 'user' }],
    }), expect.any(AbortSignal));
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
  });

  it.each(['install', 'refreshAndSync'] as const)(
    'retries a reloaded partial target with reinstall after a failed %s',
    async (originalAction) => {
      const before = loadResult();
      const after = loadResult();
      if (originalAction === 'refreshAndSync') {
        for (const loaded of [before, after]) {
          for (const entry of loaded.payload.targets.filter((target) =>
            target.pluginId === 'official/agent-lab'
            && (target.platform === 'codex' || target.scope === 'user'))) {
            updatePlacement(entry, 'user', { state: 'ready', components: [
              { kind: 'ownership', key: 'fixture', state: 'present' },
            ] });
          }
        }
      }
      const targetAfterReload = after.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'claude'
        && entry.scope === 'user');
      if (targetAfterReload) updatePlacement(targetAfterReload, 'user', {
        state: 'needsSync',
        reasons: [{ code: 'missingContent', message: '安全说明', severity: 'warning' }],
      });
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
      const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
        const receipt = (plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt;
        return { kind: 'recovery' as const, receipt: { ...receipt, ok: false,
          targetResults: [
            scopedTarget('official/agent-lab', 'codex', 'applied', 'verified'),
            scopedTarget('official/agent-lab', 'claude', 'failed', 'missing'),
          ],
          remainingTargets: [{ pluginId: 'official/agent-lab', agent: 'claude' as const,
            scope: 'user' as const, delivery: { kind: 'native' as const, platform: 'claude' as const } }],
        } };
      });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
        prepareScopedTask, executeScopedTask,
      });
      await value.load();
      value.push(originalAction === 'install'
        ? { name: 'pluginDetail', pluginId: 'official/agent-lab' }
        : { name: 'pluginList', mode: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(2);
      if (originalAction === 'install') {
        await focusAction(instance, '添加插件…');
        await input(instance, '\r', '\r');
      } else {
        await input(instance, 'm', ' ', 'c');
        await focusAction(instance, '其他维护方式');
        await input(instance, '\r');
        await focusAction(instance, '同步已保存使用设置');
        await input(instance, '\r');
      }
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
      await focusAction(instance, '重试明确失败项（1）');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'recovery', scope: 'user',
        exactTargets: [{ pluginId: 'official/agent-lab', agent: 'claude', scope: 'user' }],
      }), expect.any(AbortSignal));
      instance.unmount();
      instance.cleanup();
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'offers normal cleanup for an exact owned target after a failed uninstall at %ix%i',
    async (columns, rows) => {
      const loaded = loadResult();
      const codex = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex')!;
      updatePlacement(codex, 'user', { state: 'absent', components: [
        { kind: 'ownership', key: 'fixture', state: 'absent' },
      ] });
      const claude = target({ pluginName: 'review-gate', sourceId: 'team-tools',
        platform: 'claude', scope: 'user', state: 'present' });
      loaded.payload.targets = loaded.payload.targets.filter((entry) =>
        entry.pluginId !== 'team-tools/review-gate' || entry.platform === 'codex').concat(claude);
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
      const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
        const receipt = (plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt;
        return { kind: 'recovery' as const, receipt: { ...receipt, ok: false,
          targetResults: [scopedTarget('team-tools/review-gate', 'claude', 'failed', 'unknown')],
          remainingTargets: [{ pluginId: 'team-tools/review-gate', agent: 'claude' as const,
            scope: 'user' as const, delivery: { kind: 'native' as const, platform: 'claude' as const } }],
        } };
      });
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded),
        prepareScopedTask, executeScopedTask });
      await value.load();
      value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      await input(instance, 'm', ' ', 'c');
      await focusAction(instance, '卸载所选插件');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
      expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'recovery', command: 'uninstall', scope: 'user',
        exactTargets: [{ pluginId: 'team-tools/review-gate', agent: 'claude' }],
      }), expect.any(AbortSignal));
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
      expect(instance.lastFrame()).toContain('请求仍有未完成目标');
      expect(instance.lastFrame()).not.toContain('强制清理');
      expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);
      await focusAction(instance, '返回插件列表');
      await input(instance, '\r');
      await input(instance, 'm', ' ', 'c');
      await focusAction(instance, '其他维护方式');
      await input(instance, '\r');
      await focusAction(instance, '清理遗留内容');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
      expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'recovery', command: 'cleanup', scope: 'user',
        exactTargets: [{ pluginId: 'team-tools/review-gate', agent: 'claude' }],
      }), expect.any(AbortSignal));
    },
  );

  it('shows a new review after the locked executor reports stale evidence before business writes', async () => {
    const changed = { ...evidence, targetFingerprint: 'sha256:changed' };
    const businessWrite = vi.fn();
    const executeIntent = vi.fn(async (
      _intent: Parameters<TuiControllerDependencies['executeIntent']>[0],
      expected: OperationEvidence,
    ) => {
      if (expected.targetFingerprint !== changed.targetFingerprint) {
        throw new Error('operationReviewStale: locked target evidence changed');
      }
      return businessWrite();
    });
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValue(changed);
    const value = controller({
      captureEvidence,
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({ kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await confirmReview(instance, value);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(businessWrite).not.toHaveBeenCalled();
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('状态已变化');
    expect(instance.lastFrame()).toContain('再次确认');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'hides successful result navigation while Esc and home still work at %ix%i', async (columns, rows) => {
      const navigate = vi.fn().mockResolvedValue('pending');
      const value = controller({
        executeIntent: vi.fn().mockResolvedValue({
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'succeeded', targetResults: [] },
        }),
      });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
      const review = await value.buildOperationReview({
        kind: 'configSave', pluginId: 'team-tools/review-gate', scope: 'user',
        apply: true, updates: { mode: 'safe' },
      });
      await value.executeOperation(review.reviewToken);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }}
        onSessionNavigation={navigate} />);
      await nextTurn(2);
      const result = instance.lastFrame() ?? '';
      expect(result).toContain('设置已保存并应用');
      expect(result).not.toContain('返回插件详情');
      expect(result).not.toContain('返回首页');
      expect(result).not.toContain('查看插件');
      await input(instance, 'h');
      expect(navigate.mock.calls[0]?.[0]).toBe('home');
      await escape(instance);
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId: 'team-tools/review-gate',
      });
    },
  );

  it('keeps every compact Review change and confirmation in one bounded focus viewport', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const value = controller({ executeIntent });
    await value.load();
    await value.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/agent-lab',
      scope: 'user',
            apply: true,
      updates: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field-${index + 1}`, index + 1])),
      changes: Array.from({ length: 9 }, (_, index) => ({
        key: `field-${index + 1}`,
        title: `变更 ${index + 1}`,
        before: '旧值',
        after: '新值',
      })),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('~ 公共配置 · 变更 1');
    expect(instance.lastFrame()).not.toContain('› ~ 公共配置 · 变更 1');
    expect(instance.lastFrame()).toContain('1 / 11');
    expect(instance.lastFrame()).toContain('› 保存并应用');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('summarizes many kept and warning Review rows without clipping actions or HelpBar', async () => {
    const executeIntent = vi.fn();
    const value = controller({ executeIntent });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user', force: true,
    });
    const snapshot = structuredClone(value.snapshot);
    if (!snapshot.activeReview) throw new Error('expected active review');
    snapshot.activeReview.changes = [
      { kind: 'remove', group: 'requested', title: 'Codex · 所有项目', description: '目标安装' },
      ...Array.from({ length: 18 }, (_, index) => ({ kind: 'keep' as const, group: 'preserved' as const, title: `保留项 ${index + 1}`, description: '保持安装' })),
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: 'warning' as const,
        group: 'portableWarnings' as const,
        title: `风险 ${index + 1}`,
        description: index === 11 ? `${'这是不能截断的风险说明。'.repeat(8)}完整结尾标记` : '共同风险原因',
      })),
    ];
    snapshot.activeReview.requiresConfirmation = true;
    snapshot.activeReview.sharedImpact = {
      pluginIds: ['team-tools/review-gate'],
      warning: '被共用的内容需要明确确认。',
    };
    Object.defineProperty(value, 'snapshot', { configurable: true, get: () => snapshot });
    const compactSize = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={value} size={compactSize} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('1 / 31');
    expect(frame).toContain(`› ${review.primaryLabel}`);
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(snapshot.activeReview.requiresConfirmation).toBe(true);
    trace.push(acceptanceTraceStep(instance, compactSize, '操作汇总核心风险', []));
    let reviewFrames = frame;
    for (let index = 0; index < 50; index += 1) {
      const page = (instance.lastFrame() ?? '').match(/← 上一页\s+(\d+) \/ (\d+)/u);
      expect(page).toBeTruthy();
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[C');
      reviewFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(reviewFrames).toContain('共同风险原因');
    expect(reviewFrames).toContain('保留项 18');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(executeIntent).not.toHaveBeenCalled();
    await focusAction(instance, review.primaryLabel);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('独立授权');
    let riskFrames = instance.lastFrame() ?? '';
    for (let index = 0; index < 50; index += 1) {
      const page = (instance.lastFrame() ?? '').match(/← 上一页\s+(\d+) \/ (\d+)/u);
      expect(page).toBeTruthy();
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[C');
      expect(executeIntent).not.toHaveBeenCalled();
      riskFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(riskFrames).toContain('风险 1');
    expect(riskFrames).toContain('风险 12');
    expect(riskFrames).toContain('完整结尾标记');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    trace.push(acceptanceTraceStep(instance, compactSize, '风险说明完整结尾', ['Enter', 'ArrowRight']));
    await writeAcceptanceTrace('review/user-fields/paged-technical', trace);
  });

  it.each([[60, 18], [80, 24]] as const)('pages unequal technical Review collections at %ix%i', async (columns, rows) => {
    const value = controller();
    await value.load();
    await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/agent-lab', scope: 'user',
      apply: false, updates: { enabled: true },
      changes: [{ key: 'enabled', title: '设置', before: '关闭', after: '开启' }],
    });
    const snapshot = structuredClone(value.snapshot);
    if (!snapshot.activeReview) throw new Error('expected active review');
    snapshot.activeReview.changes = Array.from({ length: 18 }, (_, index) => ({
      kind: 'change' as const, title: `技术变更 ${index + 1}`, description: '已确认',
    }));
    snapshot.activeReview.technicalDetails = ['唯一技术字段'];
    Object.defineProperty(value, 'snapshot', { configurable: true, get: () => snapshot });
    const size = { columns, rows };
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(2);
    await input(instance, 'd');
    const frames: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const current = acceptanceTraceStep(instance, size, `技术页 ${index}`, []);
      frames.push(current.frame);
      const page = current.frame.match(/← 上一页\s+(\d+) \/ (\d+)/u);
      expect(page).toBeTruthy();
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[C');
    }
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.join('\n')).toContain('技术变更 18');
    expect(frames.at(-1)).toContain('唯一技术字段');
    expect(frames.filter((frame) => frame.includes('唯一技术字段'))).toHaveLength(1);
    for (const rendered of [frames[0]!, frames.at(-1)!]) {
      const pager = rendered.split('\n').find((line) => line.includes('← 上一页'))!;
      expect(pager).toMatch(/下一页 →\s+│$/u);
    }
    const lastLines = frames.at(-1)!.split('\n');
    expect(lastLines.findIndex((line) => line.includes('唯一技术字段'))).toBeLessThan(
      lastLines.findIndex((line) => line.includes('← 上一页')),
    );
    expect(lastLines.findIndex((line) => line.includes('← 上一页'))).toBeLessThan(
      lastLines.findIndex((line) => line.includes('› 保存')),
    );
    await writeAcceptanceTrace(`reader/review-technical-${columns}x${rows}`, [
      { label: '第一页', size, inputs: ['d'], frame: frames[0]! },
      { label: '末页', size, inputs: ['ArrowRight'], frame: frames.at(-1)! },
    ]);
  });

  it.each(['cleanup', 'uninstall'] as const)('does not offer script timeout for %s Review', async (action) => {
    const value = controller();
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('高级选项：脚本超时');
    expect(instance.lastFrame()).toContain(value.snapshot.activeReview?.primaryLabel);
  });

  it('renders a plugin write with failed status reload as unconfirmed and keeps its return route', async () => {
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('结果未确认');
    expect(instance.lastFrame()).not.toContain('插件操作未完成');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
  });

  it('renders an all-failed receipt as unconfirmed after showing the refreshed target state', async () => {
    const before = loadResult();
    const after = loadResult();
    const refreshed = after.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex');
    if (refreshed) updatePlacement(refreshed, 'user', {
      state: 'needsSync',
      reasons: [{ code: 'missingContent', message: '安全说明', severity: 'warning' }],
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { platform: 'codex', scope: 'user' },
          state: 'failed',
          errorCode: 'durableCleanupFailed',
        }],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('结果未确认');
    expect(instance.lastFrame()).not.toContain('operationFailed');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('查看插件');
    expect(value.getTargetState('team-tools/review-gate', 'codex', 'user')).toBe('needsSync');
  });

  it('groups a layered Review without giving its headings a separate focus and keeps the primary action reachable', async () => {
    const plan = dependencyPlan();
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D05');
    expect(instance.lastFrame()).toContain('根插件');
    expect(instance.lastFrame()).toContain('依赖');
    expect(instance.lastFrame()).not.toContain('Project intent');
    expect(instance.lastFrame()).not.toContain('User intent');
    expect(instance.lastFrame()).toContain('保持');
    expect(instance.lastFrame()).toContain('skill-toolkit');
    expect(instance.lastFrame()).toContain('content-toolkit');
    expect(instance.lastFrame()).toContain('› 添加插件 3 个插件');
    expect(instance.lastFrame()).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it.each([
    ['install', 'keep', 'add'],
    ['uninstall', 'keep', 'remove'],
    ['refreshAndSync', 'move', 'keep'],
    ['reinstall', 'move', 'keep'],
    ['sync', 'move', 'keep'],
  ] as const)('mounts %s Review intent rows from the command desired action when targets %s', async (
    action,
    targetAction,
    expectedKind,
  ) => {
    const plan = placementPlanFor({ platform: 'codex', scope: 'project' });
    plan.targets = plan.targets.map((entry) => ({ ...entry, action: targetAction }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'official/agent-lab',
      platform: 'codex', scope: 'project',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const intentRows = value.snapshot.activeReview?.changes.filter((change) =>
      change.group === 'requested' || change.group === 'dependencies') ?? [];

    expect(intentRows.length).toBeGreaterThan(0);
    expect(intentRows.every((change) => change.kind === expectedKind)).toBe(true);
    expect(instance.lastFrame()).toContain(action === 'uninstall' ? '移除插件' : '你选择的插件');
    instance.unmount();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'requires the Phase4 shared impact confirmation before executing at %ix%i',
    async (columns, rows) => {
      const intent = {
        kind: 'pluginWrite' as const,
        action: 'install' as const,
        pluginId: 'official/agent-lab',
        platform: 'codex' as const,
        scope: 'project' as const,
        dependencyScopeOverrides: [{
          pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'user' as const,
        }],
      };
      const plan = placementPlanFor(intent);
      const codexReconcilePlans = [{
        sharedNativeActions: [{
          pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
          action: 'replace', desiredVersion: '2.0.0', affectsOtherScopes: true,
        }],
        activationActions: {
          user: [{
            pluginId: 'official/skill-toolkit', codexPluginId: 'skill-toolkit@aw-official',
            scope: 'user', action: 'enable', desired: true,
          }],
          project: [{
            pluginId: 'official/agent-lab', codexPluginId: 'agent-lab@aw-official',
            scope: 'project', action: 'enable', desired: true,
          }],
        },
        extensionWrites: [{
          pluginId: 'official/agent-lab', componentKey: 'extensions.instructions:guide',
          kind: 'instruction', scope: 'project', action: 'write',
        }],
        extensionRemovals: [],
        review: {
          requiresConfirmation: true,
          sharedImpact: {
            pluginIds: ['agent-lab@aw-official'],
            warning: '被共用的 native 内容会影响其他项目。',
          },
        },
      }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
      const executeIntent = vi.fn().mockResolvedValue({
        overallState: 'succeeded', dependencyPlan: plan, targetResults: [],
      });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
        captureEvidence: vi.fn().mockResolvedValue({
          ...evidence, dependencyPlan: plan, codexReconcilePlans,
        }),
        executeIntent,
      });
      await value.load();
      await value.buildOperationReview(intent);
      const navigate = vi.fn().mockResolvedValue('completed');
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }}
        onSessionNavigation={navigate} />);
      await nextTurn(2);

      const initial = instance.lastFrame() ?? '';
      expect(initial).toContain('需要确认会影响其他项目的内容');
      for (const layer of [
        'Project intent', 'User intent', 'Shared Codex native',
        'User activation', 'Project activation', 'AW extensions',
      ]) expect(initial).not.toContain(layer);
      expect(initial).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
      expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
      await input(instance, ...Array.from({ length: 10 }, () => '\u001B[6~'));
      for (const layer of [
        'Project intent', 'User intent', 'Shared Codex native',
        'User activation', 'Project activation', 'AW extensions',
      ]) expect(instance.lastFrame()).not.toContain(layer);
      await input(instance, ...Array.from({ length: 10 }, () => '\u001B[5~'));
      await input(instance, 'd');
      expect(instance.lastFrame()).toContain('另有');
      await input(instance, '\r');
      expect(executeIntent).not.toHaveBeenCalled();
      expect(instance.lastFrame()).toContain('返回检查');
      expect(instance.lastFrame()).toContain('我已了解影响');

      if (columns === 80) {
        await input(instance, 'h');
        expect(navigate).toHaveBeenCalledWith('home', { discardDrafts: false });
      } else {
        await input(instance, '\r');
        expect(instance.lastFrame()).toContain('替换由平台共用的内容');
      }
      expect(executeIntent).not.toHaveBeenCalled();
      await input(instance, '\r');
      if (columns === 60) {
        instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 17 }} />);
        await nextTurn(2);
        expect(instance.lastFrame()).toContain('终端空间不足');
        await input(instance, '\r');
        expect(executeIntent).not.toHaveBeenCalled();
        instance.rerender(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
        await nextTurn(2);
        expect(instance.lastFrame()).toContain('返回检查');
      }
      await input(instance, '\u001B[B', '\r');
      await nextTurn(3);
      expect(executeIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('shows a completed install on the stable detail and one Esc preserves the browse anchor', async () => {
    const value = controller();
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 0,
        scrollOffset: 0,
        query: 'agent',
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/agent-lab',
      },
    );
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    value.beginInstallFlow('official/agent-lab', 'user');
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/agent-lab',
      platform: 'codex',
      scope: 'user',
    });
    await value.executeOperation(review.reviewToken);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.result).toBeDefined();
    expect(value.snapshot.completionNotice).toMatchObject({
      pluginId: 'official/agent-lab', title: '插件安装完成',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('插件安装完成');
    expect(instance.lastFrame()).toContain('尚无安装结果');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    await nextTurn(2);
    expect(value.snapshot.router.current).toEqual({
      route: { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      context: {
        focusIndex: 0,
        scrollOffset: 0,
        query: 'agent',
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/agent-lab',
      },
    });
    expect(instance.lastFrame()).toMatch(/搜索 agent +\[\/\]/u);

    await input(instance, '\r');
    await focusAction(instance, '添加插件…');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/agent-lab',
    });
  });

  it.each(['restore', 'update'] as const)(
    'returns a successful single-plugin %s task to stable detail with a notice',
    async (goal) => {
      const captureEvidence = vi.fn(async (candidate: OperationIntent) =>
        pluginWriteTaskEvidence(candidate as Extract<OperationIntent, { kind: 'pluginWriteTask' }>));
      const executeIntent = vi.fn(async (_candidate: OperationIntent, operationEvidence: OperationEvidence) =>
        pluginWriteTaskExecution(operationEvidence as PluginWriteTaskEvidence));
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(goal === 'update'
          ? platformLoadResult('upgradeAvailable') : loadResult()),
        captureEvidence,
        executeIntent,
      });
      await value.load();
      const targets = goal === 'update'
        ? [value.listPluginWriteTaskCandidates('update').find((candidate) =>
            candidate.target.pluginId === 'official/review-gate')!.target]
        : [{
            pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const,
          }];
      const intent = {
        kind: 'pluginWriteTask' as const,
        goal,
        executionPolicy: 'all' as const,
        targets,
      };
      const pluginId = targets[0]!.pluginId;
      value.push({ name: 'pluginDetail', pluginId });
      const review = await value.buildOperationReview(intent);
      await value.executeOperation(review.reviewToken);

      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId,
      });
      expect(value.snapshot.completionNotice).toMatchObject({
        pluginId,
        title: goal === 'restore' ? '插件恢复完成' : '插件更新完成',
      });
    },
  );

  it.each([
    ['operationDiagnostic', 60, 18], ['operationDiagnostic', 80, 24],
    ['operationReportPreview', 60, 18], ['operationReportPreview', 80, 24],
  ] as const)('review repair pages every retained line with equivalent keys in %s at %ix%i', async (name, columns, rows) => {
    const value = controller();
    const recordId = value.recordUiFailure(undefined, { code: 'fixtureFailure', stage: 'fixture-stage' });
    const detailLines = Array.from({ length: 15 }, (_, index) =>
      `SEGMENT_${index}_${Array.from({ length: 20 }, (_, part) => `${index}-${part}|`).join('')}_END_${index}`);
    if (name === 'operationDiagnostic') {
      const detail = value.getOperationDiagnostic(recordId)!;
      detail.diagnostics[0]!.detailLines = detailLines;
      vi.spyOn(value, 'getOperationDiagnostic').mockReturnValue(detail);
    }
    value.push({ name, recordId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    const first = instance.lastFrame();
    expect(first).toContain('1 /');
    expect((first ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    const trace: AcceptanceTraceStep[] = [];
    const expectedText = name === 'operationDiagnostic'
      ? operationDiagnosticText(value.getOperationDiagnostic(recordId)!)
      : value.previewOperationReport(recordId)!.content;
    const pageRows = name === 'operationDiagnostic'
      ? columns === 60 ? 9 : 12
      : columns === 60 ? 8 : 9;
    const visibleLines: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const frame = instance.lastFrame() ?? '';
      trace.push(acceptanceTraceStep(instance, { columns, rows }, `page ${index}`, []));
      const page = frame.match(/← 上一页\s+(\d+) \/ (\d+)\s+下一页 →/u);
      expect(page).toBeTruthy();
      const projection = readerPage({ text: expectedText, columns: columns - 2, rows: pageRows, page: index + 1 });
      expect(page?.[1]).toBe(String(projection.page));
      expect(page?.[2]).toBe(String(projection.pageCount));
      for (const line of projection.lines.filter(Boolean)) expect(frame).toContain(line);
      visibleLines.push(...projection.lines);
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[6~');
    }
    const joined = visibleLines.join('').replace(/\s/gu, '');
    if (name === 'operationDiagnostic') {
      for (const line of detailLines) expect(joined).toContain(line);
    } else {
      for (const line of value.previewOperationReport(recordId)!.content.split('\n').slice(2).filter(Boolean)) {
        expect(joined).toContain(line.replace(/\s/gu, ''));
      }
    }
    await input(instance, ...Array.from({ length: 50 }, () => '\u001B[5~'));
    expect(instance.lastFrame()).toBe(first);
    await input(instance, '\u001B[6~');
    const next = instance.lastFrame();
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toBe(first);
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toBe(next);
    await writeAcceptanceTrace(`review-repair/${name}-${columns}x${rows}`, trace);
  });
  it('discards the first scoped plan and binds script timeout to a fresh Review', async () => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn();
    const value = controller({ prepareScopedTask, executeScopedTask });
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await focusAction(instance, '添加插件…');
    await input(instance, '\r', '\u001B[B', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const firstPlan = await prepareScopedTask.mock.results[0]!.value;

    await focusAction(instance, '修改脚本超时');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('设置脚本超时');
    expect((firstPlan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.context.dispose)
      .toHaveBeenCalledTimes(1);
    await input(instance, '\u0015', '12000', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledTimes(2);
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: 'project', scriptTimeoutMs: 12_000,
      selectors: ['official/agent-lab'],
    }), expect.any(AbortSignal));
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it('shows scoped preparation and lets Esc cancel without creating a Review', async () => {
    const prepared = deferred<ScopedTuiPlan>();
    const prepareScopedTask = vi.fn(() => prepared.promise);
    const executeScopedTask = vi.fn();
    const value = controller({ prepareScopedTask, executeScopedTask });
    value.beginInstallFlow('official/agent-lab', 'project');
    value.setInstallPlatforms(['codex']);
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('正在准备操作汇总');
    expect(instance.lastFrame()).toContain('Esc 可取消准备');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installPlacement', pluginId: 'official/agent-lab',
    });
    const plan = scopedPlan(prepareScopedTask.mock.calls[0]![0]);
    prepared.resolve(plan);
    await nextTurn(3);
    expect((plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.context.dispose)
      .toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('选择使用范围');
    expect(instance.lastFrame()).not.toContain('确认恢复可执行目标');
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps one requested declaration scope across platform observations at %ix%i',
    async (columns, rows) => {
      const loaded = loadResult();
      loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!
        .supportedTargets = { codex: ['project'], claude: ['user'] };
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
      await value.load();
      value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);
      await focusAction(instance, '■ 当前项目');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(prepareScopedTask).toHaveBeenCalledWith({ kind: 'recovery', command: 'install',
        scope: 'project', selectors: ['official/agent-lab'] }, expect.any(AbortSignal));
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps shared dependency impact behind a separate confirmation at %ix%i',
    async (columns, rows) => {
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => {
        const prepared = scopedPlan(request) as Extract<ScopedTuiPlan, { kind: 'recovery' }>;
        prepared.plan.nativeGroups = [{ preview: { codexReconcilePlans: [{ review: {
          requiresConfirmation: true, sharedImpact: { warning: '共享内容可能影响其他项目。' },
        } }] } }] as typeof prepared.plan.nativeGroups;
        return prepared;
      });
      const executeScopedTask = vi.fn();
      const value = controller({ prepareScopedTask, executeScopedTask });
      value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);
      await focusAction(instance, '■ 当前项目');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('请确认本次风险');
      expect(instance.lastFrame()).toContain('› 返回检查');
      expect(executeScopedTask).not.toHaveBeenCalled();
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      await input(instance, '\r');
      expect(instance.lastFrame()).not.toContain('请确认本次风险');
      expect(instance.lastFrame()).toContain('操作汇总');
      expect(executeScopedTask).not.toHaveBeenCalled();
    },
  );

  it('selects exact installed locations in one scope before uninstall Review and keeps settings', async () => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })),
      prepareScopedTask,
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await focusAction(instance, '卸载');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'uninstallTargets', pluginId: 'official/agent-lab',
    });
    const targetFrame = instance.lastFrame() ?? '';
    for (const label of [
      'Codex · 当前项目', 'Codex · 所有项目',
      'Claude Code · 当前项目', 'Claude Code · 所有项目',
      '全部已安装位置',
    ]) expect(targetFrame).toContain(label);
    expect(targetFrame).toContain('插件设置默认保留');

    await focusAction(instance, 'Codex · 所有项目');
    await input(instance, '\r');
    await focusAction(instance, 'Claude Code · 所有项目');
    await input(instance, '\r');
    await focusAction(instance, '继续到卸载确认');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'uninstall', scope: 'project',
      exactTargets: expect.arrayContaining([
        { pluginId: 'official/agent-lab', agent: 'codex' },
        { pluginId: 'official/agent-lab', agent: 'claude' },
      ]),
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).not.toContain('删除所选插件的全部本机设置');
    const details = await readScopedDetails(instance);
    expect(details).toContain('配置变更（计划）：无');
    expect(value.dependencies.executeScopedTask).not.toHaveBeenCalled();
  });

  it('runs the normal install chain through scoped Review and retries only the failed target', async () => {
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request, {
      ...scopedReceipt(request), declarationChanged: true,
    }));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
      const receipt = (plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt;
      return { kind: 'recovery' as const, receipt: { ...receipt, ok: false,
        outputsMayHaveChanged: true,
        targetResults: [
          scopedTarget('official/agent-lab', 'codex', 'applied', 'verified'),
          scopedTarget('official/agent-lab', 'claude', 'failed', 'missing'),
        ],
        remainingTargets: [{ pluginId: 'official/agent-lab', agent: 'claude' as const,
          scope: 'user' as const, delivery: { kind: 'native' as const, platform: 'claude' as const } }],
      } };
    });
    const value = controller({ prepareScopedTask, executeScopedTask });
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await focusAction(instance, '添加插件…');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('选择使用范围');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: 'user',
      selectors: ['official/agent-lab'],
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).toContain('插件清单也将保存本次变化。');
    const reviewDetails = await readScopedDetails(instance);
    expect(reviewDetails).toContain('需求变更（计划）：保存当前范围需求');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('请求仍有未完成目标');
    expect(instance.lastFrame()).toContain('× 执行失败 agent-lab（official）');
    const resultDetails = await readScopedDetails(instance);
    expect(resultDetails).toContain('official/agent-lab · Claude Code [个人] · 原生 · failed · missing');
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    await focusAction(instance, '重试明确失败项（1）');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'user',
      exactTargets: [{ pluginId: 'official/agent-lab', agent: 'claude', scope: 'user' }],
    }), expect.any(AbortSignal));
  });

  it('keeps dependency-blocked project cleanup outside an exact user-scope request', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId === 'official/agent-lab');
    const codex = loaded.payload.targets.find((entry) => entry.platform === 'codex')!;
    updatePlacement(codex, 'project', {
      state: 'blocked',
      components: [{ kind: 'ownership', key: 'fixture', state: 'partial' }],
      reasons: [{ code: 'dependencyStillRequired', message: '仍被使用', severity: 'blocking' }],
    });
    const claude = loaded.payload.targets.find((entry) =>
      entry.platform === 'claude' && entry.scope === 'user')!;
    updatePlacement(claude, 'user', {
      state: 'needsSync',
      components: [{ kind: 'ownership', key: 'fixture', state: 'partial' }],
    });
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    await focusAction(instance, '其他维护方式');
    await input(instance, '\r');
    await focusAction(instance, '清理遗留内容');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('个人与项目目标需要分别确认');
    expect(instance.lastFrame()).not.toContain('强制清理');
    expect(prepareScopedTask).not.toHaveBeenCalled();
  });

});
