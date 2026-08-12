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
  validateCatalogManifest,
} from '../src/utils/manifest.js';
export {
  appendCatalogToPluginReleaseLedger,
  createLegacyPluginReleaseLedger,
  mergePluginReleaseLedgers,
  PLUGIN_DEVELOPMENT_RECEIPT_FILENAME,
  PLUGIN_RELEASE_LEDGER_FILENAME,
  resolveBetaPluginVersionOverrides,
  validatePluginDevelopmentReceipt,
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
  CATALOG_FULL_DIRNAME,
  CATALOG_FULL_PACKAGE_NAME,
  CATALOG_MANIFEST_FILENAME,
  CATALOG_PACKAGE_METADATA_FIELD,
  CATALOG_SIDECAR_DIRNAME,
  CATALOG_SIDECAR_PACKAGE_NAME,
  CATALOG_STAGING_DIRNAME,
  getCanonicalCatalogManifestPath,
  getCatalogFullManifestPath,
  getCatalogFullPackageRoot,
  getCatalogSidecarManifestPath,
  getCatalogSidecarPackageRoot,
  getCatalogStagingRoot,
} from '../src/utils/bundle-layout.js';

import {
  CATALOG_FULL_PACKAGE_NAME,
  CATALOG_MANIFEST_FILENAME,
  CATALOG_PACKAGE_METADATA_FIELD,
  CATALOG_SIDECAR_PACKAGE_NAME,
  getCanonicalCatalogManifestPath,
  getCatalogFullPackageRoot,
  getCatalogSidecarPackageRoot,
  getCatalogStagingRoot,
} from '../src/utils/bundle-layout.js';
import type {
  CatalogChannel,
  CatalogManifest,
  CatalogManifestEntry,
  PluginMeta,
} from '../src/types.js';
import {
  assertStrictSemVer,
  compareStrictSemVer,
  createMarketplaceManifestEntry,
  resolvePluginsFromCatalog,
  validateCatalogManifest,
} from '../src/utils/manifest.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
} from '../src/utils/catalog-digests.js';
import { readJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  appendCatalogToPluginReleaseLedger,
  createPluginDevelopmentReceipt,
  type PluginDevelopmentReceipt,
  type PluginReleaseLedger,
  PLUGIN_DEVELOPMENT_RECEIPT_FILENAME,
  PLUGIN_RELEASE_LEDGER_FILENAME,
  validatePluginDevelopmentReceipt,
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
  pluginVersionOverrides?: Readonly<Record<string, string>>;
  previousReleaseLedger?: PluginReleaseLedger;
}

export interface CatalogPackageMetadata {
  name: string;
  version: string;
  type: 'module';
  description: string;
  files: string[];
  publishConfig?: Record<string, unknown>;
  [CATALOG_PACKAGE_METADATA_FIELD]: {
    kind: 'sidecar' | 'full';
    channel: CatalogChannel;
    compatibility: {
      aw: {
        minVersion: string;
      };
    };
  };
}

export interface CatalogStageResult {
  manifest: CatalogManifest;
  releaseLedger: PluginReleaseLedger;
  developmentReceipt: PluginDevelopmentReceipt | null;
  canonicalManifestPath: string;
  sidecarPackageRoot: string;
  fullPackageRoot: string;
}

function detectCatalogChannel(version: string): CatalogChannel {
  return version.includes('-') ? 'beta' : 'latest';
}

function resolveCatalogMinAwVersion(plugins: readonly PluginMeta[]): string {
  let current: string | null = null;
  for (const plugin of plugins) {
    const pluginMinVersion = plugin.manifest.compatibility!.aw.minVersion;
    if (!current || compareStrictSemVer(pluginMinVersion, current) > 0) {
      current = pluginMinVersion;
    }
  }
  return current ?? '0.0.0';
}

async function readCliPackageMetadata(
  repoRoot: string,
): Promise<{ version: string; publishConfig?: Record<string, unknown> }> {
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
    publishConfig:
      packageJson.publishConfig && typeof packageJson.publishConfig === 'object' && !Array.isArray(packageJson.publishConfig)
        ? packageJson.publishConfig as Record<string, unknown>
        : undefined,
  };
}

