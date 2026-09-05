import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { probeAgentVersion } from '../../src/utils/agent-version.js';
import {
  NativeCliError,
  CodexProjectConfigNotEffectiveError,
  SYSTEM_CODEX_MANAGER,
  buildCodexMarketplaceAddInvocation,
  buildCodexMarketplaceRemoveInvocation,
  buildCodexPluginAddInvocation,
  buildCodexPluginListJsonInvocation,
  buildCodexPluginRemoveInvocation,
  buildCodexProjectPluginListInvocations,
  createExecFileNativeCliRunner,
  execFileNativeCliRunner,
  isNativeCliExecutableMissingError,
  isNativeCliTimeoutError,
  parseCodexPluginListJson,
  postcheckCodexProjectPluginActivation,
  runNativeCli,
  summarizeNativeCliFailure,
  type CodexManager,
  type NativeCliInvocation,
  type NativeCliResult,
} from '../../src/utils/native-cli.js';
import {
  assertProcessTreeInspectionAvailable,
  observeProcessTree,
} from '../../src/utils/process-tree.js';
import { TestNativeCliGuardError } from '../helpers/native-guard.js';

let hostProcessInspectionAvailable = false;
try {
  await assertProcessTreeInspectionAvailable();
  hostProcessInspectionAvailable = true;
} catch {
  // This integration test requires permission to inspect the host process table.
}

function result(stdout = '', stderr = '', exitCode = 0): NativeCliResult {
  return { stdout, stderr, exitCode };
}

