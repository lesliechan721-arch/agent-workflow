import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertCurrentReleaseHead,
  assertVersionKind,
  createReleaseSnapshotIdentity,
  readCliPackageJson,
  resolveCliPublicationGate,
  resolvePublishedCliVersion,
  resolveReleaseHead,
  runCommand,
  withReleaseBuildSnapshot,
} from './common.mjs';
import {
  catalogPromotionRecoveryCommand,
  OFFICIAL_CATALOG_PUBLISH_REMOTE,
  promoteCatalogTag,
  publishStagedCatalog,
  readCatalogPublicationHistory,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';
import { publishCli } from './publish-cli.mjs';
import { stageCatalogRelease } from './stage-catalog.mjs';

export function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  let cliVersion;
  let catalogVersion;
  while (args[0] === '--') args.shift();
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--cli-version') {
      cliVersion = args.shift();
      continue;
    }
    if (token === '--catalog-version') {
      catalogVersion = args.shift();
      continue;
    }
    throw new Error(
      `Unknown argument "${token}". Usage: node scripts/release/publish-release.mjs <beta|latest> --catalog-version <version> [--cli-version <version>]`,
    );
  }
  if (mode !== 'beta' && mode !== 'latest') {
    throw new Error('Missing publish mode. Use "beta" or "latest".');
  }
  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/publish-release.mjs <beta|latest> --catalog-version <version> [--cli-version <version>]',
    );
  }
  assertVersionKind(catalogVersion, mode === 'beta' ? 'prerelease' : 'stable');
  return { mode, cliVersion, catalogVersion };
}

export async function publishRelease(argv = process.argv.slice(2), options = {}) {
  const { mode, cliVersion, catalogVersion } = parseArgs(argv);
  const cliPackageJson = await (options.readCliPackageJson ?? readCliPackageJson)();
  const currentCliVersion = String(cliPackageJson.version);
  if (cliVersion && cliVersion !== currentCliVersion) {
    throw new Error(
      `CLI version mismatch: expected ${cliVersion}, found ${currentCliVersion} in packages/cli/package.json.`,
    );
  }
  assertVersionKind(currentCliVersion, mode === 'beta' ? 'prerelease' : 'stable');
  const snapshotRunner = options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot;
  return snapshotRunner(async (snapshot) => {
    const headCommit = await (options.resolveReleaseHead ?? resolveReleaseHead)();
    const releaseIdentity = createReleaseSnapshotIdentity(snapshot, headCommit);
    const assertHead = () => (options.assertCurrentReleaseHead ?? assertCurrentReleaseHead)(
      releaseIdentity,
    );
    await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify']);
    const remoteUrl = options.remoteUrl ?? OFFICIAL_CATALOG_PUBLISH_REMOTE;
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
        const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
          '--catalog-version',
          catalogVersion,
        ], {
          previousReleaseLedger: history.mergedLedger,
          snapshot,
          releaseIdentity,
        });
        const publishedCliVersion = await (options.resolvePublishedCliVersion
          ?? resolvePublishedCliVersion)(mode);
        const compare = history.catalogModules.pluginStaging.compareStrictSemVer;
        const cliGate = resolveCliPublicationGate({
          mode,
          candidateVersion: currentCliVersion,
          publishedVersion: publishedCliVersion,
          compare,
        });
        const skippedCli = cliGate.status === 'already-published' ? cliGate : null;
        const minCliVersion = staged.manifest.compatibility.aw.minVersion;
        const requiresCandidateCli = compare(publishedCliVersion, minCliVersion) < 0;
        const resumeTagFirst = Boolean(
          history.tag
          && history.channels[mode]?.commit !== history.tag.commit,
        );

        await assertHead();
        if (!requiresCandidateCli && !resumeTagFirst) {
          const catalog = await (options.publishStagedCatalog ?? publishStagedCatalog)(
            history,
            staged.outputRoot,
            {
              ...options.publisherOptions,
              publicationLease,
              publicationMode: 'atomic',
            },
          );
          try {
            await assertHead();
            const cli = skippedCli
              ? skippedCli
              : await (options.publishCli ?? publishCli)([mode], {
                expectedVersion: currentCliVersion,
                publishedVersion: publishedCliVersion,
                compareSemVer: compare,
                skipVerify: true,
                snapshot,
                releaseIdentity,
              });
            return { path: 'catalog-first', catalog, cli, releaseIdentity };
          } catch (error) {
            throw new Error(
              `Catalog ${catalogVersion} (${mode}) is published, but CLI ${currentCliVersion} publication failed. ` +
              'Immutable catalog refs were not rolled back.',
              { cause: error },
            );
          }
        }

        if (compare(currentCliVersion, minCliVersion) < 0) {
          throw new Error(
            `Catalog ${catalogVersion} requires aw >= ${minCliVersion}, but the CLI candidate is ${currentCliVersion}.`,
          );
        }
        const catalog = await (options.publishStagedCatalog ?? publishStagedCatalog)(
          history,
          staged.outputRoot,
          {
            ...options.publisherOptions,
            publicationLease,
            publicationMode: 'tag',
          },
        );
        let cli = skippedCli;
        if (!skippedCli) {
          try {
            await assertHead();
            cli = await (options.publishCli ?? publishCli)([mode], {
              expectedVersion: currentCliVersion,
              publishedVersion: publishedCliVersion,
              compareSemVer: compare,
              skipVerify: true,
              snapshot,
              releaseIdentity,
            });
          } catch (error) {
            throw new Error(
              `Catalog tag refs/tags/catalog-v${catalogVersion} is published, but CLI ${currentCliVersion} publication failed. ` +
              'The channel was not promoted; rerun the same combined release command after fixing the CLI failure.',
              { cause: error },
            );
          }
        }
        try {
          await assertHead();
          const promotion = await (options.promoteCatalogTag ?? promoteCatalogTag)({
            mode,
            catalogVersion,
            currentCliVersion,
            remoteUrl,
            publicationLease,
            ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
          });
          return { path: 'tag-first', catalog, cli, promotion, releaseIdentity };
        } catch (error) {
          const recoveryCommand = catalogPromotionRecoveryCommand(mode, catalogVersion);
          throw new Error(
            `CLI ${currentCliVersion} and catalog tag refs/tags/catalog-v${catalogVersion} are published, ` +
            `but channel promotion failed. Recover with: ${recoveryCommand}`,
            { cause: error },
          );
        }
      },
      options.publisherOptions,
    );
  }, options.snapshotOptions);
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await publishRelease(argv);
    console.log(
      `Published combined ${result.path} release for catalog ${result.catalog.validation.manifest.catalogVersion}.` +
      (result.cli?.status === 'already-published'
        ? ` CLI ${result.cli.version} was already published; CLI publication was skipped.`
        : ''),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
