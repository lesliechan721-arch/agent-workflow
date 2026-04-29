import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { createAvailableLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import {
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

async function makeWorkspaceWithMutator(
  mutateRepo: (repoRoot: string) => Promise<void>,
): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await mutateRepo(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

async function restrictGitCommitToCodex(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.marketplace.policy.products = ['CODEX'];
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function addRequiredConfigSchemaToGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config = {
    schema: {
      token: {
        type: 'string',
        required: true,
        sensitive: true,
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

interface FakePluginState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  currentCatalogAvailable?: boolean;
  nativeInstalled?: boolean;
  runtimeEvidence?: boolean;
  nativeFallback?: boolean;
  catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged';
  externalOwnership?: boolean;
  artifactPath?: string;
}

class FakeAdapter implements PlatformAdapter {
  readonly name: PlatformName;
  readonly installCalls: string[] = [];
  readonly uninstallCalls: string[] = [];
  readonly extensionInstallCalls: string[] = [];
  readonly extensionUninstallCalls: string[] = [];

  constructor(
    name: PlatformName,
    private readonly cwd: string,
    private readonly states: Record<string, FakePluginState>,
  ) {
    this.name = name;
  }

  private getState(pluginName: string): FakePluginState {
    this.states[pluginName] ??= {};
    return this.states[pluginName];
  }

  async detect(_cwd: string): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    this.installCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(plugin: PluginMeta, scope: 'project' | 'user'): Promise<GeneratedArtifact[]> {
    this.extensionInstallCalls.push(plugin.manifest.name);
    const state = this.getState(plugin.manifest.name);
    const artifactPath = path.join(
      this.cwd,
      `.generated-${this.name}`,
      `${plugin.manifest.name}-${scope}.txt`,
    );
    await fs.ensureDir(path.dirname(artifactPath));
    await fs.writeFile(artifactPath, `${this.name}:${plugin.manifest.name}`, 'utf8');
    state.artifactPath = artifactPath;
    state.scopeInitialized = 'yes';
    return [{
      path: artifactPath,
      kind: 'instruction',
      platform: this.name,
    }];
  }

  async uninstallExtensions(
    plugin: PluginMeta,
    _scope: 'project' | 'user',
    _generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void> {
    this.extensionUninstallCalls.push(plugin.manifest.name);
    const state = this.getState(plugin.manifest.name);
    if (state.artifactPath) {
      await fs.remove(state.artifactPath);
      state.artifactPath = undefined;
    }
    state.scopeInitialized = 'no';
  }

  async upgradePlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: 'project' | 'user'): Promise<StatusReport> {
    const state = this.getState(plugin.manifest.name);
    const generatedArtifacts = state.artifactPath
      ? [{
          path: state.artifactPath,
          exists: await fs.pathExists(state.artifactPath),
          kind: 'instruction' as const,
        }]
      : [];
    const currentCatalogAvailable = state.currentCatalogAvailable ?? true;

    return {
      platform: this.name,
      scope,
      initialized:
        state.scopeInitialized === 'yes' ||
        state.nativeInstalled === true ||
        state.runtimeEvidence === true ||
        state.nativeFallback === true,
      plugins: [
        {
          pluginName: plugin.manifest.name,
          native: {
            marketplaceRegistered: state.nativeInstalled === true,
            pluginAvailable: currentCatalogAvailable,
            pluginInstalled: state.nativeInstalled === true,
            version: plugin.manifest.version,
          },
          generatedArtifacts,
          driftWarnings: [],
          ledgerStateStatus: 'available',
          ledgerStateReason: null,
          scopeInitialized: state.scopeInitialized ?? 'no',
          catalogCompatibility: state.catalogCompatibility,
          externalOwnership: state.externalOwnership
            ? {
                present: true,
                marketplace: 'third-party',
                details: '同名插件已由外部 marketplace 管理。',
              }
            : undefined,
          platformRuntimeEvidence: {
            present: state.runtimeEvidence === true,
          },
          platformNativeFallbackEvidence: {
            present: state.nativeFallback === true,
          },
          scopeManagedEvidence: {
            ledger: state.scopeInitialized === 'yes',
            tracking: generatedArtifacts.length > 0,
            sharedNativeRef: false,
          },
          currentCatalog: {
            rootDir: '/synthetic',
            source: 'embedded',
            available: currentCatalogAvailable,
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
        },
      ],
    };
  }
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  process.env.PATH = originalPath;
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('upgrade command coverage', () => {
  it('rejects explicit upgrade without plugin names', async () => {
    const { repoRoot } = await makeWorkspace();

    await expect(
      upgradeCommand([], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('upgrade 命令需要插件名，或者显式传入 `--all`。');
  });

  it('blocks explicit upgrade when only fallback evidence exists', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        runtimeEvidence: true,
        scopeInitialized: 'no',
      },
    });

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('缺少安装时快照');
  });

  it('uninstalls and reinstalls capability-changed plugins during explicit upgrade', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'capabilityChanged',
      },
    });

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['git-commit'],
    });

    expect(codex.uninstallCalls).toEqual(['git-commit']);
    expect(codex.extensionUninstallCalls).toEqual(['git-commit']);
    expect(codex.installCalls).toEqual(['git-commit']);
    expect(codex.extensionInstallCalls).toEqual(['git-commit']);
  });

  it('preflights missing required config during upgrade and honors the selected config scope', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addRequiredConfigSchemaToGitCommit,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const projectKey = await resolveCodexProjectKey(repoRoot);
    const installedLedger = createAvailableLedger();
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-29T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: false,
            projects: [projectKey],
          },
          lastRequestedScope: 'project',
          lastRequestedAt: '2026-04-29T00:00:00.000Z',
        },
      },
    };
    await writeInstalledLedger(installedLedger, process.env);

    const configureCalls: Array<{
      allowedScopes: string[];
      initialScope: string;
      requiredKeys?: string[];
      currentValues?: Record<string, unknown>;
    }> = [];
    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          interactive: true,
          prompt: {
            configurePlugin: async (options) => {
              configureCalls.push({
                allowedScopes: options.allowedScopes,
                initialScope: options.initialScope,
                requiredKeys: options.requiredKeys,
                currentValues: options.currentValues,
              });
              return {
                selectedScope: 'user',
                updates: { token: 'upgrade-secret' },
                updatedKeys: ['token'],
                cancelled: false,
              };
            },
          },
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['git-commit'],
    });

    expect(codex.installCalls).toEqual(['git-commit']);
    expect(configureCalls).toEqual([
      {
        allowedScopes: ['user', 'project'],
        initialScope: 'project',
        requiredKeys: ['token'],
        currentValues: {},
      },
    ]);
    await expect(fs.readJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toEqual({
      token: 'upgrade-secret',
    });
    await expect(fs.pathExists(
      path.join(repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toBe(false);
  });

  it('auto-infers the only managed platform for upgrade --all', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const projectKey = await resolveCodexProjectKey(repoRoot);
    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
        },
      },
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });
    const claude = new FakeAdapter('claude', repoRoot, {});

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          adapters: {
            codex,
            claude,
          },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['git-commit'],
    });

    expect(codex.installCalls).toEqual(['git-commit']);
    expect(claude.installCalls).toEqual([]);
  });

  it('rejects upgrade --all with --platform both when only one platform is available', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: codexHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
      PATH: '',
    };
    delete env.AW_FORCE_CLAUDE_AVAILABLE;

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'both',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
          env,
        },
      ),
    ).rejects.toThrow('`--platform both` 只在同时检测到 Codex 和 Claude 时可用。');
  });

  it('blocks upgrade --platform auto when products narrowing would skip a managed platform', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      restrictGitCommitToCodex,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const [codexProjectKey, claudeProjectKey] = await Promise.all([
      resolveCodexProjectKey(repoRoot),
      resolveClaudeProjectKey(repoRoot),
    ]);
    const installedLedger = createAvailableLedger();
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: false,
            projects: [codexProjectKey],
          },
        },
        claude: {
          projectScopes: {
            [claudeProjectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions', 'permissions', 'hooks'],
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(installedLedger, process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });
    const claude = new FakeAdapter('claude', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          adapters: {
            codex,
            claude,
          },
        },
      ),
    ).rejects.toThrow('被排除的平台上保留受管安装');

    expect(codex.installCalls).toEqual([]);
    expect(claude.installCalls).toEqual([]);
  });

  it('preflights products narrowing before upgrade --all --platform both writes anything', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      restrictGitCommitToCodex,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const [codexProjectKey, claudeProjectKey] = await Promise.all([
      resolveCodexProjectKey(repoRoot),
      resolveClaudeProjectKey(repoRoot),
    ]);
    const installedLedger = createAvailableLedger();
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: false,
            projects: [codexProjectKey],
          },
        },
        claude: {
          projectScopes: {
            [claudeProjectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions', 'permissions', 'hooks'],
              },
            },
          },
        },
      },
    };
    await writeInstalledLedger(installedLedger, process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });
    const claude = new FakeAdapter('claude', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'both',
        },
        {
          adapters: {
            codex,
            claude,
          },
        },
      ),
    ).rejects.toThrow('marketplace.policy.products=[CODEX]');

    expect(codex.installCalls).toEqual([]);
    expect(claude.installCalls).toEqual([]);
  });
});
