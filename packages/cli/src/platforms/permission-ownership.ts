import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSharedOwnerToken, parseSharedOwnerToken, type OwnedComponent, type OwnedSharedLocator } from '../utils/ownership.js';
import { getDeploymentResourceKey, getInvocationPolicyPhysicalKey, scopedPermissionPath, getOpenCodePermissionRoot } from './layout.js';
import { identityDigest } from './identity.js';
import { parseOpenCodePermissionDocument, readOpenCodePermissionChain, mergeOpenCodePermissions,
  isOpenCodePermission, openCodePermissionConfigured, openCodePermissionResourceKey, openCodePrefixesOverlap, type OpenCodeLayerRule } from './opencode-permissions.js';
import { commitPermissionOwnership, manualPermissionEntries, permissionConflict, permissionFailureNotice, permissionFileFingerprint, type PermissionWriteReceipt,
  readPermissionHost, readPermissionSidecar } from './permission-sidecar.js';
import { openCodeRestrictions, prepareRelatedOpenCodeProjects, readOpenCodeUserRestrictions, relatedOpenCodeProjectChanges,
  type RelatedOpenCodeProject, type RelatedOpenCodeProjectBatch, type RelatedOpenCodeProjectWrites } from './opencode-related-permissions.js';
import type { DeploymentBinding, Diagnostic, ReadContext } from './contracts.js';
import { canonicalizePathThroughExistingAncestorSync } from '../utils/state-paths.js';
import { attachSafeOperationError } from '../utils/safe-operation-diagnostic.js';
import { assertGrokPermissionPath, grokProjectPermissionsAuthorized, parseGrokPermissionDocument, readGrokPermissionLayers } from './grok-permission-config.js';
import { grokPermissionResource, grokPrefixesOverlap, isGrokPermission, mergeGrokPermissions } from './grok-permissions.js';
import { assertAntigravityGlobalPermissionPath, antigravityPermissionResources, antigravityPrefixesOverlap, isAntigravityPermission,
  parseAntigravityPermissionDocument, mergeAntigravityPermissions, supportsAntigravityGlobalPermissions } from './antigravity-permissions.js';
import { adjustedPermissionOwners, hostPermissionImpactDiagnostics, isPermissionHost, isHostPermissionMutation,
  type PermissionHost, type HostPermissionRule } from './host-permission-policy.js';
import { resolvePlatformConfigRoot, TARGET_DISPLAY_NAMES } from './discovery.js';
import type { HostPermissionAdjustment, PermissionClaim, PermissionDocument } from './permission-sidecar.js';
import { GROK_ADDITIONAL_RULES_UNVERIFIED, HOST_PERMISSION_ADDITIONAL_IMPACT } from '../output/component-delivery.js';

export type PermissionLocator = Extract<OwnedSharedLocator, { kind: 'host-permissions' }>;

export function permissionComponent(binding: DeploymentBinding, settingsPath: string, physicalKey: string):
  Extract<OwnedComponent, { locator: OwnedSharedLocator }> & { locator: PermissionLocator } {
  const entry = binding.consumers[0]?.entry;
  if (!isPermissionHost(binding.platform) || !entry || entry.kind === 'generic') throw new Error('platformInvocationPolicyUnsupported');
  const identity = { owner: 'agent-workflows' as const, sourceId: binding.plugin.sourceId, pluginId: binding.plugin.pluginId,
    sourceIdentity: binding.plugin.sourceIdentity, plugin: binding.plugin.pluginId.split('/').at(-1)!, scope: binding.scope.kind, platform: binding.platform,
    physicalKey, artifactKey: `${binding.platform}-permissions-${getDeploymentResourceKey(binding.plugin)}` };
  return { kind: 'shared-config', identity, label: settingsPath, locator: { kind: 'host-permissions', settingsPath, platform: binding.platform,
    ownerKey: createSharedOwnerToken(identity), hostConfigRoot: canonicalizePathThroughExistingAncestorSync(entry.configRoot),
    ...(binding.scope.kind === 'project' ? { projectRoot: canonicalizePathThroughExistingAncestorSync(binding.scope.projectRoot) } : {}) } };
}

export type PermissionBatchOwners = Record<string, PermissionClaim[]>;
export interface ReviewedPermissionBatch {
  owners: PermissionBatchOwners;
  reviewDigest: string;
  effective: HostPermissionRule[];
  restorations?: Diagnostic[];
  additionalImpacts?: Diagnostic[];
  relatedProjects?: RelatedOpenCodeProject[];
}

const relatedProjectRecovery = 'An OpenCode Project permission update is incomplete. Review its rules in that project before syncing again.';

class RelatedProjectPermissionError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(readonly projects: string[], readonly mutation: 'confirmed' | 'possible' | 'none', interrupted: boolean, cause: unknown,
    readonly primaryFailure?: { path: string; code: string }) {
    super(relatedProjectRecovery, { cause });
    this.code = interrupted ? 'operationInterrupted' : 'permissionRelatedProjectUpdateIncomplete';
    this.path = projects[0]!;
    attachSafeOperationError(this, { code: this.code, safeMessage: this.message });
  }
}

