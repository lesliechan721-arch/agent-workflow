import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  preflightCatalogRelease,
  publishCatalogRelease,
  readCliPackageJson,
  runCommand,
  withReleaseBuildSnapshot,
} from './common.mjs';
import { publishCli } from './publish-cli.mjs';

export function parseArgs(argv) {
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

export async function runReleasePreflight() {
  await runCommand('pnpm', ['run', 'release:verify:cli']);
  await runCommand('pnpm', ['run', 'release:verify:catalog']);
}

function assertReleaseSnapshot(label, releaseResult, snapshot) {
  if (releaseResult.generationId !== snapshot.generationId) {
    throw new Error(
      `${label} build generation mismatch: expected ${snapshot.generationId}, found ${releaseResult.generationId}.`,
    );
  }
  if (releaseResult.outputDigest !== snapshot.outputDigest) {
    throw new Error(
      `${label} build output mismatch: expected ${snapshot.outputDigest}, found ${releaseResult.outputDigest}.`,
    );
  }
}

export async function publishRelease(argv = process.argv.slice(2)) {
  const { mode, cliVersion, catalogVersion } = parseArgs(argv);
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

  await runReleasePreflight();
  return withReleaseBuildSnapshot(async (snapshot) => {
    const catalogPreflight = await preflightCatalogRelease({
      channel: mode,
      catalogVersion,
      snapshot,
    });
    assertReleaseSnapshot('Catalog preflight', catalogPreflight, snapshot);

    let cliPublished;
    try {
      cliPublished = await publishCli([mode], {
        expectedVersion: currentCliVersion,
        skipVerify: true,
        snapshot,
      });
      assertReleaseSnapshot('CLI publish', cliPublished, snapshot);
      status.cli = `published (${currentCliVersion})`;
    } catch (error) {
      status.cli = `failed (${currentCliVersion})`;
      throw error;
    }

    let catalogPublished;
    try {
      catalogPublished = await publishCatalogRelease({
        channel: mode,
        catalogVersion,
        snapshot,
      });
      assertReleaseSnapshot('Catalog publish', catalogPublished, snapshot);
      status.catalog = `published (${catalogVersion})`;
    } catch (error) {
      status.catalog = `failed (${catalogVersion})`;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Combined release failed after CLI publish.\nCLI: ${status.cli}\nCatalog: ${status.catalog}\nRe-run catalog only: pnpm run release:publish:catalog:${mode} -- --catalog-version ${catalogVersion}\nDetails: ${detail}`,
      );
    }

    return {
      mode,
      currentCliVersion,
      catalogVersion,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
    };
  });
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const { mode, currentCliVersion, catalogVersion, generationId } = await publishRelease(argv);
    console.log(
      `Published CLI ${currentCliVersion} and catalog ${catalogVersion} to ${mode} from build generation ${generationId}.`,
    );
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
