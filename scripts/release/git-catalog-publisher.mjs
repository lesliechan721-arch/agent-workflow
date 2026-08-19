import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadCatalogModules } from './common.mjs';

const execFileAsync = promisify(execFile);

export const CATALOG_CHANNEL_REFS = {
  latest: 'refs/heads/catalog/latest',
  beta: 'refs/heads/catalog/beta',
};
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

function gitEnvironment(env = process.env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (
      key === 'GIT_DIR'
      || key === 'GIT_COMMON_DIR'
      || key === 'GIT_WORK_TREE'
      || key === 'GIT_INDEX_FILE'
      || key === 'GIT_OBJECT_DIRECTORY'
      || key === 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
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
  return {
    ...next,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  };
}

export async function runCatalogGit(args, options = {}) {
  const execute = options.execFile ?? execFileAsync;
  try {
    const result = await execute('git', args, {
      cwd: options.cwd,
      env: gitEnvironment(options.env),
      maxBuffer: 16 * 1024 * 1024,
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

async function withTemporaryRepository(callback, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publish-'));
  try {
    const repositoryRoot = path.join(root, 'repository');
    await fs.mkdir(repositoryRoot);
    const git = (args, gitOptions = {}) => (options.runGit ?? runCatalogGit)(args, {
      cwd: repositoryRoot,
      ...gitOptions,
    });
    await git(['init', '--quiet']);
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

async function listRemoteRefs(git, remoteUrl, catalogVersion) {
  const tagRef = `refs/tags/catalog-v${catalogVersion}`;
  const { stdout } = await git([
    'ls-remote',
    remoteUrl,
    CATALOG_CHANNEL_REFS.latest,
    CATALOG_CHANNEL_REFS.beta,
    tagRef,
    `${tagRef}^{}`,
  ]);
  const refs = parseLsRemote(stdout);
  const tagObject = refs.get(tagRef) ?? null;
  const peeledTagCommit = refs.get(`${tagRef}^{}`) ?? null;
  if (tagObject && !peeledTagCommit) {
    throw new Error(`Catalog tag ${tagRef} exists but is not an annotated tag to a commit.`);
  }
  if (!tagObject && peeledTagCommit) {
    throw new Error(`Catalog tag ${tagRef} has invalid remote ref data.`);
  }
  return {
    heads: {
      latest: refs.get(CATALOG_CHANNEL_REFS.latest) ?? null,
      beta: refs.get(CATALOG_CHANNEL_REFS.beta) ?? null,
    },
    tag: tagObject ? { ref: tagRef, objectId: tagObject, commit: peeledTagCommit } : null,
  };
}

async function fetchObject(git, remoteUrl, remoteRef, localRef) {
  await git(['fetch', '--quiet', '--no-tags', remoteUrl, `${remoteRef}:${localRef}`]);
}

async function materializeCommit(git, root, commit, label) {
  const snapshotRoot = path.join(root, label);
  await fs.mkdir(snapshotRoot);
  await git(['read-tree', commit]);
  await git(['checkout-index', '--all', '--force', '--prefix', `${snapshotRoot}${path.sep}`]);
  return snapshotRoot;
}

async function validateSnapshotAndLedger(root, expectedChannel, catalogModules) {
  const validation = await catalogModules.catalogSnapshot.validateCatalogSnapshot(root);
  if (validation.manifest.channel !== expectedChannel) {
    throw new Error(
      `Catalog snapshot channel mismatch: expected ${expectedChannel}, found ${validation.manifest.channel}.`,
    );
  }
  const ledgerPath = path.join(root, 'plugin-release-ledger.json');
  let rawLedger;
  try {
    rawLedger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
  } catch (error) {
    throw new Error(`Published ${expectedChannel} catalog is missing or has an invalid release ledger.`, {
      cause: error,
    });
  }
  const ledger = catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
    rawLedger,
    validation.manifest,
  );
  return { ...validation, ledger };
}

export async function readCatalogPublicationHistory(options) {
  const remoteUrl = assertSafeRemoteUrl(
    options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE,
  );
  const catalogModules = options.catalogModules ?? await loadCatalogModules(options.cliDistRoot);
  return withTemporaryRepository(async ({ root, git }) => {
    const remote = await listRemoteRefs(git, remoteUrl, options.catalogVersion);
    const channels = {};
    for (const mode of ['latest', 'beta']) {
      const commit = remote.heads[mode];
      if (!commit) {
        channels[mode] = null;
        continue;
      }
      const localRef = `refs/remotes/catalog/${mode}`;
      await fetchObject(git, remoteUrl, CATALOG_CHANNEL_REFS[mode], localRef);
      const snapshotRoot = await materializeCommit(git, root, commit, `channel-${mode}`);
      channels[mode] = {
        commit,
        ...await validateSnapshotAndLedger(snapshotRoot, mode, catalogModules),
      };
    }

    let tag = null;
    if (remote.tag) {
      const localRef = `refs/tags/catalog-v${options.catalogVersion}`;
      await fetchObject(git, remoteUrl, remote.tag.ref, localRef);
      const { stdout: typeOutput } = await git(['cat-file', '-t', localRef]);
      if (typeOutput.trim() !== 'tag') {
        throw new Error(`Catalog tag ${remote.tag.ref} must be annotated.`);
      }
      const { stdout: commitType } = await git(['cat-file', '-t', `${localRef}^{}`]);
      if (commitType.trim() !== 'commit') {
        throw new Error(`Catalog tag ${remote.tag.ref} must point to a snapshot commit.`);
      }
      const snapshotRoot = await materializeCommit(
        git,
        root,
        remote.tag.commit,
        'tag-snapshot',
      );
      const validation = await validateSnapshotAndLedger(
        snapshotRoot,
        options.mode,
        catalogModules,
      );
      if (validation.manifest.catalogVersion !== options.catalogVersion) {
        throw new Error(`Catalog tag ${remote.tag.ref} contains the wrong catalog version.`);
      }
      tag = { ...remote.tag, ...validation };
    }
    return {
      remoteUrl,
      catalogVersion: options.catalogVersion,
      mode: options.mode,
      channels,
      tag,
      mergedLedger: catalogModules.pluginStaging.mergePluginReleaseLedgers(
        channels.latest?.ledger,
        channels.beta?.ledger,
      ),
      catalogModules,
    };
  }, options);
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
}

async function clearRepositoryWorktree(repositoryRoot) {
  for (const entry of await fs.readdir(repositoryRoot)) {
    if (entry !== '.git') {
      await fs.rm(path.join(repositoryRoot, entry), { recursive: true, force: true });
    }
  }
}

function assertCandidate(history, validation) {
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
}

async function prepareLocalPublication(history, stagedRoot, options = {}) {
  const validation = await history.catalogModules.catalogSnapshot.validateCatalogSnapshot(stagedRoot);
  const ledger = history.catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
    JSON.parse(await fs.readFile(path.join(stagedRoot, 'plugin-release-ledger.json'), 'utf8')),
    validation.manifest,
  );
  assertCandidate(history, validation);

  return withTemporaryRepository(async ({ repositoryRoot, git }) => {
    const actual = await listRemoteRefs(git, history.remoteUrl, history.catalogVersion);
    assertUnchangedRemote(history, actual);
    for (const mode of ['latest', 'beta']) {
      if (history.channels[mode]) {
        await fetchObject(
          git,
          history.remoteUrl,
          CATALOG_CHANNEL_REFS[mode],
          `refs/remotes/catalog/${mode}`,
        );
      }
    }
    const tagRef = `refs/tags/catalog-v${history.catalogVersion}`;
    if (history.tag) {
      await fetchObject(git, history.remoteUrl, tagRef, tagRef);
      return callbackPublication({
        git,
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
    await fs.cp(stagedRoot, repositoryRoot, { recursive: true });
    await git(['add', '--all']);
    await git([
      '-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '-m', `Catalog ${history.catalogVersion} (${history.mode})`,
    ]);
    const { stdout } = await git(['rev-parse', 'HEAD']);
    const commit = stdout.trim();
    await git([
      '-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'tag', '--annotate', `catalog-v${history.catalogVersion}`,
      '--message', `Catalog ${history.catalogVersion} (${history.mode})`,
      commit,
    ]);
    return callbackPublication({
      git,
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

export async function publishStagedCatalog(history, stagedRoot, options = {}) {
  const publicationMode = options.publicationMode ?? 'atomic';
  return prepareLocalPublication(history, stagedRoot, {
    ...options,
    callback: async (context) => {
      const channelRef = CATALOG_CHANNEL_REFS[history.mode];
      const current = history.channels[history.mode];
      if (current?.commit === context.commit) {
        return { ...context, mode: history.mode, idempotent: true, promoted: true };
      }
      if (publicationMode === 'tag') {
        if (!context.existingTag) {
          await context.git(['push', history.remoteUrl, `${context.tagRef}:${context.tagRef}`]);
        }
        return { ...context, mode: history.mode, idempotent: context.existingTag, promoted: false };
      }
      if (publicationMode !== 'atomic') {
        throw new Error(`Unknown catalog publication mode ${JSON.stringify(publicationMode)}.`);
      }
      const refspecs = [`${context.commit}:${channelRef}`];
      if (!context.existingTag) refspecs.push(`${context.tagRef}:${context.tagRef}`);
      try {
        await context.git(['push', '--atomic', history.remoteUrl, ...refspecs]);
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

export async function promoteCatalogTag(options) {
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
    return { mode: options.mode, commit: history.tag.commit, promoted: true, idempotent: true };
  }
  return withTemporaryRepository(async ({ git }) => {
    const actual = await listRemoteRefs(git, history.remoteUrl, history.catalogVersion);
    assertUnchangedRemote(history, actual);
    await fetchObject(git, history.remoteUrl, history.tag.ref, history.tag.ref);
    if (current) {
      await fetchObject(
        git,
        history.remoteUrl,
        CATALOG_CHANNEL_REFS[options.mode],
        `refs/remotes/catalog/${options.mode}`,
      );
      try {
        await git(['merge-base', '--is-ancestor', current.commit, history.tag.commit]);
      } catch (error) {
        throw new Error('Catalog promotion is not a fast-forward.', { cause: error });
      }
    }
    await git(['push', history.remoteUrl, `${history.tag.commit}:${CATALOG_CHANNEL_REFS[options.mode]}`]);
    return { mode: options.mode, commit: history.tag.commit, promoted: true, idempotent: false };
  }, options);
}

export function catalogPromotionRecoveryCommand(mode, catalogVersion) {
  return `pnpm run release:promote:catalog:${mode} -- --catalog-version ${catalogVersion}`;
}
