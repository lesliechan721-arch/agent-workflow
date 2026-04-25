import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { parseTOML } from 'toml-eslint-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { generateAgentArtifacts } from '../../src/generators/agents.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-plugin-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local-plugin generator', () => {
  it('generates Claude and Codex runtime manifests with explicit bundle-local paths', async () => {
    const repoRoot = await makeTempRepo();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const outputRoot = path.join(repoRoot, 'out', plugin.manifest.name);

    const result = await bundleLocalPlugin(plugin, outputRoot);

    expect(result.claudeManifest).toMatchObject({
      skills: './claude/skills',
      hooks: './claude/hooks/hooks.json',
      agents: ['./claude/agents/aw-git-commit-commit-reviewer.md'],
    });
    expect(result.codexManifest).toMatchObject({
      skills: './codex/skills',
    });

    await expect(
      fs.readFile(path.join(outputRoot, 'claude', 'agents', 'aw-git-commit-commit-reviewer.md'), 'utf8'),
    ).resolves.toContain('name: "commit-reviewer"');
    await expect(
      fs.pathExists(path.join(outputRoot, 'codex', 'skills', 'commit', 'SKILL.md')),
    ).resolves.toBe(true);
  });

  it('renders Claude agents with frontmatter and Codex agents as valid role-file TOML', () => {
    const [claudeArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'claude',
    );
    expect(claudeArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.md',
    });
    expect(claudeArtifact.content).toContain('name: "commit-reviewer"');
    expect(claudeArtifact.content).toContain('description:');
    expect(claudeArtifact.content).toContain('tools:');
    expect(claudeArtifact.content).toContain('请检查这次提交是否符合提交规范');

    const [codexArtifact] = generateAgentArtifacts(
      'git-commit',
      [
        {
          name: 'commit-reviewer',
          description: '检查提交范围和信息是否匹配。',
          prompt: '请检查这次提交是否符合提交规范，并指出 scope 是否准确。',
          tools: ['shell'],
        },
      ],
      'codex',
    );
    expect(codexArtifact).toMatchObject({
      relativePath: 'agents/aw-git-commit-commit-reviewer.toml',
    });
    const parsed = parseTOML(codexArtifact.content);
    const rendered = parsed.body[0];
    expect(rendered.type).toBe('TOMLTopLevelTable');
    expect(codexArtifact.content).toContain('name = "commit-reviewer"');
    expect(codexArtifact.content).toContain('description = "检查提交范围和信息是否匹配。');
    expect(codexArtifact.content).toContain('developer_instructions =');
    expect(codexArtifact.content).not.toContain('tools =');
  });
});
