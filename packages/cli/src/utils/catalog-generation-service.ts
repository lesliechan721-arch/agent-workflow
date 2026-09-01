import type {
  CatalogGenerationActiveV1,
  CatalogGenerationCandidateComparison,
  CatalogGenerationCandidateEvidence,
  CatalogGenerationLastSyncV1,
  CatalogGenerationSyncResult,
  CatalogSource,
  CatalogSourceResolution,
} from '../types.js';
import fs from 'fs-extra';
import { withAwHomeMutationLock } from './aw-home-mutation-lock.js';
import { CatalogGenerationError, catalogGenerationErrorCode } from './catalog-generation-error.js';
import {
  createCatalogStoreKey,
  publishCatalogStoreEntry,
  readCatalogSnapshotLogicalIdentity,
  readCatalogStoreEntry,
  replaceDamagedCatalogStoreEntry,
  resolveCatalogStoreLocation,
  type CatalogStoreEntry,
} from './catalog-generation-store.js';
import { readCatalogGenerationState, withCatalogGenerationStateTransaction } from './catalog-generation-state.js';
export { removeCatalogSourceGenerationState } from './catalog-generation-state.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { calculateCatalogSourceConfigFingerprint, calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';
import { catalogGitProviderInternal } from './git-catalog-provider.js';
import { catalogPathProviderInternal } from './path-catalog-provider.js';

export interface CatalogGenerationProviderSet {
  git: typeof catalogGitProviderInternal.resolve;
  path: typeof catalogPathProviderInternal.resolve;
}

export interface CatalogGenerationServiceRuntime {
  providers?: CatalogGenerationProviderSet;
  now?: () => Date;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
}

export interface CatalogGenerationProbeResult {
  sourceId: string;
  candidate: CatalogGenerationCandidateEvidence;
}

export interface CatalogGenerationStatusEntry {
  sourceId: string;
  configuredSourceIdentity: string;
  active?: CatalogGenerationActiveV1;
  activeReady: boolean;
  configMatchesActive: boolean;
  catalogVersion?: string;
  channel?: 'latest' | 'beta';
  storeKey?: string;
  lastSync?: CatalogGenerationLastSyncV1;
  errorCode?: string;
}

export interface CatalogGenerationStatusPayload {
  catalogGenerationStatusSchemaVersion: 1;
  sources: CatalogGenerationStatusEntry[];
}

type ResolvedCandidate = {
  source: CatalogSource;
  resolution: CatalogSourceResolution;
  candidate: CatalogGenerationCandidateEvidence;
};

type CandidateContinuity = Pick<
  CatalogGenerationCandidateEvidence,
  'sourceConfigFingerprint' | 'sourceIdentity'
> & { resolvedCommit?: string };

const CANDIDATE_FIELDS: ReadonlyArray<keyof CatalogGenerationCandidateEvidence> = [
  'sourceConfigFingerprint', 'sourceIdentity', 'logicalIdentity', 'requestedRef',
  'resolvedCommit', 'catalogVersion', 'channel', 'manifestDigest', 'snapshotDigest',
];

function now(runtime?: CatalogGenerationServiceRuntime): string {
  return (runtime?.now?.() ?? new Date()).toISOString();
}

function warnCleanupFailure(sourceId: string): void {
  try {
    process.emitWarning(`Catalog provider staging cleanup failed for source "${sourceId}".`, {
      code: 'AW_CATALOG_PROVIDER_CLEANUP_FAILED',
    });
  } catch {
    // Cleanup diagnostics cannot replace the operation result.
  }
}

async function resolveProvider(options: {
  source: CatalogSource;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogSourceResolution> {
  const providers = options.runtime?.providers ?? {
    git: catalogGitProviderInternal.resolve,
    path: catalogPathProviderInternal.resolve,
  };
  return providers[options.source.type](options.source as never, {
    cliVersion: options.cliVersion,
    env: options.env,
    signal: options.signal,
  });
}

async function resolveCandidate(options: {
  sourceId: string;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<ResolvedCandidate> {
  const config = await readCatalogSourcesConfigSnapshot(options.env);
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const resolution = await resolveProvider({ source, ...options });
  try {
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    if (resolution.sourceId !== source.id || resolution.sourceIdentity !== sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch', sourceId: source.id,
        message: `Catalog provider returned mismatched identity for source "${source.id}".`,
      });
    }
    const validation = await validateCatalogSnapshotTransport(resolution.rootDir);
    if (
      validation.manifestDigest !== resolution.manifestDigest
      || validation.snapshotDigest !== resolution.snapshotDigest
    ) throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch', sourceId: source.id,
      message: `Catalog provider returned mismatched snapshot evidence for source "${source.id}".`,
    });
    return {
      source,
      resolution,
      candidate: {
        sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
        sourceIdentity: resolution.sourceIdentity,
        logicalIdentity: await readCatalogSnapshotLogicalIdentity(resolution.rootDir),
        catalogVersion: validation.manifest.catalogVersion,
        channel: validation.manifest.channel,
        requestedRef: resolution.requestedRef,
        resolvedCommit: resolution.resolvedCommit,
        manifestDigest: resolution.manifestDigest,
        snapshotDigest: resolution.snapshotDigest,
      },
    };
  } catch (error) {
    await resolution.cleanup().catch(() => warnCleanupFailure(source.id));
    throw error;
  }
}

