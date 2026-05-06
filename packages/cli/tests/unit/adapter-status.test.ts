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
  applyCodexInstallLedger,
  applyCodexUninstallLedger,
  CodexAdapter,
  getCodexProjectManagedKinds,
  hasCodexProjectManagedArtifacts,
  hasRepoManagedArtifacts,
  requiresCodexNativePlugin,
  requiresNativePlugin,
  resolveCodexCatalogCompatibility,
} from '../../src/adapters/codex.js';
import { loadPluginTargetsForCommand } from '../../src/commands/common.js';
import { pluginDeclaresCodexProjectConfigBackedArtifacts } from '../../src/commands/codex-project-safety.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
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

  it('recovers Codex repo skill and MCP placeholders from tracking-only historical evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-repo-tracking-history-'));
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

    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    await upsertTrackingRecord(codexPaths.trackingDir, 'repo-history', [
      {
        path: path.join(repoRoot, '.agents', 'skills', 'commit'),
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'commit',
      },
      {
        path: path.join(repoRoot, '.codex', 'config.toml'),
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'acme.tools v1',
      },
    ]);

    const [target] = await loadPluginTargetsForCommand(
      repoRoot,
      'project',
      ['repo-history'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.plugin.manifest.skills).toBe('./historical-skills');
    expect(target.plugin.manifest.mcpServers).toBe('./historical-mcp.json');
    expect(target.plugin.manifest.extensions).toBeUndefined();
    expect(hasRepoManagedArtifacts(target.plugin)).toBe(true);
  });

  it('recovers Codex historical placeholders from snapshot managed kinds', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-managed-kinds-history-'));
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

    const codexProjectKey = await resolveCodexProjectKey(repoRoot);
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'managed-kind-history': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                projectScopes: {
                  [codexProjectKey]: {
                    managed: true,
                    updatedAt: '2026-04-25T00:00:00.000Z',
                    resolvedVersion: '0.1.0',
                    capabilitySnapshot: {
                      requiresNativePlugin: false,
                      hasRepoManagedArtifacts: true,
                      managedKinds: ['skill', 'mcpServer', 'instruction'],
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
      ['managed-kind-history'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.plugin.manifest.skills).toBe('./historical-skills');
    expect(target.plugin.manifest.mcpServers).toBe('./historical-mcp.json');
    expect(target.plugin.manifest.extensions?.instructions).toHaveLength(1);
    expect(target.plugin.manifest.extensions?.instructions?.[0]?.agentOverrides).toMatchObject({
      claude: null,
    });
  });

  it('recovers tracked Codex dynamic artifact identities without synthesizing historical-agent placeholders', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-dynamic-history-'));
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

    const codexPaths = resolveCodexPaths(repoRoot, 'project', env);
    const rolePath = path.join(codexPaths.configDir, 'agents', 'aw-history-role.toml');
    await upsertTrackingRecord(codexPaths.trackingDir, 'dynamic-history', [
      {
        path: codexPaths.configTomlPath,
        paths: [codexPaths.configTomlPath],
        kind: 'instruction',
        platform: 'codex',
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        state: 'disabled',
        disabledReason: 'config',
        refreshKeys: ['enableLightweightInstruction'],
      },
      {
        path: rolePath,
        paths: [codexPaths.configTomlPath, rolePath],
        kind: 'agent',
        platform: 'codex',
        artifactKey: 'codex-explorer',
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        state: 'present',
        refreshKeys: ['explorerModel', 'modelReasoningEffort'],
      },
    ]);

    const [target] = await loadPluginTargetsForCommand(
      repoRoot,
      'project',
      ['dynamic-history'],
      { allowHistoricalFallback: true, env },
    );

    expect(target.source).toBe('historical');
    expect(target.historicalArtifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        paths: [codexPaths.configTomlPath],
        state: 'disabled',
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        paths: [codexPaths.configTomlPath, rolePath],
        roleKey: 'codex-explorer',
        artifactKey: 'codex-explorer',
        state: 'present',
      }),
    ]));
    expect(target.plugin.manifest.extensions?.agents).toBeUndefined();
    expect(target.plugin.manifest.artifacts?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
        scopes: ['project'],
        states: ['disabled'],
        refreshKeys: ['enableLightweightInstruction'],
      }),
      expect.objectContaining({
        id: 'codex-explorer-role',
        target: 'codex.agentRole',
        roleKey: 'codex-explorer',
        scopes: ['project'],
        states: ['present'],
      }),
    ]));
    expect(getCodexProjectManagedKinds(target.plugin)).toEqual(['instruction', 'agent']);
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

    const skillsOnlyPlugin = makePluginMeta({
      skills: './skills',
    });
    const slashCommandsOnlyPlugin = makePluginMeta({
      slashCommands: './slash-commands',
    });
    const mcpOnlyPlugin = makePluginMeta({
      mcpServers: './.mcp.json',
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
    const extensionsOnlyPlugin = makePluginMeta({
      extensions: {
        instructions: [
          {
            name: 'commit-policy',
            title: '提交规范',
            content: '保持提交规范。',
          },
        ],
        permissions: [
          {
            name: 'shell-policy',
            allow: ['Bash(git status)'],
          },
        ],
        hooks: [
          {
            event: 'session_start',
            command: 'echo ready',
          },
        ],
        agents: [
          {
            name: 'commit-reviewer',
            description: 'Review commits.',
            prompt: 'Review commits.',
          },
        ],
      },
    });
    const appsOnlyPlugin = makePluginMeta({
      apps: './apps',
    });
    const appsMixedPlugin = makePluginMeta({
      skills: './skills',
      slashCommands: './slash-commands',
      mcpServers: './.mcp.json',
      apps: './apps',
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
    const dynamicArtifactsPlugin = makePluginMeta({
      skills: './skills',
      config: {
        schema: {
          enableLightweightInstruction: {
            type: 'boolean',
            default: true,
          },
          explorerModel: {
            type: 'string',
            default: 'gpt-5.4-mini',
          },
          modelReasoningEffort: {
            type: 'enum',
            values: ['low', 'medium', 'high', 'xhigh'],
            default: 'medium',
          },
        },
      },
      artifacts: {
        targets: [
          {
            id: 'lightweight-instruction',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.developerInstructionsBlock',
            projectManagedKind: 'instruction',
            states: ['present', 'disabled'],
            refreshKeys: [
              'enableLightweightInstruction',
              'explorerModel',
              'modelReasoningEffort',
            ],
            requiresCodexProjectConfig: true,
          },
          {
            id: 'codex-explorer-role',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.agentRole',
            projectManagedKind: 'agent',
            states: ['present'],
            refreshKeys: ['explorerModel', 'modelReasoningEffort'],
            requiresCodexProjectConfig: true,
            roleKey: 'codex-explorer',
          },
        ],
      },
    });
    const claudeOnlyDynamicArtifactsPlugin = makePluginMeta({
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CLAUDE'],
        },
      },
      skills: './skills',
      config: {
        schema: {
          enableLightweightInstruction: {
            type: 'boolean',
            default: true,
          },
          explorerModel: {
            type: 'string',
            default: 'gpt-5.4-mini',
          },
          modelReasoningEffort: {
            type: 'enum',
            values: ['low', 'medium', 'high', 'xhigh'],
            default: 'medium',
          },
        },
      },
      artifacts: {
        targets: [
          {
            id: 'lightweight-instruction',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.developerInstructionsBlock',
            projectManagedKind: 'instruction',
            states: ['present', 'disabled'],
            refreshKeys: [
              'enableLightweightInstruction',
              'explorerModel',
              'modelReasoningEffort',
            ],
            requiresCodexProjectConfig: true,
          },
        ],
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

    expect(requiresCodexNativePlugin(skillsOnlyPlugin, 'user')).toBe(true);
    expect(requiresCodexNativePlugin(skillsOnlyPlugin, 'project')).toBe(false);
    expect(requiresCodexNativePlugin(slashCommandsOnlyPlugin, 'user')).toBe(true);
    expect(requiresCodexNativePlugin(slashCommandsOnlyPlugin, 'project')).toBe(false);
    expect(requiresCodexNativePlugin(mcpOnlyPlugin, 'user')).toBe(true);
    expect(requiresCodexNativePlugin(mcpOnlyPlugin, 'project')).toBe(false);
    expect(requiresCodexNativePlugin(appsOnlyPlugin, 'user')).toBe(true);
    expect(requiresCodexNativePlugin(appsOnlyPlugin, 'project')).toBe(false);
    expect(requiresCodexNativePlugin(extensionsOnlyPlugin, 'user')).toBe(false);
    expect(requiresCodexNativePlugin(extensionsOnlyPlugin, 'project')).toBe(false);

    expect(requiresNativePlugin(skillsOnlyPlugin)).toBe(true);
    expect(hasRepoManagedArtifacts(skillsOnlyPlugin)).toBe(true);
    expect(hasCodexProjectManagedArtifacts(skillsOnlyPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(skillsOnlyPlugin)).toEqual(['skill']);
    expect(hasCodexProjectManagedArtifacts(slashCommandsOnlyPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(slashCommandsOnlyPlugin)).toEqual(['skill']);
    expect(hasCodexProjectManagedArtifacts(mcpOnlyPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(mcpOnlyPlugin)).toEqual(['mcpServer']);
    expect(hasCodexProjectManagedArtifacts(extensionsOnlyPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(extensionsOnlyPlugin)).toEqual([
      'instruction',
      'permission',
      'hook',
      'agent',
    ]);
    expect(hasCodexProjectManagedArtifacts(appsOnlyPlugin)).toBe(false);
    expect(getCodexProjectManagedKinds(appsOnlyPlugin)).toEqual([]);
    expect(hasCodexProjectManagedArtifacts(appsMixedPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(appsMixedPlugin)).toEqual([
      'skill',
      'mcpServer',
      'instruction',
    ]);
    expect(hasCodexProjectManagedArtifacts(dynamicArtifactsPlugin)).toBe(true);
    expect(getCodexProjectManagedKinds(dynamicArtifactsPlugin)).toEqual([
      'skill',
      'instruction',
      'agent',
    ]);
    expect(pluginDeclaresCodexProjectConfigBackedArtifacts(dynamicArtifactsPlugin)).toBe(true);
    expect(requiresCodexNativePlugin(claudeOnlyDynamicArtifactsPlugin, 'user')).toBe(false);
    expect(hasCodexProjectManagedArtifacts(claudeOnlyDynamicArtifactsPlugin)).toBe(false);
    expect(getCodexProjectManagedKinds(claudeOnlyDynamicArtifactsPlugin)).toEqual([]);
    expect(pluginDeclaresCodexProjectConfigBackedArtifacts(claudeOnlyDynamicArtifactsPlugin)).toBe(false);
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
          projectManagedKinds: ['skill', 'instruction'],
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
          projectManagedKinds: ['instruction', 'skill'],
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
          projectManagedKinds: ['instruction'],
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
          projectManagedKinds: ['instruction'],
        },
      }),
    ).toBe('capabilityChanged');
    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: true,
        currentScopeManagedEvidence: true,
        platformNativeFallbackEvidence: false,
        currentCapabilities: {
          requiresNativePlugin: false,
          hasRepoManagedArtifacts: true,
          projectManagedKinds: ['skill'],
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: false,
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
          projectManagedKinds: ['skill', 'agent'],
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: false,
          managedKinds: ['agent', 'skill'],
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
          projectManagedKinds: ['skill'],
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: false,
          projectManagedKinds: ['mcpServer'],
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

  it('applies Codex project installability preflight without native fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-installability-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);
    const adapter = new CodexAdapter(repoRoot, async () => {
      throw new Error('native runner should not be called for project repo-managed targets');
    });

    await expect(
      adapter.installPlugin(makePluginMeta({ skills: './skills' }), 'project'),
    ).resolves.toBeUndefined();
    await expect(
      adapter.installPlugin(makePluginMeta({ slashCommands: './slash-commands' }), 'project'),
    ).resolves.toBeUndefined();
    await expect(
      adapter.installPlugin(makePluginMeta({ mcpServers: './.mcp.json' }), 'project'),
    ).resolves.toBeUndefined();
    await expect(
      adapter.installPlugin(
        makePluginMeta({
          extensions: {
            instructions: [
              {
                name: 'commit-policy',
                title: '提交规范',
                content: '保持提交规范。',
              },
            ],
          },
        }),
        'project',
      ),
    ).resolves.toBeUndefined();
    await expect(adapter.installPlugin(makePluginMeta({ apps: './apps' }), 'project')).rejects.toThrow(
      'Codex project scope 暂不支持 apps',
    );
    await expect(
      adapter.installPlugin(makePluginMeta({ skills: './skills', apps: './apps' }), 'project'),
    ).rejects.toThrow('Codex project scope 暂不支持 apps');
    await expect(adapter.installPlugin(makePluginMeta({}), 'project')).rejects.toThrow(
      '不包含任何 repo-managed artifacts',
    );
  });

  it('writes scope-aware Codex capability snapshots and user native refs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-capability-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);

    const slashCommandsOnlyPlugin = makePluginMeta({
      slashCommands: './slash-commands',
    });
    const userLedger = await applyCodexInstallLedger(
      createAvailableLedger(),
      slashCommandsOnlyPlugin,
      'user',
      repoRoot,
    );
    const projectLedger = await applyCodexInstallLedger(
      userLedger,
      slashCommandsOnlyPlugin,
      'project',
      repoRoot,
    );
    const projectKey = await fs.realpath(repoRoot);

    expect(
      projectLedger.plugins['git-commit'].platforms.codex?.userScope?.capabilitySnapshot,
    ).toMatchObject({
      requiresNativePlugin: true,
      hasRepoManagedArtifacts: true,
      projectManagedKinds: ['skill'],
    });
    expect(
      projectLedger.plugins['git-commit'].platforms.codex?.projectScopes?.[projectKey]?.capabilitySnapshot,
    ).toMatchObject({
      requiresNativePlugin: false,
      hasRepoManagedArtifacts: true,
      projectManagedKinds: ['skill'],
    });
    expect(
      projectLedger.plugins['git-commit'].platforms.codex?.projectScopes?.[projectKey]?.projectKey,
    ).toBe(projectKey);
    expect(projectLedger.plugins['git-commit'].platforms.codex?.sharedNativeRefs).toEqual({
      user: true,
      projects: [],
    });

    const projectOnlyLedger = await applyCodexInstallLedger(
      createAvailableLedger(),
      slashCommandsOnlyPlugin,
      'project',
      repoRoot,
    );
    expect(
      projectOnlyLedger.plugins['git-commit'].platforms.codex?.projectScopes?.[projectKey]?.capabilitySnapshot,
    ).toMatchObject({
      requiresNativePlugin: false,
      hasRepoManagedArtifacts: true,
      projectManagedKinds: ['skill'],
    });
    expect(
      projectOnlyLedger.plugins['git-commit'].platforms.codex?.projectScopes?.[projectKey]?.projectKey,
    ).toBe(projectKey);
    expect(projectOnlyLedger.plugins['git-commit'].platforms.codex).not.toHaveProperty('sharedNativeRefs');
  });

  it('removes Codex project ledger records without mutating shared native refs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-ledger-remove-'));
    tempDirs.push(root);
    const repoRoot = path.join(root, 'repo');
    await fs.ensureDir(repoRoot);
    const projectKey = await fs.realpath(repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: false,
                hasRepoManagedArtifacts: true,
                projectManagedKinds: ['skill'],
              },
            },
          },
          sharedNativeRefs: {
            user: true,
            projects: [projectKey],
          },
        },
      },
    };

    const updated = await applyCodexUninstallLedger(ledger, 'git-commit', 'project', repoRoot);

    expect(updated.plugins['git-commit'].platforms.codex?.projectScopes).toBeUndefined();
    expect(updated.plugins['git-commit'].platforms.codex?.sharedNativeRefs).toEqual({
      user: true,
      projects: [projectKey],
    });
  });

  it('does not count Codex project shared native refs or user native state as project evidence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-evidence-'));
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

    const projectKey = await fs.realpath(repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          sharedNativeRefs: {
            user: false,
            projects: [projectKey],
          },
        },
      },
    };
    await writeInstalledLedger(ledger, env);
    const userPaths = resolveCodexPaths(repoRoot, 'user', env);
    await fs.outputFile(
      userPaths.configTomlPath,
      '[plugins."git-commit@aw"]\nenabled = true\n',
      'utf8',
    );

    const adapter = new CodexAdapter(repoRoot, env);
    const report = await adapter.status(makePluginMeta({ skills: './skills' }), 'project');

    expect(report.initialized).toBe(false);
    expect(report.plugins[0]).toMatchObject({
      scopeInitialized: 'no',
      native: {
        pluginInstalled: false,
        pluginEnabled: true,
      },
      scopeManagedEvidence: {
        ledger: false,
        tracking: false,
        sharedNativeRef: false,
      },
    });
  });
});
