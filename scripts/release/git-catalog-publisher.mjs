import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import crypto from 'node:crypto';

import {
  captureCommand,
  cliDistRoot,
  compareReleaseSemVer,
  loadCatalogModules,
  runCommand,
} from './common.mjs';
import { calculateCanonicalDigest } from './release-model.mjs';

export const CATALOG_CHANNEL_REFS = {
  latest: 'refs/heads/catalog/latest',
  beta: 'refs/heads/catalog/beta',
};

export const OFFICIAL_CATALOG_PUBLISH_REMOTE =
  'git@github.com:lesliechan721-arch/agent-workflow.git';

function assertSafeRemoteUrl(value) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw new Error('Catalog remote URL must be a non-empty string.');
  }
  if (/^[a-z][a-z\d+.-]*:\/\/[^/\s?#]*@/iu.test(value)) {
    throw new Error('Catalog remote URL must not contain embedded credentials.');
  }
  if (/\s/u.test(value) || value.startsWith('-')) throw new Error('Catalog remote URL is unsafe.');
  return value;
}

export function resolveCatalogMaintenanceRemote(options = {}) {
  const values = [options.remoteUrl, options.catalogRemoteUrl]
    .filter((value) => value !== undefined);
  if (values.length === 2 && values[0] !== values[1]) {
    throw new Error('Conflicting Catalog remote overrides.');
  }
  return assertSafeRemoteUrl(values[0] ?? OFFICIAL_CATALOG_PUBLISH_REMOTE);
}

function tagRef(version) {
  return `refs/tags/catalog-v${version}`;
}

async function listRemote(remoteUrl, options = {}) {
  return withTemporaryRepository(async (root) => {
    await preparePrivateGitFiles(root);
    const result = await privateCapture(root, 'git', ['ls-remote', '--refs', remoteUrl], options);
    return new Map(result.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [objectId, ref] = line.split(/\s+/u);
      return [ref, objectId];
    }));
  });
}

export async function assertCatalogTagAvailable(catalogVersion, options = {}) {
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const refs = await listRemote(remoteUrl, options);
  if (refs.has(tagRef(catalogVersion))) {
    throw new Error(`Catalog tag ${tagRef(catalogVersion)} already exists; bump the Catalog version and prepare again.`);
  }
  return { remoteUrl, refs };
}

export async function readCatalogVersions(options = {}) {
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const refs = await listRemote(remoteUrl, options);
  return [...refs.keys()]
    .filter((ref) => ref.startsWith('refs/tags/catalog-v'))
    .map((ref) => ref.slice('refs/tags/catalog-v'.length));
}

export async function readCatalogChannelState(mode, options = {}) {
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog mode must be latest or beta.');
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const refs = await listRemote(remoteUrl, options);
  const channelRef = CATALOG_CHANNEL_REFS[mode];
  const commit = refs.get(channelRef);
  if (!commit) return null;
  return withTemporaryRepository(async (root) => {
    await preparePrivateGitFiles(root);
    await privateRun(root, ['init', '--quiet', '--object-format=sha1',
      `--template=${path.join(root, 'empty-template')}`], options);
    await privateRun(root, [
      'fetch', '--quiet', '--depth=1', remoteUrl, `${channelRef}:refs/remotes/catalog/channel`,
    ], options);
    const snapshotRoot = path.join(root, 'snapshot');
    await fs.mkdir(snapshotRoot);
    await privateRun(root, ['--work-tree', snapshotRoot, 'checkout', '--quiet',
      'refs/remotes/catalog/channel', '--', '.'], options);
    const modules = options.catalogModules ?? await loadCatalogModules(options.cliDistRoot ?? cliDistRoot);
    const validation = await modules.catalogSnapshot.validateCatalogSnapshot(snapshotRoot);
    const ledgerBytes = await fs.readFile(path.join(snapshotRoot, 'plugin-release-ledger.json'));
    let ledger;
    try {
      ledger = JSON.parse(ledgerBytes);
    } catch (error) {
      throw new Error('Published Catalog channel has an invalid plugin release ledger.', { cause: error });
    }
    modules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(ledger, validation.manifest);
    if (validation.manifest.channel !== mode) {
      throw new Error(`Published Catalog ${mode} channel has the wrong manifest channel.`);
    }
    const version = validation.manifest.catalogVersion;
    const prerelease = version.includes('-');
    if ((mode === 'latest' && prerelease) || (mode === 'beta' && !prerelease)) {
      throw new Error(`Published Catalog ${mode} channel has an invalid version kind.`);
    }
    return {
      commit,
      version,
      manifest: validation.manifest,
      ledger,
      ledgerDigest: calculateCanonicalDigest(ledger),
      ledgerBytesDigest: digest(ledgerBytes),
      snapshotDigest: validation.snapshotDigest,
    };
  });
}

