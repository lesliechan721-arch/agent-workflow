import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { toWizardCandidates } from '../../src/commands/wizard.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

vi.mock('../../src/recovery/coordinator.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/recovery/coordinator.js')>(),
  runRecovery: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(runRecovery).mockReset();
  vi.mocked(runRecovery).mockResolvedValue({
    schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'cleanup', ok: true,
    intent: { state: 'absent', roots: [] }, requestedRoots: [], requestedTargets: [],
    selection: { agents: ['codex'], origin: 'argument', preferences: 'absent' },
    blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
    declarationChanged: false, preferencesChanged: false, configChanged: false,
    outputsMayHaveChanged: false,
  });
});

describe('scoped write command entry', () => {
  // Test Value Gate: a complete CLI request must reach the coordinator with the exact selected scope and Agent.
  it('routes complete cleanup arguments without mounting a wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli([
      'cleanup', 'team/demo', '--scope', 'user', '--target', 'codex', '--force', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: true, io: captured.io, tuiRunner: { launch } as never });
    expect(exitCode).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'cleanup', ok: true,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(runRecovery).toHaveBeenCalledWith('cleanup', ['team/demo'], expect.objectContaining({
      scope: 'user', targets: ['codex'], force: true,
    }), expect.any(Object));
  });

  it('rejects an omitted scope before calling the coordinator', async () => {
    const captured = createCapturedCliIo();
    const result = await runCli([
      'install', 'team/demo', '--target', 'codex', '--json',
    ], { interactive: false, io: captured.io });
    expect(result).toBe(2);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      kind: 'aw-recovery', scope: null, command: 'install', ok: false,
      errors: [{ code: 'invalidArguments' }],
    });
    expect(runRecovery).not.toHaveBeenCalled();
  });

  it('keeps namespaced config candidates for the config wizard', () => {
    expect(toWizardCandidates([{
      pluginName: 'team/demo',
      pluginSummary: { description: 'Namespaced summary',
        configSchema: { mode: { type: 'string', title: 'Mode' } } },
      targets: [],
    }])).toEqual([expect.objectContaining({
      pluginName: 'team/demo', pluginId: 'team/demo', description: 'Namespaced summary',
      configSchema: { mode: { type: 'string', title: 'Mode' } },
    })]);
  });

  it('requires a scope for a parameter-missing non-TTY write', async () => {
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['install'], {
      interactive: true, io: captured.io, tuiRunner: { launch } as never,
    });
    expect(exitCode).toBe(2);
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain("required option '--scope <scope>'");
    expect(launch).not.toHaveBeenCalled();
  });
});
