import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  claudeHome: string;
  codexHome: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);

  const claudeHome = path.join(root, 'claude-home');
  const codexHome = path.join(root, 'codex-home');
  await fs.ensureDir(claudeHome);
  await fs.ensureDir(codexHome);

  return { repoRoot, claudeHome, codexHome };
}

afterEach(async () => {
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI integration', () => {
  it('installs, upgrades, reports status and uninstalls Claude project scope artifacts', async () => {
    const { repoRoot, claudeHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(fs.readJson(path.join(repoRoot, '.claude', 'settings.json'))).resolves.toMatchObject({
      extraKnownMarketplaces: {
        'agent-workflows': path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
      },
    });
    await expect(
      fs.pathExists(path.join(repoRoot, '.claude', 'rules', 'aw-git-commit-commit-policy.md')),
    ).resolves.toBe(true);

    await fs.writeFile(
      path.join(repoRoot, '.claude', 'rules', 'aw-git-commit-commit-policy.md'),
      'stale',
      'utf8',
    );
    await upgradeCommand([], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
      all: true,
    });
    await expect(
      fs.readFile(path.join(repoRoot, '.claude', 'rules', 'aw-git-commit-commit-policy.md'), 'utf8'),
    ).resolves.not.toBe('stale');

    const status = await statusCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });
    expect(status.reports[0].plugins[0].native.pluginInstalled).toBe(true);

    await uninstallCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });
    await expect(
      fs.pathExists(path.join(repoRoot, '.claude', 'rules', 'aw-git-commit-commit-policy.md')),
    ).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(repoRoot, '.claude', '.agent-workflows-manifest.json')),
    ).resolves.toMatchObject({
      plugins: {},
    });
  });

  it('writes Codex native registry to user scope and extensions to project scope', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain(
      '[marketplaces.agent-workflows]',
    );
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'AGENTS.md'))).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(repoRoot, '.codex', 'rules', 'aw-git-commit-git-ops.rules')),
    ).resolves.toBe(true);
  });

  it('enforces auto and both platform resolution rules', async () => {
    const { repoRoot, claudeHome, codexHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await expect(
      installCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'auto',
      }),
    ).rejects.toThrow('无法从当前 scope 的初始化状态唯一推断目标平台');

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(
      upgradeCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'auto',
      }),
    ).resolves.toMatchObject({
      platforms: ['claude'],
    });

    const singlePlatformWorkspace = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = path.join(singlePlatformWorkspace.repoRoot, 'missing-claude-home');
    process.env.AW_CODEX_HOME = singlePlatformWorkspace.codexHome;
    delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await expect(
      installCommand(['git-commit'], {
        cwd: singlePlatformWorkspace.repoRoot,
        scope: 'project',
        platform: 'both',
      }),
    ).rejects.toThrow('`--platform both`');
  });
});
