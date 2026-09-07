import {
  CatalogProviderCompatibilityError,
  catalogSourceErrorCode,
} from '../../utils/catalog-public-error.js';
import type { CatalogGenerationFreshnessResult } from '../../utils/catalog-generation-service.js';
import type {
  CatalogSourceFreshnessViewModel,
  CatalogSessionReusableCandidate,
  CatalogSourceSessionDescriptor,
} from './types.js';
import { checkAwCapabilitySupport } from '../../utils/manifest.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../../commands/aw-capabilities.js';

export interface CatalogSourcesSessionOptions {
  probe: (
    sourceId: string,
    options: { fullValidation: boolean },
    signal: AbortSignal,
  ) => Promise<CatalogGenerationFreshnessResult>;
  onChange: (sourceId: string, freshness: CatalogSourceFreshnessViewModel) => void;
  onError?: (error: unknown, code: string) => void;
  parentSignal: AbortSignal;
  now?: () => number;
}

interface RunningProbe {
  abort: AbortController;
  token: number;
  automatic: boolean;
  primary: boolean;
}

interface ReusableCandidateEntry {
  candidate: CatalogSessionReusableCandidate;
  token: number;
  fingerprint: string;
}

export class CatalogSourcesSession {
  readonly #sources = new Map<string, CatalogSourceSessionDescriptor>();
  readonly #attempted = new Set<string>();
  readonly #queue: string[] = [];
  readonly #running = new Map<string, RunningProbe>();
  readonly #tokens = new Map<string, number>();
  readonly #reusableCandidates = new Map<string, ReusableCandidateEntry>();
  readonly #lastSuccessful = new Map<string, CatalogSourceFreshnessViewModel>();
  readonly #pending = new Set<Promise<void>>();
  #disposed = false;
  #drainScheduled = false;

  constructor(readonly options: CatalogSourcesSessionOptions) {}

