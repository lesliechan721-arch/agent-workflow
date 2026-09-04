import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import { CATALOG_STORE_DIRECTORY } from '../constants.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { createCatalogStoreKey, readCatalogStoreEntry } from '../utils/catalog-generation-store.js';
import { readCatalogGenerationState } from '../utils/catalog-generation-state.js';
import { readCatalogSourcesConfig } from '../utils/catalog-sources.js';
import { resolveAwHome } from '../utils/state-paths.js';

const FORMAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;
const HEX_SEGMENT = /^[0-9a-f]{64}$/u;
const TEMP_SEGMENT = /^\.(staging|replacement|quarantine)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const DELETE_CLAIM_SEGMENT = /^\.delete-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export type CatalogStoreEntryCategory =
  | 'entry'
  | 'staging'
  | 'replacement'
  | 'quarantine'
  | 'deleteClaim'
  | 'foreign';

export type CatalogStoreEntryStatus = 'active' | 'reclaimable' | 'retained' | 'error';

export interface CatalogStoreInspectionEntry {
  storeKey: string;
  category: CatalogStoreEntryCategory;
  status: CatalogStoreEntryStatus;
  ageMs: number | null;
  reclaimableBytes: number | null;
  reason: string;
}

export interface CatalogStoreStatusResult {
  catalogStoreSchemaVersion: 1;
  command: 'catalog:store:status';
  ok: true;
  entries: CatalogStoreInspectionEntry[];
  totals: {
    entries: number;
    reclaimableEntries: number;
    reclaimableBytes: number | null;
  };
}

export interface CatalogStoreStatusFailureResult {
  catalogStoreSchemaVersion: 1;
  command: 'catalog:store:status';
  ok: false;
  entries: [];
  errors: Array<{ code: string; message: string }>;
}

export interface CatalogStorePruneResult {
  catalogStoreSchemaVersion: 1;
  command: 'catalog:store:prune';
  ok: boolean;
  overallState: 'succeeded' | 'partial';
  dryRun: boolean;
  entries: CatalogStoreInspectionEntry[];
  deleted: Array<{ storeKey: string; bytes: number }>;
  retained: Array<{ storeKey: string; reason: string }>;
  errors: Array<{ storeKey: string; code: 'catalogStoreDeleteFailed'; message: string }>;
  reclaimableBytes: number | null;
  deletedBytes: number;
}

export interface CatalogStorePruneFailureResult {
  catalogStoreSchemaVersion: 1;
  command: 'catalog:store:prune';
  ok: false;
  overallState: 'failed';
  dryRun: boolean;
  entries: [];
  deleted: [];
  retained: [];
  errors: Array<{ code: string; message: string }>;
  reclaimableBytes: null;
  deletedBytes: 0;
}

interface TreeEvidence {
  ageMs: number | null;
  bytes: number | null;
  safe: boolean;
  reason?: string;
  rootIdentity: NodeIdentity | null;
}

interface NodeIdentity {
  device: number;
  inode: number;
  mode: number;
  birthtimeMs: number;
}

interface InternalInspectionEntry extends CatalogStoreInspectionEntry {
  absolutePath: string;
  rootIdentity: NodeIdentity | null;
}

interface CatalogStorePruneRuntime {
  afterInitialInspection?(
    entries: readonly CatalogStoreInspectionEntry[],
  ): Promise<void> | void;
  updateDeleteClaimTime?(target: string, now: Date): Promise<void> | void;
  afterDeleteClaim?(options: { storeKey: string; claimPath: string }): Promise<void> | void;
}

function opaqueForeignKey(parent: string, name: string): string {
  const digest = crypto.createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `${parent === '' ? '' : `${parent}/`}<foreign-${digest}>`;
}

