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
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './aw-home-mutation-lock.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from './catalog-generation-state.js';
import {
  discardPreparedCatalogGeneration,
  prepareCatalogGeneration,
  publishPreparedCatalogGeneration,
  readCatalogGeneration,
  type PublishedCatalogGeneration,
} from './catalog-generation-store.js';
import { assertCatalogPublishedVersion } from './catalog-generation-published-version.js';
import {
  calculateCatalogSourceConfigFingerprint,
  calculateCatalogSourceIdentity,
} from './catalog-source-identity.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';
import { catalogGitProviderInternal } from './git-catalog-provider.js';
import { checkAwCapabilitySupport, compareStrictSemVer } from './manifest.js';
import type { CatalogSourceProviderSet } from './multi-source-catalog.js';
import { catalogPathProviderInternal } from './path-catalog-provider.js';

export interface CatalogGenerationServiceRuntime {
  providers?: CatalogSourceProviderSet;
  now?: () => Date;
  onProgress?: (event: {
    sourceId: string;
    state: 'checking' | 'validating';
  }) => void | Promise<void>;
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
    sourceIdentity: options.resolution.sourceIdentity,
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
  sourceIdentity: string;
  env: NodeJS.ProcessEnv;
  checkedAt: string;
  errorCode: string;
  awHomeMutationToken?: AwHomeMutationToken;
}): Promise<void> {
  await withAwHomeMutationLock({
    env: options.env,
    token: options.awHomeMutationToken,
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
          const source = retainMatchingCandidate(
            current.sources[options.sourceId],
            options.sourceConfigFingerprint,
            options.sourceIdentity,
          );
          const refreshPolicy = source?.refreshPolicy
            ?? (configured.type === 'path' ? 'manual' : 'startup');
          return {
            state: {
              ...current,
              sources: {
                ...current.sources,
                [options.sourceId]: {
                  ...source,
                  refreshPolicy,
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

function retainMatchingCandidate(
  source: CatalogSourceGenerationStateV1 | undefined,
  sourceConfigFingerprint: string,
  sourceIdentity: string,
): CatalogSourceGenerationStateV1 | undefined {
  if (!source?.candidate
    || (source.candidate.sourceConfigFingerprint === sourceConfigFingerprint
      && source.candidate.sourceIdentity === sourceIdentity)) return source;
  const next = { ...source };
  delete next.candidate;
  return next;
}

function sameGeneration(
  pointer: CatalogGenerationPointerV1 | undefined,
  generation: PublishedCatalogGeneration,
  sourceConfigFingerprint: string,
  sourceIdentity: string,
): boolean {
  return pointer?.sourceConfigFingerprint === sourceConfigFingerprint
    && pointer.sourceIdentity === sourceIdentity
    && pointer.catalogVersion === generation.metadata.catalogVersion
    && pointer.snapshotDigest === generation.metadata.snapshotDigest;
}

export async function refreshCatalogSourceGeneration(options: {
  sourceId: string;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  awHomeMutationToken?: AwHomeMutationToken;
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
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const checkedAt = (options.runtime?.now?.() ?? new Date()).toISOString();
  let resolution: CatalogSourceResolution;
  try {
    await options.runtime?.onProgress?.({ sourceId: source.id, state: 'checking' });
    options.signal?.throwIfAborted();
    resolution = await resolveSourceForRefresh({
      source,
      cliVersion: options.cliVersion,
      env,
      signal: options.signal,
      providers: options.runtime?.providers,
    });
    if (resolution.sourceIdentity !== sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: source.id,
        message: `Catalog source "${source.id}" returned evidence for a different source identity. The previous Active generation is unchanged.`,
      });
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    await recordRefreshFailure({
      sourceId: source.id,
      sourceConfigFingerprint,
      sourceIdentity,
      env,
      checkedAt,
      errorCode: error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationRefreshFailed',
      ...(options.awHomeMutationToken
        ? { awHomeMutationToken: options.awHomeMutationToken }
        : {}),
    });
    throw error;
  }

  let prepared: Awaited<ReturnType<typeof prepareCatalogGeneration>>;
  try {
    await options.runtime?.onProgress?.({ sourceId: source.id, state: 'validating' });
    options.signal?.throwIfAborted();
    prepared = await prepareCatalogGeneration({
      resolution,
      cliVersion: options.cliVersion,
      env,
      now: options.runtime?.now,
      signal: options.signal,
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    await recordRefreshFailure({
      sourceId: source.id,
      sourceConfigFingerprint,
      sourceIdentity,
      env,
      checkedAt,
      errorCode: error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationPublishFailed',
      ...(options.awHomeMutationToken
        ? { awHomeMutationToken: options.awHomeMutationToken }
        : {}),
    });
    throw error;
  }

  try {
    options.signal?.throwIfAborted();
    const transaction = await withAwHomeMutationLock({
      env,
      signal: options.signal,
      token: options.awHomeMutationToken,
      action: async () => {
        options.signal?.throwIfAborted();
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
          beforeReplace: () => options.signal?.throwIfAborted(),
          action: async (current) => {
            options.signal?.throwIfAborted();
            const storedPrevious = current.sources[source.id];
            const previous = retainMatchingCandidate(
              storedPrevious,
              sourceConfigFingerprint,
              sourceIdentity,
            );
            const currentWithMatchingCandidate = previous === storedPrevious
              ? current
              : {
                  ...current,
                  sources: { ...current.sources, [source.id]: previous! },
                };
            const previousPointer = previous?.active ?? previous?.candidate;
            const previousMatchesSourceIdentity = !previousPointer
              || previousPointer.sourceIdentity === sourceIdentity;
            if (
              source.type === 'git'
              && previous?.active
              && previousMatchesSourceIdentity
              && previous.logicalIdentity !== prepared.metadata.logicalIdentity
            ) {
              return {
                state: currentWithMatchingCandidate,
                result: {
                  error: new CatalogGenerationError({
                    code: 'catalogGenerationIdentityMismatch',
                    sourceId: source.id,
                    message: `Catalog source "${source.id}" returned a different workspace identity. Active and Candidate are unchanged; update the source configuration explicitly before adopting another Catalog identity.`,
                  }),
                },
              };
            }
            const currentSource = previousMatchesSourceIdentity
              && previous?.logicalIdentity === prepared.metadata.logicalIdentity
              ? previous
              : undefined;
            const refreshPolicy = previous?.refreshPolicy
              ?? (source.type === 'path' ? 'manual' : 'startup');

            if (source.type === 'git') {
              try {
                await assertCatalogPublishedVersion({
                  logicalIdentity: prepared.metadata.logicalIdentity,
                  catalogVersion: prepared.metadata.catalogVersion,
                  snapshotDigest: prepared.metadata.snapshotDigest,
                  firstObservedAt: checkedAt,
                  sourceId: source.id,
                  env,
                });
              } catch (error) {
                if (!(error instanceof CatalogGenerationError)
                  || error.code !== 'catalogImmutableVersionViolation') throw error;
                const lastCheck = checked({
                  checkedAt,
                  state: 'immutableViolation',
                  resolution,
                  errorCode: 'catalogImmutableVersionViolation',
                });
                const nextSource: CatalogSourceGenerationStateV1 = currentSource
                  ? { ...currentSource, lastCheck }
                  : {
                      refreshPolicy,
                      lastCheck,
                    };
                return {
                  state: {
                    ...current,
                    sources: { ...current.sources, [source.id]: nextSource },
                  },
                  result: {
                    error,
                  },
                };
              }
            }

            options.signal?.throwIfAborted();
            const published = await publishPreparedCatalogGeneration(prepared);
            options.signal?.throwIfAborted();
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
                    activeChanged: true,
                    activeGenerationKey: active.generationKey,
                    active,
                    lastCheck,
                  },
                },
              };
            }

            const explicitRefChange = source.refPolicy.type === 'explicit'
              && currentSource.active.requestedRef !== resolution.requestedRef;
            const baseline = [currentSource.active, currentSource.candidate]
              .filter((pointer): pointer is CatalogGenerationPointerV1 => pointer !== undefined
                && pointer.sourceConfigFingerprint === sourceConfigFingerprint
                && pointer.sourceIdentity === sourceIdentity)
              .reduce<CatalogGenerationPointerV1 | undefined>((highest, pointer) =>
                !highest || compareStrictSemVer(pointer.catalogVersion, highest.catalogVersion) > 0
                  ? pointer
                  : highest, undefined);
            if (!explicitRefChange && baseline
              && compareStrictSemVer(published.metadata.catalogVersion, baseline.catalogVersion) < 0) {
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
                    activeChanged: false,
                    activeGenerationKey: currentSource.active.generationKey,
                    active: currentSource.active,
                    ...(currentSource.candidate ? { candidate: currentSource.candidate } : {}),
                    lastCheck,
                  },
                },
              };
            }

            if (sameGeneration(
              currentSource.active,
              published,
              sourceConfigFingerprint,
              sourceIdentity,
            )) {
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
                    activeChanged: false,
                    activeGenerationKey: currentSource.active.generationKey,
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
            const candidate = sameGeneration(
              currentSource.candidate,
              published,
              sourceConfigFingerprint,
              sourceIdentity,
            )
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
                  activeChanged: false,
                  activeGenerationKey: currentSource.active.generationKey,
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
  sourceIdentity?: string;
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
  if (options.sourceIdentity !== undefined
    && options.pointer.sourceIdentity !== options.sourceIdentity) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      message: 'Catalog generation pointer does not match the current source identity. Refresh the configured source.',
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
  expectedCandidateGenerationKey?: string;
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
          if (options.expectedCandidateGenerationKey
            && source.candidate.generationKey !== options.expectedCandidateGenerationKey) {
            throw new CatalogGenerationError({
              code: 'catalogGenerationCandidateChanged',
              sourceId: options.sourceId,
              message: `Catalog source "${options.sourceId}" Candidate changed after Review. Review the new Candidate before activation.`,
            });
          }
          const candidateGeneration = await assertPointerMatchesGeneration({
            logicalIdentity: source.logicalIdentity!,
            pointer: source.candidate,
            sourceConfigFingerprint: calculateCatalogSourceConfigFingerprint(configuredSource),
            sourceIdentity: await calculateCatalogSourceIdentity(configuredSource),
            env,
          });
          const requiredCapabilities = candidateGeneration.metadata.requiredAwCapabilities;
          const support = checkAwCapabilitySupport(
            requiredCapabilities,
            IMPLEMENTED_AW_CAPABILITIES,
          );
          if (!support.supported) {
            throw new CatalogProviderCompatibilityError({
              sourceId: options.sourceId,
              requiredCapabilities,
              missingCapabilities: support.missing,
              availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
            });
          }
          const active: CatalogGenerationPointerV1 = {
            sourceConfigFingerprint: source.candidate.sourceConfigFingerprint,
            sourceIdentity: source.candidate.sourceIdentity,
            catalogVersion: source.candidate.catalogVersion,
            channel: source.candidate.channel,
            requestedRef: source.candidate.requestedRef,
            resolvedCommit: source.candidate.resolvedCommit,
            manifestDigest: source.candidate.manifestDigest,
            snapshotDigest: source.candidate.snapshotDigest,
            generationKey: source.candidate.generationKey,
            activatedAt: (options.runtime?.now?.() ?? new Date()).toISOString(),
          };
          const lastCheck: CatalogGenerationLastCheckV1 = {
            checkedAt: active.activatedAt!,
            state: 'activeReady',
            remoteCommit: active.resolvedCommit,
          };
          const nextSource: CatalogSourceGenerationStateV1 = {
            ...source,
            active,
            lastCheck,
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
              logicalIdentity: source.logicalIdentity!,
              outcome: 'activated' as const,
              active,
            },
          };
        },
      });
    },
  });
}

export async function setCatalogSourceRefreshPolicy(options: {
  sourceId: string;
  refreshPolicy: 'startup' | 'manual';
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogGenerationStatusEntry> {
  const env = options.env ?? process.env;
  return withAwHomeMutationLock({
    env,
    action: async () => {
      const config = await readCatalogSourcesConfigSnapshot(env);
      const configuredSource = config.config.sources.find((source) => source.id === options.sourceId);
      if (!configuredSource) {
        throw new CatalogGenerationError({
          code: 'catalogGenerationSourceMissing',
          sourceId: options.sourceId,
          message: `Catalog source "${options.sourceId}" is not configured.`,
        });
      }
      if (configuredSource.type === 'path' && options.refreshPolicy !== 'manual') {
        throw new CatalogGenerationError({
          code: 'catalogGenerationRefreshPolicyInvalid',
          sourceId: options.sourceId,
          message: `Path Catalog source "${options.sourceId}" only supports manual refresh.`,
        });
      }
      await withCatalogGenerationStateTransaction({
        env,
        action: async (current) => {
          const source = current.sources[options.sourceId];
          return {
            state: {
              ...current,
              sources: {
                ...current.sources,
                [options.sourceId]: {
                  ...source,
                  refreshPolicy: options.refreshPolicy,
                },
              },
            },
            result: undefined,
          };
        },
      });
      return (await readCatalogGenerationStatus({ sourceId: options.sourceId, env })).sources[0]!;
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
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    if (selected?.active) await assertPointerMatchesGeneration({
      logicalIdentity: selected.logicalIdentity!,
      pointer: selected.active,
      sourceIdentity,
      env,
    });
    if (selected?.candidate) await assertPointerMatchesGeneration({
      logicalIdentity: selected.logicalIdentity!,
      pointer: selected.candidate,
      sourceConfigFingerprint,
      sourceIdentity,
      env,
    });
    entries.push({
      sourceId: source.id,
      sourceType: source.type,
      refreshPolicy: selected?.refreshPolicy ?? (source.type === 'path' ? 'manual' : 'startup'),
      ...(selected?.logicalIdentity ? { logicalIdentity: selected.logicalIdentity } : {}),
      ...(selected?.active ? { active: selected.active } : {}),
      ...(selected?.candidate ? { candidate: selected.candidate } : {}),
      ...(selected?.lastCheck ? { lastCheck: selected.lastCheck } : {}),
    });
  }
  return { catalogGenerationStatusSchemaVersion: 1, sources: entries };
}
