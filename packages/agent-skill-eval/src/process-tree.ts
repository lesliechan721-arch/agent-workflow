import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { assertLinuxProcfsProcessVisibility, readLinuxMarkerScan, type LinuxMarkerScan } from './linux-process-marker.js';
import { DARWIN_PROCESS_MARKER_SCRIPT } from './darwin-process-marker.js';
import { readWindowsNativeProcessTable, type WindowsNativeProcessRow } from './windows-native.js';

type KillSignal = 'SIGTERM' | 'SIGKILL';
type PosixSignal = KillSignal | 'SIGSTOP';
const DEFAULT_PROCESS_MARKER_ENV = 'AW_NATIVE_CLI_PROCESS_MARKER';
const PROCESS_TREE_COMMAND_TIMEOUT_MS = 1_000;
const POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS = 2_000;
const DARWIN_PROCESS_TREE_COMMAND_TIMEOUT_MS = 5_000;
// Hosted macOS scans can exceed two seconds. Reserve a bounded confirmation
// window so a successful slow scan does not consume its own follow-up budget.
function posixCommandTimeout(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? DARWIN_PROCESS_TREE_COMMAND_TIMEOUT_MS : POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS;
}

function posixInspectionTimeout(platform: NodeJS.Platform): number {
  return platform === 'darwin'
    ? DARWIN_PROCESS_TREE_COMMAND_TIMEOUT_MS + POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS
    : POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS;
}
const PROCESS_TREE_IDENTITY_INTERVAL_MS = 250;
const PROCESS_TREE_MARKER_INTERVAL_MS = 1_000;
const PROCESS_TREE_TERMINATION_GRACE_MS = 250;
const PROCESS_TREE_SETTLE_MS = 50;
const PROCESS_TREE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const LINUX_PS_INVALID_PGID = 0xffff_ffff;
const MARKER_SCAN_COLLECTION_MS = 2;
const MARKER_SCAN_MIN_SHARED_BUDGET_MS = 20;

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

interface ProcessQueryDiagnostic {
  kind: 'identity' | 'marker' | 'darwin-marker';
  startedAt: number;
  deadline: number;
  callbackAt?: number;
  settledAt?: number;
  callbackState: 'returned' | 'pending' | 'not-called';
  completion: 'pending' | 'callback' | 'deadline' | 'synchronous-error';
  failureReason?: ProcessCommandFailure['reason'];
}

type ProcessCommandResult<T = string> = (
  | { output: T; failure?: never }
  | { output: null; failure: ProcessCommandFailure }
) & { query?: ProcessQueryDiagnostic };
type ProcessCommandPromise<T = string> = Promise<ProcessCommandResult<T>> & { readonly query: ProcessQueryDiagnostic };

interface PosixProcessSnapshot {
  table: Map<number, ProcessEntry>;
  sampledPids?: ReadonlySet<number>;
  markerPids: Set<number>;
  unreadableMarkerPids: Set<number>;
  markerLookupSucceeded: boolean;
  markerLookupAttempts: number;
  markerScanStartedAt?: number;
  markerLookupFailure?: ProcessCommandFailure;
  confirmedUnmarkedPids: Set<number>;
  replacementPids?: Set<number>;
  snapshotStartedAt?: number;
  snapshotDeadline?: number;
  queries?: ProcessQueryDiagnostic[];
}

function posixSnapshotDeadline(
  snapshot: PosixProcessSnapshot,
  platform: NodeJS.Platform,
  deadline = Infinity,
): number {
  return Math.min((snapshot.markerScanStartedAt ?? Date.now()) + posixInspectionTimeout(platform), deadline);
}

function confirmationDeadline(snapshotDeadline: number, queryTimeoutMs = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS): number {
  return Math.min(snapshotDeadline, Date.now() + queryTimeoutMs);
}

interface PsMarkerScan {
  table: Map<number, ProcessEntry>;
  commands: Map<number, string>;
  unreadablePids: Set<number>;
}

type PosixMarkerScan = PsMarkerScan | LinuxMarkerScan;
type MarkerOutput = string | LinuxMarkerScan;

export interface ProcessTreeDependencies {
  platform?: NodeJS.Platform;
  markerEnvironmentVariable?: string;
  /** Coalesce newly requested marker scans for native install cleanup. */
  coalescePosixMarkerScans?: boolean;
  /** Use Linux procfs for the complete lifetime of an explicitly leased observation. */
  linuxProcessInspection?: 'procfs';
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
  /** Physical executor for shared ps samples. Private queries still use execFile. */
  posixSamplerExecFile?: ProcessTreeDependencies['execFile'];
  windowsJobHelperPath?: string;
  windowsProcessTable?: (requiredPids: readonly number[]) => Promise<WindowsNativeProcessRow[]>;
  createSentinel?: (
    markerEnvironmentVariable: string,
    marker: string,
  ) => Promise<ProcessTreeSentinel>;
  /** Diagnostic only. Times are epoch milliseconds; callback failures cannot change inspection. */
  onLinuxMarkerIdentityConfirmation?: (confirmation: {
    rootPid: number;
    pid: number;
    startTime: string;
    phase: 'post-marker-confirmation';
    queryStartedAt: number;
    queryCompletedAt: number;
    deadline: number;
    result: 'absent' | 'present' | 'unknown';
  }) => void;
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
  rootPgidMode?: 'owned' | 'shared' | 'missing' | 'reused';
  affectedPids: number[];
  markerLookupSucceeded: boolean | null;
  lookupFailure?: ProcessCommandFailure;
  snapshotStartedAt?: number;
  snapshotDeadline?: number;
  markerLookupAttempts?: number;
  queries?: ProcessQueryDiagnostic[];
  sentinel?: {
    pid: number;
    knownStartTime: string;
    present: boolean | null;
    startTime?: string;
    identityMatches: boolean | null;
    markerMatches: boolean | null;
  };
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
  coalescePosixMarkerScans: boolean;
  lease?: ProcessTreeInspectionLease;
  dependencies: ProcessTreeDependencies;
  root?: ProcessIdentity;
  rootPgid?: number;
  rootPgidMode?: ProcessTreeDiagnostic['rootPgidMode'];
  rootDiscoveryPending: boolean;
  unmarkedRootCandidate?: ProcessIdentity;
  initialWindowsLookupSucceeded: boolean;
  descendants: Map<number, ProcessIdentity>;
  failure?: Error;
  diagnostics: ProcessTreeDiagnostic[];
  failureListeners: Set<(error: Error) => void>;
  initialLookup: Promise<void>;
  sampler?: PosixProcessSampler;
  excludedInitialMarkerQuery?: Promise<void>;
  initialFreshMarkerRead?: Promise<void>;
  preFreshIdentityQuery?: Promise<void>;
  deferredSamplerDelivery?: Promise<void>;
  finalSamplerQueries?: ReadonlySet<Promise<void> | undefined>;
  disposed: boolean;
}

interface SamplerDeliveries {
  byState: ReadonlyMap<ObservationState, Promise<void>>;
  shared: Promise<void>[];
}

interface PosixProcessSampler {
  readonly linuxMarker?: { name: string; value: string };
  readonly platform: NodeJS.Platform;
  readonly execFile: NonNullable<ProcessTreeDependencies['execFile']>;
  readonly states: Set<ObservationState>;
  identityTable?: Map<number, ProcessEntry>;
  identityFailure?: ProcessCommandFailure;
  identityQuery?: ProcessQueryDiagnostic;
  identityCompletedAt: number;
  identityInFlight?: Promise<void>;
  identityDeliveries?: Promise<SamplerDeliveries>;
  identityDelivering?: boolean;
  markerScan?: PosixMarkerScan;
  markerFailure?: ProcessCommandFailure;
  markerQuery?: ProcessQueryDiagnostic;
  markerCompletedAt: number;
  markerInFlight?: Promise<void>;
  markerDeliveries?: Promise<SamplerDeliveries>;
  markerDelivering?: boolean;
  timer?: NodeJS.Timeout;
}

const observationStates = new WeakMap<ProcessTreeObservation, ObservationState>();
const posixSamplers = new Map<NodeJS.Platform, WeakMap<object, PosixProcessSampler>>();
const linuxInspectionLeases = new WeakMap<ProcessTreeInspectionLease, string>();
const preLeaseMarkerQueries = new WeakMap<ProcessTreeInspectionLease, Promise<void>>();

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

function measureProcessQuery<T>(
  kind: ProcessQueryDiagnostic['kind'],
  timeoutMs: number,
  start: (callback: (result: ProcessCommandResult<T>) => void) => unknown,
  expire?: () => void,
): ProcessCommandPromise<T> {
  const startedAt = Date.now();
  const query: ProcessQueryDiagnostic = {
    kind,
    startedAt, deadline: startedAt + timeoutMs, callbackState: 'pending', completion: 'pending',
  };
  const pending = new Promise<ProcessCommandResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: ProcessCommandResult<T>, completion: ProcessQueryDiagnostic['completion']): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      query.settledAt = Date.now();
      query.completion = completion;
      if (completion === 'synchronous-error' && query.callbackState === 'pending') query.callbackState = 'not-called';
      if (result.failure) query.failureReason = result.failure.reason;
      resolve({ ...result, query: { ...query } });
    };
    const timeout = setTimeout(() => {
      finish({ output: null, failure: commandFailure('deadline-exceeded') }, 'deadline');
      expire?.();
    }, timeoutMs);
    timeout.unref();

    try {
      start((result) => {
        query.callbackAt = Date.now();
        query.callbackState = 'returned';
        finish(result, 'callback');
      });
    } catch (error) {
      finish({ output: null, failure: commandFailure('synchronous-error', error) }, 'synchronous-error');
    }
  });
  return Object.assign(pending, { query });
}

function runCommandWithDiagnostics(
  command: string,
  args: string[],
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs: number,
): ProcessCommandPromise {
  const kind = command === '/usr/bin/osascript' ? 'darwin-marker' : args[0] === 'eww' ? 'marker' : 'identity';
  return measureProcessQuery(kind, timeoutMs, complete => execFileImpl(command, args,
    { timeout: timeoutMs, windowsHide: true, maxBuffer: PROCESS_TREE_MAX_BUFFER_BYTES }, (error, output) =>
      complete(error ? { output: null, failure: commandFailure('callback-error', error) } : { output })));
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
        startTime: groupMatch[5].replace(/\s+/gu, ' '),
      });
      continue;
    }
    const legacyMatch = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!legacyMatch) continue;
    table.set(Number(legacyMatch[1]), {
      ppid: Number(legacyMatch[2]),
      state: legacyMatch[3],
      startTime: legacyMatch[4].replace(/\s+/gu, ' '),
    });
  }
  return table;
}

