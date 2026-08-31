import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type PosixSignal = KillSignal | 'SIGSTOP';
const DEFAULT_PROCESS_MARKER_ENV = 'AW_NATIVE_CLI_PROCESS_MARKER';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;
const PROCESS_TREE_OBSERVATION_INTERVAL_MS = 50;
const PROCESS_TREE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface ProcessEntry {
  ppid: number;
  pgid?: number;
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
  confirmedUnmarkedPids: Set<number>;
}

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  markerEnvironmentVariable?: string;
  enforceCooperativeProcessGroup?: boolean;
  kill?: (pid: number, signal: PosixSignal) => void;
  execFile?: (
    command: string,
    args: string[],
    options: { timeout: number; windowsHide: boolean; maxBuffer: number },
    callback: (error: Error | null, stdout: string) => void,
  ) => unknown;
  createSentinel?: (
    markerEnvironmentVariable: string,
    marker: string,
  ) => Promise<ProcessTreeSentinel>;
}

export interface ProcessTreeSentinel {
  pid: number;
  stop(): Promise<void>;
}

export interface ProcessTreeInspectionLease {
  readonly marker: string;
  readonly sentinel: ProcessIdentity;
  release(): Promise<void>;
}

export interface ProcessTreeObservation {
  readonly pid: number;
  onFailure(listener: (error: Error) => void): () => void;
  dispose(): void;
}

export interface ProcessTreeTerminationOptions {
  observation?: ProcessTreeObservation;
  requireConfirmedCleanup?: boolean;
  allowInspectionUnavailable?: boolean;
  requireDescendantsExitedBeforeCompletion?: boolean;
}

interface ObservationState {
  pid: number;
  platform: NodeJS.Platform;
  marker?: string;
  markerEnvironmentVariable: string;
  lease?: ProcessTreeInspectionLease;
  dependencies: ProcessTreeDependencies;
  root?: ProcessIdentity;
  rootPgid?: number;
  rootPgidMode?: 'owned' | 'shared' | 'missing';
  rootDiscoveryPending: boolean;
  descendants: Map<number, ProcessIdentity>;
  lastSnapshot?: PosixProcessSnapshot;
  failure?: Error;
  failureListeners: Set<(error: Error) => void>;
  initialLookup: Promise<void>;
  pollTimer?: NodeJS.Timeout;
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
    const groupMatch = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (groupMatch) {
      table.set(Number(groupMatch[1]), {
        ppid: Number(groupMatch[2]),
        pgid: Number(groupMatch[3]),
        state: groupMatch[4],
        startTime: groupMatch[5],
      });
      continue;
    }
    const legacyMatch = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!legacyMatch) continue;
    table.set(Number(legacyMatch[1]), {
      ppid: Number(legacyMatch[2]),
      state: legacyMatch[3],
      startTime: legacyMatch[4],
    });
  }
  return table;
}

function parseMarkerProcessIds(
  stdout: string,
  markerEnvironmentVariable: string,
  marker: string,
): Set<number> {
  const processIds = new Set<number>();
  const assignment = `${markerEnvironmentVariable}=${marker}`;
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (match?.[2].split(/\s+/u).includes(assignment)) processIds.add(Number(match[1]));
  }
  return processIds;
}

