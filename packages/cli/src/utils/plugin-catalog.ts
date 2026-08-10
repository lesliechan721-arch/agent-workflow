import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import {
  CURRENT_CATALOG_FULL_PACKAGE,
  CURRENT_CATALOG_MANIFEST_FILE,
  CURRENT_CATALOG_MANIFEST_PACKAGE,
} from '../constants.js';
import type {
  CatalogChannel,
  CatalogFreshnessPolicy,
  CatalogManifest,
  CatalogResolution,
  CatalogResolutionFailure,
  CatalogSelector,
  CatalogVersion,
  CliVersion,
} from '../types.js';
import {
  buildCurrentCatalogCacheKey,
  type CurrentCatalogCacheEntry,
  type CurrentCatalogCacheIdentity,
  type CurrentCatalogCacheObservation,
  markCurrentCatalogCacheEntryValidated,
  readCliPackageInfo,
  readCurrentCatalogCacheEntry,
  readCurrentCatalogCacheEntryBySelector,
  reserveCurrentCatalogCacheObservationOrder,
  serializeCatalogSelectorForCache,
  writeCurrentCatalogCacheEntry,
} from './local-marketplace.js';
import { calculateCatalogEntryDigestsFromRoot } from './catalog-digests.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  resolvePluginsFromCatalog,
  tryParseStrictSemVer,
  validateCatalogManifest,
} from './manifest.js';
import {
  downloadCatalogPackageArchive,
  getCatalogPackageSourceRevisionForTests,
  hasCatalogPackageSourceOverrideForTests,
  resolveCatalogRegistryUrl,
  resolveCatalogPackageIdentityByDistTag,
  resolveCatalogPackageIdentityByVersion,
  type CatalogPackageArchive,
  type CatalogPackageArchiveIdentity,
} from './marketplace.js';
import {
  getEmbeddedPluginsRootOverrideForTests,
  getMarketplaceManifestPath,
  resolveAwHome,
  resolveCurrentCatalogCacheStagingDir,
} from './paths.js';
import {
  getCatalogFullPackageRoot,
  getCatalogSidecarPackageRoot,
} from './bundle-layout.js';

export interface ResolveCurrentCatalogOptions {
  cliVersion?: CliVersion;
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
  forceRefresh?: boolean;
  freshnessPolicy?: CatalogFreshnessPolicy;
  signal?: AbortSignal;
}

interface ResolveCurrentCatalogRuntimeOptions extends ResolveCurrentCatalogOptions {
  freshnessPolicy: NonNullable<ResolveCurrentCatalogOptions['freshnessPolicy']>;
  cacheTtlMs: number;
  remoteTimeoutMs: number;
  sourceIdentity: string;
}

interface ResolvedCatalogTarget {
  manifest: CatalogManifest;
  manifestText: string;
  sidecarIdentity: CatalogPackageArchiveIdentity;
  sidecarManifestPackage: NonNullable<CatalogResolution['sidecarManifestPackage']>;
  observationOrder?: number;
}

interface CurrentCatalogResolutionMemoEntry {
  promise: Promise<CatalogResolution>;
  settled: boolean;
  validatedAtMs?: number;
  capability: 'cacheOnly' | 'remoteChecked';
  controller: AbortController;
  waiterCount: number;
}

const currentCatalogResolutionMemo = new Map<string, CurrentCatalogResolutionMemoEntry>();

const DEFAULT_CATALOG_CACHE_TTL_MS = 300_000;
const MAX_CATALOG_CACHE_TTL_MS = 86_400_000;
const DEFAULT_CATALOG_REMOTE_TIMEOUT_MS = 5_000;

function readCatalogEnvironmentInteger(
  env: NodeJS.ProcessEnv,
  name: 'AW_CATALOG_CACHE_TTL_MS' | 'AW_CATALOG_REMOTE_TIMEOUT_MS',
  defaultValue: number,
  isValid: (value: number) => boolean,
  range: string,
): number {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return defaultValue;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(rawValue)) {
    throw new Error(`Invalid ${name}="${rawValue}": expected ${range}.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || !isValid(value)) {
    throw new Error(`Invalid ${name}="${rawValue}": expected ${range}.`);
  }
  return value;
}

function readCatalogRuntimePolicy(
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogOptions,
): {
  freshnessPolicy: NonNullable<ResolveCurrentCatalogOptions['freshnessPolicy']>;
  cacheTtlMs: number;
  remoteTimeoutMs: number;
} {
  const cacheTtlMs = readCatalogEnvironmentInteger(
    env,
    'AW_CATALOG_CACHE_TTL_MS',
    DEFAULT_CATALOG_CACHE_TTL_MS,
    (value) => value >= 0 && value <= MAX_CATALOG_CACHE_TTL_MS,
    'an integer in range 0..86400000',
  );
  const remoteTimeoutMs = readCatalogEnvironmentInteger(
    env,
    'AW_CATALOG_REMOTE_TIMEOUT_MS',
    DEFAULT_CATALOG_REMOTE_TIMEOUT_MS,
    (value) => value === 0 || (value >= 100 && value <= 60_000),
    '0 or an integer in range 100..60000',
  );
  return {
    freshnessPolicy: options.forceRefresh === true
      ? 'forceRemote'
      : options.freshnessPolicy ?? 'requireRemote',
    cacheTtlMs,
    remoteTimeoutMs,
  };
}

function buildCacheState(
  state: NonNullable<CatalogResolution['cacheState']>['state'],
  validatedAt: string,
  ttlMs: number,
): NonNullable<CatalogResolution['cacheState']> {
  return {
    state,
    validatedAt,
    ageMs: Math.max(0, Date.now() - Date.parse(validatedAt)),
    ttlMs,
  };
}

function throwIfRemoteAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) {
      throw signal.reason;
    }
    const error = new Error('Catalog remote resolution aborted.');
    error.name = 'AbortError';
    throw error;
  }
}

function calculateManifestTextDigest(manifestText: string): string {
  return `sha256:${crypto.createHash('sha256').update(manifestText).digest('hex')}`;
}

function isCompatibleWithCliVersion(
  cliVersion: CliVersion,
  minAwVersion: CliVersion,
): boolean {
  return compareStrictSemVer(cliVersion, minAwVersion) >= 0;
}

function isPrereleaseVersion(version: string): boolean {
  return (tryParseStrictSemVer(version)?.prerelease.length ?? 0) > 0;
}

export function resolveDefaultCatalogChannel(
  cliVersion: CliVersion,
): CatalogChannel {
  return isPrereleaseVersion(cliVersion) ? 'beta' : 'latest';
}

export function resolveCatalogSelector(
  options: {
    cliVersion: CliVersion;
    channel?: CatalogChannel;
    catalogVersion?: CatalogVersion;
  },
): CatalogSelector {
  if (options.channel && options.catalogVersion) {
    throw new Error('catalog channel 与 exact catalog version 互斥，不能同时指定。');
  }

  const cliVersion = assertStrictSemVer(options.cliVersion, 'catalog selector cliVersion');
  const defaultChannel = resolveDefaultCatalogChannel(cliVersion);

  if (options.catalogVersion) {
    return {
      kind: 'exactVersion',
      cliVersion,
      defaultChannel,
      requestedCatalogVersion: assertStrictSemVer(
        options.catalogVersion,
        'catalog selector requestedCatalogVersion',
      ),
    };
  }

  if (options.channel) {
    return {
      kind: 'distTag',
      cliVersion,
      defaultChannel,
      requestedChannel: options.channel,
    };
  }

  return {
    kind: 'default',
    cliVersion,
    defaultChannel,
  };
}

function getRequestedCatalogChannel(
  selector: CatalogSelector,
): CatalogChannel | null {
  if (selector.kind === 'exactVersion') {
    return null;
  }

  return selector.requestedChannel ?? selector.defaultChannel;
}

function createCatalogResolutionErrorMessage(
  failure: CatalogResolutionFailure,
): string {
  if (failure.reason.trim() !== '') {
    return failure.reason;
  }
  return failure.reasonCode;
}

export class CatalogResolutionError extends Error {
  readonly resolution: CatalogResolutionFailure;

  constructor(resolution: CatalogResolutionFailure) {
    super(createCatalogResolutionErrorMessage(resolution));
    this.name = 'CatalogResolutionError';
    this.resolution = resolution;
  }
}

export function isCatalogResolutionError(
  error: unknown,
): error is CatalogResolutionError {
  return error instanceof CatalogResolutionError;
}

function throwCatalogResolutionFailure(
  failure: CatalogResolutionFailure,
): never {
  throw new CatalogResolutionError(failure);
}

function createRemoteFailure(
  stage: NonNullable<CatalogResolutionFailure['remoteFailure']>['stage'],
  message: string,
  options: {
    packageName?: string;
    packageVersion?: CatalogVersion;
    integrity?: string;
  } = {},
): NonNullable<CatalogResolutionFailure['remoteFailure']> {
  return {
    stage,
    message,
    ...(options.packageName ? { packageName: options.packageName } : {}),
    ...(options.packageVersion ? { packageVersion: options.packageVersion } : {}),
    ...(options.integrity ? { integrity: options.integrity } : {}),
  };
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class CatalogRemoteDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Catalog remote resolution exceeded AW_CATALOG_REMOTE_TIMEOUT_MS=${timeoutMs}.`);
    this.name = 'CatalogRemoteDeadlineError';
  }
}

