import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import {
  assertValidVersion,
  createCatalogRegistryAdapter,
  isMissingRegistryPackageError,
} from '../../../../scripts/release/common.mjs';

describe('release common registry error classification', () => {
  it('rejects empty prerelease identifiers in release versions', () => {
    expect(() => assertValidVersion('1.2.3-')).toThrow('Invalid version');
    expect(() => assertValidVersion('1.2.3-+meta')).toThrow('Invalid version');
  });

  it('treats absent packages and dist-tags as missing', () => {
    expect(isMissingRegistryPackageError(new Error('HTTP 404 from registry'))).toBe(true);
    expect(isMissingRegistryPackageError(new Error('Registry dist-tag beta is missing for @lesliechan721/aw-plugins-manifest.'))).toBe(true);
  });

  it('does not treat malformed package metadata as missing', () => {
    expect(
      isMissingRegistryPackageError(
        new Error('Registry metadata for @lesliechan721/aw-plugins-manifest@2.0.0 is missing dist.integrity or dist.tarball.'),
      ),
    ).toBe(false);
  });

  it('lets publish continue when an existing package has not published the target version yet', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => {
          throw new Error('Registry version 2.0.0 is missing for @lesliechan721/aw-plugins.');
        }),
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: '/tmp/full',
      channel: 'latest',
      version: '2.0.0',
      manifest: {},
    })).resolves.toEqual({ exists: false, verified: false });
  });

  it('treats an exact-version metadata HTTP 404 as absent before identity resolution', async () => {
    const downloadCatalogPackageArchive = vi.fn();
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => {
          throw new Error('HTTP 404 from exact-version registry metadata');
        }),
        downloadCatalogPackageArchive,
      },
    });

    await expect(adapter.verifyExistingPackage('sidecar', {
      packageRoot: '/tmp/sidecar',
      channel: 'latest',
      version: '2.0.0',
      manifest: {},
    })).resolves.toEqual({ exists: false, verified: false });
    expect(downloadCatalogPackageArchive).not.toHaveBeenCalled();
  });

  it('fails closed when an existing target version has malformed metadata', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => {
          throw new Error('Registry metadata for @lesliechan721/aw-plugins@2.0.0 is missing dist.integrity or dist.tarball.');
        }),
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: '/tmp/full',
      channel: 'latest',
      version: '2.0.0',
      manifest: {},
    })).rejects.toThrow('missing dist.integrity or dist.tarball');
  });

  it('does not classify a dist-tag lookup error as a missing exact version', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => {
          throw new Error('Registry dist-tag beta is missing for @lesliechan721/aw-plugins.');
        }),
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: '/tmp/full',
      channel: 'beta',
      version: '2.0.0-beta.1',
      manifest: {},
    })).rejects.toThrow('Registry dist-tag beta is missing');
  });

  it.each([
    'HTTP 404 while downloading resolved tarball',
    'catalog tarball network timeout',
    'catalog tarball extraction failed',
  ])('fails closed after exact-version identity resolution: %s', async (message) => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins',
          version: '2.0.0',
          integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        })),
        downloadCatalogPackageArchive: vi.fn(async () => {
          throw new Error(message);
        }),
      },
    });

    await expect(adapter.verifyExistingPackage('full', {
      packageRoot: '/tmp/full',
      channel: 'latest',
      version: '2.0.0',
      manifest: {},
    })).rejects.toThrow(message);
  });

  it('fails closed when a channel dist-tag points at missing version metadata', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByDistTag: vi.fn(async () => {
          throw new Error('Registry version 2.0.0 is missing for @lesliechan721/aw-plugins-manifest.');
        }),
      },
    });

    await expect(adapter.readChannelPackageIdentity('latest')).resolves.toEqual({
      status: 'error',
      error: 'Registry version 2.0.0 is missing for @lesliechan721/aw-plugins-manifest.',
    });
  });

  it('does not download or parse a dist-tag catalog manifest', async () => {
    const resolveCatalogPackageIdentityByDistTag = vi.fn(async () => ({
      packageName: '@lesliechan721/aw-plugins-manifest',
      version: '1.0.0',
    }));
    const downloadCatalogPackageArchive = vi.fn(async () => {
      throw new Error('legacy schema 1 manifest must not be parsed');
    });
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByDistTag,
        downloadCatalogPackageArchive,
      },
    });

    await expect(adapter.readChannelPackageIdentity('latest')).resolves.toMatchObject({
      status: 'ready',
      version: '1.0.0',
    });
    expect(downloadCatalogPackageArchive).not.toHaveBeenCalled();
  });

  it('reads and disposes the publisher-only plugin release ledger', async () => {
    const packageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-ledger-'));
    const dispose = vi.fn(async () => fs.remove(packageRoot));
    const ledger = { schemaVersion: 1, records: [] };
    await fs.writeJson(path.join(packageRoot, 'plugin-release-ledger.json'), ledger);
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByDistTag: vi.fn(async () => ({
          packageName: '@lesliechan721/aw-plugins-manifest',
          version: '2.0.0-beta.1',
        })),
        downloadCatalogPackageArchive: vi.fn(async () => ({
          packageRoot,
          rawManifest: { schemaVersion: 2 },
          dispose,
        })),
      },
    });

    await expect(adapter.readChannelReleaseLedger('beta')).resolves.toMatchObject({
      status: 'ready',
      version: '2.0.0-beta.1',
      rawLedger: ledger,
    });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
