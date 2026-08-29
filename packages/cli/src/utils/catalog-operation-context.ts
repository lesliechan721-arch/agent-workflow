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
  readCatalogGenerationControlSnapshot,
  type CatalogGenerationControlSnapshot,
} from './catalog-generation-control-snapshot.js';
import {
  refreshCatalogSourceGeneration,
  type CatalogGenerationServiceRuntime,
} from './catalog-generation-service.js';
import type { CatalogSourcesConfigSnapshot } from './catalog-sources.js';
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
    context.generationSet.configDigest,
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
  const requested = new Set(sourceIds);
  return snapshot.config.sources
    .filter((source) => requested.has(source.id))
    .map((source) => source.id);
}

async function bootstrapMissingActiveGenerations(options: {
  cliVersion: string;
  sourceIds?: CatalogSourceId[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runtime?: CatalogGenerationServiceRuntime;
}): Promise<void> {
  const controlSnapshot = await readCatalogGenerationControlSnapshot({ env: options.env });
  const missing = selectedSourceIds(controlSnapshot.configSnapshot, options.sourceIds)
    .filter((sourceId) => !controlSnapshot.generationState.sources[sourceId]?.active);
  if (missing.length === 0) return;
  const failures: Array<{ sourceId: CatalogSourceId; cause: unknown } | undefined>
    = new Array(missing.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < missing.length) {
      const index = nextIndex;
      nextIndex += 1;
      const sourceId = missing[index]!;
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
        failures[index] = { sourceId, cause };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(2, missing.length) },
    () => worker(),
  ));
  const firstFailure = failures.find((failure) => failure !== undefined);
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
  configSnapshot?: CatalogSourcesConfigSnapshot;
}): Promise<{
  generationSet: CatalogGenerationSet;
  controlSnapshot: CatalogGenerationControlSnapshot;
}> {
  let controlSnapshot = await readCatalogGenerationControlSnapshot({
    env: options.env,
    ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
  });
  try {
    const generationSet = await resolveCatalogGenerationSet({
      ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
      env: options.env,
      controlSnapshot,
    });
    return { generationSet, controlSnapshot };
  } catch (error) {
    if (!(error instanceof CatalogGenerationError)
      || error.code !== 'catalogGenerationUnavailable'
      || options.bootstrapMissingActive === false) throw error;
    await bootstrapMissingActiveGenerations(options);
    controlSnapshot = await readCatalogGenerationControlSnapshot({
      env: options.env,
      ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
    });
    const generationSet = await resolveCatalogGenerationSet({
      ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
      env: options.env,
      controlSnapshot,
    });
    return { generationSet, controlSnapshot };
  }
}

async function createCatalogOperationContext(options: {
  generationSet: CatalogGenerationSet;
  controlSnapshot: CatalogGenerationControlSnapshot;
  signal?: AbortSignal;
}): Promise<CatalogOperationContext> {
  const configured = new Map(options.controlSnapshot.configSnapshot.config.sources
    .map((source) => [source.id, source]));
  const sources = options.generationSet.sources.map((generation) => {
    options.signal?.throwIfAborted();
    const source = configured.get(generation.sourceId);
    const active = options.controlSnapshot.generationState.sources[generation.sourceId]?.active;
    if (!source || !active
      || active.generationKey !== generation.generationKey
      || active.sourceIdentity !== generation.sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: generation.sourceId,
        message: `Active Catalog generation for source "${generation.sourceId}" changed while the operation context was being resolved. Retry the operation.`,
      });
    }
    const resolution: CatalogSourceResolution = {
      sourceId: generation.sourceId,
      sourceIdentity: generation.sourceIdentity,
      requestedRef: active.requestedRef,
      resolvedCommit: generation.resolvedCommit,
      rootDir: generation.snapshotPath,
      manifest: generation.manifest,
      manifestDigest: generation.manifestDigest,
      snapshotDigest: generation.snapshotDigest,
      cacheEntryKey: generation.generationKey,
      source: source.type === 'path' ? 'path' : 'cache',
      cacheFallback: false,
    };
    return { sourceId: generation.sourceId, resolution };
  });
  options.signal?.throwIfAborted();
  return {
    generationSet: options.generationSet,
    generationSetDigest: options.generationSet.generationSetDigest,
    catalog: {
      sources,
      primarySourceId: options.generationSet.primarySourceId,
      configDigest: options.generationSet.configDigest,
      compositeDigest: options.generationSet.generationSetDigest,
    },
  };
}

export async function resolveCatalogOperationContext(
  options: ResolveCatalogOperationContextOptions,
): Promise<CatalogOperationContext> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const resolved = await resolveGenerationSetWithBootstrap({
    cliVersion: options.cliVersion,
    ...(options.sourceIds ? { sourceIds: options.sourceIds } : {}),
    env,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.bootstrapMissingActive === false ? { bootstrapMissingActive: false } : {}),
    ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
  });
  options.signal?.throwIfAborted();
  return createCatalogOperationContext({
    ...resolved,
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function resolvePartialCatalogOperationContext(
  options: ResolveCatalogOperationContextOptions,
): Promise<CatalogOperationContext> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  let controlSnapshot = await readCatalogGenerationControlSnapshot({
    env,
    ...(options.configSnapshot ? { configSnapshot: options.configSnapshot } : {}),
  });
  const configSnapshot = controlSnapshot.configSnapshot;
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
    controlSnapshot = await readCatalogGenerationControlSnapshot({
      env,
      configSnapshot,
    });
  }
  const resolved = await Promise.all(sourceIds.map(async (sourceId) => {
    try {
      const generationSet = await resolveCatalogGenerationSet({
        sourceIds: [sourceId],
        env,
        controlSnapshot,
      });
      const context = await createCatalogOperationContext({
        generationSet,
        controlSnapshot,
        ...(options.signal ? { signal: options.signal } : {}),
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
  const generationSetDigest = calculateCatalogGenerationSetDigest(
    configSnapshot.digest,
    primarySourceId,
    sources,
  );
  return {
    generationSet: {
      generationSetDigest,
      configDigest: configSnapshot.digest,
      primarySourceId,
      sources,
    },
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