function readSelectorOverrides(
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogOptions,
): {
  cliVersion?: CliVersion;
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
  overrideSource?: CatalogSelector['overrideSource'];
} {
  const envChannel = env.AW_CATALOG_CHANNEL;
  const envCatalogVersion = env.AW_CATALOG_VERSION;

  return {
    cliVersion: options.cliVersion ?? env.AW_CLI_VERSION,
    channel: options.channel ?? (
      envChannel === 'latest' || envChannel === 'beta'
        ? envChannel
        : undefined
    ),
    catalogVersion: options.catalogVersion ?? envCatalogVersion,
    overrideSource: options.catalogVersion !== undefined
      ? 'option:catalog-version'
      : options.channel !== undefined
        ? 'option:catalog-channel'
        : envCatalogVersion !== undefined
          ? 'env:AW_CATALOG_VERSION'
          : envChannel === 'latest' || envChannel === 'beta'
            ? 'env:AW_CATALOG_CHANNEL'
            : undefined,
  };
}

async function resolveEffectiveCatalogSelector(
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogOptions,
): Promise<CatalogSelector> {
  const overrides = readSelectorOverrides(env, options);
  const cliVersion = overrides.cliVersion ?? (await readCliPackageInfo()).version;
  const selector = resolveCatalogSelector({
    cliVersion,
    channel: overrides.channel,
    catalogVersion: overrides.catalogVersion,
  });
  if (overrides.overrideSource) {
    selector.overrideSource = overrides.overrideSource;
  }
  return selector;
}

