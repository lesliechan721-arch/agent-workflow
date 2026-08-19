import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import { bundlePlugins } from '../../scripts/bundle-plugins.js';
import {
  CATALOG_FULL_PACKAGE_NAME,
  CATALOG_MANIFEST_FILENAME,
  CATALOG_SIDECAR_PACKAGE_NAME,
  getCatalogFullPackageRoot,
  getCatalogSidecarPackageRoot,
} from '../../src/utils/bundle-layout.js';
import type {
  CatalogPackageArchiveIdentity,
  CatalogPackageSource,
} from '../../src/utils/marketplace.js';
import type { CatalogChannel, CatalogManifest } from '../../src/types.js';

export interface PerfCatalogFixture {
  channel: CatalogChannel;
  catalogVersion: string;
  cliVersion: string;
  fullRoot: string;
  sidecarRoot: string;
  pluginNames: string[];
}

function sourceRepositoryRoot(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
}

export async function createPerfCatalogFixture(
  suiteRoot: string,
): Promise<PerfCatalogFixture> {
  const repoRoot = path.join(suiteRoot, 'repo');
  const outputRoot = path.join(suiteRoot, 'catalog-build');
  await fs.copy(path.join(sourceRepositoryRoot(), 'plugins'), path.join(repoRoot, 'plugins'));
  await bundlePlugins({ repoRoot, outputRoot });

  const sidecarRoot = getCatalogSidecarPackageRoot(outputRoot);
  const fullRoot = getCatalogFullPackageRoot(outputRoot);
  const snapshotManifest = await fs.readJson(path.join(outputRoot, CATALOG_MANIFEST_FILENAME));
  const manifest: CatalogManifest = {
    schemaVersion: 2,
    catalogVersion: snapshotManifest.catalogVersion,
    channel: snapshotManifest.channel,
    compatibility: snapshotManifest.compatibility,
    packages: {
      sidecar: {
        name: CATALOG_SIDECAR_PACKAGE_NAME,
        version: snapshotManifest.catalogVersion,
        channel: snapshotManifest.channel,
      },
      full: {
        name: CATALOG_FULL_PACKAGE_NAME,
        version: snapshotManifest.catalogVersion,
        channel: snapshotManifest.channel,
        manifestPath: `./${CATALOG_MANIFEST_FILENAME}`,
      },
    },
    entries: snapshotManifest.entries.map(({ contentDigest: _contentDigest, ...entry }: {
      contentDigest: string;
      [key: string]: unknown;
    }) => entry),
  } as CatalogManifest;
  await Promise.all([
    fs.outputJson(path.join(sidecarRoot, CATALOG_MANIFEST_FILENAME), manifest),
    fs.outputJson(path.join(fullRoot, CATALOG_MANIFEST_FILENAME), manifest),
    fs.copy(path.join(outputRoot, '.agents'), path.join(fullRoot, '.agents')),
    fs.copy(path.join(outputRoot, '.claude-plugin'), path.join(fullRoot, '.claude-plugin')),
    fs.copy(path.join(outputRoot, 'plugins'), path.join(fullRoot, 'plugins')),
  ]);
  if (manifest.entries.length < 3) {
    throw new Error(
      `Performance catalog fixture requires at least 3 plugins, found ${manifest.entries.length}.`,
    );
  }

  return {
    channel: manifest.channel,
    catalogVersion: manifest.catalogVersion,
    cliVersion: manifest.catalogVersion,
    fullRoot,
    sidecarRoot,
    pluginNames: manifest.entries.map((entry) => entry.name),
  };
}

export function createFixtureCatalogPackageSource(
  fixture: PerfCatalogFixture,
): CatalogPackageSource {
  function createIdentity(
    packageName: string,
    requestedDistTag?: CatalogChannel,
  ): CatalogPackageArchiveIdentity {
    return {
      packageName,
      version: fixture.catalogVersion,
      integrity: `sha512-perf-${packageName}`,
      ...(requestedDistTag ? { requestedDistTag } : {}),
    };
  }

  return {
    resolveIdentityByDistTag: async (packageName, distTag) => {
      if (distTag !== fixture.channel) {
        throw new Error(`Unexpected catalog dist-tag: ${distTag}.`);
      }
      return createIdentity(packageName, distTag);
    },
    resolveIdentityByVersion: async (packageName, version) => {
      if (version !== fixture.catalogVersion) {
        throw new Error(`Unexpected catalog version: ${version}.`);
      }
      return createIdentity(packageName);
    },
    downloadArchive: async (identity) => {
      const packageRoot = identity.packageName === CATALOG_SIDECAR_PACKAGE_NAME
        ? fixture.sidecarRoot
        : identity.packageName === CATALOG_FULL_PACKAGE_NAME
          ? fixture.fullRoot
          : undefined;
      if (!packageRoot) {
        throw new Error(`Unexpected catalog package: ${identity.packageName}.`);
      }
      const manifestText = await fs.readFile(
        path.join(packageRoot, CATALOG_MANIFEST_FILENAME),
        'utf8',
      );
      return {
        identity,
        manifestText,
        rawManifest: JSON.parse(manifestText) as unknown,
        packageRoot,
        materialize: async (targetRoot: string) => {
          await fs.copy(packageRoot, targetRoot);
        },
        dispose: async () => {},
      };
    },
  };
}

export function createUnexpectedRemoteCatalogSource(
  onCall: () => void,
): CatalogPackageSource {
  const fail = async (): Promise<never> => {
    onCall();
    throw new Error('Warm cache benchmark unexpectedly accessed the remote source.');
  };
  return {
    resolveIdentityByDistTag: fail,
    resolveIdentityByVersion: fail,
    downloadArchive: fail,
  };
}
