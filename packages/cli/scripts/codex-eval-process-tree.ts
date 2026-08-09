import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_KILL_CONFIRMATION_MS = 1_000;
const PROCESS_FROZEN_TREE_KILL_CONFIRMATION_MS = 2_000;
const PROCESS_TREE_POLL_MS = 250;
const PROCESS_TOKEN_SCAN_TIMEOUT_MS = 3_000;
export const CODEX_EVAL_PROCESS_TREE_ID_ENV = 'AW_CODEX_EVAL_PROCESS_TREE_ID';
export const PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX =
  'Could not confirm process-tree cleanup';

interface PosixProcessEntry {
  ppid: number;
  state: string;
  startTime: string;
}

interface PosixProcessIdentity {
  pid: number;
  startTime: string;
}

interface PosixProcessTreeDependencies {
  readProcessTable?: (timeoutMs?: number) => Promise<Map<number, PosixProcessEntry>>;
  readTaggedProcessTable?: (
    treeId: string,
    timeoutMs?: number,
  ) => Promise<Map<number, PosixProcessEntry>>;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  treeId?: string;
  canUseProcessGroup?: () => boolean;
  allowRootIdentityDiscovery?: boolean;
}

export interface ChildProcessTreeMonitor {
  terminate(): Promise<string[]>;
}

export function processTreeCleanupIsUnconfirmed(diagnostics: readonly string[]): boolean {
  return diagnostics.some((entry) =>
    entry.startsWith(PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX) ||
    entry.startsWith('Could not confirm process-tree termination') ||
    entry.startsWith('Could not confirm Windows process-tree termination') ||
    entry.startsWith('Could not verify Windows process-tree termination')
  );
}

export function scrubProcessTreeId<T>(value: T, treeId: string): T {
  if (typeof value === 'string') {
    return value.replaceAll(treeId, '[process-tree-id]') as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubProcessTreeId(entry, treeId)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        scrubProcessTreeId(key, treeId),
        scrubProcessTreeId(entry, treeId),
      ]),
    ) as T;
  }
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readPosixProcessTable(
  timeoutMs: number = PROCESS_TERMINATION_GRACE_MS,
): Promise<Map<number, PosixProcessEntry>> {
  const result = await execFileAsync('/bin/ps', ['-Ao', 'pid=,ppid=,state=,lstart='], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
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

async function readTaggedPosixProcessTable(
  treeId: string,
  timeoutMs: number = PROCESS_TERMINATION_GRACE_MS,
): Promise<Map<number, PosixProcessEntry>> {
  const marker = `${CODEX_EVAL_PROCESS_TREE_ID_ENV}=${treeId}`;
  const table = new Map<number, PosixProcessEntry>();
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/bin/ps',
      ['eww', '-Ao', 'pid=,ppid=,state=,lstart=,command='],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let linePrefix = '';
    let markerTail = '';
    let lineHasMarker = false;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(table);
    };
    const finishLine = (): void => {
      if (lineHasMarker) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)/u.exec(
          linePrefix,
        );
        if (match) {
          const pid = Number(match[1]);
          const ppid = Number(match[2]);
          if (Number.isInteger(pid) && Number.isInteger(ppid)) {
            table.set(pid, {
              ppid,
              state: match[3],
              startTime: match[4].split(/\s+/u).join(' '),
            });
          }
        }
      }
      linePrefix = '';
      markerTail = '';
      lineHasMarker = false;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const segment of chunk.split(/(\n)/u)) {
        if (segment === '\n') {
          finishLine();
          continue;
        }
        if (linePrefix.length < 256) {
          linePrefix += segment.slice(0, 256 - linePrefix.length);
        }
        const markerCandidate = markerTail + segment;
        if (markerCandidate.includes(marker)) lineHasMarker = true;
        markerTail = markerCandidate.slice(-(marker.length - 1));
      }
    });
    child.once('error', finish);
    child.once('close', (exitCode, signal) => {
      finishLine();
      if (exitCode === 0) finish();
      else finish(new Error(
        `POSIX process-tree token scan failed: exit=${String(exitCode)}, signal=${String(signal)}.`,
      ));
    });
    const timeout = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // The ps subprocess can exit before the timeout fallback.
      }
      finish(new Error(
        `POSIX process-tree token scan exceeded ${timeoutMs}ms.`,
      ));
    }, timeoutMs);
    timeout.unref();
  });
}

