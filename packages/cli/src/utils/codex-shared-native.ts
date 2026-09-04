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
  if (listEntry.version !== undefined && listEntry.version !== evidence.desiredVersion) {
    return {
      state: 'replaceable',
      reason: 'outdated',
      version: listEntry.version,
      desiredVersion: evidence.desiredVersion,
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
