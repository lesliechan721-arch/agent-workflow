import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertCliRegistryHistoryMatchesPlan,
  assertPromotionCliTrain,
  parsePublishPlanArgs,
  publishCommittedRelease,
} from '../../../../scripts/release/publish-plan.mjs';
import {
  publishCli,
  publishPreparedEvalPublication,
} from '../../../../scripts/release/publish-cli.mjs';
import { OFFICIAL_CATALOG_PUBLISH_REMOTE } from '../../../../scripts/release/git-catalog-publisher.mjs';
import { materializeCatalogPlanArtifact } from '../../../../scripts/release/release-prepare.mjs';
import { prepareRelease } from '../../../../scripts/release/release-prepare.mjs';
import { observeReleaseHistory } from '../../../../scripts/release/release-observe.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';
import {
  computeBuildInputDigest,
  computeCliPackageDigest,
} from '../../../../scripts/build/build-cache.mjs';

const temporaryRoots: string[] = [];
const execFileAsync = promisify(execFile);

async function createIdentityDriftFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plan-live-identity-'));
  temporaryRoots.push(root);
  await Promise.all([
    fs.mkdir(path.join(root, 'release'), { recursive: true }),
    fs.mkdir(path.join(root, 'scripts', 'release'), { recursive: true }),
    fs.mkdir(path.join(root, 'packages', 'agent-skill-eval'), { recursive: true }),
    fs.mkdir(path.join(root, 'packages', 'cli'), { recursive: true }),
  ]);
  const cliPath = path.join(root, 'packages', 'cli', 'package.json');
  const cleanCli = `${JSON.stringify({ name: '@lesliechan721/aw', version: '1.0.0' }, null, 2)}\n`;
  await Promise.all([
    fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture","private":true}\n'),
    fs.writeFile(path.join(root, 'release', 'version-targets.json'),
      '{"schemaVersion":1,"cli":"1.0.0","catalog":"2.0.0"}\n'),
    fs.writeFile(path.join(root, 'scripts', 'release', 'fixture.mjs'), 'export const fixture = true;\n'),
    fs.writeFile(path.join(root, 'packages', 'agent-skill-eval', 'package.json'),
      '{"name":"@lesliechan721/agent-skill-eval","version":"1.0.0"}\n'),
    fs.writeFile(cliPath, cleanCli),
  ]);
  await execFileAsync('git', ['init', '--quiet'], { cwd: root });
  await execFileAsync('git', ['add', '--all'], { cwd: root });
  await execFileAsync('git', [
    '-c', 'user.name=Release Test', '-c', 'user.email=release@example.invalid',
    'commit', '--quiet', '-m', 'fixture',
  ], { cwd: root });
  await fs.writeFile(cliPath, `${JSON.stringify({
    name: '@lesliechan721/aw', version: '1.0.0', scripts: { drift: 'node drift.mjs' },
  }, null, 2)}\n`);
  const [inputDigest, cliPackageDigest] = await Promise.all([
    computeBuildInputDigest(root),
    computeCliPackageDigest(root),
  ]);
  await fs.writeFile(cliPath, cleanCli);
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
  const identity = {
    generationId: 'generation',
    outputDigest: 'output',
    inputDigest,
    cliPackageDigest,
    headCommit: stdout.trim(),
  };
  return { root, identity, snapshot: { ...identity } };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

const EVAL_DIGEST = `sha256:${'1'.repeat(64)}`;
const AW_DIGEST = `sha256:${'2'.repeat(64)}`;
const TRAIN_DIGEST = calculateCliTrainContentDigest([
  { name: '@lesliechan721/agent-skill-eval', contentDigest: EVAL_DIGEST },
  { name: '@lesliechan721/aw', contentDigest: AW_DIGEST },
]);
const EMPTY_REGISTRY = {
  '@lesliechan721/agent-skill-eval': [],
  '@lesliechan721/aw': [],
  distTags: {
    '@lesliechan721/agent-skill-eval': { latest: null, beta: null },
    '@lesliechan721/aw': { latest: null, beta: null },
  },
};
const freshRegistryOptions = {
  readRegistryReleaseHistory: async () => EMPTY_REGISTRY,
};

function releaseMetadata(packageName: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    targetVersion: '1.0.0',
    candidateVersion: '1.0.0-beta.1',
    planId: `sha256:${'a'.repeat(64)}`,
    sourceHead: 'b'.repeat(40),
    packageContentDigest: packageName === '@lesliechan721/agent-skill-eval' ? EVAL_DIGEST : AW_DIGEST,
    trainContentDigest: TRAIN_DIGEST,
    ...overrides,
  };
}

function registryWithCandidate(
  packages: string[],
  tags: Record<string, { latest: string | null; beta: string | null }> = EMPTY_REGISTRY.distTags,
) {
  return {
    '@lesliechan721/agent-skill-eval': packages.includes('@lesliechan721/agent-skill-eval')
      ? [{ version: '1.0.0-beta.1', awRelease: releaseMetadata('@lesliechan721/agent-skill-eval') }]
      : [],
    '@lesliechan721/aw': packages.includes('@lesliechan721/aw')
      ? [{ version: '1.0.0-beta.1', awRelease: releaseMetadata('@lesliechan721/aw') }]
      : [],
    distTags: tags,
  };
}

