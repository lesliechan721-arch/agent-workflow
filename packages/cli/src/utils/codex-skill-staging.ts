import {
  createDynamicSkillExpectedTree,
  createDynamicSkillTreeContentDigest,
  type DynamicSkillTree,
} from './dynamic-skill-tree.js';

export type CodexSkillStagingTree = DynamicSkillTree;

export async function createCodexSkillExpectedTree(options: {
  artifact: Parameters<typeof createDynamicSkillExpectedTree>[0]['artifact'] & { target: 'codex.skill' };
  sourceDirs?: string[];
  requireReadme?: boolean;
  requirementsReceipt?: Buffer;
  sourceRequirementsReceiptPolicy?: 'reject' | 'allow' | 'ignore';
}): Promise<CodexSkillStagingTree> {
  return createDynamicSkillExpectedTree(options);
}

export function createCodexSkillStagingTreeContentDigest(
  tree: CodexSkillStagingTree,
): string {
  return createDynamicSkillTreeContentDigest(tree);
}