function readTaggedPosixProcessTableWithTimeout(
  treeId: string,
  readTaggedProcessTable: NonNullable<PosixProcessTreeDependencies['readTaggedProcessTable']>,
  timeoutMs: number,
): Promise<Map<number, PosixProcessEntry>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: { table: Map<number, PosixProcessEntry> } | { error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('table' in result) resolve(result.table);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({
      error: new Error(
        `POSIX process-tree token scan exceeded ${timeoutMs}ms.`,
      ),
    }), timeoutMs);
    timer.unref();
    Promise.resolve().then(() => readTaggedProcessTable(treeId, timeoutMs)).then(
      (table) => finish({ table }),
      (error: unknown) => finish({ error }),
    );
  });
}

function readPosixProcessTableWithTimeout(
  readProcessTable: NonNullable<PosixProcessTreeDependencies['readProcessTable']>,
  timeoutMs: number,
  stage: 'initial' | 'lineage' | 'confirmation' | 'kill-confirmation',
): Promise<Map<number, PosixProcessEntry>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: { table: Map<number, PosixProcessEntry> } | { error: unknown },
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if ('table' in result) resolve(result.table);
      else reject(result.error);
    };
    const timer = setTimeout(() => finish({
      error: new Error(
        `POSIX process-tree ${stage} scan exceeded ${timeoutMs}ms.`,
      ),
    }), timeoutMs);
    timer.unref();
    Promise.resolve().then(() => readProcessTable(timeoutMs)).then(
      (table) => finish({ table }),
      (error: unknown) => finish({ error }),
    );
  });
}

function recordKnownDescendants(
  root: PosixProcessIdentity,
  knownDescendants: Map<number, PosixProcessIdentity>,
  table: Map<number, PosixProcessEntry>,
): void {
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
      const entry = table.get(childPid)!;
      const knownIdentity = knownDescendants.get(childPid);
      if (knownIdentity && knownIdentity.startTime !== entry.startTime) continue;
      knownDescendants.set(childPid, {
        pid: childPid,
        startTime: entry.startTime,
      });
      queue.push(childPid);
    }
  }
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

function signalPosixPid(
  pid: number,
  signal: NodeJS.Signals,
  kill: NonNullable<PosixProcessTreeDependencies['kill']> = process.kill.bind(process),
): boolean {
  try {
    kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return false;
  }
}

function signalKnownPosixTree(
  root: PosixProcessIdentity,
  knownDescendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: Map<number, PosixProcessEntry>,
  signal: NodeJS.Signals,
  kill: NonNullable<PosixProcessTreeDependencies['kill']> = process.kill.bind(process),
): void {
  for (const identity of [...knownDescendants.values()].reverse()) {
    if (processIsRunning(table, identity)) signalPosixPid(identity.pid, signal, kill);
  }
  if (processIsRunning(table, root)) signalPosixPid(root.pid, signal, kill);
}