export function relatedProjectPermissionNotices(error: unknown, subject: Diagnostic['subject']): Diagnostic[] {
  if (!(error instanceof RelatedProjectPermissionError)) return [];
  const primary = error.primaryFailure && permissionFailureNotice(error.primaryFailure.code, error.primaryFailure.path, subject);
  return [...(primary ? [primary] : []), ...error.projects.map((path) => incompleteProjectNotice(path, subject, error.code))];
}

function incompleteProjectNotice(path: string, subject: Diagnostic['subject'], reasonCode: string): Diagnostic {
  return { code: 'permissionRelatedProjectUpdateIncomplete', severity: 'error', subject: { ...subject, scope: 'project' },
    detail: { reasonCode, path }, message: relatedProjectRecovery };
}

export function pendingRelatedProjectNotices(batch: RelatedOpenCodeProjectBatch, interrupted: boolean): Diagnostic[] {
  return [...batch.pending].map(([path, { subject }]) => incompleteProjectNotice(path, subject,
    interrupted ? 'operationInterrupted' : 'permissionRelatedProjectUpdateIncomplete'));
}

function replaceOwners(previous: PermissionBatchOwners, changes: PermissionBatchOwners) {
  const owners = { ...previous };
  for (const [key, claims] of Object.entries(changes)) {
    if (claims.length) owners[key] = claims;
    else delete owners[key];
  }
  return owners;
}

function claimsInOwnerOrder(owners: PermissionBatchOwners): PermissionClaim[] {
  return Object.keys(owners).sort().flatMap((key) => owners[key]!);
}

type Merged = ReturnType<typeof mergeOpenCodePermissions> & { adjusted?: HostPermissionAdjustment[] };
function ownerDecision(claims: PermissionClaim[], merged: Merged, matchesResource: (configured: string, claim: PermissionClaim) => boolean) {
  const effective = merged.effective.filter((rule) => claims.some((claim) => claim.effect === rule.effect && matchesResource(rule.resource, claim)));
  const skipped = claims.flatMap((claim) => {
    const reason = merged.skipped.find((item) => item.name === claim.name && item.effect === claim.effect
      && identityDigest(item.tokens) === identityDigest(claim.tokens));
    if (reason) return [reason];
    const superseded = merged.effective.some((rule) => matchesResource(rule.resource, claim) && rule.effect !== claim.effect);
    return superseded ? [{ ...claim, reasonCode: 'permission-rule-conflict' }] : [];
  });
  return { effective, skipped };
}

function preparePermissionDocument(ctx: ReadContext, locator: PermissionLocator, host: string | null) {
  try {
    if (locator.platform === 'grok') {
      const document = parseGrokPermissionDocument(host ?? '');
      return { document: document as PermissionDocument, resources: (claim: PermissionClaim) => [grokPermissionResource(claim)], isRule: isGrokPermission, agentRules: [],
        chain: () => readGrokPermissionLayers(ctx, locator.settingsPath, locator.hostConfigRoot, locator.projectRoot, document),
        merge: (entries: PermissionClaim[], manual: unknown[], layers: OpenCodeLayerRule[]) =>
          mergeGrokPermissions(entries, manual, layers, ctx.platform) };
    }
    if (locator.platform === 'antigravity') {
      const document = parseAntigravityPermissionDocument(host ?? '{}');
      return { document: document as PermissionDocument,
        resources: (claim: PermissionClaim) => antigravityPermissionResources(claim, ctx.platform, { includeLegacyRaw: true }),
        isRule: isAntigravityPermission, agentRules: [],
        chain: async (): Promise<OpenCodeLayerRule[]> => { await assertAntigravityGlobalPermissionPath(ctx, locator.settingsPath); return []; },
        merge: (entries: PermissionClaim[], manual: unknown[], _layers: OpenCodeLayerRule[]) =>
          mergeAntigravityPermissions(entries, manual, ctx.platform, document.strict) };
    }
    const document = parseOpenCodePermissionDocument(host ?? '{}');
    return { document: document as PermissionDocument, resources: (claim: PermissionClaim) => [claim.tokens.join(' ') + ' *'], isRule: isOpenCodePermission, agentRules: document.agentRules,
      chain: () => readOpenCodePermissionChain(ctx, locator.settingsPath, locator.hostConfigRoot, locator.projectRoot, document),
      merge: (entries: PermissionClaim[], manual: unknown[], layers: OpenCodeLayerRule[], restrictions: PermissionClaim[]) =>
        mergeOpenCodePermissions(entries, manual, layers, ctx.platform, restrictions) };
  } catch { throw permissionConflict(); }
}

async function assertScopedPermissionPath(ctx: ReadContext, locator: PermissionLocator) {
  if (locator.platform === 'antigravity') await assertAntigravityGlobalPermissionPath(ctx, locator.settingsPath);
  if (locator.platform === 'grok') await assertGrokPermissionPath(ctx, locator.settingsPath, locator.hostConfigRoot, locator.projectRoot);
}

