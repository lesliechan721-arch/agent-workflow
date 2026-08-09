import { execFile } from 'node:child_process';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type PosixSignal = KillSignal | 'SIGSTOP';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_LOOKUP_TIMEOUT_MS = 500;

interface PosixProcessEntry {
  ppid: number;
  state: string;
  startTime: string;
}

interface PosixProcessIdentity {
  pid: number;
  startTime: string;
}

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: PosixSignal) => void;
  execFile?: (
    command: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean },
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown;
}

const defaultExecFile: NonNullable<ProcessTreeDependencies['execFile']> = (
  command,
  args,
  options,
  callback,
) => execFile(command, args, options, (error, stdout) => callback(error, stdout));

function runTaskkill(
  pid: number,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(false), PROCESS_TREE_COMMAND_TIMEOUT_MS);
    timeout.unref();

    try {
      execFileImpl(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { timeout: PROCESS_TREE_COMMAND_TIMEOUT_MS, windowsHide: true },
        (error) => finish(!error),
      );
    } catch {
      finish(false);
    }
  });
}

function readPosixProcessTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs: number = POSIX_PROCESS_LOOKUP_TIMEOUT_MS,
): Promise<Map<number, PosixProcessEntry> | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Map<number, PosixProcessEntry> | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    timeout.unref();

    try {
      execFileImpl(
        'ps',
        ['-A', '-o', 'pid=,ppid=,state=,lstart='],
        { timeout: timeoutMs, windowsHide: true },
        (error, stdout) => {
          if (error) {
            finish(null);
            return;
          }

          const table = new Map<number, PosixProcessEntry>();
          for (const line of stdout.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
            if (!match) {
              continue;
            }
            const processId = Number(match[1]);
            const parentProcessId = Number(match[2]);
            table.set(processId, {
              ppid: parentProcessId,
              state: match[3],
              startTime: match[4],
            });
          }
          finish(table);
        },
      );
    } catch {
      finish(null);
    }
  });
}

function refreshDescendants(
  root: PosixProcessIdentity,
  knownDescendants: Map<number, PosixProcessIdentity>,
  table: ReadonlyMap<number, PosixProcessEntry>,
): void {
  const childrenByParent = new Map<number, number[]>();
  for (const [processId, entry] of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(processId);
    childrenByParent.set(entry.ppid, children);
  }
  const roots = [root, ...knownDescendants.values()].filter((identity) =>
    table.get(identity.pid)?.startTime === identity.startTime
  );
  const pending = roots.map((identity) => identity.pid);
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const descendantPid of childrenByParent.get(parent) ?? []) {
      if (visited.has(descendantPid)) continue;
      visited.add(descendantPid);
      const entry = table.get(descendantPid)!;
      const knownIdentity = knownDescendants.get(descendantPid);
      if (knownIdentity && knownIdentity.startTime !== entry.startTime) continue;
      knownDescendants.set(descendantPid, {
        pid: descendantPid,
        startTime: entry.startTime,
      });
      pending.push(descendantPid);
    }
  }
}

function signalKnownDescendants(
  descendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: ReadonlyMap<number, PosixProcessEntry>,
  signal: PosixSignal,
  kill: NonNullable<ProcessTreeDependencies['kill']>,
): void {
  for (const identity of [...descendants.values()].reverse()) {
    if (table.get(identity.pid)?.startTime !== identity.startTime) continue;
    try {
      kill(identity.pid, signal);
    } catch {
      // A descendant can exit between process discovery and termination.
    }
  }
}

function knownProcessTreeIsFrozen(
  root: PosixProcessIdentity,
  descendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: ReadonlyMap<number, PosixProcessEntry>,
): boolean {
  return [root, ...descendants.values()].every((identity) => {
    const entry = table.get(identity.pid);
    return entry === undefined ||
      entry.startTime !== identity.startTime ||
      entry.state.startsWith('T') ||
      entry.state.startsWith('Z');
  });
}

export async function terminateProcessTree(
  pid: number,
  killDirectChild: (signal: KillSignal) => void,
  dependencies: ProcessTreeDependencies = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;

  if (platform === 'win32') {
    const execFileImpl = dependencies.execFile ?? defaultExecFile;
    if (!(await runTaskkill(pid, execFileImpl))) {
      try {
        killDirectChild('SIGKILL');
      } catch {
        // The direct child can exit before the fallback runs.
      }
    }
    return;
  }

  const kill = dependencies.kill ?? process.kill.bind(process);
  try {
    kill(pid, 'SIGSTOP');
  } catch {
    // The direct child can exit before it is frozen.
  }

  const execFileImpl = dependencies.execFile ?? defaultExecFile;
  const lookupDeadline = Date.now() + PROCESS_TREE_COMMAND_TIMEOUT_MS;
  const firstTable = await readPosixProcessTable(execFileImpl);
  const rootEntry = firstTable?.get(pid);
  if (firstTable && rootEntry) {
    const root = { pid, startTime: rootEntry.startTime };
    const descendants = new Map<number, PosixProcessIdentity>();
    refreshDescendants(root, descendants, firstTable);
    let latestTable = firstTable;
    signalKnownDescendants(descendants, latestTable, 'SIGSTOP', kill);
    while (Date.now() < lookupDeadline) {
      const remainingMs = lookupDeadline - Date.now();
      if (remainingMs <= 0) break;
      const nextTable = await readPosixProcessTable(
        execFileImpl,
        Math.min(POSIX_PROCESS_LOOKUP_TIMEOUT_MS, remainingMs),
      );
      if (!nextTable) break;
      latestTable = nextTable;
      refreshDescendants(root, descendants, latestTable);
      signalKnownDescendants(descendants, latestTable, 'SIGSTOP', kill);
      if (knownProcessTreeIsFrozen(root, descendants, latestTable)) break;
    }
    signalKnownDescendants(descendants, latestTable, 'SIGKILL', kill);
  }

  try {
    killDirectChild('SIGKILL');
  } catch {
    // The direct child can exit before fallback termination runs.
  }
}
