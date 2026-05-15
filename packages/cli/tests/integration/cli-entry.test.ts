import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClaudeAdapter } from '../../src/adapters/claude.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import * as discoveryModule from '../../src/commands/discovery.js';
import { runCli } from '../../src/index.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import type {
  GeneratedArtifact,
  InstalledLedger,
  PlatformAdapter,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import {
  removeCodexPluginEnabledFile,
  upsertCodexMarketplaceFile,
  upsertCodexPluginEnabledFile,
} from '../../src/utils/codex-config.js';
import * as codexNativeRecoveryModule from '../../src/utils/codex-native-recovery.js';
import {
  createAvailableLedger,
  readInstalledLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  NativeCliError,
  type NativeCliInvocation,
  type NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import {
  createCapturedCliIo as createCapturedIo,
  runCliEntry,
} from '../helpers/cli-entry.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';

const tempDirs: string[] = [];
const DEFAULT_STATUS_FORBIDDEN_TERMS = [
  'repo-managed',
  'tracking',
  'healthSource',
  'artifactRefresh',
  'pluginEnabled',
  'pluginInstalled',
  'configDigest',
  'contentDigest',
  'sessionVisibility',
  'projectTrust',
  'currentCatalog',
  'marketplace',
];

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
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  const codexHome = path.join(root, 'codex-home');
  const claudeHome = path.join(root, 'claude-home');

  const env = {
    ...process.env,
    AW_HOME: awHome,
    AW_CODEX_HOME: codexHome,
    AW_CLAUDE_HOME: claudeHome,
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  return {
    repoRoot,
    awHome,
    codexHome,
    claudeHome,
    embeddedRoot,
    env,
  };
}

async function makeWorkspaceWithMutator(
  mutateRepo: (repoRoot: string) => Promise<void>,
): Promise<{
  repoRoot: string;
  awHome: string;
  codexHome: string;
  claudeHome: string;
  embeddedRoot: string;
  env: NodeJS.ProcessEnv;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-entry-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await mutateRepo(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  const awHome = path.join(root, 'aw-home');
  const codexHome = path.join(root, 'codex-home');
  const claudeHome = path.join(root, 'claude-home');

  const env = {
    ...process.env,
    AW_HOME: awHome,
    AW_CODEX_HOME: codexHome,
    AW_CLAUDE_HOME: claudeHome,
    AW_FORCE_CODEX_AVAILABLE: '1',
    PATH: '',
  } as NodeJS.ProcessEnv;

  return {
    repoRoot,
    awHome,
    codexHome,
    claudeHome,
    embeddedRoot,
    env,
  };
}

async function addNativeHookOnlyPlugin(repoRoot: string, pluginName = 'prompt-guard'): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: pluginName,
      version: '0.1.0',
      description: 'Codex native hook only test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
      extensions: {
        nativeHooks: {
          codex: [
            {
              event: 'UserPromptSubmit',
              command: `echo ${pluginName} prompt`,
            },
          ],
        },
      },
    },
    { spaces: 2 },
  );
}

