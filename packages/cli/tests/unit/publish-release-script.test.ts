import { afterEach, describe, expect, it, vi } from 'vitest';

interface RunCommandCall {
  type: 'command';
  command: string;
  args: string[];
}

interface CatalogPreflightCall {
  type: 'catalog-preflight';
  channel: 'beta' | 'latest';
  catalogVersion: string;
}

interface CatalogPreflightArgs {
  channel: 'beta' | 'latest';
  catalogVersion: string;
  registry: unknown;
}

async function loadPublishReleaseHarness(
  options: {
    cliVersion?: string;
    runCommandImpl?: (command: string, args: string[]) => Promise<void> | void;
    preflightImpl?: (args: CatalogPreflightArgs) => Promise<void> | void;
  } = {},
) {
  const calls: Array<RunCommandCall | CatalogPreflightCall> = [];
  vi.doMock('../../../../scripts/release/common.mjs', () => ({
    createCatalogRegistryAdapter: vi.fn(async () => ({
      kind: 'mock-registry',
    })),
    preflightCatalogRelease: vi.fn(async (args: CatalogPreflightArgs) => {
      calls.push({
        type: 'catalog-preflight',
        channel: args.channel,
        catalogVersion: args.catalogVersion,
      });
      await options.preflightImpl?.(args);
      return {
        channel: args.channel,
        registry: args.registry,
        staged: {
          manifest: {
            catalogVersion: args.catalogVersion,
          },
          sidecarPackageRoot: '/tmp/sidecar',
          fullPackageRoot: '/tmp/full',
        },
      };
    }),
    readCliPackageJson: vi.fn(async () => ({
      version: options.cliVersion ?? '1.0.0',
    })),
    runCommand: vi.fn(async (command: string, args: string[]) => {
      calls.push({ type: 'command', command, args });
      await options.runCommandImpl?.(command, args);
    }),
  }));

  const module = await import(
    new URL(`../../../../scripts/release/publish-release.mjs?test=${Math.random()}`, import.meta.url).href
  );

  return {
    calls,
    publishRelease: module.publishRelease as (argv?: string[]) => Promise<{
      mode: 'beta' | 'latest';
      currentCliVersion: string;
      catalogVersion: string;
    }>,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('publish-release script', () => {
  it('runs catalog-specific preflight before publishing CLI', async () => {
    const harness = await loadPublishReleaseHarness({
      cliVersion: '1.0.0',
    });

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
    });

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:catalog'],
      },
      {
        type: 'catalog-preflight',
        channel: 'latest',
        catalogVersion: '2.0.0',
      },
      {
        type: 'command',
        command: 'node',
        args: ['scripts/release/publish-cli.mjs', 'latest'],
      },
      {
        type: 'command',
        command: 'node',
        args: ['scripts/release/publish-catalog.mjs', 'latest', '--catalog-version', '2.0.0'],
      },
    ]);
  });

  it('stops before CLI publish when catalog verify fails', async () => {
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
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:catalog'],
      },
    ]);
  });

  it('stops before CLI publish when catalog version kind preflight fails', async () => {
    const harness = await loadPublishReleaseHarness({
      preflightImpl: async ({ catalogVersion }) => {
        throw new Error(`Expected a stable version, received prerelease version "${catalogVersion}".`);
      },
    });

    await expect(harness.publishRelease([
      'latest',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow('Expected a stable version');

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:catalog'],
      },
      {
        type: 'catalog-preflight',
        channel: 'latest',
        catalogVersion: '2.0.0-beta.1',
      },
    ]);
  });

  it('stops before CLI publish when catalog history preflight fails', async () => {
    const harness = await loadPublishReleaseHarness({
      preflightImpl: async () => {
        throw new Error('Unable to read target beta catalog history. registry offline');
      },
    });

    await expect(harness.publishRelease([
      'beta',
      '--catalog-version',
      '2.0.0-beta.1',
    ])).rejects.toThrow('Unable to read target beta catalog history');

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:catalog'],
      },
      {
        type: 'catalog-preflight',
        channel: 'beta',
        catalogVersion: '2.0.0-beta.1',
      },
    ]);
  });

  it('stops before CLI publish when catalog history metadata is malformed', async () => {
    const harness = await loadPublishReleaseHarness({
      preflightImpl: async () => {
        throw new Error('Registry metadata for @yiliang/aw-plugins-manifest@2.0.0 is missing dist.integrity or dist.tarball.');
      },
    });

    await expect(harness.publishRelease([
      'latest',
      '--catalog-version',
      '2.0.0',
    ])).rejects.toThrow('missing dist.integrity or dist.tarball');

    expect(harness.calls).toEqual([
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:cli'],
      },
      {
        type: 'command',
        command: 'pnpm',
        args: ['run', 'release:verify:catalog'],
      },
      {
        type: 'catalog-preflight',
        channel: 'latest',
        catalogVersion: '2.0.0',
      },
    ]);
  });
});
