import { readCliPackageJson, runCommand } from './common.mjs';

function parseArgs(argv) {
  const args = [...argv];
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
      `Unknown argument "${token}". Usage: node scripts/release/pack-release.mjs --catalog-version <version>`,
    );
  }

  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/pack-release.mjs --catalog-version <version>',
    );
  }

  return {
    catalogVersion,
  };
}

try {
  const { catalogVersion } = parseArgs(process.argv.slice(2));
  const cliPackageJson = await readCliPackageJson();
  await runCommand('node', ['scripts/release/pack-cli.mjs']);
  await runCommand('node', ['scripts/release/pack-catalog.mjs', '--catalog-version', catalogVersion]);
  console.log(
    `Packed CLI ${cliPackageJson.version} and catalog ${catalogVersion}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
