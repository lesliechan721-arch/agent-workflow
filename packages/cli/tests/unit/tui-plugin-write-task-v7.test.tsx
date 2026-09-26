import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import { copyToClipboard } from '../../src/tui/clipboard.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { ConfigPageViewModel, UserIssueViewModel } from '../../src/tui/model.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  type OperationEvidence,
  type PluginWriteTaskEvidence,
  type PluginWriteTaskExecutionResult,
  type PluginWriteTaskIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

afterEach(() => cleanup());

const target = {
  pluginId: 'official/demo', platform: 'codex', scope: 'user',
  expectedUpdate: {
    installedVersion: '1.0.0', activeVersion: '2.0.0',
    sourceIdentity: 'identity:official', generationKey: 'official/active',
  },
} as const;

const statusTarget: StatusV8Payload['targets'][number] = {
  pluginName: 'demo', pluginId: 'official/demo', sourceId: 'official',
  sourceIdentity: 'identity:official', version: '2.0.0', platform: 'codex',
  cwd: '/workspace', state: 'ready',
  components: [], reasons: [], recoveryActions: [],
  placements: [{
    scope: 'user', state: 'ready',
    components: [{ kind: 'ownership', key: 'demo', state: 'present' }],
    reasons: [], recoveryActions: [],
  }],
};

const summary: StatusV8PluginSummary = {
  pluginName: 'demo', pluginId: 'official/demo', displayName: 'Demo',
  description: '演示插件', version: '2.0.0',
  supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0,
};

function loaded(): TuiStatusLoadResult {
  return {
    payload: {
      schemaVersion: 8,
      catalog: {
        primarySourceId: 'official', configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'official', identity: 'identity:official', type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active', catalogVersion: '2.0.0',
        }],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: [statusTarget], errors: [],
    },
    pluginSummaries: [summary],
    targetRevisions: [{
      pluginId: 'official/demo', platform: 'codex', scope: 'user',
      revision: { state: 'upgradeAvailable', installedVersion: '1.0.0', availableVersion: '2.0.0' },
    }],
    catalogGenerations: [{
      sourceId: 'official', sourceType: 'path', state: 'ready',
      active: {
        catalogVersion: '2.0.0', channel: 'latest', requestedRef: 'path', resolvedCommit: 'path',
        storeKey: 'official/active', digestShort: 'official',
      },
    }],
  };
}

function preview(state: 'completed' | 'failed' = 'completed') {
  const receiptTarget = {
    pluginName: 'demo', pluginId: 'official/demo', sourceId: 'official',
    platform: 'codex' as const, scope: 'user' as const,
  };
  return {
    platforms: ['codex'], plugins: state === 'completed' ? ['demo'] : [], warnings: [],
    rebuildResults: [],
    targetResults: [{
      target: receiptTarget, action: 'sync', state,
      ...(state === 'failed' ? { errorCode: 'writeFailed' } : {}),
    }],
    overallState: state === 'completed' ? 'succeeded' as const : 'failed' as const,
    receiptTargets: [receiptTarget],
    operationPlan: createOperationPlan({
      intentChanges: [], actions: [], changes: ['official/demo:codex:user'], warnings: [],
      evidence: {
        catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
        intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
      },
    }),
  };
}

function taskEvidence(intent: PluginWriteTaskIntent): PluginWriteTaskEvidence {
  const sourcePreview = preview();
  const cause = {
    causeKey: 'update\0official/demo', issueId: 'update\0official/demo', sourceId: 'official',
    sourceIdentity: 'identity:official',
    repairTarget: { pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const },
    method: 'sync' as const,
    consumers: [{ pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const }],
  };
  const evidence: PluginWriteTaskEvidence = {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    taskPlan: {
      goal: intent.goal, requestedTargets: intent.targets, executableTargets: intent.targets,
      causes: [cause], blockedTargets: [], targetFingerprint: 'sha256:targets',
      planFingerprint: '',
      sources: [{
        sourceId: 'official', sourceIdentity: 'identity:official',
        requestedTargets: intent.targets, causes: [cause], preview: sourcePreview, executable: true,
      }],
    },
  };
  evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
  return evidence;
}

