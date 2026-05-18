import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { runConsoleController } from '../../src/commands/console.js';
import { initCommand } from '../../src/commands/init.js';
import { installCommand } from '../../src/commands/install.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { readInstallRecordFileAt } from '../../src/install-state/facade.js';
import { getInstallStatePrivateRoot } from '../../src/install-state/paths.js';
import type { InstallRecordFile } from '../../src/install-state/types.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  removeCodexPluginEnabledFile,
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const tempDirs: string[] = [];
const originalEnv = {
  AW_HOME: process.env.AW_HOME,
  AW_CODEX_HOME: process.env.AW_CODEX_HOME,
  AW_CLAUDE_HOME: process.env.AW_CLAUDE_HOME,
  AW_FORCE_CODEX_AVAILABLE: process.env.AW_FORCE_CODEX_AVAILABLE,
  AW_FORCE_CLAUDE_AVAILABLE: process.env.AW_FORCE_CLAUDE_AVAILABLE,
  PATH: process.env.PATH,
};

interface FakePluginState {
  nativeInstalled?: boolean;
  scopeInitialized?: 'yes' | 'no';
  managedEvidence?: boolean;
}

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
}

async function makeWorkspace(): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-console-duplicate-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await removeAppsFromGitCommit(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    codexHome: path.join(root, 'codex-home'),
    claudeHome: path.join(root, 'claude-home'),
    embeddedRoot,
  };
}

function configureWorkspaceEnv(workspace: {
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
}): void {
  process.env.AW_HOME = workspace.awHome;
  process.env.AW_CODEX_HOME = workspace.codexHome;
  process.env.AW_CLAUDE_HOME = workspace.claudeHome;
  process.env.AW_FORCE_CODEX_AVAILABLE = '1';
  process.env.PATH = '';
  setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
}

function codexNativeManifestPath(codexHome: string, pluginName: string): string {
  return path.join(codexHome, 'plugins', `${pluginName}@aw`, 'manifest.json');
}

function codexNativeCachePath(codexHome: string, pluginName: string): string {
  return path.join(codexHome, 'plugins', 'cache', 'aw', pluginName);
}

async function writeCodexNativeEvidence(codexHome: string, pluginName: string): Promise<void> {
  await upsertCodexPluginEnabledFile(
    path.join(codexHome, 'config.toml'),
    `${pluginName}@aw`,
    { enabled: true },
  );
  await fs.outputJson(
    codexNativeManifestPath(codexHome, pluginName),
    { name: `${pluginName}@aw`, version: '0.1.0' },
    { spaces: 2 },
  );
  await fs.ensureDir(codexNativeCachePath(codexHome, pluginName));
}

async function removeCodexNativeEvidence(codexHome: string, pluginName: string): Promise<void> {
  await removeCodexPluginEnabledFile(
    path.join(codexHome, 'config.toml'),
    `${pluginName}@aw`,
  );
  await fs.remove(path.join(codexHome, 'plugins', `${pluginName}@aw`));
  await fs.remove(codexNativeCachePath(codexHome, pluginName));
}

class FakeAdapter implements PlatformAdapter {
  readonly name: PlatformName;

  constructor(
    name: PlatformName,
    private readonly states: Record<string, FakePluginState> = {},
  ) {
    this.name = name;
  }

