import {
  getPlatformCapabilityFact, getUnmetFeatureRequirements, isSkillInvocationFeature,
  type FeatureRequirement, type PlatformCapabilitiesV2, type PlatformId, type Scope,
} from '@lesliechan721/aw-plugin-core/manifest';
import type { Diagnostic } from '../output/public-result.js';

export const SKILL_INVOCATION_NOTICE = 'skillInvocationPolicyNotGuaranteed';
export type SkillInvocationNoticeReason = 'noBoundExecutor' | 'invocationControlUnverified' | 'invocationControlUnsupported' | 'invocationControlDegraded';
export type SkillInvocationControl = FeatureRequirement & { reasonCode: SkillInvocationNoticeReason; product?: 'cli' | 'app' };
export interface AntigravitySkillInvocationReader {
  product: 'cli' | 'app';
  unsupported: readonly FeatureRequirement[];
  observed?: readonly FeatureRequirement[];
}

export function describeSkillInvocationControl({ feature, values }: FeatureRequirement): string {
  return values?.length ? `${feature}=${values.join(',')}` : feature;
}

/** One notice per delivered Skill, with only the controls this target cannot guarantee. */
export function skillInvocationWarning(skill: string, requirements: FeatureRequirement[],
  position: { pluginId: string; target: PlatformId; scope: Scope }, capabilities?: PlatformCapabilitiesV2,
  codexCliCapabilities?: PlatformCapabilitiesV2, antigravityReaders: readonly AntigravitySkillInvocationReader[] = []): Diagnostic | undefined {
  const requested = requirements.filter(({ feature }) => isSkillInvocationFeature(feature));
  if (position.target === 'antigravity') {
    const controls = antigravityReaders.flatMap(({ product, unsupported, observed }) => requested.flatMap((requirement): SkillInvocationControl[] => {
      const actual = observed?.find(({ feature }) => feature === requirement.feature)?.values;
      const degraded = actual?.length ? requirement.values?.filter((value) => !actual.includes(value)) : undefined;
      if (degraded?.length) return [{ feature: requirement.feature, values: degraded, reasonCode: 'invocationControlDegraded', product }];
      const limit = unsupported.find(({ feature }) => feature === requirement.feature);
      if (!limit) return [];
      const values = requirement.values?.filter((value) => !actual?.includes(value) && (!limit.values || limit.values.includes(value)));
      return values?.length || !requirement.values && !limit.values
        ? [{ feature: requirement.feature, ...(values ? { values } : {}), reasonCode: 'invocationControlUnsupported', product }] : [];
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
  const missing = capabilities ? getUnmetFeatureRequirements(requested, capabilities) : requested;
  if (!missing.length) return;
  const controls = missing.map((requirement): SkillInvocationControl => {
    const reasonCode = !capabilities ? 'noBoundExecutor'
      : getPlatformCapabilityFact(requirement.feature, capabilities).status === 'unsupported'
        ? 'invocationControlUnsupported' : 'invocationControlUnverified';
    const appOnly = reasonCode === 'invocationControlUnverified' && codexCliCapabilities
      && !getUnmetFeatureRequirements([requirement], codexCliCapabilities).length;
    return { ...requirement, reasonCode, ...(appOnly ? { product: 'app' } : {}) };
  });
  const describe = (items: FeatureRequirement[]) => items.map(describeSkillInvocationControl).join(', ');
  let reasonCode: SkillInvocationNoticeReason;
  let explanation: string;
  if (!capabilities) {
    reasonCode = 'noBoundExecutor';
    explanation = `The generic directory has no bound host to enforce ${describe(controls)}.`;
  } else {
    const unsupported = controls.filter(({ reasonCode }) => reasonCode === 'invocationControlUnsupported');
    const unverified = controls.filter(({ reasonCode, product }) => reasonCode === 'invocationControlUnverified' && !product);
    const desktop = controls.filter(({ product }) => product === 'app');
    reasonCode = unverified.length || desktop.length ? 'invocationControlUnverified' : 'invocationControlUnsupported';
    explanation = [
      unsupported.length ? `This host does not support ${describe(unsupported)}.` : '',
      unverified.length ? `AW has not verified ${describe(unverified)} for this host.` : '',
      desktop.length ? `AW has not verified ${describe(desktop)} for the Codex desktop app.` : '',
    ].filter(Boolean).join(' ');
  }
  return { code: SKILL_INVOCATION_NOTICE, severity: 'warning',
    subject: { ...position, field: `skill.${skill}` }, detail: { reasonCode, skillInvocationControls: controls },
    message: `Installed Skill "${skill}". ${explanation}` };
}
