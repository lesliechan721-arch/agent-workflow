import type {
  CatalogManifestV3,
  CatalogManifestV3Entry,
  PluginMeta,
} from '../types.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from './catalog-digests.js';
import {
  createMarketplaceManifestEntry,
  normalizeCatalogManifestBase,
  normalizeCatalogManifestEntries,
} from './manifest.js';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  fieldName: string,
  allowedKeys: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
    }
  }
}

function normalizeContentDigest(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a sha256 digest string.`);
  }
  return value;
}

export function validateCatalogManifestV3(rawManifest: unknown): CatalogManifestV3 {
  const input = assertObject(rawManifest, 'catalog manifest v3');
  assertAllowedKeys(input, 'catalog manifest v3', [
    'schemaVersion',
    'catalogVersion',
    'channel',
    'compatibility',
    'entries',
  ]);
  if (input.schemaVersion !== 3) {
    throw new Error('Invalid catalog manifest v3.schemaVersion: expected 3.');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Invalid catalog manifest v3.entries: expected an array.');
  }

  const contentDigests: string[] = [];
  const entryInputs = input.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `catalog manifest v3.entries[${index}]`);
    contentDigests.push(normalizeContentDigest(
      entry.contentDigest,
      `catalog manifest v3.entries[${index}].contentDigest`,
    ));
    const entryInput = { ...entry };
    delete entryInput.contentDigest;
    return entryInput;
  });
  const base = normalizeCatalogManifestBase(input, 'catalog manifest v3');
  const entries = normalizeCatalogManifestEntries(
    entryInputs,
    base,
    'catalog manifest v3',
  );

  return {
    schemaVersion: 3,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    compatibility: base.compatibility,
    entries: entries.map((entry, index) => ({
      ...entry,
      contentDigest: contentDigests[index]!,
    })),
  };
}

export function createCatalogManifestV3(
  manifest: Omit<CatalogManifestV3, 'schemaVersion'>,
): CatalogManifestV3 {
  return validateCatalogManifestV3({ schemaVersion: 3, ...manifest });
}

export async function createCatalogManifestV3Entry(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestV3Entry> {
  if (!plugin.manifest.compatibility) {
    throw new Error(`Plugin "${plugin.manifest.name}" is missing compatibility metadata.`);
  }
  const marketplaceEntry = createMarketplaceManifestEntry(plugin);
  const entry = {
    ...marketplaceEntry,
    version: plugin.manifest.version,
    compatibility: plugin.manifest.compatibility,
    artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
    manifestDigest: calculateCatalogEntryManifestDigest(plugin.manifest),
    contentDigest: await calculateCatalogEntryContentDigest(pluginRoot),
  };
  return entry;
}
