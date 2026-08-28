import type {
  CatalogGenerationSet,
  CatalogSourceId,
  CatalogSourceResolution,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import {
  calculateCatalogGenerationSetDigest,
  resolveCatalogGenerationSet,
} from './catalog-generation-resolver.js';
import {
  refreshCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
} from './catalog-generation-service.js';
import { readCatalogGenerationState } from './catalog-generation-state.js';
import { calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  type CatalogSourcesConfigSnapshot,
} from './catalog-sources.js';
import { validateCatalogSnapshot } from './catalog-snapshot.js';
import type { MultiSourceCatalogResolution } from './multi-source-catalog.js';

export interface CatalogOperationContext {
  generationSet: CatalogGenerationSet;
  generationSetDigest: string;
  catalog: MultiSourceCatalogResolution;
}

export interface ResolveCatalogOperationContextOptions {
  cliVersion: string;
  sourceIds?: CatalogSourceId[];
  configSnapshot?: CatalogSourcesConfigSnapshot;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  bootstrapMissingActive?: boolean;
}

export function selectCatalogOperationContext(
  context: CatalogOperationContext,
  sourceIds: CatalogSourceId[],
): CatalogOperationContext {
  const requested = new Set(sourceIds);
  const available = new Set(context.generationSet.sources.map((source) => source.sourceId));
  const missing = sourceIds.find((sourceId) => !available.has(sourceId));
  if (missing) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationUnavailable',
      sourceId: missing,
      message: `Catalog source "${missing}" was unavailable when this operation context was bound. Refresh the source and reload before retrying.`,
    });
  }
  const sources = context.generationSet.sources.filter((source) => requested.has(source.sourceId));
  const generationSetDigest = calculateCatalogGenerationSetDigest(
    context.generationSet.primarySourceId,
    sources,
  );
  return {
    generationSet: {
      ...context.generationSet,
      generationSetDigest,
      sources,
    },
    generationSetDigest,
    catalog: {
      ...context.catalog,
      sources: context.catalog.sources.filter((source) => requested.has(source.sourceId)),
      compositeDigest: generationSetDigest,
    },
  };
}

function selectedSourceIds(
  snapshot: CatalogSourcesConfigSnapshot,
  sourceIds?: CatalogSourceId[],
): CatalogSourceId[] {
  if (!sourceIds) return snapshot.config.sources.map((source) => source.id);
  const configured = new Set(snapshot.config.sources.map((source) => source.id));
  const unknown = sourceIds.find((sourceId) => !configured.has(sourceId));
  if (unknown) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: unknown,
      message: `Catalog source "${unknown}" is not configured.`,
    });
  }
  return [...new Set(sourceIds)];
}

