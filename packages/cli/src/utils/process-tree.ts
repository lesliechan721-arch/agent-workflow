import { execFile } from 'node:child_process';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type PosixSignal = KillSignal | 'SIGSTOP';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;
const PROCESS_TREE_LOOKUP_TIMEOUT_MS = 250;
const PROCESS_TREE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface ProcessEntry {
  ppid: number;
  startTime: string;
  state?: string;
}

interface ProcessIdentity {
  pid: number;
  startTime: string;
}

interface PosixProcessSnapshot {
  table: Map<number, ProcessEntry>;
  markerPids: Set<number>;
  markerLookupSucceeded: boolean;
}

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  kill?: (pid: number, signal: PosixSignal) => void;
  execFile?: (
    command: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean; maxBuffer: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown;
}

export interface ProcessTreeObservation {
  readonly pid: number;
  dispose(): void;
}

export interface ProcessTreeTerminationOptions {
  observation?: ProcessTreeObservation;
  requireConfirmedCleanup?: boolean;
}

interface ObservationState {
  pid: number;
  platform: NodeJS.Platform;
  marker?: string;
  dependencies: ProcessTreeDependencies;
  root?: ProcessIdentity;
  rootDiscoveryPending: boolean;
  descendants: Map<number, ProcessIdentity>;
  initialLookup: Promise<void>;
  disposed: boolean;
}

const observationStates = new WeakMap<ProcessTreeObservation, ObservationState>();

const defaultExecFile: NonNullable<ProcessTreeDependencies['execFile']> = (
  command,
  args,
  options,
  callback,
) => execFile(command, args, options, (error, stdout) => callback(error, stdout));

function runCommand(
  command: string,
  args: string[],
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    timeout.unref();

    try {
      execFileImpl(
        command,
        args,
        {
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: PROCESS_TREE_MAX_BUFFER_BYTES,
        },
        (error, stdout) => finish(error ? null : stdout),
      );
    } catch {
      finish(null);
    }
  });
}

function parsePosixProcessTable(stdout: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      state: match[3],
      startTime: match[4],
    });
  }
  return table;
}

function parseMarkerProcessIds(stdout: string, marker: string): Set<number> {
  const processIds = new Set<number>();
  const assignment = `AW_NATIVE_CLI_PROCESS_MARKER=${marker}`;
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[2].includes(assignment)) processIds.add(Number(match[1]));
  }
  return processIds;
}

async function readPosixProcessTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  marker?: string,
  timeoutMs: number = PROCESS_TREE_LOOKUP_TIMEOUT_MS,
): Promise<PosixProcessSnapshot | null> {
  const [identityOutput, markerOutput] = await Promise.all([
    runCommand(
      'ps',
      ['-A', '-o', 'pid=,ppid=,state=,lstart='],
      execFileImpl,
      timeoutMs,
    ),
    marker === undefined
      ? Promise.resolve('')
      : runCommand('ps', ['eww', '-A', '-o', 'pid=,command='], execFileImpl, timeoutMs),
  ]);
  if (identityOutput === null) return null;
  return {
    table: parsePosixProcessTable(identityOutput),
    markerPids:
      marker === undefined || markerOutput === null
        ? new Set()
        : parseMarkerProcessIds(markerOutput, marker),
    markerLookupSucceeded: marker === undefined || markerOutput !== null,
  };
}

function parseWindowsProcessTable(stdout: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\|(\d+)\|(.+?)\s*$/u.exec(line);
    if (!match) continue;
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      startTime: match[3],
    });
  }
  return table;
}

function readWindowsProcessTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<Map<number, ProcessEntry> | null> {
  const script = [
    'Get-CimInstance Win32_Process | ForEach-Object {',
    "  '{0}|{1}|{2}' -f $_.ProcessId,$_.ParentProcessId,$_.CreationDate.ToUniversalTime().Ticks",
    '}',
  ].join(' ');
  return runCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    execFileImpl,
    PROCESS_TREE_COMMAND_TIMEOUT_MS,
  ).then((stdout) => stdout === null ? null : parseWindowsProcessTable(stdout));
}

function refreshDescendants(
  root: ProcessIdentity | undefined,
  knownDescendants: Map<number, ProcessIdentity>,
  table: ReadonlyMap<number, ProcessEntry>,
): void {
  const childrenByParent = new Map<number, number[]>();
  for (const [processId, entry] of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(processId);
    childrenByParent.set(entry.ppid, children);
  }
  const roots = [root, ...knownDescendants.values()].filter(
    (identity): identity is ProcessIdentity =>
      identity !== undefined && table.get(identity.pid)?.startTime === identity.startTime,
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
      knownDescendants.set(descendantPid, { pid: descendantPid, startTime: entry.startTime });
      pending.push(descendantPid);
    }
  }
}

