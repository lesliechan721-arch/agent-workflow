import type {
  CatalogGenerationActiveV1,
  CatalogGenerationLastSyncV1,
  CatalogGenerationSyncEvidence,
  CatalogGenerationSyncResult,
  CatalogSource,
  CatalogSourceResolution,
} from '../types.js';
import { CatalogGenerationError, catalogGenerationErrorCode } from './catalog-generation-error.js';
import { readCatalogGenerationControlSnapshot } from './catalog-generation-control-snapshot.js';
import {
  publishCatalogStoreEntry,
  readCatalogSnapshotLogicalIdentity,
  readCatalogStoreEntry,
  type CatalogStoreEntry,
} from './catalog-generation-store.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from './catalog-generation-state.js';
export { removeCatalogSourceGenerationState } from './catalog-generation-state.js';
import {
  calculateCatalogSourceConfigFingerprint,
  calculateCatalogSourceIdentity,
} from './catalog-source-identity.js';
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

function now(runtime?: CatalogGenerationServiceRuntime): string {
  return (runtime?.now?.() ?? new Date()).toISOString();
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

function evidence(
  resolution: CatalogSourceResolution,
  logicalIdentity: string,
): CatalogGenerationSyncEvidence {
  return {
    sourceIdentity: resolution.sourceIdentity,
    logicalIdentity,
    catalogVersion: resolution.manifest.catalogVersion,
    channel: resolution.manifest.channel,
    requestedRef: resolution.requestedRef,
    resolvedCommit: resolution.resolvedCommit,
    manifestDigest: resolution.manifestDigest,
    snapshotDigest: resolution.snapshotDigest,
  };
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
  fingerprint: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const current = await readCatalogSourcesConfigSnapshot(options.env);
  const source = current.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing',
    sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" was removed during sync.`,
  });
  if (calculateCatalogSourceConfigFingerprint(source) !== options.fingerprint) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" changed during sync. Run sync again.`,
    });
  }
}

