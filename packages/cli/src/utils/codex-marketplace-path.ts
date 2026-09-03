import path from 'node:path';

import fs from 'fs-extra';

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function isRegularDirectoryWithoutSymlink(location: string): Promise<boolean | undefined> {
  try {
    const stats = await fs.lstat(location);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export async function isSafeCodexMarketplaceRoot(options: {
  awHome: string;
  sourceId: string;
  marketplaceRoot: string;
}): Promise<boolean> {
  const awHome = path.resolve(options.awHome);
  const marketplacesRoot = path.join(awHome, 'marketplaces');
  const expectedRoot = path.join(marketplacesRoot, options.sourceId);
  if (path.dirname(expectedRoot) !== marketplacesRoot) return false;
  if (path.resolve(options.marketplaceRoot) !== expectedRoot) return false;

  const awHomeSafe = await isRegularDirectoryWithoutSymlink(awHome);
  if (awHomeSafe !== true) return false;
  const canonicalAwHome = await fs.realpath(awHome);

  const marketplacesSafe = await isRegularDirectoryWithoutSymlink(marketplacesRoot);
  if (marketplacesSafe === false) return false;
  if (marketplacesSafe === undefined) return true;
  const canonicalMarketplacesRoot = await fs.realpath(marketplacesRoot);
  if (canonicalMarketplacesRoot !== path.join(canonicalAwHome, 'marketplaces')) return false;

  const targetSafe = await isRegularDirectoryWithoutSymlink(expectedRoot);
  if (targetSafe === false) return false;
  if (targetSafe === undefined) return true;
  return await fs.realpath(expectedRoot) === path.join(canonicalMarketplacesRoot, options.sourceId);
}
