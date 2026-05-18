import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stageCatalogArtifacts } from '../../scripts/plugin-staging.js';
import type { CatalogChannel } from '../../src/types.js';
import { resolvePluginsFromCatalog } from '../../src/utils/manifest.js';
import {
  resolveCurrentCatalog,
  resolveCatalogPlugins,
} from '../../src/utils/plugin-catalog.js';
import {
  calculateCatalogEntryDigestsFromRoot,
} from '../../src/utils/catalog-digests.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import {
  setCatalogPackageSourceForTests,
  type CatalogPackageArchiveIdentity,
  type CatalogPackageSource,
} from '../../src/utils/marketplace.js';
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

async function makeRepoWorkspace(): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-resolver-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);

  return {
    repoRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLI_VERSION: '1.0.0',
    },
  };
}

async function createValidCatalogPackage(options: {
  repoRoot: string;
  catalogVersion: string;
  channel: CatalogChannel;
  minAwVersion: string;
}): Promise<{
  fullRoot: string;
  sidecarRoot: string;
  manifest: Record<string, unknown>;
}> {
  const fullRoot = await createSyntheticEmbeddedRoot(options.repoRoot);
  tempDirs.push(fullRoot);
  const plugins = await resolvePluginsFromCatalog(fullRoot, undefined);
  const entries = await Promise.all(plugins.map(async (plugin) => {
    const pluginRoot = path.join(fullRoot, 'plugins', plugin.manifest.name);
    const digests = await calculateCatalogEntryDigestsFromRoot(pluginRoot);
    return {
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      ...(plugin.manifest.interface ? { interface: plugin.manifest.interface } : {}),
      category: plugin.manifest.marketplace.category,
      ...(plugin.manifest.marketplace.tags ? { tags: plugin.manifest.marketplace.tags } : {}),
      strict: plugin.manifest.marketplace.strict,
      policy: plugin.manifest.marketplace.policy,
      compatibility: plugin.manifest.compatibility,
      ...(plugin.manifest.dependencies ? { dependencies: plugin.manifest.dependencies } : {}),
      source: `./plugins/${plugin.manifest.name}`,
      artifactDigest: digests.artifactDigest,
      manifestDigest: digests.manifestDigest,
    };
  }));
  const manifest = {
    schemaVersion: 1,
    catalogVersion: options.catalogVersion,
    channel: options.channel,
    compatibility: {
      aw: {
        minVersion: options.minAwVersion,
      },
    },
    history: {
      schemaVersion: 1,
      channel: options.channel,
      releases: [{
        catalogVersion: options.catalogVersion,
        minAwVersion: options.minAwVersion,
        plugins: entries.map((entry) => ({
          name: entry.name,
          version: entry.version,
          minAwVersion: (entry.compatibility as { aw: { minVersion: string } }).aw.minVersion,
          artifactDigest: entry.artifactDigest,
          manifestDigest: entry.manifestDigest,
        })),
      }],
    },
    packages: {
      sidecar: {
        name: '@yiliang/aw-plugins-manifest',
        version: options.catalogVersion,
        channel: options.channel,
      },
      full: {
        name: '@yiliang/aw-plugins',
        version: options.catalogVersion,
        channel: options.channel,
        manifestPath: './catalog-manifest.json',
      },
    },
    entries,
  };

  await fs.writeJson(path.join(fullRoot, 'catalog-manifest.json'), manifest, { spaces: 2 });
  const sidecarRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-sidecar-'));
  tempDirs.push(sidecarRoot);
  await fs.writeJson(path.join(sidecarRoot, 'catalog-manifest.json'), manifest, { spaces: 2 });

  return {
    fullRoot,
    sidecarRoot,
    manifest,
  };
}

function createIncompatibleLatestSidecar(options: {
  catalogVersion: string;
  minAwVersion: string;
  fallbackVersion: string;
  fallbackMinAwVersion: string;
  channel: CatalogChannel;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    catalogVersion: options.catalogVersion,
    channel: options.channel,
    compatibility: {
      aw: {
        minVersion: options.minAwVersion,
      },
    },
    history: {
      schemaVersion: 1,
      channel: options.channel,
      releases: [
        {
          catalogVersion: options.fallbackVersion,
          minAwVersion: options.fallbackMinAwVersion,
          plugins: [],
        },
        {
          catalogVersion: options.catalogVersion,
          minAwVersion: options.minAwVersion,
          plugins: [],
        },
      ],
    },
    packages: {
      sidecar: {
        name: '@yiliang/aw-plugins-manifest',
        version: options.catalogVersion,
        channel: options.channel,
      },
      full: {
        name: '@yiliang/aw-plugins',
        version: options.catalogVersion,
        channel: options.channel,
        manifestPath: './catalog-manifest.json',
      },
    },
    entries: [],
  };
}