function renderClaudeNpmShim(target: string): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      `"%_prog%"  "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');
}

async function writeWindowsClaudeNpmFixture(root: string): Promise<{
  binRoot: string;
  launcher: string;
  shim: string;
}> {
  const binRoot = path.join(root, 'npm-prefix');
  const packageRoot = path.join(binRoot, 'node_modules', '@anthropic-ai', 'claude-code');
  const launcher = path.join(packageRoot, 'cli.js');
  const shim = path.join(binRoot, 'claude.CMD');
  await fs.ensureDir(packageRoot);
  await Promise.all([
    fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: '@anthropic-ai/claude-code',
      version: '2.1.88',
      bin: { claude: 'cli.js' },
    }),
    fs.writeFile(launcher, '#!/usr/bin/env node\n'),
    fs.writeFile(
      shim,
      renderClaudeNpmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'),
    ),
  ]);
  return { binRoot, launcher, shim };
}

describe('native-cli', () => {
  it('resolves the official Windows Claude npm shim for version probes and runner calls', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-shim-'));
    try {
      const fixture = await writeWindowsClaudeNpmFixture(root);
      const childProcesses: Array<EventEmitter & {
        pid: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: ReturnType<typeof vi.fn>;
      }> = [];
      let targetArgs: readonly string[] = [];
      const execFile = vi.fn((_command, _args, _options, callback) => {
        const child = Object.assign(new EventEmitter(), {
          pid: 320 + childProcesses.length,
          exitCode: 0 as number | null,
          signalCode: null as NodeJS.Signals | null,
          kill: vi.fn(() => true),
        });
        childProcesses.push(child);
        queueMicrotask(() => callback(
          null,
          targetArgs.includes('--version') ? '2.1.88 (Claude Code)' : 'ok',
          '',
        ));
        return child;
      });
      const createWindowsJobInvocation = vi.fn((executable, args: readonly string[]) => {
        targetArgs = args;
        return {
          command: 'C:\\aw\\aw-windows-job.exe',
          args: ['--config', 'encoded'] as ['--config', string],
          config: { schemaVersion: 1 as const, executable, args: [...args], parentPid: 42 },
        };
      });
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile,
        createWindowsJobInvocation,
      });
      const env = { PATH: fixture.binRoot, PATHEXT: '.CMD' };

      await expect(probeAgentVersion('claude', {
        cache: false,
        cwd: root,
        env,
        runner,
      })).resolves.toMatchObject({ status: 'supported', detectedVersion: '2.1.88' });
      await expect(runner({
        command: 'claude',
        args: ['plugin', 'list'],
        agentKind: 'claude',
        cwd: root,
        env,
      })).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });

      const canonicalLauncher = await fs.realpath(fixture.launcher);
      expect(createWindowsJobInvocation).toHaveBeenNthCalledWith(
        1,
        process.execPath,
        [canonicalLauncher, '--version'],
      );
      expect(createWindowsJobInvocation).toHaveBeenNthCalledWith(
        2,
        process.execPath,
        [canonicalLauncher, 'plugin', 'list'],
      );
    } finally {
      await fs.remove(root);
    }
  });

  it.each([
    ['malicious shim', async (fixture: Awaited<ReturnType<typeof writeWindowsClaudeNpmFixture>>) => {
      await fs.appendFile(fixture.shim, '@calc.exe\r\n');
    }],
    ['foreign package', async (fixture: Awaited<ReturnType<typeof writeWindowsClaudeNpmFixture>>) => {
      await fs.writeJson(path.join(
        fixture.binRoot,
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'package.json',
      ), { name: '@example/claude', bin: { claude: 'cli.js' } });
    }],
  ] as const)('fails closed before the Windows Job helper for a %s', async (_label, mutate) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-shim-invalid-'));
    try {
      const fixture = await writeWindowsClaudeNpmFixture(root);
      await mutate(fixture);
      const execFile = vi.fn();
      const createWindowsJobInvocation = vi.fn();
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile,
        createWindowsJobInvocation,
      });

      await expect(runner({
        command: 'claude',
        args: ['--version'],
        env: { PATH: fixture.binRoot, PATHEXT: '.CMD' },
      })).rejects.toThrow('Windows Claude launcher is unsupported');
      expect(createWindowsJobInvocation).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      await fs.remove(root);
    }
  });

  it('routes Windows commands through the Job helper and settles after its callback', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      exitCode: 0 as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const execFile = vi.fn((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, 'ready', ''));
      return child;
    });
    const createWindowsJobInvocation = vi.fn(() => ({
      command: 'C:\\aw\\aw-windows-job.exe',
      args: ['--config', 'encoded'] as ['--config', string],
      config: {
        schemaVersion: 1 as const,
        executable: 'agent.exe',
        args: ['--flag'],
        parentPid: 42,
      },
    }));
    const observeProcessTree = vi.fn();
    const terminateProcessTree = vi.fn();
    const runner = createExecFileNativeCliRunner({
      platform: 'win32',
      execFile,
      createWindowsJobInvocation,
      observeProcessTree,
      terminateProcessTree,
    });

    await expect(runner({ command: 'agent.exe', args: ['--flag'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'ready',
      stderr: '',
    });
    expect(createWindowsJobInvocation).toHaveBeenCalledWith('agent.exe', ['--flag']);
    expect(execFile).toHaveBeenCalledWith(
      'C:\\aw\\aw-windows-job.exe',
      ['--config', 'encoded'],
      expect.objectContaining({ detached: false }),
      expect.any(Function),
    );
    expect(observeProcessTree).not.toHaveBeenCalled();
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it('waits for the Windows Job helper callback after timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        createWindowsJobInvocation: () => ({
          command: 'C:\\aw\\aw-windows-job.exe',
          args: ['--config', 'encoded'],
          config: { schemaVersion: 1, executable: 'agent.exe', args: [], parentPid: 42 },
        }),
      });
      const running = runner({ command: 'agent.exe', args: [], timeoutMs: 100 });
      let settled = false;
      void running.then(() => { settled = true; }, () => { settled = true; });

      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(100);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(settled).toBe(false);
      child.signalCode = 'SIGKILL';
      callback!(new Error('helper terminated'), '', '');

      await expect(running).rejects.toMatchObject({ reason: 'timeout', exitCode: 124 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks guarded agent CLIs by default in tests', async () => {
    const invocation = {
      command: 'codex',
      args: ['plugin', 'marketplace', 'add', '/tmp/aw-home'],
      cwd: '/tmp/workspace',
      env: {
        AW_HOME: '/tmp/aw-home',
        PATH: '/tmp/bin',
      } as NodeJS.ProcessEnv,
    };

    await expect(runNativeCli(invocation)).rejects.toBeInstanceOf(TestNativeCliGuardError);
    await expect(runNativeCli(invocation)).rejects.toThrow('请显式注入 fake native runner');
    await expect(runNativeCli(invocation)).rejects.toThrow(
      'cwd 来源: runNativeCli()/createCommandExecutionContext() invocation.cwd',
    );
  });

  it('passes invocations through fake runners', async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];

    const result = await runNativeCli(
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
      },
      async (invocation) => {
        calls.push(invocation);
        return {
          exitCode: 0,
          stdout: 'ok',
          stderr: '',
        };
      },
    );

    expect(calls).toEqual([
      {
        command: 'claude',
        args: ['plugin', 'install', 'git-commit@aw'],
        cwd: '/tmp/workspace',
        timeoutMs: 60_000,
      },
    ]);
    expect(result.stdout).toBe('ok');
  });

  it('applies the default timeout to Codex and Claude executables across path formats', async () => {
    const calls: Array<{ command: string; timeoutMs?: number }> = [];
    const runner = async (invocation: { command: string; timeoutMs?: number }) => {
      calls.push(invocation);
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    await runNativeCli({ command: '/usr/local/bin/codex', args: [], env: {} }, runner);
    await runNativeCli({ command: 'C:\\Tools\\Claude.EXE', args: [], env: {} }, runner);

    expect(calls).toEqual([
      expect.objectContaining({ command: '/usr/local/bin/codex', timeoutMs: 60_000 }),
      expect.objectContaining({ command: 'C:\\Tools\\Claude.EXE', timeoutMs: 60_000 }),
    ]);
  });

  it('builds system Codex plugin and marketplace invocations with unchanged arguments and the effective home', () => {
    const cwd = '/tmp/workspace';
    const codexHome = process.env.AW_CODEX_HOME!;
    const env = { ...process.env, CODEX_HOME: '/ignored/codex-home' };

    const invocations = [
      buildCodexPluginAddInvocation(SYSTEM_CODEX_MANAGER, 'demo@aw', cwd, env),
      buildCodexPluginRemoveInvocation(SYSTEM_CODEX_MANAGER, 'demo@aw', cwd, env),
      buildCodexMarketplaceAddInvocation(SYSTEM_CODEX_MANAGER, '/tmp/aw-home', cwd, env),
      buildCodexMarketplaceRemoveInvocation(SYSTEM_CODEX_MANAGER, 'aw', cwd, env),
    ];

    expect(invocations.map(({ command, args, agentKind, cwd: invocationCwd, env: invocationEnv }) => ({
      command,
      args,
      agentKind,
      cwd: invocationCwd,
      codexHome: invocationEnv?.CODEX_HOME,
    }))).toEqual([
      { command: 'codex', args: ['plugin', 'add', 'demo@aw'], agentKind: 'codex', cwd, codexHome },
      { command: 'codex', args: ['plugin', 'remove', 'demo@aw'], agentKind: 'codex', cwd, codexHome },
      { command: 'codex', args: ['plugin', 'marketplace', 'add', '/tmp/aw-home'], agentKind: 'codex', cwd, codexHome },
      { command: 'codex', args: ['plugin', 'marketplace', 'remove', 'aw'], agentKind: 'codex', cwd, codexHome },
    ]);
  });

  it('builds exact and neutral Codex JSON postcheck invocations without changing trust', () => {
    const env = { ...process.env, CODEX_HOME: '/ignored' };
    const invocations = buildCodexProjectPluginListInvocations(SYSTEM_CODEX_MANAGER, {
      marketplaceName: 'aw-team',
      exactCwd: '/tmp/project',
      neutralCwd: '/tmp/neutral',
      env,
    });

    expect(invocations).toEqual({
      exact: buildCodexPluginListJsonInvocation(
        SYSTEM_CODEX_MANAGER,
        'aw-team',
        '/tmp/project',
        env,
      ),
      neutral: buildCodexPluginListJsonInvocation(
        SYSTEM_CODEX_MANAGER,
        'aw-team',
        '/tmp/neutral',
        env,
      ),
    });
    expect(invocations.exact.args).toEqual([
      'plugin', 'list', '--marketplace', 'aw-team', '--json',
    ]);
    expect(invocations.neutral.args).toEqual([
      'plugin', 'list', '--marketplace', 'aw-team', '--json',
    ]);
    expect([...invocations.exact.args, ...invocations.neutral.args]).not.toContain('trust');
  });

  it('parses structured plugin list identities and verifies project-only activation', () => {
    expect(parseCodexPluginListJson(JSON.stringify({
      installed: [{
        pluginId: 'demo@aw-team',
        name: 'demo',
        marketplaceName: 'aw-team',
        version: '1.0.0',
        installed: true,
        enabled: true,
        source: { source: 'local', path: '/tmp/marketplace/plugins/demo' },
        marketplaceSource: { sourceType: 'local', source: '/tmp/marketplace' },
        installPolicy: 'AVAILABLE',
        authPolicy: 'ON_USE',
      }],
      available: [],
    }))).toEqual([{
      pluginId: 'demo@aw-team',
      enabled: true,
      version: '1.0.0',
      path: '/tmp/marketplace/plugins/demo',
    }]);

    expect(postcheckCodexProjectPluginActivation({
      pluginId: 'demo@aw-team',
      userEnabled: false,
      projectEnabled: true,
      exactResult: result(JSON.stringify({
        installed: [{ pluginId: 'demo@aw-team', installed: true, enabled: true }],
        available: [],
      })),
      neutralResult: result(JSON.stringify({ installed: [], available: [] })),
    })).toEqual({
      effective: true,
      pluginId: 'demo@aw-team',
      exactActive: true,
      neutralActive: false,
    });
  });

  it('maps an ineffective project config to the stable postcheck error', () => {
    expect(() => postcheckCodexProjectPluginActivation({
      pluginId: 'demo@aw-team',
      userEnabled: false,
      projectEnabled: true,
      exactResult: result(JSON.stringify({ installed: [], available: [] })),
      neutralResult: result(JSON.stringify({ installed: [], available: [] })),
    })).toThrow(expect.objectContaining<Partial<CodexProjectConfigNotEffectiveError>>({
      code: 'codexProjectConfigNotEffective',
    }));
  });

  it.each([
    ['legacy plugins object', { plugins: [] }],
    ['bare array', []],
    ['missing available inventory', { installed: [] }],
    ['missing exact plugin ID', {
      installed: [{ name: 'demo', marketplaceName: 'aw-team', installed: true, enabled: true }],
      available: [],
    }],
    ['non-installed entry', {
      installed: [{ pluginId: 'demo@aw-team', installed: false, enabled: true }],
      available: [],
    }],
    ['missing enabled state', {
      installed: [{ pluginId: 'demo@aw-team', installed: true }],
      available: [],
    }],
  ])('fails closed for an invalid Codex 0.151 plugin list: %s', (_label, value) => {
    expect(() => parseCodexPluginListJson(JSON.stringify(value))).toThrow(
      /^codexPluginListInvalid:/u,
    );
  });

  it('runs an AW-managed Codex invocation through its launcher prefix with the Codex default timeout', async () => {
    const manager: CodexManager = {
      kind: 'aw-managed',
      version: '0.145.0',
      command: process.execPath,
      argsPrefix: ['/tmp/codex-launcher.js'],
      runtimeRoot: '/tmp/codex-runtime',
    };
    let receivedInvocation: NativeCliInvocation | undefined;

    await runNativeCli(
      buildCodexPluginListJsonInvocation(manager, 'aw', '/tmp/workspace', process.env),
      async (invocation) => {
        receivedInvocation = invocation;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedInvocation).toMatchObject({
      command: process.execPath,
      args: [
        '/tmp/codex-launcher.js',
        'plugin', 'list', '--marketplace', 'aw', '--json',
      ],
      agentKind: 'codex',
      timeoutMs: 60_000,
      env: { CODEX_HOME: process.env.AW_CODEX_HOME },
    });
  });

  it.each([
    ['0', 0],
    ['1000', 1_000],
    ['600000', 600_000],
  ])('accepts AW_NATIVE_CLI_TIMEOUT_MS=%s', async (rawValue, expectedTimeout) => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'codex',
        args: ['plugin', 'list'],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: rawValue },
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBe(expectedTimeout);
  });

  it.each(['', '999', '600001', '1.5', 'invalid'])(
    'rejects invalid AW_NATIVE_CLI_TIMEOUT_MS=%j before calling the runner',
    async (rawValue) => {
      let runnerCalled = false;

      await expect(
        runNativeCli(
          {
            command: 'claude',
            args: ['plugin', 'list'],
            env: { AW_NATIVE_CLI_TIMEOUT_MS: rawValue },
          },
          async () => {
            runnerCalled = true;
            return { exitCode: 0, stdout: '', stderr: '' };
          },
        ),
      ).rejects.toThrow(
        `Invalid AW_NATIVE_CLI_TIMEOUT_MS=${JSON.stringify(rawValue)}. Expected 0 or an integer from 1000 to 600000.`,
      );
      expect(runnerCalled).toBe(false);
    },
  );

  it('keeps an explicit invocation timeout ahead of the environment default', async () => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'codex',
        args: [],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: '1000' },
        timeoutMs: 2_500,
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBe(2_500);
  });

  it('validates the environment before running an agent CLI with an explicit timeout', async () => {
    let runnerCalled = false;

    await expect(
      runNativeCli(
        {
          command: 'claude',
          args: [],
          env: { AW_NATIVE_CLI_TIMEOUT_MS: 'invalid' },
          timeoutMs: 2_500,
        },
        async () => {
          runnerCalled = true;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      ),
    ).rejects.toThrow('AW_NATIVE_CLI_TIMEOUT_MS="invalid"');
    expect(runnerCalled).toBe(false);
  });

  it('does not apply or validate the agent timeout for other native commands', async () => {
    let receivedTimeout: number | undefined;

    await runNativeCli(
      {
        command: 'tar',
        args: ['--version'],
        env: { AW_NATIVE_CLI_TIMEOUT_MS: 'invalid' },
      },
      async (invocation) => {
        receivedTimeout = invocation.timeoutMs;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    );

    expect(receivedTimeout).toBeUndefined();
  });

  it('captures stdout and stderr from execFile', async () => {
    const result = await createExecFileNativeCliRunner({
      terminateProcessTree: async () => {},
    })({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ready"); process.stderr.write("warn");'],
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'ready',
      stderr: 'warn',
    });
  });

  it.each([
    ['confirms cleanup before returning success', async () => {}, false],
    ['reports cleanup failure instead of returning success', async () => {
      throw new Error('cleanup rejected');
    }, true],
  ])('%s', async (_name, terminateProcessTreeImpl, rejects) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      exitCode: 0 as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn(() => true),
    });
    const observation = {
      pid: 321,
      onFailure: () => () => undefined,
      dispose: vi.fn(),
    };
    const terminateProcessTree = vi.fn(terminateProcessTreeImpl);
    const runner = createExecFileNativeCliRunner({
      platform: 'win32',
      execFile: (_command, _args, _options, callback) => {
        queueMicrotask(() => callback(null, 'ready', ''));
        return child;
      },
      observeProcessTree: () => observation,
      terminateProcessTree,
    });
    const running = runner({ command: 'tar', args: [] });

    if (rejects) {
      await expect(running).rejects.toMatchObject({
        reason: 'exit',
        cleanupError: expect.objectContaining({ message: 'cleanup rejected' }),
      });
    } else {
      await expect(running).resolves.toEqual({ exitCode: 0, stdout: 'ready', stderr: '' });
    }
    expect(terminateProcessTree).toHaveBeenCalledWith(
      321,
      expect.any(Function),
      {},
      {
        observation,
        requireConfirmedCleanup: true,
        allowUnobservedWindowsProcessOnNormalCompletion: true,
      },
    );
  });

  it('overwrites a caller-supplied process marker with a per-run UUID', async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    let receivedDetached: boolean | undefined;
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      kill: vi.fn(() => true),
    });
    const runner = createExecFileNativeCliRunner({
      platform: 'linux',
      execFile: (_command, _args, options, callback) => {
        receivedEnv = options.env;
        receivedDetached = options.detached;
        callback(null, '', '');
        return child;
      },
      terminateProcessTree: async () => {},
      killProcess: vi.fn(() => {
        throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
      }),
    });

    await runner({
      command: 'tar',
      args: [],
      env: {
        AW_NATIVE_CLI_PROCESS_MARKER: 'caller-value',
        KEEP_ME: 'yes',
      },
    });

    expect(receivedEnv).toMatchObject({ KEEP_ME: 'yes' });
    expect(receivedDetached).toBe(true);
    expect(receivedEnv?.AW_NATIVE_CLI_PROCESS_MARKER).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it.each(['darwin', 'win32'] as const)(
    'does not observe the process table for a successful trusted CLI on %s',
    async (platform) => {
      const observe = vi.fn();
      let receivedOptions: { detached: boolean } | undefined;
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        exitCode: 0 as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      });
      const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) {
          throw Object.assign(new Error('missing'), { code: 'ESRCH' });
        }
        return true;
      });
      const runner = createExecFileNativeCliRunner({
        platform,
        observeProcessTree: observe,
        killProcess,
        execFile: (_command, _args, options, callback) => {
          receivedOptions = options;
          callback(null, 'ok', '');
          return child;
        },
      });

      await expect(runner({ command: 'codex', args: [] })).resolves.toMatchObject({
        exitCode: 0,
        stdout: 'ok',
      });
      expect(observe).not.toHaveBeenCalled();
      expect(receivedOptions?.detached).toBe(platform !== 'win32');
      expect(killProcess).toHaveBeenCalledTimes(platform === 'win32' ? 0 : 3);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'keeps a successful real POSIX command successful when marker lookup is denied',
    async () => {
      const groupSignals: Array<number | NodeJS.Signals | undefined> = [];
      const runner = createExecFileNativeCliRunner({
        platform: process.platform,
        observeProcessTree: (pid, marker) => observeProcessTree(pid, marker, {
          platform: process.platform,
          execFile: (_command, args, _options, callback) => {
            if (args.includes('pid=,ppid=,pgid=,state=,lstart=,command=')) {
              callback(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }), '');
              return undefined;
            }
            callback(null, '');
            return undefined;
          },
        }),
        killProcess: (pid, signal) => {
          groupSignals.push(signal);
          process.kill(pid, signal);
          return true;
        },
      });

      await expect(runner({ command: '/usr/bin/true', args: [] })).resolves.toEqual({
        exitCode: 0,
        stdout: '',
        stderr: '',
      });
      expect(groupSignals).toEqual(['SIGTERM', 'SIGKILL', 0]);
    },
  );

  it('converts non-zero exits into NativeCliError', async () => {
    await expect(
      execFileNativeCliRunner({
        command: process.execPath,
        args: [
          '-e',
          'process.stdout.write("partial"); process.stderr.write("boom"); process.exit(7);',
        ],
      }),
    ).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 7,
      stdout: 'partial',
      stderr: 'boom',
    });
  });

  it('surfaces real child timeouts with exitCode 124 and a stable reason', async () => {
    const promise = execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000);'],
      timeoutMs: 100,
    });

    await expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 124,
      reason: 'timeout',
    });
    await expect(promise).rejects.toSatisfy(isNativeCliTimeoutError);
  });

  it('starts timeout accounting after spawn and preserves timeout output', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
        stdout,
        stderr,
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      let finishCleanup: (() => void) | undefined;
      const terminate = vi.fn(() => new Promise<void>((resolve) => {
        finishCleanup = resolve;
      }));
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        terminateProcessTree: terminate,
      });

      const promise = runner({
        command: 'tar',
        args: [],
        timeoutMs: 100,
      });
      const assertion = expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: 'callback partial',
        stderr: 'callback warning',
      });
      expect(vi.getTimerCount()).toBe(0);

      stdout.write('stream partial');
      stderr.write('stream warning');
      child.emit('spawn');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(terminate).toHaveBeenCalledWith(
        321,
        expect.any(Function),
        {},
        { observation: undefined, requireConfirmedCleanup: false },
      );

      callback!(new Error('terminated'), 'callback partial', 'callback warning');
      finishCleanup!();
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles without an execFile callback, preserves stream output, and ignores a late callback', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
        stdout,
        stderr,
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        terminateProcessTree: vi.fn(async () => {}),
      });

      const promise = runner({
        command: 'tar',
        args: [],
        timeoutMs: 100,
      });
      const errorPromise = promise.catch((error: unknown) => error);
      stdout.write('partial');
      stderr.write('warning');
      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(100);

      const error = await errorPromise;
      expect(error).toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: 'partial',
        stderr: 'warning',
      });

      callback!(new Error('late callback'), 'late stdout', 'late stderr');
      await Promise.resolve();
      expect(error).toMatchObject({ stdout: 'partial', stderr: 'warning' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the original success after root-exit cleanup without signaling the root PID', async () => {
    vi.useFakeTimers();
    try {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
        stdout,
        stderr,
      });
      const terminate = vi.fn(async () => {});
      const observation = { pid: 321, dispose: vi.fn() };
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: () => child,
        observeProcessTree: vi.fn(() => observation),
        terminateProcessTree: terminate,
      });

      const promise = runner({
        command: 'tar',
        args: [],
        timeoutMs: 100,
      });
      child.emit('spawn');
      stdout.write('partial');
      stderr.write('warning');
      child.exitCode = 0;
      child.emit('exit');

      await expect(promise).resolves.toEqual({
        exitCode: 0,
        stdout: 'partial',
        stderr: 'warning',
      });
      expect(terminate).toHaveBeenCalledWith(
        321,
        expect.any(Function),
        {},
        {
          observation,
          requireConfirmedCleanup: true,
          allowUnobservedWindowsProcessOnNormalCompletion: true,
        },
      );
      expect(child.kill).not.toHaveBeenCalled();
      expect(stdout.destroyed).toBe(true);
      expect(stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles spawn errors without starting a timeout timer', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
      });

      const promise = runner({
        command: 'missing-native-cli',
        args: [],
        timeoutMs: 1_000,
      });
      callback!(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '');

      await expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
        exitCode: 1,
        reason: 'exit',
        stdout: '',
        stderr: '',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['resolved', () => Promise.resolve(), 0],
    ['rejected', () => Promise.reject(new Error('cleanup rejected')), 1],
    ['throwing', () => { throw new Error('cleanup threw'); }, 1],
    ['pending', () => new Promise<void>(() => {}), 1],
  ])('settles timeout errors when process-tree cleanup is %s', async (
    _label,
    terminate,
    expectedDirectKills,
  ) => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
      });
      const terminateProcessTree = vi.fn(terminate);
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: () => child,
        terminateProcessTree,
      });

      const promise = runner({
        command: 'tar',
        args: [],
        timeoutMs: 100,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(4_500);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
        exitCode: 124,
        reason: 'timeout',
        stdout: '',
        stderr: '',
      });
      expect(child.kill).toHaveBeenCalledTimes(expectedDirectKills);
      if (expectedDirectKills > 0) {
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      }
      expect(terminateProcessTree).toHaveBeenCalledWith(
        321,
        expect.any(Function),
        {},
        { observation: undefined, requireConfirmedCleanup: false },
      );
      const error = await errorPromise as NativeCliError;
      if (_label === 'resolved') {
        expect(error.cleanupError).toBeUndefined();
      } else {
        expect(error.cleanupError).toBeInstanceOf(Error);
        expect(error.message).toContain('cleanup unconfirmed');
      }
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'cleans a detached marked descendant after a generic POSIX command exits normally',
    async () => {
      let descendantPid: number | undefined;
      try {
        const result = await execFileNativeCliRunner({
          command: process.execPath,
          args: [fileURLToPath(new URL(
            '../fixtures/native-cli-detached-descendant.mjs',
            import.meta.url,
          ))],
          timeoutMs: 200,
        });
        expect(result.exitCode).toBe(0);
        descendantPid = Number.parseInt(result.stdout.trim(), 10);
        expect(descendantPid).toBeGreaterThan(0);
        expect(() => process.kill(descendantPid!, 0)).toThrow();
      } finally {
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // The cleanup under test already terminated the descendant.
          }
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable).each([
    ['timeout', 'timeout'],
    ['abort', 'aborted'],
    ['exit', 'exit'],
  ] as const)(
    'cleans a detached marked descendant after a trusted POSIX CLI %s',
    async (mode, reason) => {
      const controller = new AbortController();
      let descendantPid: number | undefined;
      const abortTimer = mode === 'abort'
        ? setTimeout(() => controller.abort(new Error('test abort')), 200)
        : undefined;
      try {
        const error = await execFileNativeCliRunner({
          command: process.execPath,
          args: [fileURLToPath(new URL(
            '../fixtures/native-cli-trusted-detached-failure.mjs',
            import.meta.url,
          )), mode],
          agentKind: 'claude',
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 200 : 2_000,
        }).catch((failure: unknown) => failure) as NativeCliError;
        descendantPid = Number.parseInt(error.stdout.trim(), 10);
        expect(error).toMatchObject({ reason, cleanupError: undefined });
        expect(descendantPid).toBeGreaterThan(0);
        expect(() => process.kill(descendantPid!, 0)).toThrow();
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
        if (descendantPid !== undefined) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // The cleanup under test already terminated the descendant.
          }
        }
      }
    },
  );

  it.each(['codex', 'claude', 'git'])(
    'signals the same POSIX process group for %s',
    async (command) => {
      vi.useFakeTimers();
      try {
        const child = Object.assign(new EventEmitter(), {
          pid: 321,
          kill: vi.fn(() => true),
        });
        const signals: Array<number | NodeJS.Signals> = [];
        const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
          signals.push(signal ?? 'SIGTERM');
          if (signal === 0) {
            throw Object.assign(new Error('missing'), { code: 'ESRCH' });
          }
          return true;
        });
        const observation = { pid: 321, onFailure: () => () => undefined, dispose: vi.fn() };
        const observe = vi.fn(() => observation);
        const terminate = vi.fn(async () => {});
        const runner = createExecFileNativeCliRunner({
          platform: 'linux',
          execFile: () => child,
          killProcess,
          observeProcessTree: observe,
          terminateProcessTree: terminate,
        });
        const promise = runner({ command, args: [], timeoutMs: 100 });
        const errorPromise = promise.catch((error: unknown) => error);

        child.emit('spawn');
        await vi.advanceTimersByTimeAsync(200);

        await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
          exitCode: 124,
          reason: 'timeout',
          cleanupError: undefined,
        });
        expect(killProcess.mock.calls.map(([, signal]) => signal)).toEqual([
          'SIGTERM',
          'SIGKILL',
          0,
        ]);
        expect(killProcess.mock.calls.every(([pid]) => pid === -321)).toBe(true);
        expect(child.kill).not.toHaveBeenCalled();
        expect(observe).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledWith(
          321,
          expect.any(Function),
          {},
          { observation, requireConfirmedCleanup: true },
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ['abort', 'aborted'],
    ['non-zero exit', 'exit'],
  ] as const)('audits the trusted POSIX process marker after %s', async (mode, reason) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(() => true),
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) throw Object.assign(new Error('missing'), { code: 'ESRCH' });
        return true;
      });
      const observation = { pid: 321, onFailure: () => () => undefined, dispose: vi.fn() };
      const observe = vi.fn(() => observation);
      const terminate = vi.fn(async () => {});
      const runner = createExecFileNativeCliRunner({
        platform: 'linux',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        killProcess,
        observeProcessTree: observe,
        terminateProcessTree: terminate,
      });
      const promise = runner({
        command: 'claude',
        args: ['plugin', 'list'],
        signal: controller.signal,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      if (mode === 'abort') {
        controller.abort(new Error('cancelled'));
      } else {
        child.exitCode = 7;
        callback!(Object.assign(new Error('failed'), { code: 7 }), '', 'failed');
      }
      await vi.advanceTimersByTimeAsync(100);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({ reason });
      expect(killProcess.mock.calls.map(([pid, signal]) => [pid, signal])).toEqual([
        [-321, 'SIGTERM'],
        [-321, 'SIGKILL'],
        [-321, 0],
      ]);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(terminate).toHaveBeenCalledWith(
        321,
        expect.any(Function),
        {},
        { observation, requireConfirmedCleanup: true },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when trusted POSIX CLI process-group exit cannot be confirmed', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
      });
      const runner = createExecFileNativeCliRunner({
        platform: 'linux',
        execFile: () => child,
        killProcess: vi.fn(() => true),
      });
      const promise = runner({ command: 'claude', args: [], timeoutMs: 100 });
      const errorPromise = promise.catch((error: unknown) => error);

      child.emit('spawn');
      await vi.advanceTimersByTimeAsync(4_500);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
        reason: 'timeout',
        cleanupError: expect.objectContaining({
          message: 'Native CLI cleanup unconfirmed: process group is still running.',
        }),
      });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovers and terminates a trusted Windows CLI tree only after abort', async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      kill: vi.fn(() => true),
    });
    const observation = { pid: 321, dispose: vi.fn() };
    const observe = vi.fn(() => observation);
    const terminate = vi.fn(async () => {});
    let detached: boolean | undefined;
    const runner = createExecFileNativeCliRunner({
      platform: 'win32',
      execFile: (_command, _args, options) => {
        detached = options.detached;
        return child;
      },
      observeProcessTree: observe,
      terminateProcessTree: terminate,
    });
    const promise = runner({
      command: 'claude',
      args: [],
      signal: controller.signal,
    });
    const errorPromise = promise.catch((error: unknown) => error);

    expect(observe).not.toHaveBeenCalled();
    controller.abort(new Error('cancelled'));

    await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
      reason: 'aborted',
      cleanupError: undefined,
    });
    expect(detached).toBe(false);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(
      321,
      expect.any(Function),
      {},
      { observation, requireConfirmedCleanup: true },
    );
  });

  it('fails closed when trusted Windows CLI tree discovery cannot start', async () => {
    const controller = new AbortController();
    const child = Object.assign(new EventEmitter(), {
      pid: 321,
      kill: vi.fn(() => true),
    });
    const runner = createExecFileNativeCliRunner({
      platform: 'win32',
      execFile: () => child,
      observeProcessTree: () => { throw new Error('inspection unavailable'); },
    });
    const promise = runner({
      command: 'codex',
      args: [],
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toMatchObject<Partial<NativeCliError>>({
      reason: 'aborted',
      cleanupError: expect.objectContaining({ message: 'inspection unavailable' }),
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not start an already-aborted invocation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    const execFile = vi.fn();
    const runner = createExecFileNativeCliRunner({ execFile });

    await expect(runner({
      command: 'tar',
      args: [],
      signal: controller.signal,
    })).rejects.toMatchObject<Partial<NativeCliError>>({
      exitCode: 1,
      reason: 'aborted',
      stdout: '',
      stderr: '',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('aborts a running invocation once and settles without an execFile callback', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        kill: vi.fn(() => true),
      });
      const terminate = vi.fn(async () => {});
      const runner = createExecFileNativeCliRunner({
        platform: 'win32',
        execFile: () => child,
        terminateProcessTree: terminate,
      });
      const promise = runner({
        command: 'tar',
        args: [],
        signal: controller.signal,
        timeoutMs: 1_000,
      });
      const errorPromise = promise.catch((error: unknown) => error);

      child.emit('spawn');
      controller.abort(new Error('cancelled while running'));
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(errorPromise).resolves.toMatchObject<Partial<NativeCliError>>({
        exitCode: 1,
        reason: 'aborted',
      });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detects ENOENT spawn failures as missing executables', () => {
    const error = new NativeCliError({
      invocation: {
        command: 'codex',
        args: ['--version'],
      },
      exitCode: 1,
      stdout: '',
      stderr: '',
      cause: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }),
    });

    expect(isNativeCliExecutableMissingError(error)).toBe(true);
  });

  it('summarizes native CLI failures from stderr, stdout, or the fallback message', () => {
    expect(
      summarizeNativeCliFailure(new NativeCliError({
        invocation: {
          command: 'codex',
          args: ['--version'],
        },
        exitCode: 1,
        stdout: 'partial output',
        stderr: 'boom',
      })),
    ).toBe('boom');

    expect(
      summarizeNativeCliFailure(new NativeCliError({
        invocation: {
          command: 'claude',
          args: ['--version'],
        },
        exitCode: 1,
        stdout: 'partial output',
        stderr: '',
      })),
    ).toBe('partial output');
  });

  it('includes unconfirmed cleanup details in native CLI failure summaries', () => {
    const error = new NativeCliError({
      invocation: {
        command: 'codex',
        args: ['plugin', 'list'],
      },
      exitCode: 124,
      stdout: 'partial output',
      stderr: 'warning output already says cleanup unconfirmed',
      cleanupError: new Error(
        'Native CLI cleanup unconfirmed: Windows process identity lookup failed for AW_NATIVE_CLI_PROCESS_MARKER=secret-value.',
      ),
      reason: 'timeout',
    });

    expect(summarizeNativeCliFailure(error)).toBe(
      'warning output already says cleanup unconfirmed cleanup unconfirmed: Windows process identity lookup failed for [redacted process marker]',
    );
    expect(summarizeNativeCliFailure(error)).not.toContain('AW_NATIVE_CLI_PROCESS_MARKER');
    expect(summarizeNativeCliFailure(error)).not.toContain('secret-value');
  });
});
