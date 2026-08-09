import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getCodexNativeRecoveryBreadcrumbPath,
  readCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';
import { createRecordId } from '../../src/install-state/ids.js';
import type { InstallRecordFile, PluginLocation } from '../../src/install-state/types.js';
import {
  buildCurrentCatalogCacheKey,
  acquireCurrentCatalogCacheLease,
  calculateBundleFingerprint,
  createAvailableLedger,
  ensureLocalMarketplace,
  hasInstalledLedgerDependencyMetadata,
  initializeLocalMarketplace,
  markCurrentCatalogCacheEntryValidated,
  materializeStagedMarketplaceCodexDynamicSkills,
  readCurrentCatalogCacheEntry,
  readCurrentCatalogCacheEntryBySelector,
  readCliPackageInfo,
  readInstalledLedger,
  resolveReadOnlyCatalogResolution,
  syncLocalMarketplaceCodexDynamicSkills,
  validateLocalMarketplaceLayout,
  writeCurrentCatalogCacheEntry,
  writeInstalledLedger,
  type CurrentCatalogCacheEntry,
  type CurrentCatalogCacheIdentity,
  type CurrentCatalogCacheObservation,
} from '../../src/utils/local-marketplace.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import {
  CatalogResolutionError,
  clearCurrentCatalogResolutionMemoForTests,
} from '../../src/utils/plugin-catalog.js';
import { readJsonFile } from '../../src/utils/json.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import {
  resolveCurrentCatalogCacheEntryDir,
  resolveCurrentCatalogCacheStagingDir,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import type { CatalogResolution, CatalogSelector, InstalledLedger } from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { TestPathFenceError } from '../helpers/test-isolation.js';
