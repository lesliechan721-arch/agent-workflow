import type {
  CatalogGenerationCandidateKind,
  CatalogGenerationLastCheckV1,
  CatalogGenerationPointerV1,
  CatalogGenerationRefreshPolicy,
  CatalogManifestV4,
} from '../types.js';
import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import {
  readCatalogGenerationStatus,
  type CatalogGenerationServiceRuntime,
} from '../utils/catalog-generation-service.js';
import { readCatalogGeneration } from '../utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { validateCatalogSnapshot } from '../utils/catalog-snapshot.js';

export type CatalogRefreshState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'validating'
  | 'upToDate'
  | 'candidateReady'
  | 'failed'
  | 'immutableViolation'
  | 'channelRollback';

export interface CatalogPluginChangesViewModel {
  added: number;
  updated: number;
  removed: number;
}

export interface CatalogGenerationViewModel {
  catalogVersion: string;
  channel: 'latest' | 'beta';
  requestedRef: string;
  resolvedCommit: string;
  generationKey: string;
  digestShort: string;
}

export interface CatalogCandidateViewModel extends CatalogGenerationViewModel {
  kind: CatalogGenerationCandidateKind;
  downloadedAt: string;
  pluginChanges: CatalogPluginChangesViewModel;
}

export interface CatalogSourceGenerationViewModel {
  sourceId: string;
  sourceType: 'git' | 'path';
  refreshPolicy: CatalogGenerationRefreshPolicy;
  active?: CatalogGenerationViewModel;
  candidate?: CatalogCandidateViewModel;
  refreshState: CatalogRefreshState;
  lastCheckedAt?: string;
  lastCheckCode?: string;
  remoteCommit?: string;
}

export interface CatalogRefreshExecutionResult {
  source: CatalogSourceGenerationViewModel;
}

export interface CatalogRefreshCoordinatorOptions {
  execute: (
    sourceId: string,
    signal: AbortSignal,
    onState: (state: Extract<CatalogRefreshState, 'checking' | 'downloading' | 'validating'>) => void,
  ) => Promise<CatalogRefreshExecutionResult>;
  onUpdate: (sourceId: string, state: CatalogRefreshState, errorCode?: string) => void;
  onResult?: (source: CatalogSourceGenerationViewModel) => void;
  maxConcurrency?: number;
}

interface RefreshTask {
  sourceId: string;
  abort: AbortController;
  promise: Promise<void>;
  resolve: () => void;
  started: boolean;
  restoreState: CatalogRefreshState;
}

function shortDigest(value: string): string {
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return digest.slice(0, 8);
}

function refreshStateFromLastCheck(
  lastCheck: CatalogGenerationLastCheckV1 | undefined,
): CatalogRefreshState {
  if (!lastCheck) return 'idle';
  return {
    activeReady: 'idle',
    upToDate: 'upToDate',
    candidateReady: 'candidateReady',
    failed: 'failed',
    immutableViolation: 'immutableViolation',
    channelRollback: 'channelRollback',
  }[lastCheck.state] as CatalogRefreshState;
}

function generationViewModel(pointer: CatalogGenerationPointerV1): CatalogGenerationViewModel {
  return {
    catalogVersion: pointer.catalogVersion,
    channel: pointer.channel,
    requestedRef: pointer.requestedRef,
    resolvedCommit: pointer.resolvedCommit,
    generationKey: pointer.generationKey,
    digestShort: shortDigest(pointer.snapshotDigest),
  };
}

function manifestEntryMap(manifest: CatalogManifestV4): Map<string, CatalogManifestV4['entries'][number]> {
  return new Map(manifest.entries.map((entry) => [entry.name, entry]));
}

export function countCatalogPluginChanges(
  active: CatalogManifestV4,
  candidate: CatalogManifestV4,
): CatalogPluginChangesViewModel {
  const activeEntries = manifestEntryMap(active);
  const candidateEntries = manifestEntryMap(candidate);
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const [name, entry] of candidateEntries) {
    const previous = activeEntries.get(name);
    if (!previous) added += 1;
    else if (JSON.stringify(previous) !== JSON.stringify(entry)) updated += 1;
  }
  for (const name of activeEntries.keys()) {
    if (!candidateEntries.has(name)) removed += 1;
  }
  return { added, updated, removed };
}

async function readGenerationManifest(options: {
  logicalIdentity: string;
  pointer: CatalogGenerationPointerV1;
  env: NodeJS.ProcessEnv;
}): Promise<CatalogManifestV4> {
  const generation = await readCatalogGeneration({
    logicalIdentity: options.logicalIdentity,
    snapshotDigest: options.pointer.snapshotDigest,
    env: options.env,
  });
  return (await validateCatalogSnapshot(generation.snapshotRoot)).manifest;
}

