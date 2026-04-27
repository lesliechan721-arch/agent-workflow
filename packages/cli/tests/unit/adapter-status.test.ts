import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClaudeCatalogCompatibility } from '../../src/adapters/claude.js';
import {
  detectClaudeExternalOwnership,
  detectCodexExternalOwnership,
  resolveClaudePlatformNativeFallbackEvidence,
  resolveClaudePlatformRuntimeEvidence,
} from '../../src/adapters/helpers.js';
import {
  hasRepoManagedArtifacts,
  requiresNativePlugin,
  resolveCodexCatalogCompatibility,
} from '../../src/adapters/codex.js';
import { loadPluginTargetsForCommand } from '../../src/commands/common.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
import type { PluginMeta } from '../../src/types.js';

const tempDirs: string[] = [];

function makePluginMeta(overrides: Partial<PluginMeta['manifest']>): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: 'git-commit',
      version: '0.1.0',
      description: 'test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      ...overrides,
    },
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('adapter status helpers', () => {
  async function makeEmptyEmbeddedRoot(root: string): Promise<string> {
    const embeddedRoot = path.join(root, 'embedded');
    await fs.ensureDir(path.join(embeddedRoot, '.claude-plugin'));
    await fs.ensureDir(path.join(embeddedRoot, '.agents', 'plugins'));
    await fs.ensureDir(path.join(embeddedRoot, 'plugins'));
    const marketplace = {
      name: 'aw',
      owner: {
        name: 'Test',
        url: 'https://example.test',
      },
      interface: {
        displayName: 'Test',
      },
      plugins: [],
    };

    await fs.writeJson(path.join(embeddedRoot, '.claude-plugin', 'marketplace.json'), marketplace, { spaces: 2 });
    await fs.writeJson(
      path.join(embeddedRoot, '.agents', 'plugins', 'marketplace.json'),
      marketplace,
      { spaces: 2 },
    );
    return embeddedRoot;
  }

  it('keeps historical fallback extension placeholders scoped to their original platform', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-historical-status-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);
    await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');

    const env = {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    };
    setEmbeddedPluginsRootOverrideForTests(await makeEmptyEmbeddedRoot(root));

    const claudeProjectKey = await resolveClaudeProjectKey(repoRoot);
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'history-only': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              claude: {
                projectScopes: {
                  [claudeProjectKey]: {
                    managed: true,
                    updatedAt: '2026-04-25T00:00:00.000Z',
                    resolvedVersion: '0.1.0',
                    capabilitySnapshot: {
                      managedExtensions: ['permissions', 'hooks'],
                    },
                  },
                },
              },
            },
          },
        },
      },
      env,
    );
    await upsertTrackingRecord(
      resolveClaudePaths(repoRoot, 'project', env).trackingDir,
      'history-only',
      [
        {
          path: path.join(repoRoot, '.claude', 'rules', 'history-only.md'),
          kind: 'permission',
          platform: 'claude',
        },
      ],
    );

    const [target] = await loadPluginTargetsForCommand(
      repoRoot,
      'project',
      ['history-only'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.plugin.manifest.extensions?.permissions).toHaveLength(1);
    expect(target.plugin.manifest.extensions?.hooks).toHaveLength(1);
    expect(target.plugin.manifest.extensions?.hooks?.[0]?.agentOverrides).toMatchObject({
      codex: null,
    });
    expect(hasRepoManagedArtifacts(target.plugin)).toBe(false);
  });

  it('does not synthesize Codex historical hook placeholders from ledger-only repo-managed booleans', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-history-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);
    await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');

    const env = {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    };
    setEmbeddedPluginsRootOverrideForTests(await makeEmptyEmbeddedRoot(root));

    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'repo-only-history': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                  },
                },
              },
            },
          },
        },
      },
      env,
    );

    const [target] = await loadPluginTargetsForCommand(
      repoRoot,
      'user',
      ['repo-only-history'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.plugin.manifest.extensions?.hooks).toBeUndefined();
  });

  it('recovers Claude hook-only historical plugins from ledger snapshots without tracking artifacts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-hook-history-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);
    await fs.writeFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages: []\n', 'utf8');

    const env = {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
    };
    setEmbeddedPluginsRootOverrideForTests(await makeEmptyEmbeddedRoot(root));

    const claudeProjectKey = await resolveClaudeProjectKey(repoRoot);
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'claude-hook-history': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              claude: {
                projectScopes: {
                  [claudeProjectKey]: {
                    managed: true,
                    updatedAt: '2026-04-25T00:00:00.000Z',
                    resolvedVersion: '0.1.0',
                    capabilitySnapshot: {
                      managedExtensions: ['hooks'],
                    },
                  },
                },
              },
            },
          },
        },
      },
      env,
    );

    const [target] = await loadPluginTargetsForCommand(
      repoRoot,
      'project',
      ['claude-hook-history'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.plugin.manifest.extensions?.hooks).toHaveLength(1);
    expect(target.plugin.manifest.extensions?.hooks?.[0]?.agentOverrides).toMatchObject({
      codex: null,
    });
  });

  it('resolves Claude runtime and native fallback evidence with scope-sensitive project matching', async () => {
    const installLocation = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-runtime-'));
    tempDirs.push(installLocation);

    await fs.ensureDir(path.join(installLocation, '.claude-plugin'));
    await fs.ensureDir(path.join(installLocation, 'plugins', 'git-commit'));
    await fs.writeJson(path.join(installLocation, '.claude-plugin', 'marketplace.json'), {
      name: 'aw',
      plugins: [
        {
          name: 'git-commit',
          source: './plugins/git-commit',
        },
      ],
    }, { spaces: 2 });

    const settings = {
      extraKnownMarketplaces: {
        aw: {
          source: installLocation,
        },
      },
      plugins: {
        installed: {
          'git-commit': {
            marketplace: 'aw',
            version: '0.1.0',
            installedAt: '2026-04-25T00:00:00.000Z',
            scope: 'project' as const,
            projectPath: '/repo/project-a',
          },
        },
      },
    };
    const installedPlugins = {
      plugins: {
        'git-commit@aw': [
          {
            name: 'git-commit',
            marketplace: 'aw',
            scope: 'project' as const,
            projectPath: '/repo/project-a',
            version: '0.1.0',
          },
        ],
      },
    };

    await expect(
      resolveClaudePlatformRuntimeEvidence(
        settings,
        installedPlugins,
        {
          installLocation,
        },
        'git-commit',
        'aw',
        'project',
        '/repo/project-a',
      ),
    ).resolves.toMatchObject({
      present: true,
      activeLocalBundle: path.join(installLocation, 'plugins', 'git-commit'),
    });

    expect(
      resolveClaudePlatformNativeFallbackEvidence(
        settings,
        installedPlugins,
        'git-commit',
        'aw',
        'project',
        '/repo/project-b',
      ),
    ).toMatchObject({
      present: false,
    });
  });

  it('detects external ownership and resolves catalog compatibility for Claude/Codex', () => {
    expect(
      detectClaudeExternalOwnership(
        {
          plugins: {
            installed: {
              'git-commit': {
                marketplace: 'third-party',
                version: '1.0.0',
                installedAt: '2026-04-25T00:00:00.000Z',
              },
            },
          },
        },
        { plugins: {} },
        'git-commit',
        'aw',
        'user',
      ),
    ).toMatchObject({
      present: true,
      marketplace: 'third-party',
    });

    expect(
      detectCodexExternalOwnership(
        {
          'git-commit@third-party': {
            enabled: true,
          },
        },
        'git-commit',
        'aw',
      ),
    ).toMatchObject({
      present: true,
      marketplace: 'third-party',
    });

    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: true,
        currentManagedExtensions: ['instructions', 'permissions', 'hooks'],
        currentScopeManagedEvidence: true,
        platformRuntimeEvidence: false,
        platformNativeFallbackEvidence: false,
        installedCapabilitySnapshot: {
          managedExtensions: ['permissions', 'instructions', 'hooks'],
        },
      }),
    ).toBe('current');
    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: true,
        currentManagedExtensions: ['instructions', 'hooks'],
        currentScopeManagedEvidence: true,
        platformRuntimeEvidence: false,
        platformNativeFallbackEvidence: false,
        installedCapabilitySnapshot: {
          managedExtensions: ['permissions', 'instructions', 'hooks'],
        },
      }),
    ).toBe('capabilityChanged');
    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: false,
        currentManagedExtensions: [],
        currentScopeManagedEvidence: false,
        platformRuntimeEvidence: true,
        platformNativeFallbackEvidence: false,
      }),
    ).toBe('missing');

    const nativeOnlyPlugin = makePluginMeta({
      skills: './skills',
    });
    const nativeHookOnlyPlugin = makePluginMeta({
      extensions: {
        nativeHooks: {
          codex: [
            {
              event: 'Stop',
              command: 'echo stop',
            },
          ],
        },
      },
    });
    const hybridPlugin = makePluginMeta({
      skills: './skills',
      extensions: {
        instructions: [
          {
            name: 'commit-policy',
            title: '提交规范',
            content: '保持提交规范。',
          },
        ],
      },
    });

    expect(requiresNativePlugin(nativeOnlyPlugin)).toBe(true);
    expect(hasRepoManagedArtifacts(nativeOnlyPlugin)).toBe(false);
    expect(requiresNativePlugin(nativeHookOnlyPlugin)).toBe(false);
    expect(hasRepoManagedArtifacts(nativeHookOnlyPlugin)).toBe(true);
    expect(requiresNativePlugin(hybridPlugin)).toBe(true);
    expect(hasRepoManagedArtifacts(hybridPlugin)).toBe(true);

    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: true,
        currentScopeManagedEvidence: true,
        platformNativeFallbackEvidence: false,
        currentCapabilities: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
      }),
    ).toBe('current');
    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: true,
        currentScopeManagedEvidence: true,
        platformNativeFallbackEvidence: false,
        currentCapabilities: {
          requiresNativePlugin: false,
          hasRepoManagedArtifacts: true,
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
      }),
    ).toBe('capabilityChanged');
    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: false,
        currentScopeManagedEvidence: false,
        platformNativeFallbackEvidence: true,
        currentCapabilities: {},
      }),
    ).toBe('missing');
  });
});
