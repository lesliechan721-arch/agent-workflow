import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertValidVersion,
  assertReleaseSnapshotIdentity,
  catalogReleaseStagingRoot,
  combineReleaseErrors,
  ensureCatalogStagePublicationBoundary,
  loadCatalogModules,
  repoRoot,
  relativeToRepo,
  withReleaseBuildSnapshot,
} from './common.mjs';

export const catalogStageOutputRoot = path.join(catalogReleaseStagingRoot, 'catalog');

function resolvePublicationRepoRoot(options) {
  if (options.outputRoot !== undefined) {
    throw new Error(
      'Catalog stage output injection must use the internalOutputRoot option.',
    );
  }
  if (options.internalOutputRoot === undefined) {
    return repoRoot;
  }
  if (
    typeof options.internalOutputRoot !== 'string'
    || !path.isAbsolute(options.internalOutputRoot)
  ) {
    throw new Error('Internal catalog stage output must be an absolute path.');
  }
  const outputRoot = path.resolve(options.internalOutputRoot);
  const publicationRepoRoot = path.dirname(path.dirname(path.dirname(outputRoot)));
  if (
    outputRoot
    !== path.join(publicationRepoRoot, '.release', 'catalog-staging', 'catalog')
  ) {
    throw new Error(
      'Internal catalog stage output must use the fixed .release/catalog-staging/catalog layout.',
    );
  }
  return publicationRepoRoot;
}

export function parseArgs(argv) {
  const args = [...argv];
  let catalogVersion;
  while (args[0] === '--') args.shift();
  while (args.length > 0) {
    const token = args.shift();
    if (token === '--catalog-version') {
      catalogVersion = args.shift();
      continue;
    }
    throw new Error(
      `Unknown argument "${token}". Usage: node scripts/release/stage-catalog.mjs --catalog-version <version>`,
    );
  }
  if (!catalogVersion) {
    throw new Error(
      'Missing catalog version. Usage: node scripts/release/stage-catalog.mjs --catalog-version <version>',
    );
  }
  return { catalogVersion: assertValidVersion(catalogVersion) };
}

async function stageCatalogFromSnapshot(argv, snapshot, options = {}) {
  if (options.releaseIdentity) {
    assertReleaseSnapshotIdentity(snapshot, options.releaseIdentity);
  }
  const { catalogVersion } = parseArgs(argv);
  const publicationRepoRoot = resolvePublicationRepoRoot(options);
  const initialBoundary = await ensureCatalogStagePublicationBoundary(
    publicationRepoRoot,
  );
  const outputRoot = initialBoundary.publicationTargetRoot;
  const parentRoot = initialBoundary.publicationParentRoot;
  const temporaryRoot = await fs.mkdtemp(path.join(parentRoot, '.catalog-stage-'));
  let backupRoot = null;
  let published = false;
  try {
    await fs.cp(snapshot.catalogOutputRoot, temporaryRoot, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const catalogModules = options.catalogModules ?? await loadCatalogModules(snapshot.cliDistRoot);
    const staged = await catalogModules.pluginStaging.stageCatalogArtifacts({
      repoRoot: snapshot.root,
      outputRoot: temporaryRoot,
      phase: 'release',
      catalogVersion,
      ...(options.previousReleaseLedger
        ? { previousReleaseLedger: options.previousReleaseLedger }
        : {}),
    });
    const validation = await catalogModules.catalogSnapshot.validateCatalogSnapshot(temporaryRoot);
    const ledger = catalogModules.pluginStaging.validatePluginReleaseLedgerAgainstManifest(
      JSON.parse(await fs.readFile(path.join(temporaryRoot, 'plugin-release-ledger.json'), 'utf8')),
      validation.manifest,
    );
    if (validation.manifest.catalogVersion !== catalogVersion) {
      throw new Error(
        `Catalog stage version mismatch: expected ${catalogVersion}, found ${validation.manifest.catalogVersion}.`,
      );
    }
    const publicationBoundary = await ensureCatalogStagePublicationBoundary(
      publicationRepoRoot,
    );
    if (publicationBoundary.targetExists) {
      backupRoot = path.join(parentRoot, `.catalog-backup-${crypto.randomUUID()}`);
      await fs.rename(outputRoot, backupRoot);
    }
    try {
      await fs.rename(temporaryRoot, outputRoot);
    } catch (error) {
      if (backupRoot) {
        try {
          await fs.rename(backupRoot, outputRoot);
        } catch (restoreError) {
          throw combineReleaseErrors(
            error,
            restoreError,
            'Catalog staging previous output restoration also failed',
          );
        }
      }
      throw error;
    }
    published = true;
    if (backupRoot) {
      await fs.rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      outputRoot,
      manifest: staged.manifest,
      releaseLedger: ledger,
      snapshotDigest: validation.snapshotDigest,
      generationId: snapshot.generationId,
      outputDigest: snapshot.outputDigest,
      inputDigest: snapshot.inputDigest,
      cliPackageDigest: snapshot.cliPackageDigest,
      ...(options.releaseIdentity ? { releaseIdentity: options.releaseIdentity } : {}),
    };
  } finally {
    if (!published) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

export async function stageCatalogRelease(argv = process.argv.slice(2), options = {}) {
  if (options.snapshot) {
    return stageCatalogFromSnapshot(argv, options.snapshot, options);
  }
  return withReleaseBuildSnapshot(
    (snapshot) => stageCatalogFromSnapshot(argv, snapshot, options),
    options.snapshotOptions,
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const staged = await stageCatalogRelease(argv);
    console.log(
      `Staged catalog ${staged.manifest.catalogVersion} (${staged.manifest.channel}) at ${relativeToRepo(staged.outputRoot)}.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === currentEntryPath) await main();
