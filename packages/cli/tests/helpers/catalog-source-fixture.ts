import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import type { PluginMeta } from '../../src/types.js';
import {
  createCatalogManifestV3,
  createCatalogManifestV3Entry,
} from '../../src/utils/catalog-manifest-v3.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const execFileAsync = promisify(execFile);

export async function createCatalogSnapshotFixture(
  rootDir: string,
  pluginName = 'demo',
  minAwVersion = '0.0.0',
  readme = `${pluginName}\n`,
  configureManifest?: (manifest: PluginMeta['manifest']) => void,
): Promise<void> {
  await Promise.all([
    fs.ensureDir(path.join(rootDir, '.agents')),
    fs.ensureDir(path.join(rootDir, '.claude-plugin')),
    fs.ensureDir(path.join(rootDir, 'plugins')),
  ]);
  await Promise.all([
    fs.outputFile(path.join(rootDir, '.agents', '.keep'), ''),
    fs.outputFile(path.join(rootDir, '.claude-plugin', '.keep'), ''),
  ]);
  const pluginRoot = path.join(rootDir, 'plugins', pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    name: pluginName,
    version: '1.0.0',
    description: `${pluginName} plugin`,
    compatibility: { aw: { minVersion: minAwVersion } },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
    },
  };
  configureManifest?.(manifest);
  const marketplaceEntry = {
    name: manifest.name,
    source: `./plugins/${manifest.name}`,
    description: manifest.description,
    ...(manifest.interface ? { interface: manifest.interface } : {}),
    category: manifest.marketplace.category,
    strict: manifest.marketplace.strict,
    policy: manifest.marketplace.policy,
  };
  const products = manifest.marketplace.policy.products;
  const marketplace = (platform: 'CODEX' | 'CLAUDE') => ({
    name: 'aw',
    owner: { name: 'Fixture Owner' },
    interface: { displayName: 'Fixture Marketplace' },
    plugins: products === undefined || products.includes(platform) ? [marketplaceEntry] : [],
  });
  await Promise.all([
    fs.outputJson(manifestPath, manifest, { spaces: 2 }),
    fs.outputJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), marketplace('CODEX'), { spaces: 2 }),
    fs.outputJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), marketplace('CLAUDE'), { spaces: 2 }),
  ]);
  await fs.outputFile(path.join(pluginRoot, 'README.md'), readme);
  const plugin: PluginMeta = await readPluginManifest(pluginRoot, { mode: 'bundle' });
  const entry = await createCatalogManifestV3Entry(plugin, pluginRoot);
  await fs.writeJson(path.join(rootDir, 'catalog-manifest.json'), createCatalogManifestV3({
    catalogVersion: '1.0.0',
    channel: 'latest',
    compatibility: { aw: { minVersion: minAwVersion } },
    entries: [entry],
  }), { spaces: 2 });
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  return String(result.stdout).trim();
}
