import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  detectClaudeExternalOwnership,
  readClaudeInstalledPluginsState,
  readClaudeSettings,
  readCodexRegistry,
  readKnownMarketplaceState,
  removeFiles,
  resolveClaudeActiveLocalBundle,
  resolveClaudePlatformNativeFallbackEvidence,
  resolveClaudePlatformRuntimeEvidence,
  writeCodexRegistry,
} from '../../src/adapters/helpers.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('adapter helpers', () => {
  it('parses and rewrites Codex registry blocks while preserving unrelated content', async () => {
    const root = await makeTempDir('aw-codex-registry-');
    const configPath = path.join(root, 'config.toml');
    await fs.writeFile(
      configPath,
      [
        '# managed by tests',
        '',
        '[marketplaces.aw]',
        'source = "/tmp/aw"',
        'source_type = "local"',
        '',
        '[plugins."legacy@aw"]',
        'enabled = "true"',
        '',
        '[unrelated.section]',
        'value = "keep-me"',
        '',
      ].join('\n'),
      'utf8',
    );

    const registryFile = await readCodexRegistry(configPath);
    expect(registryFile.registry.marketplaces.aw).toEqual({
      source: '/tmp/aw',
      source_type: 'local',
    });
    expect(registryFile.registry.plugins['"legacy@aw"']).toEqual({
      enabled: 'true',
    });

    registryFile.registry.marketplaces.aw = {
      source: '/tmp/aw-next',
      source_type: 'local',
    };
    delete registryFile.registry.plugins['"legacy@aw"'];
    registryFile.registry.plugins['"git-commit@aw"'] = {
      enabled: 'true',
      source: './plugins/git-commit',
    };

    await writeCodexRegistry(configPath, registryFile);

    const output = await fs.readFile(configPath, 'utf8');
    expect(output).toContain('# managed by tests');
    expect(output).toContain('[unrelated.section]');
    expect(output).toContain('source = "/tmp/aw-next"');
    expect(output).toContain('[plugins."git-commit@aw"]');
    expect(output).toContain('source = "./plugins/git-commit"');
    expect(output).not.toContain('[plugins."legacy@aw"]');

    await expect(readCodexRegistry(configPath)).resolves.toMatchObject({
      registry: {
        marketplaces: {
          aw: {
            source: '/tmp/aw-next',
            source_type: 'local',
          },
        },
        plugins: {
          '"git-commit@aw"': {
            enabled: 'true',
            source: './plugins/git-commit',
          },
        },
      },
    });
  });

  it('returns empty defaults for missing Claude files and normalizes installed plugin records', async () => {
    const root = await makeTempDir('aw-claude-state-');

    await expect(readClaudeSettings(path.join(root, 'settings.json'))).resolves.toEqual({});
    await expect(
      readKnownMarketplaceState(path.join(root, 'known_marketplaces.json')),
    ).resolves.toEqual({
      marketplaces: {},
    });
    await expect(
      readClaudeInstalledPluginsState(path.join(root, 'installed_plugins.json')),
    ).resolves.toEqual({
      plugins: {},
    });

    const installedPluginsPath = path.join(root, 'installed_plugins.json');
    await fs.writeJson(
      installedPluginsPath,
      {
        plugins: {
          'git-commit@aw': {
            scope: 'project',
            projectPath: '/repo/project-a',
            version: '1.0.0',
            installedAt: '2026-04-25T00:00:00.000Z',
          },
          'reviewer@third-party': [
            {
              name: 'reviewer',
              marketplace: 'third-party',
              scope: 'user',
              owner: 'outside-team',
            },
            null,
            'bad-record',
          ],
          'docs-note': {},
        },
      },
      { spaces: 2 },
    );

    await expect(readClaudeInstalledPluginsState(installedPluginsPath)).resolves.toEqual({
      plugins: {
        'git-commit@aw': [
          {
            name: 'git-commit',
            marketplace: 'aw',
            scope: 'project',
            projectPath: '/repo/project-a',
            version: '1.0.0',
            installedAt: '2026-04-25T00:00:00.000Z',
            installPath: undefined,
            owner: undefined,
          },
        ],
        'reviewer@third-party': [
          {
            name: 'reviewer',
            marketplace: 'third-party',
            scope: 'user',
            projectPath: undefined,
            version: undefined,
            installedAt: undefined,
            installPath: undefined,
            owner: 'outside-team',
          },
        ],
        'docs-note': [
          {
            name: 'docs-note',
            marketplace: 'aw',
            scope: 'user',
            projectPath: undefined,
            version: undefined,
            installedAt: undefined,
            installPath: undefined,
            owner: undefined,
          },
        ],
      },
    });
  });

  it('resolves Claude runtime and fallback evidence details from materialized marketplace state', async () => {
    const installRoot = await makeTempDir('aw-claude-runtime-');
    await fs.ensureDir(path.join(installRoot, '.claude-plugin'));
    await fs.ensureDir(path.join(installRoot, 'plugins', 'git-commit'));
    await fs.writeJson(
      path.join(installRoot, '.claude-plugin', 'marketplace.json'),
      {
        name: 'aw',
        plugins: [
          {
            name: 'git-commit',
            source: './plugins/git-commit',
          },
        ],
      },
      { spaces: 2 },
    );

    await expect(
      resolveClaudeActiveLocalBundle('git-commit', 'aw', undefined),
    ).resolves.toMatchObject({
      activeLocalBundle: null,
      details: 'known_marketplaces.json 中缺少 installLocation。',
    });

    const settings = {
      plugins: {
        installed: {
          'git-commit': {
            marketplace: 'aw',
            version: '0.1.0',
            installedAt: '2026-04-25T00:00:00.000Z',
            scope: 'project' as const,
            projectPath: '/repo/project-a',
          },
        },
      },
    };

    await expect(
      resolveClaudePlatformRuntimeEvidence(
        settings,
        { plugins: {} },
        { installLocation: installRoot },
        'git-commit',
        'aw',
        'project',
        '/repo/project-a',
      ),
    ).resolves.toMatchObject({
      present: true,
      activeLocalBundle: path.join(installRoot, 'plugins', 'git-commit'),
      details: 'installed_plugins.json 未命中当前 scope 记录。',
    });

    expect(
      resolveClaudePlatformNativeFallbackEvidence(
        settings,
        { plugins: {} },
        'git-commit',
        'aw',
        'project',
        '/repo/project-a',
      ),
    ).toMatchObject({
      present: false,
      details: 'installed_plugins.json 未命中 project scope 的 git-commit@aw 记录。',
    });

    expect(
      detectClaudeExternalOwnership(
        settings,
        {
          plugins: {
            'git-commit@third-party': [
              {
                name: 'git-commit',
                marketplace: 'third-party',
                scope: 'project',
                projectPath: '/repo/project-a',
                owner: 'outside-team',
              },
            ],
          },
        },
        'git-commit',
        'aw',
        'project',
        '/repo/project-a',
      ),
    ).toMatchObject({
      present: true,
      marketplace: 'third-party',
      owner: 'outside-team',
      details: 'installed_plugins.json 显示 git-commit 由 third-party 管理。',
    });
  });

  it('removes files idempotently', async () => {
    const root = await makeTempDir('aw-remove-files-');
    const existing = path.join(root, 'existing.txt');
    await fs.writeFile(existing, 'present', 'utf8');

    await removeFiles([existing, path.join(root, 'missing.txt')]);

    await expect(fs.pathExists(existing)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(root, 'missing.txt'))).resolves.toBe(false);
  });
});
