import type {
  CatalogManifestV5,
  CatalogManifestV5Entry,
  CatalogManifestV5Release,
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
export const CATALOG_SCHEMA_5_CAPABILITY = 'aw.catalog-snapshot.v5';

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

function normalizeRelease(raw: unknown): CatalogManifestV5Release {
  const release = assertObject(raw, 'catalog manifest v5.release');
  if (release.state === 'development') {
    assertAllowedKeys(release, 'catalog manifest v5.release', ['state']);
    return { state: 'development' };
  }
  if (release.state !== 'published') {
    throw new Error('Invalid catalog manifest v5.release.state.');
  }
  assertAllowedKeys(release, 'catalog manifest v5.release', [
    'state', 'targetVersion', 'planId', 'sourceHead', 'contentDigest',
  ]);
  if (typeof release.targetVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(release.targetVersion)) {
    throw new Error('Invalid catalog manifest v5.release.targetVersion: expected a stable version.');
  }
  if (typeof release.sourceHead !== 'string' || !SOURCE_HEAD_PATTERN.test(release.sourceHead)) {
    throw new Error('Invalid catalog manifest v5.release.sourceHead.');
  }
  return {
    state: 'published',
    targetVersion: release.targetVersion,
    planId: digest(release.planId, 'catalog manifest v5.release.planId'),
    sourceHead: release.sourceHead,
    contentDigest: digest(release.contentDigest, 'catalog manifest v5.release.contentDigest'),
  };
}

export function validateCatalogManifestV5(rawManifest: unknown): CatalogManifestV5 {
  const input = assertObject(rawManifest, 'catalog manifest v5');
  assertAllowedKeys(input, 'catalog manifest v5', [
    'schemaVersion', 'catalogVersion', 'channel', 'requires', 'marketplace', 'release', 'entries',
  ]);
  if (input.schemaVersion !== 5) {
    throw new Error('Invalid catalog manifest v5.schemaVersion: expected 5.');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Invalid catalog manifest v5.entries: expected an array.');
  }
  const contentDigests: string[] = [];
  const entryInputs = input.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `catalog manifest v5.entries[${index}]`);
    contentDigests.push(digest(entry.contentDigest, `catalog manifest v5.entries[${index}].contentDigest`));
    const entryInput = { ...entry };
    delete entryInput.contentDigest;
    return entryInput;
  });
  const base = normalizeCatalogManifestBase(input, 'catalog manifest v5');
  const marketplace = normalizeCatalogMarketplaceIdentity(input.marketplace);
  if (!(base.requires.aw.capabilities ?? []).includes(CATALOG_SCHEMA_5_CAPABILITY)) {
    throw new Error(`Invalid catalog manifest v5.requires.aw.capabilities: expected ${CATALOG_SCHEMA_5_CAPABILITY}.`);
  }
  const entries = normalizeCatalogManifestEntries(entryInputs, base, 'catalog manifest v5');
  const release = normalizeRelease(input.release);
  if (
    release.state === 'published'
    && release.targetVersion !== base.catalogVersion.replace(/-beta\.[1-9]\d*$/u, '')
  ) {
    throw new Error('Invalid catalog manifest v5.release.targetVersion: must equal the stable catalogVersion core.');
  }
  return {
    schemaVersion: 5,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    requires: base.requires,
    marketplace,
    release,
    entries: entries.map((entry, index) => ({ ...entry, contentDigest: contentDigests[index]! })),
  };
}

export function createCatalogManifestV5(
  manifest: Omit<CatalogManifestV5, 'schemaVersion'>,
): CatalogManifestV5 {
  return validateCatalogManifestV5({ schemaVersion: 5, ...manifest });
}

export async function createCatalogManifestV5Entry(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestV5Entry> {
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
