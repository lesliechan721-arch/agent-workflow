import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  bootstrapCatalog,
  parseArgs,
} from '../../../../scripts/release/bootstrap-catalog.mjs';
import { OFFICIAL_CATALOG_PUBLISH_REMOTE } from '../../../../scripts/release/git-catalog-publisher.mjs';

function emptyHistory() {
  return {
    remoteUrl: OFFICIAL_CATALOG_PUBLISH_REMOTE,
    mode: 'latest',
    catalogVersion: '9.0.0',
    channels: { latest: null, beta: null },
    tag: null,
    mergedLedger: { schemaVersion: 2, records: [] },
  };
}

const testPublicationLease = {
  ref: 'refs/heads/aw-release/publication-lock',
  ownerCommit: 'test-owner',
  remoteUrl: OFFICIAL_CATALOG_PUBLISH_REMOTE,
};

const releaseSnapshot = {
  root: '/tmp/bootstrap-snapshot',
  generationId: 'bootstrap-generation',
  outputDigest: 'bootstrap-output',
  inputDigest: 'bootstrap-input',
  cliPackageDigest: 'bootstrap-package',
  cliPackageRoot: '/tmp/bootstrap-snapshot/packages/cli',
  cliDistRoot: '/tmp/bootstrap-snapshot/packages/cli/dist',
  catalogOutputRoot: '/tmp/bootstrap-snapshot/packages/cli/plugins-dist',
};

function releaseOptions() {
  return {
    withReleaseBuildSnapshot: async (
      callback: (snapshot: typeof releaseSnapshot) => Promise<unknown>,
    ) => callback(releaseSnapshot),
    resolveReleaseHead: async () => 'b'.repeat(40),
    assertCurrentReleaseIdentity: async () => undefined,
  };
}

async function assertCleanReleaseWorktree() {}

async function withTestPublicationLease(
  _remoteUrl: string,
  callback: (lease: typeof testPublicationLease) => Promise<unknown>,
) {
  return callback(testPublicationLease);
}

