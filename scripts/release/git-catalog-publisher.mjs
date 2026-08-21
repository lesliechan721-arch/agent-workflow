import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadCatalogModules } from './common.mjs';
import { calculateCatalogContentDigest } from './release-model.mjs';

const execFileAsync = promisify(execFile);
const PRIVATE_CATALOG_REMOTE = 'aw-catalog-publication';

const SAFE_GIT_CONFIG_ARGS = [
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'core.autocrlf=false',
  '-c', 'core.eol=lf',
  '-c', 'core.symlinks=true',
  '-c', `core.attributesFile=${os.devNull}`,
  '-c', `core.excludesFile=${os.devNull}`,
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
];

export const CATALOG_CHANNEL_REFS = {
  latest: 'refs/heads/catalog/latest',
  beta: 'refs/heads/catalog/beta',
};
// This internal branch is a remote mutex, not release history. A publisher creates it
// only when absent, verifies its unique owner commit, and deletes it without force.
// The lease spans history read through the final tag/channel transition, so beta,
// latest, bootstrap, tag-first recovery, and promotion cannot stage from split history.
// Tag-first also atomically creates the persistent pending ref below with its immutable
// tag. It blocks every other catalog version across failed CLI-publish retries, and
// promotion atomically advances the channel and deletes that guard without fallback.
export const CATALOG_PUBLICATION_LOCK_REF =
  'refs/heads/aw-release/publication-lock';
export const CATALOG_TAG_FIRST_PENDING_REF =
  'refs/heads/aw-release/tag-first-pending';
export const OFFICIAL_CATALOG_PUBLISH_REMOTE =
  'https://github.com/lesliechan721-arch/agent-workflow.git';

function assertSafeRemoteUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    throw new Error('Catalog publish remote URL is required.');
  }
  let parsed;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    if (path.isAbsolute(remoteUrl) || /^[^/\s]+@[^:]+:.+$/.test(remoteUrl)) return remoteUrl;
    throw new Error('Invalid catalog publish remote URL.');
  }
  if (parsed.password || ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username)) {
    throw new Error('Catalog publish remote URL must not contain an embedded token or password.');
  }
  if (!['http:', 'https:', 'ssh:', 'file:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported catalog publish remote protocol ${JSON.stringify(parsed.protocol)}.`);
  }
  return remoteUrl;
}

function gitEnvironment(env = process.env, privateConfigPath) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === 'GIT_DIR'
      || key === 'GIT_COMMON_DIR'
      || key === 'GIT_WORK_TREE'
      || key === 'GIT_INDEX_FILE'
      || key === 'GIT_OBJECT_DIRECTORY'
      || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
      || key === 'GIT_DEFAULT_HASH'
      || key === 'GIT_NAMESPACE'
      || key === 'GIT_CONFIG'
      || key === 'GIT_CONFIG_COUNT'
      || key === 'GIT_CONFIG_PARAMETERS'
      || key === 'GIT_EXEC_PATH'
      || key === 'GIT_SSH'
      || key === 'GIT_SSH_COMMAND'
      || key === 'GIT_ASKPASS'
      || key === 'SSH_ASKPASS'
      || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)
    ) delete next[key];
  }
  if (privateConfigPath) {
    delete next.GIT_CONFIG_GLOBAL;
    delete next.GIT_CONFIG_SYSTEM;
    delete next.GIT_CONFIG_NOSYSTEM;
    next.GIT_CONFIG_GLOBAL = privateConfigPath;
    next.GIT_CONFIG_NOSYSTEM = '1';
  }
  return {
    ...next,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    GIT_ATTR_NOSYSTEM: '1',
  };
}

export async function runCatalogGit(args, options = {}) {
  const execute = options.execFile ?? execFileAsync;
  try {
    const result = await execute('git', [...SAFE_GIT_CONFIG_ARGS, ...args], {
      cwd: options.cwd,
      env: gitEnvironment(options.env, options.privateConfigPath),
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs ?? 2 * 60 * 1000,
      killSignal: 'SIGTERM',
    });
    return {
      stdout: String(result?.stdout ?? ''),
      stderr: String(result?.stderr ?? ''),
    };
  } catch (error) {
    const detail = String(error?.stderr ?? error?.stdout ?? '').trim();
    throw new Error(
      detail
        ? `${detail}\nCatalog Git command failed: git ${args.join(' ')}`
        : `Catalog Git command failed: git ${args.join(' ')}`,
      { cause: error },
    );
  }
}

