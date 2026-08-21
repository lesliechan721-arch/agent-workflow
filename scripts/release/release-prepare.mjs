import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseIdentity,
  assertReleaseWorktreeClean,
  cliDistRoot,
  repoRoot as defaultRepoRoot,
} from './common.mjs';
import { observeRelease, observeReleaseHistory } from './release-observe.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';
import { createReleasePlan, writeReleasePlan } from './release-plan.mjs';
import {
  assertNoBlockedReleaseAction,
  calculateReleaseStatus,
  hasPlanAction,
} from './release-state.mjs';
import { assertVersionTargetsMatchHead, readVersionTargets } from './release-target.mjs';

export function parsePrepareArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 1 || (args[0] !== 'beta' && args[0] !== 'stable')) {
    throw new Error('Usage: pnpm release:prepare -- beta|stable');
  }
  return { channel: args[0] };
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
  const plan = createReleasePlan(status);
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
