import { describe, expect, it, vi } from 'vitest';

import {
  parseRecoverArgs,
  recoverRelease,
  resolvePublishedCliTrain,
} from '../../../../scripts/release/release-recover.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';

const releaseDigest = (character: string) => `sha256:${character.repeat(64)}`;

function completeRegistry(overrides: { planId?: string; trainContentDigest?: string } = {}) {
  const packageDigests = [releaseDigest('3'), releaseDigest('4')];
  const trainContentDigest = overrides.trainContentDigest ?? calculateCliTrainContentDigest([
    { name: '@lesliechan721/agent-skill-eval', contentDigest: packageDigests[0] },
    { name: '@lesliechan721/aw', contentDigest: packageDigests[1] },
  ]);
  const metadata = (packageContentDigest: string) => ({
    schemaVersion: 1,
    targetVersion: '1.0.0',
    candidateVersion: '1.0.0',
    planId: overrides.planId ?? releaseDigest('1'),
    sourceHead: '2'.repeat(40),
    packageContentDigest,
    trainContentDigest,
  });
  return {
    '@lesliechan721/agent-skill-eval': [{ version: '1.0.0', awRelease: metadata(packageDigests[0]) }],
    '@lesliechan721/aw': [{ version: '1.0.0', awRelease: metadata(packageDigests[1]) }],
    distTags: {
      '@lesliechan721/agent-skill-eval': { latest: '1.0.0', beta: null },
      '@lesliechan721/aw': { latest: '1.0.0', beta: null },
    },
  };
}

function guardedCatalogHistory(overrides: { planId?: string; catalogVersion?: string } = {}) {
  const commit = '5'.repeat(40);
  const catalogVersion = overrides.catalogVersion ?? '2.0.0';
  return {
    pending: commit,
    tag: {
      objectId: '6'.repeat(40),
      commit,
      catalogVersion,
      manifest: {
        catalogVersion,
        compatibility: { aw: { minVersion: '0.1.0-beta.3' } },
        release: {
          state: 'published', targetVersion: '2.0.0',
          planId: overrides.planId ?? releaseDigest('1'), sourceHead: '2'.repeat(40),
          contentDigest: releaseDigest('7'),
        },
      },
    },
  };
}

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

  it('requires matching dist-tags and complete schema-1 CLI train metadata', async () => {
    const digest = releaseDigest;
    const metadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '1.0.0',
      candidateVersion: '1.0.0',
      planId: digest('1'),
      sourceHead: '2'.repeat(40),
      packageContentDigest,
      trainContentDigest: digest('f'),
    });
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
    })).rejects.toThrow('schema-1 awRelease metadata');
    await expect(resolvePublishedCliTrain('latest', {
      readRegistryReleaseHistory: async () => registry('1.0.0', '1.0.1'),
    })).rejects.toThrow('matching published latest dist-tags');

    const packageDigests = [digest('3'), digest('4')];
    const trainContentDigest = calculateCliTrainContentDigest([
      { name: '@lesliechan721/agent-skill-eval', contentDigest: packageDigests[0] },
      { name: '@lesliechan721/aw', contentDigest: packageDigests[1] },
    ]);
    const valid: Record<string, any> = registry('1.0.0', '1.0.0');
    valid['@lesliechan721/agent-skill-eval'] = [{
      version: '1.0.0', awRelease: { ...metadata(packageDigests[0]), trainContentDigest },
    }];
    valid['@lesliechan721/aw'] = [{
      version: '1.0.0', awRelease: { ...metadata(packageDigests[1]), trainContentDigest },
    }];
    await expect(resolvePublishedCliTrain('latest', {
      readRegistryReleaseHistory: async () => valid,
    })).resolves.toBe('1.0.0');
  });

  it.each([
    ['invalid train digest', completeRegistry({ trainContentDigest: releaseDigest('9') }), guardedCatalogHistory(), 'invalid trainContentDigest'],
    ['cross-plan Catalog tag', completeRegistry(), guardedCatalogHistory({ planId: releaseDigest('8') }), 'does not match the published CLI train'],
    ['wrong Catalog tag version', completeRegistry(), guardedCatalogHistory({ catalogVersion: '2.0.1' }), 'wrong catalog version'],
  ])('rejects %s before acquiring the publication lease', async (_label, registry, catalog, message) => {
    const withCatalogPublicationLease = vi.fn();
    await expect(recoverRelease(['catalog', '2.0.0'], {
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => registry,
      readCatalogPublicationHistory: async () => catalog,
      withCatalogPublicationLease,
      remoteUrl: 'https://catalog.example.test/repository.git',
    })).rejects.toThrow(message);
    expect(withCatalogPublicationLease).not.toHaveBeenCalled();
  });

  it('uses the guarded promotion transaction without version-sync exceptions', async () => {
    const assertReleaseWorktreeClean = vi.fn(async () => undefined);
    const runCommand = vi.fn(async () => undefined);
    const promoteCatalogTag = vi.fn(async (options: {
      beforeRemoteWrite?: () => Promise<void>;
    }) => {
      await options.beforeRemoteWrite?.();
      return { ...options, mode: 'latest', commit: 'promotion-commit', promoted: true };
    });
    const resolveRecoveryBinding = vi.fn(async () => ({
      currentCliVersion: '1.0.0', identity: 'binding',
    }));
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
      runCommand,
      resolveRecoveryBinding,
      promoteCatalogTag,
      withCatalogPublicationLease,
      remoteUrl: 'https://catalog.example.test/repository.git',
    })).resolves.toMatchObject({ promoted: true });
    expect(promoteCatalogTag).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'latest', catalogVersion: '2.0.0', currentCliVersion: '1.0.0',
      requirePendingGuard: true,
    }));
    expect(resolveRecoveryBinding).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify:catalog']);
    expect(assertReleaseWorktreeClean).toHaveBeenCalledTimes(4);
  });

  it('rejects a CLI train drift at the remote-write boundary', async () => {
    const beforeRemoteWrites: string[] = [];
    const resolveRecoveryBinding = vi.fn()
      .mockResolvedValueOnce({ currentCliVersion: '1.0.0', identity: 'before' })
      .mockResolvedValueOnce({ currentCliVersion: '1.0.1', identity: 'after' });
    await expect(recoverRelease(['catalog', '2.0.0'], {
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      resolveRecoveryBinding,
      withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
        callback({ ownerCommit: 'lease-owner' }),
      promoteCatalogTag: async (options: { beforeRemoteWrite: () => Promise<void> }) => {
        await options.beforeRemoteWrite();
        beforeRemoteWrites.push('push');
        return { mode: 'latest', commit: 'unexpected', promoted: true };
      },
      remoteUrl: 'https://catalog.example.test/repository.git',
    })).rejects.toThrow('identity changed during catalog recovery');
    expect(beforeRemoteWrites).toEqual([]);
  });
});