/** Check only this owner's declarations and the rules actually delivered at the last write. */
export async function inspectHostPermissionDelivery(ctx: ReadContext, binding: DeploymentBinding, claims: PermissionClaim[],
  grokAuthorization?: 'granted' | 'denied' | 'unknown'): Promise<{
    content: 'unknown' | 'drifted'; diagnostic: Diagnostic;
  } | undefined> {
  const { platform, scope } = binding;
  if (!isPermissionHost(platform) || platform === 'antigravity' && !supportsAntigravityGlobalPermissions(binding)) return;
  let destination: string | undefined;
  const finding = (content: 'unknown' | 'drifted', code: string, message: string, reasonCode = code) => ({ content,
    diagnostic: { code, severity: 'warning' as const, message, subject: { pluginId: binding.plugin.pluginId, target: platform, scope: scope.kind },
      detail: { reasonCode, ...(destination ? { path: destination } : {}) } } });
  try {
    const entry = binding.consumers[0]?.entry;
    const hostRoot = entry && entry.kind !== 'generic' ? entry.configRoot : undefined;
    destination = await scopedPermissionPath(ctx, platform, scope, hostRoot);
    if (!destination) return finding('unknown', 'componentOutputUnconfirmed', 'The host permission configuration path could not be verified.');
    const { locator } = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(ctx, binding));
    // Never open project configuration when the native client or saved trust disallows inspection.
    if (platform === 'grok' && scope.kind === 'project' && (grokAuthorization === 'denied' || grokAuthorization === 'unknown'
      || !await grokProjectPermissionsAuthorized(ctx, locator.hostConfigRoot, scope.projectRoot))) {
      const record = await readPermissionSidecar(ctx.env, platform, destination);
      if (!record.unreadable && (record.state ? !record.state.owners[locator.ownerKey] : record.raw === null)) return;
      return finding('unknown', 'componentOutputUnconfirmed', 'Grok project authorization is required to verify these permissions.', 'grok-project-trust-required');
    }
    await assertScopedPermissionPath(ctx, locator);
    const snapshot = await readPermissionSidecar(ctx.env, platform, destination);
    const host = await readPermissionHost(snapshot.target);
    const { document, resources, isRule } = preparePermissionDocument(ctx, locator, host);
    const priorClaims = snapshot.state?.owners[locator.ownerKey];
    if (!priorClaims && (snapshot.unreadable || snapshot.raw !== null && !snapshot.state || !snapshot.state && document.permissions.length)) {
      return finding('unknown', 'permissionOwnershipDegraded', 'Host permission ownership could not be verified. Review the host configuration and sync again.');
    }
    if (identityDigest(claims) !== identityDigest(priorClaims ?? [])) {
      return finding('drifted', 'platformContentDrift', 'The recorded host permission declarations differ from this plugin. Sync to apply them.');
    }
    if (!snapshot.state || !priorClaims) return;
    const key = (resource: string) => platform === 'opencode' ? openCodePermissionResourceKey(resource, ctx.platform) : resource;
    const expected = [...snapshot.state.before, ...snapshot.state.after, ...snapshot.state.manualPermissions].filter(isRule)
      .filter((rule) => priorClaims.some((claim) => claim.effect === rule.effect && resources(claim).some((resource) => key(resource) === key(rule.resource))));
    const present = new Set(document.permissions.map(identityDigest));
    if (expected.some((rule) => platform === 'opencode' ? !openCodePermissionConfigured(rule, document.permissions, ctx.platform)
      : !present.has(identityDigest(rule)))) {
      return finding('drifted', 'componentOutputMissing', 'A previously delivered host permission rule is missing or has been overridden. Sync to restore the rule.');
    }
  } catch {
    ctx.signal?.throwIfAborted();
    return finding('unknown', 'componentOutputUnconfirmed', 'The host permission configuration could not be verified.');
  }
}

