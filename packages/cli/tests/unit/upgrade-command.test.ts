import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import { buildCommandReceiptJson } from '../../src/output/command-receipt.js';
import type {
  GeneratedArtifact,
  InstalledDependencyEdge,
  InstalledLedger,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  ResolvedPluginTarget,
  Scope,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  readInstalledLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readInstallRecordForLocation } from '../../src/install-state/facade.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveCodexPaths } from '../../src/utils/paths.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { createMinimalPluginInstallStateFixtureBuilder } from '../helpers/minimal-plugin-install-state-fixtures.js';
import { createDependencyPluginManifest } from '../support/plugin-dependency-fixtures.js';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-unit-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(path.join(repoRoot, 'plugins'));

  return {
    repoRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_FORCE_CODEX_AVAILABLE: '1',
      AW_FORCE_CLAUDE_AVAILABLE: '1',
    },
  };
}

async function writeSyntheticPlugin(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<PluginMeta> {
  const pluginRoot = path.join(repoRoot, 'plugins', String(manifest.name));
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
  return readPluginManifest(pluginRoot);
}

function createResolvedTarget(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    embeddedPlugin: undefined,
    source: 'currentCatalog',
  };
}

async function readInstallRecord(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  plugin: string;
  platform?: PlatformName;
  scope?: Scope;
  projectKey?: string;
}) {
  return readInstallRecordForLocation({
    cwd: options.repoRoot,
    location: {
      plugin: options.plugin,
      platform: options.platform ?? 'codex',
      scope: options.scope ?? 'user',
      ...(options.scope === 'project' ? { projectKey: options.projectKey } : {}),
    },
    env: options.env,
  });
}

function mockCatalogTargets(options: {
  explicitTargets: ResolvedPluginTarget[];
  allTargets: ResolvedPluginTarget[];
  ledger: InstalledLedger;
  catalogRoot?: string;
}): void {
  vi.spyOn(commonModule, 'preparePluginTargetsForCommand').mockResolvedValue({
    ledger: options.ledger,
    warnings: [],
    targets: options.explicitTargets,
  });
  vi.spyOn(commonModule, 'loadPluginTargetsForCommand').mockResolvedValue(
    options.allTargets,
  );
  if (options.catalogRoot) {
    vi.spyOn(localMarketplaceModule, 'resolveReadOnlyCatalogResolution').mockResolvedValue({
      rootDir: options.catalogRoot,
      source: 'embedded',
    });
  }
}

function createInstallSource(kind: 'explicit' | 'dependency') {
  return kind === 'explicit'
    ? {
        kind,
        explicitlyRequested: true,
        allowsUnusedCleanup: false,
      }
    : {
        kind,
        explicitlyRequested: false,
        allowsUnusedCleanup: true,
      };
}

function createManagedCodexUserRecord(options: {
  version?: string;
  installSource?: 'explicit' | 'dependency';
  dependencyEdges?: InstalledDependencyEdge[];
}) {
  return {
    managed: true,
    updatedAt: '2026-05-06T00:00:00.000Z',
    resolvedVersion: options.version ?? '0.1.0',
    capabilitySnapshot: {
      requiresNativePlugin: true,
      hasRepoManagedArtifacts: false,
      projectManagedKinds: [],
    },
    installSource: createInstallSource(options.installSource ?? 'explicit'),
    dependencyEdges: options.dependencyEdges ?? [],
  };
}

interface UpgradeAdapterState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  nativeInstalled?: boolean;
  marketplaceRegistered?: boolean;
  failInstallExtensions?: boolean;
  artifactPath?: string;
}

class UpgradeTestAdapter implements PlatformAdapter {
  readonly installOrder: string[] = [];
  readonly uninstallOrder: string[] = [];

  constructor(
    readonly name: PlatformName,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly states: Record<string, UpgradeAdapterState> = {},
  ) {}

  private stateFor(pluginName: string): UpgradeAdapterState {
    this.states[pluginName] ??= {};
    return this.states[pluginName];
  }

