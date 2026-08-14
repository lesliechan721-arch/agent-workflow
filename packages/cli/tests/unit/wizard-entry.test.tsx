import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TuiLaunchRequest, TuiRunner } from '../../src/tui/runner.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';

const mocks = vi.hoisted(() => ({
  installWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  loadConsoleItemsResult: vi.fn(),
}));

vi.mock('../../src/commands/write-commands.js', () => ({
  installWriteCommand: mocks.installWriteCommand,
  upgradeWriteCommand: mocks.upgradeWriteCommand,
  reinstallWriteCommand: mocks.reinstallWriteCommand,
  uninstallWriteCommand: mocks.uninstallWriteCommand,
  cleanupWriteCommand: mocks.cleanupWriteCommand,
}));

vi.mock('../../src/commands/status.js', async (importActual) => ({
  ...await importActual<typeof import('../../src/commands/status.js')>(),
  loadConsoleItemsResult: mocks.loadConsoleItemsResult,
}));

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function runnerFor(inputs: string[]): {
  runner: TuiRunner;
  launch: ReturnType<typeof vi.fn>;
  frames: string[];
} {
  const frames: string[] = [];
  const launch = vi.fn(async <T,>(request: TuiLaunchRequest<T>): Promise<T> => {
    let complete!: (result: T) => void;
    const result = new Promise<T>((resolve) => { complete = resolve; });
    const instance = render(request.render(complete));
    await nextTurn();
    for (const input of inputs) {
      instance.stdin.write(input);
      await nextTurn();
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    frames.push(...instance.frames);
    const value = await result;
    instance.unmount();
    instance.cleanup();
    return value;
  });
  return { runner: { launch }, launch, frames };
}

function successfulResult() {
  return {
    platforms: ['codex', 'claude'],
    plugins: ['alpha'],
    warnings: [],
    rebuildResults: [],
    targetResults: [],
    overallState: 'succeeded' as const,
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: [],
  };
}

function failedResult() {
  return {
    ...successfulResult(),
    plugins: [],
    overallState: 'failed' as const,
    targetResults: [{
      target: { pluginName: 'alpha', platform: 'codex', scope: 'user' },
      action: 'install' as const,
      state: 'failed' as const,
      message: 'write failed',
    }],
  };
}

function catalogItems(state: 'absent' | 'present' = 'absent') {
  return {
    catalogUnavailable: false,
    status: {
      schemaVersion: 3 as const,
      catalog: {},
      filters: { plugins: [], platform: 'both' as const, cwd: '/workspace' },
      targets: [],
      errors: [],
    },
    items: [{
      pluginName: 'alpha',
      version: '1.0.0',
      targets: ['codex', 'claude'].map((platform) => ({
        target: {
          plugin: 'alpha',
          platform,
          scope: 'user',
          cwd: '/workspace',
        },
        state,
        components: [],
        errors: [],
      })),
    }],
  };
}

describe('write command wizard entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { command: 'install', state: 'absent', inputs: ['\r', ' ', '\r', '\r', '\r'] },
    { command: 'upgrade', state: 'present', inputs: ['\r', ' ', '\r', '\r', '\r'] },
    { command: 'uninstall', state: 'present', inputs: ['\r', ' ', '\r', '\r', '\r'] },
    { command: 'reinstall', state: 'present', inputs: ['\r', '\r', '\r', '\r'] },
    { command: 'cleanup', state: 'present', inputs: ['\r', '\r', '\r', '\r', '\r'] },
  ] as const)('mounts one $command session and calls its helper once', async ({ command, state, inputs }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue(catalogItems(state));
    const helper = mocks[`${command}WriteCommand` as keyof typeof mocks];
    helper.mockResolvedValue(successfulResult());
    const captured = createCapturedCliIo();
    const testing = runnerFor([...inputs]);

    const exitCode = await runCli([command], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: testing.runner,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(testing.launch).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledTimes(1);
    expect(helper).toHaveBeenCalledWith(
      ['alpha'],
      expect.objectContaining({ cwd: '/workspace', platform: 'both', scope: 'user' }),
      expect.any(Object),
    );
    expect(captured.readStdout()).toContain(command);
  });

  it('does not start a runner for a complete write command', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.installWriteCommand.mockResolvedValue(successfulResult());
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['install', 'alpha', '--platform', 'codex'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(0);
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.loadConsoleItemsResult).not.toHaveBeenCalled();
    expect(mocks.installWriteCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'] as const)(
    'fails %s safely before mounting when the plugin catalog is unavailable', async (command) => {
      const { runCli } = await import('../../src/index.js');
      mocks.loadConsoleItemsResult.mockResolvedValue({
        ...catalogItems(),
        catalogUnavailable: true,
        items: [],
        status: {
          ...catalogItems().status,
          catalog: { error: 'token=/Users/alice/Private/catalog.json' },
        },
      });
      const captured = createCapturedCliIo();
      const launch = vi.fn();

      const exitCode = await runCli([command], {
        cwd: '/workspace', env: { CI: undefined }, interactive: true,
        io: captured.io, tuiRunner: { launch } as never, ...createTtyRuntimeStreams(),
      });

      expect(exitCode).toBe(1);
      expect(launch).not.toHaveBeenCalled();
      expect(mocks[`${command}WriteCommand`]).not.toHaveBeenCalled();
      expect(captured.readStdout()).toBe('');
      expect(captured.readStderr()).toContain('插件目录不可用');
      expect(captured.readStderr()).toContain('aw init');
      expect(captured.readStderr()).not.toContain('alice');
      expect(captured.readStderr()).not.toContain('\u001B[');
    },
  );

  it('fails before mounting when no target can perform the selected action', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue(catalogItems('absent'));
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['upgrade', '--platform', 'codex'], {
      cwd: '/workspace', env: { CI: undefined }, interactive: true,
      io: captured.io, tuiRunner: { launch } as never, ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.upgradeWriteCommand).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain('没有可执行此操作的目标');
    expect(captured.readStderr()).toContain('aw status');
    expect(captured.readStderr()).not.toContain('\u001B[');
  });

  it('does not apply action-candidate filtering to an explicit plugin missing only platform', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({ ...catalogItems('absent'), items: [] });
    mocks.installWriteCommand.mockResolvedValue(successfulResult());
    const captured = createCapturedCliIo();
    const testing = runnerFor(['\r', '\r', '\r']);

    const exitCode = await runCli(['install', 'new-plugin'], {
      cwd: '/workspace', env: { CI: undefined }, interactive: true,
      io: captured.io, tuiRunner: testing.runner, ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(testing.launch).toHaveBeenCalledTimes(1);
    expect(mocks.installWriteCommand).toHaveBeenCalledWith(
      ['new-plugin'],
      expect.objectContaining({ platform: 'both' }),
      expect.any(Object),
    );
  });

  it('returns zero without executing or printing a receipt when cancelled', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue(catalogItems());
    const captured = createCapturedCliIo();
    const testing = runnerFor(['q']);

    const exitCode = await runCli(['install'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: testing.runner,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(testing.launch).toHaveBeenCalledTimes(1);
    expect(mocks.installWriteCommand).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
  });

  it.each([
    { name: 'success', result: successfulResult(), exitCode: 0 },
    { name: 'failed', result: failedResult(), exitCode: 1 },
  ])('prints the human receipt for a $name result closed with Ctrl-C', async ({ result, exitCode }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue(catalogItems());
    mocks.installWriteCommand.mockResolvedValue(result);
    const captured = createCapturedCliIo();
    const testing = runnerFor(['\r', ' ', '\r', '\r', '\u0003']);

    const actualExitCode = await runCli(['install'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: testing.runner,
      ...createTtyRuntimeStreams(),
    });

    expect(actualExitCode).toBe(exitCode);
    expect(mocks.installWriteCommand).toHaveBeenCalledTimes(1);
    if (exitCode === 1) {
      expect(testing.frames.join('\n')).toContain('操作失败');
      expect(captured.readStdout()).toBe('');
      expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
    } else {
      expect(captured.readStdout()).toContain('install');
    }
  });

  it('does not start an injected runner when the command streams are not TTYs', async () => {
    const { runCli } = await import('../../src/index.js');
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['install'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain('Usage: aw install');
    expect(captured.readStderr()).not.toContain('\u001B[');
  });

  it.each([
    {
      name: 'upgrade all selectors and timeout',
      argv: ['upgrade', '--all', '--catalog-channel', 'beta', '--script-timeout', '1234'],
      helper: 'upgradeWriteCommand' as const,
      expected: 'aw upgrade --all --platform both --scope user --catalog-channel beta --script-timeout 1234',
    },
    {
      name: 'quoted plugin and exact catalog version',
      argv: ['install', "alpha beta's", '--catalog-version', '2.0.0-beta.1'],
      helper: 'installWriteCommand' as const,
      expected: "aw install --platform both --scope user --catalog-version 2.0.0-beta.1 -- 'alpha beta'\"'\"'s'",
    },
  ])('renders all applied parameters for $name', async ({ argv, helper, expected }) => {
    const { runCli } = await import('../../src/index.js');
    mocks[helper].mockResolvedValue(successfulResult());
    const captured = createCapturedCliIo();
    const testing = runnerFor(['\r', '\r', '\r']);

    const exitCode = await runCli(argv, {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: testing.runner,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(testing.frames.join('\n').replaceAll(/\s+/g, ' ')).toContain(expected.slice(0, 70));
  });

  it('keeps a raw native command failure out of wizard output and stderr', async () => {
    const { runCli } = await import('../../src/index.js');
    const raw = 'native failed token=plain-secret at /Users/alice/Private/native.log';
    mocks.loadConsoleItemsResult.mockResolvedValue(catalogItems());
    mocks.installWriteCommand.mockRejectedValue(new Error(raw));
    const captured = createCapturedCliIo();
    const testing = runnerFor(['\r', ' ', '\r', '\r', '\r']);
    const debugEvents: string[] = [];

    const exitCode = await runCli(['install', '--verbose'], {
      cwd: '/workspace', env: { CI: undefined }, interactive: true,
      io: captured.io, tuiRunner: testing.runner, ...createTtyRuntimeStreams(),
      debugLogger: { log: (event) => { debugEvents.push(JSON.stringify(event)); } },
    });

    expect(exitCode).toBe(1);
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain('操作失败。详细原因请使用 --debug 查看日志。');
    expect(captured.readStderr()).not.toContain('native failed');
    expect(captured.readStderr()).not.toContain('plain-secret');
    expect(captured.readStderr()).not.toContain('/Users/alice');
    expect(testing.frames.join('\n')).not.toContain('native failed');
    expect(testing.frames.join('\n')).not.toContain('alice');
    expect(debugEvents.join('\n')).toContain('native failed');
    expect(debugEvents.join('\n')).toContain('/Users/alice');
    expect(debugEvents.join('\n')).not.toContain('plain-secret');
  });

  it('preserves the raw error contract for a complete non-wizard command', async () => {
    const { runCli } = await import('../../src/index.js');
    const raw = 'direct native failure at /Users/alice/direct.log';
    mocks.installWriteCommand.mockRejectedValue(new Error(raw));
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['install', 'alpha', '--platform', 'codex'], {
      cwd: '/workspace', env: { CI: undefined }, interactive: false, io: captured.io,
    });

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain(raw);
  });

  it.each(['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'] as const)(
    'places %s summary options before the positional boundary',
    async (command) => {
      const { buildEquivalentWriteCommandTokens } = await import('../../src/index.js');
      const tokens = buildEquivalentWriteCommandTokens(command, {
        plugins: ['-plugin'],
        platform: 'codex',
        scope: 'user',
      }, {
        catalogChannel: 'beta',
        scriptTimeout: '1234',
      });
      const boundary = tokens.indexOf('--');

      expect(boundary).toBeGreaterThan(1);
      expect(tokens.slice(boundary + 1)).toEqual(['-plugin']);
      expect(tokens.slice(0, boundary)).toContain('--platform');
      expect(tokens.slice(0, boundary)).toContain('--scope');
    },
  );
});
