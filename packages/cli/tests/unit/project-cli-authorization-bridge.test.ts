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
  // Test Value Gate: the public CLI must keep preApply and managed downloads as separate grants.
  it('does not turn --yes into managed Codex authorization', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'sync', '--all', '--scope', 'project', '--target', 'codex', '--yes', '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    expect(JSON.parse(output.readStdout())).toMatchObject({ kind: 'aw-recovery', ok: true });
    const runtime = vi.mocked(runRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: true, directCli: true });
    expect(runtime?.managedCodexAuthorizer).toBeUndefined();
  });

  it('passes managed authorization only from its explicit flag', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'sync', '--all', '--scope', 'project', '--target', 'codex',
      '--allow-managed-codex-install', '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    const runtime = vi.mocked(runRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: false, directCli: true });
    expect(await runtime?.managedCodexAuthorizer?.()).toBe(true);
  });
});
