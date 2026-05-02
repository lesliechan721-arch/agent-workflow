import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex.js';
import {
  getCodexProjectInstallability,
} from '../../src/commands/codex-project-installability.js';
import { createInteractiveInstallPlan } from '../../src/commands/interactive.js';
import { installCommand, installTargetsOnPlatforms } from '../../src/commands/install.js';
import { normalizeInstallCommandOptions } from '../../src/commands/options.js';
import { createCommandExecutionContext } from '../../src/commands/runtime.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginManifestSource,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveCodexPaths,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import { readInstalledLedger } from '../../src/utils/local-marketplace.js';
import {
  runWithZeroWriteSnapshot,
} from '../helpers/repo-managed-state.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    'codex-project-repo-managed',
    ...segments,
  );
}

function createPlugin(manifest: Partial<PluginManifestSource>): PluginMeta {
  return {
    rootDir: '/fixture',
    manifestPath: '/fixture/.agents-plugin/plugin.json',
    manifest: {
      name: manifest.name ?? 'fixture',
      version: '0.1.0',
      description: 'Fixture plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
          products: ['CODEX'],
        },
      },
      ...manifest,
    },
  };
}

async function makeWorkspace(pluginDirs: string[]): Promise<{
  root: string;
  repoRoot: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-project-installability-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.ensureDir(path.join(repoRoot, 'plugins'));
  await fs.ensureDir(repoRoot);
  await fs.copy(
    fixturePath('plugins', 'marketplace-source.json'),
    path.join(repoRoot, 'plugins', 'marketplace-source.json'),
  );

  for (const pluginDir of pluginDirs) {
    await fs.copy(
      fixturePath('plugins', pluginDir),
      path.join(repoRoot, 'plugins', pluginDir),
    );
  }
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  const env = {
    ...process.env,
    AW_HOME: path.join(root, 'aw-home'),
    AW_CODEX_HOME: path.join(root, 'codex-home'),
    AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  return {
    root,
    repoRoot,
    embeddedRoot,
    env,
  };
}

async function listFilesRecursively(root: string): Promise<string[]> {
  if (!(await fs.pathExists(root))) {
    return [];
  }

  const entries: string[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(current)) {
      const absolutePath = path.join(current, entry);
      const nextRelative = path.join(relative, entry);
      const stats = await fs.lstat(absolutePath);
      if (stats.isDirectory()) {
        await walk(absolutePath, nextRelative);
        continue;
      }

      entries.push(nextRelative);
    }
  };

  await walk(root, '');
  return entries.sort();
}

class RecordingAdapter implements PlatformAdapter {
  readonly nativeInstallCalls: string[] = [];
  readonly extensionInstallCalls: string[] = [];