async function inspectTree(root: string, nowMs: number): Promise<TreeEvidence> {
  let newestMtimeMs = Number.NEGATIVE_INFINITY;
  let bytes = 0;
  let rootIdentity: NodeIdentity | null = null;
  const pending = [root];
  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      const stat = await fs.lstat(current);
      if (current === root) rootIdentity = {
        device: stat.dev,
        inode: stat.ino,
        mode: stat.mode,
        birthtimeMs: stat.birthtimeMs,
      };
      newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) {
        return { ageMs: null, bytes: null, safe: false, reason: 'unsafeSymlink', rootIdentity };
      }
      if (stat.isFile()) {
        bytes += stat.size;
        continue;
      }
      if (!stat.isDirectory()) {
        return { ageMs: null, bytes: null, safe: false, reason: 'unsafeNode', rootIdentity };
      }
      const children = await fs.readdir(current);
      for (const child of children) pending.push(path.join(current, child));
    }
    return {
      ageMs: Math.max(0, nowMs - newestMtimeMs),
      bytes,
      safe: true,
      rootIdentity,
    };
  } catch {
    return { ageMs: null, bytes: null, safe: false, reason: 'unreadable', rootIdentity };
  }
}

async function readEntryIdentity(entryDir: string): Promise<{
  logicalIdentity: string;
  snapshotDigest: string;
} | null> {
  try {
    const value = await fs.readJson(path.join(entryDir, 'metadata.json')) as Record<string, unknown>;
    if (typeof value.logicalIdentity !== 'string'
      || typeof value.snapshotDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(value.snapshotDigest)) return null;
    return { logicalIdentity: value.logicalIdentity, snapshotDigest: value.snapshotDigest };
  } catch {
    return null;
  }
}

function retainedEntry(options: {
  storeKey: string;
  category: CatalogStoreEntryCategory;
  absolutePath: string;
  evidence: TreeEvidence;
  reason: string;
}): InternalInspectionEntry {
  return {
    storeKey: options.storeKey,
    category: options.category,
    status: options.evidence.safe ? 'retained' : 'error',
    ageMs: options.evidence.ageMs,
    reclaimableBytes: null,
    reason: options.evidence.reason ?? options.reason,
    absolutePath: options.absolutePath,
    rootIdentity: options.evidence.rootIdentity,
  };
}

async function inspectFormalEntry(options: {
  identitySegment: string;
  digestSegment: string;
  entryDir: string;
  activeKeys: ReadonlySet<string>;
  evidence: TreeEvidence;
  env: NodeJS.ProcessEnv;
}): Promise<InternalInspectionEntry> {
  const storeKey = `${options.identitySegment}/${options.digestSegment}`;
  if (!options.evidence.safe) return retainedEntry({
    storeKey, category: 'entry', absolutePath: options.entryDir,
    evidence: options.evidence, reason: 'unsafeEntry',
  });
  const identity = await readEntryIdentity(options.entryDir);
  if (!identity) return retainedEntry({
    storeKey, category: 'entry', absolutePath: options.entryDir,
    evidence: options.evidence, reason: 'validationFailed',
  });
  try {
    if (createCatalogStoreKey(identity.logicalIdentity, identity.snapshotDigest) !== storeKey) {
      throw new Error('store key mismatch');
    }
    await readCatalogStoreEntry({ ...identity, env: options.env });
  } catch {
    return retainedEntry({
      storeKey, category: 'entry', absolutePath: options.entryDir,
      evidence: options.evidence, reason: 'validationFailed',
    });
  }
  if (options.activeKeys.has(storeKey)) return {
    storeKey,
    category: 'entry',
    status: 'active',
    ageMs: options.evidence.ageMs,
    reclaimableBytes: null,
    reason: 'active',
    absolutePath: options.entryDir,
    rootIdentity: options.evidence.rootIdentity,
  };
  const reclaimable = options.evidence.ageMs !== null && options.evidence.ageMs > FORMAL_RETENTION_MS;
  return {
    storeKey,
    category: 'entry',
    status: reclaimable ? 'reclaimable' : 'retained',
    ageMs: options.evidence.ageMs,
    reclaimableBytes: reclaimable ? options.evidence.bytes : null,
    reason: reclaimable ? 'inactiveOlderThan30Days' : 'inactiveWithin30Days',
    absolutePath: options.entryDir,
    rootIdentity: options.evidence.rootIdentity,
  };
}

