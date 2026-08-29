import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  CATALOG_GENERATION_METADATA_FILE,
  CATALOG_GENERATIONS_DIRECTORY,
} from '../constants.js';
import type {
  CatalogGenerationMetadataV1,
  CatalogManifestV5,
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

const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/u;

export interface CatalogGenerationLocation {
  awHomeDir: string;
  storeRootDir: string;
  logicalIdentityDirectory: string;
  generationDir: string;
  metadataPath: string;
  snapshotRoot: string;
  generationKey: string;
}

export interface PreparedCatalogGeneration {
  stagingDir: string;
  location: CatalogGenerationLocation;
  metadata: CatalogGenerationMetadataV1;
  manifest: CatalogManifestV5;
}

export interface PublishedCatalogGeneration {
  generationDir: string;
  snapshotRoot: string;
  metadata: CatalogGenerationMetadataV1;
  manifest: CatalogManifestV5;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function digestHex(value: string, fieldName: string): string {
  const match = SHA256_DIGEST_PATTERN.exec(value);
  if (!match) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: `Invalid ${fieldName}: expected a SHA-256 digest. Remove the damaged generation and refresh the source.`,
    });
  }
  return match[1]!;
}

export function createCatalogGenerationKey(
  logicalIdentity: string,
  snapshotDigest: string,
): string {
  if (typeof logicalIdentity !== 'string' || logicalIdentity.trim() === '') {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Invalid Catalog logical identity. Rebuild or republish the Catalog snapshot, then refresh the source.',
    });
  }
  return `${sha256Hex(logicalIdentity)}/${digestHex(snapshotDigest, 'Catalog snapshot digest')}`;
}

export function resolveCatalogGenerationLocation(options: {
  logicalIdentity: string;
  snapshotDigest: string;
  env?: NodeJS.ProcessEnv;
}): CatalogGenerationLocation {
  const awHomeDir = canonicalizePathThroughExistingAncestorSync(
    resolveAwHome(options.env ?? process.env),
  );
  const storeRootDir = path.join(awHomeDir, CATALOG_GENERATIONS_DIRECTORY);
  const generationKey = createCatalogGenerationKey(
    options.logicalIdentity,
    options.snapshotDigest,
  );
  const [logicalIdentityHex, snapshotDigestHex] = generationKey.split('/');
  const logicalIdentityDirectory = path.join(storeRootDir, logicalIdentityHex!);
  const generationDir = path.join(logicalIdentityDirectory, snapshotDigestHex!);
  return {
    awHomeDir,
    storeRootDir,
    logicalIdentityDirectory,
    generationDir,
    metadataPath: path.join(generationDir, CATALOG_GENERATION_METADATA_FILE),
    snapshotRoot: path.join(generationDir, 'snapshot'),
    generationKey,
  };
}

function isStrictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseGenerationMetadata(value: unknown): CatalogGenerationMetadataV1 {
  if (!isStrictObject(value, [
    'schemaVersion',
    'logicalIdentity',
    'catalogVersion',
    'channel',
    'manifestDigest',
    'snapshotDigest',
    'generationKey',
    'requiredAwCapabilities',
    'publishedAt',
  ])) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Invalid Catalog generation metadata. Remove the damaged generation and refresh the source.',
    });
  }
  if (
    value.schemaVersion !== 1
    || typeof value.logicalIdentity !== 'string'
    || value.logicalIdentity.trim() === ''
    || typeof value.catalogVersion !== 'string'
    || !Array.isArray(value.requiredAwCapabilities)
    || value.requiredAwCapabilities.some((capability) => typeof capability !== 'string')
    || (value.channel !== 'latest' && value.channel !== 'beta')
    || typeof value.manifestDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string'
    || !SHA256_DIGEST_PATTERN.test(value.snapshotDigest)
    || typeof value.generationKey !== 'string'
    || !/^[0-9a-f]{64}\/[0-9a-f]{64}$/u.test(value.generationKey)
    || typeof value.publishedAt !== 'string'
    || Number.isNaN(Date.parse(value.publishedAt))
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Invalid Catalog generation metadata. Remove the damaged generation and refresh the source.',
    });
  }
  try {
    parseStrictSemVer(value.catalogVersion, 'Catalog generation catalogVersion');
    if (JSON.stringify(normalizeAwCapabilities(value.requiredAwCapabilities))
      !== JSON.stringify(value.requiredAwCapabilities)) {
      throw new Error('Catalog generation required capabilities are not normalized.');
    }
  } catch (error) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Invalid Catalog generation version metadata. Remove the damaged generation and refresh the source.',
      cause: error,
    });
  }
  if (value.generationKey !== createCatalogGenerationKey(
    value.logicalIdentity,
    value.snapshotDigest,
  )) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog generation metadata does not match its content identity. Remove the damaged generation and refresh the source.',
    });
  }
  return value as unknown as CatalogGenerationMetadataV1;
}

