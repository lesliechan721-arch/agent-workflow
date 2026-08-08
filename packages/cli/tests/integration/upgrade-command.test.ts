import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import * as commonModule from '../../src/commands/common.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import * as pluginCatalogModule from '../../src/utils/plugin-catalog.js';
import * as pluginScriptsModule from '../../src/utils/plugin-scripts.js';
import type {
  AgentVersionGateErrorPayload,
  CatalogResolution,
  GeneratedArtifact,
  NativeRecoveryState,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { clearCurrentCatalogResolutionMemoForTests } from '../../src/utils/plugin-catalog.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import { writeCodexNativeRecoveryBreadcrumb } from '../../src/utils/codex-native-recovery.js';
import { createAvailableLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { getInstallRecordPath } from '../../src/install-state/paths.js';
import {
  resolveCodexPaths,
  resolveClaudeProjectKey,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { resolveSafeCliEnv } from '../helpers/cli-runtime.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  activateCliEmbeddedRoot,
  registerCliCatalogSourceRoot,
  registerCliEmbeddedRoot,
  registerCliFixtureRepoRoot,
  registerCliTempRoot,
} from '../helpers/workspace.js';
import { registerCurrentTestReadonlyFixtureRoot } from '../setup/test-isolation.js';
import { createDependencyPluginManifest } from '../support/plugin-dependency-fixtures.js';
import type { InstallRecordFile, PluginLocation as InstallStatePluginLocation } from '../../src/install-state/types.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

function registerRepoFixtureRoots(): void {
  registerCurrentTestReadonlyFixtureRoot(fixturePath(), 'upgrade command fixture root');
}

function replaceProcessEnv(nextEnv: NodeJS.ProcessEnv): void {
  const nextKeys = new Set(Object.keys(nextEnv));

  for (const key of Object.keys(process.env)) {
    if (!nextKeys.has(key)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function createAgentVersionRunner(options: {
  codex?: string;
  claude?: string;
} = {}): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(`Unexpected native CLI invocation in upgrade-command.test.ts: ${invocation.command} ${invocation.args.join(' ')}`.trim());
    }

    if (invocation.command === 'codex') {
      return {
        exitCode: 0,
        stdout: options.codex ?? 'codex-cli 0.145.0',
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

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string }> {
  registerRepoFixtureRoots();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-command-'));
  tempDirs.push(root);
  registerCliTempRoot(root, 'upgrade command root');

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'upgrade command repo root');
  await removeAppsFromGitCommit(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  registerCliEmbeddedRoot(embeddedRoot, 'upgrade command embedded root');
  registerCliCatalogSourceRoot(
    getCatalogFullPackageRoot(embeddedRoot),
    'upgrade command catalog source root',
  );

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
  registerRepoFixtureRoots();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-upgrade-command-'));
  tempDirs.push(root);
  registerCliTempRoot(root, 'upgrade command mutated root');

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'upgrade command mutated repo root');
  await removeAppsFromGitCommit(repoRoot);
  await mutateRepo(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  registerCliEmbeddedRoot(embeddedRoot, 'upgrade command mutated embedded root');
  registerCliCatalogSourceRoot(
    getCatalogFullPackageRoot(embeddedRoot),
    'upgrade command mutated catalog source root',
  );

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

function activateWorkspaceEnv(
  workspace: {
    awHome: string;
    codexHome: string;
    embeddedRoot: string;
  },
  options: {
    forceClaude?: boolean;
    overrides?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const env = resolveSafeCliEnv({
    AW_HOME: workspace.awHome,
    AW_CODEX_HOME: workspace.codexHome,
    PATH: '',
    AW_FORCE_CODEX_AVAILABLE: '1',
    ...(options.forceClaude ? { AW_FORCE_CLAUDE_AVAILABLE: '1' } : {}),
    ...options.overrides,
  });
  replaceProcessEnv(env);
  activateCliEmbeddedRoot(workspace.embeddedRoot, 'upgrade command embedded root activation');
  return env;
}

async function writeUpgradeInstallRecord(options: {
  repoRoot: string;
  env: NodeJS.ProcessEnv;
  pluginName?: string;
  pluginVersion?: string;
  platform?: PlatformName;
  scope?: 'user' | 'project';
  projectKey?: string;
}): Promise<void> {
  const pluginName = options.pluginName ?? 'git-commit';
  const platform = options.platform ?? 'codex';
  const scope = options.scope ?? 'project';
  const location: InstallStatePluginLocation = {
    plugin: pluginName,
    platform,
    scope,
    ...(scope === 'project' ? { projectKey: options.projectKey ?? options.repoRoot } : {}),
  };
  const recordPath = getInstallRecordPath(options.repoRoot, location, options.env, 'write');
  await fs.ensureDir(path.dirname(recordPath));
  const recordId = path.basename(recordPath, '.json');
  const record: InstallRecordFile = {
    version: 2,
    recordId,
    record: {
      pluginName,
      platform,
      scope,
      ...(scope === 'project' ? { projectKey: location.projectKey } : {}),
      installedAt: '2026-04-29T00:00:00.000Z',
      updatedAt: '2026-04-29T00:00:00.000Z',
      source: {
        pluginVersion: options.pluginVersion ?? '0.1.0',
        manifestDigest: 'synthetic-upgrade-manifest-digest',
        bundleFingerprint: 'synthetic-upgrade-bundle-fingerprint',
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      artifacts: [],
      dependencyEdges: [],
    },
  };
  await fs.writeJson(recordPath, record, { spaces: 2 });
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
  readonly catalogResolutions: Array<CatalogResolution | undefined> = [];
  readonly marketplacePreparedValues: Array<boolean | undefined> = [];
  readonly statusArtifactStates: boolean[] = [];

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

  async installPlugin(
    plugin: PluginMeta,
    _scope: 'project' | 'user',
    options?: Parameters<PlatformAdapter['installPlugin']>[2],
  ): Promise<void> {
    this.catalogResolutions.push(options?.catalogResolution);
    this.marketplacePreparedValues.push(options?.marketplacePrepared);
    this.installCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(
    plugin: PluginMeta,
    scope: 'project' | 'user',
    options?: Parameters<PlatformAdapter['installExtensions']>[2],
  ): Promise<GeneratedArtifact[]> {
    this.catalogResolutions.push(options?.catalogResolution);
    this.marketplacePreparedValues.push(options?.marketplacePrepared);
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

  async upgradePlugin(
    plugin: PluginMeta,
    scope: 'project' | 'user',
    options?: Parameters<PlatformAdapter['upgradePlugin']>[2],
  ): Promise<void> {
    await this.installPlugin(plugin, scope, options);
    await this.installExtensions(plugin, scope, options);
  }

  async status(
    plugin: PluginMeta,
    scope: 'project' | 'user',
    options?: Parameters<PlatformAdapter['status']>[2],
  ): Promise<StatusReport> {
    this.catalogResolutions.push(options?.catalogResolution);
    const state = this.getState(plugin.manifest.name);
    this.statusArtifactStates.push(Boolean(state.artifactPath));
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
  clearCurrentCatalogResolutionMemoForTests();
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
    const readOnlyCatalogSpy = vi.spyOn(localMarketplaceModule, 'resolveReadOnlyCatalogResolution')
      .mockRejectedValue(new Error('HTTP 404 Not Found'));
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

    expect(readOnlyCatalogSpy).not.toHaveBeenCalled();
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    ).rejects.toThrow('有效 install record');
  });

  it('reapplies current catalog for capability-changed plugins without pre-uninstall', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

    await initCommand({ force: true });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      scope: 'project',
      platform: 'codex',
      projectKey: await resolveCodexProjectKey(repoRoot),
    });

    const codex = new FakeAdapter('codex', repoRoot, {
      'git-commit': {
        currentCatalogAvailable: true,
        nativeInstalled: true,
        scopeInitialized: 'yes',
        catalogCompatibility: 'capabilityChanged',
      },
    });
    clearCurrentCatalogResolutionMemoForTests();
    const resolveCatalogSpy = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');
    const ensureLocalMarketplaceSpy = vi.spyOn(localMarketplaceModule, 'ensureLocalMarketplace');

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
    expect(resolveCatalogSpy).toHaveBeenCalledTimes(1);
    const catalog = await resolveCatalogSpy.mock.results[0]!.value;
    expect(codex.catalogResolutions.length).toBeGreaterThanOrEqual(4);
    expect(codex.catalogResolutions.every((resolution) => resolution === catalog)).toBe(true);
    expect(codex.marketplacePreparedValues).toEqual([true]);
    expect(ensureLocalMarketplaceSpy).toHaveBeenCalledTimes(1);
    expect(codex.statusArtifactStates.at(0)).toBe(false);
    expect(codex.statusArtifactStates.at(-1)).toBe(true);
  });

  it('preflights missing required config during upgrade, rejects without prompting, and avoids config/native writes', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addRequiredConfigSchemaToGitCommit,
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      scope: 'project',
      platform: 'codex',
      projectKey,
    });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
          await writeUpgradeInstallRecord({ repoRoot, env: process.env, scope: 'project', platform: 'codex', projectKey: await resolveCodexProjectKey(repoRoot) });
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
      activateWorkspaceEnv(workspace);

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      scope: 'project',
      platform: 'codex',
      projectKey: codexProjectKey,
    });
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      scope: 'project',
      platform: 'claude',
      projectKey: claudeProjectKey,
    });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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
    await writeUpgradeInstallRecord({
      repoRoot: nestedCwd,
      env: process.env,
      scope: 'project',
      platform: 'codex',
      projectKey: codexProjectKey,
    });
    await writeUpgradeInstallRecord({
      repoRoot: nestedCwd,
      env: process.env,
      scope: 'project',
      platform: 'claude',
      projectKey: claudeProjectKey,
    });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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

  it('rejects upgrade --all with --platform both when one agent version is blocked', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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

    const ensureLocalMarketplaceSpy = vi.spyOn(localMarketplaceModule, 'ensureLocalMarketplace');
    let payload: AgentVersionGateErrorPayload | null = null;
    try {
      await upgradeCommand(
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
          nativeCliRunner: createAgentVersionRunner({
            claude: '2.1.87 (Claude Code)',
          }),
        },
      );
    } catch (error) {
      payload = (error as { payload?: AgentVersionGateErrorPayload }).payload ?? null;
      expect(error).toBeInstanceOf(Error);
    }

    expect(payload).toMatchObject({
      command: 'upgradeAll',
      failures: [{
        platform: 'claude',
        reasonCode: 'agentVersionTooLow',
        detectedVersion: '2.1.87',
        requiredMinVersion: '2.1.88',
      }],
    });
    expect(ensureLocalMarketplaceSpy).not.toHaveBeenCalled();
  });

  it('keeps explicit single-platform upgrade scoped to the selected supported platform after products narrowing', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      restrictGitCommitToCodex,
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      scope: 'project',
      platform: 'codex',
      projectKey: codexProjectKey,
    });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceClaude: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      pluginName: 'upgrade-all-root',
      scope: 'user',
      platform: 'codex',
    });
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      pluginName: 'reachable-auto-dep',
      scope: 'user',
      platform: 'codex',
    });
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      pluginName: 'orphan-auto-dep',
      scope: 'user',
      platform: 'codex',
    });

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
    clearCurrentCatalogResolutionMemoForTests();
    const resolveCatalogSpy = vi.spyOn(pluginCatalogModule, 'resolveCurrentCatalog');
    const ensureLocalMarketplaceSpy = vi.spyOn(localMarketplaceModule, 'ensureLocalMarketplace');

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

    expect(result.plugins).toEqual(['orphan-auto-dep', 'reachable-auto-dep', 'upgrade-all-root']);
    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'upgrade-all-root',
        requested: true,
      }),
      expect.objectContaining({
        plugin: 'reachable-auto-dep',
        requested: true,
        dependencyOf: [{
          plugin: 'upgrade-all-root',
          platform: 'codex',
          scope: 'user',
        }],
      }),
    ]));
    expect(result.receiptTargets?.some((target) => target.plugin === 'orphan-auto-dep')).toBe(true);
    expect(result.receiptActions).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([
      'orphan-auto-dep',
      'reachable-auto-dep',
      'upgrade-all-root',
    ]);
    expect(resolveCatalogSpy).toHaveBeenCalledTimes(1);
    const catalog = await resolveCatalogSpy.mock.results[0]!.value;
    expect(codex.catalogResolutions.length).toBeGreaterThanOrEqual(12);
    expect(codex.catalogResolutions.every((resolution) => resolution === catalog)).toBe(true);
    expect(codex.marketplacePreparedValues.length).toBeGreaterThan(0);
    expect(codex.marketplacePreparedValues.every((prepared) => prepared === true)).toBe(true);
    expect(ensureLocalMarketplaceSpy).toHaveBeenCalledTimes(1);
    expect(codex.statusArtifactStates.at(0)).toBe(false);
    expect(codex.statusArtifactStates.at(-1)).toBe(true);
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      pluginName: 'skip-root',
      scope: 'user',
      platform: 'codex',
    });
    await writeUpgradeInstallRecord({
      repoRoot,
      env: process.env,
      pluginName: 'capability-changed-dep',
      scope: 'user',
      platform: 'codex',
    });

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

    expect(result.plugins).toEqual(['capability-changed-dep', 'skip-root']);
    expect(result.skipped).toEqual([]);
    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'skip-root',
        requested: true,
      }),
      expect.objectContaining({
        plugin: 'capability-changed-dep',
        requested: true,
        dependencyOf: [{
          plugin: 'skip-root',
          platform: 'codex',
          scope: 'user',
        }],
      }),
    ]));
    expect(result.receiptTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'capability-changed-dep',
        requested: true,
      }),
    ]));
    expect(codex.extensionInstallCalls).toEqual([
      'capability-changed-dep',
      'skip-root',
    ]);
  });

  it('rejects upgrade --all takeover before evaluating roots', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot });

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
    ).rejects.toThrow('`upgrade` 不再接受 `--takeover-shared-runtime`');

    expect(codex.installCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual([]);
  });
});