function parseExternalConfig(stdout) {
  const records = stdout.split('\0');
  const entries = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const scope = records[index];
    const record = records[index + 1];
    if (!scope || !record || (scope !== 'system' && scope !== 'global')) continue;
    const separator = record.indexOf('\n');
    const key = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? '' : record.slice(separator + 1);
    if (/^include(?:if\..+)?\.path$/i.test(key)) continue;
    entries.push([key, value]);
  }
  return entries;
}

async function freezeExternalGitConfig(git, privateConfigPath) {
  const { stdout } = await git([
    'config',
    '--null',
    '--show-scope',
    '--includes',
    '--list',
  ]);
  await fs.writeFile(privateConfigPath, '', { mode: 0o600 });
  for (const [key, value] of parseExternalConfig(stdout)) {
    await git(['config', '--file', privateConfigPath, '--add', key, value]);
  }
  await fs.chmod(privateConfigPath, 0o600);
}

async function withTemporaryRepository(callback, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publish-'));
  try {
    const repositoryRoot = path.join(root, 'repository');
    const templateRoot = path.join(root, 'empty-template');
    await fs.mkdir(repositoryRoot);
    await fs.mkdir(templateRoot);
    const invokeGit = (args, gitOptions = {}) => (options.runGit ?? runCatalogGit)(args, {
      cwd: repositoryRoot,
      ...(options.env ? { env: options.env } : {}),
      ...gitOptions,
    });
    await invokeGit([
      'init',
      '--quiet',
      '--object-format=sha1',
      `--template=${templateRoot}`,
    ]);
    const privateConfigPath = path.join(root, 'git-config');
    await freezeExternalGitConfig(invokeGit, privateConfigPath);
    await invokeGit([
      'config', '--file', privateConfigPath, '--replace-all', 'core.symlinks', 'true',
    ]);
    const git = (args, gitOptions = {}) => invokeGit(args, {
      privateConfigPath,
      ...gitOptions,
    });
    return await callback({ root, repositoryRoot, git });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function parseLsRemote(stdout) {
  const refs = new Map();
  for (const line of stdout.trim().split('\n')) {
    if (!line) continue;
    const [objectId, ref] = line.split(/\s+/, 2);
    if (!/^[0-9a-f]{40,64}$/.test(objectId ?? '') || !ref) {
      throw new Error('Catalog remote returned malformed ref data.');
    }
    refs.set(ref, objectId);
  }
  return refs;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isPublicationLeaseContention(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('aw-release/publication-lock')
    && (message.includes('fetch first') || message.includes('non-fast-forward'));
}

async function readRemoteRef(git, remote, ref) {
  const { stdout } = await git(['ls-remote', remote, ref]);
  return parseLsRemote(stdout).get(ref) ?? null;
}

async function releaseCatalogPublicationLease(git, remote, ownerCommit, options) {
  const timeoutMs = options.publicationLockReleaseTimeoutMs
    ?? options.publicationLockTimeoutMs
    ?? 30_000;
  const pollIntervalMs = options.publicationLockReleasePollIntervalMs
    ?? options.publicationLockPollIntervalMs
    ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastObservedRef = 'not observed';
  let lastError = null;
  let deleteAccepted = false;

  while (true) {
    try {
      const current = await readRemoteRef(git, remote, CATALOG_PUBLICATION_LOCK_REF);
      lastObservedRef = current ?? 'absent';
      if (current === null) return;
      if (current !== ownerCommit) {
        if (deleteAccepted) return;
        if (options.allowDifferentOwner) return;
        throw new Error(
          `Catalog publication lease owner changed before release: expected ${ownerCommit}, found ${current}.`,
        );
      }
      try {
        await git(['push', remote, `:${CATALOG_PUBLICATION_LOCK_REF}`]);
        deleteAccepted = true;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(
        'Catalog publication lease owner changed before release:',
      )) {
        throw error;
      }
      lastError = error;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms releasing catalog publication lease ` +
        `${CATALOG_PUBLICATION_LOCK_REF}; last observed ref state: ${lastObservedRef}.`,
        { cause: lastError ?? undefined },
      );
    }
    await delay(pollIntervalMs);
  }
}

export async function withCatalogPublicationLease(remoteUrlInput, callback, options = {}) {
  const remoteUrl = assertSafeRemoteUrl(remoteUrlInput ?? OFFICIAL_CATALOG_PUBLISH_REMOTE);
  const timeoutMs = options.publicationLockTimeoutMs ?? 30_000;
  const pollIntervalMs = options.publicationLockPollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  return withTemporaryRepository(async ({ git }) => {
    const remote = await bindCatalogRemote(git, remoteUrl);
    await listRemoteRefs(git, remote, '__publication-lock-probe__', { validatePending: false });
    await git(['checkout', '--quiet', '--orphan', 'catalog-publication-lock']);
    const ownerToken = crypto.randomUUID();
    await git([
      '-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '--allow-empty', '-m', `Catalog publication lease ${ownerToken}`,
    ]);
    const { stdout: ownerOutput } = await git(['rev-parse', 'HEAD']);
    const ownerCommit = ownerOutput.trim();
    let ownerConfirmed = false;
    let operationError = null;
    try {
      while (!ownerConfirmed) {
        await options.beforeAcquire?.();
        let pushError = null;
        try {
          await git(['push', remote, `${ownerCommit}:${CATALOG_PUBLICATION_LOCK_REF}`]);
        } catch (error) {
          pushError = error;
        }

        let existing;
        while (true) {
          try {
            existing = await readRemoteRef(git, remote, CATALOG_PUBLICATION_LOCK_REF);
            break;
          } catch (error) {
            if (Date.now() >= deadline) {
              throw new Error(
                `Timed out after ${timeoutMs}ms confirming catalog publication lease ` +
                `${CATALOG_PUBLICATION_LOCK_REF}.`,
                { cause: error },
              );
            }
            await delay(pollIntervalMs);
          }
        }
        if (existing === ownerCommit) {
          ownerConfirmed = true;
          break;
        }
        if (!pushError) {
          throw new Error('Catalog publication lease owner changed immediately after acquisition.');
        }
        if (!existing && !isPublicationLeaseContention(pushError)) throw pushError;
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out after ${timeoutMs}ms waiting for catalog publication lease ${CATALOG_PUBLICATION_LOCK_REF}. ` +
            'A stale lease requires offline operator inspection.',
            { cause: pushError },
          );
        }
        await delay(pollIntervalMs);
      }

      return await callback({ ref: CATALOG_PUBLICATION_LOCK_REF, ownerCommit, remoteUrl });
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      try {
        await releaseCatalogPublicationLease(git, remote, ownerCommit, {
          ...options,
          allowDifferentOwner: !ownerConfirmed,
        });
      } catch (releaseError) {
        if (operationError) {
          throw new AggregateError(
            [operationError, releaseError],
            `${operationError.message} (catalog publication lease release also failed: ${releaseError.message})`,
            { cause: operationError },
          );
        }
        throw releaseError;
      }
    }
  }, options);
}

