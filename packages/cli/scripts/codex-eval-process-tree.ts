import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_KILL_CONFIRMATION_MS = 1_000;
const PROCESS_TREE_POLL_MS = 25;

interface PosixProcessEntry {
  ppid: number;
  state: string;
  startTime: string;
}

interface PosixProcessIdentity {
  pid: number;
  startTime: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readPosixProcessTable(): Promise<Map<number, PosixProcessEntry>> {
  const result = await execFileAsync('/bin/ps', ['-Ao', 'pid=,ppid=,state=,lstart='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: PROCESS_TERMINATION_GRACE_MS,
  });
  const table = new Map<number, PosixProcessEntry>();
  for (const line of result.stdout.split('\n')) {
    const [pidText, ppidText, state, ...startTimeParts] = line.trim().split(/\s+/u);
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const startTime = startTimeParts.join(' ');
    if (Number.isInteger(pid) && Number.isInteger(ppid) && state && startTime) {
      table.set(pid, { ppid, state, startTime });
    }
  }
  return table;
}

async function refreshKnownDescendants(
  root: PosixProcessIdentity,
  knownDescendants: Map<number, PosixProcessIdentity>,
): Promise<Map<number, PosixProcessEntry>> {
  const table = await readPosixProcessTable();
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, entry] of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(pid);
    childrenByParent.set(entry.ppid, children);
  }
  const roots = [root, ...knownDescendants.values()].filter((identity) =>
    table.get(identity.pid)?.startTime === identity.startTime
  );
  const queue = roots.map((identity) => identity.pid);
  const visited = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const childPid of childrenByParent.get(parent) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      knownDescendants.set(childPid, {
        pid: childPid,
        startTime: table.get(childPid)!.startTime,
      });
      queue.push(childPid);
    }
  }
  return table;
}

function processIsRunning(
  table: Map<number, PosixProcessEntry>,
  identity: PosixProcessIdentity,
): boolean {
  const entry = table.get(identity.pid);
  return entry !== undefined &&
    entry.startTime === identity.startTime &&
    !entry.state.startsWith('Z');
}

function signalPosixPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function signalKnownPosixTree(
  root: PosixProcessIdentity,
  knownDescendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: Map<number, PosixProcessEntry>,
  signal: NodeJS.Signals,
): void {
  for (const identity of [...knownDescendants.values()].reverse()) {
    if (processIsRunning(table, identity)) signalPosixPid(identity.pid, signal);
  }
  if (processIsRunning(table, root)) signalPosixPid(root.pid, signal);
}

