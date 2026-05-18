import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

async function buildCatalogPair(options: {
  sourceCatalogRoot: string;
  targetRoot: string;
  label: string;
  catalogVersion: string;
  channel: 'latest' | 'beta';
  minAwVersion: string;
  historyReleases?: Array<{
    catalogVersion: string;
    minAwVersion: string;
    plugins: Array<{
      name: string;
      version: string;
      minAwVersion: string;
      artifactDigest: string;
      manifestDigest: string;
    }>;
  }>;
}) {
  const sidecarRoot = path.join(options.targetRoot, `${options.label}-sidecar`);
  const fullRoot = path.join(options.targetRoot, `${options.label}-full`);
  await fs.copy(path.join(options.sourceCatalogRoot, '.catalog', 'sidecar'), sidecarRoot);
  await fs.copy(path.join(options.sourceCatalogRoot, '.catalog', 'full'), fullRoot);

  const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json'));
  const defaultHistoryReleases = [
    {
      catalogVersion: options.catalogVersion,
      minAwVersion: options.minAwVersion,
      plugins: manifest.entries.map((entry: {
        name: string;
        version: string;
        compatibility: { aw: { minVersion: string } };
        artifactDigest: string;
        manifestDigest: string;
      }) => ({
        name: entry.name,
        version: entry.version,
        minAwVersion: entry.compatibility.aw.minVersion,
        artifactDigest: entry.artifactDigest,
        manifestDigest: entry.manifestDigest,
      })),
    },
  ];

  manifest.catalogVersion = options.catalogVersion;
  manifest.channel = options.channel;
  manifest.compatibility.aw.minVersion = options.minAwVersion;
  manifest.packages.sidecar.version = options.catalogVersion;
  manifest.packages.sidecar.channel = options.channel;
  manifest.packages.full.version = options.catalogVersion;
  manifest.packages.full.channel = options.channel;
  manifest.history = {
    schemaVersion: 1,
    channel: options.channel,
    releases: options.historyReleases ?? defaultHistoryReleases,
  };

  await Promise.all([
    fs.writeJson(path.join(sidecarRoot, 'catalog-manifest.json'), manifest, { spaces: 2 }),
    fs.writeJson(path.join(fullRoot, 'catalog-manifest.json'), manifest, { spaces: 2 }),
  ]);

  const [sidecarPackageJson, fullPackageJson] = await Promise.all([
    fs.readJson(path.join(sidecarRoot, 'package.json')),
    fs.readJson(path.join(fullRoot, 'package.json')),
  ]);
  sidecarPackageJson.version = options.catalogVersion;
  sidecarPackageJson.awCatalog.channel = options.channel;
  sidecarPackageJson.awCatalog.compatibility.aw.minVersion = options.minAwVersion;
  fullPackageJson.version = options.catalogVersion;
  fullPackageJson.awCatalog.channel = options.channel;
  fullPackageJson.awCatalog.compatibility.aw.minVersion = options.minAwVersion;
  await Promise.all([
    fs.writeJson(path.join(sidecarRoot, 'package.json'), sidecarPackageJson, { spaces: 2 }),
    fs.writeJson(path.join(fullRoot, 'package.json'), fullPackageJson, { spaces: 2 }),
  ]);

  return {
    manifest,
    sidecarRoot,
    fullRoot,
  };
}

