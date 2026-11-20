import { getPlatformFeatureRegistry, type ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';
import type { RecoveryComponentGap, RecoveryTarget } from '../recovery/receipt.js';
import type { Diagnostic } from './public-result.js';
import { isDeliveryCapabilityGap, isDeliveryCapabilityGapReason } from '../utils/component-gap.js';
import { SKILL_INVOCATION_NOTICE } from '../utils/skill-invocation-warning.js';

export type ComponentDelivery = Pick<RecoveryTarget, 'satisfaction' | 'installedComponentCount' | 'componentGaps' | 'installedComponentIds'>;

export function projectComponentGap(gap: ComponentUnmet): ComponentUnmet {
  return { id: gap.id, kind: gap.kind, ...(gap.name ? { name: gap.name } : {}),
    ...(gap.componentId ? { componentId: gap.componentId } : {}), reasonCode: gap.reasonCode,
    requiredFeatures: gap.requiredFeatures.map(({ feature, values }) => ({ feature, ...(values ? { values: [...values] } : {}) })) };
}

export function projectComponentDelivery(value: ComponentDelivery): ComponentDelivery {
  return {
    ...(value.satisfaction ? { satisfaction: value.satisfaction } : {}),
    ...(value.installedComponentCount !== undefined && Number.isSafeInteger(value.installedComponentCount) && value.installedComponentCount >= 0
      ? { installedComponentCount: value.installedComponentCount } : {}),
    ...(value.installedComponentIds ? { installedComponentIds: [...value.installedComponentIds] } : {}),
    ...(value.componentGaps ? { componentGaps: value.componentGaps.map((gap): RecoveryComponentGap => ({
      ...projectComponentGap(gap), providerPluginId: gap.providerPluginId, agent: gap.agent, renderScope: gap.renderScope,
    })) } : {}),
  };
}

export function componentGapOutcome(gap: ComponentUnmet, installedIds?: readonly string[]): 'skipped' | 'limited' | 'unmet' {
  if (!isDeliveryCapabilityGap(gap)) return 'unmet';
  return gap.componentId && installedIds?.includes(gap.componentId) ? 'limited' : 'skipped';
}

export function hasComponentDeliveryNotice(value: ComponentDelivery): boolean {
  return value.componentGaps?.some(isDeliveryCapabilityGap) ?? false;
}

export function safeComponentIdentity(value: string): string {
  // Component IDs come from plugin authors; history accepts label-like IDs only.
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value) ? value : '<component>';
}

export function componentGapFeatures(gap: ComponentUnmet, separator = '='): string[] {
  const registry = getPlatformFeatureRegistry();
  return gap.requiredFeatures.flatMap(({ feature, values }) => {
    if (!Object.hasOwn(registry, feature)) return [];
    const allowedValues = values?.filter((value) => registry[feature]?.values?.includes(value));
    return [allowedValues?.length ? `${feature}${separator}${allowedValues.join(',')}` : feature];
  });
}

export function componentGapDescription(gap: ComponentUnmet, featureSeparator = '='): string {
  return [safeComponentIdentity(gap.componentId ?? gap.id), gap.kind,
    /^[A-Za-z][A-Za-z0-9._-]*$/u.test(gap.reasonCode) ? gap.reasonCode : 'unknown', ...componentGapFeatures(gap, featureSeparator)].join(' · ');
}

export const PI_AGENT_CONSUMER_NOTICE = 'piAgentConsumerUnavailable';
export const PREVIOUS_DEPLOYMENT_RETAINED = 'previousDeploymentRetained';
export const INVOCATION_POLICY_NOT_APPLIED = 'invocationPolicyNotApplied';
export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny', 'sandbox'] as const;
export type PermissionAction = typeof PERMISSION_ACTIONS[number];

export function safeSkippedPermissionActions(value: unknown): PermissionAction[] {
  return Array.isArray(value) ? PERMISSION_ACTIONS.filter((action) => value.includes(action)) : [];
}

export function isSkippedPermissionReason(reasonCode: string): boolean {
  return isDeliveryCapabilityGapReason(reasonCode) || ['not-offered', 'config-disabled', 'scope-excluded'].includes(reasonCode);
}

export function isDeliveryNoticeCode(code: string): boolean {
  return code === PI_AGENT_CONSUMER_NOTICE || code === PREVIOUS_DEPLOYMENT_RETAINED || code === INVOCATION_POLICY_NOT_APPLIED;
}

export function isInstallationAdvisory(code: string): boolean {
  return code === PI_AGENT_CONSUMER_NOTICE || code === INVOCATION_POLICY_NOT_APPLIED || code === SKILL_INVOCATION_NOTICE;
}

export function deliveryNoticeMessage(code: string, detail?: Diagnostic['detail'], field?: string): string {
  if (code === PREVIOUS_DEPLOYMENT_RETAINED) return 'Previous output was retained and may still be active. Inspect it before retrying.';
  if (code === INVOCATION_POLICY_NOT_APPLIED) {
    const actions = safeSkippedPermissionActions(detail?.skippedPermissionActions);
    const position = field ? ` for ${safeComponentIdentity(field)}` : '';
    return actions.length ? `Skipped invocation policy actions (${actions.join(', ')})${position}.`
      : `Some invocation policy actions were skipped${position}.`;
  }
  const reasonCode = detail?.reasonCode;
  if (reasonCode === 'piAgentPackageSourceUnsupported') {
    return 'Pi roles are installed. The detected pi-subagents version cannot read this Pi package source. Enable a compatible extension such as @tintinweb/pi-subagents and reload Pi.';
  }
  const action = reasonCode === 'piAgentConsumerDisabled' ? 'Enable a compatible role extension, then reload Pi.'
    : reasonCode === 'piAgentPackageAccessDenied' ? 'Review the extension’s access to this package, then reload Pi.'
      : reasonCode === 'piProjectTrustRequired' ? 'Review the project’s trust settings in Pi.'
        : 'Enable a compatible role extension, such as pi-subagents or @tintinweb/pi-subagents, then reload Pi.';
  const observation = reasonCode === 'piAgentConsumerMissing' ? 'No compatible role extension was detected.'
    : 'Pi has no confirmed active role executor for this package.';
  return `Pi roles are installed. ${observation} ${action}`;
}
