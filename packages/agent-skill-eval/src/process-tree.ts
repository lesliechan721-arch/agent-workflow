import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type PosixSignal = KillSignal | 'SIGSTOP';
const DEFAULT_PROCESS_MARKER_ENV = 'AW_NATIVE_CLI_PROCESS_MARKER';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS = 2_000;
const PROCESS_TREE_IDENTITY_INTERVAL_MS = 250;
const PROCESS_TREE_MARKER_INTERVAL_MS = 1_000;
const PROCESS_TREE_TERMINATION_GRACE_MS = 250;
const PROCESS_TREE_TERMINATION_SETTLE_MS = 50;
const PROCESS_TREE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface ProcessEntry {
  ppid: number;
  pgid?: number;
  startTime: string;
  creationTime?: bigint;
  state?: string;
}

interface ProcessIdentity {
  pid: number;
  startTime: string;
  creationTime?: bigint;
}

interface ProcessCommandFailure {
  reason: 'callback-error' | 'deadline-exceeded' | 'synchronous-error';
  code?: string | number;
  signal?: string;
  killed?: boolean;
}

type ProcessCommandResult =
  | { output: string; failure?: never }
  | { output: null; failure: ProcessCommandFailure };

interface PosixProcessSnapshot {
  table: Map<number, ProcessEntry>;
  markerPids: Set<number>;
  unreadableMarkerPids: Set<number>;
  markerLookupSucceeded: boolean;
  markerLookupAttempts: number;
  markerScanStartedAt?: number;
  markerLookupFailure?: ProcessCommandFailure;
  confirmedUnmarkedPids: Set<number>;
}

interface PosixMarkerScan {
  table: Map<number, ProcessEntry>;
  commands: Map<number, string>;
  unreadablePids: Set<number>;
}

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  markerEnvironmentVariable?: string;
  /** Continuously verify markers without requiring all descendants to share a process group. */
  enforceProcessMarker?: boolean;
  /** Enforce the custom provider contract, including continuous marker verification. */
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
  readonly diagnostics: ProcessTreeDiagnostic[];
  onFailure(listener: (error: Error) => void): () => void;
  dispose(): void;
}

/** Bounded process metadata only: never retain commands, environments, or marker values. */
export interface ProcessTreeDiagnostic {
  capturedAt: string;
  stage: string;
  reason: string;
  rootPid: number;
  rootPgid?: number;
  rootPgidMode?: 'owned' | 'shared' | 'missing';
  affectedPids: number[];
  markerLookupSucceeded: boolean | null;
  lookupFailure?: ProcessCommandFailure;
  processes: Array<{
    pid: number;
    present: boolean | null;
    knownStartTime?: string;
    ppid?: number;
    pgid?: number;
    startTime?: string;
    state?: string;
    markerMatches: boolean | null;
  }>;
}

export interface ProcessTreeTerminationOptions {
  observation?: ProcessTreeObservation;
  requireConfirmedCleanup?: boolean;
  allowUnobservedWindowsProcessOnNormalCompletion?: boolean;
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
  unmarkedRootCandidate?: ProcessIdentity;
  initialWindowsLookupSucceeded: boolean;
  descendants: Map<number, ProcessIdentity>;
  failure?: Error;
  diagnostics: ProcessTreeDiagnostic[];
  failureListeners: Set<(error: Error) => void>;
  initialLookup: Promise<void>;
  sampler?: PosixProcessSampler;
  disposed: boolean;
}

interface PosixProcessSampler {
  readonly execFile: NonNullable<ProcessTreeDependencies['execFile']>;
  readonly states: Set<ObservationState>;
  identityTable?: Map<number, ProcessEntry>;
  identityFailure?: ProcessCommandFailure;
  identityScannedAt: number;
  identityInFlight?: Promise<void>;
  markerScan?: PosixMarkerScan;
  markerFailure?: ProcessCommandFailure;
  markerScannedAt: number;
  markerInFlight?: Promise<void>;
  timer?: NodeJS.Timeout;
}

const observationStates = new WeakMap<ProcessTreeObservation, ObservationState>();
const posixSamplers = new WeakMap<
  NonNullable<ProcessTreeDependencies['execFile']>,
  PosixProcessSampler
>();

const defaultExecFile: NonNullable<ProcessTreeDependencies['execFile']> = (
  command,
  args,
  options,
  callback,
) => execFile(command, args, options, (error, stdout) => callback(error, stdout));

function safeCommandFailureValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(value)) return undefined;
  return value;
}

function commandFailure(
  reason: ProcessCommandFailure['reason'],
  error?: unknown,
): ProcessCommandFailure {
  const details = error && typeof error === 'object'
    ? error as { code?: unknown; signal?: unknown; killed?: unknown }
    : {};
  const code = safeCommandFailureValue(details.code);
  const signal = safeCommandFailureValue(details.signal);
  return {
    reason,
    ...(code !== undefined ? { code } : {}),
    ...(typeof signal === 'string' ? { signal } : {}),
    ...(typeof details.killed === 'boolean' ? { killed: details.killed } : {}),
  };
}

function runCommandWithDiagnostics(
  command: string,
  args: string[],
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs: number,
): Promise<ProcessCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ProcessCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => finish({
      output: null,
      failure: commandFailure('deadline-exceeded'),
    }), timeoutMs);
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
        (error, stdout) => finish(error
          ? { output: null, failure: commandFailure('callback-error', error) }
          : { output: stdout }),
      );
    } catch (error) {
      finish({ output: null, failure: commandFailure('synchronous-error', error) });
    }
  });
}

