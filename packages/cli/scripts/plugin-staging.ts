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
  CatalogManifestHistory,
  CatalogHistoryRelease,
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
  calculateCatalogEntryManifestDigest,
} from '../src/utils/catalog-digests.js';
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
  catalogVersion?: string;
  channel?: CatalogChannel;
  history?: CatalogManifestHistory;
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

function createCatalogRelease(
  manifest: CatalogManifest,
): CatalogHistoryRelease {
  return {
    catalogVersion: manifest.catalogVersion,
    minAwVersion: manifest.compatibility.aw.minVersion,
    plugins: manifest.entries.map((entry) => ({
      name: entry.name,
      version: entry.version,
      minAwVersion: entry.compatibility.aw.minVersion,
      artifactDigest: entry.artifactDigest,
      manifestDigest: entry.manifestDigest,
    })),
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
      ? [CATALOG_MANIFEST_FILENAME]
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

export async function stageCatalogArtifacts(
  options: CatalogStageOptions,
): Promise<CatalogStageResult> {
  const repoRoot = options.repoRoot ?? path.resolve(resolveCliPackageRoot(), '..', '..');
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
  const entries = await Promise.all(
    plugins.map((plugin) =>
      createCatalogManifestEntryFromPlugin(
        plugin,
        path.join(options.outputRoot, 'plugins', plugin.manifest.name),
      )),
  );

  const manifestBase = {
    schemaVersion: 1 as const,
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

  const history = options.history ?? {
    schemaVersion: 1 as const,
    channel,
    releases: [
      {
        catalogVersion,
        minAwVersion,
        plugins: entries.map((entry) => ({
          name: entry.name,
          version: entry.version,
          minAwVersion: entry.compatibility.aw.minVersion,
          artifactDigest: entry.artifactDigest,
          manifestDigest: entry.manifestDigest,
        })),
      },
    ],
  };

  const manifest = validateCatalogManifest({
    ...manifestBase,
    history,
  });
  const stagingRoot = getCatalogStagingRoot(options.outputRoot);
  const canonicalManifestPath = getCanonicalCatalogManifestPath(options.outputRoot);
  const sidecarPackageRoot = getCatalogSidecarPackageRoot(options.outputRoot);
  const fullPackageRoot = getCatalogFullPackageRoot(options.outputRoot);

  await fs.remove(stagingRoot);
  const canonicalManifestContent = await writeCanonicalJsonFile(
    canonicalManifestPath,
    manifest,
  );
  await writeCatalogPackageContents({
    outputRoot: options.outputRoot,
    sidecarPackageRoot,
    fullPackageRoot,
    canonicalManifestContent,
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

export function createCatalogHistoryRelease(
  manifest: CatalogManifest,
): CatalogHistoryRelease {
  return createCatalogRelease(manifest);
}
