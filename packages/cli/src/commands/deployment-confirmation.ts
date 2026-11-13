import type { Confirmation } from '../output/public-result.js';
import type { FrozenDeploymentPlan } from '../platforms/contracts.js';

/** Project the reviewed physical effects without observing or changing the host. */
export function deploymentConfirmationEffects(deployment: FrozenDeploymentPlan): Confirmation['effects'] {
  const { binding, evidence } = deployment;
  const packageSlot = evidence.ownership.find((slot) => 'path' in slot.component
    && slot.component.path === evidence.layout.packageRoot);
  const sharedOutput = evidence.sharedReferences !== 'none'
    || packageSlot !== undefined && packageSlot.component.identity.scope !== binding.scope.kind;
  return deployment.effects.flatMap((effect) => {
    const replacesSharedOutput = sharedOutput && effect.physicalKey === binding.physicalKey
      && (effect.kind === 'refresh' || effect.kind === 'publish-package'
        && packageSlot !== undefined && ['present', 'partial'].includes(packageSlot.state));
    if (!effect.destructive && !replacesSharedOutput) return [];
    return [{ code: replacesSharedOutput ? 'replaceSharedOutput' : 'removeOwnedOutput',
      message: replacesSharedOutput ? 'Replace shared native output used by other scopes.' : 'Remove owned output or its activation.',
      impact: replacesSharedOutput ? 'shared' as const : 'selected-scope' as const,
      subject: { pluginId: binding.plugin.pluginId, target: binding.platform, scope: binding.scope.kind } }];
  });
}
