import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import * as projectBoundaryModule from '../../src/install-state/project-boundary.js';
import {
  disposePinnedCatalogRoot,
  installCommand,
  installTargetsOnPlatforms,
  pinCurrentCatalogTargetsForLocalMarketplaceRebuild,
} from '../../src/commands/install.js';
import { buildCommandReceiptJson, renderCommandReceipt } from '../../src/output/command-receipt.js';
import type {
  AgentVersionGateErrorPayload,
  GeneratedArtifact,
  InstalledLedger,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  ResolvedInstallOptions,
  Scope,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  readInstalledLedger,
  validateLocalMarketplaceLayout,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { setCatalogPackageSourceForTests } from '../../src/utils/marketplace.js';
import { clearCurrentCatalogResolutionMemoForTests } from '../../src/utils/plugin-catalog.js';
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
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import {
  createProjectArtifactSharedLocator,
  getDiagnosticCachePath,
  getProjectArtifactSharedIdentityPath,
} from '../../src/install-state/paths.js';
import { createCliTestWorkspace, registerCliEmbeddedRoot, registerCliTempRoot } from '../helpers/workspace.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { resolveSafeCliEnv } from '../helpers/cli-runtime.js';
import { createMinimalPluginInstallStateFixtureBuilder } from '../helpers/minimal-plugin-install-state-fixtures.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import {
  createDependencyPluginManifest,
  createPluginDependencyScenarioFixtures,
} from '../support/plugin-dependency-fixtures.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';

