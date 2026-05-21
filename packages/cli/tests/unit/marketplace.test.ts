import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateBundleLayout } from '../../src/utils/bundle-layout.js';
import { readJsonFile } from '../../src/utils/json.js';
import { resolveCatalogPackageIdentityByDistTag } from '../../src/utils/marketplace.js';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { TestPathFenceError } from '../helpers/test-isolation.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
} from '../setup/test-isolation.js';

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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-marketplace-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

afterEach(async () => {
  vi.resetModules();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

async function addCodexOnlyFixture(repoRoot: string): Promise<void> {
  await fs.copy(
    fixturePath('codex-project-repo-managed', 'plugins', 'skills-only'),
    path.join(repoRoot, 'plugins', 'skills-only'),
  );
}

async function addClaudeOnlyFixture(repoRoot: string): Promise<void> {
  const pluginName = 'git-commit-claude-only';
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.copy(fixturePath('repo-template', 'plugins', 'git-commit'), pluginRoot);

  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.name = pluginName;
  manifest.description = 'Claude-only marketplace fixture';
  manifest.apps = undefined;
  manifest.marketplace.policy.products = ['CLAUDE'];
  if (manifest.interface) {
    manifest.interface.displayName = 'Git Commit Claude Only';
  }
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, '.app.json'));
}

async function addStagedManifestBuildFixture(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const scriptsRoot = path.join(pluginRoot, 'scripts');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);

  manifest.description = 'Source description';
  manifest.marketplace.policy.products = ['CLAUDE'];
  delete manifest.apps;
  manifest.scripts = {
    node: {
      build: {
        runner: 'node',
        path: './scripts/build.mjs',
      },
    },
  };

  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, '.app.json'));
  await fs.ensureDir(scriptsRoot);
  await fs.writeFile(
    path.join(scriptsRoot, 'build.mjs'),
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      '',
      'const manifestUrl = new URL("../.agents-plugin/plugin.json", import.meta.url);',
      'const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));',
      'manifest.description = "Built smoke description";',
      'manifest.marketplace.policy.products = ["CODEX"];',
      'await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\\n`, "utf8");',
      '',
    ].join('\n'),
    'utf8',
  );
}