function plan(publicationMode: 'none' | 'catalog-only' | 'atomic-combined' | 'tag-first' | 'bootstrap' | 'promotion') {
  return {
    planId: `sha256:${'a'.repeat(64)}`,
    channel: 'beta',
    source: { head: 'b'.repeat(40) },
    history: {
      catalog: { latest: null, beta: null, publicationGuard: null },
      npm: {
        legacyLatestAwOnly: false,
        legacyBetaAwOnly: false,
        packages: [
          { name: '@lesliechan721/agent-skill-eval', versions: [] },
          { name: '@lesliechan721/aw', versions: [] },
        ],
        distTags: [
          { name: '@lesliechan721/agent-skill-eval', latest: null, beta: null },
          { name: '@lesliechan721/aw', latest: null, beta: null },
        ],
      },
    },
    cli: {
      targetVersion: '1.0.0',
      candidateVersion: '1.0.0-beta.1',
      action: ['catalog-only', 'bootstrap', 'promotion', 'none'].includes(publicationMode) ? 'skip' : 'publish',
      trainContentDigest: TRAIN_DIGEST,
      packages: [
        { name: '@lesliechan721/agent-skill-eval', contentDigest: EVAL_DIGEST },
        { name: '@lesliechan721/aw', contentDigest: AW_DIGEST },
      ],
    },
    catalog: {
      targetVersion: '2.0.0',
      candidateVersion: publicationMode === 'none' ? null : '2.0.0-beta.1',
      catalogContentDigest: `sha256:${'d'.repeat(64)}`,
      snapshotDigest: publicationMode === 'none' ? null : `sha256:${'e'.repeat(64)}`,
      minCliVersion: '1.0.0-beta.1',
      publicationMode,
    },
    plugins: [],
  };
}

function bindPublishedCandidate(releasePlan: ReturnType<typeof plan>) {
  for (const packageHistory of releasePlan.history.npm.packages) {
    packageHistory.versions.push({
      candidateVersion: '1.0.0-beta.1',
      metadata: releaseMetadata(packageHistory.name),
    });
  }
  for (const tags of releasePlan.history.npm.distTags) tags.beta = '1.0.0-beta.1';
  if (releasePlan.catalog.publicationMode === 'promotion') {
    releasePlan.history.catalog.publicationGuard = 'c'.repeat(40);
    releasePlan.history.catalog.tag = {
      commit: 'c'.repeat(40),
      candidateVersion: '2.0.0-beta.1',
      contentDigest: `sha256:${'d'.repeat(64)}`,
      snapshotDigest: `sha256:${'e'.repeat(64)}`,
      origin: {
        targetVersion: '2.0.0',
        planId: `sha256:${'a'.repeat(64)}`,
        sourceHead: 'b'.repeat(40),
        contentDigest: `sha256:${'d'.repeat(64)}`,
      },
    };
  }
  return releasePlan;
}

function legacyStablePlan() {
  const releasePlan = plan('tag-first');
  releasePlan.channel = 'stable';
  releasePlan.cli.candidateVersion = '1.0.0';
  releasePlan.catalog.candidateVersion = '2.0.0';
  releasePlan.history.npm = {
    legacyLatestAwOnly: true,
    legacyBetaAwOnly: false,
    packages: [
      { name: '@lesliechan721/agent-skill-eval', versions: [] },
      {
        name: '@lesliechan721/aw',
        versions: [{ candidateVersion: '0.1.0-beta.1', metadata: null }],
      },
    ],
    distTags: [
      { name: '@lesliechan721/agent-skill-eval', latest: null, beta: null },
      { name: '@lesliechan721/aw', latest: '0.1.0-beta.1', beta: null },
    ],
  };
  return releasePlan;
}

function registryFromTestPlan(releasePlan: ReturnType<typeof plan>) {
  return {
    ...Object.fromEntries(releasePlan.history.npm.packages.map((entry) => [entry.name,
      entry.versions.map((version) => ({
        version: version.candidateVersion, awRelease: version.metadata,
      }))])),
    distTags: Object.fromEntries(releasePlan.history.npm.distTags.map((entry) => [entry.name, {
      latest: entry.latest, beta: entry.beta,
    }])),
  };
}

function promotionCatalogHistory() {
  return {
    channels: { latest: null, beta: null },
    tag: {
      commit: 'c'.repeat(40),
      catalogContentDigest: `sha256:${'d'.repeat(64)}`,
      snapshotDigest: `sha256:${'e'.repeat(64)}`,
      manifest: {
        schemaVersion: 4,
        catalogVersion: '2.0.0-beta.1',
        release: {
          state: 'published',
          targetVersion: '2.0.0',
          planId: `sha256:${'a'.repeat(64)}`,
          sourceHead: 'b'.repeat(40),
          contentDigest: `sha256:${'d'.repeat(64)}`,
        },
      },
    },
    pending: 'c'.repeat(40),
    mergedLedger: { schemaVersion: 2, records: [] },
  };
}

