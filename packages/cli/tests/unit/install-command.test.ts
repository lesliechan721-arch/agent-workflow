import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installCommand,
  installTargetsOnPlatforms,
} from '../../src/commands/install.js';
import type {
  GeneratedArtifact,
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
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
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
    await this.installPlugin(plugin, scope);
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
});