async function readReconciliation(ctx: ReadContext, locator: PermissionLocator, claims: PermissionClaim[] | undefined,
  batch?: PermissionBatchOwners, reviewedProjects?: RelatedOpenCodeProject[], projectWrites?: RelatedOpenCodeProjectWrites) {
  await assertScopedPermissionPath(ctx, locator);
  const snapshot = await readPermissionSidecar(ctx.env, locator.platform, locator.settingsPath);
  const host = await readPermissionHost(snapshot.target);
  const previous = snapshot.state?.owners ?? {};
  const owners = replaceOwners(previous, { [locator.ownerKey]: claims ?? [] });
  const candidates = batch ? replaceOwners(owners, batch) : owners;
  const dialect = preparePermissionDocument(ctx, locator, host);
  const { document, resources } = dialect;
  const resourceKey = (configured: string) => locator.platform === 'opencode' ? openCodePermissionResourceKey(configured, ctx.platform) : configured;
  const matchesResource = (configured: string, claim: PermissionClaim) =>
    resources(claim).some((resource) => resourceKey(resource) === resourceKey(configured));
  const equivalentResources = (a: PermissionClaim, b: PermissionClaim) =>
    identityDigest(resources(a).map(resourceKey).sort()) === identityDigest(resources(b).map(resourceKey).sort());
  const chain = async () => {
    try {
      const otherRules = await dialect.chain();
      const restrictions = locator.platform === 'opencode' && locator.projectRoot
        ? await readOpenCodeUserRestrictions(ctx, locator.hostConfigRoot, snapshot.target) : [];
      return { otherRules, restrictions };
    } catch { throw permissionConflict(); }
  };
  const layerState = await chain();
  const { entries: manual, retainedAfterDrift } = manualPermissionEntries(snapshot, host, document.permissions, document.permissionGroup);
  const merge = (entries: PermissionClaim[]): Merged => dialect.merge(entries, manual, layerState.otherRules, layerState.restrictions);
  const finalClaims = claimsInOwnerOrder(candidates);
  const final = merge(finalClaims);
  const prior = merge(claimsInOwnerOrder(previous));
  const futureRestrictions = openCodeRestrictions(candidates);
  const selectedOwners = new Set([locator.ownerKey, ...Object.keys(batch ?? {})]);
  const affectedRestrictions = [previous, candidates].flatMap((state) =>
    openCodeRestrictions(Object.fromEntries(Object.entries(state).filter(([owner]) => selectedOwners.has(owner)))));
  const openCodeUser = locator.platform === 'opencode' && !locator.projectRoot;
  const { writes: projectPlans, conflicts: projectConflicts } = openCodeUser
    ? await prepareRelatedOpenCodeProjects(ctx, { path: snapshot.target, permissions: [...final.before, ...manual, ...final.after], agentRules: dialect.agentRules },
      futureRestrictions, affectedRestrictions, reviewedProjects, projectWrites) : { writes: [], conflicts: [] };
  const relatedProjects = projectPlans.map((plan) => plan.review);
  const installed = new Set(document.permissions.map(identityDigest));
  const oldRules = [...snapshot.state?.before ?? [], ...snapshot.state?.after ?? [], ...snapshot.state?.manualPermissions ?? []]
    .filter(dialect.isRule).filter((rule) => installed.has(identityDigest(rule)));
  // Keep exact owner tokens for writes. Review identifies a plugin by its public
  // selector, which can cover several source generations sharing the same file.
  const claimsByPlugin = new Map<string, PermissionClaim[]>();
  const affectedPlugins = new Set<string>();
  const currentPlugin = parseSharedOwnerToken(locator.ownerKey)!.pluginId!;
  const restored = new Map<string, HostPermissionRule[]>();
  const skipped: Array<PermissionClaim & { reasonCode: string; pluginId: string; path?: string }> = [];
  for (const [key, declarations] of Object.entries(candidates).sort(([a], [b]) => a.localeCompare(b))) {
    const pluginId = parseSharedOwnerToken(key)!.pluginId!;
    claimsByPlugin.set(pluginId, [...claimsByPlugin.get(pluginId) ?? [], ...declarations]);
    const decision = ownerDecision(declarations, final, matchesResource);
    const oldClaims = previous[key] ?? [];
    const before = ownerDecision(oldClaims, prior, matchesResource);
    // A live user restriction may have changed since the previous sync. The
    // old AW rule still in the host is an observable withdrawal for its owner.
    const withdrawn = oldClaims.filter((claim) => oldRules.some((rule) => rule.effect === claim.effect && matchesResource(rule.resource, claim))
      && !decision.effective.some((rule) => rule.effect === claim.effect && matchesResource(rule.resource, claim)));
    if (key !== locator.ownerKey && (withdrawn.length || identityDigest(before.effective) !== identityDigest(decision.effective))) {
      affectedPlugins.add(pluginId);
    }
    if (!claims?.length) {
      const regained = decision.effective.filter((rule) => !prior.effective.some((old) => identityDigest(old) === identityDigest(rule))
        && oldClaims.some((claim) => claim.effect === rule.effect && matchesResource(rule.resource, claim)));
      if (regained.length) restored.set(pluginId, [...restored.get(pluginId) ?? [], ...regained]);
    }
    for (const item of decision.skipped) {
      if (key === locator.ownerKey || withdrawn.some((claim) => claim.name === item.name && claim.effect === item.effect && equivalentResources(claim, item))
        || !before.skipped.some((old) => identityDigest(old) === identityDigest(item))) {
        skipped.push({ ...item, pluginId });
      }
    }
    for (const item of projectConflicts) {
      if (declarations.some((claim) => identityDigest(claim) === identityDigest(item.claim))) {
        skipped.push({ ...item.claim, reasonCode: 'permission-rule-conflict', pluginId, path: item.path });
      }
    }
  }

  const effective = ownerDecision(claimsByPlugin.get(currentPlugin) ?? [], final, matchesResource).effective;
  affectedPlugins.delete(currentPlugin);
  const affected = [...affectedPlugins].map((pluginId) => ({ pluginId, permissions: ownerDecision(claimsByPlugin.get(pluginId) ?? [], final, matchesResource).effective }));
  const restorationNotices = (written: Merged): Diagnostic[] => [...restored].flatMap(([pluginId, rules]) => {
    const active = written.effective.filter((rule) => rules.some((candidate) => identityDigest(candidate) === identityDigest(rule)));
    return active.length ? [{ code: 'hostPermissionRestored', severity: 'info' as const,
      subject: { pluginId, target: locator.platform, scope: locator.projectRoot ? 'project' as const : 'user' as const },
      detail: { reasonCode: 'hostPermissionRestored', path: locator.settingsPath },
      message: `Restored ${TARGET_DISPLAY_NAMES[locator.platform]} permissions: ` + active.map((rule) => `${rule.effect} ${rule.action} ${rule.resource}`).join(', ') }] : [];
  });
  let merged = final;
  if (batch) {
    // A target can fail its package/preApply gate. Persist only owners that
    // actually reached this write. Withhold overlapping grants until every
    // stricter reviewed prefix that protects them has reached its own write.
    const committed = claimsInOwnerOrder(owners);
    const pending = Object.values(batch).flat().filter((claim) => claim.effect !== 'allow'
      && !committed.some((active) => active.effect === claim.effect && equivalentResources(active, claim)));
    merged = merge(committed.filter((claim) => claim.effect === 'deny'
      || (finalClaims.some((declaration) => declaration.effect === claim.effect && equivalentResources(declaration, claim))
        || oldRules.some((rule) => rule.effect === claim.effect && matchesResource(rule.resource, claim))) && !pending.some((restriction) => (claim.effect === 'allow' || restriction.effect === 'deny')
        && (locator.platform === 'opencode' ? openCodePrefixesOverlap(claim.tokens, restriction.tokens, ctx.platform)
          : locator.platform === 'grok' ? grokPrefixesOverlap(claim.tokens, restriction.tokens)
            : antigravityPrefixesOverlap(claim.tokens, restriction.tokens, ctx.platform)))));
  }
  const sameRule = (a: HostPermissionRule, b: HostPermissionAdjustment) => a.effect === b.effect && a.resource === b.resource;
  const managedRules = (merge: Merged) => {
    const generated = new Set([...merge.before, ...merge.after].map(identityDigest));
    return merge.effective.filter((rule) => generated.has(identityDigest(rule)));
  };
  const adjusted = adjustedPermissionOwners(candidates, final.adjusted, managedRules(final), matchesResource,
    (owner, rule) => owner === locator.ownerKey || Boolean(batch && Object.hasOwn(batch, owner)) || !oldRules.some((old) => sameRule(old, rule)));
  const reviewedAdjustmentKeys = new Set(adjusted.map(identityDigest));
  const writtenAdjustments = adjustedPermissionOwners(owners, merged.adjusted, managedRules(merged), matchesResource, () => true)
    .filter((rule) => reviewedAdjustmentKeys.has(identityDigest(rule)) && !document.permissions.some((old) => dialect.isRule(old) && sameRule(old, rule)));
  const scope = locator.projectRoot ? 'project' : 'user';
  const layerNotices: Diagnostic[] = [];
  if (locator.platform === 'grok' && (claims?.length || previous[locator.ownerKey]?.length)) {
    for (const path of new Set(layerState.otherRules.filter(({ rule }) => rule === null).map(({ path }) => path))) {
      layerNotices.push({ code: HOST_PERMISSION_ADDITIONAL_IMPACT, severity: 'warning',
        subject: { pluginId: currentPlugin, target: locator.platform, scope },
        detail: { reasonCode: GROK_ADDITIONAL_RULES_UNVERIFIED, path },
        message: 'An additional Grok configuration could not be read. Its rules may affect the permission decision.' });
    }
  }
  const additionalImpacts = [...hostPermissionImpactDiagnostics(adjusted, locator.platform, scope, locator.settingsPath), ...layerNotices,
    ...relatedProjects.flatMap((project) => project.additionalImpacts ?? [])];
  const reviewDigest = identityDigest({ manual, layerState, candidates, relatedProjects, projectConflicts,
    ...(final.adjusted?.length ? { adjusted: final.adjusted } : {}) });
  const preview = { skipped, adjusted, effective, affected, additionalImpacts, layerNotices, restorations: restorationNotices(final), reviewDigest, relatedProjects,
    ownershipDegraded: retainedAfterDrift || !snapshot.state && (snapshot.unreadable || snapshot.raw !== null || document.permissions.length > 0) };
  const allOwnersCommitted = identityDigest(owners) === identityDigest(candidates);
  const liveProjectPlans = async (pending: RelatedOpenCodeProject[] = []) => {
    if (!openCodeUser || allOwnersCommitted && !projectWrites?.size && !pending.length) return projectPlans;
    if (!allOwnersCommitted && !projectWrites) return [];
    const activeRestrictions = openCodeRestrictions(owners);
    const affected = allOwnersCommitted ? affectedRestrictions
      : [previous, owners].flatMap((state) => openCodeRestrictions({ [locator.ownerKey]: state[locator.ownerKey] ?? [] }));
    return (await prepareRelatedOpenCodeProjects(ctx, { path: snapshot.target,
      permissions: [...merged.before, ...manual, ...merged.after], agentRules: dialect.agentRules },
    activeRestrictions, affected, allOwnersCommitted ? [...reviewedProjects ?? [], ...pending] : undefined)).writes;
  };
  return { snapshot, host, document, manual, owners, merged, preview, appliedNotices: [
    ...restorationNotices(merged), ...hostPermissionImpactDiagnostics(writtenAdjustments, locator.platform, scope, locator.settingsPath), ...layerNotices,
  ],
    allOwnersCommitted, liveProjectPlans, verifyChain: async () => {
    if (identityDigest(await chain()) !== identityDigest(layerState)) throw permissionConflict();
  } };
}
export async function previewPermissionBatch(ctx: ReadContext, locator: PermissionLocator, claims: PermissionClaim[], owners: PermissionBatchOwners) {
  return (await readReconciliation(ctx, locator, claims, owners)).preview;
}
export interface PermissionRemovalReview {
  fingerprint: string;
  batch?: ReviewedPermissionBatch;
}

