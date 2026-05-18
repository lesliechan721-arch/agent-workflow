import path from 'node:path';

import {
  createCatalogRegistryAdapter,
  fullCatalogPackageName,
  publishCatalogRelease,
  relativeToRepo,
  runCommand,
  sidecarCatalogPackageName,
} from './common.mjs';

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  let catalogVersion;

  while (args[0] === '--') {
    args.shift();
  }

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

  return {
    mode,
    catalogVersion,
  };
}

try {
  const { mode, catalogVersion } = parseArgs(process.argv.slice(2));

  await runCommand('pnpm', ['run', 'release:verify:catalog']);
  const registry = await createCatalogRegistryAdapter();
  const staged = await publishCatalogRelease({
    channel: mode,
    catalogVersion,
    registry,
  });

  console.log(
    `Published catalog ${staged.manifest.catalogVersion} to ${mode} (${sidecarCatalogPackageName}, ${fullCatalogPackageName}).`,
  );
  console.log(
    `  sidecar: ${relativeToRepo(path.join(staged.sidecarPackageRoot, 'package.json'))}`,
  );
  console.log(
    `  full: ${relativeToRepo(path.join(staged.fullPackageRoot, 'package.json'))}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