async function inspectTempEntry(options: {
  identitySegment: string;
  name: string;
  entryDir: string;
  evidence: TreeEvidence;
  env: NodeJS.ProcessEnv;
}): Promise<InternalInspectionEntry> {
  const match = TEMP_SEGMENT.exec(options.name)!;
  const category = match[1] as 'staging' | 'replacement' | 'quarantine';
  const storeKey = `${options.identitySegment}/${options.name}`;
  const rootStat = await fs.lstat(options.entryDir).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return retainedEntry({
    storeKey, category, absolutePath: options.entryDir,
    evidence: { ...options.evidence, safe: false, reason: 'unsafeTemporaryRoot' },
    reason: 'unsafeTemporaryRoot',
  });
  if (!options.evidence.safe) return retainedEntry({
    storeKey, category, absolutePath: options.entryDir,
    evidence: options.evidence, reason: 'unsafeTemporaryEntry',
  });
  if (options.evidence.ageMs === null || options.evidence.ageMs <= TEMP_RETENTION_MS) {
    return retainedEntry({
      storeKey, category, absolutePath: options.entryDir,
      evidence: options.evidence, reason: 'temporaryWithin24Hours',
    });
  }
  if (category === 'quarantine') {
    const identity = await readEntryIdentity(options.entryDir);
    if (!identity) return retainedEntry({
      storeKey, category, absolutePath: options.entryDir,
      evidence: options.evidence, reason: 'quarantineCanonicalUnknown',
    });
    try {
      const canonicalKey = createCatalogStoreKey(identity.logicalIdentity, identity.snapshotDigest);
      if (!canonicalKey.startsWith(`${options.identitySegment}/`)) throw new Error('identity mismatch');
      await readCatalogStoreEntry({ ...identity, env: options.env });
    } catch {
      return retainedEntry({
        storeKey, category, absolutePath: options.entryDir,
        evidence: options.evidence, reason: 'quarantineCanonicalUnhealthy',
      });
    }
  }
  return {
    storeKey,
    category,
    status: 'reclaimable',
    ageMs: options.evidence.ageMs,
    reclaimableBytes: options.evidence.bytes,
    reason: 'temporaryOlderThan24Hours',
    absolutePath: options.entryDir,
    rootIdentity: options.evidence.rootIdentity,
  };
}

async function inspectDeleteClaim(options: {
  identitySegment: string;
  name: string;
  entryDir: string;
  evidence: TreeEvidence;
}): Promise<InternalInspectionEntry> {
  const storeKey = `${options.identitySegment}/${options.name}`;
  const rootStat = await fs.lstat(options.entryDir).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return retainedEntry({
    storeKey, category: 'deleteClaim', absolutePath: options.entryDir,
    evidence: { ...options.evidence, safe: false, reason: 'unsafeDeleteClaimRoot' },
    reason: 'unsafeDeleteClaimRoot',
  });
  if (!options.evidence.safe) return retainedEntry({
    storeKey, category: 'deleteClaim', absolutePath: options.entryDir,
    evidence: options.evidence, reason: 'unsafeDeleteClaim',
  });
  const reclaimable = options.evidence.ageMs !== null && options.evidence.ageMs > TEMP_RETENTION_MS;
  return {
    storeKey,
    category: 'deleteClaim',
    status: reclaimable ? 'reclaimable' : 'retained',
    ageMs: options.evidence.ageMs,
    reclaimableBytes: reclaimable ? options.evidence.bytes : null,
    reason: reclaimable ? 'deleteClaimOlderThan24Hours' : 'deleteClaimWithin24Hours',
    absolutePath: options.entryDir,
    rootIdentity: options.evidence.rootIdentity,
  };
}

async function activeStoreKeys(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const [config, state] = await Promise.all([
    readCatalogSourcesConfig(env),
    readCatalogGenerationState(env),
  ]);
  const configuredSourceIds = new Set(config.sources.map((source) => source.id));
  return new Set(Object.entries(state.sources)
    .flatMap(([sourceId, source]) => configuredSourceIds.has(sourceId) && source.active
      ? [createCatalogStoreKey(source.active.logicalIdentity, source.active.snapshotDigest)]
      : []));
}

