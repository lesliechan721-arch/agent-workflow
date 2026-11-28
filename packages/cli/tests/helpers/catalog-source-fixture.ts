import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import fs from 'fs-extra';

import type { PluginMeta } from '../../src/types.js';
import {
  createCatalogManifestV7,
  createCatalogManifestV7Entry,
} from '../../src/utils/catalog-manifest-v7.js';
import {
  deriveAwCapabilitiesFromManifest,
  createAwPluginRequirementsReceipt,
  createMarketplaceManifestEntry,
  createPlatformManifestBase,
  normalizeAwCapabilities,
  readPluginManifest,
  resolveSupportedNativePlatforms,
  resolveSupportedPlatforms,
} from '../../src/utils/manifest.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';

const execFileAsync = promisify(execFile);

async function writeCatalogPluginFixture(
  rootDir: string,
  pluginName: string,
  requiredCapabilities: readonly string[],
  readme: string,
  configureManifest?: (manifest: PluginMeta['manifest']) => void,
): Promise<PluginMeta> {
  const pluginRoot = path.join(rootDir, 'plugins', pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 4,
    name: pluginName,
    version: '1.0.0',
    description: `${pluginName} plugin`,
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
  manifest.requires = {
    aw: {
      capabilities: normalizeAwCapabilities([
        ...requiredCapabilities,
        ...deriveAwCapabilitiesFromManifest(manifest),
      ]),
    },
  };
  const pluginMeta = { rootDir: pluginRoot, manifestPath, manifest };
  const supportedPlatforms = resolveSupportedPlatforms(manifest);
  const nativePlatforms = new Set([...resolveSupportedNativePlatforms(manifest)]
    .filter((platform): platform is 'codex' | 'claude' => platform === 'codex' || platform === 'claude'));
  await Promise.all((['claude', 'codex'] as const).map((platform) =>
    fs.remove(path.join(pluginRoot, `.${platform}-plugin`))));
  const platformManifest = (platform: 'claude' | 'codex') => {
    const projected = createPlatformManifestBase(pluginMeta);
    if (manifest.skills) {
      projected.skills = `./${platform}/skills`;
    }
    return projected;
  };
  await Promise.all([
    fs.outputJson(manifestPath, manifest, { spaces: 2 }),
    ...[...nativePlatforms].map((platform) => fs.outputJson(
      path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json'),
      platformManifest(platform),
      { spaces: 2 },
    )),
    ...[...supportedPlatforms].map((platform) => fs.ensureDir(path.join(pluginRoot, platform))),
    ...(manifest.skills ? [...supportedPlatforms].map(async (platform) => {
      const source = path.join(pluginRoot, 'skills');
      const destination = path.join(pluginRoot, platform, 'skills');
      if (await fs.pathExists(source)) {
        await fs.remove(destination);
        await fs.copy(source, destination, { overwrite: true });
      } else await fs.ensureDir(destination);
      // Requirements receipts belong only to the generated platform transport.
      // Keep explicitly supplied bytes so corruption tests retain their evidence.
      for (const skill of await fs.readdir(destination, { withFileTypes: true })) {
        if (!skill.isDirectory() || !await fs.pathExists(path.join(destination, skill.name, 'SKILL.md'))) continue;
        const receiptPath = path.join(destination, skill.name, 'aw-plugin-requirements.json');
        if (!await fs.pathExists(receiptPath)) await fs.outputJson(receiptPath,
          createAwPluginRequirementsReceipt({ name: manifest.name, version: manifest.version }, manifest.requires?.aw.capabilities ?? []), { spaces: 2 });
      }
    }) : []),
  ]);
  await fs.outputFile(path.join(pluginRoot, 'README.md'), readme);
  return pluginMeta;
}

async function writeCatalogFixtureManifest(
  rootDir: string,
  metas: PluginMeta[],
  marketplaceMetas = metas,
): Promise<void> {
  const entries = await Promise.all(metas.map((meta) =>
    createCatalogManifestV7Entry(meta, meta.rootDir)));
  const marketplace = (platform: 'codex' | 'claude') => ({
    name: 'aw',
    owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture Marketplace' },
    plugins: marketplaceMetas
      .filter((meta) => resolveSupportedNativePlatforms(meta.manifest).has(platform))
      .map(createMarketplaceManifestEntry),
  });
  await Promise.all([
    fs.outputJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), marketplace('codex'), { spaces: 2 }),
    fs.outputJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), marketplace('claude'), { spaces: 2 }),
    fs.writeJson(path.join(rootDir, 'catalog-manifest.json'), createCatalogManifestV7({
      catalogVersion: '1.0.0',
      channel: 'latest',
      marketplace: {
        owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
        interface: { displayName: 'Fixture Marketplace' },
      },
      requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
      release: { state: 'development' },
      entries,
    }), { spaces: 2 }),
    fs.writeJson(path.join(rootDir, '.aw-generated.json'), {
      schemaVersion: 1,
      kind: 'catalog',
      workspaceIdentity: `fixture:${crypto.createHash('sha256').update(path.resolve(rootDir)).digest('hex')}`,
      sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${path.resolve(rootDir)}`).digest('hex')}`,
    }, { spaces: 2 }),
  ]);
}

