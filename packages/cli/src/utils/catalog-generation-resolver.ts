import crypto from 'node:crypto';

import type {
  CatalogGenerationPointerV1,
  CatalogGenerationSet,
  CatalogGenerationSetSource,
  CatalogGenerationStateFileV1,
  CatalogSource,
  SourceIdentity,
} from '../types.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import {
  readCatalogGenerationControlSnapshot,
  type CatalogGenerationControlSnapshot,
} from './catalog-generation-control-snapshot.js';
import {
  readCatalogGeneration,
  type PublishedCatalogGeneration,
} from './catalog-generation-store.js';
import { checkAwCapabilitySupport } from './manifest.js';

export interface ResolvedActiveCatalogGeneration extends CatalogGenerationSetSource {
  pointer: CatalogGenerationPointerV1;
}

async function resolveFromState(options: {
  source: CatalogSource;
  sourceIdentity: SourceIdentity;
  state: CatalogGenerationStateFileV1;
  env: NodeJS.ProcessEnv;
  validatedGenerations?: Map<string, PublishedCatalogGeneration>;
  validatingGenerations?: Map<string, Promise<PublishedCatalogGeneration>>;
}): Promise<ResolvedActiveCatalogGeneration> {
  const selected = options.state.sources[options.source.id];
  if (!selected?.active) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationUnavailable',
      sourceId: options.source.id,
      message: `Catalog source "${options.source.id}" has no Active generation. Run aw catalog source refresh ${options.source.id}.`,
    });
  }
  if (selected.active.sourceIdentity !== options.sourceIdentity) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      sourceId: options.source.id,
      message: `Active Catalog generation for source "${options.source.id}" does not match the current source identity. Confirm the configured location, run aw catalog source refresh ${options.source.id}, then reload and retry.`,
    });
  }
  let generation = options.validatedGenerations?.get(selected.active.generationKey);
  if (!generation) {
    let pending = options.validatingGenerations?.get(selected.active.generationKey);
    if (!pending) {
      pending = readCatalogGeneration({
        logicalIdentity: selected.logicalIdentity!,
        snapshotDigest: selected.active.snapshotDigest,
        env: options.env,
      });
      options.validatingGenerations?.set(selected.active.generationKey, pending);
    }
    try {
      generation = await pending;
      options.validatedGenerations?.set(selected.active.generationKey, generation);
    } finally {
      if (options.validatingGenerations?.get(selected.active.generationKey) === pending) {
        options.validatingGenerations.delete(selected.active.generationKey);
      }
    }
  }
  const requiredCapabilities = generation.metadata.requiredAwCapabilities;
  const support = checkAwCapabilitySupport(requiredCapabilities, IMPLEMENTED_AW_CAPABILITIES);
  if (!support.supported) {
    throw new CatalogProviderCompatibilityError({
      sourceId: options.source.id,
      requiredCapabilities,
      missingCapabilities: support.missing,
      availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
    });
  }
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
    sourceIdentity: selected.active.sourceIdentity,
    logicalIdentity: selected.logicalIdentity!,
    catalogVersion: selected.active.catalogVersion,
    resolvedCommit: selected.active.resolvedCommit,
    manifestDigest: selected.active.manifestDigest,
    snapshotDigest: selected.active.snapshotDigest,
    generationKey: selected.active.generationKey,
    snapshotPath: generation.snapshotRoot,
    manifest: generation.manifest,
    pointer: selected.active,
  };
}

export async function resolveActiveCatalogGeneration(options: {
  sourceId: string;
  env?: NodeJS.ProcessEnv;
  validatedGenerations?: Map<string, PublishedCatalogGeneration>;
  validatingGenerations?: Map<string, Promise<PublishedCatalogGeneration>>;
}): Promise<ResolvedActiveCatalogGeneration> {
  const env = options.env ?? process.env;
  const controlSnapshot = await readCatalogGenerationControlSnapshot({ env });
  const source = controlSnapshot.configSnapshot.config.sources
    .find((entry) => entry.id === options.sourceId);
  if (!source) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationSourceMissing',
      sourceId: options.sourceId,
      message: `Catalog source "${options.sourceId}" is not configured.`,
    });
  }
  return resolveFromState({
    source,
    sourceIdentity: controlSnapshot.sourceIdentities[source.id]!,
    state: controlSnapshot.generationState,
    env,
    validatedGenerations: options.validatedGenerations,
    validatingGenerations: options.validatingGenerations,
  });
}

export function calculateCatalogGenerationSetDigest(
  configDigest: string,
  primarySourceId: string,
  sources: CatalogGenerationSetSource[],
): string {
  const input = {
    configDigest,
    primarySourceId,
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      sourceConfigFingerprint: source.sourceConfigFingerprint,
      sourceIdentity: source.sourceIdentity,
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
  controlSnapshot?: CatalogGenerationControlSnapshot;
  validatedGenerations?: Map<string, PublishedCatalogGeneration>;
  validatingGenerations?: Map<string, Promise<PublishedCatalogGeneration>>;
} = {}): Promise<CatalogGenerationSet> {
  const env = options.env ?? process.env;
  const controlSnapshot = options.controlSnapshot
    ?? await readCatalogGenerationControlSnapshot({ env });
  const validatedGenerations = options.validatedGenerations ?? new Map();
  const validatingGenerations = options.validatingGenerations ?? new Map();
  const config = controlSnapshot.configSnapshot;
  const state = controlSnapshot.generationState;
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
    resolveFromState({
      source,
      sourceIdentity: controlSnapshot.sourceIdentities[source.id]!,
      state,
      env,
      validatedGenerations,
      validatingGenerations,
    })));
  const sources: CatalogGenerationSetSource[] = resolved.map(({ pointer: _pointer, ...source }) => source);
  const primarySourceId = config.config.sources.find((source) => source.primary)!.id;
  return {
    generationSetDigest: calculateCatalogGenerationSetDigest(
      config.digest,
      primarySourceId,
      sources,
    ),
    configDigest: config.digest,
    primarySourceId,
    sources,
  };
}
