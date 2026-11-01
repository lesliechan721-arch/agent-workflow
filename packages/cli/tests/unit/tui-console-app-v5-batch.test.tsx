import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import { type ScopedTaskRequest, scopedPlan, scopedTarget, dependencyPlan, placement } from '../helpers/tui-console-app-fixture.js';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8PluginSummary,
} from '../../src/commands/status-v6.js';

import {
  ConsoleAppV4,
} from '../../src/tui/console-app-v4.js';
import {
  operationEvidenceFingerprint,
  type OperationEvidence,
  type OperationIntent,
  type PluginWriteBatchExecutionResult,
  type PluginWriteTaskEvidence,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  batchEvidenceForIntent,
  controller,
  evidence,
  evidenceForIntent,
  loadResult,
  pluginWriteTaskEvidence,
  pluginWriteTaskExecution,
  setAllPlacementsAbsent,
  target,
  updatePlacement,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  escape,
  focusAction,
  focusBottomAction,
  input,
  nextTurn,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function keepOnlyReadyCodexUserTargets(
  loaded: TuiStatusLoadResult,
  pluginIds: readonly string[],
): void {
  loaded.payload.targets = loaded.payload.targets.map((target) => {
    const clone = setAllPlacementsAbsent(target);
    if (!pluginIds.includes(clone.pluginId) || clone.platform !== 'codex') return clone;
    updatePlacement(clone, 'user', {
      state: 'ready',
      components: [{ kind: 'ownership', key: 'fixture', state: 'present' }],
      reasons: [],
      recoveryActions: [],
    });
    return clone;
  });
}

async function selectAllBatch(instance: ReturnType<typeof render>): Promise<void> {
  await focusBottomAction(instance, '选择工具');
  await input(instance, '\r');
  await focusAction(instance, '全选当前结果');
  await input(instance, '\r');
  await escape(instance);
}

describe('ConsoleAppV4', () => {
  it('opens the recommended update task with exact targets from two roots', async () => {
    const loaded = loadResult();
    const roots = ['official/review-gate', 'team-tools/review-gate'];
    keepOnlyReadyCodexUserTargets(loaded, roots);
    loaded.targetRevisions = roots.map((pluginId) => ({
      pluginId, platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, installedVersion: '0.2.0', availableVersion: '0.4.2' },
    }));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { focusIndex: 0, installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await focusAction(instance, '更新 2 个');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const review = instance.lastFrame() ?? '';
    expect(review).toContain('范围：个人（所有项目）');
    expect(review).toContain('完整请求：official/review-gate、team-tools/review-gate');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'reinstall', scope: 'user',
      exactTargets: [
        { pluginId: 'official/review-gate', agent: 'codex' },
        { pluginId: 'team-tools/review-gate', agent: 'codex' },
      ],
    }), expect.any(AbortSignal));
  });

  it.each(['button', 'shortcut'] as const)(
    'uses the visible recommended-update continuation for the %s path',
    async (activation) => {
      const loaded = loadResult();
      const roots = ['official/review-gate', 'team-tools/review-gate'];
      keepOnlyReadyCodexUserTargets(loaded, roots);
      loaded.targetRevisions = roots.map((pluginId) => ({
        pluginId, platform: 'codex' as const, scope: 'user' as const,
        revision: { state: 'upgradeAvailable' as const, installedVersion: '0.2.0', availableVersion: '0.4.2' },
      }));
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
      await value.load();
      value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(3);

      await input(instance, 'm');
      expect(value.snapshot.router.current.route.name).toBe('batchSelection');
      await selectAllBatch(instance);
      if (activation === 'button') {
        await focusBottomAction(instance, '继续选择任务（2）');
        await input(instance, '\r');
      } else await input(instance, 'c');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));

      expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'recovery', command: 'reinstall', scope: 'user',
        exactTargets: [
          { pluginId: 'official/review-gate', agent: 'codex' },
          { pluginId: 'team-tools/review-gate', agent: 'codex' },
        ],
      }), expect.any(AbortSignal));
    },
  );

  it('completes a real select-many update and removes only its parent batch draft', async () => {
    const loaded = loadResult();
    const roots = ['official/review-gate', 'team-tools/review-gate'];
    keepOnlyReadyCodexUserTargets(loaded, roots);
    loaded.targetRevisions = roots.map((pluginId) => ({
      pluginId, platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, installedVersion: '0.2.0', availableVersion: '0.4.2' },
    }));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => ({
      kind: 'recovery' as const,
      receipt: { ...(plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt,
        targetResults: [scopedTarget(roots[0]!, 'codex', 'applied', 'verified'),
          scopedTarget(roots[1]!, 'codex', 'applied', 'verified')],
      },
    }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask,
    });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const navigate = vi.fn().mockResolvedValue('completed');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onSessionNavigation={navigate} />);
    await nextTurn(3);

    await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'user', command: 'reinstall', exactTargets: [
        { pluginId: roots[0], agent: 'codex' }, { pluginId: roots[1], agent: 'codex' },
      ],
    }), expect.any(AbortSignal));
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask', goal: 'update',
      batchOrigin: { owner: 'batch-write', flowId: expect.any(String) },
    });
    expect(value.snapshot.installPlacementDraft).toBeUndefined();
    await input(instance, '\r');
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await vi.waitFor(() => expect(value.hasSessionDraft).toBe(false));
    expect(instance.lastFrame()).not.toContain('完成，返回我的插件');

    await escape(instance);
    await input(instance, 'h');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(navigate).toHaveBeenCalledWith('home', { discardDrafts: false });
    expect(instance.lastFrame()).not.toContain('放弃未保存修改');
  });

  it('keeps a select-many task draft for retry and clears it only when partial work is finished', async () => {
    const loaded = loadResult();
    const roots = ['official/review-gate', 'team-tools/review-gate'];
    keepOnlyReadyCodexUserTargets(loaded, roots);
    loaded.targetRevisions = roots.map((pluginId) => ({
      pluginId, platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, installedVersion: '0.2.0', availableVersion: '0.4.2' },
    }));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
      const receipt = (plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt;
      const partial = executeScopedTask.mock.calls.length === 1;
      return { kind: 'recovery' as const, receipt: {
        ...receipt, ok: !partial,
        targetResults: partial ? [
          scopedTarget(roots[0]!, 'codex', 'applied', 'verified'),
          scopedTarget(roots[1]!, 'codex', 'failed', 'missing'),
        ] : [scopedTarget(roots[1]!, 'codex', 'applied', 'verified')],
        remainingTargets: partial ? [{ pluginId: roots[1]!, agent: 'codex' as const, scope: 'user' as const,
          delivery: { kind: 'native' as const, platform: 'codex' as const } }] : [],
      } };
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask,
    });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(value.hasSessionDraft).toBe(true);
    let resultFrames = instance.lastFrame() ?? '';
    for (let page = 0; page < 4; page += 1) {
      await input(instance, '\u001B[C');
      resultFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(resultFrames).toContain('official/review-gate · Codex [个人] · 原生 · applied · verified');
    expect(resultFrames).toContain('team-tools/review-gate · Codex [个人] · 原生 · failed · missing');
    await focusAction(instance, '重试明确失败项（1）');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'user', command: 'reinstall',
      exactTargets: [{ pluginId: roots[1], agent: 'codex' }],
    }), expect.any(AbortSignal));
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '返回插件列表');
    await input(instance, '\r');
    await vi.waitFor(() => expect(value.hasSessionDraft).toBe(false));
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
  });

  it('keeps a failed dependency node readable in a partial task result', async () => {
    const intent = {
      kind: 'pluginWriteTask' as const,
      goal: 'restore' as const,
      executionPolicy: 'all' as const,
      targets: [
        { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const },
        { pluginId: 'official/review-gate', platform: 'codex' as const, scope: 'user' as const },
      ],
    };
    const captureEvidence = vi.fn(async (candidate: OperationIntent) => {
      const taskEvidence = pluginWriteTaskEvidence(
        candidate as Extract<OperationIntent, { kind: 'pluginWriteTask' }>,
      );
      const cause = {
        causeKey: 'dependency:official/skill-toolkit',
        issueId: 'dependencyNotReady:official/skill-toolkit',
        sourceId: 'official',
        sourceIdentity: 'identity:official',
        repairTarget: { pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'user' as const },
        method: 'sync' as const,
        consumers: [{ pluginId: 'official/review-gate', platform: 'codex' as const, scope: 'user' as const }],
      };
      taskEvidence.taskPlan.causes = [cause];
      taskEvidence.taskPlan.sources[0]!.causes = [cause];
      taskEvidence.taskPlan.planFingerprint = operationEvidenceFingerprint(taskEvidence);
      return taskEvidence;
    });
    const executeIntent = vi.fn(async (_candidate: OperationIntent, operationEvidence: OperationEvidence) => {
      const execution = pluginWriteTaskExecution(operationEvidence as PluginWriteTaskEvidence);
      const source = execution.sourceResults[0]!;
      const dependencyPlan = {
        requestedPluginIds: ['official/review-gate'],
        resolvedPluginIds: ['official/review-gate', 'official/skill-toolkit'],
        dependencyEdges: [{ from: 'official/review-gate', to: 'official/skill-toolkit', platform: 'codex' as const }],
        scopeOverrides: [],
        targets: [
          {
            pluginId: 'official/review-gate', pluginName: 'review-gate', platform: 'codex' as const,
            relation: 'requested' as const, depth: 0, requiredBy: [], requestedScope: 'user' as const,
            rootScope: 'user' as const, minimumScope: 'user' as const, resolvedScope: 'user' as const,
            allowedScopes: ['user' as const, 'project' as const], assignmentSource: 'root' as const,
            locked: false, affectsOtherProjects: false, state: 'present' as const,
            action: 'keep' as const, order: 0,
          },
          {
            pluginId: 'official/skill-toolkit', pluginName: 'skill-toolkit', platform: 'codex' as const,
            relation: 'dependency' as const, depth: 1, requiredBy: ['official/review-gate'],
            requiredByTargets: [{ pluginId: 'official/review-gate', platform: 'codex' as const, scope: 'user' as const }],
            rootScope: 'user' as const, minimumScope: 'user' as const, resolvedScope: 'user' as const,
            allowedScopes: ['user' as const, 'project' as const], assignmentSource: 'default' as const,
            locked: false, affectsOtherProjects: false, state: 'error' as const,
            action: 'block' as const, errorCode: 'preApplyExited', order: 1,
          },
        ],
      };
      source.result.dependencyPlan = dependencyPlan;
      const requestedRoot = source.result.targetResults.find((entry) =>
        entry.target.pluginId === 'official/review-gate')!;
      requestedRoot.action = 'skipped';
      requestedRoot.state = 'failed';
      requestedRoot.errorCode = 'dependencyNotReady';
      source.result.targetResults.push({
        target: {
          pluginId: 'official/skill-toolkit', pluginName: 'skill-toolkit', sourceId: 'official',
          platform: 'codex', scope: 'user',
        },
        action: 'install', state: 'failed', relation: 'dependency',
        requiredBy: ['official/review-gate'], errorCode: 'preApplyExited',
      });
      source.result.overallState = 'partial';
      execution.dependencyPlan = dependencyPlan;
      execution.targetResults = source.result.targetResults;
      execution.overallState = 'partial';
      return execution;
    });
    const value = controller({ captureEvidence, executeIntent });
    await value.load();
    const review = await value.buildOperationReview(intent);
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 24 }} />);
    await nextTurn(3);
    expect(reviewInstance.lastFrame()).toContain('版本 未知 · 范围 Codex/所有项目');
    reviewInstance.unmount();
    reviewInstance.cleanup();
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 24 }} />);
    await nextTurn(3);

    let frames = instance.lastFrame() ?? '';
    for (let page = 0; page < 4; page += 1) {
      await input(instance, '\u001B[C');
      frames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(frames).toContain('official/review-gate → official/skill-toolkit · Codex · 所有项目');
    expect(frames).toContain('失败 · preApplyExited');
    expect(frames).toContain('继续处理剩余 1 项');
  });

  it('activates a selected candidate source only for its owned frozen batch task', async () => {
    const loaded = loadResult();
    const roots = ['official/review-gate', 'team-tools/review-gate'];
    keepOnlyReadyCodexUserTargets(loaded, roots);
    loaded.targetRevisions = roots.map((pluginId) => ({
      pluginId, platform: 'codex' as const, scope: 'user' as const,
      revision: {
        state: 'current' as const,
        installedVersion: pluginId.startsWith('official/') ? '0.2.1' : '0.4.2',
        availableVersion: pluginId.startsWith('official/') ? '0.2.1' : '0.4.2',
      },
    }));
    const candidateFor = (sourceId: string) => {
      const official = sourceId === 'official';
      const candidate = {
        sourceConfigFingerprint: `sha256:${sourceId}`,
        sourceIdentity: `identity:${sourceId}`,
        logicalIdentity: `workspace:${sourceId}`,
        requestedRef: official ? 'path' : 'catalog/stable',
        resolvedCommit: official ? 'path-next' : 'def456',
        catalogVersion: official ? '1.1.0' : '2.5.0',
        channel: 'latest' as const,
        manifestDigest: `sha256:${(official ? 'b' : 'c').repeat(64)}`,
        snapshotDigest: `sha256:${(official ? 'd' : 'e').repeat(64)}`,
      };
      return {
        sourceId,
        state: 'updateAvailable' as const,
        activeVersion: official ? '1.0.0' : '2.4.0',
        candidate,
        reusableCandidate: {
          sourceConfigFingerprint: candidate.sourceConfigFingerprint,
          activeStoreKey: official ? 'official-active' : 'team-tools-active',
          probe: {
            sourceId,
            candidate,
            manifest: {
              requires: { aw: { capabilities: [] } },
              entries: [{
                name: 'review-gate',
                version: official ? '0.3.0' : '0.5.0',
                manifestDigest: `sha256:${official ? 'f' : '1'}`,
                contentDigest: `sha256:${official ? '2' : '3'}`,
                requires: { aw: { capabilities: [] } },
              }],
            },
          },
        },
      };
    };
    const executeIntent = vi.fn().mockResolvedValue({ status: 'succeeded' });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn(async (sourceId: string) => candidateFor(sourceId)),
      executeIntent,
    });
    await value.load();
    await vi.waitFor(() => expect(value.listPluginWriteTaskCandidates('update')
      .filter((candidate) => roots.includes(candidate.target.pluginId)
        && candidate.blockReason === 'catalogActivationRequired')).toHaveLength(2));
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask',
      targetKeys: expect.arrayContaining([
        'official/review-gate\0codex\0user',
        'team-tools/review-gate\0codex\0user',
      ]),
      batchOrigin: { owner: 'batch-write', flowId: expect.any(String) },
    });
    expect(instance.lastFrame()).toContain('先更新来源目录');

    value.setExternalDraftState([
      ...value.externalDrafts,
      { kind: 'configDraft', owner: 'unrelated\0user', revision: 1 },
    ]);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    expect(executeIntent).not.toHaveBeenCalled();

    await input(instance, 'b');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    await input(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await input(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.result).toBeDefined());
    expect(value.snapshot.result).toMatchObject({ state: 'succeeded', operationKind: 'catalogGeneration' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    expect(value.hasSessionDraft).toBe(true);
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps the select-many entry and explicit confirmation reachable at %ix%i',
    async (columns, rows) => {
      const value = controller();
      await value.load();
      value.push({ name: 'pluginList', mode: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      expect(instance.lastFrame()).toContain('[m] 多选');
      await input(instance, 'm');
      let frame = instance.lastFrame() ?? '';
      expect(frame).toContain('已选 0');
      expect(frame.split('\n')).toSatisfy((lines: string[]) =>
        lines.length <= rows && lines.every((line) => stringWidth(line) <= columns));
      await input(instance, ' ');
      expect(instance.lastFrame()).toContain('已选 1');
      await input(instance, 'c');
      expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    },
  );

  it('returns through batch maintenance and task stages with consecutive Esc presses', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' }, {
      query: 'review', installFilter: 'all', sourceTabId: 'team-tools', focusIndex: 0,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    await focusAction(instance, '其他维护方式');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('其他维护方式');

    await escape(instance);
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    expect(instance.lastFrame()).toContain('› 其他维护方式');
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');

    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
    expect(instance.lastFrame()).toContain('已选 1 个');
    expect(instance.lastFrame()).toContain('› [x] Review Gate');
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    instance.unmount();
  });

  it('returns through batch read-only history and still guards the batch owner exit', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginMore', pluginId: 'team-tools/review-gate',
    });

    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toContain('已选 1 个');
    expect(instance.lastFrame()).toContain('› [x] Review Gate');
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');

    await escape(instance);
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    instance.unmount();
  });

  it('does not treat a separate plugin write task as part of the batch draft owner', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', '\r');
    value.push({
      name: 'pluginWriteTask', pluginId: 'team-tools/review-gate', goal: 'restore',
    });
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginWriteTask', pluginId: 'team-tools/review-gate', goal: 'restore',
    });

    await escape(instance);
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    instance.unmount();
  });

  it('[batch-selection/update-hidden-selected] keeps canonical selections across source and query changes and exposes the complete selected set', async () => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.map((entry) =>
      entry.pluginId === 'team-tools/review-gate' ? setAllPlacementsAbsent(entry) : entry);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse', sourceId: 'official' }, {
      query: 'review', installFilter: 'all', sourceTabId: 'official',
    });
    const standardSize = { columns: 80, rows: 24 };
    const compactSize = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={value} size={standardSize} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(3);

    await input(instance, 'm');
    expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
    trace.push(acceptanceTraceStep(instance, standardSize, '批量选择已打开', ['m']));
    await input(instance, ' ', '\u001B[C');
    expect(instance.lastFrame()).toContain('隐藏 1 个');
    instance.rerender(<ConsoleAppV4 controller={value} size={compactSize} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('隐藏 1 个');
    trace.push(acceptanceTraceStep(instance, compactSize, '缩窄后保留隐藏选择', ['Space', 'ArrowRight', 'resize 60x18']));
    await input(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 2 个');

    await input(instance, '/', '\u0015', 'nomatch');
    await escape(instance);
    expect(instance.lastFrame()).toContain('隐藏 2 个');
    await focusBottomAction(instance, '查看全部已选（2）');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    const selectedFrame = instance.lastFrame() ?? '';
    expect(selectedFrame).toContain('Review Gate');
    expect(selectedFrame.match(/Review Gate/gu)?.length).toBeGreaterThanOrEqual(1);
    expect(selectedFrame.split('\n').length).toBeLessThanOrEqual(18);
    trace.push(acceptanceTraceStep(instance, compactSize, '工具动作打开完整已选集合', ['/', 'Ctrl-U', 'nomatch', 'Esc', 'ArrowDown', 'ArrowDown', 'Enter']));
    instance.rerender(<ConsoleAppV4 controller={value} size={standardSize} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Review Gate');
    trace.push(acceptanceTraceStep(instance, standardSize, '恢复宽屏后保留集合和焦点', ['resize 80x24']));
    await writeAcceptanceTrace('batch-selection/update-hidden-selected', trace);
  });

  it('lets each selected plugin be removed after it becomes ineligible or disappears', async () => {
    const loaded = loadResult();
    for (const entry of loaded.payload.targets) {
      if ((entry.pluginId === 'official/agent-lab' || entry.pluginId === 'official/review-gate')
        && entry.platform === 'codex') {
        updatePlacement(entry, 'user', {
          state: 'ready',
          components: [{ kind: 'ownership', key: 'fixture', state: 'present' }],
        });
      }
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const originalListPlugins = value.listPlugins.bind(value);
    let unavailable = false;
    let missing = false;
    vi.spyOn(value, 'listPlugins').mockImplementation((options) => originalListPlugins(options)
      .filter((plugin) => !missing || plugin.pluginId !== 'official/review-gate')
      .map((plugin) => unavailable && plugin.pluginId === 'official/agent-lab'
        ? { ...plugin, configOnly: true }
        : plugin));
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', '\u001B[B', ' ');
    expect(instance.lastFrame()).toContain('已选 2');
    unavailable = true;
    value.updatePageContext({ focusIndex: 1 });
    await nextTurn(2);
    await input(instance, '\u001B[A', ' ');
    expect(instance.lastFrame()).toContain('已选 1');

    missing = true;
    value.updatePageContext({ focusIndex: 1 });
    await nextTurn(2);
    await input(instance, 'c');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toContain('1 个已选插件已不可用');
    await focusBottomAction(instance, '查看全部已选（1）');
    expect(instance.lastFrame()).toContain('› 查看全部已选（1）');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('official/review-gate');
    expect(instance.lastFrame()).toContain('可取消选择');
    expect(instance.lastFrame()).toContain('› [x] official/review-gate');
    await input(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 0');
  });

  it('uses direct shortcuts and a reversible action jump from the 200th plugin', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 205 }, (_, index): StatusV8PluginSummary => ({
      pluginName: `plugin-${String(index).padStart(3, '0')}`,
      pluginId: `official/plugin-${String(index).padStart(3, '0')}`,
      displayName: `Plugin ${String(index + 1).padStart(3, '0')}`,
      description: `用途说明 ${index}`,
      version: `1.0.${index}`,
      supportedTargets: { codex: ['project'], claude: [] },
      configFieldCount: 0,
    }));
    loaded.payload.targets = loaded.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'project',
      state: 'absent',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });

    await input(instance, '/', 'Plugin 199', '\r', '/', '\u0015', '\r', '\u001B[B');
    expect(value.snapshot.router.current.context.query).toBe('');
    expect(instance.lastFrame()).toContain('› Plugin 200');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);

    const depth = value.snapshot.router.depth;
    await input(instance, '\t');
    expect(instance.lastFrame()).toContain('› Plugin 200');
    await input(instance, 'a');
    expect(instance.lastFrame()).toContain('› 需要处理');
    expect(value.snapshot.router.depth).toBe(depth);
    await input(instance, 'a');
    expect(instance.lastFrame()).toContain('› Plugin 200');
    await input(instance, 'f', 'f');
    expect(instance.lastFrame()).not.toContain('[未安装 205]');
    expect(instance.lastFrame()).toContain('› Plugin 200');
    await input(instance, '/', 'Plugin 200', '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    expect(value.snapshot.router.depth).toBe(depth);
    await input(instance, 'm', ' ');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(instance.lastFrame()).toContain('已选 1');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/plugin-199' });
    await escape(instance);
    expect(value.snapshot.router.current.route.name).toBe('batchSelection');
    expect(instance.lastFrame()).toContain('› [x] Plugin 200');
    expect(instance.lastFrame()).toContain('Plugin 200');
    instance.unmount();
  }, 30_000);

  it.each([[60, 18], [80, 24]] as const)('keeps full batch cards and restores tools to the 50th candidate at %ix%i', async (columns, rows) => {
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 50 }, (_, index): StatusV8PluginSummary => ({
      pluginName: `plugin-${String(index).padStart(2, '0')}`,
      pluginId: `official/plugin-${String(index).padStart(2, '0')}`,
      displayName: `Plugin ${String(index).padStart(2, '0')}`,
      description: `用途说明 ${index}`,
      version: `1.0.${index}`,
      supportedTargets: { codex: ['project'], claude: [] },
      configFieldCount: 0,
    }));
    loaded.payload.targets = loaded.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'project',
      state: 'present',
    }));
    const loadStatus = vi.fn().mockResolvedValue(loaded);
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    await input(instance, 'm');
    expect(instance.lastFrame()).toContain('已选 0');
    expect(instance.lastFrame()).toMatch(/Plugin 00[\s\S]+official/u);
    expect(instance.lastFrame()).toContain('用途说明 0');
    expect(instance.lastFrame()).toContain('版本 1.0.0');
    expect(instance.lastFrame()).toContain('[✓ Codex]');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 1');
    await input(instance, ...Array.from({ length: 49 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› [ ] Plugin 49');
    const beforeTools = instance.lastFrame();
    await input(instance, 'a');
    expect(instance.lastFrame()).toMatch(/› 继续选择任务（1） +\[c\]/u);
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('全选当前结果');
    expect(instance.lastFrame()).toContain('取消当前结果');
    expect(instance.lastFrame()).toContain('清空全部已选');
    await input(instance, '\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› [ ] Plugin 49');
    expect(instance.lastFrame()).toBe(beforeTools);

    await focusBottomAction(instance, '选择工具');
    await input(instance, '\r');
    loaded.pluginSummaries = loaded.pluginSummaries.slice(0, 2);
    loaded.payload.targets = loaded.payload.targets.slice(0, 2);
    await value.load();
    await nextTurn(2);
    await escape(instance);
    expect(instance.lastFrame()).toContain('› [ ] Plugin 01');
    expect((instance.lastFrame()?.match(/›/gu) ?? [])).toHaveLength(1);
    await input(instance, 'c');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
  });

  it('blocks final batch preparation when a selected plugin disappears on the task page', async () => {
    const value = controller();
    await value.load();
    const originalListPlugins = value.listPlugins.bind(value);
    let missing = false;
    vi.spyOn(value, 'listPlugins').mockImplementation((options) => originalListPlugins(options)
      .filter((plugin) => !missing || plugin.pluginId !== 'team-tools/review-gate'));
    value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    missing = true;
    value.updatePageContext({ focusIndex: 0 });
    await nextTurn(2);
    await focusAction(instance, '卸载所选插件');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toContain('已选插件状态已变化');
    expect(value.snapshot.reviewPreparation).toBeUndefined();
  });

  it('selects an installed batch candidate but keeps add disabled when it has no missing location', async () => {
    const loaded = loadResult();
    for (const target of loaded.payload.targets.filter((target) =>
      target.pluginId === 'team-tools/review-gate')) {
      target.state = 'ready';
      target.components = [{ kind: 'ownership', key: 'fixture', state: 'present' }];
      if (target.platform === 'codex') {
        for (const placement of target.placements) {
          placement.state = 'ready';
          placement.components = [{ kind: 'ownership', key: 'fixture', state: 'present' }];
        }
      }
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'm');
    expect(instance.lastFrame()).toMatch(/Review Gate[\s\S]+team-tools/u);
    await input(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 1');
    await input(instance, 'c');
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    expect(instance.lastFrame()).toContain('安装到缺失位置');
    expect(instance.lastFrame()).toContain('当前选择没有可安装位置');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
  });

  it('guards batch selection for h navigation and keeps 100 narrow-screen candidates reachable', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 100 }, (_, index): StatusV8PluginSummary => ({
      pluginName: `plugin-${String(index).padStart(3, '0')}`,
      pluginId: `official/plugin-${String(index).padStart(3, '0')}`,
      displayName: `Plugin ${String(index).padStart(3, '0')}`,
      description: `批量候选 ${index}`,
      version: '1.0.0',
      supportedTargets: { codex: ['project'], claude: [] },
      configFieldCount: 0,
    }));
    loaded.payload.targets = loaded.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'project',
      state: 'present',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const navigate = vi.fn().mockResolvedValue('draftBlocked');
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onSessionNavigation={navigate}
    />);
    await nextTurn(2);

    await input(instance, 'm');
    expect(instance.lastFrame()).toContain('Plugin 000');
    await selectAllBatch(instance);
    expect(instance.lastFrame()).toContain('已选 100 个');
    await input(instance, 'a', '\u001B[A');
    expect(instance.lastFrame()).toContain('Plugin 099');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, 'h');
    expect(navigate).toHaveBeenCalledWith('home', { discardDrafts: false });
    expect(instance.lastFrame()).toContain('放弃未保存修改');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    await input(instance, 'b', 'H');
    expect(navigate).toHaveBeenLastCalledWith('reload', { discardDrafts: false });
    expect(instance.lastFrame()).toContain('放弃未保存修改');
    instance.unmount();
  });

  it('scrolls a 100-target batch Result to both ends and Esc restores installed list context', async () => {
    const root = 'team-tools/review-gate';
    const secondRoot = 'team-tools/second-root';
    const targetResults = Array.from({ length: 100 }, (_, index) => ({
      target: {
        pluginName: index < 2 ? 'Review Gate' : `target-${String(index).padStart(3, '0')}`,
        pluginId: index === 0 ? root : index === 1 ? secondRoot : `team-tools/target-${String(index).padStart(3, '0')}`,
        sourceId: 'team-tools',
        platform: index === 1 ? 'claude' as const : 'codex' as const,
        scope: index === 1 ? 'user' as const : 'project' as const,
      },
      state: 'completed' as const,
      relation: index < 2 ? 'requested' as const : 'transitive' as const,
      ...(index < 2 ? {} : { requiredBy: [root] }),
    }));
    const rebuild = {
      platforms: ['codex'], plugins: [root, secondRoot], warnings: [], rebuildResults: [], receiptTargets: [],
      overallState: 'succeeded' as const, targetResults,
    };
    const captureEvidence = vi.fn(async (intent: OperationIntent) => intent.kind === 'pluginWriteBatch'
      ? {
          ...evidence,
          requestedPluginIds: [root, secondRoot],
          groups: [{
            groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex' as const,
            scope: 'project' as const,
            requestedPluginIds: [root, secondRoot], preview: rebuild, executable: false,
          }],
        }
      : evidence);
    const execution: PluginWriteBatchExecutionResult = {
      ...rebuild,
      requestedPluginIds: [root, secondRoot],
      groupResults: [{
        groupId: 'team-tools:codex', sourceId: 'team-tools', platform: 'codex',
        scope: 'project',
        requestedPluginIds: [root, secondRoot], result: rebuild,
      }],
    };
    const value = controller({ captureEvidence, executeIntent: vi.fn().mockResolvedValue(execution) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    value.updatePageContext({ query: 'review', focusIndex: 0, scrollOffset: 0 });
    value.beginPluginWriteBatch();
    await value.buildOperationReview({
      kind: 'pluginWriteBatch', action: 'sync',
      selection: { kind: 'selected', pluginIds: [root, secondRoot] },
      platform: 'codex', scope: 'project',
    }, { name: 'batchPlacement' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, '\r');
    await nextTurn(4);

    let resultFrames = instance.lastFrame() ?? '';
    expect(resultFrames).toContain('Review Gate');
    expect(resultFrames).toContain('1 / 26');
    await input(instance, '\u001B[C');
    resultFrames += `\n${instance.lastFrame() ?? ''}`;
    for (let page = 0; page < 110; page += 1) {
      await input(instance, '\u001B[C');
      resultFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(resultFrames).toContain('Review Gate · Codex · 当前项目');
    expect(resultFrames).toContain('target-099');
    expect(instance.lastFrame()).toContain('target-099');
    expect(instance.lastFrame()).toContain('26 / 26');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(value.snapshot.router.current.context).toMatchObject({ query: 'review', focusIndex: 0 });
    expect(value.snapshot.result).toBeUndefined();
    instance.unmount();
  });

  it.each(['page', 'help', 'discard', 'sessionNavigation', 'tooSmall'] as const)(
    'keeps the batch draft until explicit exit confirmation from %s',
    async (origin) => {
      const exit = vi.fn();
      const navigate = vi.fn().mockResolvedValue('draftBlocked');
      const value = controller();
      await value.load();
      value.push({ name: 'pluginList', mode: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
        onExit={exit} onSessionNavigation={navigate} />);
      await nextTurn(3);
      await input(instance, 'm');
      expect(value.hasSessionDraft).toBe(true);

      if (origin === 'help') await input(instance, '?');
      if (origin === 'discard') await escape(instance);
      if (origin === 'sessionNavigation') {
        await input(instance, 'h');
        await vi.waitFor(() => expect(instance.lastFrame()).toContain('放弃未保存修改？'));
      }
      if (origin === 'tooSmall') {
        instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 17 }}
          onExit={exit} onSessionNavigation={navigate} />);
        await nextTurn(2);
        expect(instance.lastFrame()).toContain('终端空间不足');
      }

      await input(instance, '\u0003');
      expect(instance.lastFrame()).toContain('放弃未保存修改？');
      expect(instance.lastFrame()).toContain('放弃后将退出控制台。');
      expect(exit).not.toHaveBeenCalled();
      expect(value.hasSessionDraft).toBe(true);
      await input(instance, '\u0003');
      expect(exit).not.toHaveBeenCalled();
      expect(value.hasSessionDraft).toBe(true);

      await input(instance, '\u001B[B', '\r');
      expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
      expect(value.hasSessionDraft).toBe(false);
    },
  );

  it('keeps search results multi-selectable from the shared plugin row sequence', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'review');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('[m] 多选');
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, 'm');
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
  });

  it('adds only missing exact targets and requires an explicit executable subset choice', async () => {
    const loaded = loadResult();
    const codex = loaded.payload.targets.find((target) =>
      target.pluginId === 'official/agent-lab' && target.platform === 'codex')!;
    const placement = codex.platform === 'codex'
      ? codex.placements.find((entry) => entry.scope === 'project')! : undefined;
    placement!.state = 'ready';
    placement!.components = [{ kind: 'ownership', key: 'fixture', state: 'present' }];
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', '\u001B[B', ' ', 'c', '\r');
    await nextTurn(2);
    let frame = instance.lastFrame() ?? '';
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallPlatforms' });
    expect(frame).toContain('选择安装平台');
    expect(frame).toContain('确定所选平台');
    expect(frame).not.toContain('在哪里使用');
    await input(instance, 'c');
    await nextTurn(2);
    frame = instance.lastFrame() ?? '';
    expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallScope' });
    expect(frame).toContain('在哪里使用');
    expect(frame).not.toContain('用于哪个工具');
    expect(frame).toContain('查看全部位置和受阻原因');
    expect(frame).toContain('仅添加可执行的 2 个位置');

    await focusAction(instance, '查看全部位置和受阻原因');
    await input(instance, '\r');
    frame = instance.lastFrame() ?? '';
    expect(frame).toContain('official/agent-lab · Codex');
    expect(frame).toContain('已有，不重复添加');
    await focusAction(instance, 'official/review-gate · Claude Code · 当前项目');
    frame = instance.lastFrame() ?? '';
    expect(frame).toContain('受阻：插件不支持所选工具或位置');
    await escape(instance);
    expect(instance.lastFrame()).toContain('仅添加可执行的 2 个位置');

    await input(instance, '\u001B[B', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    const request = prepareScopedTask.mock.calls.at(-1)?.[0];
    expect(request).toMatchObject({ kind: 'recovery', command: 'install', scope: 'project',
      exactTargets: [
        { pluginId: 'official/agent-lab', agent: 'claude-code' },
        { pluginId: 'official/review-gate', agent: 'codex' },
      ],
    });
    expect(request && request.kind === 'recovery' ? request.exactTargets : []).not.toContainEqual({
      pluginId: 'official/agent-lab', agent: 'codex',
    });
  });

  it('moves batch search focus within the rendered candidate collection', async () => {
    const value = controller();
    await value.load();
    const expected = value.listPlugins({ mode: 'browse' });
    expect(expected.length).toBeGreaterThan(1);
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'm', '/', '\u001B[B');

    expect(value.snapshot.router.current.route).toEqual({ name: 'batchSelection' });
    expect(instance.lastFrame()).toContain(`› [ ] ${expected[1]!.displayName}`);
  });

  it('keeps every batch placement result reachable at 60 x 18', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 30 }, (_, index): StatusV7PluginSummary => {
      const pluginName = `plugin-${String(index).padStart(2, '0')}`;
      return {
        pluginName,
        pluginId: `official/${pluginName}`,
        displayName: `Plugin ${String(index).padStart(2, '0')}`,
        description: `批量位置测试插件 ${index}`,
        version: '1.0.0',
        supportedTargets: {
          codex: ['project'],
          claude: index % 2 === 0 ? ['project'] : [],
        },
        configFieldCount: 0,
      };
    });
    loaded.payload.targets = loaded.pluginSummaries.flatMap((summary) =>
      (['codex', 'claude'] as const).flatMap((platform) =>
        (summary.supportedTargets?.[platform] ?? []).map((scope) => target({
          pluginName: summary.pluginName,
          platform,
          scope,
          state: 'absent',
        }))),
    );
    loaded.sourceDetails = loaded.sourceDetails.map((source) => ({
      ...source,
      pluginCount: source.id === 'official' ? loaded.pluginSummaries.length : 0,
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c', '\r', 'c');
    await nextTurn(2);
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    expect(instance.lastFrame()).toContain('↑↓ 移动 · Enter 选择 · Esc 返回修改');
    await focusAction(instance, '查看全部位置和受阻原因');
    await nextTurn(3);
    await input(instance, '\r');
    await focusAction(instance, 'official/plugin-29 · Claude Code · 当前项目', 100);
    expect(instance.lastFrame()).toContain('受阻：插件不支持所选工具或位置');
    expect(instance.lastFrame()).toContain('↑↓ 查看全部位置 · Esc 返回位置选择');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);

    await escape(instance);
    expect(instance.lastFrame()).toContain('30 个插件');
    expect(instance.lastFrame()).toContain('仅添加可执行的 45 个位置');
    expect(instance.lastFrame()).toContain('↑↓ 移动 · Enter 选择 · Esc 返回修改');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    [60, 18, 'enter'],
    [60, 18, 'shortcut'],
    [60, 18, 'fixed'],
    [80, 24, 'enter'],
    [80, 24, 'shortcut'],
    [80, 24, 'fixed'],
  ] as const)(
    'moves from batch platforms to exact targets at %ix%i with the %s confirmation',
    async (columns, rows, confirmation) => {
      const value = controller({
        captureEvidence: vi.fn(async (intent: OperationIntent) =>
          intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent)),
      });
      await value.load();
      value.push({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);

      await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c', '\r');
      await nextTurn(2);
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallPlatforms' });
      expect(instance.lastFrame()).toContain('› ● Codex');
      expect(instance.lastFrame()).toContain('● Claude Code');
      expect(instance.lastFrame()).not.toContain('在哪里使用');
      expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, ' ');
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallPlatforms' });
      expect(instance.lastFrame()).toContain('○ Codex');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallPlatforms' });
      expect(instance.lastFrame()).toContain('● Codex');

      if (confirmation === 'enter') {
        await input(instance, '\u001B[B', '\u001B[B', '\r');
      } else if (confirmation === 'fixed') {
        await input(instance, 'a', '\r');
      } else await input(instance, 'c');
      await nextTurn(2);
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallScope' });
      expect(instance.lastFrame()).toContain('在哪里使用');
      expect(instance.lastFrame()).toContain('查看全部位置和受阻原因');
      expect(instance.lastFrame()).not.toContain('用于哪个工具');
      expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);

      await escape(instance);
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallPlatforms' });
      expect(instance.lastFrame()).toContain('● Codex');
      expect(instance.lastFrame()).toContain('● Claude Code');
      await input(instance, 'c');
      await nextTurn(2);
      expect(value.snapshot.router.current.route).toEqual({ name: 'batchInstallScope' });
      await input(instance, 'c');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(value.dependencies.prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'recovery', command: 'install', exactTargets: expect.arrayContaining([
          { pluginId: 'official/agent-lab', agent: 'codex' },
          { pluginId: 'official/agent-lab', agent: 'claude-code' },
        ]),
      }), expect.any(AbortSignal));
    },
  );

  it.each([
    ['来源不可用', 'sourceUnavailable'],
    ['能力不足', 'capabilityUnsupported'],
  ] as const)('allows an installed plugin with %s to reach maintenance Review', async (_label, condition) => {
    const loaded = loadResult();
    if (condition === 'sourceUnavailable') {
      const source = loaded.payload.catalog.sources.find((entry) => entry.id === 'team-tools')!;
      source.error = 'unavailable';
      source.errorCode = 'catalogSourceUnavailable';
    } else {
      const summary = loaded.pluginSummaries.find((entry) => entry.pluginId === 'team-tools/review-gate')!;
      summary.missingCapabilities = ['aw.future-feature.v1'];
    }
    const codex = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex')!;
    updatePlacement(codex, 'project', { state: 'absent', components: [
      { kind: 'ownership', key: 'fixture', state: 'absent' },
    ] });
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'team-tools/review-gate' || entry.platform !== 'claude');
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    expect(instance.lastFrame()).toContain('为 1 个插件选择任务');
    await focusAction(instance, '其他维护方式');
    await input(instance, '\r');
    await focusAction(instance, '同步已保存使用设置');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'sync', scope: 'user',
      exactTargets: expect.arrayContaining([
        { pluginId: 'team-tools/review-gate', agent: 'codex' },
      ]),
    }), expect.any(AbortSignal));
  });

  it.each([
    ['fixed', 0],
    ['shortcut', 12],
  ] as const)('opens a 24-target maintenance Review from the %s action without changing the exact selection', async (
    confirmation,
    focusSteps,
  ) => {
    // Risk: the fixed maintenance confirmation can rebuild a different target set than the visible toggles.
    const loaded = loadResult();
    loaded.pluginSummaries = Array.from({ length: 12 }, (_, index): StatusV8PluginSummary => {
      const suffix = String(index + 1).padStart(2, '0');
      return {
        pluginName: `maintenance-${suffix}`,
        pluginId: `official/maintenance-${suffix}`,
        displayName: `Maintenance ${suffix}`,
        description: `Maintenance fixture ${suffix}`,
        version: '1.0.0',
        supportedTargets: { codex: ['user'], claude: ['user'] },
        configFieldCount: 0,
      };
    });
    loaded.payload.targets = loaded.pluginSummaries.flatMap((summary) => [
      target({ pluginName: summary.pluginName, platform: 'codex', scope: 'user', state: 'present' }),
      target({ pluginName: summary.pluginName, platform: 'claude', scope: 'user', state: 'present' }),
    ]);
    loaded.sourceDetails = loaded.sourceDetails.map((source) => ({
      ...source,
      pluginCount: source.id === 'official' ? loaded.pluginSummaries.length : 0,
    }));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm');
    await selectAllBatch(instance);
    await input(instance, 'c');
    await focusAction(instance, '卸载所选插件');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    await focusAction(instance, '修改处理范围');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('24/24 个位置');
    await input(instance, ...Array.from({ length: focusSteps }, () => '\u001B[B'));

    if (confirmation === 'fixed') {
      await input(instance, 'a');
      expect(instance.lastFrame()).toContain('› 查看批量卸载确认');
      await input(instance, '\r');
    } else {
      await input(instance, 'c');
    }
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    expect(prepareScopedTask).toHaveBeenCalledTimes(2);
    expect(prepareScopedTask.mock.calls[1]![0]).toMatchObject({
      kind: 'recovery', command: 'uninstall', scope: 'user',
      exactTargets: expect.arrayContaining([
        { pluginId: 'official/maintenance-01', agent: 'codex' },
        { pluginId: 'official/maintenance-12', agent: 'claude-code' },
      ]),
    });
    expect((prepareScopedTask.mock.calls[1]![0] as Extract<ScopedTaskRequest, { kind: 'recovery' }>).exactTargets)
      .toHaveLength(24);
  });

  it('returns a successful one-plugin multi-location uninstall batch to stable detail', async () => {
    const intent = {
      kind: 'pluginWriteBatch' as const,
      action: 'uninstall' as const,
      selection: {
        kind: 'targets' as const,
        targets: [
          { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'project' as const },
          { pluginId: 'official/agent-lab', platform: 'claude' as const, scope: 'user' as const },
        ],
      },
      platform: 'both' as const,
      scope: 'project' as const,
    };
    const batchEvidence = batchEvidenceForIntent(intent);
    const groupResults = batchEvidence.groups.map((group) => ({
      groupId: group.groupId,
      sourceId: group.sourceId,
      platform: group.platform,
      scope: group.scope,
      requestedPluginIds: group.requestedPluginIds,
      result: {
        ...group.preview,
        targetResults: intent.selection.targets
          .filter((target) => target.platform === group.platform && target.scope === group.scope)
          .map((target) => ({
            target: { ...target, pluginName: 'agent-lab', sourceId: 'official' },
            action: 'uninstall', state: 'completed' as const, requiredBy: [],
          })),
      },
    }));
    const execution = {
      platforms: ['codex', 'claude'], plugins: ['official/agent-lab'], warnings: [],
      rebuildResults: [], receiptTargets: [], targetResults: groupResults.flatMap((group) => group.result.targetResults),
      overallState: 'succeeded', requestedPluginIds: ['official/agent-lab'], groupResults,
    } as PluginWriteBatchExecutionResult;
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue(batchEvidence),
      executeIntent: vi.fn().mockResolvedValue(execution),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const review = await value.buildOperationReview(intent);
    await value.executeOperation(review.reviewToken);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.completionNotice).toMatchObject({
      pluginId: 'official/agent-lab', title: '插件卸载完成',
    });
  });
  it('retries only a failed batch root through a new scoped Review and returns to the installed list', async () => {
    const root = 'team-tools/review-gate';
    const loaded = loadResult();
    const codex = loaded.payload.targets.find((entry) =>
      entry.pluginId === root && entry.platform === 'codex')!;
    updatePlacement(codex, 'user', { state: 'absent', components: [
      { kind: 'ownership', key: 'fixture', state: 'absent' },
    ] });
    updatePlacement(codex, 'project', { state: 'ready', components: [
      { kind: 'ownership', key: 'fixture', state: 'present' },
    ] });
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== root || entry.platform !== 'claude');
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => {
      const first = executeScopedTask.mock.calls.length === 1;
      return { kind: 'recovery' as const, receipt: {
        ...(plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt,
        ok: !first,
        targetResults: [scopedTarget(root, 'codex', first ? 'failed' : 'applied',
          first ? 'missing' : 'verified')].map((target) => ({ ...target, scope: 'project' as const })),
      } };
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { query: 'review', installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    await focusAction(instance, '其他维护方式');
    await input(instance, '\r');
    await focusAction(instance, '同步已保存使用设置');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('重试明确失败项（1）'));
    await focusAction(instance, '重试明确失败项（1）');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'project', command: 'sync',
      exactTargets: [{ pluginId: root, agent: 'codex' }],
    }), expect.any(AbortSignal));
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '返回插件列表');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    expect(executeScopedTask).toHaveBeenCalledTimes(2);
  });

  it('canonicalizes reverse-order batch choices before scoped Review and preserves them across timeout edit', async () => {
    const loaded = loadResult();
    const official = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    updatePlacement(official, 'project', { state: 'ready', components: [
      { kind: 'ownership', key: 'fixture', state: 'present' },
    ] });
    const team = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex')!;
    updatePlacement(team, 'user', { state: 'absent', components: [
      { kind: 'ownership', key: 'fixture', state: 'absent' },
    ] });
    updatePlacement(team, 'project', { state: 'ready', components: [
      { kind: 'ownership', key: 'fixture', state: 'present' },
    ] });
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', '\u001B[B', ' ', 'c');
    await focusAction(instance, '其他维护方式');
    await input(instance, '\r');
    await focusAction(instance, '同步已保存使用设置');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const firstRequest = prepareScopedTask.mock.calls[0]![0];
    expect(firstRequest).toMatchObject({ kind: 'recovery', command: 'sync', scope: 'project',
      selectors: ['official/review-gate', 'team-tools/review-gate'],
      exactTargets: [
        { pluginId: 'official/review-gate', agent: 'codex' },
        { pluginId: 'team-tools/review-gate', agent: 'claude-code' },
        { pluginId: 'team-tools/review-gate', agent: 'codex' },
      ],
    });
    const firstPlan = await prepareScopedTask.mock.results[0]!.value;
    await focusAction(instance, '修改脚本超时');
    await input(instance, '\r', '\u0015', '4500', '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledTimes(2);
    expect(prepareScopedTask.mock.calls[1]![0]).toEqual({ ...firstRequest, scriptTimeoutMs: 4_500 });
    expect((firstPlan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.context.dispose)
      .toHaveBeenCalledTimes(1);
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it.each([
    ['sync', '同步已保存使用设置', true],
    ['reinstall', '重新安装', true],
    ['uninstall', '卸载所选插件', false],
    ['cleanup', '清理遗留内容', true],
  ] as const)('lets batch %s edit exact existing locations in one scope', async (
    expectedAction, actionLabel, opensMaintenance,
  ) => {
    const loaded = loadResult();
    const codex = loaded.payload.targets.find((target) =>
      target.pluginId === 'team-tools/review-gate' && target.platform === 'codex')!;
    updatePlacement(codex, 'user', { state: 'ready', components: [
      { kind: 'ownership', key: 'fixture', state: 'present' },
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: ['user'], relation: 'root',
      } },
    ] });
    updatePlacement(codex, 'project', { state: 'absent', components: [
      { kind: 'ownership', key: 'fixture', state: 'absent' },
    ] });
    const claude = target({ pluginName: 'review-gate', sourceId: 'team-tools',
      platform: 'claude', scope: 'user', state: 'present' });
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'team-tools/review-gate' || entry.platform !== 'claude').concat(claude);
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, 'm', ' ', 'c');
    if (opensMaintenance) {
      await focusAction(instance, '其他维护方式');
      await input(instance, '\r');
    }
    await focusAction(instance, actionLabel);
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    const firstRequest = prepareScopedTask.mock.calls[0]![0];
    expect(firstRequest).toMatchObject({ kind: 'recovery', command: expectedAction,
      scope: 'user', exactTargets: expect.arrayContaining([
        { pluginId: 'team-tools/review-gate', agent: 'codex' },
        { pluginId: 'team-tools/review-gate', agent: 'claude-code' },
      ]),
    });
    const firstPlan = await prepareScopedTask.mock.results[0]!.value;
    await focusAction(instance, '修改处理范围');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('2/2 个位置');
    expect((firstPlan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.context.dispose)
      .toHaveBeenCalledTimes(1);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('1/2 个位置');
    await focusAction(instance, `查看批量${{
      sync: '同步', reinstall: '重新安装', uninstall: '卸载', cleanup: '清理',
    }[expectedAction]}确认`);
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('确认恢复可执行目标'));
    expect(prepareScopedTask).toHaveBeenCalledTimes(2);
    expect(prepareScopedTask.mock.calls[1]![0]).toMatchObject({
      kind: 'recovery', command: expectedAction, scope: 'user',
      exactTargets: [{ pluginId: 'team-tools/review-gate', agent: 'codex' }],
    });
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

});