function buildCurrentCatalogMemoKey(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogRuntimeOptions,
): string {
  const payload = {
    selector: serializeCatalogSelectorForCache(selector),
    overrideSource: selector.overrideSource ?? null,
    awHome: resolveAwHome(env),
    sourceIdentity: options.sourceIdentity,
    npmUserConfig: env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || null,
    cwd: path.resolve(process.cwd()),
    home: env.HOME || null,
    userprofile: env.USERPROFILE || null,
    embeddedOverrideRoot: getEmbeddedPluginsRootOverrideForTests(),
    catalogPackageSourceRevision: getCatalogPackageSourceRevisionForTests(),
    remoteTimeoutMs: options.remoteTimeoutMs,
    forceRefresh: Boolean(options.forceRefresh),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function buildCatalogSourceIdentity(registryUrl: string): string {
  return `registry-sha256:${crypto.createHash('sha256').update(registryUrl).digest('hex')}`;
}

async function resolveCurrentCatalogUncached(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogRuntimeOptions,
  signal?: AbortSignal,
): Promise<CatalogResolution> {
  if (!hasCatalogPackageSourceOverrideForTests()) {
    const fixtureCatalog = await tryResolveFixtureCatalogOverride(selector);
    if (fixtureCatalog) {
      return fixtureCatalog;
    }
  }

  throwIfRemoteAborted(signal);
  const target = await resolveCatalogTarget(
    selector,
    options.sourceIdentity,
    env,
    signal,
  );
  throwIfRemoteAborted(signal);
  return await resolveValidatedCatalogRoot(selector, target, env, options, signal);
}

async function validateMemoizedCatalogResolutionRoot(
  resolved: CatalogResolution,
  target?: ResolvedCatalogTarget,
): Promise<boolean> {
  const sidecarManifestPackage = resolved.sidecarManifestPackage;
  if (!sidecarManifestPackage) {
    return false;
  }

  try {
    if (target) {
      await validateMaterializedCatalog({
        manifest: target.manifest,
        sidecarManifestText: target.manifestText,
        rootDir: resolved.rootDir,
      });
      return true;
    }

    if (
      resolved.channel === undefined ||
      resolved.catalogVersion === undefined ||
      resolved.minAwVersion === undefined
    ) {
      return false;
    }

    const manifestPath = path.join(resolved.rootDir, CURRENT_CATALOG_MANIFEST_FILE);
    const manifestText = await fs.readFile(manifestPath, 'utf8');
    if (calculateManifestTextDigest(manifestText) !== sidecarManifestPackage.manifestDigest) {
      return false;
    }

    const manifest = validateCatalogManifest(JSON.parse(manifestText) as unknown);
    if (
      manifest.channel !== resolved.channel ||
      manifest.catalogVersion !== resolved.catalogVersion ||
      manifest.compatibility.aw.minVersion !== resolved.minAwVersion
    ) {
      return false;
    }

    await validateMaterializedCatalog({
      manifest,
      sidecarManifestText: manifestText,
      rootDir: resolved.rootDir,
    });
    return true;
  } catch {
    return false;
  }
}

async function readCurrentCatalogMemoEntry(
  memoKey: string,
  memoized: CurrentCatalogResolutionMemoEntry,
  cacheTtlMs: number,
  signal?: AbortSignal,
): Promise<CatalogResolution | null> {
  signal?.throwIfAborted();
  if (!memoized.settled) {
    return waitForCurrentCatalogMemoEntry(memoKey, memoized, signal);
  }
  try {
    if (
      cacheTtlMs === 0 ||
      memoized.validatedAtMs === undefined ||
      Date.now() - memoized.validatedAtMs > cacheTtlMs
    ) {
      if (currentCatalogResolutionMemo.get(memoKey) === memoized) {
        currentCatalogResolutionMemo.delete(memoKey);
      }
      return null;
    }

    const resolved = await memoized.promise;
    if (!(await fs.pathExists(resolved.rootDir))) {
      if (currentCatalogResolutionMemo.get(memoKey) === memoized) {
        currentCatalogResolutionMemo.delete(memoKey);
      }
      return null;
    }
    if (!(await validateMemoizedCatalogResolutionRoot(resolved))) {
      if (currentCatalogResolutionMemo.get(memoKey) === memoized) {
        currentCatalogResolutionMemo.delete(memoKey);
      }
      return null;
    }
    return resolved;
  } catch (error) {
    if (currentCatalogResolutionMemo.get(memoKey) === memoized) {
      currentCatalogResolutionMemo.delete(memoKey);
    }
    throw error;
  }
}

function waitForCurrentCatalogMemoEntry(
  memoKey: string,
  entry: CurrentCatalogResolutionMemoEntry,
  signal?: AbortSignal,
): Promise<CatalogResolution> {
  signal?.throwIfAborted();
  entry.waiterCount += 1;

  return new Promise<CatalogResolution>((resolve, reject) => {
    let finished = false;
    const finish = (
      result: { resolution: CatalogResolution } | { error: unknown },
      abortReason?: unknown,
    ): void => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', onAbort);
      entry.waiterCount -= 1;
      if (
        abortReason !== undefined &&
        entry.waiterCount === 0 &&
        !entry.settled &&
        !entry.controller.signal.aborted
      ) {
        if (currentCatalogResolutionMemo.get(memoKey) === entry) {
          currentCatalogResolutionMemo.delete(memoKey);
        }
        entry.controller.abort(abortReason);
      }
      if ('resolution' in result) resolve(result.resolution);
      else reject(result.error);
    };
    const onAbort = (): void => {
      const reason = signal?.reason ?? new DOMException('Catalog resolution aborted.', 'AbortError');
      finish({ error: reason }, reason);
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (resolution) => finish({ resolution }),
      (error) => finish({ error }),
    );
    if (signal?.aborted) {
      onAbort();
    }
  });
}

function reserveCurrentCatalogResolutionMemo(
  memoKey: string,
  expected: CurrentCatalogResolutionMemoEntry | undefined,
  capability: CurrentCatalogResolutionMemoEntry['capability'],
  task: (entry: CurrentCatalogResolutionMemoEntry) => Promise<CatalogResolution>,
): CurrentCatalogResolutionMemoEntry | null {
  if (currentCatalogResolutionMemo.get(memoKey) !== expected) {
    return null;
  }
  let resolvePromise!: (resolution: CatalogResolution) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<CatalogResolution>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const entry: CurrentCatalogResolutionMemoEntry = {
    promise,
    settled: false,
    capability,
    controller: new AbortController(),
    waiterCount: 0,
  };
  currentCatalogResolutionMemo.set(memoKey, entry);
  queueMicrotask(() => {
    void task(entry).then(
      (resolution) => {
        entry.settled = true;
        if (resolution.source === 'remote' || resolution.cacheFallback?.used === true) {
          entry.capability = 'remoteChecked';
        }
        entry.validatedAtMs = resolution.cacheState
          ? Date.parse(resolution.cacheState.validatedAt)
          : Date.now();
        resolvePromise(resolution);
      },
      (error) => {
        entry.settled = true;
        if (currentCatalogResolutionMemo.get(memoKey) === entry) {
          currentCatalogResolutionMemo.delete(memoKey);
        }
        rejectPromise(error);
      },
    );
  });
  return entry;
}

export function clearCurrentCatalogResolutionMemoForTests(): void {
  currentCatalogResolutionMemo.clear();
}

async function resolveArchiveByIdentity(
  identity: CatalogPackageArchiveIdentity,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CatalogPackageArchive> {
  return downloadCatalogPackageArchive(identity, env, signal);
}

function startCatalogArchiveDispose(archive: CatalogPackageArchive): Promise<void> {
  const disposal = Promise.resolve().then(() => archive.dispose());
  void disposal.catch(() => {});
  return disposal.catch(() => {});
}

async function disposeCatalogArchiveBounded(
  archive: CatalogPackageArchive | null,
  signal?: AbortSignal,
): Promise<void> {
  if (!archive) {
    return;
  }
  const disposal = startCatalogArchiveDispose(archive);
  if (signal?.aborted) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 250);
    timer.unref?.();
  });
  await Promise.race([disposal, bound]);
  if (timer) {
    clearTimeout(timer);
  }
}

