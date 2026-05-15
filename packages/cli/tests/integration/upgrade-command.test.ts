import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import * as commonModule from '../../src/commands/common.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import * as pluginScriptsModule from '../../src/utils/plugin-scripts.js';
import type {
  GeneratedArtifact,
  NativeRecoveryState,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { writeCodexNativeRecoveryBreadcrumb } from '../../src/utils/codex-native-recovery.js';
import { createAvailableLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import {
  resolveCodexPaths,
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createDependencyPluginManifest } from '../support/plugin-dependency-fixtures.js';

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
  await removeAppsFromGitCommit(repoRoot);
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
  await removeAppsFromGitCommit(repoRoot);
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

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
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

async function restoreAppsOnGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.apps = './.app.json';
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.writeJson(
    path.join(repoRoot, 'plugins', 'git-commit', '.app.json'),
    {
      apps: {
        'git-commit': {
          id: 'git-commit',
          name: 'Git Commit',
        },
      },
    },
    { spaces: 2 },
  );
}

async function removeProjectManagedKindsFromGitCommit(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.skills;
  delete manifest.skillTriggers;
  delete manifest.mcpServers;
  delete manifest.extensions;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(pluginRoot, 'skills'));
  await fs.remove(path.join(pluginRoot, '.mcp.json'));
  await fs.remove(path.join(pluginRoot, 'hooks'));
  await fs.remove(path.join(pluginRoot, 'agents'));
}

async function removeGitCommitFromCatalog(repoRoot: string): Promise<void> {
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit'));
}

async function writeSyntheticPluginManifest(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', String(manifest.name));
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
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

function createManagedCodexUserScopeRecord(options: {
  version?: string;
  installSource?: 'explicit' | 'dependency';
  dependencyEdges?: Array<{
    dependency: {
      plugin: string;
      platform: 'codex';
      scope: 'user';
      projectKey: null;
    };
    declaration: {
      name: string;
    };
  }>;
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

interface FakePluginState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  currentCatalogAvailable?: boolean;
  nativeInstalled?: boolean;
  nativeEnabled?: boolean;
  runtimeEvidence?: boolean;
  nativeFallback?: boolean;
  sharedNativeRef?: boolean;
  nativeRecoveryPresent?: boolean;
  nativeRecoveryState?: NativeRecoveryState;
  nativeRecoveryReason?: string;
  catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged';
  externalOwnership?: boolean;
  externalOwnershipCheckState?: 'known' | 'unknown';
  externalOwnershipDetails?: string;
  projectTrust?: 'trusted' | 'untrusted' | 'unknown' | 'not_applicable';
  artifactPath?: string;
  artifactKind?: GeneratedArtifact['kind'];
  artifactKey?: string;
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
    state.artifactKind = 'instruction';
    state.artifactKey = undefined;
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
          kind: state.artifactKind ?? 'instruction',
          artifactKey: state.artifactKey,
        }]
      : [];
    const currentCatalogAvailable = state.currentCatalogAvailable ?? true;

    return {
      platform: this.name,
      scope,
      initialized:
        state.scopeInitialized === 'yes' ||
        state.nativeInstalled === true ||
        state.nativeEnabled === true ||
        state.runtimeEvidence === true ||
        state.nativeFallback === true ||
        state.sharedNativeRef === true ||
        state.nativeRecoveryPresent === true,
      plugins: [
        {
          pluginName: plugin.manifest.name,
          native: {
            marketplaceRegistered: state.nativeInstalled === true,
            pluginAvailable: currentCatalogAvailable,
            pluginInstalled: state.nativeInstalled === true,
            pluginEnabled: state.nativeEnabled === true,
            recovery: {
              present: state.nativeRecoveryPresent === true,
              state: state.nativeRecoveryPresent ? state.nativeRecoveryState ?? 'post_check_failed' : null,
              reason: state.nativeRecoveryPresent ? state.nativeRecoveryReason ?? 'native_install_post_check_failed' : null,
              evidenceMatches: null,
              suggestion: null,
            },
            version: plugin.manifest.version,
          },
          generatedArtifacts,
          driftWarnings: [],
          ledgerStateStatus: 'available',
          ledgerStateReason: null,
          scopeInitialized: state.scopeInitialized ?? 'no',
          catalogCompatibility: state.catalogCompatibility,
          externalOwnership:
            state.externalOwnership ||
            state.externalOwnershipCheckState === 'unknown'
              ? {
                  present: state.externalOwnership === true,
                  checkState: state.externalOwnershipCheckState ??
                    (state.externalOwnership ? 'known' : 'unknown'),
                  marketplace: state.externalOwnership ? 'third-party' : undefined,
                  details: state.externalOwnershipDetails ??
                    (state.externalOwnership
                      ? '同名插件已由外部 marketplace 管理。'
                      : 'external ownership / project trust 当前无法可靠判定。'),
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
            sharedNativeRef: state.sharedNativeRef === true,
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
          projectTrust: state.projectTrust ?? 'not_applicable',
        },
      ],
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  process.env.PATH = originalPath;
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

async function writeCodexProjectManagedLedgerRecord(options: {
  repoRoot: string;
  pluginName?: string;
  capabilitySnapshot?: Record<string, unknown>;
  installOptions?: {
    skillTriggerPreference?: 'default' | 'manual' | 'auto';
  };
}): Promise<void> {
  const projectKey = await resolveCodexProjectKey(options.repoRoot);
  const ledger = createAvailableLedger();
  ledger.plugins[options.pluginName ?? 'git-commit'] = {
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
              ...(options.capabilitySnapshot ?? {}),
            },
            installOptions: options.installOptions ?? {
              skillTriggerPreference: 'default',
            },
            installSource: createInstallSource('explicit'),
            dependencyEdges: [],
          },
        },
        lastRequestedScope: 'project',
        lastRequestedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  };
  await writeInstalledLedger(ledger, process.env);
}

