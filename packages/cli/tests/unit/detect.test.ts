import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { detectEnvironment } from '../../src/utils/detect.js';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{
  repoRoot: string;
  claudeHome: string;
  codexHome: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-detect-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  const claudeHome = path.join(root, 'claude-home');
  const codexHome = path.join(root, 'codex-home');

  await fs.ensureDir(path.join(repoRoot, '.claude'));
  await fs.ensureDir(path.join(repoRoot, '.codex'));
  await fs.ensureDir(claudeHome);
  await fs.ensureDir(codexHome);

  return { repoRoot, claudeHome, codexHome };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('detect utils', () => {
  it('reports available scopes for Claude and Codex independently', async () => {
    const { repoRoot, claudeHome, codexHome } = await makeWorkspace();

    await fs.writeJson(path.join(repoRoot, '.claude', 'settings.json'), { team: true }, { spaces: 2 });
    await fs.writeFile(path.join(codexHome, 'config.toml'), '[marketplaces.test]\nsource = "./test"\n', 'utf8');

    const detection = await detectEnvironment(repoRoot, {
      ...process.env,
      AW_CLAUDE_HOME: claudeHome,
      AW_CODEX_HOME: codexHome,
    });

    expect(detection.claude.available).toBe(true);
    expect(detection.claude.scopes).toEqual(['project', 'user']);
    expect(detection.claude.preferredScope).toBe('project');

    expect(detection.codex.available).toBe(true);
    expect(detection.codex.scopes).toEqual(['project', 'user']);
    expect(detection.codex.preferredScope).toBe('project');
  });
});
