import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectPathFenceViolation } from '../helpers/test-isolation.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  registerCurrentTestReadonlyFixtureRoot,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('command runtime', () => {
  it('keeps a successful native result when diagnostic sinks fail', async () => {
    const { createCommandExecutionContext } = await import('../../src/commands/runtime.js');
    const reportEvent = vi.fn((event: { type: string }) => {
      if (event.type === 'native:success') throw new Error('reporter sink failed');
    });
    const debugLog = vi.fn((event: { type: string }) => {
      if (event.type === 'native:success') throw new Error('debug sink failed');
    });
    const context = createCommandExecutionContext({
      nativeCliRunner: vi.fn(async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
      reporter: { event: reportEvent, notice: vi.fn() },
      debugLogger: { log: debugLog },
      diagnostics: { commandName: 'install' },
    });

    await expect(context.nativeCliRunner({ command: 'codex', args: ['--version'] })).resolves.toEqual({
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
    });
    expect(reportEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'native:success' }));
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({ type: 'native:success' }));
  });

  it('uses the injected prompt output sink instead of stdout', async () => {
    const { createReadlinePrompt } = await import('../../src/commands/runtime.js');
    const input = Readable.from(['\n']);
    const output: string[] = [];
    const prompt = createReadlinePrompt({
      input,
      outputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
    });

    await expect(prompt.confirm!({ message: '继续吗？', defaultValue: true })).resolves.toEqual({
      action: 'select',
      cancelled: false,
      value: true,
    });

    expect(output.join('')).toContain('继续吗？');
  });

  it('treats prompt interactivity as stdin, stdout, and prompt output TTY', async () => {
    const { createCliExecutionContext } = await import('../../src/commands/runtime.js');
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    stdout.isTTY = true;
    const output: string[] = [];

    const context = createCliExecutionContext({
      stdin,
      stdout,
      promptOutputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
      env: process.env,
      diagnostics: {
        commandName: 'status',
      },
    });

    expect(context.interactive).toBe(true);
    expect(context.isTty).toBe(true);
    expect(context.diagnostics.metadata).toMatchObject({
      stdinIsTty: true,
      stdoutIsTty: true,
      promptOutputIsTty: true,
      interactiveEnabled: true,
    });
  });

  it('disables default interactivity when stdout is not a TTY', async () => {
    const { createCliExecutionContext } = await import('../../src/commands/runtime.js');
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    const stdout = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    stdout.isTTY = false;

    const context = createCliExecutionContext({
      stdin,
      stdout,
      promptOutputSink: {
        isTTY: true,
        write: vi.fn(),
      },
      env: process.env,
      diagnostics: {
        commandName: 'console',
      },
    });

    expect(context.isTty).toBe(false);
    expect(context.interactive).toBe(false);
    expect(context.diagnostics.metadata).toMatchObject({
      stdinIsTty: true,
      stdoutIsTty: false,
      promptOutputIsTty: true,
      interactiveEnabled: false,
    });
  });

  it('rejects fake config prompt results that select a scope outside the allowed candidates', async () => {
    const { validateCliConfigPromptResult } = await import('../../src/commands/runtime.js');

    expect(() => validateCliConfigPromptResult(
      {
        allowedScopes: ['user'],
        schema: {
          token: {
            type: 'string',
            sensitive: true,
          },
        },
      },
      {
        selectedScope: 'project',
        updates: {},
        updatedKeys: [],
      },
    )).toThrow('Unsupported config scope "project"');
  });

  it('hides sensitive string input from the prompt output sink', async () => {
    const { createReadlinePrompt } = await import('../../src/commands/runtime.js');
    const input = Readable.from(['hunter2\n']);
    const output: string[] = [];
    const prompt = createReadlinePrompt({
      input,
      outputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
    });

    const result = await prompt.configurePlugin!({
      pluginName: 'secret-plugin',
      schema: {
        token: {
          type: 'string',
          label: 'API token',
          required: true,
          sensitive: true,
        },
      },
      initialScope: 'user',
      allowedScopes: ['user'],
    });

    expect(result).toMatchObject({
      selectedScope: 'user',
      updates: {
        token: 'hunter2',
      },
      updatedKeys: ['token'],
      cancelled: false,
    });
    expect(output.join('')).toContain('API token');
    expect(output.join('')).not.toContain('hunter2');
  });

  it('renders the all-platform install choice in Chinese', async () => {
    const { createReadlinePrompt } = await import('../../src/commands/runtime.js');
    const input = Readable.from(['3\n']);
    const output: string[] = [];
    const prompt = createReadlinePrompt({
      input,
      outputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
    });

    await expect(prompt.selectPlatform!({
      available: ['codex', 'claude', 'both'],
      defaultValue: 'both',
    })).resolves.toBe('both');

    expect(output.join('')).toContain('全部支持平台');
  });

  it('allows the readline config prompt to edit an existing optional key', async () => {
    const { createReadlinePrompt } = await import('../../src/commands/runtime.js');
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = true;
    const output: string[] = [];
    let selectedKey = false;
    let answeredValue = false;
    const prompt = createReadlinePrompt({
      input,
      outputSink: {
        isTTY: true,
        write: (text) => {
          output.push(text);
          if (!selectedKey && text.includes('直接回车跳过')) {
            selectedKey = true;
            queueMicrotask(() => input.write('1\n'));
          } else if (!answeredValue && text.includes('Retries（当前：1）:')) {
            answeredValue = true;
            queueMicrotask(() => input.write('2\n'));
          }
        },
      },
    });

    const result = await prompt.configurePlugin!({
      pluginName: 'optional-plugin',
      schema: {
        retries: {
          type: 'number',
          label: 'Retries',
        },
      },
      initialScope: 'user',
      allowedScopes: ['user'],
      currentValues: {
        retries: 1,
      },
      requiredKeys: [],
    });
    input.end();

    expect(result).toMatchObject({
      selectedScope: 'user',
      updates: {
        retries: 2,
      },
      updatedKeys: ['retries'],
      cancelled: false,
    });
    expect(output.join('')).toContain('Retries（当前：1）');
  });

  it('maps menu shortcuts to stable navigation results while preserving text input', async () => {
    const { createReadlinePrompt } = await import('../../src/commands/runtime.js');
    const createPrompt = (answer: string) => createReadlinePrompt({
      input: Readable.from([answer]),
      outputSink: {
        isTTY: true,
        write: vi.fn(),
      },
    });
    const menuChoices = [
      { value: 'first', label: 'First' },
      { value: 'menu-back', label: '返回', role: 'back' as const },
      { value: 'menu-exit', label: '退出', role: 'exit' as const },
    ];

    await expect(createPrompt('b\n').select!({
      message: '选择功能',
      choices: menuChoices,
    })).resolves.toMatchObject({
      action: 'back',
      cancelled: false,
    });
    await expect(createPrompt('q\n').select!({
      message: '选择功能',
      choices: menuChoices,
    })).resolves.toMatchObject({
      action: 'exit',
      cancelled: false,
    });
    await expect(createPrompt('\u001B\n').select!({
      message: '选择功能',
      choices: menuChoices,
    })).resolves.toMatchObject({
      action: 'back',
      cancelled: false,
    });
    await expect(createPrompt('\u0003\n').select!({
      message: '选择功能',
      choices: menuChoices,
    })).resolves.toMatchObject({
      action: 'exit',
      cancelled: false,
    });

    await expect(createPrompt('b\n').input!({ message: 'Value' })).resolves.toMatchObject({
      action: 'select',
      cancelled: false,
      value: 'b',
    });
    await expect(createPrompt('q\n').input!({ message: 'Value' })).resolves.toMatchObject({
      action: 'select',
      cancelled: false,
      value: 'q',
    });
    await expect(createPrompt('b\n').password!({ message: 'Secret' })).resolves.toMatchObject({
      action: 'select',
      cancelled: false,
      value: 'b',
    });
    await expect(createPrompt('\u001B\n').input!({ message: 'Value' })).resolves.toMatchObject({
      action: 'cancel',
      cancelled: true,
    });
  });

  it('keeps status debug logs in the system temp dir by default', async () => {
    const { createCommandDiagnostics } = await import('../../src/commands/runtime.js');
    const isolation = getCurrentSourceTestIsolation();

    const statusDiagnostics = createCommandDiagnostics({
      commandName: 'status',
      debug: true,
    }, process.env);
    const installDiagnostics = createCommandDiagnostics({
      commandName: 'install',
      debug: true,
    }, process.env);

    expect(statusDiagnostics).toMatchObject({
      debug: true,
      verbose: true,
    });
    expect(statusDiagnostics.logFile).toContain(path.join(isolation.layout.tmpDir, 'agent-workflows'));
    expect(installDiagnostics.logFile).toContain(path.join(isolation.layout.awHomeDir, 'logs'));
  });

  it('blocks explicit debug log files outside writable test roots', async () => {
    const { createCommandDiagnostics } = await import('../../src/commands/runtime.js');
    const repositoryCwd = getSourceTestRepositoryCwd();
    registerCurrentTestReadonlyFixtureRoot(repositoryCwd, 'repository cwd');

    expectPathFenceViolation(
      () => createCommandDiagnostics({
        commandName: 'install',
        debug: true,
        logFile: path.join(repositoryCwd, 'runtime-debug.log'),
      }, process.env),
      {
        access: 'write',
        path: path.join(repositoryCwd, 'runtime-debug.log'),
        source: '--log-file',
        reason: 'writeToReadOnlyRoot',
        conflictingRootPath: repositoryCwd,
        recommendedFixIncludes: 'registerWritableStateRoot()',
      },
    );
  });

  it('blocks status debug logs in unregistered temp roots and allows them after registration', async () => {
    const { createCommandDiagnostics } = await import('../../src/commands/runtime.js');
    const isolation = getCurrentSourceTestIsolation();
    const externalTmpRoot = path.join(isolation.layout.rootDir, 'runtime-external-tmp');
    await fs.ensureDir(externalTmpRoot);

    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(externalTmpRoot);
    try {
      let error: unknown;
      try {
        createCommandDiagnostics({
          commandName: 'status',
          debug: true,
        }, process.env);
      } catch (caught) {
        error = caught;
      }

      const violation = expectPathFenceViolation(
        () => {
          throw error;
        },
        {
          access: 'write',
          path: error instanceof Error
            ? /Unsafe test write path: ([^\n]+)/.exec(error.message)?.[1] ?? path.join(externalTmpRoot, 'agent-workflows', 'unknown.log')
            : path.join(externalTmpRoot, 'agent-workflows', 'unknown.log'),
          source: 'AW_DEBUG default status log file',
          reason: 'outsideRegisteredRoots',
          recommendedFixIncludes: 'registerWritableStateRoot()',
        },
      );
      expect(violation.details.normalizedUnsafePath).toContain(
        path.join(externalTmpRoot, 'agent-workflows'),
      );

      registerCurrentTestWritableStateRoot(
        externalTmpRoot,
        'runtime status debug temp root',
      );

      expect(createCommandDiagnostics({
        commandName: 'status',
        debug: true,
      }, process.env).logFile).toContain(externalTmpRoot);
    } finally {
      tmpdirSpy.mockRestore();
    }
  });
});