interface FakePackageRecord {
  identity: CatalogPackageArchiveIdentity;
  rootDir?: string;
  manifest: Record<string, unknown>;
  failDownload?: string;
}

function packageKey(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

function createFakeCatalogPackageSource(options: {
  distTags?: Partial<Record<CatalogChannel, string>>;
  manifestPackages?: Record<string, FakePackageRecord>;
  fullPackages?: Record<string, FakePackageRecord>;
}): CatalogPackageSource {
  const manifestPackages = options.manifestPackages ?? {};
  const fullPackages = options.fullPackages ?? {};

  return {
    resolveIdentityByDistTag: async (packageName, distTag) => {
      const version = options.distTags?.[distTag];
      if (!version) {
        throw new Error(`missing dist-tag ${distTag}`);
      }
      const record = manifestPackages[packageKey(packageName, version)];
      if (!record) {
        throw new Error(`missing ${packageName}@${version}`);
      }
      return record.identity;
    },
    resolveIdentityByVersion: async (packageName, version) => {
      const record = (packageName === '@yiliang/aw-plugins-manifest' ? manifestPackages : fullPackages)[packageKey(packageName, version)];
      if (!record) {
        throw new Error(`missing ${packageName}@${version}`);
      }
      return record.identity;
    },
    downloadArchive: async (identity) => {
      const record = (identity.packageName === '@yiliang/aw-plugins-manifest' ? manifestPackages : fullPackages)[packageKey(identity.packageName, identity.version)];
      if (!record) {
        throw new Error(`missing ${identity.packageName}@${identity.version}`);
      }
      if (record.failDownload) {
        throw new Error(record.failDownload);
      }

      const rootDir = record.rootDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-archive-'));
      if (!record.rootDir) {
        tempDirs.push(rootDir);
        await fs.writeJson(path.join(rootDir, 'catalog-manifest.json'), record.manifest, { spaces: 2 });
      }
      const manifestText = await fs.readFile(path.join(rootDir, 'catalog-manifest.json'), 'utf8');

      return {
        identity: record.identity,
        manifestText,
        rawManifest: record.manifest,
        packageRoot: rootDir,
        materialize: async (targetRoot: string) => {
          await fs.copy(rootDir, targetRoot);
        },
        dispose: async () => {},
      };
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setCatalogPackageSourceForTests(null);
  delete process.env.AW_CLI_VERSION;
  delete process.env.AW_CATALOG_CHANNEL;
  delete process.env.AW_CATALOG_VERSION;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin catalog resolvers', () => {
  it('keeps staging digests aligned with runtime validation for the same plugin', async () => {
    const { repoRoot } = await makeRepoWorkspace();
    const outputRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(outputRoot);

    const staged = await stageCatalogArtifacts({
      repoRoot,
      outputRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
    });
    const manifest = await fs.readJson(staged.canonicalManifestPath) as {
      entries: Array<{
        name: string;
        source: string;
        artifactDigest: string;
        manifestDigest: string;
      }>;
    };
    const gitCommitEntry = manifest.entries.find((entry) => entry.name === 'git-commit');

    expect(gitCommitEntry).toBeDefined();
    const runtimeDigests = await calculateCatalogEntryDigestsFromRoot(
      path.join(staged.fullPackageRoot, gitCommitEntry!.source),
    );
    expect(runtimeDigests).toEqual({
      artifactDigest: gitCommitEntry!.artifactDigest,
      manifestDigest: gitCommitEntry!.manifestDigest,
    });
  });

  it('uses history to resolve the latest compatible catalog on the same channel', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const compatiblePackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const blockedLatestManifest = createIncompatibleLatestSidecar({
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
      fallbackVersion: '1.0.0',
      fallbackMinAwVersion: '1.0.0',
      channel: 'latest',
    });
    const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-blocked-'));
    tempDirs.push(blockedRoot);
    await fs.writeJson(path.join(blockedRoot, 'catalog-manifest.json'), blockedLatestManifest, { spaces: 2 });

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '2.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-latest',
            requestedDistTag: 'latest',
          },
          rootDir: blockedRoot,
          manifest: blockedLatestManifest,
        },
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0',
            integrity: 'sha512-sidecar-1',
          },
          rootDir: compatiblePackage.sidecarRoot,
          manifest: compatiblePackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          rootDir: compatiblePackage.fullRoot,
          manifest: compatiblePackage.manifest,
        },
      },
    }));

    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      source: 'remote',
      channel: 'latest',
      catalogVersion: '1.0.0',
      minAwVersion: '1.0.0',
      latestCatalogBlocked: {
        catalogVersion: '2.0.0',
        minAwVersion: '9.0.0',
      },
    });

    await expect(resolveCatalogPlugins(['git-commit'], env)).resolves.toMatchObject({
      catalog: {
        catalogVersion: '1.0.0',
      },
      plugins: [{
        manifest: {
          name: 'git-commit',
        },
      }],
    });
  });

  it('falls back to a matching cache entry only after the catalog identity is resolved', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '1.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0',
            integrity: 'sha512-sidecar-1',
            requestedDistTag: 'latest',
          },
          rootDir: catalogPackage.sidecarRoot,
          manifest: catalogPackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          rootDir: catalogPackage.fullRoot,
          manifest: catalogPackage.manifest,
        },
      },
    }));

    const seeded = await resolveCurrentCatalog(env);
    expect(seeded.source).toBe('remote');

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '1.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0',
            integrity: 'sha512-sidecar-1',
            requestedDistTag: 'latest',
          },
          rootDir: catalogPackage.sidecarRoot,
          manifest: catalogPackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          manifest: catalogPackage.manifest,
          failDownload: 'simulated full tarball failure',
        },
      },
    }));

    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      source: 'cache',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: true,
      },
      remoteFailure: {
        stage: 'fullTarball',
      },
    });
  });

  it('returns a readable validated remote root when cache persistence fails', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '1.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0',
            integrity: 'sha512-sidecar-1',
            requestedDistTag: 'latest',
          },
          rootDir: catalogPackage.sidecarRoot,
          manifest: catalogPackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          rootDir: catalogPackage.fullRoot,
          manifest: catalogPackage.manifest,
        },
      },
    }));

    vi.spyOn(localMarketplaceModule, 'writeCurrentCatalogCacheEntry').mockRejectedValueOnce(
      new Error('simulated cache write failure'),
    );

    const resolution = await resolveCurrentCatalog(env);
    expect(resolution).toMatchObject({
      source: 'remote',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: false,
      },
    });
    expect(resolution.reason).toContain('simulated cache write failure');
    await expect(fs.pathExists(resolution.rootDir)).resolves.toBe(true);
    await expect(fs.readFile(path.join(resolution.rootDir, 'catalog-manifest.json'), 'utf8')).resolves.toContain('"catalogVersion": "1.0.0"');

    await expect(resolvePluginsFromCatalog(resolution.rootDir, ['git-commit'])).resolves.toMatchObject([
      {
        manifest: {
          name: 'git-commit',
        },
      },
    ]);
  });

  it('does not reuse a cache entry from another selector or channel', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const betaEnv = {
      ...env,
      AW_CLI_VERSION: '1.0.0-beta.1',
    };
    const betaPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0-beta.1',
      channel: 'beta',
      minAwVersion: '1.0.0-beta.1',
    });
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        beta: '1.0.0-beta.1',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0-beta.1')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0-beta.1',
            integrity: 'sha512-sidecar-beta',
            requestedDistTag: 'beta',
          },
          rootDir: betaPackage.sidecarRoot,
          manifest: betaPackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0-beta.1')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0-beta.1',
            integrity: 'sha512-full-beta',
          },
          rootDir: betaPackage.fullRoot,
          manifest: betaPackage.manifest,
        },
      },
    }));
    await resolveCurrentCatalog(betaEnv);

    const stablePackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '1.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '1.0.0',
            integrity: 'sha512-sidecar-stable',
            requestedDistTag: 'latest',
          },
          rootDir: stablePackage.sidecarRoot,
          manifest: stablePackage.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-stable',
          },
          manifest: stablePackage.manifest,
          failDownload: 'stable full tarball offline',
        },
      },
    }));

    await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
      resolution: {
        reasonCode: 'catalogUnavailable',
        cacheFallback: {
          used: false,
        },
      },
    });
  });
});
