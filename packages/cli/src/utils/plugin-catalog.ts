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
  freshnessPolicy?: 'cacheFirst' | 'requireRemote' | 'forceRemote';
}

interface ResolveCurrentCatalogRuntimeOptions extends ResolveCurrentCatalogOptions {
  freshnessPolicy: NonNullable<ResolveCurrentCatalogOptions['freshnessPolicy']>;
  cacheTtlMs: number;
  remoteTimeoutMs: number;
}

interface PartialCatalogSummary {
  catalogVersion: CatalogVersion;
  channel: CatalogChannel;
  minAwVersion: CliVersion;
  historySchemaVersion: number | null;
}

interface CatalogHistoryReleaseSummary {
  catalogVersion: CatalogVersion;
  minAwVersion: CliVersion;
}

interface ParsedCatalogHistory {
  schemaVersion: number;
  releases: CatalogHistoryReleaseSummary[];
}

interface ResolvedCatalogTarget {
  manifest: CatalogManifest;
  manifestText: string;
  sidecarIdentity: CatalogPackageArchiveIdentity;
  sidecarManifestPackage: NonNullable<CatalogResolution['sidecarManifestPackage']>;
  latestCatalog?: CatalogResolution['latestCatalog'];
  latestCatalogBlocked?: CatalogResolution['latestCatalogBlocked'];
  historySchemaVersion: number | null;
  resolutionSource?: NonNullable<CatalogResolution['fullCatalog']>['resolutionSource'];
}

interface CurrentCatalogResolutionMemoEntry {
  promise: Promise<CatalogResolution>;
  settled: boolean;
  validatedAtMs?: number;
  capability: 'cacheOnly' | 'remoteChecked';
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
    throw signal.reason instanceof Error ? signal.reason : new Error('Catalog remote resolution aborted.');
  }
}

