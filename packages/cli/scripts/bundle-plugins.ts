import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import {
  stageCatalogArtifacts,
  bundleLocalPlugin,
  type PluginBundleBuildMode,
  type RuntimeImportProvenance,
  type SkillRuntimeFileProvenance,
  type PluginStagingRunner,
} from './plugin-staging.js';
import { writeJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  assertStrictSemVer,
  createMarketplaceManifest,
  discoverPlugins,
  readMarketplaceSourceMeta,
} from '../src/utils/manifest.js';
import type { PlatformName, PluginMeta } from '../src/types.js';
import { createCatalogRuntimeImportResolver } from '../src/utils/catalog-runtime-projection.js';
import { orderPluginMetasByDependencies } from '../src/utils/plugin-dependencies.js';

export interface BundlePluginsOptions {
  repoRoot?: string;
  outputRoot?: string;
  buildMode?: PluginBundleBuildMode;
  stagingRunner?: PluginStagingRunner;
  catalogVersion?: string;
  channel?: import('../src/types.js').CatalogChannel;
  assertPackageVersions?: boolean;
}

function resolveDefaultPaths(): { repoRoot: string; outputRoot: string } {
  const packageRoot = resolveCliPackageRoot();
  const repoRoot = path.resolve(packageRoot, '..', '..');

  return {
    repoRoot,
    outputRoot: path.join(packageRoot, 'plugins-dist'),
  };
}

async function assertPackageVersions(repoRoot: string): Promise<void> {
  const truthFiles = [
    ['package.json', path.join(repoRoot, 'package.json')],
    ['release/version-targets.json', path.join(repoRoot, 'release', 'version-targets.json')],
    ['packages/agent-skill-eval/package.json', path.join(repoRoot, 'packages', 'agent-skill-eval', 'package.json')],
    ['packages/cli/package.json', path.join(repoRoot, 'packages', 'cli', 'package.json')],
  ] as const;
  const existence = await Promise.all(truthFiles.map(([, filePath]) => fs.pathExists(filePath)));
  if (existence.every((exists) => !exists)) return;
  const missing = truthFiles.filter((_, index) => !existence[index]).map(([label]) => label);
  if (missing.length > 0) {
    throw new Error(`Incomplete release version truth set: missing ${missing.join(', ')}.`);
  }
  const [[, rootPackageJsonPath], [, targetsPath], [, evalPackageJsonPath], [, cliPackageJsonPath]] = truthFiles;
  const [rootPackageJson, targets, evalPackageJson, cliPackageJson] = await Promise.all([
    fs.readJson(rootPackageJsonPath) as Promise<{ version?: unknown }>,
    fs.readJson(targetsPath) as Promise<{ cli?: unknown }>,
    fs.readJson(evalPackageJsonPath) as Promise<{ version?: unknown }>,
    fs.readJson(cliPackageJsonPath) as Promise<{ version?: unknown }>,
  ]);
  if (Object.hasOwn(rootPackageJson, 'version')) {
    throw new Error('package.json must not declare a version; release/version-targets.json is the release target source.');
  }
  const targetVersion = assertStrictSemVer(targets.cli, 'release/version-targets.json cli');
  if (targetVersion.includes('-')) {
    throw new Error('Invalid release/version-targets.json cli: expected a stable SemVer 2.0.0 string.');
  }
  const evalVersion = assertStrictSemVer(
    evalPackageJson.version,
    'packages/agent-skill-eval/package.json version',
  );
  const cliVersion = assertStrictSemVer(cliPackageJson.version, 'packages/cli/package.json version');
  if (targetVersion !== cliVersion || targetVersion !== evalVersion) {
    throw new Error(
      `Invalid release versions: release/version-targets.json cli ${targetVersion} must match ` +
      `packages/agent-skill-eval/package.json version ${evalVersion} and ` +
      `packages/cli/package.json version ${cliVersion}.`,
    );
  }
}

async function removeGeneratedEmptyDirectories(currentDir: string): Promise<void> {
  for (const entry of await fs.readdir(currentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(currentDir, entry.name);
    await removeGeneratedEmptyDirectories(entryPath);
    if ((await fs.readdir(entryPath)).length === 0) {
      await fs.remove(entryPath);
    }
  }
}

export async function bundlePlugins(
  options: BundlePluginsOptions = {},
): Promise<{
  outputRoot: string;
  pluginNames: string[];
  runtimeProjection: Record<string, {
    buildImports: RuntimeImportProvenance[];
    skillRuntimeFiles: SkillRuntimeFileProvenance[];
  }>;
}> {
  const defaults = resolveDefaultPaths();
  const repoRoot = options.repoRoot ?? defaults.repoRoot;
  const outputRoot = options.outputRoot ?? defaults.outputRoot;
  const buildMode = options.buildMode ?? 'build-free';

  if (options.assertPackageVersions !== false) await assertPackageVersions(repoRoot);
  const [sourceMeta, discoveredPlugins] = await Promise.all([
    readMarketplaceSourceMeta(repoRoot),
    discoverPlugins(repoRoot),
  ]);
  const plugins = orderPluginMetasByDependencies(discoveredPlugins);

  await fs.remove(outputRoot);
  await fs.ensureDir(path.join(outputRoot, 'plugins'));

  const bundledPlugins = [];
  const runtimeProjection: Record<string, {
    buildImports: RuntimeImportProvenance[];
    skillRuntimeFiles: SkillRuntimeFileProvenance[];
  }> = {};
  const runtimeResolver = createCatalogRuntimeImportResolver(plugins);
  const bundledPluginsByPlatform: Record<PlatformName, PluginMeta[]> = {
    claude: [],
    codex: [],
  };
  for (const plugin of plugins) {
    const bundledPluginRoot = path.join(outputRoot, 'plugins', plugin.manifest.name);
    const result = await bundleLocalPlugin(
      plugin,
      bundledPluginRoot,
      {
        buildMode,
        stagingRunner: options.stagingRunner,
        runtimeResolver,
      },
    );
    await removeGeneratedEmptyDirectories(bundledPluginRoot);
    bundledPlugins.push(result.plugin);
    runtimeProjection[result.plugin.manifest.name] = result.runtimeProjection;

    for (const platform of ['claude', 'codex'] as const) {
      if (result.platformManifests[platform]) {
        bundledPluginsByPlatform[platform].push(result.plugin);
      }
    }
  }

  await writeJsonFile(
    path.join(outputRoot, '.claude-plugin', 'marketplace.json'),
    createMarketplaceManifest(sourceMeta, bundledPluginsByPlatform.claude),
  );
  await writeJsonFile(
    path.join(outputRoot, '.agents', 'plugins', 'marketplace.json'),
    createMarketplaceManifest(sourceMeta, bundledPluginsByPlatform.codex),
  );
  await stageCatalogArtifacts({
    repoRoot,
    outputRoot,
    catalogVersion: options.catalogVersion ?? sourceMeta.catalog.version,
    ...(options.channel ? { channel: options.channel } : {}),
  });

  return {
    outputRoot,
    pluginNames: bundledPlugins.map((plugin) => plugin.manifest.name),
    runtimeProjection,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundlePlugins({ buildMode: 'staging' }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