function controller(executionState: 'completed' | 'failed' = 'completed') {
  let reviewedEvidence: PluginWriteTaskEvidence | undefined;
  const dependencies: TuiControllerDependencies = {
    loadStatus: vi.fn().mockResolvedValue(loaded()),
    captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
      if (intent.kind !== 'pluginWriteTask') throw new Error('unexpected intent');
      reviewedEvidence = taskEvidence(intent);
      return reviewedEvidence;
    }),
    executeIntent: vi.fn(async (): Promise<PluginWriteTaskExecutionResult> => {
      const result = preview(executionState);
      return {
        ...result,
        taskPlan: reviewedEvidence!.taskPlan,
        sourceResults: [{
          sourceId: 'official', sourceIdentity: 'identity:official',
          requestedTargets: reviewedEvidence!.taskPlan.requestedTargets, result,
        }],
      };
    }),
    now: () => 1_000,
    reviewTtlMs: 10_000,
  };
  return { value: new TuiController(dependencies), dependencies };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function write(instance: ReturnType<typeof render>, input: string): Promise<void> {
  instance.stdin.write(input);
  await nextTurn();
  await nextTurn();
}

async function focusAction(
  instance: ReturnType<typeof render>,
  label: string,
  limit = 24,
): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    const frame = instance.lastFrame()?.replace(/ +(?=\[[a-z/?]\] *$)/gmu, ' ');
    if (frame?.includes(`› ${label}`) || frame?.includes(`› [${label}]`) || frame?.includes(`› ○ ${label}`)
      || frame?.includes(`› ● ${label}`)) return;
    await write(instance, '\u001B[B');
  }
  throw new Error(`Action was not reachable: ${label}\n${instance.lastFrame() ?? ''}`);
}