function calculateManifestTextDigest(manifestText: string): string {
  return `sha256:${crypto.createHash('sha256').update(manifestText).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCatalogChannel(
  value: unknown,
  fieldName: string,
): CatalogChannel {
  if (value === 'latest' || value === 'beta') {
    return value;
  }
  throw new Error(`Invalid ${fieldName}: expected "latest" or "beta".`);
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
  options: ResolveCurrentCatalogOptions | ResolveCurrentCatalogRuntimeOptions,
): string {
  const payload = {
    selector: serializeCatalogSelectorForCache(selector),
    overrideSource: selector.overrideSource ?? null,
    awHome: resolveAwHome(env),
    registry: env.AW_NPM_REGISTRY_URL || env.npm_config_registry || env.NPM_CONFIG_REGISTRY || null,
    npmUserConfig: env.npm_config_userconfig || env.NPM_CONFIG_USERCONFIG || null,
    cwd: path.resolve(process.cwd()),
    home: env.HOME || null,
    userprofile: env.USERPROFILE || null,
    embeddedOverrideRoot: getEmbeddedPluginsRootOverrideForTests(),
    catalogPackageSourceRevision: getCatalogPackageSourceRevisionForTests(),
    remoteTimeoutMs: 'remoteTimeoutMs' in options
      ? options.remoteTimeoutMs
      : DEFAULT_CATALOG_REMOTE_TIMEOUT_MS,
    forceRefresh: Boolean(options.forceRefresh),
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
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
  const target = await resolveCatalogTarget(selector, env, signal);
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
      manifest.compatibility.aw.minVersion !== resolved.minAwVersion ||
      (
        resolved.historySchemaVersion !== undefined &&
        resolved.historySchemaVersion !== null &&
        manifest.history.schemaVersion !== resolved.historySchemaVersion
      )
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
): Promise<CatalogResolution | null> {
  try {
    if (!memoized.settled) {
      return await memoized.promise;
    }
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
        if (currentCatalogResolutionMemo.get(memoKey) === entry) {
          currentCatalogResolutionMemo.delete(memoKey);
        }
        rejectPromise(error);
      },
    );
  });
  return entry;
}

function replaceCurrentCatalogResolutionMemo(
  memoKey: string,
  resolution: CatalogResolution,
  capability: CurrentCatalogResolutionMemoEntry['capability'],
): void {
  currentCatalogResolutionMemo.set(memoKey, {
    promise: Promise.resolve(resolution),
    settled: true,
    capability,
    validatedAtMs: resolution.cacheState
      ? Date.parse(resolution.cacheState.validatedAt)
      : Date.now(),
  });
}

export function clearCurrentCatalogResolutionMemoForTests(): void {
  currentCatalogResolutionMemo.clear();
}

function parseCatalogSummary(
  rawManifest: unknown,
): PartialCatalogSummary {
  if (!isRecord(rawManifest)) {
    throw new Error('Invalid catalog manifest: expected an object.');
  }

  const catalogVersion = assertStrictSemVer(
    rawManifest.catalogVersion,
    'catalog manifest.catalogVersion',
  );
  const channel = assertCatalogChannel(
    rawManifest.channel,
    'catalog manifest.channel',
  );

  const compatibility = rawManifest.compatibility;
  if (!isRecord(compatibility) || !isRecord(compatibility.aw)) {
    throw new Error('Invalid catalog manifest.compatibility.aw: expected an object.');
  }

  const minAwVersion = assertStrictSemVer(
    compatibility.aw.minVersion,
    'catalog manifest.compatibility.aw.minVersion',
  );
  const historySchemaVersion =
    isRecord(rawManifest.history) && typeof rawManifest.history.schemaVersion === 'number'
      ? rawManifest.history.schemaVersion
      : null;

  return {
    catalogVersion,
    channel,
    minAwVersion,
    historySchemaVersion,
  };
}

function parseCatalogHistory(
  rawManifest: unknown,
  expectedChannel: CatalogChannel,
): ParsedCatalogHistory {
  if (!isRecord(rawManifest) || !isRecord(rawManifest.history)) {
    throw new Error('catalog history is missing.');
  }

  const history = rawManifest.history;
  const schemaVersion = typeof history.schemaVersion === 'number'
    ? history.schemaVersion
    : NaN;
  if (schemaVersion !== 1) {
    throw new Error('catalog history schemaVersion is unsupported.');
  }

  const channel = assertCatalogChannel(history.channel, 'catalog manifest.history.channel');
  if (channel !== expectedChannel) {
    throw new Error(`catalog history channel ${channel} does not match requested channel ${expectedChannel}.`);
  }

  if (!Array.isArray(history.releases) || history.releases.length === 0) {
    throw new Error('catalog history releases are missing.');
  }

  const releases = history.releases.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`catalog history release[${index}] is invalid.`);
    }

    return {
      catalogVersion: assertStrictSemVer(
        entry.catalogVersion,
        `catalog manifest.history.releases[${index}].catalogVersion`,
      ),
      minAwVersion: assertStrictSemVer(
        entry.minAwVersion,
        `catalog manifest.history.releases[${index}].minAwVersion`,
      ),
    };
  });

  for (let index = 1; index < releases.length; index += 1) {
    if (compareStrictSemVer(releases[index - 1]!.catalogVersion, releases[index]!.catalogVersion) >= 0) {
      throw new Error('catalog history releases must be strictly increasing.');
    }
  }

  return {
    schemaVersion,
    releases,
  };
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
  const latestHistoryRelease = manifest.history.releases[manifest.history.releases.length - 1];
  if (
    !latestHistoryRelease ||
    manifest.history.channel !== manifest.channel ||
    latestHistoryRelease.catalogVersion !== manifest.catalogVersion ||
    latestHistoryRelease.minAwVersion !== manifest.compatibility.aw.minVersion
  ) {
    throw new Error('catalog history latest release does not match the sidecar summary.');
  }
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

function selectLatestCompatibleHistoryRelease(
  history: ParsedCatalogHistory,
  cliVersion: CliVersion,
): CatalogHistoryReleaseSummary | null {
  const compatible = history.releases.filter((release) =>
    isCompatibleWithCliVersion(cliVersion, release.minAwVersion),
  );
  return compatible.length > 0 ? compatible[compatible.length - 1]! : null;
}

async function resolveCatalogTarget(
  selector: CatalogSelector,
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
      historySchemaVersion: null,
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

  let requestedSidecarArchive: CatalogPackageArchive | null = null;
  try {
    try {
      requestedSidecarArchive = await resolveArchiveByIdentity(requestedSidecarIdentity, env, signal);
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: getRequestedCatalogChannel(selector) ?? undefined,
        catalogVersion: requestedSidecarIdentity.version,
        historySchemaVersion: null,
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

    let requestedSummary: PartialCatalogSummary;
    try {
      requestedSummary = parseCatalogSummary(requestedSidecarArchive.rawManifest);
      if (requestedSummary.catalogVersion !== requestedSidecarIdentity.version) {
        throw new Error(`sidecar manifest version ${requestedSummary.catalogVersion} does not match identity ${requestedSidecarIdentity.version}.`);
      }
      if (
        selector.kind !== 'exactVersion' &&
        requestedSummary.channel !== getRequestedCatalogChannel(selector)
      ) {
        throw new Error(`sidecar manifest channel ${requestedSummary.channel} does not match selector channel ${getRequestedCatalogChannel(selector)}.`);
      }
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: getRequestedCatalogChannel(selector) ?? undefined,
        catalogVersion: requestedSidecarIdentity.version,
        historySchemaVersion: null,
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
        reason: `current catalog sidecar manifest 无法解析：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    if (selector.kind === 'exactVersion') {
      if (!isCompatibleWithCliVersion(selector.cliVersion, requestedSummary.minAwVersion)) {
        throwCatalogResolutionFailure({
          selector,
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
          historySchemaVersion: requestedSummary.historySchemaVersion,
          cacheFallback: {
            used: false,
          },
          reason: `显式 catalog 版本 ${requestedSummary.catalogVersion} 需要 aw >= ${requestedSummary.minAwVersion}，当前 CLI 为 ${selector.cliVersion}。`,
          reasonCode: 'explicitCatalogIncompatible',
        });
      }

      try {
        const validated = await validateResolvedCatalogArchive(requestedSidecarArchive);
        return {
          manifest: validated.manifest,
          manifestText: validated.manifestText,
          sidecarIdentity: requestedSidecarIdentity,
          sidecarManifestPackage: buildSidecarManifestPackageEvidence(
            requestedSidecarIdentity,
            validated.manifest,
            validated.manifestText,
          ),
          latestCatalog: {
            channel: validated.manifest.channel,
            catalogVersion: validated.manifest.catalogVersion,
            minAwVersion: validated.manifest.compatibility.aw.minVersion,
            blocked: false,
          },
          historySchemaVersion: validated.manifest.history.schemaVersion,
          resolutionSource: 'requestedCatalog',
        };
      } catch (error) {
        throwCatalogResolutionFailure({
          selector,
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
          historySchemaVersion: requestedSummary.historySchemaVersion,
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
          reason: `显式 catalog sidecar manifest 校验失败：${normalizeErrorMessage(error)}`,
          reasonCode: 'catalogUnavailable',
        });
      }
    }

    if (isCompatibleWithCliVersion(selector.cliVersion, requestedSummary.minAwVersion)) {
      try {
        const validated = await validateResolvedCatalogArchive(requestedSidecarArchive);
        return {
          manifest: validated.manifest,
          manifestText: validated.manifestText,
          sidecarIdentity: requestedSidecarIdentity,
          sidecarManifestPackage: buildSidecarManifestPackageEvidence(
            requestedSidecarIdentity,
            validated.manifest,
            validated.manifestText,
          ),
          latestCatalog: {
            channel: validated.manifest.channel,
            catalogVersion: validated.manifest.catalogVersion,
            minAwVersion: validated.manifest.compatibility.aw.minVersion,
            blocked: false,
          },
          historySchemaVersion: validated.manifest.history.schemaVersion,
          resolutionSource: 'requestedCatalog',
        };
      } catch (error) {
        throwCatalogResolutionFailure({
          selector,
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
          historySchemaVersion: requestedSummary.historySchemaVersion,
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
    }

    const requestedChannel = getRequestedCatalogChannel(selector)!;
    let history: ParsedCatalogHistory;
    try {
      history = parseCatalogHistory(requestedSidecarArchive.rawManifest, requestedChannel);
      const latestHistoryRelease = history.releases[history.releases.length - 1]!;
      if (
        latestHistoryRelease.catalogVersion !== requestedSummary.catalogVersion ||
        latestHistoryRelease.minAwVersion !== requestedSummary.minAwVersion
      ) {
        throw new Error('catalog history latest release does not match the latest sidecar summary.');
      }
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: requestedSummary.channel,
        catalogVersion: requestedSummary.catalogVersion,
        minAwVersion: requestedSummary.minAwVersion,
        latestCatalogBlocked: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
        },
        historySchemaVersion: requestedSummary.historySchemaVersion,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'historyLookup',
          normalizeErrorMessage(error),
          {
            packageName: requestedSidecarIdentity.packageName,
            packageVersion: requestedSidecarIdentity.version,
            integrity: requestedSidecarIdentity.integrity,
          },
        ),
        reason: `当前 ${requestedChannel} 轨道最新 catalog 不兼容，且 history 不可用：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogHistoryUnavailable',
      });
    }

    const compatibleHistoryRelease = selectLatestCompatibleHistoryRelease(history, selector.cliVersion);
    if (!compatibleHistoryRelease) {
      throwCatalogResolutionFailure({
        selector,
        channel: requestedSummary.channel,
        catalogVersion: requestedSummary.catalogVersion,
        minAwVersion: requestedSummary.minAwVersion,
        latestCatalogBlocked: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
        },
        historySchemaVersion: history.schemaVersion,
        cacheFallback: {
          used: false,
        },
        reason: `当前 CLI 版本 ${selector.cliVersion} 低于 ${requestedChannel} 轨道可用 catalog 的最低兼容版本。`,
        reasonCode: 'awVersionTooLow',
      });
    }

    let fallbackSidecarIdentity: CatalogPackageArchiveIdentity;
    try {
      fallbackSidecarIdentity = await resolveCatalogPackageIdentityByVersion(
        CURRENT_CATALOG_MANIFEST_PACKAGE,
        compatibleHistoryRelease.catalogVersion,
        env,
        signal,
      );
      if (
        fallbackSidecarIdentity.packageName !== CURRENT_CATALOG_MANIFEST_PACKAGE ||
        fallbackSidecarIdentity.version !== compatibleHistoryRelease.catalogVersion
      ) {
        throw new Error(`history fallback identity ${fallbackSidecarIdentity.packageName}@${fallbackSidecarIdentity.version} does not match ${compatibleHistoryRelease.catalogVersion}.`);
      }
    } catch (error) {
      throwCatalogResolutionFailure({
        selector,
        channel: requestedSummary.channel,
        catalogVersion: compatibleHistoryRelease.catalogVersion,
        minAwVersion: compatibleHistoryRelease.minAwVersion,
        latestCatalogBlocked: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
        },
        historySchemaVersion: history.schemaVersion,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'sidecarMetadata',
          normalizeErrorMessage(error),
          {
            packageName: CURRENT_CATALOG_MANIFEST_PACKAGE,
            packageVersion: compatibleHistoryRelease.catalogVersion,
          },
        ),
        reason: `无法解析兼容 catalog ${compatibleHistoryRelease.catalogVersion} 的 sidecar metadata：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    }

    let fallbackSidecarArchive: CatalogPackageArchive | null = null;
    try {
      try {
        fallbackSidecarArchive = await resolveArchiveByIdentity(fallbackSidecarIdentity, env, signal);
      } catch (error) {
        throwCatalogResolutionFailure({
          selector,
          channel: requestedSummary.channel,
          catalogVersion: compatibleHistoryRelease.catalogVersion,
          minAwVersion: compatibleHistoryRelease.minAwVersion,
          latestCatalogBlocked: {
            channel: requestedSummary.channel,
            catalogVersion: requestedSummary.catalogVersion,
            minAwVersion: requestedSummary.minAwVersion,
          },
          historySchemaVersion: history.schemaVersion,
          cacheFallback: {
            used: false,
          },
          remoteFailure: createRemoteFailure(
            'sidecarTarball',
            normalizeErrorMessage(error),
            {
              packageName: fallbackSidecarIdentity.packageName,
              packageVersion: fallbackSidecarIdentity.version,
              integrity: fallbackSidecarIdentity.integrity,
            },
          ),
          reason: `无法下载兼容 catalog ${compatibleHistoryRelease.catalogVersion} 的 sidecar：${normalizeErrorMessage(error)}`,
          reasonCode: 'catalogUnavailable',
        });
      }

      const validated = await validateResolvedCatalogArchive(fallbackSidecarArchive);
      if (
        validated.manifest.catalogVersion !== compatibleHistoryRelease.catalogVersion ||
        validated.manifest.compatibility.aw.minVersion !== compatibleHistoryRelease.minAwVersion ||
        validated.manifest.channel !== requestedChannel
      ) {
        throw new Error(`history fallback catalog ${validated.manifest.catalogVersion} does not match the selected history release.`);
      }

      return {
        manifest: validated.manifest,
        manifestText: validated.manifestText,
        sidecarIdentity: fallbackSidecarIdentity,
        sidecarManifestPackage: buildSidecarManifestPackageEvidence(
          fallbackSidecarIdentity,
          validated.manifest,
          validated.manifestText,
        ),
        latestCatalog: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
          blocked: true,
        },
        latestCatalogBlocked: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
        },
        historySchemaVersion: history.schemaVersion,
        resolutionSource: 'historyCompatibleCatalog',
      };
    } catch (error) {
      if (isCatalogResolutionError(error)) {
        throw error;
      }

      throwCatalogResolutionFailure({
        selector,
        channel: requestedSummary.channel,
        catalogVersion: compatibleHistoryRelease.catalogVersion,
        minAwVersion: compatibleHistoryRelease.minAwVersion,
        latestCatalogBlocked: {
          channel: requestedSummary.channel,
          catalogVersion: requestedSummary.catalogVersion,
          minAwVersion: requestedSummary.minAwVersion,
        },
        historySchemaVersion: history.schemaVersion,
        cacheFallback: {
          used: false,
        },
        remoteFailure: createRemoteFailure(
          'sidecarManifest',
          normalizeErrorMessage(error),
          {
            packageName: fallbackSidecarIdentity.packageName,
            packageVersion: fallbackSidecarIdentity.version,
            integrity: fallbackSidecarIdentity.integrity,
          },
        ),
        reason: `兼容 catalog ${compatibleHistoryRelease.catalogVersion} 的 sidecar manifest 校验失败：${normalizeErrorMessage(error)}`,
        reasonCode: 'catalogUnavailable',
      });
    } finally {
      await disposeCatalogArchiveBounded(fallbackSidecarArchive, signal);
    }
  } finally {
    await disposeCatalogArchiveBounded(requestedSidecarArchive, signal);
  }

  throw new Error('resolveCatalogTarget reached an unreachable state.');
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
  resolutionSource: NonNullable<ResolvedCatalogTarget['resolutionSource']>,
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
    resolutionSource,
  };
}

