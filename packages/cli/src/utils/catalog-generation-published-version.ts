import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { CATALOG_PUBLISHED_VERSIONS_DIRECTORY } from '../constants.js';
import { CatalogGenerationError } from './catalog-generation-error.js';
import { parseStrictSemVer } from './manifest.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export interface CatalogPublishedVersionV1 {
  schemaVersion: 1;
  logicalIdentity: string;
  catalogVersion: string;
  snapshotDigest: string;
  firstObservedAt: string;
}

function immutableVersionError(options: {
  sourceId: string;
  catalogVersion: string;
  cause?: unknown;
}): CatalogGenerationError {
  return new CatalogGenerationError({
    code: 'catalogImmutableVersionViolation',
    sourceId: options.sourceId,
    message: `Catalog source "${options.sourceId}" cannot use version ${options.catalogVersion} because its immutable version record is damaged or binds different content. Publish a higher Catalog version and refresh again.`,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

function isStrictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validateRecord(options: {
  value: unknown;
  logicalIdentity: string;
  catalogVersion: string;
  snapshotDigest: string;
  sourceId: string;
}): CatalogPublishedVersionV1 {
  const value = options.value;
  if (!isStrictObject(value, [
    'schemaVersion',
    'logicalIdentity',
    'catalogVersion',
    'snapshotDigest',
    'firstObservedAt',
  ])
    || value.schemaVersion !== 1
    || value.logicalIdentity !== options.logicalIdentity
    || value.catalogVersion !== options.catalogVersion
    || value.snapshotDigest !== options.snapshotDigest
    || typeof value.firstObservedAt !== 'string'
    || Number.isNaN(Date.parse(value.firstObservedAt))) {
    throw immutableVersionError(options);
  }
  return value as unknown as CatalogPublishedVersionV1;
}

export function resolveCatalogPublishedVersionPath(options: {
  logicalIdentity: string;
  catalogVersion: string;
  env?: NodeJS.ProcessEnv;
}): string {
  if (typeof options.logicalIdentity !== 'string' || options.logicalIdentity.trim() === '') {
    throw new Error('Invalid Catalog logical identity.');
  }
  parseStrictSemVer(options.catalogVersion, 'Catalog published version');
  const awHome = canonicalizePathThroughExistingAncestorSync(
    resolveAwHome(options.env ?? process.env),
  );
  const identityHex = crypto.createHash('sha256').update(options.logicalIdentity).digest('hex');
  return path.join(
    awHome,
    CATALOG_PUBLISHED_VERSIONS_DIRECTORY,
    identityHex,
    `${options.catalogVersion}.json`,
  );
}

async function readExistingRecord(options: {
  recordPath: string;
  logicalIdentity: string;
  catalogVersion: string;
  snapshotDigest: string;
  sourceId: string;
}): Promise<CatalogPublishedVersionV1 | undefined> {
  const stat = await fs.lstat(options.recordPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw immutableVersionError(options);
  try {
    return validateRecord({
      ...options,
      value: await fs.readJson(options.recordPath),
    });
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw immutableVersionError({ ...options, cause: error });
  }
}

export async function assertCatalogPublishedVersion(options: {
  logicalIdentity: string;
  catalogVersion: string;
  snapshotDigest: string;
  firstObservedAt: string;
  sourceId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<CatalogPublishedVersionV1> {
  if (!SHA256_DIGEST_PATTERN.test(options.snapshotDigest)
    || Number.isNaN(Date.parse(options.firstObservedAt))) {
    throw immutableVersionError(options);
  }
  const recordPath = resolveCatalogPublishedVersionPath(options);
  const parentDir = path.dirname(recordPath);
  const stagingPath = path.join(parentDir, `.staging-${crypto.randomUUID()}.tmp`);
  try {
    await ensureRegularDirectoryPath(parentDir, 'Catalog published version directory');
    const existing = await readExistingRecord({ ...options, recordPath });
    if (existing) return existing;
    const record: CatalogPublishedVersionV1 = {
      schemaVersion: 1,
      logicalIdentity: options.logicalIdentity,
      catalogVersion: options.catalogVersion,
      snapshotDigest: options.snapshotDigest,
      firstObservedAt: options.firstObservedAt,
    };
    await fs.writeFile(stagingPath, `${JSON.stringify(record, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    try {
      await fs.link(stagingPath, recordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const published = await readExistingRecord({ ...options, recordPath });
    if (!published) throw immutableVersionError(options);
    return published;
  } catch (error) {
    if (error instanceof CatalogGenerationError) throw error;
    throw immutableVersionError({ ...options, cause: error });
  } finally {
    await fs.remove(stagingPath).catch(() => undefined);
  }
}
