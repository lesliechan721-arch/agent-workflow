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

  it('fails closed when a channel dist-tag points at missing version metadata', async () => {
    const adapter = await createCatalogRegistryAdapter({
      registryUrl: 'https://registry.example.test/',
      marketplace: {
        resolveCatalogPackageByDistTag: vi.fn(async () => {
          throw new Error('Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.');
        }),
      },
    });

    await expect(adapter.readChannelManifest('latest')).resolves.toEqual({
      status: 'error',
      error: 'Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.',
    });
  });
});