export function compareCatalogGenerationCandidates(
  expected: CatalogGenerationCandidateEvidence,
  actual: CatalogGenerationCandidateEvidence,
): CatalogGenerationCandidateComparison {
  const changedFields = CANDIDATE_FIELDS.filter((field) => expected[field] !== actual[field]);
  return { matches: changedFields.length === 0, changedFields };
}

function publicEvidence(candidate: CatalogGenerationCandidateEvidence) {
  const { sourceConfigFingerprint: _fingerprint, ...evidence } = candidate;
  return evidence;
}

function sameActive(
  active: CatalogGenerationActiveV1 | undefined,
  next: Omit<CatalogGenerationActiveV1, 'activatedAt'>,
): active is CatalogGenerationActiveV1 {
  return Boolean(active)
    && active!.sourceConfigFingerprint === next.sourceConfigFingerprint
    && active!.sourceIdentity === next.sourceIdentity
    && active!.requestedRef === next.requestedRef
    && active!.resolvedCommit === next.resolvedCommit
    && active!.logicalIdentity === next.logicalIdentity
    && active!.manifestDigest === next.manifestDigest
    && active!.snapshotDigest === next.snapshotDigest;
}

async function assertCurrentSource(options: {
  sourceId: string;
  candidate: CandidateContinuity;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const config = await readCatalogSourcesConfigSnapshot(options.env);
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" was removed during sync.`,
  });
  if (
    calculateCatalogSourceConfigFingerprint(source) !== options.candidate.sourceConfigFingerprint
    || await calculateCatalogSourceIdentity(source) !== options.candidate.sourceIdentity
  ) throw new CatalogGenerationError({
    code: 'catalogGenerationIdentityMismatch', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" changed during sync. Run sync again.`,
  });
}

function assertLogicalContinuity(
  sourceId: string,
  active: CatalogGenerationActiveV1 | undefined,
  candidate: CatalogGenerationCandidateEvidence,
): void {
  if (
    active
    && active.sourceConfigFingerprint === candidate.sourceConfigFingerprint
    && active.sourceIdentity === candidate.sourceIdentity
    && active.logicalIdentity !== candidate.logicalIdentity
  ) throw new CatalogGenerationError({
    code: 'catalogLogicalIdentityChanged', sourceId,
    message: `Catalog source "${sourceId}" changed logical identity without a source configuration change.`,
  });
}

function assertStoreMatchesCandidate(
  sourceId: string,
  store: CatalogStoreEntry,
  candidate: CatalogGenerationCandidateEvidence,
): void {
  if (
    store.metadata.logicalIdentity !== candidate.logicalIdentity
    || store.metadata.manifestDigest !== candidate.manifestDigest
    || store.metadata.snapshotDigest !== candidate.snapshotDigest
  ) throw new CatalogGenerationError({
    code: 'catalogGenerationPublishFailed', sourceId,
    message: `Catalog store evidence does not match the validated candidate for source "${sourceId}".`,
  });
}