function runCommand(
  command: string,
  args: string[],
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs: number,
): Promise<string | null> {
  return runCommandWithDiagnostics(command, args, execFileImpl, timeoutMs)
    .then((result) => result.output);
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

function parsePosixMarkerScan(stdout: string): PosixMarkerScan {
  const table = new Map<number, ProcessEntry>();
  const commands = new Map<number, string>();
  const unreadablePids = new Set<number>();
  for (const line of stdout.split('\n')) {
    const actual = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S{3}\s+\S{3}\s+\d+\s+\S+\s+\d{4})\s+(.*)$/u.exec(line);
    const synthetic = actual ??
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!synthetic) continue;
    const pid = Number(synthetic[1]);
    table.set(pid, {
      ppid: Number(synthetic[2]),
      pgid: Number(synthetic[3]),
      state: synthetic[4],
      startTime: synthetic[5].replace(/\s+/gu, ' '),
    });
    commands.set(pid, synthetic[6]);
    // macOS ps can retain an earlier live state after argv/environment becomes unreadable.
    const command = synthetic[6].trim();
    if (!command || command === '<defunct>' || /^\([^)]*\)$/u.test(command)) {
      unreadablePids.add(pid);
    }
  }
  return { table, commands, unreadablePids };
}

function parseMarkerProcessIds(
  scan: PosixMarkerScan,
  markerEnvironmentVariable: string,
  marker: string,
): Set<number> {
  const processIds = new Set<number>();
  const assignment = `${markerEnvironmentVariable}=${marker}`;
  for (const [pid, command] of scan.commands) {
    if (command.split(/\s+/u).includes(assignment)) processIds.add(pid);
  }
  return processIds;
}

async function readPosixProcessTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  markerEnvironmentVariable: string,
  marker?: string,
  timeoutMs: number = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS,
  confirmUnmarkedPid?: number,
): Promise<PosixProcessSnapshot | null> {
  const identityArgs = ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='];
  const markerArgs = ['eww', '-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=,command='];
  const lookupStartedAt = Date.now();
  const [identityResult, initialMarkerResult] = await Promise.all([
    runCommandWithDiagnostics('ps', identityArgs, execFileImpl, timeoutMs),
    marker === undefined
      ? Promise.resolve<ProcessCommandResult>({ output: '' })
      : runCommandWithDiagnostics('ps', markerArgs, execFileImpl, timeoutMs),
  ]);
  if (identityResult.output === null) return null;
  let markerResult = initialMarkerResult;
  let markerLookupAttempts = marker === undefined ? 0 : 1;
  const retryTimeoutMs = timeoutMs - (Date.now() - lookupStartedAt);
  if (marker !== undefined && markerResult.output === null && retryTimeoutMs > 0) {
    markerLookupAttempts += 1;
    markerResult = await runCommandWithDiagnostics(
      'ps',
      markerArgs,
      execFileImpl,
      retryTimeoutMs,
    );
  }
  const markerOutput = markerResult.output;
  const markerScan = markerOutput === null ? undefined : parsePosixMarkerScan(markerOutput);
  const table = markerScan?.table ?? parsePosixProcessTable(identityResult.output);
  const markerPids = marker === undefined || !markerScan
    ? new Set<number>()
    : parseMarkerProcessIds(markerScan, markerEnvironmentVariable, marker);
  const confirmedUnmarkedPids = new Set<number>();
  const unmarkedEntry = confirmUnmarkedPid === undefined || markerPids.has(confirmUnmarkedPid)
    ? undefined
    : table.get(confirmUnmarkedPid);
  if (unmarkedEntry && !unmarkedEntry.state?.startsWith('Z')) {
    const confirmationOutput = await runCommand('ps', markerArgs, execFileImpl, timeoutMs);
    if (confirmationOutput === null) return null;
    const confirmationScan = parsePosixMarkerScan(confirmationOutput);
    const confirmedEntry = confirmationScan.table.get(confirmUnmarkedPid!);
    if (
      confirmedEntry?.startTime === unmarkedEntry.startTime &&
      !parseMarkerProcessIds(
        confirmationScan,
        markerEnvironmentVariable,
        marker!,
      ).has(confirmUnmarkedPid!) &&
      !confirmedEntry.state?.startsWith('Z')
    ) {
      confirmedUnmarkedPids.add(confirmUnmarkedPid!);
    }
  }
  return {
    table,
    markerPids,
    unreadableMarkerPids: markerScan?.unreadablePids ?? new Set(),
    markerLookupSucceeded: marker === undefined || markerOutput !== null,
    markerLookupAttempts,
    ...(markerResult.failure ? { markerLookupFailure: markerResult.failure } : {}),
    confirmedUnmarkedPids,
  };
}

function readPosixIdentityTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): Promise<ProcessCommandResult> {
  return runCommandWithDiagnostics(
    'ps',
    ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='],
    execFileImpl,
    POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS,
  );
}

function readPosixMarkerOutput(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS,
): Promise<ProcessCommandResult> {
  return runCommandWithDiagnostics(
    'ps',
    ['eww', '-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=,command='],
    execFileImpl,
    timeoutMs,
  );
}