async function readCatalogLogicalIdentity(snapshotRoot: string): Promise<string> {
  const markerPath = path.join(snapshotRoot, '.aw-generated.json');
  const stat = await fs.lstat(markerPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog snapshot has no valid generated marker. Rebuild or republish the Catalog, then refresh the source.',
    });
  }
  const marker = await fs.readJson(markerPath) as unknown;
  if (
    !isStrictObject(marker, ['schemaVersion', 'kind', 'workspaceIdentity', 'sourceIdentity'])
    || marker.schemaVersion !== 1
    || marker.kind !== 'catalog'
    || typeof marker.workspaceIdentity !== 'string'
    || marker.workspaceIdentity.trim() === ''
    || typeof marker.sourceIdentity !== 'string'
    || !SHA256_DIGEST_PATTERN.test(marker.sourceIdentity)
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog snapshot generated marker is invalid. Rebuild or republish the Catalog, then refresh the source.',
    });
  }
  return marker.workspaceIdentity;
}

async function assertRegularGenerationDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog generation directory is missing or unsafe. Refresh the source after repairing the generation store.',
    });
  }
}

async function validateGenerationDirectory(options: {
  generationDir: string;
  logicalIdentity: string;
  snapshotDigest: string;
}): Promise<PublishedCatalogGeneration> {
  const metadata = await readGenerationMetadataAt(options);
  const snapshotRoot = path.join(options.generationDir, 'snapshot');
  let validation: Awaited<ReturnType<typeof validateCatalogSnapshotTransport>>;
  try {
    validation = await validateCatalogSnapshotTransport(snapshotRoot);
  } catch (error) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog generation snapshot is damaged. Remove the damaged generation and refresh the source.',
      cause: error,
    });
  }
  if (
    validation.manifest.catalogVersion !== metadata.catalogVersion
    || validation.manifest.channel !== metadata.channel
    || JSON.stringify(validation.manifest.requires.aw.capabilities ?? [])
      !== JSON.stringify(metadata.requiredAwCapabilities)
    || validation.manifestDigest !== metadata.manifestDigest
    || validation.snapshotDigest !== metadata.snapshotDigest
    || await readCatalogLogicalIdentity(snapshotRoot) !== metadata.logicalIdentity
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      message: 'Catalog generation snapshot does not match its immutable metadata. Remove the damaged generation and refresh the source.',
    });
  }
  return {
    generationDir: options.generationDir,
    snapshotRoot,
    metadata,
    manifest: validation.manifest,
  };
}

async function readGenerationMetadataAt(options: {
  generationDir: string;
  logicalIdentity: string;
  snapshotDigest: string;
}): Promise<CatalogGenerationMetadataV1> {
  await assertRegularGenerationDirectory(options.generationDir);
  const metadataPath = path.join(options.generationDir, CATALOG_GENERATION_METADATA_FILE);
  const metadataStat = await fs.lstat(metadataPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadataStat?.isFile() || metadataStat.isSymbolicLink()) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog generation metadata file is missing or unsafe. Remove the damaged generation and refresh the source.',
    });
  }
  let metadata: CatalogGenerationMetadataV1;
  try {
    metadata = parseGenerationMetadata(await fs.readJson(metadataPath));
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationMetadataInvalid',
      message: 'Catalog generation metadata is unreadable. Remove the damaged generation and refresh the source.',
      cause: error,
    });
  }
  if (
    metadata.logicalIdentity !== options.logicalIdentity
    || metadata.snapshotDigest !== options.snapshotDigest
  ) {
    throw new CatalogGenerationError({
      code: 'catalogGenerationIdentityMismatch',
      message: 'Catalog generation directory identity does not match its metadata. Remove the damaged generation and refresh the source.',
    });
  }
  return metadata;
}

