import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import {
  installCommand,
  installTargetsOnPlatforms,
} from '../../src/commands/install.js';
import { buildCommandReceiptJson } from '../../src/output/command-receipt.js';
import type {
  GeneratedArtifact,
  InstalledLedger,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  ResolvedInstallOptions,
  Scope,
  StatusReport,
} from '../../src/types.js';
import { createAvailableLedger, readInstalledLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import {
  getCodexNativeRecoveryBreadcrumbPath,
  readCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../../src/utils/codex-native-recovery.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexProjectKey,
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  createDependencyPluginManifest,
  createPluginDependencyScenarioFixtures,
} from '../support/plugin-dependency-fixtures.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

  return {
    repoRoot,
    embeddedRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
      AW_FORCE_CODEX_AVAILABLE: '1',
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

interface GraphTestPluginState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  nativeInstalled?: boolean;
  marketplaceRegistered?: boolean;
  externalOwnership?: boolean;
  failInstallExtensions?: boolean;
  failUninstall?: boolean;
  artifactPath?: string;
}

class GraphTestAdapter implements PlatformAdapter {
  installOrder: string[] = [];
  uninstallOrder: string[] = [];

  constructor(
    readonly name: PlatformName,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
    readonly states: Record<string, GraphTestPluginState> = {},
  ) {}

  private stateFor(pluginName: string): GraphTestPluginState {
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
    const state = this.stateFor(plugin.manifest.name);
    if (state.failUninstall) {
      throw new Error(`simulated uninstall failure for ${plugin.manifest.name}`);
    }
    state.nativeInstalled = false;
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
    if (state.failUninstall) {
      throw new Error(`simulated uninstall failure for ${plugin.manifest.name}`);
    }
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
        externalOwnership: state.externalOwnership
          ? {
              present: true,
              marketplace: 'third-party',
              details: '同名插件已由外部 marketplace 管理。',
            }
          : undefined,
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

function createPreparedTargets(
  explicitTargets: ResolvedPluginTarget[],
  ledger: InstalledLedger,
) {
  return {
    ledger,
    warnings: [],
    targets: explicitTargets,
  };
}

function mockCatalogTargets(options: {
  explicitTargets: ResolvedPluginTarget[];
  allTargets: ResolvedPluginTarget[];
  ledger: InstalledLedger;
}): void {
  vi.spyOn(commonModule, 'preparePluginTargetsForCommand').mockResolvedValue(
    createPreparedTargets(options.explicitTargets, options.ledger),
  );
  vi.spyOn(commonModule, 'loadPluginTargetsForCommand').mockResolvedValue(
    options.allTargets,
  );
}

class FakeCodexAdapter implements PlatformAdapter {
  readonly name: PlatformName = 'codex';
  nativeInstalled = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly options: {
      onInstallPlugin?: (plugin: PluginMeta) => Promise<void> | void;
      onInstallExtensions?: (plugin: PluginMeta) => Promise<GeneratedArtifact[]> | GeneratedArtifact[];
    } = {},
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    await this.options.onInstallPlugin?.(plugin);
    this.nativeInstalled = true;
  }

  async uninstallPlugin(): Promise<void> {}

  async installExtensions(plugin: PluginMeta): Promise<GeneratedArtifact[]> {
    return await this.options.onInstallExtensions?.(plugin) ?? [];
  }

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope,
      initialized: this.nativeInstalled,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: this.nativeInstalled,
          pluginAvailable: true,
          pluginInstalled: this.nativeInstalled,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
        driftWarnings: [],
        ledgerStateStatus: 'available',
        ledgerStateReason: null,
        scopeInitialized: this.nativeInstalled ? 'yes' : 'no',
        catalogCompatibility: 'current',
        platformRuntimeEvidence: { present: false },
        platformNativeFallbackEvidence: { present: false },
        scopeManagedEvidence: {
          ledger: this.nativeInstalled,
          tracking: false,
          sharedNativeRef: this.nativeInstalled,
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
      }],
    };
  }
}

class FakeClaudeAdapter implements PlatformAdapter {
  readonly name: PlatformName = 'claude';

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}
  async uninstallPlugin(): Promise<void> {}
  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }
  async uninstallExtensions(): Promise<void> {}
  async upgradePlugin(): Promise<void> {}
  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'claude',
      scope,
      initialized: false,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: false,
          pluginAvailable: true,
          pluginInstalled: false,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
        driftWarnings: [],
        ledgerStateStatus: 'available',
        ledgerStateReason: null,
        scopeInitialized: 'no',
        catalogCompatibility: 'current',
        platformRuntimeEvidence: { present: false },
        platformNativeFallbackEvidence: { present: false },
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
      }],
    };
  }
}

