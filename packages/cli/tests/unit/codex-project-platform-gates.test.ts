import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInteractiveUninstallPlan,
  createInteractiveUpgradePlan,
} from '../../src/commands/interactive.js';
import { installCommand } from '../../src/commands/install.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { runWithZeroWriteSnapshot } from '../helpers/repo-managed-state.js';

const tempDirs: string[] = [];

function codexFixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-project-repo-managed',
    ...segments,
  );
}

function repoTemplatePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'repo-template',
    ...segments,
  );
}

async function makeCodexProjectWorkspace(pluginDirs: string[]): Promise<{
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-gates-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(path.join(repoRoot, 'plugins'));
  await fs.copy(
    codexFixturePath('plugins', 'marketplace-source.json'),
    path.join(repoRoot, 'plugins', 'marketplace-source.json'),
  );

  for (const pluginDir of pluginDirs) {
    await fs.copy(
      codexFixturePath('plugins', pluginDir),
      path.join(repoRoot, 'plugins', pluginDir),
    );
  }

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
      PATH: '',
    },
  };
}

async function makeRepoTemplateWorkspace(): Promise<{
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-both-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(repoTemplatePath(), repoRoot);

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
      AW_FORCE_CLAUDE_AVAILABLE: '1',
      PATH: '',
    },
  };
}

function inferArtifactDescriptor(
  plugin: PluginMeta,
  repoRoot: string,
): { path: string; kind: GeneratedArtifact['kind']; artifactKey?: string } {
  if (plugin.manifest.mcpServers) {
    return {
      path: path.join(repoRoot, '.codex', 'config.toml'),
      kind: 'mcpServer',
      artifactKey: 'acme.tools v1',
    };
  }

  if (plugin.manifest.skills || plugin.manifest.slashCommands) {
    return {
      path: path.join(repoRoot, '.agents', 'skills', 'commit'),
      kind: 'skill',
      artifactKey: 'commit',
    };
  }

  return {
    path: path.join(repoRoot, '.codex', 'aw-generated-instruction.md'),
    kind: 'instruction',
  };
}

class GateAdapter implements PlatformAdapter {
  readonly installPluginCalls: string[] = [];
  readonly uninstallPluginCalls: string[] = [];
  readonly installExtensionsCalls: string[] = [];
  readonly uninstallExtensionsCalls: string[] = [];

  constructor(
    readonly name: PlatformName,
    private readonly repoRoot: string,
    private readonly states: Record<string, {
      scopeInitialized?: 'yes' | 'no' | 'unknown';
      currentCatalogAvailable?: boolean;
      nativeInstalled?: boolean;
      runtimeEvidence?: boolean;
      nativeFallback?: boolean;
      catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged';
      externalOwnership?: boolean;
      artifactPath?: string;
      artifactKind?: GeneratedArtifact['kind'];
      artifactKey?: string;
    }> = {},
  ) {}

