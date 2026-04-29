import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { initCommand } from '../../src/commands/init.js';
import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  InstalledLedger,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import {
  calculateBundleFingerprint,
  createAvailableLedger,
  readInstalledLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
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

async function makeWorkspace(
  customizeRepo?: (repoRoot: string) => Promise<void>,
): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-skill-trigger-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await customizeRepo?.(repoRoot);
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

function codexOpenAiYamlPath(awHome: string, pluginName = 'git-commit'): string {
  return path.join(
    awHome,
    'plugins',
    pluginName,
    'codex',
    'skills',
    'commit',
    'agents',
    'openai.yaml',
  );
}

function claudeSkillPath(awHome: string, pluginName = 'git-commit'): string {
  return path.join(
    awHome,
    'plugins',
    pluginName,
    'claude',
    'skills',
    'commit',
    'SKILL.md',
  );
}

async function readCodexAllowImplicitInvocation(
  awHome: string,
  pluginName = 'git-commit',
): Promise<boolean> {
  const parsed = YAML.parse(await fs.readFile(codexOpenAiYamlPath(awHome, pluginName), 'utf8')) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

async function writeCodexAllowImplicitInvocation(
  awHome: string,
  value: boolean,
  pluginName = 'git-commit',
): Promise<void> {
  await fs.writeFile(
    codexOpenAiYamlPath(awHome, pluginName),
    YAML.stringify({ policy: { allow_implicit_invocation: value } }),
    'utf8',
  );
}

async function listSkillBackupDirs(
  awHome: string,
  pluginName = 'git-commit',
  platform: PlatformName = 'codex',
): Promise<string[]> {
  const platformRoot = path.join(awHome, 'plugins', pluginName, platform);
  if (!(await fs.pathExists(platformRoot))) {
    return [];
  }

  return (await fs.readdir(platformRoot))
    .filter((entry) => entry.startsWith('.skills-backup-'))
    .sort();
}

async function writeCodexSkillAllowImplicitInvocation(
  awHome: string,
  pluginName: string,
  skillName: string,
  value: boolean,
): Promise<void> {
  await fs.writeFile(
    path.join(
      awHome,
      'plugins',
      pluginName,
      'codex',
      'skills',
      skillName,
      'agents',
      'openai.yaml',
    ),
    YAML.stringify({ policy: { allow_implicit_invocation: value } }),
    'utf8',
  );
}

async function readClaudeFrontmatter(
  awHome: string,
  pluginName = 'git-commit',
): Promise<Record<string, unknown>> {
  const content = await fs.readFile(claudeSkillPath(awHome, pluginName), 'utf8');
  const end = content.indexOf('\n---\n', 4);
  return YAML.parse(content.slice(4, end)) as Record<string, unknown>;
}

async function updateEmbeddedManifest(
  embeddedRoot: string,
  pluginName: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(embeddedRoot, 'plugins', pluginName, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  update(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function cloneFixturePlugin(repoRoot: string, sourceName: string, targetName: string): Promise<void> {
  const sourceRoot = path.join(repoRoot, 'plugins', sourceName);
  const targetRoot = path.join(repoRoot, 'plugins', targetName);
  await fs.copy(sourceRoot, targetRoot);
  const manifestPath = path.join(targetRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.name = targetName;
  manifest.description = `${manifest.description} (${targetName})`;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function writeClaudeSkillWithPlatformDefaults(repoRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'SKILL.md'),
    `---
name: commit
description: Commit skill
---

# Commit
`,
    'utf8',
  );
}

async function writeCodexSkillWithEmptyPolicy(repoRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'agents', 'openai.yaml'),
    'policy: {}\n',
    'utf8',
  );
}

async function writeCodexSkillWithoutPolicy(repoRoot: string): Promise<void> {
  await fs.writeFile(
    path.join(repoRoot, 'plugins', 'git-commit', 'skills', 'commit', 'agents', 'openai.yaml'),
    'name: commit\n',
    'utf8',
  );
}

async function addCodexSkill(
  repoRoot: string,
  pluginName: string,
  skillName: string,
  allowImplicitInvocation: boolean,
): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.copy(
    path.join(pluginRoot, 'skills', 'commit'),
    path.join(pluginRoot, 'skills', skillName),
  );
  await fs.writeFile(
    path.join(pluginRoot, 'skills', skillName, 'agents', 'openai.yaml'),
    YAML.stringify({ policy: { allow_implicit_invocation: allowImplicitInvocation } }),
    'utf8',
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.skillTriggers ??= {};
  manifest.skillTriggers[skillName] = { allowInstallOverride: true };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

function createDegradedLedger(): InstalledLedger {
  return {
    version: 1,
    ledgerState: {
      status: 'degraded',
      degradedAt: '2026-04-28T00:00:00.000Z',
      reason: 'operation_interrupted_after_native_write',
    },
    plugins: {},
  };
}

interface FakePluginState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  nativeInstalled?: boolean;
  managedEvidence?: boolean;
  failInstall?: string;
  failExtensions?: string;
}

class FakeAdapter implements PlatformAdapter {
  readonly installCalls: string[] = [];
  readonly name: PlatformName;

  constructor(
    name: PlatformName,
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
    const state = this.getState(plugin.manifest.name);
    if (state.failInstall) {
      throw new Error(state.failInstall);
    }
    state.nativeInstalled = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.getState(plugin.manifest.name).nativeInstalled = false;
  }

  async installExtensions(plugin: PluginMeta, _scope: 'project' | 'user'): Promise<GeneratedArtifact[]> {
    const state = this.getState(plugin.manifest.name);
    if (state.failExtensions) {
      throw new Error(state.failExtensions);
    }
    return [];
  }

  async uninstallExtensions(
    _plugin: PluginMeta,
    _scope: 'project' | 'user',
    _generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void> {
    // noop
  }

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

function configureWorkspaceEnv(workspace: {
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
}, platforms: Array<'codex' | 'claude'> = ['codex']): void {
  process.env.AW_HOME = workspace.awHome;
  process.env.AW_CODEX_HOME = workspace.codexHome;
  process.env.AW_CLAUDE_HOME = workspace.claudeHome;
  process.env.PATH = '';
  if (platforms.includes('codex')) {
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
  }
  if (platforms.includes('claude')) {
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
  }
  setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
}

function createAdapters(
  codexStates: Record<string, FakePluginState> = {},
  claudeStates: Record<string, FakePluginState> = {},
): Record<PlatformName, PlatformAdapter> {
  return {
    codex: new FakeAdapter('codex', codexStates),
    claude: new FakeAdapter('claude', claudeStates),
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  process.env.PATH = originalPath;
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill trigger command integration', () => {
  it('blocks degraded repeated install without --skill-trigger before native writes', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true, env: process.env });

    const ledger = createDegradedLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    const codex = new FakeAdapter('codex', {});

    let installError: unknown;
    try {
      await installCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      );
    } catch (error) {
      installError = error;
    }
    expect(installError).toBeInstanceOf(Error);
    expect((installError as Error).message).toContain('不能隐式继承旧的 skill trigger 偏好');
    expect((installError as { warnings?: string[] }).warnings?.join('\n')).toContain(
      '跳过 skill trigger 偏好 replay',
    );
    expect(codex.installCalls).toEqual([]);
  });

  it('allows degraded new installs with implicit default and allows explicit upgrade overrides', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createDegradedLedger(), process.env);

    const installAdapter = new FakeAdapter('codex', {});
    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex: installAdapter,
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      ),
    ).resolves.toMatchObject({
      plugins: ['git-commit'],
      platforms: ['codex'],
    });
    expect(installAdapter.installCalls).toEqual(['git-commit']);

    const degradedManagedLedger = createDegradedLedger();
    degradedManagedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degradedManagedLedger, process.env);

    const upgradeAdapter = new FakeAdapter('codex', {
      'git-commit': {
        scopeInitialized: 'yes',
        managedEvidence: true,
      },
    });
    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: {
            codex: upgradeAdapter,
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      ),
    ).resolves.toMatchObject({
      plugins: ['git-commit'],
      platforms: ['codex'],
    });
    expect(upgradeAdapter.installCalls).toEqual(['git-commit']);
  });

  it('blocks degraded explicit upgrade without --skill-trigger before reinstalling', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true, env: process.env });

    const ledger = createDegradedLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    const codex = new FakeAdapter('codex', {
      'git-commit': {
        scopeInitialized: 'yes',
        managedEvidence: true,
      },
    });

    let upgradeError: unknown;
    try {
      await upgradeCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      );
    } catch (error) {
      upgradeError = error;
    }
    expect(upgradeError).toBeInstanceOf(Error);
    expect((upgradeError as Error).message).toContain('无法从 degraded installed.json 安全恢复');
    expect((upgradeError as { warnings?: string[] }).warnings?.join('\n')).toContain(
      '跳过 skill trigger 偏好 replay',
    );
    expect(codex.installCalls).toEqual([]);
  });

  it('rejects upgrade --all --skill-trigger and degraded upgrade --all', async () => {
    const { repoRoot, awHome, codexHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.PATH = '';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true, env: process.env });

    await expect(
      upgradeCommand(
        [],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          all: true,
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', {}),
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      ),
    ).rejects.toThrow('`upgrade --all` 首版不支持 `--skill-trigger`');

    await writeInstalledLedger(createDegradedLedger(), process.env);
    await fs.writeFile(path.join(awHome, 'config.json'), '{"version":', 'utf8');

    let upgradeAllError: unknown;
    try {
      await upgradeCommand(
        [],
        {
          cwd: repoRoot,
          scope: 'user',
          platform: 'codex',
          all: true,
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', {}),
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      );
    } catch (error) {
      upgradeAllError = error;
    }
    expect(upgradeAllError).toBeInstanceOf(Error);
    expect((upgradeAllError as Error).message).toContain(
      '`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行',
    );
    expect((upgradeAllError as { warnings?: string[] }).warnings?.join('\n')).toContain(
      '跳过 skill trigger 偏好 replay',
    );
  });

  it('materializes explicit codex manual, auto, and default before native install and records write order', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);

    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const seenDuringInstall: boolean[] = [];
    const codex = new FakeAdapter('codex', {});
    vi.spyOn(codex, 'installPlugin').mockImplementation(async (plugin: PluginMeta) => {
      seenDuringInstall.push(await readCodexAllowImplicitInvocation(workspace.awHome));
      codex.installCalls.push(plugin.manifest.name);
    });

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: {
          codex,
          claude: new FakeAdapter('claude', {}),
        },
        env: process.env,
      },
    );
    expect(seenDuringInstall).toEqual([false]);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);

    let ledger = await readInstalledLedger(process.env);
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.installOptions).toEqual({
      skillTriggerPreference: 'manual',
    });
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.skillTriggerWriteOrder).toBe(1);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    ledger = await readInstalledLedger(process.env);
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.installOptions).toEqual({
      skillTriggerPreference: 'auto',
    });
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.skillTriggerWriteOrder).toBe(2);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    ledger = await readInstalledLedger(process.env);
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.installOptions).toEqual({
      skillTriggerPreference: 'default',
    });
    expect(ledger.plugins['git-commit'].platforms.codex?.userScope?.skillTriggerWriteOrder).toBe(3);
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);
  });

  it('keeps non-overridable skills pristine and ignores tampered local manifest policy', async () => {
    const nonOverridable = await makeWorkspace();
    configureWorkspaceEnv(nonOverridable);
    await updateEmbeddedManifest(nonOverridable.embeddedRoot, 'git-commit', (manifest) => {
      manifest.skillTriggers = {
        commit: {
          allowInstallOverride: false,
        },
      };
    });
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const result = await installCommand(
      ['git-commit'],
      {
        cwd: nonOverridable.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(nonOverridable.awHome)).toBe(true);
    expect(result.warnings.join('\n')).toContain('未声明 allowInstallOverride');

    const tampered = await makeWorkspace();
    configureWorkspaceEnv(tampered);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    await updateEmbeddedManifest(tampered.awHome, 'git-commit', (manifest) => {
      manifest.skillTriggers = {
        commit: {
          allowInstallOverride: false,
        },
      };
    });

    await installCommand(
      ['git-commit'],
      {
        cwd: tampered.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(tampered.awHome)).toBe(false);
  });

  it('inherits available ledger preferences per target and treats explicit default as reset', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace, ['codex', 'claude']);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await writeCodexAllowImplicitInvocation(workspace.awHome, true);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'both',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    expect(await readClaudeFrontmatter(workspace.awHome)).not.toHaveProperty('disable-model-invocation');

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
  });

  it('restores ledger preferences during explicit upgrade and upgrade --all', async () => {
    const workspace = await makeWorkspace(async (repoRoot) => {
      await cloneFixturePlugin(repoRoot, 'git-commit', 'git-review');
    });
    configureWorkspaceEnv(workspace, ['codex', 'claude']);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await installCommand(
      ['git-review'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'claude',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    await writeCodexAllowImplicitInvocation(workspace.awHome, true, 'git-commit');
    await writeCodexAllowImplicitInvocation(workspace.awHome, false, 'git-review');
    await upgradeCommand(
      ['git-commit', 'git-review'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: createAdapters(
          {
            'git-commit': { scopeInitialized: 'yes', managedEvidence: true },
            'git-review': { scopeInitialized: 'yes', managedEvidence: true },
          },
        ),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(false);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-review')).toBe(true);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await writeCodexAllowImplicitInvocation(workspace.awHome, true, 'git-commit');
    await fs.writeFile(
      claudeSkillPath(workspace.awHome),
      `---\nname: commit\nuser-invocable: true\n---\n# Commit\n`,
      'utf8',
    );
    await upgradeCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'both',
      },
      {
        adapters: createAdapters(
          { 'git-commit': { scopeInitialized: 'yes', managedEvidence: true } },
          { 'git-commit': { scopeInitialized: 'yes', managedEvidence: true } },
        ),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(false);
    expect(await readClaudeFrontmatter(workspace.awHome)).toMatchObject({
      'disable-model-invocation': false,
    });

    await writeCodexAllowImplicitInvocation(workspace.awHome, true, 'git-commit');
    await writeCodexAllowImplicitInvocation(workspace.awHome, false, 'git-review');
    await upgradeCommand(
      [],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        all: true,
      },
      {
        adapters: createAdapters(
          {
            'git-commit': { scopeInitialized: 'yes', managedEvidence: true },
            'git-review': { scopeInitialized: 'yes', managedEvidence: true },
          },
        ),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(false);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-review')).toBe(true);
  });

  it('warns for sibling scope drift using write order and skips equivalent default-auto rewrites', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    let projectResult = await installCommand(
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
    expect(projectResult.warnings.join('\n')).toContain('sibling scope');
    expect(projectResult.warnings.join('\n')).toContain('user (manual)');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);

    let ledger = await readInstalledLedger(process.env);
    const userOrder = ledger.plugins['git-commit'].platforms.codex?.userScope?.skillTriggerWriteOrder;
    const projectOrder = Object.values(
      ledger.plugins['git-commit'].platforms.codex?.projectScopes ?? {},
    )[0]?.skillTriggerWriteOrder;
    expect(projectOrder).toBeGreaterThan(userOrder ?? 0);

    const equivalent = await makeWorkspace();
    configureWorkspaceEnv(equivalent);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    await installCommand(
      ['git-commit'],
      {
        cwd: equivalent.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    projectResult = await installCommand(
      ['git-commit'],
      {
        cwd: equivalent.repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(projectResult.warnings.join('\n')).not.toContain('sibling scope');

    ledger = await readInstalledLedger(process.env);
    const projectScope = Object.keys(ledger.plugins['git-commit'].platforms.codex?.projectScopes ?? {})[0];
    if (projectScope) {
      const record = ledger.plugins['git-commit'].platforms.codex?.projectScopes?.[projectScope];
      if (record) {
        record.updatedAt = ledger.plugins['git-commit'].platforms.codex?.userScope?.updatedAt ?? record.updatedAt;
      }
    }
    await writeInstalledLedger(ledger, process.env);

    const repeatResult = await installCommand(
      ['git-commit'],
      {
        cwd: equivalent.repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    expect(repeatResult.warnings.join('\n')).toContain('user (default)');
    expect(await readCodexAllowImplicitInvocation(equivalent.awHome)).toBe(false);
  });

  it('does not warn for Claude default-auto sibling scopes when frontmatter relies on platform defaults', async () => {
    const workspace = await makeWorkspace(writeClaudeSkillWithPlatformDefaults);
    configureWorkspaceEnv(workspace, ['claude']);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'claude',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const projectResult = await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'claude',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    expect(projectResult.warnings.join('\n')).not.toContain('sibling scope');
    expect(await readClaudeFrontmatter(workspace.awHome)).toMatchObject({
      'disable-model-invocation': false,
    });
  });

  it('does not warn for Codex default-auto sibling scopes when openai.yaml relies on platform defaults', async () => {
    const workspace = await makeWorkspace(writeCodexSkillWithEmptyPolicy);
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const projectResult = await installCommand(
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

    expect(projectResult.warnings.join('\n')).not.toContain('sibling scope');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
  });

  it('reports sibling drift when an explicit upgrade changes semantics after a bundle change', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await fs.writeFile(
      path.join(
        workspace.embeddedRoot,
        'plugins',
        'git-commit',
        'codex',
        'skills',
        'commit',
        'agents',
        'openai.yaml',
      ),
      YAML.stringify({ policy: { allow_implicit_invocation: false } }),
      'utf8',
    );
    const configPath = path.join(workspace.awHome, 'config.json');
    const config = await fs.readJson(configPath);
    config.bundleFingerprint = await calculateBundleFingerprint(workspace.embeddedRoot);
    await fs.writeJson(configPath, config, { spaces: 2 });

    const result = await upgradeCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: createAdapters({
          'git-commit': {
            scopeInitialized: 'yes',
            managedEvidence: true,
          },
        }),
        env: process.env,
      },
    );
    expect(result.warnings.join('\n')).toContain('user (auto)');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
  });

  it('does not trust degraded sibling records when explicit install continues', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });

    const ledger = createDegradedLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
            skillTriggerWriteOrder: 10,
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const result = await installCommand(
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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    expect(result.warnings.join('\n')).not.toContain('sibling scope');
    expect((await readInstalledLedger(process.env)).ledgerState.status).toBe('degraded');
  });

  it('fails strict explicit malformed skills before native install', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await fs.writeFile(
      path.join(
        workspace.embeddedRoot,
        'plugins',
        'git-commit',
        'codex',
        'skills',
        'commit',
        'agents',
        'openai.yaml',
      ),
      'policy: [',
      'utf8',
    );
    await initCommand({ force: true, env: process.env });

    const codex = new FakeAdapter('codex', {});
    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', {}),
          },
          env: process.env,
        },
      ),
    ).rejects.toThrow('codex skill trigger 无法物化');
    expect(codex.installCalls).toEqual([]);
  });

  it('rolls back materialized skills when native install or extension install fails', async () => {
    const installFailure = await makeWorkspace();
    configureWorkspaceEnv(installFailure);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: installFailure.repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: createAdapters({
            'git-commit': {
              failInstall: 'native install failed',
            },
          }),
          env: process.env,
        },
      ),
    ).rejects.toThrow('native install failed');
    expect(await readCodexAllowImplicitInvocation(installFailure.awHome)).toBe(true);

    const extensionFailure = await makeWorkspace();
    configureWorkspaceEnv(extensionFailure);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: extensionFailure.repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: createAdapters({
            'git-commit': {
              failExtensions: 'extension install failed',
            },
          }),
          env: process.env,
        },
      ),
    ).rejects.toThrow('extension install failed');
    expect(await readCodexAllowImplicitInvocation(extensionFailure.awHome)).toBe(true);
    expect((await readInstalledLedger(process.env)).ledgerState).toMatchObject({
      status: 'degraded',
      reason: 'operation_interrupted_after_native_write',
    });
  });

  it('marks the ledger degraded when materialization rollback fails', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    const originalMove = fs.move.bind(fs);
    vi.spyOn(fs, 'move').mockImplementation(async (...args: Parameters<typeof fs.move>) => {
      if (String(args[0]).includes('-backup-')) {
        throw new Error('rollback move failed');
      }
      await originalMove(...args);
    });

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: createAdapters({
            'git-commit': {
              failInstall: 'native install failed',
            },
          }),
          env: process.env,
        },
      ),
    ).rejects.toThrow('native install failed');
    expect((await readInstalledLedger(process.env)).ledgerState).toMatchObject({
      status: 'degraded',
      reason: 'operation_interrupted_after_native_write',
    });
  });

  it('replays ledger preferences during init refresh and degraded preparation warnings stay visible', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await writeCodexAllowImplicitInvocation(workspace.awHome, true);

    await initCommand({ force: true, env: process.env });
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);

    const degraded = createDegradedLedger();
    degraded.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degraded, process.env);

    const result = await initCommand({ force: true, env: process.env });
    expect(result.warnings.join('\n')).toContain('跳过 skill trigger 偏好 replay');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
  });

  it('re-elects skill trigger preferences after uninstall and restores pristine after the last scope', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: createAdapters({
          'git-commit': {
            scopeInitialized: 'yes',
            managedEvidence: true,
          },
        }),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: createAdapters({
          'git-commit': {
            scopeInitialized: 'yes',
            managedEvidence: true,
            nativeInstalled: true,
          },
        }),
        env: process.env,
      },
    );
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);
  });

  it('skips uninstall re-election under degraded ledgers', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });

    const degraded = createDegradedLedger();
    degraded.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degraded, process.env);
    await writeCodexAllowImplicitInvocation(workspace.awHome, false);

    const result = await uninstallCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: createAdapters({
          'git-commit': {
            scopeInitialized: 'yes',
            managedEvidence: true,
            nativeInstalled: true,
          },
        }),
        env: process.env,
      },
    );

    expect(result.warnings.join('\n')).toContain('跳过卸载后的 skill trigger 重选');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    expect((await readInstalledLedger(process.env)).ledgerState.status).toBe('degraded');
  });

  it('shows the current scope ledger preference and matched runtime in status', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerLedger=manual');
    expect(result.output).toContain('skillTriggerRuntime=manual');
    expect(result.output).toContain('skillTriggerDrift=no');
    expect(result.reports[0].plugins[0]).toMatchObject({
      skillTriggerPreference: 'manual',
      skillTriggerRuntimeMatches: ['manual'],
      skillTriggerRuntimeState: 'matched',
      skillTriggerDrift: 'no',
    });
  });

  it('reports equivalent runtime candidates without false drift', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerLedger=default');
    expect(result.output).toContain('skillTriggerRuntime=matches(default,auto)');
    expect(result.output).toContain('skillTriggerDrift=no');
  });

  it('reports Codex platform defaults as equivalent runtime candidates without false drift', async () => {
    const cases = [
      {
        name: 'empty policy',
        customizeRepo: writeCodexSkillWithEmptyPolicy,
      },
      {
        name: 'missing policy',
        customizeRepo: writeCodexSkillWithoutPolicy,
      },
    ];

    for (const testCase of cases) {
      const workspace = await makeWorkspace(testCase.customizeRepo);
      configureWorkspaceEnv(workspace);
      await initCommand({ force: true, env: process.env });
      await writeInstalledLedger(createAvailableLedger(), process.env);

      await installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'user',
          platform: 'codex',
          requestedSkillTrigger: 'default',
        },
        {
          adapters: createAdapters(),
          env: process.env,
        },
      );

      const runtimeMetadata = YAML.parse(
        await fs.readFile(codexOpenAiYamlPath(workspace.awHome), 'utf8'),
      ) as Record<string, unknown>;
      if (testCase.name === 'empty policy') {
        expect(runtimeMetadata.policy).toEqual({});
      } else {
        expect(runtimeMetadata).not.toHaveProperty('policy');
      }

      const result = await statusCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'user',
          platform: 'codex',
          verbose: true,
        },
        { env: process.env },
      );

      expect(result.output).toContain('skillTriggerLedger=default');
      expect(result.output).toContain('skillTriggerRuntime=matches(default,auto)');
      expect(result.output).toContain('skillTriggerDrift=no');
      expect(result.reports[0].plugins[0]).toMatchObject({
        skillTriggerPreference: 'default',
        skillTriggerRuntimeMatches: ['default', 'auto'],
        skillTriggerRuntimeState: 'matched',
        skillTriggerDrift: 'no',
      });
    }
  });

  it('reports Claude platform defaults as equivalent runtime candidates without false drift', async () => {
    const workspace = await makeWorkspace(writeClaudeSkillWithPlatformDefaults);
    configureWorkspaceEnv(workspace, ['claude']);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'claude',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const frontmatter = await readClaudeFrontmatter(workspace.awHome);
    expect(frontmatter).not.toHaveProperty('disable-model-invocation');
    expect(frontmatter).not.toHaveProperty('user-invocable');

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'claude',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerLedger=default');
    expect(result.output).toContain('skillTriggerRuntime=matches(default,auto)');
    expect(result.output).toContain('skillTriggerDrift=no');
  });

  it('reports skill trigger drift when runtime no longer matches the ledger preference', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await writeCodexAllowImplicitInvocation(workspace.awHome, true);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerLedger=manual');
    expect(result.output).toContain('skillTriggerRuntime=matches(default,auto)');
    expect(result.output).toContain('skillTriggerDrift=yes');
    expect(result.output).toContain('skill trigger runtime 与当前 scope ledger 偏好不一致');
  });

  it('keeps multi-skill default signatures distinct when defaults are not uniform', async () => {
    const workspace = await makeWorkspace((repoRoot) =>
      addCodexSkill(repoRoot, 'git-commit', 'review', false)
    );
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerRuntime=default');
    expect(result.output).toContain('skillTriggerDrift=no');
  });

  it('reports mixed runtime when different skills do not match one candidate preference', async () => {
    const workspace = await makeWorkspace((repoRoot) =>
      addCodexSkill(repoRoot, 'git-commit', 'review', true)
    );
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await writeCodexSkillAllowImplicitInvocation(workspace.awHome, 'git-commit', 'review', false);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerLedger=auto');
    expect(result.output).toContain('skillTriggerRuntime=mixed');
    expect(result.output).toContain('skillTriggerDrift=yes');
  });

  it('reports unknown skill trigger runtime and drift when the local marketplace is stale', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await fs.writeJson(
      path.join(workspace.awHome, 'config.json'),
      {
        version: 1,
        initializedAt: '2026-04-28T00:00:00.000Z',
        sourcePackage: '@yiliang/aw',
        sourceVersion: '0.1.0',
        bundleFingerprint: 'sha256:stale',
      },
      { spaces: 2 },
    );

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('currentCatalog=source:embedded');
    expect(result.output).toContain('skillTriggerLedger=manual');
    expect(result.output).toContain('skillTriggerRuntime=unknown');
    expect(result.output).toContain('skillTriggerDrift=unknown');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
  });

  it('reports unknown skill trigger runtime when local marketplace layout is unhealthy', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await fs.remove(path.join(workspace.awHome, '.claude-plugin', 'marketplace.json'));

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('currentCatalog=source:embedded');
    expect(result.output).toContain('skillTriggerRuntime=unknown');
    expect(result.output).toContain('skillTriggerDrift=unknown');
    await expect(fs.pathExists(path.join(workspace.awHome, '.claude-plugin', 'marketplace.json'))).resolves.toBe(false);
  });

  it('reports unknown skill trigger drift for degraded ledgers', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeCodexAllowImplicitInvocation(workspace.awHome, false);

    const degraded = createDegradedLedger();
    degraded.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(degraded, process.env);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('ledgerState=degraded');
    expect(result.output).toContain('skillTriggerLedger=manual');
    expect(result.output).toContain('skillTriggerRuntime=unknown');
    expect(result.output).toContain('skillTriggerDrift=unknown');
  });

  it('reports unknown when trusted runtime skill files are missing or malformed', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await fs.remove(codexOpenAiYamlPath(workspace.awHome));

    const missingResult = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(missingResult.output).toContain('skillTriggerRuntime=unknown');
    expect(missingResult.output).toContain('skillTriggerDrift=unknown');

    await fs.ensureDir(path.dirname(codexOpenAiYamlPath(workspace.awHome)));
    await fs.writeFile(codexOpenAiYamlPath(workspace.awHome), 'policy: [', 'utf8');

    const malformedResult = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(malformedResult.output).toContain('skillTriggerRuntime=unknown');
    expect(malformedResult.output).toContain('skillTriggerDrift=unknown');
  });

  it('reports unknown when embedded pristine skill metadata cannot produce candidate signatures', async () => {
    const workspace = await makeWorkspace(async (repoRoot) => {
      await fs.writeFile(
        path.join(
          repoRoot,
          'plugins',
          'git-commit',
          'skills',
          'commit',
          'agents',
          'openai.yaml',
        ),
        'policy: [',
        'utf8',
      );
    });
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });

    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerRuntime=unknown');
    expect(result.output).toContain('skillTriggerDrift=unknown');
    expect(result.output).toContain('skill trigger 候选签名无法确定');
  });

  it('keeps historical fallback skill trigger status unknown', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });

    const ledger = createAvailableLedger();
    ledger.plugins['legacy-plugin'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
            },
            installOptions: {
              skillTriggerPreference: 'manual',
            },
          },
        },
      },
    };
    await writeInstalledLedger(ledger, process.env);

    const result = await statusCommand(
      ['legacy-plugin'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('currentCatalog=source:local,available:no');
    expect(result.output).toContain('skillTriggerLedger=manual');
    expect(result.output).toContain('skillTriggerRuntime=unknown');
    expect(result.output).toContain('skillTriggerDrift=unknown');
  });

  it('uses embedded skillTriggers for status when the local manifest is tampered', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await updateEmbeddedManifest(workspace.awHome, 'git-commit', (manifest) => {
      manifest.skillTriggers = {
        commit: {
          allowInstallOverride: false,
        },
      };
    });

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'user',
        platform: 'codex',
        verbose: true,
      },
      { env: process.env },
    );

    expect(result.output).toContain('skillTriggerRuntime=manual');
    expect(result.output).toContain('skillTriggerDrift=no');
    expect(result.output).toContain('local marketplace manifest 的 skillTriggers 与 embedded manifest 不一致');
  });
});