function posixMarkerLookupFailure(
  snapshot: PosixProcessSnapshot,
  stage: string,
): Error {
  const fields = [
    `stage=${stage}`,
    `attempts=${snapshot.markerLookupAttempts}`,
    `reason=${snapshot.markerLookupFailure?.reason ?? 'unknown'}`,
  ];
  if (snapshot.markerLookupFailure?.code !== undefined) {
    fields.push(`code=${snapshot.markerLookupFailure.code}`);
  }
  if (snapshot.markerLookupFailure?.signal !== undefined) {
    fields.push(`signal=${snapshot.markerLookupFailure.signal}`);
  }
  if (snapshot.markerLookupFailure?.killed !== undefined) {
    fields.push(`killed=${snapshot.markerLookupFailure.killed}`);
  }
  return cleanupUnconfirmed(`POSIX process marker lookup failed (${fields.join(', ')}).`);
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
  stage: string,
): Error | undefined {
  if (!snapshot.markerLookupSucceeded) {
    return posixMarkerLookupFailure(snapshot, stage);
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
      throw posixMarkerLookupFailure(snapshot, 'inspection-preflight');
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
    const startTime = match[3];
    const creationTime = /^\d+$/u.test(startTime) ? BigInt(startTime) : undefined;
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      startTime,
      ...(creationTime !== undefined ? { creationTime } : {}),
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

function collectDescendantProcessIds(
  rootPid: number,
  table: ReadonlyMap<number, ProcessEntry>,
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const [processId, entry] of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(processId);
    childrenByParent.set(entry.ppid, children);
  }
  const descendants = new Set<number>();
  const visited = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const childPid of childrenByParent.get(parent) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      descendants.add(childPid);
      pending.push(childPid);
    }
  }
  return descendants;
}

function collectComparableWindowsDescendantProcessIds(
  root: ProcessIdentity | undefined,
  table: ReadonlyMap<number, ProcessEntry>,
): Set<number> {
  if (root?.creationTime === undefined) return new Set();
  const childrenByParent = new Map<number, number[]>();
  for (const [processId, entry] of table) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(processId);
    childrenByParent.set(entry.ppid, children);
  }
  const descendants = new Set<number>();
  const visited = new Set([root.pid]);
  const pending = [root];
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const childPid of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      const entry = table.get(childPid)!;
      if (
        entry.creationTime === undefined ||
        parent.creationTime === undefined ||
        entry.creationTime < parent.creationTime
      ) continue;
      descendants.add(childPid);
      pending.push({
        pid: childPid,
        startTime: entry.startTime,
        creationTime: entry.creationTime,
      });
    }
  }
  return descendants;
}

function refreshDescendants(
  root: ProcessIdentity | undefined,
  knownDescendants: Map<number, ProcessIdentity>,
  table: ReadonlyMap<number, ProcessEntry>,
  requireComparableCreationOrder: boolean = false,
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
  const pending = [...roots];
  const visited = new Set(pending.map((identity) => identity.pid));
  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const descendantPid of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(descendantPid)) continue;
      visited.add(descendantPid);
      const entry = table.get(descendantPid)!;
      if (
        requireComparableCreationOrder &&
        (
          parent.creationTime === undefined ||
          entry.creationTime === undefined ||
          entry.creationTime < parent.creationTime
        )
      ) continue;
      const knownIdentity = knownDescendants.get(descendantPid);
      if (knownIdentity && knownIdentity.startTime !== entry.startTime) continue;
      const identity = {
        pid: descendantPid,
        startTime: entry.startTime,
        ...(entry.creationTime !== undefined ? { creationTime: entry.creationTime } : {}),
      };
      knownDescendants.set(descendantPid, identity);
      pending.push(identity);
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
    if (entry && (state.platform !== 'win32' || entry.creationTime !== undefined)) {
      state.root = {
        pid: state.pid,
        startTime: entry.startTime,
        ...(entry.creationTime !== undefined ? { creationTime: entry.creationTime } : {}),
      };
    }
  }
  state.rootDiscoveryPending = false;
  for (const processId of markerPids) {
    if (processId === state.lease?.sentinel.pid) continue;
    if (processId === state.root?.pid) continue;
    const entry = table.get(processId);
    if (!entry) continue;
    if (state.platform === 'win32' && entry.creationTime === undefined) continue;
    const known = state.descendants.get(processId);
    if (!known || known.startTime === entry.startTime) {
      state.descendants.set(processId, {
        pid: processId,
        startTime: entry.startTime,
        ...(entry.creationTime !== undefined ? { creationTime: entry.creationTime } : {}),
      });
    }
  }
  if (state.platform === 'win32' || state.marker === undefined) {
    refreshDescendants(
      state.root,
      state.descendants,
      table,
      state.platform === 'win32',
    );
  }
}

function posixDiagnostic(
  state: ObservationState,
  snapshot: PosixProcessSnapshot | undefined,
  stage: string,
  reason: string,
  affectedPids: number[] = [],
): ProcessTreeDiagnostic {
  const identities = new Map([state.root, ...state.descendants.values()]
    .filter((identity): identity is ProcessIdentity => identity !== undefined)
    .map((identity) => [identity.pid, identity.startTime]));
  const pids = new Set([state.pid, ...identities.keys(), ...affectedPids]);
  for (const [pid, entry] of snapshot?.table ?? []) {
    if (pid === state.lease?.sentinel.pid) continue;
    if (snapshot?.markerPids.has(pid) ||
      (state.rootPgid !== undefined && entry.pgid === state.rootPgid)) pids.add(pid);
  }
  return {
    capturedAt: new Date().toISOString(),
    stage,
    reason,
    rootPid: state.pid,
    rootPgid: state.rootPgid,
    rootPgidMode: state.rootPgidMode,
    affectedPids,
    markerLookupSucceeded: snapshot?.markerLookupSucceeded ?? null,
    ...(snapshot?.markerLookupFailure ? { lookupFailure: snapshot.markerLookupFailure } : {}),
    processes: [...pids].sort((a, b) => a - b).map((pid) => {
      const entry = snapshot?.table.get(pid);
      return {
        pid,
        present: snapshot ? entry !== undefined : null,
        knownStartTime: identities.get(pid),
        ...(entry ? {
          ppid: entry.ppid,
          pgid: entry.pgid,
          startTime: entry.startTime,
          state: entry.state,
        } : {}),
        markerMatches: snapshot?.markerLookupSucceeded && state.marker !== undefined &&
          !snapshot.unreadableMarkerPids.has(pid)
          ? snapshot.markerPids.has(pid)
          : null,
      };
    }),
  };
}

