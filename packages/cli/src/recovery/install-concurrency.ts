import os from 'node:os';
import path from 'node:path';
import { retainNativeCliRunnerBackend, withInstallNativeMarkerScans, type NativeCliRunner } from '../utils/native-cli.js';
import { canonicalizePathThroughExistingAncestorSync } from '../utils/state-paths.js';
import { recoveryInterruptionCode } from './interruption.js';

export function installConcurrencyLimits(): { reads: number; writes: number } {
  const cores = os.availableParallelism();
  return { reads: Math.min(4, Math.max(1, cores)), writes: Math.min(2, Math.max(1, cores)) };
}

function concurrencyLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid install concurrency limit');
  return limit;
}

function cleanupUnconfirmed(error: unknown): boolean {
  return recoveryInterruptionCode(error) === 'processCleanupUnconfirmed';
}

/** Drain started reads before the caller releases their observation context. */
export async function mapInstallReads<T, R>(items: readonly T[], read: (item: T, index: number) => Promise<R>,
  options: { signal?: AbortSignal; limit?: number } = {}): Promise<R[]> {
  options.signal?.throwIfAborted();
  const count = Math.min(items.length, concurrencyLimit(options.limit ?? installConcurrencyLimits().reads));
  const results: R[] = new Array(items.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length && !options.signal?.aborted && !failures.length) {
      const index = next++;
      try { results[index] = await read(items[index]!, index); }
      catch (error) { failures.push({ index, error }); }
    }
  }
  await Promise.all(Array.from({ length: count }, worker));
  failures.sort((a, b) => a.index - b.index);
  const cleanup = failures.find(({ error }) => cleanupUnconfirmed(error));
  if (cleanup) throw cleanup.error;
  options.signal?.throwIfAborted();
  if (failures.length) throw failures[0]!.error;
  return results;
}

export type InstallResource = { kind: 'exclusive' }
  | { kind: 'path' | 'key'; value: string; access?: 'read' | 'write' };

export interface InstallTaskProgress {
  running: number;
  completed: number;
  waitingForDependencies: number;
  waiting: number;
}

