import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { stageCatalogArtifacts } from '../../scripts/plugin-staging.js';
import type { CatalogChannel, CatalogResolution } from '../../src/types.js';
import { resolvePluginsFromCatalog } from '../../src/utils/manifest.js';
import {
  clearCurrentCatalogResolutionMemoForTests,
  resolveCurrentCatalog,
  resolveCatalogPlugins,
} from '../../src/utils/plugin-catalog.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import {
  calculateCatalogEntryDigestsFromRoot,
} from '../../src/utils/catalog-digests.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import {
  setCatalogPackageSourceForTests,
  type CatalogPackageArchiveIdentity,
  type CatalogPackageSource,
} from '../../src/utils/marketplace.js';
import {
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { initCommand } from '../../src/commands/init.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];
const originalCwd = process.cwd();

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
    schemaVersion: 2,
    catalogVersion: options.catalogVersion,
    channel: options.channel,
    compatibility: {
      aw: {
        minVersion: options.minAwVersion,
      },
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
    schemaVersion: 2,
    catalogVersion: options.catalogVersion,
    channel: options.channel,
    compatibility: {
      aw: {
        minVersion: options.minAwVersion,
      },
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
  operations?: string[];
}): CatalogPackageSource {
  const manifestPackages = options.manifestPackages ?? {};
  const fullPackages = options.fullPackages ?? {};

  return {
    resolveIdentityByDistTag: async (packageName, distTag) => {
      options.operations?.push(`identity:${packageName}:${distTag}`);
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
      options.operations?.push(`identity:${packageName}:${version}`);
      const record = (packageName === '@yiliang/aw-plugins-manifest' ? manifestPackages : fullPackages)[packageKey(packageName, version)];
      if (!record) {
        throw new Error(`missing ${packageName}@${version}`);
      }
      return record.identity;
    },
    downloadArchive: async (identity) => {
      options.operations?.push(`download:${identity.packageName}:${identity.version}`);
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

function createSingleVersionCatalogPackageSource(options: {
  catalogPackage: Awaited<ReturnType<typeof createValidCatalogPackage>>;
  catalogVersion?: string;
  channel?: CatalogChannel;
  operations?: string[];
}): CatalogPackageSource {
  const catalogVersion = options.catalogVersion ?? '1.0.0';
  const channel = options.channel ?? 'latest';
  return createFakeCatalogPackageSource({
    distTags: { [channel]: catalogVersion },
    manifestPackages: {
      [packageKey('@yiliang/aw-plugins-manifest', catalogVersion)]: {
        identity: {
          packageName: '@yiliang/aw-plugins-manifest',
          version: catalogVersion,
          integrity: `sha512-sidecar-${catalogVersion}`,
          requestedDistTag: channel,
        },
        rootDir: options.catalogPackage.sidecarRoot,
        manifest: options.catalogPackage.manifest,
      },
    },
    fullPackages: {
      [packageKey('@yiliang/aw-plugins', catalogVersion)]: {
        identity: {
          packageName: '@yiliang/aw-plugins',
          version: catalogVersion,
          integrity: `sha512-full-${catalogVersion}`,
        },
        rootDir: options.catalogPackage.fullRoot,
        manifest: options.catalogPackage.manifest,
      },
    },
    operations: options.operations,
  });
}

afterEach(async () => {
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  clearCurrentCatalogResolutionMemoForTests();
  setCatalogPackageSourceForTests(null);
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_CLI_VERSION;
  delete process.env.AW_CATALOG_CHANNEL;
  delete process.env.AW_CATALOG_VERSION;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin catalog resolvers', () => {
  it('uses fresh and stale selector cache entries without network access', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({ source: 'remote' });

    clearCurrentCatalogResolutionMemoForTests();
    const operations: string[] = [];
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({ operations }));
    const fresh = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(fresh).toMatchObject({
      source: 'cache',
      cacheState: { state: 'fresh', ttlMs: 300_000 },
    });
    expect(operations).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    clearCurrentCatalogResolutionMemoForTests();

    const stale = await resolveCurrentCatalog(
      { ...env, AW_CATALOG_CACHE_TTL_MS: '100' },
      { freshnessPolicy: 'cacheFirst' },
    );
    expect(stale).toMatchObject({
      source: 'cache',
      cacheState: { state: 'stale', ttlMs: 100 },
    });
    expect(operations).toEqual([]);

    clearCurrentCatalogResolutionMemoForTests();
    const ttlDisabled = await resolveCurrentCatalog(
      { ...env, AW_CATALOG_CACHE_TTL_MS: '0' },
      { freshnessPolicy: 'cacheFirst' },
    );
    expect(ttlDisabled.cacheState).toMatchObject({ state: 'stale', ttlMs: 0 });
    expect(operations).toEqual([]);
  });

  it('does not use a source-less v1 entry for registry selector fallback', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await resolveCurrentCatalog(env);
    clearCurrentCatalogResolutionMemoForTests();
    await fs.remove(path.join(String(env.AW_HOME), 'catalog-cache', 'selectors'));
    const entriesDir = path.join(String(env.AW_HOME), 'catalog-cache', 'entries');
    const [cacheKey] = await fs.readdir(entriesDir);
    const metadataPath = path.join(entriesDir, cacheKey!, 'entry.json');
    const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
    delete metadata.publicationId;
    await fs.writeJson(metadataPath, { ...metadata, version: 1 });

    const operations: string[] = [];
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({ operations }));
    await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' })).rejects.toMatchObject({
      resolution: {
        cacheFallback: { used: false },
        remoteFailure: { stage: 'sidecarMetadata' },
      },
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
    ]);
    await expect(fs.pathExists(path.join(String(env.AW_HOME), 'catalog-cache', 'selectors')))
      .resolves.toBe(false);
  });

  it('rejects v1 selector cache entries with invalid package envelopes', async () => {
    for (const mutation of ['sidecarName', 'fullIdentity'] as const) {
      const { repoRoot, env } = await makeRepoWorkspace();
      const catalogPackage = await createValidCatalogPackage({
        repoRoot,
        catalogVersion: '1.0.0',
        channel: 'latest',
        minAwVersion: '1.0.0',
      });
      setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
      const seeded = await resolveCurrentCatalog(env);
      clearCurrentCatalogResolutionMemoForTests();

      await fs.remove(path.join(String(env.AW_HOME), 'catalog-cache', 'selectors'));
      const entryDir = path.dirname(seeded.rootDir);
      const metadataPath = path.join(entryDir, 'entry.json');
      const manifestPath = path.join(seeded.rootDir, 'catalog-manifest.json');
      const metadata = await fs.readJson(metadataPath) as Record<string, unknown>;
      delete metadata.publicationId;
      metadata.version = 1;
      const manifest = await fs.readJson(manifestPath) as {
        packages: {
          sidecar: Record<string, unknown>;
          full: Record<string, unknown>;
        };
      };
      if (mutation === 'sidecarName') {
        manifest.packages.sidecar.name = '@malicious/sidecar';
      } else {
        manifest.packages.full.name = '@malicious/full';
        manifest.packages.full.manifestPath = './wrong.json';
      }
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      metadata.manifestDigest = `sha256:${crypto
        .createHash('sha256')
        .update(await fs.readFile(manifestPath))
        .digest('hex')}`;
      await fs.writeJson(metadataPath, metadata, { spaces: 2 });

      setCatalogPackageSourceForTests(createFakeCatalogPackageSource({}));
      await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' })).rejects.toMatchObject({
        resolution: {
          reasonCode: 'catalogUnavailable',
          cacheFallback: { used: false },
          remoteFailure: { stage: 'sidecarMetadata' },
        },
      });
    }
  });

  it('resolves remotely when cache-first mode has no matching cache entry', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage, operations }));

    await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' })).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);
  });

  it('does not trust a tampered cache entry in cache-first mode', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage, operations }));
    const seeded = await resolveCurrentCatalog(env);
    await fs.remove(path.join(
      seeded.rootDir,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    ));
    clearCurrentCatalogResolutionMemoForTests();
    operations.length = 0;

    await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' })).resolves.toMatchObject({
      source: 'remote',
    });
    expect(operations).toContain('download:@yiliang/aw-plugins:1.0.0');
  });

  it('rejects invalid cache policy environment values before network or cache writes', async () => {
    for (const [name, value] of [
      ['AW_CATALOG_CACHE_TTL_MS', '-1'],
      ['AW_CATALOG_CACHE_TTL_MS', '86400001'],
      ['AW_CATALOG_REMOTE_TIMEOUT_MS', '99'],
      ['AW_CATALOG_REMOTE_TIMEOUT_MS', '60001'],
    ] as const) {
      const { env } = await makeRepoWorkspace();
      const operations: string[] = [];
      setCatalogPackageSourceForTests(createFakeCatalogPackageSource({ operations }));
      await expect(resolveCurrentCatalog({ ...env, [name]: value })).rejects.toThrow(
        new RegExp(`${name}.*${value}`),
      );
      expect(operations).toEqual([]);
      await expect(fs.pathExists(path.join(String(env.AW_HOME), 'catalog-cache'))).resolves.toBe(false);
    }
  });

  it('applies one total remote deadline to a source that ignores AbortSignal', async () => {
    const { env } = await makeRepoWorkspace();
    let identityCalls = 0;
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => {
        identityCalls += 1;
        return await new Promise(() => {});
      },
      resolveIdentityByVersion: async () => {
        throw new Error('unexpected version identity call');
      },
      downloadArchive: async () => {
        throw new Error('unexpected archive download');
      },
    });

    await expect(resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    })).rejects.toThrow('AW_CATALOG_REMOTE_TIMEOUT_MS=100');
    expect(identityCalls).toBe(1);
  });

  it.each([
    ['no internal deadline', '0'],
    ['the default deadline', undefined],
  ])('propagates an external abort with %s and clears the rejected memo', async (_label, remoteTimeoutMs) => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    let identityCalls = 0;
    let sourceCleanedUp = false;
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async (_packageName, _tag, _env, signal) => {
        identityCalls += 1;
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            sourceCleanedUp = true;
            reject(signal.reason);
          }, { once: true });
        });
      },
      resolveIdentityByVersion: async () => {
        throw new Error('unexpected version identity call');
      },
      downloadArchive: async () => {
        throw new Error('unexpected archive download');
      },
    });
    const controller = new AbortController();
    const reason = new DOMException('Console catalog refresh stopped.', 'AbortError');
    const catalogEnv = {
      ...env,
      ...(remoteTimeoutMs ? { AW_CATALOG_REMOTE_TIMEOUT_MS: remoteTimeoutMs } : {}),
    };
    const resolving = resolveCurrentCatalog(catalogEnv, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(identityCalls).toBe(1));

    controller.abort(reason);

    await expect(resolving).rejects.toBe(reason);
    expect(sourceCleanedUp).toBe(true);

    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await expect(resolveCurrentCatalog(catalogEnv)).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
  });

  it('cancels memo waiters independently without aborting shared remote catalog work', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const baseSource = createSingleVersionCatalogPackageSource({ catalogPackage });
    let identityCalls = 0;
    let sharedSignalAborted = false;
    let identityStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      identityStarted = resolve;
    });
    let releaseIdentity!: () => void;
    const identityReleased = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    setCatalogPackageSourceForTests({
      ...baseSource,
      resolveIdentityByDistTag: async (...args) => {
        identityCalls += 1;
        const signal = args[3];
        signal?.addEventListener('abort', () => {
          sharedSignalAborted = true;
        }, { once: true });
        identityStarted();
        await identityReleased;
        signal?.throwIfAborted();
        return baseSource.resolveIdentityByDistTag(...args);
      },
    });
    const catalogEnv = {
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '0',
      AW_NPM_REGISTRY_URL: 'https://registry.example',
    };
    const firstController = new AbortController();
    const first = resolveCurrentCatalog(catalogEnv, { signal: firstController.signal });
    await started;
    const secondController = new AbortController();
    const second = resolveCurrentCatalog(catalogEnv, { signal: secondController.signal });
    const survivor = resolveCurrentCatalog(catalogEnv);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondReason = new DOMException('Second catalog waiter stopped.', 'AbortError');
    secondController.abort(secondReason);

    await expect(second).rejects.toBe(secondReason);
    expect(sharedSignalAborted).toBe(false);

    const firstReason = new DOMException('First catalog waiter stopped.', 'AbortError');
    firstController.abort(firstReason);

    await expect(first).rejects.toBe(firstReason);
    expect(sharedSignalAborted).toBe(false);
    releaseIdentity();
    await expect(survivor).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(identityCalls).toBe(1);
  });

  it('keeps a cache-first handoff alive when the remote initiator aborts', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const baseSource = createSingleVersionCatalogPackageSource({ catalogPackage });
    const readSelectorCache = localMarketplaceModule.readCurrentCatalogCacheEntryBySelector;
    let cacheReadStarted!: () => void;
    const cacheReadStart = new Promise<void>((resolve) => {
      cacheReadStarted = resolve;
    });
    let releaseCacheRead!: () => void;
    const cacheReadReleased = new Promise<void>((resolve) => {
      releaseCacheRead = resolve;
    });
    let cacheReadFinished!: () => void;
    const cacheReadFinish = new Promise<void>((resolve) => {
      cacheReadFinished = resolve;
    });
    vi.spyOn(localMarketplaceModule, 'readCurrentCatalogCacheEntryBySelector').mockImplementationOnce(
      async (...args) => {
        cacheReadStarted();
        await cacheReadReleased;
        const result = await readSelectorCache(...args);
        cacheReadFinished();
        return result;
      },
    );
    let identityCalls = 0;
    let sharedSignalAborted = false;
    let identityStarted!: () => void;
    const identityStart = new Promise<void>((resolve) => {
      identityStarted = resolve;
    });
    let releaseIdentity!: () => void;
    const identityReleased = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    setCatalogPackageSourceForTests({
      ...baseSource,
      resolveIdentityByDistTag: async (...args) => {
        identityCalls += 1;
        const signal = args[3];
        signal?.addEventListener('abort', () => {
          sharedSignalAborted = true;
        }, { once: true });
        identityStarted();
        await identityReleased;
        signal?.throwIfAborted();
        return baseSource.resolveIdentityByDistTag(...args);
      },
    });
    const catalogEnv = {
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '0',
      AW_NPM_REGISTRY_URL: 'https://registry.example',
    };

    const cacheFirst = resolveCurrentCatalog(catalogEnv, { freshnessPolicy: 'cacheFirst' });
    await cacheReadStart;
    const remoteController = new AbortController();
    const remote = resolveCurrentCatalog(catalogEnv, {
      freshnessPolicy: 'requireRemote',
      signal: remoteController.signal,
    });
    await identityStart;
    releaseCacheRead();
    await cacheReadFinish;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const reason = new DOMException('Remote initiator stopped.', 'AbortError');
    remoteController.abort(reason);

    await expect(remote).rejects.toBe(reason);
    const signalAbortedBeforeRelease = sharedSignalAborted;
    releaseIdentity();
    await expect(cacheFirst).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(signalAbortedBeforeRelease).toBe(false);
    expect(identityCalls).toBe(1);
  });

  it('starts fresh memo work immediately after its last waiter aborts', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const baseSource = createSingleVersionCatalogPackageSource({ catalogPackage });
    let identityCalls = 0;
    let firstSignalAborted!: () => void;
    const firstSignalAbort = new Promise<void>((resolve) => {
      firstSignalAborted = resolve;
    });
    setCatalogPackageSourceForTests({
      ...baseSource,
      resolveIdentityByDistTag: async (...args) => {
        identityCalls += 1;
        if (identityCalls !== 1) {
          return baseSource.resolveIdentityByDistTag(...args);
        }
        const signal = args[3];
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            firstSignalAborted();
            reject(signal.reason);
          }, { once: true });
        });
      },
    });
    const catalogEnv = {
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '0',
      AW_NPM_REGISTRY_URL: 'https://registry.example',
    };
    const controller = new AbortController();
    const first = resolveCurrentCatalog(catalogEnv, { signal: controller.signal });
    await vi.waitFor(() => expect(identityCalls).toBe(1));
    let second: Promise<CatalogResolution> | undefined;
    controller.signal.addEventListener('abort', () => {
      second = resolveCurrentCatalog(catalogEnv);
    }, { once: true });
    const reason = new DOMException('Only catalog waiter stopped.', 'AbortError');

    controller.abort(reason);

    await firstSignalAbort;
    await expect(first).rejects.toBe(reason);
    expect(second).toBeDefined();
    await expect(second!).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(identityCalls).toBe(2);
  });

  it('falls back for early remote stages and classifies deadline failures', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const identity = {
      packageName: '@yiliang/aw-plugins-manifest',
      version: '1.0.0',
      integrity: 'sha512-sidecar-1',
      requestedDistTag: 'latest' as const,
    };
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await resolveCurrentCatalog(env);

    for (const [stage, source] of [
      ['sidecarTarball', createFakeCatalogPackageSource({
        distTags: { latest: '1.0.0' },
        manifestPackages: {
          [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
            identity,
            manifest: catalogPackage.manifest,
            failDownload: 'sidecar offline',
          },
        },
      })],
      ['sidecarManifest', createFakeCatalogPackageSource({
        distTags: { latest: '1.0.0' },
        manifestPackages: {
          [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
            identity,
            manifest: {},
          },
        },
      })],
      ['fullMetadata', createFakeCatalogPackageSource({
        distTags: { latest: '1.0.0' },
        manifestPackages: {
          [packageKey('@yiliang/aw-plugins-manifest', '1.0.0')]: {
            identity,
            rootDir: catalogPackage.sidecarRoot,
            manifest: catalogPackage.manifest,
          },
        },
      })],
    ] as const) {
      clearCurrentCatalogResolutionMemoForTests();
      setCatalogPackageSourceForTests(source);
      await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
        source: 'cache',
        cacheFallback: { used: true },
        cacheState: { state: 'refreshFailed' },
        remoteFailure: { stage },
      });
    }

    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => await new Promise(() => {}),
      resolveIdentityByVersion: async () => { throw new Error('unexpected'); },
      downloadArchive: async () => { throw new Error('unexpected'); },
    });
    await expect(resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    })).resolves.toMatchObject({
      source: 'cache',
      cacheFallback: { used: true },
      cacheState: { state: 'refreshFailed' },
      remoteFailure: { stage: 'deadline' },
    });
  });

  it('rejects identities and manifests that do not bind to the selector', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => ({
        packageName: '@yiliang/aw-plugins-manifest',
        version: '1.0.0',
        integrity: 'sha512-sidecar-1',
        requestedDistTag: 'beta',
      }),
      resolveIdentityByVersion: async (_packageName, version) => ({
        packageName: '@yiliang/aw-plugins-manifest',
        version,
        integrity: 'sha512-sidecar-1',
      }),
      downloadArchive: async () => { throw new Error('unexpected download'); },
    });
    await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
      resolution: { remoteFailure: { stage: 'sidecarMetadata' } },
    });

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: { latest: '2.0.0' },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-2',
            requestedDistTag: 'latest',
          },
          rootDir: catalogPackage.sidecarRoot,
          manifest: catalogPackage.manifest,
        },
      },
    }));
    await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
      resolution: { remoteFailure: { stage: 'sidecarManifest' } },
    });
  });

  it('rejects package layout declarations and validates schema before compatibility', async () => {
    const { env } = await makeRepoWorkspace();
    const invalidPackages = createIncompatibleLatestSidecar({
      catalogVersion: '2.0.0',
      minAwVersion: '1.0.0',
      fallbackVersion: '1.0.0',
      fallbackMinAwVersion: '1.0.0',
      channel: 'latest',
    });
    invalidPackages.packages = {
      ...(invalidPackages.packages as Record<string, unknown>),
      full: {
        name: '@yiliang/aw-plugins',
        version: '2.0.0',
        channel: 'latest',
        manifestPath: './wrong.json',
      },
    };
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: { latest: '2.0.0' },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-2',
            requestedDistTag: 'latest',
          },
          manifest: invalidPackages,
        },
      },
    }));
    await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
      resolution: { remoteFailure: { stage: 'sidecarManifest' } },
    });

    const withHistory = createIncompatibleLatestSidecar({
      catalogVersion: '2.0.0',
      minAwVersion: '9.0.0',
      fallbackVersion: '1.0.0',
      fallbackMinAwVersion: '1.0.0',
      channel: 'latest',
    });
    withHistory.history = {};
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: { latest: '2.0.0' },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-2',
            requestedDistTag: 'latest',
          },
          manifest: withHistory,
        },
      },
    }));
    await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
      resolution: {
        reasonCode: 'catalogUnavailable',
        remoteFailure: {
          stage: 'sidecarManifest',
          message: expect.stringContaining('unknown field "history"'),
        },
      },
    });
  });

  it('does not publish a delayed cache writer after the remote deadline', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    const writeCache = localMarketplaceModule.writeCurrentCatalogCacheEntry;
    vi.spyOn(localMarketplaceModule, 'writeCurrentCatalogCacheEntry').mockImplementationOnce(
      async (options) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return writeCache(options);
      },
    );

    await expect(resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    })).rejects.toMatchObject({
      resolution: { remoteFailure: { stage: 'deadline' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await expect(fs.readdir(path.join(String(env.AW_HOME), 'catalog-cache', 'entries')).catch(() => []))
      .resolves.toEqual([]);
    await expect(fs.readdir(path.join(String(env.AW_HOME), 'catalog-cache', 'selectors')).catch(() => []))
      .resolves.toEqual([]);
  });

  it('keeps successful publication independent from pending or rejected archive disposal', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const createDisposeSource = (mode: 'pending' | 'reject'): CatalogPackageSource => {
      const base = createSingleVersionCatalogPackageSource({ catalogPackage });
      return {
        ...base,
        downloadArchive: async (...args) => {
          const archive = await base.downloadArchive(...args);
          return {
            ...archive,
            dispose: mode === 'pending'
              ? async () => await new Promise<void>(() => {})
              : async () => { throw new Error(`dispose ${mode}`); },
          };
        },
      };
    };

    setCatalogPackageSourceForTests(createDisposeSource('pending'));
    await expect(resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '1000',
    }, { forceRefresh: true })).resolves.toMatchObject({
      source: 'remote',
      cacheFallback: { used: false },
    });

    setCatalogPackageSourceForTests(createDisposeSource('reject'));
    await expect(resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '1000',
    }, { forceRefresh: true })).resolves.toMatchObject({
      source: 'remote',
      cacheFallback: { used: false },
    });
  });

  it('classifies manifest and artifact digest validation failures without message matching', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    for (const stage of ['fullManifest', 'artifactDigest'] as const) {
      const catalogPackage = await createValidCatalogPackage({
        repoRoot,
        catalogVersion: '1.0.0',
        channel: 'latest',
        minAwVersion: '1.0.0',
      });
      if (stage === 'fullManifest') {
        const manifestPath = path.join(
          catalogPackage.fullRoot,
          'plugins',
          'git-commit',
          '.agents-plugin',
          'plugin.json',
        );
        const pluginManifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        await fs.writeJson(manifestPath, { ...pluginManifest, description: 'tampered manifest' });
      } else {
        await fs.appendFile(path.join(
          catalogPackage.fullRoot,
          'plugins',
          'git-commit',
          'codex',
          'skills',
          'commit',
          'SKILL.md',
        ), '\ntampered artifact\n');
      }
      setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
      await expect(resolveCurrentCatalog(env, { forceRefresh: true })).rejects.toMatchObject({
        resolution: { remoteFailure: { stage } },
      });
    }
  });

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

  it('reuses a fresh process memo without another remote request', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];

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
      operations,
    }));

    const first = await resolveCurrentCatalog(env);
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);

    operations.length = 0;
    const second = await resolveCurrentCatalog(env);

    expect(second).toBe(first);
    expect(operations).toEqual([]);
  });

  it('invalidates a fresh process memo when the test package source changes', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogV1 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const catalogV2 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '2.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({
      catalogPackage: catalogV1,
      catalogVersion: '1.0.0',
    }));
    const first = await resolveCurrentCatalog(env);

    const operations: string[] = [];
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({
      catalogPackage: catalogV2,
      catalogVersion: '2.0.0',
      operations,
    }));
    const second = await resolveCurrentCatalog(env);

    expect(second).not.toBe(first);
    expect(second.catalogVersion).toBe('2.0.0');
    expect(operations).toContain('identity:@yiliang/aw-plugins-manifest:latest');
  });

  it('tracks memo capability and coalesces concurrent remote resolution', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage, operations }));

    const concurrent = await Promise.all([
      resolveCurrentCatalog(env),
      resolveCurrentCatalog(env),
      resolveCurrentCatalog(env),
    ]);
    expect(concurrent[1]).toBe(concurrent[0]);
    expect(concurrent[2]).toBe(concurrent[0]);
    expect(operations).toHaveLength(4);

    clearCurrentCatalogResolutionMemoForTests();
    operations.length = 0;
    const cacheOnly = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(operations).toEqual([]);
    const [remotelyChecked, coalescedRequireRemote] = await Promise.all([
      resolveCurrentCatalog(env),
      resolveCurrentCatalog(env),
    ]);
    expect(remotelyChecked).not.toBe(cacheOnly);
    expect(coalescedRequireRemote).toBe(remotelyChecked);
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
    ]);

    operations.length = 0;
    await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' }))
      .resolves.toBe(remotelyChecked);
    expect(operations).toEqual([]);

    clearCurrentCatalogResolutionMemoForTests();
    await fs.remove(path.join(String(env.AW_HOME), 'catalog-cache'));
    operations.length = 0;
    const [mixedCacheFirst, mixedRequireRemote] = await Promise.all([
      resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' }),
      resolveCurrentCatalog(env),
    ]);
    expect(mixedCacheFirst).toBe(mixedRequireRemote);
    expect(operations).toHaveLength(4);
  });

  it('returns selector cache without joining a pending remote memo', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({ source: 'remote' });

    clearCurrentCatalogResolutionMemoForTests();
    const operations: string[] = [];
    const source = createSingleVersionCatalogPackageSource({ catalogPackage, operations });
    let remoteStarted!: () => void;
    const remoteStart = new Promise<void>((resolve) => {
      remoteStarted = resolve;
    });
    let releaseRemote!: () => void;
    const remoteRelease = new Promise<void>((resolve) => {
      releaseRemote = resolve;
    });
    let identityCalls = 0;
    setCatalogPackageSourceForTests({
      ...source,
      resolveIdentityByDistTag: async (...args) => {
        identityCalls += 1;
        remoteStarted();
        await remoteRelease;
        return source.resolveIdentityByDistTag(...args);
      },
    });
    const noDeadlineEnv = { ...env, AW_CATALOG_REMOTE_TIMEOUT_MS: '0' };

    const background = resolveCurrentCatalog(noDeadlineEnv, { freshnessPolicy: 'requireRemote' });
    await remoteStart;
    const cacheFirst = resolveCurrentCatalog(noDeadlineEnv, { freshnessPolicy: 'cacheFirst' });
    let blockedTimer!: ReturnType<typeof setTimeout>;
    const cacheOutcome = await Promise.race([
      cacheFirst.then((resolution) => ({ kind: 'resolved' as const, resolution })),
      new Promise<{ kind: 'blocked' }>((resolve) => {
        blockedTimer = setTimeout(() => resolve({ kind: 'blocked' }), 1_000);
      }),
    ]);

    clearTimeout(blockedTimer);
    const identityCallsBeforeRelease = identityCalls;
    const operationsBeforeRelease = [...operations];
    releaseRemote();
    const [firstRemote, coalescedRemote] = await Promise.all([
      background,
      resolveCurrentCatalog(noDeadlineEnv, { freshnessPolicy: 'requireRemote' }),
    ]);

    expect(cacheOutcome).toMatchObject({
      kind: 'resolved',
      resolution: {
        source: 'cache',
        cacheState: { state: 'fresh' },
      },
    });
    expect(identityCallsBeforeRelease).toBe(1);
    expect(operationsBeforeRelease).toEqual([]);
    expect(coalescedRemote).toBe(firstRemote);
    expect(firstRemote.source).toBe('cache');
    expect(identityCalls).toBe(1);
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
    ]);
  });

  it('partitions remote memo work by total timeout', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const baseSource = createSingleVersionCatalogPackageSource({ catalogPackage });
    let identityCalls = 0;
    setCatalogPackageSourceForTests({
      ...baseSource,
      resolveIdentityByDistTag: async (...args) => {
        identityCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 200));
        return baseSource.resolveIdentityByDistTag(...args);
      },
    });

    const shortDeadline = resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '100',
    });
    const longDeadline = resolveCurrentCatalog({
      ...env,
      AW_CATALOG_REMOTE_TIMEOUT_MS: '60000',
    });
    await expect(shortDeadline).rejects.toMatchObject({
      resolution: { remoteFailure: { stage: 'deadline' } },
    });
    await expect(longDeadline).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(identityCalls).toBe(2);
  });

  it('falls back to validated selector cache after a failing source replacement', async () => {
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

    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    clearCurrentCatalogResolutionMemoForTests();

    const first = await resolveCurrentCatalog(env);
    expect(first).toMatchObject({
      source: 'cache',
      catalogVersion: '1.0.0',
    });

    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      manifestPackages: {},
      fullPackages: {},
    }));

    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      source: 'cache',
      cacheFallback: { used: true, blockingCode: 'catalogUnavailable' },
      cacheState: { state: 'refreshFailed' },
      remoteFailure: { stage: 'sidecarMetadata' },
    });

    const operations: string[] = [];
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
      operations,
    }));

    const recovered = await resolveCurrentCatalog(env);
    expect(recovered).not.toBe(first);
    expect(recovered).toMatchObject({
      source: 'cache',
      catalogVersion: '1.0.0',
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
    ]);
  });

  it('does not use a selector fallback cached for another registry', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const registryAEnv = {
      ...env,
      AW_NPM_REGISTRY_URL: 'https://registry-a.example',
    };
    const registryBEnv = {
      ...env,
      AW_NPM_REGISTRY_URL: 'https://registry-b.example',
    };
    setCatalogPackageSourceForTests(createSingleVersionCatalogPackageSource({ catalogPackage }));
    await expect(resolveCurrentCatalog(registryAEnv)).resolves.toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });

    clearCurrentCatalogResolutionMemoForTests();
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      manifestPackages: {},
      fullPackages: {},
    }));

    await expect(resolveCurrentCatalog(registryBEnv)).rejects.toMatchObject({
      resolution: {
        cacheFallback: { used: false },
        remoteFailure: { stage: 'sidecarMetadata' },
      },
    });
    await expect(resolveCurrentCatalog(registryAEnv)).resolves.toMatchObject({
      source: 'cache',
      cacheFallback: { used: true },
      catalogVersion: '1.0.0',
    });
  });

  it('keeps a newer dist-tag observation and memo when the registry rolls back', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogV1 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const catalogV2 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.1.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const sourceV1 = createSingleVersionCatalogPackageSource({
      catalogPackage: catalogV1,
      catalogVersion: '1.0.0',
    });
    const sourceV2 = createSingleVersionCatalogPackageSource({
      catalogPackage: catalogV2,
      catalogVersion: '1.1.0',
    });
    let distTagCalls = 0;
    let olderDownloadStarted!: () => void;
    const olderDownload = new Promise<void>((resolve) => {
      olderDownloadStarted = resolve;
    });
    let releaseOlderDownload!: () => void;
    const olderDownloadReleased = new Promise<void>((resolve) => {
      releaseOlderDownload = resolve;
    });
    const sourceForVersion = (version: string): CatalogPackageSource =>
      version === '1.0.0' ? sourceV1 : sourceV2;
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async (...args) => {
        distTagCalls += 1;
        return (distTagCalls === 1 ? sourceV2 : sourceV1)
          .resolveIdentityByDistTag(...args);
      },
      resolveIdentityByVersion: async (packageName, version, ...args) =>
        sourceForVersion(version).resolveIdentityByVersion(packageName, version, ...args),
      downloadArchive: async (identity, ...args) => {
        if (
          identity.packageName === '@yiliang/aw-plugins-manifest' &&
          identity.version === '1.1.0'
        ) {
          olderDownloadStarted();
          await olderDownloadReleased;
        }
        return sourceForVersion(identity.version).downloadArchive(identity, ...args);
      },
    });

    const older = resolveCurrentCatalog(env, { freshnessPolicy: 'forceRemote' });
    await olderDownload;
    await expect(resolveCurrentCatalog(env, {
      freshnessPolicy: 'forceRemote',
    })).resolves.toMatchObject({ catalogVersion: '1.0.0' });
    releaseOlderDownload();
    await expect(older).resolves.toMatchObject({ catalogVersion: '1.1.0' });

    const distTagCallsBeforeCacheRead = distTagCalls;
    await expect(resolveCurrentCatalog(env, {
      freshnessPolicy: 'cacheFirst',
    })).resolves.toMatchObject({
      source: 'cache',
      catalogVersion: '1.0.0',
    });
    expect(distTagCalls).toBe(distTagCallsBeforeCacheRead);
  });

  it('refreshes a process memo when the current catalog dist-tag moves', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogV1 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const catalogV2 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '2.0.0',
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
          rootDir: catalogV1.sidecarRoot,
          manifest: catalogV1.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          rootDir: catalogV1.fullRoot,
          manifest: catalogV1.manifest,
        },
      },
    }));

    const first = await resolveCurrentCatalog(env);
    expect(first).toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    await expect(fs.pathExists(first.rootDir)).resolves.toBe(true);

    const operations: string[] = [];
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '2.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-2',
            requestedDistTag: 'latest',
          },
          rootDir: catalogV2.sidecarRoot,
          manifest: catalogV2.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '2.0.0',
            integrity: 'sha512-full-2',
          },
          rootDir: catalogV2.fullRoot,
          manifest: catalogV2.manifest,
        },
      },
      operations,
    }));

    env.AW_CATALOG_CACHE_TTL_MS = '0';

    const second = await resolveCurrentCatalog(env);

    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      source: 'remote',
      catalogVersion: '2.0.0',
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:2.0.0',
      'identity:@yiliang/aw-plugins:2.0.0',
      'download:@yiliang/aw-plugins:2.0.0',
    ]);
  });

  for (const scenario of [
    {
      name: 'current catalog target is too new for this CLI',
      reasonCode: 'awVersionTooLow',
      createBlockedManifest: () => createIncompatibleLatestSidecar({
        catalogVersion: '2.0.0',
        minAwVersion: '9.0.0',
        fallbackVersion: '1.5.0',
        fallbackMinAwVersion: '8.0.0',
        channel: 'latest',
      }),
    },
  ]) {
    it(`does not reuse an expired process memo when the ${scenario.name}`, async () => {
      const { repoRoot, env } = await makeRepoWorkspace();
      const catalogV1 = await createValidCatalogPackage({
        repoRoot,
        catalogVersion: '1.0.0',
        channel: 'latest',
        minAwVersion: '1.0.0',
      });
      const blockedManifest = scenario.createBlockedManifest();
      const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-blocked-'));
      tempDirs.push(blockedRoot);
      await fs.writeJson(path.join(blockedRoot, 'catalog-manifest.json'), blockedManifest, { spaces: 2 });

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
            rootDir: catalogV1.sidecarRoot,
            manifest: catalogV1.manifest,
          },
        },
        fullPackages: {
          [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
            identity: {
              packageName: '@yiliang/aw-plugins',
              version: '1.0.0',
              integrity: 'sha512-full-1',
            },
            rootDir: catalogV1.fullRoot,
            manifest: catalogV1.manifest,
          },
        },
      }));

      await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
        catalogVersion: '1.0.0',
      });

      const operations: string[] = [];
      setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
        distTags: {
          latest: '2.0.0',
        },
        manifestPackages: {
          [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
            identity: {
              packageName: '@yiliang/aw-plugins-manifest',
              version: '2.0.0',
              integrity: 'sha512-sidecar-2',
              requestedDistTag: 'latest',
            },
            rootDir: blockedRoot,
            manifest: blockedManifest,
          },
        },
        operations,
      }));

      env.AW_CATALOG_CACHE_TTL_MS = '0';

      await expect(resolveCurrentCatalog(env)).rejects.toMatchObject({
        resolution: {
          reasonCode: scenario.reasonCode,
          catalogVersion: '2.0.0',
          minAwVersion: '9.0.0',
          cacheFallback: { used: false },
        },
      });
      expect(operations).toEqual([
        'identity:@yiliang/aw-plugins-manifest:latest',
        'download:@yiliang/aw-plugins-manifest:2.0.0',
      ]);
    });
  }

  it('keeps the cached root readable across a local marketplace rebuild', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];

    setEmbeddedPluginsRootOverrideForTests(catalogPackage.fullRoot);
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
      operations,
    }));

    const first = await resolveCurrentCatalog(env);
    await expect(fs.pathExists(first.rootDir)).resolves.toBe(true);

    await localMarketplaceModule.initializeLocalMarketplace({ force: true, env });
    await expect(fs.pathExists(first.rootDir)).resolves.toBe(true);

    operations.length = 0;
    const second = await resolveCurrentCatalog(env);

    expect(second.rootDir).toBe(first.rootDir);
    await expect(fs.pathExists(second.rootDir)).resolves.toBe(true);
    expect(operations).toEqual([]);
  });

  it('revalidates a memoized current catalog root before reusing it', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];

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
      operations,
    }));

    const first = await resolveCurrentCatalog(env);
    expect(first).toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    await fs.remove(path.join(
      first.rootDir,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    ));
    operations.length = 0;

    const second = await resolveCurrentCatalog(env);

    expect(second).not.toBe(first);
    expect(second).toMatchObject({
      source: 'remote',
      catalogVersion: '1.0.0',
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);
    await expect(fs.pathExists(path.join(
      second.rootDir,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    ))).resolves.toBe(true);
  });

  it('partitions current catalog process memo by cwd', async () => {
    const firstWorkspace = await makeRepoWorkspace();
    const secondWorkspace = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot: firstWorkspace.repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];

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
      operations,
    }));

    process.chdir(firstWorkspace.repoRoot);
    const first = await resolveCurrentCatalog(firstWorkspace.env, { forceRefresh: true });
    operations.length = 0;

    process.chdir(secondWorkspace.repoRoot);
    const second = await resolveCurrentCatalog(firstWorkspace.env, { forceRefresh: true });

    expect(second).not.toBe(first);
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);
  });

  it('invalidates the ordinary process memo after a successful force refresh', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogV1 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const catalogV2 = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '2.0.0',
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
          rootDir: catalogV1.sidecarRoot,
          manifest: catalogV1.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '1.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '1.0.0',
            integrity: 'sha512-full-1',
          },
          rootDir: catalogV1.fullRoot,
          manifest: catalogV1.manifest,
        },
      },
    }));
    await expect(resolveCurrentCatalog(env)).resolves.toMatchObject({
      catalogVersion: '1.0.0',
    });

    const operations: string[] = [];
    setCatalogPackageSourceForTests(createFakeCatalogPackageSource({
      distTags: {
        latest: '2.0.0',
      },
      manifestPackages: {
        [packageKey('@yiliang/aw-plugins-manifest', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins-manifest',
            version: '2.0.0',
            integrity: 'sha512-sidecar-2',
            requestedDistTag: 'latest',
          },
          rootDir: catalogV2.sidecarRoot,
          manifest: catalogV2.manifest,
        },
      },
      fullPackages: {
        [packageKey('@yiliang/aw-plugins', '2.0.0')]: {
          identity: {
            packageName: '@yiliang/aw-plugins',
            version: '2.0.0',
            integrity: 'sha512-full-2',
          },
          rootDir: catalogV2.fullRoot,
          manifest: catalogV2.manifest,
        },
      },
      operations,
    }));

    const staleMemo = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(staleMemo).toMatchObject({
      source: 'cache',
      catalogVersion: '1.0.0',
    });
    expect(operations).toEqual([]);

    const refreshed = await resolveCurrentCatalog(env, { forceRefresh: true });
    expect(refreshed).toMatchObject({
      source: 'remote',
      catalogVersion: '2.0.0',
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:2.0.0',
      'identity:@yiliang/aw-plugins:2.0.0',
      'download:@yiliang/aw-plugins:2.0.0',
    ]);

    operations.length = 0;
    const selected = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(selected).not.toBe(staleMemo);
    expect(selected).not.toBe(refreshed);
    expect(selected).toMatchObject({
      source: 'cache',
      catalogVersion: '2.0.0',
    });
    expect(operations).toEqual([]);
  });

  it('does not let init selector display metadata mutate the process memo', async () => {
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

    const aliasResult = await initCommand({
      env,
      catalogChannel: 'latest',
      selectorOverrideSource: 'option:channel-alias',
    });
    expect(aliasResult.catalog.selector?.overrideSource).toBe('option:channel-alias');

    const directResolution = await resolveCurrentCatalog(env, { channel: 'latest' });
    expect(directResolution.selector?.overrideSource).toBe('option:catalog-channel');
  });

  it('resolves ordinary init with requireRemote exactly once', async () => {
    const { env } = await makeRepoWorkspace();
    const catalog: CatalogResolution = {
      rootDir: '/tmp/catalog',
      source: 'remote',
    };
    const resolver = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog')
      .mockResolvedValue(catalog);

    await expect(initCommand({ env })).resolves.toMatchObject({
      rootDir: catalog.rootDir,
      catalog,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(env, {
      freshnessPolicy: 'requireRemote',
      forceRefresh: false,
    });
  });

  it('resolves forced init with forceRemote exactly once while keeping forceRefresh compatibility', async () => {
    const { env } = await makeRepoWorkspace();
    const catalog: CatalogResolution = {
      rootDir: '/tmp/catalog',
      source: 'remote',
    };
    const resolver = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog')
      .mockResolvedValue(catalog);

    await expect(initCommand({ env, force: true })).resolves.toMatchObject({
      rootDir: catalog.rootDir,
      catalog,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(env, {
      freshnessPolicy: 'forceRemote',
      forceRefresh: true,
    });
  });

  it('uses a matching cache entry after resolving catalog identity and before downloading full catalog', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });

    const operations: string[] = [];
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
    clearCurrentCatalogResolutionMemoForTests();

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
      operations,
    }));

    const cached = await resolveCurrentCatalog(env);
    expect(cached).toMatchObject({
      source: 'cache',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: false,
      },
    });
    expect(cached.remoteFailure).toBeUndefined();
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
    ]);

    operations.length = 0;
    clearCurrentCatalogResolutionMemoForTests();
    const forcedFallback = await resolveCurrentCatalog(env, { forceRefresh: true });
    expect(forcedFallback).toMatchObject({
      source: 'cache',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: true,
      },
      remoteFailure: {
        stage: 'fullTarball',
      },
      cacheState: {
        state: 'refreshFailed',
      },
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);

    operations.length = 0;
    const afterForce = await resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' });
    expect(afterForce).not.toBe(forcedFallback);
    expect(afterForce).toMatchObject({
      source: 'cache',
      cacheFallback: { used: false },
      cacheState: { state: 'fresh' },
    });
    expect(operations).toEqual([]);

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
      operations,
    }));

    await expect(resolveCurrentCatalog(env, { forceRefresh: true })).resolves.toMatchObject({
      source: 'remote',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: false,
      },
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);
  });

  it('refreshes the current catalog cache when the cached plugin tree is damaged', async () => {
    const { repoRoot, env } = await makeRepoWorkspace();
    const catalogPackage = await createValidCatalogPackage({
      repoRoot,
      catalogVersion: '1.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const operations: string[] = [];

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
      operations,
    }));

    const seeded = await resolveCurrentCatalog(env);
    expect(seeded.source).toBe('remote');
    await fs.remove(path.join(
      seeded.rootDir,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    ));
    clearCurrentCatalogResolutionMemoForTests();
    operations.length = 0;

    const refreshed = await resolveCurrentCatalog(env);

    expect(refreshed).toMatchObject({
      source: 'remote',
      channel: 'latest',
      catalogVersion: '1.0.0',
      cacheFallback: {
        used: false,
      },
    });
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest:latest',
      'download:@yiliang/aw-plugins-manifest:1.0.0',
      'identity:@yiliang/aw-plugins:1.0.0',
      'download:@yiliang/aw-plugins:1.0.0',
    ]);
    await expect(fs.pathExists(path.join(
      refreshed.rootDir,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    ))).resolves.toBe(true);
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

    await expect(resolveCurrentCatalog(env, { freshnessPolicy: 'cacheFirst' })).rejects.toMatchObject({
      resolution: {
        reasonCode: 'catalogUnavailable',
        cacheFallback: {
          used: false,
        },
      },
    });
  });
});
