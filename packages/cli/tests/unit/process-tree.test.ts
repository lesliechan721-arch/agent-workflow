import { describe, expect, it, vi } from 'vitest';

import {
  observeProcessTree,
  terminateProcessTree,
} from '../../src/utils/process-tree.js';

interface FakeProcess {
  ppid: number;
  state: string;
  startTime: string;
}

function renderPosixTable(processes: ReadonlyMap<number, FakeProcess>): string {
  return [...processes].map(([pid, entry]) =>
    `${pid} ${entry.ppid} ${entry.state} ${entry.startTime}`
  ).join('\n');
}

describe('process-tree', () => {
  it('freezes, verifies, and terminates POSIX descendants before the direct child', async () => {
    const processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'first-start' }],
      [102, { ppid: 101, state: 'S', startTime: 'nested-start' }],
    ]);
    const kill = vi.fn((pid: number, signal: string) => {
      const entry = processes.get(pid);
      if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' });
      if (signal === 'SIGKILL') processes.delete(pid);
    });
    const killDirectChild = vi.fn();
    const execFile = vi.fn((_command, _args, _options, callback) => {
      callback(null, renderPosixTable(processes));
    });

    await terminateProcessTree(100, killDirectChild, {
      platform: 'linux',
      kill,
      execFile,
    });

    expect(kill.mock.calls[0]).toEqual([100, 'SIGSTOP']);
    for (const descendantPid of [101, 102]) {
      const stopIndex = kill.mock.calls.findIndex((call) =>
        call[0] === descendantPid && call[1] === 'SIGSTOP'
      );
      const killIndex = kill.mock.calls.findIndex((call) =>
        call[0] === descendantPid && call[1] === 'SIGKILL'
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(killIndex).toBeGreaterThan(stopIndex);
    }
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('terminates a marker-observed POSIX descendant after it is reparented', async () => {
    const marker = 'marker-value';
    const processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'descendant-start' }],
    ]);
    const marked = new Set([100, 101]);
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.includes('pid=,command=')) {
        callback(null, [...marked].map((pid) =>
          `${pid} node AW_NATIVE_CLI_PROCESS_MARKER=${marker}`
        ).join('\n'));
        return;
      }
      callback(null, renderPosixTable(processes));
    });
    const kill = vi.fn((pid: number, signal: string) => {
      const entry = processes.get(pid);
      if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' });
      if (signal === 'SIGKILL') {
        processes.delete(pid);
        marked.delete(pid);
      }
    });
    const observation = observeProcessTree(100, marker, {
      platform: 'darwin',
      execFile,
      kill,
    });
    await Promise.resolve();
    processes.delete(100);
    marked.delete(100);
    processes.set(101, { ...processes.get(101)!, ppid: 1 });
    const killDirectChild = vi.fn();

    await terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'darwin', execFile, kill },
      { observation, requireConfirmedCleanup: true },
    );

    expect(kill).toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).toHaveBeenCalledWith(101, 'SIGKILL');
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips process signals and rejects when POSIX marker lookup fails', async () => {
    const marker = 'marker-value';
    const processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'descendant-start' }],
    ]);
    let markerLookup = 0;
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.includes('pid=,command=')) {
        markerLookup += 1;
        if (markerLookup === 1) {
          callback(null, [100, 101].map((pid) =>
            `${pid} node AW_NATIVE_CLI_PROCESS_MARKER=${marker}`
          ).join('\n'));
        } else {
          callback(new Error('marker ps failed'), '');
        }
        return;
      }
      callback(null, renderPosixTable(processes));
    });
    const kill = vi.fn((pid: number, signal: string) => {
      const entry = processes.get(pid);
      if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' });
      if (signal === 'SIGKILL') processes.delete(pid);
    });
    const observation = observeProcessTree(100, marker, {
      platform: 'linux',
      execFile,
      kill,
    });
    const killDirectChild = vi.fn();

    await expect(terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'linux', execFile, kill },
      { observation },
    )).rejects.toThrow('cleanup unconfirmed');

    expect(kill).not.toHaveBeenCalled();
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not signal a historical same-second PID outside current lineage after marker failure', async () => {
    const marker = 'marker-value';
    const processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'same-second-start' }],
    ]);
    let markerLookup = 0;
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.includes('pid=,command=')) {
        markerLookup += 1;
        if (markerLookup === 1) {
          callback(null, [100, 101].map((pid) =>
            `${pid} node AW_NATIVE_CLI_PROCESS_MARKER=${marker}`
          ).join('\n'));
        } else {
          callback(new Error('marker ps failed'), '');
        }
        return;
      }
      callback(null, renderPosixTable(processes));
    });
    const kill = vi.fn((pid: number, signal: string) => {
      const entry = processes.get(pid);
      if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' });
    });
    const observation = observeProcessTree(100, marker, {
      platform: 'linux',
      execFile,
      kill,
    });
    await Promise.resolve();
    processes.set(101, {
      ppid: 1,
      state: 'S',
      startTime: 'same-second-start',
    });

    await expect(terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'linux', execFile, kill },
      { observation },
    )).rejects.toThrow('cleanup unconfirmed');

    expect(kill).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(101, 'SIGKILL');
  });

  it('does not signal a same-second reused root lineage when confirmed cleanup loses marker lookup', async () => {
    const marker = 'marker-value';
    let processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'same-second-root' }],
      [101, { ppid: 100, state: 'S', startTime: 'old-child' }],
    ]);
    let markerLookup = 0;
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.includes('pid=,command=')) {
        markerLookup += 1;
        if (markerLookup === 1) {
          callback(null, [100, 101].map((pid) =>
            `${pid} node AW_NATIVE_CLI_PROCESS_MARKER=${marker}`
          ).join('\n'));
        } else {
          callback(new Error('marker ps failed'), '');
        }
        return;
      }
      callback(null, renderPosixTable(processes));
    });
    const kill = vi.fn();
    const observation = observeProcessTree(100, marker, {
      platform: 'linux',
      execFile,
      kill,
    });
    await Promise.resolve();
    processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'same-second-root' }],
      [202, { ppid: 100, state: 'S', startTime: 'new-child' }],
    ]);
    const killDirectChild = vi.fn();

    await expect(terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'linux', execFile, kill },
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('cleanup unconfirmed');

    expect(kill).not.toHaveBeenCalled();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not signal a same-second reused POSIX PID after its marker disappears', async () => {
    const marker = 'marker-value';
    const processes = new Map<number, FakeProcess>([
      [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      [101, { ppid: 100, state: 'S', startTime: 'old-start' }],
    ]);
    const marked = new Set([100, 101]);
    const execFile = vi.fn((_command, args, _options, callback) => {
      if (args.includes('pid=,command=')) {
        callback(null, [...marked].map((pid) =>
          `${pid} node AW_NATIVE_CLI_PROCESS_MARKER=${marker}`
        ).join('\n'));
        return;
      }
      callback(null, renderPosixTable(processes));
    });
    const kill = vi.fn();
    const observation = observeProcessTree(100, marker, {
      platform: 'linux',
      execFile,
      kill,
    });
    await Promise.resolve();
    processes.delete(100);
    marked.clear();
    processes.set(100, { ppid: 1, state: 'S', startTime: 'root-start' });
    processes.set(101, { ppid: 1, state: 'S', startTime: 'old-start' });

    await terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'linux', execFile, kill },
      { observation },
    );

    expect(kill).not.toHaveBeenCalledWith(101, 'SIGSTOP');
    expect(kill).not.toHaveBeenCalledWith(101, 'SIGKILL');
    expect(kill).not.toHaveBeenCalledWith(100, 'SIGSTOP');
  });

  it('falls back to the direct child when POSIX observation cannot see its marker', async () => {
    const execFile = vi.fn((_command, args, _options, callback) => {
      callback(null, args.includes('pid=,command=') ? '' : '100 1 S root-start');
    });
    const kill = vi.fn();
    const observation = observeProcessTree(100, 'missing-marker', {
      platform: 'linux',
      execFile,
      kill,
    });
    const killDirectChild = vi.fn();

    await terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'linux', execFile, kill },
      { observation },
    );

    expect(kill).not.toHaveBeenCalled();
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('freezes a descendant returned at the POSIX lookup deadline before killing it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const processes = new Map<number, FakeProcess>([
        [100, { ppid: 1, state: 'S', startTime: 'root-start' }],
      ]);
      const kill = vi.fn((pid: number, signal: string) => {
        const entry = processes.get(pid);
        if (entry && signal === 'SIGSTOP') processes.set(pid, { ...entry, state: 'T' });
        if (signal === 'SIGKILL') processes.delete(pid);
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
        callback(null, renderPosixTable(processes));
      });

      await terminateProcessTree(100, vi.fn(), {
        platform: 'linux',
        execFile,
        kill,
      });

      const stopIndex = kill.mock.calls.findIndex((call) =>
        call[0] === 101 && call[1] === 'SIGSTOP'
      );
      const killIndex = kill.mock.calls.findIndex((call) =>
        call[0] === 101 && call[1] === 'SIGKILL'
      );
      expect(stopIndex).toBeGreaterThanOrEqual(0);
      expect(killIndex).toBeGreaterThan(stopIndex);
    } finally {
      vi.useRealTimers();
    }
  });

  it('taskkills an identity-verified Windows descendant after the root exits', async () => {
    const processes = new Map([
      [100, { ppid: 1, startTime: '1000' }],
      [101, { ppid: 100, startTime: '1001' }],
    ]);
    const renderTable = () => [...processes].map(([pid, entry]) =>
      `${pid}|${entry.ppid}|${entry.startTime}`
    ).join('\n');
    const execFile = vi.fn((command, args, _options, callback) => {
      if (command === 'taskkill') {
        processes.delete(Number(args[1]));
        callback(null, 'SUCCESS');
        return;
      }
      callback(null, renderTable());
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    await Promise.resolve();
    processes.delete(100);
    processes.set(101, { ...processes.get(101)!, ppid: 1 });

    await terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'win32', execFile },
      { observation, requireConfirmedCleanup: true },
    );

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '101', '/T', '/F'],
      { timeout: 1_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
  });

  it('taskkills only the Windows root while it still owns the process tree', async () => {
    const processes = new Map([
      [100, { ppid: 1, startTime: '1000' }],
      [101, { ppid: 100, startTime: '1001' }],
      [102, { ppid: 101, startTime: '1002' }],
    ]);
    const taskkillPids: number[] = [];
    const execFile = vi.fn((command, args, _options, callback) => {
      if (command === 'taskkill') {
        taskkillPids.push(Number(args[1]));
        processes.clear();
        callback(null, 'SUCCESS');
        return;
      }
      callback(null, [...processes].map(([pid, entry]) =>
        `${pid}|${entry.ppid}|${entry.startTime}`
      ).join('\n'));
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });

    await terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'win32', execFile },
      { observation, requireConfirmedCleanup: true },
    );

    expect(taskkillPids).toEqual([100]);
  });

  it('taskkills the active Windows root when initial observation misses it', async () => {
    let lookup = 0;
    const execFile = vi.fn((command, _args, _options, callback) => {
      if (command === 'taskkill') {
        callback(null, 'SUCCESS');
        return;
      }
      lookup += 1;
      callback(null, lookup === 1 ? '' : '100|1|1000\n101|100|1001');
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    const killDirectChild = vi.fn();

    await terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'win32', execFile },
      { observation },
    );

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '100', '/T', '/F'],
      { timeout: 1_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
    expect(lookup).toBe(1);
  });

  it('taskkills the active Windows root when observation contains no target', async () => {
    const execFile = vi.fn((command, _args, _options, callback) => {
      callback(null, command === 'taskkill' ? 'SUCCESS' : '');
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    const killDirectChild = vi.fn();

    await terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'win32', execFile },
      { observation },
    );

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '100', '/T', '/F'],
      { timeout: 1_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
  });

  it('rejects and directly kills the active Windows root when taskkill fallback fails', async () => {
    let lookup = 0;
    const execFile = vi.fn((command, _args, _options, callback) => {
      if (command === 'taskkill') {
        callback(new Error('taskkill failed'), '');
        return;
      }
      lookup += 1;
      callback(null, '');
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    const killDirectChild = vi.fn();

    await expect(terminateProcessTree(
      100,
      killDirectChild,
      { platform: 'win32', execFile },
      { observation },
    )).rejects.toThrow('cleanup unconfirmed');

    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '100', '/T', '/F'],
      { timeout: 1_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      expect.any(Function),
    );
    expect(killDirectChild).toHaveBeenCalledOnce();
    expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
    expect(lookup).toBe(1);
  });

  it('does not taskkill a reused Windows descendant PID and reports unconfirmed cleanup', async () => {
    const processes = new Map([
      [100, { ppid: 1, startTime: '1000' }],
      [101, { ppid: 100, startTime: '1001' }],
    ]);
    const execFile = vi.fn((command, _args, _options, callback) => {
      expect(command).toBe('powershell.exe');
      callback(null, [...processes].map(([pid, entry]) =>
        `${pid}|${entry.ppid}|${entry.startTime}`
      ).join('\n'));
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    await Promise.resolve();
    processes.delete(100);
    processes.set(101, { ppid: 1, startTime: 'reused-start' });

    await expect(terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'win32', execFile },
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('cleanup unconfirmed');
    expect(execFile).not.toHaveBeenCalledWith(
      'taskkill',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('rejects when Windows taskkill leaves a nested observed descendant running', async () => {
    const processes = new Map([
      [100, { ppid: 1, startTime: '1000' }],
      [101, { ppid: 100, startTime: '1001' }],
      [102, { ppid: 101, startTime: '1002' }],
    ]);
    const taskkillPids: number[] = [];
    const execFile = vi.fn((command, args, _options, callback) => {
      if (command === 'taskkill') {
        const pid = Number(args[1]);
        taskkillPids.push(pid);
        processes.delete(pid);
        callback(null, 'SUCCESS');
        return;
      }
      callback(null, [...processes].map(([pid, entry]) =>
        `${pid}|${entry.ppid}|${entry.startTime}`
      ).join('\n'));
    });
    const observation = observeProcessTree(100, undefined, {
      platform: 'win32',
      execFile,
    });
    await Promise.resolve();
    processes.delete(100);
    processes.set(101, { ...processes.get(101)!, ppid: 1 });

    await expect(terminateProcessTree(
      100,
      vi.fn(),
      { platform: 'win32', execFile },
      { observation, requireConfirmedCleanup: true },
    )).rejects.toThrow('cleanup unconfirmed');
    expect(taskkillPids).toEqual([101]);
    expect(processes.has(102)).toBe(true);
  });

  it('bounds slow Windows cleanup and taskkills only descendant roots in parallel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let windowsLookup = 0;
      const taskkillStartedAt: number[] = [];
      const taskkillPids: number[] = [];
      const execFile = vi.fn((command, args, _options, callback) => {
        if (command === 'taskkill') {
          taskkillStartedAt.push(Date.now());
          taskkillPids.push(Number(args[1]));
          setTimeout(() => callback(null, 'SUCCESS'), 900);
          return;
        }
        windowsLookup += 1;
        const stdout = windowsLookup === 1
          ? [
              '100|1|1000',
              '101|100|1001',
              '102|100|1002',
              '103|101|1003',
            ].join('\n')
          : windowsLookup === 2
            ? [
                '101|1|1001',
                '102|1|1002',
                '103|101|1003',
              ].join('\n')
            : '';
        setTimeout(() => callback(null, stdout), 900);
      });
      const observation = observeProcessTree(100, undefined, {
        platform: 'win32',
        execFile,
      });
      const promise = terminateProcessTree(
        100,
        vi.fn(),
        { platform: 'win32', execFile },
        { observation, requireConfirmedCleanup: true },
      );

      await vi.advanceTimersByTimeAsync(3_600);
      await promise;

      expect(taskkillPids.sort()).toEqual([101, 102]);
      expect(taskkillStartedAt).toEqual([1_800, 1_800]);
      expect(Date.now()).toBe(3_600);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('always reports unconfirmed cleanup when the POSIX identity lookup times out', async () => {
    vi.useFakeTimers();
    try {
      const killDirectChild = vi.fn();
      const promise = terminateProcessTree(
        100,
        killDirectChild,
        { platform: 'linux', execFile: vi.fn() },
      );
      const assertion = expect(promise).rejects.toThrow('cleanup unconfirmed');
      await vi.advanceTimersByTimeAsync(250);
      await assertion;

      expect(killDirectChild).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds taskkill and reports unconfirmed Windows cleanup', async () => {
    vi.useFakeTimers();
    try {
      const processes = new Map([
        [100, { ppid: 1, startTime: '1000' }],
      ]);
      const execFile = vi.fn((command, _args, _options, callback) => {
        if (command === 'powershell.exe') {
          callback(null, [...processes].map(([pid, entry]) =>
            `${pid}|${entry.ppid}|${entry.startTime}`
          ).join('\n'));
        }
      });
      const observation = observeProcessTree(100, undefined, {
        platform: 'win32',
        execFile,
      });
      await Promise.resolve();
      const promise = terminateProcessTree(
        100,
        vi.fn(),
        { platform: 'win32', execFile },
        { observation },
      );
      const assertion = expect(promise).rejects.toThrow('cleanup unconfirmed');
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
