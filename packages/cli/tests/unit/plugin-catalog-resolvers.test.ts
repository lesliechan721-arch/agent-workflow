import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import {
  resolveActiveLocalBundle,
  resolveActiveLocalBundleFromInstallLocation,
  resolveCatalogPlugins,
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-extra-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  return { repoRoot, awHome, embeddedRoot };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin catalog resolvers', () => {
  it('falls back to the embedded catalog when local metadata matches but layout is broken', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.remove(path.join(awHome, '.claude-plugin', 'marketplace.json'));

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reason: expect.any(String),
    });
  });

  it('resolves catalog plugins and active local bundles from ~/.aw', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(resolveCatalogPlugins(['git-commit'], process.env)).resolves.toMatchObject({
      catalog: {
        rootDir: awHome,
        source: 'local',
      },
      plugins: [
        {
          manifest: {
            name: 'git-commit',
          },
        },
      ],
    });

    await expect(resolveActiveLocalBundle('git-commit', process.env)).resolves.toBe(
      path.join(awHome, 'plugins', 'git-commit'),
    );
    await expect(resolveActiveLocalBundle('missing-plugin', process.env)).resolves.toBeNull();
  });

  it('reports install-location manifest edge cases', async () => {
    const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-location-'));
    tempDirs.push(installRoot);

    await expect(
      resolveActiveLocalBundleFromInstallLocation('git-commit', 'claude', installRoot),
    ).resolves.toMatchObject({
      bundleRoot: null,
      details: expect.stringContaining('marketplace manifest 缺失'),
    });

    const manifestDir = path.join(installRoot, '.claude-plugin');
    const manifestPath = path.join(manifestDir, 'marketplace.json');
    await fs.ensureDir(manifestDir);

    await fs.writeJson(
      manifestPath,
      {
        name: 'aw',
        plugins: [
          {
            name: 'git-commit',
          },
        ],
      },
      { spaces: 2 },
    );
    await expect(
      resolveActiveLocalBundleFromInstallLocation('git-commit', 'claude', installRoot),
    ).resolves.toMatchObject({
      bundleRoot: null,
      details: 'marketplace manifest 缺少 git-commit 的 source。',
    });

    await fs.writeJson(
      manifestPath,
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
      resolveActiveLocalBundleFromInstallLocation('git-commit', 'claude', installRoot),
    ).resolves.toMatchObject({
      bundleRoot: null,
      details: `bundle 路径不存在: ${path.join(installRoot, 'plugins', 'git-commit')}`,
    });

    await fs.writeFile(manifestPath, '{ invalid json', 'utf8');
    await expect(
      resolveActiveLocalBundleFromInstallLocation('git-commit', 'claude', installRoot),
    ).resolves.toMatchObject({
      bundleRoot: null,
      details: expect.any(String),
    });
  });
});