describe('committed release plan publisher', () => {
  it('materializes the final schema 4 Catalog candidate into the plan digest input', async () => {
    const stageCatalogRelease = vi.fn(async () => ({ snapshotDigest: `sha256:${'e'.repeat(64)}` }));
    const status = {
      source: { head: 'b'.repeat(40) },
      catalog: {
        action: 'publish', candidateVersion: '2.0.0-beta.1', targetVersion: '2.0.0',
        contentDigest: `sha256:${'d'.repeat(64)}`,
      },
      plugins: [{ name: 'demo', candidateVersion: '1.0.0-beta.1' }],
      history: { catalog: { ledger: { schemaVersion: 2, records: [] } } },
    };
    await expect(materializeCatalogPlanArtifact(status, `sha256:${'a'.repeat(64)}`, {
      withPrivateCatalogStageRoot: async (callback) => callback('/tmp/private-catalog'),
      stageCatalogRelease,
    })).resolves.toBe(`sha256:${'e'.repeat(64)}`);
    expect(stageCatalogRelease).toHaveBeenCalledWith([
      '--catalog-version', '2.0.0-beta.1',
    ], expect.objectContaining({
      pluginVersionOverrides: { demo: '1.0.0-beta.1' },
      catalogRelease: expect.objectContaining({
        state: 'published',
        planId: `sha256:${'a'.repeat(64)}`,
        contentDigest: `sha256:${'d'.repeat(64)}`,
      }),
    }));
  });

  it('carries the projected cross-channel ledger through observe, status, and prepare', async () => {
    const stableRecord = {
      plugin: 'stable-plugin',
      version: '1.0.0',
      contentDigest: `sha256:${'7'.repeat(64)}`,
      artifactDigest: `sha256:${'8'.repeat(64)}`,
      manifestDigest: `sha256:${'9'.repeat(64)}`,
      channel: 'latest',
      catalogVersion: '1.0.0',
    };
    const registry = registryWithCandidate([
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ], {
      '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
      '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
    });
    const history = await observeReleaseHistory({
      targets: { schemaVersion: 1, cli: '1.0.0', catalog: '2.0.0' },
      channel: 'beta',
      cliDistRoot: '/fixture/cli-dist',
      readRegistryHistory: async () => registry,
      readCatalogHistory: async () => ({
        channels: {
          latest: {
            commit: '1'.repeat(40),
            manifest: { catalogVersion: '1.0.0', channel: 'latest' },
            snapshotDigest: `sha256:${'3'.repeat(64)}`,
            catalogContentDigest: `sha256:${'4'.repeat(64)}`,
            ledger: { schemaVersion: 2, records: [stableRecord] },
          },
          beta: null,
        },
        tag: null,
        pending: null,
        mergedLedger: { schemaVersion: 2, records: [stableRecord] },
      }),
    });
    const observed = {
      targets: { schemaVersion: 1, cli: '1.0.0', catalog: '2.0.0' },
      content: {
        source: {
          head: 'b'.repeat(40),
          releaseInputDigest: `sha256:${'a'.repeat(64)}`,
          buildOutputDigest: `sha256:${'b'.repeat(64)}`,
          cliPackageDigest: `sha256:${'c'.repeat(64)}`,
        },
        cli: {
          trainContentDigest: TRAIN_DIGEST,
          packages: [
            {
              name: '@lesliechan721/agent-skill-eval', contentDigest: EVAL_DIGEST,
              tarballDigest: `sha256:${'5'.repeat(64)}`,
            },
            {
              name: '@lesliechan721/aw', contentDigest: AW_DIGEST,
              tarballDigest: `sha256:${'6'.repeat(64)}`,
            },
          ],
        },
        catalog: {
          minCliVersion: '1.0.0-beta.1',
          contentDigest: `sha256:${'d'.repeat(64)}`,
          plugins: [
            { name: 'stable-plugin', targetVersion: '1.0.0', contentDigest: stableRecord.contentDigest },
            { name: 'beta-plugin', targetVersion: '2.0.0', contentDigest: `sha256:${'e'.repeat(64)}` },
          ],
        },
      },
      releaseIdentity: {
        generationId: 'generation', outputDigest: 'output', inputDigest: 'input',
        cliPackageDigest: 'package', headCommit: 'b'.repeat(40),
      },
      history,
    };
    const stageCatalogRelease = vi.fn(async (_args, options) => {
      expect(options.previousReleaseLedger.records).toContainEqual(stableRecord);
      expect(options.pluginCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'stable-plugin', action: 'skip' }),
        expect.objectContaining({ name: 'beta-plugin', action: 'publish' }),
      ]));
      return { snapshotDigest: `sha256:${'f'.repeat(64)}` };
    });
    const result = await prepareRelease(['beta'], {
      assertClean: async () => undefined,
      assertFresh: async () => undefined,
      assertTargetsMatchHead: async () => undefined,
      readTargets: async () => observed.targets,
      observe: async () => observed,
      observeRemoteHistory: async () => history,
      materializeCliPlanArtifacts: async (status) => status.cli.packages,
      withPrivateCatalogStageRoot: async (callback) => callback('/tmp/projected-ledger'),
      stageCatalogRelease,
      writePlan: async (releasePlan) => ({ created: true, plan: releasePlan }),
    });
    expect(result.plan?.plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'stable-plugin', action: 'skip' }),
      expect.objectContaining({ name: 'beta-plugin', action: 'publish' }),
    ]));
    expect(stageCatalogRelease).toHaveBeenCalledOnce();
  });

  it('rejects every version argument', () => {
    expect(() => parsePublishPlanArgs(['--catalog-version', '1.0.0'])).toThrow('does not accept');
  });

  it('accepts only the exact committed candidate as a partial or complete retry', () => {
    const releasePlan = plan('atomic-combined');
    expect(() => assertCliRegistryHistoryMatchesPlan(releasePlan, registryWithCandidate([
      '@lesliechan721/agent-skill-eval',
    ], {
      '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
      '@lesliechan721/aw': { latest: null, beta: null },
    }))).not.toThrow();
    expect(() => assertCliRegistryHistoryMatchesPlan(releasePlan, registryWithCandidate([
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ]))).not.toThrow();
  });

  it('rejects wrong plan metadata and unplanned versions in the complete live history', () => {
    const releasePlan = plan('atomic-combined');
    const wrongMetadata = registryWithCandidate(['@lesliechan721/agent-skill-eval']);
    wrongMetadata['@lesliechan721/agent-skill-eval'][0].awRelease = releaseMetadata(
      '@lesliechan721/agent-skill-eval',
      { planId: `sha256:${'f'.repeat(64)}` },
    );
    expect(() => assertCliRegistryHistoryMatchesPlan(releasePlan, wrongMetadata)).toThrow('does not belong');
    expect(() => assertCliRegistryHistoryMatchesPlan(releasePlan, {
      ...EMPTY_REGISTRY,
      '@lesliechan721/agent-skill-eval': [{ version: '1.0.0-beta.2', awRelease: null }],
    })).toThrow('unplanned');
  });

  it.each(['catalog-only', 'bootstrap', 'atomic-combined'] as const)(
    'rejects %s registry drift before entering a publication lease',
    async (publicationMode) => {
      const publishCatalog = vi.fn();
      const bootstrapCatalog = vi.fn();
      const publishCombinedRelease = vi.fn();
      await expect(publishCommittedRelease([], {
        readCurrentReleasePlan: async () => ({ plan: plan(publicationMode) }),
        assertPlanOnlyCommit: async () => undefined,
        runCommand: async () => undefined,
        readRegistryReleaseHistory: async () => ({
          ...EMPTY_REGISTRY,
          '@lesliechan721/agent-skill-eval': [{ version: '1.0.0-beta.2', awRelease: null }],
        }),
        publishCatalog,
        bootstrapCatalog,
        publishCombinedRelease,
        _boundCatalog: {
          internalOutputRoot: '/tmp/catalog', snapshot: {},
          staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
        },
      })).rejects.toThrow('unplanned');
      expect(publishCatalog).not.toHaveBeenCalled();
      expect(bootstrapCatalog).not.toHaveBeenCalled();
      expect(publishCombinedRelease).not.toHaveBeenCalled();
    },
  );

  it.each(['beforeRemoteWrite', 'beforeNpmWrite'] as const)(
    'composes %s and rejects registry drift observed at the write boundary',
    async (boundary) => {
      let registry = EMPTY_REGISTRY;
      const callerBoundary = vi.fn(async () => undefined);
      const publishCombinedRelease = vi.fn(async (_args, options) => {
        registry = {
          ...EMPTY_REGISTRY,
          '@lesliechan721/aw': [{ version: '1.0.0-beta.2', awRelease: null }],
        };
        await options[boundary]('@lesliechan721/aw');
        return { path: 'catalog-first' };
      });
      await expect(publishCommittedRelease([], {
        readCurrentReleasePlan: async () => ({ plan: plan('atomic-combined') }),
        assertPlanOnlyCommit: async () => undefined,
        runCommand: async () => undefined,
        readRegistryReleaseHistory: async () => registry,
        publishCombinedRelease,
        [boundary]: callerBoundary,
        _boundCatalog: {
          internalOutputRoot: '/tmp/catalog', snapshot: {},
          staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
        },
      })).rejects.toThrow('unplanned');
      expect(callerBoundary).toHaveBeenCalledOnce();
    },
  );

  it('always runs the production canonical live identity gate before a publisher write', async () => {
    const fixture = await createIdentityDriftFixture();
    const releasePlan = plan('atomic-combined');
    releasePlan.source.head = fixture.identity.headCommit;
    const callerIdentityHook = vi.fn(async () => undefined);
    const remoteWrite = vi.fn();
    const publishCombinedRelease = vi.fn(async (_args, options) => {
      await options.assertCurrentReleaseIdentity(fixture.snapshot, fixture.identity, {});
      remoteWrite();
      return { path: 'catalog-first' };
    });
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      repoRoot: fixture.root,
      readCurrentReleasePlan: async () => ({ plan: releasePlan }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      assertCurrentReleaseIdentity: callerIdentityHook,
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog',
        snapshot: fixture.snapshot,
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).rejects.toThrow('live inputDigest');
    expect(callerIdentityHook).not.toHaveBeenCalled();
    expect(remoteWrite).not.toHaveBeenCalled();
  });

  it('accepts a verified no-write plan without invoking a publisher', async () => {
    const assertPlanOnlyCommit = vi.fn();
    const publishCatalog = vi.fn();
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: plan('none') }),
      assertPlanOnlyCommit,
      publishCatalog,
    })).resolves.toMatchObject({ path: 'none' });
    expect(assertPlanOnlyCommit).toHaveBeenCalledOnce();
    expect(publishCatalog).not.toHaveBeenCalled();
  });

  it('publishes the CLI train when Catalog mode is none but the CLI axis is publish', async () => {
    const cliOnly = plan('none');
    cliOnly.cli.action = 'publish';
    const publishCli = vi.fn(async () => ({ status: 'published' }));
    const runCommand = vi.fn(async () => undefined);
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: cliOnly }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand,
      publishCli,
    })).resolves.toMatchObject({ path: 'cli-only' });
    expect(publishCli).toHaveBeenCalledWith([
      'beta', '--cli-version', '1.0.0-beta.1',
    ], expect.objectContaining({ beforeNpmWrite: expect.any(Function) }));
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify:cli']);
  });

  it('does not enter a publisher when the required release verification fails', async () => {
    const cliOnly = plan('none');
    cliOnly.cli.action = 'publish';
    const publishCli = vi.fn();
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: cliOnly }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => { throw new Error('verification failed'); },
      publishCli,
    })).rejects.toThrow('verification failed');
    expect(publishCli).not.toHaveBeenCalled();
  });

  it.each([
    ['atomic-combined', 'catalog-first'],
    ['tag-first', 'tag-first'],
  ] as const)('requires the committed %s execution path', async (publicationMode, path) => {
    const publishCombinedRelease = vi.fn(async () => ({ path }));
    const runCommand = vi.fn(async () => undefined);
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: plan(publicationMode) }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand,
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).resolves.toMatchObject({ path, planId: `sha256:${'a'.repeat(64)}` });
    expect(publishCombinedRelease).toHaveBeenCalledWith([
      'beta', '--catalog-version', '2.0.0-beta.1', '--cli-version', '1.0.0-beta.1',
    ], expect.objectContaining({
      remoteUrl: OFFICIAL_CATALOG_PUBLISH_REMOTE,
      resolveReleaseHead: expect.any(Function),
    }));
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify']);
  });

  it('uses the production command runner for Eval and AW while suppressing nested verification', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-plan-command-fallback-'));
    temporaryRoots.push(root);
    const binRoot = path.join(root, 'bin');
    const cliPackageRoot = path.join(root, 'cli');
    const commandLog = path.join(root, 'commands.log');
    await Promise.all([
      fs.mkdir(binRoot),
      fs.mkdir(cliPackageRoot),
    ]);
    const fakePnpm = path.join(binRoot, 'pnpm');
    await fs.writeFile(fakePnpm, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.appendFileSync(process.env.AW_TEST_COMMAND_LOG, `${process.argv.slice(2).join(' ')}\\n`);",
    ].join('\n'));
    await fs.chmod(fakePnpm, 0o755);
    await fs.writeFile(path.join(cliPackageRoot, 'package.json'), JSON.stringify({
      name: '@lesliechan721/aw', version: '1.0.0-beta.1',
    }));
    vi.stubEnv('PATH', `${binRoot}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('AW_TEST_COMMAND_LOG', commandLog);
    vi.stubEnv('npm_config_user_agent', 'fixture');
    vi.stubEnv('npm_execpath', '');

    const snapshot = {
      cliPackageRoot,
      generationId: 'generation',
      outputDigest: 'output',
      inputDigest: 'input',
      cliPackageDigest: 'package',
    };
    const publishCombinedRelease = async (_args: string[], nestedOptions: {
      runCommand: (
        command: string, args: string[], options?: Record<string, unknown>,
      ) => Promise<unknown>;
    }) => {
      await nestedOptions.runCommand('pnpm', ['run', 'release:verify']);
      await nestedOptions.runCommand('pnpm', ['run', 'release:verify:cli']);
      const evalPublication = await publishPreparedEvalPublication({
        status: 'publish',
        mode: 'beta',
        version: '1.0.0-beta.1',
        tarballPath: path.join(root, 'eval.tgz'),
        registryUrl: 'https://registry.example.test/',
        gitCheckArgs: [],
        candidateTreeDigest: EVAL_DIGEST,
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
        inputDigest: snapshot.inputDigest,
      }, async () => undefined);
      await publishCli(['beta', '--cli-version', '1.0.0-beta.1'], {
        snapshot,
        expectedVersion: '1.0.0-beta.1',
        readCliPackageJson: async () => ({ version: '1.0.0-beta.1' }),
        resolveReleaseHead: async () => 'b'.repeat(40),
        assertCurrentReleaseIdentity: async () => undefined,
        publicationLease: {},
        publishedVersion: '0.9.0-beta.1',
        cliPublication: {
          status: 'publish', mode: 'beta', version: '1.0.0-beta.1',
          tarballPath: path.join(root, 'aw.tgz'),
          registryUrl: 'https://registry.example.test/',
          candidateTreeDigest: AW_DIGEST,
          generationId: snapshot.generationId,
          outputDigest: snapshot.outputDigest,
          inputDigest: snapshot.inputDigest,
          cliPackageDigest: snapshot.cliPackageDigest,
        },
        evalPublication,
        resolveCliPublishGitCheckArgs: async () => [],
        runCommand: nestedOptions.runCommand,
        skipVerify: true,
      });
      return { path: 'tag-first' };
    };

    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: plan('tag-first') }),
      assertPlanOnlyCommit: async () => undefined,
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot,
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).resolves.toMatchObject({ path: 'tag-first' });

    const commands = (await fs.readFile(commandLog, 'utf8')).trim().split('\n');
    expect(commands.filter((entry) => entry === 'run release:verify')).toHaveLength(1);
    expect(commands.some((entry) => /^publish .*eval\.tgz/u.test(entry))).toBe(true);
    expect(commands.some((entry) => /^publish .*aw\.tgz/u.test(entry))).toBe(true);
  });

  it('injects no stable baseline only for the strictly bound legacy latest history', async () => {
    const releasePlan = legacyStablePlan();
    const publishCombinedRelease = vi.fn(async (_args, nestedOptions) => {
      expect(nestedOptions.publishedVersion).toBeNull();
      return { path: 'tag-first' };
    });
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: releasePlan }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => registryFromTestPlan(releasePlan),
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).resolves.toMatchObject({ path: 'tag-first' });
    expect(publishCombinedRelease).toHaveBeenCalledOnce();

    const wrongLegacy = legacyStablePlan();
    wrongLegacy.history.npm.distTags[1].latest = '0.1.0-beta.2';
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: wrongLegacy }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => registryFromTestPlan(wrongLegacy),
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).rejects.toThrow(/legacyLatestAwOnly|latest dist-tag/u);
  });

  it('retries the same first-stable plan after Eval succeeds and AW fails', async () => {
    const releasePlan = legacyStablePlan();
    const registry = registryFromTestPlan(releasePlan);
    const calls: string[] = [];
    const candidateMetadata = (packageName: string) => releaseMetadata(packageName, {
      candidateVersion: '1.0.0',
      planId: releasePlan.planId,
      sourceHead: releasePlan.source.head,
    });
    let attempt = 0;
    const publishCombinedRelease = vi.fn(async (_args, nestedOptions) => {
      attempt += 1;
      if (attempt === 1) {
        await nestedOptions.evalPublicationOptions.beforeNpmWrite();
        registry['@lesliechan721/agent-skill-eval'].push({
          version: '1.0.0',
          awRelease: candidateMetadata('@lesliechan721/agent-skill-eval'),
        });
        registry.distTags['@lesliechan721/agent-skill-eval'].latest = '1.0.0';
        calls.push('eval');
        await nestedOptions.beforeNpmWrite();
        throw new Error('injected AW publish failure');
      }
      await nestedOptions.beforeNpmWrite();
      registry['@lesliechan721/aw'].push({
        version: '1.0.0',
        awRelease: candidateMetadata('@lesliechan721/aw'),
      });
      registry.distTags['@lesliechan721/aw'].latest = '1.0.0';
      calls.push('aw');
      nestedOptions.assertPromotionRegistryFresh(registry);
      calls.push('promotion');
      return { path: 'tag-first' };
    });
    const options = {
      readCurrentReleasePlan: async () => ({ plan: releasePlan }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => structuredClone(registry),
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    };

    await expect(publishCommittedRelease([], options)).rejects.toThrow('AW publish failure');
    expect(registry.distTags).toMatchObject({
      '@lesliechan721/agent-skill-eval': { latest: '1.0.0' },
      '@lesliechan721/aw': { latest: '0.1.0-beta.1' },
    });
    await expect(publishCommittedRelease([], options)).resolves.toMatchObject({ path: 'tag-first' });
    expect(calls).toEqual(['eval', 'aw', 'promotion']);
  });

  it('uses the real combined and CLI gates when first-stable npm acceptance outlives the client call', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-first-stable-exact-retry-'));
    temporaryRoots.push(root);
    const cliPackageRoot = path.join(root, 'cli');
    const evalPackageRoot = path.join(root, 'eval');
    await Promise.all([fs.mkdir(cliPackageRoot), fs.mkdir(evalPackageRoot)]);
    await Promise.all([
      fs.writeFile(path.join(cliPackageRoot, 'package.json'), JSON.stringify({
        name: '@lesliechan721/aw', version: '1.0.0',
        publishConfig: { registry: 'https://registry.example.test/' },
      })),
      fs.writeFile(path.join(evalPackageRoot, 'package.json'), JSON.stringify({
        name: '@lesliechan721/agent-skill-eval', version: '1.0.0',
        publishConfig: { registry: 'https://registry.example.test/' },
      })),
    ]);
    const releasePlan = legacyStablePlan();
    const registry = registryFromTestPlan(releasePlan);
    const snapshot = {
      generationId: 'generation', outputDigest: 'output', inputDigest: 'input',
      cliPackageDigest: 'package', cliPackageRoot, evalPackageRoot,
    };
    const releaseIdentity = { ...snapshot, headCommit: releasePlan.source.head };
    const staged = {
      outputRoot: root,
      ...snapshot,
      releaseIdentity,
      snapshotDigest: `sha256:${'e'.repeat(64)}`,
      manifest: { compatibility: { aw: { minVersion: '0.1.0-beta.3' } } },
    };
    const candidateMetadata = (packageName: string) => releaseMetadata(packageName, {
      candidateVersion: '1.0.0',
      planId: releasePlan.planId,
      sourceHead: releasePlan.source.head,
    });
    const packageDigest = (packageName: string) =>
      packageName === '@lesliechan721/agent-skill-eval' ? EVAL_DIGEST : AW_DIGEST;
    const npmWrites: string[] = [];
    let tagPublished = false;
    let promoted = false;
    let failAfterAwAcceptance = true;
    let rejectPublishedTarball = false;
    const recordAcceptedPublish = (packageName: '@lesliechan721/agent-skill-eval' | '@lesliechan721/aw') => {
      npmWrites.push(packageName);
      registry[packageName].push({
        version: '1.0.0', awRelease: candidateMetadata(packageName),
      });
      registry.distTags[packageName].latest = '1.0.0';
    };
    const readCatalogPublicationHistory = async () => ({
      channels: { latest: promoted ? { commit: 'c'.repeat(40) } : null, beta: null },
      tag: tagPublished ? {
        commit: 'c'.repeat(40),
        catalogContentDigest: releasePlan.catalog.catalogContentDigest,
        snapshotDigest: releasePlan.catalog.snapshotDigest,
        manifest: {
          schemaVersion: 4,
          catalogVersion: releasePlan.catalog.candidateVersion,
          release: {
            state: 'published', targetVersion: releasePlan.catalog.targetVersion,
            planId: releasePlan.planId, sourceHead: releasePlan.source.head,
            contentDigest: releasePlan.catalog.catalogContentDigest,
          },
        },
        ledger: { schemaVersion: 2, records: [] },
      } : null,
      pending: tagPublished && !promoted ? 'c'.repeat(40) : null,
      mergedLedger: { schemaVersion: 2, records: [] },
      catalogModules: {
        pluginStaging: {
          compareStrictSemVer: (left: string, right: string) =>
            left === right ? 0 : left === '0.1.0-beta.3' ? -1 : 1,
        },
      },
    });
    const isExactPackageVersionPublished = async (packageName: keyof typeof registry, version: string) =>
      Array.isArray(registry[packageName])
      && registry[packageName].some((entry) => entry.version === version);
    const assertPublishedPackageTarballMatchesCandidate = async (packageName: string) => {
      if (rejectPublishedTarball) throw new Error('published tarball differs from candidate');
      return {
        registryUrl: 'https://registry.example.test/',
        candidateTreeDigest: packageDigest(packageName),
        publishedTreeDigest: packageDigest(packageName),
      };
    };
    const options = {
      repoRoot: root,
      readCurrentReleasePlan: async () => ({ plan: releasePlan }),
      assertPlanOnlyCommit: async () => undefined,
      canonicalAssertCurrentReleaseIdentity: async () => undefined,
      assertReleaseWorktreeClean: async () => undefined,
      runCommand: async (_command: string, args: string[]) => {
        if (args[0] !== 'publish') return;
        recordAcceptedPublish('@lesliechan721/aw');
        if (failAfterAwAcceptance) {
          failAfterAwAcceptance = false;
          throw new Error('registry accepted AW before client timeout');
        }
      },
      evalPublicationOptions: {
        withPrivateEvalTarball: async (_snapshot: unknown, callback: (tarball: string) => unknown) =>
          callback(path.join(root, 'eval.tgz')),
        computePackageTarballTreeDigest: async () => EVAL_DIGEST,
        isExactPackageVersionPublished,
        assertPublishedPackageTarballMatchesCandidate,
        runCommand: async () => recordAcceptedPublish('@lesliechan721/agent-skill-eval'),
      },
      cliPublicationOptions: {
        withPrivateCliTarball: async (_snapshot: unknown, callback: (tarball: string) => unknown) =>
          callback(path.join(root, 'aw.tgz')),
        computePackageTarballTreeDigest: async () => AW_DIGEST,
        isExactPackageVersionPublished,
        assertPublishedPackageTarballMatchesCandidate,
      },
      readRegistryReleaseHistory: async () => structuredClone(registry),
      readCatalogPublicationHistory,
      withCatalogPublicationLease: async (_remote: string, callback: (lease: object) => unknown) => callback({}),
      publishStagedCatalog: async () => {
        const idempotent = tagPublished;
        tagPublished = true;
        return { idempotent, promoted: false };
      },
      promoteCatalogTag: async (promotionOptions: {
        beforeAcquire: () => Promise<unknown>;
        beforeRemoteWrite: () => Promise<unknown>;
      }) => {
        await promotionOptions.beforeAcquire();
        await promotionOptions.beforeRemoteWrite();
        promoted = true;
        return { promoted: true };
      },
      resolveCliPublishGitCheckArgs: async () => [],
      _boundCatalog: { internalOutputRoot: root, snapshot, staged },
    };

    await expect(publishCommittedRelease([], options)).rejects.toThrow('channel was not promoted');
    expect(npmWrites).toEqual([
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ]);
    expect(promoted).toBe(false);

    rejectPublishedTarball = true;
    await expect(publishCommittedRelease([], options)).rejects.toThrow('published tarball differs');
    expect(npmWrites).toHaveLength(2);
    expect(promoted).toBe(false);

    rejectPublishedTarball = false;
    await expect(publishCommittedRelease([], options)).resolves.toMatchObject({
      path: 'tag-first', cli: { status: 'already-published' }, promotion: { promoted: true },
    });
    expect(npmWrites).toHaveLength(2);
    expect(promoted).toBe(true);
  });

  it('runs bootstrap only from the committed candidate without public version arguments', async () => {
    const bootstrapCatalog = vi.fn(async () => ({ idempotent: false, commit: 'catalog' }));
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: plan('bootstrap') }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      bootstrapCatalog,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).resolves.toMatchObject({ path: 'bootstrap' });
    expect(bootstrapCatalog).toHaveBeenCalledWith([
      'beta', '--catalog-version', '2.0.0-beta.1',
    ], expect.any(Object));
  });

  it('rejects a rebuilt Catalog tree before the catalog publisher can write', async () => {
    const publishCatalog = vi.fn(async (_args, options) => {
      await options.stageCatalogRelease([], {});
    });
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: plan('catalog-only') }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      publishCatalog,
      stageCatalogRelease: async () => ({ snapshotDigest: `sha256:${'f'.repeat(64)}` }),
      withPrivateCatalogStageRoot: async (callback) => callback('/tmp/catalog'),
      withReleaseBuildSnapshot: async (callback) => callback({
        generationId: 'g', outputDigest: 'o', inputDigest: 'i', cliPackageDigest: 'c',
      }),
      readCatalogPublicationHistory: async () => ({
        channels: { latest: null, beta: null }, tag: null, pending: null,
        mergedLedger: { schemaVersion: 2, records: [] },
      }),
    })).rejects.toThrow('snapshotDigest does not match');
    expect(publishCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ['missing Eval tag', { eval: null, aw: '1.0.0-beta.1' }],
    ['different package tags', { eval: '1.0.0-beta.1', aw: '1.0.0-beta.2' }],
    ['plan tag drift', { eval: '1.0.0-beta.2', aw: '1.0.0-beta.2' }],
  ])('rejects promotion for %s', async (_label, tags) => {
    const promotionPlan = plan('promotion');
    await expect(assertPromotionCliTrain(promotionPlan, {
      readRegistryReleaseHistory: async () => ({
        '@lesliechan721/agent-skill-eval': [],
        '@lesliechan721/aw': [],
        distTags: {
          '@lesliechan721/agent-skill-eval': { latest: null, beta: tags.eval },
          '@lesliechan721/aw': { latest: null, beta: tags.aw },
        },
      }),
    })).rejects.toThrow(/Promotion|dist-tags/u);
  });

  it('rejects promotion when the complete bound CLI train is below the Catalog floor', async () => {
    const promotionPlan = plan('promotion');
    promotionPlan.catalog.minCliVersion = '1.0.0';
    await expect(assertPromotionCliTrain(promotionPlan, {
      readRegistryReleaseHistory: async () => ({
        '@lesliechan721/agent-skill-eval': [],
        '@lesliechan721/aw': [],
        distTags: {
          '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
          '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
        },
      }),
    })).rejects.toThrow('below Catalog minimum');
  });

  it('rechecks both bound CLI dist-tags immediately before promotion writes', async () => {
    let registryReads = 0;
    const promotionPlan = bindPublishedCandidate(plan('promotion'));
    const runCommand = vi.fn(async () => undefined);
    const promoteCatalogTag = vi.fn(async (options) => {
      await options.beforeAcquire();
      await options.beforeRemoteWrite();
      return { promoted: true };
    });
    await expect(publishCommittedRelease([], {
      ...freshRegistryOptions,
      readCurrentReleasePlan: async () => ({ plan: promotionPlan }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand,
      readRegistryReleaseHistory: async () => {
        registryReads += 1;
        return registryWithCandidate([
          '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
        ], {
          '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
          '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
        });
      },
      readCatalogPublicationHistory: async () => promotionCatalogHistory(),
      promoteCatalogTag,
    })).resolves.toMatchObject({ path: 'promotion' });
    expect(runCommand).toHaveBeenCalledWith('pnpm', ['run', 'release:verify:catalog']);
    expect(registryReads).toBe(3);
  });

  it('rejects complete registry drift before the promotion lease can write its lock', async () => {
    let registry = registryWithCandidate([
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ], {
      '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
      '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
    });
    const publicationLockPush = vi.fn();
    const promoteCatalogTag = vi.fn(async (options) => {
      registry = {
        ...registry,
        '@lesliechan721/aw': [
          ...registry['@lesliechan721/aw'],
          {
            version: '1.0.0-beta.2',
            awRelease: releaseMetadata('@lesliechan721/aw', {
              candidateVersion: '1.0.0-beta.2',
            }),
          },
        ],
      };
      await options.beforeAcquire();
      publicationLockPush();
      return { promoted: true };
    });

    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: bindPublishedCandidate(plan('promotion')) }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => registry,
      readCatalogPublicationHistory: async () => promotionCatalogHistory(),
      promoteCatalogTag,
    })).rejects.toThrow('unplanned');
    expect(publicationLockPush).not.toHaveBeenCalled();
  });

  it('rejects a second registry drift at the promotion remote-write boundary', async () => {
    let registry = registryWithCandidate([
      '@lesliechan721/agent-skill-eval', '@lesliechan721/aw',
    ], {
      '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
      '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
    });
    const channelPush = vi.fn();
    const promoteCatalogTag = vi.fn(async (options) => {
      await options.beforeAcquire();
      registry = {
        ...registry,
        '@lesliechan721/agent-skill-eval': [
          ...registry['@lesliechan721/agent-skill-eval'],
          {
            version: '1.0.0-beta.2',
            awRelease: releaseMetadata('@lesliechan721/agent-skill-eval', {
              candidateVersion: '1.0.0-beta.2',
            }),
          },
        ],
      };
      await options.beforeRemoteWrite();
      channelPush();
      return { promoted: true };
    });

    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: bindPublishedCandidate(plan('promotion')) }),
      assertPlanOnlyCommit: async () => undefined,
      runCommand: async () => undefined,
      readRegistryReleaseHistory: async () => registry,
      readCatalogPublicationHistory: async () => promotionCatalogHistory(),
      promoteCatalogTag,
    })).rejects.toThrow('unplanned');
    expect(channelPush).not.toHaveBeenCalled();
  });
});
