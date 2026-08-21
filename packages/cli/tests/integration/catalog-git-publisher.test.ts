import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CATALOG_CHANNEL_REFS,
  CATALOG_PUBLICATION_LOCK_REF,
  CATALOG_TAG_FIRST_PENDING_REF,
  promoteCatalogTag,
  publishStagedCatalog,
  readCatalogPublicationHistory,
  runCatalogGit,
  withCatalogPublicationLease,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { bootstrapCatalog } from '../../../../scripts/release/bootstrap-catalog.mjs';
import { stageCatalogRelease } from '../../../../scripts/release/stage-catalog.mjs';
import { calculateCatalogContentDigest } from '../../../../scripts/release/release-model.mjs';
import { observeReleaseHistory } from '../../../../scripts/release/release-observe.mjs';
import { prepareRelease } from '../../../../scripts/release/release-prepare.mjs';
import { publishCommittedRelease } from '../../../../scripts/release/publish-plan.mjs';
import { recoverRelease } from '../../../../scripts/release/release-recover.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';
import * as pluginStaging from '../../scripts/plugin-staging.js';
import * as catalogSnapshot from '../../src/utils/catalog-snapshot.js';
import { catalogGitProviderInternal } from '../../src/utils/git-catalog-provider.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { calculateCatalogEntryContentDigest } from '../../src/utils/catalog-digests.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const catalogModules = { pluginStaging, catalogSnapshot };

function releaseSnapshot(root: string, catalogVersion: string) {
  return {
    root,
    generationId: `generation-${catalogVersion}`,
    outputDigest: `output-${catalogVersion}`,
    inputDigest: `input-${catalogVersion}`,
    cliPackageDigest: `package-${catalogVersion}`,
    cliPackageRoot: path.join(root, 'packages', 'cli'),
    cliDistRoot: path.join(root, 'packages', 'cli', 'dist'),
    catalogOutputRoot: path.join(root, `source-${catalogVersion}`),
  };
}

function bootstrapReleaseOptions(root: string, catalogVersion: string) {
  const snapshot = releaseSnapshot(root, catalogVersion);
  return {
    withReleaseBuildSnapshot: async (
      callback: (releaseSnapshotValue: typeof snapshot) => Promise<unknown>,
    ) => callback(snapshot),
    resolveReleaseHead: async () => 'c'.repeat(40),
    assertCurrentReleaseIdentity: async () => undefined,
  };
}

async function git(args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  return String(result.stdout).trim();
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

async function createBareRemote(root: string): Promise<string> {
  const remote = path.join(root, 'catalog.git');
  await git(['init', '--bare', '--quiet', remote]);
  return remote;
}

async function stage(
  root: string,
  catalogVersion: string,
  previousReleaseLedger: pluginStaging.PluginReleaseLedger,
  pluginVersion = '1.0.0',
  readme = 'demo\n',
  releaseOptions: {
    internalOutputRoot?: string;
    snapshot?: ReturnType<typeof releaseSnapshot>;
    releaseIdentity?: object;
  } = {},
) {
  const snapshot = releaseOptions.snapshot ?? releaseSnapshot(root, catalogVersion);
  const sourceRoot = snapshot.catalogOutputRoot;
  await createCatalogSnapshotFixture(
    sourceRoot,
    'demo',
    '0.0.0',
    readme,
    (manifest) => { manifest.version = pluginVersion; },
  );
  const sourceManifest = await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json'));
  const marketplace = await fs.readJson(path.join(sourceRoot, '.agents', 'plugins', 'marketplace.json'));
  const catalogContentDigest = calculateCatalogContentDigest({
    schemaIdentity: { schemaVersion: 4 },
    marketplaceMetadata: {
      name: marketplace.name,
      owner: marketplace.owner,
      interface: marketplace.interface,
    },
    compatibility: {
      aw: { minVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR },
    },
    plugins: sourceManifest.entries.map((entry: { name: string; version: string; contentDigest: string }) => ({
      name: entry.name,
      targetVersion: entry.version,
      contentDigest: entry.contentDigest,
    })),
  });
  const outputRoot = releaseOptions.internalOutputRoot
    ?? path.join(root, `publication-${catalogVersion}`, '.release', 'catalog-staging', 'catalog');
  await fs.ensureDir(path.dirname(path.dirname(path.dirname(outputRoot))));
  return stageCatalogRelease(
    ['--catalog-version', catalogVersion],
    {
      snapshot,
      internalOutputRoot: outputRoot,
      previousReleaseLedger,
      catalogRelease: {
        state: 'published',
        targetVersion: catalogVersion.replace(/-beta\.[1-9]\d*$/u, ''),
        planId: `sha256:${'1'.repeat(64)}`,
        sourceHead: '2'.repeat(40),
        contentDigest: catalogContentDigest,
      },
      catalogModules,
      ...(releaseOptions.releaseIdentity
        ? { releaseIdentity: releaseOptions.releaseIdentity }
        : {}),
    },
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.remove(directory)));
});