function packageKey(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

function createFakeCatalogPackageSource(options: {
  distTags: Partial<Record<'latest' | 'beta', string>>;
  manifestPackages: Record<string, { rootDir: string; manifest: Record<string, unknown>; failDownload?: string }>;
  fullPackages: Record<string, { rootDir: string; manifest: Record<string, unknown>; failDownload?: string }>;
  operations: string[];
}) {
  return {
    resolveIdentityByDistTag: async (packageName: string, distTag: 'latest' | 'beta') => {
      options.operations.push(`identity:${packageName}:${distTag}`);
      const version = options.distTags[distTag];
      if (!version) {
        throw new Error(`missing dist-tag ${distTag}`);
      }
      return {
        packageName,
        version,
        integrity: `${packageName}-${version}-integrity`,
        requestedDistTag: distTag,
      };
    },
    resolveIdentityByVersion: async (packageName: string, version: string) => {
      options.operations.push(`identity:${packageName}:${version}`);
      return {
        packageName,
        version,
        integrity: `${packageName}-${version}-integrity`,
      };
    },
    downloadArchive: async (identity: { packageName: string; version: string }) => {
      options.operations.push(`download:${identity.packageName}:${identity.version}`);
      const registry = identity.packageName === '@yiliang/aw-plugins-manifest'
        ? options.manifestPackages
        : options.fullPackages;
      const record = registry[packageKey(identity.packageName, identity.version)];
      if (!record) {
        throw new Error(`missing ${identity.packageName}@${identity.version}`);
      }
      if (record.failDownload) {
        throw new Error(record.failDownload);
      }

      const manifestText = await fs.readFile(path.join(record.rootDir, 'catalog-manifest.json'), 'utf8');
      return {
        identity,
        manifestText,
        rawManifest: record.manifest,
        packageRoot: record.rootDir,
        materialize: async (targetRoot: string) => {
          await fs.copy(record.rootDir, targetRoot);
        },
        dispose: async () => {},
      };
    },
  };
}

afterEach(async () => {
  const distMarketplacePath = path.join(
    repoRoot(),
    'packages',
    'cli',
    'dist',
    'src',
    'utils',
    'marketplace.js',
  );
  if (await fs.pathExists(distMarketplacePath)) {
    const distMarketplace = await import(pathToFileURL(distMarketplacePath).href) as {
      setCatalogPackageSourceForTests: (source: unknown) => void;
    };
    distMarketplace.setCatalogPackageSourceForTests(null);
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('catalog fetch smoke', () => {
  it('resolves sidecar before full and falls back to current catalog cache on later full download failure', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    const distPluginCatalog = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'plugin-catalog.js')).href,
    ) as {
      resolveCurrentCatalog: (env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
    };
    const distMarketplace = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'marketplace.js')).href,
    ) as {
      setCatalogPackageSourceForTests: (source: unknown) => void;
    };

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-fetch-cache-smoke-'));
    tempDirs.push(tempRoot);
    const stagedManifest = await fs.readJson(
      path.join(root, 'packages', 'cli', 'plugins-dist', '.catalog', 'sidecar', 'catalog-manifest.json'),
    ) as {
      catalogVersion: string;
      channel: 'latest' | 'beta';
      compatibility: {
        aw: {
          minVersion: string;
        };
      };
    };
    const operations: string[] = [];
    const fullRecord = {
      rootDir: path.join(root, 'packages', 'cli', 'plugins-dist', '.catalog', 'full'),
      manifest: stagedManifest as Record<string, unknown>,
    };
    const source = createFakeCatalogPackageSource({
      distTags: {
        [stagedManifest.channel]: stagedManifest.catalogVersion,
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', stagedManifest.catalogVersion)]: {
          rootDir: path.join(root, 'packages', 'cli', 'plugins-dist', '.catalog', 'sidecar'),
          manifest: stagedManifest as Record<string, unknown>,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', stagedManifest.catalogVersion)]: fullRecord,
      },
      operations,
    });
    distMarketplace.setCatalogPackageSourceForTests(source);

    const env = {
      ...process.env,
      AW_HOME: path.join(tempRoot, 'aw-home'),
      AW_CLI_VERSION: stagedManifest.compatibility.aw.minVersion,
      AW_CATALOG_CHANNEL: stagedManifest.channel,
    };
    const firstResolution = await distPluginCatalog.resolveCurrentCatalog(env);
    expect(firstResolution).toMatchObject({
      source: 'remote',
      channel: stagedManifest.channel,
      catalogVersion: stagedManifest.catalogVersion,
      cacheFallback: {
        used: false,
      },
    });
    expect(operations).toEqual([
      `identity:@yiliang/aw-plugins-manifest:${stagedManifest.channel}`,
      `download:@yiliang/aw-plugins-manifest:${stagedManifest.catalogVersion}`,
      `identity:@yiliang/aw-plugins:${stagedManifest.catalogVersion}`,
      `download:@yiliang/aw-plugins:${stagedManifest.catalogVersion}`,
    ]);

    operations.length = 0;
    fullRecord.failDownload = 'simulated full tarball outage';
    const cachedResolution = await distPluginCatalog.resolveCurrentCatalog(env);
    expect(cachedResolution).toMatchObject({
      source: 'cache',
      channel: stagedManifest.channel,
      catalogVersion: stagedManifest.catalogVersion,
      cacheFallback: {
        used: true,
        source: 'currentCatalogCache',
        blockingCode: 'catalogUnavailable',
      },
      remoteFailure: {
        stage: 'fullTarball',
      },
    });
    expect(operations).toEqual([
      `identity:@yiliang/aw-plugins-manifest:${stagedManifest.channel}`,
      `download:@yiliang/aw-plugins-manifest:${stagedManifest.catalogVersion}`,
      `identity:@yiliang/aw-plugins:${stagedManifest.catalogVersion}`,
      `download:@yiliang/aw-plugins:${stagedManifest.catalogVersion}`,
    ]);
  });

  it('uses sidecar history to fall back from incompatible latest to a compatible historical catalog', async () => {
    const root = repoRoot();
    await execFileAsync('pnpm', ['build'], {
      cwd: root,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });

    const distPluginCatalog = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'plugin-catalog.js')).href,
    ) as {
      resolveCurrentCatalog: (env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
    };
    const distMarketplace = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'marketplace.js')).href,
    ) as {
      setCatalogPackageSourceForTests: (source: unknown) => void;
    };

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-fetch-history-smoke-'));
    tempDirs.push(tempRoot);
    const compatible = await buildCatalogPair({
      sourceCatalogRoot: path.join(root, 'packages', 'cli', 'plugins-dist'),
      targetRoot: tempRoot,
      label: 'compatible',
      catalogVersion: '0.9.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const blocked = await buildCatalogPair({
      sourceCatalogRoot: path.join(root, 'packages', 'cli', 'plugins-dist'),
      targetRoot: tempRoot,
      label: 'blocked',
      catalogVersion: '1.5.0',
      channel: 'latest',
      minAwVersion: '2.0.0',
      historyReleases: [
        compatible.manifest.history.releases[0],
        {
          catalogVersion: '1.5.0',
          minAwVersion: '2.0.0',
          plugins: compatible.manifest.history.releases[0].plugins,
        },
      ],
    });

    const operations: string[] = [];
    distMarketplace.setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '1.5.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '1.5.0')]: {
          rootDir: blocked.sidecarRoot,
          manifest: blocked.manifest as Record<string, unknown>,
        },
        [packageKey('@yiliang/aw-plugins-manifest', '0.9.0')]: {
          rootDir: compatible.sidecarRoot,
          manifest: compatible.manifest as Record<string, unknown>,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '0.9.0')]: {
          rootDir: compatible.fullRoot,
          manifest: compatible.manifest as Record<string, unknown>,
        },
      },
      operations,
    }));

    const resolution = await distPluginCatalog.resolveCurrentCatalog({
      ...process.env,
      AW_HOME: path.join(tempRoot, 'aw-home'),
      AW_CLI_VERSION: '1.0.0',
      AW_CATALOG_CHANNEL: 'latest',
    });

    expect(resolution).toMatchObject({
      source: 'remote',
      channel: 'latest',
      catalogVersion: '0.9.0',
      latestCatalogBlocked: {
        channel: 'latest',
        catalogVersion: '1.5.0',
        minAwVersion: '2.0.0',
      },
      fullCatalog: {
        resolutionSource: 'historyCompatibleCatalog',
      },
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.5.0',
      'identity:@yiliang/aw-plugins-manifest:0.9.0',
      'download:@yiliang/aw-plugins-manifest:0.9.0',
      'identity:@yiliang/aw-plugins:0.9.0',
      'download:@yiliang/aw-plugins:0.9.0',
    ]);
  });
});