function createCatalogPackageMetadata(options: {
  kind: 'sidecar' | 'full';
  version: string;
  channel: CatalogChannel;
  minAwVersion: string;
  publishConfig?: Record<string, unknown>;
}): CatalogPackageMetadata {
  return {
    name: options.kind === 'sidecar'
      ? CATALOG_SIDECAR_PACKAGE_NAME
      : CATALOG_FULL_PACKAGE_NAME,
    version: options.version,
    type: 'module',
    description: options.kind === 'sidecar'
      ? 'Agent Workflows catalog manifest sidecar package'
      : 'Agent Workflows full plugin catalog package',
    files: options.kind === 'sidecar'
      ? [CATALOG_MANIFEST_FILENAME, PLUGIN_RELEASE_LEDGER_FILENAME]
      : [
        CATALOG_MANIFEST_FILENAME,
        '.agents/',
        '.claude-plugin/',
        'plugins/',
      ],
    publishConfig: options.publishConfig,
    [CATALOG_PACKAGE_METADATA_FIELD]: {
      kind: options.kind,
      channel: options.channel,
      compatibility: {
        aw: {
          minVersion: options.minAwVersion,
        },
      },
    },
  };
}

async function writeCanonicalJsonFile(filePath: string, value: unknown): Promise<string> {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, 'utf8');
  return content;
}

async function createCatalogManifestEntryFromPlugin(
  plugin: PluginMeta,
  pluginRoot: string,
): Promise<CatalogManifestEntry> {
  const marketplaceEntry = createMarketplaceManifestEntry(plugin);
  return {
    ...marketplaceEntry,
    version: plugin.manifest.version,
    compatibility: plugin.manifest.compatibility!,
    artifactDigest: await calculateCatalogEntryArtifactDigest(pluginRoot),
    manifestDigest: calculateCatalogEntryManifestDigest(plugin.manifest),
  };
}

