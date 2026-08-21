import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPlanOnlyCommit,
  createReleasePlan,
  writeReleasePlan,
} from '../../../../scripts/release/release-plan.mjs';
import { releaseStatus } from '../../../../scripts/release/release-status.mjs';
import { prepareRelease } from '../../../../scripts/release/release-prepare.mjs';
import { publishCommittedRelease } from '../../../../scripts/release/publish-plan.mjs';
import {
  observeRelease,
  readCurrentReleaseContent,
} from '../../../../scripts/release/release-observe.mjs';
import { calculateReleaseStatus } from '../../../../scripts/release/release-state.mjs';
import {
  calculateCatalogContentDigest,
  calculateCliTrainContentDigest,
} from '../../../../scripts/release/release-model.mjs';
import {
  assertReleaseWorktreeClean,
  computePackageTarballTreeDigest,
  createReleaseSnapshotIdentity,
} from '../../../../scripts/release/common.mjs';
import {
  promoteCatalogTag,
  publishStagedCatalog,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import {
  assertVersionTargetsMatchHead,
  updateReleaseTargets,
} from '../../../../scripts/release/release-target.mjs';
import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { calculateCatalogEntryContentDigest } from '../../src/utils/catalog-digests.js';

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
  await fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true });
  await fs.cp(path.resolve(import.meta.dirname, '..', 'fixtures', 'repo-template', 'plugins'), path.join(root, 'plugins'), {
    recursive: true,
  });
  await fs.writeFile(path.join(root, 'source.txt'), 'source\n');
  await fs.writeFile(path.join(root, 'package.json'), `${JSON.stringify({ private: true }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({
    name: '@lesliechan721/aw', version: '1.0.0',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
    name: '@lesliechan721/agent-skill-eval', version: '1.0.0',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
    schemaVersion: 1, cli: '1.0.0', catalog: '1.0.0',
  }, null, 2)}\n`);
  await git(root, ['add', 'package.json', 'packages', 'source.txt', 'release/version-targets.json', 'plugins']);
  await git(root, ['commit', '--quiet', '-m', 'source']);
  return { root, head: await git(root, ['rev-parse', 'HEAD']) };
}

