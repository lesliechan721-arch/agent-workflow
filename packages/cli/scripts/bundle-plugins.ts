import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import {
  bundleLocalPlugin,
  type PluginBundleBuildMode,
  type PluginStagingRunner,
} from '../src/generators/local-plugin.js';
import { writeJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  assertStrictSemVer,
  createMarketplaceManifest,
  discoverPlugins,
  readMarketplaceSourceMeta,
} from '../src/utils/manifest.js';
import type { PlatformName, PluginMeta } from '../src/types.js';

export interface BundlePluginsOptions {
  repoRoot?: string;
  outputRoot?: string;
  buildMode?: PluginBundleBuildMode;
  stagingRunner?: PluginStagingRunner;
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
  const rootPackageJsonPath = path.join(repoRoot, 'package.json');
  const cliPackageJsonPath = path.join(repoRoot, 'packages', 'cli', 'package.json');
  const [rootExists, cliExists] = await Promise.all([
    fs.pathExists(rootPackageJsonPath),
    fs.pathExists(cliPackageJsonPath),
  ]);
  if (!rootExists || !cliExists) {
    return;
  }
  const [rootPackageJson, cliPackageJson] = await Promise.all([
    fs.readJson(rootPackageJsonPath) as Promise<{ version?: unknown }>,
    fs.readJson(cliPackageJsonPath) as Promise<{ version?: unknown }>,
  ]);
  const rootVersion = assertStrictSemVer(rootPackageJson.version, 'package.json version');
  const cliVersion = assertStrictSemVer(cliPackageJson.version, 'packages/cli/package.json version');
  if (rootVersion !== cliVersion) {
    throw new Error(
      `Invalid release versions: package.json version ${rootVersion} must match packages/cli/package.json version ${cliVersion}.`,
    );
  }
}

export async function bundlePlugins(
  options: BundlePluginsOptions = {},
): Promise<{ outputRoot: string; pluginNames: string[] }> {
  const defaults = resolveDefaultPaths();
  const repoRoot = options.repoRoot ?? defaults.repoRoot;
  const outputRoot = options.outputRoot ?? defaults.outputRoot;
  const buildMode = options.buildMode ?? 'build-free';

  await assertPackageVersions(repoRoot);
  const [sourceMeta, plugins] = await Promise.all([
    readMarketplaceSourceMeta(repoRoot),
    discoverPlugins(repoRoot),
  ]);

  await fs.remove(outputRoot);
  await fs.ensureDir(path.join(outputRoot, 'plugins'));

  const bundledPlugins = [];
  const bundledPluginsByPlatform: Record<PlatformName, PluginMeta[]> = {
    claude: [],
    codex: [],
  };
  for (const plugin of plugins) {
    const result = await bundleLocalPlugin(
      plugin,
      path.join(outputRoot, 'plugins', plugin.manifest.name),
      {
        buildMode,
        stagingRunner: options.stagingRunner,
      },
    );
    bundledPlugins.push(result.plugin);

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

  return {
    outputRoot,
    pluginNames: bundledPlugins.map((plugin) => plugin.manifest.name),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundlePlugins({ buildMode: 'staging' }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
