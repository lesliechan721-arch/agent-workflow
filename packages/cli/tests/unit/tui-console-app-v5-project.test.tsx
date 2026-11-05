import { type ScopedTaskRequest, scopedPlan } from '../helpers/tui-console-app-fixture.js';

import { cleanup, render } from 'ink-testing-library';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8Target,
} from '../../src/commands/status-v6.js';

import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import { type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { copyToClipboard } from '../../src/tui/clipboard.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import { controller, dependencyLoadResult, evidence, loadResult, placement, target, updatePlacement } from '../helpers/tui-console-app-fixture.js';

import { acceptanceTraceStep, escape, input, nextTurn, writeAcceptanceTrace } from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function projectIntentTarget(options: {
  pluginName: string;
  platform?: 'codex' | 'claude';
  state: 'ready' | 'needsSync' | 'blocked' | 'unobserved';
}): StatusV8Target {
  const value = target({
    pluginName: options.pluginName,
    platform: options.platform ?? 'claude',
    scope: 'project',
    state: options.state === 'ready' ? 'present' : 'absent',
  });
  const current = placement(value, 'project');
  current.components.push({
    kind: 'intent',
    key: 'desired',
    state: 'desired',
    metadata: { enabled: true, scopes: ['project'], relation: 'root' },
  });
  if (options.state !== 'ready') {
    current.state = options.state === 'blocked' ? 'blocked' : 'needsSync';
  }
  if (options.state === 'blocked') {
    current.reasons = [{
      code: 'catalogSourceUnavailable',
      message: '来源当前不可用。',
      severity: 'blocking',
    }];
  }
  if (options.state === 'unobserved' && value.platform === 'codex') {
    value.components.push({
      kind: 'sharedNative',
      key: `${options.pluginName}@aw-official`,
      state: 'unobserved',
    });
    current.components.push({
      kind: 'activation',
      key: 'project',
      state: 'unknown',
      metadata: { evidence: 'unobserved' },
    });
    value.reasons = [{
      code: 'codexSharedNativeUnobserved',
      message: '未取得兼容 Codex 状态。',
      severity: 'warning',
    }];
  }
  if (value.platform === 'codex') value.state = current.state;
  return value;
}

function projectStatusLoadResult(targets: StatusV8Target[]): TuiStatusLoadResult {
  const initial = loadResult();
  initial.projectRoot = '/workspace';
  initial.projectIntentRoots = targets.map((entry) => ({
    pluginId: entry.pluginId,
    platforms: [entry.platform],
  }));
  initial.projectIntent = { state: 'ready', roots: initial.projectIntentRoots };
  initial.payload.targets = targets;
  initial.pluginSummaries = targets.map((entry) => ({
    pluginName: entry.pluginName,
    pluginId: entry.pluginId,
    displayName: entry.pluginName,
    description: '项目插件',
    version: entry.version,
    supportedTargets: entry.platform === 'codex'
      ? { codex: ['project'], claude: [] }
      : { codex: [], claude: ['project'] },
    configFieldCount: 0,
  }));
  return initial;
}

describe('ConsoleAppV4', () => {

  it.each([
    ['dependencyMissing', 'absent', 'D14'],
    ['dependencyNotReady', 'partial', 'D15'],
  ] as const)('runs the complete project root plan for a desired consumer %s action', async (
    category,
    dependencyState,
    expectedScreen,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const dependencyTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/skill-toolkit' && entry.platform === 'codex')!;
    updatePlacement(dependencyTarget, 'user', {
      state: dependencyState === 'partial' ? 'needsSync' : 'absent',
      reasons: dependencyState === 'partial'
        ? [{ code: 'missingContent', message: '安全说明', severity: 'warning' }] : [],
    });
    for (const target of loaded.payload.targets.filter((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex')) {
      placement(target, 'project').components.push({
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      });
      updatePlacement(target, 'project', { state: 'needsSync', reasons: [{
        code: category,
        message: `${category}: official/skill-toolkit has changed state.`,
        severity: 'blocking',
        dependencyPluginId: 'official/skill-toolkit',
        dependencyPlatform: 'codex',
        dependencyScope: 'user',
        dependencyProject: null,
      }], recoveryActions: [{
        command: 'sync', scope: 'project', description: '同步完整的根插件依赖计划。',
      }] });
    }
    const prepareScopedTask = vi.fn(async (request: ScopedTaskRequest) => scopedPlan(request));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), prepareScopedTask });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === 'codex' && candidate.scope === 'project')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain(expectedScreen);
    expect(instance.lastFrame()).toContain('受影响的根插件');
    expect(instance.lastFrame()).toContain('依赖目标');
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');

    await input(instance, '\r');

    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'sync', scope: 'project',
      selectors: ['official/agent-lab'],
      exactTargets: [{ pluginId: 'official/agent-lab', agent: 'codex' }],
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).toContain('操作汇总');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps mixed scoped placement facts and root focus on return at %ix%i', async (columns, rows) => {
      const loaded = projectStatusLoadResult([
        projectIntentTarget({ pluginName: 'agent-lab', platform: 'codex', state: 'blocked' }),
        projectIntentTarget({ pluginName: 'agent-lab', platform: 'claude', state: 'needsSync' }),
        projectIntentTarget({ pluginName: 'review-gate', platform: 'codex', state: 'ready' }),
      ]);
      loaded.scopedRecovery = { project: { scope: 'project', intent: { state: 'valid' },
        selection: { agents: ['codex', 'claude'], preferences: 'valid' },
        inventory: [{ pluginId: 'official/agent-lab', source: 'official', sourceState: 'ready', blockers: [],
          targetResults: [{ pluginId: 'official/agent-lab', agent: 'codex', scope: 'project',
            delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run', observation: 'unknown',
            content: 'conflict', blockers: [{ code: 'sourceUnavailable', message: '来源当前不可用。' }], requiredBy: [] },
          { pluginId: 'official/agent-lab', agent: 'claude', scope: 'project',
            delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run', observation: 'missing',
            content: 'drifted', blockers: [], requiredBy: [] }] },
        { pluginId: 'official/review-gate', source: 'official', sourceState: 'ready', blockers: [],
          targetResults: [{ pluginId: 'official/review-gate', agent: 'codex', scope: 'project',
            delivery: { kind: 'native', platform: 'codex' }, execution: 'no-op', observation: 'verified',
            content: 'satisfied', blockers: [], requiredBy: [] }] }],
        extraObserved: [], errors: [], allSatisfied: false } };
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      value.push({ name: 'intentInventory', scope: 'project', projectKey: '/workspace' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      const frames = [acceptanceTraceStep(instance, { columns, rows }, 'mixed root')];
      expect(frames[0]!.frame).toContain('[■ 当前项目]');
      const allFacts = [frames[0]!.frame];
      for (let line = 0; line < 8 && (!allFacts.join('\n').includes('Claude Code] 待同步')
        || !allFacts.join('\n').includes('插件来源不可用')); line += 1) {
        await input(instance, '\u001B[B');
        const step = acceptanceTraceStep(instance, { columns, rows }, `mixed facts ${line + 1}`);
        frames.push(step);
        allFacts.push(step.frame);
      }
      expect(allFacts.join('\n')).toContain('[! Codex] 受阻');
      expect(allFacts.join('\n')).toContain('插件来源不可用');
      expect(allFacts.join('\n')).toContain('[↻ Claude Code] 待同步');
      expect(value.listScopedInventoryRoots('project')).toHaveLength(2);
      const mixedRoot = value.listScopedInventoryRoots('project').find((root) => root.pluginId === 'official/agent-lab')!;
      expect(mixedRoot.targets).toHaveLength(2);
      expect(mixedRoot.targets.every((entry) => entry.scope === 'project')).toBe(true);
      await input(instance, '/', 'review', '\r');
      expect(instance.lastFrame()).toContain('review-gate');
      expect(instance.lastFrame()).not.toContain('agent-lab');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId: 'official/review-gate',
      });
      await escape(instance);
      expect(value.snapshot.router.current.route.name).toBe('intentInventory');
      expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
      expect(instance.lastFrame()).toContain('› review-gate');
      frames.push(acceptanceTraceStep(instance, { columns, rows }, 'root returned'));
      await writeAcceptanceTrace(`b04/scoped-mixed-${columns}x${rows}`, frames);
    },
  );

});
