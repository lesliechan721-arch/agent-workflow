import type {
  CatalogManifestV4,
  CatalogManifestV4Entry,
  CatalogManifestV4Release,
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
  compareStrictSemVer,
} from './manifest.js';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_HEAD_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const CATALOG_SCHEMA_4_CLI_FLOOR = '0.1.0';

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

function normalizeRelease(raw: unknown): CatalogManifestV4Release {
  const release = assertObject(raw, 'catalog manifest v4.release');
  if (release.state === 'development') {
    assertAllowedKeys(release, 'catalog manifest v4.release', ['state']);
    return { state: 'development' };
  }
  if (release.state !== 'published') {
    throw new Error('Invalid catalog manifest v4.release.state.');
  }
  assertAllowedKeys(release, 'catalog manifest v4.release', [
    'state', 'targetVersion', 'planId', 'sourceHead', 'contentDigest',
  ]);
  if (typeof release.targetVersion !== 'string' || !/^\d+\.\d+\.\d+$/u.test(release.targetVersion)) {
    throw new Error('Invalid catalog manifest v4.release.targetVersion: expected a stable version.');
  }
  if (typeof release.sourceHead !== 'string' || !SOURCE_HEAD_PATTERN.test(release.sourceHead)) {
    throw new Error('Invalid catalog manifest v4.release.sourceHead.');
  }
  return {
    state: 'published',
    targetVersion: release.targetVersion,
    planId: digest(release.planId, 'catalog manifest v4.release.planId'),
    sourceHead: release.sourceHead,
    contentDigest: digest(release.contentDigest, 'catalog manifest v4.release.contentDigest'),
  };
}

export function validateCatalogManifestV4(rawManifest: unknown): CatalogManifestV4 {
  const input = assertObject(rawManifest, 'catalog manifest v4');
  assertAllowedKeys(input, 'catalog manifest v4', [
    'schemaVersion', 'catalogVersion', 'channel', 'compatibility', 'release', 'entries',
  ]);
  if (input.schemaVersion !== 4) {
    throw new Error('Invalid catalog manifest v4.schemaVersion: expected 4.');
  }
  if (!Array.isArray(input.entries)) {
    throw new Error('Invalid catalog manifest v4.entries: expected an array.');
  }
  const contentDigests: string[] = [];
  const entryInputs = input.entries.map((rawEntry, index) => {
    const entry = assertObject(rawEntry, `catalog manifest v4.entries[${index}]`);
    contentDigests.push(digest(entry.contentDigest, `catalog manifest v4.entries[${index}].contentDigest`));
    const entryInput = { ...entry };
    delete entryInput.contentDigest;
    return entryInput;
  });
  const base = normalizeCatalogManifestBase(input, 'catalog manifest v4');
  if (compareStrictSemVer(base.compatibility.aw.minVersion, CATALOG_SCHEMA_4_CLI_FLOOR) < 0) {
    throw new Error(`Invalid catalog manifest v4.compatibility.aw.minVersion: schema 4 requires ${CATALOG_SCHEMA_4_CLI_FLOOR} or newer.`);
  }
  const entries = normalizeCatalogManifestEntries(entryInputs, base, 'catalog manifest v4');
  const release = normalizeRelease(input.release);
  if (
    release.state === 'published'
    && release.targetVersion !== base.catalogVersion.replace(/-beta\.[1-9]\d*$/u, '')
  ) {
    throw new Error('Invalid catalog manifest v4.release.targetVersion: must equal the stable catalogVersion core.');
  }
  return {
    schemaVersion: 4,
    catalogVersion: base.catalogVersion,
    channel: base.channel,
    compatibility: base.compatibility,
    release,
    entries: entries.map((entry, index) => ({ ...entry, contentDigest: contentDigests[index]! })),
  };
}

export function createCatalogManifestV4(
  manifest: Omit<CatalogManifestV4, 'schemaVersion'>,
): CatalogManifestV4 {
  return validateCatalogManifestV4({ schemaVersion: 4, ...manifest });
}

export async function createCatalogManifestV4Entry(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestV4Entry> {
  if (!plugin.manifest.compatibility) {
    throw new Error(`Plugin "${plugin.manifest.name}" is missing compatibility metadata.`);
  }
  return {
    ...createMarketplaceManifestEntry(plugin),
    version: plugin.manifest.version,
    compatibility: plugin.manifest.compatibility,
    artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
    manifestDigest: calculateCatalogEntryManifestDigest(plugin.manifest),
    contentDigest: await calculateCatalogEntryContentDigest(pluginRoot),
  };
}