export async function loadCatalogGenerationViewModels(options: {
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogSourceGenerationViewModel[]> {
  const env = options.env ?? process.env;
  const [config, state] = await Promise.all([
    readCatalogSourcesConfigSnapshot(env),
    readCatalogGenerationState(env),
  ]);
  const sources = [...config.config.sources]
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  return Promise.all(sources.map(async (configured): Promise<CatalogSourceGenerationViewModel> => {
    const persisted = state.sources[configured.id];
    let source: Awaited<ReturnType<typeof readCatalogGenerationStatus>>['sources'][number];
    try {
      source = (await readCatalogGenerationStatus({ sourceId: configured.id, env })).sources[0]!;
    } catch (error) {
      const code = error instanceof CatalogGenerationError
        ? error.code : 'catalogGenerationUnavailable';
      return {
        sourceId: configured.id,
        sourceType: configured.type,
        refreshPolicy: persisted?.refreshPolicy ?? (configured.type === 'path' ? 'manual' : 'startup'),
        refreshState: 'failed',
        lastCheckCode: code,
        ...(persisted?.lastCheck ? { lastCheckedAt: persisted.lastCheck.checkedAt } : {}),
      };
    }
    let pluginChanges: CatalogPluginChangesViewModel = { added: 0, updated: 0, removed: 0 };
    if (source.logicalIdentity && source.active && source.candidate) {
      const [activeManifest, candidateManifest] = await Promise.all([
        readGenerationManifest({
          logicalIdentity: source.logicalIdentity,
          pointer: source.active,
          env,
        }),
        readGenerationManifest({
          logicalIdentity: source.logicalIdentity,
          pointer: source.candidate,
          env,
        }),
      ]);
      pluginChanges = countCatalogPluginChanges(activeManifest, candidateManifest);
    }
    return {
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      refreshPolicy: source.refreshPolicy,
      ...(source.active ? { active: generationViewModel(source.active) } : {}),
      ...(source.candidate ? {
        candidate: {
          ...generationViewModel(source.candidate),
          kind: source.candidate.candidateKind,
          downloadedAt: source.candidate.downloadedAt,
          pluginChanges,
        },
      } : {}),
      refreshState: refreshStateFromLastCheck(source.lastCheck),
      ...(source.lastCheck ? { lastCheckedAt: source.lastCheck.checkedAt } : {}),
      ...(source.lastCheck?.errorCode ? { lastCheckCode: source.lastCheck.errorCode } : {}),
      ...(source.lastCheck?.remoteCommit ? { remoteCommit: source.lastCheck.remoteCommit } : {}),
    };
  }));
}

function refreshFailure(error: unknown): { state: CatalogRefreshState; code: string } {
  if (error instanceof CatalogGenerationError) {
    if (error.code === 'catalogImmutableVersionViolation') {
      return { state: 'immutableViolation', code: error.code };
    }
    return { state: 'failed', code: error.code };
  }
  return { state: 'failed', code: 'catalogGenerationRefreshFailed' };
}

export class CatalogRefreshCoordinator {
  readonly #tasks = new Map<string, RefreshTask>();
  readonly #queue: RefreshTask[] = [];
  readonly #running = new Set<RefreshTask>();
  readonly #maxConcurrency: number;
  #disposed = false;
  #started = false;

  constructor(readonly options: CatalogRefreshCoordinatorOptions) {
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
  }

  start(sources: readonly CatalogSourceGenerationViewModel[]): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    const eligible = sources
      .filter((source) => source.sourceType === 'git' && source.refreshPolicy === 'startup')
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId, 'en'));
    queueMicrotask(() => {
      if (this.#disposed) return;
      for (const source of eligible) void this.refresh(source.sourceId, source.refreshState);
    });
  }

  refresh(sourceId: string, restoreState: CatalogRefreshState = 'idle'): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    const current = this.#tasks.get(sourceId);
    if (current) return current.promise;
    let resolve!: () => void;
    const task: RefreshTask = {
      sourceId,
      abort: new AbortController(),
      promise: new Promise<void>((done) => { resolve = done; }),
      resolve: () => resolve(),
      started: false,
      restoreState,
    };
    this.#tasks.set(sourceId, task);
    this.#queue.push(task);
    this.#drain();
    return task.promise;
  }

  cancel(sourceId: string): void {
    const task = this.#tasks.get(sourceId);
    if (!task) return;
    task.abort.abort();
    if (!task.started) this.#finish(task, task.restoreState);
  }

  refreshingSourceIds(): string[] {
    return [...this.#tasks.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const task of this.#tasks.values()) task.abort.abort();
    for (const task of [...this.#queue]) this.#finish(task, task.restoreState);
  }

  #drain(): void {
    if (this.#disposed) return;
    while (this.#running.size < this.#maxConcurrency && this.#queue.length > 0) {
      const task = this.#queue.shift()!;
      if (task.abort.signal.aborted) {
        this.#finish(task, task.restoreState);
        continue;
      }
      task.started = true;
      this.#running.add(task);
      this.options.onUpdate(task.sourceId, 'checking');
      void this.options.execute(task.sourceId, task.abort.signal, (state) => {
        if (!task.abort.signal.aborted) this.options.onUpdate(task.sourceId, state);
      }).then(({ source }) => {
        if (!task.abort.signal.aborted) {
          this.options.onResult?.(source);
          this.#finish(task, source.refreshState, source.lastCheckCode);
        }
        else this.#finish(task, task.restoreState);
      }).catch((error: unknown) => {
        if (task.abort.signal.aborted) this.#finish(task, task.restoreState);
        else {
          const failure = refreshFailure(error);
          this.#finish(task, failure.state, failure.code);
        }
      });
    }
  }

  #finish(task: RefreshTask, state: CatalogRefreshState, errorCode?: string): void {
    const queueIndex = this.#queue.indexOf(task);
    if (queueIndex >= 0) this.#queue.splice(queueIndex, 1);
    this.#running.delete(task);
    if (this.#tasks.get(task.sourceId) === task) this.#tasks.delete(task.sourceId);
    this.options.onUpdate(task.sourceId, state, errorCode);
    task.resolve();
    this.#drain();
  }
}

export type CatalogGenerationRefreshRuntime = CatalogGenerationServiceRuntime;