function resolvedInstallOptions(): ResolvedInstallOptions {
  return {
    applicability: 'none',
    ledgerTrust: 'available',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('install command P5 snapshot and ledger semantics', () => {
  it('repairs a breadcrumb-only Codex user install without creating snapshots before native write, then clears the breadcrumb and native-write degraded ledger', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger({
      ...createAvailableLedger(),
      ledgerState: {
        status: 'degraded',
        degradedAt: '2026-05-04T00:00:00.000Z',
        reason: 'operation_interrupted_after_native_write',
      },
    }, env);
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: plugin.manifest.name,
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    let snapshotCopyObservedWithBreadcrumb = false;
    const originalCopy = fs.copy.bind(fs);
    vi.spyOn(fs, 'copy').mockImplementation(async (...args: Parameters<typeof fs.copy>) => {
      if (path.resolve(String(args[0])) === path.resolve(plugin.rootDir)) {
        const breadcrumb = await readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, env);
        snapshotCopyObservedWithBreadcrumb = Boolean(
          breadcrumb && breadcrumb.state === 'pending_after_native_write',
        );
      }
      return originalCopy(...args);
    });

    const codex = new FakeCodexAdapter(env, {
      onInstallPlugin: async (currentPlugin) => {
        await expect(
          fs.pathExists(path.join(env.AW_HOME!, 'plugin-install-snapshots')),
        ).resolves.toBe(false);
        await writeCodexNativeRecoveryBreadcrumb({
          pluginName: currentPlugin.manifest.name,
          state: 'pending_after_native_write',
          reason: 'native_write_succeeded_post_steps_pending',
          env,
        });
      },
    });

    await installTargetsOnPlatforms(
      [{
        pluginName: plugin.manifest.name,
        plugin,
        currentPlugin: plugin,
        embeddedPlugin: undefined,
        source: 'currentCatalog',
      }],
      ['codex'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new FakeClaudeAdapter(),
        },
        resolveInstallOptions: () => resolvedInstallOptions(),
        skipConfigPreflight: true,
        skipWriteSafetyPreflight: true,
      },
    );

    expect(snapshotCopyObservedWithBreadcrumb).toBe(true);
    await expect(readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, env)).resolves.toBeNull();
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {
        [plugin.manifest.name]: {
          platforms: {
            codex: {
              userScope: {
                lifecycleConfigSnapshot: expect.objectContaining({
                  pluginName: plugin.manifest.name,
                }),
              },
            },
          },
        },
      },
    });
  });

  it('updates the breadcrumb to snapshot_write_failed when snapshot persistence fails and does not write a success ledger', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(createAvailableLedger(), env);

    const originalCopy = fs.copy.bind(fs);
    vi.spyOn(fs, 'copy').mockImplementation(async (...args: Parameters<typeof fs.copy>) => {
      if (path.resolve(String(args[0])) === path.resolve(plugin.rootDir)) {
        throw new Error('simulated snapshot copy failure');
      }
      return originalCopy(...args);
    });

    const codex = new FakeCodexAdapter(env, {
      onInstallPlugin: async (currentPlugin) => {
        await writeCodexNativeRecoveryBreadcrumb({
          pluginName: currentPlugin.manifest.name,
          state: 'pending_after_native_write',
          reason: 'native_write_succeeded_post_steps_pending',
          env,
        });
      },
    });
    const reporter = {
      event: vi.fn(async () => {}),
      notice: vi.fn(async () => {}),
    };

    await expect(
      installTargetsOnPlatforms(
        [{
          pluginName: plugin.manifest.name,
          plugin,
          currentPlugin: plugin,
          embeddedPlugin: undefined,
          source: 'currentCatalog',
        }],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new FakeClaudeAdapter(),
          },
          reporter,
          resolveInstallOptions: () => resolvedInstallOptions(),
          skipConfigPreflight: true,
          skipWriteSafetyPreflight: true,
        },
      ),
    ).rejects.toThrow('AW 安装未完成');

    expect(reporter.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'native:recovery',
        data: expect.objectContaining({
          operation: 'update',
          phase: 'success',
          state: 'snapshot_write_failed',
          nativeWriteSucceeded: true,
          recoveryBreadcrumbPersisted: true,
        }),
      }),
    );

    await expect(readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, env)).resolves.toMatchObject({
      state: 'snapshot_write_failed',
      reason: 'install_snapshot_write_failed',
    });
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {},
    });
  });

  it('fails after successful install when breadcrumb cleanup fails, while preserving the successful ledger and keeping diagnostics', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(createAvailableLedger(), env);

    const breadcrumbPath = getCodexNativeRecoveryBreadcrumbPath(plugin.manifest.name, env);
    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (...args: Parameters<typeof fs.remove>) => {
      if (path.resolve(String(args[0])) === path.resolve(breadcrumbPath)) {
        throw new Error('simulated breadcrumb delete failure');
      }
      return originalRemove(...args);
    });

    const codex = new FakeCodexAdapter(env, {
      onInstallPlugin: async (currentPlugin) => {
        await writeCodexNativeRecoveryBreadcrumb({
          pluginName: currentPlugin.manifest.name,
          state: 'pending_after_native_write',
          reason: 'native_write_succeeded_post_steps_pending',
          env,
        });
      },
    });

    await expect(
      installTargetsOnPlatforms(
        [{
          pluginName: plugin.manifest.name,
          plugin,
          currentPlugin: plugin,
          embeddedPlugin: undefined,
          source: 'currentCatalog',
        }],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new FakeClaudeAdapter(),
          },
          resolveInstallOptions: () => resolvedInstallOptions(),
          skipConfigPreflight: true,
          skipWriteSafetyPreflight: true,
        },
      ),
    ).rejects.toThrow('删除 Codex native recovery breadcrumb 失败');

    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {
        [plugin.manifest.name]: {
          lastResolvedVersion: plugin.manifest.version,
        },
      },
    });
    await expect(readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, env)).resolves.toMatchObject({
      state: 'cleanup_failed',
      reason: 'install_breadcrumb_delete_failed',
    });
  });

  it('fails breadcrumb-only install when the current catalog no longer contains the plugin and suggests uninstall cleanup', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        'git-commit': {
          lastResolvedVersion: '0.1.0',
          platforms: {
            codex: {
              projectScopes: {
                [projectKey]: {
                  managed: true,
                  updatedAt: '2026-05-04T00:00:00.000Z',
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
    }, env);
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'pending_after_native_write',
      reason: 'native_write_succeeded_post_steps_pending',
      env,
    });
    await fs.remove(path.join(repoRoot, 'plugins', 'git-commit'));
    const missingEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(missingEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(missingEmbeddedRoot);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
        },
      ),
    ).rejects.toThrow(
      '请先恢复该插件到当前 catalog，或运行 `aw uninstall git-commit -p codex -s user` 清理 Codex native 残留。',
    );
  });

  it('auto-installs missing dependencies, writes parent edges after success, and exposes receipt metadata', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const childPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'same-scope-child',
    }));
    const parentPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'same-scope-parent',
      dependencies: [{ name: childPlugin.manifest.name }],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const explicitTarget = {
      pluginName: parentPlugin.manifest.name,
      plugin: parentPlugin,
      currentPlugin: parentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const dependencyTarget = {
      pluginName: childPlugin.manifest.name,
      plugin: childPlugin,
      currentPlugin: childPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env);
    const result = await installCommand(
      [parentPlugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new GraphTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(result.plugins).toEqual([parentPlugin.manifest.name]);
    expect(codex.installOrder).toEqual([
      childPlugin.manifest.name,
      parentPlugin.manifest.name,
    ]);

    const ledger = await readInstalledLedger(env);
    expect(ledger.plugins[childPlugin.manifest.name]?.platforms.codex?.userScope).toMatchObject({
      installSource: {
        kind: 'dependency',
        explicitlyRequested: false,
        allowsUnusedCleanup: true,
      },
      dependencyEdges: [],
    });
    expect(ledger.plugins[parentPlugin.manifest.name]?.platforms.codex?.userScope).toMatchObject({
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
        allowsUnusedCleanup: false,
      },
      dependencyEdges: [{
        dependency: {
          plugin: childPlugin.manifest.name,
          platform: 'codex',
          scope: 'user',
          projectKey: null,
        },
        declaration: {
          name: childPlugin.manifest.name,
        },
      }],
    });

    const receipt = buildCommandReceiptJson('install', {
      result,
      groups: [{
        scope: 'user',
        platforms: result.platforms,
        plugins: result.plugins,
      }],
    });
    expect(receipt).toMatchObject({
      command: 'install',
      targets: expect.arrayContaining([
        expect.objectContaining({
          plugin: parentPlugin.manifest.name,
          requested: true,
        }),
        expect.objectContaining({
          plugin: childPlugin.manifest.name,
          requested: false,
          dependencyOf: [{
            plugin: parentPlugin.manifest.name,
            platform: 'codex',
            scope: 'user',
          }],
        }),
      ]),
      actions: expect.arrayContaining([
        expect.objectContaining({
          plugin: parentPlugin.manifest.name,
          type: 'install',
        }),
        expect.objectContaining({
          plugin: childPlugin.manifest.name,
          type: 'installDependency',
        }),
      ]),
    });
  });

  it('does not reinstall an already satisfied dependency, but still writes the parent edge', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const childPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'existing-child',
    }));
    const parentPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'existing-parent',
      dependencies: [{ name: childPlugin.manifest.name }],
    }));
    await writeInstalledLedger({
      ...createAvailableLedger(),
      plugins: {
        [childPlugin.manifest.name]: {
          lastResolvedVersion: childPlugin.manifest.version,
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-05-06T00:00:00.000Z',
                resolvedVersion: childPlugin.manifest.version,
                capabilitySnapshot: {
                  requiresNativePlugin: true,
                  hasRepoManagedArtifacts: false,
                  projectManagedKinds: [],
                },
                installSource: {
                  kind: 'explicit',
                  explicitlyRequested: true,
                  allowsUnusedCleanup: false,
                },
                dependencyEdges: [],
              },
            },
          },
        },
      },
    }, env);

    const explicitTarget = {
      pluginName: parentPlugin.manifest.name,
      plugin: parentPlugin,
      currentPlugin: parentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const dependencyTarget = {
      pluginName: childPlugin.manifest.name,
      plugin: childPlugin,
      currentPlugin: childPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env, {
      [childPlugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    const result = await installCommand(
      [parentPlugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new GraphTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(result.receiptActions).toEqual([]);
    expect(codex.installOrder).toEqual([parentPlugin.manifest.name]);
    expect((await readInstalledLedger(env)).plugins[parentPlugin.manifest.name]?.platforms.codex?.userScope?.dependencyEdges)
      .toEqual([
        expect.objectContaining({
          dependency: expect.objectContaining({
            plugin: childPlugin.manifest.name,
          }),
        }),
      ]);
  });

  it('keeps --platform auto based on explicit targets only, without letting dependencies influence platform selection', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const childPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'claude-only-child',
      products: ['claude'],
    }));
    const parentPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'auto-parent',
      dependencies: [{
        name: childPlugin.manifest.name,
        when: {
          platforms: ['claude'],
        },
      }],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const explicitTarget = {
      pluginName: parentPlugin.manifest.name,
      plugin: parentPlugin,
      currentPlugin: parentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const dependencyTarget = {
      pluginName: childPlugin.manifest.name,
      plugin: childPlugin,
      currentPlugin: childPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env, {
      [parentPlugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    const result = await installCommand(
      [parentPlugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'auto',
      },
      {
        env,
        adapters: {
          codex,
          claude: new GraphTestAdapter('claude', repoRoot, env),
        },
      },
    );

    expect(result.platforms).toEqual(['codex']);
    expect(codex.installOrder).toEqual([parentPlugin.manifest.name]);
    expect((await readInstalledLedger(env)).plugins[childPlugin.manifest.name]).toBeUndefined();
  });

  it('fails graph preflight on dependency required config without writing state', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const childPlugin = await writeSyntheticPlugin(repoRoot, {
      ...createDependencyPluginManifest({
        name: 'config-child',
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
    const parentPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'config-parent',
      dependencies: [{ name: childPlugin.manifest.name }],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const explicitTarget = {
      pluginName: parentPlugin.manifest.name,
      plugin: parentPlugin,
      currentPlugin: parentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const dependencyTarget = {
      pluginName: childPlugin.manifest.name,
      plugin: childPlugin,
      currentPlugin: childPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env);

    await expect(
      installCommand(
        [parentPlugin.manifest.name],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new GraphTestAdapter('claude', repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow(/config-child.*token/);

    expect(codex.installOrder).toEqual([]);
    expect((await readInstalledLedger(env)).plugins).toEqual({});
  });

  it('rolls back newly auto-installed dependencies when the parent install fails before committing edges', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const childPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'rollback-child',
    }));
    const parentPlugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'rollback-parent',
      dependencies: [{ name: childPlugin.manifest.name }],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const explicitTarget = {
      pluginName: parentPlugin.manifest.name,
      plugin: parentPlugin,
      currentPlugin: parentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const dependencyTarget = {
      pluginName: childPlugin.manifest.name,
      plugin: childPlugin,
      currentPlugin: childPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [explicitTarget],
      allTargets: [explicitTarget, dependencyTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env, {
      [parentPlugin.manifest.name]: {
        failInstallExtensions: true,
      },
    });

    await expect(
      installCommand(
        [parentPlugin.manifest.name],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex,
            claude: new GraphTestAdapter('claude', repoRoot, env),
          },
        },
      ),
    ).rejects.toThrow(/rollback-parent/);

    expect(codex.installOrder).toEqual([
      childPlugin.manifest.name,
      parentPlugin.manifest.name,
    ]);
    const ledger = await readInstalledLedger(env);
    expect(ledger.plugins[parentPlugin.manifest.name]).toBeUndefined();
    expect(ledger.plugins[childPlugin.manifest.name]).toBeUndefined();
  });
});
