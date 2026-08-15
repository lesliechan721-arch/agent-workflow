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

describe('author Skill layout', () => {
  it('exposes the current author Skills through valid Claude links', async () => {
    const entries = [
      ['create-aw-plugin', '../../.agents/skills/create-aw-plugin'],
      ['skill-review', '../../.agents/skills/skill-review'],
    ];

    for (const [name, target] of entries) {
      const sourceRoot = path.join(repoRoot, '.agents', 'skills', name);
      const claudeLink = path.join(repoRoot, '.claude', 'skills', name);
      expect((await fs.lstat(claudeLink)).isSymbolicLink()).toBe(true);
      await expect(fs.readlink(claudeLink)).resolves.toBe(target);
      await expect(fs.pathExists(sourceRoot)).resolves.toBe(true);
      await expect(fs.pathExists(claudeLink)).resolves.toBe(true);
    }

    await expect(fs.readdir(path.join(repoRoot, '.claude', 'skills')))
      .resolves.not.toContain('create-agent-workflows-plugin');
  });
});
