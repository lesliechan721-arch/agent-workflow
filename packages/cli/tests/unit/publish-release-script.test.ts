import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { publishRelease } from '../../../../scripts/release/publish-release.mjs';
import { compareStrictSemVer } from '../../src/utils/manifest.js';

function history(compare: (left: string, right: string) => number) {
  return {
    mergedLedger: { schemaVersion: 2, records: [] },
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
  const snapshot = {
    root: '/tmp/release-snapshot',
    generationId: 'generation-a',
    outputDigest: 'output-a',
    inputDigest: 'input-a',
    cliPackageDigest: 'package-a',
    evalPackageRoot: '/tmp/release-snapshot/packages/agent-skill-eval',
    cliPackageRoot: '/tmp/release-snapshot/packages/cli',
    cliDistRoot: '/tmp/release-snapshot/packages/cli/dist',
    catalogOutputRoot: '/tmp/release-snapshot/packages/cli/plugins-dist',
  };
  return {
    snapshot,
    assertReleaseWorktreeClean: vi.fn(async () => undefined),
    withReleaseBuildSnapshot: vi.fn(async (callback: (value: typeof snapshot) => Promise<unknown>) =>
      callback(snapshot)),
    resolveReleaseHead: vi.fn(async () => 'a'.repeat(40)),
    assertCurrentReleaseIdentity: vi.fn(async () => undefined),
    withCatalogPublicationLease: vi.fn(async (_remote: string, callback: (lease: object) => Promise<unknown>) =>
      callback({ ownerCommit: 'lease-owner' })),
    runCommand: vi.fn(async () => undefined),
    readCliPackageJson: vi.fn(async () => ({ version: currentCliVersion })),
    readCatalogPublicationHistory: vi.fn(async () => releaseHistory),
    stageCatalogRelease: vi.fn(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '1.0.0' } } },
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
      cliPackageDigest: snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    })),
    resolvePublishedCliVersion: vi.fn(async () => publishedCliVersion),
    prepareEvalPublication: vi.fn(async () => ({
      status: 'already-published',
      version: currentCliVersion,
      candidateTreeDigest: `sha256:${'a'.repeat(64)}`,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
    })),
  };
}

