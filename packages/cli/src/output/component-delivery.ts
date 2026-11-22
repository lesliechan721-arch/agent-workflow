import { getPlatformFeatureRegistry, type ComponentUnmet } from '@lesliechan721/aw-plugin-core/manifest';
import type { RecoveryComponentGap, RecoveryTarget } from '../recovery/receipt.js';
import type { Diagnostic } from './public-result.js';
import { isDeliveryCapabilityGap, isDeliveryCapabilityGapReason } from '../utils/component-gap.js';
import { SKILL_INVOCATION_NOTICE } from '../utils/skill-invocation-warning.js';
import { redactString } from './redact.js';

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
export const HOST_PERMISSION_ADDITIONAL_IMPACT = 'hostPermissionAdditionalImpact';
export const GROK_ADDITIONAL_RULES_UNVERIFIED = 'grok-additional-rules-unverified';
export const COMMAND_ROUTE_UNREACHABLE = 'command-route-unreachable';
export const GROK_ARGUMENT_BOUNDARIES_UNAVAILABLE = 'grok-argument-boundaries-unavailable';
export const GROK_WRAPPER_TARGET_NOT_COVERED = 'grok-wrapper-target-not-covered';
export const PERMISSION_ACTIONS = ['allow', 'ask', 'deny', 'sandbox'] as const;
export type PermissionAction = typeof PERMISSION_ACTIONS[number];

export function safeSkippedPermissionActions(value: unknown): PermissionAction[] {
  return Array.isArray(value) ? PERMISSION_ACTIONS.filter((action) => value.includes(action)) : [];
}

export function isSkippedPermissionReason(reasonCode: string): boolean {
  return isDeliveryCapabilityGapReason(reasonCode) || ['not-offered', 'config-disabled', 'scope-excluded', 'permission-prefix-unrepresentable', 'permission-rule-conflict', 'permission-config-path-unconfirmed',
    'opencode-windows-command-syntax', 'grok-project-trust-required', 'grok-shell-pattern-unrepresentable', 'grok-shell-prefix-normalized',
    'antigravity-cli-global-only', 'antigravity-windows-command-syntax', 'antigravity-config-path-unconfirmed', 'antigravity-command-matching-unverified', 'antigravity-strict-mode',
    COMMAND_ROUTE_UNREACHABLE, GROK_ARGUMENT_BOUNDARIES_UNAVAILABLE, GROK_WRAPPER_TARGET_NOT_COVERED].includes(reasonCode);
}

export function isDeliveryNoticeCode(code: string): boolean {
  return code === PI_AGENT_CONSUMER_NOTICE || code === PREVIOUS_DEPLOYMENT_RETAINED
    || code === INVOCATION_POLICY_NOT_APPLIED || code === HOST_PERMISSION_ADDITIONAL_IMPACT;
}

export function isInstallationAdvisory(code: string): boolean {
  return code === PI_AGENT_CONSUMER_NOTICE || code === INVOCATION_POLICY_NOT_APPLIED
    || code === HOST_PERMISSION_ADDITIONAL_IMPACT || code === SKILL_INVOCATION_NOTICE;
}

export function hostPermissionImpactMessage(message?: string): string {
  return (message && redactString(message.replace(/[\p{C}]/gu, ' ')).trim()) || 'The configured permission can also affect other commands.';
}

export function publicHostPermissionResource(resource: string): string {
  return redactString(resource.replace(/[\p{C}]/gu, ''));
}

export function deliveryNoticeMessage(code: string, detail?: Diagnostic['detail'], field?: string): string {
  if (code === HOST_PERMISSION_ADDITIONAL_IMPACT) return hostPermissionImpactMessage();
  if (code === PREVIOUS_DEPLOYMENT_RETAINED) return 'Previous output was retained and may still be active. Inspect it before retrying.';
  if (code === INVOCATION_POLICY_NOT_APPLIED) {
    const actions = safeSkippedPermissionActions(detail?.skippedPermissionActions);
    const position = field ? ` for ${safeComponentIdentity(field)}` : '';
    if (detail?.reasonCode === COMMAND_ROUTE_UNREACHABLE && actions.length) {
      return `Skipped invocation policy actions (${actions.join(', ')})${position} because a matching command route is unavailable.`;
    }
    if (detail?.reasonCode === 'permission-rule-conflict') return detail.path
      ? `OpenCode Project rules may still relax invocation policy actions (${actions.join(', ')})${position}. Review the Project settings.`
      : `Invocation policy actions (${actions.join(', ')})${position} could not be fully applied because of overlapping permission rules.`;
    if (detail?.reasonCode === 'permission-config-path-unconfirmed') return `Skipped invocation policy actions (${actions.join(', ')})${position}. Set an absolute OPENCODE_CONFIG_DIR to identify the host configuration.`;
    if (detail?.reasonCode === 'opencode-windows-command-syntax') return `Skipped invocation policy actions (${actions.join(', ')})${position} because their prefix has special syntax in PowerShell or cmd.exe.`;
    if (detail?.reasonCode === 'grok-project-trust-required') return `Skipped invocation policy actions (${actions.join(', ')})${position}. Review this project's trust in Grok and sync again.`;
    if (detail?.reasonCode === 'grok-shell-pattern-unrepresentable') return `Skipped invocation policy actions (${actions.join(', ')})${position} because the prefix contains characters Grok cannot use as a shell pattern.`;
    if (detail?.reasonCode === 'grok-shell-prefix-normalized') return `Skipped invocation policy actions (${actions.join(', ')})${position} because Grok cannot determine the inner command to allow.`;
    if (detail?.reasonCode === GROK_WRAPPER_TARGET_NOT_COVERED) {
      return `Invocation policy actions (${actions.join(', ')})${position} cover only the wrapper without an inner command. `
        + 'Grok checks the inner command separately if additional arguments name one.';
    }
    if (detail?.reasonCode === 'antigravity-config-path-unconfirmed') return `Skipped invocation policy actions (${actions.join(', ')})${position}. The Antigravity CLI Global settings path could not be identified.`;
    if (detail?.reasonCode === 'antigravity-windows-command-syntax') return `Skipped invocation policy actions (${actions.join(', ')})${position} because Windows shell processing may change the command words.`;
    if (detail?.reasonCode === 'antigravity-cli-global-only') return `Skipped invocation policy actions (${actions.join(', ')})${position}. Antigravity command permissions require the CLI Global settings.`;
    if (detail?.reasonCode === 'antigravity-command-matching-unverified') return `Skipped invocation policy actions (${actions.join(', ')})${position} because equivalent command-prefix decisions in Antigravity CLI remain unverified.`;
    if (detail?.reasonCode === 'antigravity-strict-mode') return `Skipped invocation policy actions (${actions.join(', ')})${position} because Antigravity CLI is configured for strict tool review.`;
    if (detail?.reasonCode === 'permission-prefix-unrepresentable') return `Skipped invocation policy actions (${actions.join(', ')})${position} because AW could not verify an exact command-prefix match on this host.`;
    if (detail?.reasonCode === GROK_ARGUMENT_BOUNDARIES_UNAVAILABLE) {
      return `Skipped invocation policy actions (${actions.join(', ')})${position}. `
        + 'Grok Build joins command arguments into one string, so a space inside an argument looks like a space between arguments.';
    }
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
