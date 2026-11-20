import { constants } from 'node:fs';
import { open, readFile, readdir } from 'node:fs/promises';

interface LinuxProcessEntry {
  ppid: number;
  pgid: number;
  state: string;
  startTime: string;
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

function readIdentity(text: string, pid: number) {
  // comm can contain spaces, newlines and parentheses. The remaining fields
  // begin with state (field 3); field 22 is the process start tick.
  const end = text.lastIndexOf(') ');
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  if (end < 0 || !text.startsWith(`${pid} (`) || !/^[A-Za-z]$/u.test(fields[0])
    || ![ppid, pgid].every(value => Number.isSafeInteger(value) && value >= 0)
    || ![19, 47, 48].every(index => /^\d+$/u.test(fields[index] ?? ''))) throw new Error('Invalid Linux process identity.');
  return { entry: { ppid, pgid, state: fields[0], startTime: fields[19] },
    envStart: BigInt(fields[47]), envEnd: BigInt(fields[48]) };
}

export async function readLinuxMarkerScan(
  markerName: string, markers: ReadonlySet<string>, signal: AbortSignal, maxBytes: number, proc = '/proc',
): Promise<LinuxMarkerScan> {
  const result: LinuxMarkerScan = { table: new Map(), markerPidsByValue: new Map(), unreadablePids: new Set() };
  const assignments = [...markers].map(marker => ({ marker, bytes: Buffer.from(`${markerName}=${marker}`) }));
  const pids = (await readdir(proc)).filter(name => /^[1-9]\d*$/u.test(name)).map(Number);
  let bytes = 0;
  let next = 0;
  let failed = false;

  async function sample(pid: number): Promise<void> {
    const directory = await open(`${proc}/${pid}`, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      // The open proc directory pins this PID lookup. A reused numeric PID
      // cannot redirect the environment read into a replacement directory.
      const base = `/proc/self/fd/${directory.fd}`;
      const stat = () => readFile(`${base}/stat`, { encoding: 'utf8', signal }).then(text => readIdentity(text, pid));
      const before = await stat();
      if (!markers.size || before.entry.state === 'Z') {
        result.table.set(pid, before.entry);
        return;
      }
      let environment: Buffer | undefined;
      try {
        const file = await open(`${base}/environ`, 'r');
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of file.createReadStream({ signal, autoClose: false })) {
            bytes += chunk.length;
            if (bytes > maxBytes) throw new Error('Linux process scan exceeded its byte limit.');
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
      if (after.entry.startTime !== before.entry.startTime) throw new Error('Linux process identity changed during inspection.');
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
  if (!result.table.has(process.pid)) throw new Error('Linux observer identity missing.');
  return result;
}
