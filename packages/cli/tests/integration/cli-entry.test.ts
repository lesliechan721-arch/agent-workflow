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

function createCapturedIo() {
  let stdout = '';
  let stderr = '';

  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    readStdout: () => stdout,
    readStderr: () => stderr,
  };
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
    const workspace = await makeWorkspace();
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

    for (const args of [
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '-j'],
      ['status', 'git-commit', '--scope', 'user', '--platform', 'codex', '-j', '--verbose'],
      [
        'status',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '-j',
        '--debug',
        '--log-file',
        path.join(workspace.awHome, 'status-debug.log'),
      ],
      [
        'status',
        'git-commit',
        '--scope',
        'user',
        '--platform',
        'codex',
        '-j',
        '--verbose',
        '--debug',
        '--log-file',
        path.join(workspace.awHome, 'status-verbose-debug.log'),
      ],
    ]) {
      const capture = createCapturedIo();
      const exitCode = await runCli(
        args,
        {
          cwd: workspace.repoRoot,
          env: workspace.env,
          io: capture.io,
        },
      );

      expect(exitCode, capture.readStderr()).toBe(0);
      const parsed = JSON.parse(capture.readStdout()) as { reports?: unknown[] };
      expect(parsed.reports).toBeInstanceOf(Array);
    }
  });
});
