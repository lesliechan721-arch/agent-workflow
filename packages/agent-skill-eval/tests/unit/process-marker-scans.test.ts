import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';

import * as linux from '../../src/linux-process-marker.js';
import {
  acquireProcessTreeInspectionLease,
  hasOnlyZombieLinuxProcessGroupMembers,
  observeProcessTree,
  terminateProcessTree,
  type ProcessTreeDependencies,
} from '../../src/process-tree.js';

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
    fields[17] = '2';
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
    expect(scan.table.get(wrong)).toMatchObject({ pgid: wrong, startTime: String(wrong + 100), threadCount: 2 });
    expect(scan.table.has(empty)).toBe(true);
    // The synthetic FIFO has completed its controlled lookup. Use regular
    // files for the byte-limit check so the kernel can close the scan promptly.
    await rm(fifo);
    await writeFile(fifo, entry);
    await expect(linux.readLinuxMarkerScan(name, new Set([marker]), AbortSignal.timeout(2_000), 1, root))
      .rejects.toMatchObject({ code: 'PROCFS_BYTE_LIMIT' });
    await expect(linux.readLinuxMarkerScan(name, new Set([marker]), AbortSignal.abort(), 16_384, root))
      .rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function runIsolatedLinuxMarkerScan(script: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'aw-marker-scan-'));
  try {
    const ts = await import('typescript');
    const source = await readFile(new URL('../../src/linux-process-marker.ts', import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
    });
    await writeFile(join(root, 'marker.mjs'), outputText);
    const imports = `
      import assert from 'node:assert/strict';
      import { promises as fs } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { readLinuxMarkerScan } from './marker.mjs';
    `;
    await expect(promisify(execFile)(process.execPath, ['--input-type=module', '-e', imports + script], {
      cwd: root, env: {}, timeout: 3_000, killSignal: 'SIGKILL',
    })).resolves.toMatchObject({ stdout: '', stderr: '' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A partly sampled task that is being reaped can show kernel placeholders.
// Recheck its pinned directory before accepting absence or using its identity.
it.skipIf(process.platform !== 'linux')('preserves Linux marker and PID evidence across a partially reaped stat', async () => {
  await runIsolatedLinuxMarkerScan(String.raw`
    const pid = process.pid + 1;
    const marker = 'fixture-value';
    const name = 'AW_MARKER';
    const environment = Buffer.from(name + '=' + marker + '\0');
    function row(id, exiting = false, startTime = id + 100) {
      const fields = Array(49).fill('0');
      fields[0] = exiting ? 'X' : 'S';
      fields[1] = exiting ? '0' : '1';
      fields[2] = fields[3] = exiting ? '-1' : String(id);
      fields[17] = exiting ? '0' : '1';
      fields[19] = String(startTime);
      fields[47] = '100';
      fields[48] = String(100 + environment.length);
      return id + ' (fixture) ' + fields.join(' ');
    }
    const exiting = row(pid, true);
    const live = row(pid);
    const readFile = fs.readFile;
    const cases = [
      { caseName: 'gone', first: exiting, next: [null], present: false },
      { caseName: 'same identity', first: exiting, next: [live], present: true, marked: true },
      { caseName: 'gone after environment', first: live, next: [exiting, null], present: true, unreadable: true },
      { caseName: 'unresolved', first: exiting, next: [], code: 'PROCFS_INVALID_IDENTITY' },
      { caseName: 'changed identity', first: exiting, next: [row(pid, false, pid + 101)], code: 'PROCFS_IDENTITY_CHANGED' },
      { caseName: 'already rechecked', first: exiting, next: [live, exiting, null], code: 'PROCFS_INVALID_IDENTITY' },
      { caseName: 'empty stat', first: '', next: [], code: 'PROCFS_INVALID_IDENTITY' },
      { caseName: 'partial placeholders', first: exiting.replace(' 0 -1 -1 ', ' 0 -1 0 '), next: [], code: 'PROCFS_INVALID_IDENTITY' },
    ];
    for (const [index, scenario] of cases.entries()) {
      const proc = 'proc-' + index;
      const stat = proc + '/' + pid + '/stat';
      for (const id of [process.pid, pid]) {
        const directory = proc + '/' + id;
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(directory + '/environ', environment);
        await fs.writeFile(directory + '/stat', id === pid ? scenario.first : row(id));
      }
      fs.readFile = async (path, ...args) => {
        const data = await readFile(path, ...args);
        if (typeof data === 'string' && data.startsWith(pid + ' (fixture) ')) {
          const next = scenario.next.shift();
          if (next === null) await fs.unlink(stat);
          else if (next !== undefined) await fs.writeFile(stat, next);
        }
        return data;
      };
      syncBuiltinESMExports();
      const scan = readLinuxMarkerScan(name, new Set([marker]), AbortSignal.timeout(1_000), 16_384, proc);
      if (scenario.code) {
        await assert.rejects(scan, { code: scenario.code }, scenario.caseName);
      } else {
        const evidence = await scan;
        assert.equal(evidence.table.has(pid), scenario.present, scenario.caseName);
        assert.equal(evidence.unreadablePids.has(pid), scenario.unreadable === true, scenario.caseName);
        assert.deepEqual(evidence.markerPidsByValue.get(marker), new Set(scenario.marked
          ? [process.pid, pid] : [process.pid]), scenario.caseName);
      }
    }
  `);
});

// Cancellation after the environment opens must reject the scan without crashing Node.
it.skipIf(process.platform !== 'linux')('survives cancellation while opening a Linux process environment', async () => {
  await runIsolatedLinuxMarkerScan(`
      const row = 'proc/' + process.pid;
      const fields = Array(49).fill('0');
      fields[0] = 'S'; fields[19] = '100';
      await fs.mkdir(row, { recursive: true });
      await fs.writeFile(row + '/stat', process.pid + ' (fixture) ' + fields.join(' '));
      await fs.writeFile(row + '/environ', '');

      const controller = new AbortController();
      const open = fs.open;
      let environment;
      fs.open = async (path, ...args) => {
        const file = await open(path, ...args);
        if (path.endsWith('/environ')) {
          environment = file;
          controller.abort();
        }
        return file;
      };
      syncBuiltinESMExports();

      await assert.rejects(readLinuxMarkerScan('AW_MARKER', new Set(['fixture']),
        controller.signal, 1_024, 'proc'), { name: 'AbortError' });
      assert.equal(environment?.fd, -1);
  `);
});

// Cleanup may succeed with unreaped zombies only if every member has exited.
it.skipIf(process.platform !== 'linux')('requires complete member and thread evidence to confirm a Linux zombie group', async () => {
  const pgid = 101;
  const zombie = { ppid: 1, pgid, state: 'Z', startTime: '1000', threadCount: 1 };
  const table = new Map([[102, zombie], [201, { ...zombie, pgid: 201, state: 'S' }]]);
  const verifyVisibility = vi.spyOn(linux, 'assertLinuxProcfsProcessVisibility').mockResolvedValue();
  const read = vi.spyOn(linux, 'readLinuxMarkerScan').mockResolvedValue({
    table, markerPidsByValue: new Map(), unreadablePids: new Set(),
  });
  const verifyGroup = () => hasOnlyZombieLinuxProcessGroupMembers(pgid, 1_000);
  try {
    await expect(verifyGroup()).resolves.toBe(true);
    table.set(103, { ...zombie, state: 'S' });
    await expect(verifyGroup()).resolves.toBe(false);
    table.set(103, { ...zombie, threadCount: 2 });
    await expect(verifyGroup()).resolves.toBe(false);
    table.delete(103);
    verifyVisibility.mockRejectedValueOnce(new Error('Process visibility unavailable.'));
    await expect(verifyGroup()).resolves.toBe(false);
    table.delete(102);
    await expect(verifyGroup()).resolves.toBe(false);
  } finally {
    verifyVisibility.mockRestore();
    read.mockRestore();
  }
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

it.skipIf(process.platform !== 'linux').each([
  'detached-unreadable', 'detached-unmarked', 'reused-group-member', 'reused-detached-unreadable',
] as const)(
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
      const olderMarkedChild = scenario === 'reused-detached-unreadable' && phase === 0;
      if (olderMarkedChild) {
        table.set(child, { ppid: root, pgid: root, state: 'S', startTime: '25' });
        marked.add(child);
      } else if (sameGroup || phase > 0) {
        const replaced = sameGroup && phase >= 2;
        table.set(child, { ppid: rootAlive && !replaced ? root : 1, pgid: sameGroup ? root : child,
          state: 'S', startTime: replaced ? '40' : '30' });
        if (phase < 2) marked.add(child);
        else if (scenario !== 'detached-unmarked' && !sameGroup) unreadable.add(child);
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
        : scenario === 'detached-unmarked' ? 'known-process-marker-missing' : 'process-marker-unreadable';
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

type LeasedRow = [pid: number, tick: string, group: number, marker: boolean | null, state?: string, ppid?: number];
type ReadLeasedRows = (query: 'identity' | 'marker') => LeasedRow[] | Promise<LeasedRow[]>;

async function leasedLinuxFixture(knownChild = false, initialObservation?: ReadLeasedRows) {
  const [root, child, sentinel] = [101, 102, 103];
  const markerName = 'AW_LEASE_FIXTURE';
  const kill = vi.fn<(pid: number, signal: NodeJS.Signals) => void>();
  const confirmation = vi.fn();
  const dependencies: ProcessTreeDependencies = {
    linuxProcessInspection: 'procfs', enforceProcessMarker: true, markerEnvironmentVariable: markerName,
    kill, onLinuxMarkerIdentityConfirmation: confirmation,
    createSentinel: async () => ({ pid: sentinel, stop: async () => {} }),
  };
  let marker = '';
  let includeSentinel = true;
  let rows: ReadLeasedRows = () => knownChild
    ? [[root, '10', root, true], [child, '20', child, true]] : [[root, '10', root, true]];
  const read = vi.spyOn(linux, 'readLinuxMarkerScan').mockImplementation(async (name, markers) => {
    if (markers.size) {
      expect(name).toBe(markerName);
      marker = [...markers][0];
    }
    const current = await rows(markers.size ? 'marker' : 'identity');
    if (includeSentinel) current.push([sentinel, '5', sentinel, true]);
    return {
      table: new Map(current.map(([pid, startTime, pgid, , state = 'S', ppid = 1]) => [pid, { ppid, pgid, startTime, state }])),
      markerPidsByValue: new Map([[marker, new Set(current.filter(row => row[3] === true).map(row => row[0]))]]),
      unreadablePids: new Set(current.filter(row => row[3] === null).map(row => row[0])),
    };
  });
  const lease = await acquireProcessTreeInspectionLease(dependencies);
  if (initialObservation) rows = initialObservation;
  const observation = observeProcessTree(root, lease.marker, dependencies, lease);
  await vi.advanceTimersByTimeAsync(0);
  return { root, child, kill, confirmation, observation,
    sample: (readRows: typeof rows) => { rows = readRows; },
    loseSentinel: () => { includeSentinel = false; },
    terminate: (requireDescendantsExitedBeforeCompletion = false) => terminateProcessTree(root, () => {}, dependencies, {
      observation, requireConfirmedCleanup: true, requireDescendantsExitedBeforeCompletion,
    }),
    close: async () => { observation.dispose(); read.mockRestore(); await lease.release(); },
  };
}

// Independent identity and marker queries can finish in either order. Cleanup
// must wait for both and retain the marker error even when its own scan succeeds.
it.skipIf(process.platform !== 'linux').each(['marker', 'identity'] as const)(
  'retains the first procfs marker query failure when %s returns first', async first => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const f = await leasedLinuxFixture(false, async query => {
      await new Promise(resolve => setTimeout(resolve, first === query ? 5 : 30));
      if (query === 'marker') throw Object.assign(new Error('private query failure'), { code: 'EIO' });
      return [[101, '10', 101, true]];
    });
    try {
      const listener = vi.fn();
      f.observation.onFailure(listener);
      await vi.advanceTimersByTimeAsync(5);
      expect(listener).toHaveBeenCalledTimes(first === 'marker' ? 1 : 0);
      f.sample(() => []);
      const result = f.terminate().then(() => undefined, (error: Error) => error);
      await vi.advanceTimersByTimeAsync(25);
      expect((await result)?.message).toContain('code=EIO');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(f.observation.diagnostics).toMatchObject([
        {
          stage: 'observation', reason: 'marker-lookup-failed', markerLookupSucceeded: false,
          snapshotStartedAt: startedAt, snapshotDeadline: startedAt + 2_000, markerLookupAttempts: 1,
          lookupFailure: { reason: 'callback-error', code: 'EIO' },
          queries: expect.arrayContaining([expect.objectContaining({ kind: 'marker', completion: 'callback' })]),
          sentinel: { present: null, identityMatches: null, markerMatches: null },
          processes: [{ pid: f.root, present: null, markerMatches: null }],
        },
        { stage: 'termination-start', markerLookupSucceeded: true },
      ]);
      expect(f.kill).not.toHaveBeenCalled();
    } finally { await f.close(); vi.useRealTimers(); }
  },
);

it.skipIf(process.platform !== 'linux')('ignores foreign group members after the Linux group leader PID is reused', async () => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture();
  try {
    f.sample(() => [[f.root, '40', f.root, false], [104, '41', f.root, false], [105, '42', f.root, null]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.observation.diagnostics).toEqual([]);
    f.sample(() => [[104, '41', f.root, false], [105, '42', f.root, null]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.observation.diagnostics).toEqual([]);
    let markedAlive = true;
    f.sample(() => markedAlive ? [[f.child, '43', f.root, true]] : []);
    f.kill.mockImplementation(pid => { if (pid === f.child) markedAlive = false; });
    const cleanup = f.terminate();
    await vi.advanceTimersByTimeAsync(350);
    await expect(cleanup).resolves.toBeUndefined();
    expect(f.kill.mock.calls).toEqual([[f.child, 'SIGTERM']]);
  } finally { await f.close(); vi.useRealTimers(); }
});

it.skipIf(process.platform !== 'linux')('retains a negative marker from a short-lived descendant in a separate group', async () => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture(false, query => query === 'identity' ? [] : [
    [101, '10', 101, true], [102, '20', 102, false, 'S', 101],
  ]);
  try {
    f.sample(() => []);
    await expect(f.terminate()).rejects.toThrow('lost its process marker');
    expect(f.observation.diagnostics[0]).toMatchObject({
      stage: 'observation', affectedPids: [f.child], processes: expect.arrayContaining([
        expect.objectContaining({ pid: f.child, ppid: f.root, pgid: f.child, markerMatches: false }),
      ]),
    });
    expect(f.kill).not.toHaveBeenCalled();
  } finally { await f.close(); vi.useRealTimers(); }
});

it.skipIf(process.platform !== 'linux').each([
  ['observation', false], ['observation', null], ['termination-start', false], ['termination-start', null],
] as const)('checks a detached child first seen on the second %s table with marker %s', async (stage, marker) => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture();
  try {
    let scans = 0;
    f.sample(query => {
      const detached: LeasedRow = [f.child, '20', f.child, marker, 'S', f.root];
      if (query === 'identity') return scans === 2 ? [detached] : [];
      const root: LeasedRow = [f.root, '10', f.root, true];
      switch (++scans) {
        case 1: return [root, [104, '30', f.root, null]];
        case 2: return [root, detached];
        default: return [];
      }
    });
    if (stage === 'observation') await vi.advanceTimersByTimeAsync(1_000);
    const cleanup = f.terminate(true).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(350);
    expect(await cleanup).toBeInstanceOf(Error);
    expect(f.observation.diagnostics[0]).toMatchObject({
      stage, reason: marker === false ? 'known-process-marker-missing' : 'process-marker-unreadable',
      affectedPids: [f.child], processes: expect.arrayContaining([
        expect.objectContaining({ pid: f.child, ppid: f.root, pgid: f.child, markerMatches: marker }),
      ]),
    });
    expect(f.kill.mock.calls.every(([pid]) => Math.abs(pid) === f.root)).toBe(true);
    if (stage === 'observation' && marker === null) {
      expect(f.confirmation).toHaveBeenCalledWith(expect.objectContaining({ pid: f.child, result: 'present' }));
    } else expect(f.confirmation).not.toHaveBeenCalled();
  } finally { await f.close(); vi.useRealTimers(); }
});

it.skipIf(process.platform !== 'linux').each([true, false])('checks completion before replacing an unreadable table (marked descendant: %s)', async marked => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture();
  try {
    let scans = 0;
    f.sample(() => {
      if (++scans !== 1) return [];
      const rows: LeasedRow[] = [[104, '30', f.root, null]];
      if (marked) rows.push([f.child, '20', f.child, true]);
      return rows;
    });
    if (marked) {
      await expect(f.terminate(true)).rejects.toThrow('descendants must exit before completion');
      expect(f.observation.diagnostics[0]).toMatchObject({
        stage: 'termination-start', reason: 'live-descendants-before-completion', affectedPids: [f.child],
        processes: expect.arrayContaining([expect.objectContaining({ pid: f.child, present: true, markerMatches: true })]),
      });
    } else {
      await expect(f.terminate(true)).resolves.toBeUndefined();
      expect(f.observation.diagnostics).toEqual([]);
    }
    expect(f.kill).not.toHaveBeenCalled();
  } finally { await f.close(); vi.useRealTimers(); }
});

it.skipIf(process.platform !== 'linux')('shares the termination deadline with procfs signal revalidation', async () => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture(false, async query => {
    if (query === 'marker') await new Promise(resolve => setTimeout(resolve, 1_900));
    return [];
  });
  try {
    let scans = 0;
    f.sample(() => ++scans === 1 ? [[f.root, '10', f.root, true]] : new Promise(() => {}));
    const result = f.terminate().catch((error: Error) => error);
    const deadline = Date.now() + 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await result).toBeInstanceOf(Error);
    expect(f.observation.diagnostics[0]).toMatchObject({
      stage: 'termination-start', snapshotDeadline: deadline,
      lookupFailure: { reason: 'deadline-exceeded' }, queries: [expect.objectContaining({ deadline })],
    });
    expect(f.kill).not.toHaveBeenCalled();
  } finally { await f.close(); vi.useRealTimers(); }
});

it.skipIf(process.platform !== 'linux')('revalidates group and individual signals after an overlapping observation', async () => {
  vi.useFakeTimers();
  let resolveObservation!: (rows: LeasedRow[]) => void;
  const f = await leasedLinuxFixture(false, query => query === 'identity' ? [] :
    new Promise(resolve => { resolveObservation = resolve; }));
  try {
    const sibling: LeasedRow = [104, '30', f.root, true];
    let scans = 0;
    let siblingAlive = true;
    f.sample(() => {
      const rows: LeasedRow[] = [[f.child, '20', f.root, ++scans === 1]];
      if (siblingAlive) rows.push(sibling);
      return rows;
    });
    f.kill.mockImplementation(pid => { if (pid === sibling[0]) siblingAlive = false; });
    const result = f.terminate().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toBe(1);
    expect(f.kill).not.toHaveBeenCalled();
    resolveObservation([[f.root, '10', f.root, true], [f.child, '20', f.root, null]]);
    await vi.advanceTimersByTimeAsync(350);
    expect(await result).toBeInstanceOf(Error);
    expect(f.kill.mock.calls).toEqual([[sibling[0], 'SIGTERM']]);
  } finally { await f.close(); vi.useRealTimers(); }
});

// A live candidate can change while its marker is read. Its original identity
// and the sentinel decide which evidence may exempt this one observation.
it.skipIf(process.platform !== 'linux').each([
  'exit', 'zombie', 'initial-negative', 'marker-negative', 'still-unreadable', 'post-identity-absent', 'sentinel-lost',
  'new-unreadable', 'new-exited', 'replacement-unreadable',
] as const)('checks the leased Linux candidate when the confirmation reports %s', async outcome => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture();
  try {
    let markerQueries = 0;
    f.sample(query => {
      const root: LeasedRow = [f.root, '10', f.root, true];
      const child: LeasedRow = [f.child, '20', f.root, null];
      if (query === 'marker') markerQueries++;
      if (markerQueries < 2) {
        return outcome === 'initial-negative' ? [root, child, [104, '30', f.root, false]] : [root, child];
      }
      if (outcome === 'initial-negative') return [root];
      if (outcome === 'exit' || (outcome === 'post-identity-absent' && query === 'identity')) return [root];
      if (outcome === 'sentinel-lost') { f.loseSentinel(); return [root]; }
      if (outcome === 'new-exited' && query === 'identity') return [root];
      if (outcome === 'new-unreadable' || outcome === 'new-exited') return [root, [104, '30', f.root, null]];
      if (outcome === 'replacement-unreadable') return query === 'marker' ? [root, [f.child, '31', f.root, null]] : [root];
      if (outcome === 'marker-negative') child[3] = false;
      if (outcome === 'zombie') child[4] = 'Z';
      return [root, child];
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(markerQueries).toBe(2);
    const reasons = f.observation.diagnostics.map(d => d.reason);
    if (outcome === 'initial-negative' || outcome === 'marker-negative') expect(reasons).toEqual(['initial-group-marker-missing']);
    else if (outcome === 'sentinel-lost') expect(reasons).toContain('inspection-lease-invalid');
    else if (['still-unreadable', 'new-unreadable', 'replacement-unreadable'].includes(outcome)) {
      expect(reasons).toEqual(['process-marker-unreadable']);
    }
    else expect(reasons).toEqual([]);
    if (outcome === 'post-identity-absent' || outcome === 'still-unreadable') {
      expect(f.confirmation.mock.calls.map(([event]) => event.result)).toEqual([outcome === 'still-unreadable' ? 'present' : 'absent']);
    } else if (outcome === 'new-unreadable' || outcome === 'new-exited') {
      expect(f.confirmation.mock.calls.map(([event]) => [event.pid, event.startTime, event.result])).toEqual([
        [104, '30', outcome === 'new-unreadable' ? 'present' : 'absent'],
      ]);
    } else expect(f.confirmation).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  } finally { await f.close(); vi.useRealTimers(); }
});

// Rechecking tick 20 cannot authorize tick 30, even with a valid marker.
// The independent escalation stage can discover and clean that newer lifetime.
it.skipIf(process.platform !== 'linux').each([false, true])('claims a replacement only on a fresh Linux cleanup scan (previously known: %s)', async known => {
  vi.useFakeTimers();
  const f = await leasedLinuxFixture(known);
  try {
    let scans = 0;
    let alive = true;
    f.sample(query => {
      expect(query).toBe('marker');
      scans++;
      if (!alive) return [];
      if (scans === 1) return [[f.child, '20', f.root, null]];
      if (scans === 2) return [
        [f.root, '10', f.root, true], [f.child, '30', f.child, true, 'S', f.root],
        [105, '35', 105, false, 'S', f.child],
      ];
      return [[f.child, '30', f.child, true]];
    });
    f.kill.mockImplementation((pid, signal) => {
      if (Math.abs(pid) === f.root) return;
      expect(pid).toBe(f.child);
      expect(signal).toBe('SIGKILL');
      alive = false;
    });
    const cleanup = f.terminate();
    await vi.advanceTimersByTimeAsync(0);
    expect(scans).toBe(2);
    expect(f.kill.mock.calls.map(([pid]) => Math.abs(pid))).toEqual([f.root, f.root]);
    await vi.advanceTimersByTimeAsync(350);
    await cleanup;
    expect(scans).toBe(4);
    expect(f.kill.mock.calls.at(-1)).toEqual([f.child, 'SIGKILL']);
  } finally { await f.close(); vi.useRealTimers(); }
});
