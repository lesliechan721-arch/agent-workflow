import { describe, expect, it, vi } from 'vitest';

import { buildEquivalentWriteCommandTokens, runCli } from '../../src/index.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

const mocks = vi.hoisted(() => ({
  installWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  cleanupWriteCommand: vi.fn(),
}));

vi.mock('../../src/commands/write-commands.js', async () => ({
  ...await vi.importActual<typeof import('../../src/commands/write-commands.js')>(
    '../../src/commands/write-commands.js',
  ),
  ...mocks,
}));

describe('write command transition gate', () => {
  it.each([
    ['install', ['demo', '--platform', 'codex']],
    ['upgrade', ['demo', '--platform', 'codex']],
    ['reinstall', ['demo', '--platform', 'codex']],
    ['uninstall', ['demo', '--platform', 'codex']],
    ['cleanup', ['demo', '--platform', 'codex', '--scope', 'user']],
  ] as const)('fails %s closed with one v4 receipt and no helper call', async (command, args) => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli([command, ...args, '--json'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command,
      ok: false,
      overallState: 'failed',
      targets: [expect.objectContaining({
        pluginName: 'demo',
        platform: 'codex',
        scope: 'user',
        status: 'failed',
      })],
      errors: [{ code: 'runtimeTransitionIncomplete' }],
    });
    expect(launch).not.toHaveBeenCalled();
    expect(Object.values(mocks).every((helper) => helper.mock.calls.length === 0)).toBe(true);
  });

  it('fails a parameter-missing interactive write before mounting a wizard', async () => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['install'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(captured.readStdout()).toContain('runtimeTransitionIncomplete');
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.installWriteCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['install', ['demo'], ['--platform', 'codex', '--scope', 'user']],
    ['upgrade', [], ['--all', '--platform', 'both', '--scope', 'user']],
    ['reinstall', ['demo'], ['--platform', 'claude', '--scope', 'project']],
    ['uninstall', ['demo'], ['--platform', 'codex', '--scope', 'user']],
    ['cleanup', ['demo'], ['--platform', 'codex', '--scope', 'project']],
  ] as const)('keeps %s replay tokens free of removed catalog selectors', (command, plugins, expected) => {
    const tokens = buildEquivalentWriteCommandTokens(command, {
      plugins: [...plugins],
      platform: expected[1] as 'codex' | 'claude' | 'both',
      scope: expected[3] as 'project' | 'user',
    }, { all: command === 'upgrade' });
    expect(tokens).not.toContain('--catalog-channel');
    expect(tokens).not.toContain('--catalog-version');
  });
});
