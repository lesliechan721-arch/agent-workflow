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
  normalizeAwCapabilities,
  readPluginManifest,
} from '../../src/utils/manifest.js';
import { resolveSupportedPlatforms } from '../../src/utils/platform-support.js';
import { resolvePlatformEntries } from '../../src/utils/platform-entries.js';
import {
  readCatalogGenerationState,
  withCatalogGenerationStateTransaction,
} from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';

const execFileAsync = promisify(execFile);

export async function createCatalogSnapshotFixture(
  rootDir: string,
  pluginName = 'demo',
  requiredCapabilities: readonly string[] = [],
  readme = `${pluginName}\n`,
  configureManifest?: (manifest: PluginMeta['manifest']) => void,
): Promise<void> {
  await Promise.all([
    fs.ensureDir(path.join(rootDir, '.agents')),
    fs.ensureDir(path.join(rootDir, '.claude-plugin')),
    fs.ensureDir(path.join(rootDir, 'plugins')),
  ]);
  const pluginRoot = path.join(rootDir, 'plugins', pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 3,
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
  const marketplaceEntry = {
    name: manifest.name,
    source: `./plugins/${manifest.name}`,
    description: manifest.description,
    ...(manifest.interface ? { interface: manifest.interface } : {}),
    category: manifest.marketplace.category,
    strict: manifest.marketplace.strict,
    policy: manifest.marketplace.policy,
  };
  const supportedPlatforms = resolveSupportedPlatforms(manifest);
  await Promise.all((['claude', 'codex'] as const).map((platform) =>
    fs.remove(path.join(pluginRoot, `.${platform}-plugin`))));
  const marketplace = (platform: 'CODEX' | 'CLAUDE') => ({
    name: 'aw',
    owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture Marketplace' },
    plugins: supportedPlatforms.has(platform === 'CLAUDE' ? 'claude' : 'codex')
      ? [marketplaceEntry]
      : [],
  });
  const platformManifest = (platform: 'claude' | 'codex') => {
    const projected = {
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      ...(manifest.interface ? { interface: manifest.interface } : {}),
    } as Record<string, unknown>;
    if (platform === 'claude') {
      const agents = resolvePlatformEntries(manifest.extensions?.agents, platform);
      if (agents.length > 0) {
        projected.agents = agents.map((agent) => {
          const slug = (value: string) => value.trim().toLowerCase()
            .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
          return `./claude/agents/aw-${slug(manifest.name)}-${slug(agent.name)}.md`;
        });
      }
    }
    return projected;
  };
  const projectedAgentPaths = resolvePlatformEntries(manifest.extensions?.agents, 'claude').map((agent) => {
    const slug = (value: string) => value.trim().toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '');
    return path.join(pluginRoot, 'claude', 'agents', `aw-${slug(manifest.name)}-${slug(agent.name)}.md`);
  });
  await Promise.all([
    fs.outputJson(manifestPath, manifest, { spaces: 2 }),
    ...[...supportedPlatforms].map((platform) => fs.outputJson(
      path.join(pluginRoot, `.${platform}-plugin`, 'plugin.json'),
      platformManifest(platform),
      { spaces: 2 },
    )),
    ...(supportedPlatforms.has('claude')
      ? projectedAgentPaths.map((agentPath) => fs.outputFile(agentPath, '# Agent\n'))
      : []),
    fs.outputJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), marketplace('CODEX'), { spaces: 2 }),
    fs.outputJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), marketplace('CLAUDE'), { spaces: 2 }),
  ]);
  await fs.outputFile(path.join(pluginRoot, 'README.md'), readme);
  const plugin: PluginMeta = await readPluginManifest(pluginRoot, { mode: 'bundle' });
  const entry = await createCatalogManifestV7Entry(plugin, pluginRoot);
  await fs.writeJson(path.join(rootDir, 'catalog-manifest.json'), createCatalogManifestV7({
    catalogVersion: '1.0.0',
    channel: 'latest',
    marketplace: {
      owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
      interface: { displayName: 'Fixture Marketplace' },
    },
    requires: { aw: { capabilities: ['aw.catalog-snapshot.v7'] } },
    release: { state: 'development' },
    entries: [entry],
  }), { spaces: 2 });
  await fs.writeJson(path.join(rootDir, '.aw-generated.json'), {
    schemaVersion: 1,
    kind: 'catalog',
    workspaceIdentity: `fixture:${crypto.createHash('sha256').update(path.resolve(rootDir)).digest('hex')}`,
    sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${path.resolve(rootDir)}`).digest('hex')}`,
  }, { spaces: 2 });
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
  for (const plugin of plugins) {
    await createCatalogSnapshotFixture(
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
          }],
        };
        plugin.configureManifest?.(manifest);
      },
    );
  }
  const metas = (await Promise.all(plugins.map((plugin) =>
    readPluginManifest(path.join(rootDir, 'plugins', plugin.name), { mode: 'bundle' }))))
    .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
  const entries = await Promise.all(metas.map((meta) =>
    createCatalogManifestV7Entry(meta, meta.rootDir)));
  const marketplaceEntry = (meta: PluginMeta) => ({
    name: meta.manifest.name,
    source: `./plugins/${meta.manifest.name}`,
    description: meta.manifest.description,
    category: meta.manifest.marketplace.category,
    strict: meta.manifest.marketplace.strict,
    policy: meta.manifest.marketplace.policy,
  });
  const marketplace = (platform: 'CODEX' | 'CLAUDE') => ({
    name: 'aw',
    owner: { name: 'Fixture Owner', url: 'https://example.invalid/fixture' },
    interface: { displayName: 'Fixture Marketplace' },
    plugins: metas
      .filter((meta) => resolveSupportedPlatforms(meta.manifest)
        .has(platform === 'CLAUDE' ? 'claude' : 'codex'))
      .map(marketplaceEntry),
  });
  await Promise.all([
    fs.writeJson(path.join(rootDir, '.agents', 'plugins', 'marketplace.json'), marketplace('CODEX'), { spaces: 2 }),
    fs.writeJson(path.join(rootDir, '.claude-plugin', 'marketplace.json'), marketplace('CLAUDE'), { spaces: 2 }),
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
  ]);
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