function buildCurrentCatalogCacheObservation(
  target: ResolvedCatalogTarget,
): CurrentCatalogCacheObservation {
  if (!target.resolutionSource) {
    throw new Error('Current catalog target is missing resolutionSource.');
  }
  return {
    sidecarManifestPackage: target.sidecarManifestPackage,
    ...(target.latestCatalog ? { latestCatalog: target.latestCatalog } : {}),
    ...(target.latestCatalogBlocked ? { latestCatalogBlocked: target.latestCatalogBlocked } : {}),
    historySchemaVersion: target.historySchemaVersion,
    resolutionSource: target.resolutionSource,
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
  const matchedCatalog = options.target.resolutionSource
    ? buildFullCatalogEvidence(
      { source: 'cache' },
      options.target.manifest,
      options.cacheEntry.metadata.manifestDigest,
      options.target.resolutionSource,
    )
    : undefined;

  return {
    rootDir: options.cacheEntry.rootDir,
    source: 'cache',
    selector: options.selector,
    sidecarManifestPackage: options.target.sidecarManifestPackage,
    ...(matchedCatalog ? { fullCatalog: matchedCatalog } : {}),
    channel: options.target.manifest.channel,
    catalogVersion: options.target.manifest.catalogVersion,
    minAwVersion: options.target.manifest.compatibility.aw.minVersion,
    ...(options.target.latestCatalog ? { latestCatalog: options.target.latestCatalog } : {}),
    ...(options.target.latestCatalogBlocked ? { latestCatalogBlocked: options.target.latestCatalogBlocked } : {}),
    historySchemaVersion: options.target.historySchemaVersion,
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
): Promise<CurrentCatalogCacheEntry | null> {
  const cacheEntry = await readCurrentCatalogCacheEntry(identity, env);
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
): Promise<{
  cacheEntry: CurrentCatalogCacheEntry;
  target: ResolvedCatalogTarget;
} | null> {
  const cacheEntry = await readCurrentCatalogCacheEntryBySelector(selector, env);
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
      manifest.history.schemaVersion !== cacheEntry.metadata.historySchemaVersion ||
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
        ...(cacheEntry.observation?.latestCatalog
          ? { latestCatalog: cacheEntry.observation.latestCatalog }
          : {}),
        ...(cacheEntry.observation?.latestCatalogBlocked
          ? { latestCatalogBlocked: cacheEntry.observation.latestCatalogBlocked }
          : {}),
        historySchemaVersion: cacheEntry.observation?.historySchemaVersion ?? manifest.history.schemaVersion,
        ...(cacheEntry.observation?.resolutionSource
          ? { resolutionSource: cacheEntry.observation.resolutionSource }
          : {}),
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
): Promise<CatalogResolution | null> {
  const cached = await readValidatedCurrentCatalogCacheEntryBySelector(selector, env);
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
  error: unknown,
): Promise<CatalogResolution | null> {
  const failure = classifyRemoteCatalogFailure(selector, error);
  if (!failure) {
    return null;
  }
  const cached = await readValidatedCurrentCatalogCacheEntryBySelector(selector, env);
  if (!cached) {
    if (isCatalogResolutionError(error)) {
      throw error;
    }
    throw new CatalogResolutionError(failure);
  }
  const matchedCatalog = cached.target.resolutionSource
    ? buildFullCatalogEvidence(
      { source: 'cache' },
      cached.target.manifest,
      cached.cacheEntry.metadata.manifestDigest,
      cached.target.resolutionSource,
    )
    : undefined;
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
      ...(matchedCatalog ? { matchedCatalog } : {}),
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
      latestCatalogBlocked: target.latestCatalogBlocked,
      historySchemaVersion: target.historySchemaVersion,
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
    historySchemaVersion: target.manifest.history.schemaVersion,
    sidecarIntegrity: target.sidecarIdentity.integrity,
    fullIntegrity: fullIdentity.integrity,
  } as const;

  let fullArchive: CatalogPackageArchive | null = null;
  let cacheEntry = null as Awaited<ReturnType<typeof readCurrentCatalogCacheEntry>> | null;
  try {
    if (options.freshnessPolicy !== 'forceRemote' && options.forceRefresh !== true) {
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(cacheIdentity, target, env);
      if (cacheEntry) {
        cacheEntry = await markCurrentCatalogCacheEntryValidated(
          cacheEntry,
          env,
          new Date().toISOString(),
          buildCurrentCatalogCacheObservation(target),
          signal,
        );
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
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(cacheIdentity, target, env);
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
              target.resolutionSource!,
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
        latestCatalogBlocked: target.latestCatalogBlocked,
        historySchemaVersion: target.historySchemaVersion,
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
      cacheEntry = await readValidatedCurrentCatalogCacheEntry(cacheIdentity, target, env);
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
              target.resolutionSource!,
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
        latestCatalogBlocked: target.latestCatalogBlocked,
        historySchemaVersion: target.historySchemaVersion,
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
      );
      const cacheResult = existingCacheEntry
        ? await markCurrentCatalogCacheEntryValidated(
          existingCacheEntry,
          env,
          new Date().toISOString(),
          buildCurrentCatalogCacheObservation(target),
          signal,
        )
        : await writeCurrentCatalogCacheEntry({
          ...cacheIdentity,
          sourceRoot: fullArchive.packageRoot,
          env,
          observation: buildCurrentCatalogCacheObservation(target),
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
          target.resolutionSource!,
        ),
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        latestCatalog: target.latestCatalog,
        latestCatalogBlocked: target.latestCatalogBlocked,
        historySchemaVersion: target.historySchemaVersion,
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
          target.resolutionSource!,
        ),
        channel: target.manifest.channel,
        catalogVersion: target.manifest.catalogVersion,
        minAwVersion: target.manifest.compatibility.aw.minVersion,
        latestCatalog: target.latestCatalog,
        latestCatalogBlocked: target.latestCatalogBlocked,
        historySchemaVersion: target.historySchemaVersion,
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
      resolutionSource: 'requestedCatalog',
    },
    channel: manifest.channel,
    catalogVersion: manifest.catalogVersion,
    minAwVersion: manifest.compatibility.aw.minVersion,
    latestCatalog: {
      channel: manifest.channel,
      catalogVersion: manifest.catalogVersion,
      minAwVersion: manifest.compatibility.aw.minVersion,
      blocked: false,
    },
    historySchemaVersion: manifest.history.schemaVersion,
  };
}

async function resolveCurrentCatalogWithRemoteDeadline(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
  options: ResolveCurrentCatalogRuntimeOptions,
  timeoutMs: number,
): Promise<CatalogResolution> {
  if (timeoutMs === 0) {
    try {
      return await resolveCurrentCatalogUncached(selector, env, options);
    } catch (error) {
      const fallback = await resolveCatalogFailureFromSelectorCache(
        selector,
        env,
        options.cacheTtlMs,
        error,
      );
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  }

  const controller = new AbortController();
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    const error = new CatalogRemoteDeadlineError(timeoutMs);
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  timer.unref?.();

  try {
    const work = resolveCurrentCatalogUncached(selector, env, options, controller.signal);
    void work.catch(() => {});
    try {
      return await Promise.race([work, deadline]);
    } catch (error) {
      const fallback = await resolveCatalogFailureFromSelectorCache(
        selector,
        env,
        options.cacheTtlMs,
        error,
      );
      if (fallback) {
        return fallback;
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveCurrentCatalog(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCurrentCatalogOptions = {},
): Promise<CatalogResolution> {
  const runtimePolicy = readCatalogRuntimePolicy(env, options);
  const selector = await resolveEffectiveCatalogSelector(env, options);
  const effectiveOptions: ResolveCurrentCatalogRuntimeOptions = {
    ...options,
    freshnessPolicy: runtimePolicy.freshnessPolicy,
    cacheTtlMs: runtimePolicy.cacheTtlMs,
    remoteTimeoutMs: runtimePolicy.remoteTimeoutMs,
  };
  const normalMemoKey = buildCurrentCatalogMemoKey(
    selector,
    env,
    { ...effectiveOptions, forceRefresh: false },
  );

  if (runtimePolicy.freshnessPolicy === 'forceRemote') {
    const resolved = await resolveCurrentCatalogWithRemoteDeadline(
      selector,
      env,
      effectiveOptions,
      runtimePolicy.remoteTimeoutMs,
    );
    replaceCurrentCatalogResolutionMemo(normalMemoKey, resolved, 'remoteChecked');
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
      const memoized = await readCurrentCatalogMemoEntry(
        normalMemoKey,
        observed,
        runtimePolicy.cacheTtlMs,
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
        if (runtimePolicy.freshnessPolicy === 'cacheFirst') {
          const cached = await tryResolveCacheFirstCatalog(
            selector,
            env,
            runtimePolicy.cacheTtlMs,
          );
          if (cached) {
            return cached;
          }
          const current = currentCatalogResolutionMemo.get(normalMemoKey);
          if (current !== entry && current?.capability === 'remoteChecked') {
            return current.promise;
          }
          entry.capability = 'remoteChecked';
        }
        return resolveCurrentCatalogWithRemoteDeadline(
          selector,
          env,
          effectiveOptions,
          runtimePolicy.remoteTimeoutMs,
        );
      },
    );
    if (reserved) {
      return reserved.promise;
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