function signalPosixProcessGroup(
  rootPid: number,
  signal: NodeJS.Signals,
  kill: NonNullable<PosixProcessTreeDependencies['kill']> = process.kill.bind(process),
): void {
  try {
    kill(-rootPid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') throw error;
  }
}

function posixProcessGroupIsRunning(
  rootPid: number,
  kill: NonNullable<PosixProcessTreeDependencies['kill']> = process.kill.bind(process),
): boolean {
  try {
    kill(-rootPid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH' && code !== 'EPERM';
  }
}

function knownPosixTreeIsFrozen(
  root: PosixProcessIdentity,
  knownDescendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: Map<number, PosixProcessEntry>,
): boolean {
  return [root, ...knownDescendants.values()].every((identity) => {
    const entry = table.get(identity.pid);
    return entry === undefined ||
      entry.startTime !== identity.startTime ||
      entry.state.startsWith('T') ||
      entry.state.startsWith('Z');
  });
}

function knownPosixTreeIsRunning(
  root: PosixProcessIdentity,
  knownDescendants: ReadonlyMap<number, PosixProcessIdentity>,
  table: Map<number, PosixProcessEntry>,
): boolean {
  return [root, ...knownDescendants.values()].some((identity) =>
    processIsRunning(table, identity)
  );
}

async function terminatePosixProcessGroupFallback(
  rootPid: number,
  kill: NonNullable<PosixProcessTreeDependencies['kill']>,
  allowed: boolean = true,
  deadline: number = Date.now() + PROCESS_KILL_CONFIRMATION_MS,
): Promise<boolean> {
  if (!allowed) return false;
  while (Date.now() < deadline) {
    signalPosixProcessGroup(rootPid, 'SIGKILL', kill);
    if (!posixProcessGroupIsRunning(rootPid, kill)) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
    }
  }
  return false;
}

async function terminateKnownPosixProcessTree(
  rootPid: number,
  dependencies: PosixProcessTreeDependencies = {},
  observedRoot?: PosixProcessIdentity,
  observedDescendants: ReadonlyMap<number, PosixProcessIdentity> = new Map(),
  observedTable?: Map<number, PosixProcessEntry>,
  preFrozen: boolean = false,
): Promise<string[]> {
  const readProcessTable = dependencies.readProcessTable ?? readPosixProcessTable;
  const kill = dependencies.kill ?? process.kill.bind(process);
  const diagnostics: string[] = [];
  const knownDescendants = new Map(observedDescendants);
  const canUseProcessGroup = (): boolean => dependencies.canUseProcessGroup?.() ?? true;
  const allowRootIdentityDiscovery = dependencies.allowRootIdentityDiscovery ?? true;
  let table: Map<number, PosixProcessEntry>;
  let root: PosixProcessIdentity;
  if (
    preFrozen &&
    observedTable &&
    (observedRoot || knownDescendants.size > 0)
  ) {
    root = observedRoot ?? { pid: rootPid, startTime: '<unobserved-root>' };
    table = observedTable;
    const killDeadline = Date.now() + PROCESS_FROZEN_TREE_KILL_CONFIRMATION_MS;
    signalKnownPosixTree(root, knownDescendants, table, 'SIGKILL', kill);
    while (Date.now() < killDeadline) {
      try {
        const remainingMs = killDeadline - Date.now();
        if (remainingMs <= 0) break;
        table = await readPosixProcessTableWithTimeout(
          readProcessTable,
          remainingMs,
          'kill-confirmation',
        );
        recordKnownDescendants(root, knownDescendants, table);
        signalKnownPosixTree(root, knownDescendants, table, 'SIGKILL', kill);
        if (!knownPosixTreeIsRunning(root, knownDescendants, table)) {
          return diagnostics;
        }
      } catch (error) {
        diagnostics.push(
          `Could not verify the pre-frozen POSIX process tree after SIGKILL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (await terminatePosixProcessGroupFallback(
          rootPid,
          kill,
          canUseProcessGroup(),
          killDeadline,
        )) return diagnostics;
        break;
      }
      const remainingMs = killDeadline - Date.now();
      if (remainingMs > 0) {
        await delay(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
      }
    }
    diagnostics.push(
      `Could not confirm process-tree termination within ` +
      `${PROCESS_FROZEN_TREE_KILL_CONFIRMATION_MS}ms after SIGKILL; process ${rootPid} ` +
      'or one of its descendants may still be running.',
    );
    return diagnostics;
  }
  const freezeDeadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;
  try {
    const initialRemainingMs = freezeDeadline - Date.now();
    if (initialRemainingMs <= 0) {
      throw new Error('POSIX process-tree initial scan deadline was exhausted.');
    }
    table = await readPosixProcessTableWithTimeout(
      readProcessTable,
      initialRemainingMs,
      'initial',
    );
    const rootEntry = table.get(rootPid);
    if (observedRoot) {
      root = observedRoot;
      recordKnownDescendants(root, knownDescendants, table);
    } else if (
      !allowRootIdentityDiscovery ||
      !rootEntry ||
      rootEntry.state.startsWith('Z')
    ) {
      if (knownDescendants.size > 0) {
        root = { pid: rootPid, startTime: '<unobserved-root>' };
      } else {
        const killDeadline = Date.now() + PROCESS_KILL_CONFIRMATION_MS;
        if (await terminatePosixProcessGroupFallback(
          rootPid,
          kill,
          canUseProcessGroup(),
          killDeadline,
        )) return diagnostics;
        diagnostics.push(
          `${PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX}: root identity and process-group ` +
          `ownership for ${rootPid} are unavailable.`,
        );
        return diagnostics;
      }
    } else {
      root = { pid: rootPid, startTime: rootEntry.startTime };
    }
    signalKnownPosixTree(root, knownDescendants, table, 'SIGSTOP', kill);
  } catch (error) {
    diagnostics.push(
      `Could not inspect and freeze the POSIX process tree: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const killDeadline = Date.now() + PROCESS_KILL_CONFIRMATION_MS;
    if (observedTable && (observedRoot || knownDescendants.size > 0)) {
      const fallbackRoot = observedRoot ?? {
        pid: rootPid,
        startTime: '<unobserved-root>',
      };
      signalKnownPosixTree(
        fallbackRoot,
        knownDescendants,
        observedTable,
        'SIGKILL',
        kill,
      );
    }
    if (!(await terminatePosixProcessGroupFallback(
      rootPid,
      kill,
      canUseProcessGroup(),
      killDeadline,
    ))) {
      diagnostics.push(
        `${PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX}: no fresh POSIX snapshot or trusted ` +
        `process-group ownership is available for ${rootPid}.`,
      );
    }
    return diagnostics;
  }

  let useProcessGroupFallback = false;
  while (Date.now() < freezeDeadline) {
    try {
      const remainingMs = freezeDeadline - Date.now();
      if (remainingMs <= 0) break;
      table = await readPosixProcessTableWithTimeout(
        readProcessTable,
        remainingMs,
        'lineage',
      );
      recordKnownDescendants(root, knownDescendants, table);
      signalKnownPosixTree(root, knownDescendants, table, 'SIGSTOP', kill);
      if (knownPosixTreeIsFrozen(root, knownDescendants, table)) break;
    } catch (error) {
      diagnostics.push(
        `Could not refresh the frozen POSIX process tree; used process-group fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      useProcessGroupFallback = true;
      break;
    }
    const remainingMs = freezeDeadline - Date.now();
    if (remainingMs > 0) {
      await delay(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
    }
  }
  if (!useProcessGroupFallback && !knownPosixTreeIsFrozen(root, knownDescendants, table)) {
    diagnostics.push(
      `Could not confirm process-tree freeze within ${PROCESS_TERMINATION_GRACE_MS}ms; ` +
      'continued with SIGKILL.',
    );
  }

  const killDeadline = Date.now() + PROCESS_KILL_CONFIRMATION_MS;
  signalKnownPosixTree(root, knownDescendants, table, 'SIGKILL', kill);
  if (useProcessGroupFallback) {
    if (await terminatePosixProcessGroupFallback(
      rootPid,
      kill,
      canUseProcessGroup(),
      killDeadline,
    )) return diagnostics;
  } else {
    while (Date.now() < killDeadline) {
      try {
        const remainingMs = killDeadline - Date.now();
        if (remainingMs <= 0) break;
        table = await readPosixProcessTableWithTimeout(
          readProcessTable,
          remainingMs,
          'kill-confirmation',
        );
        recordKnownDescendants(root, knownDescendants, table);
        signalKnownPosixTree(root, knownDescendants, table, 'SIGKILL', kill);
        if (!knownPosixTreeIsRunning(root, knownDescendants, table)) return diagnostics;
      } catch (error) {
        diagnostics.push(
          `Could not verify the frozen POSIX process tree after SIGKILL; ` +
          `used process-group fallback: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        useProcessGroupFallback = true;
        break;
      }
      const remainingMs = killDeadline - Date.now();
      if (remainingMs > 0) {
        await delay(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
      }
    }
    if (!useProcessGroupFallback) {
      diagnostics.push(
        `Could not confirm process-tree termination within ${PROCESS_KILL_CONFIRMATION_MS}ms ` +
        `after SIGKILL; process ${rootPid} or one of its descendants may still be running.`,
      );
      return diagnostics;
    }
    if (await terminatePosixProcessGroupFallback(
      rootPid,
      kill,
      canUseProcessGroup(),
      killDeadline,
    )) return diagnostics;
  }

  diagnostics.push(
    `Could not confirm process-tree termination within ${PROCESS_KILL_CONFIRMATION_MS}ms after SIGKILL; ` +
    `process group ${rootPid} may still be running.`,
  );
  return diagnostics;
}

export async function terminatePosixProcessTree(
  rootPid: number,
  dependencies: PosixProcessTreeDependencies = {},
): Promise<string[]> {
  return terminateKnownPosixProcessTree(rootPid, dependencies);
}

export function createPosixProcessTreeMonitor(
  rootPid: number,
  dependencies: PosixProcessTreeDependencies = {},
): ChildProcessTreeMonitor {
  const readProcessTable = dependencies.readProcessTable ?? readPosixProcessTable;
  const readTaggedProcessTable = dependencies.readTaggedProcessTable ??
    readTaggedPosixProcessTable;
  const kill = dependencies.kill ?? process.kill.bind(process);
  let observedRoot: PosixProcessIdentity | undefined;
  const observedDescendants = new Map<number, PosixProcessIdentity>();
  const diagnostics: string[] = [];
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingPoll: Promise<void> | undefined;
  let latestValidatedTable: Map<number, PosixProcessEntry> | undefined;
  let allowLineageRootBinding = false;

  const observeTable = (table: Map<number, PosixProcessEntry>): void => {
    latestValidatedTable = table;
    const rootEntry = table.get(rootPid);
    if (
      allowLineageRootBinding &&
      !observedRoot &&
      rootEntry &&
      !rootEntry.state.startsWith('Z')
    ) {
      observedRoot = { pid: rootPid, startTime: rootEntry.startTime };
    }
    if (observedRoot) {
      recordKnownDescendants(observedRoot, observedDescendants, table);
    }
  };

  const observeTaggedTable = (
    taggedTable: Map<number, PosixProcessEntry>,
    freshTable: Map<number, PosixProcessEntry>,
  ): void => {
    const taggedRoot = taggedTable.get(rootPid);
    if (
      !observedRoot &&
      taggedRoot &&
      freshTable.get(rootPid)?.startTime === taggedRoot.startTime
    ) {
      observedRoot = { pid: rootPid, startTime: taggedRoot.startTime };
    }
    for (const [pid, entry] of taggedTable) {
      if (pid === rootPid) continue;
      if (freshTable.get(pid)?.startTime !== entry.startTime) continue;
      const knownIdentity = observedDescendants.get(pid);
      if (knownIdentity && knownIdentity.startTime !== entry.startTime) continue;
      observedDescendants.set(pid, { pid, startTime: entry.startTime });
    }
  };

  const signalObservedDescendants = (
    table: Map<number, PosixProcessEntry>,
    signal: NodeJS.Signals,
  ): void => {
    for (const identity of [...observedDescendants.values()].reverse()) {
      if (table.get(identity.pid)?.startTime !== identity.startTime) continue;
      signalPosixPid(identity.pid, signal, kill);
    }
  };

  const observedDescendantsAreFrozen = (
    table: Map<number, PosixProcessEntry>,
  ): boolean => [...observedDescendants.values()].every((identity) => {
    const entry = table.get(identity.pid);
    return entry === undefined ||
      entry.startTime !== identity.startTime ||
      entry.state.startsWith('T') ||
      entry.state.startsWith('Z');
  });

  const observedTreeIsFrozen = (
    table: Map<number, PosixProcessEntry>,
  ): boolean => {
    const rootFrozen = !observedRoot || knownPosixTreeIsFrozen(
      observedRoot,
      new Map(),
      table,
    );
    return rootFrozen && observedDescendantsAreFrozen(table);
  };

  const recordObservedLineage = (table: Map<number, PosixProcessEntry>): void => {
    if (observedRoot) {
      recordKnownDescendants(observedRoot, observedDescendants, table);
      return;
    }
    for (const identity of [...observedDescendants.values()]) {
      recordKnownDescendants(identity, observedDescendants, table);
    }
  };

  const stopObservedTree = (table: Map<number, PosixProcessEntry>): void => {
    if (
      observedRoot &&
      table.get(observedRoot.pid)?.startTime === observedRoot.startTime
    ) {
      signalPosixPid(observedRoot.pid, 'SIGSTOP', kill);
    }
    signalObservedDescendants(table, 'SIGSTOP');
  };

  const recordMonitorError = (error: unknown): void => {
    if (diagnostics.length === 0) {
      diagnostics.push(
        `Could not monitor the POSIX process tree before cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const poll = (): void => {
    pendingPoll = readPosixProcessTableWithTimeout(
      readProcessTable,
      PROCESS_TERMINATION_GRACE_MS,
      'lineage',
    )
      .then(observeTable, recordMonitorError).finally(() => {
        pendingPoll = undefined;
        if (!stopped) {
          pollTimer = setTimeout(poll, PROCESS_TREE_POLL_MS);
          pollTimer.unref();
        }
      });
  };
  let initialRootStopped = false;
  try {
    initialRootStopped = signalPosixPid(rootPid, 'SIGSTOP', kill);
    allowLineageRootBinding = initialRootStopped;
  } catch (error) {
    recordMonitorError(error);
  }
  pendingPoll = readPosixProcessTableWithTimeout(
    readProcessTable,
    PROCESS_TERMINATION_GRACE_MS,
    'initial',
  )
    .then(observeTable, recordMonitorError).finally(() => {
      allowLineageRootBinding = false;
      try {
        if (initialRootStopped) signalPosixPid(rootPid, 'SIGCONT', kill);
      } catch (error) {
        recordMonitorError(error);
      }
      pendingPoll = undefined;
      if (!stopped) {
        pollTimer = setTimeout(poll, PROCESS_TREE_POLL_MS);
        pollTimer.unref();
      }
    });

  return {
    terminate: async () => {
      if (!stopped) {
        stopped = true;
        if (pollTimer) clearTimeout(pollTimer);
        await pendingPoll;
      }
      let tokenCleanupConfirmed = false;
      if (dependencies.treeId) {
        const tokenScanDeadline = Date.now() + PROCESS_TOKEN_SCAN_TIMEOUT_MS;
        while (Date.now() < tokenScanDeadline) {
          try {
            const preFreezeRemainingMs = tokenScanDeadline - Date.now();
            if (preFreezeRemainingMs <= 0) break;
            const preFreezeTable = await readPosixProcessTableWithTimeout(
              readProcessTable,
              preFreezeRemainingMs,
              'lineage',
            );
            latestValidatedTable = preFreezeTable;
            recordObservedLineage(preFreezeTable);
            stopObservedTree(preFreezeTable);
            const freezeConfirmationRemainingMs = tokenScanDeadline - Date.now();
            if (freezeConfirmationRemainingMs <= 0) break;
            const freezeConfirmationTable = await readPosixProcessTableWithTimeout(
              readProcessTable,
              freezeConfirmationRemainingMs,
              'confirmation',
            );
            latestValidatedTable = freezeConfirmationTable;
            recordObservedLineage(freezeConfirmationTable);
            stopObservedTree(freezeConfirmationTable);
            if (!observedTreeIsFrozen(freezeConfirmationTable)) {
              continue;
            }
            const remainingMs = tokenScanDeadline - Date.now();
            if (remainingMs <= 0) break;
            const taggedTable = await readTaggedPosixProcessTableWithTimeout(
              dependencies.treeId,
              readTaggedProcessTable,
              Math.min(PROCESS_TERMINATION_GRACE_MS, remainingMs),
            );
            const tagContainsOnlyFrozenKnownIdentities = [...taggedTable].every(
              ([pid, entry]) => {
                const identity = pid === rootPid
                  ? observedRoot
                  : observedDescendants.get(pid);
                const frozenEntry = freezeConfirmationTable.get(pid);
                return identity?.startTime === entry.startTime &&
                  frozenEntry?.startTime === entry.startTime &&
                  (frozenEntry.state.startsWith('T') || frozenEntry.state.startsWith('Z'));
              },
            );
            if (tagContainsOnlyFrozenKnownIdentities) {
              tokenCleanupConfirmed = true;
              latestValidatedTable = freezeConfirmationTable;
              break;
            }
            const lineageRemainingMs = tokenScanDeadline - Date.now();
            if (lineageRemainingMs <= 0) break;
            const lineageTable = await readPosixProcessTableWithTimeout(
              readProcessTable,
              lineageRemainingMs,
              'lineage',
            );
            latestValidatedTable = lineageTable;
            observeTaggedTable(taggedTable, lineageTable);
            recordObservedLineage(lineageTable);
            stopObservedTree(lineageTable);
          } catch (error) {
            recordMonitorError(error);
            const remainingMs = tokenScanDeadline - Date.now();
            if (remainingMs > 0) {
              await delay(Math.min(PROCESS_TREE_POLL_MS, remainingMs));
            }
          }
        }
        if (!tokenCleanupConfirmed) {
          diagnostics.push(
            `${PROCESS_TREE_CLEANUP_UNCONFIRMED_PREFIX}: the POSIX token scan did not ` +
            `reach a frozen fixed point within ${PROCESS_TOKEN_SCAN_TIMEOUT_MS}ms.`,
          );
        }
      }
      return [
        ...diagnostics,
        ...(await terminateKnownPosixProcessTree(
          rootPid,
          { ...dependencies, allowRootIdentityDiscovery: false },
          observedRoot,
          observedDescendants,
          latestValidatedTable,
          tokenCleanupConfirmed,
        )),
      ];
    },
  };
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

export function createWindowsChildProcessTreeMonitor(
  child: ChildProcess,
  options: Parameters<typeof terminateWindowsProcessTree>[1] = {},
): ChildProcessTreeMonitor {
  return {
    terminate: () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve([
          'Skipped Windows process-tree termination after the root exited to avoid signaling ' +
          'a potentially reused PID; detached descendants require Job Object containment.',
        ]);
      }
      return terminateWindowsProcessTree(child, options);
    },
  };
}

export async function terminateChildProcessTree(child: ChildProcess): Promise<string[]> {
  if (child.pid === undefined) return [];
  if (process.platform === 'win32') return terminateWindowsProcessTree(child);
  return terminatePosixProcessTree(child.pid);
}

export function createChildProcessTreeMonitor(
  child: ChildProcess,
  options: { treeId?: string } = {},
): ChildProcessTreeMonitor {
  if (child.pid === undefined) {
    return { terminate: () => terminateChildProcessTree(child) };
  }
  if (process.platform === 'win32') {
    return createWindowsChildProcessTreeMonitor(child);
  }
  return createPosixProcessTreeMonitor(child.pid, {
    treeId: options.treeId,
    canUseProcessGroup: () => child.exitCode === null && child.signalCode === null,
  });
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
