import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertVersionKind, readCliPackageJson, runCommand } from './common.mjs';
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
  await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify']);
  const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
    '--catalog-version',
    catalogVersion,
  ]);
  throw new Error(
    `Release ${currentCliVersion} / catalog ${catalogVersion} (${mode}) stopped after local staging at ${staged.outputRoot}. ` +
    'Remote Git catalog publishing is not available until Phase 4B; the CLI was not published.',
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await publishRelease(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
