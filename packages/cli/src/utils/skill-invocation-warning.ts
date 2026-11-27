import {
  getUnmetFeatureRequirements, isSkillInvocationFeature,
  type FeatureRequirement, type PlatformCapabilitiesV3, type PlatformId, type Scope,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic } from '../output/public-result.js';

export const SKILL_INVOCATION_NOTICE = 'skillInvocationPolicyNotGuaranteed';
export type SkillInvocationNoticeReason = 'noBoundExecutor' | 'invocationControlUnsupported' | 'invocationControlDegraded';
export type SkillInvocationControl = FeatureRequirement & { reasonCode: SkillInvocationNoticeReason; product?: 'cli' | 'app' };
export interface AntigravitySkillInvocationReader {
  product: 'cli' | 'app';
  observed?: readonly FeatureRequirement[];
}

export function describeSkillInvocationControl({ feature, values }: FeatureRequirement): string {
  return values?.length ? `${feature}=${values.join(',')}` : feature;
}

/** One notice per delivered Skill, with only the controls this target cannot guarantee. */
export function skillInvocationWarning(skill: string, requirements: FeatureRequirement[],
  position: { pluginId: string; target: PlatformId; scope: Scope }, capabilities?: PlatformCapabilitiesV3,
  antigravityReaders: readonly AntigravitySkillInvocationReader[] = []): Diagnostic | undefined {
  const requested = requirements.filter(({ feature }) => isSkillInvocationFeature(feature));
  const missing = capabilities ? getUnmetFeatureRequirements(requested, capabilities) : requested;
  if (position.target === 'antigravity') {
    const controls = antigravityReaders.flatMap(({ product, observed }) => requested.flatMap((requirement): SkillInvocationControl[] => {
      const actual = observed?.find(({ feature }) => feature === requirement.feature)?.values;
      const degraded = actual?.length ? requirement.values?.filter((value) => !actual.includes(value)) : undefined;
      if (degraded?.length) return [{ feature: requirement.feature, values: degraded, reasonCode: 'invocationControlDegraded', product }];
      const limit = missing.find(({ feature }) => feature === requirement.feature);
      return limit ? [{ ...limit, reasonCode: 'invocationControlUnsupported', product }] : [];
    }));
    if (!controls.length) return;
    const reasonCode = controls.some((control) => control.reasonCode === 'invocationControlDegraded')
      ? 'invocationControlDegraded' : 'invocationControlUnsupported';
    const explanation = controls.map(({ reasonCode: reason, product, ...control }) => {
      const client = product === 'cli' ? 'Antigravity CLI' : 'Antigravity App';
      const description = describeSkillInvocationControl(control);
      return reason === 'invocationControlDegraded' ? `${client} reported a policy that differs from ${description}.`
        : `${client} does not support ${description}.`;
    }).join(' ');
    return { code: SKILL_INVOCATION_NOTICE, severity: 'warning', subject: { ...position, field: `skill.${skill}` },
      detail: { reasonCode, skillInvocationControls: controls }, message: `Installed Skill "${skill}". ${explanation}` };
  }
  if (!missing.length) return;
  const reasonCode = capabilities ? 'invocationControlUnsupported' : 'noBoundExecutor';
  const controls = missing.map((requirement): SkillInvocationControl => ({ ...requirement, reasonCode }));
  const description = controls.map(describeSkillInvocationControl).join(', ');
  const explanation = capabilities ? `This host does not support ${description}.`
    : `The generic directory has no bound host to enforce ${description}.`;
  return { code: SKILL_INVOCATION_NOTICE, severity: 'warning',
    subject: { ...position, field: `skill.${skill}` }, detail: { reasonCode, skillInvocationControls: controls },
    message: `Installed Skill "${skill}". ${explanation}` };
}
