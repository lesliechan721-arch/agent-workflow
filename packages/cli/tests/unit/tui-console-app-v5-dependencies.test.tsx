import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import { type ScopedTaskRequest, scopedPlan, scopedTarget, mixedScopeConflictTarget } from '../helpers/tui-console-app-fixture.js';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8CodexTarget,
} from '../../src/commands/status-v6.js';
import {
  createDependencyPlacementPlan,
  type DependencyOperationPlan,
} from '../../src/commands/dependency-operation-plan.js';
import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import { TuiOperationBlockedError, type OperationIntent, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { buildDependencyGraphProjection } from '../../src/tui/dependency-graph.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import { controller, dependencyLoadResult, dependencyPlan, evidence, loadResult, placement, placementPlanFor, target, updatePlacement } from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  confirmReview,
  focusAction,
  input,
  nextTurn,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

async function readScopedDetails(instance: ReturnType<typeof render>): Promise<string> {
  await input(instance, 'd');
  const frames: string[] = [];
  for (let page = 0; page < 20; page += 1) {
    const frame = instance.lastFrame() ?? '';
    frames.push(frame);
    const pager = frame.match(/(\d+)\s*\/\s*(\d+)/u);
    expect(pager).not.toBeNull();
    if (pager![1] === pager![2]) {
      await input(instance, 'd');
      return frames.join('\n');
    }
    await input(instance, '\u001B[C');
  }
  throw new Error('The technical details did not reach the last page.');
}

function forceCleanupLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  const offlineTarget = loaded.payload.targets.find((entry) =>
    entry.pluginId === 'team-tools/review-gate'
    && entry.platform === 'codex')!;
  const offlinePlacement = placement(offlineTarget, 'user');
  offlineTarget.state = 'blocked';
  offlinePlacement.state = 'blocked';
  offlineTarget.reasons = offlinePlacement.reasons = [{
    code: 'bundleUnavailable',
    message: 'Catalog no longer contains this plugin.',
    severity: 'blocking',
  }];
  offlineTarget.recoveryActions = offlinePlacement.recoveryActions = [{
    command: 'cleanup',
    scope: 'user',
    description: 'Clean only AW-owned content for this exact target.',
  }];
  return loaded;
}

