import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import type { PreparedDeployment, ReadContext, HostContribution } from '../platforms/contracts.js';
import type { PlatformDriverState } from '../platforms/lifecycle.js';
import { isHostPermissionMutation, isPermissionHost, hostPermissionDiagnostics } from '../platforms/host-permission-policy.js';
import { previewPermissionBatch, type PermissionBatchOwners, type PermissionLocator } from '../platforms/permission-ownership.js';
import { getAgentPluginAdapter } from '../platforms/registry.js';
import type { DesiredTarget } from './rebuild-operations.js';
import type { PermissionClaim } from '../platforms/permission-sidecar.js';
import { identityDigest } from '../platforms/identity.js';
import { GROK_WRAPPER_TARGET_NOT_COVERED, HOST_PERMISSION_ADDITIONAL_IMPACT } from '../output/component-delivery.js';

interface Participant {
  target: DesiredTarget;
  deployment: PreparedDeployment<PlatformDriverState>;
  locator: PermissionLocator;
  contribution?: HostContribution;
  claims: PermissionClaim[];
}

/** Freeze all declarations for each shared permission file after eligible targets are known. */
export async function sealPermissionBatches(targets: readonly DesiredTarget[], context: (target: DesiredTarget) => ReadContext,
  adapterFor: typeof getAgentPluginAdapter): Promise<void> {
  const files = new Map<string, Participant[]>();
  for (const target of targets) for (const deployment of target.platformDeployment?.deployments ?? []) {
    const { plan, driverState } = deployment;
    if (!isPermissionHost(plan.binding.platform)) continue;
    const slot = plan.evidence.ownership.find(({ component }) => component.kind === 'shared-config' && component.locator.kind === 'host-permissions');
    if (!slot || slot.component.kind !== 'shared-config' || slot.component.locator.kind !== 'host-permissions') continue;
    const locator = slot.component.locator;
    const contribution = plan.projections.flatMap((entry) => entry.supplements).find((entry) =>
      entry.kind === 'config-entry' && entry.destination === locator.settingsPath);
    const remove = driverState.removals.some(({ component }) => component.identity.artifactKey === slot.component.identity.artifactKey);
    if (!contribution && !remove) continue;
    if (contribution && slot.contentDigest !== contribution.contentDigest && !driverState.contributions.some((item) =>
      item.contribution.id === contribution.id)) continue;
    let claims: PermissionClaim[] = [];
    if (contribution) {
      const bytes = await fs.readFile(contribution.stagingPath);
      if ('sha256:' + createHash('sha256').update(bytes).digest('hex') !== contribution.contentDigest) throw new Error('operationPlanStale');
      const mutation: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isHostPermissionMutation(mutation, locator.platform)) throw new Error('platformContributionUnsupported');
      claims = mutation.permissions;
    }
    const entries = files.get(locator.settingsPath) ?? [];
    entries.push({ target, deployment, locator, contribution, claims });
    files.set(locator.settingsPath, entries);
  }
  for (const entries of files.values()) {
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only?.contribution && (only.locator.platform !== 'opencode' || only.locator.projectRoot)) continue;
    const owners: PermissionBatchOwners = {};
    for (const entry of entries.sort((a, b) => a.locator.ownerKey.localeCompare(b.locator.ownerKey))) owners[entry.locator.ownerKey] = entry.claims;
    for (const { target, deployment, locator, contribution, claims } of entries) {
      const { plan } = deployment;
      if (plan.evidence.permissionBatch && identityDigest(plan.evidence.permissionBatch.owners) === identityDigest(owners)) continue;
      const preview = await previewPermissionBatch(context(target), locator, claims, owners);
      if (only?.contribution && !preview.relatedProjects.length) continue;
      const evidence = structuredClone(plan.evidence);
      evidence.permissionBatch = { owners, reviewDigest: preview.reviewDigest, effective: preview.effective, restorations: preview.restorations,
        ...(preview.additionalImpacts.length ? { additionalImpacts: preview.additionalImpacts } : {}),
        ...(preview.relatedProjects.length ? { relatedProjects: preview.relatedProjects } : {}) };
      if (evidence.managedCommandReview) {
        evidence.managedCommandReview.permissions = evidence.managedCommandReview.permissions.filter((item) => item.kind !== `${locator.platform}-permissions`);
        for (const item of [{ pluginId: plan.binding.plugin.pluginId, permissions: preview.effective }, ...preview.affected]) {
          evidence.managedCommandReview.permissions.push({ kind: `${locator.platform}-permissions`, path: locator.settingsPath, ...item });
        }
      }
      const projections = structuredClone(plan.projections);
      const projection = projections.find((entry) => entry.supplements.some((item) => item.id === contribution?.id));
      if (projection) {
        projection.diagnostics = projection.diagnostics.filter((item) => item.code !== 'permissionOwnershipDegraded' && item.code !== HOST_PERMISSION_ADDITIONAL_IMPACT
          && !(item.code === 'invocationPolicyNotApplied' && ['permission-prefix-unrepresentable', 'permission-rule-conflict', 'config-disabled', 'opencode-windows-command-syntax', 'grok-shell-pattern-unrepresentable', 'grok-shell-prefix-normalized', GROK_WRAPPER_TARGET_NOT_COVERED, 'antigravity-command-matching-unverified', 'antigravity-strict-mode', 'antigravity-windows-command-syntax']
            .includes(item.detail?.reasonCode ?? '')));
        projection.diagnostics.push(...hostPermissionDiagnostics({ ...preview, adjusted: undefined }, plan.binding, locator.settingsPath));
      }
      const updated = adapterFor(plan.binding.platform).lifecycle.prepare({ ...plan, projections, evidence, observation: deployment.driverState.before });
      if (updated.status !== 'ready') throw new Error('operationPlanStale: the shared permission plan could not be frozen.');
      const prepared = target.platformDeployment!;
      prepared.deployments.splice(prepared.deployments.indexOf(deployment), 1, updated.prepared);
      prepared.plans.splice(prepared.plans.findIndex((item) => item.binding.id === plan.binding.id), 1, updated.prepared.plan);
    }
  }
}