async function bindCatalogRemote(git, remoteUrl) {
  await git(['config', '--local', `remote.${PRIVATE_CATALOG_REMOTE}.url`, remoteUrl]);
  const [{ stdout: fetchOutput }, { stdout: pushOutput }] = await Promise.all([
    git(['remote', 'get-url', '--all', PRIVATE_CATALOG_REMOTE]),
    git(['remote', 'get-url', '--push', '--all', PRIVATE_CATALOG_REMOTE]),
  ]);
  const fetchUrls = fetchOutput.trim().split('\n').filter(Boolean);
  const pushUrls = pushOutput.trim().split('\n').filter(Boolean);
  if (fetchUrls.length !== 1 || fetchUrls[0] !== remoteUrl) {
    throw new Error(
      'Catalog publish remote fetch URL was rewritten by Git configuration; refusing to contact a different remote.',
    );
  }
  if (pushUrls.length !== 1 || pushUrls[0] !== remoteUrl) {
    throw new Error(
      'Catalog publish remote push URL was rewritten by Git configuration; refusing to write a different remote.',
    );
  }
  return PRIVATE_CATALOG_REMOTE;
}

async function listRemoteRefs(git, remote, catalogVersion, options = {}) {
  const tagRef = `refs/tags/catalog-v${catalogVersion}`;
  const { stdout } = await git([
    'ls-remote',
    remote,
    CATALOG_CHANNEL_REFS.latest,
    CATALOG_CHANNEL_REFS.beta,
    CATALOG_TAG_FIRST_PENDING_REF,
    tagRef,
    `${tagRef}^{}`,
    `refs/tags/catalog-v${catalogVersion}-beta.*`,
  ]);
  const refs = parseLsRemote(stdout);
  const pending = refs.get(CATALOG_TAG_FIRST_PENDING_REF) ?? null;
  const tagCandidates = [];
  const escapedVersion = catalogVersion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const candidatePattern = new RegExp(`^refs/tags/catalog-v(${escapedVersion}(?:-beta\\.[1-9]\\d*)?)$`, 'u');
  for (const [ref, objectId] of refs) {
    const match = candidatePattern.exec(ref);
    if (!match) continue;
    const peeledTagCommit = refs.get(`${ref}^{}`) ?? null;
    if (!peeledTagCommit) {
      throw new Error(`Catalog tag ${ref} exists but is not an annotated tag to a commit.`);
    }
    tagCandidates.push({ ref, objectId, commit: peeledTagCommit, catalogVersion: match[1] });
  }
  const exactTag = tagCandidates.find((entry) => entry.ref === tagRef) ?? null;
  const pendingTags = pending === null
    ? []
    : tagCandidates.filter((entry) => entry.commit === pending);
  if (options.validatePending !== false && pending !== null && pendingTags.length !== 1) {
    throw new Error(
      'Catalog tag-first publication is pending. Only recovery of that exact catalog version may continue; ' +
      `the guard does not identify one annotated tag for ${catalogVersion}.`,
    );
  }
  const tag = pending !== null ? pendingTags[0] : exactTag;
  return {
    heads: {
      latest: refs.get(CATALOG_CHANNEL_REFS.latest) ?? null,
      beta: refs.get(CATALOG_CHANNEL_REFS.beta) ?? null,
    },
    pending,
    tag,
    tagCandidates,
  };
}