async function writeLastSync(options: {
  sourceId: string;
  candidate: CandidateContinuity;
  mode: 'check' | 'sync';
  state: 'succeeded' | 'failed';
  errorCode?: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationLastSyncV1> {
  return withAwHomeMutationLock({
    env: options.env,
    signal: options.signal,
    action: async () => {
      await assertCurrentSource(options);
      const lastSync: CatalogGenerationLastSyncV1 = {
        syncedAt: now(options.runtime), mode: options.mode, state: options.state,
        ...(options.state === 'succeeded'
          ? { resolvedCommit: options.candidate.resolvedCommit! }
          : { errorCode: options.errorCode! }),
      };
      await withCatalogGenerationStateTransaction({
        env: options.env,
        beforeReplace: () => assertCurrentSource(options),
        action: async (current) => ({
          state: {
            schemaVersion: 1,
            sources: {
              ...current.sources,
              [options.sourceId]: { ...current.sources[options.sourceId], lastSync },
            },
          },
          result: undefined,
        }),
      });
      return lastSync;
    },
  });
}

async function recordFailure(options: {
  sourceId: string;
  candidate?: CandidateContinuity;
  mode: 'check' | 'sync';
  errorCode: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  if (!options.candidate) return;
  await writeLastSync({ ...options, candidate: options.candidate, state: 'failed' })
    .catch(() => undefined);
}

async function readCandidateContinuity(
  sourceId: string,
  env: NodeJS.ProcessEnv,
): Promise<CandidateContinuity | undefined> {
  const source = (await readCatalogSourcesConfigSnapshot(env)).config.sources
    .find((entry) => entry.id === sourceId);
  if (!source) return undefined;
  return {
    sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(source),
    sourceIdentity: await calculateCatalogSourceIdentity(source),
  };
}

export async function probeCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationProbeResult> {
  const env = options.env ?? process.env;
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    return { sourceId: options.sourceId, candidate: resolved.candidate };
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function recordCatalogGenerationCheck(options: {
  probe: CatalogGenerationProbeResult;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const lastSync = await writeLastSync({
    sourceId: options.probe.sourceId, candidate: options.probe.candidate,
    mode: 'check', state: 'succeeded', env,
    signal: options.signal, runtime: options.runtime,
  });
  const active = (await readCatalogGenerationState(env)).sources[options.probe.sourceId]?.active;
  return {
    catalogGenerationSchemaVersion: 1, sourceId: options.probe.sourceId,
    mode: 'check', outcome: 'checked', activeChanged: false,
    resolution: publicEvidence(options.probe.candidate),
    ...(active ? { active } : {}), lastSync,
  };
}

async function activateResolvedCandidate(options: {
  sourceId: string;
  resolved: ResolvedCandidate;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  store?: CatalogStoreEntry;
}): Promise<CatalogGenerationSyncResult> {
  const candidate = options.resolved.candidate;
  const store = options.store ?? await publishCatalogStoreEntry({
    resolution: options.resolved.resolution, env: options.env, signal: options.signal,
  });
  assertStoreMatchesCandidate(options.sourceId, store, candidate);
  return withAwHomeMutationLock({
    env: options.env,
    signal: options.signal,
    action: async () => {
      await assertCurrentSource({ sourceId: options.sourceId, candidate, env: options.env });
      const syncedAt = now(options.runtime);
      return withCatalogGenerationStateTransaction({
        env: options.env,
        beforeReplace: () => assertCurrentSource({ sourceId: options.sourceId, candidate, env: options.env }),
        action: async (current) => {
          const previous = current.sources[options.sourceId]?.active;
          assertLogicalContinuity(options.sourceId, previous, candidate);
          const activeInput = {
            sourceConfigFingerprint: candidate.sourceConfigFingerprint,
            sourceIdentity: candidate.sourceIdentity,
            requestedRef: candidate.requestedRef,
            resolvedCommit: candidate.resolvedCommit,
            logicalIdentity: store.metadata.logicalIdentity,
            manifestDigest: store.metadata.manifestDigest,
            snapshotDigest: store.metadata.snapshotDigest,
          };
          const unchanged = sameActive(previous, activeInput);
          const active: CatalogGenerationActiveV1 = unchanged
            ? previous
            : { ...activeInput, activatedAt: syncedAt };
          const lastSync: CatalogGenerationLastSyncV1 = {
            syncedAt, mode: 'sync', state: 'succeeded', resolvedCommit: candidate.resolvedCommit,
          };
          return {
            state: {
              schemaVersion: 1,
              sources: { ...current.sources, [options.sourceId]: { active, lastSync } },
            },
            result: {
              catalogGenerationSchemaVersion: 1 as const, sourceId: options.sourceId,
              mode: 'sync' as const, outcome: unchanged ? 'unchanged' as const : 'activated' as const,
              activeChanged: !unchanged, resolution: publicEvidence(candidate), active, lastSync,
            },
          };
        },
      });
    },
  });
}

export async function activateCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  expectedCandidate?: CatalogGenerationCandidateEvidence;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const initialCandidate = await readCandidateContinuity(options.sourceId, env);
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    if (options.expectedCandidate
      && !compareCatalogGenerationCandidates(options.expectedCandidate, resolved.candidate).matches) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationReviewStale', sourceId: options.sourceId,
        message: `Catalog source "${options.sourceId}" changed after review. Review it again.`,
      });
    }
    return await activateResolvedCandidate({ ...options, env, resolved });
  } catch (error) {
    await recordFailure({
      sourceId: options.sourceId, candidate: resolved?.candidate ?? initialCandidate, mode: 'sync',
      errorCode: error instanceof CatalogGenerationError
        ? error.code : 'catalogGenerationRefreshFailed',
      env, signal: options.signal, runtime: options.runtime,
    });
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed', sourceId: options.sourceId,
      message: `Cannot sync Catalog source "${options.sourceId}". The previous Active snapshot is unchanged.`,
      cause: error,
    });
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function repairCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  const env = options.env ?? process.env;
  const target = (await readCatalogGenerationState(env)).sources[options.sourceId]?.active;
  if (!target) throw new CatalogGenerationError({
    code: 'catalogGenerationUnavailable', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" has no Active snapshot to repair.`,
  });
  let resolved: ResolvedCandidate | undefined;
  try {
    resolved = await resolveCandidate({ ...options, env });
    assertLogicalContinuity(options.sourceId, target, resolved.candidate);
    let store: CatalogStoreEntry;
    const candidateStoreKey = createCatalogStoreKey(
      resolved.candidate.logicalIdentity,
      resolved.candidate.snapshotDigest,
    );
    const targetStoreKey = createCatalogStoreKey(target.logicalIdentity, target.snapshotDigest);
    if (candidateStoreKey !== targetStoreKey) {
      store = await publishCatalogStoreEntry({ resolution: resolved.resolution, env, signal: options.signal });
    } else {
      const targetLocation = resolveCatalogStoreLocation({
        logicalIdentity: target.logicalIdentity,
        snapshotDigest: target.snapshotDigest,
        env,
      });
      const targetExists = await fs.lstat(targetLocation.entryDir)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false;
          throw error;
        });
      if (!targetExists) {
        store = await publishCatalogStoreEntry({ resolution: resolved.resolution, env, signal: options.signal });
      } else {
        try {
          store = await readCatalogStoreEntry({
            logicalIdentity: target.logicalIdentity, snapshotDigest: target.snapshotDigest, env,
          });
        } catch {
          store = await replaceDamagedCatalogStoreEntry({
            resolution: resolved.resolution,
            logicalIdentity: target.logicalIdentity,
            snapshotDigest: target.snapshotDigest,
            env, signal: options.signal,
          });
        }
      }
    }
    return await activateResolvedCandidate({ ...options, env, resolved, store });
  } finally {
    if (resolved) await resolved.resolution.cleanup().catch(() => warnCleanupFailure(options.sourceId));
  }
}

