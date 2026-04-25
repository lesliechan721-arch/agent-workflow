import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';

import { bundleLocalPlugin } from '../src/generators/local-plugin.js';
import { writeJsonFile } from '../src/utils/json.js';
import { resolveCliPackageRoot } from '../src/utils/paths.js';
import {
  createMarketplaceManifest,
  discoverPlugins,
  readMarketplaceSourceMeta,
} from '../src/utils/manifest.js';

export interface BundlePluginsOptions {
  repoRoot?: string;
  outputRoot?: string;
}

function resolveDefaultPaths(): { repoRoot: string; outputRoot: string } {
  const packageRoot = resolveCliPackageRoot();
  const repoRoot = path.resolve(packageRoot, '..', '..');

  return {
    repoRoot,
    outputRoot: path.join(packageRoot, 'plugins-dist'),
  };
}

export async function bundlePlugins(
  options: BundlePluginsOptions = {},
): Promise<{ outputRoot: string; pluginNames: string[] }> {
  const defaults = resolveDefaultPaths();
  const repoRoot = options.repoRoot ?? defaults.repoRoot;
  const outputRoot = options.outputRoot ?? defaults.outputRoot;

  await fs.remove(outputRoot);
  await fs.ensureDir(path.join(outputRoot, 'plugins'));

  const [sourceMeta, plugins] = await Promise.all([
    readMarketplaceSourceMeta(repoRoot),
    discoverPlugins(repoRoot),
  ]);

  for (const plugin of plugins) {
    await bundleLocalPlugin(
      plugin,
      path.join(outputRoot, 'plugins', plugin.manifest.name),
    );
  }

  const marketplace = createMarketplaceManifest(sourceMeta, plugins);
  await writeJsonFile(path.join(outputRoot, '.claude-plugin', 'marketplace.json'), marketplace);
  await writeJsonFile(path.join(outputRoot, '.agents', 'plugins', 'marketplace.json'), marketplace);

  return {
    outputRoot,
    pluginNames: plugins.map((plugin) => plugin.manifest.name),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  bundlePlugins().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