import {
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
  runWithCurrentRepositoryCwdAsReadOnly,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function updateFixturePluginManifest(
  repoRoot: string,
  updater: (manifest: Record<string, any>) => void,
): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  updater(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function makeWorkspace(
  manifestUpdater?: (manifest: Record<string, any>) => void,
  afterCopy?: (repoRoot: string) => Promise<void>,
): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-marketplace-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  if (manifestUpdater) {
    await updateFixturePluginManifest(repoRoot, manifestUpdater);
  }
  await afterCopy?.(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');

  return { repoRoot, awHome, embeddedRoot };
}

function createStaticCatalogPackageSource(options: {
  manifest: Record<string, unknown>;
  sidecarRoot: string;
  fullRoot: string;
  channel: 'latest' | 'beta';
  version: string;
}) {
  return {
    resolveIdentityByDistTag: async (packageName: string) => ({
      packageName,
      version: options.version,
      integrity: packageName === '@yiliang/aw-plugins-manifest'
        ? `sha512-sidecar-${options.version}`
        : `sha512-full-${options.version}`,
      requestedDistTag: options.channel,
    }),
    resolveIdentityByVersion: async (packageName: string, version: string) => ({
      packageName,
      version,
      integrity: packageName === '@yiliang/aw-plugins-manifest'
        ? `sha512-sidecar-${version}`
        : `sha512-full-${version}`,
    }),
    downloadArchive: async (identity: { packageName: string }) => ({
      identity,
      manifestText: await fs.readFile(
        path.join(
          identity.packageName === '@yiliang/aw-plugins-manifest'
            ? options.sidecarRoot
            : options.fullRoot,
          'catalog-manifest.json',
        ),
        'utf8',
      ),
      rawManifest: options.manifest,
      packageRoot: identity.packageName === '@yiliang/aw-plugins-manifest'
        ? options.sidecarRoot
        : options.fullRoot,
      materialize: async () => {},
      dispose: async () => {},
    }),
  };
}

async function writeUserSkillTriggerConfig(
  awHome: string,
  trigger: 'manual' | 'auto' = 'manual',
): Promise<void> {
  await writePluginConfigStore({
    pluginName: 'git-commit',
    scope: 'user',
    cwd: process.cwd(),
    env: { ...process.env, AW_HOME: awHome },
    values: {
      $aw: {
        skillTriggers: {
          commit: { trigger },
        },
      },
    },
  });
}

function codexOpenAiYamlPath(rootDir: string, pluginName = 'git-commit'): string {
  return path.join(
    rootDir,
    'plugins',
    pluginName,
    'codex',
    'skills',
    'commit',
    'agents',
    'openai.yaml',
  );
}

async function readCodexAllowImplicitInvocation(rootDir: string): Promise<boolean> {
  const parsed = YAML.parse(await fs.readFile(codexOpenAiYamlPath(rootDir), 'utf8')) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

async function writeCodexAllowImplicitInvocation(rootDir: string, value: boolean): Promise<void> {
  await fs.writeFile(
    codexOpenAiYamlPath(rootDir),
    YAML.stringify({ policy: { allow_implicit_invocation: value } }),
    'utf8',
  );
}

async function listSkillBackupDirs(
  rootDir: string,
  pluginName = 'git-commit',
  platform = 'codex',
): Promise<string[]> {
  const platformRoot = path.join(rootDir, 'plugins', pluginName, platform);
  if (!(await fs.pathExists(platformRoot))) {
    return [];
  }

  return (await fs.readdir(platformRoot))
    .filter((entry) => entry.startsWith('.skills-backup-'))
    .sort();
}

async function readLocalMarketplaceCatalogSelector(awHome: string): Promise<CatalogSelector> {
  const config = await readJsonFile<{ catalogSelector: CatalogSelector }>(
    path.join(awHome, 'config.json'),
  );
  return config.catalogSelector;
}

function createCatalogUnavailableError(selector: CatalogSelector): CatalogResolutionError {
  return new CatalogResolutionError({
    selector,
    cacheFallback: {
      used: false,
    },
    reason: 'current catalog is temporarily unavailable',
    reasonCode: 'catalogUnavailable',
  });
}

async function makeCurrentCatalogCacheFixture(options?: {
  selector?: CatalogSelector;
  catalogVersion?: string;
  minAwVersion?: string;
}): Promise<{
  cacheRoot: string;
  env: NodeJS.ProcessEnv;
  sourceRoot: string;
  identity: CurrentCatalogCacheIdentity;
}> {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-current-catalog-cache-'));
  tempDirs.push(cacheRoot);
  const env = { ...process.env, AW_HOME: cacheRoot };
  const sourceRoot = path.join(cacheRoot, 'source-catalog');
  await fs.ensureDir(sourceRoot);
  await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), { version: 1 }, { spaces: 2 });
  return {
    cacheRoot,
    env,
    sourceRoot,
    identity: {
      selector: options?.selector ?? {
        kind: 'distTag',
        cliVersion: '1.0.0',
        defaultChannel: 'latest',
        requestedChannel: 'latest',
      },
      channel: 'latest',
      catalogVersion: options?.catalogVersion ?? '1.0.0',
      minAwVersion: options?.minAwVersion ?? '1.0.0',
      schemaVersion: 1,
      historySchemaVersion: 1,
      sidecarIntegrity: 'sha512-sidecar',
      fullIntegrity: 'sha512-full',
    },
  };
}

function createCurrentCatalogCacheObservation(
  entry: CurrentCatalogCacheEntry,
): CurrentCatalogCacheObservation {
  return {
    sidecarManifestPackage: {
      source: '@yiliang/aw-plugins-manifest',
      version: entry.metadata.catalogVersion,
      channel: entry.metadata.channel,
      npmIntegrity: entry.metadata.sidecarIntegrity,
      manifestDigest: entry.metadata.manifestDigest,
    },
    latestCatalog: {
      channel: entry.metadata.channel,
      catalogVersion: entry.metadata.catalogVersion,
      minAwVersion: entry.metadata.minAwVersion,
      blocked: false,
    },
    historySchemaVersion: entry.metadata.historySchemaVersion,
    resolutionSource: 'requestedCatalog',
  };
}

async function getOnlyCurrentCatalogCacheIndexPath(cacheRoot: string): Promise<string> {
  const selectorsDir = path.join(cacheRoot, 'catalog-cache', 'selectors');
  const [indexName] = await fs.readdir(selectorsDir);
  return path.join(selectorsDir, indexName!);
}

async function writeLocalMarketplaceResolvedCatalog(
  awHome: string,
  resolvedCatalog: {
    channel: 'latest' | 'beta';
    catalogVersion: string;
    minAwVersion: string;
    historySchemaVersion: number | null;
  },
): Promise<void> {
  const configPath = path.join(awHome, 'config.json');
  const config = await fs.readJson(configPath) as Record<string, unknown>;
  config.resolvedCatalog = resolvedCatalog;
  await fs.writeJson(configPath, config, { spaces: 2 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  setCatalogPackageSourceForTests(null);
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local marketplace', () => {
  it('reuses a supplied catalog resolution without calling the current catalog resolver', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    const packageInfo = await readCliPackageInfo();
    const catalogResolution: CatalogResolution = {
      rootDir: embeddedRoot,
      source: 'remote',
      selector: {
        kind: 'default',
        cliVersion: packageInfo.version,
        defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
      },
      channel: packageInfo.version.includes('-') ? 'beta' : 'latest',
      catalogVersion: packageInfo.version,
      minAwVersion: packageInfo.version,
      historySchemaVersion: 1,
    };
    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');

    await expect(resolveReadOnlyCatalogResolution(env, { catalogResolution }))
      .resolves.toBe(catalogResolution);
    await expect(ensureLocalMarketplace(env, undefined, catalogResolution)).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });

    expect(resolveCurrentCatalog).not.toHaveBeenCalled();
    await expect(readJsonFile(path.join(awHome, 'config.json'))).resolves.toMatchObject({
      catalogSelector: catalogResolution.selector,
      resolvedCatalog: {
        channel: catalogResolution.channel,
        catalogVersion: catalogResolution.catalogVersion,
        minAwVersion: catalogResolution.minAwVersion,
        historySchemaVersion: catalogResolution.historySchemaVersion,
      },
    });
  });

  it('validates the layout of a supplied catalog resolution', async () => {
    const { awHome, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    const catalogResolution: CatalogResolution = {
      rootDir: path.join(repoRoot, 'missing-catalog'),
      source: 'remote',
    };
    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');

    await expect(resolveReadOnlyCatalogResolution(env, { catalogResolution })).rejects.toThrow();
    await expect(ensureLocalMarketplace(env, undefined, catalogResolution)).rejects.toThrow();
    expect(resolveCurrentCatalog).not.toHaveBeenCalled();
  });

  it('passes the requested freshness policy to current catalog resolution', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    const catalogResolution: CatalogResolution = {
      rootDir: embeddedRoot,
      source: 'cache',
    };
    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog')
      .mockResolvedValue(catalogResolution);

    await expect(resolveReadOnlyCatalogResolution(env, { freshnessPolicy: 'cacheFirst' }))
      .resolves.toBe(catalogResolution);
    expect(resolveCurrentCatalog).toHaveBeenCalledWith(env, {
      freshnessPolicy: 'cacheFirst',
    });
  });

  it('blocks local marketplace writes when AW_HOME points at a read-only fixture root', async () => {
    const { embeddedRoot } = await makeWorkspace();
    const repositoryCwd = path.resolve(getSourceTestRepositoryCwd(), '..', '..');
    await runWithCurrentRepositoryCwdAsReadOnly(async () => {
      const repositoryCwd = process.cwd();
      setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

      const error = await initializeLocalMarketplace({
        force: true,
        env: {
          ...process.env,
          AW_HOME: path.join(repositoryCwd, '.aw-readonly'),
        },
      }).catch((value) => value);
      expect(error).toBeInstanceOf(TestPathFenceError);
      expect((error as TestPathFenceError).details).toMatchObject({
        access: 'write',
        source: 'AW_HOME',
        reason: 'writeToReadOnlyRoot',
        conflictingRoot: {
          path: repositoryCwd,
        },
      });
    }, { repositoryCwd });
  });

  it('uses AW_HOME-backed staging and same-device backups when rebuilding a custom AW_HOME', async () => {
    const { embeddedRoot } = await makeWorkspace();
    const guardedRoot = await fs.mkdtemp(path.join(
      getSourceTestRepositoryCwd(),
      '.aw-local-marketplace-guarded-',
    ));
    tempDirs.push(guardedRoot);
    registerCurrentTestWritableStateRoot(guardedRoot, 'guarded local marketplace parent');
    const awHome = registerCurrentTestWritableStateRoot(
      path.join(guardedRoot, 'aw-home'),
      'guarded local marketplace AW_HOME',
    );
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    const observedMkdtempPrefixes: string[] = [];
    const observedMoveTargets: string[] = [];
    const realMkdtemp: typeof fs.mkdtemp = fs.mkdtemp.bind(fs);
    const realMove: typeof fs.move = fs.move.bind(fs);
    const mkdtempSpy = vi.spyOn(fs, 'mkdtemp').mockImplementation(async (...args) => {
      observedMkdtempPrefixes.push(String(args[0]));
      return realMkdtemp(...args);
    });
    const moveSpy = vi.spyOn(fs, 'move').mockImplementation(async (...args) => {
      observedMoveTargets.push(String(args[1]));
      return realMove(...args);
    });

    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    try {
      await initializeLocalMarketplace({ force: true, env });
      await initializeLocalMarketplace({ force: true, env });
    } finally {
      mkdtempSpy.mockRestore();
      moveSpy.mockRestore();
    }

    expect(observedMkdtempPrefixes).toEqual(expect.arrayContaining([
      expect.stringContaining(path.join(guardedRoot, '.aw-local-marketplace-staging', '.aw-staging-')),
    ]));
    expect(observedMoveTargets).toEqual(expect.arrayContaining([
      expect.stringContaining(path.join(guardedRoot, '.aw-local-marketplace-backups', '.aw-backup-')),
    ]));
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('falls back to a matching local marketplace only for catalogUnavailable current catalog failures', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);

    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(selector),
    );

    await expect(resolveReadOnlyCatalogResolution(env)).resolves.toMatchObject({
      rootDir: awHome,
      source: 'local',
      selector,
    });
  });

  it('falls back to embedded catalog when the local marketplace is missing and current catalog is unavailable', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    const packageInfo = await readCliPackageInfo();
    const selector: CatalogSelector = {
      kind: 'default',
      cliVersion: packageInfo.version,
      defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
    };
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(selector),
    );

    await expect(resolveReadOnlyCatalogResolution(env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      selector,
    });
  });

  it('falls back to embedded catalog instead of a local marketplace when selector metadata is missing', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    delete config.catalogSelector;
    await fs.writeJson(configPath, config, { spaces: 2 });
    const failure = createCatalogUnavailableError(selector);
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(failure);

    await expect(resolveReadOnlyCatalogResolution(env)).resolves.toMatchObject({
      rootDir: embeddedRoot,
      source: 'embedded',
      selector,
    });
  });

  it('tries current catalog before falling back to a healthy local marketplace when plugins-dist is missing', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);

    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(selector),
    );
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    await expect(ensureLocalMarketplace(env)).resolves.toEqual({
      rootDir: awHome,
      changed: false,
      warnings: [],
    });
    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a local marketplace for a different selector when plugins-dist is missing', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.catalogSelector = {
      kind: 'distTag',
      cliVersion: selector.cliVersion,
      defaultChannel: selector.defaultChannel,
      requestedChannel: selector.defaultChannel === 'latest' ? 'beta' : 'latest',
    };
    await fs.writeJson(configPath, config, { spaces: 2 });
    const failure = createCatalogUnavailableError(selector);
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(failure);
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    await expect(ensureLocalMarketplace(env)).rejects.toBe(failure);
  });

  it('reuses a default-selector local marketplace for read-only resolution when the same channel is requested explicitly', async () => {
    const { awHome, repoRoot, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const explicitSelector: CatalogSelector = {
      kind: 'distTag',
      cliVersion: selector.cliVersion,
      defaultChannel: selector.defaultChannel,
      requestedChannel: selector.defaultChannel,
    };
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(explicitSelector),
    );

    await expect(resolveReadOnlyCatalogResolution({
      ...env,
      AW_CATALOG_CHANNEL: selector.defaultChannel,
    })).resolves.toMatchObject({
      rootDir: awHome,
      source: 'local',
      selector: explicitSelector,
    });
  });

  it('reuses a default-selector local marketplace during ensureLocalMarketplace when the same channel is requested explicitly', async () => {
    const { awHome, repoRoot, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const explicitSelector: CatalogSelector = {
      kind: 'distTag',
      cliVersion: selector.cliVersion,
      defaultChannel: selector.defaultChannel,
      requestedChannel: selector.defaultChannel,
    };
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(explicitSelector),
    );

    await expect(ensureLocalMarketplace({
      ...env,
      AW_CATALOG_CHANNEL: selector.defaultChannel,
    })).resolves.toEqual({
      rootDir: awHome,
      changed: false,
      warnings: [],
    });
  });

  it('does not reuse a channel-matched local marketplace for read-only resolution after the dist-tag moves', async () => {
    const { awHome, repoRoot, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const currentManifest = await fs.readJson(
      path.join(embeddedRoot, '.catalog', 'sidecar', 'catalog-manifest.json'),
    ) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
      compatibility: {
        aw: {
          minVersion: string;
        };
      };
      history: {
        schemaVersion: number;
      };
    };
    await writeLocalMarketplaceResolvedCatalog(awHome, {
      channel: currentManifest.channel,
      catalogVersion: currentManifest.catalogVersion,
      minAwVersion: currentManifest.compatibility.aw.minVersion,
      historySchemaVersion: currentManifest.history.schemaVersion,
    });

    const explicitSelector: CatalogSelector = {
      kind: 'distTag',
      cliVersion: selector.cliVersion,
      defaultChannel: selector.defaultChannel,
      requestedChannel: selector.defaultChannel,
    };
    const failure = new CatalogResolutionError({
      selector: explicitSelector,
      channel: currentManifest.channel,
      catalogVersion: '9.9.9',
      minAwVersion: currentManifest.compatibility.aw.minVersion,
      historySchemaVersion: currentManifest.history.schemaVersion,
      cacheFallback: {
        used: false,
      },
      reason: 'current catalog is temporarily unavailable',
      reasonCode: 'catalogUnavailable',
    });
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(failure);

    await expect(resolveReadOnlyCatalogResolution({
      ...env,
      AW_CATALOG_CHANNEL: selector.defaultChannel,
    })).rejects.toBe(failure);
  });

  it('does not reuse a channel-matched local marketplace during ensureLocalMarketplace after the dist-tag moves', async () => {
    const { awHome, repoRoot, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    const currentManifest = await fs.readJson(
      path.join(embeddedRoot, '.catalog', 'sidecar', 'catalog-manifest.json'),
    ) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
      compatibility: {
        aw: {
          minVersion: string;
        };
      };
      history: {
        schemaVersion: number;
      };
    };
    await writeLocalMarketplaceResolvedCatalog(awHome, {
      channel: currentManifest.channel,
      catalogVersion: currentManifest.catalogVersion,
      minAwVersion: currentManifest.compatibility.aw.minVersion,
      historySchemaVersion: currentManifest.history.schemaVersion,
    });

    const explicitSelector: CatalogSelector = {
      kind: 'distTag',
      cliVersion: selector.cliVersion,
      defaultChannel: selector.defaultChannel,
      requestedChannel: selector.defaultChannel,
    };
    const failure = new CatalogResolutionError({
      selector: explicitSelector,
      channel: currentManifest.channel,
      catalogVersion: '9.9.9',
      minAwVersion: currentManifest.compatibility.aw.minVersion,
      historySchemaVersion: currentManifest.history.schemaVersion,
      cacheFallback: {
        used: false,
      },
      reason: 'current catalog is temporarily unavailable',
      reasonCode: 'catalogUnavailable',
    });
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(failure);

    await expect(ensureLocalMarketplace({
      ...env,
      AW_CATALOG_CHANNEL: selector.defaultChannel,
    })).rejects.toBe(failure);
  });

  it('rebuilds from resolved current catalog instead of reusing a same-version stale local marketplace', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const staleConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );

    await fs.appendFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
      '\ncurrent-catalog-marker\n',
      'utf8',
    );
    const currentEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(currentEmbeddedRoot);
    const sidecarRoot = path.join(currentEmbeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(currentEmbeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    const result = await ensureLocalMarketplace(env);

    expect(result).toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    const currentConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    expect(currentConfig.bundleFingerprint).toBe(await calculateBundleFingerprint(fullRoot));
    expect(currentConfig.bundleFingerprint).not.toBe(staleConfig.bundleFingerprint);
    await expect(fs.readFile(
      path.join(awHome, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('current-catalog-marker');
  });

  it('prefers the default current catalog over plugins-dist when rebuilding the local marketplace', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };

    await fs.appendFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
      '\ndefault-current-catalog-marker\n',
      'utf8',
    );
    const currentEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(currentEmbeddedRoot);
    const sidecarRoot = path.join(currentEmbeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(currentEmbeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');

    const result = await initializeLocalMarketplace({ force: true, env });

    expect(result).toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(
      path.join(awHome, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('default-current-catalog-marker');
    const currentConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    expect(currentConfig.bundleFingerprint).toBe(await calculateBundleFingerprint(fullRoot));
    expect(currentConfig.bundleFingerprint).not.toBe(await calculateBundleFingerprint(embeddedRoot));
  });

  it('rebuilds from the requested current catalog when a selector override is provided', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });

    await fs.appendFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
      '\nselector-override-marker\n',
      'utf8',
    );
    const requestedEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(requestedEmbeddedRoot);
    const sidecarRoot = path.join(requestedEmbeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(requestedEmbeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));

    const result = await ensureLocalMarketplace({
      ...env,
      AW_CATALOG_VERSION: manifest.catalogVersion,
    });

    expect(result).toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(readLocalMarketplaceCatalogSelector(awHome)).resolves.toMatchObject({
      kind: 'exactVersion',
      requestedCatalogVersion: manifest.catalogVersion,
    });
    await expect(fs.readFile(
      path.join(awHome, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      'utf8',
    )).resolves.toContain('selector-override-marker');
  });

  it('reuses a matching local marketplace for read-only resolution when a selector override catalog is unavailable', async () => {
    const { awHome, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    await fs.appendFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
      '\nselector-override-read-only-marker\n',
      'utf8',
    );
    const requestedEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(requestedEmbeddedRoot);
    const sidecarRoot = path.join(requestedEmbeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(requestedEmbeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));

    const selectorEnv = {
      ...env,
      AW_CATALOG_VERSION: manifest.catalogVersion,
    };
    await initializeLocalMarketplace({ force: true, env: selectorEnv });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(selector),
    );

    await expect(resolveReadOnlyCatalogResolution(selectorEnv)).resolves.toMatchObject({
      rootDir: awHome,
      source: 'local',
      selector,
    });
  });

  it('reuses a matching local marketplace during ensureLocalMarketplace when a selector override catalog is unavailable', async () => {
    const { awHome, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    await fs.appendFile(
      path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
      '\nselector-override-writeable-marker\n',
      'utf8',
    );
    const requestedEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(requestedEmbeddedRoot);
    const sidecarRoot = path.join(requestedEmbeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(requestedEmbeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));

    const selectorEnv = {
      ...env,
      AW_CATALOG_VERSION: manifest.catalogVersion,
    };
    await initializeLocalMarketplace({ force: true, env: selectorEnv });
    const selector = await readLocalMarketplaceCatalogSelector(awHome);
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      createCatalogUnavailableError(selector),
    );

    await expect(ensureLocalMarketplace(selectorEnv)).resolves.toEqual({
      rootDir: awHome,
      changed: false,
      warnings: [],
    });
  });

  it('does not mask fail-closed current catalog failures with the local marketplace', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });
    const failure = new CatalogResolutionError({
      selector: {
        kind: 'default',
        cliVersion: '0.1.0',
        defaultChannel: 'latest',
      },
      channel: 'latest',
      catalogVersion: '2.0.0',
      minAwVersion: '2.0.0',
      cacheFallback: {
        used: false,
      },
      reason: '当前 CLI 版本过低。',
      reasonCode: 'awVersionTooLow',
    });
    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(failure);

    await expect(resolveReadOnlyCatalogResolution(env)).rejects.toBe(failure);
  });

  it('writes and reads isolated current catalog cache entries', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-current-catalog-cache-'));
    tempDirs.push(cacheRoot);
    const env = {
      ...process.env,
      AW_HOME: cacheRoot,
    };
    const sourceRoot = path.join(cacheRoot, 'source-catalog');
    await fs.ensureDir(sourceRoot);
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), { version: 1 }, { spaces: 2 });

    const selector: CatalogSelector = {
      kind: 'distTag',
      cliVersion: '1.0.0',
      defaultChannel: 'latest',
      requestedChannel: 'latest',
    };
    const identity = {
      selector,
      channel: 'latest' as const,
      catalogVersion: '1.0.0',
      minAwVersion: '1.0.0',
      schemaVersion: 1,
      historySchemaVersion: 1,
      sidecarIntegrity: 'sha512-sidecar',
      fullIntegrity: 'sha512-full',
    };

    const written = await writeCurrentCatalogCacheEntry({
      ...identity,
      sourceRoot,
      env,
    });
    expect(written.cacheKey).toBe(buildCurrentCatalogCacheKey(identity));
    expect(resolveCurrentCatalogCacheEntryDir(written.cacheKey, env)).toBe(path.dirname(written.rootDir));

    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
      rootDir: written.rootDir,
      metadata: {
        channel: 'latest',
        catalogVersion: '1.0.0',
      },
    });

    const selectorsDir = path.join(cacheRoot, 'catalog-cache', 'selectors');
    const [indexName] = await fs.readdir(selectorsDir);
    const indexPath = path.join(selectorsDir, indexName!);
    const index = await fs.readJson(indexPath) as Record<string, unknown>;
    await fs.writeJson(indexPath, { ...index, validatedAt: '2000-01-01T00:00:00.000Z' });
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      validatedAt: written.metadata.createdAt,
    });
  });

  it('publishes concurrent immutable cache writers without partial reader state', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-current-catalog-cache-race-'));
    tempDirs.push(cacheRoot);
    const env = { ...process.env, AW_HOME: cacheRoot };
    const sourceRoot = path.join(cacheRoot, 'source-catalog');
    await fs.ensureDir(sourceRoot);
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), { version: 1 }, { spaces: 2 });
    const identity = {
      selector: {
        kind: 'default' as const,
        cliVersion: '1.0.0',
        defaultChannel: 'latest' as const,
      },
      channel: 'latest' as const,
      catalogVersion: '1.0.0',
      minAwVersion: '1.0.0',
      schemaVersion: 1,
      historySchemaVersion: 1,
      sidecarIntegrity: 'sha512-sidecar',
      fullIntegrity: 'sha512-full',
    };

    const writers = [1, 2, 3].map(() => writeCurrentCatalogCacheEntry({
      ...identity,
      sourceRoot,
      env,
    }));
    const readers = [1, 2, 3, 4].map(() => readCurrentCatalogCacheEntry(identity, env));
    const [written, observed] = await Promise.all([
      Promise.all(writers),
      Promise.all(readers),
    ]);

    expect(new Set(written.map((entry) => entry.rootDir)).size).toBe(1);
    expect(observed.every((entry) => entry === null || entry.cacheKey === written[0]!.cacheKey)).toBe(true);
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      cacheKey: written[0]!.cacheKey,
    });
  });

  it('bounds catalog cache lock waits and never releases a different owner token', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const lease = await acquireCurrentCatalogCacheLease(env);
    expect(path.resolve(lease.lockPath).startsWith(`${path.resolve(String(env.AW_HOME))}${path.sep}`))
      .toBe(false);
    await expect(acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 20,
      pollMs: 5,
      staleMs: 60_000,
    })).rejects.toThrow('Timed out after 20ms');
    await expect(fs.readJson(path.join(lease.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: lease.owner.token,
    });

    const controller = new AbortController();
    const aborted = new Error('aborted catalog cache lock wait');
    const waitingLease = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 5_000,
      pollMs: 1_000,
      staleMs: 60_000,
      signal: controller.signal,
    });
    controller.abort(aborted);
    await expect(waitingLease).rejects.toBe(aborted);
    await expect(fs.readJson(path.join(lease.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: lease.owner.token,
    });

    const mismatchedToken = '00000000-0000-4000-8000-000000000001';
    await fs.writeJson(path.join(lease.lockPath, 'owner.json'), {
      ...lease.owner,
      token: mismatchedToken,
    });
    await expect(lease.release()).resolves.toBe(false);
    await expect(fs.readJson(path.join(lease.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: mismatchedToken,
    });
    await fs.remove(lease.lockPath);
  });

  it('removes its catalog cache lock when synchronous owner metadata writing fails', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const failure = new Error('injected synchronous owner write failure');
    const realWriteFileSync: typeof fs.writeFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      if (path.basename(String(args[0])) === 'owner.json') {
        throw failure;
      }
      return realWriteFileSync(...args);
    });

    await expect(acquireCurrentCatalogCacheLease(env)).rejects.toBe(failure);
    writeSpy.mockRestore();
    const lockRoot = path.join(path.dirname(String(env.AW_HOME)), '.aw-local-marketplace-staging');
    const siblingEntries = await fs.readdir(lockRoot).catch(() => [] as string[]);
    expect(siblingEntries.filter((entry) => entry.startsWith('.catalog-cache-'))).toEqual([]);
  });

  it('recovers stale dead, PID-reused, and ownerless catalog cache locks without residue', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const staleOwners = [
      { pid: 999_999, processStartIdentity: 'dead-process' },
      { pid: process.pid, processStartIdentity: 'reused-process-start' },
      null,
    ] as const;

    for (const staleOwner of staleOwners) {
      const staleLease = await acquireCurrentCatalogCacheLease(env);
      const ownerPath = path.join(staleLease.lockPath, 'owner.json');
      if (staleOwner === null) {
        await fs.remove(ownerPath);
      } else {
        await fs.writeJson(ownerPath, { ...staleLease.owner, ...staleOwner });
      }
      const oldTime = new Date(Date.now() - 60_000);
      await fs.utimes(staleLease.lockPath, oldTime, oldTime);

      const recovered = await acquireCurrentCatalogCacheLease(env, {
        timeoutMs: 100,
        pollMs: 2,
        staleMs: 0,
      });
      await expect(staleLease.release()).resolves.toBe(false);
      await expect(recovered.release()).resolves.toBe(true);
      await expect(fs.pathExists(recovered.lockPath)).resolves.toBe(false);
    }
  });

  it('never recovers an invalid stale owner automatically under competing waiters', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const invalidOwnerLease = await acquireCurrentCatalogCacheLease(env);
    const ownerPath = path.join(invalidOwnerLease.lockPath, 'owner.json');
    await fs.writeFile(ownerPath, '{invalid owner', 'utf8');
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(invalidOwnerLease.lockPath, oldTime, oldTime);

    const waiters = [0, 1, 2, 3].map(() => acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 25,
      pollMs: 2,
      staleMs: 0,
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    ));
    const results = await Promise.all(waiters);
    expect(results.every((result) => 'error' in result)).toBe(true);
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe('{invalid owner');
    await fs.writeJson(ownerPath, invalidOwnerLease.owner);
    await expect(invalidOwnerLease.release()).resolves.toBe(true);
  });

  it('keeps the canonical lock closed to later contenders when a stale claim observes a new owner', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const ownerA = await acquireCurrentCatalogCacheLease(env);
    await fs.writeJson(path.join(ownerA.lockPath, 'owner.json'), {
      ...ownerA.owner,
      pid: 999_999,
      processStartIdentity: 'dead-owner-a',
    });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(ownerA.lockPath, oldTime, oldTime);

    let staleClaimReady!: () => void;
    const staleClaimObservedOwnerA = new Promise<void>((resolve) => {
      staleClaimReady = resolve;
    });
    let releaseStaleClaim!: () => void;
    const staleClaimReleased = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    const staleContenderResult = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 40,
      pollMs: 2,
      staleMs: 0,
      __testBeforeStaleClaim: async () => {
        staleClaimReady();
        await staleClaimReleased;
      },
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    await staleClaimObservedOwnerA;
    await expect(ownerA.release()).resolves.toBe(true);
    const ownerB = await acquireCurrentCatalogCacheLease(env);
    const thirdContenderResult = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 30,
      pollMs: 2,
      staleMs: 60_000,
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );
    const fourthContenderResult = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 30,
      pollMs: 2,
      staleMs: 0,
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );

    releaseStaleClaim();
    const [staleContender, thirdContender, fourthContender] = await Promise.all([
      staleContenderResult,
      thirdContenderResult,
      fourthContenderResult,
    ]);
    expect(staleContender).toHaveProperty('error');
    expect(thirdContender).toHaveProperty('error');
    expect(fourthContender).toHaveProperty('error');
    await expect(fs.readJson(path.join(ownerB.lockPath, 'owner.json'))).resolves.toMatchObject({
      token: ownerB.owner.token,
    });
    await expect(ownerB.release()).resolves.toBe(true);
    await expect(fs.pathExists(ownerB.lockPath)).resolves.toBe(false);
  });

  it('lets a new owner release after a stale claimant temporarily claims its owner file', async () => {
    const { env } = await makeCurrentCatalogCacheFixture();
    const ownerA = await acquireCurrentCatalogCacheLease(env);
    await fs.writeJson(path.join(ownerA.lockPath, 'owner.json'), {
      ...ownerA.owner,
      pid: 999_999,
      processStartIdentity: 'dead-owner-a',
    });
    const oldTime = new Date(Date.now() - 60_000);
    await fs.utimes(ownerA.lockPath, oldTime, oldTime);

    let beforeClaimReady!: () => void;
    const staleReadOwnerA = new Promise<void>((resolve) => {
      beforeClaimReady = resolve;
    });
    let releaseBeforeClaim!: () => void;
    const beforeClaimReleased = new Promise<void>((resolve) => {
      releaseBeforeClaim = resolve;
    });
    let afterClaimReady!: () => void;
    const staleClaimedOwnerB = new Promise<void>((resolve) => {
      afterClaimReady = resolve;
    });
    let releaseAfterClaim!: () => void;
    const afterClaimReleased = new Promise<void>((resolve) => {
      releaseAfterClaim = resolve;
    });
    let mismatchRestoreReady!: () => void;
    const mismatchOwnerRestored = new Promise<void>((resolve) => {
      mismatchRestoreReady = resolve;
    });
    let releaseMismatchRestore!: () => void;
    const mismatchRestoreReleased = new Promise<void>((resolve) => {
      releaseMismatchRestore = resolve;
    });
    const staleContenderResult = acquireCurrentCatalogCacheLease(env, {
      timeoutMs: 100,
      pollMs: 2,
      staleMs: 0,
      __testBeforeStaleClaim: async () => {
        beforeClaimReady();
        await beforeClaimReleased;
      },
      __testAfterStaleClaim: async () => {
        afterClaimReady();
        await afterClaimReleased;
      },
      __testAfterMismatchOwnerRestore: async () => {
        mismatchRestoreReady();
        await mismatchRestoreReleased;
      },
    }).then(
      (lease) => ({ lease }),
      (error: unknown) => ({ error }),
    );

    await staleReadOwnerA;
    await expect(ownerA.release()).resolves.toBe(true);
    const ownerB = await acquireCurrentCatalogCacheLease(env);
    releaseBeforeClaim();
    await staleClaimedOwnerB;
    let ownerBReleaseSettled = false;
    const ownerBRelease = ownerB.release().finally(() => {
      ownerBReleaseSettled = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(ownerBReleaseSettled).toBe(false);

    releaseAfterClaim();
    await mismatchOwnerRestored;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(ownerBReleaseSettled).toBe(false);
    releaseMismatchRestore();
    await expect(ownerBRelease).resolves.toBe(true);
    const staleContender = await staleContenderResult;
    if ('lease' in staleContender) {
      await staleContender.lease.release();
    }
    await expect(fs.pathExists(ownerB.lockPath)).resolves.toBe(false);
  });

  it('waits for a v2 selector index displaced during Windows replacement', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    expect(written.metadata.version).toBe(2);
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);

    let displacementSeen!: () => void;
    const indexDisplaced = new Promise<void>((resolve) => {
      displacementSeen = resolve;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    let readerPolling!: () => void;
    const readerEnteredBoundedPoll = new Promise<void>((resolve) => {
      readerPolling = resolve;
    });
    let stagedPublishAttempts = 0;
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const source = String(args[0]);
      const target = String(args[1]);
      if (target === indexPath && source.endsWith('.tmp')) {
        stagedPublishAttempts += 1;
        if (stagedPublishAttempts === 1) {
          const error = new Error('injected Windows replace path') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
      }
      if (source === indexPath && target.endsWith('.tmp.old')) {
        const result = await realRename(...args);
        displacementSeen();
        await publicationReleased;
        return result;
      }
      return realRename(...args);
    });
    const realPathExists: typeof fs.pathExists = fs.pathExists.bind(fs);
    let missingIndexReads = 0;
    const pathExistsSpy = vi.spyOn(fs, 'pathExists').mockImplementation(async (...args) => {
      const exists = await realPathExists(...args);
      if (String(args[0]) === indexPath && !exists) {
        missingIndexReads += 1;
        if (missingIndexReads === 2) {
          readerPolling();
        }
      }
      return exists;
    });

    const writer = markCurrentCatalogCacheEntryValidated(written, env);
    await indexDisplaced;
    const reader = readCurrentCatalogCacheEntryBySelector(identity.selector, env);
    await readerEnteredBoundedPoll;
    releasePublication();
    const [selected] = await Promise.all([reader, writer]);
    renameSpy.mockRestore();
    pathExistsSpy.mockRestore();

    expect(selected).toMatchObject({
      cacheKey: written.cacheKey,
      metadata: { version: 2 },
    });
  });

  it('ignores v1 selector index observations and reads the immutable v1 entry without migration', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const metadata = await fs.readJson(written.metadataPath) as Record<string, unknown>;
    delete metadata.publicationId;
    await fs.writeJson(written.metadataPath, { ...metadata, version: 1 }, { spaces: 2 });

    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const index = await fs.readJson(indexPath) as Record<string, unknown>;
    await fs.writeJson(indexPath, {
      version: 1,
      selectorKey: index.selectorKey,
      cacheKey: index.cacheKey,
      validatedAt: index.validatedAt,
      observation: createCurrentCatalogCacheObservation(written),
    }, { spaces: 2 });

    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
      metadata: { version: 1 },
    });
    await expect(fs.readJson(indexPath)).resolves.toHaveProperty('observation');
  });

  it('does not scan v1 entry metadata that carries an observation field', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await fs.remove(await getOnlyCurrentCatalogCacheIndexPath(cacheRoot));
    const metadata = await fs.readJson(written.metadataPath) as Record<string, unknown>;
    delete metadata.publicationId;
    await fs.writeJson(written.metadataPath, {
      ...metadata,
      version: 1,
      observation: { forged: true },
    }, { spaces: 2 });

    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toBeNull();
  });

  it('does not scan a v2 orphan disguised as v1 while publicationId remains', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await fs.remove(await getOnlyCurrentCatalogCacheIndexPath(cacheRoot));
    await fs.writeJson(written.metadataPath, {
      ...await fs.readJson(written.metadataPath),
      version: 1,
    }, { spaces: 2 });

    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toBeNull();
    await expect(fs.readdir(path.join(cacheRoot, 'catalog-cache', 'selectors'))).resolves.toEqual([]);
  });

  it('does not write a selector index while reading a legacy v1 entry', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const legacy = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const metadata = await fs.readJson(legacy.metadataPath) as Record<string, unknown>;
    delete metadata.publicationId;
    await fs.writeJson(legacy.metadataPath, { ...metadata, version: 1 }, { spaces: 2 });
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    await fs.remove(indexPath);
    const linkSpy = vi.spyOn(fs, 'link');
    const copySpy = vi.spyOn(fs, 'copyFile');

    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toMatchObject({
      cacheKey: legacy.cacheKey,
      metadata: { version: 1 },
    });
    expect(linkSpy).not.toHaveBeenCalled();
    expect(copySpy).not.toHaveBeenCalled();
    linkSpy.mockRestore();
    copySpy.mockRestore();
    await expect(fs.pathExists(indexPath)).resolves.toBe(false);
  });

  it('drops conflicting v2 requested-catalog observations but keeps the committed entry', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const validObservation = createCurrentCatalogCacheObservation(written);
    await markCurrentCatalogCacheEntryValidated(written, env, undefined, validObservation);
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const validIndex = await fs.readJson(indexPath) as Record<string, unknown>;
    const conflicts: Array<(observation: CurrentCatalogCacheObservation) => void> = [
      (observation) => { observation.sidecarManifestPackage.source = '@example/forged'; },
      (observation) => { observation.sidecarManifestPackage.version = '1.0.1'; },
      (observation) => { observation.sidecarManifestPackage.channel = 'beta'; },
      (observation) => { observation.sidecarManifestPackage.manifestDigest = `sha256:${'0'.repeat(64)}`; },
      (observation) => { observation.sidecarManifestPackage.npmIntegrity = 'sha512-other'; },
      (observation) => { observation.historySchemaVersion = 2; },
      (observation) => { observation.resolutionSource = 'historyCompatibleCatalog'; },
      (observation) => { observation.latestCatalog!.blocked = true; },
      (observation) => {
        observation.latestCatalogBlocked = {
          channel: 'latest',
          catalogVersion: '2.0.0',
          minAwVersion: '2.0.0',
        };
      },
    ];

    for (const mutate of conflicts) {
      const observation = structuredClone(validObservation);
      mutate(observation);
      await fs.writeJson(indexPath, { ...validIndex, observation }, { spaces: 2 });
      const cached = await readCurrentCatalogCacheEntryBySelector(identity.selector, env);
      expect(cached).toMatchObject({ cacheKey: written.cacheKey });
      expect(cached).not.toHaveProperty('observation');
    }
  });

  it('accepts only selector-compatible blocked history observations', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const blockedObservation: CurrentCatalogCacheObservation = {
      ...createCurrentCatalogCacheObservation(written),
      latestCatalog: {
        channel: 'latest',
        catalogVersion: '2.0.0',
        minAwVersion: '2.0.0',
        blocked: true,
      },
      latestCatalogBlocked: {
        channel: 'latest',
        catalogVersion: '2.0.0',
        minAwVersion: '2.0.0',
      },
      resolutionSource: 'historyCompatibleCatalog',
    };
    await markCurrentCatalogCacheEntryValidated(written, env, undefined, blockedObservation);
    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toMatchObject({
      observation: blockedObservation,
    });

    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const validIndex = await fs.readJson(indexPath) as Record<string, unknown>;
    const conflicts: Array<(observation: CurrentCatalogCacheObservation) => void> = [
      (observation) => { observation.latestCatalogBlocked!.catalogVersion = '2.0.1'; },
      (observation) => { observation.latestCatalog!.catalogVersion = identity.catalogVersion; },
      (observation) => { observation.latestCatalog!.minAwVersion = identity.selector.cliVersion; },
      (observation) => { observation.latestCatalog!.blocked = false; },
      (observation) => { observation.historySchemaVersion = null; },
    ];
    for (const mutate of conflicts) {
      const observation = structuredClone(blockedObservation);
      mutate(observation);
      await fs.writeJson(indexPath, { ...validIndex, observation }, { spaces: 2 });
      expect(await readCurrentCatalogCacheEntryBySelector(identity.selector, env)).not.toHaveProperty('observation');
    }
  });

  it('does not scan an aborted orphan v2 entry and lets another writer adopt it', async () => {
    const { env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const controller = new AbortController();
    const finalEntryDir = resolveCurrentCatalogCacheEntryDir(buildCurrentCatalogCacheKey(identity), env);
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const result = await realRename(...args);
      if (path.resolve(String(args[1])) === path.resolve(finalEntryDir)) {
        controller.abort();
      }
      return result;
    });

    await expect(writeCurrentCatalogCacheEntry({
      ...identity,
      sourceRoot,
      env,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    renameSpy.mockRestore();

    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toBeNull();
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toBeNull();
    const adopted = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toMatchObject({
      cacheKey: adopted.cacheKey,
      metadata: { publicationId: adopted.metadata.version === 2 ? adopted.metadata.publicationId : '' },
    });
  });

  it('serializes a second writer while isolating a corrupt entry', async () => {
    const { env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const finalEntryDir = resolveCurrentCatalogCacheEntryDir(buildCurrentCatalogCacheKey(identity), env);
    await fs.ensureDir(finalEntryDir);
    await fs.writeJson(path.join(finalEntryDir, 'entry.json'), { version: 'corrupt' });

    let releaseQuarantine!: () => void;
    const quarantineReleased = new Promise<void>((resolve) => {
      releaseQuarantine = resolve;
    });
    let quarantineStarted!: () => void;
    const quarantined = new Promise<void>((resolve) => {
      quarantineStarted = resolve;
    });
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const result = await realRename(...args);
      if (
        path.resolve(String(args[0])) === path.resolve(finalEntryDir) &&
        path.basename(String(args[1])).startsWith('corrupt-')
      ) {
        quarantineStarted();
        await quarantineReleased;
      }
      return result;
    });

    const firstWriter = writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    await quarantined;
    const secondWriterPromise = writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    releaseQuarantine();
    const [firstResult, secondWriter] = await Promise.all([firstWriter, secondWriterPromise]);
    renameSpy.mockRestore();

    expect(firstResult.metadata).toMatchObject({
      version: 2,
      publicationId: secondWriter.metadata.version === 2
        ? secondWriter.metadata.publicationId
        : '',
    });
    await expect(readCurrentCatalogCacheEntry(identity, env)).resolves.toMatchObject({
      metadata: {
        version: 2,
        publicationId: secondWriter.metadata.version === 2
          ? secondWriter.metadata.publicationId
          : '',
      },
    });
  });

  it.each([
    ['second rename failure', false],
    ['abort after displacement', true],
  ])('restores the old Windows selector index after %s', async (_label, abortAfterDisplacement) => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const oldIndex = await fs.readJson(indexPath);
    const controller = new AbortController();
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    let stagedPublishAttempts = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const source = String(args[0]);
      const target = String(args[1]);
      if (target === indexPath && source.endsWith('.tmp')) {
        stagedPublishAttempts += 1;
        const error = new Error('injected Windows rename failure') as NodeJS.ErrnoException;
        error.code = stagedPublishAttempts === 1 ? 'EPERM' : 'EIO';
        throw error;
      }
      const result = await realRename(...args);
      if (target.endsWith('.old') && abortAfterDisplacement) {
        controller.abort();
      }
      return result;
    });

    await expect(markCurrentCatalogCacheEntryValidated(
      written,
      env,
      new Date(Date.now() + 100).toISOString(),
      undefined,
      controller.signal,
    )).rejects.toBeDefined();
    renameSpy.mockRestore();

    await expect(fs.readJson(indexPath)).resolves.toEqual(oldIndex);
    await expect(readCurrentCatalogCacheEntryBySelector(identity.selector, env)).resolves.toMatchObject({
      cacheKey: written.cacheKey,
    });
  });

  it.each([
    ['restores with exclusive copy when no new index exists', false, 'ENOTSUP'],
    ['keeps a valid concurrent index', true, 'EOPNOTSUPP'],
  ])('handles unsupported hard links and %s', async (_label, publishConcurrentIndex, linkErrorCode) => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const oldIndex = await fs.readJson(indexPath) as Record<string, unknown>;
    const concurrentIndex = {
      ...oldIndex,
      validatedAt: new Date().toISOString(),
    };
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    let stagedPublishAttempts = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const source = String(args[0]);
      const target = String(args[1]);
      if (target === indexPath && source.endsWith('.tmp')) {
        stagedPublishAttempts += 1;
        if (stagedPublishAttempts === 1) {
          const error = new Error('injected Windows rename failure') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        if (publishConcurrentIndex) {
          await fs.writeJson(indexPath, concurrentIndex, { spaces: 2 });
        }
        const error = new Error('injected second rename failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      return realRename(...args);
    });
    const realLink: typeof fs.link = fs.link.bind(fs);
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.old')) {
        const error = new Error('hard links unsupported') as NodeJS.ErrnoException;
        error.code = linkErrorCode;
        throw error;
      }
      return realLink(...args);
    });

    await expect(markCurrentCatalogCacheEntryValidated(
      written,
      env,
      new Date(Date.now() + 100).toISOString(),
    )).rejects.toMatchObject({ code: 'EIO' });
    renameSpy.mockRestore();
    linkSpy.mockRestore();

    await expect(fs.readJson(indexPath)).resolves.toEqual(
      publishConcurrentIndex ? concurrentIndex : oldIndex,
    );
    const selectorsDir = path.dirname(indexPath);
    expect((await fs.readdir(selectorsDir)).filter((name) => name.endsWith('.old'))).toEqual([]);
  });

  it('keeps the displaced index when all ownership-safe restore methods fail', async () => {
    const { cacheRoot, env, sourceRoot, identity } = await makeCurrentCatalogCacheFixture();
    const written = await writeCurrentCatalogCacheEntry({ ...identity, sourceRoot, env });
    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(cacheRoot);
    const oldIndex = await fs.readJson(indexPath);
    const realRename: typeof fs.rename = fs.rename.bind(fs);
    let stagedPublishAttempts = 0;
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const source = String(args[0]);
      const target = String(args[1]);
      if (target === indexPath && source.endsWith('.tmp')) {
        stagedPublishAttempts += 1;
        const error = new Error('injected rename failure') as NodeJS.ErrnoException;
        error.code = stagedPublishAttempts === 1 ? 'EPERM' : 'EIO';
        throw error;
      }
      return realRename(...args);
    });
    const linkSpy = vi.spyOn(fs, 'link').mockImplementation(async () => {
      const error = new Error('hard links unsupported') as NodeJS.ErrnoException;
      error.code = 'ENOSYS';
      throw error;
    });
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async () => {
      const error = new Error('exclusive copy unavailable') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    await expect(markCurrentCatalogCacheEntryValidated(written, env)).rejects.toMatchObject({
      code: 'EACCES',
    });
    renameSpy.mockRestore();
    linkSpy.mockRestore();
    copySpy.mockRestore();

    await expect(fs.pathExists(indexPath)).resolves.toBe(false);
    const selectorsDir = path.dirname(indexPath);
    const displacedNames = (await fs.readdir(selectorsDir)).filter((name) => name.endsWith('.old'));
    expect(displacedNames).toHaveLength(1);
    await expect(fs.readJson(path.join(selectorsDir, displacedNames[0]!))).resolves.toEqual(oldIndex);
  });

  it('keeps current catalog cache partitioned by selector and channel', async () => {
    const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-current-catalog-cache-'));
    tempDirs.push(cacheRoot);
    const env = {
      ...process.env,
      AW_HOME: cacheRoot,
    };
    const sourceRoot = path.join(cacheRoot, 'beta-source-catalog');
    await fs.ensureDir(sourceRoot);
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), { version: 1 }, { spaces: 2 });

    await writeCurrentCatalogCacheEntry({
      selector: {
        kind: 'default',
        cliVersion: '1.0.0-beta.1',
        defaultChannel: 'beta',
      },
      channel: 'beta',
      catalogVersion: '1.0.0-beta.1',
      minAwVersion: '1.0.0-beta.1',
      schemaVersion: 1,
      historySchemaVersion: 1,
      sidecarIntegrity: 'sha512-sidecar-beta',
      fullIntegrity: 'sha512-full-beta',
      sourceRoot,
      env,
    });

    await expect(readCurrentCatalogCacheEntry({
      selector: {
        kind: 'default',
        cliVersion: '1.0.0',
        defaultChannel: 'latest',
      },
      channel: 'latest',
      catalogVersion: '1.0.0',
      minAwVersion: '1.0.0',
      schemaVersion: 1,
      historySchemaVersion: 1,
      sidecarIntegrity: 'sha512-sidecar-beta',
      fullIntegrity: 'sha512-full-beta',
    }, env)).resolves.toBeNull();
  });

  it('refreshes ~/.aw from platform-filtered embedded bundles without breaking layout validation', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace((manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
    });
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
    await expect(
      fs.pathExists(path.join(awHome, 'plugins', 'git-commit', '.claude-plugin')),
    ).resolves.toBe(false);
    await expect(
      fs.pathExists(path.join(awHome, 'plugins', 'git-commit', 'claude')),
    ).resolves.toBe(false);

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed for filtered refresh\n',
      'utf8',
    );
    await ensureLocalMarketplace(process.env);

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('initializes ~/.aw from the embedded bundle and preserves a valid ledger on refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeJson(
      path.join(awHome, 'installed.json'),
      {
        version: 1,
        ledgerState: {
          status: 'available',
          degradedAt: null,
          reason: null,
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {},
          },
        },
      },
      { spaces: 2 },
    );

    const beforeFingerprint = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    const currentCatalogRoot = path.join(embeddedRoot, '.catalog', 'full');

    await fs.writeFile(
      path.join(currentCatalogRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed\n',
      'utf8',
    );

    await initializeLocalMarketplace({ force: true, env: process.env });

    const afterConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    const preservedLedger = await readJsonFile(path.join(awHome, 'installed.json'));

    expect(afterConfig.bundleFingerprint).not.toBe(beforeFingerprint.bundleFingerprint);
    expect(preservedLedger).toMatchObject({
      ledgerState: {
        status: 'available',
      },
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
        },
      },
    });
  });

  it('falls back to the current catalog cache source when embedded bundles are unavailable', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    const missingEmbeddedRoot = path.join(awHome, 'missing-plugins-dist');
    const sidecarRoot = path.join(embeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(embeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json'));
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));
    setEmbeddedPluginsRootOverrideForTests(missingEmbeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
    await expect(readJsonFile<{ bundleFingerprint: string }>(path.join(awHome, 'config.json'))).resolves.toMatchObject({
      bundleFingerprint: await calculateBundleFingerprint(fullRoot),
    });
  });

  it('preserves Codex project-managed ledger records without shared native refs', async () => {
    const { repoRoot, awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const projectKey = await fs.realpath(repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              projectKey,
              capabilitySnapshot: {
                requiresNativePlugin: false,
                hasRepoManagedArtifacts: true,
                projectManagedKinds: ['skill'],
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    await initializeLocalMarketplace({ force: true, env: process.env });

    const preservedLedger = await readJsonFile<unknown>(path.join(awHome, 'installed.json'));
    expect(preservedLedger).toMatchObject({
      plugins: {
        'git-commit': {
          platforms: {
            codex: {
              projectScopes: {
                [projectKey]: {
                  projectKey,
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    projectManagedKinds: ['skill'],
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(
      (preservedLedger as InstalledLedger).plugins['git-commit'].platforms.codex?.sharedNativeRefs,
    ).toBeUndefined();
  });

  it('preserves dependency metadata across local marketplace refreshes', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const ledger = createAvailableLedger();
    ledger.plugins['workflow-pack'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-05-06T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installSource: {
              kind: 'explicit',
              explicitlyRequested: true,
              allowsUnusedCleanup: false,
            },
            dependencyEdges: [
              {
                dependency: {
                  plugin: 'git-commit',
                  platform: 'codex',
                  scope: 'user',
                  projectKey: null,
                },
                declaration: {
                  name: 'git-commit',
                  target: {
                    scope: 'user',
                  },
                  when: {
                    platforms: ['codex'],
                  },
                },
              },
            ],
          },
        },
      },
    };
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-05-06T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installSource: {
              kind: 'dependency',
              explicitlyRequested: false,
              allowsUnusedCleanup: true,
            },
            dependencyEdges: [],
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed with dependency metadata\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: true, env: process.env });

    const preservedLedger = await readInstalledLedger(process.env);
    expect(hasInstalledLedgerDependencyMetadata(preservedLedger)).toBe(true);
    expect(preservedLedger.plugins['workflow-pack']?.platforms.codex?.userScope).toMatchObject({
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
        allowsUnusedCleanup: false,
      },
      dependencyEdges: [
        {
          dependency: {
            plugin: 'git-commit',
            platform: 'codex',
            scope: 'user',
            projectKey: null,
          },
          declaration: {
            name: 'git-commit',
          },
        },
      ],
    });
  });

  it('preserves AW-managed plugin config during local marketplace rebuilds', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.outputJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
      {
        token: 'secret',
      },
      { spaces: 2 },
    );

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed again\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(fs.readJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toEqual({
      token: 'secret',
    });
  });

  it('preserves install-state runtime state during local marketplace rebuilds', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await Promise.all([
      fs.outputJson(
        path.join(awHome, 'dependency-index', 'index.json'),
        {
          version: 1,
          updatedAt: '2026-05-07T00:00:00.000Z',
          records: [],
        },
        { spaces: 2 },
      ),
      fs.outputFile(
        path.join(awHome, 'lifecycle-runtimes', 'codex', 'user', 'user', 'git-commit.123456789abc', 'runtime-a', 'bundle', 'marker.txt'),
        'runtime',
        'utf8',
      ),
      fs.outputJson(
        path.join(awHome, 'shared-runtime-owners', 'codex', 'git-commit.123456789abc.json'),
        {
          version: 1,
          pluginName: 'git-commit',
          platform: 'codex',
          owner: {
            plugin: 'git-commit',
            platform: 'codex',
            scope: 'user',
          },
          ownerRecordPath: '/tmp/record.json',
          ownerRecordDigest: 'sha256:record',
          preference: 'manual',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
        { spaces: 2 },
      ),
    ]);

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed for install-state preserve\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(fs.readJson(
      path.join(awHome, 'dependency-index', 'index.json'),
    )).resolves.toMatchObject({
      records: [],
    });
    await expect(fs.readFile(
      path.join(awHome, 'lifecycle-runtimes', 'codex', 'user', 'user', 'git-commit.123456789abc', 'runtime-a', 'bundle', 'marker.txt'),
      'utf8',
    )).resolves.toBe('runtime');
    await expect(fs.readJson(
      path.join(awHome, 'shared-runtime-owners', 'codex', 'git-commit.123456789abc.json'),
    )).resolves.toMatchObject({
      pluginName: 'git-commit',
      preference: 'manual',
    });
  });

  it('preserves a validated catalog cache across a real ensureLocalMarketplace rebuild without a second cache copy', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const sidecarRoot = path.join(embeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(embeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CLI_VERSION: manifest.catalogVersion,
    };
    setCatalogPackageSourceForTests(createStaticCatalogPackageSource({
      manifest,
      sidecarRoot,
      fullRoot,
      channel: manifest.channel,
      version: manifest.catalogVersion,
    }));
    const seeded = await pluginCatalogModule.resolveCurrentCatalog(env);
    expect(seeded.source).toBe('remote');
    await ensureLocalMarketplace(env, undefined, {
      ...seeded,
      rootDir: embeddedRoot,
      source: 'embedded',
    });

    const indexPath = await getOnlyCurrentCatalogCacheIndexPath(awHome);
    const entryMetadataPath = path.join(path.dirname(seeded.rootDir), 'entry.json');
    const cachedManifestPath = path.join(seeded.rootDir, 'catalog-manifest.json');
    const originalBytes = await Promise.all([
      fs.readFile(indexPath),
      fs.readFile(entryMetadataPath),
      fs.readFile(cachedManifestPath),
    ]);
    const initialConfig = await readJsonFile<{ bundleFingerprint: string }>(
      path.join(awHome, 'config.json'),
    );
    expect(initialConfig.bundleFingerprint).not.toBe(await calculateBundleFingerprint(seeded.rootDir));

    const copiedCacheSources: string[] = [];
    const realCopy: typeof fs.copy = fs.copy.bind(fs);
    const copySpy = vi.spyOn(fs, 'copy').mockImplementation(async (...args) => {
      if (path.basename(String(args[0])) === 'catalog-cache') {
        copiedCacheSources.push(String(args[0]));
      }
      return realCopy(...args);
    });
    await expect(ensureLocalMarketplace(env, undefined, seeded)).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    copySpy.mockRestore();

    expect(copiedCacheSources).toEqual([path.join(awHome, 'catalog-cache')]);
    await expect(Promise.all([
      fs.readFile(indexPath),
      fs.readFile(entryMetadataPath),
      fs.readFile(cachedManifestPath),
    ])).resolves.toEqual(originalBytes);

    let remoteCalls = 0;
    const failRemote = async (): Promise<never> => {
      remoteCalls += 1;
      throw new Error('catalog cache regression unexpectedly accessed remote');
    };
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: failRemote,
      resolveIdentityByVersion: failRemote,
      downloadArchive: failRemote,
    });
    clearCurrentCatalogResolutionMemoForTests();
    await expect(pluginCatalogModule.resolveCurrentCatalog(env, {
      freshnessPolicy: 'cacheFirst',
    })).resolves.toMatchObject({
      source: 'cache',
      catalogVersion: manifest.catalogVersion,
      cacheState: { state: 'fresh' },
    });
    expect(remoteCalls).toBe(0);

    const cacheEntry = await readCurrentCatalogCacheEntryBySelector(seeded.selector!, env);
    expect(cacheEntry?.metadata.version).toBe(2);
    const lockProbe = await acquireCurrentCatalogCacheLease(env);
    const catalogCacheLockPath = lockProbe.lockPath;
    await lockProbe.release();
    let cacheCopyFinished!: () => void;
    const cacheCopied = new Promise<void>((resolve) => {
      cacheCopyFinished = resolve;
    });
    let releaseRebuild!: () => void;
    const rebuildReleased = new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    const cacheCopySpy = vi.spyOn(fs, 'copy').mockImplementation(async (...args) => {
      const result = await realCopy(...args);
      if (path.basename(String(args[0])) === 'catalog-cache') {
        cacheCopyFinished();
        await rebuildReleased;
      }
      return result;
    });
    const rebuild = initializeLocalMarketplace({ force: true, env, catalogResolution: seeded });
    await cacheCopied;

    let writerWaited!: () => void;
    const writerObservedHeldLock = new Promise<void>((resolve) => {
      writerWaited = resolve;
    });
    const realMkdir: typeof fs.mkdir = fs.mkdir.bind(fs);
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockImplementation(async (...args) => {
      try {
        return await realMkdir(...args);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'EEXIST' &&
          path.resolve(String(args[0])) === path.resolve(catalogCacheLockPath)
        ) {
          writerWaited();
        }
        throw error;
      }
    });
    const writers = Array.from({ length: 3 }, (_, index) => writeCurrentCatalogCacheEntry({
      selector: cacheEntry!.metadata.selector,
      channel: cacheEntry!.metadata.channel,
      catalogVersion: cacheEntry!.metadata.catalogVersion,
      minAwVersion: cacheEntry!.metadata.minAwVersion,
      schemaVersion: cacheEntry!.metadata.schemaVersion,
      historySchemaVersion: cacheEntry!.metadata.historySchemaVersion,
      sidecarIntegrity: cacheEntry!.metadata.sidecarIntegrity,
      fullIntegrity: `${cacheEntry!.metadata.fullIntegrity}-after-copy-${index}`,
      sourceRoot: cacheEntry!.rootDir,
      env,
    }));
    await writerObservedHeldLock;
    releaseRebuild();
    await rebuild;
    const writtenAfterCopy = await Promise.all(writers);
    cacheCopySpy.mockRestore();
    mkdirSpy.mockRestore();

    expect(new Set(writtenAfterCopy.map((entry) => entry.cacheKey)).size).toBe(3);
    await expect(Promise.all(writtenAfterCopy.map((entry) => fs.pathExists(entry.rootDir))))
      .resolves.toEqual([true, true, true]);
    const selectedAfterCopy = await readCurrentCatalogCacheEntryBySelector(seeded.selector!, env);
    expect(writtenAfterCopy.map((entry) => entry.cacheKey)).toContain(selectedAfterCopy?.cacheKey);

    clearCurrentCatalogResolutionMemoForTests();
    await expect(pluginCatalogModule.resolveCurrentCatalog(env, {
      freshnessPolicy: 'cacheFirst',
    })).resolves.toMatchObject({
      source: 'cache',
      catalogVersion: manifest.catalogVersion,
    });
    expect(remoteCalls).toBe(0);

    const legacyMetadata = await fs.readJson(selectedAfterCopy!.metadataPath) as Record<string, unknown>;
    delete legacyMetadata.publicationId;
    await fs.writeJson(
      selectedAfterCopy!.metadataPath,
      { ...legacyMetadata, version: 1 },
      { spaces: 2 },
    );
    await fs.remove(indexPath);
    let legacyCopyFinished!: () => void;
    const legacyCacheCopied = new Promise<void>((resolve) => {
      legacyCopyFinished = resolve;
    });
    let releaseLegacyRebuild!: () => void;
    const legacyRebuildReleased = new Promise<void>((resolve) => {
      releaseLegacyRebuild = resolve;
    });
    const legacyCopySpy = vi.spyOn(fs, 'copy').mockImplementation(async (...args) => {
      const result = await realCopy(...args);
      if (path.basename(String(args[0])) === 'catalog-cache') {
        legacyCopyFinished();
        await legacyRebuildReleased;
      }
      return result;
    });
    const legacyRebuild = initializeLocalMarketplace({ force: true, env, catalogResolution: seeded });
    await legacyCacheCopied;
    await expect(readCurrentCatalogCacheEntryBySelector(seeded.selector!, env)).resolves.toMatchObject({
      cacheKey: selectedAfterCopy!.cacheKey,
      metadata: { version: 1 },
    });
    await expect(fs.pathExists(indexPath)).resolves.toBe(false);
    releaseLegacyRebuild();
    await legacyRebuild;
    legacyCopySpy.mockRestore();
    await expect(readCurrentCatalogCacheEntryBySelector(seeded.selector!, env)).resolves.toMatchObject({
      cacheKey: selectedAfterCopy!.cacheKey,
      metadata: { version: 1 },
    });
    await expect(fs.pathExists(indexPath)).resolves.toBe(false);

    clearCurrentCatalogResolutionMemoForTests();
    await expect(pluginCatalogModule.resolveCurrentCatalog(env, {
      freshnessPolicy: 'cacheFirst',
    })).resolves.toMatchObject({ source: 'cache' });
    expect(remoteCalls).toBe(0);
  });

  it('keeps an extracted remote archive stable across rebuild and publishes it afterward', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const sidecarRoot = path.join(embeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(embeddedRoot, '.catalog', 'full');
    const manifest = await fs.readJson(path.join(sidecarRoot, 'catalog-manifest.json')) as {
      channel: 'latest' | 'beta';
      catalogVersion: string;
    };
    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CLI_VERSION: manifest.catalogVersion,
    };
    await initializeLocalMarketplace({
      force: true,
      env,
      catalogResolution: { rootDir: embeddedRoot, source: 'embedded' },
    });

    let extractedArchiveReady!: (paths: { tempRoot: string; packageRoot: string }) => void;
    const extractedArchive = new Promise<{ tempRoot: string; packageRoot: string }>((resolve) => {
      extractedArchiveReady = resolve;
    });
    let releaseArchive!: () => void;
    const archiveReleased = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    setCatalogPackageSourceForTests({
      resolveIdentityByDistTag: async (packageName: string) => ({
        packageName,
        version: manifest.catalogVersion,
        integrity: packageName === '@yiliang/aw-plugins-manifest'
          ? 'sha512-sidecar-extracted'
          : 'sha512-full-extracted',
        requestedDistTag: manifest.channel,
      }),
      resolveIdentityByVersion: async (packageName: string) => ({
        packageName,
        version: manifest.catalogVersion,
        integrity: 'sha512-full-extracted',
      }),
      downloadArchive: async (identity: { packageName: string }) => {
        const sourceRoot = identity.packageName === '@yiliang/aw-plugins-manifest'
          ? sidecarRoot
          : fullRoot;
        if (identity.packageName === '@yiliang/aw-plugins-manifest') {
          return {
            identity,
            manifestText: await fs.readFile(path.join(sourceRoot, 'catalog-manifest.json'), 'utf8'),
            rawManifest: manifest,
            packageRoot: sourceRoot,
            materialize: async () => {},
            dispose: async () => {},
          };
        }

        const stagingParent = resolveCurrentCatalogCacheStagingDir(env);
        await fs.ensureDir(stagingParent);
        const tempRoot = await fs.mkdtemp(path.join(stagingParent, 'package-'));
        const packageRoot = path.join(tempRoot, 'extract', 'package');
        await fs.copy(sourceRoot, packageRoot);
        extractedArchiveReady({ tempRoot, packageRoot });
        await archiveReleased;
        return {
          identity,
          manifestText: await fs.readFile(path.join(packageRoot, 'catalog-manifest.json'), 'utf8'),
          rawManifest: manifest,
          packageRoot,
          materialize: async (targetRoot: string) => fs.copy(packageRoot, targetRoot),
          dispose: async () => fs.remove(tempRoot),
        };
      },
    });

    clearCurrentCatalogResolutionMemoForTests();
    const remoteResolution = pluginCatalogModule.resolveCurrentCatalog(env);
    const extracted = await extractedArchive;
    expect(path.dirname(resolveCurrentCatalogCacheStagingDir(env))).toBe(path.join(
      path.dirname(awHome),
      '.aw-local-marketplace-staging',
    ));
    expect(extracted.tempRoot.startsWith(`${awHome}${path.sep}`)).toBe(false);

    await initializeLocalMarketplace({
      force: true,
      env,
      catalogResolution: { rootDir: embeddedRoot, source: 'embedded' },
    });
    await expect(fs.pathExists(extracted.packageRoot)).resolves.toBe(true);
    releaseArchive();
    const published = await remoteResolution;
    await expect(fs.pathExists(published.rootDir)).resolves.toBe(true);

    for (let attempt = 0; attempt < 20 && await fs.pathExists(extracted.tempRoot); attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    await expect(fs.pathExists(extracted.tempRoot)).resolves.toBe(false);
    await expect(fs.readdir(resolveCurrentCatalogCacheStagingDir(env))).resolves.toEqual([]);
  });

  it('allows marketplace rebuilds when catalog cache state is missing or damaged', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = { ...process.env, AW_HOME: awHome };
    const packageInfo = await readCliPackageInfo();
    const catalogResolution: CatalogResolution = {
      rootDir: embeddedRoot,
      source: 'embedded',
      selector: {
        kind: 'default',
        cliVersion: packageInfo.version,
        defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
      },
    };

    await initializeLocalMarketplace({ force: true, env, catalogResolution });
    await fs.remove(path.join(awHome, 'catalog-cache'));
    await expect(initializeLocalMarketplace({ force: true, env, catalogResolution }))
      .resolves.toMatchObject({ changed: true });
    await expect(fs.pathExists(path.join(awHome, 'catalog-cache'))).resolves.toBe(false);

    const damagedPath = path.join(awHome, 'catalog-cache', 'selectors', 'damaged.json');
    await fs.outputFile(damagedPath, '{invalid json', 'utf8');
    await expect(initializeLocalMarketplace({ force: true, env, catalogResolution }))
      .resolves.toMatchObject({ changed: true });
    await expect(fs.readFile(damagedPath, 'utf8')).resolves.toBe('{invalid json');
  });

  it('restores the original catalog cache when atomic marketplace replacement rolls back', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = { ...process.env, AW_HOME: awHome };
    const packageInfo = await readCliPackageInfo();
    const catalogResolution: CatalogResolution = {
      rootDir: embeddedRoot,
      source: 'embedded',
      selector: {
        kind: 'default',
        cliVersion: packageInfo.version,
        defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
      },
    };
    await initializeLocalMarketplace({ force: true, env, catalogResolution });
    const cacheMarkerPath = path.join(awHome, 'catalog-cache', 'rollback-marker.bin');
    const cacheMarker = Buffer.from([0, 1, 2, 3, 255]);
    await fs.outputFile(cacheMarkerPath, cacheMarker);

    const realMove: typeof fs.move = fs.move.bind(fs);
    const moveSpy = vi.spyOn(fs, 'move').mockImplementation(async (...args) => {
      const source = String(args[0]);
      const target = String(args[1]);
      if (source.includes(`${path.sep}.aw-local-marketplace-staging${path.sep}`) && target === awHome) {
        throw new Error('injected marketplace publish failure');
      }
      return realMove(...args);
    });

    await expect(initializeLocalMarketplace({ force: true, env, catalogResolution }))
      .rejects.toThrow('injected marketplace publish failure');
    moveSpy.mockRestore();
    await expect(fs.readFile(cacheMarkerPath)).resolves.toEqual(cacheMarker);
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('restores the complete original marketplace when post-publish runtime preservation fails', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = { ...process.env, AW_HOME: awHome };
    const packageInfo = await readCliPackageInfo();
    const catalogResolution: CatalogResolution = {
      rootDir: embeddedRoot,
      source: 'embedded',
      selector: {
        kind: 'default',
        cliVersion: packageInfo.version,
        defaultChannel: packageInfo.version.includes('-') ? 'beta' : 'latest',
      },
    };
    await initializeLocalMarketplace({ force: true, env, catalogResolution });
    const cacheMarkerPath = path.join(awHome, 'catalog-cache', 'rollback-marker.bin');
    const runtimeMarkerPath = path.join(awHome, 'plugin-config', 'rollback', 'marker.bin');
    const pluginPath = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'SKILL.md',
    );
    const originalPluginBytes = await fs.readFile(pluginPath);
    await fs.outputFile(cacheMarkerPath, Buffer.from('catalog-before-failure'));
    await fs.outputFile(runtimeMarkerPath, Buffer.from('runtime-before-failure'));
    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# replacement that must roll back\n',
      'utf8',
    );

    const failure = new Error('injected post-publish runtime copy failure');
    const realCopy: typeof fs.copy = fs.copy.bind(fs);
    const copySpy = vi.spyOn(fs, 'copy').mockImplementation(async (...args) => {
      const source = String(args[0]);
      if (
        source.includes(`${path.sep}.aw-local-marketplace-backups${path.sep}`) &&
        path.basename(source) === 'plugin-config'
      ) {
        throw failure;
      }
      return realCopy(...args);
    });

    await expect(initializeLocalMarketplace({ force: true, env, catalogResolution }))
      .rejects.toBe(failure);
    copySpy.mockRestore();

    await expect(fs.readFile(cacheMarkerPath, 'utf8')).resolves.toBe('catalog-before-failure');
    await expect(fs.readFile(runtimeMarkerPath, 'utf8')).resolves.toBe('runtime-before-failure');
    await expect(fs.readFile(pluginPath)).resolves.toEqual(originalPluginBytes);
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
    const backupRoot = path.join(path.dirname(awHome), '.aw-local-marketplace-backups');
    await expect(fs.readdir(backupRoot)).resolves.toEqual([]);
    const stagingRoot = path.join(path.dirname(awHome), '.aw-local-marketplace-staging');
    await expect(fs.readdir(stagingRoot)).resolves.toEqual([]);
    const leaseAfterRollback = await acquireCurrentCatalogCacheLease(env, { timeoutMs: 50 });
    await expect(leaseAfterRollback.release()).resolves.toBe(true);
    await expect(fs.pathExists(leaseAfterRollback.lockPath)).resolves.toBe(false);
  });

  it('preserves native recovery breadcrumbs during ensureLocalMarketplace refreshes', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const breadcrumb = await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      bundleFingerprint: 'sha256:bundle-a',
      env: process.env,
    });

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
      '# changed for recovery preserve\n',
      'utf8',
    );
    await ensureLocalMarketplace(process.env);

    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', process.env)).resolves.toEqual(breadcrumb);
  });

  it('preserves native recovery breadcrumbs during force init rebuilds', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      pluginVersion: '0.1.0',
      env: process.env,
    });

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(readCodexNativeRecoveryBreadcrumb('git-commit', process.env)).resolves.toMatchObject({
      pluginId: 'git-commit@aw',
      pluginVersion: '0.1.0',
    });
  });

  it('repairs a corrupted local marketplace layout during force init', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const marketplacePath = path.join(awHome, '.claude-plugin', 'marketplace.json');
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins[0].source = './plugins/broken';
    await fs.writeJson(marketplacePath, marketplace, { spaces: 2 });

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('requires confirmation when config.json is malformed during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).rejects.toThrow(
      '非交互环境不会自动覆盖',
    );
  });

  it('rebuilds ~/.aw when config.json uses an unsupported schema version during a non-force refresh', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const configPath = path.join(awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.version = 3;
    await fs.writeJson(configPath, config, { spaces: 2 });

    await expect(initializeLocalMarketplace({ force: false, env: process.env })).resolves.toMatchObject({
      rootDir: awHome,
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('treats an invalid source manifest as an unhealthy local marketplace layout', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.writeFile(
      path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );

    await expect(validateLocalMarketplaceLayout(awHome)).rejects.toThrow();
  });

  it('returns a degraded ledger when installed.json contains malformed JSON', async () => {
    const { awHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":', 'utf8');

    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
  });

  it('writes a degraded ledger when the previous installed.json is missing or invalid', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.ensureDir(awHome);
    await fs.writeFile(path.join(awHome, 'installed.json'), '{"version":"broken"}', 'utf8');

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(readJsonFile(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    });
    await expect(calculateBundleFingerprint(awHome)).resolves.toMatch(/^sha256:/);
  });

  it('ignores runtime state contents when calculating bundle fingerprints', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const before = await calculateBundleFingerprint(awHome);

    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      reason: 'native install completed',
      nativeWrittenAt: '2026-05-04T09:00:00.000Z',
      env: process.env,
    });

    const afterWrite = await calculateBundleFingerprint(awHome);
    expect(afterWrite).toBe(before);

    await Promise.all([
      fs.writeFile(
        getCodexNativeRecoveryBreadcrumbPath('git-commit', process.env),
        JSON.stringify({
          version: 1,
          platform: 'codex',
          scope: 'user',
          marketplaceName: 'aw',
          pluginName: 'git-commit',
          pluginId: 'git-commit@aw',
          state: 'cleanup_failed',
          reason: 'changed diagnostics',
          nativeWrittenAt: '2026-05-04T09:00:00.000Z',
          updatedAt: '2026-05-04T09:05:00.000Z',
        }, null, 2),
        'utf8',
      ),
      fs.outputJson(
        path.join(awHome, 'dependency-index', 'index.json'),
        {
          version: 1,
          updatedAt: '2026-05-07T00:00:00.000Z',
          records: [],
        },
        { spaces: 2 },
      ),
      fs.outputFile(
        path.join(awHome, 'lifecycle-runtimes', 'codex', 'user', 'user', 'git-commit.123456789abc', 'runtime-a', 'bundle', 'marker.txt'),
        'runtime changed\n',
        'utf8',
      ),
      fs.outputJson(
        path.join(awHome, 'shared-runtime-owners', 'codex', 'git-commit.123456789abc.json'),
        {
          version: 1,
          pluginName: 'git-commit',
          platform: 'codex',
          owner: {
            plugin: 'git-commit',
            platform: 'codex',
            scope: 'user',
          },
          ownerRecordPath: '/tmp/record.json',
          ownerRecordDigest: 'sha256:record',
          preference: 'manual',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
        { spaces: 2 },
      ),
    ]);

    await expect(calculateBundleFingerprint(awHome)).resolves.toBe(before);
  });

  it('accepts runtime state directories when validating local marketplace layout', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await Promise.all([
      fs.outputFile(
        getCodexNativeRecoveryBreadcrumbPath('git-commit', process.env),
        'not a bundle source',
        'utf8',
      ),
      fs.outputJson(
        path.join(awHome, 'dependency-index', 'index.json'),
        {
          version: 1,
          updatedAt: '2026-05-07T00:00:00.000Z',
          records: [],
        },
        { spaces: 2 },
      ),
      fs.outputFile(
        path.join(awHome, 'lifecycle-runtimes', 'codex', 'user', 'user', 'git-commit.123456789abc', 'runtime-a', 'bundle', 'marker.txt'),
        'runtime',
        'utf8',
      ),
      fs.outputJson(
        path.join(awHome, 'shared-runtime-owners', 'codex', 'git-commit.123456789abc.json'),
        {
          version: 1,
          pluginName: 'git-commit',
          platform: 'codex',
          owner: {
            plugin: 'git-commit',
            platform: 'codex',
            scope: 'user',
          },
          ownerRecordPath: '/tmp/record.json',
          ownerRecordDigest: 'sha256:record',
          preference: 'manual',
          updatedAt: '2026-05-07T00:00:00.000Z',
        },
        { spaces: 2 },
      ),
    ]);

    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('replays available ledger skill trigger preferences during force rebuild', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, true);
    const localManifestPath = path.join(awHome, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
    const localManifest = await fs.readJson(localManifestPath);
    localManifest.skillTriggers.commit.allowDynamicTrigger = false;
    await fs.writeJson(localManifestPath, localManifest, { spaces: 2 });

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).not.toContain('degraded');
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
    expect(await listSkillBackupDirs(awHome)).toEqual([]);
    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
      },
    });
  });

  it('does not replay manifest-declared codex.skill entries back into ~/.aw during rebuild', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace((manifest) => {
      manifest.skillTriggers = {
        ...manifest.skillTriggers,
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      };
      manifest.artifacts = {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'generated-commit',
        }],
      };
    });
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: false,
              hasRepoManagedArtifacts: true,
              projectManagedKinds: ['skill'],
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, true);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
    await expect(fs.pathExists(path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
      'agents',
      'openai.yaml',
    ))).resolves.toBe(false);
    expect(await listSkillBackupDirs(awHome)).toEqual([]);
    expect(result.warnings.join('\n')).not.toContain('跳过 skill trigger 偏好 replay');
  });

  it('does not add a Codex skills declaration when staging dynamic-only plugins without runtime skills', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace(
      (manifest) => {
        delete manifest.skills;
        manifest.skillTriggers = {
          'generated-commit': {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        };
        manifest.artifacts = {
          targets: [{
            id: 'commit-skill',
            platform: 'codex',
            scopes: ['user'],
            target: 'codex.skill',
            projectManagedKind: 'skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'generated-commit',
          }],
        };
      },
      async (repoRoot) => {
        await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', 'skills'));
      },
    );
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });

    await syncLocalMarketplaceCodexDynamicSkills({
      rootDir: awHome,
      pluginName: 'git-commit',
      skillKeys: ['generated-commit'],
    });

    await expect(fs.pathExists(path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
    ))).resolves.toBe(false);
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.not.toHaveProperty('skills');
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('adds a Codex skills declaration only for staged native marketplaces that materialize runtime dynamic skills', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace(
      (manifest) => {
        delete manifest.skills;
        manifest.skillTriggers = {
          'generated-commit': {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        };
        manifest.artifacts = {
          targets: [{
            id: 'commit-skill',
            platform: 'codex',
            scopes: ['user'],
            target: 'codex.skill',
            projectManagedKind: 'skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'generated-commit',
          }],
        };
      },
      async (repoRoot) => {
        await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', 'skills'));
      },
    );
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await fs.outputFile(path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
      'SKILL.md',
    ), '# Generated\n', 'utf8');
    await fs.outputFile(path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
      'agents',
      'openai.yaml',
    ), 'policy:\n  allow_implicit_invocation: true\n', 'utf8');

    await materializeStagedMarketplaceCodexDynamicSkills({
      rootDir: awHome,
      pluginName: 'git-commit',
      skillKeys: ['generated-commit'],
    });

    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({ skills: './codex/skills' });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });

  it('preserves migrated static Codex skills in custom roots when historical dynamic sync keys are replayed', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });

    const pluginRoot = path.join(awHome, 'plugins', 'git-commit');
    const sourceManifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
    const codexManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    const sourceManifest = await fs.readJson(sourceManifestPath);
    await fs.writeJson(sourceManifestPath, {
      ...sourceManifest,
      skills: './custom-skills',
      skillTriggers: {
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      },
    }, { spaces: 2 });

    const staticSourceSkillRoot = path.join(pluginRoot, 'custom-skills', 'generated-commit');
    await fs.outputFile(path.join(staticSourceSkillRoot, 'SKILL.md'), '# Static Commit\n', 'utf8');
    await fs.outputFile(
      path.join(staticSourceSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const codexManifest = await fs.readJson(codexManifestPath);
    await fs.writeJson(codexManifestPath, {
      ...codexManifest,
      skills: './codex/custom-skills',
    }, { spaces: 2 });

    const mirroredSkillRoot = path.join(pluginRoot, 'codex', 'custom-skills', 'generated-commit');
    await fs.outputFile(path.join(mirroredSkillRoot, 'SKILL.md'), '# Stale Dynamic Commit\n', 'utf8');
    await fs.outputFile(
      path.join(mirroredSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );
    await fs.remove(path.join(pluginRoot, 'codex', 'skills', 'generated-commit'));

    await syncLocalMarketplaceCodexDynamicSkills({
      rootDir: awHome,
      pluginName: 'git-commit',
      skillKeys: ['generated-commit'],
    });

    await expect(fs.readFile(path.join(mirroredSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('# Static Commit\n');
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({ skills: './codex/custom-skills' });
  });

  it('replays retained Codex user dynamic skills without adding a static skills root to the platform manifest', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace(
      (manifest) => {
        delete manifest.skills;
        manifest.skillTriggers = {
          'generated-commit': {
            defaultTrigger: 'auto',
            allowDynamicTrigger: true,
          },
        };
        manifest.artifacts = {
          targets: [{
            id: 'commit-skill',
            platform: 'codex',
            scopes: ['user'],
            target: 'codex.skill',
            projectManagedKind: 'skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'generated-commit',
          }],
        };
      },
      async (repoRoot) => {
        await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', 'skills'));
      },
    );
    const codexHome = path.join(path.dirname(awHome), 'codex-home');
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const dynamicSkillRoot = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
    );
    await fs.outputFile(path.join(dynamicSkillRoot, 'SKILL.md'), '# Generated\n', 'utf8');
    await fs.outputFile(
      path.join(dynamicSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const location: PluginLocation = {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    };
    const recordId = createRecordId(location);
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId,
      record: {
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        installedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:generated-manifest',
          bundleFingerprint: 'sha256:generated-bundle',
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'codex',
          path: dynamicSkillRoot,
          artifactKey: 'generated-commit',
          id: 'commit-skill',
          target: 'codex.skill',
          state: 'present',
        }],
        dependencyEdges: [],
      },
    };
    await fs.outputJson(
      path.join(codexHome, '.agent-workflows', 'records', `${recordId}.json`),
      recordFile,
      { spaces: 2 },
    );

    await initializeLocalMarketplace({ force: true, env: process.env });

    await expect(fs.pathExists(path.join(dynamicSkillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.not.toHaveProperty('skills');
  });

  it('replays retained Codex user dynamic skills into custom Codex skills roots during rebuild', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace((manifest) => {
      manifest.skillTriggers = {
        ...manifest.skillTriggers,
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      };
      manifest.artifacts = {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'generated-commit',
        }],
      };
    });
    const currentCatalogPluginRoot = path.join(
      embeddedRoot,
      '.catalog',
      'full',
      'plugins',
      'git-commit',
    );
    await fs.copy(
      path.join(currentCatalogPluginRoot, 'codex', 'skills'),
      path.join(currentCatalogPluginRoot, 'codex', 'custom-skills'),
    );
    await fs.writeJson(
      path.join(currentCatalogPluginRoot, '.codex-plugin', 'plugin.json'),
      {
        ...(await fs.readJson(path.join(currentCatalogPluginRoot, '.codex-plugin', 'plugin.json'))),
        skills: './codex/custom-skills',
      },
      { spaces: 2 },
    );
    const codexHome = path.join(path.dirname(awHome), 'codex-home');
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const dynamicSkillRoot = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
    );
    await fs.outputFile(path.join(dynamicSkillRoot, 'SKILL.md'), '# Generated\n', 'utf8');
    await fs.outputFile(
      path.join(dynamicSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const location: PluginLocation = {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    };
    const recordId = createRecordId(location);
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId,
      record: {
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        installedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:generated-manifest',
          bundleFingerprint: 'sha256:generated-bundle',
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'codex',
          path: dynamicSkillRoot,
          artifactKey: 'generated-commit',
          id: 'commit-skill',
          target: 'codex.skill',
          state: 'present',
        }],
        dependencyEdges: [],
      },
    };
    await fs.outputJson(
      path.join(codexHome, '.agent-workflows', 'records', `${recordId}.json`),
      recordFile,
      { spaces: 2 },
    );

    await initializeLocalMarketplace({ force: true, env: process.env });

    const customSkillRoot = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'custom-skills',
      'generated-commit',
    );
    await expect(fs.readFile(path.join(dynamicSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Generated');
    await expect(fs.readFile(path.join(customSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toContain('# Generated');
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'git-commit', '.codex-plugin', 'plugin.json')),
    ).resolves.toMatchObject({ skills: './codex/custom-skills' });
  });

  it('skips retained Codex user dynamic skill records for plugins missing from the current catalog', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const codexHome = path.join(path.dirname(awHome), 'codex-home');
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const retiredSkillRoot = path.join(
      awHome,
      'plugins',
      'retired-plugin',
      'codex',
      'skills',
      'retired-skill',
    );
    await fs.outputFile(path.join(retiredSkillRoot, 'SKILL.md'), '# Retired\n', 'utf8');
    await fs.outputFile(
      path.join(retiredSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const location: PluginLocation = {
      plugin: 'retired-plugin',
      platform: 'codex',
      scope: 'user',
    };
    const recordId = createRecordId(location);
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId,
      record: {
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        installedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:retired-manifest',
          bundleFingerprint: 'sha256:retired-bundle',
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'codex',
          path: retiredSkillRoot,
          artifactKey: 'retired-skill',
          id: 'retired-skill',
          target: 'codex.skill',
          state: 'present',
        }],
        dependencyEdges: [],
      },
    };
    await fs.outputJson(
      path.join(codexHome, '.agent-workflows', 'records', `${recordId}.json`),
      recordFile,
      { spaces: 2 },
    );

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain(
      '跳过 user dynamic skill replay：current catalog 缺少 Codex plugin retired-plugin。',
    );
    await expect(fs.pathExists(path.join(awHome, 'plugins', 'retired-plugin'))).resolves.toBe(false);
  });

  it('skips retained Codex user dynamic skills removed from the current catalog manifest', async () => {
    const { repoRoot, awHome, embeddedRoot } = await makeWorkspace((manifest) => {
      manifest.skillTriggers = {
        ...manifest.skillTriggers,
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      };
      manifest.artifacts = {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'generated-commit',
        }],
      };
    });
    const codexHome = path.join(path.dirname(awHome), 'codex-home');
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const dynamicSkillRoot = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
    );
    await fs.outputFile(path.join(dynamicSkillRoot, 'SKILL.md'), '# Generated\n', 'utf8');
    await fs.outputFile(
      path.join(dynamicSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const location: PluginLocation = {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    };
    const recordId = createRecordId(location);
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId,
      record: {
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        installedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:generated-manifest',
          bundleFingerprint: 'sha256:generated-bundle',
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'codex',
          path: dynamicSkillRoot,
          artifactKey: 'generated-commit',
          id: 'commit-skill',
          target: 'codex.skill',
          state: 'present',
        }],
        dependencyEdges: [],
      },
    };
    await fs.outputJson(
      path.join(codexHome, '.agent-workflows', 'records', `${recordId}.json`),
      recordFile,
      { spaces: 2 },
    );

    await updateFixturePluginManifest(repoRoot, (manifest) => {
      delete manifest.artifacts;
      delete manifest.skillTriggers['generated-commit'];
    });
    const nextEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(nextEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(nextEmbeddedRoot);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain(
      '跳过 user dynamic skill replay：current catalog 不再为 user scope 声明 Codex dynamic skill git-commit/generated-commit。',
    );
    await expect(fs.pathExists(path.join(dynamicSkillRoot, 'SKILL.md'))).resolves.toBe(false);
  });

  it('skips retained Codex user dynamic skills when the current catalog keeps them project-only', async () => {
    const { repoRoot, awHome, embeddedRoot } = await makeWorkspace((manifest) => {
      manifest.skillTriggers = {
        ...manifest.skillTriggers,
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      };
      manifest.artifacts = {
        targets: [{
          id: 'commit-skill',
          platform: 'codex',
          scopes: ['user'],
          target: 'codex.skill',
          projectManagedKind: 'skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'generated-commit',
        }],
      };
    });
    const codexHome = path.join(path.dirname(awHome), 'codex-home');
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const dynamicSkillRoot = path.join(
      awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'generated-commit',
    );
    await fs.outputFile(path.join(dynamicSkillRoot, 'SKILL.md'), '# Generated\n', 'utf8');
    await fs.outputFile(
      path.join(dynamicSkillRoot, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );

    const location: PluginLocation = {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
    };
    const recordId = createRecordId(location);
    const recordFile: InstallRecordFile = {
      version: 2,
      recordId,
      record: {
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        installedAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
        source: {
          pluginVersion: '0.1.0',
          manifestDigest: 'sha256:generated-manifest',
          bundleFingerprint: 'sha256:generated-bundle',
        },
        installSource: {
          kind: 'explicit',
          explicitlyRequested: true,
        },
        artifacts: [{
          kind: 'skill',
          platform: 'codex',
          path: dynamicSkillRoot,
          artifactKey: 'generated-commit',
          id: 'commit-skill',
          target: 'codex.skill',
          state: 'present',
        }],
        dependencyEdges: [],
      },
    };
    await fs.outputJson(
      path.join(codexHome, '.agent-workflows', 'records', `${recordId}.json`),
      recordFile,
      { spaces: 2 },
    );

    await updateFixturePluginManifest(repoRoot, (manifest) => {
      manifest.artifacts.targets[0].scopes = ['project'];
    });
    const nextEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(nextEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(nextEmbeddedRoot);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain(
      '跳过 user dynamic skill replay：current catalog 不再为 user scope 声明 Codex dynamic skill git-commit/generated-commit。',
    );
    await expect(fs.pathExists(path.join(dynamicSkillRoot, 'SKILL.md'))).resolves.toBe(false);
  });

  it('ignores Codex project scope records when replaying the shared runtime winner', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
          projectScopes: {
            'project-a': {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
              skillTriggerWriteOrder: 2,
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, false);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
    expect(result.warnings.join('\n')).not.toContain('project-a');
  });

  it('uses the stable scope identity fallback when replaying old ledgers without write order', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
          projectScopes: {
            alpha: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
              },
              installOptions: {
                skillTriggerPreference: 'auto',
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, false);

    await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
  });

  it('does not replay Codex project-only preferences into ~/.aw during rebuild', async () => {
    const { repoRoot, awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    const projectKey = await fs.realpath(repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              projectKey,
              capabilitySnapshot: {
                requiresNativePlugin: false,
                hasRepoManagedArtifacts: true,
                projectManagedKinds: ['skill'],
              },
              installOptions: {
                skillTriggerPreference: 'manual',
              },
              skillTriggerWriteOrder: 3,
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await writeCodexAllowImplicitInvocation(awHome, true);

    await initializeLocalMarketplace({ force: true, env: process.env });

    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(true);
  });

  it('replays skill trigger preferences during non-force stale and bundle refreshes', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    await writeCodexAllowImplicitInvocation(awHome, true);
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');
    await initializeLocalMarketplace({
      force: false,
      env: process.env,
      gate: {
        interactive: true,
        confirmOverwrite: async () => true,
      },
    });
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);

    await writeCodexAllowImplicitInvocation(awHome, true);
    await fs.writeFile(
      path.join(
        embeddedRoot,
        '.catalog',
        'full',
        'plugins',
        'git-commit',
        'claude',
        'skills',
        'commit',
        'README.md',
      ),
      'fingerprint changed\n',
      'utf8',
    );
    await initializeLocalMarketplace({ force: false, env: process.env });
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(false);
  });

  it('skips replay for degraded ledgers and keeps the pristine bundle', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeInstalledLedger(
      {
        version: 1,
        ledgerState: {
          status: 'degraded',
          degradedAt: '2026-04-28T00:00:00.000Z',
          reason: 'operation_interrupted_after_native_write',
        },
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-28T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: true,
                  },
                  installOptions: {
                    skillTriggerPreference: 'manual',
                  },
                },
              },
            },
          },
        },
      },
      process.env,
    );
    await writeCodexAllowImplicitInvocation(awHome, false);

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain('跳过 skill trigger 偏好 replay');
    expect(await readCodexAllowImplicitInvocation(awHome)).toBe(true);
    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('keeps rebuild best-effort when replay sees malformed pristine skill files', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
    await writeUserSkillTriggerConfig(awHome);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 1,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await fs.writeFile(
      codexOpenAiYamlPath(path.join(embeddedRoot, '.catalog', 'full')),
      'policy: [',
      'utf8',
    );

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain('偏好跳过覆盖');
    await expect(fs.readFile(codexOpenAiYamlPath(awHome), 'utf8')).resolves.toBe('policy: [');
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });
});