/** Prepare offline cleanup without discovering a client or staging a package. */
export async function reviewPermissionRemovals(ctx: ReadContext, locators: PermissionLocator[]) {
  const files = new Map<string, PermissionBatchOwners>();
  const reviews = new Map<string, PermissionRemovalReview>();
  for (const locator of locators) {
    const owners = files.get(locator.settingsPath) ?? {};
    owners[locator.ownerKey] = [];
    files.set(locator.settingsPath, owners);
  }
  for (const locator of locators) {
    const owners = files.get(locator.settingsPath)!;
    try {
      const planned = await readReconciliation(ctx, locator, [], owners);
      const { effective, restorations, additionalImpacts, reviewDigest, relatedProjects } = planned.preview;
      reviews.set(locator.ownerKey, { fingerprint: permissionFileFingerprint(planned.host, planned.snapshot.raw),
        batch: { owners, effective, restorations, reviewDigest, ...(additionalImpacts.length ? { additionalImpacts } : {}),
          ...(relatedProjects.length ? { relatedProjects } : {}) } });
    } catch {
      // Isolate unreadable permissions so unrelated proven output can still be cleaned.
      reviews.set(locator.ownerKey, { fingerprint: 'unreadable' });
    }
  }
  return reviews;
}
export async function previewHostPermissions(ctx: ReadContext, binding: DeploymentBinding, destination: string, permissions: PermissionClaim[]) {
  const { locator } = permissionComponent(binding, destination, await getInvocationPolicyPhysicalKey(ctx, binding));
  return (await readReconciliation(ctx, locator, permissions)).preview;
}
export const previewOpenCodePermissions = previewHostPermissions;

