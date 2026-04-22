import type { PlatformName } from '../types.js';
import { readJsonFile } from './json.js';
import {
  getMarketplaceManifestPath,
  getMarketplaceManifestPaths,
} from './paths.js';

export interface MarketplaceManifest {
  name: string;
  plugins: Array<{ name: string }>;
  [key: string]: unknown;
}

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
  repoRoot: string,
  platform: PlatformName,
): Promise<{
  path: string;
  manifest: MarketplaceManifest;
}> {
  const marketplacePaths = getMarketplaceManifestPaths(repoRoot);
  const targetPath = getMarketplaceManifestPath(repoRoot, platform);
  const [targetManifest, claudeManifest, codexManifest] = await Promise.all([
    readJsonFile<MarketplaceManifest>(targetPath),
    readJsonFile<MarketplaceManifest>(marketplacePaths.claude),
    readJsonFile<MarketplaceManifest>(marketplacePaths.codex),
  ]);

  if (serializeComparableValue(claudeManifest) !== serializeComparableValue(codexManifest)) {
    throw new Error(
      'marketplace 镜像不一致，请先同步 `.claude-plugin/marketplace.json` 和 `.agents/plugins/marketplace.json`。',
    );
  }

  return {
    path: targetPath,
    manifest: targetManifest,
  };
}
