import { describe, expect, it, vi } from 'vitest';

import { terminateProcessTree } from '../../src/utils/process-tree.js';

describe('process-tree', () => {
  it('freezes, verifies, and terminates POSIX descendants before the direct child', async () => {
    const kill = vi.fn();
    const killDirectChild = vi.fn();
    let lookup = 0;
    const execFile = vi.fn((_command, _args, _options, callback) => {
      lookup += 1;
      callback(null, [
        '100 1 T root-start',
        `101 100 ${lookup === 1 ? 'S' : 'T'} first-start`,
        `102 101 ${lookup === 1 ? 'S' : 'T'} nested-start`,
        `103 100 ${lookup === 1 ? 'S' : 'T'} second-start`,
      ].join('\n'));
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledWith(
      'ps',
      ['-A', '-o', 'pid=,ppid=,state=,lstart='],
      { timeout: 500, windowsHide: true },
      expect.any(Function),
    );
    expect(kill.mock.calls[0]).toEqual([100, 'SIGSTOP']);
    for (const descendantPid of [101, 102, 103]) {
      const stopIndex = kill.mock.calls.findIndex((call) =>
        call[0] === descendantPid && call[1] === 'SIGSTOP'
      );
      const killIndex = kill.mock.calls.findIndex((call) =>
        call[0] === descendantPid && call[1] === 'SIGKILL'
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(killIndex).toBeGreaterThan(stopIndex);
    }
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('discovers a detached descendant created as the root is frozen', async () => {
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
    ]);
    const kill = vi.fn((pid: number, signal: string) => {
      if (pid === 100 && signal === 'SIGSTOP') {
        processes.set(100, { ppid: 1, state: 'T', startTime: 'root-start' });
        processes.set(101, { ppid: 100, state: 'S', startTime: 'descendant-start' });
      }
      if (pid === 101 && signal === 'SIGSTOP') {
        processes.set(101, { ppid: 100, state: 'T', startTime: 'descendant-start' });
      }
    });
    const killDirectChild = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, [...processes].map(([pid, entry]) =>
        `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
      ).join('\n'));
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(kill).toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('freezes to a fixed point when newly discovered descendants create children', async () => {
    const processes = new Map([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
    ]);
    const createdBy = new Set<number>();
    const kill = vi.fn((pid: number, signal: string) => {
      if (signal !== 'SIGSTOP') return;
      const entry = processes.get(pid);
      if (entry) processes.set(pid, { ...entry, state: 'T' });
      if (createdBy.has(pid)) return;
      createdBy.add(pid);
      if (pid === 100) {
        processes.set(101, { ppid: 100, state: 'S', startTime: 'first-start' });
      } else if (pid === 101) {
        processes.set(102, { ppid: 101, state: 'S', startTime: 'second-start' });
      } else if (pid === 102) {
        processes.set(103, { ppid: 102, state: 'S', startTime: 'final-start' });
      }
    });
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, [...processes].map(([pid, entry]) =>
        `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
      ).join('\n'));
    });

    await terminateProcessTree(100, vi.fn(), {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(execFile).toHaveBeenCalledTimes(4);
    expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(102, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith(103, 'SIGKILL');
  });

  it('freezes a descendant returned at the lookup deadline before killing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const processes = new Map([
        [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      let escapedDescendantCreated = false;
      const kill = vi.fn((pid: number, signal: string) => {
        const entry = processes.get(pid);
        if (signal === 'SIGSTOP' && entry) {
          processes.set(pid, { ...entry, state: 'T' });
        }
        if (pid === 101 && signal === 'SIGKILL' && entry?.state !== 'T') {
          escapedDescendantCreated = true;
        }
      });
      let lookup = 0;
      const execFile = vi.fn((_command, _args, _options, callback) => {
        lookup += 1;
        if (lookup === 2) {
          vi.setSystemTime(1_000);
          processes.set(101, {
            ppid: 100,
            state: 'S',
            startTime: 'deadline-child-start',
          });
        }
        callback(null, [...processes].map(([pid, entry]) =>
          `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
        ).join('\n'));
      });

      await terminateProcessTree(100, vi.fn(), {
        platform: 'linux',
        kill,
        execFile,
      });

      const stopIndex = kill.mock.calls.findIndex((call) =>
        call[0] === 101 && call[1] === 'SIGSTOP'
      );
      const killIndex = kill.mock.calls.findIndex((call) =>
        call[0] === 101 && call[1] === 'SIGKILL'
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(killIndex).toBeGreaterThan(stopIndex);
      expect(escapedDescendantCreated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not terminate a reused descendant PID', async () => {
    const kill = vi.fn();
    const killDirectChild = vi.fn();
    let lookup = 0;
    const execFile = vi.fn((_command, _args, _options, callback) => {
      lookup += 1;
      callback(null, lookup === 1
        ? '100 1 T root-start\n101 100 S old-start'
        : '100 1 T root-start\n101 100 S reused-start');
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(kill).toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(101, 'SIGKILL');
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills frozen descendants from the first snapshot when the second lookup fails', async () => {
    const kill = vi.fn();
    const killDirectChild = vi.fn();
    let lookup = 0;
    const execFile = vi.fn((_command, _args, _options, callback) => {
      lookup += 1;
      if (lookup === 1) {
        callback(null, '100 1 T root-start\n101 100 S descendant-start');
      } else {
        callback(new Error('second ps failed'), '');
      }
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(kill).toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
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
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith(100, 'SIGSTOP');
      expect(killDirectChild).toHaveBeenCalledOnce();
      expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
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
