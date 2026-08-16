import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('console and removed diagnose entry', () => {
  it('rejects the bare console in a non-interactive runtime with copyable live commands', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([], {
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain('当前运行环境不可交互');
    expect(captured.readStderr()).toContain('aw status --json');
  });

  it('launches one injected dashboard session on stderr without writing stdout', async () => {
    const captured = createCapturedCliIo();
    const launch = vi.fn(async () => ({ exitCode: 0 }));
    const exitCode = await runCli([], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(captured.readStdout()).toBe('');
  });

  it('applies bare console verbose and debug options to diagnostics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const debugLog = vi.fn();
    const logFile = path.join(isolation.layout.debugLogsDir, 'bare-console.log');
    const exitCode = await runCli(['--verbose', '--debug', '--log-file', logFile], {
      env: isolation.env,
      interactive: true,
      io: captured.io,
      debugLogger: { log: debugLog },
      tuiRunner: { launch: vi.fn(async () => ({ exitCode: 0 })) } as never,
    });

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toContain('调试：command:start');
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command:start',
      data: expect.objectContaining({ verbose: true, debug: true, logFile }),
    }));
  });

  it('keeps a successful console result when terminal diagnostics fail', async () => {
    const captured = createCapturedCliIo();
    const debugLog = vi.fn((event: { type: string }) => {
      if (event.type === 'command:success') throw new Error('debug sink failed');
    });
    const reportEvent = vi.fn((event: { type: string }) => {
      if (event.type === 'command:success') throw new Error('reporter sink failed');
    });

    const exitCode = await runCli([], {
      interactive: true,
      io: captured.io,
      reporter: { event: reportEvent, notice: vi.fn() },
      debugLogger: { log: debugLog, flush: vi.fn(() => { throw new Error('flush failed'); }) },
      tuiRunner: { launch: vi.fn(async () => ({ exitCode: 0 })) } as never,
    });

    expect(exitCode).toBe(0);
    expect(reportEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'command:success' }));
    expect(debugLog).toHaveBeenCalledWith(expect.objectContaining({ type: 'command:success' }));
  });

  it(
    'rejects a bare console log file option without its required value',
    async () => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli(['--log-file'], {
        interactive: true,
        io: captured.io,
      });

      expect(exitCode).toBe(1);
      expect(captured.readStderr()).toContain('argument missing');
    },
  );

  it.each(['--catalog-channel', '--catalog-version'])(
    'rejects removed bare console option %s',
    async (option) => {
      const captured = createCapturedCliIo();
      const launch = vi.fn(async () => ({ exitCode: 0 }));
      const exitCode = await runCli([option], {
        interactive: true,
        io: captured.io,
        tuiRunner: { launch } as never,
      });

      expect(exitCode).toBe(1);
      expect(launch).not.toHaveBeenCalled();
      expect(captured.readStderr()).toContain('unknown option');
    },
  );

  it('treats diagnose as an ordinary unknown command without a compatibility route', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['diagnose'], { io: captured.io });

    expect(exitCode).toBe(1);
    expect(captured.readStderr()).toContain('unknown command');
    expect(captured.readStderr()).not.toContain('status --verbose');
  });
});