export async function readCatalogChannelLedger(mode, options = {}) {
  return (await readCatalogChannelState(mode, options))?.ledger;
}

async function withTemporaryRepository(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-publish-'));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function privateGitEnv(root, sourceEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
    'SSH_AUTH_SOCK', 'SSH_AGENT_PID']) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'empty-global-config'),
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

async function preparePrivateGitFiles(root) {
  await Promise.all([
    fs.writeFile(path.join(root, 'empty-global-config'), '', { mode: 0o600 }),
    fs.mkdir(path.join(root, 'empty-template')),
  ]);
}

function privateRun(root, args, options = {}) {
  return (options.runCommand ?? runCommand)('git', args, {
    cwd: root,
    env: privateGitEnv(root, options.env),
    replaceEnv: true,
    stdio: 'ignore',
  });
}

function privateCapture(root, command, args, options = {}) {
  return (options.captureCommand ?? captureCommand)(command, args, {
    cwd: root,
    env: privateGitEnv(root, options.env),
    replaceEnv: true,
  });
}

async function assertNoAttributes(root, relative = '') {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === '.gitattributes') {
      throw new Error(`Catalog publication snapshot must not contain .gitattributes (${child}).`);
    }
    if (entry.isDirectory()) await assertNoAttributes(root, child);
  }
}