describe('Git catalog publisher', () => {
  it('bootstraps an absent beta channel from one committed plan and retries it exactly', async () => {
    const root = await fixtureRoot('aw-plan-bootstrap-');
    const remoteUrl = await createBareRemote(root);
    const snapshot = releaseSnapshot(root, '1.0.0-beta.1');
    await createCatalogSnapshotFixture(snapshot.catalogOutputRoot);
    const sourceManifest = await fs.readJson(path.join(snapshot.catalogOutputRoot, 'catalog-manifest.json'));
    const marketplace = await fs.readJson(path.join(snapshot.catalogOutputRoot, '.agents', 'plugins', 'marketplace.json'));
    const catalogContentDigest = calculateCatalogContentDigest({
      schemaIdentity: { schemaVersion: 4 },
      marketplaceMetadata: { name: marketplace.name, owner: marketplace.owner, interface: marketplace.interface },
      compatibility: { aw: { minVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR } },
      plugins: sourceManifest.entries.map((entry: { name: string; version: string; contentDigest: string }) => ({
        name: entry.name, targetVersion: entry.version, contentDigest: entry.contentDigest,
      })),
    });
    const planId = `sha256:${'7'.repeat(64)}`;
    const previewRoot = path.join(root, 'preview', '.release', 'catalog-staging', 'catalog');
    await fs.ensureDir(path.dirname(path.dirname(path.dirname(previewRoot))));
    const preview = await stageCatalogRelease(['--catalog-version', '1.0.0-beta.1'], {
      snapshot,
      internalOutputRoot: previewRoot,
      previousReleaseLedger: { schemaVersion: 2, records: [] },
      pluginVersionOverrides: { demo: '1.0.0-beta.1' },
      catalogRelease: {
        state: 'published', targetVersion: '1.0.0', planId,
        sourceHead: 'b'.repeat(40), contentDigest: catalogContentDigest,
      },
      catalogModules,
    });
    const plan = {
      planId,
      channel: 'beta',
      source: { head: 'b'.repeat(40) },
      history: { catalog: { latest: null, beta: null, publicationGuard: null } },
      cli: { action: 'skip', candidateVersion: '1.0.0-beta.3', packages: [] },
      catalog: {
        action: 'publish', publicationMode: 'bootstrap', targetVersion: '1.0.0',
        candidateVersion: '1.0.0-beta.1', catalogContentDigest,
        snapshotDigest: preview.snapshotDigest, minCliVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR,
      },
      plugins: [{
        name: 'demo', targetVersion: '1.0.0', candidateVersion: '1.0.0-beta.1',
        contentDigest: sourceManifest.entries[0].contentDigest, action: 'publish',
      }],
    };
    const options = {
      remoteUrl,
      catalogModules,
      readCurrentReleasePlan: async () => ({ plan }),
      assertPlanOnlyCommit: async () => undefined,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      withReleaseBuildSnapshot: async (callback: (value: typeof snapshot) => Promise<unknown>) => callback(snapshot),
    };
    await expect(publishCommittedRelease([], options)).resolves.toMatchObject({
      path: 'bootstrap', catalog: { idempotent: false },
    });
    await expect(publishCommittedRelease([], options)).resolves.toMatchObject({
      path: 'bootstrap', catalog: { idempotent: true },
    });
  });

  it('publishes sha1 objects when the environment and global Git config default to sha256', async () => {
    const root = await fixtureRoot('aw-catalog-sha1-format-');
    const remoteUrl = path.join(root, 'catalog.git');
    await git(['init', '--bare', '--quiet', '--object-format=sha1', remoteUrl]);
    const globalConfigPath = path.join(root, 'global.gitconfig');
    await fs.outputFile(globalConfigPath, '[init]\n\tdefaultObjectFormat = sha256\n');
    const publisherEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfigPath,
      GIT_DEFAULT_HASH: 'sha256',
    };
    const history = await readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.0.0',
      remoteUrl,
      catalogModules,
      env: publisherEnv,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);

    const published = await publishStagedCatalog(history, staged.outputRoot, {
      env: publisherEnv,
    });

    expect(await git(['--git-dir', remoteUrl, 'rev-parse', '--show-object-format']))
      .toBe('sha1');
    expect(await git(['--git-dir', remoteUrl, 'cat-file', '-t', published.commit]))
      .toBe('commit');
  });

  it('bootstraps independent orphan beta and latest channels through the dedicated entry point', async () => {
    const root = await fixtureRoot('aw-catalog-bootstrap-');
    const remoteUrl = await createBareRemote(root);
    const runBootstrap = async (mode: 'beta' | 'latest', catalogVersion: string) =>
      bootstrapCatalog([mode, '--catalog-version', catalogVersion], {
        ...bootstrapReleaseOptions(root, catalogVersion),
        testRemoteUrl: remoteUrl,
        catalogModules,
        assertReleaseWorktreeClean: async () => undefined,
        runCommand: async () => undefined,
        stageCatalogRelease: async (_argv: string[], options: {
          internalOutputRoot: string;
          previousReleaseLedger: pluginStaging.PluginReleaseLedger;
          snapshot: ReturnType<typeof releaseSnapshot>;
          releaseIdentity: object;
        }) => stage(root, catalogVersion, options.previousReleaseLedger, '1.0.0', 'demo\n', options),
      });

    const beta = await runBootstrap('beta', '1.0.0-beta.1');
    const retry = await runBootstrap('beta', '1.0.0-beta.1');
    const latest = await runBootstrap('latest', '1.0.0');
    const retryAfterLatest = await runBootstrap('beta', '1.0.0-beta.1');

    const source = {
      id: 'official',
      type: 'git' as const,
      primary: true,
      url: remoteUrl,
      refPolicy: { type: 'cliChannel' as const },
    };
    const stableResolution = await catalogGitProviderInternal.resolve(source, {
      cliVersion: '1.0.0',
      freshnessPolicy: 'forceRemote',
      env: { ...process.env, AW_HOME: path.join(root, 'aw-home-stable') },
    });
    const prereleaseResolution = await catalogGitProviderInternal.resolve(source, {
      cliVersion: '1.0.1-beta.1',
      freshnessPolicy: 'forceRemote',
      env: { ...process.env, AW_HOME: path.join(root, 'aw-home-prerelease') },
    });

    const nextBetaHistory = await readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '1.0.0-beta.2', remoteUrl, catalogModules,
    });
    const nextBetaStage = await stage(
      root,
      '1.0.0-beta.2',
      nextBetaHistory.mergedLedger,
      '1.0.1',
      'next beta\n',
    );
    const nextBeta = await publishStagedCatalog(nextBetaHistory, nextBetaStage.outputRoot);

    expect(retry).toMatchObject({ commit: beta.commit, idempotent: true, promoted: true });
    expect(retryAfterLatest).toMatchObject({ commit: beta.commit, idempotent: true, promoted: true });
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', beta.commit])).split(' '))
      .toHaveLength(1);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', latest.commit])).split(' '))
      .toHaveLength(1);
    expect(stableResolution).toMatchObject({
      requestedRef: CATALOG_CHANNEL_REFS.latest,
      resolvedCommit: latest.commit,
    });
    expect(prereleaseResolution).toMatchObject({
      requestedRef: CATALOG_CHANNEL_REFS.beta,
      resolvedCommit: beta.commit,
    });
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', nextBeta.commit])).split(' '))
      .toEqual([nextBeta.commit, beta.commit]);
    expect(nextBeta.ledger.records).toHaveLength(3);
    expect(await git(['--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v1.0.0-beta.1']))
      .toBe('tag');
    expect(await git(['--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v1.0.0']))
      .toBe('tag');
  });

  it('serializes concurrent beta and latest bootstrap publications with one complete merged history', async () => {
    const root = await fixtureRoot('aw-catalog-bootstrap-concurrent-');
    const remoteUrl = await createBareRemote(root);
    const runBootstrap = (mode: 'beta' | 'latest', catalogVersion: string) =>
      bootstrapCatalog([mode, '--catalog-version', catalogVersion], {
        ...bootstrapReleaseOptions(root, catalogVersion),
        testRemoteUrl: remoteUrl,
        catalogModules,
        assertReleaseWorktreeClean: async () => undefined,
        runCommand: async () => undefined,
        publisherOptions: {
          publicationLockTimeoutMs: 10_000,
          publicationLockPollIntervalMs: 10,
        },
        stageCatalogRelease: async (_argv: string[], options: {
          internalOutputRoot: string;
          previousReleaseLedger: pluginStaging.PluginReleaseLedger;
          snapshot: ReturnType<typeof releaseSnapshot>;
          releaseIdentity: object;
        }) => stage(root, catalogVersion, options.previousReleaseLedger, '1.0.0', 'demo\n', options),
      });

    await Promise.all([
      runBootstrap('beta', '1.0.0-beta.1'),
      runBootstrap('latest', '1.0.0'),
    ]);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl, catalogModules,
    });
    expect(history.mergedLedger.records).toHaveLength(2);
    expect([
      history.channels.beta!.ledger.records.length,
      history.channels.latest!.ledger.records.length,
    ].sort()).toEqual([1, 2]);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .rejects.toThrow();
  });

  it('does not create a bootstrap tag or channel when atomic push is unsupported', async () => {
    const root = await fixtureRoot('aw-catalog-bootstrap-no-atomic-');
    const remoteUrl = await createBareRemote(root);
    await git(['--git-dir', remoteUrl, 'config', 'receive.advertiseAtomic', 'false']);
    await expect(bootstrapCatalog(['latest', '--catalog-version', '1.0.0'], {
      ...bootstrapReleaseOptions(root, '1.0.0'),
      testRemoteUrl: remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      stageCatalogRelease: async (_argv: string[], options: {
        internalOutputRoot: string;
        previousReleaseLedger: pluginStaging.PluginReleaseLedger;
        snapshot: ReturnType<typeof releaseSnapshot>;
        releaseIdentity: object;
      }) => stage(root, '1.0.0', options.previousReleaseLedger, '1.0.0', 'demo\n', options),
    })).rejects.toThrow('did not fall back to sequential pushes');
    await expect(git(['--git-dir', remoteUrl, 'show-ref'])).rejects.toThrow();
  });

  it('rejects bootstrap while a tag-first publication is pending', async () => {
    const root = await fixtureRoot('aw-catalog-bootstrap-partial-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await publishStagedCatalog(history, staged.outputRoot, { publicationMode: 'tag' });

    await expect(bootstrapCatalog(['latest', '--catalog-version', '1.0.0'], {
      ...bootstrapReleaseOptions(root, '1.0.0'),
      testRemoteUrl: remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      stageCatalogRelease: async () => staged,
    })).rejects.toThrow('cannot confirm a tag-first pending publication');
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .rejects.toThrow();
  });

  it('creates orphan channel roots, one-parent fast-forward commits, independent channels, and annotated tags', async () => {
    const root = await fixtureRoot('aw-catalog-publisher-');
    const remoteUrl = await createBareRemote(root);

    const firstHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const firstStage = await stage(root, '1.0.0', firstHistory.mergedLedger);
    const first = await publishStagedCatalog(firstHistory, firstStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', first.commit])).split(' '))
      .toHaveLength(1);
    expect(await git(['--git-dir', remoteUrl, 'cat-file', '-t', 'refs/tags/catalog-v1.0.0']))
      .toBe('tag');

    const secondHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    });
    const secondStage = await stage(root, '1.1.0', secondHistory.mergedLedger, '1.1.0', 'demo two\n');
    const second = await publishStagedCatalog(secondHistory, secondStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', second.commit])).split(' '))
      .toEqual([second.commit, first.commit]);

    const betaHistory = await readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '2.0.0-beta.1', remoteUrl, catalogModules,
    });
    expect(betaHistory.mergedLedger.records).toHaveLength(2);
    const betaStage = await stage(root, '2.0.0-beta.1', betaHistory.mergedLedger, '2.0.0', 'demo beta\n');
    const beta = await publishStagedCatalog(betaHistory, betaStage.outputRoot);
    expect((await git(['--git-dir', remoteUrl, 'rev-list', '--parents', '-n', '1', beta.commit])).split(' '))
      .toHaveLength(1);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(second.commit);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.beta]))
      .toBe(beta.commit);
  });

  it('reuses an identical immutable tag and promotes it with a fast-forward', async () => {
    const root = await fixtureRoot('aw-catalog-tag-retry-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    const tagged = await publishStagedCatalog(history, staged.outputRoot, { publicationMode: 'tag' });
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .rejects.toThrow();
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_TAG_FIRST_PENDING_REF]))
      .toBe(tagged.commit);
    await expect(readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '2.0.0-beta.1', remoteUrl, catalogModules,
    })).rejects.toThrow('Only recovery of that exact catalog version may continue');

    const retryHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const retryStage = await stage(root, '1.0.0', retryHistory.mergedLedger);
    const retry = await publishStagedCatalog(retryHistory, retryStage.outputRoot, { publicationMode: 'tag' });
    expect(retry.idempotent).toBe(true);
    expect(retry.commit).toBe(tagged.commit);
    const driftingCliTrain = vi.fn()
      .mockResolvedValueOnce('1.0.0')
      .mockResolvedValueOnce('1.0.1');
    await expect(recoverRelease(['catalog', '1.0.0'], {
      remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      resolvePublishedCliTrain: driftingCliTrain,
    })).rejects.toThrow('identity changed during catalog recovery');
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .rejects.toThrow();
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_TAG_FIRST_PENDING_REF]))
      .toBe(tagged.commit);
    const promotion = await recoverRelease(['catalog', '1.0.0'], {
      remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      resolvePublishedCliTrain: async () => '1.0.0',
    });
    expect(promotion.promoted).toBe(true);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(tagged.commit);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_TAG_FIRST_PENDING_REF]))
      .rejects.toThrow();
    await expect(recoverRelease(['catalog', '1.0.0'], {
      remoteUrl,
      catalogModules,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async () => undefined,
      resolvePublishedCliTrain: async () => '1.0.0',
    })).rejects.toThrow('requires the exact immutable tag and tag-first pending guard');
  });

  it('discovers and prepares recovery for a guarded beta tag from a stable target only', async () => {
    const root = await fixtureRoot('aw-catalog-pending-beta-plan-');
    const remoteUrl = await createBareRemote(root);
    const initial = await readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '1.0.0-beta.1', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0-beta.1', initial.mergedLedger);
    const tagged = await publishStagedCatalog(initial, staged.outputRoot, { publicationMode: 'tag' });
    const packageContents = [
      { name: '@lesliechan721/agent-skill-eval', contentDigest: `sha256:${'3'.repeat(64)}` },
      { name: '@lesliechan721/aw', contentDigest: `sha256:${'4'.repeat(64)}` },
    ];
    const trainContentDigest = calculateCliTrainContentDigest(packageContents);
    const metadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '1.0.0',
      candidateVersion: '1.0.0-beta.1',
      planId: `sha256:${'7'.repeat(64)}`,
      sourceHead: 'a'.repeat(40),
      packageContentDigest,
      trainContentDigest,
    });
    const registry = {
      '@lesliechan721/agent-skill-eval': [{
        version: '1.0.0-beta.1', awRelease: metadata(packageContents[0]!.contentDigest),
      }],
      '@lesliechan721/aw': [{
        version: '1.0.0-beta.1', awRelease: metadata(packageContents[1]!.contentDigest),
      }],
      distTags: {
        '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
        '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
      },
    };
    const targets = { schemaVersion: 1, cli: '1.0.0', catalog: '1.0.0' };
    const readHistory = () => observeReleaseHistory({
      targets,
      channel: 'beta',
      cliDistRoot: path.join(root, 'unused-dist'),
      readRegistryHistory: async () => registry,
      readCatalogHistory: (options) => readCatalogPublicationHistory({
        ...options, remoteUrl, catalogModules,
      }),
    });
    const history = await readHistory();
    expect(history.catalog).toMatchObject({
      pending: tagged.commit,
      tag: { commit: tagged.commit, manifest: { catalogVersion: '1.0.0-beta.1' } },
    });
    const guardedBetaHistory = await readCatalogPublicationHistory({
      mode: 'beta', catalogVersion: '1.0.0-beta.1', remoteUrl, catalogModules,
    });
    const taggedEntry = staged.manifest.entries[0]!;
    const content = {
      source: {
        head: 'a'.repeat(40),
        releaseInputDigest: `sha256:${'1'.repeat(64)}`,
        buildOutputDigest: `sha256:${'2'.repeat(64)}`,
        cliPackageDigest: `sha256:${'5'.repeat(64)}`,
      },
      cli: {
        trainContentDigest,
        packages: packageContents.map((entry, index) => ({
          ...entry, tarballDigest: `sha256:${String(index + 8).repeat(64)}`,
        })),
      },
      catalog: {
        minCliVersion: staged.manifest.compatibility.aw.minVersion,
        contentDigest: history.catalog.tag!.catalogContentDigest,
        plugins: [{
          name: taggedEntry.name,
          targetVersion: taggedEntry.version.replace(/-beta\.[1-9]\d*$/u, ''),
          contentDigest: taggedEntry.contentDigest,
        }],
      },
    };
    const prepared = await prepareRelease(['beta'], {
      repoRoot: root,
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => targets,
      observe: async () => ({ targets, content, history }),
      observeRemoteHistory: readHistory,
      materializeCliPlanArtifacts: async (status) => status.cli.packages,
      materializeCatalogPlanArtifact: async () => staged.snapshotDigest,
      writePlan: async () => ({
        created: true,
        planPath: path.join(root, 'plan.json'),
        pointerPath: path.join(root, 'current-plan.json'),
      }),
    });
    expect(prepared.status.catalog).toMatchObject({
      action: 'recover', candidateVersion: '1.0.0-beta.1', publicationMode: 'promotion',
    });

    await git(['--git-dir', remoteUrl, 'update-ref', '-d', CATALOG_TAG_FIRST_PENDING_REF]);
    await expect(publishStagedCatalog(
      { ...guardedBetaHistory, pending: null },
      staged.outputRoot,
      { publicationMode: 'tag' },
    )).rejects.toThrow('no tag-first pending guard');
    await expect(readHistory()).rejects.toThrow('ahead of its channel without the tag-first pending guard');
    await expect(prepareRelease(['beta'], {
      repoRoot: root,
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => targets,
      observe: async () => ({ targets, content, history }),
      observeRemoteHistory: readHistory,
    })).rejects.toThrow('ahead of its channel without the tag-first pending guard');
  });

  it('rejects same-version channel drift and existing tag runtime drift', async () => {
    const root = await fixtureRoot('aw-catalog-content-drift-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await publishStagedCatalog(history, staged.outputRoot);

    const retryHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const drifted = await stage(
      root,
      '1.0.0',
      { schemaVersion: 2, records: [] },
      '1.1.0',
      'different runtime\n',
    );
    await expect(publishStagedCatalog(retryHistory, drifted.outputRoot))
      .rejects.toThrow('already published with different runtime content');

    const tagOnlyRoot = await fixtureRoot('aw-catalog-tag-content-drift-');
    const tagOnlyRemote = await createBareRemote(tagOnlyRoot);
    const tagHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl: tagOnlyRemote, catalogModules,
    });
    const tagStage = await stage(tagOnlyRoot, '2.0.0', tagHistory.mergedLedger);
    await publishStagedCatalog(tagHistory, tagStage.outputRoot, { publicationMode: 'tag' });
    const taggedHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl: tagOnlyRemote, catalogModules,
    });
    const tagDrift = await stage(
      tagOnlyRoot,
      '2.0.0',
      { schemaVersion: 2, records: [] },
      '2.0.0',
      'different tagged runtime\n',
    );
    await expect(publishStagedCatalog(taggedHistory, tagDrift.outputRoot, { publicationMode: 'tag' }))
      .rejects.toThrow('maps to different runtime content');
  });

  it('scans every canonical Catalog tag for an unguarded publication ahead of its own channel', async () => {
    const root = await fixtureRoot('aw-catalog-all-tag-guard-');
    const remoteUrl = await createBareRemote(root);
    const oldHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const oldStage = await stage(root, '1.0.0', oldHistory.mergedLedger);
    const oldTag = await publishStagedCatalog(oldHistory, oldStage.outputRoot, { publicationMode: 'tag' });
    await git(['--git-dir', remoteUrl, 'update-ref', '-d', CATALOG_TAG_FIRST_PENDING_REF]);

    await expect(readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl, catalogModules,
    })).rejects.toThrow('catalog-v1.0.0 is ahead of its channel');

    await git([
      '--git-dir', remoteUrl, 'update-ref', CATALOG_CHANNEL_REFS.latest, oldTag.commit,
    ]);
    await expect(readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '2.0.0', remoteUrl, catalogModules,
    })).resolves.toMatchObject({ pending: null, tag: null });
  });

  it('rejects reuse of an existing tag when its normalized release ledger differs', async () => {
    const root = await fixtureRoot('aw-catalog-tag-ledger-drift-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await publishStagedCatalog(history, staged.outputRoot, { publicationMode: 'tag' });
    const retryHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const ledger = await fs.readJson(path.join(staged.outputRoot, 'plugin-release-ledger.json'));
    ledger.records.push({
      ...ledger.records[0],
      catalogVersion: '0.9.0',
    });
    await fs.writeJson(path.join(staged.outputRoot, 'plugin-release-ledger.json'), ledger, { spaces: 2 });

    await expect(publishStagedCatalog(retryHistory, staged.outputRoot, { publicationMode: 'tag' }))
      .rejects.toThrow('release ledger differs');
  });

  it('rejects global insteadOf rewriting before contacting a different remote', async () => {
    const root = await fixtureRoot('aw-catalog-instead-of-');
    const remoteUrl = await createBareRemote(root);
    const rewrittenRemote = await createBareRemote(await fixtureRoot('aw-catalog-rewrite-target-'));
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.writeFile(globalConfig, [
      '[url "' + rewrittenRemote.replaceAll('\\\\', '/') + '"]',
      '\tinsteadOf = ' + remoteUrl.replaceAll('\\\\', '/'),
      '',
    ].join('\n'));

    await expect(readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.0.0',
      remoteUrl,
      catalogModules,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: globalConfig,
      },
    })).rejects.toThrow('rewritten by Git configuration');
    await expect(git(['--git-dir', rewrittenRemote, 'show-ref'])).rejects.toThrow();
  });

  it('rejects pushInsteadOf rewriting before fetch or publication-lock writes', async () => {
    const root = await fixtureRoot('aw-catalog-push-instead-of-');
    const remoteUrl = await createBareRemote(root);
    const rewrittenRemote = await createBareRemote(await fixtureRoot('aw-catalog-push-target-'));
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.writeFile(globalConfig, [
      '[url "' + rewrittenRemote.replaceAll('\\\\', '/') + '"]',
      '\tpushInsteadOf = ' + remoteUrl.replaceAll('\\\\', '/'),
      '',
    ].join('\n'));

    await expect(readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.0.0',
      remoteUrl,
      catalogModules,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: globalConfig,
      },
    })).rejects.toThrow('push URL was rewritten by Git configuration');
    await expect(git(['--git-dir', remoteUrl, 'show-ref'])).rejects.toThrow();
    await expect(git(['--git-dir', rewrittenRemote, 'show-ref'])).rejects.toThrow();
  });

  it('keeps the validated private remote after global pushInsteadOf changes', async () => {
    const root = await fixtureRoot('aw-catalog-frozen-remote-');
    const remoteUrl = await createBareRemote(root);
    const rewrittenRemote = await createBareRemote(await fixtureRoot('aw-catalog-late-push-target-'));
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.writeFile(globalConfig, '');
    const injectedEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: os.devNull,
    };
    let mutated = false;
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      const result = await runCatalogGit(args, { ...options, env: injectedEnv });
      if (!mutated && args[0] === 'remote' && args[1] === 'get-url') {
        mutated = true;
        await fs.writeFile(globalConfig, [
          '[url "' + rewrittenRemote.replaceAll('\\\\', '/') + '"]',
          '\tpushInsteadOf = ' + remoteUrl.replaceAll('\\\\', '/'),
          '',
        ].join('\n'));
      }
      return result;
    };

    await expect(withCatalogPublicationLease(remoteUrl, async (lease) => {
      expect(await git([
        '--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF,
      ])).toBe(lease.ownerCommit);
      await expect(git(['--git-dir', rewrittenRemote, 'show-ref'])).rejects.toThrow();
    }, { runGit })).resolves.toBeUndefined();

    expect(mutated).toBe(true);
    await expect(git([
      '--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF,
    ])).rejects.toThrow();
    await expect(git(['--git-dir', rewrittenRemote, 'show-ref'])).rejects.toThrow();
  });

  it('ignores global and system hooks, clean filters, attributes, and line-ending conversion', async () => {
    const root = await fixtureRoot('aw-catalog-global-config-');
    const remoteUrl = await createBareRemote(root);
    const hooksRoot = path.join(root, 'hooks');
    const hookMarker = path.join(root, 'hook-ran');
    const attributesPath = path.join(root, 'global-attributes');
    const signingMarker = path.join(root, 'signing-ran');
    const signingProgram = path.join(root, 'signing-program');
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.ensureDir(hooksRoot);
    await fs.writeFile(path.join(hooksRoot, 'pre-commit'), `#!/bin/sh\ntouch ${hookMarker}\nexit 1\n`);
    await fs.chmod(path.join(hooksRoot, 'pre-commit'), 0o755);
    await fs.writeFile(attributesPath, '* filter=poison text eol=crlf\n');
    await fs.writeFile(signingProgram, `#!/bin/sh\ntouch "${signingMarker}"\nexit 1\n`);
    await fs.chmod(signingProgram, 0o755);
    await fs.writeFile(globalConfig, [
      '[core]',
      `\thooksPath = ${hooksRoot}`,
      '\tautocrlf = true',
      `\tattributesFile = ${attributesPath}`,
      '[filter "poison"]',
      '\tclean = sed s/demo/poisoned/g',
      '\trequired = true',
      '[commit]',
      '\tgpgSign = true',
      '[tag]',
      '\tgpgSign = true',
      '\tforceSignAnnotated = true',
      '[gpg]',
      `\tprogram = ${signingProgram}`,
      '',
    ].join('\n'));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
    };
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules, env,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await expect(publishStagedCatalog(history, staged.outputRoot, { env }))
      .resolves.toMatchObject({ promoted: true });
    await expect(fs.pathExists(hookMarker)).resolves.toBe(false);
    await expect(fs.pathExists(signingMarker)).resolves.toBe(false);
    const committedReadme = await git([
      '--git-dir', remoteUrl, 'show', `${CATALOG_CHANNEL_REFS.latest}:plugins/demo/README.md`,
    ]);
    expect(committedReadme).toBe('demo');
  });

  it('uses an owned empty init template and commits the exact staged blob bytes', async () => {
    const root = await fixtureRoot('aw-catalog-init-template-');
    const remoteUrl = await createBareRemote(root);
    const templateRoot = path.join(root, 'host-template');
    const filterMarker = path.join(root, 'template-filter-ran');
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.ensureDir(path.join(templateRoot, 'info'));
    await fs.writeFile(path.join(templateRoot, 'info', 'attributes'), '* filter=poison\n');
    await fs.writeFile(globalConfig, [
      '[init]',
      `\ttemplateDir = ${templateRoot}`,
      '[filter "poison"]',
      `\tclean = sh -c 'touch "${filterMarker}"; tr a-z A-Z'`,
      '\trequired = true',
      '',
    ].join('\n'));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
    };
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules, env,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger, '1.0.0', 'mixed Bytes\r\n');
    const stagedReadme = path.join(staged.outputRoot, 'plugins', 'demo', 'README.md');
    const expectedBlob = await git(['hash-object', '--no-filters', stagedReadme]);

    await expect(publishStagedCatalog(history, staged.outputRoot, { env }))
      .resolves.toMatchObject({ promoted: true });
    await expect(fs.pathExists(filterMarker)).resolves.toBe(false);
    expect(await git([
      '--git-dir', remoteUrl, 'rev-parse', `${CATALOG_CHANNEL_REFS.latest}:plugins/demo/README.md`,
    ])).toBe(expectedBlob);
  });

  it('force-stages complete snapshot files even when a nested .gitignore excludes runtime content', async () => {
    const root = await fixtureRoot('aw-catalog-nested-ignore-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    const agentsRoot = path.join(staged.outputRoot, '.agents');
    await fs.writeFile(path.join(agentsRoot, '.gitignore'), 'plugins/marketplace.json\n');

    const published = await publishStagedCatalog(history, staged.outputRoot);

    expect(await git([
      '--git-dir', remoteUrl, 'show', `${published.commit}:.agents/plugins/marketplace.json`,
    ])).toContain('"plugins"');
    expect(await git([
      '--git-dir', remoteUrl, 'show', `${published.commit}:.agents/.gitignore`,
    ])).toBe('plugins/marketplace.json');
  });

  it('rejects publication .gitattributes before an external clean filter can run', async () => {
    const root = await fixtureRoot('aw-catalog-publication-attributes-');
    const remoteUrl = await createBareRemote(root);
    const filterMarker = path.join(root, 'filter-ran');
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.writeFile(globalConfig, [
      '[filter "poison"]',
      `\tclean = sh -c 'touch "${filterMarker}"; cat'`,
      '\trequired = true',
      '',
    ].join('\n'));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: globalConfig,
    };
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules, env,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await fs.writeFile(
      path.join(staged.outputRoot, 'plugins', 'demo', '.gitattributes'),
      'README.md filter=poison\n',
    );

    await expect(publishStagedCatalog(history, staged.outputRoot, { env }))
      .rejects.toThrow('must not contain .gitattributes');
    await expect(fs.pathExists(filterMarker)).resolves.toBe(false);
    await expect(git(['--git-dir', remoteUrl, 'show-ref'])).rejects.toThrow();
  });

  it('rejects remote tree .gitattributes before checkout can run its smudge filter', async () => {
    const root = await fixtureRoot('aw-catalog-remote-attributes-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    const poisonedClone = path.join(root, 'poisoned-clone');
    await git(['clone', '--quiet', '--branch', 'catalog/latest', remoteUrl, poisonedClone]);
    await git(['-C', poisonedClone, 'config', 'user.name', 'Remote Attribute Fixture']);
    await git(['-C', poisonedClone, 'config', 'user.email', 'fixture@example.invalid']);
    await fs.writeFile(
      path.join(poisonedClone, 'plugins', 'demo', '.gitattributes'),
      'README.md filter=poison\n',
    );
    await git(['-C', poisonedClone, 'add', 'plugins/demo/.gitattributes']);
    await git(['-C', poisonedClone, 'commit', '--quiet', '-m', 'Add poisoned attributes']);
    await git(['-C', poisonedClone, 'push', '--quiet', 'origin', `HEAD:${CATALOG_CHANNEL_REFS.latest}`]);

    const filterMarker = path.join(root, 'remote-filter-ran');
    const filterProgram = path.join(root, 'smudge-filter');
    const globalConfig = path.join(root, 'remote-filter.gitconfig');
    await fs.writeFile(filterProgram, `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`);
    await fs.chmod(filterProgram, 0o755);
    await fs.writeFile(globalConfig, [
      '[filter "poison"]',
      `\tsmudge = ${filterProgram}`,
      '\trequired = true',
      '',
    ].join('\n'));

    await expect(readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '2.0.0',
      remoteUrl,
      catalogModules,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_SYSTEM: globalConfig,
      },
    })).rejects.toThrow('must not contain .gitattributes');
    await expect(fs.pathExists(filterMarker)).resolves.toBe(false);
  });

  it('fails closed with a clear error when Git cannot materialize a published symlink', async () => {
    const root = await fixtureRoot('aw-catalog-symlink-unsupported-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    await fs.symlink(
      'README.md',
      path.join(initialStage.outputRoot, 'plugins', 'demo', 'current-readme'),
    );
    const changedContentDigest = await calculateCatalogEntryContentDigest(
      path.join(initialStage.outputRoot, 'plugins', 'demo'),
    );
    await pluginStaging.stageCatalogArtifacts({
      repoRoot: root,
      outputRoot: initialStage.outputRoot,
      phase: 'release',
      catalogVersion: '1.0.0',
      previousReleaseLedger: initialHistory.mergedLedger,
      release: {
        ...initialStage.manifest.release,
        contentDigest: calculateCatalogContentDigest({
          schemaIdentity: { schemaVersion: 4 },
          marketplaceMetadata: {
            name: 'aw',
            owner: { name: 'Fixture Owner' },
            interface: { displayName: 'Fixture Marketplace' },
          },
          compatibility: { aw: { minVersion: pluginStaging.CATALOG_SCHEMA_4_CLI_FLOOR } },
          plugins: [{ name: 'demo', targetVersion: '1.0.0', contentDigest: changedContentDigest }],
        }),
      },
    });
    await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    let blockedCheckout = false;
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === 'checkout-index') {
        blockedCheckout = true;
        throw new Error('injected platform symlink failure');
      }
      return runCatalogGit(args, options);
    };

    await expect(readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.1.0',
      remoteUrl,
      catalogModules,
      runGit,
    })).rejects.toThrow(
      'requires filesystem symbolic-link support to materialize Git mode 120000 at ' +
      'plugins/demo/current-readme; refusing to fall back to a regular file',
    );
    expect(blockedCheckout).toBe(true);
  });

  it('retries a transient ordinary publication-lock delete and releases the real remote ref', async () => {
    const root = await fixtureRoot('aw-catalog-lock-release-retry-');
    const remoteUrl = await createBareRemote(root);
    let rejectedDelete = false;
    let lockReads = 0;
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      if (
        args[0] === 'ls-remote'
        && args.at(-1) === CATALOG_PUBLICATION_LOCK_REF
      ) {
        lockReads += 1;
        if (lockReads === 2) throw new Error('injected transient list failure');
      }
      if (
        !rejectedDelete
        && args[0] === 'push'
        && args.includes(`:${CATALOG_PUBLICATION_LOCK_REF}`)
      ) {
        rejectedDelete = true;
        throw new Error('injected transient delete failure');
      }
      return runCatalogGit(args, options);
    };

    await expect(withCatalogPublicationLease(remoteUrl, async () => undefined, {
      runGit,
      publicationLockReleaseTimeoutMs: 1_000,
      publicationLockReleasePollIntervalMs: 10,
    })).resolves.toBeUndefined();
    expect(rejectedDelete).toBe(true);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .rejects.toThrow();
  });

  it('runs the live identity gate before creating the remote publication lock', async () => {
    const root = await fixtureRoot('aw-catalog-lock-freshness-');
    const remoteUrl = await createBareRemote(root);
    const callback = vi.fn();
    const beforeAcquire = vi.fn(async () => {
      throw new Error(
        'release freshness failed near aw-release/publication-lock with non-fast-forward text',
      );
    });

    await expect(withCatalogPublicationLease(remoteUrl, callback, {
      beforeAcquire,
      publicationLockTimeoutMs: 40,
      publicationLockPollIntervalMs: 5,
    })).rejects.toThrow('release freshness failed');
    expect(beforeAcquire).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    await expect(git(['--git-dir', remoteUrl, 'show-ref']))
      .rejects.toThrow();
  });

  it('runs the live identity gate after local materialization and before catalog refs', async () => {
    const root = await fixtureRoot('aw-catalog-push-freshness-');
    const remoteUrl = await createBareRemote(root);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);

    await expect(withCatalogPublicationLease(remoteUrl, (publicationLease) =>
      publishStagedCatalog(history, staged.outputRoot, {
        publicationLease,
        beforeRemoteWrite: async () => {
          throw new Error('release input changed before catalog push');
        },
      }))).rejects.toThrow('release input changed before catalog push');
    await expect(git(['--git-dir', remoteUrl, 'show-ref']))
      .rejects.toThrow();
  });

  it('treats a push error as acquired when the remote publication lock is the owner', async () => {
    const root = await fixtureRoot('aw-catalog-lock-push-confirm-');
    const remoteUrl = await createBareRemote(root);
    let injected = false;
    let callbackRan = false;
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      const createsLock = args[0] === 'push' && args.some((arg) =>
        arg.endsWith(`:${CATALOG_PUBLICATION_LOCK_REF}`)
        && !arg.startsWith(':'));
      if (createsLock && !injected) {
        injected = true;
        await runCatalogGit(args, options);
        throw new Error('injected post-push transport failure');
      }
      return runCatalogGit(args, options);
    };

    await expect(withCatalogPublicationLease(remoteUrl, async () => {
      callbackRan = true;
    }, {
      runGit,
      publicationLockTimeoutMs: 500,
      publicationLockPollIntervalMs: 10,
    })).resolves.toBeUndefined();
    expect(callbackRan).toBe(true);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .rejects.toThrow();
  });

  it('retries a failed post-push owner confirmation and does not leave a self-lock', async () => {
    const root = await fixtureRoot('aw-catalog-lock-confirm-retry-');
    const remoteUrl = await createBareRemote(root);
    let lockReads = 0;
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === 'ls-remote' && args.at(-1) === CATALOG_PUBLICATION_LOCK_REF) {
        lockReads += 1;
        if (lockReads === 1) throw new Error('injected owner confirmation failure');
      }
      return runCatalogGit(args, options);
    };

    await expect(withCatalogPublicationLease(remoteUrl, async () => undefined, {
      runGit,
      publicationLockTimeoutMs: 500,
      publicationLockPollIntervalMs: 10,
    })).resolves.toBeUndefined();
    expect(lockReads).toBeGreaterThan(1);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .rejects.toThrow();
  });

  it('times out lock release with the last observed remote ref state', async () => {
    const root = await fixtureRoot('aw-catalog-lock-release-timeout-');
    const remoteUrl = await createBareRemote(root);
    let ownerCommit = '';
    const runGit = async (args: string[], options: { cwd?: string } = {}) => {
      if (args[0] === 'push' && args.includes(`:${CATALOG_PUBLICATION_LOCK_REF}`)) {
        throw new Error('injected persistent delete failure');
      }
      return runCatalogGit(args, options);
    };

    const releaseError = await withCatalogPublicationLease(remoteUrl, async (lease) => {
      ownerCommit = lease.ownerCommit;
    }, {
      runGit,
      publicationLockReleaseTimeoutMs: 20,
      publicationLockReleasePollIntervalMs: 5,
    }).catch((error) => error);

    expect(releaseError).toBeInstanceOf(Error);
    expect(releaseError.message).toContain('Timed out after 20ms releasing catalog publication lease');
    expect(releaseError.message).toContain(`last observed ref state: ${ownerCommit}`);
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .toBe(ownerCommit);
  });

  it('fails closed without deleting a publication lock whose owner changed', async () => {
    const root = await fixtureRoot('aw-catalog-lock-release-owner-change-');
    const remoteUrl = await createBareRemote(root);
    await git(['--git-dir', remoteUrl, 'config', 'user.name', 'Alternate Owner']);
    await git(['--git-dir', remoteUrl, 'config', 'user.email', 'alternate@example.invalid']);
    let alternateOwner = '';

    await expect(withCatalogPublicationLease(remoteUrl, async (lease) => {
      const ownerTree = await git([
        '--git-dir', remoteUrl, 'rev-parse', `${lease.ownerCommit}^{tree}`,
      ]);
      alternateOwner = await git([
        '--git-dir', remoteUrl, 'commit-tree', ownerTree,
        '-p', lease.ownerCommit,
        '-m', 'Alternate publication lock owner',
      ]);
      await git(['--git-dir', remoteUrl, 'update-ref', CATALOG_PUBLICATION_LOCK_REF, alternateOwner]);
    }, {
      publicationLockReleaseTimeoutMs: 1_000,
      publicationLockReleasePollIntervalMs: 10,
    })).rejects.toThrow('publication lease owner changed before release');
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_PUBLICATION_LOCK_REF]))
      .toBe(alternateOwner);
  });

  it('does not publish either ref when the remote does not support atomic push', async () => {
    const root = await fixtureRoot('aw-catalog-no-atomic-');
    const remoteUrl = await createBareRemote(root);
    await git(['--git-dir', remoteUrl, 'config', 'receive.advertiseAtomic', 'false']);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await expect(publishStagedCatalog(history, staged.outputRoot))
      .rejects.toThrow('did not fall back to sequential pushes');
    await expect(git(['--git-dir', remoteUrl, 'show-ref']))
      .rejects.toThrow();
  });

  it('does not create a tag-first tag or pending guard when atomic push is unsupported', async () => {
    const root = await fixtureRoot('aw-catalog-tag-first-no-atomic-');
    const remoteUrl = await createBareRemote(root);
    await git(['--git-dir', remoteUrl, 'config', 'receive.advertiseAtomic', 'false']);
    const history = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const staged = await stage(root, '1.0.0', history.mergedLedger);
    await expect(publishStagedCatalog(history, staged.outputRoot, { publicationMode: 'tag' }))
      .rejects.toThrow('Atomic tag-first catalog publication failed');
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', 'refs/tags/catalog-v1.0.0']))
      .rejects.toThrow();
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_TAG_FIRST_PENDING_REF]))
      .rejects.toThrow();
  });

  it('rejects channel rollback and a lightweight catalog tag', async () => {
    const root = await fixtureRoot('aw-catalog-monotonic-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    const initial = await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    const rollbackHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '0.9.0', remoteUrl, catalogModules,
    });
    const rollbackStage = await stage(root, '0.9.0', rollbackHistory.mergedLedger);
    await expect(publishStagedCatalog(rollbackHistory, rollbackStage.outputRoot))
      .rejects.toThrow('must not be lower than published 1.0.0');

    await git(['--git-dir', remoteUrl, 'tag', 'catalog-v1.1.0', initial.commit]);
    await expect(readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    })).rejects.toThrow('is not an annotated tag');
  });

  it('fails closed when the channel advances after history is read', async () => {
    const root = await fixtureRoot('aw-catalog-concurrency-');
    const remoteUrl = await createBareRemote(root);
    const initialHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules,
    });
    const initialStage = await stage(root, '1.0.0', initialHistory.mergedLedger);
    await publishStagedCatalog(initialHistory, initialStage.outputRoot);

    const staleHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.1.0', remoteUrl, catalogModules,
    });
    const staleStage = await stage(root, '1.1.0', staleHistory.mergedLedger, '1.1.0');
    const competing = path.join(root, 'competing');
    await git(['clone', '--quiet', '--branch', 'catalog/latest', remoteUrl, competing]);
    await git(['-C', competing, 'config', 'user.name', 'Concurrent Publisher']);
    await git(['-C', competing, 'config', 'user.email', 'concurrent@example.invalid']);
    await fs.outputFile(path.join(competing, 'concurrent-marker.txt'), 'advanced\n');
    await git(['-C', competing, 'add', 'concurrent-marker.txt']);
    await git(['-C', competing, 'commit', '--quiet', '-m', 'concurrent advance']);
    await git(['-C', competing, 'push', '--quiet', 'origin', `HEAD:${CATALOG_CHANNEL_REFS.latest}`]);
    const concurrentHead = await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]);

    await expect(publishStagedCatalog(staleHistory, staleStage.outputRoot))
      .rejects.toThrow('advanced after release history was read');
    expect(await git(['--git-dir', remoteUrl, 'rev-parse', CATALOG_CHANNEL_REFS.latest]))
      .toBe(concurrentHead);
    await expect(git(['--git-dir', remoteUrl, 'rev-parse', 'refs/tags/catalog-v1.1.0']))
      .rejects.toThrow();
  });

  it('keeps temporary Git metadata inside the publisher repository under injected Git paths', async () => {
    const root = await fixtureRoot('aw-catalog-git-env-');
    const remoteUrl = await createBareRemote(root);
    const externalWorktree = path.join(root, 'external-worktree');
    await git(['init', '--quiet', externalWorktree]);
    await git(['-C', externalWorktree, 'config', 'user.name', 'External Repository']);
    await git(['-C', externalWorktree, 'config', 'user.email', 'external@example.invalid']);
    await fs.outputFile(path.join(externalWorktree, 'sentinel.txt'), 'external\n');
    await git(['-C', externalWorktree, 'add', 'sentinel.txt']);
    await git(['-C', externalWorktree, 'commit', '--quiet', '-m', 'external sentinel']);
    const externalGitDir = path.join(externalWorktree, '.git');
    const refsBefore = await git(['--git-dir', externalGitDir, 'show-ref']);
    const objectsBefore = (await fs.readdir(path.join(externalGitDir, 'objects'), { recursive: true }))
      .sort();
    const injectedEnv = {
      ...process.env,
      GIT_COMMON_DIR: externalGitDir,
      GIT_WORK_TREE: externalWorktree,
      GIT_INDEX_FILE: path.join(externalGitDir, 'index'),
      GIT_OBJECT_DIRECTORY: path.join(externalGitDir, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(externalGitDir, 'objects'),
      GIT_NAMESPACE: 'external-namespace',
    };
    const temporaryGitPaths: string[][] = [];
    const executeRealGit = async (command: string, args: string[], options: Parameters<typeof execFileAsync>[2]) => {
      const result = await execFileAsync(command, args, options);
      if (args.includes('init')) {
        const paths = await Promise.all([
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
          ['rev-parse', '--path-format=absolute', '--git-path', 'refs'],
        ].map(async (gitArgs) => String((await execFileAsync('git', gitArgs, options)).stdout).trim()));
        temporaryGitPaths.push(paths);
      }
      return result;
    };
    const runGit = (args: string[], options: { cwd?: string } = {}) => runCatalogGit(args, {
      ...options,
      env: injectedEnv,
      execFile: executeRealGit,
    });

    const releaseHistory = await readCatalogPublicationHistory({
      mode: 'latest', catalogVersion: '1.0.0', remoteUrl, catalogModules, runGit,
    });
    const staged = await stage(root, '1.0.0', releaseHistory.mergedLedger);
    await publishStagedCatalog(releaseHistory, staged.outputRoot, { runGit });

    expect(temporaryGitPaths).toHaveLength(3);
    for (const paths of temporaryGitPaths) {
      for (const gitPath of paths) {
        expect(gitPath).toContain(`${path.sep}aw-catalog-publish-`);
        expect(gitPath.startsWith(externalGitDir)).toBe(false);
      }
    }
    expect(await git(['--git-dir', externalGitDir, 'show-ref'])).toBe(refsBefore);
    expect((await fs.readdir(path.join(externalGitDir, 'objects'), { recursive: true })).sort())
      .toEqual(objectsBefore);
  });

  it('rejects embedded HTTPS credentials and invokes Git without a shell in non-interactive mode', async () => {
    const credential = 'catalog-secret-value';
    const credentialError = await readCatalogPublicationHistory({
      mode: 'latest',
      catalogVersion: '1.0.0',
      remoteUrl: `https://publisher:${credential}@example.com/catalog.git`,
      catalogModules,
    }).catch((error) => error);
    expect(credentialError).toBeInstanceOf(Error);
    expect(credentialError.message).toContain('must not contain an embedded token or password');
    expect(credentialError.message).not.toContain(credential);

    const execute = vi.fn(async (_command, _args, options) => {
      expect(options).not.toHaveProperty('shell');
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0');
      expect(options.env.GCM_INTERACTIVE).toBe('Never');
      expect(options.env).not.toHaveProperty('GIT_DIR');
      expect(options.env).not.toHaveProperty('GIT_COMMON_DIR');
      expect(options.env).not.toHaveProperty('GIT_NAMESPACE');
      expect(options.env.HOME).toBe('/credential-home');
      expect(options.env.SSH_AUTH_SOCK).toBe('/credential-agent.sock');
      expect(options.env.GIT_CONFIG_GLOBAL).toBe('/credential-home/.gitconfig');
      return { stdout: '', stderr: '' };
    });
    await runCatalogGit(['status'], {
      execFile: execute,
      env: {
        ...process.env,
        GIT_DIR: '/tmp/injected',
        GIT_COMMON_DIR: '/tmp/injected-common',
        GIT_NAMESPACE: 'injected',
        HOME: '/credential-home',
        SSH_AUTH_SOCK: '/credential-agent.sock',
        GIT_CONFIG_GLOBAL: '/credential-home/.gitconfig',
      },
    });
    const invokedArgs = execute.mock.calls[0]![1];
    expect(invokedArgs.at(-1)).toBe('status');
    expect(invokedArgs).toContain('core.autocrlf=false');
    expect(invokedArgs).toContain(`core.hooksPath=${os.devNull}`);
    expect(invokedArgs).toContain('commit.gpgSign=false');
    expect(invokedArgs).toContain('tag.gpgSign=false');
  });
});
