import path from 'node:path';

import fs from 'fs-extra';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { SessionConsoleApp } from '../../src/tui/session-console-app.js';
import type { ConsoleExitRequest } from '../../src/tui/console-app-v4.js';
import type { SessionHost } from '../../src/tui/session-host.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => { resolve = settle; }), resolve };
}

describe('console entry', () => {
  it('shows help for bare aw in a non-interactive runtime', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([], {
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(captured.readStderr()).toBe('');
    expect(captured.readStdout()).toContain('Usage: aw');
    expect(captured.readStdout()).toContain('plugin');
  });

  it('launches one V4 controller session, completes through onExit, and disposes ownership once', async () => {
    const captured = createCapturedCliIo();
    let mountedController: { snapshot: { phase: string } } | undefined;
    const launch = vi.fn(async (request: {
      render: (complete: (result: { exitCode: number }) => void) => {
        type: unknown;
        props: { host: { snapshot: { controller: { snapshot: { phase: string } } } }; onExit: (request: ConsoleExitRequest) => void };
      };
    }) => {
      let result: { exitCode: number } | undefined;
      const element = request.render((value) => { result = value; });
      expect(element.type).toBe(SessionConsoleApp);
      expect(element.props.host.snapshot.controller.snapshot.phase).toBe('idle');
      mountedController = element.props.host.snapshot.controller;
      element.props.onExit({ code: 0, reason: 'user' });
      return result!;
    });
    const exitCode = await runCli([], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(0);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(mountedController?.snapshot.phase).toBe('disposed');
    expect(captured.readStdout()).toBe('');
  });

  it('drains an active TUI read before returning the process signal exit code', async () => {
    const captured = createCapturedCliIo();
    const entered = deferred<void>();
    const cancelled = deferred<void>();
    const release = deferred<void>();
    const previousListeners = new Set(process.listeners('SIGTERM'));
    let signalListener: NodeJS.SignalsListener;
    const launch = async (request: {
      render: (complete: (result: { exitCode: number }) => void) => ReactElement<{ host: SessionHost }>;
    }) => {
      const completed = deferred<{ exitCode: number }>();
      const element = request.render(completed.resolve);
      element.props.host.snapshot.controller.dependencies.loadStatus = async (signal) => {
        signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        throw signal.reason;
      };
      // Only deliver the signal to this invocation. Ink and Vitest own their own handlers.
      const listeners = process.listeners('SIGTERM').filter((listener) => !previousListeners.has(listener));
      expect(listeners).toHaveLength(1);
      signalListener = listeners[0]!;
      const app = render(element);
      try { return await completed.promise; }
      finally { app.unmount(); }
    };
    let settled = false;
    const running = runCli(['tui'], { interactive: true, io: captured.io, tuiRunner: { launch } as never })
      .finally(() => { settled = true; });
    try {
      await entered.promise;
      signalListener!('SIGTERM');
      await cancelled.promise;
      expect(settled).toBe(false);
    } finally { release.resolve(); }
    expect(await running).toBe(143);
    expect(process.listeners('SIGTERM')).not.toContain(signalListener!);
  });

  it('returns the exit code supplied by the mounted V4 component callback', async () => {
    const captured = createCapturedCliIo();
    const launch = vi.fn(async (request: {
      render: (complete: (result: { exitCode: number }) => void) => {
        props: { onExit: (request: ConsoleExitRequest) => void };
      };
    }) => {
      let result: { exitCode: number } | undefined;
      const element = request.render((value) => { result = value; });
      element.props.onExit({ code: 1, reason: 'initialError' });
      return result!;
    });

    expect(await runCli([], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    })).toBe(1);
  });

  it.each(['success', 'failure'])('drains an active session read before restoring the reporter on %s exit', async (outcome) => {
    const captured = createCapturedCliIo();
    const read = deferred<never>();
    const launch = vi.fn(async (request: {
      render: (complete: (result: { exitCode: number }) => void) => {
        props: { host: SessionHost; onExit: (request: ConsoleExitRequest) => void };
      };
    }) => {
      let result: { exitCode: number } | undefined;
      const element = request.render((value) => { result = value; });
      const controller = element.props.host.snapshot.controller;
      controller.dependencies.loadStatus = vi.fn(() => read.promise);
      void controller.load();
      if (outcome === 'failure') throw new Error('terminal session failed');
      element.props.onExit({ code: 0, reason: 'user' });
      return result!;
    });
    let settled = false;
    const running = runCli([], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    }).finally(() => { settled = true; });

    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    read.resolve(undefined as never);
    await expect(running).resolves.toBe(outcome === 'failure' ? 1 : 0);
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
    expect(captured.readStderr()).toContain('command:start');
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

  it('does not persist config values from argv in a real debug log', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const logFile = path.join(isolation.layout.debugLogsDir, 'config-value.log');
    const secret = 'unknown-config-secret-value';

    const exitCode = await runCli([
      'plugin', 'config', 'set', 'missing/demo', 'unknown-sensitive-key',
      '--context', 'user', '--value-json', JSON.stringify(secret),
      '--debug', '--log-file', logFile,
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(3);
    const debugLog = await fs.readFile(logFile, 'utf8');
    expect(debugLog).not.toContain(secret);
    expect(debugLog).not.toContain('unknown-sensitive-key');
  });

  it(
    'rejects a bare console log file option without its required value',
    async () => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli(['--log-file'], {
        interactive: true,
        io: captured.io,
      });

      expect(exitCode).toBe(2);
      expect(captured.readStderr()).toContain('invalidArguments');
    },
  );

  it('rejects a generic invalid command', async () => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['invalid-command'], { io: captured.io });

    expect(exitCode).toBe(2);
    expect(captured.readStderr()).toMatch(/unknown command/iu);
    expect(captured.readStdout()).toContain('FAILED');
  });
});