async function writeLegacyCodexProjectCandidateRecord(repoRoot: string): Promise<void> {
  const ledger = createAvailableLedger();
  ledger.plugins['git-commit'] = {
    lastResolvedVersion: '0.1.0',
    platforms: {
      codex: {
        lastRequestedScope: 'project',
        lastRequestedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  };
  await writeInstalledLedger(ledger, process.env);
}

async function writeCodexProjectTrackingRecord(options: {
  repoRoot: string;
  pluginName?: string;
  artifactKey?: string;
  artifactPath?: string;
}): Promise<void> {
  const pluginName = options.pluginName ?? 'git-commit';
  const artifactKey = options.artifactKey ?? 'commit';
  const artifactPath = options.artifactPath ?? path.join(options.repoRoot, '.agents', 'skills', artifactKey);
  await fs.outputJson(
    path.join(options.repoRoot, '.codex', '.agent-workflows-manifest.json'),
    {
      version: 1,
      plugins: {
        [pluginName]: {
          name: pluginName,
          generatedAt: '2026-04-29T00:00:00.000Z',
          artifacts: [{
            path: artifactPath,
            kind: 'skill',
            platform: 'codex',
            artifactKey,
          }],
        },
      },
    },
    { spaces: 2 },
  );
}

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

  it('fails breadcrumb-only explicit Codex user upgrade before install option inheritance, lifecycle, and native install', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: codexHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    };
    await writeInstalledLedger(createAvailableLedger(), env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeRecoveryPresent: true,
        nativeRecoveryState: 'post_check_failed',
        nativeRecoveryReason: 'native_install_post_check_failed',
      },
    });
    const resolveInstallOptionsSpy = vi.spyOn(commonModule, 'resolveInstallOptionsForTargets');
    const lifecycleSpy = vi.spyOn(pluginScriptsModule, 'runLifecycleScript');

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
          env,
        },
      ),
    ).rejects.toThrow(
      'git-commit 当前只有 Codex native recovery breadcrumb，安装尚未完整成功；请先运行 aw install git-commit -p codex -s user 修复，或运行 aw uninstall git-commit -p codex -s user 清理。',
    );

    expect(resolveInstallOptionsSpy).not.toHaveBeenCalled();
    expect(lifecycleSpy).not.toHaveBeenCalled();
    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
  });

  it('ignores breadcrumb-only Codex user candidates during upgrade --all root selection', async () => {
    const { repoRoot, awHome, codexHome } = await makeWorkspace();
    const env = {
      ...process.env,
      AW_HOME: awHome,
      AW_CODEX_HOME: codexHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    };
    await writeInstalledLedger(createAvailableLedger(), env);
    await writeCodexNativeRecoveryBreadcrumb({
      pluginName: 'git-commit',
      state: 'post_check_failed',
      reason: 'native_install_post_check_failed',
      env,
    });

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeRecoveryPresent: true,
        nativeRecoveryState: 'post_check_failed',
        nativeRecoveryReason: 'native_install_post_check_failed',
      },
    });

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
          env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: [],
      skipped: [],
    });

    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
  });

  it('refuses explicit upgrade when tracked skill or MCP identity is missing artifactKey', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.outputJson(
      path.join(repoRoot, '.codex', '.agent-workflows-manifest.json'),
      {
        version: 1,
        plugins: {
          'git-commit': {
            name: 'git-commit',
            generatedAt: '2026-04-30T00:00:00.000Z',
            artifacts: [
              {
                path: path.join(repoRoot, '.agents', 'skills', 'commit'),
                kind: 'skill',
                platform: 'codex',
              },
            ],
          },
        },
      },
      { spaces: 2 },
    );

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
            codex: new FakeAdapter('codex', repoRoot, {
              'git-commit': {
                scopeInitialized: 'yes',
                currentCatalogAvailable: true,
                artifactPath: path.join(repoRoot, '.agents', 'skills', 'commit'),
                artifactKind: 'skill',
                nativeInstalled: false,
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('artifactKey');
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

  it('reapplies current catalog for capability-changed plugins without pre-uninstall', async () => {
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

    expect(codex.uninstallCalls).toEqual([]);
    expect(codex.extensionUninstallCalls).toEqual([]);
    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual(['git-commit']);
  });

  it('preflights missing required config during upgrade, rejects without prompting, and avoids config/native writes', async () => {
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
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });

    const userCodexPaths = resolveCodexPaths(repoRoot, 'user', process.env);
    const projectCodexPaths = resolveCodexPaths(repoRoot, 'project', process.env);

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
    ).rejects.toThrow(
      'git-commit requires valid AW config before install/upgrade: token. ' +
        'Run `aw config set git-commit token <value> -s project`, or open `aw` to complete setup.',
    );

    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
    await expect(fs.readJson(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).rejects.toThrow();
    await expect(fs.pathExists(path.join(repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json'))).resolves.toBe(false);
    await expect(fs.pathExists(userCodexPaths.configTomlPath)).resolves.toBe(false);
    await expect(fs.pathExists(projectCodexPaths.configTomlPath)).resolves.toBe(false);
  });

  it.each([
    {
      title: 'rejects project upgrade when the current catalog reintroduces apps',
      mutateRepo: restoreAppsOnGitCommit,
      message: '暂不支持 apps',
    },
    {
      title: 'rejects project upgrade when the current catalog has no project-managed kinds',
      mutateRepo: removeProjectManagedKindsFromGitCommit,
      message: '没有任何 Codex project-managed kind',
    },
  ])('$title', async ({ mutateRepo, message }) => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      mutateRepo,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: false,
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
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow(message);

    expect(codex.uninstallCalls).toEqual([]);
    expect(codex.extensionUninstallCalls).toEqual([]);
    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
  });

  it('ignores legacy project candidates without explicit retained install source during upgrade --all', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await writeLegacyCodexProjectCandidateRecord(repoRoot);

    const result = await upgradeCommand(
      [],
      {
        all: true,
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              catalogCompatibility: 'current',
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.plugins).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it('returns stable skipped codes for Codex project upgrade --all target preflight cases', async () => {
    const cases = [
      {
        title: 'codexProjectUserConfigUnreadable',
        setup: async (repoRoot: string, codexHome: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
          await fs.ensureDir(codexHome);
          await fs.writeFile(path.join(codexHome, 'config.toml'), '[[plugins', 'utf8');
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
        },
        code: 'codexProjectUserConfigUnreadable',
      },
      {
        title: 'externalOwnershipUnknown',
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
          externalOwnershipCheckState: 'unknown' as const,
          externalOwnershipDetails: '外部 ownership 当前无法可靠判定。',
          projectTrust: 'unknown' as const,
        },
        code: 'externalOwnershipUnknown',
      },
      {
        title: 'externalOwnershipPresent',
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
          externalOwnership: true,
        },
        code: 'externalOwnershipPresent',
      },
      {
        title: 'trackingIntegrityError',
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
          await fs.outputJson(
            path.join(repoRoot, '.codex', '.agent-workflows-manifest.json'),
            {
              version: 1,
              plugins: {
                'git-commit': {
                  name: 'git-commit',
                  generatedAt: '2026-04-29T00:00:00.000Z',
                  artifacts: [{
                    path: path.join(repoRoot, '.agents', 'skills', 'commit'),
                    kind: 'skill',
                    platform: 'codex',
                  }],
                },
              },
            },
            { spaces: 2 },
          );
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
        },
        code: 'trackingIntegrityError',
      },
      {
        title: 'catalogNotCurrent',
        mutateRepo: removeGitCommitFromCatalog,
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
        },
        adapterState: {
          currentCatalogAvailable: false,
          catalogCompatibility: 'missing' as const,
        },
        code: 'catalogNotCurrent',
      },
      {
        title: 'catalogNotProjectInstallable',
        mutateRepo: restoreAppsOnGitCommit,
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
        },
        code: 'catalogNotProjectInstallable',
      },
      {
        title: 'projectConfigUnreadable',
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
          await fs.ensureDir(path.join(repoRoot, '.codex'));
          await fs.writeFile(path.join(repoRoot, '.codex', 'config.toml'), '[mcp_servers', 'utf8');
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
        },
        code: 'projectConfigUnreadable',
      },
      {
        title: 'unmanagedRepoArtifactConflict',
        setup: async (repoRoot: string) => {
          await writeCodexProjectManagedLedgerRecord({ repoRoot });
          await fs.outputJson(
            path.join(repoRoot, '.codex', '.agent-workflows-manifest.json'),
            {
              version: 1,
              plugins: {
                'other-plugin': {
                  name: 'other-plugin',
                  generatedAt: '2026-04-29T00:00:00.000Z',
                  artifacts: [{
                    path: path.join(repoRoot, '.agents', 'skills', 'commit'),
                    kind: 'skill',
                    platform: 'codex',
                    artifactKey: 'commit',
                  }],
                },
              },
            },
            { spaces: 2 },
          );
        },
        adapterState: {
          currentCatalogAvailable: true,
          catalogCompatibility: 'current' as const,
        },
        code: 'unmanagedRepoArtifactConflict',
      },
    ] as const;

    for (const testCase of cases) {
      const workspace = testCase.mutateRepo
        ? await makeWorkspaceWithMutator(testCase.mutateRepo)
        : await makeWorkspace();
      process.env.AW_HOME = workspace.awHome;
      process.env.AW_CODEX_HOME = workspace.codexHome;
      process.env.AW_FORCE_CODEX_AVAILABLE = '1';
      setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

      await initCommand({ force: true });
      await writeInstalledLedger(createAvailableLedger(), process.env);
      await testCase.setup(workspace.repoRoot, workspace.codexHome);

      const result = await upgradeCommand(
        [],
        {
          all: true,
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', workspace.repoRoot, {
              'git-commit': testCase.adapterState,
            }),
            claude: new FakeAdapter('claude', workspace.repoRoot, {}),
          },
        },
      ).catch((error) => {
        throw new Error(`${testCase.title}: ${error instanceof Error ? error.message : String(error)}`);
      });

      expect(result.plugins, testCase.title).toEqual([]);
      expect(result.skipped, testCase.title).toEqual(expect.arrayContaining([
        expect.objectContaining({
          platform: 'codex',
          scope: 'project',
          plugin: 'git-commit',
          code: testCase.code,
        }),
      ]));
    }
  });

  it('keeps successful targets in plugins[] and skipped targets in skipped[] during mixed upgrade --all', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
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
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-29T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
            },
          },
          lastRequestedScope: 'project',
          lastRequestedAt: '2026-04-29T00:00:00.000Z',
        },
        claude: {
          projectScopes: {
            [claudeProjectKey]: {
              managed: true,
              updatedAt: '2026-04-29T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions'],
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
            },
          },
          lastRequestedScope: 'project',
          lastRequestedAt: '2026-04-29T00:00:00.000Z',
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const result = await upgradeCommand(
      [],
      {
        all: true,
        cwd: repoRoot,
        scope: 'project',
        platform: 'both',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              catalogCompatibility: 'current',
              externalOwnershipCheckState: 'unknown',
              externalOwnershipDetails: '外部 ownership 当前无法可靠判定。',
              projectTrust: 'unknown',
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              nativeInstalled: true,
              scopeInitialized: 'yes',
              catalogCompatibility: 'current',
            },
          }),
        },
      },
    );

    expect(result.plugins).toEqual(['git-commit']);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        platform: 'codex',
        scope: 'project',
        plugin: 'git-commit',
        code: 'externalOwnershipUnknown',
      }),
    ]);
  });

  it('keeps both platform-specific project roots when upgrade --all runs from a subdirectory', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    const nestedCwd = path.join(repoRoot, 'packages', 'workspace-child');
    await fs.ensureDir(nestedCwd);
    await fs.writeFile(
      path.join(repoRoot, 'pnpm-workspace.yaml'),
      'packages:\n  - plugins/*\n',
      'utf8',
    );

    const [codexProjectKey, claudeProjectKey] = await Promise.all([
      resolveCodexProjectKey(nestedCwd),
      resolveClaudeProjectKey(nestedCwd),
    ]);
    expect(codexProjectKey).not.toBe(claudeProjectKey);

    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [codexProjectKey]: {
              managed: true,
              updatedAt: '2026-04-29T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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
              updatedAt: '2026-04-29T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions'],
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const codex = new FakeAdapter('codex', nestedCwd, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });
    const claude = new FakeAdapter('claude', nestedCwd, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
    });

    const result = await upgradeCommand(
      [],
      {
        all: true,
        cwd: nestedCwd,
        scope: 'project',
        platform: 'both',
      },
      {
        adapters: {
          codex,
          claude,
        },
      },
    );

    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'project',
        requested: true,
      }),
      expect.objectContaining({
        plugin: 'git-commit',
        platform: 'claude',
        scope: 'project',
        requested: true,
      }),
    ]));
    expect(codex.extensionInstallCalls).toEqual(['git-commit']);
    expect(claude.extensionInstallCalls).toEqual(['git-commit']);
  });

  it('requires an explicit platform for upgrade --all even when only one managed platform remains', async () => {
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
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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
        },
        {
          adapters: {
            codex,
            claude,
          },
        },
      ),
    ).rejects.toThrow('upgrade 命令需要显式指定 `--platform codex|claude|both`');

    expect(codex.installCalls).toEqual([]);
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

  it('keeps explicit single-platform upgrade scoped to the selected supported platform after products narrowing', async () => {
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
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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
          platform: 'codex',
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
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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
              installSource: createInstallSource('explicit'),
              dependencyEdges: [],
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

  it('does not treat unreachable auto dependencies as upgrade --all roots and keeps dependency receipt metadata', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (workspaceRepoRoot) => {
        await writeSyntheticPluginManifest(workspaceRepoRoot, createDependencyPluginManifest({
          name: 'upgrade-all-root',
          products: ['codex'],
          dependencies: [{ name: 'reachable-auto-dep' }],
        }));
        await writeSyntheticPluginManifest(workspaceRepoRoot, createDependencyPluginManifest({
          name: 'reachable-auto-dep',
          products: ['codex'],
        }));
        await writeSyntheticPluginManifest(workspaceRepoRoot, createDependencyPluginManifest({
          name: 'orphan-auto-dep',
          products: ['codex'],
        }));
      },
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    const ledger = createAvailableLedger();
    ledger.plugins['upgrade-all-root'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createManagedCodexUserScopeRecord({
            installSource: 'explicit',
            dependencyEdges: [{
              dependency: {
                plugin: 'reachable-auto-dep',
                platform: 'codex',
                scope: 'user',
                projectKey: null,
              },
              declaration: {
                name: 'reachable-auto-dep',
              },
            }],
          }),
        },
      },
    };
    ledger.plugins['reachable-auto-dep'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createManagedCodexUserScopeRecord({
            installSource: 'dependency',
          }),
        },
      },
    };
    ledger.plugins['orphan-auto-dep'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createManagedCodexUserScopeRecord({
            installSource: 'dependency',
          }),
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'upgrade-all-root': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
      'reachable-auto-dep': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
      'orphan-auto-dep': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
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
        adapters: {
          codex,
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.plugins).toEqual(['upgrade-all-root']);
    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'upgrade-all-root',
        requested: true,
      }),
      expect.objectContaining({
        plugin: 'reachable-auto-dep',
        requested: false,
        dependencyOf: [{
          plugin: 'upgrade-all-root',
          platform: 'codex',
          scope: 'user',
        }],
      }),
    ]));
    expect(result.receiptTargets?.some((target) => target.plugin === 'orphan-auto-dep')).toBe(false);
    expect(result.receiptActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'reachable-auto-dep',
        type: 'upgradeDependency',
      }),
    ]));
    expect(codex.extensionInstallCalls).toEqual([
      'reachable-auto-dep',
      'upgrade-all-root',
    ]);
  });

  it('upgrades capability-changed dependencies during upgrade --all without forcing explicit parent repair', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (workspaceRepoRoot) => {
        await writeSyntheticPluginManifest(workspaceRepoRoot, createDependencyPluginManifest({
          name: 'skip-root',
          products: ['codex'],
          dependencies: [{ name: 'capability-changed-dep' }],
        }));
        await writeSyntheticPluginManifest(workspaceRepoRoot, createDependencyPluginManifest({
          name: 'capability-changed-dep',
          products: ['codex'],
        }));
      },
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    const ledger = createAvailableLedger();
    ledger.plugins['skip-root'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createManagedCodexUserScopeRecord({
            installSource: 'explicit',
            dependencyEdges: [{
              dependency: {
                plugin: 'capability-changed-dep',
                platform: 'codex',
                scope: 'user',
                projectKey: null,
              },
              declaration: {
                name: 'capability-changed-dep',
              },
            }],
          }),
        },
      },
    };
    ledger.plugins['capability-changed-dep'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: createManagedCodexUserScopeRecord({
            installSource: 'dependency',
          }),
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const codex = new FakeAdapter('codex', repoRoot, {
      'skip-root': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
      },
      'capability-changed-dep': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'capabilityChanged',
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
        adapters: {
          codex,
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.plugins).toEqual(['skip-root']);
    expect(result.skipped).toEqual([]);
    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'skip-root',
        requested: true,
      }),
      expect.objectContaining({
        plugin: 'capability-changed-dep',
        requested: false,
        dependencyOf: [{
          plugin: 'skip-root',
          platform: 'codex',
          scope: 'user',
        }],
      }),
    ]));
    expect(result.receiptActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'capability-changed-dep',
        type: 'upgradeDependency',
        requested: false,
      }),
    ]));
    expect(codex.extensionInstallCalls).toEqual([
      'capability-changed-dep',
      'skip-root',
    ]);
  });

  it('rejects upgrade --all takeover before evaluating roots', async () => {
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
      },
    });

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
          adapters: {
            codex,
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('`upgrade --all` 不支持 `--takeover-shared-runtime`');

    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
  });
});
