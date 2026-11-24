import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
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
  bindNativeCliRunnerSignal,
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

function renderNpmShim(target: string): string {
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

async function writeWindowsAgentNpmFixture(root: string, agent: 'claude' | 'codex'): Promise<{
  binRoot: string;
  launcher: string;
  shim: string;
}> {
  const binRoot = path.join(root, 'npm-prefix');
  const packageName = agent === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code';
  const launcherEntry = agent === 'codex' ? 'bin/codex.js' : 'cli.js';
  const packageRoot = path.join(binRoot, 'node_modules', ...packageName.split('/'));
  const launcher = path.join(packageRoot, ...launcherEntry.split('/'));
  const shim = path.join(binRoot, `${agent}.CMD`);
  await fs.ensureDir(packageRoot);
  await Promise.all([
    fs.writeJson(path.join(packageRoot, 'package.json'), {
      name: packageName,
      version: agent === 'codex' ? '0.200.0' : '2.1.292',
      bin: { [agent]: launcherEntry },
    }),
    fs.outputFile(launcher, '#!/usr/bin/env node\n'),
    fs.writeFile(
      shim,
      renderNpmShim(`node_modules/${packageName}/${launcherEntry}`.replaceAll('/', '\\')),
    ),
  ]);
  return { binRoot, launcher, shim };
}

describe('native-cli', () => {
  // Test Value Gate: namespacing an ordinary cwd changes native trust keys;
  // long cwd values must retain the existing Windows compatibility handling.
  it.each([
    ['short drive', 'C:\\work\\project', 'C:\\work\\project'],
    ['relative', 'relative-project', 'relative-project'],
    ['short UNC', '\\\\server\\share\\project', '\\\\server\\share\\project'],
    ['259 code units', `C:\\${'a\\'.repeat(125)}abcdef`, `C:\\${'a\\'.repeat(125)}abcdef`],
    ['260 code units', `C:\\${'a\\'.repeat(125)}abcdefg`, `\\\\?\\C:\\${'a\\'.repeat(125)}abcdefg`],
    ['Unicode 259 code units', `C:\\${'😀\\'.repeat(85)}x`, `C:\\${'😀\\'.repeat(85)}x`],
    ['Unicode 260 code units', `C:\\${'😀\\'.repeat(85)}xx`, `\\\\?\\C:\\${'😀\\'.repeat(85)}xx`],
    ['explicit namespace', '\\\\?\\C:\\work\\project', '\\\\?\\C:\\work\\project'],
    ['long UNC', `\\\\server\\share\\${'a\\'.repeat(130)}project`, `\\\\?\\UNC\\server\\share\\${'a\\'.repeat(130)}project`],
  ])('preserves the Windows cwd contract for %s', async (_name, cwd, expected) => {
    let observedCwd: string | undefined;
    const onSpawn = vi.fn(() => { throw new Error('diagnostic callback failed'); });
    const runner = createExecFileNativeCliRunner({ platform: 'win32',
      createWindowsJobInvocation: (executable, args) => ({ command: 'fixture-job-helper',
        args: ['--config', 'fixed'], config: { schemaVersion: 1, executable, args: [...args], parentPid: 42 } }),
      execFile: (_command, _args, options, callback) => {
        observedCwd = options.cwd;
        const child = Object.assign(new EventEmitter(), { pid: 321, exitCode: 0, signalCode: null, kill: vi.fn(() => true) });
        queueMicrotask(() => callback(null, 'cwd fixture', ''));
        return child;
      } });
    await expect(runner({ command: 'controlled-client', args: [], cwd, onSpawn })).resolves.toMatchObject({ exitCode: 0 });
    expect(onSpawn).toHaveBeenCalledExactlyOnceWith({ pid: 321 });
    expect(observedCwd).toBe(expected);
  });

  // Test Value Gate: cancellation must preserve the production runner's unconfirmed-cleanup evidence and original cause.
  it('preserves NativeCliError cleanup evidence when a bound read is cancelled', async () => {
    const abort = new AbortController();
    const cause = new DOMException('session cancelled', 'AbortError');
    const cleanupError = new Error('Native CLI cleanup unconfirmed: remaining process identity is unavailable.');
    let nativeFailure: NativeCliError | undefined;
    const runner = bindNativeCliRunnerSignal(async (invocation) => {
      abort.abort(cause);
      nativeFailure = new NativeCliError({ invocation, exitCode: 1, stdout: '', stderr: '',
        reason: 'aborted', cause, cleanupError });
      throw nativeFailure;
    }, abort.signal);
    const failure = await runner({ command: 'codex', args: ['plugin', 'list'] }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NativeCliError);
    expect(failure).toMatchObject({ name: 'AbortError', reason: 'aborted' });
    expect(failure).toBe(nativeFailure);
    expect((failure as NativeCliError).cleanupError).toBe(cleanupError);
    expect((failure as NativeCliError).cause).toBe(cause);
  });

  // Test Value Gate: Windows probes must use the child process's selected PATH and PATHEXT, including duplicate key casing.
  it.each(['claude', 'codex'] as const)('resolves the official Windows %s npm shim with Node-selected environment keys', async (agent) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `aw-${agent}-shim-`));
    try {
      const fixture = await writeWindowsAgentNpmFixture(root, agent);
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
          targetArgs.includes('--version')
            ? agent === 'codex' ? 'codex-cli 0.200.0' : '2.1.292 (Claude Code)'
            : 'ok',
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
      const env = { ...process.env, Path: path.join(root, 'ignored-prefix'), PATH: fixture.binRoot,
        Pathext: '.BAT', PATHEXT: '.CMD' };

      await expect(probeAgentVersion(agent, {
        cache: false,
        cwd: root,
        env,
        runner,
      })).resolves.toMatchObject({ status: 'supported', detectedVersion: agent === 'codex' ? '0.200.0' : '2.1.292' });
      await expect(runner({
        command: agent,
        args: ['plugin', 'list'],
        agentKind: agent,
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
    ['malicious shim', async (fixture: Awaited<ReturnType<typeof writeWindowsAgentNpmFixture>>) => {
      await fs.appendFile(fixture.shim, '@calc.exe\r\n');
    }],
    ['foreign package', async (fixture: Awaited<ReturnType<typeof writeWindowsAgentNpmFixture>>) => {
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
      const fixture = await writeWindowsAgentNpmFixture(root, 'claude');
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
    const codexHome = process.env.CODEX_HOME!;
    const env = { ...process.env, AW_CODEX_HOME: '/ignored/codex-home' };

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
    const env = { ...process.env, AW_CODEX_HOME: '/ignored' };
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

  it('runs a local Codex launcher prefix with the Codex default timeout', async () => {
    const manager: CodexManager = {
      kind: 'system',
      version: '0.153.0',
      command: process.execPath,
      argsPrefix: ['/tmp/codex-launcher.js'],
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
      env: { CODEX_HOME: process.env.CODEX_HOME },
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

  // A real child must own the process group AW signals during cleanup.
  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'starts the real POSIX CLI in its own process group',
    async () => {
      let childPid: number | undefined;
      const result = await execFileNativeCliRunner({
        command: process.execPath,
        args: ['-e', `
          const { execFileSync } = require('node:child_process');
          const group = execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' });
          process.stdout.write(group.trim());
        `],
        agentKind: 'claude',
        env: { PATH: '/bin:/usr/bin' },
        onSpawn: ({ pid }) => { childPid = pid; },
      });

      expect(childPid).toBeGreaterThan(1);
      expect(Number(result.stdout)).toBe(childPid);
    },
  );

  // The POSIX launcher must drain both pipes and decode UTF-8 across reads.
  it.skipIf(process.platform === 'win32')('preserves large UTF-8 output on both POSIX streams', async () => {
    const stdout = '😀'.repeat(200_000) + '\nstdout complete\n';
    const stderr = '界'.repeat(230_000) + '\nstderr complete\n';
    const response = await execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', `
        const out = Buffer.from('😀'.repeat(200_000) + '\\nstdout complete\\n');
        const err = Buffer.from('界'.repeat(230_000) + '\\nstderr complete\\n');
        process.stdout.write(out.subarray(0, 1));
        process.stderr.write(err.subarray(0, 1));
        setTimeout(() => {
          process.stdout.write(out.subarray(1));
          process.stderr.write(err.subarray(1));
        }, 10);
      `],
      agentKind: 'claude',
      env: {},
    });

    expect(response.exitCode).toBe(0);
    expect(response.stdout === stdout, 'stdout differs from what the child wrote').toBe(true);
    expect(response.stderr === stderr, 'stderr differs from what the child wrote').toBe(true);
  });

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'bounds POSIX output and cleans up a child that ignores TERM after overflowing',
    async () => {
      const error = await execFileNativeCliRunner({
        command: process.execPath,
        args: ['-e', `
          process.on('SIGTERM', () => {});
          process.stderr.write('warning', () => process.stdout.write('x'.repeat(2 * 1024 * 1024)));
          setTimeout(() => {}, 2_000);
        `],
        agentKind: 'claude',
        env: {},
        timeoutMs: 1_000,
      }).catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(NativeCliError);
      expect(error).toMatchObject({ exitCode: 1, reason: 'exit', stderr: 'warning', cleanupError: undefined,
        cause: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } });
      expect(Buffer.byteLength((error as NativeCliError).stdout)).toBe(1024 * 1024);
    },
  );

  it.skipIf(process.platform === 'win32')('reports a real POSIX spawn ENOENT as a missing executable', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-native-cli-missing-'));
    try {
      const running = execFileNativeCliRunner({ command: path.join(root, 'missing'), args: [], env: {}, timeoutMs: 100 });
      await expect(running).rejects.toMatchObject({ reason: 'exit', stdout: '', stderr: '' });
      await expect(running).rejects.toSatisfy(isNativeCliExecutableMissingError);
    } finally {
      await fs.remove(root);
    }
  });

  // A trusted CLI's successful root exit skips the marker audit. That leaves
  // group cleanup responsible for an unmarked child still holding the pipe.
  it.skipIf(process.platform === 'win32')('cleans a real POSIX group member and keeps its final output', async () => {
    const descendant = `
      process.once('SIGTERM', () => process.stdout.write('descendant terminated\\n', () => process.exit(0)));
      setTimeout(() => {}, 1_000);
      process.send('ready');
    `;
    const response = await execFileNativeCliRunner({
      command: process.execPath,
      args: ['-e', `
        const { spawn } = require('node:child_process');
        const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
          env: {}, stdio: ['ignore', 'inherit', 'ignore', 'ipc'],
        });
        child.once('message', () => process.stdout.write('root exited\\n', () => process.exit(0)));
      `],
      agentKind: 'claude',
      env: {},
      timeoutMs: 2_000,
    });

    expect(response).toEqual(result('root exited\ndescendant terminated\n'));
  });

  // A root exit can precede the execFile callback. Return the complete output
  // within the grace window while still signaling and verifying the group.
  it.each([
    {
      description: 'returns complete POSIX output before the grace period ends when the group is gone',
      missingGroup: true,
      abortAfterOutput: false,
      keepGrace: false,
    },
    {
      description: 'retains the POSIX grace period when TERM reaches the group',
      missingGroup: false,
      abortAfterOutput: false,
      keepGrace: true,
    },
    {
      description: 'retains the POSIX grace period when cancelled as complete output arrives',
      missingGroup: true,
      abortAfterOutput: true,
      keepGrace: true,
    },
  ])('$description', async ({ missingGroup, abortAfterOutput, keepGrace }) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        pid: 321,
        exitCode: 0,
        signalCode: null,
        kill: vi.fn(() => true),
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 'SIGTERM' && !missingGroup) return true;
        throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
      });
      const runner = createExecFileNativeCliRunner({
        platform: 'linux',
        execFile: (_command, _args, _options, nextCallback) => {
          callback = nextCallback;
          return child;
        },
        killProcess,
        terminateProcessTree: async () => {},
      });
      const onSettled = vi.fn();
      const completion = runner({ command: 'codex', args: [], signal: controller.signal })
        .then(onSettled, onSettled);

      child.emit('exit');
      await vi.advanceTimersByTimeAsync(35);
      expect(onSettled).not.toHaveBeenCalled();
      expect(killProcess.mock.calls).toEqual([[-321, 'SIGTERM']]);

      const stdout = 'complete stdout';
      const stderr = 'complete stderr';
      callback!(null, stdout, stderr);
      if (abortAfterOutput) controller.abort();
      await vi.advanceTimersByTimeAsync(keepGrace ? 64 : 0);
      if (keepGrace) {
        expect(onSettled).not.toHaveBeenCalled();
        expect(killProcess.mock.calls).toEqual([[-321, 'SIGTERM']]);
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(onSettled).toHaveBeenCalledExactlyOnceWith(abortAfterOutput
        ? expect.objectContaining({ reason: 'aborted', stdout, stderr })
        : result(stdout, stderr));
      await completion;
      expect(killProcess.mock.calls).toEqual([[-321, 'SIGTERM'], [-321, 'SIGKILL'], [-321, 0]]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Reproduce the Darwin TERM result at the signal boundary while using the
  // real launcher, group-existence check, stdio, and marker audit.
  it.skipIf(process.platform !== 'darwin' || !hostProcessInspectionAvailable)(
    'keeps complete output from an exited Darwin CLI when the denied process group is gone',
    async () => {
      let childPid: number | undefined;
      const killProcess = vi.fn((pid: number, signal?: number | NodeJS.Signals) => {
        expect(pid).toBe(-childPid!);
        if (signal === 0) return process.kill(pid, 0);
        if (signal === 'SIGTERM') throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        throw new Error('The test must not signal a group after its absence is confirmed.');
      });
      const runner = createExecFileNativeCliRunner({ killProcess });

      await expect(runner({
        command: process.execPath,
        args: ['-e', "process.stdout.write('complete stdout'); process.stderr.write('complete stderr');"],
        env: {},
        onSpawn: ({ pid }) => { childPid = pid; },
      })).resolves.toEqual(result('complete stdout', 'complete stderr'));
      expect(killProcess.mock.calls).toEqual([[-childPid!, 'SIGTERM'], [-childPid!, 0]]);
    },
  );

  it.each([
    { name: 'TERM after the root exited', deniedSignal: 'SIGTERM', abortDuringAudit: false, auditFailure: false },
    { name: 'KILL after the grace period', deniedSignal: 'SIGKILL', abortDuringAudit: false, auditFailure: false },
    { name: 'cancellation during the audit', deniedSignal: 'SIGTERM', abortDuringAudit: true, auditFailure: false },
    { name: 'failed marker audit', deniedSignal: 'SIGTERM', abortDuringAudit: false, auditFailure: true },
  ] as const)('requires complete Darwin output and an applicable audit after $name', async ({
    deniedSignal, abortDuringAudit, auditFailure,
  }) => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { pid: 321, exitCode: 0, signalCode: null, kill: vi.fn() });
      const controller = new AbortController();
      const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const auditError = new Error('Process tree cleanup unconfirmed: POSIX process marker lookup failed.');
      const { promise: audit, resolve: finishAudit, reject: failAudit } = Promise.withResolvers<void>();
      const terminateProcessTree = vi.fn(() => audit);
      let auditFinished = false;
      const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === deniedSignal) throw denied;
        if (signal === 0 && auditFinished) throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
        return true;
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: 'darwin',
        execFile: (_command, _args, _options, completed) => { callback = completed; return child; },
        observeProcessTree: () => ({ pid: 321, onFailure: () => () => undefined, dispose: () => {} }),
        terminateProcessTree,
        killProcess,
      });
      const onSettled = vi.fn();
      const running = runner({ command: 'cursor-agent', args: ['--help'], signal: controller.signal }).then(onSettled, onSettled);

      child.emit('exit');
      await vi.advanceTimersByTimeAsync(35);
      expect(onSettled).not.toHaveBeenCalled();
      expect(terminateProcessTree).not.toHaveBeenCalled();
      callback!(null, 'complete stdout', 'complete stderr');
      await vi.advanceTimersByTimeAsync(deniedSignal === 'SIGTERM' ? 0 : 65);
      expect(terminateProcessTree).toHaveBeenCalledTimes(1);
      expect(onSettled).not.toHaveBeenCalled();
      const terminatingSignals = deniedSignal === 'SIGTERM' ? [[-321, 'SIGTERM']] : [[-321, 'SIGTERM'], [-321, 'SIGKILL']];
      expect(killProcess.mock.calls).toEqual(terminatingSignals);
      if (abortDuringAudit) controller.abort();
      if (auditFailure) failAudit(auditError);
      else {
        auditFinished = true;
        finishAudit();
      }
      await running;

      expect(onSettled).toHaveBeenCalledExactlyOnceWith(abortDuringAudit || auditFailure
        ? expect.objectContaining({
          reason: abortDuringAudit ? 'aborted' : 'exit',
          stdout: 'complete stdout', stderr: 'complete stderr',
          cleanupError: expect.objectContaining({ cause: denied }),
        })
        : result('complete stdout', 'complete stderr'));
      expect(killProcess.mock.calls).toEqual(abortDuringAudit || auditFailure ? terminatingSignals : [...terminatingSignals, [-321, 0]]);
      expect(child.kill).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: 'group still present', platform: 'darwin', exitCode: 0, probe: true, signalZero: 'present' },
    { name: 'signal zero is also denied', platform: 'darwin', exitCode: 0, probe: true, signalZero: 'EPERM' },
    { name: 'signal zero fails otherwise', platform: 'darwin', exitCode: 0, probe: true, signalZero: 'EIO' },
    { name: 'callback reports truncated output', platform: 'darwin', exitCode: 0, probe: false, signalZero: 'ESRCH', overflow: true },
    { name: 'command exits non-zero', platform: 'darwin', exitCode: 7, probe: false, signalZero: 'ESRCH' },
    { name: 'command was cancelled', platform: 'darwin', exitCode: null, probe: false, signalZero: 'ESRCH' },
    { name: 'trusted success skips the marker audit', platform: 'darwin', exitCode: 0, probe: false, signalZero: 'ESRCH', trusted: true },
    { name: 'a marker audit could not be prepared', platform: 'darwin', exitCode: 0, probe: false, signalZero: 'ESRCH', observationUnavailable: true },
    { name: 'host is Linux', platform: 'linux', exitCode: 0, probe: false, signalZero: 'ESRCH' },
  ] as const)('keeps denied group cleanup unconfirmed when $name', async (scenario) => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), {
        pid: 321, exitCode: scenario.exitCode, signalCode: null, kill: vi.fn(),
      });
      const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      const killProcess = vi.fn((_pid: number, signal?: number | NodeJS.Signals) => {
        if (signal !== 0) throw denied;
        if (scenario.signalZero === 'present') return true;
        throw Object.assign(new Error('signal zero failed'), { code: scenario.signalZero });
      });
      const observeProcessTree = vi.fn((pid: number) => {
        if ('observationUnavailable' in scenario) throw new Error('marker audit unavailable');
        return { pid, onFailure: () => () => undefined, dispose: () => {} };
      });
      let callback: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: scenario.platform,
        execFile: (_command, _args, _options, completed) => { callback = completed; return child; },
        observeProcessTree,
        terminateProcessTree: async () => {},
        killProcess,
      });
      const cancelled = scenario.exitCode === null;
      const trusted = 'trusted' in scenario;
      const running = runner({ command: trusted ? 'claude' : 'cursor-agent', args: ['--help'], signal: controller.signal })
        .catch((error: unknown) => error);
      if (cancelled) controller.abort();
      else child.emit('exit');
      const overflow = 'overflow' in scenario ? new RangeError('stdout maxBuffer length exceeded') : null;
      callback!(overflow, 'stdout', 'stderr');
      await vi.advanceTimersByTimeAsync(100);

      await expect(running).resolves.toMatchObject({
        reason: cancelled ? 'aborted' : 'exit',
        stdout: 'stdout', stderr: 'stderr',
        cleanupError: expect.objectContaining({ cause: denied }),
      });
      expect(killProcess.mock.calls).toEqual(scenario.probe ? [[-321, 'SIGTERM'], [-321, 0]] : [[-321, 'SIGTERM']]);
      expect(observeProcessTree).toHaveBeenCalledTimes(trusted ? 0 : 1);
      expect(child.kill).toHaveBeenCalledTimes(cancelled ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable).each([
    { output: 'inherited', args: [] },
    { output: 'closed', args: ['--ignore-output'] },
  ])(
    'cleans a detached marked descendant with $output output after a generic POSIX command exits normally',
    async ({ args }) => {
      let descendantPid: number | undefined;
      try {
        const result = await execFileNativeCliRunner({
          command: process.execPath,
          args: [
            fileURLToPath(new URL('../fixtures/native-cli-detached-descendant.mjs', import.meta.url)),
            ...args,
          ],
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

  // Exercise concurrent, real process cleanup across completion and cancellation paths.
  it.skipIf(process.platform === 'win32' || !hostProcessInspectionAvailable)(
    'cleans only its own descendants when native POSIX marker scans are shared', async () => {
      const runner = createExecFileNativeCliRunner({ coalescePosixMarkerScans: true });
      const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });
      const unrelatedClosed = once(unrelated, 'close');
      const modes = [
        ['normal-inherited', 'inherit', undefined, 0],
        ['normal-closed', 'ignore', undefined, 0],
        ['exit', 'inherit', 'exit', 7],
        ['timeout', 'inherit', 'timeout', 124],
        ['abort', 'inherit', 'aborted', 1],
      ] as const;
      try {
        const results = await Promise.allSettled(modes.map(async ([mode, output, reason, exitCode]) => {
          const script = `
            const { spawn } = require('node:child_process');
            const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], {
              detached: true, stdio: ['ignore', ${JSON.stringify(output)}, ${JSON.stringify(output)}],
            });
            descendant.unref();
            process.stdout.write(String(descendant.pid) + '\\n');
            if (${JSON.stringify(reason)} === 'exit') process.exit(7);
            if (${JSON.stringify(reason)} !== undefined) setTimeout(() => {}, 10_000);
          `;
          const controller = new AbortController();
          let abortTimer: NodeJS.Timeout | undefined;
          try {
            const response = await runner({
              command: process.execPath, args: ['-e', script], signal: controller.signal,
              ...(reason === undefined ? {} : { agentKind: 'claude' }),
              timeoutMs: mode === 'timeout' ? 500 : 3_000,
              onSpawn() {
                if (mode === 'abort') abortTimer = setTimeout(() => controller.abort(), 500);
              },
            }).catch((error: unknown) => error);
            expect(response).toMatchObject(reason === undefined ? { exitCode } : {
              exitCode, reason, cleanupError: undefined,
            });
            const pid = Number.parseInt((response as NativeCliResult | NativeCliError).stdout.trim(), 10);
            expect(pid).toBeGreaterThan(1);
            expect(() => process.kill(pid, 0)).toThrow();
          } finally {
            if (abortTimer) clearTimeout(abortTimer);
          }
        }));
        expect(results).toEqual(modes.map(() => ({ status: 'fulfilled', value: undefined })));
        expect(unrelated.exitCode).toBeNull();
        expect(unrelated.signalCode).toBeNull();
      } finally {
        if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill();
        await unrelatedClosed;
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
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

  it.each([false, true])('waits to verify Darwin group exit after a denied probe (persistent: %s)', async (persistent) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const child = Object.assign(new EventEmitter(), {
        pid: 321, exitCode: 0, signalCode: null, kill: vi.fn(),
      });
      const denied = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      let probeCount = 0;
      let complete: ((error: unknown, stdout: string, stderr: string) => void) | undefined;
      const runner = createExecFileNativeCliRunner({
        platform: 'darwin',
        execFile: (_command, _args, _options, callback) => { complete = callback; return child; },
        killProcess: (_pid, signal) => {
          if (signal !== 0) return true;
          if (++probeCount <= 2 || persistent) throw denied;
          throw Object.assign(new Error('missing process group'), { code: 'ESRCH' });
        },
      });
      const settled = vi.fn();
      const running = runner({ command: 'claude', args: [] });
      void running.then(settled, settled);
      complete!(null, 'complete stdout', '');

      await vi.advanceTimersByTimeAsync(125);
      expect(probeCount).toBeGreaterThan(0);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_200);
      if (persistent) {
        await expect(running).rejects.toMatchObject({
          cleanupError: expect.objectContaining({ cause: denied }),
        });
      } else {
        await expect(running).resolves.toEqual(result('complete stdout', ''));
      }
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
