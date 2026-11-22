import { antigravityPermissionResources } from '../platforms/antigravity-permissions.js';
import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type { ClaudePermissions, InactiveManagedCommandPermission } from '../generators/permissions.js';
import { isHostPermissionMutation, isPermissionHost, type HostPermissionMutation, type HostPermissionRule } from '../platforms/host-permission-policy.js';
import type { DeploymentBinding, ProjectionResult, RenderUnit } from '../platforms/contracts.js';

export type ManagedCommandPermissionReview =
  | { kind: 'codex-rules'; pluginId: string; path: string; content: string }
  | { kind: 'claude-permissions'; pluginId: string; path: string; permissions: ClaudePermissions }
  | { kind: HostPermissionMutation['kind']; pluginId: string; path: string; permissions: HostPermissionRule[] };

/** Operation-local values copied from the same projected bytes that execution publishes. */
export interface ManagedCommandReviewEvidence {
  permissions: ManagedCommandPermissionReview[];
  inactivePermissions: InactiveManagedCommandPermission[];
}

function invalid(): never { throw new Error('commandReviewEvidenceInvalid: The prepared command Review does not match its deployment.'); }

async function ordinaryFile(file: string): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) invalid();
  return fs.readFile(file);
}

/** Capture once during preparation. Review performs no filesystem reads or renderer calls. */
export async function captureManagedCommandReviewEvidence(options: {
  binding: DeploymentBinding;
  renderUnits: readonly RenderUnit[];
  projections: readonly ProjectionResult[];
  inactivePermissions?: readonly InactiveManagedCommandPermission[];
}): Promise<ManagedCommandReviewEvidence> {
  const { binding } = options;
  const permissions: ManagedCommandPermissionReview[] = [];
  for (const projection of options.projections) {
    const unit = options.renderUnits.find((candidate) => candidate.id === projection.renderUnitId);
    if (!unit || unit.physicalKey !== binding.physicalKey && unit.output === 'package') invalid();
    for (const contribution of projection.supplements) {
      const codex = binding.platform === 'codex' && contribution.kind === 'owned-file'
        && contribution.id.startsWith('policy:') && path.extname(contribution.destination) === '.rules';
      const claude = binding.platform === 'claude' && contribution.kind === 'config-entry'
        && contribution.mergeKey?.startsWith('claude-permissions:');
      const host = isPermissionHost(binding.platform) && contribution.kind === 'config-entry'
        && contribution.mergeKey?.startsWith(`${binding.platform}-permissions:`);
      if (!codex && !claude && !host) continue;
      const bytes = await ordinaryFile(contribution.stagingPath);
      if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== contribution.contentDigest) invalid();
      if (codex) {
        permissions.push({ kind: 'codex-rules', pluginId: binding.plugin.pluginId, path: contribution.destination, content: bytes.toString('utf8') });
      } else if (host) {
        const mutation: unknown = JSON.parse(bytes.toString('utf8'));
        if (!isPermissionHost(binding.platform) || !isHostPermissionMutation(mutation, binding.platform)) invalid();
        permissions.push({ kind: mutation.kind, pluginId: binding.plugin.pluginId, path: contribution.destination,
          permissions: mutation.effective });
        for (const affected of mutation.affected ?? []) permissions.push({ kind: mutation.kind, path: contribution.destination,
          pluginId: affected.pluginId, permissions: affected.permissions });
      } else {
        const mutation = JSON.parse(bytes.toString('utf8')) as { kind?: unknown; permissions?: unknown };
        const value = mutation.permissions;
        if (mutation.kind !== 'claude-permissions' || !value || typeof value !== 'object' || Array.isArray(value)) invalid();
        const record = value as Record<string, unknown>;
        if (Object.keys(record).some((key) => !['allow', 'ask', 'deny', 'excludedCommands'].includes(key))
          || ['allow', 'ask', 'deny'].some((key) => !Object.hasOwn(record, key))
          || Object.values(record).some((rules) => !Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))) invalid();
        permissions.push({ kind: 'claude-permissions', pluginId: binding.plugin.pluginId, path: contribution.destination,
          permissions: record as unknown as ClaudePermissions });
      }
    }
  }
  return { permissions, inactivePermissions: (options.inactivePermissions ?? [])
    .map((permission) => ({ ...permission, argsPrefix: [...permission.argsPrefix] })) };
}

/** Review only inactive restrictions that survive the final shared-file merge. */
export function reviewedInactivePermissions(binding: DeploymentBinding, evidence?: ManagedCommandReviewEvidence): InactiveManagedCommandPermission[] {
  if (!evidence) return [];
  if (!isPermissionHost(binding.platform)) return evidence.inactivePermissions;
  const active = evidence.permissions.flatMap((item) => item.kind !== 'codex-rules' && item.kind !== 'claude-permissions'
    && item.pluginId === binding.plugin.pluginId ? item.permissions : []);
  return evidence.inactivePermissions.filter(({ action, argsPrefix }) => {
    const tokens = ['aw', 'command', 'run', binding.plugin.pluginId, '--', ...argsPrefix];
    const prefix = tokens.join(' ');
    const resources = binding.platform === 'antigravity' ? antigravityPermissionResources({ tokens })
      : [binding.platform === 'grok' ? prefix : prefix + ' *'];
    return active.some((rule) => resources.includes(rule.resource) && rule.effect === action);
  });
}
