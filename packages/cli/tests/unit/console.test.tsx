import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDashboardController,
  dashboardActions,
  runConsoleController,
  type DashboardController,
} from '../../src/commands/console.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  emitCommandNotice,
} from '../../src/commands/runtime.js';
import type { ConsoleItemsLoadResult, LiveConsoleItem } from '../../src/commands/status.js';
import {
  Dashboard,
  createInitialDashboardState,
  dashboardReducer,
} from '../../src/tui/dashboard.js';

const mocks = vi.hoisted(() => ({
  loadConsoleItemsResult: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  resolveEffectivePluginConfig: vi.fn(),
  resolveConfigRead: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
}));

vi.mock('../../src/commands/status.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/status.js')>(
    '../../src/commands/status.js',
  );
  return { ...actual, loadConsoleItemsResult: mocks.loadConsoleItemsResult };
});

vi.mock('../../src/commands/write-commands.js', () => ({
  installWriteCommand: mocks.installWriteCommand,
  reinstallWriteCommand: mocks.reinstallWriteCommand,
  cleanupWriteCommand: mocks.cleanupWriteCommand,
  upgradeWriteCommand: mocks.upgradeWriteCommand,
  uninstallWriteCommand: mocks.uninstallWriteCommand,
}));

vi.mock('../../src/utils/plugin-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>(
    '../../src/utils/plugin-config.js',
  );
  return {
    ...actual,
    resolveEffectivePluginConfig: mocks.resolveEffectivePluginConfig,
    resolveConfigRead: mocks.resolveConfigRead,
  };
});

vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite: mocks.applyPluginConfigWrite,
  resetPluginConfigWithHelper: mocks.resetPluginConfigWithHelper,
}));

function item(
  pluginName: string,
  state: 'present' | 'absent' | 'partial' | 'error',
  withConfig = true,
): LiveConsoleItem {
  return {
    pluginName,
    version: '1.0.0',
    plugin: {
      rootDir: `/catalog/${pluginName}`,
      manifestPath: `/catalog/${pluginName}/.agents-plugin/plugin.json`,
      manifest: {
        name: pluginName,
        version: '1.0.0',
        description: 'demo',
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        ...(withConfig ? { config: { schema: { token: { type: 'string', sensitive: true } } } } : {}),
      },
    },
    targets: [{
      target: {
        plugin: pluginName,
        version: '1.0.0',
        platform: 'codex',
        scope: 'user',
        cwd: '/workspace',
      },
      state,
      components: [],
      errors: [],
    }],
  };
}

function loaded(items: LiveConsoleItem[]): ConsoleItemsLoadResult {
  return {
    items,
    catalogUnavailable: false,
    status: {
      schemaVersion: 3,
      catalog: { catalogVersion: '1.2.3', source: 'cache' },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: items.flatMap((entry) => entry.targets),
      errors: [],
    },
  };
}

function fakeController(value: ConsoleItemsLoadResult): DashboardController {
  return {
    cwd: '/workspace',
    load: vi.fn().mockResolvedValue(value),
    execute: vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [],
      warnings: [],
    }),
    readConfig: vi.fn(),
    saveConfig: vi.fn(),
    resetConfig: vi.fn(),
  } as unknown as DashboardController;
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function frameRows(instance: ReturnType<typeof render>): number {
  return instance.lastFrame()?.split('\n').length ?? 0;
}

async function writeInput(
  instance: ReturnType<typeof render>,
  ...inputs: string[]
): Promise<void> {
  for (const input of inputs) {
    instance.stdin.write(input);
    await nextTurn();
  }
}