  private trackingDir(scope: Scope): string {
    if (this.name === 'claude') {
      return scope === 'project'
        ? path.join(this.cwd, '.claude')
        : path.join(this.cwd, '.claude-user');
    }
    return resolveCodexPaths(this.cwd, scope, this.env).trackingDir;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    const state = this.stateFor(plugin.manifest.name);
    state.nativeInstalled = true;
    state.marketplaceRegistered = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.stateFor(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const state = this.stateFor(plugin.manifest.name);
    this.installOrder.push(plugin.manifest.name);
    if (state.failInstallExtensions) {
      throw new Error(`simulated installExtensions failure for ${plugin.manifest.name}`);
    }

    const trackingDir = this.trackingDir(scope);
    const artifactPath = path.join(trackingDir, `${plugin.manifest.name}.${this.name}.txt`);
    await fs.ensureDir(path.dirname(artifactPath));
    await fs.writeFile(artifactPath, `${this.name}:${plugin.manifest.name}`, 'utf8');
    state.scopeInitialized = 'yes';
    state.artifactPath = artifactPath;

    return [{
      path: artifactPath,
      kind: 'instruction',
      platform: this.name,
      artifactKey: `${plugin.manifest.name}.${this.name}`,
    }];
  }

  async uninstallExtensions(
    plugin: PluginMeta,
    _scope: Scope,
    _generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void> {
    const state = this.stateFor(plugin.manifest.name);
    this.uninstallOrder.push(plugin.manifest.name);
    if (state.artifactPath) {
      await fs.remove(state.artifactPath).catch(() => undefined);
    }
    state.artifactPath = undefined;
    state.scopeInitialized = 'no';
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const state = this.stateFor(plugin.manifest.name);
    const generatedArtifacts = state.artifactPath
      ? [{
          path: state.artifactPath,
          exists: await fs.pathExists(state.artifactPath),
          kind: 'instruction' as const,
          artifactKey: `${plugin.manifest.name}.${this.name}`,
        }]
      : [];

    return {
      platform: this.name,
      scope,
      initialized:
        state.scopeInitialized === 'yes' ||
        state.nativeInstalled === true,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: state.marketplaceRegistered === true,
          pluginAvailable: true,
          pluginInstalled: state.nativeInstalled === true,
          version: plugin.manifest.version,
        },
        generatedArtifacts,
        driftWarnings: [],
        ledgerStateStatus: 'available',
        ledgerStateReason: null,
        scopeInitialized: state.scopeInitialized ?? 'no',
        catalogCompatibility: 'current',
        platformRuntimeEvidence: {
          present: false,
        },
        platformNativeFallbackEvidence: {
          present: false,
        },
        scopeManagedEvidence: {
          ledger: state.scopeInitialized === 'yes',
          tracking: generatedArtifacts.length > 0,
          sharedNativeRef: state.nativeInstalled === true,
        },
        currentCatalog: {
          rootDir: '/synthetic',
          source: 'embedded',
          available: true,
        },
        artifactsInitialized: generatedArtifacts.every((artifact) => artifact.exists),
        repoManagedSessionState: {
          instructions: generatedArtifacts.length > 0 ? 'visible' : 'absent',
          rules: 'not_applicable',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      }],
    };
  }
}

