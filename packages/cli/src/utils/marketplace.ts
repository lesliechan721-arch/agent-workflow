import type { MarketplaceManifest, PlatformName } from '../types.js';
import { readJsonFile } from './json.js';
import { resolveCurrentCatalog } from './plugin-catalog.js';
import {
  getMarketplaceManifestPath,
  getMarketplaceManifestPaths,
} from './paths.js';

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeComparableValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeComparableValue(entry)]),
    );
  }

  return value;
}

function serializeComparableValue(value: unknown): string {
  return JSON.stringify(normalizeComparableValue(value));
}

export async function readMarketplaceManifest(
  _cwd: string,
  platform: PlatformName,
): Promise<{
  path: string;
  manifest: MarketplaceManifest;
}> {
  const catalog = await resolveCurrentCatalog();
  const marketplacePaths = getMarketplaceManifestPaths(catalog.rootDir);
  const targetPath = getMarketplaceManifestPath(catalog.rootDir, platform);
  const [targetManifest, claudeManifest, codexManifest] = await Promise.all([
    readJsonFile<MarketplaceManifest>(targetPath),
    readJsonFile<MarketplaceManifest>(marketplacePaths.claude),
    readJsonFile<MarketplaceManifest>(marketplacePaths.codex),
  ]);

  if (serializeComparableValue(claudeManifest) !== serializeComparableValue(codexManifest)) {
    throw new Error(
      'marketplace mirrors are inconsistent; rebuild the embedded bundle before continuing.',
    );
  }

  return {
    path: targetPath,
    manifest: targetManifest,
  };
}
