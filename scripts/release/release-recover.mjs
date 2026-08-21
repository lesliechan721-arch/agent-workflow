import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseWorktreeClean } from './common.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  promoteCatalogTag,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';
import { readRegistryReleaseHistory } from './release-observe.mjs';
import { CLI_PACKAGES, normalizeCliRegistryHistory } from './release-state.mjs';

const CATALOG_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/u;

export function parseRecoverArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 2 || args[0] !== 'catalog') {
    throw new Error('Usage: pnpm release:recover -- catalog <x.y.z[-beta.N]>');
  }
  const catalogVersion = args[1];
  if (!CATALOG_VERSION_PATTERN.test(catalogVersion)) {
    throw new Error('Catalog recovery version must be canonical x.y.z or x.y.z-beta.N.');
  }
  return {
    kind: 'catalog',
    catalogVersion,
    mode: catalogVersion.includes('-beta.') ? 'beta' : 'latest',
  };
}

export async function resolvePublishedCliTrain(mode, options = {}) {
  const history = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  const normalized = normalizeCliRegistryHistory(history);
  const versions = CLI_PACKAGES.map((name) => normalized.distTags[name][mode]);
  if (versions.some((version) => version === null) || versions[0] !== versions[1]) {
    throw new Error(`Catalog recovery requires matching published ${mode} dist-tags for both CLI packages.`);
  }
  return versions[0];
}

export async function recoverRelease(argv = process.argv.slice(2), options = {}) {
  const { mode, catalogVersion } = parseRecoverArgs(argv);
  const assertClean = options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean;
  const resolveCliTrain = options.resolvePublishedCliTrain ?? resolvePublishedCliTrain;
  await assertClean();
  const currentCliVersion = await resolveCliTrain(mode, options);
  const remoteUrl = options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE;
  return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
    remoteUrl,
    (publicationLease) => (options.promoteCatalogTag ?? promoteCatalogTag)({
      mode,
      catalogVersion,
      currentCliVersion,
      remoteUrl,
      publicationLease,
      requirePendingGuard: true,
      beforeRemoteWrite: async () => {
        await assertClean();
        const liveCliVersion = await resolveCliTrain(mode, options);
        if (liveCliVersion !== currentCliVersion) {
          throw new Error(
            `Published ${mode} CLI train changed from ${currentCliVersion} to ${liveCliVersion} during catalog recovery.`,
          );
        }
      },
      ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
    }),
    {
      ...options.publisherOptions,
      beforeAcquire: assertClean,
    },
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await recoverRelease(argv);
    process.stdout.write(`Recovered catalog ${result.mode} channel at ${result.commit}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
