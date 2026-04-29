import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('command runtime', () => {
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

    await expect(prompt.confirm!({ message: '继续吗？', defaultValue: true })).resolves.toBe(true);

    expect(output.join('')).toContain('继续吗？');
  });

  it('treats prompt interactivity as stdin TTY plus output sink TTY, independent from stdout', async () => {
    const { createCliExecutionContext } = await import('../../src/commands/runtime.js');
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    const output: string[] = [];

    const context = createCliExecutionContext({
      stdin,
      promptOutputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
      env: {
        AW_HOME: '/tmp/aw-home',
      } as NodeJS.ProcessEnv,
      diagnostics: {
        commandName: 'status',
      },
    });

    expect(context.interactive).toBe(true);
    expect(context.isTty).toBe(true);
    expect(context.diagnostics.metadata).toMatchObject({
      promptOutputIsTty: true,
      interactiveEnabled: true,
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

  it('passes the same native runner and env into default adapters', async () => {
    const CodexAdapter = vi.fn(function CodexAdapterMock() {
      return { name: 'codex' };
    });
    const ClaudeAdapter = vi.fn(function ClaudeAdapterMock() {
      return { name: 'claude' };
    });
    vi.doMock('../../src/adapters/codex.js', () => ({
      CodexAdapter,
    }));
    vi.doMock('../../src/adapters/claude.js', () => ({
      ClaudeAdapter,
    }));

    const { createCommandExecutionContext } = await import('../../src/commands/runtime.js');
    const env = {
      AW_HOME: '/tmp/aw-home',
    } as NodeJS.ProcessEnv;
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));

    const context = createCommandExecutionContext({
      env,
      nativeCliRunner,
      diagnostics: {
        commandName: 'install',
      },
    });
    const adapters = context.adaptersFactory('/tmp/project', context);

    expect(adapters).toMatchObject({
      codex: { name: 'codex' },
      claude: { name: 'claude' },
    });
    expect(CodexAdapter).toHaveBeenCalledWith('/tmp/project', context.nativeCliRunner, env);
    expect(ClaudeAdapter).toHaveBeenCalledWith('/tmp/project', context.nativeCliRunner, env);
  });

  it('keeps status debug logs in the system temp dir by default', async () => {
    const { createCommandDiagnostics } = await import('../../src/commands/runtime.js');
    const env = {
      AW_HOME: '/tmp/aw-home',
    } as NodeJS.ProcessEnv;

    const statusDiagnostics = createCommandDiagnostics({
      commandName: 'status',
      debug: true,
    }, env);
    const installDiagnostics = createCommandDiagnostics({
      commandName: 'install',
      debug: true,
    }, env);

    expect(statusDiagnostics).toMatchObject({
      debug: true,
      verbose: true,
    });
    expect(statusDiagnostics.logFile).toContain(path.join(os.tmpdir(), 'agent-workflows'));
    expect(installDiagnostics.logFile).toContain(path.join('/tmp/aw-home', 'logs'));
  });
});