export interface InstallAdmission {
  /** An opaque writer may change the inputs of otherwise independent targets. */
  readonly exclusiveGeneration: number;
  run<T>(resources: readonly InstallResource[], action: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function canonicalResource(resource: InstallResource): InstallResource {
  if (resource.kind !== 'path') return resource;
  // An unresolved location must not be treated as independent. The actual
  // writer still owns authorization, symlink checks and its normal diagnostics.
  if (!path.isAbsolute(resource.value)) return { kind: 'exclusive' };
  try {
    let value = canonicalizePathThroughExistingAncestorSync(resource.value);
    if (process.platform === 'darwin' || process.platform === 'win32') value = value.normalize('NFC').toLowerCase();
    return { ...resource, value };
  } catch { return { kind: 'exclusive' }; }
}

function containsPath(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function conflicts(left: readonly InstallResource[], right: readonly InstallResource[]): boolean {
  if (left.some((item) => item.kind === 'exclusive') || right.some((item) => item.kind === 'exclusive')) return true;
  return left.some((a) => right.some((b) => {
    if (a.kind === 'exclusive' || b.kind === 'exclusive' || a.kind !== b.kind
      || a.access === 'read' && b.access === 'read') return false;
    return a.kind === 'path' ? containsPath(a.value, b.value) || containsPath(b.value, a.value) : a.value === b.value;
  }));
}

/** Acquire all resources for one leaf operation together, under the existing AW_HOME lock. */
export function createInstallAdmission(options: { signal?: AbortSignal; limit?: number } = {}): InstallAdmission {
  const limit = concurrencyLimit(options.limit ?? installConcurrencyLimits().writes);
  interface Entry { resources: InstallResource[]; start(): void }
  const stopped = new AbortController();
  const operationSignal = options.signal ? AbortSignal.any([stopped.signal, options.signal]) : stopped.signal;
  const waiting: Entry[] = [];
  const running = new Set<Entry>();
  let generation = 0;
  function dispatch(): void {
    while (running.size < limit) {
      const index = waiting.findIndex((entry) => ![...running].some((other) => conflicts(entry.resources, other.resources)));
      if (index < 0) return;
      const [entry] = waiting.splice(index, 1);
      running.add(entry!);
      entry!.start();
    }
  }
  return {
    get exclusiveGeneration() { return generation; },
    async run<T>(resources: readonly InstallResource[], action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      const cancellation = signal && signal !== options.signal ? AbortSignal.any([operationSignal, signal]) : operationSignal;
      cancellation.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = { resources: resources.map(canonicalResource), start() {
          cancellation.removeEventListener('abort', abort);
          const execute = async () => {
            try { cancellation.throwIfAborted(); resolve(await action()); }
            catch (error) {
              // Stop queued leaves before releasing an unconfirmed process's resources.
              if (cleanupUnconfirmed(error)) stopped.abort(error);
              reject(error);
            } finally {
              if (entry.resources.some((resource) => resource.kind === 'exclusive')) generation++;
              running.delete(entry);
              dispatch();
            }
          };
          void execute();
        } };
        function abort(): void {
          const index = waiting.indexOf(entry);
          if (index !== -1) waiting.splice(index, 1);
          reject(cancellation.reason);
        }
        waiting.push(entry);
        cancellation.addEventListener('abort', abort, { once: true });
        dispatch();
      });
    },
  };
}

export interface InstallTask<T> {
  id: string;
  dependencies?: readonly string[];
  resources: readonly InstallResource[];
  run: () => Promise<T>;
}

/** Keep stable receipt order while unrelated ready tasks can complete out of order. */
export async function runInstallTasks<T>(tasks: readonly InstallTask<T>[], options: {
  signal?: AbortSignal; limit?: number;
  /** Set null for dependency groups which only submit work to the operation's leaf admission. */
  admission?: InstallAdmission | null;
} = {}): Promise<T[]> {
  options.signal?.throwIfAborted();
  const ordered: Array<InstallTask<T>> = [];
  const known = new Set<string>();
  const pending = new Set(tasks);
  while (pending.size) {
    const previous = pending.size;
    for (const task of pending) {
      if (task.dependencies?.some((key) => !known.has(key))) continue;
      if (options.admission === null && task.resources.length) throw new Error('Install resources require admission');
      if (known.has(task.id)) throw new Error('dependencyContractInvalid: duplicate install task');
      known.add(task.id); ordered.push(task); pending.delete(task);
    }
    if (previous === pending.size) throw new Error('dependencyContractInvalid: missing or cyclic install dependency');
  }
  if (ordered.length !== tasks.length) throw new Error('dependencyContractInvalid: duplicate install task');
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  const admission = options.admission === undefined ? createInstallAdmission({ limit: options.limit }) : options.admission;
  const jobs = new Map<string, Promise<T>>();
  for (const task of ordered) {
    const predecessors = (task.dependencies ?? []).map((key) => jobs.get(key)!);
    const run = async () => {
      signal.throwIfAborted();
      try { return await task.run(); }
      catch (error) { stop.abort(error); throw error; }
    };
    jobs.set(task.id, Promise.all(predecessors).then(() => admission ? admission.run(task.resources, run, signal) : run()));
  }
  const settled = await Promise.allSettled(tasks.map((task) => jobs.get(task.id)!));
  for (const entry of settled) if (entry.status === 'rejected' && cleanupUnconfirmed(entry.reason)) throw entry.reason;
  signal.throwIfAborted();
  return settled.map((entry) => { if (entry.status === 'rejected') throw entry.reason; return entry.value; });
}

const limitedNativeRunners = new WeakSet<NativeCliRunner>();

/** Limit actual processes, including nested adapter probes, without holding a worker while waiting for its children. */
export function limitInstallNativeRunner(runner: NativeCliRunner, limit = installConcurrencyLimits().reads): NativeCliRunner {
  if (limitedNativeRunners.has(runner)) return runner;
  const admission = createInstallAdmission({ limit });
  const installRunner = withInstallNativeMarkerScans(runner);
  const limited = retainNativeCliRunnerBackend((invocation) => admission.run([], () => installRunner(invocation), invocation.signal), runner);
  limitedNativeRunners.add(limited);
  return limited;
}
