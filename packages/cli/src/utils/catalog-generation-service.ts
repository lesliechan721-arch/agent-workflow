import type {
  CatalogGenerationActivationResult,
  CatalogGenerationCandidateKind,
  CatalogGenerationCandidateV1,
  CatalogGenerationLastCheckV1,
  CatalogGenerationPointerV1,
  CatalogGenerationRefreshResult,
  CatalogSource,
  CatalogSourceGenerationStateV1,
  CatalogSourceResolution,
} from '../types.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from './catalog-generation-state.js';
import {
  discardPreparedCatalogGeneration,
  listCatalogGenerationsForIdentity,
  prepareCatalogGeneration,
  publishPreparedCatalogGeneration,
  readCatalogGeneration,
  type PublishedCatalogGeneration,
} from './catalog-generation-store.js';
import { calculateCatalogSourceConfigFingerprint } from './catalog-source-identity.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';
import { catalogGitProviderInternal } from './git-catalog-provider.js';
import { compareStrictSemVer } from './manifest.js';
import type { CatalogSourceProviderSet } from './multi-source-catalog.js';
import { catalogPathProviderInternal } from './path-catalog-provider.js';

export interface CatalogGenerationServiceRuntime {
  providers?: CatalogSourceProviderSet;
  now?: () => Date;
}

export interface CatalogGenerationStatusEntry {
  sourceId: string;
  sourceType: CatalogSource['type'];
  logicalIdentity?: string;
  refreshPolicy: 'startup' | 'manual';
  active?: CatalogGenerationPointerV1;
  candidate?: CatalogGenerationCandidateV1;
  lastCheck?: CatalogGenerationLastCheckV1;
}

export interface CatalogGenerationStatusPayload {
  catalogGenerationStatusSchemaVersion: 1;
  sources: CatalogGenerationStatusEntry[];
}

type RefreshTransactionResult =
  | { error: CatalogGenerationError }
  | { value: CatalogGenerationRefreshResult };

function defaultProviders(): CatalogSourceProviderSet {
  return {
    git: catalogGitProviderInternal.resolve,
    path: catalogPathProviderInternal.resolve,
  };
}

async function resolveSourceForRefresh(options: {
  source: CatalogSource;
  cliVersion: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  providers?: CatalogSourceProviderSet;
}): Promise<CatalogSourceResolution> {
  const providers = options.providers ?? defaultProviders();
  try {
    return options.source.type === 'git'
      ? await providers.git(options.source, {
          cliVersion: options.cliVersion,
          freshnessPolicy: 'forceRemote',
          env: options.env,
          signal: options.signal,
        })
      : await providers.path(options.source, {
          cliVersion: options.cliVersion,
          freshnessPolicy: 'forceRemote',
          env: options.env,
          signal: options.signal,
        });
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed',
      sourceId: options.source.id,
      message: `Cannot refresh Catalog source "${options.source.id}". The previous Active generation is unchanged.`,
      cause: error,
    });
  }
}

function pointerFromGeneration(options: {
  generation: PublishedCatalogGeneration;
  resolution: CatalogSourceResolution;
  sourceConfigFingerprint: string;
  activatedAt?: string;
}): CatalogGenerationPointerV1 {
  return {
    sourceConfigFingerprint: options.sourceConfigFingerprint,
    catalogVersion: options.generation.metadata.catalogVersion,
    channel: options.generation.metadata.channel,
    requestedRef: options.resolution.requestedRef,
    resolvedCommit: options.resolution.resolvedCommit,
    manifestDigest: options.generation.metadata.manifestDigest,
    snapshotDigest: options.generation.metadata.snapshotDigest,
    generationKey: options.generation.metadata.generationKey,
    ...(options.activatedAt ? { activatedAt: options.activatedAt } : {}),
  };
}

function candidateFromGeneration(options: {
  generation: PublishedCatalogGeneration;
  resolution: CatalogSourceResolution;
  sourceConfigFingerprint: string;
  candidateKind: CatalogGenerationCandidateKind;
  downloadedAt: string;
}): CatalogGenerationCandidateV1 {
  return {
    ...pointerFromGeneration(options),
    candidateKind: options.candidateKind,
    downloadedAt: options.downloadedAt,
  };
}

