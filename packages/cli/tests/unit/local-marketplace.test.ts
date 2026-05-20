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
  calculateBundleFingerprint,
  createAvailableLedger,
  ensureLocalMarketplace,
  hasInstalledLedgerDependencyMetadata,
  initializeLocalMarketplace,
  readCurrentCatalogCacheEntry,
  readInstalledLedger,
  resolveReadOnlyCatalogResolution,
  validateLocalMarketplaceLayout,
  writeCurrentCatalogCacheEntry,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import { CatalogResolutionError } from '../../src/utils/plugin-catalog.js';
import { readJsonFile } from '../../src/utils/json.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import { resolveCurrentCatalogCacheEntryDir, setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import type { CatalogSelector, InstalledLedger } from '../../src/types.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

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

afterEach(async () => {
  vi.restoreAllMocks();
  setCatalogPackageSourceForTests(null);
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local marketplace', () => {
  it('falls back to a matching local marketplace only for catalogUnavailable current catalog failures', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });

    vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(new CatalogResolutionError({
      selector: {
        kind: 'default',
        cliVersion: '0.1.0',
        defaultChannel: 'latest',
      },
      cacheFallback: {
        used: false,
      },
      reason: 'current catalog is temporarily unavailable',
      reasonCode: 'catalogUnavailable',
    }));

    await expect(resolveReadOnlyCatalogResolution(env)).resolves.toMatchObject({
      rootDir: awHome,
      source: 'local',
    });
  });

  it('reuses a healthy local marketplace before resolving current catalog when plugins-dist is missing', async () => {
    const { awHome, embeddedRoot, repoRoot } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
    };
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await initializeLocalMarketplace({ force: true, env });

    const resolveCurrentCatalog = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog').mockRejectedValue(
      new CatalogResolutionError({
        selector: {
          kind: 'default',
          cliVersion: '0.1.0',
          defaultChannel: 'latest',
        },
        cacheFallback: {
          used: false,
        },
        reason: 'current catalog is temporarily unavailable',
        reasonCode: 'catalogUnavailable',
      }),
    );
    setEmbeddedPluginsRootOverrideForTests(path.join(repoRoot, 'missing-plugins-dist'));

    await expect(ensureLocalMarketplace(env)).resolves.toEqual({
      rootDir: awHome,
      changed: false,
      warnings: [],
    });
    expect(resolveCurrentCatalog).not.toHaveBeenCalled();
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

    await fs.writeFile(
      path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'SKILL.md'),
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
    config.version = 2;
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

  it('ignores Codex project scope records when replaying the shared runtime winner', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initializeLocalMarketplace({ force: true, env: process.env });
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
      path.join(embeddedRoot, 'plugins', 'git-commit', 'claude', 'skills', 'commit', 'README.md'),
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
    await fs.writeFile(codexOpenAiYamlPath(embeddedRoot), 'policy: [', 'utf8');

    const result = await initializeLocalMarketplace({ force: true, env: process.env });

    expect(result.warnings.join('\n')).toContain('偏好跳过覆盖');
    await expect(fs.readFile(codexOpenAiYamlPath(awHome), 'utf8')).resolves.toBe('policy: [');
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();
  });
});