async function fetchObject(git, remoteUrl, remoteRef, localRef) {
  await git(['fetch', '--quiet', '--no-tags', remoteUrl, `${remoteRef}:${localRef}`]);
}

async function assertCommitHasNoAttributes(git, commit) {
  const { stdout } = await git(['ls-tree', '-r', '--name-only', '-z', commit]);
  const attributesPath = stdout
    .split('\0')
    .find((entry) => entry && entry.split('/').at(-1) === '.gitattributes');
  if (attributesPath) {
    throw new Error(
      `Published catalog commit must not contain .gitattributes (${attributesPath}).`,
    );
  }
}

async function checkoutIndexWithSymlinks(git, outputRoot) {
  const { stdout } = await git(['ls-files', '--stage', '-z']);
  const symlinkPaths = stdout
    .split('\0')
    .filter(Boolean)
    .flatMap((record) => {
      const separator = record.indexOf('\t');
      if (separator === -1) {
        throw new Error('Catalog Git index returned malformed staged entry data.');
      }
      return record.slice(0, separator).startsWith('120000 ')
        ? [record.slice(separator + 1)]
        : [];
    });
  const symlinkFailure = (relativePath, cause) => {
    const message =
      'Catalog publisher requires filesystem symbolic-link support to materialize Git mode ' +
      `120000 at ${relativePath}; refusing to fall back to a regular file.`;
    return cause === undefined ? new Error(message) : new Error(message, { cause });
  };
  try {
    await git(['checkout-index', '--all', '--force', '--prefix', `${outputRoot}${path.sep}`]);
  } catch (error) {
    if (symlinkPaths.length === 0) throw error;
    throw symlinkFailure(symlinkPaths[0], error);
  }
  for (const relativePath of symlinkPaths) {
    let stats;
    try {
      stats = await fs.lstat(path.join(outputRoot, ...relativePath.split('/')));
    } catch (error) {
      throw symlinkFailure(relativePath, error);
    }
    if (!stats.isSymbolicLink()) {
      throw symlinkFailure(relativePath);
    }
  }
}

async function materializeCommit(git, root, commit, label) {
  await assertCommitHasNoAttributes(git, commit);
  const snapshotRoot = path.join(root, label);
  await fs.mkdir(snapshotRoot);
  await git(['read-tree', commit]);
  await checkoutIndexWithSymlinks(git, snapshotRoot);
  return snapshotRoot;
}

async function validateSnapshotAndLedger(root, expectedChannel, catalogModules) {
  const validation = await catalogModules.catalogSnapshot.validateCatalogSnapshot(root);
  if (expectedChannel !== null && validation.manifest.channel !== expectedChannel) {
    throw new Error(
      `Catalog snapshot channel mismatch: expected ${expectedChannel}, found ${validation.manifest.channel}.`,
    );
  }
  const ledgerPath = path.join(root, 'plugin-release-ledger.json');
  let rawLedger;
  try {
    rawLedger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  } catch (error) {
    throw new Error(`Published ${expectedChannel ?? validation.manifest.channel} catalog is missing or has an invalid release ledger.`, {
      cause: error,
    });
  }
  const ledger = catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
    rawLedger,
    validation.manifest,
  );
  const marketplace = JSON.parse(await fs.readFile(
    path.join(root, '.agents', 'plugins', 'marketplace.json'),
    'utf8',
  ));
  const catalogContentDigest = calculateCatalogContentDigest({
    schemaIdentity: { schemaVersion: validation.manifest.schemaVersion },
    marketplaceMetadata: {
      name: marketplace.name,
      owner: marketplace.owner,
      interface: marketplace.interface,
    },
    compatibility: validation.manifest.compatibility,
    plugins: validation.manifest.entries.map((entry) => ({
      name: entry.name,
      targetVersion: entry.version.replace(/-beta\.[1-9]\d*$/u, ''),
      contentDigest: entry.contentDigest,
    })),
  });
  return { ...validation, ledger, catalogContentDigest };
}