  constructor(
    readonly name: PlatformName,
    private readonly repoRoot: string,
    private readonly scopeInitializedByPlugin: Record<string, 'yes' | 'no' | 'unknown'> = {},
  ) {}

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    this.nativeInstallCalls.push(`${plugin.manifest.name}:${scope}`);
  }

  async uninstallPlugin(): Promise<void> {}

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    this.extensionInstallCalls.push(`${plugin.manifest.name}:${scope}`);
    const artifactPath = path.join(this.repoRoot, '.codex', 'config.toml');
    await fs.ensureDir(path.dirname(artifactPath));
    await fs.writeFile(artifactPath, '[mcp_servers]\n', 'utf8');
    return [{
      path: artifactPath,
      kind: 'mcpServer',
      platform: this.name,
      artifactKey: 'acme.tools v1',
    }];
  }

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await this.installPlugin(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const scopeInitialized = this.scopeInitializedByPlugin[plugin.manifest.name] ?? 'no';
    return {
      platform: this.name,
      scope,
      initialized: scopeInitialized === 'yes',
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
        scopeInitialized,
        catalogCompatibility: 'current',
        scopeManagedEvidence: {
          ledger: scopeInitialized === 'yes',
          tracking: scopeInitialized === 'yes',
          sharedNativeRef: false,
        },
      }],
    };
  }
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('Codex project installability', () => {
  it('treats skills, MCP, slashCommands, and extensions as project-managed kinds', () => {
    expect(getCodexProjectInstallability(createPlugin({ skills: './skills' }))).toMatchObject({
      installable: true,
      managedKinds: ['skill'],
    });
    expect(getCodexProjectInstallability(createPlugin({ mcpServers: './.mcp.json' }))).toMatchObject({
      installable: true,
      managedKinds: ['mcpServer'],
    });
    expect(getCodexProjectInstallability(createPlugin({ slashCommands: './slash-commands' }))).toMatchObject({
      installable: true,
      managedKinds: ['skill'],
    });
    expect(getCodexProjectInstallability(createPlugin({
      extensions: {
        instructions: [{
          name: 'guide',
          title: 'Guide',
          content: 'Use the guide.',
        }],
      },
    }))).toMatchObject({
      installable: true,
      managedKinds: ['instruction'],
    });
  });

  it('fails apps and native-only Codex project installs before writing state', async () => {
    const workspace = await makeWorkspace(['apps-only', 'apps-mixed', 'native-only']);

    for (const [pluginName, expected] of [
      ['apps-only', '暂不支持 apps'],
      ['apps-mixed', '暂不支持 apps'],
      ['native-only', '没有任何 Codex project-managed kind'],
    ] as const) {
      await expect(
        runWithZeroWriteSnapshot(
          {
            repoRoot: workspace.repoRoot,
            env: workspace.env,
          },
          () => installCommand(
            [pluginName],
            {
              cwd: workspace.repoRoot,
              platform: 'codex',
              scope: 'project',
            },
            {
              env: workspace.env,
            },
          ),
        ),
      ).rejects.toThrow(expected);
    }
  });

  it('skips Codex native registration for project-managed MCP installs', async () => {
    const workspace = await makeWorkspace(['mcp-only']);
    const plugin = await readPluginManifest(
      path.join(workspace.embeddedRoot, 'plugins', 'mcp-only'),
      { mode: 'bundle' },
    );
    const codex = new RecordingAdapter('codex', workspace.repoRoot);
    const claude = new RecordingAdapter('claude', workspace.repoRoot);

    const result = await installTargetsOnPlatforms(
      [{
        pluginName: 'mcp-only',
        plugin,
        currentPlugin: plugin,
        embeddedPlugin: plugin,
        source: 'currentCatalog',
      }],
      ['codex'],
      {
        cwd: workspace.repoRoot,
        platform: 'codex',
        scope: 'project',
      },
      {
        env: workspace.env,
        adapters: { codex, claude },
      },
    );

    expect(codex.nativeInstallCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual(['mcp-only:project']);
    expect(result.nativePlugins.codex).toBeUndefined();
  });

  it('allows explicit Codex project repo-managed install without a Codex native executable', async () => {
    const workspace = await makeWorkspace(['mcp-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';
    const codex = new RecordingAdapter('codex', workspace.repoRoot);
    const claude = new RecordingAdapter('claude', workspace.repoRoot);

    await expect(
      installCommand(
        ['mcp-only'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'project',
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

    expect(codex.nativeInstallCalls).toEqual([]);
    expect(codex.extensionInstallCalls).toEqual(['mcp-only:project']);
  });

  it('uses a read-only catalog for Codex project-only install without creating shared runtime', async () => {
    const workspace = await makeWorkspace(['mcp-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';
    const codex = new RecordingAdapter('codex', workspace.repoRoot);
    const claude = new RecordingAdapter('claude', workspace.repoRoot);

    const result = await installCommand(
      ['mcp-only'],
      {
        cwd: workspace.repoRoot,
        platform: 'codex',
        scope: 'project',
      },
      {
        env: workspace.env,
        adapters: { codex, claude },
      },
    );

    expect(result).toMatchObject({
      platforms: ['codex'],
      plugins: ['mcp-only'],
      marketplace: {
        source: 'embedded',
        changed: false,
      },
    });
    expect(result.nativePlugins.codex).toBeUndefined();
    await expect(fs.pathExists(path.join(workspace.env.AW_HOME!, 'installed.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(workspace.env.AW_HOME!, 'config.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(workspace.env.AW_HOME!, 'plugins'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(workspace.env.AW_HOME!, '.agents'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(workspace.env.AW_HOME!, '.claude-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(workspace.env.AW_CODEX_HOME!, 'config.toml'))).resolves.toBe(false);
  });

  it('installs the extensions-only fixture as repo-managed Codex project artifacts', async () => {
    const workspace = await makeWorkspace(['extensions-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';

    const result = await installCommand(
      ['extensions-only'],
      {
        cwd: workspace.repoRoot,
        platform: 'codex',
        scope: 'project',
      },
      {
        env: workspace.env,
      },
    );

    expect(result.nativePlugins.codex).toBeUndefined();

    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    await expect(fs.readFile(codexPaths.configTomlPath, 'utf8')).resolves.toContain(
      'Use this managed instruction only for Codex project repo-managed fixture assertions.',
    );
    await expect(
      fs.readFile(path.join(codexPaths.configDir, 'rules', 'aw-extensions-only-fixture-permissions.rules'), 'utf8'),
    ).resolves.toContain('prefix_rule(pattern = ["git","status"], decision = "allow")');
    await expect(fs.readJson(codexPaths.hooksPath)).resolves.toMatchObject({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo extensions-only hook' }],
          },
        ],
      },
    });
    await expect(
      fs.readFile(path.join(codexPaths.configDir, 'agents', 'aw-extensions-only-fixture-reviewer.toml'), 'utf8'),
    ).resolves.toContain('name = "fixture-reviewer"');

    const tracking = await readTrackingManifest(codexPaths.trackingDir);
    expect(tracking.plugins['extensions-only']?.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      'agent',
      'hook',
      'instruction',
      'permission',
    ]);
  });

  it('rolls back repo artifacts, tracking, and install snapshots when a post-ledger hook fails', async () => {
    const workspace = await makeWorkspace(['mcp-only']);
    const plugin = await readPluginManifest(
      path.join(workspace.embeddedRoot, 'plugins', 'mcp-only'),
      { mode: 'bundle' },
    );
    const codex = new CodexAdapter(workspace.repoRoot, workspace.env);
    const claude = new RecordingAdapter('claude', workspace.repoRoot);
    let threwAfterLedger = false;

    await expect(
      installTargetsOnPlatforms(
        [{
          pluginName: 'mcp-only',
          plugin,
          currentPlugin: plugin,
          embeddedPlugin: plugin,
          source: 'currentCatalog',
        }],
        ['codex'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'project',
        },
        {
          env: workspace.env,
          adapters: { codex, claude },
          resolveInstallOptions: () => ({
            applicability: 'none',
            ledgerTrust: 'available',
          }),
          reporter: {
            async event(event) {
              if (!threwAfterLedger && event.type === 'ledger:written') {
                threwAfterLedger = true;
                throw new Error('post-ledger boom');
              }
            },
            async notice() {},
          },
          debugLogger: {
            async log() {},
          },
        },
      ),
    ).rejects.toThrow('post-ledger boom');

    const codexPaths = resolveCodexPaths(workspace.repoRoot, 'project', workspace.env);
    await expect(fs.pathExists(codexPaths.configTomlPath)).resolves.toBe(false);
    await expect(readTrackingManifest(codexPaths.trackingDir)).resolves.toMatchObject({
      plugins: {},
    });
    await expect(readInstalledLedger(workspace.env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
    await expect(
      listFilesRecursively(path.join(workspace.env.AW_HOME!, 'plugin-install-snapshots')),
    ).resolves.toEqual([]);
  });

  it('still requires Codex native availability for user scope and native-only Codex targets', async () => {
    const workspace = await makeWorkspace(['mcp-only', 'native-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';

    await expect(
      installCommand(
        ['mcp-only'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'user',
        },
        {
          env: workspace.env,
        },
      ),
    ).rejects.toThrow('Codex user scope 需要本机 Codex native runner');

    await expect(
      installCommand(
        ['native-only'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'project',
        },
        {
          env: workspace.env,
        },
      ),
    ).rejects.toThrow('需要本机 Codex native runner');
  });

  it('rejects ambiguous project auto install before writes when Claude and Codex project are both executable without evidence', async () => {
    const workspace = await makeWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    workspace.env.PATH = '';

    await expect(
      runWithZeroWriteSnapshot(
        {
          repoRoot: workspace.repoRoot,
          env: workspace.env,
        },
        () => installCommand(
          ['slash-commands-only'],
          {
            cwd: workspace.repoRoot,
            platform: 'auto',
            scope: 'project',
          },
          {
            env: workspace.env,
            adapters: {
              codex: new RecordingAdapter('codex', workspace.repoRoot),
              claude: new RecordingAdapter('claude', workspace.repoRoot),
            },
          },
        ),
      ),
    ).rejects.toThrow('无法从当前 scope 的初始化状态唯一推断目标平台');
  });

  it('uses current scope managed evidence to infer Codex project for auto install without a Codex native executable', async () => {
    const workspace = await makeWorkspace(['slashCommands-only']);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    workspace.env.PATH = '';
    const codex = new RecordingAdapter('codex', workspace.repoRoot, {
      'slash-commands-only': 'yes',
    });
    const claude = new RecordingAdapter('claude', workspace.repoRoot);

    await expect(
      installCommand(
        ['slash-commands-only'],
        {
          cwd: workspace.repoRoot,
          platform: 'auto',
          scope: 'project',
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

    expect(codex.extensionInstallCalls).toEqual(['slash-commands-only:project']);
    expect(claude.extensionInstallCalls).toEqual([]);
  });

  it('applies Codex project installability to explicit upgrade targets', async () => {
    const workspace = await makeWorkspace(['apps-mixed']);

    await expect(
      upgradeCommand(
        ['apps-mixed'],
        {
          cwd: workspace.repoRoot,
          platform: 'codex',
          scope: 'project',
        },
        {
          env: workspace.env,
        },
      ),
    ).rejects.toThrow('暂不支持 apps');
  });

  it('filters interactive Codex project install candidates for apps and project-managed artifacts', async () => {
    const workspace = await makeWorkspace([
      'apps-only',
      'apps-mixed',
      'mcp-only',
      'native-only',
      'skills-only',
    ]);
    const seenCandidates: Array<{
      pluginName: string;
      platform?: string;
      selectable: boolean;
      disabledReason?: string;
      id: string;
    }> = [];
    const context = createCommandExecutionContext({
      env: workspace.env,
      interactive: true,
      prompt: {
        selectScope: async () => 'project',
        selectPlatform: async ({ available }) => {
          expect(available).toEqual(['codex']);
          return 'codex';
        },
        selectPlugins: async ({ candidates }) => {
          seenCandidates.push(...candidates);
          const selected = candidates.find((candidate) =>
            candidate.pluginName === 'skills-only' &&
            candidate.platform === 'codex' &&
            candidate.selectable
          );
          expect(selected).toBeTruthy();
          return [selected!.id];
        },
      },
    });

    const plan = await createInteractiveInstallPlan(
      [],
      normalizeInstallCommandOptions({
        cwd: workspace.repoRoot,
        platform: 'codex',
        scope: 'project',
      }),
      context,
      false,
    );

    expect(plan?.groups[0]?.pluginNames).toEqual(['skills-only']);
    expect(seenCandidates.map((candidate) => candidate.pluginName)).not.toContain('apps-only');
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'skills-only')).toMatchObject({
      selectable: true,
    });
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'mcp-only')).toMatchObject({
      selectable: true,
    });
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'apps-mixed')).toMatchObject({
      selectable: false,
      disabledReason: expect.stringContaining('--scope user'),
    });
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'apps-mixed')?.disabledReason)
      .toContain('拆分插件');
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'native-only')).toMatchObject({
      selectable: false,
      disabledReason: expect.stringContaining('project-managed kind'),
    });
  });

  it('keeps Codex project interactive install visible without a Codex executable when repo-managed candidates exist', async () => {
    const workspace = await makeWorkspace([
      'native-only',
      'skills-only',
      'slashCommands-only',
    ]);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';

    const seenPlatforms: string[][] = [];
    const seenCandidates: Array<{
      pluginName: string;
      platform?: string;
      selectable: boolean;
      disabledReason?: string;
    }> = [];
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
          seenCandidates.push(...candidates);
          const selected = candidates.find((candidate) =>
            candidate.pluginName === 'slash-commands-only' &&
            candidate.platform === 'codex' &&
            candidate.selectable
          );
          expect(selected).toBeTruthy();
          return [selected!.id];
        },
      },
    });

    const plan = await createInteractiveInstallPlan(
      [],
      normalizeInstallCommandOptions({
        cwd: workspace.repoRoot,
        platform: 'auto',
        scope: 'project',
      }),
      context,
      false,
    );

    expect(seenPlatforms).toEqual([['codex']]);
    expect(plan?.groups[0]?.pluginNames).toEqual(['slash-commands-only']);
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'skills-only')).toMatchObject({
      selectable: true,
    });
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'slash-commands-only')).toMatchObject({
      selectable: true,
    });
    expect(seenCandidates.find((candidate) => candidate.pluginName === 'native-only')).toMatchObject({
      selectable: false,
      disabledReason: expect.stringContaining('project-managed kind'),
    });
  });
});
