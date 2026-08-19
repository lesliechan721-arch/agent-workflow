import { describe, expect, it, vi } from 'vitest';

import { publishCatalog } from '../../../../scripts/release/publish-catalog.mjs';

function publicationHistory() {
  return {
    mergedLedger: { schemaVersion: 1, records: [] },
    catalogModules: {
      pluginStaging: {
        compareStrictSemVer: () => 1,
      },
    },
  };
}

describe('publish-catalog script', () => {
  it('restages with merged remote history and publishes an atomic compatible catalog', async () => {
    const runCommand = vi.fn(async () => undefined);
    const releaseHistory = publicationHistory();
    const stageCatalogRelease = vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
      manifest: { compatibility: { aw: { minVersion: '1.0.0' } } },
    }));
    const publishStagedCatalog = vi.fn(async () => ({ commit: 'abc' }));

    await expect(publishCatalog(
      ['beta', '--catalog-version', '9.0.0-beta.6'],
      {
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
    ], { previousReleaseLedger: releaseHistory.mergedLedger });
    expect(publishStagedCatalog).toHaveBeenCalledWith(
      releaseHistory,
      '/tmp/catalog-stage',
      { publicationLease: { ownerCommit: 'lease-owner' } },
    );
  });

  it('rejects a catalog that requires a newer CLI without publishing refs', async () => {
    const releaseHistory = publicationHistory();
    releaseHistory.catalogModules.pluginStaging.compareStrictSemVer = () => -1;
    const publishStagedCatalog = vi.fn();
    await expect(publishCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        runCommand: async () => undefined,
        withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
          callback({ ownerCommit: 'lease-owner' }),
        readCatalogPublicationHistory: async () => releaseHistory,
        stageCatalogRelease: async () => ({
          outputRoot: '/tmp/catalog',
          manifest: { compatibility: { aw: { minVersion: '2.0.0' } } },
        }),
        resolvePublishedCliVersion: async () => '1.0.0',
        publishStagedCatalog,
      },
    )).rejects.toThrow('Use the combined release entry point');
    expect(publishStagedCatalog).not.toHaveBeenCalled();
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
