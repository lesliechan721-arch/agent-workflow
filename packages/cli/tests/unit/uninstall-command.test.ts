import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex.js';
import * as commonModule from '../../src/commands/common.js';
import { uninstallCommand, uninstallTargetsOnPlatforms } from '../../src/commands/uninstall.js';
import {
  readCodexConfigFile,
  removeCodexPluginEnabledFile,
  removeManagedDeveloperInstructionsFile,
  upsertCodexMarketplaceFile,
  upsertCodexMcpServer,
  upsertCodexPluginEnabledFile,
  upsertManagedDeveloperInstructionsFile,
} from '../../src/utils/codex-config.js';
import * as pluginScriptsModule from '../../src/utils/plugin-scripts.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  readCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import * as skillTriggerPreferencesModule from '../../src/utils/skill-trigger-preferences.js';
import * as trackingModule from '../../src/utils/tracking.js';
import { readTrackingManifest, upsertTrackingRecord } from '../../src/utils/tracking.js';
import {
  buildCommandReceiptJson,
  renderCommandReceipt,
} from '../../src/output/command-receipt.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-uninstall-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);

  return {
    repoRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
  };
}

async function copyRepoManagedFixturePlugin(
  repoRoot: string,
  pluginDir: 'instructions-mcp' | 'skills-mcp',
): Promise<void> {
  await fs.copy(
    fixturePath('codex-project-repo-managed', 'plugins', pluginDir),
    path.join(repoRoot, 'plugins', pluginDir),
  );
}

function resolveCodexNativeCacheVersionPath(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): string {
  return path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version);
}