export async function publishStagedCatalog({ mode, catalogVersion, stagedRoot }, options = {}) {
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog mode must be latest or beta.');
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const catalogModules = options.catalogModules ?? await loadCatalogModules(options.cliDistRoot ?? cliDistRoot);
  const validation = await catalogModules.catalogSnapshot.validateCatalogSnapshot(stagedRoot);
  const ledger = JSON.parse(await fs.readFile(path.join(stagedRoot, 'plugin-release-ledger.json'), 'utf8'));
  catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
    ledger,
    validation.manifest,
  );
  if (validation.manifest.catalogVersion !== catalogVersion || validation.manifest.channel !== mode) {
    throw new Error('Staged Catalog identity does not match the prepared candidate.');
  }
  const stagedLedgerBytes = await fs.readFile(path.join(stagedRoot, 'plugin-release-ledger.json'));
  const stagedLedgerBytesDigest = digest(stagedLedgerBytes);
  await assertNoAttributes(stagedRoot);
  await assertCatalogTagAvailable(catalogVersion, { ...options, remoteUrl });
  const initialParent = await readCatalogChannelState(mode, { ...options, remoteUrl });
  if (initialParent && compareReleaseSemVer(catalogVersion, initialParent.version) <= 0) {
    throw new Error(
      `Catalog candidate ${catalogVersion} must be higher than published ${mode} ${initialParent.version}.`,
    );
  }

  return withTemporaryRepository(async (repositoryRoot) => {
    await preparePrivateGitFiles(repositoryRoot);
    const git = (args) => privateRun(repositoryRoot, args, options);
    await git(['init', '--quiet', '--object-format=sha1',
      `--template=${path.join(repositoryRoot, 'empty-template')}`]);
    await git(['config', 'core.hooksPath', path.join(repositoryRoot, 'disabled-hooks')]);
    await git(['config', 'core.symlinks', 'true']);
    await git(['remote', 'add', 'catalog', remoteUrl]);

    const channelRef = CATALOG_CHANNEL_REFS[mode];
    const parent = initialParent?.commit ?? null;
    if (parent) {
      await git(['fetch', '--quiet', '--no-tags', 'catalog', `${channelRef}:refs/remotes/catalog/channel`]);
      await git(['checkout', '--quiet', '--detach', 'refs/remotes/catalog/channel']);
    } else {
      await git(['checkout', '--quiet', '--orphan', 'catalog-publication']);
    }
    for (const entry of await fs.readdir(repositoryRoot)) {
      if (entry !== '.git' && entry !== 'empty-global-config' && entry !== 'empty-template') {
        await fs.rm(path.join(repositoryRoot, entry), { recursive: true, force: true });
      }
    }
    await fs.rm(path.join(repositoryRoot, 'empty-global-config'), { force: true });
    await fs.rm(path.join(repositoryRoot, 'empty-template'), { recursive: true, force: true });
    await fs.cp(stagedRoot, repositoryRoot, { recursive: true, verbatimSymlinks: true });
    await git(['add', '--force', '--all']);
    await git(['-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'commit', '--quiet', '-m', `Catalog ${catalogVersion} (${mode})`]);
    const verificationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-catalog-verify-'));
    try {
      await privateRun(repositoryRoot, [
        '-c', 'core.symlinks=true',
        'clone', '--quiet', '--no-hardlinks', repositoryRoot, verificationRoot,
      ], options);
      await fs.rm(path.join(verificationRoot, '.git'), { recursive: true, force: true });
      const committed = await catalogModules.catalogSnapshot.validateCatalogSnapshot(verificationRoot);
      const committedLedger = JSON.parse(await fs.readFile(
        path.join(verificationRoot, 'plugin-release-ledger.json'), 'utf8',
      ));
      catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
        committedLedger,
        committed.manifest,
      );
      if (committed.snapshotDigest !== validation.snapshotDigest) {
        throw new Error('Catalog commit tree does not match the complete staged snapshot.');
      }
      const committedLedgerBytes = await fs.readFile(
        path.join(verificationRoot, 'plugin-release-ledger.json'),
      );
      if (digest(committedLedgerBytes) !== stagedLedgerBytesDigest) {
        throw new Error('Catalog commit ledger bytes do not match the staged ledger.');
      }
    } finally {
      await fs.rm(verificationRoot, { recursive: true, force: true });
    }
    await git(['-c', 'user.name=Agent Workflows Catalog Publisher',
      '-c', 'user.email=catalog-publisher@agent-workflows.invalid',
      'tag', '--annotate', `catalog-v${catalogVersion}`,
      '--message', `Catalog ${catalogVersion} (${mode})`]);
    const liveParent = await readCatalogChannelState(mode, { ...options, remoteUrl });
    if (calculateCanonicalDigest(liveParent) !== calculateCanonicalDigest(initialParent)) {
      throw new Error('Published Catalog channel changed during preparation; prepare again with a new version.');
    }
    await assertCatalogTagAvailable(catalogVersion, { ...options, remoteUrl });
    await options.beforeRemoteWrite?.();
    try {
      await git(['push', '--atomic', 'catalog',
        `HEAD:${channelRef}`,
        `${tagRef(catalogVersion)}:${tagRef(catalogVersion)}`]);
    } catch (error) {
      throw new Error(
        `Catalog atomic push failed or its result is uncertain. Do not retry ${catalogVersion}; ` +
        'run pnpm release again with --catalog-bump and the intended Catalog axis.',
        { cause: error },
      );
    }
    const result = await privateCapture(repositoryRoot, 'git', ['rev-parse', 'HEAD'], options);
    return { mode, catalogVersion, commit: result.stdout.trim(), snapshotDigest: validation.snapshotDigest };
  });
}