function checked(options: {
  checkedAt: string;
  state: CatalogGenerationLastCheckV1['state'];
  resolution: CatalogSourceResolution;
  errorCode?: string;
}): CatalogGenerationLastCheckV1 {
  return {
    checkedAt: options.checkedAt,
    state: options.state,
    remoteCommit: options.resolution.resolvedCommit,
    ...(options.errorCode ? { errorCode: options.errorCode } : {}),
  };
}

async function recordRefreshFailure(options: {
  sourceId: string;
  sourceConfigFingerprint: string;
  env: NodeJS.ProcessEnv;
  checkedAt: string;
  errorCode: string;
}): Promise<void> {
  await withAwHomeMutationLock({
    env: options.env,
    action: async () => {
      const config = await readCatalogSourcesConfigSnapshot(options.env);
      const configured = config.config.sources.find((source) => source.id === options.sourceId);
      if (
        !configured
        || calculateCatalogSourceConfigFingerprint(configured) !== options.sourceConfigFingerprint
      ) return;
      await withCatalogGenerationStateTransaction({
        env: options.env,
        action: async (current) => {
          const source = current.sources[options.sourceId];
          if (!source) return { state: current, result: undefined };
          return {
            state: {
              ...current,
              sources: {
                ...current.sources,
                [options.sourceId]: {
                  ...source,
                  lastCheck: {
                    checkedAt: options.checkedAt,
                    state: 'failed',
                    errorCode: options.errorCode,
                  },
                },
              },
            },
            result: undefined,
          };
        },
      });
    },
  });
}

function sameGeneration(
  pointer: CatalogGenerationPointerV1 | undefined,
  generation: PublishedCatalogGeneration,
  sourceConfigFingerprint: string,
): boolean {
  return pointer?.sourceConfigFingerprint === sourceConfigFingerprint
    && pointer.catalogVersion === generation.metadata.catalogVersion
    && pointer.snapshotDigest === generation.metadata.snapshotDigest;
}