export async function prepareCatalogGeneration(options: {
  resolution: CatalogSourceResolution;
  cliVersion: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  signal?: AbortSignal;
}): Promise<PreparedCatalogGeneration> {
  options.signal?.throwIfAborted();
  const awHomeDir = canonicalizePathThroughExistingAncestorSync(
    resolveAwHome(options.env ?? process.env),
  );
  const storeRootDir = path.join(awHomeDir, CATALOG_GENERATIONS_DIRECTORY);
  await ensureRegularDirectoryPath(storeRootDir, 'Catalog generation store');
  const stagingDir = path.join(storeRootDir, `.staging-${crypto.randomUUID()}.tmp`);
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
    options.signal?.throwIfAborted();
    const validation = await validateCatalogSnapshotTransport(snapshotRoot);
    options.signal?.throwIfAborted();
    if (
      validation.manifestDigest !== options.resolution.manifestDigest
      || validation.snapshotDigest !== options.resolution.snapshotDigest
      || validation.manifest.catalogVersion !== options.resolution.manifest.catalogVersion
      || validation.manifest.channel !== options.resolution.manifest.channel
    ) {
      throw new CatalogGenerationError({
        code: 'catalogGenerationPublishFailed',
        sourceId: options.resolution.sourceId,
        message: `Catalog source "${options.resolution.sourceId}" changed before generation publication. Refresh the source again.`,
      });
    }
    const logicalIdentity = await readCatalogLogicalIdentity(snapshotRoot);
    const location = resolveCatalogGenerationLocation({
      logicalIdentity,
      snapshotDigest: validation.snapshotDigest,
      env: options.env,
    });
    const metadata: CatalogGenerationMetadataV1 = {
      schemaVersion: 1,
      logicalIdentity,
      catalogVersion: validation.manifest.catalogVersion,
      channel: validation.manifest.channel,
      manifestDigest: validation.manifestDigest,
      snapshotDigest: validation.snapshotDigest,
      generationKey: location.generationKey,
      requiredAwCapabilities: normalizeAwCapabilities(
        validation.manifest.requires.aw.capabilities ?? [],
      ),
      publishedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await fs.writeFile(
      path.join(stagingDir, CATALOG_GENERATION_METADATA_FILE),
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    options.signal?.throwIfAborted();
    const validated = await validateGenerationDirectory({
      generationDir: stagingDir,
      logicalIdentity,
      snapshotDigest: validation.snapshotDigest,
    });
    options.signal?.throwIfAborted();
    return { stagingDir, location, metadata, manifest: validated.manifest };
  } catch (error) {
    await fs.remove(stagingDir).catch(() => undefined);
    if (error instanceof CatalogGenerationError) throw error;
    throw new CatalogGenerationError({
      code: 'catalogGenerationPublishFailed',
      sourceId: options.resolution.sourceId,
      message: `Cannot prepare Catalog generation for source "${options.resolution.sourceId}". Refresh the source again after repairing the snapshot.`,
      cause: error,
    });
  }
}

export async function publishPreparedCatalogGeneration(
  prepared: PreparedCatalogGeneration,
): Promise<PublishedCatalogGeneration> {
  await ensureRegularDirectoryPath(
    prepared.location.logicalIdentityDirectory,
    'Catalog logical identity directory',
  );
  const existing = await fs.lstat(prepared.location.generationDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (existing) {
    const published = await validateGenerationDirectory({
      generationDir: prepared.location.generationDir,
      logicalIdentity: prepared.metadata.logicalIdentity,
      snapshotDigest: prepared.metadata.snapshotDigest,
    });
    await fs.remove(prepared.stagingDir).catch(() => undefined);
    return published;
  }
  try {
    await fs.rename(prepared.stagingDir, prepared.location.generationDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      const published = await validateGenerationDirectory({
        generationDir: prepared.location.generationDir,
        logicalIdentity: prepared.metadata.logicalIdentity,
        snapshotDigest: prepared.metadata.snapshotDigest,
      });
      await fs.remove(prepared.stagingDir).catch(() => undefined);
      return published;
    }
    throw new CatalogGenerationError({
      code: 'catalogGenerationPublishFailed',
      message: 'Cannot atomically publish the prepared Catalog generation. The previous Active generation is unchanged; refresh the source again.',
      cause: error,
    });
  }
  return {
    generationDir: prepared.location.generationDir,
    snapshotRoot: prepared.location.snapshotRoot,
    metadata: prepared.metadata,
    manifest: prepared.manifest,
  };
}

export async function discardPreparedCatalogGeneration(
  prepared: PreparedCatalogGeneration,
): Promise<void> {
  await fs.remove(prepared.stagingDir).catch(() => undefined);
}

export async function readCatalogGeneration(options: {
  logicalIdentity: string;
  snapshotDigest: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PublishedCatalogGeneration> {
  const location = resolveCatalogGenerationLocation(options);
  return validateGenerationDirectory({
    generationDir: location.generationDir,
    logicalIdentity: options.logicalIdentity,
    snapshotDigest: options.snapshotDigest,
  });
}
