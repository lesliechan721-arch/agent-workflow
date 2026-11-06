import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

vi.mock('../../src/recovery/coordinator.js', () => ({ runRecovery: vi.fn() }));

beforeEach(() => {
  vi.mocked(runRecovery).mockReset();
  vi.mocked(runRecovery).mockResolvedValue({
    schemaVersion: 1, kind: 'aw-recovery', scope: 'project', command: 'sync', ok: true,
    intent: { state: 'absent', roots: [] }, requestedRoots: [],
    requestedTargets: [],
    selection: { agents: ['codex'], origin: 'argument', preferences: 'absent' }, blockers: [], errors: [],
    targetResults: [], remainingTargets: [], recoveryActions: [],
    declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false,
  });
});

describe('scoped CLI authorization bridge', () => {
  // Test Value Gate: the public CLI must preserve the explicit preApply grant at the recovery boundary.
  it('passes --yes as preApply authorization', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'sync', '--context', 'user', '--target', 'codex', '--yes', '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    expect(JSON.parse(output.readStdout())).toMatchObject({ kind: 'aw-recovery', ok: true });
    const runtime = vi.mocked(runRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: true, directCli: true });
  });

  it('keeps preApply unconfirmed without --yes', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'sync', '--context', 'user', '--target', 'codex',
      '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    const runtime = vi.mocked(runRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: false, directCli: true });
  });
});