function signalPosixProcessGroup(rootPid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-rootPid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

function posixProcessGroupIsRunning(rootPid: number): boolean {
  try {
    process.kill(-rootPid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'EPERM';
  }
}

export async function terminatePosixProcessTree(rootPid: number): Promise<string[]> {
  const diagnostics: string[] = [];
  const knownDescendants = new Map<number, PosixProcessIdentity>();
  let table: Map<number, PosixProcessEntry> | null = null;
  let root: PosixProcessIdentity | null = null;
  try {
    table = await readPosixProcessTable();
    const rootEntry = table.get(rootPid);
    if (rootEntry) {
      root = { pid: rootPid, startTime: rootEntry.startTime };
      table = await refreshKnownDescendants(root, knownDescendants);
      signalKnownPosixTree(root, knownDescendants, table, 'SIGTERM');
    }
  } catch (error) {
    diagnostics.push(
      `Could not inspect the POSIX process tree; used process-group fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    table = null;
  }
  signalPosixProcessGroup(rootPid, 'SIGTERM');

  const graceDeadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;
  while (Date.now() < graceDeadline) {
    await delay(PROCESS_TREE_POLL_MS);
    if (root && table) {
      try {
        table = await refreshKnownDescendants(root, knownDescendants);
        signalKnownPosixTree(root, knownDescendants, table, 'SIGTERM');
      } catch (error) {
        diagnostics.push(
          `Could not refresh the POSIX process tree; continued with process-group fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        table = null;
      }
    }
    signalPosixProcessGroup(rootPid, 'SIGTERM');
    const knownRunning = root && table
      ? [root, ...knownDescendants.values()].some((identity) =>
          processIsRunning(table!, identity)
        )
      : false;
    if (!knownRunning && !posixProcessGroupIsRunning(rootPid)) return diagnostics;
  }

  const killDeadline = Date.now() + PROCESS_KILL_CONFIRMATION_MS;
  while (Date.now() < killDeadline) {
    if (root && table) {
      try {
        table = await refreshKnownDescendants(root, knownDescendants);
        signalKnownPosixTree(root, knownDescendants, table, 'SIGKILL');
      } catch (error) {
        diagnostics.push(
          `Could not verify the POSIX descendant set after SIGKILL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        table = null;
      }
    }
    signalPosixProcessGroup(rootPid, 'SIGKILL');
    const knownRunning = root && table
      ? [root, ...knownDescendants.values()].some((identity) =>
          processIsRunning(table!, identity)
        )
      : false;
    if (!knownRunning && !posixProcessGroupIsRunning(rootPid)) return diagnostics;
    await delay(PROCESS_TREE_POLL_MS);
  }
  diagnostics.push(
    `Could not confirm process-tree termination within ${PROCESS_KILL_CONFIRMATION_MS}ms after SIGKILL; ` +
    `process group ${rootPid} may still be running.`,
  );
  return diagnostics;
}

function observeChildClose(child: ChildProcess): {
  wait(timeoutMs: number): Promise<boolean>;
  dispose(): void;
} {
  let closed = Boolean(
    (child.exitCode !== null || child.signalCode !== null) &&
    child.stdout?.destroyed &&
    child.stderr?.destroyed,
  );
  let resolveClose: (() => void) | undefined;
  const closePromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });
  const onClose = (): void => {
    closed = true;
    resolveClose?.();
  };
  child.once('close', onClose);
  return {
    wait: async (timeoutMs: number) => {
      if (closed) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const result = await Promise.race([closePromise.then(() => true as const), timedOut]);
      if (timer) clearTimeout(timer);
      return result;
    },
    dispose: () => child.off('close', onClose),
  };
}

export function releaseChildProcessHandles(child: ChildProcess): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

export async function terminateWindowsProcessTree(
  child: ChildProcess,
  options: {
    closeTimeoutMs?: number;
    runTaskkill?: (pid: number) => Promise<void>;
  } = {},
): Promise<string[]> {
  if (child.pid === undefined) return [];
  const closeTimeoutMs = options.closeTimeoutMs ?? PROCESS_KILL_CONFIRMATION_MS;
  const closeObserver = observeChildClose(child);
  const runTaskkill = options.runTaskkill ?? (async (pid: number) => {
    await execFileAsync(
      'taskkill.exe',
      ['/pid', String(pid), '/t', '/f'],
      {
        encoding: 'utf8',
        timeout: PROCESS_TERMINATION_GRACE_MS * 5,
        windowsHide: true,
      },
    );
  });
  try {
    await runTaskkill(child.pid);
    if (await closeObserver.wait(closeTimeoutMs)) return [];
    releaseChildProcessHandles(child);
    return [
      `Could not confirm Windows process-tree termination within ${closeTimeoutMs}ms after taskkill; ` +
      `process ${child.pid} may still be running.`,
    ];
  } catch (error) {
    const diagnostics = [
      `Could not verify Windows process-tree termination after taskkill failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ];
    const usedSigkillFallback = child.exitCode === null && child.signalCode === null;
    if (usedSigkillFallback) {
      try {
        child.kill('SIGKILL');
      } catch (killError) {
        diagnostics.push(
          `Windows SIGKILL fallback failed: ${
            killError instanceof Error ? killError.message : String(killError)
          }`,
        );
      }
    }
    if (!(await closeObserver.wait(closeTimeoutMs))) {
      diagnostics.push(
        `Could not confirm Windows process-tree termination within ${closeTimeoutMs}ms ` +
        `after taskkill failure${usedSigkillFallback ? ' and SIGKILL fallback' : ''}; ` +
        `process ${child.pid} may still be running.`,
      );
      releaseChildProcessHandles(child);
    }
    return diagnostics;
  } finally {
    closeObserver.dispose();
  }
}

export async function terminateChildProcessTree(child: ChildProcess): Promise<string[]> {
  if (child.pid === undefined) return [];
  if (process.platform === 'win32') return terminateWindowsProcessTree(child);
  return terminatePosixProcessTree(child.pid);
}

export async function assertProcessTreeInspectionAvailable(): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await readPosixProcessTable();
  } catch (error) {
    throw new Error(
      `Cannot start a Codex eval process because POSIX process-tree inspection is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
