import { isPlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { RecoveryTarget } from '../recovery/receipt.js';
import type { PlatformTarget, Scope } from '../types.js';
import { SKILL_INVOCATION_NOTICE, type SkillInvocationNoticeReason } from '../utils/skill-invocation-warning.js';

interface SkillInvocationNotice {
  pluginId: string;
  platform: PlatformTarget;
  scope: Scope;
  skill: string;
  reasonCode: SkillInvocationNoticeReason;
  message: string;
}

export function skillInvocationNotices(targets: readonly RecoveryTarget[]): SkillInvocationNotice[] {
  const notices = new Map<string, SkillInvocationNotice>();
  for (const target of targets) {
    for (const { code, subject, detail, message } of target.reasons ?? []) {
      if (code !== SKILL_INVOCATION_NOTICE) continue;
      // Shared output may be attached to a requesting root. Keep its actual position.
      const { pluginId, target: platform, scope, field } = subject ?? {};
      const reasonCode = detail?.reasonCode;
      const skill = field?.match(/^skill\.([a-z0-9]+(?:-[a-z0-9]+)*)$/u)?.[1];
      if (!pluginId || !platform || !isPlatformTarget(platform) || !scope || !skill
        || (reasonCode !== 'noBoundExecutor' && reasonCode !== 'invocationControlUnsupported'
          && reasonCode !== 'invocationControlUnverified')) continue;
      const key = JSON.stringify([pluginId, platform, scope, skill]);
      if (!notices.has(key)) notices.set(key, { pluginId, platform, scope, skill, reasonCode, message });
    }
  }
  return [...notices.values()];
}
