import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PluginMeta } from '../../src/types.js';
import {
  materializeCodexProjectSkills,
  rollbackCodexProjectSkills,
} from '../../src/utils/native-skill-materialization.js';

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-skill-materialization-'));
  tempDirs.push(root);
  return root;
}

function makePlugin(rootDir: string): PluginMeta {
  return {
    rootDir,
    manifestPath: path.join(rootDir, '.agents-plugin', 'plugin.json'),
    manifest: {
      name: 'native-skill-test',
      version: '1.0.0',
      description: 'Native skill test plugin',
      compatibility: { aw: { minVersion: '0.0.0' } },
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('native Codex project skill materialization', () => {
  it('preserves source bytes and restores the previous skill tree on rollback', async () => {
    const root = await makeTempRoot();
    const pluginRoot = path.join(root, 'plugin');
    const repoRoot = path.join(root, 'repo');
    const sourceSkillRoot = path.join(pluginRoot, 'codex', 'skills', 'review');
    const targetSkillRoot = path.join(repoRoot, '.agents', 'skills', 'review');
    const sourceMetadata = [
      'interface:',
      '  display_name: "Review"',
      'policy:',
      '  allow_implicit_invocation: false',
      '',
    ].join('\n');
    const oldSkill = '# Existing skill\n';

    await fs.outputFile(path.join(sourceSkillRoot, 'SKILL.md'), '# Review\n');
    await fs.outputFile(path.join(sourceSkillRoot, 'agents', 'openai.yaml'), sourceMetadata);
    await fs.outputFile(path.join(sourceSkillRoot, 'assets', 'icon.bin'), Buffer.from([0, 255, 1]));
    await fs.outputFile(path.join(targetSkillRoot, 'SKILL.md'), oldSkill);

    const materialization = await materializeCodexProjectSkills({
      plugin: makePlugin(pluginRoot),
      repoRoot,
    });

    await expect(
      fs.readFile(path.join(targetSkillRoot, 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toBe(sourceMetadata);
    await expect(
      fs.readFile(path.join(targetSkillRoot, 'assets', 'icon.bin')),
    ).resolves.toEqual(Buffer.from([0, 255, 1]));

    await rollbackCodexProjectSkills(materialization);

    await expect(fs.readFile(path.join(targetSkillRoot, 'SKILL.md'), 'utf8')).resolves.toBe(oldSkill);
    await expect(fs.pathExists(path.join(targetSkillRoot, 'agents', 'openai.yaml'))).resolves.toBe(false);
  });

  it('rejects invalid native metadata before changing an existing target', async () => {
    const root = await makeTempRoot();
    const pluginRoot = path.join(root, 'plugin');
    const repoRoot = path.join(root, 'repo');
    const sourceSkillRoot = path.join(pluginRoot, 'codex', 'skills', 'review');
    const targetSkillRoot = path.join(repoRoot, '.agents', 'skills', 'review');
    const oldSkill = '# Existing skill\n';

    await fs.outputFile(path.join(sourceSkillRoot, 'SKILL.md'), '# Review\n');
    await fs.outputFile(
      path.join(sourceSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: "false"\n',
    );
    await fs.outputFile(path.join(targetSkillRoot, 'SKILL.md'), oldSkill);

    await expect(materializeCodexProjectSkills({
      plugin: makePlugin(pluginRoot),
      repoRoot,
    })).rejects.toThrow('policy.allow_implicit_invocation 必须是 boolean');

    await expect(fs.readFile(path.join(targetSkillRoot, 'SKILL.md'), 'utf8')).resolves.toBe(oldSkill);
    await expect(fs.pathExists(path.join(targetSkillRoot, 'agents', 'openai.yaml'))).resolves.toBe(false);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symbolic links in the bundled Skills root',
    async () => {
      const root = await makeTempRoot();
      const pluginRoot = path.join(root, 'plugin');
      const repoRoot = path.join(root, 'repo');
      const outsideSkill = path.join(root, 'outside-skill');
      const skillsRoot = path.join(pluginRoot, 'codex', 'skills');
      await fs.outputFile(path.join(outsideSkill, 'SKILL.md'), '# Linked\n');
      await fs.outputFile(
        path.join(outsideSkill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: "false"\n',
      );
      await fs.ensureDir(skillsRoot);
      await fs.symlink(outsideSkill, path.join(skillsRoot, 'linked'), 'dir');

      await expect(materializeCodexProjectSkills({
        plugin: makePlugin(pluginRoot),
        repoRoot,
      })).rejects.toThrow('Codex 项目 Skills 根目录不支持符号链接：linked');
    },
  );

  it('restores the original target when the staged replacement move fails', async () => {
    const root = await makeTempRoot();
    const pluginRoot = path.join(root, 'plugin');
    const repoRoot = path.join(root, 'repo');
    const sourceSkillRoot = path.join(pluginRoot, 'codex', 'skills', 'review');
    const targetSkillRoot = path.join(repoRoot, '.agents', 'skills', 'review');
    const oldSkill = '# Existing skill\n';

    await fs.outputFile(path.join(sourceSkillRoot, 'SKILL.md'), '# Review\n');
    await fs.outputFile(
      path.join(sourceSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );
    await fs.outputFile(path.join(targetSkillRoot, 'SKILL.md'), oldSkill);

    const actualMove = fs.move.bind(fs);
    vi.spyOn(fs, 'move').mockImplementation(async (source, destination, options) => {
      if (
        path.basename(String(source)).startsWith('.review-native-staging-') &&
        !String(source).endsWith('-backup') &&
        path.resolve(String(destination)) === path.resolve(targetSkillRoot)
      ) {
        throw new Error('injected replacement move failure');
      }
      return actualMove(source, destination, options);
    });

    await expect(materializeCodexProjectSkills({
      plugin: makePlugin(pluginRoot),
      repoRoot,
    })).rejects.toThrow('injected replacement move failure');

    await expect(fs.readFile(path.join(targetSkillRoot, 'SKILL.md'), 'utf8')).resolves.toBe(oldSkill);
  });

  it('continues restoring other skills when one rollback operation fails', async () => {
    const root = await makeTempRoot();
    const pluginRoot = path.join(root, 'plugin');
    const repoRoot = path.join(root, 'repo');
    const skillNames = ['first', 'second'];

    for (const skillName of skillNames) {
      const sourceSkillRoot = path.join(pluginRoot, 'codex', 'skills', skillName);
      await fs.outputFile(path.join(sourceSkillRoot, 'SKILL.md'), `# New ${skillName}\n`);
      await fs.outputFile(
        path.join(sourceSkillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: false\n',
      );
      await fs.outputFile(
        path.join(repoRoot, '.agents', 'skills', skillName, 'SKILL.md'),
        `# Old ${skillName}\n`,
      );
    }

    const materialization = await materializeCodexProjectSkills({
      plugin: makePlugin(pluginRoot),
      repoRoot,
    });
    const failedTarget = path.join(repoRoot, '.agents', 'skills', 'first');
    const actualRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (path.resolve(String(targetPath)) === path.resolve(failedTarget)) {
        throw new Error('injected rollback remove failure');
      }
      return actualRemove(targetPath);
    });

    await expect(rollbackCodexProjectSkills(materialization)).rejects.toThrow(
      'Codex 项目 Skill 回滚未完整完成',
    );

    await expect(
      fs.readFile(path.join(repoRoot, '.agents', 'skills', 'second', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Old second\n');
  });
});
