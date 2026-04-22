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
const originalPath = process.env.PATH ?? '';

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

async function registerPluginInMarketplaces(
  repoRoot: string,
  pluginName: string,
  description: string,
): Promise<void> {
  const marketplacePaths = [
    path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
    path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
  ];

  for (const marketplacePath of marketplacePaths) {
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins.push({
      name: pluginName,
      source: `./plugins/${pluginName}`,
      description,
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    });
    await fs.writeJson(marketplacePath, marketplace, { spaces: 2 });
  }
}

async function addPlugin(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', String(manifest.name));
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.ensureDir(path.join(pluginRoot, 'skills'));
  await fs.writeJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), manifest, {
    spaces: 2,
  });
}

afterEach(async () => {
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  process.env.PATH = originalPath;
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

  it('refreshes Claude marketplace materialization on upgrade without rewriting unchanged native install records', async () => {
    const { repoRoot, claudeHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
    const knownMarketplacePath = path.join(
      repoRoot,
      '.claude',
      'plugins',
      'known_marketplaces.json',
    );
    const cachePath = path.join(
      repoRoot,
      '.claude',
      'plugins',
      'marketplaces',
      'agent-workflows.json',
    );

    const originalSettings = await fs.readJson(settingsPath);
    const installedAt = originalSettings.plugins.installed['git-commit'].installedAt;

    await fs.writeJson(
      knownMarketplacePath,
      {
        marketplaces: {
          'agent-workflows': {
            source: '/tmp/stale-marketplace.json',
            materializedAt: '2000-01-01T00:00:00.000Z',
            plugins: [],
          },
        },
      },
      { spaces: 2 },
    );
    await fs.writeJson(cachePath, { name: 'agent-workflows', plugins: [] }, { spaces: 2 });

    await upgradeCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(fs.readJson(settingsPath)).resolves.toMatchObject({
      plugins: {
        installed: {
          'git-commit': {
            installedAt,
          },
        },
      },
    });
    await expect(fs.readJson(knownMarketplacePath)).resolves.toMatchObject({
      marketplaces: {
        'agent-workflows': {
          source: path.join(repoRoot, '.claude-plugin', 'marketplace.json'),
          plugins: ['git-commit'],
        },
      },
    });
    await expect(fs.readJson(cachePath)).resolves.toMatchObject({
      name: 'agent-workflows',
      plugins: [
        {
          name: 'git-commit',
        },
      ],
    });
  });

  it('preserves existing Claude permissions and hooks when installing and uninstalling extensions', async () => {
    const { repoRoot, claudeHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await fs.ensureDir(path.join(repoRoot, '.claude'));
    await fs.writeJson(
      path.join(repoRoot, '.claude', 'settings.json'),
      {
        permissions: {
          allow: ['npm test'],
          ask: ['git push'],
        },
        hooks: [
          {
            event: 'beforeToolUse',
            matcher: 'npm *',
            command: 'echo keep-user-hook',
            description: '保留手写 hook',
          },
        ],
      },
      { spaces: 2 },
    );

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(fs.readJson(path.join(repoRoot, '.claude', 'settings.json'))).resolves.toMatchObject({
      permissions: {
        allow: ['npm test', 'git status', 'git diff'],
        ask: ['git push', 'git commit'],
      },
      hooks: [
        {
          event: 'beforeToolUse',
          matcher: 'npm *',
          command: 'echo keep-user-hook',
          description: '保留手写 hook',
        },
        {
          event: 'command',
          matcher: 'git *',
          command: 'echo git hook',
          description: '观察 git 命令',
        },
      ],
    });

    await uninstallCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(fs.readJson(path.join(repoRoot, '.claude', 'settings.json'))).resolves.toMatchObject({
      permissions: {
        allow: ['npm test'],
        ask: ['git push'],
      },
      hooks: [
        {
          event: 'beforeToolUse',
          matcher: 'npm *',
          command: 'echo keep-user-hook',
          description: '保留手写 hook',
        },
      ],
    });
  });

  it('preserves overlapping Claude permissions and hooks without duplicating shared values', async () => {
    const { repoRoot, claudeHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    const sharedHook = {
      event: 'command',
      matcher: 'git *',
      command: 'echo git hook',
      description: '观察 git 命令',
    };
    const userHook = {
      event: 'beforeToolUse',
      matcher: 'npm *',
      command: 'echo keep-user-hook',
      description: '保留手写 hook',
    };

    await fs.ensureDir(path.join(repoRoot, '.claude'));
    await fs.writeJson(
      path.join(repoRoot, '.claude', 'settings.json'),
      {
        permissions: {
          allow: ['git status', 'npm test'],
          ask: ['git commit', 'git push'],
        },
        hooks: [sharedHook, userHook],
      },
      { spaces: 2 },
    );

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    const installedSettings = await fs.readJson(path.join(repoRoot, '.claude', 'settings.json'));
    expect(installedSettings.permissions).toMatchObject({
      allow: ['git status', 'npm test', 'git diff'],
      ask: ['git commit', 'git push'],
    });
    expect(installedSettings.hooks).toEqual([sharedHook, userHook]);

    await uninstallCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });

    await expect(fs.readJson(path.join(repoRoot, '.claude', 'settings.json'))).resolves.toMatchObject({
      permissions: {
        allow: ['git status', 'npm test'],
        ask: ['git commit', 'git push'],
      },
      hooks: [sharedHook, userHook],
    });
  });

  it('writes Codex native registry to user scope and extensions to project scope', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    const result = await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain(
      '[marketplaces.agent-workflows]',
    );
    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain(
      path.join(repoRoot, '.agents', 'plugins', 'marketplace.json'),
    );
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'AGENTS.md'))).resolves.toBe(true);
    await expect(
      fs.pathExists(path.join(repoRoot, '.codex', 'rules', 'aw-git-commit-git-ops.rules')),
    ).resolves.toBe(true);
    expect(result.warnings).toContain(
      'Codex 原生 plugin / marketplace 注册仅支持 user scope，已回退到 `~/.codex/config.toml`；`--scope project` 只影响 `.codex/` 自定义扩展。',
    );
  });

  it('preserves unrelated Codex config and merges shared artifacts across multiple plugins', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '# existing config',
        'model = "gpt-5"',
        '',
        '[profiles.default]',
        'enabled = true',
        '',
        '[plugins.external-tool]',
        'marketplace = "vendor-market"',
        'version = "9.9.9"',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    await addPlugin(repoRoot, {
      name: 'repo-check',
      version: '0.2.0',
      description: '检查仓库状态。',
      extensions: {
        instructions: [
          {
            name: 'repo-check-policy',
            title: '仓库检查',
            content: '执行检查前先确认当前分支。',
          },
        ],
        hooks: [
          {
            event: 'command',
            matcher: 'pnpm *',
            command: 'echo repo hook',
            description: '观察 pnpm 命令',
          },
        ],
      },
    });
    await registerPluginInMarketplaces(repoRoot, 'repo-check', '检查仓库状态。');

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });
    await installCommand(['repo-check'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    await expect(fs.readFile(path.join(repoRoot, '.codex', 'AGENTS.md'), 'utf8')).resolves.toContain(
      'git-commit',
    );
    await expect(fs.readFile(path.join(repoRoot, '.codex', 'AGENTS.md'), 'utf8')).resolves.toContain(
      'repo-check',
    );
    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toMatchObject({
      commands: [
        {
          matcher: 'git *',
          command: 'echo git hook',
          description: '观察 git 命令',
        },
        {
          matcher: 'pnpm *',
          command: 'echo repo hook',
          description: '观察 pnpm 命令',
        },
      ],
    });

    const installedConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(installedConfig).toContain('# existing config');
    expect(installedConfig).toContain('[profiles.default]');
    expect(installedConfig).toContain('[plugins.external-tool]');
    expect(installedConfig).toContain('[marketplaces.agent-workflows]');

    await uninstallCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    await expect(fs.readFile(path.join(repoRoot, '.codex', 'AGENTS.md'), 'utf8')).resolves.not.toContain(
      'git-commit',
    );
    await expect(fs.readFile(path.join(repoRoot, '.codex', 'AGENTS.md'), 'utf8')).resolves.toContain(
      'repo-check',
    );
    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toMatchObject({
      commands: [
        {
          matcher: 'pnpm *',
          command: 'echo repo hook',
          description: '观察 pnpm 命令',
        },
      ],
    });
    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain(
      '[marketplaces.agent-workflows]',
    );

    await uninstallCommand(['repo-check'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'AGENTS.md'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toBe(false);

    const finalConfig = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
    expect(finalConfig).not.toContain('[marketplaces.agent-workflows]');
    expect(finalConfig).toContain('[profiles.default]');
    expect(finalConfig).toContain('[plugins.external-tool]');
  });

  it('protects external same-name plugins from install, upgrade and uninstall', async () => {
    const { repoRoot, claudeHome, codexHome } = await makeWorkspace();
    process.env.AW_CLAUDE_HOME = claudeHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[plugins.git-commit]',
        'marketplace = "vendor-market"',
        'version = "9.9.9"',
        '',
      ].join('\n'),
      'utf8',
    );

    await fs.ensureDir(path.join(repoRoot, '.claude'));
    await fs.writeJson(
      path.join(repoRoot, '.claude', 'settings.json'),
      {
        plugins: {
          installed: {
            'git-commit': {
              marketplace: 'vendor-market',
              version: '9.9.9',
              installedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        },
      },
      { spaces: 2 },
    );

    const codexStatus = await statusCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });
    expect(codexStatus.reports[0].plugins[0].driftWarnings).toContain(
      '插件已安装，但 marketplace 字段不属于 agent-workflows。',
    );

    const claudeStatus = await statusCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'claude',
    });
    expect(claudeStatus.reports[0].plugins[0].driftWarnings).toContain(
      '插件已安装，但 marketplace 字段不属于 agent-workflows。',
    );

    await expect(
      installCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');
    await expect(
      upgradeCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');
    await expect(
      uninstallCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');

    await expect(
      installCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');
    await expect(
      upgradeCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');
    await expect(
      uninstallCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
      }),
    ).rejects.toThrow('不会覆盖或删除外部同名插件');

    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain(
      'marketplace = "vendor-market"',
    );
    await expect(fs.readJson(path.join(repoRoot, '.claude', 'settings.json'))).resolves.toMatchObject({
      plugins: {
        installed: {
          'git-commit': {
            marketplace: 'vendor-market',
            version: '9.9.9',
          },
        },
      },
    });

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'AGENTS.md'))).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(repoRoot, '.claude', 'rules', 'aw-git-commit-commit-policy.md')),
    ).resolves.toBe(false);
  });

  it('keeps status read-only and groups multiple plugin reports by platform', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await addPlugin(repoRoot, {
      name: 'repo-check',
      version: '0.2.0',
      description: '检查仓库状态。',
      extensions: {
        instructions: [
          {
            name: 'repo-check-policy',
            title: '仓库检查',
            content: '执行检查前先确认当前分支。',
          },
        ],
      },
    });
    await registerPluginInMarketplaces(repoRoot, 'repo-check', '检查仓库状态。');

    const status = await statusCommand(['git-commit', 'repo-check'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    expect(status.reports).toHaveLength(1);
    expect(status.reports[0].plugins.map((plugin) => plugin.pluginName)).toEqual([
      'git-commit',
      'repo-check',
    ]);
    expect(status.output).toContain('detected-platforms');
    expect((status.output.match(/codex \(project\)/g) ?? [])).toHaveLength(1);
    expect(status.output).toContain('native:');
    expect(status.output).toContain('artifacts: none');

    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'repo-check', '.claude-plugin', 'plugin.json')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(repoRoot, 'plugins', 'repo-check', '.codex-plugin', 'plugin.json')),
    ).resolves.toBe(false);
  });

  it('reports native version drift and refreshes Codex registry data on upgrade', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await installCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    const configPath = path.join(codexHome, 'config.toml');
    const staleConfig = (await fs.readFile(configPath, 'utf8')).replace(
      'version = "1.0.0"',
      'version = "0.9.0"',
    );
    await fs.writeFile(configPath, staleConfig, 'utf8');

    const beforeUpgrade = await statusCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });
    expect(beforeUpgrade.reports[0].plugins[0].driftWarnings).toContain(
      '原生安装版本与当前插件 manifest version 不一致。',
    );

    await upgradeCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });

    const afterUpgrade = await statusCommand(['git-commit'], {
      cwd: repoRoot,
      scope: 'project',
      platform: 'codex',
    });
    expect(afterUpgrade.reports[0].plugins[0].driftWarnings).not.toContain(
      '原生安装版本与当前插件 manifest version 不一致。',
    );
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('version = "1.0.0"');
  });

  it('rejects Codex install when marketplace mirrors drift', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    const codexMarketplacePath = path.join(repoRoot, '.agents', 'plugins', 'marketplace.json');
    const codexMarketplace = await fs.readJson(codexMarketplacePath);
    codexMarketplace.plugins[0].description = 'drifted description';
    await fs.writeJson(codexMarketplacePath, codexMarketplace, { spaces: 2 });

    await expect(
      installCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('marketplace 镜像不一致');
  });

  it('does not upgrade uninitialized Codex plugins implicitly', async () => {
    const { repoRoot, codexHome } = await makeWorkspace();
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';

    await expect(
      upgradeCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('尚未初始化');

    await expect(
      upgradeCommand([], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        all: true,
      }),
    ).resolves.toMatchObject({
      plugins: [],
      warnings: [
        'Codex 原生 plugin / marketplace 注册仅支持 user scope，已回退到 `~/.codex/config.toml`；`--scope project` 只影响 `.codex/` 自定义扩展。',
      ],
    });

    await expect(fs.pathExists(path.join(codexHome, 'config.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'AGENTS.md'))).resolves.toBe(false);
  });

  it('enforces auto and both platform resolution rules', async () => {
    const { repoRoot, claudeHome, codexHome } = await makeWorkspace();
    process.env.PATH = '';
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
    process.env.PATH = '';
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