class RootCheckingUpgradeAdapter extends UpgradeTestAdapter {
  readonly upgradedBundleRoots: string[] = [];

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    this.upgradedBundleRoots.push(plugin.rootDir);
    expect(await fs.pathExists(path.join(plugin.rootDir, '.agents-plugin', 'plugin.json'))).toBe(true);
    return super.installExtensions(plugin, scope);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('upgrade command dependency graph', () => {
  it('pins current catalog cache targets before explicit upgrade rebuilds the local marketplace', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const catalogRoot = path.join(String(env.AW_HOME), 'catalog-cache', 'entries', 'current', 'package');
    await fs.ensureDir(path.join(catalogRoot, '.claude-plugin'));
    await fs.ensureDir(path.join(catalogRoot, '.agents'));
    const plugin = await writeSyntheticPlugin(catalogRoot, {
      ...createDependencyPluginManifest({
        name: 'cache-backed-upgrade',
      }),
      compatibility: {
        aw: {
          minVersion: '0.0.0',
        },
      },
    });

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [plugin.manifest.name]: {
          lastResolvedVersion: plugin.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: plugin.manifest.version,
              }),
            },
          },
        },
      },
    }, env);

    const target = createResolvedTarget(plugin);
    const preparedLedger = await readInstalledLedger(env);
    mockCatalogTargets({
      explicitTargets: [target],
      allTargets: [target],
      ledger: preparedLedger,
      catalogRoot,
    });
    vi.spyOn(commonModule, 'prepareCommandEnvironment').mockImplementation(async () => {
      await fs.remove(path.join(String(env.AW_HOME), 'catalog-cache'));
      return {
        ledger: preparedLedger,
        warnings: [],
        marketplace: {
          rootDir: String(env.AW_HOME),
          source: 'local' as const,
          changed: true,
          mode: 'runtimeWritable' as const,
          catalog: {
            rootDir: String(env.AW_HOME),
            source: 'local' as const,
          },
        },
      };
    });

    const codex = new RootCheckingUpgradeAdapter('codex', repoRoot, env, {
      [plugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    await upgradeCommand(
      [plugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new UpgradeTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(codex.upgradedBundleRoots).toHaveLength(1);
    expect(codex.upgradedBundleRoots[0]).toContain('.aw-current-catalog-source-');
    expect(codex.upgradedBundleRoots[0]).toContain(
      path.join(String(env.TMPDIR), 'aw-cli', 'current-catalog-sources'),
    );
  });

  it('marks explicitly upgraded auto dependencies as requested while preserving dependency kind', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'upgraded-auto-dependency',
    }));

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [plugin.manifest.name]: {
          lastResolvedVersion: plugin.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: plugin.manifest.version,
                installSource: 'dependency',
              }),
            },
          },
        },
      },
    }, env);

    const explicitTarget = createResolvedTarget(plugin);
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [plugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    await upgradeCommand(
      [plugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new UpgradeTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect((await readInstalledLedger(env)).plugins[plugin.manifest.name]?.platforms.codex?.userScope).toMatchObject({
      installSource: {
        kind: 'dependency',
        explicitlyRequested: true,
        allowsUnusedCleanup: false,
      },
      dependencyEdges: [],
    });
  });

  it('installs missing dependencies, upgrades existing dependencies, and preserves receipt dependency metadata', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const existingChild = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'existing-upgrade-child',
    }));
    const missingChild = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'missing-upgrade-child',
    }));
    const parent = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'upgrade-parent',
      dependencies: [
        { name: existingChild.manifest.name },
        { name: missingChild.manifest.name },
      ],
    }));

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [existingChild.manifest.name]: {
          lastResolvedVersion: existingChild.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: existingChild.manifest.version,
              }),
            },
          },
        },
        [parent.manifest.name]: {
          lastResolvedVersion: parent.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: parent.manifest.version,
                dependencyEdges: [{
                  dependency: {
                    plugin: existingChild.manifest.name,
                    platform: 'codex',
                    scope: 'user',
                    projectKey: null,
                  },
                  declaration: {
                    name: existingChild.manifest.name,
                  },
                }],
              }),
            },
          },
        },
      },
    }, env);

    const explicitTarget = createResolvedTarget(parent);
    const existingDependencyTarget = createResolvedTarget(existingChild);
    const missingDependencyTarget = createResolvedTarget(missingChild);
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [
        explicitTarget,
        existingDependencyTarget,
        missingDependencyTarget,
      ],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [existingChild.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
      [parent.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    const result = await upgradeCommand(
      [parent.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new UpgradeTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(codex.installOrder).toEqual([
      existingChild.manifest.name,
      missingChild.manifest.name,
      parent.manifest.name,
    ]);

    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: missingChild.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          installSource: {
            kind: 'dependency',
            explicitlyRequested: false,
          },
        },
      },
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: parent.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          dependencyEdges: [
            {
              dependency: {
                plugin: existingChild.manifest.name,
                platform: 'codex',
                scope: 'user',
              },
              declaration: {
                name: existingChild.manifest.name,
              },
            },
            {
              dependency: {
                plugin: missingChild.manifest.name,
                platform: 'codex',
                scope: 'user',
              },
              declaration: {
                name: missingChild.manifest.name,
              },
            },
          ],
        },
      },
    });

    const receipt = buildCommandReceiptJson('upgrade', {
      result,
      groups: [{
        scope: 'user',
        platforms: result.platforms,
        plugins: result.plugins,
      }],
    });
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      command: 'upgrade',
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ description: expect.any(String) })],
      targets: expect.arrayContaining([
        expect.objectContaining({
          plugin: parent.manifest.name,
          requested: true,
        }),
        expect.objectContaining({
          plugin: existingChild.manifest.name,
          requested: false,
          dependencyOf: [{
            plugin: parent.manifest.name,
            platform: 'codex',
            scope: 'user',
          }],
        }),
        expect.objectContaining({
          plugin: missingChild.manifest.name,
          requested: false,
          dependencyOf: [{
            plugin: parent.manifest.name,
            platform: 'codex',
            scope: 'user',
          }],
        }),
      ]),
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: parent.manifest.name,
            platform: 'codex',
            scope: 'user',
          }),
          action: 'upgrade',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: existingChild.manifest.name,
            platform: 'codex',
            scope: 'user',
          }),
          action: 'upgradeDependency',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: missingChild.manifest.name,
            platform: 'codex',
            scope: 'user',
          }),
          action: 'installDependency',
          state: 'completed',
        }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({
          plugin: parent.manifest.name,
          type: 'upgrade',
        }),
        expect.objectContaining({
          plugin: existingChild.manifest.name,
          type: 'upgradeDependency',
          requested: false,
        }),
        expect.objectContaining({
          plugin: missingChild.manifest.name,
          type: 'installDependency',
          requested: false,
        }),
      ]),
    });
  });

  it('keeps old dependency refs until the parent upgrade succeeds and rolls back new auto dependencies on failure', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const oldChild = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'old-upgrade-child',
    }));
    const newChild = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'new-upgrade-child',
    }));
    const parent = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'failing-upgrade-parent',
      dependencies: [{ name: newChild.manifest.name }],
    }));

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [oldChild.manifest.name]: {
          lastResolvedVersion: oldChild.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: oldChild.manifest.version,
              }),
            },
          },
        },
        [parent.manifest.name]: {
          lastResolvedVersion: parent.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: parent.manifest.version,
                dependencyEdges: [{
                  dependency: {
                    plugin: oldChild.manifest.name,
                    platform: 'codex',
                    scope: 'user',
                    projectKey: null,
                  },
                  declaration: {
                    name: oldChild.manifest.name,
                  },
                }],
              }),
            },
          },
        },
      },
    }, env);

    const explicitTarget = createResolvedTarget(parent);
    const newDependencyTarget = createResolvedTarget(newChild);
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, newDependencyTarget],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [oldChild.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
      [parent.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
        failInstallExtensions: true,
      },
    });

    await expect(
      upgradeCommand(
        [parent.manifest.name],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new UpgradeTestAdapter('claude', repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow('simulated installExtensions failure for failing-upgrade-parent');

    expect(codex.installOrder).toEqual([
      newChild.manifest.name,
      parent.manifest.name,
    ]);
    expect(codex.uninstallOrder).toContain(newChild.manifest.name);

    const ledger = await readInstalledLedger(env);
    expect(ledger.plugins[parent.manifest.name]?.platforms.codex?.userScope?.dependencyEdges).toEqual([
      {
        dependency: {
          plugin: oldChild.manifest.name,
          platform: 'codex',
          scope: 'user',
          projectKey: null,
        },
        declaration: {
          name: oldChild.manifest.name,
        },
      },
    ]);
    expect(ledger.plugins[newChild.manifest.name]).toBeUndefined();
  });

  it('preflights dependency required config before any upgrade write and points to the dependency plugin', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const configuredChild = await writeSyntheticPlugin(repoRoot, {
      ...createDependencyPluginManifest({
        name: 'config-required-child',
      }),
      config: {
        schema: {
          token: {
            type: 'string',
            required: true,
            sensitive: true,
          },
        },
      },
    });
    const parent = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'config-parent',
      dependencies: [{ name: configuredChild.manifest.name }],
    }));

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [parent.manifest.name]: {
          lastResolvedVersion: parent.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: parent.manifest.version,
              }),
            },
          },
        },
      },
    }, env);

    const explicitTarget = createResolvedTarget(parent);
    const dependencyTarget = createResolvedTarget(configuredChild);
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [parent.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    await expect(
      upgradeCommand(
        [parent.manifest.name],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new UpgradeTestAdapter('claude', repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow(
      'config-required-child requires valid AW config before install/upgrade: token.',
    );

    expect(codex.installOrder).toEqual([]);
  });

  it('fails upgrade scope preflight before required config when the sibling scope is already healthy', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-duplicate-')),
    );
    tempDirs.push(builder.paths.rootDir);
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    } satisfies NodeJS.ProcessEnv;
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const pluginName = 'duplicate-upgrade-plugin';
    const userTarget = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'user',
    });
    const projectTarget = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    await builder.writeRepoArtifact(userTarget);
    const userLifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
    const userRecord = await builder.writeInstallRecord(userTarget, userLifecycle);
    await builder.writeDiagnosticCache(userTarget);
    await builder.writeExternalNativeEvidence(userTarget);
    await builder.writeRepoArtifact(projectTarget);
    const projectLifecycle = await builder.writeHistoricalLifecycleRuntime(projectTarget);
    const projectRecord = await builder.writeInstallRecord(projectTarget, projectLifecycle);
    await builder.writeDiagnosticCache(projectTarget);
    await builder.writeProjectIdentity(projectTarget);
    await builder.writeDependencyIndex([
      { target: userTarget, record: userRecord },
      { target: projectTarget, record: projectRecord },
    ]);

    const plugin = await writeSyntheticPlugin(builder.paths.repoRoot, {
      ...createDependencyPluginManifest({
        name: pluginName,
      }),
      config: {
        schema: {
          token: {
            type: 'string',
            required: true,
          },
        },
      },
    });
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [pluginName]: {
          lastResolvedVersion: plugin.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: plugin.manifest.version,
              }),
            },
          },
        },
      },
    }, env);

    const target = createResolvedTarget(plugin);
    mockCatalogTargets({
      explicitTargets: [target],
      allTargets: [target],
      ledger: await readInstalledLedger(env),
      catalogRoot: builder.paths.repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', builder.paths.repoRoot, env, {
      [pluginName]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    await expect(
      upgradeCommand(
        [pluginName],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new UpgradeTestAdapter('claude', builder.paths.repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow(/duplicateInstall/);

    expect(codex.installOrder).toEqual([]);
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName,
      scope: 'user',
      cwd: builder.paths.repoRoot,
      env,
    }))).resolves.toBe(false);
  });

  it('expands explicit --platform both by each plugin current manifest support', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexOnly = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'upgrade-codex-only',
      products: ['codex'],
    }));
    const claudeOnly = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'upgrade-claude-only',
      products: ['claude'],
    }));
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [codexOnly.manifest.name]: {
          lastResolvedVersion: codexOnly.manifest.version,
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: codexOnly.manifest.version,
              }),
            },
          },
        },
        [claudeOnly.manifest.name]: {
          lastResolvedVersion: claudeOnly.manifest.version,
          platforms: {
            claude: {
              userScope: createManagedCodexUserRecord({
                version: claudeOnly.manifest.version,
              }),
            },
          },
        },
      },
    }, env);

    const codexTarget = createResolvedTarget(codexOnly);
    const claudeTarget = createResolvedTarget(claudeOnly);
    mockCatalogTargets({
      explicitTargets: [codexTarget, claudeTarget],
      allTargets: [codexTarget, claudeTarget],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [codexOnly.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });
    const claude = new UpgradeTestAdapter('claude', repoRoot, env, {
      [claudeOnly.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    const result = await upgradeCommand(
      [codexOnly.manifest.name, claudeOnly.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'both',
      },
      {
        env,
        adapters: {
          codex,
          claude,
        },
      },
    );

    expect(result.platforms).toEqual(['codex', 'claude']);
    expect(codex.installOrder).toEqual([codexOnly.manifest.name]);
    expect(claude.installOrder).toEqual([claudeOnly.manifest.name]);
  });

  it('rejects upgrade --all takeover before any write', async () => {
    const { repoRoot, env } = await makeWorkspace();

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          takeoverSharedRuntime: true,
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex: new UpgradeTestAdapter('codex', repoRoot, env),
            claude: new UpgradeTestAdapter('claude', repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow('`upgrade --all` 不支持 `--takeover-shared-runtime`');
  });

  it('does not auto-upgrade legacy installed versions during upgrade --all', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await writeSyntheticPlugin(repoRoot, {
      name: 'legacy-version-plugin',
      version: '0.2.0',
      description: 'legacy version guard',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
    });

    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [plugin.manifest.name]: {
          lastResolvedVersion: 'workspace',
          platforms: {
            codex: {
              userScope: createManagedCodexUserRecord({
                version: 'workspace',
              }),
            },
          },
        },
      },
    }, env);

    const target = createResolvedTarget(plugin);
    mockCatalogTargets({
      explicitTargets: [target],
      allTargets: [target],
      ledger: await readInstalledLedger(env),
      catalogRoot: repoRoot,
    });

    const codex = new UpgradeTestAdapter('codex', repoRoot, env, {
      [plugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    const result = await upgradeCommand(
      [],
      {
        all: true,
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new UpgradeTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(codex.installOrder).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        plugin: plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
        code: 'repairRequired',
        reason: expect.stringContaining('installed ledger resolvedVersion'),
      }),
    ]);
  });
});
