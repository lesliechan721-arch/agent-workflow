import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDashboardController,
  type DashboardController,
} from '../../src/commands/console.js';
import {
  executeRebuildOperation,
  type DesiredTarget,
  type RebuildActiveStore,
  type RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  emitCommandNotice,
  withCommandReporterSession,
} from '../../src/commands/runtime.js';
import type { ConsoleItemsLoadResult, LiveConsoleItem } from '../../src/commands/status.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { Dashboard } from '../../src/tui/dashboard.js';
import type { PluginMeta, ReceiptTargetIdentity } from '../../src/types.js';
import { readPluginConfigStore } from '../../src/utils/plugin-config.js';
import { applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const tempDirs: string[] = [];

afterEach(async () => {
  cleanup();
  while (tempDirs.length > 0) await fs.remove(tempDirs.pop()!);
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function writeInput(instance: ReturnType<typeof render>, ...inputs: string[]): Promise<void> {
  for (const input of inputs) {
    instance.stdin.write(input);
    await nextTurn();
  }
}

async function waitForFrame(instance: ReturnType<typeof render>, text: string): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (instance.lastFrame()?.includes(text)) return;
    await nextTurn();
  }
  throw new Error(`Frame did not contain: ${text}\n${instance.lastFrame() ?? ''}`);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    if (condition()) return;
    await nextTurn();
  }
  throw new Error('Condition did not settle.');
}

function pluginFixture(rootDir: string, name: string): PluginMeta {
  return {
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      name,
      version: '1.0.0',
      description: 'TUI real progress fixture',
      compatibility: { aw: { minVersion: '0.0.0' } },
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      config: {
        schema: {
          mode: { type: 'enum', values: ['safe', 'fast'], default: 'safe' },
        },
      },
    },
  };
}

function desiredTarget(
  plugin: PluginMeta,
  platform: 'codex' | 'claude',
  scope: 'user' | 'project',
  cwd: string,
): DesiredTarget {
  return {
    plugin,
    lifecycleSource: plugin,
    identity: {
      pluginName: plugin.manifest.name,
      pluginVersion: plugin.manifest.version,
      platform,
      scope,
      cwd,
    },
    ownedComponents: [{
      kind: 'native-plugin',
      identity: {
        owner: 'agent-workflows',
        plugin: plugin.manifest.name,
        artifactKey: `native-${platform}-${scope}`,
        platform,
        scope,
      },
      pluginId: `${plugin.manifest.name}@aw`,
    }],
    requiresNative: true,
    artifacts: [],
  };
}

function activeStore(): RebuildActiveStore {
  return {
    prepare: async () => ({}) as never,
    discard: async () => undefined,
    promote: async () => ({}) as never,
    read: async () => null,
    remove: async () => undefined,
  };
}

function operationDriver(options: { failWrite?: boolean; initial?: 'absent' | 'present' } = {}): {
  driver: RebuildTargetDriver;
  state: () => 'absent' | 'present';
} {
  let state: 'absent' | 'present' = options.initial ?? 'absent';
  return {
    state: () => state,
    driver: {
      probeNative: async () => state,
      removeNative: async () => { state = 'absent'; await nextTurn(); },
      writeNative: async () => {
        state = 'present';
        await nextTurn();
        if (options.failWrite) throw new Error('private native failure');
      },
      writeArtifacts: async () => undefined,
      runLifecycle: async () => undefined,
    },
  };
}

function consoleItem(plugin: PluginMeta, cwd: string, state: 'absent' | 'present'): LiveConsoleItem {
  return {
    pluginName: plugin.manifest.name,
    version: plugin.manifest.version,
    plugin,
    targets: [{
      target: {
        plugin: plugin.manifest.name,
        version: plugin.manifest.version,
        platform: 'codex',
        scope: 'user',
        cwd,
      },
      state,
      components: [],
      errors: [],
    }],
  };
}

function loaded(item: LiveConsoleItem): ConsoleItemsLoadResult {
  return {
    items: [item],
    catalogUnavailable: false,
    status: {
      schemaVersion: 3,
      catalog: { catalogVersion: '1.0.0', source: 'local' },
      filters: { plugins: [], platform: 'both', cwd: item.targets[0]!.target.cwd },
      targets: item.targets,
      errors: [],
    },
  };
}

