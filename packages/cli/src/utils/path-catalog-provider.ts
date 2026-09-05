import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogProviderRuntimeOptions,
  CatalogSourceResolution,
  PathCatalogSource,
} from '../types.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { calculateCatalogSourceIdentity } from './catalog-source-identity.js';
import { checkAwCapabilitySupport } from './manifest.js';
import { readCatalogSnapshotLogicalIdentity } from './catalog-generation-store.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

async function resolvePathCatalogSource(
  source: PathCatalogSource,
  options: CatalogProviderRuntimeOptions,
): Promise<CatalogSourceResolution> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const temporaryRoot = path.join(
    canonicalizePathThroughExistingAncestorSync(resolveAwHome(env)),
    'tmp',
  );
  await ensureRegularDirectoryPath(temporaryRoot, 'Catalog provider temporary directory');
  const stagingDir = await fs.mkdtemp(path.join(temporaryRoot, 'catalog-path-'));
  let returned = false;
  try {
    const sourceRoot = await fs.realpath(source.path);
    const before = await validateCatalogSnapshotTransport(sourceRoot);
    await fs.copy(sourceRoot, stagingDir, {
      dereference: false,
      preserveTimestamps: true,
      filter: () => {
        options.signal?.throwIfAborted();
        return true;
      },
    });
    const copied = await validateCatalogSnapshotTransport(stagingDir);
    const after = await validateCatalogSnapshotTransport(sourceRoot);
    if (
      before.manifestDigest !== copied.manifestDigest
      || before.snapshotDigest !== copied.snapshotDigest
      || after.manifestDigest !== copied.manifestDigest
      || after.snapshotDigest !== copied.snapshotDigest
    ) throw new Error(`Catalog path source "${source.id}" changed during snapshot copy.`);
    const requiredCapabilities = copied.manifest.requires.aw.capabilities ?? [];
    const support = checkAwCapabilitySupport(requiredCapabilities, IMPLEMENTED_AW_CAPABILITIES);
    if (!support.supported) {
      throw new CatalogProviderCompatibilityError({
        sourceId: source.id,
        requiredCapabilities,
        missingCapabilities: support.missing,
        availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
      });
    }
    returned = true;
    let cleaned = false;
    return {
      sourceId: source.id,
      sourceIdentity,
      logicalIdentity: await readCatalogSnapshotLogicalIdentity(stagingDir),
      requestedRef: 'path',
      resolvedCommit: `path:${copied.snapshotDigest}`,
      rootDir: stagingDir,
      manifest: copied.manifest,
      manifestDigest: copied.manifestDigest,
      snapshotDigest: copied.snapshotDigest,
      transport: 'path',
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await fs.remove(stagingDir);
      },
    };
  } finally {
    if (!returned) await fs.remove(stagingDir).catch(() => undefined);
  }
}

/** @internal Provider bridge for source sync. */
export const catalogPathProviderInternal = {
  resolve: resolvePathCatalogSource,
};
