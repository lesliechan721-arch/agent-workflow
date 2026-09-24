import fs from 'fs-extra';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { ConfigTile, configTileHeight } from '../../src/tui/components.js';

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
    'keeps project section, status, search, and root focus on one page at $columns x $rows', async (size) => {
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(data()),
        captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const initial = frame(instance, size);
      expect(initial).toContain('[项目声明');
      expect(initial).toContain('[全部 2]');
      await input(instance, 'f');
      const filtered = frame(instance, size);
      expect(filtered).toContain('[受阻 2]');
      expect(controller.snapshot.router.current.context.projectSection).toBeUndefined();
      expect(controller.snapshot.router.current.context.projectStatusFilter).toBe('blocked');
      await input(instance, '/');
      await input(instance, 'fmcshrHq?');
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(controller.snapshot.router.current.context.query).toBe('fmcshrHq?');
      expect(controller.snapshot.router.current.context.projectStatusFilter).toBe('blocked');
      await input(instance, '\u001b[D');
      expect(controller.snapshot.router.current.context.projectSection).toBeUndefined();
      await input(instance, '\r');
      const zero = frame(instance, size);
      expect(zero).toContain('当前条件无匹配');
      expect(zero).toContain('[受阻 0]');
      await input(instance, '\u001b[C');
      expect(controller.snapshot.router.current.context.projectSection).toBe('extraInstalled');
      await input(instance, '\u001b');
      expect(controller.snapshot.router.current.route.name).toBe('home');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `query-project-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { initial, filtered, zero } }, { spaces: 2 });
      instance.unmount();
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'searches source identity and address without routing or triggering shortcuts at $columns x $rows', async (size) => {
      const loaded = data();
      loaded.payload.catalog.sources = [
        { id: 'official', identity: 'one', type: 'git', primary: true, requestedRef: 'main' },
        { id: 'team', identity: 'two', type: 'path', primary: false, requestedRef: 'local' },
      ];
      loaded.configuredSources = [
        { id: 'official', type: 'git', primary: true, url: 'https://example.com/official-catalog', refPolicy: { type: 'explicit', ref: 'main' } },
        { id: 'team', type: 'path', primary: false, path: '/tmp/catalog-team' },
      ];
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
        captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'sourceList' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const initial = frame(instance, size);
      expect(initial).toContain('类型');
      await input(instance, '/');
      await input(instance, 'catalog-team');
      await input(instance, '\r');
      const searched = frame(instance, size);
      expect(searched).toContain('team');
      expect(searched).not.toContain('› official');
      expect(controller.snapshot.router.current.context.query).toBe('catalog-team');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team' });
      await input(instance, '\u001b');
      expect(controller.snapshot.router.current.route.name).toBe('sourceList');
      expect(controller.snapshot.router.current.context.query).toBe('catalog-team');
      await input(instance, '\u001b[C');
      expect(controller.snapshot.router.current.context.sourceTypeTab).toBe('git');
      const zero = frame(instance, size);
      expect(zero).toContain('当前条件无匹配');
      expect(controller.snapshot.router.current.route.name).toBe('sourceList');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `query-source-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { initial, searched, zero } }, { spaces: 2 });
      instance.unmount();
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
    'keeps three domain cards and unresolved project roots reachable at $columns x $rows', async (size) => {
      const loadStatus = vi.fn().mockImplementation(async () => data());
      const executeIntent = vi.fn();
      const captureEvidence = vi.fn();
      const controller = new TuiController({ loadStatus, executeIntent, captureEvidence });
      await controller.load();
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      const home = frame(instance, size);
      expect(home.match(/╭/gu)).toHaveLength(3);
      expect(home).toContain('项目插件');
      expect(home).toContain('2 受阻');
      expect(home).not.toContain('没有待同步提醒');
      await input(instance, '\u001b[B');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      const project = frame(instance, size);
      expect(project).toContain('工具一');
      expect(project.match(/项目长名称/gu)).toHaveLength(1);
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
      expect(loadStatus).toHaveBeenCalledTimes(2);
      expect(controller.snapshot.router.current.context.query).toBe('工具二');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'missing/工具二' });
      expect(frame(instance, size)).toContain('目录定义当前不可用');
      expect(frame(instance, size)).toContain('Claude Code [当前项目] [项目声明]');
      await input(instance, '\u001b');
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
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

  it('retains the focused project root across refresh sorting and a detail round trip', async () => {
    const before = data();
    before.projectIntent = { state: 'ready', roots: [
      { pluginId: 'official/first', platforms: ['claude'] }, { pluginId: 'official/second', platforms: ['claude'] },
    ] };
    before.pluginSummaries = ['first', 'second'].map((name, index) => ({ pluginId: `official/${name}`, pluginName: name,
      displayName: index === 0 ? 'A Root' : 'B Root', description: 'Project root', version: '1.0.0',
      supportedTargets: { claude: ['project'], codex: [] }, configFieldCount: 0 }));
    const after = structuredClone(before);
    after.pluginSummaries[0]!.displayName = 'Z Root';
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after).mockResolvedValue(before),
      captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('› A Root');
    await input(instance, 'r');
    expect(instance.lastFrame()).toContain('› Z Root');
    await input(instance, '\r');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/first' });
    await controller.refreshProjectInventory(); await tick();
    await input(instance, '\u001b');
    await input(instance, '\r');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/first' });
  });

  it('shows a proven shared user dependency inside its project root without a second root or sync target', async () => {
    const loaded = data();
    loaded.projectIntent = { state: 'ready', roots: [{ pluginId: 'official/root', platforms: ['claude'] }] };
    loaded.payload.catalog.sources = [{ id: 'official', identity: 'source', type: 'path', primary: true, requestedRef: 'local' }];
    loaded.pluginSummaries = ['root', 'shared'].map((name) => ({ pluginId: `official/${name}`, pluginName: name,
      displayName: name, description: 'Plugin', version: '1.0.0', supportedTargets: { claude: ['project', 'user'], codex: [] }, configFieldCount: 0 }));
    loaded.payload.targets = [{ pluginId: 'official/root', pluginName: 'root', sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude', scope: 'project', cwd: '/tmp/项目长名称', version: '1.0.0', state: 'ready',
      components: [{ kind: 'ownership', key: 'skill', state: 'present' },
        { kind: 'dependency', key: 'official/shared', state: 'ready', metadata: { platform: 'claude', scope: 'user' } }],
      reasons: [], recoveryActions: [] }, { pluginId: 'official/shared', pluginName: 'shared', sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude', scope: 'user', cwd: '/tmp/项目长名称', version: '1.0.0', state: 'ready',
      components: [{ kind: 'ownership', key: 'skill', state: 'present' }], reasons: [], recoveryActions: [] }];
    loaded.dependencyOverviews = [{ pluginId: 'official/root', summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [{ pluginId: 'official/shared', displayName: 'shared', relation: 'direct', depth: 1,
        requiredBy: [{ pluginId: 'official/root', displayName: 'root' }], placements: [], aggregateStatus: 'ready' }], dependents: [], blockers: [] }];
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(controller.snapshot.projectInventory?.declaredRoots).toHaveLength(1);
    expect(controller.snapshot.projectInventory?.syncTargets).toEqual([]);
    expect(instance.lastFrame()).toContain('依赖 shared');
    await input(instance, '\u001b[B');
    expect(instance.lastFrame()).toContain('共用个人安装');
    expect((instance.lastFrame() ?? '').match(/╭/gu)).toHaveLength(1);
    const scrolledRoot = instance.lastFrame();
    await input(instance, '\r');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/root' });
    expect(instance.lastFrame()).toContain('依赖关系');
    await input(instance, '\u001b');
    expect(instance.lastFrame()).toBe(scrolledRoot);
    await input(instance, 'd');
    let technical = instance.lastFrame() ?? '';
    for (let index = 0; index < 5; index += 1) { await input(instance, '\u001b[C'); technical += instance.lastFrame(); }
    expect(technical).toContain('official/shared');
    expect(technical).toContain('共用');
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
