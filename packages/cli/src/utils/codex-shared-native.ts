import path from 'node:path';

import type { CodexMarketplaceSnapshot } from './codex-config.js';
import { tryParseStrictSemVer } from './manifest.js';
import type { CodexNativePluginObservation } from './codex-native-observation.js';

export type CodexSharedNativeDiagnostic =
  | 'staleCacheObserved'
  | 'marketplaceRegistrationForeign'
  | 'marketplacePathUnsafe'
  | 'pluginListUnavailable'
  | 'pluginListDuplicate'
  | 'pluginNameCollision'
  | 'pluginListVersionMismatch'
  | 'manifestMissing'
  | 'manifestUnreadable'
  | 'manifestIdentityMismatch'
  | 'manifestVersionInvalid'
  | 'payloadPathUnsafe'
  | 'payloadDigestMismatch'
  | 'projectionReceiptMissing'
  | 'projectionReceiptUnreadable'
  | 'projectionExpectedPayloadDigestMissing'
  | 'projectionReceiptIdentityMismatch'
  | 'projectionPayloadDigestMismatch'
  | 'projectionRenderDrift';

export type CodexSharedNativeState = 'missing' | 'usable' | 'replaceable' | 'blocked' | 'unobserved';

export type CodexSharedNativeInspection =
  | {
      state: 'unobserved';
      staleCacheObserved?: true;
    }
  | {
      state: 'missing';
      staleCacheObserved?: true;
    }
  | {
      state: 'usable';
      version?: string;
    }
  | {
      state: 'replaceable';
      reason: 'outdated' | 'damaged' | 'renderDrift';
      version?: string;
      desiredVersion?: string;
      diagnostic?: CodexSharedNativeDiagnostic;
    }
  | {
      state: 'blocked';
      reason: 'foreign' | 'unreadable';
      diagnostic: CodexSharedNativeDiagnostic;
    };

export interface CodexSharedNativeEvidence {
  pluginName: string;
  pluginId: string;
  marketplaceName: string;
  canonicalMarketplaceRoot: string;
  desiredVersion: string;
  expectedPayloadDigest?: string;
  marketplaceRegistration?: CodexMarketplaceSnapshot;
  marketplacePathSafe: boolean;
  observation: CodexNativePluginObservation;
  sourceProjection?: 'current' | 'drifted';
  sourceProjectionIssue?: {
    reason: 'damaged' | 'foreign' | 'unreadable';
    diagnostic: CodexSharedNativeDiagnostic;
  };
}

