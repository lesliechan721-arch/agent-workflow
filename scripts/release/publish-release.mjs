import { readCliPackageJson, runCommand } from './common.mjs';

function parseArgs(argv) {
  const args = [...argv];
  const mode = args.shift();
  let cliVersion;
  let catalogVersion;

  while (args[0] === '--') {
    args.shift();
  }

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

  return {
    mode,
    cliVersion,
    catalogVersion,
  };
}

try {
  const { mode, cliVersion, catalogVersion } = parseArgs(process.argv.slice(2));
  const cliPackageJson = await readCliPackageJson();
  const currentCliVersion = String(cliPackageJson.version);
  if (cliVersion && cliVersion !== currentCliVersion) {
    throw new Error(
      `CLI version mismatch: expected ${cliVersion}, found ${currentCliVersion} in packages/cli/package.json.`,
    );
  }

  const status = {
    cli: `pending (${currentCliVersion})`,
    catalog: `pending (${catalogVersion})`,
  };

  try {
    await runCommand('node', ['scripts/release/publish-cli.mjs', mode]);
    status.cli = `published (${currentCliVersion})`;
  } catch (error) {
    status.cli = `failed (${currentCliVersion})`;
    throw error;
  }

  try {
    await runCommand('node', [
      'scripts/release/publish-catalog.mjs',
      mode,
      '--catalog-version',
      catalogVersion,
    ]);
    status.catalog = `published (${catalogVersion})`;
    console.log(
      `Published CLI ${currentCliVersion} and catalog ${catalogVersion} to ${mode}.`,
    );
  } catch (error) {
    status.catalog = `failed (${catalogVersion})`;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Combined release failed after CLI publish.\nCLI: ${status.cli}\nCatalog: ${status.catalog}\nRe-run catalog only: pnpm run release:publish:catalog:${mode} -- --catalog-version ${catalogVersion}\nDetails: ${detail}`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
