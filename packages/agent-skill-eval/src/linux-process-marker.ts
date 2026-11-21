import { constants } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';

interface LinuxProcessEntry {
  ppid: number;
  pgid: number;
  state: string;
  startTime: string;
  threadCount?: number;
}

export interface LinuxMarkerScan {
  table: Map<number, LinuxProcessEntry>;
  markerPidsByValue: Map<string, Set<number>>;
  unreadablePids: Set<number>;
}

function processGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}

function scanFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function assertSameStartTime(before: string, after: string): void {
  if (before !== after) {
    throw scanFailure('PROCFS_IDENTITY_CHANGED', 'Linux process identity changed during inspection.');
  }
}

export async function assertLinuxProcfsProcessVisibility(signal: AbortSignal): Promise<void> {
  const mountInfo = await readFile('/proc/self/mountinfo', { encoding: 'utf8', signal });
  const procMounts: string[] = [];
  for (const line of mountInfo.split('\n')) {
    const mountPoint = line.split(' ', 5)[4];
    if (mountPoint === '/proc') procMounts.push(line);
    if (/^\/proc\/[1-9]\d*(?:\/|$)/u.test(mountPoint ?? '')) {
      throw new Error('Linux procfs process entries are overmounted.');
    }
  }
  const [mount, filesystem] = procMounts[0]?.split(' - ') ?? [];
  const [type, , options] = filesystem?.split(' ') ?? [];
  // In particular, hidepid=invisible may silently omit a live group member.
  if (procMounts.length !== 1 || mount?.split(' ')[3] !== '/' || type !== 'proc' || !options ||
    options.split(',').some(option => option.startsWith('hidepid=') && option !== 'hidepid=0' && option !== 'hidepid=off')) {
    throw new Error('Linux procfs process visibility could not be confirmed.');
  }
  const status = await readFile('/proc/self/status', { encoding: 'utf8', signal });
  // A procfs mounted for an ancestor namespace lists an additional PID per level.
  if (/^NSpid:[ \t]+(\d+)$/mu.exec(status)?.[1] !== String(process.pid)) {
    throw new Error('Linux procfs does not describe the current PID namespace.');
  }
}

function readIdentity(text: string, pid: number) {
  // comm can contain spaces, newlines and parentheses. The remaining fields
  // begin with state (field 3); fields 20 and 22 are thread count and start tick.
  const end = text.lastIndexOf(') ');
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const threadCount = /^\d+$/u.test(fields[17] ?? '') ? Number(fields[17]) : undefined;
  // do_task_stat leaves these initial values when the task is reaped before
  // it can read the signal state. The recorded task state can be older.
  const reapedDuringRead = fields[1] === '0' && fields[2] === '-1' && fields[3] === '-1' && fields[17] === '0';
  if (end < 0 || !text.startsWith(`${pid} (`) || !/^[A-Za-z]$/u.test(fields[0])
    || !Number.isSafeInteger(ppid) || ppid < 0 || !Number.isSafeInteger(pgid) || (pgid < 0 && !reapedDuringRead)
    || ![19, 47, 48].every(index => /^\d+$/u.test(fields[index] ?? ''))) {
    throw scanFailure('PROCFS_INVALID_IDENTITY', 'Invalid Linux process identity.');
  }
  if (reapedDuringRead) return { startTime: fields[19] };
  return { entry: { ppid, pgid, state: fields[0], startTime: fields[19], threadCount },
    envStart: BigInt(fields[47]), envEnd: BigInt(fields[48]) };
}

