import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('authoring tools', () => {
  it('keeps fixtures on the source manifest + embedded bundle model', async () => {
    const fixtureRoot = fixturePath('repo-template');

    await expect(
      fs.pathExists(path.join(fixtureRoot, 'plugins', 'marketplace-source.json')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(fixtureRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(fixtureRoot, '.agents', 'plugins', 'marketplace.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(
        path.join(fixtureRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json'),
      ),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(
        path.join(fixtureRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json'),
      ),
    ).resolves.toBe(false);
  });

  it('scaffolds a source-only plugin and preserves marketplace-source metadata', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-authoring-'));
    tempDirs.push(tempRoot);

    const tempRepo = path.join(tempRoot, 'repo');
    await fs.copy(fixturePath('repo-template'), tempRepo);

    const marketplaceSourcePath = path.join(tempRepo, 'plugins', 'marketplace-source.json');
    const beforeMarketplaceSource = await fs.readFile(marketplaceSourcePath, 'utf8');
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'init_plugin.js',
    );

    await execFileAsync(
      'node',
      [
        scriptPath,
        'repo-check',
        '--description',
        '检查仓库状态并输出诊断结论。',
        '--display-name',
        'Repo Check',
        '--short-description',
        '检查仓库状态',
        '--skill-name',
        'repo-check',
        '--skill-description',
        '手动触发这个 skill，执行仓库检查工作流',
        '--repo-root',
        tempRepo,
      ],
      {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'repo-check', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      name: 'repo-check',
      version: '0.1.0',
      description: '检查仓库状态并输出诊断结论。',
      skills: './skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
      interface: {
        displayName: 'Repo Check',
        shortDescription: '检查仓库状态',
        capabilities: ['Skills'],
      },
      extensions: {
        instructions: [],
        permissions: [],
        hooks: [],
        agents: [],
      },
    });
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md')),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(
        path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'agents', 'openai.yaml'),
      ),
    ).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(tempRepo, 'plugins', 'repo-check', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(fs.readFile(marketplaceSourcePath, 'utf8')).resolves.toBe(beforeMarketplaceSource);
  });

  it('keeps authoring docs aligned with the build-bundle model', async () => {
    const root = repoRoot();
    const refBase = path.join(
      root,
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'references',
    );
    const skillDoc = await fs.readFile(
      path.join(root, '.agents', 'skills', 'create-agent-workflows-plugin', 'SKILL.md'),
      'utf8',
    );
    const manifestSpecDoc = await fs.readFile(
      path.join(refBase, 'plugin-manifest-spec.md'),
      'utf8',
    );
    const triggersDoc = await fs.readFile(
      path.join(refBase, 'skills-and-triggers.md'),
      'utf8',
    );

    expect(skillDoc).toContain('`plugins/marketplace-source.json`');
    expect(skillDoc).toContain('`pnpm build`');
    expect(skillDoc).toContain('`.claude-plugin/plugin.json`');
    expect(skillDoc).toContain('`.codex-plugin/plugin.json`');
    expect(skillDoc).not.toContain('同步 `.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json`');
    expect(skillDoc).not.toContain('默认把插件注册到两份 marketplace manifest');

    expect(manifestSpecDoc).toContain('`plugins/marketplace-source.json`');
    expect(manifestSpecDoc).toContain('不是运行时 marketplace manifest');
    expect(manifestSpecDoc).toContain('packages/cli/plugins-dist/');
    expect(manifestSpecDoc).toContain('禁止手改');

    expect(triggersDoc).toContain('两个平台的触发开关完全独立');
  });

  it('marks replaced plans as historical documents and links the current plan', async () => {
    const historicalDocs = [
      path.join(repoRoot(), 'docs', 'dev', 'plans', 'project-init.md'),
      path.join(repoRoot(), 'docs', 'dev', 'plans', 'npm-plugin-marketplace.md'),
      path.join(repoRoot(), 'docs', 'dev', 'plans', 'codex-repo-managed-artifacts.md'),
    ];

    for (const docPath of historicalDocs) {
      const header = (await fs.readFile(docPath, 'utf8')).split('\n').slice(0, 8).join('\n');
      expect(header).toContain('历史文档');
      expect(header).toContain('npm-plugin-marketplace-new.md');
      expect(header).toContain('todos/npm-plugin-marketplace-new.md');
    }
  });
});
