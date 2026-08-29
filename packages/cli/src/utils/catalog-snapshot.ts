import path from 'node:path';

import {
  validateCatalogSnapshotComplete as validateCoreCatalogSnapshotComplete,
  validateCatalogSnapshotPluginEntriesComplete as validateCoreCatalogSnapshotPluginEntriesComplete,
  validateCatalogSnapshotTransport as validateCoreCatalogSnapshotTransport,
} from '@lesliechan721/aw-plugin-core';

import { CURRENT_CATALOG_MANIFEST_FILE } from '../constants.js';
import type { CatalogManifestV5 } from '../types.js';
import { calculateFileDigest } from './bundle-integrity.js';

export interface CatalogSnapshotValidation {
  rootDir: string;
  manifest: CatalogManifestV5;
  manifestDigest: string;
  snapshotDigest: string;
}

async function withManifestDigest(
  validation: Omit<CatalogSnapshotValidation, 'manifestDigest'>,
): Promise<CatalogSnapshotValidation> {
  return {
    ...validation,
    manifestDigest: await calculateFileDigest(
      path.join(validation.rootDir, CURRENT_CATALOG_MANIFEST_FILE),
    ),
  };
}

export async function validateCatalogSnapshotTransport(rootDir: string): Promise<CatalogSnapshotValidation> {
  return withManifestDigest(await validateCoreCatalogSnapshotTransport(rootDir));
}

export async function validateCatalogSnapshotComplete(rootDir: string): Promise<CatalogSnapshotValidation> {
  return withManifestDigest(await validateCoreCatalogSnapshotComplete(rootDir));
}

export async function validateCatalogSnapshotPluginEntriesComplete(
  rootDir: string,
  pluginNames: readonly string[],
): Promise<CatalogSnapshotValidation> {
  return withManifestDigest(await validateCoreCatalogSnapshotPluginEntriesComplete(rootDir, pluginNames));
}
