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
  readCliPackageInfo,
  readCurrentCatalogCacheEntry,
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

export interface ResolveCurrentCatalogOptions {
  cliVersion?: CliVersion;
  channel?: CatalogChannel;
  catalogVersion?: CatalogVersion;
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
  latestCatalog: NonNullable<CatalogResolution['latestCatalog']>;
  latestCatalogBlocked?: CatalogResolution['latestCatalogBlocked'];
  historySchemaVersion: number | null;
  resolutionSource: NonNullable<CatalogResolution['fullCatalog']>['resolutionSource'];
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
): Promise<CatalogPackageArchive> {
  return downloadCatalogPackageArchive(identity, env);
}

async function resolveRequestedSidecarIdentity(
  selector: CatalogSelector,
  env: NodeJS.ProcessEnv,
): Promise<CatalogPackageArchiveIdentity> {
  if (selector.kind === 'exactVersion') {
    return resolveCatalogPackageIdentityByVersion(
      CURRENT_CATALOG_MANIFEST_PACKAGE,
      selector.requestedCatalogVersion!,
      env,
    );
  }

  return resolveCatalogPackageIdentityByDistTag(
    CURRENT_CATALOG_MANIFEST_PACKAGE,
    getRequestedCatalogChannel(selector)!,
    env,
  );
}

async function validateResolvedCatalogArchive(
  archive: CatalogPackageArchive,
): Promise<{ manifest: CatalogManifest; manifestText: string }> {
  return {
    manifest: validateCatalogManifest(archive.rawManifest),
    manifestText: archive.manifestText,
  };
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
): Promise<ResolvedCatalogTarget> {
  let requestedSidecarIdentity: CatalogPackageArchiveIdentity;
  try {
    requestedSidecarIdentity = await resolveRequestedSidecarIdentity(selector, env);
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
      requestedSidecarArchive = await resolveArchiveByIdentity(requestedSidecarIdentity, env);
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
      );
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
        fallbackSidecarArchive = await resolveArchiveByIdentity(fallbackSidecarIdentity, env);
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
      if (!isCompatibleWithCliVersion(selector.cliVersion, validated.manifest.compatibility.aw.minVersion)) {
        throw new Error(`catalog ${validated.manifest.catalogVersion} is still incompatible with CLI ${selector.cliVersion}.`);
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
      await fallbackSidecarArchive?.dispose();
    }
  } finally {
    await requestedSidecarArchive?.dispose();
  }

  throw new Error('resolveCatalogTarget reached an unreachable state.');
}

async function validateMaterializedCatalog(
  options: {
    manifest: CatalogManifest;
    sidecarManifestText: string;
    rootDir: string;
  },
): Promise<void> {
  const manifestPath = path.join(options.rootDir, CURRENT_CATALOG_MANIFEST_FILE);
  const fullManifestText = await fs.readFile(manifestPath, 'utf8');
  if (fullManifestText !== options.sidecarManifestText) {
    throw new Error('sidecar manifest and full catalog manifest differ.');
  }

  for (const entry of options.manifest.entries) {
    const pluginRoot = path.join(options.rootDir, entry.source);
    const {
      manifestDigest,
      artifactDigest,
    } = await calculateCatalogEntryDigestsFromRoot(pluginRoot);
    if (manifestDigest !== entry.manifestDigest) {
      throw new Error(
        `plugin "${entry.name}" manifestDigest mismatch: expected ${entry.manifestDigest}, got ${manifestDigest}.`,
      );
    }

    if (artifactDigest !== entry.artifactDigest) {
      throw new Error(
        `plugin "${entry.name}" artifactDigest mismatch: expected ${entry.artifactDigest}, got ${artifactDigest}.`,
      );
    }
  }
}

