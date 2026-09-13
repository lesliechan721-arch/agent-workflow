import {
  catalogStorePrune,
  catalogStoreStatus,
  type CatalogStoreInspectionEntry,
  type CatalogStorePruneItemKey,
  type CatalogStorePruneResult,
  type CatalogStoreStatusResult,
} from '../commands/catalog-store.js';

export interface CatalogStoreTaskOptions {
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface CatalogStoreTaskEvidence {
  preview: CatalogStorePruneResult;
  entries: CatalogStoreInspectionEntry[];
  authorizedItems: CatalogStorePruneItemKey[];
  reclaimableBytes: number | null;
}

export function inspectCatalogStoreTask(
  options: CatalogStoreTaskOptions = {},
): Promise<CatalogStoreStatusResult> {
  return catalogStoreStatus(options);
}

export async function prepareCatalogStoreTask(
  options: CatalogStoreTaskOptions = {},
): Promise<CatalogStoreTaskEvidence> {
  const preview = await catalogStorePrune({ ...options, dryRun: true });
  return {
    preview,
    entries: preview.entries,
    authorizedItems: preview.entries
      .filter((entry) => entry.status === 'reclaimable')
      .map(({ storeKey, category }) => ({ storeKey, category })),
    reclaimableBytes: preview.reclaimableBytes,
  };
}

export function executeCatalogStoreTask(
  options: CatalogStoreTaskOptions & {
    authorizedItems: readonly CatalogStorePruneItemKey[];
  },
): Promise<CatalogStorePruneResult> {
  return catalogStorePrune({ ...options, dryRun: false });
}
