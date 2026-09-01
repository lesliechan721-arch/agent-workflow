import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { CATALOG_STORE_DIRECTORY, CATALOG_STORE_METADATA_FILE } from '../constants.js';
import type {
  CatalogGenerationMetadataV1,
  CatalogManifestV7,
  CatalogSourceResolution,
} from '../types.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { validateCatalogSnapshotTransport } from './catalog-snapshot.js';
import { normalizeAwCapabilities, parseStrictSemVer } from './manifest.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

const DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export interface CatalogStoreLocation {
  awHomeDir: string;
  storeRootDir: string;
  logicalIdentityDirectory: string;
  entryDir: string;
  metadataPath: string;
  snapshotRoot: string;
  storeKey: string;
}

export interface CatalogStoreEntry {
  entryDir: string;
  snapshotRoot: string;
  metadata: CatalogGenerationMetadataV1;
  manifest: CatalogManifestV7;
  reused: boolean;
}

function metadataError(message: string, cause?: unknown): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogGenerationMetadataInvalid',
    message: `${message} Remove the damaged store entry and run aw catalog source sync.`,
    cause,
  });
}

function digestHex(value: string, name: string): string {
  const match = DIGEST_PATTERN.exec(value);
  if (!match) throw metadataError(`Invalid ${name}: expected a SHA-256 digest.`);
  return match[1]!;
}

function logicalIdentitySegment(value: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw metadataError('Invalid Catalog logical identity.');
  }
  try {
    if (value === '.') return '%2E';
    if (value === '..') return '%2E%2E';
    const segment = encodeURIComponent(value);
    if (segment === '.' || segment === '..' || /[\\/]/u.test(segment)) {
      throw metadataError('Invalid Catalog logical identity.');
    }
    return segment;
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw metadataError('Invalid Catalog logical identity.', error);
  }
}

function resolveStrictStoreDescendant(storeRootDir: string, ...segments: string[]): string {
  const candidate = path.resolve(storeRootDir, ...segments);
  const relative = path.relative(storeRootDir, candidate);
  if (
    relative === ''
    || path.isAbsolute(relative)
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
  ) throw metadataError('Invalid Catalog store path.');
  return candidate;
}

export function createCatalogStoreKey(logicalIdentity: string, snapshotDigest: string): string {
  return `${logicalIdentitySegment(logicalIdentity)}/${digestHex(snapshotDigest, 'snapshot digest')}`;
}

export function resolveCatalogStoreLocation(options: {
  logicalIdentity: string;
  snapshotDigest: string;
  env?: NodeJS.ProcessEnv;
}): CatalogStoreLocation {
  const awHomeDir = canonicalizePathThroughExistingAncestorSync(
    resolveAwHome(options.env ?? process.env),
  );
  const storeRootDir = path.join(awHomeDir, CATALOG_STORE_DIRECTORY);
  const logicalIdentity = logicalIdentitySegment(options.logicalIdentity);
  const digest = digestHex(options.snapshotDigest, 'snapshot digest');
  const storeKey = `${logicalIdentity}/${digest}`;
  const logicalIdentityDirectory = resolveStrictStoreDescendant(storeRootDir, logicalIdentity);
  const entryDir = resolveStrictStoreDescendant(storeRootDir, logicalIdentity, digest);
  return {
    awHomeDir,
    storeRootDir,
    logicalIdentityDirectory,
    entryDir,
    metadataPath: path.join(entryDir, CATALOG_STORE_METADATA_FILE),
    snapshotRoot: path.join(entryDir, 'snapshot'),
    storeKey,
  };
}

function strictRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseMetadata(value: unknown): CatalogGenerationMetadataV1 {
  if (!strictRecord(value, [
    'schemaVersion', 'logicalIdentity', 'catalogVersion', 'channel', 'manifestDigest',
    'snapshotDigest', 'requiredAwCapabilities',
  ])) throw metadataError('Invalid Catalog store metadata.');
  if (
    value.schemaVersion !== 1
    || typeof value.logicalIdentity !== 'string'
    || value.logicalIdentity.trim() === ''
    || value.logicalIdentity !== value.logicalIdentity.trim()
    || typeof value.catalogVersion !== 'string'
    || (value.channel !== 'latest' && value.channel !== 'beta')
    || typeof value.manifestDigest !== 'string'
    || !DIGEST_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string'
    || !DIGEST_PATTERN.test(value.snapshotDigest)
    || !Array.isArray(value.requiredAwCapabilities)
    || value.requiredAwCapabilities.some((entry) => typeof entry !== 'string')
  ) throw metadataError('Invalid Catalog store metadata.');
  try {
    parseStrictSemVer(value.catalogVersion, 'Catalog store catalogVersion');
    if (JSON.stringify(normalizeAwCapabilities(value.requiredAwCapabilities))
      !== JSON.stringify(value.requiredAwCapabilities)) {
      throw new Error('Capabilities are not normalized.');
    }
  } catch (error) {
    throw metadataError('Invalid Catalog store metadata.', error);
  }
  return value as unknown as CatalogGenerationMetadataV1;
}

