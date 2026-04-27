import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  readMarketplaceSourceMeta,
  readPluginManifest,
} from '../../src/utils/manifest.js';

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest utils', () => {
  it('reads marketplace source metadata and plugin source manifest', async () => {
    const repoRoot = await makeTempRepo();
    const [marketplace, plugin] = await Promise.all([
      readMarketplaceSourceMeta(repoRoot),
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ]);

    expect(marketplace).toEqual({
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
    });

    expect(plugin.manifest.marketplace).toMatchObject({
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products: ['CODEX'],
      },
    });
    expect(plugin.manifest.extensions?.hooks?.[0]).toMatchObject({
      event: 'before_tool',
      matcher: 'Bash',
    });
  });

  it('rejects deprecated top-level claude block', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.claude = {
      hooks: './hooks/hooks.json',
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('unknown field "claude"');
  });

  it('rejects hook fields and permission patterns outside the public source contract', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions.hooks[0].event = 'command';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unsupported hook event "command"',
    );

    manifest.extensions.hooks[0].event = 'before_tool';
    manifest.extensions.hooks[0].description = 'old field';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'unknown field "description"',
    );

    delete manifest.extensions.hooks[0].description;
    manifest.extensions.permissions[0].allow = ['git *'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'only plain token prefixes are supported',
    );
  });

  it('rejects unknown root marketplace metadata fields', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePath = path.join(repoRoot, 'plugins', 'marketplace-source.json');
    const source = await fs.readJson(sourcePath);
    source.metadata = {
      internal: true,
    };
    await fs.writeJson(sourcePath, source, { spaces: 2 });

    await expect(readMarketplaceSourceMeta(repoRoot)).rejects.toThrow(
      'unknown field "metadata"',
    );
  });

  it('rejects undeclared default skills directory', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(
      repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    delete manifest.skills;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(
      readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit')),
    ).rejects.toThrow('found skills but missing "skills" declaration');
  });

  it('rejects declared native asset paths that do not exist', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.skills = './missing-skills';
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'skills points to "./missing-skills" but path does not exist',
    );
  });

  it('rejects undeclared default MCP manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { servers: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .mcp.json but missing "mcpServers" declaration',
    );
  });

  it('rejects undeclared default app manifest', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: [] }, { spaces: 2 });

    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'found .app.json but missing "apps" declaration',
    );
  });

  it('allows templated JSON native assets at source time but validates non-template JSON shape', async () => {
    const repoRoot = await makeTempRepo();
    const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);
    manifest.mcpServers = './.mcp.json';
    manifest.apps = './.app.json';
    manifest.buildConfig = {
      templates: {
        include: ['.mcp.json', '.app.json'],
        vars: {
          serverName: { claude: 'claude-server', codex: 'codex-server' },
        },
      },
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeFile(path.join(pluginRoot, '.mcp.json'), '{"mcpServers": {{serverName}}}', 'utf8');
    await fs.writeFile(path.join(pluginRoot, '.app.json'), '{"apps": {{serverName}}}', 'utf8');

    await expect(readPluginManifest(pluginRoot)).resolves.toMatchObject({
      manifest: {
        mcpServers: './.mcp.json',
        apps: './.app.json',
      },
    });

    delete manifest.buildConfig;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.mcp.json'), { mcpServers: [] }, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, '.app.json'), { apps: {} }, { spaces: 2 });
    await expect(readPluginManifest(pluginRoot)).rejects.toThrow(
      'expected top-level "mcpServers" object',
    );
  });

  it('loads bundle manifests without applying source-only default asset checks', async () => {
    const repoRoot = await makeTempRepo();
    const sourcePluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
    const bundlePluginRoot = path.join(repoRoot, 'bundle', 'plugins', 'git-commit');
    await fs.ensureDir(path.join(bundlePluginRoot, '.agents-plugin'));
    const manifest = await fs.readJson(
      path.join(sourcePluginRoot, '.agents-plugin', 'plugin.json'),
    );
    delete manifest.skills;
    await fs.writeJson(
      path.join(bundlePluginRoot, '.agents-plugin', 'plugin.json'),
      manifest,
      { spaces: 2 },
    );
    await fs.ensureDir(path.join(bundlePluginRoot, 'skills'));

    await expect(readPluginManifest(bundlePluginRoot)).rejects.toThrow(
      'found skills but missing "skills" declaration',
    );
    await expect(
      readPluginManifest(bundlePluginRoot, { mode: 'bundle' }),
    ).resolves.toMatchObject({
      manifest: {
        name: 'git-commit',
      },
    });
  });
});
