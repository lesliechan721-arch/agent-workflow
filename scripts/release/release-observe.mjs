import fs from 'node:fs/promises';
import path from 'node:path';

import {
  captureCommand,
  cliPackageJsonPath,
  computePackageTarballTreeDigest,
  computeReleasePackageContentDigest,
  loadCatalogModules,
  repoRoot as defaultRepoRoot,
  resolveReleaseHead,
  resolveRegistryUrl,
  withPrivateCliTarball,
  withPrivateEvalTarball,
  withReleaseBuildSnapshot,
} from './common.mjs';
import {
  readCatalogPublicationHistory,
  resolveCatalogMaintenanceRemote,
} from './git-catalog-publisher.mjs';
import {
  calculateCatalogContentDigest,
  calculateCliTrainContentDigest,
} from './release-model.mjs';
import { readVersionTargets } from './release-target.mjs';
import { CLI_PACKAGES } from './release-state.mjs';

const CANDIDATE_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-beta\.[1-9]\d*)?$/;
const BUILD_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export function projectBuildDigest(value, field) {
  if (typeof value !== 'string' || !BUILD_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid release build ${field}: expected 64 lowercase hexadecimal characters.`);
  }
  return `sha256:${value}`;
}

async function captureRegistry(args, options) {
  const registryUrl = options.registryUrl ?? await resolveRegistryUrl(
    options.packageJsonPath ?? cliPackageJsonPath,
    options.env ?? process.env,
  );
  return (options.captureCommand ?? captureCommand)('pnpm', [
    'view', ...args, '--json', '--registry', registryUrl,
  ], {
    cwd: options.repoRoot ?? defaultRepoRoot,
    timeoutMs: options.timeoutMs,
    env: {
      ...(options.env ?? process.env),
      AW_RELEASE_NPM_REGISTRY_URL: registryUrl,
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
    },
  });
}

export async function readRegistryReleaseHistory(options = {}) {
  const result = { distTags: {} };
  for (const packageName of CLI_PACKAGES) {
    let versionsOutput;
    try {
      versionsOutput = await captureRegistry([packageName, 'versions'], options);
    } catch (error) {
      if (/E404|404 Not Found|is not in this registry/iu.test(String(error?.message))) {
        result[packageName] = [];
        result.distTags[packageName] = { latest: null, beta: null };
        continue;
      }
      throw error;
    }
    let versions;
    try {
      versions = JSON.parse(versionsOutput.stdout);
    } catch (error) {
      throw new Error(`Registry returned invalid versions for ${packageName}.`, { cause: error });
    }
    if (!Array.isArray(versions)) throw new Error(`Registry returned invalid versions for ${packageName}.`);
    const tagsResult = await captureRegistry([packageName, 'dist-tags'], options);
    let rawTags;
    try {
      rawTags = JSON.parse(tagsResult.stdout);
    } catch (error) {
      throw new Error(`Registry returned invalid dist-tags for ${packageName}.`, { cause: error });
    }
    if (!rawTags || typeof rawTags !== 'object' || Array.isArray(rawTags)) {
      throw new Error(`Registry returned invalid dist-tags for ${packageName}.`);
    }
    result.distTags[packageName] = {
      latest: typeof rawTags.latest === 'string' ? rawTags.latest : null,
      beta: typeof rawTags.beta === 'string' ? rawTags.beta : null,
    };
    result[packageName] = [];
    for (const version of versions) {
      if (typeof version !== 'string' || !CANDIDATE_PATTERN.test(version)) {
        throw new Error(`Registry returned an unsupported version for ${packageName}.`);
      }
      const metadataResult = await captureRegistry([`${packageName}@${version}`, 'awRelease'], options);
      let awRelease = null;
      if (metadataResult.stdout.trim() !== '') {
        try {
          awRelease = JSON.parse(metadataResult.stdout);
        } catch (error) {
          throw new Error(`Registry returned invalid awRelease metadata for ${packageName}@${version}.`, {
            cause: error,
          });
        }
        if (awRelease !== null && (
          typeof awRelease !== 'object'
          || Array.isArray(awRelease)
          || Object.getPrototypeOf(awRelease) !== Object.prototype
        )) {
          throw new Error(`Registry returned invalid awRelease metadata for ${packageName}@${version}.`);
        }
      }
      result[packageName].push({ version, awRelease });
    }
  }
  return result;
}

export async function readCliReleaseContent(snapshot, options = {}) {
  const packageDigests = await withPrivateCliTarball(snapshot, (cliTarball) =>
    withPrivateEvalTarball(snapshot, async (evalTarball) => ({
        '@lesliechan721/aw': {
          contentDigest: await computeReleasePackageContentDigest(cliTarball),
          tarballDigest: await computePackageTarballTreeDigest(cliTarball),
        },
        '@lesliechan721/agent-skill-eval': {
          contentDigest: await computeReleasePackageContentDigest(evalTarball),
          tarballDigest: await computePackageTarballTreeDigest(evalTarball),
        },
      }), { quiet: true, ...options.packOptions }), { quiet: true, ...options.packOptions });
  const packages = CLI_PACKAGES.map((name) => ({ name, ...packageDigests[name] }));
  return {
    packages,
    trainContentDigest: calculateCliTrainContentDigest(packages.map(({ name, contentDigest }) => ({
      name,
      contentDigest,
    }))),
  };
}

export async function readCurrentReleaseContent(snapshot, sourceHead, options = {}) {
  const [catalogModules, marketplace, cli] = await Promise.all([
    loadCatalogModules(snapshot.cliDistRoot),
    fs.readFile(path.join(snapshot.catalogOutputRoot, '.agents', 'plugins', 'marketplace.json'), 'utf8')
      .then(JSON.parse),
    readCliReleaseContent(snapshot, options),
  ]);
  const validation = await catalogModules.catalogSnapshot.validateCatalogSnapshot(
    snapshot.catalogOutputRoot,
  );
  const plugins = validation.manifest.entries.map((entry) => ({
    name: entry.name,
    targetVersion: entry.version,
    contentDigest: entry.contentDigest,
  }));
  return {
    source: {
      head: sourceHead,
      releaseInputDigest: projectBuildDigest(snapshot.inputDigest, 'inputDigest'),
      buildOutputDigest: projectBuildDigest(snapshot.outputDigest, 'outputDigest'),
      cliPackageDigest: projectBuildDigest(snapshot.cliPackageDigest, 'cliPackageDigest'),
    },
    cli,
    catalog: {
      plugins,
      minCliVersion: validation.manifest.compatibility.aw.minVersion,
      contentDigest: calculateCatalogContentDigest({
        schemaIdentity: { schemaVersion: validation.manifest.schemaVersion },
        marketplaceMetadata: {
          name: marketplace.name,
          owner: marketplace.owner,
          interface: marketplace.interface,
        },
        compatibility: validation.manifest.compatibility,
        plugins,
      }),
    },
  };
}

export async function observeReleaseHistory({ targets, channel, cliDistRoot, ...options }) {
  const remoteUrl = resolveCatalogMaintenanceRemote(options);
  const [registry, rawCatalogHistory] = await Promise.all([
    (options.readRegistryHistory ?? readRegistryReleaseHistory)(options),
    (options.readCatalogHistory ?? readCatalogPublicationHistory)({
      catalogVersion: targets.catalog,
      mode: channel === undefined ? null : channel === 'stable' ? 'latest' : 'beta',
      cliDistRoot,
      remoteUrl,
    }),
  ]);
  return {
    registry,
    catalog: rawCatalogHistory.channels
      ? projectCatalogHistory(rawCatalogHistory)
      : rawCatalogHistory,
  };
}

function projectCatalogHistory(history) {
  const channel = (entry) => entry ? {
    commit: entry.commit,
    manifest: {
      catalogVersion: entry.manifest.catalogVersion,
      channel: entry.manifest.channel,
    },
    snapshotDigest: entry.snapshotDigest,
    catalogContentDigest: entry.catalogContentDigest,
    ledger: entry.ledger,
  } : null;
  return {
    latest: channel(history.channels.latest),
    beta: channel(history.channels.beta),
    tag: channel(history.tag),
    pending: history.pending,
    ledger: {
      schemaVersion: 2,
      records: [
        ...(history.mergedLedger?.records ?? []),
        ...(history.tag?.ledger?.records ?? []),
      ],
    },
  };
}

export async function observeRelease(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const targets = await (options.readTargets ?? readVersionTargets)(repoRoot);
  const snapshotRunner = options.withReleaseBuildSnapshot ?? withReleaseBuildSnapshot;
  return snapshotRunner(async (snapshot) => {
    const sourceHead = await (options.resolveHead ?? resolveReleaseHead)({ cwd: repoRoot });
    const content = await (options.readContent ?? readCurrentReleaseContent)(snapshot, sourceHead, options);
    const history = await observeReleaseHistory({
      ...options,
      targets,
      channel: options.channel,
      cliDistRoot: snapshot.cliDistRoot,
      repoRoot,
    });
    return {
      targets,
      content,
      releaseIdentity: {
        generationId: snapshot.generationId,
        outputDigest: snapshot.outputDigest,
        inputDigest: snapshot.inputDigest,
        cliPackageDigest: snapshot.cliPackageDigest,
        headCommit: sourceHead,
      },
      history,
    };
  }, { repoRoot, quiet: true });
}
