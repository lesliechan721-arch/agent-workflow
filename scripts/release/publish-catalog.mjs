import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertVersionKind, runCommand } from './common.mjs';
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
  await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify:catalog']);
  const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
    '--catalog-version',
    catalogVersion,
  ]);
  throw new Error(
    `Catalog ${catalogVersion} (${mode}) is staged at ${staged.outputRoot}. ` +
    'Remote Git catalog publishing is not available until Phase 4B.',
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    await publishCatalog(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