export async function hasPermissionOwner(env: NodeJS.ProcessEnv | undefined, locator: PermissionLocator): Promise<boolean> {
  return !!(await readPermissionSidecar(env, locator.platform, locator.settingsPath)).state?.owners[locator.ownerKey];
}
export async function permissionOwnerContentDigest(ctx: ReadContext, locator: PermissionLocator): Promise<string | undefined> {
  const claims = (await readPermissionSidecar(ctx.env, locator.platform, locator.settingsPath)).state?.owners[locator.ownerKey];
  if (!claims) return;
  const { document, manual, merged, snapshot, host, preview } = await readReconciliation(ctx, locator, claims);
  const hostDigest = host === null ? null : createHash('sha256').update(host).digest('hex');
  if (preview.relatedProjects.length || hostDigest !== snapshot.state?.hostDigest
    || document.writePermissions([...merged.before, ...manual, ...merged.after]) !== (host ?? (locator.platform === 'grok' ? '' : '{}'))) return;
  const mutation = { kind: `${locator.platform}-permissions`, permissions: claims, effective: preview.effective, reviewDigest: preview.reviewDigest };
  return 'sha256:' + createHash('sha256').update(JSON.stringify(mutation, null, 2) + '\n').digest('hex');
}

export async function hostPermissionFingerprint(ctx: ReadContext, locator: PermissionLocator, plannedWrite: boolean) {
  const snapshot = await readPermissionSidecar(ctx.env, locator.platform, locator.settingsPath);
  // An unrelated installation has no authority over an unowned host file.
  if (!plannedWrite && !snapshot.state?.owners[locator.ownerKey]) return 'unowned';
  await assertScopedPermissionPath(ctx, locator);
  return snapshot.unreadable ? 'unreadable' : permissionFileFingerprint(await readPermissionHost(snapshot.target), snapshot.raw);
}

