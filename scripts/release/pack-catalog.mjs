import path from 'node:path';

import {
  cleanTarballs,
  packCatalogPackage,
  prepareCatalogRelease,
  relativeToRepo,
  runCommand,
  tarballDir,
} from './common.mjs';

function parseArgs(argv) {
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

try {
  const { channel, catalogVersion } = parseArgs(process.argv.slice(2));
  await runCommand('pnpm', ['build']);
  const staged = await prepareCatalogRelease({
    channel,
    catalogVersion,
  });

  const sidecarDestination = path.join(tarballDir, 'catalog', 'sidecar');
  const fullDestination = path.join(tarballDir, 'catalog', 'full');
  await Promise.all([
    cleanTarballs(sidecarDestination),
    cleanTarballs(fullDestination),
  ]);
  const [sidecarTarballPath, fullTarballPath] = await Promise.all([
    packCatalogPackage({
      kind: 'sidecar',
      destination: sidecarDestination,
    }),
    packCatalogPackage({
      kind: 'full',
      destination: fullDestination,
    }),
  ]);

  console.log(`Packed catalog ${staged.manifest.catalogVersion} (${staged.manifest.channel}).`);
  console.log(`  sidecar: ${relativeToRepo(sidecarTarballPath)}`);
  console.log(`  full: ${relativeToRepo(fullTarballPath)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