describe('real TUI progress chains', () => {
  it('routes two real rebuild targets, recovery, and receipt through a Dashboard session', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-dashboard-real-progress-'));
    tempDirs.push(root);
    registerCurrentTestWritableStateRoot(root);
    const plugin = pluginFixture(path.join(root, 'plugin'), 'real-dashboard');
    const item = consoleItem(plugin, root, 'absent');
    const progress = createRebuildProgressFeed();
    const stdout = vi.fn();
    const context = createCliExecutionContext({ cwd: root, io: { stdout } });
    const failedDriver = operationDriver({ failWrite: true });
    const succeededDriver = operationDriver();
    const controller = createDashboardController(context, progress);
    controller.load = vi.fn().mockResolvedValue(loaded(item));
    let executeDone = false;
    controller.execute = vi.fn(async () => {
      const first = await executeRebuildOperation({
        command: 'install',
        target: desiredTarget(plugin, 'codex', 'user', root),
        driver: failedDriver.driver,
        activeStore: activeStore(),
        onActionEvent: (event) => emitCommandEvent(context, event),
      });
      const second = await executeRebuildOperation({
        command: 'install',
        target: desiredTarget(plugin, 'claude', 'project', root),
        driver: succeededDriver.driver,
        activeStore: activeStore(),
        onActionEvent: (event) => emitCommandEvent(context, event),
      });
      const receipt = {
        overallState: 'failed',
        platforms: ['codex', 'claude'],
        plugins: ['real-dashboard'],
        warnings: [],
        rebuildResults: [first, second],
        targetResults: [
          {
            target: { pluginName: 'real-dashboard', platform: 'codex', scope: 'user' },
            action: 'install', state: 'failed', message: first.failure?.message,
          },
          {
            target: { pluginName: 'real-dashboard', platform: 'claude', scope: 'project' },
            action: 'install', state: 'completed',
          },
        ],
        nativePlugins: {},
        repoManagedArtifacts: [],
        receiptTargets: [],
      } as const;
      executeDone = true;
      return receipt;
    });

    let frame = '';
    let frames = '';
    await withCommandReporterSession(context.reporter, {
      event: (event) => progress.addEvent(event),
      notice: (notice) => progress.addNotice(notice),
    }, async () => {
      const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
      await nextTurn();
      await writeInput(instance, '\r', '\r', '\r');
      await waitForCondition(() => executeDone);
      await nextTurn();
      await nextTurn();
      await writeInput(instance, ...Array.from({ length: 8 }, () => '\u001B[5~'));
      frame = instance.lastFrame() ?? '';
      frames = instance.frames.join('\n');
      instance.unmount();
    });

    expect(frames).toContain('real-dashboard · Codex/当前用户');
    expect(frames).toContain('real-dashboard · Claude Code/当前项目');
    expect(frames).toContain('写入平台插件失败。');
    expect(frames).toContain('清理失败写入');
    expect(frame).toContain('结果：failed');
    expect(frame).toContain('codex/user: failed');
    expect(frame).toContain('claude/project: completed');
    expect(progress.get().current?.target).toBe('real-dashboard · Claude Code/当前项目');
    expect(failedDriver.state()).toBe('absent');
    expect(succeededDriver.state()).toBe('present');

    await emitCommandNotice(context, { level: 'notice', message: 'session restored' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('session restored'));
  });

  it('routes a real config write reinstall through ConfigPage and restores the reporter', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-real-progress-'));
    tempDirs.push(root);
    registerCurrentTestWritableStateRoot(root);
    const cwd = path.join(root, 'repo');
    await fs.ensureDir(cwd);
    const plugin = pluginFixture(path.join(root, 'plugin'), 'real-config');
    const item = consoleItem(plugin, cwd, 'present');
    const progress = createRebuildProgressFeed();
    const stdout = vi.fn();
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const context = createCliExecutionContext({
      cwd,
      env: { AW_HOME: path.join(root, 'aw-home') },
      io: { stdout },
      nativeCliRunner,
    });
    const controller: DashboardController = createDashboardController(context, progress);
    controller.load = vi.fn().mockResolvedValue(loaded(item));
    const applyTarget: ReceiptTargetIdentity = {
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
    };
    const reinstallDriver = operationDriver({ initial: 'present' });
    let savePromise: ReturnType<typeof applyPluginConfigWrite> | undefined;
    controller.saveConfig = (_item, location, request) => {
      savePromise = applyPluginConfigWrite({
        plugin,
        scope: location.scope,
        projectLayer: location.projectLayer,
        cwd,
        env: context.env,
        request,
        applyTargets: [applyTarget],
        nativeCliRunner,
        rebuildRuntime: context,
        reinstallCommandImpl: async (_plugins, _options, runtime) => {
        const result = await executeRebuildOperation({
          command: 'reinstall',
          target: desiredTarget(plugin, 'codex', 'user', cwd),
          driver: reinstallDriver.driver,
          activeStore: activeStore(),
          onActionEvent: (event) => runtime.reporter?.event(event),
        });
        return {
          platforms: ['codex'],
          plugins: result.status === 'succeeded' ? [plugin.manifest.name] : [],
          warnings: [],
          rebuildResults: [result],
          targetResults: [{
            target: applyTarget,
            action: 'reinstall',
            state: result.status === 'succeeded' ? 'completed' : 'failed',
            ...(result.failure ? { message: result.failure.message } : {}),
          }],
          overallState: result.status,
          nativePlugins: {},
          repoManagedArtifacts: [],
          receiptTargets: [],
        };
        },
      });
      return savePromise;
    };

    let frame = '';
    let frames = '';
    await withCommandReporterSession(context.reporter, {
      event: (event) => progress.addEvent(event),
      notice: (notice) => progress.addNotice(notice),
    }, async () => {
      const instance = render(<Dashboard controller={controller} onComplete={() => undefined} size={{ columns: 60, rows: 16 }} />);
      await nextTurn();
      await writeInput(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
      await waitForFrame(instance, 'mode · default/default · safe');
      await writeInput(instance, '\r');
      await waitForFrame(instance, '选择 mode');
      await writeInput(instance, '\u001B[B', '\r');
      await waitForFrame(instance, 'mode · default/default · fast');
      await writeInput(instance, 's');
      await waitForCondition(() => savePromise !== undefined);
      await savePromise;
      await waitForCondition(() => !instance.lastFrame()?.includes('· 0s'));
      await writeInput(instance, ...Array.from({ length: 8 }, () => '\u001B[5~'));
      frame = instance.lastFrame() ?? '';
      frames = instance.frames.join('\n');
      instance.unmount();
    });

    expect(frames).toContain('real-config · Codex/当前用户');
    expect(frames).toContain('检查当前组件');
    expect(frames).toContain('清理 AW 组件');
    expect(frames).toContain('写入平台插件');
    expect(frame).toContain('已保存。');
    expect(frame).toContain('codex/user: completed');
    expect(reinstallDriver.state()).toBe('present');
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd,
      env: context.env,
    })).values).toEqual({ mode: 'fast' });

    await emitCommandNotice(context, { level: 'notice', message: 'config session restored' });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('config session restored'));
  });
});
