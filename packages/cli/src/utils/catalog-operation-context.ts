import type {
  CatalogGenerationSet,
  CatalogSourceId,
  CatalogSourceResolution,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import {
  calculateCatalogGenerationSetDigest,
  createCatalogPreparationStoreKey,
  resolveActiveCatalogGeneration,
  resolveCatalogGenerationSet,
} from './catalog-generation-resolver.js';
import {
  readCatalogGenerationControlSnapshot,
  type CatalogGenerationControlSnapshot,
} from './catalog-generation-control-snapshot.js';
import type { CatalogStoreEntry } from './catalog-generation-store.js';
import { validateCatalogSnapshotComplete, validateCatalogSnapshotPluginEntriesComplete } from './catalog-snapshot.js';
import type { CatalogSourcesConfigSnapshot } from './catalog-sources.js';
import type { MultiSourceCatalogResolution } from './multi-source-catalog.js';

export interface CatalogOperationContext {
  generationSet: CatalogGenerationSet;
  generationSetDigest: string;
  catalog: MultiSourceCatalogResolution;
}

export interface ResolveCatalogOperationContextOptions {
  sourceIds?: CatalogSourceId[];
  configSnapshot?: CatalogSourcesConfigSnapshot;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
  reuseTransport?: boolean;
}

type PreparationCatalogOptions = Pick<ResolveCatalogOperationContextOptions, 'sourceIds' | 'configSnapshot'>;

/** Bound Active evidence may be used by consumers of a single read-only preparation. */
export class CatalogPreparationReadScope {
  readonly #options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal };
  readonly #validatedStoreEntries = new Map<string, CatalogStoreEntry>();
  readonly #validatingStoreEntries = new Map<string, Promise<CatalogStoreEntry>>();
  readonly #bindings = new WeakMap<CatalogSourceResolution,
    Pick<CatalogSourceResolution, 'sourceId' | 'sourceIdentity' | 'requestedRef' | 'resolvedCommit'> & { key: string; entry: CatalogStoreEntry }>();

  constructor(options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal }) {
    this.#options = { env: options.env, signal: options.signal };
  }

  async resolve(input: PreparationCatalogOptions, requireAll = false): Promise<CatalogOperationContext> {
    this.#options.signal?.throwIfAborted();
    const resolve = requireAll ? resolveCatalogOperationContext : resolvePartialCatalogOperationContext;
    const context = await resolve({
      ...input, ...this.#options,
      validatedStoreEntries: this.#validatedStoreEntries,
      validatingStoreEntries: this.#validatingStoreEntries,
      reuseTransport: true,
    });
    for (const generation of context.generationSet.sources) {
      const resolution = context.catalog.sources.find((source) => source.sourceId === generation.sourceId)?.resolution;
      if (!resolution) continue;
      const { sourceId, sourceIdentity, requestedRef, resolvedCommit } = resolution;
      const key = createCatalogPreparationStoreKey({ ...generation, requestedRef });
      const entry = this.#validatedStoreEntries.get(key);
      if (entry) this.#bindings.set(resolution, { sourceId, sourceIdentity, requestedRef, resolvedCommit, key, entry });
    }
    return context;
  }

  async resolveActiveGeneration(sourceId: string, previousResolution?: CatalogSourceResolution) {
    this.#options.signal?.throwIfAborted();
    const previous = previousResolution && this.#bindings.get(previousResolution);
    const entries = new Map<string, CatalogStoreEntry>(previous && [[previous.key, previous.entry]]);
    const active = await resolveActiveCatalogGeneration({
      sourceId, env: this.#options.env, validatedStoreEntries: entries, reuseTransport: true,
    });
    this.#options.signal?.throwIfAborted();
    const key = createCatalogPreparationStoreKey({ ...active, requestedRef: active.active.requestedRef });
    const entry = entries.get(key)!;
    // The session's physical Store cache must not retain this attempt's transport validator.
    const { validateEntries: _validateEntries, ...sessionEntry } = entry;
    return { active, sessionEntry, reused: entry === previous?.entry };
  }

  static async validateEntries(readScope: CatalogPreparationReadScope | undefined, source: CatalogSourceResolution,
    pluginNames?: readonly string[]): Promise<void> {
    const signal = readScope ? readScope.#options.signal : undefined;
    signal?.throwIfAborted();
    const binding = readScope ? readScope.#bindings.get(source) : undefined;
    if (binding?.entry.validateEntries && binding.sourceId === source.sourceId
      && binding.sourceIdentity === source.sourceIdentity && binding.requestedRef === source.requestedRef
      && binding.resolvedCommit === source.resolvedCommit && binding.entry.snapshotRoot === source.rootDir
      && binding.entry.metadata.logicalIdentity === source.logicalIdentity
      && binding.entry.metadata.snapshotDigest === source.snapshotDigest
      && binding.entry.metadata.manifestDigest === source.manifestDigest) {
      await binding.entry.validateEntries(pluginNames);
    } else if (pluginNames) await validateCatalogSnapshotPluginEntriesComplete(source.rootDir, pluginNames);
    else await validateCatalogSnapshotComplete(source.rootDir);
    signal?.throwIfAborted();
  }
}

