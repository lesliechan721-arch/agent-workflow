import { describe, expect, it, vi } from 'vitest';

import {
  createCatalogRegistryAdapter,
  isMissingRegistryPackageError,
} from '../../../../scripts/release/common.mjs';

describe('release common registry error classification', () => {
  it('treats absent packages and dist-tags as missing', () => {
    expect(isMissingRegistryPackageError(new Error('HTTP 404 from registry'))).toBe(true);
    expect(isMissingRegistryPackageError(new Error('Registry dist-tag beta is missing for @yiliang/aw-plugins-manifest.'))).toBe(true);
  });

  it('does not treat malformed package metadata as missing', () => {
    expect(
      isMissingRegistryPackageError(
        new Error('Registry metadata for @yiliang/aw-plugins-manifest@2.0.0 is missing dist.integrity or dist.tarball.'),
      ),
    ).toBe(false);
  });

  it('lets publish continue when an existing package has not published the target version yet', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageIdentityByVersion: vi.fn(async () => {
          throw new Error('Registry version 2.0.0 is missing for @yiliang/aw-plugins.');
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
          throw new Error('Registry metadata for @yiliang/aw-plugins@2.0.0 is missing dist.integrity or dist.tarball.');
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
          throw new Error('Registry dist-tag beta is missing for @yiliang/aw-plugins.');
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
          packageName: '@yiliang/aw-plugins',
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
          throw new Error('Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.');
        }),
      },
    });

    await expect(adapter.readChannelPackageIdentity('latest')).resolves.toEqual({
      status: 'error',
      error: 'Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.',
    });
  });

  it('does not download or parse a dist-tag catalog manifest', async () => {
    const resolveCatalogPackageIdentityByDistTag = vi.fn(async () => ({
      packageName: '@yiliang/aw-plugins-manifest',
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
});