export async function refreshCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<CatalogGenerationRefreshResult> {
  const env = options.env ?? process.env;
  const config = await readCatalogSourcesConfigSnapshot(env);
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" is not configured.`,
    });
  }
  const sourceConfigFingerprint = calculateCatalogSourceConfigFingerprint(source);
  const checkedAt = (options.runtime?.now?.() ?? new Date()).toISOString();
  let resolution: CatalogSourceResolution;
  try {
    resolution = await resolveSourceForRefresh({
      source,
      cliVersion: options.cliVersion,
      env,
      signal: options.signal,
      providers: options.runtime?.providers,
    });
  } catch (error) {
    await recordRefreshFailure({
      sourceId: source.id,
      sourceConfigFingerprint,
      env,
      checkedAt,
      errorCode: error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationRefreshFailed',
    });
    throw error;
  }

  let prepared: Awaited<ReturnType<typeof prepareCatalogGeneration>>;
  try {
    prepared = await prepareCatalogGeneration({
      resolution,
      cliVersion: options.cliVersion,
      env,
      now: options.runtime?.now,
    });
  } catch (error) {
    await recordRefreshFailure({
      sourceId: source.id,
      sourceConfigFingerprint,
      env,
      checkedAt,
      errorCode: error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationPublishFailed',
    });
    throw error;
  }

  try {
    const transaction = await withAwHomeMutationLock({
      env,
      action: async () => {
        const currentConfig = await readCatalogSourcesConfigSnapshot(env);
        const currentConfiguredSource = currentConfig.config.sources
          .find((entry) => entry.id === source.id);
        if (!currentConfiguredSource) {
          throw new CatalogGenerationError({
            code: 'catalogGenerationSourceMissing',
            sourceId: source.id,
            message: `Catalog source "${source.id}" was removed while refresh was in progress. The prepared generation was discarded.`,
          });
        }
        if (
          calculateCatalogSourceConfigFingerprint(currentConfiguredSource)
          !== sourceConfigFingerprint
        ) {
          throw new CatalogGenerationError({
            code: 'catalogGenerationIdentityMismatch',
            sourceId: source.id,
            message: `Catalog source "${source.id}" changed while refresh was in progress. The prepared generation was discarded.`,
          });
        }
        return withCatalogGenerationStateTransaction<RefreshTransactionResult>({
          env,
          action: async (current) => {
            const previous = current.sources[source.id];
            if (
              source.type === 'git'
              && previous?.active
              && previous.logicalIdentity !== prepared.metadata.logicalIdentity
            ) {
              return {
                state: current,
                result: {
                  error: new CatalogGenerationError({
                    code: 'catalogGenerationIdentityMismatch',
                    sourceId: source.id,
                    message: `Catalog source "${source.id}" returned a different workspace identity. Active and Candidate are unchanged; update the source configuration explicitly before adopting another Catalog identity.`,
                  }),
                },
              };
            }
            const currentSource = previous?.logicalIdentity === prepared.metadata.logicalIdentity
              ? previous
              : undefined;
            const refreshPolicy = currentSource?.refreshPolicy
              ?? (source.type === 'path' ? 'manual' : 'startup');

            if (source.type === 'git') {
              const generations = await listCatalogGenerationsForIdentity({
                logicalIdentity: prepared.metadata.logicalIdentity,
                env,
              });
              const violation = generations.find((generation) =>
                generation.metadata.catalogVersion === prepared.metadata.catalogVersion
                && generation.metadata.snapshotDigest !== prepared.metadata.snapshotDigest);
              if (violation) {
                const lastCheck = checked({
                  checkedAt,
                  state: 'immutableViolation',
                  resolution,
                  errorCode: 'catalogImmutableVersionViolation',
                });
                const nextSource: CatalogSourceGenerationStateV1 = currentSource
                  ? { ...currentSource, lastCheck }
                  : {
                      logicalIdentity: prepared.metadata.logicalIdentity,
                      refreshPolicy,
                      lastCheck,
                    };
                return {
                  state: {
                    ...current,
                    sources: { ...current.sources, [source.id]: nextSource },
                  },
                  result: {
                    error: new CatalogGenerationError({
                      code: 'catalogImmutableVersionViolation',
                      sourceId: source.id,
                      message: `Catalog source "${source.id}" reused version ${prepared.metadata.catalogVersion} with different content. Active and Candidate are unchanged; publish a higher Catalog version and refresh again.`,
                    }),
                  },
                };
              }
            }

            const published = await publishPreparedCatalogGeneration(prepared);
            if (source.type === 'path' || !currentSource?.active) {
              const active = pointerFromGeneration({
                generation: published,
                resolution,
                sourceConfigFingerprint,
                activatedAt: checkedAt,
              });
              const lastCheck = checked({ checkedAt, state: 'activeReady', resolution });
              const nextSource: CatalogSourceGenerationStateV1 = {
                logicalIdentity: published.metadata.logicalIdentity,
                refreshPolicy,
                active,
                lastCheck,
              };
              return {
                state: {
                  ...current,
                  sources: { ...current.sources, [source.id]: nextSource },
                },
                result: {
                  value: {
                    catalogGenerationSchemaVersion: 1 as const,
                    sourceId: source.id,
                    sourceIdentity: resolution.sourceIdentity,
                    logicalIdentity: published.metadata.logicalIdentity,
                    outcome: 'activeReady' as const,
                    active,
                    lastCheck,
                  },
                },
              };
            }

            if (sameGeneration(currentSource.active, published, sourceConfigFingerprint)) {
              const lastCheck = checked({ checkedAt, state: 'upToDate', resolution });
              return {
                state: {
                  ...current,
                  sources: {
                    ...current.sources,
                    [source.id]: { ...currentSource, lastCheck },
                  },
                },
                result: {
                  value: {
                    catalogGenerationSchemaVersion: 1 as const,
                    sourceId: source.id,
                    sourceIdentity: resolution.sourceIdentity,
                    logicalIdentity: published.metadata.logicalIdentity,
                    outcome: 'upToDate' as const,
                    active: currentSource.active,
                    ...(currentSource.candidate ? { candidate: currentSource.candidate } : {}),
                    lastCheck,
                  },
                },
              };
            }

            const comparison = compareStrictSemVer(
              published.metadata.catalogVersion,
              currentSource.active.catalogVersion,
            );
            const explicitRefChange = source.refPolicy.type === 'explicit'
              && currentSource.active.requestedRef !== resolution.requestedRef;
            if (comparison < 0 && !explicitRefChange) {
              const lastCheck = checked({ checkedAt, state: 'channelRollback', resolution });
              return {
                state: {
                  ...current,
                  sources: {
                    ...current.sources,
                    [source.id]: { ...currentSource, lastCheck },
                  },
                },
                result: {
                  value: {
                    catalogGenerationSchemaVersion: 1 as const,
                    sourceId: source.id,
                    sourceIdentity: resolution.sourceIdentity,
                    logicalIdentity: published.metadata.logicalIdentity,
                    outcome: 'channelRollback' as const,
                    active: currentSource.active,
                    ...(currentSource.candidate ? { candidate: currentSource.candidate } : {}),
                    lastCheck,
                  },
                },
              };
            }

            const candidateKind: CatalogGenerationCandidateKind = explicitRefChange
              ? 'refChange'
              : 'upgrade';
            const candidate = sameGeneration(currentSource.candidate, published, sourceConfigFingerprint)
              ? currentSource.candidate!
              : candidateFromGeneration({
                  generation: published,
                  resolution,
                  sourceConfigFingerprint,
                  candidateKind,
                  downloadedAt: checkedAt,
                });
            const lastCheck = checked({ checkedAt, state: 'candidateReady', resolution });
            return {
              state: {
                ...current,
                sources: {
                  ...current.sources,
                  [source.id]: { ...currentSource, candidate, lastCheck },
                },
              },
              result: {
                value: {
                  catalogGenerationSchemaVersion: 1 as const,
                  sourceId: source.id,
                  sourceIdentity: resolution.sourceIdentity,
                  logicalIdentity: published.metadata.logicalIdentity,
                  outcome: 'candidateReady' as const,
                  active: currentSource.active,
                  candidate,
                  lastCheck,
                },
              },
            };
          },
        });
      },
    });
    if ('error' in transaction) throw transaction.error;
    return transaction.value;
  } finally {
    await discardPreparedCatalogGeneration(prepared);
  }
}

