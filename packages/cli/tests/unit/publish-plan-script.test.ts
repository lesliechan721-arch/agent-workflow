import { describe, expect, it, vi } from 'vitest';

import {
  assertPromotionCliTrain,
  parsePublishPlanArgs,
  publishCommittedRelease,
} from '../../../../scripts/release/publish-plan.mjs';
import { materializeCatalogPlanArtifact } from '../../../../scripts/release/release-prepare.mjs';

function plan(publicationMode: 'none' | 'catalog-only' | 'atomic-combined' | 'tag-first' | 'promotion') {
  return {
    planId: `sha256:${'a'.repeat(64)}`,
    channel: 'beta',
    source: { head: 'b'.repeat(40) },
    history: {
      catalog: { latest: null, beta: null, publicationGuard: null },
    },
    cli: {
      targetVersion: '1.0.0',
      candidateVersion: '1.0.0-beta.1',
      action: ['catalog-only', 'bootstrap', 'promotion', 'none'].includes(publicationMode) ? 'skip' : 'publish',
      trainContentDigest: `sha256:${'c'.repeat(64)}`,
      packages: [],
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

  it('accepts a verified no-write plan without invoking a publisher', async () => {
    const assertPlanOnlyCommit = vi.fn();
    const publishCatalog = vi.fn();
    await expect(publishCommittedRelease([], {
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
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: cliOnly }),
      assertPlanOnlyCommit: async () => undefined,
      publishCli,
    })).resolves.toMatchObject({ path: 'cli-only' });
    expect(publishCli).toHaveBeenCalledWith([
      'beta', '--cli-version', '1.0.0-beta.1',
    ], expect.objectContaining({ beforeNpmWrite: expect.any(Function) }));
  });

  it.each([
    ['atomic-combined', 'catalog-first'],
    ['tag-first', 'tag-first'],
  ] as const)('requires the committed %s execution path', async (publicationMode, path) => {
    const publishCombinedRelease = vi.fn(async () => ({ path }));
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: plan(publicationMode) }),
      assertPlanOnlyCommit: async () => undefined,
      publishCombinedRelease,
      _boundCatalog: {
        internalOutputRoot: '/tmp/catalog', snapshot: {},
        staged: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      },
    })).resolves.toMatchObject({ path, planId: `sha256:${'a'.repeat(64)}` });
    expect(publishCombinedRelease).toHaveBeenCalledWith([
      'beta', '--catalog-version', '2.0.0-beta.1', '--cli-version', '1.0.0-beta.1',
    ], expect.objectContaining({ resolveReleaseHead: expect.any(Function) }));
  });

  it('runs bootstrap only from the committed candidate without public version arguments', async () => {
    const bootstrapCatalog = vi.fn(async () => ({ idempotent: false, commit: 'catalog' }));
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: plan('bootstrap') }),
      assertPlanOnlyCommit: async () => undefined,
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
      readCurrentReleasePlan: async () => ({ plan: plan('catalog-only') }),
      assertPlanOnlyCommit: async () => undefined,
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
    const promoteCatalogTag = vi.fn(async (options) => {
      await options.beforeRemoteWrite();
      return { promoted: true };
    });
    await expect(publishCommittedRelease([], {
      readCurrentReleasePlan: async () => ({ plan: plan('promotion') }),
      assertPlanOnlyCommit: async () => undefined,
      readRegistryReleaseHistory: async () => {
        registryReads += 1;
        return {
          '@lesliechan721/agent-skill-eval': [],
          '@lesliechan721/aw': [],
          distTags: {
            '@lesliechan721/agent-skill-eval': { latest: null, beta: '1.0.0-beta.1' },
            '@lesliechan721/aw': { latest: null, beta: '1.0.0-beta.1' },
          },
        };
      },
      readCatalogPublicationHistory: async () => ({
        tag: { snapshotDigest: `sha256:${'e'.repeat(64)}` },
      }),
      promoteCatalogTag,
    })).resolves.toMatchObject({ path: 'promotion' });
    expect(registryReads).toBe(2);
  });
});
