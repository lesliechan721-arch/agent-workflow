import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseWorktreeClean,
  assertVersionKind,
  resolvePublishedCliVersion,
} from './common.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  promoteCatalogTag,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';

export function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  let catalogVersion;
  while (args[0] === '--') args.shift();
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--catalog-version') {
      catalogVersion = args.shift();
      continue;
    }
    throw new Error(
      `Unknown argument "${token}". Usage: node scripts/release/promote-catalog.mjs <beta|latest> --catalog-version <version>`,
    );
  }
  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Missing promotion mode. Use "beta" or "latest".');
  }
  if (!catalogVersion) throw new Error('Missing catalog version.');
  assertVersionKind(catalogVersion, mode === 'beta' ? 'prerelease' : 'stable');
  return { mode, catalogVersion };
}

export async function promoteCatalog(argv = process.argv.slice(2), options = {}) {
  const { mode, catalogVersion } = parseArgs(argv);
  const assertClean = options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean;
  await assertClean({ allowVersionSync: true });
  const currentCliVersion = await (options.resolvePublishedCliVersion
    ?? resolvePublishedCliVersion)(mode);
  const remoteUrl = options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE;
  return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
    remoteUrl,
    (publicationLease) => (options.promoteCatalogTag ?? promoteCatalogTag)({
      mode,
      catalogVersion,
      currentCliVersion,
      remoteUrl,
      publicationLease,
      beforeRemoteWrite: () => assertClean({ allowVersionSync: true }),
      ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
    }),
    {
      ...options.publisherOptions,
      beforeAcquire: () => assertClean({ allowVersionSync: true }),
    },
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await promoteCatalog(argv);
    console.log(`Promoted catalog ${result.mode} channel to ${result.commit}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
