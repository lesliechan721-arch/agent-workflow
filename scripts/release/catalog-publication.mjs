import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertReleaseWorktreeClean,
  cliDistRoot,
  repoRoot as defaultRepoRoot,
  resolveReleaseHead,
  withReleaseBuildSnapshot,
} from './common.mjs';

export const CATALOG_CHANNEL_BRANCHES = {
  latest: 'catalog/latest',
  beta: 'catalog/beta',
};

export const CATALOG_CHANNEL_REFS = {
  latest: `refs/heads/${CATALOG_CHANNEL_BRANCHES.latest}`,
  beta: `refs/heads/${CATALOG_CHANNEL_BRANCHES.beta}`,
};

export const OFFICIAL_CATALOG_PUBLISH_REMOTE =
  'https://github.com/lesliechan721-arch/agent-workflow.git';

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

async function loadCatalogPublicationService(options = {}) {
  if (options.catalogPublicationService) return options.catalogPublicationService;
  const distRoot = path.resolve(options.cliDistRoot ?? cliDistRoot);
  const [inspection, publication] = await Promise.all([
    import(pathToFileURL(path.join(
      distRoot,
      'src',
      'commands',
      'catalog-publication-inspection.js',
    )).href),
    import(pathToFileURL(path.join(
      distRoot,
      'src',
      'commands',
      'catalog-publish.js',
    )).href),
  ]).catch((error) => {
    throw new Error('Catalog publication requires compiled CLI artifacts. Run `pnpm build` first.', {
      cause: error,
    });
  });
  return { ...inspection, ...publication };
}

