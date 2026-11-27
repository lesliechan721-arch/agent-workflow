import { CatalogGenerationError } from '../utils/catalog-generation-error.js';
import { resolveActiveCatalogGeneration } from '../utils/catalog-generation-resolver.js';
import { CatalogPreparationReadScope, type CatalogOperationContext } from '../utils/catalog-operation-context.js';
import { readCatalogGenerationStatus } from '../utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { validateCatalogSnapshotComplete } from '../utils/catalog-snapshot.js';
import {
  createCatalogStoreKey,
  readCatalogStoreEntry,
  type CatalogStoreEntry,
} from '../utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import {
  calculateCatalogSourceConfigFingerprint,
  calculateCatalogSourceIdentity,
} from '../utils/catalog-source-identity.js';

import type { CatalogSourceGenerationViewModel } from './catalog-sources/types.js';

export type {
  CatalogGenerationViewModel,
  CatalogSourceGenerationViewModel,
} from './catalog-sources/types.js';

/** Complete validation of a source with a missing plugin. Null revokes a previous positive check. */
export type RetirementSourceChecks = Readonly<Record<string, string | null>>;

export async function checkRetirementSources(
  catalog: CatalogOperationContext | undefined,
  residualPluginIds: readonly string[],
  signal: AbortSignal,
  readScope?: CatalogPreparationReadScope,
): Promise<RetirementSourceChecks> {
  const checks: Array<[string, string | null]> = [];
  for (const { sourceId, resolution: source } of catalog?.catalog.sources ?? []) {
    if (!source) continue;
    const prefix = sourceId + '/';
    const residuals = residualPluginIds.filter((id) => id.startsWith(prefix));
    if (!residuals.length) continue;
    const listed = new Set(source.manifest.entries.map((entry) => prefix + entry.name));
    if (residuals.every((id) => listed.has(id))) continue;
    signal.throwIfAborted();
    let complete = false;
    try {
      if (readScope) {
        await CatalogPreparationReadScope.validateEntries(readScope, source);
        complete = true;
      } else {
        const checked = await validateCatalogSnapshotComplete(source.rootDir);
        complete = checked.snapshotDigest === source.snapshotDigest;
      }
    } catch {
      // An unreadable bundle leaves the source recovery and offline actions available.
    }
    signal.throwIfAborted();
    checks.push([sourceId, complete ? createCatalogStoreKey(source.logicalIdentity, source.snapshotDigest) : null]);
  }
  return Object.fromEntries(checks);
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
  signal?: AbortSignal;
  preparation?: { scope: CatalogPreparationReadScope; context?: CatalogOperationContext };
  validatedStoreEntries?: Map<string, CatalogStoreEntry>;
  validatingStoreEntries?: Map<string, Promise<CatalogStoreEntry>>;
  onStage?: (event: CatalogGenerationLoadStageEvent) => void | Promise<void>;
  now?: () => number;
} = {}): Promise<CatalogSourceGenerationViewModel[]> {
  options.signal?.throwIfAborted();
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
  options.signal?.throwIfAborted();
  let fullValidationCount = 0;
  let reusedValidationCount = 0;
  const validationStartedAt = now();
  const sourceReads = sources.map(async (source): Promise<CatalogSourceGenerationViewModel> => {
    const instruction = `aw source sync ${source.id}`;
    const wasValidated = options.validatedStoreEntries?.size ?? 0;
    try {
      const prepared = options.preparation && await options.preparation.scope.resolveActiveGeneration(
        source.id, options.preparation.context?.catalog.sources.find((item) => item.sourceId === source.id)?.resolution,
      );
      const active = prepared?.active ?? await resolveActiveCatalogGeneration({
        sourceId: source.id,
        env,
        validatedStoreEntries: options.validatedStoreEntries,
        validatingStoreEntries: options.validatingStoreEntries,
      });
      if (prepared) options.validatedStoreEntries?.set(active.storeKey, prepared.sessionEntry);
      if (prepared ? !prepared.reused : (options.validatedStoreEntries?.size ?? 0) > wasValidated) fullValidationCount += 1;
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
        compatibility: { state: 'supported' },
        technicalCommand: instruction,
      };
    } catch (error) {
      options.signal?.throwIfAborted();
      let errorCode = error instanceof CatalogGenerationError
        ? error.code
        : 'catalogGenerationUnavailable';
      let recoveryEntryPath: string | undefined;
      let state: CatalogSourceGenerationViewModel['state'] = 'unavailable';
      const sourceState = await readCatalogGenerationState(env)
        .then((value) => value.sources[source.id])
        .catch(() => undefined);
      options.signal?.throwIfAborted();
      const statusEntry = await readCatalogGenerationStatus({
        sourceId: source.id,
        env,
        validatedStoreEntries: options.preparation ? undefined : options.validatedStoreEntries,
        validatingStoreEntries: options.preparation ? undefined : options.validatingStoreEntries,
      })
        .then((status) => status.sources[0])
        .catch(() => undefined);
      options.signal?.throwIfAborted();
      const compatibility = statusEntry?.compatibility ?? null;
      if (
        compatibility?.state === 'unsupported'
        && statusEntry?.active
        && statusEntry.catalogVersion
        && statusEntry.channel
        && statusEntry.storeKey
      ) {
        if ((options.validatedStoreEntries?.size ?? 0) > wasValidated) fullValidationCount += 1;
        else reusedValidationCount += 1;
        return {
          sourceId: source.id,
          sourceType: source.type,
          active: {
            catalogVersion: statusEntry.catalogVersion,
            channel: statusEntry.channel,
            requestedRef: statusEntry.active.requestedRef,
            resolvedCommit: statusEntry.active.resolvedCommit,
            storeKey: statusEntry.storeKey,
            digestShort: shortDigest(statusEntry.active.snapshotDigest),
          },
          errorCode: 'awCapabilityUnsupported',
          ...(!statusEntry.configMatchesActive ? { configMismatch: true } : {}),
          state: 'incompatible',
          compatibility,
          technicalCommand: instruction,
        };
      }
      const configMismatch = Boolean(sourceState?.active)
        && (sourceState!.active!.sourceConfigFingerprint
            !== calculateCatalogSourceConfigFingerprint(source)
          || sourceState!.active!.sourceIdentity !== await calculateCatalogSourceIdentity(source));
      options.signal?.throwIfAborted();
      const activeEntryDamaged = sourceState?.active
        ? await readCatalogStoreEntry({
            logicalIdentity: sourceState.active.logicalIdentity,
            snapshotDigest: sourceState.active.snapshotDigest,
            env,
          }).then(() => false).catch(() => true)
        : false;
      if (activeEntryDamaged) errorCode = 'catalogGenerationMetadataInvalid';
      if (compatibility?.state === 'unsupported') state = 'incompatible';
      else if (errorCode === 'catalogGenerationStateInvalid') state = 'stateInvalid';
      else if (errorCode === 'catalogGenerationMetadataInvalid') state = 'repairRequired';
      else if (!sourceState?.active) state = 'activationRequired';
      else if (configMismatch) state = 'configMismatch';
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
        compatibility,
        ...(configMismatch ? { configMismatch: true } : {}),
        ...(recoveryEntryPath ? { recoveryEntryPath } : {}),
        technicalCommand: instruction,
      };
    }
  });
  const viewModels = await Promise.all(sourceReads).catch(async (error: unknown) => {
    // Session reload waits for reads that already started on sibling sources.
    await Promise.allSettled(sourceReads);
    throw error;
  });
  options.signal?.throwIfAborted();
  await reportStage({
    name: 'catalog.validation',
    durationMs: Math.max(0, now() - validationStartedAt),
    pointerCount: viewModels.filter((source) => source.active).length,
    fullValidationCount,
    reusedValidationCount,
  });
  return viewModels;
}