async function readPosixProcessTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  markerEnvironmentVariable: string,
  marker?: string,
  timeoutMs: number = PROCESS_TREE_COMMAND_TIMEOUT_MS,
  confirmUnmarkedPid?: number,
): Promise<PosixProcessSnapshot | null> {
  const identityArgs = ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='];
  const [identityOutput, markerOutput] = await Promise.all([
    runCommand('ps', identityArgs, execFileImpl, timeoutMs),
    marker === undefined
      ? Promise.resolve('')
      : runCommand('ps', ['eww', '-A', '-o', 'pid=,command='], execFileImpl, timeoutMs),
  ]);
  if (identityOutput === null) return null;
  const table = parsePosixProcessTable(identityOutput);
  const markerPids = marker === undefined || markerOutput === null
    ? new Set<number>()
    : parseMarkerProcessIds(markerOutput, markerEnvironmentVariable, marker);
  const confirmedUnmarkedPids = new Set<number>();
  const unmarkedEntry = confirmUnmarkedPid === undefined || markerPids.has(confirmUnmarkedPid)
    ? undefined
    : table.get(confirmUnmarkedPid);
  if (unmarkedEntry && !unmarkedEntry.state?.startsWith('Z')) {
    const confirmationOutput = await runCommand('ps', identityArgs, execFileImpl, timeoutMs);
    if (confirmationOutput === null) return null;
    const confirmedEntry = parsePosixProcessTable(confirmationOutput).get(confirmUnmarkedPid!);
    if (
      confirmedEntry?.startTime === unmarkedEntry.startTime &&
      !confirmedEntry.state?.startsWith('Z')
    ) {
      confirmedUnmarkedPids.add(confirmUnmarkedPid!);
    }
  }
  return {
    table,
    markerPids,
    markerLookupSucceeded: marker === undefined || markerOutput !== null,
    confirmedUnmarkedPids,
  };
}

async function defaultCreateSentinel(
  markerEnvironmentVariable: string,
  marker: string,
): Promise<ProcessTreeSentinel> {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 60_000)'],
    {
      env: { [markerEnvironmentVariable]: marker },
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  await once(child, 'spawn');
  if (child.pid === undefined) throw cleanupUnconfirmed('inspection sentinel did not start.');
  return {
    pid: child.pid,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close').then(() => undefined);
      try {
        child.kill('SIGKILL');
      } catch {
        // The controlled sentinel can exit before release.
      }
      await closed;
    },
  };
}

function validateLeaseSnapshot(
  snapshot: PosixProcessSnapshot,
  lease: ProcessTreeInspectionLease,
): Error | undefined {
  if (!snapshot.markerLookupSucceeded) {
    return cleanupUnconfirmed('POSIX process marker lookup failed.');
  }
  const sentinelEntry = snapshot.table.get(lease.sentinel.pid);
  if (
    sentinelEntry?.startTime !== lease.sentinel.startTime ||
    !snapshot.markerPids.has(lease.sentinel.pid)
  ) {
    return cleanupUnconfirmed('POSIX inspection sentinel could not be verified.');
  }
  return undefined;
}

export async function acquireProcessTreeInspectionLease(
  dependencies: ProcessTreeDependencies = {},
): Promise<ProcessTreeInspectionLease> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    throw cleanupUnconfirmed(`process inspection is unsupported on ${platform}.`);
  }
  const markerEnvironmentVariable =
    dependencies.markerEnvironmentVariable ?? DEFAULT_PROCESS_MARKER_ENV;
  const marker = randomUUID();
  const sentinel = await (dependencies.createSentinel ?? defaultCreateSentinel)(
    markerEnvironmentVariable,
    marker,
  );
  try {
    const snapshot = await readPosixProcessTable(
      dependencies.execFile ?? defaultExecFile,
      markerEnvironmentVariable,
      marker,
    );
    if (!snapshot) throw cleanupUnconfirmed('POSIX process identity lookup failed.');
    if (!snapshot.markerLookupSucceeded) {
      throw cleanupUnconfirmed('POSIX process marker lookup failed.');
    }
    const entry = snapshot.table.get(sentinel.pid);
    if (!entry || !snapshot.markerPids.has(sentinel.pid)) {
      throw cleanupUnconfirmed('POSIX inspection sentinel could not be verified.');
    }
    let released = false;
    return {
      marker,
      sentinel: { pid: sentinel.pid, startTime: entry.startTime },
      release: async () => {
        if (released) return;
        released = true;
        await sentinel.stop();
      },
    };
  } catch (error) {
    await sentinel.stop();
    throw error;
  }
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
    if (processId === state.lease?.sentinel.pid) continue;
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

function latchObservationFailure(state: ObservationState, error: Error): void {
  if (state.failure) return;
  state.failure = error;
  for (const listener of state.failureListeners) listener(error);
}

