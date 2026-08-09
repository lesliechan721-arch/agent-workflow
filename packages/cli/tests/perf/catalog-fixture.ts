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
} from '../../scripts/plugin-staging.js';
import type {
  CatalogPackageArchiveIdentity,
  CatalogPackageSource,
} from '../../src/utils/marketplace.js';
import type { CatalogChannel, CatalogManifest } from '../../src/types.js';
import { createMinimalPluginInstallStateFixtureBuilder } from '../helpers/minimal-plugin-install-state-fixtures.js';

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
  const manifest = await fs.readJson(
    path.join(sidecarRoot, CATALOG_MANIFEST_FILENAME),
  ) as CatalogManifest;
  if (manifest.entries.length < 4) {
    throw new Error(`Performance catalog fixture requires at least 4 plugins, found ${manifest.entries.length}.`);
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

export async function writePerfInstalledEvidence(options: {
  rootDir: string;
  pluginNames: readonly string[];
}): Promise<{
  workspace: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
}> {
  const builder = await createMinimalPluginInstallStateFixtureBuilder(options.rootDir);
  const records = [];
  for (const pluginName of options.pluginNames) {
    const target = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'project',
    });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await builder.writeDiagnosticCache(target);
    await builder.writeProjectIdentity(target);
    records.push({ target, record });
  }
  await builder.writeDependencyIndex(records);

  return {
    workspace: builder.paths.repoRoot,
    awHome: builder.paths.awHome,
    codexHome: builder.paths.codexHome,
    claudeHome: builder.paths.claudeHome,
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
