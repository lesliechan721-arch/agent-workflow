import { afterEach, describe, expect, it, vi } from 'vitest';

type ReleaseCall =
  | { type: 'command'; command: string; args: string[] }
  | { type: 'catalog-preflight'; snapshot: unknown; catalogVersion: string }
  | { type: 'cli-publish'; snapshot: unknown; skipVerify: boolean; expectedVersion: string }
  | { type: 'catalog-publish'; snapshot: unknown; catalogVersion: string };

interface SnapshotFixture {
  root: string;
  generationId: string;
  outputDigest: string;
  cliPackageRoot: string;
  cliDistRoot: string;
  catalogOutputRoot: string;
}

async function loadPublishReleaseHarness(
  options: {
    cliVersion?: string;
    runCommandImpl?: (command: string, args: string[]) => Promise<void> | void;
    preflightImpl?: (args: Record<string, unknown>) => Promise<void> | void;
    publishCliImpl?: (args: Record<string, unknown>) => Promise<void> | void;
    publishCatalogImpl?: (args: Record<string, unknown>) => Promise<void> | void;
  } = {},
) {
  const calls: ReleaseCall[] = [];
  const snapshots: SnapshotFixture[] = [
    {
      root: '/tmp/build-generation-a',
      generationId: 'generation-a',
      outputDigest: 'digest-a',
      cliPackageRoot: '/tmp/build-generation-a/packages/cli',
      cliDistRoot: '/tmp/build-generation-a/packages/cli/dist',
      catalogOutputRoot: '/tmp/build-generation-a/packages/cli/plugins-dist',
    },
    {
      root: '/tmp/build-generation-b',
      generationId: 'generation-b',
      outputDigest: 'digest-b',
      cliPackageRoot: '/tmp/build-generation-b/packages/cli',
      cliDistRoot: '/tmp/build-generation-b/packages/cli/dist',
      catalogOutputRoot: '/tmp/build-generation-b/packages/cli/plugins-dist',
    },
  ];
  let nextSnapshotIndex = 0;
  let snapshotRequests = 0;
  let snapshotCleanups = 0;

  vi.doMock('../../../../scripts/release/common.mjs', () => ({
    preflightCatalogRelease: vi.fn(async (args: Record<string, unknown>) => {
      const snapshot = args.snapshot as SnapshotFixture;
      calls.push({
        type: 'catalog-preflight',
        snapshot,
        catalogVersion: String(args.catalogVersion),
      });
      await options.preflightImpl?.(args);
      return {
        channel: args.channel,
        catalogVersion: args.catalogVersion,
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
      };
    }),
    publishCatalogRelease: vi.fn(async (args: Record<string, unknown>) => {
      const snapshot = args.snapshot as SnapshotFixture;
      calls.push({
        type: 'catalog-publish',
        snapshot,
        catalogVersion: String(args.catalogVersion),
      });
      await options.publishCatalogImpl?.(args);
      return {
        catalogVersion: args.catalogVersion,
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
      };
    }),
    readCliPackageJson: vi.fn(async () => ({
      version: options.cliVersion ?? '1.0.0',
    })),
    runCommand: vi.fn(async (command: string, args: string[]) => {
      calls.push({ type: 'command', command, args });
      await options.runCommandImpl?.(command, args);
    }),
    withReleaseBuildSnapshot: vi.fn(async (
      callback: (snapshot: SnapshotFixture) => Promise<unknown>,
    ) => {
      snapshotRequests += 1;
      const snapshot = snapshots[nextSnapshotIndex] ?? snapshots.at(-1)!;
      try {
        return await callback(snapshot);
      } finally {
        snapshotCleanups += 1;
      }
    }),
  }));
  vi.doMock('../../../../scripts/release/publish-cli.mjs', () => ({
    publishCli: vi.fn(async (
      _argv: string[],
      publishOptions: Record<string, unknown>,
    ) => {
      const snapshot = publishOptions.snapshot as SnapshotFixture;
      calls.push({
        type: 'cli-publish',
        snapshot,
        skipVerify: Boolean(publishOptions.skipVerify),
        expectedVersion: String(publishOptions.expectedVersion),
      });
      await options.publishCliImpl?.(publishOptions);
      return {
        version: publishOptions.expectedVersion,
        tarballPath: '/tmp/aw.tgz',
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
      };
    }),
  }));

  const module = await import(
    new URL(`../../../../scripts/release/publish-release.mjs?test=${Math.random()}`, import.meta.url).href
  );

  return {
    calls,
    snapshots,
    advanceSnapshotSource() {
      nextSnapshotIndex = Math.min(nextSnapshotIndex + 1, snapshots.length - 1);
    },
    get snapshotRequests() {
      return snapshotRequests;
    },
    get snapshotCleanups() {
      return snapshotCleanups;
    },
    publishRelease: module.publishRelease as (argv?: string[]) => Promise<{
      mode: 'beta' | 'latest';
      currentCliVersion: string;
      catalogVersion: string;
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

describe('publish-release script', () => {
  it('publishes CLI then catalog from one snapshot after catalog preflight', async () => {
    const harness = await loadPublishReleaseHarness({ cliVersion: '1.0.0' });

    await expect(harness.publishRelease([
      'latest',
      '--cli-version',
      '1.0.0',
      '--catalog-version',
      '2.0.0',
    ])).resolves.toMatchObject({
      mode: 'latest',
      currentCliVersion: '1.0.0',
      catalogVersion: '2.0.0',
      generationId: 'generation-a',
      outputDigest: 'digest-a',
    });

    expect(harness.calls).toEqual([
      { type: 'command', command: 'pnpm', args: ['run', 'release:verify:cli'] },
      { type: 'command', command: 'pnpm', args: ['run', 'release:verify:catalog'] },
      {
        type: 'catalog-preflight',
        snapshot: harness.snapshots[0],
        catalogVersion: '2.0.0',
      },
      {
        type: 'cli-publish',
        snapshot: harness.snapshots[0],
        skipVerify: true,
        expectedVersion: '1.0.0',
      },
      {
        type: 'catalog-publish',
        snapshot: harness.snapshots[0],
        catalogVersion: '2.0.0',
      },
    ]);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('keeps one generation when force changes the available source after preflight and CLI publish', async () => {
    let harness: Awaited<ReturnType<typeof loadPublishReleaseHarness>>;
    harness = await loadPublishReleaseHarness({
      preflightImpl: async () => {
        harness.advanceSnapshotSource();
      },
      publishCliImpl: async () => {
        harness.advanceSnapshotSource();
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).resolves.toMatchObject({ generationId: 'generation-a' });

    const releaseContexts = harness.calls.filter((call) =>
      call.type === 'catalog-preflight' ||
      call.type === 'cli-publish' ||
      call.type === 'catalog-publish'
    );
    expect(releaseContexts.map((call) => call.snapshot)).toEqual([
      harness.snapshots[0],
      harness.snapshots[0],
      harness.snapshots[0],
    ]);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('stops before snapshot allocation when catalog verify fails', async () => {
    const harness = await loadPublishReleaseHarness({
      runCommandImpl: async (_command, args) => {
        if (args[1] === 'release:verify:catalog') {
          throw new Error('catalog verify failed');
        }
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow('catalog verify failed');
    expect(harness.calls).toEqual([
      { type: 'command', command: 'pnpm', args: ['run', 'release:verify:cli'] },
      { type: 'command', command: 'pnpm', args: ['run', 'release:verify:catalog'] },
    ]);
    expect(harness.snapshotRequests).toBe(0);
    expect(harness.snapshotCleanups).toBe(0);
  });

  it.each(['sidecar', 'full'])(
    'stops before CLI publish when exact-version %s package bytes differ',
    async (kind) => {
      const harness = await loadPublishReleaseHarness({
        preflightImpl: async () => {
          throw new Error(`Existing ${kind} catalog package does not match staged contents.`);
        },
      });

      await expect(harness.publishRelease([
        'beta',
        '--catalog-version',
        '2.0.0-beta.1',
      ])).rejects.toThrow(`Existing ${kind} catalog package does not match staged contents.`);
      expect(harness.calls.some((call) => call.type === 'cli-publish')).toBe(false);
      expect(harness.snapshotRequests).toBe(1);
      expect(harness.snapshotCleanups).toBe(1);
    },
  );

  it('stops before CLI publish when a resolved exact-version tarball cannot be downloaded', async () => {
    const harness = await loadPublishReleaseHarness({
      preflightImpl: async () => {
        throw new Error('HTTP 404 while downloading resolved catalog tarball');
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow('HTTP 404 while downloading resolved catalog tarball');
    expect(harness.calls.some((call) => call.type === 'cli-publish')).toBe(false);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('keeps the catalog-only retry guidance and cleans snapshot after CLI succeeds', async () => {
    const harness = await loadPublishReleaseHarness({
      publishCatalogImpl: async () => {
        throw new Error('catalog registry failed');
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow(
      'Re-run catalog only: pnpm run release:publish:catalog:beta -- --catalog-version 2.0.0-beta.1',
    );
    expect(harness.calls.map((call) => call.type)).toEqual([
      'command',
      'command',
      'catalog-preflight',
      'cli-publish',
      'catalog-publish',
    ]);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });

  it('stops before catalog publish and cleans snapshot when CLI tarball publish fails', async () => {
    const harness = await loadPublishReleaseHarness({
      publishCliImpl: async () => {
        throw new Error('CLI tarball publish failed');
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow('CLI tarball publish failed');
    expect(harness.calls.some((call) => call.type === 'catalog-publish')).toBe(false);
    expect(harness.snapshotRequests).toBe(1);
    expect(harness.snapshotCleanups).toBe(1);
  });
});