function acceptPosixSnapshot(
  state: ObservationState,
  snapshot: PosixProcessSnapshot,
): boolean {
  if (!snapshot.markerLookupSucceeded && state.marker !== undefined) {
    latchObservationFailure(
      state,
      cleanupUnconfirmed('POSIX process marker lookup failed.'),
    );
    return false;
  }
  if (state.lease) {
    const leaseFailure = validateLeaseSnapshot(snapshot, state.lease);
    if (leaseFailure) {
      latchObservationFailure(state, leaseFailure);
      return false;
    }
  }
  const rootEntry = snapshot.table.get(state.pid);
  if (
    state.marker !== undefined &&
    state.dependencies.enforceCooperativeProcessGroup === true &&
    rootEntry !== undefined &&
    !rootEntry.state?.startsWith('Z') &&
    snapshot.confirmedUnmarkedPids.has(state.pid)
  ) {
    state.root = { pid: state.pid, startTime: rootEntry.startTime };
    latchObservationFailure(
      state,
      cleanupUnconfirmed(
        'custom process contract violation: a live provider process lost its process marker.',
      ),
    );
  }
  refreshObservedProcesses(state, snapshot.table, snapshot.markerPids);
  if (state.marker !== undefined) {
    const providerMarkerPids = [...snapshot.markerPids].filter(
      (pid) => pid !== state.lease?.sentinel.pid,
    );
    if (
      state.dependencies.enforceCooperativeProcessGroup === true &&
      state.rootPgidMode === undefined
    ) {
      if (
        state.root?.pid === state.pid &&
        rootEntry?.startTime === state.root.startTime &&
        rootEntry.pgid !== undefined &&
        snapshot.markerPids.has(state.pid)
      ) {
        if (rootEntry.pgid === state.pid) {
          state.rootPgid = rootEntry.pgid;
          state.rootPgidMode = 'owned';
        } else {
          state.rootPgidMode = 'shared';
        }
      } else if (
        rootEntry === undefined &&
        (
          providerMarkerPids.some((pid) => snapshot.table.get(pid)?.pgid !== undefined) ||
          [...snapshot.table].some(([pid, entry]) =>
            pid !== state.lease?.sentinel.pid &&
            entry.pgid === state.pid &&
            !entry.state?.startsWith('Z')
          )
        )
      ) {
        state.rootPgid = state.pid;
        state.rootPgidMode = 'missing';
      }
    }
    const expectedPgid = state.rootPgidMode === 'owned'
      ? state.rootPgid
      : state.rootPgidMode === 'missing'
        ? state.pid
        : undefined;
    if (
      expectedPgid !== undefined &&
      providerMarkerPids.some((pid) => {
        const entry = snapshot.table.get(pid);
        return entry?.pgid !== undefined && entry.pgid !== expectedPgid;
      })
    ) {
      latchObservationFailure(
        state,
        cleanupUnconfirmed(
          'custom process contract violation: a marked process left its initial process group.',
        ),
      );
    }
    const liveKnownIdentities = [state.root, ...state.descendants.values()].filter(
      (identity): identity is ProcessIdentity =>
        identityMatches(identity, snapshot.table) &&
        !snapshot.table.get(identity.pid)?.state?.startsWith('Z'),
    );
    const markerlessKnownIdentity =
      state.dependencies.enforceCooperativeProcessGroup === true &&
      liveKnownIdentities.some((identity) =>
        identity.pid !== state.pid && !snapshot.markerPids.has(identity.pid)
      );
    let markerlessInitialGroupMember = false;
    if (state.rootPgid !== undefined) {
      for (const [pid, entry] of snapshot.table) {
        if (entry.pgid !== state.rootPgid || entry.state?.startsWith('Z')) continue;
        if (pid !== state.root?.pid) {
          const known = state.descendants.get(pid);
          if (!known || known.startTime === entry.startTime) {
            state.descendants.set(pid, { pid, startTime: entry.startTime });
          }
        }
        if (pid !== state.pid && !snapshot.markerPids.has(pid)) {
          markerlessInitialGroupMember = true;
        }
      }
    }
    if (markerlessKnownIdentity || markerlessInitialGroupMember) {
      latchObservationFailure(
        state,
        cleanupUnconfirmed(
          'custom process contract violation: a live provider process lost its process marker.',
        ),
      );
    }
  }
  state.lastSnapshot = snapshot;
  return true;
}

