import fs from 'node:fs/promises';
import path from 'node:path';

import {
  computePackageTarballTreeDigest,
  computeReleasePackageContentDigest,
  loadCatalogModules,
  withPrivateCliTarball,
  withPrivateEvalTarball,
} from './common.mjs';
import {
  calculateCatalogContentDigest,
  calculateCliTrainContentDigest,
} from './release-model.mjs';
const CLI_PACKAGES = [
  '@lesliechan721/agent-skill-eval',
  '@lesliechan721/aw',
];

const BUILD_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export function projectBuildDigest(value, field) {
  if (typeof value !== 'string' || !BUILD_DIGEST_PATTERN.test(value)) {
    throw new Error(`Invalid release build ${field}: expected 64 lowercase hexadecimal characters.`);
  }
  return `sha256:${value}`;
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