function latchObservationFailure(
  state: ObservationState,
  error: Error,
  diagnostic?: ProcessTreeDiagnostic,
): void {
  if (state.failure) return;
  state.failure = error;
  if (diagnostic) state.diagnostics.push(diagnostic);
  else if (state.platform !== 'win32') {
    state.diagnostics.push(posixDiagnostic(state, undefined, 'observation', error.message));
  }
  for (const listener of state.failureListeners) listener(error);
}

function isRelevantPosixProcess(state: ObservationState, pid: number, entry: ProcessEntry): boolean {
  return pid === state.pid || pid === state.lease?.sentinel.pid ||
    state.descendants.get(pid)?.startTime === entry.startTime ||
    entry.pgid === (state.rootPgid ?? state.pid);
}

async function acceptPosixSnapshot(
  state: ObservationState,
  snapshot: PosixProcessSnapshot,
  stage: string,
): Promise<boolean> {
  const fail = (error: Error, reason: string, affectedPids: number[] = []): void => {
    if (state.failure) return;
    latchObservationFailure(state, error, posixDiagnostic(state, snapshot, stage, reason, affectedPids));
  };
  const enforceProcessMarker = state.dependencies.enforceProcessMarker === true ||
    state.dependencies.enforceCooperativeProcessGroup === true;
  if (!snapshot.markerLookupSucceeded && state.marker !== undefined) {
    fail(posixMarkerLookupFailure(snapshot, stage), 'marker-lookup-failed');
    return false;
  }
  const needsConfirmation = (pid: number): boolean => {
    const entry = snapshot.table.get(pid);
    return entry !== undefined && !entry.state?.startsWith('Z') && isRelevantPosixProcess(state, pid, entry);
  };
  const unreadablePids = [...snapshot.unreadableMarkerPids].filter(needsConfirmation);
  if (state.marker !== undefined && unreadablePids.length > 0) {
    const remaining = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS -
      (Date.now() - (snapshot.markerScanStartedAt ?? Date.now()));
    snapshot.markerLookupAttempts += 1;
    const confirmation = remaining > 0
      ? await readPosixMarkerOutput(state.dependencies.execFile ?? defaultExecFile, remaining)
      : { output: null, failure: commandFailure('deadline-exceeded') };
    if (confirmation.output === null) {
      snapshot.markerLookupSucceeded = false;
      snapshot.markerLookupFailure = confirmation.failure;
      fail(posixMarkerLookupFailure(snapshot, stage), 'marker-lookup-failed');
      return false;
    }
    const confirmed = parsePosixMarkerScan(confirmation.output);
    const confirmedMarkers = parseMarkerProcessIds(confirmed, state.markerEnvironmentVariable, state.marker);
    // Each observer confirms its own suspect PIDs, even when the initial scan is shared.
    // Keep other evidence unchanged and retain start times to protect against PID reuse.
    snapshot.table = new Map(snapshot.table);
    snapshot.unreadableMarkerPids = new Set(snapshot.unreadableMarkerPids);
    for (const pid of unreadablePids) {
      const entry = confirmed.table.get(pid);
      if (entry) snapshot.table.set(pid, entry);
      else snapshot.table.delete(pid);
      if (confirmedMarkers.has(pid)) snapshot.markerPids.add(pid);
      else snapshot.markerPids.delete(pid);
      if (confirmed.unreadablePids.has(pid)) snapshot.unreadableMarkerPids.add(pid);
      else snapshot.unreadableMarkerPids.delete(pid);
    }
    const stillUnreadable = unreadablePids.filter((pid) =>
      snapshot.unreadableMarkerPids.has(pid) && needsConfirmation(pid));
    if (stillUnreadable.length > 0) {
      fail(
        cleanupUnconfirmed('POSIX process marker could not be read for a live provider process after confirmation.'),
        'process-marker-unreadable',
        stillUnreadable,
      );
    }
  }
  if (state.lease) {
    const leaseFailure = validateLeaseSnapshot(snapshot, state.lease, stage);
    if (leaseFailure) {
      fail(leaseFailure, 'inspection-lease-invalid');
      return false;
    }
  }
  const rootEntry = snapshot.table.get(state.pid);
  let confirmedUnmarkedRoot = snapshot.confirmedUnmarkedPids.has(state.pid);
  if (
    state.marker !== undefined &&
    rootEntry !== undefined &&
    !rootEntry.state?.startsWith('Z') &&
    (state.root === undefined || state.root.startTime === rootEntry.startTime) &&
    !snapshot.markerPids.has(state.pid)
  ) {
    confirmedUnmarkedRoot ||=
      state.unmarkedRootCandidate?.startTime === rootEntry.startTime;
    state.unmarkedRootCandidate = { pid: state.pid, startTime: rootEntry.startTime };
  } else {
    state.unmarkedRootCandidate = undefined;
  }
  if (
    state.marker !== undefined &&
    enforceProcessMarker &&
    rootEntry !== undefined &&
    !rootEntry.state?.startsWith('Z') &&
    confirmedUnmarkedRoot
  ) {
    fail(
      cleanupUnconfirmed(
        'custom process contract violation: a live provider process lost its process marker.',
      ),
      'root-marker-missing',
      [state.pid],
    );
  }
  refreshObservedProcesses(state, snapshot.table, snapshot.markerPids);
  if (state.marker !== undefined) {
    const providerMarkerPids = [...snapshot.markerPids].filter(
      (pid) => pid !== state.lease?.sentinel.pid,
    );
    if (state.rootPgidMode === undefined) {
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
          if (state.dependencies.enforceCooperativeProcessGroup === true) {
            fail(
              cleanupUnconfirmed(
                'custom process contract violation: the provider root left its initial process group.',
              ),
              'root-process-group-changed',
              [state.pid],
            );
          }
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
      state.dependencies.enforceCooperativeProcessGroup === true &&
      expectedPgid !== undefined &&
      providerMarkerPids.some((pid) => {
        const entry = snapshot.table.get(pid);
        return entry?.pgid !== undefined && entry.pgid !== expectedPgid;
      })
    ) {
      fail(
        cleanupUnconfirmed(
          'custom process contract violation: a marked process left its initial process group.',
        ),
        'marked-process-group-changed',
        providerMarkerPids.filter((pid) => snapshot.table.get(pid)?.pgid !== expectedPgid),
      );
    }
    const liveKnownIdentities = [state.root, ...state.descendants.values()].filter(
      (identity): identity is ProcessIdentity =>
        identityMatches(identity, snapshot.table) &&
        !snapshot.table.get(identity.pid)?.state?.startsWith('Z'),
    );
    const markerlessKnownPids = liveKnownIdentities
      .filter((identity) => !snapshot.markerPids.has(identity.pid))
      .map((identity) => identity.pid);
    const markerlessInitialGroupPids: number[] = [];
    const groupLeader = state.rootPgid === undefined
      ? undefined
      : snapshot.table.get(state.rootPgid);
    const groupLeaderWasReused =
      state.rootPgidMode === 'owned' &&
      groupLeader !== undefined &&
      groupLeader.startTime !== state.root?.startTime;
    if (state.rootPgid !== undefined && !groupLeaderWasReused) {
      for (const [pid, entry] of snapshot.table) {
        if (entry.pgid !== state.rootPgid || entry.state?.startsWith('Z')) continue;
        if (pid !== state.pid && !snapshot.markerPids.has(pid)) {
          markerlessInitialGroupPids.push(pid);
        }
      }
    }
    if (
      enforceProcessMarker &&
      (markerlessKnownPids.length > 0 || markerlessInitialGroupPids.length > 0)
    ) {
      fail(
        cleanupUnconfirmed(
          'custom process contract violation: a live provider process lost its process marker.',
        ),
        markerlessKnownPids.length > 0 ? 'known-process-marker-missing' : 'initial-group-marker-missing',
        [...new Set([...markerlessKnownPids, ...markerlessInitialGroupPids])],
      );
    }
  }
  return true;
}

