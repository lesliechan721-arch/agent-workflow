import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  getCodexNativeRecoveryBreadcrumbPath,
  readCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';
import {
  calculateBundleFingerprint,
  createAvailableLedger,
  ensureLocalMarketplace,
  hasInstalledLedgerDependencyMetadata,
  initializeLocalMarketplace,
  readInstalledLedger,
  validateLocalMarketplaceLayout,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readJsonFile } from '../../src/utils/json.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import type { InstalledLedger } from '../../src/types.js';
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
): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-local-marketplace-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  if (manifestUpdater) {
    await updateFixturePluginManifest(repoRoot, manifestUpdater);
  }
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');

  return { repoRoot, awHome, embeddedRoot };
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
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('local marketplace', () => {
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
