import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { repoRoot as defaultRepoRoot, runReleaseGit } from './common.mjs';
import { normalizeStableTargetVersion } from './release-model.mjs';
import { normalizeVersionTargets, setReleaseTargets, synchronizeCliLockfile } from './release-target.mjs';

const VERSION = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-beta\\.([1-9]\\d*))?';
const SOURCE_TAG = new RegExp(`^release/(cli|catalog)/v(${VERSION})$`);
const CATALOG_METADATA = 'plugins/marketplace-source.json';
const CLI_TARGETS = 'release/version-targets.json';
const CLI_PACKAGES = [
  ['aw-windows-job-win32-x64', '@lesliechan721/aw-windows-job-win32-x64'],
  ['aw-windows-job-win32-arm64', '@lesliechan721/aw-windows-job-win32-arm64'],
  ['agent-skill-eval', '@lesliechan721/agent-skill-eval'],
  ['plugin-core', '@lesliechan721/aw-plugin-core'],
  ['cli', '@lesliechan721/aw'],
].map(([directory, name]) => ({ path: `packages/${directory}/package.json`, name }));
const INTERNAL_DEPENDENCIES = {
  'packages/agent-skill-eval/package.json': {
    optionalDependencies: [CLI_PACKAGES[0].name, CLI_PACKAGES[1].name],
  },
  'packages/cli/package.json': {
    dependencies: [CLI_PACKAGES[2].name, CLI_PACKAGES[3].name],
  },
};

function git(repoRoot, args) {
  return runReleaseGit(args, { cwd: repoRoot });
}

export function parseSourceTag(tag) {
  const match = typeof tag === 'string' ? SOURCE_TAG.exec(tag) : null;
  if (!match || match[0] !== tag) {
    throw new Error('Invalid source tag: expected release/<cli|catalog>/v<x.y.z[-beta.N]>.');
  }
  return { product: match[1], version: match[2], channel: match[2].includes('-') ? 'beta' : 'stable' };
}