const execFileAsync = promisify(execFile);

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(
  manifestUpdater?: (manifest: Record<string, any>) => void,
): Promise<{
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  embeddedRoot: string;
}> {
  const workspace = await createCliTestWorkspace({
    env: {
      PATH: process.env.PATH,
      AW_FORCE_CLAUDE_AVAILABLE: '1',
    },
    rootDirPrefix: 'aw-install-command-',
    mutateRepo: manifestUpdater
      ? async (repoRoot) => {
        const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
        const manifest = await fs.readJson(manifestPath);
        manifestUpdater(manifest);
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
      }
      : undefined,
  });
  await execFileAsync('git', ['init', '-q'], { cwd: workspace.repoRoot });

  return {
    repoRoot: workspace.repoRoot,
    embeddedRoot: workspace.embeddedRoot!,
    env: workspace.env,
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

function createResolvedTarget(plugin: PluginMeta) {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    embeddedPlugin: undefined,
    source: 'currentCatalog' as const,
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

function createAgentVersionRunner(options: {
  codex?: string;
  claude?: string;
} = {}): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(`Unexpected native CLI invocation in install-command.test.ts: ${invocation.command} ${invocation.args.join(' ')}`.trim());
    }

    if (invocation.command === 'codex') {
      return {
        exitCode: 0,
        stdout: options.codex ?? 'codex-cli 0.131.0',
        stderr: '',
      };
    }

    if (invocation.command === 'claude') {
      return {
        exitCode: 0,
        stdout: options.claude ?? '2.1.88 (Claude Code)',
        stderr: '',
      };
    }

    throw new Error(`Unexpected native CLI command: ${invocation.command}`);
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
  nativeInstalled = false;

  constructor(
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
  async upgradePlugin(): Promise<void> {}
  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'claude',
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

function resolvedInstallOptions(): ResolvedInstallOptions {
  return {
    applicability: 'none',
    ledgerTrust: 'available',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  clearCurrentCatalogResolutionMemoForTests();
  setCatalogPackageSourceForTests(null);
  setEmbeddedPluginsRootOverrideForTests(null);
});

describe('install command P6 install-state semantics', () => {
  it('pins only the selected current catalog plugins for local marketplace rebuilds', async () => {
    const { env } = await makeWorkspace();
    const sourceCatalogRoot = path.join(
      String(env.AW_HOME),
      'catalog-cache',
      'entries',
      'current',
      'catalog',
    );

    const selectedA = await writeSyntheticPlugin(sourceCatalogRoot, {
      ...createDependencyPluginManifest({
        name: 'selected-a',
      }),
      compatibility: {
        aw: {
          minVersion: '0.0.0',
        },
      },
    });
    const selectedB = await writeSyntheticPlugin(sourceCatalogRoot, {
      ...createDependencyPluginManifest({
        name: 'selected-b',
      }),
      compatibility: {
        aw: {
          minVersion: '0.0.0',
        },
      },
    });
    const unselected = await writeSyntheticPlugin(sourceCatalogRoot, {
      ...createDependencyPluginManifest({
        name: 'unselected',
      }),
      compatibility: {
        aw: {
          minVersion: '0.0.0',
        },
      },
    });

    const targets = [
      createResolvedTarget(selectedA),
      createResolvedTarget(selectedB),
    ];

    const pinnedRoots = await pinCurrentCatalogTargetsForLocalMarketplaceRebuild({
      targets,
      env,
    });

    expect(pinnedRoots).toHaveLength(1);
    const [pinnedRoot] = pinnedRoots;
    try {
      expect(path.dirname(path.dirname(targets[0]!.currentPlugin!.rootDir))).toBe(pinnedRoot);
      expect(path.dirname(path.dirname(targets[1]!.currentPlugin!.rootDir))).toBe(pinnedRoot);
      await expect(fs.pathExists(path.join(pinnedRoot, 'plugins', selectedA.manifest.name, '.agents-plugin', 'plugin.json'))).resolves.toBe(true);
      await expect(fs.pathExists(path.join(pinnedRoot, 'plugins', selectedB.manifest.name, '.agents-plugin', 'plugin.json'))).resolves.toBe(true);
      await expect(fs.pathExists(path.join(pinnedRoot, 'plugins', unselected.manifest.name))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(pinnedRoot, '.agents'))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(pinnedRoot, '.claude-plugin'))).resolves.toBe(false);
    } finally {
      await disposePinnedCatalogRoot(pinnedRoot);
    }
  });

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
    registerCliEmbeddedRoot(missingEmbeddedRoot, 'install command missing embedded root');
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
      'git-commit 当前不在 current catalog 中，无法继续当前安装。请先恢复该插件到 current catalog，或运行 `aw uninstall git-commit -p codex -s user` 清理 Codex native 残留。',
    );
  });

  it('falls back to the current catalog package when runtimeWritable install cannot read plugins-dist', async () => {
    const { repoRoot, env, embeddedRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const sidecarRoot = path.join(embeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(embeddedRoot, '.catalog', 'full');
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
    await writeInstalledLedger(createAvailableLedger(), env);

    const target = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [target],
      allTargets: [target],
      ledger: await readInstalledLedger(env),
    });

    const result = await installCommand(
      [plugin.manifest.name],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
      },
      {
        env,
        adapters: {
          codex: new FakeCodexAdapter(env),
          claude: new FakeClaudeAdapter(),
        },
      },
    );

    expect(result.marketplace).toMatchObject({
      source: 'local',
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(String(env.AW_HOME))).resolves.toBeUndefined();
  });

  it('keeps Codex user dynamic skill installs on the rebuilt local marketplace when plugins-dist is unavailable', async () => {
    const { repoRoot, env, embeddedRoot } = await makeWorkspace((pluginManifest) => {
      pluginManifest.skillTriggers = {
        ...pluginManifest.skillTriggers,
        'generated-commit': {
          defaultTrigger: 'auto',
          allowDynamicTrigger: true,
        },
      };
      pluginManifest.artifacts = {
        targets: [{
          id: 'generated-commit-skill',
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
    const sidecarRoot = path.join(embeddedRoot, '.catalog', 'sidecar');
    const fullRoot = path.join(embeddedRoot, '.catalog', 'full');
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
    await writeInstalledLedger(createAvailableLedger(), env);

    const result = await installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex: new FakeCodexAdapter(env),
          claude: new FakeClaudeAdapter(),
        },
      },
    );

    expect(result.marketplace).toMatchObject({
      source: 'local',
      changed: true,
    });
    await expect(validateLocalMarketplaceLayout(String(env.AW_HOME))).resolves.toBeUndefined();
    await expect(fs.pathExists(path.join(
      String(env.AW_HOME),
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'agents',
      'openai.yaml',
    ))).resolves.toBe(true);
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
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      command: 'install',
      nextStepsSchemaVersion: 1,
      nextSteps: [expect.objectContaining({ description: expect.any(String) })],
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
      targetResults: expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: parentPlugin.manifest.name,
            platform: 'codex',
            scope: 'user',
          }),
          action: 'install',
          state: 'completed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({
            pluginName: childPlugin.manifest.name,
            platform: 'codex',
            scope: 'user',
          }),
          action: 'installDependency',
          state: 'completed',
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
            cleanupCommand: 'aw cleanup git-commit -p codex -s project',
          },
          dependencyIndex: {
            trusted: false,
            coverageReason: ['indexMissing'],
            verifiedLocations: [],
            revisitLocations: [],
            recoveryMessage: '请回到可能相关的仓库重新运行 status --verbose。',
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
      receiptSchemaVersion: 2,
      overallState: 'succeeded',
      nextStepsSchemaVersion: 1,
      nextSteps: [
        expect.objectContaining({
          command: 'aw cleanup git-commit -p codex -s project',
        }),
        expect.objectContaining({
          command: 'aw reinstall git-commit --platform codex --scope project',
        }),
      ],
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
        recoveryMessage: '请回到可能相关的仓库重新运行 status --verbose。',
      },
      staleProjectReferences: [{
        recordPath: '/tmp/workspace/.codex/.agent-workflows/records/git-commit.json',
      }],
      sharedSkillTriggerOwner: {
        suppressedOwnerConflict: true,
        needsTakeover: false,
      },
    });
    expect(receipt).not.toHaveProperty('legacyNextSteps');
    expect(receipt.nativeTransactionMarker).not.toHaveProperty('recoveryCommand');
    expect(JSON.stringify(receipt)).not.toContain('repair');

    const human = renderCommandReceipt('install', rawReceipt).join('\n');
    expect(human).toContain('主要安装已经完成，但还需要收口本机原生状态');
    expect(human).toContain('aw cleanup git-commit -p codex -s project');
    expect(human).toContain('已更新团队共享配置。');
    expect(human).toContain('已更新共享身份文件。');
    expect(human).toContain('已更新 AW 本地状态。');
    expect(human).toContain('当前项目的 repo-local skill trigger 已按本地项目路径处理');
    expect(human).not.toContain('takeoverRequired');
    expect(human).not.toContain('ownerConflict');
    expect(human).not.toContain('aw repair');
    expect(human).not.toContain('repair');
    expect(human).not.toContain('--takeover-shared-runtime');
  });

  it('keeps explicit single-platform installs scoped to requested targets, without letting dependencies widen the platform set', async () => {
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

  it('expands --platform both by current manifest support without generating unsupported target pairs', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const codexOnly = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'codex-only-plugin',
      products: ['codex'],
    }));
    const claudeOnly = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'claude-only-plugin',
      products: ['claude'],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const codexTarget = {
      pluginName: codexOnly.manifest.name,
      plugin: codexOnly,
      currentPlugin: codexOnly,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    const claudeTarget = {
      pluginName: claudeOnly.manifest.name,
      plugin: claudeOnly,
      currentPlugin: claudeOnly,
      embeddedPlugin: undefined,
      source: 'currentCatalog' as const,
    };
    mockCatalogTargets({
      explicitTargets: [codexTarget, claudeTarget],
      allTargets: [codexTarget, claudeTarget],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env);
    const claude = new GraphTestAdapter('claude', repoRoot, env);

    const result = await installCommand(
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
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: codexOnly.manifest.name,
      platform: 'claude',
    })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: claudeOnly.manifest.name,
      platform: 'codex',
    })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('fails Codex install before any write when the detected version is too old', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'codex-version-gated',
      products: ['codex'],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);
    mockCatalogTargets({
      explicitTargets: [createResolvedTarget(plugin)],
      allTargets: [createResolvedTarget(plugin)],
      ledger: await readInstalledLedger(env),
    });

    const codex = new GraphTestAdapter('codex', repoRoot, env);
    const claude = new GraphTestAdapter('claude', repoRoot, env);

    let payload: AgentVersionGateErrorPayload | null = null;
    try {
      await installCommand(
        [plugin.manifest.name],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          nativeCliRunner: createAgentVersionRunner({
            codex: 'codex-cli 0.130.0',
          }),
          adapters: { codex, claude },
        },
      );
    } catch (error) {
      payload = (error as { payload?: AgentVersionGateErrorPayload }).payload ?? null;
      expect(error).toBeInstanceOf(Error);
    }

    expect(payload).toMatchObject({
      command: 'install',
      failures: [{
        platform: 'codex',
        reasonCode: 'agentVersionTooLow',
        detectedVersion: '0.130.0',
        requiredMinVersion: '0.131.0',
      }],
    });
    expect(payload?.failures[0]?.suggestedAction).toContain('升级到 >= 0.131.0');
    expect(codex.installOrder).toEqual([]);
    expect(claude.installOrder).toEqual([]);
    await expect(readInstallRecord({
      repoRoot,
      env,
      plugin: plugin.manifest.name,
      platform: 'codex',
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

  it('fails install scope preflight before required config when the sibling scope is already healthy', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      registerCliTempRoot(
        await fs.mkdtemp(path.join(os.tmpdir(), 'aw-install-duplicate-')),
        'install duplicate fixture root',
      ),
    );
    const env = resolveSafeCliEnv({
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    });
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const projectTarget = builder.createTarget({
      pluginName: 'duplicate-install-plugin',
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    await builder.writeRepoArtifact(projectTarget);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(projectTarget);
    const record = await builder.writeInstallRecord(projectTarget, lifecycle);
    await builder.writeDiagnosticCache(projectTarget);
    await builder.writeProjectIdentity(projectTarget);
    await builder.writeDependencyIndex([{ target: projectTarget, record }]);

    const plugin = await writeSyntheticPlugin(builder.paths.repoRoot, {
      ...createDependencyPluginManifest({
        name: projectTarget.location.plugin,
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
    await fs.writeJson(
      path.join(builder.paths.repoRoot, 'plugins', 'marketplace-source.json'),
      {
        owner: {
          name: 'Stage3 Test',
          url: 'https://example.invalid/agent-workflows',
        },
        interface: {
          displayName: 'Stage3 Test Catalog',
        },
      },
      { spaces: 2 },
    );
    const embeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    registerCliEmbeddedRoot(embeddedRoot, 'install duplicate embedded root');
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), env);

    const codex = new GraphTestAdapter('codex', builder.paths.repoRoot, env, {
      [plugin.manifest.name]: {
        scopeInitialized: 'yes',
        nativeInstalled: true,
        marketplaceRegistered: true,
      },
    });

    await expect(installCommand(
      [plugin.manifest.name],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex,
          claude: new GraphTestAdapter('claude', builder.paths.repoRoot, env),
        },
      },
    )).rejects.toThrow(/duplicateInstall/);

    expect(codex.installOrder).toEqual([]);
    await expect(readInstallRecord({
      repoRoot: builder.paths.repoRoot,
      env,
      plugin: plugin.manifest.name,
      scope: 'user',
    })).resolves.toMatchObject({
      status: 'missing',
    });
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: plugin.manifest.name,
      scope: 'user',
      cwd: builder.paths.repoRoot,
      env,
    }))).resolves.toBe(false);
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

  it('writes Claude subdirectory project shared identity for repo-visible artifacts alongside the per-plugin install record', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const projectRoot = path.join(repoRoot, 'packages', 'a');
    await fs.ensureDir(projectRoot);
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'claude-project-shared-identity',
      products: ['claude'],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const repoVisibleArtifactPath = path.join(projectRoot, 'docs', 'claude.instructions.md');
    const claude = new FakeClaudeAdapter({
      onInstallExtensions: async () => {
        await fs.ensureDir(path.dirname(repoVisibleArtifactPath));
        await fs.writeFile(repoVisibleArtifactPath, '# claude install artifact\n', 'utf8');
        return [{
          path: repoVisibleArtifactPath,
          kind: 'instruction',
          platform: 'claude',
          artifactKey: `${plugin.manifest.name}.project-doc`,
        }];
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
      ['claude'],
      {
        cwd: projectRoot,
        scope: 'project',
        platform: 'claude',
      },
      {
        env,
        adapters: {
          codex: new FakeCodexAdapter(env),
          claude,
        },
        resolveInstallOptions: () => resolvedInstallOptions(),
        skipConfigPreflight: true,
        skipWriteSafetyPreflight: true,
      },
    );

    const projectKey = await resolveClaudeProjectKey(projectRoot);
    const recordRead = await readInstallRecordForLocation({
      cwd: projectRoot,
      location: {
        plugin: plugin.manifest.name,
        platform: 'claude',
        scope: 'project',
        projectKey,
      },
      env,
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
      platform: 'claude',
      repoRoot,
      projectRoot,
    });
    const identityRead = await readProjectArtifactIdentityForLocator({
      repoRoot,
      locator,
      cwd: projectRoot,
    });
    expect(identityRead).toMatchObject({
      status: 'ok',
      value: {
        locator,
        artifacts: [
          expect.objectContaining({
            kind: 'instruction',
            platform: 'claude',
            path: 'packages/a/docs/claude.instructions.md',
            artifactKey: `${plugin.manifest.name}.project-doc`,
          }),
        ],
      },
    });
    if (identityRead.status !== 'ok') {
      throw new Error(`expected project artifact identity for ${plugin.manifest.name}`);
    }

    const repoRootLocator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'claude',
      repoRoot,
      projectRoot: repoRoot,
    });
    await expect(readProjectArtifactIdentityForLocator({
      repoRoot,
      locator: repoRootLocator,
      cwd: projectRoot,
    })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('fails Claude project-scope install when the subdirectory shared identity path is ignored', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const projectRoot = path.join(repoRoot, 'packages', 'a');
    await fs.ensureDir(projectRoot);
    const plugin = await writeSyntheticPlugin(repoRoot, createDependencyPluginManifest({
      name: 'claude-project-identity-ignore',
      products: ['claude'],
    }));
    await writeInstalledLedger(createAvailableLedger(), env);

    const locator = createProjectArtifactSharedLocator({
      plugin: plugin.manifest.name,
      platform: 'claude',
      repoRoot,
      projectRoot,
    });
    const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
    const ignoredRelativePath = path.relative(repoRoot, identityPath).split(path.sep).join('/');
    await fs.writeFile(path.join(repoRoot, '.gitignore'), `${ignoredRelativePath}\n`, 'utf8');

    await expect(
      installTargetsOnPlatforms(
        [{
          pluginName: plugin.manifest.name,
          plugin,
          currentPlugin: plugin,
          embeddedPlugin: undefined,
          source: 'currentCatalog',
        }],
        ['claude'],
        {
          cwd: projectRoot,
          scope: 'project',
          platform: 'claude',
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
    ).rejects.toMatchObject({
      name: 'ProjectBoundaryVisibilityError',
      code: 'projectArtifactIdentityIgnored',
      targetRelativePath: ignoredRelativePath,
      matchedPattern: ignoredRelativePath,
    });
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
      `aw install ${plugin.manifest.name} --platform codex --scope project --adopt-existing`,
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