function buildFullCatalogEvidence(
  resolution: Pick<CatalogResolution, 'source'>,
  manifest: CatalogManifest,
  revision: string,
  resolutionSource: ResolvedCatalogTarget['resolutionSource'],
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

async function materializeRetainedCatalogRoot(
  archive: CatalogPackageArchive,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
  await fs.ensureDir(stagingParent);
  const retainedRoot = await fs.mkdtemp(path.join(stagingParent, 'validated-remote-'));

  try {
    await archive.materialize(retainedRoot);
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
): Promise<CatalogResolution> {
  let fullIdentity: CatalogPackageArchiveIdentity;
  try {
    fullIdentity = await resolveCatalogPackageIdentityByVersion(
      CURRENT_CATALOG_FULL_PACKAGE,
      target.manifest.catalogVersion,
      env,
    );
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
    try {
      fullArchive = await resolveArchiveByIdentity(fullIdentity, env);
    } catch (error) {
      cacheEntry = await readCurrentCatalogCacheEntry(cacheIdentity, env);
      if (cacheEntry) {
        return {
          rootDir: cacheEntry.rootDir,
          source: 'cache',
          selector,
          sidecarManifestPackage: target.sidecarManifestPackage,
          fullCatalog: buildFullCatalogEvidence(
            { source: 'cache' },
            target.manifest,
            cacheEntry.metadata.manifestDigest,
            target.resolutionSource,
          ),
          channel: target.manifest.channel,
          catalogVersion: target.manifest.catalogVersion,
          minAwVersion: target.manifest.compatibility.aw.minVersion,
          latestCatalog: target.latestCatalog,
          latestCatalogBlocked: target.latestCatalogBlocked,
          historySchemaVersion: target.historySchemaVersion,
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
              target.resolutionSource,
            ),
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
          reason: normalizeErrorMessage(error),
        };
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
      if (validatedFullManifest.catalogVersion !== target.manifest.catalogVersion) {
        throw new Error(`full catalog version ${validatedFullManifest.catalogVersion} does not match sidecar ${target.manifest.catalogVersion}.`);
      }

      await validateMaterializedCatalog({
        manifest: target.manifest,
        sidecarManifestText: target.manifestText,
        rootDir: fullArchive.packageRoot,
      });
    } catch (error) {
      cacheEntry = await readCurrentCatalogCacheEntry(cacheIdentity, env);
      if (cacheEntry) {
        return {
          rootDir: cacheEntry.rootDir,
          source: 'cache',
          selector,
          sidecarManifestPackage: target.sidecarManifestPackage,
          fullCatalog: buildFullCatalogEvidence(
            { source: 'cache' },
            target.manifest,
            cacheEntry.metadata.manifestDigest,
            target.resolutionSource,
          ),
          channel: target.manifest.channel,
          catalogVersion: target.manifest.catalogVersion,
          minAwVersion: target.manifest.compatibility.aw.minVersion,
          latestCatalog: target.latestCatalog,
          latestCatalogBlocked: target.latestCatalogBlocked,
          historySchemaVersion: target.historySchemaVersion,
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
              target.resolutionSource,
            ),
          },
          remoteFailure: createRemoteFailure(
            error instanceof Error && error.message.includes('artifactDigest mismatch')
              ? 'artifactDigest'
              : 'fullManifest',
            normalizeErrorMessage(error),
            {
              packageName: fullIdentity.packageName,
              packageVersion: fullIdentity.version,
              integrity: fullIdentity.integrity,
            },
          ),
          reason: normalizeErrorMessage(error),
        };
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
          error instanceof Error && error.message.includes('artifactDigest mismatch')
            ? 'artifactDigest'
            : 'fullManifest',
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
      const cacheResult = await writeCurrentCatalogCacheEntry({
        ...cacheIdentity,
        sourceRoot: fullArchive.packageRoot,
        env,
      });
      await fullArchive.dispose();
      fullArchive = null;

      return {
        rootDir: cacheResult.rootDir,
        source: 'remote',
        selector,
        sidecarManifestPackage: target.sidecarManifestPackage,
        fullCatalog: buildFullCatalogEvidence(
          { source: 'remote' },
          target.manifest,
          cacheResult.metadata.manifestDigest,
          target.resolutionSource,
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
      };
    } catch (error) {
      if (!fullArchive) {
        throw new Error('full catalog archive is unavailable after validation.');
      }
      const retainedRoot = await materializeRetainedCatalogRoot(fullArchive, env);

      return {
        rootDir: retainedRoot,
        source: 'remote',
        selector,
        sidecarManifestPackage: target.sidecarManifestPackage,
        fullCatalog: buildFullCatalogEvidence(
          { source: 'remote' },
          target.manifest,
          calculateManifestTextDigest(target.manifestText),
          target.resolutionSource,
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
    await fullArchive?.dispose();
  }
}

async function tryResolveFixtureCatalogOverride(
  selector: CatalogSelector,
): Promise<CatalogResolution | null> {
  const overrideRoot = getEmbeddedPluginsRootOverrideForTests();
  if (!overrideRoot) {
    return null;
  }

  const manifestPath = path.join(overrideRoot, '.catalog', CURRENT_CATALOG_MANIFEST_FILE);
  if (!(await fs.pathExists(manifestPath))) {
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
    rootDir: overrideRoot,
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

export async function resolveCurrentCatalog(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveCurrentCatalogOptions = {},
): Promise<CatalogResolution> {
  const selector = await resolveEffectiveCatalogSelector(env, options);
  if (!hasCatalogPackageSourceOverrideForTests()) {
    const fixtureCatalog = await tryResolveFixtureCatalogOverride(selector);
    if (fixtureCatalog) {
      return fixtureCatalog;
    }
  }

  const target = await resolveCatalogTarget(selector, env);
  return await resolveValidatedCatalogRoot(selector, target, env);
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
