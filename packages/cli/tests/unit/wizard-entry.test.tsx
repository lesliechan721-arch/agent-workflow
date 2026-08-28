import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { toWizardCandidates } from '../../src/commands/wizard.js';
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

describe('write command runtime entry', () => {
  it('uses the status v4 plugin summary for namespaced config candidates', () => {
    expect(toWizardCandidates([{
      pluginName: 'team/demo',
      pluginSummary: {
        description: 'Namespaced summary',
        configSchema: { mode: { type: 'string', title: 'Mode' } },
      },
      targets: [],
    }])).toEqual([expect.objectContaining({
      pluginName: 'team/demo',
      pluginId: 'team/demo',
      description: 'Namespaced summary',
      configSchema: { mode: { type: 'string', title: 'Mode' } },
    })]);
  });

  it.each([
    ['install', ['demo', '--platform', 'codex']],
    ['upgrade', ['demo', '--platform', 'codex']],
    ['reinstall', ['demo', '--platform', 'codex']],
    ['uninstall', ['demo', '--platform', 'codex']],
    ['cleanup', ['demo', '--platform', 'codex', '--scope', 'user', '--force']],
  ] as const)('routes complete %s arguments without mounting a wizard', async (command, args) => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const helper = mocks[`${command}WriteCommand` as keyof typeof mocks];
    helper.mockResolvedValueOnce({
      platforms: ['codex'],
      plugins: ['demo'],
      warnings: [],
      rebuildResults: [],
      targetResults: [],
      overallState: 'succeeded',
      nativePlugins: {},
      repoManagedArtifacts: [],
      receiptTargets: [],
    });
    const exitCode = await runCli([command, ...args, '--json'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 4,
      command,
      ok: true,
      overallState: 'succeeded',
      errors: [],
    });
    expect(launch).not.toHaveBeenCalled();
    expect(helper).toHaveBeenCalledOnce();
    if (command === 'cleanup') {
      expect(helper.mock.calls[0]?.[1]).toMatchObject({ force: true });
    }
  });

  it('prints usage for a parameter-missing non-TTY write', async () => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['install'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(1);
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain('Usage: aw install');
    expect(launch).not.toHaveBeenCalled();
  });
});
