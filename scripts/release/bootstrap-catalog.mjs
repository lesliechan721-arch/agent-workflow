import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseIdentity,
  assertReleaseWorktreeClean,
  assertStagedCatalogReleaseIdentity,
  assertVersionKind,
  createReleaseSnapshotIdentity,
  resolveReleaseHead,
  runCommand,
  withPrivateCatalogStageRoot,
  withReleaseBuildSnapshot,
} from './common.mjs';
import {
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  publishStagedCatalog,
  readCatalogPublicationHistory,
  resolveCatalogStageLedger,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

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
      `Unknown argument "${token}". Usage: node scripts/release/bootstrap-catalog.mjs <beta|latest> --catalog-version <version>`,
    );
  }
  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Missing bootstrap mode. Use "beta" or "latest".');
  }
  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/bootstrap-catalog.mjs <beta|latest> --catalog-version <version>',
    );
  }
  assertVersionKind(catalogVersion, mode === 'beta' ? 'prerelease' : 'stable');
  return { mode, catalogVersion };
}

function assertBootstrapState(history) {
  if (history.pending) {
    throw new Error(
      'Catalog bootstrap cannot confirm a tag-first pending publication; use the fixed promotion recovery entry point.',
    );
  }
  const current = history.channels[history.mode];
  if (!current) {
    if (history.tag) {
      throw new Error(
        `Catalog tag refs/tags/catalog-v${history.catalogVersion} already exists while the target channel is missing. ` +
        'Bootstrap requires one atomic tag and channel publication.',
      );
    }
    return;
  }
  if (
    current.manifest.catalogVersion !== history.catalogVersion
    || !history.tag
    || history.tag.commit !== current.commit
    || history.tag.snapshotDigest !== current.snapshotDigest
  ) {
    throw new Error(
      `Catalog ${history.mode} channel already exists. Bootstrap is only for the first official publication; use the normal catalog publisher.`,
    );
  }
}

export function bootstrapNextSteps() {
  return [
    'Complete every required official bootstrap ref first:',
    '  pnpm run release:bootstrap:catalog:beta -- --catalog-version <beta-version>',
    '  pnpm run release:bootstrap:catalog:latest -- --catalog-version <stable-version>',
    'Verify both Git refs through the Git provider, then publish the CLI version that uses Git catalog sources.',
    'This command does not publish the CLI.',
  ];
}

export async function bootstrapCatalog(argv = process.argv.slice(2), options = {}) {
  const { mode, catalogVersion } = parseArgs(argv);
  if (options.remoteUrl && options.remoteUrl !== OFFICIAL_CATALOG_PUBLISH_REMOTE) {
    throw new Error('Catalog bootstrap only permits the official remote. Tests must inject a local remote with testRemoteUrl.');
  }
  const remoteUrl = options.testRemoteUrl ?? options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE;
  await (options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean)();
  await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify:catalog']);
  const snapshotRunner = options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot;
  return snapshotRunner(async (snapshot) => {
    const headCommit = await (options.resolveReleaseHead ?? resolveReleaseHead)();
    const releaseIdentity = createReleaseSnapshotIdentity(snapshot, headCommit);
    const assertFresh = () => (options.assertCurrentReleaseIdentity
      ?? assertCurrentReleaseIdentity)(
      snapshot,
      releaseIdentity,
      { allowVersionSync: false },
    );
    return (options.withPrivateCatalogStageRoot ?? withPrivateCatalogStageRoot)(async (internalOutputRoot) => {
      await assertFresh();
      return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
        remoteUrl,
        async (publicationLease) => {
          const history = await (options.readCatalogPublicationHistory
            ?? readCatalogPublicationHistory)({
            mode,
            catalogVersion,
            remoteUrl,
            ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
          });
          assertBootstrapState(history);
          const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
            '--catalog-version',
            catalogVersion,
          ], {
            internalOutputRoot,
            previousReleaseLedger: resolveCatalogStageLedger(history),
            snapshot,
            releaseIdentity,
            legacyPublishedIdentity: true,
          });
          assertStagedCatalogReleaseIdentity(staged, internalOutputRoot, releaseIdentity);
          await assertFresh();
          const result = await (options.publishStagedCatalog ?? publishStagedCatalog)(
            history,
            staged.outputRoot,
            { publicationMode: 'atomic', publicationLease, beforeRemoteWrite: assertFresh },
          );
          return { ...result, nextSteps: bootstrapNextSteps(), releaseIdentity };
        },
        { ...options.publisherOptions, beforeAcquire: assertFresh },
      );
    });
  }, options.snapshotOptions);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await bootstrapCatalog(argv);
    console.log(
      `${result.idempotent ? 'Confirmed' : 'Bootstrapped'} catalog ${result.mode} at ${result.commit}.`,
    );
    console.log(result.nextSteps.join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
