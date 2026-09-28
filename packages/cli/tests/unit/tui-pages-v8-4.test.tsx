import fs from 'fs-extra';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { ConfigTile, configTileHeight } from '../../src/tui/components.js';
import type { RecoveryInventoryInput } from '../../src/tui/scoped-inventory.js';

afterEach(cleanup);

function data(): TuiStatusLoadResult {
  return {
    projectRoot: '/tmp/项目长名称',
    projectIntent: { state: 'ready', roots: [
      { pluginId: 'missing/工具一', platforms: ['claude', 'codex'] },
      { pluginId: 'missing/工具二', platforms: ['claude'] },
    ] },
    pluginSummaries: [],
    payload: {
      schemaVersion: 8,
      catalog: { primarySourceId: 'official', configDigest: 'config', compositeDigest: 'catalog', sources: [] },
      filters: { plugins: [], platform: 'both', cwd: '/tmp/项目长名称' },
      targets: [], errors: [],
    },
  };
}

function scopedProjectRoots(pluginIds: string[]): RecoveryInventoryInput {
  return { scope: 'project', intent: { state: 'valid' },
    selection: { agents: ['claude-code'], preferences: 'valid' },
    inventory: pluginIds.map((pluginId) => ({ pluginId, source: pluginId.split('/')[0]!,
      sourceState: 'ready', blockers: [], targetResults: [{ pluginId, agent: 'claude-code',
        scope: 'project', delivery: { kind: 'native', platform: 'claude' },
        execution: 'not-run', observation: 'unknown', content: 'unknown', blockers: [], requiredBy: [] }] })),
    extraObserved: [], errors: [], allSatisfied: null };
}

function projectActionsData(pendingState: 'needsSync' | 'blocked' = 'needsSync'): TuiStatusLoadResult {
  const loaded = data();
  loaded.projectIntent = { state: 'ready', roots: [
    { pluginId: 'official/pending', platforms: ['claude'] },
    { pluginId: 'official/blocked', platforms: ['claude'] },
  ] };
  loaded.pluginSummaries = ['pending', 'blocked'].map((pluginName) => ({
    pluginId: `official/${pluginName}`, pluginName, displayName: pluginName,
    description: '项目插件', version: '1.0.0',
    supportedTargets: { codex: [], claude: ['project'] }, configFieldCount: 0,
  }));
  loaded.payload.targets = ['pending', 'blocked'].map((pluginName) => {
    const state = pluginName === 'pending' ? pendingState : 'blocked';
    return {
      pluginId: `official/${pluginName}`, pluginName, sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude' as const, scope: 'project' as const, cwd: '/tmp/项目长名称', version: '1.0.0',
      state,
      components: [
        { kind: 'intent' as const, key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'ownership' as const, key: 'fixture', state: 'absent' },
      ],
      reasons: state === 'blocked' ? [{ code: 'catalogSourceUnavailable', message: '来源不可用', severity: 'blocking' as const }] : [],
      recoveryActions: state === 'needsSync' ? [{ command: 'sync' as const, scope: 'project' as const, description: '同步目标' }] : [],
    };
  });
  return loaded;
}

async function tick(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 15));
}

async function input(instance: ReturnType<typeof render>, value: string): Promise<void> {
  instance.stdin.write(value);
  await tick();
  if (value === '\u001b') await new Promise((resolve) => setTimeout(resolve, 80));
}

function frame(instance: ReturnType<typeof render>, size: { columns: number; rows: number }): string {
  const result = instance.lastFrame() ?? '';
  expect(result.split('\n').length).toBeLessThanOrEqual(size.rows);
  expect(result.split('\n').every((line) => stringWidth(line) <= size.columns)).toBe(true);
  return result;
}