export async function prepareCatalogRelease(mode, options = {}) {
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog mode must be latest or beta.');
  const sourceVersion = await readCatalogSourceVersion(options);
  if ((mode === 'beta') !== sourceVersion.includes('-beta.')) {
    throw new Error(`Catalog source version does not match the ${mode} release channel.`);
  }
  const service = await loadCatalogPublicationService(options);
  const workspaceRoot = options.repoRoot ?? defaultRepoRoot;
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const env = options.env ?? process.env;
  let existingJournal = false;
  try {
    await fs.lstat(path.join(workspaceRoot, '.aw', 'publish', sourceVersion, 'journal.json'));
    existingJournal = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const officialPluginHistory = existingJournal ? undefined
    : await service.readCatalogPublicationPluginHistory({
      workspaceRoot,
      remoteUrl,
      branches: Object.values(CATALOG_CHANNEL_BRANCHES),
      env,
    });
  const plan = await service.prepareCatalogPublicationPlan({
    workspaceRoot,
    remoteUrl,
    branch: CATALOG_CHANNEL_BRANCHES[mode],
    officialPluginHistory,
    sourcePluginVersionsAtBaseline: options.sourcePluginVersionsAtBaseline,
    env,
  });
  if (plan.channel !== mode) {
    throw new Error(`Catalog source version does not match the ${mode} release channel.`);
  }
  return plan;
}

export async function resolveCatalogPluginBaseVersions({ channel, ...options }) {
  const mode = channel === 'stable' ? 'latest' : channel;
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog channel must be stable or beta.');
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const env = options.env ?? process.env;
  await assertReleaseWorktreeClean({ cwd: repoRoot });
  const sourceHead = await resolveReleaseHead({ cwd: repoRoot, env });
  if (options.sourceHead !== undefined && options.sourceHead !== sourceHead) {
    throw new Error('Catalog Plugin base preparation must use the checked out source HEAD.');
  }
  const result = await (options.withSnapshot ?? withReleaseBuildSnapshot)(async (snapshot) => {
    const [core, service] = await Promise.all([
      import(pathToFileURL(path.join(snapshot.corePackageRoot, 'dist', 'index.js')).href),
      loadCatalogPublicationService({ ...options, cliDistRoot: snapshot.cliDistRoot }),
    ]);
    const current = await core.validateCatalogSnapshotComplete(snapshot.catalogOutputRoot);
    const officialPluginHistory = await service.readCatalogPublicationPluginHistory({
      workspaceRoot: repoRoot,
      remoteUrl: resolveCatalogMaintenanceRemote(options),
      branches: Object.values(CATALOG_CHANNEL_BRANCHES),
      env,
    });
    const versions = core.resolvePublishedPluginVersions({
      channel: mode,
      entries: current.manifest.entries,
      officialPluginHistory,
      sourcePluginVersionsAtBaseline: options.sourcePluginVersionsAtBaseline,
    });
    return Object.fromEntries(current.manifest.entries.flatMap((entry) => {
      const baseVersion = versions[entry.name].split('-', 1)[0];
      return baseVersion === entry.version ? [] : [[entry.name, baseVersion]];
    }));
  }, { repoRoot });
  await assertReleaseWorktreeClean({ cwd: repoRoot });
  if (await resolveReleaseHead({ cwd: repoRoot, env }) !== sourceHead) {
    throw new Error('Catalog source HEAD changed during Plugin base preparation.');
  }
  return result;
}

export async function publishCatalogRelease({ channel, expectedPlanDigest }, options = {}) {
  const mode = channel === 'stable' ? 'latest' : channel;
  const branch = CATALOG_CHANNEL_BRANCHES[mode];
  if (branch === undefined) {
    throw new Error('Prepared Catalog plan does not match an official release channel.');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(expectedPlanDigest ?? '')) {
    throw new Error('Prepared Catalog plan digest is invalid.');
  }
  const service = await loadCatalogPublicationService(options);
  return service.applyCatalogPublicationPlan({
    workspaceRoot: options.repoRoot ?? defaultRepoRoot,
    remoteUrl: resolveCatalogMaintenanceRemote(options),
    branch,
    expectedPlanDigest,
    env: options.env ?? process.env,
    beforeRemoteWrite: options.beforeRemoteWrite,
  });
}

export async function readCatalogVersions(options = {}) {
  const service = await loadCatalogPublicationService(options);
  return service.listCatalogPublicationVersions({
    workspaceRoot: options.repoRoot ?? defaultRepoRoot,
    remoteUrl: resolveCatalogMaintenanceRemote(options),
    env: options.env ?? process.env,
  });
}

export async function readCatalogSourceVersion(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const sourcePath = path.join(repoRoot, 'plugins', 'marketplace-source.json');
  let source;
  try {
    source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
  } catch (error) {
    throw new Error('Catalog source metadata is not valid JSON.', { cause: error });
  }
  const version = source?.catalog?.version;
  if (
    typeof version !== 'string'
    || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version)
  ) {
    throw new Error('Catalog source metadata must contain a stable or exact beta Catalog version.');
  }
  return version;
}

export async function readCatalogAttemptVersions(options = {}) {
  const journalsRoot = path.join(
    path.resolve(options.repoRoot ?? defaultRepoRoot),
    '.aw',
    'publish',
  );
  let entries;
  try {
    entries = await fs.readdir(journalsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const version = entry.name;
    return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/u.test(version)
      ? [version]
      : [];
  });
}

export async function readReusableCatalogAttempt(channel, currentVersion, options = {}) {
  const mode = channel === 'stable' ? 'latest' : channel;
  if (
    (mode !== 'latest' && mode !== 'beta')
    || (mode === 'latest' && currentVersion.includes('-beta.'))
    || (mode === 'beta' && !currentVersion.includes('-beta.'))
  ) return null;
  const journalPath = path.join(
    path.resolve(options.repoRoot ?? defaultRepoRoot),
    '.aw',
    'publish',
    currentVersion,
    'journal.json',
  );
  try {
    await fs.lstat(journalPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let plan;
  try {
    plan = await prepareCatalogRelease(mode, options);
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'Catalog publication identity changed. Increase the Catalog version and create a new plan.'
    ) return null;
    throw error;
  }
  if (plan.catalogVersion !== currentVersion) {
    throw new Error('Catalog publication plan does not match the current exact version.');
  }
  return plan.state === 'prepared' || plan.state === 'uncertain'
    ? currentVersion
    : null;
}
