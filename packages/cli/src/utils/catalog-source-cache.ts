import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import path from 'node:path';

import fs from 'fs-extra';

import type { CatalogSourceId, CliVersion, SourceIdentity } from '../types.js';
import { compareStrictSemVer } from './manifest.js';
import { acquireProcessLock, type ProcessLockLease } from './process-lock.js';
import {
  canonicalizePathThroughExistingAncestorSync,
  ensureRegularDirectoryPath,
  resolveAwHome,
} from './state-paths.js';
import {
  validateCatalogSnapshot,
  type CatalogSnapshotValidation,
} from './catalog-snapshot.js';

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SOURCE_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMIT_IDENTITY_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|path:sha256:[0-9a-f]{64})$/;
const MAX_OBSERVATION_FUTURE_SKEW = 60_000_000;
const TRANSIENT_WINDOWS_RELEASE_CODES = new Set(['EBUSY', 'EPERM']);

interface SharedCatalogCacheLease {
  controller: AbortController;
  lease: Promise<ProcessLockLease>;
  waiters: number;
  users: number;
  cleanupPromise?: Promise<void>;
}

interface CatalogCacheCommitContext {
  parent?: CatalogCacheCommitContext;
  durableCommit: boolean;
}

const sharedCatalogCacheLeases = new Map<string, SharedCatalogCacheLease>();
const catalogCacheCommitStorage = new AsyncLocalStorage<CatalogCacheCommitContext>();
let catalogCacheBeforeReleaseHookForTests:
  | ((lockPath: string, attempt: number) => Promise<void>)
  | undefined;
let catalogCacheAfterRootLeaseAcquireHookForTests:
  | ((lockPath: string) => Promise<void>)
  | undefined;

function isTransientWindowsReleaseError(error: unknown): boolean {
  return TRANSIENT_WINDOWS_RELEASE_CODES.has((error as NodeJS.ErrnoException).code ?? '');
}

function isOperationalCacheReadError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES'
    || code === 'EBUSY'
    || code === 'EIO'
    || code === 'EMFILE'
    || code === 'ENFILE'
    || code === 'EPERM';
}

function markCatalogCacheDurableCommit(): void {
  let context = catalogCacheCommitStorage.getStore();
  while (context) {
    context.durableCommit = true;
    context = context.parent;
  }
}

function emitCatalogCacheReleaseWarning(
  message: string,
  code: string,
): void {
  try {
    process.emitWarning(message, { code });
  } catch {
    // Diagnostics cannot replace the action result or primary action error.
  }
}

async function releaseCatalogCacheLease(lease: ProcessLockLease): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await catalogCacheBeforeReleaseHookForTests?.(lease.lockPath, attempt);
      await lease.release();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isTransientWindowsReleaseError(error)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    await lease.release();
  } catch {
    // Keep the first diagnostic. A later invocation can retry the same live lease.
  }
  throw lastError;
}

async function acquireCatalogSourceRootLease(
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<ProcessLockLease> {
  const awHome = canonicalizePathThroughExistingAncestorSync(resolveAwHome(env));
  const coordinationRoot = path.join(path.dirname(awHome), '.aw-catalog-source-coordination');
  await ensureRegularDirectoryPath(coordinationRoot, 'Catalog source coordination root');
  const lease = await acquireProcessLock({
    lockPath: path.join(coordinationRoot, `${digestJson({ awHome })}.lock`),
    signal,
  });
  try {
    await catalogCacheAfterRootLeaseAcquireHookForTests?.(lease.lockPath);
  } catch (error) {
    await lease.release();
    throw error;
  }
  return lease;
}

export interface CatalogSourceCacheMetadata {
  schemaVersion: 1;
  entryKey: string;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  resolvedCommit: string;
  manifestDigest: string;
  snapshotDigest: string;
  minAwVersion: CliVersion;
  observedAt: number;
  validatedAt: string;
}

interface CatalogSourceSelectorIndex {
  schemaVersion: 1;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  entryKey: string;
  observationOrder: number;
}

interface CatalogSourceObservationRecord {
  schemaVersion: 1;
  observationOrder: number;
  entryKey: string;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
}

interface CatalogSourceObservationCounter {
  schemaVersion: 1;
  lastOrder: number;
}

interface CatalogSourceObjectFault {
  schemaVersion: 1;
  faultedAt: string;
  reason: string;
}

class CatalogSourceObjectFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSourceObjectFaultError';
  }
}