describe('combined release script', () => {
  it('rejects unexpected dirty files before verification or catalog-first ref writes', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const dirtyError = new Error('Refusing to publish from a dirty working tree.');
    const assertReleaseWorktreeClean = vi.fn(async () => { throw dirtyError; });
    const withCatalogPublicationLease = vi.fn();

    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      { ...options, assertReleaseWorktreeClean, withCatalogPublicationLease },
    )).rejects.toThrow('dirty working tree');

    expect(options.runCommand).not.toHaveBeenCalled();
    expect(withCatalogPublicationLease).not.toHaveBeenCalled();
  });

  it('publishes a compatible catalog atomically before publishing the CLI', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const calls: string[] = [];
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
      generationId: options.snapshot.generationId,
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '0.9.0';
    });
    const publishCli = vi.fn(async () => {
      calls.push('cli');
      return { version: '1.0.0' };
    });
    const result = await publishRelease(
      ['latest', '--cli-version', '1.0.0', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: vi.fn(async (_history, _root, publisherOptions) => {
          calls.push(`catalog:${publisherOptions.publicationMode}`);
          return { validation: { manifest: { catalogVersion: '2.0.0' } } };
        }),
        publishCli,
      },
    );
    expect(result.path).toBe('catalog-first');
    expect(calls).toEqual(['registry', 'catalog:atomic', 'cli']);
    expect(options.stageCatalogRelease).toHaveBeenCalledWith(
      ['--catalog-version', '2.0.0'],
      expect.objectContaining({
        previousReleaseLedger: releaseHistory.mergedLedger,
        snapshot: options.snapshot,
        releaseIdentity: expect.objectContaining({
          generationId: 'generation-a',
          outputDigest: 'output-a',
          headCommit: 'a'.repeat(40),
        }),
      }),
    );
    const stageOptions = options.stageCatalogRelease.mock.calls[0]![1];
    expect(path.isAbsolute(stageOptions.internalOutputRoot)).toBe(true);
    expect(stageOptions.internalOutputRoot).not.toBe(
      path.resolve(process.cwd(), '..', '..', '.release', 'catalog-staging', 'catalog'),
    );
    expect(publishCli).toHaveBeenCalledWith([
      'latest', '--cli-version', '1.0.0',
    ], expect.objectContaining({
      snapshot: options.snapshot,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    expect(options.withReleaseBuildSnapshot).toHaveBeenCalledTimes(1);
  });

  it('publishes tag, then CLI, then promotion when the catalog needs the candidate CLI', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const calls: string[] = [];
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '0.9.0';
    });
    const publishCli = vi.fn(async () => {
      calls.push('cli');
      return { version: '1.0.0' };
    });
    const result = await publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async (_history, _root, publisherOptions) => {
          calls.push(`catalog:${publisherOptions.publicationMode}`);
          return { validation: { manifest: { catalogVersion: '2.0.0' } } };
        },
        publishCli,
        promoteCatalogTag: async () => {
          calls.push('promotion');
          return { promoted: true };
        },
      },
    );
    expect(result.path).toBe('tag-first');
    expect(calls).toEqual(['registry', 'catalog:tag', 'cli', 'promotion']);
    const stageOptions = options.stageCatalogRelease.mock.calls[0]![1];
    expect(publishCli).toHaveBeenCalledWith([
      'latest', '--cli-version', '1.0.0',
    ], expect.objectContaining({
      snapshot: options.snapshot,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
  });

  it('skips CLI publication when the exact candidate is already published', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory, '1.0.0', '1.0.0');
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
      generationId: options.snapshot.generationId,
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const calls: string[] = [];
    options.resolvePublishedCliVersion.mockImplementation(async () => {
      calls.push('registry');
      return '1.0.0';
    });
    const publishCli = vi.fn(async () => ({
      status: 'already-published',
      version: '1.0.0',
      evalPackage: { status: 'already-published', version: '1.0.0' },
    }));
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
    expect(publishCli).toHaveBeenCalledOnce();
    expect(result.cli).toMatchObject({
      status: 'already-published',
      version: '1.0.0',
    });
  });

  it('completes the Eval package gate before any immutable catalog ref or CLI write', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    const calls: string[] = [];
    options.prepareEvalPublication.mockImplementation(async () => {
      calls.push('eval-gate');
      return {
        status: 'already-published',
        version: '1.0.0',
        candidateTreeDigest: `sha256:${'a'.repeat(64)}`,
        generationId: options.snapshot.generationId,
        outputDigest: options.snapshot.outputDigest,
        inputDigest: options.snapshot.inputDigest,
      };
    });

    await publishRelease(['latest', '--catalog-version', '2.0.0'], {
      ...options,
      publishStagedCatalog: async () => {
        calls.push('catalog');
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
    });

    expect(calls).toEqual(['eval-gate', 'catalog', 'cli', 'promotion']);
  });

  it('writes no catalog ref or CLI package when the partial-retry Eval gate finds different files', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    options.prepareEvalPublication.mockRejectedValue(
      new Error('Published shared Eval has different package files from the release candidate.'),
    );
    const publishStagedCatalog = vi.fn();
    const publishCli = vi.fn();

    await expect(publishRelease(['latest', '--catalog-version', '2.0.0'], {
      ...options,
      publishStagedCatalog,
      publishCli,
    })).rejects.toThrow('different package files');

    expect(publishStagedCatalog).not.toHaveBeenCalled();
    expect(publishCli).not.toHaveBeenCalled();
  });

  it('does not publish Eval or write release refs when the staged catalog requires a newer CLI', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory, '1.0.0', '0.9.0');
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '1.1.0' } } },
      generationId: options.snapshot.generationId,
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const publishStagedCatalog = vi.fn();
    const publishCli = vi.fn();

    await expect(publishRelease(['latest', '--catalog-version', '2.0.0'], {
      ...options,
      publishStagedCatalog,
      publishCli,
    })).rejects.toThrow('requires aw >= 1.1.0');

    expect(options.prepareEvalPublication).not.toHaveBeenCalled();
    expect(publishStagedCatalog).not.toHaveBeenCalled();
    expect(publishCli).not.toHaveBeenCalled();
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

  it('rejects staged bytes from a different build generation before compatibility or ref writes', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
      generationId: 'generation-b',
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    const resolvePublishedCliVersion = vi.fn();
    const publishStagedCatalog = vi.fn();

    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      { ...options, resolvePublishedCliVersion, publishStagedCatalog },
    )).rejects.toThrow('generationId does not match the bound release generation');

    expect(resolvePublishedCliVersion).not.toHaveBeenCalled();
    expect(publishStagedCatalog).not.toHaveBeenCalled();
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
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
      generationId: options.snapshot.generationId,
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    await expect(publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => ({ validation: { manifest: { catalogVersion: '2.0.0' } } }),
        publishCli: async () => { throw new Error('npm failed'); },
      },
    )).rejects.toThrow('Catalog 2.0.0 (latest) is published, but CLI 1.0.0 publication failed');
  });

  it('detects a HEAD switch between catalog publication and CLI packing', async () => {
    const releaseHistory = history(compareStrictSemVer);
    const options = commonOptions(releaseHistory);
    options.stageCatalogRelease.mockImplementation(async (_argv, stageOptions) => ({
      outputRoot: stageOptions.internalOutputRoot,
      manifest: { compatibility: { aw: { minVersion: '0.9.0' } } },
      generationId: options.snapshot.generationId,
      outputDigest: options.snapshot.outputDigest,
      inputDigest: options.snapshot.inputDigest,
      cliPackageDigest: options.snapshot.cliPackageDigest,
      releaseIdentity: stageOptions.releaseIdentity,
    }));
    options.assertCurrentReleaseIdentity
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Release HEAD changed during publication'));
    const publishCli = vi.fn();

    const error = await publishRelease(
      ['latest', '--catalog-version', '2.0.0'],
      {
        ...options,
        publishStagedCatalog: async () => ({ validation: { manifest: { catalogVersion: '2.0.0' } } }),
        publishCli,
      },
    ).catch((caught) => caught);
    expect(error.cause).toEqual(expect.objectContaining({
      message: 'Release HEAD changed during publication',
    }));
    expect(publishCli).not.toHaveBeenCalled();
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
