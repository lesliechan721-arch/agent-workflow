import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createBundleSourceManifest,
  createMarketplaceManifest,
  createMarketplaceManifestEntry,
  createPlatformManifestBase,
  discoverPlugins,
  discoverPluginsInDirectory,
  resolvePlugins,
  resolvePluginsFromCatalog,
  validateCatalogManifest,
  validateMarketplaceSourceMeta,
  validatePluginManifest,
} from '../../src/utils/manifest.js';
import type { PluginMeta } from '../../src/types.js';
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

async function makeTempRepo(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-manifest-coverage-'));
  tempDirs.push(tempDir);
  await fs.copy(fixturePath('repo-template'), tempDir);
  return tempDir;
}

function createPluginMeta(manifest: PluginMeta['manifest']): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest,
  };
}

function sha256(char: string): string {
  return `sha256:${char.repeat(64)}`;
}

function createCatalogManifestFixture() {
  return {
    schemaVersion: 1,
    catalogVersion: '1.2.3',
    channel: 'latest',
    compatibility: {
      aw: {
        minVersion: '0.0.0',
      },
    },
    history: {
      schemaVersion: 1,
      channel: 'latest',
      releases: [
        {
          catalogVersion: '1.2.3',
          minAwVersion: '0.0.0',
          plugins: [
            {
              name: 'demo',
              version: '1.2.0',
              minAwVersion: '0.0.0',
              artifactDigest: sha256('a'),
              manifestDigest: sha256('b'),
            },
          ],
        },
      ],
    },
    packages: {
      sidecar: {
        name: '@yiliang/aw-plugins-manifest',
        version: '1.2.3',
        channel: 'latest',
      },
      full: {
        name: '@yiliang/aw-plugins',
        version: '1.2.3',
        channel: 'latest',
        manifestPath: './catalog-manifest.json',
      },
    },
    entries: [
      {
        name: 'demo',
        version: '1.2.0',
        description: 'demo plugin',
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
        compatibility: {
          aw: {
            minVersion: '0.0.0',
          },
        },
        source: './plugins/demo',
        artifactDigest: sha256('a'),
        manifestDigest: sha256('b'),
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('manifest coverage', () => {
  it('accepts object-based channels and rejects plugin paths that escape the root', () => {
    const manifest = validatePluginManifest('/tmp/plugin', {
      name: 'demo-object-channels',
      version: '0.1.0',
      description: 'demo',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      buildConfig: {
        manifestOverrides: {
          claude: {
            lspServers: './config/lsp.json',
            channels: {
              default: true,
            },
          },
        },
      },
    });

    expect(manifest.buildConfig?.manifestOverrides?.claude).toMatchObject({
      lspServers: './config/lsp.json',
      channels: {
        default: true,
      },
    });

    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'bad-demo',
        version: '0.1.0',
        description: 'demo',
        skills: './../skills',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      }),
    ).toThrow('path must stay inside the plugin root');

    expect(() =>
      validatePluginManifest('/tmp/plugin', {
        name: 'bad-demo-abs',
        version: '0.1.0',
        description: 'demo',
        apps: '/tmp/apps.json',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      }),
    ).toThrow('absolute paths are not allowed');
  });

  it('discovers, resolves, and selects plugins from repo and catalog directories', async () => {
    const repoRoot = await makeTempRepo();
    const alphaRoot = path.join(repoRoot, 'plugins', 'alpha-note');
    await fs.ensureDir(path.join(alphaRoot, '.agents-plugin'));
    await fs.writeJson(
      path.join(alphaRoot, '.agents-plugin', 'plugin.json'),
      {
        name: 'alpha-note',
        version: '0.1.0',
        description: 'alpha plugin',
        marketplace: {
          category: 'workflow',
          strict: true,
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
        },
      },
      { spaces: 2 },
    );
    await fs.ensureDir(path.join(repoRoot, 'plugins', 'ignored-dir'));

    await expect(
      discoverPluginsInDirectory(path.join(repoRoot, 'missing')),
    ).resolves.toEqual([]);

    await expect(discoverPluginsInDirectory(path.join(repoRoot, 'plugins'))).resolves.toMatchObject([
      {
        manifest: {
          name: 'alpha-note',
        },
      },
      {
        manifest: {
          name: 'git-commit',
        },
      },
    ]);

    await expect(discoverPlugins(repoRoot)).resolves.toMatchObject([
      {
        manifest: {
          name: 'alpha-note',
        },
      },
      {
        manifest: {
          name: 'git-commit',
        },
      },
    ]);

    await expect(resolvePlugins(repoRoot, ['git-commit', 'alpha-note'])).resolves.toMatchObject([
      {
        manifest: {
          name: 'git-commit',
        },
      },
      {
        manifest: {
          name: 'alpha-note',
        },
      },
    ]);

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    await expect(resolvePluginsFromCatalog(embeddedRoot, ['missing-plugin'])).rejects.toThrow(
      'Unknown plugin "missing-plugin".',
    );
  });

  it('preserves nativeHooks through the embedded bundle catalog', async () => {
    const repoRoot = await makeTempRepo();
    const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const manifest = await fs.readJson(manifestPath);

    manifest.extensions ??= {};
    manifest.extensions.nativeHooks = {
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    };
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);

    const [plugin] = await resolvePluginsFromCatalog(embeddedRoot, ['git-commit']);

    expect(plugin.manifest.extensions?.nativeHooks).toEqual({
      claude: [
        {
          event: 'Notification',
          matcher: '*',
          command: 'echo claude notification',
        },
      ],
      codex: [
        {
          event: 'UserPromptSubmit',
          command: 'echo codex prompt',
        },
      ],
    });
    await expect(
      fs.readJson(path.join(embeddedRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'Notification',
              matcher: '*',
              command: 'echo claude notification',
            },
          ],
          codex: [
            {
              event: 'UserPromptSubmit',
              command: 'echo codex prompt',
            },
          ],
        },
      },
    });
  });

  it('rejects invalid catalog manifest channel, prerelease, digest, package identity, and history contracts', () => {
    const missingHistory = createCatalogManifestFixture();
    delete (missingHistory as Record<string, unknown>).history;
    expect(() => validateCatalogManifest(missingHistory)).toThrow('expected an object');

    const badHistorySchema = createCatalogManifestFixture();
    badHistorySchema.history.schemaVersion = 2;
    expect(() => validateCatalogManifest(badHistorySchema)).toThrow('history.schemaVersion');

    const badDigest = createCatalogManifestFixture();
    badDigest.entries[0]!.manifestDigest = 'sha256:not-hex';
    badDigest.history.releases[0]!.plugins[0]!.manifestDigest = 'sha256:not-hex';
    expect(() => validateCatalogManifest(badDigest)).toThrow('manifestDigest');

    const mismatchedPackageIdentity = createCatalogManifestFixture();
    mismatchedPackageIdentity.packages.full.version = '1.2.4';
    expect(() => validateCatalogManifest(mismatchedPackageIdentity)).toThrow('packages.full.version');

    const betaStableCatalog = createCatalogManifestFixture();
    betaStableCatalog.channel = 'beta';
    betaStableCatalog.history.channel = 'beta';
    betaStableCatalog.packages.sidecar.channel = 'beta';
    betaStableCatalog.packages.full.channel = 'beta';
    betaStableCatalog.history.releases[0]!.catalogVersion = '1.2.3';
    expect(() => validateCatalogManifest(betaStableCatalog)).toThrow('beta catalog requires a prerelease catalog version');
  });

  it('rejects plugin minVersion and duplicate snapshot names that violate catalog bounds', () => {
    const pluginMinAboveCatalog = createCatalogManifestFixture();
    pluginMinAboveCatalog.entries[0]!.compatibility.aw.minVersion = '0.0.1';
    pluginMinAboveCatalog.history.releases[0]!.plugins[0]!.minAwVersion = '0.0.1';
    pluginMinAboveCatalog.compatibility.aw.minVersion = '0.0.0';
    pluginMinAboveCatalog.history.releases[0]!.minAwVersion = '0.0.0';
    expect(() => validateCatalogManifest(pluginMinAboveCatalog)).toThrow('higher than catalog minimum');

    const duplicateEntry = createCatalogManifestFixture();
    duplicateEntry.entries.push(structuredClone(duplicateEntry.entries[0]!));
    expect(() => validateCatalogManifest(duplicateEntry)).toThrow('duplicate plugin "demo"');
  });

});
