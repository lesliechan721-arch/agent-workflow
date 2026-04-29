import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe('command runtime', () => {
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
