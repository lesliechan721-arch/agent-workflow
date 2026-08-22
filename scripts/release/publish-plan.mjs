import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseIdentity,
  assertReleaseWorktreeClean,
  compareReleaseSemVer,
  createReleaseSnapshotIdentity,
  repoRoot as defaultRepoRoot,
  runCommand,
  stampReleaseCandidateSnapshot,
  withPrivateCatalogStageRoot,
  withReleaseBuildSnapshot,
} from './common.mjs';
import { publishCatalog } from './publish-catalog.mjs';
import { bootstrapCatalog } from './bootstrap-catalog.mjs';
import { publishRelease as publishCombinedRelease } from './publish-release.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  promoteCatalogTag,
  resolveCatalogMaintenanceRemote,
  resolveCatalogStageLedger,
} from './git-catalog-publisher.mjs';
import {
  assertPlanOnlyCommit,
  readCurrentReleasePlan,
} from './release-plan.mjs';
import { readCliReleaseContent } from './release-observe.mjs';
import { readRegistryReleaseHistory } from './release-observe.mjs';
import {
  calculateCliTrainContentDigest,
  canonicalJson,
} from './release-model.mjs';
import {
  CLI_PACKAGES,
  normalizeCliRegistryHistory,
  resolveCliPublishedHistory,
} from './release-state.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