export async function readCatalogPublicationHistory(options) {
  const remoteUrl = assertSafeRemoteUrl(
    options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE,
  );
  const catalogModules = options.catalogModules ?? await loadCatalogModules(options.cliDistRoot);
  return withTemporaryRepository(async ({ root, git }) => {
    const remote = await bindCatalogRemote(git, remoteUrl);
    const remoteRefs = await listRemoteRefs(git, remote, options.catalogVersion);
    const channels = {};
    for (const mode of ['latest', 'beta']) {
      const commit = remoteRefs.heads[mode];
      if (!commit) {
        channels[mode] = null;
        continue;
      }
      const localRef = `refs/remotes/catalog/${mode}`;
      await fetchObject(git, remote, CATALOG_CHANNEL_REFS[mode], localRef);
      const snapshotRoot = await materializeCommit(git, root, commit, `channel-${mode}`);
      channels[mode] = {
        commit,
        ...await validateSnapshotAndLedger(snapshotRoot, mode, catalogModules),
      };
    }
    if (!remoteRefs.pending) {
      const unguardedTag = remoteRefs.tagCandidates.find((candidate) => {
        const mode = candidate.catalogVersion.includes('-beta.') ? 'beta' : 'latest';
        const channel = channels[mode];
        if (channel?.commit === candidate.commit) return false;
        if (!channel) return true;
        return catalogModules.pluginStaging.compareStrictSemVer(
          candidate.catalogVersion,
          channel.manifest.catalogVersion,
        ) >= 0;
      });
      if (unguardedTag) {
        throw new Error(
          `Catalog tag ${unguardedTag.ref} is ahead of its channel without the tag-first pending guard.`,
        );
      }
    }

    let tag = null;
    if (remoteRefs.tag) {
      const localRef = remoteRefs.tag.ref;
      await fetchObject(git, remote, remoteRefs.tag.ref, localRef);
      const { stdout: typeOutput } = await git(['cat-file', '-t', localRef]);
      if (typeOutput.trim() !== 'tag') {
        throw new Error(`Catalog tag ${remoteRefs.tag.ref} must be annotated.`);
      }
      const { stdout: commitType } = await git(['cat-file', '-t', `${localRef}^{}`]);
      if (commitType.trim() !== 'commit') {
        throw new Error(`Catalog tag ${remoteRefs.tag.ref} must point to a snapshot commit.`);
      }
      const snapshotRoot = await materializeCommit(
        git,
        root,
        remoteRefs.tag.commit,
        'tag-snapshot',
      );
      const validation = await validateSnapshotAndLedger(
        snapshotRoot,
        options.mode ?? null,
        catalogModules,
      );
      if (validation.manifest.catalogVersion !== remoteRefs.tag.catalogVersion) {
        throw new Error(`Catalog tag ${remoteRefs.tag.ref} contains the wrong catalog version.`);
      }
      tag = { ...remoteRefs.tag, ...validation };
    }
    if (remoteRefs.pending && (!tag || remoteRefs.pending !== tag.commit)) {
      throw new Error(
        `Catalog tag-first publication is pending at ${CATALOG_TAG_FIRST_PENDING_REF}. ` +
        'Only recovery of that exact catalog version may continue.',
      );
    }
    return {
      remoteUrl,
      catalogVersion: options.catalogVersion,
      mode: options.mode,
      channels,
      tag,
      pending: remoteRefs.pending,
      mergedLedger: catalogModules.pluginStaging.mergePluginReleaseLedgers(
        channels.latest?.ledger,
        channels.beta?.ledger,
      ),
      catalogModules,
    };
  }, options);
}

export function resolveCatalogStageLedger(history) {
  return history.tag?.ledger ?? history.mergedLedger;
}

function assertUnchangedRemote(expected, actual) {
  for (const mode of ['latest', 'beta']) {
    if ((expected.channels[mode]?.commit ?? null) !== actual.heads[mode]) {
      throw new Error(`Catalog ${mode} channel advanced after release history was read.`);
    }
  }
  const expectedTag = expected.tag?.objectId ?? null;
  const actualTag = actual.tag?.objectId ?? null;
  if (expectedTag !== actualTag) {
    throw new Error('Catalog version tag changed after release history was read.');
  }
  if ((expected.pending ?? null) !== actual.pending) {
    throw new Error('Catalog tag-first pending state changed after release history was read.');
  }
}