function withConfigController(value: ConsoleItemsLoadResult): DashboardController {
  const controller = fakeController(value);
  controller.readConfig = vi.fn().mockResolvedValue({
    location: { scope: 'user', projectLayer: 'shared' },
    model: {
      pluginName: 'demo',
      allowedScopes: ['user', 'project'],
      initialScope: 'user',
      requiredKeys: [],
      fields: [{
        key: 'token',
        type: 'string',
        label: 'Token',
        description: '访问令牌',
        required: true,
        sensitive: true,
        configured: true,
      }],
    },
    read: {
      pluginName: 'demo',
      scope: 'user',
      projectLayer: 'shared',
      fields: [{
        key: 'token',
        title: 'Token',
        kind: 'manifest',
        reserved: false,
        writable: true,
        valueState: 'configured',
        effectiveValue: '[redacted]',
        sourceLayer: 'user',
      }],
    },
  });
  controller.saveConfig = vi.fn().mockResolvedValue({
    overallState: 'succeeded',
    targetResults: [{
      target: { pluginName: 'demo', platform: 'codex', scope: 'user' },
      action: 'reinstall',
      state: 'completed',
    }],
    warnings: [],
  });
  controller.resetConfig = vi.fn().mockResolvedValue({
    overallState: 'succeeded',
    targetResults: [],
    warnings: [],
  });
  return controller;
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const command of [
    mocks.installWriteCommand,
    mocks.reinstallWriteCommand,
    mocks.cleanupWriteCommand,
    mocks.upgradeWriteCommand,
    mocks.uninstallWriteCommand,
  ]) command.mockResolvedValue({ overallState: 'succeeded', targetResults: [], warnings: [] });
  mocks.resolveEffectivePluginConfig.mockResolvedValue({
    pluginName: 'demo',
    projectRoot: '/workspace',
    values: {},
    redactedValues: {},
    sources: {},
    issues: [],
    ignoredUnknownKeys: [],
    schema: {},
    stores: {},
  });
  mocks.resolveConfigRead.mockResolvedValue({
    pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [],
  });
  mocks.applyPluginConfigWrite.mockResolvedValue({
    overallState: 'succeeded', targetResults: [], warnings: [], updatedKeys: [], removedKeys: [],
  });
  mocks.resetPluginConfigWithHelper.mockResolvedValue({
    overallState: 'succeeded', targetResults: [], warnings: [], deleted: true, removedKeys: [],
  });
});

describe('dashboard controller and reducer', () => {
  it('keeps the legacy action matrix exactly', () => {
    expect(dashboardActions(item('demo', 'absent'), item('demo', 'absent').targets[0]!)).toEqual([
      'install', 'config', 'refresh', 'back', 'exit',
    ]);
    expect(dashboardActions(item('demo', 'partial'), item('demo', 'partial').targets[0]!)).toEqual([
      'reinstall', 'cleanup', 'config', 'refresh', 'back', 'exit',
    ]);
    expect(dashboardActions(item('demo', 'present'), item('demo', 'present').targets[0]!)).toEqual([
      'reinstall', 'upgrade', 'uninstall', 'cleanup', 'config', 'refresh', 'back', 'exit',
    ]);
    expect(dashboardActions(item('demo', 'error', false), item('demo', 'error').targets[0]!)).toEqual([
      'cleanup', 'refresh', 'back', 'exit',
    ]);
  });

  it('loads status v3 once and dispatches each write helper with the selected target identity', async () => {
    const value = loaded([item('demo', 'absent')]);
    mocks.loadConsoleItemsResult.mockResolvedValue(value);
    const context = createCliExecutionContext({ cwd: '/workspace', interactive: true });
    const controller = createDashboardController(context);

    await expect(controller.load()).resolves.toBe(value);
    expect(mocks.loadConsoleItemsResult).toHaveBeenCalledWith(
      { cwd: '/workspace', includeCatalogOnly: true },
      context,
    );
    for (const [action, command] of [
      ['install', mocks.installWriteCommand],
      ['reinstall', mocks.reinstallWriteCommand],
      ['upgrade', mocks.upgradeWriteCommand],
      ['uninstall', mocks.uninstallWriteCommand],
      ['cleanup', mocks.cleanupWriteCommand],
    ] as const) {
      await controller.execute(action, value.items[0]!.targets[0]!);
      expect(command).toHaveBeenCalledWith(
        ['demo'],
        { cwd: '/workspace', platform: 'codex', scope: 'user' },
        context,
      );
    }
  });

  it.each([
    [{ scope: 'user', projectLayer: 'shared' }],
    [{ scope: 'project', projectLayer: 'shared' }],
    [{ scope: 'project', projectLayer: 'local' }],
  ] as const)('passes %j to config read, save, and reset helpers', async (location) => {
    const value = loaded([item('demo', 'present')]);
    const context = createCliExecutionContext({ cwd: '/workspace', interactive: true });
    const controller = createDashboardController(context);

    await controller.readConfig(value.items[0]!, location);
    await controller.saveConfig(value.items[0]!, location, { updates: { token: 'value' } });
    await controller.resetConfig(value.items[0]!, location);

    expect(mocks.resolveConfigRead).toHaveBeenCalledWith(expect.objectContaining(location));
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining(location));
    expect(mocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining(location));
  });

  it('preserves plugin and target identity after refresh and falls back when they disappear', () => {
    const alpha = item('alpha', 'present');
    const beta = item('beta', 'present');
    let state = dashboardReducer(createInitialDashboardState(), {
      type: 'load-success', loaded: loaded([alpha, beta]),
    });
    state = dashboardReducer(state, { type: 'move', region: 'plugins', delta: 1 });
    state = dashboardReducer(state, { type: 'load-success', loaded: loaded([beta, alpha]) });
    expect(state.loaded?.items[state.pluginIndex]?.pluginName).toBe('beta');
    state = dashboardReducer(state, { type: 'load-success', loaded: loaded([alpha]) });
    expect(state.loaded?.items[state.pluginIndex]?.pluginName).toBe('alpha');
  });

  it('marks Ctrl-C during busy as exit-after-completion', () => {
    let state = dashboardReducer(createInitialDashboardState(), {
      type: 'busy-start', action: '安装', target: 'demo codex/user', startedAt: 1,
    });
    state = dashboardReducer(state, { type: 'busy-exit-after' });
    expect(state.busy?.exitAfter).toBe(true);
  });
});

