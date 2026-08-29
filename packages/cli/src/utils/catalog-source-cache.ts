import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { CatalogSourceId, CliVersion, SourceIdentity } from '../types.js';
import { checkAwCapabilitySupport, normalizeAwCapabilities } from './manifest.js';
import { canonicalizePathThroughExistingAncestorSync, resolveAwHome } from './state-paths.js';
import { validateCatalogSnapshotTransport, type CatalogSnapshotValidation } from './catalog-snapshot.js';
import { IMPLEMENTED_AW_CAPABILITIES } from '../commands/aw-capabilities.js';
import { CatalogProviderCompatibilityError } from './catalog-public-error.js';

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_IDENTITY_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|path:sha256:[0-9a-f]{64})$/;

export interface CatalogSourceCacheMetadata {
  schemaVersion: 2;
  entryKey: string;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  resolvedCommit: string;
  manifestDigest: string;
  snapshotDigest: string;
  requiredCapabilities: string[];
  validatedAt: string;
}

export interface CatalogSourceCacheEntry {
  entryDir: string;
  snapshotRoot: string;
  metadata: CatalogSourceCacheMetadata;
  validation: CatalogSnapshotValidation;
}

export interface CatalogSourceCacheLocation {
  awHomeDir: string;
  cacheRootDir: string;
  rootDir: string;
  currentDir: string;
  lastGoodDir: string;
}

interface PublishCatalogSourceCacheEntryOptions {
  location: CatalogSourceCacheLocation;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  cliVersion: CliVersion;
  resolvedCommit: string;
  snapshotRoot: string;
  validation: CatalogSnapshotValidation;
  signal?: AbortSignal;
}

const publicationTails = new Map<string, Promise<void>>();

function digestJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function assertCacheIdentity(sourceId: CatalogSourceId, sourceIdentity: SourceIdentity): void {
  if (!SOURCE_ID_PATTERN.test(sourceId) || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)) {
    throw new Error('Invalid catalog source cache identity.');
  }
}

function isStrictObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');
}

function parseMetadata(value: unknown): CatalogSourceCacheMetadata | null {
  if (!isStrictObject(value, [
    'schemaVersion', 'entryKey', 'sourceId', 'sourceIdentity', 'requestedRef',
    'resolvedCommit', 'manifestDigest', 'snapshotDigest', 'requiredCapabilities', 'validatedAt',
  ])) return null;
  if (
    value.schemaVersion !== 2
    || typeof value.entryKey !== 'string' || !/^[0-9a-f]{64}$/.test(value.entryKey)
    || typeof value.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(value.sourceId)
    || typeof value.sourceIdentity !== 'string' || !SOURCE_IDENTITY_PATTERN.test(value.sourceIdentity)
    || typeof value.requestedRef !== 'string' || value.requestedRef.length === 0
    || typeof value.resolvedCommit !== 'string' || !COMMIT_IDENTITY_PATTERN.test(value.resolvedCommit)
    || typeof value.manifestDigest !== 'string' || !SOURCE_IDENTITY_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string' || !SOURCE_IDENTITY_PATTERN.test(value.snapshotDigest)
    || !Array.isArray(value.requiredCapabilities)
    || typeof value.validatedAt !== 'string' || Number.isNaN(Date.parse(value.validatedAt))
  ) return null;
  const requiredCapabilities = (() => {
    try {
      return normalizeAwCapabilities(value.requiredCapabilities);
    } catch {
      return null;
    }
  })();
  if (
    requiredCapabilities === null
    || JSON.stringify(requiredCapabilities) !== JSON.stringify(value.requiredCapabilities)
  ) return null;
  return value as unknown as CatalogSourceCacheMetadata;
}

function resolveCatalogSourceCacheLocation(options: {
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  env?: NodeJS.ProcessEnv;
}): CatalogSourceCacheLocation {
  assertCacheIdentity(options.sourceId, options.sourceIdentity);
  const awHomeDir = canonicalizePathThroughExistingAncestorSync(resolveAwHome(options.env ?? process.env));
  const cacheRootDir = path.join(awHomeDir, 'catalog-cache');
  const rootDir = path.join(cacheRootDir, 'sources', options.sourceId);
  return {
    awHomeDir,
    cacheRootDir,
    rootDir,
    currentDir: path.join(rootDir, 'current'),
    lastGoodDir: path.join(rootDir, 'last-good'),
  };
}

