import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import type { InstalledLedger } from '../../src/types.js';
import { upsertCodexMarketplaceFile } from '../../src/utils/codex-config.js';
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

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry integration', () => {
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

  it('configures plugin config through a fake prompt with scoped patching and clean JSON stdout', async () => {
    const workspace = await makeWorkspaceWithMutator(addConfigSchemaToGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const projectConfigPath = path.join(
      workspace.repoRoot,
      '.agent-workflows',
      'plugin-config',
      'git-commit',
      'config.json',
    );
    await fs.outputJson(
      projectConfigPath,
      {
        token: 'keep-project-secret',
        retries: 2,
        legacyProject: 'keep-me',
      },
      { spaces: 2 },
    );
    const promptCalls: Array<{
      allowedScopes: string[];
      initialScope: string;
      currentValues?: Record<string, unknown>;
      requiredKeys?: string[];
    }> = [];
    const prompt = {
      configurePlugin: async (options: {
        allowedScopes: string[];
        initialScope: string;
        currentValues?: Record<string, unknown>;
        requiredKeys?: string[];
      }) => {
        promptCalls.push({
          allowedScopes: options.allowedScopes,
          initialScope: options.initialScope,
          currentValues: options.currentValues,
          requiredKeys: options.requiredKeys,
        });
        return {
          selectedScope: 'project' as const,
          updates: { retries: 4 },
          updatedKeys: ['retries'],
          cancelled: false,
        };
      },
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['config', 'configure', 'git-commit', '--json'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(capture.readStderr()).toBe('');
    expect(promptCalls).toEqual([
      {
        allowedScopes: ['user', 'project'],
        initialScope: 'user',
        currentValues: {
          token: 'keep-project-secret',
          retries: 2,
        },
        requiredKeys: [],
      },
    ]);
    const payload = JSON.parse(capture.readStdout());
    expect(capture.readStdout().trim()).toBe(JSON.stringify(payload, null, 2));
    expect(payload).toMatchObject({
      ok: true,
      command: 'config:configure',
      plugin: 'git-commit',
      scope: 'project',
      updatedKeys: ['retries'],
      effective: {
        values: {
          token: '[redacted]',
          retries: 4,
        },
      },
    });
    expect(capture.readStdout()).not.toContain('keep-project-secret');
    await expect(fs.readJson(projectConfigPath)).resolves.toEqual({
      token: 'keep-project-secret',
      retries: 4,
      legacyProject: 'keep-me',
    });
    await expect(fs.pathExists(
      path.join(workspace.awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toBe(false);
  });

  it('guards config reset with interactive confirmation and allows non-interactive --yes', async () => {
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

    let confirmCalls = 0;
    let capture = createCapturedIo();
    let exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'user'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt: {
          confirm: async ({ defaultValue }: { defaultValue?: boolean }) => {
            confirmCalls += 1;
            expect(defaultValue).toBe(false);
            return false;
          },
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(confirmCalls).toBe(1);
    expect(capture.readStderr()).toContain('Config reset for git-commit was cancelled.');
    await expect(fs.pathExists(userConfigPath)).resolves.toBe(true);

    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'user'],
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
    expect(capture.readStdout()).toContain('已重置 git-commit 的 user 配置。');
    await expect(fs.pathExists(userConfigPath)).resolves.toBe(false);

    await fs.outputJson(projectConfigPath, { token: 'project-secret' }, { spaces: 2 });
    let promptCalled = false;
    capture = createCapturedIo();
    exitCode = await runCli(
      ['config', 'reset', 'git-commit', '--scope', 'project', '--yes', '--no-interactive', '--json'],
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
    expect(payload.summary.ignoredUnknownKeys).toEqual([{ scope: 'user', key: 'legacyUser' }]);
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
    expect(payload.summary.ignoredUnknownKeys).toEqual([{ scope: 'project', key: 'legacyProject' }]);
    expect(JSON.stringify(payload)).not.toContain('legacyUser');
    expect(payload.source).toMatchObject({
      token: 'missing',
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

  it('rejects invalid --skill-trigger values at the source entry', async () => {
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
    expect(readStderr()).toContain('Unsupported skill trigger preference "sometimes"');
  });

  it('applies install --skill-trigger manual, auto, and default through runCli', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCalls: NativeCliInvocation[] = [];
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace, nativeCalls);

    for (const [preference, expected] of [
      ['manual', false],
      ['auto', true],
      ['default', true],
    ] as const) {
      const { io, readStderr } = createCapturedIo();
      const exitCode = await runCli(
        [
          'install',
          'git-commit',
          '--scope',
          'user',
          '--platform',
          'codex',
          '--skill-trigger',
          preference,
        ],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io,
          nativeCliRunner,
        },
      );

      expect(exitCode, readStderr()).toBe(0);
      expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(expected);
    }
    expect(nativeCalls.map((invocation) => invocation.args)).toContainEqual([
      'plugin',
      'marketplace',
      'add',
      await fs.realpath(workspace.awHome),
    ]);
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
    const nativeErrorEntry = logLines
      .map((line) => JSON.parse(line) as { event: { type: string; data?: Record<string, unknown> } })
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
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace),
      },
    );

    expect(exitCode, readStderr()).toBe(0);
    expect(readStderr()).toContain('options:normalized');
    expect(readStderr()).toContain('catalog:resolved');
    expect(readStderr()).toContain('platform:resolved');
    expect(readStderr()).toContain('skill-trigger:resolved');
  });

  it('applies explicit upgrade --skill-trigger manual, auto, and default through runCli', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
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
        nativeCliRunner,
      },
    )).toBe(0);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(true);

    for (const [preference, expected] of [
      ['manual', false],
      ['auto', true],
      ['default', true],
    ] as const) {
      capture = createCapturedIo();
      const exitCode = await runCli(
        [
          'upgrade',
          'git-commit',
          '--scope',
          'user',
          '--platform',
          'codex',
          '--skill-trigger',
          preference,
        ],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io: capture.io,
          nativeCliRunner,
        },
      );

      expect(exitCode, capture.readStderr()).toBe(0);
      expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(expected);
    }
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
    expect(readStderr()).toContain('`upgrade --all` 首版不支持 `--skill-trigger`');
  });

  it('prints degraded replay warnings before upgrade --all errors', async () => {
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
    expect(stderr).toContain('跳过 skill 触发偏好回放');
    expect(stderr).toContain('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行');
    expect(stderr.indexOf('跳过 skill 触发偏好回放')).toBeLessThan(
      stderr.indexOf('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行'),
    );
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
    expect(stderr).toContain('跳过 skill 触发偏好回放');
    expect(stderr).toContain('无法从 degraded installed.json 安全恢复');
    expect(stderr.indexOf('跳过 skill 触发偏好回放')).toBeLessThan(
      stderr.indexOf('无法从 degraded installed.json 安全恢复'),
    );
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
    expect(await runCli(
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
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace),
      },
    )).toBe(0);
    expect(capture.readStderr().match(/跳过 skill trigger 偏好 replay/g)).toBeNull();
  });

  it('installs from an interactive catalog candidate selection', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCalls: NativeCliInvocation[] = [];
    const seenCandidates: Array<{ id: string; pluginName: string; platform?: string; selectable: boolean }> = [];
    const prompt = {
      selectScope: async () => 'user',
      selectPlatform: async ({ available }: { available: string[] }) => {
        expect(available).toEqual(['codex']);
        return 'codex';
      },
      selectPlugins: async ({ candidates }: {
        candidates: Array<{ id: string; pluginName: string; platform?: string; selectable: boolean }>;
      }) => {
        seenCandidates.push(...candidates);
        const candidate = candidates.find((entry) =>
          entry.pluginName === 'git-commit' &&
          entry.platform === 'codex' &&
          entry.selectable
        );
        expect(candidate).toBeTruthy();
        return [candidate!.id];
      },
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('已安装 git-commit：Codex / user scope。');
    expect(seenCandidates[0].id).not.toBe('git-commit');
    expect(nativeCalls.map((invocation) => invocation.args)).toContainEqual([
      'plugin',
      'marketplace',
      'add',
      await fs.realpath(workspace.awHome),
    ]);
  });

  it('rejects interactive plugin selections outside the candidate list', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const prompt = {
      selectScope: async () => 'user',
      selectPlatform: async () => 'codex',
      selectPlugins: async () => ['git-commit'],
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace),
      },
    );

    expect(exitCode).toBe(1);
    expect(capture.readStderr()).toContain('无效候选选择：git-commit');
  });

  it('keeps Codex project interactive install candidates visible without a Codex executable', async () => {
    const workspace = await makeWorkspaceWithMutator(async (repoRoot) => {
      await addCodexProjectFixturePlugins(repoRoot, [
        'skills-only',
        'slashCommands-only',
      ]);
    });
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    workspace.env.PATH = '';

    const seenPlatforms: string[][] = [];
    const seenCandidates: Array<{ pluginName: string; platform?: string; selectable: boolean }> = [];
    const prompt = {
      selectScope: async () => 'project',
      selectPlatform: async ({ available }: { available: string[] }) => {
        seenPlatforms.push([...available]);
        return 'codex';
      },
      selectPlugins: async ({ candidates }: {
        candidates: Array<{ id: string; pluginName: string; platform?: string; selectable: boolean }>;
      }) => {
        seenCandidates.push(...candidates);
        const candidate = candidates.find((entry) =>
          entry.pluginName === 'slash-commands-only' &&
          entry.platform === 'codex' &&
          entry.selectable
        );
        expect(candidate).toBeTruthy();
        return [candidate!.id];
      },
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(seenPlatforms).toEqual([['codex', 'claude', 'both']]);
    expect(seenCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginName: 'skills-only',
          platform: 'codex',
          selectable: true,
        }),
        expect.objectContaining({
          pluginName: 'slash-commands-only',
          platform: 'codex',
          selectable: true,
        }),
      ]),
    );
    expect(capture.readStdout()).toContain('已安装 slash-commands-only：Codex / project scope。');
  });

  it('prompts for platform when explicit install auto is ambiguous on both platforms', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const env = {
      ...workspace.env,
      AW_FORCE_CLAUDE_AVAILABLE: '1',
    } as NodeJS.ProcessEnv;
    const selectedPlatforms: string[] = [];
    const prompt = {
      selectPlatform: async ({ available }: { available: string[] }) => {
        selectedPlatforms.push(...available);
        return 'codex';
      },
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install', 'git-commit'],
      {
        cwd: workspace.repoRoot,
        env,
        io: capture.io,
        prompt,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace),
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(selectedPlatforms).toEqual(['codex', 'claude', 'both']);
    expect(capture.readStdout()).toContain('已安装 git-commit：Codex / user scope。');
  });

  it('allows --interactive to reselect an explicit install platform', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const env = {
      ...workspace.env,
      AW_FORCE_CLAUDE_AVAILABLE: '1',
    } as NodeJS.ProcessEnv;
    const selectedPlatforms: string[] = [];
    const nativeCalls: NativeCliInvocation[] = [];
    const prompt = {
      selectScope: async () => 'user',
      selectPlatform: async ({ available, defaultValue }: { available: string[]; defaultValue?: string }) => {
        selectedPlatforms.push(...available);
        expect(defaultValue).toBe('codex');
        return 'claude';
      },
      selectPlugins: async ({ candidates }: {
        candidates: Array<{ id: string; pluginName: string; platform?: string; selectable: boolean }>;
      }) => {
        const candidate = candidates.find((entry) =>
          entry.pluginName === 'git-commit' &&
          entry.platform === 'claude' &&
          entry.selectable
        );
        expect(candidate).toBeTruthy();
        return [candidate!.id];
      },
    };
    const nativeCliRunner: NativeCliRunner = async (invocation) => {
      nativeCalls.push(invocation);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const capture = createCapturedIo();

    const exitCode = await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex', '--interactive'],
      {
        cwd: workspace.repoRoot,
        env,
        io: capture.io,
        prompt,
        nativeCliRunner,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(selectedPlatforms).toEqual(['codex', 'claude', 'both']);
    expect(capture.readStdout()).toContain('已安装 git-commit：Claude Code / user scope。');
    expect(nativeCalls.some((invocation) =>
      invocation.command === 'claude' &&
      invocation.args.join(' ') === 'plugin install git-commit@aw --scope user'
    )).toBe(true);
  });

  it('does not enter a real prompt for --interactive in a non-TTY runtime', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const capture = createCapturedIo();

    try {
      const exitCode = await runCli(
        ['install', 'git-commit', '--interactive'],
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io: capture.io,
        },
      );

      expect(exitCode).toBe(1);
      expect(capture.readStderr()).toContain('当前运行环境不可交互');
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
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
    expect(capture.readStdout()).toContain('已安装 prompt-guard：Codex / project scope。');
    expect(capture.readStdout()).toContain('已写入 Codex project repo-managed artifacts：.codex/hooks.json、.codex/.agent-workflows-manifest.json。');
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
    expect(logEntries.some((entry) => entry.event.type === 'native:skipped')).toBe(true);
    expect(logEntries.some((entry) => entry.event.type === 'artifacts:written')).toBe(true);
    expect(logEntries.some((entry) => entry.event.type === 'tracking:written')).toBe(true);
    expect(logEntries.some((entry) => entry.event.type === 'ledger:written')).toBe(true);
  });

  it('prints Codex project repo-managed install, upgrade, uninstall and status without native marketplace as the main diagnosis', async () => {
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
      '已写入 Codex project repo-managed artifacts：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。',
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
    expect(capture.readStdout()).toContain('repo-managed：skills=visible，mcpServers=visible');
    expect(capture.readStdout()).not.toContain('Codex marketplace aw 未注册');
    expect(capture.readStdout()).not.toContain('重新注册 Codex marketplace');

    capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'skills-mcp', '--scope', 'project', '--platform', 'codex', '--skill-trigger', 'default'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    ), capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain(
      '已刷新 Codex project repo-managed artifacts：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。',
    );
    expect(capture.readStdout()).not.toContain('已确认 Codex marketplace 注册');
    expect(capture.readStdout()).not.toContain('已确认插件启用');

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
      '已清理 Codex project repo-managed artifacts：.agents/skills、.codex/config.toml、.codex/.agent-workflows-manifest.json。',
    );
    expect(capture.readStdout()).not.toContain('已确认 Codex marketplace 注册');
    expect(capture.readStdout()).not.toContain('已确认插件启用');
  });

  it('does not prompt when --no-interactive is passed', async () => {
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
      ['install', '--no-interactive'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('install 命令至少需要一个插件名');
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

  it('uninstalls a Codex project candidate discovered from a repo subdirectory', async () => {
    const workspace = await makeWorkspaceWithMutator(removeAppsFromGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    await fs.ensureDir(path.join(workspace.repoRoot, '.git'));
    const subdir = path.join(workspace.repoRoot, 'packages', 'feature');
    await fs.ensureDir(subdir);
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'project',
        '--platform',
        'codex',
        '--skill-trigger',
        'default',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner,
      },
    )).toBe(0);

    let selectedExecutionCwd = '';
    const prompt = {
      selectScope: async () => 'project',
      selectPlatform: async () => 'codex',
      selectPlugins: async ({ candidates }: {
        candidates: Array<{
          id: string;
          pluginName: string;
          platform?: string;
          scope?: string;
          executionCwd?: string;
          projectKey?: string;
          selectable: boolean;
        }>;
      }) => {
        const candidate = candidates.find((entry) =>
          entry.pluginName === 'git-commit' &&
          entry.platform === 'codex' &&
          entry.scope === 'project' &&
          entry.selectable
        );
        expect(candidate).toBeTruthy();
        selectedExecutionCwd = candidate!.executionCwd ?? '';
        expect(candidate!.projectKey).toBe(await resolveCodexProjectKey(subdir));
        return [candidate!.id];
      },
    };
    capture = createCapturedIo();

    const exitCode = await runCli(
      ['uninstall'],
      {
        cwd: subdir,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(selectedExecutionCwd).toBe(await fs.realpath(workspace.repoRoot));
    expect(capture.readStdout()).toContain('已卸载 git-commit：Codex / project scope。');
  });

  it('keeps interactive project uninstall on Codex evidence without a Codex executable', async () => {
    const workspace = await makeWorkspaceWithMutator(removeAppsFromGitCommit);
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'project',
        '--platform',
        'codex',
        '--skill-trigger',
        'default',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner,
      },
    )).toBe(0);

    delete workspace.env.AW_FORCE_CODEX_AVAILABLE;
    workspace.env.PATH = '';

    const seenPlatforms: string[][] = [];
    const prompt = {
      selectScope: async () => 'project',
      selectPlatform: async ({ available }: { available: string[] }) => {
        seenPlatforms.push([...available]);
        return 'codex';
      },
      selectPlugins: async ({ candidates }: {
        candidates: Array<{
          id: string;
          pluginName: string;
          platform?: string;
          scope?: string;
          selectable: boolean;
        }>;
      }) => {
        const candidate = candidates.find((entry) =>
          entry.pluginName === 'git-commit' &&
          entry.platform === 'codex' &&
          entry.scope === 'project' &&
          entry.selectable
        );
        expect(candidate).toBeTruthy();
        return [candidate!.id];
      },
    };
    capture = createCapturedIo();

    const exitCode = await runCli(
      ['uninstall'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(seenPlatforms).toEqual([['codex']]);
    expect(capture.readStdout()).toContain('已卸载 git-commit：Codex / project scope。');
  });

  it('rejects interactive auto uninstall before prompting when Claude and Codex project evidence both exist', async () => {
    const workspace = await makeWorkspaceWithMutator(async (repoRoot) => {
      await addCodexProjectFixturePlugins(repoRoot, ['slashCommands-only']);
    });
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'slash-commands-only',
        '--scope',
        'project',
        '--platform',
        'both',
      ],
      {
        cwd: workspace.repoRoot,
        env: {
          ...workspace.env,
          AW_FORCE_CLAUDE_AVAILABLE: '1',
        } as NodeJS.ProcessEnv,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace),
      },
    )).toBe(0);

    let promptCalled = false;
    const prompt = {
      selectScope: async () => 'project',
      selectPlatform: async () => {
        promptCalled = true;
        return 'codex';
      },
      selectPlugins: async () => {
        promptCalled = true;
        return [];
      },
    };
    capture = createCapturedIo();

    const exitCode = await runCli(
      ['uninstall'],
      {
        cwd: workspace.repoRoot,
        env: {
          ...workspace.env,
          AW_FORCE_CLAUDE_AVAILABLE: '1',
        } as NodeJS.ProcessEnv,
        io: capture.io,
        prompt,
      },
    );

    expect(exitCode).toBe(1);
    expect(promptCalled).toBe(false);
    expect(capture.readStderr()).toContain('同时存在 Claude Code 和 Codex 的受管安装证据');
  });

  it('can choose interactive upgrade all after selecting scope and platform', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace);
    await writeInstalledLedger(createAvailableLedger(), workspace.env);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '--skill-trigger',
        'default',
      ],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner,
      },
    )).toBe(0);

    const prompt = {
      selectScope: async () => 'user',
      selectPlatform: async () => 'codex',
      selectUpgradeMode: async ({ canUpgradeAll }: { canUpgradeAll: boolean }) => {
        expect(canUpgradeAll).toBe(true);
        return 'all';
      },
    };
    capture = createCapturedIo();

    const exitCode = await runCli(
      ['upgrade'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(capture.readStdout()).toContain('已升级 git-commit：Codex / user scope。');
  });

  it('prompts for skill-trigger before dispatch when degraded ledger blocks implicit install inheritance', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    const nativeCliRunner = createCodexMarketplaceAddRunner(workspace);

    let capture = createCapturedIo();
    expect(await runCli(
      [
        'install',
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
        nativeCliRunner,
      },
    )).toBe(0);

    const degraded = await readInstalledLedger(workspace.env);
    degraded.ledgerState = {
      status: 'degraded',
      degradedAt: '2026-04-28T00:00:00.000Z',
      reason: 'operation_interrupted_after_native_write',
    };
    await writeInstalledLedger(degraded, workspace.env);

    const prompt = {
      selectSkillTrigger: async ({ allowSkip }: { allowSkip?: boolean }) => {
        expect(allowSkip).toBe(false);
        return 'manual';
      },
    };
    capture = createCapturedIo();
    const exitCode = await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        prompt,
        nativeCliRunner,
      },
    );

    expect(exitCode, capture.readStderr()).toBe(0);
    expect(await readCodexAllowImplicitInvocation(workspace.awHome)).toBe(false);
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
      const parsed = result.parseJsonStdout<{ reports?: unknown[] }>();
      expect(parsed.reports).toBeInstanceOf(Array);
    }
  });

  it('reports Codex marketplace source drift in status JSON and default next steps', async () => {
    const workspace = await makeWorkspace();
    setEmbeddedPluginsRootOverrideForTests(workspace.embeddedRoot);
    let capture = createCapturedIo();
    const nativeCalls: NativeCliInvocation[] = [];

    expect(await runCli(
      ['install', 'git-commit', '--scope', 'user', '--platform', 'codex'],
      {
        cwd: workspace.repoRoot,
        env: workspace.env,
        io: capture.io,
        nativeCliRunner: createCodexMarketplaceAddRunner(workspace, nativeCalls),
      },
    )).toBe(0);

    const wrongSource = path.join(workspace.awHome, 'old-copy');
    await upsertCodexMarketplaceFile(
      resolveCodexPaths(workspace.repoRoot, 'user', workspace.env).configTomlPath,
      'aw',
      {
        source: wrongSource,
        sourceType: 'local',
      },
    );
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
      health: string;
      summaries: Array<{ health: string; nextSteps: string[] }>;
      cells: Array<{ health: string }>;
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

    expect(payload.health).toBe('needsAttention');
    expect(payload.summaries[0].health).toBe('needsAttention');
    expect(payload.summaries[0].nextSteps).toContain(
      '重新注册 Codex marketplace：aw install git-commit --platform codex --scope user',
    );
    expect(payload.cells[0].health).toBe('needsAttention');
    expect(payload.reports[0].plugins[0].native).toMatchObject({
      marketplaceRegistered: false,
      marketplaceSource: wrongSource,
      marketplaceSourceType: 'local',
      marketplaceRootResolution: 'unknown',
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
    expect(capture.readStdout()).toContain('Codex marketplace source 指向');
    expect(capture.readStdout()).toContain(
      '重新注册 Codex marketplace：aw install git-commit --platform codex --scope user',
    );
  });
});
