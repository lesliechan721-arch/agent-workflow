import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { runProjectRecovery } from '../../src/project/recovery.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';

vi.mock('../../src/project/recovery.js', () => ({ runProjectRecovery: vi.fn() }));

beforeEach(() => {
  vi.mocked(runProjectRecovery).mockReset();
  vi.mocked(runProjectRecovery).mockResolvedValue({
    schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: true,
    intent: { state: 'absent', roots: [] }, requestedRoots: [],
    selection: { agents: ['codex'], origin: 'argument' }, blockers: [],
    targetResults: [], remainingTargets: [], recoveryActions: [],
    declarationChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
  });
});

describe('Project CLI authorization bridge', () => {
  // Test Value Gate: the public CLI must keep preApply and managed downloads as separate grants.
  it('does not turn --yes into managed Codex authorization', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'sync', '--all', '-s', 'project', '-p', 'codex', '--yes', '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    expect(JSON.parse(output.readStdout())).toMatchObject({ kind: 'aw-project-recovery', ok: true });
    const runtime = vi.mocked(runProjectRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: true, directCli: true });
    expect(runtime?.managedCodexAuthorizer).toBeUndefined();
  });

  it('passes managed authorization only from its explicit flag', async () => {
    const output = createCapturedCliIo();
    expect(await runCli([
      'sync', '--all', '-s', 'project', '-p', 'codex',
      '--allow-managed-codex-install', '--json',
    ], { interactive: false, io: output.io })).toBe(0);
    const runtime = vi.mocked(runProjectRecovery).mock.calls[0]?.[3];
    expect(runtime).toMatchObject({ preApplyConfirmed: false, directCli: true });
    expect(await runtime?.managedCodexAuthorizer?.()).toBe(true);
  });
});
