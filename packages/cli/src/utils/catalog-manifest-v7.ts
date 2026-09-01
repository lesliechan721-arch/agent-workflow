import type {
  CatalogManifestV7,
  CatalogManifestV7Entry,
  CatalogManifestV7Release,
  PluginMeta,
} from '../types.js';
import fs from 'fs-extra';
import path from 'node:path';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from './catalog-digests.js';
import {
  createMarketplaceManifestEntry,
  normalizeCatalogManifestBase,
  normalizeCatalogManifestEntries,
  normalizeCatalogMarketplaceIdentity,
  normalizeAwCapabilities,
} from './manifest.js';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const CATALOG_SCHEMA_7_CAPABILITY = 'aw.catalog-snapshot.v7';

function assertObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function assertAllowedKeys(value: Record<string, unknown>, fieldName: string, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Invalid ${fieldName}: unknown field "${key}".`);
  }
}

function digest(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid ${fieldName}: expected a canonical sha256 digest.`);
  }
  return value;
}

function normalizeRelease(raw: unknown): CatalogManifestV7Release {
  const release = assertObject(raw, 'catalog manifest v7.release');
  if (release.state === 'development') {
    assertAllowedKeys(release, 'catalog manifest v7.release', ['state']);
    return { state: 'development' };
  }
  if (release.state !== 'published') {
    throw new Error('Invalid catalog manifest v7.release.state.');
  }
  assertAllowedKeys(release, 'catalog manifest v7.release', ['state', 'sourceHead']);
  if (typeof release.sourceHead !== 'string' || !SOURCE_HEAD_PATTERN.test(release.sourceHead)) {
    throw new Error('Invalid catalog manifest v7.release.sourceHead.');
  }
  return {
    state: 'published',
    sourceHead: release.sourceHead,
  };
}

export function validateCatalogManifestV7(rawManifest: unknown): CatalogManifestV7 {
  const input = assertObject(rawManifest, 'catalog manifest v7');
  assertAllowedKeys(input, 'catalog manifest v7', [
    'schemaVersion', 'catalogVersion', 'channel', 'requires', 'marketplace', 'release', 'entries',
  ]);
  if (input.schemaVersion !== 7) {
    throw new Error('Invalid catalog manifest v7.schemaVersion: expected 7.');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Invalid catalog manifest v7.entries: expected an array.');
  }
  const contentDigests: string[] = [];
  const entryInputs = input.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `catalog manifest v7.entries[${index}]`);
    contentDigests.push(digest(entry.contentDigest, `catalog manifest v7.entries[${index}].contentDigest`));
    const entryInput = { ...entry };
    delete entryInput.contentDigest;
    return entryInput;
  });
  const base = normalizeCatalogManifestBase(input, 'catalog manifest v7');
  const marketplace = normalizeCatalogMarketplaceIdentity(input.marketplace);
  if (!(base.requires.aw.capabilities ?? []).includes(CATALOG_SCHEMA_7_CAPABILITY)) {
    throw new Error(`Invalid catalog manifest v7.requires.aw.capabilities: expected ${CATALOG_SCHEMA_7_CAPABILITY}.`);
  }
  const entries = normalizeCatalogManifestEntries(entryInputs, base, 'catalog manifest v7');
  const release = normalizeRelease(input.release);
  return {
    schemaVersion: 7,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    requires: base.requires,
    marketplace,
    release,
    entries: entries.map((entry, index) => ({ ...entry, contentDigest: contentDigests[index]! })),
  };
}

export function createCatalogManifestV7(
  manifest: Omit<CatalogManifestV7, 'schemaVersion'>,
): CatalogManifestV7 {
  return validateCatalogManifestV7({ schemaVersion: 7, ...manifest });
}

export async function createCatalogManifestV7Entry(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestV7Entry> {
  return {
    ...createMarketplaceManifestEntry(plugin),
    version: plugin.manifest.version,
    dependencies: [...(plugin.manifest.dependencies ?? [])].sort(),
    requires: {
      aw: {
        capabilities: normalizeAwCapabilities(plugin.manifest.requires?.aw.capabilities ?? []),
      },
    },
    artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
    manifestDigest: calculateCatalogEntryManifestDigest(
      await fs.readJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json')),
    ),
    contentDigest: await calculateCatalogEntryContentDigest(pluginRoot),
  };
}
