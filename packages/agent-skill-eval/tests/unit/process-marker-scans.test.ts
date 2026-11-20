import { expect, it, vi } from 'vitest';

import { observeProcessTree, terminateProcessTree, type ProcessTreeDependencies } from '../../src/process-tree.js';

function processScans() {
  const pending: Array<(error: Error | null, stdout: string) => void> = [];
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const dependencies: ProcessTreeDependencies = {
    platform: 'linux',
    coalescePosixMarkerScans: true,
    kill,
    execFile: (_command, args, _options, callback) => {
      expect(args[0]).toBe('eww');
      pending.push(callback);
    },
  };
  const observe = (pid: number, marker: string) => observeProcessTree(pid, marker, dependencies);
  const terminate = (observation: ReturnType<typeof observe>) =>
    terminateProcessTree(observation.pid, () => {}, dependencies, { observation, requireConfirmedCleanup: true });
  return { pending, kill, observe, terminate };
}

// A shared table must not cross cleanup requests or authorize signaling a reused PID.
it('takes a fresh scan for a request made after launch and keeps marker ownership independent', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const { pending, observe, terminate, kill } = processScans();
    const first = observe(101, 'first-private-marker');
    const second = observe(201, 'second-private-marker');
    await vi.advanceTimersByTimeAsync(2);
    expect(pending).toHaveLength(1);
    pending.shift()!(null, [
      '101 1 101 S first-root node AW_NATIVE_CLI_PROCESS_MARKER=first-private-marker',
      '201 1 201 S second-root node AW_NATIVE_CLI_PROCESS_MARKER=second-private-marker',
    ].join('\n'));
    await vi.advanceTimersByTimeAsync(0);

    const firstCleanup = terminate(first);
    await vi.advanceTimersByTimeAsync(2);
    expect(pending).toHaveLength(1);
    const secondCleanup = terminate(second);
    await vi.advanceTimersByTimeAsync(2);
    expect(pending).toHaveLength(2);

    const firstScan = [
      '101 1 101 S reused-root unrelated',
      '103 1 103 S new-child node AW_NATIVE_CLI_PROCESS_MARKER=first-private-marker',
      '201 1 201 S second-root node AW_NATIVE_CLI_PROCESS_MARKER=second-private-marker',
      '301 1 301 S other-root unrelated',
    ].join('\n');
    pending.shift()!(null, firstScan);
    await vi.advanceTimersByTimeAsync(0);
    expect(kill.mock.calls).toEqual([[103, 'SIGTERM']]);

    pending.shift()!(null, '301 1 301 S other-root unrelated');
    await expect(secondCleanup).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(252);
    pending.shift()!(null, '301 1 301 S other-root unrelated');
    await vi.advanceTimersByTimeAsync(52);
    pending.shift()!(null, '301 1 301 S other-root unrelated');
    await expect(firstCleanup).resolves.toBeUndefined();
    expect(kill.mock.calls).toEqual([[103, 'SIGTERM']]);
  } finally {
    vi.useRealTimers();
  }
});

// Sharing the process must not move a short deadline or make a longer request fail with it.
it('lets a later member finish after the earlier member’s inspection deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const { pending, kill, observe, terminate } = processScans();
    const first = observe(101, 'first-private-marker');
    const second = observe(201, 'second-private-marker');
    await vi.advanceTimersByTimeAsync(2);
    expect(pending).toHaveLength(1);
    pending.shift()!(null, '');
    await vi.advanceTimersByTimeAsync(0);

    const firstCleanup = terminate(first).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1);
    const secondCleanup = terminate(second);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(pending).toHaveLength(1);
    await expect(firstCleanup).resolves.toMatchObject({
      message: expect.stringContaining('reason=deadline-exceeded'),
    });
    pending.shift()!(null, '101 1 101 S first-root node AW_NATIVE_CLI_PROCESS_MARKER=first-private-marker');
    await expect(secondCleanup).resolves.toBeUndefined();
    expect(kill).not.toHaveBeenCalled();
    expect(JSON.stringify(first.diagnostics)).not.toContain('first-private-marker');
  } finally {
    vi.useRealTimers();
  }
});

// Denied process-table access must never be mistaken for an empty, verified table.
it('fails closed for both cleanup requests when a shared scan is denied', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  try {
    const { pending, kill, observe, terminate } = processScans();
    const observations = [observe(101, 'first-private-marker'), observe(201, 'second-private-marker')];
    const cleanups = Promise.allSettled(observations.map(terminate));
    await vi.advanceTimersByTimeAsync(2);
    expect(pending).toHaveLength(1);
    pending.shift()!(Object.assign(new Error('private process table output'), { code: 'EACCES' }), '');
    for (const result of await cleanups) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { message: expect.stringContaining('code=EACCES') },
      });
    }
    expect(kill).not.toHaveBeenCalled();
    for (const observation of observations) {
      expect(JSON.stringify(observation.diagnostics)).not.toContain('private process table output');
    }
  } finally {
    vi.useRealTimers();
  }
});
