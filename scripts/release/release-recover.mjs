import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseWorktreeClean, compareReleaseSemVer, runCommand } from './common.mjs';
import {
  promoteCatalogTag,
  resolveCatalogMaintenanceRemote,
  withCatalogPublicationLease,
} from './git-catalog-publisher.mjs';
import { readRegistryReleaseHistory } from './release-observe.mjs';
import {
  calculateCliTrainContentDigest,
  canonicalJson,
} from './release-model.mjs';
import {
  CLI_PACKAGES,
  normalizeCliRegistryHistory,
  resolveCliPublishedHistory,
} from './release-state.mjs';

const CATALOG_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/u;

export function parseRecoverArgs(argv) {
  const args = [...argv];
  while (args[0] === '--') args.shift();
  if (args.length !== 2 || args[0] !== 'catalog') {
    throw new Error('Usage: pnpm release:recover -- catalog <x.y.z[-beta.N]>');
  }
  const catalogVersion = args[1];
  if (!CATALOG_VERSION_PATTERN.test(catalogVersion)) {
    throw new Error('Catalog recovery version must be canonical x.y.z or x.y.z-beta.N.');
  }
  return {
    kind: 'catalog',
    catalogVersion,
    mode: catalogVersion.includes('-beta.') ? 'beta' : 'latest',
  };
}

export async function resolvePublishedCliTrain(mode, options = {}) {
  return (await readPublishedCliTrainIdentity(mode, options)).currentCliVersion;
}

async function readPublishedCliTrainIdentity(mode, options = {}) {
  const history = await (options.readRegistryReleaseHistory ?? readRegistryReleaseHistory)(options);
  const normalized = normalizeCliRegistryHistory(history);
  resolveCliPublishedHistory(history);
  const versions = CLI_PACKAGES.map((name) => normalized.distTags[name][mode]);
  if (versions.some((version) => version === null) || versions[0] !== versions[1]) {
    throw new Error(`Catalog recovery requires matching published ${mode} dist-tags for both CLI packages.`);
  }
  const currentCliVersion = versions[0];
  const packages = CLI_PACKAGES.map((name) => {
    const exact = normalized.packages.get(name).find((entry) =>
      entry.candidateVersion === currentCliVersion);
    if (!exact?.metadata) {
      throw new Error(`Catalog recovery requires schema-1 awRelease metadata for ${name}@${currentCliVersion}.`);
    }
    return { name, metadata: exact.metadata };
  });
  const metadata = packages[0].metadata;
  if (packages.some((entry) =>
    entry.metadata.candidateVersion !== currentCliVersion
    || entry.metadata.targetVersion !== metadata.targetVersion
    || entry.metadata.planId !== metadata.planId
    || entry.metadata.sourceHead !== metadata.sourceHead
    || entry.metadata.trainContentDigest !== metadata.trainContentDigest)) {
    throw new Error(`Catalog recovery requires one consistent schema-1 CLI train at ${currentCliVersion}.`);
  }
  const trainContentDigest = calculateCliTrainContentDigest(packages.map((entry) => ({
    name: entry.name,
    contentDigest: entry.metadata.packageContentDigest,
  })));
  if (trainContentDigest !== metadata.trainContentDigest) {
    throw new Error(`Catalog recovery CLI train ${currentCliVersion} has an invalid trainContentDigest.`);
  }
  return {
    currentCliVersion,
    planId: metadata.planId,
    sourceHead: metadata.sourceHead,
    trainContentDigest,
    registry: history,
  };
}

function catalogRecoveryIdentity(history) {
  const publication = (entry) => entry ? {
    commit: entry.commit ?? null,
    snapshotDigest: entry.snapshotDigest ?? null,
    catalogContentDigest: entry.catalogContentDigest ?? null,
    manifest: entry.manifest ?? null,
    ledger: entry.ledger ?? null,
  } : null;
  return {
    channels: {
      latest: publication(history.channels?.latest),
      beta: publication(history.channels?.beta),
    },
    tag: history.tag ? {
      objectId: history.tag.objectId ?? null,
      catalogVersion: history.tag.catalogVersion ?? null,
      ...publication(history.tag),
    } : null,
    pending: history.pending ?? null,
    mergedLedger: history.mergedLedger ?? null,
  };
}

