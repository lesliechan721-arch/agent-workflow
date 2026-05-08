import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import * as projectBoundaryModule from '../../src/install-state/project-boundary.js';
import {
  installCommand,
  installTargetsOnPlatforms,
} from '../../src/commands/install.js';
import { buildCommandReceiptJson, renderCommandReceipt } from '../../src/output/command-receipt.js';
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
  inspectGlobalDependencyIndex,
  readDynamicArtifactDiagnosticCacheAt,
  readInstallRecordForLocation,
  readNativeTransactionMarker,
  readProjectArtifactIdentityForLocator,
  writeNativeTransactionMarker,
} from '../../src/install-state/facade.js';
import type { NativeTransactionMarker } from '../../src/install-state/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexProjectKey,
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import {
  createProjectArtifactSharedLocator,
  getDiagnosticCachePath,
  getProjectArtifactSharedIdentityPath,
} from '../../src/install-state/paths.js';
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

async function readDependencyIndex(env: NodeJS.ProcessEnv) {
  const inspection = await inspectGlobalDependencyIndex(env);
  expect(inspection.status).toBe('ok');
  if (inspection.status !== 'ok') {
    throw new Error(`dependency index unavailable: ${inspection.status}`);
  }
  return inspection.value;
}

function makeNativeInstallMarker(pluginName: string): NativeTransactionMarker {
  return {
    version: 1,
    pluginName,
    pluginId: `${pluginName}@aw`,
    platform: 'codex',
    scope: 'user',
    operation: 'install',
    nativeWriteSucceeded: true,
    createdAt: '2026-05-04T00:00:00.000Z',
    updatedAt: '2026-05-04T00:00:00.000Z',
  };
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

describe('install command P6 install-state semantics', () => {
  it('repairs a marker-backed Codex user install without creating snapshots before native write, then clears the marker and native-write degraded ledger', async () => {
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
    await writeNativeTransactionMarker(makeNativeInstallMarker(plugin.manifest.name), env);

    let snapshotCopyObservedWithMarker = false;
    const originalCopy = fs.copy.bind(fs);
    vi.spyOn(fs, 'copy').mockImplementation(async (...args: Parameters<typeof fs.copy>) => {
      if (path.resolve(String(args[0])) === path.resolve(plugin.rootDir)) {
        const marker = await readNativeTransactionMarker(plugin.manifest.name, env);
        snapshotCopyObservedWithMarker = Boolean(
          marker.status === 'ok' && marker.value.operation === 'install',
        );
      }
      return originalCopy(...args);
    });

    const codex = new FakeCodexAdapter(env, {
      onInstallPlugin: async (currentPlugin) => {
        await expect(
          fs.pathExists(path.join(env.AW_HOME!, 'plugin-install-snapshots')),
        ).resolves.toBe(false);
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

    expect(snapshotCopyObservedWithMarker).toBe(true);
    await expect(readNativeTransactionMarker(plugin.manifest.name, env)).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          pluginName: plugin.manifest.name,
          native: {
            pluginId: `${plugin.manifest.name}@aw`,
          },
        },
      },
    });
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {},
    });
  });

  it('keeps the native marker when snapshot persistence fails and does not write a success record', async () => {
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
      onInstallPlugin: async () => {},
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
    ).rejects.toThrow('AW 安装未完成');

    await expect(readNativeTransactionMarker(plugin.manifest.name, env)).resolves.toMatchObject({
      status: 'ok',
      value: {
        pluginName: plugin.manifest.name,
        operation: 'install',
        lastError: 'simulated snapshot copy failure',
      },
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {},
    });
  });

  it('fails after successful install when marker cleanup fails, while preserving the committed install record', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    await writeInstalledLedger(createAvailableLedger(), env);

    const markerPath = path.join(env.AW_HOME!, 'native-recovery', 'codex', 'user', `${plugin.manifest.name}@aw.json`);
    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (...args: Parameters<typeof fs.remove>) => {
      if (path.resolve(String(args[0])) === path.resolve(markerPath)) {
        throw new Error('simulated marker delete failure');
      }
      return originalRemove(...args);
    });

    const codex = new FakeCodexAdapter(env, {
      onInstallPlugin: async () => {},
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
    ).rejects.toThrow('native transaction marker 清理失败');

    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          pluginName: plugin.manifest.name,
        },
      },
    });
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {},
    });
    await expect(readNativeTransactionMarker(plugin.manifest.name, env)).resolves.toMatchObject({
      status: 'ok',
      value: {
        pluginName: plugin.manifest.name,
      },
    });
  });

  it('fails marker-only install when the current catalog no longer contains the plugin and suggests uninstall cleanup', async () => {
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
    await writeNativeTransactionMarker(makeNativeInstallMarker('git-commit'), env);
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

    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: childPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          installSource: {
            kind: 'dependency',
            explicitlyRequested: false,
          },
          dependencyEdges: [],
        },
      },
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: parentPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          installSource: {
            kind: 'explicit',
            explicitlyRequested: true,
          },
          dependencyEdges: [{
            dependency: {
              plugin: childPlugin.manifest.name,
              platform: 'codex',
              scope: 'user',
            },
            declaration: {
              name: childPlugin.manifest.name,
            },
          }],
        },
      },
    });
    await expect(readDependencyIndex(env)).resolves.toMatchObject({
      records: expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({
            plugin: parentPlugin.manifest.name,
          }),
          dependencyEdges: [
            expect.objectContaining({
              dependency: expect.objectContaining({
                plugin: childPlugin.manifest.name,
              }),
            }),
          ],
        }),
      ]),
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
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: parentPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          dependencyEdges: [
            expect.objectContaining({
              dependency: expect.objectContaining({
                plugin: childPlugin.manifest.name,
              }),
            }),
          ],
        },
      },
    });
  });

  it('surfaces receipt file categories and suppresses shared-owner takeover copy for Codex repo-local triggers', () => {
    const rawReceipt = {
      result: {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: [],
        receiptDetails: {
          privateStateFiles: [{ path: '/tmp/workspace/.codex/.agent-workflows/records/git-commit.json' }],
          ignoredStateFiles: [{ path: '/tmp/workspace/.gitignore', repoRelativePath: '.gitignore' }],
          sharedConfigFiles: [{ path: '/tmp/workspace/.agent-workflows/plugin-config/git-commit/config.json' }],
          projectArtifactIdentityFiles: [{
            path: '/tmp/workspace/.agent-workflows/project-artifacts/codex/git-commit.identity.json',
            sharedIdentityId: 'git-commit.identity',
          }],
          nativeTransactionMarker: {
            status: 'recordInstallResidual' as const,
            recordCommitted: true,
            markerPending: true,
            needsAttention: true,
            repairCommand: 'aw repair git-commit -p codex -s project',
            cleanupCommand: 'aw cleanup git-commit -p codex -s project',
          },
          dependencyIndex: {
            trusted: false,
            coverageReason: ['indexMissing'],
            verifiedLocations: [],
            revisitLocations: [],
            recoveryMessage: '请回到可能相关的仓库重新运行 diagnose 或 repair。',
          },
          staleProjectReferences: [{
            location: {
              plugin: 'git-commit',
              platform: 'codex',
              scope: 'project' as const,
              projectKey: '/tmp/workspace',
            },
            recordPath: '/tmp/workspace/.codex/.agent-workflows/records/git-commit.json',
          }],
          sharedSkillTriggerOwner: {
            present: true,
            needsTakeover: false,
            ownerConflict: false,
            suppressedOwnerConflict: true,
          },
        },
      },
      groups: [{
        scope: 'project' as const,
        platforms: ['codex'],
        plugins: ['git-commit'],
      }],
    };
    const receipt = buildCommandReceiptJson('install', rawReceipt);

    expect(receipt).toMatchObject({
      privateStateFiles: [{ path: '/tmp/workspace/.codex/.agent-workflows/records/git-commit.json' }],
      ignoredStateFiles: [{ repoRelativePath: '.gitignore' }],
      sharedConfigFiles: [{ path: '/tmp/workspace/.agent-workflows/plugin-config/git-commit/config.json' }],
      projectArtifactIdentityFiles: [{ sharedIdentityId: 'git-commit.identity' }],
      nativeTransactionMarker: {
        status: 'recordInstallResidual',
        recordCommitted: true,
        markerPending: true,
        needsAttention: true,
      },
      dependencyIndex: {
        trusted: false,
        coverageReason: ['indexMissing'],
        recoveryMessage: '请回到可能相关的仓库重新运行 diagnose 或 repair。',
      },
      staleProjectReferences: [{
        recordPath: '/tmp/workspace/.codex/.agent-workflows/records/git-commit.json',
      }],
      sharedSkillTriggerOwner: {
        suppressedOwnerConflict: true,
        needsTakeover: false,
      },
    });

    const human = renderCommandReceipt('install', rawReceipt).join('\n');
    expect(human).toContain('主要安装已经完成，但还需要收口本机原生状态');
    expect(human).toContain('已更新团队共享配置。');
    expect(human).toContain('已更新共享身份文件。');
    expect(human).toContain('已更新 AW 本地状态。');
    expect(human).toContain('当前项目的 repo-local skill trigger 已按本地项目路径处理');
    expect(human).not.toContain('takeoverRequired');
    expect(human).not.toContain('ownerConflict');
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
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: childPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
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
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: childPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: parentPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
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
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: parentPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: childPlugin.manifest.name,
    })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('writes project shared identity for repo-visible artifacts alongside the per-plugin install record', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'project-shared-identity',
      products: ['codex'],
    }));
    await fs.writeJson(
      path.join(plugin.rootDir, '.agents-plugin', 'plugin.json'),
      {
        ...plugin.manifest,
        extensions: {
          instructions: [{
            name: 'project-note',
            title: 'Project Note',
            content: 'Project managed instruction fixture.',
            paths: ['docs/**'],
          }],
        },
      },
      { spaces: 2 },
    );
    const refreshedPlugin = await readPluginManifest(plugin.rootDir);
    vi.spyOn(projectBoundaryModule, 'ensureProjectPrivateStateIgnore').mockResolvedValue({
      status: 'alreadyIgnored',
      targetRelativePath: '.codex/.agent-workflows',
      ignoreFilePath: path.join(repoRoot, '.gitignore'),
      pattern: '.codex/.agent-workflows/',
      matchedPattern: '.codex/.agent-workflows/',
    });
    vi.spyOn(projectBoundaryModule, 'assertProjectArtifactIdentityPathVisible').mockResolvedValue();
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await writeInstalledLedger(createAvailableLedger(), env);

    const repoVisibleArtifactPath = path.join(repoRoot, 'docs', 'git-commit.instructions.md');
    const codex = new FakeCodexAdapter(env, {
      onInstallExtensions: async () => {
        await fs.ensureDir(path.dirname(repoVisibleArtifactPath));
        await fs.writeFile(repoVisibleArtifactPath, '# install artifact\n', 'utf8');
        return [{
          path: repoVisibleArtifactPath,
          kind: 'instruction',
          platform: 'codex',
          artifactKey: `${plugin.manifest.name}.project-doc`,
        }];
      },
    });

    await installTargetsOnPlatforms(
      [{
          pluginName: plugin.manifest.name,
        plugin: refreshedPlugin,
        currentPlugin: refreshedPlugin,
        embeddedPlugin: undefined,
        source: 'currentCatalog',
      }],
      ['codex'],
      {
        cwd: repoRoot,
        scope: 'project',
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

    const recordRead = await readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    expect(recordRead).toMatchObject({
      status: 'ok',
      value: {
        record: {
          pluginName: plugin.manifest.name,
          scope: 'project',
          projectKey,
        },
      },
    });
    if (recordRead.status !== 'ok') {
      throw new Error(`expected install record for ${plugin.manifest.name}`);
    }

    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'codex',
      repoRoot,
      projectRoot: repoRoot,
    });
    const identityRead = await readProjectArtifactIdentityForLocator({
      repoRoot,
      locator,
      cwd: repoRoot,
    });
    expect(identityRead).toMatchObject({
      status: 'ok',
      value: {
        locator,
        artifacts: [
          expect.objectContaining({
            kind: 'instruction',
            platform: 'codex',
            path: 'docs/git-commit.instructions.md',
            artifactKey: `${plugin.manifest.name}.project-doc`,
          }),
        ],
      },
    });
    if (identityRead.status !== 'ok') {
      throw new Error(`expected project artifact identity for ${plugin.manifest.name}`);
    }

    expect(identityRead.value.sharedIdentityId).toBe(
      path.basename(getProjectArtifactSharedIdentityPath({ repoRoot, locator }), '.json'),
    );
    expect(identityRead.value.sharedIdentityId).not.toBe(recordRead.value.recordId);
  });

  it('refuses project-scope install when an adoptable shared identity already exists without a local record', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'project-adopt-existing',
      products: ['codex'],
    }));
    await fs.writeJson(
      path.join(plugin.rootDir, '.agents-plugin', 'plugin.json'),
      {
        ...plugin.manifest,
        extensions: {
          instructions: [{
            name: 'project-note',
            title: 'Project Note',
            content: 'Project managed instruction fixture.',
            paths: ['docs/**'],
          }],
        },
      },
      { spaces: 2 },
    );
    const refreshedPlugin = await readPluginManifest(plugin.rootDir);
    vi.spyOn(projectBoundaryModule, 'ensureProjectPrivateStateIgnore').mockResolvedValue({
      status: 'alreadyIgnored',
      targetRelativePath: '.codex/.agent-workflows',
      ignoreFilePath: path.join(repoRoot, '.gitignore'),
      pattern: '.codex/.agent-workflows/',
      matchedPattern: '.codex/.agent-workflows/',
    });
    vi.spyOn(projectBoundaryModule, 'assertProjectArtifactIdentityPathVisible').mockResolvedValue();
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await writeInstalledLedger(createAvailableLedger(), env);

    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'codex',
      repoRoot,
      projectRoot: repoRoot,
    });
    const sharedIdentityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
    await fs.ensureDir(path.dirname(sharedIdentityPath));
    await fs.writeJson(sharedIdentityPath, {
      version: 1,
      sharedIdentityId: path.basename(sharedIdentityPath, '.json'),
      locator,
      source: {
        pluginVersion: plugin.manifest.version,
        manifestDigest: 'synthetic-manifest-digest',
        bundleFingerprint: 'synthetic-bundle-fingerprint',
      },
      generatedAt: '2026-05-08T00:00:00.000Z',
      artifacts: [{
        kind: 'instruction',
        platform: 'codex',
        path: 'docs/existing-instructions.md',
      }],
    }, { spaces: 2 });

    await expect(
      installTargetsOnPlatforms(
        [{
          pluginName: plugin.manifest.name,
          plugin: refreshedPlugin,
          currentPlugin: refreshedPlugin,
          embeddedPlugin: undefined,
          source: 'currentCatalog',
        }],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex: new FakeCodexAdapter(env),
            claude: new FakeClaudeAdapter(),
          },
          resolveInstallOptions: () => resolvedInstallOptions(),
          skipConfigPreflight: true,
          skipWriteSafetyPreflight: true,
        },
      ),
    ).rejects.toThrow(
      `aw repair ${plugin.manifest.name} --platform codex --scope project --adopt-existing`,
    );

    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
      platform: 'codex',
      scope: 'project',
      projectKey,
    })).resolves.toMatchObject({
      status: 'missing',
    });

    const diagnosticCachePath = getDiagnosticCachePath(
      repoRoot,
      {
        plugin: plugin.manifest.name,
        platform: 'codex',
        scope: 'project',
        projectKey,
      },
      env,
    );
    await expect(
      readDynamicArtifactDiagnosticCacheAt(diagnosticCachePath, {
        expectedLocation: {
          plugin: plugin.manifest.name,
          platform: 'codex',
          scope: 'project',
          projectKey,
        },
      }),
    ).resolves.toMatchObject({
      status: 'unavailable',
      code: 'missing',
    });
    await expect(inspectGlobalDependencyIndex(env)).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
      plugins: {},
    });
  });
});