export async function readCatalogSnapshotLogicalIdentity(snapshotRoot: string): Promise<string> {
  try {
    const markerPath = path.join(snapshotRoot, '.aw-generated.json');
    const stat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw metadataError('Catalog marker is missing or unsafe.');
    const marker = await fs.readJson(markerPath) as unknown;
    if (!strictRecord(marker, ['schemaVersion', 'kind', 'workspaceIdentity', 'sourceIdentity'])
      || marker.schemaVersion !== 1
      || marker.kind !== 'catalog'
      || typeof marker.workspaceIdentity !== 'string'
      || marker.workspaceIdentity.trim() === '') {
      throw metadataError('Catalog marker is invalid.');
    }
    return marker.workspaceIdentity;
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw metadataError('Catalog marker is unreadable.', error);
  }
}

async function validateEntry(options: {
  location: CatalogStoreLocation;
}): Promise<CatalogStoreEntry> {
  try {
    const stat = await fs.lstat(options.location.entryDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw metadataError('Catalog store entry is missing or unsafe.');
    const metadataStat = await fs.lstat(options.location.metadataPath).catch(
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error),
    );
    if (!metadataStat?.isFile() || metadataStat.isSymbolicLink()) {
      throw metadataError('Catalog store metadata is missing or unsafe.');
    }
    const metadata = parseMetadata(await fs.readJson(options.location.metadataPath));
    const validation = await validateCatalogSnapshotTransport(options.location.snapshotRoot)
      .catch((error: unknown) => { throw metadataError('Catalog store snapshot is damaged.', error); });
    if (
      createCatalogStoreKey(metadata.logicalIdentity, metadata.snapshotDigest) !== options.location.storeKey
      || validation.manifestDigest !== metadata.manifestDigest
      || validation.snapshotDigest !== metadata.snapshotDigest
      || validation.manifest.catalogVersion !== metadata.catalogVersion
      || validation.manifest.channel !== metadata.channel
      || JSON.stringify(normalizeAwCapabilities(validation.manifest.requires.aw.capabilities ?? []))
        !== JSON.stringify(metadata.requiredAwCapabilities)
      || await readCatalogSnapshotLogicalIdentity(options.location.snapshotRoot) !== metadata.logicalIdentity
    ) throw metadataError('Catalog store content does not match its immutable identity.');
    return {
      entryDir: options.location.entryDir,
      snapshotRoot: options.location.snapshotRoot,
      metadata,
      manifest: validation.manifest,
      reused: true,
    };
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw metadataError('Catalog store entry is unreadable.', error);
  }
}

export async function publishCatalogStoreEntry(options: {
  resolution: CatalogSourceResolution;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<CatalogStoreEntry> {
  options.signal?.throwIfAborted();
  const logicalIdentity = await readCatalogSnapshotLogicalIdentity(options.resolution.rootDir);
  const location = resolveCatalogStoreLocation({
    logicalIdentity,
    snapshotDigest: options.resolution.snapshotDigest,
    env: options.env,
  });
  await ensureRegularDirectoryPath(location.storeRootDir, 'Catalog store');
  await ensureRegularDirectoryPath(location.logicalIdentityDirectory, 'Catalog logical identity store');
  if (await fs.pathExists(location.entryDir)) return validateEntry({ location });

  const stagingDir = resolveStrictStoreDescendant(
    location.storeRootDir,
    path.basename(location.logicalIdentityDirectory),
    `.staging-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.mkdir(stagingDir);
    const snapshotRoot = path.join(stagingDir, 'snapshot');
    await fs.copy(options.resolution.rootDir, snapshotRoot, {
      dereference: false,
      preserveTimestamps: true,
      filter: () => {
        options.signal?.throwIfAborted();
        return true;
      },
    });
    const validation = await validateCatalogSnapshotTransport(snapshotRoot);
    if (
      validation.manifestDigest !== options.resolution.manifestDigest
      || validation.snapshotDigest !== options.resolution.snapshotDigest
      || await readCatalogSnapshotLogicalIdentity(snapshotRoot) !== logicalIdentity
    ) throw new CatalogGenerationError({
      code: 'catalogGenerationPublishFailed',
      sourceId: options.resolution.sourceId,
      message: `Catalog source "${options.resolution.sourceId}" changed before store publication. Run source sync again.`,
    });
    const metadata: CatalogGenerationMetadataV1 = {
      schemaVersion: 1,
      logicalIdentity,
      catalogVersion: validation.manifest.catalogVersion,
      channel: validation.manifest.channel,
      manifestDigest: validation.manifestDigest,
      snapshotDigest: validation.snapshotDigest,
      requiredAwCapabilities: normalizeAwCapabilities(validation.manifest.requires.aw.capabilities ?? []),
    };
    await fs.writeFile(
      path.join(stagingDir, CATALOG_STORE_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    options.signal?.throwIfAborted();
    try {
      await fs.rename(stagingDir, location.entryDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      return validateEntry({ location });
    }
    return { entryDir: location.entryDir, snapshotRoot: location.snapshotRoot, metadata, manifest: validation.manifest, reused: false };
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationPublishFailed',
      sourceId: options.resolution.sourceId,
      message: `Cannot publish Catalog store entry for source "${options.resolution.sourceId}". The previous Active entry is unchanged.`,
      cause: error,
    });
  } finally {
    await fs.remove(stagingDir).catch(() => undefined);
  }
}

export async function readCatalogStoreEntry(options: {
  logicalIdentity: string;
  snapshotDigest: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogStoreEntry> {
  return validateEntry({ location: resolveCatalogStoreLocation(options) });
}
