import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { toWizardCandidates } from '../../src/commands/wizard.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';

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
  syncWriteCommand: mocks.installWriteCommand,
}));

describe('write command runtime entry', () => {
  it('shows and binds the full cleanup range before an interactive write', async () => {
    const plan = createOperationPlan({
      intentChanges: [], actions: [], changes: [], warnings: [],
      evidence: { catalogDigests: [], intentDigests: [], configDigests: [],
        targetOwnerFingerprints: [] },
    });
    const receipt = {
      platforms: ['codex', 'claude'], plugins: ['demo'], warnings: [],
      rebuildResults: [], targetResults: [], overallState: 'succeeded', receiptTargets: [],
      removedPluginCleanupIds: ['official/demo'], operationPlan: plan,
    };
    const prompt = { confirm: vi.fn().mockResolvedValue({ cancelled: false, value: true }) };
    mocks.cleanupWriteCommand.mockResolvedValueOnce(receipt).mockResolvedValueOnce(receipt);
    const captured = createCapturedCliIo();
    const exitCode = await runCli(['cleanup', 'official/demo', '-p', 'codex', '-s', 'user'], {
      env: {}, interactive: true, io: captured.io, prompt,
      stdin: { isTTY: true } as NodeJS.ReadableStream,
      stdout: { isTTY: true }, promptOutputSink: { isTTY: true, write: () => undefined },
    });

    expect(exitCode).toBe(0);
    expect(prompt.confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Codex、Claude Code 的用户与当前项目位置'),
      defaultValue: false,
    }));
    expect(mocks.cleanupWriteCommand.mock.calls[0]?.[2]).toMatchObject({
      previewOperationPlan: true,
    });
    expect(mocks.cleanupWriteCommand.mock.calls[1]?.[1]).toMatchObject({ yes: true });
    expect(mocks.cleanupWriteCommand.mock.calls[1]?.[2]).toMatchObject({
      expectedPlanFingerprint: plan.planFingerprint,
    });
    mocks.cleanupWriteCommand.mockClear();
  });

  it('does not start deleted-plugin cleanup when the interactive review is declined', async () => {
    const captured = createCapturedCliIo();
    mocks.cleanupWriteCommand.mockResolvedValueOnce({
      platforms: ['codex', 'claude'], plugins: [], warnings: [], rebuildResults: [],
      targetResults: [], overallState: 'succeeded', receiptTargets: [],
      removedPluginCleanupIds: ['official/demo'],
      operationPlan: createOperationPlan({
        intentChanges: [], actions: [], changes: [], warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [],
          targetOwnerFingerprints: [] },
      }),
    });
    const prompt = { confirm: vi.fn().mockResolvedValue({ cancelled: false, value: false }) };
    expect(await runCli(['cleanup', 'official/demo', '-p', 'codex', '-s', 'user'], {
      env: {}, interactive: true, io: captured.io, prompt,
      stdin: { isTTY: true } as NodeJS.ReadableStream,
      stdout: { isTTY: true }, promptOutputSink: { isTTY: true, write: () => undefined },
    })).toBe(0);
    expect(mocks.cleanupWriteCommand).toHaveBeenCalledOnce();
    expect(mocks.cleanupWriteCommand.mock.calls[0]?.[2]).toMatchObject({
      previewOperationPlan: true,
    });
    mocks.cleanupWriteCommand.mockClear();
  });
  it('uses the Status v6 plugin summary for namespaced config candidates', () => {
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
      receiptTargets: [],
    });
    const exitCode = await runCli([command, ...args, '--json'], {
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
    });

    expect(exitCode).toBe(0);
    const receipt = JSON.parse(captured.readStdout());
    expect(receipt).toMatchObject({
      receiptSchemaVersion: 6,
      command,
      ok: true,
      overallState: 'succeeded',
      changes: [],
      targetResults: [],
      recoveryActions: [],
      warnings: [],
      errors: [],
    });
    expect(receipt).not.toHaveProperty('layers');
    expect(receipt).not.toHaveProperty('targets');
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
