import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertReleaseWorktreeClean,
  assertCurrentReleaseIdentity,
  assertStagedCatalogReleaseIdentity,
  assertVersionKind,
  createReleaseSnapshotIdentity,
  resolveReleaseHead,
  resolvePublishedCliVersion,
  runCommand,
  withPrivateCatalogStageRoot,
  withReleaseBuildSnapshot,
} from './common.mjs';
import {
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
      `Unknown argument "${token}". Usage: node scripts/release/publish-catalog.mjs <beta|latest> --catalog-version <version>`,
    );
  }
  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }
  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/publish-catalog.mjs <beta|latest> --catalog-version <version>',
    );
  }
  assertVersionKind(catalogVersion, mode === 'beta' ? 'prerelease' : 'stable');
  return { mode, catalogVersion };
}

export async function publishCatalog(argv = process.argv.slice(2), options = {}) {
  const { mode, catalogVersion } = parseArgs(argv);
  await (options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean)();
  if (!options.skipVerify) {
    await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify:catalog']);
  }
  const snapshotRunner = options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot;
  return snapshotRunner(async (snapshot) => {
    const headCommit = await (options.resolveReleaseHead ?? resolveReleaseHead)();
    const releaseIdentity = createReleaseSnapshotIdentity(snapshot, headCommit);
    const assertFresh = () => (options.assertCurrentReleaseIdentity
      ?? assertCurrentReleaseIdentity)(
      snapshot,
      releaseIdentity,
      {},
    );
    const beforeRemoteWrite = async () => {
      await assertFresh();
      await options.beforeRemoteWrite?.();
    };
    return (options.withPrivateCatalogStageRoot ?? withPrivateCatalogStageRoot)(async (internalOutputRoot) => {
      const remoteUrl = options.remoteUrl;
      await assertFresh();
      return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
        remoteUrl,
        async (publicationLease) => {
          const history = await (options.readCatalogPublicationHistory
            ?? readCatalogPublicationHistory)({
            mode,
            catalogVersion,
            ...(remoteUrl ? { remoteUrl } : {}),
            ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
          });
          const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
            '--catalog-version',
            catalogVersion,
          ], {
            internalOutputRoot,
            previousReleaseLedger: resolveCatalogStageLedger(history),
            snapshot,
            releaseIdentity,
            ...(options.catalogRelease ? { catalogRelease: options.catalogRelease } : {}),
          });
          assertStagedCatalogReleaseIdentity(staged, internalOutputRoot, releaseIdentity);
          const publishedCliVersion = await (options.resolvePublishedCliVersion
            ?? resolvePublishedCliVersion)(mode);
          if (
            history.catalogModules.pluginStaging.compareStrictSemVer(
              publishedCliVersion,
              staged.manifest.compatibility.aw.minVersion,
            ) < 0
          ) {
            throw new Error(
              `Catalog ${catalogVersion} requires aw >= ${staged.manifest.compatibility.aw.minVersion}, ` +
              `but the currently published ${mode} CLI is ${publishedCliVersion}. Use the combined release entry point.`,
            );
          }
          await assertFresh();
          return (options.publishStagedCatalog ?? publishStagedCatalog)(
            history,
            staged.outputRoot,
            {
              ...options.publisherOptions,
              publicationLease,
              beforeRemoteWrite,
            },
          );
        },
        { ...options.publisherOptions, beforeAcquire: assertFresh },
      );
    });
  }, options.snapshotOptions);
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) {
  process.stderr.write(
    'Direct release helper execution is disabled. Use `pnpm release:publish` or `pnpm release:recover`.\n',
  );
  process.exitCode = 1;
}
