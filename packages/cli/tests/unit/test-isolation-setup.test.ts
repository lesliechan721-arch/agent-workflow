import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  hasCatalogPackageSourceOverrideForTests,
  setCatalogPackageSourceForTests,
  type CatalogPackageArchiveIdentity,
  type CatalogPackageSource,
} from '../../src/utils/marketplace.js';
import {
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import {
  getEmbeddedPluginsRootOverrideForTests,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import {
  assertIsolatedTestEnv,
  assertPathWithinReadableRoots,
  assertSafeTestCwd,
  expectPathFenceViolation,
} from '../helpers/test-isolation.js';
import { normalizeAbsolutePath } from '../helpers/path-fence.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  runWithCurrentRepositoryCwdAsReadOnly,
} from '../setup/test-isolation.js';
import { resetSourceStateForTests } from '../setup/reset-source-state.js';

function createCatalogManifest(catalogVersion: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    catalogVersion,
    channel: 'latest',
    compatibility: {
      aw: {
        minVersion: '1.0.0',
      },
    },
    packages: {
      sidecar: {
        name: '@yiliang/aw-plugins-manifest',
        version: catalogVersion,
        channel: 'latest',
      },
      full: {
        name: '@yiliang/aw-plugins',
        version: catalogVersion,
        channel: 'latest',
        manifestPath: './catalog-manifest.json',
      },
    },
    entries: [],
  };
}

function createArchive(
  identity: CatalogPackageArchiveIdentity,
  manifest: Record<string, unknown>,
  manifestText: string,
  rootDir: string,
) {
  return {
    identity,
    manifestText,
    rawManifest: manifest,
    packageRoot: rootDir,
    materialize: async () => {},
    dispose: async () => {},
  };
}

function createCatalogPackageSource(options: {
  label: string;
  catalogVersion: string;
  rootDir: string;
  operations: string[];
}): CatalogPackageSource {
  const manifest = createCatalogManifest(options.catalogVersion);
  const manifestText = JSON.stringify(manifest, null, 2);
  const sidecarIdentity: CatalogPackageArchiveIdentity = {
    packageName: '@yiliang/aw-plugins-manifest',
    version: options.catalogVersion,
    integrity: `sha512-${options.label}-sidecar`,
    requestedDistTag: 'latest',
  };
  const fullIdentity: CatalogPackageArchiveIdentity = {
    packageName: '@yiliang/aw-plugins',
    version: options.catalogVersion,
    integrity: `sha512-${options.label}-full`,
  };

  return {
    resolveIdentityByDistTag: async (packageName, distTag) => {
      options.operations.push(`identity:${options.label}:${packageName}:${distTag}`);
      if (packageName !== '@yiliang/aw-plugins-manifest' || distTag !== 'latest') {
        throw new Error(`unexpected dist-tag lookup for ${packageName}:${distTag}`);
      }

      return sidecarIdentity;
    },
    resolveIdentityByVersion: async (packageName, version) => {
      options.operations.push(`version:${options.label}:${packageName}:${version}`);
      if (packageName !== '@yiliang/aw-plugins' || version !== options.catalogVersion) {
        throw new Error(`unexpected version lookup for ${packageName}:${version}`);
      }

      return fullIdentity;
    },
    downloadArchive: async (identity) => {
      options.operations.push(`download:${options.label}:${identity.packageName}:${identity.version}`);
      return createArchive(identity, manifest, manifestText, options.rootDir);
    },
  };
}

let leakedRootDir: string | null = null;

