import type { CodexSkillArtifact, SkillTriggerPolicy, SkillTriggerPreference } from '../types.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  type DynamicSkillTree,
  renderCodexOpenAiYamlWithAllowImplicitInvocation,
} from './dynamic-skill-tree.js';

export type CodexSkillStagingTree = DynamicSkillTree;

function resolveEffectiveTriggerPreference(
  policy: SkillTriggerPolicy | undefined,
  preference: SkillTriggerPreference,
): Exclude<SkillTriggerPreference, 'default'> {
  const defaultTrigger = policy?.defaultTrigger ?? 'auto';
  if (preference === 'default' || policy?.allowDynamicTrigger === false) {
    return defaultTrigger;
  }
  return preference;
}

export function resolveDynamicCodexSkillAllowImplicitInvocation(options: {
  policy?: SkillTriggerPolicy;
  preference: SkillTriggerPreference;
}): boolean {
  return resolveEffectiveTriggerPreference(options.policy, options.preference) === 'auto';
}

export { renderCodexOpenAiYamlWithAllowImplicitInvocation };

export async function createCodexSkillExpectedTree(options: {
  artifact: Pick<CodexSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'>;
  sourceDirs?: string[];
  preference: SkillTriggerPreference;
  policy?: SkillTriggerPolicy;
}): Promise<CodexSkillStagingTree> {
  return createDynamicSkillExpectedTree(options);
}

export function createCodexSkillStagingTreeContentDigest(
  tree: CodexSkillStagingTree,
): string {
  return createDynamicSkillTreeContentDigest(tree);
}