async function inspectCatalogStore(options: {
  env: NodeJS.ProcessEnv;
  nowMs: number;
}): Promise<InternalInspectionEntry[]> {
  const activeKeys = await activeStoreKeys(options.env);
  const storeRoot = path.join(resolveAwHome(options.env), CATALOG_STORE_DIRECTORY);
  const rootStat = await fs.lstat(storeRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat) return [];
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return [retainedEntry({
      storeKey: '.', category: 'foreign', absolutePath: storeRoot,
      evidence: {
        ageMs: null, bytes: null, safe: false, reason: 'unsafeStoreRoot', rootIdentity: null,
      },
      reason: 'unsafeStoreRoot',
    })];
  }
  const entries: InternalInspectionEntry[] = [];
  const identityNames = await fs.readdir(storeRoot).then((names) => names.sort()).catch(() => null);
  if (!identityNames) return [retainedEntry({
    storeKey: '.', category: 'foreign', absolutePath: storeRoot,
    evidence: {
      ageMs: null, bytes: null, safe: false, reason: 'unreadableStoreRoot', rootIdentity: null,
    },
    reason: 'unreadableStoreRoot',
  })];
  for (const identityName of identityNames) {
    const identityDir = path.join(storeRoot, identityName);
    const identityStat = await fs.lstat(identityDir).catch(() => null);
    if (!HEX_SEGMENT.test(identityName) || !identityStat?.isDirectory() || identityStat.isSymbolicLink()) {
      const evidence = await inspectTree(identityDir, options.nowMs);
      entries.push(retainedEntry({
        storeKey: opaqueForeignKey('', identityName), category: 'foreign', absolutePath: identityDir,
        evidence, reason: 'unrecognizedIdentityNode',
      }));
      continue;
    }
    const childNames = await fs.readdir(identityDir).then((names) => names.sort()).catch(() => null);
    if (!childNames) {
      entries.push(retainedEntry({
        storeKey: `${identityName}/<unreadable>`, category: 'foreign', absolutePath: identityDir,
        evidence: {
          ageMs: null,
          bytes: null,
          safe: false,
          reason: 'unreadableIdentityDirectory',
          rootIdentity: identityStat ? {
            device: identityStat.dev,
            inode: identityStat.ino,
            mode: identityStat.mode,
            birthtimeMs: identityStat.birthtimeMs,
          } : null,
        },
        reason: 'unreadableIdentityDirectory',
      }));
      continue;
    }
    for (const childName of childNames) {
      const entryDir = path.join(identityDir, childName);
      const evidence = await inspectTree(entryDir, options.nowMs);
      if (HEX_SEGMENT.test(childName)) {
        entries.push(await inspectFormalEntry({
          identitySegment: identityName,
          digestSegment: childName,
          entryDir,
          activeKeys,
          evidence,
          env: options.env,
        }));
      } else if (TEMP_SEGMENT.test(childName)) {
        entries.push(await inspectTempEntry({
          identitySegment: identityName,
          name: childName,
          entryDir,
          evidence,
          env: options.env,
        }));
      } else if (DELETE_CLAIM_SEGMENT.test(childName)) {
        entries.push(await inspectDeleteClaim({
          identitySegment: identityName,
          name: childName,
          entryDir,
          evidence,
        }));
      } else {
        entries.push(retainedEntry({
          storeKey: opaqueForeignKey(identityName, childName), category: 'foreign', absolutePath: entryDir,
          evidence, reason: 'unrecognizedStoreNode',
        }));
      }
    }
  }
  return entries;
}

function publicEntries(entries: InternalInspectionEntry[]): CatalogStoreInspectionEntry[] {
  return entries.map(({
    absolutePath: _absolutePath,
    rootIdentity: _rootIdentity,
    ...entry
  }) => entry);
}

function reclaimableTotal(entries: readonly CatalogStoreInspectionEntry[]): number | null {
  if (entries.some((entry) => entry.status === 'error')) return null;
  const reclaimable = entries.filter((entry) => entry.status === 'reclaimable');
  if (reclaimable.some((entry) => entry.reclaimableBytes === null)) return null;
  return reclaimable.reduce((sum, entry) => sum + entry.reclaimableBytes!, 0);
}

function sameNodeIdentity(left: NodeIdentity | null, right: NodeIdentity | null): boolean {
  return left !== null
    && right !== null
    && left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && Object.is(left.birthtimeMs, right.birthtimeMs);
}

