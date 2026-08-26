import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPublishedCliArtifactsMatch,
  assertCliTagAvailable,
  ensureCliTag,
} from './cli-git-tag.mjs';
import {
  repoRoot as defaultRepoRoot,
  runCommand,
  runReleaseGit,
} from './common.mjs';
import {
  assertPreparedCliArtifacts,
  assertPreparedCliAttempt,
  assertSelectedCandidates,
  assertTrackedHeadClean,
  prepareLocalRelease,
  publishPreparedRelease,
  readPreparedDescriptor,
  repairPreparedCliRelease,
  resolvePreparedCandidates,
} from './prepared-release.mjs';
import {
  assertVersionTargetsMatchHead,
  readVersionTargets,
  updateReleaseTargets,
} from './release-target.mjs';

const BUMPS = new Set(['major', 'minor', 'patch']);
const PLUGIN_BUMP_PATTERN = /^([a-z0-9]+(?:-[a-z0-9]+)*)=(major|minor|patch)$/u;
const usage = [
  'pnpm release -- beta|release --cli|--catalog|--all',
  '[--cli-bump major|minor|patch] [--catalog-bump major|minor|patch]',
  '[--plugin <name>=major|minor|patch]',
  'or: pnpm release -- --repair-cli',
  'or: pnpm release -- --repair-cli-tag',
].join(' ');

function takeBump(args, option) {
  const bump = args.shift();
  if (!BUMPS.has(bump)) throw new Error(`${option} requires major, minor, or patch.`);
  return bump;
}

export function parseReleaseArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args[0] === '--repair-cli') {
    args.shift();
    if (args.length > 0) throw new Error(`--repair-cli cannot be combined with other arguments. Usage: ${usage}`);
    return { repairCli: true };
  }
  if (args[0] === '--repair-cli-tag') {
    args.shift();
    if (args.length > 0) throw new Error(`--repair-cli-tag cannot be combined with other arguments. Usage: ${usage}`);
    return { repairCliTag: true };
  }
  const requestedChannel = args.shift();
  if (requestedChannel !== 'beta' && requestedChannel !== 'release') {
    throw new Error(`Release channel must be beta or release. Usage: ${usage}`);
  }
  const parsed = {
    repairCliTag: false,
    requestedChannel,
    channel: requestedChannel === 'release' ? 'stable' : 'beta',
    axis: null,
    axes: { cli: false, catalog: false },
    cliBump: null,
    catalogBump: null,
    plugins: new Map(),
  };
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--cli' || token === '--catalog' || token === '--all') {
      if (parsed.axis !== null) throw new Error('Select exactly one of --cli, --catalog, or --all.');
      parsed.axis = token.slice(2);
      parsed.axes = {
        cli: token === '--cli' || token === '--all',
        catalog: token === '--catalog' || token === '--all',
      };
      continue;
    }
    if (token === '--cli-bump') {
      if (parsed.cliBump !== null) throw new Error('Duplicate --cli-bump option.');
      parsed.cliBump = takeBump(args, token);
      continue;
    }
    if (token === '--catalog-bump') {
      if (parsed.catalogBump !== null) throw new Error('Duplicate --catalog-bump option.');
      parsed.catalogBump = takeBump(args, token);
      continue;
    }
    if (token === '--plugin') {
      const value = args.shift();
      const match = PLUGIN_BUMP_PATTERN.exec(value ?? '');
      if (!match) throw new Error('--plugin requires <name>=major|minor|patch.');
      if (parsed.plugins.has(match[1])) throw new Error(`Duplicate plugin bump ${match[1]}.`);
      parsed.plugins.set(match[1], match[2]);
      continue;
    }
    throw new Error(`Unknown release argument ${JSON.stringify(token)}. Usage: ${usage}`);
  }
  if (parsed.axis === null) throw new Error('Select exactly one of --cli, --catalog, or --all.');
  if (parsed.cliBump !== null && !parsed.axes.cli) {
    throw new Error('--cli-bump requires --cli or --all.');
  }
  if ((parsed.catalogBump !== null || parsed.plugins.size > 0) && !parsed.axes.catalog) {
    throw new Error('--catalog-bump and --plugin require --catalog or --all.');
  }
  return parsed;
}

function targetArgs(parsed) {
  const args = [];
  if (parsed.cliBump) args.push('--cli', parsed.cliBump);
  if (parsed.catalogBump) args.push('--catalog', parsed.catalogBump);
  for (const [name, bump] of parsed.plugins) args.push('--plugin', `${name}=${bump}`);
  return args;
}

