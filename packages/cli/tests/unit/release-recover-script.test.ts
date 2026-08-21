import { describe, expect, it, vi } from 'vitest';

import {
  parseRecoverArgs,
  recoverRelease,
  resolvePublishedCliTrain,
} from '../../../../scripts/release/release-recover.mjs';

describe('release recovery command', () => {
  it('accepts only canonical catalog recovery identities and infers the channel', () => {
    expect(parseRecoverArgs(['catalog', '2.0.0'])).toMatchObject({ mode: 'latest' });
    expect(parseRecoverArgs(['--', 'catalog', '2.0.0-beta.3'])).toMatchObject({ mode: 'beta' });
    for (const args of [
      [], ['cli', '2.0.0'], ['catalog', '2.0.0', 'extra'], ['catalog', 'v2.0.0'],
      ['catalog', '2.0'], ['catalog', '02.0.0'], ['catalog', '2.0.0-beta.01'],
      ['catalog', '2.0.0-rc.1'], ['catalog', '2.0.0+build'],
    ]) expect(() => parseRecoverArgs(args)).toThrow();
  });

  it('requires both published CLI package dist-tags to match', async () => {
    const registry = (evalVersion: string | null, cliVersion: string | null) => ({
      '@lesliechan721/agent-skill-eval': [],
      '@lesliechan721/aw': [],
      distTags: {
        '@lesliechan721/agent-skill-eval': { latest: evalVersion, beta: null },
        '@lesliechan721/aw': { latest: cliVersion, beta: null },
      },
    });
    await expect(resolvePublishedCliTrain('latest', {
      readRegistryReleaseHistory: async () => registry('1.0.0', '1.0.0'),
    })).resolves.toBe('1.0.0');
    await expect(resolvePublishedCliTrain('latest', {
      readRegistryReleaseHistory: async () => registry('1.0.0', '1.0.1'),
    })).rejects.toThrow('matching published latest dist-tags');
  });

  it('uses the guarded promotion transaction without version-sync exceptions', async () => {
    const assertReleaseWorktreeClean = vi.fn(async () => undefined);
    const promoteCatalogTag = vi.fn(async (options: {
      beforeRemoteWrite?: () => Promise<void>;
    }) => {
      await options.beforeRemoteWrite?.();
      return { ...options, mode: 'latest', commit: 'promotion-commit', promoted: true };
    });
    const resolvePublishedCliTrain = vi.fn(async () => '1.0.0');
    const withCatalogPublicationLease = vi.fn(async (
      _remote: string,
      callback: (lease: object) => Promise<unknown>,
      options: { beforeAcquire: () => Promise<void> },
    ) => {
      await options.beforeAcquire();
      return callback({ ownerCommit: 'lease-owner' });
    });
    await expect(recoverRelease(['catalog', '2.0.0'], {
      assertReleaseWorktreeClean,
      resolvePublishedCliTrain,
      promoteCatalogTag,
      withCatalogPublicationLease,
      remoteUrl: 'https://catalog.example.test/repository.git',
    })).resolves.toMatchObject({ promoted: true });
    expect(promoteCatalogTag).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'latest', catalogVersion: '2.0.0', currentCliVersion: '1.0.0',
      requirePendingGuard: true,
    }));
    expect(resolvePublishedCliTrain).toHaveBeenCalledTimes(2);
    expect(assertReleaseWorktreeClean).toHaveBeenCalledTimes(3);
    expect(assertReleaseWorktreeClean.mock.calls).toEqual([[], [], []]);
  });

  it('rejects a CLI train drift at the remote-write boundary', async () => {
    const beforeRemoteWrites: string[] = [];
    const resolvePublishedCliTrain = vi.fn()
      .mockResolvedValueOnce('1.0.0')
      .mockResolvedValueOnce('1.0.1');
    await expect(recoverRelease(['catalog', '2.0.0'], {
      assertReleaseWorktreeClean: async () => undefined,
      resolvePublishedCliTrain,
      withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
        callback({ ownerCommit: 'lease-owner' }),
      promoteCatalogTag: async (options: { beforeRemoteWrite: () => Promise<void> }) => {
        await options.beforeRemoteWrite();
        beforeRemoteWrites.push('push');
        return { mode: 'latest', commit: 'unexpected', promoted: true };
      },
      remoteUrl: 'https://catalog.example.test/repository.git',
    })).rejects.toThrow('changed from 1.0.0 to 1.0.1');
    expect(beforeRemoteWrites).toEqual([]);
  });
});
