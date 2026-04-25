import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import { uninstallCommand, uninstallTargetsOnPlatforms } from '../../src/commands/uninstall.js';
import {
  readCodexConfigFile,
  removeManagedDeveloperInstructionsFile,
  upsertManagedDeveloperInstructionsFile,
} from '../../src/utils/codex-config.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveCodexPaths, resolveCodexProjectKey } from '../../src/utils/paths.js';
import { readTrackingManifest, upsertTrackingRecord } from '../../src/utils/tracking.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';

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
                  externalOwnership: {
                    present: true,
                    marketplace: 'third-party',
                    details: 'third-party owns this plugin',
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
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
    ).resolves.toEqual({
      warnings: [`[codex/${plugin.manifest.name}] post-uninstall drift`],
    });

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
});
