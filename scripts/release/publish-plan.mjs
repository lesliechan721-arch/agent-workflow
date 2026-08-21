import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseWorktreeClean,
  compareReleaseSemVer,
  createReleaseSnapshotIdentity,
  repoRoot as defaultRepoRoot,
  stampReleaseCandidateSnapshot,
  withPrivateCatalogStageRoot,
  withReleaseBuildSnapshot,
} from './common.mjs';
import { publishCatalog } from './publish-catalog.mjs';
import { bootstrapCatalog } from './bootstrap-catalog.mjs';
import { publishRelease as publishCombinedRelease } from './publish-release.mjs';
import { promoteCatalogTag } from './git-catalog-publisher.mjs';
import {
  assertPlanOnlyCommit,
  readCurrentReleasePlan,
} from './release-plan.mjs';
import { readCliReleaseContent } from './release-observe.mjs';
import { readRegistryReleaseHistory } from './release-observe.mjs';
import { CLI_PACKAGES, normalizeCliRegistryHistory } from './release-state.mjs';
import { resolveCatalogStageLedger } from './git-catalog-publisher.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

function assertCatalogHistoryAllowed(plan, history) {
  const plannedMode = publicationMode(plan);
  for (const mode of ['latest', 'beta']) {
    const expected = plan.history.catalog[mode];
    const actual = history.channels?.[mode] ?? null;
    if ((actual?.commit ?? null) === (expected?.commit ?? null)) continue;
    const isPlannedPublication = mode === plannedMode
      && actual?.manifest?.release?.state === 'published'
      && actual.manifest.release.planId === plan.planId;
    if (!isPlannedPublication) {
      throw new Error(`Catalog ${mode} history changed after the release plan was committed.`);
    }
  }
  const plannedGuard = plan.history.catalog.publicationGuard;
  const actualGuard = history.pending ?? null;
  const plannedTag = history.tag?.manifest?.release?.state === 'published'
    && history.tag.manifest.release.planId === plan.planId;
  if (actualGuard !== plannedGuard && !(plannedTag && actualGuard === history.tag.commit)) {
    throw new Error('Catalog publication guard changed after the release plan was committed.');
  }
  if (
    plannedTag
    && actualGuard === null
    && history.channels?.[plannedMode]?.commit !== history.tag.commit
  ) {
    throw new Error('Catalog tag is ahead without the exact plan pending guard.');
  }
  return history;
}

export function parsePublishPlanArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 0) throw new Error('release:publish does not accept version arguments.');
  return {};
}

function publicationMode(plan) {
  return plan.channel === 'beta' ? 'beta' : 'latest';
}

function pluginVersionOverrides(plan) {
  return Object.fromEntries(plan.plugins.map((plugin) => {
    if (plugin.candidateVersion === null) {
      throw new Error(`Release plan plugin ${plugin.name} does not have an executable candidate.`);
    }
    return [plugin.name, plugin.candidateVersion];
  }));
}

function catalogReleaseIdentity(plan) {
  return {
    state: 'published',
    targetVersion: plan.catalog.targetVersion,
    planId: plan.planId,
    sourceHead: plan.source.head,
    contentDigest: plan.catalog.catalogContentDigest,
  };
}

export async function assertPromotionCliTrain(plan, options = {}) {
  const registry = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  const normalized = normalizeCliRegistryHistory(registry);
  const tag = plan.channel === 'beta' ? 'beta' : 'latest';
  const versions = CLI_PACKAGES.map((name) => normalized.distTags[name][tag]);
  if (versions.some((version) => version === null) || versions[0] !== versions[1]) {
    throw new Error(`Promotion requires matching ${tag} dist-tags for the complete CLI train.`);
  }
  if (versions[0] !== plan.cli.candidateVersion) {
    throw new Error(`Promotion CLI train ${tag} dist-tags changed after the release plan was committed.`);
  }
  if (compareReleaseSemVer(versions[0], plan.catalog.minCliVersion) < 0) {
    throw new Error(`Promotion CLI train ${versions[0]} is below Catalog minimum ${plan.catalog.minCliVersion}.`);
  }
  return versions[0];
}

export async function assertPlanCliRegistryFresh(plan, options = {}) {
  const registry = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  const normalized = normalizeCliRegistryHistory(registry);
  const tag = plan.channel === 'beta' ? 'beta' : 'latest';
  for (const expected of plan.cli.packages) {
    const packageEntries = normalized.packages.get(expected.name);
    const exact = packageEntries.find((entry) => entry.candidateVersion === plan.cli.candidateVersion);
    if (exact && (
      exact.metadata?.planId !== plan.planId
      || exact.metadata.packageContentDigest !== expected.contentDigest
    )) {
      throw new Error(`Published ${expected.name}@${plan.cli.candidateVersion} does not belong to this release plan.`);
    }
    const originalTag = plan.history.npm.distTags.find((entry) => entry.name === expected.name)?.[tag] ?? null;
    const liveTag = normalized.distTags[expected.name][tag];
    if (liveTag !== originalTag && liveTag !== plan.cli.candidateVersion) {
      throw new Error(`${expected.name} ${tag} dist-tag changed outside the committed release plan.`);
    }
    if (liveTag && compareReleaseSemVer(liveTag, plan.cli.candidateVersion) > 0) {
      throw new Error(`${expected.name} ${tag} dist-tag is ahead of the committed candidate.`);
    }
  }
  return registry;
}