function getPosixProcessSampler(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
): PosixProcessSampler {
  const existing = posixSamplers.get(execFileImpl);
  if (existing) return existing;
  const sampler: PosixProcessSampler = {
    execFile: execFileImpl,
    states: new Set(),
    identityScannedAt: Number.NEGATIVE_INFINITY,
    markerScannedAt: Number.NEGATIVE_INFINITY,
  };
  posixSamplers.set(execFileImpl, sampler);
  return sampler;
}

function snapshotFromSampler(
  state: ObservationState,
  sampler: PosixProcessSampler,
): PosixProcessSnapshot | undefined {
  const markerLookupSucceeded = state.marker === undefined || sampler.markerFailure === undefined;
  const table = state.marker === undefined || !markerLookupSucceeded
    ? sampler.identityTable
    : sampler.markerScan?.table;
  if (!table) return undefined;
  const markerPids =
    state.marker === undefined || !markerLookupSucceeded || sampler.markerScan === undefined
      ? new Set<number>()
      : parseMarkerProcessIds(
          sampler.markerScan,
          state.markerEnvironmentVariable,
          state.marker,
        );
  return {
    table,
    markerPids,
    unreadableMarkerPids: sampler.markerScan?.unreadablePids ?? new Set(),
    markerLookupSucceeded,
    markerLookupAttempts: state.marker === undefined ? 0 : 1,
    markerScanStartedAt: sampler.markerScannedAt,
    ...(sampler.markerFailure ? { markerLookupFailure: sampler.markerFailure } : {}),
    confirmedUnmarkedPids: new Set<number>(),
  };
}

function deliverSamplerIdentity(sampler: PosixProcessSampler): void {
  for (const state of sampler.states) {
    if (state.disposed) continue;
    if (sampler.identityFailure) {
      latchObservationFailure(
        state,
        cleanupUnconfirmed('POSIX process identity lookup failed.'),
        {
          ...posixDiagnostic(state, undefined, 'observation', 'identity-lookup-failed'),
          lookupFailure: sampler.identityFailure,
        },
      );
      continue;
    }
    if (state.marker !== undefined) {
      if (sampler.identityTable) {
        refreshDescendants(state.root, state.descendants, sampler.identityTable);
      }
      const expectedPgid = state.rootPgidMode === 'owned'
        ? state.rootPgid
        : state.rootPgidMode === 'missing'
          ? state.pid
          : undefined;
      if (
        state.dependencies.enforceCooperativeProcessGroup === true &&
        expectedPgid !== undefined &&
        [state.root, ...state.descendants.values()].some((identity) => {
          if (!identity || !sampler.identityTable) return false;
          const entry = sampler.identityTable.get(identity.pid);
          return entry?.startTime === identity.startTime &&
            entry.pgid !== undefined && entry.pgid !== expectedPgid;
        })
      ) {
        latchObservationFailure(
          state,
          cleanupUnconfirmed(
            'custom process contract violation: a marked process left its initial process group.',
          ),
        );
      }
      continue;
    }
    const snapshot = snapshotFromSampler(state, sampler);
    if (snapshot) acceptPosixSnapshot(state, snapshot, 'observation');
  }
}

