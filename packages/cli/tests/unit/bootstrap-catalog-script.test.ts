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
    mergedLedger: { schemaVersion: 1, records: [] },
  };
}

describe('bootstrap-catalog script', () => {
  it('accepts only a channel-appropriate catalog version', () => {
    expect(parseArgs(['beta', '--catalog-version', '9.0.0-beta.1']))
      .toEqual({ mode: 'beta', catalogVersion: '9.0.0-beta.1' });
    expect(() => parseArgs(['latest', '--catalog-version', '9.0.0-beta.1']))
      .toThrow('Expected a stable version');
  });

  it('stages and atomically bootstraps an absent official channel without reading npm compatibility', async () => {
    const history = emptyHistory();
    const stageCatalogRelease = vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
      manifest: { catalogVersion: '9.0.0', channel: 'latest' },
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
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
        resolvePublishedCliVersion,
      },
    )).resolves.toMatchObject({ commit: 'abc', idempotent: false });

    expect(stageCatalogRelease).toHaveBeenCalledWith(
      ['--catalog-version', '9.0.0'],
      { previousReleaseLedger: history.mergedLedger },
    );
    expect(publishStagedCatalog).toHaveBeenCalledWith(
      history,
      '/tmp/catalog-stage',
      { publicationMode: 'atomic' },
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
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
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
    const stageCatalogRelease = vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
      manifest: { catalogVersion: '9.0.0', channel: 'latest' },
    }));
    const publishStagedCatalog = vi.fn(async () => ({
      mode: 'latest', commit: 'same', promoted: true, idempotent: true,
    }));
    await expect(bootstrapCatalog(
      ['latest', '--catalog-version', '9.0.0'],
      {
        runCommand: async () => undefined,
        readCatalogPublicationHistory: async () => history,
        stageCatalogRelease,
        publishStagedCatalog,
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
});
