import { describe, expect, it, vi } from 'vitest';

import { executeOperationAction } from '../../src/commands/operation-action-executor.js';

describe('operation action executor', () => {
  it('runs inspect, one switched apply, and verify in order', async () => {
    const calls: string[] = [];
    const driver = {
      inspect: vi.fn(async () => { calls.push('inspect'); }),
      ensureNativeRegistration: vi.fn(async () => { calls.push('ensure'); }),
      removeNativeRegistration: vi.fn(),
      setActivation: vi.fn(),
      writeOwnedArtifact: vi.fn(),
      updateSharedConfig: vi.fn(),
      removeOwnedArtifact: vi.fn(),
      runPostApply: vi.fn(),
      verify: vi.fn(async () => { calls.push('verify'); }),
    };
    await executeOperationAction({
      action: {
        kind: 'ensureNativeRegistration',
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'user',
        registration: 'demo@aw',
      },
      driver,
    });
    expect(calls).toEqual(['inspect', 'ensure', 'verify']);
    expect(driver.setActivation).not.toHaveBeenCalled();
  });
});
