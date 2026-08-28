import crypto from 'node:crypto';

import type {
  CatalogGenerationPointerV1,
  CatalogGenerationSet,
  CatalogGenerationSetSource,
  CatalogGenerationStateFileV1,
  CatalogSource,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { readCatalogGenerationState } from './catalog-generation-state.js';
import { readCatalogGeneration } from './catalog-generation-store.js';
import { calculateCatalogSourceConfigFingerprint } from './catalog-source-identity.js';
import { readCatalogSourcesConfigSnapshot } from './catalog-sources.js';

export interface ResolvedActiveCatalogGeneration extends CatalogGenerationSetSource {
  pointer: CatalogGenerationPointerV1;
}

async function resolveFromState(options: {
  source: CatalogSource;
  state: CatalogGenerationStateFileV1;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedActiveCatalogGeneration> {
  const selected = options.state.sources[options.source.id];
  if (!selected?.active) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationUnavailable',
      sourceId: options.source.id,
      message: `Catalog source "${options.source.id}" has no Active generation. Run aw catalog source refresh ${options.source.id}.`,
    });
  }
  if (
    selected.active.sourceConfigFingerprint
    !== calculateCatalogSourceConfigFingerprint(options.source)
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      sourceId: options.source.id,
      message: `Active Catalog generation for source "${options.source.id}" does not match the current source configuration. Refresh the source.`,
    });
  }
  const generation = await readCatalogGeneration({
    logicalIdentity: selected.logicalIdentity,
    snapshotDigest: selected.active.snapshotDigest,
    env: options.env,
  });
  if (
    generation.metadata.logicalIdentity !== selected.logicalIdentity
    || generation.metadata.catalogVersion !== selected.active.catalogVersion
    || generation.metadata.channel !== selected.active.channel
    || generation.metadata.manifestDigest !== selected.active.manifestDigest
    || generation.metadata.snapshotDigest !== selected.active.snapshotDigest
    || generation.metadata.generationKey !== selected.active.generationKey
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      sourceId: options.source.id,
      message: `Active Catalog generation for source "${options.source.id}" does not match its immutable metadata. Refresh the source after repairing catalog-generations.json.`,
    });
  }
  return {
    sourceId: options.source.id,
    sourceConfigFingerprint: selected.active.sourceConfigFingerprint,
    logicalIdentity: selected.logicalIdentity,
    catalogVersion: selected.active.catalogVersion,
    resolvedCommit: selected.active.resolvedCommit,
    manifestDigest: selected.active.manifestDigest,
    snapshotDigest: selected.active.snapshotDigest,
    generationKey: selected.active.generationKey,
    snapshotPath: generation.snapshotRoot,
    pointer: selected.active,
  };
}

export async function resolveActiveCatalogGeneration(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedActiveCatalogGeneration> {
  const env = options.env ?? process.env;
  const [config, state] = await Promise.all([
    readCatalogSourcesConfigSnapshot(env),
    readCatalogGenerationState(env),
  ]);
  const source = config.config.sources.find((entry) => entry.id === options.sourceId);
  if (!source) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" is not configured.`,
    });
  }
  return resolveFromState({ source, state, env });
}

export function calculateCatalogGenerationSetDigest(
  primarySourceId: string,
  sources: CatalogGenerationSetSource[],
): string {
  const input = {
    primarySourceId,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      sourceConfigFingerprint: source.sourceConfigFingerprint,
      logicalIdentity: source.logicalIdentity,
      catalogVersion: source.catalogVersion,
      resolvedCommit: source.resolvedCommit,
      manifestDigest: source.manifestDigest,
      snapshotDigest: source.snapshotDigest,
      generationKey: source.generationKey,
    })),
  };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

export async function resolveCatalogGenerationSet(options: {
  sourceIds?: string[];
  env?: NodeJS.ProcessEnv;
} = {}): Promise<CatalogGenerationSet> {
  const env = options.env ?? process.env;
  const [config, state] = await Promise.all([
    readCatalogSourcesConfigSnapshot(env),
    readCatalogGenerationState(env),
  ]);
  const requested = options.sourceIds ? new Set(options.sourceIds) : null;
  if (requested) {
    const configured = new Set(config.config.sources.map((source) => source.id));
    const missing = [...requested].find((sourceId) => !configured.has(sourceId));
    if (missing) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationSourceMissing',
        sourceId: missing,
        message: `Catalog source "${missing}" is not configured.`,
      });
    }
  }
  const configuredSources = config.config.sources
    .filter((source) => !requested || requested.has(source.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const resolved = await Promise.all(configuredSources.map((source) =>
    resolveFromState({ source, state, env })));
  const sources: CatalogGenerationSetSource[] = resolved.map(({ pointer: _pointer, ...source }) => source);
  const primarySourceId = config.config.sources.find((source) => source.primary)!.id;
  return {
    generationSetDigest: calculateCatalogGenerationSetDigest(primarySourceId, sources),
    primarySourceId,
    sources,
  };
}
