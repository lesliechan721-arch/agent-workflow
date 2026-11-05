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
  // Test Value Gate: CLI arguments must reach the coordinator; invalid input must fail before coordination or a wizard.
  it('routes complete cleanup arguments without mounting a wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli([
      'plugin', 'cleanup', 'team/demo', '--scope', 'user', '--target', 'codex', '--force', '--json',
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

  it('routes installation with declaration scope and work context without target selection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const result = await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--context', 'user', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: true, io: captured.io, tuiRunner: { launch } as never });
    expect(result).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      kind: 'aw-recovery', command: 'install', ok: true,
    });
    expect(runRecovery).toHaveBeenCalledWith('install', ['team/demo'], expect.objectContaining({
      scope: 'user', context: 'user', targets: undefined,
    }), expect.any(Object));
    expect(launch).not.toHaveBeenCalled();
  });

  it('rejects an omitted cleanup scope before calling the coordinator', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const result = await runCli([
      'plugin', 'cleanup', 'team/demo', '--target', 'codex', '--json',
    ], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
      interactive: false, io: captured.io });
    expect(result).toBe(2);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      kind: 'aw-recovery', scope: null, command: 'cleanup', ok: false,
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

  it('rejects missing install selectors before mounting a non-TTY wizard', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const captured = createCapturedCliIo();
    const launch = vi.fn();
    const exitCode = await runCli(['plugin', 'install'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: true, io: captured.io, tuiRunner: { launch } as never,
    });
    expect(exitCode).toBe(2);
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain("missing required argument 'plugins'");
    expect(launch).not.toHaveBeenCalled();
    expect(runRecovery).not.toHaveBeenCalled();
  });
});
