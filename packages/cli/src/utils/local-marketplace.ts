import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import type {
  CatalogChannel,
  CatalogFreshnessPolicy,
  CatalogResolution,
  CatalogResolutionFailure,
  CatalogSelector,
  CatalogVersion,
  CliVersion,
  LocalMarketplaceConfig,
} from '../types.js';
import {
  CURRENT_CATALOG_MANIFEST_FILE,
  CURRENT_CATALOG_MANIFEST_PACKAGE,
} from '../constants.js';
import { readJsonFile, readJsonFileIfExistsSafe, writeJsonFile } from './json.js';
import {
  getCodexHome,
  resolveCurrentCatalogCacheEntriesDir,
  resolveCurrentCatalogCacheEntryDir,
  resolveCurrentCatalogCacheSelectorIndexPath,
  resolveCurrentCatalogCacheSelectorsDir,
  resolveCurrentCatalogCacheStagingDir,
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEmbeddedPluginsRoot,
} from './paths.js';
import { validateBundleLayout } from './bundle-layout.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  tryParseStrictSemVer,
} from './manifest.js';
import { assertTestWritablePath } from './test-path-fence.js';
import { readSkillOwnerMarker } from './ownership.js';

function resolveCliPackageJsonPath(): string {
  return path.join(resolveCliPackageRoot(), 'package.json');
}

export function getLocalMarketplacePluginRoot(rootDir: string, pluginName: string): string {
  return path.join(rootDir, 'plugins', pluginName);
}

export function getLocalMarketplaceCodexSkillsRoot(rootDir: string, pluginName: string): string {
  return path.join(getLocalMarketplacePluginRoot(rootDir, pluginName), 'codex', 'skills');
}

export function getLocalMarketplaceCodexSkillRoot(
  rootDir: string,
  pluginName: string,
  skillKey: string,
): string {
  return path.join(getLocalMarketplaceCodexSkillsRoot(rootDir, pluginName), skillKey);
}

function hasCatalogSelectorOverride(env: NodeJS.ProcessEnv): boolean {
  return env.AW_CATALOG_VERSION !== undefined ||
    env.AW_CATALOG_CHANNEL === 'latest' ||
    env.AW_CATALOG_CHANNEL === 'beta' ||
    env.AW_CLI_VERSION !== undefined;
}

export interface LocalMarketplaceGateOptions {
  interactive?: boolean;
  confirmOverwrite?: (options: { message: string; defaultValue: boolean }) => Promise<boolean>;
  onNotice?: (message: string) => void | Promise<void>;
}

interface LocalMarketplaceConfigInspection {
  state: 'missing' | 'valid' | 'invalid';
  config: LocalMarketplaceConfig | null;
  sourceVersion: string | null | undefined;
}

type LocalMarketplaceSourceVersionStatus =
  | 'absent'
  | 'missing'
  | 'invalid'
  | 'ahead'
  | 'equal'
  | 'behind';

interface LocalMarketplaceInspection {
  awHome: string;
  embeddedRoot: string;
  packageInfo: {
    name: string;
    version: string;
  };
  bundleFingerprint: string;
  configInspection: LocalMarketplaceConfigInspection;
  sourceVersionStatus: LocalMarketplaceSourceVersionStatus;
  layoutHealthy: boolean;
  layoutError?: string;
}

export async function readCliPackageInfo(): Promise<{ name: string; version: string }> {
  const packageJson = await readJsonFile<{ name: string; version: string }>(resolveCliPackageJsonPath());
  const version = assertStrictSemVer(packageJson.version, 'packages/cli/package.json version');
  return {
    name: packageJson.name,
    version,
  };
}

export interface CurrentCatalogCacheIdentity {
  selector: CatalogSelector;
  channel: CatalogChannel;
  catalogVersion: CatalogVersion;
  minAwVersion: CliVersion;
  schemaVersion: number;
  historySchemaVersion: number | null;
  sidecarIntegrity: string;
  fullIntegrity: string;
}

interface CurrentCatalogCacheEntryRecordBase extends CurrentCatalogCacheIdentity {
  manifestDigest: string;
  createdAt: string;
}

export interface CurrentCatalogCacheEntryRecordV1 extends CurrentCatalogCacheEntryRecordBase {
  version: 1;
}

export interface CurrentCatalogCacheEntryRecordV2 extends CurrentCatalogCacheEntryRecordBase {
  version: 2;
  publicationId: string;
}

export type CurrentCatalogCacheEntryRecord =
  | CurrentCatalogCacheEntryRecordV1
  | CurrentCatalogCacheEntryRecordV2;

export interface CurrentCatalogCacheEntry {
  cacheKey: string;
  selectorKey: string;
  rootDir: string;
  metadataPath: string;
  metadata: CurrentCatalogCacheEntryRecord;
  validatedAt: string;
  observation?: CurrentCatalogCacheObservation;
}

export interface CurrentCatalogCacheObservation {
  sidecarManifestPackage: NonNullable<CatalogResolution['sidecarManifestPackage']>;
  latestCatalog?: CatalogResolution['latestCatalog'];
  latestCatalogBlocked?: CatalogResolution['latestCatalogBlocked'];
  historySchemaVersion: number | null;
  resolutionSource: NonNullable<NonNullable<CatalogResolution['fullCatalog']>['resolutionSource']>;
  sourceIdentity?: string;
  observationOrder?: number;
}

interface CurrentCatalogCacheSelectorIndexRecordV1 {
  version: 1;
  selectorKey: string;
  cacheKey: string;
  validatedAt: string;
}

interface CurrentCatalogCacheSelectorIndexRecordV2 {
  version: 2;
  selectorKey: string;
  cacheKey: string;
  publicationId: string;
  validatedAt: string;
  sourceIdentity?: string;
  observation?: CurrentCatalogCacheObservation;
}

type CurrentCatalogCacheSelectorIndexRecord =
  | CurrentCatalogCacheSelectorIndexRecordV1
  | CurrentCatalogCacheSelectorIndexRecordV2;

const CURRENT_CATALOG_CONCURRENT_INDEX_WAIT_MS = 250;
const CURRENT_CATALOG_CONCURRENT_INDEX_POLL_MS = 5;
const CURRENT_CATALOG_LOCK_TIMEOUT_MS = 5_000;
const CURRENT_CATALOG_LOCK_POLL_MS = 10;
const CURRENT_CATALOG_LOCK_STALE_MS = 30_000;
const CURRENT_CATALOG_LOCK_HEARTBEAT_MS = 1_000;
const execFileAsync = promisify(execFile);
const CURRENT_PROCESS_INSTANCE_TOKEN = crypto.randomUUID();
let currentProcessStartIdentity: Promise<string | null> | null = null;

export interface CurrentCatalogCacheLockOwner {
  version: 1;
  token: string;
  pid: number;
  processStartIdentity: string | null;
  acquiredAt: string;
}

export interface CurrentCatalogCacheLease {
  lockPath: string;
  owner: CurrentCatalogCacheLockOwner;
  release: () => Promise<boolean>;
}

function resolveCurrentCatalogCacheLockPath(env: NodeJS.ProcessEnv): string {
  const awHome = resolveAwHome(env);
  const identity = crypto.createHash('sha256').update(path.resolve(awHome)).digest('hex').slice(0, 16);
  return assertTestWritablePath(
    path.join(
      path.dirname(awHome),
      '.aw-local-marketplace-staging',
      `.catalog-cache-${identity}.lock`,
    ),
    'current catalog cache writer lock',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或登记 AW_HOME 同盘 sibling lock 路径。',
  );
}

function isCurrentCatalogCacheLockOwner(value: unknown): value is CurrentCatalogCacheLockOwner {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.token === 'string' &&
    isPublicationId(value.token) &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    (value.processStartIdentity === null || typeof value.processStartIdentity === 'string') &&
    typeof value.acquiredAt === 'string';
}

async function readCurrentCatalogCacheLockOwner(lockPath: string): Promise<CurrentCatalogCacheLockOwner | null> {
  const owner = await readJsonFileIfExistsSafe<unknown>(path.join(lockPath, 'owner.json'));
  return isCurrentCatalogCacheLockOwner(owner) ? owner : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOsProcessStartIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'linux') {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) {
      return null;
    }
    const closeParen = stat.lastIndexOf(')');
    const fields = closeParen === -1 ? [] : stat.slice(closeParen + 2).split(' ');
    const startTicks = fields[19];
    return startTicks ? `linux:${startTicks}` : null;
  }
  if (process.platform === 'darwin') {
    let result: Awaited<ReturnType<typeof execFileAsync>> | null = null;
    try {
      result = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        timeout: 1_000,
      });
    } catch {
      return null;
    }
    const value = result === null ? '' : String(result.stdout).trim();
    return value ? `darwin:${value}` : null;
  }
  if (process.platform === 'win32') {
    const powershell = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    let result: Awaited<ReturnType<typeof execFileAsync>> | null = null;
    try {
      result = await execFileAsync(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { timeout: 1_000 });
    } catch {
      return null;
    }
    const value = result === null ? '' : String(result.stdout).trim();
    return value && /^\d+$/.test(value) ? `win32:${value}` : null;
  }
  return null;
}

function getCurrentProcessStartIdentity(): Promise<string | null> {
  currentProcessStartIdentity ??= readOsProcessStartIdentity(process.pid).then((identity) =>
    identity ?? `instance:${CURRENT_PROCESS_INSTANCE_TOKEN}`);
  return currentProcessStartIdentity;
}

async function readProcessStartIdentity(pid: number): Promise<string | null> {
  return pid === process.pid
    ? getCurrentProcessStartIdentity()
    : readOsProcessStartIdentity(pid);
}

