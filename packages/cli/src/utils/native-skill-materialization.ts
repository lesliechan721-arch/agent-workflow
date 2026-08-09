import path from 'node:path';

import fs from 'fs-extra';

import type { GeneratedArtifact, PluginMeta } from '../types.js';
import {
  createCodexSkillExpectedTree,
  type CodexSkillStagingTree,
} from './codex-skill-staging.js';
import {
  assertOwnedSkillPath,
  createSkillOwnerMarkerContent,
  SKILL_OWNER_MARKER,
  type OwnerIdentity,
} from './ownership.js';

interface CodexProjectSkillOperation {
  targetRoot: string;
  backupRoot: string | null;
}

export interface CodexProjectSkillMaterialization {
  active: boolean;
  artifacts: GeneratedArtifact[];
  operations: CodexProjectSkillOperation[];
}

async function collectBundledCodexSkillTrees(
  plugin: PluginMeta,
): Promise<CodexSkillStagingTree[]> {
  const skillsRoot = path.join(plugin.rootDir, 'codex', 'skills');
  if (!(await fs.pathExists(skillsRoot))) {
    return [];
  }

  const dynamicSkillKeys = new Set(
    (plugin.manifest.artifacts?.targets ?? []).flatMap((target) =>
      target.target === 'codex.skill' && target.skillKey ? [target.skillKey] : []),
  );
  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  const trees: CodexSkillStagingTree[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    if (entry.isSymbolicLink()) {
      throw new Error(`Codex 项目 Skills 根目录不支持符号链接：${entry.name}`);
    }
    if (!entry.isDirectory()) {
      continue;
    }
    if (dynamicSkillKeys.has(entry.name)) {
      continue;
    }
    const skillRoot = path.join(skillsRoot, entry.name);
    if (!(await fs.pathExists(path.join(skillRoot, 'SKILL.md')))) {
      continue;
    }
    trees.push(await createCodexSkillExpectedTree({
      artifact: {
        target: 'codex.skill',
        skillKey: entry.name,
        state: 'present',
        content: { files: {} },
      },
      sourceDirs: [skillRoot],
    }));
  }
  return trees;
}

function createCodexProjectSkillArtifact(
  repoRoot: string,
  tree: CodexSkillStagingTree,
): GeneratedArtifact {
  return {
    path: path.join(repoRoot, '.agents', 'skills', tree.skillKey),
    kind: 'skill',
    platform: 'codex',
    artifactKey: tree.skillKey,
  };
}

export async function collectBundledCodexProjectSkillArtifacts(options: {
  plugin: PluginMeta;
  repoRoot: string;
}): Promise<GeneratedArtifact[]> {
  return (await collectBundledCodexSkillTrees(options.plugin))
    .map((tree) => createCodexProjectSkillArtifact(options.repoRoot, tree));
}

async function stageSkillTree(
  targetRoot: string,
  tree: CodexSkillStagingTree,
  operations: CodexProjectSkillOperation[],
  ownership: { allowedRoot: string; identity: OwnerIdentity },
): Promise<void> {
  await assertOwnedSkillPath({
    skillRoot: targetRoot,
    allowedRoot: ownership.allowedRoot,
    identity: ownership.identity,
  });
  const targetParent = path.dirname(targetRoot);
  await fs.ensureDir(targetParent);
  const stagingRoot = await fs.mkdtemp(
    path.join(targetParent, `.${path.basename(targetRoot)}-native-staging-`),
  );
  const backupRoot = `${stagingRoot}-backup`;
  const targetExists = await fs.pathExists(targetRoot);

  try {
    for (const [relativePath, content] of Object.entries(tree.files)) {
      await fs.outputFile(
        path.join(stagingRoot, relativePath.split('/').join(path.sep)),
        content,
      );
    }
    await fs.writeFile(
      path.join(stagingRoot, SKILL_OWNER_MARKER),
      createSkillOwnerMarkerContent(ownership.identity),
      'utf8',
    );
    if (targetExists) {
      await fs.move(targetRoot, backupRoot, { overwrite: false });
    }
    operations.push({
      targetRoot,
      backupRoot: targetExists ? backupRoot : null,
    });
    await fs.move(stagingRoot, targetRoot, { overwrite: false });
  } catch (error) {
    try {
      await fs.remove(stagingRoot);
    } catch (cleanupError) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error(String(error)),
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        ],
        `Codex 项目 Skill staging 失败，且临时目录清理失败：${stagingRoot}`,
      );
    }
    throw error;
  }
}

export async function materializeCodexProjectSkills(options: {
  plugin: PluginMeta;
  repoRoot: string;
}): Promise<CodexProjectSkillMaterialization> {
  const materialization: CodexProjectSkillMaterialization = {
    active: false,
    artifacts: [],
    operations: [],
  };

  try {
    for (const tree of await collectBundledCodexSkillTrees(options.plugin)) {
      const artifact = createCodexProjectSkillArtifact(options.repoRoot, tree);
      const targetRoot = artifact.path;
      await stageSkillTree(targetRoot, tree, materialization.operations, {
        allowedRoot: path.dirname(targetRoot),
        identity: {
          owner: 'agent-workflows',
          plugin: options.plugin.manifest.name,
          artifactKey: tree.skillKey,
          platform: 'codex',
          scope: 'project',
        },
      });
      materialization.artifacts.push(artifact);
    }
    materialization.active = materialization.operations.length > 0;
    return materialization;
  } catch (error) {
    try {
      await rollbackCodexProjectSkills(materialization);
    } catch (rollbackError) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error(String(error)),
          rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)),
        ],
        'Codex 项目 Skill materialization 失败，且回滚未完整完成。',
      );
    }
    throw error;
  }
}

export async function rollbackCodexProjectSkills(
  materialization: CodexProjectSkillMaterialization,
): Promise<void> {
  const failures: Error[] = [];
  for (const operation of [...materialization.operations].reverse()) {
    try {
      await fs.remove(operation.targetRoot);
    } catch (error) {
      failures.push(new Error(
        `无法清理 Codex 项目 Skill 目标 ${operation.targetRoot}：${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    if (operation.backupRoot) {
      try {
        await fs.move(operation.backupRoot, operation.targetRoot, { overwrite: false });
      } catch (error) {
        failures.push(new Error(
          `无法从备份恢复 Codex 项目 Skill ${operation.targetRoot}；备份保留在 ${operation.backupRoot}：${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
  materialization.active = false;
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Codex 项目 Skill 回滚未完整完成。');
  }
}

export async function commitCodexProjectSkills(
  materialization: CodexProjectSkillMaterialization,
): Promise<void> {
  const failures: Error[] = [];
  for (const operation of materialization.operations) {
    if (operation.backupRoot) {
      try {
        await fs.remove(operation.backupRoot);
      } catch (error) {
        failures.push(new Error(
          `无法清理 Codex 项目 Skill 备份 ${operation.backupRoot}：${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }
  materialization.active = false;
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Codex 项目 Skill 备份清理未完整完成。');
  }
}