function createProcessTreeObservation(
  pid: number,
  marker: string | undefined,
  dependencies: ProcessTreeDependencies,
  startLookup: boolean,
  lease?: ProcessTreeInspectionLease,
): ProcessTreeObservation {
  const observation: ProcessTreeObservation = {
    pid,
    onFailure: (listener) => {
      const state = observationStates.get(observation);
      if (!state) return () => undefined;
      state.failureListeners.add(listener);
      if (state.failure) listener(state.failure);
      return () => state.failureListeners.delete(listener);
    },
    dispose: () => {
      const state = observationStates.get(observation);
      if (state) {
        state.disposed = true;
        if (state.pollTimer) clearTimeout(state.pollTimer);
      }
    },
  };
  const state: ObservationState = {
    pid,
    platform: dependencies.platform ?? process.platform,
    marker,
    markerEnvironmentVariable:
      dependencies.markerEnvironmentVariable ?? DEFAULT_PROCESS_MARKER_ENV,
    lease,
    dependencies,
    rootDiscoveryPending: true,
    descendants: new Map<number, ProcessIdentity>(),
    failureListeners: new Set<(error: Error) => void>(),
    disposed: false,
    initialLookup: Promise.resolve(),
  };
  observationStates.set(observation, state);
  if (!startLookup) return observation;
  const execFileImpl = dependencies.execFile ?? defaultExecFile;
  const refresh = (): Promise<void> => state.platform === 'win32'
    ? readWindowsProcessTable(execFileImpl).then((table) => {
      if (!state.disposed && table) refreshObservedProcesses(state, table);
    })
    : readPosixProcessTable(
      execFileImpl,
      state.markerEnvironmentVariable,
      marker,
      PROCESS_TREE_COMMAND_TIMEOUT_MS,
      dependencies.enforceCooperativeProcessGroup === true && marker !== undefined
        ? state.pid
        : undefined,
    ).then((snapshot) => {
      if (state.disposed) return;
      if (!snapshot) {
        latchObservationFailure(
          state,
          cleanupUnconfirmed('POSIX process identity lookup failed.'),
        );
        return;
      }
      acceptPosixSnapshot(state, snapshot);
    });
  const scheduleRefresh = (): void => {
    if (state.disposed) return;
    state.pollTimer = setTimeout(() => {
      state.pollTimer = undefined;
      void refresh().finally(scheduleRefresh);
    }, PROCESS_TREE_OBSERVATION_INTERVAL_MS);
    state.pollTimer.unref();
  };
  state.initialLookup = refresh();
  if (state.platform !== 'win32') void state.initialLookup.finally(scheduleRefresh);
  return observation;
}

export function observeProcessTree(
  pid: number,
  marker: string | undefined,
  dependencies: ProcessTreeDependencies = {},
  lease?: ProcessTreeInspectionLease,
): ProcessTreeObservation {
  return createProcessTreeObservation(pid, marker, dependencies, true, lease);
}

export async function assertProcessTreeInspectionAvailable(
  dependencies: ProcessTreeDependencies = {},
): Promise<void> {
  const lease = await acquireProcessTreeInspectionLease(dependencies);
  await lease.release();
}

function cleanupUnconfirmed(detail: string): Error {
  return new Error(`Process tree cleanup unconfirmed: ${detail}`);
}

function identityMatches(
  identity: ProcessIdentity | undefined,
  table: ReadonlyMap<number, ProcessEntry>,
): identity is ProcessIdentity {
  return identity !== undefined && table.get(identity.pid)?.startTime === identity.startTime;
}

