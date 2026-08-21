import { describe, expect, it, vi } from 'vitest';

import {
  assertCliRegistryHistoryMatchesPlan,
  assertPromotionCliTrain,
  parsePublishPlanArgs,
  publishCommittedRelease,
} from '../../../../scripts/release/publish-plan.mjs';
import { OFFICIAL_CATALOG_PUBLISH_REMOTE } from '../../../../scripts/release/git-catalog-publisher.mjs';
import { materializeCatalogPlanArtifact } from '../../../../scripts/release/release-prepare.mjs';
import { calculateCliTrainContentDigest } from '../../../../scripts/release/release-model.mjs';

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
  return releasePlan;
}

function promotionCatalogHistory() {
  return {
    channels: { latest: null, beta: null },
    tag: {
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
    pending: null,
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
    expect(registryReads).toBe(5);
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