function parseCompletePosixIdentityTable(stdout: string): Map<number, ProcessEntry> | undefined {
  const lines = stdout.split('\n').filter((line) => line.trim());
  if (lines.length === 0) return undefined;
  const pids = new Set<number>();
  for (const line of lines) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+[A-Za-z?]\s+\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s*$/u.exec(line);
    if (!row) return undefined;
    const pid = Number(row[1]);
    if (pid <= 0 || pids.has(pid) || ![pid, Number(row[2]), Number(row[3])].every(Number.isSafeInteger)) {
      return undefined;
    }
    pids.add(pid);
  }
  return parsePosixProcessTable(stdout);
}

function parsePosixMarkerScan(stdout: MarkerOutput): PosixMarkerScan {
  if (typeof stdout !== 'string') return stdout;
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

function unreadableMarkerPids(
  scan: PosixMarkerScan | undefined,
  platform: NodeJS.Platform,
  markerPids: ReadonlySet<number>,
): Set<number> {
  if (!scan) return new Set();
  if (platform !== 'linux' || 'markerPidsByValue' in scan) return scan.unreadablePids;
  const unreadable = new Set(scan.unreadablePids);
  // procps uses [comm] when command arguments cannot be read. A stale live
  // state does not make that fallback complete environment evidence.
  for (const [pid, command] of scan.commands) {
    if (!markerPids.has(pid) && /^\[[^\]]*\](?:\s+<defunct>)?$/u.test(command.trim())) unreadable.add(pid);
  }
  return unreadable;
}

function parseMarkerProcessIds(
  scan: PosixMarkerScan,
  markerEnvironmentVariable: string,
  marker: string,
): Set<number> {
  if ('markerPidsByValue' in scan) return new Set(scan.markerPidsByValue.get(marker));
  const processIds = new Set<number>();
  const assignment = `${markerEnvironmentVariable}=${marker}`;
  for (const [pid, command] of scan.commands) {
    if (command.split(/\s+/u).includes(assignment)) processIds.add(pid);
  }
  return processIds;
}

async function readPosixProcessTable(
  platform: NodeJS.Platform,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  markerEnvironmentVariable: string,
  marker?: string,
  timeoutMs: number = posixCommandTimeout(platform),
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
  const queries = [identityResult.query, initialMarkerResult.query]
    .filter((query): query is ProcessQueryDiagnostic => query !== undefined);
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
    if (markerResult.query) queries.push(markerResult.query);
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
    unreadableMarkerPids: unreadableMarkerPids(markerScan, platform, markerPids),
    markerLookupSucceeded: marker === undefined || markerOutput !== null,
    markerLookupAttempts,
    markerScanStartedAt: lookupStartedAt,
    snapshotStartedAt: lookupStartedAt,
    snapshotDeadline: lookupStartedAt + posixInspectionTimeout(platform),
    queries,
    ...(markerResult.failure ? { markerLookupFailure: markerResult.failure } : {}),
    confirmedUnmarkedPids,
  };
}

function readPosixIdentityTable(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS,
): ProcessCommandPromise {
  return runCommandWithDiagnostics(
    'ps',
    ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart='],
    execFileImpl,
    timeoutMs,
  );
}

function readPosixMarkerOutput(
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  timeoutMs = POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS,
): ProcessCommandPromise {
  return runCommandWithDiagnostics(
    'ps',
    ['eww', '-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=,command='],
    execFileImpl,
    timeoutMs,
  );
}

function usesLinuxProcfs(state: ObservationState): boolean {
  if (state.dependencies.linuxProcessInspection === 'procfs') return true;
  return state.platform === 'linux' && process.platform === 'linux' && state.dependencies.execFile === undefined
    && state.dependencies.posixSamplerExecFile === undefined
    && state.marker !== undefined && state.markerEnvironmentVariable === DEFAULT_PROCESS_MARKER_ENV
    && !state.lease && !state.dependencies.enforceProcessMarker && !state.dependencies.enforceCooperativeProcessGroup;
}

function queryLinuxMarkers(
  timeoutMs: number,
  markers: Set<string>,
  name = DEFAULT_PROCESS_MARKER_ENV,
  requireProcessVisibility = false,
  selectedPids?: ReadonlySet<number>,
): ProcessCommandPromise<LinuxMarkerScan> {
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  return measureProcessQuery(markers.size ? 'marker' : 'identity', timeoutMs, complete => {
    const read = () => readLinuxMarkerScan(name, markers, controller.signal, PROCESS_TREE_MAX_BUFFER_BYTES, undefined, selectedPids);
    const scan = requireProcessVisibility
      ? assertLinuxProcfsProcessVisibility(controller.signal).then(read)
      : read();
    void scan
      .then(output => complete(performance.now() < deadline ? { output }
        : { output: null, failure: commandFailure('deadline-exceeded') }),
      error => {
        controller.abort();
        complete({ output: null, failure: commandFailure('callback-error', error) });
      });
  }, () => controller.abort());
}

/** @internal Confirms an existing Linux group has only zombie members after group SIGKILL. */
export async function hasOnlyZombieLinuxProcessGroupMembers(pgid: number, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const { output } = await queryLinuxMarkers(
    Math.min(timeoutMs, POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS),
    new Set(),
    DEFAULT_PROCESS_MARKER_ENV,
    true,
  );
  if (output === null) return false;
  const members = [...output.table.values()].filter(entry => entry.pgid === pgid);
  // A zombie thread-group leader can still have another live thread.
  return members.length > 0 && members.every(entry => entry.state === 'Z' && entry.threadCount === 1);
}

interface PendingMarkerScan {
  expiresAt: number;
  marker: string;
  receive(lookup: ProcessCommandPromise<MarkerOutput>): void;
}

// All members of a batch use the same execution backend, inherited process
// view and byte limit. Only requests waiting to launch are kept.
const pendingMarkerScans = new WeakMap<object, PendingMarkerScan[]>();

function readObservationMarkerOutput(state: ObservationState, timeoutMs: number, initial = false): ProcessCommandPromise<MarkerOutput> {
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  const linux = usesLinuxProcfs(state);
  const backend = linux ? queryLinuxMarkers : execFileImpl;
  const launch = (budget: number, markers: Set<string>) => linux
    ? queryLinuxMarkers(budget, markers, state.markerEnvironmentVariable)
    : readPosixMarkerOutput(execFileImpl, budget);
  if ((!state.coalescePosixMarkerScans && !(linux && initial)) || timeoutMs < MARKER_SCAN_MIN_SHARED_BUDGET_MS) {
    return launch(timeoutMs, new Set([state.marker!]));
  }
  const requestedAt = Date.now();
  const expiresAt = performance.now() + timeoutMs;
  const query: ProcessQueryDiagnostic = {
    kind: 'marker', startedAt: requestedAt, deadline: requestedAt + timeoutMs,
    callbackState: 'not-called', completion: 'pending',
  };
  const pending = new Promise<ProcessCommandResult<MarkerOutput>>((resolve) => {
    const expire = (): void => {
      if (query.completion !== 'pending') return;
      query.settledAt = Date.now();
      query.completion = 'deadline';
      query.failureReason = 'deadline-exceeded';
      resolve({ output: null, failure: commandFailure('deadline-exceeded'), query: { ...query } });
    };
    const timer = setTimeout(expire, timeoutMs);
    timer.unref();
    const request: PendingMarkerScan = {
      expiresAt, marker: state.marker!,
      receive(lookup) {
        if (query.completion !== 'pending') return;
        query.startedAt = lookup.query.startedAt;
        query.callbackState = 'pending';
        void lookup.then((result) => {
          clearTimeout(timer);
          if (query.completion !== 'pending') return;
          if (performance.now() >= expiresAt) {
            expire();
            return;
          }
          Object.assign(query, result.query, { deadline: requestedAt + timeoutMs });
          resolve({ ...result, query: { ...query } });
        });
      },
    };
    const waiting = pendingMarkerScans.get(backend);
    if (waiting) {
      waiting.push(request);
      return;
    }
    const batch = [request];
    pendingMarkerScans.set(backend, batch);
    const launchBatch = () => {
      pendingMarkerScans.delete(backend);
      const now = performance.now();
      const live = batch.filter((member) => member.expiresAt > now);
      if (live.length === 0) return;
      const remaining = Math.ceil(Math.max(...live.map((member) => member.expiresAt - now)));
      const lookup = launch(remaining, new Set(live.map(member => member.marker)));
      for (const member of live) member.receive(lookup);
    };
    if (state.coalescePosixMarkerScans) setTimeout(launchBatch, MARKER_SCAN_COLLECTION_MS);
    else queueMicrotask(launchBatch);
  });
  return Object.assign(pending, { query });
}

async function confirmDarwinMarkers(
  snapshot: PosixProcessSnapshot,
  pids: readonly number[],
  markerEnvironmentVariable: string,
  marker: string,
  execFileImpl: NonNullable<ProcessTreeDependencies['execFile']>,
  deadline: number,
): Promise<Map<number, ProcessEntry> | undefined> {
  const query = async (command: string, args: string[]): Promise<ProcessCommandResult> => {
    const remaining = deadline - Date.now();
    return remaining > 0
      ? runCommandWithDiagnostics(command, args, execFileImpl, remaining)
      : { output: null, failure: commandFailure('deadline-exceeded') };
  };
  const failed = (failure: ProcessCommandFailure): undefined => {
    snapshot.markerLookupSucceeded = false;
    snapshot.markerLookupFailure = failure;
    return undefined;
  };
  snapshot.markerLookupAttempts += 1;
  const result = await query('/usr/bin/osascript', ['-l', 'JavaScript', '-e', DARWIN_PROCESS_MARKER_SCRIPT,
    JSON.stringify({ pids, token: Buffer.from(`\0${markerEnvironmentVariable}=${marker}\0`).toString('base64') })]);
  if (result.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(result.query);
  if (result.output === null) return failed(result.failure);
  const markers = new Map<number, boolean | null>();
  try {
    const rows: unknown = JSON.parse(result.output);
    if (!Array.isArray(rows) || rows.length !== pids.length) throw new Error();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !pids.includes(row.pid) || markers.has(row.pid)
        || ![true, false, null].includes(row.marker)
        || !Number.isInteger(row.errno) || row.errno < 0 || row.errno > 255
        || row.marker !== null && row.errno !== 0) throw new Error();
      markers.set(row.pid, row.marker);
    }
  } catch {
    return failed(commandFailure('callback-error', { code: 'DARWIN_MARKER_RESULT_INVALID' }));
  }
  const identity = await query('ps', ['-A', '-o', 'pid=,ppid=,pgid=,state=,lstart=']);
  if (identity.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(identity.query);
  if (identity.output === null) return failed(identity.failure);
  if (Date.now() >= deadline) return failed(commandFailure('deadline-exceeded'));
  const confirmed = parsePosixProcessTable(identity.output);
  if (Date.now() >= deadline) return failed(commandFailure('deadline-exceeded'));
  if (!confirmed.has(process.pid)) {
    return failed(commandFailure('callback-error', { code: 'DARWIN_IDENTITY_RESULT_INVALID' }));
  }
  snapshot.table = new Map(snapshot.table);
  snapshot.unreadableMarkerPids = new Set(snapshot.unreadableMarkerPids);
  for (const pid of pids) {
    const before = snapshot.table.get(pid);
    const after = confirmed.get(pid);
    if (!before || !after || before.startTime !== after.startTime) {
      // Never assign a read to a replacement PID, or signal it using old evidence.
      snapshot.table.delete(pid);
      snapshot.markerPids.delete(pid);
      snapshot.unreadableMarkerPids.delete(pid);
      continue;
    }
    if (after.state?.startsWith('Z')) {
      snapshot.table.set(pid, { ...before, state: after.state });
      snapshot.unreadableMarkerPids.delete(pid);
      continue;
    }
    const matches = markers.get(pid);
    if (matches === true) {
      snapshot.markerPids.add(pid);
      snapshot.unreadableMarkerPids.delete(pid);
    } else {
      snapshot.markerPids.delete(pid);
      if (matches === null) snapshot.unreadableMarkerPids.add(pid);
    }
  }
  // Preserve the original row's PGID as evidence; the caller checks fresh PGIDs
  // separately so neither a departure nor a later return can erase a violation.
  return confirmed;
}