async function clearRepositoryWorktree(repositoryRoot) {
  for (const entry of await fs.readdir(repositoryRoot)) {
    if (entry !== '.git') {
      await fs.rm(path.join(repositoryRoot, entry), { recursive: true, force: true });
    }
  }
}

function normalizedLedgerJson(ledger) {
  return JSON.stringify(ledger);
}

async function listPublicationTree(root, relativeRoot = '') {
  const result = [];
  const absoluteRoot = path.join(root, relativeRoot);
  for (const entry of (await fs.readdir(absoluteRoot, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (relativeRoot === '' && entry.name === '.git') continue;
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const absolutePath = path.join(root, relativePath);
    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      result.push({
        path: relativePath,
        kind: 'symlink',
        mode: '120000',
        target: await fs.readlink(absolutePath),
      });
      continue;
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`Catalog publication tree contains unsupported path ${relativePath}.`);
    }
    if (stats.isDirectory()) {
      result.push({ path: relativePath, kind: 'directory', mode: '040000' });
      result.push(...await listPublicationTree(root, relativePath));
      continue;
    }
    result.push({
      path: relativePath,
      kind: 'file',
      mode: (stats.mode & 0o100) === 0 ? '100644' : '100755',
      contents: await fs.readFile(absolutePath),
    });
  }
  return result;
}

async function assertNoPublicationAttributes(root, relativeRoot = '') {
  const absoluteRoot = path.join(root, relativeRoot);
  for (const entry of await fs.readdir(absoluteRoot, { withFileTypes: true })) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.name === '.gitattributes') {
      throw new Error(
        `Catalog publication snapshot must not contain .gitattributes (${relativePath}).`,
      );
    }
    if (entry.isDirectory()) {
      await assertNoPublicationAttributes(root, relativePath);
    }
  }
}

async function assertPublicationTreesEqual(expectedRoot, actualRoot) {
  const [expected, actual] = await Promise.all([
    listPublicationTree(expectedRoot),
    listPublicationTree(actualRoot),
  ]);
  if (expected.length !== actual.length) {
    throw new Error('Catalog commit tree does not match the complete staged publication tree.');
  }
  for (let index = 0; index < expected.length; index += 1) {
    const expectedEntry = expected[index];
    const actualEntry = actual[index];
    if (
      expectedEntry.path !== actualEntry.path
      || expectedEntry.kind !== actualEntry.kind
      || expectedEntry.mode !== actualEntry.mode
      || (
        expectedEntry.kind === 'symlink'
        && expectedEntry.target !== actualEntry.target
      )
      || (
        expectedEntry.kind === 'file'
        && !expectedEntry.contents.equals(actualEntry.contents)
      )
    ) {
      throw new Error(
        `Catalog commit tree differs from staged bytes at ${expectedEntry.path}.`,
      );
    }
  }
}

function assertCandidate(history, validation, ledger) {
  const manifest = validation.manifest;
  if (manifest.catalogVersion !== history.catalogVersion || manifest.channel !== history.mode) {
    throw new Error(
      `Staged catalog identity mismatch: expected ${history.catalogVersion} (${history.mode}).`,
    );
  }
  const current = history.channels[history.mode];
  if (current) {
    const relation = history.catalogModules.pluginStaging.compareStrictSemVer(
      manifest.catalogVersion,
      current.manifest.catalogVersion,
    );
    if (relation < 0) {
      throw new Error(
        `Catalog ${history.mode} version ${manifest.catalogVersion} must not be lower than published ${current.manifest.catalogVersion}.`,
      );
    }
    if (relation === 0 && validation.snapshotDigest !== current.snapshotDigest) {
      throw new Error(`Catalog ${manifest.catalogVersion} is already published with different runtime content.`);
    }
  }
  if (history.tag && validation.snapshotDigest !== history.tag.snapshotDigest) {
    throw new Error(`Catalog tag refs/tags/catalog-v${manifest.catalogVersion} maps to different runtime content.`);
  }
  if (
    history.tag
    && normalizedLedgerJson(ledger) !== normalizedLedgerJson(history.tag.ledger)
  ) {
    throw new Error(
      `Catalog tag refs/tags/catalog-v${manifest.catalogVersion} release ledger differs; use a new catalogVersion.`,
    );
  }
}

