import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  NativeCliError,
  createExecFileNativeCliRunner,
  execFileNativeCliRunner,
  isNativeCliExecutableMissingError,
  isNativeCliTimeoutError,
  runNativeCli,
  summarizeNativeCliFailure,
} from '../../src/utils/native-cli.js';
import { TestNativeCliGuardError } from '../helpers/native-guard.js';

describe('native-cli', () => {
  it('blocks guarded agent CLIs by default in tests', async () => {
    const invocation = {
      command: 'codex',
      args: ['plugin', 'marketplace', 'add', '/tmp/aw-home'],
      cwd: '/tmp/workspace',
      env: {
        AW_HOME: '/tmp/aw-home',
        PATH: '/tmp/bin',
      } as NodeJS.ProcessEnv,
    };

    await expect(runNativeCli(invocation)).rejects.toBeInstanceOf(TestNativeCliGuardError);
    await expect(runNativeCli(invocation)).rejects.toThrow('请显式注入 fake native runner');
    await expect(runNativeCli(invocation)).rejects.toThrow(
      'cwd 来源: runNativeCli()/createCommandExecutionContext() invocation.cwd',
    );
  });

  it('passes invocations through fake runners', async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

    const result = await runNativeCli(
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
      },
      async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        };
      },
    );

    expect(calls).toEqual([
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
        timeoutMs: 60_000,
      },
    ]);
    expect(result.stdout).toBe('ok');
  });

  it('applies the default timeout to Codex and Claude executables across path formats', async () => {
    const calls: Array<{ command: string; timeoutMs?: number }> = [];
    const runner = async (invocation: { command: string; timeoutMs?: number }) => {
      calls.push(invocation);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await runNativeCli({ command: '/usr/local/bin/codex', args: [], env: {} }, runner);
    await runNativeCli({ command: 'C:\\Tools\\Claude.EXE', args: [], env: {} }, runner);

    expect(calls).toEqual([
      expect.objectContaining({ command: '/usr/local/bin/codex', timeoutMs: 60_000 }),
      expect.objectContaining({ command: 'C:\\Tools\\Claude.EXE', timeoutMs: 60_000 }),
    ]);
  });

  it.each([
    ['0', 0],
    ['1000', 1_000],
    ['600000', 600_000],
  ])('accepts AW_NATIVE_CLI_TIMEOUT_MS=%s', async (rawValue, expectedTimeout) => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'codex',
        args: ['plugin', 'list'],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: rawValue },
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBe(expectedTimeout);
  });

  it.each(['', '999', '600001', '1.5', 'invalid'])(
    'rejects invalid AW_NATIVE_CLI_TIMEOUT_MS=%j before calling the runner',
    async (rawValue) => {
      let runnerCalled = false;

      await expect(
        runNativeCli(
          {
            command: 'claude',
            args: ['plugin', 'list'],
            env: { AW_NATIVE_CLI_TIMEOUT_MS: rawValue },
          },
          async () => {
            runnerCalled = true;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        ),
      ).rejects.toThrow(
        `Invalid AW_NATIVE_CLI_TIMEOUT_MS=${JSON.stringify(rawValue)}. Expected 0 or an integer from 1000 to 600000.`,
      );
      expect(runnerCalled).toBe(false);
    },
  );

  it('keeps an explicit invocation timeout ahead of the environment default', async () => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'codex',
        args: [],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: '1000' },
        timeoutMs: 2_500,
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBe(2_500);
  });

  it('validates the environment before running an agent CLI with an explicit timeout', async () => {
    let runnerCalled = false;

    await expect(
      runNativeCli(
        {
          command: 'claude',
          args: [],
          env: { AW_NATIVE_CLI_TIMEOUT_MS: 'invalid' },
          timeoutMs: 2_500,
        },
        async () => {
          runnerCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      ),
    ).rejects.toThrow('AW_NATIVE_CLI_TIMEOUT_MS="invalid"');
    expect(runnerCalled).toBe(false);
  });

  it('does not apply or validate the agent timeout for other native commands', async () => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'tar',
        args: ['--version'],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: 'invalid' },
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBeUndefined();
  });

  it('captures stdout and stderr from execFile', async () => {
    const result = await execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready"); process.stderr.write("warn");'],
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ready',
      stderr: 'warn',
    });
  });

  it('converts non-zero exits into NativeCliError', async () => {
    await expect(
      execFileNativeCliRunner({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(7);',
        ],
      }),
    ).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 7,
      stdout: 'partial',
      stderr: 'boom',
    });
  });

  it('surfaces real child timeouts with exitCode 124 and a stable reason', async () => {
    const promise = execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000);'],
      timeoutMs: 100,
    });

    await expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 124,
      reason: 'timeout',
    });
    await expect(promise).rejects.toSatisfy(isNativeCliTimeoutError);
  });

  it('starts timeout accounting after spawn and preserves timeout output', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
        stdout,
        stderr,
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      let finishCleanup: (() => void) | undefined;
      const terminate = vi.fn(() => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }));
      const runner = createExecFileNativeCliRunner({
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        terminateProcessTree: terminate,
      });

      const promise = runner({
        command: 'codex',
        args: [],
        timeoutMs: 100,
      });
      const assertion = expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: 'callback partial',
        stderr: 'callback warning',
      });
      expect(vi.getTimerCount()).toBe(0);

      stdout.write('stream partial');
      stderr.write('stream warning');
      child.emit('spawn');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(terminate).toHaveBeenCalledWith(321, expect.any(Function));

      callback!(new Error('terminated'), 'callback partial', 'callback warning');
      finishCleanup!();
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles without an execFile callback, preserves stream output, and ignores a late callback', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
        stdout,
        stderr,
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        terminateProcessTree: vi.fn(async () => {}),
      });

      const promise = runner({
        command: 'codex',
        args: [],
        timeoutMs: 100,
      });
      const errorPromise = promise.catch((error: unknown) => error);
      stdout.write('partial');
      stderr.write('warning');
      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(100);

      const error = await errorPromise;
      expect(error).toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: 'partial',
        stderr: 'warning',
      });

      callback!(new Error('late callback'), 'late stdout', 'late stderr');
      await Promise.resolve();
      expect(error).toMatchObject({ stdout: 'partial', stderr: 'warning' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles spawn errors without starting a timeout timer', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
      });

      const promise = runner({
        command: 'missing-native-cli',
        args: [],
        timeoutMs: 1_000,
      });
      callback!(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '');

      await expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
        exitCode: 1,
        reason: 'exit',
        stdout: '',
        stderr: '',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['resolved', () => Promise.resolve(), 0],
    ['rejected', () => Promise.reject(new Error('cleanup rejected')), 1],
    ['throwing', () => { throw new Error('cleanup threw'); }, 1],
    ['pending', () => new Promise<void>(() => {}), 1],
  ])('settles timeout errors when process-tree cleanup is %s', async (
    _label,
    terminate,
    expectedDirectKills,
  ) => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
      });
      const runner = createExecFileNativeCliRunner({
        execFile: () => child,
        terminateProcessTree: terminate,
      });

      const promise = runner({
        command: 'codex',
        args: [],
        timeoutMs: 100,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(1_500);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: '',
        stderr: '',
      });
      expect(child.kill).toHaveBeenCalledTimes(expectedDirectKills);
      if (expectedDirectKills > 0) {
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start an already-aborted invocation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const execFile = vi.fn();
    const runner = createExecFileNativeCliRunner({ execFile });

    await expect(runner({
      command: 'tar',
      args: [],
      signal: controller.signal,
    })).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 1,
      reason: 'aborted',
      stdout: '',
      stderr: '',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('aborts a running invocation once and settles without an execFile callback', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
      });
      const terminate = vi.fn(async () => {});
      const runner = createExecFileNativeCliRunner({
        execFile: () => child,
        terminateProcessTree: terminate,
      });
      const promise = runner({
        command: 'tar',
        args: [],
        signal: controller.signal,
        timeoutMs: 1_000,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      child.emit('spawn');
      controller.abort(new Error('cancelled while running'));
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
        exitCode: 1,
        reason: 'aborted',
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects ENOENT spawn failures as missing executables', () => {
    const error = new NativeCliError({
      invocation: {
        command: 'codex',
        args: ['--version'],
      },
      exitCode: 1,
      stdout: '',
      stderr: '',
      cause: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    });

    expect(isNativeCliExecutableMissingError(error)).toBe(true);
  });

  it('summarizes native CLI failures from stderr, stdout, or the fallback message', () => {
    expect(
      summarizeNativeCliFailure(new NativeCliError({
        invocation: {
          command: 'codex',
          args: ['--version'],
        },
        exitCode: 1,
        stdout: 'partial output',
        stderr: 'boom',
      })),
    ).toBe('boom');

    expect(
      summarizeNativeCliFailure(new NativeCliError({
        invocation: {
          command: 'claude',
          args: ['--version'],
        },
        exitCode: 1,
        stdout: 'partial output',
        stderr: '',
      })),
    ).toBe('partial output');
  });
});
