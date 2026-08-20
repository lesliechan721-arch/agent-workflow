import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { withCatalogPublicationLease as withRealCatalogPublicationLease } from '../../../../scripts/release/git-catalog-publisher.mjs';
import { parseArgs as parsePublishCliArgs } from '../../../../scripts/release/publish-cli.mjs';

const execFileAsync = promisify(execFile);
const tempRoots: string[] = [];

interface CommandCall {
  type: 'command';
  command: string;
  args: string[];
}

interface PackCall {
  type: 'pack';
}

type Call = CommandCall | PackCall;

async function loadPublishCliHarness(
  options: {
    cliVersion?: string;
    snapshotVersion?: string;
    gitCheckArgs?: string[];
    gitCheckError?: Error;
    freshnessError?: Error;
    packCliResult?: string;
    registryUrl?: string;
    publishedVersion?: string;
    evalPublished?: boolean;
    publishedEvalMatches?: boolean;
    resolvePublishedCliVersionImpl?: (mode: string) => Promise<string> | string;
    withCatalogPublicationLeaseImpl?: (
      remoteUrl: string,
      callback: (lease: object) => Promise<unknown>,
      publisherOptions?: object,
    ) => Promise<unknown>;
    runCommandImpl?: (
      command: string,
      args: string[],
      commandOptions?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
    ) => Promise<void> | void;
  } = {},
) {
  const calls: Call[] = [];
  const commandOptions: Array<{
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  } | undefined> = [];
  const packSnapshots: unknown[] = [];
  const registryResolveCalls: Array<{ packageJsonPath: string; env: NodeJS.ProcessEnv }> = [];
  const registryComparisonCalls: string[] = [];
  const snapshot = {
    root: '/tmp/build-snapshot',
    generationId: 'generation-a',
    outputDigest: 'digest-a',
    inputDigest: 'input-a',
    cliPackageDigest: 'package-a',
    evalPackageRoot: '/tmp/build-snapshot/packages/agent-skill-eval',
    cliPackageRoot: '/tmp/build-snapshot/packages/cli',
    cliDistRoot: '/tmp/build-snapshot/packages/cli/dist',
    catalogOutputRoot: '/tmp/build-snapshot/packages/cli/plugins-dist',
  };
  let snapshotRequests = 0;
  let snapshotCleanups = 0;
  let publicationLeaseRequests = 0;

  vi.doMock('../../../../scripts/release/git-catalog-publisher.mjs', () => ({
    OFFICIAL_CATALOG_PUBLISH_REMOTE: 'https://catalog.example.test/repository.git',
    withCatalogPublicationLease: vi.fn(async (
      remoteUrl: string,
      callback: (lease: object) => Promise<unknown>,
      publisherOptions?: object,
    ) => {
      publicationLeaseRequests += 1;
      if (options.withCatalogPublicationLeaseImpl) {
        return options.withCatalogPublicationLeaseImpl(remoteUrl, callback, publisherOptions);
      }
      return callback({
        ref: 'refs/heads/aw-release/publication-lock',
        ownerCommit: 'unit-owner',
        remoteUrl,
      });
    }),
  }));

  vi.doMock('../../../../scripts/release/common.mjs', () => ({
    assertCurrentReleaseIdentity: vi.fn(async () => {
      if (options.freshnessError) throw options.freshnessError;
    }),
    assertReleaseSnapshotIdentity: vi.fn(),
    assertVersionKind: vi.fn(),
    createReleaseSnapshotIdentity: vi.fn((releaseSnapshot: typeof snapshot, headCommit: string) => ({
      generationId: releaseSnapshot.generationId,
      outputDigest: releaseSnapshot.outputDigest,
      inputDigest: releaseSnapshot.inputDigest,
      cliPackageDigest: releaseSnapshot.cliPackageDigest,
      headCommit,
    })),
    withPrivateCliTarball: vi.fn(async (
      packSnapshot: unknown,
      callback: (tarballPath: string) => Promise<unknown>,
    ) => {
      calls.push({ type: 'pack' });
      packSnapshots.push(packSnapshot);
      return callback(options.packCliResult ?? '/tmp/aw.tgz');
    }),
    withPrivateEvalTarball: vi.fn(async (
      _packSnapshot: unknown,
      callback: (tarballPath: string) => Promise<unknown>,
    ) => callback('/tmp/agent-skill-eval.tgz')),
    assertPublishedPackageTarballMatchesCandidate: vi.fn(async (
      packageName: string,
      version: string,
      _packageJsonPath: string,
      tarballPath: string,
    ) => {
      registryComparisonCalls.push(`${packageName}@${version}:${tarballPath}`);
      if (options.publishedEvalMatches === false) {
        throw new Error(`Published ${packageName}@${version} has different package files from the release candidate.`);
      }
      return {
        candidateTreeDigest: `sha256:${'a'.repeat(64)}`,
        publishedTreeDigest: `sha256:${'a'.repeat(64)}`,
        registryUrl: options.registryUrl ?? 'https://registry.example.test/',
      };
    }),
    computePackageTarballTreeDigest: vi.fn(async () => `sha256:${'a'.repeat(64)}`),
    isExactPackageVersionPublished: vi.fn(async () => options.evalPublished ?? true),
    readPackageJson: vi.fn(async (packageJsonPath: string) => ({
      ...(packageJsonPath.includes('agent-skill-eval')
        ? { name: '@lesliechan721/agent-skill-eval' }
        : {}),
      version: options.snapshotVersion ?? options.cliVersion ?? '1.0.0-beta.16',
    })),
    readCliPackageJson: vi.fn(async () => ({
      version: options.cliVersion ?? '1.0.0-beta.16',
    })),
    RELEASE_NETWORK_TIMEOUT_MS: 120_000,
    relativeToRepo: vi.fn((target: string) => target),
    resolveCliPublicationGate: vi.fn(({ mode, candidateVersion, publishedVersion }: {
      mode: string;
      candidateVersion: string;
      publishedVersion: string;
    }) => {
      if (candidateVersion === publishedVersion) {
        return { status: 'already-published', version: candidateVersion };
      }
      if (candidateVersion < publishedVersion) {
        throw new Error(
          `CLI candidate ${candidateVersion} must be higher than the published ${mode} CLI ${publishedVersion}.`,
        );
      }
      return { status: 'publish', version: candidateVersion };
    }),
    resolvePublishedCliVersion: vi.fn(async (mode: string) =>
      options.resolvePublishedCliVersionImpl?.(mode)
      ?? options.publishedVersion
      ?? (mode === 'beta' ? '1.0.0-beta.15' : '0.9.0')),
    resolveReleaseHead: vi.fn(async () => 'a'.repeat(40)),
    resolveRegistryUrl: vi.fn(async (packageJsonPath: string, env: NodeJS.ProcessEnv) => {
      registryResolveCalls.push({ packageJsonPath, env });
      return options.registryUrl ?? 'https://registry.example.test/';
    }),
    resolveCliPublishGitCheckArgs: vi.fn(async () => {
      if (options.gitCheckError) {
        throw options.gitCheckError;
      }
      return options.gitCheckArgs ?? [];
    }),
    runCommand: vi.fn(async (
      command: string,
      args: string[],
      runOptions?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
    ) => {
      calls.push({ type: 'command', command, args });
      commandOptions.push(runOptions);
      await options.runCommandImpl?.(command, args, runOptions);
    }),
    withReleaseBuildSnapshot: vi.fn(async (callback: (snapshot: unknown) => Promise<unknown>) => {
      snapshotRequests += 1;
      try {
        return await callback(snapshot);
      } finally {
        snapshotCleanups += 1;
      }
    }),
  }));

  const module = await import(
    new URL(`../../../../scripts/release/publish-cli.mjs?test=${Math.random()}`, import.meta.url).href
  );

  return {
    calls,
    commandOptions,
    packSnapshots,
    registryResolveCalls,
    registryComparisonCalls,
    snapshot,
    get snapshotRequests() {
      return snapshotRequests;
    },
    get snapshotCleanups() {
      return snapshotCleanups;
    },
    get publicationLeaseRequests() {
      return publicationLeaseRequests;
    },
    publishCli: module.publishCli as (argv?: string[], options?: Record<string, unknown>) => Promise<{
      mode: 'beta' | 'latest';
      version: string;
      tarballPath: string;
      registryUrl: string;
      generationId: string;
      outputDigest: string;
    }>,
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('publish-cli script', () => {
  it.each([
    ['latest', ['latest', '--', '--cli-version', '1.0.0']],
    ['latest with repeated separators', ['latest', '--', '--', '--cli-version', '1.0.0']],
  ])('accepts the pnpm argument separator after the publish mode (%s)', (_label, argv) => {
    expect(parsePublishCliArgs(argv)).toMatchObject({
      mode: 'latest',
      cliVersion: '1.0.0',
    });
  });

  it.each([
    ['unknown option', ['latest', '--', '--unknown', '1.0.0']],
    ['extra positional argument', ['latest', '--', '--cli-version', '1.0.0', 'extra']],
    ['extra separator after the version', ['latest', '--', '--cli-version', '1.0.0', '--']],
  ])('still rejects %s at the public parser boundary', (_label, argv) => {
    expect(() => parsePublishCliArgs(argv)).toThrow('Unknown or extra arguments');
  });

  it.each([
    { argv: ['beta'] },
    { argv: ['beta', '--unknown', '1.0.0-beta.16'] },
    { argv: ['beta', '--cli-version', '1.0.0-beta.16', 'extra'] },
  ])('rejects missing, unknown, or extra standalone arguments before snapshot or npm work', async ({ argv }) => {
    const harness = await loadPublishCliHarness();

    await expect(harness.publishCli(argv)).rejects.toThrow('Unknown or extra arguments');
    expect(harness.snapshotRequests).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('binds the requested CLI version to the live manifest before taking a snapshot', async () => {
    const harness = await loadPublishCliHarness({ cliVersion: '1.0.0-beta.16' });

    await expect(harness.publishCli([
      'beta',
      '--cli-version',
      '1.0.0-beta.17',
    ])).rejects.toThrow('found 1.0.0-beta.16 in packages/cli/package.json');
    expect(harness.snapshotRequests).toBe(0);
    expect(harness.calls).toEqual([]);
  });

  it('does not let concurrent explicit versions publish the live version for the wrong request', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.17',
      publishedVersion: '1.0.0-beta.15',
    });

    const [oldRequest, currentRequest] = await Promise.allSettled([
      harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16']),
      harness.publishCli(['beta', '--cli-version', '1.0.0-beta.17']),
    ]);

    expect(oldRequest).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('expected 1.0.0-beta.16') }),
    });
    expect(currentRequest).toMatchObject({
      status: 'fulfilled',
      value: expect.objectContaining({ version: '1.0.0-beta.17' }),
    });
    expect(harness.calls.filter((call) =>
      call.type === 'command' && call.args[0] === 'publish')).toHaveLength(1);
  });

  it('adds no-git-checks when version sync is the only dirty change', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      gitCheckArgs: ['--no-git-checks'],
      packCliResult: '/tmp/aw-1.0.0-beta.16.tgz',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'])).resolves.toMatchObject({
      mode: 'beta',
      version: '1.0.0-beta.16',
      tarballPath: '/tmp/aw-1.0.0-beta.16.tgz',
      generationId: 'generation-a',
    });

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'pack',
      },
      {
        type: 'command',
        command: 'pnpm',
        args: [
          'publish',
          '/tmp/aw-1.0.0-beta.16.tgz',
          '--ignore-scripts',
          '--tag',
          'beta',
          '--registry',
          'https://registry.example.test/',
          '--no-git-checks',
        ],
      },
    ]);
    expect(harness.packSnapshots).toEqual([harness.snapshot]);
    expect(harness.commandOptions[1]?.timeoutMs).toBe(120_000);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('keeps the default git checks when the worktree is already clean', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0',
      gitCheckArgs: [],
      packCliResult: '/tmp/aw-1.0.0.tgz',
    });

    await expect(harness.publishCli(['latest', '--cli-version', '1.0.0'])).resolves.toMatchObject({
      mode: 'latest',
      version: '1.0.0',
      tarballPath: '/tmp/aw-1.0.0.tgz',
    });

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'pack',
      },
      {
        type: 'command',
        command: 'pnpm',
        args: [
          'publish',
          '/tmp/aw-1.0.0.tgz',
          '--ignore-scripts',
          '--tag',
          'latest',
          '--registry',
          'https://registry.example.test/',
        ],
      },
    ]);
  });

  it('fails closed when the worktree has unrelated changes', async () => {
    const harness = await loadPublishCliHarness({
      gitCheckError: new Error(
        'Refusing to publish from a dirty working tree. Only package.json, packages/cli/package.json may be modified by the version sync step.\nUnexpected changes:\n- README.md',
      ),
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'])).rejects.toThrow('Unexpected changes:\n- README.md');

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
    ]);
    expect(harness.snapshotRequests).toBe(1);
  });

  it('uses an explicit snapshot without re-running verify or acquiring another snapshot', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      packCliResult: '/tmp/explicit-snapshot.tgz',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      expectedVersion: '1.0.0-beta.16',
      skipVerify: true,
      snapshot: harness.snapshot,
    })).resolves.toMatchObject({
      version: '1.0.0-beta.16',
      tarballPath: '/tmp/explicit-snapshot.tgz',
      generationId: 'generation-a',
      outputDigest: 'digest-a',
    });

    expect(harness.calls).toEqual([
      { type: 'pack' },
      {
        type: 'command',
        command: 'pnpm',
        args: [
          'publish',
          '/tmp/explicit-snapshot.tgz',
          '--ignore-scripts',
          '--tag',
          'beta',
          '--registry',
          'https://registry.example.test/',
        ],
      },
    ]);
    expect(harness.packSnapshots).toEqual([harness.snapshot]);
    expect(harness.snapshotRequests).toBe(0);
  });

  it('publishes the tarball with the snapshot registry in every registry environment key', async () => {
    const registryUrl = 'https://aw.example.test/team/';
    const harness = await loadPublishCliHarness({
      registryUrl,
      packCliResult: '/tmp/registry-specific-aw.tgz',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      expectedVersion: '1.0.0-beta.16',
      skipVerify: true,
      snapshot: harness.snapshot,
    })).resolves.toMatchObject({
      tarballPath: '/tmp/registry-specific-aw.tgz',
      registryUrl,
    });

    expect(harness.registryResolveCalls).toEqual([{
      packageJsonPath: '/tmp/build-snapshot/packages/cli/package.json',
      env: process.env,
    }]);
    expect(harness.calls).toEqual([
      { type: 'pack' },
      {
        type: 'command',
        command: 'pnpm',
        args: [
          'publish',
          '/tmp/registry-specific-aw.tgz',
          '--ignore-scripts',
          '--tag',
          'beta',
          '--registry',
          registryUrl,
        ],
      },
    ]);
    expect(harness.commandOptions[0]?.env).toMatchObject({
      AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
    });
  });

  it('rejects a snapshot package version mismatch before packing or publishing', async () => {
    const harness = await loadPublishCliHarness({
      snapshotVersion: '1.0.0-beta.17',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      expectedVersion: '1.0.0-beta.16',
      skipVerify: true,
      snapshot: harness.snapshot,
    })).rejects.toThrow(
      'Shared Eval snapshot version mismatch: expected 1.0.0-beta.16, found 1.0.0-beta.17',
    );

    expect(harness.calls).toEqual([]);
    expect(harness.packSnapshots).toEqual([]);
  });

  it('cleans an owned standalone snapshot when tarball publish fails', async () => {
    const harness = await loadPublishCliHarness({
      runCommandImpl: async (_command, args) => {
        if (args[0] === 'publish') {
          throw new Error('publish failed');
        }
      },
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'])).rejects.toThrow('publish failed');
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
    expect(harness.packSnapshots).toEqual([harness.snapshot]);
  });

  it('returns already-published for an exact dist-tag without verifying, packing, or publishing', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.16',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'])).resolves.toEqual({
      mode: 'beta',
      status: 'already-published',
      version: '1.0.0-beta.16',
      evalPackage: {
        status: 'already-published',
        version: '1.0.0-beta.16',
        candidateTreeDigest: `sha256:${'a'.repeat(64)}`,
        generationId: 'generation-a',
        outputDigest: 'digest-a',
        inputDigest: 'input-a',
      },
    });
    expect(harness.calls).toEqual([]);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.publicationLeaseRequests).toBe(1);
  });

  it('publishes the lockstep shared Eval package before the dependent CLI', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.15',
      evalPublished: false,
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      skipVerify: true,
      snapshot: harness.snapshot,
    })).resolves.toMatchObject({
      version: '1.0.0-beta.16',
      evalPackage: { status: 'published', version: '1.0.0-beta.16' },
    });
    const publishCalls = harness.calls.filter(
      (call): call is CommandCall => call.type === 'command' && call.args[0] === 'publish',
    );
    expect(publishCalls.map((call) => call.args[1])).toEqual([
      '/tmp/agent-skill-eval.tgz',
      '/tmp/aw.tgz',
    ]);
  });

  it('continues a partial retry only when the published Eval package matches the candidate files', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.15',
      evalPublished: true,
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      skipVerify: true,
      snapshot: harness.snapshot,
    })).resolves.toMatchObject({
      version: '1.0.0-beta.16',
      evalPackage: {
        status: 'already-published',
        candidateTreeDigest: `sha256:${'a'.repeat(64)}`,
      },
    });
    expect(harness.registryComparisonCalls).toEqual([
      '@lesliechan721/agent-skill-eval@1.0.0-beta.16:/tmp/agent-skill-eval.tgz',
    ]);
    const publishCalls = harness.calls.filter(
      (call): call is CommandCall => call.type === 'command' && call.args[0] === 'publish',
    );
    expect(publishCalls.map((call) => call.args[1])).toEqual(['/tmp/aw.tgz']);
  });

  it('fails a partial retry before verification or CLI publication when published Eval files differ', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.15',
      evalPublished: true,
      publishedEvalMatches: false,
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16']))
      .rejects.toThrow('has different package files from the release candidate');
    expect(harness.registryComparisonCalls).toHaveLength(1);
    expect(harness.calls).toEqual([]);
  });

  it('rejects a lower standalone candidate before verifying, packing, or publishing', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.17',
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16']))
      .rejects.toThrow('must be higher than the published beta CLI');
    expect(harness.calls).toEqual([]);
    expect(harness.snapshotRequests).toBe(1);
  });

  it('reuses a combined publication lease without acquiring a nested lease', async () => {
    const harness = await loadPublishCliHarness();
    const publicationLease = {
      ref: 'refs/heads/aw-release/publication-lock',
      ownerCommit: 'combined-owner',
      remoteUrl: '/tmp/catalog.git',
    };

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      expectedVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.15',
      skipVerify: true,
      snapshot: harness.snapshot,
      publicationLease,
    })).resolves.toMatchObject({ version: '1.0.0-beta.16' });
    expect(harness.publicationLeaseRequests).toBe(0);
  });

  it('rejects live input drift after packing and before the npm write', async () => {
    const harness = await loadPublishCliHarness({
      freshnessError: new Error(
        'Release live cliPackageDigest no longer matches the bound release identity.',
      ),
    });

    await expect(harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], {
      expectedVersion: '1.0.0-beta.16',
      publishedVersion: '1.0.0-beta.15',
      skipVerify: true,
      snapshot: harness.snapshot,
      publicationLease: { ownerCommit: 'combined-owner' },
    })).rejects.toThrow('live cliPackageDigest');

    expect(harness.calls).toEqual([{ type: 'pack' }]);
  });

  it('serializes standalone publishers and rereads the dist-tag so a retry cannot downgrade it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-publication-lease-'));
    tempRoots.push(root);
    const remoteUrl = path.join(root, 'catalog.git');
    await execFileAsync('git', ['init', '--bare', '--quiet', remoteUrl]);
    let publishedVersion = '1.0.0-beta.15';
    const harness = await loadPublishCliHarness({
      resolvePublishedCliVersionImpl: async () => publishedVersion,
      withCatalogPublicationLeaseImpl: (url, callback, publisherOptions) =>
        withRealCatalogPublicationLease(url, callback, {
          ...publisherOptions,
          publicationLockTimeoutMs: 5_000,
          publicationLockPollIntervalMs: 10,
        }),
      runCommandImpl: async (_command, args) => {
        if (args[0] === 'publish') publishedVersion = '1.0.0-beta.16';
      },
    });

    const results = await Promise.all([
      harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], { remoteUrl }),
      harness.publishCli(['beta', '--cli-version', '1.0.0-beta.16'], { remoteUrl }),
    ]);

    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: '1.0.0-beta.16' }),
      expect.objectContaining({ status: 'already-published', version: '1.0.0-beta.16' }),
    ]));
    expect(harness.calls.filter((call) =>
      call.type === 'command' && call.args[0] === 'publish')).toHaveLength(1);
    expect(harness.publicationLeaseRequests).toBe(2);
  });
});