async function waitForHarnessMethod(
  harness: ReturnType<typeof createFakeCodexAppServerHarness>,
  method: string,
): Promise<void> {
  while (!harness.stdinMessages.some((message) => message.json?.method === method)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makePluginStatus(
  pluginName: string,
  overrides: Partial<PluginStatusReport> = {},
): PluginStatusReport {
  return {
    pluginName,
    native: {
      marketplaceRegistered: false,
      pluginAvailable: true,
      pluginInstalled: false,
      version: '0.1.0',
    },
    generatedArtifacts: [],
    driftWarnings: [],
    scopeInitialized: 'no',
    platformRuntimeEvidence: {
      present: false,
    },
    platformNativeFallbackEvidence: {
      present: false,
    },
    scopeManagedEvidence: {
      ledger: false,
      tracking: false,
      sharedNativeRef: false,
    },
    currentCatalog: {
      rootDir: '/synthetic',
      source: 'embedded',
      available: true,
    },
    artifactsInitialized: true,
    repoManagedSessionState: {
      instructions: 'not_applicable',
      rules: 'not_applicable',
      hooks: 'not_applicable',
      agents: 'not_applicable',
      diagnostics: [],
    },
    projectTrust: 'not_applicable',
    ...overrides,
  };
}

function makeStatusReport(
  platform: PlatformName,
  scope: Scope,
  plugins: PluginStatusReport[],
): StatusReport {
  return {
    platform,
    scope,
    initialized: plugins.some((plugin) =>
      plugin.scopeManagedEvidence?.ledger ||
      plugin.scopeManagedEvidence?.tracking ||
      plugin.scopeManagedEvidence?.sharedNativeRef ||
      plugin.platformRuntimeEvidence?.present ||
      plugin.platformNativeFallbackEvidence?.present,
    ),
    plugins,
  };
}

class FakeAdapter implements PlatformAdapter {
  readonly uninstallPluginCalls: string[] = [];
  readonly uninstallExtensionsCalls: string[] = [];
  readonly reinstallExtensionsCalls: string[] = [];
  private statusIndex = 0;

  constructor(
    readonly name: PlatformName,
    private readonly statusSequence: StatusReport[],
    private readonly options: {
      installExtensionsAction?: (
        plugin: { manifest: { name: string; version?: string } },
        scope: Scope,
      ) => Promise<GeneratedArtifact[] | void> | GeneratedArtifact[] | void;
      uninstallExtensionsAction?: (
        plugin: { manifest: { name: string; version?: string } },
        scope: Scope,
      ) => Promise<void> | void;
      uninstallExtensionsError?: string;
    } = {},
  ) {}

  async detect(_cwd: string): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(plugin: { manifest: { name: string } }): Promise<void> {
    this.uninstallPluginCalls.push(plugin.manifest.name);
  }

  async installExtensions(
    plugin: { manifest: { name: string; version?: string } },
    scope: Scope,
  ): Promise<GeneratedArtifact[]> {
    this.reinstallExtensionsCalls.push(plugin.manifest.name);
    const artifacts = await this.options.installExtensionsAction?.(plugin, scope);
    return artifacts ?? [];
  }

  async uninstallExtensions(
    plugin: { manifest: { name: string; version?: string } },
    scope: Scope = 'project',
    _generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
    await this.options.uninstallExtensionsAction?.(plugin, scope);
    if (this.options.uninstallExtensionsError) {
      throw new Error(this.options.uninstallExtensionsError);
    }
  }

  async upgradePlugin(): Promise<void> {}

  async status(): Promise<StatusReport> {
    const index = Math.min(this.statusIndex, this.statusSequence.length - 1);
    this.statusIndex += 1;
    return this.statusSequence[index];
  }
}

async function seedManagedCodexInstruction(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  pluginName: string,
  instructionValue: string,
  resolvedVersion = '0.1.0',
): Promise<{ configTomlPath: string; trackingDir: string }> {
  const paths = resolveCodexPaths(repoRoot, 'project', env);
  const projectKey = await resolveCodexProjectKey(repoRoot);

  await localMarketplaceModule.writeInstalledLedger(
    {
      ...localMarketplaceModule.createAvailableLedger(),
      plugins: {
        [pluginName]: {
          lastResolvedVersion: resolvedVersion,
          platforms: {
            codex: {
              projectScopes: {
                [projectKey]: {
                  managed: true,
                  updatedAt: '2026-04-25T00:00:00.000Z',
                  resolvedVersion,
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                    hasRepoManagedArtifacts: true,
                  },
                },
              },
              sharedNativeRefs: {
                user: false,
                projects: [],
              },
            },
          },
        },
      },
    },
    env,
  );

  await upsertManagedDeveloperInstructionsFile(paths.configTomlPath, {
    pluginName,
    value: instructionValue,
  });
  await upsertTrackingRecord(paths.trackingDir, pluginName, [
    {
      path: paths.configTomlPath,
      kind: 'instruction',
      platform: 'codex',
    },
  ]);

  return paths;
}

async function readManagedCodexInstruction(
  configTomlPath: string,
  pluginName: string,
): Promise<string | undefined> {
  const { snapshot } = await readCodexConfigFile(configTomlPath);
  return snapshot.developerInstructions.managedBlocks[pluginName]?.value?.trimEnd();
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('uninstall command coverage', () => {
  it('rejects empty uninstall invocations', async () => {
    await expect(
      uninstallCommand([], {
        cwd: '/tmp/repo',
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('uninstall 命令至少需要一个插件名。');
  });

  it('blocks explicit uninstall when another installed dependent still references the target', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await localMarketplaceModule.writeInstalledLedger(
      {
        ...localMarketplaceModule.createAvailableLedger(),
        plugins: {
          'git-commit': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                  },
                  installSource: {
                    kind: 'explicit',
                    explicitlyRequested: true,
                    allowsUnusedCleanup: false,
                  },
                  dependencyEdges: [],
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
          'workflow-pack': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {
                    requiresNativePlugin: false,
                  },
                  installSource: {
                    kind: 'explicit',
                    explicitlyRequested: true,
                    allowsUnusedCleanup: false,
                  },
                  dependencyEdges: [{
                    dependency: {
                      plugin: 'git-commit',
                      platform: 'codex',
                      scope: 'user',
                      projectKey: null,
                    },
                    declaration: {
                      name: 'git-commit',
                    },
                  }],
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
        },
      },
      env,
    );

    await expect(
      uninstallCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'user', [
                makePluginStatus('git-commit', {
                  scopeInitialized: 'yes',
                  scopeManagedEvidence: {
                    ledger: true,
                    tracking: false,
                    sharedNativeRef: false,
                  },
                }),
              ]),
              makeStatusReport('codex', 'user', [
                makePluginStatus('workflow-pack', {
                  scopeInitialized: 'yes',
                  scopeManagedEvidence: {
                    ledger: true,
                    tracking: false,
                    sharedNativeRef: false,
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow(/workflow-pack/);
  });

  it('adds uninstallAutoDependency receipt actions and readable auto-cleanup summaries', () => {
    const receipt = {
      result: {
        platforms: ['codex'],
        plugins: ['cleanup-parent'],
        warnings: [],
        receiptActions: [{
          type: 'uninstallAutoDependency' as const,
          plugin: 'cleanup-child',
          platform: 'codex',
          scope: 'user' as const,
        }],
      },
      groups: [{
        scope: 'user' as const,
        platforms: ['codex'],
        plugins: ['cleanup-parent'],
      }],
    };

    expect(buildCommandReceiptJson('uninstall', receipt)).toMatchObject({
      actions: expect.arrayContaining([
        {
          type: 'uninstall',
          plugin: 'cleanup-parent',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
        {
          type: 'uninstallAutoDependency',
          plugin: 'cleanup-child',
          platform: 'codex',
          scope: 'user',
          status: 'succeeded',
        },
      ]),
    });
    expect(renderCommandReceipt('uninstall', receipt)).toContain(
      '已自动清理不再需要的依赖：cleanup-child。',
    );
  });

  it('refuses historical uninstall when tracked skill or MCP identity is missing artifactKey', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: undefined,
      embeddedPlugin: undefined,
      source: 'historical',
    };
    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          generatedArtifacts: [
            {
              path: path.join(repoRoot, '.agents', 'skills', 'commit'),
              exists: true,
              kind: 'skill',
            },
          ],
          scopeInitialized: 'unknown',
        }),
      ]),
    ]);

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('缺少 artifactKey');

    expect(codex.uninstallPluginCalls).toEqual([]);
    expect(codex.uninstallExtensionsCalls).toEqual([]);
  });

  it('uses default adapters when runtime is omitted and skips missing plugin reports', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', []),
    ]);
    vi.spyOn(commonModule, 'createAdapters').mockReturnValue({
      codex,
      claude: new FakeAdapter('claude', [
        makeStatusReport('claude', 'project', []),
      ]),
    });

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
      ),
    ).resolves.toEqual({
      warnings: [],
      repoManagedArtifacts: [],
    });
  });

  it('rejects external ownership, historical misses, and fallback-only cleanup requests', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const currentTarget: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    const historicalTarget: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: undefined,
      source: 'historical',
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [currentTarget],
        ['claude'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', []),
            ]),
            claude: new FakeAdapter('claude', [
              makeStatusReport('claude', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  externalOwnership: {
                    present: true,
                    marketplace: 'third-party',
                    details: 'third-party owns this plugin',
                  },
                }),
              ]),
            ]),
          },
          env,
        },
      ),
    ).rejects.toThrow('third-party owns this plugin');

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['claude'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [makeStatusReport('codex', 'project', [])]),
            claude: new FakeAdapter('claude', [
              makeStatusReport('claude', 'project', [
                makePluginStatus(plugin.manifest.name),
              ]),
            ]),
          },
          env,
        },
      ),
    ).rejects.toThrow(`Unknown plugin "${plugin.manifest.name}".`);

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['claude'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [makeStatusReport('codex', 'project', [])]),
            claude: new FakeAdapter('claude', [
              makeStatusReport('claude', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  platformRuntimeEvidence: {
                    present: true,
                  },
                }),
              ]),
            ]),
          },
          env,
        },
      ),
    ).rejects.toThrow('当前只剩原生 loader 仍会读取该插件的证据');

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  platformNativeFallbackEvidence: {
                    present: true,
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('当前只剩 Codex user native fallback evidence');
  });

  it('warns when the current scope is unmanaged and preserves available ledgers on successful uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [`[codex/${plugin.manifest.name}] 当前 scope 未受管，无需卸载。`],
      repoManagedArtifacts: [],
    });

    await localMarketplaceModule.writeInstalledLedger(
      localMarketplaceModule.createAvailableLedger(),
      env,
    );
    const trackingDir = resolveCodexPaths(repoRoot, 'project', env).trackingDir;
    await upsertTrackingRecord(trackingDir, plugin.manifest.name, [
      {
        path: path.join(trackingDir, 'git-commit.rule'),
        kind: 'instruction',
        platform: 'codex',
      },
    ]);

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }),
      ]),
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'no',
          driftWarnings: ['post-uninstall drift'],
        }),
      ]),
    ]);
    const reporter = {
      event: vi.fn(),
      notice: vi.fn(),
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          reporter,
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [],
      repoManagedArtifacts: [
        {
          path: path.join(trackingDir, 'git-commit.rule'),
          kind: 'instruction',
          platform: 'codex',
        },
      ],
    });
    expect(reporter.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'drift:suppressed',
        data: expect.objectContaining({
          platform: 'codex',
          plugin: plugin.manifest.name,
          warnings: ['post-uninstall drift'],
        }),
      }),
    );

    expect(codex.uninstallPluginCalls).toEqual([plugin.manifest.name]);
    expect(codex.uninstallExtensionsCalls).toEqual([plugin.manifest.name]);
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {},
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
    });
  });

  it('restores tracking state, rolls artifacts back, and degrades the ledger when uninstall bookkeeping fails', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    const legacyInstruction = 'Legacy managed instruction';
    const { configTomlPath, trackingDir } = await seedManagedCodexInstruction(
      repoRoot,
      env,
      plugin.manifest.name,
      legacyInstruction,
    );

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }),
      ]),
    ], {
      uninstallExtensionsAction: async (currentPlugin) => {
        await removeManagedDeveloperInstructionsFile(configTomlPath, currentPlugin.manifest.name);
      },
    });

    const writeInstalledLedgerImpl = localMarketplaceModule.writeInstalledLedger;
    vi.spyOn(localMarketplaceModule, 'writeInstalledLedger')
      .mockImplementationOnce(async () => {
        throw new Error('ledger boom');
      })
      .mockImplementation((ledger, nextEnv) => writeInstalledLedgerImpl(ledger, nextEnv));

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('ledger boom');

    await expect(readManagedCodexInstruction(configTomlPath, plugin.manifest.name)).resolves.toBe(
      legacyInstruction,
    );
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          artifacts: [
            {
              path: configTomlPath,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('restores repo skills and the full Codex config baseline when project uninstall tracking fails', async () => {
    const { repoRoot, env } = await makeWorkspace();
    await copyRepoManagedFixturePlugin(repoRoot, 'skills-mcp');
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'skills-mcp'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: plugin,
      source: 'currentCatalog',
    };
    const paths = resolveCodexPaths(repoRoot, 'project', env);
    const projectKey = await resolveCodexProjectKey(repoRoot);
    const installedSkillPath = path.join(repoRoot, '.agents', 'skills', 'repo-check');

    await localMarketplaceModule.writeInstalledLedger(
      {
        ...localMarketplaceModule.createAvailableLedger(),
        plugins: {
          [plugin.manifest.name]: {
            lastResolvedVersion: plugin.manifest.version,
            platforms: {
              codex: {
                projectScopes: {
                  [projectKey]: {
                    managed: true,
                    updatedAt: '2026-04-30T00:00:00.000Z',
                    resolvedVersion: plugin.manifest.version,
                    projectKey,
                    capabilitySnapshot: {
                      requiresNativePlugin: false,
                      hasRepoManagedArtifacts: true,
                      projectManagedKinds: ['skill', 'mcpServer', 'instruction'],
                    },
                  },
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
        },
      },
      env,
    );

    let baselineConfig = upsertCodexMcpServer('# baseline\n\n', 'external', {
      command: 'keep',
    });
    baselineConfig = upsertCodexMcpServer(baselineConfig, 'skills-mcp-server', {
      command: 'node',
      args: ['./servers/skills-mcp.js'],
      env: {
        FIXTURE_KIND: 'skills-mcp',
      },
    });
    await fs.outputFile(paths.configTomlPath, baselineConfig, 'utf8');
    await upsertManagedDeveloperInstructionsFile(paths.configTomlPath, {
      pluginName: plugin.manifest.name,
      value: '## skills-mcp\n\nmanaged instruction',
    });
    baselineConfig = await fs.readFile(paths.configTomlPath, 'utf8');

    await fs.copy(
      path.join(repoRoot, 'plugins', 'skills-mcp', 'skills', 'repo-check'),
      installedSkillPath,
    );
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: installedSkillPath,
        kind: 'skill',
        platform: 'codex',
        artifactKey: 'repo-check',
      },
      {
        path: paths.configTomlPath,
        kind: 'mcpServer',
        platform: 'codex',
        artifactKey: 'skills-mcp-server',
      },
      {
        path: paths.configTomlPath,
        kind: 'instruction',
        platform: 'codex',
      },
    ]);

    const writeTrackingManifestImpl = trackingModule.writeTrackingManifest;
    vi.spyOn(trackingModule, 'writeTrackingManifest')
      .mockImplementationOnce(async () => {
        throw new Error('tracking boom');
      })
      .mockImplementation((trackingDir, manifest) => writeTrackingManifestImpl(trackingDir, manifest));

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new CodexAdapter(repoRoot, env),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('tracking boom');

    await expect(fs.pathExists(installedSkillPath)).resolves.toBe(true);
    await expect(fs.readFile(paths.configTomlPath, 'utf8')).resolves.toBe(baselineConfig);
    await expect(readTrackingManifest(paths.trackingDir)).resolves.toMatchObject({
      plugins: {
        'skills-mcp': {
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'skill',
              artifactKey: 'repo-check',
              path: installedSkillPath,
            }),
            expect.objectContaining({
              kind: 'mcpServer',
              artifactKey: 'skills-mcp-server',
              path: paths.configTomlPath,
            }),
            expect.objectContaining({
              kind: 'instruction',
              path: paths.configTomlPath,
            }),
          ]),
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('restores historical uninstall artifacts from the pre-uninstall snapshot', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: undefined,
      source: 'historical',
    };
    const legacyInstruction = 'Historical managed instruction';
    const { configTomlPath, trackingDir } = await seedManagedCodexInstruction(
      repoRoot,
      env,
      plugin.manifest.name,
      legacyInstruction,
      '0.0.5',
    );

    const codex = new FakeAdapter(
      'codex',
      [
        makeStatusReport('codex', 'project', [
          makePluginStatus(plugin.manifest.name, {
            scopeInitialized: 'yes',
            catalogCompatibility: 'missing',
            scopeManagedEvidence: {
              ledger: true,
              tracking: true,
              sharedNativeRef: false,
            },
          }),
        ]),
      ],
      {
        installExtensionsAction: async (currentPlugin) => {
          await upsertManagedDeveloperInstructionsFile(configTomlPath, {
            pluginName: currentPlugin.manifest.name,
            value: `rollback-from-${currentPlugin.manifest.version ?? 'unknown'}`,
          });
        },
        uninstallExtensionsAction: async (currentPlugin) => {
          await removeManagedDeveloperInstructionsFile(configTomlPath, currentPlugin.manifest.name);
        },
        uninstallExtensionsError: 'artifact cleanup boom',
      },
    );

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('artifact cleanup boom');

    expect(codex.reinstallExtensionsCalls).toEqual([]);
    await expect(readManagedCodexInstruction(configTomlPath, plugin.manifest.name)).resolves.toBe(
      legacyInstruction,
    );
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          artifacts: [
            {
              path: configTomlPath,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('restores capability-changed uninstall artifacts to the installed snapshot instead of the current catalog', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const currentPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        version: '9.9.0',
      },
    };
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin: currentPlugin,
      currentPlugin,
      source: 'currentCatalog',
    };
    const legacyInstruction = 'Installed snapshot instruction';
    const { configTomlPath, trackingDir } = await seedManagedCodexInstruction(
      repoRoot,
      env,
      plugin.manifest.name,
      legacyInstruction,
      '0.3.0',
    );

    const codex = new FakeAdapter(
      'codex',
      [
        makeStatusReport('codex', 'project', [
          makePluginStatus(plugin.manifest.name, {
            scopeInitialized: 'yes',
            catalogCompatibility: 'capabilityChanged',
            scopeManagedEvidence: {
              ledger: true,
              tracking: true,
              sharedNativeRef: false,
            },
          }),
        ]),
      ],
      {
        installExtensionsAction: async (rollbackPlugin) => {
          await upsertManagedDeveloperInstructionsFile(configTomlPath, {
            pluginName: rollbackPlugin.manifest.name,
            value: `rollback-from-${rollbackPlugin.manifest.version ?? 'unknown'}`,
          });
        },
        uninstallExtensionsAction: async (currentPluginMeta) => {
          await removeManagedDeveloperInstructionsFile(configTomlPath, currentPluginMeta.manifest.name);
        },
        uninstallExtensionsError: 'artifact cleanup boom',
      },
    );

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('artifact cleanup boom');

    expect(codex.reinstallExtensionsCalls).toEqual([]);
    await expect(readManagedCodexInstruction(configTomlPath, plugin.manifest.name)).resolves.toBe(
      legacyInstruction,
    );
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          artifacts: [
            {
              path: configTomlPath,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('marks the ledger degraded with native write semantics when post-uninstall skill trigger rematerialization fails', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(embeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: plugin,
      source: 'currentCatalog',
    };
    await localMarketplaceModule.writeInstalledLedger(
      {
        ...localMarketplaceModule.createAvailableLedger(),
        plugins: {
          [plugin.manifest.name]: {
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
                sharedNativeRefs: {
                  user: true,
                  projects: [],
                },
              },
            },
          },
        },
      },
      env,
    );
    vi.spyOn(
      skillTriggerPreferencesModule,
      'rematerializeSkillTriggerPreferenceAfterUninstall',
    ).mockRejectedValueOnce(new Error('rematerialize boom'));

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'user', [
                makePluginStatus(plugin.manifest.name, {
                  native: {
                    marketplaceRegistered: true,
                    pluginAvailable: true,
                    pluginInstalled: true,
                    version: '0.1.0',
                  },
                  scopeInitialized: 'yes',
                  scopeManagedEvidence: {
                    ledger: true,
                    tracking: false,
                    sharedNativeRef: true,
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('rematerialize boom');

    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('does not rematerialize the shared Codex runtime for project-scope uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: plugin,
      source: 'currentCatalog',
    };
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await localMarketplaceModule.writeInstalledLedger(
      {
        ...localMarketplaceModule.createAvailableLedger(),
        plugins: {
          [plugin.manifest.name]: {
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
                  },
                },
              },
            },
          },
        },
      },
      env,
    );
    const rematerializeSpy = vi.spyOn(
      skillTriggerPreferencesModule,
      'rematerializeSkillTriggerPreferenceAfterUninstall',
    );

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  scopeInitialized: 'yes',
                  scopeManagedEvidence: {
                    ledger: true,
                    tracking: false,
                    sharedNativeRef: false,
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).resolves.toMatchObject({
      warnings: [],
    });

    expect(rematerializeSpy).not.toHaveBeenCalled();
  });

  it('uses breadcrumb-only Codex uninstall authorization without lifecycle or current catalog requirements', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const pluginName = 'recovery-only';
    const pluginId = `${pluginName}@aw`;
    await fs.ensureDir(env.AW_HOME!);

    const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, pluginId, {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, pluginName), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const [target] = await commonModule.loadPluginTargetsForCommand(
      repoRoot,
      'user',
      [pluginName],
      {
        allowHistoricalFallback: true,
        env,
      },
    );
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const lifecycleSpy = vi.spyOn(pluginScriptsModule, 'runLifecycleScript');
    const adapter = new CodexAdapter(repoRoot, env, appServerHarness.createRunner());
    const uninstallSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/uninstall').then(async () => {
      await removeCodexPluginEnabledFile(configPath, pluginId);
      await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName));
    });

    expect(target.source).toBe('historical');
    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: adapter,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [],
      repoManagedArtifacts: [],
    });
    await uninstallSideEffect;

    expect(lifecycleSpy).not.toHaveBeenCalled();
    await expect(readCodexNativeRecoveryBreadcrumb(pluginName, env)).resolves.toBeNull();
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
        marketplaces: {},
      },
    });
    expect(appServerHarness.stdinMessages.map((message) => message.json?.method)).toContain('plugin/uninstall');
  });

  it('runs Codex user native uninstall for tracking-only records when the ledger scope record is missing', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    await fs.ensureDir(env.AW_HOME!);
    await localMarketplaceModule.writeInstalledLedger(
      localMarketplaceModule.createAvailableLedger(),
      env,
    );

    const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
    const trackingDir = resolveCodexPaths(repoRoot, 'user', env).trackingDir;
    const trackedArtifact = {
      path: path.join(trackingDir, 'git-commit.rule'),
      kind: 'instruction' as const,
      platform: 'codex' as const,
    };
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, plugin.manifest.name), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await upsertTrackingRecord(trackingDir, plugin.manifest.name, [trackedArtifact]);

    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(repoRoot, env, appServerHarness.createRunner());
    const commandPromise = uninstallTargetsOnPlatforms(
      [target],
      ['codex'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: adapter,
          claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
        },
        env,
      },
    );

    await waitForHarnessMethod(appServerHarness, 'plugin/uninstall');
    await removeCodexPluginEnabledFile(configPath, 'git-commit@aw');
    await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', plugin.manifest.name));

    const result = await commandPromise;
    expect(result.repoManagedArtifacts).toEqual([trackedArtifact]);
    expect(appServerHarness.stdinMessages.map((message) => message.json?.method)).toContain('plugin/uninstall');
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {},
    });
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {},
        marketplaces: {},
      },
    });
  });

  it('fails breadcrumb-only uninstall when RPC succeeds but native post-check still sees enabled config and cache', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const pluginName = 'post-check-fails';
    const pluginId = `${pluginName}@aw`;
    await fs.ensureDir(env.AW_HOME!);

    const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, pluginId, {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, pluginName), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const [target] = await commonModule.loadPluginTargetsForCommand(
      repoRoot,
      'user',
      [pluginName],
      {
        allowHistoricalFallback: true,
        env,
      },
    );
    const adapter = new CodexAdapter(
      repoRoot,
      env,
      createFakeCodexAppServerHarness([
        {
          when: 'stdin',
          match: { method: 'initialize' },
          actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
        },
        {
          when: 'stdin',
          match: { method: 'plugin/uninstall' },
          actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } } }],
        },
      ]).createRunner(),
    );

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: adapter,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('卸载后校验失败');

    await expect(readCodexNativeRecoveryBreadcrumb(pluginName, env)).resolves.toMatchObject({
      state: 'cleanup_failed',
      reason: 'native_uninstall_post_check_failed',
    });
  });

  it('treats a disabled residual config entry as breadcrumb-only uninstall failure', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const pluginName = 'disabled-residual';
    const pluginId = `${pluginName}@aw`;
    await fs.ensureDir(env.AW_HOME!);

    const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, pluginId, {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, pluginName), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const [target] = await commonModule.loadPluginTargetsForCommand(
      repoRoot,
      'user',
      [pluginName],
      {
        allowHistoricalFallback: true,
        env,
      },
    );
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(repoRoot, env, appServerHarness.createRunner());
    const uninstallSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/uninstall').then(async () => {
      await upsertCodexPluginEnabledFile(configPath, pluginId, {
        enabled: false,
      });
      await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName));
    });

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: adapter,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('目标 config entry 仍然存在');
    await uninstallSideEffect;

    await expect(readCodexNativeRecoveryBreadcrumb(pluginName, env)).resolves.toMatchObject({
      state: 'cleanup_failed',
      reason: 'native_uninstall_post_check_failed',
    });
  });

  it('fails managed Codex user uninstall when RPC leaves invalid cache and preserves recovery bookkeeping', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const pluginName = plugin.manifest.name;
    const pluginId = `${pluginName}@aw`;
    const target: ResolvedPluginTarget = {
      pluginName,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: plugin,
      source: 'currentCatalog',
    };
    await fs.ensureDir(env.AW_HOME!);

    const paths = resolveCodexPaths(repoRoot, 'user', env);
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    const cacheVersionPath = resolveCodexNativeCacheVersionPath(env, pluginName);
    const trackedArtifact = {
      path: path.join(paths.trackingDir, 'git-commit.rule'),
      kind: 'instruction' as const,
      platform: 'codex' as const,
    };

    await upsertCodexMarketplaceFile(paths.configTomlPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(paths.configTomlPath, pluginId, {
      enabled: true,
    });
    await fs.outputFile(path.join(cacheVersionPath, 'plugin.json'), '{}\n', 'utf8');
    await upsertTrackingRecord(paths.trackingDir, pluginName, [trackedArtifact]);
    await localMarketplaceModule.writeInstalledLedger(
      {
        ...localMarketplaceModule.createAvailableLedger(),
        plugins: {
          [pluginName]: {
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
                },
                sharedNativeRefs: {
                  user: true,
                  projects: [],
                },
              },
            },
          },
        },
      },
      env,
    );
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      activeCachePath: cacheVersionPath,
      env,
    });

    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 250 }],
      },
    ]);
    const adapter = new CodexAdapter(repoRoot, env, appServerHarness.createRunner());
    const commandPromise = uninstallTargetsOnPlatforms(
      [target],
      ['codex'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: adapter,
          claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
        },
        env,
      },
    );

    await waitForHarnessMethod(appServerHarness, 'plugin/uninstall');
    await removeCodexPluginEnabledFile(paths.configTomlPath, pluginId);
    await fs.remove(path.join(cacheVersionPath, 'plugin.json'));

    await expect(commandPromise).rejects.toThrow('native cache 状态 invalid');
    await expect(readCodexNativeRecoveryBreadcrumb(pluginName, env)).resolves.toMatchObject({
      state: 'cleanup_failed',
      reason: 'native_uninstall_post_check_failed',
      lastError: expect.stringContaining('native cache 状态 invalid'),
    });
    await expect(readTrackingManifest(paths.trackingDir)).resolves.toMatchObject({
      plugins: {
        [pluginName]: {
          artifacts: [
            {
              path: trackedArtifact.path,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      plugins: {
        [pluginName]: {
          platforms: {
            codex: {
              userScope: {
                managed: true,
                capabilitySnapshot: {
                  requiresNativePlugin: true,
                },
              },
              sharedNativeRefs: {
                user: true,
                projects: [],
              },
            },
          },
        },
      },
    });
  });

  it('keeps [marketplaces.aw] while other Codex breadcrumbs or native evidence still remain', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const pluginName = 'cleanup-target';
    const pluginId = `${pluginName}@aw`;
    await fs.ensureDir(env.AW_HOME!);

    const configPath = resolveCodexPaths(repoRoot, 'user', env).configTomlPath;
    const canonicalAwHome = await fs.realpath(env.AW_HOME!);
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: canonicalAwHome,
      sourceType: 'local',
    });
    await upsertCodexPluginEnabledFile(configPath, pluginId, {
      enabled: true,
    });
    await upsertCodexPluginEnabledFile(configPath, 'other-evidence@aw', {
      enabled: true,
    });
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, pluginName), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await fs.outputFile(
      path.join(resolveCodexNativeCacheVersionPath(env, 'other-evidence'), 'plugin.json'),
      '{}\n',
      'utf8',
    );
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'other-breadcrumb',
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const [target] = await commonModule.loadPluginTargetsForCommand(
      repoRoot,
      'user',
      [pluginName],
      {
        allowHistoricalFallback: true,
        env,
      },
    );
    const appServerHarness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      },
    ]);
    const adapter = new CodexAdapter(repoRoot, env, appServerHarness.createRunner());
    const uninstallSideEffect = waitForHarnessMethod(appServerHarness, 'plugin/uninstall').then(async () => {
      await removeCodexPluginEnabledFile(configPath, pluginId);
      await fs.remove(path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName));
    });

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: adapter,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'user', [])]),
          },
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [],
      repoManagedArtifacts: [],
    });
    await uninstallSideEffect;

    await expect(readCodexNativeRecoveryBreadcrumb(pluginName, env)).resolves.toBeNull();
    await expect(readCodexNativeRecoveryBreadcrumb('other-breadcrumb', env)).resolves.toMatchObject({
      pluginName: 'other-breadcrumb',
    });
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        marketplaces: {
          aw: {
            source: canonicalAwHome,
            sourceType: 'local',
          },
        },
        plugins: {
          'other-evidence@aw': {
            enabled: true,
          },
        },
      },
    });
  });
});
