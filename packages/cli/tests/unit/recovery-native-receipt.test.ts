import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/commands/rebuild-command.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-command.js')>(),
  runRebuildCommand: native.run,
}));
vi.mock('../../src/portable/recovery.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/recovery.js')>(),
  inspectPortableResidue: vi.fn(async () => ({ state: 'absent', targets: [], blockers: [] })),
}));

import { runRecovery } from '../../src/recovery/coordinator.js';
import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('scoped Native recovery receipt', () => {
  it.each([
    { command: 'cleanup' as const, shared: false, content: 'absent', observation: 'missing' },
    { command: 'uninstall' as const, shared: false, content: 'absent', observation: 'missing' },
    { command: 'cleanup' as const, shared: true, content: 'unknown', observation: 'unknown' },
  ])('keeps $command execution separate from observed content with shared=$shared', async ({ command, shared, content, observation }) => {
    const isolation = getCurrentSourceTestIsolation();
    const target = { pluginId: 'team/demo', pluginName: 'demo', pluginVersion: '1.0.0',
      platform: 'claude' as const, scope: 'user' as const, cwd: isolation.layout.fixtureCwd };
    const outputPath = path.join(isolation.layout.fixtureCwd, '.claude', 'owned-output');
    native.run.mockImplementation(async (): Promise<RebuildCommandResult> => ({
      platforms: ['claude'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded',
      receiptTargets: [{ pluginId: target.pluginId, pluginName: target.pluginName,
        platform: target.platform, scope: target.scope }],
      targetResults: [{ target, action: command, state: 'completed' }],
      rebuildResults: [{ status: 'succeeded', command, target,
        actions: [{ name: 'cleanup.owned', status: 'succeeded' }], cleanupAttempted: true,
        removed: ['owned-output'], absent: [], residual: [], quarantined: [], failures: [] }],
      nativeFootprints: [{ path: outputPath,
        pluginId: target.pluginId, platform: target.platform, scope: target.scope, shared }],
      operationPlan: createOperationPlan({
        intentChanges: [],
        actions: [{ kind: 'removeOwnedArtifact', pluginId: target.pluginId, platform: target.platform,
          scope: target.scope, path: outputPath, ownerFingerprint: 'sha256:fixture' }],
        changes: [`${target.pluginId}:${target.platform}:${target.scope}:removeOwnedOutput:${outputPath}`],
        warnings: [],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] },
      }),
    }));

    const receipt = await runRecovery(command, ['team/demo'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['claude-code'], yes: true,
    }, { nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }) });

    expect(receipt.ok).toBe(true);
    expect(receipt.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/demo', agent: 'claude-code', execution: 'applied', content, observation,
    })]);
  });
});
