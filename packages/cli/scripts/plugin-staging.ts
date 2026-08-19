import path from 'node:path';

import fs from 'fs-extra';

export {
  bundleLocalPlugin,
  prepareLocalPluginBundleSource,
} from '../src/generators/local-plugin.js';
export type {
  PluginBundleBuildMode,
  PluginStagingRunner,
} from '../src/generators/local-plugin.js';
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
  CatalogManifestV3,
  PluginMeta,
} from '../src/types.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  resolvePluginsFromCatalog,
} from '../src/utils/manifest.js';
import {
  calculateCatalogEntryContentDigest,
} from '../src/utils/catalog-digests.js';
import {
  createCatalogManifestV3,
  createCatalogManifestV3Entry,
  validateCatalogManifestV3,
} from '../src/utils/catalog-manifest-v3.js';
import { validateCatalogSnapshot } from '../src/utils/catalog-snapshot.js';
import { readJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  appendCatalogToPluginReleaseLedger,
  assertStablePluginVersion,
  type PluginReleaseLedger,
  PLUGIN_RELEASE_LEDGER_FILENAME,
  resolveBetaPluginVersionOverrides,
  validatePluginReleaseLedgerAgainstManifest,
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
  phase?: 'development' | 'release';
  previousReleaseLedger?: PluginReleaseLedger;
}

export interface CatalogStageResult {
  manifest: CatalogManifestV3;
  releaseLedger: PluginReleaseLedger;
  canonicalManifestPath: string;
}

export const CATALOG_SCHEMA_3_CLI_FLOOR = '0.1.0-beta.2';

function detectCatalogChannel(version: string): CatalogChannel {
  return version.includes('-') ? 'beta' : 'latest';
}

function resolveCatalogMinAwVersion(plugins: readonly PluginMeta[]): string {
  let current = CATALOG_SCHEMA_3_CLI_FLOOR;
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


async function rewriteBundledPluginVersions(
  outputRoot: string,
  overrides: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [pluginName, requestedVersion] of Object.entries(overrides)) {
    const version = assertStrictSemVer(requestedVersion, `${pluginName} release version`);
    const pluginRoot = path.join(outputRoot, 'plugins', pluginName);
    if (!(await fs.pathExists(pluginRoot))) {
      throw new Error(`Plugin version override refers to unknown plugin ${JSON.stringify(pluginName)}.`);
    }
    for (const relativePath of [
      '.agents-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      '.codex-plugin/plugin.json',
    ]) {
      const manifestPath = path.join(pluginRoot, relativePath);
      if (!(await fs.pathExists(manifestPath))) continue;
      const manifest = await readJsonFile<Record<string, unknown>>(manifestPath);
      await writeCanonicalJsonFile(manifestPath, { ...manifest, version });
    }
  }
}

export async function stageCatalogArtifacts(
  options: CatalogStageOptions,
): Promise<CatalogStageResult> {
  const repoRoot = options.repoRoot ?? path.resolve(resolveCliPackageRoot(), '..', '..');
  const phase = options.phase ?? 'development';
  const [{ version }, sourcePlugins] = await Promise.all([
    readCliPackageMetadata(repoRoot),
    resolvePluginsFromCatalog(options.outputRoot),
  ]);
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
  const contentDigestEntries = await Promise.all(sourcePlugins.map(async (plugin) => [
    plugin.manifest.name,
    await calculateCatalogEntryContentDigest(
      path.join(options.outputRoot, 'plugins', plugin.manifest.name),
    ),
  ] as const));
  const contentDigests = new Map(contentDigestEntries);
  const previousReleaseLedger: PluginReleaseLedger = options.previousReleaseLedger
    ?? { schemaVersion: 1, records: [] };
  if (phase === 'release' && channel === 'beta') {
    const overrides = resolveBetaPluginVersionOverrides({
      plugins: sourcePlugins,
      contentDigests,
      ledger: previousReleaseLedger,
    });
    await rewriteBundledPluginVersions(options.outputRoot, overrides);
  }
  const plugins = phase === 'release' && channel === 'beta'
    ? await resolvePluginsFromCatalog(options.outputRoot)
    : sourcePlugins;
  const minAwVersion = resolveCatalogMinAwVersion(plugins);
  const entries = await Promise.all(plugins.map((plugin) =>
    createCatalogManifestV3Entry(
      plugin,
      path.join(options.outputRoot, 'plugins', plugin.manifest.name),
    )));
  const manifest = createCatalogManifestV3({
    catalogVersion,
    channel,
    compatibility: {
      aw: {
        minVersion: minAwVersion,
      },
    },
    entries,
  });
  const releaseLedger = appendCatalogToPluginReleaseLedger({
    previous: previousReleaseLedger,
    manifest,
    contentDigests,
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
  if (phase === 'release') {
    await writeCanonicalJsonFile(releaseLedgerPath, releaseLedger);
    validatePluginReleaseLedgerAgainstManifest(releaseLedger, manifest);
  }
  await validateCatalogSnapshot(options.outputRoot);

  return {
    manifest,
    releaseLedger,
    canonicalManifestPath,
  };
}

export async function readStagedCatalogManifest(
  outputRoot: string,
): Promise<CatalogManifestV3> {
  return validateCatalogManifestV3(
    await readJsonFile<unknown>(path.join(outputRoot, CATALOG_MANIFEST_FILENAME)),
  );
}
