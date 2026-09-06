import { describe, expect, it } from 'vitest';

import {
  buildAllowedConfigActions,
  buildAllowedLifecycleActions,
  buildOperationResultModel,
  selectLifecycleRetryAction,
} from '../../src/commands/operation-planner.js';

describe('operation planner', () => {
  it('uses refresh and sync instead of a public upgrade action', () => {
    const actions = buildAllowedLifecycleActions({
      pluginId: 'official/demo', platform: 'codex', scope: 'user', state: 'ready',
      recoveryActions: [],
      revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
    });

    expect(actions).toContainEqual(expect.objectContaining({
      id: 'refreshAndSync', reason: 'newActiveVersion',
      availableVersion: '2.0.0', refreshBeforeReview: true,
    }));
    expect(actions[0]).not.toHaveProperty('label');
    expect(actions[0]).not.toHaveProperty('description');
    expect(actions.map((action) => action.id)).not.toContain('upgrade');
  });

  it('allows only exact single-target cleanup for an orphan', () => {
    expect(buildAllowedLifecycleActions({
      pluginId: 'official/leaf', platform: 'codex', scope: 'user', state: 'orphaned',
      recoveryActions: [{ command: 'cleanup', scope: 'user', description: 'cleanup leaf' }],
    })).toEqual([expect.objectContaining({
      id: 'cleanup', pluginId: 'official/leaf', platform: 'codex', scope: 'user',
      reason: 'statusRecovery',
    })]);
  });

  it('uses the scope supplied by a structured recovery action', () => {
    expect(buildAllowedLifecycleActions({
      pluginId: 'official/leaf', platform: 'codex', scope: 'project', state: 'needsSync',
      recoveryActions: [{ command: 'reinstall', scope: 'user', description: 'repair user target' }],
    })).toEqual([expect.objectContaining({
      id: 'reinstall', scope: 'user', reason: 'statusRecovery',
    })]);
  });

  it('offers save and save-and-apply only for a changed config draft', () => {
    expect(buildAllowedConfigActions(false)).toEqual([]);
    expect(buildAllowedConfigActions(true)).toEqual([
      { id: 'configSave', label: '保存', apply: false },
      { id: 'configSaveAndApply', label: '保存并应用', apply: true },
    ]);
  });

  it('projects Receipt v6 without reconstructing target results', () => {
    const result = buildOperationResultModel({
      ok: false,
      command: 'sync',
      receiptSchemaVersion: 6,
      overallState: 'partial',
      changes: ['official/demo:codex:user:updated'],
      targetResults: [],
      warnings: ['source warning'],
      recoveryActions: ['run sync'],
      planFingerprint: 'sha256:plan',
      errors: [],
    });

    expect(result).toEqual(expect.objectContaining({
      state: 'partial',
      changes: ['official/demo:codex:user:updated'],
      warnings: ['source warning'],
      recoveryActions: ['run sync'],
      planFingerprint: 'sha256:plan',
    }));
  });

  it('selects retry actions from planner facts', () => {
    const target = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      state: 'needsSync' as const,
      recoveryActions: [
        { command: 'reinstall' as const, scope: 'user' as const, description: 'reinstall target' },
        { command: 'cleanup' as const, scope: 'user' as const, description: 'cleanup target' },
        { command: 'uninstall' as const, scope: 'user' as const, description: 'uninstall target' },
      ],
    };

    expect(selectLifecycleRetryAction({
      operationKind: 'pluginWrite', originalAction: 'install', target,
    })?.id).toBe('reinstall');
    expect(selectLifecycleRetryAction({
      operationKind: 'pluginWrite', originalAction: 'cleanup', target,
    })?.id).toBe('cleanup');
    expect(selectLifecycleRetryAction({
      operationKind: 'pluginWrite', originalAction: 'uninstall', target,
    })?.id).toBe('uninstall');
  });

  it('does not derive a lifecycle retry for a non-lifecycle operation', () => {
    expect(selectLifecycleRetryAction({
      operationKind: 'sourceMutation',
      target: {
        pluginId: 'official/demo', platform: 'codex', scope: 'user', state: 'absent',
        recoveryActions: [],
      },
    })).toBeUndefined();
  });
});