async function createStampedSnapshotRunner(plan, assertFresh, options) {
  return async (callback) => (options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot)(
    async (snapshot) => {
      if (plan.cli.action === 'publish') {
        const content = Object.fromEntries(plan.cli.packages.map((entry) => [entry.name, entry.contentDigest]));
        await (options.stampReleaseCandidateSnapshot ?? stampReleaseCandidateSnapshot)(snapshot, {
          targetVersion: plan.cli.targetVersion,
          candidateVersion: plan.cli.candidateVersion,
          planId: plan.planId,
          sourceHead: plan.source.head,
          packageContentDigest: content['@lesliechan721/aw'],
          evalPackageContentDigest: content['@lesliechan721/agent-skill-eval'],
          cliPackageContentDigest: content['@lesliechan721/aw'],
          trainContentDigest: plan.cli.trainContentDigest,
        });
        const artifacts = await (options.readCliReleaseContent ?? readCliReleaseContent)(snapshot, options);
        for (const expected of plan.cli.packages) {
          const actual = artifacts.packages.find((entry) => entry.name === expected.name);
          if (
            !actual
            || actual.contentDigest !== expected.contentDigest
            || actual.tarballDigest !== expected.tarballDigest
          ) throw new Error(`Rebuilt ${expected.name} artifact does not match the committed release plan.`);
        }
      }
      await assertFresh();
      return callback(snapshot);
    },
    { repoRoot: options.repoRoot ?? defaultRepoRoot },
  );
}