async function prepareLocalPublication(history, stagedRoot, options = {}) {
  await assertNoPublicationAttributes(stagedRoot);
  const validation = await history.catalogModules.catalogSnapshot.validateCatalogSnapshot(stagedRoot);
  const ledger = history.catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
    JSON.parse(await fs.readFile(path.join(stagedRoot, 'plugin-release-ledger.json'), 'utf8')),
    validation.manifest,
  );
  assertCandidate(history, validation, ledger);

  return withTemporaryRepository(async ({ root, repositoryRoot, git }) => {
    const remote = await bindCatalogRemote(git, history.remoteUrl);
    const actual = await listRemoteRefs(git, remote, history.catalogVersion);
    assertUnchangedRemote(history, actual);
    for (const mode of ['latest', 'beta']) {
      if (history.channels[mode]) {
        await fetchObject(
          git,
          remote,
          CATALOG_CHANNEL_REFS[mode],
          `refs/remotes/catalog/${mode}`,
        );
      }
    }
    const tagRef = `refs/tags/catalog-v${history.catalogVersion}`;
    if (history.tag) {
      await fetchObject(git, remote, tagRef, tagRef);
      return callbackPublication({
        git,
        remote,
        tagRef,
        commit: history.tag.commit,
        validation,
        ledger,
        existingTag: true,
      });
    }

    const parent = history.channels[history.mode]?.commit ?? null;
    if (parent) {
      await git(['checkout', '--quiet', '--detach', parent]);
    } else {
      await git(['checkout', '--quiet', '--orphan', 'catalog-publication']);
    }
    await clearRepositoryWorktree(repositoryRoot);
    await fs.cp(stagedRoot, repositoryRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await assertNoPublicationAttributes(repositoryRoot);
    await git(['add', '--force', '--all']);
    await git([
      '-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '-m', `Catalog ${history.catalogVersion} (${history.mode})`,
    ]);
    const { stdout } = await git(['rev-parse', 'HEAD']);
    const commit = stdout.trim();
    const verificationRoot = await fs.mkdtemp(path.join(root, 'commit-verification-'));
    await assertCommitHasNoAttributes(git, commit);
    await git(['read-tree', commit]);
    await checkoutIndexWithSymlinks(git, verificationRoot);
    const committed = await validateSnapshotAndLedger(
      verificationRoot,
      history.mode,
      history.catalogModules,
    );
    if (
      committed.snapshotDigest !== validation.snapshotDigest
      || normalizedLedgerJson(committed.ledger) !== normalizedLedgerJson(ledger)
    ) {
      throw new Error('Materialized catalog commit failed schema 3 or release ledger verification.');
    }
    await assertPublicationTreesEqual(stagedRoot, verificationRoot);
    await git([
      '-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'tag', '--annotate', `catalog-v${history.catalogVersion}`,
      '--message', `Catalog ${history.catalogVersion} (${history.mode})`,
      commit,
    ]);
    return callbackPublication({
      git,
      remote,
      tagRef,
      commit,
      validation,
      ledger,
      existingTag: false,
    });
  }, options);

  async function callbackPublication(context) {
    return options.callback(context);
  }
}

async function publishStagedCatalogUnderLease(history, stagedRoot, options) {
  const publicationMode = options.publicationMode ?? 'atomic';
  return prepareLocalPublication(history, stagedRoot, {
    ...options,
    callback: async (context) => {
      const channelRef = CATALOG_CHANNEL_REFS[history.mode];
      const current = history.channels[history.mode];
      if (publicationMode === 'tag' && context.existingTag && !history.pending) {
        throw new Error(
          'Existing catalog tag has no tag-first pending guard; refusing to recreate recovery state.',
        );
      }
      if (current?.commit === context.commit) {
        return { ...context, mode: history.mode, idempotent: true, promoted: true };
      }
      if (publicationMode === 'tag') {
        if (!context.existingTag) {
          await options.beforeRemoteWrite?.();
          try {
            await context.git([
              'push', '--atomic', context.remote,
              `${context.tagRef}:${context.tagRef}`,
              `${context.commit}:${CATALOG_TAG_FIRST_PENDING_REF}`,
            ]);
          } catch (error) {
            throw new Error(
              'Atomic tag-first catalog publication failed. The publisher did not fall back to sequential pushes.',
              { cause: error },
            );
          }
        }
        return { ...context, mode: history.mode, idempotent: context.existingTag, promoted: false };
      }
      if (publicationMode !== 'atomic') {
        throw new Error(`Unknown catalog publication mode ${JSON.stringify(publicationMode)}.`);
      }
      if (history.pending) {
        throw new Error(
          'Catalog tag-first publication is pending; use the combined release or fixed promotion recovery entry point.',
        );
      }
      const refspecs = [`${context.commit}:${channelRef}`];
      if (!context.existingTag) refspecs.push(`${context.tagRef}:${context.tagRef}`);
      await options.beforeRemoteWrite?.();
      try {
        await context.git(['push', '--atomic', context.remote, ...refspecs]);
      } catch (error) {
        throw new Error(
          'Atomic catalog publication failed. The publisher did not fall back to sequential pushes.',
          { cause: error },
        );
      }
      return { ...context, mode: history.mode, idempotent: false, promoted: true };
    },
  });
}