describe('source test isolation setup', () => {
  it('injects isolated env, cwd, tmpdir, and fetch guard before each case', () => {
    const isolation = getCurrentSourceTestIsolation();
    const normalizedFixtureCwd = normalizeAbsolutePath(isolation.layout.fixtureCwd);

    expect(normalizeAbsolutePath(process.cwd())).toBe(normalizedFixtureCwd);
    expect(normalizeAbsolutePath(process.cwd())).not.toBe(normalizeAbsolutePath(getSourceTestRepositoryCwd()));
    expect(path.resolve(os.tmpdir())).toBe(path.resolve(isolation.layout.tmpDir));
    expect(process.env.HOME).toBe(isolation.layout.homeDir);
    expect(process.env.AW_HOME).toBe(isolation.layout.awHomeDir);
    expect(process.env.XDG_CONFIG_HOME).toBe(isolation.layout.xdgConfigHomeDir);
    expect(process.env.npm_config_userconfig).toBe(isolation.layout.npmUserConfigPath);
    expect(() => assertIsolatedTestEnv(process.env, isolation.rootRegistry)).not.toThrow();
    expect(() => assertSafeTestCwd(process.cwd(), isolation.rootRegistry)).not.toThrow();
  });

  it('resets source module overrides and memo through the shared reset entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.rootDir, 'catalog-a');
    const secondRoot = path.join(isolation.layout.rootDir, 'catalog-b');
    await Promise.all([
      fs.ensureDir(firstRoot),
      fs.ensureDir(secondRoot),
    ]);
    await Promise.all([
      fs.writeFile(
        path.join(firstRoot, 'catalog-manifest.json'),
        JSON.stringify(createCatalogManifest('1.0.0'), null, 2),
        'utf8',
      ),
      fs.writeFile(
        path.join(secondRoot, 'catalog-manifest.json'),
        JSON.stringify(createCatalogManifest('2.0.0'), null, 2),
        'utf8',
      ),
    ]);

    const env = {
      ...process.env,
      AW_CLI_VERSION: '1.0.0',
    };
    const firstOperations: string[] = [];
    const secondOperations: string[] = [];
    const firstSource = createCatalogPackageSource({
      label: 'first',
      catalogVersion: '1.0.0',
      rootDir: firstRoot,
      operations: firstOperations,
    });
    const secondSource = createCatalogPackageSource({
      label: 'second',
      catalogVersion: '2.0.0',
      rootDir: secondRoot,
      operations: secondOperations,
    });

    setEmbeddedPluginsRootOverrideForTests(path.join(isolation.layout.rootDir, 'embedded-root'));
    setCatalogPackageSourceForTests(firstSource);

    const seeded = await resolveCurrentCatalog(env);
    expect(seeded.sidecarManifestPackage?.version).toBe('1.0.0');
    expect(firstOperations).not.toHaveLength(0);

    const repeated = await resolveCurrentCatalog(env);
    expect(repeated).toBe(seeded);

    setCatalogPackageSourceForTests(secondSource);
    const updated = await resolveCurrentCatalog(env);
    expect(updated).not.toBe(seeded);
    expect(updated.sidecarManifestPackage?.version).toBe('2.0.0');

    const memoizedSecond = await resolveCurrentCatalog(env);
    expect(memoizedSecond).toBe(updated);
    const secondOperationCountBeforeReset = secondOperations.length;
    expect(secondOperationCountBeforeReset).toBeGreaterThan(0);

    resetSourceStateForTests();
    expect(getEmbeddedPluginsRootOverrideForTests()).toBeNull();
    expect(hasCatalogPackageSourceOverrideForTests()).toBe(false);

    setCatalogPackageSourceForTests(secondSource);
    const refreshed = await resolveCurrentCatalog(env);
    expect(refreshed).not.toBe(updated);
    expect(refreshed.sidecarManifestPackage?.version).toBe('2.0.0');
    expect(secondOperations.length).toBeGreaterThan(secondOperationCountBeforeReset);
  });

  it('uses the shared read-only repository cwd helper and restores the safe cwd afterwards', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const safeCwd = process.cwd();
    const repositoryCwd = normalizeAbsolutePath(getSourceTestRepositoryCwd());

    await runWithCurrentRepositoryCwdAsReadOnly(() => {
      expect(process.cwd()).toBe(repositoryCwd);
      expect(() => assertPathWithinReadableRoots(isolation.rootRegistry, {
        path: path.join(process.cwd(), 'packages', 'cli'),
        source: 'repository source tree',
      })).not.toThrow();

      expectPathFenceViolation(
        () => assertSafeTestCwd(process.cwd(), isolation.rootRegistry),
        {
          access: 'write',
          path: repositoryCwd,
          source: 'cwd',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: repositoryCwd,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
    });

    expect(process.cwd()).toBe(safeCwd);
  });

  it('allows a case to temporarily override env, cwd, fetch, and source state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    leakedRootDir = isolation.layout.rootDir;

    const leakedAwHome = path.join(isolation.layout.rootDir, 'leaked-aw-home');
    const leakedCwd = path.join(isolation.layout.rootDir, 'leaked-cwd');
    await Promise.all([
      fs.ensureDir(leakedAwHome),
      fs.ensureDir(leakedCwd),
    ]);

    process.env.AW_HOME = leakedAwHome;
    process.chdir(leakedCwd);
    setEmbeddedPluginsRootOverrideForTests(path.join(isolation.layout.rootDir, 'leaked-embedded-root'));
    setCatalogPackageSourceForTests(createCatalogPackageSource({
      label: 'leak',
      catalogVersion: '3.0.0',
      rootDir: path.join(isolation.layout.rootDir, 'leaked-catalog'),
      operations: [],
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));

    expect(process.env.AW_HOME).toBe(leakedAwHome);
    expect(process.cwd()).toBe(normalizeAbsolutePath(leakedCwd));
    expect(getEmbeddedPluginsRootOverrideForTests()).toBe(path.join(isolation.layout.rootDir, 'leaked-embedded-root'));
    expect(hasCatalogPackageSourceOverrideForTests()).toBe(true);
    await expect(fetch('https://example.com')).resolves.toBeInstanceOf(Response);
  });

  it('restores the default isolated state for the next case', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const normalizedFixtureCwd = normalizeAbsolutePath(isolation.layout.fixtureCwd);

    expect(isolation.layout.rootDir).not.toBe(leakedRootDir);
    expect(normalizeAbsolutePath(process.cwd())).toBe(normalizedFixtureCwd);
    expect(process.env.AW_HOME).toBe(isolation.layout.awHomeDir);
    expect(getEmbeddedPluginsRootOverrideForTests()).toBeNull();
    expect(hasCatalogPackageSourceOverrideForTests()).toBe(false);
    await expect(fetch('https://example.com')).rejects.toThrow('Network access is disabled in tests.');
  });
});
