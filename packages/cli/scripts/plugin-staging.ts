import path from 'node:path';

import fs from 'fs-extra';

export {
  bundleLocalPlugin,
  prepareLocalPluginBundleSource,
} from '../src/generators/local-plugin.js';
export type {
  PluginBundleBuildMode,
  PreparedPluginRuntimeContext,
  PluginStagingRunner,
  RuntimeImportProvenance,
  SkillRuntimeFileProvenance,
} from '../src/generators/local-plugin.js';
export {
  createCatalogRuntimeImportResolver,
} from '../src/utils/catalog-runtime-projection.js';
export type {
  CatalogRuntimeImportResolver,
} from '../src/utils/catalog-runtime-projection.js';
export {
  buildLifecycleSpawnEnv,
  calculateFileDigest,
  collectSensitivePluginConfigValues,
  redactPluginScriptOutput,
} from '../src/utils/plugin-scripts.js';
export {
  coercePluginConfigValue,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
} from '../src/utils/plugin-config.js';
export {
  compareStrictSemVer,
  createMarketplaceManifestEntry,
  discoverPlugins,
  normalizeManifestDigestInput,
  readPluginManifest,
  resolvePluginsFromCatalog,
} from '../src/utils/manifest.js';
export {
  matchesPluginTestEntryGlob,
  scanJavaScriptImportSpecifiers,
  scanNodeImportContract,
} from '../src/utils/plugin-script-contract.js';
export {
  formatMarketplaceProductsForError,
  formatSupportedPlatforms,
  resolveSupportedPlatforms,
} from '../src/utils/platform-support.js';
export {
  resolveAwHome,
  resolveCliPackageRoot,
} from '../src/utils/paths.js';
export {
  CATALOG_MANIFEST_FILENAME,
} from '../src/utils/bundle-layout.js';

import {
  CATALOG_MANIFEST_FILENAME,
} from '../src/utils/bundle-layout.js';
import type {
  CatalogChannel,
  CatalogManifestV6,
  MarketplaceManifest,
} from '../src/types.js';
import {
  readMarketplaceSourceMeta,
  resolvePluginsFromCatalog,
} from '../src/utils/manifest.js';
import {
  createCatalogManifestV6,
  createCatalogManifestV6Entry,
  CATALOG_SCHEMA_6_CAPABILITY,
  validateCatalogManifestV6,
} from '../src/utils/catalog-manifest-v6.js';
import { validateCatalogSnapshotComplete } from '../src/utils/catalog-snapshot.js';
import { validatePluginMetaDependencyGraph } from '../src/utils/plugin-dependencies.js';
import { readJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';

export type {
  PlatformName,
  PluginConfigSchemaField,
  PluginManifestSource,
  PluginMeta,
  Scope,
} from '../src/types.js';
export type { PluginConfigValue } from '../src/utils/plugin-config.js';

export interface CatalogStageOptions {
  repoRoot?: string;
  outputRoot: string;
}

export interface CatalogStageResult {
  manifest: CatalogManifestV6;
  canonicalManifestPath: string;
}

export { CATALOG_SCHEMA_6_CAPABILITY };

function detectCatalogChannel(version: string): CatalogChannel {
  return version.includes('-') ? 'beta' : 'latest';
}

function assertStablePluginVersion(version: string, fieldName: string): void {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Invalid ${fieldName}: expected a stable SemVer without prerelease or build metadata.`);
  }
}

async function writeCanonicalJsonFile(filePath: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
  return content;
}


export async function stageCatalogArtifacts(
  options: CatalogStageOptions,
): Promise<CatalogStageResult> {
  const repoRoot = options.repoRoot ?? path.resolve(resolveCliPackageRoot(), '..', '..');
  const [sourceMetadata, sourcePlugins] = await Promise.all([
    readMarketplaceSourceMeta(repoRoot),
    resolvePluginsFromCatalog(options.outputRoot),
  ]);
  validatePluginMetaDependencyGraph(sourcePlugins);
  const catalogVersion = sourceMetadata.catalog.version;
  const channel = detectCatalogChannel(catalogVersion);
  for (const plugin of sourcePlugins) {
    assertStablePluginVersion(plugin.manifest.version, `${plugin.manifest.name} source version`);
  }
  const plugins = sourcePlugins;
  const entries = await Promise.all(plugins.map((plugin) =>
    createCatalogManifestV6Entry(
      plugin,
      path.join(options.outputRoot, 'plugins', plugin.manifest.name),
    )));
  const marketplace = await readJsonFile<MarketplaceManifest>(
    path.join(options.outputRoot, '.agents', 'plugins', 'marketplace.json'),
  );
  const manifest = createCatalogManifestV6({
    catalogVersion,
    channel,
    marketplace: {
      owner: marketplace.owner,
      interface: marketplace.interface,
    },
    requires: {
      aw: {
        capabilities: [CATALOG_SCHEMA_6_CAPABILITY],
      },
    },
    release: { state: 'development' },
    entries,
  });
  const canonicalManifestPath = path.join(options.outputRoot, CATALOG_MANIFEST_FILENAME);
  await fs.remove(path.join(options.outputRoot, '.catalog'));
  await writeCanonicalJsonFile(
    canonicalManifestPath,
    manifest,
  );
  await validateCatalogSnapshotComplete(options.outputRoot);

  return {
    manifest,
    canonicalManifestPath,
  };
}

export async function readStagedCatalogManifest(
  outputRoot: string,
): Promise<CatalogManifestV6> {
  return validateCatalogManifestV6(
    await readJsonFile<unknown>(path.join(outputRoot, CATALOG_MANIFEST_FILENAME)),
  );
}
