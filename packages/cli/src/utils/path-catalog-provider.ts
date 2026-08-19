import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogProviderRuntimeOptions,
  CatalogSourceResolution,
  PathCatalogSource,
} from '../types.js';
import { calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import {
  catalogSourceCacheInternal,
} from './catalog-source-cache.js';
import { validateCatalogSnapshot } from './catalog-snapshot.js';
import { compareStrictSemVer } from './manifest.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';

const {
  ensureCatalogSourceCacheLocation,
  observeAndReserveCatalogSourceObservation,
  publishCatalogSourceCacheEntry,
  resolveCatalogSourceCacheLocation,
  withCatalogSourceCacheLease,
} = catalogSourceCacheInternal;

export interface CatalogPathProviderTestHooks {
  beforeObservationLock?: (observation: {
    sourceId: string;
  }) => Promise<void>;
  afterStableObservationBeforeReservation?: (observation: {
    sourceId: string;
    snapshotDigest: string;
  }) => Promise<void>;
  afterObservation?: (observation: {
    sourceId: string;
    snapshotDigest: string;
    observationOrder: number;
  }) => Promise<void>;
}

let catalogPathProviderTestHooks: CatalogPathProviderTestHooks | undefined;

export function setCatalogPathProviderTestHooksForTests(
  hooks: CatalogPathProviderTestHooks | undefined,
): void {
  catalogPathProviderTestHooks = hooks;
}

async function resolvePathCatalogSource(
  source: PathCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  return withCatalogSourceCacheLease({
    env: options.env,
    signal: options.signal,
    action: () => resolvePathCatalogSourceWithLease(source, options),
  });
}

/** @internal Provider bridge for the lease-scoped multi-source resolver and provider tests. */
export const catalogPathProviderInternal = {
  resolve: resolvePathCatalogSource,
};

async function resolvePathCatalogSourceWithLease(
  source: PathCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  const env = options.env ?? process.env;
  if (options.signal?.aborted) throw options.signal.reason;
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
  await ensureCatalogSourceCacheLocation(location);
  const stagingRoot = path.join(location.rootDir, `.path-${crypto.randomUUID()}.tmp`);
  try {
    await catalogPathProviderTestHooks?.beforeObservationLock?.({ sourceId: source.id });
    const observed = await observeAndReserveCatalogSourceObservation({
      location,
      signal: options.signal,
      observe: async () => {
        const initial = await validateCatalogSnapshot(await fs.realpath(source.path));
        const sourceRoot = initial.rootDir;
        await fs.copy(sourceRoot, stagingRoot, { dereference: false, preserveTimestamps: true });
        const copied = await validateCatalogSnapshot(stagingRoot);
        const current = await validateCatalogSnapshot(sourceRoot);
        if (
          initial.manifestDigest !== copied.manifestDigest
          || initial.snapshotDigest !== copied.snapshotDigest
          || current.manifestDigest !== copied.manifestDigest
          || current.snapshotDigest !== copied.snapshotDigest
        ) {
          throw new Error(`Catalog path source "${source.id}" changed during snapshot copy.`);
        }
        if (compareStrictSemVer(options.cliVersion, copied.manifest.compatibility.aw.minVersion) < 0) {
          throw new CatalogProviderCompatibilityError({
            sourceId: source.id,
            minAwVersion: copied.manifest.compatibility.aw.minVersion,
            selection: 'explicit',
          });
        }
        await catalogPathProviderTestHooks?.afterStableObservationBeforeReservation?.({
          sourceId: source.id,
          snapshotDigest: copied.snapshotDigest,
        });
        return copied;
      },
    });
    const copied = observed.observation;
    const observationOrder = observed.observationOrder;
    await catalogPathProviderTestHooks?.afterObservation?.({
      sourceId: source.id,
      snapshotDigest: copied.snapshotDigest,
      observationOrder,
    });
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'path',
      resolvedCommit: `path:${copied.snapshotDigest}`,
      snapshotRoot: stagingRoot,
      validation: copied,
      observationOrder,
      signal: options.signal,
    });
    return {
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'path',
      resolvedCommit: entry.metadata.resolvedCommit,
      rootDir: entry.snapshotRoot,
      manifest: entry.validation.manifest,
      manifestDigest: entry.validation.manifestDigest,
      snapshotDigest: entry.validation.snapshotDigest,
      cacheEntryKey: entry.metadata.entryKey,
      source: 'path',
      cacheFallback: false,
    };
  } finally {
    await fs.remove(stagingRoot);
  }
}