export interface CatalogSourceCacheEntry {
  entryDir: string;
  snapshotRoot: string;
  metadata: CatalogSourceCacheMetadata;
  validation: CatalogSnapshotValidation;
}

export interface CatalogSourceCacheLocation {
  awHomeDir: string;
  rootDir: string;
  objectsDir: string;
  entriesDir: string;
  observationsDir: string;
  selectorsDir: string;
  locksDir: string;
  objectsFaultPath: string;
  quarantineDir: string;
}

async function withCatalogSourceCacheLease<T>(options: {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  action: () => Promise<T>;
}): Promise<T> {
  const env = options.env ?? process.env;
  const key = canonicalizePathThroughExistingAncestorSync(resolveAwHome(env));
  let shared = sharedCatalogCacheLeases.get(key);
  if (!shared) {
    const controller = new AbortController();
    shared = {
      controller,
      lease: acquireCatalogSourceRootLease(env, controller.signal),
      waiters: 0,
      users: 0,
    };
    sharedCatalogCacheLeases.set(key, shared);
    void shared.lease.catch(() => undefined);
  }
  shared.waiters += 1;
  const commitContext: CatalogCacheCommitContext = {
    parent: catalogCacheCommitStorage.getStore(),
    durableCommit: false,
  };
  let activeUser = false;
  let result: T | undefined;
  let actionError: unknown;
  let actionSucceeded = false;
  try {
    await waitForSharedCatalogCacheLease(shared.lease, options.signal);
    shared.waiters -= 1;
    shared.users += 1;
    activeUser = true;
    result = await catalogCacheCommitStorage.run(commitContext, options.action);
    actionSucceeded = true;
  } catch (error) {
    actionError = error;
  }
  if (activeUser) {
    shared.users -= 1;
  } else {
    shared.waiters -= 1;
  }
  try {
    await cleanupSharedCatalogCacheLease({
      key,
      shared,
      abortPendingAcquire: !activeUser && options.signal?.aborted === true,
    });
  } catch (releaseError) {
    if (!actionSucceeded) {
      emitCatalogCacheReleaseWarning(
        'Catalog cache action failed, and its root lock release also failed.',
        'AW_CATALOG_CACHE_ROOT_LOCK_RELEASE_FAILED',
      );
      throw actionError;
    }
    if (commitContext.durableCommit) {
      emitCatalogCacheReleaseWarning(
        'Catalog cache action completed successfully, but its root lock could not be released after 3 attempts. The explicitly committed selector or config remains successful; the lock can require process exit or manual recovery before another update.',
        'AW_CATALOG_CACHE_ROOT_LOCK_RELEASE_FAILED',
      );
    } else {
      throw releaseError;
    }
  }
  if (!actionSucceeded) throw actionError;
  return result as T;
}