export async function publishStagedCatalog(history, stagedRoot, options = {}) {
  if (options.publicationLease) {
    return publishStagedCatalogUnderLease(history, stagedRoot, options);
  }
  return withCatalogPublicationLease(
    history.remoteUrl,
    (publicationLease) => publishStagedCatalogUnderLease(history, stagedRoot, {
      ...options,
      publicationLease,
    }),
    options,
  );
}

async function promoteCatalogTagUnderLease(options) {
  const history = await readCatalogPublicationHistory(options);
  if (!history.tag) {
    throw new Error(`Catalog tag refs/tags/catalog-v${options.catalogVersion} does not exist.`);
  }
  const current = history.channels[options.mode];
  if (current) {
    const relation = history.catalogModules.pluginStaging.compareStrictSemVer(
      history.tag.manifest.catalogVersion,
      current.manifest.catalogVersion,
    );
    if (relation < 0) {
      throw new Error('Catalog promotion would move the channel to a lower version.');
    }
    if (relation === 0 && history.tag.snapshotDigest !== current.snapshotDigest) {
      throw new Error('Catalog promotion would replace same-version runtime content.');
    }
  }
  if (
    history.catalogModules.pluginStaging.compareStrictSemVer(
      options.currentCliVersion,
      history.tag.manifest.compatibility.aw.minVersion,
    ) < 0
  ) {
    throw new Error(
      `Catalog ${options.catalogVersion} requires aw >= ${history.tag.manifest.compatibility.aw.minVersion}, but published ${options.mode} CLI is ${options.currentCliVersion}.`,
    );
  }
  if (current?.commit === history.tag.commit) {
    if (history.pending) {
      await withTemporaryRepository(async ({ git }) => {
        const remote = await bindCatalogRemote(git, history.remoteUrl);
        const actual = await listRemoteRefs(git, remote, history.catalogVersion);
        assertUnchangedRemote(history, actual);
        await options.beforeRemoteWrite?.();
        await git(['push', remote, `:${CATALOG_TAG_FIRST_PENDING_REF}`]);
      }, options);
    }
    return { mode: options.mode, commit: history.tag.commit, promoted: true, idempotent: true };
  }
  return withTemporaryRepository(async ({ git }) => {
    const remote = await bindCatalogRemote(git, history.remoteUrl);
    const actual = await listRemoteRefs(git, remote, history.catalogVersion);
    assertUnchangedRemote(history, actual);
    await fetchObject(git, remote, history.tag.ref, history.tag.ref);
    if (current) {
      await fetchObject(
        git,
        remote,
        CATALOG_CHANNEL_REFS[options.mode],
        `refs/remotes/catalog/${options.mode}`,
      );
      try {
        await git(['merge-base', '--is-ancestor', current.commit, history.tag.commit]);
      } catch (error) {
        throw new Error('Catalog promotion is not a fast-forward.', { cause: error });
      }
    }
    const promotionRefspecs = [
      `${history.tag.commit}:${CATALOG_CHANNEL_REFS[options.mode]}`,
    ];
    if (history.pending) promotionRefspecs.push(`:${CATALOG_TAG_FIRST_PENDING_REF}`);
    await options.beforeRemoteWrite?.();
    try {
      await git([
        'push',
        ...(history.pending ? ['--atomic'] : []),
        remote,
        ...promotionRefspecs,
      ]);
    } catch (error) {
      if (history.pending) {
        throw new Error(
          'Atomic catalog promotion and tag-first pending-state cleanup failed. The publisher did not fall back.',
          { cause: error },
        );
      }
      throw error;
    }
    return { mode: options.mode, commit: history.tag.commit, promoted: true, idempotent: false };
  }, options);
}

export async function promoteCatalogTag(options) {
  if (options.publicationLease) return promoteCatalogTagUnderLease(options);
  const remoteUrl = options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE;
  return withCatalogPublicationLease(
    remoteUrl,
    (publicationLease) => promoteCatalogTagUnderLease({ ...options, publicationLease }),
    options,
  );
}

export function catalogPromotionRecoveryCommand(mode, catalogVersion) {
  return `pnpm run release:promote:catalog:${mode} -- --catalog-version ${catalogVersion}`;
}