async function resolveRequestedSidecarIdentity(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CatalogPackageArchiveIdentity> {
  if (selector.kind === 'exactVersion') {
    return resolveCatalogPackageIdentityByVersion(
      CURRENT_CATALOG_MANIFEST_PACKAGE,
      selector.requestedCatalogVersion!,
      env,
      signal,
    );
  }

  return resolveCatalogPackageIdentityByDistTag(
    CURRENT_CATALOG_MANIFEST_PACKAGE,
    getRequestedCatalogChannel(selector)!,
    env,
    signal,
  );
}

async function validateResolvedCatalogArchive(
  archive: CatalogPackageArchive,
): Promise<{ manifest: CatalogManifest; manifestText: string }> {
  const manifest = validateCatalogManifest(archive.rawManifest);
  validateCatalogPackageEnvelope(manifest);
  return {
    manifest,
    manifestText: archive.manifestText,
  };
}

function validateCatalogPackageEnvelope(manifest: CatalogManifest): void {
  const expectedManifestPath = `./${CURRENT_CATALOG_MANIFEST_FILE}`;
  if (
    manifest.packages.sidecar.name !== CURRENT_CATALOG_MANIFEST_PACKAGE ||
    manifest.packages.sidecar.version !== manifest.catalogVersion ||
    manifest.packages.sidecar.channel !== manifest.channel ||
    manifest.packages.sidecar.manifestPath !== undefined
  ) {
    throw new Error('catalog packages.sidecar does not match the sidecar package identity.');
  }
  if (
    manifest.packages.full.name !== CURRENT_CATALOG_FULL_PACKAGE ||
    manifest.packages.full.version !== manifest.catalogVersion ||
    manifest.packages.full.channel !== manifest.channel ||
    manifest.packages.full.manifestPath !== expectedManifestPath
  ) {
    throw new Error(`catalog packages.full must match the full package identity and ${expectedManifestPath}.`);
  }
}

function buildSidecarManifestPackageEvidence(
  identity: CatalogPackageArchiveIdentity,
  manifest: CatalogManifest,
  manifestText: string,
): NonNullable<CatalogResolution['sidecarManifestPackage']> {
  return {
    source: identity.packageName,
    version: identity.version,
    channel: manifest.channel,
    npmIntegrity: identity.integrity,
    manifestDigest: calculateManifestTextDigest(manifestText),
  };
}

async function resolveCatalogTarget(
  selector: CatalogSelector,
  sourceIdentity: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<ResolvedCatalogTarget> {
  let requestedSidecarIdentity: CatalogPackageArchiveIdentity;
  try {
    requestedSidecarIdentity = await resolveRequestedSidecarIdentity(selector, env, signal);
    if (requestedSidecarIdentity.packageName !== CURRENT_CATALOG_MANIFEST_PACKAGE) {
      throw new Error(`sidecar identity package ${requestedSidecarIdentity.packageName} is invalid.`);
    }
    if (
      selector.kind === 'exactVersion' &&
      requestedSidecarIdentity.version !== selector.requestedCatalogVersion
    ) {
      throw new Error(`sidecar identity version ${requestedSidecarIdentity.version} does not match exact selector ${selector.requestedCatalogVersion}.`);
    }
    if (
      selector.kind !== 'exactVersion' &&
      requestedSidecarIdentity.requestedDistTag !== getRequestedCatalogChannel(selector)
    ) {
      throw new Error(`sidecar identity dist-tag ${requestedSidecarIdentity.requestedDistTag ?? '<missing>'} does not match selector channel ${getRequestedCatalogChannel(selector)}.`);
    }
  } catch (error) {
    throwCatalogResolutionFailure({
      selector,
      channel: getRequestedCatalogChannel(selector) ?? undefined,
      cacheFallback: {
        used: false,
      },
      remoteFailure: createRemoteFailure(
        'sidecarMetadata',
        normalizeErrorMessage(error),
        {
          packageName: CURRENT_CATALOG_MANIFEST_PACKAGE,
          packageVersion: selector.requestedCatalogVersion,
        },
      ),
      reason: `无法解析 current catalog sidecar metadata：${normalizeErrorMessage(error)}`,
      reasonCode: 'catalogUnavailable',
    });
  }

  let observationOrder: number | undefined;
  try {
    observationOrder = await reserveCurrentCatalogCacheObservationOrder(
      selector,
      sourceIdentity,
      env,
      signal,
    );
  } catch {
    throwIfRemoteAborted(signal);
  }

  let requestedSidecarArchive: CatalogPackageArchive | null = null;
  try {
    try {
      requestedSidecarArchive = await resolveArchiveByIdentity(requestedSidecarIdentity, env, signal);
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: getRequestedCatalogChannel(selector) ?? undefined,
        catalogVersion: requestedSidecarIdentity.version,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'sidecarTarball',
          normalizeErrorMessage(error),
          {
            packageName: requestedSidecarIdentity.packageName,
            packageVersion: requestedSidecarIdentity.version,
            integrity: requestedSidecarIdentity.integrity,
          },
        ),
        reason: `无法下载 current catalog sidecar：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    let validated: Awaited<ReturnType<typeof validateResolvedCatalogArchive>>;
    try {
      validated = await validateResolvedCatalogArchive(requestedSidecarArchive);
      if (validated.manifest.catalogVersion !== requestedSidecarIdentity.version) {
        throw new Error(`sidecar manifest version ${validated.manifest.catalogVersion} does not match identity ${requestedSidecarIdentity.version}.`);
      }
      if (
        selector.kind !== 'exactVersion' &&
        validated.manifest.channel !== getRequestedCatalogChannel(selector)
      ) {
        throw new Error(`sidecar manifest channel ${validated.manifest.channel} does not match selector channel ${getRequestedCatalogChannel(selector)}.`);
      }
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: getRequestedCatalogChannel(selector) ?? undefined,
        catalogVersion: requestedSidecarIdentity.version,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'sidecarManifest',
          normalizeErrorMessage(error),
          {
            packageName: requestedSidecarIdentity.packageName,
            packageVersion: requestedSidecarIdentity.version,
            integrity: requestedSidecarIdentity.integrity,
          },
        ),
        reason: `current catalog sidecar manifest 校验失败：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    if (!isCompatibleWithCliVersion(
      selector.cliVersion,
      validated.manifest.compatibility.aw.minVersion,
    )) {
      throwCatalogResolutionFailure({
        selector,
        channel: validated.manifest.channel,
        catalogVersion: validated.manifest.catalogVersion,
        minAwVersion: validated.manifest.compatibility.aw.minVersion,
        cacheFallback: {
          used: false,
        },
        reason: selector.kind === 'exactVersion'
          ? `显式 catalog 版本 ${validated.manifest.catalogVersion} 需要 aw >= ${validated.manifest.compatibility.aw.minVersion}，当前 CLI 为 ${selector.cliVersion}。`
          : `当前 ${validated.manifest.channel} 轨道 catalog ${validated.manifest.catalogVersion} 需要 aw >= ${validated.manifest.compatibility.aw.minVersion}，当前 CLI 为 ${selector.cliVersion}。`,
        reasonCode: selector.kind === 'exactVersion'
          ? 'explicitCatalogIncompatible'
          : 'awVersionTooLow',
      });
    }

    return {
      manifest: validated.manifest,
      manifestText: validated.manifestText,
      sidecarIdentity: requestedSidecarIdentity,
      sidecarManifestPackage: buildSidecarManifestPackageEvidence(
        requestedSidecarIdentity,
        validated.manifest,
        validated.manifestText,
      ),
      ...(observationOrder === undefined ? {} : { observationOrder }),
    };
  } finally {
    await disposeCatalogArchiveBounded(requestedSidecarArchive, signal);
  }
}
async function validateMaterializedCatalog(
  options: {
    manifest: CatalogManifest;
    sidecarManifestText: string;
    rootDir: string;
  },
  signal?: AbortSignal,
): Promise<void> {
  throwIfRemoteAborted(signal);
  const manifestPath = path.join(options.rootDir, CURRENT_CATALOG_MANIFEST_FILE);
  const fullManifestText = await fs.readFile(manifestPath, 'utf8');
  if (fullManifestText !== options.sidecarManifestText) {
    throw new CatalogContentValidationError(
      'fullManifest',
      'sidecar manifest and full catalog manifest differ.',
    );
  }

  for (const entry of options.manifest.entries) {
    throwIfRemoteAborted(signal);
    const pluginRoot = path.join(options.rootDir, entry.source);
    const {
      manifestDigest,
      artifactDigest,
    } = await calculateCatalogEntryDigestsFromRoot(pluginRoot);
    throwIfRemoteAborted(signal);
    if (manifestDigest !== entry.manifestDigest) {
      throw new CatalogContentValidationError(
        'fullManifest',
        `plugin "${entry.name}" manifestDigest mismatch: expected ${entry.manifestDigest}, got ${manifestDigest}.`,
      );
    }

    if (artifactDigest !== entry.artifactDigest) {
      throw new CatalogContentValidationError(
        'artifactDigest',
        `plugin "${entry.name}" artifactDigest mismatch: expected ${entry.artifactDigest}, got ${artifactDigest}.`,
      );
    }
  }
}

class CatalogContentValidationError extends Error {
  readonly stage: 'fullManifest' | 'artifactDigest';

  constructor(stage: CatalogContentValidationError['stage'], message: string) {
    super(message);
    this.name = 'CatalogContentValidationError';
    this.stage = stage;
  }
}

function classifyCatalogContentValidationStage(
  error: unknown,
): CatalogContentValidationError['stage'] {
  return error instanceof CatalogContentValidationError ? error.stage : 'fullManifest';
}

function buildFullCatalogEvidence(
  resolution: Pick<CatalogResolution, 'source'>,
  manifest: CatalogManifest,
  revision: string,
): NonNullable<CatalogResolution['fullCatalog']> {
  return {
    source: resolution.source,
    version: manifest.catalogVersion,
    channel: manifest.channel,
    minAwVersion: manifest.compatibility.aw.minVersion,
    revision,
    freshness: resolution.source === 'cache'
      ? 'cached'
      : resolution.source === 'local'
        ? 'localFixture'
        : resolution.source === 'embedded'
          ? 'embedded'
          : 'fresh',
  };
}

function buildCurrentCatalogCacheObservation(
  target: ResolvedCatalogTarget,
  sourceIdentity: string,
): CurrentCatalogCacheObservation | null {
  if (target.observationOrder === undefined) {
    return null;
  }
  return {
    sidecarManifestPackage: target.sidecarManifestPackage,
    sourceIdentity,
    observationOrder: target.observationOrder,
  };
}

function buildCatalogResolutionFromCache(options: {
  selector: CatalogSelector;
  target: ResolvedCatalogTarget;
  cacheEntry: CurrentCatalogCacheEntry;
  cacheFallback?: CatalogResolution['cacheFallback'];
  remoteFailure?: CatalogResolution['remoteFailure'];
  reason?: string;
  cacheState?: CatalogResolution['cacheState'];
}): CatalogResolution {
  const matchedCatalog = buildFullCatalogEvidence(
    { source: 'cache' },
    options.target.manifest,
    options.cacheEntry.metadata.manifestDigest,
  );

  return {
    rootDir: options.cacheEntry.rootDir,
    source: 'cache',
    selector: options.selector,
    sidecarManifestPackage: options.target.sidecarManifestPackage,
    fullCatalog: matchedCatalog,
    channel: options.target.manifest.channel,
    catalogVersion: options.target.manifest.catalogVersion,
    minAwVersion: options.target.manifest.compatibility.aw.minVersion,
    cacheFallback: options.cacheFallback ?? {
      used: false,
      cacheKey: options.cacheEntry.cacheKey,
      selectorKey: options.cacheEntry.selectorKey,
    },
    ...(options.remoteFailure ? { remoteFailure: options.remoteFailure } : {}),
    ...(options.cacheState ? { cacheState: options.cacheState } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
}

async function readValidatedCurrentCatalogCacheEntry(
  identity: CurrentCatalogCacheIdentity,
  target: ResolvedCatalogTarget,
  env: NodeJS.ProcessEnv,
  sourceIdentity: string,
): Promise<CurrentCatalogCacheEntry | null> {
  const cacheEntry = await readCurrentCatalogCacheEntry(identity, env, sourceIdentity);
  if (!cacheEntry) {
    return null;
  }

  try {
    await validateMaterializedCatalog({
      manifest: target.manifest,
      sidecarManifestText: target.manifestText,
      rootDir: cacheEntry.rootDir,
    });
    return cacheEntry;
  } catch {
    return null;
  }
}

async function readValidatedCurrentCatalogCacheEntryBySelector(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  sourceIdentity: string,
): Promise<{
  cacheEntry: CurrentCatalogCacheEntry;
  target: ResolvedCatalogTarget;
} | null> {
  const cacheEntry = await readCurrentCatalogCacheEntryBySelector(
    selector,
    env,
    sourceIdentity,
  );
  if (!cacheEntry) {
    return null;
  }

  try {
    const manifestPath = path.join(cacheEntry.rootDir, CURRENT_CATALOG_MANIFEST_FILE);
    const manifestText = await fs.readFile(manifestPath, 'utf8');
    const manifest = validateCatalogManifest(JSON.parse(manifestText) as unknown);
    validateCatalogPackageEnvelope(manifest);
    if (
      manifest.channel !== cacheEntry.metadata.channel ||
      manifest.catalogVersion !== cacheEntry.metadata.catalogVersion ||
      manifest.compatibility.aw.minVersion !== cacheEntry.metadata.minAwVersion ||
      manifest.schemaVersion !== cacheEntry.metadata.schemaVersion ||
      cacheEntry.metadata.sidecarIntegrity.trim() === '' ||
      cacheEntry.metadata.fullIntegrity.trim() === ''
    ) {
      return null;
    }
    if (
      (selector.kind === 'exactVersion' && manifest.catalogVersion !== selector.requestedCatalogVersion) ||
      (selector.kind !== 'exactVersion' && manifest.channel !== getRequestedCatalogChannel(selector))
    ) {
      return null;
    }
    await validateMaterializedCatalog({
      manifest,
      sidecarManifestText: manifestText,
      rootDir: cacheEntry.rootDir,
    });

    const sidecarIdentity: CatalogPackageArchiveIdentity = {
      packageName: CURRENT_CATALOG_MANIFEST_PACKAGE,
      version: manifest.catalogVersion,
      integrity: cacheEntry.metadata.sidecarIntegrity,
      ...(selector.kind === 'exactVersion'
        ? {}
        : { requestedDistTag: getRequestedCatalogChannel(selector)! }),
    };
    return {
      cacheEntry,
      target: {
        manifest,
        manifestText,
        sidecarIdentity,
        sidecarManifestPackage: cacheEntry.observation?.sidecarManifestPackage ??
          buildSidecarManifestPackageEvidence(sidecarIdentity, manifest, manifestText),
      },
    };
  } catch {
    return null;
  }
}

async function tryResolveCacheFirstCatalog(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  cacheTtlMs: number,
  sourceIdentity: string,
): Promise<CatalogResolution | null> {
  const cached = await readValidatedCurrentCatalogCacheEntryBySelector(
    selector,
    env,
    sourceIdentity,
  );
  if (!cached) {
    return null;
  }
  const ageMs = Math.max(0, Date.now() - Date.parse(cached.cacheEntry.validatedAt));
  return buildCatalogResolutionFromCache({
    selector,
    target: cached.target,
    cacheEntry: cached.cacheEntry,
    cacheState: buildCacheState(
      cacheTtlMs > 0 && ageMs <= cacheTtlMs ? 'fresh' : 'stale',
      cached.cacheEntry.validatedAt,
      cacheTtlMs,
    ),
  });
}

function classifyRemoteCatalogFailure(
  selector: CatalogSelector,
  error: unknown,
): CatalogResolutionFailure | null {
  if (isCatalogResolutionError(error)) {
    if (
      error.resolution.reasonCode === 'explicitCatalogIncompatible' ||
      error.resolution.reasonCode === 'awVersionTooLow'
    ) {
      return null;
    }
    return error.resolution;
  }
  if (!(error instanceof CatalogRemoteDeadlineError)) {
    return null;
  }
  const message = normalizeErrorMessage(error);
  return {
    selector,
    channel: getRequestedCatalogChannel(selector) ?? undefined,
    cacheFallback: { used: false },
    remoteFailure: createRemoteFailure('deadline', message),
    reason: message,
    reasonCode: 'catalogUnavailable',
  };
}

async function resolveCatalogFailureFromSelectorCache(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  cacheTtlMs: number,
  sourceIdentity: string,
  error: unknown,
): Promise<CatalogResolution | null> {
  const failure = classifyRemoteCatalogFailure(selector, error);
  if (!failure) {
    return null;
  }
  const cached = await readValidatedCurrentCatalogCacheEntryBySelector(
    selector,
    env,
    sourceIdentity,
  );
  if (!cached) {
    if (isCatalogResolutionError(error)) {
      throw error;
    }
    throw new CatalogResolutionError(failure);
  }
  const matchedCatalog = buildFullCatalogEvidence(
    { source: 'cache' },
    cached.target.manifest,
    cached.cacheEntry.metadata.manifestDigest,
  );
  return buildCatalogResolutionFromCache({
    selector,
    target: cached.target,
    cacheEntry: cached.cacheEntry,
    cacheFallback: {
      used: true,
      source: 'currentCatalogCache',
      cacheKey: cached.cacheEntry.cacheKey,
      selectorKey: cached.cacheEntry.selectorKey,
      blockingCode: failure.reasonCode,
      matchedSelector: selector,
      matchedCatalog,
    },
    remoteFailure: failure.remoteFailure,
    cacheState: buildCacheState(
      'refreshFailed',
      cached.cacheEntry.validatedAt,
      cacheTtlMs,
    ),
    reason: failure.reason,
  });
}

async function materializeRetainedCatalogRoot(
  archive: CatalogPackageArchive,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  throwIfRemoteAborted(signal);
  const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
  await fs.ensureDir(stagingParent);
  const retainedRoot = await fs.mkdtemp(path.join(stagingParent, 'validated-remote-'));

  try {
    await archive.materialize(retainedRoot, signal);
    throwIfRemoteAborted(signal);
    return retainedRoot;
  } catch (error) {
    await fs.remove(retainedRoot);
    throw error;
  }
}

async function resolveValidatedCatalogRoot(
  selector: CatalogSelector,
  target: ResolvedCatalogTarget,
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogRuntimeOptions,
  signal?: AbortSignal,
): Promise<CatalogResolution> {
  let fullIdentity: CatalogPackageArchiveIdentity;
  try {
    fullIdentity = await resolveCatalogPackageIdentityByVersion(
      CURRENT_CATALOG_FULL_PACKAGE,
      target.manifest.catalogVersion,
      env,
      signal,
    );
    if (
      fullIdentity.packageName !== CURRENT_CATALOG_FULL_PACKAGE ||
      fullIdentity.version !== target.manifest.catalogVersion
    ) {
      throw new Error(`full catalog identity ${fullIdentity.packageName}@${fullIdentity.version} does not match ${CURRENT_CATALOG_FULL_PACKAGE}@${target.manifest.catalogVersion}.`);
    }
  } catch (error) {
    throwCatalogResolutionFailure({
      selector,
      channel: target.manifest.channel,
      catalogVersion: target.manifest.catalogVersion,
      minAwVersion: target.manifest.compatibility.aw.minVersion,
      cacheFallback: {
        used: false,
      },
      remoteFailure: createRemoteFailure(
        'fullMetadata',
        normalizeErrorMessage(error),
        {
          packageName: CURRENT_CATALOG_FULL_PACKAGE,
          packageVersion: target.manifest.catalogVersion,
        },
      ),
      reason: `无法解析 full catalog metadata：${normalizeErrorMessage(error)}`,
      reasonCode: 'catalogUnavailable',
    });
  }

  const cacheIdentity = {
    selector,
    channel: target.manifest.channel,
    catalogVersion: target.manifest.catalogVersion,
    minAwVersion: target.manifest.compatibility.aw.minVersion,
    schemaVersion: target.manifest.schemaVersion,
    sidecarIntegrity: target.sidecarIdentity.integrity,
    fullIntegrity: fullIdentity.integrity,
  } as const;
  const cacheObservation = buildCurrentCatalogCacheObservation(
    target,
    options.sourceIdentity,
  );

  let fullArchive: CatalogPackageArchive | null = null;
  let cacheEntry = null as Awaited<ReturnType<typeof readCurrentCatalogCacheEntry>> | null;
  try {
    if (options.freshnessPolicy !== 'forceRemote' && options.forceRefresh !== true) {
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(
        cacheIdentity,
        target,
        env,
        options.sourceIdentity,
      );
      if (cacheEntry) {
        if (cacheObservation) {
          cacheEntry = await markCurrentCatalogCacheEntryValidated(
            cacheEntry,
            env,
            new Date().toISOString(),
            cacheObservation,
            signal,
          );
        }
        return buildCatalogResolutionFromCache({
          selector,
          target,
          cacheEntry,
          cacheState: buildCacheState('fresh', cacheEntry.validatedAt, options.cacheTtlMs),
        });
      }
    }

    try {
      throwIfRemoteAborted(signal);
      fullArchive = await resolveArchiveByIdentity(fullIdentity, env, signal);
    } catch (error) {
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(
        cacheIdentity,
        target,
        env,
        options.sourceIdentity,
      );
      if (cacheEntry) {
        const remoteFailure = createRemoteFailure(
          'fullTarball',
          normalizeErrorMessage(error),
          {
            packageName: fullIdentity.packageName,
            packageVersion: fullIdentity.version,
            integrity: fullIdentity.integrity,
          },
        );
        return buildCatalogResolutionFromCache({
          selector,
          target,
          cacheEntry,
          cacheFallback: {
            used: true,
            source: 'currentCatalogCache',
            cacheKey: cacheEntry.cacheKey,
            selectorKey: cacheEntry.selectorKey,
            blockingCode: 'catalogUnavailable',
            matchedSelector: selector,
            matchedCatalog: buildFullCatalogEvidence(
              { source: 'cache' },
              target.manifest,
              cacheEntry.metadata.manifestDigest,
            ),
          },
          remoteFailure,
          cacheState: buildCacheState(
            'refreshFailed',
            cacheEntry.validatedAt,
            options.cacheTtlMs,
          ),
          reason: normalizeErrorMessage(error),
        });
      }

      throwCatalogResolutionFailure({
        selector,
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'fullTarball',
          normalizeErrorMessage(error),
          {
            packageName: fullIdentity.packageName,
            packageVersion: fullIdentity.version,
            integrity: fullIdentity.integrity,
          },
        ),
        reason: `无法下载 full catalog：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    try {
      const validatedFullManifest = validateCatalogManifest(fullArchive.rawManifest);
      validateCatalogPackageEnvelope(validatedFullManifest);
      if (validatedFullManifest.catalogVersion !== target.manifest.catalogVersion) {
        throw new Error(`full catalog version ${validatedFullManifest.catalogVersion} does not match sidecar ${target.manifest.catalogVersion}.`);
      }

      await validateMaterializedCatalog({
        manifest: target.manifest,
        sidecarManifestText: target.manifestText,
        rootDir: fullArchive.packageRoot,
      }, signal);
    } catch (error) {
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(
        cacheIdentity,
        target,
        env,
        options.sourceIdentity,
      );
      if (cacheEntry) {
        const remoteFailure = createRemoteFailure(
          classifyCatalogContentValidationStage(error),
          normalizeErrorMessage(error),
          {
            packageName: fullIdentity.packageName,
            packageVersion: fullIdentity.version,
            integrity: fullIdentity.integrity,
          },
        );
        return buildCatalogResolutionFromCache({
          selector,
          target,
          cacheEntry,
          cacheFallback: {
            used: true,
            source: 'currentCatalogCache',
            cacheKey: cacheEntry.cacheKey,
            selectorKey: cacheEntry.selectorKey,
            blockingCode: 'catalogUnavailable',
            matchedSelector: selector,
            matchedCatalog: buildFullCatalogEvidence(
              { source: 'cache' },
              target.manifest,
              cacheEntry.metadata.manifestDigest,
            ),
          },
          remoteFailure,
          cacheState: buildCacheState(
            'refreshFailed',
            cacheEntry.validatedAt,
            options.cacheTtlMs,
          ),
          reason: normalizeErrorMessage(error),
        });
      }

      throwCatalogResolutionFailure({
        selector,
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          classifyCatalogContentValidationStage(error),
          normalizeErrorMessage(error),
          {
            packageName: fullIdentity.packageName,
            packageVersion: fullIdentity.version,
            integrity: fullIdentity.integrity,
          },
        ),
        reason: `full catalog 校验失败：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    try {
      throwIfRemoteAborted(signal);
      const existingCacheEntry = await readValidatedCurrentCatalogCacheEntry(
        cacheIdentity,
        target,
        env,
        options.sourceIdentity,
      );
      let cacheResult: CurrentCatalogCacheEntry;
      if (existingCacheEntry) {
        cacheResult = cacheObservation
          ? await markCurrentCatalogCacheEntryValidated(
            existingCacheEntry,
            env,
            new Date().toISOString(),
            cacheObservation,
            signal,
          )
          : existingCacheEntry;
      } else {
        if (!cacheObservation) {
          throw new Error('Current catalog observation order is unavailable.');
        }
        cacheResult = await writeCurrentCatalogCacheEntry({
          ...cacheIdentity,
          sourceRoot: fullArchive.packageRoot,
          env,
          observation: cacheObservation,
          signal,
          validateExisting: async (rootDir) => {
            try {
              await validateMaterializedCatalog({
                manifest: target.manifest,
                sidecarManifestText: target.manifestText,
                rootDir,
              }, signal);
              return true;
            } catch {
              throwIfRemoteAborted(signal);
              return false;
            }
          },
        });
      }
      const publishedArchive = fullArchive;
      fullArchive = null;
      void startCatalogArchiveDispose(publishedArchive);

      return {
        rootDir: cacheResult.rootDir,
        source: 'remote',
        selector,
        sidecarManifestPackage: target.sidecarManifestPackage,
        fullCatalog: buildFullCatalogEvidence(
          { source: 'remote' },
          target.manifest,
          cacheResult.metadata.manifestDigest,
        ),
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        cacheFallback: {
          used: false,
          cacheKey: cacheResult.cacheKey,
          selectorKey: cacheResult.selectorKey,
        },
        cacheState: buildCacheState(
          'fresh',
          cacheResult.validatedAt,
          options.cacheTtlMs,
        ),
      };
    } catch (error) {
      if (!fullArchive) {
        throw new Error('full catalog archive is unavailable after validation.');
      }
      const retainedRoot = await materializeRetainedCatalogRoot(fullArchive, env, signal);

      return {
        rootDir: retainedRoot,
        source: 'remote',
        selector,
        sidecarManifestPackage: target.sidecarManifestPackage,
        fullCatalog: buildFullCatalogEvidence(
          { source: 'remote' },
          target.manifest,
          calculateManifestTextDigest(target.manifestText),
        ),
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        cacheFallback: {
          used: false,
          cacheKey: buildCurrentCatalogCacheKey(cacheIdentity),
        },
        reason: `current catalog cache write failed; using validated remote catalog directly: ${normalizeErrorMessage(error)}`,
      };
    }
  } finally {
    await disposeCatalogArchiveBounded(fullArchive, signal);
  }
}

async function tryResolveFixtureCatalogOverride(
  selector: CatalogSelector,
): Promise<CatalogResolution | null> {
  const overrideRoot = getEmbeddedPluginsRootOverrideForTests();
  if (!overrideRoot) {
    return null;
  }

  const sidecarPackageRoot = getCatalogSidecarPackageRoot(overrideRoot);
  const fullPackageRoot = getCatalogFullPackageRoot(overrideRoot);
  const manifestPath = path.join(sidecarPackageRoot, CURRENT_CATALOG_MANIFEST_FILE);
  if (
    !(await fs.pathExists(manifestPath)) ||
    !(await fs.pathExists(path.join(fullPackageRoot, CURRENT_CATALOG_MANIFEST_FILE)))
  ) {
    return null;
  }

  const manifest = validateCatalogManifest(await fs.readJson(manifestPath));
  const manifestText = await fs.readFile(manifestPath, 'utf8');
  const manifestDigest = calculateManifestTextDigest(manifestText);
  if (selector.kind === 'exactVersion' && manifest.catalogVersion !== selector.requestedCatalogVersion) {
    return null;
  }

  const requestedChannel = getRequestedCatalogChannel(selector);
  if (requestedChannel && manifest.channel !== requestedChannel) {
    return null;
  }

  if (!isCompatibleWithCliVersion(selector.cliVersion, manifest.compatibility.aw.minVersion)) {
    return null;
  }

  return {
    rootDir: fullPackageRoot,
    source: 'local',
    selector,
    sidecarManifestPackage: {
      source: 'localFixture',
      version: manifest.catalogVersion,
      channel: manifest.channel,
      manifestDigest,
    },
    fullCatalog: {
      source: 'local',
      version: manifest.catalogVersion,
      channel: manifest.channel,
      minAwVersion: manifest.compatibility.aw.minVersion,
      revision: manifestDigest,
      freshness: 'localFixture',
    },
    channel: manifest.channel,
    catalogVersion: manifest.catalogVersion,
    minAwVersion: manifest.compatibility.aw.minVersion,
  };
}

async function resolveCurrentCatalogWithRemoteDeadline(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogRuntimeOptions,
  timeoutMs: number,
): Promise<CatalogResolution> {
  const controller = new AbortController();
  let rejectCancellation!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromExternalSignal = () => {
    try {
      throwIfRemoteAborted(options.signal);
    } catch (error) {
      const abortError = error instanceof Error ? error : new Error(String(error));
      controller.abort(abortError);
      rejectCancellation(abortError);
    }
  };
  if (options.signal?.aborted) {
    abortFromExternalSignal();
  } else {
    options.signal?.addEventListener('abort', abortFromExternalSignal, { once: true });
  }
  const timer = timeoutMs === 0
    ? undefined
    : setTimeout(() => {
      const error = new CatalogRemoteDeadlineError(timeoutMs);
      controller.abort(error);
      rejectCancellation(error);
    }, timeoutMs);
  timer?.unref?.();

  try {
    const work = resolveCurrentCatalogUncached(selector, env, options, controller.signal);
    void work.catch(() => {});
    try {
      return await Promise.race([work, cancellation]);
    } catch (error) {
      throwIfRemoteAborted(options.signal);
      const fallback = await resolveCatalogFailureFromSelectorCache(
        selector,
        env,
        options.cacheTtlMs,
        options.sourceIdentity,
        error,
      );
      throwIfRemoteAborted(options.signal);
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    options.signal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

export async function resolveCurrentCatalog(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCurrentCatalogOptions = {},
): Promise<CatalogResolution> {
  options.signal?.throwIfAborted();
  const runtimePolicy = readCatalogRuntimePolicy(env, options);
  const [selector, registryUrl] = await Promise.all([
    resolveEffectiveCatalogSelector(env, options),
    resolveCatalogRegistryUrl(env),
  ]);
  const sourceIdentity = buildCatalogSourceIdentity(registryUrl);
  options.signal?.throwIfAborted();
  const effectiveOptions: ResolveCurrentCatalogRuntimeOptions = {
    ...options,
    freshnessPolicy: runtimePolicy.freshnessPolicy,
    cacheTtlMs: runtimePolicy.cacheTtlMs,
    remoteTimeoutMs: runtimePolicy.remoteTimeoutMs,
    sourceIdentity,
  };
  const normalMemoKey = buildCurrentCatalogMemoKey(
    selector,
    env,
    { ...effectiveOptions, forceRefresh: false },
  );

  if (runtimePolicy.freshnessPolicy === 'forceRemote') {
    const ordinaryMemoBeforeForce = currentCatalogResolutionMemo.get(normalMemoKey);
    const resolved = await resolveCurrentCatalogWithRemoteDeadline(
      selector,
      env,
      effectiveOptions,
      runtimePolicy.remoteTimeoutMs,
    );
    if (currentCatalogResolutionMemo.get(normalMemoKey) === ordinaryMemoBeforeForce) {
      currentCatalogResolutionMemo.delete(normalMemoKey);
    }
    return resolved;
  }

  const requiredCapability = runtimePolicy.freshnessPolicy === 'cacheFirst'
    ? 'cacheOnly'
    : 'remoteChecked';
  while (true) {
    const observed = currentCatalogResolutionMemo.get(normalMemoKey);
    const capabilityMatches = observed !== undefined && (
      requiredCapability === 'cacheOnly' || observed.capability === 'remoteChecked'
    );
    if (observed && capabilityMatches) {
      if (
        runtimePolicy.freshnessPolicy === 'cacheFirst' &&
        !observed.settled &&
        observed.capability === 'remoteChecked'
      ) {
        const cached = await tryResolveCacheFirstCatalog(
          selector,
          env,
          runtimePolicy.cacheTtlMs,
          effectiveOptions.sourceIdentity,
        );
        if (cached) {
          return cached;
        }
      }
      const memoized = await readCurrentCatalogMemoEntry(
        normalMemoKey,
        observed,
        runtimePolicy.cacheTtlMs,
        options.signal,
      );
      if (memoized) {
        return memoized;
      }
      if (currentCatalogResolutionMemo.get(normalMemoKey) !== observed) {
        continue;
      }
    }

    const expected = currentCatalogResolutionMemo.get(normalMemoKey);
    if (expected !== observed) {
      continue;
    }
    const reserved = reserveCurrentCatalogResolutionMemo(
      normalMemoKey,
      expected,
      requiredCapability,
      async (entry) => {
        const sharedOptions: ResolveCurrentCatalogRuntimeOptions = {
          ...effectiveOptions,
          signal: entry.controller.signal,
        };
        if (runtimePolicy.freshnessPolicy === 'cacheFirst') {
          const cached = await tryResolveCacheFirstCatalog(
            selector,
            env,
            runtimePolicy.cacheTtlMs,
            effectiveOptions.sourceIdentity,
          );
          if (cached) {
            return cached;
          }
          const current = currentCatalogResolutionMemo.get(normalMemoKey);
          if (current !== entry && current?.capability === 'remoteChecked') {
            return waitForCurrentCatalogMemoEntry(
              normalMemoKey,
              current,
              entry.controller.signal,
            );
          }
          entry.capability = 'remoteChecked';
        }
        return resolveCurrentCatalogWithRemoteDeadline(
          selector,
          env,
          sharedOptions,
          runtimePolicy.remoteTimeoutMs,
        );
      },
    );
    if (reserved) {
      return waitForCurrentCatalogMemoEntry(normalMemoKey, reserved, options.signal);
    }
  }
}

export async function resolveCatalogPlugins(
  pluginNames: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCurrentCatalogOptions = {},
) {
  const catalog = await resolveCurrentCatalog(env, options);
  const plugins = await resolvePluginsFromCatalog(catalog.rootDir, pluginNames);
  return {
    catalog,
    plugins,
  };
}

export async function resolveActiveLocalBundle(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pluginRoot = path.join(resolveAwHome(env), 'plugins', pluginName);
  return (await fs.pathExists(pluginRoot)) ? pluginRoot : null;
}

export async function resolveActiveLocalBundleFromInstallLocation(
  pluginName: string,
  platform: 'claude' | 'codex',
  installLocation: string,
): Promise<{
  bundleRoot: string | null;
  details?: string;
}> {
  const manifestPath = getMarketplaceManifestPath(installLocation, platform);
  if (!(await fs.pathExists(manifestPath))) {
    return {
      bundleRoot: null,
      details: `marketplace manifest 缺失: ${manifestPath}`,
    };
  }

  try {
    const manifest = await fs.readJson(manifestPath) as {
      plugins?: Array<{ name?: string; source?: string }>;
    };
    const entry = manifest.plugins?.find((plugin) => plugin.name === pluginName);
    if (!entry?.source) {
      return {
        bundleRoot: null,
        details: `marketplace manifest 缺少 ${pluginName} 的 source。`,
      };
    }

    const bundleRoot = path.resolve(installLocation, entry.source);
    return {
      bundleRoot: await fs.pathExists(bundleRoot) ? bundleRoot : null,
      details: await fs.pathExists(bundleRoot)
        ? undefined
        : `bundle 路径不存在: ${bundleRoot}`,
    };
  } catch (error) {
    return {
      bundleRoot: null,
      details: normalizeErrorMessage(error),
    };
  }
}