async function waitForSharedCatalogCacheLease(
  lease: Promise<ProcessLockLease>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) {
    await lease;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      try { throwIfAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    void lease.then(
      () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

async function cleanupSharedCatalogCacheLease(options: {
  key: string;
  shared: SharedCatalogCacheLease;
  abortPendingAcquire: boolean;
}): Promise<void> {
  const { key, shared } = options;
  if (shared.waiters !== 0 || shared.users !== 0) return;
  if (sharedCatalogCacheLeases.get(key) === shared) {
    sharedCatalogCacheLeases.delete(key);
  }
  if (options.abortPendingAcquire && !shared.controller.signal.aborted) {
    const error = new Error('Catalog cache lease acquisition has no remaining waiters.');
    error.name = 'AbortError';
    shared.controller.abort(error);
  }
  shared.cleanupPromise ??= (async () => {
    let lease: ProcessLockLease;
    try {
      lease = await shared.lease;
    } catch {
      return;
    }
    await releaseCatalogCacheLease(lease);
  })();
  await shared.cleanupPromise;
}

function digestJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('Catalog source cache publication aborted.');
  error.name = 'AbortError';
  throw error;
}

function assertCacheIdentity(sourceId: CatalogSourceId, sourceIdentity: SourceIdentity): void {
  if (!SOURCE_ID_PATTERN.test(sourceId) || !SOURCE_IDENTITY_PATTERN.test(sourceIdentity)) {
    throw new Error('Invalid catalog source cache identity.');
  }
}

async function lstatIfExists(filePath: string): Promise<Stats | null> {
  return fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

function resolveCatalogSourceCacheLocation(options: {
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  env?: NodeJS.ProcessEnv;
}): CatalogSourceCacheLocation {
  assertCacheIdentity(options.sourceId, options.sourceIdentity);
  const awHomeDir = canonicalizePathThroughExistingAncestorSync(
    resolveAwHome(options.env ?? process.env),
  );
  const rootDir = path.join(
    awHomeDir,
    'catalog-cache',
    options.sourceId,
    options.sourceIdentity.replace(':', '-'),
  );
  return {
    awHomeDir,
    rootDir,
    objectsDir: path.join(rootDir, 'objects.git'),
    entriesDir: path.join(rootDir, 'entries'),
    observationsDir: path.join(rootDir, 'observations'),
    selectorsDir: path.join(rootDir, 'selectors'),
    locksDir: path.join(rootDir, 'locks'),
    objectsFaultPath: path.join(rootDir, 'locks', 'objects.fault.json'),
    quarantineDir: path.join(rootDir, 'quarantine'),
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
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrent = await fs.lstat(directory);
    if (!concurrent.isDirectory() || concurrent.isSymbolicLink()) {
      throw new Error(`Catalog source cache path must be a regular directory: ${directory}`);
    }
  }
}

async function ensureCatalogSourceCacheLocation(
  location: CatalogSourceCacheLocation,
): Promise<void> {
  return withCatalogSourceCacheLease({
    env: { ...process.env, AW_HOME: location.awHomeDir },
    action: () => ensureCatalogSourceCacheLocationWithLease(location),
  });
}

async function ensureCatalogSourceCacheLocationWithLease(
  location: CatalogSourceCacheLocation,
): Promise<void> {
  const directories = [
    location.awHomeDir,
    path.join(location.awHomeDir, 'catalog-cache'),
    path.dirname(location.rootDir),
    location.rootDir,
  ];
  for (const directory of directories) await ensureRegularDirectory(directory);
  for (const directory of [
    location.entriesDir,
    location.observationsDir,
    location.selectorsDir,
    location.locksDir,
    location.quarantineDir,
  ]) {
    const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`Catalog source cache path must be a regular directory: ${directory}`);
    }
  }
}

function selectorPath(location: CatalogSourceCacheLocation, requestedRef: string): string {
  return path.join(location.selectorsDir, `${digestJson({ requestedRef })}.json`);
}

function observationCounterPath(location: CatalogSourceCacheLocation): string {
  return path.join(location.rootDir, 'observation-order.json');
}

function observationRecordPath(
  location: CatalogSourceCacheLocation,
  observationOrder: number,
): string {
  return path.join(location.observationsDir, `${observationOrder}.json`);
}

function isStrictObject(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');
}

function parseMetadata(value: unknown): CatalogSourceCacheMetadata | null {
  if (!isStrictObject(value, [
    'schemaVersion',
    'entryKey',
    'sourceId',
    'sourceIdentity',
    'requestedRef',
    'resolvedCommit',
    'manifestDigest',
    'snapshotDigest',
    'minAwVersion',
    'observedAt',
    'validatedAt',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.entryKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.entryKey)
    || typeof value.sourceId !== 'string'
    || !SOURCE_ID_PATTERN.test(value.sourceId)
    || typeof value.sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(value.sourceIdentity)
    || typeof value.requestedRef !== 'string'
    || value.requestedRef.length === 0
    || typeof value.resolvedCommit !== 'string'
    || !COMMIT_IDENTITY_PATTERN.test(value.resolvedCommit)
    || typeof value.manifestDigest !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(value.manifestDigest)
    || typeof value.snapshotDigest !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(value.snapshotDigest)
    || typeof value.minAwVersion !== 'string'
    || typeof value.observedAt !== 'number'
    || !Number.isSafeInteger(value.observedAt)
    || typeof value.validatedAt !== 'string'
    || Number.isNaN(Date.parse(value.validatedAt))
  ) return null;
  return value as unknown as CatalogSourceCacheMetadata;
}

function parseSelector(value: unknown): CatalogSourceSelectorIndex | null {
  if (!isStrictObject(value, [
    'schemaVersion',
    'sourceId',
    'sourceIdentity',
    'requestedRef',
    'entryKey',
    'observationOrder',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.sourceId !== 'string'
    || !SOURCE_ID_PATTERN.test(value.sourceId)
    || typeof value.sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(value.sourceIdentity)
    || typeof value.requestedRef !== 'string'
    || value.requestedRef.length === 0
    || typeof value.entryKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.entryKey)
    || typeof value.observationOrder !== 'number'
    || !Number.isSafeInteger(value.observationOrder)
    || value.observationOrder < 1
  ) return null;
  return value as unknown as CatalogSourceSelectorIndex;
}

function parseObservationCounter(value: unknown): CatalogSourceObservationCounter | null {
  if (!isStrictObject(value, ['schemaVersion', 'lastOrder'])) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.lastOrder !== 'number'
    || !Number.isSafeInteger(value.lastOrder)
    || value.lastOrder <= 0
    || value.lastOrder > Date.now() * 1_000 + MAX_OBSERVATION_FUTURE_SKEW
  ) return null;
  return value as unknown as CatalogSourceObservationCounter;
}

function parseObservationRecord(value: unknown): CatalogSourceObservationRecord | null {
  if (!isStrictObject(value, [
    'schemaVersion',
    'observationOrder',
    'entryKey',
    'sourceId',
    'sourceIdentity',
    'requestedRef',
  ])) return null;
  if (
    value.schemaVersion !== 1
    || typeof value.observationOrder !== 'number'
    || !Number.isSafeInteger(value.observationOrder)
    || value.observationOrder < 1
    || typeof value.entryKey !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.entryKey)
    || typeof value.sourceId !== 'string'
    || !SOURCE_ID_PATTERN.test(value.sourceId)
    || typeof value.sourceIdentity !== 'string'
    || !SOURCE_IDENTITY_PATTERN.test(value.sourceIdentity)
    || typeof value.requestedRef !== 'string'
    || value.requestedRef.length === 0
  ) return null;
  return value as unknown as CatalogSourceObservationRecord;
}

async function withCatalogSourceCacheLock<T>(options: {
  location: CatalogSourceCacheLocation;
  name: 'objects' | 'publication';
  timeoutMs?: number;
  signal?: AbortSignal;
  retainLockOnError?: (error: unknown) => boolean;
  action: () => Promise<T>;
}): Promise<T> {
  return withCatalogSourceCacheLease({
    env: { ...process.env, AW_HOME: options.location.awHomeDir },
    signal: options.signal,
    action: () => withCatalogSourceCacheLockWithLease(options),
  });
}

async function withCatalogSourceCacheLockWithLease<T>(options: {
  location: CatalogSourceCacheLocation;
  name: 'objects' | 'publication';
  timeoutMs?: number;
  signal?: AbortSignal;
  retainLockOnError?: (error: unknown) => boolean;
  action: () => Promise<T>;
}): Promise<T> {
  await ensureCatalogSourceCacheLocationWithLease(options.location);
  await fs.ensureDir(options.location.locksDir);
  const lease = await acquireProcessLock({
    lockPath: path.join(options.location.locksDir, `${options.name}.lock`),
    timeoutMs: options.timeoutMs ?? 10_000,
    signal: options.signal,
    persistentFaultPath: options.name === 'objects'
      ? options.location.objectsFaultPath
      : undefined,
  });
  let retainLock = false;
  let result: T | undefined;
  let actionError: unknown;
  let actionSucceeded = false;
  const commitContext: CatalogCacheCommitContext = {
    parent: catalogCacheCommitStorage.getStore(),
    durableCommit: false,
  };
  try {
    if (options.name === 'objects') {
      await assertCatalogSourceObjectCacheHealthy(options.location);
    }
    throwIfAborted(options.signal);
    result = await catalogCacheCommitStorage.run(commitContext, options.action);
    actionSucceeded = true;
  } catch (error) {
    retainLock = error instanceof CatalogSourceObjectFaultError
      || options.retainLockOnError?.(error) === true;
    actionError = error;
  }
  if (!retainLock) {
    try {
      await releaseCatalogCacheLease(lease);
    } catch (releaseError) {
      if (!actionSucceeded) {
        emitCatalogCacheReleaseWarning(
          'Catalog cache action failed, and its named lock release also failed.',
          'AW_CATALOG_CACHE_LOCK_RELEASE_FAILED',
        );
        throw actionError;
      }
      if (commitContext.durableCommit) {
        emitCatalogCacheReleaseWarning(
          'Catalog cache action completed successfully, but its named lock could not be released after 3 attempts. The explicitly committed selector or config remains successful; the lock can require process exit or manual recovery before another update.',
          'AW_CATALOG_CACHE_LOCK_RELEASE_FAILED',
        );
      } else {
        throw releaseError;
      }
    }
  }
  if (!actionSucceeded) throw actionError;
  return result as T;
}

async function assertCatalogSourceObjectCacheHealthy(
  location: CatalogSourceCacheLocation,
): Promise<void> {
  return withCatalogSourceCacheLease({
    env: { ...process.env, AW_HOME: location.awHomeDir },
    action: () => assertCatalogSourceObjectCacheHealthyWithLease(location),
  });
}

async function assertCatalogSourceObjectCacheHealthyWithLease(
  location: CatalogSourceCacheLocation,
): Promise<void> {
  const stat = await fs.lstat(location.objectsFaultPath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  if (!stat) return;
  throw new CatalogSourceObjectFaultError(
    'Catalog Git object cache has a persistent cleanup fault; remove this source cache or fault marker manually before retrying.',
  );
}

async function persistCatalogSourceObjectFault(options: {
  location: CatalogSourceCacheLocation;
  reason: string;
}): Promise<void> {
  return withCatalogSourceCacheLease({
    env: { ...process.env, AW_HOME: options.location.awHomeDir },
    action: () => persistCatalogSourceObjectFaultWithLease(options),
  });
}

async function persistCatalogSourceObjectFaultWithLease(options: {
  location: CatalogSourceCacheLocation;
  reason: string;
}): Promise<void> {
  await ensureCatalogSourceCacheLocationWithLease(options.location);
  await fs.ensureDir(options.location.locksDir);
  if (await lstatIfExists(options.location.objectsFaultPath)) return;
  try {
    await atomicWriteJson(options.location.objectsFaultPath, {
      schemaVersion: 1,
      faultedAt: new Date().toISOString(),
      reason: options.reason,
    } satisfies CatalogSourceObjectFault);
  } catch (error) {
    if (await lstatIfExists(options.location.objectsFaultPath)) return;
    throw error;
  }
}

async function quarantineCacheFile(
  location: CatalogSourceCacheLocation,
  filePath: string,
  kind: 'observation' | 'selector',
): Promise<void> {
  const stat = await lstatIfExists(filePath);
  if (!stat) return;
  await fs.ensureDir(location.quarantineDir);
  await fs.rename(filePath, path.join(
    location.quarantineDir,
    `${kind}-${path.basename(filePath)}-${crypto.randomUUID()}`,
  ));
}

async function readObservationCounter(
  location: CatalogSourceCacheLocation,
): Promise<CatalogSourceObservationCounter | null> {
  const filePath = observationCounterPath(location);
  const stat = await lstatIfExists(filePath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    await quarantineCacheFile(location, filePath, 'observation');
    return null;
  }
  let raw: unknown;
  try {
    raw = await fs.readJson(filePath);
  } catch (error) {
    if (isOperationalCacheReadError(error)) throw error;
    await quarantineCacheFile(location, filePath, 'observation');
    return null;
  }
  const counter = parseObservationCounter(raw);
  if (!counter) await quarantineCacheFile(location, filePath, 'observation');
  return counter;
}

async function reserveCatalogSourceObservationOrder(options: {
  location: CatalogSourceCacheLocation;
  lockTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<number> {
  const reserved = await observeAndReserveCatalogSourceObservation({
    ...options,
    observe: async () => undefined,
  });
  return reserved.observationOrder;
}

async function observeAndReserveCatalogSourceObservation<T>(options: {
  location: CatalogSourceCacheLocation;
  lockTimeoutMs?: number;
  signal?: AbortSignal;
  observe: () => Promise<T>;
}): Promise<{ observation: T; observationOrder: number }> {
  return withCatalogSourceCacheLock({
    location: options.location,
    name: 'publication',
    timeoutMs: options.lockTimeoutMs,
    signal: options.signal,
    action: async () => {
      throwIfAborted(options.signal);
      const observation = await options.observe();
      throwIfAborted(options.signal);
      const current = await readObservationCounter(options.location);
      const nextOrder = Math.max(Date.now() * 1_000, (current?.lastOrder ?? 0) + 1);
      await atomicWriteJson(observationCounterPath(options.location), {
        schemaVersion: 1,
        lastOrder: nextOrder,
      } satisfies CatalogSourceObservationCounter, options.signal);
      return { observation, observationOrder: nextOrder };
    },
  });
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    throwIfAborted(signal);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.remove(tempPath);
    throw error;
  }
}

async function writeObservationRecord(
  location: CatalogSourceCacheLocation,
  record: CatalogSourceObservationRecord,
  signal?: AbortSignal,
): Promise<void> {
  const filePath = observationRecordPath(location, record.observationOrder);
  await fs.ensureDir(location.observationsDir);
  throwIfAborted(signal);
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
}

async function readObservationRecord(
  location: CatalogSourceCacheLocation,
  index: CatalogSourceSelectorIndex,
): Promise<CatalogSourceObservationRecord | null> {
  const filePath = observationRecordPath(location, index.observationOrder);
  const stat = await lstatIfExists(filePath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    await quarantineCacheFile(location, filePath, 'observation');
    return null;
  }
  let raw: unknown;
  try {
    raw = await fs.readJson(filePath);
  } catch (error) {
    if (isOperationalCacheReadError(error)) throw error;
    await quarantineCacheFile(location, filePath, 'observation');
    return null;
  }
  const record = parseObservationRecord(raw);
  if (!record) {
    await quarantineCacheFile(location, filePath, 'observation');
    return null;
  }
  if (
    record.observationOrder !== index.observationOrder
    || record.entryKey !== index.entryKey
    || record.sourceId !== index.sourceId
    || record.sourceIdentity !== index.sourceIdentity
    || record.requestedRef !== index.requestedRef
  ) return null;
  return record;
}

async function quarantineEntry(
  location: CatalogSourceCacheLocation,
  entryDir: string,
): Promise<void> {
  if (!await lstatIfExists(entryDir)) return;
  await fs.ensureDir(location.quarantineDir);
  const target = path.join(
    location.quarantineDir,
    `${path.basename(entryDir)}-${crypto.randomUUID()}`,
  );
  await fs.rename(entryDir, target);
}

async function readEntryAt(options: {
  location: CatalogSourceCacheLocation;
  entryKey: string;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
}): Promise<CatalogSourceCacheEntry | null> {
  const entryDir = path.join(options.location.entriesDir, options.entryKey);
  try {
    const entryStat = await fs.lstat(entryDir);
    if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
      throw new Error('Catalog source cache entry is not a regular directory.');
    }
    const completePath = path.join(entryDir, 'complete.json');
    const metadataPath = path.join(entryDir, 'metadata.json');
    const [completeStat, metadataStat] = await Promise.all([
      fs.lstat(completePath),
      fs.lstat(metadataPath),
    ]);
    if (
      !completeStat.isFile()
      || completeStat.isSymbolicLink()
      || !metadataStat.isFile()
      || metadataStat.isSymbolicLink()
    ) throw new Error('Catalog source cache entry markers must be regular files.');
    const complete = await fs.readJson(completePath);
    if (!isStrictObject(complete, ['schemaVersion']) || complete.schemaVersion !== 1) {
      throw new Error('Catalog source cache completion marker is invalid.');
    }
    const metadata = parseMetadata(await fs.readJson(metadataPath));
    if (
      !metadata
      || metadata.entryKey !== options.entryKey
      || metadata.sourceId !== options.sourceId
      || metadata.sourceIdentity !== options.sourceIdentity
      || metadata.requestedRef !== options.requestedRef
    ) throw new Error('Catalog source cache metadata mismatch.');
    const expectedKey = digestJson({
      sourceId: metadata.sourceId,
      sourceIdentity: metadata.sourceIdentity,
      requestedRef: metadata.requestedRef,
      resolvedCommit: metadata.resolvedCommit,
      manifestDigest: metadata.manifestDigest,
      snapshotDigest: metadata.snapshotDigest,
      minAwVersion: metadata.minAwVersion,
    });
    if (expectedKey !== metadata.entryKey) {
      throw new Error('Catalog source cache entry identity mismatch.');
    }
    const snapshotRoot = path.join(entryDir, 'snapshot');
    const validation = await validateCatalogSnapshot(snapshotRoot);
    if (
      validation.manifestDigest !== metadata.manifestDigest
      || validation.snapshotDigest !== metadata.snapshotDigest
      || validation.manifest.compatibility.aw.minVersion !== metadata.minAwVersion
    ) throw new Error('Catalog source cache snapshot digest mismatch.');
    return { entryDir, snapshotRoot, metadata, validation };
  } catch (error) {
    if (isOperationalCacheReadError(error)) throw error;
    await quarantineEntry(options.location, entryDir);
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
  throwIfAborted(options.signal);
  return withCatalogSourceCacheLease({
    env: { ...process.env, AW_HOME: options.location.awHomeDir },
    signal: options.signal,
    action: async () => {
      throwIfAborted(options.signal);
      const entry = await readCatalogSourceCacheWithLease(options);
      throwIfAborted(options.signal);
      return entry;
    },
  });
}

async function readCatalogSourceCacheWithLease(options: {
  location: CatalogSourceCacheLocation;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  cliVersion: CliVersion;
  signal?: AbortSignal;
}): Promise<CatalogSourceCacheEntry | null> {
  return withCatalogSourceCacheLockWithLease({
    location: options.location,
    name: 'publication',
    signal: options.signal,
    action: async () => {
      throwIfAborted(options.signal);
      const indexPath = selectorPath(options.location, options.requestedRef);
      const indexStat = await lstatIfExists(indexPath);
      if (!indexStat) return null;
      if (!indexStat.isFile() || indexStat.isSymbolicLink()) {
        await quarantineCacheFile(options.location, indexPath, 'selector');
        return null;
      }
      let rawIndex: unknown;
      try {
        rawIndex = await fs.readJson(indexPath);
      } catch (error) {
        if (isOperationalCacheReadError(error)) throw error;
        await quarantineCacheFile(options.location, indexPath, 'selector');
        return null;
      }
      const index = parseSelector(rawIndex);
      if (!index) {
        await quarantineCacheFile(options.location, indexPath, 'selector');
        return null;
      }
      const counter = await readObservationCounter(options.location);
      if (
        !counter
        || index.sourceId !== options.sourceId
        || index.sourceIdentity !== options.sourceIdentity
        || index.requestedRef !== options.requestedRef
        || index.observationOrder > counter.lastOrder
      ) {
        await quarantineCacheFile(options.location, indexPath, 'selector');
        return null;
      }
      const observation = await readObservationRecord(options.location, index);
      if (!observation) {
        await quarantineCacheFile(options.location, indexPath, 'selector');
        return null;
      }
      const entry = await readEntryAt({
        location: options.location,
        entryKey: index.entryKey,
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        requestedRef: options.requestedRef,
      });
      if (
        entry
        && compareStrictSemVer(options.cliVersion, entry.metadata.minAwVersion) < 0
      ) return null;
      throwIfAborted(options.signal);
      return entry;
    },
  });
}

async function publishCatalogSourceCacheEntry(options: {
  location: CatalogSourceCacheLocation;
  sourceId: CatalogSourceId;
  sourceIdentity: SourceIdentity;
  requestedRef: string;
  resolvedCommit: string;
  snapshotRoot: string;
  validation: CatalogSnapshotValidation;
  observationOrder: number;
  lockTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CatalogSourceCacheEntry> {
  throwIfAborted(options.signal);
  assertCacheIdentity(options.sourceId, options.sourceIdentity);
  if (
    options.requestedRef.length === 0
    || !COMMIT_IDENTITY_PATTERN.test(options.resolvedCommit)
    || !Number.isSafeInteger(options.observationOrder)
    || options.observationOrder < 1
  ) throw new Error('Invalid catalog source cache observation.');
  const identity = {
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    requestedRef: options.requestedRef,
    resolvedCommit: options.resolvedCommit,
    manifestDigest: options.validation.manifestDigest,
    snapshotDigest: options.validation.snapshotDigest,
    minAwVersion: options.validation.manifest.compatibility.aw.minVersion,
  };
  const entryKey = digestJson(identity);
  return withCatalogSourceCacheLock({
    location: options.location,
    name: 'publication',
    timeoutMs: options.lockTimeoutMs,
    signal: options.signal,
    action: async () => {
      const counter = await readObservationCounter(options.location);
      if (!counter || options.observationOrder > counter.lastOrder) {
        throw new Error('Catalog source cache observation was not reserved by this source cache.');
      }
      await fs.ensureDir(options.location.entriesDir);
      const existing = await readEntryAt({
        location: options.location,
        entryKey,
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        requestedRef: options.requestedRef,
      });
      let entry = existing;
      if (!entry) {
        const stagingDir = path.join(
          options.location.rootDir,
          `.entry-${entryKey}-${crypto.randomUUID()}.tmp`,
        );
        const snapshotRoot = path.join(stagingDir, 'snapshot');
        await fs.ensureDir(stagingDir);
        try {
          await fs.copy(options.snapshotRoot, snapshotRoot, { dereference: false, preserveTimestamps: true });
          const validation = await validateCatalogSnapshot(snapshotRoot);
          throwIfAborted(options.signal);
          if (
            validation.manifestDigest !== options.validation.manifestDigest
            || validation.snapshotDigest !== options.validation.snapshotDigest
          ) {
            throw new Error('Catalog snapshot changed before cache publication.');
          }
          const metadata: CatalogSourceCacheMetadata = {
            schemaVersion: 1,
            entryKey,
            ...identity,
            observedAt: options.observationOrder,
            validatedAt: new Date().toISOString(),
          };
          await fs.writeJson(path.join(stagingDir, 'metadata.json'), metadata, { spaces: 2 });
          await fs.writeJson(path.join(stagingDir, 'complete.json'), { schemaVersion: 1 }, { spaces: 2 });
          const entryDir = path.join(options.location.entriesDir, entryKey);
          throwIfAborted(options.signal);
          await fs.rename(stagingDir, entryDir);
          entry = { entryDir, snapshotRoot: path.join(entryDir, 'snapshot'), metadata, validation };
        } catch (error) {
          await fs.remove(stagingDir);
          throw error;
        }
      }

      throwIfAborted(options.signal);
      const indexPath = selectorPath(options.location, options.requestedRef);
      const observationRecord = {
        schemaVersion: 1,
        observationOrder: options.observationOrder,
        entryKey,
        sourceId: options.sourceId,
        sourceIdentity: options.sourceIdentity,
        requestedRef: options.requestedRef,
      } satisfies CatalogSourceObservationRecord;
      await writeObservationRecord(options.location, observationRecord, options.signal);

      const indexStat = await lstatIfExists(indexPath);
      let currentIndex: CatalogSourceSelectorIndex | null = null;
      if (indexStat?.isFile() && !indexStat.isSymbolicLink()) {
        try {
          currentIndex = parseSelector(await fs.readJson(indexPath));
        } catch (error) {
          if (isOperationalCacheReadError(error)) throw error;
        }
      }
      if (currentIndex) {
        const currentObservation = currentIndex.sourceId === options.sourceId
          && currentIndex.sourceIdentity === options.sourceIdentity
          && currentIndex.requestedRef === options.requestedRef
          && currentIndex.observationOrder <= counter.lastOrder
          ? await readObservationRecord(options.location, currentIndex)
          : null;
        const currentEntry = currentObservation
          ? await readEntryAt({
              location: options.location,
              entryKey: currentIndex.entryKey,
              sourceId: options.sourceId,
              sourceIdentity: options.sourceIdentity,
              requestedRef: options.requestedRef,
            })
          : null;
        if (!currentEntry) {
          await quarantineCacheFile(options.location, indexPath, 'selector');
          currentIndex = null;
        }
      } else if (indexStat) {
        await quarantineCacheFile(options.location, indexPath, 'selector');
      }
      if (!currentIndex || currentIndex.observationOrder < options.observationOrder) {
        await atomicWriteJson(indexPath, {
          schemaVersion: 1,
          sourceId: options.sourceId,
          sourceIdentity: options.sourceIdentity,
          requestedRef: options.requestedRef,
          entryKey,
          observationOrder: options.observationOrder,
        } satisfies CatalogSourceSelectorIndex, options.signal);
        markCatalogCacheDurableCommit();
      }
      return entry;
    },
  });
}

/** @internal Cache bridge for catalog providers and cache-focused tests. */
export const catalogSourceCacheInternal = {
  assertCatalogSourceObjectCacheHealthy,
  ensureCatalogSourceCacheLocation,
  observeAndReserveCatalogSourceObservation,
  persistCatalogSourceObjectFault,
  publishCatalogSourceCacheEntry,
  readCatalogSourceCache,
  reserveCatalogSourceObservationOrder,
  resolveCatalogSourceCacheLocation,
  withCatalogSourceCacheLease,
  withCatalogSourceCacheLock,
  markDurableCommit: markCatalogCacheDurableCommit,
  setBeforeReleaseHookForTests(hook: typeof catalogCacheBeforeReleaseHookForTests): void {
    catalogCacheBeforeReleaseHookForTests = hook;
  },
  setAfterRootLeaseAcquireHookForTests(hook: typeof catalogCacheAfterRootLeaseAcquireHookForTests): void {
    catalogCacheAfterRootLeaseAcquireHookForTests = hook;
  },
};