async function waitForCurrentCatalogCacheLockPoll(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Catalog cache lock wait aborted.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function restoreCurrentCatalogCacheOwnerClaim(
  claimPath: string,
  ownerPath: string,
  afterOwnerRestore?: () => Promise<void>,
): Promise<boolean> {
  try {
    await fs.link(claimPath, ownerPath);
    await afterOwnerRestore?.();
    await fs.remove(claimPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      return false;
    }
    if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
      throw error;
    }
  }
  try {
    await fs.copyFile(claimPath, ownerPath, fs.constants.COPYFILE_EXCL);
    await afterOwnerRestore?.();
    await fs.remove(claimPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function claimOwnedCurrentCatalogCacheLock(options: {
  lockPath: string;
  ownerToken: string;
  purpose: 'release' | 'stale';
  beforeClaim?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
  afterMismatchOwnerRestore?: () => Promise<void>;
}): Promise<boolean> {
  const owner = await readCurrentCatalogCacheLockOwner(options.lockPath);
  if (owner?.token !== options.ownerToken) {
    return false;
  }
  await options.beforeClaim?.();
  const ownerPath = path.join(options.lockPath, 'owner.json');
  const claimPath = path.join(
    options.lockPath,
    `${options.purpose}-${options.ownerToken}.json`,
  );
  try {
    await fs.rename(ownerPath, claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  await options.afterClaim?.();
  const claimedOwner = await readJsonFileIfExistsSafe<unknown>(claimPath);
  if (!isCurrentCatalogCacheLockOwner(claimedOwner) || claimedOwner.token !== options.ownerToken) {
    await restoreCurrentCatalogCacheOwnerClaim(
      claimPath,
      ownerPath,
      options.afterMismatchOwnerRestore,
    );
    return false;
  }
  await fs.remove(claimPath);
  try {
    await fs.rmdir(options.lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return true;
    }
    return false;
  }
}

async function releaseCurrentCatalogCacheLock(
  lockPath: string,
  ownerToken: string,
): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    if (!(await fs.pathExists(lockPath))) {
      return true;
    }
    const owner = await readCurrentCatalogCacheLockOwner(lockPath);
    if (owner) {
      if (owner.token !== ownerToken) {
        return false;
      }
      if (await claimOwnedCurrentCatalogCacheLock({
        lockPath,
        ownerToken,
        purpose: 'release',
      })) {
        return true;
      }
    } else {
      const claim = await findCurrentCatalogCacheOwnerClaim(lockPath);
      if (claim && claim.owner.token !== ownerToken) {
        return false;
      }
      if (!claim) {
        try {
          await fs.rmdir(lockPath);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            return true;
          }
          if (code !== 'ENOTEMPTY' && code !== 'EEXIST') {
            throw error;
          }
        }
      }
    }
    if (Date.now() - startedAt >= CURRENT_CATALOG_LOCK_TIMEOUT_MS) {
      throw new Error(
        `Timed out releasing current catalog cache lock ${lockPath} for owner ${ownerToken}.`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CURRENT_CATALOG_LOCK_POLL_MS));
  }
}

async function ownerIsRecoverable(owner: CurrentCatalogCacheLockOwner): Promise<boolean> {
  if (!processIsAlive(owner.pid)) {
    return true;
  }
  const liveStartIdentity = await readProcessStartIdentity(owner.pid);
  return liveStartIdentity !== null &&
    owner.processStartIdentity !== null &&
    liveStartIdentity !== owner.processStartIdentity;
}

async function findCurrentCatalogCacheOwnerClaim(lockPath: string): Promise<{
  path: string;
  owner: CurrentCatalogCacheLockOwner;
} | null> {
  const entries = await fs.readdir(lockPath).catch(() => [] as string[]);
  for (const entryName of entries.sort()) {
    if (!/^(?:release|stale)-[a-f0-9-]{36}\.json$/.test(entryName)) {
      continue;
    }
    const claimPath = path.join(lockPath, entryName);
    const owner = await readJsonFileIfExistsSafe<unknown>(claimPath);
    if (isCurrentCatalogCacheLockOwner(owner)) {
      return { path: claimPath, owner };
    }
  }
  return null;
}

async function tryRecoverStaleCurrentCatalogCacheLock(options: {
  lockPath: string;
  staleMs: number;
  beforeClaim?: () => Promise<void>;
  afterClaim?: () => Promise<void>;
  afterMismatchOwnerRestore?: () => Promise<void>;
}): Promise<boolean> {
  const [owner, stats] = await Promise.all([
    readCurrentCatalogCacheLockOwner(options.lockPath),
    fs.stat(options.lockPath).catch(() => null),
  ]);
  if (!stats) {
    return false;
  }
  const ageMs = Date.now() - stats.mtimeMs;
  if (ageMs < options.staleMs) {
    return false;
  }
  if (!owner) {
    const claim = await findCurrentCatalogCacheOwnerClaim(options.lockPath);
    if (!claim) {
      const entries = await fs.readdir(options.lockPath).catch(() => [] as string[]);
      if (entries.length === 0) {
        await fs.rmdir(options.lockPath).catch(() => {});
        return !(await fs.pathExists(options.lockPath));
      }
      return false;
    }
    const claimStats = await fs.stat(claim.path).catch(() => null);
    if (!claimStats || Date.now() - claimStats.mtimeMs < options.staleMs) {
      return false;
    }
    if (!(await ownerIsRecoverable(claim.owner))) {
      const restored = await restoreCurrentCatalogCacheOwnerClaim(
        claim.path,
        path.join(options.lockPath, 'owner.json'),
      );
      if (!restored) {
        const currentOwner = await readCurrentCatalogCacheLockOwner(options.lockPath);
        if (currentOwner?.token === claim.owner.token) {
          await fs.remove(claim.path).catch(() => {});
        }
      }
      return false;
    }
    await fs.remove(claim.path);
    await fs.rmdir(options.lockPath).catch(() => {});
    return !(await fs.pathExists(options.lockPath));
  }
  if (!(await ownerIsRecoverable(owner))) {
    return false;
  }
  return claimOwnedCurrentCatalogCacheLock({
    lockPath: options.lockPath,
    ownerToken: owner.token,
    purpose: 'stale',
    beforeClaim: options.beforeClaim,
    afterClaim: options.afterClaim,
    afterMismatchOwnerRestore: options.afterMismatchOwnerRestore,
  });
}

export async function acquireCurrentCatalogCacheLease(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    staleMs?: number;
    __testBeforeStaleClaim?: () => Promise<void>;
    __testAfterStaleClaim?: () => Promise<void>;
    __testAfterMismatchOwnerRestore?: () => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<CurrentCatalogCacheLease> {
  const lockPath = resolveCurrentCatalogCacheLockPath(env);
  const timeoutMs = options.timeoutMs ?? CURRENT_CATALOG_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? CURRENT_CATALOG_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? CURRENT_CATALOG_LOCK_STALE_MS;
  const startedAt = Date.now();
  await fs.ensureDir(path.dirname(lockPath));

  while (true) {
    options.signal?.throwIfAborted();
    const owner: CurrentCatalogCacheLockOwner = {
      version: 1,
      token: crypto.randomUUID(),
      pid: process.pid,
      processStartIdentity: await getCurrentProcessStartIdentity(),
      acquiredAt: new Date().toISOString(),
    };
    try {
      await fs.mkdir(lockPath);
      try {
        fs.writeFileSync(
          path.join(lockPath, 'owner.json'),
          `${JSON.stringify(owner, null, 2)}\n`,
          { flag: 'wx' },
        );
      } catch (error) {
        await fs.remove(lockPath);
        throw error;
      }
      let released = false;
      const heartbeat = setInterval(() => {
        void (async () => {
          const current = await readCurrentCatalogCacheLockOwner(lockPath);
          if (current?.token === owner.token) {
            const now = new Date();
            await fs.utimes(lockPath, now, now).catch(() => {});
          }
        })();
      }, CURRENT_CATALOG_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        lockPath,
        owner,
        async release() {
          if (released) {
            return false;
          }
          const releaseResult = await releaseCurrentCatalogCacheLock(lockPath, owner.token);
          released = true;
          clearInterval(heartbeat);
          return releaseResult;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    if (await tryRecoverStaleCurrentCatalogCacheLock({
      lockPath,
      staleMs,
      beforeClaim: options.__testBeforeStaleClaim,
      afterClaim: options.__testAfterStaleClaim,
      afterMismatchOwnerRestore: options.__testAfterMismatchOwnerRestore,
    })) {
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      const owner = await readCurrentCatalogCacheLockOwner(lockPath);
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for current catalog cache lock ${lockPath}. ` +
        `Owner token: ${owner?.token ?? 'unknown'}; pid: ${owner?.pid ?? 'unknown'}.`,
      );
    }
    await waitForCurrentCatalogCacheLockPoll(pollMs, options.signal);
  }
}

function createSha256Digest(value: Buffer | string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function serializeCatalogSelectorForCache(selector: CatalogSelector): string {
  return JSON.stringify({
    kind: selector.kind,
    cliVersion: selector.cliVersion,
    defaultChannel: selector.defaultChannel,
    requestedChannel: selector.requestedChannel ?? null,
    requestedCatalogVersion: selector.requestedCatalogVersion ?? null,
  });
}

function createCurrentCatalogCacheIdentityPayload(
  identity: CurrentCatalogCacheIdentity,
): Record<string, unknown> {
  return {
    selector: serializeCatalogSelectorForCache(identity.selector),
    channel: identity.channel,
    catalogVersion: identity.catalogVersion,
    minAwVersion: identity.minAwVersion,
    schemaVersion: identity.schemaVersion,
    historySchemaVersion: identity.historySchemaVersion,
    sidecarIntegrity: identity.sidecarIntegrity,
    fullIntegrity: identity.fullIntegrity,
  };
}

export function buildCurrentCatalogCacheKey(
  identity: CurrentCatalogCacheIdentity,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(createCurrentCatalogCacheIdentityPayload(identity)))
    .digest('hex');
}

function buildCurrentCatalogSelectorHashFromKey(
  selectorKey: string,
  sourceIdentity?: string,
): string {
  return crypto
    .createHash('sha256')
    .update(sourceIdentity === undefined
      ? selectorKey
      : JSON.stringify({ selectorKey, sourceIdentity }))
    .digest('hex');
}

function buildCurrentCatalogSelectorHash(
  selector: CatalogSelector,
  sourceIdentity?: string,
): string {
  return buildCurrentCatalogSelectorHashFromKey(
    serializeCatalogSelectorForCache(selector),
    sourceIdentity,
  );
}

function getCurrentCatalogCacheMetadataPath(entryDir: string): string {
  return path.join(entryDir, 'entry.json');
}

function getCurrentCatalogCacheRootDir(entryDir: string): string {
  return path.join(entryDir, 'catalog');
}

function isPublicationId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

function isCurrentCatalogCacheEntryRecord(value: unknown): value is CurrentCatalogCacheEntryRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    ((value.version === 1 &&
      value.publicationId === undefined &&
      value.observation === undefined) || (
      value.version === 2 &&
      isPublicationId(value.publicationId)
    )) &&
    isCatalogSelector(value.selector) &&
    isCatalogChannel(value.channel) &&
    isStrictSemVerString(value.catalogVersion) &&
    isStrictSemVerString(value.minAwVersion) &&
    typeof value.schemaVersion === 'number' && Number.isInteger(value.schemaVersion) &&
    value.schemaVersion >= 1 &&
    (value.historySchemaVersion === null || (
      typeof value.historySchemaVersion === 'number' && Number.isInteger(value.historySchemaVersion)
    )) &&
    typeof value.sidecarIntegrity === 'string' && value.sidecarIntegrity.trim() !== '' &&
    typeof value.fullIntegrity === 'string' && value.fullIntegrity.trim() !== '' &&
    typeof value.manifestDigest === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.manifestDigest) &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    Date.parse(value.createdAt) <= Date.now() + 1_000
  );
}

function isCurrentCatalogCacheSelectorIndexRecord(
  value: unknown,
): value is CurrentCatalogCacheSelectorIndexRecord {
  if (
    !isRecord(value) ||
    typeof value.selectorKey !== 'string' ||
    typeof value.cacheKey !== 'string' ||
    typeof value.validatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.validatedAt))
  ) {
    return false;
  }
  if (value.version === 1) {
    return value.publicationId === undefined &&
      value.observation === undefined &&
      value.sourceIdentity === undefined;
  }
  return value.version === 2 &&
    isPublicationId(value.publicationId) &&
    (value.sourceIdentity === undefined || (
      typeof value.sourceIdentity === 'string' && value.sourceIdentity.trim() !== ''
    ));
}

function isCatalogLatestEvidence(value: unknown): boolean {
  return isRecord(value) &&
    isCatalogChannel(value.channel) &&
    isStrictSemVerString(value.catalogVersion) &&
    isStrictSemVerString(value.minAwVersion) &&
    typeof value.blocked === 'boolean';
}

function isCurrentCatalogCacheObservation(value: unknown): value is CurrentCatalogCacheObservation {
  if (!isRecord(value) || !isRecord(value.sidecarManifestPackage)) {
    return false;
  }
  const sidecar = value.sidecarManifestPackage;
  return typeof sidecar.source === 'string' && sidecar.source.trim() !== '' &&
    isStrictSemVerString(sidecar.version) &&
    isCatalogChannel(sidecar.channel) &&
    typeof sidecar.manifestDigest === 'string' &&
    (sidecar.npmIntegrity === undefined || typeof sidecar.npmIntegrity === 'string') &&
    (value.latestCatalog === undefined || isCatalogLatestEvidence(value.latestCatalog)) &&
    (value.latestCatalogBlocked === undefined || (
      isRecord(value.latestCatalogBlocked) &&
      isCatalogChannel(value.latestCatalogBlocked.channel) &&
      isStrictSemVerString(value.latestCatalogBlocked.catalogVersion) &&
      isStrictSemVerString(value.latestCatalogBlocked.minAwVersion)
    )) &&
    (value.historySchemaVersion === null || Number.isInteger(value.historySchemaVersion)) &&
    ((value.sourceIdentity === undefined && value.observationOrder === undefined) || (
      typeof value.sourceIdentity === 'string' && value.sourceIdentity.trim() !== '' &&
      typeof value.observationOrder === 'number' &&
      Number.isSafeInteger(value.observationOrder) &&
      value.observationOrder > 0
    )) &&
    (value.resolutionSource === 'requestedCatalog' || value.resolutionSource === 'historyCompatibleCatalog');
}

function getRequestedCatalogChannelForCache(selector: CatalogSelector): CatalogChannel | null {
  return selector.kind === 'exactVersion'
    ? null
    : selector.requestedChannel ?? selector.defaultChannel;
}

function sameCatalogLatestEvidence(
  left: NonNullable<CurrentCatalogCacheObservation['latestCatalog']>,
  right: NonNullable<CurrentCatalogCacheObservation['latestCatalogBlocked']>,
): boolean {
  return left.channel === right.channel &&
    left.catalogVersion === right.catalogVersion &&
    left.minAwVersion === right.minAwVersion;
}

function isCurrentCatalogCacheObservationForEntry(
  value: unknown,
  entry: CurrentCatalogCacheEntry,
): value is CurrentCatalogCacheObservation {
  if (!isCurrentCatalogCacheObservation(value)) {
    return false;
  }
  const { metadata } = entry;
  const sidecar = value.sidecarManifestPackage;
  if (
    sidecar.source !== CURRENT_CATALOG_MANIFEST_PACKAGE ||
    sidecar.version !== metadata.catalogVersion ||
    sidecar.channel !== metadata.channel ||
    sidecar.manifestDigest !== metadata.manifestDigest ||
    sidecar.npmIntegrity !== metadata.sidecarIntegrity ||
    value.historySchemaVersion !== metadata.historySchemaVersion ||
    compareStrictSemVer(metadata.minAwVersion, metadata.selector.cliVersion) > 0
  ) {
    return false;
  }

  const requestedChannel = getRequestedCatalogChannelForCache(metadata.selector);
  if (
    (metadata.selector.kind === 'exactVersion' &&
      metadata.catalogVersion !== metadata.selector.requestedCatalogVersion) ||
    (requestedChannel !== null && metadata.channel !== requestedChannel)
  ) {
    return false;
  }

  const latest = value.latestCatalog;
  const blocked = value.latestCatalogBlocked;
  if (value.resolutionSource === 'requestedCatalog') {
    return latest !== undefined &&
      latest.channel === metadata.channel &&
      latest.catalogVersion === metadata.catalogVersion &&
      latest.minAwVersion === metadata.minAwVersion &&
      latest.blocked === false &&
      blocked === undefined;
  }

  return metadata.selector.kind !== 'exactVersion' &&
    latest !== undefined &&
    latest.blocked === true &&
    blocked !== undefined &&
    sameCatalogLatestEvidence(latest, blocked) &&
    latest.channel === metadata.channel &&
    compareStrictSemVer(latest.catalogVersion, metadata.catalogVersion) > 0 &&
    compareStrictSemVer(latest.minAwVersion, metadata.selector.cliVersion) > 0 &&
    metadata.historySchemaVersion !== null;
}

async function readCurrentCatalogCacheEntryByKey(
  cacheKey: string,
  expectedSelectorKey: string,
  env: NodeJS.ProcessEnv,
): Promise<CurrentCatalogCacheEntry | null> {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) {
    return null;
  }
  const entryDir = resolveCurrentCatalogCacheEntryDir(cacheKey, env);
  return readCurrentCatalogCacheEntryAt(cacheKey, expectedSelectorKey, entryDir);
}

async function readCurrentCatalogCacheEntryAt(
  cacheKey: string,
  expectedSelectorKey: string,
  entryDir: string,
): Promise<CurrentCatalogCacheEntry | null> {
  const metadataPath = getCurrentCatalogCacheMetadataPath(entryDir);
  const rootDir = getCurrentCatalogCacheRootDir(entryDir);
  const metadata = await readJsonFileIfExistsSafe<unknown>(metadataPath);
  if (
    !isCurrentCatalogCacheEntryRecord(metadata) ||
    serializeCatalogSelectorForCache(metadata.selector) !== expectedSelectorKey ||
    buildCurrentCatalogCacheKey(metadata) !== cacheKey
  ) {
    return null;
  }

  const manifestPath = path.join(rootDir, CURRENT_CATALOG_MANIFEST_FILE);
  const manifest = await fs.readFile(manifestPath).catch(() => null);
  if (manifest === null || createSha256Digest(manifest) !== metadata.manifestDigest) {
    return null;
  }

  return {
    cacheKey,
    selectorKey: expectedSelectorKey,
    rootDir,
    metadataPath,
    metadata,
    validatedAt: metadata.createdAt,
  };
}

async function validateCurrentCatalogCacheEntryForReuse(
  entry: CurrentCatalogCacheEntry,
  validateExisting?: (rootDir: string) => Promise<boolean>,
): Promise<boolean> {
  return validateExisting === undefined || await validateExisting(entry.rootDir);
}

async function restoreQuarantinedCurrentCatalogCacheEntry(
  quarantinedEntryDir: string,
  finalEntryDir: string,
): Promise<void> {
  try {
    await fs.rename(quarantinedEntryDir, finalEntryDir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') {
      throw error;
    }
  }
}

function applyCurrentCatalogCacheSelectorIndex(
  entry: CurrentCatalogCacheEntry,
  index: unknown,
  sourceIdentity?: string,
): CurrentCatalogCacheEntry | null {
  if (
    !isCurrentCatalogCacheSelectorIndexRecord(index) ||
    index.selectorKey !== entry.selectorKey ||
    index.cacheKey !== entry.cacheKey ||
    (index.version === 1 && sourceIdentity !== undefined) ||
    (index.version === 2 && index.sourceIdentity !== sourceIdentity) ||
    (entry.metadata.version === 2 && (
      index.version !== 2 ||
      index.publicationId !== entry.metadata.publicationId
    )) ||
    (entry.metadata.version === 1 && index.version !== 1)
  ) {
    return null;
  }
  const validatedAtMs = Date.parse(index.validatedAt);
  if (
    validatedAtMs < Date.parse(entry.metadata.createdAt) ||
    validatedAtMs > Date.now() + 1_000
  ) {
    return entry;
  }
  return {
    ...entry,
    validatedAt: index.validatedAt,
    ...(index.version === 2 &&
      isCurrentCatalogCacheObservationForEntry(index.observation, entry) &&
      index.observation.sourceIdentity === index.sourceIdentity
      ? { observation: index.observation }
      : {}),
  };
}

async function readCurrentCatalogCacheEntryFromSelectorIndex(
  selectorKey: string,
  index: unknown,
  env: NodeJS.ProcessEnv,
  sourceIdentity?: string,
): Promise<CurrentCatalogCacheEntry | null> {
  if (
    !isCurrentCatalogCacheSelectorIndexRecord(index) ||
    index.selectorKey !== selectorKey
  ) {
    return null;
  }
  const entry = await readCurrentCatalogCacheEntryByKey(index.cacheKey, selectorKey, env);
  return entry === null
    ? null
    : applyCurrentCatalogCacheSelectorIndex(entry, index, sourceIdentity);
}

function readCurrentCatalogObservationOrderFromIndex(
  index: unknown,
  selectorKey: string,
  sourceIdentity: string,
): number {
  if (
    !isCurrentCatalogCacheSelectorIndexRecord(index) ||
    index.version !== 2 ||
    index.selectorKey !== selectorKey ||
    index.sourceIdentity !== sourceIdentity ||
    !isCurrentCatalogCacheObservation(index.observation) ||
    index.observation.sourceIdentity !== sourceIdentity ||
    index.observation.observationOrder === undefined
  ) {
    return 0;
  }
  return index.observation.observationOrder;
}

export async function reserveCurrentCatalogCacheObservationOrder(
  selector: CatalogSelector,
  sourceIdentity: string,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<number> {
  const lease = await acquireCurrentCatalogCacheLease(env, { signal });
  try {
    signal?.throwIfAborted();
    const selectorKey = serializeCatalogSelectorForCache(selector);
    const selectorHash = buildCurrentCatalogSelectorHashFromKey(
      selectorKey,
      sourceIdentity,
    );
    const observationsDir = path.join(
      path.dirname(resolveCurrentCatalogCacheSelectorsDir(env)),
      'observations',
      selectorHash,
    );
    await fs.ensureDir(observationsDir);
    signal?.throwIfAborted();

    const entryNames = await fs.readdir(observationsDir);
    let highestOrder = 0;
    for (const entryName of entryNames) {
      if (!/^[1-9]\d*$/.test(entryName)) {
        throw new Error(`Invalid current catalog observation order entry ${entryName}.`);
      }
      const order = Number(entryName);
      if (!Number.isSafeInteger(order)) {
        throw new Error(`Invalid current catalog observation order entry ${entryName}.`);
      }
      highestOrder = Math.max(highestOrder, order);
    }

    const indexPath = resolveCurrentCatalogCacheSelectorIndexPath(selectorHash, env);
    const currentIndex = await readJsonFileIfExistsSafe<unknown>(indexPath);
    highestOrder = Math.max(
      highestOrder,
      readCurrentCatalogObservationOrderFromIndex(
        currentIndex,
        selectorKey,
        sourceIdentity,
      ),
    );
    const observationOrder = highestOrder + 1;
    if (!Number.isSafeInteger(observationOrder)) {
      throw new Error('Current catalog observation order is exhausted.');
    }

    await fs.mkdir(path.join(observationsDir, String(observationOrder)));
    signal?.throwIfAborted();
    await Promise.all(entryNames.map((entryName) =>
      fs.remove(path.join(observationsDir, entryName))));
    return observationOrder;
  } finally {
    await lease.release();
  }
}

async function restoreDisplacedCurrentCatalogCacheSelectorIndex(
  displacedIndexPath: string,
  indexPath: string,
  selectorKey: string,
  env: NodeJS.ProcessEnv,
  sourceIdentity?: string,
): Promise<void> {
  const removeDisplacedIndex = async (): Promise<void> => {
    await fs.remove(displacedIndexPath);
  };
  const keepValidPublishedIndex = async (): Promise<boolean> => {
    const current = await readJsonFileIfExistsSafe<unknown>(indexPath);
    return await readCurrentCatalogCacheEntryFromSelectorIndex(
      selectorKey,
      current,
      env,
      sourceIdentity,
    ) !== null;
  };

  try {
    await fs.link(displacedIndexPath, indexPath);
    await removeDisplacedIndex();
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    if (code === 'EEXIST') {
      if (await keepValidPublishedIndex()) {
        await removeDisplacedIndex();
        return;
      }
      throw error;
    }
    if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
      throw error;
    }
  }

  try {
    await fs.copyFile(displacedIndexPath, indexPath, fs.constants.COPYFILE_EXCL);
    await removeDisplacedIndex();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' && await keepValidPublishedIndex()) {
      await removeDisplacedIndex();
      return;
    }
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function createCurrentCatalogCacheSelectorIndexRecord(
  entry: Pick<CurrentCatalogCacheEntry, 'cacheKey' | 'selectorKey' | 'metadata' | 'observation'>,
  validatedAt: string,
): CurrentCatalogCacheSelectorIndexRecord {
  return entry.metadata.version === 2
    ? {
        version: 2,
        selectorKey: entry.selectorKey,
        cacheKey: entry.cacheKey,
        publicationId: entry.metadata.publicationId,
        validatedAt,
        ...(entry.observation?.sourceIdentity
          ? { sourceIdentity: entry.observation.sourceIdentity }
          : {}),
        ...(entry.observation ? { observation: entry.observation } : {}),
      }
    : {
        version: 1,
        selectorKey: entry.selectorKey,
        cacheKey: entry.cacheKey,
        validatedAt,
      };
}

function shouldKeepNewerCurrentCatalogObservation(
  current: CurrentCatalogCacheEntry,
  candidate: Pick<CurrentCatalogCacheEntry, 'metadata' | 'observation'>,
): boolean {
  const currentOrder = current.observation?.observationOrder;
  const candidateOrder = candidate.observation?.observationOrder;
  if (currentOrder === undefined || candidateOrder === undefined) {
    return false;
  }
  return currentOrder >= candidateOrder;
}

async function writeCurrentCatalogCacheSelectorIndex(
  entry: Pick<CurrentCatalogCacheEntry, 'cacheKey' | 'selectorKey' | 'metadata' | 'observation'>,
  validatedAt: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const selectorsDir = resolveCurrentCatalogCacheSelectorsDir(env);
  const sourceIdentity = entry.observation?.sourceIdentity;
  const selectorHash = buildCurrentCatalogSelectorHashFromKey(
    entry.selectorKey,
    sourceIdentity,
  );
  const indexPath = resolveCurrentCatalogCacheSelectorIndexPath(selectorHash, env);
  await fs.ensureDir(selectorsDir);
  signal?.throwIfAborted();
  const currentIndex = await readJsonFileIfExistsSafe<unknown>(indexPath);
  const currentEntry = await readCurrentCatalogCacheEntryFromSelectorIndex(
    entry.selectorKey,
    currentIndex,
    env,
    sourceIdentity,
  );
  if (currentEntry && shouldKeepNewerCurrentCatalogObservation(currentEntry, entry)) {
    return;
  }
  const stagedIndexPath = path.join(
    selectorsDir,
    `.${selectorHash}-${crypto.randomUUID()}.tmp`,
  );
  const displacedIndexPath = `${stagedIndexPath}.old`;
  let displacedIndex = false;
  let indexPublished = false;
  try {
    const index = createCurrentCatalogCacheSelectorIndexRecord(entry, validatedAt);
    await writeJsonFile(stagedIndexPath, index);
    signal?.throwIfAborted();
    try {
      await fs.rename(stagedIndexPath, indexPath);
      indexPublished = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') {
        throw error;
      }
      await fs.rename(indexPath, displacedIndexPath).catch((renameError: NodeJS.ErrnoException) => {
        if (renameError.code !== 'ENOENT') {
          throw renameError;
        }
      });
      displacedIndex = await fs.pathExists(displacedIndexPath);
      signal?.throwIfAborted();
      await fs.rename(stagedIndexPath, indexPath);
      indexPublished = true;
    }
  } catch (error) {
    if (displacedIndex) {
      await restoreDisplacedCurrentCatalogCacheSelectorIndex(
        displacedIndexPath,
        indexPath,
        entry.selectorKey,
        env,
        sourceIdentity,
      );
      displacedIndex = false;
    }
    throw error;
  } finally {
    await fs.remove(stagedIndexPath);
    if (displacedIndex && indexPublished) {
      await fs.remove(displacedIndexPath);
    }
  }
}

async function markCurrentCatalogCacheEntryValidatedWithLease(
  entry: CurrentCatalogCacheEntry,
  env: NodeJS.ProcessEnv,
  validatedAt = new Date().toISOString(),
  observation = entry.observation,
  signal?: AbortSignal,
): Promise<CurrentCatalogCacheEntry> {
  signal?.throwIfAborted();
  const { observation: _storedObservation, ...unobservedEntry } = entry;
  const observedEntry = isCurrentCatalogCacheObservationForEntry(observation, entry)
    ? { ...unobservedEntry, observation }
    : unobservedEntry;
  await writeCurrentCatalogCacheSelectorIndex(observedEntry, validatedAt, env, signal);
  return entry.metadata.version === 2
    ? { ...observedEntry, validatedAt }
    : { ...unobservedEntry, validatedAt };
}

export async function markCurrentCatalogCacheEntryValidated(
  entry: CurrentCatalogCacheEntry,
  env: NodeJS.ProcessEnv = process.env,
  validatedAt = new Date().toISOString(),
  observation = entry.observation,
  signal?: AbortSignal,
): Promise<CurrentCatalogCacheEntry> {
  const lease = await acquireCurrentCatalogCacheLease(env, { signal });
  try {
    return await markCurrentCatalogCacheEntryValidatedWithLease(
      entry,
      env,
      validatedAt,
      observation,
      signal,
    );
  } finally {
    await lease.release();
  }
}

async function readConcurrentCurrentCatalogCacheSelectorIndex(
  selectorKey: string,
  indexPath: string,
  env: NodeJS.ProcessEnv,
  sourceIdentity?: string,
): Promise<CurrentCatalogCacheEntry | null> {
  const deadline = Date.now() + CURRENT_CATALOG_CONCURRENT_INDEX_WAIT_MS;
  while (true) {
    const index = await readJsonFileIfExistsSafe<unknown>(indexPath);
    const entry = await readCurrentCatalogCacheEntryFromSelectorIndex(
      selectorKey,
      index,
      env,
      sourceIdentity,
    );
    if (entry) {
      return entry;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      Math.min(CURRENT_CATALOG_CONCURRENT_INDEX_POLL_MS, remainingMs),
    ));
  }
}

async function hasCurrentCatalogCacheSelectorDisplacementMarker(
  selectorHash: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const entries = await fs.readdir(resolveCurrentCatalogCacheSelectorsDir(env)).catch(() => [] as string[]);
  return entries.some((entryName) =>
    parseCurrentCatalogCacheSelectorDisplacementMarker(entryName)?.selectorHash === selectorHash);
}

export async function readCurrentCatalogCacheEntryBySelector(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv = process.env,
  sourceIdentity?: string,
): Promise<CurrentCatalogCacheEntry | null> {
  const selectorKey = serializeCatalogSelectorForCache(selector);
  const selectorHash = buildCurrentCatalogSelectorHash(selector, sourceIdentity);
  const indexPath = resolveCurrentCatalogCacheSelectorIndexPath(selectorHash, env);
  const index = await readJsonFileIfExistsSafe<unknown>(indexPath);
  const indexedEntry = await readCurrentCatalogCacheEntryFromSelectorIndex(
    selectorKey,
    index,
    env,
    sourceIdentity,
  );
  if (indexedEntry) {
    return indexedEntry;
  }

  let newest: CurrentCatalogCacheEntry | null = null;
  if (sourceIdentity === undefined) {
    const entriesDir = resolveCurrentCatalogCacheEntriesDir(env);
    const entries = await fs.readdir(entriesDir).catch(() => [] as string[]);
    for (const cacheKey of entries) {
      const candidate = await readCurrentCatalogCacheEntryByKey(cacheKey, selectorKey, env);
      if (
        candidate?.metadata.version === 1 &&
        (!newest || Date.parse(candidate.metadata.createdAt) > Date.parse(newest.metadata.createdAt))
      ) {
        newest = candidate;
      }
    }
  }
  if (!newest) {
    if (await hasCurrentCatalogCacheSelectorDisplacementMarker(selectorHash, env)) {
      return readConcurrentCurrentCatalogCacheSelectorIndex(
        selectorKey,
        indexPath,
        env,
        sourceIdentity,
      );
    }

    // A publisher can remove its displacement marker immediately after it
    // publishes the replacement index. Re-read once before reporting a miss.
    const currentIndex = await readJsonFileIfExistsSafe<unknown>(indexPath);
    return readCurrentCatalogCacheEntryFromSelectorIndex(
      selectorKey,
      currentIndex,
      env,
      sourceIdentity,
    );
  }
  return newest;
}

export async function readCurrentCatalogCacheEntry(
  identity: CurrentCatalogCacheIdentity,
  env: NodeJS.ProcessEnv = process.env,
  sourceIdentity?: string,
): Promise<CurrentCatalogCacheEntry | null> {
  const selectorKey = serializeCatalogSelectorForCache(identity.selector);
  const cacheKey = buildCurrentCatalogCacheKey(identity);
  const entry = await readCurrentCatalogCacheEntryByKey(cacheKey, selectorKey, env);
  if (!entry) {
    return null;
  }

  const { metadata } = entry;

  if (
    serializeCatalogSelectorForCache(metadata.selector) !== selectorKey ||
    metadata.channel !== identity.channel ||
    metadata.catalogVersion !== identity.catalogVersion ||
    metadata.minAwVersion !== identity.minAwVersion ||
    metadata.schemaVersion !== identity.schemaVersion ||
    metadata.historySchemaVersion !== identity.historySchemaVersion ||
    metadata.sidecarIntegrity !== identity.sidecarIntegrity ||
    metadata.fullIntegrity !== identity.fullIntegrity
  ) {
    return null;
  }

  const selectorIndex = await readJsonFileIfExistsSafe<unknown>(
    resolveCurrentCatalogCacheSelectorIndexPath(
      buildCurrentCatalogSelectorHash(identity.selector, sourceIdentity),
      env,
    ),
  );
  return applyCurrentCatalogCacheSelectorIndex(entry, selectorIndex, sourceIdentity) ??
    (entry.metadata.version === 1 && sourceIdentity === undefined ? entry : null);
}

async function writeCurrentCatalogCacheEntryWithLease(
  options: CurrentCatalogCacheIdentity & {
    sourceRoot: string;
    env?: NodeJS.ProcessEnv;
    observation?: CurrentCatalogCacheObservation;
    signal?: AbortSignal;
    validateExisting?: (rootDir: string) => Promise<boolean>;
  },
): Promise<CurrentCatalogCacheEntry> {
  const env = options.env ?? process.env;
  options.signal?.throwIfAborted();
  const selectorKey = serializeCatalogSelectorForCache(options.selector);
  const cacheKey = buildCurrentCatalogCacheKey(options);
  const entriesDir = resolveCurrentCatalogCacheEntriesDir(env);
  const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
  await fs.ensureDir(stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(stagingParent, `${cacheKey}-`));
  const finalEntryDir = resolveCurrentCatalogCacheEntryDir(cacheKey, env);
  const finalRootDir = getCurrentCatalogCacheRootDir(finalEntryDir);
  const metadataPath = getCurrentCatalogCacheMetadataPath(finalEntryDir);
  let publishedByThisWriter = false;

  try {
    await fs.ensureDir(entriesDir);
    options.signal?.throwIfAborted();
    const stagedRootDir = getCurrentCatalogCacheRootDir(stagingDir);
    await fs.copy(options.sourceRoot, stagedRootDir);
    options.signal?.throwIfAborted();

    const manifestPath = path.join(stagedRootDir, CURRENT_CATALOG_MANIFEST_FILE);
    const manifestDigest = createSha256Digest(await fs.readFile(manifestPath));
    const metadata: CurrentCatalogCacheEntryRecordV2 = {
      version: 2,
      publicationId: crypto.randomUUID(),
      selector: options.selector,
      channel: options.channel,
      catalogVersion: options.catalogVersion,
      minAwVersion: options.minAwVersion,
      schemaVersion: options.schemaVersion,
      historySchemaVersion: options.historySchemaVersion,
      sidecarIntegrity: options.sidecarIntegrity,
      fullIntegrity: options.fullIntegrity,
      manifestDigest,
      createdAt: new Date().toISOString(),
    };
    await writeJsonFile(getCurrentCatalogCacheMetadataPath(stagingDir), metadata);
    options.signal?.throwIfAborted();

    for (let attempt = 0; attempt < 4 && !publishedByThisWriter; attempt += 1) {
      try {
        await fs.rename(stagingDir, finalEntryDir);
        publishedByThisWriter = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') {
          throw error;
        }
        const existing = await readCurrentCatalogCacheEntryByKey(cacheKey, selectorKey, env);
        if (existing && await validateCurrentCatalogCacheEntryForReuse(
          existing,
          options.validateExisting,
        )) {
          return markCurrentCatalogCacheEntryValidatedWithLease(
            existing,
            env,
            new Date().toISOString(),
            options.observation,
            options.signal,
          );
        }
        const displaced = path.join(stagingParent, `corrupt-${cacheKey}-${crypto.randomUUID()}`);
        await fs.rename(finalEntryDir, displaced).catch((renameError: NodeJS.ErrnoException) => {
          if (renameError.code !== 'ENOENT') {
            throw renameError;
          }
        });
        const displacedEntry = await readCurrentCatalogCacheEntryAt(
          cacheKey,
          selectorKey,
          displaced,
        );
        if (displacedEntry && await validateCurrentCatalogCacheEntryForReuse(
          displacedEntry,
          options.validateExisting,
        )) {
          await restoreQuarantinedCurrentCatalogCacheEntry(displaced, finalEntryDir);
        } else {
          await fs.remove(displaced);
        }
        options.signal?.throwIfAborted();
      }
    }
    if (!publishedByThisWriter) {
      throw new Error(`Unable to publish current catalog cache entry ${cacheKey}.`);
    }
    options.signal?.throwIfAborted();

    const entry = {
      cacheKey,
      selectorKey,
      rootDir: finalRootDir,
      metadataPath,
      metadata,
      validatedAt: metadata.createdAt,
      ...(options.observation ? { observation: options.observation } : {}),
    };
    return markCurrentCatalogCacheEntryValidatedWithLease(
      entry,
      env,
      metadata.createdAt,
      options.observation,
      options.signal,
    );
  } finally {
    await fs.remove(stagingDir);
  }
}

export async function writeCurrentCatalogCacheEntry(
  options: CurrentCatalogCacheIdentity & {
    sourceRoot: string;
    env?: NodeJS.ProcessEnv;
    observation?: CurrentCatalogCacheObservation;
    signal?: AbortSignal;
    validateExisting?: (rootDir: string) => Promise<boolean>;
  },
): Promise<CurrentCatalogCacheEntry> {
  const env = options.env ?? process.env;
  const lease = await acquireCurrentCatalogCacheLease(env, { signal: options.signal });
  try {
    return await writeCurrentCatalogCacheEntryWithLease(options);
  } finally {
    await lease.release();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isCatalogChannel(value: unknown): value is CatalogChannel {
  return value === 'latest' || value === 'beta';
}

function isStrictSemVerString(value: unknown): value is CliVersion {
  return typeof value === 'string' && tryParseStrictSemVer(value) !== null;
}

function isCatalogSelectorOverrideSource(
  value: unknown,
): value is NonNullable<CatalogSelector['overrideSource']> {
  return value === 'option:catalog-channel' ||
    value === 'option:channel-alias' ||
    value === 'option:catalog-version' ||
    value === 'env:AW_CATALOG_CHANNEL' ||
    value === 'env:AW_CATALOG_VERSION';
}

function isCatalogSelector(value: unknown): value is CatalogSelector {
  if (
    !isRecord(value) ||
    !isStrictSemVerString(value.cliVersion) ||
    !isCatalogChannel(value.defaultChannel) ||
    (value.overrideSource !== undefined && !isCatalogSelectorOverrideSource(value.overrideSource))
  ) {
    return false;
  }

  if (value.kind === 'default') {
    return value.requestedChannel === undefined && value.requestedCatalogVersion === undefined;
  }

  if (value.kind === 'distTag') {
    return isCatalogChannel(value.requestedChannel) && value.requestedCatalogVersion === undefined;
  }

  if (value.kind === 'exactVersion') {
    return isStrictSemVerString(value.requestedCatalogVersion) && value.requestedChannel === undefined;
  }

  return false;
}

function isLocalMarketplaceResolvedCatalog(
  value: unknown,
): value is NonNullable<LocalMarketplaceConfig['resolvedCatalog']> {
  return (
    isRecord(value) &&
    isCatalogChannel(value.channel) &&
    isStrictSemVerString(value.catalogVersion) &&
    isStrictSemVerString(value.minAwVersion) &&
    (value.historySchemaVersion === null || Number.isInteger(value.historySchemaVersion))
  );
}

function resolveLocalMarketplaceResolvedCatalog(
  value: Pick<
    CatalogResolution | CatalogResolutionFailure,
    'channel' | 'catalogVersion' | 'minAwVersion' | 'historySchemaVersion'
  >,
): NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null {
  if (
    value.channel === undefined ||
    value.catalogVersion === undefined ||
    value.minAwVersion === undefined
  ) {
    return null;
  }

  return {
    channel: value.channel,
    catalogVersion: value.catalogVersion,
    minAwVersion: value.minAwVersion,
    historySchemaVersion: value.historySchemaVersion ?? null,
  };
}

function resolveDefaultLocalMarketplaceCatalogSelector(cliVersion: CliVersion): CatalogSelector {
  return {
    kind: 'default',
    cliVersion,
    defaultChannel: (tryParseStrictSemVer(cliVersion)?.prerelease.length ?? 0) > 0
      ? 'beta'
      : 'latest',
  };
}

function localMarketplaceCatalogSelectorMatches(
  config: LocalMarketplaceConfig,
  expectedSelector: CatalogSelector,
  expectedResolvedCatalog?: NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null,
): boolean {
  if (
    serializeCatalogSelectorForReuse(config.catalogSelector) !==
    serializeCatalogSelectorForReuse(expectedSelector)
  ) {
    return false;
  }

  if (
    expectedSelector.kind === 'exactVersion' ||
    expectedResolvedCatalog === undefined ||
    expectedResolvedCatalog === null
  ) {
    return true;
  }

  return (
    config.resolvedCatalog?.channel === expectedResolvedCatalog.channel &&
    config.resolvedCatalog.catalogVersion === expectedResolvedCatalog.catalogVersion &&
    config.resolvedCatalog.minAwVersion === expectedResolvedCatalog.minAwVersion &&
    config.resolvedCatalog.historySchemaVersion === expectedResolvedCatalog.historySchemaVersion
  );
}

function serializeCatalogSelectorForReuse(selector: CatalogSelector): string {
  if (selector.kind === 'exactVersion') {
    return JSON.stringify({
      kind: 'exactVersion',
      cliVersion: selector.cliVersion,
      requestedCatalogVersion: selector.requestedCatalogVersion,
    });
  }

  return JSON.stringify({
    kind: 'channel',
    cliVersion: selector.cliVersion,
    resolvedChannel: selector.requestedChannel ?? selector.defaultChannel,
  });
}

const LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS = new Set([
  'catalog-cache',
  'plugin-config',
  'lifecycle-active',
]);

const LOCAL_MARKETPLACE_ALREADY_STAGED_STATE_DIRS = new Set([
  'catalog-cache',
  'plugin-config',
  'lifecycle-active',
]);

const LOCAL_MARKETPLACE_DEFERRED_STATE_DIRS = new Set(['catalog-cache']);

async function listFilesRecursively(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.name === 'config.json') {
      continue;
    }
    if (LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS.has(entry.name)) {
      continue;
    }

    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nestedFiles = await listFilesRecursively(entryPath);
      files.push(
        ...nestedFiles.map((nestedFile) => path.join(entry.name, nestedFile).split(path.sep).join('/')),
      );
      continue;
    }

    files.push(entry.name);
  }

  return files.sort();
}

export async function calculateBundleFingerprint(rootDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const files = await listFilesRecursively(rootDir);

  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(rootDir, relativePath)));
    hash.update('\0');
  }

  return `sha256:${hash.digest('hex')}`;
}

export async function validateLocalMarketplaceLayout(rootDir: string): Promise<void> {
  await validateBundleLayout(rootDir, { ownerMarkerPolicy: 'ignore' });
}

async function copyBundleToStaging(embeddedRoot: string, stagingRoot: string): Promise<void> {
  await fs.copy(path.join(embeddedRoot, '.claude-plugin'), path.join(stagingRoot, '.claude-plugin'));
  await fs.copy(path.join(embeddedRoot, '.agents'), path.join(stagingRoot, '.agents'));
  await fs.copy(path.join(embeddedRoot, 'plugins'), path.join(stagingRoot, 'plugins'));
}

function normalizePluginRelativeDirectory(value: unknown, fallback: string): string | null {
  const raw = typeof value === 'string' && value.trim() !== '' ? value : fallback;
  const normalized = path.posix.normalize(raw.replace(/^\.\//u, ''));
  return normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)
    ? null
    : normalized;
}

async function assertOverlayTreeHasNoSymlinks(root: string): Promise<void> {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Dynamic Skill overlay 不能包含符号链接：${entryPath}`);
      }
      if (entry.isDirectory()) pending.push(entryPath);
    }
  }
}

async function replayOwnedDynamicSkillOverlays(
  sourceRoot: string,
  stagingRoot: string,
): Promise<void> {
  const sourcePluginsRoot = path.join(sourceRoot, 'plugins');
  const pluginEntries = await fs.readdir(sourcePluginsRoot, { withFileTypes: true }).catch(() => []);
  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory() || pluginEntry.isSymbolicLink()) continue;
    const pluginName = pluginEntry.name;
    const sourcePluginRoot = path.join(sourcePluginsRoot, pluginName);
    const stagingPluginRoot = path.join(stagingRoot, 'plugins', pluginName);
    if (!await fs.pathExists(stagingPluginRoot)) continue;
    const sourceManifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    ).catch(() => null) as Record<string, unknown> | null;
    const targets = (sourceManifest?.artifacts as { targets?: unknown[] } | undefined)?.targets ?? [];
    const dynamicKeys = new Set(targets.flatMap((target) => {
      if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
      const record = target as Record<string, unknown>;
      return record.platform === 'codex'
        && record.target === 'codex.skill'
        && Array.isArray(record.scopes)
        && record.scopes.includes('user')
        && typeof record.skillKey === 'string'
        ? [record.skillKey]
        : [];
    }));
    if (dynamicKeys.size === 0) continue;
    const sourcePlatformManifest = await fs.readJson(
      path.join(sourcePluginRoot, '.codex-plugin', 'plugin.json'),
    ).catch(() => null) as Record<string, unknown> | null;
    const stagingPlatformManifest = await fs.readJson(
      path.join(stagingPluginRoot, '.codex-plugin', 'plugin.json'),
    ).catch(() => null) as Record<string, unknown> | null;
    const sourceSkillsRoot = normalizePluginRelativeDirectory(
      sourcePlatformManifest?.skills,
      'codex/skills',
    );
    if (!sourceSkillsRoot) continue;
    let replayed = false;
    for (const skillKey of dynamicKeys) {
      const sourceSkillRoot = path.join(sourcePluginRoot, ...sourceSkillsRoot.split('/'), skillKey);
      const marker = await readSkillOwnerMarker({
        skillRoot: sourceSkillRoot,
        allowedRoot: path.dirname(sourceSkillRoot),
      }).catch(() => null);
      if (
        marker?.plugin !== pluginName
        || marker.artifactKey !== skillKey
        || marker.platform !== 'codex'
        || marker.scope !== 'user'
      ) continue;
      await assertOverlayTreeHasNoSymlinks(sourceSkillRoot);
      await fs.copy(
        sourceSkillRoot,
        path.join(stagingPluginRoot, ...sourceSkillsRoot.split('/'), skillKey),
        { overwrite: true, errorOnExist: false, dereference: false },
      );
      replayed = true;
    }
    if (replayed) {
      await fs.outputJson(
        path.join(stagingPluginRoot, '.codex-plugin', 'plugin.json'),
        {
          ...(stagingPlatformManifest ?? {}),
          skills: `./${sourceSkillsRoot}`,
        },
        { spaces: 2 },
      );
    }
  }
}

function isLocalMarketplaceConfig(value: unknown): value is LocalMarketplaceConfig {
  return (
    isRecord(value) &&
    value.version === 2 &&
    typeof value.initializedAt === 'string' &&
    typeof value.sourcePackage === 'string' &&
    typeof value.sourceVersion === 'string' &&
    isCatalogSelector(value.catalogSelector) &&
    (value.resolvedCatalog === undefined || isLocalMarketplaceResolvedCatalog(value.resolvedCatalog)) &&
    typeof value.bundleFingerprint === 'string'
  );
}

export async function readLocalMarketplaceConfig(rootDir: string): Promise<LocalMarketplaceConfig | null> {
  const rawConfig = await readJsonFileIfExistsSafe<unknown>(path.join(rootDir, 'config.json'));
  return isLocalMarketplaceConfig(rawConfig) ? rawConfig : null;
}

async function inspectLocalMarketplaceConfig(
  rootDir: string,
): Promise<LocalMarketplaceConfigInspection> {
  const configPath = path.join(rootDir, 'config.json');
  if (!(await fs.pathExists(configPath))) {
    return {
      state: 'missing',
      config: null,
      sourceVersion: null,
    };
  }

  let rawConfig: unknown;
  try {
    rawConfig = await fs.readJson(configPath);
  } catch {
    return {
      state: 'invalid',
      config: null,
      sourceVersion: undefined,
    };
  }

  if (isLocalMarketplaceConfig(rawConfig)) {
    return {
      state: 'valid',
      config: rawConfig,
      sourceVersion: rawConfig.sourceVersion,
    };
  }

  return {
    state: 'invalid',
    config: null,
    sourceVersion: isRecord(rawConfig) && typeof rawConfig.sourceVersion === 'string'
      ? rawConfig.sourceVersion
      : null,
  };
}

function classifyLocalSourceVersionStatus(options: {
  inspection: LocalMarketplaceConfigInspection;
  cliVersion: string;
}): LocalMarketplaceSourceVersionStatus {
  if (options.inspection.state === 'missing') {
    return 'absent';
  }

  if (options.inspection.sourceVersion === undefined) {
    return 'invalid';
  }
  if (typeof options.inspection.sourceVersion !== 'string' || options.inspection.sourceVersion.trim() === '') {
    return 'missing';
  }

  const parsedSourceVersion = tryParseStrictSemVer(options.inspection.sourceVersion);
  if (!parsedSourceVersion) {
    return 'invalid';
  }

  const relation = compareStrictSemVer(parsedSourceVersion.raw, options.cliVersion);
  if (relation > 0) {
    return 'ahead';
  }
  if (relation < 0) {
    return 'behind';
  }
  return 'equal';
}

async function inspectLocalMarketplaceState(
  env: NodeJS.ProcessEnv = process.env,
  bundleRootOverride?: string,
): Promise<LocalMarketplaceInspection> {
  const awHome = resolveAwHome(env);
  const embeddedRoot = bundleRootOverride ?? await resolveEmbeddedPluginsRoot();
  const [packageInfo, bundleFingerprint, configInspection] = await Promise.all([
    readCliPackageInfo(),
    calculateBundleFingerprint(embeddedRoot),
    inspectLocalMarketplaceConfig(awHome),
  ]);
  const sourceVersionStatus = classifyLocalSourceVersionStatus({
    inspection: configInspection,
    cliVersion: packageInfo.version,
  });
  const validConfig = configInspection.state === 'valid' ? configInspection.config : null;

  let layoutHealthy = false;
  let layoutError: string | undefined;
  if (
    validConfig &&
    sourceVersionStatus === 'equal' &&
    validConfig.bundleFingerprint === bundleFingerprint
  ) {
    try {
      await validateLocalMarketplaceLayout(awHome);
      layoutHealthy = true;
    } catch (error) {
      layoutError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    awHome,
    embeddedRoot,
    packageInfo,
    bundleFingerprint,
    configInspection,
    sourceVersionStatus,
    layoutHealthy,
    ...(layoutError ? { layoutError } : {}),
  };
}

async function resolveCurrentCatalogBundleRoot(
  env: NodeJS.ProcessEnv,
  catalogResolution?: CatalogResolution,
): Promise<{
  rootDir: string;
  selector: CatalogSelector | undefined;
  resolvedCatalog: NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null;
}> {
  let catalog = catalogResolution;
  if (!catalog) {
    const { resolveCurrentCatalog } = await import('./plugin-catalog.js');
    catalog = await resolveCurrentCatalog(env);
  }
  await validateBundleLayout(catalog.rootDir);
  return {
    rootDir: catalog.rootDir,
    selector: catalog.selector,
    resolvedCatalog: resolveLocalMarketplaceResolvedCatalog(catalog),
  };
}

async function tryReuseExistingLocalMarketplace(
  env: NodeJS.ProcessEnv,
  expectedSelector: CatalogSelector,
  expectedResolvedCatalog?: NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null,
): Promise<EnsureLocalMarketplaceResult | null> {
  const awHome = resolveAwHome(env);
  const [packageInfo, config] = await Promise.all([
    readCliPackageInfo(),
    readLocalMarketplaceConfig(awHome),
  ]);

  if (
    !config ||
    config.sourcePackage !== packageInfo.name ||
    config.sourceVersion !== packageInfo.version ||
    !localMarketplaceCatalogSelectorMatches(config, expectedSelector, expectedResolvedCatalog)
  ) {
    return null;
  }

  try {
    await validateLocalMarketplaceLayout(awHome);
    return {
      rootDir: awHome,
      changed: false,
      warnings: [],
    };
  } catch {
    return null;
  }
}

export async function resolveReadOnlyCatalogResolution(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    freshnessPolicy?: CatalogFreshnessPolicy;
    catalogResolution?: CatalogResolution;
  } = {},
): Promise<CatalogResolution> {
  if (options.catalogResolution) {
    await validateBundleLayout(options.catalogResolution.rootDir);
    return options.catalogResolution;
  }

  const hasSelectorOverride = hasCatalogSelectorOverride(env);
  const { isCatalogResolutionError, resolveCurrentCatalog } = await import('./plugin-catalog.js');
  let currentCatalogError: unknown = null;
  let fallbackSelector: CatalogSelector | null = null;
  let fallbackResolvedCatalog: NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null = null;
  try {
    return options.freshnessPolicy === undefined
      ? await resolveCurrentCatalog(env)
      : await resolveCurrentCatalog(env, { freshnessPolicy: options.freshnessPolicy });
  } catch (error) {
    if (!isCatalogResolutionError(error) || error.resolution.reasonCode !== 'catalogUnavailable') {
      throw error;
    }
    currentCatalogError = error;
    fallbackSelector = error.resolution.selector;
    fallbackResolvedCatalog = resolveLocalMarketplaceResolvedCatalog(error.resolution);
  }

  if (fallbackSelector) {
    const reusableMarketplace = await tryReuseExistingLocalMarketplace(
      env,
      fallbackSelector,
      fallbackResolvedCatalog,
    );
    if (reusableMarketplace) {
      return {
        rootDir: reusableMarketplace.rootDir,
        source: 'local',
        selector: fallbackSelector,
      };
    }
  }

  if (!hasSelectorOverride) {
    try {
      const embeddedRoot = await resolveEmbeddedPluginsRoot();
      await validateBundleLayout(embeddedRoot);
      return {
        rootDir: embeddedRoot,
        source: 'embedded',
        selector: fallbackSelector,
      };
    } catch {
      // Preserve the current catalog failure as the actionable error when the
      // embedded bundle is also unavailable or invalid.
    }
  }

  throw currentCatalogError;
}

async function isFreshLocalMarketplace(
  awHome: string,
  sourceVersion: string,
  bundleFingerprint: string,
): Promise<boolean> {
  const config = await readLocalMarketplaceConfig(awHome);
  if (!config) {
    return false;
  }

  if (config.sourceVersion !== sourceVersion || config.bundleFingerprint !== bundleFingerprint) {
    return false;
  }

  try {
    await validateLocalMarketplaceLayout(awHome);
    return true;
  } catch {
    return false;
  }
}

async function preserveLocalRuntimeStateDirectories(
  sourceRoot: string,
  targetRoot: string,
  options: { skip?: ReadonlySet<string> } = {},
): Promise<void> {
  for (const directoryName of LOCAL_MARKETPLACE_RUNTIME_STATE_DIRS) {
    if (options.skip?.has(directoryName)) {
      continue;
    }
    const sourceDir = path.join(sourceRoot, directoryName);
    if (!(await fs.pathExists(sourceDir))) {
      continue;
    }

    await fs.copy(sourceDir, path.join(targetRoot, directoryName), {
      overwrite: true,
      errorOnExist: false,
    });
  }
}

function parseCurrentCatalogCacheSelectorDisplacementMarker(
  entryName: string,
): { selectorHash: string } | null {
  const match = /^\.([a-f0-9]{64})-([a-f0-9-]{36})\.tmp\.old$/.exec(entryName);
  return match && isPublicationId(match[2]!)
    ? { selectorHash: match[1]! }
    : null;
}

async function restoreStagedCurrentCatalogCacheSelectorIndexes(stagingRoot: string): Promise<void> {
  const selectorsDir = path.join(stagingRoot, 'catalog-cache', 'selectors');
  const entries = await fs.readdir(selectorsDir).catch(() => [] as string[]);
  for (const entryName of entries) {
    const marker = parseCurrentCatalogCacheSelectorDisplacementMarker(entryName);
    if (!marker) {
      continue;
    }

    const markerPath = path.join(selectorsDir, entryName);
    const indexPath = path.join(selectorsDir, `${marker.selectorHash}.json`);
    if (!(await fs.pathExists(indexPath))) {
      await fs.copyFile(markerPath, indexPath, fs.constants.COPYFILE_EXCL);
    }
    await fs.remove(markerPath);
  }
}

async function preserveLocalCatalogCache(sourceRoot: string, stagingRoot: string): Promise<void> {
  const sourceDir = path.join(sourceRoot, 'catalog-cache');
  if (!(await fs.pathExists(sourceDir))) {
    return;
  }
  await fs.copy(sourceDir, path.join(stagingRoot, 'catalog-cache'), {
    overwrite: true,
    errorOnExist: false,
  });
  await restoreStagedCurrentCatalogCacheSelectorIndexes(stagingRoot);
}

function resolveLocalMarketplaceStagingRoot(awHome: string): string {
  return assertTestWritablePath(
    path.join(path.dirname(awHome), '.aw-local-marketplace-staging'),
    'local marketplace staging root',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记 AW_HOME 同盘 staging 根。',
  );
}

function resolveLocalMarketplaceBackupRoot(targetDir: string): string {
  return assertTestWritablePath(
    path.join(path.dirname(targetDir), '.aw-local-marketplace-backups'),
    'local marketplace backup root',
    '用 createIsolatedTestEnv() 生成默认 AW_HOME，或通过 registerWritableStateRoot() 登记 AW_HOME 同盘 backup 根。',
  );
}

function createLocalMarketplaceBackupDirPath(targetDir: string): string {
  return path.join(
    resolveLocalMarketplaceBackupRoot(targetDir),
    `.aw-backup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

async function replaceDirectoryAtomically(
  targetDir: string,
  stagingDir: string,
): Promise<void> {
  const backupDir = createLocalMarketplaceBackupDirPath(targetDir);
  const failedTargetDir = path.join(
    path.dirname(backupDir),
    `.aw-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const targetExists = await fs.pathExists(targetDir);
  await fs.ensureDir(path.dirname(backupDir));

  try {
    if (targetExists) {
      await fs.move(targetDir, backupDir, { overwrite: true });
    }

    await fs.move(stagingDir, targetDir, { overwrite: true });
    if (targetExists) {
      await preserveLocalRuntimeStateDirectories(backupDir, targetDir, {
        skip: LOCAL_MARKETPLACE_ALREADY_STAGED_STATE_DIRS,
      });
      await fs.remove(backupDir);
    }
  } catch (error) {
    try {
      if (targetExists && await fs.pathExists(backupDir)) {
        if (await fs.pathExists(targetDir)) {
          await fs.move(targetDir, failedTargetDir, { overwrite: false });
        }
        await fs.move(backupDir, targetDir, { overwrite: true });
        await fs.remove(failedTargetDir);
      }
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    throw error;
  }
}

function localMarketplaceRequiresConfirmation(
  inspection: LocalMarketplaceInspection,
): boolean {
  return (
    inspection.sourceVersionStatus === 'missing' ||
    inspection.sourceVersionStatus === 'invalid' ||
    inspection.sourceVersionStatus === 'ahead'
  );
}

function createLocalMarketplaceOverwriteMessage(
  inspection: LocalMarketplaceInspection,
): string {
  if (
    inspection.configInspection.state === 'invalid' &&
    inspection.configInspection.sourceVersion === undefined
  ) {
    return `本地插件目录 ${inspection.awHome} 的 config.json 无法读取或 schema 不受支持，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
  }
  if (inspection.sourceVersionStatus === 'ahead') {
    return `本地插件目录 ${inspection.awHome} 的 sourceVersion ${inspection.configInspection.sourceVersion ?? 'unknown'} 高于当前 CLI 版本 ${inspection.packageInfo.version}。继续会用当前 embedded bundle 覆盖这份本地目录。`;
  }
  if (inspection.sourceVersionStatus === 'missing') {
    return `本地插件目录 ${inspection.awHome} 的 sourceVersion 缺失，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
  }
  return `本地插件目录 ${inspection.awHome} 的 sourceVersion ${inspection.configInspection.sourceVersion ?? 'unknown'} 不符合严格 SemVer 2.0.0，当前 CLI 无法安全判断是否应该覆盖。继续会用当前 embedded bundle 重建本地目录。`;
}

async function confirmLocalMarketplaceOverwrite(options: {
  inspection: LocalMarketplaceInspection;
  gate?: LocalMarketplaceGateOptions;
}): Promise<void> {
  const message = createLocalMarketplaceOverwriteMessage(options.inspection);
  await options.gate?.onNotice?.(message);

  if (!options.gate?.interactive || !options.gate.confirmOverwrite) {
    throw new Error(`${message} 非交互环境不会自动覆盖；请在交互模式下确认后重试。`);
  }

  const confirmed = await options.gate.confirmOverwrite({
    message: `${message} 是否继续覆盖？`,
    defaultValue: false,
  });
  if (!confirmed) {
    throw new Error('已取消覆盖本地插件目录，本次没有写入任何状态。');
  }
}

export interface EnsureLocalMarketplaceResult {
  rootDir: string;
  changed: boolean;
  warnings?: string[];
}

export async function ensureLocalMarketplace(
  env: NodeJS.ProcessEnv = process.env,
  gate?: LocalMarketplaceGateOptions,
  catalogResolution?: CatalogResolution,
): Promise<EnsureLocalMarketplaceResult> {
  return initializeLocalMarketplace({ force: false, env, gate, catalogResolution });
}

export async function initializeLocalMarketplace(
  options: {
    force: boolean;
    env?: NodeJS.ProcessEnv;
    gate?: LocalMarketplaceGateOptions;
    catalogResolution?: CatalogResolution;
  },
): Promise<EnsureLocalMarketplaceResult> {
  const env = options.env ?? process.env;
  let bundleRootOverride: string | undefined;
  let resolvedCatalogSelector: CatalogSelector | undefined;
  let resolvedCatalog: NonNullable<LocalMarketplaceConfig['resolvedCatalog']> | null = null;
  const resolveCurrentCatalogWithLocalFallback = async (): Promise<EnsureLocalMarketplaceResult | null> => {
    const { isCatalogResolutionError } = await import('./plugin-catalog.js');
    try {
      const resolved = await resolveCurrentCatalogBundleRoot(env, options.catalogResolution);
      bundleRootOverride = resolved.rootDir;
      resolvedCatalogSelector = resolved.selector;
      resolvedCatalog = resolved.resolvedCatalog;
      return null;
    } catch (error) {
      if (
        !options.force &&
        isCatalogResolutionError(error) &&
        error.resolution.reasonCode === 'catalogUnavailable'
      ) {
        const reusableMarketplace = await tryReuseExistingLocalMarketplace(
          env,
          error.resolution.selector,
          resolveLocalMarketplaceResolvedCatalog(error.resolution),
        );
        if (reusableMarketplace) {
          return reusableMarketplace;
        }
      }
      throw error;
    }
  };
  if (hasCatalogSelectorOverride(env)) {
    const reusableMarketplace = await resolveCurrentCatalogWithLocalFallback();
    if (reusableMarketplace) {
      return reusableMarketplace;
    }
  } else {
    try {
      const reusableMarketplace = await resolveCurrentCatalogWithLocalFallback();
      if (reusableMarketplace) {
        return reusableMarketplace;
      }
    } catch (error) {
      const { isCatalogResolutionError } = await import('./plugin-catalog.js');
      if (
        !isCatalogResolutionError(error) ||
        error.resolution.reasonCode !== 'catalogUnavailable'
      ) {
        throw error;
      }

      try {
        bundleRootOverride = await resolveEmbeddedPluginsRoot();
      } catch {
        throw error;
      }
    }
  }
  const inspection = await inspectLocalMarketplaceState(env, bundleRootOverride);
  const validConfig = inspection.configInspection.state === 'valid'
    ? inspection.configInspection.config
    : null;
  const expectedCatalogSelector = resolvedCatalogSelector ??
    resolveDefaultLocalMarketplaceCatalogSelector(inspection.packageInfo.version);

  if (
    !options.force &&
    validConfig &&
    inspection.sourceVersionStatus === 'equal' &&
    validConfig.bundleFingerprint === inspection.bundleFingerprint &&
    localMarketplaceCatalogSelectorMatches(
      validConfig,
      expectedCatalogSelector,
      resolvedCatalog,
    ) &&
    inspection.layoutHealthy
  ) {
    return {
      rootDir: inspection.awHome,
      changed: false,
      warnings: [],
    };
  }

  if (localMarketplaceRequiresConfirmation(inspection)) {
    await confirmLocalMarketplaceOverwrite({
      inspection,
      gate: options.gate,
    });
  }

  const stagingParent = resolveLocalMarketplaceStagingRoot(inspection.awHome);
  await fs.ensureDir(stagingParent);
  const stagingDir = await fs.mkdtemp(path.join(stagingParent, '.aw-staging-'));
  const warnings: string[] = [];

  try {
    await copyBundleToStaging(inspection.embeddedRoot, stagingDir);
    await replayOwnedDynamicSkillOverlays(inspection.awHome, stagingDir);
    await preserveLocalRuntimeStateDirectories(inspection.awHome, stagingDir, {
      skip: LOCAL_MARKETPLACE_DEFERRED_STATE_DIRS,
    });
    await writeJsonFile(path.join(stagingDir, 'config.json'), {
      version: 2,
      initializedAt: new Date().toISOString(),
      sourcePackage: inspection.packageInfo.name,
      sourceVersion: inspection.packageInfo.version,
      catalogSelector: expectedCatalogSelector,
      ...(resolvedCatalog ? { resolvedCatalog } : {}),
      bundleFingerprint: inspection.bundleFingerprint,
    } satisfies LocalMarketplaceConfig);
    await validateLocalMarketplaceLayout(stagingDir);
    const catalogCacheLease = await acquireCurrentCatalogCacheLease(env);
    try {
      await preserveLocalCatalogCache(inspection.awHome, stagingDir);
      await replaceDirectoryAtomically(inspection.awHome, stagingDir);
    } finally {
      await catalogCacheLease.release();
    }
  } catch (error) {
    await fs.remove(stagingDir);
    throw error;
  }

  return {
    rootDir: inspection.awHome,
    changed: true,
    warnings,
  };
}