function releaseMetadataPaths(parsed) {
  const paths = new Set();
  if (parsed.cliBump || parsed.catalogBump) paths.add('release/version-targets.json');
  if (parsed.cliBump) {
    paths.add('packages/cli/package.json');
    paths.add('packages/agent-skill-eval/package.json');
    paths.add('packages/plugin-core/package.json');
    paths.add('pnpm-lock.yaml');
  }
  for (const name of parsed.plugins.keys()) paths.add(`plugins/${name}/.agents-plugin/plugin.json`);
  return [...paths];
}

export async function commitReleaseMetadata(parsed, options = {}) {
  const args = targetArgs(parsed);
  if (args.length === 0) return null;
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const updateTargets = options.updateTargets ?? updateReleaseTargets;
  const runGit = options.runGit ?? runReleaseGit;
  const result = await updateTargets(args, { ...options, repoRoot });
  const allowedPaths = releaseMetadataPaths(parsed);
  await runGit(['add', '--', ...allowedPaths], { ...options, cwd: repoRoot });
  const staged = (await runGit([
    'diff', '--cached', '--name-only', '-z',
  ], { ...options, cwd: repoRoot })).stdout.split('\0').filter(Boolean);
  if (staged.length === 0 || staged.some((entry) => !allowedPaths.includes(entry))) {
    throw new Error('Release metadata commit contains unexpected paths or no changes.');
  }
  await runGit(['commit', '-m', 'chore(release): set release targets'], {
    ...options,
    cwd: repoRoot,
  });
  return result;
}

async function runReleaseVerification(axes, options = {}) {
  const script = axes.cli && axes.catalog
    ? 'release:verify'
    : axes.cli ? 'release:verify:cli' : 'release:verify:catalog';
  await (options.runVerification ?? runCommand)('pnpm', ['run', script], {
    cwd: options.repoRoot ?? defaultRepoRoot,
  });
  return script;
}

async function repairCliTag(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const { root, descriptor } = await (options.readDescriptor ?? readPreparedDescriptor)(options);
  await (options.assertPreparedCliAttempt ?? assertPreparedCliAttempt)(descriptor, options);
  await (options.assertPreparedCliArtifacts ?? assertPreparedCliArtifacts)(root, descriptor, options);
  await (options.assertPublishedCliArtifactsMatch ?? assertPublishedCliArtifactsMatch)(
    root,
    descriptor,
    options,
  );
  await (options.runGit ?? runReleaseGit)([
    'cat-file', '-e', `${descriptor.source.head}^{commit}`,
  ], { ...options, cwd: repoRoot });
  return (options.ensureCliTag ?? ensureCliTag)(
    descriptor.candidates.cli,
    descriptor.source.head,
    { ...options, repoRoot },
  );
}

export async function runRelease(argv = process.argv.slice(2), options = {}) {
  const parsed = parseReleaseArgs(argv);
  if (parsed.repairCli) {
    return (options.repairCli ?? repairPreparedCliRelease)(options);
  }
  if (parsed.repairCliTag) return repairCliTag(options);

  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);
  await (options.assertTargetsMatchHead ?? assertVersionTargetsMatchHead)(repoRoot, options);
  const metadata = await (options.commitMetadata ?? commitReleaseMetadata)(parsed, {
    ...options,
    repoRoot,
  });
  await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);

  const targets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  const candidates = await (options.resolveCandidates ?? resolvePreparedCandidates)(
    parsed.channel,
    targets,
    { ...options, repoRoot, axes: parsed.axes },
  );
  assertSelectedCandidates(parsed.axes, candidates);
  if (parsed.axes.cli) {
    await (options.assertCliTagAvailable ?? assertCliTagAvailable)(
      candidates.cli,
      { ...options, repoRoot },
    );
  }
  const verification = await runReleaseVerification(parsed.axes, { ...options, repoRoot });
  await (options.assertClean ?? assertTrackedHeadClean)(repoRoot, options);
  const descriptor = await (options.prepare ?? prepareLocalRelease)(parsed.channel, {
    ...options,
    repoRoot,
    axes: parsed.axes,
  });
  const published = await (options.publish ?? publishPreparedRelease)({ ...options, repoRoot });
  return { metadata, verification, candidates, descriptor, published };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runRelease(argv);
    if ('status' in result && 'version' in result) {
      process.stdout.write(`CLI tag ${result.status}: cli-v${result.version}.\n`);
      return;
    }
    process.stdout.write(
      `Published ${result.published.channel} release: ` +
      `CLI ${result.published.candidates.cli ?? 'disabled'}, ` +
      `Catalog ${result.published.candidates.catalog ?? 'disabled'}.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