export async function publishCommittedRelease(argv = process.argv.slice(2), options = {}) {
  parsePublishPlanArgs(argv);
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { plan } = await (options.readCurrentReleasePlan ?? readCurrentReleasePlan)({ repoRoot });
  const assertPlan = options.assertPlanOnlyCommit ?? assertPlanOnlyCommit;
  const assertFresh = async () => {
    await assertPlan(plan, { repoRoot, ...(options.planCommitOptions ?? {}) });
  };
  await assertFresh();
  const mode = publicationMode(plan);
  if (plan.catalog.publicationMode === 'none' && plan.cli.action !== 'publish') {
    return { path: 'none', planId: plan.planId };
  }
  const snapshotRunner = await createStampedSnapshotRunner(plan, assertFresh, options);
  if (
    !options._boundCatalog
    && !['none', 'promotion'].includes(plan.catalog.publicationMode)
  ) {
    return (options.withPrivateCatalogStageRoot ?? withPrivateCatalogStageRoot)(
      async (internalOutputRoot) => snapshotRunner(async (snapshot) => {
        const readHistory = options.readCatalogPublicationHistory
          ?? (await import('./git-catalog-publisher.mjs')).readCatalogPublicationHistory;
        const history = assertCatalogHistoryAllowed(plan, await readHistory({
          mode,
          catalogVersion: plan.catalog.candidateVersion,
          ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
          ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
        }));
        const releaseIdentity = createReleaseSnapshotIdentity(snapshot, plan.source.head);
        const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
          '--catalog-version', plan.catalog.candidateVersion,
        ], {
          internalOutputRoot,
          previousReleaseLedger: resolveCatalogStageLedger(history),
          snapshot,
          releaseIdentity,
          pluginVersionOverrides: pluginVersionOverrides(plan),
          pluginCandidates: plan.plugins.map((plugin) => ({
            name: plugin.name,
            targetVersion: plugin.targetVersion,
            candidateVersion: plugin.candidateVersion,
            contentDigest: plugin.contentDigest,
            action: plugin.action,
          })),
          catalogRelease: catalogReleaseIdentity(plan),
          ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
        });
        if (staged.snapshotDigest !== plan.catalog.snapshotDigest) {
          throw new Error('Rebuilt Catalog snapshotDigest does not match the committed release plan.');
        }
        return publishCommittedRelease([], {
          ...options,
          readCurrentReleasePlan: async () => ({ plan }),
          _boundCatalog: { internalOutputRoot, snapshot, releaseIdentity, staged },
        });
      }),
    );
  }
  const boundCatalog = options._boundCatalog;
  const commonOptions = {
    ...options,
    repoRoot,
    withReleaseBuildSnapshot: boundCatalog
      ? async (callback) => callback(boundCatalog.snapshot)
      : snapshotRunner,
    ...(boundCatalog ? {
      withPrivateCatalogStageRoot: async (callback) => callback(boundCatalog.internalOutputRoot),
    } : {}),
    assertReleaseWorktreeClean: async () => {
      await (options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean)({ cwd: repoRoot });
      await assertFresh();
    },
    assertCurrentReleaseIdentity: assertFresh,
    resolveReleaseHead: async () => plan.source.head,
    readCliPackageJson: async () => ({ version: plan.cli.candidateVersion }),
    expectedPublicationMode: plan.catalog.publicationMode,
    beforeNpmWrite: async () => {
      await assertFresh();
      await assertPlanCliRegistryFresh(plan, options);
    },
    evalPublicationOptions: {
      ...(options.evalPublicationOptions ?? {}),
      beforeNpmWrite: async () => {
        await assertFresh();
        await assertPlanCliRegistryFresh(plan, options);
      },
    },
    readCatalogPublicationHistory: async (historyOptions) => {
      const readHistory = options.readCatalogPublicationHistory
        ?? (await import('./git-catalog-publisher.mjs')).readCatalogPublicationHistory;
      return assertCatalogHistoryAllowed(plan, await readHistory(historyOptions));
    },
    stageCatalogRelease: async (stageArgs, stageOptions) => boundCatalog?.staged ?? (
      options.stageCatalogRelease ?? stageCatalogRelease
    )(stageArgs, {
      ...stageOptions,
      ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
      pluginVersionOverrides: pluginVersionOverrides(plan),
      pluginCandidates: plan.plugins.map((plugin) => ({
        name: plugin.name,
        targetVersion: plugin.targetVersion,
        candidateVersion: plugin.candidateVersion,
        contentDigest: plugin.contentDigest,
        action: plugin.action,
      })),
      catalogRelease: catalogReleaseIdentity(plan),
    }).then((staged) => {
      if (staged.snapshotDigest !== plan.catalog.snapshotDigest) {
        throw new Error('Rebuilt Catalog snapshotDigest does not match the committed release plan.');
      }
      return staged;
    }),
    runCommand: async (command, args) => {
      if (command === 'pnpm' && (
        args.join(' ') === 'run release:verify'
        || args.join(' ') === 'run release:verify:catalog'
      )) return;
      throw new Error('Unexpected top-level release command.');
    },
  };
  if (plan.catalog.publicationMode === 'none' && plan.cli.action === 'publish') {
    const cli = await (options.publishCli ?? (await import('./publish-cli.mjs')).publishCli)([
      mode, '--cli-version', plan.cli.candidateVersion,
    ], {
      ...commonOptions,
      expectedVersion: plan.cli.candidateVersion,
      skipVerify: true,
    });
    return { path: 'cli-only', planId: plan.planId, cli };
  }
  if (plan.catalog.publicationMode === 'promotion') {
    await assertFresh();
    const currentCliVersion = await assertPromotionCliTrain(plan, options);
    const readHistory = options.readCatalogPublicationHistory
      ?? (await import('./git-catalog-publisher.mjs')).readCatalogPublicationHistory;
    const promotionHistory = await readHistory({
      mode,
      catalogVersion: plan.catalog.candidateVersion,
      ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
      ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
    });
    if (promotionHistory.tag?.snapshotDigest !== plan.catalog.snapshotDigest) {
      throw new Error('Promotion tag snapshotDigest does not match the committed release plan.');
    }
    const promotion = await (options.promoteCatalogTag ?? promoteCatalogTag)({
      mode,
      catalogVersion: plan.catalog.candidateVersion,
      currentCliVersion,
      beforeRemoteWrite: async () => {
        await assertFresh();
        await assertPromotionCliTrain(plan, options);
      },
      ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
    });
    return { path: 'promotion', planId: plan.planId, promotion };
  }
  if (plan.catalog.publicationMode === 'catalog-only') {
    const catalog = await (options.publishCatalog ?? publishCatalog)([
      mode, '--catalog-version', plan.catalog.candidateVersion,
    ], commonOptions);
    return { path: 'catalog-only', planId: plan.planId, catalog };
  }
  if (plan.catalog.publicationMode === 'bootstrap') {
    const { remoteUrl: ignoredRemoteUrl, ...bootstrapOptions } = commonOptions;
    const catalog = await (options.bootstrapCatalog ?? bootstrapCatalog)([
      mode, '--catalog-version', plan.catalog.candidateVersion,
    ], {
      ...bootstrapOptions,
      ...(options.remoteUrl ? { testRemoteUrl: options.remoteUrl } : {}),
    });
    return { path: 'bootstrap', planId: plan.planId, catalog };
  }
  const catalogVersion = plan.catalog.candidateVersion;
  const cliVersion = plan.cli.candidateVersion;
  const result = await (options.publishCombinedRelease ?? publishCombinedRelease)([
    mode,
    '--catalog-version', catalogVersion,
    '--cli-version', cliVersion,
  ], commonOptions);
  const expectedPath = plan.catalog.publicationMode === 'tag-first' ? 'tag-first' : 'catalog-first';
  if (result.path !== expectedPath) {
    throw new Error(`Release execution path ${result.path} does not match committed plan mode ${plan.catalog.publicationMode}.`);
  }
  return { ...result, planId: plan.planId };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await publishCommittedRelease(argv);
    process.stdout.write(`Release plan ${result.planId} completed through ${result.path}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
