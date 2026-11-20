import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

import * as linux from '../../src/linux-process-marker.js';
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

// Linux procfs distinguishes real startup environment entries from argv and
// incomplete reads. A changed image must never inherit the old marker evidence.
it.skipIf(process.platform !== 'linux')('binds exact Linux marker evidence to the process and environment extent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aw-marker-proc-'));
  const name = 'AW_NATIVE_CLI_PROCESS_MARKER';
  const marker = 'fixture-value';
  const entry = Buffer.from(`${name}=${marker}\0`);
  const [partial, redacted, changed, wrong, empty, reparented, malformed] =
    [1, 2, 3, 4, 5, 6, 7].map(offset => process.pid + offset);
  const stat = (pid: number, start: number, end: number): string => {
    const fields = Array<string>(50).fill('0');
    fields[0] = 'S'; fields[1] = '1'; fields[2] = String(pid);
    fields[19] = String(pid + 100); fields[47] = String(start); fields[48] = String(end);
    return `${pid} (odd ) name\n) ${fields.join(' ')}\n`;
  };
  async function row(pid: number, start: number, end: number, bytes?: Buffer) {
    await mkdir(join(root, String(pid)));
    await writeFile(join(root, String(pid), 'stat'), stat(pid, start, end));
    if (bytes !== undefined) await writeFile(join(root, String(pid), 'environ'), bytes);
  }
  try {
    const unrelated = Buffer.from(`OTHER=${name}=${marker}\0`);
    await row(process.pid, 200, 200 + entry.length, entry);
    await row(partial, 200, 202 + entry.length, entry);
    await row(redacted, 0, 0, Buffer.alloc(0));
    await row(changed, 200, 200 + entry.length);
    await row(wrong, 200, 200 + unrelated.length, unrelated);
    await row(empty, 200, 200, Buffer.alloc(0));
    await row(reparented, 200, 200 + entry.length, entry);
    await row(malformed, 200, 199 + entry.length, entry.subarray(0, -1));
    const fifo = join(root, String(changed), 'environ');
    await promisify(execFile)('mkfifo', [fifo]);
    const pending = linux.readLinuxMarkerScan(name, new Set([marker]), AbortSignal.timeout(2_000), 16_384, root);
    // Opening the writer pairs with the reader after its first stat.
    const writer = await open(fifo, 'w');
    try {
      await writeFile(join(root, String(changed), 'stat'), stat(changed, 300, 300 + entry.length));
      await writer.writeFile(entry);
    } finally { await writer.close(); }
    const scan = await pending;
    expect(scan.markerPidsByValue.get(marker)).toEqual(new Set([process.pid, reparented]));
    expect(scan.unreadablePids).toEqual(new Set([partial, redacted, changed, malformed]));
    expect(scan.table.get(wrong)).toMatchObject({ pgid: wrong, startTime: String(wrong + 100) });
    expect(scan.table.has(empty)).toBe(true);
    // The synthetic FIFO has completed its controlled lookup. Use regular
    // files for the byte-limit check so the kernel can close the scan promptly.
    await rm(fifo);
    await writeFile(fifo, entry);
    await expect(linux.readLinuxMarkerScan(name, new Set([marker]), AbortSignal.timeout(2_000), 1, root))
      .rejects.toThrow('exceeded its byte limit');
    await expect(linux.readLinuxMarkerScan(name, new Set([marker]), AbortSignal.abort(), 16_384, root))
      .rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'linux')('retains the first unreadable observation and the latest failed cleanup', async () => {
  const observer = process.pid;
  const pid = observer + 1;
  const table = new Map([pid, observer].map(id => [id, { ppid: 1, pgid: id, state: 'S', startTime: String(id) }]));
  const marker = 'unreadable-fixture-marker';
  const read = vi.spyOn(linux, 'readLinuxMarkerScan').mockResolvedValue({
    table, markerPidsByValue: new Map(), unreadablePids: new Set([pid]),
  });
  const kill = vi.fn();
  const observation = observeProcessTree(pid, marker, { kill });
  try {
    await new Promise<Error>(resolve => observation.onFailure(resolve));
    await expect(terminateProcessTree(pid, () => {}, { kill }, { observation, requireConfirmedCleanup: true }))
      .rejects.toThrow('marker could not be read');
    const diagnostics = observation.diagnostics;
    expect(diagnostics.map(({ stage, reason, affectedPids }) => ({ stage, reason, affectedPids }))).toEqual(
      ['observation', 'termination-start'].map(stage => ({ stage, reason: 'process-marker-unreadable', affectedPids: [pid] })),
    );
    const cleanup = diagnostics[1];
    expect(cleanup.snapshotDeadline).toBeGreaterThan(cleanup.snapshotStartedAt!);
    expect(cleanup.queries?.map(query => query.completion)).toEqual(['callback', 'callback']);
    expect(kill).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain(marker);
  } finally {
    observation.dispose();
    read.mockRestore();
  }
});

it.skipIf(process.platform !== 'linux')('withholds an unreadable group and keeps verifying the independently marked survivor', async () => {
  const observer = process.pid;
  const root = observer + 1;
  const child = observer + 2;
  const marker = 'mixed-evidence-marker';
  const table = new Map([observer, root, child].map(pid => [pid, {
    ppid: pid === child ? root : 1, pgid: pid, state: 'S', startTime: String(pid),
  }]));
  const scan = vi.spyOn(linux, 'readLinuxMarkerScan');
  scan.mockResolvedValueOnce({ table, markerPidsByValue: new Map([[marker, new Set([root, child])]]), unreadablePids: new Set() });
  scan.mockResolvedValue({ table, markerPidsByValue: new Map([[marker, new Set([child])]]), unreadablePids: new Set([root]) });
  // Deliberately withhold delivery so the final verification also has to report the surviving child.
  const kill = vi.fn();
  const observation = observeProcessTree(root, marker, { kill });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(terminateProcessTree(root, () => {}, { kill }, { observation, requireConfirmedCleanup: true }))
      .rejects.toThrow('marker could not be read');
    expect(kill.mock.calls).toEqual([[child, 'SIGTERM'], [child, 'SIGKILL']]);
    expect(observation.diagnostics).toMatchObject([
      { stage: 'termination-start', reason: 'process-marker-unreadable', affectedPids: [root] },
      { stage: 'termination-verification', reason: 'verified-process-still-running', affectedPids: [child] },
    ]);
  } finally {
    observation.dispose();
    scan.mockRestore();
  }
});

