import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommandWarningError } from '../../src/types.js';
import { NativeCliError } from '../../src/utils/native-cli.js';

const tempDirs: string[] = [];

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

afterEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cli entry', () => {
  it('rejects invalid --skill-trigger values at the entry layer', async () => {
    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--skill-trigger', 'sometimes'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain('Unsupported skill trigger preference "sometimes"');
  });

  it('passes install --skill-trigger to installCommand', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--skill-trigger', 'manual'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      }),
      expect.objectContaining({
        env,
        nativeCliRunner: expect.any(Function),
        diagnostics: expect.objectContaining({
          commandName: 'install',
        }),
      }),
    );
  });

  it('prints a readable install receipt without English warning prefixes', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      nativePlugins: {
        codex: ['git-commit'],
      },
      warnings: ['当前 repo trust 状态未知，project scope 会话可见性无法确定。'],
    }));
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--scope', 'user', '--no-interactive'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStdout()).toContain('已安装 git-commit：Codex / user scope。');
    expect(readStdout()).toContain('使用插件目录：AW marketplace。');
    expect(readStdout()).toContain('已确认 Codex marketplace 注册：/tmp/aw-home。');
    expect(readStdout()).toContain('已确认插件启用：git-commit@aw。');
    expect(readStdout()).toContain('完成。下一步：运行 aw status git-commit -p codex');
    expect(readStderr()).not.toContain('Warning:');
    expect(readStderr()).toContain('注意：Codex 已写入 project scope 文件');
  });

  it('prints readable uninstall and upgrade receipts', async () => {
    const uninstallCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['claude'],
      nativePlugins: {
        claude: ['git-commit'],
      },
      warnings: [],
    }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已卸载 git-commit：Codex / user scope。');
    expect(capture.readStdout()).toContain('已清理匹配的受管状态和生成产物。');

    capture = createCapturedIo();
    expect(await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude'],
      { cwd: '/tmp/workspace', env: { AW_HOME: '/tmp/aw-home' } as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(0);
    expect(capture.readStdout()).toContain('已升级 git-commit：Claude Code / user scope。');
    expect(capture.readStdout()).toContain('已确认 Claude Code marketplace 和插件状态。');
  });

  it('passes upgrade --skill-trigger to upgradeCommand', async () => {
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['claude'],
      warnings: [],
    }));
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand,
    }));

    const { io } = createCapturedIo();
    const env = {} as NodeJS.ProcessEnv;
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit', '--platform', 'claude', '--skill-trigger', 'auto'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(upgradeCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'claude',
        requestedSkillTrigger: 'auto',
      }),
      expect.objectContaining({
        env,
        nativeCliRunner: expect.any(Function),
        diagnostics: expect.objectContaining({
          commandName: 'upgrade',
        }),
      }),
    );
  });

  it('parses short options with the same raw values as long options', async () => {
    const installCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const upgradeCommand = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
    }));
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: JSON.stringify({ ok: true }),
    }));
    const initCommand = vi.fn(async () => ({
      changed: true,
      rootDir: '/tmp/aw',
      warnings: [],
    }));
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
    vi.doMock('../../src/commands/status.js', () => ({ statusCommand }));
    vi.doMock('../../src/commands/init.js', () => ({ initCommand }));

    const { runCli } = await import('../../src/index.js');

    expect(await runCli(
      ['init', '-f'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['install', 'git-commit', '-p', 'codex', '-s', 'user', '-t', 'manual'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['upgrade', '-a', '-p', 'both'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);
    expect(await runCli(
      ['status', '-j'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: createCapturedIo().io },
    )).toBe(0);

    expect(initCommand).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'codex',
        requestedSkillTrigger: 'manual',
      }),
      expect.anything(),
    );
    expect(upgradeCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        scope: 'user',
        platform: 'both',
        all: true,
      }),
      expect.anything(),
    );
    expect(statusCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        cwd: '/tmp/workspace',
        json: true,
      }),
      expect.anything(),
    );
    expect(statusCommand.mock.calls[0][1]).not.toHaveProperty('scope');
    expect(statusCommand.mock.calls[0][1]).not.toHaveProperty('platform');
  });

  it('passes missing install and uninstall plugin names through Commander to command handlers', async () => {
    const installCommand = vi.fn(async () => {
      throw new Error('install 命令至少需要一个插件名。');
    });
    const uninstallCommand = vi.fn(async () => {
      throw new Error('uninstall 命令至少需要一个插件名。');
    });
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));
    vi.doMock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));

    const { runCli } = await import('../../src/index.js');

    let capture = createCapturedIo();
    expect(await runCli(
      ['install'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('install 命令至少需要一个插件名');
    expect(capture.readStderr()).not.toContain('missing required argument');
    expect(installCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        scope: 'user',
        platform: 'auto',
      }),
      expect.anything(),
    );

    capture = createCapturedIo();
    expect(await runCli(
      ['uninstall'],
      { cwd: '/tmp/workspace', env: {} as NodeJS.ProcessEnv, io: capture.io },
    )).toBe(1);
    expect(capture.readStderr()).toContain('uninstall 命令至少需要一个插件名');
    expect(capture.readStderr()).not.toContain('missing required argument');
    expect(uninstallCommand).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        scope: 'user',
        platform: 'auto',
      }),
      expect.anything(),
    );
  });

  it('threads injected native runner, prompt, reporter, and debug logger through one context', async () => {
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    }));
    const prompt = {
      confirm: vi.fn(async () => true),
    };
    const reporter = {
      event: vi.fn(),
      notice: vi.fn(),
    };
    const debugLogger = {
      log: vi.fn(),
      flush: vi.fn(),
    };
    const env = {} as NodeJS.ProcessEnv;

    const installCommand = vi.fn(async (
      _plugins: string[],
      commandOptions: { cwd: string },
      context: {
        env: NodeJS.ProcessEnv;
        nativeCliRunner: (invocation: {
          command: string;
          args: string[];
          cwd?: string;
          env?: NodeJS.ProcessEnv;
        }) => Promise<unknown>;
        prompt: typeof prompt;
        reporter: typeof reporter;
        debugLogger: typeof debugLogger;
      },
    ) => {
      await context.nativeCliRunner({
        command: 'probe',
        args: ['install'],
        cwd: commandOptions.cwd,
        env: context.env,
      });
      await context.prompt.confirm({ message: 'continue?' });
      await context.reporter.event({ type: 'inside-command' });
      await context.debugLogger.log({ type: 'inside-command' });
      return {
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: [],
      };
    });
    vi.doMock('../../src/commands/install.js', () => ({
      installCommand,
    }));

    const { io } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');
    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env,
        io,
        nativeCliRunner,
        prompt,
        reporter,
        debugLogger,
      },
    );

    expect(exitCode).toBe(0);
    expect(nativeCliRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'probe',
        args: ['install'],
        cwd: '/tmp/workspace',
        env,
      }),
    );
    expect(prompt.confirm).toHaveBeenCalledTimes(1);
    expect(reporter.event).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'command:start',
        commandName: 'install',
      }),
    );
    expect(debugLogger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'native:success',
        commandName: 'install',
      }),
    );
    expect(debugLogger.flush).toHaveBeenCalled();
  });

  it('normalizes AW_DEBUG, --debug, and --log-file into command diagnostics', async () => {
    const diagnostics: Array<{ debug: boolean; verbose: boolean; logFile?: string }> = [];
    const statusCommand = vi.fn(async (
      _plugins: string[],
      _options: unknown,
      context: { diagnostics: { debug: boolean; verbose: boolean; logFile?: string } },
    ) => {
      diagnostics.push(context.diagnostics);
      return {
        reports: [],
        output: JSON.stringify({ ok: true }),
      };
    });
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const { runCli } = await import('../../src/index.js');
    let capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit'],
      {
        cwd: '/tmp/workspace',
        env: { AW_DEBUG: '1' } as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-debug-'));
    tempDirs.push(tempDir);
    const logFile = path.join(tempDir, 'debug.log');
    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--debug', '--log-file', logFile],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    const logOnlyFile = path.join(tempDir, 'log-only.log');
    capture = createCapturedIo();
    expect(await runCli(
      ['status', 'git-commit', '--log-file', logOnlyFile],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io: capture.io,
      },
    )).toBe(0);

    expect(diagnostics[0]).toMatchObject({
      debug: true,
      verbose: true,
    });
    expect(diagnostics[1]).toMatchObject({
      debug: true,
      verbose: true,
      logFile,
    });
    expect(diagnostics[2]).toMatchObject({
      debug: false,
      verbose: false,
      logFile: logOnlyFile,
    });
    expect(await fs.pathExists(logFile)).toBe(true);
    expect(await fs.pathExists(logOnlyFile)).toBe(false);
  });

  it('keeps status JSON stdout parseable with verbose and debug diagnostics', async () => {
    const statusCommand = vi.fn(async (
      _plugins: string[],
      options: { json?: boolean; verbose?: boolean },
    ) => ({
      reports: [],
      output: JSON.stringify({
        json: options.json === true,
        verbose: options.verbose === true,
      }),
    }));
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const { runCli } = await import('../../src/index.js');
    for (const args of [
      ['status', 'git-commit', '-j'],
      ['status', 'git-commit', '-j', '--verbose'],
      ['status', 'git-commit', '-j', '--debug'],
      ['status', 'git-commit', '-j', '--verbose', '--debug'],
    ]) {
      const { io, readStdout } = createCapturedIo();
      const exitCode = await runCli(
        args,
        {
          cwd: '/tmp/workspace',
          env: {} as NodeJS.ProcessEnv,
          io,
        },
      );

      expect(exitCode).toBe(0);
      expect(() => JSON.parse(readStdout())).not.toThrow();
      expect(JSON.parse(readStdout())).toMatchObject({
        json: true,
      });
    }
  });

  it('prints warnings before the final error message', async () => {
    vi.doMock('../../src/commands/upgrade.js', () => ({
      upgradeCommand: vi.fn(async () => {
        throw new CommandWarningError('fatal upgrade error', {
          warnings: ['rebuild replay skipped'],
        });
      }),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['upgrade', 'git-commit'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    const stderr = readStderr();
    expect(exitCode).toBe(1);
    expect(stderr).toContain('注意：rebuild replay skipped');
    expect(stderr).toContain('fatal upgrade error');
    expect(stderr.indexOf('注意：rebuild replay skipped')).toBeLessThan(
      stderr.indexOf('fatal upgrade error'),
    );
  });

  it('translates degraded skill-trigger warnings for users', async () => {
    vi.doMock('../../src/commands/uninstall.js', () => ({
      uninstallCommand: vi.fn(async () => ({
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: ['[codex/git-commit] installed.json 处于 degraded 状态，跳过卸载后的 skill trigger 重选。'],
      })),
    }));

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['uninstall', 'git-commit', '--platform', 'codex'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(readStderr()).toContain('本机安装账本处于异常恢复状态');
    expect(readStderr()).toContain('--skill-trigger default|manual|auto');
    expect(readStderr()).not.toContain('[codex/git-commit]');
    expect(readStderr()).not.toContain('Warning:');
  });

  it('writes and redacts debug logs while keeping status JSON stdout clean', async () => {
    const installCommand = vi.fn(async (
      _plugins: string[],
      _options: unknown,
      context: {
        nativeCliRunner: (invocation: {
          command: string;
          args: string[];
        }) => Promise<unknown>;
      },
    ) => {
      await context.nativeCliRunner({
        command: 'probe',
        args: ['install'],
      });
      return {
        plugins: ['git-commit'],
        platforms: ['codex'],
        warnings: [],
      };
    });
    vi.doMock('../../src/commands/install.js', () => ({ installCommand }));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-debug-redact-'));
    tempDirs.push(tempDir);
    const logFile = path.join(tempDir, 'debug.log');
    const secret = 'super-secret-value';
    const nativeCliRunner = vi.fn(async (invocation) => {
      throw new NativeCliError({
        invocation,
        exitCode: 1,
        stdout: `TOKEN=${secret}`,
        stderr: `Authorization: Bearer ${secret}`,
      });
    });

    const { io, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');
    const exitCode = await runCli(
      ['install', 'git-commit', '--platform', 'codex', '--debug', '--log-file', logFile, '--no-interactive'],
      {
        cwd: '/tmp/workspace',
        env: {} as NodeJS.ProcessEnv,
        io,
        nativeCliRunner,
      },
    );

    expect(exitCode).toBe(1);
    expect(readStderr()).toContain(`调试日志：${logFile}`);
    const logContent = await fs.readFile(logFile, 'utf8');
    expect(logContent).not.toContain(secret);
    expect(logContent).toContain('[REDACTED]');
  });

  it('does not create AW_HOME logs for default status debug logs', async () => {
    const statusCommand = vi.fn(async () => ({
      reports: [],
      output: JSON.stringify({ ok: true }),
    }));
    vi.doMock('../../src/commands/status.js', () => ({
      statusCommand,
    }));

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-status-debug-'));
    tempDirs.push(tempDir);
    const awHome = path.join(tempDir, 'aw-home');
    const { io, readStdout, readStderr } = createCapturedIo();
    const { runCli } = await import('../../src/index.js');

    const exitCode = await runCli(
      ['status', '-j', '--debug'],
      {
        cwd: '/tmp/workspace',
        env: { AW_HOME: awHome } as NodeJS.ProcessEnv,
        io,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(readStdout())).toEqual({ ok: true });
    expect(readStderr()).toContain(path.join(os.tmpdir(), 'agent-workflows'));
    expect(await fs.pathExists(awHome)).toBe(false);
  });
});
