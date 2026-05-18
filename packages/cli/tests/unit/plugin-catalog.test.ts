import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CatalogResolutionError,
  resolveCatalogSelector,
  resolveCurrentCatalog,
} from '../../src/utils/plugin-catalog.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';

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
  history?: Record<string, unknown>;
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
    history: options.history ?? {
      schemaVersion: 1,
      channel: options.channel,
      releases: [{
        catalogVersion: options.catalogVersion,
        minAwVersion: options.minAwVersion,
        plugins: [],
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
    entries: [],
  };
}

afterEach(async () => {
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
  it('rejects explicit incompatible catalog versions without history fallback', async () => {
    const manifest = createManifest({
      catalogVersion: '2.0.0-beta.1',
      channel: 'beta',
      minAwVersion: '9.0.0',
    });
    const rootDir = await makeRootWithManifest(manifest);
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async () => {
        throw new Error('unexpected');
      },
      resolveIdentityByVersion: async () => ({
        packageName: '@yiliang/aw-plugins-manifest',
        version: '2.0.0-beta.1',
        integrity: 'sha512-sidecar-exact',
      }),
      downloadArchive: async () => createArchive(manifest, rootDir),
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
      },
    } satisfies Partial<CatalogResolutionError>);
  });

  it('reports catalogHistoryUnavailable when latest is incompatible and history is unusable', async () => {
    const manifest = createManifest({
      catalogVersion: '2.0.0',
      channel: 'latest',
      minAwVersion: '9.0.0',
      history: {},
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
        reasonCode: 'catalogHistoryUnavailable',
        latestCatalogBlocked: {
          catalogVersion: '2.0.0',
          minAwVersion: '9.0.0',
        },
      },
    } satisfies Partial<CatalogResolutionError>);
  });
});