function refreshObservedProcesses(
  state: ObservationState,
  table: ReadonlyMap<number, ProcessEntry>,
  markerPids: ReadonlySet<number> = new Set(),
  allowRootWithoutMarker: boolean = false,
): void {
  if (
    state.root === undefined &&
    (markerPids.has(state.pid) ||
      allowRootWithoutMarker ||
      (state.rootDiscoveryPending && (state.platform === 'win32' || state.marker === undefined)))
  ) {
    const entry = table.get(state.pid);
    if (entry) state.root = { pid: state.pid, startTime: entry.startTime };
  }
  state.rootDiscoveryPending = false;
  for (const processId of markerPids) {
    if (processId === state.root?.pid) continue;
    const entry = table.get(processId);
    if (!entry) continue;
    const known = state.descendants.get(processId);
    if (!known || known.startTime === entry.startTime) {
      state.descendants.set(processId, { pid: processId, startTime: entry.startTime });
    }
  }
  refreshDescendants(state.root, state.descendants, table);
}

function createProcessTreeObservation(
  pid: number,
  marker: string | undefined,
  dependencies: ProcessTreeDependencies,
  startLookup: boolean,
): ProcessTreeObservation {
  const observation: ProcessTreeObservation = {
    pid,
    dispose: () => {
      const state = observationStates.get(observation);
      if (state) state.disposed = true;
    },
  };
  const state = {
    pid,
    platform: dependencies.platform ?? process.platform,
    marker,
    dependencies,
    rootDiscoveryPending: true,
    descendants: new Map<number, ProcessIdentity>(),
    disposed: false,
    initialLookup: Promise.resolve(),
  } satisfies ObservationState;
  observationStates.set(observation, state);
  if (!startLookup) return observation;
  const execFileImpl = dependencies.execFile ?? defaultExecFile;
  state.initialLookup = state.platform === 'win32'
    ? readWindowsProcessTable(execFileImpl).then((table) => {
      if (!state.disposed && table) refreshObservedProcesses(state, table);
    })
    : readPosixProcessTable(execFileImpl, marker).then((snapshot) => {
      if (!state.disposed && snapshot) {
        refreshObservedProcesses(
          state,
          snapshot.table,
          snapshot.markerPids,
          !snapshot.markerLookupSucceeded,
        );
      }
    });
  return observation;
}

export function observeProcessTree(
  pid: number,
  marker: string | undefined,
  dependencies: ProcessTreeDependencies = {},
): ProcessTreeObservation {
  return createProcessTreeObservation(pid, marker, dependencies, true);
}

function cleanupUnconfirmed(detail: string): Error {
  return new Error(`Native CLI cleanup unconfirmed: ${detail}`);
}

function identityMatches(
  identity: ProcessIdentity | undefined,
  table: ReadonlyMap<number, ProcessEntry>,
): identity is ProcessIdentity {
  return identity !== undefined && table.get(identity.pid)?.startTime === identity.startTime;
}

function posixIdentityMatches(
  state: ObservationState,
  identity: ProcessIdentity | undefined,
  snapshot: PosixProcessSnapshot,
): identity is ProcessIdentity {
  return identityMatches(identity, snapshot.table) &&
    (state.marker === undefined ||
      (snapshot.markerLookupSucceeded && snapshot.markerPids.has(identity.pid)));
}

function signalIdentity(
  state: ObservationState,
  identity: ProcessIdentity,
  snapshot: PosixProcessSnapshot,
  signal: PosixSignal,
  kill: NonNullable<ProcessTreeDependencies['kill']>,
): void {
  if (!posixIdentityMatches(state, identity, snapshot)) return;
  try {
    kill(identity.pid, signal);
  } catch {
    // The process can exit between identity verification and the signal.
  }
}