export async function readLinuxMarkerScan(
  markerName: string, markers: ReadonlySet<string>, signal: AbortSignal, maxBytes: number, proc = '/proc',
  selectedPids?: ReadonlySet<number>,
): Promise<LinuxMarkerScan> {
  const result: LinuxMarkerScan = { table: new Map(), markerPidsByValue: new Map(), unreadablePids: new Set() };
  const assignments = [...markers].map(marker => ({ marker, bytes: Buffer.from(`${markerName}=${marker}`) }));
  const pids = selectedPids ? [...selectedPids]
    : (await readdir(proc)).filter(name => /^[1-9]\d*$/u.test(name)).map(Number);
  let bytes = 0;
  let next = 0;
  let failed = false;

  async function sample(pid: number): Promise<void> {
    const directory = await open(`${proc}/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      // The open proc directory pins this PID lookup. A reused numeric PID
      // cannot redirect the environment read into a replacement directory.
      const base = `/proc/self/fd/${directory.fd}`;
      const readStat = () => readFile(`${base}/stat`, { encoding: 'utf8', signal });
      let recheckedStat = false;
      const stat = async () => {
        const observed = readIdentity(await readStat(), pid);
        if (observed.entry) return observed;
        const identity = recheckedStat ? undefined : readIdentity(await readStat(), pid);
        recheckedStat = true;
        if (!identity?.entry) throw scanFailure('PROCFS_INVALID_IDENTITY', 'Linux process identity is still unavailable.');
        assertSameStartTime(observed.startTime, identity.entry.startTime);
        return identity;
      };
      const before = await stat();
      if (!markers.size || before.entry.state === 'Z') {
        result.table.set(pid, before.entry);
        return;
      }
      let environment: Buffer | undefined;
      try {
        const file = await open(`${base}/environ`, 'r');
        try {
          // A read stream created with an already-aborted signal can emit an
          // unhandled error before its async iterator observes the stream.
          signal.throwIfAborted();
          const chunks: Buffer[] = [];
          for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw scanFailure('PROCFS_BYTE_LIMIT', 'Linux process scan exceeded its byte limit.');
            chunks.push(chunk);
          }
          environment = Buffer.concat(chunks);
        } finally { await file.close(); }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (!processGone(error) && !['EACCES', 'EPERM', 'EIO', 'EFAULT'].includes(code ?? '')) throw error;
      }
      let after: typeof before;
      try { after = await stat(); }
      catch (error) {
        if (!processGone(error)) throw error;
        // This identity was seen live. Preserve an unavailable sample for the
        // ordinary confirmation gate; its disappearance is not marker evidence.
        result.table.set(pid, before.entry);
        result.unreadablePids.add(pid);
        return;
      }
      assertSameStartTime(before.entry.startTime, after.entry.startTime);
      result.table.set(pid, after.entry);
      if (after.entry.state === 'Z') return;
      // A live task may be in exec or losing its address space. A short read,
      // redacted extent or changed bounds cannot establish either marker result.
      if (environment === undefined || before.envStart === 0n || before.envStart !== after.envStart
        || before.envEnd !== after.envEnd || BigInt(environment.length) !== after.envEnd - after.envStart
        || (environment.length > 0 && environment.at(-1) !== 0)) {
        result.unreadablePids.add(pid);
        return;
      }
      for (let start = 0; start < environment.length;) {
        const end = environment.indexOf(0, start);
        const item = environment.subarray(start, end);
        const match = assignments.find(assignment => assignment.bytes.equals(item));
        if (match) {
          const matches = result.markerPidsByValue.get(match.marker) ?? new Set<number>();
          matches.add(pid);
          result.markerPidsByValue.set(match.marker, matches);
        }
        start = end + 1;
      }
    } finally { await directory.close(); }
  }

  async function worker(): Promise<void> {
    while (!failed && next < pids.length) {
      signal.throwIfAborted();
      const pid = pids[next++];
      try { await sample(pid); }
      catch (error) {
        if (!processGone(error)) { failed = true; throw error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, pids.length) }, worker));
  signal.throwIfAborted();
  if (!result.table.has(process.pid)) throw scanFailure('PROCFS_OBSERVER_MISSING', 'Linux observer identity missing.');
  return result;
}
