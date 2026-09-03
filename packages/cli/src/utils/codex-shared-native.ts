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
  | 'payloadDigestMismatch';

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
      version: string;
    }
  | {
      state: 'replaceable';
      reason: 'outdated' | 'damaged';
      version?: string;
      desiredVersion?: string;
      diagnostic?: CodexSharedNativeDiagnostic;
    }
  | {
      state: 'blocked';
      reason: 'foreign' | 'unreadable';
      diagnostic: CodexSharedNativeDiagnostic;
    };

export type CodexSharedNativeManifestEvidence =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | {
      state: 'present';
      identity: string;
      version: string;
      payloadDigest?: string;
      payloadPath: string;
      pathSafe: boolean;
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
  manifest: CodexSharedNativeManifestEvidence;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export function isCanonicalCodexMarketplaceRegistration(
  registration: CodexMarketplaceSnapshot | undefined,
  canonicalMarketplaceRoot: string,
): boolean {
  return registration?.sourceType === 'local'
    && registration.sourcePointsToManifest === false
    && typeof registration.source === 'string'
    && samePath(registration.source, canonicalMarketplaceRoot);
}

function damaged(diagnostic: CodexSharedNativeDiagnostic): CodexSharedNativeInspection {
  return { state: 'replaceable', reason: 'damaged', diagnostic };
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
    return evidence.manifest.state === 'absent'
      ? { state: 'unobserved' }
      : { state: 'unobserved', staleCacheObserved: true };
  }
  if (evidence.observation.state === 'failed') {
    return blocked(
      'unreadable',
      evidence.observation.reason === 'duplicate' ? 'pluginListDuplicate' : 'pluginListUnavailable',
    );
  }
  if (evidence.observation.value === 'absent') {
    return evidence.manifest.state === 'absent'
      ? { state: 'missing' }
      : { state: 'missing', staleCacheObserved: true };
  }
  const listEntry = evidence.observation.entry;
  if (evidence.marketplaceRegistration && !isCanonicalCodexMarketplaceRegistration(
    evidence.marketplaceRegistration,
    evidence.canonicalMarketplaceRoot,
  )) {
    return blocked('foreign', 'marketplaceRegistrationForeign');
  }
  if (evidence.manifest.state === 'unreadable') return blocked('unreadable', 'manifestUnreadable');
  if (evidence.manifest.state === 'absent') {
    return damaged('manifestMissing');
  }
  if (!evidence.marketplaceRegistration) {
    return blocked('foreign', 'marketplaceRegistrationForeign');
  }
  if (!evidence.manifest.pathSafe) return blocked('foreign', 'payloadPathUnsafe');
  if (
    evidence.manifest.identity !== evidence.pluginId
    && evidence.manifest.identity !== evidence.pluginName
  ) {
    return blocked('foreign', 'manifestIdentityMismatch');
  }
  if (!tryParseStrictSemVer(evidence.manifest.version)) {
    return damaged('manifestVersionInvalid');
  }
  if (listEntry.version !== undefined && listEntry.version !== evidence.manifest.version) {
    return {
      state: 'replaceable',
      reason: 'outdated',
      version: listEntry.version,
      desiredVersion: evidence.desiredVersion,
    };
  }
  if (evidence.manifest.version !== evidence.desiredVersion) {
    return {
      state: 'replaceable',
      reason: 'outdated',
      version: evidence.manifest.version,
      desiredVersion: evidence.desiredVersion,
    };
  }
  if (evidence.expectedPayloadDigest !== undefined
    && evidence.manifest.payloadDigest !== evidence.expectedPayloadDigest) {
    return damaged('payloadDigestMismatch');
  }
  return {
    state: 'usable',
    version: evidence.manifest.version,
  };
}

export const classifyCodexSharedNativeEvidence = inspectCodexSharedNative;