async function runTaskkill(
  pid: number,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<boolean> {
  return (await runCommand(
    'taskkill',
    ['/PID', String(pid), '/T', '/F'],
    execFileImpl,
    PROCESS_TREE_COMMAND_TIMEOUT_MS,
  )) !== null;
}

async function terminateWindowsProcessTree(
  state: ObservationState,
  requireConfirmedCleanup: boolean,
): Promise<void> {
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  if (!requireConfirmedCleanup) {
    if (!(await runTaskkill(state.pid, execFileImpl))) {
      throw cleanupUnconfirmed('taskkill did not confirm termination.');
    }
    return;
  }
  await state.initialLookup;
  const table = await readWindowsProcessTable(execFileImpl);
  if (!table) {
    throw cleanupUnconfirmed('Windows process identity lookup failed.');
  }
  refreshObservedProcesses(state, table);
  const rootTarget = identityMatches(state.root, table) ? state.root : undefined;
  const liveDescendants = [...state.descendants.values()].filter((identity) =>
    identityMatches(identity, table)
  );
  const liveDescendantPids = new Set(liveDescendants.map((identity) => identity.pid));
  const targets = rootTarget
    ? [rootTarget]
    : liveDescendants.filter((identity) =>
      !liveDescendantPids.has(table.get(identity.pid)!.ppid)
    );
  const taskkillResults = await Promise.all(
    targets.map((identity) => runTaskkill(identity.pid, execFileImpl)),
  );
  if (taskkillResults.some((result) => !result)) {
    throw cleanupUnconfirmed('taskkill did not confirm termination.');
  }
  const verifiedTable = await readWindowsProcessTable(execFileImpl);
  if (!verifiedTable) throw cleanupUnconfirmed('Windows termination verification failed.');
  const verifiedIdentities = [rootTarget, ...liveDescendants].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  if (verifiedIdentities.some((identity) => identityMatches(identity, verifiedTable))) {
    throw cleanupUnconfirmed('a verified Windows process is still running.');
  }
  if (requireConfirmedCleanup && targets.length === 0) {
    throw cleanupUnconfirmed('no inherited-pipe process identity was observed.');
  }
}

async function terminatePosixProcessTree(
  state: ObservationState,
  requireConfirmedCleanup: boolean,
): Promise<void> {
  await state.initialLookup;
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  const kill = state.dependencies.kill ?? process.kill.bind(process);
  const deadline = Date.now() + PROCESS_TREE_COMMAND_TIMEOUT_MS;
  let snapshot = await readPosixProcessTable(execFileImpl, state.marker);
  if (!snapshot) {
    throw cleanupUnconfirmed('POSIX process identity lookup failed.');
  }
  let markerLookupEverFailed = state.marker !== undefined && !snapshot.markerLookupSucceeded;
  refreshObservedProcesses(
    state,
    snapshot.table,
    snapshot.markerPids,
  );
  const observedAtTermination = new Set(
    [...state.descendants.values()]
      .filter((identity) =>
        posixIdentityMatches(state, identity, snapshot!)
      )
      .map((identity) => `${identity.pid}:${identity.startTime}`),
  );

  while (Date.now() < deadline) {
    if (posixIdentityMatches(state, state.root, snapshot)) {
      signalIdentity(state, state.root, snapshot, 'SIGSTOP', kill);
    }
    for (const identity of [...state.descendants.values()].reverse()) {
      signalIdentity(state, identity, snapshot, 'SIGSTOP', kill);
    }
    const next = await readPosixProcessTable(
      execFileImpl,
      state.marker,
      Math.min(PROCESS_TREE_LOOKUP_TIMEOUT_MS, Math.max(1, deadline - Date.now())),
    );
    if (!next) break;
    snapshot = next;
    markerLookupEverFailed ||=
      state.marker !== undefined && !snapshot.markerLookupSucceeded;
    const previousSize = state.descendants.size;
    refreshObservedProcesses(
      state,
      snapshot.table,
      snapshot.markerPids,
    );
    if (posixIdentityMatches(state, state.root, snapshot)) {
      signalIdentity(state, state.root, snapshot, 'SIGSTOP', kill);
    }
    for (const identity of [...state.descendants.values()].reverse()) {
      signalIdentity(state, identity, snapshot, 'SIGSTOP', kill);
    }
    const allFrozen = [state.root, ...state.descendants.values()].every((identity) => {
      if (!posixIdentityMatches(state, identity, snapshot!)) return true;
      const processState = snapshot!.table.get(identity.pid)?.state;
      return processState?.startsWith('T') || processState?.startsWith('Z');
    });
    if (allFrozen && state.descendants.size === previousSize) break;
  }

  const killed = [...state.descendants.values()].filter((identity) =>
    posixIdentityMatches(state, identity, snapshot!)
  );
  for (const identity of killed.reverse()) {
    signalIdentity(state, identity, snapshot, 'SIGKILL', kill);
  }
  if (markerLookupEverFailed) {
    throw cleanupUnconfirmed('POSIX process marker lookup failed.');
  }
  if (!requireConfirmedCleanup) return;
  const verified = await readPosixProcessTable(execFileImpl, state.marker);
  if (!verified) throw cleanupUnconfirmed('POSIX termination verification failed.');
  if (!verified.markerLookupSucceeded) {
    throw cleanupUnconfirmed('POSIX process marker verification failed.');
  }
  const stillRunning = killed.some((identity) => {
    if (!posixIdentityMatches(state, identity, verified)) return false;
    return !verified.table.get(identity.pid)?.state?.startsWith('Z');
  });
  if (stillRunning) throw cleanupUnconfirmed('a verified POSIX descendant is still running.');
  if (requireConfirmedCleanup && observedAtTermination.size === 0) {
    throw cleanupUnconfirmed('no inherited-pipe process identity was observed.');
  }
}

export async function terminateProcessTree(
  pid: number,
  killDirectChild: (signal: KillSignal) => void,
  dependencies: ProcessTreeDependencies = {},
  options: ProcessTreeTerminationOptions = {},
): Promise<void> {
  const platform = dependencies.platform ?? process.platform;
  const observation = options.observation ??
    createProcessTreeObservation(pid, undefined, dependencies, false);
  const state = observationStates.get(observation);
  try {
    if (!state || state.pid !== pid || state.platform !== platform) {
      throw cleanupUnconfirmed('process observation is invalid.');
    }
    if (platform === 'win32') {
      await terminateWindowsProcessTree(
        state,
        options.requireConfirmedCleanup ?? false,
      );
      return;
    }
    await terminatePosixProcessTree(
      state,
      options.requireConfirmedCleanup ?? false,
    );
  } finally {
    observation.dispose();
    try {
      killDirectChild('SIGKILL');
    } catch {
      // The direct child can exit before fallback termination runs.
    }
  }
}