export async function updateHostPermissions(ctx: ReadContext, locator: PermissionLocator, value?: unknown,
  onWrite?: PermissionWriteReceipt, batch?: ReviewedPermissionBatch,
  onNotices?: (notices: Diagnostic[]) => void, expectedFingerprint?: string,
  projectBatch?: RelatedOpenCodeProjectBatch): Promise<boolean> {
  if (value !== undefined && !isHostPermissionMutation(value, locator.platform)) throw new Error('platformContributionUnsupported');
  if (value === undefined && !await hasPermissionOwner(ctx.env, locator)) {
    if (batch) throw permissionConflict();
    return false;
  }
  const planned = await readReconciliation(ctx, locator, value?.permissions, batch?.owners, batch?.relatedProjects, projectBatch?.writes);
  if (expectedFingerprint && expectedFingerprint !== permissionFileFingerprint(planned.host, planned.snapshot.raw)) throw permissionConflict();
  const review = batch ?? value;
  if (!batch && planned.preview.relatedProjects.length) throw permissionConflict();
  if (review && (review.reviewDigest !== planned.preview.reviewDigest
    || identityDigest(review.effective) !== identityDigest(planned.preview.effective))) throw permissionConflict();
  const projectPlans = await planned.liveProjectPlans(projectBatch ? [...projectBatch.pending.values()].map(({ review }) => review) : []);
  let changed: boolean;
  try {
    changed = await commitPermissionOwnership({ ...planned, onWrite, before: planned.merged.before, after: planned.merged.after, effective: planned.merged.effective });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'permissionOwnershipWriteFailed' && planned.appliedNotices.length) {
      onNotices?.(planned.appliedNotices);
    }
    if (projectPlans.length && error && typeof error === 'object' && 'mutation' in error && error.mutation === 'confirmed'
      && 'code' in error && typeof error.code === 'string') {
      throw new RelatedProjectPermissionError(projectPlans.map((project) => project.review.path), 'confirmed',
        ctx.signal?.aborted ?? false, error, { path: locator.settingsPath, code: error.code });
    }
    throw error;
  }
  const notices = changed ? planned.appliedNotices : planned.preview.layerNotices;
  if (notices.length) onNotices?.(notices);
  if (planned.allOwnersCommitted) projectBatch?.pending.clear();
  const incomplete: string[] = [];
  let projectFailure: unknown;
  let possibleProjectChange = false;
  for (const project of projectPlans) {
    const reviewed = batch?.relatedProjects?.find((entry) => entry.path === project.review.path);
    // A subset of owners can produce a different Project rule. Apply only
    // the exact rule changes from the Review and report any remaining work.
    const approved = reviewed && (['removed', 'added', 'additionalImpacts'] as const).every((field) => {
      const approvedEntries = new Set((reviewed[field] ?? []).map(identityDigest));
      return (project.review[field] ?? []).every((entry) => approvedEntries.has(identityDigest(entry)));
    });
    if (!approved && !planned.allOwnersCommitted && !ctx.signal?.aborted && projectBatch) {
      // A later owner may supply a replacement restriction. Until the batch
      // settles, keep the current Project rules and remember what to recheck.
      if (changed) projectBatch.pending.set(project.review.path, { review: project.review,
        subject: { pluginId: parseSharedOwnerToken(locator.ownerKey)?.pluginId, target: 'opencode' } });
      continue;
    }
    if (ctx.signal?.aborted || !approved) {
      projectBatch?.pending.delete(project.review.path);
      incomplete.push(project.review.path);
      continue;
    }
    const reportWrittenProject = () => onNotices?.([{
      code: 'permissionRelatedProjectUpdated', severity: 'info', subject: { target: 'opencode', scope: 'project' },
      detail: { path: project.review.path, reasonCode: 'permissionRelatedProjectUpdated',
        permissionChanges: relatedOpenCodeProjectChanges(project.review) },
      message: 'Updated OpenCode Project permissions.',
    }, ...project.review.additionalImpacts ?? []]);
    try {
      const projectChanged = await commitPermissionOwnership({ ...project, onWrite: (previous, current, target, host) => {
        const destination = project.review.path;
        projectBatch?.writes.set(destination, { original: projectBatch.writes.get(destination)?.original ?? project, fingerprint: current });
        onWrite?.(previous, current, target, host);
      } });
      if (projectChanged) reportWrittenProject();
      projectBatch?.pending.delete(project.review.path);
      changed ||= projectChanged;
    } catch (error) {
      const mutation = error && typeof error === 'object' && 'mutation' in error ? error.mutation : undefined;
      if (mutation === 'confirmed' && error && typeof error === 'object' && 'code' in error && error.code === 'permissionOwnershipWriteFailed') {
        reportWrittenProject();
      }
      changed ||= mutation === 'confirmed';
      possibleProjectChange ||= mutation !== 'none' && !ctx.signal?.aborted;
      projectBatch?.pending.delete(project.review.path);
      incomplete.push(project.review.path);
      projectFailure ??= error;
    }
  }
  if (incomplete.length) throw new RelatedProjectPermissionError(incomplete, changed ? 'confirmed' : possibleProjectChange ? 'possible' : 'none',
    ctx.signal?.aborted ?? false, projectFailure ?? ctx.signal?.reason);
  return changed;
}

