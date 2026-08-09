import {
  publishCatalogRelease,
  runCommand,
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
  const published = await publishCatalogRelease({
    channel: mode,
    catalogVersion,
  });

  console.log(
    `Published catalog ${published.catalogVersion} to ${published.channel} (${published.packages.sidecar.name}, ${published.packages.full.name}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
