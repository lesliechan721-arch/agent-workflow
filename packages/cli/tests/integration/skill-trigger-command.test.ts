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
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import {
  calculateBundleFingerprint,
  createAvailableLedger,
  readInstalledLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  readInstallRecordFileAt,
  readSharedSkillTriggerRuntimeOwner,
} from '../../src/install-state/facade.js';
import { getInstallStatePrivateRoot } from '../../src/install-state/paths.js';
import type { InstallRecordFile } from '../../src/install-state/types.js';
import {
  removeCodexPluginEnabledFile,
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
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
  await removeAppsFromGitCommit(repoRoot);
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

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
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

function repoSkillOpenAiYamlPath(repoRoot: string, skillName = 'commit'): string {
  return path.join(
    repoRoot,
    '.agents',
    'skills',
    skillName,
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

async function readRepoSkillAllowImplicitInvocation(
  repoRoot: string,
  skillName = 'commit',
): Promise<boolean> {
  const parsed = YAML.parse(await fs.readFile(repoSkillOpenAiYamlPath(repoRoot, skillName), 'utf8')) as {
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

async function createCorruptedEmbeddedRoot(repoRoot: string): Promise<string> {
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  await fs.remove(
    path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'commit', 'agents', 'openai.yaml'),
  );
  return embeddedRoot;
}

async function addLifecycleRecorder(repoRoot: string, pluginName = 'git-commit'): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.scripts = {
    lifecycle: {
      install: './scripts/lifecycle.mjs',
      upgrade: './scripts/lifecycle.mjs',
      uninstall: './scripts/lifecycle.mjs',
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.outputFile(
    path.join(pluginRoot, 'scripts', 'lifecycle.mjs'),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'fs.appendFileSync(path.join(context.paths.awHome, "lifecycle.log"), `${context.event}\\n`);',
    ].join('\n'),
    'utf8',
  );
}

async function removeEmbeddedMcpFromGitCommit(
  embeddedRoot: string,
): Promise<void> {
  await updateEmbeddedManifest(embeddedRoot, 'git-commit', (manifest) => {
    delete manifest.mcpServers;
    manifest.version = '0.2.0';
  });
  await fs.remove(path.join(embeddedRoot, 'plugins', 'git-commit', '.mcp.json'));
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
  manifest.skillTriggers[skillName] = {
    defaultTrigger: 'auto',
    allowDynamicTrigger: true,
  };
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

  async installPlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    this.installCalls.push(plugin.manifest.name);
    const state = this.getState(plugin.manifest.name);
    if (state.failInstall) {
      throw new Error(state.failInstall);
    }
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

async function seedLegacyCodexUserHealthySiblingInstall(options: {
  workspace: {
    repoRoot: string;
    awHome: string;
    codexHome: string;
    claudeHome: string;
    embeddedRoot: string;
  };
  requestedSkillTrigger: 'manual' | 'auto' | 'default';
}): Promise<void> {
  const sibling = await makeWorkspace();
  process.env.AW_HOME = options.workspace.awHome;
  process.env.AW_CODEX_HOME = options.workspace.codexHome;
  process.env.AW_CLAUDE_HOME = options.workspace.claudeHome;
  process.env.AW_FORCE_CODEX_AVAILABLE = '1';
  process.env.PATH = '';
  setEmbeddedPluginsRootOverrideForTests(options.workspace.embeddedRoot);

  await installCommand(
    ['git-commit'],
    {
      cwd: sibling.repoRoot,
      scope: 'user',
      platform: 'codex',
      requestedSkillTrigger: options.requestedSkillTrigger,
    },
    {
      adapters: createAdapters(),
      env: process.env,
    },
  );

  configureWorkspaceEnv(options.workspace);
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

async function findInstallRecord(options: {
  cwd: string;
  pluginName: string;
  platform: PlatformName;
  scope: 'user' | 'project';
}): Promise<InstallRecordFile | undefined> {
  const records = await readScopedInstallRecords(options.cwd, options.platform, options.scope);
  return records.find((record) =>
    record.record.pluginName === options.pluginName
    && record.record.platform === options.platform
    && record.record.scope === options.scope,
  );
}

async function readInstallRecordPreference(options: {
  cwd: string;
  pluginName: string;
  platform: PlatformName;
  scope: 'user' | 'project';
}): Promise<'default' | 'manual' | 'auto' | undefined> {
  return (await findInstallRecord(options))?.record.options?.skillTriggerPreference;
}


function findStatusCell<T extends { matrix: { cells: Array<{ pluginName: string; platform: PlatformName; scope: string }> } }>(
  result: T,
  options: { pluginName: string; platform: PlatformName; scope: 'user' | 'project' },
) {
  const cell = result.matrix.cells.find((candidate) =>
    candidate.pluginName === options.pluginName
    && candidate.platform === options.platform
    && candidate.scope === options.scope,
  );
  expect(cell).toBeDefined();
  return cell!;
}

function parseVerboseStatusPayload(result: {
  output: string;
  reports: StatusReport[];
  friendlySummaries: Array<{ pluginName: string; status: string; location: string }>;
  consoleItems: Array<{ pluginName: string }>;
}): {
  reports: StatusReport[];
  friendlySummaries: Array<{ pluginName: string; status: string; location: string }>;
  consoleItems: Array<{ pluginName: string }>;
} {
  expect(result.output).toContain('状态详情');
  return {
    reports: result.reports,
    friendlySummaries: result.friendlySummaries,
    consoleItems: result.consoleItems,
  };
}

function findReportedPlugin(
  payload: ReturnType<typeof parseVerboseStatusPayload>,
  options: { pluginName: string; platform: PlatformName; scope: 'user' | 'project' },
) {
  const report = payload.reports.find((candidate) =>
    candidate.platform === options.platform
    && candidate.scope === options.scope,
  );
  expect(report).toBeDefined();
  const plugin = report!.plugins.find((candidate) => candidate.pluginName === options.pluginName);
  expect(plugin).toBeDefined();
  return plugin!;
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  process.env.PATH = originalPath;
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_CLAUDE_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  delete process.env.AW_TEST_LIFECYCLE_LOG;
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('skill trigger command integration', () => {
  it('blocks degraded repeated install when skill trigger preferences can only be recovered from config management', async () => {
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

  it('blocks degraded explicit upgrade when skill trigger preferences can only be recovered from config management', async () => {
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

  it('restores the old Codex project install when a capabilityChanged upgrade fails after internal uninstall, without running uninstall lifecycle', async () => {
    const workspace = await makeWorkspace(async (repoRoot) => {
      await addLifecycleRecorder(repoRoot);
    });
    configureWorkspaceEnv(workspace);
    const lifecycleLogPath = path.join(workspace.awHome, 'lifecycle.log');

    await initCommand({ force: true, env: process.env });
    await installCommand(
      ['git-commit'],
      {
        cwd: workspace.repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      },
      {
        env: process.env,
      },
    );

    const trackingPath = path.join(workspace.repoRoot, '.codex', '.agent-workflows-manifest.json');
    const configPath = path.join(workspace.repoRoot, '.codex', 'config.toml');
    const trackingBefore = await fs.readJson(trackingPath);
    const ledgerBefore = await readInstalledLedger(process.env);
    expect(await readRepoSkillAllowImplicitInvocation(workspace.repoRoot)).toBe(false);

    await removeEmbeddedMcpFromGitCommit(workspace.embeddedRoot);

    const writeInstalledLedgerImpl = localMarketplaceModule.writeInstalledLedger;
    let ledgerWriteCount = 0;
    vi.spyOn(localMarketplaceModule, 'writeInstalledLedger')
      .mockImplementation(async (ledger, env) => {
        ledgerWriteCount += 1;
        if (ledgerWriteCount === 2) {
          throw new Error('ledger boom');
        }
        return writeInstalledLedgerImpl(ledger, env);
      });

    await expect(
      upgradeCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          env: process.env,
        },
      ),
    ).resolves.toMatchObject({
      plugins: ['git-commit'],
      platforms: ['codex'],
    });

    expect(await readRepoSkillAllowImplicitInvocation(workspace.repoRoot)).toBe(false);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('developer_instructions = """');
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('[mcp_servers.git-commit]');
    const trackingAfter = await fs.readJson(trackingPath);
    expect(trackingAfter.plugins['git-commit'].artifacts.map((artifact: { kind: string }) => artifact.kind)).toEqual(
      expect.arrayContaining(['skill', 'instruction', 'permission', 'hook', 'agent']),
    );
    expect(trackingAfter.plugins['git-commit'].artifacts.map((artifact: { kind: string }) => artifact.kind)).not.toContain('mcpServer');
    expect(trackingBefore.plugins['git-commit'].artifacts.map((artifact: { kind: string }) => artifact.kind)).toContain('mcpServer');
    await expect(readInstalledLedger(process.env)).resolves.toEqual(ledgerBefore);

    const lifecycleEvents = (await fs.readFile(lifecycleLogPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    expect(lifecycleEvents).toContain('upgrade');
    expect(lifecycleEvents).not.toContain('uninstall');
  });

  it('rejects deprecated upgrade overrides and degraded upgrade --all', async () => {
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
    ).rejects.toThrow('`upgrade` 不再接受 `--skill-trigger` / `-t`');

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
      'config.json 无法读取或 schema 不受支持',
    );
  });

  it('materializes explicit codex manual, auto, and default before native install and stores preference in the current install record', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('manual');

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
    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('auto');

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
    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('default');
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);
  });

  it('keeps non-overridable skills pristine and ignores tampered local manifest policy', async () => {
    const nonOverridable = await makeWorkspace();
    configureWorkspaceEnv(nonOverridable);
    await updateEmbeddedManifest(nonOverridable.embeddedRoot, 'git-commit', (manifest) => {
      manifest.skillTriggers = {
        commit: {
          defaultTrigger: 'auto',
          allowDynamicTrigger: false,
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
    expect(result.warnings.join('\n')).not.toContain('allowInstallOverride');

    const tampered = await makeWorkspace();
    configureWorkspaceEnv(tampered);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    await installCommand(
      ['git-commit'],
      {
        cwd: tampered.repoRoot,
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'auto',
      },
      {
        adapters: createAdapters(),
        env: process.env,
      },
    );
    await updateEmbeddedManifest(tampered.awHome, 'git-commit', (manifest) => {
      manifest.skillTriggers = {
        commit: {
          defaultTrigger: 'auto',
          allowDynamicTrigger: false,
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

    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
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

  it('keeps install record preferences stable during explicit upgrade and upgrade --all', async () => {
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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(true);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-review')).toBe(true);
    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('default');
    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-review',
      platform: 'codex',
      scope: 'user',
    })).toBe('default');

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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(true);
    expect(await readClaudeFrontmatter(workspace.awHome)).not.toHaveProperty('disable-model-invocation');

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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-commit')).toBe(true);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome, 'git-review')).toBe(false);
  }, 15_000);

  it('fails Codex project sibling installs with duplicateInstall and leaves the user runtime untouched', async () => {
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

    await expect(installCommand(
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
    )).rejects.toThrow(/duplicateInstall/);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('manual');
    expect(await findInstallRecord({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
    })).toBeUndefined();
    await expect(fs.pathExists(path.join(workspace.repoRoot, '.agents', 'skills', 'commit', 'SKILL.md'))).resolves.toBe(false);

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
    await expect(installCommand(
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
    )).rejects.toThrow(/duplicateInstall/);

    await expect(installCommand(
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
    )).rejects.toThrow(/duplicateInstall/);
    expect(await readCodexAllowImplicitInvocation(equivalent.awHome)).toBe(true);
    expect(await findInstallRecord({
      cwd: equivalent.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
    })).toBeUndefined();
  });

  it('fails Claude sibling installs with duplicateInstall before any project write when frontmatter relies on platform defaults', async () => {
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

    await expect(installCommand(
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
    )).rejects.toThrow(/duplicateInstall/);
    await expect(fs.pathExists(path.join(workspace.repoRoot, '.claude', 'settings.json'))).resolves.toBe(false);
    expect(await readClaudeFrontmatter(workspace.awHome)).not.toHaveProperty('disable-model-invocation');
  });

  it('fails Codex sibling installs with duplicateInstall before any project write when openai.yaml relies on platform defaults', async () => {
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

    await expect(installCommand(
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
    )).rejects.toThrow(/duplicateInstall/);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    await expect(fs.pathExists(path.join(workspace.repoRoot, '.agents', 'skills', 'commit', 'SKILL.md'))).resolves.toBe(false);
  });

  it('materializes Codex project skills into repo-local .agents/skills without touching ~/.aw runtime skills', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await writeInstalledLedger(createAvailableLedger(), process.env);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: createAdapters(),
          env: process.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['git-commit'],
    });

    await expect(fs.pathExists(path.join(workspace.repoRoot, '.agents', 'skills', 'commit', 'SKILL.md'))).resolves.toBe(true);
    await expect(readRepoSkillAllowImplicitInvocation(workspace.repoRoot, 'commit')).resolves.toBe(false);
    await expect(fs.pathExists(codexOpenAiYamlPath(workspace.awHome))).resolves.toBe(false);
  });

  it('fails Codex project upgrade preflight with duplicateInstall when the sibling user install is healthy', async () => {
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

    await expect(upgradeCommand(
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
    )).rejects.toThrow(/duplicateInstall/);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    expect(await findInstallRecord({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
    })).toBeUndefined();
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
    expect(await readRepoSkillAllowImplicitInvocation(workspace.repoRoot)).toBe(true);
    await expect(fs.pathExists(codexOpenAiYamlPath(workspace.awHome))).resolves.toBe(false);
    expect(result.warnings.join('\n')).not.toContain('sibling scope');
    expect((await readInstalledLedger(process.env)).ledgerState.status).toBe('available');
  });

  it('refuses tracking-only Codex project repeated installs when skill trigger preferences can only be recovered from config management, and explicit overrides do not touch ~/.aw', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
    await writeInstalledLedger(createAvailableLedger(), process.env);
    await fs.outputJson(
      path.join(workspace.repoRoot, '.codex', '.agent-workflows-manifest.json'),
      {
        version: 1,
        plugins: {
          'git-commit': {
            name: 'git-commit',
            generatedAt: '2026-04-28T00:00:00.000Z',
            artifacts: [{
              path: path.join(workspace.repoRoot, '.agents', 'skills', 'commit'),
              kind: 'skill',
              platform: 'codex',
              artifactKey: 'commit',
            }],
          },
        },
      },
      { spaces: 2 },
    );

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: createAdapters(),
          env: process.env,
        },
      ),
    ).rejects.toThrow('tracking 只能证明 repo artifact 归属');
    await expect(fs.pathExists(codexOpenAiYamlPath(workspace.awHome))).resolves.toBe(false);

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: workspace.repoRoot,
          scope: 'project',
          platform: 'codex',
          requestedSkillTrigger: 'manual',
        },
        {
          adapters: createAdapters(),
          env: process.env,
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['git-commit'],
    });
    expect(await readRepoSkillAllowImplicitInvocation(workspace.repoRoot)).toBe(false);
    await expect(fs.pathExists(codexOpenAiYamlPath(workspace.awHome))).resolves.toBe(false);
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
      status: 'available',
      reason: null,
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

  it('marks the ledger degraded with artifact-write semantics when project repo skill rollback fails', async () => {
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
          scope: 'project',
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
    expect((await readInstalledLedger(process.env)).ledgerState).toMatchObject({
      status: 'degraded',
      reason: 'operation_interrupted_after_artifact_write',
    });
  });

  it('leaves active runtime state untouched during init refresh even when the legacy ledger is degraded', async () => {
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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);

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
    expect(result.warnings).toEqual([]);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
  });

  it('re-elects skill trigger preferences after uninstall from a legacy dual-healthy sibling state and restores pristine after the last scope', async () => {
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
    await seedLegacyCodexUserHealthySiblingInstall({
      workspace,
      requestedSkillTrigger: 'manual',
    });
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
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
    await expect(readSharedSkillTriggerRuntimeOwner({
      pluginName: 'git-commit',
      platform: 'codex',
      env: process.env,
    })).resolves.toMatchObject({
      status: 'ok',
    });

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
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);
    expect(await listSkillBackupDirs(workspace.awHome)).toEqual([]);
    await expect(readSharedSkillTriggerRuntimeOwner({
      pluginName: 'git-commit',
      platform: 'codex',
      env: process.env,
    })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('best-effort uninstalls the last Codex scope from a legacy dual-healthy sibling state when the embedded bundle is corrupted', async () => {
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
    await seedLegacyCodexUserHealthySiblingInstall({
      workspace,
      requestedSkillTrigger: 'manual',
    });
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

    setEmbeddedPluginsRootOverrideForTests(await createCorruptedEmbeddedRoot(workspace.repoRoot));

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

    expect(result.warnings.join('\n')).toContain('embedded bundle 不可用');
    await expect(readSharedSkillTriggerRuntimeOwner({
      pluginName: 'git-commit',
      platform: 'codex',
      env: process.env,
    })).resolves.toMatchObject({
      status: 'missing',
    });
  });

  it('skips uninstall re-election under degraded ledgers', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });

    await installCommand(
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
            scopeInitialized: 'yes',
            managedEvidence: true,
            nativeInstalled: true,
          },
        }),
        env: process.env,
      },
    );

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

    await expect(
      uninstallCommand(
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
      ),
    ).rejects.toThrow('缺失 dependency metadata');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
    expect((await readInstalledLedger(process.env)).ledgerState.status).toBe('degraded');
  });

  it('shows the current scope install record and verbose status summary', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('manual');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
    expect(payload.consoleItems[0]).toMatchObject({
      pluginName: 'git-commit',
    });
    expect(findReportedPlugin(payload, {
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toMatchObject({
      currentCatalog: expect.objectContaining({
        source: 'local',
        available: true,
      }),
    });
  });

  it('keeps verbose status available for equivalent runtime candidates', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('default');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps verbose status available when Codex runtime relies on platform defaults', async () => {
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

      expect(await readInstallRecordPreference({
        cwd: workspace.repoRoot,
        pluginName: 'git-commit',
        platform: 'codex',
        scope: 'user',
      })).toBe('default');
      const payload = parseVerboseStatusPayload(result);
      expect(payload.friendlySummaries[0]).toMatchObject({
        pluginName: 'git-commit',
      });
    }
  });

  it('keeps verbose status available when Claude runtime relies on platform defaults', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'claude',
      scope: 'user',
    })).toBe('default');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps verbose status available when runtime no longer matches the install record preference', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('manual');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps verbose status available when multi-skill defaults are not uniform', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('default');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps verbose status available when different skills diverge at runtime', async () => {
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

    expect(await readInstallRecordPreference({
      cwd: workspace.repoRoot,
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toBe('auto');
    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps status readable when the local marketplace fingerprint is stale', async () => {
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

    const payload = parseVerboseStatusPayload(result);
    const plugin = findReportedPlugin(payload, {
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    expect(plugin).toMatchObject({
      currentCatalog: expect.objectContaining({
        source: 'local',
        available: true,
        rootDir: workspace.embeddedRoot,
        sidecarManifestPackage: expect.objectContaining({
          source: 'localFixture',
        }),
      }),
    });
    expect(plugin.currentCatalog).not.toHaveProperty('reasonCode');
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
  });

  it('keeps status readable when the local marketplace layout is unhealthy', async () => {
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

    const payload = parseVerboseStatusPayload(result);
    const plugin = findReportedPlugin(payload, {
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    expect(plugin).toMatchObject({
      currentCatalog: expect.objectContaining({
        source: 'local',
        available: true,
        rootDir: workspace.embeddedRoot,
        sidecarManifestPackage: expect.objectContaining({
          source: 'localFixture',
        }),
      }),
    });
    expect(plugin.currentCatalog).not.toHaveProperty('reasonCode');
    await expect(fs.pathExists(path.join(workspace.awHome, '.claude-plugin', 'marketplace.json'))).resolves.toBe(false);
  });

  it('keeps status readable even when the legacy ledger is degraded', async () => {
    const workspace = await makeWorkspace();
    configureWorkspaceEnv(workspace);
    await initCommand({ force: true, env: process.env });
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

    const payload = parseVerboseStatusPayload(result);
    expect(findReportedPlugin(payload, {
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    })).toMatchObject({
      ledgerStateStatus: 'available',
    });
    expect((await readInstalledLedger(process.env)).ledgerState.status).toBe('degraded');
  });

  it('keeps verbose status available when trusted runtime skill files are missing or malformed', async () => {
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

    expect(parseVerboseStatusPayload(missingResult).friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });

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

    expect(parseVerboseStatusPayload(malformedResult).friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps verbose status available when embedded pristine skill metadata cannot produce candidate signatures', async () => {
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

    expect(parseVerboseStatusPayload(result).friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });

  it('keeps historical fallback status readable without a current catalog entry', async () => {
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

    const payload = parseVerboseStatusPayload(result);
    expect(findReportedPlugin(payload, {
      pluginName: 'legacy-plugin',
      platform: 'codex',
      scope: 'user',
    })).toMatchObject({
      scopeManagedEvidence: {
        ledger: true,
        tracking: false,
        sharedNativeRef: false,
      },
    });
  });

  it('keeps verbose status available when the local manifest is tampered', async () => {
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
          defaultTrigger: 'auto',
          allowDynamicTrigger: false,
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

    const payload = parseVerboseStatusPayload(result);
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
    });
  });
});