describe('dashboard rendering and input', () => {
  it('renders three-column, single-column, and too-small views with text status symbols', async () => {
    const value = loaded([item('demo', 'present')]);
    const three = render(<Dashboard controller={fakeController(value)} onComplete={() => undefined} size={{ columns: 110, rows: 18 }} />);
    const single = render(<Dashboard controller={fakeController(value)} onComplete={() => undefined} size={{ columns: 80, rows: 18 }} />);
    const small = render(<Dashboard controller={fakeController(value)} onComplete={() => undefined} size={{ columns: 59, rows: 16 }} />);
    await nextTurn();

    expect(three.lastFrame()).toContain('插件');
    expect(three.lastFrame()).toContain('操作');
    expect(three.lastFrame()).toContain('详情');
    expect(three.lastFrame()).toContain('● 已就绪');
    expect(single.lastFrame()).toContain('插件');
    expect(single.lastFrame()).not.toContain('终端空间不足');
    expect(small.lastFrame()).toContain('终端空间不足');
  });

  it('navigates plugin, target, action and cancels an inline destructive confirmation', async () => {
    const controller = fakeController(loaded([item('demo', 'present')]));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 80, rows: 18 }} />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('确认卸载');
    instance.stdin.write('n');
    await nextTurn();
    expect(controller.execute).not.toHaveBeenCalled();
  });

  it('executes a confirmed write, shows busy and receipt, then refreshes status', async () => {
    const value = loaded([item('demo', 'present')]);
    const write = deferred<Awaited<ReturnType<DashboardController['execute']>>>();
    const controller = fakeController(value);
    controller.execute = vi.fn(() => write.promise);
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();

    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\r', 'y');
    expect(instance.lastFrame()).toContain('卸载');
    expect(instance.lastFrame()).toContain('0s');
    write.resolve({
      overallState: 'succeeded',
      targetResults: Array.from({ length: 10 }, () => ({
        target: { pluginName: 'demo', platform: 'codex', scope: 'user' },
        action: 'uninstall',
        state: 'completed' as const,
      })),
      warnings: [],
    });
    await nextTurn();
    await nextTurn();

    expect(controller.execute).toHaveBeenCalledWith('uninstall', value.items[0]!.targets[0]);
    expect(controller.load).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('结果：succeeded');
    expect(instance.lastFrame()).toContain('↓ 还有');
    expect(frameRows(instance)).toBeLessThanOrEqual(16);
  });

  it('scrolls through all write warnings in a 60x16 frame', async () => {
    const value = loaded([item('demo', 'absent')]);
    const controller = fakeController(value);
    controller.execute = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [],
      warnings: Array.from({ length: 12 }, (_, index) => `warning-${index}`),
    });
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\r');
    await nextTurn();
    await writeInput(instance, ...Array.from({ length: 8 }, () => '\u001B[6~'));

    expect(instance.lastFrame()).toContain('警告：warning-11');
    expect(instance.lastFrame()).toContain('PgUp/PgDn 输出');
    expect(frameRows(instance)).toBeLessThanOrEqual(16);
  });

  it('scrolls to a late component error in target details', async () => {
    const targetItem = item('details', 'partial');
    targetItem.targets[0]!.components = Array.from({ length: 14 }, (_, index) => ({
      artifactKey: `component-${index}`,
      label: index === 13 ? 'Late component error' : `Component ${index}`,
      state: index === 13 ? 'error' as const : 'present' as const,
      ...(index === 13 ? { error: 'late failure' } : {}),
    }));
    const instance = render(<Dashboard controller={fakeController(loaded([targetItem]))} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', ...Array.from({ length: 10 }, () => ']'));

    expect(instance.lastFrame()).toContain('Late component error · late failure');
    expect(instance.lastFrame()).toContain('[/] 详情');
  });

  it('resets detail scroll when refresh replaces the target at the same index', async () => {
    const oldItem = item('identity', 'present');
    oldItem.targets[0]!.components = Array.from({ length: 20 }, (_, index) => ({
      artifactKey: `old-component-${index}`,
      label: index === 19 ? '旧尾部组件' : `旧组件 ${index}`,
      state: 'present' as const,
    }));
    const refreshedItem = item('identity', 'present');
    refreshedItem.targets[0]!.target.platform = 'claude';
    refreshedItem.targets[0]!.components = Array.from({ length: 20 }, (_, index) => ({
      artifactKey: `new-component-${index}`,
      label: index === 19 ? '新尾部组件' : `新组件 ${index}`,
      state: 'present' as const,
    }));
    const controller = fakeController(loaded([oldItem]));
    controller.load = vi.fn()
      .mockResolvedValueOnce(loaded([oldItem]))
      .mockResolvedValueOnce(loaded([refreshedItem]));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', ...Array.from({ length: 5 }, () => ']'));
    expect(instance.lastFrame()).toContain('旧尾部组件');

    await writeInput(instance, 'r');
    await nextTurn();
    await nextTurn();

    expect(controller.load).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('目标：claude/user');
    expect(instance.lastFrame()).toContain('状态：● 已就绪');
    expect(instance.lastFrame()).toContain('组件：● 新组件 0');
    expect(instance.lastFrame()).not.toContain('新尾部组件');
  });

  it('recovers after a write failure and still performs automatic refresh', async () => {
    const value = loaded([item('demo', 'absent')]);
    const controller = fakeController(value);
    controller.execute = vi.fn().mockRejectedValue(new Error('write broke'));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\r');
    await nextTurn();

    expect(controller.load).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('失败：write broke');
    expect(instance.lastFrame()).toContain('下一步');
  });

  it('exits only after a busy target write settles on Ctrl-C', async () => {
    const value = loaded([item('demo', 'absent')]);
    const write = deferred<Awaited<ReturnType<DashboardController['execute']>>>();
    const controller = fakeController(value);
    controller.execute = vi.fn(() => write.promise);
    const onComplete = vi.fn();
    const instance = render(<Dashboard controller={controller} onComplete={onComplete} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\r', '\u0003');
    expect(onComplete).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('完成后退出');

    write.resolve({ overallState: 'succeeded', targetResults: [], warnings: [] });
    await nextTurn();
    await nextTurn();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('edits sensitive config in the same session and saves all staged changes once', async () => {
    const controller = withConfigController(loaded([item('demo', 'present')]));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 80, rows: 18 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('AW · demo 配置');
    expect(instance.lastFrame()).toContain('已配置');
    expect(instance.lastFrame()).not.toContain('[redacted]');

    await writeInput(instance, '\r', 'new-secret', '\r', 's');
    await nextTurn();
    expect(controller.saveConfig).toHaveBeenCalledTimes(1);
    expect(controller.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'demo' }),
      { scope: 'user', projectLayer: 'shared' },
      { updates: { token: 'new-secret' } },
    );
    expect(instance.frames.join('\n')).not.toContain('new-secret');
  });

  it('clears dirty state when save succeeds but config and status refresh fail', async () => {
    const controller = withConfigController(loaded([item('demo', 'present')]));
    vi.mocked(controller.readConfig)
      .mockResolvedValueOnce(await controller.readConfig(item('demo', 'present'), { scope: 'user', projectLayer: 'shared' }))
      .mockRejectedValueOnce(new Error('read broke'));
    vi.mocked(controller.load)
      .mockResolvedValueOnce(loaded([item('demo', 'present')]))
      .mockRejectedValueOnce(new Error('status broke'));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(instance, 'd', 's');
    await nextTurn();
    await nextTurn();

    expect(controller.saveConfig).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('已保存；自动刷新失败');
    expect(instance.lastFrame()).not.toContain('保存失败');
    await writeInput(instance, 'b');
    expect(instance.lastFrame()).not.toContain('有未保存变更');
    expect(instance.lastFrame()).toContain('Catalog:');
  });

  it('keeps a failed save dirty and asks before leaving', async () => {
    const controller = withConfigController(loaded([item('demo', 'present')]));
    vi.mocked(controller.saveConfig).mockRejectedValueOnce(new Error('disk full'));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(instance, 'd', 's');
    await nextTurn();
    expect(instance.lastFrame()).toContain('保存失败：disk full');
    await writeInput(instance, 'b');
    expect(instance.lastFrame()).toContain('有未保存变更');
  });

  it('exits after an initial config read settles when Ctrl-C arrives while busy', async () => {
    const value = loaded([item('demo', 'present')]);
    const read = deferred<Awaited<ReturnType<DashboardController['readConfig']>>>();
    const controller = withConfigController(value);
    controller.readConfig = vi.fn(() => read.promise);
    const onComplete = vi.fn();
    const instance = render(<Dashboard controller={controller} onComplete={onComplete} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('读取配置');
    await writeInput(instance, '\u0003');
    expect(onComplete).not.toHaveBeenCalled();
    read.resolve({
      location: { scope: 'user', projectLayer: 'shared' },
      model: { pluginName: 'demo', allowedScopes: ['user'], initialScope: 'user', requiredKeys: [], fields: [] },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [] },
    });
    await nextTurn();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each(['save', 'reset'] as const)('exits after a busy config %s settles on Ctrl-C', async (operation) => {
    const value = loaded([item('demo', 'present')]);
    const pending = deferred<{
      overallState: 'succeeded';
      targetResults: [];
      warnings: [];
    }>();
    const controller = withConfigController(value);
    if (operation === 'save') controller.saveConfig = vi.fn(() => pending.promise);
    else controller.resetConfig = vi.fn(() => pending.promise);
    const onComplete = vi.fn();
    const instance = render(<Dashboard controller={controller} onComplete={onComplete} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    if (operation === 'save') await writeInput(instance, 'd', 's');
    else await writeInput(instance, 'R', 'y');
    await writeInput(instance, '\u0003');
    expect(onComplete).not.toHaveBeenCalled();

    pending.resolve({ overallState: 'succeeded', targetResults: [], warnings: [] });
    await nextTurn();
    await nextTurn();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('confirms dirty location changes and current-layer reset inline', async () => {
    const controller = withConfigController(loaded([item('demo', 'present')]));
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 80, rows: 18 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(instance, 'd', '\t');
    expect(instance.lastFrame()).toContain('有未保存变更');
    await writeInput(instance, 'n', 'R');
    expect(instance.lastFrame()).toContain('确认重置当前层');
    await writeInput(instance, 'y');
    await nextTurn();
    expect(controller.resetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'demo' }),
      { scope: 'user', projectLayer: 'shared' },
    );
  });

  it('edits number, boolean, enum, and sensitive fields without leaking the secret', async () => {
    const value = loaded([item('demo', 'present')]);
    const controller = fakeController(value);
    controller.readConfig = vi.fn().mockResolvedValue({
      location: { scope: 'user', projectLayer: 'shared' },
      model: {
        pluginName: 'demo', allowedScopes: ['user', 'project'], initialScope: 'user', requiredKeys: [],
        fields: [
          { key: 'count', type: 'number', label: 'Count', required: false, sensitive: false, configured: false },
          { key: 'enabled', type: 'boolean', label: 'Enabled', required: false, sensitive: false, configured: false },
          { key: 'mode', type: 'enum', label: 'Mode', required: false, sensitive: false, configured: false, enumValues: ['fast', 'slow'] },
          { key: 'token', type: 'string', label: 'Token', required: false, sensitive: true, configured: false },
        ],
      },
      read: {
        pluginName: 'demo', scope: 'user', projectLayer: 'shared',
        fields: ['count', 'enabled', 'mode', 'token'].map((key) => ({
          key, title: key, kind: 'manifest', reserved: false, writable: true,
          valueState: 'missing', effectiveValue: undefined, sourceLayer: 'missing',
        })),
      },
    });
    controller.saveConfig = vi.fn().mockResolvedValue({ overallState: 'succeeded', targetResults: [], warnings: [] });
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();

    await writeInput(instance, '\r', '42', '\r', '\u001B[B', '\r', '\u001B[B', '\r');
    await writeInput(instance, '\u001B[B', '\r', '\u001B[B', '\r');
    await writeInput(instance, '\u001B[B', '\r', 'top-secret', '\r', 's');
    await nextTurn();

    expect(controller.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'demo' }),
      { scope: 'user', projectLayer: 'shared' },
      { updates: { count: 42, enabled: false, mode: 'slow', token: 'top-secret' } },
    );
    expect(instance.frames.join('\n')).not.toContain('top-secret');
  });

  it('keeps current enum and false boolean values when Enter accepts each editor default', async () => {
    const value = loaded([item('demo', 'present')]);
    const controller = fakeController(value);
    const configData = {
      location: { scope: 'user' as const, projectLayer: 'shared' as const },
      model: {
        pluginName: 'demo', allowedScopes: ['user' as const], initialScope: 'user' as const, requiredKeys: [],
        fields: [
          { key: 'mode', type: 'enum' as const, label: 'Mode', required: false, sensitive: false, configured: true, defaultValue: 'fast', enumValues: ['fast', 'slow'] },
          { key: 'enabled', type: 'boolean' as const, label: 'Enabled', required: false, sensitive: false, configured: true, defaultValue: true },
        ],
      },
      read: {
        pluginName: 'demo', scope: 'user' as const, projectLayer: 'shared' as const,
        fields: [
          { key: 'mode', title: 'Mode', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'slow', sourceLayer: 'user' as const },
          { key: 'enabled', title: 'Enabled', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: false, sourceLayer: 'user' as const },
        ],
      },
    };
    controller.readConfig = vi.fn().mockResolvedValue(configData);
    controller.saveConfig = vi.fn().mockResolvedValue({ overallState: 'succeeded', targetResults: [], warnings: [] });
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\r', '\r', 's');
    await nextTurn();

    expect(controller.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'demo' }),
      { scope: 'user', projectLayer: 'shared' },
      { updates: { mode: 'slow', enabled: false } },
    );
  });

  it('scrolls to the last config apply result', async () => {
    const controller = withConfigController(loaded([item('demo', 'present')]));
    controller.saveConfig = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: Array.from({ length: 10 }, (_, index) => ({
        target: { pluginName: 'demo', platform: 'codex' as const, scope: 'user' as const },
        action: 'reinstall' as const,
        state: 'completed' as const,
        message: index === 9 ? 'final-apply-result' : `apply-${index}`,
      })),
      warnings: [],
    });
    const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(instance, 'd', 's');
    await nextTurn();
    await nextTurn();
    await writeInput(instance, ...Array.from({ length: 15 }, () => '\u001B[6~'));

    expect(instance.lastFrame()).toContain('final-apply-result');
    expect(instance.lastFrame()).toContain('PgUp/PgDn 消息');
  });

  it('keeps growing dashboard and config selections visible within 60x16 and 110x18 frames', async () => {
    const manyItems = Array.from({ length: 18 }, (_, index) => item(`plugin-${index}`, 'present'));
    const selectedTarget = manyItems[0]!.targets[0]!;
    selectedTarget.components = Array.from({ length: 20 }, (_, index) => ({
      artifactKey: `component-${index}`,
      label: `Component ${index}`,
      state: 'present' as const,
    }));
    const value = loaded(manyItems);
    const single = render(<Dashboard controller={fakeController(value)} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    const three = render(<Dashboard controller={fakeController(value)} onComplete={() => undefined} size={{ columns: 110, rows: 18 }} />);
    await nextTurn();
    await writeInput(single, ...Array.from({ length: 17 }, () => '\u001B[B'));
    await writeInput(three, ...Array.from({ length: 17 }, () => '\u001B[B'));

    expect(single.lastFrame()).toContain('plugin-17');
    expect(single.lastFrame()).toContain('↑ 还有');
    expect(frameRows(single)).toBeLessThanOrEqual(16);
    expect(three.lastFrame()).toContain('plugin-17');
    expect(three.lastFrame()).toContain('↑ 还有');
    expect(frameRows(three)).toBeLessThanOrEqual(18);

    const targetItem = item('targets', 'present');
    targetItem.targets = Array.from({ length: 18 }, (_, index) => ({
      ...targetItem.targets[0]!,
      target: {
        ...targetItem.targets[0]!.target,
        plugin: `target-${index}`,
        platform: `platform-${index}` as never,
      },
    }));
    const targets = render(<Dashboard controller={fakeController(loaded([targetItem]))} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(targets, '\r', ...Array.from({ length: 17 }, () => '\u001B[B'));
    expect(targets.lastFrame()).toContain('platform-17/user');
    expect(targets.lastFrame()).toContain('↑ 还有');
    expect(frameRows(targets)).toBeLessThanOrEqual(16);

    const configController = withConfigController(loaded([item('demo', 'present')]));
    const configData = await configController.readConfig(item('demo', 'present'), { scope: 'user', projectLayer: 'shared' });
    configData.model.fields = Array.from({ length: 24 }, (_, index) => ({
      key: `field-${index}`,
      type: 'string' as const,
      label: `Field ${index}`,
      required: false,
      sensitive: false,
      configured: false,
    }));
    configData.read.fields = configData.model.fields.map((entry) => ({
      key: entry.key, title: entry.label, kind: 'manifest', reserved: false, writable: true,
      valueState: 'missing', effectiveValue: undefined, sourceLayer: 'missing',
    }));
    configController.readConfig = vi.fn().mockResolvedValue(configData);
    const config = render(<Dashboard controller={configController} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    await nextTurn();
    await writeInput(config, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn();
    await writeInput(config, ...Array.from({ length: 23 }, () => '\u001B[B'));
    expect(config.lastFrame()).toContain('Field 23');
    expect(config.lastFrame()).toContain('↑ 还有');
    expect(frameRows(config)).toBeLessThanOrEqual(16);

    config.rerender(<Dashboard controller={configController} onComplete={() => undefined} size={{ columns: 59, rows: 16 }} />);
    expect(config.lastFrame()).toContain('终端空间不足');
    config.rerender(<Dashboard controller={configController} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
    expect(config.lastFrame()).toContain('Field 23');
    expect(frameRows(config)).toBeLessThanOrEqual(16);
  });

  it('routes dashboard notices into the frame, suppresses session IO events, and keeps debug logging', async () => {
    const value = loaded([item('demo', 'absent')]);
    mocks.loadConsoleItemsResult.mockResolvedValue(value);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const debugLog = vi.fn();
    mocks.installWriteCommand.mockImplementationOnce(async (_plugins, _options, context) => {
      await emitCommandEvent(context, { type: 'lifecycle:verbose', message: 'verbose event' });
      await emitCommandNotice(context, { level: 'notice', message: '生命周期已完成' });
      return { overallState: 'succeeded', targetResults: [], warnings: [] };
    });
    const launch = vi.fn(async (request) => {
      let completed = { exitCode: 1 };
      const instance = render(request.render((result) => { completed = result; }));
      await nextTurn();
      await writeInput(instance, '\r', '\r', '\r');
      await nextTurn();
      expect(instance.lastFrame()).toContain('生命周期已完成');
      expect(instance.lastFrame()).toContain('结果：succeeded');
      return completed;
    });
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true,
      io: { stdout, stderr },
      diagnostics: { verbose: true, commandName: 'console' },
      debugLogger: { log: debugLog },
      tuiRunner: { launch } as never,
    });

    await runConsoleController(context);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({ type: 'lifecycle:verbose' }));
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice:notice' }));
    await emitCommandNotice(context, { level: 'notice', message: '会话后通知' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('会话后通知'));
  });

  it('uses one injected runner session for the bare console', async () => {
    const launch = vi.fn(async (request) => {
      let result = { exitCode: 1 };
      request.render((value: { exitCode: number }) => { result = value; });
      return { exitCode: 0 };
    });
    const context = createCliExecutionContext({
      interactive: true,
      tuiRunner: { launch } as never,
    });
    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});