function posixMarkerLookupFailure(
  snapshot: Pick<PosixProcessSnapshot, 'markerLookupAttempts' | 'markerLookupFailure'>,
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
  const procfs = dependencies.linuxProcessInspection === 'procfs';
  if (procfs && (platform !== 'linux' || process.platform !== 'linux' || dependencies.execFile || dependencies.posixSamplerExecFile
    || !dependencies.enforceProcessMarker || dependencies.enforceCooperativeProcessGroup)) {
    throw cleanupUnconfirmed('Linux procfs inspection requires native leased marker observation.');
  }
  const marker = randomUUID();
  const sentinel = await (dependencies.createSentinel ?? defaultCreateSentinel)(
    markerEnvironmentVariable,
    marker,
  );
  try {
    let snapshot: PosixProcessSnapshot | null;
    if (procfs) {
      const preflight = await queryLinuxMarkers(posixCommandTimeout(platform), new Set([marker]), markerEnvironmentVariable);
      if (preflight.output === null) throw cleanupUnconfirmed('Linux inspection preflight lookup failed.');
      snapshot = successfulPosixSnapshot({ platform, markerEnvironmentVariable, marker }, preflight.output, { markerLookupAttempts: 1 });
    } else {
      snapshot = await readPosixProcessTable(platform, dependencies.execFile ?? defaultExecFile, markerEnvironmentVariable, marker);
    }
    if (!snapshot) throw cleanupUnconfirmed('POSIX process identity lookup failed.');
    if (!snapshot.markerLookupSucceeded) {
      throw posixMarkerLookupFailure(snapshot, 'inspection-preflight');
    }
    if (platform === 'darwin' && snapshot.table.has(sentinel.pid) && !snapshot.markerPids.has(sentinel.pid)) {
      await confirmDarwinMarkers(snapshot, [sentinel.pid], markerEnvironmentVariable, marker,
        dependencies.execFile ?? defaultExecFile,
        confirmationDeadline(posixSnapshotDeadline(snapshot, platform)));
      if (!snapshot.markerLookupSucceeded) throw posixMarkerLookupFailure(snapshot, 'inspection-preflight');
    }
    const entry = snapshot.table.get(sentinel.pid);
    if (!entry || !snapshot.markerPids.has(sentinel.pid)) {
      throw cleanupUnconfirmed('POSIX inspection sentinel could not be verified.');
    }
    let released = false;
    const lease: ProcessTreeInspectionLease = {
      marker,
      sentinel: { pid: sentinel.pid, startTime: entry.startTime },
      release: async () => {
        if (released) return;
        released = true;
        await sentinel.stop();
      },
    };
    if (procfs) linuxInspectionLeases.set(lease, markerEnvironmentVariable);
    else {
      // A shared ps scan already launched before preflight succeeded may
      // predate this sentinel. It is not observation evidence for this lease.
      const pending = posixSamplers.get(platform)?.get(dependencies.posixSamplerExecFile ?? dependencies.execFile ?? defaultExecFile)?.markerInFlight;
      if (pending) preLeaseMarkerQueries.set(lease, pending);
    }
    return lease;
  } catch (error) {
    await sentinel.stop();
    throw error;
  }
}

async function readWindowsProcessTable(
  state: ObservationState,
  pendingPids: Iterable<number> = [],
): Promise<Map<number, ProcessEntry> | null> {
  const requiredPids = [...new Set([
    process.pid,
    state.pid,
    ...state.descendants.keys(),
    ...pendingPids,
  ])];
  try {
    const rows = state.dependencies.windowsProcessTable
      ? await state.dependencies.windowsProcessTable(requiredPids)
      : await readWindowsNativeProcessTable(requiredPids, { helperPath: state.dependencies.windowsJobHelperPath });
    return new Map(rows.map((row) => [row.pid, {
      ppid: row.ppid,
      startTime: row.started,
      creationTime: BigInt(row.started),
    }]));
  } catch {
    return null;
  }
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
    // An exact procfs marker can establish a newer lifetime of the same PID.
    // Keep just that identity for subsequent checks, never an older sample.
    if (!known || known.startTime === entry.startTime ||
      (usesLinuxProcfs(state) && BigInt(entry.startTime) > BigInt(known.startTime))) {
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
  const sentinel = state.lease?.sentinel;
  const sentinelEntry = sentinel ? snapshot?.table.get(sentinel.pid) : undefined;
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
    ...(sentinel ? { sentinel: {
      pid: sentinel.pid, knownStartTime: sentinel.startTime,
      present: snapshot ? sentinelEntry !== undefined : null,
      ...(sentinelEntry ? { startTime: sentinelEntry.startTime } : {}),
      identityMatches: snapshot ? sentinelEntry?.startTime === sentinel.startTime : null,
      markerMatches: snapshot?.markerLookupSucceeded && !snapshot.unreadableMarkerPids.has(sentinel.pid)
        ? snapshot.markerPids.has(sentinel.pid) : null,
    } } : {}),
    ...(snapshot ? {
      snapshotStartedAt: snapshot.snapshotStartedAt,
      snapshotDeadline: snapshot.snapshotDeadline,
      markerLookupAttempts: snapshot.markerLookupAttempts,
      queries: snapshot.queries?.slice(0, 8),
    } : {}),
    ...(snapshot?.markerLookupFailure ? { lookupFailure: snapshot.markerLookupFailure } : {}),
    processes: [...pids].sort((a, b) => a - b).map((pid) => {
      const entry = snapshot?.table.get(pid);
      const sampled = snapshot && (snapshot.sampledPids?.has(pid) ?? true);
      return {
        pid,
        present: sampled ? entry !== undefined : null,
        knownStartTime: identities.get(pid),
        ...(entry ? {
          ppid: entry.ppid,
          pgid: entry.pgid,
          startTime: entry.startTime,
          state: entry.state,
        } : {}),
        markerMatches: sampled && snapshot.markerLookupSucceeded && state.marker !== undefined &&
          !snapshot.unreadableMarkerPids.has(pid)
          ? snapshot.markerPids.has(pid)
          : null,
      };
    }),
  };
}