async function assertPointerMatchesGeneration(options: {
  logicalIdentity: string;
  pointer: CatalogGenerationPointerV1;
  sourceConfigFingerprint?: string;
  env: NodeJS.ProcessEnv;
}): Promise<PublishedCatalogGeneration> {
  if (
    options.sourceConfigFingerprint !== undefined
    && options.pointer.sourceConfigFingerprint !== options.sourceConfigFingerprint
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      message: 'Catalog generation pointer does not match the current source configuration. Refresh the configured source.',
    });
  }
  const generation = await readCatalogGeneration({
    logicalIdentity: options.logicalIdentity,
    snapshotDigest: options.pointer.snapshotDigest,
    env: options.env,
  });
  if (
    generation.metadata.catalogVersion !== options.pointer.catalogVersion
    || generation.metadata.channel !== options.pointer.channel
    || generation.metadata.manifestDigest !== options.pointer.manifestDigest
    || generation.metadata.generationKey !== options.pointer.generationKey
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      message: 'Catalog generation pointer does not match immutable generation metadata. Refresh the source after repairing catalog-generations.json.',
    });
  }
  return generation;
}

export async function activateCatalogSourceCandidate(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
  awHomeMutationToken?: AwHomeMutationToken;
  runtime?: Pick<CatalogGenerationServiceRuntime, 'now'>;
}): Promise<CatalogGenerationActivationResult> {
  const env = options.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    token: options.awHomeMutationToken,
    action: async () => {
      const config = await readCatalogSourcesConfigSnapshot(env);
      const configuredSource = config.config.sources
        .find((source) => source.id === options.sourceId);
      if (!configuredSource) {
        throw new CatalogGenerationError({
          code: 'catalogGenerationSourceMissing',
          sourceId: options.sourceId,
          message: `Catalog source "${options.sourceId}" is not configured.`,
        });
      }
      return withCatalogGenerationStateTransaction({
        env,
        action: async (current) => {
          const source = current.sources[options.sourceId];
          if (!source?.candidate) {
            throw new CatalogGenerationError({
              code: 'catalogGenerationCandidateUnavailable',
              sourceId: options.sourceId,
              message: `Catalog source "${options.sourceId}" has no Candidate generation to activate.`,
            });
          }
          await assertPointerMatchesGeneration({
            logicalIdentity: source.logicalIdentity,
            pointer: source.candidate,
            sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(configuredSource),
            env,
          });
          const active: CatalogGenerationPointerV1 = {
            sourceConfigFingerprint: source.candidate.sourceConfigFingerprint,
            catalogVersion: source.candidate.catalogVersion,
            channel: source.candidate.channel,
            requestedRef: source.candidate.requestedRef,
            resolvedCommit: source.candidate.resolvedCommit,
            manifestDigest: source.candidate.manifestDigest,
            snapshotDigest: source.candidate.snapshotDigest,
            generationKey: source.candidate.generationKey,
            activatedAt: (options.runtime?.now?.() ?? new Date()).toISOString(),
          };
          const nextSource: CatalogSourceGenerationStateV1 = {
            ...source,
            active,
          };
          delete nextSource.candidate;
          return {
            state: {
              ...current,
              sources: { ...current.sources, [options.sourceId]: nextSource },
            },
            result: {
              catalogGenerationSchemaVersion: 1 as const,
              sourceId: options.sourceId,
              logicalIdentity: source.logicalIdentity,
              outcome: 'activated' as const,
              active,
            },
          };
        },
      });
    },
  });
}

