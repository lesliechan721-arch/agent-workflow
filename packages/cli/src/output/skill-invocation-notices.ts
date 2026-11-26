import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';
import { getPlatformFeatureRegistry, isSkillInvocationFeature } from '@lesliechan721/aw-plugin-core/manifest';
import type { RecoveryDiagnostic, RecoveryTarget } from '../recovery/receipt.js';
import type { PlatformTarget, Scope } from '../types.js';
import { parsePluginId } from '../utils/multi-source-catalog.js';
import { describeSkillInvocationControl, SKILL_INVOCATION_NOTICE, type SkillInvocationControl, type SkillInvocationNoticeReason } from '../utils/skill-invocation-warning.js';
import { safePublicMessage, type Diagnostic } from './public-result.js';

interface SkillInvocationNotice {
  pluginId: string;
  platform: PlatformTarget;
  scope: Scope;
  skill: string;
  reasonCode: SkillInvocationNoticeReason;
  controls: SkillInvocationControl[];
  message: string;
}

function isNoticeReason(reason: string | undefined): reason is SkillInvocationNoticeReason {
  return reason === 'noBoundExecutor' || reason === 'invocationControlUnsupported'
    || reason === 'invocationControlDegraded';
}

export function skillInvocationProductLabel(product: NonNullable<SkillInvocationControl['product']>): string {
  return `Antigravity ${product === 'cli' ? 'CLI' : 'App'}`;
}

function safeControls(controls: readonly SkillInvocationControl[] | undefined, platform: PlatformTarget): SkillInvocationControl[] {
  if (!Array.isArray(controls)) return [];
  return controls.flatMap(({ feature, values, reasonCode, product }: SkillInvocationControl) => {
    if (!isSkillInvocationFeature(feature) || !isNoticeReason(reasonCode)) return [];
    const antigravity = platform === 'antigravity';
    if (antigravity && ((reasonCode !== 'invocationControlUnsupported' && reasonCode !== 'invocationControlDegraded')
      || (product !== 'app' && product !== 'cli'))) return [];
    const allowed = getPlatformFeatureRegistry()[feature]?.values;
    if (values !== undefined && (!Array.isArray(values) || !values.every((value) => allowed?.includes(value)))) return [];
    return [{ feature, ...(values ? { values: [...values] } : {}), reasonCode,
      ...(antigravity ? { product } : {}) }];
  });
}

export function skillInvocationNotices(diagnostics: readonly RecoveryDiagnostic[]): SkillInvocationNotice[] {
  const notices = new Map<string, SkillInvocationNotice>();
  for (const { code, subject, detail, message } of diagnostics) {
    if (code !== SKILL_INVOCATION_NOTICE) continue;
    // A dependency's delivery may be attached to a requesting root's result.
    const { pluginId, target: platform, scope, field } = subject ?? {};
    const reasonCode = detail?.reasonCode;
    const skill = field?.match(/^skill\.([a-z0-9]+(?:-[a-z0-9]+)*)$/u)?.[1];
    if (!pluginId || !isPlatformTarget(platform) || (scope !== 'user' && scope !== 'project') || !skill || !isNoticeReason(reasonCode)) continue;
    try { parsePluginId(pluginId); } catch { continue; }
    const key = JSON.stringify([pluginId, platform, scope, skill]);
    const controls = safeControls(detail?.skillInvocationControls, platform);
    const previous = notices.get(key);
    if (platform === 'antigravity') {
      if (!controls.length) continue;
      const combined = [...new Map([...(previous?.controls ?? []), ...controls].map((control) => [JSON.stringify(control), control])).values()];
      const degraded = combined.some((control) => control.reasonCode === 'invocationControlDegraded');
      const explanations = combined.map((control) => {
        const reader = skillInvocationProductLabel(control.product!);
        const requirement = describeSkillInvocationControl(control);
        return control.reasonCode === 'invocationControlDegraded'
          ? `${reader} did not enforce ${requirement}.` : `${reader} does not support ${requirement}.`;
      });
      notices.set(key, { pluginId, platform, scope, skill, controls: combined,
        reasonCode: degraded ? 'invocationControlDegraded' : 'invocationControlUnsupported',
        message: `Installed Skill "${skill}". ${explanations.join(' ')}` });
      continue;
    }
    if (!previous || (!previous.controls.length && controls.length)) {
      notices.set(key, { pluginId, platform, scope, skill, reasonCode, controls, message: safePublicMessage(message, code) });
    }
  }
  return [...notices.values()];
}

export function skillInvocationDiagnostics(targets: readonly RecoveryTarget[]): Diagnostic[] {
  return projectSkillInvocationDiagnostics(targets.flatMap(({ reasons, deploymentReceipts }) => [
    ...(reasons ?? []), ...(deploymentReceipts ?? []).flatMap(({ diagnostics, effects }) =>
      [...diagnostics, ...effects.flatMap((effect) => effect.diagnostics)]),
  ]));
}

export function projectSkillInvocationDiagnostics(diagnostics: readonly RecoveryDiagnostic[]): Diagnostic[] {
  return skillInvocationNotices(diagnostics).map(({ pluginId, platform, scope, skill, reasonCode, controls, message }) => ({
    code: SKILL_INVOCATION_NOTICE, severity: 'warning', message,
    subject: { pluginId, target: platform, scope, field: `skill.${skill}` },
    detail: { reasonCode, ...(controls.length ? { skillInvocationControls: controls } : {}) },
  }));
}
