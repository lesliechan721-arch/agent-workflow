import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  bumpStableVersion,
  parseTargetArgs,
  readVersionTargets,
  updateReleaseTargets,
} from '../../../../scripts/release/release-target.mjs';
import {
  createReleasePlan,
  normalizeReleasePlan,
  writeReleasePlan,
} from '../../../../scripts/release/release-plan.mjs';
import {
  calculateReleaseStatus,
  hasPlanAction,
  normalizeCliRegistryHistory,
} from '../../../../scripts/release/release-state.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';
import { calculateCanonicalDigest } from '../../../../scripts/release/release-model.mjs';
import {
  observeReleaseHistory,
  projectBuildDigest,
  readRegistryReleaseHistory,
} from '../../../../scripts/release/release-observe.mjs';
import { prepareRelease } from '../../../../scripts/release/release-prepare.mjs';
import { releaseStatus } from '../../../../scripts/release/release-status.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  resolveCatalogMaintenanceRemote,
} from '../../../../scripts/release/git-catalog-publisher.mjs';
import { OFFICIAL_CATALOG_SOURCE_URL } from '../../src/constants.js';

const roots: string[] = [];
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

async function temporaryRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-release-phase2-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'release'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true });
  await fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true });
  await fs.writeFile(path.join(root, 'release', 'version-targets.json'), `${JSON.stringify({
    schemaVersion: 1,
    cli: '1.2.3',
    catalog: '2.3.4',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'packages', 'cli', 'package.json'), `${JSON.stringify({
    name: '@lesliechan721/aw', version: '1.2.3', type: 'module',
  }, null, 2)}\n`);
  await fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), `${JSON.stringify({
    name: '@lesliechan721/agent-skill-eval', version: '1.2.3', type: 'module',
  }, null, 2)}\n`);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('release targets', () => {
  it('parses combined axes, rejects duplicates, and applies strict SemVer bumps', () => {
    const parsed = parseTargetArgs([
      '--cli', 'minor', '--catalog', 'patch', '--plugin', 'ask-me=major',
    ]);
    expect(parsed).toMatchObject({ cli: 'minor', catalog: 'patch' });
    expect([...parsed.plugins]).toEqual([['ask-me', 'major']]);
    expect(bumpStableVersion('999999999999999999999.2.3', 'patch'))
      .toBe('999999999999999999999.2.4');
    expect(() => parseTargetArgs(['--cli', 'patch', '--cli', 'minor']))
      .toThrow('Duplicate release target axis');
    expect(() => parseTargetArgs([])).toThrow('at least one version bump');
  });

  it('atomically updates exact target and plugin manifest files', async () => {
    const root = await temporaryRepo();
    const manifestRoot = path.join(root, 'plugins', 'ask-me', '.agents-plugin');
    await fs.mkdir(manifestRoot, { recursive: true });
    await fs.writeFile(path.join(manifestRoot, 'plugin.json'), `${JSON.stringify({
      name: 'ask-me', version: '4.5.6', description: 'fixture',
    }, null, 2)}\n`);
    await fs.chmod(path.join(manifestRoot, 'plugin.json'), 0o640);
    await updateReleaseTargets([
      '--cli', 'minor', '--catalog', 'patch', '--plugin', 'ask-me=major',
    ], { repoRoot: root });
    await expect(readVersionTargets(root)).resolves.toEqual({
      schemaVersion: 1, cli: '1.3.0', catalog: '2.3.5',
    });
    for (const packagePath of [
      path.join(root, 'packages', 'cli', 'package.json'),
      path.join(root, 'packages', 'agent-skill-eval', 'package.json'),
    ]) {
      expect(JSON.parse(await fs.readFile(packagePath, 'utf8')).version).toBe('1.3.0');
    }
    expect(JSON.parse(await fs.readFile(path.join(manifestRoot, 'plugin.json'), 'utf8')))
      .toMatchObject({ name: 'ask-me', version: '5.0.0', description: 'fixture' });
    expect((await fs.stat(path.join(manifestRoot, 'plugin.json'))).mode & 0o777).toBe(0o640);
    await expect(updateReleaseTargets(['--plugin', 'missing=patch'], { repoRoot: root }))
      .rejects.toThrow('Unknown plugin');
  });

  it('rejects non-canonical target bytes', async () => {
    const root = await temporaryRepo();
    await fs.writeFile(path.join(root, 'release', 'version-targets.json'),
      '{"schemaVersion":1,"cli":"1.2.3","catalog":"2.3.4"}\n');
    await expect(readVersionTargets(root)).rejects.toThrow('canonical JSON formatting');
  });

  it('rolls back every target when a later atomic replacement fails', async () => {
    const root = await temporaryRepo();
    const manifestRoot = path.join(root, 'plugins', 'ask-me', '.agents-plugin');
    const manifestPath = path.join(manifestRoot, 'plugin.json');
    await fs.mkdir(manifestRoot, { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify({ name: 'ask-me', version: '1.0.0' }, null, 2)}\n`);
    const originalTargets = await fs.readFile(path.join(root, 'release', 'version-targets.json'), 'utf8');
    const originalManifest = await fs.readFile(manifestPath, 'utf8');
    const cliPackagePath = path.join(root, 'packages', 'cli', 'package.json');
    const evalPackagePath = path.join(root, 'packages', 'agent-skill-eval', 'package.json');
    const originalCliPackage = await fs.readFile(cliPackagePath, 'utf8');
    const originalEvalPackage = await fs.readFile(evalPackagePath, 'utf8');
    const fileSystem = {
      writeFile: fs.writeFile.bind(fs),
      rm: fs.rm.bind(fs),
      rename: async (source: string, destination: string) => {
        if (source.endsWith('.tmp') && destination === manifestPath) {
          throw new Error('injected second replacement failure');
        }
        return fs.rename(source, destination);
      },
    };
    await expect(updateReleaseTargets([
      '--cli', 'patch', '--plugin', 'ask-me=patch',
    ], { repoRoot: root, fileSystem })).rejects.toThrow('injected second replacement failure');
    await expect(fs.readFile(path.join(root, 'release', 'version-targets.json'), 'utf8'))
      .resolves.toBe(originalTargets);
    await expect(fs.readFile(manifestPath, 'utf8')).resolves.toBe(originalManifest);
    await expect(fs.readFile(cliPackagePath, 'utf8')).resolves.toBe(originalCliPackage);
    await expect(fs.readFile(evalPackagePath, 'utf8')).resolves.toBe(originalEvalPackage);
  });

  it.each([
    ['patch', '1.2.4'],
    ['minor', '1.3.0'],
    ['major', '2.0.0'],
  ] as const)('updates both public packages for a CLI %s bump', async (bump, expected) => {
    const root = await temporaryRepo();
    await updateReleaseTargets(['--cli', bump], { repoRoot: root });
    const target = await readVersionTargets(root);
    const versions = await Promise.all([
      fs.readFile(path.join(root, 'packages', 'cli', 'package.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'), 'utf8').then(JSON.parse),
    ]);
    expect(target.cli).toBe(expected);
    expect(versions.map((entry) => entry.version)).toEqual([expected, expected]);
  });

  it('rejects a CLI bump before writing when either public package is out of lockstep', async () => {
    const root = await temporaryRepo();
    const cliPackagePath = path.join(root, 'packages', 'cli', 'package.json');
    const originalTarget = await fs.readFile(path.join(root, 'release', 'version-targets.json'), 'utf8');
    const cliPackage = JSON.parse(await fs.readFile(cliPackagePath, 'utf8'));
    await fs.writeFile(cliPackagePath, `${JSON.stringify({ ...cliPackage, version: '1.2.4' }, null, 2)}\n`);
    await expect(updateReleaseTargets(['--cli', 'patch'], { repoRoot: root }))
      .rejects.toThrow('must match packages/cli/package.json');
    await expect(fs.readFile(path.join(root, 'release', 'version-targets.json'), 'utf8'))
      .resolves.toBe(originalTarget);
  });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const packages = [
    { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('3'), tarballDigest: digest('7') },
    { name: '@lesliechan721/aw', contentDigest: digest('4'), tarballDigest: digest('8') },
  ];
  return {
    channel: 'beta' as const,
    targets: { schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0' },
    content: {
      source: {
        head: 'a'.repeat(40),
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
        minCliVersion: '0.1.0-beta.3',
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
    ...overrides,
  };
}

describe('release status and plans', () => {
  it('projects only real bare build digests into canonical release-plan digests', () => {
    expect(projectBuildDigest('a'.repeat(64), 'inputDigest')).toBe(`sha256:${'a'.repeat(64)}`);
    for (const value of [
      `sha256:${'a'.repeat(64)}`,
      'a'.repeat(63),
      'A'.repeat(64),
      `sha512:${'a'.repeat(64)}`,
    ]) expect(() => projectBuildDigest(value, 'inputDigest')).toThrow('64 lowercase hexadecimal');
  });
  it('uses one canonical SSH maintenance remote while runtime keeps the public HTTPS source', async () => {
    const readCatalogHistory = vi.fn(async (options) => ({
      remoteUrl: options.remoteUrl,
      channels: { latest: null, beta: null },
      tag: null,
      pending: null,
      mergedLedger: { schemaVersion: 2, records: [] },
    }));
    await observeReleaseHistory({
      targets: { schemaVersion: 1, cli: '0.1.0', catalog: '0.1.0' },
      channel: 'beta',
      cliDistRoot: '/fixture/cli-dist',
      readRegistryHistory: async () => ({
        '@lesliechan721/agent-skill-eval': [],
        '@lesliechan721/aw': [],
        distTags: {
          '@lesliechan721/agent-skill-eval': { latest: null, beta: null },
          '@lesliechan721/aw': { latest: null, beta: null },
        },
      }),
      readCatalogHistory,
    });

    expect(OFFICIAL_CATALOG_PUBLISH_REMOTE)
      .toBe('git@github.com:lesliechan721-arch/agent-workflow.git');
    expect(OFFICIAL_CATALOG_SOURCE_URL)
      .toBe('https://github.com/lesliechan721-arch/agent-workflow.git');
    expect(readCatalogHistory).toHaveBeenCalledWith(expect.objectContaining({
      remoteUrl: OFFICIAL_CATALOG_PUBLISH_REMOTE,
    }));
    expect(() => resolveCatalogMaintenanceRemote({
      remoteUrl: '/fixture/one.git',
      catalogRemoteUrl: '/fixture/two.git',
    })).toThrow('must identify the same remote');
    expect(() => resolveCatalogMaintenanceRemote({
      remoteUrl: 'https://token@github.com/example/catalog.git',
    })).toThrow('must not contain');
  });

  it('uses beta.3 for the first complete CLI train and selects the schema 4 tag-first publication', () => {
    const input = fixture();
    input.history.registry['@lesliechan721/aw'] = [
      { version: '0.1.0-beta.1', awRelease: null },
      { version: '0.1.0-beta.2', awRelease: null },
    ];
    const status = calculateReleaseStatus(input);
    expect(status.cli).toMatchObject({ action: 'publish', candidateVersion: '0.1.0-beta.3' });
    expect(status.catalog).toMatchObject({
      action: 'publish', candidateVersion: '0.1.0-beta.1', publicationMode: 'tag-first',
    });
    expect(status.plugins[0]).toMatchObject({
      action: 'publish', candidateVersion: '1.0.0-beta.1',
    });
  });

  it('blocks a partial schema-1 CLI train', () => {
    const input = fixture();
    input.history.registry['@lesliechan721/aw'] = [{
      version: '0.1.0-beta.3',
      awRelease: {
        schemaVersion: 1,
        targetVersion: '0.1.0',
        candidateVersion: '0.1.0-beta.3',
        planId: digest('7'),
        sourceHead: 'a'.repeat(40),
        packageContentDigest: digest('8'),
        trainContentDigest: input.content.cli.trainContentDigest,
      },
    }];
    expect(calculateReleaseStatus(input).cli).toMatchObject({
      action: 'blocked',
      candidateVersion: null,
      reason: { code: 'partial-candidate' },
    });
  });

  it('blocks beta.3+ without metadata and rejects a declared train digest not derived from both packages', () => {
    const missing = fixture();
    missing.history.registry['@lesliechan721/aw'] = [{ version: '0.1.0-beta.3', awRelease: null }];
    expect(calculateReleaseStatus(missing).cli.action).toBe('blocked');

    const inconsistent = fixture();
    const metadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '0.1.0',
      candidateVersion: '0.1.0-beta.3',
      planId: digest('9'),
      sourceHead: 'a'.repeat(40),
      packageContentDigest,
      trainContentDigest: digest('f'),
    });
    inconsistent.history.registry['@lesliechan721/agent-skill-eval'] = [{
      version: '0.1.0-beta.3', awRelease: metadata(digest('3')),
    }];
    inconsistent.history.registry['@lesliechan721/aw'] = [{
      version: '0.1.0-beta.3', awRelease: metadata(digest('4')),
    }];
    expect(calculateReleaseStatus(inconsistent).cli).toMatchObject({
      action: 'blocked', reason: { code: 'partial-candidate' },
    });
  });

  it('chooses atomic-combined or tag-first from observed train tags and compatibility', () => {
    const atomic = fixture();
    const publishedPackages = [
      { name: '@lesliechan721/agent-skill-eval', contentDigest: digest('d') },
      { name: '@lesliechan721/aw', contentDigest: digest('e') },
    ];
    const publishedTrainDigest = calculateCliTrainContentDigest(publishedPackages);
    for (const publishedPackage of publishedPackages) {
      atomic.history.registry[publishedPackage.name] = [{
        version: '0.1.0-beta.3',
        awRelease: {
          schemaVersion: 1,
          targetVersion: '0.1.0',
          candidateVersion: '0.1.0-beta.3',
          planId: digest('9'),
          sourceHead: 'b'.repeat(40),
          packageContentDigest: publishedPackage.contentDigest,
          trainContentDigest: publishedTrainDigest,
        },
      }];
      atomic.history.registry.distTags[publishedPackage.name].beta = '0.1.0-beta.3';
    }
    expect(calculateReleaseStatus(atomic).catalog.publicationMode).toBe('atomic-combined');

    const tagFirst = fixture();
    tagFirst.history.registry['@lesliechan721/aw'] = [
      { version: '0.1.0-beta.1', awRelease: null },
      { version: '0.1.0-beta.2', awRelease: null },
    ];
    expect(calculateReleaseStatus(tagFirst).catalog.publicationMode).toBe('tag-first');
  });

  it('fixes catalog-only and promotion modes in status instead of deferring them to publishing', () => {
    const catalogOnly = fixture();
    catalogOnly.content.catalog.minCliVersion = '0.1.0-beta.1';
    const metadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '0.1.0',
      candidateVersion: '0.1.0-beta.1',
      planId: digest('9'),
      sourceHead: 'a'.repeat(40),
      packageContentDigest,
      trainContentDigest: catalogOnly.content.cli.trainContentDigest,
    });
    for (const [name, packageDigest] of [
      ['@lesliechan721/agent-skill-eval', digest('3')],
      ['@lesliechan721/aw', digest('4')],
    ] as const) {
      catalogOnly.history.registry[name] = [{
        version: '0.1.0-beta.1', awRelease: metadata(packageDigest),
      }];
      catalogOnly.history.registry.distTags[name].beta = '0.1.0-beta.1';
    }
    expect(calculateReleaseStatus(catalogOnly).catalog.publicationMode).toBe('bootstrap');

    const promotion = structuredClone(catalogOnly);
    promotion.history.catalog.pending = 'c'.repeat(40);
    promotion.history.catalog.tag = {
      commit: 'c'.repeat(40),
      snapshotDigest: digest('8'),
      manifest: {
        schemaVersion: 4,
        catalogVersion: '0.1.0-beta.1',
        release: {
          state: 'published', targetVersion: '0.1.0', planId: digest('9'),
          sourceHead: 'a'.repeat(40), contentDigest: digest('5'),
        },
      },
      catalogContentDigest: digest('5'),
      ledger: { schemaVersion: 2, records: [] },
    };
    expect(calculateReleaseStatus(promotion).catalog).toMatchObject({
      action: 'recover', publicationMode: 'promotion',
    });

    const belowFloor = structuredClone(promotion);
    belowFloor.content.catalog.minCliVersion = '0.1.0-beta.2';
    expect(calculateReleaseStatus(belowFloor).catalog).toMatchObject({
      action: 'deferred',
      candidateVersion: null,
      publicationMode: 'none',
      reason: {
        code: 'published-cli-incompatible',
        details: { minCliVersion: '0.1.0-beta.2', publishedTag: '0.1.0-beta.1' },
      },
    });
  });

  it('defers Catalog and Plugin only in the channel that does not own a pending tag', async () => {
    const betaPending = fixture();
    betaPending.content.catalog.minCliVersion = '0.1.0-beta.1';
    const betaMetadata = (packageContentDigest: string) => ({
      schemaVersion: 1,
      targetVersion: '0.1.0',
      candidateVersion: '0.1.0-beta.1',
      planId: digest('9'),
      sourceHead: 'a'.repeat(40),
      packageContentDigest,
      trainContentDigest: betaPending.content.cli.trainContentDigest,
    });
    for (const [name, packageDigest] of [
      ['@lesliechan721/agent-skill-eval', digest('3')],
      ['@lesliechan721/aw', digest('4')],
    ] as const) {
      betaPending.history.registry[name] = [{
        version: '0.1.0-beta.1', awRelease: betaMetadata(packageDigest),
      }];
      betaPending.history.registry.distTags[name].beta = '0.1.0-beta.1';
    }
    betaPending.history.catalog.pending = 'c'.repeat(40);
    betaPending.history.catalog.tag = {
      commit: 'c'.repeat(40),
      snapshotDigest: digest('8'),
      manifest: {
        schemaVersion: 4,
        catalogVersion: '0.1.0-beta.1',
        channel: 'beta',
        release: {
          state: 'published', targetVersion: '0.1.0', planId: digest('9'),
          sourceHead: 'a'.repeat(40), contentDigest: digest('5'),
        },
      },
      catalogContentDigest: digest('5'),
      ledger: { schemaVersion: 2, records: [] },
    };
    expect(calculateReleaseStatus(betaPending).catalog).toMatchObject({
      action: 'recover', publicationMode: 'promotion',
    });
    const { channel: ignoredChannel, ...betaObserved } = betaPending;
    const stableView = calculateReleaseStatus({ channel: 'stable', ...betaObserved });
    expect(stableView.cli.action).not.toBe('deferred');
    expect(stableView.catalog).toMatchObject({
      action: 'deferred', candidateVersion: null, publicationMode: 'none',
      reason: { code: 'catalog-publication-pending', details: { channel: 'beta' } },
    });
    expect(stableView.plugins[0]).toMatchObject({
      action: 'deferred', reason: { code: 'catalog-publication-pending' },
    });

    const stablePending = structuredClone(betaPending);
    stablePending.history.registry.distTags['@lesliechan721/agent-skill-eval'] = {
      latest: '0.1.0', beta: null,
    };
    stablePending.history.registry.distTags['@lesliechan721/aw'] = {
      latest: '0.1.0', beta: null,
    };
    for (const name of [
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ] as const) {
      stablePending.history.registry[name][0].version = '0.1.0';
      stablePending.history.registry[name][0].awRelease.candidateVersion = '0.1.0';
    }
    stablePending.history.catalog.tag.manifest = {
      schemaVersion: 4,
      catalogVersion: '0.1.0',
      channel: 'latest',
      release: {
        state: 'published', targetVersion: '0.1.0', planId: digest('9'),
        sourceHead: 'a'.repeat(40), contentDigest: digest('5'),
      },
    };
    const { channel: ignoredStableChannel, ...stableObserved } = stablePending;
    expect(calculateReleaseStatus({ channel: 'stable', ...stableObserved }).catalog)
      .toMatchObject({ action: 'recover', publicationMode: 'promotion' });
    expect(calculateReleaseStatus({ channel: 'beta', ...stableObserved }).catalog)
      .toMatchObject({
        action: 'deferred', reason: { code: 'catalog-publication-pending' },
      });

    await expect(releaseStatus([], { observe: async () => betaObserved, writeOutput: false }))
      .resolves.toMatchObject({ channels: { stable: { catalog: { action: 'deferred' } } } });
    await expect(releaseStatus(['--json'], { observe: async () => betaObserved, writeOutput: false }))
      .resolves.toMatchObject({ channels: { beta: { catalog: { action: 'recover' } } } });

    const prepareCrossChannel = async (channel: 'stable' | 'beta', observed: typeof betaObserved) => {
      const releaseIdentity = {
        generationId: 'generation', outputDigest: 'output', inputDigest: 'input',
        cliPackageDigest: 'package', headCommit: 'a'.repeat(40),
      };
      return prepareRelease([channel], {
        observe: async () => ({ ...observed, releaseIdentity }),
        assertClean: async () => undefined,
        assertFresh: async () => undefined,
        readTargets: async () => observed.targets,
        assertTargetsMatchHead: async () => undefined,
        observeRemoteHistory: async () => observed.history,
        materializeCliPlanArtifacts: async (status) => status.cli.packages,
        materializeCatalogPlanArtifact: async () => null,
        writePlan: async (plan) => ({ created: true, planPath: '/fixture/plan.json', plan }),
      });
    };
    await expect(prepareCrossChannel('stable', betaObserved)).resolves.toMatchObject({
      plan: {
        channel: 'stable',
        cli: { action: 'publish', candidateVersion: '0.1.0' },
        catalog: { action: 'deferred', publicationMode: 'none', snapshotDigest: null },
      },
    });
    const stablePendingWithChangedCli = structuredClone(stableObserved);
    stablePendingWithChangedCli.targets.cli = '0.2.0';
    stablePendingWithChangedCli.content.cli.packages[0].contentDigest = digest('7');
    stablePendingWithChangedCli.content.cli.trainContentDigest = calculateCliTrainContentDigest(
      stablePendingWithChangedCli.content.cli.packages.map(({ name, contentDigest }) => ({
        name, contentDigest,
      })),
    );
    await expect(prepareCrossChannel('beta', stablePendingWithChangedCli)).resolves.toMatchObject({
      plan: {
        channel: 'beta',
        cli: { action: 'publish', candidateVersion: '0.2.0-beta.1' },
        catalog: { action: 'deferred', publicationMode: 'none', snapshotDigest: null },
      },
    });

    const inconsistentPending = structuredClone(betaPending);
    inconsistentPending.history.catalog.tag.manifest.channel = 'latest';
    expect(() => calculateReleaseStatus(inconsistentPending))
      .toThrow('tag version and manifest channel are inconsistent');
  });

  it('keeps CLI publishable when the catalog axis needs a target bump', () => {
    const input = fixture();
    input.history.catalog.latest = {
      commit: 'b'.repeat(40),
      manifest: { catalogVersion: '0.1.0' },
      catalogContentDigest: digest('9'),
      ledger: {
        schemaVersion: 2,
        records: [{
          plugin: 'ask-me', version: '1.0.0', contentDigest: digest('9'),
          artifactDigest: digest('a'), manifestDigest: digest('b'),
          channel: 'latest', catalogVersion: '0.1.0',
        }],
      },
    };
    input.history.catalog.ledger = input.history.catalog.latest.ledger;
    const status = calculateReleaseStatus(input);
    expect(status.cli.action).toBe('publish');
    expect(status.catalog.action).toBe('deferred');
    expect(status.plugins[0]).toMatchObject({ action: 'deferred', candidateVersion: null });
    expect(hasPlanAction(status)).toBe(true);
  });

  it('validates plan identity and writes an immutable idempotent plan', async () => {
    const root = await temporaryRepo();
    const status = calculateReleaseStatus(fixture());
    const plan = createReleasePlan(status);
    expect(normalizeReleasePlan(plan)).toEqual(plan);

    const { snapshotDigest: omittedSnapshot, ...catalogWithoutSnapshot } = plan.catalog;
    expect(() => normalizeReleasePlan({
      ...plan,
      catalog: catalogWithoutSnapshot,
    })).toThrow('missing field "snapshotDigest"');
    expect(() => normalizeReleasePlan({
      ...plan,
      catalog: { ...plan.catalog, snapshotDigest: 'sha256:not-hex' },
    })).toThrow('catalog.snapshotDigest');
    expect(() => normalizeReleasePlan({ ...plan, channel: 'stable' }))
      .toThrow('candidate does not match plan channel');
    const first = await writeReleasePlan(plan, { repoRoot: root });
    const second = await writeReleasePlan(plan, { repoRoot: root });
    expect(first.created).toBe(true);
    expect(path.basename(first.planPath)).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(second.created).toBe(false);
    const changed = `${JSON.stringify({ ...plan, planDigest: digest('f') }, null, 2)}\n`;
    await fs.writeFile(first.planPath, changed);
    await expect(writeReleasePlan(plan, { repoRoot: root })).rejects.toThrow('different bytes');
  });

  it('keeps planId free of the raw Catalog tree digest while planDigest binds it', () => {
    const input = fixture();
    input.content.catalog.minCliVersion = '0.1.0-beta.1';
    const plan = createReleasePlan(calculateReleaseStatus(input));
    const changedSnapshotDigest = digest('f');
    const { planId: ignoredId, planDigest: ignoredDigest, ...base } = plan;
    const { snapshotDigest: ignoredSnapshot, ...catalogIdentity } = base.catalog;
    const identity = {
      ...base,
      cli: {
        ...base.cli,
        packages: base.cli.packages.map(({ tarballDigest: ignoredTarball, ...entry }) => entry),
      },
      catalog: catalogIdentity,
    };
    const changedBase = {
      ...base,
      catalog: { ...base.catalog, snapshotDigest: changedSnapshotDigest },
    };
    const resigned = {
      ...changedBase,
      planId: calculateCanonicalDigest(identity),
    };
    const changed = {
      ...resigned,
      planDigest: calculateCanonicalDigest(resigned),
    };
    expect(changed.planId).toBe(plan.planId);
    expect(changed.planDigest).not.toBe(plan.planDigest);
    expect(normalizeReleasePlan(changed).catalog.snapshotDigest).toBe(changedSnapshotDigest);
  });

  it('rejects cross-field plan drift even after planId and planDigest are recomputed', () => {
    const plan = createReleasePlan(calculateReleaseStatus(fixture()));
    const resign = (raw: Record<string, unknown>) => {
      const { planId: ignoredId, planDigest: ignoredDigest, ...base } = raw;
      const planId = calculateCanonicalDigest(base);
      return { ...base, planId, planDigest: calculateCanonicalDigest({ ...base, planId }) };
    };
    const packageActionDrift = resign({
      ...plan,
      cli: {
        ...plan.cli,
        packages: plan.cli.packages.map((entry, index) => index === 0
          ? { ...entry, action: 'skip' }
          : entry),
      },
    });
    expect(() => normalizeReleasePlan(packageActionDrift)).toThrow('package actions must match');
    const modeDrift = resign({
      ...plan,
      catalog: { ...plan.catalog, publicationMode: 'catalog-only' },
    });
    expect(() => normalizeReleasePlan(modeDrift)).toThrow('action/mode combination');
    const trainDrift = resign({
      ...plan,
      cli: { ...plan.cli, trainContentDigest: digest('e') },
    });
    expect(() => normalizeReleasePlan(trainDrift)).toThrow('package content does not match');
    const channelDrift = resign({ ...plan, channel: 'stable' });
    expect(() => normalizeReleasePlan(channelDrift)).toThrow('candidate does not match plan channel');
    const skipCandidateDrift = resign({
      ...plan,
      cli: { ...plan.cli, action: 'skip', candidateVersion: null },
    });
    expect(() => normalizeReleasePlan(skipCandidateDrift)).toThrow('skip requires a candidate');

    const tagFirstInput = fixture();
    tagFirstInput.content.catalog.minCliVersion = '0.1.0-beta.1';
    const tagFirstPlan = createReleasePlan(calculateReleaseStatus(tagFirstInput));
    const allowedModeDrift = resign({
      ...tagFirstPlan,
      catalog: { ...tagFirstPlan.catalog, publicationMode: 'atomic-combined' },
    });
    expect(() => normalizeReleasePlan(allowedModeDrift)).toThrow('bound release observations');

    const skippedCliDrift = resign({
      ...tagFirstPlan,
      cli: {
        ...tagFirstPlan.cli,
        action: 'skip',
        packages: tagFirstPlan.cli.packages.map((entry) => ({ ...entry, action: 'skip' })),
      },
      catalog: { ...tagFirstPlan.catalog, publicationMode: 'catalog-only' },
    });
    expect(() => normalizeReleasePlan(skippedCliDrift)).toThrow('bound release observations');
  });

  it('enforces dist-tag channel types and binds the one legacy latest exception', async () => {
    const invalid = fixture();
    invalid.history.registry.distTags['@lesliechan721/aw'].beta = '0.1.0';
    expect(() => normalizeCliRegistryHistory(invalid.history.registry))
      .toThrow('beta dist-tag must reference a canonical beta');

    invalid.history.registry.distTags['@lesliechan721/aw'] = {
      latest: '0.1.0-beta.2', beta: null,
    };
    expect(() => normalizeCliRegistryHistory(invalid.history.registry))
      .toThrow('latest dist-tag must reference a stable');

    const legacy = fixture({ channel: 'stable' });
    legacy.history.registry['@lesliechan721/aw'] = [
      { version: '0.1.0-beta.1', awRelease: null },
      { version: '0.1.0-beta.2', awRelease: null },
    ];
    legacy.history.registry.distTags['@lesliechan721/aw'].latest = '0.1.0-beta.1';
    const status = calculateReleaseStatus(legacy);
    expect(status.cli).toMatchObject({
      action: 'publish', candidateVersion: '0.1.0', publishedTag: '0.1.0-beta.1',
      latestBeta: '0.1.0-beta.2',
    });
    expect(status.catalog).toMatchObject({
      action: 'publish', candidateVersion: '0.1.0', minCliVersion: '0.1.0-beta.3',
      publicationMode: 'tag-first',
    });
    expect(status.plugins[0]).toMatchObject({
      action: 'publish', candidateVersion: '1.0.0',
    });
    const plan = createReleasePlan(status);
    expect(plan.history.npm.legacyLatestAwOnly).toBe(true);
    expect(plan.history.npm.packages).toContainEqual(expect.objectContaining({
      name: '@lesliechan721/aw',
      versions: [
        { candidateVersion: '0.1.0-beta.1', metadata: null },
        { candidateVersion: '0.1.0-beta.2', metadata: null },
      ],
    }));
    expect(normalizeReleasePlan(plan)).toEqual(plan);

    const root = await temporaryRepo();
    const prepared = await prepareRelease(['stable'], {
      repoRoot: root,
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => legacy.targets,
      observe: async () => legacy,
      observeRemoteHistory: async () => legacy.history,
      materializeCliPlanArtifacts: async (releaseStatus) => releaseStatus.cli.packages,
      materializeCatalogPlanArtifact: async () => digest('c'),
    });
    expect(prepared).toMatchObject({
      created: true,
      plan: {
        channel: 'stable',
        cli: { action: 'publish', candidateVersion: '0.1.0' },
        catalog: {
          action: 'publish', candidateVersion: '0.1.0',
          minCliVersion: '0.1.0-beta.3', publicationMode: 'tag-first',
          snapshotDigest: digest('c'),
        },
      },
    });
    const writtenPlan = JSON.parse(await fs.readFile(prepared.planPath!, 'utf8'));
    expect(writtenPlan.history.npm).toMatchObject({ legacyLatestAwOnly: true });

    const evalFirst = structuredClone(legacy);
    evalFirst.history.registry['@lesliechan721/agent-skill-eval'] = [{
      version: '0.1.0',
      awRelease: {
        schemaVersion: 1,
        targetVersion: '0.1.0',
        candidateVersion: '0.1.0',
        planId: digest('9'),
        sourceHead: 'a'.repeat(40),
        packageContentDigest: digest('3'),
        trainContentDigest: evalFirst.content.cli.trainContentDigest,
      },
    }];
    evalFirst.history.registry.distTags['@lesliechan721/agent-skill-eval'].latest = '0.1.0';
    const normalizedEvalFirst = normalizeCliRegistryHistory(evalFirst.history.registry);
    expect(normalizedEvalFirst).toMatchObject({
      legacyLatestAwOnly: false,
      legacyAwBeta1RemainsLatest: true,
    });
    expect(calculateReleaseStatus(evalFirst).cli).toMatchObject({
      action: 'blocked', reason: { code: 'partial-candidate' },
    });
    const writePlan = vi.fn();
    await expect(prepareRelease(['stable'], {
      assertClean: async () => undefined,
      observe: async () => evalFirst,
      writePlan,
    })).rejects.toThrow('partial-candidate');
    expect(writePlan).not.toHaveBeenCalled();

    const invalidLegacyBeta = fixture();
    invalidLegacyBeta.history.registry['@lesliechan721/agent-skill-eval'] = [{
      version: '0.1.0-beta.1', awRelease: null,
    }];
    invalidLegacyBeta.history.registry['@lesliechan721/aw'] = [{
      version: '0.1.0-beta.1', awRelease: null,
    }];
    invalidLegacyBeta.history.registry.distTags['@lesliechan721/aw'].beta = '0.1.0-beta.1';
    expect(calculateReleaseStatus(invalidLegacyBeta).cli).toMatchObject({
      action: 'blocked',
      reason: { code: 'partial-candidate' },
    });
  });
});