async function addConfigSchemaToGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config = {
    schema: {
      token: {
        type: 'string',
        required: true,
        sensitive: true,
      },
      retries: {
        type: 'number',
        min: 0,
        max: 5,
        default: 1,
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function addConfigSchemaWithFileToGitCommit(repoRoot: string): Promise<void> {
  await addConfigSchemaToGitCommit(repoRoot);
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config.schema.workspaceFile = {
    type: 'file',
    required: true,
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function addCodexProjectFixturePlugins(
  repoRoot: string,
  pluginDirs: string[],
): Promise<void> {
  for (const pluginDir of pluginDirs) {
    await fs.copy(
      fixturePath('codex-project-repo-managed', 'plugins', pluginDir),
      path.join(repoRoot, 'plugins', pluginDir),
    );
  }
}

async function trustCodexProject(workspace: Awaited<ReturnType<typeof makeWorkspace>>): Promise<void> {
  const projectKey = await resolveCodexProjectKey(workspace.repoRoot);
  await fs.outputFile(
    resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
    ['', `[projects.${JSON.stringify(projectKey)}]`, 'trust_level = "trusted"', ''].join('\n'),
  );
}

function createCodexMarketplaceAddRunner(
  workspace: Awaited<ReturnType<typeof makeWorkspace>>,
  calls: NativeCliInvocation[] = [],
): NativeCliRunner {
  return async (invocation) => {
    calls.push(invocation);
    const awHome = invocation.args[3] ?? '';
    await upsertCodexMarketplaceFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'aw',
      {
        source: awHome,
        sourceType: 'local',
      },
    );
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  };
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

function createCodexUserManagedLedger(): InstalledLedger {
  const ledger = createAvailableLedger();
  ledger.plugins['git-commit'] = {
    lastResolvedVersion: '0.1.0',
    platforms: {
      codex: {
        userScope: {
          managed: true,
          updatedAt: '2026-04-29T00:00:00.000Z',
          resolvedVersion: '0.1.0',
          capabilitySnapshot: {
            requiresNativePlugin: true,
            hasRepoManagedArtifacts: true,
          },
        },
        sharedNativeRefs: {
          user: true,
          projects: [],
        },
        lastRequestedScope: 'user',
        lastRequestedAt: '2026-04-29T00:00:00.000Z',
      },
    },
  };
  return ledger;
}

async function writeCodexActiveCache(
  env: NodeJS.ProcessEnv,
  pluginName: string,
  version = '0.1.0',
): Promise<void> {
  await fs.outputFile(
    path.join(env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName, version, 'plugin.json'),
    '{}\n',
    'utf8',
  );
}

async function waitForHarnessMethod(
  harness: ReturnType<typeof createFakeCodexAppServerHarness>,
  method: string,
): Promise<void> {
  while (!harness.stdinMessages.some((message) => message.json?.method === method)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function createCodexNativeCliRuntime(
  workspace: Awaited<ReturnType<typeof makeWorkspace>>,
  nativeCalls: NativeCliInvocation[] = [],
): {
  runtime: {
    nativeCliRunner: NativeCliRunner;
    adaptersFactory: Parameters<typeof runCli>[1]['adaptersFactory'];
  };
  scheduleInstallSideEffect: (pluginName?: string, version?: string) => Promise<void>;
  scheduleUninstallSideEffect: (pluginName?: string) => Promise<void>;
} {
  const nativeCliRunner = createCodexMarketplaceAddRunner(workspace, nativeCalls);
  const appServerHarness = createFakeCodexAppServerHarness([
    {
      when: 'stdin',
      match: { method: 'initialize' },
      actions: [{ type: 'stdout-jsonl', value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } } }],
      repeat: true,
    },
    {
      when: 'stdin',
      match: { method: 'plugin/install' },
      actions: [{ type: 'stdout-jsonl', value: { id: 'install-1', result: { installed: true } }, delayMs: 50 }],
      repeat: true,
    },
    {
      when: 'stdin',
      match: { method: 'plugin/uninstall' },
      actions: [{ type: 'stdout-jsonl', value: { id: 'uninstall-1', result: { removed: true } }, delayMs: 50 }],
      repeat: true,
    },
  ]);

  return {
    runtime: {
      nativeCliRunner,
      adaptersFactory: (cwd, context) => ({
        codex: new CodexAdapter(cwd, context.nativeCliRunner, context.env, appServerHarness.createRunner()),
        claude: new ClaudeAdapter(cwd, context.nativeCliRunner, context.env),
      }),
    },
    scheduleInstallSideEffect: async (
      pluginName = 'git-commit',
      version = '0.1.0',
    ) => {
      await waitForHarnessMethod(appServerHarness, 'plugin/install');
      const configPath = resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath;
      await upsertCodexPluginEnabledFile(configPath, `${pluginName}@aw`, { enabled: true });
      await writeCodexActiveCache(workspace.env, pluginName, version);
    },
    scheduleUninstallSideEffect: async (pluginName = 'git-commit') => {
      await waitForHarnessMethod(appServerHarness, 'plugin/uninstall');
      const configPath = resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath;
      await removeCodexPluginEnabledFile(configPath, `${pluginName}@aw`);
      await fs.remove(path.join(workspace.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', pluginName));
    },
  };
}

async function readCodexAllowImplicitInvocation(awHome: string): Promise<boolean> {
  const openAiYamlPath = path.join(
    awHome,
    'plugins',
    'git-commit',
    'codex',
    'skills',
    'commit',
    'agents',
    'openai.yaml',
  );
  const parsed = YAML.parse(await fs.readFile(openAiYamlPath, 'utf8')) as {
    policy?: { allow_implicit_invocation?: boolean };
  };
  return parsed.policy?.allow_implicit_invocation === true;
}

class PassiveAdapter implements PlatformAdapter {
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
  async status(_plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope,
      initialized: false,
      plugins: [],
    };
  }
}

class FakeCliCleanupAdapter extends PassiveAdapter {
  constructor(private readonly configPath: string) {
    super();
  }

  override async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    await removeCodexPluginEnabledFile(this.configPath, `${plugin.manifest.name}@aw`);
  }

  async uninstallUserNativePluginById(pluginNameOrId: string): Promise<void> {
    await removeCodexPluginEnabledFile(this.configPath, pluginNameOrId);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry integration', () => {
  it('lets cleanup --force remove the target while keeping verified dependents and printing the follow-up guidance', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-cleanup-force-'));
    tempDirs.push(root);
    const builder = await createMinimalPluginInstallStateFixtureBuilder(root);
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const dependentTarget = builder.createTarget({
      pluginName: 'helper-local-dependent',
      platform: 'codex',
      scope: 'user',
    });
    const dependentRecord = await builder.writeInstallRecord(dependentTarget);
    const dependentRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${dependentTarget.recordId}.json`,
    );
    await fs.writeJson(
      dependentRecordPath,
      {
        ...dependentRecord,
        record: {
          ...dependentRecord.record,
          dependencyEdges: [{
            dependency: target.location,
            declaration: {
              name: target.location.plugin,
            },
          }],
        },
      },
      { spaces: 2 },
    );

    const capture = createCapturedIo();
    const exitCode = await runCli(
      ['cleanup', 'git-commit', '-p', 'codex', '-s', 'user', '--force'],
      {
        cwd: builder.paths.repoRoot,
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
          AW_FORCE_CODEX_AVAILABLE: '1',
        },
        io: capture.io,
        adaptersFactory: () => ({
          codex: new FakeCliCleanupAdapter(configPath),
          claude: new PassiveAdapter(),
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(capture.readStdout()).toContain('cleanup 已完成：git-commit。');
    expect(capture.readStdout()).toContain('受影响依赖：');
    expect(capture.readStdout()).toContain('helper-local-dependent');
    expect(capture.readStdout()).toContain('repair、reinstall 或 cleanup');
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
    await expect(fs.pathExists(dependentRecordPath)).resolves.toBe(true);
  });

  it('rejects schema-aware config commands for plugins without AW config schema', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['config', 'set', 'git-commit', 'token', 'secret', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('does not declare an AW config schema');
    await expect(fs.pathExists(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toBe(false);
  });

  it('supports aw config set/get/reset without leaking schema-less raw values', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let capture = createCapturedIo();

    let exitCode = await runCli(
      ['config', 'set', 'git-commit', 'token', 'super-secret', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'config:set',
      plugin: 'git-commit',
      scope: 'user',
      updatedKeys: ['token'],
      effective: {
        values: {
          token: '[redacted]',
          retries: 1,
        },
      },
    });
    await expect(fs.readJson(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toMatchObject({
      token: 'super-secret',
    });

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'get', 'git-commit', 'token', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      value: '[redacted]',
      source: 'user',
    });
    expect(capture.readStdout()).not.toContain('super-secret');

    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'missing-plugin', 'config.json'),
      {
        token: 'old-secret',
      },
      { spaces: 2 },
    );
    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'get', 'missing-plugin', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('Unknown plugin "missing-plugin"');
    expect(capture.readStderr()).toContain('aw config reset missing-plugin -s user --yes');
    expect(capture.readStderr()).not.toContain('old-secret');

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'list', 'missing-plugin', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('aw config reset missing-plugin -s user --yes');
    expect(capture.readStderr()).not.toContain('old-secret');

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'reset', 'missing-plugin', '--yes', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'config:reset',
      plugin: 'missing-plugin',
      existed: true,
      deleted: true,
    });
    await expect(fs.pathExists(
      path.join(workspace.awHome, 'plugin-config', 'missing-plugin', 'config.json'),
    )).resolves.toBe(false);
  });

  it('rejects removed config configure subcommand', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['config', 'configure', 'git-commit'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('unknown command');
    expect(capture.readStderr()).toContain('configure');
  });

  it('requires --yes for existing config reset and never prompts', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const userConfigPath = path.join(
      workspace.awHome,
      'plugin-config',
      'git-commit',
      'config.json',
    );
    const projectConfigPath = path.join(
      workspace.repoRoot,
      '.agent-workflows',
      'plugin-config',
      'git-commit',
      'config.json',
    );
    await fs.outputJson(userConfigPath, { token: 'user-secret' }, { spaces: 2 });

    let promptCalled = false;
    let capture = createCapturedIo();
    let exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'user'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          confirm: async () => {
            promptCalled = true;
            return true;
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('Reset requires confirmation.');
    expect(capture.readStderr()).toContain('aw config reset git-commit -s user --yes');
    await expect(fs.pathExists(userConfigPath)).resolves.toBe(true);

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'user', '--yes'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          confirm: async () => true,
        },
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('已重置 git-commit 的个人配置。');
    await expect(fs.pathExists(userConfigPath)).resolves.toBe(false);

    await fs.outputJson(projectConfigPath, { token: 'project-secret' }, { spaces: 2 });
    promptCalled = false;
    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'project', '--yes', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          confirm: async () => {
            promptCalled = true;
            return false;
          },
        },
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(promptCalled).toBe(false);
    expect(JSON.parse(capture.readStdout())).toMatchObject({
      ok: true,
      command: 'config:reset',
      plugin: 'git-commit',
      scope: 'project',
      existed: true,
      deleted: true,
    });
    await expect(fs.pathExists(projectConfigPath)).resolves.toBe(false);
  });

  it('scopes config get/list JSON diagnostics to the requested store', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
      {
        token: 'user-secret',
        legacyUser: 'keep-user',
      },
      { spaces: 2 },
    );
    await fs.outputJson(
      path.join(workspace.repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json'),
      {
        retries: 3,
        legacyProject: 'keep-project',
      },
      { spaces: 2 },
    );

    let capture = createCapturedIo();
    let exitCode = await runCli(
      ['config', 'list', 'git-commit', '--scope', 'user', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    let payload = JSON.parse(capture.readStdout());
    expect(payload.summary.ignoredUnknownKeys).toEqual([{
      scope: 'user',
      projectLayer: 'shared',
      source: 'user',
      key: 'legacyUser',
    }]);
    expect(JSON.stringify(payload)).not.toContain('legacyProject');
    expect(payload.summary.sources).toMatchObject({
      token: 'user',
      retries: 'default',
    });

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'get', 'git-commit', '--scope', 'project', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    payload = JSON.parse(capture.readStdout());
    expect(payload.summary.ignoredUnknownKeys).toEqual(expect.arrayContaining([
      {
        scope: 'user',
        projectLayer: 'shared',
        source: 'user',
        key: 'legacyUser',
      },
      {
        scope: 'project',
        projectLayer: 'shared',
        source: 'project',
        key: 'legacyProject',
      },
    ]));
    expect(payload.source).toMatchObject({
      token: 'user',
      retries: 'project',
    });
  });

  it('prints repair guidance for invalid config in get and list output', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaWithFileToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await fs.outputJson(
      path.join(workspace.repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json'),
      {
        token: 'project-secret',
        workspaceFile: path.join(workspace.repoRoot, 'missing.txt'),
      },
      { spaces: 2 },
    );

    let capture = createCapturedIo();
    let exitCode = await runCli(
      ['config', 'list', 'git-commit', '--scope', 'project'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    expect(capture.readStdout()).toContain('workspaceFile: invalid-config');
    expect(capture.readStdout()).toContain('aw config set git-commit workspaceFile <value> -s project');
    expect(capture.readStdout()).toContain('aw config unset git-commit workspaceFile -s project');
    expect(capture.readStdout()).toContain('aw config reset git-commit -s project');

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'get', 'git-commit', 'workspaceFile', '--scope', 'project'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );
    expect(exitCode).toBe(0);
    expect(capture.readStdout()).toContain('workspaceFile: invalid-config');
    expect(capture.readStdout()).toContain('aw config set git-commit workspaceFile <value> -s project');
  });

  it('rejects deprecated --skill-trigger at the source entry', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--skill-trigger', 'sometimes'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`install` 不再接受 `--skill-trigger` / `-t`');
  });

  it('rejects install --skill-trigger before writing runtime state', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCalls: NativeCliInvocation[] = [];
    const { io, readStderr } = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace, nativeCalls);
    const exitCode = await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--skill-trigger',
        'manual',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
        ...codexRuntime.runtime,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`install` 不再接受 `--skill-trigger` / `-t`');
    expect(nativeCalls).toEqual([]);
    expect(await fs.pathExists(path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'agents',
      'openai.yaml',
    ))).toBe(false);
  });

  it('uses the injected native runner for Codex marketplace add failures in runCli', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: 'invalid marketplace root',
      });
    };

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
        nativeCliRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('无法通过 Codex 原生命令注册 AW 本地 marketplace');
    expect(readStderr()).toContain('invalid marketplace root');
  });

  it('records native marketplace add failure details in the debug log', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();
    const logFile = path.join(workspace.awHome, 'native-debug.log');
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw new NativeCliError({
        invocation,
        exitCode: 77,
        stdout: 'native stdout',
        stderr: 'native stderr',
        cause,
      });
    };

    const exitCode = await runCli(
      [
        'install',
        'git-commit',
        '--platform',
        'codex',
        '--debug',
        '--log-file',
        logFile,
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
        nativeCliRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('无法通过 Codex 原生命令注册 AW 本地 marketplace');
    const logLines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
    const logEntries = logLines
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } });
    const nativeErrorEntry = logEntries
      .find((entry) => entry.event.type === 'native:error');
    expect(nativeErrorEntry?.event.data).toMatchObject({
      invocation: {
        command: 'codex',
        args: ['plugin', 'marketplace', 'add', await fs.realpath(workspace.awHome)],
        cwd: workspace.repoRoot,
      },
      error: {
        exitCode: 77,
        stdout: 'native stdout',
        stderr: 'native stderr',
        causeCode: 'EACCES',
      },
    });
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'native:marketplace',
          data: expect.objectContaining({
            operation: 'add',
            phase: 'error',
            errorCategory: 'native_cli_failed',
            marketplaceName: 'aw',
          }),
        }),
      }),
    );
  });

  it('prints a readable Codex native add error when the runner has no output', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: '',
        stderr: '',
      });
    };

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
        nativeCliRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('无法通过 Codex 原生命令注册 AW 本地 marketplace');
    expect(readStderr()).toContain('exit code 1');
  });

  it('prints verbose command decisions during install', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace);
    const installSideEffect = codexRuntime.scheduleInstallSideEffect();

    const exitCode = await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--verbose',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
        ...codexRuntime.runtime,
      },
    );

    expect(exitCode, readStderr()).toBe(0);
    await installSideEffect;
    expect(readStderr()).toContain('options:normalized');
    expect(readStderr()).toContain('catalog:resolved');
    expect(readStderr()).toContain('platform:resolved');
    expect(readStderr()).toContain('skill-trigger:resolved');
    expect(readStderr()).toContain('native:marketplace');
    expect(readStderr()).toContain('native:rpc');
    expect(readStderr()).toContain('native:post-check');
  });

  it('explains missing recovery evidence in stderr and debug events when the native write already happened', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const logFile = path.join(workspace.awHome, 'native-recovery-risk.log');
    const capture = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace);
    const installSideEffect = codexRuntime.scheduleInstallSideEffect();

    vi.spyOn(codexNativeRecoveryModule, 'writeCodexNativeRecoveryBreadcrumb')
      .mockRejectedValueOnce(new Error('simulated breadcrumb write failure'));

    const exitCode = await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex', '--debug', '--log-file', logFile],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        ...codexRuntime.runtime,
      },
    );

    expect(exitCode).toBe(1);
    await installSideEffect;
    expect(capture.readStderr()).toContain('AW 没有持久化恢复证据');
    expect(capture.readStderr()).toContain('不能承诺后续 repair / uninstall 一定具备自动授权');

    const logEntries = (await fs.readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } });
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'native:recovery',
          data: expect.objectContaining({
            operation: 'write',
            phase: 'error',
            state: 'pending_after_native_write',
            nativeWriteSucceeded: true,
            recoveryBreadcrumbPersisted: false,
            errorCategory: 'breadcrumb_write_failed',
          }),
        }),
      }),
    );
    expect(
      logEntries.find((entry) =>
        entry.event.type === 'native:recovery' &&
        entry.event.data?.operation === 'write' &&
        entry.event.data?.phase === 'error',
      )?.event.data?.suggestion,
    ).toContain('自动授权');
  });

  it('persists marketplace, rpc, recovery, and post-check events in the debug log for successful Codex user installs and uninstalls', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    const installLogFile = path.join(workspace.awHome, 'native-install-events.log');
    let capture = createCapturedIo();
    let codexRuntime = createCodexNativeCliRuntime(workspace);
    let installSideEffect = codexRuntime.scheduleInstallSideEffect();

    expect(await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex', '--debug', '--log-file', installLogFile],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        ...codexRuntime.runtime,
      },
    )).toBe(0);
    await installSideEffect;

    const installEntries = (await fs.readFile(installLogFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } });
    expect(installEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:marketplace',
            data: expect.objectContaining({
              operation: 'verify',
              phase: 'success',
              marketplaceName: 'aw',
            }),
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:rpc',
            data: expect.objectContaining({
              method: 'plugin/install',
              phase: 'success',
              pluginId: 'git-commit@aw',
              nativeWriteSucceeded: true,
            }),
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:recovery',
            data: expect.objectContaining({
              operation: 'write',
              phase: 'success',
              state: 'pending_after_native_write',
            }),
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:post-check',
            data: expect.objectContaining({
              operation: 'install',
              phase: 'success',
              pluginEnabled: true,
              configEntryPresent: true,
              pluginInstalled: true,
            }),
          }),
        }),
      ]),
    );

    const uninstallLogFile = path.join(workspace.awHome, 'native-uninstall-events.log');
    capture = createCapturedIo();
    codexRuntime = createCodexNativeCliRuntime(workspace);
    const uninstallSideEffect = codexRuntime.scheduleUninstallSideEffect();
    expect(await runCli(
      ['uninstall', 'git-commit', '--scope', 'user', '--platform', 'codex', '--debug', '--log-file', uninstallLogFile],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        ...codexRuntime.runtime,
      },
    )).toBe(0);
    await uninstallSideEffect;

    const uninstallEntries = (await fs.readFile(uninstallLogFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } });
    expect(uninstallEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:rpc',
            data: expect.objectContaining({
              method: 'plugin/uninstall',
              phase: 'success',
              pluginId: 'git-commit@aw',
              nativeWriteSucceeded: true,
            }),
          }),
        }),
        expect.objectContaining({
          event: expect.objectContaining({
            type: 'native:post-check',
            data: expect.objectContaining({
              operation: 'uninstall',
              phase: 'success',
              pluginEnabled: false,
              configEntryPresent: false,
              pluginInstalled: false,
            }),
          }),
        }),
      ]),
    );
  });

  it('rejects explicit upgrade --skill-trigger before rewriting installed runtime', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    const capture = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace);
    const exitCode = await runCli(
      [
        'upgrade',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--skill-trigger',
        'auto',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        ...codexRuntime.runtime,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('`upgrade` 不再接受 `--skill-trigger` / `-t`');
    expect(await fs.pathExists(path.join(
      workspace.awHome,
      'plugins',
      'git-commit',
      'codex',
      'skills',
      'commit',
      'agents',
      'openai.yaml',
    ))).toBe(false);
  });

  it('rejects upgrade --all --skill-trigger at the entry layer', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const { io, readStderr } = createCapturedIo();

    const exitCode = await runCli(
      ['upgrade', '--all', '--platform', 'codex', '--skill-trigger', 'manual'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('`upgrade` 不再接受 `--skill-trigger` / `-t`');
  });

  it('fails upgrade --all at the local catalog gate before degraded replay warnings', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

    await writeInstalledLedger(createDegradedLedger(), workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');

    capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', '--all', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    const stderr = capture.readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('本地插件目录');
    expect(stderr).toContain('config.json 无法读取或 schema 不受支持');
    expect(stderr).toContain('非交互环境不会自动覆盖');
    expect(stderr).not.toContain('跳过 skill 触发偏好回放');
    expect(stderr).not.toContain('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行');
  });

  it('prints degraded replay warnings before explicit upgrade inheritance errors', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

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
    await writeInstalledLedger(degraded, workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');

    capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    const stderr = capture.readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('无法从 degraded installed.json 安全恢复');
    expect(stderr).toMatch(/skill trigger 偏好/);
  });

  it('prints preparation warnings once for init and install entry flows', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);

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
    await writeInstalledLedger(degraded, workspace.env);

    capture = createCapturedIo();
    expect(await runCli(
      ['init', '--force'],
      { cwd: workspace.repoRoot, env: workspace.env, io: capture.io },
    )).toBe(0);
    expect(capture.readStderr().match(/跳过 skill 触发偏好回放/g)).toHaveLength(1);

    await writeInstalledLedger(createAvailableLedger(), workspace.env);
    await fs.writeFile(path.join(workspace.awHome, 'config.json'), '{"version":', 'utf8');
    capture = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace);
    const exitCode = await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        ...codexRuntime.runtime,
      },
    );
    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('config.json 无法读取或 schema 不受支持');
    expect(capture.readStderr()).toContain('非交互环境不会自动覆盖');
    expect(capture.readStderr().match(/跳过 skill trigger 偏好 replay/g)).toBeNull();
  });

  it.each([
    ['install', ['install', '--interactive']],
    ['install', ['install', '--no-interactive']],
    ['uninstall', ['uninstall', 'git-commit', '--interactive']],
    ['upgrade', ['upgrade', 'git-commit', '--no-interactive']],
    ['config reset', ['config', 'reset', 'git-commit', '--interactive']],
    ['config reset', ['config', 'reset', 'git-commit', '--no-interactive']],
  ])('rejects removed interactive flags for %s', async (_label, argv) => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      argv,
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('unknown option');
  });

  it('rejects removed uninstall --force at the CLI entry', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['uninstall', 'git-commit', '--force'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('unknown option');
  });

  it.each([
    ['install', ['install'], 'install 命令至少需要一个插件名', '`aw install <plugin>`'],
    ['uninstall', ['uninstall'], 'uninstall 命令至少需要一个插件名', '`aw uninstall <plugin>`'],
    ['upgrade', ['upgrade'], 'upgrade 命令至少需要一个插件名', '`aw upgrade <plugin>` / `aw upgrade --all`'],
  ])('does not prompt for missing %s targets', async (_label, argv, message, hint) => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let promptCalled = false;
    const capture = createCapturedIo();

    const exitCode = await runCli(
      argv,
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          selectScope: async () => {
            promptCalled = true;
            return 'user';
          },
          selectPlatform: async () => {
            promptCalled = true;
            return 'codex';
          },
          selectPlugins: async () => {
            promptCalled = true;
            return [];
          },
          selectUpgradeMode: async () => {
            promptCalled = true;
            return 'all';
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain(message);
    expect(capture.readStderr()).toContain('`aw`');
    expect(capture.readStderr()).toContain(hint);
  });

  it('fails install required config without prompting and points to aw config set or aw', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let promptCalled = false;
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          configurePlugin: async () => {
            promptCalled = true;
            return {
              selectedScope: 'user' as const,
              updates: { token: 'unexpected' },
              updatedKeys: ['token'],
              cancelled: false,
            };
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('git-commit requires valid AW config before install/upgrade');
    expect(capture.readStderr()).toContain('`aw config set git-commit token <value> -s user`');
    expect(capture.readStderr()).toContain('open `aw`');
    expect(capture.readStderr()).not.toContain('aw config configure');
  });

  it('fails upgrade required config without prompting and points to aw config set or aw', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await fs.outputJson(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
      { token: 'user-secret' },
      { spaces: 2 },
    );

    const installCapture = createCapturedIo();
    const codexRuntime = createCodexNativeCliRuntime(workspace);
    const installSideEffect = codexRuntime.scheduleInstallSideEffect();
    expect(await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: installCapture.io,
        ...codexRuntime.runtime,
      },
    ), installCapture.readStderr()).toBe(0);
    await installSideEffect;

    await fs.remove(path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'));

    let promptCalled = false;
    const capture = createCapturedIo();
    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          configurePlugin: async () => {
            promptCalled = true;
            return {
              selectedScope: 'user' as const,
              updates: { token: 'unexpected' },
              updatedKeys: ['token'],
              cancelled: false,
            };
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('git-commit requires valid AW config before install/upgrade');
    expect(capture.readStderr()).toContain('`aw config set git-commit token <value> -s user`');
    expect(capture.readStderr()).toContain('open `aw`');
    expect(capture.readStderr()).not.toContain('aw config configure');
  });

  it('does not print Codex native receipts for repo-managed-only plugins and records debug decisions', async () => {
    const workspace = await makeWorkspaceWithMutator((repoRoot) =>
      addNativeHookOnlyPlugin(repoRoot),
    );
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCalls: NativeCliInvocation[] = [];
    const logFile = path.join(workspace.awHome, 'repo-managed-debug.log');
    const capture = createCapturedIo();

    const exitCode = await runCli(
      [
        'install',
        'prompt-guard',
        '--scope',
        'project',
        '--platform',
        'codex',
        '--debug',
        '--log-file',
        logFile,
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(nativeCalls).toEqual([]);
    expect(capture.readStdout()).toContain('已安装 prompt-guard。');
    expect(capture.readStdout()).toContain('目标：Codex；当前项目。');
    expect(capture.readStdout()).toContain('已更新项目文件：.codex/hooks.json、.codex/.agent-workflows-manifest.json。');
    expect(capture.readStdout()).not.toContain('已确认 Codex marketplace 注册');
    expect(capture.readStdout()).not.toContain('已确认插件启用');

    const logEntries = (await fs.readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } });
    expect(logEntries.find((entry) => entry.event.type === 'run:metadata')?.event.data).toMatchObject({
      cwd: workspace.repoRoot,
      awHome: workspace.awHome,
      rawArgv: [
        'install',
        'prompt-guard',
        '--scope',
        'project',
        '--platform',
        'codex',
        '--debug',
        '--log-file',
        logFile,
      ],
    });
    expect(logEntries).toContainEqual(
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'native:skipped',
          data: expect.objectContaining({
            platform: 'codex',
            scope: 'project',
            plugin: 'prompt-guard',
            reason: 'project_repo_managed_skipped_native',
            requiresNativeRuntime: false,
            repoManagedArtifactKinds: ['hook'],
          }),
        }),
      }),
    );
    expect(logEntries.some((entry) => entry.event.type === 'artifacts:written')).toBe(true);
    expect(logEntries.some((entry) => entry.event.type === 'tracking:written')).toBe(true);
    expect(logEntries.some((entry) => entry.event.type === 'ledger:written')).toBe(true);
  });

  it('prints Codex project repo-managed install, status, and uninstall without native marketplace as the main diagnosis, and upgrade falls back to config guidance when trigger preferences cannot be recovered', async () => {
    const workspace = await makeWorkspaceWithMutator((repoRoot) =>
      addCodexProjectFixturePlugins(repoRoot, ['skills-mcp']),
    );
    await trustCodexProject(workspace);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCalls: NativeCliInvocation[] = [];

    let capture = createCapturedIo();
    expect(await runCli(
      ['install', 'skills-mcp', '--scope', 'project', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    ), capture.readStderr()).toBe(0);
    expect(nativeCalls).toEqual([]);
    expect(capture.readStdout()).toContain(
      '已更新项目文件：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。',
    );
    expect(capture.readStdout()).not.toContain('已确认 Codex marketplace 注册');
    expect(capture.readStdout()).not.toContain('已确认插件启用');

    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'skills-mcp', '--scope', 'project', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    ), capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('- skills-mcp');
    expect(capture.readStdout()).toContain('状态：已安装');
    expect(capture.readStdout()).toContain('位置：Codex（当前项目）');
    expect(capture.readStdout()).toContain('摘要：当前安装状态正常。');
    for (const term of DEFAULT_STATUS_FORBIDDEN_TERMS) {
      expect(capture.readStdout()).not.toContain(term);
    }

    capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'skills-mcp', '--scope', 'project', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    ), capture.readStderr()).toBe(1);
    expect(capture.readStderr()).toContain('请改用配置管理维护 skill trigger 偏好后再重试');
    expect(capture.readStdout()).toBe('');

    capture = createCapturedIo();
    expect(await runCli(
      ['uninstall', 'skills-mcp', '--scope', 'project', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    ), capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain(
      '已清理项目文件：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。',
    );
    expect(capture.readStdout()).not.toContain('已确认 Codex marketplace 注册');
    expect(capture.readStdout()).not.toContain('已确认插件启用');
  });

  it('rejects --no-interactive as an unknown option', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install', '--no-interactive'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('unknown option');
  });

  it('does not prompt in CI even when a fake prompt is injected', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let promptCalled = false;
    const prompt = {
      selectScope: async () => {
        promptCalled = true;
        return 'user';
      },
      selectPlatform: async () => {
        promptCalled = true;
        return 'codex';
      },
      selectPlugins: async () => {
        promptCalled = true;
        return [];
      },
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install'],
      {
        cwd: workspace.repoRoot,
        env: {
          ...workspace.env,
          CI: 'true',
        } as NodeJS.ProcessEnv,
        io: capture.io,
        prompt,
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('install 命令至少需要一个插件名');
  });

  it('fails bare aw in CI with console guidance instead of help output', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const capture = createCapturedIo();

    const exitCode = await runCli(
      [],
      {
        cwd: workspace.repoRoot,
        env: {
          ...workspace.env,
          CI: 'true',
        } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStdout()).toBe('');
    expect(capture.readStderr()).toContain('当前运行环境不可交互');
    expect(capture.readStderr()).toContain('`aw status`');
    expect(capture.readStderr()).toContain('`aw status --json`');
    expect(capture.readStderr()).not.toContain('Usage:');
  });

  it('keeps real status JSON stdout parseable when verbose or debug is enabled', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    for (const flags of [
      ['--json'],
      ['--json', '--verbose'],
      [
        '--json',
        '--debug',
        '--log-file',
        path.join(workspace.awHome, 'status-debug.log'),
      ],
      [
        '--json',
        '--verbose',
        '--debug',
        '--log-file',
        path.join(workspace.awHome, 'status-verbose-debug.log'),
      ],
    ]) {
      const result = await runCliEntry(
        ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', ...flags],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
        },
      );

      expect(result.exitCode, result.stderr).toBe(0);
      const parsed = result.parseJsonStdout<{
        ok?: boolean;
        command?: string;
        reports?: unknown[];
        friendlySummaries?: unknown[];
        consoleItems?: unknown[];
      }>();
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('status');
      expect(parsed.reports).toBeInstanceOf(Array);
      expect(parsed.friendlySummaries).toBeInstanceOf(Array);
      expect(parsed.consoleItems).toBeInstanceOf(Array);
    }
  });

  it('reports Codex marketplace source drift in status JSON and default next steps', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let capture = createCapturedIo();
    const configPath = resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath;
    await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
    await writeCodexActiveCache(workspace.env, 'git-commit');
    const wrongSource = path.join(workspace.awHome, 'old-copy');
    await upsertCodexMarketplaceFile(configPath, 'aw', {
      source: wrongSource,
      sourceType: 'local',
    });
    await writeInstalledLedger(createCodexUserManagedLedger(), workspace.env);

    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '-j'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    ), capture.readStderr()).toBe(0);
    const payload = JSON.parse(capture.readStdout()) as {
      ok: boolean;
      command: string;
      health: string;
      summaries: Array<{ health: string; nextSteps: string[] }>;
      cells: Array<{ health: string }>;
      friendlySummaries: Array<{
        pluginName: string;
        status: string;
        statusLabel: string;
        location: string;
        nextStep?: string;
      }>;
      consoleItems: Array<{
        pluginName: string;
        status: string;
        statusLabel: string;
        reasonCodes: string[];
        nextSteps: string[];
        locations: Array<{
          reasonCodes: string[];
        }>;
      }>;
      reports: Array<{
        plugins: Array<{
          native: {
            marketplaceRegistered: boolean;
            marketplaceSource?: string;
            marketplaceSourceType?: string;
            marketplaceRootResolution?: string;
            pluginInstalled: boolean;
          };
        }>;
      }>;
    };

    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('status');
    expect(payload.health).toBe('needsAttention');
    expect(payload.summaries[0].health).toBe('needsAttention');
    expect(payload.summaries[0].nextSteps).toBeInstanceOf(Array);
    expect(payload.cells[0].health).toBe('needsAttention');
    expect(payload.friendlySummaries[0]).toMatchObject({
      pluginName: 'git-commit',
      location: 'Codex（个人）',
    });
    expect(payload.friendlySummaries[0].nextStep).toBeTruthy();
    expect(payload.consoleItems[0]).toMatchObject({
      pluginName: 'git-commit',
    });
    expect(payload.consoleItems[0].reasonCodes).toBeInstanceOf(Array);
    expect(payload.consoleItems[0].installedLocations[0].reasonCodes).toBeInstanceOf(Array);
    expect(payload.reports[0].plugins[0].native).toMatchObject({
      marketplaceRegistered: false,
      pluginInstalled: true,
    });

    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    ), capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('- git-commit');
    expect(capture.readStdout()).toContain('状态：');
    expect(capture.readStdout()).toContain('位置：Codex（当前用户）');
    expect(capture.readStdout()).toContain('摘要：检测到 Codex 原生残留。不要直接覆盖当前残留，先确认来源。');
    for (const term of DEFAULT_STATUS_FORBIDDEN_TERMS) {
      expect(capture.readStdout()).not.toContain(term);
    }

    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '--verbose'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
      },
    ), capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('诊断信息');
    expect(capture.readStdout()).toContain('"pluginEnabled": true');
    expect(capture.readStdout()).toContain('"pluginInstalled": true');
    expect(capture.readStdout()).toContain('"currentCatalog": {');
  });

  it('renders Codex enabled-only, cache-only and recovery residue as external-friendly summaries with native reason codes', async () => {
    const cases = [
      {
        label: 'enabled-only',
        expectedReason: 'externalOwnership',
        setup: async (workspace: Awaited<ReturnType<typeof makeWorkspace>>) => {
          const configPath = resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath;
          await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
        },
      },
      {
        label: 'cache-only',
        expectedReason: 'externalOwnership',
        setup: async (workspace: Awaited<ReturnType<typeof makeWorkspace>>) => {
          await writeCodexActiveCache(workspace.env, 'git-commit');
        },
      },
      {
        label: 'recovery',
        expectedReason: 'externalOwnership',
        setup: async (workspace: Awaited<ReturnType<typeof makeWorkspace>>) => {
          const configPath = resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath;
          await upsertCodexPluginEnabledFile(configPath, 'git-commit@aw', { enabled: true });
          await writeCodexActiveCache(workspace.env, 'git-commit');
          await codexNativeRecoveryModule.writeCodexNativeRecoveryBreadcrumb({
            pluginName: 'git-commit',
            reason: 'pending',
            env: workspace.env,
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      const workspace = await makeWorkspace();
      setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
      await testCase.setup(workspace);

      const jsonResult = await runCliEntry(
        ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '--json'],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
        },
      );
      expect(jsonResult.exitCode, `${testCase.label}\n${jsonResult.stderr}`).toBe(0);
      const payload = jsonResult.parseJsonStdout<{
        consoleItems: Array<{
          status: string;
          statusLabel: string;
          installedLocations: Array<{ reasonCodes: string[] }>;
        }>;
      }>();
      expect(payload.consoleItems[0].status).toBe('abnormal');
      expect(payload.consoleItems[0].statusLabel).toBe('异常');
      expect(payload.consoleItems[0].installedLocations[0].reasonCodes.length).toBeGreaterThan(0);

      const humanResult = await runCliEntry(
        ['status', 'git-commit', '--scope', 'user', '--platform', 'codex'],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
        },
      );
      expect(humanResult.exitCode, `${testCase.label}\n${humanResult.stderr}`).toBe(0);
      expect(humanResult.stdout).toContain('- git-commit');
      expect(humanResult.stdout).toContain('状态：外部管理');
      expect(humanResult.stdout).toContain('位置：Codex（当前用户）');
      expect(humanResult.stdout).toContain('摘要：检测到 Codex 原生残留。不要直接覆盖当前残留，先确认来源。');
      expect(humanResult.stdout).not.toContain('状态：已安装');
      for (const term of DEFAULT_STATUS_FORBIDDEN_TERMS) {
        expect(humanResult.stdout).not.toContain(term);
      }
    }
  });

  it('keeps stdout empty when status --json fails before rendering', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    vi.spyOn(discoveryModule, 'buildCommandCandidates')
      .mockRejectedValueOnce(new Error('simulated status discovery failure'));

    const result = await runCliEntry(
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('simulated status discovery failure');
  });
});