function observed(
  head: string,
  targets = { schemaVersion: 1, cli: '1.0.0', catalog: '1.0.0' },
  catalog = {
    minCliVersion: '0.1.0-beta.3',
    contentDigest: digest('5'),
    plugins: [{ name: 'git-commit', targetVersion: '0.1.0', contentDigest: digest('6') }],
  },
) {
  const packages = [
    { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('3'), tarballDigest: digest('7') },
    { name: '@lesliechan721/aw', contentDigest: digest('4'), tarballDigest: digest('8') },
  ];
  return {
    targets,
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
      catalog,
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

  it('keeps the root pnpm machine-status command stdout as one JSON document', async () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..', '..');
    const hookRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-status-hook-'));
    roots.push(hookRoot);
    const observeModuleUrl = pathToFileURL(
      path.join(repoRoot, 'scripts', 'release', 'release-observe.mjs'),
    ).href;
    const fakeModuleSource = `export async function observeRelease() { return ${JSON.stringify(
      observed('a'.repeat(40)),
    )}; }`;
    const hookPath = path.join(hookRoot, 'observe-hook.mjs');
    await fs.writeFile(hookPath, [
      "import { registerHooks } from 'node:module';",
      `const target = ${JSON.stringify(observeModuleUrl)};`,
      `const replacement = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(fakeModuleSource)}`)};`,
      'registerHooks({',
      '  resolve(specifier, context, nextResolve) {',
      '    const resolved = nextResolve(specifier, context);',
      '    return resolved.url === target ? { url: replacement, shortCircuit: true } : resolved;',
      '  },',
      '});',
      '',
    ].join('\n'));
    const nodeOptions = [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(hookPath).href}`,
    ].filter(Boolean).join(' ');

    const result = await execute('pnpm', ['--silent', 'release:status', '--', '--json'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        NODE_OPTIONS: nodeOptions,
      },
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      channels: { beta: {}, stable: {} },
    });
  }, 60_000);

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
      inputDigest: '1'.repeat(64),
      outputDigest: '2'.repeat(64),
      cliPackageDigest: '3'.repeat(64),
    };
    const realObservation = await observeRelease({
      readTargets: async () => ({ schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0' }),
      withReleaseBuildSnapshot: async (callback) => callback(snapshot),
      resolveHead: async () => 'a'.repeat(40),
      readContent: (currentSnapshot, head) => readCurrentReleaseContent(currentSnapshot, head, {
        packOptions: { runPackCommand },
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
    });
    expect(realObservation.content.source).toMatchObject({
      releaseInputDigest: digest('1'),
      buildOutputDigest: digest('2'),
      cliPackageDigest: digest('3'),
    });
    const realStatus = calculateReleaseStatus({ ...realObservation, channel: 'beta' });
    expect(createReleasePlan(realStatus).source).toMatchObject(realObservation.content.source);
    await releaseStatus(['--json'], {
      observe: async () => realObservation,
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

  it('runs target, source commit, prepare, plan-only commit, publication retry, and drift gates as one local workflow', async () => {
    const repository = await createRepo();
    await updateReleaseTargets(['--cli', 'patch', '--catalog', 'patch'], {
      repoRoot: repository.root,
    });
    const skillPath = path.join(repository.root, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md');
    await fs.appendFile(skillPath, '\nRelease fixture production change.\n');
    for (const packagePath of [
      path.join(repository.root, 'packages', 'cli', 'package.json'),
      path.join(repository.root, 'packages', 'agent-skill-eval', 'package.json'),
    ]) {
      const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      await fs.writeFile(packagePath, `${JSON.stringify({ ...packageJson, version: '1.0.1' }, null, 2)}\n`);
    }
    await git(repository.root, [
      'add',
      'release/version-targets.json',
      'packages/cli/package.json',
      'packages/agent-skill-eval/package.json',
      'plugins/git-commit/skills/commit/SKILL.md',
    ]);
    await git(repository.root, ['commit', '--quiet', '-m', 'release target and source']);
    const sourceHead = await git(repository.root, ['rev-parse', 'HEAD']);
    expect(await git(repository.root, ['diff-tree', '--no-commit-id', '--name-only', '-r', sourceHead]))
      .toContain('plugins/git-commit/skills/commit/SKILL.md');

    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-local-publication-'));
    roots.push(artifactRoot);
    const catalogOutputRoot = path.join(artifactRoot, 'catalog-source');
    await bundlePlugins({ repoRoot: repository.root, outputRoot: catalogOutputRoot, buildMode: 'staging' });
    const [developmentManifest, marketplace, pluginContentDigest] = await Promise.all([
      fs.readFile(path.join(catalogOutputRoot, 'catalog-manifest.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(catalogOutputRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8').then(JSON.parse),
      calculateCatalogEntryContentDigest(path.join(catalogOutputRoot, 'plugins', 'git-commit')),
    ]);
    const catalogContentDigest = calculateCatalogContentDigest({
      schemaIdentity: { schemaVersion: 4 },
      marketplaceMetadata: {
        name: marketplace.name,
        owner: marketplace.owner,
        interface: marketplace.interface,
      },
      compatibility: { aw: { minVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR } },
      plugins: [{ name: 'git-commit', targetVersion: '0.1.0', contentDigest: pluginContentDigest }],
    });
    expect(developmentManifest.entries[0]).toMatchObject({
      name: 'git-commit',
      compatibility: { aw: { minVersion: '0.0.0' } },
    });
    expect(developmentManifest.compatibility.aw.minVersion)
      .toBe(pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR);

    const targets = { schemaVersion: 1, cli: '1.0.1', catalog: '1.0.1' };
    const observation = observed(sourceHead, targets, {
      minCliVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR,
      contentDigest: catalogContentDigest,
      plugins: [{ name: 'git-commit', targetVersion: '0.1.0', contentDigest: pluginContentDigest }],
    });
    const snapshot = {
      generationId: 'local-release-generation',
      outputDigest: observation.content.source.buildOutputDigest,
      inputDigest: observation.content.source.releaseInputDigest,
      cliPackageDigest: observation.content.source.cliPackageDigest,
      cliPackageRoot: path.join(artifactRoot, 'packages', 'cli'),
      evalPackageRoot: path.join(artifactRoot, 'packages', 'eval'),
      cliDistRoot: path.resolve(import.meta.dirname, '..', '..', 'dist'),
      catalogOutputRoot,
    };
    const releaseIdentity = createReleaseSnapshotIdentity(snapshot, sourceHead);
    let boundStage: Record<string, unknown> | undefined;

    const prepared = await prepareRelease(['beta'], {
      repoRoot: repository.root,
      assertFresh: async () => undefined,
      observe: async () => observation,
      observeRemoteHistory: async () => observation.history,
      materializeCliPlanArtifacts: async (status) => status.cli.packages,
      materializeCatalogPlanArtifact: async (status, planId) => {
        const staged = await pluginStaging.stageCatalogArtifacts({
          repoRoot: repository.root,
          outputRoot: catalogOutputRoot,
          phase: 'release',
          catalogVersion: status.catalog.candidateVersion,
          channel: 'beta',
          previousReleaseLedger: { schemaVersion: 2, records: [] },
          pluginVersionOverrides: { 'git-commit': status.plugins[0].candidateVersion },
          pluginCandidates: status.plugins.map((plugin) => ({
            name: plugin.name,
            targetVersion: plugin.targetVersion,
            candidateVersion: plugin.candidateVersion,
            contentDigest: plugin.contentDigest,
            action: plugin.action,
          })),
          release: {
            state: 'published',
            targetVersion: status.catalog.targetVersion,
            planId,
            sourceHead,
            contentDigest: catalogContentDigest,
          },
        });
        const validation = await catalogSnapshot.validateCatalogSnapshot(catalogOutputRoot);
        boundStage = {
          ...staged,
          ...validation,
          outputRoot: catalogOutputRoot,
          generationId: snapshot.generationId,
          outputDigest: snapshot.outputDigest,
          inputDigest: snapshot.inputDigest,
          cliPackageDigest: snapshot.cliPackageDigest,
          releaseIdentity,
        };
        return validation.snapshotDigest;
      },
    });
    expect(prepared.created).toBe(true);
    expect(prepared.plan?.source.head).toBe(sourceHead);
    await git(repository.root, ['add', 'release/current-plan.json', `release/plans/${prepared.plan!.planId.slice(7)}.json`]);
    await git(repository.root, ['commit', '--quiet', '-m', 'immutable release plan']);
    await expect(assertPlanOnlyCommit(prepared.plan!, { repoRoot: repository.root }))
      .resolves.toMatchObject({ parent: sourceHead });

    for (const [packageRoot, packageJson] of [
      [snapshot.evalPackageRoot, {
        name: '@lesliechan721/agent-skill-eval',
        version: prepared.plan!.cli.candidateVersion,
        packageManager: 'pnpm@10.33.0',
        files: ['index.js'],
      }],
      [snapshot.cliPackageRoot, {
        name: '@lesliechan721/aw',
        version: prepared.plan!.cli.candidateVersion,
        packageManager: 'pnpm@10.33.0',
        files: ['index.js'],
        dependencies: {
          '@lesliechan721/agent-skill-eval': prepared.plan!.cli.candidateVersion,
        },
      }],
    ] as const) {
      await fs.mkdir(packageRoot, { recursive: true });
      await fs.writeFile(path.join(packageRoot, 'index.js'), 'export const localReleaseFixture = true;\n');
      await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
    }

    const remoteUrl = path.join(artifactRoot, 'catalog.git');
    await git(artifactRoot, ['init', '--bare', '--quiet', remoteUrl]);
    const catalogModules = { pluginStaging, catalogSnapshot };
    const registry = {
      '@lesliechan721/agent-skill-eval': [] as Array<Record<string, unknown>>,
      '@lesliechan721/aw': [] as Array<Record<string, unknown>>,
      distTags: {
        '@lesliechan721/agent-skill-eval': { latest: null as string | null, beta: null as string | null },
        '@lesliechan721/aw': { latest: null as string | null, beta: null as string | null },
      },
    };
    const adapterRequests: string[] = [];
    const npmWrites: string[] = [];
    const publicationEvents: string[] = [];
    const readRegistryReleaseHistory = async () => structuredClone(registry);
    const isExactPackageVersionPublished = async (name: keyof typeof registry, version: string) =>
      Array.isArray(registry[name]) && registry[name].some((entry) => entry.version === version);
    const assertPublishedPackageTarballMatchesCandidate = async (
      _name: string, _version: string, _packageJsonPath: string, tarballPath: string,
    ) => {
      const candidateTreeDigest = await computePackageTarballTreeDigest(tarballPath);
      return {
        registryUrl: 'http://registry.test.invalid',
        candidateTreeDigest,
        publishedTreeDigest: candidateTreeDigest,
      };
    };
    const recordRegistryWrite = (name: '@lesliechan721/agent-skill-eval' | '@lesliechan721/aw') => {
      npmWrites.push(name === '@lesliechan721/agent-skill-eval' ? 'eval-package' : 'aw-package');
      publicationEvents.push(`npm:${name}`);
      const expected = prepared.plan!.cli.packages.find((entry) => entry.name === name)!;
      registry[name] = [{
        version: prepared.plan!.cli.candidateVersion,
        awRelease: {
          schemaVersion: 1,
          targetVersion: prepared.plan!.cli.targetVersion,
          candidateVersion: prepared.plan!.cli.candidateVersion,
          planId: prepared.plan!.planId,
          sourceHead,
          packageContentDigest: expected.contentDigest,
          trainContentDigest: prepared.plan!.cli.trainContentDigest,
        },
      }];
      registry.distTags[name].beta = prepared.plan!.cli.candidateVersion;
    };
    const publish = () => publishCommittedRelease([], {
      repoRoot: repository.root,
      catalogRemoteUrl: remoteUrl,
      catalogModules,
      readRegistryReleaseHistory,
      resolvePublishedCliVersion: async () =>
        registry.distTags['@lesliechan721/aw'].beta ?? '0.1.0-beta.2',
      isExactPackageVersionPublished,
      assertPublishedPackageTarballMatchesCandidate,
      cliPublicationOptions: {
        isExactPackageVersionPublished,
        assertPublishedPackageTarballMatchesCandidate,
      },
      resolveCliPublishGitCheckArgs: async () => [],
      runCommand: async (_command, args) => {
        if (args.join(' ') === 'run release:verify') {
          publicationEvents.push('verify');
          return;
        }
        expect(args[0]).toBe('publish');
        recordRegistryWrite('@lesliechan721/aw');
      },
      evalPublicationOptions: {
        isExactPackageVersionPublished,
        assertPublishedPackageTarballMatchesCandidate,
        runCommand: async (_command: string, args: string[]) => {
          expect(args[0]).toBe('publish');
          recordRegistryWrite('@lesliechan721/agent-skill-eval');
        },
      },
      publishStagedCatalog: async (...args) => {
        adapterRequests.push('catalog-tag');
        publicationEvents.push('catalog-tag');
        return publishStagedCatalog(...args);
      },
      promoteCatalogTag: async (options) => {
        adapterRequests.push('catalog-promotion');
        publicationEvents.push('catalog-promotion');
        return promoteCatalogTag(options);
      },
      _boundCatalog: {
        internalOutputRoot: catalogOutputRoot,
        snapshot,
        staged: boundStage,
      },
    });

    await expect(publish()).resolves.toMatchObject({
      path: 'tag-first',
      planId: prepared.plan!.planId,
      catalog: { idempotent: false, promoted: false },
      promotion: { idempotent: false, promoted: true },
    });
    expect([adapterRequests[0], ...npmWrites, adapterRequests[1]])
      .toEqual(['catalog-tag', 'eval-package', 'aw-package', 'catalog-promotion']);
    expect(publicationEvents[0]).toBe('verify');
    const refsAfterFirstPublish = await git(artifactRoot, [
      '--git-dir', remoteUrl, 'show-ref',
    ]);
    const writeCount = npmWrites.length;
    adapterRequests.length = 0;
    await expect(publish()).resolves.toMatchObject({
      path: 'tag-first',
      catalog: { idempotent: true, promoted: true },
      cli: { status: 'already-published' },
      promotion: { idempotent: true, promoted: true },
    });
    expect(npmWrites).toHaveLength(writeCount);
    expect(adapterRequests).toEqual(['catalog-tag', 'catalog-promotion']);
    expect(await git(artifactRoot, ['--git-dir', remoteUrl, 'show-ref']))
      .toBe(refsAfterFirstPublish);

    await fs.writeFile(path.join(repository.root, 'source.txt'), 'drifted\n');
    await expect(publish()).rejects.toThrow('dirty working tree');
    await fs.writeFile(path.join(repository.root, 'source.txt'), 'source\n');

    await git(artifactRoot, ['--git-dir', remoteUrl, 'update-ref', '-d', 'refs/heads/catalog/beta']);
    await expect(publish()).rejects.toThrow('ahead of its channel without the tag-first pending guard');
  }, 60_000);

  it.each(['source', 'targets', 'remote'] as const)(
    'does not write a plan when %s drifts during final materialization',
    async (kind) => {
      const input = observed('a'.repeat(40));
      const writePlan = vi.fn();
      let freshChecks = 0;
      let targetReads = 0;
      let historyReads = 0;
      await expect(prepareRelease(['beta'], {
        assertClean: async () => undefined,
        assertFresh: async () => {
          freshChecks += 1;
          if (kind === 'source' && freshChecks === 2) throw new Error('source changed during materialization');
        },
        assertTargetsMatchHead: async () => undefined,
        readTargets: async () => {
          targetReads += 1;
          return kind === 'targets' && targetReads === 2
            ? { ...input.targets, cli: '1.0.1' }
            : input.targets;
        },
        observe: async () => input,
        observeRemoteHistory: async () => {
          historyReads += 1;
          return kind === 'remote' && historyReads === 2
            ? { ...input.history, catalog: { ...input.history.catalog, pending: 'b'.repeat(40) } }
            : input.history;
        },
        materializeCliPlanArtifacts: async (status) => status.cli.packages,
        materializeCatalogPlanArtifact: async () => null,
        writePlan,
      })).rejects.toThrow(/changed|targets/u);
      expect(writePlan).not.toHaveBeenCalled();
    },
  );
});