export async function syncCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  check?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationSyncResult> {
  if (!options.check) return activateCatalogSourceGeneration(options);
  const env = options.env ?? process.env;
  const initialCandidate = await readCandidateContinuity(options.sourceId, env);
  let probe: CatalogGenerationProbeResult | undefined;
  try {
    probe = await probeCatalogSourceGeneration({ ...options, env });
    return await recordCatalogGenerationCheck({ probe, env, signal: options.signal, runtime: options.runtime });
  } catch (error) {
    await recordFailure({
      sourceId: options.sourceId, candidate: probe?.candidate ?? initialCandidate, mode: 'check',
      errorCode: error instanceof CatalogGenerationError
        ? error.code : 'catalogGenerationRefreshFailed',
      env, signal: options.signal, runtime: options.runtime,
    });
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed', sourceId: options.sourceId,
      message: `Cannot check Catalog source "${options.sourceId}".`, cause: error,
    });
  }
}

export async function readCatalogGenerationStatus(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogGenerationStatusPayload> {
  const env = options.env ?? process.env;
  const config = await readCatalogSourcesConfigSnapshot(env);
  const state = await readCatalogGenerationState(env);
  const selected = options.sourceId
    ? config.config.sources.filter((source) => source.id === options.sourceId)
    : config.config.sources;
  if (options.sourceId && selected.length === 0) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing', sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const sources = await Promise.all(selected.map(async (source): Promise<CatalogGenerationStatusEntry> => {
    const configuredSourceIdentity = await calculateCatalogSourceIdentity(source);
    const sourceState = state.sources[source.id];
    const active = sourceState?.active;
    const configMatchesActive = Boolean(active)
      && active!.sourceIdentity === configuredSourceIdentity
      && active!.sourceConfigFingerprint === calculateCatalogSourceConfigFingerprint(source);
    if (!active) return {
      sourceId: source.id, configuredSourceIdentity, activeReady: false,
      configMatchesActive: false, lastSync: sourceState?.lastSync,
    };
    try {
      const entry = await readCatalogStoreEntry({
        logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env,
      });
      if (entry.metadata.manifestDigest !== active.manifestDigest) throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch', message: 'Active does not match store metadata.',
      });
      return {
        sourceId: source.id, configuredSourceIdentity, active,
        activeReady: configMatchesActive, configMatchesActive,
        catalogVersion: entry.metadata.catalogVersion, channel: entry.metadata.channel,
        storeKey: createCatalogStoreKey(active.logicalIdentity, active.snapshotDigest),
        lastSync: sourceState?.lastSync,
      };
    } catch (error) {
      return {
        sourceId: source.id, configuredSourceIdentity, active, activeReady: false,
        configMatchesActive, lastSync: sourceState?.lastSync,
        errorCode: catalogGenerationErrorCode(error),
      };
    }
  }));
  return { catalogGenerationStatusSchemaVersion: 1, sources };
}