function assertCatalogHistoryAllowed(plan, history) {
  const plannedMode = publicationMode(plan);
  const boundOrigin = plan.history.catalog.tag?.origin ?? null;
  const tagRelease = history.tag?.manifest?.release;
  const tagMatchesBoundOrigin = boundOrigin !== null
    && tagRelease?.state === 'published'
    && canonicalJson({
      targetVersion: tagRelease.targetVersion,
      planId: tagRelease.planId,
      sourceHead: tagRelease.sourceHead,
      contentDigest: tagRelease.contentDigest,
    }) === canonicalJson(boundOrigin);
  const tagBelongsToCurrentPlan = tagRelease?.state === 'published'
    && tagRelease.planId === plan.planId
    && tagRelease.sourceHead === plan.source.head;
  for (const mode of ['latest', 'beta']) {
    const expected = plan.history.catalog[mode];
    const actual = history.channels?.[mode] ?? null;
    if ((actual?.commit ?? null) === (expected?.commit ?? null)) continue;
    const isPlannedPublication = mode === plannedMode
      && (tagMatchesBoundOrigin || tagBelongsToCurrentPlan)
      && actual?.commit === history.tag?.commit;
    if (!isPlannedPublication) {
      throw new Error(`Catalog ${mode} history changed after the release plan was committed.`);
    }
  }
  const plannedGuard = plan.history.catalog.publicationGuard;
  const actualGuard = history.pending ?? null;
  const plannedTag = tagMatchesBoundOrigin || tagBelongsToCurrentPlan;
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

function catalogHistoryBinding(history) {
  const publication = (entry) => entry ? {
    commit: entry.commit ?? null,
    snapshotDigest: entry.snapshotDigest ?? null,
    catalogContentDigest: entry.catalogContentDigest ?? null,
    manifest: entry.manifest ?? null,
    ledger: entry.ledger ?? null,
  } : null;
  return canonicalJson(JSON.parse(JSON.stringify({
    channels: {
      latest: publication(history.channels?.latest),
      beta: publication(history.channels?.beta),
    },
    tag: history.tag ? {
      objectId: history.tag.objectId ?? null,
      catalogVersion: history.tag.catalogVersion ?? null,
      ...publication(history.tag),
    } : null,
    pending: history.pending ?? null,
    mergedLedger: history.mergedLedger ?? null,
  })));
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

function verificationScript(plan) {
  if (plan.catalog.publicationMode === 'none') return 'release:verify:cli';
  if (['catalog-only', 'bootstrap', 'promotion'].includes(plan.catalog.publicationMode)) {
    return 'release:verify:catalog';
  }
  return 'release:verify';
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

function assertPromotionCliTrainObservation(plan, registry) {
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

export async function assertPromotionCliTrain(plan, options = {}) {
  const registry = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  return assertPromotionCliTrainObservation(plan, registry);
}

function registryFromPlanHistory(plan) {
  return {
    ...Object.fromEntries(plan.history.npm.packages.map((entry) => [entry.name,
      entry.versions.map((version) => ({
        version: version.candidateVersion,
        awRelease: version.metadata,
      }))])),
    distTags: Object.fromEntries(plan.history.npm.distTags.map((entry) => [entry.name, {
      latest: entry.latest,
      beta: entry.beta,
    }])),
  };
}

function historyWithoutCandidate(normalized, candidateVersion) {
  return {
    ...Object.fromEntries(CLI_PACKAGES.map((name) => [name,
      normalized.packages.get(name)
        .filter((entry) => entry.candidateVersion !== candidateVersion)
        .map((entry) => ({ version: entry.candidateVersion, awRelease: entry.metadata }))])),
    distTags: Object.fromEntries(CLI_PACKAGES.map((name) => [name, {
      latest: null,
      beta: null,
    }])),
  };
}

function metadataIdentity(metadata) {
  return canonicalJson(metadata);
}

export function assertCliRegistryHistoryMatchesPlan(plan, registry) {
  const plannedRegistry = registryFromPlanHistory(plan);
  const planned = normalizeCliRegistryHistory(plannedRegistry);
  const live = normalizeCliRegistryHistory(registry);
  resolveCliPublishedHistory(plannedRegistry);

  const candidateVersion = plan.cli.candidateVersion;
  const allowsCandidateRetry = ['publish', 'recover'].includes(plan.cli.action);
  const candidateEntries = [];
  for (const packageName of CLI_PACKAGES) {
    const expectedPackage = plan.cli.packages.find((entry) => entry.name === packageName);
    if (!expectedPackage) throw new Error(`Committed release plan is missing CLI package ${packageName}.`);
    const plannedByVersion = new Map(planned.packages.get(packageName).map((entry) => [
      entry.candidateVersion, entry,
    ]));
    const liveByVersion = new Map(live.packages.get(packageName).map((entry) => [
      entry.candidateVersion, entry,
    ]));
    for (const [version, plannedEntry] of plannedByVersion) {
      const liveEntry = liveByVersion.get(version);
      if (!liveEntry || metadataIdentity(liveEntry.metadata) !== metadataIdentity(plannedEntry.metadata)) {
        throw new Error(`Registry history for ${packageName}@${version} changed after the release plan was committed.`);
      }
    }
    for (const [version, liveEntry] of liveByVersion) {
      if (plannedByVersion.has(version)) continue;
      if (!allowsCandidateRetry || version !== candidateVersion) {
        throw new Error(`Registry history added unplanned ${packageName}@${version}.`);
      }
      const expectedMetadata = {
        schemaVersion: 1,
        targetVersion: plan.cli.targetVersion,
        candidateVersion,
        planId: plan.planId,
        sourceHead: plan.source.head,
        packageContentDigest: expectedPackage.contentDigest,
        trainContentDigest: plan.cli.trainContentDigest,
      };
      if (metadataIdentity(liveEntry.metadata) !== metadataIdentity(expectedMetadata)) {
        throw new Error(`Published ${packageName}@${candidateVersion} does not belong to this release plan.`);
      }
      candidateEntries.push({ packageName, entry: liveEntry });
    }
  }

  resolveCliPublishedHistory(historyWithoutCandidate(live, candidateVersion));
  if (candidateEntries.length === CLI_PACKAGES.length) {
    const calculatedTrainDigest = calculateCliTrainContentDigest(candidateEntries.map(({ packageName, entry }) => ({
      name: packageName,
      contentDigest: entry.metadata.packageContentDigest,
    })));
    if (calculatedTrainDigest !== plan.cli.trainContentDigest) {
      throw new Error(`Published CLI train ${candidateVersion} does not match the committed train digest.`);
    }
    resolveCliPublishedHistory(registry);
  }

  for (const packageName of CLI_PACKAGES) {
    const exact = live.packages.get(packageName).find((entry) =>
      entry.candidateVersion === candidateVersion);
    for (const tag of ['latest', 'beta']) {
      const plannedTag = planned.distTags[packageName][tag];
      const liveTag = live.distTags[packageName][tag];
      if (liveTag === plannedTag) continue;
      if (!allowsCandidateRetry || liveTag !== candidateVersion || !exact) {
        throw new Error(`${packageName} ${tag} dist-tag changed outside the committed release plan.`);
      }
    }
  }
  return registry;
}

export async function assertPlanCliRegistryFresh(plan, options = {}) {
  const registry = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  return assertCliRegistryHistoryMatchesPlan(plan, registry);
}

function legacyStablePublishedVersion(plan, registry) {
  if (plan.channel !== 'stable' || plan.history.npm.legacyLatestAwOnly !== true) return undefined;
  const planned = normalizeCliRegistryHistory(registryFromPlanHistory(plan));
  if (!planned.legacyLatestAwOnly) {
    throw new Error('Invalid committed legacyLatestAwOnly registry history.');
  }
  const live = normalizeCliRegistryHistory(registry);
  const publishedVersion = live.distTags['@lesliechan721/aw'].latest;
  if (publishedVersion === '0.1.0-beta.1') return null;
  if (publishedVersion === plan.cli.candidateVersion) return plan.cli.candidateVersion;
  throw new Error('Live registry does not match the committed first stable release baseline.');
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
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const { plan } = await (options.readCurrentReleasePlan ?? readCurrentReleasePlan)({ repoRoot });
  const assertPlan = options.assertPlanOnlyCommit ?? assertPlanOnlyCommit;
  let planCommitHead = null;
  const assertFresh = async () => {
    const binding = await assertPlan(plan, { repoRoot, ...(options.planCommitOptions ?? {}) });
    if (binding?.head) {
      if (planCommitHead !== null && binding.head !== planCommitHead) {
        throw new Error('Plan-only release commit changed during publication.');
      }
      planCommitHead ??= binding.head;
    }
    return binding;
  };
  await assertFresh();
  const mode = publicationMode(plan);
  if (plan.catalog.publicationMode === 'none' && plan.cli.action !== 'publish') {
    return { path: 'none', planId: plan.planId };
  }
  if (!options._verified) {
    await (options.runCommand ?? runCommand)('pnpm', ['run', verificationScript(plan)]);
    await assertFresh();
  }
  const initialRegistry = await assertPlanCliRegistryFresh(plan, options);
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
          remoteUrl,
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
          _verified: true,
          _boundCatalog: { internalOutputRoot, snapshot, releaseIdentity, staged },
        });
      }),
    );
  }
  const boundCatalog = options._boundCatalog;
  const assertWriteFresh = async () => {
    await assertFresh();
    return assertPlanCliRegistryFresh(plan, options);
  };
  const assertPublicationFresh = async (...args) => {
    const [snapshot, identity] = args;
    const liveIdentity = {
      ...identity,
      headCommit: planCommitHead ?? identity.headCommit,
    };
    await (options.canonicalAssertCurrentReleaseIdentity
      ?? assertCurrentReleaseIdentity)(snapshot, liveIdentity, { repoRoot });
    await options.assertCurrentReleaseIdentity?.(...args);
    await assertWriteFresh();
  };
  const callerBeforeNpmWrite = options.beforeNpmWrite;
  const callerEvalBeforeNpmWrite = options.evalPublicationOptions?.beforeNpmWrite;
  const callerBeforeRemoteWrite = options.beforeRemoteWrite;
  const stablePublishedVersion = legacyStablePublishedVersion(plan, initialRegistry);
  const runPlanCommand = async (command, args, commandOptions) => {
    if (command === 'pnpm' && (
      args.join(' ') === 'run release:verify'
      || args.join(' ') === 'run release:verify:cli'
      || args.join(' ') === 'run release:verify:catalog'
    )) return;
    return (options.runCommand ?? runCommand)(command, args, commandOptions);
  };
  const commonOptions = {
    ...options,
    repoRoot,
    remoteUrl,
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
    assertCurrentReleaseIdentity: assertPublicationFresh,
    resolveReleaseHead: async () => plan.source.head,
    readCliPackageJson: async () => ({ version: plan.cli.candidateVersion }),
    expectedPublicationMode: plan.catalog.publicationMode,
    beforeNpmWrite: async (...args) => {
      await callerBeforeNpmWrite?.(...args);
      await assertWriteFresh();
    },
    beforeRemoteWrite: async () => {
      await callerBeforeRemoteWrite?.();
      await assertWriteFresh();
    },
    beforePromotionRemoteWrite: async () => {
      await callerBeforeRemoteWrite?.();
      await assertFresh();
    },
    evalPublicationOptions: {
      ...(options.evalPublicationOptions ?? {}),
      beforeNpmWrite: async (...args) => {
        await callerEvalBeforeNpmWrite?.(...args);
        await assertWriteFresh();
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
    runCommand: runPlanCommand,
    ...(stablePublishedVersion !== undefined
      ? { publishedVersion: stablePublishedVersion }
      : {}),
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
    const readHistory = options.readCatalogPublicationHistory
      ?? (await import('./git-catalog-publisher.mjs')).readCatalogPublicationHistory;
    let initialCatalogBinding = null;
    const assertPromotionCatalogFresh = async () => {
      const promotionHistory = assertCatalogHistoryAllowed(plan, await readHistory({
        mode,
        catalogVersion: plan.catalog.candidateVersion,
        remoteUrl,
        ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
      }));
      const taggedManifest = promotionHistory.tag?.manifest;
      const boundTag = plan.history.catalog.tag;
      const boundOrigin = boundTag?.origin;
      if (
        taggedManifest?.schemaVersion !== 4
        || taggedManifest.catalogVersion !== plan.catalog.candidateVersion
        || taggedManifest.release?.state !== 'published'
        || !boundOrigin
        || taggedManifest.release.targetVersion !== boundOrigin.targetVersion
        || taggedManifest.release.planId !== boundOrigin.planId
        || taggedManifest.release.sourceHead !== boundOrigin.sourceHead
        || taggedManifest.release.contentDigest !== boundOrigin.contentDigest
        || promotionHistory.tag.catalogContentDigest !== boundTag.contentDigest
        || promotionHistory.tag.snapshotDigest !== boundTag.snapshotDigest
        || plan.catalog.snapshotDigest !== boundTag.snapshotDigest
      ) {
        throw new Error('Promotion Catalog tag identity does not match the committed release plan.');
      }
      const liveCatalogBinding = catalogHistoryBinding(promotionHistory);
      if (initialCatalogBinding !== null && liveCatalogBinding !== initialCatalogBinding) {
        throw new Error('Catalog publication history changed after the promotion binding was observed.');
      }
      initialCatalogBinding ??= liveCatalogBinding;
      return promotionHistory;
    };
    const assertPromotionWriteFresh = async () => {
      await assertFresh();
      const registry = await assertPlanCliRegistryFresh(plan, options);
      assertPromotionCliTrainObservation(plan, registry);
      return assertPromotionCatalogFresh();
    };
    assertPromotionCliTrainObservation(plan, initialRegistry);
    await assertPromotionCatalogFresh();
    const currentCliVersion = plan.cli.candidateVersion;
    if (compareReleaseSemVer(currentCliVersion, plan.catalog.minCliVersion) < 0) {
      throw new Error(`Promotion CLI train ${currentCliVersion} is below Catalog minimum ${plan.catalog.minCliVersion}.`);
    }
    const callerBeforeAcquire = options.publisherOptions?.beforeAcquire;
    const promotion = await (options.promoteCatalogTag ?? promoteCatalogTag)({
      mode,
      catalogVersion: plan.catalog.candidateVersion,
      currentCliVersion,
      beforeAcquire: async () => {
        await assertPromotionWriteFresh();
      },
      beforeRemoteWrite: async () => {
        await callerBeforeRemoteWrite?.();
        await assertPromotionWriteFresh();
      },
      remoteUrl,
      withCatalogPublicationLease: options.withCatalogPublicationLease,
      publisherOptions: {
        ...(options.publisherOptions ?? {}),
        beforeAcquire: callerBeforeAcquire,
      },
    });
    return { path: 'promotion', planId: plan.planId, promotion };
  }
  if (plan.catalog.publicationMode === 'catalog-only') {
    const catalog = await (options.publishCatalog ?? publishCatalog)([
      mode, '--catalog-version', plan.catalog.candidateVersion,
    ], { ...commonOptions, skipVerify: true });
    return { path: 'catalog-only', planId: plan.planId, catalog };
  }
  if (plan.catalog.publicationMode === 'bootstrap') {
    const { remoteUrl: ignoredRemoteUrl, ...bootstrapOptions } = commonOptions;
    const catalog = await (options.bootstrapCatalog ?? bootstrapCatalog)([
      mode, '--catalog-version', plan.catalog.candidateVersion,
    ], {
      ...bootstrapOptions,
      skipVerify: true,
      ...(remoteUrl === OFFICIAL_CATALOG_PUBLISH_REMOTE
        ? { remoteUrl }
        : { testRemoteUrl: remoteUrl }),
    });
    return { path: 'bootstrap', planId: plan.planId, catalog };
  }
  const catalogVersion = plan.catalog.candidateVersion;
  const cliVersion = plan.cli.candidateVersion;
  const result = await (options.publishCombinedRelease ?? publishCombinedRelease)([
    mode,
    '--catalog-version', catalogVersion,
    '--cli-version', cliVersion,
  ], {
    ...commonOptions,
    skipVerify: true,
    readLiveCliHistory: options.readRegistryReleaseHistory ?? readRegistryReleaseHistory,
    assertPromotionRegistryFresh: (registry) => assertCliRegistryHistoryMatchesPlan(plan, registry),
  });
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
