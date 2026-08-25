import path from 'node:path';

import {
  assertPublishedPackageTarballMatchesCandidate,
  assertValidVersion,
  cliPackageJsonPath,
  corePackageJsonPath,
  evalPackageJsonPath,
  repoRoot as defaultRepoRoot,
  runReleaseGit,
} from './common.mjs';

const CLI_PACKAGES = new Map([
  ['@lesliechan721/agent-skill-eval', evalPackageJsonPath],
  ['@lesliechan721/aw-plugin-core', corePackageJsonPath],
  ['@lesliechan721/aw', cliPackageJsonPath],
]);

export function cliTagName(version) {
  assertValidVersion(version);
  return `cli-v${version}`;
}

function tagRef(version) {
  return `refs/tags/${cliTagName(version)}`;
}

function assertSourceHead(sourceHead) {
  if (typeof sourceHead !== 'string' || !/^[0-9a-f]{40,64}$/u.test(sourceHead)) {
    throw new Error('CLI tag requires a valid release source commit.');
  }
}

async function readRemoteCliTag(version, options = {}) {
  const ref = tagRef(version);
  const remote = options.remote ?? 'origin';
  const result = await (options.runGit ?? runReleaseGit)([
    'ls-remote', '--tags', remote, ref, `${ref}^{}`,
  ], { cwd: options.repoRoot ?? defaultRepoRoot, ...options });
  const refs = new Map(result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [object, name] = line.split('\t');
    return [name, object];
  }));
  if (refs.size === 0) return null;
  return {
    object: refs.get(ref) ?? null,
    commit: refs.get(`${ref}^{}`) ?? null,
  };
}

async function readLocalCliTag(version, options = {}) {
  const ref = tagRef(version);
  const runGit = options.runGit ?? runReleaseGit;
  const result = await runGit([
    'for-each-ref', '--format=%(objecttype) %(objectname)', ref,
  ], { cwd: options.repoRoot ?? defaultRepoRoot, ...options });
  const value = result.stdout.trim();
  if (!value) return null;
  const [type, object] = value.split(' ');
  const commit = (await runGit([
    'rev-parse', '--verify', `${ref}^{commit}`,
  ], { cwd: options.repoRoot ?? defaultRepoRoot, ...options })).stdout.trim();
  return { type, object, commit };
}

function assertExpectedRemoteTag(remoteTag, sourceHead, version) {
  if (!remoteTag) return false;
  if (remoteTag.commit === sourceHead) return true;
  throw new Error(
    `CLI tag ${cliTagName(version)} already exists and does not point to the prepared source commit.`,
  );
}

export async function assertCliTagAvailable(version, options = {}) {
  const [remoteTag, localTag] = await Promise.all([
    (options.readRemoteTag ?? readRemoteCliTag)(version, options),
    (options.readLocalTag ?? readLocalCliTag)(version, options),
  ]);
  if (remoteTag || localTag) {
    throw new Error(
      `CLI tag ${cliTagName(version)} already exists; use --repair-cli-tag only for the prepared published CLI.`,
    );
  }
}

export async function ensureCliTag(version, sourceHead, options = {}) {
  assertValidVersion(version);
  assertSourceHead(sourceHead);
  const readRemoteTag = options.readRemoteTag ?? readRemoteCliTag;
  const readLocalTag = options.readLocalTag ?? readLocalCliTag;
  const existingRemote = await readRemoteTag(version, options);
  if (assertExpectedRemoteTag(existingRemote, sourceHead, version)) {
    return { version, sourceHead, status: 'already-published' };
  }

  const runGit = options.runGit ?? runReleaseGit;
  const local = await readLocalTag(version, options);
  if (local) {
    if (local.type !== 'tag' || local.commit !== sourceHead) {
      throw new Error(
        `Local CLI tag ${cliTagName(version)} conflicts with the prepared source commit.`,
      );
    }
  } else {
    await runGit([
      '-c', 'user.name=Agent Workflows CLI Publisher',
      '-c', 'user.email=cli-publisher@agent-workflows.invalid',
      'tag', '--annotate', cliTagName(version), sourceHead,
      '--message', `CLI ${version}`,
    ], { cwd: options.repoRoot ?? defaultRepoRoot, ...options });
  }

  const remote = options.remote ?? 'origin';
  const ref = tagRef(version);
  try {
    await runGit(['push', remote, `${ref}:${ref}`], {
      cwd: options.repoRoot ?? defaultRepoRoot,
      ...options,
    });
  } catch (error) {
    const remoteTag = await readRemoteTag(version, options);
    if (assertExpectedRemoteTag(remoteTag, sourceHead, version)) {
      return { version, sourceHead, status: 'published' };
    }
    throw new Error(
      `CLI tag ${cliTagName(version)} push failed or its result is uncertain. ` +
      'Run pnpm release -- --repair-cli-tag with the unchanged prepared release.',
      { cause: error },
    );
  }
  const published = await readRemoteTag(version, options);
  if (!assertExpectedRemoteTag(published, sourceHead, version)) {
    throw new Error(`CLI tag ${cliTagName(version)} is missing after push.`);
  }
  return { version, sourceHead, status: 'published' };
}

function resolvePreparedPath(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || path.isAbsolute(relativePath)) {
    throw new Error('Prepared CLI artifact path is invalid.');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Prepared CLI artifact path escapes the prepared root.');
  }
  return resolved;
}

export async function assertPublishedCliArtifactsMatch(root, descriptor, options = {}) {
  if (!descriptor.axes?.cli || !descriptor.npm || typeof descriptor.candidates?.cli !== 'string') {
    throw new Error('The prepared release does not contain a CLI candidate.');
  }
  for (const artifact of descriptor.npm.packages) {
    const packageJsonPath = CLI_PACKAGES.get(artifact.name);
    if (!packageJsonPath) throw new Error(`Unknown prepared CLI package ${artifact.name}.`);
    await (options.assertPublishedPackageMatches
      ?? assertPublishedPackageTarballMatchesCandidate)(
      artifact.name,
      descriptor.candidates.cli,
      packageJsonPath,
      resolvePreparedPath(root, artifact.path),
      options,
    );
  }
}