async function ensureRegularDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Catalog source cache path must be a regular directory: ${directory}`);
    }
    return;
  }
  await fs.mkdir(directory).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
    const concurrent = await fs.lstat(directory);
    if (!concurrent.isDirectory() || concurrent.isSymbolicLink()) throw error;
  });
}

async function ensureCatalogSourceCacheLocation(location: CatalogSourceCacheLocation): Promise<void> {
  for (const directory of [
    location.awHomeDir, location.cacheRootDir, path.join(location.cacheRootDir, 'sources'), location.rootDir,
  ]) await ensureRegularDirectory(directory);
}

async function readSnapshotAt(options: {
  entryDir: string;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  cliVersion: CliVersion;
  signal?: AbortSignal;
}): Promise<CatalogSourceCacheEntry | null> {
  try {
    throwIfAborted(options.signal);
    const entryStat = await fs.lstat(options.entryDir);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) return null;
    const metadataPath = path.join(options.entryDir, 'metadata.json');
    const snapshotRoot = path.join(options.entryDir, 'snapshot');
    const metadataStat = await fs.lstat(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) return null;
    const metadata = parseMetadata(await fs.readJson(metadataPath));
    if (
      !metadata || metadata.sourceId !== options.sourceId
      || metadata.sourceIdentity !== options.sourceIdentity
      || metadata.requestedRef !== options.requestedRef
    ) return null;
    const expectedKey = digestJson({
      sourceId: metadata.sourceId,
      sourceIdentity: metadata.sourceIdentity,
      requestedRef: metadata.requestedRef,
      resolvedCommit: metadata.resolvedCommit,
      manifestDigest: metadata.manifestDigest,
      snapshotDigest: metadata.snapshotDigest,
      requiredCapabilities: metadata.requiredCapabilities,
    });
    if (metadata.entryKey !== expectedKey) return null;
    const validation = await validateCatalogSnapshotTransport(snapshotRoot);
    if (
      validation.manifestDigest !== metadata.manifestDigest
      || validation.snapshotDigest !== metadata.snapshotDigest
      || JSON.stringify(validation.manifest.requires.aw.capabilities ?? [])
        !== JSON.stringify(metadata.requiredCapabilities)
    ) return null;
    const support = checkAwCapabilitySupport(metadata.requiredCapabilities, IMPLEMENTED_AW_CAPABILITIES);
    if (!support.supported) {
      throw new CatalogProviderCompatibilityError({
        sourceId: options.sourceId,
        requiredCapabilities: metadata.requiredCapabilities,
        missingCapabilities: support.missing,
        availableCapabilities: IMPLEMENTED_AW_CAPABILITIES,
      });
    }
    throwIfAborted(options.signal);
    return { entryDir: options.entryDir, snapshotRoot, metadata, validation };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (options.signal?.aborted) throw error;
    if (error instanceof CatalogProviderCompatibilityError) throw error;
    return null;
  }
}

async function readCatalogSourceCache(options: {
  location: CatalogSourceCacheLocation;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  cliVersion: CliVersion;
  signal?: AbortSignal;
}): Promise<CatalogSourceCacheEntry | null> {
  assertCacheIdentity(options.sourceId, options.sourceIdentity);
  const common = {
    sourceId: options.sourceId, sourceIdentity: options.sourceIdentity,
    requestedRef: options.requestedRef, cliVersion: options.cliVersion, signal: options.signal,
  };
  return await readSnapshotAt({ ...common, entryDir: options.location.currentDir })
    ?? await readSnapshotAt({ ...common, entryDir: options.location.lastGoodDir });
}

async function withCatalogSourceCachePublication<T>(
  rootDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = publicationTails.get(rootDir) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  publicationTails.set(rootDir, tail);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (publicationTails.get(rootDir) === tail) publicationTails.delete(rootDir);
  }
}

async function publishCatalogSourceCacheEntry(
  options: PublishCatalogSourceCacheEntryOptions,
): Promise<CatalogSourceCacheEntry> {
  return withCatalogSourceCachePublication(options.location.rootDir, () =>
    publishCatalogSourceCacheEntryUnlocked(options));
}

async function publishCatalogSourceCacheEntryUnlocked(
  options: PublishCatalogSourceCacheEntryOptions,
): Promise<CatalogSourceCacheEntry> {
  assertCacheIdentity(options.sourceId, options.sourceIdentity);
  if (options.requestedRef.length === 0 || !COMMIT_IDENTITY_PATTERN.test(options.resolvedCommit)) {
    throw new Error('Invalid catalog source cache snapshot identity.');
  }
  await ensureCatalogSourceCacheLocation(options.location);
  const candidateDir = path.join(options.location.rootDir, `.candidate-${crypto.randomUUID()}.tmp`);
  const replacedLastGood = path.join(options.location.rootDir, `.last-good-${crypto.randomUUID()}.tmp`);
  const replacedCurrent = path.join(options.location.rootDir, `.current-${crypto.randomUUID()}.tmp`);
  const candidateSnapshotRoot = path.join(candidateDir, 'snapshot');
  let currentMoved = false;
  let oldLastGoodMoved = false;
  let invalidCurrentMoved = false;
  let candidateInstalled = false;
  let committed = false;
  try {
    await fs.mkdir(candidateDir);
    await fs.copy(options.snapshotRoot, candidateSnapshotRoot, { dereference: false, preserveTimestamps: true });
    const validation = await validateCatalogSnapshotTransport(candidateSnapshotRoot);
    throwIfAborted(options.signal);
    if (
      validation.manifestDigest !== options.validation.manifestDigest
      || validation.snapshotDigest !== options.validation.snapshotDigest
      || JSON.stringify(validation.manifest.requires.aw.capabilities ?? [])
        !== JSON.stringify(options.validation.manifest.requires.aw.capabilities ?? [])
    ) throw new Error('Catalog snapshot changed before cache publication.');
    const identity = {
      sourceId: options.sourceId, sourceIdentity: options.sourceIdentity,
      requestedRef: options.requestedRef, resolvedCommit: options.resolvedCommit,
      manifestDigest: validation.manifestDigest, snapshotDigest: validation.snapshotDigest,
      requiredCapabilities: normalizeAwCapabilities(validation.manifest.requires.aw.capabilities ?? []),
    };
    const metadata: CatalogSourceCacheMetadata = {
      schemaVersion: 2, entryKey: digestJson(identity), ...identity, validatedAt: new Date().toISOString(),
    };
    await fs.writeJson(path.join(candidateDir, 'metadata.json'), metadata, { spaces: 2 });
    throwIfAborted(options.signal);

    const current = await readSnapshotAt({
      entryDir: options.location.currentDir,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      requestedRef: options.requestedRef,
      cliVersion: options.cliVersion,
      signal: options.signal,
    });
    if (current) {
      if (await fs.pathExists(options.location.lastGoodDir)) {
        await fs.rename(options.location.lastGoodDir, replacedLastGood);
        oldLastGoodMoved = true;
      }
      await fs.rename(options.location.currentDir, options.location.lastGoodDir);
      currentMoved = true;
    } else if (await fs.pathExists(options.location.currentDir)) {
      await fs.rename(options.location.currentDir, replacedCurrent);
      invalidCurrentMoved = true;
    }
    await fs.rename(candidateDir, options.location.currentDir);
    candidateInstalled = true;
    const published = await readSnapshotAt({
      entryDir: options.location.currentDir,
      sourceId: options.sourceId,
      sourceIdentity: options.sourceIdentity,
      requestedRef: options.requestedRef,
      cliVersion: options.cliVersion,
      signal: options.signal,
    });
    if (!published) throw new Error('Published catalog source cache snapshot did not validate.');
    committed = true;
    return published;
  } catch (error) {
    if (candidateInstalled) {
      await fs.remove(options.location.currentDir).catch(() => undefined);
    }
    if (!await fs.pathExists(options.location.currentDir) && currentMoved) {
      await fs.rename(options.location.lastGoodDir, options.location.currentDir).catch(() => undefined);
    }
    if (oldLastGoodMoved && !await fs.pathExists(options.location.lastGoodDir)) {
      await fs.rename(replacedLastGood, options.location.lastGoodDir).catch(() => undefined);
    }
    if (!await fs.pathExists(options.location.currentDir) && invalidCurrentMoved) {
      await fs.rename(replacedCurrent, options.location.currentDir).catch(() => undefined);
    }
    throw error;
  } finally {
    await fs.remove(candidateDir).catch(() => undefined);
    if (committed) {
      await fs.remove(replacedLastGood).catch(() => undefined);
      await fs.remove(replacedCurrent).catch(() => undefined);
    }
  }
}

export async function cleanupLegacyCatalogSourceCache(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const cacheRoot = path.join(canonicalizePathThroughExistingAncestorSync(resolveAwHome(env)), 'catalog-cache');
  const warnings: string[] = [];
  const cacheRootStat = await fs.lstat(cacheRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    warnings.push('旧 Catalog cache 根检查失败。');
    return undefined;
  });
  if (cacheRootStat === undefined || cacheRootStat === null) return warnings;
  if (!cacheRootStat.isDirectory() || cacheRootStat.isSymbolicLink()) {
    warnings.push('旧 Catalog cache 根不是普通目录，已跳过清理。');
    return warnings;
  }
  for (const name of ['entries', 'selectors', 'observations', 'locks', 'quarantine', 'observation-order.json']) {
    try {
      await fs.remove(path.join(cacheRoot, name));
    } catch {
      warnings.push(`旧 Catalog cache 布局清理失败：${name}`);
    }
  }
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true }).catch(() => {
    warnings.push('旧 Catalog cache 根读取失败。');
    return [];
  });
  for (const entry of entries) {
    if (entry.name === 'sources' || !SOURCE_ID_PATTERN.test(entry.name)) continue;
    try {
      await fs.remove(path.join(cacheRoot, entry.name));
    } catch {
      warnings.push(`旧 Catalog cache 来源布局清理失败：${entry.name}`);
    }
  }
  return warnings;
}

/** @internal Minimal cache bridge for catalog providers and cache behavior tests. */
export const catalogSourceCacheInternal = {
  ensureCatalogSourceCacheLocation,
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  resolveCatalogSourceCacheLocation,
};
