import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8CodexTarget,
} from '../../src/commands/status-v6.js';
import {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  controller,
  dependencyLoadResult,
  dependencyOverview,
  evidence,
  evidenceForIntent,
  loadResult,
  platformLoadResult,
  pluginWriteTaskEvidence,
  setAllPlacementsAbsent,
  target,
  updatePlacement,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  escape,
  focusAction,
  input,
  nextTurn,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function capabilityUnsupportedLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  const unsupported = target({
    pluginName: 'review-gate',
    platform: 'codex',
    scope: 'user',
    state: 'error',
    errorCode: 'awCapabilityUnsupported',
  });
  unsupported.recoveryActions = [{
    command: 'manual',
    description: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
  }];
  loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
  loaded.payload.targets = [unsupported];
  loaded.pluginSummaries = [{
    ...loaded.pluginSummaries.find((summary) => summary.pluginId === 'official/review-gate')!,
    missingCapabilities: ['aw.future-feature.v1'],
  }];
  return loaded;
}

describe('ConsoleAppV4', () => {
  it('reaches every P state through a real mounted controller snapshot', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const mountRoute = async (
      route: Parameters<TuiController['push']>[0],
      expected: ConsoleV4ScreenId,
      value = controller(),
    ): Promise<void> => {
      value.push(route);
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns: 80, rows: 24 }}
        onScreenChange={(screen) => reached.add(screen)}
      />);
      await nextTurn(3);
      expect(reached.has(expected), `${expected} was not reached`).toBe(true);
      instance.unmount();
      instance.cleanup();
    };

    await mountRoute({ name: 'pluginList', mode: 'browse' }, 'P01');
    const search = controller();
    search.push({ name: 'pluginList', mode: 'browse' });
    const searchInstance = render(<ConsoleAppV4 controller={search} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    await input(searchInstance, '/');
    expect(reached.has('P02')).toBe(true);
    searchInstance.unmount();
    searchInstance.cleanup();
    await mountRoute({ name: 'pluginList', mode: 'browse', sourceId: 'research' }, 'P03');
    await mountRoute({ name: 'pluginContent', pluginId: 'official/agent-lab' }, 'P04');
    await mountRoute({ name: 'installPlacement', pluginId: 'official/agent-lab' }, 'P05');
    await mountRoute({ name: 'installTargets', pluginId: 'official/agent-lab' }, 'P06');
    await mountRoute({ name: 'pluginList', mode: 'installed' }, 'P11');
    const emptyData = loadResult();
    emptyData.payload.targets = emptyData.payload.targets.map(setAllPlacementsAbsent);
    const emptyInstalled = controller({
      loadStatus: vi.fn().mockResolvedValue(emptyData),
    });
    emptyInstalled.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const emptyInstalledInstance = render(<ConsoleAppV4
      controller={emptyInstalled}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => reached.add(screen)}
    />);
    await nextTurn(3);
    expect(reached.has('P12'), 'P12 was not reached').toBe(true);
    emptyInstalledInstance.unmount();
    emptyInstalledInstance.cleanup();
    await mountRoute({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' }, 'P13');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P14');
    await mountRoute({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' }, 'P15');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'claude' }, 'P16');
    const unavailableData = loadResult();
    unavailableData.payload.catalog.sources = unavailableData.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P17', controller({
      loadStatus: vi.fn().mockResolvedValue(unavailableData),
    }));
    await mountRoute({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' }, 'P21');
    await mountRoute({ name: 'pluginMore', pluginId: 'team-tools/review-gate' }, 'P22');

    const prepare = async (
      action: 'install' | 'reinstall' | 'uninstall',
      executeIntent: TuiControllerDependencies['executeIntent'] = vi.fn().mockResolvedValue({
        targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      }),
    ): Promise<{ value: TuiController; token: string }> => {
      const value = controller({ executeIntent });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite',
        action,
        pluginId: action === 'install' ? 'official/agent-lab' : 'team-tools/review-gate',
        platform: 'codex',
        scope: 'user',
      });
      return { value, token: review.reviewToken };
    };
    for (const [action, expected] of [['install', 'P07'], ['reinstall', 'P18'], ['uninstall', 'P19']] as const) {
      const prepared = await prepare(action);
      const instance = render(<ConsoleAppV4 controller={prepared.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
      await nextTurn(3);
      expect(reached.has(expected)).toBe(true);
      instance.unmount();
      instance.cleanup();
    }
    const pending = new Promise<unknown>(() => undefined);
    const progress = await prepare('install', vi.fn(() => pending));
    void progress.value.executeOperation(progress.token);
    await nextTurn(2);
    const progressInstance = render(<ConsoleAppV4 controller={progress.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P08')).toBe(true);
    progressInstance.unmount();
    progressInstance.cleanup();
    const success = await prepare('install', vi.fn().mockResolvedValue({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      warnings: ['需要复查。'],
    }));
    await success.value.executeOperation(success.token);
    const successInstance = render(<ConsoleAppV4 controller={success.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P09')).toBe(true);
    successInstance.unmount();
    successInstance.cleanup();
    const partial = await prepare('install', vi.fn().mockResolvedValue({ targetResults: [
      { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
      { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
    ] }));
    await partial.value.executeOperation(partial.token);
    const partialInstance = render(<ConsoleAppV4 controller={partial.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P10')).toBe(true);
    partialInstance.unmount();
    partialInstance.cleanup();

    expect([...reached].filter((screen) => screen.startsWith('P')).sort()).toEqual(
      CONSOLE_V4_SCREEN_IDS.filter((screen) => screen.startsWith('P')).sort(),
    );
  }, 30_000);

  it.each([[60, 18], [80, 24]] as const)(
    'reads a ten-item plugin content list by vertical scrolling at %ix%i',
    async (columns, rows) => {
      // Risk: content cards and the navigation actions can be clipped, leaving declared content unreadable.
      const value = controller();
      await value.load();
      const items = Array.from({ length: 10 }, (_, index) => ({
        id: `skill:content-${index + 1}`,
        name: index === 0 ? 'isolating-work-with-git-worktrees' : `content-${index + 1}`,
        type: 'skill' as const,
        description: `Content ${index + 1} description.`,
        tools: ['Codex'],
      }));
      vi.spyOn(value, 'getPluginContentOverview').mockReturnValue({
        pluginId: 'official/agent-lab',
        pluginVersion: '2.0.0',
        catalogVersion: '9.0.0',
        evidence: 'catalogBundle',
        items,
        notices: [],
      });
      vi.spyOn(value, 'getPluginContentState').mockReturnValue('ready');
      value.push({ name: 'pluginContent', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      let frames = instance.lastFrame() ?? '';
      expect(frames).toContain('内容版本 2.0.0');
      expect(frames).toContain('安装 ');
      expect(frames).not.toContain('p 上一页');
      expect(frames).not.toContain('n 下一页');
      expect(frames).toContain('isolating-work-with-git-worktrees');
      expect(frames).toContain('[Skill]');
      expect(frames).toContain('[Codex]');
      expect(frames.split('\n').length).toBeLessThanOrEqual(rows);

      for (let index = 1; index < items.length; index += 1) {
        await input(instance, '\u001B[B');
        const current = instance.lastFrame() ?? '';
        expect(current.split('\n').length).toBeLessThanOrEqual(rows);
        frames += `\n${current}`;
      }
      expect(instance.lastFrame()).toContain('content-10');
      for (const item of items) expect(frames).toContain(item.name);
      await focusAction(instance, '查看技术详情');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginTechnical', pluginId: 'official/agent-lab',
      });
    },
  );

  it('shows the stable primary root cause on an installed plugin row', async () => {
    const loaded = loadResult();
    const consumer = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex');
    expect(consumer).toBeDefined();
    updatePlacement(consumer!, 'user', { state: 'needsSync', reasons: [{
      code: 'dependencyNotReady',
      message: 'safe dependency symptom',
      dependencyPluginId: 'team-tools/toolkit',
      rootIssueId: 'artifactCollision:team-tools/toolkit:codex:user:agent:toolkit',
      rootIssueCode: 'artifactCollision',
      severity: 'warning',
    }] });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).not.toContain('artifactCollision');
    expect(instance.lastFrame()).toContain('团队发布审查、证据检查与发布门禁');
    expect(instance.lastFrame()).toContain('AW 不会覆盖或删除');
    instance.unmount();
  });

  it('shows each plugin fact once, keeps common actions direct, and limits More to low-frequency tasks', async () => {
    const loaded = loadResult();
    for (const entry of loaded.payload.targets.filter((target) => target.pluginId === 'team-tools/review-gate')) {
      if (entry.platform === 'claude') {
        if (entry.state !== 'absent') updatePlacement(entry, entry.scope, { state: 'ready', reasons: [] });
      } else {
        for (const targetPlacement of entry.placements) {
          if (targetPlacement.state !== 'absent') updatePlacement(entry, targetPlacement.scope, { state: 'ready', reasons: [] });
        }
      }
    }
    loaded.dependencyOverviews = [{
      ...dependencyOverview()[0]!, pluginId: 'team-tools/review-gate',
      dependencies: [{ ...dependencyOverview()[0]!.dependencies[0]!,
        requiredBy: [{ pluginId: 'team-tools/review-gate', displayName: 'Review Gate' }] }],
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    const detail = instance.lastFrame() ?? '';
    expect(detail).toContain('插件设置');
    expect(detail).toContain('内容详情');
    for (const label of ['依赖关系', '卸载', '更多操作']) {
      await focusAction(instance, label);
      expect(instance.lastFrame()).toContain(`› ${label}`);
    }
    expect(detail.match(/团队发布审查、证据检查与发布门禁/gu)).toHaveLength(1);
    expect(detail.match(/team-tools/gu) ?? []).toHaveLength(1);
    expect(detail.match(/目录版本 0\.4\.2/gu)).toHaveLength(1);
    expect(detail.match(/Codex \[所有项目\] 安装版本/gu)).toHaveLength(1);
    expect(detail.match(/Claude Code \[当前项目\] 安装版本/gu)).toHaveLength(1);
    expect(detail).not.toContain('重新安装');
    expect(detail).not.toContain('同步已保存');

    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    const more = instance.lastFrame() ?? '';
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginMore', pluginId: 'team-tools/review-gate',
    });
    expect(more).toContain('Codex 平台维护');
    expect(more).toContain('诊断与技术详情');
    expect(more).not.toContain('插件设置');
    expect(more).not.toContain('内容详情');
    expect(more).not.toContain('依赖关系');
    expect(more).not.toContain('卸载');
    expect(more).not.toContain('插件定义信息');
    expect(more.split('\n').length).toBeLessThanOrEqual(24);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex',
    });
    expect(instance.lastFrame()).toContain('重新安装');
    expect(instance.lastFrame()).toContain('移除');
  });

  it('shows one usage action and an explicit health conclusion for a healthy plugin without config', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';

    expect(frame).toContain('Codex [所有项目]');
    expect(frame).toContain('Codex [当前项目]');
    expect(frame).toMatch(/Codex \[所有项目\][^\n]*\[✓ 可用\]/u);
    expect(frame).toMatch(/Codex \[当前项目\][^\n]*\[✓ 可用\]/u);
    expect(frame.match(/依赖关系/gu)).toHaveLength(1);
  });

  it.each([
    ['ready', 'needsSync', ['Codex [所有项目] 安装版本 未确认 [✓ 可用]', 'Codex [当前项目] 安装版本 未确认 [↻ 待同步]']],
    ['needsSync', 'ready', ['Codex [所有项目] 安装版本 未确认 [↻ 待同步]', 'Codex [当前项目] 安装版本 未确认 [✓ 可用]']],
    ['ready', 'absent', ['Codex [所有项目] 安装版本 未确认 [✓ 可用]']],
    ['needsSync', 'needsSync', ['Codex [所有项目] 安装版本 未确认 [↻ 待同步]', 'Codex [当前项目] 安装版本 未确认 [↻ 待同步]']],
  ] as const)('keeps scoped Status v8 conclusions for user=%s and project=%s', async (
    userState, projectState, expected,
  ) => {
    const loaded = loadResult();
    loaded.pluginSummaries = loaded.pluginSummaries.filter((entry) =>
      entry.pluginId === 'official/review-gate');
    const target = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    loaded.payload.targets = [target];
    for (const [scope, state] of [['user', userState], ['project', projectState]] as const) {
      updatePlacement(target, scope, {
        state,
        components: state === 'absent' ? [{ kind: 'ownership', key: `fixture-${scope}`, state: 'absent' }] : [
          { kind: 'intent', key: 'desired', state: 'desired', metadata: {
            enabled: true, scopes: [scope], relation: 'root',
          } },
          { kind: 'ownership', key: `fixture-${scope}`, state: 'present' },
        ],
        reasons: state === 'needsSync'
          ? [{ code: 'missingContent', message: 'safe fixture', severity: 'warning' }] : [],
        recoveryActions: [],
      });
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';

    for (const text of expected) expect(frame.replace(/ +/gu, ' ')).toContain(text);
    if (projectState === 'absent') expect(frame).not.toContain('Codex [当前项目]');
    expect(frame).not.toContain('所有项目、当前项目需要同步');
  });

  it('keeps one shared failure conclusion for both Status v8 scopes', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = loaded.pluginSummaries.filter((entry) =>
      entry.pluginId === 'official/review-gate');
    const target = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    if (target.platform !== 'codex') throw new Error('expected Codex target');
    loaded.payload.targets = [target];
    target.components = [{
      kind: 'sharedNative', key: 'review-gate@aw-official', state: 'replaceable',
      metadata: { shared: true, reason: 'renderDrift', version: '0.2.1' },
    }];
    for (const scope of ['user', 'project'] as const) updatePlacement(target, scope, {
      state: 'needsSync',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: [scope], relation: 'root',
        } },
        { kind: 'ownership', key: `fixture-${scope}`, state: 'present' },
      ],
      reasons: [],
      recoveryActions: [{ command: 'sync', scope, description: 'Synchronize shared content.' }],
    });
    target.reasons = [{
      code: 'codexSharedNativeRenderDrift', message: 'safe shared drift', severity: 'warning',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 未确认 [↻ 待同步]');
    expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain('Codex [当前项目] 安装版本 未确认 [↻ 待同步]');
  });

  it('does not copy one scoped collision to the ready Status v8 scope', async () => {
    const loaded = loadResult();
    loaded.pluginSummaries = loaded.pluginSummaries.filter((entry) =>
      entry.pluginId === 'official/review-gate');
    const target = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    loaded.payload.targets = [target];
    updatePlacement(target, 'user', {
      state: 'ready',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['user'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-user', state: 'present' },
      ],
      reasons: [], recoveryActions: [],
    });
    updatePlacement(target, 'project', {
      state: 'blocked',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-project', state: 'present' },
      ],
      reasons: [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }],
      recoveryActions: [],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';

    expect((frame).replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 未确认 [✓ 可用]');
    expect((frame).replace(/ +/gu, ' ')).toContain('Codex [当前项目] 安装版本 未确认 [! 受阻]');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps four scoped platform conclusions and all detail actions reachable at %ix%i',
    async (columns, rows) => {
    const loaded = loadResult();
    loaded.pluginSummaries = loaded.pluginSummaries.filter((entry) =>
      entry.pluginId === 'team-tools/review-gate');
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId === 'team-tools/review-gate');
    for (const target of loaded.payload.targets) {
      const targetScopes = target.platform === 'codex'
        ? target.placements.map((entry) => entry.scope) : [target.scope];
      for (const targetScope of targetScopes) {
        const nextState = target.platform === 'codex' && targetScope === 'project'
          ? 'needsSync' as const
          : target.platform === 'claude' && targetScope === 'user'
            ? 'blocked' as const : 'ready' as const;
        updatePlacement(target, targetScope, {
          state: nextState,
          components: [
            { kind: 'intent', key: 'desired', state: 'desired', metadata: {
              enabled: true, scopes: [targetScope], relation: 'root',
            } },
            { kind: 'ownership', key: `fixture-${target.platform}-${targetScope}`, state: 'present' },
          ],
          reasons: nextState === 'needsSync'
            ? [{ code: 'missingContent', message: 'safe missing content', severity: 'warning' }]
            : nextState === 'blocked'
              ? [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }] : [],
          recoveryActions: [],
        });
      }
    }
    loaded.targetRevisions = loaded.payload.targets.map((target) => ({
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      revision: {
        state: 'upgradeAvailable' as const,
        installedVersion: '0.2.1',
        availableVersion: '0.3.0',
      },
    }));
    loaded.dependencyOverviews = [{
      ...dependencyOverview()[0]!,
      pluginId: 'team-tools/review-gate',
    }];
    const executeIntent = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const size = { columns, rows };
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    const trace: AcceptanceTraceStep[] = [];
    await nextTurn(3);
    const first = instance.lastFrame() ?? '';
    expect(first).toContain('Codex');
    expect((first).replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 未确认 [✓ 可用]');
    expect((first).replace(/ +/gu, ' ')).toContain('Codex [当前项目] 安装版本 未确认 [↻ 待同步]');
    expect(first).toContain('更新 Review Gate');
    expect(first).toContain('›');
    expect(first.split('\n').length).toBeLessThanOrEqual(rows);
    trace.push(acceptanceTraceStep(instance, size, '混合范围首屏', []));

    expect(first).not.toContain('完整基本信息');
    let conclusionFrames = instance.lastFrame() ?? '';
    for (let page = 0; page < 10; page += 1) {
      await input(instance, '\u001b[6~');
      conclusionFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    const second = instance.lastFrame() ?? '';
    expect(conclusionFrames).toContain('Claude Code');
    expect((conclusionFrames).replace(/ +/gu, ' ')).toContain('Claude Code [所有项目] 安装版本 0.2.1 [! 受阻]');
    expect((conclusionFrames).replace(/ +/gu, ' ')).toContain('Claude Code [当前项目] 安装版本 0.2.1 [✓ 可用]');
    expect(second).toContain('›');
    expect(second.split('\n').length).toBeLessThanOrEqual(rows);
    trace.push(acceptanceTraceStep(instance, size, '详情原页显示全部范围', ['PgDn']));
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');

    const focusedActions = new Set<string>();
    for (const [index, label] of ['插件设置', '更多操作'].entries()) {
      await focusAction(instance, label);
      const actionFrame = instance.lastFrame() ?? '';
      const focusedAction = actionFrame.match(/› ([^\n]+)/u)?.[1];
      expect(focusedAction).toBeDefined();
      focusedActions.add(focusedAction!);
      expect(actionFrame.split('\n').length).toBeLessThanOrEqual(rows);
      trace.push(acceptanceTraceStep(instance, size, `插件动作 ${index + 1}`, ['ArrowDown']));
    }
    expect(focusedActions).toHaveLength(2);
    expect([...focusedActions].join('\n')).toContain('插件设置');
    expect([...focusedActions].join('\n')).toContain('更多操作');
    expect(executeIntent).not.toHaveBeenCalled();
    await writeAcceptanceTrace(`plugin-detail/mixed-scope-${columns}x${rows}`, trace);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps missing platform observations unknown in the list and detail at %ix%i',
    async (columns, rows) => {
      const loaded = loadResult();
      loaded.payload.targets = loaded.payload.targets.filter((target) =>
        target.pluginId !== 'official/review-gate');
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      value.push({ name: 'pluginList', mode: 'browse', sourceId: 'official' }, { query: 'Review Gate' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      expect(instance.lastFrame()).toContain('? Codex');
      expect(instance.lastFrame()).toMatch(/搜索 [^\n]*\[\/\]/u);
      await input(instance, '\r');
      expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain('使用位置 [? 未确认]');
      expect(instance.lastFrame()).not.toContain('尚未安装');
      expect(instance.lastFrame()).toContain('Esc 返回');
    },
  );

  it('does not claim saved settings make an uninstalled plugin usable', async () => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.map((target) =>
      target.pluginId === 'official/review-gate' ? {
        ...target,
        state: 'absent' as const,
        components: [{ kind: 'ownership' as const, key: 'fixture', state: 'absent' }],
      } : target);
    loaded.configStoreInventory = [{
      pluginId: 'official/review-gate', sourceId: 'official', pluginName: 'review-gate', scope: 'user',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('已保存设置 所有项目');
    expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain('使用位置 [? 未确认]');
    expect(instance.lastFrame()).not.toContain('[✓ 可用]');
  });

  it('prepares an unchanged eligible update from plugin detail once', async () => {
    const loaded = platformLoadResult('upgradeAvailable');
    const captureEvidence = vi.fn(async (intent: OperationIntent) => intent.kind === 'pluginWriteTask'
      ? pluginWriteTaskEvidence(intent)
      : evidenceForIntent(intent));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await focusAction(instance, '更新到 0.3.0');
    await input(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(captureEvidence).toHaveBeenCalledTimes(1);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask',
      goal: 'update',
      targets: [expect.objectContaining({
        pluginId: 'official/review-gate', platform: 'codex', scope: 'user',
        expectedUpdate: expect.objectContaining({ installedVersion: '0.2.1', activeVersion: '0.3.0' }),
      })],
    }), expect.any(AbortSignal));

    await escape(instance);
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    expect(instance.lastFrame()).toContain('确认更新 1 个位置');
    expect(captureEvidence).toHaveBeenCalledTimes(1);
  });

  it.each(['0.9.0', '2.0.0'])('shows native version %s without claiming saved settings differ', async (installedVersion) => {
    const loaded = loadResult();
    const native = loaded.payload.targets.find((entry): entry is StatusV8CodexTarget =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex')!;
    native.state = 'needsSync';
    native.components = [{ kind: 'sharedNative', key: 'review-gate@aw-team-tools',
      state: 'replaceable', metadata: { reason: 'outdated', version: installedVersion, desiredVersion: '1.0.0' } }];
    native.reasons = [{ code: 'codexSharedNativeUpdateRequired', message: 'update required', severity: 'warning' }];
    updatePlacement(native, 'user', { state: 'needsSync' });
    loaded.targetRevisions = [{
      pluginId: native.pluginId, platform: 'codex', scope: 'user',
      revision: { state: installedVersion === '0.9.0' ? 'upgradeAvailable' : 'current',
        installedVersion, availableVersion: '1.0.0' },
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 120, rows: 40 }} />);
    await nextTurn(2);
    expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain(`Codex [所有项目] 安装版本 ${installedVersion} [↻ 待同步]`);
    expect(instance.lastFrame()).toContain('同步所有项目的使用位置');
    expect(instance.lastFrame()).not.toContain('当前安装与已保存设置不一致');
  });

  it('routes an outdated native plugin through the update task instead of issue recovery', async () => {
    const loaded = platformLoadResult('upgradeAvailable');
    const native = loaded.payload.targets.find((entry): entry is StatusV8CodexTarget =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    native.state = 'needsSync';
    native.components = [{ kind: 'sharedNative', key: 'review-gate@aw',
      state: 'replaceable', metadata: {
        reason: 'outdated', version: '0.2.1', desiredVersion: '0.3.0',
      } }];
    updatePlacement(native, 'user', { state: 'needsSync', reasons: [{
      code: 'codexSharedNativeUpdateRequired', message: 'update required', severity: 'warning',
    }] });
    const captureEvidence = vi.fn(async (intent: OperationIntent) => intent.kind === 'pluginWriteTask'
      ? pluginWriteTaskEvidence(intent)
      : evidenceForIntent(intent));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: native.pluginId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 120, rows: 40 }} />);
    await nextTurn(2);

    expect(value.listUserIssues().some((issue) => issue.issueId === `sharedNative:${native.pluginId}`))
      .toBe(false);
    expect(instance.lastFrame()).toContain('更新到 0.3.0');
    expect(instance.lastFrame()).not.toContain('恢复正常');
    expect(instance.lastFrame()).not.toContain('查看处理建议');

    await focusAction(instance, '更新到 0.3.0');
    await input(instance, '\r');
    await vi.waitFor(() => expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteTask', goal: 'update', targets: [expect.objectContaining({
        pluginId: native.pluginId, platform: 'codex', scope: 'user',
      })],
    }), expect.any(AbortSignal)));
  });

  it('keeps an installed plugin visible when its source is unavailable', async () => {
    const unavailable = loadResult();
    unavailable.payload.catalog.sources = unavailable.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    unavailable.pluginSummaries.push({
      pluginName: 'catalog-only',
      pluginId: 'team-tools/catalog-only',
      displayName: 'Catalog Only',
      description: 'Only in the unavailable catalog',
      supportedTargets: { codex: ['user'], claude: [] },
    });
    unavailable.payload.targets = [
      ...unavailable.payload.targets.map((entry) => {
        if (entry.pluginId !== 'team-tools/review-gate') return entry;
        const clone = setAllPlacementsAbsent(entry);
        if (clone.platform === 'codex') updatePlacement(clone, 'user', {
          state: 'blocked',
          reasons: [{ code: 'nativeStateUnreadable', message: 'safe live owner failure', severity: 'blocking' }],
        });
        return clone;
      }),
      target({ pluginName: 'catalog-only', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' }),
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(unavailable),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('插件');
    expect(instance.lastFrame()).not.toContain('插件可用');
    await input(instance, '\r', 'f');
    expect(instance.lastFrame()).toContain('Review Gate');
    expect(instance.lastFrame()).toContain('来源');
    expect(instance.lastFrame()).not.toContain('Catalog Only');
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    await nextTurn(2);
    await focusAction(instance, '更多操作');
    await input(instance, '\r');
    await focusAction(instance, 'Codex 平台维护');
    await input(instance, '\r');
    expect(screens).toContain('P17');
    expect((instance.lastFrame() ?? '').replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 未确认 [! 受阻]');
    expect(instance.lastFrame()).toContain('查看来源问题');
  });

  it('shows AW CLI capability recovery without routing a healthy source to a missing source issue', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(capabilityUnsupportedLoadResult()),
    });
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    const frame = instance.lastFrame() ?? '';
    expect((frame).replace(/ +/gu, ' ')).toContain('Codex [所有项目] 安装版本 未确认 [! 受阻]');
    expect(frame).toContain('升级 AW CLI');
    expect(frame).toContain('查看功能支持详情');
    expect(frame).not.toContain('查看来源问题');
    expect(frame).not.toContain('重新加载状态');
    expect(frame).not.toContain('来源不可用');

    await focusAction(instance, '查看功能支持详情');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'pluginTechnical', pluginId: 'official/review-gate', platform: 'codex',
    });
    expect(instance.lastFrame()).toContain('Capability 技术详情');
    expect(instance.lastFrame()).toContain('aw.future-feature.v1');
    expect(instance.lastFrame()).toContain('awCapabilityUnsupported');
    expect(value.snapshot.router.current.route.name).not.toBe('sourceDetail');
    expect(value.snapshot.router.current.route.name).not.toBe('issueDetail');
  });

  it('counts source tabs from the active browse or installed list mode', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    expect((instance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 3] official 2 team-tools 1');

    instance.unmount();
    const installed = controller();
    installed.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const installedInstance = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect((installedInstance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 1] official 0 team-tools 1');
  });

  it('normalizes a mounted detail route when reload removes its current plugin', async () => {
    const initial = loadResult();
    const removed = loadResult();
    initial.payload.catalog.sources = initial.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'active' as const }
      : source);
    removed.payload.catalog.sources = removed.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'active' as const }
      : source);
    removed.pluginSummaries = removed.pluginSummaries.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    removed.payload.targets = removed.payload.targets.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(removed),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Review Gate');

    await value.reloadCatalog();
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(instance.lastFrame()).not.toContain('后续阶段');
  });

  it('routes platform errors to typed issues without offering reinstall or removal', async () => {
    const loaded = loadResult();
    const failed = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex');
    if (failed) {
      updatePlacement(failed, 'user', { state: 'blocked', reasons: [{
        code: 'sourceChanged',
        message: '/private/source changed',
        severity: 'blocking',
      }] });
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('查看对应问题');
    expect(instance.lastFrame()).not.toContain('重新连接缺失内容');
    expect(instance.lastFrame()).not.toContain('移除');
    expect(instance.lastFrame()).not.toContain('/private/source');
  });

  it('shows the catalog version in the refresh-and-sync action only from revision sidecar evidence', async () => {
    const loaded = loadResult();
    loaded.targetRevisions = [{
      pluginId: 'team-tools/review-gate',
      platform: 'codex',
      scope: 'user',
      revision: {
        state: 'upgradeAvailable',
        availableVersion: '0.5.0',
        installedVersion: '0.4.2',
      },
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('更新到 0.5.0');
    expect(instance.lastFrame()).toContain('Codex [所有项目] 安装版本 0.4.2');
  });

  it('keeps the focused platform action by ID when a live reload inserts refresh-and-sync first', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('current'))
      .mockResolvedValue(platformLoadResult('upgradeAvailable'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await focusAction(instance, '查看安装详情');
    expect(instance.lastFrame()).toContain('› 查看安装详情');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('更新到 0.3.0');
    expect(instance.lastFrame()).toContain('› 查看安装详情');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginTechnical', pluginId: 'official/review-gate',
      platform: 'codex', scope: 'user',
    });
  });

  it('returns to the selected platform card when a live refresh removes the focused action', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('upgradeAvailable'))
      .mockResolvedValue(platformLoadResult('current'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await focusAction(instance, '更新到 0.3.0');
    expect(instance.lastFrame()).toContain('› 更新到 0.3.0');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toMatch(/╭─ › (?:当前项目|所有项目) \[选定\]/u);
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).toMatch(/╭─ › (?:当前项目|所有项目) \[选定\]/u);
    await focusAction(instance, '重新安装所有项目位置');
    await input(instance, '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      operationKind: 'pluginWrite',
      pluginAction: 'reinstall',
    });
    expect(value.dependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'reinstall',
      pluginId: 'official/review-gate',
      platform: 'codex',
      scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('shows only safe verbose component fields on P21 and keeps non-verbose P21 unchanged', async () => {
    const verbose = loadResult();
    const targetWithComponent = verbose.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex');
    if (targetWithComponent) updatePlacement(targetWithComponent, 'user', { components: [{
      kind: 'ownership', key: 'skill:review', state: 'error',
      metadata: { errorCode: 'componentInspectionFailed' },
    }] });
    const verboseValue = controller({ loadStatus: vi.fn().mockResolvedValue(verbose) });
    await verboseValue.load();
    verboseValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const verboseInstance = render(<ConsoleAppV4 controller={verboseValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(verboseInstance.lastFrame()).toContain('skill:review');
    expect(verboseInstance.lastFrame()).toContain('componentInspectionFailed');
    expect(verboseInstance.lastFrame()).not.toContain('/private/raw');

    const normalValue = controller();
    normalValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const normalInstance = render(<ConsoleAppV4 controller={normalValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(normalInstance.lastFrame()).not.toContain('skill:review');
  });

  it.each([
    [60, 18, 10],
    [80, 24, 14],
  ] as const)('prioritizes exceptional P21 components and preserves return at %ix%i with %i items', async (
    columns,
    rows,
    componentCount,
  ) => {
    const loaded = loadResult();
    const selected = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex')!;
    updatePlacement(selected, 'user', { components: [
      ...Array.from({ length: componentCount - 2 }, (_, index) => ({
        kind: 'ownership' as const,
        key: `ordinary:${index}`,
        state: 'present' as const,
      })),
      { kind: 'ownership', key: 'error-code', state: 'error', metadata: { errorCode: 'componentInspectionFailed' } },
      { kind: 'ownership', key: 'partial-code', state: 'partial' },
    ] });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('error-code');
    expect(frame).toContain('componentInspectionFailed');
    expect(frame).toMatch(/1 \/ \d+/u);
    expect(frame).not.toContain('返回插件');
    expect(frame).toContain('Esc 返回');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame).not.toContain('/private/component');

    let componentPages = frame;
    for (let page = 0; page < componentCount + 8; page += 1) {
      await input(instance, '\u001B[C');
      componentPages += instance.lastFrame() ?? '';
    }
    expect(componentPages).toContain('partial-code');
    const lastPage = instance.lastFrame() ?? '';
    expect(componentPages).toContain(`ordinary:${componentCount - 3}`);
    expect(lastPage).toContain('Claude Code target');
    for (let index = 0; index < componentCount - 2; index += 1) {
      expect(componentPages).toContain(`ordinary:${index}`);
    }
    expect(lastPage).toMatch(/\d+ \/ \d+/u);
    expect(lastPage.split('\n').length).toBeLessThanOrEqual(rows);

    await escape(instance);
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
  });

  it.each([[60, 18], [80, 24]] as const)(
    'reads every safe P21 field and a single long component at %ix%i', async (columns, rows) => {
      const loaded = capabilityUnsupportedLoadResult();
      const pluginId = 'official/review-gate-component-component-component-plugin-end';
      loaded.pluginSummaries[0]!.pluginId = pluginId;
      loaded.pluginSummaries[0]!.missingCapabilities = [
        'aw.future-feature-component-component-component-capability-end',
      ];
      const selected = loaded.payload.targets[0]!;
      selected.pluginId = pluginId;
      updatePlacement(selected, 'user', { components: [{
        kind: 'ownership',
        key: 'skill:component-component-component-component-component-end-sentinel',
        state: 'error',
        metadata: { errorCode: 'componentInspectionFailed', rawError: '/private/raw-error' },
      }] });
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.push({ name: 'pluginTechnical', pluginId });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      const first = instance.lastFrame() ?? '';
      await input(instance, '\u001B[6~');
      const second = instance.lastFrame() ?? '';
      await input(instance, '\u001B[D');
      expect(instance.lastFrame()).toBe(first);
      await input(instance, '\u001B[C');
      expect(instance.lastFrame()).toBe(second);

      const frames = [first, second];
      for (let page = 0; page < 20; page += 1) {
        await input(instance, '\u001B[6~');
        frames.push(instance.lastFrame() ?? '');
      }
      const last = instance.lastFrame() ?? '';
      await input(instance, '\u001B[C');
      expect(instance.lastFrame()).toBe(last);
      const allFrames = frames.join('\n');
      for (const field of ['canonical pluginId', '来源 · official',
        'componentInspectionFailed', 'failure code',
        'capability 状态', '恢复方向', 'Codex target']) {
        expect(allFrames).toContain(field);
      }
      const joinedFacts = allFrames.replace(/[\s│╭╮╰╯─←→]/gu, '');
      for (const field of [
        `canonical pluginId · ${pluginId}`,
        '组件 · error · componentInspectionFailed · skill:component-component-component-component-component-end-sentinel · Codex · 所有项目',
        '缺少 capability · aw.future-feature-component-component-component-capability-end',
      ]) {
        expect(joinedFacts).toContain(field.replace(/\s/gu, ''));
      }
      expect(allFrames).not.toContain('/private/raw-error');
      for (const current of frames) {
        expect(current.split('\n').length).toBeLessThanOrEqual(rows);
        for (const line of current.split('\n')) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
      }
      await escape(instance);
      expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId });
    },
  );

  it('keeps source tabs out of the vertical focus and searches same-name plugins by canonical identity', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const initial = instance.lastFrame() ?? '';
    expect(initial.split('\n')[0]).toMatch(/\[m\] 多选/u);
    expect(initial.split('\n')[2]).not.toContain('[m]');
    expect(initial).toContain('全部 3');
    expect(initial).toContain('Review Gate');
    expect(initial.match(/›/g)).toHaveLength(1);

    await input(instance, '\u001B[C');
    const afterTab = instance.lastFrame() ?? '';
    expect(afterTab).toContain('[official 2]');
    expect(afterTab.match(/›/g)).toHaveLength(1);

    await input(instance, '/', 'review');
    const searched = instance.lastFrame() ?? '';
    expect(searched).toMatch(/搜索 review▌ +\[\/\]/u);
    expect(searched).toContain('轻量代码审查与合并检查');
  });

  it('restores list context and keeps 60x18 and 80x24 frames within their row budgets', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'pluginList', mode: 'browse' }, { focusIndex: 1, query: 'review', sourceTabId: 'all' });
      value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);
      await input(instance, 'b');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/搜索 review +\[\/\]/u);
      expect(frame).toContain('Review Gate');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      if (size.columns === 60) expect(frame).toMatch(/来源\s+\[全部 \d+\][^\n]*\[←→\] 切换/u);
    }
  });

  it('keeps the browse install filter with source, query, preview, and Back navigation', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'f', 'f', ']', ']');
    expect(instance.lastFrame()).toContain('本条件无匹配');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[', '/', 'review');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('[未安装 1]');
    expect(instance.lastFrame()).toContain('› Review Gate');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });

    await input(instance, ']');
    expect(instance.lastFrame()).toContain('本条件无匹配');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[');
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/review-gate' });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
    expect(value.snapshot.router.current.context).toMatchObject({
      query: 'review',
      installFilter: 'uninstalled',
      sourceTabId: 'official',
    });
    expect(instance.lastFrame()).toContain('[未安装 1]');
    expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
    expect(instance.lastFrame()).toContain('› Review Gate');
  });

  it('distinguishes global, source, query, and update empty plugin lists', async () => {
    const emptyInstalled = loadResult();
    for (const target of emptyInstalled.payload.targets) {
      target.state = 'absent';
      target.components = [{ kind: 'ownership', key: 'fixture', state: 'absent' }];
      if (target.platform === 'codex') {
        for (const placement of target.placements) {
          placement.state = 'absent';
          placement.components = [{ kind: 'ownership', key: 'fixture', state: 'absent' }];
        }
      }
    }
    const globalValue = controller({ loadStatus: vi.fn().mockResolvedValue(emptyInstalled) });
    await globalValue.load();
    globalValue.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const globalScreen = render(<ConsoleAppV4 controller={globalValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(globalScreen.lastFrame()).toContain('开始添加第一个插件');
    globalScreen.unmount();

    const sourceValue = controller();
    await sourceValue.load();
    sourceValue.push({ name: 'pluginList', mode: 'installed', sourceId: 'official' }, { installFilter: 'installed' });
    const sourceScreen = render(<ConsoleAppV4 controller={sourceValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(sourceScreen.lastFrame()).toContain('本条件无匹配');
    expect(sourceValue.snapshot.router.current.context.installFilter).toBe('installed');
    sourceScreen.unmount();

    const queryValue = controller();
    await queryValue.load();
    queryValue.push({ name: 'pluginList', mode: 'browse' }, { query: 'no-such-plugin' });
    const queryScreen = render(<ConsoleAppV4 controller={queryValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(queryScreen.lastFrame()).toContain('搜索没有匹配插件');
    expect(queryScreen.lastFrame()).toContain('清除搜索');
    queryScreen.unmount();

    const updateValue = controller();
    await updateValue.load();
    updateValue.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'updateAvailable' });
    const updateScreen = render(<ConsoleAppV4 controller={updateValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(updateScreen.lastFrame()).toContain('本条件无匹配');
  });

  it('keeps one focus for empty-query recovery while Tab is inert', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' }, { query: 'no-such-plugin' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('› 清除搜索');
    await input(instance, '\t');
    expect(instance.lastFrame()).toContain('› 清除搜索');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');

    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(value.snapshot.router.current.context.query).toBe('');
    instance.unmount();
  });

  it('keeps a source-error recovery action in the single focus sequence', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse', sourceId: 'research' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('› 查看来源问题');
    await input(instance, '\t');
    expect(instance.lastFrame()).toContain('› 查看来源问题');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail', issueId: 'source:research:unavailable',
    });
    instance.unmount();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps one in-place query and selection trajectory at %ix%i without color',
    async (columns, rows) => {
      const captureEvidence = vi.fn().mockResolvedValue(evidence);
      const value = controller({ captureEvidence });
      await value.load();
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      const home = instance.lastFrame() ?? '';
      for (const label of ['插件', '项目插件', '插件来源']) expect(home).toContain(label);
      expect(home.match(/›/gu)).toHaveLength(1);
      await input(instance, '?');
      expect(value.snapshot.router.depth).toBe(1);
      await escape(instance);
      expect(instance.lastFrame()).toContain('› 插件');
      await input(instance, '\r');
      const depth = value.snapshot.router.depth;
      await input(instance, '/', 'Reviw', '\u001B[D', 'e', '\r');
      expect(value.snapshot.router.current.context.query).toBe('Review');
      expect(value.snapshot.router.depth).toBe(depth);
      expect(value.snapshot.router.current.route.name).toBe('pluginList');
      await input(instance, 'f');
      expect(instance.lastFrame()).toContain('[已安装');
      await input(instance, 'm', 'c');
      expect(value.snapshot.router.depth).toBe(depth);
      expect(value.snapshot.router.current.route.name).toBe('batchSelection');
      expect(captureEvidence).not.toHaveBeenCalled();
      await input(instance, ' ');
      expect(instance.lastFrame()).toContain('已选 1');
      await input(instance, '\u001B[C');
      expect(instance.lastFrame()).toContain('隐藏已选 1');
      await input(instance, '\u001B[C');
      expect(instance.lastFrame()).toContain('已选 1');
      expect(instance.lastFrame()).not.toContain('隐藏已选');
      expect(instance.lastFrame()).toContain('› [x] Review Gate');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
      await escape(instance);
      const restored = instance.lastFrame() ?? '';
      expect(restored).toContain('Review');
      expect(restored).toContain('[已安装 1]');
      expect(restored).toContain('› [x] Review Gate');
      expect(restored).toContain('team-tools');
      expect(restored).not.toMatch(/\u001B\[[0-9;]*m/u);
      expect(restored.split('\n').length).toBeLessThanOrEqual(rows);
      expect(Math.max(...restored.split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);
      expect(value.snapshot.router.depth).toBe(depth);
      await input(instance, '/', '\u0015', '中文😀mfcshHq?');
      expect(value.snapshot.router.current.route.name).toBe('batchSelection');
      expect(instance.lastFrame()).not.toContain('退出控制台？');
      await escape(instance);
      expect(instance.lastFrame()).toContain('中文😀mfcshHq?');
      expect(instance.lastFrame()).toContain('隐藏已选 1');
    },
  );

  it('treats search shortcut letters as query text and keeps the query after Esc', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'mcsrhHq[]');
    expect(instance.lastFrame()).toContain('mcsrhHq[]▌');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('mcsrhHq[]');
    expect(instance.lastFrame()).toMatch(/搜索 mcsrhHq\[\] +\[\/\]/u);
    expect(instance.lastFrame()).not.toContain('退出控制台？');
  });

  it.each([
    [60, 18],
    [80, 24],
  ] as const)('keeps a complex search cursor visible and bounded at %i x %i', async (columns, rows) => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);

    await input(instance, '/', `${'前'.repeat(35)}😀🇨🇳👨‍👩‍👧‍👦e\u0301中文`, '\u007f');

    const frame = instance.lastFrame()!;
    expect(frame).toContain('▌');
    expect(frame).not.toContain('中文▌');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThanOrEqual(columns);
  });

  it('uses arrows to leave search and requires a second Enter to open a result', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'review', '\u001B[B');
    expect(instance.lastFrame()).toMatch(/› Review Gate[\s\S]+team-tools/u);
    expect(instance.lastFrame()).not.toContain('review▌');
    await input(instance, '/', '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail',
      pluginId: 'team-tools/review-gate',
    });
  });

  it('keeps source and status visible when a plugin name is truncated at 60 columns', async () => {
    const data = loadResult();
    const displayName = 'This Plugin Name Is Intentionally Much Too Long For The Available Width';
    data.pluginSummaries = [{
      pluginName: 'long-name',
      pluginId: 'team-tools/long-name',
      displayName,
      description: '用途说明',
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }];
    data.payload.targets = [target({ pluginName: 'long-name', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' })];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('team-tools');
    expect(frame).toContain('[○ Codex]');
    expect(frame).not.toContain(displayName);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps the current longest legal source tab and last plugin focus visible on one line at 80x24', async () => {
    const data = loadResult();
    const sourceIds = Array.from({ length: 4 }, (_, index) => `${String(index + 1).repeat(31)}a`);
    data.payload.catalog.sources = sourceIds.map((id, index) => ({
      id,
      identity: `identity:${id}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'active' as const,
    }));
    data.payload.catalog.primarySourceId = sourceIds[0]!;
    data.pluginSummaries = sourceIds.flatMap((sourceId, sourceIndex) =>
      Array.from({ length: sourceIndex === sourceIds.length - 1 ? 8 : 1 }, (_, pluginIndex) => ({
        pluginName: `source-${sourceIndex}-plugin-${pluginIndex}`,
        pluginId: `${sourceId}/source-${sourceIndex}-plugin-${pluginIndex}`,
        displayName: `Source ${sourceIndex + 1} Plugin ${pluginIndex + 1}`,
        description: `Description ${pluginIndex + 1}`,
        supportedTargets: { codex: ['user' as const], claude: [] },
        configFieldCount: 0,
      })));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      sourceId: summary.pluginId.split('/')[0],
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: data.pluginSummaries.filter((plugin) => plugin.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, ']', ']', ']', ']');
    expect(instance.lastFrame()).toContain(`[${sourceIds.at(-1)} 8]`);
    expect(instance.lastFrame()).toContain('[←→] 切换');
    await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('› Source 4 Plugin 8');
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('grows the same plugin viewport with terminal rows and keeps the last focus visible', async () => {
    const sizes = [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ];
    const visibleCounts: number[] = [];
    for (const size of sizes) {
      const data = loadResult();
      data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
        pluginName: `viewport-${index + 1}`,
        pluginId: `official/viewport-${index + 1}`,
        displayName: `Viewport Plugin ${index + 1}`,
        description: `Viewport description ${index + 1}`,
        supportedTargets: { codex: ['user'], claude: [] },
        configFieldCount: 0,
      }));
      data.payload.targets = data.pluginSummaries.map((summary) => target({
        pluginName: summary.pluginName,
        platform: 'codex',
        scope: 'user',
        state: 'absent',
      }));
      data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
      data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
      value.push({ name: 'pluginList', mode: 'browse' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);

      const initialFrame = instance.lastFrame() ?? '';
      visibleCounts.push(initialFrame.match(/Viewport Plugin \d+/gu)?.length ?? 0);
      expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
      await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
      expect(instance.lastFrame()).toContain('› Viewport Plugin 8');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }

    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(8);
  });

  it('keeps the focused item visible in a 60x18 viewport and opens that exact item', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
      pluginName: `plugin-${index + 1}`,
      pluginId: `official/plugin-${index + 1}`,
      displayName: `Plugin ${index + 1}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, ...Array.from({ length: 6 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› Plugin 7');
    expect(instance.lastFrame()).not.toContain('Plugin 1');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail',
      pluginId: 'official/plugin-7',
    });
  });

  it('keeps plugin and issue focus visible at item 10 in an 80x24 viewport and opens the exact object', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 12 }, (_, index) => ({
      pluginName: `plugin-${String(index + 1).padStart(2, '0')}`,
      pluginId: `official/plugin-${String(index + 1).padStart(2, '0')}`,
      displayName: `Plugin ${String(index + 1).padStart(2, '0')}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'partial',
    }));
    data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
    data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' });
    const plugins = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(plugins, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(plugins.lastFrame()).toContain('› Plugin 10');
    expect(plugins.lastFrame()).not.toContain('Plugin 01');
    await input(plugins, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/plugin-10' });
    plugins.unmount();

    value.push({ name: 'issueList' });
    const issues = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(issues, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(issues.lastFrame()).toContain('› official/plugin-10');
    expect(issues.lastFrame()).not.toContain('official/plugin-01');
    await input(issues, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail',
      issueId: 'incompleteInstallation:official/plugin-10:codex:user',
    });
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['内容详情', '依赖关系', '卸载', '更多操作']],
    ['P13', loadResult(), 'team-tools/review-gate', ['插件设置', '内容详情', '卸载', '更多操作']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 60x18 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    expect(screens).toContain(expectedScreen);
    for (const label of labels) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 选择动作');
      expect(frame.match(/›/gu)).toHaveLength(1);
    }
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['内容详情', '依赖关系', '卸载', '更多操作']],
    ['P13', loadResult(), 'team-tools/review-gate', ['插件设置', '内容详情', '卸载', '更多操作']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 80x24 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    expect(screens).toContain(expectedScreen);
    for (const label of labels) {
      await focusAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 选择动作');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
  });

  it('keeps inactive shared Codex content in browse without installed or attention claims', async () => {
    // Risk: shared payload can remain usable after its final scope is disabled.
    const loaded = loadResult();
    const inactive = setAllPlacementsAbsent(loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'codex')!);
    if (inactive.platform !== 'codex') throw new Error('Expected Codex fixture.');
    inactive.components.push({
      kind: 'sharedNative', key: 'agent-lab@aw-official', state: 'usable', metadata: { shared: true },
    });
    for (const entry of inactive.placements) entry.components = [
      { kind: 'ownership', key: 'native', state: 'partial' },
      { kind: 'activation', key: entry.scope, state: 'disabled', metadata: { evidence: 'observed' } },
      { kind: 'extension', key: 'aw', state: 'missing', metadata: { kinds: [] } },
    ];
    loaded.payload.targets = [inactive];
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.pluginSummaries = [{
      ...loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!,
      supportedTargets: { codex: ['user', 'project'], claude: [] },
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('Agent Lab');
    expect(value.listUserIssues()).toEqual([]);
    await input(instance, 'f');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('[○ Codex]');
  });

  it('restores list focus by entity ID after a reload changes row order', async () => {
    const initial = loadResult();
    const reordered = loadResult();
    reordered.pluginSummaries.unshift({
      pluginName: 'aardvark',
      pluginId: 'official/aardvark',
      displayName: 'Aardvark',
      description: '排序变化夹具',
      version: '1.0.0',
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(reordered),
    });
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 1,
        scrollOffset: 10,
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/review-gate',
      },
    );
    value.push({ name: 'pluginDetail', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await value.load();

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/review-gate',
    });
  });

  it('uses the adjacent list row when the focused entity disappears during reload', async () => {
    const initial = loadResult();
    const withoutFocusedPlugin = loadResult();
    withoutFocusedPlugin.pluginSummaries = withoutFocusedPlugin.pluginSummaries
      .filter((plugin) => plugin.pluginId !== 'official/review-gate');
    withoutFocusedPlugin.payload.targets = withoutFocusedPlugin.payload.targets
      .filter((target) => target.pluginId !== 'official/review-gate');
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(withoutFocusedPlugin),
    });
    await value.load();
    value.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 1,
        scrollOffset: 10,
        sourceTabId: 'official',
        installFilter: 'all',
        focusedEntityId: 'official/review-gate',
      },
    );
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await value.load();
    const remaining = value.listPlugins({
      mode: 'browse', sourceId: 'official', installFilter: 'all',
    });
    const adjacent = remaining[Math.min(1, remaining.length - 1)];
    if (!adjacent) throw new Error('expected an adjacent plugin row');

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: adjacent.pluginId,
    });
  });

  it.each([[60, 18], [80, 24]] as const)('review repair exposes common detail actions on first screen at %ix%i', async (columns, rows) => {
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('› Agent Lab');
    expect(frame).toContain('› 安装');
    expect(frame).toContain('安装');
    expect(frame).toContain('内容详情');
    expect(frame).toContain('0.4.2');
    expect(frame).toContain('official');
    expect(frame.replace(/ +/gu, ' ')).toContain('使用位置 [? 未确认]');
    const trace = [acceptanceTraceStep(instance, { columns, rows }, 'detail information', [])];
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('› 安装');
    trace.push(acceptanceTraceStep(instance, { columns, rows }, 'information page with action focus', ['ArrowRight']));
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('› 安装');
    expect(instance.lastFrame()).not.toContain('› Agent Lab');
    trace.push(acceptanceTraceStep(instance, { columns, rows }, 'detail information return', ['ArrowLeft']));
    await writeAcceptanceTrace(`b04/detail-${columns}x${rows}`, trace);
  });

  it.each([[60, 18], [80, 24]] as const)('keeps card metadata and actions visible with a long plugin purpose at %ix%i', async (columns, rows) => {
    const loaded = loadResult();
    loaded.pluginSummaries[0]!.description = '这是合法的插件用途说明。'.repeat(24) + '用途完整末尾';
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
    const size = { columns, rows };
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(3);
    const checkCard = (): string => {
      const frame = instance.lastFrame() ?? '';
      const titleLine = frame.split('\n').find((line) => line.includes('╭─ ›'));
      expect(titleLine).toContain('Agent Lab');
      expect(titleLine).not.toContain('official');
      expect(frame.split('\n').find((line) => line.includes('Codex') && line.includes('official'))).toBeDefined();
      expect(frame).toContain('…');
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
      return frame;
    };
    checkCard();
    const trace = [acceptanceTraceStep(instance, size, 'long purpose list card', [])];
    await input(instance, 'a');
    expect(instance.lastFrame()).not.toContain('╭─ › Agent Lab');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, 'a', 'm');
    checkCard();
    trace.push(acceptanceTraceStep(instance, size, 'long purpose batch card', ['a', 'a', 'm']));
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    let pages = instance.lastFrame() ?? '';
    trace.push(acceptanceTraceStep(instance, size, 'detail long first', ['Enter']));
    for (let page = 0; page < 30 && !pages.replace(/\s/gu, '').includes('用途完整末尾'); page += 1) {
      await input(instance, '\u001B[C');
      pages += `\n${instance.lastFrame() ?? ''}`;
      trace.push(acceptanceTraceStep(instance, size, `detail long page ${page + 2}`, ['right']));
    }
    expect(pages.replace(/\s/gu, '')).toContain('用途完整末尾');
    await writeAcceptanceTrace(`b04/long-detail-${columns}x${rows}`, trace);
  });

  it.each([[60, 18], [80, 24]] as const)('shows the complete short plugin purpose on its first page at %ix%i', async (columns, rows) => {
    const loaded = loadResult();
    const purpose = '帮助用户检查代理插件的安装位置和当前状态，并说明每个范围内已经确认的结果。';
    loaded.pluginSummaries[0]!.description = purpose;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';
    expect(frame.replace(/[\s│]/gu, '')).toContain(purpose.replace(/\s/gu, ''));
    expect(frame).not.toContain('完整基本信息');
    expect(frame.match(/目录版本/gu)).toHaveLength(1);
    expect(frame.match(/\[official\]/gu)).toHaveLength(1);
    expect(frame).toContain('╭');
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps typed content, search, and safe reading distinct at %ix%i', async (columns, rows) => {
      const value = controller();
      await value.load();
      vi.spyOn(value, 'getPluginContentOverview').mockReturnValue({
        pluginId: 'official/agent-lab', pluginVersion: '2.0.0', catalogVersion: '9.0.0',
        evidence: 'catalogBundle', coverage: 'partial',
        coverageIssue: { code: 'incompleteList', message: '部分内容清单无法确认。' }, notices: [],
        items: [
          { id: 'skill:plain', name: '普通技能', type: 'skill', description: null,
            descriptionState: 'absent', tools: ['Codex'] },
          { id: 'agent:trusted', name: '可信代理', type: 'agent', description: '可信用途说明。',
            descriptionState: 'available', tools: ['Claude Code'] },
          { id: 'command:broken', name: '受阻命令', type: 'command', description: null,
            descriptionState: 'issue', tools: ['Codex'],
            issue: { code: 'invalidMetadata', message: '安全简介元信息无效。' } },
        ],
      });
      vi.spyOn(value, 'getPluginContentState').mockReturnValue('ready');
      value.push({ name: 'pluginContent', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      const first = acceptanceTraceStep(instance, { columns, rows }, 'content plain');
      const trace = [first];
      expect(first.frame).toContain('普通技能');
      expect(first.frame.split('\n').find((line) => line.includes('普通技能'))).toContain('[Skill]');
      expect(first.frame).toContain('[Codex]');
      expect(first.frame).not.toContain('目录没有提供简短描述');
      expect(first.frame).toContain('清单覆盖不完整');
      expect(first.frame.match(/内容版本[^\n]*2\.0\.0/gu)).toHaveLength(1);
      await input(instance, '\r');
      expect(instance.lastFrame()).toBe(first.frame);
      await input(instance, 'a', '\r');
      expect(instance.lastFrame()).toContain('incompleteList');
      expect(instance.lastFrame()).not.toContain('菜单');
      trace.push({ label: 'coverage issue reader', size: { columns, rows },
        inputs: ['a', 'Enter'], frame: instance.lastFrame() ?? '' });
      await escape(instance);
      await input(instance, 'a');
      expect(instance.lastFrame()).toContain('普通技能');
      await input(instance, '\u001B[C', '\u001B[C');
      expect(instance.lastFrame()).toContain('[Agent 1]');
      expect(instance.lastFrame()).toContain('可信用途说明');
      trace.push(acceptanceTraceStep(instance, { columns, rows }, 'agent type', ['right', 'right']));
      await input(instance, '/', '可信', '\r');
      expect(instance.lastFrame()).toMatch(/搜索 可信\s+\[\/\]/u);
      expect(instance.lastFrame()).toContain('可信代理');
      expect(instance.lastFrame()).not.toContain('受阻命令');
      await input(instance, '\u001B[C');
      expect(instance.lastFrame()).toContain('[命令 0]');
      expect(instance.lastFrame()).toContain('当前条件无匹配');
      await input(instance, '/', '\u0015', '\r');
      expect(instance.lastFrame()).toContain('受阻命令');
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('invalidMetadata');
      expect(instance.lastFrame()).not.toContain('菜单');
      const readerFrame = instance.lastFrame();
      await input(instance, 'j', 'a', '/', '\r');
      expect(instance.lastFrame()).toBe(readerFrame);
      expect(value.snapshot.router.current.context.query).toBe('');
      await input(instance, '?');
      expect(instance.lastFrame()).not.toBe(readerFrame);
      await escape(instance);
      expect(instance.lastFrame()).toBe(readerFrame);
      trace.push({ label: 'item issue reader', size: { columns, rows },
        inputs: ['Enter'], frame: instance.lastFrame() ?? '' });
      await escape(instance);
      expect(instance.lastFrame()).toContain('受阻命令');
      expect(value.snapshot.router.current.context.contentTypeTab).toBe('command');
      await writeAcceptanceTrace(`b04/content-${columns}x${rows}`, trace);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'reads long content fully and restores its preview and query at %ix%i', async (columns, rows) => {
      const value = controller();
      await value.load();
      vi.spyOn(value, 'getPluginContentOverview').mockReturnValue({
        pluginId: 'official/agent-lab', pluginVersion: '2.0.0', catalogVersion: '9.0.0',
        evidence: 'catalogBundle', coverage: 'complete', notices: [],
        items: [{ id: 'agent:long', name: '长简介 Agent', type: 'agent',
          description: `${'这是可信的长简介内容。'.repeat(24)}简介末尾标记`,
          descriptionState: 'available', tools: ['Codex'] }],
      });
      vi.spyOn(value, 'getPluginContentState').mockReturnValue('ready');
      value.push({ name: 'pluginContent', pluginId: 'official/agent-lab' });
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      expect(instance.lastFrame()).toContain('› 长简介 Agent');
      await input(instance, '/', '长简介', '\r');
      const preview = acceptanceTraceStep(instance, size, 'long content preview');
      expect(preview.frame).not.toContain('简介末尾标记');
      expect(preview.frame).toContain('…');
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('Esc 返回清单');
      let pages = instance.lastFrame() ?? '';
      for (let page = 0; page < 30 && !pages.replace(/\s/gu, '').includes('简介末尾标记'); page += 1) {
        await input(instance, '\u001b[C');
        pages += `\n${instance.lastFrame() ?? ''}`;
      }
      expect(pages.replace(/\s/gu, '')).toContain('简介末尾标记');
      await escape(instance);
      expect(value.snapshot.router.current.route).toEqual({ name: 'pluginContent', pluginId: 'official/agent-lab' });
      expect(instance.lastFrame()).toBe(preview.frame);
      expect(value.snapshot.router.current.context.query).toBe('长简介');
    },
  );
});
