import type {
  CatalogManifestV6,
  CatalogManifestV6Entry,
  CatalogManifestV6Release,
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
export const CATALOG_SCHEMA_6_CAPABILITY = 'aw.catalog-snapshot.v6';

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

function normalizeRelease(raw: unknown): CatalogManifestV6Release {
  const release = assertObject(raw, 'catalog manifest v6.release');
  if (release.state === 'development') {
    assertAllowedKeys(release, 'catalog manifest v6.release', ['state']);
    return { state: 'development' };
  }
  if (release.state !== 'published') {
    throw new Error('Invalid catalog manifest v6.release.state.');
  }
  assertAllowedKeys(release, 'catalog manifest v6.release', ['state', 'sourceHead']);
  if (typeof release.sourceHead !== 'string' || !SOURCE_HEAD_PATTERN.test(release.sourceHead)) {
    throw new Error('Invalid catalog manifest v6.release.sourceHead.');
  }
  return {
    state: 'published',
    sourceHead: release.sourceHead,
  };
}

export function validateCatalogManifestV6(rawManifest: unknown): CatalogManifestV6 {
  const input = assertObject(rawManifest, 'catalog manifest v6');
  assertAllowedKeys(input, 'catalog manifest v6', [
    'schemaVersion', 'catalogVersion', 'channel', 'requires', 'marketplace', 'release', 'entries',
  ]);
  if (input.schemaVersion !== 6) {
    throw new Error('Invalid catalog manifest v6.schemaVersion: expected 6.');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Invalid catalog manifest v6.entries: expected an array.');
  }
  const contentDigests: string[] = [];
  const entryInputs = input.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `catalog manifest v6.entries[${index}]`);
    contentDigests.push(digest(entry.contentDigest, `catalog manifest v6.entries[${index}].contentDigest`));
    const entryInput = { ...entry };
    delete entryInput.contentDigest;
    return entryInput;
  });
  const base = normalizeCatalogManifestBase(input, 'catalog manifest v6');
  const marketplace = normalizeCatalogMarketplaceIdentity(input.marketplace);
  if (!(base.requires.aw.capabilities ?? []).includes(CATALOG_SCHEMA_6_CAPABILITY)) {
    throw new Error(`Invalid catalog manifest v6.requires.aw.capabilities: expected ${CATALOG_SCHEMA_6_CAPABILITY}.`);
  }
  const entries = normalizeCatalogManifestEntries(entryInputs, base, 'catalog manifest v6');
  const release = normalizeRelease(input.release);
  return {
    schemaVersion: 6,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    requires: base.requires,
    marketplace,
    release,
    entries: entries.map((entry, index) => ({ ...entry, contentDigest: contentDigests[index]! })),
  };
}

export function createCatalogManifestV6(
  manifest: Omit<CatalogManifestV6, 'schemaVersion'>,
): CatalogManifestV6 {
  return validateCatalogManifestV6({ schemaVersion: 6, ...manifest });
}

export async function createCatalogManifestV6Entry(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestV6Entry> {
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