function sameDeletionEvidence(
  initial: InternalInspectionEntry,
  current: InternalInspectionEntry,
): boolean {
  return current.status === 'reclaimable'
    && current.storeKey === initial.storeKey
    && current.category === initial.category
    && current.absolutePath === initial.absolutePath
    && current.ageMs === initial.ageMs
    && current.reclaimableBytes === initial.reclaimableBytes
    && current.reason === initial.reason
    && sameNodeIdentity(current.rootIdentity, initial.rootIdentity);
}

function staleInspectionEntry(
  initial: InternalInspectionEntry,
  current?: InternalInspectionEntry,
): InternalInspectionEntry {
  if (current?.status === 'active' || current?.status === 'error') return current;
  return {
    ...(current ?? initial),
    status: 'retained',
    ageMs: current?.ageMs ?? null,
    reclaimableBytes: null,
    reason: 'staleBeforeDelete',
    rootIdentity: current?.rootIdentity ?? null,
  };
}

async function readNodeIdentity(target: string): Promise<NodeIdentity | null> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return null;
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    birthtimeMs: stat.birthtimeMs,
  };
}

async function readDirectoryIdentity(target: string): Promise<NodeIdentity | null> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return null;
  return {
    device: stat.dev,
    inode: stat.ino,
    mode: stat.mode,
    birthtimeMs: stat.birthtimeMs,
  };
}

async function restoreStaleClaim(claimPath: string, originalPath: string): Promise<boolean> {
  const originalExists = await fs.lstat(originalPath)
    .then(() => true)
    .catch(() => false);
  if (originalExists) return false;
  return fs.rename(claimPath, originalPath)
    .then(() => true)
    .catch(() => false);
}

async function inspectDeleteClaimAfterFailure(options: {
  claimPath: string;
  nowMs: number;
}): Promise<InternalInspectionEntry | null> {
  const exists = await fs.lstat(options.claimPath)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : true);
  if (!exists) return null;
  return inspectDeleteClaim({
    identitySegment: path.basename(path.dirname(options.claimPath)),
    name: path.basename(options.claimPath),
    entryDir: options.claimPath,
    evidence: await inspectTree(options.claimPath, options.nowMs),
  });
}

export async function catalogStoreStatus(options: {
  env?: NodeJS.ProcessEnv;
  now?: Date;
} = {}): Promise<CatalogStoreStatusResult> {
  const entries = publicEntries(await inspectCatalogStore({
    env: options.env ?? process.env,
    nowMs: (options.now ?? new Date()).getTime(),
  }));
  return {
    catalogStoreSchemaVersion: 1,
    command: 'catalog:store:status',
    ok: true,
    entries,
    totals: {
      entries: entries.length,
      reclaimableEntries: entries.filter((entry) => entry.status === 'reclaimable').length,
      reclaimableBytes: reclaimableTotal(entries),
    },
  };
}

