import path from 'node:path';

import type { CodexMarketplaceSnapshot } from './codex-config.js';
import { tryParseStrictSemVer } from './manifest.js';
import type { CodexPluginListEntry } from './native-cli.js';

export type CodexSharedNativeDiagnostic =
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

export type CodexSharedNativeState =
  | { state: 'absent'; nativeAction: 'install' }
  | { state: 'claimable'; version: string; nativeAction: 'none' }
  | { state: 'present'; version: string; nativeAction: 'none' }
  | {
      state: 'outdated';
      version: string;
      desiredVersion: string;
      nativeAction: 'replace';
    }
  | {
      state: 'corrupt';
      diagnostic: CodexSharedNativeDiagnostic;
      nativeAction: 'blocked';
    }
  | {
      state: 'foreign';
      diagnostic: CodexSharedNativeDiagnostic;
      nativeAction: 'blocked';
    };

export type CodexSharedNativeManifestEvidence =
  | { state: 'absent' }
  | { state: 'unreadable' }
  | {
      state: 'present';
      identity: string;
      version: string;
      payloadDigest: string;
      payloadPath: string;
      pathSafe: boolean;
    };

export interface CodexSharedNativeEvidence {
  pluginName: string;
  pluginId: string;
  marketplaceName: string;
  canonicalMarketplaceRoot: string;
  desiredVersion: string;
  expectedPayloadDigest: string;
  marketplaceRegistration?: CodexMarketplaceSnapshot;
  marketplacePathSafe: boolean;
  pluginListEntries: CodexPluginListEntry[] | null;
  manifest: CodexSharedNativeManifestEvidence;
  managedByCurrentIntent: boolean;
}

function namespacedPluginName(pluginId: string): string | null {
  const separator = pluginId.lastIndexOf('@');
  return separator > 0 ? pluginId.slice(0, separator) : null;
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

function corrupt(diagnostic: CodexSharedNativeDiagnostic): CodexSharedNativeState {
  return { state: 'corrupt', diagnostic, nativeAction: 'blocked' };
}

function foreign(diagnostic: CodexSharedNativeDiagnostic): CodexSharedNativeState {
  return { state: 'foreign', diagnostic, nativeAction: 'blocked' };
}

export function inspectCodexSharedNative(
  evidence: CodexSharedNativeEvidence,
): CodexSharedNativeState {
  const expectedPluginId = `${evidence.pluginName}@${evidence.marketplaceName}`;
  if (evidence.pluginId !== expectedPluginId) {
    throw new Error(`Invalid Codex shared native identity: expected ${expectedPluginId}.`);
  }
  if (!tryParseStrictSemVer(evidence.desiredVersion)) {
    throw new Error(`Invalid desired Codex shared native version: ${evidence.desiredVersion}.`);
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(evidence.expectedPayloadDigest)) {
    throw new Error('Invalid expected Codex shared native payload digest.');
  }

  if (evidence.marketplaceRegistration && !isCanonicalCodexMarketplaceRegistration(
    evidence.marketplaceRegistration,
    evidence.canonicalMarketplaceRoot,
  )) {
    return foreign('marketplaceRegistrationForeign');
  }
  if (!evidence.marketplacePathSafe) return foreign('marketplacePathUnsafe');
  if (evidence.pluginListEntries === null) return corrupt('pluginListUnavailable');

  const nameCollisions = evidence.pluginListEntries.filter((entry) =>
    namespacedPluginName(entry.pluginId) === evidence.pluginName
    && entry.pluginId !== evidence.pluginId);
  if (nameCollisions.length > 0) return foreign('pluginNameCollision');
  const listMatches = evidence.pluginListEntries.filter((entry) =>
    entry.pluginId === evidence.pluginId);
  if (listMatches.length > 1) return corrupt('pluginListDuplicate');
  const listEntry = listMatches[0];

  if (evidence.manifest.state === 'unreadable') return corrupt('manifestUnreadable');
  if (evidence.manifest.state === 'absent') {
    return listEntry || evidence.managedByCurrentIntent
      ? corrupt('manifestMissing')
      : { state: 'absent', nativeAction: 'install' };
  }
  if (!listEntry) return corrupt('pluginListUnavailable');
  if (!evidence.marketplaceRegistration) return corrupt('marketplaceRegistrationForeign');
  if (!evidence.manifest.pathSafe) return foreign('payloadPathUnsafe');
  if (
    evidence.manifest.identity !== evidence.pluginId
    && evidence.manifest.identity !== evidence.pluginName
  ) {
    return foreign('manifestIdentityMismatch');
  }
  if (!tryParseStrictSemVer(evidence.manifest.version)) {
    return corrupt('manifestVersionInvalid');
  }
  if (listEntry.version !== undefined && listEntry.version !== evidence.manifest.version) {
    return corrupt('pluginListVersionMismatch');
  }
  if (evidence.manifest.version !== evidence.desiredVersion) {
    return {
      state: 'outdated',
      version: evidence.manifest.version,
      desiredVersion: evidence.desiredVersion,
      nativeAction: 'replace',
    };
  }
  if (evidence.manifest.payloadDigest !== evidence.expectedPayloadDigest) {
    return corrupt('payloadDigestMismatch');
  }
  return evidence.managedByCurrentIntent
    ? { state: 'present', version: evidence.manifest.version, nativeAction: 'none' }
    : { state: 'claimable', version: evidence.manifest.version, nativeAction: 'none' };
}

export const classifyCodexSharedNativeEvidence = inspectCodexSharedNative;
