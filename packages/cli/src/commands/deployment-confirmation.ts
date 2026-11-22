import { isPermissionHost } from '../platforms/host-permission-policy.js';
import { HOST_PERMISSION_ADDITIONAL_IMPACT } from '../output/component-delivery.js';
import type { Confirmation } from '../output/public-result.js';
import type { Diagnostic, FrozenDeploymentPlan } from '../platforms/contracts.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';

export function relatedProjectPermissionEffects(batch: FrozenDeploymentPlan['evidence']['permissionBatch']): Confirmation['effects'] {
  return (batch?.relatedProjects ?? []).map(({ path, removed, added }) => {
    const changes = [
      ...removed.map((rule) => `Remove ${rule.effect} ${rule.action} ${rule.resource}`),
      ...added.map((rule) => `Add ${rule.effect} ${rule.action} ${rule.resource}`),
    ];
    return { code: 'changeRelatedProjectPermissions', impact: 'shared', subject: { target: 'opencode', scope: 'project' },
      message: [path, ...changes].join('\n') };
  });
}

export function additionalPermissionEffects(notices: readonly Diagnostic[] = []): Confirmation['effects'] {
  return notices.map(({ code, message, subject, detail }) => ({ code, subject,
    message: [detail?.permissionResource && `${detail.permissionAction} ${detail.permissionResource}`,
      detail?.path, message].filter(Boolean).join(' · '),
    impact: subject?.scope === 'user' ? 'user-wide' : 'selected-scope' }));
}

export function deploymentAdditionalPermissionImpacts(plan: FrozenDeploymentPlan): Diagnostic[] {
  const writes = (path: string | undefined) => plan.effects.some((effect) =>
    (effect.kind === 'write-supplement' || effect.kind === 'remove-owned') && effect.destination === path);
  const writesBatch = plan.evidence.ownership.some(({ component }) =>
    component.kind === 'shared-config' && component.locator.kind === 'host-permissions' && writes(component.locator.settingsPath));
  const result = [
    ...(writesBatch ? plan.evidence.permissionBatch?.additionalImpacts ?? [] : []),
    ...plan.projections.flatMap(({ diagnostics }) => diagnostics.filter((notice) =>
      notice.code === HOST_PERMISSION_ADDITIONAL_IMPACT && writes(notice.detail?.path))),
  ];
  return [...new Map(result.map((notice) => [JSON.stringify(notice), notice])).values()];
}

export function configApplyDeploymentUnavailable(plan: RecoveryPlan, { binding }: FrozenDeploymentPlan): boolean {
  return plan.options.existingOnly === true && plan.receipt.targetResults.some((target) =>
    target.pluginId === binding.plugin.pluginId && target.agent === binding.platform && target.scope === binding.scope.kind
    && target.blockers.some(({ code }) => code === 'configApplyRequiresExistingOutput'));
}

export function recoveryHostPermissionEffects(plan: RecoveryPlan): Confirmation['effects'] {
  return [...new Map([
    ...plan.nativeGroups.flatMap(({ preview }) => [
      ...preview.operationPlan?.deploymentPlans?.flatMap((deployment) => configApplyDeploymentUnavailable(plan, deployment) ? [] : [
        ...relatedProjectPermissionEffects(deployment.evidence.permissionBatch),
        ...additionalPermissionEffects(deploymentAdditionalPermissionImpacts(deployment)),
      ]) ?? [],
      ...preview.operationPlan?.actions.flatMap((action) => action.kind === 'removeOwnedArtifact'
        ? [...relatedProjectPermissionEffects(action.permissionRemoval?.batch),
          ...additionalPermissionEffects(action.permissionRemoval?.batch?.additionalImpacts)] : []) ?? [],
    ]),
    ...(plan.joint?.children ?? []).flatMap(recoveryHostPermissionEffects),
  ].map((effect) => [JSON.stringify(effect), effect])).values()];
}

export function restorationEffects(notices: Diagnostic[] = []): Confirmation['effects'] {
  return notices.map(({ code, message, subject }) => ({ code, message, subject, impact: 'selected-scope' }));
}

/** Project the reviewed physical effects without observing or changing the host. */
export function deploymentConfirmationEffects(deployment: FrozenDeploymentPlan): Confirmation['effects'] {
  const { binding, evidence } = deployment;
  const packageSlot = evidence.ownership.find((slot) => 'path' in slot.component
    && slot.component.path === evidence.layout.packageRoot);
  const sharedOutput = evidence.sharedReferences !== 'none'
    || packageSlot !== undefined && packageSlot.component.identity.scope !== binding.scope.kind;
  const permissions = [...restorationEffects(evidence.permissionBatch?.restorations), ...relatedProjectPermissionEffects(evidence.permissionBatch),
    ...additionalPermissionEffects(deploymentAdditionalPermissionImpacts(deployment))];
  const writesSupplement = deployment.effects.some((effect) => effect.kind === 'write-supplement');
  if (isPermissionHost(binding.platform) && writesSupplement) {
    for (const item of evidence.managedCommandReview?.permissions ?? []) {
      if (item.kind === 'claude-permissions' || item.kind === 'codex-rules' || !item.permissions.length) continue;
      if (!deployment.effects.some((effect) => effect.kind === 'write-supplement' && effect.destination === item.path)) continue;
      permissions.push({ code: 'changeHostPermissions', impact: 'selected-scope',
        subject: { pluginId: item.pluginId, target: binding.platform, scope: binding.scope.kind },
        message: [`Configure permissions in ${item.path}`, ...item.permissions.map((rule) => `${rule.effect} ${rule.action} ${rule.resource}`)].join('\n') });
    }
  }
  if (binding.platform === 'opencode' && writesSupplement || binding.platform === 'antigravity' || binding.platform === 'grok') {
    for (const diagnostic of deployment.projections.flatMap((projection) => projection.diagnostics)) {
      if (diagnostic.code === 'invocationPolicyNotApplied') permissions.push({ code: diagnostic.code, impact: 'selected-scope',
        message: diagnostic.message, subject: diagnostic.subject });
    }
  }
  return [...permissions, ...deployment.effects.flatMap((effect) => {
    const replacesSharedOutput = sharedOutput && effect.physicalKey === binding.physicalKey
      && (effect.kind === 'refresh' || effect.kind === 'publish-package'
        && packageSlot !== undefined && ['present', 'partial'].includes(packageSlot.state));
    if (!effect.destructive && !replacesSharedOutput) return [];
    return [{ code: replacesSharedOutput ? 'replaceSharedOutput' : 'removeOwnedOutput',
      message: replacesSharedOutput ? 'Replace shared native output used by other scopes.' : 'Remove owned output or its activation.',
      impact: replacesSharedOutput ? 'shared' as const : 'selected-scope' as const,
      subject: { pluginId: binding.plugin.pluginId, target: binding.platform, scope: binding.scope.kind } }];
  })];
}
