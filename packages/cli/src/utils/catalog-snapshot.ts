import path from 'node:path';

import {
  validateCatalogSnapshot as validateCoreCatalogSnapshot,
} from '@lesliechan721/aw-plugin-core';

import { CURRENT_CATALOG_MANIFEST_FILE } from '../constants.js';
import type { CatalogManifestV4 } from '../types.js';
import { calculateFileDigest } from './bundle-integrity.js';

export interface CatalogSnapshotValidation {
  rootDir: string;
  manifest: CatalogManifestV4;
  manifestDigest: string;
  snapshotDigest: string;
}

export async function validateCatalogSnapshot(rootDir: string): Promise<CatalogSnapshotValidation> {
  const validation = await validateCoreCatalogSnapshot(rootDir);
  return {
    ...validation,
    manifestDigest: await calculateFileDigest(
      path.join(validation.rootDir, CURRENT_CATALOG_MANIFEST_FILE),
    ),
  };
}
