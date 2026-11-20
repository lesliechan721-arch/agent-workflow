import {
  getPlatformCapabilityFact, getUnmetFeatureRequirements, isSkillInvocationFeature,
  type FeatureRequirement, type PlatformCapabilitiesV2, type PlatformId, type Scope,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic } from '../output/public-result.js';

export const SKILL_INVOCATION_NOTICE = 'skillInvocationPolicyNotGuaranteed';
export type SkillInvocationNoticeReason = 'noBoundExecutor' | 'invocationControlUnverified' | 'invocationControlUnsupported';

/** One notice per delivered Skill, with only the controls this target cannot guarantee. */
export function skillInvocationWarning(skill: string, requirements: FeatureRequirement[],
  position: { pluginId: string; target: PlatformId; scope: Scope }, capabilities?: PlatformCapabilitiesV2): Diagnostic | undefined {
  const requested = requirements.filter(({ feature }) => isSkillInvocationFeature(feature));
  const missing = capabilities ? getUnmetFeatureRequirements(requested, capabilities) : requested;
  if (!missing.length) return;
  const controls = (items: FeatureRequirement[]) => items.map(({ feature, values }) =>
    values?.length ? `${feature}=${values.join(',')}` : feature).join(', ');
  let reasonCode: SkillInvocationNoticeReason;
  let explanation: string;
  if (!capabilities) {
    reasonCode = 'noBoundExecutor';
    explanation = `The generic directory has no bound host to enforce ${controls(missing)}.`;
  } else {
    const unsupported = missing.filter(({ feature }) => getPlatformCapabilityFact(feature, capabilities).status === 'unsupported');
    const unverified = missing.filter((requirement) => !unsupported.includes(requirement));
    reasonCode = unverified.length ? 'invocationControlUnverified' : 'invocationControlUnsupported';
    explanation = [
      unsupported.length ? `This host does not support ${controls(unsupported)}.` : '',
      unverified.length ? `AW has not verified ${controls(unverified)} for this host.` : '',
    ].filter(Boolean).join(' ');
  }
  return { code: SKILL_INVOCATION_NOTICE, severity: 'warning',
    subject: { ...position, field: `skill.${skill}` }, detail: { reasonCode },
    message: `Installed Skill "${skill}". ${explanation}` };
}
