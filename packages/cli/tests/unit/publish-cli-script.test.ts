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
    gitCheckArgs?: string[];
    gitCheckError?: Error;
    packCliResult?: string;
    runCommandImpl?: (command: string, args: string[]) => Promise<void> | void;
  } = {},
) {
  const calls: Call[] = [];

  vi.doMock('../../../../scripts/release/common.mjs', () => ({
    assertVersionKind: vi.fn(),
    packCli: vi.fn(async () => {
      calls.push({ type: 'pack' });
      return options.packCliResult ?? '/tmp/aw.tgz';
    }),
    readCliPackageJson: vi.fn(async () => ({
      version: options.cliVersion ?? '1.0.0-beta.16',
    })),
    relativeToRepo: vi.fn((target: string) => target),
    resolveCliPublishGitCheckArgs: vi.fn(async () => {
      if (options.gitCheckError) {
        throw options.gitCheckError;
      }
      return options.gitCheckArgs ?? [];
    }),
    runCommand: vi.fn(async (command: string, args: string[]) => {
      calls.push({ type: 'command', command, args });
      await options.runCommandImpl?.(command, args);
    }),
  }));

  const module = await import(
    new URL(`../../../../scripts/release/publish-cli.mjs?test=${Math.random()}`, import.meta.url).href
  );

  return {
    calls,
    publishCli: module.publishCli as (argv?: string[]) => Promise<{
      mode: 'beta' | 'latest';
      version: string;
      tarballPath: string;
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
        args: ['--filter', '@yiliang/aw', 'publish', '--tag', 'beta', '--no-git-checks'],
      },
    ]);
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
        args: ['--filter', '@yiliang/aw', 'publish', '--tag', 'latest'],
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
  });
});
