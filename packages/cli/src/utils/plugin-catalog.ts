import path from 'node:path';

import fs from 'fs-extra';

import type { CatalogResolution } from '../types.js';
import { resolvePluginsFromCatalog } from './manifest.js';
import { calculateBundleFingerprint, validateLocalMarketplaceLayout } from './local-marketplace.js';
import { readJsonFileIfExists } from './json.js';
import {
  resolveAwHome,
  resolveCliPackageRoot,
  resolveEmbeddedPluginsRoot,
  getMarketplaceManifestPath,
} from './paths.js';

async function readCurrentSourceVersion(): Promise<string> {
  const packageJsonPath = path.join(resolveCliPackageRoot(), 'package.json');
  const packageJson = await fs.readJson(packageJsonPath);
  return String(packageJson.version);
}

export async function resolveCurrentCatalog(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CatalogResolution> {
  const awHome = resolveAwHome(env);
  const embeddedRoot = await resolveEmbeddedPluginsRoot();
  const [embeddedFingerprint, sourceVersion, localConfig] = await Promise.all([
    calculateBundleFingerprint(embeddedRoot),
    readCurrentSourceVersion(),
    readJsonFileIfExists<{
      sourceVersion: string;
      bundleFingerprint: string;
    }>(path.join(awHome, 'config.json')),
  ]);

  if (
    localConfig &&
    localConfig.sourceVersion === sourceVersion &&
    localConfig.bundleFingerprint === embeddedFingerprint
  ) {
    try {
      await validateLocalMarketplaceLayout(awHome);
      return {
        rootDir: awHome,
        source: 'local',
      };
    } catch (error) {
      return {
        rootDir: embeddedRoot,
        source: 'embedded',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    rootDir: embeddedRoot,
    source: 'embedded',
    reason: 'local marketplace is missing, stale, or unhealthy',
  };
}

export async function resolveCatalogPlugins(
  pluginNames?: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const catalog = await resolveCurrentCatalog(env);
  const plugins = await resolvePluginsFromCatalog(catalog.rootDir, pluginNames);
  return {
    catalog,
    plugins,
  };
}

export async function resolveActiveLocalBundle(
  pluginName: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const pluginRoot = path.join(resolveAwHome(env), 'plugins', pluginName);
  return (await fs.pathExists(pluginRoot)) ? pluginRoot : null;
}

export async function resolveActiveLocalBundleFromInstallLocation(
  pluginName: string,
  platform: 'claude' | 'codex',
  installLocation: string,
): Promise<{
  bundleRoot: string | null;
  details?: string;
}> {
  const manifestPath = getMarketplaceManifestPath(installLocation, platform);
  if (!(await fs.pathExists(manifestPath))) {
    return {
      bundleRoot: null,
      details: `marketplace manifest 缺失: ${manifestPath}`,
    };
  }

  try {
    const manifest = await fs.readJson(manifestPath) as {
      plugins?: Array<{ name?: string; source?: string }>;
    };
    const entry = manifest.plugins?.find((plugin) => plugin.name === pluginName);
    if (!entry?.source) {
      return {
        bundleRoot: null,
        details: `marketplace manifest 缺少 ${pluginName} 的 source。`,
      };
    }

    const bundleRoot = path.resolve(installLocation, entry.source);
    return {
      bundleRoot: await fs.pathExists(bundleRoot) ? bundleRoot : null,
      details: await fs.pathExists(bundleRoot)
        ? undefined
        : `bundle 路径不存在: ${bundleRoot}`,
    };
  } catch (error) {
    return {
      bundleRoot: null,
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