/** Lexical local-directory identity only; this never resolves filesystem aliases. */
export function codexMarketplacePathKey(value: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  if (platform !== 'win32') return path.posix.isAbsolute(value) ? path.posix.resolve(value) : undefined;

  let local = value;
  if (local.startsWith('\\\\?\\')) {
    local = local.slice(4);
    if (local.startsWith('UNC\\')) local = `\\\\${local.slice(4)}`;
    // Verbatim paths do not interpret slash or dot components as DOS paths do.
    if (local.includes('/')) return undefined;
  } else local = local.replaceAll('/', '\\');

  let root: string;
  let components: string[];
  if (/^[A-Za-z]:\\/u.test(local)) {
    root = `${local[0]!.toUpperCase()}:\\`;
    components = local.slice(3).split('\\');
  } else if (local.startsWith('\\\\')) {
    const parts = local.slice(2).split('\\');
    if (parts.length < 2) return undefined;
    root = `\\\\${parts[0]}\\${parts[1]}`;
    components = parts.slice(2);
    if (parts.slice(0, 2).some((part) => !part || /[\u0000-\u001f<>:"/\\|?*]/u.test(part)
      || part === '.' || part === '..' || /[. ]$/u.test(part))) return undefined;
  } else return undefined;
  if (components.at(-1) === '') components.pop();
  if (components.some((part) => !part || part === '.' || part === '..'
    || /[\u0000-\u001f<>:"/\\|?*]/u.test(part) || /[. ]$/u.test(part)
    || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))) return undefined;
  return components.length ? `${root}${root.endsWith('\\') ? '' : '\\'}${components.join('\\')}` : root;
}

export function isCanonicalCodexMarketplaceRegistration(
  registration: CodexMarketplaceSnapshot | undefined,
  canonicalMarketplaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const expected = codexMarketplacePathKey(canonicalMarketplaceRoot, platform);
  return registration?.sourceType === 'local'
    && registration.sourcePointsToManifest === false
    && expected !== undefined
    && codexMarketplacePathKey(registration.source, platform) === expected;
}

function blocked(
  reason: 'foreign' | 'unreadable',
  diagnostic: CodexSharedNativeDiagnostic,
): CodexSharedNativeInspection {
  return { state: 'blocked', reason, diagnostic };
}

export function inspectCodexSharedNative(
  evidence: CodexSharedNativeEvidence,
): CodexSharedNativeInspection {
  const expectedPluginId = `${evidence.pluginName}@${evidence.marketplaceName}`;
  if (evidence.pluginId !== expectedPluginId) {
    throw new Error(`Invalid Codex shared native identity: expected ${expectedPluginId}.`);
  }
  if (!tryParseStrictSemVer(evidence.desiredVersion)) {
    throw new Error(`Invalid desired Codex shared native version: ${evidence.desiredVersion}.`);
  }
  if (evidence.expectedPayloadDigest !== undefined
    && !/^sha256:[0-9a-f]{64}$/u.test(evidence.expectedPayloadDigest)) {
    throw new Error('Invalid expected Codex shared native payload digest.');
  }

  if (!evidence.marketplacePathSafe) return blocked('foreign', 'marketplacePathUnsafe');
  if (evidence.observation.state === 'unobserved') {
    return { state: 'unobserved' };
  }
  if (evidence.observation.state === 'failed') {
    return blocked(
      'unreadable',
      evidence.observation.reason === 'duplicate' ? 'pluginListDuplicate' : 'pluginListUnavailable',
    );
  }
  if (evidence.observation.value === 'absent') {
    return { state: 'missing' };
  }
  const listEntry = evidence.observation.entry;
  if (evidence.marketplaceRegistration && !isCanonicalCodexMarketplaceRegistration(
    evidence.marketplaceRegistration,
    evidence.canonicalMarketplaceRoot,
  )) {
    return blocked('foreign', 'marketplaceRegistrationForeign');
  }
  if (!evidence.marketplaceRegistration) {
    return blocked('foreign', 'marketplaceRegistrationForeign');
  }
  if (evidence.sourceProjectionIssue
    && evidence.sourceProjectionIssue.reason !== 'damaged') {
    return blocked(
      evidence.sourceProjectionIssue.reason,
      evidence.sourceProjectionIssue.diagnostic,
    );
  }
  if (listEntry.version !== undefined && listEntry.version !== evidence.desiredVersion) {
    return {
      state: 'replaceable',
      reason: 'outdated',
      version: listEntry.version,
      desiredVersion: evidence.desiredVersion,
    };
  }
  if (evidence.sourceProjectionIssue?.reason === 'damaged') {
    return {
      state: 'replaceable',
      reason: 'damaged',
      ...(listEntry.version ? { version: listEntry.version } : {}),
      desiredVersion: evidence.desiredVersion,
      diagnostic: evidence.sourceProjectionIssue.diagnostic,
    };
  }
  if (evidence.sourceProjection === 'drifted') {
    return {
      state: 'replaceable',
      reason: 'renderDrift',
      ...(listEntry.version ? { version: listEntry.version } : {}),
      desiredVersion: evidence.desiredVersion,
      diagnostic: 'projectionRenderDrift',
    };
  }
  return {
    state: 'usable',
    ...(listEntry.version ? { version: listEntry.version } : {}),
  };
}

export const classifyCodexSharedNativeEvidence = inspectCodexSharedNative;
