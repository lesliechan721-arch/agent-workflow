import path from 'node:path';

import fs from 'fs-extra';

import {
  assertCatalogSourceInventoryComplete,
  inventoryCatalogSourceReferences,
} from './catalog-source-references.js';
import { readStrictNamespacedMarketplaceRoot } from './local-marketplace.js';
import { resolveAwHome } from './state-paths.js';

export async function cleanupOrphanNamespacedMarketplaceRoot(options: {
  sourceId: string;
  sourceIdentity: string;
  marketplaceName?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const rootDir = path.join(resolveAwHome(options.env), 'marketplaces', options.sourceId);
  let root;
  try {
    root = await readStrictNamespacedMarketplaceRoot({
      rootDir,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      ...(options.marketplaceName ? { marketplaceName: options.marketplaceName } : {}),
    });
  } catch {
    return false;
  }
  if (!root) return false;
  const inventory = await inventoryCatalogSourceReferences({ cwd: options.cwd, env: options.env });
  try {
    assertCatalogSourceInventoryComplete(inventory);
  } catch {
    return false;
  }
  const blockingReference = inventory.references.some((reference) =>
    reference.sourceId === options.sourceId
    && !(reference.kind === 'namespacedMarketplace' && reference.pluginName === undefined));
  if (blockingReference) return false;
  await fs.remove(root.rootDir);
  return true;
}