async function bootstrapMissingActiveGenerations(options: {
  cliVersion: string;
  sourceIds?: CatalogSourceId[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  const [snapshot, state] = await Promise.all([
    readCatalogSourcesConfigSnapshot(options.env),
    readCatalogGenerationState(options.env),
  ]);
  const missing = selectedSourceIds(snapshot, options.sourceIds)
    .filter((sourceId) => !state.sources[sourceId]?.active);
  if (missing.length === 0) return;
  let firstFailure: { sourceId: CatalogSourceId; cause: unknown } | undefined;
  for (const sourceId of missing) {
    try {
      await refreshCatalogSourceGeneration({
        sourceId,
        cliVersion: options.cliVersion,
        env: options.env,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
      });
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      firstFailure ??= { sourceId, cause };
    }
  }
  if (!firstFailure) return;
  throw new CatalogGenerationError({
    code: 'catalogGenerationUnavailable',
    sourceId: firstFailure.sourceId,
    message: `Catalog source "${firstFailure.sourceId}" has no Active generation and automatic bootstrap failed. Run aw catalog source refresh ${firstFailure.sourceId}, then retry.`,
    cause: firstFailure.cause,
  });
}

export async function bootstrapCatalogOperationSources(options: {
  cliVersion: string;
  sourceIds?: CatalogSourceId[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  return bootstrapMissingActiveGenerations({
    cliVersion: options.cliVersion,
    ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
    env: options.env ?? process.env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
}

async function resolveGenerationSetWithBootstrap(options: {
  cliVersion: string;
  sourceIds?: CatalogSourceId[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
  bootstrapMissingActive?: boolean;
}): Promise<CatalogGenerationSet> {
  try {
    return await resolveCatalogGenerationSet({
      ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
      env: options.env,
    });
  } catch (error) {
    if (!(error instanceof CatalogGenerationError)
      || error.code !== 'catalogGenerationUnavailable'
      || options.bootstrapMissingActive === false) throw error;
    await bootstrapMissingActiveGenerations(options);
    return resolveCatalogGenerationSet({
      ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
      env: options.env,
    });
  }
}

export async function resolveCatalogOperationContext(
  options: ResolveCatalogOperationContextOptions,
): Promise<CatalogOperationContext> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const generationSet = await resolveGenerationSetWithBootstrap({
    cliVersion: options.cliVersion,
    ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
    env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.bootstrapMissingActive === false ? { bootstrapMissingActive: false } : {}),
  });
  options.signal?.throwIfAborted();
  const [configSnapshot, state] = await Promise.all([
    options.configSnapshot
      ? Promise.resolve(options.configSnapshot)
      : readCatalogSourcesConfigSnapshot(env),
    readCatalogGenerationState(env),
  ]);
  const configured = new Map(configSnapshot.config.sources.map((source) => [source.id, source]));
  const sources = await Promise.all(generationSet.sources.map(async (generation) => {
    options.signal?.throwIfAborted();
    const source = configured.get(generation.sourceId);
    const active = state.sources[generation.sourceId]?.active;
    if (!source || !active
      || active.generationKey !== generation.generationKey
      || active.sourceConfigFingerprint !== generation.sourceConfigFingerprint) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: generation.sourceId,
        message: `Active Catalog generation for source "${generation.sourceId}" changed while the operation context was being resolved. Retry the operation.`,
      });
    }
    const validation = await validateCatalogSnapshot(generation.snapshotPath);
    if (validation.manifestDigest !== generation.manifestDigest
      || validation.snapshotDigest !== generation.snapshotDigest) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: generation.sourceId,
        message: `Active Catalog generation for source "${generation.sourceId}" is damaged. Run aw catalog source refresh ${generation.sourceId}, then retry.`,
      });
    }
    const resolution: CatalogSourceResolution = {
      sourceId: generation.sourceId,
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      requestedRef: active.requestedRef,
      resolvedCommit: generation.resolvedCommit,
      rootDir: generation.snapshotPath,
      manifest: validation.manifest,
      manifestDigest: generation.manifestDigest,
      snapshotDigest: generation.snapshotDigest,
      cacheEntryKey: generation.generationKey,
      source: source.type === 'path' ? 'path' : 'cache',
      cacheFallback: false,
    };
    return { sourceId: generation.sourceId, resolution };
  }));
  options.signal?.throwIfAborted();
  return {
    generationSet,
    generationSetDigest: generationSet.generationSetDigest,
    catalog: {
      sources,
      primarySourceId: generationSet.primarySourceId,
      configDigest: configSnapshot.digest,
      compositeDigest: generationSet.generationSetDigest,
    },
  };
}

export async function resolvePartialCatalogOperationContext(
  options: ResolveCatalogOperationContextOptions,
): Promise<CatalogOperationContext> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const configSnapshot = options.configSnapshot ?? await readCatalogSourcesConfigSnapshot(env);
  const sourceIds = selectedSourceIds(configSnapshot, options.sourceIds);
  let bootstrapFailure: unknown;
  if (options.bootstrapMissingActive !== false) {
    try {
      await bootstrapMissingActiveGenerations({
        cliVersion: options.cliVersion,
        sourceIds,
        env,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      bootstrapFailure = error;
    }
  }
  const resolved = await Promise.all(sourceIds.map(async (sourceId) => {
    try {
      const context = await resolveCatalogOperationContext({
        ...options,
        sourceIds: [sourceId],
        configSnapshot,
        env,
        bootstrapMissingActive: false,
      });
      return { sourceId, context };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = bootstrapFailure instanceof Error
        && (bootstrapFailure as Error & { sourceId?: string }).sourceId === sourceId
        ? bootstrapFailure
        : error as Error;
      return { sourceId, error: failure };
    }
  }));
  options.signal?.throwIfAborted();
  const contexts = resolved.flatMap((entry) => entry.context ? [entry.context] : []);
  const sources = contexts.flatMap((context) => context.generationSet.sources)
    .sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0);
  const primarySourceId = configSnapshot.config.sources.find((source) => source.primary)!.id;
  const generationSetDigest = calculateCatalogGenerationSetDigest(primarySourceId, sources);
  return {
    generationSet: { generationSetDigest, primarySourceId, sources },
    generationSetDigest,
    catalog: {
      sources: resolved.map((entry) => entry.context
        ? entry.context.catalog.sources[0]!
        : { sourceId: entry.sourceId, error: entry.error as Error }),
      primarySourceId,
      configDigest: configSnapshot.digest,
      compositeDigest: generationSetDigest,
    },
  };
}