describe('release registry observation', () => {
  it('maps only package E404 versions lookups to empty history', async () => {
    const captureCommand = vi.fn(async () => {
      throw new Error('ERR_PNPM_FETCH_404 404 Not Found');
    });
    await expect(readRegistryReleaseHistory({
      registryUrl: 'https://registry.example.test/',
      captureCommand,
    })).resolves.toMatchObject({
      '@lesliechan721/agent-skill-eval': [],
      '@lesliechan721/aw': [],
    });
  });

  it('keeps non-404 registry failures fail closed', async () => {
    await expect(readRegistryReleaseHistory({
      registryUrl: 'https://registry.example.test/',
      captureCommand: async () => { throw new Error('registry timeout'); },
    })).rejects.toThrow('registry timeout');
  });

  it('rejects an unsupported version instead of omitting it from complete history', async () => {
    await expect(readRegistryReleaseHistory({
      registryUrl: 'https://registry.example.test/',
      captureCommand: async (_command, args: string[]) => {
        if (args.includes('versions')) return { stdout: '["1.0.0-alpha.1"]', stderr: '' };
        return { stdout: '{}', stderr: '' };
      },
    })).rejects.toThrow('unsupported version');
  });

  it.each([
    ['string', '"metadata"'],
    ['array', '[]'],
    ['boolean', 'true'],
    ['number', '42'],
  ])('rejects %s awRelease JSON instead of treating it as missing', async (_kind, metadataJson) => {
    let call = 0;
    await expect(readRegistryReleaseHistory({
      registryUrl: 'https://registry.example.test/',
      captureCommand: async () => {
        call += 1;
        if (call === 1) return { stdout: '["0.1.0"]', stderr: '' };
        if (call === 2) return { stdout: '{}', stderr: '' };
        return { stdout: metadataJson, stderr: '' };
      },
    })).rejects.toThrow('invalid awRelease metadata');
  });

  it.each([
    ['empty stdout', ''],
    ['JSON null', 'null'],
  ])('treats only %s awRelease as missing metadata', async (_kind, metadataJson) => {
    const result = await readRegistryReleaseHistory({
      registryUrl: 'https://registry.example.test/',
      captureCommand: async (_command, args: string[]) => {
        if (args.includes('versions')) return { stdout: '["0.1.0-beta.1"]', stderr: '' };
        if (args.includes('dist-tags')) return { stdout: '{}', stderr: '' };
        return { stdout: metadataJson, stderr: '' };
      },
    });
    expect(result['@lesliechan721/agent-skill-eval'][0]?.awRelease).toBeNull();
    expect(result['@lesliechan721/aw'][0]?.awRelease).toBeNull();
  });
});
