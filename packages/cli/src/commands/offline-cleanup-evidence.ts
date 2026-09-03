import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';

import type { PlatformName, Scope } from '../types.js';
import type { CatalogSourceReferenceInventory } from '../utils/catalog-source-references.js';
import type { OwnedComponent, OwnerIdentity } from '../utils/ownership.js';

export interface OfflineCleanupTargetEvidence {
  reason: 'sourceMissing' | 'bundleUnavailable';
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  plan: OfflineCleanupPlan;
  planDigest: string;
  targetFingerprint: string;
  forceExclusive?: true;
}

export interface OfflineCleanupPlanAction {
  action: 'removeOwnedOutput' | 'removeNativeRegistration';
  kind: 'namespacedOwner' | 'namespacedMarketplace' | 'skill-directory' | 'owned-text-file';
  target: string;
  allowedRoot?: string;
  owner?: OwnerIdentity;
  pathEvidence?: string;
  marketplaceName?: string;
  activationScope?: Scope;
  projectKey?: string | null;
  pluginVersion?: string;
}

async function pathEvidence(component: Extract<OwnedComponent, { path: string }>): Promise<string> {
  const target = await fs.lstat(component.path).then((stats) => ({
    type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : stats.isSymbolicLink() ? 'symlink' : 'other',
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  })).catch((error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
    ? { type: 'absent' }
    : { type: 'error', code: (error as NodeJS.ErrnoException).code ?? 'unknown' });
  const ownershipPath = component.kind === 'skill-directory'
    ? path.join(component.path, '.agent-workflows-owner.json')
    : component.path;
  const ownership = await fs.readFile(ownershipPath).then((content) =>
    `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`)
    .catch((error: unknown) => `unreadable:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({ target, ownership })).digest('hex')}`;
}

export async function forceOfflineCleanupEvidence(options: {
  reason: OfflineCleanupTargetEvidence['reason'];
  pluginId: string;
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  components: ReadonlyArray<Extract<OwnedComponent, { path: string }>>;
}): Promise<OfflineCleanupTargetEvidence> {
  const actions = await Promise.all(options.components.map(async (component): Promise<OfflineCleanupPlanAction> => ({
    action: 'removeOwnedOutput',
    kind: component.kind,
    target: component.path,
    allowedRoot: component.allowedRoot,
    owner: component.identity,
    pathEvidence: await pathEvidence(component),
  })));
  actions.sort((left, right) => left.target.localeCompare(right.target));
  const plan: OfflineCleanupPlan = {
    schemaVersion: 1,
    pluginId: options.pluginId,
    sourceIdentity: options.sourceIdentity,
    platform: options.platform,
    scope: options.scope,
    actions,
  };
  const planDigest = calculateOfflineCleanupPlanDigest(plan);
  return {
    reason: options.reason,
    pluginId: options.pluginId,
    pluginName: options.pluginName,
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    platform: options.platform,
    scope: options.scope,
    plan,
    planDigest,
    targetFingerprint: planDigest,
    forceExclusive: true,
  };
}

export interface OfflineCleanupPlan {
  schemaVersion: 1;
  pluginId: string;
  sourceIdentity: string;
  platform: PlatformName;
  scope: Scope;
  actions: OfflineCleanupPlanAction[];
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function calculateOfflineCleanupPlanDigest(plan: OfflineCleanupPlan): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex')}`;
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
      || reference.kind === 'namespacedMarketplace')
    && reference.pluginName === options.pluginName
    && reference.sourceId === options.sourceId
    && (reference.kind === 'namespacedOwner'
      || reference.sourceIdentity === options.sourceIdentity)
    && reference.platform === options.platform
    && reference.scope === options.scope);
  if (references.length === 0) return null;
  const marketplaceRoots = options.inventory.references.flatMap((reference) =>
    reference.kind === 'namespacedMarketplace'
    && reference.sourceId === options.sourceId
    && reference.sourceIdentity === options.sourceIdentity
    && reference.pluginName === undefined
    && path.basename(reference.location) === 'config.json'
      ? [path.dirname(reference.location)]
      : []);
  const ownedReferences = references.filter((reference) =>
    reference.kind !== 'namespacedOwner'
    || !marketplaceRoots.some((root) => isPathInside(
      reference.location,
      path.join(root, 'plugins', options.pluginName),
    )));
  const actions = ownedReferences.flatMap((reference): OfflineCleanupPlanAction[] => {
    if (options.platform === 'codex' && reference.kind === 'namespacedMarketplace') return [];
    return [{
      action: reference.kind === 'namespacedOwner'
        ? 'removeOwnedOutput'
        : 'removeNativeRegistration',
      kind: reference.kind as OfflineCleanupPlanAction['kind'],
      target: reference.location,
      ...(reference.marketplaceName ? { marketplaceName: reference.marketplaceName } : {}),
      ...(reference.projectKey !== undefined ? { projectKey: reference.projectKey } : {}),
      ...(reference.pluginVersion ? { pluginVersion: reference.pluginVersion } : {}),
    }];
  });
  if (options.platform === 'codex') {
    const registeredNames = new Set(options.inventory.references.flatMap((reference) =>
      reference.kind === 'namespacedMarketplace'
      && reference.sourceId === options.sourceId
      && reference.sourceIdentity === options.sourceIdentity
      && reference.pluginName === undefined
      && reference.marketplaceName
        ? [reference.marketplaceName]
        : []));
    const nativeNames = new Set(options.inventory.references.flatMap((reference) =>
      reference.kind === 'namespacedMarketplace'
      && reference.pluginName === options.pluginName
      && reference.platform === 'codex'
      && reference.marketplaceName
      && ((reference.sourceId === options.sourceId
          && reference.sourceIdentity === options.sourceIdentity)
        || (reference.sourceId === undefined && registeredNames.has(reference.marketplaceName)))
        ? [reference.marketplaceName]
        : []));
    if (nativeNames.size === 1) {
      const marketplaceName = [...nativeNames][0]!;
      actions.push({
        action: 'removeNativeRegistration',
        kind: 'namespacedMarketplace',
        target: `${options.pluginName}@${marketplaceName}`,
        marketplaceName,
        activationScope: options.scope,
      });
    }
  }
  actions.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), 'en'));
  const plan: OfflineCleanupPlan = {
    schemaVersion: 1,
    pluginId: options.pluginId,
    sourceIdentity: options.sourceIdentity,
    platform: options.platform,
    scope: options.scope,
    actions,
  };
  const planDigest = calculateOfflineCleanupPlanDigest(plan);
  return {
    reason: options.reason,
    pluginId: options.pluginId,
    pluginName: options.pluginName,
    sourceId: options.sourceId,
    sourceIdentity: options.sourceIdentity,
    platform: options.platform,
    scope: options.scope,
    plan,
    planDigest,
    targetFingerprint: planDigest,
  };
}

export function offlineCleanupEvidenceMatches(
  expected: OfflineCleanupTargetEvidence,
  actual: OfflineCleanupTargetEvidence,
): boolean {
  return expected.reason === actual.reason
    && expected.forceExclusive === actual.forceExclusive
    && expected.pluginId === actual.pluginId
    && expected.pluginName === actual.pluginName
    && expected.sourceId === actual.sourceId
    && expected.sourceIdentity === actual.sourceIdentity
    && expected.platform === actual.platform
    && expected.scope === actual.scope
    && expected.planDigest === calculateOfflineCleanupPlanDigest(expected.plan)
    && actual.planDigest === calculateOfflineCleanupPlanDigest(actual.plan)
    && expected.planDigest === actual.planDigest
    && JSON.stringify(expected.plan) === JSON.stringify(actual.plan)
    && expected.targetFingerprint === expected.planDigest
    && actual.targetFingerprint === actual.planDigest;
}
