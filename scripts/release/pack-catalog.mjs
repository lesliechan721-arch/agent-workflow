import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanTarballs,
  combineReleaseErrors,
  createCatalogReleaseStaging,
  loadCatalogModules,
  packCatalogPackage,
  prepareCatalogRelease,
  relativeToRepo,
  tarballDir,
  withReleaseBuildSnapshot,
} from './common.mjs';

export function parseArgs(argv) {
  const args = [...argv];
  let channel;
  let catalogVersion;

  while (args[0] === '--') {
    args.shift();
  }

  while (args.length > 0) {
    const token = args.shift();
    if (token === '--channel') {
      channel = args.shift();
      continue;
    }
    if (token === '--catalog-version') {
      catalogVersion = args.shift();
      continue;
    }
    throw new Error(
      `Unknown argument "${token}". Usage: node scripts/release/pack-catalog.mjs [--channel latest|beta] --catalog-version <version>`,
    );
  }

  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/pack-catalog.mjs [--channel latest|beta] --catalog-version <version>',
    );
  }

  return {
    channel,
    catalogVersion,
  };
}

async function packCatalogReleaseFromSnapshot(argv, snapshot) {
  const { channel, catalogVersion } = parseArgs(argv);
  const catalogModules = await loadCatalogModules(snapshot.cliDistRoot);
  const releaseStaging = await createCatalogReleaseStaging({
    sourceRoot: snapshot.catalogOutputRoot,
  });
  let result;
  let releaseError;
  try {
    const staged = await prepareCatalogRelease({
      channel,
      catalogVersion,
      outputRoot: releaseStaging.outputRoot,
      catalogModules,
      cliDistRoot: snapshot.cliDistRoot,
      sourceRepoRoot: snapshot.root,
    });

    const sidecarDestination = path.join(tarballDir, 'catalog', 'sidecar');
    const fullDestination = path.join(tarballDir, 'catalog', 'full');
    await Promise.all([
      cleanTarballs(sidecarDestination),
      cleanTarballs(fullDestination),
    ]);
    const packResults = await Promise.allSettled([
      packCatalogPackage({
        kind: 'sidecar',
        destination: sidecarDestination,
        outputRoot: releaseStaging.outputRoot,
        catalogModules,
        cliDistRoot: snapshot.cliDistRoot,
      }),
      packCatalogPackage({
        kind: 'full',
        destination: fullDestination,
        outputRoot: releaseStaging.outputRoot,
        catalogModules,
        cliDistRoot: snapshot.cliDistRoot,
      }),
    ]);
    const packFailures = packResults
      .filter((packResult) => packResult.status === 'rejected')
      .map((packResult) => packResult.reason);
    if (packFailures.length > 0) {
      let packError = packFailures[0];
      for (const additionalPackError of packFailures.slice(1)) {
        packError = combineReleaseErrors(
          packError,
          additionalPackError,
          'An additional catalog pack also failed',
        );
      }

      const cleanupResults = await Promise.allSettled([
        cleanTarballs(sidecarDestination),
        cleanTarballs(fullDestination),
      ]);
      for (const cleanupResult of cleanupResults) {
        if (cleanupResult.status === 'rejected') {
          packError = combineReleaseErrors(
            packError,
            cleanupResult.reason,
            'Catalog tarball cleanup also failed',
          );
        }
      }
      throw packError;
    }

    const sidecarTarballPath = packResults[0].value;
    const fullTarballPath = packResults[1].value;

    result = {
      catalogVersion: staged.manifest.catalogVersion,
      channel: staged.manifest.channel,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      sidecarTarballPath,
      fullTarballPath,
    };
  } catch (error) {
    releaseError = error;
  }

  try {
    await releaseStaging.cleanup();
  } catch (cleanupError) {
    if (releaseError) {
      throw combineReleaseErrors(
        releaseError,
        cleanupError,
        'Catalog pack staging cleanup also failed',
      );
    }
    throw cleanupError;
  }

  if (releaseError) {
    throw releaseError;
  }
  return result;
}

export async function packCatalogRelease(argv = process.argv.slice(2), options = {}) {
  if (options.snapshot) {
    return packCatalogReleaseFromSnapshot(argv, options.snapshot);
  }
  return withReleaseBuildSnapshot(
    (snapshot) => packCatalogReleaseFromSnapshot(argv, snapshot),
    options.snapshotOptions,
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const packed = await packCatalogRelease(argv);
    console.log(`Packed catalog ${packed.catalogVersion} (${packed.channel}).`);
    console.log(`  sidecar: ${relativeToRepo(packed.sidecarTarballPath)}`);
    console.log(`  full: ${relativeToRepo(packed.fullTarballPath)}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  await main();
}