describe('marketplace npm userconfig fencing', () => {
  it('uses the isolated npm userconfig by default when resolving registry metadata', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': {
        latest: '1.2.3',
      },
      versions: {
        '1.2.3': {
          dist: {
            integrity: 'sha512-test-integrity',
            tarball: 'https://example.test/aw-plugins-1.2.3.tgz',
          },
        },
      },
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      resolveCatalogPackageIdentityByDistTag(
        '@yiliang/aw-plugins-manifest',
        'latest',
        process.env,
      ),
    ).resolves.toMatchObject({
      packageName: '@yiliang/aw-plugins-manifest',
      version: '1.2.3',
      integrity: 'sha512-test-integrity',
    });
    expect(process.env.npm_config_userconfig).toBe(isolation.layout.npmUserConfigPath);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('blocks explicit real or unregistered npm userconfig paths before reading ~/.npmrc', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('fetch should not run for unsafe npm userconfig paths');
    });
    vi.stubGlobal('fetch', fetch);

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const realHomeError = await resolveCatalogPackageIdentityByDistTag(
      '@yiliang/aw-plugins-manifest',
      'latest',
      {
        npm_config_userconfig: path.join(os.homedir(), '.npmrc'),
      },
    ).catch((error) => error);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    expect(realHomeError).toBeInstanceOf(TestPathFenceError);
    expect((realHomeError as TestPathFenceError).details).toMatchObject({
      access: 'read',
      source: 'npm_config_userconfig',
      reason: 'outsideRegisteredRoots',
    });

    const unregisteredError = await resolveCatalogPackageIdentityByDistTag(
      '@yiliang/aw-plugins-manifest',
      'latest',
      {
        ...process.env,
        npm_config_userconfig: path.join(getSourceTestRepositoryCwd(), '.npmrc'),
      },
    ).catch((error) => error);
    expect(unregisteredError).toBeInstanceOf(TestPathFenceError);
    expect((unregisteredError as TestPathFenceError).details).toMatchObject({
      access: 'read',
      source: 'npm_config_userconfig',
      reason: 'outsideRegisteredRoots',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('marketplace bundle', () => {
  it('filters marketplace entries by platform while preserving shared root metadata', async () => {
    const repoRoot = await makeTempRepo();
    await Promise.all([
      addCodexOnlyFixture(repoRoot),
      addClaudeOnlyFixture(repoRoot),
    ]);

    const outputRoot = path.join(repoRoot, 'out');
    await bundlePlugins({ repoRoot, outputRoot });

    const [claudeMarketplace, codexMarketplace] = await Promise.all([
      readJsonFile(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
      readJsonFile(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ]);

    expect(claudeMarketplace).toMatchObject({
      name: 'aw',
      owner: {
        name: 'Leslie Chan',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
      plugins: [
        {
          name: 'git-commit',
          source: './plugins/git-commit',
          category: 'workflow',
          strict: true,
        },
        {
          name: 'git-commit-claude-only',
          source: './plugins/git-commit-claude-only',
          policy: {
            products: ['CLAUDE'],
          },
        },
      ],
    });
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'git-commit',
      'git-commit-claude-only',
    ]);
    expect(codexMarketplace.plugins.map((plugin: { name: string }) => plugin.name).sort()).toEqual([
      'git-commit',
      'skills-only',
    ]);
    expect(codexMarketplace.owner).toEqual(claudeMarketplace.owner);
    expect(codexMarketplace.interface).toEqual(claudeMarketplace.interface);
    expect(codexMarketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: 'skills-only',
        source: './plugins/skills-only',
        policy: expect.objectContaining({
          products: ['CODEX'],
        }),
      }),
    );
    expect(claudeMarketplace.plugins.find((plugin: { name: string }) => plugin.name === 'skills-only')).toBeUndefined();
    expect(codexMarketplace.plugins.find((plugin: { name: string }) => plugin.name === 'git-commit-claude-only')).toBeUndefined();
  });

  it('uses the staged final manifest to filter platform marketplaces', async () => {
    const repoRoot = await makeTempRepo();
    await addStagedManifestBuildFixture(repoRoot);

    const outputRoot = path.join(repoRoot, 'out');
    await bundlePlugins({
      repoRoot,
      outputRoot,
      buildMode: 'staging',
    });

    await expect(
      readJsonFile(path.join(outputRoot, '.claude-plugin', 'marketplace.json')),
    ).resolves.toMatchObject({
      plugins: [],
    });
    await expect(
      readJsonFile(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json')),
    ).resolves.toMatchObject({
      plugins: [
        {
          name: 'git-commit',
          description: 'Built smoke description',
          policy: {
            products: ['CODEX'],
          },
          source: './plugins/git-commit',
        },
      ],
    });
  }, 15_000);

  it('reads only the target platform marketplace and validates its root metadata', async () => {
    const catalogRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-marketplace-read-'));
    tempDirs.push(catalogRoot);
    await fs.ensureDir(path.join(catalogRoot, '.claude-plugin'));
    await fs.writeJson(path.join(catalogRoot, '.claude-plugin', 'marketplace.json'), {
      name: 'aw',
      owner: {
        name: 'Leslie Chan',
        url: 'https://github.com/LeslieChan/agent-workflows',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
      plugins: [],
    }, { spaces: 2 });

    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCurrentCatalog: async () => ({
        rootDir: catalogRoot,
        source: 'embedded',
      }),
    }));

    const { readMarketplaceManifest } = await import('../../src/utils/marketplace.js');
    await expect(
      readMarketplaceManifest(process.cwd(), 'claude'),
    ).resolves.toMatchObject({
      path: path.join(catalogRoot, '.claude-plugin', 'marketplace.json'),
      manifest: {
        name: 'aw',
        plugins: [],
      },
    });
  });

  it('rejects invalid target marketplace root metadata without reading the other platform mirror', async () => {
    const catalogRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-marketplace-invalid-'));
    tempDirs.push(catalogRoot);
    await fs.ensureDir(path.join(catalogRoot, '.claude-plugin'));
    await fs.writeJson(path.join(catalogRoot, '.claude-plugin', 'marketplace.json'), {
      name: 'aw',
      owner: {
        name: 'Leslie Chan',
      },
      interface: {
        displayName: 'Agent Workflows',
      },
      plugins: [],
    }, { spaces: 2 });

    vi.doMock('../../src/utils/plugin-catalog.js', () => ({
      resolveCurrentCatalog: async () => ({
        rootDir: catalogRoot,
        source: 'embedded',
      }),
    }));

    const { readMarketplaceManifest } = await import('../../src/utils/marketplace.js');
    await expect(readMarketplaceManifest(process.cwd(), 'claude')).rejects.toThrow(
      'Invalid claude marketplace manifest.owner.url: expected a non-empty string.',
    );
  });

  it('validates the generated embedded root layout', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
  });

  it('builds Claude bundle hooks with public and native events under strict validation', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions ??= {};
    manifest.extensions.hooks ??= [];
    manifest.extensions.hooks.push({
      event: 'session_start',
      command: 'echo shared session start',
    });
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(validateBundleLayout(embeddedRoot)).resolves.toBeUndefined();
    await expect(
      fs.readJson(path.join(embeddedRoot, 'plugins', 'git-commit', 'claude', 'hooks', 'hooks.json')),
    ).resolves.toEqual({
      hooks: {
        Notification: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo claude notification' }],
          },
        ],
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          },
        ],
        SessionStart: [
          {
            matcher: 'startup|resume|clear',
            hooks: [{ type: 'command', command: 'echo shared session start' }],
          },
        ],
      },
    });
    await expect(
      fs.readJson(path.join(embeddedRoot, 'plugins', 'git-commit', '.claude-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      hooks: './claude/hooks/hooks.json',
    });
  });

  it('rejects rendered native assets and hooks with invalid bundle semantics', async () => {
    const repoRoot = await makeTempRepo();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const claudeManifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
    const codexManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');

    const codexManifest = await fs.readJson(codexManifestPath);
    codexManifest.apps = './codex/.app.json';
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'codex', '.app.json'), {
      apps: {
        dashboard: {},
      },
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'codex.apps.apps.dashboard.id',
    );

    delete codexManifest.apps;
    codexManifest.mcpServers = './codex/.mcp.json';
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'codex', '.mcp.json'), {
      mcpServers: [],
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'expected top-level "mcpServers" object',
    );

    delete codexManifest.mcpServers;
    await fs.writeJson(codexManifestPath, codexManifest, { spaces: 2 });
    const claudeManifest = await fs.readJson(claudeManifestPath);
    claudeManifest.hooks = './claude/hooks/hooks.json';
    await fs.writeJson(claudeManifestPath, claudeManifest, { spaces: 2 });
    await fs.writeJson(path.join(pluginRoot, 'claude', 'hooks', 'hooks.json'), {
      hooks: [],
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'claude.hooks.hooks',
    );

    await fs.writeJson(path.join(pluginRoot, 'claude', 'hooks', 'hooks.json'), {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                command: 'echo missing type',
              },
            ],
          },
        ],
      },
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'claude.hooks.hooks.PreToolUse[0].hooks[0].type',
    );

    await fs.writeJson(path.join(pluginRoot, 'claude', 'hooks', 'hooks.json'), {
      hooks: {
        sessionStop: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'echo done' }],
          },
        ],
      },
    }, { spaces: 2 });
    await expect(validateBundleLayout(embeddedRoot)).rejects.toThrow(
      'claude.hooks.hooks.sessionStop',
    );
  });
});