describe('v8.4 page contracts', () => {
  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps help readable without changing the underlying list or its focus at $columns x $rows', async (size) => {
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(projectActionsData()),
        captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'pluginList', mode: 'browse' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size}
        onSessionNavigation={vi.fn().mockResolvedValue('completed')} />);
      await tick();
      await input(instance, '\u001b[B');
      const before = frame(instance, size);
      await input(instance, '?');
      let help = frame(instance, size);
      expect(help).toContain('当前页快捷键');
      for (let index = 0; index < 4; index += 1) {
        await input(instance, '\u001b[C');
        help += frame(instance, size);
      }
      expect(help).toContain('/ 搜索');
      expect(help).toContain('f 筛选');
      expect(help).toContain('m 多选');
      expect(help).toContain('o 查看操作记录');
      await input(instance, '\u001b');
      expect(frame(instance, size)).toBe(before);
    },
  );

  it('advertises source information paging only while that information owns focus', async () => {
    const loaded = data();
    loaded.configuredSources = [{ id: 'official', type: 'path', primary: true, path: '/catalog', autoCheck: true }];
    loaded.payload.catalog.sources = [{ id: 'official', identity: 'source', type: 'path', primary: true,
      requestedRef: 'path', freshness: 'active' }];
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load(); controller.push({ name: 'sourceDetail', sourceId: 'official' });
    const size = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    expect(frame(instance, size)).toContain('PgUp/PgDn 翻信息');
    await input(instance, 'a');
    const before = frame(instance, size);
    expect(before).not.toContain('PgUp/PgDn 翻信息');
    await input(instance, '?');
    expect(frame(instance, size)).not.toContain('PgUp/PgDn 翻信息');
    await input(instance, '\u001b');
    expect(frame(instance, size)).toBe(before);
  });

  it('shows all plugin facts when the remaining space fits its only action', async () => {
    const loaded = data();
    const pluginId = `source${'x'.repeat(60)}/demo`;
    loaded.scopedRecovery = { project: scopedProjectRoots([pluginId]) };
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId });
    const size = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    const initial = frame(instance, size);
    expect(initial).toContain('Claude Code');
    expect(initial).toContain('未确认');
    expect(initial).not.toContain('上一页');
    expect(initial).not.toContain('翻信息');
    await input(instance, '\u001b[C');
    expect(frame(instance, size)).toBe(initial);
  });

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'pages readonly plugin information without moving action focus at $columns x $rows', async (size) => {
      const loaded = data();
      loaded.projectIntent = { state: 'ready', roots: [] };
      loaded.pluginSummaries = [{ pluginId: 'official/demo', pluginName: 'demo', displayName: 'Demo',
        description: Array.from({ length: 96 }, (_, index) => `用途行 ${index + 1}`).join('\n'),
        version: '1.0.0', supportedTargets: { claude: ['project'], codex: [] }, configFieldCount: 0 }];
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
        captureEvidence: vi.fn(), executeIntent });
      await controller.load(); controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const first = frame(instance, size);
      expect(first.split('\n').find((line) => line.includes('╭'))).toContain('Demo');
      expect(first).not.toContain('› Demo');
      const focusedAction = first.split('\n').find((line) => line.includes('› '))?.trim();
      expect(focusedAction).toBeTruthy();
      expect(first).toContain('1 /');
      let seen = first;
      for (let index = 0; index < 30; index += 1) {
        await input(instance, '\u001b[C');
        const current = frame(instance, size);
        expect(current.split('\n').find((line) => line.includes('› '))?.trim()).toBe(focusedAction);
        seen += current;
      }
      expect(seen).toContain('用途行 96');
      expect(seen).toContain('目录版本 1.0.0');
      await input(instance, '\u001b[D');
      expect(frame(instance, size)).not.toContain('› Demo');
      for (let index = 0; index < 8 && !frame(instance, size).includes('› 更多操作'); index += 1) {
        await input(instance, '\u001b[B');
      }
      expect(frame(instance, size)).toContain('› 更多操作');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('pluginMore');
      expect(executeIntent).not.toHaveBeenCalled();
    },
  );

  it('keeps hidden batch selections while search changes and restores the selected list', async () => {
    const loaded = data();
    loaded.projectIntent = { state: 'absent' };
    loaded.payload.catalog.sources = [{ id: 'official', identity: 'one', type: 'path', primary: true, requestedRef: 'local' }];
    loaded.pluginSummaries = ['First', 'Second'].map((name) => ({
      pluginId: `official/${name.toLowerCase()}`, pluginName: name.toLowerCase(),
      displayName: name, description: `${name} purpose`, version: '1.0.0',
      supportedTargets: { claude: ['user' as const], codex: [] }, configFieldCount: 0,
    }));
    loaded.payload.targets = ['first', 'second'].map((name) => ({
      pluginId: `official/${name}`, pluginName: name, sourceId: 'official', sourceIdentity: 'one',
      platform: 'claude' as const, scope: 'user' as const, cwd: '/tmp/项目长名称', version: '1.0.0',
      state: 'absent' as const, components: [], reasons: [], recoveryActions: [],
    }));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load(); controller.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await input(instance, 'm');
    expect(controller.snapshot.router.current.route.name).toBe('batchSelection');
    await input(instance, ' ');
    expect(instance.lastFrame()).toContain('已选 1');
    await input(instance, '/'); await input(instance, 'Second'); await input(instance, '\r');
    expect(instance.lastFrame()).toContain('隐藏已选 1');
    expect(instance.lastFrame()).toContain('Second');
    expect(instance.lastFrame()).not.toContain('› [✓] First');
    await input(instance, '\r');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/second' });
    await input(instance, '\u001b');
    expect(controller.snapshot.router.current.route.name).toBe('batchSelection');
    expect(instance.lastFrame()).toContain('隐藏已选 1');
    instance.unmount();
  });

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps three domain cards and unresolved scoped roots reachable at $columns x $rows', async (size) => {
      const loadStatus = vi.fn().mockImplementation(async () => data());
      const loadScopedStatus = vi.fn().mockResolvedValue({ ...scopedProjectRoots(['missing/工具一', 'missing/工具二']),
        nativeSnapshot: { payload: data().payload, pluginSummaries: data().pluginSummaries,
          targetRevisions: [], dependencyOverviews: [] } });
      const executeIntent = vi.fn();
      const captureEvidence = vi.fn();
      const controller = new TuiController({ loadStatus, loadScopedStatus, executeIntent, captureEvidence });
      await controller.load();
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const home = frame(instance, size);
      expect(home.match(/╭/gu)).toHaveLength(3);
      expect(home).toContain('插件清单');
      expect(home).not.toContain('没有待同步提醒');
      await input(instance, '\u001b[B');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('intentScopes');
      await input(instance, '\u001b[B');
      await input(instance, '\r');
      await vi.waitFor(() => expect(loadScopedStatus).toHaveBeenCalledWith('project', expect.anything()));
      expect(controller.snapshot.router.current.route.name).toBe('intentInventory');
      const project = frame(instance, size);
      expect(project).toContain('工具一');
      expect(project).toContain('当前项目清单');
      for (let step = 0; step < 12 && !instance.lastFrame()?.includes('工具二'); step += 1) {
        await input(instance, '\u001b[B');
      }
      expect(frame(instance, size)).toContain('工具二');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `pages-${size.columns}x${size.rows}.json`), { synthetic: true, size, frames: { home, project } }, { spaces: 2 });
      await input(instance, '/');
      await input(instance, '工具二');
      await input(instance, '\r');
      expect(frame(instance, size)).toContain('工具二');
      expect(frame(instance, size)).not.toContain('工具一');
      await input(instance, 'r');
      expect(loadScopedStatus).toHaveBeenCalledTimes(2);
      expect(controller.snapshot.router.current.context.query).toBe('工具二');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'missing/工具二' });
      expect(frame(instance, size)).toContain('目录定义当前不可用');
      expect(frame(instance, size)).toContain('Claude Code');
      await input(instance, '\u001b');
      expect(controller.snapshot.router.current.route.name).toBe('intentInventory');
      expect(controller.snapshot.router.current.context.query).toBe('工具二');
      expect(executeIntent).not.toHaveBeenCalled();
      expect(captureEvidence).not.toHaveBeenCalled();
      instance.unmount();
    },
  );

  it('retains a selected zero-result filter during search and drops it after cycling away', async () => {
    const loaded = data();
    loaded.payload.catalog.sources = [{ id: 'official', identity: 'source', type: 'path', primary: true, requestedRef: 'local' }];
    loaded.pluginSummaries = [{ pluginId: 'official/tool', pluginName: 'tool', displayName: 'Installed Tool',
      description: '工具说明', version: '1.0.0', supportedTargets: { claude: ['user'], codex: [] }, configFieldCount: 0 }];
    loaded.payload.targets = [{ pluginId: 'official/tool', pluginName: 'tool', sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude', scope: 'user', cwd: '/tmp/项目长名称', version: '1.0.0', state: 'ready',
      components: [{ kind: 'ownership', key: 'skill', state: 'present' }], reasons: [], recoveryActions: [] }];
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load();
    controller.push({ name: 'pluginList', mode: 'browse' }, { installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('[已安装 1]');
    await input(instance, '/'); await input(instance, 'no-match'); await input(instance, '\r');
    expect(instance.lastFrame()).toContain('[已安装 0]');
    expect(instance.lastFrame()).toContain('本条件无匹配');
    expect(controller.snapshot.router.current.context.installFilter).toBe('installed');
    await input(instance, 'f');
    expect(controller.snapshot.router.current.context.installFilter).toBe('all');
    expect(instance.lastFrame()).not.toContain('[已安装 0]');
    await input(instance, 'f');
    expect(controller.snapshot.router.current.context.installFilter).toBe('all');
  });

  it.each([58, 78])('keeps a two-line value complete and source separate at width %i', (width) => {
    const value = '中文配置值'.repeat(7);
    const props = { width, title: '模型设置', value, source: '插件默认', focused: true };
    const instance = render(<ConfigTile {...props} />);
    const lines = (instance.lastFrame() ?? '').split('\n');
    expect(lines).toHaveLength(configTileHeight(props));
    expect(lines[0]).toContain('[插件默认]');
    expect(lines.slice(1, -1).map((line) => line.slice(1, -1).trim()).join('')).toBe(value);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
  });
});