async function resolveRecoveryBinding(mode, catalogVersion, options) {
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const history = await (options.readCatalogPublicationHistory
    ?? (await import('./git-catalog-publisher.mjs')).readCatalogPublicationHistory)({
    mode,
    catalogVersion,
    remoteUrl,
    ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
  });
  if (!history.tag || history.pending !== history.tag.commit) {
    throw new Error('Catalog recovery requires the exact immutable tag and tag-first pending guard.');
  }
  const manifest = history.tag.manifest;
  const cli = options.resolvePublishedCliTrain
    ? {
      currentCliVersion: await options.resolvePublishedCliTrain(mode, options),
      planId: manifest.release?.planId,
      sourceHead: manifest.release?.sourceHead,
      registry: null,
    }
    : await readPublishedCliTrainIdentity(mode, options);
  if (manifest.catalogVersion !== catalogVersion || history.tag.catalogVersion !== catalogVersion) {
    throw new Error('Catalog recovery tag contains the wrong catalog version.');
  }
  if (
    manifest.schemaVersion !== 4
    || manifest.release?.state !== 'published'
    || manifest.release.planId !== cli.planId
    || manifest.release.sourceHead !== cli.sourceHead
  ) {
    throw new Error('Catalog recovery tag release identity does not match the published CLI train.');
  }
  if (compareReleaseSemVer(cli.currentCliVersion, manifest.compatibility.aw.minVersion) < 0) {
    throw new Error(
      `Catalog ${catalogVersion} requires aw >= ${manifest.compatibility.aw.minVersion}, ` +
      `but published ${mode} CLI is ${cli.currentCliVersion}.`,
    );
  }
  return {
    currentCliVersion: cli.currentCliVersion,
    identity: canonicalJson(JSON.parse(JSON.stringify({
      currentCliVersion: cli.currentCliVersion,
      registry: cli.registry,
      catalog: catalogRecoveryIdentity(history),
    }))),
  };
}

export async function assertRecoveryBindingFresh(
  initialBinding,
  mode,
  catalogVersion,
  options = {},
) {
  const resolveBinding = options.resolveRecoveryBinding ?? resolveRecoveryBinding;
  const liveBinding = await resolveBinding(mode, catalogVersion, options);
  if (liveBinding.identity !== initialBinding.identity) {
    throw new Error('Published CLI train or Catalog tag identity changed during catalog recovery.');
  }
  return liveBinding;
}

export async function recoverRelease(argv = process.argv.slice(2), options = {}) {
  const { mode, catalogVersion } = parseRecoverArgs(argv);
  const assertClean = options.assertReleaseWorktreeClean ?? assertReleaseWorktreeClean;
  await assertClean();
  await (options.runCommand ?? runCommand)('pnpm', ['run', 'release:verify:catalog']);
  await assertClean();
  const resolveBinding = options.resolveRecoveryBinding ?? resolveRecoveryBinding;
  const binding = await resolveBinding(mode, catalogVersion, options);
  const currentCliVersion = binding.currentCliVersion;
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const callerBeforeAcquire = options.publisherOptions?.beforeAcquire;
  const callerBeforeRemoteWrite = options.beforeRemoteWrite;
  const assertBindingFresh = async () => {
    await assertClean();
    return assertRecoveryBindingFresh(binding, mode, catalogVersion, {
      ...options,
      resolveRecoveryBinding: resolveBinding,
    });
  };
  return (options.withCatalogPublicationLease ?? withCatalogPublicationLease)(
    remoteUrl,
    (publicationLease) => (options.promoteCatalogTag ?? promoteCatalogTag)({
      mode,
      catalogVersion,
      currentCliVersion,
      remoteUrl,
      publicationLease,
      requirePendingGuard: true,
      beforeRemoteWrite: async () => {
        await callerBeforeRemoteWrite?.();
        await assertBindingFresh();
      },
      ...(options.catalogModules ? { catalogModules: options.catalogModules } : {}),
    }),
    {
      ...options.publisherOptions,
      beforeAcquire: async () => {
        await callerBeforeAcquire?.();
        await assertBindingFresh();
      },
    },
  );
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await recoverRelease(argv);
    process.stdout.write(`Recovered catalog ${result.mode} channel at ${result.commit}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
