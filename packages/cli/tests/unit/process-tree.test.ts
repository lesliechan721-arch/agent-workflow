import { describe, expect, it, vi } from 'vitest';

import { terminateProcessTree } from '../../src/utils/process-tree.js';

describe('process-tree', () => {
  it('discovers and terminates POSIX descendants before the direct child', async () => {
    const kill = vi.fn();
    const killDirectChild = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, [
        '100 1',
        '101 100',
        '102 101',
        '103 100',
      ].join('\n'));
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid='],
      { timeout: 1_000, windowsHide: true },
      expect.any(Function),
    );
    expect(kill.mock.calls).toEqual([
      [102, 'SIGTERM'],
      [103, 'SIGTERM'],
      [101, 'SIGTERM'],
      [102, 'SIGKILL'],
      [103, 'SIGKILL'],
      [101, 'SIGKILL'],
    ]);
    expect(killDirectChild.mock.calls).toEqual([
      ['SIGTERM'],
      ['SIGKILL'],
    ]);
  });

  it('uses taskkill to terminate a Windows process tree', async () => {
    const killDirectChild = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, 'SUCCESS');
    });

    await terminateProcessTree(321, killDirectChild, {
      platform: 'win32',
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '321', '/T', '/F'],
      { timeout: 1_000, windowsHide: true },
      expect.any(Function),
    );
    expect(killDirectChild).not.toHaveBeenCalled();
  });

  it('falls back to the direct child when taskkill fails', async () => {
    const killDirectChild = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(new Error('taskkill failed'), '');
    });

    await terminateProcessTree(321, killDirectChild, {
      platform: 'win32',
      execFile,
    });

    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('bounds a POSIX process lookup that never calls back', async () => {
    vi.useFakeTimers();
    try {
      const kill = vi.fn();
      const killDirectChild = vi.fn();
      const execFile = vi.fn();

      const promise = terminateProcessTree(100, killDirectChild, {
        platform: 'linux',
        kill,
        execFile,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(kill).not.toHaveBeenCalled();
      expect(killDirectChild.mock.calls).toEqual([
        ['SIGTERM'],
        ['SIGKILL'],
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds taskkill and ignores a late callback', async () => {
    vi.useFakeTimers();
    try {
      const killDirectChild = vi.fn();
      let callback: ((error: Error | null, stdout: string) => void) | undefined;
      const execFile = vi.fn((_command, _args, _options, nextCallback) => {
        callback = nextCallback;
      });

      const promise = terminateProcessTree(321, killDirectChild, {
        platform: 'win32',
        execFile,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await promise;

      expect(killDirectChild).toHaveBeenCalledTimes(1);
      expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);

      callback!(null, 'late success');
      expect(killDirectChild).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
