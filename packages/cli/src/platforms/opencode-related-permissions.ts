import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { PermissionRuleChange } from '../output/public-result.js';
import { parseSharedOwnerToken } from '../utils/ownership.js';
import type { Diagnostic, ReadContext } from './contracts.js';
import { adjustedPermissionOwners, hostPermissionImpactDiagnostics } from './host-permission-policy.js';
import { getPhysicalKey, identityDigest } from './identity.js';
import { getDeploymentResourceKey, getOpenCodePermissionRoot } from './layout.js';
import { parseOpenCodePermissionDocument, readOpenCodePermissionChain, type OpenCodeGlobalPolicy } from './opencode-permission-config.js';
import { compareOpenCodePermissions, isOpenCodePermission, mergeOpenCodePermissions, openCodePermissionMayRelax,
  openCodePermissionResourceKey, openCodePrefixesOverlap,
  type OpenCodeClaim, type OpenCodeLayerRule, type OpenCodePermission } from './opencode-permissions.js';
import { commitPermissionOwnership, listPermissionSidecarStates, manualPermissionEntries, permissionConflict, permissionFileFingerprint,
  readPermissionHost, readPermissionSidecar } from './permission-sidecar.js';

export interface RelatedOpenCodeProject {
  path: string;
  fingerprint: string;
  removed: OpenCodePermission[];
  added: OpenCodePermission[];
  additionalImpacts?: Diagnostic[];
}

export function relatedOpenCodeProjectChanges({ removed, added }: RelatedOpenCodeProject): PermissionRuleChange[] {
  return [
    ...removed.map(({ effect, resource }) => ({ change: 'remove' as const, effect, resource })),
    ...added.map(({ effect, resource }) => ({ change: 'add' as const, effect, resource })),
  ];
}

type RelatedProjectWrite = Parameters<typeof commitPermissionOwnership>[0] & { review: RelatedOpenCodeProject; policy: OpenCodeGlobalPolicy };
export type RelatedOpenCodeProjectWrites = Map<string, {
  original: Pick<RelatedProjectWrite, 'snapshot' | 'host' | 'policy'>;
  fingerprint: string;
}>;
export interface RelatedOpenCodeProjectBatch {
  writes: RelatedOpenCodeProjectWrites;
  pending: Map<string, { review: RelatedOpenCodeProject; subject: Diagnostic['subject'] }>;
}
interface RelatedProjectPlan {
  writes: RelatedProjectWrite[];
  conflicts: Array<{ path: string; claim: OpenCodeClaim }>;
}

export function openCodeRestrictions(owners: Record<string, OpenCodeClaim[]>): OpenCodeClaim[] {
  return Object.keys(owners).sort().flatMap((owner) => owners[owner]!.filter((claim) => claim.effect !== 'allow'));
}

export async function readOpenCodeUserRestrictions(ctx: ReadContext, hostConfigRoot?: string, projectTarget?: string): Promise<OpenCodeClaim[]> {
  const userRoot = getOpenCodePermissionRoot(ctx, hostConfigRoot);
  if (!userRoot) return [];
  const snapshot = await readPermissionSidecar(ctx.env, 'opencode', path.join(userRoot, 'opencode.json'));
  return snapshot.target === projectTarget ? [] : openCodeRestrictions(snapshot.state?.owners ?? {});
}

function isProjectOwner(token: string, target: string): boolean {
  const owner = parseSharedOwnerToken(token);
  if (owner?.scope !== 'project' || !owner.pluginId || !owner.sourceId || !owner.sourceIdentity) return false;
  const { sourceId, pluginId, sourceIdentity } = owner;
  const resourceKey = getDeploymentResourceKey({ sourceId, pluginId, sourceIdentity, version: '0.0.0' });
  return owner.physicalKey === getPhysicalKey({ sourceIdentity, pluginId, platform: 'opencode', route: 'opencode-directory',
    namespaceRoot: target, resourceKey: `${resourceKey}:permission` }) && owner.artifactKey === `opencode-permissions-${resourceKey}`;
}

function tokens(rule: OpenCodePermission): string[] {
  return rule.resource.slice(0, -2).split(' ');
}

