import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';
import { installCurrentSmokeDistIsolationBridge } from '../setup/test-isolation-smoke.js';
import { execPnpmForTest } from '../helpers/pnpm.js';

const tempDirs: string[] = [];
let cliBuildPromise: Promise<void> | null = null;

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

function registerSmokeWritableRoot(rootPath: string, source: string): string {
  return registerCurrentTestWritableStateRoot(rootPath, source);
}

async function createSmokeTempRoot(prefix: string, source: string): Promise<string> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(rootPath);
  return registerSmokeWritableRoot(rootPath, source);
}

async function buildCli(root: string): Promise<void> {
  await execPnpmForTest(['build'], {
    cwd: root,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function ensureBuiltCli(root: string): Promise<void> {
  cliBuildPromise ??= buildCli(root);
  await cliBuildPromise;
  await installCurrentSmokeDistIsolationBridge();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('catalog fetch smoke', () => {
  it('keeps smoke dist guards active for repo dist imports after rebuilding dist', async () => {
    const root = repoRoot();
    await ensureBuiltCli(root);

    const distMarketplace = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'marketplace.js')).href,
    ) as {
      hasCatalogPackageSourceOverrideForTests: () => boolean;
    };
    const distPaths = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'paths.js')).href,
    ) as {
      getEmbeddedPluginsRootOverrideForTests: () => string | null;
      resolveAwHome: (env?: NodeJS.ProcessEnv) => string;
    };
    const distNativeCli = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'native-cli.js')).href,
    ) as {
      runNativeCli: (invocation: {
        command: string;
        args: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      }) => Promise<unknown>;
    };
    const distCodexAppServer = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'codex-app-server-client.js')).href,
    ) as {
      installCodexPluginViaAppServer: (options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
        marketplacePath: string;
        pluginName: string;
      }) => Promise<unknown>;
    };

    expect(distMarketplace.hasCatalogPackageSourceOverrideForTests()).toBe(false);
    expect(distPaths.getEmbeddedPluginsRootOverrideForTests()).toBeNull();
    expect(() => distPaths.resolveAwHome({
      ...process.env,
      AW_HOME: path.join(root, 'packages', 'cli', 'dist', '.aw-smoke-readonly'),
    })).toThrow('Unsafe test write path');
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    const guardedFetch = globalThis.fetch as typeof fetch;
    await expect(guardedFetch('https://example.com')).rejects.toThrow('Network access is disabled in tests.');
    await expect(distNativeCli.runNativeCli({
      command: 'codex',
      args: ['--version'],
      cwd: process.cwd(),
      env: process.env,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'codex-cli 0.145.0',
      stderr: '',
    });
    await expect(distNativeCli.runNativeCli({
      command: 'codex',
      args: ['plugin', 'list'],
      cwd: process.cwd(),
      env: process.env,
    })).rejects.toThrow('测试默认禁止真实 native CLI 调用');
    await expect(distCodexAppServer.installCodexPluginViaAppServer({
      cwd: process.cwd(),
      env: process.env,
      marketplacePath: path.join(process.cwd(), 'fake-marketplace'),
      pluginName: 'git-commit',
    })).rejects.toThrow('测试默认禁止启动真实 `codex app-server`');
  });

  it('resolves sidecar before full and reuses current catalog cache before a later full download', async () => {
    const root = repoRoot();
    await ensureBuiltCli(root);

    const distPluginCatalog = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'plugin-catalog.js')).href,
    ) as {
      clearCurrentCatalogResolutionMemoForTests: () => void;
      resolveCurrentCatalog: (env?: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>;
    };
    const distMarketplace = await import(
      pathToFileURL(path.join(root, 'packages', 'cli', 'dist', 'src', 'utils', 'marketplace.js')).href,
    ) as {
      setCatalogPackageSourceForTests: (source: unknown) => void;
    };

    const tempRoot = await createSmokeTempRoot(
      'aw-fetch-cache-smoke-',
      'catalog fetch smoke cache temp root',
    );
    registerSmokeWritableRoot(path.join(tempRoot, 'aw-home'), 'catalog fetch smoke cache AW_HOME');
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
    distPluginCatalog.clearCurrentCatalogResolutionMemoForTests();
    const cachedResolution = await distPluginCatalog.resolveCurrentCatalog(env);
    expect(cachedResolution).toMatchObject({
      source: 'cache',
      channel: stagedManifest.channel,
      catalogVersion: stagedManifest.catalogVersion,
      cacheFallback: {
        used: false,
      },
    });
    expect(cachedResolution.remoteFailure).toBeUndefined();
    expect(operations).toEqual([
      `identity:@yiliang/aw-plugins-manifest:${stagedManifest.channel}`,
      `download:@yiliang/aw-plugins-manifest:${stagedManifest.catalogVersion}`,
      `identity:@yiliang/aw-plugins:${stagedManifest.catalogVersion}`,
    ]);
  });

  it('uses sidecar history to fall back from incompatible latest to a compatible historical catalog', async () => {
    const root = repoRoot();
    await ensureBuiltCli(root);

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

    const tempRoot = await createSmokeTempRoot(
      'aw-fetch-history-smoke-',
      'catalog fetch smoke history temp root',
    );
    registerSmokeWritableRoot(path.join(tempRoot, 'aw-home'), 'catalog fetch smoke history AW_HOME');
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
