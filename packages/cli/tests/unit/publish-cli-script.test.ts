import { afterEach, describe, expect, it, vi } from 'vitest';

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
    packCliResult?: string;
    registryUrl?: string;
    runCommandImpl?: (
      command: string,
      args: string[],
      commandOptions?: { env?: NodeJS.ProcessEnv },
    ) => Promise<void> | void;
  } = {},
) {
  const calls: Call[] = [];
  const commandOptions: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
  const packSnapshots: unknown[] = [];
  const registryResolveCalls: Array<{ packageJsonPath: string; env: NodeJS.ProcessEnv }> = [];
  const snapshot = {
    root: '/tmp/build-snapshot',
    generationId: 'generation-a',
    outputDigest: 'digest-a',
    cliPackageRoot: '/tmp/build-snapshot/packages/cli',
    cliDistRoot: '/tmp/build-snapshot/packages/cli/dist',
    catalogOutputRoot: '/tmp/build-snapshot/packages/cli/plugins-dist',
  };
  let snapshotRequests = 0;
  let snapshotCleanups = 0;

  vi.doMock('../../../../scripts/release/common.mjs', () => ({
    assertVersionKind: vi.fn(),
    packCli: vi.fn(async ({ snapshot: packSnapshot }: { snapshot: unknown }) => {
      calls.push({ type: 'pack' });
      packSnapshots.push(packSnapshot);
      return options.packCliResult ?? '/tmp/aw.tgz';
    }),
    readPackageJson: vi.fn(async () => ({
      version: options.snapshotVersion ?? options.cliVersion ?? '1.0.0-beta.16',
    })),
    readCliPackageJson: vi.fn(async () => ({
      version: options.cliVersion ?? '1.0.0-beta.16',
    })),
    relativeToRepo: vi.fn((target: string) => target),
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
      runOptions?: { env?: NodeJS.ProcessEnv },
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
    snapshot,
    get snapshotRequests() {
      return snapshotRequests;
    },
    get snapshotCleanups() {
      return snapshotCleanups;
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

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('publish-cli script', () => {
  it('adds no-git-checks when version sync is the only dirty change', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      gitCheckArgs: ['--no-git-checks'],
      packCliResult: '/tmp/aw-1.0.0-beta.16.tgz',
    });

    await expect(harness.publishCli(['beta'])).resolves.toMatchObject({
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
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('keeps the default git checks when the worktree is already clean', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0',
      gitCheckArgs: [],
      packCliResult: '/tmp/aw-1.0.0.tgz',
    });

    await expect(harness.publishCli(['latest'])).resolves.toMatchObject({
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

    await expect(harness.publishCli(['beta'])).rejects.toThrow('Unexpected changes:\n- README.md');

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
    ]);
    expect(harness.snapshotRequests).toBe(0);
  });

  it('uses an explicit snapshot without re-running verify or acquiring another snapshot', async () => {
    const harness = await loadPublishCliHarness({
      cliVersion: '1.0.0-beta.16',
      packCliResult: '/tmp/explicit-snapshot.tgz',
    });

    await expect(harness.publishCli(['beta'], {
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

    await expect(harness.publishCli(['beta'], {
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

    await expect(harness.publishCli(['beta'], {
      expectedVersion: '1.0.0-beta.16',
      skipVerify: true,
      snapshot: harness.snapshot,
    })).rejects.toThrow(
      'CLI snapshot version mismatch: expected 1.0.0-beta.16, found 1.0.0-beta.17',
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

    await expect(harness.publishCli(['beta'])).rejects.toThrow('publish failed');
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
    expect(harness.packSnapshots).toEqual([harness.snapshot]);
  });
});
