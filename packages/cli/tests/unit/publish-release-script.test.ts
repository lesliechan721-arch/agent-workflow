import { describe, expect, it, vi } from 'vitest';

import { publishRelease } from '../../../../scripts/release/publish-release.mjs';
import { compareStrictSemVer } from '../../src/utils/manifest.js';

function history(compare: (left: string, right: string) => number) {
  return {
    mergedLedger: { schemaVersion: 1, records: [] },
    channels: { latest: null, beta: null },
    tag: null,
    catalogModules: { pluginStaging: { compareStrictSemVer: compare } },
  };
}

function commonOptions(
  releaseHistory: ReturnType<typeof history>,
  currentCliVersion = '1.0.0',
  publishedCliVersion = '0.9.0',
) {
  return {
    runCommand: vi.fn(async () => undefined),
    readCliPackageJson: vi.fn(async () => ({ version: currentCliVersion })),
    readCatalogPublicationHistory: vi.fn(async () => releaseHistory),
    stageCatalogRelease: vi.fn(async () => ({
      outputRoot: '/tmp/catalog-stage',
      manifest: { compatibility: { aw: { minVersion: '1.0.0' } } },
    })),
    resolvePublishedCliVersion: vi.fn(async () => publishedCliVersion),
  };
}

describe('combined release script', () => {
  it('publishes a compatible catalog atomically before publishing the CLI', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const calls: string[] = [];
    options.stageCatalogRelease.mockResolvedValue({
      outputRoot: '/tmp/catalog-stage',
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
    });
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '0.9.0';
    });
    const result = await publishRelease(
      ['latest', '--cli-version', '1.0.0', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: vi.fn(async (_history, _root, publisherOptions) => {
          calls.push(`catalog:${publisherOptions.publicationMode}`);
          return { validation: { manifest: { catalogVersion: '2.0.0' } } };
        }),
        publishCli: vi.fn(async () => {
          calls.push('cli');
          return { version: '1.0.0' };
        }),
      },
    );
    expect(result.path).toBe('catalog-first');
    expect(calls).toEqual(['registry', 'catalog:atomic', 'cli']);
    expect(options.stageCatalogRelease).toHaveBeenCalledWith(
      ['--catalog-version', '2.0.0'],
      { previousReleaseLedger: releaseHistory.mergedLedger },
    );
  });

  it('publishes tag, then CLI, then promotion when the catalog needs the candidate CLI', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const calls: string[] = [];
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '0.9.0';
    });
    const result = await publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async (_history, _root, publisherOptions) => {
          calls.push(`catalog:${publisherOptions.publicationMode}`);
          return { validation: { manifest: { catalogVersion: '2.0.0' } } };
        },
        publishCli: async () => {
          calls.push('cli');
          return { version: '1.0.0' };
        },
        promoteCatalogTag: async () => {
          calls.push('promotion');
          return { promoted: true };
        },
      },
    );
    expect(result.path).toBe('tag-first');
    expect(calls).toEqual(['registry', 'catalog:tag', 'cli', 'promotion']);
  });

  it('skips CLI publication when the exact candidate is already published', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory, '1.0.0', '1.0.0');
    options.stageCatalogRelease.mockResolvedValue({
      outputRoot: '/tmp/catalog-stage',
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
    });
    const calls: string[] = [];
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '1.0.0';
    });
    const publishCli = vi.fn();
    const result = await publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => {
          calls.push('catalog:atomic');
          return { validation: { manifest: { catalogVersion: '2.0.0' } } };
        },
        publishCli,
      },
    );

    expect(calls).toEqual(['registry', 'catalog:atomic']);
    expect(publishCli).not.toHaveBeenCalled();
    expect(result.cli).toEqual({
      status: 'already-published',
      version: '1.0.0',
    });
  });

  it.each([
    {
      name: 'lower precedence',
      currentCliVersion: '1.0.0',
      publishedCliVersion: '1.1.0',
      message: 'must be higher than the published latest CLI 1.1.0',
    },
    {
      name: 'equal precedence with a different string',
      currentCliVersion: '1.0.0+candidate',
      publishedCliVersion: '1.0.0+published',
      message: 'same SemVer precedence but a different version string',
    },
  ])('fails closed for a $name candidate before any ref or CLI write', async ({
    currentCliVersion,
    publishedCliVersion,
    message,
  }) => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory, currentCliVersion, publishedCliVersion);
    const calls: string[] = [];
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return publishedCliVersion;
    });
    const publishStagedCatalog = vi.fn(() => {
      calls.push('catalog');
    });
    const publishCli = vi.fn(() => {
      calls.push('cli');
    });
    const promoteCatalogTag = vi.fn(() => {
      calls.push('promotion');
    });

    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog,
        publishCli,
        promoteCatalogTag,
      },
    )).rejects.toThrow(message);

    expect(calls).toEqual(['registry']);
    expect(publishStagedCatalog).not.toHaveBeenCalled();
    expect(publishCli).not.toHaveBeenCalled();
    expect(promoteCatalogTag).not.toHaveBeenCalled();
  });

  it('fails closed when the registry lookup fails before any ref or CLI write', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    options.resolvePublishedCliVersion.mockRejectedValue(new Error('registry unavailable'));
    const publishStagedCatalog = vi.fn();
    const publishCli = vi.fn();
    const promoteCatalogTag = vi.fn();

    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      { ...options, publishStagedCatalog, publishCli, promoteCatalogTag },
    )).rejects.toThrow('registry unavailable');

    expect(publishStagedCatalog).not.toHaveBeenCalled();
    expect(publishCli).not.toHaveBeenCalled();
    expect(promoteCatalogTag).not.toHaveBeenCalled();
  });

  it('reports the fixed recovery command when promotion fails', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => ({ validation: { manifest: { catalogVersion: '2.0.0' } } }),
        publishCli: async () => ({ version: '1.0.0' }),
        promoteCatalogTag: async () => { throw new Error('promotion failed'); },
      },
    )).rejects.toThrow(
      'Recover with: pnpm run release:promote:catalog:latest -- --catalog-version 2.0.0',
    );
  });

  it('keeps the tag unpromoted when CLI publication fails on the tag-first path', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const promoteCatalogTag = vi.fn();
    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => ({ validation: { manifest: { catalogVersion: '2.0.0' } } }),
        publishCli: async () => { throw new Error('npm failed'); },
        promoteCatalogTag,
      },
    )).rejects.toThrow('catalog-v2.0.0 is published, but CLI 1.0.0 publication failed');
    expect(promoteCatalogTag).not.toHaveBeenCalled();
  });

  it('reports that the catalog remains published when CLI publication fails on the catalog-first path', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    options.stageCatalogRelease.mockResolvedValue({
      outputRoot: '/tmp/catalog-stage',
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
    });
    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => ({ validation: { manifest: { catalogVersion: '2.0.0' } } }),
        publishCli: async () => { throw new Error('npm failed'); },
      },
    )).rejects.toThrow('Catalog 2.0.0 (latest) is published, but CLI 1.0.0 publication failed');
  });

  it('stops before verification and staging when the CLI version is wrong', async () => {
    const runCommand = vi.fn();
    const stageCatalogRelease = vi.fn();
    await expect(publishRelease(
      ['beta', '--cli-version', '1.0.1', '--catalog-version', '2.0.0-beta.1'],
      {
        runCommand,
        stageCatalogRelease,
        readCliPackageJson: async () => ({ version: '1.0.0' }),
      },
    )).rejects.toThrow('CLI version mismatch');
    expect(runCommand).not.toHaveBeenCalled();
    expect(stageCatalogRelease).not.toHaveBeenCalled();
  });
});
