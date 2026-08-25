import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

describe('repository Claude Skill layout', () => {
  it('keeps legacy Skills manual-only and leaves new plugin Skills for aw CLI installation', async () => {
    const compatibilityEntries = [
      ['create-aw-plugin', '../../.agents/skills/create-aw-plugin'],
      ['skill-review', '../../.agents/skills/skill-review'],
    ];

    for (const [name, target] of compatibilityEntries) {
      const sourceRoot = path.resolve(repoRoot, '.claude', 'skills', target);
      const claudeLink = path.join(repoRoot, '.claude', 'skills', name);
      expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(claudeLink)).resolves.toBe(target);
      await expect(fs.pathExists(sourceRoot)).resolves.toBe(true);
      await expect(fs.pathExists(claudeLink)).resolves.toBe(true);
    }

    const cliInstalledPluginSkills = [
      'author-agent-skill',
      'review-agent-skill',
      'review-agent-workflow',
      'author-aw-plugin',
      'review-aw-plugin',
      'review-aw-workflow',
    ];

    for (const name of cliInstalledPluginSkills) {
      await expect(fs.pathExists(path.join(repoRoot, '.claude', 'skills', name)))
        .resolves.toBe(false);
    }

    for (const [name, target] of compatibilityEntries) {
      const skill = await fs.readFile(
        path.resolve(repoRoot, '.claude', 'skills', target, 'SKILL.md'),
        'utf8',
      );
      // Static contract exception: Claude reads these frontmatter fields to control model and user invocation; behavior test is not suitable because the host controls skill routing outside this repository.
      expect(skill).toContain('user-invocable: true');
      expect(skill).toContain('disable-model-invocation: true');

      const metadata = await fs.readFile(
        path.join(repoRoot, '.agents', 'skills', name, 'agents', 'openai.yaml'),
        'utf8',
      );
      // Static contract exception: Codex reads this policy to control implicit invocation; behavior test is not suitable because the host controls skill routing outside this repository.
      expect(metadata).toContain('allow_implicit_invocation: false');
    }
  });
});