export function selectCatalogOperationContext(
  context: CatalogOperationContext,
  sourceIds: CatalogSourceId[],
): CatalogOperationContext {
  const requested = new Set(sourceIds);
  const missing = sourceIds.find((sourceId) =>
    !context.generationSet.sources.some((source) => source.sourceId === sourceId));
  if (missing) throw new CatalogGenerationError({
    code: 'catalogGenerationUnavailable',
    sourceId: missing,
    message: `Catalog source "${missing}" was unavailable when this operation context was bound. Run aw source sync ${missing}, then retry.`,
  });
  const sources = context.generationSet.sources.filter((source) => requested.has(source.sourceId));
  const generationSetDigest = calculateCatalogGenerationSetDigest(
    context.generationSet.configDigest,
    context.generationSet.primarySourceId,
    sources,
  );
  return {
    generationSet: { ...context.generationSet, sources, generationSetDigest },
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
  if (unknown) throw new CatalogGenerationError({
    code: 'catalogGenerationSourceMissing',
    sourceId: unknown,
    message: `Catalog source "${unknown}" is not configured.`,
  });
  const requested = new Set(sourceIds);
  return snapshot.config.sources.filter((source) => requested.has(source.id)).map((source) => source.id);
}

async function createContext(options: {
  generationSet: CatalogGenerationSet;
  control: CatalogGenerationControlSnapshot;
  signal?: AbortSignal;
}): Promise<CatalogOperationContext> {
  const configured = new Map(options.control.configSnapshot.config.sources.map((source) => [source.id, source]));
  const sources = options.generationSet.sources.map((generation) => {
    options.signal?.throwIfAborted();
    const source = configured.get(generation.sourceId);
    const active = options.control.generationState.sources[generation.sourceId]?.active;
    if (!source || !active
      || active.snapshotDigest !== generation.snapshotDigest
      || active.sourceIdentity !== generation.sourceIdentity) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationIdentityMismatch',
        sourceId: generation.sourceId,
        message: `Active Catalog snapshot for source "${generation.sourceId}" changed while the operation context was being resolved. Retry the operation.`,
      });
    }
    const resolution: CatalogSourceResolution = {
      sourceId: generation.sourceId,
      sourceIdentity: generation.sourceIdentity,
      logicalIdentity: generation.logicalIdentity,
      requestedRef: active.requestedRef,
      resolvedCommit: generation.resolvedCommit,
      rootDir: generation.snapshotPath,
      manifest: generation.manifest,
      manifestDigest: generation.manifestDigest,
      snapshotDigest: generation.snapshotDigest,
      transport: source.type,
      async cleanup() {},
    };
    return { sourceId: generation.sourceId, resolution };
  });
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
  options: ResolveCatalogOperationContextOptions = {},
  readScope?: CatalogPreparationReadScope,
): Promise<CatalogOperationContext> {
  if (readScope) return readScope.resolve(options, true);
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const control = await readCatalogGenerationControlSnapshot({
    env,
    configSnapshot: options.configSnapshot,
  });
  const generationSet = await resolveCatalogGenerationSet({
    sourceIds: selectedSourceIds(control.configSnapshot, options.sourceIds),
    env,
    controlSnapshot: control,
    validatedStoreEntries: options.validatedStoreEntries,
    validatingStoreEntries: options.validatingStoreEntries,
    reuseTransport: options.reuseTransport,
  });
  return createContext({ generationSet, control, signal: options.signal });
}

export async function resolvePartialCatalogOperationContext(
  options: ResolveCatalogOperationContextOptions = {},
  readScope?: CatalogPreparationReadScope,
): Promise<CatalogOperationContext> {
  if (readScope) return readScope.resolve(options);
  const env = options.env ?? process.env;
  const control = await readCatalogGenerationControlSnapshot({
    env,
    configSnapshot: options.configSnapshot,
  });
  const sourceIds = selectedSourceIds(control.configSnapshot, options.sourceIds);
  const results = await Promise.all(sourceIds.map(async (sourceId) => {
    try {
      const generationSet = await resolveCatalogGenerationSet({
        sourceIds: [sourceId],
        env,
        controlSnapshot: control,
        validatedStoreEntries: options.validatedStoreEntries,
        validatingStoreEntries: options.validatingStoreEntries,
        reuseTransport: options.reuseTransport,
      });
      return { sourceId, context: await createContext({ generationSet, control, signal: options.signal }) };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return { sourceId, error: error as Error };
    }
  }));
  const sources = results.flatMap((result) => result.context?.generationSet.sources ?? [])
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const primarySourceId = control.configSnapshot.config.sources.find((source) => source.primary)!.id;
  const generationSetDigest = calculateCatalogGenerationSetDigest(
    control.configSnapshot.digest,
    primarySourceId,
    sources,
  );
  return {
    generationSet: {
      generationSetDigest,
      configDigest: control.configSnapshot.digest,
      primarySourceId,
      sources,
    },
    generationSetDigest,
    catalog: {
      sources: results.map((result) => result.context
        ? result.context.catalog.sources[0]!
        : { sourceId: result.sourceId, error: result.error! }),
      primarySourceId,
      configDigest: control.configSnapshot.digest,
      compositeDigest: generationSetDigest,
    },
  };
}
