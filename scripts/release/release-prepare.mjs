import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseIdentity,
  assertReleaseWorktreeClean,
  cliDistRoot,
  repoRoot as defaultRepoRoot,
  stampReleaseCandidateSnapshot,
  withPrivateCatalogStageRoot,
  withReleaseBuildSnapshot,
} from './common.mjs';
import { resolveCatalogStageLedger } from './git-catalog-publisher.mjs';
import { observeRelease, observeReleaseHistory, readCliReleaseContent } from './release-observe.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';
import { createReleasePlan, writeReleasePlan } from './release-plan.mjs';
import {
  assertNoBlockedReleaseAction,
  calculateReleaseStatus,
  hasPlanAction,
} from './release-state.mjs';
import { assertVersionTargetsMatchHead, readVersionTargets } from './release-target.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

export function parsePrepareArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 1 || (args[0] !== 'beta' && args[0] !== 'stable')) {
    throw new Error('Usage: pnpm release:prepare -- beta|stable');
  }
  return { channel: args[0] };
}

export async function materializeCliPlanArtifacts(status, planId, options = {}) {
  if (status.cli.action !== 'publish') return status.cli.packages;
  const packageContent = Object.fromEntries(status.cli.packages.map((entry) => [entry.name, entry.contentDigest]));
  return (options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
    await (options.stampReleaseCandidateSnapshot ?? stampReleaseCandidateSnapshot)(snapshot, {
      targetVersion: status.cli.targetVersion,
      candidateVersion: status.cli.candidateVersion,
      planId,
      sourceHead: status.source.head,
      packageContentDigest: packageContent['@lesliechan721/aw'],
      evalPackageContentDigest: packageContent['@lesliechan721/agent-skill-eval'],
      cliPackageContentDigest: packageContent['@lesliechan721/aw'],
      trainContentDigest: status.cli.trainContentDigest,
    });
    const materialized = await (options.readCliReleaseContent ?? readCliReleaseContent)(snapshot, options);
    if (materialized.trainContentDigest !== status.cli.trainContentDigest) {
      throw new Error('Candidate stamping changed the normalized CLI train content digest.');
    }
    for (const expected of status.cli.packages) {
      const actual = materialized.packages.find((entry) => entry.name === expected.name);
      if (!actual || actual.contentDigest !== expected.contentDigest) {
        throw new Error(`Candidate stamping changed ${expected.name} normalized package content.`);
      }
    }
    return materialized.packages;
  }, { repoRoot: options.repoRoot ?? defaultRepoRoot });
}

export async function materializeCatalogPlanArtifact(status, planId, options = {}) {
  if (status.catalog.action !== 'publish' && status.catalog.action !== 'recover') return null;
  if (status.catalog.action === 'recover') {
    const snapshotDigest = status.history.catalog?.tag?.snapshotDigest;
    if (typeof snapshotDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(snapshotDigest)) {
      throw new Error('Catalog promotion recovery is missing the exact tagged snapshotDigest.');
    }
    return snapshotDigest;
  }
  const pluginVersionOverrides = Object.fromEntries(status.plugins.map((plugin) => {
    if (plugin.candidateVersion === null) {
      throw new Error(`Catalog plan plugin ${plugin.name} is missing a candidate version.`);
    }
    return [plugin.name, plugin.candidateVersion];
  }));
  return (options.withPrivateCatalogStageRoot ?? withPrivateCatalogStageRoot)(
    async (internalOutputRoot) => {
      const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
        '--catalog-version', status.catalog.candidateVersion,
      ], {
        internalOutputRoot,
        previousReleaseLedger: resolveCatalogStageLedger(status.history.catalog),
        pluginVersionOverrides,
        pluginCandidates: status.plugins.map((plugin) => ({
          name: plugin.name,
          targetVersion: plugin.targetVersion,
          candidateVersion: plugin.candidateVersion,
          contentDigest: plugin.contentDigest,
          action: plugin.action,
        })),
        catalogRelease: {
          state: 'published',
          targetVersion: status.catalog.targetVersion,
          planId,
          sourceHead: status.source.head,
          contentDigest: status.catalog.contentDigest,
        },
        snapshotOptions: { repoRoot: options.repoRoot ?? defaultRepoRoot },
      });
      return staged.snapshotDigest;
    },
  );
}

export async function prepareRelease(argv = process.argv.slice(2), options = {}) {
  const { channel } = parsePrepareArgs(argv);
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  await (options.assertClean ?? assertReleaseWorktreeClean)({ cwd: repoRoot });
  const observed = await (options.observe ?? observeRelease)({ ...options, repoRoot, channel });
  const status = calculateReleaseStatus({ channel, ...observed });
  assertNoBlockedReleaseAction(status);
  if (!hasPlanAction(status)) return { created: false, status, plan: null };
  const assertFresh = options.assertFresh ?? assertCurrentReleaseIdentity;
  await assertFresh(observed.releaseIdentity, observed.releaseIdentity, { repoRoot });
  const freshTargets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  if (calculateCanonicalDigest(freshTargets) !== status.source.targetsDigest) {
    throw new Error('Release version targets changed while the plan was prepared.');
  }
  await (options.assertTargetsMatchHead ?? assertVersionTargetsMatchHead)(repoRoot);
  const freshHistory = await (options.observeRemoteHistory ?? observeReleaseHistory)({
    ...options,
    targets: freshTargets,
    channel,
    cliDistRoot,
    repoRoot,
  });
  if (calculateCanonicalDigest(freshHistory) !== calculateCanonicalDigest(observed.history)) {
    throw new Error('Release remote history changed while the plan was prepared.');
  }
  const provisionalPlan = createReleasePlan(status);
  const materializedPackages = await (options.materializeCliPlanArtifacts
    ?? materializeCliPlanArtifacts)(status, provisionalPlan.planId, { ...options, repoRoot });
  const executableStatus = {
    ...status,
    cli: { ...status.cli, packages: materializedPackages },
    catalog: {
      ...status.catalog,
      snapshotDigest: await (options.materializeCatalogPlanArtifact
        ?? materializeCatalogPlanArtifact)(status, provisionalPlan.planId, { ...options, repoRoot }),
    },
  };
  const plan = createReleasePlan(executableStatus);
  if (plan.planId !== provisionalPlan.planId) {
    throw new Error('Executable artifact materialization changed the release plan identity.');
  }
  await (options.assertClean ?? assertReleaseWorktreeClean)({ cwd: repoRoot });
  await assertFresh(observed.releaseIdentity, observed.releaseIdentity, { repoRoot });
  const finalTargets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  if (calculateCanonicalDigest(finalTargets) !== status.source.targetsDigest) {
    throw new Error('Release version targets changed during final artifact materialization.');
  }
  await (options.assertTargetsMatchHead ?? assertVersionTargetsMatchHead)(repoRoot);
  const finalHistory = await (options.observeRemoteHistory ?? observeReleaseHistory)({
    ...options,
    targets: finalTargets,
    channel,
    cliDistRoot,
    repoRoot,
  });
  if (calculateCanonicalDigest(finalHistory) !== calculateCanonicalDigest(observed.history)) {
    throw new Error('Release remote history changed during final artifact materialization.');
  }
  const written = await (options.writePlan ?? writeReleasePlan)(plan, { repoRoot });
  return { created: written.created, status, plan, ...written };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await prepareRelease(argv);
    if (!result.plan) {
      process.stdout.write('No publishable or recoverable release action; no plan was written.\n');
    } else {
      process.stdout.write(`Prepared immutable release plan ${result.plan.planId}.\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