  private getState(pluginName: string): FakePluginState {
    this.states[pluginName] ??= {};
    return this.states[pluginName]!;
  }

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    const state = this.getState(plugin.manifest.name);
    state.nativeInstalled = true;
    if (this.name === 'codex' && scope === 'user') {
      await writeCodexNativeEvidence(process.env.AW_CODEX_HOME!, plugin.manifest.name);
    }
  }

  async uninstallPlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    this.getState(plugin.manifest.name).nativeInstalled = false;
    if (this.name === 'codex' && scope === 'user') {
      await removeCodexNativeEvidence(process.env.AW_CODEX_HOME!, plugin.manifest.name);
    }
  }

  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    await this.installPlugin(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: 'project' | 'user'): Promise<StatusReport> {
    const state = this.getState(plugin.manifest.name);
    return {
      platform: this.name,
      scope,
      initialized: state.scopeInitialized === 'yes' || state.nativeInstalled === true,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: state.nativeInstalled === true,
          pluginAvailable: true,
          pluginInstalled: state.nativeInstalled === true,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
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
          ledger: state.managedEvidence === true,
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
          instructions: 'absent',
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

function createAdapters(): Record<PlatformName, PlatformAdapter> {
  return {
    codex: new FakeAdapter('codex'),
    claude: new FakeAdapter('claude'),
  };
}

async function seedLegacyCodexUserHealthySiblingInstall(workspace: {
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
}): Promise<void> {
  const sibling = await makeWorkspace();
  process.env.AW_HOME = workspace.awHome;
  process.env.AW_CODEX_HOME = workspace.codexHome;
  process.env.AW_CLAUDE_HOME = workspace.claudeHome;
  process.env.AW_FORCE_CODEX_AVAILABLE = '1';
  process.env.PATH = '';
  setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

  await installCommand(
    ['git-commit'],
    {
      cwd: sibling.repoRoot,
      scope: 'user',
      platform: 'codex',
      requestedSkillTrigger: 'manual',
    },
    {
      adapters: createAdapters(),
      env: process.env,
    },
  );

  configureWorkspaceEnv(workspace);
}

async function readScopedInstallRecords(
  cwd: string,
  platform: PlatformName,
  scope: 'user' | 'project',
): Promise<InstallRecordFile[]> {
  const recordsDir = path.join(
    getInstallStatePrivateRoot(
      cwd,
      {
        plugin: 'unused',
        platform,
        scope,
        ...(scope === 'project' ? { projectKey: 'repo:fixture-project' } : {}),
      },
      process.env,
    ),
    'records',
  );
  if (!(await fs.pathExists(recordsDir))) {
    return [];
  }

  const entries = (await fs.readdir(recordsDir))
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const records: InstallRecordFile[] = [];
  for (const entry of entries) {
    const read = await readInstallRecordFileAt(path.join(recordsDir, entry));
    if (read.status === 'ok') {
      records.push(read.value);
    }
  }
  return records;
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  process.env.AW_HOME = originalEnv.AW_HOME;
  process.env.AW_CODEX_HOME = originalEnv.AW_CODEX_HOME;
  process.env.AW_CLAUDE_HOME = originalEnv.AW_CLAUDE_HOME;
  process.env.AW_FORCE_CODEX_AVAILABLE = originalEnv.AW_FORCE_CODEX_AVAILABLE;
  process.env.AW_FORCE_CLAUDE_AVAILABLE = originalEnv.AW_FORCE_CLAUDE_AVAILABLE;
  process.env.PATH = originalEnv.PATH;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('console duplicate resolution integration', () => {
  it('does not surface duplicate-resolution cleanup for a healthy dual-scope sibling state', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await seedLegacyCodexUserHealthySiblingInstall(workspace);

    expect(await readScopedInstallRecords(workspace.repoRoot, 'codex', 'project')).toHaveLength(1);
    expect(await readScopedInstallRecords(workspace.repoRoot, 'codex', 'user')).toHaveLength(1);

    const prompt = createFakePrompt([
      { method: 'select', value: 'git-commit' },
      { method: 'select', action: 'exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: workspace.repoRoot,
      env: process.env,
      prompt,
      consoleDriver,
      interactive: true,
      adapters: createAdapters(),
      io: {
        stdout: () => undefined,
        stderr: () => undefined,
      },
    });

    await expect(runConsoleController(context)).resolves.toBe(0);
    await expect(readScopedInstallRecords(workspace.repoRoot, 'codex', 'project')).resolves.toHaveLength(1);
    await expect(readScopedInstallRecords(workspace.repoRoot, 'codex', 'user')).resolves.toHaveLength(1);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('✓ 已安装');
    expect(detailView?.lines).toContain('✓ Codex（个人）');
    expect(detailView?.lines).toContain('✓ Codex（当前项目）');
    const featurePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toContain('resolveDuplicateInstall');
  }, 15_000);
});
