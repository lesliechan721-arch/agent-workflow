import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { publishCatalog } from '../../../../scripts/release/publish-catalog.mjs';

function publicationHistory() {
  return {
    mergedLedger: { schemaVersion: 2, records: [] },
    catalogModules: {
      pluginStaging: {
        compareStrictSemVer: () => 1,
      },
    },
  };
}

const releaseSnapshot = {
  root: '/tmp/release-snapshot',
  generationId: 'generation-a',
  outputDigest: 'output-a',
  inputDigest: 'input-a',
  cliPackageDigest: 'package-a',
  cliPackageRoot: '/tmp/release-snapshot/packages/cli',
  cliDistRoot: '/tmp/release-snapshot/packages/cli/dist',
  catalogOutputRoot: '/tmp/release-snapshot/packages/cli/plugins-dist',
};

function releaseOptions() {
  return {
    assertReleaseWorktreeClean: async () => undefined,
    withReleaseBuildSnapshot: async (callback: (snapshot: typeof releaseSnapshot) => Promise<unknown>) =>
      callback(releaseSnapshot),
    resolveReleaseHead: async () => 'a'.repeat(40),
    assertCurrentReleaseIdentity: async () => undefined,
  };
}

describe('publish-catalog script', () => {
  it('rejects a dirty worktree before verification or publication-lease ref writes', async () => {
    const dirtyError = new Error('Refusing to publish from a dirty working tree.');
    const assertReleaseWorktreeClean = vi.fn(async () => { throw dirtyError; });
    const runCommand = vi.fn();
    const withCatalogPublicationLease = vi.fn();

    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        assertReleaseWorktreeClean,
        runCommand,
        withCatalogPublicationLease,
      },
    )).rejects.toThrow('dirty working tree');

    expect(runCommand).not.toHaveBeenCalled();
    expect(withCatalogPublicationLease).not.toHaveBeenCalled();
  });

  it('restages with merged remote history and publishes an atomic compatible catalog', async () => {
    const runCommand = vi.fn(async () => undefined);
    const releaseHistory = publicationHistory();
    const stageCatalogRelease = vi.fn(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '1.0.0' } } },
      generationId: releaseSnapshot.generationId,
      outputDigest: releaseSnapshot.outputDigest,
      inputDigest: releaseSnapshot.inputDigest,
      cliPackageDigest: releaseSnapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const publishStagedCatalog = vi.fn(async () => ({ commit: 'abc' }));

    await expect(publishCatalog(
      ['beta', '--catalog-version', '9.0.0-beta.6'],
      {
        ...releaseOptions(),
        runCommand,
        withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
          callback({ ownerCommit: 'lease-owner' }),
        readCatalogPublicationHistory: async () => releaseHistory,
        stageCatalogRelease,
        resolvePublishedCliVersion: async () => '1.0.0-beta.1',
        publishStagedCatalog,
      },
    )).resolves.toEqual({ commit: 'abc' });

    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify:catalog']);
    expect(stageCatalogRelease).toHaveBeenCalledWith([
      '--catalog-version',
      '9.0.0-beta.6',
    ], expect.objectContaining({
      previousReleaseLedger: releaseHistory.mergedLedger,
      internalOutputRoot: expect.any(String),
    }));
    const privateOutputRoot = stageCatalogRelease.mock.calls[0]![1].internalOutputRoot;
    expect(path.isAbsolute(privateOutputRoot)).toBe(true);
    expect(privateOutputRoot).not.toBe(path.resolve(
      process.cwd(),
      '..',
      '..',
      '.release',
      'catalog-staging',
      'catalog',
    ));
    expect(publishStagedCatalog).toHaveBeenCalledWith(
      releaseHistory,
      privateOutputRoot,
      expect.objectContaining({ publicationLease: { ownerCommit: 'lease-owner' } }),
    );
  });

  it('rejects a catalog that requires a newer CLI without publishing refs', async () => {
    const releaseHistory = publicationHistory();
    releaseHistory.catalogModules.pluginStaging.compareStrictSemVer = () => -1;
    const publishStagedCatalog = vi.fn();
    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        runCommand: async () => undefined,
        withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
          callback({ ownerCommit: 'lease-owner' }),
        readCatalogPublicationHistory: async () => releaseHistory,
        stageCatalogRelease: async (_argv, stageOptions) => ({
          outputRoot: stageOptions.internalOutputRoot,
          manifest: { compatibility: { aw: { minVersion: '2.0.0' } } },
          generationId: releaseSnapshot.generationId,
          outputDigest: releaseSnapshot.outputDigest,
          inputDigest: releaseSnapshot.inputDigest,
          cliPackageDigest: releaseSnapshot.cliPackageDigest,
          releaseIdentity: stageOptions.releaseIdentity,
        }),
        resolvePublishedCliVersion: async () => '1.0.0',
        publishStagedCatalog,
      },
    )).rejects.toThrow('Use the combined release entry point');
    expect(publishStagedCatalog).not.toHaveBeenCalled();
  });

  it('rejects live input drift after binding the snapshot and before lease ref writes', async () => {
    const withCatalogPublicationLease = vi.fn();
    const assertCurrentReleaseIdentity = vi.fn(async () => {
      throw new Error('Release live inputDigest no longer matches the bound release identity.');
    });

    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        runCommand: async () => undefined,
        assertCurrentReleaseIdentity,
        withCatalogPublicationLease,
      },
    )).rejects.toThrow('live inputDigest');

    expect(assertCurrentReleaseIdentity).toHaveBeenCalledWith(
      releaseSnapshot,
      expect.objectContaining({ inputDigest: releaseSnapshot.inputDigest }),
      {},
    );
    expect(withCatalogPublicationLease).not.toHaveBeenCalled();
  });

  it('publishes its private staged bytes after the shared handoff is replaced', async () => {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-publish-catalog-private-'));
    const sharedOutputRoot = path.join(fixtureRoot, '.release', 'catalog-staging', 'catalog');
    const releaseHistory = publicationHistory();
    let privateOutputRoot = '';
    try {
      const result = await publishCatalog(
        ['latest', '--catalog-version', '9.0.0'],
        {
          ...releaseOptions(),
          runCommand: async () => undefined,
          withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
            callback({ ownerCommit: 'lease-owner' }),
          readCatalogPublicationHistory: async () => releaseHistory,
          stageCatalogRelease: async (_argv, stageOptions) => {
            privateOutputRoot = stageOptions.internalOutputRoot;
            await fs.mkdir(privateOutputRoot, { recursive: true });
            await fs.writeFile(path.join(privateOutputRoot, 'candidate-marker'), 'candidate\n');
            return {
              outputRoot: privateOutputRoot,
              manifest: { compatibility: { aw: { minVersion: '1.0.0' } } },
              generationId: releaseSnapshot.generationId,
              outputDigest: releaseSnapshot.outputDigest,
              inputDigest: releaseSnapshot.inputDigest,
              cliPackageDigest: releaseSnapshot.cliPackageDigest,
              releaseIdentity: stageOptions.releaseIdentity,
            };
          },
          resolvePublishedCliVersion: async () => {
            await fs.mkdir(sharedOutputRoot, { recursive: true });
            await fs.writeFile(path.join(sharedOutputRoot, 'candidate-marker'), 'competing\n');
            return '1.0.0';
          },
          publishStagedCatalog: async (_history, stagedRoot) => ({
            bytes: await fs.readFile(path.join(stagedRoot, 'candidate-marker'), 'utf8'),
          }),
        },
      );

      expect(result).toEqual({ bytes: 'candidate\n' });
      await expect(fs.readFile(path.join(sharedOutputRoot, 'candidate-marker'), 'utf8'))
        .resolves.toBe('competing\n');
      await expect(fs.access(privateOutputRoot)).rejects.toThrow();
    } finally {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects a channel and version mismatch before remote reads', async () => {
    const readCatalogPublicationHistory = vi.fn();
    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0-beta.6'],
      { readCatalogPublicationHistory },
    )).rejects.toThrow('Expected a stable version');
    expect(readCatalogPublicationHistory).not.toHaveBeenCalled();
  });
});
