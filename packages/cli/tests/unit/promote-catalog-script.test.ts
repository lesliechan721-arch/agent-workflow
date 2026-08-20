import { describe, expect, it, vi } from 'vitest';

import { promoteCatalog } from '../../../../scripts/release/promote-catalog.mjs';

describe('catalog promotion recovery script', () => {
  it('allows the combined version sync at every recovery clean gate', async () => {
    const cleanChecks: unknown[] = [];
    const publicationOptions: { beforeAcquire?: () => Promise<void> } = {};
    const promotionOptions: { beforeRemoteWrite?: () => Promise<void> } = {};
    const assertReleaseWorktreeClean = vi.fn(async (options: unknown) => {
      cleanChecks.push(options);
    });
    const withCatalogPublicationLease = vi.fn(async (
      _remoteUrl: string,
      callback: (publicationLease: object) => Promise<unknown>,
      options: typeof publicationOptions,
    ) => {
      Object.assign(publicationOptions, options);
      await options.beforeAcquire?.();
      return callback({ ownerCommit: 'lease-owner' });
    });
    const promoteCatalogTag = vi.fn(async (options: typeof promotionOptions) => {
      Object.assign(promotionOptions, options);
      await options.beforeRemoteWrite?.();
      return { mode: 'latest', commit: 'promotion-commit', promoted: true };
    });

    await expect(promoteCatalog(
      ['latest', '--catalog-version', '2.0.0'],
      {
        assertReleaseWorktreeClean,
        resolvePublishedCliVersion: vi.fn(async () => '2.0.0'),
        withCatalogPublicationLease,
        promoteCatalogTag,
        remoteUrl: 'https://catalog.example.test/repository.git',
      },
    )).resolves.toMatchObject({ promoted: true });

    expect(assertReleaseWorktreeClean).toHaveBeenCalledTimes(3);
    expect(cleanChecks).toEqual([
      { allowVersionSync: true },
      { allowVersionSync: true },
      { allowVersionSync: true },
    ]);
    expect(publicationOptions.beforeAcquire).toBeTypeOf('function');
    expect(promotionOptions.beforeRemoteWrite).toBeTypeOf('function');
  });
});