  configure(sources: CatalogSourceSessionDescriptor[]): void {
    if (this.#disposed) return;
    const nextIds = new Set(sources.map((source) => source.sourceId));
    for (const sourceId of this.#sources.keys()) {
      if (nextIds.has(sourceId)) continue;
      this.#cancel(sourceId);
      this.#reusableCandidates.delete(sourceId);
      this.#lastSuccessful.delete(sourceId);
      this.#sources.delete(sourceId);
    }
    for (const source of sources) {
      const previous = this.#sources.get(source.sourceId);
      this.#sources.set(source.sourceId, source);
      if (previous && previous.fingerprint !== source.fingerprint) {
        this.#cancel(source.sourceId);
        this.#reusableCandidates.delete(source.sourceId);
        this.#lastSuccessful.delete(source.sourceId);
        this.#attempted.delete(source.sourceId);
        this.options.onChange(source.sourceId, { sourceId: source.sourceId, state: 'notChecked' });
      }
      if (source.fixedCommit) {
        const automaticRunning = this.#running.get(source.sourceId)?.automatic === true;
        this.#removeQueued(source.sourceId);
        this.#cancelAutomatic(source.sourceId);
        this.#attempted.add(source.sourceId);
        if (!previous?.fixedCommit || automaticRunning) {
          this.options.onChange(source.sourceId, { sourceId: source.sourceId, state: 'fixed' });
        }
        continue;
      }
      if (!source.autoCheck) {
        const wasPending = this.#queue.includes(source.sourceId)
          || this.#running.get(source.sourceId)?.automatic === true;
        this.#removeQueued(source.sourceId);
        this.#cancelAutomatic(source.sourceId);
        if (wasPending) {
          this.options.onChange(source.sourceId, { sourceId: source.sourceId, state: 'notChecked' });
        }
        continue;
      }
      if (!this.#attempted.has(source.sourceId)
        && !this.#queue.includes(source.sourceId)
        && !this.#running.has(source.sourceId)) {
        this.#queue.push(source.sourceId);
      }
    }
    this.#scheduleDrain();
  }

  setAutoCheck(sourceId: string, autoCheck: boolean): void {
    const source = this.#sources.get(sourceId);
    if (!source || source.autoCheck === autoCheck || this.#disposed) return;
    this.#sources.set(sourceId, { ...source, autoCheck });
    if (!autoCheck) {
      const wasPending = this.#queue.includes(sourceId)
        || this.#running.get(sourceId)?.automatic === true;
      this.#removeQueued(sourceId);
      this.#cancelAutomatic(sourceId);
      if (wasPending) this.options.onChange(sourceId, { sourceId, state: 'notChecked' });
      return;
    }
    if (!source.fixedCommit && !this.#attempted.has(sourceId)
      && !this.#queue.includes(sourceId) && !this.#running.has(sourceId)) {
      this.#queue.push(sourceId);
      this.#scheduleDrain();
    }
  }

  recheck(sourceId: string): Promise<void> {
    return this.refresh(sourceId, false);
  }

  fullValidate(sourceId: string): Promise<void> {
    return this.refresh(sourceId, true);
  }

  reusableCandidate(sourceId: string): CatalogSessionReusableCandidate | undefined {
    const entry = this.#reusableCandidates.get(sourceId);
    const source = this.#sources.get(sourceId);
    if (!entry || !source
      || entry.token !== this.#tokens.get(sourceId)
      || entry.fingerprint !== source.fingerprint) return undefined;
    return structuredClone(entry.candidate);
  }

  refresh(sourceId: string, fullValidation: boolean): Promise<void> {
    if (this.#disposed || !this.#sources.has(sourceId)) return Promise.resolve();
    this.#removeQueued(sourceId);
    this.#cancel(sourceId);
    return this.#startTracked(sourceId, false, fullValidation);
  }

  async cancelAndWait(): Promise<void> {
    const pending = [...this.#pending];
    this.dispose();
    await Promise.allSettled(pending);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.length = 0;
    this.#reusableCandidates.clear();
    for (const sourceId of this.#running.keys()) this.#cancel(sourceId);
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled || this.#disposed) return;
    this.#drainScheduled = true;
    queueMicrotask(() => {
      this.#drainScheduled = false;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#disposed) return;
    const primaryRunning = [...this.#running.values()].some((probe) => probe.automatic && probe.primary);
    const queuedPrimaryIndex = this.#queue.findIndex((sourceId) => this.#sources.get(sourceId)?.primary);
    if (!primaryRunning && queuedPrimaryIndex >= 0) {
      const [sourceId] = this.#queue.splice(queuedPrimaryIndex, 1);
      if (sourceId) void this.#startTracked(sourceId, true, false);
    }
    let secondaryRunning = [...this.#running.values()].filter((probe) =>
      probe.automatic && !probe.primary).length;
    while (secondaryRunning < 2) {
      const index = this.#queue.findIndex((sourceId) => !this.#sources.get(sourceId)?.primary);
      if (index < 0) break;
      const [sourceId] = this.#queue.splice(index, 1);
      if (!sourceId) break;
      secondaryRunning += 1;
      void this.#startTracked(sourceId, true, false);
    }
  }

  #startTracked(sourceId: string, automatic: boolean, fullValidation: boolean): Promise<void> {
    const promise = this.#start(sourceId, automatic, fullValidation).finally(() => {
      this.#pending.delete(promise);
    });
    this.#pending.add(promise);
    return promise;
  }

  async #start(sourceId: string, automatic: boolean, fullValidation: boolean): Promise<void> {
    const source = this.#sources.get(sourceId);
    if (!source || this.#disposed || automatic && (!source.autoCheck || this.#attempted.has(sourceId))) {
      return;
    }
    if (automatic) this.#attempted.add(sourceId);
    const abort = new AbortController();
    const token = (this.#tokens.get(sourceId) ?? 0) + 1;
    this.#tokens.set(sourceId, token);
    this.#running.set(sourceId, { abort, token, automatic, primary: source.primary });
    this.options.onChange(sourceId, { sourceId, state: 'checking' });
    const signal = AbortSignal.any([this.options.parentSignal, abort.signal]);
    try {
      const result = await this.options.probe(sourceId, { fullValidation }, signal);
      if (this.#isCurrent(source, token, signal)) {
        const { reusableCandidate, ...freshness } = result;
        if (reusableCandidate) {
          this.#reusableCandidates.set(sourceId, {
            candidate: { sourceId, ...structuredClone(reusableCandidate) },
            token,
            fingerprint: source.fingerprint,
          });
        } else {
          this.#reusableCandidates.delete(sourceId);
        }
        const successful: CatalogSourceFreshnessViewModel = {
          ...structuredClone(freshness),
          checkedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
          ...(reusableCandidate && Array.isArray(reusableCandidate.probe.manifest.entries) ? {
            candidatePlugins: reusableCandidate.probe.manifest.entries.map((entry) => {
              const requiredCapabilities = [...new Set([
                ...(reusableCandidate.probe.manifest.requires.aw.capabilities ?? []),
                ...(entry.requires.aw.capabilities ?? []),
              ])];
              return {
                name: entry.name,
                version: entry.version,
                manifestDigest: entry.manifestDigest,
                contentDigest: entry.contentDigest,
                requiredCapabilities,
                missingCapabilities: checkAwCapabilitySupport(
                  requiredCapabilities,
                  IMPLEMENTED_AW_CAPABILITIES,
                ).missing,
              };
            }),
          } : {}),
        };
        this.#lastSuccessful.set(sourceId, successful);
        this.options.onChange(sourceId, structuredClone(successful));
      }
    } catch (error) {
      if (this.#isCurrent(source, token, signal)) {
        const code = catalogSourceErrorCode(error);
        this.#reusableCandidates.delete(sourceId);
        const previous = this.#lastSuccessful.get(sourceId);
        this.options.onChange(sourceId, {
          ...(previous ? structuredClone(previous) : {}),
          sourceId,
          state: code === 'awCapabilityUnsupported' ? 'incompatible' : 'checkFailed',
          errorCode: code,
          ...(previous ? { lastSuccessful: true } : {}),
          ...(error instanceof CatalogProviderCompatibilityError ? {
            requiredCapabilities: [...error.requiredCapabilities],
            missingCapabilities: [...error.missingCapabilities],
          } : {}),
        });
        this.options.onError?.(error, code);
      }
    } finally {
      const running = this.#running.get(sourceId);
      if (running?.token === token) this.#running.delete(sourceId);
      this.#scheduleDrain();
    }
  }

  #isCurrent(
    source: CatalogSourceSessionDescriptor,
    token: number,
    signal: AbortSignal,
  ): boolean {
    const current = this.#sources.get(source.sourceId);
    return !this.#disposed
      && !signal.aborted
      && token === this.#tokens.get(source.sourceId)
      && current?.fingerprint === source.fingerprint;
  }

  #cancel(sourceId: string): void {
    this.#reusableCandidates.delete(sourceId);
    const running = this.#running.get(sourceId);
    if (!running) return;
    this.#tokens.set(sourceId, running.token + 1);
    running.abort.abort();
    this.#running.delete(sourceId);
  }

  #cancelAutomatic(sourceId: string): void {
    if (this.#running.get(sourceId)?.automatic) this.#cancel(sourceId);
  }

  #removeQueued(sourceId: string): void {
    let index = this.#queue.indexOf(sourceId);
    while (index >= 0) {
      this.#queue.splice(index, 1);
      index = this.#queue.indexOf(sourceId);
    }
  }
}
