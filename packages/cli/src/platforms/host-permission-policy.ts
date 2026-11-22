import { normalizeCommandSelector } from '@lesliechan721/aw-plugin-core/manifest';
import { deliveryNoticeMessage, HOST_PERMISSION_ADDITIONAL_IMPACT, hostPermissionImpactMessage,
  INVOCATION_POLICY_NOT_APPLIED, PERMISSION_ACTIONS, publicHostPermissionResource } from '../output/component-delivery.js';
import { parseSharedOwnerToken } from '../utils/ownership.js';
import type { DeploymentBinding, Diagnostic } from './contracts.js';
import { isGrokPermission } from './grok-permissions.js';
import { isAntigravityPermission } from './antigravity-permissions.js';
import { isOpenCodePermission } from './opencode-permissions.js';
import { isPermissionClaim, type HostPermissionAdjustment, type PermissionClaim } from './permission-sidecar.js';

export type PermissionHost = 'opencode' | 'antigravity' | 'grok';
export interface HostPermissionRule {
  action: 'shell';
  resource: string;
  effect: PermissionClaim['effect'];
}
export interface HostPermissionMutation {
  kind: `${PermissionHost}-permissions`;
  permissions: PermissionClaim[];
  effective: HostPermissionRule[];
  reviewDigest: string;
  affected?: Array<{ pluginId: string; permissions: HostPermissionRule[] }>;
}

export function isPermissionHost(platform: string): platform is PermissionHost {
  return platform === 'opencode' || platform === 'antigravity' || platform === 'grok';
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAffectedOwner(value: unknown, isRule: (value: unknown) => boolean): boolean {
  if (!record(value) || !Array.isArray(value.permissions) || !value.permissions.every(isRule)) return false;
  try { normalizeCommandSelector(value.pluginId); return true; } catch { return false; }
}

export type OwnedPermissionAdjustment = HostPermissionAdjustment & { pluginId: string; scope?: 'user' | 'project' };

export function adjustedPermissionOwners(owners: Record<string, PermissionClaim[]>, adjusted: HostPermissionAdjustment[] | undefined,
  effective: readonly HostPermissionRule[], matches: (resource: string, claim: PermissionClaim) => boolean,
  include: (owner: string, adjustment: HostPermissionAdjustment) => boolean): OwnedPermissionAdjustment[] {
  const result = new Map<string, OwnedPermissionAdjustment>();
  for (const adjustment of adjusted ?? []) {
    const { effect, resource, reasonCode, message } = adjustment;
    if (!effective.some((rule) => rule.effect === effect && rule.resource === resource)) continue;
    for (const [owner, claims] of Object.entries(owners)) {
      const { pluginId, scope } = parseSharedOwnerToken(owner) ?? {};
      if (!pluginId || !include(owner, adjustment)) continue;
      const claim = claims.find((item) => item.effect === effect && matches(resource, item));
      if (!claim) continue;
      const key = JSON.stringify([pluginId, scope, effect, resource, reasonCode, message]);
      if (!result.has(key)) result.set(key, { ...adjustment, ...claim, pluginId, scope });
    }
  }
  return [...result.values()];
}

export function hostPermissionImpactDiagnostics(adjusted: readonly OwnedPermissionAdjustment[], target: PermissionHost | 'claude',
  scope: 'user' | 'project', path: string): Diagnostic[] {
  return adjusted.map(({ pluginId, name, reasonCode, resource, effect, message, scope: ownerScope = scope }) => ({
    code: HOST_PERMISSION_ADDITIONAL_IMPACT, severity: 'warning', message: hostPermissionImpactMessage(message),
    subject: { pluginId, target, scope: ownerScope, field: `permissions.${name}` },
    detail: { reasonCode, path, permissionResource: publicHostPermissionResource(resource), permissionAction: effect },
  }));
}

export function hostPermissionDiagnostics(preview: {
  skipped: Array<{ name: string; effect: PermissionClaim['effect']; reasonCode: string; pluginId?: string; path?: string }>;
  adjusted?: OwnedPermissionAdjustment[];
  layerNotices?: Diagnostic[];
  ownershipDegraded: boolean;
}, binding: DeploymentBinding, destination: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const subject = { pluginId: binding.plugin.pluginId, target: binding.platform, scope: binding.scope.kind };
  const groups = new Map<string, typeof preview.skipped>();
  for (const skipped of preview.skipped) {
    const key = JSON.stringify([skipped.pluginId ?? subject.pluginId, skipped.name, skipped.reasonCode, skipped.path]);
    const group = groups.get(key) ?? [];
    group.push(skipped);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const { name, reasonCode, pluginId = subject.pluginId, path } = group[0]!;
    const field = `permissions.${name}`;
    const detail = { reasonCode, ...(path ? { path } : {}), skippedPermissionActions: PERMISSION_ACTIONS.filter((action) => group.some(({ effect }) => effect === action)) };
    diagnostics.push({ code: INVOCATION_POLICY_NOT_APPLIED, severity: 'warning', subject: { ...subject, pluginId, field }, detail,
      message: path ? `OpenCode Project rules in ${path} may still relax this User restriction. Review the Project settings.`
        : deliveryNoticeMessage(INVOCATION_POLICY_NOT_APPLIED, detail, field) });
  }
  if (preview.ownershipDegraded) diagnostics.push({ code: 'permissionOwnershipDegraded', severity: 'warning', subject,
    detail: { reasonCode: 'permissionOwnershipDegraded', path: destination },
    message: 'Existing permission rules were retained because their ownership could not be verified. Review them and sync to rebuild ownership.' });
  if (isPermissionHost(binding.platform)) diagnostics.push(...hostPermissionImpactDiagnostics(preview.adjusted ?? [], binding.platform, binding.scope.kind, destination));
  diagnostics.push(...preview.layerNotices ?? []);
  return diagnostics;
}

export function isHostPermissionMutation(value: unknown, platform: PermissionHost): value is HostPermissionMutation {
  const isRule = platform === 'opencode' ? isOpenCodePermission : platform === 'grok' ? isGrokPermission : isAntigravityPermission;
  return record(value) && value.kind === `${platform}-permissions` && typeof value.reviewDigest === 'string'
    && /^sha256:[a-f0-9]{64}$/u.test(value.reviewDigest) && Array.isArray(value.permissions) && value.permissions.every(isPermissionClaim)
    && Array.isArray(value.effective) && value.effective.every(isRule)
    && (value.affected === undefined || Array.isArray(value.affected) && value.affected.every((affected) => isAffectedOwner(affected, isRule)));
}
