import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandWizardResult } from '../../src/commands/wizard.js';
import {
  executeRebuildOperation,
  type DesiredTarget,
  type RebuildActiveStore,
  type RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { CommandWizard } from '../../src/tui/wizard.js';
import type { PluginMeta } from '../../src/types.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const unsafeTuiText = [
  'codex --version',
  'claude plugins list',
  '/Users/alice/Private Project/private.json',
  'C:\\Users\\alice\\Private Project\\private.json',
  '\\\\server\\Private Share\\private.json',
  'sk-proj-123456789',
  'Authorization: Bearer abcdef',
  'Bearer qwerty',
  'password=hunter2',
].join(' | ');

function expectTuiTextProjected(frame: string): void {
  for (const fragment of [
    'codex --version', 'claude plugins', '/Users/alice', 'Project/private.json',
    'C:\\Users', '\\\\server', 'Private Share', 'sk-proj', 'Authorization',
    'Bearer', 'hunter2',
  ]) expect(frame).not.toContain(fragment);
}

describe('command wizard', () => {
  it('renders a real rebuild failure and recovery through the progress feed', async () => {
    const progress = createRebuildProgressFeed();
    const plugin: PluginMeta = {
      rootDir: '/fixture/bundle',
      manifestPath: '/fixture/bundle/.agents-plugin/plugin.json',
      manifest: {
        name: 'real-chain',
        version: '1.0.0',
        description: 'fixture',
        compatibility: { aw: { minVersion: '0.0.0' } },
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
      },
    };
    let nativeState: 'absent' | 'present' = 'absent';
    const target: DesiredTarget = {
      plugin,
      lifecycleSource: plugin,
      identity: {
        pluginName: 'real-chain',
        pluginVersion: '1.0.0',
        platform: 'codex',
        scope: 'user',
        cwd: '/Users/alice/private/repo',
      },
      ownedComponents: [{
        kind: 'native-plugin',
        identity: {
          owner: 'agent-workflows',
          plugin: 'real-chain',
          artifactKey: 'native',
          platform: 'codex',
          scope: 'user',
        },
        pluginId: 'real-chain@aw',
      }],
      requiresNative: true,
      artifacts: [],
    };
    const driver: RebuildTargetDriver = {
      probeNative: async () => nativeState,
      removeNative: async () => { nativeState = 'absent'; },
      writeNative: async () => {
        nativeState = 'present';
        throw new Error(unsafeTuiText);
      },
      writeArtifacts: async () => undefined,
      runLifecycle: async () => undefined,
    };
    const activeStore: RebuildActiveStore = {
      prepare: async () => ({}) as never,
      discard: async () => undefined,
      promote: async () => ({}) as never,
      read: async () => null,
      remove: async () => undefined,
    };
    const execute = vi.fn(() => executeRebuildOperation({
      command: 'install',
      target,
      driver,
      activeStore,
      onActionEvent: (event) => progress.addEvent(event),
    }));
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['real-chain'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install real-chain --platform codex --scope user',
        resultState: (value) => (value as { status: string }).status,
        execute,
      }}
      progress={progress}
      onComplete={() => undefined}
    />);

    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('写入平台插件失败。');
    expect(frame).toContain('清理失败写入');
    expectTuiTextProjected(instance.frames.join('\n'));
    expect(nativeState).toBe('absent');
  });

  it('shows real progress, the latest eight messages, and keeps them on the receipt page', async () => {
    let finish!: (value: unknown) => void;
    const progress = createRebuildProgressFeed();
    const execute = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install alpha --platform codex --scope user',
        resultState: (value) => (value as { overallState: 'succeeded' }).overallState,
        execute,
      }}
      progress={progress}
      onComplete={() => undefined}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'alpha', platform: 'codex', scope: 'user', action: 'install' },
      data: { name: 'artifacts.write', phase: 'start' },
    });
    for (let index = 0; index < 10; index += 1) {
      progress.addNotice({
        level: index === 9 ? 'warning' : 'notice',
        message: unsafeTuiText,
        source: { plugin: `notice-${index}`, platform: 'codex', scope: 'user' },
      });
    }
    await nextTurn();

    expect(instance.lastFrame()).toContain('alpha · Codex/当前用户');
    expect(instance.lastFrame()).toContain('阶段：写入插件文件');
    expect(instance.lastFrame()).not.toContain('notice-1');
    expect(instance.lastFrame()).toContain('notice-2');
    expect(instance.lastFrame()).toContain('警告：Codex / notice-9 / 当前用户：收到警告');
    expect((instance.lastFrame()?.match(/收到(?:通知|警告)/g) ?? [])).toHaveLength(8);
    expectTuiTextProjected(instance.frames.join('\n'));
    instance.stdin.write('\u001B[5~');
    await nextTurn();
    expect(instance.lastFrame()).toContain('notice-0');
    expect(instance.lastFrame()).not.toContain('notice-9');
    instance.stdin.write('\u001B[6~');
    await nextTurn();
    expect(instance.lastFrame()).toContain('notice-9');

    finish({
      overallState: 'succeeded',
      targetResults: [{
        target: { pluginName: 'alpha', platform: 'codex', scope: 'user' },
        state: 'completed',
        message: unsafeTuiText,
      }],
    });
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('执行结果');
    expect(instance.lastFrame()).toContain('收据：succeeded');
    expect(instance.lastFrame()).toContain('notice-9');
    expectTuiTextProjected(instance.frames.join('\n'));
  });

  it('keeps platform, multi-plugin selection, confirmation, and execution in one mount', async () => {
    const execute = vi.fn(async (selection) => ({ selection }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [
          { pluginName: 'alpha', targets: [] },
          { pluginName: 'beta', targets: [] },
        ],
        initial: { plugins: [], scope: 'user' },
        pluginMode: 'multiple',
        promptForPlatform: true,
        equivalentCommand: (selection) => `aw install ${selection.plugins.join(' ')} --platform ${selection.platform}`,
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    instance.stdin.write(' ');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write(' ');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('POSIX shell 命令');
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('执行结果');
    instance.stdin.write('\r');
    await nextTurn();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      plugins: ['alpha', 'beta'],
      platform: 'both',
      scope: 'user',
    }));
    expect(completed).toMatchObject({ cancelled: false });
  });

  it('does not render or expose a sensitive config value', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'config:set',
        candidates: [{
          pluginName: 'secure',
          targets: [],
          configSchema: { token: { type: 'string', sensitive: true } },
        }],
        initial: { plugins: [], scope: 'user', projectLayer: 'shared' },
        pluginMode: 'single',
        promptForKey: true,
        promptForValue: true,
        equivalentCommand: () => 'aw config set secure token <sensitive-value>',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    for (const input of ['\r', '\r', 'hunter2', '\r', '\r']) {
      instance.stdin.write(input);
      await nextTurn();
    }
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();

    expect(instance.frames.join('\n')).not.toContain('hunter2');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ value: 'hunter2' }));
    expect(completed).toMatchObject({ cancelled: false });
  });

  it.each([
    { type: 'file' as const, value: '/Users/alice/Private Project/private.json' },
    { type: 'directory' as const, value: 'C:\\Users\\alice\\Private Project' },
    { type: 'directory' as const, value: '\\\\server\\Private Share' },
  ])('does not echo a $type path while preserving the submitted value', async ({ type, value }) => {
    const execute = vi.fn(async () => ({ ok: true }));
    const instance = render(<CommandWizard
      request={{
        command: 'config:set',
        candidates: [{
          pluginName: 'paths',
          targets: [],
          configSchema: { location: { type, sensitive: false } },
        }],
        initial: { plugins: [], scope: 'user', projectLayer: 'shared' },
        pluginMode: 'single',
        promptForKey: true,
        promptForValue: true,
        equivalentCommand: () => `aw config set paths location <${type}-path>`,
        commandIsTemplate: () => true,
        execute,
      }}
      onComplete={() => undefined}
    />);
    await nextTurn();
    for (const input of ['\r', '\r', value, '\r', '\r']) {
      instance.stdin.write(input);
      await nextTurn();
    }
    await nextTurn();

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ value }));
    expectTuiTextProjected(instance.frames.join('\n'));
    expect(instance.frames.join('\n')).toContain(`<${type}-path>`);
    expect(instance.frames.join('\n')).toContain('命令模板');
  });

  it('cancels before execution', async () => {
    const execute = vi.fn();
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'cleanup',
        candidates: [{ pluginName: 'alpha', targets: [] }],
        initial: { plugins: [], platform: 'codex', scope: 'user' },
        pluginMode: 'single',
        destructive: true,
        equivalentCommand: () => 'aw cleanup alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('q');
    await nextTurn();

    expect(execute).not.toHaveBeenCalled();
    expect(completed).toEqual({ cancelled: true });
  });

  it('waits for an active write before honoring Ctrl-C', async () => {
    let finish!: () => void;
    const execute = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finish = () => resolve({ ok: true });
    }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'uninstall',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        destructive: true,
        equivalentCommand: () => 'aw uninstall alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('正在执行');
    instance.stdin.write('\u0003');
    await nextTurn();
    expect(completed).toBeUndefined();
    finish();
    await nextTurn();
    await nextTurn();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({ cancelled: false });
  });

  it.each([
    { name: 'success', execute: async () => ({ ok: true }), hasError: false },
    { name: 'failure', execute: async () => { throw new Error('write failed'); }, hasError: true },
  ])('returns the settled $name result when Ctrl-C closes the result page', async ({ execute, hasError }) => {
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('执行结果');
    instance.stdin.write('\u0003');
    await nextTurn();

    expect(completed).toMatchObject({ cancelled: false });
    expect(completed?.failed === true).toBe(hasError);
  });

  it.each([
    { columns: 60, rows: 16 },
    { columns: 80, rows: 18 },
    { columns: 110, rows: 18 },
  ])('keeps confirmation in one $columns x $rows frame with reachable controls', async (size) => {
    const execute = vi.fn(async () => ({ ok: true }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install alpha --platform codex --scope user',
        execute,
      }}
      size={size}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();

    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(size.rows);
    expect(instance.lastFrame()?.match(/确认参数/g)).toHaveLength(1);
    expect(instance.lastFrame()).toContain('Y/n');
    instance.stdin.write('y');
    await nextTurn();
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({ cancelled: false });
  });

  it('cancels from the single 60x16 confirmation frame', async () => {
    const execute = vi.fn();
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'cleanup',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        destructive: true,
        equivalentCommand: () => 'aw cleanup alpha --platform codex --scope user',
        execute,
      }}
      size={{ columns: 60, rows: 16 }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();

    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(16);
    instance.stdin.write('n');
    await nextTurn();

    expect(execute).not.toHaveBeenCalled();
    expect(completed).toEqual({ cancelled: true });
  });

  it('keeps long Windows replay forms and confirmation reachable in 60x16', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const execute = vi.fn(async () => ({ ok: true }));
    const tokens = ['aw', 'install', '--platform', 'both', '--scope', 'user', '--',
      ...Array.from({ length: 12 }, (_, index) => `plugin ${index} with a long name`)];
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: tokens.slice(7), platform: 'both', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => '',
        equivalentCommandTokens: () => tokens,
        execute,
      }}
      size={{ columns: 60, rows: 16 }}
      onComplete={() => undefined}
    />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('PowerShell 命令');
    expect(instance.lastFrame()).toContain('参数列表');
    expect(instance.lastFrame()).toContain('Y/n');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(16);
    instance.stdin.write('y');
    await nextTurn();
    expect(execute).toHaveBeenCalledTimes(1);
    platform.mockRestore();
  });

  it('shows exactly the latest eight of twelve messages and receipt state in 60x16', async () => {
    let finish!: (value: unknown) => void;
    const progress = createRebuildProgressFeed();
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install alpha --platform codex --scope user',
        resultState: (value) => (value as { overallState: 'succeeded' | 'failed' }).overallState,
        execute: () => new Promise((resolve) => { finish = resolve; }),
      }}
      progress={progress}
      size={{ columns: 60, rows: 16 }}
      onComplete={() => undefined}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    for (let index = 0; index < 12; index += 1) {
      progress.addNotice({
        level: 'notice',
        message: `notice-message-${index}`,
        source: { plugin: `notice-${index}`, platform: 'codex', scope: 'user' },
      });
    }
    finish({ overallState: 'failed', targetResults: [] });
    await nextTurn();
    await nextTurn();

    expect(instance.lastFrame()).toContain('notice-11');
    expect(instance.lastFrame()).not.toContain('notice-3');
    expect(instance.lastFrame()?.match(/收到通知/g)).toHaveLength(8);
    expect(instance.lastFrame()).toContain('收据：failed');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(16);
    instance.stdin.write('\u001B[5~');
    await nextTurn();
    expect(instance.lastFrame()).toContain('notice-0');
    expect(instance.lastFrame()).not.toContain('notice-11');
    instance.stdin.write('\u001B[6~');
    await nextTurn();
    expect(instance.lastFrame()).toContain('notice-11');
  });
});