async function recordFailure(options: {
  sourceId: string;
  fingerprint: string;
  mode: 'check' | 'sync';
  errorCode: string;
  env: NodeJS.ProcessEnv;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  try {
    await assertCurrentSource(options);
    const lastSync: CatalogGenerationLastSyncV1 = {
      syncedAt: now(options.runtime),
      mode: options.mode,
      state: 'failed',
      errorCode: options.errorCode,
    };
    await withCatalogGenerationStateTransaction({
      env: options.env,
      beforeReplace: () => assertCurrentSource(options),
      action: async (current) => ({
        state: {
          schemaVersion: 1,
          sources: {
            ...current.sources,
            [options.sourceId]: {
              ...current.sources[options.sourceId],
              lastSync,
            },
          },
        },
        result: undefined,
      }),
    });
  } catch {
    // A concurrent source update or removal must not be undone by failure diagnostics.
  }
}

function warnCleanupFailure(sourceId: string): void {
  try {
    process.emitWarning(
      `Catalog provider staging cleanup failed for source "${sourceId}".`,
      { code: 'AW_CATALOG_PROVIDER_CLEANUP_FAILED' },
    );
  } catch {
    // Cleanup diagnostics cannot replace the sync result.
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
  const env = options.env ?? process.env;
  const mode = options.check ? 'check' : 'sync';
  const control = await readCatalogGenerationControlSnapshot({ env });
  const source = control.configSnapshot.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing',
    sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" is not configured.`,
  });
  const fingerprint = calculateCatalogSourceConfigFingerprint(source);
  let resolution: CatalogSourceResolution | undefined;
  try {
    resolution = await resolveProvider({
      source,
      cliVersion: options.cliVersion,
      env,
      signal: options.signal,
      runtime: options.runtime,
    });
    const expectedIdentity = await calculateCatalogSourceIdentity(source);
    if (resolution.sourceId !== source.id || resolution.sourceIdentity !== expectedIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: source.id,
        message: `Catalog provider returned mismatched identity for source "${source.id}".`,
      });
    }
    const logicalIdentity = await readCatalogSnapshotLogicalIdentity(resolution.rootDir);
    const syncEvidence = evidence(resolution, logicalIdentity);
    if (options.check) {
      await assertCurrentSource({ sourceId: source.id, fingerprint, env });
      const lastSync: CatalogGenerationLastSyncV1 = {
        syncedAt: now(options.runtime),
        mode,
        state: 'succeeded',
        resolvedCommit: resolution.resolvedCommit,
      };
      await withCatalogGenerationStateTransaction({
        env,
        beforeReplace: () => assertCurrentSource({ sourceId: source.id, fingerprint, env }),
        action: async (current) => ({
          state: {
            schemaVersion: 1,
            sources: {
              ...current.sources,
              [source.id]: { ...current.sources[source.id], lastSync },
            },
          },
          result: undefined,
        }),
      });
      return {
        catalogGenerationSchemaVersion: 1,
        sourceId: source.id,
        mode,
        outcome: 'checked',
        activeChanged: false,
        resolution: syncEvidence,
        ...(control.generationState.sources[source.id]?.active
          ? { active: control.generationState.sources[source.id]!.active }
          : {}),
        lastSync,
      };
    }

    const store = await publishCatalogStoreEntry({ resolution, env, signal: options.signal });
    const activeInput = {
      sourceConfigFingerprint: fingerprint,
      sourceIdentity: resolution.sourceIdentity,
      requestedRef: resolution.requestedRef,
      resolvedCommit: resolution.resolvedCommit,
      logicalIdentity: store.metadata.logicalIdentity,
      manifestDigest: store.metadata.manifestDigest,
      snapshotDigest: store.metadata.snapshotDigest,
    };
    await assertCurrentSource({ sourceId: source.id, fingerprint, env });
    const syncedAt = now(options.runtime);
    return await withCatalogGenerationStateTransaction({
      env,
      beforeReplace: () => assertCurrentSource({ sourceId: source.id, fingerprint, env }),
      action: async (current) => {
        const previous = current.sources[source.id]?.active;
        const unchanged = sameActive(previous, activeInput);
        const active: CatalogGenerationActiveV1 = unchanged
          ? previous
          : { ...activeInput, activatedAt: syncedAt };
        const lastSync: CatalogGenerationLastSyncV1 = {
          syncedAt,
          mode,
          state: 'succeeded',
          resolvedCommit: resolution!.resolvedCommit,
        };
        return {
          state: {
            schemaVersion: 1,
            sources: { ...current.sources, [source.id]: { active, lastSync } },
          },
          result: {
            catalogGenerationSchemaVersion: 1 as const,
            sourceId: source.id,
            mode,
            outcome: unchanged ? 'unchanged' as const : 'activated' as const,
            activeChanged: !unchanged,
            resolution: syncEvidence,
            active,
            lastSync,
          },
        };
      },
    });
  } catch (error) {
    const code = error instanceof CatalogGenerationError
      ? error.code
      : 'catalogGenerationRefreshFailed';
    await recordFailure({
      sourceId: source.id,
      fingerprint,
      mode,
      errorCode: code,
      env,
      runtime: options.runtime,
    });
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationRefreshFailed',
      sourceId: source.id,
      message: `Cannot sync Catalog source "${source.id}". The previous Active snapshot is unchanged.`,
      cause: error,
    });
  } finally {
    if (resolution) await resolution.cleanup().catch(() => warnCleanupFailure(source.id));
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
    code: 'catalogGenerationSourceMissing',
    sourceId: options.sourceId,
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
      sourceId: source.id,
      configuredSourceIdentity,
      activeReady: false,
      configMatchesActive: false,
      lastSync: sourceState?.lastSync,
    };
    try {
      const entry = await readCatalogStoreEntry({
        logicalIdentity: active.logicalIdentity,
        snapshotDigest: active.snapshotDigest,
        env,
      });
      if (entry.metadata.manifestDigest !== active.manifestDigest) {
        throw new CatalogGenerationError({
          code: 'catalogGenerationIdentityMismatch',
          message: 'Active does not match store metadata.',
        });
      }
      return {
        sourceId: source.id,
        configuredSourceIdentity,
        active,
        activeReady: configMatchesActive,
        configMatchesActive,
        catalogVersion: entry.metadata.catalogVersion,
        channel: entry.metadata.channel,
        storeKey: `${encodeURIComponent(active.logicalIdentity)}/${active.snapshotDigest.slice('sha256:'.length)}`,
        lastSync: sourceState?.lastSync,
      };
    } catch (error) {
      return {
        sourceId: source.id,
        configuredSourceIdentity,
        active,
        activeReady: false,
        configMatchesActive,
        lastSync: sourceState?.lastSync,
        errorCode: catalogGenerationErrorCode(error),
      };
    }
  }));
  return { catalogGenerationStatusSchemaVersion: 1, sources };
}