  private getState(pluginName: string) {
    this.states[pluginName] ??= {};
    return this.states[pluginName];
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    this.installPluginCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallPluginCalls.push(plugin.manifest.name);
    this.getState(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(
    plugin: PluginMeta,
    scope: Scope,
  ): Promise<GeneratedArtifact[]> {
    this.installExtensionsCalls.push(plugin.manifest.name);
    const state = this.getState(plugin.manifest.name);
    const artifact = inferArtifactDescriptor(plugin, this.repoRoot);
    state.artifactPath = artifact.path;
    state.artifactKind = artifact.kind;
    state.artifactKey = artifact.artifactKey;
    state.scopeInitialized = 'yes';

    if (artifact.kind === 'skill') {
      await fs.outputFile(path.join(artifact.path, 'SKILL.md'), `# ${plugin.manifest.name}\n`, 'utf8');
    } else {
      await fs.outputFile(artifact.path, `${this.name}:${plugin.manifest.name}:${scope}\n`, 'utf8');
    }

    return [{
      path: artifact.path,
      kind: artifact.kind,
      platform: this.name,
      artifactKey: artifact.artifactKey,
    }];
  }

  async uninstallExtensions(plugin: PluginMeta): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
    const state = this.getState(plugin.manifest.name);
    if (state.artifactPath) {
      await fs.remove(state.artifactPath);
      state.artifactPath = undefined;
    }
    state.scopeInitialized = 'no';
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
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
          catalogCompatibility: state.catalogCompatibility ?? 'current',
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
            tracking: state.scopeInitialized === 'yes',
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

async function seedCodexProjectManagedEvidence(
  workspace: { repoRoot: string; env: NodeJS.ProcessEnv },
  pluginName: string,
  managedKind: 'skill' | 'mcpServer',
): Promise<void> {
  const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
  const ledger = createAvailableLedger();
  ledger.plugins[pluginName] = {
    lastResolvedVersion: '0.1.0',
    platforms: {
      codex: {
        projectScopes: {
          [projectKey]: {
            managed: true,
            updatedAt: '2026-04-30T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: false,
              hasRepoManagedArtifacts: true,
              projectManagedKinds: [managedKind],
            },
            installSource: {
              kind: 'explicit',
              explicitlyRequested: true,
              allowsUnusedCleanup: false,
            },
            dependencyEdges: [],
          },
        },
        sharedNativeRefs: {
          user: false,
          projects: [],
        },
        lastRequestedScope: 'project',
        lastRequestedAt: '2026-04-30T00:00:00.000Z',
      },
    },
  };
  await writeInstalledLedger(ledger, workspace.env);

  const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
  await upsertTrackingRecord(codexPaths.trackingDir, pluginName, [
    managedKind === 'skill'
      ? {
          path: path.join(workspace.repoRoot, '.agents', 'skills', 'commit'),
          kind: 'skill',
          platform: 'codex',
          artifactKey: 'commit',
        }
      : {
          path: path.join(workspace.repoRoot, '.codex', 'config.toml'),
          kind: 'mcpServer',
          platform: 'codex',
          artifactKey: 'acme.tools v1',
        },
  ]);
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex project platform gates', () => {
  it('allows repo-managed project uninstall without a Codex native executable', async () => {
    const workspace = await makeCodexProjectWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    await seedCodexProjectManagedEvidence(workspace, 'slash-commands-only', 'skill');

    const codex = new GateAdapter('codex', workspace.repoRoot, {
      'slash-commands-only': {
        scopeInitialized: 'yes',
      },
    });
    const claude = new GateAdapter('claude', workspace.repoRoot);

    await expect(
      uninstallCommand(
        ['slash-commands-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['slash-commands-only'],
    });

    expect(codex.uninstallPluginCalls).toEqual(['slash-commands-only']);
    expect(codex.uninstallExtensionsCalls).toEqual(['slash-commands-only']);
  });

  it('allows repo-managed explicit upgrade without a Codex native executable', async () => {
    const workspace = await makeCodexProjectWorkspace(['mcp-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    await seedCodexProjectManagedEvidence(workspace, 'mcp-only', 'mcpServer');

    const codex = new GateAdapter('codex', workspace.repoRoot, {
      'mcp-only': {
        scopeInitialized: 'yes',
        currentCatalogAvailable: true,
        catalogCompatibility: 'current',
      },
    });
    const claude = new GateAdapter('claude', workspace.repoRoot);

    await expect(
      upgradeCommand(
        ['mcp-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['mcp-only'],
    });

    expect(codex.installPluginCalls).toEqual([]);
    expect(codex.installExtensionsCalls).toEqual(['mcp-only']);
  });

  it('keeps upgrade --all executable on auto when the current scope only has Codex project evidence', async () => {
    const workspace = await makeCodexProjectWorkspace(['mcp-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    await seedCodexProjectManagedEvidence(workspace, 'mcp-only', 'mcpServer');

    const codex = new GateAdapter('codex', workspace.repoRoot, {
      'mcp-only': {
        scopeInitialized: 'yes',
        currentCatalogAvailable: true,
        catalogCompatibility: 'current',
      },
    });
    const claude = new GateAdapter('claude', workspace.repoRoot);

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['mcp-only'],
    });

    expect(codex.installExtensionsCalls).toEqual(['mcp-only']);
    expect(claude.installExtensionsCalls).toEqual([]);
  });

  it('auto-infers Codex project uninstall from full tracking and ledger evidence without a Codex native executable', async () => {
    const workspace = await makeCodexProjectWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    await seedCodexProjectManagedEvidence(workspace, 'slash-commands-only', 'skill');

    const codex = new GateAdapter('codex', workspace.repoRoot, {
      'slash-commands-only': {
        scopeInitialized: 'yes',
      },
    });
    const claude = new GateAdapter('claude', workspace.repoRoot, {
      'slash-commands-only': {
        scopeInitialized: 'no',
      },
    });

    await expect(
      uninstallCommand(
        ['slash-commands-only'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['slash-commands-only'],
    });

    expect(codex.uninstallPluginCalls).toEqual(['slash-commands-only']);
    expect(claude.uninstallPluginCalls).toEqual([]);
  });

  it('keeps interactive project uninstall platform choices on Codex evidence even without a Codex native executable', async () => {
    const workspace = await makeCodexProjectWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';
    await seedCodexProjectManagedEvidence(workspace, 'slash-commands-only', 'skill');

    const seenPlatforms: string[][] = [];
    const context = createCommandExecutionContext({
      env: workspace.env,
      interactive: true,
      prompt: {
        selectScope: async () => 'project',
        selectPlatform: async ({ available }) => {
          seenPlatforms.push([...available]);
          return 'codex';
        },
        selectPlugins: async ({ candidates }) => {
          const selected = candidates.find((candidate) =>
            candidate.pluginName === 'slash-commands-only' &&
            candidate.platform === 'codex' &&
            candidate.scope === 'project' &&
            candidate.selectable
          );
          expect(selected).toBeTruthy();
          return [selected!.id];
        },
      },
    });

    const plan = await createInteractiveUninstallPlan(
      [],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'auto',
      },
      context,
      false,
    );

    expect(seenPlatforms).toEqual([['codex']]);
    expect(plan?.groups).toHaveLength(1);
    expect(plan?.groups[0]).toMatchObject({
      pluginNames: ['slash-commands-only'],
      options: {
        platform: 'codex',
        scope: 'project',
      },
    });
  });

  it('rejects auto project uninstall when another executable platform is evidence-unknown and leaves state untouched', async () => {
    const workspace = await makeCodexProjectWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    await seedCodexProjectManagedEvidence(workspace, 'slash-commands-only', 'skill');

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => uninstallCommand(
          ['slash-commands-only'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'auto',
          },
          {
            env: workspace.env,
            adapters: {
              codex: new GateAdapter('codex', workspace.repoRoot, {
                'slash-commands-only': {
                  scopeInitialized: 'yes',
                },
              }),
              claude: new GateAdapter('claude', workspace.repoRoot, {
                'slash-commands-only': {
                  scopeInitialized: 'unknown',
                },
              }),
            },
          },
        ),
      ),
    ).rejects.toThrow('scopeInitialized = unknown');
  });

  it('rejects interactive auto project uninstall before prompting when Claude and Codex evidence both exist', async () => {
    const workspace = await makeCodexProjectWorkspace(['slashCommands-only']);
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    workspace.env.AW_FORCE_CODEX_AVAILABLE = '1';
    await installCommand(
      ['slash-commands-only'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'both',
      },
      {
        env: workspace.env,
        adapters: {
          codex: new GateAdapter('codex', workspace.repoRoot, {
            'slash-commands-only': {
              currentCatalogAvailable: true,
            },
          }),
          claude: new GateAdapter('claude', workspace.repoRoot, {
            'slash-commands-only': {
              currentCatalogAvailable: true,
            },
          }),
        },
      },
    );

    let promptCalled = false;
    const context = createCommandExecutionContext({
      env: workspace.env,
      interactive: true,
      prompt: {
        selectScope: async () => 'project',
        selectPlatform: async () => {
          promptCalled = true;
          return 'codex';
        },
        selectPlugins: async () => {
          promptCalled = true;
          return [];
        },
      },
    });

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => createInteractiveUninstallPlan(
          [],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'auto',
          },
          context,
          false,
        ),
      ),
    ).rejects.toThrow('同时存在 Claude Code 和 Codex');
    expect(promptCalled).toBe(false);
  });

  it('rejects interactive auto project upgrade before prompting when current evidence is unknown', async () => {
    const workspace = await makeCodexProjectWorkspace(['mcp-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';
    await seedCodexProjectManagedEvidence(workspace, 'mcp-only', 'mcpServer');
    await fs.writeFile(
      path.join(resolveCodexPaths(workspace.repoRoot, 'project', workspace.env).trackingDir, '.agent-workflows-manifest.json'),
      '{broken',
      'utf8',
    );

    let promptCalled = false;
    const context = createCommandExecutionContext({
      env: workspace.env,
      interactive: true,
      prompt: {
        selectScope: async () => 'project',
        selectPlatform: async () => {
          promptCalled = true;
          return 'codex';
        },
        selectPlugins: async () => {
          promptCalled = true;
          return [];
        },
      },
    });

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => createInteractiveUpgradePlan(
          [],
          {
            all: false,
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'auto',
          },
          context,
          false,
        ),
      ),
    ).rejects.toThrow('unknown');
    expect(promptCalled).toBe(false);
  });

  it('refuses --platform both before any Claude branch work when the Codex project precheck fails', async () => {
    const workspace = await makeRepoTemplateWorkspace();
    const codex = new GateAdapter('codex', workspace.repoRoot);
    const claude = new GateAdapter('claude', workspace.repoRoot);

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['git-commit'],
          {
            cwd: workspace.repoRoot,
            scope: 'project',
            platform: 'both',
          },
          {
            env: workspace.env,
            adapters: { codex, claude },
          },
        ),
      ),
    ).rejects.toThrow('暂不支持 apps');