async function writeCatalogPackageContents(options: {
  outputRoot: string;
  sidecarPackageRoot: string;
  fullPackageRoot: string;
  canonicalManifestContent: string;
  releaseLedgerContent: string;
  metadata: {
    sidecar: CatalogPackageMetadata;
    full: CatalogPackageMetadata;
  };
}): Promise<void> {
  await fs.remove(options.sidecarPackageRoot);
  await fs.remove(options.fullPackageRoot);
  await fs.ensureDir(options.sidecarPackageRoot);
  await fs.ensureDir(options.fullPackageRoot);

  await Promise.all([
    fs.writeFile(
      path.join(options.sidecarPackageRoot, CATALOG_MANIFEST_FILENAME),
      options.canonicalManifestContent,
      'utf8',
    ),
    fs.writeFile(
      path.join(options.sidecarPackageRoot, PLUGIN_RELEASE_LEDGER_FILENAME),
      options.releaseLedgerContent,
      'utf8',
    ),
    fs.writeFile(
      path.join(options.fullPackageRoot, CATALOG_MANIFEST_FILENAME),
      options.canonicalManifestContent,
      'utf8',
    ),
    writeCanonicalJsonFile(
      path.join(options.sidecarPackageRoot, 'package.json'),
      options.metadata.sidecar,
    ),
    writeCanonicalJsonFile(
      path.join(options.fullPackageRoot, 'package.json'),
      options.metadata.full,
    ),
  ]);

  await Promise.all([
    fs.copy(
      path.join(options.outputRoot, '.claude-plugin'),
      path.join(options.fullPackageRoot, '.claude-plugin'),
    ),
    fs.copy(
      path.join(options.outputRoot, '.agents'),
      path.join(options.fullPackageRoot, '.agents'),
    ),
    fs.copy(
      path.join(options.outputRoot, 'plugins'),
      path.join(options.fullPackageRoot, 'plugins'),
    ),
  ]);
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

function getDevelopmentReceiptPath(outputRoot: string): string {
  return path.join(getCatalogStagingRoot(outputRoot), PLUGIN_DEVELOPMENT_RECEIPT_FILENAME);
}

export async function readPluginDevelopmentReceipt(
  outputRoot: string,
): Promise<PluginDevelopmentReceipt> {
  return validatePluginDevelopmentReceipt(
    await readJsonFile<unknown>(getDevelopmentReceiptPath(outputRoot)),
  );
}

export async function stageCatalogArtifacts(
  options: CatalogStageOptions,
): Promise<CatalogStageResult> {
  const repoRoot = options.repoRoot ?? path.resolve(resolveCliPackageRoot(), '..', '..');
  const phase = options.phase ?? 'development';
  const priorDevelopmentReceipt = phase === 'release'
    ? await readPluginDevelopmentReceipt(options.outputRoot)
    : null;
  if (options.pluginVersionOverrides) {
    await rewriteBundledPluginVersions(options.outputRoot, options.pluginVersionOverrides);
  }
  const [{ version, publishConfig }, plugins] = await Promise.all([
    readCliPackageMetadata(repoRoot),
    resolvePluginsFromCatalog(options.outputRoot),
  ]);
  const catalogVersion = assertStrictSemVer(
    options.catalogVersion ?? version,
    'catalog version',
  );
  const channel = options.channel ?? detectCatalogChannel(catalogVersion);
  const minAwVersion = resolveCatalogMinAwVersion(plugins);
  const contentDigestEntries = await Promise.all(plugins.map(async (plugin) => [
    plugin.manifest.name,
    await calculateCatalogEntryContentDigest(
      path.join(options.outputRoot, 'plugins', plugin.manifest.name),
    ),
  ] as const));
  const contentDigests = new Map(contentDigestEntries);
  if (priorDevelopmentReceipt) {
    const priorByName = new Map(
      priorDevelopmentReceipt.entries.map((entry) => [entry.name, entry]),
    );
    for (const [pluginName, contentDigest] of contentDigests) {
      if (priorByName.get(pluginName)?.contentDigest !== contentDigest) {
        throw new Error(
          `Release staging content for plugin ${pluginName} does not match the development receipt.`,
        );
      }
    }
  }
  const entries = await Promise.all(
    plugins.map((plugin) =>
      createCatalogManifestEntryFromPlugin(
        plugin,
        path.join(options.outputRoot, 'plugins', plugin.manifest.name),
      )),
  );

  const manifestBase = {
    schemaVersion: 2 as const,
    catalogVersion,
    channel,
    compatibility: {
      aw: {
        minVersion: minAwVersion,
      },
    },
    packages: {
      sidecar: {
        name: CATALOG_SIDECAR_PACKAGE_NAME,
        version: catalogVersion,
        channel,
      },
      full: {
        name: CATALOG_FULL_PACKAGE_NAME,
        version: catalogVersion,
        channel,
        manifestPath: `./${CATALOG_MANIFEST_FILENAME}`,
      },
    },
    entries,
  };

  const manifest = validateCatalogManifest(manifestBase);
  const releaseLedger = appendCatalogToPluginReleaseLedger({
    previous: options.previousReleaseLedger ?? { schemaVersion: 1, records: [] },
    manifest,
    contentDigests,
  });
  const developmentReceipt = phase === 'development'
    ? await createPluginDevelopmentReceipt({
      repoRoot,
      catalogVersion,
      plugins,
      contentDigests,
    })
    : priorDevelopmentReceipt;
  const stagingRoot = getCatalogStagingRoot(options.outputRoot);
  const canonicalManifestPath = getCanonicalCatalogManifestPath(options.outputRoot);
  const sidecarPackageRoot = getCatalogSidecarPackageRoot(options.outputRoot);
  const fullPackageRoot = getCatalogFullPackageRoot(options.outputRoot);

  await fs.remove(stagingRoot);
  const canonicalManifestContent = await writeCanonicalJsonFile(
    canonicalManifestPath,
    manifest,
  );
  if (phase === 'development') {
    await writeCanonicalJsonFile(getDevelopmentReceiptPath(options.outputRoot), developmentReceipt);
  }
  const releaseLedgerContent = `${JSON.stringify(releaseLedger, null, 2)}\n`;
  await writeCatalogPackageContents({
    outputRoot: options.outputRoot,
    sidecarPackageRoot,
    fullPackageRoot,
    canonicalManifestContent,
    releaseLedgerContent,
    metadata: {
      sidecar: createCatalogPackageMetadata({
        kind: 'sidecar',
        version: manifest.catalogVersion,
        channel: manifest.channel,
        minAwVersion: manifest.compatibility.aw.minVersion,
        publishConfig,
      }),
      full: createCatalogPackageMetadata({
        kind: 'full',
        version: manifest.catalogVersion,
        channel: manifest.channel,
        minAwVersion: manifest.compatibility.aw.minVersion,
        publishConfig,
      }),
    },
  });

  return {
    manifest,
    releaseLedger,
    developmentReceipt,
    canonicalManifestPath,
    sidecarPackageRoot,
    fullPackageRoot,
  };
}

export async function readStagedCatalogManifest(
  outputRoot: string,
): Promise<CatalogManifest> {
  return validateCatalogManifest(
    await readJsonFile<unknown>(getCanonicalCatalogManifestPath(outputRoot)),
  );
}