describe('bootstrap-catalog script', () => {
  it('rejects a dirty worktree before verification or bootstrap ref writes', async () => {
    const assertReleaseWorktreeClean = vi.fn(async () => {
      throw new Error('Refusing to publish from a dirty working tree.');
    });
    const runCommand = vi.fn();
    const withCatalogPublicationLease = vi.fn();

    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      { assertReleaseWorktreeClean, runCommand, withCatalogPublicationLease },
    )).rejects.toThrow('dirty working tree');

    expect(runCommand).not.toHaveBeenCalled();
    expect(withCatalogPublicationLease).not.toHaveBeenCalled();
  });

  it('accepts only a channel-appropriate catalog version', () => {
    expect(parseArgs(['beta', '--catalog-version', '9.0.0-beta.1']))
      .toEqual({ mode: 'beta', catalogVersion: '9.0.0-beta.1' });
    expect(() => parseArgs(['latest', '--catalog-version', '9.0.0-beta.1']))
      .toThrow('Expected a stable version');
  });

  it('stages and atomically bootstraps an absent official channel without reading npm compatibility', async () => {
    const history = emptyHistory();
    const stageCatalogRelease = vi.fn(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { catalogVersion: '9.0.0', channel: 'latest' },
      generationId: releaseSnapshot.generationId,
      outputDigest: releaseSnapshot.outputDigest,
      inputDigest: releaseSnapshot.inputDigest,
      cliPackageDigest: releaseSnapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const publishStagedCatalog = vi.fn(async () => ({
      mode: 'latest',
      commit: 'abc',
      promoted: true,
      idempotent: false,
    }));
    const resolvePublishedCliVersion = vi.fn();

    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        assertReleaseWorktreeClean: assertCleanReleaseWorktree,
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
        resolvePublishedCliVersion,
        withCatalogPublicationLease: withTestPublicationLease,
      },
    )).resolves.toMatchObject({ commit: 'abc', idempotent: false });

    expect(stageCatalogRelease).toHaveBeenCalledWith(
      ['--catalog-version', '9.0.0'],
      expect.objectContaining({
        previousReleaseLedger: history.mergedLedger,
        internalOutputRoot: expect.any(String),
        snapshot: releaseSnapshot,
        releaseIdentity: expect.objectContaining({ headCommit: 'b'.repeat(40) }),
      }),
    );
    const privateOutputRoot = stageCatalogRelease.mock.calls[0]![1].internalOutputRoot;
    expect(publishStagedCatalog).toHaveBeenCalledWith(
      history,
      privateOutputRoot,
      expect.objectContaining({
        publicationMode: 'atomic',
        publicationLease: testPublicationLease,
      }),
    );
    expect(resolvePublishedCliVersion).not.toHaveBeenCalled();
  });

  it('fails closed when the target channel already contains another publication', async () => {
    const history = {
      ...emptyHistory(),
      channels: {
        latest: {
          commit: 'old',
          manifest: { catalogVersion: '8.0.0', channel: 'latest' },
          snapshotDigest: 'sha256:old',
        },
        beta: null,
      },
    };
    const stageCatalogRelease = vi.fn();
    const publishStagedCatalog = vi.fn();
    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        assertReleaseWorktreeClean: assertCleanReleaseWorktree,
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
        withCatalogPublicationLease: withTestPublicationLease,
      },
    )).rejects.toThrow('already exists');
    expect(stageCatalogRelease).not.toHaveBeenCalled();
    expect(publishStagedCatalog).not.toHaveBeenCalled();
  });

  it('permits only exact tag-and-channel idempotency after bootstrap', async () => {
    const history = {
      ...emptyHistory(),
      channels: {
        latest: {
          commit: 'same',
          manifest: { catalogVersion: '9.0.0', channel: 'latest' },
          snapshotDigest: 'sha256:same',
        },
        beta: null,
      },
      tag: {
        commit: 'same',
        manifest: { catalogVersion: '9.0.0', channel: 'latest' },
        snapshotDigest: 'sha256:same',
      },
    };
    const stageCatalogRelease = vi.fn(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { catalogVersion: '9.0.0', channel: 'latest' },
      generationId: releaseSnapshot.generationId,
      outputDigest: releaseSnapshot.outputDigest,
      inputDigest: releaseSnapshot.inputDigest,
      cliPackageDigest: releaseSnapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const publishStagedCatalog = vi.fn(async () => ({
      mode: 'latest', commit: 'same', promoted: true, idempotent: true,
    }));
    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        ...releaseOptions(),
        assertReleaseWorktreeClean: assertCleanReleaseWorktree,
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
        withCatalogPublicationLease: withTestPublicationLease,
      },
    )).resolves.toMatchObject({ commit: 'same', promoted: true, idempotent: true });
    expect(stageCatalogRelease).toHaveBeenCalledOnce();
  });

  it('rejects a non-official remote unless tests inject it through options', async () => {
    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        remoteUrl: 'file:///tmp/not-official.git',
        runCommand: async () => undefined,
      },
    )).rejects.toThrow('official remote');
  });

  it('publishes the bound private generation when the shared handoff is replaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-bootstrap-private-'));
    const sharedOutputRoot = path.join(root, '.release', 'catalog-staging', 'catalog');
    let privateOutputRoot = '';
    try {
      const result = await bootstrapCatalog(
        ['latest', '--catalog-version', '9.0.0'],
        {
          ...releaseOptions(),
          assertReleaseWorktreeClean: assertCleanReleaseWorktree,
          runCommand: async () => undefined,
          readCatalogPublicationHistory: async () => emptyHistory(),
          withCatalogPublicationLease: withTestPublicationLease,
          stageCatalogRelease: async (_argv, stageOptions) => {
            privateOutputRoot = stageOptions.internalOutputRoot;
            await fs.mkdir(privateOutputRoot, { recursive: true });
            await fs.writeFile(path.join(privateOutputRoot, 'candidate-marker'), 'candidate-a\n');
            return {
              outputRoot: privateOutputRoot,
              manifest: { catalogVersion: '9.0.0', channel: 'latest' },
              generationId: releaseSnapshot.generationId,
              outputDigest: releaseSnapshot.outputDigest,
              inputDigest: releaseSnapshot.inputDigest,
              cliPackageDigest: releaseSnapshot.cliPackageDigest,
              releaseIdentity: stageOptions.releaseIdentity,
            };
          },
          publishStagedCatalog: async (_history, stagedRoot) => {
            await fs.mkdir(sharedOutputRoot, { recursive: true });
            await fs.writeFile(path.join(sharedOutputRoot, 'candidate-marker'), 'candidate-b\n');
            return {
              mode: 'latest',
              commit: 'bound',
              bytes: await fs.readFile(path.join(stagedRoot, 'candidate-marker'), 'utf8'),
            };
          },
        },
      );

      expect(result).toMatchObject({ commit: 'bound', bytes: 'candidate-a\n' });
      await expect(fs.readFile(path.join(sharedOutputRoot, 'candidate-marker'), 'utf8'))
        .resolves.toBe('candidate-b\n');
      await expect(fs.access(privateOutputRoot)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