function posixIdentityDiagnostic(
  state: ObservationState,
  table: ReadonlyMap<number, ProcessEntry>,
  reason: string,
  affectedPids: number[],
): ProcessTreeDiagnostic {
  // A separate marker scan cannot establish marker state for this identity table.
  const diagnostic = posixDiagnostic(state, undefined, 'identity-observation', reason, affectedPids);
  diagnostic.processes = diagnostic.processes.map((process) => {
    const entry = table.get(process.pid);
    return {
      ...process,
      present: entry !== undefined,
      ...(entry ? { ppid: entry.ppid, pgid: entry.pgid, startTime: entry.startTime, state: entry.state } : {}),
    };
  });
  return diagnostic;
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

function groupLeaderWasReused(state: ObservationState, table: ReadonlyMap<number, ProcessEntry>): boolean {
  const leader = state.rootPgid === undefined ? undefined : table.get(state.rootPgid);
  return state.rootPgidMode === 'reused' ||
    (state.rootPgidMode === 'owned' && leader !== undefined && leader.startTime !== state.root?.startTime);
}

function retainProcfsRootReuse(state: ObservationState, table: ReadonlyMap<number, ProcessEntry>): void {
  const leader = table.get(state.pid);
  if (state.dependencies.linuxProcessInspection === 'procfs' && state.root && leader
    && BigInt(leader.startTime) > BigInt(state.root.startTime)) {
    // Even after the replacement leader exits, its group can still have members.
    state.rootPgidMode = 'reused';
  }
}

function isRelevantPosixProcess(
  state: ObservationState, pid: number, entry: ProcessEntry, table: ReadonlyMap<number, ProcessEntry>,
): boolean {
  return pid === state.pid || pid === state.lease?.sentinel.pid ||
    state.descendants.get(pid)?.startTime === entry.startTime ||
    (entry.pgid === (state.rootPgid ?? state.pid) &&
      (state.dependencies.linuxProcessInspection !== 'procfs' || !groupLeaderWasReused(state, table)));
}

async function acceptPosixSnapshot(
  state: ObservationState,
  snapshot: PosixProcessSnapshot,
  stage: string,
  deadline?: number,
  requireDescendantsExitedBeforeCompletion = false,
): Promise<boolean> {
  // This disposition applies only to this observation's confirmed null candidates.
  // Keep their marker rows and known identities for later, independent cleanup.
  const confirmedExitedPids = new Set<number>();
  const recoveredMarkerPids = new Set<number>();
  const darwin = state.platform === 'darwin';
  const snapshotDeadline = posixSnapshotDeadline(snapshot, state.platform, deadline);
  const markerConfirmationDeadline = confirmationDeadline(snapshotDeadline, posixCommandTimeout(state.platform));
  const linuxPsGroupObservation = state.platform === 'linux' && stage === 'observation'
    && !usesLinuxProcfs(state) && state.dependencies.enforceCooperativeProcessGroup === true;
  const groupDepartures: GroupDepartureSample[] = [];
  // Related identities sampled during this delivery only; never signal authority.
  const groupRelatedEntries = new Map<number, ProcessEntry>();
  let groupConfirmation: ProcessCommandResult<MarkerOutput> | undefined;
  const retainGroupCandidates = (table: ReadonlyMap<number, ProcessEntry>, pids: number[], expectedPgid: number): number[] => {
    if (!linuxPsGroupObservation) return pids;
    const proven = pids.filter(pid => !isLinuxPsDeadTaskPlaceholder(table.get(pid)));
    if (pids.length > 0 && proven.length === 0) groupDepartures.push({ table, pids, expectedPgid });
    return proven;
  };
  const fail = (error: Error, reason: string, affectedPids: number[] = [], evidence = snapshot): void => {
    const recordCleanup = stage !== 'observation' && usesLinuxProcfs(state);
    if (state.failure && !recordCleanup) return;
    const diagnostic = posixDiagnostic(state, evidence, stage, reason, affectedPids);
    latchObservationFailure(state, error, diagnostic);
    if (recordCleanup) state.diagnostics[1] = diagnostic;
  };
  const failMarkerLookup = (failure: ProcessCommandFailure): false => {
    snapshot.markerLookupSucceeded = false;
    snapshot.markerLookupFailure = failure;
    fail(posixMarkerLookupFailure(snapshot, stage), 'marker-lookup-failed');
    return false;
  };
  const enforceProcessMarker = state.dependencies.enforceProcessMarker === true ||
    state.dependencies.enforceCooperativeProcessGroup === true;
  if (!snapshot.markerLookupSucceeded && state.marker !== undefined) {
    fail(posixMarkerLookupFailure(snapshot, stage), 'marker-lookup-failed');
    return false;
  }
  if (darwin && state.marker !== undefined && Date.now() >= snapshotDeadline) {
    return failMarkerLookup(commandFailure('deadline-exceeded'));
  }
  if (state.dependencies.enforceCooperativeProcessGroup === true) {
    const expectedPgid = state.rootPgidMode === 'owned' ? state.rootPgid
      : state.rootPgidMode === 'missing' ? state.pid : undefined;
    const changed = expectedPgid === undefined ? [] : retainGroupCandidates(snapshot.table,
      identityGroupDepartures(state, snapshot.table, expectedPgid).filter(pid =>
        linuxPsGroupObservation || !snapshot.table.get(pid)?.state?.startsWith('Z')), expectedPgid);
    if (changed.length > 0) {
      // A later confirmation may see a return or exit. Keep the departure
      // already established for a known identity before changing any row.
      latchObservationFailure(state,
        cleanupUnconfirmed('custom process contract violation: a marked process left its initial process group.'),
        posixIdentityDiagnostic(state, snapshot.table, 'marked-process-group-changed', changed));
    }
  }
  const needsConfirmation = (pid: number): boolean => {
    if (confirmedExitedPids.has(pid)) return false;
    const entry = snapshot.table.get(pid);
    if (pid === state.pid && state.root && entry?.startTime !== state.root.startTime) return false;
    return entry !== undefined && !entry.state?.startsWith('Z')
      && (isRelevantPosixProcess(state, pid, entry, snapshot.table) || snapshot.confirmedUnmarkedPids.has(pid));
  };
  const strictProcfs = state.dependencies.linuxProcessInspection === 'procfs';
  const failLeasedNegative = (negative: number[], evidence: PosixProcessSnapshot): void => {
    const known = negative.some(pid =>
      pid === state.pid || state.descendants.get(pid)?.startTime === evidence.table.get(pid)?.startTime);
    fail(cleanupUnconfirmed('custom process contract violation: a live provider process lost its process marker.'),
      known ? 'known-process-marker-missing' : 'initial-group-marker-missing', negative, evidence);
  };
  const inspectLeasedProcfsTable = (): boolean => {
    const invalid = validateLeaseSnapshot(snapshot, state.lease!, stage);
    if (invalid) {
      fail(invalid, 'inspection-lease-invalid');
      return false;
    }
    retainProcfsRootReuse(state, snapshot.table);
    // Neither a marker nor a parent chain on the recheck can claim a replacement.
    const replacements = snapshot.replacementPids;
    const table = replacements?.size
      ? new Map([...snapshot.table].filter(([pid]) => !replacements.has(pid)))
      : snapshot.table;
    refreshObservedProcesses(state, table, snapshot.markerPids);
    refreshDescendants(state.root, state.descendants, table);
    const negative = [...snapshot.table.keys()].filter(pid =>
      needsConfirmation(pid) && !snapshot.markerPids.has(pid)
      && !snapshot.unreadableMarkerPids.has(pid));
    if (negative.length) failLeasedNegative(negative, snapshot);
    if (requireDescendantsExitedBeforeCompletion) {
      latchLiveDescendantCompletionFailure(state, snapshot, true);
    }
    return true;
  };
  if (strictProcfs && !inspectLeasedProcfsTable()) return false;
  const unreadablePids = [...snapshot.unreadableMarkerPids].filter(needsConfirmation);
  if (state.marker !== undefined && unreadablePids.length > 0) {
    if (usesLinuxProcfs(state) && !strictProcfs) {
      // A positive identity remains relevant if it detaches or becomes
      // unreadable in the confirmation. Signals still need fresh evidence.
      refreshObservedProcesses(state, snapshot.table, snapshot.markerPids);
    }
    const originalEntries = new Map(unreadablePids.map((pid) => [pid, snapshot.table.get(pid)!]));
    const observerEntry = snapshot.table.get(process.pid);
    const anchor = state.lease?.sentinel ?? (observerEntry
      ? { pid: process.pid, startTime: observerEntry.startTime }
      : undefined);
    const rememberGroupMarkers = (table: ReadonlyMap<number, ProcessEntry>, markers: ReadonlySet<number>): void => {
      if (!linuxPsGroupObservation) return;
      for (const pid of markers) {
        const entry = table.get(pid);
        if (pid !== state.lease?.sentinel.pid && entry) groupRelatedEntries.set(pid, entry);
      }
    };
    const retainGroupDepartures = (table: ReadonlyMap<number, ProcessEntry>, markers?: ReadonlySet<number>): void => {
      if (!linuxPsGroupObservation || state.rootPgidMode === 'shared') return;
      const expectedPgid = state.rootPgid ?? state.pid;
      // Retain same-lifetime departures from the full original/recheck tables,
      // including positive markers on newly sampled processes. Do not adopt
      // an unmarked replacement or merge unrelated recheck rows into cleanup.
      if (markers) rememberGroupMarkers(table, markers);
      const changed = identityGroupDepartures(state, table, expectedPgid, groupRelatedEntries);
      const proven = retainGroupCandidates(table, changed, expectedPgid);
      if (proven.length > 0) latchIdentityGroupDeparture(state, table, proven);
    };
    if (linuxPsGroupObservation) {
      for (const [pid, entry] of originalEntries) {
        if (pid !== state.lease?.sentinel.pid) groupRelatedEntries.set(pid, entry);
      }
    }
    retainGroupDepartures(snapshot.table);
    rememberGroupMarkers(snapshot.table, snapshot.markerPids);
    const remaining = markerConfirmationDeadline - Date.now();
    snapshot.markerLookupAttempts += 1;
    const confirmation: ProcessCommandResult<MarkerOutput> = remaining > 0
      ? await readObservationMarkerOutput(state, remaining)
      : { output: null, failure: commandFailure('deadline-exceeded') };
    if (confirmation.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(confirmation.query);
    if (confirmation.output === null || (darwin && Date.now() >= markerConfirmationDeadline)) {
      return failMarkerLookup(confirmation.failure ?? commandFailure('deadline-exceeded'));
    }
    const confirmed = parsePosixMarkerScan(confirmation.output);
    const confirmedMarkers = parseMarkerProcessIds(confirmed, state.markerEnvironmentVariable, state.marker);
    const confirmedUnreadable = unreadableMarkerPids(confirmed, state.platform, confirmedMarkers);
    if (darwin && Date.now() >= markerConfirmationDeadline) {
      return failMarkerLookup(commandFailure('deadline-exceeded'));
    }
    retainGroupDepartures(confirmed.table, confirmedMarkers);
    if (strictProcfs) {
      // A recheck is tied to the original lifetime. Keep positive rows visible
      // for diagnostics, but only an independent scan can claim a replacement.
      snapshot.replacementPids = new Set([...confirmed.table.keys()].filter(pid => {
        const known = pid === state.pid ? state.root : state.descendants.get(pid);
        const previous = snapshot.table.get(pid)?.startTime ?? known?.startTime;
        return previous !== undefined && previous !== confirmed.table.get(pid)?.startTime;
      }));
    }
    // The strict ps observer confirms its own suspect rows. A native procfs
    // cleanup has a complete second table and must use it for every signal.
    if (usesLinuxProcfs(state)) {
      snapshot.table = confirmed.table;
      snapshot.markerPids = confirmedMarkers;
      snapshot.unreadableMarkerPids = confirmedUnreadable;
    } else {
      snapshot.table = new Map(snapshot.table);
      snapshot.unreadableMarkerPids = new Set(snapshot.unreadableMarkerPids);
      for (const pid of unreadablePids) {
        const entry = confirmed.table.get(pid);
        if (entry) snapshot.table.set(pid, entry);
        else snapshot.table.delete(pid);
        if (confirmedMarkers.has(pid)) snapshot.markerPids.add(pid);
        else snapshot.markerPids.delete(pid);
        if (confirmedUnreadable.has(pid)) snapshot.unreadableMarkerPids.add(pid);
        else snapshot.unreadableMarkerPids.delete(pid);
      }
    }
    for (const [pid, previousEntry] of originalEntries) {
      const entry = confirmed.table.get(pid);
      // Keep a confirmed negative relevant even if this same identity moved
      // groups. It does not grant ownership of a replacement process.
      if (state.platform === 'linux' && entry?.startTime === previousEntry?.startTime
        && entry && !entry.state?.startsWith('Z') && !confirmedMarkers.has(pid)) {
        snapshot.confirmedUnmarkedPids.add(pid);
      }
    }
    if (strictProcfs && !inspectLeasedProcfsTable()) return false;
    if (state.platform === 'linux' && stage === 'observation' && !state.failure
      && (!state.lease || validateLeaseSnapshot(snapshot, state.lease, stage) === undefined)) {
      // A full procfs recheck can sample another short-lived child after the
      // first one exits. Verify the identities the recheck actually found.
      const candidates = [...snapshot.unreadableMarkerPids].filter(pid => needsConfirmation(pid)
        && (strictProcfs ? !snapshot.replacementPids?.has(pid)
          : originalEntries.get(pid)?.startTime === snapshot.table.get(pid)?.startTime));
      if (candidates.length > 0) {
        const queryStartedAt = Date.now();
        const identityRemaining = markerConfirmationDeadline - queryStartedAt;
        // A forced sampler scan can reuse an older in-flight query. Start a new
        // direct lookup only after the marker confirmation callback has completed.
        let identity: ProcessCommandResult<MarkerOutput>;
        if (identityRemaining <= 0) identity = { output: null, failure: commandFailure('deadline-exceeded') };
        else if (usesLinuxProcfs(state)) identity = await queryLinuxMarkers(identityRemaining, new Set());
        else identity = await readPosixIdentityTable(state.dependencies.execFile ?? defaultExecFile, identityRemaining);
        if (identity.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(identity.query);
        if (linuxPsGroupObservation) groupConfirmation = identity;
        const identityTable = typeof identity.output === 'string' ? parseCompletePosixIdentityTable(identity.output) : identity.output?.table;
        const anchorConfirmed = anchor !== undefined
          && confirmed.table.get(anchor.pid)?.startTime === anchor.startTime
          && identityTable?.get(anchor.pid)?.startTime === anchor.startTime
          && !confirmed.table.get(anchor.pid)?.state?.startsWith('Z')
          && !identityTable?.get(anchor.pid)?.state?.startsWith('Z')
          && (!state.lease || confirmedMarkers.has(anchor.pid));
        const queryCompletedAt = Date.now();
        const trustedTable = queryCompletedAt < markerConfirmationDeadline && anchorConfirmed
          ? identityTable : undefined;
        if (trustedTable) {
          retainProcfsRootReuse(state, trustedTable);
          retainGroupDepartures(trustedTable);
        }
        const stillPresent: number[] = [];
        for (const pid of candidates) {
          const startTime = snapshot.table.get(pid)!.startTime;
          const current = trustedTable?.get(pid);
          const result = trustedTable === undefined ? 'unknown'
            : current === undefined ? 'absent'
              : current.startTime === startTime ? 'present' : 'unknown';
          if (result === 'absent') confirmedExitedPids.add(pid);
          if (result === 'present') stillPresent.push(pid);
          try {
            state.dependencies.onLinuxMarkerIdentityConfirmation?.({
              rootPid: state.pid, pid, startTime, phase: 'post-marker-confirmation',
              queryStartedAt, queryCompletedAt, deadline: markerConfirmationDeadline, result,
            });
          } catch {
            // Diagnostic consumers cannot change the process inspection gate.
          }
        }
        const lease = state.lease;
        if (strictProcfs && lease && stillPresent.length > 0 && !state.failure
          && Date.now() + PROCESS_TREE_SETTLE_MS < markerConfirmationDeadline) {
          // A live task can still be in exec across both quick full scans. Give
          // the same identities one settled read within the original deadline.
          await new Promise(resolve => setTimeout(resolve, PROCESS_TREE_SETTLE_MS));
          if (state.disposed || state.failure) return false;
          const remaining = markerConfirmationDeadline - Date.now();
          if (remaining <= 0) return failMarkerLookup(commandFailure('deadline-exceeded'));
          const pids = new Set([process.pid, lease.sentinel.pid, ...stillPresent]);
          snapshot.markerLookupAttempts += 1;
          const settled = await queryLinuxMarkers(remaining, new Set([state.marker]), state.markerEnvironmentVariable, true, pids);
          if (settled.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(settled.query);
          if (settled.output === null || Date.now() >= markerConfirmationDeadline) {
            return failMarkerLookup(settled.failure ?? commandFailure('deadline-exceeded'));
          }
          const evidence: PosixProcessSnapshot = {
            ...snapshot, table: settled.output.table, sampledPids: pids,
            markerPids: parseMarkerProcessIds(settled.output, state.markerEnvironmentVariable, state.marker),
            unreadableMarkerPids: settled.output.unreadablePids,
          };
          const invalid = validateLeaseSnapshot(evidence, lease, stage);
          if (invalid) {
            fail(invalid, 'inspection-lease-invalid', [], evidence);
            return false;
          }
          retainProcfsRootReuse(state, evidence.table);
          const negative: number[] = [];
          for (const pid of stillPresent) {
            const entry = evidence.table.get(pid);
            if (entry && entry.startTime !== snapshot.table.get(pid)!.startTime) continue;
            if (!entry || entry.state?.startsWith('Z')) confirmedExitedPids.add(pid);
            else if (evidence.markerPids.has(pid)) recoveredMarkerPids.add(pid);
            else if (!evidence.unreadableMarkerPids.has(pid)) negative.push(pid);
          }
          // Keep newly proven identities relevant if they later detach or
          // lose the marker. Cleanup still needs its own complete marker table.
          refreshObservedProcesses(state, evidence.table, recoveredMarkerPids);
          if (negative.length > 0) failLeasedNegative(negative, evidence);
        }
      }
    }
  }
  if (darwin && state.marker !== undefined) {
    const relevant = new Set([...snapshot.table].filter(([pid, entry]) =>
      isRelevantPosixProcess(state, pid, entry, snapshot.table)).map(([pid]) => pid));
    // Include newly visible descendants before their first marker can establish
    // ownership. Reading them does not grant permission to signal them.
    for (const pid of [...relevant]) {
      const entry = snapshot.table.get(pid);
      const known = pid === state.pid ? state.root : state.descendants.get(pid);
      if (known && known.startTime !== entry?.startTime) continue;
      for (const descendant of collectDescendantProcessIds(pid, snapshot.table)) relevant.add(descendant);
    }
    const suspects = [...relevant].filter((pid) => {
      const entry = snapshot.table.get(pid);
      return entry && !entry.state?.startsWith('Z') && !snapshot.markerPids.has(pid);
    });
    if (suspects.length > 0) {
      const confirmed = await confirmDarwinMarkers(snapshot, suspects, state.markerEnvironmentVariable, state.marker,
        state.dependencies.execFile ?? defaultExecFile,
        confirmationDeadline(snapshotDeadline));
      if (!confirmed) {
        fail(posixMarkerLookupFailure(snapshot, stage), 'marker-lookup-failed');
        return false;
      }
      // The detached root can exit before its first marker delivery. Its PID
      // still identifies the initial group of a surviving confirmed candidate.
      const expectedPgid = state.rootPgidMode === 'owned' ? state.rootPgid
        : state.rootPgidMode === 'missing' || !snapshot.table.has(state.pid)
          || snapshot.table.get(state.pid)?.pgid === state.pid
          ? state.pid : undefined;
      const changed = expectedPgid === undefined ? [] : suspects.filter((pid) => {
        if (pid === state.lease?.sentinel.pid) return false;
        const before = snapshot.table.get(pid);
        const after = confirmed.get(pid);
        return before && after?.startTime === before.startTime && !after.state?.startsWith('Z')
          && after.pgid !== undefined && after.pgid !== expectedPgid;
      });
      if (state.dependencies.enforceCooperativeProcessGroup === true && changed.length > 0) {
        latchObservationFailure(state,
          cleanupUnconfirmed('custom process contract violation: a marked process left its initial process group.'),
          posixIdentityDiagnostic(state, confirmed, 'marked-process-group-changed', changed));
      }
    }
  }
  const stillUnreadable = [...snapshot.unreadableMarkerPids]
    .filter(pid => needsConfirmation(pid) && !recoveredMarkerPids.has(pid));
  if (state.marker !== undefined && stillUnreadable.length > 0) {
    fail(
      cleanupUnconfirmed('POSIX process marker could not be read for a live provider process after confirmation.'),
      'process-marker-unreadable', stillUnreadable,
    );
  }
  if (state.lease && !strictProcfs) {
    const leaseFailure = validateLeaseSnapshot(snapshot, state.lease, stage);
    if (leaseFailure) {
      fail(leaseFailure, 'inspection-lease-invalid');
      return false;
    }
  }
  const rootEntry = snapshot.table.get(state.pid);
  let confirmedUnmarkedRoot = snapshot.confirmedUnmarkedPids.has(state.pid)
    && !confirmedExitedPids.has(state.pid);
  if (
    state.marker !== undefined &&
    rootEntry !== undefined &&
    !rootEntry.state?.startsWith('Z') &&
    !confirmedExitedPids.has(state.pid) &&
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
    enforceProcessMarker && !strictProcfs &&
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
  if (!strictProcfs) refreshObservedProcesses(state, snapshot.table, snapshot.markerPids);
  if (state.marker !== undefined) {
    const providerMarkerPids = [...snapshot.markerPids].filter(
      (pid) => pid !== state.lease?.sentinel.pid,
    );
    let rootGroupUnconfirmed = false;
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
        } else if (linuxPsGroupObservation && isLinuxPsDeadTaskPlaceholder(rootEntry)) {
          // A first sample can catch the root being reaped. Check the expected
          // group below, but establish no group ownership from this row.
          rootGroupUnconfirmed = true;
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
      : state.rootPgidMode === 'missing' || rootGroupUnconfirmed
        ? state.pid
        : undefined;
    if (state.dependencies.enforceCooperativeProcessGroup === true && expectedPgid !== undefined) {
      const changed = retainGroupCandidates(snapshot.table, providerMarkerPids.filter(pid => {
        const entry = snapshot.table.get(pid);
        return entry?.pgid !== undefined && entry.pgid !== expectedPgid;
      }), expectedPgid);
      if (changed.length > 0) {
        fail(cleanupUnconfirmed('custom process contract violation: a marked process left its initial process group.'),
          'marked-process-group-changed', changed);
      }
    }
    if (strictProcfs) return true;
    const liveKnownIdentities = [state.root, ...state.descendants.values()].filter(
      (identity): identity is ProcessIdentity =>
        identityMatches(identity, snapshot.table) &&
        !snapshot.table.get(identity.pid)?.state?.startsWith('Z'),
    );
    const markerlessKnownPids = liveKnownIdentities
      .filter((identity) => !confirmedExitedPids.has(identity.pid) && !snapshot.markerPids.has(identity.pid))
      .map((identity) => identity.pid);
    const markerlessConfirmedPids = [...snapshot.confirmedUnmarkedPids].filter((pid) => {
      const entry = snapshot.table.get(pid);
      return entry && !confirmedExitedPids.has(pid)
        && !entry.state?.startsWith('Z') && !snapshot.markerPids.has(pid);
    });
    const markerlessInitialGroupPids: number[] = [];
    if (state.rootPgid !== undefined && !groupLeaderWasReused(state, snapshot.table)) {
      for (const [pid, entry] of snapshot.table) {
        if (entry.pgid !== state.rootPgid || entry.state?.startsWith('Z') || confirmedExitedPids.has(pid)) continue;
        if (pid !== state.pid && !snapshot.markerPids.has(pid)) {
          markerlessInitialGroupPids.push(pid);
        }
      }
    }
    if (usesLinuxProcfs(state) && stage !== 'observation' && stillUnreadable.length === 0) {
      const unverified = markerlessInitialGroupPids.filter(pid =>
        state.descendants.get(pid)?.startTime !== snapshot.table.get(pid)?.startTime);
      if (unverified.length > 0) fail(cleanupUnconfirmed('a live process in the initial group has unconfirmed ownership.'),
        'initial-group-ownership-unconfirmed', unverified);
      else if (markerlessKnownPids.length > 0) fail(cleanupUnconfirmed('a known live process no longer has its marker.'),
        'known-process-marker-missing', markerlessKnownPids);
    }
    if (
      enforceProcessMarker &&
      (markerlessKnownPids.length > 0 || markerlessInitialGroupPids.length > 0 || markerlessConfirmedPids.length > 0)
    ) {
      fail(
        cleanupUnconfirmed(
          'custom process contract violation: a live provider process lost its process marker.',
        ),
        markerlessKnownPids.length > 0 ? 'known-process-marker-missing' : 'initial-group-marker-missing',
        [...new Set([...markerlessKnownPids, ...markerlessInitialGroupPids, ...markerlessConfirmedPids])],
      );
    }
  }
  if (groupDepartures.length > 0 && !state.failure) {
    // The marker rules above remain independent. Confirm the impossible PGID
    // from the original/recheck rows with one complete fresh identity table;
    // reuse a post-marker identity query if one was already necessary.
    if (!groupConfirmation) {
      const remaining = snapshotDeadline - Date.now();
      groupConfirmation = remaining > 0
        ? await readPosixIdentityTable(state.dependencies.execFile ?? defaultExecFile, remaining)
        : { output: null, failure: commandFailure('deadline-exceeded') };
      if (groupConfirmation.query && (snapshot.queries?.length ?? 0) < 8) (snapshot.queries ??= []).push(groupConfirmation.query);
    }
    const table = typeof groupConfirmation.output === 'string'
      ? parseCompletePosixIdentityTable(groupConfirmation.output) : undefined;
    const metadata = {
      snapshotStartedAt: snapshot.snapshotStartedAt,
      snapshotDeadline,
      queries: snapshot.queries?.slice(0, 8),
      ...(groupConfirmation.failure ? { lookupFailure: groupConfirmation.failure } : {}),
    };
    for (const sample of groupDepartures) {
      settleLinuxPsGroupDeparture(state, sample, table, snapshotDeadline, metadata, groupRelatedEntries);
    }
  }
  return true;
}

function getPosixProcessSampler(state: ObservationState): PosixProcessSampler {
  const { platform } = state;
  const execFileImpl = state.dependencies.posixSamplerExecFile ?? state.dependencies.execFile ?? defaultExecFile;
  const procfs = state.dependencies.linuxProcessInspection === 'procfs';
  const key = procfs ? state.lease! : execFileImpl;
  let samplers = posixSamplers.get(platform);
  if (!samplers) {
    samplers = new WeakMap();
    posixSamplers.set(platform, samplers);
  }
  const existing = samplers.get(key);
  if (existing) return existing;
  const sampler: PosixProcessSampler = {
    platform,
    execFile: execFileImpl,
    ...(procfs ? { linuxMarker: { name: state.markerEnvironmentVariable, value: state.marker! } } : {}),
    states: new Set(),
    identityCompletedAt: Number.NEGATIVE_INFINITY,
    markerCompletedAt: Number.NEGATIVE_INFINITY,
  };
  samplers.set(key, sampler);
  return sampler;
}

function snapshotFromSampler(
  state: ObservationState,
  sampler: PosixProcessSampler,
): PosixProcessSnapshot | undefined {
  const query = state.marker === undefined ? sampler.identityQuery : sampler.markerQuery;
  const markerLookupSucceeded = state.marker === undefined || sampler.markerFailure === undefined;
  const table = state.marker === undefined || !markerLookupSucceeded
    ? sampler.identityTable
    : sampler.markerScan?.table;
  if (!table || !query) return undefined;
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
    unreadableMarkerPids: unreadableMarkerPids(sampler.markerScan, state.platform, markerPids),
    markerLookupSucceeded,
    markerLookupAttempts: state.marker === undefined ? 0 : 1,
    markerScanStartedAt: sampler.markerQuery?.startedAt,
    snapshotStartedAt: query.startedAt,
    snapshotDeadline: query.startedAt + posixInspectionTimeout(state.platform),
    queries: [sampler.identityQuery, sampler.markerQuery]
      .filter((query): query is ProcessQueryDiagnostic => query !== undefined),
    ...(sampler.markerFailure ? { markerLookupFailure: sampler.markerFailure } : {}),
    confirmedUnmarkedPids: new Set<number>(),
  };
}

function identityGroupDepartures(
  state: ObservationState,
  table: ReadonlyMap<number, ProcessEntry>,
  expectedPgid: number,
  relatedEntries?: ReadonlyMap<number, ProcessEntry>,
): number[] {
  const changed = new Set([state.root, ...state.descendants.values()].flatMap((identity) => {
    if (!identity) return [];
    const entry = table.get(identity.pid);
    return entry?.startTime === identity.startTime &&
      entry.pgid !== undefined && entry.pgid !== expectedPgid ? [identity.pid] : [];
  }));
  for (const [pid, before] of relatedEntries ?? []) {
    const entry = table.get(pid);
    if (entry?.startTime === before.startTime && entry.pgid !== undefined && entry.pgid !== expectedPgid) changed.add(pid);
  }
  return [...changed];
}

function latchIdentityGroupDeparture(
  state: ObservationState,
  table: ReadonlyMap<number, ProcessEntry>,
  pids: number[],
): void {
  latchObservationFailure(
    state,
    cleanupUnconfirmed('custom process contract violation: a marked process left its initial process group.'),
    posixIdentityDiagnostic(state, table, 'marked-process-group-changed', pids),
  );
}

// procps can sample a task during reaping after the kernel has discarded
// its group identity. UINT32_MAX is not evidence of a real process group.
function isLinuxPsDeadTaskPlaceholder(entry: ProcessEntry | undefined): boolean {
  return entry?.state === 'X' && entry.ppid === 0 && entry.pgid === LINUX_PS_INVALID_PGID;
}

interface GroupDepartureSample {
  table: ReadonlyMap<number, ProcessEntry>;
  expectedPgid: number;
  pids: number[];
}

function settleLinuxPsGroupDeparture(
  state: ObservationState,
  { table, expectedPgid, pids }: GroupDepartureSample,
  confirmed: ReadonlyMap<number, ProcessEntry> | undefined,
  deadline: number,
  metadata: Pick<ProcessTreeDiagnostic, 'snapshotStartedAt' | 'snapshotDeadline' | 'queries' | 'lookupFailure'>,
  relatedEntries?: ReadonlyMap<number, ProcessEntry>,
): void {
  if (state.disposed || state.failure) return;
  const anchorPid = state.lease?.sentinel.pid ?? process.pid;
  const anchorBefore = table.get(anchorPid);
  const anchorAfter = confirmed?.get(anchorPid);
  const anchorStart = state.lease?.sentinel.startTime ?? anchorBefore?.startTime;
  const liveAnchor = (entry: ProcessEntry | undefined): boolean =>
    entry !== undefined && entry.startTime === anchorStart &&
    /^[RSDTtIWP]$/u.test(entry.state ?? '') && entry.pgid !== undefined && entry.pgid !== LINUX_PS_INVALID_PGID;
  const trusted = Date.now() < deadline && liveAnchor(anchorBefore) && liveAnchor(anchorAfter)
    ? confirmed : undefined;
  if (trusted) {
    const changed = identityGroupDepartures(state, trusted, expectedPgid, relatedEntries);
    // Some marker-recheck candidates are relevant before a positive marker has
    // established them as known descendants. Preserve their sampled departure.
    for (const pid of pids) {
      const entry = trusted.get(pid);
      if (entry && entry.startTime === table.get(pid)?.startTime && entry.pgid !== undefined && entry.pgid !== expectedPgid
        && !changed.includes(pid)) changed.push(pid);
    }
    const proven = changed.filter(pid => !isLinuxPsDeadTaskPlaceholder(trusted.get(pid)));
    if (proven.length > 0) {
      latchIdentityGroupDeparture(state, trusted, proven);
      return;
    }
    // A replacement or still-present task cannot prove that the original
    // PID was absent. Do not adopt a new identity or authorize any signal.
    if (!pids.some(pid => trusted.has(pid)) && changed.length === 0) return;
  }
  latchObservationFailure(
    state,
    cleanupUnconfirmed('POSIX process identity lookup failed: a disappearing process could not be confirmed absent.'),
    {
      ...posixIdentityDiagnostic(state, table, 'identity-lookup-failed', pids),
      ...metadata,
    },
  );
}

// Preserve every applicable table while a late lease establishes its first
// identities. Only that observer waits; cleanup drains its own tail.
function deferSamplerDelivery(state: ObservationState, previous: Promise<void>, apply: () => Promise<void>): Promise<void> {
  const delivery = previous.then(() => { if (!state.disposed) return apply(); }).finally(() => {
    if (state.deferredSamplerDelivery === delivery) state.deferredSamplerDelivery = undefined;
  });
  state.deferredSamplerDelivery = delivery;
  return delivery;
}

function deliverSamplerIdentity(
  sampler: PosixProcessSampler,
  states: readonly ObservationState[] = [...sampler.states],
): SamplerDeliveries {
  const { identityTable, identityFailure, identityQuery, identityInFlight } = sampler;
  const accept = (state: ObservationState): GroupDepartureSample | undefined => {
    if (identityFailure) {
      latchObservationFailure(
        state,
        cleanupUnconfirmed('POSIX process identity lookup failed.'),
        {
          ...posixDiagnostic(state, undefined, 'observation', 'identity-lookup-failed'),
          lookupFailure: identityFailure,
          ...(identityQuery ? {
            snapshotStartedAt: identityQuery.startedAt,
            snapshotDeadline: identityQuery.deadline,
            queries: [identityQuery],
          } : {}),
        },
      );
      return;
    }
    if (state.marker !== undefined) {
      if (identityTable) {
        retainProcfsRootReuse(state, identityTable);
        refreshDescendants(state.root, state.descendants, identityTable);
      }
      const expectedPgid = state.rootPgidMode === 'owned'
        ? state.rootPgid
        : state.rootPgidMode === 'missing'
          ? state.pid
          : undefined;
      if (state.dependencies.enforceCooperativeProcessGroup === true &&
        expectedPgid !== undefined && identityTable) {
        const changedPids = identityGroupDepartures(state, identityTable, expectedPgid);
        if (changedPids.length > 0) {
          const proven = state.platform === 'linux' && !sampler.linuxMarker
            ? changedPids.filter(pid => !isLinuxPsDeadTaskPlaceholder(identityTable.get(pid)))
            : changedPids;
          if (proven.length > 0) latchIdentityGroupDeparture(state, identityTable, proven);
          else if (!state.failure) return { table: identityTable, expectedPgid, pids: changedPids };
        }
      }
      return;
    }
    const snapshot = snapshotFromSampler(state, sampler);
    if (snapshot) acceptPosixSnapshot(state, snapshot, 'observation');
  };
  // All subscribers of this delivery share one independent confirmation,
  // including those waiting for their initial marker. Its deadline is fixed.
  const deadline = identityQuery?.deadline ?? Date.now();
  const confirm = async () => {
    const remaining = deadline - Date.now();
    const result: ProcessCommandResult = remaining > 0
      ? await readPosixIdentityTable(sampler.execFile, remaining)
      : { output: null, failure: commandFailure('deadline-exceeded') };
    return {
      confirmed: result.output === null ? undefined : parseCompletePosixIdentityTable(result.output),
      metadata: {
        snapshotStartedAt: identityQuery?.startedAt,
        snapshotDeadline: identityQuery?.deadline,
        queries: [identityQuery, result.query].filter((query): query is ProcessQueryDiagnostic => query !== undefined),
        ...(result.failure ? { lookupFailure: result.failure } : {}),
      },
    };
  };
  let confirmation: ReturnType<typeof confirm> | undefined;
  // A cleanup waits for its own delivery, not the other subscribers'
  // independent initial reads or marker confirmations.
  const deliveries = new Map<ObservationState, Promise<void>>();
  const shared: Promise<void>[] = [];
  for (const state of states) {
    if (state.disposed || state.finalSamplerQueries?.has(identityInFlight) === false) continue;
    const apply = async () => {
      const sample = accept(state);
      if (!sample) return;
      const { confirmed, metadata } = await (confirmation ??= confirm());
      settleLinuxPsGroupDeparture(state, sample, confirmed, deadline, metadata);
    };
    const previous = identityInFlight === state.preFreshIdentityQuery
      ? undefined : state.deferredSamplerDelivery ?? state.initialFreshMarkerRead;
    const delivery = previous ? deferSamplerDelivery(state, previous, apply) : apply();
    deliveries.set(state, delivery);
    if (!previous) shared.push(delivery);
  }
  return { byState: deliveries, shared };
}

function deliverSamplerMarkers(sampler: PosixProcessSampler, stage: string): SamplerDeliveries {
  const { markerInFlight, markerFailure, markerQuery } = sampler;
  const deliveries = new Map<ObservationState, Promise<void>>();
  const shared: Promise<void>[] = [];
  for (const state of sampler.states) {
    if (state.disposed || state.marker === undefined || state.finalSamplerQueries?.has(markerInFlight) === false ||
      (state.excludedInitialMarkerQuery !== undefined && state.excludedInitialMarkerQuery === markerInFlight)) continue;
    const snapshot = snapshotFromSampler(state, sampler);
    const apply = async () => {
      if (markerFailure) {
        recordMarkerLookupFailure(state, stage, markerFailure, {
          snapshotStartedAt: markerQuery?.startedAt,
          snapshotDeadline: (markerQuery?.startedAt ?? Date.now()) + posixInspectionTimeout(state.platform),
          markerLookupAttempts: 1, queries: markerQuery ? [markerQuery] : [],
        });
      } else if (snapshot) await acceptPosixSnapshot(state, snapshot, stage);
    };
    const previous = state.deferredSamplerDelivery ?? state.initialFreshMarkerRead;
    const delivery = previous ? deferSamplerDelivery(state, previous, apply) : apply();
    deliveries.set(state, delivery);
    if (!previous) shared.push(delivery);
  }
  return { byState: deliveries, shared };
}

function waitForSamplerDelivery(
  state: ObservationState,
  deliveries: Promise<SamplerDeliveries> | undefined,
  query: Promise<void>,
): Promise<void> {
  return deliveries ? deliveries.then(async values => { await values.byState.get(state); }) : query;
}

function scanSamplerIdentity(
  sampler: PosixProcessSampler,
  force: boolean,
): Promise<void> {
  if (sampler.identityInFlight) return sampler.identityInFlight;
  const now = Date.now();
  if (
    !force &&
    Number.isFinite(sampler.identityCompletedAt) &&
    now - sampler.identityCompletedAt < PROCESS_TREE_IDENTITY_INTERVAL_MS
  ) return Promise.resolve();
  const timeoutMs = posixCommandTimeout(sampler.platform);
  const query: ProcessCommandPromise<MarkerOutput> = sampler.linuxMarker ? queryLinuxMarkers(timeoutMs, new Set())
    : readPosixIdentityTable(sampler.execFile, timeoutMs);
  sampler.identityDeliveries = query
    .then((result) => {
      sampler.identityCompletedAt = Date.now();
      sampler.identityFailure = result.failure;
      sampler.identityQuery = result.query;
      sampler.identityTable = result.output === null
        ? undefined
        : typeof result.output === 'string' ? parsePosixProcessTable(result.output) : result.output.table;
      sampler.identityDelivering = true;
      return deliverSamplerIdentity(sampler);
    });
  sampler.identityInFlight = sampler.identityDeliveries
    .then(async deliveries => { await Promise.all(deliveries.shared); })
    .finally(() => {
      sampler.identityInFlight = undefined;
      sampler.identityDeliveries = undefined;
      sampler.identityDelivering = undefined;
    });
  return sampler.identityInFlight;
}

function runMarkerScan(
  sampler: PosixProcessSampler,
): Promise<void> {
  const timeoutMs = posixCommandTimeout(sampler.platform);
  const query: ProcessCommandPromise<MarkerOutput> = sampler.linuxMarker
    ? queryLinuxMarkers(timeoutMs, new Set([sampler.linuxMarker.value]), sampler.linuxMarker.name)
    : readPosixMarkerOutput(sampler.execFile, timeoutMs);
  sampler.markerDeliveries = query
    .then((result) => {
      sampler.markerCompletedAt = Date.now();
      sampler.markerFailure = result.failure;
      sampler.markerQuery = result.query;
      sampler.markerScan = result.output === null ? undefined : parsePosixMarkerScan(result.output);
      sampler.markerDelivering = true;
      return deliverSamplerMarkers(sampler, 'observation');
    });
  sampler.markerInFlight = sampler.markerDeliveries
    .then(async deliveries => { await Promise.all(deliveries.shared); })
    .finally(() => {
      sampler.markerInFlight = undefined;
      sampler.markerDeliveries = undefined;
      sampler.markerDelivering = undefined;
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
    Number.isFinite(sampler.markerCompletedAt) &&
    now - sampler.markerCompletedAt < PROCESS_TREE_MARKER_INTERVAL_MS
  ) return Promise.resolve();
  return runMarkerScan(sampler);
}

function schedulePosixSampler(sampler: PosixProcessSampler): void {
  if (sampler.timer) clearTimeout(sampler.timer);
  sampler.timer = undefined;
  const activeStates = [...sampler.states].filter(state => !state.finalSamplerQueries);
  if (activeStates.length === 0) return;
  const now = Date.now();
  const identityDelay = Math.max(
    0,
    PROCESS_TREE_IDENTITY_INTERVAL_MS - (now - sampler.identityCompletedAt),
  );
  const markerDelay = activeStates.some((state) => state.marker !== undefined)
    ? Math.max(0, PROCESS_TREE_MARKER_INTERVAL_MS - (now - sampler.markerCompletedAt))
    : Number.POSITIVE_INFINITY;
  const delayMs = Math.min(identityDelay, markerDelay);
  sampler.timer = setTimeout(() => {
    sampler.timer = undefined;
    const current = Date.now();
    const scans: Promise<void>[] = [];
    if (current - sampler.identityCompletedAt >= PROCESS_TREE_IDENTITY_INTERVAL_MS) {
      scans.push(scanSamplerIdentity(sampler, false));
    }
    if (
      markerDelay !== Number.POSITIVE_INFINITY &&
      current - sampler.markerCompletedAt >= PROCESS_TREE_MARKER_INTERVAL_MS
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

function recordMarkerLookupFailure(
  state: ObservationState,
  stage: string,
  failure: ProcessCommandFailure,
  metadata: Pick<PosixProcessSnapshot, 'snapshotStartedAt' | 'snapshotDeadline' | 'markerLookupAttempts' | 'queries'>,
): void {
  const diagnostic = {
    ...posixDiagnostic(state, undefined, stage, 'marker-lookup-failed'),
    ...metadata,
    markerLookupSucceeded: false,
    lookupFailure: failure,
  };
  const error = posixMarkerLookupFailure({ markerLookupAttempts: metadata.markerLookupAttempts, markerLookupFailure: failure }, stage);
  latchObservationFailure(state, error, diagnostic);
  if (stage !== 'observation') state.diagnostics[1] = diagnostic;
}

async function readImmediatePosixSnapshot(
  state: ObservationState,
  stage: string,
  options: {
    pendingObservations?: readonly Promise<unknown>[];
    deadline?: number;
    requireDescendantsExitedBeforeCompletion?: boolean;
  } = {},
): Promise<PosixProcessSnapshot | undefined> {
  const startedAt = Date.now();
  const deadline = options.deadline ?? startedAt + POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS;
  const execFileImpl = state.dependencies.execFile ?? defaultExecFile;
  // A sampler query may have captured processes before this termination stage.
  // Take a new atomic read, eligible to share only with requests waiting to launch.
  const remaining = deadline - Date.now();
  if (remaining <= 0 && state.marker !== undefined) {
    recordMarkerLookupFailure(state, stage, commandFailure('deadline-exceeded'), {
      snapshotStartedAt: startedAt, snapshotDeadline: deadline, markerLookupAttempts: 0, queries: [],
    });
    return undefined;
  }
  const lookup = state.marker === undefined
    ? readPosixIdentityTable(execFileImpl, Math.max(1, remaining))
    : readObservationMarkerOutput(state, Math.max(1, remaining));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: ProcessCommandResult<MarkerOutput>;
  try {
    result = await Promise.race([
      Promise.all([lookup, Promise.all(options.pendingObservations ?? [])]).then(([current]) => current),
      new Promise<ProcessCommandResult>((resolve) => {
        timer = setTimeout(() => resolve({ output: null, failure: commandFailure('deadline-exceeded') }),
          Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (Date.now() >= deadline) result = { output: null, failure: commandFailure('deadline-exceeded') };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const queryMetadata = {
    snapshotStartedAt: startedAt,
    snapshotDeadline: deadline,
    markerLookupAttempts: state.marker === undefined ? 0 : 1,
    queries: [{ ...lookup.query }],
  };
  if (result.output === null && state.marker === undefined) {
    const diagnostic = {
      ...posixDiagnostic(state, undefined, stage, 'identity-lookup-failed'),
      lookupFailure: result.failure,
      ...queryMetadata,
    };
    latchObservationFailure(
      state,
      cleanupUnconfirmed('POSIX process identity lookup failed.'),
      diagnostic,
    );
    state.diagnostics[1] = diagnostic;
    return undefined;
  }
  if (result.output === null) {
    recordMarkerLookupFailure(state, stage, result.failure, queryMetadata);
    return undefined;
  }
  const snapshot = successfulPosixSnapshot(state, result.output, queryMetadata);
  const previousCleanupDiagnostic = state.diagnostics[1];
  const accepted = await acceptPosixSnapshot(state, snapshot, stage, deadline, options.requireDescendantsExitedBeforeCompletion);
  if (!accepted && usesLinuxProcfs(state)) throw state.failure ?? cleanupUnconfirmed('Linux process inspection failed.');
  if (Date.now() >= deadline) {
    const diagnostic = {
      ...posixDiagnostic(state, snapshot, stage, 'inspection-deadline-exceeded'),
      lookupFailure: commandFailure('deadline-exceeded'),
    };
    latchObservationFailure(state, cleanupUnconfirmed('POSIX process inspection deadline exceeded.'), diagnostic);
    state.diagnostics[1] = diagnostic;
    return undefined;
  }
  // Keep only the first failure and the latest cleanup scan, even if inspection recovers.
  if (state.failure && state.diagnostics[1] === previousCleanupDiagnostic) {
    state.diagnostics[1] = posixDiagnostic(state, snapshot, stage, 'cleanup-snapshot');
  }
  return snapshot;
}

function successfulPosixSnapshot(
  state: Pick<ObservationState, 'marker' | 'markerEnvironmentVariable' | 'platform'>,
  output: MarkerOutput,
  queryMetadata: Pick<PosixProcessSnapshot, 'snapshotStartedAt' | 'snapshotDeadline' | 'markerLookupAttempts' | 'queries'>,
): PosixProcessSnapshot {
  const markerScan = state.marker === undefined ? undefined : parsePosixMarkerScan(output);
  const markerPids = markerScan && state.marker !== undefined
    ? parseMarkerProcessIds(markerScan, state.markerEnvironmentVariable, state.marker)
    : new Set<number>();
  return {
    table: typeof output !== 'string' ? output.table : markerScan?.table ?? parsePosixProcessTable(output),
    markerPids,
    unreadableMarkerPids: unreadableMarkerPids(markerScan, state.platform, markerPids),
    markerLookupSucceeded: true,
    markerScanStartedAt: queryMetadata.snapshotStartedAt,
    ...queryMetadata,
    confirmedUnmarkedPids: new Set(),
  };
}

function observeInitialPosixMarkers(state: ObservationState, requireLookup: boolean): Promise<void> {
  const requestedAt = Date.now();
  const timeoutMs = posixCommandTimeout(state.platform);
  return readObservationMarkerOutput(state, timeoutMs, true).then(async (result) => {
    if (state.disposed) return;
    const metadata = {
      snapshotStartedAt: requestedAt,
      snapshotDeadline: requestedAt + (requireLookup ? posixInspectionTimeout(state.platform) : timeoutMs),
      markerLookupAttempts: 1, queries: result.query ? [result.query] : [],
    };
    if (result.output === null) {
      if (requireLookup) recordMarkerLookupFailure(state, 'observation', result.failure, metadata);
      return;
    }
    await acceptPosixSnapshot(state, successfulPosixSnapshot(state, result.output, metadata), 'observation');
  });
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
  const platform = dependencies.platform ?? process.platform;
  const periodic = dependencies.enforceProcessMarker === true ||
    dependencies.enforceCooperativeProcessGroup === true;
  const state: ObservationState = {
    pid,
    platform,
    marker,
    markerEnvironmentVariable:
      dependencies.markerEnvironmentVariable ?? DEFAULT_PROCESS_MARKER_ENV,
    coalescePosixMarkerScans: dependencies.coalescePosixMarkerScans === true &&
      marker !== undefined && !periodic && lease === undefined &&
      (platform === 'darwin' || platform === 'linux'),
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
  if (state.platform === 'win32') {
    state.initialLookup = readWindowsProcessTable(state).then((table) => {
      if (!state.disposed && table) {
        state.initialWindowsLookupSucceeded = true;
        refreshObservedProcesses(state, table);
      }
    });
    return observation;
  }
  if (state.coalescePosixMarkerScans || (!periodic && usesLinuxProcfs(state))) {
    state.initialLookup = observeInitialPosixMarkers(state, usesLinuxProcfs(state));
    return observation;
  }
  const sampler = getPosixProcessSampler(state);
  const beforeLease = lease && preLeaseMarkerQueries.get(lease);
  const markerGeneration = sampler.markerInFlight;
  if (periodic && marker !== undefined && markerGeneration &&
    (markerGeneration === beforeLease || sampler.markerDelivering)) {
    // An already delivered generation has fixed its recipients. A late
    // subscriber needs its own first marker result, just like a new lease.
    state.excludedInitialMarkerQuery = markerGeneration;
  }
  const lateIdentity = periodic && sampler.identityInFlight !== undefined && sampler.identityDelivering === true;
  if (periodic) {
    state.sampler = sampler;
    sampler.states.add(state);
  }
  const identityQuery = marker === undefined || periodic ? scanSamplerIdentity(sampler, true) : undefined;
  if (state.excludedInitialMarkerQuery) {
    state.preFreshIdentityQuery = sampler.identityInFlight;
    state.initialFreshMarkerRead = observeInitialPosixMarkers(state, true).finally(() => {
      state.initialFreshMarkerRead = undefined;
      state.preFreshIdentityQuery = undefined;
    });
  }
  // The identity table is already available for a subscriber joining an
  // ongoing delivery. Deliver it explicitly, including any lookup failure.
  const initialIdentity = identityQuery && periodic
    ? lateIdentity ? deliverSamplerIdentity(sampler, [state]).byState.get(state)!
      : waitForSamplerDelivery(state, sampler.identityDeliveries, identityQuery)
    : identityQuery;
  const markerQuery = marker === undefined ? undefined : state.initialFreshMarkerRead ?? scanSamplerMarkers(sampler, true);
  const initialMarker = markerQuery && periodic && !state.initialFreshMarkerRead
    ? waitForSamplerDelivery(state, sampler.markerDeliveries, markerQuery) : markerQuery;
  state.initialLookup = (marker === undefined
    ? initialIdentity!
    : Promise.all([
        ...(initialIdentity ? [initialIdentity] : []),
        initialMarker!,
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
  if (dependencies.linuxProcessInspection === 'procfs' || (lease && linuxInspectionLeases.has(lease))) {
    if (!lease || linuxInspectionLeases.get(lease) !== (dependencies.markerEnvironmentVariable ?? DEFAULT_PROCESS_MARKER_ENV)
      || marker !== lease.marker || dependencies.linuxProcessInspection !== 'procfs'
      || dependencies.execFile || dependencies.posixSamplerExecFile || !dependencies.enforceProcessMarker || dependencies.enforceCooperativeProcessGroup
      || (dependencies.platform ?? process.platform) !== 'linux') throw cleanupUnconfirmed('Linux procfs inspection lease is incompatible.');
  }
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
    state.rootPgidMode === 'reused' ||
    state.rootPgid !== state.pid
  ) return undefined;
  const pgid = state.rootPgid;
  const members = [...snapshot.table].filter(([, entry]) =>
    entry.pgid === pgid && !entry.state?.startsWith('Z')
  );
  if (members.length === 0) return undefined;
  if (usesLinuxProcfs(state) && members.some(([pid, entry]) => {
    const known = pid === state.pid ? state.root : state.descendants.get(pid);
    return snapshot.replacementPids?.has(pid) || !snapshot.markerPids.has(pid) || known?.startTime !== entry.startTime;
  })) return undefined;
  if (state.rootPgidMode === 'owned') {
    return groupLeaderWasReused(state, snapshot.table) ? undefined : pgid;
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
  requireCurrentMarker = false,
): void {
  const liveDescendantPids = [...state.descendants.values()].filter((identity) =>
    identity.pid !== state.pid &&
    identity.pid !== state.lease?.sentinel.pid &&
    (!requireCurrentMarker || (snapshot.markerPids.has(identity.pid) && !snapshot.replacementPids?.has(identity.pid))) &&
    posixIdentityMatches(identity, snapshot) &&
    !snapshot.table.get(identity.pid)?.state?.startsWith('Z')
  ).map((identity) => identity.pid);
  if (liveDescendantPids.length === 0) return;
  latchObservationFailure(
    state,
    cleanupUnconfirmed(
      'custom process contract violation: all provider descendants must exit before completion.',
    ),
    posixDiagnostic(state, snapshot, 'termination-start', 'live-descendants-before-completion', liveDescendantPids),
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
  const table = await readWindowsProcessTable(state);
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
  const verifiedTable = await readWindowsProcessTable(state, candidatePids);
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
  const sampler = state.sampler;
  const identityQuery = sampler?.identityInFlight;
  const markerQuery = sampler?.markerInFlight !== state.excludedInitialMarkerQuery ? sampler?.markerInFlight : undefined;
  const pendingObservations = [
    state.initialLookup,
    ...(state.deferredSamplerDelivery ? [state.deferredSamplerDelivery] : []),
    ...(identityQuery ? [waitForSamplerDelivery(state, sampler?.identityDeliveries, identityQuery)] : []),
    ...(markerQuery ? [waitForSamplerDelivery(state, sampler?.markerDeliveries, markerQuery)] : []),
  ];
  const deadline = Date.now() + POSIX_PROCESS_TREE_COMMAND_TIMEOUT_MS;
  const overlappingProcfsQuery = Boolean(sampler?.linuxMarker && (sampler.identityInFlight || sampler.markerInFlight
    || state.initialFreshMarkerRead || state.deferredSamplerDelivery));
  if (sampler) {
    // Freeze this observer's delivery set at the completion boundary. Other
    // subscribers may keep sampling, but only these deliveries are drained.
    state.finalSamplerQueries = new Set([identityQuery, markerQuery]);
    schedulePosixSampler(sampler);
  }
  const kill = state.dependencies.kill ?? process.kill.bind(process);
  let snapshot: PosixProcessSnapshot | undefined;
  try {
    snapshot = await readImmediatePosixSnapshot(state, 'termination-start', {
      pendingObservations, deadline, requireDescendantsExitedBeforeCompletion,
    });
  } finally {
    state.disposed = true;
    stopObservingPosixState(state);
  }
  if (snapshot && overlappingProcfsQuery && snapshot.markerLookupAttempts === 1) {
    // The boundary table proves completion facts. A concurrent observation
    // could have rechecked identities or markers after it. Obtain signal
    // authority after draining it, within the original stage deadline.
    snapshot = await readImmediatePosixSnapshot(state, 'termination-start', { deadline, requireDescendantsExitedBeforeCompletion });
  }
  if (!snapshot) {
    if (!requireConfirmedCleanup && allowInspectionUnavailable) return;
    throw state.failure ?? cleanupUnconfirmed('POSIX process identity lookup failed.');
  }
  if (requireDescendantsExitedBeforeCompletion && state.dependencies.linuxProcessInspection !== 'procfs') {
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
      if (usesLinuxProcfs(state) && (!current.markerPids.has(identity.pid) || current.replacementPids?.has(identity.pid))) continue;
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
    setTimeout(resolve, PROCESS_TREE_SETTLE_MS);
  });
  const verified = await readImmediatePosixSnapshot(state, 'termination-verification');
  if (!verified) {
    throw state.failure ?? cleanupUnconfirmed('POSIX termination verification failed.');
  }
  const remainingIdentities = liveIdentities(verified);
  if (remainingIdentities.length > 0) {
    if (usesLinuxProcfs(state) && state.failure) {
      const marked = remainingIdentities.filter(identity => verified.markerPids.has(identity.pid));
      if (marked.length) state.diagnostics[1] = posixDiagnostic(state, verified, 'termination-verification',
        'verified-process-still-running', marked.map(identity => identity.pid));
    }
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