export async function removeCatalogSourceGenerationState(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return withCatalogGenerationStateTransaction({
    env: options.env,
    action: async (current) => {
      if (!current.sources[options.sourceId]) return { state: current, result: false };
      const sources = { ...current.sources };
      delete sources[options.sourceId];
      return { state: { ...current, sources }, result: true };
    },
  });
}

export async function readCatalogGenerationStatus(options: {
  sourceId?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogGenerationStatusPayload> {
  const env = options.env ?? process.env;
  const [config, state] = await Promise.all([
    readCatalogSourcesConfigSnapshot(env),
    readCatalogGenerationState(env),
  ]);
  const sources = config.config.sources
    .filter((source) => options.sourceId === undefined || source.id === options.sourceId)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (options.sourceId && sources.length === 0) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" is not configured.`,
    });
  }
  const entries: CatalogGenerationStatusEntry[] = [];
  for (const source of sources) {
    const selected = state.sources[source.id];
    const sourceConfigFingerprint = calculateCatalogSourceConfigFingerprint(source);
    if (selected?.active) await assertPointerMatchesGeneration({
      logicalIdentity: selected.logicalIdentity,
      pointer: selected.active,
      ...(selected.candidate ? {} : { sourceConfigFingerprint }),
      env,
    });
    if (selected?.candidate) await assertPointerMatchesGeneration({
      logicalIdentity: selected.logicalIdentity,
      pointer: selected.candidate,
      sourceConfigFingerprint,
      env,
    });
    entries.push({
      sourceId: source.id,
      sourceType: source.type,
      refreshPolicy: selected?.refreshPolicy ?? (source.type === 'path' ? 'manual' : 'startup'),
      ...(selected ? { logicalIdentity: selected.logicalIdentity } : {}),
      ...(selected?.active ? { active: selected.active } : {}),
      ...(selected?.candidate ? { candidate: selected.candidate } : {}),
      ...(selected?.lastCheck ? { lastCheck: selected.lastCheck } : {}),
    });
  }
  return { catalogGenerationStatusSchemaVersion: 1, sources: entries };
}
