import type { CodexSkillArtifact } from '../types.js';
import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  type DynamicSkillTree,
} from './dynamic-skill-tree.js';

export type CodexSkillStagingTree = DynamicSkillTree;

export async function createCodexSkillExpectedTree(options: {
  artifact: Pick<CodexSkillArtifact, 'target' | 'skillKey' | 'state' | 'content'>;
  sourceDirs?: string[];
}): Promise<CodexSkillStagingTree> {
  return createDynamicSkillExpectedTree(options);
}

export function createCodexSkillStagingTreeContentDigest(
  tree: CodexSkillStagingTree,
): string {
  return createDynamicSkillTreeContentDigest(tree);
}
