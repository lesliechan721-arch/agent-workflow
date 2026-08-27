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
  appendCatalogToPluginReleaseLedger,
  assertStablePluginVersion,
  mergePluginReleaseLedgers,
  PLUGIN_RELEASE_LEDGER_FILENAME,
  PLUGIN_RELEASE_LEDGER_SCHEMA_VERSION,
  resolveBetaPluginVersionOverrides,
  validatePluginReleaseLedgerAgainstManifest,
  validatePluginReleaseLedger,
} from '../src/utils/plugin-release.js';
export {
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
  CatalogManifestV4,
  MarketplaceManifest,
  PluginMeta,
} from '../src/types.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  resolvePluginsFromCatalog,
} from '../src/utils/manifest.js';
import {
  createCatalogManifestV4,
  createCatalogManifestV4Entry,
  CATALOG_SCHEMA_4_CLI_FLOOR,
  validateCatalogManifestV4,
} from '../src/utils/catalog-manifest-v4.js';
import { validateCatalogSnapshot } from '../src/utils/catalog-snapshot.js';
import { validatePluginMetaDependencyGraph } from '../src/utils/plugin-dependencies.js';
import { readJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  assertStablePluginVersion,
  PLUGIN_RELEASE_LEDGER_FILENAME,
} from '../src/utils/plugin-release.js';

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
  catalogVersion?: string;
  channel?: CatalogChannel;
}

export interface CatalogStageResult {
  manifest: CatalogManifestV4;
  canonicalManifestPath: string;
}

export { CATALOG_SCHEMA_4_CLI_FLOOR };
export const CATALOG_SCHEMA_3_CLI_FLOOR = CATALOG_SCHEMA_4_CLI_FLOOR;

function detectCatalogChannel(version: string): CatalogChannel {
  return version.includes('-') ? 'beta' : 'latest';
}

function resolveCatalogMinAwVersion(plugins: readonly PluginMeta[]): string {
  let current = CATALOG_SCHEMA_4_CLI_FLOOR;
  for (const plugin of plugins) {
    const pluginMinVersion = plugin.manifest.compatibility!.aw.minVersion;
    if (compareStrictSemVer(pluginMinVersion, current) > 0) {
      current = pluginMinVersion;
    }
  }
  return current;
}

async function readCliPackageMetadata(
  repoRoot: string,
): Promise<{ version: string }> {
  const candidatePaths = [
    path.join(repoRoot, 'packages', 'cli', 'package.json'),
    path.join(repoRoot, 'package.json'),
    path.join(resolveCliPackageRoot(), 'package.json'),
  ];
  let cliPackageJsonPath = candidatePaths[candidatePaths.length - 1];
  for (const candidatePath of candidatePaths) {
    if (await fs.pathExists(candidatePath)) {
      cliPackageJsonPath = candidatePath;
      break;
    }
  }
  const packageJson = await readJsonFile<Record<string, unknown>>(cliPackageJsonPath);
  return {
    version: assertStrictSemVer(packageJson.version, 'packages/cli/package.json version'),
  };
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
  const [{ version }, sourcePlugins] = await Promise.all([
    readCliPackageMetadata(repoRoot),
    resolvePluginsFromCatalog(options.outputRoot),
  ]);
  validatePluginMetaDependencyGraph(sourcePlugins);
  const catalogVersion = assertStrictSemVer(
    options.catalogVersion ?? version,
    'catalog version',
  );
  const derivedChannel = detectCatalogChannel(catalogVersion);
  const channel = options.channel ?? derivedChannel;
  if (channel !== derivedChannel) {
    throw new Error(
      `Catalog channel ${JSON.stringify(channel)} does not match catalog version ${catalogVersion}.`,
    );
  }
  for (const plugin of sourcePlugins) {
    assertStablePluginVersion(plugin.manifest.version, `${plugin.manifest.name} source version`);
  }
  const plugins = sourcePlugins;
  const minAwVersion = resolveCatalogMinAwVersion(plugins);
  const entries = await Promise.all(plugins.map((plugin) =>
    createCatalogManifestV4Entry(
      plugin,
      path.join(options.outputRoot, 'plugins', plugin.manifest.name),
    )));
  const marketplace = await readJsonFile<MarketplaceManifest>(
    path.join(options.outputRoot, '.agents', 'plugins', 'marketplace.json'),
  );
  const manifest = createCatalogManifestV4({
    catalogVersion,
    channel,
    marketplace: {
      owner: marketplace.owner,
      interface: marketplace.interface,
    },
    compatibility: {
      aw: {
        minVersion: minAwVersion,
      },
    },
    release: { state: 'development' },
    entries,
  });
  const canonicalManifestPath = path.join(options.outputRoot, CATALOG_MANIFEST_FILENAME);
  const releaseLedgerPath = path.join(options.outputRoot, PLUGIN_RELEASE_LEDGER_FILENAME);
  await Promise.all([
    fs.remove(path.join(options.outputRoot, '.catalog')),
    fs.remove(releaseLedgerPath),
  ]);
  await writeCanonicalJsonFile(
    canonicalManifestPath,
    manifest,
  );
  await validateCatalogSnapshot(options.outputRoot);

  return {
    manifest,
    canonicalManifestPath,
  };
}

export async function readStagedCatalogManifest(
  outputRoot: string,
): Promise<CatalogManifestV4> {
  return validateCatalogManifestV4(
    await readJsonFile<unknown>(path.join(outputRoot, CATALOG_MANIFEST_FILENAME)),
  );
}
