import crypto from 'node:crypto';

import type { PlatformName, Scope } from '../types.js';
import type { CatalogSourceReferenceInventory } from '../utils/catalog-source-references.js';

export interface OfflineCleanupTargetEvidence {
  reason: 'sourceMissing' | 'bundleUnavailable';
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  targetFingerprint: string;
}

export function offlineCleanupEvidenceFromInventory(options: {
  reason: OfflineCleanupTargetEvidence['reason'];
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  inventory: CatalogSourceReferenceInventory;
}): OfflineCleanupTargetEvidence | null {
  const references = options.inventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner'
      || reference.kind === 'namespacedMarketplace'
      || reference.kind === 'namespacedLifecycle')
    && reference.pluginName === options.pluginName
    && reference.sourceId === options.sourceId
    && reference.sourceIdentity === options.sourceIdentity
    && reference.platform === options.platform
    && reference.scope === options.scope);
  if (references.length === 0) return null;
  const targetFingerprint = `sha256:${crypto.createHash('sha256').update(JSON.stringify(
    references.map((reference) => ({
      kind: reference.kind,
      location: reference.location,
      marketplaceName: reference.marketplaceName ?? null,
      projectKey: reference.projectKey ?? null,
      lifecycleMetadataIntegrityDigest:
        reference.lifecycleMetadataIntegrityDigest ?? null,
      pluginVersion: reference.pluginVersion ?? null,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en')),
  )).digest('hex')}`;
  return {
    reason: options.reason,
    pluginId: options.pluginId,
    pluginName: options.pluginName,
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    platform: options.platform,
    scope: options.scope,
    targetFingerprint,
  };
}

export function offlineCleanupEvidenceMatches(
  expected: OfflineCleanupTargetEvidence,
  actual: OfflineCleanupTargetEvidence,
): boolean {
  return expected.reason === actual.reason
    && expected.pluginId === actual.pluginId
    && expected.pluginName === actual.pluginName
    && expected.sourceId === actual.sourceId
    && expected.sourceIdentity === actual.sourceIdentity
    && expected.platform === actual.platform
    && expected.scope === actual.scope
    && expected.targetFingerprint === actual.targetFingerprint;
}
