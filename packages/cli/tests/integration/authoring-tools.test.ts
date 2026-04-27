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
        '--with-apps',
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
      apps: './.app.json',
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
        capabilities: ['Skills', 'Apps'],
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
    const skillMdContent = await fs.readFile(
      path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'SKILL.md'),
      'utf8',
    );
    expect(skillMdContent).toContain('user-invocable: true');
    expect(skillMdContent).toContain('disable-model-invocation: true');
    await expect(
      fs.pathExists(
        path.join(tempRepo, 'plugins', 'repo-check', 'skills', 'repo-check', 'agents', 'openai.yaml'),
      ),
    ).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(tempRepo, 'plugins', 'repo-check', '.app.json')),
    ).resolves.toMatchObject({
      apps: {
        example: {
          id: 'replace-with-real-connector-id',
        },
      },
    });
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

    const exampleDoc = await fs.readFile(
      path.join(refBase, 'comprehensive-example.md'),
      'utf8',
    );
    expect(exampleDoc).toContain('Codex 安装时生成的 repo-managed artifacts');
  });

  it('validate_plugin.js passes on the reference code-review example', async () => {
    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const pluginDir = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'references',
      'code-review',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).resolves.toBeDefined();
  });

  it('validate_plugin.js rejects out-of-bounds skills path when CLI is built', async () => {
    const distPath = path.join(repoRoot(), 'packages', 'cli', 'dist');
    if (!fs.existsSync(distPath)) return;

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-boundary-'));
    tempDirs.push(tempRoot);

    const pluginDir = path.join(tempRoot, 'boundary-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
      name: 'boundary-test',
      version: '0.1.0',
      description: 'Test plugin for boundary check.',
      skills: './../shared-skills',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      interface: { displayName: 'Boundary Test', shortDescription: 'Test' },
    });

    const scriptPath = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await expect(
      execFileAsync('node', [scriptPath, pluginDir], {
        cwd: repoRoot(),
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      }),
    ).rejects.toBeDefined();
  });

  it('validate_plugin.js fallback warns that it is lightweight and skips templated native asset shape checks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-validator-fallback-'));
    tempDirs.push(tempRoot);

    const scriptSource = path.join(
      repoRoot(),
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    const scriptPath = path.join(
      tempRoot,
      '.agents',
      'skills',
      'create-agent-workflows-plugin',
      'scripts',
      'validate_plugin.js',
    );
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.copy(scriptSource, scriptPath);

    const pluginDir = path.join(tempRoot, 'plugins', 'fallback-test');
    await fs.ensureDir(path.join(pluginDir, '.agents-plugin'));
    await fs.writeJson(path.join(pluginDir, '.agents-plugin', 'plugin.json'), {
      name: 'fallback-test',
      version: '0.1.0',
      description: 'Test plugin for fallback validation.',
      mcpServers: './.mcp.json',
      apps: './.app.json',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'NONE' },
      },
      buildConfig: {
        templates: {
          include: ['.mcp.json', '.app.json'],
        },
      },
    }, { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.mcp.json'), { template: true }, { spaces: 2 });
    await fs.writeJson(path.join(pluginDir, '.app.json'), { template: true }, { spaces: 2 });

    const result = await execFileAsync('node', [scriptPath, pluginDir], {
      cwd: tempRoot,
      env: process.env,
      maxBuffer: 10 * 1024 * 1024,
    });

    expect(result.stdout).toContain('仅执行轻量预检');
    expect(result.stdout).toContain('[PASS] All checks passed.');
  });

});
