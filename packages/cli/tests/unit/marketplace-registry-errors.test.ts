import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveCatalogPackageIdentityByDistTag,
  resolveCatalogPackageIdentityByVersion,
  setCatalogPackageSourceForTests,
} from '../../src/utils/marketplace.js';

function stubRegistryMetadata(metadata: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(metadata), {
    headers: {
      'content-type': 'application/json',
    },
    status: 200,
  })));
}

const registryEnv = {
  AW_NPM_REGISTRY_URL: 'https://registry.example.test/',
};

afterEach(() => {
  vi.unstubAllGlobals();
  setCatalogPackageSourceForTests(null);
});

describe('registry catalog package identity errors', () => {
  it('distinguishes a missing exact package version from malformed version metadata', async () => {
    stubRegistryMetadata({
      versions: {
        '1.0.0': {
          dist: {
            integrity: 'sha512-old',
            tarball: 'https://registry.example.test/old.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toThrow('Registry version 2.0.0 is missing for @yiliang/aw-plugins.');
  });

  it('keeps malformed exact package version metadata as a registry integrity error', async () => {
    stubRegistryMetadata({
      versions: {
        '2.0.0': {
          dist: {
            tarball: 'https://registry.example.test/catalog.tgz',
          },
        },
      },
    });

    await expect(resolveCatalogPackageIdentityByVersion(
      '@yiliang/aw-plugins',
      '2.0.0',
      registryEnv,
    )).rejects.toThrow('Registry metadata for @yiliang/aw-plugins@2.0.0 is missing dist.integrity or dist.tarball.');
  });

  it('treats a dist-tag pointing at missing version metadata as malformed history', async () => {
    stubRegistryMetadata({
      'dist-tags': {
        latest: '2.0.0',
      },
      versions: {},
    });

    await expect(resolveCatalogPackageIdentityByDistTag(
      '@yiliang/aw-plugins-manifest',
      'latest',
      registryEnv,
    )).rejects.toThrow('Registry version 2.0.0 is missing for @yiliang/aw-plugins-manifest.');
  });
});