/** Review and prepare changes to AW-owned entries in related, recorded projects. */
export async function prepareRelatedOpenCodeProjects(ctx: ReadContext, globalPolicy: OpenCodeGlobalPolicy,
  restrictions: OpenCodeClaim[], affectedRestrictions: OpenCodeClaim[], reviewed: RelatedOpenCodeProject[] = [],
  projectWrites?: RelatedOpenCodeProjectWrites): Promise<RelatedProjectPlan> {
  const writes: RelatedProjectPlan['writes'] = [], conflicts: RelatedProjectPlan['conflicts'] = [];
  if (!affectedRestrictions.length && !reviewed.length) return { writes, conflicts };
  const recorded = await listPermissionSidecarStates(ctx.env, 'opencode');
  const originalPolicies = new Map<string, OpenCodeGlobalPolicy>();
  for (const [target, { original, fingerprint }] of projectWrites ?? []) {
    const snapshot = await readPermissionSidecar(ctx.env, 'opencode', target);
    const host = await readPermissionHost(snapshot.target).catch(() => { throw permissionConflict(); });
    if (snapshot.target !== target || !snapshot.state || permissionFileFingerprint(host, snapshot.raw) !== fingerprint
      || !recorded.some((state) => state.target === target && identityDigest(snapshot.state) === identityDigest(state))) {
      throw Object.assign(permissionConflict(), { path: target });
    }
    // Replay the original Review only for bytes already verified by this batch.
    // The execution plan below is built from live project files and layers.
    originalPolicies.set(target, original.policy);
  }
  const inspected: Array<{ path: string; manual: unknown[]; layers: OpenCodeLayerRule[]; restrictions: OpenCodeClaim[] }> = [];
  for (const recordedState of recorded) {
    ctx.signal?.throwIfAborted();
    const original = projectWrites?.get(recordedState.target)?.original;
    const state = original?.snapshot.state ?? recordedState;
    if (state.target === globalPolicy.path || path.basename(state.target) !== 'opencode.json'
      || !Object.keys(state.owners).length || !Object.keys(state.owners).every((token) => isProjectOwner(token, state.target))) continue;
    const prior = reviewed.find((entry) => entry.path === state.target);
    const previousRules = [...prior?.removed ?? [], ...prior?.added ?? []];
    const weaker = (restriction: OpenCodeClaim, effect: OpenCodeClaim['effect'], prefix: string[]) =>
      (restriction.effect === 'deny' && effect !== 'deny' || restriction.effect === 'ask' && effect === 'allow')
      && openCodePrefixesOverlap(restriction.tokens, prefix, ctx.platform);
    const overlaps = (effect: OpenCodeClaim['effect'], prefix: string[]) => effect !== 'deny' && (
      previousRules.some((rule) => rule.effect === effect && openCodePrefixesOverlap(tokens(rule), prefix, ctx.platform))
      || affectedRestrictions.some((restriction) => weaker(restriction, effect, prefix)));
    const claims = Object.values(state.owners).flat();
    if (!claims.some((claim) => overlaps(claim.effect, claim.tokens))) continue;

    const conflict = () => Object.assign(permissionConflict(), { path: state.target });
    const projectRoot = path.dirname(state.target);
    try {
      if (!await fs.stat(projectRoot).then((stat) => stat.isDirectory())) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw conflict();
    }

    const snapshot = original?.snapshot ?? await readPermissionSidecar(ctx.env, 'opencode', state.target);
    if (snapshot.target !== state.target || identityDigest(snapshot.state ?? null) !== identityDigest(state)) throw conflict();
    const host = original ? original.host : await readPermissionHost(snapshot.target).catch(() => { throw conflict(); });
    const digest = host === null ? null : createHash('sha256').update(host).digest('hex');
    if (state.hostDigest !== digest || !state.before.every(isOpenCodePermission) || !state.after.every(isOpenCodePermission)) {
      throw conflict();
    }
    let document;
    try { document = parseOpenCodePermissionDocument(host ?? '{}'); } catch { throw conflict(); }
    const { entries: manual, retainedAfterDrift } = manualPermissionEntries(snapshot, host, document.permissions);
    if (retainedAfterDrift || manual.length + state.before.length + state.after.length !== document.permissions.length) throw conflict();

    const scoped = { ...ctx, cwd: projectRoot, invocationCwd: projectRoot };
    const hostConfigRoot = path.dirname(globalPolicy.path);
    const layers = await readOpenCodePermissionChain(scoped, snapshot.target, hostConfigRoot, projectRoot, document, globalPolicy, originalPolicies);
    const next = mergeOpenCodePermissions(claims, manual, layers, ctx.platform, restrictions);
    // Reconcile only prefixes affected by the User operation. Preserve other
    // AW contributions until their own project's next sync.
    const affected = (rule: OpenCodePermission) => overlaps(rule.effect, tokens(rule));
    const update = (old: OpenCodePermission[], now: OpenCodePermission[]) =>
      [...old.filter((rule) => !affected(rule)), ...now.filter(affected)].sort(compareOpenCodePermissions);
    const before = update(state.before, next.before);
    const after = update(state.after, next.after);
    const relevant = restrictions.filter((restriction) => {
      if (!claims.some((claim) => weaker(restriction, claim.effect, claim.tokens))) return false;
      const resource = openCodePermissionResourceKey(restriction.tokens.join(' ') + ' *', ctx.platform);
      return globalPolicy.permissions.some((rule) => isOpenCodePermission(rule)
        && rule.effect === restriction.effect && openCodePermissionResourceKey(rule.resource, ctx.platform) === resource);
    });
    if (relevant.length) inspected.push({ path: state.target, manual, layers, restrictions: relevant });
    const old = [...state.before, ...state.after];
    const current = [...before, ...after];
    const missing = (rules: OpenCodePermission[], from: OpenCodePermission[]) => {
      const keys = new Set(from.map(identityDigest));
      return rules.filter((rule) => !keys.has(identityDigest(rule)));
    };
    const removed = missing(old, current);
    const added = missing(current, old);
    if (!removed.length && !added.length) continue;
    const adjusted = adjustedPermissionOwners(state.owners, next.adjusted, added,
      (resource, claim) => openCodePermissionResourceKey(resource, ctx.platform)
        === openCodePermissionResourceKey(claim.tokens.join(' ') + ' *', ctx.platform), () => true);
    const additionalImpacts = hostPermissionImpactDiagnostics(adjusted, 'opencode', 'project', state.target);
    const policyDigest = identityDigest({ layers, restrictions });
    const review: RelatedOpenCodeProject = { path: state.target, removed, added,
      ...(additionalImpacts.length ? { additionalImpacts } : {}),
      fingerprint: identityDigest({ host: permissionFileFingerprint(host, snapshot.raw), policyDigest }) };
    const policy = { path: state.target, permissions: document.permissions, agentRules: document.agentRules };
    writes.push({ review, snapshot, host, document, policy, manual, before, after, effective: next.effective, owners: state.owners,
      verifyChain: async () => {
        const currentLayers = await readOpenCodePermissionChain(scoped, snapshot.target, hostConfigRoot, projectRoot, document);
        const currentRestrictions = await readOpenCodeUserRestrictions(ctx, hostConfigRoot, snapshot.target);
        if (identityDigest({ layers: currentLayers, restrictions: currentRestrictions }) !== policyDigest) throw permissionConflict();
      } });
  }
  // Include the known layers that load after the User configuration. When an
  // ancestor is in this plan, inspect its surviving rules and retain its agents.
  const rewritten = new Map(writes.map((write) => [write.review.path, [...write.before, ...write.manual, ...write.after]]));
  for (const project of inspected) {
    const later = project.layers.slice(project.layers.findIndex((entry) => entry.path === globalPolicy.path && entry.source === 'config') + 1);
    const rules = project.manual.map((rule) => ({ path: project.path, rule }));
    const seen = new Set<string>();
    for (const entry of later) {
      if (entry.path === globalPolicy.path || entry.rule === null || entry.layer === 'disabled') continue;
      const replacement = entry.source === 'config' && rewritten.get(entry.path);
      if (!replacement) rules.push(entry);
      else if (!seen.has(entry.path)) {
        seen.add(entry.path);
        rules.push(...replacement.map((rule) => ({ path: entry.path, rule })));
      }
    }
    for (const claim of project.restrictions) {
      const paths = new Set(rules.filter(({ rule }) => openCodePermissionMayRelax(rule, claim, ctx.platform)).map(({ path }) => path));
      for (const path of paths) conflicts.push({ path, claim });
    }
  }
  // Descendant configurations include their ancestors as evidence. Apply the
  // descendant first so an approved ancestor write does not invalidate it.
  writes.sort((a, b) => b.review.path.length - a.review.path.length || a.review.path.localeCompare(b.review.path));
  return { writes, conflicts };
}
