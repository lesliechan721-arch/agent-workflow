import type {
  CatalogGenerationStateFileV1,
  CatalogSourceId,
  SourceIdentity,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { readCatalogGenerationState } from './catalog-generation-state.js';
import { calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import {
  readCatalogSourcesConfigSnapshot,
  type CatalogSourcesConfigSnapshot,
} from './catalog-sources.js';

const MAX_CONTROL_SNAPSHOT_RETRIES = 3;

export interface CatalogGenerationControlSnapshot {
  configSnapshot: CatalogSourcesConfigSnapshot;
  generationState: CatalogGenerationStateFileV1;
  sourceIdentities: Record<CatalogSourceId, SourceIdentity>;
}

function identityMismatch(): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogGenerationIdentityMismatch',
    message: 'Catalog source configuration changed while generation state was being read. Retry the operation.',
  });
}

async function sourceIdentities(
  snapshot: CatalogSourcesConfigSnapshot,
): Promise<Record<CatalogSourceId, SourceIdentity>> {
  return Object.fromEntries(await Promise.all(snapshot.config.sources.map(async (source) => [
    source.id,
    await calculateCatalogSourceIdentity(source),
  ])));
}

export async function readCatalogGenerationControlSnapshot(options: {
  env?: NodeJS.ProcessEnv;
  configSnapshot?: CatalogSourcesConfigSnapshot;
} = {}): Promise<CatalogGenerationControlSnapshot> {
  const env = options.env ?? process.env;
  if (options.configSnapshot) {
    const generationState = await readCatalogGenerationState(env);
    const currentConfig = await readCatalogSourcesConfigSnapshot(env);
    if (currentConfig.digest !== options.configSnapshot.digest) throw identityMismatch();
    return {
      configSnapshot: options.configSnapshot,
      generationState,
      sourceIdentities: await sourceIdentities(options.configSnapshot),
    };
  }

  for (let attempt = 0; attempt <= MAX_CONTROL_SNAPSHOT_RETRIES; attempt += 1) {
    const configSnapshot = await readCatalogSourcesConfigSnapshot(env);
    const generationState = await readCatalogGenerationState(env);
    const currentConfig = await readCatalogSourcesConfigSnapshot(env);
    if (currentConfig.digest === configSnapshot.digest) {
      return {
        configSnapshot,
        generationState,
        sourceIdentities: await sourceIdentities(configSnapshot),
      };
    }
  }
  throw identityMismatch();
}
