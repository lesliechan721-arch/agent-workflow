import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { resolveActiveCatalogGeneration } from '../utils/catalog-generation-resolver.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import {
  createCatalogStoreKey,
  readCatalogStoreEntry,
  type CatalogStoreEntry,
} from '../utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { calculateCatalogSourceConfigFingerprint } from '../utils/catalog-source-identity.js';

export interface CatalogGenerationViewModel {
  catalogVersion: string;
  channel: 'latest' | 'beta';
  requestedRef: string;
  resolvedCommit: string;
  storeKey: string;
  digestShort: string;
}

export interface CatalogSourceGenerationViewModel {
  sourceId: string;
  sourceType: 'git' | 'path';
  active?: CatalogGenerationViewModel;
  errorCode?: string;
  recoveryEntryPath?: string;
  state?: 'ready' | 'activationRequired' | 'repairRequired' | 'configMismatch'
    | 'stateInvalid' | 'unavailable';
  technicalCommand?: string;
}

export type CatalogGenerationLoadStageEvent =
  | {
      name: 'catalog.load';
      durationMs: number;
      sourceCount: number;
    }
  | {
      name: 'catalog.validation';
      durationMs: number;
      pointerCount: number;
      fullValidationCount: number;
      reusedValidationCount: number;
    };

function shortDigest(value: string): string {
  const digest = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return digest.slice(0, 8);
}

export async function loadCatalogGenerationViewModels(options: {
  env?: NodeJS.ProcessEnv;
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
  onStage?: (event: CatalogGenerationLoadStageEvent) => void | Promise<void>;
  now?: () => number;
} = {}): Promise<CatalogSourceGenerationViewModel[]> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const reportStage = async (event: CatalogGenerationLoadStageEvent): Promise<void> => {
    await Promise.resolve().then(() => options.onStage?.(event)).catch(() => undefined);
  };
  const contextStartedAt = now();
  const config = await readCatalogSourcesConfigSnapshot(env);
  const sources = [...config.config.sources]
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
  await reportStage({
    name: 'catalog.load',
    durationMs: Math.max(0, now() - contextStartedAt),
    sourceCount: sources.length,
  });
  let fullValidationCount = 0;
  let reusedValidationCount = 0;
  const validationStartedAt = now();
  const viewModels = await Promise.all(sources.map(async (source): Promise<CatalogSourceGenerationViewModel> => {
    const instruction = `aw catalog source sync ${source.id}`;
    const wasValidated = options.validatedStoreEntries?.size ?? 0;
    try {
      const active = await resolveActiveCatalogGeneration({
        sourceId: source.id,
        env,
        validatedStoreEntries: options.validatedStoreEntries,
        validatingStoreEntries: options.validatingStoreEntries,
      });
      if ((options.validatedStoreEntries?.size ?? 0) > wasValidated) fullValidationCount += 1;
      else reusedValidationCount += 1;
      return {
        sourceId: source.id,
        sourceType: source.type,
        active: {
          catalogVersion: active.catalogVersion,
          channel: active.manifest.channel,
          requestedRef: active.active.requestedRef,
          resolvedCommit: active.resolvedCommit,
          storeKey: active.storeKey,
          digestShort: shortDigest(active.snapshotDigest),
        },
        state: 'ready',
        technicalCommand: instruction,
      };
    } catch (error) {
      let errorCode = error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationUnavailable';
      let recoveryEntryPath: string | undefined;
      let state: CatalogSourceGenerationViewModel['state'] = 'unavailable';
      const sourceState = await readCatalogGenerationState(env)
        .then((value) => value.sources[source.id])
        .catch(() => undefined);
      const activeEntryDamaged = sourceState?.active
        ? await readCatalogStoreEntry({
            logicalIdentity: sourceState.active.logicalIdentity,
            snapshotDigest: sourceState.active.snapshotDigest,
            env,
          }).then(() => false).catch(() => true)
        : false;
      if (activeEntryDamaged) errorCode = 'catalogGenerationMetadataInvalid';
      if (errorCode === 'catalogGenerationStateInvalid') state = 'stateInvalid';
      else if (errorCode === 'catalogGenerationMetadataInvalid') state = 'repairRequired';
      else if (!sourceState?.active) state = 'activationRequired';
      else if (sourceState.active.sourceConfigFingerprint
        !== calculateCatalogSourceConfigFingerprint(source)) state = 'configMismatch';
      else state = 'repairRequired';
      if (errorCode === 'catalogGenerationMetadataInvalid') {
        const active = sourceState?.active;
        if (active) {
          recoveryEntryPath = `catalog-store/${createCatalogStoreKey(
            active.logicalIdentity,
            active.snapshotDigest,
          )}`;
        }
      }
      return {
        sourceId: source.id,
        sourceType: source.type,
        errorCode,
        state,
        ...(recoveryEntryPath ? { recoveryEntryPath } : {}),
        technicalCommand: instruction,
      };
    }
  }));
  await reportStage({
    name: 'catalog.validation',
    durationMs: Math.max(0, now() - validationStartedAt),
    pointerCount: viewModels.filter((source) => source.active).length,
    fullValidationCount,
    reusedValidationCount,
  });
  return viewModels;
}