async function deliverSamplerMarkers(sampler: PosixProcessSampler, stage: string): Promise<void> {
  await Promise.all([...sampler.states].map(async (state) => {
    if (state.disposed || state.marker === undefined) return;
    const snapshot = snapshotFromSampler(state, sampler);
    if (snapshot) await acceptPosixSnapshot(state, snapshot, stage);
  }));
}

function scanSamplerIdentity(
  sampler: PosixProcessSampler,
  force: boolean,
): Promise<void> {
  if (sampler.identityInFlight) return sampler.identityInFlight;
  const now = Date.now();
  if (
    !force &&
    Number.isFinite(sampler.identityScannedAt) &&
    now - sampler.identityScannedAt < PROCESS_TREE_IDENTITY_INTERVAL_MS
  ) return Promise.resolve();
  sampler.identityScannedAt = now;
  sampler.identityInFlight = readPosixIdentityTable(sampler.execFile)
    .then((result) => {
      sampler.identityFailure = result.failure;
      sampler.identityTable = result.output === null
        ? undefined
        : parsePosixProcessTable(result.output);
      deliverSamplerIdentity(sampler);
    })
    .finally(() => {
      sampler.identityInFlight = undefined;
    });
  return sampler.identityInFlight;
}

function runMarkerScan(
  sampler: PosixProcessSampler,
): Promise<void> {
  sampler.markerScannedAt = Date.now();
  sampler.markerInFlight = readPosixMarkerOutput(sampler.execFile)
    .then((result) => {
      sampler.markerFailure = result.failure;
      sampler.markerScan = result.output === null ? undefined : parsePosixMarkerScan(result.output);
      return deliverSamplerMarkers(sampler, 'observation');
    })
    .finally(() => {
      sampler.markerInFlight = undefined;
    });
  return sampler.markerInFlight;
}

function scanSamplerMarkers(
  sampler: PosixProcessSampler,
  force: boolean,
): Promise<void> {
  if (sampler.markerInFlight) return sampler.markerInFlight;
  const now = Date.now();
  if (
    !force &&
    Number.isFinite(sampler.markerScannedAt) &&
    now - sampler.markerScannedAt < PROCESS_TREE_MARKER_INTERVAL_MS
  ) return Promise.resolve();
  return runMarkerScan(sampler);
}

function schedulePosixSampler(sampler: PosixProcessSampler): void {
  if (sampler.timer) clearTimeout(sampler.timer);
  sampler.timer = undefined;
  if (sampler.states.size === 0) return;
  const now = Date.now();
  const identityDelay = Math.max(
    0,
    PROCESS_TREE_IDENTITY_INTERVAL_MS - (now - sampler.identityScannedAt),
  );
  const markerDelay = [...sampler.states].some((state) => state.marker !== undefined)
    ? Math.max(0, PROCESS_TREE_MARKER_INTERVAL_MS - (now - sampler.markerScannedAt))
    : Number.POSITIVE_INFINITY;
  const delayMs = Math.min(identityDelay, markerDelay);
  sampler.timer = setTimeout(() => {
    sampler.timer = undefined;
    const current = Date.now();
    const scans: Promise<void>[] = [];
    if (current - sampler.identityScannedAt >= PROCESS_TREE_IDENTITY_INTERVAL_MS) {
      scans.push(scanSamplerIdentity(sampler, false));
    }
    if (
      markerDelay !== Number.POSITIVE_INFINITY &&
      current - sampler.markerScannedAt >= PROCESS_TREE_MARKER_INTERVAL_MS
    ) {
      scans.push(scanSamplerMarkers(sampler, false));
    }
    void Promise.all(scans).finally(() => schedulePosixSampler(sampler));
  }, delayMs);
  sampler.timer.unref();
}

function stopObservingPosixState(state: ObservationState): void {
  const sampler = state.sampler;
  if (!sampler) return;
  state.sampler = undefined;
  sampler.states.delete(state);
  schedulePosixSampler(sampler);
}

