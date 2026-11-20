import { createOperationPlan, type OperationPlan } from '../commands/operation-plan.js';
import type { RebuildCommandRuntime } from '../commands/rebuild-command.js';
import { recoveryInterruptionCode } from './interruption.js';
import { refreshRecoveryNativePreviews, type RecoveryPlan } from './coordinator.js';
import type { RecoveryReceipt, RecoveryTarget } from './receipt.js';

type NativeGroup = RecoveryPlan['nativeGroups'][number];

/** A verified shared User package can change only the reconcile labels of an otherwise identical Project plan. */
function equivalentAfterUserInstall(group: NativeGroup, next: OperationPlan, providers: RecoveryTarget[]): boolean {
  const previous = group.preview.operationPlan!;
  const changes = new Map<string, string>();
  const owners = next.evidence.targetOwnerFingerprints.map((owner) => {
    const placement = group.preview.dependencyPlan?.targets.find((target) => target.pluginId === owner.pluginId
      && target.platform === owner.platform && target.resolvedScope === owner.scope);
    const provider = providers.find((target) => target.pluginId === owner.pluginId && target.agent === owner.platform);
    if (!placement || !provider || placement.errorCode || placement.action === 'block'
      || owner.fingerprint !== JSON.stringify({ state: 'present', errorCode: null })) return owner;
    const physicalKeys = new Set(provider.deploymentPlans?.filter((plan) => provider.deploymentReceipts?.some((receipt) =>
      receipt.bindingId === plan.binding.id && receipt.after.registration === 'present')).map((plan) => plan.binding.physicalKey));
    if (!physicalKeys.size) return owner;
    if (owner.scope === 'project' && !previous.deploymentPlans?.some((plan) => plan.binding.plugin.pluginId === owner.pluginId
      && plan.binding.scope.kind === owner.scope && physicalKeys.has(plan.binding.physicalKey))) return owner;
    const reviewed = previous.evidence.targetOwnerFingerprints.find((item) => item.pluginId === owner.pluginId
      && item.platform === owner.platform && item.scope === owner.scope);
    if (!reviewed || !['partial', 'absent'].includes(placement.state)) return owner;
    const prefix = [owner.pluginId, owner.platform, owner.scope].join(':');
    const action = placement.relation === 'dependency' ? 'keep' : group.command === 'reinstall' ? 'reinstall' : 'install';
    changes.set(`${prefix}:${action}`, `${prefix}:${placement.action}`);
    return reviewed;
  });
  return createOperationPlan({ ...next, changes: next.changes.map((change) => changes.get(change) ?? change),
    evidence: { ...next.evidence, targetOwnerFingerprints: owners } }).planFingerprint === previous.planFingerprint;
}

export async function rebaseCheckedProjectInstall(child: RecoveryPlan, previous: Iterable<RecoveryReceipt>,
  runtime: RebuildCommandRuntime): Promise<RecoveryPlan> {
  if (child.options.scope !== 'project' || child.runtime.batchInstallPlatform !== 'codex') return child;
  const providers = [...previous].flatMap((receipt) => receipt.targetResults).filter((target) => target.agent === 'codex'
    && target.scope === 'user' && target.execution === 'applied' && target.observation === 'verified'
    && target.content === 'satisfied' && !target.blockers.length);
  if (!providers.length) return child;
  const next = { ...child, nativeGroups: [...child.nativeGroups], receipt: structuredClone(child.receipt) };
  for (const [index, group] of child.nativeGroups.entries()) {
    if (!group.preview.operationPlan || !group.preview.dependencyPlan?.targets.some((target) =>
      providers.some((provider) => provider.pluginId === target.pluginId))) continue;
    const candidate = { ...child, nativeGroups: [{ ...group }], runtime: { ...child.runtime, ...runtime },
      receipt: structuredClone(child.receipt) };
    try {
      await refreshRecoveryNativePreviews(candidate, undefined, runtime.signal);
      const checked = candidate.nativeGroups[0]!;
      if (checked.preview.operationPlan && (checked.preview.operationPlan.planFingerprint === group.preview.operationPlan.planFingerprint
        || equivalentAfterUserInstall(group, checked.preview.operationPlan, providers))) {
        next.nativeGroups[index] = checked;
        continue;
      }
    } catch (error) { if (recoveryInterruptionCode(error, runtime.signal)) throw error; }
    for (const target of next.receipt.targetResults) if (group.pluginIds.includes(target.pluginId)) {
      target.blockers.push({ code: 'operationReviewStale', message: '确认依据已改变，请重新检查并确认。' });
    }
  }
  return next;
}