export async function createCatalogSnapshotFixture(
  rootDir: string,
  pluginName = 'demo',
  requiredCapabilities: readonly string[] = [],
  readme = `${pluginName}\n`,
  configureManifest?: (manifest: PluginMeta['manifest']) => void,
): Promise<void> {
  const raw = await writeCatalogPluginFixture(rootDir, pluginName, requiredCapabilities, readme, configureManifest);
  const plugin = await readPluginManifest(raw.rootDir, { mode: 'bundle' });
  await writeCatalogFixtureManifest(rootDir, [plugin], [raw]);
}

export async function rewriteActiveCatalogCapabilities(options: {
  sourceId: string;
  requiredCapabilities: readonly string[];
  env: NodeJS.ProcessEnv;
  workspaceSnapshotRoot?: string;
}): Promise<void> {
  const state = await readCatalogGenerationState(options.env);
  const active = state.sources[options.sourceId]?.active;
  if (!active) throw new Error(`Catalog source ${options.sourceId} has no Active snapshot.`);
  const currentLocation = resolveCatalogStoreLocation({
    logicalIdentity: active.logicalIdentity,
    snapshotDigest: active.snapshotDigest,
    env: options.env,
  });
  const manifestPath = path.join(currentLocation.snapshotRoot, 'catalog-manifest.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  const requiredCapabilities = normalizeAwCapabilities(options.requiredCapabilities);
  await fs.writeJson(manifestPath, {
    ...manifest,
    requires: { aw: { capabilities: requiredCapabilities } },
  }, { spaces: 2 });
  if (options.workspaceSnapshotRoot) {
    const workspaceManifestPath = path.join(options.workspaceSnapshotRoot, 'catalog-manifest.json');
    const workspaceManifest = await fs.readJson(workspaceManifestPath) as Record<string, unknown>;
    await fs.writeJson(workspaceManifestPath, {
      ...workspaceManifest,
      requires: { aw: { capabilities: requiredCapabilities } },
    }, { spaces: 2 });
  }
  const validation = await validateCatalogSnapshotTransport(currentLocation.snapshotRoot);
  if (options.workspaceSnapshotRoot) {
    const workspaceValidation = await validateCatalogSnapshotTransport(options.workspaceSnapshotRoot);
    if (workspaceValidation.snapshotDigest !== validation.snapshotDigest) {
      throw new Error('Workspace and Active snapshot digests differ after capability rewrite.');
    }
  }
  const metadata = await fs.readJson(currentLocation.metadataPath) as Record<string, unknown>;
  await fs.writeJson(currentLocation.metadataPath, {
    ...metadata,
    manifestDigest: validation.manifestDigest,
    snapshotDigest: validation.snapshotDigest,
    requiredAwCapabilities: requiredCapabilities,
  }, { spaces: 2 });
  const nextLocation = resolveCatalogStoreLocation({
    logicalIdentity: active.logicalIdentity,
    snapshotDigest: validation.snapshotDigest,
    env: options.env,
  });
  await fs.move(currentLocation.entryDir, nextLocation.entryDir);
  await withCatalogGenerationStateTransaction({
    env: options.env,
    action: async (current) => ({
      state: {
        ...current,
        sources: {
          ...current.sources,
          [options.sourceId]: {
            ...current.sources[options.sourceId],
            active: {
              ...active,
              manifestDigest: validation.manifestDigest,
              snapshotDigest: validation.snapshotDigest,
            },
          },
        },
      },
      result: undefined,
    }),
  });
}

export async function createDependencyCatalogSnapshotFixture(
  rootDir: string,
  plugins: Array<{
    name: string;
    dependencies?: string[];
    requiredCapabilities?: string[];
    configureManifest?: (manifest: PluginMeta['manifest']) => void;
  }>,
): Promise<void> {
  // Prepare all plugin trees before generating the catalog-level files and digests.
  await fs.ensureDir(path.join(rootDir, 'plugins'));
  await Promise.all(plugins.map((plugin) => writeCatalogPluginFixture(
    rootDir,
    plugin.name,
    plugin.requiredCapabilities ?? [],
    `${plugin.name}\n`,
    (manifest) => {
      if (plugin.dependencies) manifest.dependencies = plugin.dependencies;
      manifest.extensions = {
        instructions: [{
          name: `${plugin.name}-instruction`,
          title: plugin.name,
          content: `${plugin.name}.`,
          coverage: ['main'],
        }],
      };
      plugin.configureManifest?.(manifest);
    },
  )));
  const metas = (await Promise.all(plugins.map((plugin) =>
    readPluginManifest(path.join(rootDir, 'plugins', plugin.name), { mode: 'bundle' }))))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  await writeCatalogFixtureManifest(rootDir, metas);
}

export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    },
  });
  return String(result.stdout).trim();
}