async function resolveCommit(repoRoot, ref) {
  if (typeof ref !== 'string' || ref === '' || ref.startsWith('-')) {
    throw new Error('A source candidate requires an explicit Git commit or ref.');
  }
  const { stdout } = await git(repoRoot, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Source candidate did not resolve to a commit.');
  return commit;
}

async function readBlob(repoRoot, commit, relativePath) {
  const { stdout } = await git(repoRoot, ['ls-tree', '-z', commit, '--', relativePath]);
  const match = /^(100644|100755) blob [0-9a-f]+\t[^\0]+\0$/.exec(stdout);
  if (!match) throw new Error(`Candidate metadata must be a regular tracked file: ${relativePath}.`);
  const result = await git(repoRoot, ['show', `${commit}:${relativePath}`]);
  return { contents: result.stdout, mode: match[1] };
}

async function readJson(repoRoot, commit, relativePath) {
  const blob = await readBlob(repoRoot, commit, relativePath);
  let value;
  try {
    value = JSON.parse(blob.contents);
  } catch (error) {
    throw new Error(`Invalid candidate JSON: ${relativePath}.`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid candidate metadata object: ${relativePath}.`);
  }
  return { ...blob, value };
}

function withoutVersionFields(value, relativePath) {
  const normalized = structuredClone(value);
  if (relativePath === CATALOG_METADATA) {
    if (normalized.catalog) delete normalized.catalog.version;
  } else if (relativePath === CLI_TARGETS) {
    delete normalized.cli;
  } else {
    delete normalized.version;
    for (const [field, names] of Object.entries(INTERNAL_DEPENDENCIES[relativePath] ?? {})) {
      for (const name of names) delete normalized[field]?.[name];
    }
  }
  return normalized;
}

async function assertVersionOnlyDiff(repoRoot, sourceHead, candidateHead, product, allowLegacyHistory) {
  const { stdout } = await git(repoRoot, [
    'diff', '--no-renames', '--name-only', '-z', sourceHead, candidateHead, '--',
  ]);
  for (const relativePath of stdout.split('\0').filter(Boolean)) {
    const cliPath = [CLI_TARGETS, 'pnpm-lock.yaml', ...CLI_PACKAGES.map((entry) => entry.path)].includes(relativePath);
    const catalogPath = relativePath === CATALOG_METADATA
      || /^plugins\/[a-z0-9]+(?:-[a-z0-9]+)*\/\.agents-plugin\/plugin\.json$/.test(relativePath);
    const allowed = allowLegacyHistory ? cliPath || catalogPath : product === 'cli' ? cliPath : catalogPath;
    if (!allowed) throw new Error(`Source candidate changes a non-version path: ${relativePath}.`);
    const [before, after] = await Promise.all([
      readBlob(repoRoot, sourceHead, relativePath),
      readBlob(repoRoot, candidateHead, relativePath),
    ]);
    if (before.mode !== after.mode) throw new Error(`Source candidate changes file mode: ${relativePath}.`);
    if (relativePath === 'pnpm-lock.yaml') {
      const oldTarget = normalizeVersionTargets((await readJson(repoRoot, sourceHead, CLI_TARGETS)).value);
      const nextTarget = normalizeVersionTargets((await readJson(repoRoot, candidateHead, CLI_TARGETS)).value);
      if (after.contents !== synchronizeCliLockfile(before.contents, oldTarget.cli, nextTarget.cli)) {
        throw new Error('Source candidate lockfile changes exceed necessary CLI version synchronization.');
      }
      continue;
    }
    let oldValue;
    let nextValue;
    try {
      oldValue = JSON.parse(before.contents);
      nextValue = JSON.parse(after.contents);
    } catch (error) {
      throw new Error(`Invalid candidate JSON: ${relativePath}.`, { cause: error });
    }
    if (!isDeepStrictEqual(
      withoutVersionFields(oldValue, relativePath), withoutVersionFields(nextValue, relativePath),
    )) throw new Error(`Source candidate changes non-version fields: ${relativePath}.`);
    if (relativePath.endsWith('/.agents-plugin/plugin.json')) {
      normalizeStableTargetVersion(nextValue.version, `${relativePath} version`);
    }
  }
}

async function resolveSquashedIntermediateSource(repoRoot, candidate, commonSource, mainHistory, product) {
  const { stdout } = await git(repoRoot, [
    'for-each-ref', `--contains=${commonSource}`, '--format=%(objectname) %(tree)',
    'refs/aw/release-pull-heads/',
  ]);
  const pullHeads = stdout.trim().split('\n').filter(Boolean).map((entry) => entry.split(' '));
  for (const entry of mainHistory) {
    const [mainSourceHead, tree] = entry.split(' ');
    for (const [pullHead, pullTree] of pullHeads) {
      if (pullTree !== tree) continue;
      const bases = (await git(repoRoot, ['merge-base', '--all', candidate, pullHead])).stdout.trim().split('\n');
      if (bases.length !== 1) continue;
      const sourceHead = bases[0];
      try {
        // A release may add version metadata on a side branch of the PR.
        await assertVersionOnlyDiff(repoRoot, sourceHead, candidate, product, true);
      } catch {
        continue;
      }
      // Keep the actual source for declarations and content differences. The
      // later squash commit only orders this delivery against other main work.
      return { sourceHead, candidateHead: candidate, mainSourceHead };
    }
  }
  return null;
}

// Legacy completions can predate source tags or be intermediate PR commits.
// New candidates still require a main source and product-only version changes.
export async function resolveMainSource({
  repoRoot = defaultRepoRoot, candidateHead, product, mainRef = 'origin/main', allowLegacyHistory = false,
}) {
  if (product !== 'cli' && product !== 'catalog') throw new Error('Unknown source candidate product.');
  const [candidate, main] = await Promise.all([
    resolveCommit(repoRoot, candidateHead), resolveCommit(repoRoot, mainRef),
  ]);
  const bases = (await git(repoRoot, ['merge-base', '--all', candidate, main])).stdout.trim().split('\n');
  if (bases.length !== 1 || !/^[0-9a-f]{40,64}$/.test(bases[0])) {
    throw new Error('Source candidate does not have one provable main source.');
  }
  const sourceHead = bases[0];
  if (candidate === sourceHead) return { sourceHead, candidateHead: candidate };
  let mainHistory = [];
  if (allowLegacyHistory) {
    // Squash merges replace commit ancestry but preserve the complete source tree.
    const tree = (await git(repoRoot, ['rev-parse', `${candidate}^{tree}`])).stdout.trim();
    mainHistory = (await git(repoRoot, [
      'log', '--first-parent', '--format=%H %T', `${sourceHead}..${main}`,
    ])).stdout.trim().split('\n');
    const matchingSource = mainHistory.find((entry) => entry.split(' ')[1] === tree)?.split(' ')[0];
    if (matchingSource) return { sourceHead: matchingSource, candidateHead: candidate };
  }
  if (!allowLegacyHistory) {
    const parents = (await git(repoRoot, ['rev-list', '--parents', '-n', '1', candidate])).stdout.trim().split(' ');
    if (parents.length !== 2 || parents[1] !== sourceHead) {
      throw new Error('Source candidate must be main source or its direct version-only child commit.');
    }
  }
  try {
    await assertVersionOnlyDiff(repoRoot, sourceHead, candidate, product, allowLegacyHistory);
  } catch (error) {
    if (allowLegacyHistory) {
      const squashed = await resolveSquashedIntermediateSource(repoRoot, candidate, sourceHead, mainHistory, product);
      if (squashed) return squashed;
    }
    throw error;
  }
  return { sourceHead, candidateHead: candidate };
}

async function assertCandidateMetadata(repoRoot, candidateHead, parsed) {
  if (parsed.product === 'catalog') {
    const { value } = await readJson(repoRoot, candidateHead, CATALOG_METADATA);
    if (value.catalog?.version !== parsed.version) throw new Error('Catalog source tag does not match metadata version.');
    return;
  }
  const baseVersion = parsed.version.split('-', 1)[0];
  const targets = normalizeVersionTargets((await readJson(repoRoot, candidateHead, CLI_TARGETS)).value);
  if (targets.cli !== baseVersion) throw new Error('CLI source tag does not match its stable release target.');
  for (const entry of CLI_PACKAGES) {
    const { value } = await readJson(repoRoot, candidateHead, entry.path);
    if (value.name !== entry.name || value.version !== baseVersion) {
      throw new Error(`CLI source tag must match all five package stable versions: ${entry.path}.`);
    }
    for (const [field, names] of Object.entries(INTERNAL_DEPENDENCIES[entry.path] ?? {})) {
      for (const name of names) {
        if (value[field]?.[name] !== `workspace:${baseVersion}`) {
          throw new Error(`CLI source candidate has a mismatched internal dependency: ${name}.`);
        }
      }
    }
  }
  const lock = await readBlob(repoRoot, candidateHead, 'pnpm-lock.yaml');
  synchronizeCliLockfile(lock.contents, baseVersion, baseVersion);
}

export async function validateSourceCandidate({ repoRoot = defaultRepoRoot, tag, mainRef = 'origin/main' }) {
  const parsed = parseSourceTag(tag);
  const candidateHead = await resolveCommit(repoRoot, `refs/tags/${tag}`);
  const source = await resolveMainSource({ repoRoot, candidateHead, product: parsed.product, mainRef });
  await assertCandidateMetadata(repoRoot, candidateHead, parsed);
  return { ...parsed, ...source, tag };
}

async function assertMainTip(repoRoot, remote, sourceHead) {
  const { stdout } = await git(repoRoot, ['ls-remote', '--refs', remote, 'refs/heads/main']);
  if (stdout.trim() !== `${sourceHead}\trefs/heads/main`) {
    throw new Error('Main source is stale; prepare a candidate from the current remote main commit.');
  }
}

async function assertRefsAvailable(repoRoot, branch, tag, remote) {
  const refs = [`refs/heads/${branch}`, `refs/tags/${tag}`];
  const local = (await git(repoRoot, ['for-each-ref', '--format=%(refname)', ...refs])).stdout.trim();
  if (local !== '') throw new Error('Source candidate branch or tag is already occupied; select a new version.');
  if (remote !== undefined) {
    const { stdout } = await git(repoRoot, ['ls-remote', '--refs', remote, ...refs]);
    if (stdout.trim() !== '') throw new Error('Remote source candidate branch or tag is already occupied; select a new version.');
  }
}

async function mutateCatalogVersion(repoRoot, version) {
  const serviceUrl = new URL('../../packages/cli/dist/src/authoring/workspace-commands.js', import.meta.url);
  const service = await import(serviceUrl.href).catch((error) => {
    throw new Error('Source candidate preparation requires the compiled Catalog version service.', { cause: error });
  });
  return service.runCatalogVersionCommand({
    workspaceRoot: repoRoot, version, io: { stdout() {}, stderr() {} },
  });
}

export async function prepareSourceCandidate({
  repoRoot = defaultRepoRoot, product, version, sourceHead, remote, push = false,
  mainRef = 'origin/main', requireMainTip = false, pluginBaseVersions = {}, ciRun,
  mutateCatalogVersion: mutate = mutateCatalogVersion,
}) {
  const tag = `release/${product}/v${version}`;
  const parsed = parseSourceTag(tag);
  if (ciRun !== undefined && (parsed.channel !== 'beta' || !requireMainTip || !/^[1-9]\d*\/[1-9]\d*$/u.test(ciRun))) {
    throw new Error('Automatic beta CI evidence requires a run/attempt identity and the current main tip.');
  }
  if (typeof push !== 'boolean') throw new Error('Source candidate push must be an explicit boolean.');
  if (push || requireMainTip) {
    const requestedRemote = remote ?? 'origin';
    if (typeof requestedRemote !== 'string' || requestedRemote.trim() === '' || requestedRemote.startsWith('-')) {
      throw new Error('Source candidate remote must be a non-empty URL, path, or remote name.');
    }
    if (/^[a-z][a-z\d+.-]*:\/\/[^/\s?#]*@/iu.test(requestedRemote)) {
      throw new Error('Source candidate remote must not contain embedded credentials.');
    }
  }
  if (product !== 'catalog' && Object.keys(pluginBaseVersions).length !== 0) {
    throw new Error('Plugin base versions only apply to Catalog source candidates.');
  }
  const source = await resolveMainSource({ repoRoot, candidateHead: sourceHead, product, mainRef });
  if (source.sourceHead !== source.candidateHead) throw new Error('Candidate preparation requires a commit on main.');
  const branch = `release-source/${product}/${version}`;
  const pushRemote = push ? remote ?? 'origin' : undefined;
  if (requireMainTip) await assertMainTip(repoRoot, remote ?? 'origin', source.sourceHead);
  await assertRefsAvailable(repoRoot, branch, tag, pushRemote);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-source-candidate-'));
  const checkout = path.join(temporaryRoot, 'repository');
  try {
    await git(repoRoot, ['clone', '--no-hardlinks', '--no-checkout', '--', path.resolve(repoRoot), checkout]);
    await git(checkout, ['checkout', '--detach', source.sourceHead]);
    if (product === 'cli') {
      await setReleaseTargets({ cli: version.split('-', 1)[0] }, { repoRoot: checkout });
    } else {
      if (Object.keys(pluginBaseVersions).length > 0) {
        await setReleaseTargets({ plugins: pluginBaseVersions }, { repoRoot: checkout });
      }
      await mutate(checkout, version);
    }
    await git(checkout, ['add', '-A']);
    const changes = (await git(checkout, ['diff', '--cached', '--name-only', '-z'])).stdout;
    if (changes !== '') {
      await git(checkout, [
        '-c', 'user.name=AW Release', '-c', 'user.email=aw-release@users.noreply.github.com',
        '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null',
        'commit', '-m', `chore(release): prepare ${product} ${version}`,
      ]);
    }
    const candidateHead = await resolveCommit(checkout, 'HEAD');
    await assertVersionOnlyDiff(checkout, source.sourceHead, candidateHead, product);
    await assertCandidateMetadata(checkout, candidateHead, parsed);
    await git(checkout, ['branch', branch, candidateHead]);
    await git(checkout, [
      '-c', 'user.name=AW Release', '-c', 'user.email=aw-release@users.noreply.github.com',
      '-c', 'tag.gpgSign=false', 'tag',
      ...ciRun === undefined ? [] : ['--annotate', '--message', `Automatic beta\n\nAW-CI: ${ciRun}`],
      tag, candidateHead,
    ]);
    await assertRefsAvailable(repoRoot, branch, tag, pushRemote);
    await git(repoRoot, [
      'fetch', '--atomic', '--no-tags', checkout,
      `refs/heads/${branch}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    if (push) {
      if (requireMainTip) await assertMainTip(repoRoot, pushRemote, source.sourceHead);
      await git(repoRoot, ['push', '--atomic', '--no-follow-tags', pushRemote, `refs/heads/${branch}`, `refs/tags/${tag}`]);
    }
    return { ...parsed, sourceHead: source.sourceHead, candidateHead, branch, tag };
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}