    expect(codex.installPluginCalls).toEqual([]);
    expect(codex.installExtensionsCalls).toEqual([]);
    expect(claude.installPluginCalls).toEqual([]);
    expect(claude.installExtensionsCalls).toEqual([]);
  });

  it('keeps Codex dynamic-artifact preflight scoped off the Claude project branch for dual-platform plugins', async () => {
    const workspace = await makeCodexProjectWorkspace(['dynamic-artifacts']);
    const manifestPath = path.join(
      workspace.repoRoot,
      'plugins',
      'dynamic-artifacts',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath);
    manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });

    const dualPlatformEmbeddedRoot = await createSyntheticEmbeddedRoot(workspace.repoRoot);
    tempDirs.push(dualPlatformEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(dualPlatformEmbeddedRoot);

    const codex = new GateAdapter('codex', workspace.repoRoot);
    const claude = new GateAdapter('claude', workspace.repoRoot);
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';

    await expect(
      installCommand(
        ['dynamic-artifacts'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['claude'],
      plugins: ['dynamic-artifacts'],
    });

    expect(codex.installPluginCalls).toEqual([]);
    expect(codex.installExtensionsCalls).toEqual([]);
    expect(claude.installExtensionsCalls).toEqual(['dynamic-artifacts']);
  });
});