export async function missingPermissionOwnershipWarning(ctx: ReadContext, pluginId: string, scope: 'user' | 'project', settingsPath?: string, platform: PermissionHost = 'opencode', blockedProject = false): Promise<Diagnostic | undefined> {
  if (!settingsPath) return { code: 'permissionOwnershipDegraded', severity: 'warning',
    subject: { pluginId, target: platform, scope }, detail: { reasonCode: 'permission-config-path-unconfirmed' },
    message: platform === 'opencode' ? 'OpenCode permission rules were retained. Set an absolute OPENCODE_CONFIG_DIR and retry cleanup.'
      : platform === 'grok' ? 'Grok permission rules were retained. Verify GROK_HOME or the user home directory and retry cleanup.'
        : 'Antigravity permission rules were retained. Verify the user home directory and retry cleanup.' };
  const snapshot = await readPermissionSidecar(ctx.env, platform, settingsPath);
  const hostRoot = platform === 'grok' ? resolvePlatformConfigRoot(platform, ctx) : undefined;
  const project = platform === 'grok' && scope === 'project' ? path.dirname(path.dirname(settingsPath)) : undefined;
  if (project && hostRoot && (blockedProject || !await grokProjectPermissionsAuthorized(ctx, hostRoot, project))) {
    if (snapshot.raw === null && !snapshot.unreadable) return;
    return { code: 'permissionOwnershipDegraded', severity: 'warning', subject: { pluginId, target: platform, scope },
      detail: { reasonCode: 'grok-project-trust-required', path: settingsPath },
      message: 'Project permissions were retained. Review this project in Grok, then retry cleanup.' };
  }
  const parse = (text: string): PermissionDocument => platform === 'opencode' ? parseOpenCodePermissionDocument(text)
    : platform === 'grok' ? parseGrokPermissionDocument(text) : parseAntigravityPermissionDocument(text);
  // An unsafe or unreadable host path can still be retained while unrelated outputs are cleaned.
  const host = await (async () => {
    if (platform === 'antigravity') await assertAntigravityGlobalPermissionPath(ctx, settingsPath);
    if (hostRoot) await assertGrokPermissionPath(ctx, settingsPath, hostRoot, project);
    return readPermissionHost(snapshot.target);
  })().catch(() => '');
  if (snapshot.state) {
    if (host === null) return;
    try {
      const doc = parse(host);
      if (!manualPermissionEntries(snapshot, host, doc.permissions, doc.permissionGroup).retainedAfterDrift) return;
    } catch { /* Unknown ownership must remain visible during cleanup. */ }
  }
  if (!snapshot.unreadable && snapshot.raw === null && host === null) return;
  if (!snapshot.unreadable && snapshot.raw === null) {
    try { if (!parse(host!).permissions.length) return; } catch { /* The host must be reviewed by the user. */ }
  }
  return { code: 'permissionOwnershipDegraded', severity: 'warning',
    subject: { pluginId, target: platform, scope },
    detail: { reasonCode: 'permissionOwnershipDegraded', path: settingsPath },
    message: 'Permission ownership could not be verified. Existing rules were kept. Review the host configuration and sync to rebuild ownership.' };
}

/** Only the host configuration path computed from the caller's current scope is eligible for offline cleanup. */
export async function offlinePermissionComponents(ctx: ReadContext, projectRoot: string | undefined, platform: PermissionHost = 'opencode') {
  const scope = projectRoot ? { kind: 'project' as const, projectRoot } : { kind: 'user' as const };
  const settingsPath = await scopedPermissionPath(ctx, platform, scope);
  if (!settingsPath) return [];
  const snapshot = await readPermissionSidecar(ctx.env, platform, settingsPath);
  if (!snapshot.state) return [];
  const hostConfigRoot = platform === 'opencode' ? getOpenCodePermissionRoot(ctx) : resolvePlatformConfigRoot(platform, ctx);
  if (!hostConfigRoot) return [];
  if (platform === 'grok' && projectRoot && !await grokProjectPermissionsAuthorized(ctx, hostConfigRoot, projectRoot)) return [];
  const components = [];
  for (const token of Object.keys(snapshot.state?.owners ?? {})) {
    const identity = parseSharedOwnerToken(token);
    if (!identity?.pluginId || !identity.sourceId || !identity.sourceIdentity || identity.scope !== (projectRoot ? 'project' : 'user')) continue;
    const binding: DeploymentBinding = { plugin: { pluginId: identity.pluginId, sourceId: identity.sourceId, sourceIdentity: identity.sourceIdentity,
      version: '0.0.0' }, platform, route: platform === 'opencode' ? 'opencode-directory'
        : platform === 'grok' ? projectRoot ? 'grok-directory' : 'grok-cli' : 'antigravity-cli', scope,
      consumers: [{ id: 'offline', product: 'cli', version: null, availability: 'missing', reasonCodes: ['client-missing'],
        entry: { kind: 'directory', configRoot: hostConfigRoot } }], physicalKey: '', id: '', activationKey: '', renderUnitIds: [] };
    const component = permissionComponent(binding, settingsPath, await getInvocationPolicyPhysicalKey(ctx, binding));
    if (component.locator.ownerKey === token) components.push(component);
  }
  return components;
}
