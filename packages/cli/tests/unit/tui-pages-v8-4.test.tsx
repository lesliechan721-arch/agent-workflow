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
    'returns to the same project issues action before another Enter at $columns x $rows', async (size) => {
      const loadStatus = vi.fn().mockResolvedValue(projectActionsData());
      const captureEvidence = vi.fn();
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus, captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      for (let index = 0; index < 8 && !frame(instance, size).includes('› 查看需要处理'); index += 1) {
        await input(instance, '\u001b[B');
      }
      const before = frame(instance, size);
      expect(before).toContain('› 查看需要处理');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('issueList');
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(returned).toContain('› 查看需要处理');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('issueList');
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-return-issues-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { before, returned } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps the project issues action when sync appears while the issues page is open at $columns x $rows', async (size) => {
      const loadStatus = vi.fn().mockResolvedValueOnce(projectActionsData('blocked'))
        .mockResolvedValue(projectActionsData());
      const captureEvidence = vi.fn();
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus, captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      for (let index = 0; index < 8 && !frame(instance, size).includes('› 查看需要处理'); index += 1) {
        await input(instance, '\u001b[B');
      }
      expect(frame(instance, size)).toContain('› 查看需要处理');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('issueList');
      await controller.refreshProjectInventory(); await tick();
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(controller.snapshot.projectInventory?.syncTargets).toHaveLength(1);
      expect(returned).toContain('› 查看需要处理');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('issueList');
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-return-insert-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { returned } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'returns to a project root when the issues action vanishes in its child page at $columns x $rows', async (size) => {
      const after = projectActionsData();
      after.payload.targets = after.payload.targets.map((target) => ({
        ...target, state: 'ready' as const,
        components: target.components.map((component) => component.kind === 'ownership'
          ? { ...component, state: 'present' as const } : component),
        reasons: [], recoveryActions: [],
      }));
      const loadStatus = vi.fn().mockResolvedValueOnce(projectActionsData()).mockResolvedValue(after);
      const captureEvidence = vi.fn();
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus, captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      for (let index = 0; index < 8 && !frame(instance, size).includes('› 查看需要处理'); index += 1) {
        await input(instance, '\u001b[B');
      }
      expect(frame(instance, size)).toContain('› 查看需要处理');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('issueList');
      await controller.refreshProjectInventory(); await tick();
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(returned).not.toContain('查看需要处理');
      expect(returned).toContain('› blocked');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/blocked' });
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-return-issues-vanish-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { returned } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'returns to recheck when a searched root vanishes but sync remains at $columns x $rows', async (size) => {
      const before = projectActionsData();
      const after = projectActionsData();
      after.projectIntent = { state: 'ready', roots: [{ pluginId: 'official/blocked', platforms: ['claude'] }] };
      after.payload.targets = after.payload.targets.filter((target) => target.pluginId === 'official/blocked')
        .map((target) => ({ ...target, state: 'needsSync' as const, reasons: [],
          recoveryActions: [{ command: 'sync' as const, scope: 'project' as const, description: '同步目标' }] }));
      const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
      const captureEvidence = vi.fn();
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus, captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, '/'); await input(instance, 'pending'); await input(instance, '\r');
      expect(frame(instance, size)).toContain('› pending');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/pending' });
      await controller.refreshProjectInventory(); await tick();
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(controller.snapshot.router.current.context.query).toBe('pending');
      expect(controller.snapshot.projectInventory?.syncTargets).toHaveLength(1);
      expect(returned).toContain('当前条件无匹配');
      expect(returned).toContain('› 重新检查项目 [r]');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(3);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-return-vanish-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { returned } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'returns to the searched project root after its detail page at $columns x $rows', async (size) => {
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(projectActionsData()),
        captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, '/'); await input(instance, 'blocked'); await input(instance, '\r');
      expect(frame(instance, size)).toContain('› blocked');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/blocked' });
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.context.query).toBe('blocked');
      expect(returned).toContain('› blocked');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/blocked' });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'returns to the project sync action after Review preparation fails at $columns x $rows', async (size) => {
      const captureEvidence = vi.fn().mockRejectedValue(new Error('evidence unavailable'));
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(projectActionsData()),
        captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      expect(frame(instance, size)).toContain('› 同步全部可处理声明（1） [c]');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
      await vi.waitFor(() => expect(controller.snapshot.reviewPreparation?.state).toBe('failed'));
      await input(instance, '\u001b');
      const returned = frame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      expect(returned).toContain('› 同步全部可处理声明（1） [c]');
      expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({ kind: 'pluginWriteBatch' }), expect.any(AbortSignal));
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-return-review-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { returned } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps the project recheck action when roots and issue actions appear at $columns x $rows', async (size) => {
      const before = data();
      before.projectIntent = { state: 'absent' };
      const after = data();
      const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      expect(frame(instance, size)).toContain('› 重新检查项目 [r]');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(2);
      const inserted = frame(instance, size);
      expect(inserted).toContain('[项目声明 2]');
      expect(controller.snapshot.projectInventory?.declaredRoots).toHaveLength(2);
      expect(inserted).toContain('› 重新检查项目 [r]');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(3);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-action-insert-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { inserted } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'marks retained project facts after a failed check and clears the mark on success at $columns x $rows', async (size) => {
      const loaded = data();
      const loadStatus = vi.fn().mockResolvedValueOnce(loaded)
        .mockRejectedValueOnce(new Error('project status read failed'))
        .mockResolvedValue(loaded);
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, '/');
      await input(instance, '工具二');
      await input(instance, '\r');
      const before = frame(instance, size);
      expect(before).toContain('工具二');
      await input(instance, 'r');
      expect(controller.snapshot.projectInventoryRefresh.state).toBe('error');
      const failed = frame(instance, size);
      expect(failed).toContain('工具二');
      expect(failed).toContain('上次检查结果');
      expect(controller.snapshot.router.current.context.query).toBe('工具二');
      await input(instance, '\u001b');
      const home = frame(instance, size);
      expect(home).toContain('上次检查结果');
      await input(instance, '\u001b[B');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
      await input(instance, 'r');
      expect(controller.snapshot.projectInventoryRefresh.state).toBe('idle');
      const recovered = frame(instance, size);
      expect(recovered).not.toContain('上次检查结果');
      await input(instance, '\u001b');
      expect(frame(instance, size)).not.toContain('上次检查结果');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-stale-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { before, failed, home, recovered } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps a searched project root focused through failure and successful retry at $columns x $rows', async (size) => {
      const loaded = data();
      const loadStatus = vi.fn().mockResolvedValueOnce(loaded)
        .mockRejectedValueOnce(new Error('temporary read failure')).mockResolvedValue(loaded);
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, '/'); await input(instance, '工具二'); await input(instance, '\r');
      expect(frame(instance, size)).toContain('› 工具二');
      await input(instance, 'r');
      expect(controller.snapshot.projectInventoryRefresh.state).toBe('error');
      expect(frame(instance, size)).toContain('› 工具二');
      await input(instance, 'r');
      expect(controller.snapshot.projectInventoryRefresh.state).toBe('idle');
      const recovered = frame(instance, size);
      expect(recovered).toContain('› 工具二');
      expect(recovered).toContain('[/] 工具二');
      expect(recovered).not.toContain('上次检查结果');
      expect(controller.snapshot.router.current.context.query).toBe('工具二');
      expect(controller.snapshot.projectInventory?.declaredRoots).toHaveLength(2);
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'falls back to a safe project action when the focused error action disappears at $columns x $rows', async (size) => {
      const before = data();
      const after = data();
      after.projectIntent = { state: 'absent' };
      const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      expect(frame(instance, size)).toContain('› 错误详情');
      await input(instance, 'r');
      expect(loadStatus).toHaveBeenCalledTimes(2);
      const afterRefresh = frame(instance, size);
      expect(afterRefresh).toContain('› 重新检查项目 [r]');
      expect(afterRefresh).not.toContain('错误详情');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(3);
      expect(controller.snapshot.router.current.route.name).toBe('projectStatus');
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'does not turn a vanished project error action into the remaining sync action at $columns x $rows', async (size) => {
      const before = data();
      before.projectIntent = { state: 'ready', roots: [
        { pluginId: 'official/pending', platforms: ['claude'] },
        { pluginId: 'official/blocked', platforms: ['claude'] },
      ] };
      const target = (pluginName: string, state: 'needsSync' | 'blocked' | 'ready') => ({
        pluginId: `official/${pluginName}`, pluginName, sourceId: 'official', sourceIdentity: 'source',
        platform: 'claude' as const, scope: 'project' as const, cwd: '/tmp/项目长名称', version: '1.0.0',
        state, components: [
          { kind: 'intent' as const, key: 'desired', state: 'desired', metadata: {
            enabled: true, scopes: ['project'], relation: 'root',
          } },
          { kind: 'ownership' as const, key: 'fixture', state: state === 'ready' ? 'present' : 'absent' },
        ],
        reasons: state === 'blocked' ? [{ code: 'catalogSourceUnavailable', message: '来源不可用', severity: 'blocking' as const }] : [],
        recoveryActions: state === 'needsSync' ? [{ command: 'sync' as const, scope: 'project' as const, description: '同步目标' }] : [],
      });
      before.payload.targets = [target('pending', 'needsSync'), target('blocked', 'blocked')];
      const after = structuredClone(before);
      after.payload.targets = [target('pending', 'needsSync'), target('blocked', 'ready')];
      const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
      const captureEvidence = vi.fn();
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus, captureEvidence, executeIntent });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, '/'); await input(instance, 'no-match'); await input(instance, '\r');
      await input(instance, 'a');
      expect(frame(instance, size)).toContain('› 同步全部可处理声明（1） [c]');
      for (let index = 0; index < 8 && !frame(instance, size).includes('› 错误详情'); index += 1) {
        await input(instance, '\u001b[B');
      }
      expect(frame(instance, size)).toContain('› 错误详情');
      await input(instance, 'r');
      expect(loadStatus).toHaveBeenCalledTimes(2);
      const afterRefresh = frame(instance, size);
      expect(afterRefresh).toContain('› 重新检查项目 [r]');
      expect(afterRefresh).toContain('同步全部可处理声明（1）');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(3);
      expect(captureEvidence).not.toHaveBeenCalled();
      expect(executeIntent).not.toHaveBeenCalled();
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(
        path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `project-safe-fallback-${size.columns}x${size.rows}.json`),
        { synthetic: true, size, frames: { afterRefresh } }, { spaces: 2 });
    },
  );

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'keeps project recheck safe across technical details and refresh at $columns x $rows', async (size) => {
      const before = data();
      const after = data();
      after.projectIntent = { state: 'absent' };
      const loadStatus = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after);
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await tick();
      await input(instance, 'a');
      await input(instance, '\r');
      expect(frame(instance, size)).toContain('项目状态安全详情');
      expect(frame(instance, size)).toContain('› 重新检查项目 [r]');
      await input(instance, 'r');
      expect(loadStatus).toHaveBeenCalledTimes(2);
      expect(frame(instance, size)).toContain('› 重新检查项目 [r]');
      await input(instance, 'd');
      expect(frame(instance, size)).toContain('› 重新检查项目 [r]');
      await input(instance, '\r');
      expect(loadStatus).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    { columns: 80, rows: 24, declaration: 'absent' as const },
    { columns: 60, rows: 18, declaration: 'absent' as const },
    { columns: 80, rows: 24, declaration: 'notProject' as const },
    { columns: 60, rows: 18, declaration: 'notProject' as const },
  ])('keeps a failed project check visible over an old $declaration result at $columns x $rows', async ({ columns, rows, declaration }) => {
    const loaded = data();
    loaded.projectIntent = { state: 'absent' };
    if (declaration === 'notProject') delete loaded.projectRoot;
    const controller = new TuiController({
      loadStatus: vi.fn().mockResolvedValueOnce(loaded).mockRejectedValueOnce(new Error('read failed')),
      captureEvidence: vi.fn(), executeIntent: vi.fn(),
    });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const size = { columns, rows };
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    await input(instance, 'r');
    expect(controller.snapshot.projectInventoryRefresh.state).toBe('error');
    expect(frame(instance, size)).toContain('上次检查结果');
    await input(instance, '\u001b');
    const home = frame(instance, size);
    expect(home).toContain('上次检查结果');
    expect(home).toContain(declaration === 'absent' ? '未配置项目插件' : '当前不是项目');
  });

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
