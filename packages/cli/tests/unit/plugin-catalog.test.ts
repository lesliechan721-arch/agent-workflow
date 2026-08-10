import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CatalogResolutionError,
  clearCurrentCatalogResolutionMemoForTests,
  resolveCatalogSelector,
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import { TestPathFenceError } from '../helpers/test-isolation.js';
import {
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

function createArchive(manifest: Record<string, unknown>, rootDir: string) {
  return {
    identity: {
      packageName: '@yiliang/test',
      version: manifest.catalogVersion as string,
      integrity: `sha512-${manifest.catalogVersion}`,
    },
    manifestText: JSON.stringify(manifest, null, 2),
    rawManifest: manifest,
    packageRoot: rootDir,
    materialize: async () => {},
    dispose: async () => {},
  };
}

async function makeRootWithManifest(manifest: Record<string, unknown>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plugin-catalog-unit-'));
  tempDirs.push(root);
  await fs.writeJson(path.join(root, 'catalog-manifest.json'), manifest, { spaces: 2 });
  return root;
}

function createManifest(options: {
  catalogVersion: string;
  channel: 'latest' | 'beta';
  minAwVersion: string;
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

afterEach(async () => {
  clearCurrentCatalogResolutionMemoForTests();
  setCatalogPackageSourceForTests(null);
  delete process.env.AW_CLI_VERSION;
  delete process.env.AW_CATALOG_CHANNEL;
  delete process.env.AW_CATALOG_VERSION;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('plugin catalog selector', () => {
  it('uses latest for stable CLI and beta for prerelease CLI', () => {
    expect(resolveCatalogSelector({
      cliVersion: '1.2.3',
    })).toMatchObject({
      kind: 'default',
      defaultChannel: 'latest',
    });

    expect(resolveCatalogSelector({
      cliVersion: '1.2.3-beta.4',
    })).toMatchObject({
      kind: 'default',
      defaultChannel: 'beta',
    });
  });

  it('rejects dist-tag and exact catalog version together', () => {
    expect(() => resolveCatalogSelector({
      cliVersion: '1.2.3',
      channel: 'latest',
      catalogVersion: '2.0.0',
    })).toThrow('互斥');
  });
});

describe('plugin catalog failures', () => {
  it('blocks current catalog cache writes when AW_HOME points at a read-only fixture root', async () => {
    const manifest = createManifest({
      catalogVersion: '2.0.0',
      channel: 'latest',
      minAwVersion: '1.0.0',
    });
    const rootDir = await makeRootWithManifest(manifest);
    const repositoryCwd = getSourceTestRepositoryCwd();
    registerCurrentTestReadonlyFixtureRoot(repositoryCwd, 'repository cwd');
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => ({
        packageName: '@yiliang/aw-plugins-manifest',
        version: '2.0.0',
        integrity: 'sha512-sidecar-readonly',
        requestedDistTag: 'latest',
      }),
      resolveIdentityByVersion: async () => ({
        packageName: '@yiliang/aw-plugins',
        version: '2.0.0',
        integrity: 'sha512-full-readonly',
      }),
      downloadArchive: async () => createArchive(manifest, rootDir),
    });

    const error = await resolveCurrentCatalog(
      {
        ...process.env,
        AW_CLI_VERSION: '1.0.0',
        AW_HOME: path.join(repositoryCwd, '.aw-readonly'),
      },
    ).catch((value) => value);
    expect(error).toBeInstanceOf(TestPathFenceError);
    expect((error as TestPathFenceError).details).toMatchObject({
      access: 'write',
      source: 'AW_HOME',
      reason: 'writeToReadOnlyRoot',
      conflictingRoot: {
        path: repositoryCwd,
      },
    });
  });

  it('rejects explicit incompatible catalog versions without fallback or full download', async () => {
    const manifest = createManifest({
      catalogVersion: '2.0.0-beta.1',
      channel: 'beta',
      minAwVersion: '9.0.0',
    });
    const rootDir = await makeRootWithManifest(manifest);
    const operations: string[] = [];
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => {
        throw new Error('unexpected');
      },
      resolveIdentityByVersion: async (packageName) => {
        operations.push(`identity:${packageName}`);
        return {
          packageName: '@yiliang/aw-plugins-manifest',
          version: '2.0.0-beta.1',
          integrity: 'sha512-sidecar-exact',
        };
      },
      downloadArchive: async (identity) => {
        operations.push(`download:${identity.packageName}`);
        return createArchive(manifest, rootDir);
      },
    });

    await expect(
      resolveCurrentCatalog(
        {
          ...process.env,
          AW_CLI_VERSION: '1.0.0-beta.1',
        },
        {
          catalogVersion: '2.0.0-beta.1',
        },
      ),
    ).rejects.toMatchObject({
      resolution: {
        reasonCode: 'explicitCatalogIncompatible',
        catalogVersion: '2.0.0-beta.1',
        minAwVersion: '9.0.0',
        cacheFallback: { used: false },
      },
    } satisfies Partial<CatalogResolutionError>);
    expect(operations).toEqual([
      'identity:@yiliang/aw-plugins-manifest',
      'download:@yiliang/aw-plugins-manifest',
    ]);
  });

  it('reports awVersionTooLow for an incompatible channel without fallback or full download', async () => {
    const manifest = createManifest({
      catalogVersion: '2.0.0',
      channel: 'latest',
      minAwVersion: '9.0.0',
    });
    const rootDir = await makeRootWithManifest(manifest);
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => ({
        packageName: '@yiliang/aw-plugins-manifest',
        version: '2.0.0',
        integrity: 'sha512-sidecar-latest',
        requestedDistTag: 'latest',
      }),
      resolveIdentityByVersion: async () => {
        throw new Error('unexpected');
      },
      downloadArchive: async () => createArchive(manifest, rootDir),
    });

    await expect(
      resolveCurrentCatalog(
        {
          ...process.env,
          AW_CLI_VERSION: '1.0.0',
        },
      ),
    ).rejects.toMatchObject({
      resolution: {
        reasonCode: 'awVersionTooLow',
        catalogVersion: '2.0.0',
        minAwVersion: '9.0.0',
        cacheFallback: { used: false },
      },
    } satisfies Partial<CatalogResolutionError>);
  });
});