describe('ConsoleAppV4', () => {
  it('shows a blocked dependency and opens its recovery page before installation', async () => {
    const failure = new TuiOperationBlockedError('dependencyScopeConflict', 'Dependency blocked.', [{
      id: 'dependency-block', code: 'dependencyScopeConflict', stage: 'dependencyPlan',
      safeMessage: '这个依赖的安装位置存在冲突，需要先选择保留的位置。',
      target: { pluginId: 'official/review-gate', platform: 'codex', scope: 'user' },
      causes: [], detailLines: [],
    }]);
    const executeIntent = vi.fn();
    const value = controller({ captureEvidence: vi.fn().mockRejectedValue(failure), executeIntent });
    await value.load();
    const intent = {
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    } as const;
    await expect(value.buildOperationReview(intent)).rejects.toBe(failure);
    value.startReviewPreparation(intent);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 32 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('official/review-gate');
    expect(instance.lastFrame()).toContain('安装位置存在冲突');
    await focusAction(instance, `处理 ${value.getPluginOverview('official/review-gate')!.displayName}`);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'official/review-gate', platform: 'codex',
    });
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('shows the actual dependency collision on the failed preparation page', async () => {
    const value = controller({
      prepareReviewEvidence: async (_intent, _signal, onStage) => {
        await onStage('dependencyPlan');
        throw new TuiOperationBlockedError('taskNoExecutableTargets', 'private raw error', [{
          id: 'collision', code: 'artifactCollision', stage: 'dependencyPlan',
          target: { pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user' },
          safeMessage: '输出位置存在外来内容，无法覆盖。', causes: [], detailLines: [],
        }]);
      },
    });
    value.startReviewPreparation({
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'team-tools/review-gate',
      platform: 'codex', scope: 'user',
    });
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 120, rows: 32 }} />);
    await nextTurn(2);
    const frame = instance.lastFrame()!;
    expect(frame).toContain('输出位置存在外来内容');
    expect(frame).toContain('artifactCollision');
    expect(frame).not.toContain('private raw error');
  });

  it('reaches the last dependency relation at 60x18', async () => {
    const loaded = dependencyLoadResult();
    const overview = loaded.dependencyOverviews![0]!;
    overview.dependencies = Array.from({ length: 20 }, (_, index) => ({
      ...overview.dependencies[0]!,
      pluginId: `official/dependency-${index}`,
      displayName: `Dependency ${index}`,
    }));
    overview.summary = { ...overview.summary, directCount: 20, totalCount: 20 };
    const projection = buildDependencyGraphProjection({
      overviews: loaded.dependencyOverviews!, rootPluginId: overview.pluginId,
    });
    expect(projection.rows.map((row) => row.label)).toContain('Dependency 19');
    expect(projection.rows).toHaveLength(23);
  });

  it('shows dependency installation content, opens the single relation route, and keeps a plugin without dependencies on P04', async () => {
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D09');
    expect(instance.lastFrame()).toContain('依赖关系');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    expect(instance.lastFrame()).not.toContain('planDigest');
    await focusAction(instance, '依赖关系');
    await input(instance, '\r');
    expect(screens).toContain('D02');
    expect(instance.lastFrame()).toContain('安装所需插件');
    expect(instance.lastFrame()).toMatch(/◆ Agent Lab +\[当前/u);
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('A → B 表示 A 需要 B');
    expect(instance.lastFrame()).toMatch(/›[^\n]*◆ Agent Lab +\[当前/u);
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/agent-lab' });

    const plain = controller();
    await plain.load();
    plain.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const plainInstance = render(<ConsoleAppV4 controller={plain} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(plainInstance.lastFrame()).not.toContain('依赖关系');
    expect(plain.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/review-gate' });
  });

  it('keeps cleanup available without catalog-only actions for a removed plugin with known relations', async () => {
    const loaded = dependencyLoadResult({ rootState: 'error',
      rootErrorCode: 'removedPluginCleanupRequired' });
    loaded.pluginSummaries = loaded.pluginSummaries.filter((summary) =>
      summary.pluginId !== 'official/agent-lab');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await focusAction(instance, '清理已删除插件');
    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('内容详情');
    expect(frame).not.toContain('在同一关系图中查看使用者和所需插件');
    expect(frame).not.toContain('安装到其他位置');
  });

  it('keeps readonly dependency information and direct action focus visible on D01 at 60x18', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D09');
    expect(frame).toContain('依赖关系');
    expect(frame).not.toContain('Agent Skill Toolkit');
    expect(frame).not.toContain('› Agent Lab');
    expect(frame).toContain('› 添加插件…');
    expect(frame).toContain('↑↓ 连续阅读与选择');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('› 添加插件…');

    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    await focusAction(instance, '查看插件来源');
    const lastActionFrame = instance.lastFrame() ?? '';
    expect(lastActionFrame).toContain('› 查看插件来源');
    expect(lastActionFrame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(lastActionFrame.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('keeps every D01 action reachable with eight dependencies at 80x24', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const overview = loaded.dependencyOverviews?.find((entry) => entry.pluginId === 'official/agent-lab');
    expect(overview).toBeDefined();
    overview!.summary = { directCount: 4, transitiveCount: 4, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 0 };
    overview!.dependencies.push(
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/direct-${index}`,
        displayName: `Direct ${index}`,
        relation: 'direct' as const,
        depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: index === 2 ? 'needsAttention' as const : 'notInstalled' as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/transitive-${index}`,
        displayName: `Transitive ${index}`,
        relation: 'transitive' as const,
        depth: 2,
        requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: 'notInstalled' as const,
      })),
    );
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('依赖关系');
    expect(instance.lastFrame()).toContain('Direct 2');
    expect(instance.lastFrame()).not.toContain('› Agent Lab');
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('› 添加插件…');
    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    for (const label of ['查看插件来源', '诊断与技术详情']) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
    await focusAction(instance, '查看插件来源');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('previews the configured Agents before preparing an install from plugin details', async () => {
    const loaded = loadResult();
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask, executeScopedTask });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const preview = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await focusAction(preview, '更多操作');
    await input(preview, '\r');
    expect(preview.lastFrame()).not.toContain('通用 Agent Skills');
    expect(preview.lastFrame()).not.toContain('在其他 Agent 使用');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await input(preview, 'b');
    await focusAction(preview, '添加插件…');
    await input(preview, '\r');
    const scopeFrame = preview.lastFrame() ?? '';
    expect(scopeFrame).toContain('选择使用范围');
    expect(scopeFrame).toContain('◆ Codex');
    expect(scopeFrame).toContain('◆ Claude Code');
    expect(scopeFrame).not.toContain('通用 Agent Skills');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it('mounts dependency placement, target platforms, installed detail, and installed relation templates', async () => {
    const available = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await available.load();
    const availableScreens = new Set<ConsoleV4ScreenId>();
    available.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const placement = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D03');
    expect(placement.lastFrame()).toContain('选择使用范围');
    expect(placement.lastFrame()).toContain('◆ Codex');
    expect(placement.lastFrame()).toContain('◆ Claude Code');
    expect(placement.lastFrame()).not.toContain('缺失依赖使用同一个位置');
    expect(placement.lastFrame()?.match(/›/gu)).toHaveLength(1);
    placement.unmount();

    available.replace({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const targetsPage = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D04');
    expect(targetsPage.lastFrame()).toContain('选择使用范围');
    expect(targetsPage.lastFrame()).toContain('◆ Codex');
    expect(targetsPage.lastFrame()?.match(/›/gu)).toHaveLength(1);
    targetsPage.unmount();

    const installed = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })) });
    await installed.load();
    const installedScreens = new Set<ConsoleV4ScreenId>();
    installed.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const detail = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D09');
    await focusAction(detail, '依赖关系');
    await input(detail, '\r');
    expect(installed.snapshot.router.current.route).toEqual({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    expect(detail.lastFrame()).toContain('依赖与当前可用关系');
    detail.unmount();

    installed.replace({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const relations = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D10');
    expect(relations.lastFrame()).toContain('依赖与当前可用关系');
    expect(relations.lastFrame()).toMatch(/◆ Agent Lab +\[当前/u);
    expect(relations.lastFrame()).not.toContain('› Agent Skill Toolkit');
  });

  it('runs scope to platform to per-target placement to Review and restores the draft on Back', async () => {
    const planFor = (intent: OperationIntent): DependencyOperationPlan => {
      if (intent.kind !== 'pluginWrite') throw new Error('expected plugin write');
      const plan = placementPlanFor(intent);
      if (!intent.dependencyScopeOverrides?.length) {
        const platformRequired = plan.targets.find((target) =>
          target.pluginId === 'official/content-toolkit' && target.platform === 'codex');
        if (platformRequired) {
          platformRequired.minimumScope = 'user';
          platformRequired.resolvedScope = 'user';
          platformRequired.assignmentSource = 'platformRequirement';
          platformRequired.affectsOtherProjects = true;
          platformRequired.state = 'absent';
          platformRequired.action = 'install';
        }
      }
      return plan;
    };
    const previewDependencyPlacement = vi.fn(async (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      planFor(intent));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      previewDependencyPlacement,
      prepareScopedTask,
    });
    await value.load();
    value.beginInstallFlow('official/agent-lab', 'project');
    value.setInstallPlatforms(['codex']);
    await value.prepareInstallDependencyPlacement();
    value.push({ name: 'dependencyPlacement', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(instance.lastFrame()).toContain('选择每个平台的依赖位置');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit · Codex');
    expect(instance.lastFrame()).toContain('Agent Content Toolkit · Codex');
    expect(instance.lastFrame()).not.toContain('Space');
    const beforeSpace = value.snapshot.installPlacementDraft;
    await input(instance, ' ');
    expect(value.snapshot.installPlacementDraft).toEqual(beforeSpace);

    await input(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'userOverride',
      }),
      expect.objectContaining({
        pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'consumerPromotion',
      }),
    ]));
    expect(instance.lastFrame()).toContain('因依赖自动调整');

    await input(instance, '\u001B[B', '\r');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('确认恢复可执行目标');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: 'project', saveDependencyScopeOverrides: true,
      dependencyScopeOverrides: [expect.objectContaining({
        pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
      })],
    }), expect.any(AbortSignal));

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacement', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user',
    });
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, '\u001B[A', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'dependencyPlacementEditor',
      pluginId: 'official/agent-lab',
      dependencyPluginId: 'official/skill-toolkit',
      platform: 'codex',
    });
  });

  it('mounts a legal user install when a dependency currently exists only in project scope', async () => {
    const loaded = dependencyLoadResult();
    for (const entry of loaded.payload.targets.filter((target) =>
      target.pluginId === 'official/skill-toolkit' && target.platform === 'codex')) {
      updatePlacement(entry, 'user', { state: 'absent' });
      updatePlacement(entry, 'project', { state: 'ready' });
    }
    const rootOverview = loaded.dependencyOverviews?.find((entry) =>
      entry.pluginId === 'official/agent-lab');
    const installedDependency = rootOverview?.dependencies.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    if (installedDependency) {
      installedDependency.placements = [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'ready',
      }];
      installedDependency.aggregateStatus = 'ready';
    }
    const planFor = (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      createDependencyPlacementPlan({
        requestedPluginIds: ['official/agent-lab'],
        operation: 'install',
        roots: [{ pluginId: 'official/agent-lab', platform: 'codex', scope: intent.scope }],
        dependencyEdges: [
          { from: 'official/agent-lab', to: 'official/skill-toolkit', platform: 'codex' },
          { from: 'official/skill-toolkit', to: 'official/content-toolkit', platform: 'codex' },
        ],
        scopeOverrides: intent.dependencyScopeOverrides,
        nodes: [
          {
            pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform: 'codex',
            relation: 'requested', depth: 0, allowedScopes: ['project', 'user'],
            current: { project: 'absent', user: 'absent' },
          },
          {
            pluginId: 'official/skill-toolkit', pluginName: 'Agent Skill Toolkit', platform: 'codex',
            relation: 'dependency', depth: 1, allowedScopes: ['project', 'user'],
            current: { project: 'present', user: 'absent' },
          },
          {
            pluginId: 'official/content-toolkit', pluginName: 'Agent Content Toolkit', platform: 'codex',
            relation: 'dependency', depth: 2, allowedScopes: ['project', 'user'],
            current: { project: 'absent', user: 'present' },
          },
        ],
      });
    const previewDependencyPlacement = vi.fn(async (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>) =>
      planFor(intent));
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      previewDependencyPlacement,
      prepareScopedTask,
    });
    await value.load();
    value.beginInstallFlow('official/agent-lab', 'user');
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(value.listInstallTargets('official/agent-lab', 'user')).toContainEqual({
      platform: 'codex', compatible: true,
    });
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('只在当前项目可用');
    await focusAction(instance, '■ 所有项目');
    await input(instance, '\r');
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('操作汇总');
    expect(planFor({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab',
      platform: 'codex', scope: 'user',
    }).targets).toContainEqual(expect.objectContaining({
      pluginId: 'official/skill-toolkit',
      resolvedScope: 'user',
      assignmentSource: 'consumerPromotion',
    }));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: 'user',
      selectors: ['official/agent-lab'],
    }), expect.any(AbortSignal));
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a long dependency placement list, current focus, actions, and HelpBar visible at %ix%i',
    async (columns, rows) => {
      const plan: DependencyOperationPlan = {
        dependencyPlanSchemaVersion: 2,
        dependencyPlanDigest: 'sha256:long-placement',
        requestedPluginIds: ['official/agent-lab'],
        resolvedPluginIds: [
          ...Array.from({ length: 12 }, (_, index) => `official/dependency-${index + 1}`),
          'official/agent-lab',
        ],
        dependencyEdges: Array.from({ length: 12 }, (_, index) => ({
          from: 'official/agent-lab',
          to: `official/dependency-${index + 1}`,
          platform: 'codex' as const,
        })),
        scopeOverrides: [],
        claimRoots: [],
        targets: [
          ...Array.from({ length: 12 }, (_, index): DependencyOperationPlan['targets'][number] => ({
            pluginId: `official/dependency-${index + 1}`,
            pluginName: `Dependency ${index + 1}`,
            platform: 'codex', relation: 'dependency', depth: 1,
            requiredBy: ['official/agent-lab'], rootScope: 'project', minimumScope: 'project',
            resolvedScope: 'project', allowedScopes: ['project', 'user'],
            assignmentSource: 'default', locked: false, affectsOtherProjects: false,
            state: 'absent', action: 'install', order: index,
          })),
          {
            pluginId: 'official/agent-lab', pluginName: 'Agent Lab', platform: 'codex',
            relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
            minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
            assignmentSource: 'root', locked: true, affectsOtherProjects: false,
            state: 'absent', action: 'install', order: 12,
          },
        ],
      };
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
        previewDependencyPlacement: vi.fn().mockResolvedValue(plan),
      });
      await value.load();
      value.beginInstallFlow('official/agent-lab', 'project');
      value.setInstallPlatforms(['codex']);
      await value.prepareInstallDependencyPlacement();
      value.push({ name: 'dependencyPlacement', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      await input(instance, ...Array.from({ length: 12 }, () => '\u001B[B'));
      let frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 继续到确认');
      expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, '\u001B[A', '\r', 'b');
      frame = instance.lastFrame() ?? '';
      expect(value.snapshot.router.current.route.name).toBe('dependencyPlacement');
      expect(frame).toContain('› Dependency 12 · Codex');
      expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'does not offer dependency placement adjustment for an installed plugin at %ix%i',
    async (columns, rows) => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
    });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toMatch(/›[^\n]*◆ Agent Lab +\[当前/u);
    expect(instance.lastFrame()).not.toContain('调整依赖位置');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it.each([
    ['user', 'project'],
    ['project', 'user'],
  ] as const)('adds a second pure-native scope from %s to %s by reusing exact shared native', async (
    enabledScope,
    addedScope,
  ) => {
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.pluginSummaries[0]!.supportedTargets = { codex: ['user', 'project'], claude: [] };
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    const enabledTarget = target({
      pluginName: 'agent-lab', platform: 'codex', scope: enabledScope, state: 'present',
    }) as StatusV8CodexTarget;
    enabledTarget.components = [{ kind: 'sharedNative', key: 'agent-lab@aw-official', state: 'usable' }];
    updatePlacement(enabledTarget, enabledScope, { components: [
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: [enabledScope], relation: 'root',
      } },
      { kind: 'ownership', key: 'fixture', state: 'present' },
      { kind: 'activation', key: enabledScope, state: 'enabled', metadata: {
        effective: true, evidence: 'observed',
      } },
    ] });
    loaded.payload.targets = [enabledTarget];
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => ({
      kind: 'recovery' as const,
      receipt: { ...(plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt,
        targetResults: [{ ...scopedTarget('official/agent-lab', 'codex', 'applied', 'verified'),
          scope: addedScope }],
      },
    }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask,
      executeScopedTask,
    });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain(`在${addedScope === 'user' ? '所有项目' : '当前项目'}中启用`);
    await focusAction(instance, `在${addedScope === 'user' ? '所有项目' : '当前项目'}中启用`);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).toContain('Enter 选择');

    await focusAction(instance, addedScope === 'user' ? '■ 所有项目' : '■ 当前项目');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: addedScope,
      selectors: ['official/agent-lab'],
    }), expect.any(AbortSignal));
    expect(executeScopedTask).not.toHaveBeenCalled();
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('请求已完成。');
    expect(instance.lastFrame()).toContain('✓ 完成 agent-lab（official）');
    const details = await readScopedDetails(instance);
    expect(details).toContain(`official/agent-lab · Codex [${addedScope === 'user' ? '个人' : '当前项目'}] · 原生 · applied · verified`);
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
  });

  it('renders kept, failed, and skipped dependency targets as target-level results', async () => {
    const loaded = dependencyLoadResult();
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => ({
      kind: 'recovery' as const,
      receipt: { ...(plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt,
        ok: false,
        targetResults: [
          { ...scopedTarget('official/content-toolkit', 'codex', 'no-op', 'verified'),
            relation: 'dependency' as const },
          { ...scopedTarget('official/skill-toolkit', 'codex', 'failed', 'missing'),
            scope: 'project' as const, relation: 'dependency' as const },
          { ...scopedTarget('official/agent-lab', 'codex', 'not-run', 'missing'),
            scope: 'project' as const },
        ],
        remainingTargets: [{ pluginId: 'official/skill-toolkit', agent: 'codex' as const,
          scope: 'project' as const, delivery: { kind: 'native' as const, platform: 'codex' as const } }],
      },
    }));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask,
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await focusAction(instance, '添加插件…');
    await input(instance, '\r');
    await focusAction(instance, '■ 当前项目');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'install', scope: 'project',
      selectors: ['official/agent-lab'],
    }), expect.any(AbortSignal));
    expect(executeScopedTask).not.toHaveBeenCalled();
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('请求仍有未完成目标。');
    expect(frame).toContain('✓ 完成 content-toolkit（official）');
    expect(frame).toContain('× 安装失败 skill-toolkit（official）');
    const details = await readScopedDetails(instance);
    expect(details).toContain('official/content-toolkit');
    expect(details).toContain('no-op · verified');
    expect(details).toContain('official/skill-toolkit');
    expect(details).toContain('failed · missing');
    expect(details).toContain('official/agent-lab');
    expect(details).toContain('not-run · missing');
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    await focusAction(instance, '重试明确失败项（1）');
    await input(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'project', exactTargets: [{ pluginId: 'official/skill-toolkit', agent: 'codex' }],
    }), expect.any(AbortSignal));
  });

  it('returns a successful dependency install to stable detail with a completion notice at 60x18', async () => {
    const plan = dependencyPlan();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'succeeded',
        targetResults: [
          { target: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user' }, state: 'completed', action: 'keep' },
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D09');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.completionNotice).toBeDefined();
    expect(frame).toContain('状态已重新检查');
    expect(frame).toContain('Agent Lab');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    ['dependencyStillRequired', 'codex', 'D12', 80, 24],
    ['dependencyMissing', 'codex', 'D14', 80, 24],
    ['dependencyNotReady', 'codex', 'D15', 80, 24],
    ['dependencyTargetUnsupported', 'claude', 'D16', 80, 24],
    ['dependencyStillRequired', 'codex', 'D12', 60, 18],
    ['dependencyMissing', 'codex', 'D14', 60, 18],
    ['dependencyNotReady', 'codex', 'D15', 60, 18],
    ['dependencyTargetUnsupported', 'claude', 'D16', 60, 18],
  ] as const)('shows bounded safe details for %s on %s as %s at %ix%i', async (
    category,
    platform,
    expectedScreen,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === platform)!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);

    await input(instance, 'd');
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    expect(frame).toContain(category);
    let allTechnicalPages = frame;
    for (let page = 0; page < 3; page += 1) {
      await input(instance, '\u001B[6~');
      allTechnicalPages += instance.lastFrame() ?? '';
    }
    expect(allTechnicalPages).toContain(category);
    expect(frame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    expect(frame).toMatch(/d\s+返回摘要/u);
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, 'd');
    for (let index = 0; index < 8 && !instance.lastFrame()?.includes('› 技术详情'); index += 1) {
      await input(instance, '\u001B[B');
    }
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain(category);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('renders failed and skipped dependency targets as a failure without preserved-success claims', async () => {
    const plan = dependencyPlan();
    plan.resolvedPluginIds = ['official/skill-toolkit', 'official/agent-lab'];
    plan.targets = plan.targets.filter((target) => target.pluginId !== 'official/content-toolkit');
    const before = dependencyLoadResult();
    const after = dependencyLoadResult();
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'failed',
        targetResults: [
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'failed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed', action: 'skipped' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(screens).toContain('D08');
    expect(value.snapshot.result).toMatchObject({
      state: 'blocked', code: 'operationFailed', summary: { code: 'operationFailed' },
    });
    expect(instance.lastFrame()).toContain('依赖安装没有完成');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('未执行 · 依赖未完成');
    expect(instance.lastFrame()).not.toContain('只完成了一部分');
    expect(instance.lastFrame()).not.toContain('已完成或已保留的目标保持可用');
    expect(instance.lastFrame()).not.toContain('写入可能已完成');
    const captureCalls = captureEvidence.mock.calls.length;
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'official/skill-toolkit', platform: 'codex',
    });
    expect(captureEvidence).toHaveBeenCalledTimes(captureCalls);
  });

  it('allows an unreferenced Claude placement removal while Codex remains required', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    for (const platform of ['codex', 'claude'] as const) {
      const target = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/skill-toolkit'
        && entry.platform === platform
        && (entry.platform === 'codex' || entry.scope === 'user'))!;
      updatePlacement(target, 'user', {
        state: 'ready',
        components: [
          { kind: 'intent', key: 'desired', state: 'desired', metadata: {
            enabled: true, scopes: ['user'], relation: 'dependency',
          } },
          { kind: 'ownership', key: 'fixture', state: 'present' },
        ],
      });
    }
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/skill-toolkit', platform: 'claude' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await focusAction(instance, '从所有项目移除');
    await input(instance, '\r');

    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'uninstall', scope: 'user',
      exactTargets: [{ pluginId: 'official/skill-toolkit', agent: 'claude' }],
    }), expect.any(AbortSignal));
  });

  it('keeps a target available when refresh requires promoting a dependency to user scope', async () => {
    const permissive = dependencyLoadResult();
    const restricted = structuredClone(permissive);
    const restrictedCodex = restricted.payload.targets.find((target) =>
      target.pluginId === 'official/skill-toolkit' && target.platform === 'codex');
    if (restrictedCodex?.platform === 'codex') {
      restrictedCodex.placements = restrictedCodex.placements.filter((entry) => entry.scope !== 'project');
    }
    const skillSummary = restricted.pluginSummaries.find((summary) => summary.pluginId === 'official/skill-toolkit')!;
    skillSummary.supportedTargets = { codex: ['user'], claude: [] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(permissive).mockResolvedValue(restricted),
      captureEvidence,
    });
    await value.load();
    value.beginInstallFlow('official/agent-lab', 'project');
    value.setInstallPlatforms(['codex']);
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await value.load();
    await nextTurn(3);

    expect(screens).toContain('D04');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('所选目标平台不可用');
    expect(instance.lastFrame()).not.toContain('Agent Skill Toolkit 不支持所选位置');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('shows the requested root and preserved dependencies in the root removal Review', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D11');
    expect(instance.lastFrame()).toContain('你选择的插件');
    expect(instance.lastFrame()).toContain('Codex · 当前项目');
    expect(instance.lastFrame()).toContain('保持不变');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
  });

  it('does not expose force cleanup from a dependency removal blocker', async () => {
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })),
      executeIntent,
    });
    await value.load();
    value.push({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', view: 'removeBlocked',
      platform: 'codex', scope: 'user',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D12');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).not.toContain('强制清理');
    expect(instance.lastFrame()).not.toContain('› Agent Lab');
    expect(instance.lastFrame()).toContain('› 查看完整依赖关系');
    expect(instance.lastFrame()).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('dependencyStillRequired');
    expect(technicalFrame).toContain('已安装插件仍在使用这个依赖');
    expect(technicalFrame).not.toContain('强制清理');
    expect(technicalFrame).toMatch(/d\s+返回摘要/u);
    expect(technicalFrame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(technicalFrame.match(/›/gu)).toHaveLength(1);
    expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(18);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('pages every removal blocker with arrow keys at $columns x $rows', async (size) => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews?.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    const template = overview?.dependents[0];
    if (!overview || !template) throw new Error('missing dependency fixture');
    overview.dependents = Array.from({ length: 7 }, (_, index) => ({
      ...structuredClone(template),
      pluginId: `official/dependent-${index}`,
      displayName: `Dependent ${index}`,
      placementReferences: template.placementReferences?.map((reference) => ({
        ...structuredClone(reference),
        consumer: { ...reference.consumer, pluginId: `official/dependent-${index}` },
      })),
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', view: 'removeBlocked',
      platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('Dependent 0');
    expect(instance.lastFrame()).toContain('←→ 翻页');
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain(size.rows === 18 ? 'Dependent 1' : 'Dependent 3');
    expect(instance.lastFrame()).toContain('←→ 翻页');
    for (let page = 0; page < 8; page += 1) await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('Dependent 6');
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain(size.rows === 18 ? '6 / 7' : '2 / 3');
    expect(instance.lastFrame()).toContain('Dependent 5');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('keeps a long selected dependency reference while arrow keys page its fields at $columns x $rows', async (size) => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews?.find((entry) =>
      entry.pluginId === 'official/agent-lab');
    const dependency = overview?.dependencies.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    if (!dependency) throw new Error('missing dependency fixture');
    const nodeId = `official/selected-reference-${'dependency-'.repeat(16)}tail`;
    dependency.pluginId = nodeId;
    const nodeSummary = loaded.pluginSummaries.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    if (!nodeSummary) throw new Error('missing dependency summary fixture');
    nodeSummary.pluginId = nodeId;
    const longReference = {
      consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' },
      dependency: {
        pluginId: nodeId,
        platform: 'codex', scope: 'user', project: null,
      },
    } as const;
    const secondReference = {
      ...longReference,
      consumer: { ...longReference.consumer, platform: 'claude' as const, scope: 'user' as const },
      dependency: { ...longReference.dependency, platform: 'claude' as const, scope: 'project' as const },
    };
    dependency.placementReferences = [longReference, secondReference];
    dependency.availablePlacementReferences = [longReference, secondReference];
    const reverseOverview = loaded.dependencyOverviews?.find((entry) =>
      entry.pluginId === 'official/skill-toolkit');
    const dependent = reverseOverview?.dependents.find((entry) =>
      entry.pluginId === 'official/agent-lab');
    if (!dependent) throw new Error('missing reverse dependency fixture');
    if (!reverseOverview) throw new Error('missing reverse overview fixture');
    reverseOverview.pluginId = nodeId;
    dependent.placementReferences = [longReference, secondReference];
    dependent.availablePlacementReferences = [longReference, secondReference];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({
      name: 'pluginDependencyNode', pluginId: 'official/agent-lab',
      nodePluginId: nodeId, direction: 'dependencies', view: 'references',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);
    await input(instance, '\u001B[B', 'd');

    expect(instance.lastFrame()).toContain('←→ 翻页');
    let detailFrames = instance.lastFrame() ?? '';
    await input(instance, '\u001B[C');
    const secondPage = instance.lastFrame() ?? '';
    detailFrames += `\n${secondPage}`;
    expect(secondPage).toContain(size.rows === 18 ? '2 / 7' : '2 / 4');
    expect(secondPage).toContain('←→ 翻页');
    for (let page = 0; page < 12; page += 1) {
      await input(instance, '\u001B[C');
      detailFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(detailFrames).toContain('selected-reference-');
    expect(detailFrames).toContain('tail');
    expect(detailFrames).toContain('platform=Claude Code · scope=user');
    expect(detailFrames).toContain('dependency · platform=Claude Code · scope=project');
    const finalPage = instance.lastFrame();
    await input(instance, '\r');
    expect(instance.lastFrame()).toBe(finalPage);
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('←→ 翻页');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
  });

  it('keeps a restricted cleanup outside Review when no exact candidate exists', async () => {
    const getForceCleanupCandidate = vi.fn().mockResolvedValue(undefined);
    const startForceCleanupReview = vi.fn();
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(forceCleanupLoadResult()),
      executeIntent,
    });
    await value.load();
    vi.spyOn(value, 'getForceCleanupCandidate').mockImplementation(getForceCleanupCandidate);
    vi.spyOn(value, 'startForceCleanupReview').mockImplementation(startForceCleanupReview);
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('检查受限清理');
    await focusAction(instance, '检查受限清理');
    await input(instance, '\r');
    await nextTurn(3);

    expect(getForceCleanupCandidate).toHaveBeenCalledWith('team-tools/review-gate', 'codex', 'user');
    expect(startForceCleanupReview).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex',
    });
    expect(instance.lastFrame()).toContain('当前没有可安全确认的受限清理目标');
  });

  it('uses the core exact candidate to prepare restricted cleanup Review without reinstalling', async () => {
    const candidate = {
      pluginId: 'team-tools/review-gate',
      platform: 'codex' as const,
      scope: 'user' as const,
      actionCount: 1,
    };
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(forceCleanupLoadResult()),
      executeIntent,
    });
    await value.load();
    const getForceCleanupCandidate = vi.spyOn(value, 'getForceCleanupCandidate')
      .mockResolvedValue(candidate);
    const startForceCleanupReview = vi.spyOn(value, 'startForceCleanupReview');
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await focusAction(instance, '检查受限清理');
    await input(instance, '\r');
    await nextTurn(3);

    expect(getForceCleanupCandidate).toHaveBeenCalledWith('team-tools/review-gate', 'codex', 'user');
    expect(startForceCleanupReview).toHaveBeenCalledWith(candidate);
    expect(value.dependencies.prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'cleanup', scope: 'user', force: true,
      exactTargets: [{ pluginId: candidate.pluginId, agent: 'codex' }],
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).toContain('操作汇总');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('本次受限强制清理');
    expect(value.dependencies.executeScopedTask).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('renders dependency target incompatibility as D16 and only offers compatible target platforms', async () => {
    const loaded = dependencyLoadResult();
    const unsupported = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'claude' && entry.scope === 'user')!;
    updatePlacement(unsupported, 'user', { state: 'blocked', reasons: [{
      code: 'dependencyTargetUnsupported',
      message: 'official/skill-toolkit 不支持 Claude Code',
      severity: 'blocking',
    }] });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'dependencyTargetUnsupported')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D16');
    expect(instance.lastFrame()).toContain('无法添加到 Claude Code');
    expect(instance.lastFrame()).toContain('只添加到 Codex');
    await focusAction(instance, '只添加到 Codex');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
  });

  it('budgets D10 with dependency and dependent rows and projects mixed placement status consistently', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    const mixedDependency = overview.dependencies.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    mixedDependency.aggregateStatus = 'needsAttention';
    mixedDependency.placements = [
      { platform: 'codex', state: 'installed', scope: 'user', health: 'ready' },
      { platform: 'claude', state: 'installed', scope: 'user', health: 'incomplete' },
    ];
    overview.dependents.push({
      pluginId: 'official/consumer',
      displayName: '实际使用者',
      relation: 'dependent',
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
      aggregateStatus: 'ready',
      placementReferences: [{
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user', project: null },
      }],
      availablePlacementReferences: [{
        consumer: { pluginId: 'official/consumer', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user', project: null },
      }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D10');
    expect(frame).toMatch(/◆ Agent Lab +\[当前/u);
    expect(frame).toContain('需处理');
    expect(frame).toContain('Agent Skill T');
    expect(frame).not.toContain('实际使用者 · 实际使用者');
    expect(frame).not.toContain('Agent Skill Toolkit             所有项目 · 已可用');
    expect(frame).toMatch(/›[^\n]*◆ Agent Lab +\[当前/u);
    expect(frame).toContain('↑↓ 选择');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await writeAcceptanceTrace('dependency-graph/current-available', [
      acceptanceTraceStep(instance, { columns: 60, rows: 18 }, '本次检查可用关系', []),
    ]);
  });

  it('mounts the dependency issue list and invalid graph recovery page as D13 and D17', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) => entry.category === 'dependencyGraphInvalid');
    expect(graphIssue).toBeDefined();
    const screens = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'issueList' });
    const list = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('D13');
    expect(list.lastFrame()).toContain('4 项');
    expect(list.lastFrame()).toMatch(/依赖\s+\d+ 项/u);
    expect(list.lastFrame()).not.toContain('依赖 ·');
    expect(list.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(list.lastFrame()).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    list.unmount();

    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });
    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(screens).toContain('D17');
    expect(frame).toContain('来源中的依赖关系无效');
    expect(frame).toContain('没有修改任何安');
    expect(frame).not.toContain('dependencyGraphInvalid');
    expect(frame).toContain('› 查看来源问题');
    expect(frame).toContain('查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);

    await input(detail, 'd');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    expect(detail.lastFrame()).toContain('official/agent-lab');
    await input(detail, 'd');
    const technicalIndex = graphIssue!.actions.findIndex((action) => action.id === 'viewTechnical') + 1;
    for (let index = 0; index < technicalIndex; index += 1) await input(detail, '\u001B[B');
    expect(detail.lastFrame()).toContain('› 技术详情');
    await input(detail, '\r');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    await input(detail, 'd', ...Array.from({ length: technicalIndex }, () => '\u001B[A'));
    await input(detail, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('does not invent a source recovery action for D17 without a source ID', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const targetWithoutSource = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex');
    expect(targetWithoutSource).toBeDefined();
    (targetWithoutSource as { sourceId?: string }).sourceId = undefined;

    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) =>
      entry.category === 'dependencyGraphInvalid'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    expect(graphIssue).toBeDefined();
    expect(graphIssue!.sourceId).toBeUndefined();
    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });

    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(frame).not.toContain('查看来源问题');
    expect(frame).toContain('› 查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('summarizes dependency relations as static rows and keeps the only action visible at 60x18', async () => {
    const loaded = dependencyLoadResult();
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/extra-${index + 1}`,
      displayName: `额外依赖 ${index + 1}`,
      relation: 'transitive' as const,
      depth: 3,
      requiredBy: [{ pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: 'notInstalled' as const,
    })));
    overview.summary.totalCount += 6;
    overview.summary.transitiveCount += 6;
    overview.summary.missingCount += 6;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Agent Skill T');
    expect(frame).toContain('Agent Conten');
    expect(frame).toMatch(/→ 展开\s*·\s*← 收起/u);
    expect(frame).toMatch(/›[^\n]*◆ Agent Lab +\[当前/u);
    expect(frame).not.toMatch(/›[^\n]*Agent Skill T/u);
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame).toContain('↑↓ 选择');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('›');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'reads the complete dependency node explanation without another page at %ix%i',
    async (columns, rows) => {
      // Risk: a wrapped dependency reason can hide its final impact and leave no basic-key reading path.
      const loaded = dependencyLoadResult({ rootState: 'present' });
      const node = loaded.pluginSummaries.find((entry) =>
        entry.pluginId === 'official/skill-toolkit')!;
      node.description = `${'完整依赖用途说明。'.repeat(30)}唯一结尾标记`;
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      value.push({
        name: 'pluginDependencyNode',
        pluginId: 'official/agent-lab',
        nodePluginId: 'official/skill-toolkit',
        direction: 'dependencies',
      });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      let frames = instance.lastFrame() ?? '';
      expect(frames).not.toContain('阅读完整说明');
      expect(frames).not.toContain('p 上一页');
      expect(frames).toContain('Esc 返回');
      for (let page = 0; page < 30 && !frames.includes('唯一结尾标记'); page += 1) {
        await input(instance, '\u001b[6~');
        const current = instance.lastFrame() ?? '';
        expect(current.split('\n').length).toBeLessThanOrEqual(rows);
        frames += `\n${current}`;
      }
      expect(frames.replace(/\s/gu, '')).toContain('唯一结尾标记');
    },
  );

  it('restores a deep dependency row, expansion, and scroll after detail and normalizes a removed node', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.dependencies.push(
      {
        pluginId: 'official/y-branch', displayName: 'Y Branch', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
        aggregateStatus: 'ready',
      },
      {
        pluginId: 'official/y-child', displayName: 'Y Child', relation: 'transitive', depth: 2,
        requiredBy: [{ pluginId: 'official/y-branch', displayName: 'Y Branch' }],
        placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
        aggregateStatus: 'ready',
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        pluginId: `official/missing-${index}`, displayName: `Missing ${index}`,
        relation: 'direct' as const, depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user' as const] }],
        aggregateStatus: 'notInstalled' as const,
      })),
      {
        pluginId: 'official/z-branch', displayName: 'Z Branch', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
        aggregateStatus: 'ready',
      },
      {
        pluginId: 'official/z-deep', displayName: 'Z Deep', relation: 'transitive', depth: 2,
        requiredBy: [{ pluginId: 'official/z-branch', displayName: 'Z Branch' }],
        placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
        aggregateStatus: 'ready',
      },
    );
    loaded.pluginSummaries!.push(
      { pluginName: 'y-branch', pluginId: 'official/y-branch', displayName: 'Y Branch', description: 'Y', version: '1.0.0', supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0 },
      { pluginName: 'y-child', pluginId: 'official/y-child', displayName: 'Y Child', description: 'Y child', version: '1.0.0', supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0 },
      { pluginName: 'z-branch', pluginId: 'official/z-branch', displayName: 'Z Branch', description: 'Z', version: '1.0.0', supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0 },
      { pluginName: 'z-deep', pluginId: 'official/z-deep', displayName: 'Z Deep', description: 'Z deep', version: '1.0.0', supportedTargets: { codex: ['user'], claude: [] }, configFieldCount: 0 },
    );
    const loadStatus = vi.fn().mockResolvedValue(loaded);
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const initialProjection = buildDependencyGraphProjection({
      overviews: value.listPluginDependencyOverviews(),
      rootPluginId: 'official/agent-lab',
    });
    const yIndex = initialProjection.rows.findIndex((row) => row.pluginId === 'official/y-branch');
    await input(instance, ...Array.from({ length: yIndex }, () => '\u001B[B'), '\u001B[D');
    expect(instance.lastFrame()).not.toContain('Y Child');
    const collapsedProjection = buildDependencyGraphProjection({
      overviews: value.listPluginDependencyOverviews(),
      rootPluginId: 'official/agent-lab',
      expandedPluginIds: initialProjection.defaultExpandedPluginIds.filter((id) => id !== 'official/y-branch'),
    });
    const deepIndex = collapsedProjection.rows.findIndex((row) => row.pluginId === 'official/z-deep');
    await input(instance, ...Array.from({ length: deepIndex - yIndex }, () => '\u001B[B'));
    expect(instance.lastFrame()).toMatch(/›[^\n]*└─ ┄┄▷ Z Deep/u);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/z-deep' });
    await input(instance, 'b');
    const restoredFrame = instance.lastFrame() ?? '';
    expect(restoredFrame).toMatch(/›[^\n]*└─ ┄┄▷ Z Deep/u);
    expect(restoredFrame).not.toContain('Y Child');
    expect(restoredFrame).not.toContain('◆ Agent Lab');

    await input(instance, '\r');
    const invalid = structuredClone(loaded);
    invalid.pluginSummaries = invalid.pluginSummaries?.filter((summary) => summary.pluginId !== 'official/z-deep');
    invalid.dependencyOverviews = invalid.dependencyOverviews?.map((entry) => ({
      ...entry,
      dependencies: entry.dependencies.filter((dependency) => dependency.pluginId !== 'official/z-deep'),
    }));
    loadStatus.mockResolvedValue(invalid);
    await value.load();
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(instance.lastFrame()).not.toContain('Z Deep');
  });

  it('restores focus for an unverified reverse relation after its detail', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    const dependent = overview.dependents.find((entry) => entry.pluginId === 'official/agent-lab')!;
    dependent.availablePlacementReferences = [];
    for (const entry of loaded.dependencyOverviews!) {
      for (const item of [...entry.dependencies, ...entry.dependents]) {
        item.availablePlacementReferences = item.availablePlacementReferences?.filter((reference) =>
          reference.consumer.pluginId !== 'official/agent-lab'
          || reference.dependency.pluginId !== 'official/skill-toolkit');
      }
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', direction: 'dependents',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\u001B[A');
    expect(instance.lastFrame()).toMatch(/›[^\n]*Agent Lab/u);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginDetail', pluginId: 'official/agent-lab',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', direction: 'dependents',
    });
    expect(instance.lastFrame()).toMatch(/›[^\n]*Agent Lab/u);
  });

  it.each([
    ['D02', 'absent', 80, 24],
    ['D10', 'present', 80, 24],
    ['D02', 'absent', 60, 18],
    ['D10', 'present', 60, 18],
  ] as const)('jointly budgets high-volume %s relations with root %s at %ix%i', async (
    expectedScreen,
    rootState,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({ rootState });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.summary = { directCount: 1, transitiveCount: 7, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 1 };
    overview.blockers.push({ code: 'dependencyUnavailable', title: '高优先级阻塞', explanation: '来源中的依赖不可用。' });
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/high-dependency-${index}`,
      displayName: `高数量依赖 ${index}`,
      relation: 'transitive' as const,
      depth: 2,
      requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: index === 5 ? 'needsAttention' as const : 'notInstalled' as const,
    })));
    overview.dependents.push(...Array.from({ length: 5 }, (_, index) => ({
      pluginId: `official/high-dependent-${index}`,
      displayName: `高数量依赖者 ${index}`,
      relation: 'dependent' as const,
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex' as const, state: 'installed' as const, scope: 'user' as const, health: 'ready' as const }],
      aggregateStatus: 'ready' as const,
      placementReferences: [{
        consumer: { pluginId: `official/high-dependent-${index}`, platform: 'codex' as const, scope: 'user' as const, project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const, project: null },
      }],
      availablePlacementReferences: [{
        consumer: { pluginId: `official/high-dependent-${index}`, platform: 'codex' as const, scope: 'user' as const, project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const, project: null },
      }],
    })));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    expect(initial).toMatch(/›[^\n]*◆ Agent Lab +\[当前/u);
    expect(initial).toContain('↑↓ 选择');
    expect(initial.match(/›/gu)).toHaveLength(1);
    expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
    let relationFrames = initial;
    for (let index = 0; index < 20; index += 1) {
      await input(instance, '\u001B[B');
      relationFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(relationFrames).toContain('需处理');
    for (let index = 0; index < 24 && !/›[^\n]*需处理/u.test(instance.lastFrame() ?? ''); index += 1) {
      await input(instance, '\u001B[B');
    }
    expect(instance.lastFrame()).toMatch(/›[^\n]*需处理/u);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/high-dependency-5',
    });
    await input(instance, 'b');
    const graphBeforeUnboundKey = instance.lastFrame();
    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toBe(graphBeforeUnboundKey);
    expect(technical).not.toContain('d 技术详情');
    expect(technical).toMatch(/→ 展开\s*·\s*← 收起/u);
    expect(technical).toContain('↑↓ 选择');
    expect(technical.match(/›/gu)).toHaveLength(1);
    expect(technical.split('\n').length).toBeLessThanOrEqual(rows);
  });
  it('keeps mixed-scope conflict details without offering automatic cross-scope cleanup', async () => {
    const recovery = [
      {
        command: 'uninstall' as const,
        scope: 'user' as const,
        description: '运行 aw plugin remove official/agent-lab --only requirements --scope user，再运行 aw plugin remove --only outputs official/agent-lab --target codex --scope user，最后 aw plugin sync official/agent-lab --target codex --context project。',
      },
      {
        command: 'uninstall' as const,
        scope: 'project' as const,
        description: '运行 aw plugin remove official/agent-lab --only requirements --scope project，再运行 aw plugin remove --only outputs official/agent-lab --target codex --scope project，最后 aw plugin sync official/agent-lab --target codex --context user。',
      },
    ];
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    const conflictTarget = mixedScopeConflictTarget('agent-lab');
    conflictTarget.recoveryActions = recovery;
    for (const conflictPlacement of conflictTarget.placements) conflictPlacement.components.push({
      kind: 'activation', key: conflictPlacement.scope, state: 'enabled',
      metadata: { effective: true, evidence: 'observed' },
    });
    loaded.payload.targets = [conflictTarget];
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const executeScopedTask = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded),
      prepareScopedTask, executeScopedTask });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'scopeConflict')!;
    expect(issue).toBeDefined();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Codex [当前项目]');
    expect(instance.lastFrame()).toContain('Codex [所有项目]');
    expect(instance.lastFrame()).toContain('查看位置冲突问题');
    expect(instance.lastFrame()).not.toContain('重新安装…');
    expect(instance.lastFrame()).not.toContain('从所有项目移除…');
    expect(instance.lastFrame()).not.toContain('从当前项目移除…');

    await focusAction(instance, '查看位置冲突问题');
    await input(instance, '\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'issueDetail', issueId: issue.issueId });
    expect(instance.lastFrame()).toContain('当前项目、所有项目');
    expect(instance.lastFrame()).toContain('查看冲突详情');
    expect(instance.lastFrame()).not.toContain('保留当前项目');
    expect(instance.lastFrame()).not.toContain('保留所有项目');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('issueDetail');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    expect(executeScopedTask).not.toHaveBeenCalled();
  });

  it.each(['partial', 'blocked'] as const)(
    'shows scoped dependency recovery for an issue-origin %s dependency result',
    async (resultState) => {
      const loaded = dependencyLoadResult();
      const originTarget = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex')!;
      updatePlacement(originTarget, 'project', {
        state: 'needsSync',
        reasons: [{ code: 'missingContent', message: '安全说明', severity: 'warning' }],
      });
      const refreshed = structuredClone(loaded);
      const refreshedOrigin = refreshed.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex')!;
      expect(placement(refreshedOrigin, 'project').state).toBe('needsSync');
      const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
      const executeScopedTask = vi.fn(async (plan: ScopedTuiPlan) => ({
        kind: 'recovery' as const,
        receipt: { ...(plan as Extract<ScopedTuiPlan, { kind: 'recovery' }>).plan.receipt,
          ok: false,
          targetResults: [
            ...(resultState === 'partial'
              ? [{ ...scopedTarget('official/content-toolkit', 'codex', 'no-op', 'verified'),
                  relation: 'dependency' as const }] : []),
            { ...scopedTarget('official/skill-toolkit', 'codex', 'failed', 'missing'),
              scope: 'project' as const, relation: 'dependency' as const },
            { ...scopedTarget('official/agent-lab', 'codex', 'not-run', 'missing'),
              scope: 'project' as const },
          ],
          remainingTargets: [{ pluginId: 'official/skill-toolkit', agent: 'codex' as const,
            scope: 'project' as const, delivery: { kind: 'native' as const, platform: 'codex' as const } }],
        },
      }));
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(refreshed),
        prepareScopedTask, executeScopedTask,
      });
      await value.load();
      const issue = value.listUserIssues().find((candidate) =>
        candidate.category === 'incompleteInstallation'
        && candidate.pluginId === 'official/agent-lab'
        && candidate.platform === 'codex'
        && candidate.scope === 'project')!;
      value.push({ name: 'issueDetail', issueId: issue.issueId });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(2);
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'recovery', scope: 'project', selectors: ['official/agent-lab'],
      }), expect.any(AbortSignal));
      expect(executeScopedTask).not.toHaveBeenCalled();
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));

      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('请求仍有未完成目标。');
      expect(frame).toContain('× 安装失败 skill-toolkit（official）');
      expect(frame).toContain('重试明确失败项（1）');
      const details = await readScopedDetails(instance);
      expect(details).toContain('official/skill-toolkit');
      expect(details).toContain('failed · missing');
      expect(details).toContain('official/agent-lab');
      expect(details).toContain('not-run · missing');
      if (resultState === 'partial') {
        expect(details).toContain('official/content-toolkit');
        expect(details).toContain('no-op · verified');
      }

      await focusAction(instance, '重试明确失败项（1）');
      await input(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(prepareScopedTask).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'recovery', scope: 'project',
        exactTargets: [{ pluginId: 'official/skill-toolkit', agent: 'codex' }],
      }), expect.any(AbortSignal));
      expect(executeScopedTask).toHaveBeenCalledTimes(1);
    },
  );

});
