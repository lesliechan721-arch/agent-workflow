import { describe, expect, it, vi } from 'vitest';

import { resolveCodexEvalProcessManagement } from '../../scripts/codex-eval-process-management.js';

describe('Codex eval process management', () => {
  it('blocks restricted Codex sessions before keychain or process inspection', async () => {
    const preflight = vi.fn(async () => undefined);
    const inspect = vi.fn(async () => undefined);

    await expect(resolveCodexEvalProcessManagement({
      allowUnmanaged: false,
      sourceEnv: { CODEX_PERMISSION_PROFILE: ':workspace' },
      preflight,
      inspect,
    })).rejects.toThrow(/one-off sandbox_permissions=require_escalated.*not Full Access.*Do not retry/su);

    expect(preflight).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('uses explicit unmanaged mode without process inspection in a restricted session', async () => {
    const preflight = vi.fn(async () => undefined);
    const inspect = vi.fn(async () => undefined);

    await expect(resolveCodexEvalProcessManagement({
      allowUnmanaged: true,
      sourceEnv: { CODEX_PERMISSION_PROFILE: 'read-only' },
      preflight,
      inspect,
    })).resolves.toMatchObject({
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      diagnostic: expect.stringContaining('process-tree inspection was not attempted'),
    });

    expect(preflight).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each([
    ['native Full Access', { CODEX_PERMISSION_PROFILE: ':danger-full-access' }],
    ['ordinary Terminal', {}],
  ])('reports successful inspection as observed for %s', async (_label, sourceEnv) => {
    const inspect = vi.fn(async () => undefined);

    await expect(resolveCodexEvalProcessManagement({
      allowUnmanaged: false,
      sourceEnv,
      inspect,
    })).resolves.toMatchObject({
      mode: 'observed',
      inspectionAvailable: true,
      descendantCleanupGuaranteed: false,
      limitation: expect.stringContaining('does not guarantee descendant cleanup'),
    });

    expect(inspect).toHaveBeenCalledOnce();
  });

  it('allows an uninspectable ordinary Terminal only after explicit confirmation', async () => {
    await expect(resolveCodexEvalProcessManagement({
      allowUnmanaged: true,
      sourceEnv: {},
      inspect: async () => { throw new Error('process inspection denied'); },
    })).resolves.toMatchObject({
      mode: 'unmanaged-confirmed',
      inspectionAvailable: false,
      userAcknowledged: true,
      descendantCleanupGuaranteed: false,
      diagnostic: 'process inspection denied',
    });
  });
});