describe('TUI plugin write task', () => {
  it('prepares a complete recommended update Review and reissues it after adjusting the frozen selection', async () => {
    const { value, dependencies } = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('更新 1 个');
    await focusAction(instance, '更新 1 个');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));

    expect(dependencies.captureEvidence).toHaveBeenCalledOnce();
    expect(dependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask',
      goal: 'update',
      executionPolicy: 'all',
      targets: [expect.objectContaining({
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
      })],
    }), expect.any(AbortSignal));
    expect(dependencies.executeIntent).not.toHaveBeenCalled();
    const oldToken = value.snapshot.activeReview!.reviewToken;
    expect(instance.lastFrame()).toContain('调整选择（1）');

    await focusAction(instance, '调整选择（1）');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('batchSelection');
    expect(instance.lastFrame()).toContain('已选 1 个');
    await expect(value.executeOperation(oldToken)).resolves.toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });

    await focusAction(instance, '查看升级汇总（1） [c]');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));

    expect(dependencies.captureEvidence).toHaveBeenCalledTimes(2);
    expect(value.snapshot.activeReview!.reviewToken).not.toBe(oldToken);
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    expect(value.snapshot.router.currentFlowId).toBeUndefined();
    expect(value.snapshot.result).toMatchObject({
      state: 'succeeded',
      returnRoute: { name: 'pluginWriteTask', batchOrigin: { owner: 'batch-write' } },
    });

    expect(instance.lastFrame()).not.toContain('完成，返回我的插件');
    await vi.waitFor(() => expect(value.hasSessionDraft).toBe(false));
    await write(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(value.snapshot.router.currentFlowId).toBeUndefined();

    value.push({
      name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'update',
      targetKeys: ['official/demo\0codex\0user'],
      versionEvidence: {
        'official/demo\0codex\0user': JSON.stringify({
          version: '2.0.0', sourceIdentity: 'identity:official', binding: 'official/active',
        }),
      },
      recommendedPluginIds: ['official/demo'],
    });
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain(`› ${value.snapshot.activeReview!.primaryLabel}`));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('pluginDetail'));
    expect(instance.lastFrame()).toContain('插件更新完成');
    expect(value.snapshot.router.currentFlowId).toBeUndefined();
    expect(value.snapshot.result).toMatchObject({
      state: 'succeeded',
      returnRoute: { name: 'pluginWriteTask', goal: 'update' },
    });
    expect((value.snapshot.result as { returnRoute?: { batchOrigin?: unknown } }).returnRoute)
      .not.toHaveProperty('batchOrigin');
    value.dispose();
  });

  it('does not expand a frozen recommendation when a refreshed target appears', async () => {
    const { value, dependencies } = controller();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      {
        target, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [],
      },
      {
        target: {
          ...target,
          platform: 'claude',
          scope: 'project',
        },
        displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [],
      },
    ]);
    value.push({
      name: 'pluginWriteTask',
      pluginId: 'official/demo',
      goal: 'update',
      targetKeys: ['official/demo\0codex\0user'],
      versionEvidence: {
        'official/demo\0codex\0user': JSON.stringify({
          version: '2.0.0', sourceIdentity: 'identity:official', binding: 'official/active',
        }),
      },
      recommendedPluginIds: ['official/demo'],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();
    await nextTurn();

    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    expect(dependencies.captureEvidence).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('1 个新位置需要重新确认');
    expect(instance.lastFrame()).not.toContain('确认更新 1 个位置');
    value.dispose();
  });

  it('prepares an unambiguous restore once and lets Esc return without a loop', async () => {
    const { value, dependencies } = controller();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{
      target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
      displayName: 'Demo', sourceId: 'official', eligible: true,
      recommendedMethod: 'sync', issueIds: [],
    }]);
    value.push({
      name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore',
      targetKeys: ['official/demo\0codex\0user'],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);

    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(dependencies.captureEvidence).toHaveBeenCalledTimes(1);
    expect(dependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: [{ pluginId: 'official/demo', platform: 'codex', scope: 'user' }],
    }), expect.any(AbortSignal));
    await write(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask', goal: 'restore',
      targetKeys: ['official/demo\0codex\0user'],
    });
    expect(instance.lastFrame()).toContain('确认恢复 1 个位置');
    await nextTurn();
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    expect(dependencies.captureEvidence).toHaveBeenCalledTimes(1);
    value.dispose();
  });

  it.each(['restore', 'update'] as const)(
    'does not prepare a %s task when one frozen target disappears',
    async (goal) => {
      const { value, dependencies } = controller();
      await value.load();
      vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [],
      }]);
      const route = {
        name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal,
        targetKeys: [
          'official/demo\0codex\0user',
          'official/demo\0claude\0project',
        ],
      };
      value.push(route);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
      await nextTurn();
      await nextTurn();

      expect(value.snapshot.router.current.route).toEqual(route);
      expect(instance.lastFrame()).toContain('1 个本次安装位置已失效或无需处理');
      expect(instance.lastFrame()).not.toContain(`确认${goal === 'restore' ? '恢复' : '更新'} 1 个位置`);
      await write(instance, '\r');
      expect(dependencies.captureEvidence).not.toHaveBeenCalled();
      expect(value.snapshot.router.current.route.name).not.toBe('review');
      value.dispose();
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'uses one task preparation, Review, progress/detail completion chain at %ix%i',
    async (columns, rows) => {
      const { value, dependencies } = controller();
      await value.load();
      value.push({ name: 'pluginDetail', pluginId: 'official/demo' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn();

      expect(instance.lastFrame()).toContain('更新到 2.0.0');
      await write(instance, 'a');
      expect(instance.lastFrame()).toContain('› 更新到 2.0.0');
      await write(instance, '\r');
      await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
      expect(instance.lastFrame()).toContain('确认更新到 2.0.0');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      expect(Math.max(...(instance.lastFrame() ?? '').split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);

      await write(instance, '\r');
      await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('pluginDetail'));
      expect(dependencies.executeIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'pluginWriteTask', goal: 'update', targets: [target], executionPolicy: 'all',
        }),
        expect.objectContaining({ taskPlan: expect.any(Object) }),
      );
      expect(instance.lastFrame()).toContain('状态已重新检查');
      expect(instance.lastFrame()).toContain('Demo');
      expect(value.snapshot.result).toMatchObject({ state: 'succeeded' });
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      value.dispose();
    },
  );

  it('keeps manual blocked targets out of retry and returns to their task after subset success', async () => {
    const clipboard = vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
    const executableTarget = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const blockedTarget = {
      pluginId: 'official/demo', platform: 'claude' as const, scope: 'project' as const,
    };
    let reviewedEvidence: PluginWriteTaskEvidence | undefined;
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
        if (intent.kind !== 'pluginWriteTask') throw new Error('unexpected intent');
        const evidence = taskEvidence(intent);
        evidence.taskPlan.executableTargets = [executableTarget];
        evidence.taskPlan.blockedTargets = [{
          target: blockedTarget, reason: 'manualRecoveryRequired', issueIds: ['manual:demo'],
        }];
        evidence.taskPlan.sources[0]!.requestedTargets = [executableTarget];
        evidence.taskPlan.planFingerprint = '';
        evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
        reviewedEvidence = evidence;
        return evidence;
      }),
      executeIntent: vi.fn(async (): Promise<PluginWriteTaskExecutionResult> => {
        const result = preview();
        return {
          ...result,
          taskPlan: reviewedEvidence!.taskPlan,
          sourceResults: [{
            sourceId: 'official', sourceIdentity: 'identity:official', requestedTargets: [executableTarget], result,
          }],
        };
      }),
      now: () => 1_000,
      reviewTtlMs: 10_000,
    };
    const value = new TuiController(dependencies);
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      {
        target: executableTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [],
      },
      {
        target: blockedTarget, displayName: 'Demo', sourceId: 'official', eligible: false,
        blockReason: 'manualRecoveryRequired', issueIds: ['manual:demo'],
      },
    ]);
    const taskRoute = { name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal: 'restore' as const };
    value.push(taskRoute);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn();

    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));

    expect(value.snapshot.result).toMatchObject({
      state: 'partial',
      summary: {
        task: {
          blockedTargets: [{ target: blockedTarget, reason: 'manualRecoveryRequired' }],
        },
      },
    });
    expect(value.snapshot.result?.state === 'partial'
      ? value.snapshot.result.summary.task : undefined).not.toHaveProperty('retryTargets');
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('部分完成');
    expect(frame).toContain('1 个目标需要决定');
    expect(frame).toContain('需要选择手动处理方式');
    expect(frame).toContain('返回任务处理 1 个需决定项');
    expect(frame).not.toContain('继续处理剩余');
    await write(instance, 'y');
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    expect(clipboard.mock.calls[0]![0]).toContain('official/demo · Claude Code · 当前项目');
    expect(clipboard.mock.calls[0]![0]).toContain('需要选择手动处理方式');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      ...taskRoute,
      targetKeys: ['official/demo\0claude\0project'],
    });
    expect(instance.lastFrame()).toContain('维护 Demo · Claude Code · 当前项目');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'platform', pluginId: 'official/demo', platform: 'claude',
    });
    expect(instance.lastFrame()).toContain('Demo / Claude Code');
    value.dispose();
  });

  it('returns to the frozen restore targets after a nested update without a batch parent flow', async () => {
    const { value } = controller();
    await value.load();
    const restoreTarget = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation((goal) => goal === 'restore'
      ? [{
          target: restoreTarget, displayName: 'Demo', sourceId: 'official', eligible: false,
          blockReason: 'restoreVersionChanged', issueIds: [],
        }, {
          target: { pluginId: 'official/demo', platform: 'claude', scope: 'project' },
          displayName: 'Demo', sourceId: 'official', eligible: false,
          blockReason: 'manualRecoveryRequired', issueIds: [],
        }]
      : [{
          target, displayName: 'Demo', sourceId: 'official', eligible: true,
          recommendedMethod: 'sync', issueIds: [],
        }]);
    const restoreRoute = {
      name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal: 'restore' as const,
      targetKeys: ['official/demo\0codex\0user', 'official/demo\0claude\0project'],
    };
    value.push(restoreRoute);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('0 个可执行 · 2 个需决定');
    expect(instance.lastFrame()).toContain('更新并恢复 Demo · Codex · 所有项目');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(instance.lastFrame()).toContain('确认更新到 2.0.0');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    expect(instance.lastFrame()).toContain('返回剩余恢复任务');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual(restoreRoute);
    expect(instance.lastFrame()).toContain('维护 Demo · Claude Code · 当前项目');
    value.dispose();
  });

  it('edits and saves a required field from a blocked task, then returns to freshly prepared targets', async () => {
    let configured = false;
    const configEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      source: {
        sourceId: 'official', sourceIdentity: 'identity:official',
        snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content',
      },
      targetFingerprint: 'sha256:target',
      config: {
        scope: 'user', storeDigest: 'sha256:config-store', impactState: 'known',
        affectedTargets: [{ platform: 'codex', scope: 'user' }],
      },
    };
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      getConfigPage: vi.fn(async (pluginId, layer): Promise<ConfigPageViewModel> => ({
        pluginId,
        layer,
        storedCount: configured ? 1 : 0,
        presets: [],
        groups: [{
          id: 'required', title: '必填设置', advanced: false,
          fields: [{
            key: 'mode', title: '运行模式', type: 'string',
            definition: {
              type: 'string',
              choices: { allowCustom: false, presets: [{ id: 'safe', title: '安全', value: 'safe' }] },
            },
            choices: [{ id: 'safe', title: '安全', value: 'safe' }],
            displayValue: configured ? '安全' : '未设置', required: true, sensitive: false,
            writable: true, dirty: false, inherited: !configured,
            configured, sourceLabel: configured ? '个人默认' : '未设置',
            effectiveDisplayValue: configured ? '安全' : '未设置',
            effectiveSourceLabel: configured ? '个人默认' : '未设置',
            ...(configured ? { value: 'safe', draftValue: 'safe', effectiveValue: 'safe' } : {}),
            allowCustom: false, advanced: false,
          }],
        }],
      })),
      captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
        if (intent.kind === 'configSaveBatch') return {
          catalog: configEvidence.catalog,
          source: configEvidence.source,
          targetFingerprint: configEvidence.targetFingerprint,
          configBatch: {
            groups: intent.groups.map((group) => ({
              scope: group.scope,
              targetFingerprint: `sha256:config-${group.scope}`,
              config: {
                scope: group.scope, storeDigest: `sha256:config-store-${group.scope}`,
                impactState: 'known', affectedTargets: [{ platform: 'codex', scope: group.scope }],
              },
            })),
          },
        };
        if (intent.kind === 'pluginWriteTask') return taskEvidence(intent);
        throw new Error('unexpected intent');
      }),
      executeIntent: vi.fn(async (intent) => {
        if (intent.kind === 'configSaveBatch') {
          configured = true;
          return {
            status: 'succeeded' as const,
            groups: intent.groups.map((group) => ({
              scope: group.scope, status: 'succeeded' as const, configSaved: true,
              applyRequested: intent.apply, applyStatus: 'notRequested' as const,
            })),
          };
        }
        return preview();
      }),
      now: () => 1_000,
      reviewTtlMs: 10_000,
    };
    const value = new TuiController(dependencies);
    await value.load();
    const issue = {
      issueId: 'config:official/demo:mode', category: 'requiredConfigMissing', group: 'config',
      title: '缺少运行模式', explanation: '必须设置运行模式。', impact: ['插件不能恢复。'],
      entity: { kind: 'plugin', id: 'official/demo' }, pluginId: 'official/demo',
      platform: 'codex', scope: 'user', requiredFields: [{
        key: 'mode', title: '运行模式', type: 'missing-required', source: 'missing', scope: 'user',
      }],
      actions: [{ id: 'openConfig', label: '完成设置' }],
      technicalDetails: [],
      diagnostic: {
        severity: 'error', title: '缺少设置', userMessage: '必须设置运行模式。',
        impact: [{ state: 'blocked', message: '插件不能恢复。' }], nextStep: '完成设置。',
        technical: { code: 'requiredConfigMissing', stage: 'read-config' },
      },
    } as UserIssueViewModel;
    vi.spyOn(value, 'listUserIssues').mockImplementation(() => configured ? [] : [issue]);
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation(() => [{
      target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
      displayName: 'Demo', sourceId: 'official', eligible: configured,
      ...(configured
        ? { recommendedMethod: 'sync' as const }
        : { blockReason: 'manualRecoveryRequired' as const }),
      issueIds: configured ? [] : [issue.issueId],
    }]);
    value.push({
      name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore',
      targetKeys: ['official/demo\0codex\0user'],
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('完成设置：运行模式');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFields'));
    expect(value.snapshot.router.current.route).toMatchObject({ layer: { scope: 'effective' } });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('运行模式'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFieldEditor'));
    expect(instance.lastFrame()).toContain('安全');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configLayer'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFields'));
    await write(instance, 's');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await focusAction(instance, '改为只保存，稍后应用');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    await nextTurn();
    expect(instance.lastFrame()).not.toContain('返回恢复任务');
    await write(instance, 'b');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask', goal: 'restore', targetKeys: ['official/demo\0codex\0user'],
    });
    expect(instance.lastFrame()).toContain('确认恢复 1 个位置');
    await nextTurn();
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    value.dispose();
  });

  it.each([
    ['sourceMissing', 'sourceRemoved', 'archive', '重新添加来源 archive', 'issueDetail', '重新添加同一来源'],
    ['sourceUnavailable', 'sourceUnavailable', 'official', '核对来源 official', 'sourceDetail', '插件来源'],
  ] as const)('routes %s blockers to a usable source recovery page', async (
    category,
    group,
    sourceId,
    actionLabel,
    expectedRoute,
    expectedFrame,
  ) => {
    const { value } = controller();
    await value.load();
    const issue = {
      issueId: `source:${sourceId}:${category}`, category, group,
      title: category === 'sourceMissing' ? '插件来源已移除' : '插件来源不可用',
      explanation: '当前不能读取插件来源。', impact: ['不能恢复插件。'],
      entity: { kind: 'source', id: sourceId }, pluginId: 'official/demo', sourceId,
      actions: category === 'sourceMissing'
        ? [{ id: 'reAddSource', label: '重新添加同一来源' }]
        : [{ id: 'editSource', label: '编辑来源' }],
      technicalDetails: [],
      diagnostic: {
        severity: 'error', title: '来源不可用', userMessage: '当前不能读取插件来源。',
        impact: [{ state: 'blocked', message: '不能恢复插件。' }], nextStep: '处理来源。',
        technical: { code: category, stage: 'resolve-source', sourceId },
      },
    } as UserIssueViewModel;
    vi.spyOn(value, 'listUserIssues').mockReturnValue([issue]);
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{
      target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
      displayName: 'Demo', sourceId, eligible: false,
      blockReason: 'restoreVersionUnverified', issueIds: [],
    }]);
    value.push({ name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain(actionLabel);
    expect(instance.lastFrame()).not.toContain('重新检查 Demo');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe(expectedRoute);
    expect(instance.lastFrame()).toContain(expectedFrame);
    value.dispose();
  });

  it('keeps batch ownership through source activation and nested update, then returns to the frozen restore task', async () => {
    let activated = false;
    let updated = false;
    let reviewedTaskEvidence: PluginWriteTaskEvidence | undefined;
    const catalogCandidate = {
      sourceId: 'official', sourceConfigFingerprint: 'sha256:source',
      sourceIdentity: 'identity:official', logicalIdentity: 'workspace:official',
      requestedRef: 'path', resolvedCommit: 'path', catalogVersion: '2.0.0',
      channel: 'latest' as const, manifestDigest: `sha256:${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    };
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
        if (intent.kind === 'catalogGeneration') return {
          catalog: { configDigest: 'sha256:config', compositeDigest: catalogCandidate.snapshotDigest },
          catalogGeneration: {
            action: 'update', candidate: catalogCandidate,
            activationMode: 'normal', configDigest: 'sha256:config',
          },
        };
        if (intent.kind === 'pluginWriteTask') {
          reviewedTaskEvidence = taskEvidence(intent);
          return reviewedTaskEvidence;
        }
        throw new Error('unexpected intent');
      }),
      executeIntent: vi.fn(async (intent): Promise<PluginWriteTaskExecutionResult | { status: 'succeeded' }> => {
        if (intent.kind === 'catalogGeneration') {
          activated = true;
          return { status: 'succeeded' };
        }
        if (intent.kind !== 'pluginWriteTask') throw new Error('unexpected intent');
        if (intent.goal === 'update') updated = true;
        const result = preview();
        return {
          ...result,
          taskPlan: reviewedTaskEvidence!.taskPlan,
          sourceResults: [{
            sourceId: 'official', sourceIdentity: 'identity:official',
            requestedTargets: reviewedTaskEvidence!.taskPlan.requestedTargets, result,
          }],
        };
      }),
      now: () => 1_000,
      reviewTtlMs: 10_000,
    };
    const value = new TuiController(dependencies);
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation((goal) => {
      if (goal === 'restore') return [{
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        displayName: 'Demo', sourceId: 'official', eligible: updated,
        ...(updated
          ? { recommendedMethod: 'sync' as const }
          : { blockReason: 'restoreVersionChanged' as const }),
        issueIds: [],
      }];
      return [{
        target: activated ? target : {
          pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
        },
        displayName: 'Demo', sourceId: 'official', eligible: activated,
        ...(activated
          ? { recommendedMethod: 'sync' as const }
          : { blockReason: 'catalogActivationRequired' as const }),
        issueIds: [],
      }];
    });
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    await write(instance, 'm');
    await write(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 1');
    await write(instance, 'c');
    await focusAction(instance, '恢复所选中的 1 个插件');
    await write(instance, '\r');
    const outerTask = value.snapshot.router.current.route;
    expect(outerTask).toMatchObject({
      name: 'pluginWriteTask', goal: 'restore',
      targetKeys: ['official/demo\0codex\0user'],
      batchOrigin: { owner: 'batch-write', flowId: expect.any(String) },
    });
    const batchFlowId = (outerTask as Extract<typeof outerTask, { name: 'pluginWriteTask' }>)
      .batchOrigin!.flowId;
    expect(value.hasSessionDraft).toBe(true);

    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask', goal: 'update',
      batchOrigin: (outerTask as Extract<typeof outerTask, { name: 'pluginWriteTask' }>).batchOrigin,
    });
    expect(instance.lastFrame()).toContain('先更新来源目录 official');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    expect(instance.lastFrame()).toContain('重新准备插件更新');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    expect(instance.lastFrame()).toContain('返回剩余恢复任务');
    expect(value.hasSessionDraft).toBe(true);
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(outerTask);
    expect(value.snapshot.router.currentFlowId).toBe(batchFlowId);
    expect(instance.lastFrame()).toContain('确认恢复 1 个位置');
    await nextTurn();
    expect(value.snapshot.router.current.route).toEqual(outerTask);
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    await vi.waitFor(() => expect(value.hasSessionDraft).toBe(false));
    expect(value.snapshot.router.currentFlowId).toBeUndefined();
    expect(instance.lastFrame()).not.toContain('完成，返回我的插件');
    await write(instance, 'b');
    await nextTurn();
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(value.hasSessionDraft).toBe(false);
    value.dispose();
  });

  it('offers an exact failed-target retry through a new Review', async () => {
    const { value } = controller('failed');
    await value.load();
    value.push({ name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'update' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));

    expect(instance.lastFrame()).toContain('继续处理剩余 1 项');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    value.dispose();
  });

  it('shows one root plugin with separate positions and retries only its failed position', async () => {
    const clipboard = vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
    const codexTarget = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const claudeTarget = {
      pluginId: 'official/demo', platform: 'claude' as const, scope: 'project' as const,
    };
    let reviewedEvidence: PluginWriteTaskEvidence | undefined;
    const mixedResult = {
      ...preview(),
      overallState: 'partial' as const,
      targetResults: [
        preview().targetResults[0]!,
        {
          target: {
            pluginName: 'demo', pluginId: 'official/demo', sourceId: 'official',
            platform: 'claude' as const, scope: 'project' as const,
          },
          action: 'sync' as const, state: 'failed' as const, errorCode: 'writeFailed',
        },
      ],
    };
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
        if (intent.kind !== 'pluginWriteTask') throw new Error('unexpected intent');
        const evidence = taskEvidence(intent);
        evidence.taskPlan.executableTargets = intent.targets;
        evidence.taskPlan.sources[0]!.requestedTargets = intent.targets;
        evidence.taskPlan.causes = intent.targets.map((requested) => ({
          causeKey: `restore\0${requested.pluginId}\0${requested.platform}\0${requested.scope}`,
          issueId: `restore\0${requested.pluginId}\0${requested.platform}\0${requested.scope}`,
          sourceId: 'official', sourceIdentity: 'identity:official',
          repairTarget: requested, method: 'sync' as const, consumers: [requested],
        }));
        evidence.taskPlan.sources[0]!.causes = evidence.taskPlan.causes;
        evidence.taskPlan.planFingerprint = '';
        evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
        reviewedEvidence = evidence;
        return evidence;
      }),
      executeIntent: vi.fn(async (): Promise<PluginWriteTaskExecutionResult> => ({
        ...mixedResult,
        taskPlan: reviewedEvidence!.taskPlan,
        sourceResults: [{
          sourceId: 'official', sourceIdentity: 'identity:official',
          requestedTargets: reviewedEvidence!.taskPlan.requestedTargets, result: mixedResult,
        }],
      })),
      now: () => 1_000,
      reviewTtlMs: 10_000,
    };
    const value = new TuiController(dependencies);
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: codexTarget, displayName: 'Demo', sourceId: 'official', eligible: true, recommendedMethod: 'sync', issueIds: [] },
      { target: claudeTarget, displayName: 'Demo', sourceId: 'official', eligible: true, recommendedMethod: 'sync', issueIds: [] },
    ]);
    value.push({ name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));

    expect(value.snapshot.result).toMatchObject({
      state: 'partial',
      summary: {
        task: {
          rootResults: [{ pluginId: 'official/demo', state: 'partial' }],
          retryTargets: [claudeTarget],
        },
      },
    });
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Codex · 所有项目');
    expect(frame).toContain('Claude Code · 当前项目');
    expect(frame.match(/Demo/gu)).toHaveLength(1);
    expect(frame).toContain('继续处理剩余 1 项');
    await write(instance, 'y');
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
    expect(clipboard.mock.calls[0]![0]).toContain('official/demo · Claude Code · 当前项目');
    expect(clipboard.mock.calls[0]![0]).toContain('失败 · writeFailed');
    const copied = clipboard.mock.calls[0]![0];
    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn();
    await write(instance, '\u001B[C');
    await write(instance, 'y');
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(2));
    expect(clipboard.mock.calls[1]![0]).toBe(copied);
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(dependencies.captureEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask', targets: [claudeTarget],
    }), expect.any(AbortSignal));
    value.dispose();
  });

  it.each([[80, 24], [60, 18]] as const)(
    'requires an explicit executable-subset choice and shows blocked targets at %ix%i',
    async (columns, rows) => {
      const { value } = controller();
      await value.load();
      const blockedTarget = {
        pluginId: 'official/demo', platform: 'claude' as const, scope: 'project' as const,
      };
      const restorableTarget = {
        pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      };
      vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
        {
          target: restorableTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
          recommendedMethod: 'sync', issueIds: [],
        },
        {
          target: blockedTarget, displayName: 'Demo', sourceId: 'official', eligible: false,
          blockReason: 'manualRecoveryRequired', issueIds: ['manual:demo'],
        },
      ]);
      const startReview = vi.spyOn(value, 'startPluginWriteTaskReview')
        .mockReturnValue({} as ReturnType<TuiController['startPluginWriteTaskReview']>);
      value.push({ name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn();

      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('1 个可执行 · 1 个需决定');
      expect(frame).toContain('需要选择手动处理方式');
      expect(frame).toContain('先处理可执行的 1 个位置');
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
      expect(Math.max(...frame.split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);
      await write(instance, '\r');
      expect(startReview).toHaveBeenCalledWith({
        kind: 'pluginWriteTask', goal: 'restore', targets: [restorableTarget, blockedTarget],
        executionPolicy: 'executableSubset',
      }, { name: 'pluginWriteTask', pluginId: 'official/demo', goal: 'restore' });
      value.dispose();
    },
  );

  it('confirms source activation separately, then does not reuse changed version evidence', async () => {
    const { value } = controller();
    await value.load();
    const listCandidates = vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{
      target, displayName: 'Demo', sourceId: 'official', eligible: false,
      blockReason: 'catalogActivationRequired', issueIds: [],
    }]);
    const prepareSourceReview = vi.spyOn(value, 'startReviewPreparation')
      .mockReturnValue({} as ReturnType<TuiController['startReviewPreparation']>);
    const taskRoute = {
      name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal: 'update' as const,
      targetKeys: ['official/demo\0codex\0user'],
      versionEvidence: { 'official/demo\0codex\0user': '2.0.0' },
    };
    value.push(taskRoute);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('先更新来源目录 official');
    expect(instance.lastFrame()).not.toContain('确认更新 1 个位置');
    await write(instance, '\r');
    expect(prepareSourceReview).toHaveBeenCalledWith({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    }, undefined);

    const changedTarget = {
      ...target,
      expectedUpdate: { ...target.expectedUpdate, activeVersion: '3.0.0' },
    };
    listCandidates.mockReturnValue([{
      target: changedTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
      recommendedMethod: 'sync', issueIds: [],
    }]);
    prepareSourceReview.mockRestore();
    value.replace(taskRoute);
    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('插件目标版本已变化');
    expect(instance.lastFrame()).toContain('使用当前版本重新准备');
    expect(instance.lastFrame()).not.toContain('确认更新 1 个位置');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(instance.lastFrame()).toContain('确认更新到 3.0.0');
    value.dispose();
  });

  it('returns from a real source Review and result to reprepare the retained task', async () => {
    let activated = false;
    const catalogCandidate = {
      sourceId: 'official', sourceConfigFingerprint: 'sha256:source',
      sourceIdentity: 'identity:official', logicalIdentity: 'workspace:official',
      requestedRef: 'path', resolvedCommit: 'path', catalogVersion: '3.0.0',
      channel: 'latest' as const, manifestDigest: `sha256:${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    };
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn(async (intent): Promise<OperationEvidence> => {
        if (intent.kind !== 'catalogGeneration') throw new Error('unexpected intent');
        return {
          catalog: { configDigest: 'sha256:config', compositeDigest: catalogCandidate.snapshotDigest },
          catalogGeneration: {
            action: 'update', candidate: catalogCandidate,
            activationMode: 'normal', configDigest: 'sha256:config',
          },
        };
      }),
      executeIntent: vi.fn(async () => {
        activated = true;
        return { status: 'succeeded' };
      }),
      now: () => 1_000,
      reviewTtlMs: 10_000,
    };
    const value = new TuiController(dependencies);
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation(() => [{
      target: activated
        ? { ...target, expectedUpdate: { ...target.expectedUpdate, activeVersion: '3.0.0' } }
        : target,
      displayName: 'Demo', sourceId: 'official', eligible: activated,
      ...(activated
        ? { recommendedMethod: 'sync' as const }
        : { blockReason: 'catalogActivationRequired' as const }),
      issueIds: [],
    }]);
    const taskRoute = {
      name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal: 'update' as const,
      targetKeys: ['official/demo\0codex\0user'],
      versionEvidence: { 'official/demo\0codex\0user': '2.0.0' },
    };
    value.push(taskRoute);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn();

    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(value.snapshot.activeReview?.operationKind).toBe('catalogGeneration');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    expect(instance.lastFrame()).toContain('重新准备插件更新');
    await write(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual(taskRoute);
    expect(instance.lastFrame()).toContain('插件目标版本已变化');
    expect(instance.lastFrame()).toContain('使用当前版本重新准备');
    expect(instance.lastFrame()).not.toContain('确认更新 1 个位置');
    value.dispose();
  });
});
