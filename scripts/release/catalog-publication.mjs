import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cliDistRoot, repoRoot as defaultRepoRoot } from './common.mjs';

export const CATALOG_CHANNEL_BRANCHES = {
  latest: 'catalog/latest',
  beta: 'catalog/beta',
};

export const CATALOG_CHANNEL_REFS = {
  latest: `refs/heads/${CATALOG_CHANNEL_BRANCHES.latest}`,
  beta: `refs/heads/${CATALOG_CHANNEL_BRANCHES.beta}`,
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

export async function prepareCatalogRelease(catalogVersion, mode, options = {}) {
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog mode must be latest or beta.');
  const service = await loadCatalogPublicationService(options);
  return service.prepareCatalogPublicationInspection({
    workspaceRoot: options.repoRoot ?? defaultRepoRoot,
    remoteUrl: resolveCatalogMaintenanceRemote(options),
    branch: CATALOG_CHANNEL_BRANCHES[mode],
    catalogVersion,
    env: options.env ?? process.env,
    failOnUnavailable: true,
  });
}

export async function disposeCatalogRelease(preparation, options = {}) {
  const service = await loadCatalogPublicationService(options);
  await service.disposeCatalogPublicationInspection(preparation);
}

export async function publishCatalogRelease({ descriptor, stagedRoot }, options = {}) {
  const branch = CATALOG_CHANNEL_BRANCHES[descriptor?.channel];
  if (branch === undefined || descriptor.branch !== branch) {
    throw new Error('Prepared Catalog descriptor does not match the official channel branch.');
  }
  const service = await loadCatalogPublicationService(options);
  return service.publishPreparedCatalogPublication({
    workspaceRoot: options.repoRoot ?? defaultRepoRoot,
    remoteUrl: resolveCatalogMaintenanceRemote(options),
    branch,
    descriptor,
    snapshotRoot: stagedRoot,
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

export async function readCatalogChannelState(mode, options = {}) {
  if (mode !== 'latest' && mode !== 'beta') throw new Error('Catalog mode must be latest or beta.');
  const service = await loadCatalogPublicationService(options);
  const state = await service.readCatalogPublicationBranchState({
    workspaceRoot: options.repoRoot ?? defaultRepoRoot,
    remoteUrl: resolveCatalogMaintenanceRemote(options),
    branch: CATALOG_CHANNEL_BRANCHES[mode],
    env: options.env ?? process.env,
  });
  if (!state) return null;
  if (state.manifest.channel !== mode) {
    throw new Error(`Published Catalog ${mode} channel has the wrong manifest channel.`);
  }
  const prerelease = state.version.includes('-');
  if ((mode === 'latest' && prerelease) || (mode === 'beta' && !prerelease)) {
    throw new Error(`Published Catalog ${mode} channel has an invalid version kind.`);
  }
  return state;
}

export async function assertCatalogTagAvailable(catalogVersion, options = {}) {
  const versions = await readCatalogVersions(options);
  if (versions.includes(catalogVersion)) {
    throw new Error(
      `Catalog tag refs/tags/catalog-v${catalogVersion} already exists; `
      + 'bump the Catalog version and prepare again.',
    );
  }
  return { remoteUrl: resolveCatalogMaintenanceRemote(options), versions };
}