it.skipIf(process.platform !== 'linux').each(['replaced', 'exited', 'new-group-member', 'unavailable'] as const)(
  'uses the entire latest Linux confirmation for cleanup when a member is %s', async scenario => {
    const observer = process.pid;
    const [root, child, outsider] = [1, 2, 3].map(offset => observer + offset);
    const marker = 'confirmation-fixture-marker';
    const entry = (ppid: number, pgid: number, startTime: string) => ({ ppid, pgid, state: 'S', startTime });
    const initial = new Map([
      [observer, entry(1, 1, '10')], [root, entry(observer, root, '20')], [child, entry(root, root, '30')],
    ]);
    const read = vi.spyOn(linux, 'readLinuxMarkerScan');
    const snapshot = (table: typeof initial, marked: number[], unreadable: number[] = []) => ({
      table, markerPidsByValue: new Map([[marker, new Set(marked)]]), unreadablePids: new Set(unreadable),
    });
    read.mockResolvedValueOnce(snapshot(initial, [root, child]));
    read.mockResolvedValueOnce(snapshot(initial, [child], [root]));
    const changed = new Map(initial);
    if (scenario === 'exited') changed.delete(child);
    if (scenario === 'replaced') changed.set(child, entry(1, root, '40'));
    if (scenario === 'new-group-member') changed.set(outsider, entry(1, root, '50'));
    if (scenario === 'unavailable') read.mockRejectedValue(new Error('unavailable'));
    else read.mockImplementation(async () => scenario === 'new-group-member'
      ? snapshot(new Map(changed), [root, child].filter(pid => changed.has(pid)))
      : snapshot(changed, [], [root]));
    const kill = vi.fn((pid: number) => { changed.delete(pid); });
    const observation = observeProcessTree(root, marker, { kill });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      const cleanup = terminateProcessTree(root, () => {}, { kill }, { observation, requireConfirmedCleanup: true });
      if (scenario === 'new-group-member') {
        await expect(cleanup).rejects.toThrow('unconfirmed ownership');
        expect(kill.mock.calls.map(([pid]) => pid).sort()).toEqual([root, child].sort());
      } else {
        await expect(cleanup).rejects.toThrow();
        expect(kill).not.toHaveBeenCalled();
        expect(observation.diagnostics.at(-1)?.reason).toBe(
          scenario === 'unavailable' ? 'marker-lookup-failed' : 'process-marker-unreadable',
        );
      }
    } finally {
      observation.dispose();
      read.mockRestore();
    }
  },
);

it.skipIf(process.platform !== 'linux').each(['detached-unreadable', 'detached-unmarked', 'reused-group-member'] as const)(
  'keeps %s relevant after confirmation without granting it a signal', async scenario => {
    const observer = process.pid;
    const root = observer + 1;
    const child = observer + 2;
    const marker = 'changing-child-marker';
    let rootAlive = true;
    let sample = 0;
    const read = vi.spyOn(linux, 'readLinuxMarkerScan').mockImplementation(async () => {
      const phase = sample++;
      const table = new Map([[observer, { ppid: 1, pgid: 1, state: 'S', startTime: '10' }]]);
      const marked = new Set<number>();
      const unreadable = new Set<number>();
      if (rootAlive) {
        table.set(root, { ppid: observer, pgid: root, state: 'S', startTime: '20' });
        (phase === 1 ? unreadable : marked).add(root);
      }
      const sameGroup = scenario === 'reused-group-member';
      if (sameGroup || phase > 0) {
        const replaced = sameGroup && phase >= 2;
        table.set(child, { ppid: rootAlive && !replaced ? root : 1, pgid: sameGroup ? root : child,
          state: 'S', startTime: replaced ? '40' : '30' });
        if (phase < 2) marked.add(child);
        else if (scenario === 'detached-unreadable') unreadable.add(child);
      }
      return { table, markerPidsByValue: new Map([[marker, marked]]), unreadablePids: unreadable };
    });
    const kill = vi.fn((pid: number) => { if (Math.abs(pid) === root) rootAlive = false; });
    const observation = observeProcessTree(root, marker, { kill });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(terminateProcessTree(root, () => {}, { kill }, { observation, requireConfirmedCleanup: true }))
        .rejects.toThrow();
      expect(kill.mock.calls.length).toBeGreaterThan(0);
      for (const [pid] of kill.mock.calls) {
        expect(scenario === 'reused-group-member' ? pid : Math.abs(pid)).toBe(root);
      }
      const reason = scenario === 'reused-group-member' ? 'initial-group-ownership-unconfirmed'
        : scenario === 'detached-unreadable' ? 'process-marker-unreadable' : 'known-process-marker-missing';
      expect(observation.diagnostics).toMatchObject([
        { stage: 'termination-start', reason, affectedPids: [child] },
        { stage: 'termination-verification', reason, affectedPids: [child] },
      ]);
    } finally {
      observation.dispose();
      read.mockRestore();
    }
  },
);
