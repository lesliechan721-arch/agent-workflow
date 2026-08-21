import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPlanOnlyCommit,
  createReleasePlan,
  writeReleasePlan,
} from '../../../../scripts/release/release-plan.mjs';
import { releaseStatus } from '../../../../scripts/release/release-status.mjs';
import { prepareRelease } from '../../../../scripts/release/release-prepare.mjs';
import {
  observeRelease,
  readCliReleaseContent,
} from '../../../../scripts/release/release-observe.mjs';
import { calculateReleaseStatus } from '../../../../scripts/release/release-state.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';
import { assertReleaseWorktreeClean } from '../../../../scripts/release/common.mjs';
import { assertVersionTargetsMatchHead } from '../../../../scripts/release/release-target.mjs';

const execute = promisify(execFile);
const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

async function git(root: string, args: string[]): Promise<string> {
  return String((await execute('git', args, { cwd: root })).stdout).trim();
}

async function createRepo(): Promise<{ root: string; head: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-plan-git-'));
  roots.push(root);
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.name', 'Release Fixture']);
  await git(root, ['config', 'user.email', 'release-fixture@example.invalid']);
  await fs.mkdir(path.join(root, 'release'), { recursive: true });
  await fs.writeFile(path.join(root, 'source.txt'), 'source\n');
  await fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
    schemaVersion: 1, cli: '1.0.0', catalog: '1.0.0',
  }, null, 2)}\n`);
  await git(root, ['add', 'source.txt', 'release/version-targets.json']);
  await git(root, ['commit', '--quiet', '-m', 'source']);
  return { root, head: await git(root, ['rev-parse', 'HEAD']) };
}

function observed(head: string) {
  const packages = [
    { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('3'), tarballDigest: digest('7') },
    { name: '@lesliechan721/aw', contentDigest: digest('4'), tarballDigest: digest('8') },
  ];
  return {
    targets: { schemaVersion: 1, cli: '1.0.0', catalog: '1.0.0' },
    content: {
      source: {
        head,
        releaseInputDigest: digest('1'),
        buildOutputDigest: digest('a'),
        cliPackageDigest: digest('b'),
      },
      cli: {
        trainContentDigest: calculateCliTrainContentDigest(packages.map(({ name, contentDigest }) => ({
          name, contentDigest,
        }))),
        packages,
      },
      catalog: {
        minCliVersion: '0.1.0-beta.2',
        contentDigest: digest('5'),
        plugins: [{ name: 'ask-me', targetVersion: '1.0.0', contentDigest: digest('6') }],
      },
    },
    history: {
      registry: {
        '@lesliechan721/agent-skill-eval': [],
        '@lesliechan721/aw': [],
        distTags: {
          '@lesliechan721/agent-skill-eval': { latest: null, beta: null },
          '@lesliechan721/aw': { latest: null, beta: null },
        },
      },
      catalog: { latest: null, beta: null, pending: null, ledger: { schemaVersion: 2, records: [] } },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('release phase 2 process boundaries', () => {
  it('suppresses build child stdout when release observation requests a quiet build', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-quiet-build-'));
    roots.push(root);
    await fs.mkdir(path.join(root, 'packages', 'cli', 'dist'), { recursive: true });
    await fs.mkdir(path.join(root, 'packages', 'agent-skill-eval', 'dist'), { recursive: true });
    const moduleUrl = new URL('../../../../scripts/build/build-cache.mjs', import.meta.url).href;
    const script = [
      `import { runCliBuild } from ${JSON.stringify(moduleUrl)};`,
      `await runCliBuild(${JSON.stringify(root)}, {`,
      `  command: process.execPath,`,
      `  args: ['-e', 'console.log("build-noise"); console.error("build-error-noise")'],`,
      `}, { quiet: true });`,
    ].join('\n');
    const result = await execute(process.execPath, ['--input-type=module', '-e', script]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects version targets hidden by the Git index flag %s',
    async (flag) => {
      const repository = await createRepo();
      await git(repository.root, ['update-index', flag, 'release/version-targets.json']);
      await fs.writeFile(path.join(repository.root, 'release', 'version-targets.json'), `${JSON.stringify({
        schemaVersion: 1, cli: '1.0.1', catalog: '1.0.0',
      }, null, 2)}\n`);
      await expect(assertReleaseWorktreeClean({ cwd: repository.root }))
        .rejects.toThrow(flag.slice(2));
    },
  );

  it('rejects version target bytes that differ from source HEAD', async () => {
    const repository = await createRepo();
    await fs.writeFile(path.join(repository.root, 'release', 'version-targets.json'), `${JSON.stringify({
      schemaVersion: 1, cli: '1.0.1', catalog: '1.0.0',
    }, null, 2)}\n`);
    await expect(assertVersionTargetsMatchHead(repository.root))
      .rejects.toThrow('do not match source HEAD');
  });

  it('accepts an isolated plan-only commit and rejects a mixed commit', async () => {
    const repository = await createRepo();
    const plan = createReleasePlan(calculateReleaseStatus({
      channel: 'beta',
      ...observed(repository.head),
    }));
    await writeReleasePlan(plan, { repoRoot: repository.root });
    await git(repository.root, ['add', 'release']);
    await git(repository.root, ['commit', '--quiet', '-m', 'release plan']);
    await expect(assertPlanOnlyCommit(plan, { repoRoot: repository.root }))
      .resolves.toMatchObject({ parent: repository.head });

    const mixed = await createRepo();
    const mixedPlan = createReleasePlan(calculateReleaseStatus({
      channel: 'beta',
      ...observed(mixed.head),
    }));
    await writeReleasePlan(mixedPlan, { repoRoot: mixed.root });
    await fs.writeFile(path.join(mixed.root, 'source.txt'), 'changed\n');
    await git(mixed.root, ['add', 'release', 'source.txt']);
    await git(mixed.root, ['commit', '--quiet', '-m', 'mixed']);
    await expect(assertPlanOnlyCommit(mixedPlan, { repoRoot: mixed.root }))
      .rejects.toThrow('isolated plan-only commit');
  });

  it('rejects a merge commit and a parent that differs from plan.source.head', async () => {
    const repository = await createRepo();
    const plan = createReleasePlan(calculateReleaseStatus({
      channel: 'beta',
      ...observed('b'.repeat(40)),
    }));
    await writeReleasePlan(plan, { repoRoot: repository.root });
    await git(repository.root, ['add', 'release']);
    await git(repository.root, ['commit', '--quiet', '-m', 'wrong parent']);
    await expect(assertPlanOnlyCommit(plan, { repoRoot: repository.root }))
      .rejects.toThrow('parent does not match');

    const merge = await createRepo();
    const branch = await git(merge.root, ['branch', '--show-current']);
    await git(merge.root, ['checkout', '--quiet', '-b', 'side']);
    await fs.writeFile(path.join(merge.root, 'side.txt'), 'side\n');
    await git(merge.root, ['add', 'side.txt']);
    await git(merge.root, ['commit', '--quiet', '-m', 'side']);
    await git(merge.root, ['checkout', '--quiet', branch]);
    await fs.writeFile(path.join(merge.root, 'main.txt'), 'main\n');
    await git(merge.root, ['add', 'main.txt']);
    await git(merge.root, ['commit', '--quiet', '-m', 'main']);
    await git(merge.root, ['merge', '--quiet', '--no-ff', 'side', '-m', 'merge']);
    await expect(assertPlanOnlyCommit(plan, { repoRoot: merge.root }))
      .rejects.toThrow('exactly one parent');
  });

  it('writes one JSON object to stdout and no status diagnostics to stderr', async () => {
    const output: string[] = [];
    const errors: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      errors.push(String(chunk));
      return true;
    });
    await releaseStatus(['--json'], {
      observe: async () => observed('a'.repeat(40)),
    });
    expect(output).toHaveLength(1);
    expect(() => JSON.parse(output[0]!)).not.toThrow();
    expect(errors).toEqual([]);
  });

  it('keeps JSON stdout singular while real package helpers pack content and remotes are mocked', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const packRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-status-pack-'));
    roots.push(packRoot);
    const cliPackageRoot = path.join(packRoot, 'cli');
    const evalPackageRoot = path.join(packRoot, 'eval');
    for (const [packageRoot, name] of [
      [cliPackageRoot, '@lesliechan721/aw'],
      [evalPackageRoot, '@lesliechan721/agent-skill-eval'],
    ]) {
      await fs.mkdir(packageRoot);
      await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const fixture = true;\n');
      await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify({
        name, version: '0.1.0-beta.2', files: ['index.js'],
        ...(name === '@lesliechan721/aw' ? {
          dependencies: { '@lesliechan721/agent-skill-eval': '0.1.0-beta.2' },
        } : {}),
      }, null, 2)}\n`);
      await execute('npm', ['pack', '--ignore-scripts', '--pack-destination', packageRoot], {
        cwd: packageRoot,
      });
    }
    const runPackCommand = async (_command: string, args: string[], commandOptions: { cwd: string }) => {
      const destination = args[args.indexOf('--pack-destination') + 1]!;
      const tarball = (await fs.readdir(commandOptions.cwd)).find((entry) => entry.endsWith('.tgz'))!;
      await fs.copyFile(path.join(commandOptions.cwd, tarball), path.join(destination, tarball));
    };
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const snapshot = {
      cliPackageRoot,
      evalPackageRoot,
      cliDistRoot: path.join(repoRoot, 'packages', 'cli', 'dist'),
      catalogOutputRoot: path.join(repoRoot, 'packages', 'cli', 'plugins-dist'),
      inputDigest: digest('1'),
      outputDigest: digest('2'),
      cliPackageDigest: digest('3'),
    };
    await releaseStatus(['--json'], {
      observe: async () => observeRelease({
        readTargets: async () => ({ schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0' }),
        withReleaseBuildSnapshot: async (callback, buildOptions) => {
          expect(buildOptions).toMatchObject({ quiet: true });
          return callback(snapshot);
        },
        resolveHead: async () => 'a'.repeat(40),
        readContent: async (currentSnapshot, head) => ({
          ...observed(head).content,
          cli: await readCliReleaseContent(currentSnapshot, {
            packOptions: { runPackCommand },
          }),
        }),
        readRegistryHistory: async () => ({
            '@lesliechan721/agent-skill-eval': [],
            '@lesliechan721/aw': [],
            distTags: {
              '@lesliechan721/agent-skill-eval': { latest: null, beta: null },
              '@lesliechan721/aw': { latest: null, beta: null },
            },
        }),
        readCatalogHistory: async () => ({
          latest: null, beta: null, pending: null,
          ledger: { schemaVersion: 2, records: [] },
        }),
      }),
    });
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ schemaVersion: 1 });
  }, 60_000);

  it('does not write a plan when all release actions skip', async () => {
    const input = observed('a'.repeat(40));
    const metadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '1.0.0',
      candidateVersion: '1.0.0-beta.1',
      planId: digest('7'),
      sourceHead: 'a'.repeat(40),
      packageContentDigest,
      trainContentDigest: input.content.cli.trainContentDigest,
    });
    input.history.registry['@lesliechan721/agent-skill-eval'] = [{
      version: '1.0.0-beta.1', awRelease: metadata(digest('3')),
    }];
    input.history.registry['@lesliechan721/aw'] = [{
      version: '1.0.0-beta.1', awRelease: metadata(digest('4')),
    }];
    input.history.catalog.beta = {
      commit: 'b'.repeat(40),
      manifest: { catalogVersion: '1.0.0-beta.1' },
      catalogContentDigest: digest('5'),
      ledger: { schemaVersion: 2, records: [] },
    };
    input.history.catalog.ledger.records.push({
      plugin: 'ask-me', version: '1.0.0-beta.1', contentDigest: digest('6'),
      artifactDigest: digest('8'), manifestDigest: digest('9'),
      channel: 'beta', catalogVersion: '1.0.0-beta.1',
    });
    const writePlan = vi.fn();
    const result = await prepareRelease(['beta'], {
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      readTargets: async () => input.targets,
      withReleaseBuildSnapshot: async (callback: (snapshot: {
        cliDistRoot: string;
        generationId: string;
        outputDigest: string;
        inputDigest: string;
        cliPackageDigest: string;
      }) => unknown) => callback({
        cliDistRoot: '/fixture/cli-dist',
        generationId: 'fixture-generation',
        outputDigest: input.content.source.buildOutputDigest,
        inputDigest: input.content.source.releaseInputDigest,
        cliPackageDigest: input.content.source.cliPackageDigest,
      }),
      resolveHead: async () => input.content.source.head,
      readContent: async () => input.content,
      readRegistryHistory: async () => input.history.registry,
      readCatalogHistory: async () => input.history.catalog,
      writePlan,
    });
    expect(result.created).toBe(false);
    expect(writePlan).not.toHaveBeenCalled();
  });

  it('refuses a plan when the second remote observation changes', async () => {
    const input = observed('a'.repeat(40));
    const writePlan = vi.fn();
    const changedHistory = structuredClone(input.history);
    changedHistory.registry.distTags['@lesliechan721/aw'].beta = '1.0.0-beta.1';
    await expect(prepareRelease(['beta'], {
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => input.targets,
      observe: async () => input,
      observeRemoteHistory: async () => changedHistory,
      writePlan,
    })).rejects.toThrow('remote history changed');
    expect(writePlan).not.toHaveBeenCalled();
  });
});