function posixIdentityMatches(
  identity: ProcessIdentity | undefined,
  snapshot: PosixProcessSnapshot,
): identity is ProcessIdentity {
  return identityMatches(identity, snapshot.table);
}

function signalIdentity(
  identity: ProcessIdentity,
  snapshot: PosixProcessSnapshot,
  signal: PosixSignal,
  kill: NonNullable<ProcessTreeDependencies['kill']>,
): void {
  if (!posixIdentityMatches(identity, snapshot)) return;
  try {
    kill(identity.pid, signal);
  } catch {
    // The process can exit between identity verification and the signal.
  }
}

function safelyOwnedProcessGroup(
  state: ObservationState,
  snapshot: PosixProcessSnapshot,
): number | undefined {
  if (
    state.dependencies.enforceCooperativeProcessGroup !== true ||
    state.marker === undefined ||
    state.rootPgid === undefined ||
    state.rootPgid !== state.pid
  ) return undefined;
  const pgid = state.rootPgid;
  const members = [...snapshot.table].filter(([, entry]) =>
    entry.pgid === pgid && !entry.state?.startsWith('Z')
  );
  if (members.length === 0) return undefined;
  const known = [state.root, ...state.descendants.values()];
  if (members.some(([pid, entry]) =>
    !known.some((identity) => identity?.pid === pid && identity.startTime === entry.startTime)
  )) return undefined;
  return pgid;
}

function signalProcessGroup(
  pgid: number | undefined,
  signal: PosixSignal,
  kill: NonNullable<ProcessTreeDependencies['kill']>,
): void {
  if (pgid === undefined) return;
  try {
    kill(-pgid, signal);
  } catch {
    // The verified process group can exit before the signal.
  }
}

