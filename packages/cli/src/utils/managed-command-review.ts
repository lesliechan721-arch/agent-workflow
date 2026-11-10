import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { COMMAND_PRODUCER_RECORD_FILE, normalizeInstalledCommandProducer, type InstalledCommandProducer, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';

import type { ClaudePermissions } from '../generators/permissions.js';
import type { DeploymentBinding, ProjectionResult, RenderUnit } from '../platforms/contracts.js';

export type ManagedCommandPermissionReview =
  | { kind: 'codex-rules'; pluginId: string; path: string; content: string }
  | { kind: 'claude-permissions'; pluginId: string; path: string; permissions: ClaudePermissions };

/** Operation-local values copied from the same projected bytes that execution publishes. */
export interface ManagedCommandReviewEvidence {
  producers: InstalledCommandProducer[];
  permissions: ManagedCommandPermissionReview[];
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
  components: readonly PluginComponent[];
  projections: readonly ProjectionResult[];
}): Promise<ManagedCommandReviewEvidence> {
  const { binding } = options;
  const producers: InstalledCommandProducer[] = [];
  const permissions: ManagedCommandPermissionReview[] = [];
  for (const projection of options.projections) {
    const unit = options.renderUnits.find((candidate) => candidate.id === projection.renderUnitId);
    if (!unit || unit.physicalKey !== binding.physicalKey && unit.output === 'package') invalid();
    if (projection.bundle) for (const component of projection.components) {
      if (!options.components.some((candidate) => candidate.id === component.id && candidate.kind === 'skill')) continue;
      const relative = `skills/${component.nativeName}/${COMMAND_PRODUCER_RECORD_FILE}`;
      if (!component.relativeOutputs.includes(relative)) continue;
      const record = normalizeInstalledCommandProducer(JSON.parse((await ordinaryFile(path.join(projection.bundle.stagingRoot, relative))).toString('utf8')));
      const producer = record.producer;
      if (producer.kind === 'package' || producer.sourceId !== binding.plugin.sourceId
        || producer.sourceIdentity !== binding.plugin.sourceIdentity || producer.pluginName !== binding.plugin.pluginId.split('/').at(-1)
        || producer.platform !== binding.platform || producer.placementKey !== unit.physicalKey
        || producer.scope !== unit.renderScope.kind || producer.projectRoot !== (unit.renderScope.kind === 'project' ? unit.renderScope.projectRoot : null)
        || component.id !== (producer.kind === 'static-skill' ? `skill:${producer.key}` : producer.key)) invalid();
      producers.push(record);
    }
    for (const contribution of projection.supplements) {
      const codex = binding.platform === 'codex' && contribution.kind === 'owned-file'
        && contribution.id.startsWith('policy:') && path.extname(contribution.destination) === '.rules';
      const claude = binding.platform === 'claude' && contribution.kind === 'config-entry'
        && contribution.mergeKey?.startsWith('claude-permissions:');
      if (!codex && !claude) continue;
      const bytes = await ordinaryFile(contribution.stagingPath);
      if (`sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== contribution.contentDigest) invalid();
      if (codex) {
        permissions.push({ kind: 'codex-rules', pluginId: binding.plugin.pluginId, path: contribution.destination, content: bytes.toString('utf8') });
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
  return { producers, permissions };
}
