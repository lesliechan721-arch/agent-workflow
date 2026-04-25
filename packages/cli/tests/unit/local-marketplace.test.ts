import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  calculateBundleFingerprint,
  initializeLocalMarketplace,
  readInstalledLedger,
  validateLocalMarketplaceLayout,
} from '../../src/utils/local-marketplace.js';
import { readJsonFile } from '../../src/utils/json.js';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-marketplace-'));
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

describe('local marketplace', () => {
  it('initializes ~/.aw from the embedded bundle and preserves a valid ledger on refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeJson(
      path.join(awHome, 'installed.json'),
      {
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {},
          },
        },
      },
      { spaces: 2 },
    );

    const beforeFingerprint = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed\n',
      'utf8',
    );

    await initializeLocalMarketplace({ force: true, env: process.env });

    const afterConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    const preservedLedger = await readJsonFile(path.join(awHome, 'installed.json'));

    expect(afterConfig.bundleFingerprint).not.toBe(beforeFingerprint.bundleFingerprint);
    expect(preservedLedger).toMatchObject({
      ledgerState: {
        status: 'available',
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
        },
      },
    });
  });

  it('repairs a corrupted local marketplace layout during force init', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const marketplacePath = path.join(awHome, '.claude-plugin', 'marketplace.json');
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins[0].source = './plugins/broken';
    await fs.writeJson(marketplacePath, marketplace, { spaces: 2 });

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('rebuilds ~/.aw when config.json is malformed during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('rebuilds ~/.aw when config.json uses an unsupported schema version during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.version = 2;
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('treats an invalid source manifest as an unhealthy local marketplace layout', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(
      path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );

    await expect(validateLocalMarketplaceLayout(awHome)).rejects.toThrow();
  });

  it('returns a degraded ledger when installed.json contains malformed JSON', async () => {
    const { awHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":', 'utf8');

    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
  });

  it('writes a degraded ledger when the previous installed.json is missing or invalid', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":"broken"}', 'utf8');

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(readJsonFile(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
    await expect(calculateBundleFingerprint(awHome)).resolves.toMatch(/^sha256:/);
  });
});