function latchLiveDescendantCompletionFailure(
  state: ObservationState,
  snapshot: PosixProcessSnapshot,
): void {
  if (state.dependencies.enforceCooperativeProcessGroup !== true) return;
  const liveDescendant = [...state.descendants.values()].some((identity) =>
    identity.pid !== state.pid &&
    identity.pid !== state.lease?.sentinel.pid &&
    posixIdentityMatches(identity, snapshot) &&
    !snapshot.table.get(identity.pid)?.state?.startsWith('Z')
  );
  if (!liveDescendant) return;
  latchObservationFailure(
    state,
    cleanupUnconfirmed(
      'custom process contract violation: all provider descendants must exit before completion.',
    ),
  );
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
  allowInspectionUnavailable: boolean,
  requireDescendantsExitedBeforeCompletion: boolean,
): Promise<void> {
  await state.initialLookup;
  state.disposed = true;
  if (state.pollTimer) clearTimeout(state.pollTimer);
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  const kill = state.dependencies.kill ?? process.kill.bind(process);
  const deadline = Date.now() + PROCESS_TREE_COMMAND_TIMEOUT_MS;
  const inspect = async (timeoutMs: number): Promise<PosixProcessSnapshot | undefined> => {
    const next = await readPosixProcessTable(
      execFileImpl,
      state.markerEnvironmentVariable,
      state.marker,
      timeoutMs,
      state.dependencies.enforceCooperativeProcessGroup === true && state.marker !== undefined
        ? state.pid
        : undefined,
    );
    if (!next) {
      latchObservationFailure(
        state,
        cleanupUnconfirmed('POSIX process identity lookup failed.'),
      );
      return undefined;
    }
    return acceptPosixSnapshot(state, next) ? next : undefined;
  };
  let snapshot = await inspect(PROCESS_TREE_COMMAND_TIMEOUT_MS);
  let processGroupCurrentlyVerified = snapshot !== undefined;
  if (!snapshot) snapshot = state.lastSnapshot;
  if (!snapshot) {
    if (!requireConfirmedCleanup && allowInspectionUnavailable) return;
    throw state.failure ?? cleanupUnconfirmed('POSIX process identity lookup failed.');
  }
  if (!processGroupCurrentlyVerified && safelyOwnedProcessGroup(state, snapshot) === undefined) {
    if (!requireConfirmedCleanup && allowInspectionUnavailable) return;
    throw state.failure ?? cleanupUnconfirmed('POSIX process identity lookup failed.');
  }
  if (requireDescendantsExitedBeforeCompletion) {
    latchLiveDescendantCompletionFailure(state, snapshot);
  }
  const observedAtTermination = new Set(
    [...state.descendants.values()]
      .filter((identity) =>
        posixIdentityMatches(identity, snapshot!)
      )
      .map((identity) => `${identity.pid}:${identity.startTime}`),
  );

  while (Date.now() < deadline) {
    signalProcessGroup(
      processGroupCurrentlyVerified ? safelyOwnedProcessGroup(state, snapshot) : undefined,
      'SIGSTOP',
      kill,
    );
    if (posixIdentityMatches(state.root, snapshot)) {
      signalIdentity(state.root, snapshot, 'SIGSTOP', kill);
    }
    for (const identity of [...state.descendants.values()].reverse()) {
      signalIdentity(identity, snapshot, 'SIGSTOP', kill);
    }
    const next = await inspect(Math.max(1, deadline - Date.now()));
    if (!next) {
      processGroupCurrentlyVerified = false;
      break;
    }
    snapshot = next;
    processGroupCurrentlyVerified = true;
    const previousSize = state.descendants.size;
    signalProcessGroup(safelyOwnedProcessGroup(state, snapshot), 'SIGSTOP', kill);
    if (posixIdentityMatches(state.root, snapshot)) {
      signalIdentity(state.root, snapshot, 'SIGSTOP', kill);
    }
    for (const identity of [...state.descendants.values()].reverse()) {
      signalIdentity(identity, snapshot, 'SIGSTOP', kill);
    }
    const allFrozen = [state.root, ...state.descendants.values()].every((identity) => {
      if (!posixIdentityMatches(identity, snapshot!)) return true;
      const processState = snapshot!.table.get(identity.pid)?.state;
      return processState?.startsWith('T') || processState?.startsWith('Z');
    });
    if (allFrozen && state.descendants.size === previousSize) break;
  }

  const killed = [state.root, ...state.descendants.values()].filter((identity) =>
    identity !== undefined &&
    posixIdentityMatches(identity, snapshot!)
  );
  const ownedPgid = processGroupCurrentlyVerified
    ? safelyOwnedProcessGroup(state, snapshot)
    : undefined;
  for (const identity of killed.reverse()) {
    signalIdentity(identity, snapshot, 'SIGKILL', kill);
  }
  signalProcessGroup(ownedPgid, 'SIGKILL', kill);
  if (!requireConfirmedCleanup) {
    if (state.failure) throw state.failure;
    return;
  }
  const verified = await inspect(PROCESS_TREE_COMMAND_TIMEOUT_MS);
  if (!verified) {
    throw state.failure ?? cleanupUnconfirmed('POSIX termination verification failed.');
  }
  const stillRunning = killed.some((identity) => {
    if (!posixIdentityMatches(identity, verified)) return false;
    return !verified.table.get(identity.pid)?.state?.startsWith('Z');
  });
  if (stillRunning) throw cleanupUnconfirmed('a verified POSIX descendant is still running.');
  const unobservedMarkedProcess = state.marker === undefined
    ? false
    : [...verified.markerPids].some((pid) =>
      pid !== state.lease?.sentinel.pid &&
      !verified.table.get(pid)?.state?.startsWith('Z')
    );
  if (unobservedMarkedProcess) {
    throw cleanupUnconfirmed('an unverified marker process is still running.');
  }
  if (requireConfirmedCleanup && state.marker === undefined && observedAtTermination.size === 0) {
    throw cleanupUnconfirmed('no inherited-pipe process identity was observed.');
  }
  if (state.failure) throw state.failure;
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
      options.allowInspectionUnavailable ?? false,
      options.requireDescendantsExitedBeforeCompletion ?? false,
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
