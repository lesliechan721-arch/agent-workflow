import { describe, expect, it } from 'vitest';

import { projectExecutionDiagnostics } from '../../src/tui/diagnostic-projection.js';

describe('TUI config save batch diagnostic projection', () => {
  it('keeps each layer commit, apply failure, target effect, and preApply fact', () => {
    const projected = projectExecutionDiagnostics({
      status: 'partial',
      groups: [{
        scope: 'project', status: 'failed', configSaved: true,
        applyRequested: true, applyStatus: 'failed', errorCode: 'targetApplyFailed',
        execution: {
          apply: {
            state: 'partial',
            errors: [{ stage: 'apply', code: 'targetApplyFailed', message: 'private apply error' }],
            targetResults: [{
              target: { pluginId: 'team/demo', platform: 'claude', scope: 'project' },
              state: 'failed', errorCode: 'nativeCliTimedOut', message: 'private target error',
            }],
          },
        },
      }, {
        scope: 'user', status: 'failed', configSaved: false,
        applyRequested: true, applyStatus: 'failed', errorCode: 'configWriteFailed',
        execution: {
          operationRebuildResults: [{
            status: 'failed',
            target: { pluginId: 'team/demo', platform: 'codex', scope: 'user' },
            actions: [{ name: 'preApply', status: 'failed' }],
            error: {
              phase: 'preApply', message: 'private preApply output',
              operationDiagnostic: {
                code: 'preApplyExited', stage: 'preApply',
                safeMessage: 'The preApply process exited unsuccessfully.', exitCode: 7,
              },
            },
          }],
        },
      }],
    }, '4:batch', [], 'configSaveBatch');

    expect(projected.effects).toEqual({
      configCommit: 'partial', awWrite: 'partial',
      preApplyExternalEffect: 'possible', finalVerification: 'partial',
    });
    expect(projected.diagnostics.map(({ code, stage }) => ({ code, stage }))).toEqual([
      { code: 'targetApplyFailed', stage: 'apply' },
      { code: 'nativeCliTimedOut', stage: 'apply' },
      { code: 'preApplyExited', stage: 'preApply' },
      { code: 'configWriteFailed', stage: 'configWrite' },
    ]);
    expect(new Set(projected.diagnostics.map((diagnostic) => diagnostic.id)).size)
      .toBe(projected.diagnostics.length);
    expect(projected.targetEffects.get('team/demo\0codex\0user')).toMatchObject({
      awWrite: 'notStarted', preApplyExternalEffect: 'possible',
    });
    expect(JSON.stringify(projected)).not.toContain('private apply error');
    expect(JSON.stringify(projected)).not.toContain('private target error');
    expect(JSON.stringify(projected)).not.toContain('private preApply output');
  });

  it('reports completed commits when every layer was saved', () => {
    const projected = projectExecutionDiagnostics({
      status: 'succeeded',
      groups: [{
        scope: 'project', status: 'succeeded', configSaved: true,
        applyRequested: false, applyStatus: 'notRequested',
      }, {
        scope: 'user', status: 'succeeded', configSaved: true,
        applyRequested: false, applyStatus: 'notRequested',
      }],
    }, '5:batch', [], 'configSaveBatch');

    expect(projected.effects).toMatchObject({
      configCommit: 'completed', awWrite: 'notStarted', finalVerification: 'notStarted',
    });
    expect(projected.diagnostics).toEqual([]);
  });
});