async function executePrune(options: {
  env: NodeJS.ProcessEnv;
  nowMs: number;
  dryRun: boolean;
  remove: (target: string) => Promise<void>;
  runtime?: CatalogStorePruneRuntime;
}): Promise<CatalogStorePruneResult> {
  const inspected = await inspectCatalogStore({ env: options.env, nowMs: options.nowMs });
  const deleted: CatalogStorePruneResult['deleted'] = [];
  const errors: CatalogStorePruneResult['errors'] = [];
  const retainedAfterError = new Set<string>();
  const retainedReasons = new Map<string, string>();
  if (!options.dryRun) {
    const candidates = inspected
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.status === 'reclaimable');
    await options.runtime?.afterInitialInspection?.(publicEntries(inspected));
    for (const { entry: initial, index } of candidates) {
      const current = (await inspectCatalogStore({ env: options.env, nowMs: options.nowMs }))
        .find((candidate) => candidate.absolutePath === initial.absolutePath
          && candidate.storeKey === initial.storeKey
          && candidate.category === initial.category);
      if (!current || !sameDeletionEvidence(initial, current)) {
        inspected[index] = staleInspectionEntry(initial, current);
        retainedReasons.set(initial.storeKey, current?.status === 'active'
          ? 'active'
          : 'staleBeforeDelete');
        continue;
      }
      inspected[index] = current;
      const parentPath = path.dirname(current.absolutePath);
      const parentIdentity = await readDirectoryIdentity(parentPath);
      if (!parentIdentity) {
        inspected[index] = staleInspectionEntry(initial, current);
        retainedReasons.set(initial.storeKey, 'staleBeforeDelete');
        continue;
      }
      const claimPath = path.join(parentPath, `.delete-${crypto.randomUUID()}.tmp`);
      try {
        await fs.rename(current.absolutePath, claimPath);
      } catch {
        inspected[index] = staleInspectionEntry(initial, current);
        retainedReasons.set(initial.storeKey, 'staleBeforeDelete');
        continue;
      }
      try {
        const claimTime = new Date(options.nowMs);
        if (options.runtime?.updateDeleteClaimTime) {
          await options.runtime.updateDeleteClaimTime(claimPath, claimTime);
        } else {
          await fs.utimes(claimPath, claimTime, claimTime);
        }
      } catch {
        const restored = await restoreStaleClaim(claimPath, current.absolutePath);
        if (restored) {
          inspected[index] = staleInspectionEntry(initial, current);
          retainedReasons.set(initial.storeKey, 'staleBeforeDelete');
        } else {
          const failedClaim = await inspectDeleteClaimAfterFailure({
            claimPath,
            nowMs: options.nowMs,
          });
          inspected[index] = staleInspectionEntry(initial, failedClaim ?? undefined);
          retainedReasons.set(inspected[index]!.storeKey, 'staleBeforeDelete');
        }
        continue;
      }
      await options.runtime?.afterDeleteClaim?.({ storeKey: initial.storeKey, claimPath });
      const [claimedIdentity, currentParentIdentity] = await Promise.all([
        readNodeIdentity(claimPath),
        readDirectoryIdentity(parentPath),
      ]);
      if (!sameNodeIdentity(current.rootIdentity, claimedIdentity)
        || !sameNodeIdentity(parentIdentity, currentParentIdentity)) {
        await restoreStaleClaim(claimPath, current.absolutePath);
        inspected[index] = staleInspectionEntry(initial, current);
        retainedReasons.set(initial.storeKey, 'staleBeforeDelete');
        continue;
      }
      try {
        await options.remove(claimPath);
        deleted.push({ storeKey: initial.storeKey, bytes: current.reclaimableBytes! });
      } catch {
        const failedClaim = await inspectDeleteClaimAfterFailure({
          claimPath,
          nowMs: options.nowMs,
        });
        if (!failedClaim) {
          deleted.push({ storeKey: initial.storeKey, bytes: current.reclaimableBytes! });
          continue;
        }
        inspected[index] = failedClaim;
        retainedAfterError.add(failedClaim.storeKey);
        errors.push({
          storeKey: failedClaim.storeKey,
          code: 'catalogStoreDeleteFailed',
          message: `Could not safely complete deletion of Catalog store item ${failedClaim.storeKey}. Retry prune.`,
        });
      }
    }
  }
  const entries = publicEntries(inspected);
  const deletedKeys = new Set(deleted.map((entry) => entry.storeKey));
  const retained = entries
    .filter((entry) => !deletedKeys.has(entry.storeKey)
      && (options.dryRun
        || entry.status !== 'reclaimable'
        || retainedAfterError.has(entry.storeKey)
        || retainedReasons.has(entry.storeKey)))
    .map((entry) => ({
      storeKey: entry.storeKey,
      reason: retainedReasons.get(entry.storeKey) ?? entry.reason,
    }));
  return {
    catalogStoreSchemaVersion: 1,
    command: 'catalog:store:prune',
    ok: errors.length === 0,
    overallState: errors.length === 0 ? 'succeeded' : 'partial',
    dryRun: options.dryRun,
    entries,
    deleted,
    retained,
    errors,
    reclaimableBytes: reclaimableTotal(entries),
    deletedBytes: deleted.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

export async function catalogStorePrune(options: {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  remove?: (target: string) => Promise<void>;
  runtime?: CatalogStorePruneRuntime;
} = {}): Promise<CatalogStorePruneResult> {
  const env = options.env ?? process.env;
  const nowMs = (options.now ?? new Date()).getTime();
  const dryRun = options.dryRun !== false;
  const action = () => executePrune({
    env,
    nowMs,
    dryRun,
    remove: options.remove ?? ((target) => fs.remove(target)),
    runtime: options.runtime,
  });
  if (dryRun) return action();
  return withAwHomeMutationLock({ env, action });
}
