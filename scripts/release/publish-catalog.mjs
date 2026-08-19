import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertVersionKind,
  resolvePublishedCliVersion,
  runCommand,
} from './common.mjs';
import {
  publishStagedCatalog,
  readCatalogPublicationHistory,
} from './git-catalog-publisher.mjs';
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
  const history = await (options.readCatalogPublicationHistory
    ?? readCatalogPublicationHistory)({
    mode,
    catalogVersion,
    ...(options.remoteUrl ? { remoteUrl: options.remoteUrl } : {}),
    ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
  });
  const staged = await (options.stageCatalogRelease ?? stageCatalogRelease)([
    '--catalog-version',
    catalogVersion,
  ], {
    previousReleaseLedger: history.mergedLedger,
  });
  const publishedCliVersion = await (options.resolvePublishedCliVersion
    ?? resolvePublishedCliVersion)(mode);
  if (
    history.catalogModules.pluginStaging.compareStrictSemVer(
      publishedCliVersion,
      staged.manifest.compatibility.aw.minVersion,
    ) < 0
  ) {
    throw new Error(
      `Catalog ${catalogVersion} requires aw >= ${staged.manifest.compatibility.aw.minVersion}, ` +
      `but the currently published ${mode} CLI is ${publishedCliVersion}. Use the combined release entry point.`,
    );
  }
  return (options.publishStagedCatalog ?? publishStagedCatalog)(
    history,
    staged.outputRoot,
    options.publisherOptions,
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await publishCatalog(argv);
    console.log(
      `Published catalog ${result.validation.manifest.catalogVersion} (${result.mode}) at ${result.commit}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