async function readImmediatePosixSnapshot(
  state: ObservationState,
  stage: string,
): Promise<PosixProcessSnapshot | undefined> {
  const sampler = state.sampler ?? getPosixProcessSampler(
    state.dependencies.execFile ?? defaultExecFile,
  );
  if (state.marker === undefined) await scanSamplerIdentity(sampler, true);
  else await scanSamplerMarkers(sampler, true);
  if (state.marker === undefined && sampler.identityFailure) {
    const diagnostic = {
      ...posixDiagnostic(state, undefined, stage, 'identity-lookup-failed'),
      lookupFailure: sampler.identityFailure,
    };
    latchObservationFailure(
      state,
      cleanupUnconfirmed('POSIX process identity lookup failed.'),
      diagnostic,
    );
    state.diagnostics[1] = diagnostic;
    return undefined;
  }
  if (state.marker !== undefined && sampler.markerFailure) {
    const failedSnapshot: PosixProcessSnapshot = {
      table: sampler.identityTable ?? new Map(),
      markerPids: new Set(),
      unreadableMarkerPids: new Set(),
      markerLookupSucceeded: false,
      markerLookupAttempts: 1,
      markerLookupFailure: sampler.markerFailure,
      confirmedUnmarkedPids: new Set(),
    };
    const diagnostic = posixDiagnostic(state, failedSnapshot, stage, 'marker-lookup-failed');
    latchObservationFailure(
      state,
      posixMarkerLookupFailure(failedSnapshot, stage),
      diagnostic,
    );
    state.diagnostics[1] = diagnostic;
    return undefined;
  }
  const snapshot = snapshotFromSampler(state, sampler);
  if (!snapshot) return undefined;
  await acceptPosixSnapshot(state, snapshot, stage);
  // Keep only the first failure and the latest cleanup scan, even if inspection recovers.
  if (state.failure) state.diagnostics[1] = posixDiagnostic(state, snapshot, stage, 'cleanup-snapshot');
  return snapshot;
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
    get diagnostics() {
      return observationStates.get(observation)?.diagnostics.slice() ?? [];
    },
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
        stopObservingPosixState(state);
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
    initialWindowsLookupSucceeded: false,
    descendants: new Map<number, ProcessIdentity>(),
    diagnostics: [],
    failureListeners: new Set<(error: Error) => void>(),
    disposed: false,
    initialLookup: Promise.resolve(),
  };
  observationStates.set(observation, state);
  if (!startLookup) return observation;
  const execFileImpl = dependencies.execFile ?? defaultExecFile;
  if (state.platform === 'win32') {
    state.initialLookup = readWindowsProcessTable(execFileImpl).then((table) => {
      if (!state.disposed && table) {
        state.initialWindowsLookupSucceeded = true;
        refreshObservedProcesses(state, table);
      }
    });
    return observation;
  }
  const sampler = getPosixProcessSampler(execFileImpl);
  const periodic = dependencies.enforceProcessMarker === true ||
    dependencies.enforceCooperativeProcessGroup === true;
  if (periodic) {
    state.sampler = sampler;
    sampler.states.add(state);
  }
  state.initialLookup = (marker === undefined
    ? scanSamplerIdentity(sampler, true)
    : Promise.all([
        ...(periodic ? [scanSamplerIdentity(sampler, true)] : []),
        scanSamplerMarkers(sampler, true),
      ])
  ).then(async () => {
    if (state.disposed) return;
    if (periodic) return;
    const snapshot = snapshotFromSampler(state, sampler);
    if (snapshot) await acceptPosixSnapshot(state, snapshot, 'observation');
  });
  if (periodic) void state.initialLookup.finally(() => schedulePosixSampler(sampler));
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
    state.marker === undefined ||
    state.rootPgid === undefined ||
    state.rootPgid !== state.pid
  ) return undefined;
  const pgid = state.rootPgid;
  const members = [...snapshot.table].filter(([, entry]) =>
    entry.pgid === pgid && !entry.state?.startsWith('Z')
  );
  if (members.length === 0) return undefined;
  if (state.rootPgidMode === 'owned') {
    const currentLeader = snapshot.table.get(pgid);
    if (
      currentLeader !== undefined &&
      currentLeader.startTime !== state.root?.startTime
    ) return undefined;
    return pgid;
  }
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
  allowUnobservedProcessOnNormalCompletion: boolean,
): Promise<void> {
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  if (!requireConfirmedCleanup) {
    if (!(await runTaskkill(state.pid, execFileImpl))) {
      throw cleanupUnconfirmed('taskkill did not confirm termination.');
    }
    return;
  }
  const identitiesBeforeNormalCompletion = allowUnobservedProcessOnNormalCompletion
    ? {
        root: state.root,
        descendants: new Map(state.descendants),
      }
    : undefined;
  await state.initialLookup;
  const table = await readWindowsProcessTable(execFileImpl);
  if (!table) {
    throw cleanupUnconfirmed('Windows process identity lookup failed.');
  }
  refreshObservedProcesses(state, table);
  const root = identitiesBeforeNormalCompletion
    ? identitiesBeforeNormalCompletion.root
    : state.root;
  const descendants = identitiesBeforeNormalCompletion?.descendants ?? state.descendants;
  const observedIdentities = [root, ...descendants.values()].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  const candidatePids = collectDescendantProcessIds(state.pid, table);
  const comparableCandidatePids = collectComparableWindowsDescendantProcessIds(root, table);
  const hasInvalidCandidateEdge = [...candidatePids].some(
    (pid) => !comparableCandidatePids.has(pid),
  );
  const hasUnobservedCandidate = [...candidatePids].some((pid) =>
    !identityMatches(descendants.get(pid), table)
  );
  const observedPidWasReused = (candidateTable: ReadonlyMap<number, ProcessEntry>): boolean =>
    observedIdentities.some((identity) => {
      const entry = candidateTable.get(identity.pid);
      return entry !== undefined && entry.startTime !== identity.startTime;
    });
  const rootTarget = identityMatches(root, table) ? root : undefined;
  const liveDescendants = [...descendants.values()].filter((identity) =>
    identityMatches(identity, table)
  );
  const liveDescendantPids = new Set(liveDescendants.map((identity) => identity.pid));
  const targets = rootTarget
    ? [rootTarget]
    : liveDescendants.filter((identity) =>
      !liveDescendantPids.has(table.get(identity.pid)!.ppid)
    );
  const taskkillResults = hasInvalidCandidateEdge || hasUnobservedCandidate
    ? []
    : await Promise.all(
      targets.map((identity) => runTaskkill(identity.pid, execFileImpl)),
    );
  if (taskkillResults.some((result) => !result)) {
    throw cleanupUnconfirmed('taskkill did not confirm termination.');
  }
  const verifiedTable = await readWindowsProcessTable(execFileImpl);
  if (!verifiedTable) throw cleanupUnconfirmed('Windows termination verification failed.');
  const verifiedCandidatePids = collectDescendantProcessIds(state.pid, verifiedTable);
  const verifiedIdentities = [rootTarget, ...liveDescendants].filter(
    (identity): identity is ProcessIdentity => identity !== undefined,
  );
  if (verifiedIdentities.some((identity) => identityMatches(identity, verifiedTable))) {
    throw cleanupUnconfirmed('a verified Windows process is still running.');
  }
  if (hasInvalidCandidateEdge) {
    throw cleanupUnconfirmed(
      hasUnobservedCandidate
        ? 'an unobserved Windows descendant candidate has invalid process creation order.'
        : 'a Windows descendant candidate has invalid process creation order.',
    );
  }
  if (hasUnobservedCandidate) {
    throw cleanupUnconfirmed(
      'an unobserved Windows descendant candidate was found after the root exited.',
    );
  }
  if (verifiedCandidatePids.size > 0) {
    throw cleanupUnconfirmed('a Windows descendant candidate is still running.');
  }
  const unobservedNormalCompletionIsAllowed =
    allowUnobservedProcessOnNormalCompletion &&
    state.initialWindowsLookupSucceeded &&
    !table.has(state.pid) &&
    candidatePids.size === 0 &&
    !verifiedTable.has(state.pid) &&
    verifiedCandidatePids.size === 0;
  if (
    requireConfirmedCleanup &&
    targets.length === 0 &&
    (
      observedPidWasReused(table) ||
      observedPidWasReused(verifiedTable) ||
      (observedIdentities.length === 0 && !unobservedNormalCompletionIsAllowed)
    )
  ) {
    throw cleanupUnconfirmed(
      observedIdentities.length > 0
        ? 'an observed Windows process identifier was reused.'
        : 'no inherited-pipe process identity was observed.',
    );
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
  stopObservingPosixState(state);
  const kill = state.dependencies.kill ?? process.kill.bind(process);
  let snapshot = await readImmediatePosixSnapshot(state, 'termination-start');
  if (!snapshot) {
    if (!requireConfirmedCleanup && allowInspectionUnavailable) return;
    throw state.failure ?? cleanupUnconfirmed('POSIX process identity lookup failed.');
  }
  if (requireDescendantsExitedBeforeCompletion) {
    latchLiveDescendantCompletionFailure(state, snapshot);
  }
  const liveIdentities = (current: PosixProcessSnapshot): ProcessIdentity[] =>
    [state.root, ...state.descendants.values()].filter(
      (identity): identity is ProcessIdentity =>
        posixIdentityMatches(identity, current) &&
        !current.table.get(identity.pid)?.state?.startsWith('Z'),
    );
  const liveMarkerPids = (current: PosixProcessSnapshot): number[] =>
    state.marker === undefined
      ? []
      : [...current.markerPids].filter((pid) =>
          pid !== state.lease?.sentinel.pid &&
          !current.table.get(pid)?.state?.startsWith('Z')
        );
  const signalOwned = (current: PosixProcessSnapshot, signal: KillSignal): void => {
    if (state.marker !== undefined && !current.markerLookupSucceeded) return;
    signalProcessGroup(safelyOwnedProcessGroup(state, current), signal, kill);
    for (const identity of liveIdentities(current).reverse()) {
      signalIdentity(identity, current, signal, kill);
    }
  };

  const initialTargets = liveIdentities(snapshot);
  const initialMarkerPids = liveMarkerPids(snapshot);
  const initialProcessGroup = safelyOwnedProcessGroup(state, snapshot);
  if (
    initialTargets.length === 0 &&
    initialMarkerPids.length === 0 &&
    initialProcessGroup === undefined
  ) {
    if (requireConfirmedCleanup && state.marker === undefined) {
      throw cleanupUnconfirmed('no inherited-pipe process identity was observed.');
    }
    if (state.failure) throw state.failure;
    return;
  }

  signalOwned(snapshot, 'SIGTERM');
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PROCESS_TREE_TERMINATION_GRACE_MS);
  });
  const killSnapshot = await readImmediatePosixSnapshot(state, 'termination-kill');
  if (!killSnapshot) {
    throw state.failure ?? cleanupUnconfirmed('POSIX termination audit failed.');
  }
  snapshot = killSnapshot;
  signalOwned(snapshot, 'SIGKILL');
  await new Promise<void>((resolve) => {
    setTimeout(resolve, PROCESS_TREE_TERMINATION_SETTLE_MS);
  });
  const verified = await readImmediatePosixSnapshot(state, 'termination-verification');
  if (!verified) {
    throw state.failure ?? cleanupUnconfirmed('POSIX termination verification failed.');
  }
  if (liveIdentities(verified).length > 0) {
    throw state.failure ?? cleanupUnconfirmed('a verified POSIX descendant is still running.');
  }
  if (liveMarkerPids(verified).length > 0) {
    throw state.failure ?? cleanupUnconfirmed('an unverified marker process is still running.');
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
        options.allowUnobservedWindowsProcessOnNormalCompletion ?? false,
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
