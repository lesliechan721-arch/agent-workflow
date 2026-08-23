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
  publishCatalogSourceCacheEntry,
  resolveCatalogSourceCacheLocation,
} = catalogSourceCacheInternal;

async function resolvePathCatalogSource(
  source: PathCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  return resolvePathCatalogSourceDirect(source, options);
}

/** @internal Provider bridge for the multi-source resolver. */
export const catalogPathProviderInternal = {
  resolve: resolvePathCatalogSource,
};

async function resolvePathCatalogSourceDirect(
  source: PathCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  const env = options.env ?? process.env;
  if (options.signal?.aborted) throw options.signal.reason;
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const location = resolveCatalogSourceCacheLocation({ sourceId: source.id, sourceIdentity, env });
  await ensureCatalogSourceCacheLocation(location);
  const stagingRoot = path.join(location.rootDir, `.path-${crypto.randomUUID()}.tmp`);
  let published = false;
  try {
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
    ) throw new Error(`Catalog path source "${source.id}" changed during snapshot copy.`);
    if (compareStrictSemVer(options.cliVersion, copied.manifest.compatibility.aw.minVersion) < 0) {
      throw new CatalogProviderCompatibilityError({
        sourceId: source.id,
        minAwVersion: copied.manifest.compatibility.aw.minVersion,
        selection: 'explicit',
      });
    }
    const entry = await publishCatalogSourceCacheEntry({
      location,
      sourceId: source.id,
      sourceIdentity,
      requestedRef: 'path',
      cliVersion: options.cliVersion,
      resolvedCommit: `path:${copied.snapshotDigest}`,
      snapshotRoot: stagingRoot,
      validation: copied,
      signal: options.signal,
    });
    published = true;
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
    try {
      await fs.remove(stagingRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!published || (code !== 'EBUSY' && code !== 'EPERM')) throw error;
      try {
        process.emitWarning(
          `Catalog path source was published, but staging cleanup failed with ${code}.`,
          { code: 'AW_CATALOG_PROVIDER_CLEANUP_FAILED' },
        );
      } catch {
        // Diagnostics cannot replace a published cache result.
      }
    }
  }
}
