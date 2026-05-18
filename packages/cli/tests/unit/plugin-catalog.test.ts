import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeLocalMarketplace } from '../../src/utils/local-marketplace.js';
import { resolveCurrentCatalog } from '../../src/utils/plugin-catalog.js';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-'));
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

describe('plugin catalog', () => {
  it('prefers a fresh ~/.aw catalog', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: awHome,
      source: 'local',
    });
  });

  it('falls back to the embedded root when ~/.aw is stale or unhealthy', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.bundleFingerprint = 'sha256:stale';
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogFingerprintMismatch',
    });
  });

  it('falls back to the embedded root when local config.json is malformed', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogConfigInvalid',
    });
  });

  it('falls back to the embedded root when local config.json uses an unsupported schema version', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.version = 2;
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogConfigInvalid',
    });
  });

  it('falls back to the embedded root when a local source manifest is unreadable', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(
      path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogLayoutInvalid',
    });
  });

  it('falls back to the embedded root when local sourceVersion is ahead of the current CLI', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.sourceVersion = '999.0.0';
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogSourceVersionAhead',
    });
  });

  it('falls back to the embedded root when local sourceVersion is not strict SemVer', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.sourceVersion = 'latest';
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(resolveCurrentCatalog(process.env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      reasonCode: 'localCatalogSourceVersionInvalid',
    });
  });
});
